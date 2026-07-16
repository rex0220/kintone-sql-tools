# 仕様案: `LIMIT > 500` の取得打ち切り最適化（A-8・安全サブセット）

- 作成日: 2026-07-16
- 対象課題: [perf-sql-execution-improvements.md](../perf-sql-execution-improvements.md) §A-8 / [perf-sql-execution-implementation-plan.md](../perf-sql-execution-implementation-plan.md) フェーズ3 A-8
- 前提修正: [ksql_simple_select_limit_over_500_issue.md](ksql_simple_select_limit_over_500_issue.md)（`LIMIT>500` を `fetchAll` へ送る機能バグ＝v2.10.1 で解消済み）
- ステータス: **仕様案 R1（codex レビュー前）。v2.11.0 予定③（B1・B2 の後）**
- 分担: Claude=仕様/観点、Codex=実装/テスト
- SemVer: 性能改善・後方互換（返却行は現行と完全一致・API 呼び出し数のみ削減）→ minor バンドル v2.11.0 の一部

---

## 1. 目的とスコープ

### 目的

SIMPLE SELECT の `LIMIT > 500` で、現状は WHERE 一致分を最大 `maxRecords` まで**全件取得**してから JS で `LIMIT` する（`LIMIT 1000` でも一致 10,000 件を全部取る）。**必要な行数に達した時点で取得を止め**、API 往復とメモリを削減する。返却行は現行と**完全一致**（正しさは不変・性能だけ改善）。

### スコープ（安全サブセットのみ・v2.11.0）

**`stmt.orderBy` が空**の SIMPLE SELECT `LIMIT > 500`（`fetchAll` 経路）に限り、`offset + limit` 件に達したら取得を打ち切る。§3 の「フェッチ順＝返却順」がこの条件でのみ成立する。

### スコープ外（本仕様では最適化しない・現状維持）

- **`ORDER BY` を伴う `LIMIT > 500`** — JS の `applyOrderBy` が全件を再ソートするため、`LIMIT` 窓が全件に依存する。早期打ち切り不可（§3・§5）。
- **`LIMIT <= 500`** — 単発 GET で kintone が order+limit を処理（既に最適）。本仕様の対象外。
- **FULL_SCAN 経路（JOIN / GROUP BY / DISTINCT / 集計 / 式 ORDER BY / サブテーブル）** — 集約・結合に全件が必要。対象外。
- **`offset + limit > maxRecords`** — 必要行数が取得上限を超える。現状どおり `maxRecords` で打ち切り（`onLimit` に従い警告/例外）。

---

## 2. 現状（コード裏取り済み）

### 2.1 `LIMIT>500` は全件取得してから JS で LIMIT

`executeSimpleSelect`（[execute.ts:1113-1148](../../src/execute.ts#L1113)）:

```ts
const useSingleGet = stmt.limit !== null && stmt.limit <= 500;
...
} else {
  const baseQuery = stmt.where ? whereToKintone(stmt.where) : "";
  records = await fetchAll(client.getRecords, params.app, baseQuery, params.fields,
    { parallel, maxRecords, onLimit, onTruncate: ... });   // WHERE のみ。order by / limit は付けない
}
let rows = records.map((r) => flatten(r, null));
if (!useSingleGet) {
  const { optionOrders, sortKinds } = await buildOrderByMetaForSelect(stmt, client, cacheContext);
  rows = applyOrderBy(rows, stmt.orderBy, optionOrders, sortKinds);   // ← JS ソート（空なら no-op）
  rows = applyLimit(rows, stmt.limit, stmt.offset);                    // ← JS で LIMIT/OFFSET
}
```

`fetchAll` に渡すのは **WHERE 句のみ**。`maxRecords`（既定 10,000）まで取得し、その後 JS で `applyOrderBy` → `applyLimit`。

### 2.2 `fetchAll` は常に `order by $id asc` でページングする

`buildCursorQuery`（[fetchAll.ts:255-262](../../src/api/fetchAll.ts#L255)）は初回ウィンドウ（`cursorId=0`）から常に `order by $id asc` を付与する（カーソルページングの順序安定化のため）。並列取得のレスポンスも **offset 順に結合**（[fetchAll.ts:156-171](../../src/api/fetchAll.ts#L156)）。よって `fetchAll` の戻り行は**常に `$id` 昇順で確定**する。

### 2.3 打ち切りは `maxRecords` のみ（LIMIT では止めない）

`fetchAll` の停止条件は「最終ページ（`records.length < pageSize`）」か「`maxRecords` 到達」（[fetchAll.ts:104-131,162-172](../../src/api/fetchAll.ts#L104)）だけ。SQL の `LIMIT` は `fetchAll` に渡らないため、`LIMIT 1000` でも一致 5,000 件なら 5,000 件すべて取得してから JS で 1,000 件へ削る。

---

## 3. 安全性の根拠（フェッチ順＝返却順）

`fetchAll` の戻りは常に `$id` 昇順（§2.2）。返却は `applyOrderBy(rows, stmt.orderBy)` → `applyLimit(rows, limit, offset)`。

- **`stmt.orderBy` が空**: `applyOrderBy` は no-op（順序不変）→ 返却順＝フェッチ順（`$id` 昇順）。`applyLimit` は先頭から `offset..offset+limit` を切り出す。したがって**先頭 `offset+limit` 行だけ取得すれば、残りを取得しても最終結果は変わらない**。早期打ち切りは現行と**ビット同一**の結果を返す（同じ `$id` 昇順の同じ窓）。
- **`stmt.orderBy` が非空**: `applyOrderBy` が全フェッチ行を `orderBy` キーで**再ソート**する。`LIMIT` 窓（ソート後の先頭 N）は全件に依存し、フェッチ順（`$id` 昇順）の先頭 `offset+limit` 行が結果の先頭 `offset+limit` 行と一致する保証がない。→ 早期打ち切り不可。

### なぜ ORDER BY 付きを「押し下げ」で救えないか

`fetchAll` はカーソルページング（`$id > cursorId order by $id asc`）で 10,000 件超に対応している（[fetchAll.ts:9-12,117-120](../../src/api/fetchAll.ts#L9)）。カーソルは **`order by $id asc` を要求**するため、任意の `ORDER BY <field>` をページングクエリへ同時に載せられない（順序が二重指定になり、10,000 件超でカーソルが破綻する）。よって「`ORDER BY` を kintone に押し下げてフェッチ順＝返却順にする」案は現行のページング基盤と両立せず、本仕様の対象外。

---

## 4. 設計

### 4.1 `fetchAll` に軟停止 `stopAfter` を追加

`FetchAllOptions` に `stopAfter?: number` を追加する。

- **意味**: 収集済み行数が `stopAfter` に達したら、`allRecords.slice(0, stopAfter)` を返して**打ち切り通知（`onTruncate`）を出さない**（`maxRecords` 到達＝過大取得の警告とは別。`LIMIT` 充足は正常終了）。
- **呼び出し側の契約**: `stopAfter <= maxRecords` を保証して渡す（§4.2 のガードで担保）。これにより `stopAfter` で返す行数が `maxRecords` を破らない。
- **過大フェッチ防止**: バッチの並列ページ数計算（[fetchAll.ts:133-135](../../src/api/fetchAll.ts#L133)）の `remaining` を `maxRecords` ではなく `fetchCap = stopAfter ?? maxRecords` 基準にする。`stopAfter` 指定時は必要ページ数だけ並列取得する。
- **停止判定の位置**: 各 `allRecords.push` の直後（先頭ページ [:101](../../src/api/fetchAll.ts#L101) とループ [:159](../../src/api/fetchAll.ts#L159)）に「`stopAfter !== undefined && allRecords.length >= stopAfter` → `return allRecords.slice(0, stopAfter)`（通知なし）」を、**既存の `maxRecords` 超過チェックより前**に置く。`stopAfter <= maxRecords` のため `maxRecords` 超過チェックには到達しない。

### 4.2 `executeSimpleSelect` で `stopAfter` を算出

`fetchAll` 呼び出し（[execute.ts:1127](../../src/execute.ts#L1127)）に、安全サブセット条件を満たすときだけ `stopAfter` を渡す。

```ts
const needed = (stmt.offset ?? 0) + (stmt.limit ?? 0);
const stopAfter =
  stmt.orderBy.length === 0 && stmt.limit !== null && needed <= maxRecords
    ? needed
    : undefined;
...
records = await fetchAll(client.getRecords, params.app, baseQuery, params.fields,
  { parallel, maxRecords, onLimit, stopAfter, onTruncate: ... });
```

- `stmt.orderBy.length === 0`: フェッチ順＝返却順（§3）。
- `stmt.limit !== null`: `LIMIT` 明示時のみ（この経路は `LIMIT>500`。`LIMIT` なしは全件が目的なので `stopAfter` なし）。
- `needed <= maxRecords`: 必要行数が取得上限内。超えるときは現状の `maxRecords` 打ち切り（警告/例外）に委ねる。

その後の `applyOrderBy`（no-op）→ `applyLimit(rows, stmt.limit, stmt.offset)` は現行のまま。フェッチした `needed` 行から `offset..offset+limit` を切り出す＝結果は現行と一致。

### 4.3 効果

`WHERE` 一致 10,000 件・`LIMIT 1000`（`ORDER BY` なし）: 現状 GET 約 20 回（10,000 件取得）→ **GET 2 回（1,000 件）**。取得量・往復とも約 90% 削減（perf §A-8 の見積り）。

---

## 5. 変更対象ファイル

| ファイル | 変更 |
|---|---|
| `src/api/fetchAll.ts` | `FetchAllOptions.stopAfter?: number` を追加。`fetchCap = stopAfter ?? maxRecords` でバッチ並列数を算出。各 push 後に `stopAfter` 到達で `slice(0, stopAfter)` を通知なしで返す（`maxRecords` 超過チェックより前） |
| `src/execute.ts` | `executeSimpleSelect` で安全サブセット条件（§4.2）を満たすとき `stopAfter=needed` を `fetchAll` へ渡す |
| `src/api/__tests__/fetchAll.test.ts` | `stopAfter` の単体テスト（§7） |
| `src/__tests__/execute.test.ts` | `LIMIT>500`×`ORDER BY` 有無で GET 回数・結果一致を固定（§7） |
| `docs/perf-sql-execution-improvements.md` §A-8 / 実装計画 | A-8 の実装完了・安全サブセット範囲を追記 |

`applyOrderBy` / `applyLimit` / `project` / SIMPLE 判定・単発 GET 経路は不変。FULL_SCAN 経路も不変。

## 6. スコープ外（再掲・現状維持）

- `ORDER BY` 付き `LIMIT>500`（§3・§5 の非両立）。
- `LIMIT<=500`（単発 GET）。
- `LIMIT` なし（全件が目的）。
- `offset + limit > maxRecords`（`maxRecords` 打ち切りに委譲）。
- FULL_SCAN（JOIN/GROUP BY/DISTINCT/集計/式 ORDER BY/サブテーブル）。
- KLIKE 等の押し下げ WHERE は `baseQuery` に含まれるため `stopAfter` と両立（`fetchAll` は WHERE をそのままページングするだけ）。検索打ち切り（10 万件）の `onSearchAborted` は `stopAfter` 到達前に検出されれば通知される（各ページレスポンスを検査する既存経路は不変）。

## 7. 受入条件

- [ ] `ORDER BY` なし `LIMIT 1000`・一致 5,000 件・`maxRecords=10000`: **GET は 2 回**（1,000 件）で、結果 1,000 行が現行（全取得→LIMIT）と**完全一致**。`onTruncate` 未通知。
- [ ] `ORDER BY <field>` あり `LIMIT 1000`・一致 5,000 件: **現状どおり全件取得後に JS ソート→LIMIT**（GET 回数・結果が現行と一致・`stopAfter` 不適用）。
- [ ] `ORDER BY` なし `LIMIT 1000 OFFSET 200`: `needed=1200` 件取得し、`offset..offset+limit`＝1,000 行。結果が現行と一致。
- [ ] `ORDER BY` なし `LIMIT 1000`・一致 300 件: 早期打ち切りに到達せず（最終ページで終了）300 行。現行と一致。
- [ ] `offset + limit > maxRecords`（例 `LIMIT 100000`・`maxRecords=10000`）: `stopAfter` 不適用。現状どおり `maxRecords` 到達で `onLimit`（error/truncate）挙動。
- [ ] `LIMIT <= 500`: 単発 GET のまま（`stopAfter` 経路に入らない）。
- [ ] KLIKE + `ORDER BY` なし `LIMIT 1000`: WHERE に kintone `like` が保持されつつ、`stopAfter` で早期打ち切り。検索打ち切り警告が失われない。
- [ ] `fetchAll` 単体: `stopAfter=N`（`N<=maxRecords`）で N 行返却・`onTruncate` 未通知。並列取得でも N 行で停止し過大フェッチしない（GET 回数 = ceil(N/pageSize)）。

## 8. テスト計画（修正前=全取得 / 修正後=早期停止）

### 単体（`fetchAll`）
- `stopAfter=1000`・データ 5,000・`pageSize=500`・`parallel=1` → GET 2 回・1,000 行・`onTruncate` 未通知。
- `stopAfter=1000`・`parallel=3` → 必要ページ（2）だけ取得し過大フェッチなし・1,000 行。
- `stopAfter=1000`・データ 300 → 1 回・300 行。
- `stopAfter` 未指定（従来）→ 挙動不変（`maxRecords` 打ち切り・`onTruncate` 通知）。
- `stopAfter <= maxRecords` 前提: `maxRecords` 超過チェックへ到達しないことを確認。

### 結合（`executeSimpleSelect` 経由・GET 回数カウント）
- `ORDER BY` なし `LIMIT 1000`（一致 5,000）→ GET 2 回・結果一致。
- `ORDER BY <field>` あり `LIMIT 1000`（一致 5,000）→ GET 回数=現行・JS ソート結果一致。
- `LIMIT 1000 OFFSET 200` → 結果一致（1,000 行）。
- `offset+limit > maxRecords` → `maxRecords` 打ち切り挙動。
- KLIKE + `LIMIT 1000`（`ORDER BY` なし）→ 早期停止・WHERE 保持・検索打ち切り通知。

## 9. リスク・非対象

- **リスク（順序前提）**: 早期打ち切りは「フェッチ順（`$id` 昇順）＝返却順」に依存する。`ORDER BY` なしに厳密限定することで担保（`ORDER BY $id ASC` 等の「実質同順」ケースも v2.11.0 では含めない＝安全側）。§3 の根拠を回帰テストで固定。
- **リスク（`onTruncate` 誤通知）**: `stopAfter` 到達を打ち切り（`maxRecords` 超過）と混同すると誤警告になる。`stopAfter` の返却は通知なし・`stopAfter <= maxRecords` 保証で分離。
- **非対象**: `ORDER BY` 付き（押し下げはカーソルページングと非両立）・`LIMIT` なし・FULL_SCAN・`offset+limit > maxRecords`。

## 10. 未決事項（codex / ユーザー判断）

1. **`ORDER BY $id ASC`（単独）の扱い**: フェッチ順と一致するため理論上は早期打ち切り可能。ただし「`orderBy` が `$id` 昇順のみか」の判定を足す必要があり、安全側で **v2.11.0 は `ORDER BY` 完全に空のみ**とする（推奨）。将来 `$id ASC` 単独を追加可否は別途。
2. **EXPLAIN 注記**: `LIMIT>500`×`ORDER BY` なしのとき「取得は `offset+limit` 件で打ち切り」を EXPLAIN に出すか。診断値はあるが必須ではない。既定は出さない（実装簡素）・要望あれば追加。
