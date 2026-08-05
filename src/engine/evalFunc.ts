// ============================================================
// evalFunc — 関数・算術式の共通評価ロジック
//
// process.ts と evalWhere.ts の両方から使うため独立したモジュールとして切り出す。
// （evalWhere → process の循環参照を避けるため）
// ============================================================

import type {
  ArithNode,
  StringFuncExpr,
  StringFuncArg,
  ScalarValueExpr,
  AggOperand,
} from "../types/ast";
import { numberLiteralText } from "../types/ast";
import { aggregateSyntheticName } from "../core/aggregateExpression";
import type { FieldSemanticsResolver, FieldTypeResolver, ProcessRow } from "./evalWhere";
import { selectScalarExtreme } from "../core/scalarCompare";
import { assertStringFunctionArity } from "../core/functionArity";
import { evalCaseWhen, evalCaseWhenNullable } from "./evalWhere";

// ============================================================
// 算術式
// ============================================================

export function evalArithExpr(expr: ArithNode, row: ProcessRow): number {
  if (expr.type === "VARIABLE") throw new Error(
    `InternalError: unresolved arithmetic variable @${expr.name} reached arithmetic evaluation.`
  );
  if (expr.type === "NUMBER")      return expr.value;
  if (expr.type === "FIELD_REF")   return Number(resolveFieldRef(row, expr.field));
  if (expr.type === "STRING_FUNC") return Number(evalStringFunc(expr, row));
  const l = evalArithExpr(expr.left,  row);
  const r = evalArithExpr(expr.right, row);
  switch (expr.op) {
    case "+": return l + r;
    case "-": return l - r;
    case "*": return l * r;
    case "/": return r !== 0 ? l / r : NaN;
    case "%": return r !== 0 ? l % r : NaN;
  }
}

/** 新 ScalarValueExpr 専用評価器。旧 ArithNode 評価器とは入口を分離する。 */
export function evalScalarValueExpr(
  expr: ScalarValueExpr,
  row: ProcessRow,
  resolveFieldType?: FieldTypeResolver,
  resolveFieldSemantics?: FieldSemanticsResolver
): string | number {
  switch (expr.type) {
    case "STRING": return expr.value;
    case "NUMBER": return expr.value;
    case "FIELD": return resolveFieldRef(row, expr.tableAlias ? `${expr.tableAlias}.${expr.field}` : expr.field);
    case "VARIABLE":
      throw new Error(`ArgumentError: unresolved variable @${expr.name} reached scalar evaluator.`);
    case "STRING_FUNC": return evalStringFunc(expr, row, resolveFieldType, resolveFieldSemantics);
    case "CASE_WHEN": return evalCaseWhen(expr, row, resolveFieldType, resolveFieldSemantics);
    case "CONCAT_OP": {
      // CONCAT の空値・文字列化規則を唯一の実装として再利用する。
      return evalStringFunc({
        type: "STRING_FUNC",
        func: "CONCAT",
        args: [expr.left, expr.right],
      }, row, resolveFieldType, resolveFieldSemantics);
    }
    case "SCALAR_ARITH": {
      const left = Number(evalScalarValueExpr(expr.left, row, resolveFieldType, resolveFieldSemantics));
      const right = Number(evalScalarValueExpr(expr.right, row, resolveFieldType, resolveFieldSemantics));
      switch (expr.op) {
        case "+": return left + right;
        case "-": return left - right;
        case "*": return left * right;
        case "/": return right !== 0 ? left / right : NaN;
        case "%": return right !== 0 ? left % right : NaN;
      }
    }
  }
}

/** 集計入力用。表示/DML の空文字 NULL 互換を変えず、CASE の NULL だけを保持する。 */
export function evalScalarValueExprNullable(
  expr: ScalarValueExpr,
  row: ProcessRow,
  resolveFieldType?: FieldTypeResolver,
  resolveFieldSemantics?: FieldSemanticsResolver
): string | number | null {
  switch (expr.type) {
    case "CASE_WHEN":
      return evalCaseWhenNullable(expr, row, resolveFieldType, resolveFieldSemantics);
    case "SCALAR_ARITH": {
      const left = evalScalarValueExprNullable(expr.left, row, resolveFieldType, resolveFieldSemantics);
      const right = evalScalarValueExprNullable(expr.right, row, resolveFieldType, resolveFieldSemantics);
      if (left === null || right === null) return null;
      const l = Number(left);
      const r = Number(right);
      switch (expr.op) {
        case "+": return l + r;
        case "-": return l - r;
        case "*": return l * r;
        case "/": return r !== 0 ? l / r : NaN;
        case "%": return r !== 0 ? l % r : NaN;
      }
    }
    case "CONCAT_OP": {
      const left = evalScalarValueExprNullable(expr.left, row, resolveFieldType, resolveFieldSemantics);
      const right = evalScalarValueExprNullable(expr.right, row, resolveFieldType, resolveFieldSemantics);
      return `${left ?? ""}${right ?? ""}`;
    }
    default:
      return evalScalarValueExpr(expr, row, resolveFieldType, resolveFieldSemantics);
  }
}

// ============================================================
// ROUND / FLOOR / CEIL 共通処理
//
// digits > 0: 小数点以下 N 桁    例: (1234.567,  2) → 1234.57
// digits = 0: 整数               例: (1234.5)       → 1235
// digits < 0: 10^|digits| 単位   例: (1234,     -2) → 1200
// ============================================================

export function applyRoundOp(
  op: "round" | "floor" | "ceil" | "trunc",
  num: number,
  digits: number
): string {
  const factor = Math.pow(10, digits);
  const raw = Math[op](num * factor) / factor;
  if (digits > 0) return String(parseFloat(raw.toFixed(digits)));
  return String(raw);
}

// ============================================================
// UTF-16 コードユニット予算内の安全な切り出し
// ============================================================

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

/** 位置 index で切ると、入力中で対になっているサロゲートペアを割るか。 */
function splitsSurrogatePair(value: string, index: number): boolean {
  return index > 0
    && index < value.length
    && isHighSurrogate(value.charCodeAt(index - 1))
    && isLowSurrogate(value.charCodeAt(index));
}

/** String.prototype.slice と同じ規則で境界を 0..length に正規化する。 */
function normalizeSliceIndex(index: number, length: number): number {
  if (Number.isNaN(index) || index === Number.NEGATIVE_INFINITY) return 0;
  if (index === Number.POSITIVE_INFINITY) return length;
  const integer = Math.trunc(index);
  return integer < 0
    ? Math.max(length + integer, 0)
    : Math.min(integer, length);
}

function sliceSafePrefix(value: string, budget: number): string {
  let end = Math.min(Math.max(0, budget), value.length);
  if (splitsSurrogatePair(value, end)) end -= 1;
  return value.slice(0, end);
}

function sliceSafeSuffix(value: string, budget: number): string {
  let start = Math.max(0, value.length - budget);
  if (splitsSurrogatePair(value, start)) start += 1;
  return value.slice(start);
}

function sliceSafeRange(value: string, rawStart: number, rawEnd: number): string {
  let start = normalizeSliceIndex(rawStart, value.length);
  let end = normalizeSliceIndex(rawEnd, value.length);
  if (end <= start) return "";
  if (splitsSurrogatePair(value, start)) start += 1;
  if (splitsSurrogatePair(value, end)) end -= 1;
  return value.slice(start, Math.max(start, end));
}

function makeSafePadding(pad: string, gap: number): string {
  const repeated = pad.repeat(Math.ceil(gap / pad.length));
  return sliceSafePrefix(repeated, gap);
}

const REGEXP_CACHE_MAX = 200;
const regexpCache = new Map<string, RegExp>();

function normalizeRegexpFlags(flags: string): string {
  if (/[^ims]/.test(flags)) {
    throw new Error("ArgumentError: regular expression flags may contain only i, m, or s.");
  }
  if (new Set(flags).size !== flags.length) {
    throw new Error("ArgumentError: regular expression flags must not contain duplicates.");
  }
  return `${flags}u`;
}

function compileRegexp(pattern: string, flags: string, global = false): RegExp {
  const normalizedFlags = normalizeRegexpFlags(flags) + (global ? "g" : "");
  const key = `${pattern}\0${normalizedFlags}`;
  const cached = regexpCache.get(key);
  if (cached !== undefined) {
    cached.lastIndex = 0;
    return cached;
  }
  let regexp: RegExp;
  try {
    regexp = new RegExp(pattern, normalizedFlags);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`ArgumentError: invalid regular expression: ${detail}`);
  }
  if (regexpCache.size >= REGEXP_CACHE_MAX) {
    const oldest = regexpCache.keys().next().value as string | undefined;
    if (oldest !== undefined) regexpCache.delete(oldest);
  }
  regexpCache.set(key, regexp);
  return regexp;
}

function assertRegexpReplacement(replacement: string): void {
  if (replacement.includes("$`") || replacement.includes("$'")) {
    throw new Error("ArgumentError: REGEXP_REPLACE replacement must not contain $` or $'.");
  }
}

function parseRegexpOccurrence(arg: string | undefined): number {
  if (arg === undefined) return 0;
  if (!/^\d+$/.test(arg)) {
    throw new Error("ArgumentError: REGEXP_REPLACE occurrence must be a non-negative integer.");
  }
  return Number(arg);
}

function expandRegexpReplacement(
  replacement: string,
  match: string,
  captures: readonly (string | undefined)[],
  namedGroups: Record<string, string | undefined> | undefined
): string {
  let result = "";
  for (let i = 0; i < replacement.length; i += 1) {
    const char = replacement[i];
    if (char !== "$" || i + 1 >= replacement.length) {
      result += char;
      continue;
    }

    const next = replacement[i + 1];
    if (next === "$") {
      result += "$";
      i += 1;
      continue;
    }
    if (next === "&") {
      result += match;
      i += 1;
      continue;
    }
    if (next === "<" && namedGroups !== undefined) {
      const end = replacement.indexOf(">", i + 2);
      if (end >= 0) {
        result += namedGroups[replacement.slice(i + 2, end)] ?? "";
        i = end;
        continue;
      }
    }
    if (/\d/.test(next)) {
      const secondDigit = replacement[i + 2];
      if (secondDigit !== undefined && /\d/.test(secondDigit)) {
        const twoDigitIndex = Number(next + secondDigit);
        if (twoDigitIndex >= 1 && twoDigitIndex <= captures.length) {
          result += captures[twoDigitIndex - 1] ?? "";
          i += 2;
          continue;
        }
      }
      const oneDigitIndex = Number(next);
      if (oneDigitIndex >= 1 && oneDigitIndex <= captures.length) {
        result += captures[oneDigitIndex - 1] ?? "";
        i += 1;
        continue;
      }
    }
    result += "$";
  }
  return result;
}

function replaceNthMatch(input: string, globalRe: RegExp, replacement: string, n: number): string {
  let matchCount = 0;
  return input.replace(globalRe, (match: string, ...callbackArgs: unknown[]) => {
    matchCount += 1;
    if (matchCount !== n) return match;

    const lastArg = callbackArgs[callbackArgs.length - 1];
    const hasNamedGroups = typeof lastArg === "object" && lastArg !== null;
    const capturesEnd = callbackArgs.length - (hasNamedGroups ? 3 : 2);
    const captures = callbackArgs.slice(0, capturesEnd) as (string | undefined)[];
    const namedGroups = hasNamedGroups
      ? lastArg as Record<string, string | undefined>
      : undefined;
    return expandRegexpReplacement(replacement, match, captures, namedGroups);
  });
}

// ============================================================
// 文字列・数値関数
// ============================================================

export function evalStringFunc(
  expr: StringFuncExpr,
  row: ProcessRow,
  resolveFieldType?: FieldTypeResolver,
  resolveFieldSemantics?: FieldSemanticsResolver
): string {
  assertStringFunctionArity(expr.func, expr.args);
  const args = expr.args.map((a) => evalStringFuncArg(a, row, resolveFieldType, resolveFieldSemantics));
  switch (expr.func) {
    case "UPPER":  return (args[0] ?? "").toUpperCase();
    case "LOWER":  return (args[0] ?? "").toLowerCase();
    case "TRIM":   return (args[0] ?? "").trim();
    case "LTRIM":  return (args[0] ?? "").trimStart();
    case "RTRIM":  return (args[0] ?? "").trimEnd();
    case "LENGTH": return String((args[0] ?? "").length);
    case "LENGTH_CHAR":
      return String([...(args[0] ?? "")].length);
    case "SUBSTRING": {
      const str   = args[0] ?? "";
      const start = Math.max(0, Number(args[1] ?? "1") - 1); // SQL は 1-indexed
      const len   = args[2] !== undefined ? Number(args[2]) : undefined;
      return sliceSafeRange(str, start, len !== undefined ? start + len : str.length);
    }
    case "LEFT": {
      const str = args[0];
      const n = Math.trunc(Number(args[1]));
      return Number.isNaN(n) || n <= 0 ? "" : sliceSafePrefix(str, n);
    }
    case "RIGHT": {
      const str = args[0];
      const n = Math.trunc(Number(args[1]));
      return Number.isNaN(n) || n <= 0 ? "" : sliceSafeSuffix(str, n);
    }
    case "INSTR":
      return String(args[0].indexOf(args[1]) + 1);
    case "LPAD":
    case "RPAD": {
      const str = args[0];
      const n = Math.trunc(Number(args[1]));
      if (Number.isNaN(n) || n <= 0) return "";
      if (str.length >= n) return sliceSafePrefix(str, n);
      const pad = args[2] ?? " ";
      if (pad === "") return str;
      const padding = makeSafePadding(pad, n - str.length);
      return expr.func === "LPAD" ? padding + str : str + padding;
    }
    case "GREATEST":
    case "LEAST":
      return selectScalarExtreme(args, expr.func === "GREATEST" ? "greatest" : "least");
    case "CONCAT":   return args.join("");
    case "REPLACE": {
      const str  = args[0] ?? "";
      const from = args[1] ?? "";
      const to   = args[2] ?? "";
      return from === "" ? str : str.split(from).join(to);
    }
    case "REGEXP_LIKE": {
      return compileRegexp(args[1], args[2] ?? "").test(args[0]) ? "1" : "0";
    }
    case "REGEXP_REPLACE": {
      assertRegexpReplacement(args[2]);
      const occurrence = parseRegexpOccurrence(args[4]);
      const regexp = compileRegexp(args[1], args[3] ?? "", true);
      return occurrence === 0
        ? args[0].replace(regexp, args[2])
        : replaceNthMatch(args[0], regexp, args[2], occurrence);
    }
    case "REGEXP_SUBSTR": {
      return compileRegexp(args[1], args[2] ?? "").exec(args[0])?.[0] ?? "";
    }
    case "TRANSLATE": {
      const from = [...args[1]];
      const to = [...args[2]];
      if (from.length !== to.length) {
        throw new Error(
          `ArgumentError: TRANSLATE の from と to は同じ文字数である必要があります（from=${from.length}, to=${to.length}）`
        );
      }
      const map = new Map<string, string>();
      from.forEach((ch, i) => {
        if (!map.has(ch)) map.set(ch, to[i]);
      });
      return [...args[0]].map((ch) => map.get(ch) ?? ch).join("");
    }
    case "COALESCE":
      return args.find((a) => a !== "") ?? "";
    case "NULLIF":
      // NULLIF(a, b): a == b なら空文字（NULL 相当）、それ以外は a
      return (args[0] ?? "") === (args[1] ?? "") ? "" : (args[0] ?? "");
    case "ISNULL":
      // ISNULL(a, b): a が空文字なら b、それ以外は a（COALESCE の 2引数版）
      return (args[0] ?? "") !== "" ? (args[0] ?? "") : (args[1] ?? "");
    case "ROUND": return applyRoundOp("round", Number(args[0] ?? "0"), Number(args[1] ?? "0"));
    case "FLOOR": return applyRoundOp("floor", Number(args[0] ?? "0"), Number(args[1] ?? "0"));
    case "CEIL":  return applyRoundOp("ceil",  Number(args[0] ?? "0"), Number(args[1] ?? "0"));
    case "TRUNCATE":
      return applyRoundOp("trunc", Number(args[0]), Number(args[1] ?? "0"));
    case "CAST": {
      const val      = args[0] ?? "";
      const castType = args[1] ?? "TEXT";
      if (castType === "NUMBER") {
        const n = Number(val);
        // 数値に変換できない場合は元の文字列をそのまま返す
        return isNaN(n) ? val : String(n);
      }
      // TEXT: 数値フィールドをそのまま文字列として返す（すでに string 型なので変換不要）
      return val;
    }
    case "FORMAT": {
      const num     = Number(args[0] ?? "0");
      const pattern = args[1] ?? "0";
      return applyFormat(num, pattern);
    }
    case "YEAR": {
      const d = args[0] ?? "";
      return d.length >= 4 ? String(parseInt(d.slice(0, 4), 10)) : "";
    }
    case "MONTH": {
      const d = args[0] ?? "";
      return d.length >= 7 ? String(parseInt(d.slice(5, 7), 10)) : "";
    }
    case "DAY": {
      const d = args[0] ?? "";
      return d.length >= 10 ? String(parseInt(d.slice(8, 10), 10)) : "";
    }
    case "DAYOFWEEK":
      return isValidYmd(args[0]) ? String(dayOfWeekIndex(args[0]) + 1) : "";
    case "QUARTER":
      return isValidYmd(args[0]) ? String(Math.ceil(Number(args[0].slice(5, 7)) / 3)) : "";
    case "WEEK":
      return isValidYmd(args[0]) ? String(isoWeekNumber(args[0])) : "";
    case "DATE_FORMAT":
      return applyDateFormat(args[0] ?? "", args[1] ?? "");
    case "DATEDIFF":
      return applyDateDiff(args[0] ?? "", args[1] ?? "");
    case "DATE_ADD":
      return applyDateAdd(args[0] ?? "", Number(args[1] ?? "0"), (args[2] ?? "DAY").toUpperCase());
    case "LAST_DAY":
      return applyLastDay(args[0]);
    case "ABS":
      return String(Math.abs(Number(args[0] ?? "0")));
    case "MOD": {
      const a = Number(args[0] ?? "0");
      const b = Number(args[1] ?? "0");
      return String(b !== 0 ? a % b : NaN);
    }
    case "POWER":
      return String(Math.pow(Number(args[0] ?? "0"), Number(args[1] ?? "0")));
    case "SQRT":
      return String(Math.sqrt(Number(args[0] ?? "0")));
    case "CURRENT_DATE": {
      const now = new Date();
      const y = now.getFullYear();
      const m = String(now.getMonth() + 1).padStart(2, "0");
      const d = String(now.getDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
    case "CURRENT_TIMESTAMP":
      return new Date().toISOString();
  }
}

// ============================================================
// 日付ヘルパー
// ============================================================

/**
 * kintone の日付文字列（YYYY-MM-DD / YYYY-MM-DDTHH:mm:ssZ）を
 * 年・月・日・時・分・秒に分解して返す。
 */
function parseDateParts(s: string): {
  y: string; mo: string; d: string; h: string; mi: string; sec: string;
} {
  return {
    y:   s.slice(0, 4)  || "0000",
    mo:  s.slice(5, 7)  || "01",
    d:   s.slice(8, 10) || "01",
    h:   s.length >= 13 ? s.slice(11, 13) : "00",
    mi:  s.length >= 16 ? s.slice(14, 16) : "00",
    sec: s.length >= 19 ? s.slice(17, 19) : "00",
  };
}

function ymdUtcDate(dateStr: string): Date {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(
    Number(dateStr.slice(0, 4)),
    Number(dateStr.slice(5, 7)) - 1,
    Number(dateStr.slice(8, 10))
  );
  return date;
}

/** 先頭 10 文字が YYYY-MM-DD で、暦上も実在することを round-trip で検証する。 */
export function isValidYmd(dateStr: string): boolean {
  const ymd = dateStr.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return false;
  const date = ymdUtcDate(ymd);
  return date.getUTCFullYear() === Number(ymd.slice(0, 4))
    && date.getUTCMonth() + 1 === Number(ymd.slice(5, 7))
    && date.getUTCDate() === Number(ymd.slice(8, 10));
}

/** 0=日曜〜6=土曜。 */
export function dayOfWeekIndex(dateStr: string): number {
  return ymdUtcDate(dateStr).getUTCDay();
}

function isoWeekThursday(dateStr: string): Date {
  const date = ymdUtcDate(dateStr);
  const isoDay = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - isoDay);
  return date;
}

/** ISO-8601 week-year。 */
export function isoWeekYear(dateStr: string): number {
  return isoWeekThursday(dateStr).getUTCFullYear();
}

/** ISO-8601 週番号（木曜日を含む週が W01）。 */
export function isoWeekNumber(dateStr: string): number {
  const thursday = isoWeekThursday(dateStr);
  const year = thursday.getUTCFullYear();
  const jan4 = ymdUtcDate(`${String(year).padStart(4, "0")}-01-04`);
  const jan4IsoDay = jan4.getUTCDay() || 7;
  jan4.setUTCDate(jan4.getUTCDate() + 4 - jan4IsoDay);
  return 1 + Math.round((thursday.getTime() - jan4.getTime()) / (7 * 86_400_000));
}

/**
 * DATE_FORMAT — MySQL 互換の書式整形
 *
 * サポートする書式指定子:
 *   %Y  → 4桁年        例: 2024
 *   %y  → 2桁年        例: 24
 *   %m  → 2桁月(01-12) 例: 03
 *   %c  → 月(1-12)     例: 3
 *   %d  → 2桁日(01-31) 例: 05
 *   %e  → 日(1-31)     例: 5
 *   %H  → 2桁時(00-23) 例: 09
 *   %i  → 2桁分(00-59) 例: 07
 *   %s  → 2桁秒(00-59) 例: 00
 *   %w  → 曜日番号(日曜=0〜土曜=6)
 *   %a  → kSQL 定義の日本語短縮曜日(日〜土)
 *   %v  → ISO 週番号(01-53)
 *   %G  → ISO week-year
 */
function applyDateFormat(dateStr: string, pattern: string): string {
  if (!dateStr || dateStr.length < 10) return "";
  const { y, mo, d, h, mi, sec } = parseDateParts(dateStr);
  const validYmd = isValidYmd(dateStr);
  return pattern.replace(/%[YymcdeHiswavG]/g, (specifier) => {
    switch (specifier) {
      case "%Y": return y;
      case "%y": return y.slice(2);
      case "%m": return mo;
      case "%c": return String(parseInt(mo, 10));
      case "%d": return d;
      case "%e": return String(parseInt(d, 10));
      case "%H": return h;
      case "%i": return mi;
      case "%s": return sec;
      case "%w": return validYmd ? String(dayOfWeekIndex(dateStr)) : "";
      case "%a": return validYmd ? ["日", "月", "火", "水", "木", "金", "土"][dayOfWeekIndex(dateStr)] : "";
      case "%v": return validYmd ? String(isoWeekNumber(dateStr)).padStart(2, "0") : "";
      case "%G": return validYmd ? String(isoWeekYear(dateStr)).padStart(4, "0") : "";
      default: return specifier;
    }
  });
}

/**
 * DATEDIFF — 2つの日付の差（日数）を返す
 * 結果 = date1 - date2（date1 の方が未来なら正の値）
 */
function applyDateDiff(date1: string, date2: string): string {
  if (date1.length < 10 || date2.length < 10) return "0";
  const p1 = parseDateParts(date1);
  const p2 = parseDateParts(date2);
  const d1 = Date.UTC(+p1.y, +p1.mo - 1, +p1.d);
  const d2 = Date.UTC(+p2.y, +p2.mo - 1, +p2.d);
  return String(Math.round((d1 - d2) / 86_400_000));
}

/**
 * DATE_ADD — 日付に指定単位を加算して YYYY-MM-DD 形式で返す
 *
 * サポートする単位: YEAR / MONTH / DAY（大文字・小文字不問）
 */
function applyDateAdd(dateStr: string, n: number, unit: string): string {
  if (unit !== "YEAR" && unit !== "MONTH" && unit !== "DAY") {
    throw new Error("ArgumentError: DATE_ADD unit must be YEAR, MONTH, or DAY.");
  }
  if (!dateStr || dateStr.length < 10) return dateStr;
  const { y, mo, d } = parseDateParts(dateStr);
  const dt = new Date(Date.UTC(+y, +mo - 1, +d));

  const addCalendarUnit = (applyTarget: () => void): void => {
    const originalDay = dt.getUTCDate();
    dt.setUTCDate(1);
    applyTarget();

    const endOfTargetMonth = new Date(dt.getTime());
    endOfTargetMonth.setUTCMonth(endOfTargetMonth.getUTCMonth() + 1);
    endOfTargetMonth.setUTCDate(0);
    dt.setUTCDate(Math.min(originalDay, endOfTargetMonth.getUTCDate()));
  };

  switch (unit) {
    case "YEAR":  addCalendarUnit(() => dt.setUTCFullYear(dt.getUTCFullYear() + n)); break;
    case "MONTH": addCalendarUnit(() => dt.setUTCMonth(dt.getUTCMonth() + n));       break;
    case "DAY":   dt.setUTCDate(dt.getUTCDate() + n);         break;
  }
  const ry  = String(dt.getUTCFullYear()).padStart(4, "0");
  const rmo = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const rd  = String(dt.getUTCDate()).padStart(2, "0");
  return `${ry}-${rmo}-${rd}`;
}

/** LAST_DAY — 指定日の月末日を YYYY-MM-DD 形式で返す */
function applyLastDay(dateStr: string): string {
  if (!dateStr || dateStr.length < 10) return dateStr;
  const { y, mo } = parseDateParts(dateStr);
  const dt = new Date(Date.UTC(+y, +mo, 0));
  const ry = String(dt.getUTCFullYear()).padStart(4, "0");
  const rmo = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const rd = String(dt.getUTCDate()).padStart(2, "0");
  return `${ry}-${rmo}-${rd}`;
}

// ============================================================
// FORMAT — 書式整形
//
// パターン文字列（Excel 風サブセット）:
//   '#,##0'      → 整数、千区切り          例: 1234567 → "1,234,567"
//   '#,##0.00'   → 小数2桁、千区切り        例: 1234.5  → "1,234.50"
//   '0.00'       → 小数2桁、区切りなし      例: 1234.5  → "1234.50"
//   '0.00%'      → パーセント（×100）       例: 0.156   → "15.60%"
//   '#,##0.##'   → 小数最大2桁（末尾0省略） 例: 1234.5  → "1,234.5"
// 整数リテラル（MySQL スタイル）:
//   2            → 小数2桁＋千区切り         例: 1234.5  → "1,234.50"
// ============================================================

function applyFormat(num: number, pattern: string): string {
  // MySQL スタイル: pattern が整数なら「桁数＋千区切り」
  if (/^-?\d+$/.test(pattern.trim())) {
    return formatWithComma(num, Math.max(0, Number(pattern)));
  }

  const isPercent = pattern.endsWith("%");
  const useComma  = pattern.includes(",");
  const n         = isPercent ? num * 100 : num;

  // 小数桁数: パターン中の "." 以降の文字数
  const dotIdx      = pattern.replace(/%$/, "").lastIndexOf(".");
  const afterDot    = dotIdx >= 0 ? pattern.slice(dotIdx + 1).replace(/%$/, "") : "";
  const required0   = (afterDot.match(/0/g) ?? []).length;  // 必須桁（0）
  const optional    = (afterDot.match(/#/g) ?? []).length;  // 省略可（#）

  // 「#」は余分な末尾ゼロを省略する
  const maxDec = required0 + optional;
  const formatted = n.toFixed(maxDec);
  let [intStr, decStr = ""] = formatted.split(".");

  // '#' 分の末尾ゼロを除去
  if (optional > 0) {
    decStr = decStr.replace(/0+$/, "");
  }

  const intFmt = useComma
    ? intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
    : intStr;

  const result = decStr ? `${intFmt}.${decStr}` : intFmt;
  return isPercent ? result + "%" : result;
}

/** 千区切り＋小数桁数指定（MySQL スタイル） */
function formatWithComma(num: number, digits: number): string {
  const formatted = num.toFixed(digits);
  const [intStr, decStr] = formatted.split(".");
  const intFmt = intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return decStr ? `${intFmt}.${decStr}` : intFmt;
}

export function evalStringFuncArg(
  arg: StringFuncArg,
  row: ProcessRow,
  resolveFieldType?: FieldTypeResolver,
  resolveFieldSemantics?: FieldSemanticsResolver
): string {
  // GROUP BY が SELECT に実体化した集計依存値を使って HAVING からも評価する。
  if (arg.type === "AGG_REF" || arg.type === "AGG_ARITH" || arg.type === "AGG_GROUP_KEY") {
    return String(evalMaterializedAggregateOperand(arg, row));
  }
  if (arg.type === "NUMBER") return numberLiteralText(arg);
  return String(evalScalarValueExpr(arg, row, resolveFieldType, resolveFieldSemantics));
}

/** SELECT により実体化済みの合成集計キーだけを使って集計算術式を評価する。 */
export function evalMaterializedAggregateOperand(node: AggOperand, row: ProcessRow): number | string {
  if (node.type === "NUMBER") return node.value;
  if (node.type === "AGG_REF") {
    return row[aggregateSyntheticName(node.func, node.distinct, node.arg)] ?? "";
  }
  if (node.type === "AGG_GROUP_KEY") {
    const field = node.tableAlias ? `${node.tableAlias}.${node.field}` : node.field;
    return Number(resolveFieldRef(row, field));
  }
  if (node.type === "VARIABLE") {
    throw new Error(`InternalError: unresolved aggregate arithmetic variable @${node.name}.`);
  }
  const left = Number(evalMaterializedAggregateOperand(node.left, row));
  const right = Number(evalMaterializedAggregateOperand(node.right, row));
  switch (node.op) {
    case "+": return left + right;
    case "-": return left - right;
    case "*": return left * right;
    case "/": return right !== 0 ? left / right : NaN;
    case "%": return right !== 0 ? left % right : NaN;
  }
}

export function resolveFieldRef(row: ProcessRow, field: string): string {
  const direct = row[field];
  if (direct !== undefined) return direct;
  const dot = field.indexOf(".");
  if (dot > 0) {
    const fallback = row[field.slice(dot + 1)];
    if (fallback !== undefined) return fallback;
  }
  return "";
}
