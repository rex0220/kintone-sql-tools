# B164 原因調査報告

調査は静的読解のみ。起票文の実測 3 点は再実行していない。コード変更・ファイル書き込み・`git`・MCP は未使用。

## 結論

B164 の直接原因は、集計式に対して同じ `aggregateSyntheticName()` を使いながら、呼び出すタイミングが異なることにある。

- 計算・保存側は、`@a`・`@b`をリテラルへ解決した後の AST から key を生成する。
- CASE/HAVING の直接集計参照側は、parser が変数解決前に `FieldRef.field` へ焼き付けた key を使い続ける。
- 変数 resolver は `FieldRef.aggregateRef` の AST を解決するが、派生文字列である `FieldRef.field` は再生成しない。
- したがって、正しい値は「解決後 key」で保存済みなのに、「解決前 key」で検索して未一致となる。
- 未一致値は `""` となり、数値比較では有限値より小さい最小バンドへ入る。コード上は JavaScript の `-Infinity` そのものではない。

つまり、原因は「異なる canonicalizer」ではなく、**同一 serializer を変数解決前後で呼んだことと、変数解決前の派生 key が AST に残留すること**である。

---

## 1. 計算側：SELECT リスト集計の計算・保存 key

### 1.1 変数解決

バッチ文は実行前に `resolveBatchVariableReferences()` を通る。

- 通常文の解決入口: `src/execute.ts:1775-1780`
- resolver 本体: `src/execute.ts:2106-2114`
- `VARIABLE` を取得値へ置換: `src/execute.ts:2121-2153`
- 文字列変数は `{ type: "STRING", value, fromVariable: true }` になる: `src/execute.ts:2153`
- オブジェクト全体は再帰的に複製される: `src/execute.ts:2170-2185`

`fromVariable` は出自情報にすぎず、集計 key の serializer はこれを参照しない。

### 1.2 key の canonical 形

runtime の集計 identity は JSON serialize や B147 の構造 canonical ID ではなく、`aggregateSyntheticName()` が作る SQL 風文字列である。

- 文字列は単一引用符で囲み、内部の `'` を二重化: `src/core/aggregateExpression.ts:17-19`
- WHERE 条件の文字列化: `src/core/aggregateExpression.ts:60-69`
- CASE の文字列化: `src/core/aggregateExpression.ts:72-85`
- 集計引数全体の文字列化: `src/core/aggregateExpression.ts:111-115`
- 最終 key の生成: `src/core/aggregateExpression.ts:117-124`

概念上、今回の key は次のように変化する。

```text
parse 時:
SUM(CASE WHEN ... >= @a AND ... <= @b THEN 個数 ELSE 0 END)

変数解決後:
SUM(CASE WHEN ... >= '2026-02' AND ... <= '2026-04' THEN 個数 ELSE 0 END)
```

両者とも同じ `aggregateSyntheticName()` 形式だが、入力 AST が異なる。

### 1.3 計算と保存

FULL_SCAN の処理順では GROUP BY／集計が HAVING より先に実行される。

- GROUP BY／集計の呼び出し: `src/engine/process.ts:2137-2164`
- `applyGroupBy()` が各グループで集計列を materialize: `src/engine/process.ts:359-415`
- 通常 GROUP BY と GROUPING SETS はどちらも `materializeAggregateColumns()` を呼ぶ: `src/engine/process.ts:411`, `src/engine/process.ts:497`

直接の SELECT 集計列では、変数解決後の `col.arg` から key を作り、`evalAggregate()` の結果を保存する。

- key 生成: `src/engine/process.ts:520-522`
- 保存する lookup key は alias と synthetic key、または synthetic keyのみ: `src/engine/process.ts:523-528`
- 実集計処理: `src/engine/process.ts:658-774`

保存先は公開行の通常プロパティではなく、行ごとの `WeakMap` である。

- materialized 値の `WeakMap`: `src/engine/process.ts:90-95`
- 列位置用 `byColumn` と名前参照用 `byLookupKey`: `src/engine/process.ts:127-144`
- Proxy は存在しない通常プロパティを `byLookupKey` から補う: `src/engine/process.ts:96-120`

SELECT リスト自身は列位置 `byColumn` を最優先で読むため、名前不一致の影響を受けない。

- SELECT 集計値の読出し順: `src/engine/process.ts:1417-1424`
- 先頭が `getMaterializedSelectValue(row, columnIndex)`: `src/engine/process.ts:1419`

これが「SELECT リストの値だけは正常」の理由である。

---

## 2. 参照側：CASE WHEN と HAVING が使用する key

### 2.1 parser が直接集計を `FIELD` に変換する

CASE 条件または HAVING 左辺で直接集計を読むと、parser は `AggregateRef` をそのまま評価ノードにせず、合成名を持つ `FIELD` に変換する。

- CASE 条件は `SELECT_CASE` context で WHERE parser へ入る: `src/parser/parser.ts:2187-2190`
- HAVING は `HAVING` context で解析される: `src/parser/parser.ts:1183-1185`
- 集計を `parseAggregateRef()` で読む: `src/parser/parser.ts:2852-2859`
- その場で `aggregateSyntheticName()` を実行: `src/parser/parser.ts:2866`
- 結果を `FieldRef.field` に保存: `src/parser/parser.ts:2867-2870`
- 同時に元の構造を `FieldRef.aggregateRef` に保持: `src/parser/parser.ts:2871-2873`
- AST 上もこの二重保持が定義されている: `src/types/ast.ts:568-575`

したがって直接集計参照は、次の二つを持つ。

```text
field        = parse 時点で serialize 済みの文字列 key
aggregateRef = 構造化された AggregateRef
```

### 2.2 CASE WHEN の参照

集計を含む CASE 列では、まず CASE 内の集計依存を計算する。

- CASE の依存集計を materialize: `src/engine/process.ts:553-555`
- AST 全体から `AGG_REF` を収集: `src/engine/process.ts:579-592`
- `aggregateRef` から解決後 key を生成して計算・保存: `src/engine/process.ts:594-614`

しかし `resolveAggInCaseExpr()` が直接値へ置換するのは THEN／ELSE の結果だけで、WHEN 条件は変更しない。

- branch の `result` のみ置換: `src/engine/process.ts:1937-1951`

その後の WHEN 条件評価では、parser が生成した `FIELD.field` を key として使う。

- CASE の条件評価: `src/engine/evalWhere.ts:387-400`
- `FIELD` の key は `field.field`: `src/engine/evalWhere.ts:340-355`
- `resolveFieldRef()` はその文字列で行を検索: `src/engine/evalFunc.ts:741-749`

一方、`aggregateRef` は値の検索には使われず、数値／文字列 semantics の判定にだけ使われる。

- CASE 用 aggregate semantics: `src/engine/process.ts:556-563`

### 2.3 HAVING の参照

HAVING は集計後に評価される。

- GROUP BY／集計後に `applyHaving()`: `src/engine/process.ts:2166-2170`
- materialized lookup を評価行へ反映: `src/engine/process.ts:160-168`
- 実フィルタ: `src/engine/process.ts:892-905`

ただし反映される名前は、計算側が登録した解決後 synthetic key である。HAVING AST の直接集計は CASE と同じく、変数解決前に固定された `FieldRef.field` で検索する。

HAVING でも `aggregateRef` は semantics にだけ使用される。

- HAVING aggregate semantics: `src/engine/process.ts:2167-2169`
- 値検索は最終的に `FieldRef.field`: `src/engine/evalWhere.ts:127-132`, `src/engine/evalWhere.ts:340-355`

---

## 3. key が食い違う正確な箇所

食い違いは次の順序で発生する。

1. parser が未解決の `AggregateRef` から synthetic key を生成する。  
   `src/parser/parser.ts:2858-2873`

2. この時点の `FieldRef.field` には `@a`・`@b` が文字列として埋め込まれる。  
   `src/core/aggregateExpression.ts:44-49`, `src/core/aggregateExpression.ts:60-64`

3. 実行前 resolver が `aggregateRef` 内部の `VARIABLE` を `STRING` へ置換する。  
   `src/execute.ts:2121-2153`

4. resolver はオブジェクトを再帰複製するだけで、`type === "FIELD" && aggregateRef` の場合に `field` を再生成する処理を持たない。  
   `src/execute.ts:2170-2188`

5. 計算側は解決済み `AggregateRef`／SELECT aggregate AST から synthetic key を生成する。  
   `src/engine/process.ts:521-528`, `src/engine/process.ts:603-613`

6. CASE/HAVING は更新されなかった `FieldRef.field` で検索する。  
   `src/engine/evalWhere.ts:351-355`

したがって正確な原因は、**変数解決のタイミング差によって、同じ serializer の入力が異なること**である。canonical 化ルール自体が計算側と参照側で異なるわけではない。

また、`fromVariable: true` は key に反映されないため、解決後 key は `@a` ではなく通常の引用済みリテラルと同じ形になる。  
`src/execute.ts:2153`, `src/core/aggregateExpression.ts:44-48`

---

## 4. 未一致から「-Infinity」相当になる経路

未一致時にコードが `-Infinity` を直接代入しているわけではない。

1. stale な `FieldRef.field` で lookup する。
2. 見つからない場合、`resolveFieldRef()` が `""` を返す。  
   `src/engine/evalFunc.ts:741-749`
3. `aggregateRef` が残っているため、SUM は数値 semantics になる。  
   `src/engine/process.ts:870-885`, `src/engine/process.ts:2167-2169`
4. 比較は `compareScalarValues()` から数値 canonical comparator へ進む。  
   `src/engine/evalWhere.ts:127-132`, `src/engine/evalWhere.ts:176-178`
5. 数値 comparator は空文字を `band: 0` に置く。  
   `src/core/scalarCompare.ts:30-43`
6. 通常の有限数は `band: 2`、明示的な `-Infinity` は `band: 1` なので、空文字はそれらよりさらに小さい。  
   `src/core/scalarCompare.ts:35-43`
7. band 番号の大小で比較結果が決まる。  
   `src/core/scalarCompare.ts:46-52`

したがってコード上の正確な値は次のとおり。

```text
空 sentinel: band 0
-Infinity:    band 1
有限数:       band 2
+Infinity:    band 3
```

起票文の符号 probe からは `-Infinity` のように見えるが、実装上は **`-Infinity` よりも下に置かれた空文字 sentinel** である。

このため、SUM の正値 `0` が保存済みでも、参照値 `""` と `"0"` の数値比較は等しくならず、`CASE WHEN ... = 0` のガードが不発になる。起票文の症状と一致する。  
`src/core/scalarCompare.ts:140-173`

なお、集計算術式では空文字を `Number("")` に通す経路があり、その場合は `0` になる。  
`src/engine/evalFunc.ts:718-736`  
したがって「空＝最小バンド」は直接集計比較の経路に固有であり、すべての集計算術評価が `-Infinity` 相当になるわけではない。

---

## 5. 影響位置の全列挙

### 5.1 直接影響する位置

#### SELECT の CASE WHEN／IF 条件

トップレベル SELECT CASE／IF の条件は `SELECT_CASE` context を使う。

- CASE 列: `src/parser/parser.ts:1408-1413`
- IF 列: `src/parser/parser.ts:1415-1419`
- 条件 context: `src/parser/parser.ts:2187-2190`

条件左辺に直接記述した集計が対象になる。

```sql
CASE WHEN SUM(<@変数を含む式>) = 0 THEN ...
IF(SUM(<@変数を含む式>) = 0, ...)
```

AND／OR／NOT／括弧の内側でも同じ `WhereExpr` 評価なので対象である。  
`src/engine/evalWhere.ts:91-109`, `src/engine/evalWhere.ts:321-333`

#### HAVING の直接集計

```sql
HAVING SUM(<@変数を含む式>) = 0
```

HAVING のどの論理階層に現れても同じ stale `FieldRef.field` を使用する。  
`src/parser/parser.ts:1183-1185`, `src/parser/parser.ts:2852-2874`

#### GROUPING SETS／ROLLUP／CUBE

集計 materialize と HAVING/CASE の参照機構は通常 GROUP BY と共通なので、同じ直接集計比較を書けば対象になる。  
`src/engine/process.ts:428-503`, `src/engine/process.ts:2140-2150`

#### サブクエリ・CTE・UNION 各枝

それぞれの SELECT 内に対象 CASE/HAVING があれば、その SELECT 単位で発生する。

UNION 自体が左右の集計 key を共有するわけではなく、左右を独立した `executeSelect()` として実行する。  
`src/execute.ts:5169-5211`

### 5.2 集計関数の範囲

key 生成は全 `AggregateFunc` 共通なので、COUNT/SUM/AVG/MAX/MIN/GROUP_CONCAT/統計集計/MEDIAN/MODE が原理上対象である。  
`src/types/ast.ts:292-294`

ただし実際に key が変わるのは、集計引数内の identity に `@変数` が含まれる場合である。`COUNT(*)` のように引数 identity が変わらないものは対象外。

変数が CASE 条件、CASE 結果、文字列関数引数、連結式など aggregate argument の serializer 対象部分にあれば key は変化し得る。  
`src/core/aggregateExpression.ts:60-115`

### 5.3 同じ症状にならない位置

#### SELECT リストの集計値そのもの

列位置 identity で読むため正常。  
`src/engine/process.ts:1417-1424`

#### CASE の THEN／ELSE に置いた集計

THEN／ELSE の `AGG_REF` は lookup ではなくグループ行から直接計算値へ置換される。  
`src/engine/process.ts:1911-1934`

#### 集計算術式として書いた比較

`SUM(...) + 0` や `SUM(...) * @rate` は `AGG_FIELD`／`AggOperand` として構造的に評価され、解決後 `AggregateRef` から key を生成する。  
`src/parser/parser.ts:2860-2864`, `src/engine/evalFunc.ts:717-736`

したがって、少なくとも B164 の stale `FieldRef.field` 不一致とは別経路である。

#### 集計を包む文字列・数値関数

`ROUND(SUM(...), 1)` 等の `AGG_REF` は `evalMaterializedAggregateOperand()` が解決後 AST から key を生成する。  
`src/engine/evalFunc.ts:703-714`, `src/engine/evalFunc.ts:717-722`

#### WHERE／JOIN

通常の WHERE/JOIN では集計参照 context が許可されず、B164 の `aggregateRef` 付き `FIELD` は生成されない。  
`src/parser/parser.ts:2821-2824`, `src/parser/parser.ts:2852-2874`

### 5.4 ORDER BY

ORDER BY は `aggregateRef` 付き `FieldRef` を使用せず、`FIELD_NAME`／算術／関数／GROUPING key の別 AST である。  
`src/types/ast.ts:783-787`

通常の集計 alias は列位置で materialize 済み値を読むため安全である。

- alias evaluator: `src/engine/process.ts:1108-1131`
- ORDER BY key lookup: `src/engine/process.ts:1094-1103`

ただし alias なし集計の synthetic nameをバッククォート等で手書きし、その文字列内に `@a` を残した場合は、`FIELD_NAME` がその文字列をそのまま lookup するため、類似の未一致が起こり得る。これは B164 の自動生成 `aggregateRef` 不整合ではなく、文字列 key を手書きしたことによる隣接リスクである。

対策上は、ORDER BY では集計 alias を使用するのが安全。

### 5.5 ウィンドウ関数

ウィンドウ集計は `aggregateSyntheticName()` によるグループ集計 lookup を使わず、partition の各行から `aggregateRowValues()` で直接計算する。

- window は HAVING 後に実行: `src/engine/process.ts:2172-2180`
- window の独立処理: `src/engine/process.ts:1184-1240`
- aggregate window の値収集: `src/engine/process.ts:1268-1283`

また、window 結果を同一 SELECT の CASE/HAVING 条件で直接参照する構文とはなっていない。window 関数自体は SELECT 列として解析される。  
`src/parser/parser.ts:1403-1405`

したがってウィンドウ計算そのものは B164 の対象外。

### 5.6 HAVING 非掲出問題との区別

`materializeAggregateColumns()` は SELECT 列と、その列内の依存集計だけを走査する。HAVING AST 自体の依存集計を追加 materialize してはいない。  
`src/engine/process.ts:513-572`

そのため、HAVING にしか存在しない集計の未 materialize は、B164 と同じ空値症状を出し得るが別原因である。B164 修正では次の二つを分離してテストする必要がある。

- SELECT に同じ集計があるが、変数解決前後の key が不一致になる B164
- 集計自体が SELECT／SELECT 依存に存在せず、保存されていない問題

---

## 6. 修正方向と費用見立て

| 候補 | 内容 | 費用 | 評価 |
|---|---|---:|---|
| A. 参照時に `aggregateRef` から key を再生成 | `resolveField()` で `field.aggregateRef` があれば `field.field` を信用せず、`aggregateSyntheticName(field.aggregateRef...)` を使用する | 小 | 本命。値と semantics の双方で `aggregateRef` を唯一の正本にでき、CASE/HAVINGを同時に直せる |
| B. 変数 resolver 後に `FieldRef.field` を再生成 | `resolveBatchVariableReferencesInternal()` の再帰後、`FIELD + aggregateRef` の派生 key を更新する | 小〜中 | 現行構造を保ちやすいが、今後別 resolver が追加された場合に再発余地がある |
| C. parser で派生文字列を保持しない | `FieldRef.field` と `aggregateRef` の二重保持を廃止し、runtime identity を構造参照または専用 aggregate-reference node に統一する | 中〜大 | 最も堅牢。ただし parser、AST、converter、validation、runtime、snapshot の波及が大きい |
| D. 精密な runtime 検知 | stale key がない一方、`aggregateRef` から再生成した keyが存在する場合に警告またはエラーにする | 小〜中 | B164 を誤検知少なく可視化できる。修正までの中間策として有効 |
| E. unresolved aggregate lookup 全般を fail-loud 化 | `aggregateRef` 付き FIELD が未一致なら `""` にせず警告／例外 | 中 | B164 と HAVING 非掲出問題を同時に検知できるが、既存 fail-open 挙動の互換性影響が大きい |
| F. EXPLAIN／静的警告 | 比較位置の `aggregateRef` 配下に `VARIABLE` があることを変数解決前に検出する | 中 | 実装は比較的容易だが、警告を CLI・plugin・engine-library 等へ一貫して伝播する作業が必要。根本修正にはならない |

### 推奨順

1. **A：参照時に `aggregateRef` から key を再生成**
2. 同時に、再生成 key も見つからない場合は B164 と区別できる診断を追加
3. 互換性上すぐ fail-loud にできない場合は D の限定警告
4. 長期的には C で派生文字列と構造 AST の二重正本を解消

A が最小かつ本質的である。parser はすでに `aggregateRef` を保持し、semantics 判定もそれを正本としている。  
`src/types/ast.ts:568-575`, `src/engine/process.ts:556-558`, `src/engine/process.ts:2167-2169`

修正後に必要な最小回帰観点は以下となる。

- SELECT CASE の直接 SUM 比較
- HAVING の直接 SUM 比較
- AND／OR／NOT 内の複数 occurrence
- 文字列値の引用符エスケープを含む変数
- DISTINCT および全 AggregateFunc
- GROUPING SETS 系
- 集計算術式・THEN/ELSE 集計が変化しないこと
- HAVING 非掲出問題を B164 の合格条件へ混入させないこと
- ORDER BY alias、window、UNION 各枝の非回帰

