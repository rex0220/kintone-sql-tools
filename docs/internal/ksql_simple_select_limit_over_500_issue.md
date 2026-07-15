# 課題: SIMPLE SELECT の `LIMIT > 500` がページングされず単発 GET へ送られる

- 作成日: 2026-07-16
- ステータス: **R2レビュー反映・実装済み（実機確認待ち）**
- 種別: 機能バグ（KLIKE 固有ではなく SIMPLE SELECT 全般）
- 優先度: **P1**
- 関連課題:
  - [`../perf-sql-execution-improvements.md`](../perf-sql-execution-improvements.md) A-8（`LIMIT > 500` の取得打ち切り。性能改善）
  - [`../perf-sql-execution-implementation-plan.md`](../perf-sql-execution-implementation-plan.md) フェーズ3 A-8
- 更新履歴:
  - R2（2026-07-16）: レビュー承認を反映。実機で `LIMIT 501` が `GAIA_QU01`、`LIMIT 500` が正常であることを確認。`LIMIT 500 / 501` の ORDER BY 境界テストと、検索打ち切りを `wrapClientWithSearchAbort` がクライアント層で捕捉することの回帰コメントを追加。案Aを実装。

---

## 1. 概要

kintone の複数レコード取得 API で指定できる `limit` は最大 500 件である。kSQL は SIMPLE SELECT の `LIMIT <= 500` を単発 GET へ押し下げ、`LIMIT` なしまたは `LIMIT > 500` を `fetchAll` で 500 件ずつページングする設計になっている。

しかし現行の `executeSimpleSelect` は、生成済みクエリ文字列に `limit` が含まれるだけで単発 GET を選ぶ。

```ts
const useSingleGet = params.query.includes("limit")
  || (stmt.limit !== null && stmt.limit <= 500);
```

`selectToKintoneParams` は SQL の `LIMIT` を値にかかわらずクエリへ追加するため、明示的な `LIMIT` はすべて `params.query.includes("limit") === true` になる。結果として `LIMIT 501` 以上もページングされず、kintone API へ不正な `limit N` として直接送られる。

直後のコメントは「LIMIT 指定なし or 500 超の場合は fetchAll を使う」としており、実装と設計意図が矛盾している。

## 2. 再現

### 2.1 SQL

```sql
SELECT *
FROM APP100
WHERE 件名 KLIKE '至急'
LIMIT 1000;
```

実行条件:

```text
maxRecords = 100000
実際の対象レコード = 1000件
```

### 2.2 現行動作

SIMPLE SELECT として次のような単発 GET が送られる。

```text
件名 like "至急" order by $id asc limit 1000
```

kintone API の `limit` 上限は 500 のため、実際の対象件数や `maxRecords` にかかわらず、クエリパラメーターの検証で API エラーになる。

`maxRecords` は `fetchAll` の取得上限であり、単発 GET 経路ではこの問題を回避しない。

### 2.3 期待動作

500 件ずつページングし、1000 件を取得して返す。

```text
GET 1: ... limit 500 offset 0
GET 2: ... limit 500 offset 500
GET 3: ... limit 500 offset 1000  # 終端確認（0件）
```

最終的な返却行数は SQL の `LIMIT 1000` を超えない。

## 3. 発生条件と影響

| 条件 | 現行動作 | 期待動作 |
|---|---|---|
| SIMPLE、LIMIT なし | `fetchAll` | 変更なし |
| SIMPLE、`LIMIT 0..500` | 単発 GET | 変更なし |
| SIMPLE、`LIMIT 501` 以上 | **不正な limit を単発 GET へ送る** | `fetchAll` でページング |
| FULL_SCAN、`LIMIT 501` 以上 | JS 側 LIMIT | 本課題の直接対象外 |

影響する入口は共通コアを使う CLI、MCP、プラグイン、ライブラリ API。KLIKE は通常 SIMPLE のまま kintone へ押し下げられるため再現しやすいが、等値・範囲条件など他の SIMPLE SELECT でも同じ問題が起きる。

`OFFSET` の有無は本質ではない。`LIMIT > 500` が明示されていれば発生する。

## 4. 既存 A-8 との関係

既存 A-8 は、`LIMIT 1000` のために一致レコードを最大 `maxRecords` まで全件取得してから JS で LIMIT する非効率を扱う**性能改善課題**である。

本課題は、その `fetchAll` 経路へ入らず API エラーになる**現行の機能バグ**である。責務を分ける。

1. 本課題で `LIMIT > 500` を正しく `fetchAll` へ送る（正しさの回復）
2. A-8 で、安全な条件下では `limit + offset` 件に達した時点で取得を止める（性能改善）

A-8 を同時実装しなくても本課題は修正できる。修正後も、対象全体が `maxRecords` を超える場合に `LIMIT` より先に取得上限エラーとなり得る現行挙動は残る。これはA-8側で扱う。

## 5. 原因

`useSingleGet` が AST 上の LIMIT 値ではなく、変換後クエリ文字列に `limit` が含まれるかでも判定している。

```ts
const params = selectToKintoneParams(stmt);
const useSingleGet = params.query.includes("limit")
  || (stmt.limit !== null && stmt.limit <= 500);
```

変換後クエリには `stmt.limit` がそのまま入るため、第1条件が第2条件を包含し、500件境界の判定を無効化している。

また、`LIMIT 500 / 501` の境界を実行層で固定する回帰テストがないため、コメントとの矛盾を検出できていない。

## 6. 対策案

### 案A: AST の LIMIT 値だけで単発 GET を判定する（推奨）

```ts
const useSingleGet = stmt.limit !== null && stmt.limit <= 500;
```

`LIMIT > 500` と LIMIT なしは既存の `fetchAll` 経路へ送り、取得後に既存の `applyOrderBy` / `applyLimit` を適用する。

利点:

- 変更が小さく、直後のコメントおよび既存設計と一致する
- FULL_SCAN やページング実装を変更しない
- ORDER BY の選択肢順・型補正など、既存の JS 側意味論を維持できる
- A-8 の最適化と独立して先行修正できる

留意点:

- `LIMIT > 500` でも現時点では一致分を最大 `maxRecords` まで取得するため、API呼び出し数・メモリ使用量の最適化にはならない
- 対象全体が `maxRecords` 以上なら、返却に必要な LIMIT 件数がそれ未満でも取得上限エラーになり得る（既存 A-8 の対象）

### 案B: LIMIT を 500 に丸めて単発 GET する（不採用）

SQL が要求した 501 件以上を返せず、黙った欠落になるため不可。

### 案C: parser / validation で LIMIT を 500 以下に制限する（不採用）

kSQL は `fetchAll` により500件超を取得できる設計であり、既存 A-8 とも矛盾する。利用可能な言語機能を不要に狭める。

### 案D: A-8 の逐次打ち切りページングまで同時実装する

最終形としては有効だが、ORDER BY の補正要否、`limit + offset`、10,000件超のカーソル切替など検討範囲が広い。機能バグの修正を性能最適化に依存させないため、本課題の必須範囲には含めない。

## 7. 推奨方針

**案Aを先に実施し、A-8は別課題のまま維持する。**

修正対象:

| ファイル | 変更 |
|---|---|
| `src/execute.ts` | `useSingleGet` を `stmt.limit !== null && stmt.limit <= 500` に修正 |
| `src/__tests__/execute.test.ts` | 500/501境界、1000件ページング、LIMITなし回帰を追加 |
| 必要に応じて実機 smoke | kintoneへ `limit > 500` が送られないことを確認 |

## 8. テスト計画

### 8.1 必須回帰

1. `LIMIT 500`
   - GET は1回
   - APIクエリは `limit 500`
2. `LIMIT 501`
   - `fetchAll` を使用
   - 各APIクエリの `limit` は500以下
   - 501行を返す
3. `LIMIT 1000`、実対象1000件、`maxRecords=100000`
   - 500件ページを複数回取得
   - APIへ `limit 1000` を送らない
   - 最終結果は1000行
4. LIMITなし
   - 従来どおり `fetchAll`
5. KLIKE + `LIMIT 1000`
   - 各ページのWHEREに kintone `like` が保持される
   - `limit 1000` を送らない
6. KLIKE検索打ち切り
   - ページレスポンスの `searchAborted` が最終SELECT警告へ伝播する
   - `fetchAll.onSearchAborted` への個別配線ではなく、`wrapClientWithSearchAbort` がクライアント層ですべての `getRecords` を捕捉することをテストコメントに明記する
7. `ORDER BY $id DESC` + `LIMIT 500 / 501`
   - 500件側（kintone ORDER BY の単発GET）と501件側（fetchAll後のJS `applyOrderBy`）で先頭500行が一致する
   - これは既存の実行経路の非対称を固定する回帰であり、本修正による新しい意味論変更ではない

### 8.2 不変条件

- `LIMIT <= 500` の単発GET最適化を維持する
- `maxRecords` / `onLimitReached` の既存挙動を変更しない
- ORDER BY、OFFSET、選択肢順、数値・日時ソートの意味論を変更しない
- FULL_SCAN の実行計画を変更しない
- CLI / MCP / プラグインごとの分岐を追加せず共通コアで直す

## 9. 受け入れ条件

1. SIMPLE SELECT の `LIMIT > 500` が kintone API へ直接送られない
2. `LIMIT 500` は引き続き単発 GET になる
3. `LIMIT 501` 以上は500件単位のページングで取得できる
4. `maxRecords=100000`、対象1000件、`LIMIT 1000` が1000行を返す
5. KLIKEを含む同条件でも動作し、検索打ち切り警告が失われない
6. 既存テストと追加境界テストがすべて成功する

## 10. 実機確認

モックテストに加え、kintone実機で次を確認する。

```sql
SELECT $id
FROM APP対象
WHERE 絞り込み可能なフィールド = '対象値'
LIMIT 501;
```

- APIエラーにならない
- 501件存在する場合は501行返る
- デバッグログ上、各GETの `limit` が500以下
- 同じ条件の `LIMIT 500` はGET 1回
