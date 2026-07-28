import {
  buildBatchExplainPlans,
  execute,
  type SelectResult,
} from "../execute";
import {
  normalizeBatchBoundaryError,
  normalizeEngineError,
} from "./errors";
import { withCursorScope } from "./cursorScope";
import { validateQueryOptions } from "./options";
import { projectReadonlyClient } from "./readonlyClient";
import { mapMetrics, toQueryResult } from "./resultMapping";
import {
  guardRunQuerySql,
  prepareExplainQuerySql,
} from "./statementGuard";
import type {
  ExplainResult,
  QueryMetrics,
  QueryResult,
  RunQueryOptions,
} from "./publicTypes";
import type { Statement } from "../types/ast";

function assertSelectResult(result: unknown): asserts result is SelectResult {
  if (result === null || typeof result !== "object" || (result as { type?: unknown }).type !== "SELECT") {
    throw new Error("Engine returned a non-SELECT result");
  }
}

/**
 * Executes one row-returning read-only statement: SELECT, WITH, UNION,
 * SHOW APPS, DESCRIBE, or existing-record VALIDATE.
 */
export async function runQuery(
  sql: string,
  options: RunQueryOptions
): Promise<QueryResult> {
  try {
    const invocation = validateQueryOptions(options, "run");
    const statement = guardRunQuerySql(sql);
    const executeOptions = statement.type === "VALIDATE"
      ? { ...invocation.executeOptions, onLimitReached: "error" as const }
      : invocation.executeOptions;
    const result = await withCursorScope(
      invocation.client,
      (client) => execute(
        sql,
        projectReadonlyClient(client),
        { ...executeOptions, captureColumnMeta: true }
      )
    );
    assertSelectResult(result);
    return toQueryResult(result);
  } catch (error) {
    throw normalizeEngineError(error);
  }
}

/**
 * Explains read-only statements and batches without reading records.
 */
export async function explainQuery(
  sql: string,
  options: Omit<RunQueryOptions, "onLimitReached">
): Promise<ExplainResult> {
  let statements: readonly Statement[] = [];
  try {
    const invocation = validateQueryOptions(options, "explain");
    const prepared = prepareExplainQuerySql(sql);
    statements = prepared.statements;
    if (prepared.legacySql !== undefined) {
      const result = await withCursorScope(
        invocation.client,
        (client) => execute(
          prepared.legacySql!,
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
    }

    const result = await withCursorScope(
      invocation.client,
      (client) => buildBatchExplainPlans(
        sql,
        projectReadonlyClient(client),
        undefined,
        "batch-explain",
        invocation.executeOptions.maxRecords,
        invocation.executeOptions.cursorMaxActive
      )
    );
    const lines = result.statements.flatMap((statement) => [
      ...(result.statementCount > 1
        ? [`[${statement.index + 1}] ${statement.type}`]
        : []),
      ...statement.plan,
    ]);
    return {
      type: "explain",
      lines,
      text: lines.join("\n"),
      metrics: mapMetrics(),
    };
  } catch (error) {
    throw normalizeBatchBoundaryError(error, statements);
  }
}
