import {
  execute,
  type SelectResult,
} from "../execute";
import { normalizeEngineError } from "./errors";
import { withCursorScope } from "./cursorScope";
import { validateQueryOptions } from "./options";
import { projectReadonlyClient } from "./readonlyClient";
import { mapMetrics, toQueryResult } from "./resultMapping";
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

function assertSelectResult(result: unknown): asserts result is SelectResult {
  if (result === null || typeof result !== "object" || (result as { type?: unknown }).type !== "SELECT") {
    throw new Error("Engine returned a non-SELECT result");
  }
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
    return toQueryResult(result);
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
