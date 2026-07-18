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
} from "../types/ast";
import type { ProcessRow } from "./evalWhere";
import { selectScalarExtreme } from "../core/scalarCompare";

// ============================================================
// 算術式
// ============================================================

export function evalArithExpr(expr: ArithNode, row: ProcessRow): number {
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

// ============================================================
// 文字列・数値関数
// ============================================================

export function evalStringFunc(expr: StringFuncExpr, row: ProcessRow): string {
  const args = expr.args.map((a) => evalStringFuncArg(a, row));
  switch (expr.func) {
    case "UPPER":  return (args[0] ?? "").toUpperCase();
    case "LOWER":  return (args[0] ?? "").toLowerCase();
    case "TRIM":   return (args[0] ?? "").trim();
    case "LTRIM":  return (args[0] ?? "").trimStart();
    case "RTRIM":  return (args[0] ?? "").trimEnd();
    case "LENGTH": return String((args[0] ?? "").length);
    case "LENGTH_CHAR":
      assertArity("LENGTH_CHAR", args, 1, 1);
      return String([...(args[0] ?? "")].length);
    case "SUBSTRING": {
      const str   = args[0] ?? "";
      const start = Math.max(0, Number(args[1] ?? "1") - 1); // SQL は 1-indexed
      const len   = args[2] !== undefined ? Number(args[2]) : undefined;
      return sliceSafeRange(str, start, len !== undefined ? start + len : str.length);
    }
    case "LEFT": {
      assertArity("LEFT", args, 2, 2);
      const str = args[0];
      const n = Math.trunc(Number(args[1]));
      return Number.isNaN(n) || n <= 0 ? "" : sliceSafePrefix(str, n);
    }
    case "RIGHT": {
      assertArity("RIGHT", args, 2, 2);
      const str = args[0];
      const n = Math.trunc(Number(args[1]));
      return Number.isNaN(n) || n <= 0 ? "" : sliceSafeSuffix(str, n);
    }
    case "INSTR":
      assertArity("INSTR", args, 2, 2);
      return String(args[0].indexOf(args[1]) + 1);
    case "LPAD":
    case "RPAD": {
      assertArity(expr.func, args, 2, 3);
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
      assertArity(expr.func, args, 2);
      return selectScalarExtreme(args, expr.func === "GREATEST" ? "greatest" : "least");
    case "CONCAT":   return args.join("");
    case "REPLACE": {
      const str  = args[0] ?? "";
      const from = args[1] ?? "";
      const to   = args[2] ?? "";
      return from === "" ? str : str.split(from).join(to);
    }
    case "REGEXP_LIKE": {
      assertArity("REGEXP_LIKE", args, 2, 3);
      return compileRegexp(args[1], args[2] ?? "").test(args[0]) ? "1" : "0";
    }
    case "REGEXP_REPLACE": {
      assertArity("REGEXP_REPLACE", args, 3, 4);
      assertRegexpReplacement(args[2]);
      return args[0].replace(compileRegexp(args[1], args[3] ?? "", true), args[2]);
    }
    case "REGEXP_SUBSTR": {
      assertArity("REGEXP_SUBSTR", args, 2, 3);
      return compileRegexp(args[1], args[2] ?? "").exec(args[0])?.[0] ?? "";
    }
    case "TRANSLATE": {
      assertArity("TRANSLATE", args, 3, 3);
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
      assertArity("TRUNCATE", args, 1, 2);
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
    case "DATE_FORMAT":
      return applyDateFormat(args[0] ?? "", args[1] ?? "");
    case "DATEDIFF":
      return applyDateDiff(args[0] ?? "", args[1] ?? "");
    case "DATE_ADD":
      return applyDateAdd(args[0] ?? "", Number(args[1] ?? "0"), (args[2] ?? "DAY").toUpperCase());
    case "LAST_DAY":
      assertArity("LAST_DAY", args, 1, 1);
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

function assertArity(func: string, args: readonly string[], min: number, max = Number.POSITIVE_INFINITY): void {
  if (args.length >= min && args.length <= max) return;
  const expected = min === max ? String(min) : max === Number.POSITIVE_INFINITY ? `${min} or more` : `${min} to ${max}`;
  throw new Error(`ArgumentError: ${func} expects ${expected} argument(s).`);
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
 */
function applyDateFormat(dateStr: string, pattern: string): string {
  if (!dateStr || dateStr.length < 10) return "";
  const { y, mo, d, h, mi, sec } = parseDateParts(dateStr);
  return pattern
    .replace(/%Y/g, y)
    .replace(/%y/g, y.slice(2))
    .replace(/%m/g, mo)
    .replace(/%c/g, String(parseInt(mo, 10)))
    .replace(/%d/g, d)
    .replace(/%e/g, String(parseInt(d, 10)))
    .replace(/%H/g, h)
    .replace(/%i/g, mi)
    .replace(/%s/g, sec);
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
  switch (unit) {
    case "YEAR":  dt.setUTCFullYear(dt.getUTCFullYear() + n); break;
    case "MONTH": dt.setUTCMonth(dt.getUTCMonth() + n);       break;
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

export function evalStringFuncArg(arg: StringFuncArg, row: ProcessRow): string {
  if (arg.type === "STRING")      return arg.value;
  if (arg.type === "STRING_FUNC") return evalStringFunc(arg, row);
  if (arg.type === "FIELD_REF")   return resolveFieldRef(row, arg.field);
  if (arg.type === "NUMBER")      return String(arg.value);
  // 集計引数は GROUP BY 評価側で事前解決される想定。
  // ここに到達した場合は行コンテキストのみのため空文字を返して安全側に倒す。
  if (arg.type === "AGG_REF" || arg.type === "AGG_ARITH") return "";
  return String(evalArithExpr(arg, row)); // ARITH
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
