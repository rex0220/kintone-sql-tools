# B65 Phase1 実装計画 — 小計・総計（`ROLLUP` / `GROUPING SETS` / `GROUPING()`）

- ステータス: 📋 実装計画（R2 準拠・要 Claude レビュー）
- 正仕様: [B65 Phase1 仕様 R2](ksql_b65_rollup_grouping_sets_spec.md)
- 背景評価: [B65 評価](ksql_b65_rollup_grouping_sets_evaluation.md)
- 関連: [B64 条件付き集計](ksql_b64_aggregate_case_expression_spec.md)／[B56 統計集約](ksql_b56_statistical_aggregates_spec.md)／[B59 ORDER BY alias](ksql_b59_orderby_alias_fix_spec.md)／[B30 ORDER BY 完全性](ksql_order_by_truncate_completeness_issue.md)／[言語リファレンス](../ksql_language_reference.md)／[課題台帳](../ksql_issue_tracker.md)
- 実装分担: codex はファイル編集・自動検証まで。git 操作、レビュー、commit、PR、tag、Release、npm publish は Claude／ユーザー側。

## 1. 結論と実装方針

Phase1 は R2 の field-only `GROUPING SETS`、単一／複数列 `ROLLUP`、SELECT／SELECT CASE 条件／direct `ORDER BY` の `GROUPING(field)` を実装する。最優先の受入条件は、R2 §1 の看板 SQL が回避構文なしで動き、subtotal／total 行へ入力先頭行の値を漏らさず、`ORDER BY GROUPING(会社名), 売上合計 DESC` が number semantics のローカルソートとして完結することである。

実装順は correctness と fail-closed を先に固定する。Step 1 で構文を受理しても、未実装経路へ流さず planning validator で閉じる。Step 2 で最重要の空文字上書き、set 独立性、sidecar を固め、Step 3 で `GROUPING()` の構文・値・型メタ・planner の4層を開通する。Step 4 で完全入力、guard、EXPLAIN、全 consumer を閉じ、Step 5 で B64/B56/HAVING、実行面、benchmark を統合する。Step 6 は文書・版数・配布物だけを扱う。

各 Step は Claude が差分をレビューして独立 commit／必要なら PR にできる単位とする。各 Step 末の共通 gate は次で固定する。

1. `npm test` が全 green。`package.json:21-24` の二段 test runner を使うため、Jest 引数を追加しない。
2. `npm run build` が成功し、plugin／CLI／MCP／MCPB の全 build を通す（`package.json:25-29`）。
3. `src/parser/__tests__/__snapshots__/parser_compat.test.ts.snap` を含む既存 snapshot は無変更。新しい B65 snapshot は専用 test／専用 snapshot へ追加する。
4. 通常 `GROUP BY` の AST、結果、FULL_SCAN 理由、required fields、EXPLAIN が不変。
5. Claude がレビューしてから commit する。codex は `git add`、`git commit`、branch、tag、push、PR 操作を行わない。

後方互換の絶対条件は次の2点である。

- `SelectStatement.groupBy: GroupByKey[]` を維持し、通常 GROUP BY では optional `grouping` property 自体を出さない。現行 AST は `src/types/ast.ts:205-218`、parser は `src/parser/parser.ts:1034-1070` で構築されるため、通常文の JSON／snapshot を byte-equivalent に保つ。
- `ROLLUP`、`GROUPING`、`SETS`、`CUBE` は hard keyword にしない。現行 `isSoftKeyword()` の前例（`src/parser/parser.ts:1874-1889`）と同様に文脈でだけ認識し、既存 field／alias 名を壊さない。

## 2. 現行コードで確認した実装境界

### 2.1 AST、parser、engine

- 現行 `SelectStatement.groupBy` は平坦な `GroupByKey[]` で、set 境界や空 set を表現できない（`src/types/ast.ts:205-218,596-614`）。
- `parseSelect()` は `GROUP BY` 後に `parseGroupByKeys()` を呼び、`parseGroupByKey()` は通常 GROUP BY の関数／算術／field を読む（`src/parser/parser.ts:1034-1070,2457-2492`）。B65 の括弧とカンマは専用 parser で分離する。
- `applyGroupBy()` は単一 `Map<string, ProcessRow[]>` を作り、`{...groupRows[0]}` から出力を作る（`src/engine/process.ts:240-305`）。このコピー後に除外 item を空文字へ上書きしないと subtotal／total へ実値が残る。
- 現行 bucket key は `join("\x00")`（同 `:246-253`）。B65 の新経路では値中 NUL と衝突しない tuple serializer または nested Map を使う。
- `runFullScan()` は filter → group → HAVING → window → DISTINCT → ORDER BY → LIMIT/OFFSET → project（同 `:1347-1390`）。複数 set は group 段で縦結合し、後段の順序は変えない。

### 2.2 `GROUPING()` と ORDER BY

- CASE 条件は `parseFieldValue()`、direct ORDER BY は `parseOrderByKey()` を通る（`src/parser/parser.ts:2256-2310,2494-2535`）。一般 `ScalarValueExpr` へ広げず、R2 固定の dedicated node だけを足す。
- `buildOrderByAliasEvaluator()` は project 前の row から alias／集計合成名を評価する（`src/engine/process.ts:723-780`）。`GROUPING_COL AS g ORDER BY g` はここへ sidecar resolver を渡す。
- `buildOrderSemanticsForSelect()` は alias／field の意味論を作る（`src/execute.ts:4228-4325`）。direct `GROUPING_KEY` と alias `GROUPING_COL` の双方へ number semantics が必要である。
- canonical planner は未解決 field key を fail-closed にするため、dedicated `GROUPING_KEY` を local-only key として明示処理しない限り `ORDER_KEY_UNRESOLVED` になる（`src/core/optimization/canonicalOrderPlanner.ts:46-96`）。

### 2.3 complete-input bypass と採用判断

`executeSelect()` は `completeInputReasons()` を計算し、必要なら `onLimitReached: "truncate"` を `"error"` へ差し替え、`FetchAllLimitError` を reason 付きへ変換する（`src/execute.ts:2296-2342`）。一方、materialized CTE/temp が FROM/JOIN にある場合は `executeQueryWithCte()` から `executeFullScanWithCte()` へ直接入り（同 `:3582-3601`）、物理 APP fetch へ `options.onLimitReached` をそのまま渡す（同 `:3702-3754`）。

この差は `execute.ts` 内の policy 計算と error formatting の共通化で閉じられ、engine や public option の変更を必要としないため、Phase1 は **共通 complete-input helper を採用する**。B65 と CTE/temp の併用全体は拒否しない。helper は概念上次の責務だけを持つ。

- order plan によるトップレベル ORDER reason 除外を反映して `CompleteInputReason` 集合を作る。
- effective `ExecuteOptions` と `truncateWasDisabled` を返す。
- `FetchAllLimitError` を reason 別 subject 付きで再構築する。
- `executeSelect()` と `executeFullScanWithCte()` の fetch 前で同じ policy を適用する。

これにより R2 B65-F06／E44 を受理側で満たす。helper 抽出が想定外に order-plan／CTE lifecycle の大改造へ波及した場合は、その Step を開通せず Claude へ再裁定を求めるが、本計画の採用案は helper 共通化で確定する。

### 2.4 `groupBy` consumer allowlist

現行 production の直接参照は `rg -n "\.groupBy\b" src --glob "*.ts"` で少なくとも次にある。

| consumer | 現行位置 | B65 方針 |
|---|---|---|
| IMPORT projection 制約 | `src/parser/parser.ts:683` | `hasGroupingClause()` で B65 も拒否 |
| scalar-subquery 2行 probe | `src/execute.ts:2010-2015` | B65 は probe 不可 |
| no-FROM | `src/execute.ts:2419-2422` | B65 を planning error |
| CTE inline | `src/core/cteInlining.ts:5-19` | B65 final query を inline 不可 |
| FULL_SCAN reason | `src/execute.ts:8717-8738` | source を `ROLLUP`／`GROUPING_SETS` と表示 |
| mode 判定 | `src/converter/selectToKintone.ts:69-84` | normalized type が B65 なら FULL_SCAN |
| required fields | 同 `:688-695` | `allItems` を重複なしで table 別収集 |
| engine | `src/engine/process.ts:1352-1356` | normalized spec を複数 set engine へ渡す |
| window／IMPORT parser guard | `src/parser/parser.ts:676-685,1081-1085` | B65 を明示認識 |
| EXPLAIN metadata／reason | `src/core/explainMetadata.ts`、`src/execute.ts:8556-8630` | canonical field 解決、静的 guard 表示 |
| AST 手組み／再構築 | `src/execute.ts:5782-5787`、`src/core/cteInlining.ts:35-48` | optional property の不在を維持。B65 clone は保持 |

parser の AST 構築境界、通常 GROUP BY 専用 unit test の `applyGroupBy(rows, stmt.groupBy, ...)`、`normalizeGroupingSpec()` 本体以外の production 直接参照は原則禁止する。Step 4 で allowlist test と `rg` 証跡を固定する。

## 3. オーナー確定4判断の実装契約

### 3.1 guard 値

展開後 set 64、canonical item 16、生成行 50,000 は candidate のまま実装を開始する。定数は3個を分離し、planning／runtime／EXPLAIN が同じ export を参照する。Step 5 の Node、Firefox plugin、Chrome plugin benchmark で R2 §12.1 の全測定を行い、effective 値を確定する。benchmark 前に candidate を正式な公開上限として文書化・release しない。

### 3.2 B65 + SELECT DISTINCT

Phase1 は B65 文の `SELECT DISTINCT` を fetch 前の planning error で一律拒否する。`applyDistinct()`／`buildDistinctKeyBuilder()`（`src/engine/process.ts:533-600`）の full select-list evaluator 化は行わない。集計引数の `COUNT(DISTINCT x)` 等は別機能であり、set／bucket ごとに従来どおり受理する。R2 B65-A06 と E34 の「完全対応時は受理」は Phase2 へ送り、Phase1 test は明示拒否へ読み替える。

### 3.3 aggregate alias 衝突

拒否範囲は narrow に固定する。B65 の group stage で集計／射影前 materialize される次の列に **明示 alias があり**、その alias が resolved grouping item の `directKey` または一意な `unqualifiedBridgeKey` と一致する場合だけ planning error とする。

- `AGGREGATE`
- `ARITH_AGG_COL`
- 集計を含む `STRFUNC_COL`
- 集計を含む `SCALAR_VALUE_COL`

alias のない合成名一般、project 段で初めて評価する `FIELD`／`CASE_COL`／非集計式の alias はこの narrow 拒否の対象外とする。したがって看板の `CASE WHEN GROUPING(会社名)=1 ... END AS 会社名` は必ず受理する。`SUM(売上) AS 会社名` は grouping output key と衝突するため fetch 前に拒否する。silent overwrite は許さない。

### 3.4 CTE/temp complete-input

§2.3 の共通 helper を採用する。B65 body を CTE/temp に materialize する形、UNION branch／subquery 内の B65、materialized CTE/temp と物理 APP を JOIN して物理 APP field だけを grouping item にする形を受理する。materialized CTE/temp 列自体を grouping item／`GROUPING()` 引数にする形は field-only source 契約により拒否する。

## 4. Step 1 — AST・parser・soft keyword・planning 拒否

### 4.1 目的

通常 GROUP BY の AST を変えずに B65 構文を表現し、未開通 engine へ流れる前に全 Phase1 制約を fail-closed に固定する。高リスクの「構文だけ通って誤結果」を避けるため、この Step の公開実行は validator gate の後ろに置く。

### 4.2 変更ファイル・関数・型

- `src/types/ast.ts`
  - `SelectStatement` に B65 文だけが持つ `grouping?: GroupingSpec`。
  - `GroupingSpec`、`GroupingSet`、`GroupingFieldItem`、`NormalizedGroupingSpec`、`GroupingRef`。
  - `SelectColumn` に `GROUPING_COL`、`FieldValue` に `GROUPING_FIELD`、`OrderByKey` に `GROUPING_KEY`。
- 新規 `src/core/grouping.ts`
  - `normalizeGroupingSpec(stmt)`、`hasGroupingClause(stmt)`。
  - `NONE | PLAIN | GROUPING_SETS` の discriminated union。
  - ROLLUP prefix 展開、明示順／重複 set 保持、`allItems` 初出順集合。
- `src/parser/parser.ts`
  - `parseGroupByKeys()`／`parseGroupByKey()` の通常経路を保持し、`GROUP BY` 直後だけ `parseGroupingSetsClause()`／`parseRollupClause()` へ分岐。
  - 空 set `()`、複数 item、single-item 省略形、重複 set、`GROUPING SETS (())` を構造保持。
  - `parseSelectColumn()`、`parseFieldValue()`、`parseOrderByKey()` の許可位置だけで `GROUPING(` を認識。
  - `isSoftKeyword()` を使い、lexer keyword table は変更しない。
- 新規 `src/core/groupingValidation.ts` と `src/execute.ts` の planning 接続
  - APP metadata と table alias を使い、`canonicalId = source identity + field code`、`directKey`、合法な `unqualifiedBridgeKey` を解決。
  - R2 §6 の field-only、実在、一意性、arg-in-allItems、非 grouped dependency、wildcard、context、KORDER、window を検証。
  - `CUBE`、式 item、`GROUPING_ID`、nested element、通常 item との混在、`GROUP BY DISTINCT`、HAVING／WHERE／JOIN ON／window／DML 内 `GROUPING()` を専用 error で拒否。
  - B65 + `SELECT DISTINCT` を一律拒否。
  - §3.3 の narrow alias collision を拒否し、`CASE_COL AS grouping-key` は除外する。
  - set/item guard の planning hook と reason 型を用意する。candidate 定数の配線と境界 test は Step 4 で開通する。

通常 `GROUP BY ROLLUP` は、`ROLLUP` の直後が `(` でない限り field 名として従来経路へ残す。`GROUPING SETS ()` は set list 0 個として拒否し、`GROUPING SETS (())` は空 set 1 個として受理する。対象外の標準構文を別の既存構文へ誤解釈できる場合は、保守的に B65 context error とする。

### 4.3 テスト

- 新規 `src/parser/__tests__/b65GroupingSets.test.ts`
  - B65-P01、P02、P03、P04、P07、P09。
  - B65-E01〜E05、E07〜E19、E24〜E26、E41〜E43。
- `src/parser/__tests__/parser_compat.test.ts`
  - B65-P05、P06。既存 snapshot は更新せず、B65 専用 snapshot を別ファイルへ置く。
- 新規 `src/core/__tests__/b65GroupingValidation.test.ts`
  - B65-E11〜E21、E28〜E32、E34、E36、E41。
  - fetch spy 0 で planning error を確認。
  - `SUM(x) AS a` + `ROLLUP(a)` は拒否、`CASE WHEN GROUPING(a)=1 ... END AS a` は受理する対の test。
- `src/parser/__tests__/import.test.ts`、`src/parser/__tests__/window.test.ts`
  - B65-P08 の IMPORT／window 拒否。

「修正前 fail → 修正後 pass」は、B65-P01/P02/P03 の代表 SQLを先に現行 parser へ与え、現行の ParseError と token 位置を evidence に記録した後、同じ SQL の AST 構造期待へ反転する。恒久拒否形は before/after とも拒否だが、after は B65 専用 reason と fetch 0 を固定する。

### 4.4 完了 gate

共通 gateに加え、通常 GROUP BY の AST snapshot が1 byteも変わらないこと、soft keyword corpus の field／alias 受理、全 planning error の fetch 0、`groupBy` と `grouping` の同時有効 AST が internal validation error になることを確認する。Step 1 終了時は engine 未開通の B65 実行を明示 gate で拒否する。

### 4.5 リスクと緩和

- 最大リスクは dedicated node を一般 scalar union へ漏らして WHERE／DML まで意図せず開くこと。3 wrapper union だけに限定し、exhaustive switch で未接続をコンパイルエラーにする。
- soft keyword の先読み過多で同名 field を壊す可能性がある。`keyword + LPAREN`／`GROUPING SETS + LPAREN` の完全な文脈が揃った場合だけ分岐する。
- parser だけで source identity を決めると JOIN 曖昧性を誤る。parser は構造保持だけ、実在／曖昧性／alias collision は metadata を持つ planning で行う。

想定: **3.0〜4.0 人日**。

## 5. Step 2 — engine 複数 set・空文字上書き・grouping sidecar

### 5.1 目的

B65 の最重要 correctness を先に固定する。各 grouping set を `UNION ALL` 相当に独立評価し、除外 grouped 列の入力値漏れを止め、値とは独立した membership sidecar を後段へ渡す。

### 5.2 変更ファイル・関数・型

- `src/core/grouping.ts`
  - planning 済み `ResolvedGroupingItem`（`canonicalId`、`directKey`、optional `unqualifiedBridgeKey`）と `ResolvedGroupingSpec`。
- `src/engine/process.ts`
  - 通常 `applyGroupBy(rows, GroupByKey[], ...)` は互換 wrapper として維持。
  - B65 用 `applyGroupingSets(rows, resolvedSpec, columns, resolveAggSortKind, limits)` を追加し、`runFullScan()` は normalized type で分岐。
  - set を明示順に逐次処理し、1 set の bucket Map を完了後に解放可能な構造にする。全 set の `Map` を並行保持しない。
  - bucket key は配列の `JSON.stringify` 等の曖昧な文字列連結に依存せず、長さ prefix serializer または nested Map で衝突を防ぐ。
  - `{...groupRows[0]}` の直後、全 `allItems` について current set membership に応じ、`directKey` と一意 bridge を bucket 値または `""` で明示上書きしてから集計 alias を materialize。
  - set／bucket ごとに既存 `evalAggregate()`、`evalAggArithExpr()`、`resolveAggInStringFuncExpr()`、`resolveAggInScalarValue()` を独立呼出し。accumulator／DISTINCT 集合を共有しない。
- 新規 `src/engine/groupingRowMeta.ts`
  - module-private `unique symbol`、`GroupingRowMeta { includedCanonicalIds: ReadonlySet<string> }`。
  - `attachGroupingRowMeta()`、`getGroupingRowMeta()`、clone 時の明示伝播 helper。
  - enumerable string key は作らず、project 後に漏れない。
- `src/engine/process.ts` の pipeline
  - B65 は集計列がなくても grouping clause 自体で group stage を実行。
  - 0件入力では非空 set 0行、空 set 1行。
  - generated-row candidate guard は新 bucket 発見時、HAVING／DISTINCT／LIMIT 前に全 set 合計を加算し、limit+1 で dedicated error。部分結果を返さない。

### 5.3 テスト

- 新規 `src/engine/__tests__/b65GroupingSets.test.ts`
  - B65-C01〜C11。ただし C06 の `SELECT DISTINCT` 部分は「重複 set を保持」までとし、DISTINCT 併用拒否は Step 1 test で固定。
  - B65-E06、E10、E23、E26、E30、E33。
- `src/engine/__tests__/process.test.ts`
  - 通常 `applyGroupBy()` の既存単一-set testを無変更で全 green。

B65-C01 の fail-first fixture は入力先頭行を `{地域:"東", 会社名:"A"}` とし、`ROLLUP(地域,会社名)` の `(地域)` 行に会社名 `"A"`、`()` 行に地域 `"東"`／会社名 `"A"` が現行コピーから残ることを、実装前の失敗差分として記録する。実装後は `(地域)` の会社名と `()` の両列が厳密に `""` で、qualified key と一意 bridge の双方も同じことを確認する。

B65-C04 は値から membership を推測していないことを証明するため、detail の実データ空セルを `("", GROUPING=0)`、値のある入力から作った total を `("", GROUPING=1)` として同時に検証する。B65-C08/C10 は `Object.keys()`／wildcard／project 結果に sidecar が出ず、同名 user field が壊れないことを確認する。

### 5.4 完了 gate

共通 gateに加え、B65-C01 の before fail → after pass 証跡、C01〜C11、生成行 candidate limit+1 の部分結果 0、通常 GROUP BY の engine test無変更を確認する。Step 2 末でも `GROUPING()` の外部構文は Step 3 gate が揃うまで公開しない。

### 5.5 リスクと緩和

- 最大リスクは set 間 state 共有による aggregate／DISTINCT 汚染。最初は逐次 set + 既存 evaluator 再利用に限定し、最適化は Phase1 に入れない。
- symbol property は object spread で列挙可能設定次第では伝播／漏出が不安定になる。非列挙 `defineProperty` と専用 clone helper を使い、暗黙 spread に依存しない。
- qualified／unqualified key の片側だけ上書きすると CASE や SELECT が旧値を読む。resolved item に両 key を保持し、同じ loop で同時上書きする。
- row参照配列のメモリが `input × sets` に増える危険がある。1 set の Map だけを保持することを code review checklist と heap benchmark で検証する。

想定: **3.5〜5.0 人日**。

## 6. Step 3 — `GROUPING()` 横断統合と ORDER BY 4層

### 6.1 目的

同じ sidecar truth source を SELECT projection、CASE 条件、direct ORDER BY、ORDER BY aliasへ接続し、看板クエリを構文・値・型メタ・planner の4層で成立させる。

### 6.2 変更ファイル・関数・型

- `src/engine/groupingRowMeta.ts`
  - planning 解決済み ref を受ける `evalGroupingRef(ref, row): "0" | "1"`。
- `src/engine/process.ts`
  - `project()` の `GROUPING_COL` 評価。
  - `evalWhere()`／`resolveField()` 系へ CASE 条件限定の `GROUPING_FIELD` resolver。
  - `evalOrderKey()` に `GROUPING_KEY`。
  - `buildOrderByAliasEvaluator()` に `GROUPING_COL` alias evaluator。
  - `applyOrderBy()`／`sortDecoratedRows()` へ direct key の number semantics。
- `src/execute.ts`
  - `buildOrderSemanticsForSelect()` で `GROUPING_COL AS alias` を synthetic number meta と推論。
  - `buildOrderByMetaForSelect()` が direct `GROUPING_KEY` に number semantics を供給。
  - alias precedence はB59を維持し、`GROUPING(a) AS a ORDER BY a` は alias、`GROUPING()` arg は source-first。
- `src/core/optimization/canonicalOrderPlanner.ts`
  - `GROUPING_KEY` は REST非同値・local-onlyとして `CANONICAL_LOCAL`。
  - B65 全体をREST ORDER pushdown不可とし、`ORDER_KEY_UNRESOLVED` へ落とさない。
- `src/core/groupingValidation.ts`
  - 複数 `GROUPING(a)`／`GROUPING(b)` を各 canonical ID へ解決。
  - GROUPING alias と source field の解決規則を分離。

### 6.3 テスト

- 新規 `src/engine/__tests__/b65GroupingExpressions.test.ts`
  - B65-C03、C04、C08、C10、E07〜E09、E31、E33。
- `src/engine/__tests__/orderByAlias.test.ts`
  - B65-O01、O02、O03、O06。
- `src/core/optimization/__tests__/canonicalOrderPlanner.test.ts`
  - B65-O04、O05。
- 新規 `src/__tests__/b65GroupingExecute.test.ts`
  - 看板 CASE、direct ORDER、alias ORDER の統合。

B65-O01 の fail-first は同じ SQLを4つの独立 assertion に分ける。

1. parserが `GROUPING_KEY` を保持する。
2. sidecarからdetail `"0"`／total `"1"` を得る。
3. direct keyとGROUPING aliasの比較意味論がともに number。
4. plannerが `CANONICAL_LOCAL` を返し、実行結果でtotalが末尾。

実装前は少なくとも parserまたは `ORDER_KEY_UNRESOLVED` で failすることを記録し、実装後は4 assertionすべてと最終行順がpassして初めてB65-O01完了とする。parser-only／値-onlyのgreenは不可。

### 6.4 完了 gate

共通 gateに加え、R2 §1 の看板 SQLのmock execute、B65-O01〜O05とC04、KORDER fetch 0拒否、通常B59 ORDER BY test無変更を確認する。`CASE ... END AS 会社名` が narrow alias collision validatorを通ることを必須 gateにする。

### 6.5 リスクと緩和

- 最大リスクは4層の一部だけ実装して文字列順／planner拒否／誤値になること。B65-O01を4 assertion + end-to-endの単一受入IDにする。
- CASE条件の一般where evaluatorへresolverを渡すことでWHEREも開く危険がある。AST nodeはparser/plannerでSELECT CASE条件だけに生成し、WHERE/HAVINGは専用context errorを維持する。
- alias `a` とsource `a` の優先順位混同をO06で固定し、arg resolverとORDER alias resolverを別関数にする。

想定: **3.0〜4.5 人日**。

## 7. Step 4 — 完全入力・guard・EXPLAIN・required fields・consumer allowlist

### 7.1 目的

B65を常時FULL_SCAN／完全入力／有界fail-closedにし、optional ASTの読み落としを全production consumerで閉じる。CTE/temp bypassは共通helperで解消する。

### 7.2 変更ファイル・関数・型

- `src/core/dmlGuard.ts`
  - `CompleteInputReason` に `"GROUPING_SETS"`。
  - `selectCompleteInputReasons()` は `normalizeGroupingSpec(stmt).type === "GROUPING_SETS"` のときだけ追加。通常 GROUP BY は理由にしない。
  - UNION、WITH、CREATE TEMP、SELECT column subquery、CASE条件、WHERE/HAVING subqueryの既存再帰を維持。
- `src/execute.ts`
  - §2.3 の `buildCompleteInputPolicy()`／`withCompleteInputPolicy()` 相当の共通helper（最終名は既存命名に合わせる）。
  - `executeSelect()` と `executeFullScanWithCte()` の双方で effective optionsをfetch前に適用。
  - `completeInputErrorPrefix()` をreason別subjectへ一般化。`GROUPING_SETS`単独は「小計・総計」、複数reasonは「クエリの正しい結果」。
  - `collectFullScanReasons()`、`buildSelectPlan()` に grouping source/set/item/row limit、complete reason、local orderを表示。
  - `isConstantFalseWhere()` の早期return前にB65静的情報を出す。実行では空入力として空setを評価する。
- `src/converter/selectToKintone.ts`
  - `resolveSelectMode()` はB65なら常にFULL_SCAN。
  - `collectRequiredFieldsByTable()` は `allItems` を一度収集し、source-first／table別解決。`GROUPING()` argを別取得しない。
  - `GROUPING_COL`／`GROUPING_FIELD`／`GROUPING_KEY` のexhaustive walker。
- `src/core/explainMetadata.ts`
  - grouping item／argのmetadata必要性を認識。
- `src/core/cteInlining.ts`
  - `hasGroupingClause(finalQuery)` ならinline不可。
- `src/parser/parser.ts`、`src/execute.ts`
  - IMPORT、window、scalar probe、no-FROMを`normalizeGroupingSpec()`／`hasGroupingClause()`経由へ。
- `src/core/grouping.ts`
  - candidate定数 `MAX_GROUPING_SETS=64`、`MAX_GROUPING_ITEMS=16`、`MAX_GROUPING_OUTPUT_ROWS=50_000` を独立export。最終値はStep 5で更新。
- 新規 lint型contract test
  - `rg -n "\.groupBy\b" src --glob "*.ts"` のproduction allowlist。parser構築、normalizer、通常GROUP BY専用engine境界以外の追加をfailさせる。

### 7.3 テスト

- 新規 `src/core/__tests__/b65CompleteInput.test.ts`
  - B65-F01、F03、F04、F05、F06。
  - CTE body、temp作成query、UNION branch、scalar/IN/EXISTS、SELECT CASE条件、WHERE/HAVING subquery、DML早期return。
- `src/converter/__tests__/selectToKintone.test.ts`
  - B65-F01、F02。
- `src/__tests__/b65GroupingExecute.test.ts`
  - B65-F03、F05、F06、E35〜E40、E44。
  - `onLimit=truncate` でもphysical APP fetchが`error`を受け、部分小計0。
- `src/__tests__/explain.test.ts`
  - B65-X01。Records API 0、WHERE FALSEでも静的行あり。
- 新規 `src/core/__tests__/b65GroupingGuards.test.ts`
  - B65-G01〜G03のcandidate境界版、E22／E23／E27。
- 新規 `src/core/__tests__/b65GroupByConsumerAllowlist.test.ts`
  - B65-P08。production直接参照allowlistと通常AST object literal互換。

### 7.4 完了 gate

共通 gateに加え、B65-F01〜F06、G01〜G03、X01、`onLimit=truncate`の通常GROUP BY既存挙動不変、CTE/temp併用のphysical fetchがerror policyを受けることを確認する。`rg` allowlistをClaudeレビュー証拠に添付する。

### 7.5 リスクと緩和

- 最大リスクはreason walkerが正しくても実行経路でpolicyを使わないこと。F06はfetch mockの実引数と最終errorの両方を検査する。
- ORDER planがREST top-Nを担う場合のLOCAL_ORDER除外を共通化で壊す可能性がある。helper入力にorder planを明示し、既存B30/KORDER testを回帰gateにする。
- EXPLAINのWHERE FALSE早期returnで静的情報が消える。静的B65 blockを早期return前に構築し、Records API 0とは別assertionにする。
- optional ASTのconsumer漏れは型だけで防げない。normalizer経由化とsource scan allowlistの二重gateにする。

想定: **2.5〜3.5 人日**。

## 8. Step 5 — B64/B56/HAVING統合・回帰・benchmark・実行面

### 8.1 目的

各setで既存集計契約が独立して正しいことを統合し、Node／Firefox／Chrome実測で3 guardのeffective値を決める。candidate値の正式採否はこのStepの別commitとする。

### 8.2 変更ファイル・関数

- `src/engine/process.ts` と既存 aggregate evaluator
  - B64／B56 evaluator自体は原則変更せず、set/bucket単位の呼出し境界だけを検証。
  - GROUPINGを含まないHAVINGは縦結合後に適用。
- 新規 `scripts/b65-grouping-benchmark.mjs`
  - production engineを呼ぶ決定的fixture generator。
  - Nodeでwall time、group stage time、`process.memoryUsage()`のheap差／peak近似、成功／guard errorをJSON出力。
  - 入力値やSQL全文をerrorへ含めない。
- plugin開発版
  - 同じfixture定義／SQL matrixをFirefoxとChromeで実行し、browserのmemory／performance APIで取得可能な値、UI応答時間、timeout、guard時結果非表示を記録。
  - browser間で取得不能なheap指標は「未取得」を明示し、OS/browser task managerまたはDevTools heap snapshotの手順と値をevidenceへ残す。Node値で代替したと主張しない。
- 新規 `docs/internal/evidence/b65_grouping_benchmark.md`
  - 環境、commit、入力幅、set/item/cardinality、aggregate shape、5回測定のmedian／max、peak heap、timeout、採用値と安全余裕。
- `src/core/grouping.ts`
  - benchmark確定後、3 effective定数を別commitで更新。
- `docs/internal/ksql_b65_rollup_grouping_sets_spec.md` と本計画
  - candidate表／§16をeffective値と証拠リンクへ同期する別commit。仕様意味論は変えない。

benchmark matrixはR2 §12.1どおり次を網羅する。

- 入力10,000行、1／8／32／64 sets。
- 1／2／4／8／16 items、低cardinalityと全行unique。
- B64 CASE集計、COUNT DISTINCT、B56統計を個別および代表複合shapeで実行。
- 最大幅の実データ相当row。
- group stage経過時間、peak heap、UI／MCP timeout、guard到達時に結果が一切返らないこと。
- generated rowsはlimit、limit+1、HAVING／LIMITで後から減るshapeを測り、後段減少でguard免除されないこと。

effective値の採否基準は「3 surfaceの最弱環境でも、上限内の代表最大shapeが既存timeout予算内に完了し、limit+1は部分結果なしでfail-closed、heapに再実行可能な安全余裕があること」とする。数値の安全余裕率は測定結果とともにClaudeがレビューする。証拠なしに64／16／50,000を据え置かない。

### 8.3 テストとsmoke

- `src/engine/__tests__/b64AggregateScalarArg.test.ts`／`statisticalAggregates.test.ts`を回帰実行。
- 新規 `src/engine/__tests__/b65AggregateInteraction.test.ts`
  - B65-A01〜A05。
  - A02でCOUNT DISTINCTとB56数値DISTINCTのstate非共有。
  - A03でB56非数値fail-closedと`GROUPING_SETS, STATISTICAL_AGGREGATE`併記。
  - A04でHAVINGが縦結合後に作用、A05でHAVING GROUPING拒否。
  - B65-A06はPhase2送り、A07はStep 1の`GROUP BY DISTINCT`拒否として維持。
- `src/mcp/__tests__/tools.test.ts` または新規 `src/mcp/__tests__/b65GroupingSets.test.ts`
  - B65-M01〜M04のcore routing／onLimit契約。
- `scripts/mcp-smoke.mjs`
  - build済みMCPの看板validate／query代表形。実kintone接続を要する値確認は専用evidenceへ分離。
- 新規 `docs/internal/evidence/b65_mcp_plugin_smoke.md`
  - MCP看板、2列ROLLUP、明示GROUPING SETS、onLimit。
  - Firefox／Chromeで同じSQLと期待行を記録。

### 8.4 完了 gate

1. 共通 gate。
2. B65-A01〜A05、M01〜M04がpass。
3. `npm run build:mcp` 後に `npm run mcp:smoke`。
4. `npm run mcp:pack-smoke`、`npm run build:mcpb`、`node scripts/mcpb-verify.mjs`。
5. Node／Firefox／Chrome benchmark evidenceをClaudeがレビュー。
6. effective guard定数、EXPLAIN、境界test、R2仕様、本計画が同じ値。
7. Firefox／Chrome plugin smokeは別release gateとし、Node／MCPだけで代替しない。

### 8.5 リスクと緩和

- benchmark fixtureが実データ幅を過小評価するとbrowser heap上限を誤る。最大幅row、低／高cardinality、重いaggregateを分けて測る。
- browser heap APIは精度／提供有無が異なる。取得方法と欠測を明記し、DevTools snapshot等の同等証拠を残す。
- benchmarkのためにpublic ExecuteOptions／CLI／MCP schema／plugin UIへguard設定を追加しない。内部定数と専用script引数を分離する。
- DISTINCT拒否とaggregate DISTINCT受理を混同しない。parser/planner error messageとA02/A07で別契約にする。

想定: **2.5〜4.0 人日**（browser実測環境の準備時間を含む）。

## 9. Step 6 — ドキュメント同期とリリース準備

### 9.1 目的

実装済みの公開構文、制約、effective guard、実行面を利用者向け文書、`ksql_docs`埋め込み、台帳、配布版数へ同期する。新規受理構文の追加なのでSemVerはminorを想定する。

### 9.2 変更ファイル

- `docs/ksql_language_reference.md`
  - §8 GROUP BY／集計へ `GROUPING SETS`、単一／複数列`ROLLUP`、空set、重複保持、`GROUPING()`、B64併用、完全入力、guardを追記。
  - §9 HAVINGへ「通常HAVINGは可、HAVING GROUPINGはPhase1拒否」を追記。
  - SELECT DISTINCT併用拒否、KORDER／window／CUBE／式item／CTE-temp materialized item拒否を明記。
  - 看板SQLとdiscriminator推奨を掲載。
- `src/mcp/docsResourceBuilder.cjs`／`src/mcp/docsResources.ts`
  - 現行は`docs/ksql_language_reference.md`をbuild時に埋め込む（`docsResourceBuilder.cjs:176`、`docsResources.ts:1-11`）。再buildで反映し、手書き複製は作らない。
- `src/mcp/__tests__/docsResources.test.ts`、`src/mcp/__tests__/docsTool.test.ts`
  - §8／§9のB65代表語、sourceとのbyte一致、docs非同梱bundleを確認。
- `README.md`
  - 対応構文一覧と最小例。詳細は言語リファレンスへリンク。
- `CHANGELOG.md`、`docs/ksql_issue_tracker.md`
  - B65実装状態、effective guard、evidence、Phase2繰越を同期。
- memory更新
  - ユーザーが明示依頼した場合だけ、所定のmemory extension noteを作る。通常のリポジトリ実装ではmemory本体を編集しない。
- release metadata（Claude／ユーザー実施）
  - `package.json`、`package-lock.json`先頭2箇所、`prod/manifest.json`の版数。
  - build済みplugin／CLI／MCP／MCPB成果物を既存release手順でcopy／検証。

### 9.3 テスト

- docs testで`ROLLUP`、`GROUPING SETS`、`GROUPING()`、`SELECT DISTINCT`拒否、effective guard、HAVING制限を固定。
- `npm run build:mcp`後、`ksql_docs`のlanguage-reference §8／§9がsourceと一致。
- pack-smokeでdocs非同梱install後もB65文書が読める。
- release candidateでB65-M01〜M04を再実行。

### 9.4 完了 gate

共通 gateとStep 5の全smokeをrelease candidate版数で再実行する。version、manifest、zip内manifest、npm pack内容、CHANGELOG、台帳、docs埋め込みの一致を確認する。Claudeがreview→commit→PRし、tag、GitHub Release、npm publishはユーザーが実施する。publish前にFirefox／Chrome実機evidenceが揃っていない場合はreleaseしない。

### 9.5 リスクと緩和

- source docsだけ更新してbuilt MCPへ入らない危険がある。build後`ksql_docs`とpack-smokeをgateにする。
- specのR2 conditional記述とowner確定のDISTINCT拒否が矛盾し得る。Step 5の別commitでspec §2、§10.4、§14 E34、§15 A06、§16をPhase1確定へ同期する。
- minor版数は全gate後に確定し、実装途中でrelease metadataを動かさない。

想定: **1.0〜1.5 人日**（tag／Release／publishのユーザー作業を除く）。

## 10. テストID割当とPhase2繰越

| 領域 | Step | B65 ID |
|---|---:|---|
| parser／AST／soft keyword | 1 | P01〜P09 |
| planning拒否／edge | 1 | E11〜E21、E28〜E29、E32、E34、E36、E41〜E43 |
| engine correctness | 2 | C01〜C11、E06、E10、E23、E26、E30、E33 |
| GROUPING／ORDER 4層 | 3 | C04、O01〜O06、E07〜E09、E31 |
| complete input／consumer／guard／EXPLAIN | 4 | F01〜F06、G01〜G03、X01、E22、E27、E35〜E40、E44 |
| B64／B56／HAVING | 5 | A01〜A05、A07 |
| MCP／plugin | 5 | M01〜M04 |

Phase2へ送るものは `CUBE`、式／alias／ordinal grouping item、複数引数GROUPING／GROUPING_ID、HAVING GROUPING、nested／mixed grouping element、`GROUP BY DISTINCT`、B65 + SELECT DISTINCT full evaluator、window併用、guard公開設定である。B65-A06とE34の受理版はPhase2 test backlogへ移す。

## 11. 段階マージ順と依存関係

| 順 | 独立レビュー単位 | 開く能力 | merge時の安全境界 |
|---:|---|---|---|
| 1 | AST/parser/validator | 構文表現と拒否 | engine未開通形はplanning gateで閉 |
| 2 | grouping engine/sidecar | 正しい中間行 | GROUPING外部評価は未開通 |
| 3 | GROUPING/ORDER 4層 | 看板query | complete-input/guardの最終開通前 |
| 4 | complete-input/guard/consumer | 全実行経路 | candidate guardでfail-closed |
| 5a | interaction/smoke | B64/B56/MCP/plugin | candidate値のままrelease不可 |
| 5b | benchmark値確定 | effective guard | spec/plan/test/EXPLAINを同時更新 |
| 6 | docs/release | 利用者公開 | 全自動＋両browser gate後のみ |

各行の末尾で`npm test`全green、`npm run build`成功、既存snapshot無変更を必須とする。Step 5bはbenchmark evidenceだけを根拠にした別commitとし、機能diffと数値裁定を混ぜない。

## 12. リスク一覧

| リスク | 失敗例 | 緩和／gate |
|---|---|---|
| 先頭行値漏れ | totalの会社名が`A` | C01、resolved direct/bridge同時上書き |
| membershipを値で推測 | detail空セルをtotal扱い | symbol sidecar、C03/C04 |
| set間state共有 | COUNT DISTINCTが過少／過大 | 逐次set、A01/A02 |
| bucket key衝突 | NUL入り値が同bucket | 構造key、C09 |
| alias上書き | `SUM(x) AS a`がgroup key破壊 | narrow fetch前拒否、C11/E32 |
| 看板CASEの過剰拒否 | `CASE ... AS 会社名`がerror | CASE_COL除外の正例を必須gate |
| ORDER 4層欠落 | total先頭／unresolved | O01の4 assertion |
| complete-input bypass | CTE JOINでtruncate小計 | 共通helper、F06 |
| consumer漏れ | `GROUPING SETS(())`がSIMPLE | normalizer＋allowlist、P08/F01 |
| guard過大 | browser OOM／timeout | 3 surface benchmark、release gate |
| guard過小 | 正常用途を不要拒否 | matrixと安全余裕をevidence化 |
| soft keyword破壊 | field `GROUPING`がparse不能 | P06、hard keyword追加禁止 |
| 通常GROUP BY drift | AST/EXPLAIN変化 | 既存snapshot無変更、各Step gate |

## 13. 再見積り

| 領域 | 人日 |
|---|---:|
| Step 1 AST/parser/validation | 3.0〜4.0 |
| Step 2 engine/sidecar | 3.5〜5.0 |
| Step 3 GROUPING/ORDER 4層 | 3.0〜4.5 |
| Step 4 complete-input/guard/consumer | 2.5〜3.5 |
| Step 5 interaction/benchmark/smoke | 2.5〜4.0 |
| Step 6 docs/release準備 | 1.0〜1.5 |
| **合計** | **15.5〜22.5 人日** |

R1 baselineは13〜21人日だった。今回の差分は次のとおり見積もる。

- B65 + SELECT DISTINCTをplanning拒否にしたため、full select-list evaluator、重複出力名、GROUPING／CASE／aggregate／scalar／string／literalの列位置key化をPhase2へ送り、**約1.5〜2.5人日縮小**。
- aggregate materialization全体のsidecar化をせずnarrow collision拒否にしたため、**約0.5〜1.0人日縮小**。
- CTE/temp併用は拒否せず共通helperを採用するため、拒否による縮小は**0人日**。局所helper、reason formatter、F06回帰として**約0.5〜1.0人日追加**。
- R2で増えたdirect consumer監査、allowlist、WHERE FALSE EXPLAIN、CTE/temp/UNION/subquery matrixとして**約1.5〜2.5人日追加**。
- candidate guardをNodeだけでなくFirefox／Chromeでも測るbenchmarkとevidenceに**約1.0〜2.0人日追加**。

したがって、縮小判断は高リスクのDISTINCT／materialization一般化を外す一方、R2で顕在化したconsumerとbrowser実測を省略しない。合計15.5〜22.5人日は、R1下限を単純に下げず、正しさとrelease証拠の増分を反映した値である。

## 14. 着手前にClaude確認が要る点

公開意味論の両論併記はしない。着手前のClaude確認は次の実装レビュー項目に限る。

1. Step 1〜6の順、各Step末の`npm test`／`npm run build`／既存snapshot無変更gate、Step 5bをguard値だけの別commitにする分割。
2. common complete-input helperを`executeSelect()`と`executeFullScanWithCte()`の双方へ適用する境界が、B30/KORDERのreason除外を維持していること。
3. narrow alias collisionの対象が4 materialize列の明示aliasだけで、看板`CASE ... END AS 会社名`を拒否しないこと。
4. benchmarkの対象surface、測定可能なheap指標、既存timeout予算、安全余裕の承認基準。effective値そのものは実測後に別レビューする。
5. minor版数の最終番号。番号は全gate後に決め、tag／Release／npm publishはユーザー作業とする。

## 15. 最終要約

1. **ステップ順とgate**: parser/拒否 → engine correctness → GROUPING/ORDER 4層 → complete-input/guard/consumer → interaction/benchmark → docs/release。各Step末で`npm test`全green、`npm run build`成功、既存snapshot無変更、Claudeレビューを必須とする。
2. **確定4判断**: guardは64/16/50,000をcandidateとして実装し3 surface実測で確定。B65+SELECT DISTINCTはPhase1 planning拒否。aggregate alias衝突は4 materialize列の明示aliasだけnarrow拒否し、看板CASE aliasは受理。CTE/temp bypassは共通complete-input helperで解消し併用を受理する。
3. **再見積り**: 15.5〜22.5人日。DISTINCT full evaluatorとmaterialization一般化の見送りで2.0〜3.5人日縮小する一方、CTE helper、direct consumer監査、browser benchmarkで3.0〜5.5人日を追加した。
4. **着手前Claude確認**: Step分割、helper境界、narrow collision条件、benchmark承認基準、最終minor版番号だけを確認する。仕様上の4判断は本計画で確定済みであり再選択しない。
