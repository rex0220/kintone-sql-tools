import { diagnosticAt } from "../core/diagnostics";
import { validateScriptCore } from "../core/dialect1Validation";
import {
  canonicalizeLogicalAppName,
  collectAppProfileTokens,
  normalizeSqlAppProfiles,
  type AppBinding,
} from "../core/logicalApps";
import { parseScript as parseScriptCore } from "../core/script";
import {
  buildBatchExplainPlans,
  createManagedStatementExecutionContext,
  disposeManagedStatementExecutionContext,
  executeManagedStatement,
  type ManagedStatementExecutionContext,
} from "../execute";
import { createKintoneClient } from "./writableClient";
import { KsqlFlowError, normalizeFlowError } from "./errors";
import type {
  CreateExecutionContextOptions,
  Diagnostic,
  ExecutionContext,
  ExplainScriptOptions,
  ExplainScriptResult,
  ParseScriptOptions,
  ParseScriptResult,
  Statement,
  StatementResult,
  ValidateScriptOptions,
} from "./publicTypes";

declare const __KSQL_FLOW_VERSION__: string;

export const version: string =
  typeof __KSQL_FLOW_VERSION__ === "string" ? __KSQL_FLOW_VERSION__ : "0.0.0-dev";

const handles = new WeakMap<object, ManagedStatementExecutionContext>();
const bindingsByStatements = new WeakMap<object, ReadonlyMap<number, AppBinding>>();

export function parseScript(source: string, opts: ParseScriptOptions = {}): ParseScriptResult {
  return parseWithBindings(source, opts);
}

export async function validateScript(
  source: string,
  opts: ValidateScriptOptions = {}
): Promise<Diagnostic[]> {
  const parsed = parseWithBindings(source, opts);
  if (parsed.diagnostics.some((item) => item.severity === "error")) return parsed.diagnostics;
  const bindings = bindingsByStatements.get(parsed.statements);
  const physicalAppId = (appId: number) => bindings?.get(appId)?.appId ?? appId;
  const schema = opts.schema
    ? (appId: number) => opts.schema!(physicalAppId(appId))
    : opts.client
    ? (appId: number) => opts.client!.getFields(physicalAppId(appId))
    : undefined;
  const coreDiagnostics = await validateScriptCore(parsed.statements, parsed.meta, schema, {
    strict: opts.strict,
  });
  const positioned = coreDiagnostics.map((item) => {
    const offset = parsed.statementRanges[item.statementIndex ?? 0]?.start ?? 0;
    return diagnosticAt(source, offset, {
      severity: item.severity,
      code: item.code,
      message: item.message,
      ...(item.statementIndex !== undefined ? { statementIndex: item.statementIndex } : {}),
    });
  });
  return [...parsed.diagnostics, ...positioned];
}

export async function explainScript(
  source: string,
  opts: ExplainScriptOptions
): Promise<ExplainScriptResult> {
  const parsed = parseWithBindings(source, opts);
  const error = parsed.diagnostics.find((item) => item.severity === "error");
  if (error) throw new KsqlFlowError(error.code, `${error.message} (${error.line}:${error.column})`);
  const normalizedSource = normalizeLogicalApps(source, opts.apps);
  const bindings = bindingsByStatements.get(parsed.statements);
  const explainClient = bindings ? routeClient(opts.client, bindings) : opts.client;
  try {
    return await buildBatchExplainPlans(
      normalizedSource,
      explainClient,
      opts.variables,
      "flow-explain",
      opts.maxRecords,
      opts.cursorMaxActive,
      false,
      opts.dmlMaxRows,
      opts.dmlMaxSubtableRows,
      opts.resolveMetadata,
      opts.recursiveCteMaxDepth,
      opts.recursiveCteMaxRows,
      opts.recursiveCteMaxExpansions,
      opts.asOf,
      opts.timezone
    );
  } catch (error) {
    throw normalizeFlowError(error);
  }
}

export function createExecutionContext(opts: CreateExecutionContextOptions): ExecutionContext {
  try {
    const fromScript = opts.script !== undefined;
    const fromStatements = opts.statements !== undefined || opts.meta !== undefined;
    if (fromScript === fromStatements) {
      throw new TypeError("Provide exactly one of script or statements+meta.");
    }
    let statements: readonly Statement[];
    let dialect: 0 | 1;
    if (fromScript) {
      const parsed = parseWithBindings(opts.script!, opts);
      const error = parsed.diagnostics.find((item) => item.severity === "error");
      if (error) throw new KsqlFlowError(error.code, `${error.message} (${error.line}:${error.column})`);
      statements = parsed.statements;
      dialect = parsed.meta.dialect;
    } else {
      if (opts.statements === undefined || opts.meta === undefined) {
        throw new TypeError("statements and meta must be provided together.");
      }
      statements = opts.statements;
      dialect = opts.meta.dialect;
    }
    const handle = {} as ExecutionContext;
    const {
      client, script: _script, statements: _statements, meta: _meta, apps: _apps,
      onChunkWritten, ...executeOptions
    } = opts;
    const bindings = bindingsByStatements.get(statements as object);
    const executionClient = bindings ? routeClient(client, bindings) : client;
    const routedOnChunkWritten = onChunkWritten && bindings
      ? (info: import("./publicTypes").FlowChunkWrittenInfo) => onChunkWritten({
          ...info,
          appId: bindings.get(info.appId)?.appId ?? info.appId,
        })
      : onChunkWritten;
    handles.set(
      handle as object,
      createManagedStatementExecutionContext(
        statements,
        dialect,
        executionClient,
        executeOptions,
        routedOnChunkWritten
      )
    );
    return handle;
  } catch (error) {
    throw normalizeFlowError(error);
  }
}

export async function executeStatement(
  statement: Statement,
  context: ExecutionContext
): Promise<StatementResult> {
  const managed = handles.get(context as object);
  if (!managed) {
    throw new KsqlFlowError("ExecutionContextDisposedError", "ExecutionContextDisposedError: execution context is disposed or invalid.");
  }
  const internal = await executeManagedStatement(statement, managed);
  let kind: StatementResult["kind"] = "STATEMENT";
  if (statement.type === "ASSERT") {
    if (internal.status === "error") kind = "ASSERT_VIOLATION";
    else if (internal.result?.type === "ASSERT" && internal.result.warning !== undefined) kind = "ASSERT_WARNING";
    else if (internal.status === "success") kind = "ASSERT_PASSED";
  } else if (
    statement.type === "EXIT"
    && internal.result?.type === "EXIT"
    && internal.result.exited
  ) {
    kind = "EXIT_NO_DATA";
  }
  return { ...internal, kind, metrics: snapshotMetrics(managed.metrics) };
}

function snapshotMetrics(metrics: import("./publicTypes").ExecutionMetrics): import("./publicTypes").ExecutionMetrics {
  return { ...metrics, limitReachedApps: [...metrics.limitReachedApps] };
}

export async function disposeExecutionContext(context: ExecutionContext): Promise<void> {
  const managed = handles.get(context as object);
  if (!managed) return;
  handles.delete(context as object);
  await disposeManagedStatementExecutionContext(managed);
}

function normalizeLogicalApps(
  source: string,
  apps: Readonly<Record<string, number>> | undefined
): string {
  if (!collectAppProfileTokens(source).some((token) => token.source === "logical")) return source;
  if (apps === undefined) throw new Error("Logical app configuration is required.");
  return normalizedLogicalAppResult(source, apps).normalizedSql;
}

function parseWithBindings(source: string, opts: ParseScriptOptions): ParseScriptResult {
  const parsed = parseScriptCore(source, opts);
  if (opts.apps !== undefined && collectAppProfileTokens(source).some((token) => token.source === "logical")) {
    const normalized = normalizedLogicalAppResult(source, opts.apps);
    bindingsByStatements.set(parsed.statements, normalized.appBindingByMappedApp);
  }
  return parsed;
}

function normalizedLogicalAppResult(source: string, apps: Readonly<Record<string, number>>) {
  const resolved = new Map<string, number>();
  for (const [name, appId] of Object.entries(apps)) {
    const withoutPrefix = name.toUpperCase().startsWith("LAPP_") ? name.slice(5) : name;
    try { resolved.set(canonicalizeLogicalAppName(withoutPrefix), appId); } catch { /* parseScript reports invalid/missing use */ }
  }
  return normalizeSqlAppProfiles(source, "flow", {
    resolveLogicalApp(name) {
      const appId = resolved.get(canonicalizeLogicalAppName(name));
      if (appId === undefined) throw new Error(`Logical app LAPP_${name} is not defined.`);
      return appId;
    },
  });
}

function routeClient(
  client: import("../execute").KintoneClient,
  bindings: ReadonlyMap<number, AppBinding>
): import("../execute").KintoneClient {
  const app = (mapped: number) => bindings.get(mapped)?.appId ?? mapped;
  return {
    getRecords: (params) => client.getRecords({ ...params, app: app(params.app) }),
    openCursor: (params) => client.openCursor({ ...params, app: app(params.app) }),
    postRecords: (params) => client.postRecords({ ...params, app: app(params.app) }),
    putRecords: (params) => client.putRecords({ ...params, app: app(params.app) }),
    deleteRecords: (params) => client.deleteRecords({ ...params, app: app(params.app) }),
    getApps: () => client.getApps(),
    getFields: (appId) => client.getFields(app(appId)),
    getNumberPrecision: (appId) => client.getNumberPrecision(app(appId)),
    getProcessStatuses: (appId) => client.getProcessStatuses(app(appId)),
  };
}

export { isDmlResult } from "./publicTypes";
export { createKintoneClient, KsqlFlowError };
export type {
  CreateExecutionContextOptions,
  CreateKintoneClientConfig,
  Diagnostic,
  DiagnosticCode,
  ExecutionContext,
  ExplainScriptOptions,
  ExplainScriptResult,
  FieldInfo,
  FlowChunkWrittenInfo,
  FlowDeleteResult,
  FlowDmlResult,
  FlowInsertResult,
  FlowKintoneClient,
  FlowUpdateResult,
  FlowUpsertResult,
  ParseScriptOptions,
  ParseScriptResult,
  SchemaResolver,
  ScriptHeaderMeta,
  Statement,
  StatementResult,
  StatementResultKind,
  ValidateScriptOptions,
} from "./publicTypes";
