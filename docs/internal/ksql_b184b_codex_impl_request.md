# B184-B 実装依頼（codex）— ウィンドウ関数の結果を同じ SELECT の式の中で使えるようにする（隠しウィンドウ列）

**`SELECT 会社名, SUM(売上) AS 売上合計, ROUND(SUM(売上) * 100.0 / SUM(SUM(売上)) OVER (), 1) AS 構成比 FROM APP4149 GROUP BY 会社名` や `SELECT 年月, 件数, 件数 - LAG(件数) OVER (ORDER BY 年月) AS 前月差 FROM 埋め済み` のように、ウィンドウ関数を関数の引数・算術・`CASE` の中に書ける形を通す。[起票文書](ksql_b184_window_in_same_select_issue.md) §3-B と [実装案の検討報告 §5「B. 式内window」](ksql_b181_b184_codex_plan_report.md) の設計（公開 `columns` とは別の内部 `hiddenWindows`）で実装する。B184-A（集計と同じ SELECT のウィンドウ）は実装・コミット済み（`32bcebc`）。**

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（作業ブランチ `b184/dev`・B184-A コミット済みの HEAD）
上限: 1 PR・3 時間。超えそうなら途中で止めて「どこまで実装したか・どのテストが未着手か」を報告する。

## 0. 禁止事項（従来どおり）

git 操作（コミットは Claude）・version・CHANGELOG・README・release/・台帳（`docs/ksql_issue_tracker.md`）・起票文書の変更・ビルド（`prod/js/desktop.js` に触れない）・kSQL MCP の tool call・MEMORY.md 禁止。
エラー本文・警告文を新たに発明しない。**既存の 3 段の書き方（CTE / 一時テーブル）と、トップレベルのウィンドウ列（B184-A 含む）の結果・警告・EXPLAIN の行を変えない。** 公開型（`SelectResult`・`columns`・行キー・`warnings`・`SelectStatement.columns` の列 index 契約）を変えない。**隠し列は `columns`・行キー・`DISTINCT` の比較・CSV export・column meta（Dashboard）・`/flow` の結果に一切出ない。** B182 の `src/core/expressionSemantics.ts` の規則を変えない（隠し列の意味型はこの helper で決める）。

## 1. 決まっていること（レビュー対象外）

### 1.1 現状（B184-A 後）

- パーサは式内ウィンドウを 3 か所で拒否する: 関数で包む（`src/parser/parser.ts:1675-1680`・`hasNestedAggregateWindowInSelectColumn`）、算術に混ぜる（`1951-1953`・VALUE 窓、`2014-2019`・AGGREGATE 窓）。文言は `WINDOW_RESULT_IN_EXPRESSION_MESSAGE`（`342-347`・B129）
- `SelectColumn` はウィンドウをトップレベルの `WindowColumn`（`src/types/ast.ts:348-381`・RANKING / AGGREGATE / VALUE）としてしか表現できず、式 AST（`ArithNode` / `StringFuncArg` / `ScalarValueExpr` / `CaseResult`）にウィンドウ node は無い
- `applyWindow`（`src/engine/process.ts:1377` 付近）は SELECT 列中の `WINDOW_COL` を列挙し、値は列 index に紐づく `materializedSelectValues.byColumn` に保存。`project`（`1725-`）は全 `WINDOW_COL` を公開列に出し、`computeOutputKeys`（`1885-`）が列名を決める。`applyDistinct`（`1077-`）は SELECT 列で比較
- 取得フィールド収集（`src/converter/selectToKintone.ts:793`・`873`）・完全入力判定（`src/core/dmlGuard.ts:190-192`）・EXPLAIN / 意味型（`src/execute.ts:3422-3431`・`3655-3664`・`3768-3822`・`3897`・`4632`・`5059`・`5982`・`6117`・`8440`・`8505`）はトップレベル `WINDOW_COL` 前提
- B184-A で、ウィンドウの引数・PARTITION BY・ORDER BY は「グループキー・集計別名・集計式・`GROUPING()`」へ解決され、集計式は `materializeAggregateDependencies` で非表示に実体化される（`process.ts:516`・`619`・`744`）

### 1.2 直し方（隠しウィンドウ列）

- **AST**: `SelectStatement` に内部配列 `hiddenWindows: WindowColumn[]`（公開 `columns` とは別）を追加する。パーサは式内ウィンドウ（関数の引数・算術・`CASE` の条件と結果・`||`）を検出したら拒否せず、一意な内部 ID（例 `__ksql_window_0`。結果列名に出ない・決定的な順序）で `hiddenWindows` に切り出し、式側はその ID を参照する `FIELD` / `FIELD_REF`（既存の node 種別を使い、新しい式 node は足さない。必要なら `hiddenWindowRef?: true` のような任意マーカーだけ）に置き換える。同一のウィンドウ式（構文的に同じ）は 1 つに畳む
- **エンジン**: `applyWindow` は公開 `WINDOW_COL` と `hiddenWindows` の両方を評価し、隠し列の値は `byLookupKey`（内部 ID）にだけ載せる（`byColumn` には載せない）。`project` の式評価はその lookup から読む。`project` / `computeOutputKeys` / column meta / CSV / `DISTINCT` の比較には隠し列を渡さない
- 隠しウィンドウの引数・PARTITION BY・ORDER BY の参照規則は B184-A と同じ（集計と同じ SELECT なら グループキー・集計別名・集計式・`GROUPING()`。集計の無い SELECT ならフィールド・別名）。B184-A の `materializeAggregateDependencies` 接続を隠しウィンドウにも適用する
- **意味型**: 隠し列の結果型（`SUM(...) OVER ()` は number、`LAG(件数)` は引数の型、`RANK()` は number）を B182 の `expressionSemantics` helper へ渡し、それを包む式（`ROUND(… / …)`・`件数 - LAG(…)`・`COALESCE(LAG(...), 0)`・`CASE`）の型推定・`ORDER BY` の並び・比較が数値になるようにする
- **取得フィールド・完全入力・EXPLAIN**: 隠しウィンドウも公開ウィンドウと同じに扱う（`completeInputReasons()` に `WINDOW_ORDER` / `AGGREGATE_WINDOW`、取得列は引数の物理フィールド）。EXPLAIN は既存の `complete input reason` への併記で可視化し、新しい行は足さない（案があれば報告に書く）
- **拒否のまま**: `WHERE` / `HAVING` / `JOIN ON` / `GROUP BY` / 文レベル `ORDER BY` の式内ウィンドウは従来どおり B129 の文言で拒否。ウィンドウの中にウィンドウ（`SUM(RANK() OVER ()) OVER ()`）も拒否（既存文言を流用）
- `WINDOW_RESULT_IN_EXPRESSION_MESSAGE` は残す（上の拒否で使う）。SELECT 列内では出なくなる

### 1.3 変えないこと

- 既存の 3 段（CTE / 一時テーブル）の結果・警告・EXPLAIN。トップレベル `WINDOW_COL`（B184-A 含む）の挙動
- 既存テストで書き換えが要るのは、式内ウィンドウの**拒否**を固定していたもの（`src/parser/__tests__/window.test.ts` の B129 診断テスト `115-143` 付近・nested VALUE window 拒否 `183-188` 付近、ほか grep `WINDOW_RESULT_IN_EXPRESSION_MESSAGE` で見つかるもの）だけの想定。**書き換える場合は「SELECT 列内は受理・WHERE / HAVING は拒否のまま」に分けて残す**。ほかに変えざるを得ない既存テストがあれば「意味が変わるか」を報告に書き、意味が変わるなら止めて報告する

## 2. テスト（受入・境界値は桁を変えて両方向）

新規 `src/engine/__tests__/b184bWindowInExpression.test.ts`（パーサ側は `window.test.ts` に追加）に少なくとも次を入れる:

- **第 3 回の 1 段版 = 3 段版**: `SELECT 会社名, SUM(売上) AS 売上合計, RANK() OVER (ORDER BY SUM(売上) DESC) AS 順位, ROUND(SUM(売上) * 100.0 / SUM(SUM(売上)) OVER (), 1) AS 構成比, ROUND(SUM(SUM(売上)) OVER (ORDER BY SUM(売上) DESC, 会社名 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) * 100.0 / SUM(SUM(売上)) OVER (), 1) AS 累積構成比, CASE WHEN … <= 80 THEN 'A' WHEN … <= 95 THEN 'B' ELSE 'C' END AS 区分 FROM APP100 GROUP BY 会社名 ORDER BY 売上合計 DESC, 会社名` が、既存の 3 段 CTE 版（`base` → `ranked` → 区分）と**同じ行・同じ値・同じ列順・同じ `columns`・同じ `warnings`**。値は `9 / 10`・`99 / 100`・`9,050,000 / 20,700,000` の組で両方向、同額 2 社（`RANK` 同順位・累計のタイブレーク）を含む
- **第 2 回の `件数 - LAG(件数) OVER (ORDER BY 年月)`** 1 段版が、`LAG` を列に出す 2 段版と同じ行（先頭行の `LAG` は `''` → 算術で 0 扱い、`CASE WHEN LAG(...) = '' THEN ''` の形も）
- 式の位置の網羅: 関数の引数（`ROUND` / `COALESCE` / 文字列関数）・算術の左右・`CASE` の条件と結果・`||`。同じウィンドウ式が 2 か所（畳んで 1 回評価）。隠しウィンドウが 2 つ以上
- 集計の無い SELECT での式内ウィンドウ（`SELECT 会社名, 売上 - LAG(売上) OVER (ORDER BY $id) AS 差 FROM APP100`）
- 隠し列が `columns`・行キー・`DISTINCT` の比較（`SELECT DISTINCT 区分 … ` で隠し列が同じ区分の行を分けない）・CSV serializer（B179 の `serializeSelectResultAsCsv`）・column meta（`getSelectColumnMeta`）に現れない
- `completeInputReasons()` に `WINDOW_ORDER` / `AGGREGATE_WINDOW`。取得列（mock の `getRecords` の `fields`）が 3 段版の集計段と同じ
- 意味型: `ROUND(SUM(x) OVER () / …)` の列で `ORDER BY` が数値順（B182 の境界値）、`COALESCE(LAG(x) OVER (…), 0)` が number
- `WHERE` / `HAVING` / `JOIN ON` / 文レベル `ORDER BY` / ウィンドウの中のウィンドウは B129 の文言で拒否（文言不変）
- 既存の 3 段版・トップレベル窓の回帰（既存 29 ファイルのウィンドウテストが通る）
- 文書の助言をそのまま実行するテスト 1 本（§3 で §10.1・R15・R16 に載せる 1 段版）
- `npm test` 全体が通ること（結果を報告に貼る）

## 3. 文書（この PR に含める）

- `docs/ksql_language_reference.md` §10.1 の「ウィンドウの結果を同じ SELECT の式の中で使う形は未対応（段を分ける）」（B184-A で書いた文）を「v3.81.0 から、ウィンドウ関数を関数の引数・算術・`CASE` の中に書ける。`WHERE` / `HAVING` では使えない」に改め、1 段版の例を載せる。3 段は「段ごとに確かめたいときの書き方」として残す
- `docs/ksql_batch_recipes.md` R15（構成比・累積構成比・ABC）・R16（前月比）: B184-A で「比率計算だけ次の段」と書いた部分を 1 段版に改め、3 段版も残す
- 文書の SQL 例は §2 のテストで通したものだけ
- `npm run docs:check` が通ること

## 4. 確認してほしいこと（報告に書く）

1. `hiddenWindows` を持たない経路（`/flow` の `executeStatement`・engine-library・プラグインの EXPLAIN・`buildBatchExplainPlans`・CTE の実体化・サブクエリ・UNION 枝）が、パーサの出力（`hiddenWindows` 付き AST）をそのまま通すか。通さない経路があれば行番号
2. 隠し列が漏れ得る出口の一覧（`project` / `computeOutputKeys` / column meta / CSV / DISTINCT / `SelectResult.columns` / `/flow` の結果型 / Dashboard）と、それぞれで漏れないことの根拠（テスト名）
3. 隠しウィンドウの意味型を B182 の helper へどう渡したか（行番号）と、型が決まらない形（あれば）
4. 式の中の同じウィンドウ式を畳む規則（構文的同一の判定）と、畳まなかった場合の影響
5. プラグイン（EXPLAIN エンジン同梱）・MCP・CLI・`/flow` で同じ結果になることの根拠

## 5. 報告

最終メッセージ＝実装報告のみ。構成: 変更ファイル一覧／修正箇所 ↔ 根拠行の対応表／追加・変更したテストの一覧と `npm test` の結果（通過数・失敗数をそのまま）／文書の差分（追記・改めた文を全文）／§4 の 5 項目／Claude が実機（SFA パック・第 3 回の 1 段版・第 2 回の LAG・MCP v3.80.0 との比較）で確かめるべき残項目／上限内に終わらなかった項目（あれば）。
