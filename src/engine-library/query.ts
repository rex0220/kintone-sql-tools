import {
  execute,
  type ExecuteMetrics,
  type KintoneClient,
  type SelectResult,
} from "../execute";
import { parseSqlStatement } from "../core/sql";
import {
  normalizeEngineError,
  parseError,
  readOnlyViolation,
} from "./errors";
import { validateQueryOptions } from "./options";
import type {
  ExplainResult,
  QueryMetrics,
  QueryResult,
  RunQueryOptions,
} from "./publicTypes";

const RUN_READ_TOP_LEVEL = new Set([
  "SELECT",
  "WITH",
  "UNION",
  "SHOW_APPS",
  "DESCRIBE",
]);
const EXPLAIN_READ_TOP_LEVEL = new Set(["SELECT", "WITH", "UNION"]);

class ClientOperationError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(message);
    this.name = "ClientOperationError";
    this.cause = cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

async function clientCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new ClientOperationError(error);
  }
}

function bridgeClient(client: RunQueryOptions["client"]): KintoneClient {
  const projected = {
    getRecords: (params: Parameters<typeof client.getRecords>[0]) =>
      clientCall(() => client.getRecords(params)),
    openCursor: async (params: Parameters<typeof client.openCursor>[0]) => {
      const handle = await clientCall(() => client.openCursor(params));
      return {
        totalCount: handle.totalCount,
        nextPage: () => clientCall(() => handle.nextPage()),
        close: () => clientCall(() => handle.close()),
      };
    },
    getApps: () => clientCall(() => client.getApps()),
    getFields: (appId: number) => clientCall(() => client.getFields(appId)),
    getNumberPrecision: (appId: number) =>
      clientCall(() => client.getNumberPrecision(appId)),
    getProcessStatuses: (appId: number) =>
      clientCall(() => client.getProcessStatuses(appId)),
  };
  // Step 3 hardens this bridge into the complete readonly projection and bypass guard.
  return projected as unknown as KintoneClient;
}

function assertRunTopLevel(sql: string): void {
  const statement = parseSqlStatement(sql, { import: true });
  if (RUN_READ_TOP_LEVEL.has(statement.type)) return;
  throw readOnlyViolation(`runQuery does not allow ${statement.type} statements`);
}

function normalizeExplainSql(sql: string): string {
  const trimmed = sql.trim();
  if (trimmed === "") throw parseError("SQL statement is empty");
  const statement = parseSqlStatement(trimmed, { import: true });
  if (statement.type === "EXPLAIN") {
    if (!EXPLAIN_READ_TOP_LEVEL.has(statement.query.type)) {
      throw readOnlyViolation(
        `explainQuery does not allow ${statement.query.type} statements`
      );
    }
    return trimmed;
  }
  if (!EXPLAIN_READ_TOP_LEVEL.has(statement.type)) {
    throw readOnlyViolation(`explainQuery does not allow ${statement.type} statements`);
  }
  return `EXPLAIN ${trimmed}`;
}

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

export async function runQuery(
  sql: string,
  options: RunQueryOptions
): Promise<QueryResult> {
  try {
    const invocation = validateQueryOptions(options, "run");
    assertRunTopLevel(sql);
    const result = await execute(
      sql,
      bridgeClient(invocation.client),
      invocation.executeOptions
    );
    assertSelectResult(result);
    return {
      type: "query",
      rows: result.rows.map(copyStringRow),
      columns: result.columns.map((name) => ({ name, valueType: "string" as const })),
      rowCount: result.rowCount,
      warnings: [...(result.warnings ?? [])],
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
    const result = await execute(
      normalizeExplainSql(sql),
      bridgeClient(invocation.client),
      invocation.executeOptions
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
