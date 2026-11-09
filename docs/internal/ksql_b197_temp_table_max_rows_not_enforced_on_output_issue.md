# B197 `tempTableMaxRows`（1 表の上限）が出来た表の行数を守っていない — JOIN・UNION・CTE などで上限を超える表が作れる

- 状態: 🔧 **案 A で直した（2026-11-09）。v3.93.0 で出す**（2026-10-22 起票・判断待ちだったが、依頼 KJ-11 の ② で**利用者にどう見えるか**が分かったので決めた。§4 が直した内容）。元の起票は以下そのまま。B196（依頼 KJ-2）を調べる途中で見つけた。実測 v3.86.0（`/flow`・モック）。正しさ／安全性（文書が約束している上限が効いていない・規模 S〜M）。直すと**今は通る文がエラーになる**（結果が変わる）ので、CLI・MCP・kSQL プラグイン・ksql-flow への影響を見て判断する

## 1. 現象

`tempTableMaxRows` は、言語リファレンス §27.9 で「一時テーブル実体化上限・超過は常にエラー」、`BatchExecuteOptions` で「一時テーブル実体化の行数上限」、EXPLAIN で「既定上限 N 行・超過はエラー」と書いている。実際は `CREATE TEMP TABLE` の実体化の `maxRecords` に渡しているだけで、**1 回の読取ごとの上限**として働き、出来た表の行数は確かめていない。

`tempTableMaxRows: 5` で流した結果（`/flow`）:

| 形 | 出来た行数 | 結果 |
|---|---|---|
| INNER JOIN（4 件 × 4 件・重複キー） | 16 | 通る |
| UNION ALL（4 件＋4 件） | 8 | 通る |
| `GENERATE_SERIES(1, 100)` | 100 | 通る |
| CTE の CROSS JOIN | 16 | 通る |
| 別の一時テーブルからの CROSS JOIN / UNION ALL | 16 / 8 | 通る |
| 再帰 CTE | 20 | 通る |
| 1 アプリの SELECT（10 件） | — | `FetchAllLimitError` |
| GROUP BY（10 件を読んで 2 行） | — | `FetchAllLimitError`（出来る行数は 2） |

INNER / LEFT / RIGHT JOIN の出力には別の上限も無い（`src/engine/process.ts` の `applyJoin`）。重複キーの JOIN は 左×右 まで増える。

## 2. 影響

- kSQL ジョブ実行プラグイン（ブラウザ）は「1 表は上限 100,000」を製品の上限にしているが、JOIN などで超える表ができる。B196 の合計の上限を渡していれば、合計としては守られる（1 表の上限は守られない）。
- CLI・MCP・kSQL プラグイン・ksql-flow でも同じ。ksql-flow は `tempTableMaxRows` を渡している（B172 の回答で、L 段階に 25,000 を案内した）。

## 3. 案（未決定）

- **案 A**: `CREATE TEMP TABLE` の登録の前に `result.rows.length > tempTableMaxRows` を確かめてエラーにする（B196 の登録の前の確かめと同じ場所）。読取の上限は今のまま。**結果が変わる**＝今は通る JOIN・UNION などの文がエラーになる。エラーの code は今の 1 表の上限と区別するか（`TempTableRowLimitError` など）、`ArgumentError: temp table … exceeds max rows`（エラー表の上限と同じ文言）に揃えるかを決める。
- **案 B**: 文書を実際の動き（読取ごとの上限）に直すだけ。結果は変わらないが、上限としての意味が弱いまま。
- 付随: `fetchAll` は、ちょうど上限で最後のページが満杯（500 の倍数）だと続きを確かめずに上限超えにする（`src/api/fetchAll.ts:148`）。ちょうど上限の行数の表が作れない。直すなら 1 回多く読む。

推奨は案 A（文書が約束している上限を守る）。ただし v3.87.0（B196）に同梱するかは、既存の利用者への影響（ksql-flow の L 段階のジョブに JOIN・UNION で 25,000 行を超える一時テーブルがあるか）を確かめてから。

---

## 4. 直したこと（2026-11-09。v3.93.0・依頼 KJ-11 の ②）

**決定（2026-11-09 Takashi）＝案 A**。読む量と出来た表の行数の役割を分けた。

| 何を数えるか | 設定 | 超えたとき |
|---|---|---|
| 元の SELECT が**読む件数** | `tempTableReadMaxRecords`（省略時は `maxRecords`。どちらも省略したときだけ `max(10,000, tempTableMaxRows)`） | `FetchAllLimitError`／効いているのが `tempTableMaxRows` なら `TempTableRowLimitError`（名前を言い分ける） |
| **出来た表の行数** | `tempTableMaxRows`（既定 10,000） | **`TempTableRowLimitError`**（新規。表は登録しない） |
| 残っている一時テーブルの**合計** | `tempTablesMaxTotalRows` | `TempTableTotalLimitError`（B196。不変） |

**面の互換（回答 §4-2 から変えた点。1 回目のレビューの MAJOR 3 で作り直した）**:
回答どおり「**明示した `maxRecords` は必ず効く**」にすると、`maxRecords` を常に解決して渡す面の
公開の契約が壊れる。

- **MCP と CLI の `maxRecords` の既定は 500**（`src/mcp/tools.ts`・`src/cli/index.ts`）。
  `query({ sql, tempTableMaxRows: 20000 })` **だけ**で 10,001 行を実体化できることが
  試験で固定されている（`src/mcp/__tests__/tools.test.ts`）。
- 純粋に「読む量は `maxRecords`」にすると、この使い方が **500 件で止まる**（回帰）。
- B196 の試験も `tempTableMaxRows: 20_000` だけで 19,999 行を読んでいた。

最初は `max(maxRecords, tempTableMaxRows)` をエンジンの既定の式にしたが、それでは
**明示した `maxRecords` が効かない**（1 回目のレビューの MAJOR 3）。そこで
**実体化の読取だけに効く公開オプション `tempTableReadMaxRecords`** を足し、
**面（MCP・CLI）が `max(maxRecords, tempTableMaxRows ?? 10,000)` を渡す**形にした
（式は `materializeReadMaxRecords`（`src/execute.ts`）の 1 か所。面の数だけ渡すことを
`src/__tests__/b197SurfaceReadLimit.test.ts` で固定）。
**エラー文は必ず効いている上限の名前を言う**。`tempTableReadMaxRecords` が効いたときは、
利用者が動かせる設定（`maxRecords` と `tempTableMaxRows` の大きいほう）も添える。

**上限ちょうど（2 回目のレビューの MAJOR）**: 「上限 + 1 件読んで『ちょうど』と『超過』を区別する」形は、
元データが**ちょうど上限 + 1 件**のときに通ってしまい、上限を 1 件破っていた。区別は `fetchAll` に移し、
**上限で止まったときだけ 1 件の軽い GET で続きの有無を確かめる**（`src/api/fetchAll.ts`）。
これで上限は 1 件も超えず、ちょうど上限（500 の倍数）の表も作れる。
この probe は `onLimit: "error"` のときだけで、`truncate` と `stopAfter` の経路は投げない。

**これで直ったもの**:

1. 集計して 1 行しか残さない文が、**読んだ件数**で止まらない（依頼元の主な困りごと）。
2. エラー文が**効いている上限の名前**を言う（「`maxRecords` を引き上げて」と誤って案内しない）。
3. JOIN・UNION・CTE・`GENERATE_SERIES` で**増えた行**も 1 表の上限で止まる（この起票の本題）。

**`/engine` の公開コードは増やしていない**＝`TempTableRowLimitError` は B196 の
`TempTableTotalLimitError` と同じく `EXECUTION_ERROR` に入る（名前と文で見分ける）。

**試験**: `src/flow-library/__tests__/b197TempTableRowLimit.test.ts` 9 件。
更新した既存の試験: `b196TempTableTotalLimit`（読む量の上限が `maxRecords` になった形）・
`b75RelativeDateTempStep3`・`engine-library/batch`・`mcp/tools`（どれも**文言**の期待）。
