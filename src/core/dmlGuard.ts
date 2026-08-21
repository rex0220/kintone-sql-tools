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
import { normalizeGroupingSpec } from "./grouping";

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
    || type === "REORDER"
    || type === "IMPORT";
}

export function isReadOnlyType(type: string): boolean {
  return type === "SELECT"
    || type === "VALIDATE"
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
    || type === "ASSERT"
    // EXIT は条件評価とバッチ制御のみで kintone に書き込まない
    || type === "EXIT";
}

/** 文が実際に kintone の mutation API を呼ぶか。 */
export function writesKintone(stmt: Statement): boolean {
  return isDmlType(stmt.type) && !("validateOnly" in stmt && stmt.validateOnly === true);
}

export function isReadOnlyStatement(stmt: Statement): boolean {
  return !writesKintone(stmt) && (isReadOnlyType(stmt.type) || isDmlType(stmt.type));
}

/**
 * 単文実行で SelectResult（行）を返す文か。
 * read-only の意味判定は isReadOnlyStatement に委ね、ここでは結果形だけを分類する。
 */
export function isRowReturningReadOnlyStatement(stmt: Statement): boolean {
  if (!isReadOnlyStatement(stmt)) return false;
  return stmt.type === "SELECT"
    || stmt.type === "WITH"
    || stmt.type === "UNION"
    || stmt.type === "SHOW_APPS"
    || stmt.type === "DESCRIBE"
    || stmt.type === "VALIDATE";
}

export type CompleteInputReason =
  | "DML"
  | "VALIDATE"
  | "LOCAL_ORDER"
  | "WINDOW_ORDER"
  | "AGGREGATE_WINDOW"
  | "STATISTICAL_AGGREGATE"
  | "GROUPING_SETS"
  | "AGGREGATE"
  | "GROUP_BY"
  | "DISTINCT"
  | "CROSS_JOIN";

const STATISTICAL_AGGREGATES: ReadonlySet<string> = new Set([
  "STDDEV_POP", "STDDEV_SAMP", "VAR_POP", "VAR_SAMP", "MEDIAN", "MODE",
]);

function addReasons(target: Set<CompleteInputReason>, source: Iterable<CompleteInputReason>): void {
  for (const reason of source) target.add(reason);
}

function containsStatisticalAggregate(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const record = value as Record<string, unknown>;
  if ((record.type === "AGGREGATE" || record.type === "AGG_REF")
    && typeof record.func === "string"
    && STATISTICAL_AGGREGATES.has(record.func)) return true;
  if (record.type === "FIELD" && typeof record.field === "string"
    && /^(STDDEV_POP|STDDEV_SAMP|VAR_POP|VAR_SAMP|MEDIAN|MODE)\(/i.test(record.field)) return true;
  return Object.values(record).some((child) => Array.isArray(child)
    ? child.some((entry) => containsStatisticalAggregate(entry, seen))
    : containsStatisticalAggregate(child, seen));
}

function containsAggregate(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const record = value as Record<string, unknown>;
  if ((record.type === "AGGREGATE" || record.type === "AGG_REF")
    && typeof record.func === "string"
    && !STATISTICAL_AGGREGATES.has(record.func)) return true;
  if (record.type === "FIELD" && typeof record.field === "string"
    && /^(COUNT|SUM|AVG|MIN|MAX|GROUP_CONCAT)\(/i.test(record.field)) return true;
  return Object.values(record).some((child) => Array.isArray(child)
    ? child.some((entry) => containsAggregate(entry, seen))
    : containsAggregate(child, seen));
}

/** truncate を許さず完全な入力集合を必要とする理由を返す。 */
export function completeInputReasons(stmt: Statement): Set<CompleteInputReason> {
  const reasons = new Set<CompleteInputReason>();
  if (isDmlType(stmt.type)) {
    reasons.add("DML");
    return reasons;
  }
  switch (stmt.type) {
    case "VALIDATE":
      reasons.add("VALIDATE");
      break;
    case "SELECT":
      addReasons(reasons, selectCompleteInputReasons(stmt));
      break;
    case "UNION":
      addReasons(reasons, unionCompleteInputReasons(stmt));
      break;
    case "WITH":
      for (const cte of stmt.ctes) {
        if (cte.query.type !== "GENERATE_SERIES") {
          addReasons(reasons, completeInputReasons(cte.query));
        }
      }
      addReasons(reasons, completeInputReasons(stmt.query));
      break;
    case "CREATE_TEMP_TABLE":
      addReasons(reasons, completeInputReasons(stmt.query));
      break;
    default:
      // EXPLAIN itself fetches no records; the target query requirement is shown in its plan.
      break;
  }
  if (containsStatisticalAggregate(stmt)) reasons.add("STATISTICAL_AGGREGATE");
  if (containsAggregate(stmt)) reasons.add("AGGREGATE");
  return reasons;
}

/** 後方互換 wrapper。 */
export function requiresCompleteInput(stmt: Statement): boolean {
  return completeInputReasons(stmt).size > 0;
}

function unionCompleteInputReasons(stmt: UnionStatement): Set<CompleteInputReason> {
  const reasons = stmt.left.type === "SELECT"
    ? selectCompleteInputReasons(stmt.left)
    : unionCompleteInputReasons(stmt.left);
  addReasons(reasons, selectCompleteInputReasons(stmt.right));
  if (!stmt.all) reasons.add("DISTINCT");
  return reasons;
}

function selectCompleteInputReasons(stmt: SelectStatement): Set<CompleteInputReason> {
  const reasons = new Set<CompleteInputReason>();
  if (stmt.joins.some((join) => join.type === "CROSS")) reasons.add("CROSS_JOIN");
  const grouping = normalizeGroupingSpec(stmt);
  if (grouping.type === "GROUPING_SETS") reasons.add("GROUPING_SETS");
  if (grouping.type === "PLAIN") reasons.add("GROUP_BY");
  if (stmt.distinct) reasons.add("DISTINCT");
  if (stmt.orderBy.length > 0) reasons.add("LOCAL_ORDER");
  for (const column of stmt.columns) {
    if (column.type === "WINDOW_COL" && column.windowKind === "AGGREGATE") {
      reasons.add("AGGREGATE_WINDOW");
    } else if (column.type === "WINDOW_COL" && column.orderBy.length > 0) {
      reasons.add("WINDOW_ORDER");
    }
    if (column.type === "SCALAR_SUBQUERY_COL") addReasons(reasons, selectCompleteInputReasons(column.query));
    if (column.type === "CASE_COL") {
      for (const branch of column.expr.branches) addReasons(reasons, whereCompleteInputReasons(branch.condition));
    }
  }
  addReasons(reasons, whereCompleteInputReasons(stmt.where));
  addReasons(reasons, whereCompleteInputReasons(stmt.having));
  if (containsStatisticalAggregate(stmt)) reasons.add("STATISTICAL_AGGREGATE");
  if (containsAggregate(stmt)) reasons.add("AGGREGATE");
  return reasons;
}

function whereCompleteInputReasons(where: WhereExpr | null): Set<CompleteInputReason> {
  const reasons = new Set<CompleteInputReason>();
  if (where === null) return reasons;
  switch (where.type) {
    case "BINARY":
      if (where.right.type === "SUBQUERY_IN_LIST" || where.right.type === "SCALAR_SUBQUERY") {
        addReasons(reasons, selectCompleteInputReasons(where.right.query));
      }
      break;
    case "LOGICAL":
      addReasons(reasons, whereCompleteInputReasons(where.left));
      addReasons(reasons, whereCompleteInputReasons(where.right));
      break;
    case "NOT":
    case "GROUP":
      addReasons(reasons, whereCompleteInputReasons(where.expr));
      break;
    case "EXISTS":
      addReasons(reasons, selectCompleteInputReasons(where.query));
      break;
    case "NULL_CHECK":
    case "BOOLEAN":
      break;
  }
  return reasons;
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
