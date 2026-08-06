# B148 集計されていない列参照を標準 SQL に合わせてエラーにする 仕様（R3）

- ステータス: ✅ **実装済み（v3.57.0）**（2026-08-07）→ [実装報告](ksql_b148_codex_impl_report.md)。
  **§8 は実装後に改訂**（完成 SQL は単純な direct APP 列に限る＝§8.4bis／違反箇所の呼び名＝§8.4ter）

- ステータス: **R3 正本**
- 対象: kSQL v3.56.3
- 起票: [B148](ksql_b148_bare_column_group_by_issue.md)
- 破棄した前版: R1 / R2
- 方針決定: **標準 SQL に合わせ、警告ではなく `ArgumentError` にする**
- 互換性: **破壊的変更を許容する**
- 移行先: **`MIN(<列・式>)` または `GROUP BY` への追加**
- `ANY_VALUE()` は新設しない
- 関連: [B147](ksql_b147_aggregate_alias_shadows_key_input_issue.md)（別の欠陥・§13）

---

## 0. R3 の位置づけ

現行 kSQL は、ordinary `GROUP BY` および `GROUP BY` なし集計で、集計もグループ化もされていない列を黙ってグループ先頭行から返す。

```sql
SELECT 製品名, 個数, SUM(個数) AS 合計
FROM APP4228
GROUP BY 製品名
```

`個数` は集計値でも grouping key でもないが、エラーにならずグループ先頭行の値が返る。

一方、`ROLLUP` / `CUBE` / `GROUPING SETS` では、B65 の既存検査により同じ依存違反が既に拒否される。

したがって本件は、新しい規則を別系統で追加するものではない。

> **B65 の句依存検査を共通層として分離し、ordinary `GROUP BY` と `GROUP BY` なし集計へ、ordinary 固有の grouping identity を使って適用する。**

R3 では、共通処理と ordinary / B65 の policy を3層に分離する。受入条件は公開結果で定義し、内部関数名やファイル構成は要求しない。

---

## 1. 根拠と確定範囲

### 1.1 コードから静的に確定していること

| 事実 | 根拠 |
|---|---|
| ordinary / grouping sets / grouping なしは正規化済みの別種として区別される | `src/core/grouping.ts:71-100` |
| 現行 B65 の依存検査は `GROUPING_SETS` 以外では実行されない | `src/core/groupingValidation.ts:241-257` |
| B65 では grouping item と非集計依存の双方を物理フィールドに限定している | `src/core/groupingValidation.ts:151-179,259-270` |
| B65 の句依存検査、`GROUPING()`、wildcard、set/item 制限、alias collision が同じ処理に混在している | `src/core/groupingValidation.ts:190-233,277-322` |
| plain plan は `PHYSICAL` / `ALIAS_SAFE` / `EXPRESSION` 等へ解決する | `src/core/optimization/plainGroupByPlan.ts:11-29,177-247` |
| plain `GROUP BY` は物理フィールドを優先し、存在しない場合だけ SELECT alias へ fallback する | `src/core/optimization/plainGroupByPlan.ts:177-229` |
| `ALIAS_SAFE` になり得る SELECT 式はフィールド、リテラル、算術、`CASE`、関数、scalar value、scalar subquery を含む | `src/core/optimization/plainGroupByPlan.ts:60-81` |
| ordinary `GROUP BY` が直接受理するキーはフィールド、算術式、関数式である | `src/types/ast.ts:731-735` |
| SELECT 式は `CASE`、scalar value、scalar subquery等、ordinary `GROUP BY` の直接構文より広い | `src/types/ast.ts:224-239,346-415` |
| 集計関数とウィンドウ関数の同一 SELECT 併用は parser が拒否する | `src/parser/parser.ts:1202-1206` |
| window-only query は通常集計として扱われない | `src/engine/process.ts:239-247` |
| GROUP BY なし SELECT 集計は空の grouping key 集合で1グループになる | `src/engine/process.ts:284-291,1952-1978` |
| CTE は宣言順に実行・実体化され、その後に最終 query が実行される | `src/execute.ts:5182-5207` |
| 実体化済み CTE を使う SELECT には、その CTE の columns を渡せる実行経路がある | `src/execute.ts:5263-5297` |
| 現行 statement preflight は AST を再帰走査するが、未実体化 CTE の schema を渡さない | `src/execute.ts:3111-3131,3134-3139` |
| 現行 EXPLAIN は未実体化 source を含む plain `GROUP BY` の plan 構築をスキップする | `src/execute.ts:9897-9908` |
| `UPDATE ... FROM` は `SelectStatement` ではなく専用 relation source を持つ | `src/types/ast.ts:1027-1045` |
| `ksql_validate` は parse と batch の静的解析を行い、kintone API を呼ばない契約である | `src/mcp/tools.ts:514-524`, `src/mcp/index.ts:139-147` |
| 言語リファレンスは plain `GROUP BY` のフィールド・式・SELECT alias を公開契約としている | `docs/ksql_language_reference.md:1420-1437` |
| 拡張 grouping の grouping item は物理フィールド限定である | `docs/ksql_language_reference.md:1439-1446` |
| 集計とウィンドウの同一 SELECT 併用は公開契約上も未対応である | `docs/ksql_language_reference.md:1943-1945` |

### 1.2 実測で確定していること

v3.56.3・APP4228 について、依頼文およびレビューの実測結果を正とする。

- ordinary `GROUP BY` の `SELECT` / `HAVING` / `ORDER BY` の非集計依存は素通りする
- `GROUP BY` なし集計でも先頭行の列値が返る
- 拡張 grouping では同じ依存が `B65_NON_GROUPED_DEPENDENCY` で拒否される
- 拡張 grouping の wildcard は拒否される
- JOIN 修飾名および CTE 内の違反も拡張 grouping では拒否される
- `DATE_FORMAT(...) AS 年月 ... GROUP BY 年月` は動作する
- `CASE ... AS 区分 ... GROUP BY 区分` は動作する
- `YEAR(日付) + 1 ... GROUP BY YEAR(日付)` は動作する
- `SUM(個数) OVER ()` は window-only query として動作する
- `GROUP BY ROLLUP(日付)` に対する `DATE_FORMAT(日付,...)` は動作する
- 集計とウィンドウの同一 SELECT 併用は `ParseError`
- `GROUP BY CASE ... END` は `ParseError`

---

## 2. 規則

### 2.1 適用される query block

次のいずれかを満たす `SelectStatement` を、本仕様の「集計 query block」とする。

1. ordinary `GROUP BY` がある
2. `ROLLUP` / `CUBE` / `GROUPING SETS` がある
3. SELECT 句に通常の集計関数がある

`GROUP BY` がなく SELECT 句に集計関数がある場合、grouping identity 集合は空であり、入力全体を1グループとして扱う。

`SUM(x) OVER (...)` 等のウィンドウ関数は、通常集計関数には数えない。

### 2.2 許可される依存

集計 query block の `SELECT` / `HAVING` / `ORDER BY` に現れる参照は、次のいずれかでなければならない。

1. **grouping identity と一致するフィールドまたは式**
2. **grouping expression と一致する部分木だけに依存する式**
3. **集計関数の引数内部にある参照**
4. `HAVING` / `ORDER BY` の既存 alias 解決規則により、許可済みの出力式または集計結果へ解決される参照
5. 列参照を持たないリテラルまたは確定済み変数

どれにも該当しない非集計依存は `ArgumentError` とする。

### 2.3 例

```sql
SELECT 製品名, SUM(個数) AS 合計
FROM APP4228
GROUP BY 製品名
```

`製品名` は grouping identity なので許可する。

```sql
SELECT 個数 + 1 AS 加算, SUM(個数) AS 合計
FROM APP4228
GROUP BY 個数
```

`個数 + 1` の唯一の列依存が grouping identity `個数` なので許可する。

```sql
SELECT YEAR(日付) + 1 AS 翌年, SUM(個数) AS 合計
FROM APP4228
GROUP BY YEAR(日付)
```

`YEAR(日付)` と一致する部分木を semantic leaf として扱うため許可する。`日付` 単体が grouping field である必要はない。

```sql
SELECT 製品名, 個数, SUM(個数) AS 合計
FROM APP4228
GROUP BY 製品名
```

SELECT の `個数` は grouping identity へ依存せず、集計内部でもないためエラーにする。

```sql
SELECT 製品名, 個数, SUM(個数) AS 合計
FROM APP4228
```

grouping identity 集合が空であるため、`製品名` と `個数` はエラーにする。

### 2.4 wildcard

集計 query block の `SELECT *`、`alias.*`、`_p.*` は、展開先に非 grouping 列を含み得るためエラーにする。

Phase 1 では、wildcard の展開結果が偶然すべて grouping identity である場合の例外を設けない。必要列を明示させる。

### 2.5 集計内部

集計関数ノードに到達した時点で、外側 query block の依存走査を停止する。

```sql
SELECT 製品名,
       SUM(CASE WHEN 個数 > 100 THEN 個数 ELSE 0 END) AS 大口合計
FROM APP4228
GROUP BY 製品名
```

`個数` は集計関数の引数内部なので許可する。

集計関数内部にサブクエリがある場合、サブクエリ自身は別 query block として独立に検査する。

### 2.6 サブクエリ境界

スカラーサブクエリ、`IN (SELECT ...)`、`EXISTS (SELECT ...)` の内側へ、外側 query block の grouping identity を持ち込まない。

- 外側の依存収集ではサブクエリノードを葉として扱う
- 内側の `SelectStatement` は独立した grouping identity を構築して検査する
- 相関参照の新しい意味論は本 Phase では導入しない

### 2.7 first error

複数の違反を一度に収集せず、安定した first error を返す。

query block 内の順序は次で固定する。

1. SELECT 列を記述順に走査
2. 各式を構文上の左から右へ深さ優先で走査
3. HAVING
4. ORDER BY の項目順

wildcard は、その wildcard が置かれた SELECT 列位置の違反として扱う。

別 query block 間では、§6 の検査時点と実行順に従う。direct APP の同一 preflight 内では、CTE 宣言順、UNION 左 arm、UNION 右 arm、構文上のサブクエリ出現順、最終 query の順で安定させる。

---

## 3. 3層の責務分担

実装は次の責務を分離する。具体的な内部関数名、ファイル名、クラス名は受入条件にしない。

### 3.1 共通層

ordinary と B65 の双方で共有する。

- 集計 query block の判定
- SELECT / HAVING / ORDER BY の依存収集
- 集計関数内部での走査停止
- grouping expression と一致する部分木での走査停止
- サブクエリ境界
- `WINDOW_COL` の除外
- wildcard の検出
- alias 解決後の式への依存検査
- first error の順序
- 人間向けエラー本文の生成
- machine reason の付与

### 3.2 ordinary policy

ordinary `GROUP BY` および `GROUP BY` なし集計を担当する。

- plain plan の解決結果から `PHYSICAL` / `ALIAS_SAFE` / `EXPRESSION` identity を構築する
- ordinary `GROUP BY` の「物理フィールド優先、存在しない場合だけ SELECT alias」の規則を維持する
- JOIN、CTE、一時テーブル、システム列、サブテーブル列を source identity 付きで解決する
- `GROUP BY` なし集計には空の identity 集合を与える
- §4 の canonical expression identity を使用する

### 3.3 B65 policy

拡張 grouping 固有の規則を担当する。

- grouping item の物理 APP フィールド限定
- `GROUPING()` 引数の grouping item membership
- grouping set/item 数の制限
- aggregate alias と grouping runtime key の衝突検査
- B65 固有の `KORDER BY` 等の制限
- 拡張 grouping の既存実行 identity

ordinary の `ALIAS_SAFE` / `EXPRESSION` を、拡張 grouping の grouping item として許可してはならない。

---

## 4. grouping identity

### 4.1 plain plan からの構築

| plain plan の解決種別 | grouping identity |
|---|---|
| `PHYSICAL` | `(sourceIndex, fieldCode)` |
| `ALIAS_SAFE` | 対象 `columnIndex` の SELECT 式から作った canonical structure key |
| `EXPRESSION` | 対応する `GroupByKey` の式から作った canonical structure key |
| `ALIAS_REJECT` | 既存の alias 不許可エラー |
| `UNKNOWN` | 既存の不存在列エラー |
| `DEFERRED` | schema-aware 段階まで保留し、実行前に確定させる |

`PHYSICAL` の identity に表示名や runtime row keyだけを使ってはならない。JOIN の左右に同名列が存在しても、`sourceIndex` が異なれば別 identity である。

### 4.2 SELECT 式の参照解決

**SELECT 式の内部に現れる列参照を、同じ SELECT 句の alias へ fallback させてはならない。**

```sql
SELECT DATE_FORMAT(日付, '%Y-%m') AS 年月,
       年月 + 1 AS 翌月,
       SUM(個数) AS 合計
FROM APP148A
GROUP BY 年月
```

2列目の `年月` は、1列目の SELECT alias を参照するものとして扱わない。source schema に物理 `年月` があればその列、なければ通常の不存在参照である。

「物理フィールド優先、SELECT alias fallback」は `GROUP BY` token の解決規則に限る。

HAVING / ORDER BY は、それぞれの既存 alias 解決規則を維持する。ただし alias 名だけを見て無条件に許可せず、解決先の SELECT 式が集計済みまたは grouping identity に依存していることを確認する。

### 4.3 canonical structure key の対象ノード

canonical key は B148 専用の保守的な構造キーとする。

| 対象 | canonical 化 |
|---|---|
| `FIELD` / `FIELD_REF` / `AGG_GROUP_KEY` | 解決済み `(sourceIndex, fieldCode)` に統一 |
| `STRING` | 文字列値をそのまま使用 |
| `NUMBER` | 数値の意味値を使用し、`raw` は使用しない |
| `VARIABLE` | batch で値解決済みなら解決後の literal。未解決なら AST-only では一致を断定しない |
| `ARITH` / `SCALAR_ARITH` | 共通の算術ノードとして、演算子・左辺・右辺を順序付きで再帰 |
| `CONCAT_OP` | 左辺・右辺を順序付きで再帰。`CONCAT()` との代数的同一視はしない |
| `STRING_FUNC` | parser 正規化後の関数名と引数列を順序付きで再帰 |
| `CASE_WHEN` | branch 順を保ち、各 condition / result と ELSE を再帰 |
| `BINARY` | parser 上の比較演算子、左辺、右辺を順序付きで再帰 |
| `NULL_CHECK` | 対象式と `not` を再帰 |
| `LOGICAL` | `AND` / `OR`、左辺、右辺を順序付きで再帰 |
| `NOT` | 子条件を再帰 |
| `GROUP` | 括弧 wrapper 自体は identity に含めず、内側を再帰 |
| `BOOLEAN` | boolean 値 |
| scalar subquery alias | 外側では対象 SELECT 列に結び付いた不透明な query-block identity。内側 SELECT の列依存は別検査 |

次は canonical identity に含めない。

- `ARITH_COL` / `STRFUNC_COL` / `SCALAR_VALUE_COL` / `CASE_COL` / `SCALAR_SUBQUERY_COL` 等の SELECT 表現 wrapper
- `ARITH_KEY` / `FUNC_KEY` 等の `GroupByKey` wrapper
- `FUNC_FIELD` / `ARITH_FIELD` / `CASE_FIELD` / `ARITH_VALUE` 等、同じ意味式を句へ格納するための wrapper
- alias の表示用情報
- SQL 上の空白
- キーワードの大小
- parser が正規化する関数別名
-数値リテラルの `raw`
- ソース位置等の表示・診断用情報

AST 型は `src/types/ast.ts:224-239,346-440,479-603,636-657,1065-1111,1145-1175` に分かれているため、対象型を一部だけ扱ってはならない。

### 4.4 semantic leaf

各非集計式を走査するときは、子へ降りる前に、その部分木の canonical key を grouping identity 集合と比較する。

一致した場合、その部分木全体を **semantic leaf** として許可し、内部の列参照へ降りない。

```sql
SELECT YEAR(日付) + 1 AS 翌年, SUM(個数) AS 合計
FROM APP4228
GROUP BY YEAR(日付)
```

`YEAR(日付)` の部分木で走査を停止する。

一方、次は `MONTH(日付)` が grouping expression と一致しないためエラーにする。

```sql
SELECT YEAR(日付) + MONTH(日付) AS 年月値, SUM(個数) AS 合計
FROM APP4228
GROUP BY YEAR(日付)
```

### 4.5 認めない同値性

次の代数的・評価結果上の同値性は認めない。

- `a + b` と `b + a`
- `a + 0` と `a`
- 定数畳み込み
- `CAST` の省略
- `CONCAT(a,b)` と `a || b`
- 日付・文字列型を根拠にした暗黙変換
- 異なる scalar subquery の結果が偶然同じであること

canonical key を確定できない場合は不一致として扱う。ただし、公開契約済みの `ALIAS_SAFE` 種別を単に未実装という理由で拒否してはならない。

---

## 5. ウィンドウ関数

### 5.1 window-only query

次は集計 query block にしない。

```sql
SELECT SUM(個数) OVER () AS 総計
FROM APP4228
```

`WINDOW_COL` の引数、`PARTITION BY`、window 内 `ORDER BY` は、B148 の依存走査対象外とする。

### 5.2 通常集計との併用

通常集計または `GROUP BY` とウィンドウ関数を同じ SELECT に置く形は、従来どおり parser の `ParseError` とする。

```sql
SELECT 製品名,
       SUM(個数) AS 合計,
       ROW_NUMBER() OVER (ORDER BY 製品名) AS 順位
FROM APP4228
GROUP BY 製品名
```

期待結果:

```text
ParseError: ウィンドウ関数は GROUP BY / 集計関数と同じ SELECT では使用できません
```

B148 の `ArgumentError` へ変更してはならない。

集約結果へウィンドウ関数を適用する場合は、CTEまたは一時テーブルで SELECT scope を分ける。

---

## 6. 適用単位と検査時点

### 6.1 独立して検査する単位

AST 内の各 `SelectStatement` を独立した query block として扱う。

| 対象 | 扱い |
|---|---|
| `WITH` の各 CTE 本体 | 各 CTE を独立検査 |
| `WITH` の最終 query | 独立検査 |
| `UNION` / `UNION ALL` | 各 arm を独立検査 |
| scalar subquery | 内側を独立検査 |
| `IN (SELECT ...)` | 内側を独立検査 |
| `EXISTS (SELECT ...)` | 内側を独立検査 |
| `CREATE TEMP TABLE ... AS SELECT` | source SELECT を独立検査 |
| `INSERT INTO ... SELECT` | source SELECT を独立検査 |
| `UPSERT INTO ... SELECT` | source SELECT を独立検査 |
| `UPDATE ... FROM` | 対象外 |

### 6.2 direct APP query block

source schema が direct APP metadataだけで確定する query block は、statement preflight で検査する。

同一 statement の direct APP query block、UNION arm、サブクエリについて、違反を確定してから最初の records API を呼ぶ。

フォーム定義等の metadata API 呼び出しは許可する。

### 6.3 CTE

CTE は宣言順に扱う。

- 各 CTE 本体は、その CTE の実行直前に検査する
- 先行 CTE の output schema が必要なら、実体化済み columns を使用する
- 違反 CTE 自身の source records API は呼ばない
- 後続 CTE または最終 query が違反する場合、先行 CTE の取得済み records API は許容する
- 違反 query block に属する direct APP sourceの records API は `0` 回とする

### 6.4 一時テーブル

`CREATE TEMP TABLE ... AS SELECT` の source は、source query block の実行直前に検査する。

既存一時テーブルを読む query block は、その一時テーブルの保存済み columns を schema として使用する。違反 block の実行に起因する records API または DML API は呼ばない。

### 6.5 records API 0 の定義

「レコード取得前」は、**違反 query block 自身**について定義する。

> 違反を送出する query block の sourceを取得するための records API 呼び出し回数が `0` であること。

statement 全体の records API 回数が常に `0` であることは要求しない。先行 CTE が正常に実行済みで、その schema を使って後続 block の違反を判定する場合、先行 CTE の呼び出しは許容する。

direct APPだけからなる単一 SELECT、または同時に preflight できる UNION / subquery では、statement 全体の records API 回数も `0` とする。

### 6.6 EXPLAIN

EXPLAIN はレコード行を実体化せず、metadataと relation output schemaから schema-aware なB148判定を行う。

- direct APP はフォーム定義を使用する
- CTE / 一時テーブルは AST、既知の source schema、SELECT output columnsから relation schema を伝播する
- UNION は各 arm の output columns を推論する
- `SELECT *` は source schema が確定していれば展開する
- output schema を安全に確定できない場合、B148検査を黙って省略したり推測したりせず、schemaを確定できない旨の `ArgumentError` とする

EXPLAIN は records API および mutation API を呼ばない。

---

## 7. `ksql_validate` の二段階契約

### 7.1 AST-only 段階

`ksql_validate` は従来どおり kintone API を呼ばない。

ASTだけで確定できるB148違反は検出する。例:

```sql
SELECT 製品名, SUM(個数) AS 合計
FROM APP4228
```

grouping identity 集合が空であるため、`製品名` はschemaに依存せず違反と判断できる。

次はASTだけでは最終判断しない。

```sql
SELECT DATE_FORMAT(日付, '%Y-%m') AS 年月,
       SUM(個数) AS 合計
FROM APP148A
GROUP BY 年月
```

`APP148A` に物理フィールド `年月` があるかどうかで `GROUP BY 年月` の解決先が変わるためである。

AST-onlyで確定できない場合、`ksql_validate` の成功は「構文・静的検査を通過した」ことだけを意味し、schema-aware な実行可否を保証しない。

### 7.2 schema-aware 段階

`ksql_explain` と通常実行は、フォーム定義、JOIN source、CTE / 一時テーブル columnsを使って最終判断する。

違反時は次を揃える。

- エラー種別: `ArgumentError`
- machine reason: `B65_NON_GROUPED_DEPENDENCY`
- 句
- 違反式
- 最初の非 grouping 依存
- query block / source の識別情報

AST-only と schema-aware の人間向け全文一致は要求しない。metadataから分かるアプリ名、source alias、解決済みの修正案はschema-aware側だけに含めてよい。

---

## 8. エラー契約

### 8.1 machine reason

ordinary と拡張 grouping の非集計依存には、既存の machine reasonを維持する。

```text
B65_NON_GROUPED_DEPENDENCY
```

reason 名に `B65` が残ることは後方互換のため許容する。

human-readable message と machine reason は分離する。文字列transportでreasonを末尾に付ける場合も、本文とは別segmentとして扱う。

### 8.2 human-readable message

人間向け本文には次を含める。

- 問題の句: `SELECT` / `HAVING` / `ORDER BY`
- 違反式
- 最初の非 grouping 依存
- sourceまたはアプリ
- なぜ値が決まらないか
- 現在の `GROUP BY`、または `GROUP BY` がないこと
- 実行可能と確認できる移行案

人間向け本文に次を出してはならない。

- `B65`
- `Phase1`
- 「フィールドが存在しない」と誤読させる表現
- parserが受理しない `GROUP BY CASE ... END` 等
- schema上alias衝突するため実行できない修正例
- **集計の別名を、同じ query block が参照する物理フィールド名と衝突させる形**
  （実行はできるが [B147](ksql_b147_aggregate_alias_shadows_key_input_issue.md) を踏む。→ §8.3 の注記）

### 8.3 単純列の骨子

```text
ArgumentError: SELECT 式「個数」は集計もグループ化もされていません
（APP4228、非グループ化依存: 個数）。
GROUP BY 製品名の各グループでは、どの行の個数を返すか決まりません。
  グループごとに1つの値を選ぶなら:
    SELECT 製品名, MIN(個数) AS 最小個数, SUM(個数) AS 合計
    FROM APP4228 GROUP BY 製品名
  個数ごとに行を分けるなら:
    SELECT 製品名, 個数, SUM(個数) AS 合計
    FROM APP4228 GROUP BY 製品名, 個数
(reason=B65_NON_GROUPED_DEPENDENCY)
```

### 8.4 `GROUP BY` なしの骨子

```text
ArgumentError: SELECT 式「個数」は集計もグループ化もされていません
（APP4228、非グループ化依存: 個数）。
GROUP BY がないため入力全体が1グループになり、どの行の個数を返すか決まりません。
  全体から1つの値を選ぶなら:
    SELECT MIN(個数) AS 最小個数, SUM(個数) AS 合計 FROM APP4228
  個数ごとに行を分けるなら:
    SELECT 個数, SUM(個数) AS 合計 FROM APP4228 GROUP BY 個数
(reason=B65_NON_GROUPED_DEPENDENCY)
```

### 8.4bis **完成 SQL を示す範囲**（2026-08-06・実装後に改訂）

**完成した移行 SQL を示すのは、単純な direct APP の列参照に限る。**
**それ以外（複合式・`HAVING` / `ORDER BY`・JOIN・CTE・一時テーブル）は、
安全な修正「方針」だけを示し、完成 SQL を組み立てない。**

**理由＝汎用の AST→SQL serializer が無い。**
**推測で SQL を組み立てると、`GROUP BY CASE ... END`（parser が受理しない）や
alias 衝突（[B147](ksql_b147_aggregate_alias_shadows_key_input_issue.md)）を再導入する。**
**それはまさに「従うと壊れる助言」の作り方**であり、
[B140](ksql_b140_cte_groupby_total_order_issue.md) / [B145](ksql_b145_describe_subtable_field_issue.md) で 3 回やっている。

**黙って危険な例を出すより、方針だけ示すほうがよい。**

> **§8.5〜§8.8 の完成 SQL は「あるべき形」の説明であって、
> すべての surface で生成することを要求するものではない。**
> **serializer を入れるなら別 Phase**（入れる価値があるかは、
> **方針だけの案内で利用者が直せているか**を観測してから決める）。

### 8.4ter **違反箇所の呼び名**（2026-08-06・実装後に追加）

**「式」とだけ書かない。** 列の多い `SELECT` で、どれを直せばよいか分からなくなる。

**優先順**

| 順 | 呼び名 | 例 |
|---|---|---|
| 1 | **列名**（素の列） | `個数 AS 数` → **「個数」** |
| 2 | **別名**（計算列） | `DATE_FORMAT(...) AS 月` → **「月」** |
| 3 | **関数名** | `DATE_FORMAT(...)`（別名なし） → **「DATE_FORMAT(...)」** |
| 4 | 「式」 | 上のいずれでも呼べないとき |

**素の列で別名より列名を優先する**のは、
**具体的な書き換え例が「呼び名＝依存名」のときだけ出る**ため。ここを別名にすると例が消える。

**`GROUP BY` の表示も同じ規則**（`GROUP BY DATE_FORMAT(...)`）。

> **実装当初は算術式が別名、関数式が「式」と割れていた。**
> **同じ「別名付きの計算列」で呼び名が変わるのは、実測しないと気づかない。**

### 8.5 複合式

直接 `GROUP BY` に書ける算術式・関数式では、式全体を提示する。

```sql
SELECT DATE_FORMAT(日付, '%m') AS 月, SUM(個数) AS 合計
FROM APP4228
GROUP BY DATE_FORMAT(日付, '%Y')
```

移行案:

```sql
SELECT MIN(DATE_FORMAT(日付, '%m')) AS 月, SUM(個数) AS 合計
FROM APP4228
GROUP BY DATE_FORMAT(日付, '%Y')
```

または:

```sql
SELECT DATE_FORMAT(日付, '%m') AS 月, SUM(個数) AS 合計
FROM APP4228
GROUP BY DATE_FORMAT(日付, '%Y'), DATE_FORMAT(日付, '%m')
```

### 8.6 `CASE` / concat / scalar value

ordinary `GROUP BY` に直接書けない式は、直接式を `GROUP BY` へ追加する案を出さない。

既存aliasがschema-awareに安全なら、alias経由の完全なSQLを示す。

```sql
SELECT CASE WHEN 個数 > 100 THEN '大' ELSE '小' END AS 区分,
       SUM(個数) AS 合計
FROM APP4228
GROUP BY 製品名, 区分
```

aliasがない、重複している、または物理同名フィールドへ解決される場合は、そのaliasを使う案を出さない。

新しいaliasを案内する場合は、source schemaおよびSELECT出力aliasと衝突しない名前を選び、完成SQLを再parseできることを保証する。

**`GROUP BY` へ列を足す案では、足した列を射影しない完成SQLを示さない。**
示す場合は、足した列も `SELECT` に含めるか、**同じ値の行が並ぶ**旨を 1 行添える
（`GROUP BY 製品名, 区分` に対し `区分` だけを射影すると「大」が何行も並び、利用者には壊れた表に見える。実測）。

### 8.7 scalar subquery

scalar subqueryを `MIN((SELECT ...))` として案内してはならない。

scalar subquery aliasが安全にgroupingできる場合だけ、alias経由の完全なSQLを示す。

```sql
SELECT (SELECT MAX(日付) FROM APP4228) AS 最終日,
       SUM(個数) AS 合計
FROM APP4228
GROUP BY 最終日
```

安全なaliasを確定できないsurfaceでは、実行不能な具体例を出さず、schema-awareなEXPLAINまたは実行で最終案内する。

### 8.8 HAVING / ORDER BY

HAVING / ORDER BY の単純な列を `MIN()` へ移行させる場合、現行契約上必要な集計出力をSELECTへ追加し、そのaliasを句から参照する完成形を示す。

```sql
SELECT 製品名,
       SUM(個数) AS 合計,
       MIN(個数) AS 最小個数
FROM APP4228
GROUP BY 製品名
HAVING 最小個数 > 0
```

```sql
SELECT 製品名,
       SUM(個数) AS 合計,
       MIN(個数) AS 最小個数
FROM APP4228
GROUP BY 製品名
ORDER BY 最小個数
```

または、意味を確認した上で対象列を `GROUP BY` へ追加する完成形を示す。

---

## 9. 受入条件

### 9.1 観測方法

受入は内部関数の存在や呼び出しを条件にしない。

次の公開結果で判定する。

- 正常系: `SelectResult.rows` / `columns` / `rowCount` / `warnings`
- 異常系: 外へ送出される `ArgumentError` または既存 `ParseError`
- `ksql_validate`: 公開 `ValidationResult`
- 取得時点: mock client のrecords API呼び出し回数
- DML source: mutation API呼び出し回数も `0`

### 9.2 fixture

APP4228 は実測済みの次の物理項目を持つ。

- `製品名`
- `個数`
- `日付`
- `入出庫区分`

adversarial test 用に次のmock schemaを用意する。

| fixture | schema |
|---|---|
| APP148A | `日付`, `年月`, `個数` |
| APP148B | `分類`, `金額` |
| APP148S$明細 | 子列 `商品コード`, `数量`、親列を1個以上 |
| APP148T | DML target: `製品名`, `個数`, `合計` |

### 9.3 通り続けるもの

次は `SelectResult` を返し、B148エラーにならない。

```sql
SELECT 製品名, SUM(個数) AS 合計
FROM APP4228
GROUP BY 製品名
```

```sql
SELECT DATE_FORMAT(日付, '%Y-%m') AS 年月, SUM(個数) AS 出庫数
FROM APP4228
GROUP BY 年月
```

実測済みの13行の月次結果を維持する。

```sql
SELECT DATE_FORMAT(日付, '%Y-%m'), SUM(個数) AS 出庫数
FROM APP4228
GROUP BY DATE_FORMAT(日付, '%Y-%m')
```

```sql
SELECT CASE WHEN 個数 > 100 THEN '大' ELSE '小' END AS 区分,
       SUM(個数) AS 合計
FROM APP4228
GROUP BY 区分
```

実測済みの値を維持する。

| 区分 | 合計 |
|---|---:|
| 大 | 48425 |
| 小 | 37013 |

```sql
SELECT YEAR(日付) + 1 AS 翌年, SUM(個数) AS 合計
FROM APP4228
GROUP BY YEAR(日付)
```

`翌年` は2026 / 2027となり、実測済みの集計値を維持する。

```sql
SELECT YEAR(t.日付) + 1 AS 翌年, SUM(t.個数) AS 合計
FROM APP4228 t
GROUP BY YEAR(日付)
```

修飾／非修飾が同じsourceへ一意解決されるため成功する。

```sql
SELECT 個数 + 1 AS 加算, SUM(個数) AS 合計
FROM APP4228
GROUP BY 個数
```

```sql
SELECT SUM(個数) AS 合計
FROM APP4228
```

```sql
SELECT 製品名, 個数
FROM APP4228
```

```sql
SELECT SUM(個数) OVER () AS 総計
FROM APP4228
```

window-only queryとして実測済みの3行を維持する。

```sql
SELECT 製品名, SUM(個数) AS 合計
FROM APP4228
GROUP BY ROLLUP(製品名)
```

```sql
SELECT DATE_FORMAT(日付, '%Y-%m') AS 年月, SUM(個数) AS 合計
FROM APP4228
GROUP BY ROLLUP(日付)
```

```sql
SELECT 製品名,
       SUM(CASE WHEN 個数 > 100 THEN 個数 ELSE 0 END) AS 大口合計
FROM APP4228
GROUP BY 製品名
```

```sql
SELECT '全体' AS 区分, SUM(個数) AS 合計
FROM APP4228
GROUP BY 区分
```

```sql
SELECT 製品名 AS 商品, SUM(個数) AS 合計
FROM APP4228
GROUP BY 商品
```

```sql
SELECT 製品名 || '-' || 入出庫区分 AS 商品区分,
       SUM(個数) AS 合計
FROM APP4228
GROUP BY 商品区分
```

```sql
SELECT (SELECT MAX(日付) FROM APP4228) AS 最終日,
       SUM(個数) AS 合計
FROM APP4228
GROUP BY 最終日
```

```sql
WITH agg AS (
  SELECT 製品名, SUM(個数) AS 合計
  FROM APP4228
  GROUP BY 製品名
)
SELECT 製品名,
       合計,
       ROW_NUMBER() OVER (ORDER BY 合計 DESC) AS 順位
FROM agg
```

最後のSQLは、集計とウィンドウを別query blockへ分けているため成功する。

すべての正常系について、B148導入前から通っていたSQLは `rows`、`columns`、`rowCount`、行順、warningsを変更しない。

### 9.4 エラーになるもの

次は `ArgumentError`、reason=`B65_NON_GROUPED_DEPENDENCY` とする。

```sql
SELECT 製品名, 個数, SUM(個数) AS 合計
FROM APP4228
GROUP BY 製品名
```

最初の違反は `SELECT` の `個数`。

```sql
SELECT 製品名, 個数, SUM(個数) AS 合計
FROM APP4228
```

```sql
SELECT 製品名, SUM(個数) AS 合計
FROM APP4228
GROUP BY 製品名
HAVING 個数 > 0
```

```sql
SELECT 製品名, SUM(個数) AS 合計
FROM APP4228
GROUP BY 製品名
ORDER BY 個数
```

```sql
SELECT *, SUM(個数) AS 合計
FROM APP4228
GROUP BY 製品名
```

```sql
SELECT DATE_FORMAT(日付, '%m') AS 月, SUM(個数) AS 合計
FROM APP4228
GROUP BY DATE_FORMAT(日付, '%Y')
```

```sql
SELECT YEAR(日付) + MONTH(日付) AS 年月値, SUM(個数) AS 合計
FROM APP4228
GROUP BY YEAR(日付)
```

```sql
SELECT _p.*, SUM(数量) AS 合計
FROM APP148S$明細
GROUP BY 商品コード
```

### 9.5 aliasと物理フィールドの衝突

APP148A に物理フィールド `年月` がある状態で、次はエラーにする。

```sql
SELECT DATE_FORMAT(日付, '%Y-%m') AS 年月,
       SUM(個数) AS 合計
FROM APP148A
GROUP BY 年月
```

`GROUP BY 年月` は物理 `年月` を取る。SELECT式の `日付` はgrouping identityではないため、違反依存 `日付` を名指しする。

### 9.6 JOIN

次は右sourceの `r.個数` が非grouping依存なのでエラーにする。

```sql
SELECT l.製品名, r.個数, SUM(l.個数) AS 合計
FROM APP4228 l
INNER JOIN APP4228 r ON l.製品名 = r.製品名
GROUP BY l.製品名
```

次は非修飾 `個数` が両sourceに存在するため、既存の曖昧参照 `ArgumentError` とする。B148が任意のsourceへ結び付けてはならない。

```sql
SELECT 個数, SUM(l.個数) AS 合計
FROM APP4228 l
INNER JOIN APP4228 r ON l.製品名 = r.製品名
GROUP BY l.製品名
```

次は左右のsource identityが異なるためエラーにする。

```sql
SELECT r.製品名, SUM(l.個数) AS 合計
FROM APP4228 l
INNER JOIN APP4228 r ON l.製品名 = r.製品名
GROUP BY l.製品名
```

### 9.7 サブクエリ

内側query blockの違反としてエラーにする。

```sql
SELECT (SELECT 製品名
        FROM APP4228
        GROUP BY 日付) AS 内側値,
       SUM(個数) AS 合計
FROM APP4228
```

outer SELECTのgrouping identityを内側へ引き継いではならない。

### 9.8 UNION

右armの違反を、左右どちらのrecords APIも呼ぶ前に検出する。

```sql
SELECT 製品名, MIN(個数) AS 最小個数, SUM(個数) AS 合計
FROM APP4228
GROUP BY 製品名
UNION ALL
SELECT 製品名, 個数, SUM(個数) AS 合計
FROM APP4228
GROUP BY 製品名
```

期待:

- `ArgumentError`
- reason=`B65_NON_GROUPED_DEPENDENCY`
- 違反箇所は右armの `個数`
- APP4228のrecords APIはstatement全体で `0` 回

### 9.9 CTEとAPI呼び出し境界

最初のCTEが違反する場合:

```sql
WITH bad AS (
  SELECT 製品名, 個数, SUM(個数) AS 合計
  FROM APP4228
  GROUP BY 製品名
)
SELECT * FROM bad
```

期待:

- `ArgumentError`
- APP4228のrecords APIは `0` 回

先行CTEは正常、後続CTEが違反する場合:

```sql
WITH ok AS (
  SELECT 製品名 FROM APP4228
),
bad AS (
  SELECT 分類, 金額, SUM(金額) AS 合計
  FROM APP148B
  GROUP BY 分類
)
SELECT * FROM ok
```

期待:

- `ok` の実体化に必要なAPP4228 records APIは許容
- APP148Bのrecords APIは `0` 回
- `bad` の `金額` を名指しする `ArgumentError`

最終queryが違反する場合:

```sql
WITH base AS (
  SELECT 製品名, 個数 FROM APP4228
)
SELECT 製品名, 個数, SUM(個数) AS 合計
FROM base
GROUP BY 製品名
```

期待:

- `base` の実体化は許容
- `base` 実体化後、追加のrecords APIを呼ばずに最終queryの `個数` を拒否

### 9.10 一時テーブル

```sql
CREATE TEMP TABLE #base AS
SELECT 製品名, 個数 FROM APP4228;

SELECT 製品名, 個数, SUM(個数) AS 合計
FROM #base
GROUP BY 製品名;
```

期待:

- 一時テーブル作成のrecords APIは許容
- 2文目は保存済みcolumnsを使って検査
- 2文目に起因するrecords API追加なし
- `個数` を名指しする `ArgumentError`

source自身が違反する場合:

```sql
CREATE TEMP TABLE #bad AS
SELECT 製品名, 個数, SUM(個数) AS 合計
FROM APP4228
GROUP BY 製品名;
```

APP4228のrecords APIは `0` 回。

### 9.11 INSERT / UPSERT SELECT

```sql
INSERT INTO APP148T (製品名, 個数, 合計)
SELECT 製品名, 個数, SUM(個数) AS 合計
FROM APP4228
GROUP BY 製品名
```

```sql
UPSERT INTO APP148T (製品名, 個数, 合計)
SELECT 製品名, 個数, SUM(個数) AS 合計
FROM APP4228
GROUP BY 製品名
ON DUPLICATE (製品名)
```

期待:

- source SELECT の `個数` を名指しする `ArgumentError`
- APP4228 records APIは `0` 回
- APP148Tへのmutation APIは `0` 回

### 9.12 first error

```sql
SELECT 個数, 日付, SUM(個数) AS 合計
FROM APP4228
GROUP BY 製品名
```

`日付` ではなく、最初のSELECT列である `個数` を報告する。

```sql
SELECT 製品名, SUM(個数) AS 合計
FROM APP4228
GROUP BY 製品名
HAVING 日付 > '2025-01-01'
ORDER BY 個数
```

HAVINGの `日付` を先に報告する。

### 9.13 `ksql_validate`

ASTだけで確定する違反:

```sql
SELECT 製品名, SUM(個数) AS 合計
FROM APP4228
```

期待:

- `ksql_validate` が `ArgumentError`
- reason=`B65_NON_GROUPED_DEPENDENCY`
- kintone API呼び出し `0`

schema依存:

```sql
SELECT DATE_FORMAT(日付, '%Y-%m') AS 年月,
       SUM(個数) AS 合計
FROM APP148A
GROUP BY 年月
```

期待:

- `ksql_validate` は構文・静的検査として成功してよい
- 成功結果はschema-awareな実行可否を保証しない
- `ksql_explain` と通常実行は、物理 `年月` を確認して `日付` の違反を返す
- records APIは `0` 回

### 9.14 EXPLAIN

```sql
EXPLAIN
WITH base AS (
  SELECT 製品名, 個数 FROM APP4228
)
SELECT 製品名, 個数, SUM(個数) AS 合計
FROM base
GROUP BY 製品名
```

期待:

- CTE output schemaを行取得なしで推論
- 最終queryの `個数` を名指しする `ArgumentError`
- records API `0`
- mutation API `0`

### 9.15 ウィンドウ回帰

次はB148ではなく既存 `ParseError`。

```sql
SELECT 製品名,
       SUM(個数) AS 合計,
       ROW_NUMBER() OVER (ORDER BY 製品名) AS 順位
FROM APP4228
GROUP BY 製品名
```

次は成功。

```sql
WITH agg AS (
  SELECT 製品名, SUM(個数) AS 合計
  FROM APP4228
  GROUP BY 製品名
)
SELECT 製品名,
       合計,
       ROW_NUMBER() OVER (ORDER BY 合計 DESC) AS 順位
FROM agg
```

---

## 10. エラー文に示す修正例の受入

実装がエラー文へ表示するすべての具体的な修正SQLについて、次を受入条件とする。

1. 同じparserで再parseできる
2. 元のfixture schemaでalias解決に成功する
3. B148エラーにならない
4. read-only SQLは実行して `SelectResult` を返す
5. DML例は `VALIDATE ONLY` またはmock clientでsource実行まで確認できる
6. `GROUP BY CASE ... END` のような現行grammar非対応形を表示しない
7. 物理フィールドと衝突するaliasを表示しない
8. scalar subqueryを未対応の集計引数構文へ埋め込まない

単なる文字列包含テストではなく、表示されたSQL自体をparse・実行する受入とする。

---

## 11. 拡張 grouping の回帰

本仕様の共通層抽出後も、次を維持する。

- grouping item は物理APPフィールド限定
- `GROUPING()` 引数は grouping item membershipとして検査
- grouping set/item 制限
- aggregate alias collision
- JOIN修飾名のsource identity
- wildcard拒否
- first error
- reason=`B65_NON_GROUPED_DEPENDENCY`
- `ROLLUP(日付)` に依存する `DATE_FORMAT(日付,...)` の成功

人間向け本文からは `B65` / `Phase1` を除く。

次の現行内部文面は公開文面として残さない。

```text
B65 non-aggregate field ...
B65 wildcard projection is not supported in Phase1.
```

---

## 12. Phase 1 の線引き

### 12.1 入れないもの

| 対象外 | 理由 |
|---|---|
| 関数従属の推論 | kintone schemaだけでは一般の関数従属を証明できない |
| `$id` / レコード番号等の一意キーによる他列許可 | 候補キー伝播を含む別設計が必要 |
| `ANY_VALUE()` | `MIN()` / `MAX()` で移行でき、新関数は不要 |
| 代数的式同値性 | 偽陰性を作り、静かな誤結果を再導入する |
| `GROUP BY CASE ... END` のgrammar追加 | B148の依存検査とは別の言語拡張 |
| 拡張 groupingへのalias・式item追加 | B65の物理限定契約を変更する別機能 |
| 集計とウィンドウの同一SELECT解禁 | 名前空間と評価順を新設する別機能 |
| `UPDATE ... FROM` | `SelectStatement` を持たない別AST |
| 全違反の一括収集 | first error契約を採用する |
| wildcardの条件付き許可 | 展開と全identity証明が必要で、列明示で移行できる |
| B147の修正 | 別名shadowingによる投影上書きであり別の欠陥 |

### 12.2 後から広げる場合

関数従属、候補キー、wildcardの安全展開等を後から許可する変更は、従来エラーだったSQLを成功させる非破壊方向とする。

Phase 1で推測による例外を設けない。

---

## 13. B147との関係

B147は本仕様では直らない。

B147は、集計aliasが別のSELECT式の入力フィールド名と衝突し、投影値を上書きする欠陥である。B148は、非集計・非grouping依存を先頭行から返す欠陥である。

共通する原則は次だけである。

> SELECT式の内部参照を、同じSELECT句のaliasへfallbackさせない。

B147の修正をB148の受入に混ぜない。

---

## 14. 文書・リリース

実装時は少なくとも次を更新対象とする。

- `docs/ksql_language_reference.md` §8
- CHANGELOG / release history
- 保存クエリ・プラグイン利用者向け移行案内
- MCPの `ksql_validate` / `ksql_explain` 契約説明
- ordinary / 拡張 grouping双方のエラー例
- plugin bundleおよび配布物

言語リファレンス §8には次を明記する。

1. 集計queryでは非集計列はgrouping identityに依存しなければならない
2. `GROUP BY` なし集計は入力全体を1グループとする
3. 違反はレコード取得前の `ArgumentError`
4. 移行は `MIN(<列・式>)` または `GROUP BY` への追加
5. `ANY_VALUE()` はない
6. `ksql_validate` はAST-only、EXPLAIN / 実行はschema-aware
7. 集計とウィンドウは同じSELECTでは併用できず、CTE等で分ける

---

## 15. 破壊的変更

次のSQLは、v3.56.3では成功していたが、B148導入後はエラーになる。

```sql
SELECT 製品名, 個数, SUM(個数) AS 合計
FROM APP4228
GROUP BY 製品名
```

```sql
SELECT 製品名, 個数, SUM(個数) AS 合計
FROM APP4228
```

```sql
SELECT 製品名, SUM(個数) AS 合計
FROM APP4228
GROUP BY 製品名
HAVING 個数 > 0
```

これは、意味の定まらない先頭行の値を返していた挙動を停止するための意図した破壊的変更である。

- 依頼元資産に該当SQLがないことは確認済み
- 掲載SQLに該当がないことは確認済み
- 保存クエリ・プラグイン利用者は事前調査できない
- そのため、エラー文とリリースノートを唯一の移行案内として完成させる

---

## 16. Claudeが実測すべき未確認事項

以下はコード読解だけでは全surfaceの実際の結果まで確定できない。実装前後にClaudeが実測する。

### 16.1 全 `ALIAS_SAFE` 種別

次が実際に動作し、B148導入後も同じ値を返すこと。

- フィールドalias
- リテラルalias
- 算術式alias
- `CASE` alias
- 文字列・日付関数alias
- `||` 連結等のscalar value alias
- scalar subquery alias
- batch変数解決後のalias

特に次を実測する。

```sql
SELECT (SELECT MAX(日付) FROM APP4228) AS 最終日,
       SUM(個数) AS 合計
FROM APP4228
GROUP BY 最終日
```

```sql
SELECT 製品名 || '-' || 入出庫区分 AS 商品区分,
       SUM(個数) AS 合計
FROM APP4228
GROUP BY 商品区分
```

### 16.2 canonical表記

- `1` と `1.0`
- parserが正規化する関数別名
- 修飾／非修飾が同じsourceへ一意解決される形
- 余分な括弧
- legacy算術ASTとscalar算術AST
- `CASE` conditionのwrapper
- grouping expressionを部分木として使う形

特に次の実測済み結果が維持されることを再確認する。

```sql
SELECT YEAR(日付) + 1 AS 翌年, SUM(個数) AS 合計
FROM APP4228
GROUP BY YEAR(日付)
```

### 16.3 CTE / 一時テーブルのAPI順

次を別々に測る。

1. 最初のCTE本体が違反
2. 先行CTEは正常、後続CTEが違反
3. CTE本体は正常、最終queryが違反
4. CTE / 一時テーブルとdirect APPをJOINした最終query
5. UNIONの片armだけが違反
6. scalar subqueryだけが違反
7. 単一CTEインライン化候補が違反

statement全体のrecords API countと、違反query blockに起因するcountを分けて記録する。

### 16.4 EXPLAINのrelation schema

行取得なしで次のoutput columnsを確定できること。

- 明示列
- alias
- direct APPの `SELECT *`
- CTEの `SELECT *`
- 一時テーブル
- UNION
- SHOW / DESCRIBE由来のCTE
- 0行source

確定できない場合のfail-closedエラーが、B148を黙って省略する挙動になっていないことも確認する。

### 16.5 エラー文の修正SQL

次の各surfaceで、表示された修正SQLをそのまま再parse・実行し、成功すること。

**あわせて、表示された修正SQLが次のどちらにもなっていないこと。**
- 集計の別名が、同じ query block の参照する物理フィールド名と衝突する形（[B147](ksql_b147_aggregate_alias_shadows_key_input_issue.md)）
- `GROUP BY` へ足した列を射影せず、同じ値の行が並ぶ形


- `GROUP BY` あり
- `GROUP BY` なし
- HAVING
- ORDER BY
- JOIN
- CTE
- 一時テーブル
- サブテーブル
- `CASE`
- concat / scalar expression
- scalar subquery
- aliasと物理フィールドの衝突

### 16.6 拡張 grouping

共通層分離後に次が変わらないこと。

- `GROUPING()` membership
- set/item上限
- aggregate alias collision
- wildcard
- JOIN修飾名
- first error
- `ROLLUP(日付)` に対するキー依存式
- machine reason

### 16.7 全surfaceの表示

次で同じ違反箇所とmachine reasonが得られること。

- library実行
- CLI
- `ksql_validate`
- `ksql_explain`
- MCP query
- MCP mutateのSELECT source
- plugin通常実行
- plugin EXPLAIN

plugin bundle更新後、エラーがrecords APIより前に表示されることをブラウザ実測する。

### 16.8 回帰

- window-only queryがB148対象にならない
- 集計＋window同一SELECTが従来どおり `ParseError`
- CTEで段を分けた集計＋windowが成功する
- 通るSQLの `rows` / `columns` / `rowCount` / 行順 / warningsが変わらない
- 表示された移行SQLが、全surfaceで実際に動作する


---

## 17. Claude レビュー（2026-08-06・実測つき）

**結論＝実装着手可。指摘 2 件（中 1 / 低 1）。いずれも §8 の移行案の書き方で、規則本体に問題は無い。**

**作成は codex、レビューは Claude。** 直近 10 件と役割が逆である。

### 17.1 実測で確かめたこと（**問題なし**）

**§8 の移行案は、示された形がそのまま動く。**
**「従うと壊れる助言」を 3 回出しているので、ここを最優先で見た。**

| 節 | 示された SQL | 実測 |
|---|---|---|
| §8.3 | `SELECT 製品名, MIN(個数) AS 個数, SUM(個数) AS 合計 … GROUP BY 製品名` | **動く**（食パン 30 / 23429） |
| §8.6 | `SELECT CASE … AS 区分, SUM(個数) AS 合計 … GROUP BY 製品名, 区分` | **動く** |
| §8.7 | `SELECT (SELECT MAX(日付) …) AS 最終日, SUM(個数) … GROUP BY 最終日` | **動く**（2026-08-04 / 85438） |
| §8.8 | `… MIN(個数) AS 最小個数 … HAVING 最小個数 > 0` | **動く** |

**§2.1 の「集計 query block」の条件に穴が無いことも確かめた。**

```
SELECT 製品名 FROM APP4228 ORDER BY COUNT(*)
  → ParseError: フィールド名またはテーブル名が必要です（トークン:「COUNT」）
```

**`ORDER BY` にだけ集計がある形は構文として存在しない**ので、
**「`SELECT` 句に集計関数があるか `GROUP BY` があるか」で過不足ない。**

### 17.2 【中】§8.3 の移行案が、B147 を引き起こす形を教えている

**§8.3 は `MIN(個数) AS 個数` を示す。** **集計の別名を物理フィールド名と衝突させる形**である。

**実測では動く**（他の SELECT 列が `個数` を参照していないため）。
**しかし [B147](ksql_b147_aggregate_alias_shadows_key_input_issue.md) はまさにこの形で起きる**——
**同じ SELECT の別の列が、上書きされたフィールドを式で参照していると、その列が静かに空になる。**

```
SELECT DATE_FORMAT(日付,'%Y-%m') AS 年月, SUM(個数) AS 合計 → 年月 = "2025-08"
SELECT DATE_FORMAT(日付,'%Y-%m') AS 年月, SUM(個数) AS 日付 → 年月 = ""      （実測）
```

**§8.8 は同じ状況で `MIN(個数) AS 最小個数` と衝突しない名前を使っている。同じ仕様の中で不整合。**

**さらに §8.2 は「schema 上 alias 衝突するため実行できない修正例」を禁止しているが、
本件は「実行できるが、別の欠陥を踏む形」なので、その禁止に掛からない。**

**対応（R3 の修正案）**

1. **§8.3 の別名を `最小個数` 等、物理フィールドと衝突しない名前へ変える**（§8.8 と揃う）
2. **§8.2 の禁止リストへ 1 行足す**＝
   **「集計の別名を、同じ query block が参照する物理フィールド名と衝突させる形を案内しない」**
3. **§16.5 の受入に「表示された修正 SQL が B147 の形になっていないこと」を足す**

**理由**＝**エラー文は保存クエリ・プラグイン利用者にとって唯一の案内**（§15）であり、
**そこで別の静かな欠陥へ誘導するのは、B140／B145 で 3 回やった「従うと壊れる助言」の変種**である。

### 17.3 【低】§8.6 の完成 SQL は、動くが結果が壊れて見える

```
SELECT CASE WHEN 個数 > 100 THEN '大' ELSE '小' END AS 区分, SUM(個数) AS 合計
FROM APP4228 GROUP BY 製品名, 区分
  → 大 12059 / 大 19518 / 大 2766 …（「大」が何行も並ぶ）
```

**助言としては正しい**（元の `GROUP BY 製品名` に `区分` を足す最小の修正）。
**しかし `製品名` を射影していないので、利用者には「同じ区分が何行も出る壊れた表」に見える。**

**§10 の受入は「再 parse・実行して成功すること」までしか要求していない。**
**「動く」と「意味のある結果を返す」は別**で、[v3.56.2](ksql_b145_describe_subtable_field_issue.md) で
**「読んでも自分の話だと分からない助言」**を直したときと同じ論点である。

**対応（R3 の修正案）**＝**例に `製品名` も射影する**か、
**「`GROUP BY` に足した列は射影しないと同じ値の行が並ぶ」旨を 1 行添える。**

### 17.4 良かった点（R4 で消さないこと）

- **§8.2 が `GROUP BY CASE ... END` を明示的に禁止**している。
  **R2 はここで「従うと壊れる助言」を 4 度目に出すところだった**
- **§4.3 の canonical 対象ノードが AST 型を横断して列挙されている**。
  **`ALIAS_SAFE` はリテラル・`CASE`・scalar subquery まで広い**ので、
  **一部だけ扱うと契約済みの正当なクエリを偽陽性で落とす**
- **§4.4 の semantic leaf**（grouping 式と一致する部分木で走査を止める）。
  **`YEAR(日付) + 1 … GROUP BY YEAR(日付)` を通すのに必須**
- **§12.1 が「入れないもの」を理由つきで 11 件挙げている**。
  **Phase の線引きが後から揺れない**
- **§16 が「Claude が実測すべきこと」を 8 群で具体的に列挙**している。
  **codex が実行できないことを断定していない**
- **§9 が公開結果（`SelectResult` / `ArgumentError` / records API 呼び出し回数）で観測する形**になっており、
  **内部関数名を受入条件にしていない**（過去 3 件はこれで実装者を誤らせた）
- **§13 が B147 との混同を明示的に禁止**している

### 17.5 総評

**R1 は「名前一致で対応づける」で崩れ、R2 は「identity の差し替えだけで済む」で崩れた。**
**どちらも、次に読む人が最初に思いつく形である。**

**R3 は両方を踏まえたうえで、`ALIAS_SAFE` の広さ・部分木一致・移行案の実行可能性という
「実際に踏む」側の問題を先に潰している。**

### 17.6 指摘の反映（2026-08-06・Claude）

**§17.2 / §17.3 を本文へ反映した。R3 はこの状態で実装依頼に出す。**

| 反映先 | 内容 |
|---|---|
| §8.2 | 禁止リストへ「**集計の別名を、同じ query block が参照する物理フィールド名と衝突させる形**」を追加 |
| §8.3 / §8.4 / §9.8 | 骨子と受入例の別名を `個数` → **`最小個数`** へ（§8.8 と揃えた） |
| §8.6 | 「**`GROUP BY` へ足した列を射影しない完成SQLを示さない**」を追加 |
| §16.5 | 受入へ「表示された修正SQLが **B147 の形** / **同じ値の行が並ぶ形** になっていないこと」を追加 |

