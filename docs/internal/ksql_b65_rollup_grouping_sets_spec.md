# B65 Phase1 仕様 R1 — 小計・総計（`ROLLUP` / `GROUPING SETS` / `GROUPING()`）

- ステータス: 📋 仕様 R1 起票（要 codex レビュー→Claude レビュー）
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
- `DISTINCT` を grouping-set 構文自体へ付ける拡張
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
- 集計 alias と合成名は group stage で中間行へ併記され、HAVING / ORDER BY が project 前に参照する（同 `:278-300`）。`GROUPING()` も同じ段階で materialize する。
- `runFullScan()` は filter → group → HAVING → window → DISTINCT → ORDER BY → LIMIT/OFFSET → project の順である（同 `:1347-1390`）。group stage で全 set を縦結合すれば、後段は結合済み結果全体へ作用する。
- `buildOrderByAliasEvaluator()` は project 前の行から SELECT alias と集計合成名を解決する（同 `:722-780`）。ただし direct `ORDER BY GROUPING(col)` は専用キーまたは共有合成名への lowering が必要である。

### 3.3 converter / planner / 完全入力

- `resolveSelectMode()` は `stmt.groupBy.length > 0` を FULL_SCAN 条件にする（`src/converter/selectToKintone.ts:59-84`）。新 AST を別経路に置いたままでは `GROUPING SETS (())` を SIMPLE と誤分類する。
- `collectRequiredFieldsByTable()` は平坦な `stmt.groupBy` を走査する（同 `:622-695`）。全 set の item を一度だけ漏れなく収集し、`GROUPING(arg)` は追加の物理出力列ではなく grouping-item 参照として検証する必要がある。
- `buildOrderSemanticsForSelect()` は物理列と SELECT alias の比較意味論を組み立てる（`src/execute.ts:4228-4325`）。canonical planner は意味論を解決できない FIELD_NAME キーを `ORDER_KEY_UNRESOLVED` で拒否する（`src/core/optimization/canonicalOrderPlanner.ts:46-96`）。B65 は grouping 値の number semantics を明示的に供給しなければならない。
- `CompleteInputReason` は DML、VALIDATE、LOCAL_ORDER、WINDOW_ORDER、STATISTICAL_AGGREGATE を持つ（`src/core/dmlGuard.ts:62-67`）。`selectCompleteInputReasons()` は ORDER BY と統計集約等を検出するが通常 GROUP BY は理由にしない（同 `:139-152`）。B65 専用理由が必要である。
- 実行時は complete-input reason があれば `onLimit=truncate` を `error` へ差し替え、上限到達時に reason 付き `FetchAllLimitError` を返す（`src/execute.ts:2296-2327`）。EXPLAIN も同じ reason 集合を表示する（同 `:8600-8608`）。B65 はこの共通経路を使う。

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

`grouping_set ::= field_ref` は標準 SQL が許す 1 item set の省略表記であり、独自構文ではない。保守的な初期実装として括弧形だけに狭めることは本 R1 の契約を満たさない。

`field_ref` は APP の物理フィールド参照または `[table-alias.]field` である。SELECT alias、CTE/temp の materialized column は grouping item / `GROUPING()` 引数として扱わない。JOIN で無修飾名が複数ソースに一致する場合は planning 時に曖昧参照として拒否する。

### 4.1 soft keyword と互換性

`ROLLUP`、将来予約する可能性のある `CUBE`、`GROUPING`、`SETS` は hard keyword に追加しない。lexer は従来どおり IDENT として読み、parser が次の文脈だけで soft keyword と判定する。

- `GROUP BY` の直後に `ROLLUP` + `(`
- `GROUP BY` の直後に `GROUPING` + `SETS` + `(`
- Phase1 で許可した式位置に `GROUPING` + `(`

それ以外では同名のフィールド・alias を従来どおり受理する。`SELECT ROLLUP, GROUPING, SETS, CUBE FROM APP1`、`SELECT x AS GROUPING ... ORDER BY GROUPING`、通常の `GROUP BY ROLLUP`（`ROLLUP` というフィールド名で直後が `(` でない形）を壊してはならない。`SEPARATOR` 等の `isSoftKeyword()` 前例（`src/parser/parser.ts:1874-1893, 3093`）と同じ文脈判定を用い、lexer の予約語 drift guard を更新しないことを互換受入条件とする。

## 5. AST と正規形

### 5.1 後方互換 AST

通常 GROUP BY の AST snapshot と既存 consumer を壊さないため、`SelectStatement.groupBy: GroupByKey[]` は型・値とも維持する。B65 用に nullable な専用フィールドを追加する。

```ts
interface SelectStatement {
  // 既存。通常 GROUP BY は従来どおりここだけを使う。
  groupBy: GroupByKey[];
  // null = B65 構文ではない。非 null のとき groupBy は []。
  grouping: GroupingSpec | null;
}

type GroupingFieldItem = {
  type: "FIELD_NAME";
  name: string;              // parser が保持する原表記
};

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

`groupBy` と `grouping` が同時に有効な AST は internal validation error とする。parser は通常 GROUP BY なら従来と byte-equivalent な `groupBy` を生成し、B65 構文なら `groupBy=[]` と `grouping!=null` を生成する。

二経路の読み落としを防ぐため、engine、FULL_SCAN 判定、required-field walker、complete-input walker、EXPLAIN、validator は `normalizeGroupingSpec(stmt)` という単一 accessor を介す。返り値は次の discriminated union とする。

```ts
type NormalizedGroupingSpec =
  | { type: "NONE" }
  | { type: "PLAIN"; allItems: GroupByKey[]; sets: readonly [GroupByKey[]] }
  | { type: "GROUPING_SETS"; source: "GROUPING_SETS" | "ROLLUP";
      allItems: GroupingFieldItem[]; sets: GroupingSet[] };
```

これにより通常 GROUP BY の公開 AST/挙動を保持しながら、全 consumer は `NONE` / `PLAIN` / `GROUPING_SETS` を exhaustively 分岐できる。

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

## 6. planning 時検証（fail-closed）

B65 文は fetch 前に次を検証する。

1. grouping item は field-only であり、各参照が実在し、一意に解決できる。
2. `GROUPING(arg)` の arg が canonical `allItems` に存在する。存在しなければ `1` を返さず ArgumentError とする。
3. `GROUPING()` は B65 grouping 文の SELECT、SELECT CASE 条件、トップレベル通常 ORDER BY だけにある。WHERE、JOIN ON、HAVING、集計引数、通常 GROUP BY 文、window の PARTITION/ORDER、DML 式では拒否する。
4. SELECT/HAVING/ORDER BY の非集計 field dependency は、既存 alias・集計合成名を除き canonical `allItems` に属する。先頭行コピー由来の任意値を出せる非 grouped 列は拒否する。
5. 非集計の式や CASE が参照する物理 field も再帰 walker で検証する。看板例の CASE は `GROUPING(会社名)` と `会社名` だけなので受理する。grouped field 以外を参照する裸の式は拒否する。
6. HAVING に `GROUPING()` があれば、後段評価可能であっても Phase1 対象外として明示的に拒否する。GROUPING を含まない既存 HAVING は受理する。
7. `KORDER BY`、window 関数、対象外の grouping element、引数なし・複数引数の `GROUPING()` を拒否する。

この検証は parser の文字列検査だけで済ませず、required-field 解決と同じ table/field resolver を共有する。エラーは該当句、参照名、reason code を含める。

## 7. engine 設計

### 7.1 複数 set 評価と縦結合

filter 後の完全な入力行集合を 1 回取得し、展開済み `sets` を明示順に評価する。各 set について、その set の canonical item 列を構造的な複合キーとして bucket 化し、各 bucket に既存集計 evaluator を独立適用する。各 set の結果行を 1 本の配列へ縦結合し、後続の HAVING / DISTINCT / ORDER BY / LIMIT / project へ渡す。

キーを単純な NUL join だけに依存させない。値自体に separator が含まれる可能性を排除できないため、長さ prefix、tuple serializer、または入れ子 Map 等の衝突しない構造キーを使う。通常 GROUP BY のキー方式変更は B65 の必須範囲ではないが、新しい grouping-set 経路では衝突を増幅させない。

初期実装は set 間 accumulator 共有を行わず、正当性を優先する。最適化する場合も set/bucket ごとに NULL 除外、DISTINCT 集合、B64 式評価、集計状態が論理的に独立することを証明する。

### 7.2 空文字への明示上書き（最重要 correctness 契約）

現行と同様に bucket の先頭行を中間評価用にコピーしてもよいが、その直後に次を必ず行う。

1. `allItems` の各 canonical field 出力キーを走査する。
2. 現在 set に含まれる item は bucket の grouping 値で確定上書きする。
3. 現在 set に含まれない item は、元行の値にかかわらず `""` へ明示上書きする。
4. grouping item の評価結果を materialize する合成名キーがある場合も同じ規則で上書きする。Phase1 の item は field-only だが、修飾/無修飾 bridge や将来式 item の synthetic key に実値を残さない。

grand-total `()` では全 grouping item が `""`、subtotal `(a)` では `a` だけが grouping 値、除外された `b...` はすべて `""` である。`{...groupRows[0]}` の実値が残ることは仕様違反であり、テストの最優先回帰点とする。

### 7.3 grouping 状態メタデータ

各中間行へ、現在 set に**含まれる** canonical item ID の `ReadonlySet` を持つ `GroupingRowMeta` を付与する。JavaScript bitwise number は 32 bit 制限を持つため、Phase1 の truth source に number bitmask を使わない。

メタデータは通常出力キーと衝突しない `unique symbol` の非列挙 property、または同等に衝突不能な sidecar とする。`__grouping` のような利用者フィールドと衝突し得る文字列キーは禁止する。group → HAVING → DISTINCT → ORDER BY → LIMIT の各段で保持し、project で除去する。行を clone する処理がある場合は明示的に伝播する。

同時に、参照される `GROUPING(field)` ごとの canonical 合成名へ文字列 `"0"` / `"1"` を group stage で materialize する。ProcessRow の値は文字列だが、型メタは number とする。合成名 serializer は SELECT、CASE 条件、ORDER BY、validator、EXPLAIN で共有し、空白・大小文字・修飾表記差による不一致を作らない。

## 8. `GROUPING(field)` の意味論

現在行の grouping membership に canonical arg が含まれれば `0`、含まれず super-aggregate されていれば `1` を返す。

```text
GROUPING(arg, row) = row.groupingItems.has(canonical(arg)) ? 0 : 1
```

- field の実値が空文字かどうかは一切判定材料にしない。
- 戻り値は number 型メタを持つ整数 0/1 である。内部 ProcessRow では `"0"` / `"1"` としても、比較・ORDER BY は number semantics を使う。
- grouping item に無い arg は planning error であり、常に `1` を返す便利関数にはしない。
- 通常の scalar/string function registry には登録しない。集計文脈専用の `GROUPING_REF` 相当 AST と resolver を SELECT expression、CASE の `FieldValue`、OrderByKey へ一貫して供給する。
- SELECT alias と `GROUPING()` の arg の解決を混ぜない。

推奨 AST 追加は次である。

```ts
type GroupingRef = { type: "GROUPING_REF"; field: FieldRef };
// SelectColumn / ScalarValueExpr / FieldValue の必要な分岐で GroupingRef を参照
type OrderByKey = ExistingOrderByKey | { type: "GROUPING_KEY"; ref: GroupingRef };
```

具体的に `GroupingRef` を各 union へ直接追加するか、集計専用 scalar node に包むかは実装判断とする。ただし通常関数化、WHERE での利用、string 型への fallback は不可である。

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

`CompleteInputReason` に `GROUPING_SETS` を追加する。`ROLLUP` も正規化後は同じ reason を使う。`completeInputReasons()` は B65 AST を SELECT、UNION、WITH、subquery の既存再帰経路で検出する。呼出し側が `onLimit=truncate` を指定しても実効値を `error` にし、上限到達時は `FetchAllLimitError` とする。部分入力の subtotal/total は警告付きでも返さない。

エラー subject は現行の「ORDER BY」固定 fallback を一般化し、少なくとも `GROUPING_SETS` 単独時に次を示す。

```text
小計・総計の正しい結果には完全な候補集合が必要です。
complete input reason: GROUPING_SETS。onLimit=truncateは使用できません。
```

WHERE が定数 false で Records API を呼ばない既存 EXPLAIN の早期 return 例外は B56 の契約に合わせてよいが、実行意味論上は §10.6 の空入力結果を返す。

### 10.3 B59 ORDER BY 4層

`ORDER BY GROUPING(col), 売上合計 DESC` を次の 4 層すべてで同時に成立させる。

1. **構文**: `GROUPING_KEY` または canonical synthetic key への安全な lowering を parser/AST が保持する。
2. **値**: group stage が各行へ `"0"` / `"1"` と集計 alias/合成名を materialize する。
3. **型メタ**: direct key と SELECT alias の双方へ number semantics を供給する。GROUPING を CASE label の alias と誤って string 推論しない。
4. **planner**: `buildOrderSemanticsForSelect()` と canonicalOrderPlanner が未解決キーとして拒否せず、local canonical order として計画する。

B65 は常に FULL_SCAN、REST ORDER BY 押し下げ不可であり、全 set の縦結合・HAVING・DISTINCT 後にローカル全結果ソートする。昇順なら detail/subtotal の `0` が total の `1` より前になる。集計式または alias の比較意味論は B59/B26 の既存契約を維持する。

### 10.4 SELECT DISTINCT と集計 DISTINCT

- `COUNT(DISTINCT x)` 等は set/bucket 内で独立評価する。
- 明示した重複 grouping set は標準互換で重複行として保持する。
- SELECT DISTINCT は全 set を縦結合した後に SELECT 投影規約で適用する。discriminator を投影しないため同値になった detail/total 行が畳まれることは DISTINCT の意図した効果である。

### 10.5 HAVING

GROUPING を含まない既存 HAVING は、各 set の集計行を縦結合した後、DISTINCT 前に適用する。SELECT にない直接集計を materialize しない等の既存制約は変えない。

HAVING 内 `GROUPING()` は Phase2 であり、R1 は parser/planner で明示的に拒否する。内部メタが存在することを理由に無保証で受理してはならない。

### 10.6 0 件入力と空 set

- 非空 set は入力 0 件なら 0 行を生成する。
- 空 set `()` は入力 0 件でも 1 個の仮想 bucket を生成する。`GROUPING SETS (())` は GROUP BY なし集計と同じ集計値規約を使う。ただし `allItems` が空なので、この形で `GROUPING(arg)` を書くと §6.2 により拒否される。
- B65 文では grouping clause 自体が grouped query を形成するため、空 set は SELECT に通常集計がない場合も 1 行を生成する。たとえば入力 0 件の `GROUPING SETS ((a),())` で `SELECT GROUPING(a)` は、非空 set から 0 行、空 set から値 1 の 1 行を返す。現行 `hasAggregateColumns()` gate の単純流用だけではこの形を落とすため、B65 経路で明示する。
- `COUNT(*)` は 0、既存 SUM/AVG/MIN/MAX 等と B56 統計の空集合規約は各仕様を維持する。

### 10.7 LIMIT / OFFSET / window

LIMIT/OFFSET は縦結合、HAVING、window、DISTINCT、ORDER BY の後に適用する。guard は LIMIT で最終表示行が減る場合も免除しない。生成済み中間行の爆発と、LIMIT 前の正しい順序/集合を守る必要があるためである。

既存 window 関数は通常文では HAVING 後・DISTINCT 前に作用するが、Phase1 は B65 文との併用を一律 planning error とする。grouping 後の合成列だけを参照する window の許可は Phase2 以降に、field dependency と型メタを含む別契約として追加する。

## 11. FULL_SCAN / required fields / planner

- `normalizeGroupingSpec(stmt).type === "GROUPING_SETS"` は set 数、空 set、集計列、ORDER BY にかかわらず `resolveSelectMode()` で FULL_SCAN とする。
- WHERE の EXACT_PUSHDOWN は既存どおり許可するが、取得対象全件を確定した後の group、HAVING、ORDER、LIMIT はローカルで行う。
- required-field walker は `allItems` を canonical 化前の参照として全件走査し、set ごとの重複取得はしない。JOIN 修飾を正しい table へ振り分ける。
- `GROUPING(arg)` は `arg` が `allItems` に一致することを検証する walker へ渡す。関数評価のための別物理列として二重収集しない。ただし arg の元 grouping field 自体は allItems 由来で取得対象になる。
- SELECT/CASE/HAVING/ORDER BY の walker は `GROUPING_REF` を exhaustively 処理し、default で FIELD と誤認しない。
- EXPLAIN、実行、field validation、canonical order planner は同じ normalized grouping と canonical item resolver を共有する。

## 12. guard と fail-closed

### 12.1 検査点

全 grouping-set 構文へ次の独立上限を適用する。ROLLUP は糖衣展開後、重複 set を含む数で判定する。

| guard | 検査時点 | R1 初期値案 | 超過時 |
|---|---|---:|---|
| 展開後 grouping set 数 | planning、fetch 前 | 64 | planning ArgumentError |
| canonical grouping item 数 | planning、fetch 前 | 16 | planning ArgumentError |
| 生成集計行数（全 set 合計） | runtime、HAVING/DISTINCT/LIMIT 前 | 50,000 | runtime ArgumentError |

生成行数は各 set で新 bucket を発見した時点で全 set 合計を加算し、上限 + 1 の bucket を作ろうとした時点で中止する。後段 HAVING、DISTINCT、LIMIT が減らす見込みを先取りしてはならない。例外発生前に内部で一部行を作っていても、呼出し側へ部分結果を返さない。

64 / 16 / 50,000 は R1 の安全側提案であり、R2 までに Node、Firefox plugin、Chrome plugin で benchmark して確定する。少なくとも次を測る。

- 入力 10,000 行、1/8/32/64 sets
- 1/2/4/8/16 items、低 cardinality と全行 unique
- B64 CASE 集計、COUNT DISTINCT、B56 統計を含むケース
- peak heap、group stage 経過時間、UI/MCP timeout、guard 到達時に結果が返らないこと

benchmark で値を変更しても、set/item/generated-row を別 guard とし、HAVING/DISTINCT/LIMIT 前に fail-closed とする契約は変更しない。初期値を `maxRecords` や temp table 上限へ暗黙連動させない。

### 12.2 diagnostics / EXPLAIN

reason code を安定契約として次のように分離する（最終命名は既存 error code 規約へ合わせてよい）。

- `GROUPING_SET_LIMIT_EXCEEDED`
- `GROUPING_ITEM_LIMIT_EXCEEDED`
- `GROUPING_OUTPUT_LIMIT_EXCEEDED`
- `GROUPING_ARG_NOT_IN_SPEC`
- `GROUPING_CONTEXT_UNSUPPORTED`

planning error は展開後実数と上限、runtime error は作成しようとした行数と上限を含む。SQL 全文やレコード値を不要に露出しない。

EXPLAIN は Records API を実行せず、少なくとも次を表示する。

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

EXPLAIN は実行前なので実生成行数を表示しない。明示 GROUPING SETS では source と、空 set・重複を含む展開後 set 数を表示する。

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
| B65-E22 | 65 sets / 17 unique items | 拒否 | planning guard、fetch なし |
| B65-E23 | 50,001 行目の aggregate row | 拒否 | runtime fail-closed、部分結果なし |
| B65-E24 | `SELECT ROLLUP, GROUPING, SETS, CUBE FROM APP1` | 受理 | soft keyword 互換 |
| B65-E25 | `SELECT x AS GROUPING FROM APP1 ORDER BY GROUPING` | 受理 | alias として従来どおり |
| B65-E26 | `ROLLUP(a,a)` | 受理 | 展開 set の重複を除去しない |

保守的解釈として、標準が許すより広い grouping element 合成は Phase1 で拒否する。一方、公開する構文の意味論は標準の ROLLUP prefix 展開、重複 grouping set 保持、GROUPING 0/1 に従い、独自の subtotal sentinel やラベル構文は導入しない。

## 15. テスト計画

すべて「修正前 fail → 修正後 pass」を証拠化する。parser-only green では完了とせず、engine、execute/planner、EXPLAIN、MCP smoke まで通す。

### 15.1 parser / AST

- **B65-P01**: 単一/複数列 ROLLUP の展開 snapshot。
- **B65-P02**: 明示 GROUPING SETS の空 set、複数 item、single-item 省略形、明示順、重複保持。
- **B65-P03**: SELECT、CASE 条件、direct ORDER BY の `GROUPING_REF` / `GROUPING_KEY`。
- **B65-P04**: CUBE、式 item、nested element、引数数、HAVING/WHERE GROUPING の専用拒否。
- **B65-P05**: 通常 GROUP BY AST snapshot が変更されない。
- **B65-P06**: ROLLUP/GROUPING/SETS/CUBE の field/alias soft-keyword compatibility corpus。

### 15.2 engine correctness

- **B65-C01（最重要）**: 元入力先頭行が `地域='東',会社名='A'` の `ROLLUP(地域,会社名)` で、`(地域)` 行の会社名と `()` 行の地域/会社名が必ず `""`。修正前は `{...groupRows[0]}` により `A` / `東` が残って fail、修正後 pass。
- **B65-C02**: set に残る field は bucket 値で確定上書きし、先頭行以外の bucket でも正しい。
- **B65-C03**: 実データ空セル detail (`"",0`) と total (`"",1`) が別行になる。
- **B65-C04**: `GROUPING()` は field 値でなく membership を見る。detail 空セルで 0、値がある field を除外した total で 1。
- **B65-C05**: `ROLLUP(a,b)` が detail、a subtotal、grand total を縦結合し、各集計値が正しい。
- **B65-C06**: 重複 set / `ROLLUP(a,a)` が重複行を保持し、SELECT DISTINCT のみが後段で畳む。
- **B65-C07**: 0 件で非空 set 0 行、空 set 1 行。GROUPING-only と各集計の空集合規約。
- **B65-C08**: grouping metadata が user field 名と衝突せず、project 後に漏れない。
- **B65-C09**: NUL 等を含む値でも bucket key が衝突しない。

### 15.3 B64 / B56 / DISTINCT / HAVING

- **B65-A01**: 各 set で B64 `SUM(CASE ...)` / `COUNT(CASE ...)` が独立し、grand total は filter 後全入力。
- **B65-A02**: COUNT DISTINCT と B56 数値 DISTINCT が set 間で state を共有しない。
- **B65-A03**: B56 統計の空集合、非数値 fail-closed、complete-input reason 併記。
- **B65-A04**: GROUPING を含まない HAVING が縦結合後に各行へ作用する。
- **B65-A05**: HAVING GROUPING は明示拒否する。

### 15.4 ORDER BY 4層 / planner

- **B65-O01**: `ORDER BY GROUPING(a), total DESC` が構文・値・number meta・planner の 4 層を通り total が末尾。
- **B65-O02**: direct GROUPING と `SELECT GROUPING(a) AS g ORDER BY g` が同じ順序。
- **B65-O03**: 集計 alias なしの合成名でも B59 resolver が正しい。
- **B65-O04**: B65 は `CANONICAL_LOCAL` / FULL_SCAN、REST 押し下げなし。`ORDER_KEY_UNRESOLVED` にならない。
- **B65-O05**: KORDER 併用拒否。

### 15.5 FULL_SCAN / required fields / complete input / guard

- **B65-F01**: `GROUPING SETS (())` だけでも FULL_SCAN。
- **B65-F02**: 全 set の全 field を正しい app/table から収集し、GROUPING arg を出力物理列として重複収集しない。
- **B65-F03**: `onLimit=truncate` を指定して上限到達すると `GROUPING_SETS` reason の FetchAllLimitError。部分小計を返さない。
- **B65-F04**: ORDER BY/統計なしでも完全入力 required。WITH/UNION/subquery の再帰検出。
- **B65-G01**: 64 sets / 16 items / 50,000 rows 境界は成功、各 +1 は該当 reason で失敗。
- **B65-G02**: ROLLUP 展開後、重複込みで set guard を数える。
- **B65-G03**: generated-row guard は HAVING/DISTINCT/LIMIT 前に作動し、どれが結果を減らしても免除されない。
- **B65-X01**: EXPLAIN が source、set/item/row limit、FULL_SCAN、complete-input reason、local order を表示し、Records API を呼ばない。

### 15.6 end-to-end / MCP

- **B65-M01**: §1 の看板 SQL を MCP で実行し、会社明細 + 総計、CASE ラベル、discriminator、総計末尾を確認する。
- **B65-M02**: `ROLLUP(地域,会社名)` で地域×会社明細、地域小計、総計を確認する。
- **B65-M03**: 明示 GROUPING SETS で不要な階層を省き、明示順とは無関係に ORDER BY が最終順を決める。
- **B65-M04**: MCP の `onLimit=truncate` でも fail-closed。CLI/plugin 共通 core の契約 test を通す。

完了証拠は B65 ID、修正前の失敗内容、修正後の pass、実行面、EXPLAIN、benchmark 結果を 1 対 1 で追跡できる形にする。

## 16. R2 / オーナー判断が必要な残論点

Phase1 の公開構文・意味論は本 R1 で確定し、次だけを R2 判断として残す。

1. **guard 初期値**: §12 の 64 sets / 16 items / 50,000 generated rows を Node/Firefox/Chrome benchmark 後に採用するか。3 guard 分離、検査時点、fail-closed、EXPLAIN 露出は確定であり再論点化しない。
2. **内部 AST node 配置**: `GroupingRef` を各 union へ直接追加するか集計専用 scalar node へ包むか。通常関数化しないことと 4 層契約は確定。
3. **固定 guard の将来設定面**: Phase1 後に設定可能にする場合の ExecuteOptions / CLI / MCP / plugin 配管。Phase1 の公開設定追加は行わない。

`CUBE`、式 grouping item、HAVING GROUPING、GROUPING_ID、nested element は未解決ではなく Phase2 以降の対象外項目である。

## 17. 実装規模見積り

前提は field-only、固定 guard、CLI/MCP/plugin 共通 core、テスト・EXPLAIN・互換調査・文書同期を含み、設定 UI 追加を含まない。

| 領域 | 概算 |
|---|---:|
| parser / AST / soft keyword / validation | 3〜5 人日 |
| grouping-set engine、空文字上書き、内部メタ、B64/B56 統合 | 4〜6 人日 |
| GROUPING の SELECT/CASE/ORDER BY 4層、型メタ、planner | 3〜5 人日 |
| 完全入力、guard、EXPLAIN、required fields | 2〜3 人日 |
| regression、MCP/plugin smoke、benchmark、文書同期 | 1〜2 人日 |
| **Phase1 合計** | **13〜21 人日** |

最大の不確実性は複数 set の bucket 化ではなく、`GROUPING()` を SELECT、CASE 条件、direct ORDER BY、型メタ、canonical planner へ一貫して通す統合である。次点は修飾/無修飾 field の canonical identity と browser plugin で安全な generated-row 上限である。評価文書の 13〜21 人日を維持する。

## 18. R1 判断要約

1. **R1 の要点**: field-only の明示 GROUPING SETS、単一/複数列 ROLLUP、SELECT/CASE/direct ORDER BY の GROUPING を、FULL_SCAN・完全入力・有界 fail-closed で提供する。看板 MCP クエリを第一受入とする。
2. **評価案から R1 で確定した点**: 複数列 ROLLUP を Phase1 へ含め、soft keyword、direct ORDER BY、重複 set 保持、専用 `GROUPING_SETS` complete-input reason、全構文共通 guard を採用した。最重要 hole は除外 field と合成名を空文字へ明示上書きして閉じ、grouping truth は field 値でなく衝突不能な `Set` メタに置く。
3. **残論点**: benchmark 後の guard 具体値、内部 node 配置、将来の設定面だけを R2 判断とする。CTE/temp、window、CUBE 等は Phase1 対象外であり R1 の両論ではない。
4. **実装規模**: 13〜21 人日。GROUPING の式・ORDER BY・型・planner 横断統合が最大リスクである。
