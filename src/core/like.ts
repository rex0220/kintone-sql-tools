import type { BinaryExpr, WhereExpr } from "../types/ast";

export type LikeExpr = BinaryExpr & { op: "LIKE" | "NOT_LIKE" };

/** SQL LIKE パターンに、この実装が解釈するワイルドカードが含まれるか。 */
export function likePatternHasWildcard(pattern: string): boolean {
  return pattern.includes("%") || pattern.includes("_");
}

/** 式が LIKE / NOT LIKE か。LIKE は常に JavaScript 側で評価する。 */
export function isLike(where: WhereExpr): where is LikeExpr {
  return where.type === "BINARY"
    && (where.op === "LIKE" || where.op === "NOT_LIKE");
}

/** WHERE ツリー内に LIKE / NOT LIKE が含まれるか。 */
export function whereHasLike(where: WhereExpr | null): boolean {
  if (where === null) return false;
  if (isLike(where)) return true;
  switch (where.type) {
    case "LOGICAL":
      return whereHasLike(where.left) || whereHasLike(where.right);
    case "NOT":
    case "GROUP":
      return whereHasLike(where.expr);
    case "BINARY":
    case "NULL_CHECK":
    case "EXISTS":
      return false;
  }
}
