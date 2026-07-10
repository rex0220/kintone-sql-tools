import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import {
  execute,
  executeBatch,
  buildBatchExplainPlans,
  parseSqlStatement,
  parseSqlStatements,
  analyzeBatch,
  type BatchExecuteResult,
  type ExecuteOptions,
  type AssertResult,
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
  /** INSERT_SELECT / UPSERT_SELECT の SELECT ソースが一時テーブルのみか */
  tempOnlySource: boolean;
  /** DML の書き込み対象アプリ ID（DML 以外は null。appIds は参照先も含む） */
  targetAppId: number | null;
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

/** 単文 ASSERT 成功時の専用 payload（バッチ強化第1弾 §2.3） */
function toAssertPayload(result: AssertResult) {
  return {
    ok: true,
    type: result.type,
    condition: result.condition,
  };
}

/** ミューテーション結果から影響件数フィールドを取り出す（文ごとエンベロープ用） */
function toMutationSummary(result: Exclude<ExecuteResult, SelectResult | AssertResult>): Record<string, unknown> {
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
    } else if (s.status === "success" && s.result && s.result.type !== "SELECT" && s.result.type !== "ASSERT") {
      // バッチ内 ASSERT の成功は result を持たない no-result 文のためここには来ない
      //（ExecuteResult 型上は含まれるため型の除外も兼ねる）
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

function toMutationPayload(result: Exclude<ExecuteResult, SelectResult | AssertResult>) {
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

/** SELECT-based DML(INSERT_SELECT / UPSERT_SELECT)を含むか */
function containsSelectBasedDml(statements: ReadonlyArray<{ statementType: string }>): boolean {
  return statements.some(
    (s) => s.statementType === "INSERT_SELECT" || s.statementType === "UPSERT_SELECT"
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
  statements: ReadonlyArray<{ statementType: string }>,
  dmlMaxRows: number
): number | undefined {
  return containsSelectBasedDml(statements) ? undefined : dmlMaxRows + 1;
}

// 読み取り上限エラー(api/fetchAll.ts の onLimit = error 時メッセージ)への文脈付与。
// SELECT-based DML では「dmlMaxRows を上げる」が正しい対処ではないことを案内する
const READ_LIMIT_MESSAGE_FRAGMENT = "取得件数が上限";
const SELECT_BASED_DML_READ_LIMIT_HINT =
  "SELECT-based DML のソース読み取り上限は dmlMaxRows ではなく maxRecords 解決値" +
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
      tempOnlySource: s.tempOnlySource,
      targetAppId: s.targetAppId,
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

    // バッチ入力: 全文のプランを配列で返す（フェーズ2 M3。実行はしない）
    const statements = parseSqlStatements(normalized.normalizedSql);
    if (statements.length > 1) {
      const plans = buildBatchExplainPlans(normalized.normalizedSql);
      return {
        ok: true,
        batch: true,
        statementCount: plans.statementCount,
        statements: plans.statements,
      };
    }

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
      if (result.type === "ASSERT") return toAssertPayload(result);
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
    if (result.type === "ASSERT") return toAssertPayload(result);
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
      // SELECT-based DML はソース制限なし（APP / temp / 混在とも可。v1.5.0〜v1.7.0 で段階解禁）。
      // 件数判定は書き込み前の confirm フックが担う。DML（UPDATE / DELETE / UPSERT）内の
      // 一時テーブル参照はエンジン層 executeBatch の validate-all-first が実行前に拒否する
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

    const selectBasedDml = containsSelectBasedDml(validation.statements);
    const runtime = await createRuntime(serverOptions, {
      sql: input.sql,
      profile: input.profile,
      // SELECT-based DML を含む場合は dmlMaxRows で読み取りを絞らない（案A。
      // resolveMutateRuntimeMaxRecords の doc コメント参照）
      maxRecords: resolveMutateRuntimeMaxRecords(validation.statements, dmlMaxRows),
      fetchParallel: input.fetchParallel,
      onLimit: DEFAULT_ON_LIMIT,
      timeout: input.timeout,
    });

    // バッチ合計の影響行数（INSERT(VALUES) は静的、confirm を呼ぶ文種
    // = UPDATE / DELETE / UPSERT / INSERT_SELECT / UPSERT_SELECT / REORDER は実行時加算）
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
    const payload = toBatchQueryPayload(batchResult);
    // SELECT-based DML 文の読み取り上限エラー（バッチでは文ごとの結果に埋め込まれる）
    // にヒントを付与する
    if (selectBasedDml) {
      for (const entry of payload.statements) {
        if (entry.type !== "INSERT_SELECT" && entry.type !== "UPSERT_SELECT") continue;
        const error = entry.error as { code?: string; message?: string } | undefined;
        if (typeof error?.message !== "string") continue;
        if (!error.message.includes(READ_LIMIT_MESSAGE_FRAGMENT)) continue;
        entry.error = { ...error, message: `${error.message} ${SELECT_BASED_DML_READ_LIMIT_HINT}` };
      }
    }
    return payload;
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
      profile: input.profile,
      // SELECT-based DML は dmlMaxRows で読み取りを絞らない（案A。
      // resolveMutateRuntimeMaxRecords の doc コメント参照）
      maxRecords: resolveMutateRuntimeMaxRecords(validation.statements, dmlMaxRows),
      fetchParallel: input.fetchParallel,
      onLimit: DEFAULT_ON_LIMIT,
      timeout: input.timeout,
    });
    let result: ExecuteResult;
    try {
      result = await executeSql(runtime.sql, runtime.client, {
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
    } catch (err) {
      throw selectBasedDml ? appendSelectBasedDmlReadLimitHint(err) : err;
    }
    // 単文 ASSERT は validate の isReadOnly ガードで ksql_query 誘導済みのため来ない
    if (result.type === "SELECT" || result.type === "ASSERT") {
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
