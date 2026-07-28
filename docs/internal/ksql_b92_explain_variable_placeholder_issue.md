# B92 EXPLAIN が変数を算術に使うバッチをすべて拒否する（v3.31.0 の回帰）

- 起票: 2026-07-29
- ステータス: 📋 **仕様確定・実装待ち（優先 高／リリース済みの回帰）**
- 出典: v3.31.0 のデプロイ済み MCP での実機確認（オーナー環境）
- 関連: [B90 変数の直接算術](ksql_b90_variable_arithmetic_issue.md) / [B89 explainQuery バッチ対応](ksql_b89_library_explain_batch_issue.md)

## 1. 事象（実機・v3.31.0）

**`EXPLAIN` が、変数を算術に使うバッチをすべて拒否する。**

```
EXPLAIN: CREATE TEMP TABLE #g AS SELECT 案件No, 顧客No FROM APP4147;
         SET @total = (SELECT SUM(顧客No) FROM #g);
         SELECT 案件No, (顧客No * 100) / @total AS 構成比 FROM #g
→ ArgumentError: variable @total is not numeric and cannot be used in arithmetic.
```

**`ROUND()` で包んだ従来形も同じく落ちる。**

```
SELECT 案件No, ROUND(顧客No * 100 / @total, 1) AS x FROM #g
→ 同じエラー
```

**v3.30.0 までは EXPLAIN できていた**（`ROUND()` 形）ため、**回帰**である。

## 2. 影響＝**B89 と B90 が噛み合って Pro の用途を正面から壊す**

- Pro の設定画面は **`explainQuery` で構文チェック**する（B89 で複文対応したばかり）
- そこへ流すのは **構成比のバッチ**（B90 で書けるようにしたばかり）

**両方の目玉機能が、組み合わせると必ずエラーになる。**

MCP の `ksql_explain` も同じ経路なので、**Pro 以外の利用者にも影響**する。

**誤った結果ではなく fail-closed 側の誤検知**だが、**新機能が検証経路で必ず落ちる**ため実質使えない。

## 3. 原因

**EXPLAIN は変数を評価しないため、スカラー変数へ文字列のプレースホルダーを入れている。**

```ts
// execute.ts:9771-9775
// EXPLAIN は関数を評価しない。後続プランでは名前を値プレースホルダーとして使う。
variables.set(stmt.name, stmt.type === "SET_VARIABLE" && stmt.expr.type === "ARRAY"
  ? { type: "array", elements: ... }
  : { type: "string", value: `@${stmt.name}` });
```

そこへ **B90 で追加した「非数値ならエラー」チェック**が当たる。

```ts
// execute.ts:1997
if (numericArithmeticOperand && value.type !== "number") {
  throw new Error(`ArgumentError: variable @${obj["name"]} is not numeric ...`);
}
```

`numericArithmeticOperand` は `ARITH` / `SCALAR_ARITH` / `AGG_ARITH` の `left` / `right`
へ降りるときに `true` になるため、**EXPLAIN でも算術の中では必ず立つ。**

**プレースホルダーを「文字列変数」と誤認している**のが本質である。

## 4. レビューの穴（記録）

B90 の仕様 §4 で「`buildBatchExplainPlans` は解決を計画前に呼ぶ」ことは確認していたが、
**そこで渡される値が実値ではなくプレースホルダーである**ところまで見ていなかった。
**受入条件に EXPLAIN 経路が 1 件も無かった。**

## 5. 対応

### 5.1 単純にチェックを飛ばすだけでは不足

**プレースホルダーは文字列として置換される**ため、飛ばすと
**`ArithNode` の位置に `{ type: "STRING" }` が入る。**
`ArithNode` に `STRING` は存在せず、B90 で追加した内部エラーガードに当たる可能性がある。

### 5.2 方針＝プレースホルダーを明示し、算術位置では数値形で置換する

1. `VarValue` に**プレースホルダーの目印**を足す（例: `placeholder?: true`）
2. `buildBatchExplainPlans` が入れる値へその目印を付ける
3. 解決時、**プレースホルダーには数値チェックを適用しない**
4. **算術位置では `{ type: "NUMBER", value: 0, raw: "@name" }` として置換する**
   （`raw` は既に表示に使われているので、計画の見た目は `@name` のまま）

**算術以外の位置ではプレースホルダーの型を変えない。**
EXPLAIN の計画は実行時の挙動を映すべきで、
**型を数値へ変えると押し下げの判定が実際と変わって表示される**恐れがある。

### 5.3 実行経路には影響しない

**プレースホルダーは EXPLAIN でしか作られない。**
実行時の非数値変数は従来どおり `ArgumentError` で停止する（B90 の意図は維持）。

## 6. 受入条件

1. **Pro の実例が EXPLAIN できる** — §1 の 2 例（直接算術・`ROUND()`）がどちらも計画を返すこと
2. **計画の表示が `@name` のまま** — 数値化した痕跡（`0` など）が出ないこと
3. **実行時の fail-closed は維持** — 非数値変数を算術に使う実行が
   従来どおり `variable @x is not numeric ...` で停止すること（**両経路**）
4. **算術以外の位置でプレースホルダーの型が変わらない** —
   `WHERE 列 = @phase` の計画が v3.30.0 と同じであること
5. **`explainQuery`（ライブラリ）でも同じ** — B89 の経路で §1 の 2 例が通ること
6. **既存テスト全 green・snapshot 22 不変・公開型不変**

## 7. 規模

- 実装: 0.25〜0.5 人日
- テスト（EXPLAIN 経路の受入 1〜5）: 0.25 人日

**合計 0.5〜0.75 人日。SemVer=patch（v3.31.1）＝回帰修正のみ。**

## 8. 優先度の根拠

**リリース済みの回帰**で、**v3.31.0 の目玉機能 2 つが組み合わせで使えない。**
**Pro が最初に試す形**であり、連絡前に直す必要がある。
