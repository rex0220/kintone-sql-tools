// ============================================================
// pushDownNot — NOT をリーフまで押し下げる（ド・モルガン）
// whereToKintone.ts と evalWhere.ts の両方から使用する共通ロジック
// ============================================================

import type { WhereExpr, CompareOp } from "../types/ast";
import { KintoneQueryError } from "../converter/whereToKintone";

export function pushDownNot(expr: WhereExpr): WhereExpr {
  switch (expr.type) {
    case "BOOLEAN":
      return { type: "BOOLEAN", value: !expr.value };
    case "BINARY": {
      const negated = negateOp(expr.op);
      if (negated === null) {
        throw new KintoneQueryError(
          `NOT ${expr.op} はサポート対象外です`
        );
      }
      return { ...expr, op: negated };
    }
    case "NULL_CHECK":
      return { ...expr, not: !expr.not };
    case "LOGICAL":
      return {
        type: "LOGICAL",
        op: expr.op === "AND" ? "OR" : "AND",
        left: pushDownNot(expr.left),
        right: pushDownNot(expr.right),
      };
    case "NOT":
      return expr.expr; // 二重否定
    case "GROUP":
      return { type: "GROUP", expr: pushDownNot(expr.expr) };
    case "EXISTS":
      return { ...expr, not: !expr.not };
  }
}

function negateOp(op: CompareOp): CompareOp | null {
  switch (op) {
    case "=":    return "!=";
    case "!=":
    case "<>":   return "=";
    case ">":    return "<=";
    case "<":    return ">=";
    case ">=":   return "<";
    case "<=":   return ">";
    case "LIKE":     return "NOT_LIKE";
    case "NOT_LIKE": return "LIKE";
    case "KLIKE":     return "NOT_KLIKE";
    case "NOT_KLIKE": return "KLIKE";
    case "IN":       return "NOT_IN";
    case "NOT_IN":   return "IN";
  }
}
