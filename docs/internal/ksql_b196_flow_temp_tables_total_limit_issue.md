# B196 `/flow` の一時テーブルの合計の上限 `tempTablesMaxTotalRows` — 出来た行数で登録の前に止め、読取も残りで止める

- 状態: ✅ **v3.87.0 でリリース（2026-10-22）**。Claude が直接実装（codex 未介在）。実装の commit は b0a2178（作業ブランチ `b196/dev` から main へ）。`CreateExecutionContextOptions.tempTablesMaxTotalRows`・`TempTableTotalLimitError`・`StatementResult.metrics.tempTableRows`。テスト `src/flow-library/__tests__/b196TempTableTotalLimit.test.ts`（20 件）
- 種別: 機能（公開 API の純加法追加）＋安全性（ブラウザのタブのメモリ）
- 優先: **高**（kSQL ジョブ実行プラグインの製品の上限「一時テーブルの合計」のブロッカー。初版の関門）
- 版: minor（v3.87.0 想定）。省略すれば既定動作は変わらない（`metrics.tempTableRows` が増えるだけ）
- 上流の依頼（正）: kintone-plugin の work-link `kSQLエンジンへの依頼-20261022-KJ2-flow一時テーブルの合計.md`（依頼 KJ-2）。回答は同じ場所の `kSQLエンジンからの回答-20261022-KJ2-flow一時テーブルの合計.md`
- 関連: [B195](ksql_b195_flow_dml_confirm_hook_issue.md)（KJ-1）、[B197](ksql_b197_temp_table_max_rows_not_enforced_on_output_issue.md)（調べる途中で見つけた 1 表の上限の穴）、[B172](ksql_b172_flow_max_records_issue.md)（`tempTableMaxRows` を併せて指定する案内）

## 1. 何が足りなかったか

- `ExecutionContext` は不透明で、残っている一時テーブルと行数を利用者が取れない。`StatementResult.tempTable` / `rowCount` は `CREATE TEMP TABLE` だけで、エラー表（`appendValidationErrors`）へ足した行数は外から見えない。
- 文が終わってから数えて止めても、超える分はすでにメモリに載っている。

## 2. 実コードで測った事実（2026-10-22・v3.86.0 の main d453b68）

### 2.1 依頼の「`maxRecords` に残りを渡す」案は多くの経路で効かない

`CREATE TEMP TABLE` は `maxRecords = tempTableMaxRows` で実体化する（`executeBatchStatement`）。`maxRecords` は **1 回の読取（fetch）ごと**の上限で、出来た表の行数ではない。`tempTableMaxRows: 5` で流した結果（モック・`/flow`）:

| 形 | 読取 | 出来た行数 | 止まったか |
|---|---|---|---|
| 1 アプリの SELECT（10 件） | 10 | — | 止まる（`FetchAllLimitError`） |
| GROUP BY（10 件を読んで 2 行） | 10 | — | 止まる（**出来る行数は 2 なのに**読む行数で） |
| INNER JOIN（4 件 × 4 件・重複キー） | 4＋4 | 16 | **止まらない** |
| CROSS JOIN（4×4） | 4＋4 | 16 | 止まらない（CROSS JOIN 自体の上限 10,000 行は別にある） |
| UNION ALL（4＋4） | 4＋4 | 8 | **止まらない**（読取ごとの上限なので合計しない） |
| `GENERATE_SERIES(1, 100)` | 0 | 100 | **止まらない**（系列の上限 10,000 行は別） |
| FROM の無い SELECT の UNION ALL（7 本） | 0 | 7 | **止まらない** |
| CTE の CROSS JOIN（4×4） | 4 | 16 | **止まらない** |
| 別の一時テーブルからの CROSS JOIN / UNION | 0 | 16 / 8 | **止まらない** |
| 再帰 CTE（4 件 × 5 段） | 4 | 20 | **止まらない**（`recursiveCteMaxRows` は別） |

→ 今の 1 表の上限も出来た行数を守っていない（B197 に分けた）。INNER / LEFT / RIGHT JOIN の出力には上限がそもそも無い（`src/engine/process.ts` の `applyJoin`。CROSS だけ `planCrossJoinRows` で 10,000 行）。

### 2.2 そのほか

- エラー表へ足す `appendValidationErrors` の呼出し元は 10 か所（`executeBatchStatement` 2・`executeOnErrorSkip` 1・IMPORT の 3 関数 7）。**どれも確認と書込より前**なので、ここで止めれば書込は 0 回。
- 同じ名前の `CREATE TEMP TABLE` は `analyzeBatch` が `ParseError: temp table … is already defined.` で止める（実行中の上書きは無い）。エラー表は同じ名前に行を足していく。
- `fetchAll` は、読んだ件数がちょうど上限で最後のページが満杯（500 の倍数）だと、続きを確かめずに `FetchAllLimitError` にする（`src/api/fetchAll.ts:148`）。**ちょうど `tempTableMaxRows` 行（500 の倍数）の表は今でも作れない**（依頼の受入基準 1 の「20,000 行・上限 20,000」は 1 文目で止まる）。

## 3. 決めた契約（公開）

```ts
// CreateExecutionContextOptions
tempTablesMaxTotalRows?: number;   // 正の安全な整数。違えば createExecutionContext が RangeError
// ExecutionMetrics（StatementResult.metrics）
tempTableRows: number;             // 文が終わった時点で残っている一時テーブルの行数の合計（オプションの有無によらず）
```

1. **数える範囲**: その実行コンテキストで残っている一時テーブルすべての行数の合計（`CREATE TEMP TABLE`、`VALIDATE … INTO`、`VALIDATE ONLY INTO`、`ON ERROR SKIP … INTO`、IMPORT の同じ INTO）。`DROP TEMP TABLE` で外した表は数えない。CTE・JOIN の途中・SELECT の結果・読取の途中は数えない（文の中だけの一時的なもの）。
2. **登録・追加の前に、出来た行数で止める（全経路）**: `CREATE TEMP TABLE` は実体化のあと・登録の前に「ほかの表の合計＋この表の行数 ≦ 上限」を確かめる。エラー表は足す前に「ほかの表の合計＋足したあとの行数 ≦ 上限」。どの SELECT の形でも効く。
3. **読取の途中でも止める（`CREATE TEMP TABLE`）**: 読取の上限を `min(tempTableMaxRows, max(合計の残り, 1))` にする。合計の残りのほうが厳しくて読取が止まった（`FetchAllLimitError`）ときは `TempTableTotalLimitError` に読み替える。1 表の上限のほうが厳しいときは今の `FetchAllLimitError` のまま。**集計なども読む行数で数える**（出来る行数が少なくても、残りより多く読めば止まる＝今の 1 表の上限と同じ考え）。
4. **超えたとき**: その文は `status = "error"`・`error.code = "TempTableTotalLimitError"`。表は登録・追加しない。書込 0 回（エラー表への追加は書込より前）。後続は今のエラーと同じ fail-fast。メッセージに上限・いまの合計・この文の行数（読取で止めたときは残り）。
5. **後方互換**: 省略すれば合計の上限なし。CLI・MCP・kSQL プラグイン・ksql-flow の動きは変わらない。`metrics` に `tempTableRows` が増える（ksql-flow は `metrics` から決まった項目だけを読むので影響なし）。

依頼からの変更: 依頼の約束 2 の「`maxRecords` に残りを渡す」だけでは多くの経路で止まらないので、**登録の前の確かめ（全経路）を本体**にし、読取の途中で止めるのは足し（`CREATE TEMP TABLE` の読取だけ）にした。

## 4. 実装（b196/dev）

- `src/execute.ts`: `BatchExecuteOptions.tempTablesMaxTotalRows`、`TempTableTotalLimitError`（1624）、`tempTableRowTotal`（1632）、`assertTempTableTotalRows`（1640）、`assertTempTablesMaxTotalRows`（1656。`executeBatch` と `createManagedStatementExecutionContext` で確かめる）、`appendValidationErrors` に合計の上限の引数（10 か所の呼出し元で渡す）、`CREATE TEMP TABLE` の読取の上限と読み替えと登録の前の確かめ（2735〜2753）。
- `src/flow-library/publicTypes.ts`: `tempTablesMaxTotalRows`・`ExecutionMetrics.tempTableRows`。`src/flow-library/index.ts`: `snapshotMetrics` で合計を入れる。
- 文書: 言語リファレンス §27.9（合計の上限の項目・1 表の上限の本当の動き）、README の `/flow` の節。
- 既存テスト 1 件の期待値を更新（`exportSinkPublicApi.test.ts` の公開結果の golden に `tempTableRows: 0`）。

## 5. テスト

- 新規 20 件: 受入基準 1（19,999 行で同じ形。合計 30,000・1 表 20,000。2 つ目の読取は 10,500 件以下で止まる）、2（DROP のあとは成功）、3（`VALIDATE … INTO`・`ON ERROR SKIP … INTO`）、4（書込 0 回・fail-fast）、上限の内側ならエラー表へ足せる、読取で止まらない 4 経路（別の一時テーブルの CROSS JOIN / UNION ALL・`GENERATE_SERIES`・重複キーの INNER JOIN）も登録の前に止まる、読取の途中で止まる 4 経路（CTE・UNION の枝・再帰 CTE の起点・JOIN の右側）、集計は読む行数で止まる、1 表の上限のほうが厳しいときは `FetchAllLimitError` のまま、省略時は今と同じ（16 行の CROSS JOIN が通る・`tempTableRows` は出る）、値の確かめ 4 通り（0・-1・1.5・安全な整数を超える値）。
- `/flow` 9 スイート 175 件が通る。`build:flow`・`flow:bundle-guard` が通り、d.ts を strict の利用側ファイルで型検査して通る。
- 全体（Mac）: jest で落ちるのは main と同じ環境の差の 8 スイート 45 件だけ（`ksql.config.json` が Windows にだけある）。`docs:check` は main と同じ 97 件、`tsc --noEmit` は main と同じ 10 件。

## 6. 対象外・残り

- 1 表の上限が出来た行数を守っていない穴は [B197](ksql_b197_temp_table_max_rows_not_enforced_on_output_issue.md)（直すと既存の利用者で結果が変わるので別に判断）。
- INNER / LEFT / RIGHT JOIN の出力の上限、文の中だけの大きなもの（CTE の実体化・JOIN の途中・SELECT の結果）は数えない。必要なら別の依頼。
- `fetchAll` のちょうど上限（500 の倍数）の扱いは変えていない。
