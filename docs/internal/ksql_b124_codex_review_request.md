# B124 集計算術式 Phase 1 仕様 codex レビュー依頼（2026-08-05）

このファイルの §2 以降をそのまま codex へ渡す。
**レビュー依頼であり実装依頼ではない。コードは 1 行も変更しないこと。**

> **注意（headless で回す場合）**
> - `codex exec` は **MCP tool call の承認待ちで無言停止**する。**kSQL MCP を叩かないこと。**
> - **git 操作は一切しないこと。**
> - コード変更が無いため `npm test` は不要。

---

## 2. 依頼

kSQL の集計算術式に**非集計オペランド**（`GROUP BY` キーの列・`@変数`）を書けるようにする
Phase 1 仕様を書いた。**実装前の仕様レビュー**をお願いしたい。**コードは変更しない。指摘だけを返す。**

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（現行 v3.45.0）

### 読むもの

| ファイル | 役割 |
|---|---|
| `docs/internal/ksql_b124_aggregate_arithmetic_phase1_spec.md` | **レビュー対象の仕様 R1** |
| `docs/internal/ksql_b124_aggregate_arithmetic_nonaggregate_operand_issue.md` | 起票（背景・実需・実測） |
| `src/parser/parser.ts` | `parseAggPrimary` / `parseAggregateColumn` / 併用チェック |
| `src/engine/process.ts` | `applyGroupBy`（267 行付近）・`evalAggArithExpr`（688 行付近） |
| `src/core/aggregateExpression.ts` | `evalMaterializedAggregateOperand` ほか |
| `src/engine/evalWhere.ts` | `AGG_FIELD` の評価入口（347 行付近） |
| `src/types/ast.ts` | `AggOperand` / `CaseResult` / `StringFuncArg` / `AggregateFieldValue` |
| `docs/ksql_language_reference.md` §8 / §9 | 集計と `HAVING` の既存契約 |

**背景**: 直前に B125（集計ウィンドウ）で同じ形のレビューをしてもらい、
高 6・中 5・低 1 の指摘を全件反映した。今回の R1 はその教訓
（既存契約を主張せず実測で確認する / 触る箇所を全部列挙する / 受入は特定の誤実装が落ちる形にする）
を踏まえて書いてある。**同じ穴が残っていないかを見てほしい。**

---

## 3. 特に見てほしい点

### 3.1 【最優先】修飾名 `m.仕入価格` は `HAVING` 側の出力行から引けるか

仕様 §6.1 / §11.1 の**未確定 1 件**。ここが食い違うと
**「SELECT では通るが `HAVING` で 0 行」**になり、B121/B122 で潰したばかりの形が再発する。

- `applyGroupBy`（`src/engine/process.ts` 267 行付近）が**出力行に書くグループキーの列名**は何か。
  `m.仕入価格` のような修飾名のとき、キーは `m.仕入価格` か `仕入価格` か
- `evalMaterializedAggregateOperand` に渡る**出力行**から、その名前で引けるか
- SELECT 側（`evalAggArithExpr` の `rows[0]`）と **同じ値になるか**。
  ならないなら、仕様のどこを直すべきか

### 3.2 `AggOperand` を走査する箇所の全列挙

仕様 §7 は「R2 までに `rg` で確定させる」としている。**代わりに列挙してほしい。**

- `AggOperand` / `AGG_ARITH` / `AGG_REF` を走査・分岐している箇所を**すべて**挙げる
- 各箇所を「(a) 新メンバーを足しても影響なし / (b) 新メンバーの処理が要る /
  (c) 網羅 switch でコンパイルが壊れる」に分類してほしい
- とくに `CaseResult` と `StringFuncArg` が `AggOperand` を含むため、
  **`CASE` の中・文字列関数の引数へ波及する範囲**を明示してほしい
- `aggregateOperandLabel` / `aggArithDefaultKey`（alias 無しの合成キー名）が
  新メンバーで何を返すか。**合成キー名が変わると `HAVING` / `ORDER BY` の解決が壊れる**
  （集計算術式 alias 消失バグと同じ経路）

### 3.3 `GROUP BY` キー検証のタイミング（§5.2）

仕様は「`parseAggPrimary` の時点では `GROUP BY` 句がまだ読まれていないので、
`GROUP BY` を読み終えた後に SELECT 全体を走査して検証する（案 P1）」としている。

- **この前提は正しいか**（SELECT 列 → FROM → WHERE → GROUP BY の読み順）
- 既存の併用チェック（`parser.ts:1176-1180` 付近）と同じ場所に置けるか
- `HAVING` に書かれた集計算術式は**どこで**検証されるか。SELECT 列と同じ走査で拾えるか
- `WITH` / `UNION` / サブクエリの中の SELECT でも同じ検証が効くか。
  **入れ子の SELECT で外側の `GROUP BY` キーを誤って許可しないか**

### 3.4 §0 の実測 8 項目の裏取り

仕様 §0 に「実測で確認した」と書いた 8 項目が、**コードを読んでも同じ結論になるか**。
とくに次の 3 つ:

- **グループキーの raw 値がグループ内で一定**（`applyGroupBy` がキーを raw 文字列の連結で作る）。
  `evalGroupByKey` が正規化・canonical 化していないか。B71 の `resolutionPlan` 経路も含めて確認してほしい
- **`HAVING` も同じ `parseAggPrimary` を通る**
- **`whereToKintone.ts:172` が `AGG_FIELD` を押し下げ拒否**（押し下げの検討が不要である根拠）

### 3.5 受入条件で検出できないもの（§8）

- §8.1 の同値条件（`SUM(a) * 単価` = `SUM(a * 単価)`）で**何が検出できて何ができないか**
- **浮動小数**の扱いはどうか。B125 では「加算順序が違うと最下位ビットが一致しない」が
  問題になった。本件では両辺の計算順序が違うが、**同値と言い切ってよいか**
  （`c × Σaᵢ` と `Σ(aᵢ × c)` は binary64 で必ず一致するか）
- 空セル（`Number("") === 0`）と `NaN` の組み合わせで、
  外側と内側で**結果が食い違う入力**が作れないか

### 3.6 仕様そのものへの指摘

- 矛盾・抜け
- `AGG_GROUP_KEY` / `AGG_VARIABLE` という専用 AST メンバーにする案（§4）の妥当性
- `HAVING` を許可する判断（§3.4）に穴が無いか
- 非数値オペランドを `NaN` にする判断（§3.3）が既存の算術と本当に整合するか

---

## 4. 出したい成果物

`docs/internal/ksql_b124_codex_review_1.md` に、次の形で書いてほしい。

```markdown
# B124 Phase 1 仕様 codex レビュー（1 回目）

## 結論
（実装着手可能 / 要修正。要修正なら何件か）

## 指摘
### [重要度: 高/中/低] <見出し>
- 該当: 仕様の §x.y / コードの file:line
- 内容:
- 根拠:（読んだコードの引用）
- 提案:

## §3 の 6 点への回答
（3.1〜3.6 それぞれ。コードの引用を添える。3.2 は分類つきの完全な一覧）

## 仕様が正しかった点
（照合して合っていたものも列挙してほしい。R2 で消さないため）
```

**重要度の基準**:

- **高** = そのまま実装すると誤った結果を返す / 既存機能を壊す
- **中** = 実装が詰まる、または受入で検出できない穴が残る
- **低** = 表現・体裁・将来の拡張性

**根拠のないコメントは書かないでほしい。** 「〜かもしれない」ではなく、
**該当コードを引用して**「こうなっているので、こうなる」と書いてほしい。
確認できなかった項目は「未確認」と明記してくれればよい。
