import type {
  DeleteStatement,
  InsertSelectStatement,
  InsertStatement,
  ReorderStatement,
  Statement,
  UpdateStatement,
  UpsertSelectStatement,
  UpsertStatement,
} from "../types/ast";

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
    // ASSERT は条件評価のみで kintone に書き込まない（バッチ強化第1弾 §2.3）
    || type === "ASSERT";
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
    && obj.from?.cteName === "__NO_FROM__";
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
