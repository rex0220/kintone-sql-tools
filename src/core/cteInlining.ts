import { resolveSelectMode } from "../converter/selectToKintone";
import type { FieldValue, SelectStatement, WhereExpr, WithStatement } from "../types/ast";

/** 実行・検証・EXPLAIN が共有する単一 CTE のインライン化判定。 */
export function canInlineSingleCte(stmt: WithStatement): boolean {
  if (stmt.ctes.length !== 1) return false;
  const cteDef = stmt.ctes[0];
  if (cteDef.query.type !== "SELECT" || resolveSelectMode(cteDef.query) !== "SIMPLE") return false;
  const finalQuery = stmt.query;
  if (finalQuery.type !== "SELECT") return false;
  if (finalQuery.from.cteName !== cteDef.name || finalQuery.joins.length > 0) return false;
  if (finalQuery.groupBy.length > 0 || finalQuery.distinct) return false;
  return !finalQuery.columns.some(
    (column) => column.type === "AGGREGATE" || column.type === "ARITH_AGG_COL"
  );
}

/** canInlineSingleCte=true の WITH を、実際に実行する SelectStatement へ変換する。 */
export function buildInlinedQuery(stmt: WithStatement): SelectStatement {
  const cteBody = stmt.ctes[0].query as SelectStatement;
  const final = stmt.query as SelectStatement;
  const finalWhere = stripCteAlias(final.where, final.from.alias);
  const where = cteBody.where === null
    ? finalWhere
    : finalWhere === null
      ? cteBody.where
      : { type: "LOGICAL" as const, op: "AND" as const, left: cteBody.where, right: finalWhere };
  const columns = final.columns.every((column) => column.type === "WILDCARD")
    ? cteBody.columns
    : final.columns;
  return {
    type: "SELECT",
    from: cteBody.from,
    joins: [],
    columns,
    where,
    groupBy: [],
    having: null,
    orderMode: "CANONICAL",
    orderBy: final.orderBy.length > 0 ? final.orderBy : cteBody.orderBy,
    limit: final.limit ?? cteBody.limit,
    offset: final.offset ?? cteBody.offset,
    distinct: false,
  };
}

function stripCteAlias(where: WhereExpr | null, alias: string | null): WhereExpr | null {
  if (where === null || alias === null) return where;
  switch (where.type) {
    case "BINARY":
      return { ...where, left: stripCteAliasFromFieldValue(where.left, alias) };
    case "NULL_CHECK":
      return { ...where, field: stripCteAliasFromFieldValue(where.field, alias) };
    case "LOGICAL":
      return {
        ...where,
        left: stripCteAlias(where.left, alias)!,
        right: stripCteAlias(where.right, alias)!,
      };
    case "NOT":
    case "GROUP":
      return { ...where, expr: stripCteAlias(where.expr, alias)! };
    case "EXISTS":
    case "BOOLEAN":
      return where;
  }
}

function stripCteAliasFromFieldValue(value: FieldValue, alias: string): FieldValue {
  if (value.type === "FIELD" && value.tableAlias === alias) {
    return { ...value, tableAlias: null };
  }
  return value;
}
