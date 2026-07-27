import {
  getSelectColumnMeta,
  type ExecuteMetrics,
  type MaterializedColumnMetaMap,
  type SelectResult,
} from "../execute";
import type {
  QueryMetrics,
  QueryResult,
} from "./publicTypes";

export function mapMetrics(metrics?: ExecuteMetrics): QueryMetrics {
  return {
    recordGetCalls: metrics?.getCalls ?? 0,
    fetchedRows: metrics?.fetchedRows ?? 0,
    elapsedMs: metrics?.elapsedMs ?? 0,
    cursorRecordsScanned: metrics?.cursorRecordsScanned ?? 0,
  };
}

function copyStringRow(row: Readonly<Record<string, unknown>>): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, String(value)])
  );
}

function toPublicColumn(name: string, meta: MaterializedColumnMetaMap | undefined) {
  const columnMeta = meta?.get(name);
  const fieldType = columnMeta?.fieldType ?? columnMeta?.semantics?.fieldType;
  const compareMode = columnMeta?.semantics?.compareMode;
  const sortKind = columnMeta?.sortKind
    ?? (compareMode === "number" || compareMode === "string" ? compareMode : undefined);
  const sourceApp = columnMeta?.publicSourceApp;
  return {
    name,
    valueType: "string" as const,
    ...(fieldType !== undefined ? { fieldType } : {}),
    ...(sortKind !== undefined ? { sortKind } : {}),
    ...(sourceApp !== undefined ? { sourceApp } : {}),
  };
}

export function toQueryResult(
  result: SelectResult,
  metrics: ExecuteMetrics | undefined = result.metrics
): QueryResult {
  const columnMeta = getSelectColumnMeta(result);
  return {
    type: "query",
    rows: result.rows.map(copyStringRow),
    columns: result.columns.map((name) => toPublicColumn(name, columnMeta)),
    rowCount: result.rowCount,
    warnings: [...(result.warnings ?? [])],
    ...(result.validateStats ? { validateStats: result.validateStats } : {}),
    metrics: mapMetrics(metrics),
  };
}
