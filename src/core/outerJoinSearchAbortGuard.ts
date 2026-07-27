import type { Statement } from "../types/ast";

function isOuterJoinSelect(value: Record<string, unknown>): boolean {
  if (value["type"] !== "SELECT" || !Array.isArray(value["joins"])) return false;
  return value["joins"].some((join) => {
    if (join === null || typeof join !== "object") return false;
    const type = (join as Record<string, unknown>)["type"];
    return type === "LEFT" || type === "RIGHT";
  });
}

/**
 * 文全体の AST を走査し、任意の SELECT node に LEFT / RIGHT JOIN があるかを返す。
 * CTE、UNION、CREATE TEMP TABLE source、scalar/IN/EXISTS subquery も同じ走査で扱う。
 */
export function statementContainsOuterJoin(statement: Statement): boolean {
  const seen = new Set<object>();
  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(visit);
    if (value === null || typeof value !== "object" || seen.has(value as object)) return false;
    seen.add(value as object);
    const object = value as Record<string, unknown>;
    if (isOuterJoinSelect(object)) return true;
    return Object.values(object).some(visit);
  };
  return visit(statement);
}
