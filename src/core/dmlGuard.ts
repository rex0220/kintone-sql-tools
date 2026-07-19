import type {
  DeleteStatement,
  InsertSelectStatement,
  InsertStatement,
  ReorderStatement,
  Statement,
  UpdateStatement,
  UpsertSelectStatement,
  UpsertStatement,
  SelectStatement,
  UnionStatement,
  WhereExpr,
} from "../types/ast";
import { NO_FROM_CTE_NAME } from "../types/ast";

export type StatementType = Statement["type"] | "UNKNOWN";

export function getStatementType(stmt: unknown): string {
  if (!stmt || typeof stmt !== "object") return "UNKNOWN";
  const obj = stmt as { type?: unknown };
  return typeof obj.type === "string" ? obj.type : "UNKNOWN";
}

export function isDmlType(type: string): boolean {
  return type === "INSERT"
    || type === "INSERT_SELECT"
    || type === "UPDATE"
    || type === "DELETE"
    || type === "UPSERT"
    || type === "UPSERT_SELECT"
    || type === "REORDER";
}

export function isReadOnlyType(type: string): boolean {
  return type === "SELECT"
    || type === "UNION"
    || type === "WITH"
    || type === "EXPLAIN"
    || type === "SHOW_APPS"
    || type === "DESCRIBE"
    // 一時テーブルの CREATE / DROP は kintone に書き込まないため read-only 扱い（仕様 §4.3）
    || type === "CREATE_TEMP_TABLE"
    || type === "DROP_TEMP_TABLE"
    // SET はバッチ内メモリだけを更新し、kintone には書き込まない
    || type === "SET_VARIABLE"
    || type === "DECLARE_VARIABLE"
    // ASSERT は条件評価のみで kintone に書き込まない（バッチ強化第1弾 §2.3）
    || type === "ASSERT";
}

/** 文が実際に kintone の mutation API を呼ぶか。 */
export function writesKintone(stmt: Statement): boolean {
  return isDmlType(stmt.type) && !("validateOnly" in stmt && stmt.validateOnly === true);
}

export function isReadOnlyStatement(stmt: Statement): boolean {
  return !writesKintone(stmt) && (isReadOnlyType(stmt.type) || isDmlType(stmt.type));
}

/** truncate を許さず完全な入力集合を必要とする文か。 */
export function requiresCompleteInput(stmt: Statement): boolean {
  if (isDmlType(stmt.type)) return true;
  switch (stmt.type) {
    case "SELECT":
      return selectRequiresCompleteInput(stmt);
    case "UNION":
      return unionRequiresCompleteInput(stmt);
    case "WITH":
      return stmt.ctes.some((cte) =>
        (cte.query.type === "SELECT" && selectRequiresCompleteInput(cte.query)) ||
        (cte.query.type === "UNION" && unionRequiresCompleteInput(cte.query))
      ) || (stmt.query.type === "SELECT"
        ? selectRequiresCompleteInput(stmt.query)
        : unionRequiresCompleteInput(stmt.query));
    case "CREATE_TEMP_TABLE":
      return stmt.query.type === "SELECT"
        ? selectRequiresCompleteInput(stmt.query)
        : stmt.query.type === "UNION"
          ? unionRequiresCompleteInput(stmt.query)
          : requiresCompleteInput(stmt.query);
    default:
      // EXPLAIN itself fetches no records; the target query requirement is shown in its plan.
      return false;
  }
}

function unionRequiresCompleteInput(stmt: UnionStatement): boolean {
  const left = stmt.left.type === "SELECT"
    ? selectRequiresCompleteInput(stmt.left)
    : unionRequiresCompleteInput(stmt.left);
  return left || selectRequiresCompleteInput(stmt.right);
}

function selectRequiresCompleteInput(stmt: SelectStatement): boolean {
  if (stmt.orderBy.length > 0) return true;
  if (stmt.columns.some((column) =>
    (column.type === "WINDOW_COL" && column.orderBy.length > 0) ||
    (column.type === "SCALAR_SUBQUERY_COL" && selectRequiresCompleteInput(column.query)) ||
    (column.type === "CASE_COL" && column.expr.branches.some((branch) =>
      whereRequiresCompleteInput(branch.condition)
    ))
  )) return true;
  return whereRequiresCompleteInput(stmt.where) || whereRequiresCompleteInput(stmt.having);
}

function whereRequiresCompleteInput(where: WhereExpr | null): boolean {
  if (where === null) return false;
  switch (where.type) {
    case "BINARY":
      return (where.right.type === "SUBQUERY_IN_LIST" || where.right.type === "SCALAR_SUBQUERY")
        && selectRequiresCompleteInput(where.right.query);
    case "LOGICAL":
      return whereRequiresCompleteInput(where.left) || whereRequiresCompleteInput(where.right);
    case "NOT":
    case "GROUP":
      return whereRequiresCompleteInput(where.expr);
    case "EXISTS":
      return selectRequiresCompleteInput(where.query);
    case "NULL_CHECK":
    case "BOOLEAN":
      return false;
  }
}

export function hasWhereClause(stmt: unknown): boolean {
  if (!stmt || typeof stmt !== "object") return false;
  const obj = stmt as { where?: unknown };
  return obj.where !== null && obj.where !== undefined;
}

export function isNoFromSelectStatement(stmt: unknown): boolean {
  if (!stmt || typeof stmt !== "object") return false;
  const obj = stmt as { type?: unknown; from?: { appId?: unknown; cteName?: unknown } };
  return obj.type === "SELECT"
    && obj.from?.appId === 0
    && obj.from?.cteName === NO_FROM_CTE_NAME;
}

export function getInsertValuesCount(stmt: unknown): number | null {
  if (!stmt || typeof stmt !== "object") return null;
  const obj = stmt as { type?: unknown; values?: unknown };
  if (obj.type !== "INSERT") return null;
  return Array.isArray(obj.values) ? obj.values.length : null;
}

export function collectDmlTargetFields(stmt: unknown): string[] {
  if (!stmt || typeof stmt !== "object") return [];
  const obj = stmt as {
    type?: string;
    fields?: string[];
    keyFields?: string[];
    assignments?: Array<{ field?: string }>;
  };
  if (!obj.type) return [];
  if (obj.type === "UPDATE") {
    return (obj.assignments ?? [])
      .map((a) => a.field)
      .filter((f): f is string => Boolean(f));
  }
  if (obj.type === "INSERT" || obj.type === "INSERT_SELECT" || obj.type === "UPSERT" || obj.type === "UPSERT_SELECT") {
    return [...(obj.fields ?? []), ...(obj.keyFields ?? [])];
  }
  return [];
}

export function isMutationStatement(
  stmt: Statement
): stmt is InsertStatement
  | InsertSelectStatement
  | UpdateStatement
  | DeleteStatement
  | UpsertStatement
  | UpsertSelectStatement
  | ReorderStatement {
  return isDmlType(stmt.type);
}
