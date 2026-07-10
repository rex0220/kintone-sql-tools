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
import type { Statement, SelectStatement, InsertStatement, InsertSelectStatement, UpdateStatement, DeleteStatement, Assignment, ArithExpr, ArithNode, UnionStatement, WithStatement, WhereExpr, FieldValue, ShowAppsStatement, DescribeStatement, UpsertStatement, UpsertSelectStatement, TableRef, ReorderStatement, OrderByKey, OrderByItem, ExplainStatement, CaseWhenExpr, StringFuncExpr, StringFuncArg, AssertStatement, AssertOperand, AssertCompareOp } from "./types/ast";
import { analyzeBatch, BatchAnalysisError, type BatchAnalysis } from "./core/batch";
import { resolveSelectMode, selectToKintoneParams, selectToFetchAllParams, selectToFetchAllFields, hasWhereFunc, SelectMode } from "./converter/selectToKintone";
import { whereToKintone } from "./converter/whereToKintone";
import {
  insertToPostBatches,
  updateToGetQuery,
  updateToPutBatches,
  hasArithAssignment,
  updateToGetQueryForArith,
  updateToPutBatchesArith,
  deleteToGetQuery,
  deleteToDeleteBatches,
  toKintoneValue,
  evalCaseWhenValue,
  KintonePostParams,
  KintonePutParams,
  KintoneDeleteParams,
  FieldTypeMap,
} from "./converter/dmlToKintone";
import { fetchAll, PageFetcher } from "./api/fetchAll";
import {
  fetchRecordsForSharedPlan,
  resolveDmlTargetIds,
} from "./core/optimization/sharedPlanner";
import { extractTableCondition } from "./core/optimization/wherePredicatePushdown";
import {
  runFullScan,
  project,
  flatten,
  ProcessRow,
  applyOrderBy,
  applyLimit,
  OptionOrderMap,
  FieldSortKindMap,
} from "./engine/process";
import { expandSubtableRecords } from "./converter/subtableAdapter";
import type { ResolvedSubqueryInList, ResolvedExistsExpr, ResolvedScalarSubquery } from "./engine/evalWhere";
import { evalWhere, evalCaseWhen } from "./engine/evalWhere";
import { evalArithExpr, evalStringFunc } from "./engine/evalFunc";
import type { KintoneRecord } from "./converter/dmlToKintone";
import type { KintoneGetResponse } from "./api/fetchAll";

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
  | AssertResult;

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

export interface InsertResult {
  type: "INSERT";
  /** 作成されたレコード ID（バッチごと） */
  createdIds: string[][];
  insertedCount: number;
  metrics?: ExecuteMetrics;
}

export interface UpdateResult {
  type: "UPDATE";
  updatedCount: number;
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
  const metrics = createEmptyMetrics();
  const countedClient = wrapClientWithMetrics(client, metrics);
  const startedAt = Date.now();
  const result = await executeStatement(sql, countedClient, options);
  metrics.elapsedMs = Date.now() - startedAt;
  return { ...result, metrics };
}

function createEmptyMetrics(): ExecuteMetrics {
  return {
    getCalls: 0,
    postCalls: 0,
    putCalls: 0,
    deleteCalls: 0,
    fieldCalls: 0,
    appsCalls: 0,
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
  };
}

async function executeStatement(
  sql: string,
  client: KintoneClient,
  options: ExecuteOptions
): Promise<ExecuteResult> {
  const cacheContext = options.cacheContext ?? "default";
  const stmt = parseSql(sql);
  return executeParsedStatement(stmt, client, options, cacheContext);
}

/** パース済み Statement を種別でルーティングして実行する（単文・バッチ共通の入口） */
async function executeParsedStatement(
  stmt: Statement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string
): Promise<ExecuteResult> {
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
    case "EXPLAIN":       return executeExplain(stmt);
    // 一時テーブルはバッチスコープのため単文実行では拒否する（executeBatch を使う）
    case "CREATE_TEMP_TABLE":
      throw new Error("ArgumentError: CREATE TEMP TABLE requires a batch (temp tables are batch-scoped).");
    case "DROP_TEMP_TABLE":
      throw new Error("ArgumentError: DROP TEMP TABLE requires a batch (temp tables are batch-scoped).");
    case "ASSERT":        return executeAssert(stmt, client, options, cacheContext);
  }
}

// ============================================================
// バッチ実行（フェーズ1 S4）
//
// `;` 区切りの複文を validate-all-first（analyzeBatch）で検証した後、
// 順次実行する。一時テーブル（#name）はバッチ内スコープの
// Map<string, ProcessRow[]> に実体化し、CTE キャッシュと同じ機構で
// FULL_SCAN エンジンに注入する。
// ============================================================

/** 一時テーブル1個の実体化行数上限（仕様 §5.6）。onLimitReached は適用せず常に error */
export const TEMP_TABLE_MAX_ROWS = 10_000;

export interface BatchExecuteOptions extends ExecuteOptions {
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
    throw new BatchAnalysisError(
      `ArgumentError: temp table references in ${s.statementType} are not supported yet.`,
      s.index
    );
  }

  const metrics = createEmptyMetrics();
  const countedClient = wrapClientWithMetrics(client, metrics);
  const startedAt = Date.now();
  const deadline = options.timeoutMs != null ? startedAt + options.timeoutMs : null;
  const cacheContext = options.cacheContext ?? "default";

  const tempTables = new Map<string, ProcessRow[]>();
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
      const userConfirm = options.confirm;
      const stmtOptions: BatchExecuteOptions = userConfirm
        ? {
          ...options,
          confirm: (count, operation) => userConfirm(count, operation, {
            statementIndex: i,
            statementCount: statements.length,
            statementType: info.statementType,
            targetAppId: info.targetAppId,
          }),
        }
        : options;
      const outcome = await runWithDeadline(
        executeBatchStatement(statements[i], info, countedClient, stmtOptions, cacheContext, tempTables),
        remaining
      );
      results.push({ ...base, status: "success", ...outcome });
    } catch (e) {
      results.push({ ...base, status: "error", error: toBatchStatementError(e) });
      failed.add(i);
      if (e instanceof BatchTimeoutError) {
        aborted = "timeout";
      } else if (e instanceof AssertError) {
        // ASSERT 失敗は continueOnError を無視して常に停止する（設計判断 D3:
        // ASSERT は後続実行のゲートであり、続行を許すと存在意義が消える）
        aborted = "assertion";
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
  tempTables: Map<string, ProcessRow[]>
): Promise<Partial<BatchStatementResult>> {
  if (stmt.type === "CREATE_TEMP_TABLE") {
    // 実体化は onLimitReached を適用せず常に error
    //（truncate による暗黙の欠損が後続文の結果を静かに歪めるため。仕様 §5.6）
    const materializeOptions: ExecuteOptions = {
      ...options,
      maxRecords: options.tempTableMaxRows ?? TEMP_TABLE_MAX_ROWS,
      onLimitReached: "error",
    };
    const result = await runSelectLike(stmt.query, client, materializeOptions, cacheContext, tempTables);
    tempTables.set(stmt.name, result.rows);
    return { tempTable: stmt.name, rowCount: result.rows.length };
  }

  if (stmt.type === "DROP_TEMP_TABLE") {
    tempTables.delete(stmt.name); // ストアの解放（存在は analyzeBatch が検証済み）
    return { tempTable: stmt.name };
  }

  // EXPLAIN はプラン表示のみ（kintone アクセスなし）のため一時テーブル参照を含んでも安全
  if (stmt.type === "EXPLAIN") {
    return { result: await executeParsedStatement(stmt, client, options, cacheContext) };
  }

  // ASSERT: 成功時は result を持たせない no-result 文として扱う
  //（`result.type !== "SELECT"` → mutation summary 経路への流入を構造的に防ぐ。仕様 §2.3）
  if (stmt.type === "ASSERT") {
    await executeAssert(stmt, client, options, cacheContext, tempTables);
    return {};
  }

  // 一時テーブルを参照する文はストアを注入して実行
  if (info.tempTablesReferenced.length > 0) {
    if (stmt.type === "SELECT" || stmt.type === "UNION") {
      return { result: await executeQueryWithCte(stmt, client, options, tempTables, cacheContext) };
    }
    if (stmt.type === "WITH") {
      return { result: await executeWith(stmt, client, options, cacheContext, tempTables) };
    }
    // SELECT-based DML（ソースは temp のみ / APP 混在とも。事前チェックで検証済み）
    if (stmt.type === "INSERT_SELECT") {
      return { result: await executeInsertSelect(stmt, client, options, cacheContext, tempTables) };
    }
    if (stmt.type === "UPSERT_SELECT") {
      return { result: await executeUpsertSelect(stmt, client, options, cacheContext, tempTables) };
    }
    // ここに来るのは想定外（他の DML 参照は事前チェックで拒否済み）
    throw new Error(`ArgumentError: temp table references in ${stmt.type} are not supported yet.`);
  }

  // 一時テーブルと無関係な文は既存の単文実行経路をそのまま使う
  return { result: await executeParsedStatement(stmt, client, options, cacheContext) };
}

/** CREATE TEMP TABLE の AS 句（SELECT / UNION / WITH）を一時テーブルストア付きで実行する */
async function runSelectLike(
  query: SelectStatement | UnionStatement | WithStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  tempTables: Map<string, ProcessRow[]>
): Promise<SelectResult> {
  if (query.type === "WITH") {
    return executeWith(query, client, options, cacheContext, tempTables);
  }
  return executeQueryWithCte(query, client, options, tempTables, cacheContext);
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

/**
 * ASSERT 文を評価する。条件が false なら AssertError を投げる。
 * サブクエリの一時テーブル参照はバッチ実行時のみ解決できる（tempTables 経由）。
 */
async function executeAssert(
  stmt: AssertStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  tempTables?: Map<string, ProcessRow[]>
): Promise<AssertResult> {
  const left = await evalAssertOperand(stmt.left, client, options, cacheContext, tempTables);

  if (stmt.op === "BETWEEN") {
    if (stmt.low === null || stmt.high === null) {
      throw new Error("ArgumentError: malformed ASSERT statement.");
    }
    const low  = await evalAssertOperand(stmt.low,  client, options, cacheContext, tempTables);
    const high = await evalAssertOperand(stmt.high, client, options, cacheContext, tempTables);
    // WHERE の BETWEEN と同じ >= AND <= 展開
    if (!compareAssertValues(">=", left, low) || !compareAssertValues("<=", left, high)) {
      throw new AssertError(`assertion failed: ${stmt.text} (actual: ${left}).`);
    }
    return { type: "ASSERT", condition: stmt.text };
  }

  if (stmt.right === null) {
    throw new Error("ArgumentError: malformed ASSERT statement.");
  }
  const right = await evalAssertOperand(stmt.right, client, options, cacheContext, tempTables);
  if (!compareAssertValues(stmt.op, left, right)) {
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
  tempTables?: Map<string, ProcessRow[]>
): Promise<string> {
  switch (operand.type) {
    case "NUMBER": return String(operand.value);
    case "STRING": return operand.value;
    case "ARITH":  return String(evalAssertArith(operand));
    case "SCALAR_SUBQUERY": {
      const { query, probed } = withScalarProbeLimit(operand.query);
      const result = await runSubquery(query, client, options, cacheContext, tempTables);
      // SELECT * 等でパース時に列数を静的判定できなかった場合の実行時検証（仕様 §2.2）
      if (result.columns.length > 1) {
        throw new AssertError(
          `scalar subquery returned ${result.columns.length} columns (expected 1 column).`
        );
      }
      if (result.rowCount === 0) {
        throw new AssertError("scalar subquery returned no rows (expected 1 row).");
      }
      if (result.rowCount > 1) {
        // probe（LIMIT 2 打ち切り）時は総行数が分からない
        const rows = probed && result.rowCount === 2 ? "2 or more rows" : `${result.rowCount} rows`;
        throw new AssertError(`scalar subquery returned ${rows} (expected 1 row).`);
      }
      const col = result.columns[0] ?? "";
      return result.rows[0]?.[col] ?? "";
    }
  }
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

/**
 * ASSERT の比較。型規則は既存の WHERE 句比較（evalWhere の evalOp）と同一:
 * = / <> は文字列比較、大小比較は双方が数値に解釈できる場合のみ数値比較。
 */
function compareAssertValues(op: AssertCompareOp, leftStr: string, rightStr: string): boolean {
  const leftNum  = Number(leftStr);
  const rightNum = Number(rightStr);
  const numeric  = !Number.isNaN(leftNum) && !Number.isNaN(rightNum);
  switch (op) {
    case "=":    return leftStr === rightStr;
    case "!=":
    case "<>":   return leftStr !== rightStr;
    case ">":    return numeric ? leftNum > rightNum  : leftStr > rightStr;
    case "<":    return numeric ? leftNum < rightNum  : leftStr < rightStr;
    case ">=":   return numeric ? leftNum >= rightNum : leftStr >= rightStr;
    case "<=":   return numeric ? leftNum <= rightNum : leftStr <= rightStr;
  }
}

// ============================================================
// SELECT
// ============================================================

async function executeSelect(
  stmt: SelectStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  /** CTE / 一時テーブルのキャッシュ。サブクエリ解決に引き継ぐ（トップレベルの
   *  FROM / JOIN 参照は executeQueryWithCte 側で処理済みの前提） */
  cteCache?: Map<string, ProcessRow[]>
): Promise<SelectResult> {
  if (isNoFromSelect(stmt)) {
    return executeNoFromSelect(stmt);
  }
  const mode = resolveSelectMode(stmt);
  await validateSelectFieldCodes(stmt, mode, client, cacheContext);

  if (mode === "SIMPLE") {
    return executeSimpleSelect(stmt, client, options, cacheContext);
  } else {
    return executeFullScanSelect(stmt, client, options, cacheContext, cteCache);
  }
}

function isNoFromSelect(stmt: SelectStatement): boolean {
  return stmt.from.appId === 0 && stmt.from.cteName === "__NO_FROM__";
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
  const { rows: projected, columns } = project([{}], stmt.columns);
  const rows = applyLimit(projected, stmt.limit, stmt.offset);
  return { type: "SELECT", rows, columns, rowCount: rows.length, warnings: [] };
}

/** SIMPLE モード: kintone クエリに変換して GET → project */
async function executeSimpleSelect(
  stmt: SelectStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string
): Promise<SelectResult> {
  const params = selectToKintoneParams(stmt);
  const maxRecords = options.maxRecords ?? 10_000;
  const warnings = new Set<string>();
  const onLimit = options.onLimitReached ?? "error";
  const parallel = options.fetchParallel ?? 1;
  const useSingleGet = params.query.includes("limit") || (stmt.limit !== null && stmt.limit <= 500);

  // kintone は最大 500 件なので LIMIT が 500 以下ならページングは不要
  // LIMIT 指定なし or 500 超の場合は fetchAll を使う
  let records: KintoneRecord[];
  if (useSingleGet) {
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
      params.fields,
      {
        parallel,
        maxRecords,
        onLimit,
        onTruncate: (max) => {
          warnings.add(`取得上限（${max} 件）に達したため、${max} 件で打ち切って表示しています。`);
        },
      }
    );
  }

  let rows = records.map((r) => flatten(r, null));
  if (!useSingleGet) {
    const { optionOrders, sortKinds } = await buildOrderByMetaForSelect(stmt, client, cacheContext);
    rows = applyOrderBy(rows, stmt.orderBy, optionOrders, sortKinds);
    rows = applyLimit(rows, stmt.limit, stmt.offset);
  }
  const { rows: projected, columns } = project(rows, stmt.columns);

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

/** FULL_SCAN モード: 全テーブルを fetchAll → runFullScan パイプライン */
async function executeFullScanSelect(
  stmt: SelectStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  cteCache?: Map<string, ProcessRow[]>
): Promise<SelectResult> {
  const maxRecords = options.maxRecords ?? 10_000;
  const warnings = new Set<string>();
  const parallel = options.fetchParallel ?? 1;

  // サブクエリを事前実行（IN (SELECT ...) の値セットを解決）
  await Promise.all([
    resolveSubqueries(stmt.where,  client, options, cacheContext, cteCache),
    resolveSubqueries(stmt.having, client, options, cacheContext, cteCache),
  ]);

  // テーブルごとの push down 条件を計算
  const tableConditions = new Map<string, WhereExpr>();
  if (stmt.where !== null) {
    if (stmt.from.alias) {
      const cond = extractTableCondition(stmt.where, stmt.from.alias);
      if (cond) tableConditions.set(stmt.from.alias, cond);
    }
    for (const join of stmt.joins) {
      if (join.table.alias) {
        const cond = extractTableCondition(stmt.where, join.table.alias);
        if (cond) tableConditions.set(join.table.alias, cond);
      }
    }
  }

  // メインテーブルのフェッチを開始（await しない）
  const mainPushDown = stmt.from.alias ? (tableConditions.get(stmt.from.alias) ?? null) : null;
  const mainFetch = fetchTableRecordsForFullScan(
    stmt,
    stmt.from,
    client,
    maxRecords,
    parallel,
    true,
    options.onLimitReached ?? "error",
    warnings,
    mainPushDown
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
  const orderByMetaPromise = buildOrderByMetaForSelect(stmt, client, cacheContext);
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
  const { optionOrders, sortKinds } = await orderByMetaPromise;

  // JS 集計パイプライン
  const { rows, columns } = runFullScan({ tables, stmt, scalarCache, optionOrders, sortKinds });

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
  /** バッチ実行時の一時テーブルストア（#name → 行）。CTE キャッシュの初期値として合流する */
  seed?: ReadonlyMap<string, ProcessRow[]>
): Promise<SelectResult> {
  // 単純 CTE のインライン化（WHERE プッシュダウン最適化）
  // CTE 本体が SIMPLE モードで最終クエリが単純 SELECT の場合、
  // CTE を展開して WHERE をまとめて REST API に渡す。
  // 一時テーブル注入時はインライン化しない（CTE 本体が #temp を参照し得るため）
  if ((seed == null || seed.size === 0) && canInlineSingleCte(stmt)) {
    return executeSelect(buildInlinedQuery(stmt), client, options, cacheContext);
  }

  // CTE 名 → 結果行のキャッシュ（一時テーブル名は # 付きのため CTE 名と衝突しない）
  const cteCache = new Map<string, ProcessRow[]>(seed ?? []);

  // 各 CTE を順番に実行し、結果をキャッシュ
  for (const cte of stmt.ctes) {
    let result: SelectResult;
    if (cte.query.type === "SHOW_APPS") {
      result = await executeShowApps(client);
    } else if (cte.query.type === "DESCRIBE") {
      result = await executeDescribe(cte.query, client, cacheContext);
    } else {
      result = await executeQueryWithCte(cte.query, client, options, cteCache, cacheContext);
    }
    cteCache.set(cte.name, result.rows);
  }

  // 最終クエリを CTE キャッシュ付きで実行
  return executeQueryWithCte(stmt.query, client, options, cteCache, cacheContext);
}

// ------------------------------------------------------------
// CTE インライン化ヘルパー
// ------------------------------------------------------------

/**
 * WITH 文が単純 CTE インライン化の条件を満たすか判定する。
 *
 * 条件（すべて満たす場合に true）:
 *   - CTE が 1 つだけ
 *   - CTE 本体が SelectStatement（UNION でない）かつ SIMPLE モード
 *   - 最終クエリが SelectStatement（UNION でない）
 *   - 最終クエリの FROM が CTE 参照のみ（JOIN なし）
 *   - 最終クエリに GROUP BY・集計・DISTINCT がない
 */
function canInlineSingleCte(stmt: WithStatement): boolean {
  if (stmt.ctes.length !== 1) return false;
  const cteDef = stmt.ctes[0];
  if (cteDef.query.type !== "SELECT") return false;
  if (resolveSelectMode(cteDef.query) !== "SIMPLE") return false;

  const finalQuery = stmt.query;
  if (finalQuery.type !== "SELECT") return false;
  if (finalQuery.from.cteName !== cteDef.name) return false;
  if (finalQuery.joins.length > 0) return false;
  if (finalQuery.groupBy.length > 0) return false;
  if (finalQuery.distinct) return false;
  if (finalQuery.columns.some(
    (c) => c.type === "AGGREGATE" || c.type === "ARITH_AGG_COL"
  )) return false;

  return true;
}

/**
 * CTE をインライン化した SelectStatement を構築する。
 *
 * CTE 本体の WHERE と最終クエリの WHERE を AND で結合し、
 * 最終クエリの ORDER BY / LIMIT / OFFSET を優先して使用する。
 * 最終クエリで CTE に付けたエイリアス（AS c 等）はフィールド参照から除去する。
 */
function buildInlinedQuery(stmt: WithStatement): SelectStatement {
  const cteBody  = stmt.ctes[0].query as SelectStatement;
  const final    = stmt.query as SelectStatement;
  const cteAlias = final.from.alias; // FROM cte AS alias の alias

  // 最終 WHERE の CTE エイリアスを除去
  const finalWhere = stripCteAlias(final.where, cteAlias);

  // CTE 本体の WHERE と最終 WHERE を AND でマージ
  let mergedWhere: WhereExpr | null;
  if      (cteBody.where === null) mergedWhere = finalWhere;
  else if (finalWhere    === null) mergedWhere = cteBody.where;
  else mergedWhere = { type: "LOGICAL", op: "AND", left: cteBody.where, right: finalWhere };

  // 列: 最終クエリが WILDCARD のみなら CTE 本体の列を継承
  const columns = final.columns.every((c) => c.type === "WILDCARD")
    ? cteBody.columns
    : final.columns;

  return {
    type:     "SELECT",
    from:     cteBody.from,
    joins:    [],
    columns,
    where:    mergedWhere,
    groupBy:  [],
    having:   null,
    orderBy:  final.orderBy.length > 0 ? final.orderBy : cteBody.orderBy,
    limit:    final.limit  ?? cteBody.limit,
    offset:   final.offset ?? cteBody.offset,
    distinct: false,
  };
}

/**
 * WHERE 式に含まれる FieldRef の tableAlias が指定エイリアスと一致する場合に
 * tableAlias を null に置き換えて返す（CTE エイリアスの除去）。
 */
function stripCteAlias(where: WhereExpr | null, alias: string | null): WhereExpr | null {
  if (where === null || alias === null) return where;
  switch (where.type) {
    case "BINARY":
      return { type: "BINARY", op: where.op,
        left:  stripCteAliasFromFieldValue(where.left, alias),
        right: where.right };
    case "NULL_CHECK":
      return { type: "NULL_CHECK", not: where.not,
        field: stripCteAliasFromFieldValue(where.field, alias) };
    case "LOGICAL":
      return { type: "LOGICAL", op: where.op,
        left:  stripCteAlias(where.left,  alias)!,
        right: stripCteAlias(where.right, alias)! };
    case "NOT":
      return { type: "NOT",   expr: stripCteAlias(where.expr, alias)! };
    case "GROUP":
      return { type: "GROUP", expr: stripCteAlias(where.expr, alias)! };
    case "EXISTS":
      return where; // サブクエリはエイリアス除去対象外
  }
}

function stripCteAliasFromFieldValue(fv: FieldValue, alias: string): FieldValue {
  if (fv.type === "FIELD" && fv.tableAlias === alias) {
    return { type: "FIELD", field: fv.field, tableAlias: null };
  }
  return fv;
}

/**
 * SelectStatement | UnionStatement を CTE キャッシュ付きで実行する。
 * FROM / JOIN が CTE 参照を含む場合は FULL_SCAN モードで CTE 行を注入する。
 */
async function executeQueryWithCte(
  query: SelectStatement | UnionStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cteCache: Map<string, ProcessRow[]>,
  cacheContext: string
): Promise<SelectResult> {
  if (query.type === "UNION") {
    const [leftResult, rightResult] = await Promise.all([
      executeQueryWithCte(query.left,  client, options, cteCache, cacheContext),
      executeQueryWithCte(query.right, client, options, cteCache, cacheContext),
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
    return { type: "SELECT", rows, columns: leftCols, rowCount: rows.length };
  }

  // CTE 参照が FROM か JOIN に含まれるか確認
  const hasCteRef =
    query.from.cteName != null ||
    query.joins.some((j) => j.table.cteName != null);

  if (!hasCteRef) {
    // トップレベルに CTE 参照なし → 通常の SELECT 実行。
    // ただしサブクエリ内の CTE / 一時テーブル参照があり得るため cteCache は引き継ぐ
    return executeSelect(query, client, options, cacheContext, cteCache);
  }

  // CTE 参照あり → FULL_SCAN で CTE 行を注入
  return executeFullScanWithCte(query, client, options, cteCache, cacheContext);
}

/**
 * FROM / JOIN に CTE 参照を含む SELECT を FULL_SCAN モードで実行する。
 * CTE 行は ProcessRow[] → KintoneRecord[] に変換してから runFullScan に渡す。
 */
async function executeFullScanWithCte(
  stmt: SelectStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cteCache: Map<string, ProcessRow[]>,
  cacheContext: string
): Promise<SelectResult> {
  const maxRecords = options.maxRecords ?? 10_000;
  const warnings = new Set<string>();
  const parallel = options.fetchParallel ?? 1;

  // サブクエリを事前実行（サブクエリ内の CTE / 一時テーブル参照にも cteCache を引き継ぐ）
  await Promise.all([
    resolveSubqueries(stmt.where,  client, options, cacheContext, cteCache),
    resolveSubqueries(stmt.having, client, options, cacheContext, cteCache),
  ]);

  // フィールド定義・スカラーサブクエリはレコード取得と並行して解決する
  const scalarCachePromise = resolveScalarColumns(stmt.columns, client, options, cacheContext, cteCache);
  const orderByMetaPromise = buildOrderByMetaForSelect(stmt, client, cacheContext);
  scalarCachePromise.catch(() => { /* 後段の await で再スロー（未処理拒否の抑止のみ） */ });
  orderByMetaPromise.catch(() => { /* 同上 */ });

  const tables = new Map<string | null, KintoneRecord[]>();

  // メインテーブル取得
  if (stmt.from.cteName != null) {
    const rows = cteCache.get(stmt.from.cteName) ?? [];
    tables.set(stmt.from.alias, rows.map(processRowToKintoneRecord));
  } else {
    const mainRecords = await fetchTableRecordsForFullScan(
      stmt,
      stmt.from,
      client,
      maxRecords,
      parallel,
      true,
      options.onLimitReached ?? "error",
      warnings
    );
    tables.set(stmt.from.alias, mainRecords);
  }

  // JOIN テーブル取得
  const joinFetches = stmt.joins.map(async (join) => {
    if (join.table.cteName != null) {
      const rows = cteCache.get(join.table.cteName) ?? [];
      tables.set(join.table.alias, rows.map(processRowToKintoneRecord));
    } else {
      const optimized = await tryFetchJoinRecordsBySourceKeys(
        stmt,
        join,
        tables,
        client,
        maxRecords,
        parallel,
        options.onLimitReached ?? "error",
        warnings
      );
      const joinRecords = optimized ?? await fetchTableRecordsForFullScan(
        stmt,
        join.table,
        client,
        maxRecords,
        parallel,
        false,
        options.onLimitReached ?? "error",
        warnings
      );
      tables.set(join.table.alias, joinRecords);
    }
  });
  await Promise.all(joinFetches);

  const scalarCache = await scalarCachePromise;
  const { optionOrders, sortKinds } = await orderByMetaPromise;
  const { rows, columns } = runFullScan({ tables, stmt, scalarCache, optionOrders, sortKinds });
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
  pushDownCond: WhereExpr | null = null
): Promise<KintoneRecord[]> {
  const fields = selectToFetchAllFields(stmt, table);
  const onTruncate = (max: number): void => {
    warnings.add(`取得上限（${max} 件）に達したため、${max} 件で打ち切って表示しています。`);
  };
  if (!table.subtableCode) {
    const baseQuery = isMainTable ? selectToFetchAllParams(stmt, table.appId).query : "";
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
}

/**
 * ORDER BY の比較に使う選択肢順・ソート種別マップを取得する。
 * ORDER BY がない場合は applyOrderBy が即 return するため、
 * フィールド定義の取得自体をスキップする。
 */
async function buildOrderByMetaForSelect(
  stmt: SelectStatement,
  client: KintoneClient,
  cacheContext: string
): Promise<OrderByMeta> {
  if (stmt.orderBy.length === 0) {
    return { optionOrders: new Map(), sortKinds: new Map() };
  }
  const [optionOrders, sortKinds] = await Promise.all([
    buildOptionOrdersForSelect(stmt, client, cacheContext),
    buildSortKindsForSelect(stmt, client, cacheContext),
  ]);
  return { optionOrders, sortKinds };
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
  /** バッチ実行時の一時テーブルストア（#name → 行）。SELECT ソースの解決に使う */
  cteCache?: Map<string, ProcessRow[]>
): Promise<InsertResult> {
  // 1. SELECT を実行して結果行を取得（一時テーブル参照があれば注入経路で解決）
  const selectResult = cteCache !== undefined && cteCache.size > 0
    ? await executeQueryWithCte(stmt.select, client, options, cteCache, cacheContext)
    : await executeSelect(stmt.select, client, options, cacheContext);
  const { rows, columns } = selectResult;

  // 2. 列数チェック
  if (columns.length !== stmt.fields.length) {
    throw new Error(
      `SELECT の列数（${columns.length}）と INSERT のフィールド数（${stmt.fields.length}）が一致しません`
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
  cacheContext: string
): Promise<UpdateResult> {
  if (stmt.subtableCode) {
    return executeUpdateSubtable(stmt, client, options, cacheContext);
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

// ============================================================
// DELETE
// ============================================================

async function executeDelete(
  stmt: Extract<Awaited<ReturnType<typeof parseSql>>, { type: "DELETE" }>,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string
): Promise<DeleteResult> {
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
  _cacheContext: string
): Promise<UpdateResult> {
  const subtableCode = stmt.subtableCode!;
  if (!hasRidCondition(stmt.where)) {
    throw new Error("サブテーブル UPDATE には _rid 条件が必須です");
  }

  const parents = await fetchAll(
    client.getRecords,
    stmt.appId,
    "",
    [],
    { maxRecords: options.maxRecords ?? 10_000, parallel: options.fetchParallel ?? 1 }
  );
  const expanded = expandRowsForSubtableDml(parents, subtableCode);
  const targets = expanded.filter((r) => evalWhere(stmt.where, r.flat));

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
      updates[a.field] = { value: evalAssignmentValueForSubtable(a.value, t.flat) };
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
  _cacheContext: string
): Promise<DeleteResult> {
  const subtableCode = stmt.subtableCode!;
  if (!hasRidCondition(stmt.where)) {
    throw new Error("サブテーブル DELETE には _rid 条件が必須です");
  }

  const parents = await fetchAll(
    client.getRecords,
    stmt.appId,
    "",
    [],
    { maxRecords: options.maxRecords ?? 10_000, parallel: options.fetchParallel ?? 1 }
  );
  const expanded = expandRowsForSubtableDml(parents, subtableCode);
  const targets = expanded.filter((r) => evalWhere(stmt.where, r.flat));

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
  row: ProcessRow
): string {
  if (value.type === "STRING") return value.value;
  if (value.type === "NUMBER") return String(value.value);
  if (value.type === "ARITH") return String(evalArithExpr(value, row));
  if (value.type === "CASE_VALUE") return evalCaseWhen(value.expr, row);
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
  _cacheContext: string
): Promise<ReorderResult> {
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
    : new Set(expanded.filter((r) => stmt.where && evalWhere(stmt.where, r.flat)).map((r) => r.parentId));

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
    sortable.sort((a, b) => compareByOrder(a.flat, b.flat, stmt.by));
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

function compareByOrder(a: ProcessRow, b: ProcessRow, orderBy: ReorderStatement["by"]): number {
  for (const item of orderBy) {
    const av = evalOrderKeyForRow(item.key, a);
    const bv = evalOrderKeyForRow(item.key, b);
    const an = Number(av);
    const bn = Number(bv);
    const numeric = !Number.isNaN(an) && !Number.isNaN(bn);
    const cmp = numeric ? an - bn : av.localeCompare(bv, "ja");
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
  /** バッチ実行時の一時テーブルストア（#name → 行）。SELECT ソースの解決に使う */
  cteCache?: Map<string, ProcessRow[]>
): Promise<UpsertResult> {
  // 1. SELECT を実行して結果行を取得（一時テーブル参照があれば注入経路で解決）
  const selectResult = cteCache !== undefined && cteCache.size > 0
    ? await executeQueryWithCte(stmt.select, client, options, cteCache, cacheContext)
    : await executeSelect(stmt.select, client, options, cacheContext);
  const { rows, columns } = selectResult;

  if (columns.length !== stmt.fields.length) {
    throw new Error(
      `SELECT の列数（${columns.length}）と UPSERT のフィールド数（${stmt.fields.length}）が一致しません`
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
    return new Parser(tokens).parse();
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
  cteCache?: Map<string, ProcessRow[]>
): Promise<void> {
  const tasks: Array<Promise<void>> = [];
  collectSubqueryTasks(where, client, options, cacheContext, tasks, cteCache);
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
  cteCache?: Map<string, ProcessRow[]>
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
  cteCache?: Map<string, ProcessRow[]>
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
  cteCache?: Map<string, ProcessRow[]>
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

// ------------------------------------------------------------
// バッチ EXPLAIN（フェーズ2 M3）
// 全文のプランを配列で返す（dry-run 用途。kintone アクセスなし）。
// 一時テーブル参照文は既存の buildSelectPlan に通さず temp-aware に組む
// （resolveSelectMode が cteName 参照を SIMPLE と誤判定し APP0 表示になるため）。
// ------------------------------------------------------------

export interface BatchStatementPlan {
  index: number;
  type: string;
  plan: string[];
}

/** `;` 区切りバッチの全文プランを生成する（静的検証込み。実行はしない） */
export function buildBatchExplainPlans(sql: string): {
  statementCount: number;
  statements: BatchStatementPlan[];
} {
  const statements = parseSqlBatch(sql);
  const analysis = analyzeBatch(statements); // 未定義参照等はここで拒否
  return {
    statementCount: statements.length,
    statements: statements.map((stmt, i) => ({
      index: i,
      type: analysis.statements[i].statementType,
      plan: buildBatchStatementPlan(stmt, analysis.statements[i]),
    })),
  };
}

function buildBatchStatementPlan(
  stmt: Statement,
  info: BatchAnalysis["statements"][number]
): string[] {
  if (stmt.type === "CREATE_TEMP_TABLE") {
    return [
      `CREATE TEMP TABLE ${stmt.name}`,
      `  scope:         batch（バッチ終了時に自動破棄）`,
      `  rows:          実体化前のため不明（上限 ${TEMP_TABLE_MAX_ROWS} 行、超過はエラー）`,
      ...buildPlanForBatchQuery(stmt.query, info).map((l) => `  ${l}`),
    ];
  }
  if (stmt.type === "DROP_TEMP_TABLE") {
    return [
      `DROP TEMP TABLE ${stmt.name}`,
      "  一時テーブルストアの解放のみ（kintone アクセスなし）",
    ];
  }
  if (stmt.type === "SHOW_APPS") return ["SHOW APPS（アプリ一覧の取得）"];
  if (stmt.type === "DESCRIBE") return [`DESCRIBE APP${stmt.appId}（フィールド定義の取得）`];
  if (stmt.type === "EXPLAIN") return buildPlanForBatchQuery(stmt.query, info);
  return buildPlanForBatchQuery(stmt, info);
}

function buildPlanForBatchQuery(
  query: Statement | ExplainStatement["query"],
  info: BatchAnalysis["statements"][number]
): string[] {
  // 一時テーブル参照なし → 既存の単文プラン生成をそのまま使う
  if (info.tempTablesReferenced.length === 0) {
    return buildExplainPlan(query as ExplainStatement["query"]);
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

function executeExplain(stmt: ExplainStatement): SelectResult {
  const lines = buildExplainPlan(stmt.query);
  return {
    type: "SELECT",
    columns: ["plan"],
    rows: lines.map((line) => ({ plan: line })),
    rowCount: lines.length,
  };
}

function buildExplainPlan(
  query: ExplainStatement["query"],
  label?: string
): string[] {
  if (query.type === "UNION")         return buildUnionPlan(query);
  if (query.type === "WITH")          return buildWithPlan(query);
  if (query.type === "INSERT")        return buildInsertPlan(query, label);
  if (query.type === "INSERT_SELECT") return buildInsertSelectPlan(query, label);
  if (query.type === "UPSERT")        return buildUpsertPlan(query, label);
  if (query.type === "UPSERT_SELECT") return buildUpsertSelectPlan(query, label);
  if (query.type === "UPDATE")        return buildUpdatePlan(query, label);
  if (query.type === "DELETE")        return buildDeletePlan(query, label);
  if (query.type === "REORDER")       return buildReorderPlan(query, label);
  return buildSelectPlan(query, label);
}

function buildSelectPlan(stmt: SelectStatement, label?: string): string[] {
  const mode = resolveSelectMode(stmt);
  const reasons = collectFullScanReasons(stmt);
  const lines: string[] = [];

  if (label) lines.push(label);
  lines.push(`  mode:          ${mode}`);
  if (mode === "FULL_SCAN" && reasons.length > 0) {
    lines.push(`  reason:        ${reasons.join(", ")}`);
  }

  if (mode === "SIMPLE") {
    const params = selectToKintoneParams(stmt);
    lines.push(`  app:           APP${stmt.from.appId} (${stmt.from.appId})`);
    lines.push(`  kintone query: ${params.query || "(なし)"}`);
    lines.push(`  fields:        ${params.fields.length === 0 ? "(全フィールド)" : params.fields.join(", ")}`);
  } else {
    // メインテーブル
    const mainFields = selectToFetchAllFields(stmt, stmt.from);
    const mainAliasStr = stmt.from.alias ? ` AS ${stmt.from.alias}` : "";
    const mainPushDown = stmt.from.alias && stmt.where
      ? extractTableCondition(stmt.where, stmt.from.alias) : null;
    const mainQ = mainPushDown !== null
      ? whereToKintone(mainPushDown)
      : "(全件取得)";
    lines.push(`  app:           APP${stmt.from.appId}${mainAliasStr} (${stmt.from.appId})`);
    lines.push(`  kintone query: ${mainQ}`);
    lines.push(`  fields:        ${mainFields.length === 0 ? "(全フィールド)" : mainFields.join(", ")}`);
    // JOIN テーブル
    for (const join of stmt.joins) {
      const joinFields = selectToFetchAllFields(stmt, join.table);
      const joinAliasStr = join.table.alias ? ` AS ${join.table.alias}` : "";
      const joinType  = join.type === "INNER" ? "JOIN" : `${join.type} JOIN`;
      const joinPushDown = join.table.alias && stmt.where
        ? extractTableCondition(stmt.where, join.table.alias) : null;
      const joinQ = joinPushDown !== null
        ? whereToKintone(joinPushDown)
        : "(全件取得)";
      lines.push(`  ${joinType}:        APP${join.table.appId}${joinAliasStr} (${join.table.appId})`);
      lines.push(`  kintone query: ${joinQ}`);
      lines.push(`  fields:        ${joinFields.length === 0 ? "(全フィールド)" : joinFields.join(", ")}`);
    }
  }

  lines.push(...collectSubqueryPlans(stmt));
  return lines;
}

function buildUnionPlan(stmt: UnionStatement): string[] {
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
    lines.push(...buildSelectPlan(sel, `[union:${i + 1}]`));
  });
  return lines;
}

function buildWithPlan(stmt: WithStatement): string[] {
  const lines: string[] = [];
  for (const cte of stmt.ctes) {
    if (cte.query.type === "SELECT") {
      lines.push(...buildSelectPlan(cte.query, `[cte: ${cte.name}]`));
      lines.push("");
    }
  }
  if (stmt.query.type === "SELECT" || stmt.query.type === "UNION") {
    lines.push(...buildExplainPlan(stmt.query, "[main]"));
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
  if (stmt.columns.some((c) => c.type === "SCALAR_SUBQUERY_COL"))
    r.push("SELECT 列にスカラーサブクエリ");
  if (hasWhereFunc(stmt.where))
    r.push("WHERE 句に JS 評価が必要な式");
  if (stmt.orderBy.some((o) => o.key.type !== "FIELD_NAME"))
    r.push("ORDER BY に式");
  return r;
}

function collectSubqueryPlans(stmt: SelectStatement): string[] {
  const lines: string[] = [];
  let idx = 1;

  const visitWhere = (w: WhereExpr | null): void => {
    if (!w) return;
    switch (w.type) {
      case "BINARY":
        if (w.right.type === "SCALAR_SUBQUERY") {
          lines.push(""); lines.push(...buildSelectPlan(w.right.query, `[subquery:${idx++}]`));
        }
        if (w.right.type === "SUBQUERY_IN_LIST") {
          lines.push(""); lines.push(...buildSelectPlan(w.right.query, `[subquery:${idx++}]`));
        }
        break;
      case "EXISTS":
        lines.push(""); lines.push(...buildSelectPlan(w.query, `[subquery:${idx++}]`));
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
      lines.push(""); lines.push(...buildSelectPlan(col.query, `[subquery:${idx++}]`));
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
  lines.push(`  app:     APP${stmt.appId} (${stmt.appId})`);
  lines.push(`  records: ${totalRows} 件（バッチ ${batchCount} 回 × 最大 100 件）`);
  lines.push(`  api:     POST /k/v1/records.json × ${batchCount}`);
  lines.push(`  fields:  ${stmt.fields.join(", ")}`);
  return lines;
}

function buildInsertSelectPlan(stmt: InsertSelectStatement, label?: string): string[] {
  const lines: string[] = [];
  if (label) lines.push(label);
  lines.push(`  [INSERT SELECT]`);
  lines.push(`  app:     APP${stmt.appId} (${stmt.appId})`);
  lines.push(`  fields:  ${stmt.fields.join(", ")}`);
  lines.push(`  api:     POST /k/v1/records.json（件数は SELECT 結果に依存、100 件ごとにバッチ）`);
  lines.push("");
  lines.push(...buildSelectPlan(stmt.select, "[source SELECT]"));
  return lines;
}

function buildUpdatePlan(stmt: UpdateStatement, label?: string): string[] {
  const isArith  = hasArithAssignment(stmt);
  const isSubq   = stmt.assignments.some((a) => a.value.type === "SCALAR_SUBQUERY");
  const lines: string[] = [];
  if (label) lines.push(label);
  lines.push(`  [UPDATE]`);
  lines.push(`  app:           APP${stmt.appId} (${stmt.appId})`);
  lines.push(`  kintone query: ${safeWhereToKintone(stmt.where)}`);
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
      lines.push(...buildSelectPlan(a.value.query, `[subquery: ${a.field}]`));
    }
  }

  return lines;
}

function buildDeletePlan(stmt: DeleteStatement, label?: string): string[] {
  const lines: string[] = [];
  if (label) lines.push(label);
  lines.push(`  [DELETE]`);
  lines.push(`  app:           APP${stmt.appId} (${stmt.appId})`);
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
    `  app:        APP${stmt.appId} (${stmt.appId})`,
    `  records:    ${totalRows} 件（バッチ ${batchCount} 回 × 最大 100 件）`,
    `  key fields: ${stmt.keyFields.join(", ")}`,
    `  fields:     ${stmt.fields.join(", ")}`,
    `  api:        GET /k/v1/records.json（重複判定）→ POST または PUT /k/v1/records.json × ${batchCount}`,
  ];
}

function buildUpsertSelectPlan(stmt: UpsertSelectStatement, label?: string): string[] {
  const lines: string[] = [
    ...(label ? [label] : []),
    `  [UPSERT SELECT]`,
    `  app:        APP${stmt.appId} (${stmt.appId})`,
    `  key fields: ${stmt.keyFields.join(", ")}`,
    `  fields:     ${stmt.fields.join(", ")}`,
    `  api:        GET /k/v1/records.json（重複判定）→ POST または PUT /k/v1/records.json（100 件ごとにバッチ）`,
    ``,
  ];
  lines.push(...buildSelectPlan(stmt.select, "[source SELECT]"));
  return lines;
}

function buildReorderPlan(stmt: ReorderStatement, label?: string): string[] {
  const target = `APP${stmt.appId}$${stmt.subtableCode}`;
  const scope   = stmt.all ? "全親レコード対象" : "WHERE 条件に一致する親レコード対象";
  const byStr   = stmt.by.map(formatOrderByItem).join(", ");
  const lines: string[] = [
    ...(label ? [label] : []),
    `  [REORDER]`,
    `  app:    APP${stmt.appId} (${stmt.appId})`,
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
