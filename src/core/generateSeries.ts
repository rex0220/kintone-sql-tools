import type {
  GenerateSeriesArgument,
  GenerateSeriesStatement,
  NumberLiteral,
  StringLiteral,
} from "../types/ast";
import { numberLiteralText } from "../types/ast";
import { parseExactDecimal } from "./exactDecimal";

export const GENERATED_ROW_MAX_ROWS = 10_000;
export const GENERATE_SERIES_MAX_ROWS = GENERATED_ROW_MAX_ROWS;

export interface ResolvedSeries {
  readonly kind: "INTEGER" | "DATE";
  readonly start: number | string;
  readonly stop: number | string;
  readonly step: number;
  readonly rowCount: number;
  readonly values: readonly string[];
}

interface SeriesPlan {
  readonly kind: "INTEGER" | "DATE";
  readonly start: number | string;
  readonly stop: number | string;
  readonly step: number;
  readonly rowCount: number;
}

const argumentError = (message: string): Error => new Error(`ArgumentError: ${message}`);
const isVariable = (arg: GenerateSeriesArgument): boolean => arg.type === "VARIABLE";
const isResolvedVariable = (arg: NumberLiteral | StringLiteral | undefined): boolean =>
  arg?.type === "STRING" && arg.fromVariable === true;

function literalValue(arg: NumberLiteral | StringLiteral): number | string {
  return arg.type === "NUMBER" ? Number(numberLiteralText(arg)) : arg.value;
}

function dateParts(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? { year, month, day }
    : null;
}

function dateOrdinal(value: string): number {
  const parts = dateParts(value)!;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  return Math.trunc(date.getTime() / 86_400_000);
}

function dateFromOrdinal(ordinal: number): string {
  const date = new Date(ordinal * 86_400_000);
  const year = date.getUTCFullYear();
  if (year < 1 || year > 9999) {
    throw argumentError("GENERATE_SERIES の日付引数には実在する YYYY-MM-DD 形式の DATE を指定してください。");
  }
  return `${String(year).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function parseDateStep(value: string): number {
  const trimmed = value.trim();
  const match = /^([+-]?\d+)\s+(day|days)$/i.exec(trimmed);
  if (!match) {
    if (/^[+-]?\d+\s+\S+$/i.test(trimmed)) {
      throw argumentError("GENERATE_SERIES の日付 step は day または days のみ対応しています。");
    }
    throw argumentError("GENERATE_SERIES の step が系列の型と一致しません。整数系列には整数、DATE 系列には day 単位を指定してください。");
  }
  const step = Number(match[1]);
  if (!Number.isSafeInteger(step)) {
    throw argumentError("GENERATE_SERIES の数値系列は整数の start、stop、step のみを受け付けます。");
  }
  if (step === 0) throw argumentError("GENERATE_SERIES の日付 step に 0 day は指定できません。");
  return step;
}

function integerValue(value: number | string): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
  if (!/^[+-]?\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function integerNumberLiteral(arg: NumberLiteral): number | null {
  const decimal = parseExactDecimal(arg.raw ?? String(arg.value));
  if (decimal === null || decimal.scale > 0) return null;
  if (decimal.sign === 0) return 0;
  const digits = decimal.coefficient.length - decimal.scale;
  if (digits > 16) return null;
  const magnitude = `${decimal.coefficient}${"0".repeat(-decimal.scale)}`;
  if (magnitude.length === 16 && magnitude > "9007199254740991") return null;
  const value = Number(magnitude) * decimal.sign;
  return Number.isSafeInteger(value) ? value : null;
}

function isUnsupportedTemporal(value: unknown): boolean {
  return typeof value === "string" && (
    /^\d{4}-\d{2}-\d{2}T/.test(value)
    || /^\d{2}:\d{2}(?::\d{2})?$/.test(value)
  );
}

function countRows(start: number, stop: number, step: number): number {
  if (start === stop) return 1;
  if ((start < stop && step < 0) || (start > stop && step > 0)) return 0;
  const distance = step > 0 ? BigInt(stop) - BigInt(start) : BigInt(start) - BigInt(stop);
  return Number(distance / BigInt(Math.abs(step)) + 1n);
}

function planResolved(stmt: GenerateSeriesStatement): SeriesPlan {
  if (stmt.args.length < 2 || stmt.args.length > 3) {
    throw argumentError("GENERATE_SERIES は start、stop と省略可能な step の2個または3個の引数を受け付けます。");
  }
  const values = stmt.args.map((arg) => literalValue(arg as NumberLiteral | StringLiteral));
  (["start", "stop", "step"] as const).forEach((name, index) => {
    if (values[index] === "") throw argumentError(`GENERATE_SERIES の ${name} に空文字は指定できません。`);
  });
  const [startRaw, stopRaw, stepRaw] = values;
  const [startArg, stopArg, stepArg] = stmt.args as Array<NumberLiteral | StringLiteral>;
  const startDate = typeof startRaw === "string" ? dateParts(startRaw) : null;
  const stopDate = typeof stopRaw === "string" ? dateParts(stopRaw) : null;
  const dateLikeStart = typeof startRaw === "string" && /^\d{4}-/.test(startRaw);
  const dateLikeStop = typeof stopRaw === "string" && /^\d{4}-/.test(stopRaw);
  if ([startRaw, stopRaw].some(isUnsupportedTemporal)) {
    throw argumentError("GENERATE_SERIES は Phase 1 では整数と DATE のみ対応しています。DATETIME と TIME は使用できません。");
  }
  if (startDate || stopDate || dateLikeStart || dateLikeStop || (
    typeof startRaw === "string" && typeof stopRaw === "string"
    && !(isResolvedVariable(startArg) && isResolvedVariable(stopArg) && integerValue(startRaw) !== null && integerValue(stopRaw) !== null)
  )) {
    if (!startDate || !stopDate) {
      if ((startDate && typeof stopRaw !== "string") || (stopDate && typeof startRaw !== "string")) {
        throw argumentError("GENERATE_SERIES の start と stop は、両方を整数または両方を DATE にしてください。");
      }
      throw argumentError("GENERATE_SERIES の日付引数には実在する YYYY-MM-DD 形式の DATE を指定してください。");
    }
    if (stepRaw !== undefined && typeof stepRaw !== "string") {
      throw argumentError("GENERATE_SERIES の step が系列の型と一致しません。整数系列には整数、DATE 系列には day 単位を指定してください。");
    }
    const step = stepRaw === undefined ? 1 : parseDateStep(stepRaw as string);
    const start = startRaw as string;
    const stop = stopRaw as string;
    return { kind: "DATE", start, stop, step, rowCount: countRows(dateOrdinal(start), dateOrdinal(stop), step) };
  }
  const startInteger = startArg.type === "NUMBER"
    ? integerNumberLiteral(startArg)
    : isResolvedVariable(startArg) ? integerValue(startRaw) : null;
  const stopInteger = stopArg.type === "NUMBER"
    ? integerNumberLiteral(stopArg)
    : isResolvedVariable(stopArg) ? integerValue(stopRaw) : null;
  if (startInteger === null || stopInteger === null) {
    if ((startArg.type === "NUMBER" || isResolvedVariable(startArg)) && (stopArg.type === "NUMBER" || isResolvedVariable(stopArg))) {
      throw argumentError("GENERATE_SERIES の数値系列は整数の start、stop、step のみを受け付けます。");
    }
    throw argumentError("GENERATE_SERIES の start と stop は、両方を整数または両方を DATE にしてください。");
  }
  const resolvedStep = stepRaw === undefined ? 1
    : stepArg?.type === "NUMBER" ? integerNumberLiteral(stepArg)
    : isResolvedVariable(stepArg) ? integerValue(stepRaw) : null;
  if (resolvedStep === null) {
    if (stepArg?.type === "NUMBER" || isResolvedVariable(stepArg)) {
      throw argumentError("GENERATE_SERIES の数値系列は整数の start、stop、step のみを受け付けます。");
    }
    throw argumentError("GENERATE_SERIES の step が系列の型と一致しません。整数系列には整数、DATE 系列には day 単位を指定してください。");
  }
  const start = startInteger;
  const stop = stopInteger;
  const step = resolvedStep;
  if (step === 0) throw argumentError("GENERATE_SERIES の step に 0 は指定できません。");
  return { kind: "INTEGER", start, stop, step, rowCount: countRows(start, stop, step) };
}

/** AST-only 検証。変数を含む値依存判定は実行時へ保留する。 */
export function validateGenerateSeriesStatement(stmt: GenerateSeriesStatement): number | null {
  if (stmt.args.length < 2 || stmt.args.length > 3) {
    throw argumentError("GENERATE_SERIES は start、stop と省略可能な step の2個または3個の引数を受け付けます。");
  }
  if (stmt.args.some(isVariable)) {
    (["start", "stop", "step"] as const).forEach((name, index) => {
      const arg = stmt.args[index];
      if (arg?.type === "STRING" && arg.value === "") {
        throw argumentError(`GENERATE_SERIES の ${name} に空文字は指定できません。`);
      }
      if (arg?.type === "NUMBER" && integerNumberLiteral(arg) === null) {
        throw argumentError("GENERATE_SERIES の数値系列は整数の start、stop、step のみを受け付けます。");
      }
      if (index < 2 && arg?.type === "STRING") {
        if (isUnsupportedTemporal(arg.value)) {
          throw argumentError("GENERATE_SERIES は Phase 1 では整数と DATE のみ対応しています。DATETIME と TIME は使用できません。");
        }
        if (/^\d{4}-/.test(arg.value) && dateParts(arg.value) === null) {
          throw argumentError("GENERATE_SERIES の日付引数には実在する YYYY-MM-DD 形式の DATE を指定してください。");
        }
      }
    });
    const step = stmt.args[2];
    if (step?.type === "NUMBER") {
      const value = integerNumberLiteral(step);
      if (value === null) throw argumentError("GENERATE_SERIES の数値系列は整数の start、stop、step のみを受け付けます。");
      if (value === 0) throw argumentError("GENERATE_SERIES の step に 0 は指定できません。");
    } else if (step?.type === "STRING") {
      parseDateStep(step.value);
    }
    return null;
  }
  const plan = planResolved(stmt);
  if (plan.rowCount > GENERATE_SERIES_MAX_ROWS) {
    throw argumentError(`GENERATE_SERIES の生成件数 ${plan.rowCount} 行が上限 ${GENERATE_SERIES_MAX_ROWS} 行を超えています。`);
  }
  return plan.rowCount;
}

export function validateGenerateSeriesInStatement(node: unknown): void {
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const obj = value as Record<string, unknown>;
    if (obj.type === "WITH") {
      let total = 0;
      let complete = true;
      for (const cte of (obj.ctes as Array<{ query: unknown }>)) {
        if ((cte.query as { type?: string }).type === "GENERATE_SERIES") {
          const count = validateGenerateSeriesStatement(cte.query as GenerateSeriesStatement);
          if (count === null) complete = false;
          else total += count;
        } else visit(cte.query);
      }
      if (complete && total > GENERATE_SERIES_MAX_ROWS) {
        throw argumentError(`この WITH 文の GENERATE_SERIES 生成件数合計 ${total} 行が上限 ${GENERATE_SERIES_MAX_ROWS} 行を超えています。`);
      }
      visit(obj.query);
      return;
    }
    Object.values(obj).forEach(visit);
  };
  visit(node);
}

export function resolveGenerateSeries(stmt: GenerateSeriesStatement): ResolvedSeries {
  const plan = planResolved(stmt);
  if (plan.rowCount > GENERATE_SERIES_MAX_ROWS) {
    throw argumentError(`GENERATE_SERIES の生成件数 ${plan.rowCount} 行が上限 ${GENERATE_SERIES_MAX_ROWS} 行を超えています。`);
  }
  const values: string[] = [];
  if (plan.kind === "INTEGER") {
    let current = plan.start as number;
    for (let index = 0; index < plan.rowCount; index++) {
      values.push(String(current));
      if (index + 1 < plan.rowCount) {
        const next = current + plan.step;
        if (!Number.isSafeInteger(next)) throw argumentError("GENERATE_SERIES の数値系列は整数の start、stop、step のみを受け付けます。");
        current = next;
      }
    }
  } else {
    const startOrdinal = dateOrdinal(plan.start as string);
    for (let index = 0; index < plan.rowCount; index++) values.push(dateFromOrdinal(startOrdinal + index * plan.step));
  }
  return { ...plan, values };
}
