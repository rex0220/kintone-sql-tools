# B182 実装依頼（codex）

**`COALESCE` / `ISNULL` / `NULLIF` で包んだ集計値が静かに間違う 2 件（算術で 0 になる・並び順が文字列になる）を直す。[起票文書](ksql_b182_coalesce_aggregate_silent_wrong_issue.md) と [実装案の検討報告 §3](ksql_b181_b184_codex_plan_report.md) の第一案で実装する。**

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（作業ブランチ `b182/dev`・v3.77.0 相当）
上限: 1 PR・2 時間。超えそうなら途中で止めて「どこまで実装したか・どのテストが未着手か」を報告する。

## 0. 禁止事項（従来どおり）

git 操作（コミットは Claude）・version・CHANGELOG・README・release/・台帳（`docs/ksql_issue_tracker.md`）・起票文書の変更・ビルド（`prod/js/desktop.js` に触れない）・kSQL MCP の tool call・MEMORY.md 禁止。
エラー本文・警告文を新たに発明しない。**公開契約（結果の `columns`・行キー・`warnings` の形・EXPLAIN の行）を変えない。** B181・B184 の範囲（別名の参照解決・ウィンドウの脱糖）には手を出さない。

## 1. 決まっていること（レビュー対象外）

### 1.1 算術で 0 になる（値が壊れる・優先）

- 直接原因: 関数から始まる算術が `ARITH_COL` に分類され（`src/parser/parser.ts:1742-1747`）、`hasAggregateColumns()`（`src/engine/process.ts:431-439`）が `ARITH_COL` 内の集計を見ず、集計実体化（`process.ts:617-678`）に `ARITH_COL` 分岐が無い。射影時に通常算術として再評価され（`process.ts:1589-1590`）、関数引数の集計値が未実体化の空文字になる（`src/engine/evalFunc.ts:721-735`）
- 直し方: `ARITH_COL` 内も `collectAggregateRefs()` で走査し、集計を含む列は `hasAggregateColumns()` の対象にする。集計後に式内の `AGG_REF` / `AGG_ARITH` を確定値へ置換してから `evalArithExpr` する。既存の `materializeAggregateDependencies()` と `resolveAggInScalarValue()` を一般化して再利用する（パーサで `SCALAR_VALUE_COL` へ分類し直す代替案は採らない＝AST snapshot・converter への影響が大きい）
- GROUP BY あり・なし（単一グループ）、0 行、LEFT JOIN の不一致側、HAVING でこの列の別名を参照する形、DISTINCT、CTE / 一時テーブル経由、`/flow`（`executeStatement`）のすべてで同じ値になること

### 1.2 並び順が文字列になる（型推定）

- 直接原因: `deriveOutputOrderSemantics`（`process.ts:2205-2234`）が `STRFUNC_COL` を `NUMERIC_ORDER_FUNCTIONS` に無い関数なら string にする。CTE 列メタ（`src/execute.ts:5550-5565`・`5790-5799`）、HAVING 比較（`execute.ts:3768-3771`）、WHERE / HAVING の関数比較（`src/engine/evalWhere.ts:185-203`）も同じ規則
- 直し方: `COALESCE` / `ISNULL` / `NULLIF` / `GREATEST` / `LEAST` の結果意味型を「**全引数が数値意味型（NUMBER・数値形式 CALC・数値集計・数値リテラル・算術式・`CAST(… AS NUMBER)`）なら number、文字列または型不明が 1 つでも混ざれば従来どおり string**」とする。判定は 1 つの共通 helper（新規 `src/core/expressionSemantics.ts` を候補）に置き、`process.ts` / `execute.ts` / `evalWhere.ts` に散っている数値関数集合の重複を 1 か所へ寄せる。`CAST(… AS NUMBER)` と既知数値関数も同じ helper を通す
- 効く場所: 同一 SELECT の `ORDER BY`、ウィンドウの `ORDER BY`（`RANK` / 累計）、CTE・一時テーブルの列メタ、HAVING・WHERE の比較
- `COALESCE(メモ, '－')` のような文字列用途、`COALESCE(SUM(x), 'none')` のような混在は string のまま（挙動不変）

### 1.3 変えないこと

- 結果列名・行キー・`warnings` の形・EXPLAIN の行（型を EXPLAIN に新表示しない。表示するとプラグイン同梱エンジンの snapshot に波及する）
- 既存テストで意図的に変えるものは無い想定。b119〜b122 のテスト（`src/engine/__tests__/b119AggregateStringFuncArg.test.ts`・`b120AggregateCase.test.ts`・`b121HavingNumericComparison.test.ts`・`b122HavingAggregateExpression.test.ts`・`src/parser/__tests__/b120AggregateCase.test.ts`）は回帰対象としてそのまま通す。もし変えざるを得ない既存テストがあれば「意味が変わるか」を報告に書き、意味が変わるなら止めて報告する

## 2. テスト（受入・境界値は桁を変えて両方向。等値比較だけの受入は不可）

新規テストファイル（`src/engine/__tests__/b182CoalesceAggregate.test.ts` を候補）に少なくとも次を入れる:

- 値: `COALESCE(SUM(x), 0) + 0`・`COALESCE(SUM(x), 0) * 1`・`ISNULL(SUM(x), 0) * 1`・`COALESCE(SUM(x), 0) * 100.0 / 2`・`NULLIF(SUM(x), 0) + 0` が `SUM(x)` を使った同じ式と同じ値になる。GROUP BY あり／なし、0 行、LEFT JOIN 不一致側、HAVING で別名参照、DISTINCT、CTE 経由。値は `9 / 10`、`99 / 100`、`9050000 / 20700000` のように桁が変わる組を使う
- 並び: CTE に `COALESCE(SUM(x), 0) AS 合計` を作り、`ORDER BY 合計 DESC` / `ASC`、`RANK() OVER (ORDER BY 合計 DESC)`、`SUM(合計) OVER (ORDER BY 合計 DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)` が数値順になる。`9,050,000` と `20,700,000` のように文字列順と数値順で逆転する値で両方向
- 型の境界: `COALESCE(SUM(x), 'none')`・`COALESCE(メモ, '－')`・`GREATEST(SUM(x), 'a')` は string のまま（既存挙動の固定）。`NULLIF` / `GREATEST` / `LEAST` の全数値引数は number
- 文書の助言をそのまま実行するテストを 1 本: 推奨 3 形（`CASE WHEN SUM(x) = '' THEN 0 ELSE SUM(x) END`・`SUM(COALESCE(x, 0))`・`CAST(COALESCE(SUM(x), 0) AS NUMBER)`）と修正後の `COALESCE(SUM(x), 0)` が同じデータで同じ順序・同じ値になる
- `npm test` 全体が通ること（workspace-write なので jest を実行してよい。実行結果を報告に貼る）

## 3. 文書（この PR に含める）

- `docs/ksql_language_reference.md` §5 の `COALESCE` / `ISNULL` / `NULLIF` 行に「引数がすべて数値なら結果も数値として並べ替え・比較される」を追記。§10「型を確定できない式・一時列も既定は文字列」の直後に、同じ内容を 1 文で
- `docs/ksql_batch_recipes.md` R17（0 埋め）の `CASE` を使う理由の記述があれば、修正後の挙動に合わせて「`COALESCE` でも数値順になる（v3.7x〜）」と整合させる（無ければ何もしない）
- 文書の SQL 例は §2 のテストで実際に通したものだけを使う（発明しない）
- `npm run docs:check` が通ること

## 4. 確認してほしいこと（報告に書く）

1. `ARITH_COL` 以外に「関数で包んだ集計」が集計実体化から漏れる列種別が残っていないか（`CASE_COL` / `STRFUNC_COL` / `SCALAR_VALUE_COL` の各経路を確認し、漏れがあれば直すか、範囲外なら行番号つきで指摘）
2. 型推定 helper を通す場所の一覧（同一 SELECT の ORDER BY・ウィンドウ ORDER BY・CTE 列メタ・HAVING・WHERE）と、通していない場所（あれば理由）
3. B184 の隠し列が同じ helper を使えるか（インターフェースの観点だけ。実装しない）
4. `/flow`・MCP・CLI・プラグインで結果の形が変わらないことの根拠（該当テストか、変更していない出力経路）

## 5. 報告

最終メッセージ＝実装報告のみ。構成: 変更ファイル一覧／1.1・1.2 それぞれの修正箇所 ↔ 根拠行の対応表／追加・変更したテストの一覧と `npm test` の結果（通過数・失敗数をそのまま）／文書の差分（追記した文を全文）／§4 の 4 項目／Claude が実機（SFA パック・MCP v3.77.0 との比較）で確かめるべき残項目／上限内に終わらなかった項目（あれば）。
