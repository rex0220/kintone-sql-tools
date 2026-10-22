# B197 `tempTableMaxRows`（1 表の上限）が出来た表の行数を守っていない — JOIN・UNION・CTE などで上限を超える表が作れる

- 状態: 📝 **起票のみ（2026-10-22・直すかは判断待ち）**。B196（依頼 KJ-2）を調べる途中で見つけた。実測 v3.86.0（`/flow`・モック）。正しさ／安全性（文書が約束している上限が効いていない・規模 S〜M）。直すと**今は通る文がエラーになる**（結果が変わる）ので、CLI・MCP・kSQL プラグイン・ksql-flow への影響を見て判断する

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
