# B65 Phase1 仕様 R2 — 小計・総計（`ROLLUP` / `GROUPING SETS` / `GROUPING()`）

- ステータス: 📋 仕様 R2 確定（codex レビュー反映・要 Claude レビュー）
- 種別: 機能（集計・`GROUP BY` 拡張／結果正当性／完全入力）
- 優先: 中
- 関連: [B65 評価](ksql_b65_rollup_grouping_sets_evaluation.md)／[B64 条件付き集計](ksql_b64_aggregate_case_expression_spec.md)／[B56 統計集約・完全入力](ksql_b56_statistical_aggregates_spec.md)／[B59 ORDER BY alias・合成名](ksql_b59_orderby_alias_fix_spec.md)／[B40 有界 fail-closed](ksql_property_graph_phase1_spec.md)／[B30 ORDER BY 完全性](ksql_order_by_truncate_completeness_issue.md)／[文字列・比較意味論](ksql_string_semantics.md)

## 1. 目的

MCP から AI が、明細・小計・総計を 1 クエリ、1 結果セットで生成できるようにする。Phase1 は標準 SQL の `GROUPING SETS`、単一列および複数列 `ROLLUP`、`GROUPING(field)` の field-only サブセットを提供する。

設計の第一優先は、AI が次の看板クエリを特別な回避構文なしに生成でき、総計行を値ではなく `GROUPING()` で判別し、ラベル付けして末尾へソートできることである。

```sql
SELECT
  CASE WHEN GROUPING(会社名) = 1 THEN '合計' ELSE 会社名 END AS 会社名,
  GROUPING(会社名) AS grouping_company,
  COUNT(*) AS 案件数,
  SUM(売上) AS 売上合計,
  SUM(CASE WHEN 商談フェーズ = '受注' THEN 売上 ELSE 0 END) AS 受注済売上,
  SUM(CASE WHEN 商談フェーズ IN ('提案中','内示') THEN 売上 ELSE 0 END) AS 見込売上
FROM APP4149
GROUP BY ROLLUP(会社名)
ORDER BY GROUPING(会社名), 売上合計 DESC
```

このクエリでは会社別行で `GROUPING(会社名)=0`、総計行で `1` となる。総計行の `会社名` は内部的には空文字だが、CASE で `合計` と表示する。`grouping_company` は MCP クライアントが表示ラベルと実データを機械的に区別する discriminator である。

## 2. Phase1 のスコープ

### 2.1 対象

- `GROUP BY GROUPING SETS (...)`。各 grouping item は物理フィールド参照または修飾フィールド参照だけとする。
- `GROUP BY ROLLUP(a[, b ...])`。1 列以上の field-only item を受理する。
- 空 grouping set `()`、set 内の複数 item、明示した set の順序、重複 set を表現・実行する。
- `GROUPING(field)`。引数は 1 個の物理または修飾フィールド参照だけとする。
- `GROUPING(field)` の利用位置は SELECT 列、SELECT の CASE 条件、トップレベルの通常 `ORDER BY` とする。direct `ORDER BY GROUPING(col)` を必須とし、SELECT alias 経由だけに限定しない。
- B64 の条件付き集計、B56 の統計集約、既存集計、通常 HAVING、SELECT DISTINCT、LIMIT/OFFSET との組み合わせ。
- FULL_SCAN、完全入力、grouping set 数・grouping item 数・生成行数の fail-closed guard、EXPLAIN 表示。

### 2.2 対象外

- `CUBE`
- grouping item の算術式・文字列関数・CASE・alias・ordinal
- `GROUPING()` の式引数、複数引数、`GROUPING_ID`
- HAVING 内の `GROUPING()`
- `ROLLUP` / `CUBE` / `GROUPING SETS` を入れ子にした grouping element、通常 grouping item と grouping-set element の混在
- 標準 SQL の `GROUP BY DISTINCT`（展開後の重複 grouping set を実行前に除去する機能）。Phase1 は `GROUP BY ALL` 相当の重複保持だけを提供する。
- grouping-set 結果への `KORDER BY`。B65 の結果は kintone REST に存在しないローカル合成行なので、Phase1 は B65 文と `KORDER BY` の組み合わせを planning 時に拒否する。
- CTE/temp の materialized column を grouping item / `GROUPING()` arg にすること。Phase1 の field-only は APP 物理フィールドと、その table alias による修飾参照に固定する。
- window 関数との併用。grouping 後の合成行に対する window dependency 契約は別仕様とし、Phase1 は B65 文に `WINDOW_COL` があれば planning 時に拒否する。
- guard 閾値を利用者設定、CLI option、MCP schema、plugin UI へ公開すること。Phase1 は固定の安全上限から開始する。

対象外構文は、通常識別子や別の構文として誤解釈せず、可能な限り対象外要素を示す ParseError または planning ArgumentError で fail-closed に拒否する。

## 3. 現状コードの根拠

### 3.1 parser / AST

- `SelectStatement.groupBy` は `GroupByKey[]` であり、通常 GROUP BY の 1 セットしか表現しない（`src/types/ast.ts:205-215`）。`GroupByKey` は `FIELD_NAME | ARITH_KEY | FUNC_KEY` の平坦な union である（同 `:592-609`）。set 境界、空 set、全 item と現在 set の差を保持できない。
- `parseSelect()` は `GROUP BY` 後に `parseGroupByKeys()` を 1 回呼ぶ（`src/parser/parser.ts:1034-1056`）。`parseGroupByKeys()` はカンマ区切りの平坦なキー列を返し、`parseGroupByKey()` は関数・算術・フィールドを解釈する（同 `:2457-2492`）。B65 には括弧とカンマの責務が異なる専用 parser が必要である。
- `parseScalarValueExpr()` は集計関数を拒否し、通常関数は `tryStringFuncName()` 経由である（同 `:1431-1517`）。`GROUPING()` を通常文字列関数へ追加すると WHERE 等でも利用でき、行の grouping 状態も渡せない。
- CASE 条件と HAVING の左辺は `parseFieldValue()` の関数・集計・CASE・算術・フィールド別分岐を通る（同 `:2252-2287`）。看板例を成立させるには、この経路で集計文脈専用参照を受理する必要がある。
- `ORDER BY` のキーは `FIELD_NAME | ARITH_KEY | FUNC_KEY`、関数は通常関数だけである（`src/types/ast.ts:605-609`、`src/parser/parser.ts:2494-2535`）。direct `ORDER BY GROUPING(col)` 用の AST と lowering が必要である。

### 3.2 集計 engine とパイプライン

- `applyGroupBy()` は各入力行の全キーを `join("\x00")` した 1 個の `Map<string, ProcessRow[]>` を作る単一-set 実装である（`src/engine/process.ts:240-253`）。各 bucket へ既存 evaluator を適用する構造は再利用できる。
- 空入力かつ GROUP BY なしの集計は仮想 bucket を 1 個作る（同 `:255-260`）。B65 の空 set `()` に同じ集計規約を適用できる。
- 集計出力は `{ ...groupRows[0] }` で元行をコピーして開始する（同 `:263-267`）。set から除外された列を上書きしなければ、subtotal / grand-total 行へ先頭レコードの実値が残る。これは B65 で必ず閉じる correctness hole である。
- 集計 alias と合成名は group stage で中間行へ併記され、HAVING / ORDER BY が project 前に参照する（同 `:278-300`）。現行コードに `GROUPING()` の materialize 経路はなく、R2 は衝突回避のため同方式を GROUPING へ流用しない。
- `runFullScan()` は filter → group → HAVING → window → DISTINCT → ORDER BY → LIMIT/OFFSET → project の順である（同 `:1347-1390`）。group stage で全 set を縦結合すれば、後段は結合済み結果全体へ作用する。
- `buildOrderByAliasEvaluator()` は project 前の行から SELECT alias と集計合成名を解決する（同 `:722-780`）。direct `ORDER BY GROUPING(col)` は専用 key、GROUPING alias は sidecar evaluator の追加が必要であり、共有文字列合成名への lowering は採用しない。

### 3.3 converter / planner / 完全入力

- `resolveSelectMode()` は `stmt.groupBy.length > 0` を FULL_SCAN 条件にする（`src/converter/selectToKintone.ts:59-84`）。新 AST を別経路に置いたままでは `GROUPING SETS (())` を SIMPLE と誤分類する。
- `collectRequiredFieldsByTable()` は平坦な `stmt.groupBy` を走査する（同 `:622-695`）。全 set の item を一度だけ漏れなく収集し、`GROUPING(arg)` は追加の物理出力列ではなく grouping-item 参照として検証する必要がある。
- `buildOrderSemanticsForSelect()` は物理列と SELECT alias の比較意味論を組み立てる（`src/execute.ts:4228-4325`）。canonical planner は意味論を解決できない FIELD_NAME キーを `ORDER_KEY_UNRESOLVED` で拒否する（`src/core/optimization/canonicalOrderPlanner.ts:46-96`）。B65 は grouping 値の number semantics を明示的に供給しなければならない。
- `CompleteInputReason` は DML、VALIDATE、LOCAL_ORDER、WINDOW_ORDER、STATISTICAL_AGGREGATE を持つ（`src/core/dmlGuard.ts:62-67`）。`selectCompleteInputReasons()` は ORDER BY と統計集約等を検出するが通常 GROUP BY は理由にしない（同 `:139-152`）。B65 専用理由が必要である。
- 実行時は complete-input reason があれば `onLimit=truncate` を `error` へ差し替え、上限到達時に reason 付き `FetchAllLimitError` を返す（`src/execute.ts:2296-2327`）。EXPLAIN も同じ reason 集合を表示する（同 `:8600-8608`）。B65 はこの共通経路を使う。

### 3.4 R1 で漏れていた `groupBy` 直接 consumer

production code の `stmt.groupBy` / `query.groupBy` 直接参照を再検索した結果、R1 が列挙した engine、`resolveSelectMode()`、required-field walker、EXPLAIN だけでは網羅されない。少なくとも次を B65 対応対象とする（行番号は R2 レビュー時点）。

| consumer | 現行参照 | B65 で必要な変更 |
|---|---|---|
| parser の window 併用拒否 | `src/parser/parser.ts:1081-1085` | B65 grouping も GROUP BY として拒否条件へ含める |
| IMPORT projection 制約 | 同 `:676-685` | B65 grouping を式だけの projection と誤認しない |
| scalar-subquery probe | `src/execute.ts:2010-2015` | B65 を `LIMIT 2` probe 対象から除外する |
| no-FROM 拒否 | 同 `:2419-2422` | no-FROM B65 を拒否する |
| CTE inline 判定 | `src/core/cteInlining.ts:5-19` | B65 final query を inline 不可にする |
| FULL_SCAN reason | `src/execute.ts:8717-8738` | `GROUPING SETS` / `ROLLUP` を理由表示する |
| EXPLAIN metadata 判定 | `src/core/explainMetadata.ts:36-41` | grouping field の実在・曖昧性解決に必要な metadata を取得する |
| AST 手組み箇所 | `src/execute.ts:5782-5787`、`src/core/cteInlining.ts:35-48` | optional field を採用して既存 object literal を壊さない。B65 を再構築する箇所は明示伝播する |

テスト内の `applyGroupBy(rows, stmt.groupBy, ...)` は通常 GROUP BY の単一-set unit test として残してよい。production consumer は、parser の AST 構築境界と通常 GROUP BY 専用関数を除き、§5 の accessor を使う。単一 accessor は型だけでは強制できないため、実装 PR では `rg -n "\\.groupBy\\b" src --glob "*.ts"` の結果を allowlist 化してレビュー証拠に残す。

### 3.5 標準 SQL との照合

Phase1 の公開意味論は PostgreSQL の公式 SQL 説明を参照基準とする。

- grouping sets は各 set を個別 GROUP BY した結果の `UNION ALL` 相当である。重複 set は保持し、Phase1 対象外の `GROUP BY DISTINCT` だけが実行前に重複 set を除去する。`SELECT DISTINCT` は SELECT 出力行へ後から作用する別機能である（[PostgreSQL SELECT / GROUP BY](https://www.postgresql.org/docs/current/sql-select.html)）。
- `ROLLUP(a1,...,an)` は完全な item 列から空列までの prefix `n+1` set を生成する（[PostgreSQL GROUPING SETS, CUBE, and ROLLUP](https://www.postgresql.org/docs/current/queries-table-expressions.html#QUERIES-GROUPING-SETS)）。
- 空 set `()` は単一の全体 group を表す。入力 0 件でも空 set は 1 group、非空 set は 0 group である。
- 標準の `GROUPING` は複数引数の bit mask を返し、各 bit は対応式が現在 set に含まれれば 0、含まれなければ 1 である（[PostgreSQL Grouping Operations](https://www.postgresql.org/docs/current/functions-aggregate.html#FUNCTIONS-GROUPING-TABLE)）。Phase1 の 1 引数限定はこの意味論の安全なサブセットであり、独自の 0/1 定義ではない。
- super-aggregate 列を標準の NULL ではなく外部値 `""` へ写像する点だけは kSQL 固有の表現差である。grouping membership 自体は標準どおり値と分離する。

## 4. 文法

Phase1 の概念文法を次とする。大文字小文字は既存 kSQL と同様に区別しない。

```ebnf
group_by_clause        ::= GROUP BY plain_group_by
                         | GROUP BY grouping_sets_clause
                         | GROUP BY rollup_clause

plain_group_by         ::= group_by_key (',' group_by_key)*
grouping_sets_clause   ::= GROUPING SETS '(' grouping_set (',' grouping_set)* ')'
grouping_set           ::= '(' [field_ref (',' field_ref)*] ')'
                         | field_ref
rollup_clause          ::= ROLLUP '(' field_ref (',' field_ref)* ')'
grouping_ref           ::= GROUPING '(' field_ref ')'
```

`grouping_set ::= field_ref` は標準 SQL が許す 1 item set の省略表記であり、独自構文ではない。保守的な初期実装として括弧形だけに狭めることは本 R2 の契約を満たさない。

`field_ref` は APP の物理フィールド参照または `[table-alias.]field` である。SELECT alias、CTE/temp の materialized column は grouping item / `GROUPING()` 引数として扱わない。JOIN で無修飾名が複数ソースに一致する場合は planning 時に曖昧参照として拒否する。

### 4.1 soft keyword と互換性

`ROLLUP`、将来予約する可能性のある `CUBE`、`GROUPING`、`SETS` は hard keyword に追加しない。lexer は従来どおり IDENT として読み、parser が次の文脈だけで soft keyword と判定する。

- `GROUP BY` の直後に `ROLLUP` + `(`
- `GROUP BY` の直後に `GROUPING` + `SETS` + `(`
- Phase1 で許可した式位置に `GROUPING` + `(`

それ以外では同名のフィールド・alias を従来どおり受理する。`SELECT ROLLUP, GROUPING, SETS, CUBE FROM APP1`、`SELECT x AS GROUPING ... ORDER BY GROUPING`、通常の `GROUP BY ROLLUP`（`ROLLUP` というフィールド名で直後が `(` でない形）を壊してはならない。`SEPARATOR` 等の `isSoftKeyword()` 前例（`src/parser/parser.ts:1874-1893, 3093`）と同じ文脈判定を用い、lexer の予約語 drift guard を更新しないことを互換受入条件とする。

## 5. AST と正規形

### 5.1 後方互換 AST

通常 GROUP BY の AST snapshot と既存 consumer を壊さないため、`SelectStatement.groupBy: GroupByKey[]` は型・値とも維持する。R1 の「nullable `grouping` を常に出しつつ通常 AST は byte-equivalent」という主張は両立しない。`grouping: null` を追加すれば JSON/snapshot は変わり、required property にすれば既存の AST object literal もコンパイル時に壊れる。R2 は **optional field を B65 文にだけ出す**形へ改める。

```ts
interface SelectStatement {
  // 既存。通常 GROUP BY は従来どおりここだけを使う。
  groupBy: GroupByKey[];
  // absent = B65 構文ではない。存在するとき groupBy は []。
  grouping?: GroupingSpec;
}

type GroupingFieldItem = FieldRef; // tableAlias と field を既存型で構造保持

type GroupingSpec = {
  type: "GROUPING_SETS";
  source: "GROUPING_SETS" | "ROLLUP";
  allItems: GroupingFieldItem[];
  sets: GroupingSet[];
};

type GroupingSet = {
  items: GroupingFieldItem[];
};
```

`groupBy` と `grouping` が同時に有効な AST は internal validation error とする。parser は通常 GROUP BY なら `grouping` property 自体を出さず従来と byte-equivalent な AST を生成し、B65 構文なら `groupBy=[]` と `grouping` を生成する。AST を spread clone する経路は property を自然に保持するが、新しい `SelectStatement` を組み立て直す経路は §3.4 の監査対象とする。

二経路の読み落としを減らすため、engine、FULL_SCAN 判定、required-field walker、complete-input walker、EXPLAIN、validator に加え、§3.4 の parser 後 consumer は `normalizeGroupingSpec(stmt)` またはそれだけを使う `hasGroupingClause(stmt)` を介す。返り値は次の discriminated union とする。

```ts
type NormalizedGroupingSpec =
  | { type: "NONE" }
  | { type: "PLAIN"; allItems: GroupByKey[]; sets: readonly [GroupByKey[]] }
  | { type: "GROUPING_SETS"; source: "GROUPING_SETS" | "ROLLUP";
      allItems: GroupingFieldItem[]; sets: GroupingSet[] };
```

これにより通常 GROUP BY の公開 AST/挙動を保持しながら consumer は `NONE` / `PLAIN` / `GROUPING_SETS` を exhaustively 分岐できる。ただし `groupBy` を公開維持する以上、二経路読み落としを型だけで不可能にはできない。R2 の受入条件は accessor の存在だけではなく、直接参照 allowlist、`groupBy` と `grouping` の排他 invariant test、`GROUPING SETS (())` を用いた全 consumer の回帰 test である。

### 5.2 正規化と順序

- `ROLLUP(a)` は `GROUPING SETS ((a), ())` へ展開する。
- `ROLLUP(a,b)` は `GROUPING SETS ((a,b), (a), ())` へ展開する。
- 一般に `ROLLUP(a1,...,an)` は prefix 長 `n` から `0` までの `n+1` set へ展開する。
- `source` は EXPLAIN と diagnostics のため保持するが、実行 engine は共通 `GROUPING_SETS` 正規形だけを見る。
- `sets` は明示順と重複を保持する。`allItems` は全 set を明示順に走査した canonical item の初出順集合とする。`ROLLUP` では引数の初出順集合である。
- 同一 set 内の重複 item は parser AST に保持し、planning 後の bucket key では同じ canonical item として 1 回評価してよい。ただし展開後に同値となる set は削除しない。たとえば `ROLLUP(a,a)` の先頭 2 set が同じ grouping membership になっても、2 set 分の結果行を生成する。
- set の順は内部の安定性と EXPLAIN のため保持するが、SQL の結果順契約ではない。利用者が順序を必要とする場合は `ORDER BY` を書く。

### 5.3 canonical item identity

parser の文字列一致ではなく、planning で解決した物理ソース identity と field code の組を canonical ID とする。概念形は `source-id + field-code` であり、表示用文字列を ID にしない。

- `会社名` と `a.会社名` が同じ一意なソースへ解決される場合は同じ item とする。
- JOIN で `会社名` が曖昧なら拒否する。
- SELECT alias と同名でも alias へ解決しない。
- `GROUPING(arg)` はこの canonical ID で `allItems` と照合する。

planning 後は各 item に `canonicalId` だけでなく、B65 中間行で読み書きする `directKey` と、存在する場合だけ `unqualifiedBridgeKey` を持たせる。`directKey` は修飾参照なら `alias.field`、非修飾参照なら一意解決済み field code である。JOIN で同名 field が複数ソースにある場合、無修飾 bridge は canonical identity を表現できないため作らず、無修飾参照自体を拒否する。

## 6. planning 時検証（fail-closed）

B65 文は fetch 前に次を検証する。

1. grouping item は field-only であり、各参照が実在し、一意に解決できる。
2. `GROUPING(arg)` の arg が canonical `allItems` に存在する。存在しなければ `1` を返さず ArgumentError とする。
3. `GROUPING()` は B65 grouping 文の SELECT、SELECT CASE 条件、トップレベル通常 ORDER BY だけにある。WHERE、JOIN ON、HAVING、集計引数、通常 GROUP BY 文、window の PARTITION/ORDER、DML 式では拒否する。
4. SELECT/HAVING/ORDER BY の非集計 field dependency は、既存 alias・集計合成名を除き canonical `allItems` に属する。先頭行コピー由来の任意値を出せる非 grouped 列は拒否する。
5. 非集計の式や CASE が参照する物理 field も再帰 walker で検証する。看板例の CASE は `GROUPING(会社名)` と `会社名` だけなので受理する。grouped field 以外を参照する裸の式は拒否する。
6. HAVING に `GROUPING()` があれば、後段評価可能であっても Phase1 対象外として明示的に拒否する。GROUPING を含まない既存 HAVING は受理する。
7. `KORDER BY`、window 関数、対象外の grouping element、引数なし・複数引数の `GROUPING()` を拒否する。
8. `SELECT *` / `alias.*` / `_p.*` は、非 grouped 列を先頭行から漏らし、GROUPING 用内部値を wildcard 列へ混入させ得るため B65 文では Phase1 planning error とする。既知列へ展開してから一部だけ許可する最適化は行わない。
9. `GROUPING` の出力 alias と同名の source field があっても `GROUPING(arg)` の arg は必ず source field として解決する。ORDER BY の alias precedence は既存 B59 契約に従う。一方、現行 `applyGroupBy()` は集計 alias を `ProcessRow` の文字列 key へ書くため、集計 alias／集計合成名が grouping field の runtime key と衝突する B65 文は、collision-safe sidecar 化されない限り planning 時に拒否する。黙って後勝ち上書きしない。

この検証は parser の文字列検査だけで済ませず、required-field 解決と同じ table/field resolver を共有する。エラーは該当句、参照名、reason code を含める。B65 validator は SELECT、CASE 条件、ORDER BY だけでなく、HAVING、JOIN、wildcard、alias/synthetic-key collision を同じ resolved identity 上で検査する。

## 7. engine 設計

### 7.1 複数 set 評価と縦結合

filter 後の完全な入力行集合を 1 回取得し、展開済み `sets` を明示順に評価する。各 set について、その set の canonical item 列を構造的な複合キーとして bucket 化し、各 bucket に既存集計 evaluator を独立適用する。各 set の結果行を 1 本の配列へ縦結合し、後続の HAVING / DISTINCT / ORDER BY / LIMIT / project へ渡す。

キーを単純な NUL join だけに依存させない。値自体に separator が含まれる可能性を排除できないため、長さ prefix、tuple serializer、または入れ子 Map 等の衝突しない構造キーを使う。通常 GROUP BY のキー方式変更は B65 の必須範囲ではないが、新しい grouping-set 経路では衝突を増幅させない。

初期実装は set 間 accumulator 共有を行わず、正当性を優先する。最適化する場合も set/bucket ごとに NULL 除外、DISTINCT 集合、B64 式評価、集計状態が論理的に独立することを証明する。

### 7.2 空文字への明示上書き（最重要 correctness 契約）

現行と同様に bucket の先頭行を中間評価用にコピーしてもよいが、その直後に次を必ず行う。

1. `allItems` の各 resolved item を走査する。
2. 現在 set に含まれる item は bucket の grouping 値で `directKey` を確定上書きする。
3. 現在 set に含まれない item は、元行の値にかかわらず `directKey` を `""` へ明示上書きする。
4. その item に一意な `unqualifiedBridgeKey` がある場合だけ、同じ値で同時上書きする。JOIN の曖昧な無修飾名には bridge を作らない。
5. field-only の Phase1 grouping item には式合成名を作らない。集計 alias／集計合成名はその後に materialize される別 namespace であり、§6.9 の衝突検査なしに grouping field key と共有しない。

grand-total `()` では全 grouping item が `""`、subtotal `(a)` では `a` だけが grouping 値、除外された `b...` はすべて `""` である。`{...groupRows[0]}` の実値が、qualified key、合法な unqualified bridge、CASE/SELECT が実際に読む経路のいずれかへ残ることは仕様違反であり、テストの最優先回帰点とする。

### 7.3 grouping 状態メタデータ

各中間行へ、現在 set に**含まれる** canonical item ID の `ReadonlySet` を持つ `GroupingRowMeta` を付与する。JavaScript bitwise number は 32 bit 制限を持つため、Phase1 の truth source に number bitmask を使わない。

メタデータは通常出力キーと衝突しない `unique symbol` の非列挙 property、または同等に衝突不能な sidecar とする。`__grouping` のような利用者フィールドと衝突し得る文字列キーは禁止する。group → HAVING → DISTINCT → ORDER BY → LIMIT の各段で保持し、project で除去する。`applyOrderBy()` と `applyLimit()` は行 object を保持するが、将来を含む clone 処理は symbol の列挙性に依存せず明示伝播する。

R1 の「`GROUPING(field)` ごとの canonical 合成名へ `"0"` / `"1"` を materialize」は撤回する。文字列 key は同名の物理 field、SELECT alias、集計合成名、wildcard 出力と衝突し得るためである。GROUPING の truth/value は sidecar だけに置き、SELECT projection、CASE 条件、direct ORDER BY、ORDER BY alias evaluator が共通 `evalGroupingRef(ref, rowMeta)` を呼ぶ。外部 row へ値を書き出すのは project 時だけとする。

## 8. `GROUPING(field)` の意味論

現在行の grouping membership に canonical arg が含まれれば `0`、含まれず super-aggregate されていれば `1` を返す。

```text
GROUPING(arg, row) = row.groupingItems.has(canonical(arg)) ? 0 : 1
```

- field の実値が空文字かどうかは一切判定材料にしない。
- 戻り値は number 型メタを持つ整数 0/1 である。内部 ProcessRow では `"0"` / `"1"` としても、比較・ORDER BY は number semantics を使う。
- grouping item に無い arg は planning error であり、常に `1` を返す便利関数にはしない。
- 通常の scalar/string function registry には登録しない。集計文脈専用の `GroupingRef` と resolver を、Phase1 で許す SELECT column、CASE 条件の `FieldValue`、`OrderByKey` へだけ供給する。
- SELECT alias と `GROUPING()` の arg の解決を混ぜない。

推奨 AST 追加は次である。

```ts
type GroupingRef = { type: "GROUPING_REF"; field: FieldRef };
type SelectColumn = ExistingSelectColumn
  | { type: "GROUPING_COL"; ref: GroupingRef; alias: string | null };
type FieldValue = ExistingFieldValue
  | { type: "GROUPING_FIELD"; ref: GroupingRef };
type OrderByKey = ExistingOrderByKey
  | { type: "GROUPING_KEY"; ref: GroupingRef };
```

R1 のように `ScalarValueExpr` 全体へ `GroupingRef` を追加すると、算術、CONCAT、CASE の THEN/ELSE、集計引数、DML など Phase1 対象外の経路へ型上は流入する。R2 は上記 3 wrapper に限定する。`CASE WHEN GROUPING(a)=1` は `GROUPING_FIELD`、`SELECT GROUPING(a)` は `GROUPING_COL`、direct ORDER BY は `GROUPING_KEY` を通る。将来 `GROUPING(a)+1` 等を許す Phase2 で初めて scalar union への統合を再検討する。

看板 CASE の実経路は `parseSelectColumns()` → `parseCaseWhenExpr()` → `parseWhereExpr()` → `parseFieldValue()` → `GROUPING_FIELD`、評価は `project()` → `evalCaseWhen()` → `evalWhere()` → `resolveField()` → `evalGroupingRef()` である。direct ORDER BY は `parseOrderByKey()` → `GROUPING_KEY`、`planCanonicalOrder()` → `applyOrderBy()` → `evalOrderKey()` → `evalGroupingRef()` を通る。SELECT alias 経由は `GROUPING_COL` を `buildOrderSemanticsForSelect()` で number と推論し、`buildOrderByAliasEvaluator()` が sidecar から評価する。parser だけ、または group stage の文字列 materialize だけでは看板例は成立しない。

## 9. super-aggregate 行の表現

Phase1 の外部値契約は次で固定する。

| 行種別 | grouped field の出力値 | `GROUPING(field)` |
|---|---|---:|
| field が現在 set に含まれ、実データ値が `A` | `A` | 0 |
| field が現在 set に含まれ、実データが空セル | `""` | 0 |
| field が現在 set から除外された subtotal / total | `""` | 1 |

kSQL の未設定スカラー値＝空文字契約を維持し、標準 SQL の super-aggregate NULL を kSQL の外部値へ写像する。したがって値だけでは実データ空セルと total を区別できない。機械判別が必要な MCP / API 利用では、`GROUPING(col) AS grouping_col` 等の衝突しない discriminator を SELECT することを利用契約として推奨する。表示ラベルだけの `合計` は実データと衝突し得るため discriminator の代替ではない。

## 10. 既存機能との相互作用

### 10.1 B64 条件付き集計

各 set の各 bucket に既存 `evalAggregate()` / `evalAggArithExpr()` / `resolveAggInScalarValue()` を独立適用する。`SUM(CASE ...)`、`COUNT(CASE ...)`、`DISTINCT` 付き条件集計の filter/NULL/空値規約は B64 のまま維持する。

grand-total set は WHERE と JOIN 後の全入力、subtotal はその set の bucket 入力を対象にする。set 間で DISTINCT 集合や accumulator を共有しない。

### 10.2 B56・完全入力

B56 統計集約があればその規約も適用するが、B65 文は集計関数の種類、ORDER BY の有無、set の形にかかわらず常に完全入力必須である。subtotal/total 自体が全入力へ依存するためである。

`CompleteInputReason` に `GROUPING_SETS` を追加する。`ROLLUP` も正規化後は同じ reason を使う。通常 GROUP BY は現在 reason にならない（`src/core/dmlGuard.ts:139-152`）ため、単に `groupBy.length` を一般化するのではなく normalized type が `GROUPING_SETS` のときだけ追加する。

`completeInputReasons()` の現行再帰は、UNION の left/right、WITH の各 CTE と main、CREATE TEMP TABLE の query、SELECT 列 scalar subquery、CASE **条件**、WHERE/HAVING の IN/scalar/EXISTS subquery を辿る（同 `:93-178`）。CaseResult は現行 AST 上 subquery を含まない。R2 はこの実構造を test matrix とし、「任意 AST を自動的に再帰する」とは主張しない。DML は `DML` reason を追加して早期 return するため INSERT/UPSERT SELECT 内の B65 は完全入力自体は満たすが、reason 集合へ `GROUPING_SETS` を併記する契約ではない。

さらに、reason walker が再帰できることと全実行経路がその reason を適用することは別である。通常 `executeSelect()` は `src/execute.ts:2296-2305` で truncate を error に差し替えるが、materialized CTE/temp 参照時の `executeQueryWithCte()` → `executeFullScanWithCte()` は同 `:3590-3599, 3609-3782` で `executeSelect()` を経由せず、現状は `options.onLimitReached` を物理 APP fetch へそのまま渡す。R1 はこの bypass を見落としていた。

Phase1 で B65 と CTE/temp の併用を許すには、order-plan による ORDER reason 除外を含む complete-reason/effective-options/error-prefix 計算を共通 helper に抽出し、`executeSelect()` と `executeFullScanWithCte()` の双方で fetch 前に適用する。これができない縮小実装では materialized source を FROM/JOIN に含む B65 文を一律 planning error とする。item だけ物理 field に制限して bypass を放置することは不可である。

呼出し側が `onLimit=truncate` を指定しても実効値を `error` にし、上限到達時は `FetchAllLimitError` とする。部分入力の subtotal/total は警告付きでも返さない。

エラー subject は `src/execute.ts:2337-2342` の現行「統計集約単独、それ以外は ORDER BY」二択を reason ごとの formatter へ一般化し、少なくとも `GROUPING_SETS` 単独時に次を示す。複数 reason では特定の一機能名へ誤帰属せず「クエリの正しい結果」とする。

```text
小計・総計の正しい結果には完全な候補集合が必要です。
complete input reason: GROUPING_SETS。onLimit=truncateは使用できません。
```

WHERE が定数 false でも実行意味論上は §10.6 の空入力結果を返す。EXPLAIN は Records API 不要を表示してよいが、`src/execute.ts:8581-8585` の現行早期 return より前に B65 の静的 guard、grouping source/set/item、complete-input reason を表示する。定数 false を理由に §12.2 の露出契約を省略しない。

### 10.3 B59 ORDER BY 4層

`ORDER BY GROUPING(col), 売上合計 DESC` を次の 4 層すべてで同時に成立させる。

1. **構文**: parser/AST が dedicated `GROUPING_KEY` を保持する。文字列 synthetic key へ lower しない。
2. **値**: `evalOrderKey()` と `buildOrderByAliasEvaluator()` が同じ sidecar resolver から `"0"` / `"1"` を得る。group stage の enumerable string key へ materialize しない。
3. **型メタ**: `sortDecoratedRows()` は `GROUPING_KEY` を number semantics とし、`buildOrderSemanticsForSelect()` は `GROUPING_COL AS alias` を number と推論する。CASE label の alias は従来どおり CASE 結果型であり GROUPING alias と混同しない。
4. **planner**: canonicalOrderPlanner は dedicated key を未解決 FIELD として扱わず、`ORDER_KEY_NOT_REST_EQUIVALENT` / query-shape local により `CANONICAL_LOCAL` とする。alias key は number meta を解決できなければ従来どおり fail-closed に拒否する。

B65 は常に FULL_SCAN、REST ORDER BY 押し下げ不可であり、全 set の縦結合・HAVING・DISTINCT 後にローカル全結果ソートする。昇順なら detail/subtotal の `0` が total の `1` より前になる。集計式または alias の比較意味論は B59/B26 の既存契約を維持する。

### 10.4 SELECT DISTINCT と集計 DISTINCT

- `COUNT(DISTINCT x)` 等は set/bucket 内で独立評価する。
- 明示した重複 grouping set は標準互換で重複行として保持する。
- SELECT DISTINCT は全 set を縦結合し、HAVING を適用した後、**SELECT list の全出力式を評価した値**で重複を除く。`GROUP BY DISTINCT` とは異なり grouping set 自体を削除しない。

R1 の「現行 DISTINCT にそのまま載る」という主張は誤りである。`applyDistinct()` / `buildDistinctKeyBuilder()`（`src/engine/process.ts:533-600`）は現状、wildcard と FIELD/WINDOW/PARENT_WILDCARD を主に key 化し、AGGREGATE、CASE、SCALAR_VALUE、文字列関数等を SELECT list 全体として評価していない。B65 でこれを流用すると、たとえば空文字 detail と total が集計値や `GROUPING()` で異なっても同一 FIELD key だけで誤って畳まれる。

したがって Phase1 の受入条件として DISTINCT key builder を project と共通の「1 column evaluator」へ統合し、`GROUPING_COL`、CASE、全 aggregate/式/literal、重複出力名を列位置順に key 化する。これを行わない縮小実装では **B65 + SELECT DISTINCT を一律 planning error** とし、部分対応は認めない。正しく対応した場合、discriminator を SELECT しなければ出力値が同じ detail/total は畳まれ、SELECT した discriminator や異なる集計値があれば保持される。

### 10.5 HAVING

GROUPING を含まない既存 HAVING は、各 set の集計行を縦結合した後、DISTINCT 前に適用する。SELECT にない直接集計を materialize しない等の既存制約は変えない。

HAVING 内 `GROUPING()` は Phase2 であり、R2 は parser/planner で明示的に拒否する。内部メタが存在することを理由に無保証で受理してはならない。

### 10.6 0 件入力と空 set

- 非空 set は入力 0 件なら 0 行を生成する。
- 空 set `()` は入力 0 件でも 1 個の仮想 bucket を生成する。`GROUPING SETS (())` は GROUP BY なし集計と同じ集計値規約を使う。ただし `allItems` が空なので、この形で `GROUPING(arg)` を書くと §6.2 により拒否される。
- B65 文では grouping clause 自体が grouped query を形成するため、空 set は SELECT に通常集計がない場合も 1 行を生成する。たとえば入力 0 件の `GROUPING SETS ((a),())` で `SELECT GROUPING(a)` は、非空 set から 0 行、空 set から値 1 の 1 行を返す。現行 `hasAggregateColumns()` gate の単純流用だけではこの形を落とすため、B65 経路で明示する。
- `COUNT(*)` は 0、既存 SUM/AVG/MIN/MAX 等と B56 統計の空集合規約は各仕様を維持する。

### 10.7 LIMIT / OFFSET / window

LIMIT/OFFSET は縦結合、HAVING、DISTINCT、ORDER BY の後に適用する。Phase1 は window 併用を拒否するため、B65 の実行順説明へ window を含めない。guard は LIMIT で最終表示行が減る場合も免除しない。生成済み中間行の爆発と、LIMIT 前の正しい順序/集合を守る必要があるためである。

既存 window 関数は通常文では HAVING 後・DISTINCT 前に作用するが、Phase1 は B65 文との併用を一律 planning error とする。grouping 後の合成列だけを参照する window の許可は Phase2 以降に、field dependency と型メタを含む別契約として追加する。

## 11. FULL_SCAN / required fields / planner

- `normalizeGroupingSpec(stmt).type === "GROUPING_SETS"` は set 数、空 set、集計列、ORDER BY にかかわらず `resolveSelectMode()` で FULL_SCAN とする。
- WHERE の EXACT_PUSHDOWN は既存どおり許可するが、取得対象全件を確定した後の group、HAVING、ORDER、LIMIT はローカルで行う。
- required-field walker は `allItems` を canonical 化前の参照として全件走査し、set ごとの重複取得はしない。JOIN 修飾を正しい table へ振り分ける。
- `GROUPING(arg)` は `arg` が `allItems` に一致することを検証する walker へ渡す。関数評価のための別物理列として二重収集しない。ただし arg の元 grouping field 自体は allItems 由来で取得対象になる。
- SELECT walker は `GROUPING_COL`、CASE/HAVING/WHERE walker は `GROUPING_FIELD`、ORDER walker は `GROUPING_KEY` を exhaustively 処理する。HAVING/WHERE では node を認識した上で Phase1 context error にし、default で FIELD や通常関数と誤認しない。
- EXPLAIN、実行、field validation、canonical order planner は同じ normalized grouping と canonical item resolver を共有する。
- 現行 `addFieldName(..., "groupBy")` は SELECT alias と同名の GROUP BY key を収集対象から外す（`src/converter/selectToKintone.ts:438-443`）。B65 item は SELECT alias を許さないため、この除外規則をそのまま流用せず source field として解決する。
- `explainNeedsAppMetadata()` も grouping item と `GROUPING(arg)` の field metadata を必要とする。EXPLAIN が Records API を呼ばないことと、フォーム定義による planning/validation を行うことを混同しない。

## 12. guard と fail-closed

### 12.1 検査点

全 grouping-set 構文へ次の独立上限を適用する。ROLLUP は糖衣展開後、重複 set を含む数で判定する。

| guard | 検査時点 | R2 candidate（未確定） | 超過時 |
|---|---|---:|---|
| 展開後 grouping set 数 | planning、fetch 前 | 64 | planning ArgumentError |
| canonical grouping item 数 | planning、fetch 前 | 16 | planning ArgumentError |
| 生成集計行数（全 set 合計） | runtime、HAVING/DISTINCT/LIMIT 前 | 50,000 | dedicated runtime error |

生成行数は各 set で新 bucket を発見した時点で全 set 合計を加算し、上限 + 1 の bucket を作ろうとした時点で中止する。後段 HAVING、DISTINCT、LIMIT が減らす見込みを先取りしてはならない。例外発生前に内部で一部行を作っていても、呼出し側へ部分結果を返さない。set は逐次評価し、完了済み set の `ProcessRow[]` だけを縦結合する。全 set 分の `Map<key, ProcessRow[]>` を同時保持して `入力行数 × set 数` の参照配列を作らない。

64 / 16 / 50,000 は R1 が根拠なく置いた候補であり、R2 レビュー時点にも Node / Firefox / Chrome benchmark 証拠がない。したがって **確定値として扱わない**。3 guard の独立性、検査時点、fail-closed は R2 の確定契約だが、数値は §16 の Claude 判断かつ実装開始前 gate とする。少なくとも次を測る。

- 入力 10,000 行、1/8/32/64 sets
- 1/2/4/8/16 items、低 cardinality と全行 unique
- B64 CASE 集計、COUNT DISTINCT、B56 統計を含むケース
- peak heap、group stage 経過時間、UI/MCP timeout、guard 到達時に結果が返らないこと

benchmark で値を決めても、set/item/generated-row を別 guard とし、HAVING/DISTINCT/LIMIT 前に fail-closed とする契約は変更しない。初期値を `maxRecords` や temp table 上限へ暗黙連動させない。candidate 値を採用する場合も、最大幅の実データ相当 row と browser peak heap を含む証拠を残す。

### 12.2 diagnostics / EXPLAIN

reason code を安定契約として次のように分離する（最終命名は既存 error code 規約へ合わせてよい）。

- `GROUPING_SET_LIMIT_EXCEEDED`
- `GROUPING_ITEM_LIMIT_EXCEEDED`
- `GROUPING_OUTPUT_LIMIT_EXCEEDED`
- `GROUPING_ARG_NOT_IN_SPEC`
- `GROUPING_CONTEXT_UNSUPPORTED`

planning error は展開後実数と上限、runtime error は作成しようとした行数と上限を含む。SQL 全文やレコード値を不要に露出しない。

EXPLAIN は Records API を実行せず、**effective guard 値が §16 で確定した後**に少なくとも次を表示する。以下の数値は candidate の表示例である。

```text
mode: FULL_SCAN
grouping source: ROLLUP
grouping sets: 2 (limit: 64)
grouping items: 1 (limit: 16)
grouping output rows: runtime checked (limit: 50000, before HAVING/DISTINCT/LIMIT)
complete input: required (onLimit=truncate disabled)
complete input reason: GROUPING_SETS
order plan: CANONICAL_LOCAL
```

EXPLAIN は実行前なので実生成行数を表示しない。明示 GROUPING SETS では source と、空 set・重複を含む展開後 set 数を表示する。planning guard 超過時も Records API fetch 前に、実数、上限、reason code を含む error として終了する。定数 false predicate でも静的 grouping/guard/complete-input 行は省略しない。

## 13. 後方互換

1. 通常 `GROUP BY a, b` の parser AST (`groupBy: GroupByKey[]`)、実行順、空値、集計、FULL_SCAN、required fields、EXPLAIN は不変とする。
2. `ROLLUP` / `GROUPING` / `SETS` / `CUBE` は hard keyword にせず、同名 field/alias の既存 SQL を壊さない。
3. 既存集計の `onLimit=truncate` 契約は B65 文以外で変更しない。B65 文だけが `GROUPING_SETS` reason により常時完全入力となる。
4. B64/B56 の集計 evaluator、DISTINCT 単位、空値、数値 guard、合成名規約を維持する。
5. 通常 GROUP BY の expression item (`ARITH_KEY` / `FUNC_KEY`) は引き続き受理するが、B65 grouping item と `GROUPING()` arg には Phase1 で使えない。
6. 予約語互換調査として lexer token snapshot、parser compatibility corpus、フィールド/alias 位置、GROUP BY 文脈の前方一致を回帰試験し、破壊が 0 件であることを Phase1 の受入条件とする。

## 14. エッジケース・受理／拒否表

| ID | SQL 断片 | 期待 | 理由／結果 |
|---|---|---|---|
| B65-E01 | `GROUP BY ROLLUP(会社名)` | 受理 | `(会社名), ()` |
| B65-E02 | `GROUP BY ROLLUP(地域,会社名)` | 受理 | `(地域,会社名), (地域), ()` |
| B65-E03 | `GROUP BY GROUPING SETS ((地域,会社名),(地域),())` | 受理 | 明示順を保持 |
| B65-E04 | `GROUP BY GROUPING SETS (会社名, ())` | 受理 | 標準の single-item 省略形 |
| B65-E05 | `GROUPING SETS ((会社名),(会社名),())` | 受理 | 会社 set の結果を 2 回保持。SELECT DISTINCT は後段 |
| B65-E06 | detail の `会社名=''` と total | 受理 | どちらも値 `""`、GROUPING は 0 と 1 |
| B65-E07 | `SELECT GROUPING(会社名) ... ROLLUP(会社名)` | 受理 | number 0/1 |
| B65-E08 | `CASE WHEN GROUPING(会社名)=1 ...` | 受理 | 看板経路 |
| B65-E09 | `ORDER BY GROUPING(会社名), SUM(売上)` | 受理 | direct key、双方 number semantics、local sort |
| B65-E10 | `GROUPING SETS (())`、入力 0 件 | 受理 | empty set から 1 行 |
| B65-E11 | `GROUPING(地域)` + `ROLLUP(会社名)` | 拒否 | arg が allItems に無い |
| B65-E12 | `GROUPING(UPPER(会社名))` | 拒否 | 式 arg は Phase2 |
| B65-E13 | `ROLLUP(地域 || 会社名)` | 拒否 | 式 item は Phase2 |
| B65-E14 | `CUBE(地域,会社名)` | 拒否 | Phase2 以降 |
| B65-E15 | `HAVING GROUPING(会社名)=0` | 拒否 | HAVING GROUPING は Phase2 |
| B65-E16 | `WHERE GROUPING(会社名)=0` | 拒否 | 集計前文脈 |
| B65-E17 | `GROUPING()` / `GROUPING(a,b)` | 拒否 | 引数は field 1 個 |
| B65-E18 | `GROUPING SETS (ROLLUP(a,b),())` | 拒否 | nested grouping element は対象外 |
| B65-E19 | `GROUP BY a, ROLLUP(b)` | 拒否 | grouping element 混在は対象外 |
| B65-E20 | `SELECT 非group列, SUM(x) ... ROLLUP(a)` | 拒否 | 任意の先頭行値を出さない |
| B65-E21 | `KORDER BY GROUPING(a)` | 拒否 | synthetic 行を REST native sort できない |
| B65-E22 | effective limit + 1 sets | 拒否 | set planning guard、fetch なし |
| B65-E23 | 50,001 行目の aggregate row | 拒否 | runtime fail-closed、部分結果なし |
| B65-E24 | `SELECT ROLLUP, GROUPING, SETS, CUBE FROM APP1` | 受理 | soft keyword 互換 |
| B65-E25 | `SELECT x AS GROUPING FROM APP1 ORDER BY GROUPING` | 受理 | alias として従来どおり |
| B65-E26 | `ROLLUP(a,a)` | 受理 | 展開 set の重複を除去しない |
| B65-E27 | effective limit + 1 unique items | 拒否 | item planning guard、fetch なし |
| B65-E28 | `SELECT * ... GROUP BY ROLLUP(a)` | 拒否 | 非 grouped 先頭行値と内部 key の漏出防止 |
| B65-E29 | JOIN で `a.code` と `b.code` が存在し `ROLLUP(code)` | 拒否 | 無修飾曖昧参照 |
| B65-E30 | JOIN で `ROLLUP(a.code,b.code)`、`GROUPING(a.code)` | 受理 | canonical source identity を分離。曖昧 bridge は作らない |
| B65-E31 | `SELECT GROUPING(a) AS a ... ROLLUP(a)` | 受理 | GROUPING arg は source field。ORDER BY `a` は既存 alias precedence |
| B65-E32 | `SUM(x) AS a` と grouping runtime key `a` が衝突 | 条件付き拒否 | collision-safe sidecar 化がない実装では planning error |
| B65-E33 | 同じ行で複数の `GROUPING(a)`, `GROUPING(b)` を SELECT/CASE/ORDER から参照 | 受理 | 各 canonical membership を独立評価 |
| B65-E34 | `SELECT DISTINCT a, SUM(x), GROUPING(a) ...` | 受理 | 全 SELECT column 値で distinct。対応未実装なら B65+DISTINCT 全体を拒否 |
| B65-E35 | `WITH c AS (SELECT ... FROM APP1 GROUP BY ROLLUP(a)) SELECT * FROM c` | 受理 | B65 は CTE body で実行。complete-input reason を再帰伝播 |
| B65-E36 | `SELECT ... FROM #t GROUP BY ROLLUP(tcol)` | 拒否 | materialized CTE/temp column は Phase1 item 対象外 |
| B65-E37 | `CREATE TEMP TABLE #t AS SELECT ... FROM APP1 GROUP BY ROLLUP(a)` | 受理 | B65 出力の materialize は可。CREATE TEMP query 再帰で完全入力 |
| B65-E38 | UNION / UNION ALL の一分岐内 B65 | 受理 | 各 branch を完結評価後、既存 UNION distinct/all 契約を適用 |
| B65-E39 | scalar/IN/EXISTS subquery 内 B65 | 受理 | complete-input reason を再帰伝播。scalar は既存 1行1列制約を別途満たす |
| B65-E40 | `WHERE FALSE GROUP BY GROUPING SETS (())` | 受理 | fetch なし、空 set 1 行。EXPLAIN は B65 静的情報を表示 |
| B65-E41 | `GROUP BY DISTINCT ROLLUP(a,a)` | 拒否 | 標準機能だが Phase1 対象外。通常 `SELECT DISTINCT` と混同しない |
| B65-E42 | `GROUP BY GROUPING SETS ()` | 拒否 | grouping set list 自体は 1 個以上必要。空 set は `(())` |
| B65-E43 | `GROUP BY ROLLUP()` | 拒否 | ROLLUP item は 1 個以上必要 |
| B65-E44 | materialized CTE/temp を JOIN し物理 APP field を `ROLLUP` | 受理 | common complete-input helper を CTE 実行経路にも適用。未対応実装は併用全体を拒否 |

保守的解釈として、標準が許すより広い grouping element 合成は Phase1 で拒否する。一方、公開する構文の意味論は標準の ROLLUP prefix 展開、重複 grouping set 保持、GROUPING 0/1 に従い、独自の subtotal sentinel やラベル構文は導入しない。

## 15. テスト計画

すべて「修正前 fail → 修正後 pass」を証拠化する。parser-only green では完了とせず、engine、execute/planner、EXPLAIN、MCP smoke まで通す。

### 15.1 parser / AST

- **B65-P01**: 単一/複数列 ROLLUP の展開 snapshot。
- **B65-P02**: 明示 GROUPING SETS の空 set、複数 item、single-item 省略形、明示順、重複保持。
- **B65-P03**: SELECT の `GROUPING_COL`、CASE 条件の `GROUPING_FIELD`、direct ORDER BY の `GROUPING_KEY`。`ScalarValueExpr` へ漏らさない。
- **B65-P04**: CUBE、式 item、nested element、引数数、HAVING/WHERE GROUPING の専用拒否。
- **B65-P05**: 通常 GROUP BY AST snapshot が変更されない。
- **B65-P06**: ROLLUP/GROUPING/SETS/CUBE の field/alias soft-keyword compatibility corpus。
- **B65-P07**: optional `grouping` により通常 GROUP BY AST snapshot / object literal が不変、B65 だけ property が存在し、`groupBy` との同時有効を拒否。
- **B65-P08**: §3.4 の direct `groupBy` allowlist と、window / IMPORT / no-FROM / scalar probe / CTE inline の B65 回帰。
- **B65-P09**: `GROUPING SETS ()` と `ROLLUP()` は拒否し、`GROUPING SETS (())` だけを空 set 1 個として受理する。

### 15.2 engine correctness

- **B65-C01（最重要）**: 元入力先頭行が `地域='東',会社名='A'` の `ROLLUP(地域,会社名)` で、`(地域)` 行の会社名と `()` 行の地域/会社名が必ず `""`。修正前は `{...groupRows[0]}` により `A` / `東` が残って fail、修正後 pass。
- **B65-C02**: set に残る field は bucket 値で確定上書きし、qualified direct key と合法な unqualified bridge の双方が正しい。JOIN の曖昧 bridge は作らない。
- **B65-C03**: 実データ空セル detail (`"",0`) と total (`"",1`) が別行になる。
- **B65-C04**: `GROUPING()` は field 値でなく membership を見る。detail 空セルで 0、値がある field を除外した total で 1。
- **B65-C05**: `ROLLUP(a,b)` が detail、a subtotal、grand total を縦結合し、各集計値が正しい。
- **B65-C06**: 重複 set / `ROLLUP(a,a)` が重複行を保持し、SELECT DISTINCT のみが後段で畳む。
- **B65-C07**: 0 件で非空 set 0 行、空 set 1 行。GROUPING-only と各集計の空集合規約。
- **B65-C08**: grouping metadata が user field 名と衝突せず、project 後に漏れない。
- **B65-C09**: NUL 等を含む値でも bucket key が衝突しない。
- **B65-C10**: `GROUPING()` は enumerable string synthetic key を作らず、同名物理 field / alias / aggregate synthetic name / wildcard と衝突しない。
- **B65-C11**: aggregate alias が grouping runtime key と衝突するケースを collision-safe に処理するか、fetch 前に明示拒否する。

### 15.3 B64 / B56 / DISTINCT / HAVING

- **B65-A01**: 各 set で B64 `SUM(CASE ...)` / `COUNT(CASE ...)` が独立し、grand total は filter 後全入力。
- **B65-A02**: COUNT DISTINCT と B56 数値 DISTINCT が set 間で state を共有しない。
- **B65-A03**: B56 統計の空集合、非数値 fail-closed、complete-input reason 併記。
- **B65-A04**: GROUPING を含まない HAVING が縦結合後に各行へ作用する。
- **B65-A05**: HAVING GROUPING は明示拒否する。
- **B65-A06**: SELECT DISTINCT key が FIELD だけでなく aggregate、CASE、GROUPING、scalar/string/literal を列位置順に含む。空文字 detail と total が投影値どおり保持／除去される。
- **B65-A07**: `GROUP BY DISTINCT` は Phase1 で明示拒否し、`SELECT DISTINCT` と error/message を混同しない。

### 15.4 ORDER BY 4層 / planner

- **B65-O01**: `ORDER BY GROUPING(a), total DESC` が構文・値・number meta・planner の 4 層を通り total が末尾。
- **B65-O02**: direct GROUPING と `SELECT GROUPING(a) AS g ORDER BY g` が同じ順序。
- **B65-O03**: 集計 alias なしの合成名でも B59 resolver が正しい。
- **B65-O04**: B65 は `CANONICAL_LOCAL` / FULL_SCAN、REST 押し下げなし。`ORDER_KEY_UNRESOLVED` にならない。
- **B65-O05**: KORDER 併用拒否。
- **B65-O06**: `GROUPING(a) AS a` と source field `a` の衝突時、GROUPING arg は source-first、ORDER BY は既存 alias precedence。複数 GROUPING key は各々 number semantics。

### 15.5 FULL_SCAN / required fields / complete input / guard

- **B65-F01**: `GROUPING SETS (())` だけでも FULL_SCAN。
- **B65-F02**: 全 set の全 field を正しい app/table から収集し、GROUPING arg を出力物理列として重複収集しない。
- **B65-F03**: `onLimit=truncate` を指定して上限到達すると `GROUPING_SETS` reason の FetchAllLimitError。部分小計を返さない。
- **B65-F04**: ORDER BY/統計なしでも完全入力 required。WITH/UNION/CREATE TEMP/SELECT column subquery/CASE 条件/WHERE/HAVING subquery の各既存再帰経路を個別検証する。DML は既存 `DML` reason 早期 return を確認する。
- **B65-F05**: CTE body / temp 作成 query / UNION branch の B65 は受理し、materialized CTE/temp column を B65 item にする query は拒否する。
- **B65-F06**: materialized CTE/temp を FROM/JOIN に含み、物理 APP field だけを grouping item にする B65 でも `executeFullScanWithCte()` が `onLimit=truncate` を error へ差し替える。共通化しない縮小実装では fetch 前に併用全体を拒否する。
- **B65-G01**: §16 で確定した set/item/generated-row 各 effective limit 境界は成功、各 +1 は該当 reason で失敗。
- **B65-G02**: ROLLUP 展開後、重複込みで set guard を数える。
- **B65-G03**: generated-row guard は HAVING/DISTINCT/LIMIT 前に作動し、どれが結果を減らしても免除されない。
- **B65-X01**: EXPLAIN が source、set/item/row effective limit、FULL_SCAN、complete-input reason、local order を表示し、Records API を呼ばない。WHERE FALSE でも grouping 情報を早期 return で落とさない。

### 15.6 end-to-end / MCP

- **B65-M01**: §1 の看板 SQL を MCP で実行し、会社明細 + 総計、CASE ラベル、discriminator、総計末尾を確認する。
- **B65-M02**: `ROLLUP(地域,会社名)` で地域×会社明細、地域小計、総計を確認する。
- **B65-M03**: 明示 GROUPING SETS で不要な階層を省き、明示順とは無関係に ORDER BY が最終順を決める。
- **B65-M04**: MCP の `onLimit=truncate` でも fail-closed。CLI/plugin 共通 core の契約 test を通す。

完了証拠は B65 ID、修正前の失敗内容、修正後の pass、実行面、EXPLAIN、benchmark 結果を 1 対 1 で追跡できる形にする。

## 16. 要 Claude 判断が必要な残論点

公開構文と標準意味論、AST の optional 二経路、GROUPING の sidecar resolver、3 guard の構造は R2 で固定する。次は証拠またはオーナー判断なしに確定できない。

1. **guard effective 値**: §12 の 64 sets / 16 items / 50,000 generated rows は candidate に降格した。Node/Firefox/Chrome の peak heap・時間・timeout benchmark を確認し、採用または変更する。値が決まるまで実装開始 gate は未充足とする。
2. **B65 + SELECT DISTINCT の実装範囲**: R2 推奨は full select-list evaluator への修正を Phase1 に含めること。工数を切る場合は組み合わせ全体を planning error とし、R1 のような不完全流用は不可。
3. **aggregate alias / grouping runtime key collision**: Phase1 で aggregate materialization も sidecar 化するか、B65 validator で衝突 SQL を拒否するか。silent overwrite は不可。
4. **固定 guard の将来設定面**: Phase1 後に設定可能にする場合の ExecuteOptions / CLI / MCP / plugin 配管。Phase1 の公開設定追加は行わない。

`GroupingRef` の node 配置は R2 で SELECT / CASE-condition FieldValue / ORDER BY の dedicated wrapper に決めた。`CUBE`、式 grouping item、HAVING GROUPING、GROUPING_ID、nested element、`GROUP BY DISTINCT` は未解決ではなく Phase2 以降の対象外項目である。

## 17. 実装規模見積り

R1 の 13〜21 人日は、field-only、固定 guard、CLI/MCP/plugin 共通 core、テスト・EXPLAIN・互換調査・文書同期を前提にした **baseline** である。

| 領域 | 概算 |
|---|---:|
| parser / AST / soft keyword / validation | 3〜5 人日 |
| grouping-set engine、空文字上書き、内部メタ、B64/B56 統合 | 4〜6 人日 |
| GROUPING の SELECT/CASE/ORDER BY 4層、型メタ、planner | 3〜5 人日 |
| 完全入力、guard、EXPLAIN、required fields | 2〜3 人日 |
| regression、MCP/plugin smoke、benchmark、文書同期 | 1〜2 人日 |
| **R1 baseline 小計** | **13〜21 人日** |
| R2 追加: direct consumer 監査、DISTINCT full evaluator、collision 対応 | **要再見積り** |

最大の不確実性は複数 set の bucket 化ではなく、`GROUPING()` を SELECT、CASE 条件、direct ORDER BY、型メタ、canonical planner へ一貫して通す統合である。次点は DISTINCT evaluator、aggregate alias collision、修飾/無修飾 field の canonical identity、browser plugin で安全な generated-row 上限である。R2 は評価文書の 13〜21 人日を確定値として維持せず、§16.2/16.3 の選択後に再見積りする。

## 18. R2 判断要約

1. **Phase1 の核**: field-only の明示 GROUPING SETS、単一/複数列 ROLLUP、SELECT/CASE 条件/direct ORDER BY の GROUPING を、FULL_SCAN・完全入力・有界 fail-closed で提供する。看板 MCP クエリを第一受入とする。
2. **R1 から維持した方針**: soft keyword、ROLLUP prefix 展開、空 set、重複 set 保持、canonical source identity、専用 `GROUPING_SETS` complete-input reason、3 独立 guard、KORDER/window 拒否は妥当である。
3. **R2 の重要修正**: 通常 AST の byte-equivalent 性のため `grouping` は optional、直接 `groupBy` consumer を全列挙・allowlist 化、GROUPING 値は文字列 synthetic key でなく sidecar resolver、空文字上書きは resolved direct/unique bridge key に限定、SELECT DISTINCT は全 SELECT list evaluator が条件、標準の `GROUP BY DISTINCT` を対象外として正しく区別する。
4. **残る判断**: guard effective 値、B65+DISTINCT を完全実装するか一律拒否するか、aggregate alias collision を sidecar 化するか拒否するかは Claude 判断が必要である。
5. **実装規模**: R1 の 13〜21 人日は、DISTINCT evaluator 修正と consumer 追加監査を含まないため下限としてのみ扱う。Claude が DISTINCT 完全対応と collision-safe materialization を選ぶ場合は再見積りする。

## R1→R2 変更ログ

- **AST の内部矛盾を修正**: `grouping: null` を常時追加しながら通常 AST を byte-equivalent とすることは不可能だったため、B65 文だけに出す optional `grouping?: GroupingSpec` へ変更した。
- **consumer 網羅を修正**: engine / converter / required fields 以外に parser window・IMPORT、scalar probe、no-FROM、CTE inline、EXPLAIN reason/metadata、AST 再構築箇所を追加し、direct `groupBy` allowlist を受入条件にした。
- **標準 SQL の位置付けを修正**: R1 が「拡張」とした `GROUP BY DISTINCT` は標準側の重複 set 除去機能である。Phase1 対象外だが `SELECT DISTINCT` とは別物として明記した。ROLLUP prefix、空 set、重複保持、GROUPING bit の根拠を PostgreSQL 公式文書と照合した。
- **GROUPING 横断統合を具体化**: general `ScalarValueExpr` への追加をやめ、`GROUPING_COL` / `GROUPING_FIELD` / `GROUPING_KEY` と共通 sidecar resolver に限定した。看板 CASE と direct/alias ORDER BY の具体関数経路を追記した。
- **文字列 synthetic key 方針を撤回**: `GROUPING(field)` の `"0"/"1"` materialize は物理 field、alias、集計合成名、wildcard と衝突するため禁止し、project/evaluator が非列挙 sidecar から読む設計へ変更した。
- **空文字上書きを精密化**: `allItems` の曖昧な「全出力キー」ではなく resolved `directKey` と一意な場合だけの `unqualifiedBridgeKey` を上書きする。JOIN 同名 field の曖昧 bridge は作らない。
- **alias 衝突を fail-closed 化**: 現行 `{...groupRows[0]}` 後の aggregate alias materialize が grouping field key を上書き得るため、collision-safe 化または planning 拒否を必須にした。
- **SELECT DISTINCT の過大主張を修正**: 現行 `applyDistinct()` は全 SELECT 式を key 化しない。full select-list evaluator へ直すか、B65+DISTINCT を一律拒否する二択に変更した。
- **完全入力の再帰を実コードどおり記述**: UNION、WITH、CREATE TEMP、SELECT scalar subquery、CASE 条件、WHERE/HAVING subquery の経路と、DML reason 早期 return を明記した。エラー subject の ORDER BY 固定 fallback 一般化も具体化した。
- **CTE/temp 実行 bypass を追加修正**: `executeFullScanWithCte()` は `executeSelect()` の truncate→error 差し替えを通らない。complete-input helper の共通化、または併用全体の planning 拒否を必須にした。
- **EXPLAIN の矛盾を修正**: WHERE FALSE の早期 return でも grouping/guard/complete-input 静的情報を落とさない契約へ変更した。
- **guard 数値の過大確定を撤回**: benchmark 証拠がない 64/16/50,000 は candidate に降格し、effective 値の決定を実装開始前 gate とした。同時に全 set bucket Map を並行保持しないメモリ契約を追加した。
- **意味論・負例・テストの穴を追加**: wildcard、JOIN 修飾/曖昧性、`ROLLUP(a,a)`、複数 GROUPING、GROUPING alias 衝突、DISTINCT、CTE/temp、UNION、subquery、WHERE FALSE、`GROUP BY DISTINCT` を受理/拒否表とテスト計画へ追加した。
