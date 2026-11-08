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
| 元の SELECT が**読む件数** | `maxRecords`（**`tempTableMaxRows` のほうが大きいときはその値まで読む**。下の「互換のための例外」） | `FetchAllLimitError`／効いているのが `tempTableMaxRows` なら `TempTableRowLimitError`（名前を言い分ける） |
| **出来た表の行数** | `tempTableMaxRows`（既定 10,000） | **`TempTableRowLimitError`**（新規。表は登録しない） |
| 残っている一時テーブルの**合計** | `tempTablesMaxTotalRows` | `TempTableTotalLimitError`（B196。不変） |

**互換のための例外（回答 §4-2 から変えた点）**: 回答では「読む量は `maxRecords`」と書いたが、
**`tempTableMaxRows` のほうが大きいときはその値まで読む**形にした。理由は実測で分かった公開の契約で、

- **MCP の `maxRecords` の既定は 500**（`src/mcp/tools.ts`）。
  `query({ sql, tempTableMaxRows: 20000 })` **だけ**で 10,001 行を実体化できることが
  試験で固定されている（`src/mcp/__tests__/tools.test.ts`）。
- 純粋に「読む量は `maxRecords`」にすると、この使い方が **500 件で止まる**（回帰）。
- B196 の試験も `tempTableMaxRows: 20_000` だけで 19,999 行を読んでいた。

そこで **`tempTableMaxRows` を `maxRecords` より大きく指定すること＝「大きい表を作りたい」という
意思表示**として扱い、その値まで読む。`maxRecords` のほうが大きければ `maxRecords` が効く
（依頼元は両方 10,000 なので、どちらでも同じ）。**エラー文は必ず効いている上限の名前を言う。**

**これで直ったもの**:

1. 集計して 1 行しか残さない文が、**読んだ件数**で止まらない（依頼元の主な困りごと）。
2. エラー文が**効いている上限の名前**を言う（「`maxRecords` を引き上げて」と誤って案内しない）。
3. JOIN・UNION・CTE・`GENERATE_SERIES` で**増えた行**も 1 表の上限で止まる（この起票の本題）。

**`/engine` の公開コードは増やしていない**＝`TempTableRowLimitError` は B196 の
`TempTableTotalLimitError` と同じく `EXECUTION_ERROR` に入る（名前と文で見分ける）。

**試験**: `src/flow-library/__tests__/b197TempTableRowLimit.test.ts` 9 件。
更新した既存の試験: `b196TempTableTotalLimit`（読む量の上限が `maxRecords` になった形）・
`b75RelativeDateTempStep3`・`engine-library/batch`・`mcp/tools`（どれも**文言**の期待）。
