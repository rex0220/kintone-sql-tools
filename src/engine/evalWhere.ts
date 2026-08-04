// ============================================================
// evalWhere — WhereExpr を JavaScript 側で評価する
//
// 用途: JOIN クエリの結合後フィルタ（WHERE を JS 側で適用）
// kintone API では評価できない場合（複数テーブル参照等）に使用する。
// ============================================================

import type {
  WhereExpr,
  FieldValue,
  FieldRef,
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
  ArithNode,
  ScalarValueExpr,
} from "../types/ast";
import { numberLiteralText } from "../types/ast";
import {
  evalStringFunc,
  evalArithExpr,
  evalMaterializedAggregateOperand,
  evalScalarValueExpr,
  evalScalarValueExprNullable,
  resolveFieldRef,
} from "./evalFunc";
import { likePatternHasWildcard } from "../core/like";
import { compareScalarValues } from "../core/scalarCompare";
import {
  resolveFieldSemantics as resolveDeclaredFieldSemantics,
  syntheticSemantics,
  type ResolvedFieldSemantics,
} from "../core/fieldSemantics";
import { evalGroupingRef } from "./groupingRowMeta";
import {
  isRelativeDateFunctionName,
  isLegacyKintoneFunctionName,
  WHERE_KINTONE_FUNCTION_REQUIRES_EXACT_PUSHDOWN,
  WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN,
} from "../core/relativeDateFunction";
import { aggregateOperandLabel, aggregateSyntheticName } from "../core/aggregateExpression";

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

/** 物理フィールド参照から kintone フィールド型を解決する。 */
export type FieldTypeResolver = (field: FieldRef) => string | undefined;
export type FieldSemanticsResolver = (field: FieldRef) => ResolvedFieldSemantics | undefined;

// ------------------------------------------------------------
// エントリポイント
// ------------------------------------------------------------

export function evalWhere(
  expr: WhereExpr,
  row: ProcessRow,
  resolveFieldType?: FieldTypeResolver,
  appliedKlikes?: ReadonlySet<object>,
  resolveFieldSemantics?: FieldSemanticsResolver
): boolean {
  switch (expr.type) {
    case "BOOLEAN":   return expr.value;
    case "BINARY":    return evalBinary(expr, row, resolveFieldType, appliedKlikes, resolveFieldSemantics);
    case "NULL_CHECK": return evalNullCheck(expr, row);
    case "LOGICAL":   return evalLogical(expr, row, resolveFieldType, appliedKlikes, resolveFieldSemantics);
    case "NOT":       return !evalWhere(expr.expr, row, resolveFieldType, appliedKlikes, resolveFieldSemantics);
    case "GROUP":     return evalWhere(expr.expr, row, resolveFieldType, appliedKlikes, resolveFieldSemantics);
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
  row: ProcessRow,
  resolveFieldType?: FieldTypeResolver,
  appliedKlikes?: ReadonlySet<object>,
  resolveFieldSemantics?: FieldSemanticsResolver
): boolean {
  if (expr.op === "KLIKE" || expr.op === "NOT_KLIKE") {
    if (appliedKlikes?.has(expr)) return true;
    throw new Error("KLIKE / NOT KLIKE は押し下げ済み集合に含まれないため JavaScript 側では評価できません");
  }
  const left = resolveField(expr.left, row, resolveFieldType, resolveFieldSemantics);
  const fieldType = expr.left.type === "FIELD"
    ? resolveFieldType?.(expr.left)
    : undefined;
  const semantics = semanticsForLeft(expr.left, fieldType, resolveFieldSemantics);
  return evalOp(expr.op, left, expr.right, row, fieldType, resolveFieldType, semantics, resolveFieldSemantics);
}

function evalOp(
  op: CompareOp,
  leftStr: string,
  right: SqlValue,
  row: ProcessRow,
  fieldType?: string,
  resolveFieldType?: FieldTypeResolver,
  semantics: ResolvedFieldSemantics = syntheticSemantics("string"),
  resolveFieldSemantics?: FieldSemanticsResolver
): boolean {
  if (op === "IN" || op === "NOT_IN") {
    let values: Set<string> | null = null;
    if (right.type === "IN_LIST") {
      // 比較前に全要素を検査し、some/every の短絡で未解決変数を見逃さない。
      assertResolvedInListValues(right.values);
      values = new Set(right.values.map((v) => v.type === "NUMBER"
        ? (fieldType === "NUMBER" ? numberLiteralText(v) : String(v.value))
        : v.value));
    }
    if (right.type === "SUBQUERY_IN_LIST") {
      values = (right as ResolvedSubqueryInList).resolved;
    }
    if (values === null) return op === "NOT_IN";
    const contains = typedInContains(leftStr, values, fieldType);
    return op === "IN" ? contains : !contains;
  }

  if (op === "LIKE") {
    const pattern = resolveValue(right, row, resolveFieldType);
    return matchLike(leftStr, pattern);
  }

  if (op === "NOT_LIKE") {
    const pattern = resolveValue(right, row, resolveFieldType);
    return !matchLike(leftStr, pattern);
  }

  if (op === "KLIKE" || op === "NOT_KLIKE") {
    throw new Error("KLIKE / NOT KLIKE は JavaScript 側では評価できません（SIMPLE SELECT でのみ使用できます）");
  }

  const rightStr = resolveValue(right, row, resolveFieldType, resolveFieldSemantics);

  return compareScalarValues(op, leftStr, rightStr, semantics);
}

const NUMERIC_STRING_FUNCTIONS = new Set([
  "LENGTH", "LENGTH_CHAR", "INSTR", "ROUND", "FLOOR", "CEIL", "TRUNCATE",
  "YEAR", "MONTH", "DAY", "DATEDIFF", "ABS", "MOD", "POWER", "SQRT",
  "DAYOFWEEK", "QUARTER", "WEEK",
]);

function semanticsForLeft(
  left: FieldValue,
  fieldType?: string,
  resolveSemantics?: FieldSemanticsResolver
): ResolvedFieldSemantics {
  if (left.type === "FIELD") {
    return resolveSemantics?.(left)
      ?? (fieldType ? resolveDeclaredFieldSemantics({ fieldType }) : syntheticSemantics("string"));
  }
  if (left.type === "ARITH_FIELD" || left.type === "AGG_FIELD") return syntheticSemantics("number");
  if (left.type === "FUNC_FIELD") {
    return syntheticSemantics(NUMERIC_STRING_FUNCTIONS.has(left.expr.func) ? "number" : "string");
  }
  if (left.type === "CASE_FIELD") {
    const results = [
      ...left.expr.branches.map((branch) => branch.result),
      ...(left.expr.elseResult ? [left.expr.elseResult] : []),
    ];
    const modes = results.map((result): ResolvedFieldSemantics => {
      if (result.type === "NUMBER" || result.type === "ARITH") return syntheticSemantics("number");
      if (result.type === "STRING_FUNC") {
        return syntheticSemantics(NUMERIC_STRING_FUNCTIONS.has(result.func) ? "number" : "string");
      }
      if (result.type === "FIELD_REF") {
        const dot = result.field.indexOf(".");
        const ref: FieldRef = dot > 0
          ? { type: "FIELD", tableAlias: result.field.slice(0, dot), field: result.field.slice(dot + 1) }
          : { type: "FIELD", tableAlias: null, field: result.field };
        return resolveSemantics?.(ref) ?? syntheticSemantics("string");
      }
      return syntheticSemantics("string");
    });
    if (modes.length > 0 && modes.every((mode) => mode.compareMode === modes[0].compareMode)) return modes[0];
  }
  if (left.type === "GROUPING_FIELD") return syntheticSemantics("number");
  return syntheticSemantics("string");
}

const STRING_ARRAY_FIELD_TYPES = new Set(["CHECK_BOX", "MULTI_SELECT"]);
const OBJECT_ARRAY_FIELD_TYPES = new Set([
  "USER_SELECT",
  "ORGANIZATION_SELECT",
  "GROUP_SELECT",
  "STATUS_ASSIGNEE",
]);
const SINGLE_OBJECT_FIELD_TYPES = new Set(["CREATOR", "MODIFIER"]);

/**
 * kintone の複数値・ユーザー系フィールドを、値/code 単位で IN 評価する。
 * 型不明・JSON 形不一致では従来の文字列完全一致へフォールバックする。
 */
function typedInContains(
  leftStr: string,
  values: ReadonlySet<string>,
  fieldType: string | undefined
): boolean {
  const fallback = () => values.has(leftStr);
  if (fieldType === undefined) return fallback();
  if (fieldType === "NUMBER") {
    const semantics = syntheticSemantics("number");
    return [...values].some((value) => compareScalarValues("=", leftStr, value, semantics));
  }

  let parsed: unknown;
  if (
    STRING_ARRAY_FIELD_TYPES.has(fieldType) ||
    OBJECT_ARRAY_FIELD_TYPES.has(fieldType) ||
    SINGLE_OBJECT_FIELD_TYPES.has(fieldType)
  ) {
    try {
      parsed = JSON.parse(leftStr) as unknown;
    } catch {
      return fallback();
    }
  } else {
    return fallback();
  }

  if (STRING_ARRAY_FIELD_TYPES.has(fieldType)) {
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
      return fallback();
    }
    if (parsed.length === 0 && values.has("")) return true;
    return parsed.some((item) => values.has(item));
  }

  if (OBJECT_ARRAY_FIELD_TYPES.has(fieldType)) {
    if (!Array.isArray(parsed) || !parsed.every(hasStringCode)) return fallback();
    if (parsed.length === 0 && values.has("")) return true;
    return parsed.some((item) => values.has(item.code));
  }

  if (!hasStringCode(parsed)) return fallback();
  return values.has(parsed.code);
}

function hasStringCode(value: unknown): value is { code: string } {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { code?: unknown }).code === "string";
}

function assertResolvedInListValues(
  values: InList["values"]
): asserts values is (StringLiteral | NumberLiteral)[] {
  const unresolved = values.find((item) => item.type === "VARIABLE");
  if (unresolved?.type === "VARIABLE") {
    throw new Error(`ParseError: unresolved batch variable @${unresolved.name}.`);
  }
  const serverOnlyFunction = values.find((item) => item.type === "KINTONE_FUNC");
  if (serverOnlyFunction?.type === "KINTONE_FUNC") {
    throw new Error(
      `${serverOnlyFunction.name}: ${WHERE_KINTONE_FUNCTION_REQUIRES_EXACT_PUSHDOWN}`
    );
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
  row: ProcessRow,
  resolveFieldType?: FieldTypeResolver,
  appliedKlikes?: ReadonlySet<object>,
  resolveFieldSemantics?: FieldSemanticsResolver
): boolean {
  if (expr.op === "AND") {
    return evalWhere(expr.left, row, resolveFieldType, appliedKlikes, resolveFieldSemantics)
      && evalWhere(expr.right, row, resolveFieldType, appliedKlikes, resolveFieldSemantics);
  }
  return evalWhere(expr.left, row, resolveFieldType, appliedKlikes, resolveFieldSemantics)
    || evalWhere(expr.right, row, resolveFieldType, appliedKlikes, resolveFieldSemantics);
}

// ------------------------------------------------------------
// フィールド値の解決
// ------------------------------------------------------------

function resolveField(
  field: FieldValue,
  row: ProcessRow,
  resolveFieldType?: FieldTypeResolver,
  resolveFieldSemantics?: FieldSemanticsResolver
): string {
  if (field.type === "FUNC_FIELD")  return evalStringFunc(field.expr, row);
  if (field.type === "AGG_FIELD")   return String(evalMaterializedAggregateOperand(field.expr, row));
  if (field.type === "ARITH_FIELD") return String(evalArithExpr(field.expr, row));
  if (field.type === "CASE_FIELD")  return evalCaseWhen(field.expr, row, resolveFieldType, resolveFieldSemantics);
  if (field.type === "GROUPING_FIELD") return evalGroupingRef(field.ref, row);
  // エイリアス付き: "a.フィールド"
  const key = field.tableAlias
    ? `${field.tableAlias}.${field.field}`
    : field.field;
  return resolveFieldRef(row, key);
}

function resolveValue(
  value: SqlValue,
  row: ProcessRow,
  resolveFieldType?: FieldTypeResolver,
  resolveFieldSemantics?: FieldSemanticsResolver
): string {
  switch (value.type) {
    case "VARIABLE":     throw new Error(`ParseError: unresolved batch variable @${value.name}.`);
    case "VARIABLE_IN_LIST": throw new Error(`ParseError: unresolved batch array variable @${value.name}.`);
    case "STRING":       return value.value;
    case "NUMBER":       return numberLiteralText(value);
    case "KINTONE_FUNC": return resolveKintoneFuncValue(value.name as string);
    case "IN_LIST":           return ""; // IN は evalOp で別処理
    case "SUBQUERY_IN_LIST":  return ""; // IN (SELECT) は evalOp で別処理
    case "SCALAR_SUBQUERY":   return (value as ResolvedScalarSubquery).resolved;
    case "ARITH_VALUE":
      if (value.expr.type === "FIELD_REF") return resolveFieldRef(row, value.expr.field);
      if (value.expr.type === "STRING_FUNC") return evalStringFunc(value.expr, row);
      return String(evalArithExpr(value.expr, row));
    case "CASE_VALUE":        return evalCaseWhen(value.expr, row, resolveFieldType, resolveFieldSemantics);
    case "ARRAY":
      return value.elements.map((e) => e.value).join(",");
  }
}

// ============================================================
// CASE WHEN 評価（process.ts と dmlToKintone.ts からも使う）
// ============================================================

export function evalCaseWhen(
  expr: CaseWhenExpr,
  row: ProcessRow,
  resolveFieldType?: FieldTypeResolver,
  resolveFieldSemantics?: FieldSemanticsResolver
): string {
  for (const branch of expr.branches) {
    if (evalWhere(branch.condition, row, resolveFieldType, undefined, resolveFieldSemantics)) {
      return evalCaseResult(branch.result, row, resolveFieldType, resolveFieldSemantics);
    }
  }
  if (expr.elseResult !== null) {
    return evalCaseResult(expr.elseResult, row, resolveFieldType, resolveFieldSemantics);
  }
  return ""; // NULL 相当
}

/** 集計入力専用 CASE 評価。ELSE 省略だけを null として保持する。 */
export function evalCaseWhenNullable(
  expr: CaseWhenExpr,
  row: ProcessRow,
  resolveFieldType?: FieldTypeResolver,
  resolveFieldSemantics?: FieldSemanticsResolver
): string | number | null {
  for (const branch of expr.branches) {
    if (evalWhere(branch.condition, row, resolveFieldType, undefined, resolveFieldSemantics)) {
      return evalCaseResultNullable(branch.result, row, resolveFieldType, resolveFieldSemantics);
    }
  }
  return expr.elseResult === null
    ? null
    : evalCaseResultNullable(expr.elseResult, row, resolveFieldType, resolveFieldSemantics);
}

function evalCaseResultNullable(
  result: CaseResult,
  row: ProcessRow,
  resolveFieldType?: FieldTypeResolver,
  resolveFieldSemantics?: FieldSemanticsResolver
): string | number | null {
  if (result.type === "ARRAY") return result.elements.map((entry) => entry.value).join(",");
  if (result.type === "AGG_REF") {
    return row[aggregateSyntheticName(result.func, result.distinct, result.arg)] ?? "";
  }
  if (result.type === "AGG_ARITH") return row[aggregateOperandLabel(result)] ?? "";
  if (result.type === "FIELD_REF") return row[result.field] ?? "";
  if (result.type === "ARITH") return evalArithExpr(result, row);
  return evalScalarValueExprNullable(result, row, resolveFieldType, resolveFieldSemantics);
}

function evalCaseResult(
  result: CaseResult,
  row: ProcessRow,
  resolveFieldType?: FieldTypeResolver,
  resolveFieldSemantics?: FieldSemanticsResolver
): string {
  if (result.type === "ARRAY")       return result.elements.map((e) => e.value).join(",");
  if (result.type === "AGG_REF") {
    return row[aggregateSyntheticName(result.func, result.distinct, result.arg)] ?? "";
  }
  if (result.type === "AGG_ARITH") return row[aggregateOperandLabel(result)] ?? "";
  // 旧 CASE 経路が生成済み AST を受ける互換分岐。
  if ((result as { type: string }).type === "FIELD_REF") {
    return row[(result as unknown as { field: string }).field] ?? "";
  }
  if ((result as { type: string }).type === "ARITH") {
    return String(evalArithExpr(result as unknown as ArithNode, row));
  }
  return String(evalScalarValueExpr(result as ScalarValueExpr, row, resolveFieldType, resolveFieldSemantics));
}

export function resolveKintoneFunc(
  name: "TODAY" | "NOW" | "LOGINUSER" | "PRIMARY_ORGANIZATION"
): string {
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
    case "PRIMARY_ORGANIZATION":
      // kintone 環境外では解決不能 → 空文字（比較が常に false になる）
      return "";
  }
}

function resolveKintoneFuncValue(name: string): string {
  if (isRelativeDateFunctionName(name)) {
    throw new Error(
      `${name}: ${WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN}`
    );
  }
  if (isLegacyKintoneFunctionName(name)) {
    throw new Error(
      `${name}: ${WHERE_KINTONE_FUNCTION_REQUIRES_EXACT_PUSHDOWN}`
    );
  }

  switch (name) {
    default:
      throw new Error(`InternalError: unexpected KINTONE_FUNC name: ${name}`);
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
