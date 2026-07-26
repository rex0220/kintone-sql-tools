// ============================================================
// WHERE AST → kintone クエリ文字列 変換
//
// kintone クエリ構文リファレンス:
//   field = "value"
//   field != "value"
//   field > 100
//   field like "keyword"
//   field in ("v1","v2")
//   field = ""          ← IS NULL に相当
//   field != ""         ← IS NOT NULL に相当
//   (expr) and (expr)
//   (expr) or (expr)
//   TODAY() / NOW() / LOGINUSER()  ← kintone 専用関数
// ============================================================

import { pushDownNot } from "../engine/pushDownNot";
import { isLike } from "../core/like";
import type {
  WhereExpr,
  BinaryExpr,
  NullCheckExpr,
  LogicalExpr,
  NotExpr,
  GroupExpr,
  SqlValue,
  FieldValue,
  StringLiteral,
  NumberLiteral,
  KintoneFunction,
  RelativeDateFunction,
  InList,
  CompareOp,
} from "../types/ast";
import { numberLiteralText } from "../types/ast";

// ------------------------------------------------------------
// エントリポイント
// ------------------------------------------------------------

/**
 * WhereExpr を kintone クエリ文字列に変換する。
 * 例: { type: "BINARY", op: "=", left: {field:"ステータス"}, right: {value:"完了"} }
 *   → 'ステータス = "完了"'
 */
export function whereToKintone(expr: WhereExpr): string {
  switch (expr.type) {
    case "BINARY":    return convertBinary(expr);
    case "NULL_CHECK": return convertNullCheck(expr);
    case "LOGICAL":   return convertLogical(expr);
    case "NOT":       return convertNot(expr);
    case "GROUP":     return convertGroup(expr);
    case "EXISTS":    throw new KintoneQueryError("EXISTS は kintone クエリに変換できません");
    case "BOOLEAN":   throw new KintoneQueryError("internal error: BOOLEAN predicate reached kintone query conversion");
  }
}

// ------------------------------------------------------------
// BinaryExpr: field op value
// ------------------------------------------------------------

function convertBinary(expr: BinaryExpr): string {
  if (isLike(expr)) {
    throw new KintoneQueryError(
      "LIKE / NOT LIKE は kintone クエリに変換できません（常に JS 評価が必要です）"
    );
  }
  const left = convertField(expr.left);
  const op = convertOp(expr.op);
  const right = convertValue(expr.right, expr.op);
  return `${left} ${op} ${right}`;
}

/**
 * SQL 演算子 → kintone 演算子
 *
 * | SQL        | kintone  |
 * |------------|----------|
 * | =          | =        |
 * | != / <>    | !=       |
 * | > / < / >= / <= | そのまま |
 * | LIKE       | like     |
 * | IN         | in       |
 */
function convertOp(op: CompareOp): string {
  switch (op) {
    case "=":    return "=";
    case "!=":
    case "<>":   return "!=";
    case ">":    return ">";
    case "<":    return "<";
    case ">=":   return ">=";
    case "<=":   return "<=";
    case "LIKE":     return "like";
    case "NOT_LIKE": return "not like";
    case "KLIKE":     return "like";
    case "NOT_KLIKE": return "not like";
    case "IN":       return "in";
    case "NOT_IN":   return "not in";
  }
}

// ------------------------------------------------------------
// NullCheckExpr: IS NULL / IS NOT NULL
// ------------------------------------------------------------

/**
 * IS NULL     → field = ""
 * IS NOT NULL → field != ""
 */
function convertNullCheck(expr: NullCheckExpr): string {
  const field = convertField(expr.field);
  return expr.not ? `${field} != ""` : `${field} = ""`;
}

// ------------------------------------------------------------
// LogicalExpr: AND / OR
// ------------------------------------------------------------

function convertLogical(expr: LogicalExpr): string {
  const left = whereToKintone(expr.left);
  const right = whereToKintone(expr.right);
  const op = expr.op === "AND" ? "and" : "or";

  // AND/OR が混在するときの括弧付与
  // 子が LogicalExpr の場合、優先度が変わる可能性があるため括弧で包む
  const leftStr = needsParens(expr.left) ? `(${left})` : left;
  const rightStr = needsParens(expr.right) ? `(${right})` : right;

  return `${leftStr} ${op} ${rightStr}`;
}

/**
 * kintone は NOT 演算子を前置形式でサポートしない。
 * 可能な限り内側の演算子を否定形に変換する（プッシュダウン）。
 *
 * NOT (a = b)      → a != b
 * NOT (a != b)     → a = b
 * NOT (a like b)   → エラー（Phase 1 スコープ外: NOT LIKE は 🔶）
 * NOT (IS NULL)    → IS NOT NULL
 * NOT (IS NOT NULL)→ IS NULL
 * NOT (A AND B)    → (NOT A) OR (NOT B)   ← ド・モルガン
 * NOT (A OR B)     → (NOT A) AND (NOT B)  ← ド・モルガン
 */
function convertNot(expr: NotExpr): string {
  return whereToKintone(pushDownNot(expr.expr));
}

// ------------------------------------------------------------
// GroupExpr: (...)
// ------------------------------------------------------------

function convertGroup(expr: GroupExpr): string {
  return `(${whereToKintone(expr.expr)})`;
}

// ------------------------------------------------------------
// フィールド参照
// ------------------------------------------------------------

/**
 * JOIN あり（テーブルエイリアス付き）の場合、エイリアスは除去して
 * フィールドコードだけを kintone クエリに出力する。
 * kintone API はテーブル名を持たないため。
 */
function convertField(field: FieldValue): string {
  if (field.type === "FUNC_FIELD") {
    throw new KintoneQueryError(
      `WHERE 句の関数（${field.expr.func}）は kintone クエリに変換できません`
    );
  }
  if (field.type === "ARITH_FIELD") {
    throw new KintoneQueryError("WHERE 句の算術式は kintone クエリに変換できません");
  }
  if (field.type === "CASE_FIELD") {
    throw new KintoneQueryError("WHERE 句の CASE WHEN は kintone クエリに変換できません");
  }
  if (field.type === "GROUPING_FIELD") {
    throw new KintoneQueryError("GROUPING() は kintone クエリに変換できません");
  }
  return quoteIdentifier(field.field);
}

// ------------------------------------------------------------
// 値
// ------------------------------------------------------------

function convertValue(value: SqlValue, op: CompareOp): string {
  switch (value.type) {
    case "VARIABLE":
      throw new KintoneQueryError(`未解決のバッチ変数 @${value.name} があります`);
    case "VARIABLE_IN_LIST":
      throw new KintoneQueryError(`未解決の配列変数 @${value.name} があります`);
    case "STRING":        return convertString(value);
    case "NUMBER":        return numberLiteralText(value);
    case "KINTONE_FUNC":  return convertKintoneFunc(value);
    case "IN_LIST":       return convertInList(value, op);
    case "ARITH_VALUE":
      throw new KintoneQueryError("WHERE 句の右辺算術式は kintone クエリに変換できません");
    case "CASE_VALUE":
      throw new KintoneQueryError("WHERE 句の右辺 CASE WHEN は kintone クエリに変換できません");
    case "SUBQUERY_IN_LIST":
      throw new KintoneQueryError("IN (SELECT ...) は kintone クエリに変換できません");
    case "SCALAR_SUBQUERY":
      throw new KintoneQueryError("スカラーサブクエリは kintone クエリに変換できません");
    case "ARRAY":
      throw new KintoneQueryError("配列リテラルは WHERE 句では使用できません");
  }
}

function convertString(v: StringLiteral): string {
  // kintone クエリの文字列はダブルクォートで囲む
  // 値内のダブルクォートはエスケープ
  return `"${v.value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function convertKintoneFunc(v: KintoneFunction): string {
  switch (v.name) {
    case "TODAY":
    case "NOW":
    case "LOGINUSER":
      // TODAY() / NOW() / LOGINUSER() はそのまま出力
      return `${v.name}()`;
  }
  return convertRelativeDateFunction(v);
}

function convertRelativeDateFunction(v: RelativeDateFunction): string {
  switch (v.name) {
    case "YESTERDAY":
    case "TOMORROW":
    case "THIS_YEAR":
    case "LAST_YEAR":
    case "NEXT_YEAR":
      if (v.args?.kind !== "NONE") return failInvalidRelativeDateFunction();
      return `${v.name}()`;

    case "FROM_TODAY":
      if (
        v.args?.kind !== "FROM_TODAY" ||
        !isValidRelativeDateOffset(v.args.offset, v.args.offsetText) ||
        !RELATIVE_DATE_PERIOD_UNITS.has(v.args.unit)
      ) {
        return failInvalidRelativeDateFunction();
      }
      return `${v.name}(${v.args.offsetText}, ${v.args.unit})`;

    case "THIS_WEEK":
    case "LAST_WEEK":
    case "NEXT_WEEK":
      if (
        v.args?.kind !== "WEEK" ||
        (v.args.weekday !== null && !RELATIVE_DATE_WEEKDAYS.has(v.args.weekday))
      ) {
        return failInvalidRelativeDateFunction();
      }
      return v.args.weekday === null
        ? `${v.name}()`
        : `${v.name}(${v.args.weekday})`;

    case "THIS_MONTH":
    case "LAST_MONTH":
    case "NEXT_MONTH":
      if (
        v.args?.kind !== "MONTH" ||
        !isValidRelativeDateMonthDay(v.args.day)
      ) {
        return failInvalidRelativeDateFunction();
      }
      return v.args.day === null
        ? `${v.name}()`
        : `${v.name}(${v.args.day})`;
  }
  return failInvalidRelativeDateFunction();
}

const RELATIVE_DATE_PERIOD_UNITS = new Set(["DAYS", "WEEKS", "MONTHS", "YEARS"]);
const RELATIVE_DATE_WEEKDAYS = new Set([
  "SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY",
  "THURSDAY", "FRIDAY", "SATURDAY",
]);

function isValidRelativeDateOffset(offset: number, offsetText: string): boolean {
  if (!Number.isSafeInteger(offset)) return false;
  if (!/^(?:0|[1-9]\d*|-[1-9]\d*)$/.test(offsetText)) return false;
  return Number(offsetText) === offset;
}

function isValidRelativeDateMonthDay(day: unknown): boolean {
  return day === null ||
    day === "LAST" ||
    (typeof day === "number" && Number.isInteger(day) && day >= 1 && day <= 31);
}

function failInvalidRelativeDateFunction(): never {
  throw new KintoneQueryError(
    "internal error: invalid relative date function AST reached kintone query conversion"
  );
}

function convertInList(v: InList, op: CompareOp): string {
  if (op !== "IN" && op !== "NOT_IN") {
    throw new KintoneQueryError("IN_LIST は IN / NOT IN 演算子でのみ使用できます");
  }
  assertResolvedInListValues(v.values);
  const values = v.values
    .map((item) => {
      if (item.type === "STRING") return convertString(item);
      if (item.type === "NUMBER") return numberLiteralText(item);
      return convertKintoneFunc(item);
    })
    .join(",");
  return `(${values})`;
}

function assertResolvedInListValues(
  values: InList["values"]
): asserts values is Exclude<InList["values"][number], { type: "VARIABLE" }>[] {
  const unresolved = values.find((item) => item.type === "VARIABLE");
  if (unresolved?.type === "VARIABLE") {
    throw new KintoneQueryError(`未解決のバッチ変数 @${unresolved.name} があります`);
  }
}

// ------------------------------------------------------------
// 識別子クォート
// ------------------------------------------------------------

/**
 * フィールドコードにスペースや記号が含まれる場合はダブルクォートで囲む。
 * kintone クエリでは識別子のクォートにダブルクォートを使用する。
 *
 * 例:
 *   ステータス       → ステータス
 *   担当者 名前      → "担当者 名前"
 *   金額(税込)       → "金額(税込)"
 *   $id              → $id
 */
function quoteIdentifier(name: string): string {
  // ASCII英数字・$・_・日本語 Unicode 範囲（\u3000-\u9FFF）のみ → クォート不要
  if (/^[\w$\u3000-\u9FFF]+$/u.test(name)) {
    return name;
  }
  return `"${name.replace(/"/g, '\\"')}"`;
}

// ------------------------------------------------------------
// ヘルパー
// ------------------------------------------------------------

/**
 * LogicalExpr の子ノードが異なる論理演算子を持つ場合に括弧が必要か判定。
 * kintone クエリは左結合で and が or より優先されるため、
 * or の子に and が来る場合は括弧が必要。
 */
function needsParens(expr: WhereExpr): boolean {
  return expr.type === "LOGICAL";
}

// ------------------------------------------------------------
// エラー
// ------------------------------------------------------------

export class KintoneQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KintoneQueryError";
  }
}
