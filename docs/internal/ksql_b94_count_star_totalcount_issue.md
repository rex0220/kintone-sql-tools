# B94 `SELECT COUNT(*)` が全件取得している（`totalCount` で 1 リクエストにできる）

- 起票: 2026-07-29
- ステータス: ✅ **リリース済み（v3.32.0・2026-07-29）**。**Pro が実機で確認**＝APP912（実件数 10,228）が **1 リクエストで 10228**、従来 `FetchAllLimitError` だった APP730（実件数 618,525）も **676ms で返る**
- 出典: オーナーからの指摘 2026-07-29
- 関連: [B84 押し下げ可否の公開](ksql_b84_pushdown_visibility_spec.md)

## 1. 現状（実機で確認・v3.31.1）

```
EXPLAIN SELECT COUNT(*) AS c FROM APP4147
  mode:          FULL_SCAN
  reason:        集計関数（COUNT / SUM 等）あり
  kintone query: (全件取得)
  fields:        $id
```

**`fields` は `$id` だけに絞られている**が、**レコードは全件取得している。**
件数を数えるためだけに **`ceil(N / 500)` 回**（またはカーソル経由で同等）の往復が発生する。

- 10 万件のアプリ → **200 回以上**の取得
- 得たいのは**数値 1 つ**

## 2. kintone REST API は 1 リクエストで返せる

[複数のレコードを取得する](https://cybozu.dev/ja/kintone/docs/rest-api/records/get-records/) の
リクエストパラメーター **`totalCount`**（真偽値）で、
**`query` で指定した条件に一致するレコードの件数**がレスポンスの `totalCount` に返る。

```
GET /k/v1/records.json?app=1&query=<条件> limit 1&totalCount=true
→ { "records": [...1件...], "totalCount": "123456" }
```

**アプリの規模に関係なく 1 リクエスト**で済む。

## 3. 既存の配線状況（コードで確認）

**部品は既にある。**

| | 現状 |
|---|---|
| [`KintoneGetParams.totalCount`](../../src/converter/selectToKintone.ts#L48) | **型に存在する**が [常に `false`](../../src/converter/selectToKintone.ts#L156) |
| [`nodeKintoneClient.getRecords`](../../src/cli/nodeKintoneClient.ts#L234) | **`totalCount` を送っていない**（クエリ文字列に含めない） |
| [`nodeKintoneClient.openCursor`](../../src/cli/nodeKintoneClient.ts#L277) | **カーソル作成のレスポンスで `totalCount` を既に受け取っている**（`createKintoneCursorHandle(Number(created.totalCount), ...)`） |

**カーソル経路は総件数を最初から知っている**のに、`COUNT(*)` でも全件読んでいる。

## 4. 適用条件（ここを外すと誤った件数になる）

**すべて満たすときだけ**適用する。1 つでも欠けたら従来どおり全件取得する。

1. **`SELECT COUNT(*)` だけ**（他の列・他の集計関数を含まない）
2. **`GROUP BY` / `HAVING` / `DISTINCT` が無い**
3. **`JOIN` が無い**
4. **FROM が物理アプリ**（一時テーブル・CTE・サブテーブル仮想テーブルは対象外）
5. **`WHERE` が完全に押し下がる**（client 側の残余評価が 1 つも無い）

**5 が最も重要。**ksql は `LIKE` を JS 評価に統一しており（v2.0.0）、
関数・算術・`OR`/`NOT` の形によっては**取得後に client で絞る**。
その場合 `totalCount` は**絞る前の件数**なので、**使うと誤った値を返す。**

> **`COUNT(field)` は対象外。**`totalCount` はレコード件数であり、
> フィールドが空のレコードを除外する `COUNT(列)` とは意味が違う。

### 4.2 判定は**既存の仕組みがそのまま使える**（実機とコードで確認）

**新しい判定を書く必要は無い。**エンジンは既に「WHERE が完全に押し下がるか」を計算し、
**計画にも出している。**

```
-- 押し下がらない（DROP_DOWN の = は kintone が in/not in しか受けない）
EXPLAIN SELECT COUNT(*) FROM APP4149 WHERE 商談フェーズ = '受注'
  reason:        集計関数（COUNT / SUM 等）あり, WHERE_RESIDUAL   ← マーカー
  kintone query: (全件取得)

-- 押し下がる
EXPLAIN SELECT COUNT(*) FROM APP4149 WHERE 売上 > 100
  reason:        集計関数（COUNT / SUM 等）あり                    ← マーカー無し
  kintone query: 売上 > 100
  pushdown candidate: 売上 > 100（実行時の型・実在確認待ち）
```

**該当する仕組み**＝[`classifyWhereCapability`](../../src/core/optimization/whereCapability.ts#L128) が
返す [`PredicateCapability`](../../src/core/optimization/whereCapability.ts#L15)。

| 値 | totalCount |
|---|---|
| **`EXACT_PUSHDOWN`** | **使える** |
| `SUPERSET_PREFILTER` | **使えない**（サーバーが広く返し client で絞る） |
| `LOCAL_ONLY` / `UNSUPPORTED` | 使えない |

**既に同じ判定で分岐している前例がある**ので、判定基準を新規に作らずに済む。

- [`canonicalOrderPlanner`](../../src/core/optimization/canonicalOrderPlanner.ts#L101)
  … `!== "EXACT_PUSHDOWN"` なら `WHERE_NOT_EXACT`
- [`joinPredicatePushdown`](../../src/core/optimization/joinPredicatePushdown.ts#L228)
  … `!== "EXACT_PUSHDOWN"` なら `unsafe()`

### 4.3 判定は**実行時**に確定する（計画時ではない）

押し下がる例の計画に **`pushdown candidate: …（実行時の型・実在確認待ち）`** とあるとおり、
**押し下げの可否は実行時にフィールドの型と実在を確認して確定する。**

→ **`totalCount` を使うかどうかの判断も、押し下げが確定した後に行う。**
計画時の見込みで決めると、**実行時に候補が外れた場合に誤った件数を返す。**

### 4.1 検索打ち切りとの関係

`KLIKE`（kintone ネイティブの `like`）を押し下げた場合、
**10 万件で検索が打ち切られる**（`X-Cybozu-Warning: Filter aborted ...`）。
そのとき `totalCount` は**打ち切り後の値**になる。

**通常の `SELECT` は打ち切り時に警告を付けて部分結果を返す**のが現行契約であり、
**fail-closed ではない**（DML・外部結合だけが fail-closed）。
→ **今日と同じ警告を付ける。**新しい fail-closed は作らない（[仕様 §4.3](ksql_b94_count_star_totalcount_spec.md)）。

## 5. 実装案

### 5.1 案 A — `getRecords` に `totalCount` を送る（推奨）

`limit 1` ＋ `totalCount=true` で 1 リクエスト。**最も安い。**

**ただし BYO クライアントの契約に触れる。**
`ReadonlyGetRecordsResult` へ `totalCount?` を足す必要があり、
**公開型が変わる**（B66 の declaration snapshot が動く）。

**BYO クライアントが `totalCount` を返さない場合は、従来どおり全件取得へ落とす。**
**推測で 0 や undefined を件数にしない。**

> [B85](ksql_b85_library_validate_constraints_issue.md) / [B93](ksql_b93_getfields_contract_error_issue.md) の教訓＝
> **BYO クライアントは契約から外れる。**「返ってこなければ諦める」形にして、
> **誤った件数を返す余地を作らない。**

### 5.2 案 B — カーソルを作って `totalCount` だけ読み、すぐ閉じる

**BYO クライアントの変更が不要。**`openCursor` は既に総件数を返している。

- 2 リクエスト（作成＋削除）
- **カーソルの同時利用枠を 1 つ消費する**（ホストあたり既定 2）

**案 A が使えない BYO クライアント向けの代替**として有効。

### 5.3 推奨（**仕様 R1 で案 B は不採用**）

**案 A を本線とし、使えなければ現状維持（全件取得）の 2 段階にする。**

**案 B は作らない**＝2 リクエスト＋カーソル枠を消費し、案 A のフォールバックとして割に合わない。
→ [実装仕様 §4.4](ksql_b94_count_star_totalcount_spec.md)

**どちらの段でも正しい件数を返す。**

## 6. 効果

| アプリの規模 | 現状 | 案 A |
|---:|---:|---:|
| 500 件 | 1〜2 回 | **1 回** |
| 1 万件 | 20 回以上 | **1 回** |
| 10 万件 | 200 回以上 | **1 回** |

**ダッシュボードの KPI タイル（総件数）は典型的な用途**で、
**ペインの数だけ全件取得が走っている**可能性がある。

## 7. 規模

- 調査（適用条件の判定・押し下げ完全性の既存判定を再利用できるか）: 0.25〜0.5 人日
- 実装（案 A＋案 B のフォールバック）: 0.5〜1.0 人日
- テスト（適用条件の直積・打ち切り時の fail-closed・BYO 未対応時のフォールバック）: 0.5 人日

**合計 1.25〜2.0 人日。SemVer=minor**（公開型へ `totalCount?` を足すため純加法）。

## 8. 優先度の根拠

**誤った結果を返す類ではない**ので緊急ではないが、
**効果が大きく、適用条件が明確**で、**部品が既にある**。

**最大の注意点は「押し下げが完全なときだけ使う」こと。**
ここを誤ると **B78 / B79 / B86 と同じ silent wrong result** になる。
**件数は検算されにくい**（利用者は返ってきた数を信じる）ので、
**押し下げ完全性の判定を新規に書かず、既存の判定を再利用する**こと。
