import type { BinaryExpr, WhereExpr } from "../types/ast";

export type LikeExpr = BinaryExpr & { op: "LIKE" | "NOT_LIKE" };
export type KlikeExpr = BinaryExpr & { op: "KLIKE" | "NOT_KLIKE" };

/** SQL LIKE パターンに、この実装が解釈するワイルドカードが含まれるか。 */
export function likePatternHasWildcard(pattern: string): boolean {
  return pattern.includes("%") || pattern.includes("_");
}

/** 式が LIKE / NOT LIKE か。LIKE は常に JavaScript 側で評価する。 */
export function isLike(where: WhereExpr): where is LikeExpr {
  return where.type === "BINARY"
    && (where.op === "LIKE" || where.op === "NOT_LIKE");
}

/** 式が kintone ネイティブの KLIKE / NOT KLIKE か。 */
export function isKlike(where: WhereExpr): where is KlikeExpr {
  return where.type === "BINARY"
    && (where.op === "KLIKE" || where.op === "NOT_KLIKE");
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
    case "BOOLEAN":
      return false;
  }
}

/** WHERE ツリー内に KLIKE / NOT KLIKE が含まれるか。 */
export function whereHasKlike(where: WhereExpr | null): boolean {
  if (where === null) return false;
  if (isKlike(where)) return true;
  switch (where.type) {
    case "LOGICAL":
      return whereHasKlike(where.left) || whereHasKlike(where.right);
    case "NOT":
    case "GROUP":
      return whereHasKlike(where.expr);
    case "BINARY":
    case "NULL_CHECK":
    case "EXISTS":
    case "BOOLEAN":
      return false;
  }
}
