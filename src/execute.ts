// ============================================================
// execute — SQL 文字列を受け取り kintone API を呼び出して結果を返す
//
// 依存関係はすべて注入（KintoneClient）するため、
// kintone 環境外でのテストが可能。
//
// 処理フロー:
//   SELECT（SIMPLE）  → GET → project
//   SELECT（FULL_SCAN）→ 全テーブル fetchAll → runFullScan
//   INSERT            → POST（100件バッチ）
//   UPDATE            → fetchAll（$id 取得）→ 確認 → PUT バッチ
//   DELETE            → fetchAll（$id 取得）→ 確認 → DELETE バッチ
// ============================================================

import { Lexer, LexError } from "./lexer/lexer";
import { Parser, ParseError } from "./parser/parser";
import type { Statement, SelectStatement, SelectColumn, InsertStatement, InsertSelectStatement, UpdateStatement, DeleteStatement, Assignment, ArithExpr, ArithNode, AggOperand, UnionStatement, WithStatement, WhereExpr, FieldValue, FieldRef, ShowAppsStatement, DescribeStatement, UpsertStatement, UpsertSelectStatement, TableRef, ReorderStatement, OrderByKey, OrderByItem, ExplainStatement, CaseWhenExpr, CaseResult, StringFuncExpr, StringFuncArg, AssertStatement, AssertOperand, ScalarSubquery, ScalarExpr } from "./types/ast";
import { NO_FROM_CTE_NAME } from "./types/ast";
import { analyzeBatch, BatchAnalysisError, type BatchAnalysis } from "./core/batch";
import { requiresCompleteInput } from "./core/dmlGuard";
import {
  fieldSemanticsEqual,
  resolveFieldSemantics,
  syntheticSemantics,
  withFieldSemanticSource,
  type ResolvedFieldSemantics,
} from "./core/fieldSemantics";
import type { ProcessStatusState } from "./core/processStatus";
import { validateDeclaredBatchVariables } from "./core/batchVariables";
import { compareCanonicalValues, compareScalarValues } from "./core/scalarCompare";
import { validateKlikePushdownPlan, validateKlikeStatement } from "./core/klikeValidation";
import { buildInlinedQuery, canInlineSingleCte } from "./core/cteInlining";
import { whereNeedsFieldMetadata } from "./core/explainMetadata";
import { resolveSelectMode, selectToKintoneParams, selectToFetchAllParams, selectToFetchAllFields, whereRequiresJsEval, SelectMode } from "./converter/selectToKintone";
import { whereToKintone } from "./converter/whereToKintone";
import {
  insertToPostBatches,
  updateToGetQuery,
  updateToPutBatches,
  hasArithAssignment,
  updateToGetQueryForArith,
  updateToPutBatchesArith,
  updateFromToPutBatches,
  deleteToGetQuery,
  deleteToDeleteBatches,
  toKintoneValue,
  evalCaseWhenValue,
  KintonePostParams,
  KintonePutParams,
  KintoneDeleteParams,
  FieldTypeMap,
  DmlConvertError,
} from "./converter/dmlToKintone";
import { fetchAll, FetchAllLimitError, PageFetcher } from "./api/fetchAll";
import {
  fetchRecordsForSharedPlan,
  resolveDmlTargetIds,
} from "./core/optimization/sharedPlanner";
import {
  extractTypedPushdownCandidates,
} from "./core/optimization/wherePredicatePushdown";
import { buildKlikePushdownPlan } from "./core/optimization/klikePushdownPlan";
import {
  planCanonicalOrder,
  type CanonicalOrderPlan,
} from "./core/optimization/canonicalOrderPlanner";
import { planKorderNative } from "./core/optimization/korderPlanner";
import { whereHasKlike, whereHasLike } from "./core/like";
import {
  runFullScan,
  project,
  flatten,
  ProcessRow,
  applyOrderBy,
  applyLimit,
  applyWindow,
  OptionOrderMap,
  FieldSortKindMap,
  type AggregateSortKindResolver,
} from "./engine/process";
import { expandSubtableRecords } from "./converter/subtableAdapter";
import type { ResolvedSubqueryInList, ResolvedExistsExpr, ResolvedScalarSubquery, FieldTypeResolver, FieldSemanticsResolver } from "./engine/evalWhere";
import { evalWhere, evalCaseWhen, resolveKintoneFunc } from "./engine/evalWhere";
import { evalArithExpr, evalStringFunc } from "./engine/evalFunc";
import type { KintoneRecord } from "./converter/dmlToKintone";
import type { KintoneGetResponse } from "./api/fetchAll";
import {
  renderValidationValue,
  validateDmlCandidates,
  VALIDATION_META_COLUMNS,
  type DmlValidationCandidate,
  type ValidationOperation,
} from "./core/dmlValidationCandidates";
import {
  classifyWhereCapability,
  type PredicateCapabilityResult,
  type WhereFieldSemanticsResolver,
} from "./core/optimization/whereCapability";

// ============================================================
// kintone API クライアントインターフェース
// ============================================================

export interface KintoneClient {
  /** GET /k/v1/records.json（1ページ分） */
  getRecords: PageFetcher;
  /** POST /k/v1/records.json（INSERT） */
  postRecords: (params: KintonePostParams) => Promise<{ ids: string[] }>;
  /** PUT /k/v1/records.json（UPDATE） */
  putRecords: (params: KintonePutParams) => Promise<void>;
  /** DELETE /k/v1/records.json（DELETE） */
  deleteRecords: (params: KintoneDeleteParams) => Promise<void>;
  /** GET /k/v1/apps.json（SHOW APPS） */
  getApps: () => Promise<KintoneAppInfo[]>;
  /** GET /k/v1/app/form/fields.json（DESCRIBE） */
  getFields: (appId: number) => Promise<KintoneFieldInfo[]>;
  /** GET /k/v1/app/status.json（プロセス管理設定） */
  getProcessStatuses: (appId: number) => Promise<KintoneProcessStatuses>;
}

export interface KintoneProcessStatuses {
  enable: boolean;
  /** 実行ユーザーの表示言語に対応する状態名と数値化済み定義順。未設定は null。 */
  states: ProcessStatusState[] | null;
}

const SEARCH_ABORTED_WARNING =
  "検索が 10 万件で打ち切られ、結果が欠落した可能性があります。";

interface SearchAbortCollector {
  aborted: boolean;
}

export class SearchAbortedError extends Error {
  constructor() {
    super("SearchAbortedError: kintone の検索が 10 万件で打ち切られたため、完全な対象集合を確定できません。");
    this.name = "SearchAbortedError";
  }
}

export interface KintoneAppInfo {
  appId: number;
  name: string;
  description: string;
}

export interface KintoneFieldInfo {
  code: string;
  label: string;
  fieldType: string;
  /** 選択肢ラベル -> 並び順 index */
  optionOrder?: Record<string, number>;
  /** ソート種別（CALC設定などに基づく） */
  sortKind?: "number" | "string";
  /** 比較・planner・実体化が共有する解決済み意味型。 */
  semantics?: ResolvedFieldSemantics;
  required?: boolean;
  minValue?: string;
  maxValue?: string;
  minLength?: string;
  maxLength?: string;
  defaultValue?: unknown;
  /** true の場合、サブテーブルの子フィールドとして create 検証の必須/既定値走査から除外する。 */
  inSubtable?: boolean;
  /** false は計算・システム・ルックアップコピー先等の書込不可フィールド。 */
  writable?: boolean;
}

// ============================================================
// 実行結果型
// ============================================================

export type ExecuteResult =
  | SelectResult
  | InsertResult
  | UpdateResult
  | DeleteResult
  | UpsertResult
  | ReorderResult
  | AssertResult
  | DmlValidationResult;

/** 1 回の execute() で発生した kintone API 呼び出しの計測値 */
export interface ExecuteMetrics {
  /** GET /k/v1/records.json の呼び出し回数 */
  getCalls: number;
  /** POST /k/v1/records.json の呼び出し回数 */
  postCalls: number;
  /** PUT /k/v1/records.json の呼び出し回数 */
  putCalls: number;
  /** DELETE /k/v1/records.json の呼び出し回数 */
  deleteCalls: number;
  /** GET /k/v1/app/form/fields.json の呼び出し回数（キャッシュヒット時は増えない） */
  fieldCalls: number;
  /** GET /k/v1/apps.json の呼び出し回数 */
  appsCalls: number;
  /** GET /k/v1/app/status.json の呼び出し回数（キャッシュヒット時は増えない） */
  processStatusCalls: number;
  /** GET で取得したレコード総数（全ページ・サブクエリ含む） */
  fetchedRows: number;
  /** execute() 全体の所要時間（ミリ秒） */
  elapsedMs: number;
}

export interface SelectResult {
  type: "SELECT";
  rows: ProcessRow[];
  /** SELECT 列定義順のカラム名リスト（表示順保証用） */
  columns: string[];
  /** 実際に返した行数（LIMIT 適用後） */
  rowCount: number;
  /** 実行時警告（例: 上限到達で打ち切り） */
  warnings?: string[];
  /** API 呼び出し計測値（execute() 経由の実行時のみ付与） */
  metrics?: ExecuteMetrics;
}

/** CTE / 一時テーブルの実体化結果。空結果でも出力列を保持する。 */
export interface MaterializedColumnMeta {
  readonly sortKind?: "number" | "string";
  readonly fieldType?: string;
  readonly semantics?: ResolvedFieldSemantics;
}

type MaterializedColumnMetaMap = ReadonlyMap<string, MaterializedColumnMeta>;

interface MaterializedTable {
  readonly rows: ProcessRow[];
  readonly columns: string[];
  readonly columnMeta?: MaterializedColumnMetaMap;
}

/** 公開 SelectResult を拡張せず、実体化時だけ列メタを結果オブジェクトへ関連付ける。 */
const materializedMetaBySelectResult = new WeakMap<SelectResult, MaterializedColumnMetaMap>();
const materializedMetaByValidationResult = new WeakMap<DmlValidationResult, MaterializedColumnMetaMap>();

export interface InsertResult {
  type: "INSERT";
  /** 作成されたレコード ID（バッチごと） */
  createdIds: string[][];
  insertedCount: number;
  affectedRows?: number;
  skippedRows?: number;
  rejectLimit?: number | null;
  errTable?: string;
  metrics?: ExecuteMetrics;
}

export interface UpdateResult {
  type: "UPDATE";
  updatedCount: number;
  affectedRows?: number;
  skippedRows?: number;
  rejectLimit?: number | null;
  errTable?: string;
  metrics?: ExecuteMetrics;
}

export interface DeleteResult {
  type: "DELETE";
  deletedCount: number;
  metrics?: ExecuteMetrics;
}

export interface UpsertResult {
  type: "UPSERT";
  insertedCount: number;
  updatedCount: number;
  affectedRows?: number;
  skippedRows?: number;
  rejectLimit?: number | null;
  errTable?: string;
  metrics?: ExecuteMetrics;
}

export interface ReorderResult {
  type: "REORDER";
  reorderedParentCount: number;
  metrics?: ExecuteMetrics;
}

export interface AssertResult {
  type: "ASSERT";
  /** 評価した条件（パーサが再構成した正規化テキスト） */
  condition: string;
  metrics?: ExecuteMetrics;
}

export interface DmlValidationResult {
  type: "VALIDATION";
  operation: "INSERT" | "UPDATE" | "UPSERT";
  validatedRows: number;
  validRows: number;
  invalidRows: number;
  errorCount: number;
  columns: string[];
  errors: ProcessRow[];
  errTable?: string;
  metrics?: ExecuteMetrics;
}

// ============================================================
// オプション
// ============================================================

/**
 * confirm コールバックに渡される文コンテキスト（バッチ実行時のみ）。
 * executeBatch が文ごとに confirm をラップして注入する。単文実行では undefined。
 * confirm の呼び出し有無は文タイプに依存する（INSERT VALUES は confirm 非経由・
 * UPSERT 系は対象 0 件で呼ばれない）ため、呼び出し回数から文番号を推測せず
 * このコンテキストを使うこと。
 */
export interface DmlConfirmContext {
  /** バッチ内の文 index（0 始まり） */
  statementIndex: number;
  /** バッチの総文数 */
  statementCount: number;
  /** DML 文タイプ（"UPDATE" / "UPSERT_SELECT" 等。operation より細粒度） */
  statementType: string;
  /** 書き込み先アプリ ID（StatementAnalysis.targetAppId の転記。DML では実質非 null） */
  targetAppId: number | null;
}

export interface ExecuteOptions {
  /**
   * UPDATE / DELETE（および INSERT_SELECT の書き込み）実行前に呼ばれる確認コールバック。
   * false を返すとキャンセルして OperationCancelledError を投げる。
   * 省略時は確認なしで実行。context はバッチ実行時のみ渡される（後方互換の optional）。
   */
  confirm?: (
    count: number,
    operation: "UPDATE" | "DELETE" | "INSERT",
    context?: DmlConfirmContext
  ) => Promise<boolean>;
  /** 全件取得の上限（デフォルト: 10_000） */
  maxRecords?: number;
  /** 取得上限到達時の動作（SELECT系のみ） */
  onLimitReached?: "error" | "truncate";
  /** fetchAll の並列取得数（1 = 直列） */
  fetchParallel?: number;
  /** フィールド関連キャッシュの文脈キー（例: CLI profile 名） */
  cacheContext?: string;
}

// ============================================================
// メイン: execute
// ============================================================

const defaultCacheContextByClient = new WeakMap<KintoneClient, string>();
let nextDefaultCacheContextId = 1;

function resolveCacheContext(client: KintoneClient, explicit?: string): string {
  if (explicit) return explicit;
  let context = defaultCacheContextByClient.get(client);
  if (!context) {
    context = `client:${nextDefaultCacheContextId++}`;
    defaultCacheContextByClient.set(client, context);
  }
  return context;
}

/**
 * SQL 文字列を受け取り、kintone API を呼び出して結果を返す。
 * API 呼び出し回数・取得行数・所要時間を計測し、結果の metrics に付与する。
 *
 * @param sql     SQL 文字列
 * @param client  kintone API クライアント
 * @param options 確認コールバック・上限件数等
 */
export async function execute(
  sql: string,
  client: KintoneClient,
  options: ExecuteOptions = {}
): Promise<ExecuteResult> {
  const startedAt = Date.now();
  const cacheContext = resolveCacheContext(client, options.cacheContext);
  const stmt = parseSql(sql);
  const metrics = createEmptyMetrics();
  const countedClient = wrapClientWithMetrics(client, metrics);
  const collector: SearchAbortCollector = { aborted: false };
  const guardedClient = wrapClientWithSearchAbort(
    countedClient,
    collector,
    !isSelectLikeStatement(stmt)
  );
  const result = await executeParsedStatement(
    stmt,
    guardedClient,
    options,
    cacheContext
  );
  metrics.elapsedMs = Date.now() - startedAt;
  return { ...attachSearchAbortWarning(result, collector), metrics };
}

function createEmptyMetrics(): ExecuteMetrics {
  return {
    getCalls: 0,
    postCalls: 0,
    putCalls: 0,
    deleteCalls: 0,
    fieldCalls: 0,
    appsCalls: 0,
    processStatusCalls: 0,
    fetchedRows: 0,
    elapsedMs: 0,
  };
}

/**
 * KintoneClient の全メソッドを計測カウンタ付きでラップする。
 * getFields はキャッシュ（fieldInfoCache）より内側で呼ばれるため、
 * キャッシュヒット時は fieldCalls が増えない = 実際の API 呼び出し回数を表す。
 */
function wrapClientWithMetrics(client: KintoneClient, metrics: ExecuteMetrics): KintoneClient {
  return {
    getRecords: async (params) => {
      metrics.getCalls += 1;
      const res = await client.getRecords(params);
      metrics.fetchedRows += res.records.length;
      return res;
    },
    postRecords: (params) => {
      metrics.postCalls += 1;
      return client.postRecords(params);
    },
    putRecords: (params) => {
      metrics.putCalls += 1;
      return client.putRecords(params);
    },
    deleteRecords: (params) => {
      metrics.deleteCalls += 1;
      return client.deleteRecords(params);
    },
    getApps: () => {
      metrics.appsCalls += 1;
      return client.getApps();
    },
    getFields: (appId) => {
      metrics.fieldCalls += 1;
      return client.getFields(appId);
    },
    getProcessStatuses: (appId) => {
      metrics.processStatusCalls += 1;
      return client.getProcessStatuses(appId);
    },
  };
}

function wrapClientWithSearchAbort(
  client: KintoneClient,
  collector: SearchAbortCollector,
  failClosed: boolean
): KintoneClient {
  return {
    ...client,
    getRecords: async (params) => {
      const response = await client.getRecords(params);
      if (response.searchAborted) {
        collector.aborted = true;
        if (failClosed) throw new SearchAbortedError();
      }
      return response;
    },
  };
}

function isSelectLikeStatement(stmt: Statement): boolean {
  return stmt.type === "SELECT" || stmt.type === "UNION" || stmt.type === "WITH";
}

function attachSearchAbortWarning(
  result: ExecuteResult,
  collector: SearchAbortCollector
): ExecuteResult {
  if (!collector.aborted || result.type !== "SELECT") return result;
  const warnings = new Set(result.warnings ?? []);
  warnings.add(SEARCH_ABORTED_WARNING);
  return { ...result, warnings: [...warnings] };
}

/** パース済み Statement を種別でルーティングして実行する（単文・バッチ共通の入口） */
async function executeParsedStatement(
  stmt: Statement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string
): Promise<ExecuteResult> {
  const unresolved = findVariableRef(stmt);
  if (unresolved !== null) {
    throw new Error(`ParseError: variable @${unresolved} is not defined in a batch.`);
  }
  validateKlikeStatement(stmt);
  if ("validateOnly" in stmt && stmt.validateOnly === true) {
    if (stmt.validationErrorTable) {
      throw new Error("ArgumentError: VALIDATE ONLY INTO requires a batch.");
    }
    return executeDmlValidation(stmt, client, { ...options, onLimitReached: "error" }, cacheContext, undefined, 1);
  }
  if ("onErrorSkip" in stmt && stmt.onErrorSkip === true) {
    throw new Error("ArgumentError: ON ERROR SKIP requires a batch.");
  }
  switch (stmt.type) {
    case "SELECT":        return executeSelect(stmt, client, options, cacheContext);
    case "UNION":         return executeUnion(stmt, client, options, cacheContext);
    case "WITH":          return executeWith(stmt, client, options, cacheContext);
    case "INSERT":        return executeInsert(stmt, client, options, cacheContext);
    case "INSERT_SELECT": return executeInsertSelect(stmt, client, options, cacheContext);
    case "UPSERT":        return executeUpsert(stmt, client, options, cacheContext);
    case "UPSERT_SELECT": return executeUpsertSelect(stmt, client, options, cacheContext);
    case "UPDATE":        return executeUpdate(stmt, client, options, cacheContext);
    case "DELETE":        return executeDelete(stmt, client, options, cacheContext);
    case "REORDER":       return executeReorder(stmt, client, options, cacheContext);
    case "SHOW_APPS":     return executeShowApps(client);
    case "DESCRIBE":      return executeDescribe(stmt, client, cacheContext);
    case "EXPLAIN":       return executeExplain(stmt, client, cacheContext, options.maxRecords ?? 10_000);
    // 一時テーブルはバッチスコープのため単文実行では拒否する（executeBatch を使う）
    case "CREATE_TEMP_TABLE":
      throw new Error("ArgumentError: CREATE TEMP TABLE requires a batch (temp tables are batch-scoped).");
    case "DROP_TEMP_TABLE":
      throw new Error("ArgumentError: DROP TEMP TABLE requires a batch (temp tables are batch-scoped).");
    case "SET_VARIABLE":
      throw new Error("ArgumentError: SET variable requires a batch.");
    case "DECLARE_VARIABLE":
      throw new Error("ArgumentError: DECLARE variable requires a batch.");
    case "ASSERT":        return executeAssert(stmt, client, options, cacheContext);
  }
}

// ============================================================
// バッチ実行（フェーズ1 S4）
//
// `;` 区切りの複文を validate-all-first（analyzeBatch）で検証した後、
// 順次実行する。一時テーブル（#name）はバッチ内スコープの
// Map<string, MaterializedTable> に行と列を実体化し、CTE キャッシュと同じ機構で
// FULL_SCAN エンジンに注入する。
// ============================================================

/** 一時テーブル1個の実体化行数上限（仕様 §5.6）。onLimitReached は適用せず常に error */
export const TEMP_TABLE_MAX_ROWS = 10_000;

export interface BatchExecuteOptions extends ExecuteOptions {
  /** DECLARE されたバッチ変数の外部注入値（キーは @ なし、大文字小文字を区別しない） */
  variables?: Readonly<Record<string, string>>;
  /** 実行時エラー後も後続文を実行する（read-only バッチのみ指定可。既定 false = fail-fast） */
  continueOnError?: boolean;
  /** バッチ合計のタイムアウト（ミリ秒）。到達時: 実行中の文 = error(TimeoutError)、未実行の文 = skipped("timeout") */
  timeoutMs?: number;
  /** 一時テーブル実体化の行数上限（既定 TEMP_TABLE_MAX_ROWS） */
  tempTableMaxRows?: number;
}

export interface BatchStatementError {
  code: string;
  message: string;
}

function appendValidationErrors(
  tempTables: Map<string, MaterializedTable>,
  name: string,
  columns: string[],
  rows: ProcessRow[],
  maxRows: number,
  columnMeta: MaterializedColumnMetaMap
): void {
  const current = tempTables.get(name);
  if (current && (
    current.columns.length !== columns.length
    || current.columns.some((c, i) => c !== columns[i])
    || !materializedColumnMetaEqual(current.columnMeta, columnMeta)
  )) {
    throw new Error(`ArgumentError: validation error table ${name} has a different schema.`);
  }
  const existingRows = current?.rows ?? [];
  if (existingRows.length + rows.length > maxRows) {
    throw new Error(`ArgumentError: temp table ${name} exceeds max rows (${maxRows}).`);
  }
  // schema・件数を先に検査し、既存値を変更せず単一setで反映する。
  tempTables.set(name, { columns: [...columns], rows: [...existingRows, ...rows], columnMeta });
}

function materializedColumnMetaEqual(
  left: MaterializedColumnMetaMap | undefined,
  right: MaterializedColumnMetaMap | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right || left.size !== right.size) return false;
  for (const [column, meta] of left) {
    const candidate = right.get(column);
    if (
      !candidate ||
      candidate.sortKind !== meta.sortKind ||
      candidate.fieldType !== meta.fieldType ||
      !fieldSemanticsEqual(candidate.semantics, meta.semantics)
    ) return false;
  }
  return true;
}

export interface BatchStatementResult {
  index: number;
  type: string;
  status: "success" | "error" | "skipped";
  /** success した文の実行結果（CREATE / DROP TEMP TABLE は持たない） */
  result?: ExecuteResult;
  /** CREATE / DROP TEMP TABLE の対象一時テーブル名 */
  tempTable?: string;
  /** CREATE_TEMP_TABLE の実体化行数 */
  rowCount?: number;
  error?: BatchStatementError;
  /** "fail-fast" / "dependency: #name" / "timeout" / "assertion" */
  skippedReason?: string;
}

export interface BatchExecuteResult {
  /** 全文 success のときのみ true */
  ok: boolean;
  statementCount: number;
  statements: BatchStatementResult[];
  /** 静的解析結果（isReadOnlyBatch / containsDml 等。呼び出し層の検証・整形用） */
  analysis: BatchAnalysis;
  metrics?: ExecuteMetrics;
}

type VarValue =
  | { type: "string"; value: string }
  | { type: "number"; value: number };

/** バッチタイムアウト。message 接頭辞で code = TimeoutError として報告される */
class BatchTimeoutError extends Error {
  constructor() {
    super("TimeoutError: batch timeout exceeded.");
  }
}

/**
 * `;` 区切りの複文バッチを順次実行する。
 *
 * - validate-all-first: 静的検証（analyzeBatch）に違反があれば1文も実行せずに throw
 * - 実行時エラーは throw せず、文ごとの status（success / error / skipped）で返す
 * - fail-fast（既定）: エラー文以降は skipped("fail-fast")
 * - continueOnError: エラー文を記録して続行。ただし失敗した CREATE に依存する文は
 *   skipped("dependency: #name")（S3 の依存グラフを使用）
 */
export async function executeBatch(
  sql: string,
  client: KintoneClient,
  options: BatchExecuteOptions = {}
): Promise<BatchExecuteResult> {
  const statements = parseSqlBatch(sql);
  const analysis = analyzeBatch(statements);
  // API 呼び出しや文実行より前に、注入キーの正規化と DECLARE 照合を完了する。
  const injectedVariables = validateDeclaredBatchVariables(statements, options.variables);
  const batchOptions: BatchExecuteOptions = { ...options, variables: injectedVariables };

  if (options.continueOnError && analysis.containsDml) {
    throw new Error("ArgumentError: continueOnError is not allowed for batches containing DML.");
  }
  // DML 文内の一時テーブル参照は SELECT-based DML（INSERT_SELECT / UPSERT_SELECT）
  // でのみ許可する（temp のみ・APP 混在とも。v1.7.0）。件数判定は書き込み前の
  // confirm フックが担うため dmlMaxRows と整合する。
  // それ以外（UPDATE のサブクエリ等）は引き続き拒否
  for (const s of analysis.statements) {
    if (!s.isDml || s.tempTablesReferenced.length === 0) continue;
    if (s.statementType === "INSERT_SELECT" || s.statementType === "UPSERT_SELECT") continue;
    const parsed = statements[s.index];
    if (parsed?.type === "UPDATE" && parsed.from?.cteName != null) continue;
    throw new BatchAnalysisError(
      `ArgumentError: temp table references in ${s.statementType} are not supported yet.`,
      s.index
    );
  }

  const metrics = createEmptyMetrics();
  const countedClient = wrapClientWithMetrics(client, metrics);
  const startedAt = Date.now();
  const deadline = options.timeoutMs != null ? startedAt + options.timeoutMs : null;
  const cacheContext = resolveCacheContext(client, options.cacheContext);

  const tempTables = new Map<string, MaterializedTable>();
  const variables = new Map<string, VarValue>();
  const results: BatchStatementResult[] = [];
  /** success しなかった文の index（error / skipped）。依存スキップの判定に使う */
  const failed = new Set<number>();
  /** fail-fast / timeout / assertion で中断済みなら以降の文の skippedReason */
  let aborted: "fail-fast" | "timeout" | "assertion" | null = null;

  for (let i = 0; i < statements.length; i++) {
    const info = analysis.statements[i];
    const base = { index: i, type: info.statementType };

    if (aborted) {
      results.push({ ...base, status: "skipped", skippedReason: aborted });
      failed.add(i);
      continue;
    }

    // 依存スキップ: 依存先（一時テーブルを CREATE した文）が success していない
    const brokenDep = info.dependsOn.find((d) => failed.has(d));
    if (brokenDep !== undefined) {
      const depName =
        analysis.statements[brokenDep].tempTablesCreated[0] ?? `statement ${brokenDep}`;
      results.push({ ...base, status: "skipped", skippedReason: `dependency: ${depName}` });
      failed.add(i);
      continue;
    }

    if (deadline !== null && Date.now() >= deadline) {
      results.push({ ...base, status: "skipped", skippedReason: "timeout" });
      failed.add(i);
      aborted = "timeout";
      continue;
    }

    try {
      const remaining = deadline !== null ? deadline - Date.now() : null;
      // confirm に文コンテキストを注入する（呼び出し回数からの文番号推測は
      // INSERT VALUES 非経由・0 件 UPSERT スキップで崩れるため、ここで束縛する）
      const userConfirm = batchOptions.confirm;
      const stmtOptions: BatchExecuteOptions = userConfirm
        ? {
          ...batchOptions,
          confirm: (count, operation) => userConfirm(count, operation, {
            statementIndex: i,
            statementCount: statements.length,
            statementType: info.statementType,
            targetAppId: info.targetAppId,
          }),
        }
        : batchOptions;
      const searchAbortCollector: SearchAbortCollector = { aborted: false };
      const statementClient = wrapClientWithSearchAbort(
        countedClient,
        searchAbortCollector,
        info.statementType !== "SELECT" && info.statementType !== "UNION" && info.statementType !== "WITH"
      );
      const outcome = await runWithDeadline(
        executeBatchStatement(statements[i], info, statementClient, stmtOptions, cacheContext, tempTables, variables),
        remaining
      );
      if (outcome.result) {
        outcome.result = attachSearchAbortWarning(outcome.result, searchAbortCollector);
      }
      results.push({ ...base, status: "success", ...outcome });
    } catch (e) {
      results.push({
        ...base,
        status: "error",
        error: toBatchStatementError(e),
        ...(e instanceof RejectLimitExceededError ? { result: e.diagnostic } : {}),
      });
      failed.add(i);
      if (e instanceof BatchTimeoutError) {
        aborted = "timeout";
      } else if (e instanceof AssertError) {
        // ASSERT 失敗は continueOnError を無視して常に停止する（設計判断 D3:
        // ASSERT は後続実行のゲートであり、続行を許すと存在意義が消える）
        aborted = "assertion";
      } else if (info.statementType === "SET_VARIABLE" || info.statementType === "DECLARE_VARIABLE") {
        // 変数値が欠けた状態で後続を実行しない（continueOnError より優先）
        aborted = "fail-fast";
      } else if (!options.continueOnError) {
        aborted = "fail-fast";
      }
    }
  }

  metrics.elapsedMs = Date.now() - startedAt;
  return {
    ok: results.every((r) => r.status === "success"),
    statementCount: statements.length,
    statements: results,
    analysis,
    metrics,
  };
}

/** 1文をバッチ文脈（一時テーブルストア付き）で実行する */
async function executeBatchStatement(
  stmt: Statement,
  info: BatchAnalysis["statements"][number],
  client: KintoneClient,
  options: BatchExecuteOptions,
  cacheContext: string,
  tempTables: Map<string, MaterializedTable>,
  variables: Map<string, VarValue>
): Promise<Partial<BatchStatementResult>> {
  if (stmt.type === "SET_VARIABLE") {
    const resolvedStmt = resolveVariableRefs(stmt, variables);
    validateKlikeStatement(resolvedStmt);
    if (resolvedStmt.expr.type === "SCALAR_SUBQUERY") {
      try {
        const value = await evaluateScalarSubquery(
          resolvedStmt.expr.query,
          client,
          options,
          cacheContext,
          tempTables
        );
        const first = resolvedStmt.expr.query.columns[0];
        const numeric = first?.type === "ARITH_COL"
          || first?.type === "ARITH_AGG_COL"
          || first?.type === "WINDOW_COL"
          || (first?.type === "AGGREGATE"
            && (first.func === "COUNT" || first.func === "SUM" || first.func === "AVG"));
        const numberValue = numeric ? Number(value) : Number.NaN;
        variables.set(stmt.name, numeric && Number.isFinite(numberValue)
          ? { type: "number", value: numberValue }
          : { type: "string", value });
      } catch (e) {
        if (e instanceof ScalarSubqueryError) {
          throw new Error(`ArgumentError: ${e.message}`);
        }
        throw e;
      }
    } else {
      variables.set(stmt.name, evaluateScalarExpr(resolvedStmt.expr));
    }
    return {};
  }

  if (stmt.type === "DECLARE_VARIABLE") {
    const injected = options.variables ?? {};
    if (Object.prototype.hasOwnProperty.call(injected, stmt.name)) {
      variables.set(stmt.name, { type: "string", value: injected[stmt.name] });
    } else {
      const value = evaluateScalarExpr(stmt.default);
      variables.set(stmt.name, { type: "string", value: String(value.value) });
    }
    return {};
  }

  const resolvedStmt = resolveVariableRefs(stmt, variables);
  // KLIKE の %・右辺型は、バッチ変数を実リテラルへ置換した後にも検証する。
  validateKlikeStatement(resolvedStmt);

  if ("validateOnly" in resolvedStmt && resolvedStmt.validateOnly === true) {
    const result = await executeDmlValidation(
      resolvedStmt,
      client,
      { ...options, onLimitReached: "error" },
      cacheContext,
      tempTables,
      info.index + 1
    );
    if (resolvedStmt.validationErrorTable) {
      appendValidationErrors(
        tempTables,
        resolvedStmt.validationErrorTable,
        result.columns,
        result.errors,
        options.tempTableMaxRows ?? TEMP_TABLE_MAX_ROWS,
        materializedMetaByValidationResult.get(result) ?? new Map()
      );
    }
    return { result };
  }

  if ("onErrorSkip" in resolvedStmt && resolvedStmt.onErrorSkip === true) {
    return {
      result: await executeOnErrorSkip(
        resolvedStmt,
        client,
        { ...options, onLimitReached: "error" },
        cacheContext,
        tempTables,
        info.index + 1
      ),
    };
  }

  if (resolvedStmt.type === "CREATE_TEMP_TABLE") {
    // 実体化は onLimitReached を適用せず常に error
    //（truncate による暗黙の欠損が後続文の結果を静かに歪めるため。仕様 §5.6）
    const materializeOptions: ExecuteOptions = {
      ...options,
      maxRecords: options.tempTableMaxRows ?? TEMP_TABLE_MAX_ROWS,
      onLimitReached: "error",
    };
    const result = await runSelectLike(resolvedStmt.query, client, materializeOptions, cacheContext, tempTables);
    tempTables.set(resolvedStmt.name, {
      rows: result.rows,
      columns: result.columns,
      columnMeta: materializedMetaBySelectResult.get(result),
    });
    return { tempTable: resolvedStmt.name, rowCount: result.rows.length };
  }

  if (stmt.type === "DROP_TEMP_TABLE") {
    tempTables.delete(stmt.name); // ストアの解放（存在は analyzeBatch が検証済み）
    return { tempTable: stmt.name };
  }

  // EXPLAIN はプラン表示のみ（kintone アクセスなし）のため一時テーブル参照を含んでも安全
  if (stmt.type === "EXPLAIN") {
    return { result: await executeParsedStatement(resolvedStmt, client, options, cacheContext) };
  }

  // ASSERT: 成功時は result を持たせない no-result 文として扱う
  //（`result.type !== "SELECT"` → mutation summary 経路への流入を構造的に防ぐ。仕様 §2.3）
  if (resolvedStmt.type === "ASSERT") {
    await executeAssert(resolvedStmt, client, options, cacheContext, tempTables);
    return {};
  }

  // 一時テーブルを参照する文はストアを注入して実行
  if (info.tempTablesReferenced.length > 0) {
    if (resolvedStmt.type === "SELECT" || resolvedStmt.type === "UNION") {
      return { result: await executeQueryWithCte(resolvedStmt, client, options, tempTables, cacheContext) };
    }
    if (resolvedStmt.type === "WITH") {
      return { result: await executeWith(resolvedStmt, client, options, cacheContext, tempTables) };
    }
    // SELECT-based DML（ソースは temp のみ / APP 混在とも。事前チェックで検証済み）
    if (resolvedStmt.type === "INSERT_SELECT") {
      return { result: await executeInsertSelect(resolvedStmt, client, options, cacheContext, tempTables) };
    }
    if (resolvedStmt.type === "UPSERT_SELECT") {
      return { result: await executeUpsertSelect(resolvedStmt, client, options, cacheContext, tempTables) };
    }
    if (resolvedStmt.type === "UPDATE" && resolvedStmt.from?.cteName != null) {
      return { result: await executeUpdate(resolvedStmt, client, options, cacheContext, tempTables) };
    }
    // ここに来るのは想定外（他の DML 参照は事前チェックで拒否済み）
    throw new Error(`ArgumentError: temp table references in ${stmt.type} are not supported yet.`);
  }

  // 一時テーブルと無関係な文は既存の単文実行経路をそのまま使う
  return { result: await executeParsedStatement(resolvedStmt, client, options, cacheContext) };
}

/** CREATE TEMP TABLE の AS 句（SELECT / UNION / WITH）を一時テーブルストア付きで実行する */
async function runSelectLike(
  query: SelectStatement | UnionStatement | WithStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  tempTables: Map<string, MaterializedTable>
): Promise<SelectResult> {
  if (query.type === "WITH") {
    return executeWith(query, client, options, cacheContext, tempTables, true);
  }
  return executeQueryWithCte(query, client, options, tempTables, cacheContext, true);
}

/**
 * 文の実行に残り時間の期限を課す。到達時は BatchTimeoutError を投げる。
 * 注意: 進行中の kintone リクエスト自体は中断されない（AbortSignal の
 * 伝播はレート制御基盤 P0-1 とあわせて対応する）。
 */
async function runWithDeadline<T>(work: Promise<T>, remainingMs: number | null): Promise<T> {
  if (remainingMs === null) return work;
  if (remainingMs <= 0) {
    void work.catch(() => { /* 破棄する実行の未処理拒否を抑止 */ });
    throw new BatchTimeoutError();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new BatchTimeoutError()), remainingMs);
      }),
    ]);
  } catch (e) {
    if (e instanceof BatchTimeoutError) {
      void work.catch(() => { /* 同上 */ });
    }
    throw e;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * エラーを文ごとの報告形式に変換する。
 * code の優先順: Error の name / オブジェクトの code プロパティ
 * → message の "XxxError:" 接頭辞 → "Error"。
 * プラグインの kintone.api は Error ではなく素のオブジェクト（{ code, message, id }）で
 * reject するため、オブジェクト形式も解釈する（String(e) だと "[object Object]" になる）
 */
function toBatchStatementError(e: unknown): BatchStatementError {
  if (e instanceof Error) {
    const name = e.name !== "Error" ? e.name : null;
    return { code: name ?? codeFromMessagePrefix(e.message), message: e.message };
  }
  if (e !== null && typeof e === "object") {
    const obj = e as { message?: unknown; code?: unknown };
    const message =
      typeof obj.message === "string" && obj.message.length > 0
        ? obj.message
        : safeJsonStringify(e);
    const code =
      typeof obj.code === "string" && obj.code.length > 0
        ? obj.code
        : codeFromMessagePrefix(message);
    return { code, message };
  }
  const message = String(e);
  return { code: codeFromMessagePrefix(message), message };
}

/** message の "XxxError:" 接頭辞をコードとして抽出する（なければ "Error"） */
function codeFromMessagePrefix(message: string): string {
  return message.match(/^([A-Za-z]+Error):/)?.[1] ?? "Error";
}

function safeJsonStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

function parseSqlBatch(sql: string): Statement[] {
  const tokens = new Lexer(sql).tokenize();
  return new Parser(tokens).parseStatements();
}

function evaluateScalarExpr(expr: Exclude<ScalarExpr, ScalarSubquery>): VarValue {
  switch (expr.type) {
    case "STRING":
      return { type: "string", value: expr.value };
    case "NUMBER":
      return { type: "number", value: expr.value };
    case "KINTONE_FUNC":
      return { type: "string", value: resolveKintoneFunc(expr.name) };
    case "STRING_FUNC":
      return { type: "string", value: evalStringFunc(expr, {}) };
    case "ARITH": {
      const value = evalArithExpr(expr, {});
      if (!Number.isFinite(value)) {
        throw new Error("ArgumentError: SET scalar arithmetic produced a non-finite number.");
      }
      return { type: "number", value };
    }
  }
}

/** 文実行前に VariableRef を型付きリテラルへ置換し、既存実行経路へ渡す。 */
function resolveVariableRefs<T>(node: T, variables: Map<string, VarValue>): T {
  if (Array.isArray(node)) {
    return node.map((v) => resolveVariableRefs(v, variables)) as T;
  }
  if (node !== null && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (obj["type"] === "VARIABLE" && typeof obj["name"] === "string") {
      const value = variables.get(obj["name"]);
      if (value === undefined) {
        throw new Error(`ParseError: variable @${obj["name"]} is not defined in this batch.`);
      }
      return (value.type === "number"
        ? { type: "NUMBER", value: value.value }
        : { type: "STRING", value: value.value }) as T;
    }
    return Object.fromEntries(
      Object.entries(obj).map(([key, value]) => [key, resolveVariableRefs(value, variables)])
    ) as T;
  }
  return node;
}

function findVariableRef(node: unknown): string | null {
  if (Array.isArray(node)) {
    for (const value of node) {
      const found = findVariableRef(value);
      if (found !== null) return found;
    }
    return null;
  }
  if (node !== null && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (obj["type"] === "VARIABLE" && typeof obj["name"] === "string") return obj["name"];
    for (const value of Object.values(obj)) {
      const found = findVariableRef(value);
      if (found !== null) return found;
    }
  }
  return null;
}

// ============================================================
// ASSERT（バッチ強化第1弾 §2）
// ============================================================

/** ASSERT 失敗。message 接頭辞で code = AssertError として報告される */
export class AssertError extends Error {
  constructor(message: string) {
    super(`AssertError: ${message}`);
    this.name = "AssertError";
  }
}

/** ASSERT / SET に依存しないスカラーサブクエリの形状エラー。 */
class ScalarSubqueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScalarSubqueryError";
  }
}

/**
 * ASSERT 文を評価する。条件が false なら AssertError を投げる。
 * サブクエリの一時テーブル参照はバッチ実行時のみ解決できる（tempTables 経由）。
 */
async function executeAssert(
  stmt: AssertStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  tempTables?: Map<string, MaterializedTable>
): Promise<AssertResult> {
  const left = await evalAssertOperand(stmt.left, client, options, cacheContext, tempTables);
  const semantics = stmt.left.type === "NUMBER" || stmt.left.type === "ARITH"
    ? syntheticSemantics("number")
    : syntheticSemantics("string");

  if (stmt.op === "BETWEEN") {
    if (stmt.low === null || stmt.high === null) {
      throw new Error("ArgumentError: malformed ASSERT statement.");
    }
    const low  = await evalAssertOperand(stmt.low,  client, options, cacheContext, tempTables);
    const high = await evalAssertOperand(stmt.high, client, options, cacheContext, tempTables);
    // WHERE の BETWEEN と同じ >= AND <= 展開
    if (!compareScalarValues(">=", left, low, semantics) || !compareScalarValues("<=", left, high, semantics)) {
      throw new AssertError(`assertion failed: ${stmt.text} (actual: ${left}).`);
    }
    return { type: "ASSERT", condition: stmt.text };
  }

  if (stmt.right === null) {
    throw new Error("ArgumentError: malformed ASSERT statement.");
  }
  const right = await evalAssertOperand(stmt.right, client, options, cacheContext, tempTables);
  if (!compareScalarValues(stmt.op, left, right, semantics)) {
    throw new AssertError(`assertion failed: ${stmt.text} (actual: ${left}).`);
  }
  return { type: "ASSERT", condition: stmt.text };
}

/** ASSERT のオペランドを文字列値に評価する（サブクエリは 1行1列を実行時検証） */
async function evalAssertOperand(
  operand: AssertOperand,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  tempTables?: Map<string, MaterializedTable>
): Promise<string> {
  switch (operand.type) {
    case "VARIABLE":
      throw new Error(`ParseError: unresolved batch variable @${operand.name}.`);
    case "NUMBER": return String(operand.value);
    case "STRING": return operand.value;
    case "ARITH":  return String(evalAssertArith(operand));
    case "SCALAR_SUBQUERY": {
      try {
        return await evaluateScalarSubquery(
          operand.query,
          client,
          options,
          cacheContext,
          tempTables
        );
      } catch (e) {
        if (e instanceof ScalarSubqueryError) throw new AssertError(e.message);
        throw e;
      }
    }
  }
}

/** スカラーサブクエリを1回実行し、厳密に1行1列の文字列値へ変換する。 */
async function evaluateScalarSubquery(
  sourceQuery: SelectStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  tempTables?: Map<string, MaterializedTable>
): Promise<string> {
  const { query, probed } = withScalarProbeLimit(sourceQuery);
  const result = await runSubquery(query, client, options, cacheContext, tempTables);
  if (result.columns.length !== 1) {
    throw new ScalarSubqueryError(
      `scalar subquery returned ${result.columns.length} columns (expected 1 column).`
    );
  }
  if (result.rowCount === 0) {
    throw new ScalarSubqueryError("scalar subquery returned no rows (expected 1 row).");
  }
  if (result.rowCount > 1) {
    // probe（LIMIT 2 打ち切り）時は総行数が分からない
    const rows = probed && result.rowCount === 2 ? "2 or more rows" : `${result.rowCount} rows`;
    throw new ScalarSubqueryError(`scalar subquery returned ${rows} (expected 1 row).`);
  }
  return result.rows[0]?.[result.columns[0]] ?? "";
}

/**
 * 非集計・非 GROUP BY・非 DISTINCT のスカラー検証は 2 行取得できた時点で
 * 「複数行」と確定するため LIMIT 2 で打ち切る（仕様 §2.3）。
 * 集計は結果が 1 行でも計算に全対象行の取得が必要なため適用しない。
 * ユーザーが LIMIT を明示した場合はそれを尊重する。
 */
function withScalarProbeLimit(query: SelectStatement): { query: SelectStatement; probed: boolean } {
  const hasAgg =
    query.groupBy.length > 0 ||
    query.columns.some((c) => c.type === "AGGREGATE" || c.type === "ARITH_AGG_COL");
  if (hasAgg || query.distinct || query.limit !== null) return { query, probed: false };
  return { query: { ...query, limit: 2 }, probed: true };
}

/** ASSERT の算術式を評価する（葉は数値リテラルのみ — パーサで検証済み） */
function evalAssertArith(node: ArithNode): number {
  if (node.type === "NUMBER") return node.value;
  if (node.type === "ARITH") {
    const left  = evalAssertArith(node.left);
    const right = evalAssertArith(node.right);
    switch (node.op) {
      case "+": return left + right;
      case "-": return left - right;
      case "*": return left * right;
      case "/": return left / right;
      case "%": return left % right;
    }
  }
  throw new Error(`ArgumentError: unsupported operand in ASSERT expression: ${node.type}`);
}

// ============================================================
// SELECT
// ============================================================

async function buildWhereFieldSemanticsResolver(
  stmt: SelectStatement,
  client: KintoneClient,
  cacheContext: string,
  materializedTables?: ReadonlyMap<string, MaterializedTable>,
  forcePhysicalMetadata = false
): Promise<WhereFieldSemanticsResolver> {
  const tables = [stmt.from, ...stmt.joins.map((join) => join.table)];
  // $id はスキーマ不要の組み込み列。これだけの predicate で form API を増やさない。
  const physicalAppIds = forcePhysicalMetadata || whereNeedsFieldMetadata(stmt.where)
    ? [...new Set(tables.filter((table) => table.cteName === null).map((table) => table.appId))]
    : [];
  const infosByApp = new Map<number, Map<string, KintoneFieldInfo>>(
    await Promise.all(physicalAppIds.map(async (appId) => {
      const infos = await getFieldsCached(appId, client, cacheContext);
      return [appId, new Map(infos.map((info) => [info.code, info]))] as const;
    }))
  );
  const orderedFields = new Set<string>();
  const collectOrderedFields = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(collectOrderedFields);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const value = node as Record<string, unknown>;
    if (value["type"] === "SELECT") return;
    if (value["type"] === "BINARY"
      && [">", "<", ">=", "<="].includes(String(value["op"]))) {
      const left = value["left"] as Record<string, unknown> | undefined;
      if (left?.["type"] === "FIELD" && typeof left["field"] === "string") {
        orderedFields.add(left["field"] as string);
      }
    }
    Object.values(value).forEach(collectOrderedFields);
  };
  collectOrderedFields(stmt.where);
  collectOrderedFields(stmt.having);
  for (const column of stmt.columns) {
    if (column.type === "CASE_COL") collectOrderedFields(column.expr);
  }
  const statusOrdersByApp = new Map<number, ReadonlyMap<string, number>>();
  await Promise.all([...infosByApp].map(async ([appId, infos]) => {
    const needsStatus = [...orderedFields].some((field) => infos.get(field)?.fieldType === "STATUS");
    if (!needsStatus) return;
    const order = await loadProcessStatusOrder(appId, client, cacheContext);
    if (order) statusOrdersByApp.set(appId, order);
  }));

  const fromPhysical = (table: TableRef, field: string): ResolvedFieldSemantics | undefined => {
    if (field === "$id") return withFieldSemanticSource(
      resolveFieldSemantics({ fieldType: "__ID__" }), table.appId, "$id"
    );
    const info = infosByApp.get(table.appId)?.get(fieldCodeForTypeLookup(table, field));
    if (!info) return undefined;
    const base = info.semantics ?? resolveFieldSemantics(info);
    const semantics = info.fieldType === "STATUS" && statusOrdersByApp.has(table.appId)
      ? { ...base, optionOrder: statusOrdersByApp.get(table.appId) }
      : base;
    return withFieldSemanticSource(
      semantics,
      table.appId,
      info.code
    );
  };

  return (field) => {
    if (field.tableAlias !== null) {
      if (field.tableAlias === "_p" && stmt.from.subtableCode && stmt.from.cteName === null) {
        return fromPhysical(stmt.from, field.field);
      }
      const table = tables.find((candidate) => candidate.alias === field.tableAlias);
      if (!table) return undefined;
      if (table.cteName !== null) {
        return materializedTables?.get(table.cteName)?.columnMeta?.get(field.field)?.semantics
          ?? syntheticSemantics("string");
      }
      return fromPhysical(table, field.field);
    }
    if (stmt.joins.length === 0) {
      if (stmt.from.cteName !== null) {
        return materializedTables?.get(stmt.from.cteName)?.columnMeta?.get(field.field)?.semantics
          ?? syntheticSemantics("string");
      }
      return fromPhysical(stmt.from, field.field);
    }
    const matches = tables.flatMap((table): ResolvedFieldSemantics[] => {
      const semantics = table.cteName !== null
        ? materializedTables?.get(table.cteName)?.columnMeta?.get(field.field)?.semantics
        : fromPhysical(table, field.field);
      return semantics ? [semantics] : [];
    });
    if (matches.length === 1) return matches[0];
    // JOIN の非修飾同名列は既存契約どおりローカル値として評価する。
    return matches.length > 1 ? syntheticSemantics("string") : undefined;
  };
}

function selectCaseConditionsNeedFieldMetadata(stmt: SelectStatement): boolean {
  return stmt.columns.some((column) => column.type === "CASE_COL"
    && column.expr.branches.some((branch) => whereNeedsFieldMetadata(branch.condition)));
}

function buildHavingFieldSemanticsResolver(
  stmt: SelectStatement,
  rowResolver: FieldSemanticsResolver
): FieldSemanticsResolver {
  const aliases = new Map<string, ResolvedFieldSemantics>();
  for (const column of stmt.columns) {
    if (!("alias" in column) || !column.alias) continue;
    let semantics: ResolvedFieldSemantics | undefined;
    if (column.type === "FIELD") semantics = rowResolver(aggregateFieldRef(column.field));
    else if (column.type === "ARITH_COL" || column.type === "ARITH_AGG_COL" || column.type === "WINDOW_COL") {
      semantics = syntheticSemantics("number");
    } else if (column.type === "AGGREGATE") {
      if (column.func === "MIN" || column.func === "MAX") {
        semantics = column.arg.type === "FIELD_REF"
          ? rowResolver(aggregateFieldRef(column.arg.field))
          : syntheticSemantics("number");
      } else {
        semantics = column.func === "GROUP_CONCAT" ? syntheticSemantics("string") : syntheticSemantics("number");
      }
    } else if (column.type === "STRFUNC_COL") {
      semantics = stringFunctionColumnMeta(column.expr).semantics;
    } else if (column.type === "LITERAL_COL" || column.type === "SCALAR_SUBQUERY_COL" || column.type === "CASE_COL") {
      semantics = syntheticSemantics("string");
    }
    if (semantics) aliases.set(column.alias, semantics);
  }
  return (field) => field.tableAlias === null && aliases.has(field.field)
    ? aliases.get(field.field)
    : rowResolver(field);
}

async function resolveSelectWhereCapability(
  stmt: SelectStatement,
  client: KintoneClient,
  cacheContext: string,
  materializedTables?: ReadonlyMap<string, MaterializedTable>
): Promise<PredicateCapabilityResult> {
  if (stmt.where === null) return classifyWhereCapability(null, () => undefined);
  const resolver = await buildWhereFieldSemanticsResolver(stmt, client, cacheContext, materializedTables);
  return classifyWhereCapability(stmt.where, resolver);
}

function formatWhereCapabilityFailure(result: PredicateCapabilityResult): string {
  const reason = result.reasons.find((candidate) =>
    candidate.code === "WHERE_FIELD_UNRESOLVED" || candidate.code === "WHERE_OPERATOR_UNSUPPORTED"
  ) ?? result.reasons[0];
  const details = [
    reason?.field ? `field=${reason.field}` : null,
    reason?.fieldType ? `type=${reason.fieldType}` : null,
    reason?.operator ? `operator=${reason.operator}` : null,
    reason?.code ? `reason=${reason.code}` : null,
  ].filter((value): value is string => value !== null).join(", ");
  return details || "reason=WHERE_UNSUPPORTED";
}

function hasCanonicalOrder(stmt: SelectStatement): boolean {
  return stmt.orderBy.length > 0 || stmt.columns.some(
    (column) => column.type === "WINDOW_COL" && column.orderBy.length > 0
  );
}

async function assertDmlWhereCapability(
  stmt: UpdateStatement | DeleteStatement,
  client: KintoneClient,
  cacheContext: string
): Promise<void> {
  // サブテーブルDMLは既存どおり親を取得してローカル評価する。B32はREST対象選択経路を扱う。
  // UPDATE ... FROM の WHERE はソースとの結合条件で、専用の照合器が対象を決める。
  if (stmt.subtableCode || (stmt.type === "UPDATE" && stmt.from != null)) return;
  const fields = whereNeedsFieldMetadata(stmt.where)
    ? await getFieldsCached(stmt.appId, client, cacheContext)
    : [];
  const byCode = new Map(fields.map((field) => [field.code, field]));
  const result = classifyWhereCapability(stmt.where, (field) => {
    // UPDATE/DELETE の対象は単一アプリ。パーサが保持する APP100. 修飾も同じ対象列を指す。
    if (field.field === "$id") return resolveFieldSemantics({ fieldType: "__ID__" });
    const info = byCode.get(field.field);
    return info?.semantics ?? (info ? resolveFieldSemantics(info) : undefined);
  });
  if (result.capability !== "EXACT_PUSHDOWN") {
    throw new DmlConvertError(
      `WHERE predicate cannot be represented by kintone REST (${formatWhereCapabilityFailure(result)})`
    );
  }
}

async function executeSelect(
  stmt: SelectStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  /** CTE / 一時テーブルのキャッシュ。サブクエリ解決に引き継ぐ（トップレベルの
   *  FROM / JOIN 参照は executeQueryWithCte 側で処理済みの前提） */
  cteCache?: Map<string, MaterializedTable>,
  captureColumnMeta = false
): Promise<SelectResult> {
  let result: SelectResult;
  if (isNoFromSelect(stmt)) {
    result = executeNoFromSelect(stmt);
    if (captureColumnMeta) {
      materializedMetaBySelectResult.set(result, await inferSelectColumnMeta(stmt, result.columns, client, cacheContext, cteCache));
    }
    return result;
  }
  await resolveSelectCaseSubqueries(stmt, client, options, cacheContext, cteCache);
  const whereCapability = await resolveSelectWhereCapability(stmt, client, cacheContext, cteCache);
  if (whereCapability.capability === "UNSUPPORTED") {
    throw new Error(`ArgumentError: WHERE predicate is unsupported (${formatWhereCapabilityFailure(whereCapability)}).`);
  }
  const staticMode = resolveSelectMode(stmt);
  const mode: SelectMode = whereCapability.capability === "EXACT_PUSHDOWN"
    ? staticMode
    : "FULL_SCAN";
  const orderMeta = await buildOrderByMetaForSelect(stmt, client, cacheContext, cteCache);
  const orderPlan = hasCanonicalOrder(stmt)
    ? (stmt.orderMode === "KINTONE_NATIVE" ? planKorderNative : planCanonicalOrder)({
        stmt,
        staticMode: mode,
        whereCapability: whereCapability.capability,
        orderSemantics: orderMeta.semantics,
        maxRecords: options.maxRecords ?? 10_000,
        hasKlike: whereHasKlike(stmt.where),
      })
    : null;
  await validateSelectFieldCodes(
    stmt,
    orderPlan?.kind === "CANONICAL_LOCAL" ? "FULL_SCAN" : mode,
    client,
    cacheContext
  );
  // REST top-N がトップレベル ORDER BY を完全に担う場合だけ、B30 の完全入力要求から
  // その ORDER BY を除く。window / subquery ORDER BY の要求は残す。
  const completeInputRequired = orderPlan?.kind === "CANONICAL_REST_TOP_N" || orderPlan?.kind === "KORDER_NATIVE"
    ? requiresCompleteInput({ ...stmt, orderBy: [] })
    : requiresCompleteInput(stmt);
  const truncateWasDisabled = completeInputRequired && options.onLimitReached === "truncate";
  const effectiveOptions = truncateWasDisabled
    ? { ...options, onLimitReached: "error" as const }
    : options;

  try {
    if (mode === "SIMPLE") {
      result = await executeSimpleSelect(stmt, client, effectiveOptions, cacheContext, orderPlan, orderMeta);
    } else {
      result = await executeFullScanSelect(
        stmt,
        client,
        effectiveOptions,
        cacheContext,
        cteCache,
        whereCapability.capability === "EXACT_PUSHDOWN",
        orderMeta
      );
    }
  } catch (error) {
    if (completeInputRequired && error instanceof FetchAllLimitError) {
      throw new FetchAllLimitError(
        "ORDER BYの正しい結果には完全な候補集合が必要です。" +
        (truncateWasDisabled ? "onLimit=truncateは使用できません。" : "") +
        error.message
      );
    }
    throw error;
  }
  if (captureColumnMeta) {
    materializedMetaBySelectResult.set(result, await inferSelectColumnMeta(stmt, result.columns, client, cacheContext, cteCache));
  }
  return result;
}

function isNoFromSelect(stmt: SelectStatement): boolean {
  return stmt.from.appId === 0 && stmt.from.cteName === NO_FROM_CTE_NAME;
}

function arithHasFieldRef(node: ArithNode): boolean {
  if (node.type === "FIELD_REF") return true;
  if (node.type === "ARITH") return arithHasFieldRef(node.left) || arithHasFieldRef(node.right);
  if (node.type === "STRING_FUNC") return stringFuncHasFieldRef(node);
  return false;
}

function stringFuncArgHasFieldRef(arg: StringFuncArg): boolean {
  if (arg.type === "FIELD_REF") return true;
  if (arg.type === "ARITH") return arithHasFieldRef(arg);
  if (arg.type === "STRING_FUNC") return stringFuncHasFieldRef(arg);
  if (arg.type === "AGG_REF" || arg.type === "AGG_ARITH") return true;
  return false;
}

function stringFuncHasFieldRef(expr: StringFuncExpr): boolean {
  return expr.args.some((arg) => stringFuncArgHasFieldRef(arg));
}

function validateNoFromColumns(stmt: SelectStatement): void {
  for (const col of stmt.columns) {
    switch (col.type) {
      case "LITERAL_COL":
        break;
      case "ARITH_COL":
        if (arithHasFieldRef(col.expr)) {
          throw new Error("ArgumentError: field reference is not allowed without FROM.");
        }
        break;
      case "STRFUNC_COL":
        if (stringFuncHasFieldRef(col.expr)) {
          throw new Error("ArgumentError: field reference is not allowed without FROM.");
        }
        break;
      case "WINDOW_COL":
        if (col.partitionBy.length > 0 || col.orderBy.length > 0) {
          throw new Error("ArgumentError: field reference is not allowed without FROM.");
        }
        break;
      default:
        throw new Error(`ArgumentError: ${col.type} is not supported without FROM.`);
    }
  }
}

function executeNoFromSelect(stmt: SelectStatement): SelectResult {
  if (stmt.joins.length > 0 || stmt.where || stmt.groupBy.length > 0 || stmt.having || stmt.orderBy.length > 0 || stmt.distinct) {
    throw new Error("ArgumentError: JOIN/WHERE/GROUP BY/HAVING/ORDER BY/DISTINCT are not supported without FROM.");
  }
  validateNoFromColumns(stmt);
  const windowed = applyWindow([{}], stmt.columns);
  const { rows: projected, columns } = project(windowed, stmt.columns);
  const rows = applyLimit(projected, stmt.limit, stmt.offset);
  return { type: "SELECT", rows, columns, rowCount: rows.length, warnings: [] };
}

/** SIMPLE モード: kintone クエリに変換して GET → project */
async function executeSimpleSelect(
  stmt: SelectStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  orderPlan: CanonicalOrderPlan | null,
  orderMeta: OrderByMeta
): Promise<SelectResult> {
  const restStmt = orderPlan?.kind === "CANONICAL_REST_TOP_N"
    ? withCanonicalRestTie(stmt)
    : stmt;
  const params = selectToKintoneParams(restStmt);
  const fetchFields = orderPlan?.kind === "CANONICAL_LOCAL"
    ? selectToFetchAllFields(stmt, stmt.from)
    : params.fields;
  // SELECT CASE は SIMPLE モードでも JS 側で射影されるため、CASE 条件内の
  // IN / NOT IN に限って型 resolver を用意する（フィールド定義キャッシュを再利用）。
  const typedInFieldTypes = await loadTypedInFieldTypes(stmt, client, cacheContext);
  const fieldTypeResolvers = buildSelectFieldTypeResolvers(stmt, typedInFieldTypes);
  const projectionSemanticsResolver = stmt.columns.some((column) => column.type === "CASE_COL")
    ? await buildWhereFieldSemanticsResolver(
        stmt, client, cacheContext, undefined, selectCaseConditionsNeedFieldMetadata(stmt)
      )
    : undefined;
  const maxRecords = options.maxRecords ?? 10_000;
  const warnings = new Set<string>();
  const onLimit = options.onLimitReached ?? "error";
  const parallel = options.fetchParallel ?? 1;
  const useRestWindow = stmt.orderBy.length > 0
    ? orderPlan?.kind === "CANONICAL_REST_TOP_N" || orderPlan?.kind === "KORDER_NATIVE"
    : stmt.limit !== null && stmt.limit <= 500;
  const needed = stmt.limit === null ? null : (stmt.offset ?? 0) + stmt.limit;
  const stopAfter =
    stmt.orderBy.length === 0 &&
    needed !== null &&
    needed <= maxRecords &&
    !whereHasKlike(stmt.where)
      ? needed
      : undefined;

  // ORDER BY ありは schema-aware plan だけが REST 窓を許可する。
  // ORDER BY なしは順序契約がないため、従来どおり小さい LIMIT を単発取得できる。
  let records: KintoneRecord[];
  if (orderPlan?.kind === "KORDER_NATIVE" && stmt.limit === 0) {
    records = [];
  } else if (useRestWindow) {
    const res: KintoneGetResponse = await client.getRecords({
      app: params.app,
      query: params.query,
      fields: params.fields,
    });
    records = res.records;
  } else {
    const baseQuery = stmt.where ? whereToKintone(stmt.where) : "";
    records = await fetchAll(
      client.getRecords,
      params.app,
      baseQuery,
      fetchFields,
      {
        parallel,
        maxRecords,
        stopAfter,
        onLimit,
        onTruncate: (max) => {
          warnings.add(`取得上限（${max} 件）に達したため、${max} 件で打ち切って表示しています。`);
        },
      }
    );
  }

  let rows = records.map((r) => flatten(r, null));
  if (!useRestWindow) {
    rows = applyOrderBy(
      rows,
      stmt.orderBy,
      orderMeta.optionOrders,
      orderMeta.sortKinds,
      orderMeta.semantics
    );
    rows = applyLimit(rows, stmt.limit, stmt.offset);
  }
  const { rows: projected, columns } = project(
    rows,
    stmt.columns,
    undefined,
    fieldTypeResolvers.row,
    undefined,
    projectionSemanticsResolver
  );

  return { type: "SELECT", rows: projected, columns, rowCount: projected.length, warnings: [...warnings] };
}

async function validateSelectFieldCodes(
  stmt: SelectStatement,
  mode: SelectMode,
  client: KintoneClient,
  cacheContext: string
): Promise<void> {
  const appToFields = new Map<number, Set<string>>();
  const addFields = (appId: number, fields: string[]) => {
    if (fields.length === 0) return;
    let target = appToFields.get(appId);
    if (!target) {
      target = new Set<string>();
      appToFields.set(appId, target);
    }
    for (const f of fields) target.add(f);
  };

  if (mode === "SIMPLE") {
    const params = selectToKintoneParams(stmt);
    addFields(params.app, params.fields);
  } else {
    const tables = [stmt.from, ...stmt.joins.map((j) => j.table)].filter((t) => t.cteName === null);
    for (const table of tables) {
      addFields(table.appId, selectToFetchAllFields(stmt, table));
    }
  }

  for (const [appId, fields] of appToFields.entries()) {
    // システムフィールド（$id / _pid 等）は検証対象外のため、
    // ユーザーフィールドが 1 つもなければフィールド定義の取得自体を省く
    const userFields = [...fields].filter((f) => !isSystemLikeFieldCode(f));
    if (userFields.length === 0) continue;
    const defs = await getFieldsCached(appId, client, cacheContext);
    // フィールド定義が取得できない環境（モック等）では検証をスキップする。
    if (defs.length === 0) continue;
    const validCodes = new Set(defs.map((d) => d.code));
    const unknown = userFields.filter((f) => !validCodes.has(f));
    if (unknown.length > 0) {
      throw new Error(`ArgumentError: unknown field code(s): ${unknown.join(", ")} (APP${appId})`);
    }
  }
}

function extractMainTypedPushdownCandidate(stmt: SelectStatement): WhereExpr | null {
  if (stmt.where === null || stmt.from.subtableCode || stmt.from.cteName !== null) return null;

  if (stmt.joins.length === 0) {
    return extractTypedPushdownCandidates(stmt.where, {
      tableAlias: stmt.from.alias ?? undefined,
      allowUnqualifiedFields: true,
    });
  }

  if (!stmt.from.alias) return null;
  return extractTypedPushdownCandidates(stmt.where, { tableAlias: stmt.from.alias });
}

type FieldOptionsMap = Map<string, ReadonlySet<string>>;

interface TypedPushdownMeta {
  fieldTypesByApp: Map<number, FieldTypeMap>;
  fieldOptionsByApp: Map<number, FieldOptionsMap>;
}

async function loadTypedPushdownMeta(
  stmt: SelectStatement,
  client: KintoneClient,
  cacheContext: string
): Promise<TypedPushdownMeta> {
  const candidatesByApp = new Map<number, WhereExpr[]>();
  const addCandidate = (appId: number, candidate: WhereExpr | null): void => {
    if (candidate === null) return;
    const existing = candidatesByApp.get(appId);
    if (existing) existing.push(candidate);
    else candidatesByApp.set(appId, [candidate]);
  };
  addCandidate(stmt.from.appId, extractMainTypedPushdownCandidate(stmt));

  if (stmt.where !== null) {
    for (const join of stmt.joins) {
      if (!join.table.alias || join.table.subtableCode || join.table.cteName !== null) continue;
      const candidate = extractTypedPushdownCandidates(stmt.where, {
        tableAlias: join.table.alias,
      });
      addCandidate(join.table.appId, candidate);
    }
  }

  const entries = await Promise.all([...candidatesByApp.entries()].map(async ([appId, candidates]) => {
    const [fieldTypes, fieldOptions] = await Promise.all([
      getFieldTypeMap(appId, client, cacheContext),
      getFieldOptionSetMapByApp(appId, client, cacheContext),
    ]);
    const statusFields = collectCandidateFieldCodes(candidates)
      .filter((fieldCode) => fieldTypes.get(fieldCode) === "STATUS");
    if (statusFields.length > 0) {
      const process = await getProcessStatusesCached(appId, client, cacheContext);
      if (process.enable && process.states && process.states.length > 0) {
        const states = new Set(process.states.map((state) => state.name));
        for (const fieldCode of statusFields) fieldOptions.set(fieldCode, states);
      }
    }
    return [appId, fieldTypes, fieldOptions] as const;
  }));
  return {
    fieldTypesByApp: new Map(entries.map(([appId, fieldTypes]) => [appId, fieldTypes])),
    fieldOptionsByApp: new Map(entries.map(([appId, , fieldOptions]) => [appId, fieldOptions])),
  };
}

function collectCandidateFieldCodes(candidates: readonly WhereExpr[]): string[] {
  const fields = new Set<string>();
  const visit = (expr: WhereExpr): void => {
    if (expr.type === "BINARY") {
      if (expr.left.type === "FIELD") fields.add(expr.left.field);
      return;
    }
    if (expr.type === "LOGICAL") {
      visit(expr.left);
      visit(expr.right);
      return;
    }
    if (expr.type === "GROUP" || expr.type === "NOT") visit(expr.expr);
  };
  for (const candidate of candidates) visit(candidate);
  return [...fields];
}

/** IN / NOT IN の左辺にある直接フィールド参照を、CASE 条件を含めて収集する。 */
function collectTypedInFieldRefs(
  expr: WhereExpr | null,
  out: FieldRef[]
): void {
  if (expr === null) return;
  switch (expr.type) {
    case "BINARY":
      if ((expr.op === "IN" || expr.op === "NOT_IN") && expr.left.type === "FIELD") {
        out.push(expr.left);
      }
      if (expr.left.type === "CASE_FIELD") collectCaseTypedInFieldRefs(expr.left.expr, out);
      if (expr.right.type === "CASE_VALUE") collectCaseTypedInFieldRefs(expr.right.expr, out);
      return;
    case "LOGICAL":
      collectTypedInFieldRefs(expr.left, out);
      collectTypedInFieldRefs(expr.right, out);
      return;
    case "NOT":
    case "GROUP":
      collectTypedInFieldRefs(expr.expr, out);
      return;
    case "NULL_CHECK":
    case "EXISTS":
      return;
  }
}

function collectCaseTypedInFieldRefs(expr: CaseWhenExpr, out: FieldRef[]): void {
  for (const branch of expr.branches) collectTypedInFieldRefs(branch.condition, out);
}

function collectSelectTypedInFieldRefs(stmt: SelectStatement): FieldRef[] {
  const refs: FieldRef[] = [];
  collectTypedInFieldRefs(stmt.where, refs);
  collectTypedInFieldRefs(stmt.having, refs);
  for (const column of stmt.columns) {
    if (column.type === "CASE_COL") collectCaseTypedInFieldRefs(column.expr, refs);
  }
  return refs;
}

function findTableForAlias(stmt: SelectStatement, alias: string): TableRef | undefined {
  return [stmt.from, ...stmt.joins.map((join) => join.table)]
    .find((table) => table.alias === alias);
}

function physicalSelectTables(stmt: SelectStatement): TableRef[] {
  return [stmt.from, ...stmt.joins.map((join) => join.table)]
    .filter((table) => table.cteName === null);
}

/** 型付き IN 候補を持ち得る物理アプリだけ、既存キャッシュ経由で型を読む。 */
async function loadTypedInFieldTypes(
  stmt: SelectStatement,
  client: KintoneClient,
  cacheContext: string
): Promise<Map<number, FieldTypeMap>> {
  const refs = collectSelectTypedInFieldRefs(stmt);
  if (refs.length === 0) return new Map();

  const appIds = new Set<number>();
  const physicalTables = physicalSelectTables(stmt);
  for (const ref of refs) {
    if (ref.tableAlias !== null) {
      if (ref.tableAlias === "_p" && stmt.from.subtableCode && stmt.from.cteName === null) {
        appIds.add(stmt.from.appId);
        continue;
      }
      const table = findTableForAlias(stmt, ref.tableAlias);
      if (table && table.cteName === null) appIds.add(table.appId);
      continue;
    }
    if (stmt.joins.length === 0) {
      if (stmt.from.cteName === null) appIds.add(stmt.from.appId);
      continue;
    }
    // JOIN の非修飾参照は衝突判定に全物理テーブルの定義が必要。
    for (const table of physicalTables) appIds.add(table.appId);
  }

  const entries = await Promise.all([...appIds].map(async (appId) => (
    [appId, await getFieldTypeMap(appId, client, cacheContext)] as const
  )));
  return new Map(entries);
}

function aggregateFieldRef(field: string): FieldRef {
  const dot = field.indexOf(".");
  return dot > 0
    ? { type: "FIELD", tableAlias: field.slice(0, dot), field: field.slice(dot + 1) }
    : { type: "FIELD", tableAlias: null, field };
}

function collectAggregateRef(
  func: string,
  arg: { type: string; field?: string },
  out: FieldRef[]
): void {
  if ((func === "MIN" || func === "MAX") && arg.type === "FIELD_REF" && arg.field) {
    out.push(aggregateFieldRef(arg.field));
  }
}

function collectAggregateOperandRefs(node: AggOperand, out: FieldRef[]): void {
  if (node.type === "AGG_REF") {
    collectAggregateRef(node.func, node.arg, out);
    return;
  }
  if (node.type === "AGG_ARITH") {
    collectAggregateOperandRefs(node.left, out);
    collectAggregateOperandRefs(node.right, out);
  }
}

function collectStringFuncAggregateRefs(expr: StringFuncExpr, out: FieldRef[]): void {
  for (const arg of expr.args) {
    if (arg.type === "AGG_REF" || arg.type === "AGG_ARITH") {
      collectAggregateOperandRefs(arg, out);
    } else if (arg.type === "STRING_FUNC") {
      collectStringFuncAggregateRefs(arg, out);
    }
  }
}

function collectSelectAggregateSortRefs(columns: SelectColumn[]): FieldRef[] {
  const refs: FieldRef[] = [];
  for (const column of columns) {
    if (column.type === "AGGREGATE") {
      collectAggregateRef(column.func, column.arg, refs);
    } else if (column.type === "ARITH_AGG_COL") {
      collectAggregateOperandRefs(column.expr, refs);
    } else if (column.type === "STRFUNC_COL") {
      collectStringFuncAggregateRefs(column.expr, refs);
    }
  }
  return refs;
}

const AGGREGATE_STRING_FIELD_TYPES = new Set([
  "SINGLE_LINE_TEXT", "MULTI_LINE_TEXT", "RICH_TEXT", "LINK",
  "DROP_DOWN", "RADIO_BUTTON", "STATUS",
  "DATE", "TIME", "DATETIME", "CREATED_TIME", "UPDATED_TIME",
]);

function aggregateSortKind(info: KintoneFieldInfo): "number" | "string" | undefined {
  if (info.sortKind !== undefined) return info.sortKind;
  if (info.fieldType === "NUMBER" || info.fieldType === "RECORD_NUMBER") return "number";
  return AGGREGATE_STRING_FIELD_TYPES.has(info.fieldType) ? "string" : undefined;
}

/** MIN/MAX の直接フィールド参照だけに必要なフォーム定義を読み、集約専用resolverを返す。 */
async function loadAggregateSortKindResolver(
  stmt: SelectStatement,
  client: KintoneClient,
  cacheContext: string,
  materializedTables?: ReadonlyMap<string, MaterializedTable>
): Promise<AggregateSortKindResolver | undefined> {
  const refs = collectSelectAggregateSortRefs(stmt.columns);
  if (refs.length === 0) return undefined;

  const appIds = new Set<number>();
  const physicalTables = physicalSelectTables(stmt);
  for (const ref of refs) {
    if (ref.tableAlias !== null) {
      if (ref.tableAlias === "_p" && stmt.from.subtableCode && stmt.from.cteName === null) {
        appIds.add(stmt.from.appId);
        continue;
      }
      const table = findTableForAlias(stmt, ref.tableAlias);
      if (table && table.cteName === null) appIds.add(table.appId);
    } else if (stmt.joins.length === 0) {
      if (stmt.from.cteName === null) appIds.add(stmt.from.appId);
    } else {
      for (const table of physicalTables) appIds.add(table.appId);
    }
  }

  const fieldInfosByApp = new Map<number, Map<string, KintoneFieldInfo>>(
    await Promise.all([...appIds].map(async (appId) => {
      const infos = await getFieldsCached(appId, client, cacheContext);
      return [appId, new Map(infos.map((info) => [info.code, info]))] as const;
    }))
  );
  const statusOrdersByApp = new Map<number, ReadonlyMap<string, number>>();
  const aggregateFieldNames = new Set(refs.map((ref) => ref.field));
  await Promise.all([...fieldInfosByApp].map(async ([appId, infos]) => {
    if (![...aggregateFieldNames].some((field) => infos.get(field)?.fieldType === "STATUS")) return;
    const order = await loadProcessStatusOrder(appId, client, cacheContext);
    if (order) statusOrdersByApp.set(appId, order);
  }));
  const tables = [stmt.from, ...stmt.joins.map((join) => join.table)];

  const semanticsForInfo = (info: KintoneFieldInfo, appId: number): ResolvedFieldSemantics => {
    const base = info.semantics ?? resolveFieldSemantics(info);
    return info.fieldType === "STATUS" && statusOrdersByApp.has(appId)
      ? { ...base, optionOrder: statusOrdersByApp.get(appId) }
      : base;
  };

  return (ref) => {
    let info: KintoneFieldInfo | undefined;
    if (ref.tableAlias !== null) {
      if (ref.tableAlias === "_p" && stmt.from.subtableCode && stmt.from.cteName === null) {
        info = fieldInfosByApp.get(stmt.from.appId)?.get(ref.field);
      } else {
        const table = tables.find((candidate) => candidate.alias === ref.tableAlias);
        if (!table) return undefined;
        if (table.cteName !== null) {
          return materializedTables?.get(table.cteName)?.columnMeta?.get(ref.field)?.semantics
            ?? syntheticSemantics("string");
        }
        info = fieldInfosByApp.get(table.appId)?.get(fieldCodeForTypeLookup(table, ref.field));
      }
    } else if (stmt.joins.length === 0) {
      if (stmt.from.cteName !== null) {
        return materializedTables?.get(stmt.from.cteName)?.columnMeta?.get(ref.field)?.semantics
          ?? syntheticSemantics("string");
      }
      info = fieldInfosByApp.get(stmt.from.appId)?.get(fieldCodeForTypeLookup(stmt.from, ref.field));
    } else {
      const matches = tables.flatMap((table): Array<ResolvedFieldSemantics | undefined> => {
        if (table.cteName !== null) {
          const materialized = materializedTables?.get(table.cteName);
          return materialized?.columns.includes(ref.field)
            ? [materialized.columnMeta?.get(ref.field)?.semantics ?? syntheticSemantics("string")]
            : [];
        }
        const candidate = fieldInfosByApp.get(table.appId)?.get(fieldCodeForTypeLookup(table, ref.field));
        return candidate ? [semanticsForInfo(candidate, table.appId)] : [];
      });
      if (matches.length !== 1) return undefined;
      return matches[0];
    }
    if (!info) return undefined;
    const sourceTable = ref.tableAlias !== null
      ? tables.find((table) => table.alias === ref.tableAlias)
      : stmt.joins.length === 0 ? stmt.from : undefined;
    return semanticsForInfo(info, sourceTable?.appId ?? stmt.from.appId);
  };
}

function fieldCodeForTypeLookup(table: TableRef, field: string): string {
  if (table.subtableCode && field.startsWith("_p.")) return field.slice(3);
  return field;
}

function materializedMetaFromFieldInfo(
  info: KintoneFieldInfo,
  sourceAppId?: number
): MaterializedColumnMeta {
  const semantics = info.semantics ?? resolveFieldSemantics(info);
  return {
    sortKind: aggregateSortKind(info),
    fieldType: info.fieldType,
    semantics: sourceAppId === undefined
      ? semantics
      : withFieldSemanticSource(semantics, sourceAppId, info.code),
  };
}

/** REST top-N の同値群を FULL_SCAN の stable input ($id asc) と同じ順へ固定する。 */
function withCanonicalRestTie(stmt: SelectStatement): SelectStatement {
  const hasId = stmt.orderBy.some((item) =>
    item.key.type === "FIELD_NAME" && item.key.name === "$id"
  );
  return hasId
    ? stmt
    : {
        ...stmt,
        orderBy: [...stmt.orderBy, { key: { type: "FIELD_NAME", name: "$id" }, direction: "ASC" }],
      };
}

function syntheticColumnMeta(compareMode: "string" | "number"): MaterializedColumnMeta {
  return { sortKind: compareMode, semantics: syntheticSemantics(compareMode) };
}

/** 型が安全に合流しない式は v3 の既定で文字列とするが、Phase 2 では既存 sortKind を変えない。 */
function unknownStringColumnMeta(): MaterializedColumnMeta {
  return { semantics: syntheticSemantics("string", "KSQL_UNKNOWN") };
}

function unsupportedColumnMeta(fieldType = "KSQL_ARRAY"): MaterializedColumnMeta {
  return {
    semantics: { fieldType, compareMode: "unsupported", inSubtable: false, requiresCollectionOperators: false },
  };
}

function systemColumnMeta(field: string): MaterializedColumnMeta | undefined {
  if (field === "$id" || field === "_rid" || field === "_pid") {
    return {
      sortKind: "number",
      fieldType: "__ID__",
      semantics: resolveFieldSemantics({ fieldType: "__ID__" }),
    };
  }
  if (field === "$revision") return syntheticColumnMeta("number");
  return undefined;
}

const NUMBER_RETURNING_STRING_FUNCTIONS = new Set([
  "LENGTH", "INSTR", "ROUND", "FLOOR", "CEIL", "TRUNCATE",
  "YEAR", "MONTH", "DAY", "DATEDIFF", "ABS", "MOD", "POWER", "SQRT",
]);

function stringFunctionColumnMeta(expr: StringFuncExpr): MaterializedColumnMeta {
  if (expr.func === "CAST") {
    const target = expr.args[1];
    return target?.type === "STRING" && target.value === "NUMBER"
      ? syntheticColumnMeta("number")
      : syntheticColumnMeta("string");
  }
  return NUMBER_RETURNING_STRING_FUNCTIONS.has(expr.func)
    ? syntheticColumnMeta("number")
    : syntheticColumnMeta("string");
}

function caseResultColumnMeta(
  result: CaseResult,
  resolveField: (ref: FieldRef) => MaterializedColumnMeta | undefined
): MaterializedColumnMeta {
  if (result.type === "STRING") return syntheticColumnMeta("string");
  if (result.type === "ARRAY") return unsupportedColumnMeta();
  if (result.type === "NUMBER" || result.type === "ARITH") return syntheticColumnMeta("number");
  if (result.type === "STRING_FUNC") return stringFunctionColumnMeta(result);
  const source = resolveField(aggregateFieldRef(result.field));
  return source ?? unknownStringColumnMeta();
}

function mergeExpressionColumnMeta(
  candidates: readonly MaterializedColumnMeta[]
): MaterializedColumnMeta {
  if (candidates.length === 0) return unknownStringColumnMeta();
  const first = candidates[0];
  const withoutSource = (semantics: ResolvedFieldSemantics | undefined): ResolvedFieldSemantics | undefined => {
    if (!semantics) return undefined;
    const { source: _source, ...rest } = semantics;
    return rest;
  };
  if (candidates.every((candidate) =>
    candidate.sortKind === first.sortKind
    && candidate.fieldType === first.fieldType
    && fieldSemanticsEqual(withoutSource(candidate.semantics), withoutSource(first.semantics))
  )) {
    const sameSource = candidates.every((candidate) =>
      fieldSemanticsEqual(candidate.semantics, first.semantics)
    );
    return sameSource ? first : { ...first, semantics: withoutSource(first.semantics) };
  }
  if (candidates.some((candidate) => candidate.semantics?.compareMode === "unsupported")) {
    return unsupportedColumnMeta("KSQL_MIXED_UNSUPPORTED");
  }
  return unknownStringColumnMeta();
}

function selectNeedsSourceColumnMeta(stmt: SelectStatement): boolean {
  return stmt.columns.some((column) =>
    column.type === "FIELD"
    || column.type === "WILDCARD"
    || column.type === "PARENT_WILDCARD"
    || column.type === "CASE_COL"
    || (column.type === "AGGREGATE"
      && (column.func === "MIN" || column.func === "MAX")
      && column.arg.type === "FIELD_REF")
  );
}

async function inferSelectColumnMeta(
  stmt: SelectStatement,
  outputColumns: readonly string[],
  client: KintoneClient,
  cacheContext: string,
  materializedTables?: ReadonlyMap<string, MaterializedTable>
): Promise<MaterializedColumnMetaMap> {
  const physicalInfos = new Map<number, Map<string, KintoneFieldInfo>>();
  if (selectNeedsSourceColumnMeta(stmt)) {
    await Promise.all(physicalSelectTables(stmt).map(async (table) => {
      if (physicalInfos.has(table.appId)) return;
      const infos = await getFieldsCached(table.appId, client, cacheContext);
      physicalInfos.set(table.appId, new Map(infos.map((info) => [info.code, info])));
    }));
  }

  const tables = [stmt.from, ...stmt.joins.map((join) => join.table)];
  const resolveField = (ref: FieldRef): MaterializedColumnMeta | undefined => {
    if (ref.tableAlias !== null) {
      if (ref.tableAlias === "_p" && stmt.from.subtableCode && stmt.from.cteName === null) {
        const info = physicalInfos.get(stmt.from.appId)?.get(ref.field);
        return info ? materializedMetaFromFieldInfo(info, stmt.from.appId) : undefined;
      }
      const table = tables.find((candidate) => candidate.alias === ref.tableAlias);
      if (!table) return undefined;
      if (table.cteName !== null) return materializedTables?.get(table.cteName)?.columnMeta?.get(ref.field);
      const info = physicalInfos.get(table.appId)?.get(fieldCodeForTypeLookup(table, ref.field));
      return info ? materializedMetaFromFieldInfo(info, table.appId) : systemColumnMeta(ref.field);
    }

    if (stmt.joins.length === 0) {
      if (stmt.from.cteName !== null) return materializedTables?.get(stmt.from.cteName)?.columnMeta?.get(ref.field);
      const info = physicalInfos.get(stmt.from.appId)?.get(fieldCodeForTypeLookup(stmt.from, ref.field));
      return info ? materializedMetaFromFieldInfo(info, stmt.from.appId) : systemColumnMeta(ref.field);
    }

    const matches = tables.flatMap((table): Array<MaterializedColumnMeta | undefined> => {
      if (table.cteName !== null) {
        const materialized = materializedTables?.get(table.cteName);
        if (!materialized?.columns.includes(ref.field)) return [];
        return [materialized.columnMeta?.get(ref.field)];
      }
      const info = physicalInfos.get(table.appId)?.get(fieldCodeForTypeLookup(table, ref.field));
      const meta = info ? materializedMetaFromFieldInfo(info, table.appId) : systemColumnMeta(ref.field);
      return meta ? [meta] : [];
    });
    return matches.length === 1 ? matches[0] : undefined;
  };

  const inferred = new Map<string, MaterializedColumnMeta>();
  const hasWildcard = stmt.columns.some((column) => column.type === "WILDCARD" || column.type === "PARENT_WILDCARD");

  if (stmt.columns.length === 1
    && (stmt.columns[0].type === "WILDCARD" || stmt.columns[0].type === "PARENT_WILDCARD")) {
    for (const output of outputColumns) {
      const meta = resolveField(aggregateFieldRef(output));
      if (meta) inferred.set(output, meta);
    }
    return inferred;
  }

  if (hasWildcard) {
    // ワイルドカード展開済みの実列名だけを解決する。別名・計算列は下の明示列処理で補う。
    for (const output of outputColumns) {
      const meta = resolveField(aggregateFieldRef(output));
      if (meta) inferred.set(output, meta);
    }
  }

  const explicitColumns = stmt.columns.filter(
    (column) => column.type !== "WILDCARD" && column.type !== "PARENT_WILDCARD"
  );
  explicitColumns.forEach((column, index) => {
      const output = hasWildcard
        ? ("alias" in column && column.alias ? column.alias : undefined)
        : outputColumns[index];
      if (!output) return;
      let meta: MaterializedColumnMeta | undefined;
      if (column.type === "FIELD") {
        meta = resolveField(aggregateFieldRef(column.field));
      } else if (column.type === "AGGREGATE") {
        if (column.func === "GROUP_CONCAT") {
          meta = syntheticColumnMeta("string");
        } else if (column.func === "COUNT" || column.func === "SUM" || column.func === "AVG") {
          meta = syntheticColumnMeta("number");
        } else if ((column.func === "MIN" || column.func === "MAX") && column.arg.type === "FIELD_REF") {
          const source = resolveField(aggregateFieldRef(column.arg.field));
          if (source) meta = source;
        }
      } else if (column.type === "ARITH_AGG_COL" || column.type === "ARITH_COL") {
        meta = syntheticColumnMeta("number");
      } else if (column.type === "LITERAL_COL") {
        meta = syntheticColumnMeta("string");
      } else if (column.type === "STRFUNC_COL") {
        meta = stringFunctionColumnMeta(column.expr);
      } else if (column.type === "WINDOW_COL") {
        meta = syntheticColumnMeta("number");
      } else if (column.type === "CASE_COL") {
        const results = column.expr.branches.map((branch) => caseResultColumnMeta(branch.result, resolveField));
        if (column.expr.elseResult) results.push(caseResultColumnMeta(column.expr.elseResult, resolveField));
        meta = mergeExpressionColumnMeta(results);
      } else if (column.type === "SCALAR_SUBQUERY_COL") {
        // サブクエリの実行値は後段で解決される。安全に型を証明できないため既定の文字列意味型を付ける。
        meta = unknownStringColumnMeta();
      }
      if (meta) inferred.set(output, meta);
    });
  return inferred;
}

function mergeUnionColumnMeta(left: SelectResult, right: SelectResult): MaterializedColumnMetaMap {
  const leftMeta = materializedMetaBySelectResult.get(left);
  const rightMeta = materializedMetaBySelectResult.get(right);
  const merged = new Map<string, MaterializedColumnMeta>();
  left.columns.forEach((column, index) => {
    const a = leftMeta?.get(column);
    const rightColumn = right.columns[index];
    const b = rightColumn === undefined ? undefined : rightMeta?.get(rightColumn);
    if (a && b) merged.set(column, mergeExpressionColumnMeta([a, b]));
    else if (a || b) merged.set(column, unknownStringColumnMeta());
  });
  return merged;
}

interface SelectFieldTypeResolvers {
  row: FieldTypeResolver;
  having: FieldTypeResolver;
}

/** AST の FieldRef を物理テーブルへ安全に結び付ける resolver を構築する。 */
function buildSelectFieldTypeResolvers(
  stmt: SelectStatement,
  fieldTypesByApp: ReadonlyMap<number, FieldTypeMap>
): SelectFieldTypeResolvers {
  const tables = [stmt.from, ...stmt.joins.map((join) => join.table)];
  const physicalTables = tables.filter((table) => table.cteName === null);
  const outputAliases = new Set(
    stmt.columns
      .map((column) => ("alias" in column ? column.alias : null))
      .filter((alias): alias is string => alias !== null)
  );

  const row: FieldTypeResolver = (field) => {
    if (field.tableAlias !== null) {
      if (field.tableAlias === "_p" && stmt.from.subtableCode && stmt.from.cteName === null) {
        return fieldTypesByApp.get(stmt.from.appId)?.get(field.field);
      }
      const table = tables.find((candidate) => candidate.alias === field.tableAlias);
      if (!table || table.cteName !== null) return undefined;
      return fieldTypesByApp.get(table.appId)?.get(fieldCodeForTypeLookup(table, field.field));
    }

    if (stmt.joins.length === 0) {
      if (stmt.from.cteName !== null) return undefined;
      return fieldTypesByApp.get(stmt.from.appId)?.get(fieldCodeForTypeLookup(stmt.from, field.field));
    }

    // CTE は列型来歴を持たないため、混在 JOIN の非修飾参照は一意と証明できない。
    if (tables.some((table) => table.cteName !== null)) return undefined;
    const matches = physicalTables.filter((table) =>
      fieldTypesByApp.get(table.appId)?.has(fieldCodeForTypeLookup(table, field.field))
    );
    if (matches.length !== 1) return undefined;
    const table = matches[0];
    return fieldTypesByApp.get(table.appId)?.get(fieldCodeForTypeLookup(table, field.field));
  };

  const having: FieldTypeResolver = (field) => {
    if (field.tableAlias === null && outputAliases.has(field.field)) return undefined;
    return row(field);
  };
  return { row, having };
}

/** FULL_SCAN モード: 全テーブルを fetchAll → runFullScan パイプライン */
async function executeFullScanSelect(
  stmt: SelectStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  cteCache?: Map<string, MaterializedTable>,
  allowOriginalWherePushdown = true,
  preloadedOrderMeta?: OrderByMeta
): Promise<SelectResult> {
  const maxRecords = options.maxRecords ?? 10_000;
  const warnings = new Set<string>();
  const parallel = options.fetchParallel ?? 1;

  // サブクエリを事前実行（IN (SELECT ...) の値セットを解決）
  await Promise.all([
    resolveSubqueries(stmt.where,  client, options, cacheContext, cteCache),
    resolveSubqueries(stmt.having, client, options, cacheContext, cteCache),
  ]);

  // 一般 NUMBER 比較または選択系 IN 候補がある物理アプリだけ、押し下げ用メタを取得する。
  // typedInFieldTypes は最終 JS 評価用で役割が異なるため、統合しない。
  const [pushdownMeta, typedInFieldTypes, aggregateSortKindResolver] = await Promise.all([
    loadTypedPushdownMeta(stmt, client, cacheContext),
    loadTypedInFieldTypes(stmt, client, cacheContext),
    loadAggregateSortKindResolver(stmt, client, cacheContext, cteCache),
  ]);
  const fieldTypeResolvers = buildSelectFieldTypeResolvers(stmt, typedInFieldTypes);
  const fieldSemanticsResolver = await buildWhereFieldSemanticsResolver(
    stmt,
    client,
    cacheContext,
    cteCache,
    whereNeedsFieldMetadata(stmt.having) || selectCaseConditionsNeedFieldMetadata(stmt)
  );
  const havingFieldSemanticsResolver = buildHavingFieldSemanticsResolver(stmt, fieldSemanticsResolver);

  // 同じ計画を検証・fetch・JS 評価で共有する。
  const pushdownPlan = buildKlikePushdownPlan(stmt, pushdownMeta);
  validateKlikePushdownPlan(pushdownPlan);
  const mainPushDown = pushdownPlan.mainCondition;
  const tableConditions = pushdownPlan.joinConditions;

  // メインテーブルのフェッチを開始（await しない）
  const mainFetch = fetchTableRecordsForFullScan(
    stmt,
    stmt.from,
    client,
    maxRecords,
    parallel,
    true,
    options.onLimitReached ?? "error",
    warnings,
    mainPushDown,
    allowOriginalWherePushdown
  );

  // JOIN テーブルを push-down の有無で振り分け
  //   push-down あり → 案1: ON 最適化スキップ、案2: メインと並列フェッチ開始
  //   push-down なし → メイン完了後に ON 最適化（従来通り）
  type JoinEntry = { join: (typeof stmt.joins)[number]; promise: Promise<KintoneRecord[]> };
  const parallelJoins: JoinEntry[] = [];
  const onOptJoins: (typeof stmt.joins) = [];

  for (const join of stmt.joins) {
    const jCond = join.table.alias ? (tableConditions.get(join.table.alias) ?? null) : null;
    if (jCond !== null) {
      parallelJoins.push({
        join,
        promise: fetchTableRecordsForFullScan(
          stmt,
          join.table,
          client,
          maxRecords,
          parallel,
          false,
          options.onLimitReached ?? "error",
          warnings,
          jCond
        ),
      });
    } else {
      onOptJoins.push(join);
    }
  }

  // フィールド定義・スカラーサブクエリはレコード取得と並行して解決する
  // （レコードに依存しないため、フェッチ完了を待つ必要がない）
  const scalarCachePromise = resolveScalarColumns(stmt.columns, client, options, cacheContext, cteCache);
  const orderByMetaPromise = preloadedOrderMeta
    ? Promise.resolve(preloadedOrderMeta)
    : buildOrderByMetaForSelect(stmt, client, cacheContext, cteCache);
  scalarCachePromise.catch(() => { /* 後段の await で再スロー（未処理拒否の抑止のみ） */ });
  orderByMetaPromise.catch(() => { /* 同上 */ });

  // メインテーブルの完了を待つ
  const mainRecords = await mainFetch;
  const tables = new Map<string | null, KintoneRecord[]>();
  tables.set(stmt.from.alias, mainRecords);

  // 並列フェッチ済み JOIN テーブルを回収
  for (const { join, promise } of parallelJoins) {
    tables.set(join.table.alias, await promise);
  }

  // ON 最適化が必要な JOIN テーブルを処理（メイン取得後）
  await Promise.all(onOptJoins.map(async (join) => {
    const optimized = await tryFetchJoinRecordsBySourceKeys(
      stmt,
      join,
      tables,
      client,
      maxRecords,
      parallel,
      options.onLimitReached ?? "error",
      warnings,
      null
    );
    const joinRecords = optimized ?? await fetchTableRecordsForFullScan(
      stmt,
      join.table,
      client,
      maxRecords,
      parallel,
      false,
      options.onLimitReached ?? "error",
      warnings,
      null
    );
    tables.set(join.table.alias, joinRecords);
  }));

  // 並行解決していたスカラーサブクエリ・ORDER BY メタ情報を回収
  const scalarCache = await scalarCachePromise;
  const { optionOrders, sortKinds, semantics } = await orderByMetaPromise;

  // JS 集計パイプライン
  const { rows, columns } = runFullScan({
    tables,
    stmt,
    scalarCache,
    optionOrders,
    sortKinds,
    orderSemantics: semantics,
    fieldTypeResolver: fieldTypeResolvers.row,
    fieldSemanticsResolver,
    havingFieldTypeResolver: fieldTypeResolvers.having,
    havingFieldSemanticsResolver,
    aggregateSortKindResolver,
    appliedKlikes: pushdownPlan.appliedKlikes,
  });

  return { type: "SELECT", rows, columns, rowCount: rows.length, warnings: [...warnings] };
}

// ============================================================
// UNION / UNION ALL
// ============================================================

async function executeUnion(
  stmt: UnionStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string
): Promise<SelectResult> {
  // 左辺（ネストした UNION 対応）と右辺を並列実行
  const [leftResult, rightResult] = await Promise.all([
    stmt.left.type === "UNION"
      ? executeUnion(stmt.left, client, options, cacheContext)
      : executeSelect(stmt.left, client, options, cacheContext),
    executeSelect(stmt.right, client, options, cacheContext),
  ]);

  // 右辺の行を左辺のカラム名に位置対応でリマップ
  const leftCols  = leftResult.columns;
  const rightCols = rightResult.columns;
  const remappedRight = rightResult.rows.map((row) => {
    const mapped: ProcessRow = {};
    leftCols.forEach((col, i) => {
      mapped[col] = row[rightCols[i] ?? col] ?? "";
    });
    return mapped;
  });

  const combined = [...leftResult.rows, ...remappedRight];

  // UNION（重複排除）vs UNION ALL（そのまま）
  const rows = stmt.all ? combined : deduplicateRows(combined, leftCols);

  return { type: "SELECT", rows, columns: leftCols, rowCount: rows.length };
}

/** 行の重複を取り除く（すべてのカラム値が等しい行を1件に） */
function deduplicateRows(rows: ProcessRow[], columns: string[]): ProcessRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    // JSON.stringify で結合し、値に区切り文字を含む場合の誤同一視を防ぐ
    const key = JSON.stringify(columns.map((c) => row[c] ?? ""));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ============================================================
// WITH 句（CTE）
// ============================================================

async function executeWith(
  stmt: WithStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  /** バッチ実行時の一時テーブルストア（#name → 行＋列）。CTE キャッシュの初期値として合流する */
  seed?: ReadonlyMap<string, MaterializedTable>,
  captureColumnMeta = false
): Promise<SelectResult> {
  // 単純 CTE のインライン化（WHERE プッシュダウン最適化）
  // CTE 本体が SIMPLE モードで最終クエリが単純 SELECT の場合、
  // CTE を展開して WHERE をまとめて REST API に渡す。
  // 一時テーブル注入時はインライン化しない（CTE 本体が #temp を参照し得るため）
  if ((seed == null || seed.size === 0) && canInlineSingleCte(stmt)) {
    return executeSelect(buildInlinedQuery(stmt), client, options, cacheContext, undefined, captureColumnMeta);
  }

  // CTE 名 → 実体化結果のキャッシュ（一時テーブル名は # 付きのため CTE 名と衝突しない）
  const cteCache = new Map<string, MaterializedTable>(seed ?? []);

  // 各 CTE を順番に実行し、結果をキャッシュ
  for (const cte of stmt.ctes) {
    let result: SelectResult;
    if (cte.query.type === "SHOW_APPS") {
      result = await executeShowApps(client);
    } else if (cte.query.type === "DESCRIBE") {
      result = await executeDescribe(cte.query, client, cacheContext);
    } else {
      result = await executeQueryWithCte(cte.query, client, options, cteCache, cacheContext, true);
    }
    cteCache.set(cte.name, {
      rows: result.rows,
      columns: result.columns,
      columnMeta: materializedMetaBySelectResult.get(result),
    });
  }

  // 最終クエリを CTE キャッシュ付きで実行
  return executeQueryWithCte(stmt.query, client, options, cteCache, cacheContext, captureColumnMeta);
}

/**
 * SelectStatement | UnionStatement を CTE キャッシュ付きで実行する。
 * FROM / JOIN が CTE 参照を含む場合は FULL_SCAN モードで CTE 行を注入する。
 */
async function executeQueryWithCte(
  query: SelectStatement | UnionStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cteCache: Map<string, MaterializedTable>,
  cacheContext: string,
  captureColumnMeta = false
): Promise<SelectResult> {
  if (query.type === "UNION") {
    const [leftResult, rightResult] = await Promise.all([
      executeQueryWithCte(query.left,  client, options, cteCache, cacheContext, captureColumnMeta),
      executeQueryWithCte(query.right, client, options, cteCache, cacheContext, captureColumnMeta),
    ]);
    const leftCols    = leftResult.columns;
    const rightCols   = rightResult.columns;
    const remapped    = rightResult.rows.map((row) => {
      const mapped: ProcessRow = {};
      leftCols.forEach((col, i) => { mapped[col] = row[rightCols[i] ?? col] ?? ""; });
      return mapped;
    });
    const combined = [...leftResult.rows, ...remapped];
    const rows = query.all ? combined : deduplicateRows(combined, leftCols);
    const result: SelectResult = { type: "SELECT", rows, columns: leftCols, rowCount: rows.length };
    if (captureColumnMeta) {
      materializedMetaBySelectResult.set(result, mergeUnionColumnMeta(leftResult, rightResult));
    }
    return result;
  }

  // CTE 参照が FROM か JOIN に含まれるか確認
  const hasCteRef =
    (
      query.from.cteName != null &&
      query.from.cteName !== NO_FROM_CTE_NAME
    ) ||
    query.joins.some((j) => j.table.cteName != null);

  if (!hasCteRef) {
    // トップレベルに CTE 参照なし → 通常の SELECT 実行。
    // ただしサブクエリ内の CTE / 一時テーブル参照があり得るため cteCache は引き継ぐ
    return executeSelect(query, client, options, cacheContext, cteCache, captureColumnMeta);
  }

  // CTE 参照あり → FULL_SCAN で CTE 行を注入
  const result = await executeFullScanWithCte(query, client, options, cteCache, cacheContext);
  if (captureColumnMeta) {
    materializedMetaBySelectResult.set(result, await inferSelectColumnMeta(query, result.columns, client, cacheContext, cteCache));
  }
  return result;
}

/**
 * FROM / JOIN に CTE 参照を含む SELECT を FULL_SCAN モードで実行する。
 * CTE 行は ProcessRow[] → KintoneRecord[] に変換して runFullScan に渡し、
 * JOIN なしの単一実体化ソースでは保存列も sourceColumns として渡す。
 */
async function executeFullScanWithCte(
  stmt: SelectStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cteCache: Map<string, MaterializedTable>,
  cacheContext: string
): Promise<SelectResult> {
  const maxRecords = options.maxRecords ?? 10_000;
  const warnings = new Set<string>();
  const parallel = options.fetchParallel ?? 1;

  // サブクエリを事前実行（サブクエリ内の CTE / 一時テーブル参照にも cteCache を引き継ぐ）
  await Promise.all([
    resolveSubqueries(stmt.where,  client, options, cacheContext, cteCache),
    resolveSubqueries(stmt.having, client, options, cacheContext, cteCache),
    resolveSelectCaseSubqueries(stmt, client, options, cacheContext, cteCache),
  ]);
  const whereCapability = await resolveSelectWhereCapability(stmt, client, cacheContext, cteCache);
  if (whereCapability.capability === "UNSUPPORTED") {
    throw new Error(`ArgumentError: WHERE predicate is unsupported (${formatWhereCapabilityFailure(whereCapability)}).`);
  }
  const orderMeta = await buildOrderByMetaForSelect(stmt, client, cacheContext, cteCache);
  if (hasCanonicalOrder(stmt)) {
    (stmt.orderMode === "KINTONE_NATIVE" ? planKorderNative : planCanonicalOrder)({
      stmt,
      staticMode: "FULL_SCAN",
      whereCapability: whereCapability.capability,
      orderSemantics: orderMeta.semantics,
      maxRecords,
      hasKlike: whereHasKlike(stmt.where),
    });
  }

  const [pushdownMeta, typedInFieldTypes, aggregateSortKindResolver] = await Promise.all([
    loadTypedPushdownMeta(stmt, client, cacheContext),
    loadTypedInFieldTypes(stmt, client, cacheContext),
    loadAggregateSortKindResolver(stmt, client, cacheContext, cteCache),
  ]);
  const fieldTypeResolvers = buildSelectFieldTypeResolvers(stmt, typedInFieldTypes);
  const fieldSemanticsResolver = await buildWhereFieldSemanticsResolver(
    stmt,
    client,
    cacheContext,
    cteCache,
    whereNeedsFieldMetadata(stmt.having) || selectCaseConditionsNeedFieldMetadata(stmt)
  );
  const havingFieldSemanticsResolver = buildHavingFieldSemanticsResolver(stmt, fieldSemanticsResolver);
  const pushdownPlan = buildKlikePushdownPlan(stmt, pushdownMeta);
  validateKlikePushdownPlan(pushdownPlan);

  // フィールド定義・スカラーサブクエリはレコード取得と並行して解決する
  const scalarCachePromise = resolveScalarColumns(stmt.columns, client, options, cacheContext, cteCache);
  const orderByMetaPromise = Promise.resolve(orderMeta);
  scalarCachePromise.catch(() => { /* 後段の await で再スロー（未処理拒否の抑止のみ） */ });
  orderByMetaPromise.catch(() => { /* 同上 */ });

  const tables = new Map<string | null, KintoneRecord[]>();

  // メインテーブル取得
  if (stmt.from.cteName != null) {
    const table = cteCache.get(stmt.from.cteName);
    tables.set(stmt.from.alias, (table?.rows ?? []).map(processRowToKintoneRecord));
  } else {
    const mainRecords = await fetchTableRecordsForFullScan(
      stmt,
      stmt.from,
      client,
      maxRecords,
      parallel,
      true,
      options.onLimitReached ?? "error",
      warnings,
      pushdownPlan.mainCondition,
      whereCapability.capability === "EXACT_PUSHDOWN"
    );
    tables.set(stmt.from.alias, mainRecords);
  }

  // JOIN テーブル取得
  const joinFetches = stmt.joins.map(async (join) => {
    if (join.table.cteName != null) {
      const table = cteCache.get(join.table.cteName);
      tables.set(join.table.alias, (table?.rows ?? []).map(processRowToKintoneRecord));
    } else {
      const pushDownCond = join.table.alias
        ? (pushdownPlan.joinConditions.get(join.table.alias) ?? null)
        : null;
      const optimized = await tryFetchJoinRecordsBySourceKeys(
        stmt,
        join,
        tables,
        client,
        maxRecords,
        parallel,
        options.onLimitReached ?? "error",
        warnings,
        pushDownCond
      );
      const joinRecords = optimized ?? await fetchTableRecordsForFullScan(
        stmt,
        join.table,
        client,
        maxRecords,
        parallel,
        false,
        options.onLimitReached ?? "error",
        warnings,
        pushDownCond
      );
      tables.set(join.table.alias, joinRecords);
    }
  });
  await Promise.all(joinFetches);

  const scalarCache = await scalarCachePromise;
  const { optionOrders, sortKinds, semantics } = await orderByMetaPromise;
  const sourceColumns = stmt.joins.length === 0 && stmt.from.cteName != null
    ? cteCache.get(stmt.from.cteName)?.columns
    : undefined;
  const { rows, columns } = runFullScan({
    tables,
    stmt,
    scalarCache,
    optionOrders,
    sortKinds,
    orderSemantics: semantics,
    fieldTypeResolver: fieldTypeResolvers.row,
    fieldSemanticsResolver,
    havingFieldTypeResolver: fieldTypeResolvers.having,
    havingFieldSemanticsResolver,
    aggregateSortKindResolver,
    appliedKlikes: pushdownPlan.appliedKlikes,
    sourceColumns,
  });
  return { type: "SELECT", rows, columns, rowCount: rows.length, warnings: [...warnings] };
}

/** ProcessRow → KintoneRecord（すべての値を string として保持） */
function processRowToKintoneRecord(row: ProcessRow): KintoneRecord {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k, { value: v ?? "" }])
  );
}

async function fetchTableRecordsForFullScan(
  stmt: SelectStatement,
  table: TableRef,
  client: KintoneClient,
  maxRecords: number,
  parallel: number,
  isMainTable: boolean,
  onLimit: "error" | "truncate",
  warnings: Set<string>,
  pushDownCond: WhereExpr | null = null,
  allowOriginalWherePushdown = true
): Promise<KintoneRecord[]> {
  const fields = selectToFetchAllFields(stmt, table);
  const onTruncate = (max: number): void => {
    warnings.add(`取得上限（${max} 件）に達したため、${max} 件で打ち切って表示しています。`);
  };
  if (!table.subtableCode) {
    const baseQuery = isMainTable && allowOriginalWherePushdown
      ? selectToFetchAllParams(stmt, table.appId).query
      : "";
    const pushQuery = pushDownCond !== null ? whereToKintone(pushDownCond) : "";
    const query = baseQuery && pushQuery
      ? `(${baseQuery}) and (${pushQuery})`
      : baseQuery || pushQuery;
    const resolved = await fetchRecordsForSharedPlan(client.getRecords, table.appId, query, fields, {
      parallel,
      maxRecords,
      onLimit,
      onTruncate,
    });
    return resolved.records;
  }

  // サブテーブル仮想テーブルは親レコードを取得して展開する
  const parentQuery = isMainTable ? "" : "";
  const parentResolved = await fetchRecordsForSharedPlan(client.getRecords, table.appId, parentQuery, fields, {
    parallel,
    maxRecords,
    onLimit,
    onTruncate,
  });
  const parentRecords = parentResolved.records;
  return expandSubtableRecords(parentRecords, table.subtableCode);
}

// ============================================================
// UPSERT 既存判定の一括解決
//
// 従来は 1 行ごとに GET を発行していた（N+1）。キー値を in (...) で
// 50 件ずつまとめて取得し、「キー値 → 最大 $id」の索引を先に構築する。
// ============================================================

const UPSERT_IN_CHUNK_SIZE = 50;

interface UpsertTargetIndex {
  /** キー値そのまま → 最大 $id */
  raw: Map<string, number>;
  /** 数値正規化済みキー（"5.0" と "5" を同一視）→ 最大 $id */
  normalized: Map<string, number>;
  /** キー成分ごとに数値正規化を適用するか（NUMBER フィールドのみ true） */
  numericKey: boolean[];
}

/** 数値として解釈できるキー成分は正規形に揃える（数値フィールドの表記ゆれ対策） */
function normalizeKeyPart(v: string): string {
  const t = v.trim();
  if (t !== "" && !Number.isNaN(Number(t))) return String(Number(t));
  return v;
}

// 複合キーは JSON.stringify で結合する（値に区切り文字を含む場合の衝突を防ぐ）
function upsertCompositeKey(parts: string[]): string {
  return JSON.stringify(parts);
}

function upsertNormalizedKey(parts: string[], numericKey: boolean[]): string {
  return JSON.stringify(parts.map((p, i) => (numericKey[i] ? normalizeKeyPart(p) : p)));
}

/**
 * 行キーに対応する既存レコード $id を索引から引く。
 * 完全一致を優先し、NUMBER フィールドのキーに限り数値正規化でフォールバックする
 * （テキストフィールドの "001" と "1" を誤同一視しないため）。
 */
function lookupUpsertTarget(index: UpsertTargetIndex, keyParts: string[]): number | undefined {
  const exact = index.raw.get(upsertCompositeKey(keyParts));
  if (exact !== undefined) return exact;
  if (!index.numericKey.some(Boolean)) return undefined;
  return index.normalized.get(upsertNormalizedKey(keyParts, index.numericKey));
}

/**
 * UPSERT 対象行のキー値をまとめて検索し、既存レコードの索引を構築する。
 *
 * - 第 1 キーを in (...) で 50 件ずつチャンク検索し、複合キーの残りは
 *   取得レコードの値で照合する（索引キーに全成分を含める）
 * - 空文字を含むキーは in (...) にまとめられないため従来どおり行ごとに検索
 * - キーが複数レコードにヒットした場合は最大 $id（最新）を採用
 * - 数値正規化フォールバックは fieldType が NUMBER のキーのみ有効
 */
async function resolveUpsertTargets(
  appId: number,
  keyFields: string[],
  rowKeyValues: string[][],
  client: KintoneClient,
  options: ExecuteOptions,
  fieldTypes: FieldTypeMap
): Promise<UpsertTargetIndex> {
  const maxRecords = options.maxRecords ?? 10_000;
  const parallel = options.fetchParallel ?? 1;
  const numericKey = keyFields.map((f) => fieldTypes.get(f) === "NUMBER");
  const index: UpsertTargetIndex = { raw: new Map(), normalized: new Map(), numericKey };

  const setMax = (map: Map<string, number>, key: string, id: number): void => {
    const cur = map.get(key);
    if (cur === undefined || id > cur) map.set(key, id);
  };
  const addRecordToIndex = (parts: string[], id: number): void => {
    setMax(index.raw, upsertCompositeKey(parts), id);
    if (numericKey.some(Boolean)) {
      setMax(index.normalized, upsertNormalizedKey(parts, numericKey), id);
    }
  };

  // ユニークなキー組を「in (...) でまとめられる行」と「行ごと検索の行」に振り分け
  const batchFirstKeys = new Set<string>();
  const perRowKeys: string[][] = [];
  const seen = new Set<string>();
  for (const parts of rowKeyValues) {
    const composite = upsertCompositeKey(parts);
    if (seen.has(composite)) continue;
    seen.add(composite);
    if (parts.some((p) => p === "")) perRowKeys.push(parts);
    else batchFirstKeys.add(parts[0]);
  }

  // 第 1 キーの in (...) チャンク検索
  const fields = ["$id", ...keyFields];
  for (const chunk of splitChunks([...batchFirstKeys], UPSERT_IN_CHUNK_SIZE)) {
    const query = `${keyFields[0]} in (${chunk.map(sqlQuote).join(",")})`;
    const records = await fetchAll(client.getRecords, appId, query, fields, { maxRecords, parallel });
    for (const rec of records) {
      const id = Number(rec["$id"]?.value);
      if (!Number.isFinite(id)) continue;
      addRecordToIndex(keyFields.map((f) => toScalarText(rec[f]?.value)), id);
    }
  }

  // 空文字キーを含む行は従来どおり行ごとに検索
  for (const parts of perRowKeys) {
    const query = keyFields.map((f, i) => `${f} = ${sqlQuote(parts[i])}`).join(" and ");
    const existing = await fetchAll(client.getRecords, appId, query, ["$id"], { maxRecords, parallel });
    if (existing.length === 0) continue;
    addRecordToIndex(parts, maxRecordId(existing));
  }

  return index;
}

/**
 * UPSERT の既存判定でキーが複数レコードにヒットした場合、最大 $id（最新レコード）を
 * 更新対象に選ぶ。fetchAll のページングが $id 昇順になっても挙動が変わらないよう
 * 明示的に選択する。
 */
function maxRecordId(records: KintoneRecord[]): number {
  let max = Number.NEGATIVE_INFINITY;
  for (const r of records) {
    const n = Number(r["$id"]?.value);
    if (Number.isFinite(n) && n > max) max = n;
  }
  if (!Number.isFinite(max)) {
    throw new Error("レコードに数値の $id が含まれていません。");
  }
  return max;
}

function toScalarText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

function sqlQuote(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function splitChunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const JOIN_IN_CHUNK_SIZE = 50;
const JOIN_IN_MAX_CHUNKS = 6;
const JOIN_IN_MAX_KEYS = JOIN_IN_CHUNK_SIZE * JOIN_IN_MAX_CHUNKS;

async function tryFetchJoinRecordsBySourceKeys(
  stmt: SelectStatement,
  join: SelectStatement["joins"][number],
  tables: Map<string | null, KintoneRecord[]>,
  client: KintoneClient,
  maxRecords: number,
  parallel: number,
  onLimit: "error" | "truncate",
  warnings: Set<string>,
  pushDownCond: WhereExpr | null = null
): Promise<KintoneRecord[] | null> {
  if (join.type !== "INNER") return null;
  if (!join.table.alias) return null;
  if (join.table.subtableCode) return null;

  const leftAlias = join.on.left.tableAlias;
  const rightAlias = join.on.right.tableAlias;
  if (!leftAlias || !rightAlias) return null;

  let sourceAlias: string;
  let sourceField: string;
  let joinField: string;
  if (leftAlias === join.table.alias && rightAlias !== join.table.alias) {
    sourceAlias = rightAlias;
    sourceField = join.on.right.field;
    joinField = join.on.left.field;
  } else if (rightAlias === join.table.alias && leftAlias !== join.table.alias) {
    sourceAlias = leftAlias;
    sourceField = join.on.left.field;
    joinField = join.on.right.field;
  } else {
    return null;
  }

  const sourceRows = tables.get(sourceAlias);
  if (!sourceRows) return null;

  const keys = new Set<string>();
  for (const row of sourceRows) {
    const raw = row[sourceField]?.value;
    const txt = toScalarText(raw).trim();
    if (txt.length > 0) keys.add(txt);
  }
  const values = [...keys];
  if (values.length === 0) return [];
  if (values.length > JOIN_IN_MAX_KEYS) {
    warnings.add(
      `JOINキーが ${values.length} 件のため ON 最適化をスキップし、JOIN先を全件取得します（上限 ${JOIN_IN_MAX_KEYS} 件）。`
    );
    return null;
  }

  const fields = selectToFetchAllFields(stmt, join.table);
  const onTruncate = (max: number): void => {
    warnings.add(`取得上限（${max} 件）に達したため、${max} 件で打ち切って表示しています。`);
  };

  const chunks = splitChunks(values, JOIN_IN_CHUNK_SIZE);
  const merged: KintoneRecord[] = [];
  const seen = new Set<string>();

  for (const chunk of chunks) {
    const inClause = `${joinField} in (${chunk.map(sqlQuote).join(",")})`;
    const query = pushDownCond !== null
      ? `(${inClause}) and (${whereToKintone(pushDownCond)})`
      : inClause;
    const resolved = await fetchRecordsForSharedPlan(client.getRecords, join.table.appId, query, fields, {
      parallel,
      maxRecords,
      onLimit,
      onTruncate,
    });
    for (const rec of resolved.records) {
      const key = `${rec["$id"]?.value ?? ""}:${JSON.stringify(rec)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(rec);
    }
  }

  return merged;
}

// ============================================================
// フィールド型マップ（DESCRIBE キャッシュ）
// ============================================================

const fieldTypeCache = new Map<string, Map<number, FieldTypeMap>>();
const optionOrderCache = new Map<string, Map<number, Map<string, Map<string, number>>>>();
const sortKindCache = new Map<string, Map<number, Map<string, "number" | "string">>>();
const fieldInfoCache = new Map<string, Map<number, Promise<KintoneFieldInfo[]>>>();
const processStatusCache = new Map<string, Map<number, Promise<KintoneProcessStatuses>>>();

function getScopedCacheValue<T>(
  root: Map<string, Map<number, T>>,
  cacheContext: string,
  appId: number
): T | undefined {
  return root.get(cacheContext)?.get(appId);
}

function setScopedCacheValue<T>(
  root: Map<string, Map<number, T>>,
  cacheContext: string,
  appId: number,
  value: T
): void {
  let scoped = root.get(cacheContext);
  if (!scoped) {
    scoped = new Map<number, T>();
    root.set(cacheContext, scoped);
  }
  scoped.set(appId, value);
}

function isSystemLikeFieldCode(code: string): boolean {
  return code.startsWith("_") || code.startsWith("$");
}

async function getFieldsCached(appId: number, client: KintoneClient, cacheContext: string): Promise<KintoneFieldInfo[]> {
  const cached = getScopedCacheValue(fieldInfoCache, cacheContext, appId);
  if (cached) return cached;
  const loading = client.getFields(appId);
  setScopedCacheValue(fieldInfoCache, cacheContext, appId, loading);
  return loading;
}

async function getProcessStatusesCached(
  appId: number,
  client: KintoneClient,
  cacheContext: string
): Promise<KintoneProcessStatuses> {
  const cached = getScopedCacheValue(processStatusCache, cacheContext, appId);
  if (cached) return cached;
  const loading = client.getProcessStatuses(appId);
  setScopedCacheValue(processStatusCache, cacheContext, appId, loading);
  return loading;
}

async function loadProcessStatusOrder(
  appId: number,
  client: KintoneClient,
  cacheContext: string
): Promise<ReadonlyMap<string, number> | undefined> {
  const process = await getProcessStatusesCached(appId, client, cacheContext);
  return process.enable && process.states !== null
    ? new Map(process.states.map((state) => [state.name, state.index]))
    : undefined;
}

async function getFieldTypeMap(appId: number, client: KintoneClient, cacheContext: string): Promise<FieldTypeMap> {
  const cached = getScopedCacheValue(fieldTypeCache, cacheContext, appId);
  if (cached) return cached;
  const fields = await getFieldsCached(appId, client, cacheContext);
  const map: FieldTypeMap = new Map(fields.map((f) => [f.code, f.fieldType]));
  setScopedCacheValue(fieldTypeCache, cacheContext, appId, map);
  return map;
}

async function getOptionOrderMapByApp(
  appId: number,
  client: KintoneClient,
  cacheContext: string
): Promise<Map<string, Map<string, number>>> {
  const cached = getScopedCacheValue(optionOrderCache, cacheContext, appId);
  if (cached) return cached;
  const fields = await getFieldsCached(appId, client, cacheContext);
  const map = new Map<string, Map<string, number>>();
  for (const field of fields) {
    if (!field.optionOrder) continue;
    const entries = Object.entries(field.optionOrder);
    if (entries.length === 0) continue;
    map.set(field.code, new Map(entries));
  }
  setScopedCacheValue(optionOrderCache, cacheContext, appId, map);
  return map;
}

/** 押し下げ時の実在検証用に、選択肢順マップをキー集合へ射影する。 */
async function getFieldOptionSetMapByApp(
  appId: number,
  client: KintoneClient,
  cacheContext: string
): Promise<FieldOptionsMap> {
  const optionOrders = await getOptionOrderMapByApp(appId, client, cacheContext);
  return new Map(
    [...optionOrders.entries()].map(([fieldCode, order]) => [
      fieldCode,
      new Set(order.keys()),
    ])
  );
}

async function getSortKindMapByApp(
  appId: number,
  client: KintoneClient,
  cacheContext: string
): Promise<Map<string, "number" | "string">> {
  const cached = getScopedCacheValue(sortKindCache, cacheContext, appId);
  if (cached) return cached;
  const fields = await getFieldsCached(appId, client, cacheContext);
  const map = new Map<string, "number" | "string">();
  for (const field of fields) {
    if (!field.sortKind) continue;
    map.set(field.code, field.sortKind);
  }
  setScopedCacheValue(sortKindCache, cacheContext, appId, map);
  return map;
}

interface OrderByMeta {
  optionOrders: OptionOrderMap;
  sortKinds: FieldSortKindMap;
  /** Phase 2 で収集する共有意味型。比較器への切替は Phase 4 で行う。 */
  semantics: ReadonlyMap<string, ResolvedFieldSemantics>;
}

function orderByFieldNames(stmt: SelectStatement): string[] {
  const items: OrderByItem[] = [
    ...stmt.orderBy,
    ...stmt.columns.flatMap((column) => column.type === "WINDOW_COL" ? column.orderBy : []),
  ];
  return [...new Set(items.flatMap((item) =>
    item.key.type === "FIELD_NAME" ? [item.key.name] : []
  ))];
}

async function buildOrderSemanticsForSelect(
  stmt: SelectStatement,
  client: KintoneClient,
  cacheContext: string,
  materializedTables?: ReadonlyMap<string, MaterializedTable>
): Promise<ReadonlyMap<string, ResolvedFieldSemantics>> {
  const names = orderByFieldNames(stmt);
  if (names.length === 0) return new Map();

  const tables = [stmt.from, ...stmt.joins.map((join) => join.table)];
  const ambiguousFields = new Set<string>();
  const infosByApp = new Map<number, Map<string, KintoneFieldInfo>>(
    await Promise.all([...new Set(
      tables.filter((table) => table.cteName === null).map((table) => table.appId)
    )].map(async (appId) => {
      const infos = await getFieldsCached(appId, client, cacheContext);
      return [appId, new Map(infos.map((info) => [info.code, info]))] as const;
    }))
  );

  const resolveField = (ref: FieldRef): MaterializedColumnMeta | undefined => {
    if (ref.tableAlias !== null) {
      if (ref.tableAlias === "_p" && stmt.from.subtableCode && stmt.from.cteName === null) {
        const info = infosByApp.get(stmt.from.appId)?.get(ref.field);
        return info ? materializedMetaFromFieldInfo(info, stmt.from.appId) : undefined;
      }
      const table = tables.find((candidate) => candidate.alias === ref.tableAlias);
      if (!table) return undefined;
      if (table.cteName !== null) return materializedTables?.get(table.cteName)?.columnMeta?.get(ref.field);
      const info = infosByApp.get(table.appId)?.get(fieldCodeForTypeLookup(table, ref.field));
      return info ? materializedMetaFromFieldInfo(info, table.appId) : systemColumnMeta(ref.field);
    }
    if (stmt.joins.length === 0) {
      if (stmt.from.cteName !== null) return materializedTables?.get(stmt.from.cteName)?.columnMeta?.get(ref.field);
      const info = infosByApp.get(stmt.from.appId)?.get(fieldCodeForTypeLookup(stmt.from, ref.field));
      return info ? materializedMetaFromFieldInfo(info, stmt.from.appId) : systemColumnMeta(ref.field);
    }
    const matches = tables.flatMap((table): MaterializedColumnMeta[] => {
      if (table.cteName !== null) {
        const materialized = materializedTables?.get(table.cteName);
        const meta = materialized?.columns.includes(ref.field) ? materialized.columnMeta?.get(ref.field) : undefined;
        return meta ? [meta] : [];
      }
      const info = infosByApp.get(table.appId)?.get(fieldCodeForTypeLookup(table, ref.field));
      const meta = info ? materializedMetaFromFieldInfo(info, table.appId) : systemColumnMeta(ref.field);
      return meta ? [meta] : [];
    });
    if (matches.length > 1) ambiguousFields.add(ref.field);
    return matches.length === 1 ? matches[0] : undefined;
  };

  const aliasSemantics = new Map<string, ResolvedFieldSemantics>();
  for (const column of stmt.columns) {
    if (!("alias" in column) || !column.alias) continue;
    let meta: MaterializedColumnMeta | undefined;
    if (column.type === "FIELD") meta = resolveField(aggregateFieldRef(column.field));
    else if (column.type === "ARITH_COL" || column.type === "ARITH_AGG_COL" || column.type === "WINDOW_COL") {
      meta = syntheticColumnMeta("number");
    } else if (column.type === "LITERAL_COL") meta = syntheticColumnMeta("string");
    else if (column.type === "STRFUNC_COL") meta = stringFunctionColumnMeta(column.expr);
    else if (column.type === "SCALAR_SUBQUERY_COL") meta = unknownStringColumnMeta();
    else if (column.type === "CASE_COL") {
      const candidates = column.expr.branches.map((branch) => caseResultColumnMeta(branch.result, resolveField));
      if (column.expr.elseResult) candidates.push(caseResultColumnMeta(column.expr.elseResult, resolveField));
      meta = mergeExpressionColumnMeta(candidates);
    } else if (column.type === "AGGREGATE") {
      if (column.func === "MIN" || column.func === "MAX") {
        meta = column.arg.type === "FIELD_REF"
          ? resolveField(aggregateFieldRef(column.arg.field))
          : syntheticColumnMeta("number");
      } else {
        meta = column.func === "GROUP_CONCAT" ? syntheticColumnMeta("string") : syntheticColumnMeta("number");
      }
    }
    if (meta?.semantics) aliasSemantics.set(column.alias, meta.semantics);
  }

  const result = new Map<string, ResolvedFieldSemantics>();
  for (const name of names) {
    const base = aliasSemantics.get(name) ?? resolveField(aggregateFieldRef(name))?.semantics;
    if (!base) {
      const ref = aggregateFieldRef(name);
      if (ref.tableAlias === null && ambiguousFields.has(ref.field)) {
        result.set(name, resolveFieldSemantics({ fieldType: "KSQL_AMBIGUOUS" }));
      }
      continue;
    }
    let semantics = base;
    if (base.fieldType === "STATUS" && base.source && stmt.orderMode !== "KINTONE_NATIVE") {
      const process = await getProcessStatusesCached(base.source.appId, client, cacheContext);
      if (process.enable && process.states !== null) {
        semantics = {
          ...base,
          optionOrder: new Map(process.states.map((state) => [state.name, state.index])),
        };
      }
    }
    result.set(name, semantics);
  }
  return result;
}

/**
 * ORDER BY の比較に使う選択肢順・ソート種別マップを取得する。
 * ORDER BY がない場合は applyOrderBy が即 return するため、
 * フィールド定義の取得自体をスキップする。
 */
async function buildOrderByMetaForSelect(
  stmt: SelectStatement,
  client: KintoneClient,
  cacheContext: string,
  materializedTables?: ReadonlyMap<string, MaterializedTable>
): Promise<OrderByMeta> {
  const hasWindowOrderBy = stmt.columns.some(
    (column) => column.type === "WINDOW_COL" && column.orderBy.length > 0
  );
  if (stmt.orderBy.length === 0 && !hasWindowOrderBy) {
    return { optionOrders: new Map(), sortKinds: new Map(), semantics: new Map() };
  }
  const [optionOrders, sortKinds, semantics] = await Promise.all([
    buildOptionOrdersForSelect(stmt, client, cacheContext),
    buildSortKindsForSelect(stmt, client, cacheContext),
    buildOrderSemanticsForSelect(stmt, client, cacheContext, materializedTables),
  ]);
  return { optionOrders, sortKinds, semantics };
}

async function buildOptionOrdersForSelect(
  stmt: SelectStatement,
  client: KintoneClient,
  cacheContext: string
): Promise<OptionOrderMap> {
  const optionOrders: OptionOrderMap = new Map();
  const tables: TableRef[] = [stmt.from, ...stmt.joins.map((j) => j.table)];
  const appLoaded = new Set<number>();

  for (const table of tables) {
    if (table.cteName != null) continue;
    if (appLoaded.has(table.appId)) continue;
    appLoaded.add(table.appId);

    const appMap = await getOptionOrderMapByApp(table.appId, client, cacheContext);
    for (const [fieldCode, orderMap] of appMap.entries()) {
      if (!optionOrders.has(fieldCode)) {
        optionOrders.set(fieldCode, orderMap);
      }
    }
  }

  for (const table of tables) {
    if (table.cteName != null || !table.alias) continue;
    const appMap = await getOptionOrderMapByApp(table.appId, client, cacheContext);
    for (const [fieldCode, orderMap] of appMap.entries()) {
      optionOrders.set(`${table.alias}.${fieldCode}`, orderMap);
    }
  }

  return optionOrders;
}

async function buildSortKindsForSelect(
  stmt: SelectStatement,
  client: KintoneClient,
  cacheContext: string
): Promise<FieldSortKindMap> {
  const sortKinds: FieldSortKindMap = new Map();
  const tables: TableRef[] = [stmt.from, ...stmt.joins.map((j) => j.table)];
  const appLoaded = new Set<number>();

  for (const table of tables) {
    if (table.cteName != null) continue;
    if (appLoaded.has(table.appId)) continue;
    appLoaded.add(table.appId);

    const appMap = await getSortKindMapByApp(table.appId, client, cacheContext);
    for (const [fieldCode, sortKind] of appMap.entries()) {
      if (!sortKinds.has(fieldCode)) {
        sortKinds.set(fieldCode, sortKind);
      }
    }
  }

  for (const table of tables) {
    if (table.cteName != null || !table.alias) continue;
    const appMap = await getSortKindMapByApp(table.appId, client, cacheContext);
    for (const [fieldCode, sortKind] of appMap.entries()) {
      sortKinds.set(`${table.alias}.${fieldCode}`, sortKind);
    }
  }

  return sortKinds;
}

/**
 * INSERT SELECT / UPSERT SELECT: ProcessRow の文字列値を転送先フィールド型に応じて変換する。
 * 同型フィールド（USER_SELECT→USER_SELECT 等）は JSON パースして API 形式に変換。
 * 型不明の場合は文字列のまま渡す。
 */
function convertProcessRowValue(
  raw: string,
  dstFieldType: string | undefined
): string | string[] | Array<{ code: string }> {
  const USER_TYPES  = new Set(["USER_SELECT", "ORGANIZATION_SELECT", "GROUP_SELECT"]);
  const ARRAY_TYPES = new Set(["CHECK_BOX", "MULTI_SELECT"]);

  if (USER_TYPES.has(dstFieldType ?? "")) {
    if (raw === "") return [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((v) => typeof v === "object" && "code" in v)) {
        return (parsed as { code: string; name?: string }[]).map((u) => ({ code: u.code }));
      }
    } catch { /* fall through */ }
    return raw.split(",").map((c) => ({ code: c.trim() }));
  }

  if (ARRAY_TYPES.has(dstFieldType ?? "")) {
    if (raw === "") return [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return (parsed as unknown[]).map(String);
    } catch { /* fall through */ }
    return raw.split(",").map((v) => v.trim());
  }

  return raw;
}

// ============================================================
// INSERT
// ============================================================

type ValidationStatement = InsertStatement | InsertSelectStatement | UpsertStatement | UpsertSelectStatement | UpdateStatement;
const NON_WRITABLE_FIELD_TYPES = new Set([
  "CALC", "RECORD_NUMBER", "CREATOR", "CREATED_TIME", "MODIFIER", "UPDATED_TIME", "STATUS", "STATUS_ASSIGNEE", "CATEGORY", "REFERENCE_TABLE",
]);

async function executeDmlValidation(
  stmt: ValidationStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  tempTables: Map<string, MaterializedTable> | undefined,
  statementNumber: number
): Promise<DmlValidationResult> {
  return (await prepareDmlValidation(stmt, client, options, cacheContext, tempTables, statementNumber)).result;
}

/** REJECT LIMIT 超過。診断結果を batch envelope へ残したまま fail-fast する。 */
export class RejectLimitExceededError extends Error {
  constructor(
    message: string,
    readonly diagnostic: DmlValidationResult
  ) {
    super(`RejectLimitExceededError: ${message}`);
    this.name = "RejectLimitExceededError";
  }
}

interface PreparedDmlValidation {
  result: DmlValidationResult;
  candidates: DmlValidationCandidate[];
  invalidRowNumbers: Set<number>;
  columnMeta: MaterializedColumnMetaMap;
}

async function prepareDmlValidation(
  stmt: ValidationStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  tempTables: Map<string, MaterializedTable> | undefined,
  statementNumber: number
): Promise<PreparedDmlValidation> {
  if (stmt.type === "UPDATE") {
    await assertDmlWhereCapability(stmt, client, cacheContext);
  }
  const operation: ValidationOperation = stmt.type === "UPDATE" ? "UPDATE" : stmt.type.startsWith("UPSERT") ? "UPSERT" : "INSERT";
  const payloadFields = stmt.type === "UPDATE" ? ["$id", ...stmt.assignments.map((a) => a.field)] : [...stmt.fields];
  if (new Set(payloadFields).size !== payloadFields.length) {
    throw new Error("ArgumentError: DML target fields contain duplicates.");
  }
  const fieldInfos = await getFieldsCached(stmt.appId, client, cacheContext);
  const infoByCode = new Map(fieldInfos.map((field) => [field.code, field]));
  const targetFields = stmt.type === "UPDATE" ? stmt.assignments.map((a) => a.field) : stmt.fields;
  for (const code of targetFields) {
    const info = infoByCode.get(code);
    if (!info) throw new Error(`ArgumentError: DML target field ${code} does not exist.`);
    if (info.writable === false || NON_WRITABLE_FIELD_TYPES.has(info.fieldType)) {
      throw new Error(`ArgumentError: DML target field ${code} is not writable (${info.fieldType}).`);
    }
  }

  const candidates = await materializeValidationCandidates(stmt, operation, client, options, cacheContext, tempTables, infoByCode);
  const { errors, invalidRows, invalidRowNumbers } = validateDmlCandidates(
    candidates, operation, payloadFields, targetFields, fieldInfos, statementNumber
  );
  const columns = [...payloadFields, ...VALIDATION_META_COLUMNS];
  const result: DmlValidationResult = {
    type: "VALIDATION",
    operation,
    validatedRows: candidates.length,
    validRows: candidates.length - invalidRows,
    invalidRows,
    errorCount: errors.length,
    columns,
    errors,
    ...(stmt.validationErrorTable
      ? { errTable: stmt.validationErrorTable }
      : stmt.onErrorSkip && stmt.errorTable ? { errTable: stmt.errorTable } : {}),
  };
  const columnMeta = new Map<string, MaterializedColumnMeta>();
  for (const column of payloadFields) {
    if (column === "$id") {
      columnMeta.set(column, {
        sortKind: "number",
        fieldType: "RECORD_NUMBER",
        semantics: resolveFieldSemantics({ fieldType: "RECORD_NUMBER" }),
      });
      continue;
    }
    const info = infoByCode.get(column);
    if (info) columnMeta.set(column, materializedMetaFromFieldInfo(info, stmt.appId));
  }
  columnMeta.set("$err_statement", syntheticColumnMeta("number"));
  columnMeta.set("$err_operation", syntheticColumnMeta("string"));
  columnMeta.set("$err_row", syntheticColumnMeta("number"));
  columnMeta.set("$err_field", syntheticColumnMeta("string"));
  columnMeta.set("$err_code", syntheticColumnMeta("string"));
  columnMeta.set("$err_message", syntheticColumnMeta("string"));
  materializedMetaByValidationResult.set(result, columnMeta);
  return { result, candidates, invalidRowNumbers, columnMeta };
}

async function executeOnErrorSkip(
  stmt: ValidationStatement & { onErrorSkip?: boolean; errorTable?: string; rejectLimit?: number | null },
  client: KintoneClient,
  options: BatchExecuteOptions,
  cacheContext: string,
  tempTables: Map<string, MaterializedTable>,
  statementNumber: number
): Promise<InsertResult | UpdateResult | UpsertResult> {
  const prepared = await prepareDmlValidation(
    stmt, client, options, cacheContext, tempTables, statementNumber
  );
  const errTable = stmt.errorTable;
  if (!errTable) throw new Error("ArgumentError: ON ERROR SKIP requires INTO #error_table.");

  appendValidationErrors(
    tempTables,
    errTable,
    prepared.result.columns,
    prepared.result.errors,
    options.tempTableMaxRows ?? TEMP_TABLE_MAX_ROWS,
    prepared.columnMeta
  );

  const rejectLimit = stmt.rejectLimit ?? null;
  if (rejectLimit !== null && prepared.result.invalidRows > rejectLimit) {
    throw new RejectLimitExceededError(
      `rejected rows (${prepared.result.invalidRows}) exceed REJECT LIMIT (${rejectLimit}).`,
      prepared.result
    );
  }

  const valid = prepared.candidates.filter((candidate) => !prepared.invalidRowNumbers.has(candidate.rowNumber));
  if (options.confirm) {
    const operation = stmt.type.startsWith("INSERT") ? "INSERT" : "UPDATE";
    const ok = await options.confirm(valid.length, operation);
    if (!ok) throw new OperationCancelledError(operation, valid.length);
  }

  const common = {
    affectedRows: valid.length,
    skippedRows: prepared.result.invalidRows,
    rejectLimit,
    errTable,
  };

  if (stmt.type === "INSERT" || stmt.type === "INSERT_SELECT") {
    const createdIds: string[][] = [];
    for (let i = 0; i < valid.length; i += 100) {
      const response = await client.postRecords({ app: stmt.appId, records: valid.slice(i, i + 100).map((c) => c.record!) });
      createdIds.push(response.ids);
    }
    return { type: "INSERT", createdIds, insertedCount: createdIds.flat().length, ...common };
  }

  if (stmt.type === "UPDATE") {
    const updates = valid.map((candidate) => {
      if (candidate.targetId === undefined) throw new Error("InternalError: prepared UPDATE candidate has no targetId.");
      return { id: candidate.targetId, record: candidate.record! };
    });
    for (let i = 0; i < updates.length; i += 100) {
      await client.putRecords({ app: stmt.appId, records: updates.slice(i, i + 100) });
    }
    return { type: "UPDATE", updatedCount: updates.length, ...common };
  }

  const inserts = valid.filter((candidate) => candidate.mode === "create");
  const updates = valid.filter((candidate) => candidate.mode === "update").map((candidate) => {
    if (candidate.targetId === undefined) throw new Error("InternalError: prepared UPSERT candidate has no targetId.");
    return { id: candidate.targetId, record: candidate.record! };
  });
  let insertedCount = 0;
  for (let i = 0; i < inserts.length; i += 100) {
    const response = await client.postRecords({ app: stmt.appId, records: inserts.slice(i, i + 100).map((c) => c.record!) });
    insertedCount += response.ids.length;
  }
  for (let i = 0; i < updates.length; i += 100) {
    await client.putRecords({ app: stmt.appId, records: updates.slice(i, i + 100) });
  }
  return { type: "UPSERT", insertedCount, updatedCount: updates.length, ...common };
}

async function materializeValidationCandidates(
  stmt: ValidationStatement,
  operation: ValidationOperation,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  tempTables: Map<string, MaterializedTable> | undefined,
  infoByCode: Map<string, KintoneFieldInfo>
): Promise<DmlValidationCandidate[]> {
  if (stmt.type === "UPDATE") return materializeUpdateValidationCandidates(stmt, client, options, cacheContext, tempTables);

  let rows: unknown[][];
  if (stmt.type === "INSERT" || stmt.type === "UPSERT") {
    rows = stmt.values.map((row) => row.map((value, i) =>
      value.type === "CASE_VALUE"
        ? evalCaseWhenValue(value.expr, {}, infoByCode.get(stmt.fields[i])?.fieldType)
        : value
    ));
  } else {
    const selectResult = tempTables && tempTables.size > 0
      ? await executeQueryWithCte(stmt.select, client, { ...options, onLimitReached: "error" }, tempTables, cacheContext)
      : await executeSelect(stmt.select, client, { ...options, onLimitReached: "error" }, cacheContext);
    if (selectResult.columns.length !== stmt.fields.length) {
      throw new Error(`SELECT の列数（${selectResult.columns.length}）と DML のフィールド数（${stmt.fields.length}）が一致しません`);
    }
    rows = selectResult.rows.map((row) => selectResult.columns.map((column) => row[column] ?? ""));
  }

  const candidates = rows.map((values, index): DmlValidationCandidate => ({
    rowNumber: index + 1,
    operation,
    mode: "create",
    payload: new Map(stmt.fields.map((field, i) => [field, values[i]])),
    preErrors: [],
    record: {},
  }));
  if (stmt.type !== "UPSERT" && stmt.type !== "UPSERT_SELECT") return candidates;

  for (const key of stmt.keyFields) {
    if (!stmt.fields.includes(key)) throw new Error(`ON DUPLICATE のキー「${key}」が UPSERT フィールドに含まれていません`);
  }
  const fieldTypes = new Map([...infoByCode].map(([code, info]) => [code, info.fieldType]));
  const rowKeys = candidates.map((candidate) => stmt.keyFields.map((key) => renderValidationValue(candidate.payload.get(key))));
  const targets = await resolveUpsertTargets(stmt.appId, stmt.keyFields, rowKeys, client, options, fieldTypes);
  const numeric = stmt.keyFields.map((key) => fieldTypes.get(key) === "NUMBER");
  const keyCounts = new Map<string, number>();
  for (const parts of rowKeys) {
    const key = upsertNormalizedKey(parts, numeric);
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  }
  candidates.forEach((candidate, index) => {
    const parts = rowKeys[index];
    const targetId = lookupUpsertTarget(targets, parts);
    candidate.mode = targetId === undefined ? "create" : "update";
    if (targetId !== undefined) candidate.targetId = targetId;
    stmt.keyFields.forEach((key, keyIndex) => {
      if (parts[keyIndex] === "") candidate.preErrors.push({ field: key, code: "ERR_KEY_EMPTY", message: `UPSERT キー ${key} は空にできません` });
    });
    if ((keyCounts.get(upsertNormalizedKey(parts, numeric)) ?? 0) > 1) {
      candidate.preErrors.push({ field: stmt.keyFields[0], code: "ERR_KEY_DUP_SOURCE", message: "UPSERT ソース内でキーが重複しています" });
    }
  });
  return candidates;
}

async function materializeUpdateValidationCandidates(
  stmt: UpdateStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  tempTables?: Map<string, MaterializedTable>
): Promise<DmlValidationCandidate[]> {
  if (stmt.from) return materializeUpdateFromValidationCandidates(stmt, stmt.from, client, options, cacheContext, tempTables);
  await resolveSetSubqueries(stmt.assignments, client, options, cacheContext);
  const fieldTypes = await getFieldTypeMap(stmt.appId, client, cacheContext);
  let records: Array<{ id: number; record: KintoneRecord }>;
  if (hasArithAssignment(stmt)) {
    const getParams = updateToGetQueryForArith(stmt);
    const resolved = await fetchRecordsForSharedPlan(client.getRecords, getParams.app, getParams.query, [...getParams.fields], {
      maxRecords: options.maxRecords ?? 10_000, parallel: options.fetchParallel ?? 1, onLimit: "error",
    });
    records = updateToPutBatchesArith(stmt, resolved.records, fieldTypes).flatMap((batch) => batch.records);
  } else {
    const getParams = updateToGetQuery(stmt);
    const resolved = await resolveDmlTargetIds(client.getRecords, getParams.app, getParams.query, {
      maxRecords: options.maxRecords ?? 10_000, parallel: options.fetchParallel ?? 1,
    });
    records = updateToPutBatches(stmt, resolved.ids, fieldTypes).flatMap((batch) => batch.records);
  }
  return records.sort((a, b) => a.id - b.id).map((entry, index) => ({
    rowNumber: index + 1,
    operation: "UPDATE",
    mode: "update",
    payload: new Map<string, unknown>([["$id", String(entry.id)], ...stmt.assignments.map((a) => [a.field, entry.record[a.field]?.value ?? ""] as [string, unknown])]),
    preErrors: [],
    record: entry.record,
    targetId: entry.id,
  }));
}

async function materializeUpdateFromValidationCandidates(
  stmt: UpdateStatement,
  from: NonNullable<UpdateStatement["from"]>,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  tempTables?: Map<string, MaterializedTable>
): Promise<DmlValidationCandidate[]> {
  const matched = await resolveUpdateFromMatchedRecords(stmt, from, client, options, cacheContext, tempTables);
  const fieldTypes = await getFieldTypeMap(stmt.appId, client, cacheContext);
  const records = updateFromToPutBatches(stmt, matched, fieldTypes).flatMap((batch) => batch.records);
  return records.sort((a, b) => a.id - b.id).map((entry, index) => ({
    rowNumber: index + 1, operation: "UPDATE", mode: "update",
    payload: new Map<string, unknown>([["$id", String(entry.id)], ...stmt.assignments.map((a) => [a.field, entry.record[a.field]?.value ?? ""] as [string, unknown])]),
    preErrors: [],
    record: entry.record,
    targetId: entry.id,
  }));
}

const UPDATE_FROM_KEY_CHUNK_SIZE = UPSERT_IN_CHUNK_SIZE;
const UPDATE_FROM_UNSUPPORTED_SOURCE_TYPES = new Set([
  "CHECK_BOX",
  "MULTI_SELECT",
  "USER_SELECT",
  "ORGANIZATION_SELECT",
  "GROUP_SELECT",
  "FILE",
]);

type UpdateFromJoinKeyKind = "id" | "string" | "number";

async function resolveUpdateFromMatchedRecords(
  stmt: UpdateStatement,
  from: NonNullable<UpdateStatement["from"]>,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  tempTables?: Map<string, MaterializedTable>
): Promise<Array<{ target: KintoneRecord; source: ProcessRow }>> {
  const joinKind = await resolveUpdateFromTargetJoinKind(stmt, from, client, cacheContext);
  const sourceFields = [...new Set(stmt.assignments
    .filter((a) => a.value.type === "SOURCE_FIELD")
    .map((a) => a.value.type === "SOURCE_FIELD" ? a.value.field : ""))];
  const requiredSourceFields = [...new Set([from.joinKeyField, ...sourceFields])];
  const sourceRows = await loadUpdateFromSourceRows(
    from,
    requiredSourceFields,
    sourceFields,
    client,
    options,
    cacheContext,
    tempTables
  );

  const sourceByKey = new Map<string, ProcessRow>();
  for (const row of sourceRows) {
    if (!Object.prototype.hasOwnProperty.call(row, from.joinKeyField)) {
      throw new Error(`ArgumentError: UPDATE ... FROM source column ${from.joinKeyField} does not exist.`);
    }
    const key = normalizeUpdateFromJoinKey(row[from.joinKeyField], joinKind, "source");
    if (sourceByKey.has(key)) {
      throw new Error(`ArgumentError: UPDATE ... FROM source has multiple rows for normalized key ${key}.`);
    }
    sourceByKey.set(key, row);
  }

  if (sourceByKey.size === 0) return [];

  const maxRecords = options.maxRecords ?? 10_000;
  const targetFields = collectUpdateFromTargetFields(stmt);
  const filterQuery = from.targetFilter === null
    ? ""
    : updateToGetQuery({ ...stmt, from: null, where: from.targetFilter }).query;
  const targetRecords: KintoneRecord[] = [];
  const seenTargetIds = new Set<string>();
  let fetchedTargetCount = 0;
  for (const keys of splitChunks([...sourceByKey.keys()], UPDATE_FROM_KEY_CHUNK_SIZE)) {
    const keyQuery = `${from.targetJoinField} in (${keys.map(sqlQuote).join(",")})`;
    const query = filterQuery ? `(${keyQuery}) and (${filterQuery})` : keyQuery;
    const resolved = await fetchRecordsForSharedPlan(
      client.getRecords,
      stmt.appId,
      query,
      targetFields,
      { maxRecords, parallel: options.fetchParallel ?? 1, onLimit: "error" }
    );
    fetchedTargetCount += resolved.records.length;
    if (fetchedTargetCount > maxRecords) {
      throw new FetchAllLimitError(
        `取得件数が上限（${maxRecords} 件）を超えました。WHERE 句で絞り込むか、maxRecords を引き上げてください。`
      );
    }
    for (const record of resolved.records) {
      const id = record["$id"]?.value;
      if (typeof id !== "string" || id === "") {
        throw new Error("ArgumentError: UPDATE ... FROM target record does not contain a valid $id.");
      }
      // 64文字前方一致の過剰取得で同じ行が複数チャンクに現れても、PUT対象は1回にする。
      if (seenTargetIds.has(id)) continue;
      seenTargetIds.add(id);
      targetRecords.push(record);
    }
  }

  const matched: Array<{ target: KintoneRecord; source: ProcessRow }> = [];
  for (const target of targetRecords) {
    const raw = target[from.targetJoinField]?.value;
    const key = normalizeUpdateFromJoinKey(raw, joinKind, "target");
    if (key === null) continue;
    const source = sourceByKey.get(key);
    // SINGLE_LINE_TEXT の in は先頭64文字で過剰取得し得るため、全文一致しない行を除外する。
    if (source !== undefined) matched.push({ target, source });
  }
  return matched;
}

async function resolveUpdateFromTargetJoinKind(
  stmt: UpdateStatement,
  from: NonNullable<UpdateStatement["from"]>,
  client: KintoneClient,
  cacheContext: string
): Promise<UpdateFromJoinKeyKind> {
  if (from.targetJoinField === "$id") return "id";
  const info = (await getFieldsCached(stmt.appId, client, cacheContext))
    .find((field) => field.code === from.targetJoinField);
  if (!info) {
    throw new Error(`ArgumentError: UPDATE ... FROM target column ${from.targetJoinField} does not exist.`);
  }
  if (info.inSubtable || info.writable === false ||
      (info.fieldType !== "SINGLE_LINE_TEXT" && info.fieldType !== "NUMBER")) {
    throw new Error(
      `ArgumentError: UPDATE ... FROM does not support target join field type ${info.fieldType} (${from.targetJoinField}).`
    );
  }
  return info.fieldType === "NUMBER" ? "number" : "string";
}

async function loadUpdateFromSourceRows(
  from: NonNullable<UpdateStatement["from"]>,
  requiredSourceFields: string[],
  sourceValueFields: string[],
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  tempTables?: Map<string, MaterializedTable>
): Promise<ProcessRow[]> {
  if (from.cteName !== null) {
    const table = tempTables?.get(from.cteName);
    if (!table) throw new Error(`ArgumentError: temp table ${from.cteName} is not available.`);
    for (const field of requiredSourceFields) {
      if (!table.columns.includes(field)) {
        throw new Error(`ArgumentError: UPDATE ... FROM source column ${field} does not exist.`);
      }
    }
    return table.rows;
  }

  const sourceTypes = await getFieldTypeMap(from.appId, client, cacheContext);
  const joinType = from.joinKeyField === "$id" ? "RECORD_NUMBER" : sourceTypes.get(from.joinKeyField);
  if (joinType === undefined) {
    throw new Error(`ArgumentError: UPDATE ... FROM source column ${from.joinKeyField} does not exist.`);
  }
  if (from.joinKeyField !== "$id" && joinType !== "SINGLE_LINE_TEXT" && joinType !== "NUMBER") {
    throw new Error(
      `ArgumentError: UPDATE ... FROM does not support source join field type ${joinType} (${from.joinKeyField}).`
    );
  }
  for (const field of sourceValueFields) {
    if (field !== "$id" && !sourceTypes.has(field)) {
      throw new Error(`ArgumentError: UPDATE ... FROM source column ${field} does not exist.`);
    }
    const type = field === "$id" ? "RECORD_NUMBER" : sourceTypes.get(field);
    if (UPDATE_FROM_UNSUPPORTED_SOURCE_TYPES.has(type ?? "")) {
      throw new Error(`ArgumentError: UPDATE ... FROM does not support source field type ${type} (${field}).`);
    }
  }
  const resolved = await fetchRecordsForSharedPlan(
    client.getRecords,
    from.appId,
    "",
    requiredSourceFields,
    { maxRecords: options.maxRecords ?? 10_000, parallel: options.fetchParallel ?? 1, onLimit: "error" }
  );
  return resolved.records.map((record) => flatten(record, null));
}

function normalizeUpdateFromJoinKey(
  raw: unknown,
  kind: UpdateFromJoinKeyKind,
  side: "source"
): string;
function normalizeUpdateFromJoinKey(
  raw: unknown,
  kind: UpdateFromJoinKeyKind,
  side: "target"
): string | null;
function normalizeUpdateFromJoinKey(
  raw: unknown,
  kind: UpdateFromJoinKeyKind,
  side: "source" | "target"
): string | null {
  if (typeof raw !== "string") {
    throw new Error(`ArgumentError: UPDATE ... FROM ${side} key must be a scalar string: ${String(raw)}`);
  }
  if (kind === "string") {
    if (raw === "") {
      if (side === "target") return null;
      throw new Error("ArgumentError: UPDATE ... FROM source key must not be empty.");
    }
    return raw;
  }
  if (kind === "number" && side === "target" && raw === "") return null;
  if (kind === "id") {
    const text = raw.trim();
    const id = Number(text);
    if (text === "" || !Number.isSafeInteger(id) || id <= 0) {
      throw new Error(`ArgumentError: UPDATE ... FROM ${side} key must be a positive safe integer: ${raw}`);
    }
    return String(id);
  }
  const text = raw.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) {
    throw new Error(`ArgumentError: UPDATE ... FROM ${side} key must be a finite decimal: ${raw}`);
  }
  let unsigned = text;
  let negative = false;
  if (unsigned.startsWith("-") || unsigned.startsWith("+")) {
    negative = unsigned[0] === "-";
    unsigned = unsigned.slice(1);
  }
  let [whole, fraction = ""] = unsigned.split(".");
  whole = (whole || "0").replace(/^0+(?=\d)/, "");
  fraction = fraction.replace(/0+$/, "");
  const zero = /^0*$/.test(whole) && fraction === "";
  const canonical = fraction === "" ? whole : `${whole}.${fraction}`;
  return negative && !zero ? `-${canonical}` : canonical;
}

async function executeInsert(
  stmt: Extract<Awaited<ReturnType<typeof parseSql>>, { type: "INSERT" }>,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string
): Promise<InsertResult> {
  if (stmt.subtableCode) {
    return executeInsertSubtable(stmt, client, options, cacheContext);
  }
  const fieldTypes = await getFieldTypeMap(stmt.appId, client, cacheContext);
  const batches = insertToPostBatches(stmt, fieldTypes);
  const createdIds: string[][] = [];

  for (const batch of batches) {
    const res = await client.postRecords(batch);
    createdIds.push(res.ids);
  }

  return {
    type: "INSERT",
    createdIds,
    insertedCount: createdIds.flat().length,
  };
}

// ============================================================
// INSERT INTO ... SELECT
// ============================================================

async function executeInsertSelect(
  stmt: InsertSelectStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  /** バッチ実行時の一時テーブルストア（#name → 行＋列）。SELECT ソースの解決に使う */
  cteCache?: Map<string, MaterializedTable>
): Promise<InsertResult> {
  // 1. SELECT を実行して結果行を取得（一時テーブル参照があれば注入経路で解決）
  const selectResult = cteCache !== undefined && cteCache.size > 0
    ? await executeQueryWithCte(stmt.select, client, options, cteCache, cacheContext)
    : await executeSelect(stmt.select, client, options, cacheContext);
  const { rows, columns } = selectResult;

  // 2. 列数チェック
  if (columns.length !== stmt.fields.length) {
    const emptySourceHint = columns.length === 0 && rows.length === 0
      ? "。結果が 0 行のため列を特定できませんでした（SELECT * を空ソースに使うと列を決定できません。明示列で指定してください）"
      : "";
    throw new Error(
      `SELECT の列数（${columns.length}）と INSERT のフィールド数（${stmt.fields.length}）が一致しません${emptySourceHint}`
    );
  }

  // 2.5 書き込み前に件数が確定するため、確認コールバック（dmlMaxRows ガード等）を通す
  if (options.confirm) {
    const ok = await options.confirm(rows.length, "INSERT");
    if (!ok) throw new OperationCancelledError("INSERT", rows.length);
  }

  // 3. 転送先フィールド型を取得（同型自動変換）
  const fieldTypes = await getFieldTypeMap(stmt.appId, client, cacheContext);

  // 4. ProcessRow[] → KintoneRecord[]（列の位置で対応付け）
  const allRecords = rows.map((row) => {
    const record: KintoneRecord = {};
    stmt.fields.forEach((field, i) => {
      const raw = row[columns[i]] ?? "";
      record[field] = { value: convertProcessRowValue(raw, fieldTypes.get(field)) };
    });
    return record;
  });

  // 5. 100 件ごとに POST
  const createdIds: string[][] = [];
  for (let i = 0; i < allRecords.length; i += 100) {
    const batch = allRecords.slice(i, i + 100);
    const res = await client.postRecords({ app: stmt.appId, records: batch });
    createdIds.push(res.ids);
  }

  return {
    type: "INSERT",
    createdIds,
    insertedCount: createdIds.flat().length,
  };
}

// ============================================================
// UPDATE
// ============================================================

async function executeUpdate(
  stmt: Extract<Awaited<ReturnType<typeof parseSql>>, { type: "UPDATE" }>,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  tempTables?: Map<string, MaterializedTable>
): Promise<UpdateResult> {
  await assertDmlWhereCapability(stmt, client, cacheContext);
  if (stmt.subtableCode) {
    return executeUpdateSubtable(stmt, client, options, cacheContext);
  }
  if (stmt.from != null) {
    return executeUpdateFrom(stmt, stmt.from, client, options, cacheContext, tempTables);
  }
  const maxRecords = options.maxRecords ?? 10_000;

  // SET のスカラーサブクエリを事前実行して StringLiteral に差し替え
  await resolveSetSubqueries(stmt.assignments, client, options, cacheContext);

  const fieldTypes = await getFieldTypeMap(stmt.appId, client, cacheContext);

  if (hasArithAssignment(stmt)) {
    // ── 算術式あり: 現在値を取得してから計算 → PUT ──
    // 1. $id + 参照フィールドを取得
    const getParams = updateToGetQueryForArith(stmt);
    const resolved = await fetchRecordsForSharedPlan(
      client.getRecords,
      getParams.app,
      getParams.query,
      [...getParams.fields],
      { maxRecords, parallel: options.fetchParallel ?? 1 }
    );
    const records = resolved.records;

    // 2. 実行前確認
    if (options.confirm) {
      const ok = await options.confirm(records.length, "UPDATE");
      if (!ok) throw new OperationCancelledError("UPDATE", records.length);
    }

    // 3. レコードごとに算術計算して PUT
    const batches = updateToPutBatchesArith(stmt, records, fieldTypes);
    for (const batch of batches) {
      await client.putRecords(batch);
    }

    return { type: "UPDATE", updatedCount: records.length };
  }

  // ── 通常パス: $id のみ取得 → 同一値で一括 PUT ──
  // 1. 対象レコードの $id を取得
  const getParams = updateToGetQuery(stmt);
  const resolved = await resolveDmlTargetIds(
    client.getRecords,
    getParams.app,
    getParams.query,
    { maxRecords, parallel: options.fetchParallel ?? 1 }
  );
  const ids = resolved.ids;

  // 2. 実行前確認
  if (options.confirm) {
    const ok = await options.confirm(ids.length, "UPDATE");
    if (!ok) throw new OperationCancelledError("UPDATE", ids.length);
  }

  // 3. PUT バッチ実行
  const batches = updateToPutBatches(stmt, ids, fieldTypes);
  for (const batch of batches) {
    await client.putRecords(batch);
  }

  return { type: "UPDATE", updatedCount: ids.length };
}

async function executeUpdateFrom(
  stmt: UpdateStatement,
  from: NonNullable<UpdateStatement["from"]>,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  tempTables?: Map<string, MaterializedTable>
): Promise<UpdateResult> {
  const matched = await resolveUpdateFromMatchedRecords(stmt, from, client, options, cacheContext, tempTables);

  if (options.confirm) {
    const ok = await options.confirm(matched.length, "UPDATE");
    if (!ok) throw new OperationCancelledError("UPDATE", matched.length);
  }

  const fieldTypes = await getFieldTypeMap(stmt.appId, client, cacheContext);
  // 全件を先に構築・検証し、ローカル変換エラーによる部分書き込みを防止する。
  const batches = updateFromToPutBatches(stmt, matched, fieldTypes);
  for (const batch of batches) await client.putRecords(batch);
  return { type: "UPDATE", updatedCount: matched.length };
}

function collectUpdateFromTargetFields(stmt: UpdateStatement): string[] {
  const fields = new Set<string>(["$id"]);
  if (stmt.from) fields.add(stmt.from.targetJoinField);
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node === null || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (obj["type"] === "FIELD_REF" && typeof obj["field"] === "string") fields.add(obj["field"]);
    for (const value of Object.values(obj)) visit(value);
  };
  for (const assignment of stmt.assignments) {
    if (assignment.value.type !== "SOURCE_FIELD") visit(assignment.value);
  }
  return [...fields];
}

// ============================================================
// DELETE
// ============================================================

async function executeDelete(
  stmt: Extract<Awaited<ReturnType<typeof parseSql>>, { type: "DELETE" }>,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string
): Promise<DeleteResult> {
  await assertDmlWhereCapability(stmt, client, cacheContext);
  if (stmt.subtableCode) {
    return executeDeleteSubtable(stmt, client, options, cacheContext);
  }
  // 1. 対象レコードの $id を取得
  const getParams = deleteToGetQuery(stmt);
  const resolved = await resolveDmlTargetIds(
    client.getRecords,
    getParams.app,
    getParams.query,
    {
      maxRecords: options.maxRecords ?? 10_000,
      parallel: options.fetchParallel ?? 1,
    }
  );
  const ids = resolved.ids;

  // 2. 実行前確認
  if (options.confirm) {
    const ok = await options.confirm(ids.length, "DELETE");
    if (!ok) throw new OperationCancelledError("DELETE", ids.length);
  }

  // 3. DELETE バッチ実行
  const batches = deleteToDeleteBatches(stmt.appId, ids);
  for (const batch of batches) {
    await client.deleteRecords(batch);
  }

  return { type: "DELETE", deletedCount: ids.length };
}

// ============================================================
// UPSERT
// ============================================================

/**
 * UPSERT INTO APP100 (f1, f2) VALUES (v1, v2) ON DUPLICATE (f1)
 *
 * 処理フロー（行ごと）:
 *   1. keyFields の値で GET（件数チェック）
 *   2. ヒットあり → PUT（UPDATE）
 *   3. ヒットなし → POST（INSERT）
 *
 * 確認ダイアログは INSERT/UPDATE 件数をまとめて1回表示。
 */
async function executeUpsert(
  stmt: UpsertStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string
): Promise<UpsertResult> {
  // 1. 各行のキー値を評価し、既存レコードを一括検索（in (...) チャンク）
  const toInsert: KintoneRecord[] = [];
  const toUpdate: { id: number; record: KintoneRecord }[] = [];

  const fieldTypes = await getFieldTypeMap(stmt.appId, client, cacheContext);

  const rowKeyValues: string[][] = stmt.values.map((row) =>
    stmt.keyFields.map((key) => {
      const idx = stmt.fields.indexOf(key);
      if (idx === -1) throw new Error(`ON DUPLICATE のキー「${key}」が INSERT フィールドに含まれていません`);
      const val = row[idx];
      return val.type === "STRING" ? val.value
        : val.type === "NUMBER" ? String(val.value)
        : val.type === "CASE_VALUE" ? evalCaseWhen(val.expr, {})
        : val.elements.map((e) => e.value).join(",");
    })
  );
  const targetIndex = await resolveUpsertTargets(stmt.appId, stmt.keyFields, rowKeyValues, client, options, fieldTypes);

  stmt.values.forEach((row, rowIdx) => {
    // レコード全体を組み立て
    const record: KintoneRecord = {};
    stmt.fields.forEach((field, i) => {
      const val = row[i];
      if (val.type === "CASE_VALUE") {
        record[field] = { value: evalCaseWhenValue(val.expr, {}, fieldTypes.get(field)) };
      } else {
        record[field] = { value: toKintoneValue(val, fieldTypes.get(field)) };
      }
    });

    const id = lookupUpsertTarget(targetIndex, rowKeyValues[rowIdx]);
    if (id !== undefined) {
      toUpdate.push({ id, record });
    } else {
      toInsert.push(record);
    }
  });

  // 2. 確認ダイアログ（INSERT + UPDATE の合計）
  if (options.confirm && (toInsert.length + toUpdate.length) > 0) {
    const total = toInsert.length + toUpdate.length;
    const ok = await options.confirm(total, "UPDATE");
    if (!ok) throw new OperationCancelledError("UPDATE", total);
  }

  // 3. POST（INSERT 対象）
  const createdIds: string[][] = [];
  for (let i = 0; i < toInsert.length; i += 100) {
    const res = await client.postRecords({ app: stmt.appId, records: toInsert.slice(i, i + 100) });
    createdIds.push(res.ids);
  }

  // 4. PUT（UPDATE 対象）
  for (let i = 0; i < toUpdate.length; i += 100) {
    await client.putRecords({ app: stmt.appId, records: toUpdate.slice(i, i + 100) });
  }

  return {
    type:          "UPSERT",
    insertedCount: createdIds.flat().length,
    updatedCount:  toUpdate.length,
  };
}

// ============================================================
// サブテーブル DML
// ============================================================

type MutableTableRow = {
  id?: string;
  value: Record<string, { value: unknown }>;
};

interface ExpandedSubtableRow {
  parent: KintoneRecord;
  parentId: string;
  parentRevision: number;
  rowIndex: number;
  rowId: string;
  row: MutableTableRow;
  flat: ProcessRow;
}

async function buildSubtableFieldTypeResolver(
  appId: number,
  typedInRefs: readonly FieldRef[],
  client: KintoneClient,
  cacheContext: string
): Promise<FieldTypeResolver | undefined> {
  if (typedInRefs.length === 0) return undefined;
  const fieldTypes = await getFieldTypeMap(appId, client, cacheContext);
  return (field) => {
    if (field.tableAlias !== null && field.tableAlias !== "_p") return undefined;
    if (field.tableAlias === "_p") return fieldTypes.get(field.field);
    const code = field.field.startsWith("_p.") ? field.field.slice(3) : field.field;
    return fieldTypes.get(code);
  };
}

async function executeInsertSubtable(
  stmt: Extract<Awaited<ReturnType<typeof parseSql>>, { type: "INSERT" }>,
  client: KintoneClient,
  options: ExecuteOptions,
  _cacheContext: string
): Promise<InsertResult> {
  const subtableCode = stmt.subtableCode!;
  const pidIndex = stmt.fields.indexOf("_pid");
  if (pidIndex < 0) {
    throw new Error("サブテーブル INSERT には _pid が必須です");
  }

  const parents = await fetchAll(client.getRecords, stmt.appId, "", [], {
    maxRecords: options.maxRecords ?? 10_000,
    parallel: options.fetchParallel ?? 1,
  });
  const parentMap = buildParentIdMap(parents);

  // 親IDごとに追加行を集約
  const insertsByParent = new Map<string, MutableTableRow[]>();
  for (const rowValues of stmt.values) {
    const pid = valueToString(rowValues[pidIndex]);
    const parent = parentMap.get(pid);
    if (!parent) throw new Error(`_pid=${pid} の親レコードが見つかりません`);

    const newRow: MutableTableRow = { value: {} };
    stmt.fields.forEach((field, i) => {
      if (field === "_pid") return;
      if (field.startsWith("_")) {
        throw new Error(`サブテーブル INSERT でシステム列「${field}」は指定できません`);
      }
      newRow.value[field] = { value: valueToString(rowValues[i]) };
    });
    const bucket = insertsByParent.get(pid);
    if (bucket) bucket.push(newRow);
    else insertsByParent.set(pid, [newRow]);
  }

  const putCalls: KintonePutParams[] = [];
  for (const [pid, rowsToInsert] of insertsByParent.entries()) {
    const parent = parentMap.get(pid)!;
    const currentRows = getMutableTableRows(parent, subtableCode);
    const nextRows = [...currentRows, ...rowsToInsert];
    putCalls.push(buildSubtablePutParams(stmt.appId, pid, getRevision(parent), subtableCode, nextRows));
  }

  for (const p of putCalls) {
    await client.putRecords(p);
  }

  return { type: "INSERT", createdIds: [], insertedCount: stmt.values.length };
}

async function executeUpdateSubtable(
  stmt: Extract<Awaited<ReturnType<typeof parseSql>>, { type: "UPDATE" }>,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string
): Promise<UpdateResult> {
  const subtableCode = stmt.subtableCode!;
  if (!hasRidCondition(stmt.where)) {
    throw new Error("サブテーブル UPDATE には _rid 条件が必須です");
  }

  const typedInRefs: FieldRef[] = [];
  collectTypedInFieldRefs(stmt.where, typedInRefs);
  for (const assignment of stmt.assignments) {
    if (assignment.value.type === "CASE_VALUE") {
      collectCaseTypedInFieldRefs(assignment.value.expr, typedInRefs);
    }
  }
  const resolveFieldType = await buildSubtableFieldTypeResolver(
    stmt.appId,
    typedInRefs,
    client,
    cacheContext
  );

  const parents = await fetchAll(
    client.getRecords,
    stmt.appId,
    "",
    [],
    { maxRecords: options.maxRecords ?? 10_000, parallel: options.fetchParallel ?? 1 }
  );
  const expanded = expandRowsForSubtableDml(parents, subtableCode);
  const targets = expanded.filter((r) => evalWhere(stmt.where, r.flat, resolveFieldType));

  if (options.confirm) {
    const ok = await options.confirm(targets.length, "UPDATE");
    if (!ok) throw new OperationCancelledError("UPDATE", targets.length);
  }

  const updatesByParent = new Map<string, Map<string, Record<string, { value: unknown }>>>();
  for (const t of targets) {
    if (!t.rowId) {
      throw new Error("サブテーブル UPDATE 対象に id 未採番の行が含まれています");
    }
    let byRid = updatesByParent.get(t.parentId);
    if (!byRid) {
      byRid = new Map<string, Record<string, { value: unknown }>>();
      updatesByParent.set(t.parentId, byRid);
    }
    const updates: Record<string, { value: unknown }> = {};
    for (const a of stmt.assignments) {
      if (a.field.startsWith("_")) {
        throw new Error(`サブテーブル UPDATE でシステム列「${a.field}」は更新できません`);
      }
      updates[a.field] = { value: evalAssignmentValueForSubtable(a.value, t.flat, resolveFieldType) };
    }
    byRid.set(t.rowId, updates);
  }

  const parentById = buildParentIdMap(parents);
  for (const [pid, updateMap] of updatesByParent.entries()) {
    const parent = parentById.get(pid);
    if (!parent) continue;
    const currentRows = getMutableTableRows(parent, subtableCode);
    const payloadRows = currentRows.map((row) => {
      const rid = row.id ?? "";
      if (!rid) return row as unknown as { id: string; value?: Record<string, { value: unknown }> };
      const updates = updateMap.get(rid);
      if (!updates) {
        return { id: rid };
      }
      return { id: rid, value: updates };
    });
    await client.putRecords(buildSubtablePatchPutParams(stmt.appId, pid, getRevision(parent), subtableCode, payloadRows));
  }

  return { type: "UPDATE", updatedCount: targets.length };
}

async function executeDeleteSubtable(
  stmt: Extract<Awaited<ReturnType<typeof parseSql>>, { type: "DELETE" }>,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string
): Promise<DeleteResult> {
  const subtableCode = stmt.subtableCode!;
  if (!hasRidCondition(stmt.where)) {
    throw new Error("サブテーブル DELETE には _rid 条件が必須です");
  }

  const typedInRefs: FieldRef[] = [];
  collectTypedInFieldRefs(stmt.where, typedInRefs);
  const resolveFieldType = await buildSubtableFieldTypeResolver(
    stmt.appId,
    typedInRefs,
    client,
    cacheContext
  );

  const parents = await fetchAll(
    client.getRecords,
    stmt.appId,
    "",
    [],
    { maxRecords: options.maxRecords ?? 10_000, parallel: options.fetchParallel ?? 1 }
  );
  const expanded = expandRowsForSubtableDml(parents, subtableCode);
  const targets = expanded.filter((r) => evalWhere(stmt.where, r.flat, resolveFieldType));

  if (options.confirm) {
    const ok = await options.confirm(targets.length, "DELETE");
    if (!ok) throw new OperationCancelledError("DELETE", targets.length);
  }

  const byParent = new Map<string, number[]>();
  for (const t of targets) {
    const bucket = byParent.get(t.parentId);
    if (bucket) bucket.push(t.rowIndex);
    else byParent.set(t.parentId, [t.rowIndex]);
  }

  const parentById = buildParentIdMap(parents);
  for (const [pid, idxs] of byParent.entries()) {
    const parent = parentById.get(pid);
    if (!parent) continue;
    const rows = getMutableTableRows(parent, subtableCode);
    const rm = new Set(idxs);
    const nextRows = rows.filter((_, i) => !rm.has(i));
    await client.putRecords(buildSubtablePutParams(stmt.appId, pid, getRevision(parent), subtableCode, nextRows));
  }

  return { type: "DELETE", deletedCount: targets.length };
}

/** 親レコードの $id → レコードの索引（ループ内線形検索の回避） */
function buildParentIdMap(parents: KintoneRecord[]): Map<string, KintoneRecord> {
  const map = new Map<string, KintoneRecord>();
  for (const p of parents) {
    const pid = String(p["$id"]?.value ?? "");
    if (pid) map.set(pid, p);
  }
  return map;
}

function expandRowsForSubtableDml(parents: KintoneRecord[], subtableCode: string): ExpandedSubtableRow[] {
  const out: ExpandedSubtableRow[] = [];
  for (const parent of parents) {
    const parentId = String(parent["$id"]?.value ?? "");
    const parentRevision = getRevision(parent);
    const tableRows = getMutableTableRows(parent, subtableCode);
    for (let i = 0; i < tableRows.length; i++) {
      const row = tableRows[i];
      const flat: ProcessRow = {
        _pid: parentId,
        _rid: row.id ?? "",
        _idx: String(i),
      };
      for (const [k, v] of Object.entries(parent)) {
        if (k === subtableCode) continue;
        flat[`_p.${k}`] = normalizeUnknownToString(v?.value);
      }
      for (const [k, v] of Object.entries(row.value ?? {})) {
        flat[k] = normalizeUnknownToString(v?.value);
      }
      out.push({ parent, parentId, parentRevision, rowIndex: i, rowId: row.id ?? "", row, flat });
    }
  }
  return out;
}

function getMutableTableRows(parent: KintoneRecord, subtableCode: string): MutableTableRow[] {
  const raw = parent[subtableCode]?.value;
  if (!Array.isArray(raw)) return [];
  return raw as unknown as MutableTableRow[];
}

function getRevision(parent: KintoneRecord): number {
  const n = Number(parent["$revision"]?.value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function buildSubtablePutParams(
  appId: number,
  parentId: string,
  revision: number,
  subtableCode: string,
  rows: MutableTableRow[]
): KintonePutParams {
  return {
    app: appId,
    records: [
      {
        id: Number(parentId),
        revision,
        record: {
          [subtableCode]: {
            value: rows as unknown as string,
          },
        },
      },
    ],
  };
}

function buildSubtablePatchPutParams(
  appId: number,
  parentId: string,
  revision: number,
  subtableCode: string,
  rows: Array<{ id: string; value?: Record<string, { value: unknown }> }>
): KintonePutParams {
  return {
    app: appId,
    records: [
      {
        id: Number(parentId),
        revision,
        record: {
          [subtableCode]: {
            value: rows as unknown as string,
          },
        },
      },
    ],
  };
}

function buildSubtableReorderPutParams(
  appId: number,
  parentId: string,
  revision: number,
  subtableCode: string,
  rowIds: string[]
): KintonePutParams {
  if (rowIds.some((id) => !id)) {
    throw new Error("REORDER 対象に id 未採番の行が含まれています");
  }
  return {
    app: appId,
    records: [
      {
        id: Number(parentId),
        revision,
        record: {
          [subtableCode]: {
            value: rowIds.map((id) => ({ id })) as unknown as string,
          },
        },
      },
    ],
  };
}

function evalAssignmentValueForSubtable(
  value: Extract<Awaited<ReturnType<typeof parseSql>>, { type: "UPDATE" }>["assignments"][number]["value"],
  row: ProcessRow,
  resolveFieldType?: FieldTypeResolver
): string {
  if (value.type === "STRING") return value.value;
  if (value.type === "NUMBER") return String(value.value);
  if (value.type === "ARITH") return String(evalArithExpr(value, row));
  if (value.type === "CASE_VALUE") return evalCaseWhen(value.expr, row, resolveFieldType);
  throw new Error(`${value.type} はサブテーブル UPDATE の値として使用できません`);
}

function valueToString(value: { type: "STRING"; value: string } | { type: "NUMBER"; value: number } | { type: "ARRAY"; elements: { value: string }[] } | { type: "CASE_VALUE"; expr: CaseWhenExpr }): string {
  if (value.type === "STRING") return value.value;
  if (value.type === "NUMBER") return String(value.value);
  if (value.type === "CASE_VALUE") return evalCaseWhen(value.expr, {});
  return value.elements.map((e) => e.value).join(",");
}

function normalizeUnknownToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function hasRidCondition(where: WhereExpr): boolean {
  switch (where.type) {
    case "BINARY":
      return where.left.type === "FIELD" && where.left.tableAlias === null && where.left.field === "_rid";
    case "LOGICAL":
      return hasRidCondition(where.left) || hasRidCondition(where.right);
    case "NOT":
    case "GROUP":
      return hasRidCondition(where.expr);
    default:
      return false;
  }
}

async function executeReorder(
  stmt: ReorderStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string
): Promise<ReorderResult> {
  const typedInRefs: FieldRef[] = [];
  collectTypedInFieldRefs(stmt.where, typedInRefs);
  const resolveFieldType = await buildSubtableFieldTypeResolver(
    stmt.appId,
    typedInRefs,
    client,
    cacheContext
  );
  const reorderFields = await getFieldsCached(stmt.appId, client, cacheContext);
  const reorderSemanticsByCode = new Map(reorderFields.map((field) => [
    field.code,
    field.semantics ?? resolveFieldSemantics(field),
  ]));
  const resolveReorderSemantics: FieldSemanticsResolver = (field) => {
    if (field.field === "_idx" || field.field === "_pid" || field.field === "_rid") {
      return syntheticSemantics("number");
    }
    const code = field.field.startsWith("_p.") ? field.field.slice(3) : field.field;
    return reorderSemanticsByCode.get(code) ?? syntheticSemantics("string");
  };
  const parents = await fetchAll(
    client.getRecords,
    stmt.appId,
    "",
    [],
    { maxRecords: options.maxRecords ?? 10_000, parallel: options.fetchParallel ?? 1 }
  );
  const expanded = expandRowsForSubtableDml(parents, stmt.subtableCode);

  // WHERE に一致する行を1件でも持つ親を対象とする
  const targetParentIds = stmt.all
    ? new Set(parents.map((p) => String(p["$id"]?.value ?? "")).filter((id) => id !== ""))
    : new Set(expanded.filter((r) => stmt.where && evalWhere(
        stmt.where, r.flat, resolveFieldType, undefined, resolveReorderSemantics
      )).map((r) => r.parentId));

  if (options.confirm) {
    const ok = await options.confirm(targetParentIds.size, "UPDATE");
    if (!ok) throw new OperationCancelledError("UPDATE", targetParentIds.size);
  }

  const parentById = buildParentIdMap(parents);
  for (const pid of targetParentIds) {
    const parent = parentById.get(pid);
    if (!parent) continue;

    const rows = getMutableTableRows(parent, stmt.subtableCode);
    const sortable = rows.map((row, i) => ({ row, i, flat: buildFlatRowForSort(parent, stmt.subtableCode, row, i) }));
    sortable.sort((a, b) => compareByOrder(a.flat, b.flat, stmt.by, resolveReorderSemantics));
    const orderedRowIds = sortable.map((x) => x.row.id ?? "");
    await client.putRecords(buildSubtableReorderPutParams(stmt.appId, pid, getRevision(parent), stmt.subtableCode, orderedRowIds));
  }

  return { type: "REORDER", reorderedParentCount: targetParentIds.size };
}

function buildFlatRowForSort(
  parent: KintoneRecord,
  subtableCode: string,
  row: MutableTableRow,
  idx: number
): ProcessRow {
  const flat: ProcessRow = {
    _pid: String(parent["$id"]?.value ?? ""),
    _rid: row.id ?? "",
    _idx: String(idx),
  };
  for (const [k, v] of Object.entries(parent)) {
    if (k === subtableCode) continue;
    flat[`_p.${k}`] = normalizeUnknownToString(v?.value);
  }
  for (const [k, v] of Object.entries(row.value ?? {})) {
    flat[k] = normalizeUnknownToString(v?.value);
  }
  return flat;
}

function compareByOrder(
  a: ProcessRow,
  b: ProcessRow,
  orderBy: ReorderStatement["by"],
  resolveSemantics: FieldSemanticsResolver
): number {
  for (const item of orderBy) {
    const av = evalOrderKeyForRow(item.key, a);
    const bv = evalOrderKeyForRow(item.key, b);
    const semantics = item.key.type === "FIELD_NAME"
      ? resolveSemantics(aggregateFieldRef(item.key.name))
      : item.key.type === "ARITH_KEY"
        ? syntheticSemantics("number")
        : stringFunctionColumnMeta(item.key.expr).semantics ?? syntheticSemantics("string");
    const cmp = compareCanonicalValues(av, bv, semantics ?? syntheticSemantics("string"));
    if (cmp !== 0) return item.direction === "ASC" ? cmp : -cmp;
  }
  return 0;
}

function evalOrderKeyForRow(key: OrderByKey, row: ProcessRow): string {
  switch (key.type) {
    case "FIELD_NAME":
      return row[key.name] ?? "";
    case "ARITH_KEY":
      return String(evalArithExpr(key.expr, row));
    case "FUNC_KEY":
      return evalStringFunc(key.expr, row);
  }
}

// ============================================================
// UPSERT INTO ... SELECT
// ============================================================

async function executeUpsertSelect(
  stmt: UpsertSelectStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  /** バッチ実行時の一時テーブルストア（#name → 行＋列）。SELECT ソースの解決に使う */
  cteCache?: Map<string, MaterializedTable>
): Promise<UpsertResult> {
  // 1. SELECT を実行して結果行を取得（一時テーブル参照があれば注入経路で解決）
  const selectResult = cteCache !== undefined && cteCache.size > 0
    ? await executeQueryWithCte(stmt.select, client, options, cteCache, cacheContext)
    : await executeSelect(stmt.select, client, options, cacheContext);
  const { rows, columns } = selectResult;

  if (columns.length !== stmt.fields.length) {
    const emptySourceHint = columns.length === 0 && rows.length === 0
      ? "。結果が 0 行のため列を特定できませんでした（SELECT * を空ソースに使うと列を決定できません。明示列で指定してください）"
      : "";
    throw new Error(
      `SELECT の列数（${columns.length}）と UPSERT のフィールド数（${stmt.fields.length}）が一致しません${emptySourceHint}`
    );
  }

  // 2. キーフィールドが UPSERT フィールドに含まれているか確認
  for (const key of stmt.keyFields) {
    if (!stmt.fields.includes(key)) {
      throw new Error(`ON DUPLICATE のキー「${key}」が UPSERT フィールドに含まれていません`);
    }
  }

  const toInsert: KintoneRecord[] = [];
  const toUpdate: { id: number; record: KintoneRecord }[] = [];

  // レコードを組み立て（SELECT 列 → UPSERT フィールドに位置対応でマップ）
  const records: KintoneRecord[] = rows.map((row) => {
    const record: KintoneRecord = {};
    stmt.fields.forEach((field, i) => {
      record[field] = { value: row[columns[i]] ?? "" };
    });
    return record;
  });

  // キー値で既存レコードを一括検索（in (...) チャンク）
  const fieldTypes = await getFieldTypeMap(stmt.appId, client, cacheContext);
  const rowKeyValues: string[][] = records.map((record) =>
    stmt.keyFields.map((key) => String(record[key]?.value ?? ""))
  );
  const targetIndex = await resolveUpsertTargets(stmt.appId, stmt.keyFields, rowKeyValues, client, options, fieldTypes);

  records.forEach((record, rowIdx) => {
    const id = lookupUpsertTarget(targetIndex, rowKeyValues[rowIdx]);
    if (id !== undefined) {
      toUpdate.push({ id, record });
    } else {
      toInsert.push(record);
    }
  });

  // 3. 確認ダイアログ
  if (options.confirm && (toInsert.length + toUpdate.length) > 0) {
    const total = toInsert.length + toUpdate.length;
    const ok = await options.confirm(total, "UPDATE");
    if (!ok) throw new OperationCancelledError("UPDATE", total);
  }

  // 4. POST（INSERT 対象）
  const createdIds: string[][] = [];
  for (let i = 0; i < toInsert.length; i += 100) {
    const res = await client.postRecords({ app: stmt.appId, records: toInsert.slice(i, i + 100) });
    createdIds.push(res.ids);
  }

  // 5. PUT（UPDATE 対象）
  for (let i = 0; i < toUpdate.length; i += 100) {
    await client.putRecords({ app: stmt.appId, records: toUpdate.slice(i, i + 100) });
  }

  return {
    type:          "UPSERT",
    insertedCount: createdIds.flat().length,
    updatedCount:  toUpdate.length,
  };
}

// ============================================================
// SHOW APPS
// ============================================================

async function executeShowApps(client: KintoneClient): Promise<SelectResult> {
  const apps = await client.getApps();
  const columns = ["アプリID", "アプリ名", "説明"];
  const rows: ProcessRow[] = apps.map((a) => ({
    "アプリID": String(a.appId),
    "アプリ名":  a.name,
    "説明":      a.description,
  }));
  return { type: "SELECT", rows, columns, rowCount: rows.length };
}

// ============================================================
// DESCRIBE
// ============================================================

async function executeDescribe(
  stmt: DescribeStatement,
  client: KintoneClient,
  cacheContext: string
): Promise<SelectResult> {
  const fields = await getFieldsCached(stmt.appId, client, cacheContext);
  const columns = ["フィールドコード", "ラベル", "タイプ"];
  const rows: ProcessRow[] = fields.map((f) => ({
    "フィールドコード": f.code,
    "ラベル":           f.label,
    "タイプ":           f.fieldType,
  }));
  return { type: "SELECT", rows, columns, rowCount: rows.length };
}

// ============================================================
// ヘルパー
// ============================================================

function parseSql(sql: string) {
  try {
    const tokens = new Lexer(sql).tokenize();
    const stmt = new Parser(tokens).parse();
    validateKlikeStatement(stmt);
    return stmt;
  } catch (e) {
    if (e instanceof LexError || e instanceof ParseError) {
      throw e; // 日本語エラーメッセージをそのまま伝播
    }
    throw e;
  }
}

/**
 * WhereExpr を再帰的に走査し、SUBQUERY_IN_LIST / SCALAR_SUBQUERY / EXISTS の
 * サブクエリを実行して resolved を埋める（破壊的変更）。
 * 複数のサブクエリは収集後に並列実行する。
 */
async function resolveSubqueries(
  where: WhereExpr | null,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  cteCache?: Map<string, MaterializedTable>
): Promise<void> {
  const tasks: Array<Promise<void>> = [];
  collectSubqueryTasks(where, client, options, cacheContext, tasks, cteCache);
  await Promise.all(tasks);
}

/** SELECT 列 CASE WHEN 内のサブクエリも、射影前に一度だけ解決する。 */
async function resolveSelectCaseSubqueries(
  stmt: SelectStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  cteCache?: Map<string, MaterializedTable>
): Promise<void> {
  const tasks: Promise<void>[] = [];
  for (const column of stmt.columns) {
    if (column.type !== "CASE_COL") continue;
    for (const branch of column.expr.branches) {
      tasks.push(resolveSubqueries(branch.condition, client, options, cacheContext, cteCache));
    }
  }
  await Promise.all(tasks);
}

/**
 * サブクエリ1個を実行する。cteCache がある場合は executeQueryWithCte 経由にし、
 * サブクエリの FROM / JOIN にある CTE / 一時テーブル参照（#name）を解決する。
 */
function runSubquery(
  query: SelectStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  cteCache?: Map<string, MaterializedTable>
): Promise<SelectResult> {
  if (cteCache !== undefined && cteCache.size > 0) {
    return executeQueryWithCte(query, client, options, cteCache, cacheContext);
  }
  return executeSelect(query, client, options, cacheContext);
}

function collectSubqueryTasks(
  where: WhereExpr | null,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  tasks: Array<Promise<void>>,
  cteCache?: Map<string, MaterializedTable>
): void {
  if (where === null) return;
  switch (where.type) {
    case "BINARY": {
      const right = where.right;
      if (right.type === "SUBQUERY_IN_LIST") {
        tasks.push(runSubquery(right.query, client, options, cacheContext, cteCache).then((result) => {
          const col = right.column ?? (result.columns[0] ?? "");
          (right as ResolvedSubqueryInList).resolved = new Set(result.rows.map((r) => r[col] ?? ""));
        }));
      }
      if (right.type === "SCALAR_SUBQUERY") {
        tasks.push(runSubquery(right.query, client, options, cacheContext, cteCache).then((result) => {
          if (result.rowCount === 0) throw new Error("スカラーサブクエリが値を返しませんでした");
          if (result.rowCount > 1)  throw new Error("スカラーサブクエリが複数行を返しました（1行のみ許可）");
          const col = result.columns[0] ?? "";
          (right as ResolvedScalarSubquery).resolved = result.rows[0]?.[col] ?? "";
        }));
      }
      break;
    }
    case "LOGICAL":
      collectSubqueryTasks(where.left,  client, options, cacheContext, tasks, cteCache);
      collectSubqueryTasks(where.right, client, options, cacheContext, tasks, cteCache);
      break;
    case "NOT":
    case "GROUP":
      collectSubqueryTasks(where.expr, client, options, cacheContext, tasks, cteCache);
      break;
    case "EXISTS": {
      const node = where;
      tasks.push(runSubquery(node.query, client, options, cacheContext, cteCache).then((result) => {
        (node as ResolvedExistsExpr).resolved = result.rowCount > 0;
      }));
      break;
    }
  }
}

/**
 * UPDATE SET の各 Assignment を走査し、SCALAR_SUBQUERY 型の value を事前実行して
 * StringLiteral に差し替える（破壊的変更）。
 * 非相関のため 1 回だけ実行され、全対象レコードに同じ値が設定される。
 */
async function resolveSetSubqueries(
  assignments: UpdateStatement["assignments"],
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string
): Promise<void> {
  for (const a of assignments) {
    if (a.value.type !== "SCALAR_SUBQUERY") continue;
    const result = await executeSelect(a.value.query, client, options, cacheContext);
    if (result.rowCount === 0) throw new Error(`SET サブクエリが値を返しませんでした（フィールド: ${a.field}）`);
    if (result.rowCount > 1)  throw new Error(`SET サブクエリが複数行を返しました（フィールド: ${a.field}）`);
    const col = result.columns[0] ?? "";
    const resolved = result.rows[0]?.[col] ?? "";
    // StringLiteral に差し替え → dmlToKintone.ts の変更不要
    a.value = { type: "STRING", value: resolved };
  }
}

/**
 * SELECT 列のスカラーサブクエリを事前実行し、列インデックス → 値のマップを返す。
 * 同一クエリ（AST が一致）は 1 回だけ実行し、異なるクエリは並列実行する。
 * （非相関のため全行同一値）
 */
async function resolveScalarColumns(
  columns: SelectStatement["columns"],
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  cteCache?: Map<string, MaterializedTable>
): Promise<Map<number, string>> {
  const byQuery = new Map<string, Promise<string>>();
  const pending: Array<[number, Promise<string>]> = [];
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    if (col.type !== "SCALAR_SUBQUERY_COL") continue;
    const key = JSON.stringify(col.query);
    let promise = byQuery.get(key);
    if (!promise) {
      promise = runSubquery(col.query, client, options, cacheContext, cteCache).then((result) => {
        if (result.rowCount === 0) throw new Error("スカラーサブクエリが値を返しませんでした");
        if (result.rowCount > 1)  throw new Error("スカラーサブクエリが複数行を返しました（1行のみ許可）");
        const firstCol = result.columns[0] ?? "";
        return result.rows[0]?.[firstCol] ?? "";
      });
      byQuery.set(key, promise);
    }
    pending.push([i, promise]);
  }
  const values = await Promise.all(pending.map(([, promise]) => promise));
  const cache = new Map<number, string>();
  pending.forEach(([i], idx) => cache.set(i, values[idx]));
  return cache;
}

// ============================================================
// EXPLAIN
// ============================================================

interface ExplainWhereAnalysis {
  capabilities: Map<SelectStatement, PredicateCapabilityResult>;
  orderPlans: Map<SelectStatement, CanonicalOrderPlan>;
  fieldApps: Set<number>;
  processStatusApps: Set<number>;
}

async function buildExplainWhereAnalysis(
  query: unknown,
  client: KintoneClient,
  cacheContext: string,
  maxRecords = 10_000
): Promise<ExplainWhereAnalysis> {
  const fieldApps = new Set<number>();
  const processStatusApps = new Set<number>();
  const tracedClient: KintoneClient = {
    ...client,
    getFields: async (appId) => {
      fieldApps.add(appId);
      return client.getFields(appId);
    },
    getProcessStatuses: async (appId) => {
      processStatusApps.add(appId);
      return client.getProcessStatuses(appId);
    },
  };
  const capabilities = new Map<SelectStatement, PredicateCapabilityResult>();
  const orderPlans = new Map<SelectStatement, CanonicalOrderPlan>();
  const seen = new Set<object>();

  const visit = async (node: unknown): Promise<void> => {
    if (node === null || typeof node !== "object") return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      await Promise.all(node.map(visit));
      return;
    }
    const typed = node as Record<string, unknown>;
    if (typed["type"] === "SELECT") {
      const select = node as SelectStatement;
      const physicalApps = [select.from, ...select.joins.map((join) => join.table)]
        .filter((table) => table.cteName === null)
        .map((table) => table.appId);
      const needsWhereSchema = whereNeedsFieldMetadata(select.where);
      if (needsWhereSchema || select.orderBy.length > 0
        || select.columns.some((column) => column.type === "WINDOW_COL" && column.orderBy.length > 0)) {
        physicalApps.forEach((appId) => fieldApps.add(appId));
      }
      const capability = await resolveSelectWhereCapability(select, tracedClient, cacheContext);
      if (capability.capability === "UNSUPPORTED") {
        throw new Error(`ArgumentError: WHERE predicate is unsupported (${formatWhereCapabilityFailure(capability)}).`);
      }
      capabilities.set(select, capability);
      // EXPLAIN は実行 planner と同じ ORDER 意味型も解決する。STATUS なら status.json 依存も記録される。
      if (select.orderBy.length > 0
        || select.columns.some((column) => column.type === "WINDOW_COL" && column.orderBy.length > 0)) {
        const meta = await buildOrderByMetaForSelect(select, tracedClient, cacheContext);
        if (select.orderMode !== "KINTONE_NATIVE") {
          for (const semantics of meta.semantics.values()) {
            if (semantics.fieldType === "STATUS" && semantics.source) {
              processStatusApps.add(semantics.source.appId);
            }
          }
        }
        const hasUnmaterializedSource = [select.from, ...select.joins.map((join) => join.table)]
          .some((table) => table.cteName !== null);
        // batch EXPLAIN は temp/CTE の実体化前には列意味型を確定できない。
        // 実行時 planner は materialized metadata を受けて同じ検査を行う。
        if (hasCanonicalOrder(select) && !hasUnmaterializedSource) {
          const mode = capability.capability === "EXACT_PUSHDOWN"
            ? resolveSelectMode(select)
            : "FULL_SCAN";
          orderPlans.set(select, (select.orderMode === "KINTONE_NATIVE" ? planKorderNative : planCanonicalOrder)({
            stmt: select,
            staticMode: mode,
            whereCapability: capability.capability,
            orderSemantics: meta.semantics,
            maxRecords,
            hasKlike: whereHasKlike(select.where),
          }));
        }
      }
    } else if (typed["type"] === "UPDATE" || typed["type"] === "DELETE") {
      fieldApps.add((node as UpdateStatement | DeleteStatement).appId);
      await assertDmlWhereCapability(
        node as UpdateStatement | DeleteStatement,
        tracedClient,
        cacheContext
      );
    }
    await Promise.all(Object.values(typed).map(visit));
  };

  await visit(query);
  if (typeof query === "object" && query !== null && (query as { type?: string }).type === "WITH"
    && canInlineSingleCte(query as WithStatement)) {
    const inlined = buildInlinedQuery(query as WithStatement);
    const capability = await resolveSelectWhereCapability(inlined, tracedClient, cacheContext);
    if (capability.capability === "UNSUPPORTED") {
      throw new Error(`ArgumentError: WHERE predicate is unsupported (${formatWhereCapabilityFailure(capability)}).`);
    }
    capabilities.set(inlined, capability);
    if (hasCanonicalOrder(inlined)) {
      const meta = await buildOrderByMetaForSelect(inlined, tracedClient, cacheContext);
      orderPlans.set(inlined, (inlined.orderMode === "KINTONE_NATIVE" ? planKorderNative : planCanonicalOrder)({
        stmt: inlined,
        staticMode: capability.capability === "EXACT_PUSHDOWN" ? resolveSelectMode(inlined) : "FULL_SCAN",
        whereCapability: capability.capability,
        orderSemantics: meta.semantics,
        maxRecords,
        hasKlike: whereHasKlike(inlined.where),
      }));
    }
  }
  return { capabilities, orderPlans, fieldApps, processStatusApps };
}

function explainMetadataLines(analysis: ExplainWhereAnalysis): string[] {
  return [
    ...[...analysis.fieldApps].sort((a, b) => a - b)
      .map((appId) => `  metadata API: form definition APP${appId}`),
    ...[...analysis.processStatusApps].sort((a, b) => a - b)
      .map((appId) => `  metadata API: process status APP${appId}`),
  ];
}

// ------------------------------------------------------------
// バッチ EXPLAIN（フェーズ2 M3）
// 全文のプランを配列で返す（dry-run 用途。schema-aware 形は metadata API のみ使用）。
// 一時テーブル参照文は既存の buildSelectPlan に通さず temp-aware に組む
// （resolveSelectMode が cteName 参照を SIMPLE と誤判定し APP0 表示になるため）。
// ------------------------------------------------------------

export interface BatchStatementPlan {
  index: number;
  type: string;
  plan: string[];
}

type BatchExplainResult = {
  statementCount: number;
  statements: BatchStatementPlan[];
};

/** schema-aware planner 形。metadata API 以外の実行 API は呼ばない。 */
export async function buildBatchExplainPlans(
  sql: string,
  client: KintoneClient,
  injectedVariables?: Readonly<Record<string, string>>,
  cacheContext = "batch-explain",
  maxRecords = 10_000
): Promise<BatchExplainResult> {
  const statements = parseSqlBatch(sql);
  const analysis = analyzeBatch(statements); // 未定義参照等はここで拒否
  validateDeclaredBatchVariables(statements, injectedVariables);
  const variables = new Map<string, VarValue>();
  const plans: BatchStatementPlan[] = [];
  for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i];
      const planStmt = stmt.type === "SET_VARIABLE"
        ? (stmt.expr.type === "SCALAR_SUBQUERY"
          ? { ...stmt, expr: resolveVariableRefs(stmt.expr, variables) }
          : stmt)
        : resolveVariableRefs(stmt, variables);
      validateKlikeStatement(planStmt);
      const whereAnalysis = await buildExplainWhereAnalysis(planStmt, client, cacheContext, maxRecords);
      const statementPlan = buildBatchStatementPlan(
        planStmt,
        analysis.statements[i],
        whereAnalysis.capabilities,
        whereAnalysis.orderPlans
      );
      const metadataPlan = explainMetadataLines(whereAnalysis);
      plans.push({
        index: i,
        type: analysis.statements[i].statementType,
        plan: statementPlan.length === 0
          ? metadataPlan
          : [statementPlan[0], ...metadataPlan, ...statementPlan.slice(1)],
      });
      if (stmt.type === "SET_VARIABLE" || stmt.type === "DECLARE_VARIABLE") {
        // EXPLAIN は関数を評価しない。後続プランでは名前を値プレースホルダーとして使う。
        variables.set(stmt.name, { type: "string", value: `@${stmt.name}` });
      }
  }
  return { statementCount: statements.length, statements: plans };
}

function buildBatchStatementPlan(
  stmt: Statement,
  info: BatchAnalysis["statements"][number],
  capabilities?: ReadonlyMap<SelectStatement, PredicateCapabilityResult>,
  orderPlans?: ReadonlyMap<SelectStatement, CanonicalOrderPlan>
): string[] {
  if (stmt.type === "CREATE_TEMP_TABLE") {
    return [
      `CREATE TEMP TABLE ${stmt.name}`,
      `  scope:         batch（バッチ終了時に自動破棄）`,
      `  rows:          実体化前のため不明（既定上限 ${TEMP_TABLE_MAX_ROWS} 行、tempTableMaxRows で変更可、超過はエラー）`,
      ...buildPlanForBatchQuery(stmt.query, info, capabilities, orderPlans).map((l) => `  ${l}`),
    ];
  }
  if (stmt.type === "DROP_TEMP_TABLE") {
    return [
      `DROP TEMP TABLE ${stmt.name}`,
      "  一時テーブルストアの解放のみ（kintone アクセスなし）",
    ];
  }
  if (stmt.type === "SET_VARIABLE") {
    if (stmt.expr.type === "SCALAR_SUBQUERY") {
      const subInfo = hasTempTableRef(stmt.expr.query)
        ? info
        : { ...info, tempTablesReferenced: [] };
      return [
        `SET @${stmt.name} = (SELECT ...)`,
        "  value:         サブクエリを実行時に1回評価（1行1列・バッチ内定数・結果メタデータには非公開）",
        "  subquery:",
        ...buildPlanForBatchQuery(stmt.expr.query, subInfo, capabilities, orderPlans).map((l) => `  ${l}`),
      ];
    }
    return [
      `SET @${stmt.name} = <scalar expression>`,
      "  value:         実行時に1回評価（バッチ内定数・結果メタデータには非公開）",
    ];
  }
  if (stmt.type === "DECLARE_VARIABLE") {
    return [
      `DECLARE @${stmt.name} = <default scalar expression>`,
      "  value:         外部注入があれば採用、なければ既定値を実行時に1回評価（値は非公開）",
    ];
  }
  if (stmt.type === "SHOW_APPS") return ["SHOW APPS（アプリ一覧の取得）"];
  if (stmt.type === "DESCRIBE") return [`DESCRIBE APP${stmt.appId}（フィールド定義の取得）`];
  if (stmt.type === "EXPLAIN") return buildPlanForBatchQuery(stmt.query, info, capabilities, orderPlans);
  if (stmt.type === "ASSERT") {
    const lines: string[] = [
      `ASSERT ${stmt.text}`,
      "  check:         実行時に条件評価（不成立は AssertError でバッチ停止、以降の文は skipped）",
    ];
    const subqueries = [stmt.left, stmt.right, stmt.low, stmt.high].filter(
      (o): o is ScalarSubquery => o !== null && o.type === "SCALAR_SUBQUERY"
    );
    subqueries.forEach((sq, i) => {
      lines.push(subqueries.length > 1 ? `  subquery[${i + 1}]:` : "  subquery:");
      // 参照先で経路が変わるため per-subquery に判定する
      //（temp 参照なしの側を FULL_SCAN 表示にしない）
      const subInfo = hasTempTableRef(sq.query) ? info : { ...info, tempTablesReferenced: [] };
      lines.push(...buildPlanForBatchQuery(sq.query, subInfo, capabilities, orderPlans).map((l) => `  ${l}`));
    });
    return lines;
  }
  return buildPlanForBatchQuery(stmt, info, capabilities, orderPlans);
}

/** AST 内に一時テーブル参照（cteName が "#" 始まり）が含まれるか */
function hasTempTableRef(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasTempTableRef);
  if (node !== null && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const cte = obj["cteName"];
    if (typeof cte === "string" && cte.startsWith("#")) return true;
    return Object.values(obj).some(hasTempTableRef);
  }
  return false;
}

function buildPlanForBatchQuery(
  query: Statement | ExplainStatement["query"],
  info: BatchAnalysis["statements"][number],
  capabilities?: ReadonlyMap<SelectStatement, PredicateCapabilityResult>,
  orderPlans?: ReadonlyMap<SelectStatement, CanonicalOrderPlan>
): string[] {
  // 一時テーブル参照なし → 既存の単文プラン生成をそのまま使う
  if (info.tempTablesReferenced.length === 0) {
    return buildExplainPlan(query as ExplainStatement["query"], undefined, capabilities, orderPlans);
  }
  // 一時テーブル参照あり → FULL_SCAN（インメモリ）であることを明示する
  const lines: string[] = [];
  if (query.type === "INSERT_SELECT") {
    lines.push(
      `INSERT INTO APP${query.appId} ... SELECT（一時テーブルソース。実行時に件数確定 → dmlMaxRows 適用）`
    );
  } else if (query.type === "UPSERT_SELECT") {
    lines.push(
      `UPSERT INTO APP${query.appId} ... SELECT（一時テーブルソース。照合後に insert + update 合計確定 → dmlMaxRows 適用）`
    );
  }
  lines.push("  mode:          FULL_SCAN（一時テーブル参照）");
  lines.push(
    `  temp:          ${info.tempTablesReferenced.join(", ")}（インメモリ走査。実体化前のため行数不明）`
  );
  const apps = info.appIds.filter(
    (a) => (query.type !== "INSERT_SELECT" && query.type !== "UPSERT_SELECT") || a !== query.appId
  );
  if (apps.length > 0) {
    lines.push(`  app:           ${apps.map((a) => `APP${a}`).join(", ")}`);
  }
  lines.push("  note:          一時テーブルへの WHERE プッシュダウンは行われない");
  return lines;
}

async function executeExplain(
  stmt: ExplainStatement,
  client: KintoneClient,
  cacheContext: string,
  maxRecords: number
): Promise<SelectResult> {
  const analysis = await buildExplainWhereAnalysis(stmt.query, client, cacheContext, maxRecords);
  const lines = [
    ...explainMetadataLines(analysis),
    ...buildExplainPlan(stmt.query, undefined, analysis.capabilities, analysis.orderPlans),
  ];
  return {
    type: "SELECT",
    columns: ["plan"],
    rows: lines.map((line) => ({ plan: line })),
    rowCount: lines.length,
  };
}

function buildExplainPlan(
  query: ExplainStatement["query"],
  label?: string,
  capabilities?: ReadonlyMap<SelectStatement, PredicateCapabilityResult>,
  orderPlans?: ReadonlyMap<SelectStatement, CanonicalOrderPlan>
): string[] {
  if (query.type === "UNION")         return buildUnionPlan(query, capabilities, orderPlans);
  if (query.type === "WITH")          return buildWithPlan(query, capabilities, orderPlans);
  if (query.type === "INSERT")        return buildInsertPlan(query, label);
  if (query.type === "INSERT_SELECT") return buildInsertSelectPlan(query, label, capabilities, orderPlans);
  if (query.type === "UPSERT")        return buildUpsertPlan(query, label);
  if (query.type === "UPSERT_SELECT") return buildUpsertSelectPlan(query, label, capabilities, orderPlans);
  if (query.type === "UPDATE")        return buildUpdatePlan(query, label, capabilities, orderPlans);
  if (query.type === "DELETE")        return buildDeletePlan(query, label);
  if (query.type === "REORDER")       return buildReorderPlan(query, label);
  return buildSelectPlan(query, label, capabilities, orderPlans);
}

function buildSelectPlan(
  stmt: SelectStatement,
  label?: string,
  capabilities?: ReadonlyMap<SelectStatement, PredicateCapabilityResult>,
  orderPlans?: ReadonlyMap<SelectStatement, CanonicalOrderPlan>
): string[] {
  const whereCapability = capabilities?.get(stmt) ?? (capabilities
    ? [...capabilities].find(([candidate]) => JSON.stringify(candidate) === JSON.stringify(stmt))?.[1]
    : undefined);
  const orderPlan = orderPlans?.get(stmt) ?? (orderPlans
    ? [...orderPlans].find(([candidate]) => JSON.stringify(candidate) === JSON.stringify(stmt))?.[1]
    : undefined);
  const mode = orderPlan?.kind === "CANONICAL_LOCAL"
    ? "FULL_SCAN"
    : whereCapability && whereCapability.capability !== "EXACT_PUSHDOWN"
      ? "FULL_SCAN"
      : resolveSelectMode(stmt);
  const reasons = collectFullScanReasons(stmt);
  if (whereCapability && whereCapability.capability !== "EXACT_PUSHDOWN") {
    reasons.push(...whereCapability.reasons.map((reason) => reason.code));
  }
  const lines: string[] = [];

  if (label) lines.push(label);
  lines.push(`  mode:          ${mode}`);
  if (orderPlan) {
    lines.push(`  order plan:    ${orderPlan.kind}`);
    if (orderPlan.reasonCodes.length > 0) lines.push(`  order reason:  ${orderPlan.reasonCodes.join(", ")}`);
    if (orderPlan.kind === "KORDER_NATIVE") {
      lines.push("  order semantics: kintone native (not kSQL canonical)");
      lines.push("  REST execution: single GET");
    }
  }
  if (orderPlan?.requiresCompleteInput ?? requiresCompleteInput(stmt)) {
    lines.push("  complete input: required (ORDER BY / window ORDER BY; onLimit=truncate disabled)");
  }
  if (mode === "FULL_SCAN" && reasons.length > 0) {
    lines.push(`  reason:        ${reasons.join(", ")}`);
  }

  if (mode === "SIMPLE") {
    const params = selectToKintoneParams(orderPlan?.kind === "CANONICAL_REST_TOP_N"
      ? withCanonicalRestTie(stmt)
      : stmt);
    lines.push(`  app:           APP${stmt.from.appId} (${stmt.from.appId})`);
    lines.push(`  kintone query: ${params.query || "(なし)"}`);
    lines.push(`  fields:        ${params.fields.length === 0 ? "(全フィールド)" : params.fields.join(", ")}`);
  } else {
    const pushdownPlan = buildKlikePushdownPlan(stmt);
    // メインテーブル
    const mainFields = selectToFetchAllFields(stmt, stmt.from);
    const mainAliasStr = stmt.from.alias ? ` AS ${stmt.from.alias}` : "";
    const mainPushDown = pushdownPlan.mainCondition;
    const mainCandidate = extractMainTypedPushdownCandidate(stmt);
    const exactOriginalWhere = stmt.joins.length === 0
      && whereCapability?.capability === "EXACT_PUSHDOWN"
      && stmt.where !== null
      && !whereRequiresJsEval(stmt.where)
      ? whereToKintone(stmt.where)
      : "";
    const mainQ = mainPushDown !== null
      ? whereToKintone(mainPushDown)
      : exactOriginalWhere || "(全件取得)";
    lines.push(`  app:           APP${stmt.from.appId}${mainAliasStr} (${stmt.from.appId})`);
    lines.push(`  kintone query: ${mainQ}`);
    if (mainCandidate !== null) {
      lines.push(`  pushdown candidate: ${whereToKintone(mainCandidate)}（実行時の型・実在確認待ち）`);
    }
    lines.push(`  fields:        ${mainFields.length === 0 ? "(全フィールド)" : mainFields.join(", ")}`);
    // JOIN テーブル
    for (const join of stmt.joins) {
      const joinFields = selectToFetchAllFields(stmt, join.table);
      const joinAliasStr = join.table.alias ? ` AS ${join.table.alias}` : "";
      const joinType  = join.type === "INNER" ? "JOIN" : `${join.type} JOIN`;
      const joinPushDown = join.table.alias
        ? (pushdownPlan.joinConditions.get(join.table.alias) ?? null)
        : null;
      const joinCandidate = join.table.alias && !join.table.subtableCode && join.table.cteName === null && stmt.where
        ? extractTypedPushdownCandidates(stmt.where, { tableAlias: join.table.alias }) : null;
      const joinQ = joinPushDown !== null
        ? whereToKintone(joinPushDown)
        : "(全件取得)";
      lines.push(`  ${joinType}:        APP${join.table.appId}${joinAliasStr} (${join.table.appId})`);
      lines.push(`  kintone query: ${joinQ}`);
      if (joinCandidate !== null) {
        lines.push(`  pushdown candidate: ${whereToKintone(joinCandidate)}（実行時の型・実在確認待ち）`);
      }
      lines.push(`  fields:        ${joinFields.length === 0 ? "(全フィールド)" : joinFields.join(", ")}`);
    }
  }

  lines.push(...collectSubqueryPlans(stmt, capabilities, orderPlans));
  return lines;
}

function buildUnionPlan(
  stmt: UnionStatement,
  capabilities?: ReadonlyMap<SelectStatement, PredicateCapabilityResult>,
  orderPlans?: ReadonlyMap<SelectStatement, CanonicalOrderPlan>
): string[] {
  // UnionStatement は left / right の二分木 — 左辺を再帰的に展開して全 SELECT を収集
  const selects: SelectStatement[] = [];
  const collect = (u: SelectStatement | UnionStatement): void => {
    if (u.type === "SELECT") { selects.push(u); return; }
    collect(u.left);
    selects.push(u.right);
  };
  collect(stmt);

  const lines: string[] = [];
  selects.forEach((sel, i) => {
    if (i > 0) lines.push("");
    lines.push(...buildSelectPlan(sel, `[union:${i + 1}]`, capabilities, orderPlans));
  });
  return lines;
}

function buildWithPlan(
  stmt: WithStatement,
  capabilities?: ReadonlyMap<SelectStatement, PredicateCapabilityResult>,
  orderPlans?: ReadonlyMap<SelectStatement, CanonicalOrderPlan>
): string[] {
  const lines: string[] = [];
  for (const cte of stmt.ctes) {
    if (cte.query.type === "SELECT") {
      lines.push(...buildSelectPlan(cte.query, `[cte: ${cte.name}]`, capabilities, orderPlans));
      lines.push("");
    }
  }
  if (stmt.query.type === "SELECT" || stmt.query.type === "UNION") {
    lines.push(...buildExplainPlan(stmt.query, "[main]", capabilities, orderPlans));
  }
  if (canInlineSingleCte(stmt)) {
    lines.push("");
    const inlined = buildInlinedQuery(stmt);
    lines.push(...buildSelectPlan(inlined, "[effective: inlined CTE]", capabilities, orderPlans));
  }
  return lines;
}

function collectFullScanReasons(stmt: SelectStatement): string[] {
  const r: string[] = [];
  if (stmt.from.subtableCode || stmt.joins.some((j) => j.table.subtableCode))
    r.push("サブテーブル仮想テーブル");
  if (stmt.joins.length > 0)
    r.push("JOIN あり");
  if (stmt.groupBy.length > 0)
    r.push("GROUP BY あり");
  if (stmt.distinct)
    r.push("DISTINCT あり");
  if (stmt.columns.some((c) => c.type === "AGGREGATE" || c.type === "ARITH_AGG_COL"))
    r.push("集計関数（COUNT / SUM 等）あり");
  if (stmt.columns.some((c) => c.type === "WINDOW_COL"))
    r.push("ウィンドウ関数あり");
  if (stmt.columns.some((c) => c.type === "SCALAR_SUBQUERY_COL"))
    r.push("SELECT 列にスカラーサブクエリ");
  if (whereRequiresJsEval(stmt.where))
    r.push("WHERE 句に JS 評価が必要な式");
  if (whereHasLike(stmt.where))
    r.push("LIKE は常に JS 評価のため全件取得");
  if (stmt.orderBy.some((o) => o.key.type !== "FIELD_NAME"))
    r.push("ORDER BY に式");
  return r;
}

function collectSubqueryPlans(
  stmt: SelectStatement,
  capabilities?: ReadonlyMap<SelectStatement, PredicateCapabilityResult>,
  orderPlans?: ReadonlyMap<SelectStatement, CanonicalOrderPlan>
): string[] {
  const lines: string[] = [];
  let idx = 1;

  const visitWhere = (w: WhereExpr | null): void => {
    if (!w) return;
    switch (w.type) {
      case "BINARY":
        if (w.right.type === "SCALAR_SUBQUERY") {
          lines.push(""); lines.push(...buildSelectPlan(w.right.query, `[subquery:${idx++}]`, capabilities, orderPlans));
        }
        if (w.right.type === "SUBQUERY_IN_LIST") {
          lines.push(""); lines.push(...buildSelectPlan(w.right.query, `[subquery:${idx++}]`, capabilities, orderPlans));
        }
        break;
      case "EXISTS":
        lines.push(""); lines.push(...buildSelectPlan(w.query, `[subquery:${idx++}]`, capabilities, orderPlans));
        break;
      case "LOGICAL":  visitWhere(w.left); visitWhere(w.right); break;
      case "NOT":
      case "GROUP":    visitWhere(w.expr); break;
      case "NULL_CHECK": break;
    }
  };

  visitWhere(stmt.where);

  for (const col of stmt.columns) {
    if (col.type === "SCALAR_SUBQUERY_COL") {
      lines.push(""); lines.push(...buildSelectPlan(col.query, `[subquery:${idx++}]`, capabilities, orderPlans));
    }
  }

  if (stmt.having) visitWhere(stmt.having);

  return lines;
}

// ============================================================
// EXPLAIN — DML プラン
// ============================================================

function buildInsertPlan(stmt: InsertStatement, label?: string): string[] {
  const totalRows   = stmt.values.length;
  const batchCount  = Math.ceil(totalRows / 100);
  const lines: string[] = [];
  if (label) lines.push(label);
  lines.push(`  [INSERT]`);
  lines.push(`  target:  APP${stmt.appId} (${stmt.appId})`);
  lines.push(`  records: ${totalRows} 件（バッチ ${batchCount} 回 × 最大 100 件）`);
  lines.push(`  api:     POST /k/v1/records.json × ${batchCount}`);
  lines.push(`  fields:  ${stmt.fields.join(", ")}`);
  return lines;
}

function buildInsertSelectPlan(
  stmt: InsertSelectStatement,
  label?: string,
  capabilities?: ReadonlyMap<SelectStatement, PredicateCapabilityResult>,
  orderPlans?: ReadonlyMap<SelectStatement, CanonicalOrderPlan>
): string[] {
  const lines: string[] = [];
  if (label) lines.push(label);
  lines.push(`  [INSERT SELECT]`);
  lines.push(`  target:  APP${stmt.appId} (${stmt.appId})`);
  lines.push(`  fields:  ${stmt.fields.join(", ")}`);
  lines.push(`  api:     POST /k/v1/records.json（件数は SELECT 結果に依存、100 件ごとにバッチ）`);
  lines.push("");
  lines.push(...buildSelectPlan(stmt.select, "[source SELECT]", capabilities, orderPlans));
  return lines;
}

function buildUpdatePlan(
  stmt: UpdateStatement,
  label?: string,
  capabilities?: ReadonlyMap<SelectStatement, PredicateCapabilityResult>,
  orderPlans?: ReadonlyMap<SelectStatement, CanonicalOrderPlan>
): string[] {
  const isArith  = hasArithAssignment(stmt);
  const isSubq   = stmt.assignments.some((a) => a.value.type === "SCALAR_SUBQUERY");
  const lines: string[] = [];
  if (label) lines.push(label);
  lines.push(stmt.from ? `  [UPDATE FROM]` : `  [UPDATE]`);
  lines.push(`  target:        APP${stmt.appId} (${stmt.appId})`);
  if (stmt.from) {
    const source = stmt.from.cteName ?? `APP${stmt.from.appId}`;
    lines.push(`  source:        ${source} AS ${stmt.from.alias}`);
    lines.push(`  join:          APP${stmt.appId}.${stmt.from.targetJoinField} = ${stmt.from.alias}.${stmt.from.joinKeyField}`);
    lines.push(`  target filter: ${stmt.from.targetFilter ? safeWhereToKintone(stmt.from.targetFilter) : "(none)"}`);
  } else {
    lines.push(`  kintone query: ${safeWhereToKintone(stmt.where)}`);
  }
  lines.push(`  api:           GET /k/v1/records.json → PUT /k/v1/records.json`);

  const setTypes: string[] = [];
  if (isArith)  setTypes.push("算術 SET（現在値を取得して計算）");
  if (isSubq)   setTypes.push("スカラーサブクエリ SET");
  if (!isArith && !isSubq) setTypes.push("単純 SET");
  lines.push(`  set type:      ${setTypes.join(", ")}`);

  if (isArith) {
    const refFields = collectArithRefFields(stmt);
    if (refFields.length > 0) {
      lines.push(`  ref fields:    ${refFields.join(", ")}（GET に含める）`);
    }
  }
  lines.push(`  set fields:`);
  for (const a of stmt.assignments) {
    lines.push(`    ${formatAssignment(a)}`);
  }

  // サブクエリセクション
  for (const a of stmt.assignments) {
    if (a.value.type === "SCALAR_SUBQUERY") {
      lines.push("");
      lines.push(...buildSelectPlan(a.value.query, `[subquery: ${a.field}]`, capabilities, orderPlans));
    }
  }

  return lines;
}

function buildDeletePlan(stmt: DeleteStatement, label?: string): string[] {
  const lines: string[] = [];
  if (label) lines.push(label);
  lines.push(`  [DELETE]`);
  lines.push(`  target:        APP${stmt.appId} (${stmt.appId})`);
  lines.push(`  kintone query: ${safeWhereToKintone(stmt.where)}`);
  lines.push(`  api:           GET /k/v1/records.json → DELETE /k/v1/records.json`);
  return lines;
}

function buildUpsertPlan(stmt: UpsertStatement, label?: string): string[] {
  const totalRows  = stmt.values.length;
  const batchCount = Math.ceil(totalRows / 100);
  return [
    ...(label ? [label] : []),
    `  [UPSERT]`,
    `  target:     APP${stmt.appId} (${stmt.appId})`,
    `  records:    ${totalRows} 件（バッチ ${batchCount} 回 × 最大 100 件）`,
    `  key fields: ${stmt.keyFields.join(", ")}`,
    `  fields:     ${stmt.fields.join(", ")}`,
    `  api:        GET /k/v1/records.json（重複判定）→ POST または PUT /k/v1/records.json × ${batchCount}`,
  ];
}

function buildUpsertSelectPlan(
  stmt: UpsertSelectStatement,
  label?: string,
  capabilities?: ReadonlyMap<SelectStatement, PredicateCapabilityResult>,
  orderPlans?: ReadonlyMap<SelectStatement, CanonicalOrderPlan>
): string[] {
  const lines: string[] = [
    ...(label ? [label] : []),
    `  [UPSERT SELECT]`,
    `  target:     APP${stmt.appId} (${stmt.appId})`,
    `  key fields: ${stmt.keyFields.join(", ")}`,
    `  fields:     ${stmt.fields.join(", ")}`,
    `  api:        GET /k/v1/records.json（重複判定）→ POST または PUT /k/v1/records.json（100 件ごとにバッチ）`,
    ``,
  ];
  lines.push(...buildSelectPlan(stmt.select, "[source SELECT]", capabilities, orderPlans));
  return lines;
}

function buildReorderPlan(stmt: ReorderStatement, label?: string): string[] {
  const target = `APP${stmt.appId}$${stmt.subtableCode}`;
  const scope   = stmt.all ? "全親レコード対象" : "WHERE 条件に一致する親レコード対象";
  const byStr   = stmt.by.map(formatOrderByItem).join(", ");
  const lines: string[] = [
    ...(label ? [label] : []),
    `  [REORDER]`,
    `  target: APP${stmt.appId} (${stmt.appId})`,
    `  table:  ${target}`,
    `  scope:  ${scope}`,
    `  by:     ${byStr}`,
    `  api:    GET /k/v1/records.json（行 ID 取得）→ PUT /k/v1/records.json（id 配列のみ送信）`,
  ];
  if (!stmt.all && stmt.where) {
    lines.splice(5, 0, `  where:  ${safeWhereToKintone(stmt.where)}`);
  }
  return lines;
}

function formatOrderByItem(item: OrderByItem): string {
  const key = item.key.type === "FIELD_NAME" ? item.key.name : "(式)";
  return `${key} ${item.direction}`;
}

/** whereToKintone が例外を投げる場合（JS 関数含む等）は "(JS 評価)" を返す */
function safeWhereToKintone(where: WhereExpr): string {
  try {
    return whereToKintone(where);
  } catch {
    return "(JS 評価が必要なため kintone クエリに変換不可)";
  }
}

/** UPDATE の算術 SET で参照されるフィールド名を収集する */
function collectArithRefFields(stmt: UpdateStatement): string[] {
  const refs = new Set<string>();
  for (const { value } of stmt.assignments) {
    if (value.type === "ARITH") collectArithNodeRefs(value, refs);
  }
  return [...refs];
}

function collectArithNodeRefs(node: ArithExpr | ArithNode, out: Set<string>): void {
  if (node.type === "FIELD_REF") { out.add(node.field); return; }
  if (node.type === "ARITH") {
    collectArithNodeRefs(node.left, out);
    collectArithNodeRefs(node.right, out);
  }
}

/** Assignment を人が読める形式にフォーマットする */
function formatAssignment(a: Assignment): string {
  const v = a.value;
  if (v.type === "STRING")          return `${a.field} = '${v.value}'`;
  if (v.type === "NUMBER")          return `${a.field} = ${v.value}`;
  if (v.type === "ARITH")           return `${a.field} = ${formatArithExprStr(v)}`;
  if (v.type === "CASE_VALUE")      return `${a.field} = CASE WHEN ...`;
  if (v.type === "SCALAR_SUBQUERY") return `${a.field} = (SELECT ...)`;
  if (v.type === "SOURCE_FIELD")    return `${a.field} = ${v.alias}.${v.field}`;
  return `${a.field} = (${v.type})`;
}

function formatArithExprStr(expr: ArithExpr): string {
  return `${formatArithNodeStr(expr.left)} ${expr.op} ${formatArithNodeStr(expr.right)}`;
}

function formatArithNodeStr(node: ArithNode): string {
  if (node.type === "FIELD_REF") return node.field;
  if (node.type === "NUMBER")    return String(node.value);
  if (node.type === "ARITH")     return `(${formatArithExprStr(node)})`;
  return "...";
}

// ============================================================
// エラー
// ============================================================

export class OperationCancelledError extends Error {
  constructor(
    public readonly operation: "UPDATE" | "DELETE" | "INSERT",
    public readonly affectedCount: number
  ) {
    super(
      `${operation} をキャンセルしました（対象: ${affectedCount} 件）`
    );
    this.name = "OperationCancelledError";
  }
}
