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
  LegacyArithExpr,
  ArithNode,
  StringFuncExpr,
  StringFuncArg,
  AggOperand,
  CaseWhenExpr,
  CaseResult,
  WhereExpr,
  ScalarValueExpr,
} from "../types/ast";
import { collectCheckFieldRefs } from "../core/dmlCustomCheck";
import { numberLiteralText } from "../types/ast";
import { whereToKintone } from "./whereToKintone";
import { evalWhere, evalCaseWhen, type ProcessRow } from "../engine/evalWhere";
import { evalStringFunc, evalArithExpr, evalScalarValueExpr } from "../engine/evalFunc";
import { whereHasLike } from "../core/like";

function assertDmlWhereIsSafe(where: WhereExpr): void {
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
  const checkFields = collectUpdateCheckTargetFields(stmt);
  return {
    app: stmt.appId,
    query: whereToKintone(stmt.where),
    fields: ["$id", ...checkFields],
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
    // 行評価が必要な値は updateToPutBatchesArith で処理するため、ここには到達しない
    if (value.type === "ARITH" || value.type === "SCALAR_ARITH" || value.type === "CONCAT_OP" || value.type === "CASE_VALUE" || value.type === "STRING_FUNC" || value.type === "SOURCE_FIELD") continue;
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
    (a) => a.value.type === "ARITH" || a.value.type === "SCALAR_ARITH" || a.value.type === "CONCAT_OP" || a.value.type === "CASE_VALUE"
  );
}

/** 現在のレコードを取得して行ごとに評価する assignment を含むか。 */
export function hasRowDependentAssignment(stmt: UpdateStatement): boolean {
  return stmt.assignments.some(
    (a) => a.value.type === "ARITH" || a.value.type === "SCALAR_ARITH" || a.value.type === "CONCAT_OP" || a.value.type === "CASE_VALUE" || a.value.type === "STRING_FUNC"
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
    } else if (value.type === "SCALAR_ARITH" || value.type === "CONCAT_OP") {
      collectScalarValueFields(value, refFields);
    } else if (value.type === "STRING_FUNC") {
      collectStringFuncFields(value, refFields);
    } else if (value.type === "CASE_VALUE") {
      collectCaseFields(value.expr, refFields);
    }
  }
  collectUpdateCheckTargetFields(stmt).forEach((field) => refFields.add(field));
  return {
    app: stmt.appId,
    query: whereToKintone(stmt.where),
    fields: ["$id", ...refFields],
    totalCount: false,
  };
}

function collectArithFields(expr: LegacyArithExpr, out: Set<string>): void {
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
  if (arg.type === "AGG_REF" || arg.type === "AGG_ARITH") { collectAggOperandFields(arg, out); return; }
  collectScalarValueFields(arg, out);
}

function collectScalarValueFields(expr: ScalarValueExpr, out: Set<string>): void {
  if (expr.type === "FIELD") { out.add(expr.tableAlias ? `${expr.tableAlias}.${expr.field}` : expr.field); return; }
  if (expr.type === "STRING_FUNC") { collectStringFuncFields(expr, out); return; }
  if (expr.type === "SCALAR_ARITH" || expr.type === "CONCAT_OP") {
    collectScalarValueFields(expr.left, out);
    collectScalarValueFields(expr.right, out);
    return;
  }
  if (expr.type === "CASE_WHEN") collectCaseFields(expr, out);
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
  if (result.type === "ARRAY") return; // 配列リテラルはフィールド参照なし
  if (result.type === "FIELD_REF" || result.type === "ARITH") { collectArithNode(result, out); return; }
  collectScalarValueFields(result, out);
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
    case "EXISTS":
    case "BOOLEAN":
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
      record[field] = {
        value: evaluateUpdateAssignmentValue(value, row, fieldTypes.get(field), raw),
      };
    }
    return { id, record };
  });
  return chunk(updateRecords, 100).map((batch) => ({
    app: stmt.appId,
    records: batch,
  }));
}

/**
 * UPDATE の SET 右辺を更新前行だけから評価する pure helper。
 * B44 planner と従来 UPDATE が同じ評価 primitive を共有する。
 */
export function evaluateUpdateAssignmentValue(
  value: UpdateStatement["assignments"][number]["value"],
  row: ProcessRow,
  fieldType?: string,
  raw?: KintoneRecord
): KintoneValue {
  if (value.type === "ARITH") {
    return String(raw ? evalArith(value, raw) : evalArithExpr(value, row));
  }
  if (value.type === "SCALAR_ARITH" || value.type === "CONCAT_OP") {
    return String(evalScalarValueExpr(value, row));
  }
  if (value.type === "STRING_FUNC") return evalStringFunc(value, row);
  if (value.type === "CASE_VALUE") return evalCaseWhenValue(value.expr, row, fieldType);
  if (value.type === "SOURCE_FIELD") {
    throw new DmlConvertError("SOURCE_FIELD は UPDATE ... FROM 専用です");
  }
  return toKintoneValue(value, fieldType);
}

/** 従来サブテーブル UPDATE と APPLY PATCH が共有する限定 evaluator。 */
export function evaluateSubtableAssignmentValue(
  value: UpdateStatement["assignments"][number]["value"],
  row: ProcessRow,
  resolveFieldType?: import("../engine/evalWhere").FieldTypeResolver
): string {
  if (value.type === "STRING") return value.value;
  if (value.type === "NUMBER") return numberLiteralText(value);
  if (value.type === "ARITH") return String(evalArithExpr(value, row));
  if (value.type === "CASE_VALUE") return evalCaseWhen(value.expr, row, resolveFieldType);
  throw new Error(`${value.type} はサブテーブル UPDATE の値として使用できません`);
}

const UPDATE_FROM_UNSUPPORTED_TYPES = new Set([
  "CHECK_BOX",
  "MULTI_SELECT",
  "USER_SELECT",
  "ORGANIZATION_SELECT",
  "GROUP_SELECT",
  "FILE",
]);

export interface UpdateFromMatchedRecord {
  target: KintoneRecord;
  source: ProcessRow;
}

/** UPDATE ... FROM 用の全 PUT データを構築する。呼び出し後はローカル変換エラーが残らない。 */
export function updateFromToPutBatches(
  stmt: UpdateStatement,
  matched: UpdateFromMatchedRecord[],
  fieldTypes: FieldTypeMap = new Map()
): KintonePutParams[] {
  const updateRecords: KintoneUpdateRecord[] = matched.map(({ target, source }) => {
    const id = Number(target["$id"]?.value);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new DmlConvertError("UPDATE ... FROM の対象レコード番号が不正です");
    }
    const targetRow = kintoneRecordToProcessRow(target);
    const record: KintoneRecord = {};
    for (const { field, value } of stmt.assignments) {
      const fieldType = fieldTypes.get(field);
      if (value.type === "SOURCE_FIELD") {
        if (UPDATE_FROM_UNSUPPORTED_TYPES.has(fieldType ?? "")) {
          throw new DmlConvertError(`UPDATE ... FROM の SOURCE_FIELD は ${fieldType} フィールドに対応していません（フィールド: ${field}）`);
        }
        if (!Object.prototype.hasOwnProperty.call(source, value.field)) {
          throw new DmlConvertError(`UPDATE ... FROM のソース列 ${value.field} が存在しません`);
        }
        const raw = source[value.field];
        if (typeof raw !== "string") {
          throw new DmlConvertError(`UPDATE ... FROM の SOURCE_FIELD はスカラー値のみ対応しています（列: ${value.field}）`);
        }
        if ((fieldType === "NUMBER" || fieldType === "CALC") && raw !== "" && !Number.isFinite(Number(raw))) {
          throw new DmlConvertError(`数値フィールド ${field} に変換できない値です: ${raw}`);
        }
        record[field] = { value: toKintoneValue({ type: "STRING", value: raw }, fieldType) };
      } else if (value.type === "STRING_FUNC") {
        throw new DmlConvertError("UPDATE ... FROM の SET では文字列関数を直接使用できません");
      } else if (value.type === "ARITH") {
        record[field] = { value: String(evalArith(value, target)) };
      } else if (value.type === "SCALAR_ARITH" || value.type === "CONCAT_OP") {
        record[field] = { value: String(evalScalarValueExpr(value, targetRow)) };
      } else if (value.type === "CASE_VALUE") {
        record[field] = { value: evalCaseWhenValue(value.expr, targetRow, fieldType) };
      } else {
        record[field] = { value: toKintoneValue(value, fieldType) };
      }
    }
    return { id, record };
  });
  return chunk(updateRecords, 100).map((records) => ({ app: stmt.appId, records }));
}

function kintoneRecordToProcessRow(raw: KintoneRecord): ProcessRow {
  return Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [
      k,
      typeof v.value === "string" ? v.value : JSON.stringify(v.value ?? ""),
    ])
  );
}

function evalArith(expr: LegacyArithExpr, raw: KintoneRecord): number {
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

export type KintoneValue = string | string[] | Array<{ code: string }>;

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
  if (result.type === "FIELD_REF" || result.type === "ARITH") {
    return String(evalArithExpr(result, row));
  }
  return String(evalScalarValueExpr(result, row));
}

function collectUpdateCheckTargetFields(stmt: UpdateStatement): string[] {
  if (!stmt.checkGroups) return [];
  const targetAlias = `app${stmt.appId}`.toLowerCase();
  return [...new Set(collectCheckFieldRefs(stmt.checkGroups)
    .filter((ref) => ref.tableAlias === null || ref.tableAlias.toLowerCase() === targetAlias)
    .map((ref) => ref.field)
    .filter((field) => field !== "$id"))];
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
  const result = normalizeDmlSqlValue(value, fieldType);
  if (!result.ok) throw new DmlConvertError(result.message);
  return result.value;
}

export type DmlSqlValueNormalization =
  | { ok: true; value: KintoneValue }
  | { ok: false; message: string };

/** throwしない正規化primitive。VALIDATE ONLYと従来converterが共有する。 */
export function normalizeDmlSqlValue(value: SqlValue, fieldType?: string): DmlSqlValueNormalization {
  try {
    return { ok: true, value: convertDmlSqlValue(value, fieldType) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

function convertDmlSqlValue(value: SqlValue, fieldType?: string): KintoneValue {
  switch (value.type) {
    case "VARIABLE":
      throw new DmlConvertError(`未解決のバッチ変数 @${value.name} があります`);
    case "VARIABLE_IN_LIST":
      throw new DmlConvertError(`未解決の配列変数 @${value.name} があります`);
    case "STRING":
      return convertString(value.value, fieldType);
    case "NUMBER":
      return numberLiteralText(value);
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
