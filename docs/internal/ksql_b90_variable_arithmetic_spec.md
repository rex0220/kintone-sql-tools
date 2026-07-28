# 仕様: B90 変数を算術式に直接書けるようにする

- 作成: 2026-07-29
- 対象課題: [B90](ksql_b90_variable_arithmetic_issue.md)
- ステータス: 📋 **R1・実装待ち**
- 分担: Claude=仕様/レビュー、codex=実装/テスト
- SemVer: **minor**。§5 の fail-closed 化のみ挙動が変わる（誤った結果を返していたもの）

---

## 1. 目的

**`SELECT` 列の算術式に変数を直接書けるようにする。**

```sql
SET @total = (SELECT SUM(売上) FROM #g);
SELECT 提案商品, 売上, (売上 * 100) / @total AS 構成比 FROM #g;
-- 現状: ParseError（算術式のオペランドには識別子・数値・括弧式を指定してください）
-- 修正後: 動く
```

**構成比（全体比 %）はダッシュボードで最も要望の多い列の 1 つ**（Pro 談）。
現状は `ROUND()` で包めば動くため、利用者への説明が
**「`ROUND()` で包んでください。理由は文法上の都合です」**になっている。

---

## 2. 原因＝式文法が 2 系統ある

| 文法 | 使われる場所 | `@var` |
|---|---|---|
| `SCALAR_*`（[parser.ts:1568](../../src/parser/parser.ts#L1568)） | 関数引数・`SET` の右辺 | ✅ 受理 |
| **`ARITH*`**（[parser.ts:1693](../../src/parser/parser.ts#L1693)） | **`SELECT` 列の算術** | ❌ 未対応 |

`parseArithPrimary` が受けるのは `(expr)` / 単項符号 / 文字列・数値関数 / `NUMBER` /
`IDENT`・`BIDENT` だけで、`TokenKind.VARIABLE` の分岐が無い。

---

## 3. 変更

### 3.1 パーサ

`parseArithPrimary` に **`TokenKind.VARIABLE` の分岐**を足し、
`{ type: "VARIABLE", name }`（`VariableRef`）を返す。

### 3.2 型

[`ArithNode`](../../src/types/ast.ts#L998) に **`VariableRef` を追加**する。

```ts
export type ArithNode =
  | { type: "FIELD_REF"; field: string }
  | NumberLiteral
  | LegacyArithExpr
  | StringFuncExpr
  | VariableRef;   // ← 追加
```

**波及先は 17 箇所・7 ファイル**（`FIELD_REF` を判別している本番コード）。
**TypeScript が漏れを検出する**ので、網羅は型に守らせる。

| ファイル | 判別サイト |
|---|---:|
| `src/parser/parser.ts` | 4 |
| `src/execute.ts` | 4 |
| `src/converter/selectToKintone.ts` | 4 |
| `src/converter/dmlToKintone.ts` | 2 |
| `src/engine/evalWhere.ts` | 1 |
| `src/engine/evalFunc.ts` | 1 |
| `src/core/aggregateExpression.ts` | 1 |

**各所の扱いは「内部エラーで停止」**とする（§4 のとおり、実行時には到達しないため）。
**黙って無視したり、既定値を当てたりしないこと。**

---

## 4. 解決前に走る経路は無い（確認済み）

**変数は実行ディスパッチより前に解決され、評価器・押し下げ変換器へは届かない。**

| 呼び出し元 | 位置 | 何より前か |
|---|---|---|
| `executeBatchStatement` | [execute.ts:1697](../../src/execute.ts#L1697) | **KLIKE 検証・APPLY scope 検査・型別ディスパッチのすべてより前** |
| `executeBatchStatement`（`SET`） | [execute.ts:1632](../../src/execute.ts#L1632) | 同上 |
| `buildBatchExplainPlans` | [execute.ts:9706](../../src/execute.ts#L9706) | 計画生成より前 |

**したがって `selectToKintone`（押し下げ変換器）を含む下流は、解決済みリテラルしか見ない。**
押し下げの安全性（v2.0.0 の `LIKE` 全廃など、過去に何度も事故った領域）に触れずに済む。

### 4.1 既存の汎用走査器が算術中の変数も拾う

**追加実装は不要。**次の 2 つは**型ではなく構造で**変数を探す深さ優先走査である。

| 走査器 | 位置 | 役割 |
|---|---|---|
| `collectVariableRefs` | [batch.ts:150](../../src/core/batch.ts#L150) | 静的検査（未定義変数・配列変数の誤用） |
| `resolveBatchVariableReferences` | [execute.ts:1975](../../src/execute.ts#L1975) | 解決（リテラルへ置換） |

どちらも `{ type: "VARIABLE" }` を**木のどこにあっても**見つけるため、
**算術木の中に置いても自動的に効く。**

### 4.2 単文での扱いも既存のまま

単文で `SELECT (売上 * 100) / @x` と書いた場合、`collectVariableRefs` が拾って
**既存のエラーがそのまま出る。**

```
ParseError: variable @x is not defined before statement 1.
```

**実測で確認済み**（`SELECT ... WHERE 対応種別 IN @undefined_var` が同じエラーを返す）。

### 4.3 配列変数も既存のまま

`resolveBatchVariableReferences` が
`ParseError: array variable @x can only be used as IN @x.` を投げる。

---

## 5. 非数値変数は **fail-closed** にする（決めごと）

### 5.1 現状は黙って `NaN` を返す（実測）

```sql
DECLARE @phase = '受注';
SELECT 案件No, ROUND(顧客No * 100 / @phase, 1) AS x FROM APP4147;
-- → x = "NaN"（エラーも警告も無し）
```

**これは既存の関数引数経路の挙動であり、B90 が作るものではない。**
しかし**そのまま直接算術へ持ち込むと、最も要望の多い列（構成比）で
silent wrong result が起きる。**

### 5.2 方針＝**両経路とも明確なエラーにする**

**B78（黙って 0 件）・B79（黙って誤った値）・B86（黙って全件／空文字書き込み）と同系列**であり、
このプロジェクトが一貫して最優先で潰してきた類である。

判断基準もそのまま使える。
**`NaN` は正しい結果ではないので、エラー化しても正しい結果を失わない。**

> **これは Pro の依頼を超える範囲である。**
> 依頼は「直接算術を許可してほしい」だけで、既存の `ROUND()` 経路の挙動変更は含まない。
> **オーナー判断で fail-closed を採る**（B78/B79/B86 と同じ基準）。
> **狭める場合は §5.3 の案 B**。

### 5.3 案 B（採らない・記録用）

新しい直接算術だけ fail-closed にし、既存の `ROUND()` 経路は `NaN` のまま残す。
**同じ誤りに 2 つの挙動が生まれる**ため採らない。

### 5.4 エラーの形

**変数名を名指しすること。**どの変数が悪いか分からないと直せない。

```
ArgumentError: variable @phase is not numeric and cannot be used in arithmetic.
```

---

## 6. 受入条件

1. **Pro の実例が動く** — `SET @total = (SELECT SUM(…));`
   `SELECT (売上 * 100) / @total AS 構成比 FROM #g` が正しい数値を返すこと
2. **`ROUND()` で包んだ従来形が変わらない** — 数値変数の場合の結果が不変であること
3. **非数値変数は両経路でエラー** — §5.4 の形で、**変数名を含む**こと
   - 直接算術 `(a * 100) / @phase`
   - **既存の関数経路 `ROUND(a * 100 / @phase, 1)`**（`NaN` を返さないこと）
4. **単文は既存のエラー** — `SELECT (a * 100) / @x FROM APPn`（単文）が
   `variable @x is not defined before statement 1.` になること
5. **配列変数は既存のエラー** — `array variable @x can only be used as IN @x.`
6. **押し下げに変数が届かない** — 解決前に `selectToKintone` へ到達しないことを固定する。
   **変数を含む WHERE の押し下げ結果が、同じ値を直接書いた場合と一致する**ことで確認する
7. **型の網羅** — `ArithNode` の全消費側が新しい variant を扱っていること
   （TypeScript のビルドが通ることに加え、**到達したら内部エラーになる**ことを 1 箇所以上で固定）
8. **既存テスト全 green・snapshot 22 不変・公開型不変**

---

## 7. 注意点

- **`ArithNode` の消費側で「黙って無視」しないこと。**実行時には到達しないので、
  到達したら**内部エラーで停止**させる。既定値を当てると silent wrong result になる
- **`SCALAR_*` 文法側は変更しないこと。**受理範囲は既に変数を含む
- **押し下げ変換器（`selectToKintone`）に手を入れないこと。**§4 のとおり解決済みリテラルしか来ない
- **公開型を変えないこと**（`ArithNode` は内部型）
- **§5 は Pro の依頼を超える範囲**なので、CHANGELOG と Pro への連絡に明記する
