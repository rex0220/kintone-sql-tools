# B124 集計算術式の非集計オペランド Phase 1 仕様（R2）

- ステータス: ✅ **v3.46.0 でリリース済み**（2026-08-05・npm publish 済み・`npm test` 5,383 件成功・MCP 再読み込み後に実機で既知期待値と一致） → [レビュー](ksql_b124_codex_review_1.md)（高 4・中 4・低 2 を**全件反映**）
- 対象: 案 C（文書）＋ A1（`@変数`）＋ A2（`GROUP BY` キー）を **1 本の Phase 1** とする
- 関連: [B124 起票](ksql_b124_aggregate_arithmetic_nonaggregate_operand_issue.md) /
  [B122](ksql_b122_having_aggregate_expression_issue.md)・[B121](ksql_b121_having_numeric_comparison_issue.md)（`HAVING` の非対称を潰した直後）/
  [B65](ksql_b65_rollup_grouping_sets_spec.md)（**grouping sets は本件のスコープ外**・§1.1）

> **R1 からの主な訂正**（詳細は §12）
> - **`SUM(a) * c` と `SUM(a * c)` は同値ではない。** binary64 の丸めが違い、
>   **非数値キーでは外側 `NaN` / 内側 `0`** になる（実測）。R1 の中核だった「同値条件」を撤回した
> - **`ROLLUP` / `CUBE` / `GROUPING SETS` では定数性が成立しない**（小計行で除外キーが `""` に上書きされる・実測）。**明示的に拒否**する
> - **非集計オペランドから始まる形は入口に到達しない**（`単価 * SUM(a)`）。**Phase 1 は集計関数始まりに限定**する
> - **`AGG_VARIABLE` は既存の変数解決器を通らない。** 専用タグをやめ、既存の `VariableRef` を再利用する
> - **`CaseResult` は `AggOperand` を含んでいない**（`AggregateRef | AggArithExpr`）。R1 の波及記述は誤り

---

## 0. 確定事項（実測で確認）

| 事実 | 確認 | 意味 |
|---|---|---|
| オペランドは**集計関数・数値リテラル・括弧・単項マイナス**のみ | `parseAggPrimary` | 意図的な fail-closed |
| **`@変数` も拒否される** | `SUM(仕入価格) * @r` → ParseError（位置 35） | A1 の射程 |
| **`HAVING` も同じ `parseAggPrimary` を通る** | `HAVING SUM(仕入価格) * 分類 > 100` → ParseError（位置 70） | 許可が既定の帰結。拒否には追加チェックが要る |
| **ordinary GROUP BY なら修飾名は出力行から引ける** | `flatten(record, "m")` が `m.仕入価格` と `仕入価格` の両キーを書き（`process.ts:95-108`）、`outRow = { ...groupRows[0] }`（`process.ts:291-306`）。`resolveFieldRef` が両方を解決（`evalFunc.ts:734-742`） | **条件つきで OK**＝evaluator が `resolveFieldRef` を使うこと（§6） |
| **grouping sets では成立しない** | `GROUP BY ROLLUP(分類, 生産状況)` の小計行は `分類=食品, 生産状況=""`、総計行は両方 `""`（実測）。`outRow[item.directKey] = includedValues.get(...) ?? ""` | **§1.1 で拒否** |
| **非数値の算術は既存でも `NaN`** | `SELECT 製品名 * 2` → `NaN` | 外側の挙動 |
| **内側形は非数値で `0`** | `SUM(仕入価格 * 分類)` → **`0`**（実測）。`evalArithExpr` が `NaN` → 行スキップ → 空の `SUM` は `0` | **外側と食い違う**（§3.3） |
| `HAVING` の集計算術式は押し下げない | `whereToKintone.ts:172-174` が `AGG_FIELD` を拒否 | 押し下げ検討は不要 |
| 既存の算術変数は**非数値で `ArgumentError`** | `execute.ts:2070-2132` | `@変数` は `NaN` にしない（§3.3） |

---

## 1. スコープ

| 区分 | 内容 |
|---|---|
| **対象** | 集計算術式のオペランドに **`@変数`**（A1）と **ordinary `GROUP BY` キーのフィールド参照**（A2）を許可 |
| **対象の形** | **集計関数から始まる式のみ**（`SUM(a) * 単価` / `SUM(a) * @r`）。§1.2 |
| **対象位置** | SELECT 列 と `HAVING`（同じ `AggOperand` を共有・§3.4） |
| **対象（文書）** | 言語リファレンス §8（案 C） |
| **非対象** | **`ROLLUP` / `CUBE` / `GROUPING SETS`**（§1.1） |
| **非対象** | **非集計から始まる形**（`単価 * SUM(a)` / `@r * SUM(a)` / `(単価 + SUM(a))`）。§1.2 |
| **非対象** | 機能従属性の推論／スカラーサブクエリのオペランド／`GROUP BY` の無い SELECT でのフィールド参照 |

### 1.1 grouping sets を拒否する理由（実測）

```
> SELECT 分類, 生産状況, COUNT(*) FROM APP4229 GROUP BY ROLLUP(分類, 生産状況)
食品  生産可能  3
食品  生産終了  1
食品  (空)      4     ← 小計行: 生産状況 が "" に上書きされる
(空)  (空)      8     ← 総計行: 両方 ""
```

小計・総計行では、その grouping set から外れた列が `""` になる。したがって

- SELECT 側（元行から読む）は**実際の値**（`'生産可能'` 等）
- `HAVING` 側（出力行から読む）は **`""`**（→ `Number("") === 0`）

**同じ式が SELECT と `HAVING` で違う値になる。** これは B121/B122 で潰したばかりの形なので、
**Phase 1 では `grouping !== undefined` の SELECT で `AGG_GROUP_KEY` を明示拒否する。**

> parser は ordinary `groupBy` と `grouping` を別プロパティに持ち、
> `ROLLUP` / `CUBE` / `GROUPING SETS` のとき `groupBy` は空のまま（`parser.ts:1138-1154`）。
> **「`groupBy` に含まれるか」で判定すれば自動的に拒否される**が、
> 診断を分けるため明示的に検査する（§5.3）。

### 1.2 集計関数始まりに限定する理由

既存の入口は、**式が集計関数から始まるときだけ**集計算術式の経路へ入る。

- SELECT 列: 先頭が `@変数` なら `VARIABLE_COL`（`AS` 必須）へ。集計関数のときだけ `continueAggArith(ref)`（`parser.ts:1282-1378`）
- `HAVING` 左辺: 同じく集計関数始まりのときだけ `AGG_FIELD` を作る（`parser.ts:2574-2596`）
- `CASE` 結果・文字列関数引数も同様

**任意順を許すには 4 つの入口すべてに「式全体に集計を含むか」で振り分ける設計が要る。**
実証された実需（`SUM(t.個数_在庫計算用) * m.仕入価格`）は集計関数始まりなので、
**Phase 1 は限定し、非集計始まりは明示的に拒否**する。緩和は後から純加法。

---

## 2. 構文

```
<集計算術式> := <集計関数呼び出し> [ (+|-|*|/|%) <被演算子> ]...
<被演算子>   := <集計関数呼び出し>
              | <数値リテラル>
              | ( <集計算術式> )
              | - <被演算子>
              | @変数                              ← 追加（A1）
              | <ordinary GROUP BY キーの表記>       ← 追加（A2・§3.2 の表記一致）
```

**先頭は必ず集計関数呼び出し**（§1.2）。

```sql
-- 実証された実需の形
SELECT m.製品番号, m.製品名, m.仕入価格,
       SUM(t.個数_在庫計算用) * m.仕入価格 AS 在庫金額
FROM APP4229 m LEFT JOIN APP4228 t ON m.製品名 = t.製品名
GROUP BY m.製品番号, m.製品名, m.仕入価格

-- @変数（A1）
SET @rate = 1.1;
SELECT 分類, SUM(仕入価格) * @rate AS 税込 FROM APP4229 GROUP BY 分類
```

---

## 3. 意味論

### 3.1 定数性の根拠（ordinary GROUP BY のみ）

ordinary `GROUP BY` のキーは、`applyGroupBy` がキーを raw 文字列の連結で作るため
（`process.ts:267-277`）、**raw 表記まで含めてグループ内で一定**である。
`"1"` と `"01"` は別グループになるので、B125 の `MIN`/`MAX` で問題になった
「canonical 同値の raw 表記が不定」は本件には無い。

**grouping sets では成立しない**（§1.1）。

`@変数` は文の実行前に解決されるスカラーで、構造的に定数。

### 3.2 `GROUP BY` キーの同一性（表記一致・意図的に狭い契約）

**Phase 1 は「ordinary `GROUP BY` に `FIELD_NAME` として書かれた表記と、文字どおり一致すること」だけを許可する。**

- `GROUP BY m.仕入価格` → `SUM(a) * m.仕入価格` は可、`SUM(a) * 仕入価格` は**不可**
- `GROUP BY` に式・関数として書かれたキー（`GROUP BY DATE_FORMAT(日付,'%Y-%m')`）は**不可**
- SELECT alias を `GROUP BY` に書いた形も**不可**

> **なぜ狭くするか**: 既存の `GROUP BY` 名前解決は metadata-backed で、
> 物理フィールド優先・無ければ SELECT alias へ fallback し、JOIN の非修飾名は曖昧になり得る
> （`plainGroupByPlan.ts:177-205`）。**パース時の文字列だけでは同一性を確定できない。**
> `ParseError` として即座に返す診断を優先し、**表記一致という確定できる規則に狭める**。
> 緩和（canonical 解決を使う）は後から純加法で、逆に後から狭めるのは破壊的変更になる。

### 3.3 非数値オペランド（**外側と内側は食い違う**）

| 形 | 非数値のキーを掛けたとき |
|---|---|
| 外側 `SUM(a) * 分類`（本件で許可する形） | **`NaN`**（`evalAggArithExpr` が `Number` 化して掛ける） |
| 内側 `SUM(a * 分類)`（従来の回避策） | **`0`**（各行 `NaN` → 集計入力から除外 → 空の `SUM` は `0`） |

**両者は同値ではない。** R1 はここを「既存の算術と同じ規則だから問題ない」と書いていたが誤り。
**外側の `NaN` を単独の期待値として受け入れ、内側との同値は主張しない**（§8.3）。

`@変数` は別扱い。**既存の算術変数は非数値で `ArgumentError`**（`execute.ts:2070-2132`）なので、
**`NaN` にせず既存どおりエラー**にする。空セルは既存規則どおり `0`（`Number("") === 0`）。

### 3.4 `HAVING` の扱い（**許可**）

R1 から変更なし。パーサを共有しているため許可が既定の帰結であり、拒否すると
B121/B122 で潰した「別名なら通る / 直接なら通らない」の非対称が再発する。
`HAVING` はグループ化の後に走り、出力行にグループキー列が入っている（§0）。

---

## 4. AST

```ts
export type AggOperand =
  | AggregateRef
  | NumberLiteral
  | AggArithExpr
  | AggGroupKeyRef      // 追加（A2）
  | VariableRef;        // 追加（A1）— 既存型を再利用する

/** ordinary GROUP BY キーとして表記一致を検証済みのフィールド参照。 */
export interface AggGroupKeyRef {
  type: "AGG_GROUP_KEY";
  field: string;
  tableAlias?: string;
}
```

**`AGG_VARIABLE` という専用タグは作らない**（R1 からの変更）。既存の変数解決器・
未解決変数の backstop・静的参照解析は `type === "VARIABLE"` だけを見ており
（`execute.ts:2070-2132` / `2194-2211` / `core/batch.ts:154-180`）、
新タグでは**値へ置換されず、参照としても数えられない**。
**既存の `VariableRef` を再利用すれば、`AGG_ARITH.left/right` を再帰する既存経路が
そのまま `NUMBER` へ置換してくれる。**

`AGG_GROUP_KEY` は専用タグのままにする。**「検証を通ったものだけがここに来る」**ことを型で表すため。

---

## 5. パーサ

### 5.1 変更点

`parseAggPrimary` に 2 分岐（変数トークン → `VariableRef` / 識別子 → `AGG_GROUP_KEY` 候補）。
**先頭は集計関数のまま**（§1.2）なので、既存の入口（`parseSelectColumn` / `HAVING` /
`CASE` 結果 / 文字列関数引数）の振り分けは変えない。

### 5.2 検証のタイミング

`parseAggPrimary` の時点で `GROUP BY` 句はまだ読まれていない。
→ **`GROUP BY` を読み終えた後、SELECT 全体（SELECT 列・`HAVING`・`CASE` 内・文字列関数引数）を
走査して検証する。** 既存の併用チェックと同じ位置（`parser.ts:1123-1208` の `parseSelect` 内）。

**候補ノードには位置情報とトークンを保持**し、`ParseError` を B120 と同じ形で出す。

**`WITH` / `UNION` / サブクエリは各 SELECT ごとに独立して検証する**
（内側の SELECT が外側の `GROUP BY` キーを参照できてはならない）。受入 §8.4-6。

### 5.3 診断

| 入力 | メッセージ |
|---|---|
| ordinary `GROUP BY` に無い表記 | `集計算術式のフィールド参照は GROUP BY に書いた表記と一致する列だけです（<列名>）。グループ内で値が定まらないためです。` |
| `GROUP BY` の無い SELECT | `集計算術式にフィールドを書くには GROUP BY が必要です（<列名>）。` |
| `ROLLUP`/`CUBE`/`GROUPING SETS` | `ROLLUP / CUBE / GROUPING SETS では集計算術式にフィールドを書けません（小計・総計行で値が定まらないためです）。` |
| 非集計から始まる形（`単価 * SUM(a)`） | `集計算術式は集計関数から始まる必要があります（<トークン>）。` |
| 従来どおりの不正トークン | 既存（**本文を変えない**・§8.4-4） |

---

## 6. 評価

| サイト | 関数 | 取り出し方 |
|---|---|---|
| SELECT 列 | `evalAggArithExpr(node, rows, …)`（`process.ts:685-701`） | `rows[0]` から **`resolveFieldRef` で**引く |
| `HAVING` | `evalMaterializedAggregateOperand(expr, row)`（`evalFunc.ts:717-731`） | 出力行から **`resolveFieldRef` で**引く |

**両サイトとも `row[node.field]` を直接読んではいけない。** `resolveFieldRef` は
`m.仕入価格` → 無ければ `仕入価格` の順で解決する（`evalFunc.ts:734-742`）。
直接読むと修飾名の有無で食い違う。

- `AGG_GROUP_KEY` → 上記で raw 値を取り `Number(...)`。`NaN` はそのまま（§3.3）
- `VariableRef` → **評価時には既に `NUMBER` へ置換済み**（§4）。evaluator 側の分岐は不要
- **`evalAggArithExpr` / `evalMaterializedAggregateOperand` は現在
  「NUMBER でも AGG_REF でもなければ `AGG_ARITH`」と決め打ちしている**ため、
  新 leaf を足すと壊れる（レビュー分類 (c)）。**両方に leaf 分岐を追加する**

---

## 7. 既存箇所への影響

**レビューの完全一覧を正とする**（→ [レビュー §3.2](ksql_b124_codex_review_1.md)）。分類は
**(a) 影響なし / (b) 処理が要る / (c) 型追加でコンパイルが壊れる**。

**(c) の 8 箇所は必ず直す**:

| ファイル | 内容 |
|---|---|
| `src/engine/process.ts:685-701` `evalAggArithExpr` | leaf 分岐の追加（§6） |
| `src/engine/evalFunc.ts:717-731` `evalMaterializedAggregateOperand` | 同上 |
| `src/engine/evalFunc.ts:703-714` `evalStringFuncArg` | 新 tag が `evalScalarValueExpr` へ流れる |
| `src/engine/process.ts:1596-1600` `stringFuncDefaultKey` | 拡張 `StringFuncArg` と不整合 |
| `src/core/aggregateExpression.ts:126-130` `aggregateOperandLabel` | **`key` と `@var` の安定ラベルが要る**（合成キー名が変わると `HAVING`/`ORDER BY` の解決が壊れる） |
| `src/core/aggregateExpression.ts:72-95` CASE/string labels | 同上 |
| `src/converter/selectToKintone.ts:289-324` simple field collector | **`AGG_GROUP_KEY` は取得対象に必要**、変数は不要 |
| `src/converter/dmlToKintone.ts:250-286` 共通 collector | narrowing 更新（DML では集計到達は元々拒否） |

**(b) の主なもの**: `parser.ts` の各入口と `parseSelect` の検証、
`selectToKintone.ts:568-582` の `walkAgg`（`addFieldRef` が要る）、
`execute.ts` の変数解決（**`VariableRef` 再利用なら既存経路で足りる**）。

> **`CaseResult` は `AggOperand` を含まない**（`AggregateRef | AggArithExpr`・`ast.ts:401-412`）。
> R1 は「CASE へ自動波及する」と書いていたが誤り。**波及するのは `StringFuncArg` のみ**。

---

## 8. 受入条件

### 8.1 実需の形（実データ・既知の期待値）

```sql
SELECT m.製品番号, m.製品名, m.仕入価格,
       SUM(t.個数_在庫計算用) * m.仕入価格 AS 在庫金額
FROM APP4229 m LEFT JOIN APP4228 t ON m.製品名 = t.製品名
GROUP BY m.製品番号, m.製品名, m.仕入価格
```

**既知の期待値**（`ksql-analytics` のレポートで確定済み・整数）:
緑茶 10,680 / 牛乳 147,350 / バター 29,200 / 野菜ジュース 18,050 /
食パン 137,800 / トマト缶 78,840 / ほうじ茶 27,040 / ライ麦パン 33,750。**合計 482,710**

**整数データなので回避形 `SUM(t.個数_在庫計算用 * m.仕入価格)` とも一致する。**
一般の同値は主張しない（§8.3）。

### 8.2 SELECT と `HAVING` の一致（B121/B122 の再発防止）

同じ式を SELECT・`HAVING` 直接・`HAVING` 別名の**3 経路**で書き、行集合が一致すること。
**閾値は桁を変えて両方向で置く**（桁が揃うと文字列比較でも通り検出力が無い）。
`@変数` でも同形の 3 経路を確認する。

### 8.3 同値を主張しないケース（**R1 からの訂正点**）

| 入力 | 期待 |
|---|---|
| 非数値のグループキー（`SUM(a) * 分類`） | 外側 **`NaN`**。内側 `SUM(a * 分類)` は **`0`**。**一致を要求しない** |
| 小数を含む（`aᵢ = 0.1` を 10 件・`c = 0.1`） | 外側 `0.09999999999999999` / 内側 `0.10000000000000003` 相当。**相対誤差で比較**し、厳密一致を要求しない |
| 空セルを含む | `Number("") === 0` の既存規則。外側・内側それぞれの期待値を**独立に**固定 |
| 全行が `NaN` | 外側 `NaN` / 内側 `0`。独立に固定 |
| `@変数` が非数値 | **`ArgumentError`**（既存の算術変数と同じ。`NaN` にしない） |

### 8.4 拒否（fail-closed）

1. `GROUP BY` に無い列 → ParseError
2. `GROUP BY` の無い SELECT → ParseError
3. **`ROLLUP` / `CUBE` / `GROUPING SETS` → ParseError**（SELECT・`HAVING` 両方）
4. **非集計始まり**（`単価 * SUM(a)` / `@r * SUM(a)` / `(単価 + SUM(a))`）→ ParseError
5. **表記不一致**（`GROUP BY m.仕入価格` に対する `仕入価格`）→ ParseError
6. **入れ子の SELECT が外側の `GROUP BY` キーを参照** → ParseError（`WITH` / `UNION` / サブクエリ）

### 8.5 回帰（必須）

1. **alias が落ちないこと**（`SUM(a) * 単価 AS x` / `SUM(a) - SUM(b) AS diff` /
   `SUM(a) AS x - SUM(b)` = ParseError のまま）。集計算術式 alias 消失バグの回帰を**全件再実行**
2. **B119〜B122 の受入を全件再実行**
3. **`CASE` の中・文字列関数の引数**の既存形が不変（`StringFuncArg` のみ波及・§7）
4. **既存の ParseError 本文が変わらない**（B120 のメッセージ照合テスト）
5. 既存の拒否が緩まない（`SUM(売上 > 0)` / `SUM(SUM(x))` / `MODE(DISTINCT ...)`）
6. `ORDER BY` の alias 参照・`UNION`・CTE 経由で壊れない
7. **合成キー名（alias 無し）が既存形で変わらない**（`aggregateOperandLabel`・§7）

---

## 9. 文書

言語リファレンス §8 に、**許可・拒否・同値でないことの 3 点**を書く。

```markdown
集計を含む算術式は**集計関数から始まり**、被演算子には集計関数・数値リテラル・`@変数`・
**ordinary `GROUP BY` に書いた表記と一致する列**を書けます。

  SELECT 分類, SUM(売上) * 単価 FROM APP1 GROUP BY 分類, 単価   -- 可
  SELECT 分類, SUM(売上) * 担当者 FROM APP1 GROUP BY 分類       -- 不可（GROUP BY に無い）
  SELECT 分類, 単価 * SUM(売上) FROM APP1 GROUP BY 分類, 単価   -- 不可（集計関数始まりでない）

`ROLLUP` / `CUBE` / `GROUPING SETS` では書けません（小計・総計行で値が定まらないため）。

**`SUM(a) * 単価` と `SUM(a * 単価)` は同じ値になるとは限りません。** 小数では丸めの位置が違い、
非数値の列では前者が `NaN`、後者が `0` になります。
```

---

## 10. スコープ外と回避策

| 要望 | Phase 1 での書き方 |
|---|---|
| `単価 * SUM(a)` と書きたい | `SUM(a) * 単価` に並べ替える |
| `GROUP BY` に無い列を掛けたい | `GROUP BY` に足す（**表記も合わせる**） |
| grouping sets で使いたい | 不可。CTE で小計を作ってから掛ける |
| スカラーサブクエリを掛けたい | `SET @x = (SELECT …)` で変数にしてから掛ける |

---

## 11. 未確定（R3 までに詰める）

1. ~~修飾名の出力行キー名~~ → **解決**（§0・ordinary GROUP BY なら `resolveFieldRef` で引ける）
2. ~~`AggOperand` 走査箇所の全列挙~~ → **解決**（レビュー §3.2 を §7 の正とする）
3. **合成キー名（`aggregateOperandLabel`）に `AGG_GROUP_KEY` / `VariableRef` をどう出すか。**
   既存形のラベルを変えないことが条件（§8.5-7）
4. `GROUP BY` に同じ列が修飾あり／なしの両方で書かれた場合の表記一致判定

---

> **【実機確認で見つけた仕様サンプルの誤り 2026-08-05】** §2 / §9 の例に `SET @税率 = 1.1;` と
> 書いていたが、**kSQL の変数名は英字または `_` 始まりでなければならない**
> （`「@」 の直後には英字または _ で始まる変数名が必要です`）。`@rate` に修正した。
> 言語リファレンス側は実装者が正しい例を書いており、混入していたのは本仕様だけ。
> **B125 の §3.2 の数値例と同じ形の失敗**＝**サンプルは実行して確かめないと腐る**。

## 12. レビュー反映履歴

[codex レビュー 1 回目](ksql_b124_codex_review_1.md)（高 4・中 4・低 2）。**全 10 件を反映。**

| # | 重要度 | 指摘 | 反映 |
|---|---|---|---|
| 1 | 高 | 非集計始まりの式は入口に到達しない | §1.2 で**集計関数始まりに限定**・§5.3/§8.4-4 に拒否 |
| 2 | 高 | grouping sets で定数性が成立しない | §1.1 で**明示的に拒否**（実測を添付）・§8.4-3 |
| 3 | 高 | 「同値」は binary64 と NaN 規則で偽 | **§3.3 で同値主張を撤回**・§8.3 を新設・§9 に明記 |
| 4 | 高 | `AGG_VARIABLE` は既存解決器を通らない | §4 で**専用タグをやめ `VariableRef` を再利用**・非数値は `ArgumentError` |
| 5 | 中 | `GROUP BY` membership を文字列一致で表せない | §3.2 で**表記一致という狭い契約**に明文化（緩和は純加法） |
| 6 | 中 | §7 の一覧が主要経路を欠く | §7 を**レビューの完全一覧で置換**・(c) 8 箇所を明示 |
| 7 | 中 | `CaseResult` は `AggOperand` を含まない | §7 で訂正（波及は `StringFuncArg` のみ）・§8.5-3 |
| 8-10 | 中・低 | 診断文言・受入の網羅・表現 | §5.3 / §8.4 / §9 に反映 |

**仕様が正しかった点**（R3 で消さないための記録）: 案 A1/A2 の方向性・fail-closed の維持・
SELECT と `HAVING` を対称にする判断・修飾参照を AST に保持する設計・
ordinary GROUP BY でのグループキーの定数性・`HAVING` が押し下げ対象外であること。
