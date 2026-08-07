# B151 JOIN NUMBER 比較の exact prefilter 化 仕様（R1）

- ステータス: **R1 正本**
- 対象: kSQL v3.59.0
- 実装候補版: v3.60.0
- 起票: [B151](ksql_b151_join_inclusive_range_pushdown_issue.md)
- 関連: [B76 Phase A](ksql_b76_join_pushdown_phase_a_spec.md) / [B84](ksql_b84_pushdown_visibility_spec.md) / [B78](ksql_b77_b78_kintone_function_fail_closed_spec.md)
- 初版: 2026-08-07
- SemVer: **minor**
- Phase 1: **NUMBER の field-vs-numeric-literal 比較**

---

## 0. R1 の位置づけ

B151 は、alias 付き物理 APP だけを入力にする `INNER JOIN` で、NUMBER フィールドと数値リテラルを比較する `WHERE` leaf を、比較式を変形せず対象 APP の records API query へ押し下げる性能改善である。

```sql
SELECT m.製品名, t.個数
FROM APP4229 AS m
JOIN APP4228 AS t ON m.製品名 = t.製品名
WHERE t.個数 <= 100
ORDER BY t.$id
```

現行 v3.59.0 では、単一表の `個数 <= 100` は kintone query へ送られるが、JOIN 中の `t.個数 <= 100` は JOIN 固有分類器で `unsafe` となり、対象 APP を全件取得してから client で判定する。

B151 後は次をそのまま送る。

```text
個数 <= 100
```

次の widening は行わない。

```text
個数 <= 100  → 個数 < 101
個数 >= 100  → 個数 > 99
```

NUMBER の server 比較と JOIN 後の direct-field local 比較が同じ有限10進・空セル順序を使うため、widening を介さず `exact` と分類する。

B151 は結果集合を変更しない。変更するのは JOIN 前の取得候補数、`EXPLAIN` の fetch scope、NUMBER leaf の `relation` である。通常述語について元の `WHERE` を JOIN 後に再評価する B76 の契約も維持する。

---

## 1. 目的

B151 の目的は次の4点である。

1. JOIN 中の NUMBER `<=` / `>=` を、そのまま対象 APP の query へ押し下げる。
2. 同じ意味論一致に基づき、NUMBER の `<` / `>` にある安全整数リテラル制限を解除する。
3. NUMBER の `=` を `superset` から `exact` へ昇格し、`!=` / `<>`、`IN` / `NOT IN` を numeric-literal 条件下で解禁する。
4. B84 の公開表、言語リファレンス、歴史仕様の注記、回帰テストを同じ分類結果へ同期する。

公開上の原則は次である。

> NUMBER フィールドの保存値と数値リテラルを直接比較する JOIN leaf は、kintone server と kSQL local evaluator が同じ有限10進比較を行うことを証明できる範囲で、比較式を変形せず exact prefilter として使用する。

---

## 2. 根拠と確定範囲

### 2.1 コードから静的に確定していること

| 事実 | 根拠 |
|---|---|
| NUMBER の意味型は `compareMode: "number"` である | `src/core/fieldSemantics.ts:32-40` |
| JOIN 後の処理順は flatten → join → filter である | `src/engine/process.ts:2089-2121` |
| JOIN 後の filter は `applyFilter()` から `evalWhere()` を呼ぶ | `src/engine/process.ts:309-322,2117-2121` |
| direct field の比較ではフィールド型・意味型を解決して `evalOp()` へ渡す | `src/engine/evalWhere.ts:116-132` |
| 通常比較の最終入口は `compareScalarValues()` である | `src/engine/evalWhere.ts:176-179` |
| NUMBER の有限10進値は `parseExactDecimal()` で band 2 に入り、`compareExactDecimal()` で比較される | `src/core/scalarCompare.ts:30-53` |
| `=` / `!=` / `<>` / `<` / `>` / `<=` / `>=` は同じ比較結果 `cmp` から判定される | `src/core/scalarCompare.ts:159-174` |
| 空文字は NUMBER 順序の band 0、有限10進は band 2 であり、空セルはすべての有限数より小さい | `src/core/scalarCompare.ts:30-50` |
| `parseExactDecimal()` は符号、小数、指数表記を binary64 化せず解析する | `src/core/exactDecimal.ts:12-45` |
| `1.10` と `1.1`、`+0` / `-0`、指数展開後に同じ値となる表記は同じ `ExactDecimal` 値として比較される | `src/core/exactDecimal.ts:24-45,78-100` |
| NUMBER のローカル `IN` は各候補との `compareScalarValues("=")` で判定する | `src/engine/evalWhere.ts:145-159,238-248` |
| parser は数値リテラルの元字句を `raw` に保持する | `src/types/ast.ts:652-661` |
| kintone query へ送る数値は `raw` から plain decimal へ損失なく正規化される | `src/types/ast.ts:663-668` |
| `whereToKintone()` は6比較演算子と `in` / `not in` を直列化できる | `src/converter/whereToKintone.ts:62-100,191-200` |
| 一般 WHERE capability は NUMBER の6比較演算子と `in` / `not in` を native exact と認識する | `src/core/optimization/whereCapability.ts:66-99,277-309` |
| JOIN 固有分類器だけが NUMBER を `=` の superset、かつ安全整数との strict `<` / `>` に限定している | `src/core/optimization/joinPredicatePushdown.ts:1013-1049,1113-1122` |
| NUMBER prefilter の records API query は JOIN 前に対象 APP ごとに適用される | `src/execute.ts:4936-4968,4993-5028` |
| fetch 後は `runFullScan()` へ元 statement と NUMBER 意味型 resolver が渡る | `src/execute.ts:5082-5106` |
| 通常の JOIN pushdown leaf は元 `WHERE` から除去されず、JOIN 後に再評価される | `src/engine/process.ts:2117-2121`; `docs/internal/ksql_b76_join_pushdown_phase_a_spec.md:20-21,114` |
| `EXPLAIN` は plan item の relation に応じて `EXACT` / `PREFILTERED` を分け、`pushdown applied:` と `relation:` を表示する | `src/execute.ts:11524-11555,11575-11607` |

### 2.2 JOIN 後の残余 WHERE が通る比較経路

B151 対象の direct NUMBER field-vs-literal leaf は、次の経路を通る。

```text
executeFullScanSelect()
  → runFullScan()
  → applyJoin()
  → applyFilter()
  → evalWhere()
  → evalBinary()
  → semanticsForLeft()
  → evalOp()
  → compareScalarValues()
  → compareCanonicalValues()
  → compareNumbers()
  → parseExactDecimal() / compareExactDecimal()
```

根拠:

- `executeFullScanSelect()` が `runFullScan()` へ `fieldTypeResolver` と `fieldSemanticsResolver` を渡す  
  `src/execute.ts:5082-5106`
- `runFullScan()` は JOIN 後に `applyFilter()` を実行する  
  `src/engine/process.ts:2100-2121`
- `evalBinary()` は左辺の NUMBER 意味型を解決する  
  `src/engine/evalWhere.ts:116-132`
- `evalOp()` は通常比較を `compareScalarValues()` へ渡す  
  `src/engine/evalWhere.ts:176-179`
- NUMBER の有限値同士は `compareExactDecimal()` へ到達する  
  `src/core/scalarCompare.ts:35-53`

したがって、direct NUMBER field-vs-numeric-literal の残余 WHERE は binary64 比較ではない。

### 2.3 別の比較実装が残る経路

次は B151 の安全証明へ含めない。

| 経路 | 比較・変換 | B151 での扱い |
|---|---|---|
| `個数 + 0` 等の算術式 | `evalArithExpr()` で JavaScript number を経由し、その結果文字列を number semantics で比較 | prefilter 対象外。受入の対照経路としてのみ使用 |
| `SUM` / `AVG` 等の数値集計 | JavaScript number の集計結果 | 対象外 |
| 数値関数 | 関数ごとの JavaScript number 処理 | 対象外 |
| `GREATEST` / `LEAST` | 集合全体モード。有限10進同士は exact だが、非10進値では `Number()` fallback がある | 対象外。`src/core/scalarCompare.ts:177-199` |
| JOIN の `ON` 等値キー | 現行はフラット化した文字列キーの map 照合 | 対象外。B151 は `WHERE` prefilter だけを変更 |
| NUMBER 以外のフィールド型 | 型別の別 compare mode | 対象外 |
| CTE・一時テーブル・式列 | 物理 APP の query へ送る対象ではない | 対象外 |

B151 の classifier は、左辺が直接の物理 NUMBER フィールドである場合だけ開放する。`ARITH_FIELD`、`FUNC_FIELD`、`CASE_FIELD`、集計結果、field-to-field RHS は従来どおり `unsafe` または local-only とする。

### 2.4 10進比較器の導入版

git 履歴を使わず、現行コード・公開文書・リリース文書から確定できる範囲では、型付き canonical 比較契約の導入版は **v3.0.0** である。

根拠:

- v3.0.0 移行ガイドは、通常 `ORDER BY`、ウィンドウ、`MIN` / `MAX`、`WHERE` 範囲比較、REORDER が宣言型に基づく共通規則を使い、typed number の順序を `空セル < -Infinity < 有限数 < ...` と定義している  
  `docs/ksql_v3_migration_guide.md:1-12`
- 言語リファレンスは「型付き比較（v3.0.0）」として、NUMBER と数値形式 CALC が有限10進を文字列のまま厳密比較すると明記している  
  `docs/ksql_language_reference.md:917-927`
- B76 Phase A の基準版は v3.25.0、リリース版は v3.26.0 である  
  `docs/internal/ksql_b76_join_pushdown_phase_a_spec.md:1-5`

したがって、現在確認できる文書上は「B76 判断後に10進比較器が導入された」とは言えない。むしろ v3.0.0 の型付き比較契約が B76 基準版 v3.25.0 より前に存在していた。

B76 §5.2 の「IEEE-754 境界のため inclusive は不可」は、少なくとも現行コードおよび v3.0.0 公開契約とは整合しない。導入コミットや v3.0.0 内の厳密な実装日までは、git 履歴を使わない本調査では未特定とする。

### 2.5 起票・依頼で確定している実測

次は再導出せず、B151 の前提として採用する。

1. APP4228 の格納値 `999999999999.9999` とリテラル `999999999999.99985` について、押し下げ経路、FULL_SCAN 強制経路、算術経由の結果が一致した。
2. 空の NUMBER セルは kintone と direct-field local 比較の双方で有限数より小さい。
3. `個数 < 100` は両経路とも空セル行を含む。
4. `個数 >= -5` は両経路とも空セル行を含まない。
5. APP4228 の `numberPrecision` は既定の全体16桁・小数4桁・HALF_EVEN である。
6. `0.1234567890123456789` は保存時に `0.1235` へ丸められた。
7. `numberPrecision` は最大30桁・小数10桁まで設定できる。

根拠: `docs/internal/ksql_b151_join_inclusive_range_pushdown_issue.md:55-97`

### 2.6 実行しないと確定できないこと

次はコードだけでは kintone server の挙動まで証明できないため、§11 の実測をリリース条件とする。

- 変更後の JOIN query が全演算子で kintone に受理されること
- NUMBER `IN` / `NOT IN` と local `typedInContains()` の一致
- `!=` / `<>` の空セル挙動
- アプリの `numberPrecision` を変更した場合の境界比較
- app 設定の精度を超えるがB151の許可範囲内である query literal の受理
- 指数表記を plain decimal にした query と元 SQL の結果一致
- `+0` / `-0` の server equality
- 最大30桁・小数10桁付近の query literal
- 検索打ち切り、取得上限、複数ページ取得を含む場合の既存 fail-closed 契約
- CLI、MCP、Firefox plugin、Chrome plugin、engine library の公開結果一致

---

## 3. Phase 1 の適用条件

B151 Phase 1 は、次をすべて満たす leaf に適用する。

1. SELECT が alias 付き物理 APP だけを入力にする `INNER JOIN` である。
2. 左辺が単一の物理 APP に一意に所有される直接フィールド参照である。
3. フィールド型が `NUMBER` である。
4. scalar 比較では右辺が numeric literal である。
5. `IN` / `NOT IN` では右辺が1件以上の numeric literal だけからなるリストである。
6. 各 numeric literal が有限10進として損失なく解析できる。
7. 各 numeric literal が §4.2 のB151許可範囲に入る。
8. `classifyWhereCapability()` が `EXACT_PUSHDOWN` と判定する。
9. B76 の ownership、source kind、tree 合成、KLIKE、outer join、server-only function に関する既存 gate をすべて通る。

次は対象外である。

- `LEFT JOIN` / `RIGHT JOIN`
- CTE、一時テーブル、サブテーブル、入れ子 SELECT、派生表を JOIN 入力にする形
- field-to-field 比較
- 文字列リテラルとの比較
- 算術式、関数、`CASE`、集計結果を左辺または右辺に置く比較
- scalar subquery、`IN (SELECT ...)`
- 非有限値、非数値値
- CALC
- DATE / TIME / DATETIME
- TEXT、選択系、ユーザー系、複合型
- NUMBER の `LIKE` / `NOT LIKE` / `KLIKE` / `NOT KLIKE`
- §4.2 の許可範囲を超える巨大 scale

---

## 4. NUMBER の意味論契約

### 4.1 server と local の一致条件

B151 が `exact` と主張する対象は、次の同じ値領域である。

```text
D = 空セル ∪ B151許可範囲内の有限10進値
```

direct NUMBER field と numeric literal の比較では、次を契約とする。

```text
serverCompare(fieldValue, literal)
=
localCompare(fieldValue, canonicalPlainDecimal(literal))
```

local 側では次の順序を使う。

```text
空セル < すべての有限10進値
```

有限10進値同士は、符号、係数、scale を使って10進厳密比較する。binary64 の近似値、元字句の文字列順、表示書式順では比較しない。

### 4.2 B151 numeric literal の許可範囲

numeric literal は、`numberLiteralText()` と同じ規則で指数を展開し、先頭の `+`、冗長な先頭ゼロ、小数末尾ゼロ、負のゼロを正規化した plain decimal として判定する。

Phase 1 で押し下げ可能な literal は次をすべて満たすものとする。

- `parseExactDecimal()` が成功する有限10進
- 正規化後の小数部が10桁以下
- 正規化後の整数部桁数と小数部桁数の合計が30桁以下
- ゼロは桁数0として許可
- query serializer が同じ plain decimal を出力する

例:

| SQL literal | query へ送る値 | Phase 1 |
|---|---:|:---:|
| `100` | `100` | 対象 |
| `-5` | `-5` | 対象 |
| `+5` | `5` | 対象 |
| `1.20` | `1.2` | 対象 |
| `1e3` | `1000` | 対象 |
| `1e-10` | `0.0000000001` | 対象 |
| `9007199254740993` | `9007199254740993` | 対象 |
| `999999999999.99985` | `999999999999.99985` | 対象 |
| `-0` | `0` | 対象 |
| `+0` | `0` | 対象 |
| `1e-11` | — | 対象外 |
| 31桁の整数 | — | 対象外 |
| `NaN` | — | 対象外 |
| `Infinity` | — | 対象外 |
| `'100'` | — | 対象外 |
| `''` | — | 対象外 |

この30桁・小数10桁 gate は、巨大指数を plain decimal へ展開する際の無制限な文字列生成を JOIN prefilter 経路へ持ち込まないためにも必要である。

アプリ固有の `numberPrecision` より細かい query literal を一律に除外してはならない。既定16桁・小数4桁の APP4228 で、5桁の小数部を持つ境界 literal `999999999999.99985` が実測対象として成立しているためである。アプリ固有 precision は保存値の丸めを決めるが、query literal の比較境界としての受理性は §11 で設定変更アプリを使って確認する。

### 4.3 開放する型×演算子

| field type | 演算子 | RHS | relation | Phase 1 |
|---|---|---|---|:---:|
| NUMBER | `=` | 許可範囲内の numeric literal | `exact` | 開放 |
| NUMBER | `!=` / `<>` | 許可範囲内の numeric literal | `exact` | 開放 |
| NUMBER | `<` / `>` | 許可範囲内の numeric literal | `exact` | 開放 |
| NUMBER | `<=` / `>=` | 許可範囲内の numeric literal | `exact` | 開放 |
| NUMBER | `IN` | 1件以上の許可 numeric literal | `exact` | 開放 |
| NUMBER | `NOT IN` | 1件以上の許可 numeric literal | `exact` | 開放 |
| NUMBER | 上記すべて | 文字列、非有限、範囲外 literal、式、field | `unsafe` | 非開放 |
| CALC | すべて | すべて | `unsafe` | 非開放 |

`=` は現行の `superset` から `exact` へ昇格する。`<` / `>` は安全整数制限を外し、有限10進 literal 全体へ広げる。`<=` / `>=`、`!=` / `<>`、`IN` / `NOT IN` は新規に開放する。

### 4.4 空セルの挙動

有限 numeric literal `L` に対する空 NUMBER セルの結果を次に固定する。

| 条件 | 空セルの結果 |
|---|:---:|
| `field = L` | false |
| `field != L` / `field <> L` | true |
| `field < L` | true |
| `field <= L` | true |
| `field > L` | false |
| `field >= L` | false |
| `field IN (L, ...)` | false |
| `field NOT IN (L, ...)` | true |

B151 Phase 1 の numeric `IN` / `NOT IN` リストには空文字を含めない。空セルを明示的に判定する既存の `IS NULL`、`IS NOT NULL`、文字列 literal を、B151 の NUMBER numeric-literal 証明へ混ぜない。

### 4.5 符号、ゼロ、指数、表記差

次は同じ有限10進値として扱う。

```text
0 = +0 = -0 = 0.0 = 0e10
1 = 1.0 = 01 = 1e0
1000 = 1e3
0.0000000001 = 1e-10
```

query へ送る値は plain decimal に正規化する。`+` や指数表記をそのまま kintone query へ送らない。

`NumberLiteral.value` を安全性判定や query 生成の正本にしてはならない。`9007199254740993` のような binary64 安全整数外の値でも、`raw` と `numberLiteralText()` による10進字句を正本とする。

### 4.6 `numberPrecision` と保存時丸め

B151 が比較する左辺値は、kintone がアプリ設定に従って保存した後の文字列値である。

```text
入力 0.1234567890123456789
→ 保存値 0.1235
→ B151 の server/local 比較対象は 0.1235
```

B151 は保存時丸めを再実装しない。query literal も保存値の precision へ事前丸めしない。

したがって次は誤りである。

```text
WHERE field >= 0.12345
→ literal を 0.1235 へ書き換える
```

B151 は利用者が書いた比較境界を plain decimal 化するだけであり、値の widening、narrowing、アプリ precision への丸めを行わない。

### 4.7 tree 合成と residual

B76 の tree 合成規則を維持する。

- `AND`: 同じ alias の採用可能 leaf をまとめる。
- `OR`: subtree 全体が同じ alias に属し、全 leaf が採用可能な場合だけ押し下げる。
- cross-alias `OR`: 押し下げない。
- `NOT`: 既存規則を維持する。
- KLIKE を含む `OR`: B76 の既存制限を維持する。
- outer join: 対象外。
- ownership 不明・曖昧: 対象外。

NUMBER leaf が `exact` になっても、通常述語の元 `WHERE` を residual から除去しない。B151 は residual elimination を行わない。

---

## 5. CALC を対象外に維持する理由

CALC は Phase 1 に含めない。

現行意味型は、CALC のフォーム設定 `format` により number または string を選ぶ。

- `format = NUMBER` / `NUMBER_DIGIT` → `sortKind: "number"`
- その他の CALC 表示形式 → `sortKind: "string"`

根拠:

- `src/core/formFieldInfo.ts:127-136`
- `src/core/fieldSemantics.ts:32-40`

ただし、このローカル sort kind だけでは次を証明できない。

1. kintone query が CALC を比較するとき、表示形式適用前の計算値と表示文字列のどちらを使うか。
2. 数値形式 CALC の保存・計算精度、丸め、空セル相当値が NUMBER と同じか。
3. 日付、時刻、日時等の表示形式へ変えた CALC の query literal domain。
4. 桁区切り、単位、通貨、時間表示等が records API value と query 比較へ与える影響。
5. NUMBER と同じ `numberPrecision` が CALC に適用されるか。
6. server と local で `+0` / `-0`、巨大値、非有限結果、計算エラーを同じ順序に置くか。

したがって、数値形式 CALC で local comparator が10進になっていることだけを理由に JOIN prefilter を開放してはならない。CALC は専用の実測と意味論表を持つ Phase 2 以降の課題とする。

---

## 6. DATE / TIME / DATETIME の Phase 2 候補

### 6.1 現行コードから分かること

DATE / TIME / DATETIME は local comparator では string compare mode である。

`src/core/fieldSemantics.ts:22-43`

kintone の正規化済み値は次の形であり、同じ長さ・同じ timezone 表現へ canonical 化されている範囲ではコードポイント順と時系列順が一致する。

| 型 | canonical 例 | local range の性質 |
|---|---|---|
| DATE | `2026-08-07` | 日付順とコードポイント順が一致 |
| TIME | `09:30` | 同一日内の時刻順とコードポイント順が一致 |
| DATETIME | `2026-08-07T00:30:00Z` | UTC canonical 値なら時系列順とコードポイント順が一致 |
| CREATED_TIME / UPDATED_TIME | DATETIME と同形 | DATETIME と同候補 |

現行 JOIN classifier は canonical literal の `=` だけを `superset` とし、range は `unsafe` としている。

`src/core/optimization/joinPredicatePushdown.ts:1059-1064`

### 6.2 Phase 2 で必要な証明

DATE / TIME / DATETIME range を開くには、型ごとに次を実測する。

1. 空セルの `<` / `<=` / `>` / `>=` / `!=` / `IN` / `NOT IN`
2. 最小・最大付近の canonical 値
3. DATE のうるう日と月・年境界
4. TIME の `00:00` / `23:59`
5. DATETIME の秒・ミリ秒、`Z`、offset 付き literal、timezone 解決
6. CREATED_TIME / UPDATED_TIME の空セル非存在性
7. canonical でないが parser が受理する文字列
8. server query が literal を正規化するか、拒否するか
9. `=` の `superset` から `exact` への昇格可否
10. `IN` / `NOT IN` の型別受理性

DATE については、canonical `YYYY-MM-DD` の direct field-vs-canonical-literal range が最初の候補である。ただしコードポイント順の一致だけでは server の空セル、無効 literal、query validation まで証明できないため、B151 Phase 1 へ含めない。

---

## 7. 実装要件

### 7.1 JOIN classifier

`src/core/optimization/joinPredicatePushdown.ts` の NUMBER 分岐を、概念上次の規則へ変更する。

```ts
if (fieldType === "NUMBER") {
  if (isSupportedNumberScalarLiteral(predicate)) return "exact";
  if (isSupportedNumberLiteralList(predicate)) return "exact";
  return "unsafe";
}
```

scalar 比較の許可演算子:

```text
=, !=, <>, <, >, <=, >=
```

list 比較の許可演算子:

```text
IN, NOT IN
```

既存の `isSafeIntegerLiteral()` を NUMBER 分岐の gate として使用しない。`$id` / `__ID__` の正の安全整数 gate は変更しない。

### 7.2 literal validator

NUMBER JOIN prefilter 専用の pure helper、または同等の責務を持つ helper を設ける。

必要な判定:

1. scalar は `NumberLiteral`
2. list は1件以上で全要素が `NumberLiteral`
3. `raw ?? String(value)` を `parseExactDecimal()` で解析できる
4. 正規化後の fraction digits が10以下
5. integer digits + fraction digits が30以下
6. serializer と同じ plain decimal を得られる
7. 判定中に巨大な `"0".repeat(...)` を作らない

helper は `NumberLiteral.value` の `Number.isSafeInteger()` を使って精度可否を判定してはならない。

### 7.3 serializer

B151 専用の widening serializer や演算子変換を追加しない。既存の `whereToKintone()` と `numberLiteralText()` を使用する。

次を query に出してはならない。

```text
1e3
+5
-0
```

次を出す。

```text
1000
5
0
```

### 7.4 relation

採用した NUMBER leaf はすべて `exact` とする。

複数 leaf の relation は既存 `combineRelation()` に従う。他の `superset` leaf と `AND` で結合された plan item 全体は `superset` のままである。

例:

```sql
WHERE t.個数 >= 100
  AND t.備考 = '確認'
```

NUMBER leaf は exact でも、SINGLE_LINE_TEXT `=` が superset なら alias 全体の relation は superset となる。

### 7.5 residual

通常述語の元 `WHERE` は残す。NUMBER exact 化を理由に residual AST から NUMBER leaf を削除しない。

B151 の correctness は exact relation だけに依存させず、B76 の再評価防御も維持する。

### 7.6 fail-closed

次の場合は query へ送らず、従来どおり local evaluation または既存診断へ落とす。

- RHS が文字列
- RHS が field、式、関数、CASE、subquery
- numeric literal がB151許可範囲外
- `IN` / `NOT IN` に文字列、関数、未解決変数が残る
- field type が未解決
- source ownership が曖昧
- CALC
- outer join
- source kind が物理 APP 以外
- `classifyWhereCapability()` が exact でない

分類不能時に、空 query、全件 query、別の widened queryへ retry してはならない。

---

## 8. `EXPLAIN` 契約

### 8.1 基本表示

次の完全な SQL を使用する。

```sql
EXPLAIN
SELECT m.製品名, t.個数
FROM APP4229 AS m
JOIN APP4228 AS t ON m.製品名 = t.製品名
WHERE t.個数 <= 100
ORDER BY t.$id
```

APP4228 側に少なくとも次の行を表示する。

```text
kintone query: 個数 <= 100
fetch: EXACT
pushdown applied: 個数 <= 100
relation: exact
```

既存の `pushdown applied:` 行名を変更しない。`pushdown normalized:` は表示しない。widening も行わないため、query は入力と同じ演算子・境界を持つ。

### 8.2 指数表記

```sql
EXPLAIN
SELECT m.製品名, t.個数
FROM APP4229 AS m
JOIN APP4228 AS t ON m.製品名 = t.製品名
WHERE t.個数 >= 1e3
ORDER BY t.$id
```

APP4228 側の表示は次とする。

```text
kintone query: 個数 >= 1000
fetch: EXACT
pushdown applied: 個数 >= 1000
relation: exact
```

### 8.3 安全整数外

```sql
EXPLAIN
SELECT m.製品名, t.個数
FROM APP4229 AS m
JOIN APP4228 AS t ON m.製品名 = t.製品名
WHERE t.個数 = 9007199254740993
ORDER BY t.$id
```

APP4228 側の表示は次とする。

```text
kintone query: 個数 = 9007199254740993
fetch: EXACT
pushdown applied: 個数 = 9007199254740993
relation: exact
```

`9007199254740992` へ丸めてはならない。

### 8.4 IN

```sql
EXPLAIN
SELECT m.製品名, t.個数
FROM APP4229 AS m
JOIN APP4228 AS t ON m.製品名 = t.製品名
WHERE t.個数 IN (-5, 0, 1e3)
ORDER BY t.$id
```

APP4228 側の表示は次とする。

【2026-08-07 訂正】実 serializer の出力形へ統一

```text
kintone query: 個数 in (-5,0,1000)
fetch: EXACT
pushdown applied: 個数 in (-5,0,1000)
relation: exact
```

大文字小文字や括弧の空白は既存 formatter 契約に従ってよいが、値と演算子は上記と同じ意味を保持する。

### 8.5 対象外 literal

```sql
EXPLAIN
SELECT m.製品名, t.個数
FROM APP4229 AS m
JOIN APP4228 AS t ON m.製品名 = t.製品名
WHERE t.個数 >= '100'
ORDER BY t.$id
```

文字列 literal を NUMBER Phase 1 として押し下げてはならない。既存 capability が型不正として拒否する場合はその診断を維持し、local-only として受理する既存経路がある場合は `join pushdown not applied:` を表示する。

---

## 9. 公開文書と歴史資料の同期

### 9.1 B84 公開表

`docs/ksql_language_reference.md` の B84 marker 内にある NUMBER 行を次へ変更する。

```markdown
| `NUMBER` | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
```

対象列:

```text
=, !=, <, >, <=, >=, in, not in
```

`src/core/optimization/__tests__/b84PushdownDocs.test.ts` は、B151 後の分類器を直積で呼び、この行を自動生成・照合する。手書き例だけを変更して分類器との drift を作ってはならない。

B84 テストの NUMBER scalar fixture は、安全整数 `1` だけでなく次を個別回帰として追加する。

- `999999999999.99985`
- `9007199254740993`
- `-5`
- `1e3`
- `-0`
- 許可範囲外の巨大 scale
- NUMBER-only `IN` / `NOT IN`
- 文字列混在 `IN` / `NOT IN`

### 9.2 言語リファレンス

`docs/ksql_language_reference.md` §6「WHERE の REST 押し下げ」を次の内容へ同期する。

1. NUMBER の8セルをすべて「押し下がる」へ変更する。
2. NUMBER は許可範囲内の numeric literal / numeric literal list に限定すると注記する。
3. NUMBER の JOIN prefilter は `exact` であると説明する。
4. 指数表記と先頭 `+` は plain decimal へ正規化されると説明する。
5. 安全整数外でも元字句を保持して押し下げると説明する。
6. CALC は対象外と明記する。
7. 算術式で包むと直接 field leaf ではなくなり押し下がらないことを明記する。
8. `numberPrecision` は保存値の丸め設定であり、B151 が query literal を設定値へ丸めないことを明記する。

### 9.3 「押し下がる形への書き換え」表

次の行は削除する。

```markdown
| JOIN 内の `売上 >= 5000000` | 非厳密比較は JOIN で押し下げない（IEEE-754 の境界） | **`売上 > 4999999`** |
```

この書き換えは B151 後に不要であり、小数値を持つ NUMBER では同義でもない。

後続の次の注意書きも削除またはB151後の契約へ改訂する。

```text
JOIN の書き換えだけは効果が限定的です。
売上 > 4999999 にすると主表は PREFILTERED...
```

改訂する場合は次の趣旨とする。

> JOIN 中の直接 NUMBER 比較は、許可範囲内の数値リテラルであれば `>=` / `<=` を含めてそのまま exact prefilter になります。整数境界への手動書き換えは不要です。フィールドを算術式や関数で包むと直接 field leaf ではなくなるため押し下がりません。

### 9.4 KLIKE 等の周辺説明

「安全な NUMBER 条件」の説明に残る次の限定を監査する。

```text
型確認済みNUMBERの `=` と安全整数との厳密な `<` / `>`
```

B151 後は次の趣旨へ変更する。

```text
型確認済みNUMBERと許可範囲内の数値リテラルによる比較・IN
```

少なくとも次を検索対象にする。

- `安全整数`
- `strict`
- `IEEE-754`
- `非厳密比較`
- `NUMBER の =`
- `NUMBER条件`
- `>= 5000000`
- `> 4999999`
- `relation: superset`
- `PREFILTERED`

### 9.5 B76 旧判断

`docs/internal/ksql_b76_join_pushdown_phase_a_spec.md` はリリース当時の歴史資料であるため、§5.2 の表を無言で現行仕様へ書き換えない。

文書冒頭または §5.2 NUMBER 行の直後に、日付付き注記を追加する。

```markdown
> **【B151 により失効・2026-08-07】**
> NUMBER 行の「IEEE-754 境界のため inclusive は不可」と安全整数限定は、
> 現行の direct NUMBER local 比較が `parseExactDecimal()` を使う10進厳密比較であること、
> および server/local の境界・空セル挙動が一致する実測により失効した。
> 現行契約は B151 R1 を参照。B76 の他型・tree 合成・ownership・residual 規則は維持する。
```

B76 の作成時点より後に10進比較器が導入されたとは書かない。文書上は v3.0.0 の型付き比較契約が B76 の基準版 v3.25.0 より前に存在するためである。

### 9.6 B84 歴史仕様

`docs/internal/ksql_b84_pushdown_visibility_spec.md` の「`>=` / `<=` を加えない」「IEEE-754 境界のため不可」という歴史記述にも、B151 で失効した旨の注記を付ける。B84 の表生成方式、型集合導出、公開文書との照合という設計自体は維持する。

### 9.7 台帳・CHANGELOG・リリース文書

次を同期する。

- `docs/ksql_issue_tracker.md` の B151 行
- `CHANGELOG.md`
- `docs/ksql_release_history.md`
- `release/README.txt`
- README やレシピに NUMBER JOIN の手動書き換えがあれば該当箇所
- MCP docs / syntax hints に安全整数限定があれば該当箇所
- engine docs smoke の期待文字列
- plugin / CLI smoke の EXPLAIN 期待文字列

CHANGELOG は次を明記する。

- 結果集合は不変
- JOIN 前の取得候補が減る性能改善
- NUMBER の8演算子が exact prefilter 対象
- safe integer 制限を解除
- widening なし
- CALC、DATE/TIME/DATETIME、TEXT は対象外
- B76/B84 の旧 IEEE-754 注記が現行契約では失効

---

## 10. 受入用データ

実機受入では、APP4229 を master、APP4228 を transaction として、少なくとも次の対応行を用意する。既存アプリを使う場合は同じ値を持つ検証専用レコードを作り、終了後に復元または削除する。

| 製品名 | APP4228 `個数` |
|---|---:|
| `B151_BOUNDARY` | `999999999999.9999` |
| `B151_EMPTY` | 空セル |
| `B151_NINE` | `9` |
| `B151_TEN` | `10` |
| `B151_NEGATIVE` | `-6` |
| `B151_ZERO` | `0` |
| `B151_THOUSAND` | `1000` |
| `B151_SAFE_PLUS_ONE` | `9007199254740993` |

APP4229 には同じ `製品名` を1件ずつ用意し、INNER JOIN で全検証行が対応するようにする。

各公開結果は少なくとも次の列で観測する。

```sql
SELECT t.$id, t.製品名, t.個数
FROM APP4229 AS m
JOIN APP4228 AS t ON m.製品名 = t.製品名
WHERE ...
ORDER BY t.$id
```

比較では `rowCount` だけでなく、返却された `t.$id` の集合と各 `個数` 値を照合する。

---

## 11. 受入条件

### 11.1 観測方法

各対象条件について、次の3経路を比較する。

1. JOIN prefilter 経路
2. JOIN の NUMBER leaf を residual にした FULL_SCAN 対照経路
3. 単一表経路

JOIN prefilter 経路:

```sql
SELECT t.$id, t.製品名, t.個数
FROM APP4229 AS m
JOIN APP4228 AS t ON m.製品名 = t.製品名
WHERE t.個数 <= 100
ORDER BY t.$id
```

FULL_SCAN 対照経路:

```sql
SELECT t.$id, t.製品名, t.個数
FROM APP4229 AS m
JOIN APP4228 AS t ON m.製品名 = t.製品名
WHERE t.個数 <= 100
   OR t.製品名 LIKE '__B151_NO_MATCH__'
ORDER BY t.$id
```

単一表経路:

```sql
SELECT $id, 製品名, 個数
FROM APP4228
WHERE 個数 <= 100
ORDER BY $id
```

FULL_SCAN 対照の `LIKE` パターンに一致するレコードが存在しないことを事前に確認する。3経路で、master に対応する検証レコードの `$id` 集合と公開値が一致しなければならない。

### 11.2 境界すれすれ — `<=`

```sql
SELECT t.$id, t.製品名, t.個数
FROM APP4229 AS m
JOIN APP4228 AS t ON m.製品名 = t.製品名
WHERE t.個数 <= 999999999999.99985
ORDER BY t.$id
```

`B151_BOUNDARY` の格納値は `999999999999.9999` であり、結果に含まれない。

`EXPLAIN` は APP4228 について次を示す。

```text
kintone query: 個数 <= 999999999999.99985
fetch: EXACT
pushdown applied: 個数 <= 999999999999.99985
relation: exact
```

### 11.3 境界すれすれ — `>=`

```sql
SELECT t.$id, t.製品名, t.個数
FROM APP4229 AS m
JOIN APP4228 AS t ON m.製品名 = t.製品名
WHERE t.個数 >= 999999999999.99985
ORDER BY t.$id
```

`B151_BOUNDARY` を含む。

3経路の `$id` 集合が一致する。

### 11.4 空セル — 下方向

```sql
SELECT t.$id, t.製品名, t.個数
FROM APP4229 AS m
JOIN APP4228 AS t ON m.製品名 = t.製品名
WHERE t.個数 < 100
ORDER BY t.$id
```

`B151_EMPTY` を含む。

次も同じ空セル判定になる。

```sql
SELECT t.$id, t.製品名, t.個数
FROM APP4229 AS m
JOIN APP4228 AS t ON m.製品名 = t.製品名
WHERE t.個数 <= 100
ORDER BY t.$id
```

### 11.5 空セル — 上方向

```sql
SELECT t.$id, t.製品名, t.個数
FROM APP4229 AS m
JOIN APP4228 AS t ON m.製品名 = t.製品名
WHERE t.個数 >= -5
ORDER BY t.$id
```

`B151_EMPTY` を含まない。

次も空セルを含まない。

```sql
SELECT t.$id, t.製品名, t.個数
FROM APP4229 AS m
JOIN APP4228 AS t ON m.製品名 = t.製品名
WHERE t.個数 > -5
ORDER BY t.$id
```

### 11.6 桁違い — 両方向

```sql
SELECT t.$id, t.製品名, t.個数
FROM APP4229 AS m
JOIN APP4228 AS t ON m.製品名 = t.製品名
WHERE t.個数 < 10
ORDER BY t.$id
```

`B151_NINE` を含み、`B151_TEN` を含まない。

```sql
SELECT t.$id, t.製品名, t.個数
FROM APP4229 AS m
JOIN APP4228 AS t ON m.製品名 = t.製品名
WHERE t.個数 >= 10
ORDER BY t.$id
```

`B151_TEN` を含み、`B151_NINE` を含まない。

文字列順の `"10" < "9"` にならないことを確認する。

### 11.7 負リテラル

```sql
SELECT t.$id, t.製品名, t.個数
FROM APP4229 AS m
JOIN APP4228 AS t ON m.製品名 = t.製品名
WHERE t.個数 <= -5
ORDER BY t.$id
```

`B151_NEGATIVE` を含む。`B151_ZERO` と `B151_EMPTY` の挙動は §4.4 の順序に従う。

query は `個数 <= -5` のままであり、`< -4` へ変形しない。

### 11.8 指数表記

```sql
SELECT t.$id, t.製品名, t.個数
FROM APP4229 AS m
JOIN APP4228 AS t ON m.製品名 = t.製品名
WHERE t.個数 = 1e3
ORDER BY t.$id
```

`B151_THOUSAND` を含む。

`EXPLAIN` と実際の records API query は次を使う。

```text
個数 = 1000
```

`1e3` をそのまま送らず、binary64 から再生成した別値も送らない。

### 11.9 `+0` / `-0`

```sql
SELECT t.$id, t.製品名, t.個数
FROM APP4229 AS m
JOIN APP4228 AS t ON m.製品名 = t.製品名
WHERE t.個数 = -0
ORDER BY t.$id
```

```sql
SELECT t.$id, t.製品名, t.個数
FROM APP4229 AS m
JOIN APP4228 AS t ON m.製品名 = t.製品名
WHERE t.個数 = +0
ORDER BY t.$id
```

両方の `$id` 集合が一致し、`B151_ZERO` を含む。query はどちらも `個数 = 0` とする。

空セルは `= 0` に一致しない。

### 11.10 安全整数外

```sql
SELECT t.$id, t.製品名, t.個数
FROM APP4229 AS m
JOIN APP4228 AS t ON m.製品名 = t.製品名
WHERE t.個数 = 9007199254740993
ORDER BY t.$id
```

`B151_SAFE_PLUS_ONE` を含む。

query、EXPLAIN、local residual のいずれにも `9007199254740992` を使用してはならない。

### 11.11 `=` の exact 昇格

```sql
EXPLAIN
SELECT t.$id, t.製品名, t.個数
FROM APP4229 AS m
JOIN APP4228 AS t ON m.製品名 = t.製品名
WHERE t.個数 = 10
ORDER BY t.$id
```

次を表示する。

```text
pushdown applied: 個数 = 10
relation: exact
fetch: EXACT
```

現行の `relation: superset` を残してはならない。

### 11.12 `!=` / `<>`

```sql
SELECT t.$id, t.製品名, t.個数
FROM APP4229 AS m
JOIN APP4228 AS t ON m.製品名 = t.製品名
WHERE t.個数 != 10
ORDER BY t.$id
```

```sql
SELECT t.$id, t.製品名, t.個数
FROM APP4229 AS m
JOIN APP4228 AS t ON m.製品名 = t.製品名
WHERE t.個数 <> 10
ORDER BY t.$id
```

両結果の `$id` 集合が一致する。

- `B151_TEN` を含まない
- `B151_NINE` を含む
- `B151_EMPTY` を含む
- `relation: exact`
- `fetch: EXACT`

### 11.13 `IN`

```sql
SELECT t.$id, t.製品名, t.個数
FROM APP4229 AS m
JOIN APP4228 AS t ON m.製品名 = t.製品名
WHERE t.個数 IN (-6, 10, 1e3)
ORDER BY t.$id
```

次を含む。

- `B151_NEGATIVE`
- `B151_TEN`
- `B151_THOUSAND`

次を含まない。

- `B151_EMPTY`
- `B151_NINE`
- `B151_ZERO`

query は次とする。

【2026-08-07 訂正】実 serializer の出力形へ統一

```text
個数 in (-6,10,1000)
```

### 11.14 `NOT IN`

```sql
SELECT t.$id, t.製品名, t.個数
FROM APP4229 AS m
JOIN APP4228 AS t ON m.製品名 = t.製品名
WHERE t.個数 NOT IN (-6, 10, 1e3)
ORDER BY t.$id
```

次を含まない。

- `B151_NEGATIVE`
- `B151_TEN`
- `B151_THOUSAND`

次を含む。

- `B151_EMPTY`
- `B151_NINE`
- `B151_ZERO`

3経路の `$id` 集合が一致する。

### 11.15 prefilter 有無で rows 同一

各 scalar 演算子と `IN` / `NOT IN` について、通常形と NUMBER leaf を residual にした形を比較する。

通常形:

```sql
SELECT t.$id, t.製品名, t.個数
FROM APP4229 AS m
JOIN APP4228 AS t ON m.製品名 = t.製品名
WHERE t.個数 >= -5
ORDER BY t.$id
```

residual 対照形:

```sql
SELECT t.$id, t.製品名, t.個数
FROM APP4229 AS m
JOIN APP4228 AS t ON m.製品名 = t.製品名
WHERE t.個数 >= -5
   OR t.製品名 LIKE '__B151_NO_MATCH__'
ORDER BY t.$id
```

公開 `rows`、`columns`、`rowCount` が一致する。順序は明示した `ORDER BY t.$id` に従う。

### 11.16 算術経由の対照

算術式はB151 prefilter 対象外であることを確認する。

```sql
EXPLAIN
SELECT t.$id, t.製品名, t.個数
FROM APP4229 AS m
JOIN APP4228 AS t ON m.製品名 = t.製品名
WHERE t.個数 + 0 >= 999999999999.99985
ORDER BY t.$id
```

`個数 + 0` を NUMBER direct-field prefilter として送ってはならない。実行結果は起票で確定した3経路実測を再確認するが、この算術経路を direct-field exact 証明の実装依存先にしてはならない。

### 11.17 対象外 literal

次はB151 NUMBER prefilter に採用しない。

```sql
SELECT t.$id, t.製品名, t.個数
FROM APP4229 AS m
JOIN APP4228 AS t ON m.製品名 = t.製品名
WHERE t.個数 >= '100'
ORDER BY t.$id
```

```sql
SELECT t.$id, t.製品名, t.個数
FROM APP4229 AS m
JOIN APP4228 AS t ON m.製品名 = t.製品名
WHERE t.個数 IN (10, '20')
ORDER BY t.$id
```

```sql
SELECT t.$id, t.製品名, t.個数
FROM APP4229 AS m
JOIN APP4228 AS t ON m.製品名 = t.製品名
WHERE t.個数 >= 1e-11
ORDER BY t.$id
```

```sql
SELECT t.$id, t.製品名, t.個数
FROM APP4229 AS m
JOIN APP4228 AS t ON m.製品名 = t.製品名
WHERE t.個数 >= 1000000000000000000000000000000
ORDER BY t.$id
```

既存の型エラーになる形は取得前に同じエラーを返す。SQLとしてlocal-onlyが許される形は、NUMBER B151 leaf として押し下げない。

### 11.18 CALC 非回帰

数値形式 CALC に同じ演算子を書いても、B151 を理由に押し下げない。

```sql
EXPLAIN
SELECT a.$id, a.計算値
FROM APP100 AS a
JOIN APP101 AS b ON a.キー = b.キー
WHERE a.計算値 <= 100
ORDER BY a.$id
```

`計算値` が CALC なら `join pushdown not applied:` を維持し、`relation: exact` を表示しない。

### 11.19 outer join 非回帰

```sql
EXPLAIN
SELECT m.製品名, t.個数
FROM APP4229 AS m
LEFT JOIN APP4228 AS t ON m.製品名 = t.製品名
WHERE t.個数 <= 100
ORDER BY m.$id
```

B151 により NUMBER prefilter を適用しない。外部結合の preserved / non-preserved side に関する既存契約を変更しない。

### 11.20 B84 文書パリティ

次をすべて満たす。

1. NUMBER の8セルがすべて `○`
2. CALC の8セルがすべて `✕`
3. 分類器を1セル壊すと文書パリティテストが落ちる
4. 文書の NUMBER セルを1つ戻すとテストが落ちる
5. 型集合は従来どおり分類器ソースから導出する
6. 「正規化 → 分類」の観測順を維持する
7. NUMBER の指数・安全整数外・IN list の追加条件を専用テストで固定する

### 11.21 既存 B76 合成規則

次を回帰させない。

- ownership
- 曖昧な非修飾 field の拒否
- cross-alias `OR`
- 同一 alias `OR`
- GROUP
- KLIKE-containing `OR`
- server-only function の第5-W / 第5-L
- outer join 非適用
- CTE / temp / subtable source 非適用
- search-aborted fail-closed
- 元 WHERE residual の維持

### 11.22 全 surface

同じ SQL、同じアプリデータ、同じ `maxRecords` で次を確認する。

- Node engine
- CLI
- MCP
- Firefox plugin
- Chrome plugin
- engine library

各 surface で次が一致する。

- `rows`
- `columns`
- `rowCount`
- NUMBER の公開文字列値
- エラー分類
- `EXPLAIN` の query
- `relation`
- fetch scope
- warning

ブラウザ smoke は Node の unit test や CLI smoke で代替しない。

---

## 12. Phase 1 の線引き

### 12.1 Phase 1 に含めるもの

- 物理 APP の direct NUMBER field
- numeric scalar literal
- numeric literal だけの `IN` / `NOT IN`
- `=` / `!=` / `<>` / `<` / `>` / `<=` / `>=`
- 安全整数外の有限10進
- 負数
- 小数
- 許可範囲内の指数表記
- `+0` / `-0`
- relation の exact 化
- EXPLAIN
- B84 表
- 言語リファレンス
- B76 / B84 歴史注記
- unit、integration、実機、全 surface smoke

### 12.2 Phase 1 に含めないもの

- CALC
- DATE / TIME / DATETIME / CREATED_TIME / UPDATED_TIME の range
- TEXT 系
- 選択系の追加拡張
- RECORD_NUMBER
- `$id` 契約の変更
- arithmetic field
- function field
- CASE
- aggregate / window result
- field-to-field comparison
- scalar subquery
- `IN (SELECT ...)`
- outer join
- CTE / temp / derived source への server pushdown
- residual elimination
- widening
- app-specific `numberPrecision` に合わせた literal 丸め
- query literal の constant folding
- 巨大 scale の一般対応

### 12.3 Phase 2 候補

優先順は次とする。

1. DATE の canonical literal range
2. TIME の canonical literal range
3. DATETIME / CREATED_TIME / UPDATED_TIME の canonical UTC range
4. 数値形式 CALC
5. 日付・時刻形式 CALC
6. TEXT 等値・不等値・IN の exact 化
7. NUMBER のB151許可範囲を超える query boundary

各 Phase は、型固有の server/local 意味論表と実機境界証拠を別に持つ。

---

## 13. 実測すべき未確認事項

### 13.1 `numberPrecision` 変更アプリ

既定16桁・小数4桁だけで完了としてはならない。

少なくとも次の設定を持つアプリを用意する。

| digits | decimalPlaces | roundingMode |
|---:|---:|---|
| 16 | 4 | HALF_EVEN |
| 30 | 10 | HALF_EVEN |
| 30 | 0 | HALF_EVEN |
| 10 | 2 | UP |
| 10 | 2 | DOWN |

各設定で次を確認する。

- 保存直後の実値
- direct NUMBER local 比較
- 単一表 server 比較
- JOIN exact prefilter
- JOIN residual 対照
- `<=` / `>=`
- `=` / `!=`
- `IN` / `NOT IN`
- 空セル
- 設定の decimalPlaces を超える query literal
- 設定の整数桁予算を超える query literal
- 最大30桁・小数10桁付近

### 13.2 query literal の受理範囲

次を段階的に測る。

```text
1e29
1e-10
999999999999999999999999999999
99999999999999999999.9999999999
0.00000000001
1e30
```

B151許可範囲内の値が kintone query に拒否される場合、classifier の許可範囲を実測結果に合わせて狭める。拒否を全件取得 retry で隠してはならない。

### 13.3 `IN` / `NOT IN`

次を確認する。

- 1要素
- 複数要素
- 重複値
- `1`, `1.0`, `1e0` の同値要素
- `0`, `-0`, `+0`
- 安全整数外
- 空セル
- 負数
- 最大桁
- list 順序の違い
- 未解決変数解決後
- 配列変数展開後

### 13.4 query と residual の同一 literal

server query と residual が同じ10進境界を使うことを、spy または公開結果で確認する。

特に次を固定する。

```text
SQL raw:            9007199254740993
server query:       9007199254740993
local right value:  9007199254740993
```

```text
SQL raw:            1e3
server query:       1000
local right value:  1000
```

### 13.5 fetch scope

単独の NUMBER leaf が exact の場合、対象 APP の fetch scope が `EXACT` になることを確認する。

NUMBER exact leaf と既存 superset leaf を同じ alias で `AND` した場合、plan item 全体が `superset`、fetch scope が `PREFILTERED` になることも確認する。

### 13.6 取得上限

NUMBER prefilter によって従来の全件取得が上限エラーだった SQL が成功する例を1件含める。ただし prefilter 後も上限を超える場合は既存の complete-input / fetch limit 契約どおりエラーにする。

B151 を理由に `onLimit=truncate`、search-aborted、outer join の安全規則を緩和しない。

---

## 14. 実装手順

### Step 1: pure NUMBER literal policy

- B151許可範囲を判定する pure helper を追加
- scalar / list の unit test
- 巨大 scale を展開前に拒否
- `raw` 保存、指数、符号、安全整数外を固定

この Step だけでは本番 classifier の結果を変えない。

### Step 2: JOIN classifier

- NUMBER 分岐を exact policy へ変更
- `$id` / RECORD_NUMBER / CALC を変更しない
- tree 合成、ownership、whereCapability gate を維持
- classifier unit test を追加

### Step 3: runtime と EXPLAIN

- 実行と EXPLAIN が同じ runtime JOIN plan を使うことを確認
- `pushdown applied:`
- `relation: exact`
- `fetch: EXACT`
- exponent の plain decimal 表示
- residual original WHERE の維持

実行だけ、または EXPLAIN だけを先に開放してはならない。

### Step 4: B84・公開文書

- B84生成表
- 言語リファレンス
- 書き換え表
- KLIKE周辺説明
- B76/B84歴史注記
- tracker / CHANGELOG / release docs
- docs parity test

### Step 5: 実機と全 surface

- APP4228/4229 の境界実測
- `numberPrecision` 変更アプリ
- CLI / MCP
- Firefox / Chrome
- engine library
- before / after の EXPLAIN と rows
- version / manifest / release artifact gate

---

## 15. 完了条件

B151 は次をすべて満たした場合だけ完了とする。

1. NUMBER の `=` / `!=` / `<` / `>` / `<=` / `>=` / `IN` / `NOT IN` が、許可 numeric literal 条件下で `exact` になる。
2. widening を行わない。
3. `<` / `>` の安全整数制限が解除される。
4. 安全整数外の元字句が失われない。
5. 空セルの両方向が server/local で一致する。
6. 境界すれすれペアが3経路で一致する。
7. prefilter 有無で公開 rows が一致する。
8. 桁違い、負数、指数、`+0` / `-0` が一致する。
9. `IN` / `NOT IN` が一致する。
10. CALC、DATE/TIME/DATETIME、TEXT は開放されない。
11. `EXPLAIN` が実行時 query、relation、fetch scope と一致する。
12. B84 公開表が分類器から生成され、NUMBER の8セルがすべて `○` になる。
13. `>= 5000000` を `> 4999999` へ変える案内が削除または改訂される。
14. B76/B84 の旧 IEEE-754 判断に、B151で失効した旨の歴史注記が付く。
15. v3.0.0 と B76 の前後関係を誤って記述しない。
16. `numberPrecision` を変更したアプリで実測する。
17. 全 surface の公開結果が一致する。
18. ブラウザ smoke を実ブラウザで通す。
19. 既存の ownership、tree 合成、server-only function、outer join、search-aborted、取得上限の契約を回帰させない。
20. CHANGELOG、tracker、公開文書、manifest、release artifact が同じ版・同じ契約を示す。
