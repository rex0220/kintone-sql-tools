# 仕様案: `LIMIT > 500` の取得打ち切り最適化（A-8・安全サブセット）

- 作成日: 2026-07-16
- 対象課題: [perf-sql-execution-improvements.md](../perf-sql-execution-improvements.md) §A-8 / [perf-sql-execution-implementation-plan.md](../perf-sql-execution-implementation-plan.md) フェーズ3 A-8
- 前提修正: [ksql_simple_select_limit_over_500_issue.md](ksql_simple_select_limit_over_500_issue.md)（`LIMIT>500` を `fetchAll` へ送る機能バグ＝v2.10.1 で解消済み）
- ステータス: **R3 実装済み・codex 検証済み。v2.11.0 予定③（リリース待ち）**
- 更新履歴:
  - 2026-07-16 R1: 初版
  - 2026-07-16 R2: codex レビュー反映（コードで裏取り）。①「完全後方互換・API 呼び出し数のみ変更」を撤回＝`stopAfter` は `maxRecords/onLimit` の意味論を変える（総数>`maxRecords` でも `offset+limit<=maxRecords` なら従来のエラー/警告なしで成功）と明示（§1.1）②検索打ち切り警告の保証を「実際に取得したレスポンス」に限定③受入の「N 件取得」を「返却/保持 N 件・GET 数 ceil(N/pageSize)・最終ページで最大 pageSize−1 の余分受信は許容」へ厳密化。`stopAfter` の実行時検証（正の安全整数 && `<= maxRecords`）を追加
  - 2026-07-16 R3: codex 再レビュー反映（コードで裏取り）。①**ブロッカー＝KLIKE を安全サブセットから除外**（`whereHasKlike(stmt.where)` true なら `stopAfter` 非適用・§1.2）。検索打ち切りは kintone `like`＝KLIKE のみで起き、除外により `stopAfter` 経路では原理的に発生しない＝見逃し構造的に解消（§6.1）②§1 目的の「性能だけ改善」を「両方成功するケースの返却行は同一・ただし §1.1 の上限意味論変更を含む」へ訂正③`stopAfter` 検証は `ExecuteOptions` に項目がなく結合注入不可のため `fetchAll` 単体のみに置くと明記
  - 2026-07-16 実装: `FetchAllOptions.stopAfter`、安全サブセット判定、過大並列取得防止、単体／結合回帰テスト、利用者向け上限説明を実装。対象テスト・全テスト・ビルドで検証
- 分担: Claude=仕様/観点、Codex=実装/テスト
- SemVer: 性能改善だが **`maxRecords/onLimit` の意味論変更を含む**（§1.1・返却行は現行と一致するが従来エラーだったクエリが成功し得る）→ minor バンドル v2.11.0 の一部

---

## 1. 目的とスコープ

### 目的

SIMPLE SELECT の `LIMIT > 500` で、現状は WHERE 一致分を最大 `maxRecords` まで**全件取得**してから JS で `LIMIT` する（`LIMIT 1000` でも一致 10,000 件を全部取る）。**必要な行数に達した時点で取得を止め**、API 往復とメモリを削減する。**両方とも成功するケースの返却行は現行と同一**。ただし本仕様は **§1.1 の `maxRecords` 上限意味論の変更を含む**（従来エラー/警告だったクエリが成功し得る）。

### スコープ（安全サブセットのみ・v2.11.0）

**`stmt.orderBy` が空**、かつ **KLIKE を含まない**（`whereHasKlike(stmt.where) === false`）SIMPLE SELECT `LIMIT > 500`（`fetchAll` 経路）に限り、`offset + limit` 件に達したら取得を打ち切る。§3 の「フェッチ順＝返却順」と §1.2 の「検索打ち切りを見逃さない」がこの条件でのみ成立する。

### スコープ外（本仕様では最適化しない・現状維持）

- **`ORDER BY` を伴う `LIMIT > 500`** — JS の `applyOrderBy` が全件を再ソートするため、`LIMIT` 窓が全件に依存する。早期打ち切り不可（§3・§5）。
- **KLIKE（kintone キーワード検索）を含む `LIMIT > 500`** — 検索打ち切り（10 万件）警告が後続ページにのみ付く可能性があり、早期停止で見逃してサイレントな不完全結果になり得る（§1.2）。**v2.11.0 では `stopAfter` を適用せず現状の全取得を維持**。
- **`LIMIT <= 500`** — 単発 GET で kintone が order+limit を処理（既に最適）。本仕様の対象外。
- **FULL_SCAN 経路（JOIN / GROUP BY / DISTINCT / 集計 / 式 ORDER BY / サブテーブル）** — 集約・結合に全件が必要。対象外。
- **`offset + limit > maxRecords`** — 必要行数が取得上限を超える。現状どおり `maxRecords` で打ち切り（`onLimit` に従い警告/例外）。

### 1.1 意味論変更の明示（codex レビュー・重要）

本最適化は「API 呼び出し数のみ変更・完全後方互換」**ではない**。`maxRecords/onLimit` の意味論を次のとおり変える（明示的に採用する）:

- **`ORDER BY` なしで `LIMIT` 窓（`offset+limit` 件）を満たしたら正常終了**する。
- **`maxRecords` は「取得した行数」の上限**であり、**未取得の一致総数は検査しない**。
- **対象総数が `maxRecords` を超えても、`offset + limit <= maxRecords` なら**、従来のような取得上限エラー（`onLimit=error`）／truncate 警告（`onLimit=truncate`）は**出ない**（早期停止で `maxRecords` に到達しないため。[fetchAll.ts:125](../../src/api/fetchAll.ts#L125) の判定に到達しない）。
- **返却行は現行と同一**だが、**従来は取得上限エラー/警告になっていたクエリが成功に変わる**場合がある（例: `LIMIT 1000`・`maxRecords=10000`・一致 20,000 件 → 現状はエラー/警告、本仕様では 1,000 行を返して正常終了）。

これは合理的な改善だが、[v2.10.1 仕様](ksql_simple_select_limit_over_500_issue.md)の「`maxRecords`/`onLimitReached` の既存挙動を変更しない」という不変条件とは**衝突する**。厳密に従来の上限エラーを維持するには一致総数の確認＝全件取得が必要で、本最適化とは両立しない。よって v2.11.0 で上記の意味論変更を**受け入れる**。

### 1.2 KLIKE を安全サブセットから除外する（codex レビュー・ブロッカー対応）

検索打ち切り（10 万件）の検出は取得したレスポンスの `searchAborted` に依存する（§6.1）。**KLIKE 検索が打ち切られ、警告が先頭ページに付かず後続ページにのみ付く**場合、`stopAfter` が先に正常終了し、警告を検出できず、返却した先頭 `LIMIT` 行が**完全な検索集合に基づく保証もない**（サイレントな不完全結果）。

「警告は必ず最初のレスポンスにも付く」という API 契約または実機根拠が確認できるまで、**KLIKE を含む WHERE（`whereHasKlike(stmt.where) === true`）では `stopAfter` を適用しない**（現状の全取得を維持）。`whereHasKlike`（[src/core/like.ts:41](../../src/core/like.ts#L41)）は既存で、判定追加は小さい。文書化（§6.1）だけではサイレントな不完全結果を防げないため、コードで除外する。

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
- **受信 vs 返却/保持（codex レビュー・正確化）**: `stopAfter=N` の効果は次のとおり。**返却・保持は N 件**。**GET 数は `ceil(N / pageSize)`**。ページ単位取得のため**最終ページで最大 `pageSize − 1` 件の余分な受信は許容**する（受信後 `slice(0, N)` で N 件に落とす）。**不要な追加ページは発行しない**（「実通信も N 件ちょうど」ではない）。例: `stopAfter=1200`・`pageSize=500` → GET 3 回（最大 1,500 件受信）→ 1,200 件へ slice。
- **`FetchAllOptions` は export（[fetchAll.ts:46](../../src/api/fetchAll.ts#L46)）** されるため、`stopAfter` に**実行時検証**を入れる: `stopAfter` 指定時は **正の安全整数（`Number.isSafeInteger(stopAfter) && stopAfter > 0`）かつ `stopAfter <= maxRecords`** を要求。違反時は `RangeError`（`stopAfter must be a positive safe integer <= maxRecords`）を投げる（呼び出し側バグの早期検出。§4.2 のガードで正当な呼び出しは常に満たす）。
- **過大フェッチ防止**: バッチの並列ページ数計算（[fetchAll.ts:133-135](../../src/api/fetchAll.ts#L133)）の `remaining` を `maxRecords` ではなく `fetchCap = stopAfter ?? maxRecords` 基準にする。`stopAfter` 指定時は必要ページ数だけ並列取得する。
- **停止判定の位置**: 各 `allRecords.push` の直後（先頭ページ [:101](../../src/api/fetchAll.ts#L101) とループ [:159](../../src/api/fetchAll.ts#L159)）に「`stopAfter !== undefined && allRecords.length >= stopAfter` → `return allRecords.slice(0, stopAfter)`（通知なし）」を、**既存の `maxRecords` 超過チェックより前**に置く。`stopAfter <= maxRecords` のため `maxRecords` 超過チェックには到達しない。

### 4.2 `executeSimpleSelect` で `stopAfter` を算出

`fetchAll` 呼び出し（[execute.ts:1127](../../src/execute.ts#L1127)）に、安全サブセット条件を満たすときだけ `stopAfter` を渡す。

```ts
const needed = (stmt.offset ?? 0) + (stmt.limit ?? 0);
const stopAfter =
  stmt.orderBy.length === 0 &&
  stmt.limit !== null &&
  needed <= maxRecords &&
  !whereHasKlike(stmt.where)          // KLIKE は検索打ち切り見逃しの恐れ（§1.2）
    ? needed
    : undefined;
...
records = await fetchAll(client.getRecords, params.app, baseQuery, params.fields,
  { parallel, maxRecords, onLimit, stopAfter, onTruncate: ... });
```

- `stmt.orderBy.length === 0`: フェッチ順＝返却順（§3）。
- `stmt.limit !== null`: `LIMIT` 明示時のみ（この経路は `LIMIT>500`。`LIMIT` なしは全件が目的なので `stopAfter` なし）。
- `needed <= maxRecords`: 必要行数が取得上限内。超えるときは現状の `maxRecords` 打ち切り（警告/例外）に委ねる。
- `!whereHasKlike(stmt.where)`: **KLIKE を含む WHERE は除外**（§1.2・検索打ち切り警告を見逃さないため）。`whereHasKlike` は [src/core/like.ts:41](../../src/core/like.ts#L41)。**インライン CTE**（`buildInlinedQuery` で展開済み）でも、`executeSimpleSelect` が受け取るのは展開後の `stmt` なので、その `stmt.where`（CTE 本体 WHERE ＋ 最終 WHERE の合成）に対して同じ判定が効く。追加対応は不要。

その後の `applyOrderBy`（no-op）→ `applyLimit(rows, stmt.limit, stmt.offset)` は現行のまま。フェッチした `needed` 行から `offset..offset+limit` を切り出す＝結果は現行と一致。

### 4.3 効果

`WHERE` 一致 10,000 件・`LIMIT 1000`（`ORDER BY` なし）: 現状 GET 約 20 回（10,000 件取得）→ **GET 2 回（1,000 件）**。取得量・往復とも約 90% 削減（perf §A-8 の見積り）。

---

## 5. 変更対象ファイル

| ファイル | 変更 |
|---|---|
| `src/api/fetchAll.ts` | `FetchAllOptions.stopAfter?: number` を追加。`fetchCap = stopAfter ?? maxRecords` でバッチ並列数を算出。各 push 後に `stopAfter` 到達で `slice(0, stopAfter)` を通知なしで返す（`maxRecords` 超過チェックより前） |
| `src/execute.ts` | `executeSimpleSelect` で安全サブセット条件（§4.2＝`orderBy` 空・`LIMIT` 明示・`needed<=maxRecords`・`!whereHasKlike`）を満たすとき `stopAfter=needed` を `fetchAll` へ渡す。`whereHasKlike` を import（`src/core/like.ts`） |
| `src/api/__tests__/fetchAll.test.ts` | `stopAfter` の単体テスト（§7） |
| `src/__tests__/execute.test.ts` | `LIMIT>500`×`ORDER BY` 有無で GET 回数・結果一致を固定（§7） |
| `docs/perf-sql-execution-improvements.md` §A-8 / 実装計画 | A-8 の実装完了・安全サブセット範囲を追記 |
| `CHANGELOG.md` / `maxRecords`・`--on-limit` の説明 | 意味論変更（§1.1）を明記＝「`maxRecords` は取得行数の上限。`ORDER BY` なしで `LIMIT` を満たせば一致総数に関わらず正常終了（従来の上限エラー/警告が出ない場合がある）」 |

`applyOrderBy` / `applyLimit` / `project` / SIMPLE 判定・単発 GET 経路は不変。FULL_SCAN 経路も不変。

## 6. スコープ外（再掲・現状維持）

- `ORDER BY` 付き `LIMIT>500`（§3・§5 の非両立）。
- `LIMIT<=500`（単発 GET）。
- `LIMIT` なし（全件が目的）。
- `offset + limit > maxRecords`（`maxRecords` 打ち切りに委譲）。
- FULL_SCAN（JOIN/GROUP BY/DISTINCT/集計/式 ORDER BY/サブテーブル）。
- **KLIKE を含む WHERE**（§1.2・検索打ち切り見逃し回避のため `stopAfter` 非適用＝全取得維持）。

### 6.1 検索打ち切りと KLIKE 除外の関係（codex レビュー）

検索打ち切り（10 万件）の検出は、単文 `execute()`（[execute.ts:284-285](../../src/execute.ts#L284)）・バッチ（[execute.ts:582-593](../../src/execute.ts#L582)）とも `wrapClientWithSearchAbort`（[execute.ts:354-370](../../src/execute.ts#L354)）が**実際に取得した各レスポンスの `searchAborted` を検査**する（`fetchAll.onSearchAborted` も取得ページのみ）。早期停止で未取得のページに警告が付いても検出できない。

**検索打ち切りは kintone `like` 演算子でのみ起きる。v2.0.0 以降、kSQL が WHERE に kintone `like` を出すのは KLIKE のみ**（通常 `LIKE` は JS 評価・`whereToKintone` が拒否）。したがって **§1.2 で KLIKE を `stopAfter` から除外した結果、`stopAfter` を適用する経路（非 KLIKE WHERE）では検索打ち切りが原理的に発生しない**。早期停止による警告見逃しは構造的に起こらない。

KLIKE を含むクエリは `stopAfter` 非適用で全取得するため、検索打ち切り警告は現行どおり全ページ検査で検出される（挙動不変）。

## 7. 受入条件

- [x] `ORDER BY` なし `LIMIT 1000`・一致 5,000 件・`maxRecords=10000`: **GET は 2 回**・**返却/保持 1,000 行**が現行（全取得→LIMIT）と一致。`onTruncate` 未通知。
- [x] **意味論変更（§1.1）**: `ORDER BY` なし `LIMIT 1000`・一致 **20,000 件**・`maxRecords=10000`（`offset+limit ≤ maxRecords`）: **正常終了で 1,000 行**。**従来はここで `onLimit=error`→例外／`onLimit=truncate`→警告だったが、本仕様では出ない**ことを固定（両 `onLimit` 値で確認）。
- [x] `ORDER BY <field>` あり `LIMIT 1000`・一致 5,000 件: **現状どおり全件取得後に JS ソート→LIMIT**（GET 回数・結果が現行と一致・`stopAfter` 不適用）。
- [x] `ORDER BY` なし `LIMIT 1000 OFFSET 200`（`stopAfter=1200`・`pageSize=500`）: **GET 3 回（最大 1,500 件受信）→ 保持 1,200 件 → `applyLimit` で 1,000 行**。結果が現行と一致。「1,200 件ちょうど受信」ではない。
- [x] `ORDER BY` なし `LIMIT 1000`・一致 300 件: 早期打ち切りに到達せず（最終ページで終了）300 行。現行と一致。
- [x] `offset + limit > maxRecords`（例 `LIMIT 100000`・`maxRecords=10000`）: `stopAfter` 不適用。現状どおり `maxRecords` 到達で `onLimit`（error/truncate）挙動。
- [x] `LIMIT <= 500`: 単発 GET のまま（`stopAfter` 経路に入らない）。
- [x] **KLIKE を含む `ORDER BY` なし `LIMIT 1000`: `stopAfter` を適用しない＝全取得（現状維持）**。GET 回数・結果・検索打ち切り警告が現行と一致（§1.2）。
- [x] `fetchAll` 単体: `stopAfter=N`（`N ≤ maxRecords`）で **返却 N 行・`onTruncate` 未通知・GET 数 = `ceil(N/pageSize)`**（最終ページの余分受信は許容・不要な追加ページは発行しない）。
- [x] `fetchAll` 単体（検証）: `stopAfter <= 0` / 非安全整数 / `stopAfter > maxRecords` は `RangeError`。**注**: `ExecuteOptions` に `stopAfter` はないため、`executeSimpleSelect` 経由での不正注入は不可能。この検証は `fetchAll` 単体テストにのみ置く（結合テストには置かない）。

## 8. テスト計画（修正前=全取得 / 修正後=早期停止）

### 単体（`fetchAll`）
- `stopAfter=1000`・データ 5,000・`pageSize=500`・`parallel=1` → GET 2 回・返却 1,000 行・`onTruncate` 未通知。
- `stopAfter=1200`・`pageSize=500` → GET 3 回（最大 1,500 件受信）・返却 1,200 行（最終ページの余分受信を許容・追加ページは発行しない）。
- `stopAfter=1000`・`parallel=3` → 必要ページ（2）だけ取得し過大フェッチなし・返却 1,000 行。
- `stopAfter=1000`・データ 300 → 1 回・300 行。
- `stopAfter` 未指定（従来）→ 挙動不変（`maxRecords` 打ち切り・`onTruncate` 通知）。
- **意味論変更**: `stopAfter=1000`・`maxRecords=10000`・データ 20,000 → 返却 1,000 行・`onTruncate` 未通知・例外なし（`maxRecords` 超過チェックへ到達しない）。
- **検証**: `stopAfter` が `0`／負／非安全整数／`> maxRecords` → `RangeError`。
- **検索打ち切り**: 先頭ページのレスポンスに `searchAborted=true` → `stopAfter` 到達で早期停止しても `onSearchAborted` が呼ばれる（取得済みのため）。

### 結合（`executeSimpleSelect` 経由・GET 回数カウント）
- `ORDER BY` なし `LIMIT 1000`（一致 5,000）→ GET 2 回・結果一致。
- `ORDER BY <field>` あり `LIMIT 1000`（一致 5,000）→ GET 回数=現行・JS ソート結果一致。
- `LIMIT 1000 OFFSET 200` → 結果一致（1,000 行）。
- **意味論変更（§1.1）**: `ORDER BY` なし・一致 20,000・`maxRecords=10000`・`LIMIT 1000` を `onLimit=error` と `onLimit=truncate` の両方で実行 → **どちらも正常終了・1,000 行**（従来の例外／警告が出ないことを固定）。
- `offset+limit > maxRecords` → `maxRecords` 打ち切り挙動（従来どおり）。
- **KLIKE + `LIMIT 1000`（`ORDER BY` なし）→ `stopAfter` 不適用＝全取得**（GET 回数・結果・検索打ち切り警告が現行と一致・§1.2）。
- `stopAfter` 検証（非正・非安全整数・`> maxRecords` で `RangeError`）は **`fetchAll` 単体のみ**（`ExecuteOptions` に `stopAfter` がなく結合経由で注入不可）。

## 9. リスク・非対象

- **リスク（意味論変更・§1.1）**: 従来 `maxRecords` 超過でエラー/警告だったクエリが `offset+limit<=maxRecords` で成功に変わる。**v2.11.0 で明示採用**。CHANGELOG／`maxRecords` の説明に「`maxRecords` は取得行数の上限。`ORDER BY` なしで `LIMIT` を満たせば一致総数に関わらず正常終了」を追記する。
- **リスク（順序前提）**: 早期打ち切りは「フェッチ順（`$id` 昇順）＝返却順」に依存する。`ORDER BY` なしに厳密限定することで担保（`ORDER BY $id ASC` 等の「実質同順」ケースも v2.11.0 では含めない＝安全側）。§3 の根拠を回帰テストで固定。
- **検索打ち切り見逃し（§1.2・§6.1）＝KLIKE 除外で解消**: 検索打ち切りは kintone `like`（＝KLIKE のみ）で起き、KLIKE を `stopAfter` から除外したため `stopAfter` 適用経路では原理的に発生しない。KLIKE クエリは全取得維持で現行どおり検出。
- **リスク（`onTruncate` 誤通知）**: `stopAfter` 到達を打ち切り（`maxRecords` 超過）と混同すると誤警告になる。`stopAfter` の返却は通知なし・`stopAfter <= maxRecords` 保証で分離。
- **非対象**: `ORDER BY` 付き（押し下げはカーソルページングと非両立）・`LIMIT` なし・FULL_SCAN・`offset+limit > maxRecords`。

## 10. 未決事項（codex / ユーザー判断）

1. **`ORDER BY $id ASC`（単独）の扱い**: フェッチ順と一致するため理論上は早期打ち切り可能。ただし「`orderBy` が `$id` 昇順のみか」の判定を足す必要があり、安全側で **v2.11.0 は `ORDER BY` 完全に空のみ**とする（推奨）。将来 `$id ASC` 単独を追加可否は別途。
2. **EXPLAIN 注記**: `LIMIT>500`×`ORDER BY` なしのとき「取得は `offset+limit` 件で打ち切り」を EXPLAIN に出すか。診断値はあるが必須ではない。既定は出さない（実装簡素）・要望あれば追加。
