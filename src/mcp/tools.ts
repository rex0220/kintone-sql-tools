import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import {
  execute,
  executeBatch,
  parseSqlStatement,
  parseSqlStatements,
  analyzeBatch,
  type BatchExecuteResult,
  type ExecuteOptions,
  type ExecuteResult,
  type KintoneClient,
  type SelectResult,
} from "../core";
import {
  buildCacheContext,
  normalizeSqlAppProfiles,
} from "../node/appProfiles";
import { isNoFromSelectStatement } from "../node/dmlGuard";
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
  executeBatchSql?: typeof executeBatch;
}

/** 文ごとの検証結果（仕様 §7.1 の statements[]） */
export interface StatementValidation {
  index: number;
  statementType: string;
  isDml: boolean;
  isReadOnly: boolean;
  hasWhere: boolean;
  insertValuesCount: number | null;
  appIds: number[];
  tempTablesCreated: string[];
  tempTablesReferenced: string[];
  tempTablesDropped: string[];
}

interface ValidationCommon {
  ok: true;
  /** 2文以上のバッチ入力か */
  batch: boolean;
  statementCount: number;
  isReadOnlyBatch: boolean;
  containsDml: boolean;
  tempTables: string[];
  canRunWithQueryTool: boolean;
  requiresMutationTool: boolean;
  statements: StatementValidation[];
  normalizedSql: string;
  hasProfileSyntax: boolean;
  cacheContext: string;
  appBindings: Array<{ mappedAppId: number; appId: number; profile: string }>;
}

/** 単文入力の検証結果。トップレベルのスカラーフィールドは従来互換 */
export interface SingleValidationResult extends ValidationCommon {
  batch: false;
  statementType: string;
  isDml: boolean;
  isReadOnly: boolean;
  hasWhere: boolean;
  insertValuesCount: number | null;
  appIds: number[];
}

/** バッチ入力の検証結果。文ごとの情報は statements[] で表す */
export interface BatchValidationResult extends ValidationCommon {
  batch: true;
  statementType?: undefined;
  isDml?: undefined;
  isReadOnly?: undefined;
  hasWhere?: undefined;
  insertValuesCount?: undefined;
  appIds?: undefined;
}

export type ValidationResult = SingleValidationResult | BatchValidationResult;

/** バッチ未対応のツールで単文入力を要求する（対応時にこのガードを外す） */
function requireSingleStatement(
  validation: ValidationResult,
  toolName: string
): SingleValidationResult {
  if (validation.batch) {
    throw new Error(
      `ArgumentError: batch SQL (multiple statements) is not supported by ${toolName} yet.`
    );
  }
  return validation;
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

/** ミューテーション結果から影響件数フィールドを取り出す（文ごとエンベロープ用） */
function toMutationSummary(result: Exclude<ExecuteResult, SelectResult>): Record<string, unknown> {
  if (result.type === "INSERT") {
    return { insertedCount: result.insertedCount, createdIds: result.createdIds };
  }
  if (result.type === "UPDATE") return { updatedCount: result.updatedCount };
  if (result.type === "DELETE") return { deletedCount: result.deletedCount };
  if (result.type === "UPSERT") {
    return { insertedCount: result.insertedCount, updatedCount: result.updatedCount };
  }
  return { reorderedParentCount: result.reorderedParentCount };
}

/**
 * バッチ実行結果を仕様 §6.2 のエンベロープに整形する。
 * - results には結果セットを返した read-only 文の結果のみ入れる
 *   （CREATE TEMP TABLE の実体化結果は tempTable / rowCount のみ）
 * - DML 文の影響件数は statements[] のエントリに展開する（途中失敗時に
 *   「どこまで反映されたか」を文ごとに読み取れるようにする）
 * - maxTotalRecords 指定時は返却合計行数を超えた時点でエラー
 */
function toBatchQueryPayload(batch: BatchExecuteResult, maxTotalRecords?: number) {
  const results: Array<{
    columns: string[];
    rows: SelectResult["rows"];
    rowCount: number;
    warnings: string[];
  }> = [];
  let totalRows = 0;

  const statements = batch.statements.map((s) => {
    const entry: Record<string, unknown> = {
      index: s.index,
      type: s.type,
      status: s.status,
    };
    if (s.status === "error" && s.error) entry.error = s.error;
    if (s.status === "skipped" && s.skippedReason) entry.skippedReason = s.skippedReason;
    if (s.tempTable !== undefined) entry.tempTable = s.tempTable;
    if (s.rowCount !== undefined) entry.rowCount = s.rowCount;

    if (s.status === "success" && s.result?.type === "SELECT") {
      totalRows += s.result.rowCount;
      if (maxTotalRecords !== undefined && totalRows > maxTotalRecords) {
        throw new Error(
          `ArgumentError: batch total rows (${totalRows}) exceed maxTotalRecords (${maxTotalRecords}).`
        );
      }
      entry.resultIndex = results.length;
      results.push({
        columns: s.result.columns,
        rows: s.result.rows,
        rowCount: s.result.rowCount,
        warnings: s.result.warnings ?? [],
      });
    } else if (s.status === "success" && s.result && s.result.type !== "SELECT") {
      Object.assign(entry, toMutationSummary(s.result));
    }
    return entry;
  });

  return {
    ok: batch.ok,
    batch: true,
    statementCount: batch.statementCount,
    statements,
    results,
    // バッチ全体の警告（仕様 §6.2）。文ごとの警告は results[].warnings に入る
    warnings: [] as string[],
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
  const executeBatchSql = deps.executeBatchSql ?? executeBatch;

  async function validate(input: ValidateInput): Promise<ValidationResult> {
    const normalized = normalizeSqlForTool(serverOptions, input.sql, input.profile);
    // validate-all-first: 全文をパース・分類し、1文でも不正なら全体を拒否
    //（一時テーブルの静的解決・単文 CREATE/DROP の拒否・空入力の拒否を含む）
    const statements = parseSqlStatements(normalized.normalizedSql);
    const analysis = analyzeBatch(statements);
    const appBindings = [...normalized.appBindingByMappedApp.entries()].map(([mappedAppId, binding]) => ({
      mappedAppId,
      appId: binding.appId,
      profile: binding.profile,
    }));

    const statementValidations: StatementValidation[] = analysis.statements.map((s) => ({
      index: s.index,
      statementType: s.statementType,
      isDml: s.isDml,
      isReadOnly: s.isReadOnly,
      hasWhere: s.hasWhere,
      insertValuesCount: s.insertValuesCount,
      appIds: s.appIds,
      tempTablesCreated: s.tempTablesCreated,
      tempTablesReferenced: s.tempTablesReferenced,
      tempTablesDropped: s.tempTablesDropped,
    }));

    const common = {
      ok: true as const,
      statementCount: analysis.statementCount,
      isReadOnlyBatch: analysis.isReadOnlyBatch,
      containsDml: analysis.containsDml,
      tempTables: analysis.tempTables,
      canRunWithQueryTool: analysis.isReadOnlyBatch,
      requiresMutationTool: analysis.containsDml,
      statements: statementValidations,
      normalizedSql: normalized.normalizedSql,
      hasProfileSyntax: normalized.hasProfileSyntax,
      cacheContext: normalized.cacheContext,
      appBindings,
    };

    if (analysis.statementCount > 1) {
      return { ...common, batch: true };
    }

    // 単文: 従来のスカラー形を維持（後方互換）
    const s = statementValidations[0];
    return {
      ...common,
      batch: false,
      statementType: s.statementType,
      isDml: s.isDml,
      isReadOnly: s.isReadOnly,
      hasWhere: s.hasWhere,
      insertValuesCount: s.insertValuesCount,
      appIds: s.appIds,
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

    // read-only バッチ（複文）の実行（フェーズ1 S6）
    if (validation.batch) {
      if (validation.containsDml) {
        throw new Error("ArgumentError: batch contains DML statements. Use ksql_mutate.");
      }
      const runtime = await createRuntime(serverOptions, {
        sql: input.sql,
        profile: input.profile,
        maxRecords: input.maxRecords,
        fetchParallel: input.fetchParallel,
        onLimit: input.onLimit,
        timeout: input.timeout,
      });
      const batchResult = await executeBatchSql(runtime.sql, runtime.client, {
        maxRecords: runtime.maxRecords,
        fetchParallel: runtime.fetchParallel,
        onLimitReached: runtime.onLimit,
        cacheContext: runtime.cacheContext,
        continueOnError: input.continueOnError,
        // バッチでは timeout を合計タイムアウトとして扱う（仕様 §5.7）。
        // runtime.timeout は env / profile / 既定 30000ms を解決済みの値で、
        // HTTP クライアント側の per-request タイムアウトと同値になる
        timeoutMs: runtime.timeout,
      });
      return toBatchQueryPayload(batchResult, input.maxTotalRecords);
    }

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

  /**
   * DML バッチ（フェーズ2 M1）。
   * - 静的ガードを文ごとに適用してから実行（validate-all-first）
   * - 常に fail-fast（continueOnError は存在しない）
   * - dmlMaxRows は文ごと、dmlTotalMaxRows（任意）はバッチ合計の影響行数に適用
   */
  async function mutateBatch(
    input: MutateInput,
    validation: BatchValidationResult,
    dmlMaxRows: number
  ): Promise<Record<string, unknown>> {
    if (!validation.containsDml) {
      throw new Error("ArgumentError: batch contains no DML statements. Use ksql_query.");
    }

    // 静的ガード（1文でも違反すればバッチ全体を実行前に拒否）
    let staticInsertTotal = 0;
    for (const s of validation.statements) {
      if (!s.isDml) continue;
      const at = ` (statement ${s.index})`;
      if (s.statementType === "INSERT_SELECT" || s.statementType === "UPSERT_SELECT") {
        throw new Error(`ArgumentError: ${s.statementType} is not supported by ksql_mutate yet.${at}`);
      }
      if ((s.statementType === "UPDATE" || s.statementType === "DELETE") && !s.hasWhere) {
        throw new Error(`ArgumentError: ${s.statementType} without WHERE is blocked by ksql_mutate.${at}`);
      }
      if (s.insertValuesCount !== null && s.insertValuesCount > dmlMaxRows) {
        throw new Error(
          `ArgumentError: INSERT rows (${s.insertValuesCount}) exceed dmlMaxRows (${dmlMaxRows}).${at}`
        );
      }
      staticInsertTotal += s.insertValuesCount ?? 0;
    }
    const dmlTotalMaxRows = input.dmlTotalMaxRows;
    if (dmlTotalMaxRows !== undefined && staticInsertTotal > dmlTotalMaxRows) {
      throw new Error(
        `ArgumentError: batch INSERT rows (${staticInsertTotal}) exceed dmlTotalMaxRows (${dmlTotalMaxRows}).`
      );
    }

    const runtime = await createRuntime(serverOptions, {
      sql: input.sql,
      profile: input.profile,
      maxRecords: dmlMaxRows + 1,
      fetchParallel: input.fetchParallel,
      onLimit: DEFAULT_ON_LIMIT,
      timeout: input.timeout,
    });

    // バッチ合計の影響行数（INSERT は静的、UPDATE / DELETE は confirm で加算）
    let totalAffected = staticInsertTotal;
    const batchResult = await executeBatchSql(runtime.sql, runtime.client, {
      maxRecords: runtime.maxRecords,
      fetchParallel: runtime.fetchParallel,
      onLimitReached: runtime.onLimit,
      cacheContext: runtime.cacheContext,
      // 合計タイムアウト（解決済みの runtime.timeout。per-request と同値）
      timeoutMs: runtime.timeout,
      confirm: async (count, operation) => {
        if (count > dmlMaxRows) {
          throw new Error(`ArgumentError: ${operation} affected rows (${count}) exceed dmlMaxRows (${dmlMaxRows}).`);
        }
        totalAffected += count;
        if (dmlTotalMaxRows !== undefined && totalAffected > dmlTotalMaxRows) {
          throw new Error(
            `ArgumentError: batch affected rows (${totalAffected}) exceed dmlTotalMaxRows (${dmlTotalMaxRows}).`
          );
        }
        return true;
      },
    });
    return toBatchQueryPayload(batchResult);
  }

  async function mutate(input: MutateInput): Promise<Record<string, unknown>> {
    const dmlMaxRows = requireDmlApproval(input, "ksql_mutate");

    const validation = await validate(input);
    if (validation.batch) {
      return mutateBatch(input, validation, dmlMaxRows);
    }
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
    const validation = requireSingleStatement(
      await validate({
        sql: input.sql,
        profile: input.defaultProfile,
      }),
      "ksql_save_query"
    );
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
    const validation = requireSingleStatement(
      await validate({
        sql: saved.sql,
        profile,
      }),
      "ksql_run_saved_query"
    );
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
