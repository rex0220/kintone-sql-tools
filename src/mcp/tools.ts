import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import {
  execute,
  executeBatch,
  buildBatchExplainPlans,
  parseSqlStatement,
  parseSqlStatements,
  explainNeedsAppMetadata,
  analyzeBatch,
  type BatchExecuteResult,
  type ExecuteOptions,
  type AssertResult,
  type DmlValidationResult,
  type ExecuteResult,
  type KintoneClient,
  type SelectResult,
} from "../core";
import { buildBatchEnvelope } from "../output/batchEnvelope";
import type { AppBinding } from "../node/appProfiles";
import { restoreSqlContextError, restoreSqlDiagnosticValue } from "../node/sqlDiagnostics";
import { isImportCapabilityGateError } from "../import/importGateError";
import { isNoFromSelectStatement } from "../node/dmlGuard";
import { envString, loadOptionalKsqlConfig, type OnLimitMode } from "../node/config";
import {
  createKsqlRuntime,
  resolveSqlContext,
  type CreateKsqlRuntimeInput,
  type KsqlRuntime,
  type KsqlRuntimeServerOptions,
  type ResolvedSqlContext,
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
  /** INSERT_SELECT / UPSERT_SELECT の SELECT ソースが一時テーブルのみか */
  tempOnlySource: boolean;
  /** DML の書き込み対象アプリ ID（DML 以外は null。appIds は参照先も含む） */
  targetAppId: number | null;
  isUpdateFrom: boolean;
  isValidationOnly: boolean;
  isOnErrorSkip: boolean;
  requiresCompleteInput: boolean;
}

interface ValidationCommon {
  ok: true;
  /** 2文以上のバッチ入力か */
  batch: boolean;
  statementCount: number;
  isReadOnlyBatch: boolean;
  containsDml: boolean;
  containsValidationOnly: boolean;
  requiresCompleteInput: boolean;
  tempTables: string[];
  canRunWithQueryTool: boolean;
  requiresMutationTool: boolean;
  statements: StatementValidation[];
  normalizedSql: string;
  hasProfileSyntax: boolean;
  cacheContext: string;
  appBindings: Array<{
    source: "logical" | "physical";
    logicalName?: string;
    mappedAppId: number;
    appId: number;
    profile: string;
  }>;
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
export const MCP_IMPORT_SOURCE_REQUIRED_MESSAGE =
  "IMPORT には importSources（inline CSV/JSON）を指定してください。";

type InlineImportInput = { importSources?: Array<{ name: string; text?: string; base64?: string; encoding?: "utf8" | "sjis" }> };

function importCapability(input: InlineImportInput): Pick<ExecuteOptions, "enableImport" | "importSource"> {
  const sources = input.importSources;
  if (!sources || sources.length === 0) return {};
  const byName = new Map<string, { bytes: Uint8Array; encoding?: "utf8" | "sjis" }>();
  for (const source of sources) {
    if (byName.has(source.name)) throw new Error(`ArgumentError: duplicate import source name: ${source.name}`);
    let bytes: Uint8Array;
    if (source.text !== undefined && source.base64 === undefined) {
      bytes = new TextEncoder().encode(source.text);
    } else if (source.base64 !== undefined && source.text === undefined) {
      const normalized = source.base64.replace(/\s/g, "");
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized)) {
        throw new Error(`ArgumentError: invalid base64 for import source: ${source.name}`);
      }
      bytes = new Uint8Array(Buffer.from(normalized, "base64"));
    } else {
      throw new Error(`ArgumentError: import source ${source.name} requires exactly one of text or base64.`);
    }
    byName.set(source.name, { bytes, encoding: source.encoding });
  }
  return {
    enableImport: true,
    importSource: (name) => {
      const source = byName.get(name);
      return source ? { load: async () => source } : undefined;
    },
  };
}

/** MCP で importSources 未指定の IMPORT gate だけを面別案内へ置き換える。 */
export function toMcpImportError(error: unknown, importEnabled: boolean): unknown {
  if (importEnabled || !isImportCapabilityGateError(error)) return error;
  if (error instanceof Error) {
    error.message = MCP_IMPORT_SOURCE_REQUIRED_MESSAGE;
    return error;
  }
  return MCP_IMPORT_SOURCE_REQUIRED_MESSAGE;
}

function noOpClient(): KintoneClient {
  const fail = async (): Promise<never> => {
    throw new Error("No-op client should not be called.");
  };
  return {
    getRecords: fail,
    openCursor: fail,
    postRecords: fail,
    putRecords: fail,
    deleteRecords: fail,
    getApps: fail,
    getFields: fail,
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() { return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const }; },
  };
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
  const sqlContext = resolveSqlContext(serverOptions, sql, inputProfile);
  return {
    profileName: sqlContext.profileName,
    normalizedSql: sqlContext.normalizedSql,
    hasProfileSyntax: sqlContext.hasProfileSyntax,
    appBindingByMappedApp: sqlContext.bindings,
    cacheContext: sqlContext.cacheContext,
    sqlContext,
    sourceSql: sql,
  };
}

function toValidationBinding(mappedAppId: number, binding: AppBinding) {
  return binding.source === "logical"
    ? {
        source: binding.source,
        logicalName: binding.logicalName,
        mappedAppId,
        appId: binding.appId,
        profile: binding.profile,
      }
    : {
        source: binding.source,
        mappedAppId,
        appId: binding.appId,
        profile: binding.profile,
      };
}

function toExplainBindings(bindings: ReadonlyMap<number, AppBinding>) {
  return [...bindings.values()].map((binding) => binding.source === "logical"
    ? { source: binding.source, logicalName: binding.logicalName, appId: binding.appId, profile: binding.profile }
    : { source: binding.source, appId: binding.appId, profile: binding.profile });
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
    ...(result.validateStats ? { validateStats: result.validateStats } : {}),
  };
}

/** 単文 ASSERT 成功時の専用 payload（バッチ強化第1弾 §2.3） */
function toAssertPayload(result: AssertResult) {
  return {
    ok: true,
    type: result.type,
    condition: result.condition,
  };
}

function toDmlValidationPayload(result: DmlValidationResult) {
  return {
    ok: true,
    type: result.type,
    operation: result.operation,
    validatedRows: result.validatedRows,
    validRows: result.validRows,
    invalidRows: result.invalidRows,
    errorCount: result.errorCount,
    columns: result.columns,
    errors: result.errors,
    ...(result.errTable ? { errTable: result.errTable } : {}),
    ...(result.importDetail ? { importDetail: result.importDetail } : {}),
  };
}

function toMutationPayload(result: Exclude<ExecuteResult, SelectResult | AssertResult | DmlValidationResult>) {
  if (result.type === "INSERT") {
    return {
      ok: true,
      type: result.type,
      insertedCount: result.insertedCount,
      createdIds: result.createdIds,
      ...(result.affectedRows !== undefined ? { affectedRows: result.affectedRows } : {}),
      ...(result.skippedRows !== undefined ? { skippedRows: result.skippedRows } : {}),
      ...(result.rejectLimit !== undefined ? { rejectLimit: result.rejectLimit } : {}),
      ...(result.errTable !== undefined ? { errTable: result.errTable } : {}),
    };
  }
  if (result.type === "UPDATE") {
    return {
      ok: true,
      type: result.type,
      updatedCount: result.updatedCount,
      ...(result.affectedRows !== undefined ? { affectedRows: result.affectedRows } : {}),
      ...(result.skippedRows !== undefined ? { skippedRows: result.skippedRows } : {}),
      ...(result.rejectLimit !== undefined ? { rejectLimit: result.rejectLimit } : {}),
      ...(result.errTable !== undefined ? { errTable: result.errTable } : {}),
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
      ...(result.affectedRows !== undefined ? { affectedRows: result.affectedRows } : {}),
      ...(result.skippedRows !== undefined ? { skippedRows: result.skippedRows } : {}),
      ...(result.rejectLimit !== undefined ? { rejectLimit: result.rejectLimit } : {}),
      ...(result.errTable !== undefined ? { errTable: result.errTable } : {}),
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

/** ソース読み取り件数が影響行数と一致しない DML を含むか。 */
function containsSelectBasedDml(statements: ReadonlyArray<{
  statementType: string;
  isUpdateFrom?: boolean;
  isOnErrorSkip?: boolean;
}>): boolean {
  return statements.some(
    (s) => s.statementType === "INSERT_SELECT" || s.statementType === "UPSERT_SELECT"
      || s.isUpdateFrom === true || s.isOnErrorSkip === true
  );
}

/**
 * ksql_mutate が createRuntime に渡す読み取り上限。
 * - SELECT-based DML を含む場合: undefined(runtime の通常解決
 *   KSQL_MAX_RECORDS → profile.query.maxRecords → 500 に委ねる)。
 *   ソース読み取り件数は影響行数と一致しない(JOIN の FULL_SCAN や UPSERT の
 *   照合読み取り等)ため dmlMaxRows で絞らない。影響行数ガードは confirm フックが担う
 * - それ以外(UPDATE / DELETE / INSERT / UPSERT / REORDER): 対象読み取り ≒ 影響行数
 *   のため dmlMaxRows + 1(超過検出用に 1 件多く読む)
 */
function resolveMutateRuntimeMaxRecords(
  statements: ReadonlyArray<{ statementType: string; isUpdateFrom?: boolean; isOnErrorSkip?: boolean }>,
  dmlMaxRows: number
): number | undefined {
  return containsSelectBasedDml(statements) ? undefined : dmlMaxRows + 1;
}

// 読み取り上限エラー(api/fetchAll.ts の onLimit = error 時メッセージ)への文脈付与。
// SELECT-based DML では「dmlMaxRows を上げる」が正しい対処ではないことを案内する
const READ_LIMIT_MESSAGE_FRAGMENT = "取得件数が上限";
const SELECT_BASED_DML_READ_LIMIT_HINT =
  "SELECT-based DML（UPDATE … FROM を含む）のソース読み取り上限は dmlMaxRows ではなく maxRecords 解決値" +
  "(KSQL_MAX_RECORDS / profile の query.maxRecords、既定 500)で制御されます。" +
  "dmlMaxRows は影響行数ガードです。";

function appendSelectBasedDmlReadLimitHint(err: unknown): unknown {
  if (err instanceof Error && err.message.includes(READ_LIMIT_MESSAGE_FRAGMENT)) {
    const hinted = new Error(`${err.message} ${SELECT_BASED_DML_READ_LIMIT_HINT}`);
    hinted.name = err.name;
    return hinted;
  }
  return err;
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
  const validationContexts = new WeakMap<ValidationResult, ResolvedSqlContext>();

  async function validate(input: ValidateInput): Promise<ValidationResult> {
    const normalized = normalizeSqlForTool(serverOptions, input.sql, input.profile);
    const importOptions = importCapability(input);
    // validate-all-first: 全文をパース・分類し、1文でも不正なら全体を拒否
    //（一時テーブルの静的解決・単文 CREATE/DROP の拒否・空入力の拒否を含む）
    let analysis: ReturnType<typeof analyzeBatch>;
    try {
      const statements = parseSqlStatements(normalized.normalizedSql, { import: importOptions.enableImport });
      analysis = analyzeBatch(statements);
    } catch (err) {
      const restored = restoreSqlContextError(err, normalized.sourceSql, normalized.sqlContext);
      throw toMcpImportError(restored, importOptions.enableImport === true);
    }
    const appBindings = [...normalized.appBindingByMappedApp.entries()]
      .map(([mappedAppId, binding]) => toValidationBinding(mappedAppId, binding));

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
      tempOnlySource: s.tempOnlySource,
      targetAppId: s.targetAppId,
      isUpdateFrom: s.isUpdateFrom,
      isValidationOnly: s.isValidationOnly,
      isOnErrorSkip: s.isOnErrorSkip,
      requiresCompleteInput: s.requiresCompleteInput,
    }));

    const common = {
      ok: true as const,
      statementCount: analysis.statementCount,
      isReadOnlyBatch: analysis.isReadOnlyBatch,
      containsDml: analysis.containsDml,
      containsValidationOnly: analysis.containsValidationOnly,
      requiresCompleteInput: analysis.requiresCompleteInput,
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
      const result: BatchValidationResult = { ...common, batch: true };
      validationContexts.set(result, normalized.sqlContext);
      return result;
    }

    // 単文: 従来のスカラー形を維持（後方互換）
    const s = statementValidations[0];
    const result: SingleValidationResult = {
      ...common,
      batch: false,
      statementType: s.statementType,
      isDml: s.isDml,
      isReadOnly: s.isReadOnly,
      hasWhere: s.hasWhere,
      insertValuesCount: s.insertValuesCount,
      appIds: s.appIds,
    };
    validationContexts.set(result, normalized.sqlContext);
    return result;
  }

  async function explain(input: ExplainInput): Promise<Record<string, unknown>> {
    const normalized = normalizeSqlForTool(serverOptions, input.sql, input.profile);
    const importOptions = importCapability(input);
    const appBindings = toExplainBindings(normalized.appBindingByMappedApp);

    // バッチ入力: 全文のプランを配列で返す（フェーズ2 M3。実行はしない）
    let statements: ReturnType<typeof parseSqlStatements>;
    try {
      statements = parseSqlStatements(normalized.normalizedSql, { import: importOptions.enableImport });
    } catch (err) {
      const restored = restoreSqlContextError(err, normalized.sourceSql, normalized.sqlContext);
      throw toMcpImportError(restored, importOptions.enableImport === true);
    }
    const needsAppMetadata = normalized.appBindingByMappedApp.size > 0
      && statements.some(explainNeedsAppMetadata);
    const runtime = needsAppMetadata
      ? await createRuntime(serverOptions, {
          sql: input.sql,
          sqlContext: normalized.sqlContext,
          profile: input.profile,
          maxRecords: input.maxRecords,
          cursorMaxActive: input.cursorMaxActive,
        })
      : null;
    const explainClient = runtime?.client ?? noOpClient();
    const explainCacheContext = runtime?.cacheContext ?? normalized.cacheContext;
    const explainSourceSql = runtime?.sql ?? normalized.normalizedSql;

    if (statements.length > 1) {
      const plans = await buildBatchExplainPlans(
        explainSourceSql,
        explainClient,
        undefined,
        explainCacheContext,
        runtime?.maxRecords ?? input.maxRecords,
        runtime?.cursorMaxActive ?? input.cursorMaxActive ?? 2,
        importOptions.enableImport
      );
      return {
        ok: true,
        batch: true,
        statementCount: plans.statementCount,
        statements: restoreSqlDiagnosticValue(plans.statements, normalized.appBindingByMappedApp),
        appBindings,
      };
    }

    const result = await executeSql(explainSql(explainSourceSql), explainClient, {
      cacheContext: explainCacheContext,
      maxRecords: runtime?.maxRecords ?? input.maxRecords,
      cursorMaxActive: runtime?.cursorMaxActive ?? input.cursorMaxActive ?? 2,
      ...importOptions,
    });
    if (result.type !== "SELECT") {
      throw new Error(`ArgumentError: EXPLAIN returned unexpected result type ${result.type}.`);
    }
    return restoreSqlDiagnosticValue(
      { ...toSelectPayload(result), appBindings },
      normalized.appBindingByMappedApp
    ) as Record<string, unknown>;
  }

  async function query(
    input: QueryInput,
    validated?: ValidationResult
  ): Promise<Record<string, unknown>> {
    const validation = validated ?? await validate(input);
    const importOptions = importCapability(input);
    if (!validation.batch && input.variables && Object.keys(input.variables).length > 0) {
      throw new Error("ArgumentError: variables require a batch containing DECLARE.");
    }

    // read-only バッチ（複文）の実行（フェーズ1 S6）
    if (validation.batch) {
      if (validation.containsDml) {
        throw new Error("ArgumentError: batch contains DML statements. Use ksql_mutate.");
      }
      const runtime = await createRuntime(serverOptions, {
        sql: input.sql,
        sqlContext: validationContexts.get(validation),
        profile: input.profile,
        maxRecords: input.maxRecords,
        fetchParallel: input.fetchParallel,
        onLimit: validation.containsValidationOnly || validation.statements.some((s) => s.statementType === "VALIDATE") ? "error" : input.onLimit,
        timeout: input.timeout,
        tempTableMaxRows: input.tempTableMaxRows,
        cursorMaxActive: input.cursorMaxActive,
      });
      const batchResult = await executeBatchSql(runtime.sql, runtime.client, {
        maxRecords: runtime.maxRecords,
        fetchParallel: runtime.fetchParallel,
        onLimitReached: runtime.onLimit,
        cacheContext: runtime.cacheContext,
        continueOnError: input.continueOnError,
        // 一時テーブル実体化上限（未指定 = エンジン既定 TEMP_TABLE_MAX_ROWS）。
        // 実体化は onLimit 設定によらず常に error（src/execute.ts の実体化経路で固定）
        tempTableMaxRows: runtime.tempTableMaxRows,
        // バッチでは timeout を合計タイムアウトとして扱う（仕様 §5.7）。
        // runtime.timeout は env / profile / 既定 30000ms を解決済みの値で、
        // HTTP クライアント側の per-request タイムアウトと同値になる
        timeoutMs: runtime.timeout,
        cursorMaxActive: runtime.cursorMaxActive ?? input.cursorMaxActive ?? 2,
        variables: input.variables,
        ...importOptions,
      });
      return { ...buildBatchEnvelope(batchResult, { maxTotalRecords: input.maxTotalRecords }) };
    }

    if (!validation.isReadOnly) {
      throw new Error(`ArgumentError: ${validation.statementType} is not allowed by ksql_query. Use ksql_mutate.`);
    }

    const stmt = parseSqlStatement(validation.normalizedSql, { import: importOptions.enableImport });
    const noAppApiNeeded = isNoFromSelectStatement(stmt);

    if (noAppApiNeeded) {
      const result = await executeSql(validation.normalizedSql, noOpClient(), {
        maxRecords: input.maxRecords ?? DEFAULT_MAX_RECORDS,
        onLimitReached: input.onLimit ?? DEFAULT_ON_LIMIT,
        cacheContext: validation.cacheContext,
        ...importOptions,
      });
      if (result.type === "ASSERT") return toAssertPayload(result);
      if (result.type === "VALIDATION") return toDmlValidationPayload(result);
      if (result.type !== "SELECT") {
        throw new Error(`ArgumentError: read-only query returned unexpected result type ${result.type}.`);
      }
      return toSelectPayload(result);
    }

    const runtime = await createRuntime(serverOptions, {
      sql: input.sql,
      sqlContext: validationContexts.get(validation),
      profile: input.profile,
      maxRecords: input.maxRecords,
      fetchParallel: input.fetchParallel,
      onLimit: validation.containsValidationOnly || validation.statements.some((s) => s.statementType === "VALIDATE") ? "error" : input.onLimit,
      timeout: input.timeout,
      cursorMaxActive: input.cursorMaxActive,
    });
    const result = await executeSql(runtime.sql, runtime.client, {
      maxRecords: runtime.maxRecords,
      fetchParallel: runtime.fetchParallel,
      onLimitReached: runtime.onLimit,
      cacheContext: runtime.cacheContext,
      cursorMaxActive: runtime.cursorMaxActive ?? input.cursorMaxActive ?? 2,
      ...importOptions,
    });
    if (result.type === "ASSERT") return toAssertPayload(result);
    if (result.type === "VALIDATION") return toDmlValidationPayload(result);
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
    const importOptions = importCapability(input);
    if (!validation.containsDml) {
      throw new Error("ArgumentError: batch contains no DML statements. Use ksql_query.");
    }

    // 静的ガード（1文でも違反すればバッチ全体を実行前に拒否）
    let staticInsertTotal = 0;
    for (const s of validation.statements) {
      if (!s.isDml) continue;
      const at = ` (statement ${s.index})`;
      // SELECT-based DML はソース制限なし（APP / temp / 混在とも可。v1.5.0〜v1.7.0 で段階解禁）。
      // 件数判定は書き込み前の confirm フックが担う。DML（UPDATE / DELETE / UPSERT）内の
      // 一時テーブル参照はエンジン層 executeBatch の validate-all-first が実行前に拒否する
      if ((s.statementType === "UPDATE" || s.statementType === "DELETE") && !s.hasWhere) {
        throw new Error(`ArgumentError: ${s.statementType} without WHERE is blocked by ksql_mutate.${at}`);
      }
      if (!s.isOnErrorSkip && s.insertValuesCount !== null && s.insertValuesCount > dmlMaxRows) {
        throw new Error(
          `ArgumentError: INSERT rows (${s.insertValuesCount}) exceed dmlMaxRows (${dmlMaxRows}).${at}`
        );
      }
      if (!s.isOnErrorSkip) staticInsertTotal += s.insertValuesCount ?? 0;
    }
    const dmlTotalMaxRows = input.dmlTotalMaxRows;
    if (dmlTotalMaxRows !== undefined && staticInsertTotal > dmlTotalMaxRows) {
      throw new Error(
        `ArgumentError: batch INSERT rows (${staticInsertTotal}) exceed dmlTotalMaxRows (${dmlTotalMaxRows}).`
      );
    }

    const selectBasedDml = containsSelectBasedDml(validation.statements);
    const runtime = await createRuntime(serverOptions, {
      sql: input.sql,
      sqlContext: validationContexts.get(validation),
      profile: input.profile,
      // SELECT-based DML を含む場合は dmlMaxRows で読み取りを絞らない（案A。
      // resolveMutateRuntimeMaxRecords の doc コメント参照）
      maxRecords: resolveMutateRuntimeMaxRecords(validation.statements, dmlMaxRows),
      fetchParallel: input.fetchParallel,
      onLimit: DEFAULT_ON_LIMIT,
      timeout: input.timeout,
      tempTableMaxRows: input.tempTableMaxRows,
      cursorMaxActive: input.cursorMaxActive,
    });

    // バッチ合計の影響行数（INSERT(VALUES) は静的、confirm を呼ぶ文種
    // = UPDATE / DELETE / UPSERT / INSERT_SELECT / UPSERT_SELECT / REORDER は実行時加算）
    let totalAffected = staticInsertTotal;
    const batchResult = await executeBatchSql(runtime.sql, runtime.client, {
      maxRecords: runtime.maxRecords,
      fetchParallel: runtime.fetchParallel,
      onLimitReached: runtime.onLimit,
      cacheContext: runtime.cacheContext,
      // 一時テーブル実体化上限（未指定 = エンジン既定 TEMP_TABLE_MAX_ROWS）
      tempTableMaxRows: runtime.tempTableMaxRows,
      // 合計タイムアウト（解決済みの runtime.timeout。per-request と同値）
      timeoutMs: runtime.timeout,
      cursorMaxActive: runtime.cursorMaxActive ?? input.cursorMaxActive ?? 2,
      variables: input.variables,
      ...importOptions,
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
    const payload = buildBatchEnvelope(batchResult);
    // SELECT-based DML 文の読み取り上限エラー（バッチでは文ごとの結果に埋め込まれる）
    // にヒントを付与する
    if (selectBasedDml) {
      for (const entry of payload.statements) {
        const statement = validation.statements.find((s) => s.index === entry.index);
        if (entry.type !== "INSERT_SELECT" && entry.type !== "UPSERT_SELECT" && statement?.isUpdateFrom !== true) continue;
        const error = entry.error as { code?: string; message?: string } | undefined;
        if (typeof error?.message !== "string") continue;
        if (!error.message.includes(READ_LIMIT_MESSAGE_FRAGMENT)) continue;
        entry.error = { ...error, message: `${error.message} ${SELECT_BASED_DML_READ_LIMIT_HINT}` };
      }
    }
    return { ...payload };
  }

  async function mutate(
    input: MutateInput,
    validated?: ValidationResult
  ): Promise<Record<string, unknown>> {
    const dmlMaxRows = requireDmlApproval(input, "ksql_mutate");
    const importOptions = importCapability(input);

    const validation = validated ?? await validate(input);
    if (!validation.batch && input.variables && Object.keys(input.variables).length > 0) {
      throw new Error("ArgumentError: variables require a batch containing DECLARE.");
    }
    if (validation.batch) {
      return mutateBatch(input, validation, dmlMaxRows);
    }
    if (!validation.isDml) {
      throw new Error(`ArgumentError: ${validation.statementType} is not allowed by ksql_mutate. Use ksql_query.`);
    }
    // SELECT-based DML は解禁済み(INSERT_SELECT: v1.5.0 / UPSERT_SELECT: v1.6.0)。
    // 書き込み前の件数判定は実行エンジンの confirm フックが担う
    // (INSERT_SELECT: source 行数、UPSERT_SELECT: 照合後の insert + update 合計)
    if ((validation.statementType === "UPDATE" || validation.statementType === "DELETE") && !validation.hasWhere) {
      throw new Error(`ArgumentError: ${validation.statementType} without WHERE is blocked by ksql_mutate.`);
    }
    if (validation.insertValuesCount !== null && validation.insertValuesCount > dmlMaxRows) {
      throw new Error(`ArgumentError: INSERT rows (${validation.insertValuesCount}) exceed dmlMaxRows (${dmlMaxRows}).`);
    }

    const selectBasedDml = containsSelectBasedDml(validation.statements);
    const runtime = await createRuntime(serverOptions, {
      sql: input.sql,
      sqlContext: validationContexts.get(validation),
      profile: input.profile,
      // SELECT-based DML は dmlMaxRows で読み取りを絞らない（案A。
      // resolveMutateRuntimeMaxRecords の doc コメント参照）
      maxRecords: resolveMutateRuntimeMaxRecords(validation.statements, dmlMaxRows),
      fetchParallel: input.fetchParallel,
      onLimit: DEFAULT_ON_LIMIT,
      timeout: input.timeout,
      cursorMaxActive: input.cursorMaxActive,
    });
    let result: ExecuteResult;
    try {
      result = await executeSql(runtime.sql, runtime.client, {
        maxRecords: runtime.maxRecords,
        fetchParallel: runtime.fetchParallel,
        onLimitReached: runtime.onLimit,
        cacheContext: runtime.cacheContext,
        cursorMaxActive: runtime.cursorMaxActive ?? input.cursorMaxActive ?? 2,
        confirm: async (count, operation) => {
          if (count > dmlMaxRows) {
            throw new Error(`ArgumentError: ${operation} affected rows (${count}) exceed dmlMaxRows (${dmlMaxRows}).`);
          }
          return true;
        },
        ...importOptions,
      });
    } catch (err) {
      throw selectBasedDml ? appendSelectBasedDmlReadLimitHint(err) : err;
    }
    // 単文 ASSERT は validate の isReadOnly ガードで ksql_query 誘導済みのため来ない
    if (result.type === "SELECT" || result.type === "ASSERT" || result.type === "VALIDATION") {
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
      }, validation);
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
    }, validation);
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
