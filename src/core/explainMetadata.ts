import type { SelectStatement, WhereExpr } from "../types/ast";
import {
  B65_MAX_GENERATED_ROWS,
  B65_MAX_GROUPING_ITEMS,
  B65_MAX_GROUPING_SETS,
  normalizeGroupingSpec,
} from "./grouping";

export interface GroupingExplainMetadata {
  source: "ROLLUP" | "GROUPING_SETS" | "CUBE";
  expandedSetCount: number;
  groupingItemCount: number;
  setLimit: number;
  itemLimit: number;
  outputRowLimit: number;
}

/** B65 static plan facts. No Records API or runtime row count is involved. */
export function buildGroupingExplainMetadata(
  statement: SelectStatement,
  canonicalItemCount?: number
): GroupingExplainMetadata | null {
  const grouping = normalizeGroupingSpec(statement);
  if (grouping.type !== "GROUPING_SETS") return null;
  return {
    source: grouping.source,
    expandedSetCount: grouping.sets.length,
    groupingItemCount: canonicalItemCount ?? grouping.allItems.length,
    setLimit: B65_MAX_GROUPING_SETS,
    itemLimit: B65_MAX_GROUPING_ITEMS,
    outputRowLimit: B65_MAX_GENERATED_ROWS,
  };
}

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
    || statement.groupBy.length > 0
    || normalizeGroupingSpec(statement).type === "GROUPING_SETS"
    || statement.orderBy.length > 0
    // JOIN key prefilter planning selects `in`, range, or fallback from the
    // physical JOIN target field type.  Without this guard the CLI chooses its
    // API-rejecting dry-run client, then the shared EXPLAIN engine reaches
    // getFields() while planning a CTE/temp -> APP JOIN.
    || statement.joins.some((join) =>
      join.type !== "CROSS"
      &&
      join.table.appId > 0
      && join.table.cteName === null
      && (join.on.left.field !== "$id" || join.on.right.field !== "$id")
    )
    || statement.columns.some((column) =>
      column.type === "WINDOW_COL" && column.orderBy.length > 0
    );
}

function cteQueriesContainPhysicalSelect(ctes: unknown): boolean {
  if (!Array.isArray(ctes)) return false;
  const seen = new Set<object>();
  const visit = (node: unknown): boolean => {
    if (node === null || typeof node !== "object") return false;
    if (seen.has(node as object)) return false;
    seen.add(node as object);
    if (Array.isArray(node)) return node.some(visit);

    const item = node as Record<string, unknown>;
    if (item["type"] === "SELECT") {
      const select = node as SelectStatement;
      if ([select.from, ...select.joins.map((join) => join.table)]
        .some((table) => table.appId > 0 && table.cteName === null)) {
        return true;
      }
    }
    return Object.values(item).some(visit);
  };
  return ctes.some((cte) => visit((cte as { query?: unknown })?.query));
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
    // CTE の出力列推論は、CTE 定義内の物理 APP ごとにフォーム定義を読む。
    // WITH 本体の物理 APP は対象に含めず、非 CTE SELECT と B155 静的経路を維持する。
    if (item["type"] === "WITH" && cteQueriesContainPhysicalSelect(item["ctes"])) {
      return true;
    }
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

/**
 * native UPSERT の条件 3 を EXPLAIN で判定するため、target app のフォーム定義が
 * 必要かを返す。CLI の完全オフライン判定とは分離して使用する。
 */
export function explainNeedsNativeUpsertTargetMetadata(statement: unknown): boolean {
  const seen = new Set<object>();
  const visit = (node: unknown): boolean => {
    if (node === null || typeof node !== "object") return false;
    if (seen.has(node as object)) return false;
    seen.add(node as object);
    if (Array.isArray(node)) return node.some(visit);

    const item = node as Record<string, unknown>;
    if (item["type"] === "UPSERT" || item["type"] === "UPSERT_SELECT") return true;
    return Object.values(item).some(visit);
  };
  return visit(statement);
}
