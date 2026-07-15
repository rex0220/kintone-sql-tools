// ============================================================
// INSERT / UPDATE / DELETE AST → kintone API リクエスト変換
//
// kintone API エンドポイント:
//   INSERT → POST   /k/v1/records.json   (最大 100 件/リクエスト)
//   UPDATE → GET    /k/v1/records.json（対象 $id 取得）
//            PUT    /k/v1/records.json
//   DELETE → GET    /k/v1/records.json（対象 $id 取得）
//            DELETE /k/v1/records.json
// ============================================================

import type {
  InsertStatement,
  UpdateStatement,
  DeleteStatement,
  SqlValue,
  ArithExpr,
  ArithNode,
  StringFuncExpr,
  StringFuncArg,
  AggOperand,
  CaseWhenExpr,
  CaseResult,
  WhereExpr,
} from "../types/ast";
import { whereToKintone } from "./whereToKintone";
import { evalWhere, evalCaseWhen, type ProcessRow } from "../engine/evalWhere";
import { evalStringFunc, evalArithExpr } from "../engine/evalFunc";
import { whereHasKlike, whereHasLike } from "../core/like";

function assertDmlWhereIsSafe(where: WhereExpr): void {
  if (whereHasKlike(where)) {
    throw new DmlConvertError(
      "UPDATE / DELETE の WHERE に KLIKE / NOT KLIKE は使用できません。" +
      "kintone キーワード検索の打ち切りを検出できないため、全 DML で安全上拒否しています。"
    );
  }
  if (!whereHasLike(where)) return;
  throw new DmlConvertError(
    "UPDATE / DELETE の WHERE に LIKE / NOT LIKE は使用できません。" +
    "LIKE は kSQL の意味論に従って JS で評価する必要がありますが、親レコード DML には JS 評価経路がないため、安全上拒否しました。" +
    "SELECT で対象レコード番号を確認し、IN または完全一致で対象を指定してください。"
  );
}

// ============================================================
// kintone API リクエスト型
// ============================================================

/** kintone レコードのフィールド値 */
export interface KintoneFieldValue {
  value: string | string[] | Array<{ code: string }>;
}

export type KintoneRecord = Record<string, KintoneFieldValue>;

/**
 * フィールドコード → kintone フィールド型のマップ（getFields() 結果から構築）
 * 例: Map { "担当者" => "USER_SELECT", "タグ" => "CHECK_BOX" }
 */
export type FieldTypeMap = Map<string, string>;

const USER_TYPES  = new Set(["USER_SELECT", "ORGANIZATION_SELECT", "GROUP_SELECT"]);
const ARRAY_TYPES = new Set(["CHECK_BOX", "MULTI_SELECT"]);

// --- POST（INSERT）---

export interface KintonePostParams {
  app: number;
  records: KintoneRecord[];
}

// --- PUT（UPDATE）---

export interface KintoneUpdateRecord {
  id: number;
  revision?: number;
  record: KintoneRecord;
}

export interface KintonePutParams {
  app: number;
  records: KintoneUpdateRecord[];
}

// --- DELETE ---

export interface KintoneDeleteParams {
  app: number;
  ids: number[];
}

// --- GET（UPDATE / DELETE の事前取得）---

export interface KintoneGetForDmlParams {
  app: number;
  query: string;
  fields: string[];   // 通常は ["$id"]、算術式ありは参照フィールドも含む
  totalCount: false;
}

// ============================================================
// INSERT → POST バッチ
// ============================================================

/** INSERT 文を kintone POST リクエストに変換する（100 件ごとに分割）。 */
export function insertToPostBatches(
  stmt: InsertStatement,
  fieldTypes: FieldTypeMap = new Map()
): KintonePostParams[] {
  const allRecords = stmt.values.map((row) =>
    buildInsertRecord(stmt.fields, row, fieldTypes)
  );
  return chunk(allRecords, 100).map((records) => ({
    app: stmt.appId,
    records,
  }));
}

function buildInsertRecord(
  fields: string[],
  row: InsertStatement["values"][number],
  fieldTypes: FieldTypeMap
): KintoneRecord {
  const record: KintoneRecord = {};
  fields.forEach((field, i) => {
    const val = row[i];
    if (val.type === "CASE_VALUE") {
      // CASE WHEN / IF: フィールド参照なしの定数条件のみ有効（空行で評価）
      record[field] = { value: evalCaseWhenValue(val.expr, {}, fieldTypes.get(field)) };
    } else {
      record[field] = { value: toKintoneValue(val, fieldTypes.get(field)) };
    }
  });
  return record;
}

// ============================================================
// UPDATE → GET クエリ + PUT パラメータ
// ============================================================

/**
 * UPDATE の WHERE 句から、対象レコードの $id を取得するための
 * kintone GET クエリを生成する。
 */
export function updateToGetQuery(stmt: UpdateStatement): KintoneGetForDmlParams {
  assertDmlWhereIsSafe(stmt.where);
  return {
    app: stmt.appId,
    query: whereToKintone(stmt.where),
    fields: ["$id"],
    totalCount: false,
  };
}

/**
 * 取得した $id リストと UPDATE 内容から kintone PUT パラメータを生成する。
 * 100 件ごとに分割して返す。
 */
export function updateToPutBatches(
  stmt: UpdateStatement,
  ids: number[],
  fieldTypes: FieldTypeMap = new Map()
): KintonePutParams[] {
  const record = buildUpdateRecord(stmt.assignments, fieldTypes);
  return chunk(ids, 100).map((batch) => ({
    app: stmt.appId,
    records: batch.map((id) => ({ id, record })),
  }));
}

function buildUpdateRecord(
  assignments: UpdateStatement["assignments"],
  fieldTypes: FieldTypeMap
): KintoneRecord {
  const record: KintoneRecord = {};
  for (const { field, value } of assignments) {
    // ARITH / CASE_VALUE は updateToPutBatchesArith で処理するため、ここには到達しない
    if (value.type === "ARITH" || value.type === "CASE_VALUE") continue;
    record[field] = { value: toKintoneValue(value, fieldTypes.get(field)) };
  }
  return record;
}

// ============================================================
// UPDATE（算術式あり）
// ============================================================

/**
 * いずれかの assignment が算術式（ArithExpr）を含むか判定する。
 * true の場合、UPDATE は「現在値取得 → 計算 → PUT」の 2 フェーズで実行する。
 */
export function hasArithAssignment(stmt: UpdateStatement): boolean {
  return stmt.assignments.some(
    (a) => a.value.type === "ARITH" || a.value.type === "CASE_VALUE"
  );
}

/**
 * 算術式 UPDATE 用の GET クエリを生成する。
 * $id に加えて、算術式で参照されるフィールド名も取得対象に含める。
 */
export function updateToGetQueryForArith(stmt: UpdateStatement): KintoneGetForDmlParams {
  assertDmlWhereIsSafe(stmt.where);
  const refFields = new Set<string>();
  for (const { value } of stmt.assignments) {
    if (value.type === "ARITH") {
      collectArithFields(value, refFields);
    } else if (value.type === "CASE_VALUE") {
      collectCaseFields(value.expr, refFields);
    }
  }
  return {
    app: stmt.appId,
    query: whereToKintone(stmt.where),
    fields: ["$id", ...refFields],
    totalCount: false,
  };
}

function collectArithFields(expr: ArithExpr, out: Set<string>): void {
  collectArithNode(expr.left, out);
  collectArithNode(expr.right, out);
}

function collectArithNode(node: ArithNode, out: Set<string>): void {
  if (node.type === "FIELD_REF")        out.add(node.field);
  else if (node.type === "ARITH")       collectArithFields(node, out);
  else if (node.type === "STRING_FUNC") collectStringFuncFields(node, out);
}

function collectStringFuncFields(expr: StringFuncExpr, out: Set<string>): void {
  for (const arg of expr.args) collectStringFuncArgFields(arg, out);
}

function collectStringFuncArgFields(arg: StringFuncArg, out: Set<string>): void {
  if (arg.type === "STRING")      return;
  if (arg.type === "STRING_FUNC") { collectStringFuncFields(arg, out); return; }
  if (arg.type === "AGG_REF" || arg.type === "AGG_ARITH") { collectAggOperandFields(arg, out); return; }
  collectArithNode(arg, out);
}

function collectAggOperandFields(node: AggOperand, out: Set<string>): void {
  if (node.type === "AGG_REF") {
    if (node.arg.type !== "WILDCARD") collectArithNode(node.arg, out);
    return;
  }
  if (node.type === "AGG_ARITH") {
    collectAggOperandFields(node.left, out);
    collectAggOperandFields(node.right, out);
  }
}

function collectCaseResultFields(result: CaseResult, out: Set<string>): void {
  if (result.type === "STRING") return;
  if (result.type === "ARRAY") return; // 配列リテラルはフィールド参照なし
  // ArithNode (FIELD_REF / NUMBER / ARITH / STRING_FUNC) or StringFuncExpr
  collectArithNode(result as ArithNode, out);
}

function collectCaseFields(expr: CaseWhenExpr, out: Set<string>): void {
  for (const branch of expr.branches) {
    collectConditionFields(branch.condition, out);
    collectCaseResultFields(branch.result, out);
  }
  if (expr.elseResult !== null) {
    collectCaseResultFields(expr.elseResult, out);
  }
}

function collectConditionFields(expr: WhereExpr, out: Set<string>): void {
  switch (expr.type) {
    case "BINARY":
      if (expr.left.type === "FIELD")         out.add(expr.left.field);
      else if (expr.left.type === "ARITH_FIELD") collectArithNode(expr.left.expr, out);
      break;
    case "NULL_CHECK":
      if (expr.field.type === "FIELD")        out.add(expr.field.field);
      break;
    case "LOGICAL":
      collectConditionFields(expr.left, out);
      collectConditionFields(expr.right, out);
      break;
    case "NOT":
    case "GROUP":
      collectConditionFields(expr.expr, out);
      break;
  }
}

/**
 * 算術式 UPDATE 用の PUT バッチを生成する。
 * records は GET で取得した生レコード（各レコードに $id と参照フィールドが含まれる）。
 * 算術式は各レコードの現在値を使って評価する。
 */
export function updateToPutBatchesArith(
  stmt: UpdateStatement,
  records: KintoneRecord[],
  fieldTypes: FieldTypeMap = new Map()
): KintonePutParams[] {
  const updateRecords: KintoneUpdateRecord[] = records.map((raw) => {
    const id = Number(raw["$id"].value);
    const row = kintoneRecordToProcessRow(raw);
    const record: KintoneRecord = {};
    for (const { field, value } of stmt.assignments) {
      if (value.type === "ARITH") {
        record[field] = { value: String(evalArith(value, raw)) };
      } else if (value.type === "CASE_VALUE") {
        record[field] = { value: evalCaseWhenValue(value.expr, row, fieldTypes.get(field)) };
      } else {
        record[field] = { value: toKintoneValue(value, fieldTypes.get(field)) };
      }
    }
    return { id, record };
  });
  return chunk(updateRecords, 100).map((batch) => ({
    app: stmt.appId,
    records: batch,
  }));
}

function kintoneRecordToProcessRow(raw: KintoneRecord): ProcessRow {
  return Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [
      k,
      typeof v.value === "string" ? v.value : JSON.stringify(v.value ?? ""),
    ])
  );
}

function evalArith(expr: ArithExpr, raw: KintoneRecord): number {
  const l = resolveArithOperand(expr.left, raw);
  const r = resolveArithOperand(expr.right, raw);
  switch (expr.op) {
    case "+": return l + r;
    case "-": return l - r;
    case "*": return l * r;
    case "/":
      if (r === 0) throw new DmlConvertError("算術式でゼロ除算が発生しました");
      return l / r;
    case "%":
      if (r === 0) throw new DmlConvertError("算術式でゼロ除算が発生しました");
      return l % r;
  }
}

function resolveArithOperand(operand: ArithNode, raw: KintoneRecord): number {
  if (operand.type === "NUMBER") return operand.value;
  if (operand.type === "ARITH")  return evalArith(operand, raw); // ネスト
  if (operand.type === "STRING_FUNC") throw new DmlConvertError(
    "UPDATE SET の算術式では文字列関数はサポートされていません"
  );
  const fieldVal = raw[operand.field]?.value ?? "";
  const n = Number(fieldVal);
  if (Number.isNaN(n)) {
    throw new DmlConvertError(
      `算術式のフィールド "${operand.field}" の値 "${fieldVal}" は数値ではありません`
    );
  }
  return n;
}

// ============================================================
// DELETE → GET クエリ + DELETE パラメータ
// ============================================================

/**
 * DELETE の WHERE 句から、対象レコードの $id を取得するための
 * kintone GET クエリを生成する。
 */
export function deleteToGetQuery(stmt: DeleteStatement): KintoneGetForDmlParams {
  assertDmlWhereIsSafe(stmt.where);
  return {
    app: stmt.appId,
    query: whereToKintone(stmt.where),
    fields: ["$id"],
    totalCount: false,
  };
}

/**
 * 取得した $id リストから kintone DELETE パラメータを生成する。
 * 100 件ごとに分割して返す（kintone の一括削除上限に合わせる）。
 */
export function deleteToDeleteBatches(
  appId: number,
  ids: number[]
): KintoneDeleteParams[] {
  return chunk(ids, 100).map((batch) => ({ app: appId, ids: batch }));
}

// ============================================================
// 共通ヘルパー
// ============================================================

// ============================================================
// 複合フィールド変換ヘルパー
// ============================================================

type KintoneValue = string | string[] | Array<{ code: string }>;

function isUserType(t: string | undefined): boolean  { return USER_TYPES.has(t  ?? ""); }
function isArrayType(t: string | undefined): boolean { return ARRAY_TYPES.has(t ?? ""); }

// ---- 日時変換 -------------------------------------------------------

/**
 * DATETIME フィールド用: ローカル時刻表記 → kintone が要求する UTC ISO 8601 形式
 *
 * 受け付ける入力例:
 *   '2026-04-05 12:00'        → '2026-04-05T03:00:00Z'  (JST 環境)
 *   '2026/04/05 12:00:00'     → '2026-04-05T03:00:00Z'
 *   '2026-04-05T12:00'        → '2026-04-05T03:00:00Z'
 *   '2026-04-05T03:00:00Z'    → そのまま（既に UTC）
 */
function convertToDatetime(raw: string): string {
  if (!raw) return raw;
  // 既に UTC ISO 8601 形式ならそのまま返す
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(raw)) return raw;

  // '/' → '-'、スペース → 'T' に正規化
  let s = raw.replace(/\//g, "-").replace(" ", "T");
  // 秒が省略されている場合は補完: 'T12:00' → 'T12:00:00'
  if (/T\d{2}:\d{2}$/.test(s)) s += ":00";

  const d = new Date(s);  // ローカルタイムとして解釈
  if (isNaN(d.getTime())) return raw; // パース失敗はそのまま返す
  // ミリ秒を除いた UTC 文字列: '2026-04-05T03:00:00Z'
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * DATE フィールド用: 'YYYY/MM/DD' → 'YYYY-MM-DD'
 */
function convertToDate(raw: string): string {
  if (!raw) return raw;
  // 既に YYYY-MM-DD ならそのまま
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return raw.replace(/\//g, "-");
}

// ---- 文字列変換 ------------------------------------------------------

/** 文字列リテラル値をフィールド型に応じて変換する */
function convertString(raw: string, fieldType: string | undefined): KintoneValue {
  if (isUserType(fieldType)) {
    if (raw === "") return [];
    return raw.split(",").map((c) => ({ code: c.trim() }));
  }
  if (isArrayType(fieldType)) {
    if (raw === "") return [];
    return raw.split(",").map((v) => v.trim());
  }
  if (fieldType === "DATETIME") return convertToDatetime(raw);
  if (fieldType === "DATE")     return convertToDate(raw);
  return raw;
}

/** 配列リテラル要素をフィールド型に応じて変換する */
function convertArray(elements: string[], fieldType: string | undefined): KintoneValue {
  if (isUserType(fieldType)) return elements.map((c) => ({ code: c }));
  return elements;   // CHECK_BOX / MULTI_SELECT / 型不明
}

/**
 * CASE WHEN / IF の結果値をフィールド型に応じた KintoneValue に変換する。
 * UPDATE SET（算術式あり）のレコードごと評価で使用する。
 */
function evalCaseResultValue(
  result: CaseResult,
  row: ProcessRow,
  fieldType: string | undefined
): KintoneValue {
  if (result.type === "ARRAY") {
    return convertArray(result.elements.map((e) => e.value), fieldType);
  }
  if (result.type === "STRING") {
    return convertString(result.value, fieldType);
  }
  if (result.type === "STRING_FUNC") {
    return evalStringFunc(result, row);
  }
  // NUMBER / ARITH / FIELD_REF
  return String(evalArithExpr(result as ArithNode, row));
}

export function evalCaseWhenValue(
  expr: CaseWhenExpr,
  row: ProcessRow,
  fieldType: string | undefined
): KintoneValue {
  for (const branch of expr.branches) {
    if (evalWhere(branch.condition, row)) {
      return evalCaseResultValue(branch.result, row, fieldType);
    }
  }
  if (expr.elseResult !== null) {
    return evalCaseResultValue(expr.elseResult, row, fieldType);
  }
  return "";
}

/**
 * SqlValue を kintone API が受け付ける値に変換する。
 * fieldType が USER_SELECT 等の場合は配列形式に変換する。
 */
export function toKintoneValue(value: SqlValue, fieldType?: string): KintoneValue {
  switch (value.type) {
    case "VARIABLE":
      throw new DmlConvertError(`未解決のバッチ変数 @${value.name} があります`);
    case "STRING":
      return convertString(value.value, fieldType);
    case "NUMBER":
      return String(value.value);
    case "ARRAY":
      return convertArray(value.elements.map((e) => e.value), fieldType);
    case "KINTONE_FUNC":
      throw new DmlConvertError(
        `${value.name}() は INSERT / UPDATE の値として使用できません`
      );
    case "IN_LIST":
      throw new DmlConvertError(
        "IN_LIST は INSERT / UPDATE の値として使用できません"
      );
    case "ARITH_VALUE":
      throw new DmlConvertError(
        "算術式は INSERT / UPDATE の値として直接使用できません"
      );
    case "CASE_VALUE":
      throw new DmlConvertError(
        "CASE WHEN は INSERT / UPDATE の値として直接使用できません"
      );
    case "SUBQUERY_IN_LIST":
      throw new DmlConvertError(
        "IN (SELECT ...) は INSERT / UPDATE の値として使用できません"
      );
    case "SCALAR_SUBQUERY":
      throw new DmlConvertError(
        "スカラーサブクエリは INSERT / UPDATE の値として使用できません"
      );
  }
}

/** 配列を n 件ずつのチャンクに分割する */
function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

export class DmlConvertError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DmlConvertError";
  }
}
