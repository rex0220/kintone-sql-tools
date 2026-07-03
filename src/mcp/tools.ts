import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import {
  execute,
  parseSqlStatement,
  type ExecuteOptions,
  type ExecuteResult,
  type KintoneClient,
  type SelectResult,
} from "../core";
import {
  buildCacheContext,
  extractAppIds,
  normalizeSqlAppProfiles,
} from "../node/appProfiles";
import {
  getInsertValuesCount,
  getStatementType,
  hasWhereClause,
  isDmlType,
  isNoFromSelectStatement,
  isReadOnlyType,
} from "../node/dmlGuard";
import { envString, loadOptionalKsqlConfig, type OnLimitMode } from "../node/config";
import {
  createKsqlRuntime,
  resolveDefaultProfile,
  type CreateKsqlRuntimeInput,
  type KsqlRuntime,
  type KsqlRuntimeServerOptions,
} from "../node/runtime";
import {
  describeAppInputSchema,
  explainInputSchema,
  listQueriesInputSchema,
  mutateInputSchema,
  queryInputSchema,
  runSavedQueryInputSchema,
  savedQueryNameInputSchema,
  saveQueryInputSchema,
  showAppsInputSchema,
  validateInputSchema,
} from "./schemas";
import {
  assertProfileOverrideAllowed,
  assertSavedQuerySafety,
  deleteSavedQuery,
  getSavedQuery,
  loadSavedQueryCatalog,
  resolveSavedQueryCatalogPath,
  saveSavedQueryCatalog,
  upsertSavedQuery,
} from "./savedQueries";

export type QueryInput = z.infer<typeof queryInputSchema>;
export type MutateInput = z.infer<typeof mutateInputSchema>;
export type ExplainInput = z.infer<typeof explainInputSchema>;
export type ValidateInput = z.infer<typeof validateInputSchema>;
export type DescribeAppInput = z.infer<typeof describeAppInputSchema>;
export type ShowAppsInput = z.infer<typeof showAppsInputSchema>;
export type ListQueriesInput = z.infer<typeof listQueriesInputSchema>;
export type SaveQueryInput = z.infer<typeof saveQueryInputSchema>;
export type SavedQueryNameInput = z.infer<typeof savedQueryNameInputSchema>;
export type RunSavedQueryInput = z.infer<typeof runSavedQueryInputSchema>;

export interface KsqlMcpToolDependencies {
  createRuntime?: (
    serverOptions: KsqlRuntimeServerOptions,
    input: CreateKsqlRuntimeInput
  ) => Promise<KsqlRuntime>;
  executeSql?: (
    sql: string,
    client: KintoneClient,
    options?: ExecuteOptions
  ) => Promise<ExecuteResult>;
}

export interface ValidationResult {
  ok: true;
  statementType: string;
  isDml: boolean;
  isReadOnly: boolean;
  hasWhere: boolean;
  insertValuesCount: number | null;
  appIds: number[];
  canRunWithQueryTool: boolean;
  requiresMutationTool: boolean;
  normalizedSql: string;
  hasProfileSyntax: boolean;
  cacheContext: string;
  appBindings: Array<{ mappedAppId: number; appId: number; profile: string }>;
}

const DEFAULT_MAX_RECORDS = 500;
const DEFAULT_ON_LIMIT: OnLimitMode = "error";

function noOpClient(): KintoneClient {
  const fail = async (): Promise<never> => {
    throw new Error("No-op client should not be called.");
  };
  return {
    getRecords: fail,
    postRecords: fail,
    putRecords: fail,
    deleteRecords: fail,
    getApps: fail,
    getFields: fail,
  };
}

function getToolProfile(
  serverOptions: KsqlRuntimeServerOptions,
  inputProfile?: string
): string {
  const configPath = getServerConfigPath(serverOptions);
  const config = loadOptionalKsqlConfig(configPath);
  return resolveDefaultProfile(config, serverOptions, inputProfile);
}

function getServerConfigPath(serverOptions: KsqlRuntimeServerOptions): string {
  return serverOptions.configPath ?? envString("KSQL_CONFIG") ?? "./ksql.config.json";
}

function getSavedQueryCatalogPath(serverOptions: KsqlRuntimeServerOptions): string {
  const configPath = getServerConfigPath(serverOptions);
  const config = loadOptionalKsqlConfig(configPath);
  return resolveSavedQueryCatalogPath({
    configPath,
    configSavedQueriesPath: config.mcp?.savedQueries?.path,
  });
}

function normalizeSqlForTool(
  serverOptions: KsqlRuntimeServerOptions,
  sql: string,
  inputProfile?: string
) {
  const profileName = getToolProfile(serverOptions, inputProfile);
  const normalized = normalizeSqlAppProfiles(sql, profileName);
  return {
    profileName,
    normalizedSql: normalized.normalizedSql,
    hasProfileSyntax: normalized.hasProfileSyntax,
    appBindingByMappedApp: normalized.appBindingByMappedApp,
    cacheContext: buildCacheContext(profileName, normalized.appBindingByMappedApp),
  };
}

function explainSql(sql: string): string {
  return /^\s*EXPLAIN\b/i.test(sql) ? sql : `EXPLAIN ${sql}`;
}

function toSelectPayload(result: SelectResult) {
  return {
    ok: true,
    type: result.type,
    columns: result.columns,
    rows: result.rows,
    rowCount: result.rowCount,
    warnings: result.warnings ?? [],
  };
}

function toMutationPayload(result: Exclude<ExecuteResult, SelectResult>) {
  if (result.type === "INSERT") {
    return {
      ok: true,
      type: result.type,
      insertedCount: result.insertedCount,
      createdIds: result.createdIds,
    };
  }
  if (result.type === "UPDATE") {
    return {
      ok: true,
      type: result.type,
      updatedCount: result.updatedCount,
    };
  }
  if (result.type === "DELETE") {
    return {
      ok: true,
      type: result.type,
      deletedCount: result.deletedCount,
    };
  }
  if (result.type === "UPSERT") {
    return {
      ok: true,
      type: result.type,
      insertedCount: result.insertedCount,
      updatedCount: result.updatedCount,
    };
  }
  return {
    ok: true,
    type: result.type,
    reorderedParentCount: result.reorderedParentCount,
  };
}

function toErrorPayload(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const codeMatch = message.match(/^([A-Za-z]+Error):/);
  const errorName = err instanceof Error && err.name !== "Error" ? err.name : null;
  return {
    ok: false,
    error: {
      code: errorName ?? codeMatch?.[1] ?? "Error",
      message,
    },
  };
}

function requireDmlApproval(
  input: { allowDml?: unknown; confirmText?: unknown; dmlMaxRows?: unknown },
  toolName: string,
  suffix = ""
): number {
  const context = suffix ? ` ${suffix}` : "";
  if (input.allowDml !== true) {
    throw new Error(`ArgumentError: allowDml: true is required by ${toolName}${context}.`);
  }
  if (input.confirmText !== "yes") {
    throw new Error(`ArgumentError: confirmText: "yes" is required by ${toolName}${context}.`);
  }
  if (!Number.isInteger(input.dmlMaxRows) || Number(input.dmlMaxRows) <= 0) {
    throw new Error(`ArgumentError: dmlMaxRows must be a positive integer for ${toolName}${context}.`);
  }
  return Number(input.dmlMaxRows);
}

export function toToolResult(payload: object, isError = false): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload as Record<string, unknown>,
    isError,
  };
}

async function runSafely<T extends object>(
  fn: () => Promise<T>
): Promise<CallToolResult> {
  try {
    return toToolResult(await fn());
  } catch (err) {
    return toToolResult(toErrorPayload(err), true);
  }
}

export function createKsqlMcpTools(
  serverOptions: KsqlRuntimeServerOptions,
  deps: KsqlMcpToolDependencies = {}
) {
  const createRuntime = deps.createRuntime ?? createKsqlRuntime;
  const executeSql = deps.executeSql ?? execute;

  async function validate(input: ValidateInput): Promise<ValidationResult> {
    const normalized = normalizeSqlForTool(serverOptions, input.sql, input.profile);
    const stmt = parseSqlStatement(normalized.normalizedSql);
    const statementType = getStatementType(stmt);
    const isDml = isDmlType(statementType);
    const isReadOnly = isReadOnlyType(statementType);
    const appBindings = [...normalized.appBindingByMappedApp.entries()].map(([mappedAppId, binding]) => ({
      mappedAppId,
      appId: binding.appId,
      profile: binding.profile,
    }));

    return {
      ok: true,
      statementType,
      isDml,
      isReadOnly,
      hasWhere: hasWhereClause(stmt),
      insertValuesCount: getInsertValuesCount(stmt),
      appIds: extractAppIds(normalized.normalizedSql),
      canRunWithQueryTool: isReadOnly,
      requiresMutationTool: isDml,
      normalizedSql: normalized.normalizedSql,
      hasProfileSyntax: normalized.hasProfileSyntax,
      cacheContext: normalized.cacheContext,
      appBindings,
    };
  }

  async function explain(input: ExplainInput): Promise<Record<string, unknown>> {
    const normalized = normalizeSqlForTool(serverOptions, input.sql, input.profile);
    const result = await executeSql(explainSql(normalized.normalizedSql), noOpClient(), {
      cacheContext: normalized.cacheContext,
    });
    if (result.type !== "SELECT") {
      throw new Error(`ArgumentError: EXPLAIN returned unexpected result type ${result.type}.`);
    }
    return toSelectPayload(result);
  }

  async function query(input: QueryInput): Promise<Record<string, unknown>> {
    const validation = await validate(input);
    if (!validation.isReadOnly) {
      throw new Error(`ArgumentError: ${validation.statementType} is not allowed by ksql_query. Use ksql_mutate.`);
    }

    const stmt = parseSqlStatement(validation.normalizedSql);
    const noAppApiNeeded = isNoFromSelectStatement(stmt);

    if (noAppApiNeeded) {
      const result = await executeSql(validation.normalizedSql, noOpClient(), {
        maxRecords: input.maxRecords ?? DEFAULT_MAX_RECORDS,
        onLimitReached: input.onLimit ?? DEFAULT_ON_LIMIT,
        cacheContext: validation.cacheContext,
      });
      if (result.type !== "SELECT") {
        throw new Error(`ArgumentError: read-only query returned unexpected result type ${result.type}.`);
      }
      return toSelectPayload(result);
    }

    const runtime = await createRuntime(serverOptions, {
      sql: input.sql,
      profile: input.profile,
      maxRecords: input.maxRecords,
      fetchParallel: input.fetchParallel,
      onLimit: input.onLimit,
      timeout: input.timeout,
    });
    const result = await executeSql(runtime.sql, runtime.client, {
      maxRecords: runtime.maxRecords,
      fetchParallel: runtime.fetchParallel,
      onLimitReached: runtime.onLimit,
      cacheContext: runtime.cacheContext,
    });
    if (result.type !== "SELECT") {
      throw new Error(`ArgumentError: read-only query returned unexpected result type ${result.type}.`);
    }
    return toSelectPayload(result);
  }

  async function mutate(input: MutateInput): Promise<Record<string, unknown>> {
    const dmlMaxRows = requireDmlApproval(input, "ksql_mutate");

    const validation = await validate(input);
    if (!validation.isDml) {
      throw new Error(`ArgumentError: ${validation.statementType} is not allowed by ksql_mutate. Use ksql_query.`);
    }
    if (validation.statementType === "INSERT_SELECT" || validation.statementType === "UPSERT_SELECT") {
      throw new Error(`ArgumentError: ${validation.statementType} is not supported by ksql_mutate yet.`);
    }
    if ((validation.statementType === "UPDATE" || validation.statementType === "DELETE") && !validation.hasWhere) {
      throw new Error(`ArgumentError: ${validation.statementType} without WHERE is blocked by ksql_mutate.`);
    }
    if (validation.insertValuesCount !== null && validation.insertValuesCount > dmlMaxRows) {
      throw new Error(`ArgumentError: INSERT rows (${validation.insertValuesCount}) exceed dmlMaxRows (${dmlMaxRows}).`);
    }

    const runtime = await createRuntime(serverOptions, {
      sql: input.sql,
      profile: input.profile,
      maxRecords: dmlMaxRows + 1,
      fetchParallel: input.fetchParallel,
      onLimit: DEFAULT_ON_LIMIT,
      timeout: input.timeout,
    });
    const result = await executeSql(runtime.sql, runtime.client, {
      maxRecords: runtime.maxRecords,
      fetchParallel: runtime.fetchParallel,
      onLimitReached: runtime.onLimit,
      cacheContext: runtime.cacheContext,
      confirm: async (count, operation) => {
        if (count > dmlMaxRows) {
          throw new Error(`ArgumentError: ${operation} affected rows (${count}) exceed dmlMaxRows (${dmlMaxRows}).`);
        }
        return true;
      },
    });
    if (result.type === "SELECT") {
      throw new Error(`ArgumentError: ksql_mutate returned unexpected result type ${result.type}.`);
    }
    return toMutationPayload(result);
  }

  async function describeApp(input: DescribeAppInput): Promise<Record<string, unknown>> {
    return await query({
      sql: `DESCRIBE APP${input.app}`,
      profile: input.profile,
      maxRecords: input.maxRecords,
      fetchParallel: input.fetchParallel,
      onLimit: input.onLimit,
      timeout: input.timeout,
    });
  }

  async function showApps(input: ShowAppsInput): Promise<Record<string, unknown>> {
    return await query({
      sql: "SHOW APPS",
      profile: input.profile,
      maxRecords: input.maxRecords,
      fetchParallel: input.fetchParallel,
      onLimit: input.onLimit,
      timeout: input.timeout,
    });
  }

  async function saveQuery(input: SaveQueryInput): Promise<Record<string, unknown>> {
    const validation = await validate({
      sql: input.sql,
      profile: input.defaultProfile,
    });
    assertSavedQuerySafety(input, {
      isDml: validation.isDml,
      statementType: validation.statementType,
    });

    const filePath = getSavedQueryCatalogPath(serverOptions);
    const catalog = await loadSavedQueryCatalog(filePath);
    const saved = upsertSavedQuery(catalog, input);
    await saveSavedQueryCatalog(filePath, saved.catalog);
    return {
      ok: true,
      created: saved.created,
      query: saved.query,
    };
  }

  async function listQueries(_input: ListQueriesInput = {}): Promise<Record<string, unknown>> {
    const catalog = await loadSavedQueryCatalog(getSavedQueryCatalogPath(serverOptions));
    return {
      ok: true,
      queries: catalog.queries.map((query) => ({
        name: query.name,
        title: query.title,
        description: query.description,
        defaultProfile: query.defaultProfile,
        readOnly: query.readOnly,
        allowProfileOverride: query.allowProfileOverride === true,
        createdAt: query.createdAt,
        updatedAt: query.updatedAt,
        tags: query.tags ?? [],
      })),
    };
  }

  async function getQuery(input: SavedQueryNameInput): Promise<Record<string, unknown>> {
    const catalog = await loadSavedQueryCatalog(getSavedQueryCatalogPath(serverOptions));
    return {
      ok: true,
      query: getSavedQuery(catalog, input.name),
    };
  }

  async function runSavedQuery(input: RunSavedQueryInput): Promise<Record<string, unknown>> {
    const catalog = await loadSavedQueryCatalog(getSavedQueryCatalogPath(serverOptions));
    const saved = getSavedQuery(catalog, input.name);
    assertProfileOverrideAllowed(saved, input.profile);
    const profile = input.profile ?? saved.defaultProfile;
    const validation = await validate({
      sql: saved.sql,
      profile,
    });
    assertSavedQuerySafety(saved, {
      isDml: validation.isDml,
      statementType: validation.statementType,
    });

    if (saved.readOnly) {
      const result = await query({
        sql: saved.sql,
        profile,
        maxRecords: input.maxRecords,
        fetchParallel: input.fetchParallel,
        onLimit: input.onLimit,
        timeout: input.timeout,
      });
      return {
        ok: true,
        name: saved.name,
        result,
      };
    }

    const dmlMaxRows = requireDmlApproval(input, "ksql_run_saved_query", "for DML saved queries");

    const result = await mutate({
      sql: saved.sql,
      profile,
      allowDml: true,
      confirmText: "yes",
      dmlMaxRows,
      fetchParallel: input.fetchParallel,
      timeout: input.timeout,
    });
    return {
      ok: true,
      name: saved.name,
      result,
    };
  }

  async function deleteQuery(input: SavedQueryNameInput): Promise<Record<string, unknown>> {
    const filePath = getSavedQueryCatalogPath(serverOptions);
    const catalog = await loadSavedQueryCatalog(filePath);
    const deleted = deleteSavedQuery(catalog, input.name);
    await saveSavedQueryCatalog(filePath, deleted.catalog);
    return {
      ok: true,
      name: input.name,
      deleted: deleted.deleted,
    };
  }

  return {
    validate,
    explain,
    query,
    mutate,
    describeApp,
    showApps,
    saveQuery,
    listQueries,
    getQuery,
    runSavedQuery,
    deleteQuery,
    validateTool: (input: ValidateInput) => runSafely(() => validate(input)),
    explainTool: (input: ExplainInput) => runSafely(() => explain(input)),
    queryTool: (input: QueryInput) => runSafely(() => query(input)),
    mutateTool: (input: MutateInput) => runSafely(() => mutate(input)),
    describeAppTool: (input: DescribeAppInput) => runSafely(() => describeApp(input)),
    showAppsTool: (input: ShowAppsInput) => runSafely(() => showApps(input)),
    saveQueryTool: (input: SaveQueryInput) => runSafely(() => saveQuery(input)),
    listQueriesTool: (input: ListQueriesInput) => runSafely(() => listQueries(input)),
    getQueryTool: (input: SavedQueryNameInput) => runSafely(() => getQuery(input)),
    runSavedQueryTool: (input: RunSavedQueryInput) => runSafely(() => runSavedQuery(input)),
    deleteQueryTool: (input: SavedQueryNameInput) => runSafely(() => deleteQuery(input)),
  };
}
