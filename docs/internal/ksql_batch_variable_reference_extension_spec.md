# バッチ変数の参照拡張 統合仕様 R2（B10 Part B + B3）

- 作成日: 2026-07-19
- 作成: codex
- ステータス: **統合仕様 R2・Claude レビュー済（承認・§14）**。判定＝設計は健全・実装着手可。要修正1点（§3.2 の parser 分岐順＝`@x || field` 退行防止・本文へ反映済み）＋軽微確認。工数 5.2〜8.2 人日は妥当。
- 対象 HEAD: `7d03094`（v3.4.0）
- 台帳: [B3 / B10](../ksql_issue_tracker.md)
- 入力: [B3 仕様 R1＋codex レビュー](ksql_array_variable_in_expansion_spec.md)・[B10 再評価](ksql_batch_variable_followon_b10_evaluation.md)・[バッチ変数 Phase 1a](ksql_batch_variables_phase1a_spec.md)

## 1. 目的

既存バッチ変数の「定義」ではなく**参照できる位置**を増やす。1 回だけ共有基盤を作り、次の順で導入する。

1. **第1部 B10-B**: スカラー変数を SELECT 定数列として参照する `SELECT @x AS c`。
2. **第2部 B3**: STRING 配列変数を定義し、カッコ無し `IN @list` / `NOT IN @list` でリテラル IN へ展開する。

共有するのは parser の参照位置、参照 visitor、validate-all-first の型検査、実行直前の AST 解決、EXPLAIN の変数環境、および新 AST variant を扱う exhaustive switch である。現行は `analyzeBatch` が全 AST を実行前検査し（[batch.ts:11-12](../../src/core/batch.ts#L11)）、各文の実行直前に `resolveVariableRefs` を通す（[execute.ts:958-960](../../src/execute.ts#L958)）。この順序を維持する。

### 1.1 利用例

```sql
SET @batch = NOW();
SELECT @batch AS バッチID, $id, 顧客名
FROM APP100;
```

```sql
SET @ranks = ['A', 'B'];
SELECT @batch AS バッチID, $id, 顧客名
FROM APP100
WHERE 顧客ランク IN @ranks;
```

### 1.2 Part A（NULL 変数代入）は対象外

`SET @x = NULL` は追加しない。現行 parser は SET/DECLARE RHS の NULL を明示拒否する（[parser.ts:290-297](../../src/parser/parser.ts#L290)）。kSQL の空値は空文字で扱う既存方針に従い、`SET @e = ''` を使う。`VarValue` に null variant を追加せず、SQL の三値論理も本仕様では導入しない。

### 1.3 B3 R1 レビュー指摘のクローズ表

| R2 必須/追補 | 本仕様の確定先 |
|---|---|
| 空配列の親 aware boolean 簡約 | §3.1 `BOOLEAN`、§5.3 |
| 親 DML の `NOT IN []` 安全契約 | §5.4（簡約後 root TRUE を拒否） |
| EXPLAIN の配列 SET 評価 | §5.5 |
| validate-all-first の array/scalar 検査 | §3.3、§6 |
| WHERE 以外の条件位置 | §5.6 |
| IN 上限/分割 | §5.7（専用上限なし・分割なし・API error） |
| `VARIABLE_IN_LIST` visitor 群（P1-7） | §3.3〜3.4 |
| 括弧分岐は IN/NOT IN 呼出し側（P2-1） | §3.2 |
| schema-aware `EXACT_PUSHDOWN` 限定（P2-3） | §7.1 |

## 2. スコープ

### 2.1 対象

- SELECT 列のスカラー変数: `SELECT @x AS alias`。文字列・数値の両方。
- 配列定義: `SET @list = ['A', 'B']` / `SET @empty = []`。
- 配列展開: すべての `WhereExpr` 位置の `field IN @list` / `field NOT IN @list`。
- 配列/スカラーの validate-all-first 型検査と実行時二重検査。
- SIMPLE / FULL_SCAN / UNION / GROUP BY / HAVING / DISTINCT / CASE・IF / DML CHECK / サブクエリ / EXPLAIN。
- 言語リファレンス、レシピ、台帳、CHANGELOG、全面回帰テスト、ビルド成果物の同期。

### 2.2 対象外

- NULL 変数代入。
- 数値要素の配列 `[1, 2]`、混在配列、配列を返すサブクエリ代入。
- `IN (@list)` での配列展開、`= ANY(@list)`、配列の通常スカラー参照。
- SELECT 列での配列値、SELECT 列の変数をさらに式の一部として使う形（例: `@x || field`）。
- LIMIT/OFFSET、識別子、GROUP BY キー、ORDER BY キーへの直接変数参照。
- IN の専用要素数上限、クエリ分割、複数 GET への IN 分割。

## 3. 共有基盤

### 3.1 AST

次の resolved 前専用ノードを追加する。

```ts
interface VariableColumn {
  type: "VARIABLE_COL";
  name: string;
  alias: string;              // AS 必須
}

interface VariableInList {
  type: "VARIABLE_IN_LIST";
  name: string;
}
```

- `VariableColumn` を `SelectColumn` に追加する。現行 `SelectColumn` は文字列リテラル列 `LiteralColumn` と数値を表せる `ArithColumn` を既に持つ（[ast.ts:194-207](../../src/types/ast.ts#L194)、[ast.ts:224-227](../../src/types/ast.ts#L224)、[ast.ts:252-256](../../src/types/ast.ts#L252)）。`VARIABLE_COL` は実行経路へ残さず、解決時にこの既存どちらかへ変換する。
- `VariableInList` を `SqlValue` に追加する。通常の `InList.values` は従来どおり STRING / NUMBER / スカラー `VariableRef` の要素列であり（[ast.ts:527-531](../../src/types/ast.ts#L527)）、`IN (@a,@b)` の意味を変えない。
- `SetVariableStatement.expr` を SET 専用 union `ScalarExpr | ArrayLiteral` に拡張する。現行は `ScalarExpr` のみ（[ast.ts:87-109](../../src/types/ast.ts#L87)）で、既存 `ArrayLiteral` は STRING 要素だけを持つ（[ast.ts:478-482](../../src/types/ast.ts#L478)）。DECLARE はスカラーのまま変更しない。
- 親 aware 簡約の resolved-only ノードとして `BooleanPredicate { type: "BOOLEAN"; value: boolean }` を `WhereExpr` に追加する。parser はこのノードを生成しない。現行 `WhereExpr` には定数条件が無く、BINARY / NULL_CHECK / LOGICAL / NOT / GROUP / EXISTS のみである（[ast.ts:369-379](../../src/types/ast.ts#L369)）ため、空 IN を安全に表現するには新しい内部表現が必要である。

### 3.2 parser の分岐

#### SELECT 列

`parseSelectColumn` で `VARIABLE` を受理し、直後に **`AS alias` を必須**として `VARIABLE_COL` を返す。**この分岐は既存の top-level `||`（CONCAT_OP）検出（[parser.ts:766](../../src/parser/parser.ts#L766)）より後に置く（Claude レビュー・退行防止）**。`SELECT @x || field AS c` は現状この CONCAT_OP 経路で `SCALAR_VALUE_COL` として動作しており（実機確認済み・§2.2 で対象外＝挙動不変）、先頭 `VARIABLE` を無条件に `VARIABLE_COL` へ倒すと壊れる。よって `VARIABLE_COL` 化は **top-level `||` を持たず、先頭 `@x` の直後が `AS`** の場合に限る（`@x + 1` 等の算術は現状も ParseError で対象外）。現行の文字列リテラル列は alias 任意（[parser.ts:834-838](../../src/parser/parser.ts#L834)）だが、変数名を出力スキーマへ漏らさず、空結果でも安定した列名を保証するため、次をエラーにする。

```sql
SELECT @batch FROM APP100;       -- ParseError: AS alias が必要
```

数値リテラル列の既存分岐は `ARITH_COL` を生成する（[parser.ts:841-848](../../src/parser/parser.ts#L841)）。したがって変数列を単一の既存リテラル列型へ無理に合わせず、解決時に値型で STRING=`LITERAL_COL`、NUMBER=`ARITH_COL` とする。

#### `IN @list`

括弧分岐は `parseInListOrSubquery` ではなく、`IN` / `NOT IN` を消費する呼出し側で行う。現行は呼出し側が直後の `(` と閉じ `)` を要求している（[parser.ts:1751-1757](../../src/parser/parser.ts#L1751)、[parser.ts:1773-1778](../../src/parser/parser.ts#L1773)）。変更後は次のとおり。

- 次が `(`: 現行の `IN (値列)` / `IN (SELECT ...)`。意味不変。
- 次が `VARIABLE`: カッコ無し専用の `VARIABLE_IN_LIST`。
- それ以外: ParseError。

`IN (@list)` は現行 `parseInValues` が作る「スカラー変数 1 要素」の `InList` のまま（[parser.ts:2005-2028](../../src/parser/parser.ts#L2005)）。配列変数をそこへ置けば静的型エラーとなる。これにより `IN (@a,@b)` と `IN @list` は AST 上も意味上も無曖昧である。

#### 配列 SET

`parseSetVariable` は `=` 後が `[` なら既存 `parseArrayLiteral`、それ以外は既存 `parseScalarExpr` を呼ぶ。既存 array parser は空配列を受理し、非空要素には STRING を要求する（[parser.ts:2229-2240](../../src/parser/parser.ts#L2229)）。したがって `[]` と `['']` は構文段階から別の配列であり、裸の数値 `[1]` は引き続き ParseError となる。

### 3.3 参照 visitor と静的型情報

現行 `collectVariableRefs`、`findVariableRef`、`resolveVariableRefs` はいずれも `type === "VARIABLE"` だけを特別扱いする（[batch.ts:143-155](../../src/core/batch.ts#L143)、[execute.ts:1198-1216](../../src/execute.ts#L1198)、[execute.ts:1221-1237](../../src/execute.ts#L1221)）。これらを同じ参照分類に基づいて更新する。

```ts
type VariableDefinitionKind = "scalar" | "array";
type VariableUseKind = "scalar" | "select-column" | "array-in-list";
type VariableUse = { name: string; kind: VariableUseKind };
```

- `collectVariableRefs` は名前の Set だけでなく使用 kind を収集する。通常 `VARIABLE` は `scalar`、`VARIABLE_COL` は `select-column`、`VARIABLE_IN_LIST` は `array-in-list`。
- `BatchVariableAnalysis` に `kind: "scalar" | "array"` を持たせる。SET RHS が `ARRAY` のときだけ array、その他の SET と全 DECLARE は scalar。
- `findVariableRef` は 3 ノードすべてを検出し、単文実行や未解決ノードを fail-loud にする。現行の単文入口はこの visitor の結果で未定義変数を拒否する（[execute.ts:596-606](../../src/execute.ts#L596)）。
- EXPLAIN の参照走査、サブクエリ走査、必須フィールド収集、CTE inline、LIKE/KLIKE visitor など、新 union を通る全 switch に case を追加する。
- switch は `assertNever` 相当で exhaustive にし、将来の参照位置追加が暗黙に無視されないことをテストする。現行でも WhereExpr の switch は converter、mode 判定、capability、評価器、EXPLAIN などに分散している（例: [whereToKintone.ts:45-53](../../src/converter/whereToKintone.ts#L45)、[selectToKintone.ts:90-100](../../src/converter/selectToKintone.ts#L90)、[whereCapability.ts:91-117](../../src/core/optimization/whereCapability.ts#L91)、[evalWhere.ts:76-93](../../src/engine/evalWhere.ts#L76)、[execute.ts:6122-6140](../../src/execute.ts#L6122)）。`BOOLEAN` を含め、全箇所をコンパイルと手組み AST テストで固定する。

### 3.4 統一解決 API

現行の「任意 object を再帰し、VARIABLE leaf を STRING/NUMBER へ一律置換」だけでは、列 node の変換と親 BINARY を見る空 IN 簡約を表現できない（[execute.ts:1198-1218](../../src/execute.ts#L1198)）。これを文脈 aware の共通 API に置き換える。

```ts
resolveBatchVariableReferences(statement, variables, mode)
  -> resolved statement
```

同 API は次の順に処理する。

1. 通常 `VARIABLE`: scalar なら型付き STRING/NUMBER、array なら型エラー。
2. `VARIABLE_COL`: scalar STRING なら alias 付き `LITERAL_COL`、scalar NUMBER なら alias 付き単一 NUMBER の `ARITH_COL`、array なら型エラー。
3. `BINARY(IN|NOT_IN, ..., VARIABLE_IN_LIST)`: array 非空なら同じ要素の `IN_LIST`、array 空なら `BOOLEAN`、scalar なら型エラー。
4. 全 WhereExpr を §5 の規則で親 aware 簡約。
5. resolved 後に `VARIABLE` / `VARIABLE_COL` / `VARIABLE_IN_LIST` が 1 個でも残れば内部エラー。

`VarValue` は現行の string / number 判別 union（[execute.ts:745-747](../../src/execute.ts#L745)）へ次を追加する。

```ts
| { type: "array"; elements: Array<{ type: "string"; value: string }> }
```

v1 の配列要素は STRING のみなので number element variant は入れない。通常のスカラー置換は現行どおり number の `raw` を保つ（[execute.ts:1205-1212](../../src/execute.ts#L1205)）。

## 4. 第1部 B10-B: SELECT 列 `@var`

### 4.1 構文と意味

```sql
SET @batch = NOW();
SELECT @batch AS バッチID, 顧客名 FROM APP100;

SET @n = 10;
SELECT @n AS 閾値, $id FROM APP100;
```

- `AS` は必須。
- scalar string は既存文字列リテラル列、scalar number は既存数値列と同じ値・表示・型メタになる。
- array 変数は `SELECT @list AS c` で静的拒否する。
- `FROM` なしも許可する。解決後は既存の FROM なしリテラル/数値列になり、現行実行は仮想 1 行を `project` して返す（[execute.ts:1732-1740](../../src/execute.ts#L1732)）。

### 4.2 射影と空結果スキーマ（B2 整合）

文字列は `project` の `LITERAL_COL` 分岐が全行へ同じ値を付与する（[process.ts:738-742](../../src/engine/process.ts#L738)）。数値は `ARITH_COL` 分岐が評価値を文字列化して付与する（[process.ts:757-761](../../src/engine/process.ts#L757)）。列メタは既存どおり文字リテラルを string、数値式を number とする（[execute.ts:2453-2457](../../src/execute.ts#L2453)）。

0 行でも `project` はワイルドカードを含まない明示列の output key を AST から先に計算する（[process.ts:703-715](../../src/engine/process.ts#L703)、[process.ts:810-865](../../src/engine/process.ts#L810)）。`VARIABLE_COL` は解決後に必ず alias 付き既存列へなるため、`SELECT @batch AS バッチID, 顧客 FROM ...` が 0 行でも columns は `バッチID, 顧客` を保持する。これを B2 の空 SELECT 列スキーマ非回帰として固定する。

### 4.3 SIMPLE / FULL_SCAN

定数列だけを理由に FULL_SCAN へしない。現行 `resolveSelectMode` は GROUP BY / DISTINCT / JOIN / 集計等を FULL_SCAN 条件にするが、`LITERAL_COL` や通常 `ARITH_COL` は条件に含めない（[selectToKintone.ts:67-83](../../src/converter/selectToKintone.ts#L67)）。また SIMPLE は REST 取得後にも必ず `project` を通る（[execute.ts:1826-1846](../../src/execute.ts#L1826)）。したがって解決後の定数列は SIMPLE のまま各行へ付与できる。

定数列自身は取得フィールドへ加えない。現行 `extractFields` も `LITERAL_COL` を無視し、`ARITH_COL` は式内フィールドだけを収集する（[selectToKintone.ts:225-244](../../src/converter/selectToKintone.ts#L225)）。

### 4.4 UNION / GROUP BY / DISTINCT

- **UNION / UNION ALL**: 各 branch を変数解決後に通常 SELECT として実行する。右 branch は左の列名へ位置対応で remap され、UNION は全列値で deduplicate する現行契約を継承する（[execute.ts:2703-2727](../../src/execute.ts#L2703)）。alias 必須により左 branch の出力名が安定する。
- **GROUP BY / 集計**: 定数列は group key に要求しない。現行は group/aggregate 後に最後に project し（[process.ts:1115-1139](../../src/engine/process.ts#L1115)）、リテラル列をその時点で付与するため、全 group へ同じ値が付く。`SELECT @batch AS b, COUNT(*) ...` も同じ規則。
- **DISTINCT**: 定数列は全行で同値なので重複判定を変えない。現行 DISTINCT は project 前に SELECT 列から key を作り（[process.ts:427-439](../../src/engine/process.ts#L427)）、定数列を key へ入れていない（[process.ts:476-494](../../src/engine/process.ts#L476)）。これは定数列について意味的に正しい。`SELECT DISTINCT @x AS c FROM APP100` は APP100 が非空なら 1 行、空なら 0 行。

## 5. 第2部 B3: 配列変数と `IN @list`

### 5.1 構文

```sql
SET @list = ['A', 'B'];
SET @empty = [];

SELECT $id FROM APP100 WHERE コード IN @list;
SELECT $id FROM APP100 WHERE コード NOT IN @list;
```

`IN (@a,@b)` はスカラー要素列、`IN @list` は配列展開である。`IN (@list)` を配列展開として扱わない。

### 5.2 非空配列

`@list = ['A','B']` の `IN @list` は文実行直前に次と同一の `InList` AST へ変換する。

```sql
IN ('A','B')
```

以後の評価、型付き IN、押し下げ、EXPLAIN はリテラル IN と同じ経路を使う。JS 評価は `InList.values` を Set にして IN / NOT IN を対称評価する（[evalWhere.ts:129-143](../../src/engine/evalWhere.ts#L129)）。未置換 VARIABLE の事前ガードも維持する（[whereToKintone.ts:230-237](../../src/converter/whereToKintone.ts#L230)）。

`['']` は要素 1 個の通常 IN であり、空配列ではない。`IN ('')` として送信・評価し、boolean 簡約しない。

### 5.3 空配列の親 aware boolean 簡約

空配列は `InList { values: [] }` を生成しない。現行 converter は values をそのまま join して `()` を返す（[whereToKintone.ts:215-227](../../src/converter/whereToKintone.ts#L215)）一方、JS 評価は空 Set により IN=false / NOT IN=true になる（[evalWhere.ts:129-143](../../src/engine/evalWhere.ts#L129)。この経路差を解消するため、親 BINARY を見て次へ変換する。

```text
field IN     @empty  -> BOOLEAN(false)
field NOT IN @empty  -> BOOLEAN(true)
```

その後、WhereExpr 全体を次の真理値規則で再帰簡約する。

| 入力 | 結果 |
|---|---|
| `NOT TRUE` / `NOT FALSE` | `FALSE` / `TRUE` |
| `TRUE AND x` / `FALSE AND x` | `x` / `FALSE` |
| `TRUE OR x` / `FALSE OR x` | `TRUE` / `x` |
| `GROUP(TRUE|FALSE)` | `TRUE|FALSE` |
| `GROUP(x)` | `GROUP(x)` |

左右を対称に処理し、簡約を固定点まで行う。例:

```text
(a = 1 AND b IN @empty)       -> FALSE
(a = 1 OR b IN @empty)        -> a = 1
NOT (b IN @empty)             -> TRUE
(a = 1 AND b NOT IN @empty)   -> a = 1
(a = 1 OR b NOT IN @empty)    -> TRUE
```

`BOOLEAN` の消費契約は次のとおり。

- SELECT / サブクエリの root WHERE `TRUE`: WHERE を null にする。
- SELECT / サブクエリの root WHERE `FALSE`: **レコード API を呼ばず空の入力集合**を既存の後段 pipeline（GROUP BY / 集計 / HAVING / DISTINCT / ORDER / LIMIT / project）へ渡す。非集計 SELECT は 0 行となり、明示列は `project([], columns)` でスキーマを返す。一方、GROUP BY なしの集計は既存契約どおり空入力から 1 行（`COUNT=0` 等）を生成する（[process.ts:231-279](../../src/engine/process.ts#L231)）。フィールドコード/型検証に必要な metadata API は省略しない。
- HAVING / CASE・IF / CHECK WHEN 内: `BOOLEAN` を保持し、`evalWhere` が値を返す。
- `whereToKintone` は `BOOLEAN` を受けたら内部エラーとする。root/局所の routing が漏れたまま kintone query へ変換しない。
- EXPLAIN は同じ解決・簡約結果を使い、root FALSE は「constant false / records API access: none」、root TRUE は「WHERE なし」、局所 BOOLEAN は簡約後の式を表示する。

これにより `AND` / `OR` / `NOT` / `GROUP` の全形で `in ()` を送らない。leaf だけを置換する旧 `resolveVariableRefs` 方式では `BINARY.op` を参照できないため採用しない。

### 5.4 恒真と更新系の安全契約

**変数解決・簡約後の target WHERE が root `TRUE` になった UPDATE / DELETE / 非 `ALL` REORDER は、API 呼出し前に `ArgumentError` とする。WHERE を削除して実行してはならない。** エラーは `NOT IN @empty` と、OR/NOT の伝播で恒真になったことを示し、明示的な安全な対象条件へ書き換えるよう案内する。

理由:

- UPDATE と DELETE は誤操作防止のため parser が WHERE を必須にしている（[parser.ts:2327-2334](../../src/parser/parser.ts#L2327)、[parser.ts:2694-2701](../../src/parser/parser.ts#L2694)）。
- REORDER も `ALL` を明示しない限り WHERE 必須である（[parser.ts:2712-2739](../../src/parser/parser.ts#L2712)）。簡約で TRUE にしてこの契約を迂回させない。
- core の `ExecuteOptions.confirm` は任意であり、DELETE も存在する場合だけ呼ぶ（[execute.ts:4648-4675](../../src/execute.ts#L4648)）。したがって `dmlMaxRows` / confirm を常時必須の安全根拠にはできない。
- VALIDATE ONLY も文の任意 suffix である（[parser.ts:2391-2420](../../src/parser/parser.ts#L2391)）。通常 DML の恒真を許可する代替ゲートにはならない。

root `FALSE` の更新系は安全な 0 件 no-op とし、書込み先/フィールドの metadata 検証は維持したうえで、対象検索・mutation API と confirm を呼ばず affectedRows=0 を返す。`x AND NOT IN @empty -> x` のように root が通常述語へ残る場合は、その述語で通常実行できる。単に `NOT IN @empty` を含むだけで一律拒否せず、**最終 root が恒真か**で判定する。

### 5.5 EXPLAIN の配列 SET

現行 batch EXPLAIN は通常 SET RHS を評価せず、後続用に文字列 `@name` placeholder を登録する（[execute.ts:5746-5750](../../src/execute.ts#L5746)、[execute.ts:5767-5770](../../src/execute.ts#L5767)）。配列でこれを続けると array/scalar 型が崩れるため、次へ変更する。

- `SET @list = [ ... ]` だけは EXPLAIN 時にも副作用なく `VarValue.array` へ評価する。ArrayLiteral は既に確定した STRING 群であり、関数・API・時刻評価を含まない（[ast.ts:478-482](../../src/types/ast.ts#L478)）。
- 空配列を含め、後続文へ実行時と同じ `resolveBatchVariableReferences` と boolean 簡約を適用する。
- scalar SET / DECLARE は従来どおり値を評価せず placeholder を使う。SELECT 定数列は alias と実行モードに影響せず、配列型判定だけは静的解析結果を使う。
- EXPLAIN 自身が恒真更新系を検出した場合も実行と同じエラーにする。危険な計画を「実行可能」と表示しない。

### 5.6 条件位置の範囲

`IN @list` は parser が `parseWhereExpr` を使う**すべての条件位置**で許可する。現行は SELECT WHERE と HAVING（[parser.ts:631-653](../../src/parser/parser.ts#L631)）、CASE / IF 条件（[parser.ts:1231-1257](../../src/parser/parser.ts#L1231)）、DML `CHECK WHEN`（[parser.ts:2373-2388](../../src/parser/parser.ts#L2373)）、UPDATE / DELETE / REORDER WHERE（[parser.ts:2334](../../src/parser/parser.ts#L2334)、[parser.ts:2701](../../src/parser/parser.ts#L2701)、[parser.ts:2739](../../src/parser/parser.ts#L2739)）で同じ入口を使う。サブクエリの SELECT も同じ `parseSelect` を再帰利用する（例: [parser.ts:1952-1963](../../src/parser/parser.ts#L1952)）。

対象:

- SELECT / CTE / UNION branch / scalar subquery / EXISTS subquery の WHERE。
- HAVING。
- SELECT 列、WHERE 左右値、INSERT/UPDATE 値の CASE WHEN / IF 条件。
- INSERT / UPSERT / UPDATE の CHECK WHEN 条件。
- UPDATE / DELETE / REORDER の対象 WHERE（§5.4 の安全契約付き）。

対象外:

- JOIN ON。現行 `JoinCondition` は左右の識別子による等値だけで `WhereExpr` ではない（[ast.ts:357-361](../../src/types/ast.ts#L357)）。
- ASSERT。ASSERT は独自の比較オペランド文法で複合 AND/OR も拒否しており（[parser.ts:584-605](../../src/parser/parser.ts#L584)）、`IN` 条件位置ではない。
- CASE の THEN / ELSE 結果としての配列変数。配列は条件の `IN @list` だけで使用できる。

### 5.7 IN の上限と分割

**B3 専用上限は設けない。IN 分割もしない。大きすぎる押し下げ query は kintone API のエラーをそのまま fail-closed で返す。**

現行 `convertInList` は全要素を 1 本の `(...)` へ無制限 join し、ローカルの要素数 guard や分割を持たない（[whereToKintone.ts:215-227](../../src/converter/whereToKintone.ts#L215)）。CLI adapter も受け取った `params.query` 全体を 1 回の GET query parameter に載せ、IN 要素を分割しない（[nodeKintoneClient.ts:157-174](../../src/cli/nodeKintoneClient.ts#L157)）。ページングで GET が複数回になっても、IN リスト自体を複数 query へ分割する機能ではない。配列展開だけ別上限にすると同じ最終 `InList` なのに literal IN と契約が分かれるため採らない。FULL_SCAN でローカル評価される場合は API の IN query 上限に触れない。

将来、literal IN 全体へ共通 guard / chunking を導入する場合は別仕様とし、`IN (...)` と `IN @list` を同時に変更する。

## 6. validate-all-first の静的 array/scalar 検査

v1 では全変数の array/scalar が実行前に確定する。

- SET RHS が `ARRAY` なら array、それ以外の SET は scalar。
- DECLARE は scalar。
- SET RHS の他変数参照は現行 parser が禁止する（[parser.ts:291-297](../../src/parser/parser.ts#L291)）。
- 同名再定義は `analyzeBatch` が禁止する（[batch.ts:242-253](../../src/core/batch.ts#L242)）。

したがって `analyzeBatch` は現在の前方参照検査（[batch.ts:225-253](../../src/core/batch.ts#L225)）と同じ pass で、**全件を 1 文も実行する前に**次を拒否する。

| 定義 kind | 参照位置 | 結果 |
|---|---|---|
| scalar | 通常 VARIABLE / SELECT `VARIABLE_COL` | 可 |
| scalar | `VARIABLE_IN_LIST` (`IN @x`) | エラー。`IN (@x)` を案内 |
| array | `VARIABLE_IN_LIST` | 可 |
| array | 通常 VARIABLE / SELECT `VARIABLE_COL` / `IN (@list)` | エラー。`IN @list` を案内 |

未定義・前方参照、再定義、64 変数上限、`referencedBy`、未使用 warning は既存契約を維持する。`BatchVariableAnalysis` の公開/内部結果には kind を追加するが、値は引き続き公開しない。

実行時 resolver にも同じ kind 検査を残す。手組み AST、EXPLAIN placeholder、将来の外部 AST producer が静的 pass を迂回しても、配列を scalar 化したり scalar を 1 要素配列へ暗黙変換したりしない。

## 7. 押し下げと実行面

### 7.1 schema-aware EXACT_PUSHDOWN のみ

非空配列の展開後は通常 `IN_LIST` だが、**常に REST へ押し下げられるとは規定しない**。現行 capability は左辺が直接 FIELD で、フィールド型がその演算子の local contract を持ち、native operator が使え、右辺が IN_LIST 等の場合だけ `EXACT_PUSHDOWN` とする（[whereCapability.ts:120-150](../../src/core/optimization/whereCapability.ts#L120)）。親 DML は `EXACT_PUSHDOWN` でなければ実行前拒否する（[execute.ts:1564-1577](../../src/execute.ts#L1564)）。

よって B3 は literal IN の schema-aware 判定をそのまま継承する。

- EXACT_PUSHDOWN: 置換後 literal IN を REST query に含める。
- LOCAL_ONLY: SELECT は FULL_SCAN / JS 評価。親 DML は既存どおり拒否。
- UNSUPPORTED: 既存どおりエラー。

空配列は §5.3 で IN_LIST より前に消えるため capability 判定へ `in ()` を渡さない。

### 7.2 面

parser / core / engine の共有変更なので CLI / MCP / プラグインで言語意味は同一である。ただし公開文言、MCP tool description、smoke assertion、ビルド済み plugin artifact は別の契約面として同期対象に含める。現行公開版は package と plugin manifest の双方が 3.4.0（[package.json:3](../../package.json#L3)、[manifest.json:3](../../prod/manifest.json#L3)）。リリース時は全 version/artifact を同じ minor へ揃える。

## 8. エラー契約

メッセージ文言は実装時に日本語/英語の既存規約へ合わせるが、少なくとも次の区別を保つ。

- `SELECT @x` → `ParseError`: SELECT 列のバッチ変数には `AS alias` が必要。
- `IN @scalar` → `ParseError`（batch analysis）: scalar 変数。`IN (@scalar)` を案内。
- 通常位置 / `IN (@array)` / SELECT 列の array → `ParseError`（batch analysis）: array 変数。`IN @array` を案内。
- 未定義 / 前方参照 → 現行の statement 番号付きエラー。
- 更新系 root TRUE → `ArgumentError`: 空配列簡約で全件対象になるため拒否。
- unresolved 参照 node が converter / evaluator へ到達 → internal/fail-loud error。
- oversized pushed IN → kintone API error。自動 truncation・分割・部分成功なし。

## 9. 受入条件

### 9.1 parser / AST

- `SELECT @x AS c` / 複数列 / FROM なしを `VARIABLE_COL` として parse。alias 無しを拒否。
- `SET @l=['A','B']` / `SET @e=[]`。`[1]` / mixed array を拒否。
- `IN @l` / `NOT IN @l` を `VARIABLE_IN_LIST`、`IN (@x)` を従来 `IN_LIST` として区別。
- literal IN / `IN (SELECT ...)` / `IN (@a,@b)` の AST 非回帰。

### 9.2 静的解析 / visitor

- scalar / array kind と全 use kind の適合表をテスト。
- SELECT 列、HAVING、CASE/IF、CHECK WHEN、各サブクエリ、UPDATE/DELETE/REORDER WHERE の未定義・前方参照・`referencedBy`。
- 実行開始前に後続文の型誤用も拒否する validate-all-first 証跡（client call 0）。
- `findVariableRef` が 3 node を検出。手組み unresolved AST を各下流へ渡すと必ず fail-loud。
- WhereExpr / SelectColumn の exhaustive switch を compile test と手組み `BOOLEAN` AST で固定。

### 9.3 B10-B

- string / number の `SELECT @x AS c` が対応する直書きリテラル列と同一 rows / columns / column meta。
- SIMPLE のまま定数列を付与し、REST query と取得 fields に定数値を混入しない。
- FULL_SCAN、FROM なし、0 行、`*` 混在で alias schema を保持。
- UNION / UNION ALL の左右、GROUP BY＋集計、DISTINCT（非空/空入力）。
- `INSERT ... SELECT @batch AS バッチID, ...` / `UPSERT ... SELECT` の source column と型メタ伝播。
- array 変数の SELECT 列使用を静的拒否。

### 9.4 B3 非空 / 型 / 押し下げ

- STRING 1 要素 / 複数要素 / `['']` の IN・NOT IN。
- SIMPLE の EXPLAIN query が直書き literal IN と一致。
- FULL_SCAN の JS 結果が直書き literal IN と一致。
- schema-aware EXACT_PUSHDOWN / LOCAL_ONLY / UNSUPPORTED の分岐非回帰。
- 選択系フィールドの定義外値は既存 literal IN の経路差（押し下げ時 API error、local 時 0 件）をそのまま継承。

### 9.5 空配列簡約

- root `IN @empty`=空入力・records API call 0（非集計は0行、非 GROUP 集計は既存の空集合結果。metadata 検証は維持）、root `NOT IN @empty`=WHERE 無しの通常 SELECT。
- §5.3 表の AND / OR 左右、NOT 多重、GROUP 多重、複合固定点。
- `[]` と `['']` の明確な非同値。
- CASE/IF branch、HAVING、CHECK WHEN、nested subquery WHERE。
- EXPLAIN と実行の簡約結果一致。全ケースで query text に `in ()` / `not in ()` が無い。
- UPDATE / DELETE / REORDER root TRUE は metadata/read/write API call 0 でエラー。
- 更新系 root FALSE は metadata 検証後に records/mutation API call 0、affectedRows=0。`x AND NOT IN @empty -> x` は x の通常安全判定へ進む。
- VALIDATE ONLY / ON ERROR SKIP / confirm の有無で root TRUE 拒否が変わらない。

### 9.6 全面非回帰と公開面

- parser / core batch / executeBatch / converter / evalWhere / EXPLAIN / DML validation / CTE / UNION の全テスト。
- CLI / MCP / plugin build、既存 batch-variable smoke、plugin browser smoke。
- `IN (@a,@b)`、負数 IN、typed IN、IN subquery、LIKE/KLIKE pushdown、空 SELECT schema、DML WHERE 必須、REORDER ALL の非回帰。
- 言語リファレンスのバッチ変数・IN・SELECT 列・空配列・DML 安全注意を同期。
- レシピへ「バッチ由来ラベル」例を追加。
- 台帳 B3/B10 を本統合仕様へ付け替え、CHANGELOG Added、MCP description / smoke string、version / manifest / artifact をリリース時に同期。

## 10. 実装順と工数

実装は第1部を先行させるが、共有 AST / visitor / resolver の API は第2部まで見越して最初に確定する。

| 工程 | 内容 | 目安 |
|---|---|---:|
| 共有 AST / parser / visitor | 3 参照 kind、SET array RHS、静的 kind、exhaustive switch | 1.0〜1.5 人日 |
| 第1部 B10-B | `VARIABLE_COL` 解決、SIMPLE/FULL_SCAN、schema/meta、UNION/GROUP/DISTINCT | 0.8〜1.3 人日 |
| 第2部 B3 基本 | array VarValue、`VARIABLE_IN_LIST`、非空展開、型二重検査 | 0.8〜1.2 人日 |
| 空配列 / DML 安全 | BOOLEAN、親 aware 固定点簡約、root short-circuit、更新系恒真拒否 | 1.2〜2.0 人日 |
| EXPLAIN / 全条件位置 | array SET 環境、同一簡約、CASE/HAVING/CHECK/subquery | 0.6〜1.0 人日 |
| 公開面 / 全面回帰 / build | reference、recipe、tracker、CHANGELOG、MCP、artifact、smoke | 0.8〜1.2 人日 |
| **合計** | 共有分を重複計上しない統合見積り | **5.2〜8.2 人日** |

B3 R1 単独の 3.5〜6.5 人日に、B10-B と統合・公開面を加えた見積りである。最大リスクは parser ではなく、resolved-only `BOOLEAN` を既存の全 WhereExpr consumer へ漏れなく通す作業である。

## 11. リリース

既存 SQL の意味を変えず、以前 ParseError だった参照位置を受理する純加法なので **SemVer minor** とする。現行 3.4.0（[package.json:3](../../package.json#L3)）から実際の次 minor 番号はリリース計画時に決める。実装コミットと同時に番号を先取りせず、release commit で package-lock、plugin manifest、配布 artifact を同期する。

第1部と第2部は同一 minor へバンドルする。ただし実装順・レビュー順は共有基盤 → B10-B → B3 → 公開面/回帰とし、第1部のテストが独立して読める状態を保つ。

## 12. 未解決点

**実装着手を止める未解決の設計判断はない。** 本 R2 では次を確定した。

- SELECT 変数列は AS 必須。
- string / number は既存列 AST へ型別に解決。
- 空配列は resolved-only BOOLEAN と親 aware 固定点簡約。
- 更新系で最終 root TRUE は安全上エラー、root FALSE は API なし 0 件。
- EXPLAIN は array literal SET のみ実値評価し、実行と同じ展開・簡約。
- 全 WhereExpr 位置を対象、JOIN ON / ASSERT 等は対象外。
- B3 専用 IN 上限・分割なし。literal IN と同じ API 依存。
- 押し下げは schema-aware EXACT_PUSHDOWN のみ。

後続候補（本仕様外）は、数値/混在配列、サブクエリ配列代入、literal IN 全体の共通 guard/chunking、SELECT 列での変数を含む一般式である。

## 13. Claude レビュー用の要確認ポイント

1. resolved-only `BOOLEAN` を WhereExpr に加える方針と、root short-circuit / 局所 eval の境界に漏れがないか。
2. UPDATE / DELETE / REORDER は「`NOT IN @empty` を含むだけ」ではなく「親 aware 簡約後の root が TRUE」で拒否する契約が十分に安全で、`x AND NOT IN @empty -> x` を許可してよいか。
3. SELECT scalar variable を STRING=`LITERAL_COL`、NUMBER=`ARITH_COL` へ落とすことで、rows / columns / materialized column meta / INSERT・UPSERT SELECT が既存リテラル列と完全一致するか。
4. DISTINCT が定数列を key に含めない現行実装を継承する判断と、`SELECT DISTINCT @x AS c` の非空=1行・空=0行契約が妥当か。
5. EXPLAIN は array literal SET だけ実値評価し、scalar SET は placeholder のままにする境界が副作用なし・型検査一致を満たすか。
6. `IN @list` を全 WhereExpr 位置へ開放し、JOIN ON / ASSERT / CASE result / GROUP BY 等を対象外とした一覧に抜けがないか。
7. 専用上限・IN 分割を追加せず、最終 literal IN と同じ API error 契約を採る判断を受容できるか。
8. 5.2〜8.2 人日の見積りに、全 exhaustive switch、公開文書、MCP/CLI/plugin 回帰、build artifact が十分含まれているか。

---

## 14. Claude レビュー結果（2026-07-19・コード裏取り済み）

**判定＝承認・実装着手可**。基本設計（`VARIABLE_COL`→既存 `LITERAL_COL`/`ARITH_COL` 変換、空配列→`BOOLEAN`＋親aware固定点簡約、更新系は簡約後 root TRUE で拒否）は健全で、B10 評価レビューの P1（親列ノード/型メタ）と B3 R1 の R2 6点をいずれも解消している。要修正は 1 点（本文へ反映済み）。

### 裏取りで正確だった点
- `SelectColumn` に `LITERAL_COL`/`ARITH_COL` が存在し、列メタは **`ARITH_COL`→number・`LITERAL_COL`→string**（[execute.ts:2454-2455](../../src/execute.ts#L2454)）。→ NUMBER 変数を `ARITH_COL`、STRING を `LITERAL_COL` へ落とす §3.4 は、型メタを既存機構で正しく保つ（`SCALAR_VALUE_COL` の一律 string を回避）。B10 評価 P1-3 を解消。
- `WhereExpr` union に定数ノードが無い（BinaryExpr/NullCheckExpr/LogicalExpr/NotExpr/GroupExpr/ExistsExpr のみ・[ast.ts:373-379](../../src/types/ast.ts#L373)）。→ 空 IN を安全表現する `BOOLEAN` 新設は妥当。空 InList は converter が `()` を出し（[whereToKintone.ts:215](../../src/converter/whereToKintone.ts#L215)）JS 評価は false/true になる経路差も確認済みで、親aware簡約が正しい対処。
- UPDATE/DELETE は WHERE 必須（[parser.ts:2327/2694](../../src/parser/parser.ts#L2327)）・REORDER は非 ALL で WHERE 必須。→ §5.4 の「簡約後 root TRUE を拒否・`x AND NOT IN @empty → x` は許可」は安全基準として正しい（`NOT IN @empty` を含むだけで拒否しないのが妥当）。
- `IN @scalar`/`IN (@array)` を静的型エラー、`IN (@a,@b)` は不変（[parser.ts:2005](../../src/parser/parser.ts#L2005)）。無曖昧。

### P1（要修正・本文へ反映済み）
- **§3.2 の parser 分岐順で `@x || field` が退行し得る**。`SELECT @x || field AS c` は現状 top-level `||` 検出（[parser.ts:766](../../src/parser/parser.ts#L766)）で `SCALAR_VALUE_COL` として動作する（実機: `@b || 'Y'`→`XY`）。先頭 `VARIABLE` を無条件に `VARIABLE_COL`（AS 必須）へ倒すと壊れる。→ **`VARIABLE_COL` 分岐は 766 行の CONCAT_OP 検出より後に置き、top-level `||` を持たず直後が `AS` の場合に限る**と明記（§3.2 修正済み）。非回帰テストに `SELECT @x || 'Y' AS c`（SCALAR_VALUE_COL 維持）と `SELECT @x AS c`（新 VARIABLE_COL）を追加。`@x + 1` は現状も ParseError で対象外（挙動不変）。

### P2（軽微）
- §4.4 DISTINCT「定数列を key に入れない」は多列でも正しい（定数は重複判定を変えない）。現状維持で可。
- §3.4 で NUMBER 変数を「単一 NUMBER の `ARITH_COL`」へ落とすのは、既存の数値リテラル列（`123 AS n`・実機動作）と同一ノードなので rows/columns/meta/INSERT・UPSERT SELECT が一致（構造的に保証）。

### codex 8 確認ポイントへの回答
1. `BOOLEAN` の root/局所境界＝健全。最大リスクは全 WhereExpr consumer への漏れなき配線で、§3.3 の exhaustive switch 固定が正しい対処。
2. 「root TRUE で拒否／`x AND NOT IN @empty → x` 許可」＝安全で妥当。
3. `LITERAL_COL`/`ARITH_COL` 変換で既存リテラル列と一致＝裏取り済み（列メタ）。ただし §3.2 の分岐順（P1）が前提。
4. DISTINCT 定数非 key・非空=1/空=0＝妥当。
5. EXPLAIN で array literal SET のみ実値評価・scalar は placeholder＝副作用なし（ArrayLiteral は STRING 確定）で妥当。
6. WhereExpr 位置一覧＝網羅的。JOIN ON（等値のみ）/ASSERT（独自文法）/CASE result/GROUP BY 除外は正しい。追加漏れなし。
7. IN 専用上限・分割なし＝literal IN と同契約で一貫・受容可。
8. 5.2〜8.2 人日＝妥当（BOOLEAN 配線・静的型・EXPLAIN・全条件位置・公開面/回帰/build を含む）。

### 実装着手条件
§3.2 の分岐順（反映済み）を守り、共有基盤→B10-B→B3→公開面/回帰の順で進める。`@x || field` 退行テストと exhaustive switch テストを必須とする。
