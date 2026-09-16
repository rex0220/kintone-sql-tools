# B182 実装報告（codex・2026-09-16）

> `codex exec -s workspace-write` の最終メッセージをそのまま保存（[依頼書](ksql_b182_codex_impl_request.md)。絶対パスのリンクはコード表記へ変更）。Claude のレビューと修正は末尾の「Claude レビュー」節。

## 変更ファイル一覧

- `src/core/expressionSemantics.ts:1` — 意味型判定 helper を新設
- `src/engine/process.ts:433` — `ARITH_COL` 集計実体化、ORDER BY 型判定
- `src/engine/evalWhere.ts:191` — WHERE/HAVING 関数比較の型判定
- `src/execute.ts:3725` — HAVING、CTE・一時列メタ、集計参照収集
- `src/converter/selectToKintone.ts:75` — `ARITH_COL` 内集計を FULL_SCAN と判定
- `src/core/groupingValidation.ts:136` — 集計入り `ARITH_COL` alias を HAVING 参照可能に変更
- `src/core/cteInlining.ts:6` — 共通の集計 query 判定を使用
- `src/engine/__tests__/b182CoalesceAggregate.test.ts:1` — B182 受入・境界テスト
- `docs/ksql_language_reference.md:466` — 数値意味型の仕様を追記

`docs/ksql_batch_recipes.md` R17 には、今回修正対象となる「CASEを使う理由」の記述がなかったため変更していません。

## 1.1 算術値修正

| 修正 | 根拠 |
|---|---|
| `ARITH_COL` 内の集計を集計 query として認識 | `src/engine/process.ts:433` |
| `ARITH_COL` の集計依存を実体化し、確定値へ置換後に算術評価 | `src/engine/process.ts:640`、`src/engine/process.ts:2083` |
| ORDER BY alias・最終射影で実体化値を使用 | `src/engine/process.ts:1269`、`src/engine/process.ts:1593` |
| 単文実行でも SIMPLE に流れないよう FULL_SCAN 判定を修正 | `src/converter/selectToKintone.ts:82` |
| HAVING alias・CTE inline・scalar probeも共通集計判定へ統一 | `src/core/groupingValidation.ts:136`、`src/core/cteInlining.ts:6`、`src/execute.ts:3422` |

## 1.2 型推定修正

| 修正 | 根拠 |
|---|---|
| 既知数値関数、`CAST AS NUMBER`、全数値引数関数を共通判定 | `src/core/expressionSemantics.ts:5`、`src/core/expressionSemantics.ts:40` |
| 同一SELECTのORDER BY・ウィンドウORDER BY | `src/engine/process.ts:1156`、`src/engine/process.ts:2259` |
| CTE・一時テーブル列メタ | `src/execute.ts:5555`、`src/execute.ts:5796` |
| HAVING alias | `src/execute.ts:3768` |
| WHERE/HAVING の関数比較 | `src/engine/evalWhere.ts:191` |
| REORDERの関数キー | `src/execute.ts:11606` |

## テスト

追加した7テスト:

1. `COALESCE` / `ISNULL` / `NULLIF` を包む算術、GROUP BY有無
2. 0行、HAVING alias、DISTINCT
3. LEFT JOIN不一致側
4. CTEのDESC/ASC、RANK、累計
5. `NULLIF` / `GREATEST` / `LEAST`、文字列混在、NUMBER・数値CALC、WHERE比較
6. 文書の推奨3形と修正後 `COALESCE` の値・順序比較
7. 一時テーブルと `executeStatement` バッチ経路、結果shape

結果:

- 新規テスト: **7 passed / 0 failed**
- B119〜B122回帰: **54 passed / 0 failed**
- `npm test`:
  - 通常: **298 suites、6475 tests passed**
  - サブプロセス: **2 suites、26 tests passed**
  - 合計: **300 suites、6501 tests passed、0 failed**
  - Snapshots: **23 passed**
- `npm run docs:check`: **成功（リンク3918件／台帳16行）**
- ビルド: 禁止事項に従い未実行

## 文書差分

追記した文は以下です。

- `COALESCE`: 「引数がすべて数値なら結果も数値として並べ替え・比較される」
- `ISNULL`: 「引数がすべて数値なら結果も数値として並べ替え・比較される」
- `NULLIF`: 「引数がすべて数値なら結果も数値として並べ替え・比較される」
- §10:
  「`COALESCE` / `ISNULL` / `NULLIF` / `GREATEST` / `LEAST` は、引数がすべて数値なら結果も数値として並べ替え・比較され、文字列または型不明の引数が混ざる場合は文字列として扱われます。」

## §4 確認結果

1. `ARITH_COL` 以外の実体化漏れ  
   `STRFUNC_COL`、`SCALAR_VALUE_COL`、`CASE_COL` は既存の集計検出・依存実体化経路を維持しています。`src/engine/process.ts:651`、`src/engine/process.ts:661`、`src/engine/process.ts:671`  
   FULL_SCAN判定も4列種すべてを確認し、残る漏れは検出されませんでした。

2. 型推定 helper の適用先  
   同一SELECT ORDER BY、ウィンドウORDER BY、CTE・一時列メタ、HAVING、WHERE、REORDERへ適用済みです。対象範囲で未適用の経路はありません。

3. B184の隠し列  
   helperは「式AST＋任意のfield semantics resolver」を受け取るため再利用できます。ただしB184で新しいhidden-window参照ノードを導入する場合、そのノードの結果意味型をhelperへ追加する必要があります。B184自体は実装していません。

4. `/flow`・MCP・CLI・プラグインのshape  
   `computeOutputKeys`、結果組立、warnings配列、EXPLAIN行生成は変更していません。新規バッチ経路テストで `columns: ["total"]`、行キー、`warnings: []` を固定し、全体テストではflow・MCP・CLI関連スイートも通過しました。プラグイン生成物はビルド禁止のため更新・実機確認していません。

## Claudeが実機で確認すべき残項目

- SFAパックで `20,700,000 > 9,050,000` のDESC/ASC、RANK、累計
- v3.77.0との `+0`、`*1`、`*100.0/2` のbefore/after比較
- 0件、LEFT JOIN不一致、文字列混在の結果
- MCP・CLI・`/flow`・プラグインで `columns`、行キー、`warnings`、EXPLAIN行が不変であること
- ビルド後のプラグイン同梱エンジンとSFAパックでの動作

## 上限内に終わらなかった項目

実装・自動テスト・文書更新は完了しています。禁止されたgit操作、ビルド、MCP tool call、実機確認は実施していません。


## Claude レビュー（2026-09-16）

- **差分確認**: `src/core/expressionSemantics.ts`（新規 helper・引数がすべて数値なら number）、`process.ts`（`hasAggregateColumns` に `ARITH_COL`、集計実体化の `ARITH_COL` 分岐、ORDER BY alias と射影で実体化値を使用、`NUMERIC_ORDER_FUNCTIONS` を helper へ集約）、`execute.ts`（CTE 列メタ・HAVING・REORDER を helper へ、`collectSelectAggregateSortRefs` に `ARITH_COL`）、`evalWhere.ts`、`selectToKintone.ts`（`ARITH_COL` 内集計を FULL_SCAN）、`groupingValidation.ts`、`cteInlining.ts`。台帳・起票文書・版数は codex は触っていない（台帳の差分は Claude の B181〜B184 起票分）
- **回帰を 1 件発見して修正**: `collectFullScanReasons`（`execute.ts:14636`）を `isAggregateQueryBlock(stmt)` に変えたため、**GROUP BY だけの文の EXPLAIN に「集計関数（COUNT / SUM 等）あり」が新たに付いた**（v3.77.0 の MCP: `reason: GROUP BY あり`／修正前ビルド: `GROUP BY あり, 集計関数（COUNT / SUM 等）あり`）。`isAggregateQueryBlock` は grouping を含むため。`hasAggregateColumns(stmt.columns)`（集計「列」の有無）に差し替え、`b182CoalesceAggregate.test.ts` に EXPLAIN reason の固定テストを 1 本追加（GROUP BY のみ → `GROUP BY あり`、`COALESCE(SUM)+0` → `集計関数あり`）。codex の全テスト通過はこの文言を固定するテストが無かったため。修正後ビルドで再確認済み
- **意図した EXPLAIN の変化**: `SELECT COALESCE(SUM(売上), 0) + 0 FROM APP4149` は v3.77.0 では `mode: SIMPLE`（集計扱いされていなかった＝値が 0 になる原因）、修正後は `mode: FULL_SCAN`・`reason: 集計関数あり`。これは正しさの修正に伴う変化
- **実機（SFA・dev・修正後 dist-cli）**: LEFT JOIN CTE の `COALESCE(SUM(案.売上), 0)` を `ORDER BY … DESC` → サイボウズ商事 20,700,000 → キントーンシステムズ → 倉本（v3.77.0 は篠村 9,050,000 が 1 位）。番外編 2 巡目の Claude の SQL（RANK・累計・区分）→ 順位 1〜8・累積構成比・区分が第 3 回の表と一致。`SUM(売上) / COALESCE(SUM(売上),0)+0 / ISNULL(SUM(売上),0)*1 / COALESCE(SUM(売上),0)*100.0/2` → `81800000 / 81800000 / 81800000 / 4090000000`（v3.77.0 は後 3 つが 0）。`COALESCE(SUM(売上),0) + SUM(売上)` は従来どおり ParseError（算術式のオペランド制約・範囲外）
- **テスト**: `b182CoalesceAggregate.test.ts` 8 本通過（codex 7 + Claude 1）。全体 `npm test` は codex 実行時 6,501 本通過、Claude の修正後の再実行で **300 suites・6,502 本通過（version-sync・docs-check 含む・0 failed）**
- **未実施**: プラグイン（`prod/js/desktop.js`）のビルドと実機、MCP 常駐プロセスの差し替え確認。リリース時に実施
