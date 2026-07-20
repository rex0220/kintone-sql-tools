import type { SelectStatement, WhereExpr } from "../types/ast";

/**
 * WHERE の capability 判定にフォーム定義が必要かを返す。
 * `$id` は組み込みの数値列として解決できるため、フォーム API を必要としない。
 * サブクエリ自身の必要性は explainNeedsAppMetadata が別の statement として判定する。
 */
export function whereNeedsFieldMetadata(where: WhereExpr | null): boolean {
  if (where === null) return false;
  switch (where.type) {
    case "BINARY":
      return valueNeedsFieldMetadata(where.left);
    case "NULL_CHECK":
      return valueNeedsFieldMetadata(where.field);
    case "LOGICAL":
      return whereNeedsFieldMetadata(where.left) || whereNeedsFieldMetadata(where.right);
    case "NOT":
    case "GROUP":
      return whereNeedsFieldMetadata(where.expr);
    case "EXISTS":
    case "BOOLEAN":
      return false;
  }
}

function valueNeedsFieldMetadata(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(valueNeedsFieldMetadata);
  if (value === null || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (item["type"] === "FIELD") return item["field"] !== "$id";
  // SELECT 以下は、その SELECT の WHERE / ORDER BY だけを別途判定する。
  if (item["type"] === "SELECT") return false;
  return Object.values(item).some(valueNeedsFieldMetadata);
}

function selectNeedsOwnMetadata(statement: SelectStatement): boolean {
  return whereNeedsFieldMetadata(statement.where)
    || statement.orderBy.length > 0
    || statement.columns.some((column) =>
      column.type === "WINDOW_COL" && column.orderBy.length > 0
    );
}

/**
 * EXPLAIN / dry-run がフォーム定義またはプロセス設定を読む必要があるかを返す。
 * statement 全体を再帰走査するため、WITH / UNION / サブクエリ / DML を同じ規則で扱う。
 */
export function explainNeedsAppMetadata(statement: unknown): boolean {
  const seen = new Set<object>();
  const visit = (node: unknown): boolean => {
    if (node === null || typeof node !== "object") return false;
    if (seen.has(node as object)) return false;
    seen.add(node as object);
    if (Array.isArray(node)) return node.some(visit);

    const item = node as Record<string, unknown>;
    if (item["type"] === "VALIDATE") return true;
    if (item["type"] === "SELECT" && selectNeedsOwnMetadata(node as SelectStatement)) {
      return true;
    }
    if ((item["type"] === "UPDATE" || item["type"] === "DELETE")
      && whereNeedsFieldMetadata((node as { where: WhereExpr }).where)) {
      return true;
    }
    if (item["type"] === "UPDATE" && Array.isArray(item["applyBlocks"])
      && item["applyBlocks"].length > 0) return true;
    return Object.values(item).some(visit);
  };
  return visit(statement);
}
