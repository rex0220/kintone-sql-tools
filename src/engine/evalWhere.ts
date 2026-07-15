// ============================================================
// evalWhere — WhereExpr を JavaScript 側で評価する
//
// 用途: JOIN クエリの結合後フィルタ（WHERE を JS 側で適用）
// kintone API では評価できない場合（複数テーブル参照等）に使用する。
// ============================================================

import type {
  WhereExpr,
  FieldValue,
  SqlValue,
  CompareOp,
  CaseWhenExpr,
  CaseResult,
  InList,
  StringLiteral,
  NumberLiteral,
  SubqueryInList,
  ExistsExpr,
  ScalarSubquery,
} from "../types/ast";
import { evalStringFunc, evalArithExpr, resolveFieldRef } from "./evalFunc";
import { likePatternHasWildcard } from "../core/like";
import { compareScalarValues } from "../core/scalarCompare";

/**
 * サブクエリを事前実行済みの IN リスト。
 * execute.ts 側でサブクエリを実行し resolved に値セットを詰めて渡す。
 */
export interface ResolvedSubqueryInList extends SubqueryInList {
  resolved: Set<string>;
}

/**
 * EXISTS サブクエリを事前実行済みのノード。
 * execute.ts 側でサブクエリを実行し resolved に結果を詰めて渡す。
 */
export interface ResolvedExistsExpr extends ExistsExpr {
  resolved: boolean; // サブクエリの結果が 1件以上あるか
}

/**
 * スカラーサブクエリを事前実行済みのノード。
 * execute.ts 側でサブクエリを実行し resolved に値を詰めて渡す。
 */
export interface ResolvedScalarSubquery extends ScalarSubquery {
  resolved: string; // サブクエリの結果値（1行1列）
}


// ------------------------------------------------------------
// ProcessRow: 処理中のフラット行（フィールド名 → 文字列値）
//
// JOIN あり: "alias.field" 形式のキー
// JOIN なし: "field" 形式のキー
// ------------------------------------------------------------
export type ProcessRow = Record<string, string>;

// ------------------------------------------------------------
// エントリポイント
// ------------------------------------------------------------

export function evalWhere(expr: WhereExpr, row: ProcessRow): boolean {
  switch (expr.type) {
    case "BINARY":    return evalBinary(expr, row);
    case "NULL_CHECK": return evalNullCheck(expr, row);
    case "LOGICAL":   return evalLogical(expr, row);
    case "NOT":       return !evalWhere(expr.expr, row);
    case "GROUP":     return evalWhere(expr.expr, row);
    case "EXISTS": {
      const exists = (expr as ResolvedExistsExpr).resolved;
      return expr.not ? !exists : exists;
    }
  }
}

// ------------------------------------------------------------
// BinaryExpr
// ------------------------------------------------------------

function evalBinary(
  expr: Extract<WhereExpr, { type: "BINARY" }>,
  row: ProcessRow
): boolean {
  const left = resolveField(expr.left, row);
  return evalOp(expr.op, left, expr.right, row);
}

function evalOp(
  op: CompareOp,
  leftStr: string,
  right: SqlValue,
  row: ProcessRow
): boolean {
  if (op === "IN" || op === "NOT_IN") {
    if (right.type === "IN_LIST") {
      // 比較前に全要素を検査し、some/every の短絡で未解決変数を見逃さない。
      assertResolvedInListValues(right.values);
      const contains = right.values.some((v) => leftStr === String(v.value));
      return op === "IN" ? contains : !contains;
    }
    if (right.type === "SUBQUERY_IN_LIST") {
      const contains = (right as ResolvedSubqueryInList).resolved.has(leftStr);
      return op === "IN" ? contains : !contains;
    }
    return op === "NOT_IN";
  }

  if (op === "LIKE") {
    const pattern = resolveValue(right, row);
    return matchLike(leftStr, pattern);
  }

  if (op === "NOT_LIKE") {
    const pattern = resolveValue(right, row);
    return !matchLike(leftStr, pattern);
  }

  const rightStr = resolveValue(right, row);

  return compareScalarValues(op, leftStr, rightStr);
}

function assertResolvedInListValues(
  values: InList["values"]
): asserts values is (StringLiteral | NumberLiteral)[] {
  const unresolved = values.find((item) => item.type === "VARIABLE");
  if (unresolved?.type === "VARIABLE") {
    throw new Error(`ParseError: unresolved batch variable @${unresolved.name}.`);
  }
}

// ------------------------------------------------------------
// NullCheckExpr: IS NULL → value === ""
// ------------------------------------------------------------

function evalNullCheck(
  expr: Extract<WhereExpr, { type: "NULL_CHECK" }>,
  row: ProcessRow
): boolean {
  const val = resolveField(expr.field, row);
  return expr.not ? val !== "" : val === "";
}

// ------------------------------------------------------------
// LogicalExpr
// ------------------------------------------------------------

function evalLogical(
  expr: Extract<WhereExpr, { type: "LOGICAL" }>,
  row: ProcessRow
): boolean {
  if (expr.op === "AND") {
    return evalWhere(expr.left, row) && evalWhere(expr.right, row);
  }
  return evalWhere(expr.left, row) || evalWhere(expr.right, row);
}

// ------------------------------------------------------------
// フィールド値の解決
// ------------------------------------------------------------

function resolveField(
  field: FieldValue,
  row: ProcessRow
): string {
  if (field.type === "FUNC_FIELD")  return evalStringFunc(field.expr, row);
  if (field.type === "ARITH_FIELD") return String(evalArithExpr(field.expr, row));
  if (field.type === "CASE_FIELD")  return evalCaseWhen(field.expr, row);
  // エイリアス付き: "a.フィールド"
  const key = field.tableAlias
    ? `${field.tableAlias}.${field.field}`
    : field.field;
  return resolveFieldRef(row, key);
}

function resolveValue(value: SqlValue, row: ProcessRow): string {
  switch (value.type) {
    case "VARIABLE":     throw new Error(`ParseError: unresolved batch variable @${value.name}.`);
    case "STRING":       return value.value;
    case "NUMBER":       return String(value.value);
    case "KINTONE_FUNC": return resolveKintoneFunc(value.name);
    case "IN_LIST":           return ""; // IN は evalOp で別処理
    case "SUBQUERY_IN_LIST":  return ""; // IN (SELECT) は evalOp で別処理
    case "SCALAR_SUBQUERY":   return (value as ResolvedScalarSubquery).resolved;
    case "ARITH_VALUE":
      if (value.expr.type === "FIELD_REF") return resolveFieldRef(row, value.expr.field);
      if (value.expr.type === "STRING_FUNC") return evalStringFunc(value.expr, row);
      return String(evalArithExpr(value.expr, row));
    case "CASE_VALUE":        return evalCaseWhen(value.expr, row);
    case "ARRAY":
      return value.elements.map((e) => e.value).join(",");
  }
}

// ============================================================
// CASE WHEN 評価（process.ts と dmlToKintone.ts からも使う）
// ============================================================

export function evalCaseWhen(expr: CaseWhenExpr, row: ProcessRow): string {
  for (const branch of expr.branches) {
    if (evalWhere(branch.condition, row)) {
      return evalCaseResult(branch.result, row);
    }
  }
  if (expr.elseResult !== null) {
    return evalCaseResult(expr.elseResult, row);
  }
  return ""; // NULL 相当
}

function evalCaseResult(result: CaseResult, row: ProcessRow): string {
  if (result.type === "ARRAY")       return result.elements.map((e) => e.value).join(",");
  if (result.type === "STRING")      return result.value;
  if (result.type === "STRING_FUNC") return evalStringFunc(result, row);
  if (result.type === "FIELD_REF")   return row[result.field] ?? "";
  // NUMBER or ARITH
  return String(evalArithExpr(result, row));
}

export function resolveKintoneFunc(name: "TODAY" | "NOW" | "LOGINUSER"): string {
  const now = new Date();
  switch (name) {
    case "TODAY": {
      // "YYYY-MM-DD"
      const y = now.getFullYear();
      const m = String(now.getMonth() + 1).padStart(2, "0");
      const d = String(now.getDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
    case "NOW":
      return now.toISOString();
    case "LOGINUSER":
      // kintone 環境外では解決不能 → 空文字（比較が常に false になる）
      return "";
  }
}

// ------------------------------------------------------------
// LIKE パターンマッチ
// SQL の % → .* 、_ → . に変換して正規表現で評価
// ------------------------------------------------------------

// パターン → コンパイル済み正規表現のキャッシュ。
// 全件フィルタでは同一パターンを行数分評価するため、行ごとのコンパイルを避ける。
const likeRegexCache = new Map<string, RegExp>();
const LIKE_REGEX_CACHE_MAX = 200;

function matchLike(value: string, pattern: string): boolean {
  // kintone の LIKE はワイルドカード（% / _）なしでも部分一致（contains）
  // FULL_SCAN 時の JS 評価も同じ挙動にする
  if (!likePatternHasWildcard(pattern)) {
    return value.includes(pattern);
  }
  let regex = likeRegexCache.get(pattern);
  if (!regex) {
    // パターン文字列を正規表現に変換
    let regexStr = "^";
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i];
      if (ch === "%") {
        regexStr += ".*";
      } else if (ch === "_") {
        regexStr += ".";
      } else {
        // 正規表現特殊文字をエスケープ
        regexStr += ch.replace(/[.+*?^${}()|[\]\\]/g, "\\$&");
      }
    }
    regexStr += "$";
    regex = new RegExp(regexStr, "u");
    if (likeRegexCache.size >= LIKE_REGEX_CACHE_MAX) likeRegexCache.clear();
    likeRegexCache.set(pattern, regex);
  }
  return regex.test(value);
}
