import type { SelectStatement, Statement, TableRef } from "../types/ast";

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

/**
 * 取得中のテーブルが、この SELECT 自身の外部結合で保持されない側になるかを返す。
 * 入れ子は走査せず、alias ではなく parser が生成した TableRef の同一性で照合する。
 */
export function isOuterJoinNonPreservedTable(
  statement: SelectStatement,
  table: TableRef,
  isMainTable: boolean
): boolean {
  if (isMainTable) {
    return table === statement.from
      && statement.joins.some((join) => join.type === "RIGHT");
  }

  for (let index = 0; index < statement.joins.length; index += 1) {
    const join = statement.joins[index];
    if (join.type === "LEFT" && table === join.table) return true;
    if (
      join.type === "RIGHT"
      && statement.joins
        .slice(0, index)
        .some((previousJoin) => table === previousJoin.table)
    ) {
      return true;
    }
  }
  return false;
}
