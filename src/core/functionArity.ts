import type { StringFuncName } from "../types/ast";

function assertArity(func: string, args: readonly unknown[], min: number, max = Number.POSITIVE_INFINITY): void {
  if (args.length >= min && args.length <= max) return;
  const expected = min === max ? String(min) : max === Number.POSITIVE_INFINITY ? `${min} or more` : `${min} to ${max}`;
  throw new Error(`ArgumentError: ${func} expects ${expected} argument(s).`);
}

/** 言語リファレンスの関数表「構文」列に基づくスカラー関数の引数個数。 */
export function assertStringFunctionArity(func: StringFuncName, args: readonly unknown[]): void {
  switch (func) {
    case "UPPER":
    case "LOWER":
    case "TRIM":
    case "LTRIM":
    case "RTRIM":
    case "LENGTH":
    case "LENGTH_CHAR":
    case "YEAR":
    case "MONTH":
    case "DAY":
    case "DAYOFWEEK":
    case "QUARTER":
    case "WEEK":
    case "LAST_DAY":
    case "ABS":
    case "SQRT":
      return assertArity(func, args, 1, 1);

    case "SUBSTRING":
    case "LPAD":
    case "RPAD":
    case "REGEXP_LIKE":
    case "REGEXP_SUBSTR":
      return assertArity(func, args, 2, 3);

    case "LEFT":
    case "RIGHT":
    case "INSTR":
    case "ISNULL":
    case "NULLIF":
    case "MOD":
    case "POWER":
    case "FORMAT":
    case "CAST":
    case "DATE_FORMAT":
    case "DATEDIFF":
      return assertArity(func, args, 2, 2);

    case "CONCAT":
    case "COALESCE":
    case "GREATEST":
    case "LEAST":
      return assertArity(func, args, 2);

    case "REPLACE":
    case "TRANSLATE":
    case "DATE_ADD":
      return assertArity(func, args, 3, 3);

    case "REGEXP_REPLACE":
      return assertArity(func, args, 3, 5);

    case "ROUND":
    case "FLOOR":
    case "CEIL":
    case "TRUNCATE":
      return assertArity(func, args, 1, 2);

    case "CURRENT_DATE":
    case "CURRENT_TIMESTAMP":
      return assertArity(func, args, 0, 0);
  }
}
