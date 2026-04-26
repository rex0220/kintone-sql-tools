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
import type { SelectStatement, InsertStatement, InsertSelectStatement, UpdateStatement, DeleteStatement, Assignment, ArithExpr, ArithNode, UnionStatement, WithStatement, WhereExpr, FieldValue, ShowAppsStatement, DescribeStatement, UpsertStatement, UpsertSelectStatement, TableRef, ReorderStatement, OrderByKey, OrderByItem, ExplainStatement, CaseWhenExpr, StringFuncExpr, StringFuncArg } from "./types/ast";
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
  | ReorderResult;

export interface SelectResult {
  type: "SELECT";
  rows: ProcessRow[];
  /** SELECT 列定義順のカラム名リスト（表示順保証用） */
  columns: string[];
  /** 実際に返した行数（LIMIT 適用後） */
  rowCount: number;
  /** 実行時警告（例: 上限到達で打ち切り） */
  warnings?: string[];
}

export interface InsertResult {
  type: "INSERT";
  /** 作成されたレコード ID（バッチごと） */
  createdIds: string[][];
  insertedCount: number;
}

export interface UpdateResult {
  type: "UPDATE";
  updatedCount: number;
}

export interface DeleteResult {
  type: "DELETE";
  deletedCount: number;
}

export interface UpsertResult {
  type: "UPSERT";
  insertedCount: number;
  updatedCount: number;
}

export interface ReorderResult {
  type: "REORDER";
  reorderedParentCount: number;
}

// ============================================================
// オプション
// ============================================================

export interface ExecuteOptions {
  /**
   * UPDATE / DELETE 実行前に呼ばれる確認コールバック。
   * false を返すとキャンセルして OperationCancelledError を投げる。
   * 省略時は確認なしで実行。
   */
  confirm?: (count: number, operation: "UPDATE" | "DELETE") => Promise<boolean>;
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
  const cacheContext = options.cacheContext ?? "default";
  // 1. パース
  const stmt = parseSql(sql);

  // 2. 文の種別でルーティング
  switch (stmt.type) {
    case "SELECT":        return executeSelect(stmt, client, options, cacheContext);
    case "UNION":         return executeUnion(stmt, client, options, cacheContext);
    case "WITH":          return executeWith(stmt, client, options, cacheContext);
    case "INSERT":        return executeInsert(stmt, client, cacheContext);
    case "INSERT_SELECT": return executeInsertSelect(stmt, client, options, cacheContext);
    case "UPSERT":        return executeUpsert(stmt, client, options, cacheContext);
    case "UPSERT_SELECT": return executeUpsertSelect(stmt, client, options, cacheContext);
    case "UPDATE":        return executeUpdate(stmt, client, options, cacheContext);
    case "DELETE":        return executeDelete(stmt, client, options, cacheContext);
    case "REORDER":       return executeReorder(stmt, client, options, cacheContext);
    case "SHOW_APPS":     return executeShowApps(client);
    case "DESCRIBE":      return executeDescribe(stmt, client, cacheContext);
    case "EXPLAIN":       return executeExplain(stmt);
  }
}

// ============================================================
// SELECT
// ============================================================

async function executeSelect(
  stmt: SelectStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string
): Promise<SelectResult> {
  if (isNoFromSelect(stmt)) {
    return executeNoFromSelect(stmt);
  }
  const mode = resolveSelectMode(stmt);
  await validateSelectFieldCodes(stmt, mode, client, cacheContext);

  if (mode === "SIMPLE") {
    return executeSimpleSelect(stmt, client, options, cacheContext);
  } else {
    return executeFullScanSelect(stmt, client, options, cacheContext);
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
    const optionOrders = await buildOptionOrdersForSelect(stmt, client, cacheContext);
    const sortKinds = await buildSortKindsForSelect(stmt, client, cacheContext);
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
    if (fields.size === 0) continue;
    const defs = await getFieldsCached(appId, client, cacheContext);
    // フィールド定義が取得できない環境（モック等）では検証をスキップする。
    if (defs.length === 0) continue;
    const validCodes = new Set(defs.map((d) => d.code));
    const unknown = [...fields].filter((f) => !isSystemLikeFieldCode(f) && !validCodes.has(f));
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
  cacheContext: string
): Promise<SelectResult> {
  const maxRecords = options.maxRecords ?? 10_000;
  const warnings = new Set<string>();
  const parallel = options.fetchParallel ?? 1;

  // サブクエリを事前実行（IN (SELECT ...) の値セットを解決）
  await resolveSubqueries(stmt.where,  client, options, cacheContext);
  await resolveSubqueries(stmt.having, client, options, cacheContext);

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

  // メインテーブルを取得
  const mainPushDown = stmt.from.alias ? (tableConditions.get(stmt.from.alias) ?? null) : null;
  const mainRecords = await fetchTableRecordsForFullScan(
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

  // JOIN テーブルを並列取得
  const tables = new Map<string | null, KintoneRecord[]>();
  tables.set(stmt.from.alias, mainRecords);

  const joinFetches = stmt.joins.map(async (join) => {
    const joinPushDown = join.table.alias ? (tableConditions.get(join.table.alias) ?? null) : null;
    const optimized = await tryFetchJoinRecordsBySourceKeys(
      stmt,
      join,
      tables,
      client,
      maxRecords,
      parallel,
      options.onLimitReached ?? "error",
      warnings,
      joinPushDown
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
      joinPushDown
    );
    tables.set(join.table.alias, joinRecords);
  });
  await Promise.all(joinFetches);

  // スカラーサブクエリ列を事前実行してキャッシュ
  const scalarCache = await resolveScalarColumns(stmt.columns, client, options, cacheContext);
  const optionOrders = await buildOptionOrdersForSelect(stmt, client, cacheContext);
  const sortKinds = await buildSortKindsForSelect(stmt, client, cacheContext);

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
  // 左辺を再帰的に実行（ネストした UNION 対応）
  const leftResult: SelectResult = stmt.left.type === "UNION"
    ? await executeUnion(stmt.left, client, options, cacheContext)
    : await executeSelect(stmt.left, client, options, cacheContext);

  const rightResult = await executeSelect(stmt.right, client, options, cacheContext);

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
    const key = columns.map((c) => row[c] ?? "").join("\0");
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
  cacheContext: string
): Promise<SelectResult> {
  // 単純 CTE のインライン化（WHERE プッシュダウン最適化）
  // CTE 本体が SIMPLE モードで最終クエリが単純 SELECT の場合、
  // CTE を展開して WHERE をまとめて REST API に渡す。
  if (canInlineSingleCte(stmt)) {
    return executeSelect(buildInlinedQuery(stmt), client, options, cacheContext);
  }

  // CTE 名 → 結果行のキャッシュ
  const cteCache = new Map<string, ProcessRow[]>();

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
    const leftResult  = await executeQueryWithCte(query.left,  client, options, cteCache, cacheContext);
    const rightResult = await executeQueryWithCte(query.right, client, options, cteCache, cacheContext);
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
    // CTE 参照なし → 通常の SELECT 実行
    return executeSelect(query, client, options, cacheContext);
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

  // サブクエリを事前実行
  await resolveSubqueries(stmt.where,  client, options, cacheContext);
  await resolveSubqueries(stmt.having, client, options, cacheContext);

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

  const scalarCache = await resolveScalarColumns(stmt.columns, client, options, cacheContext);
  const optionOrders = await buildOptionOrdersForSelect(stmt, client, cacheContext);
  const sortKinds = await buildSortKindsForSelect(stmt, client, cacheContext);
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
  cacheContext: string
): Promise<InsertResult> {
  if (stmt.subtableCode) {
    return executeInsertSubtable(stmt, client, cacheContext);
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
  cacheContext: string
): Promise<InsertResult> {
  // 1. SELECT を実行して結果行を取得
  const selectResult = await executeSelect(stmt.select, client, options, cacheContext);
  const { rows, columns } = selectResult;

  // 2. 列数チェック
  if (columns.length !== stmt.fields.length) {
    throw new Error(
      `SELECT の列数（${columns.length}）と INSERT のフィールド数（${stmt.fields.length}）が一致しません`
    );
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
  const maxRecords = options.maxRecords ?? 10_000;

  // 1. 各行のキー条件で既存レコードを一括検索
  //    keyFields が複数の場合は AND 結合、行が複数の場合は OR 結合
  const toInsert: KintoneRecord[] = [];
  const toUpdate: { id: number; record: KintoneRecord }[] = [];

  const fieldTypes = await getFieldTypeMap(stmt.appId, client, cacheContext);

  for (const row of stmt.values) {
    // キーフィールドの値を取り出す
    const keyConditions = stmt.keyFields.map((key) => {
      const idx = stmt.fields.indexOf(key);
      if (idx === -1) throw new Error(`ON DUPLICATE のキー「${key}」が INSERT フィールドに含まれていません`);
      const val = row[idx];
      const valStr = val.type === "STRING" ? val.value
        : val.type === "NUMBER" ? String(val.value)
        : val.type === "CASE_VALUE" ? evalCaseWhen(val.expr, {})
        : val.elements.map((e) => e.value).join(",");
      return `${key} = "${valStr.replace(/"/g, '\\"')}"`;
    });
    const query = keyConditions.join(" and ");

    const existing = await fetchAll(
      client.getRecords,
      stmt.appId,
      query,
      ["$id"],
      { maxRecords, parallel: options.fetchParallel ?? 1 }
    );

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

    if (existing.length > 0) {
      const id = Number(existing[0]["$id"].value);
      toUpdate.push({ id, record });
    } else {
      toInsert.push(record);
    }
  }

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
  _cacheContext: string
): Promise<InsertResult> {
  const subtableCode = stmt.subtableCode!;
  const pidIndex = stmt.fields.indexOf("_pid");
  if (pidIndex < 0) {
    throw new Error("サブテーブル INSERT には _pid が必須です");
  }

  const parents = await fetchAll(client.getRecords, stmt.appId, "", [], { maxRecords: 10_000, parallel: 1 });
  const parentMap = new Map<string, KintoneRecord>();
  for (const p of parents) {
    const pid = String(p["$id"]?.value ?? "");
    if (pid) parentMap.set(pid, p);
  }

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

  for (const [pid, updateMap] of updatesByParent.entries()) {
    const parent = parents.find((p) => String(p["$id"]?.value ?? "") === pid);
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

  for (const [pid, idxs] of byParent.entries()) {
    const parent = parents.find((p) => String(p["$id"]?.value ?? "") === pid);
    if (!parent) continue;
    const rows = getMutableTableRows(parent, subtableCode);
    const rm = new Set(idxs);
    const nextRows = rows.filter((_, i) => !rm.has(i));
    await client.putRecords(buildSubtablePutParams(stmt.appId, pid, getRevision(parent), subtableCode, nextRows));
  }

  return { type: "DELETE", deletedCount: targets.length };
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

  for (const pid of targetParentIds) {
    const parent = parents.find((p) => String(p["$id"]?.value ?? "") === pid);
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
  cacheContext: string
): Promise<UpsertResult> {
  const maxRecords = options.maxRecords ?? 10_000;

  // 1. SELECT を実行して結果行を取得
  const selectResult = await executeSelect(stmt.select, client, options, cacheContext);
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

  for (const row of rows) {
    // レコードを組み立て（SELECT 列 → UPSERT フィールドに位置対応でマップ）
    const record: KintoneRecord = {};
    stmt.fields.forEach((field, i) => {
      record[field] = { value: row[columns[i]] ?? "" };
    });

    // キー条件で既存レコードを検索
    const keyConditions = stmt.keyFields.map((key) => {
      const val = String(record[key]?.value ?? "");
      return `${key} = "${val.replace(/"/g, '\\"')}"`;
    });
    const query = keyConditions.join(" and ");

    const existing = await fetchAll(
      client.getRecords,
      stmt.appId,
      query,
      ["$id"],
      { maxRecords, parallel: options.fetchParallel ?? 1 }
    );

    if (existing.length > 0) {
      toUpdate.push({ id: Number(existing[0]["$id"].value), record });
    } else {
      toInsert.push(record);
    }
  }

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
 * WhereExpr を再帰的に走査し、SUBQUERY_IN_LIST ノードのサブクエリを実行して
 * resolved: Set<string> を埋める（破壊的変更）。
 */
async function resolveSubqueries(
  where: WhereExpr | null,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string
): Promise<void> {
  if (where === null) return;
  switch (where.type) {
    case "BINARY": {
      const right = where.right;
      if (right.type === "SUBQUERY_IN_LIST") {
        const result = await executeSelect(right.query, client, options, cacheContext);
        const col = right.column ?? (result.columns[0] ?? "");
        const resolved = new Set(result.rows.map((r) => r[col] ?? ""));
        (right as ResolvedSubqueryInList).resolved = resolved;
      }
      if (right.type === "SCALAR_SUBQUERY") {
        const result = await executeSelect(right.query, client, options, cacheContext);
        if (result.rowCount === 0) throw new Error("スカラーサブクエリが値を返しませんでした");
        if (result.rowCount > 1)  throw new Error("スカラーサブクエリが複数行を返しました（1行のみ許可）");
        const col = result.columns[0] ?? "";
        (right as ResolvedScalarSubquery).resolved = result.rows[0]?.[col] ?? "";
      }
      break;
    }
    case "LOGICAL":
      await resolveSubqueries(where.left,  client, options, cacheContext);
      await resolveSubqueries(where.right, client, options, cacheContext);
      break;
    case "NOT":
    case "GROUP":
      await resolveSubqueries(where.expr, client, options, cacheContext);
      break;
    case "EXISTS": {
      const result = await executeSelect(where.query, client, options, cacheContext);
      (where as ResolvedExistsExpr).resolved = result.rowCount > 0;
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
 * 同一クエリは 1 回だけ実行（非相関のため全行同一値）。
 */
async function resolveScalarColumns(
  columns: SelectStatement["columns"],
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string
): Promise<Map<number, string>> {
  const cache = new Map<number, string>();
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    if (col.type !== "SCALAR_SUBQUERY_COL") continue;
    const result = await executeSelect(col.query, client, options, cacheContext);
    if (result.rowCount === 0) throw new Error("スカラーサブクエリが値を返しませんでした");
    if (result.rowCount > 1)  throw new Error("スカラーサブクエリが複数行を返しました（1行のみ許可）");
    const firstCol = result.columns[0] ?? "";
    cache.set(i, result.rows[0]?.[firstCol] ?? "");
  }
  return cache;
}

// ============================================================
// EXPLAIN
// ============================================================

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
    public readonly operation: "UPDATE" | "DELETE",
    public readonly affectedCount: number
  ) {
    super(
      `${operation} をキャンセルしました（対象: ${affectedCount} 件）`
    );
    this.name = "OperationCancelledError";
  }
}
