// ============================================================
// スカラー値の共通比較
//
// WHERE の FULL_SCAN 評価と ASSERT は同じ型規則を使う。
// = / != / <> は文字列比較、範囲比較は双方を数値化できる場合のみ
// 数値比較する。kintone の数値空セルは、有限数との範囲比較では
// −∞ 相当（< / <= は true、> / >= は false）として扱われる。
// ============================================================

export type ScalarCompareOp = "=" | "!=" | "<>" | ">" | "<" | ">=" | "<=";
export type ScalarExtreme = "greatest" | "least";

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

/**
 * GREATEST / LEAST 用の n 項比較。
 *
 * compareScalarValues を畳み込むと、数値・非数値の混在時に推移律が
 * 成り立たない。空文字を先に確定し、集合全体で比較モードを一度だけ
 * 決める。数値が同値なら元文字列を二次キーにして返却値も一意にする。
 */
export function selectScalarExtreme(values: readonly string[], extreme: ScalarExtreme): string {
  if (extreme === "least" && values.includes("")) return "";

  const candidates = extreme === "greatest"
    ? values.filter((value) => value !== "")
    : [...values];
  if (candidates.length === 0) return "";

  const numeric = candidates.every((value) => !Number.isNaN(Number(value)));
  const compare = (left: string, right: string): number => {
    if (numeric) {
      const leftNum = Number(left);
      const rightNum = Number(right);
      if (leftNum < rightNum) return -1;
      if (leftNum > rightNum) return 1;
    }
    return left < right ? -1 : left > right ? 1 : 0;
  };

  return candidates.reduce((best, candidate) => {
    const cmp = compare(candidate, best);
    return extreme === "greatest"
      ? (cmp > 0 ? candidate : best)
      : (cmp < 0 ? candidate : best);
  });
}
