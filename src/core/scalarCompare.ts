// ============================================================
// スカラー値の共通比較
//
// WHERE の FULL_SCAN 評価と ASSERT は同じ型規則を使う。
// = / != / <> は文字列比較、範囲比較は双方を数値化できる場合のみ
// 数値比較する。kintone の数値空セルは、有限数との範囲比較では
// −∞ 相当（< / <= は true、> / >= は false）として扱われる。
// ============================================================

export type ScalarCompareOp = "=" | "!=" | "<>" | ">" | "<" | ">=" | "<=";

export function compareScalarValues(
  op: ScalarCompareOp,
  leftStr: string,
  rightStr: string
): boolean {
  if (op === "=") return leftStr === rightStr;
  if (op === "!=" || op === "<>") return leftStr !== rightStr;

  const rightNum = Number(rightStr);
  if (leftStr === "" && rightStr !== "" && Number.isFinite(rightNum)) {
    return op === "<" || op === "<=";
  }

  const leftNum = Number(leftStr);
  const numeric = !Number.isNaN(leftNum) && !Number.isNaN(rightNum);
  switch (op) {
    case ">":  return numeric ? leftNum > rightNum  : leftStr > rightStr;
    case "<":  return numeric ? leftNum < rightNum  : leftStr < rightStr;
    case ">=": return numeric ? leftNum >= rightNum : leftStr >= rightStr;
    case "<=": return numeric ? leftNum <= rightNum : leftStr <= rightStr;
  }
}
