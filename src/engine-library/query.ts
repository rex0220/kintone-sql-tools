import {
  execute,
  getSelectColumnMeta,
  type ExecuteMetrics,
  type MaterializedColumnMetaMap,
  type SelectResult,
} from "../execute";
import { normalizeEngineError } from "./errors";
import { withCursorScope } from "./cursorScope";
import { validateQueryOptions } from "./options";
import { projectReadonlyClient } from "./readonlyClient";
import {
  guardExplainQuerySql,
  guardRunQuerySql,
} from "./statementGuard";
import type {
  ExplainResult,
  QueryMetrics,
  QueryResult,
  RunQueryOptions,
} from "./publicTypes";

function mapMetrics(metrics?: ExecuteMetrics): QueryMetrics {
  return {
    recordGetCalls: metrics?.getCalls ?? 0,
    fetchedRows: metrics?.fetchedRows ?? 0,
    elapsedMs: metrics?.elapsedMs ?? 0,
    cursorRecordsScanned: metrics?.cursorRecordsScanned ?? 0,
  };
}

function assertSelectResult(result: unknown): asserts result is SelectResult {
  if (result === null || typeof result !== "object" || (result as { type?: unknown }).type !== "SELECT") {
    throw new Error("Engine returned a non-SELECT result");
  }
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

export async function runQuery(
  sql: string,
  options: RunQueryOptions
): Promise<QueryResult> {
  try {
    const invocation = validateQueryOptions(options, "run");
    guardRunQuerySql(sql);
    const result = await withCursorScope(
      invocation.client,
      (client) => execute(
        sql,
        projectReadonlyClient(client),
        { ...invocation.executeOptions, captureColumnMeta: true }
      )
    );
    assertSelectResult(result);
    const columnMeta = getSelectColumnMeta(result);
    return {
      type: "query",
      rows: result.rows.map(copyStringRow),
      columns: result.columns.map((name) => toPublicColumn(name, columnMeta)),
      rowCount: result.rowCount,
      warnings: [...(result.warnings ?? [])],
      ...(result.validateStats ? { validateStats: result.validateStats } : {}),
      metrics: mapMetrics(result.metrics),
    };
  } catch (error) {
    throw normalizeEngineError(error);
  }
}

export async function explainQuery(
  sql: string,
  options: Omit<RunQueryOptions, "onLimitReached">
): Promise<ExplainResult> {
  try {
    const invocation = validateQueryOptions(options, "explain");
    const result = await withCursorScope(
      invocation.client,
      (client) => execute(
        guardExplainQuerySql(sql),
        projectReadonlyClient(client),
        invocation.executeOptions
      )
    );
    assertSelectResult(result);
    const lines = result.rows.map((row) => String(row.plan ?? ""));
    return {
      type: "explain",
      lines,
      text: lines.join("\n"),
      metrics: mapMetrics(result.metrics),
    };
  } catch (error) {
    throw normalizeEngineError(error);
  }
}
