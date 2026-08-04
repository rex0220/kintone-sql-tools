import { assertStringFunctionArity } from "../functionArity";
import type { StringFuncName } from "../../types/ast";

const validArgs: Record<StringFuncName, number[]> = {
  UPPER: [1], LOWER: [1], TRIM: [1], LTRIM: [1], RTRIM: [1],
  LENGTH: [1], LENGTH_CHAR: [1], SUBSTRING: [2, 3], CONCAT: [2, 4], REPLACE: [3], TRANSLATE: [3],
  COALESCE: [2, 4], REGEXP_LIKE: [2, 3], REGEXP_REPLACE: [3, 4, 5], REGEXP_SUBSTR: [2, 3],
  NULLIF: [2], ISNULL: [2], LEFT: [2], RIGHT: [2], INSTR: [2], LPAD: [2, 3], RPAD: [2, 3],
  GREATEST: [2, 4], LEAST: [2, 4], ROUND: [1, 2], FLOOR: [1, 2], CEIL: [1, 2], TRUNCATE: [1, 2],
  CAST: [2], FORMAT: [2], YEAR: [1], MONTH: [1], DAY: [1], DAYOFWEEK: [1], QUARTER: [1], WEEK: [1],
  DATE_FORMAT: [2], DATEDIFF: [2], DATE_ADD: [3], LAST_DAY: [1], ABS: [1], MOD: [2], POWER: [2], SQRT: [1],
  CURRENT_DATE: [0], CURRENT_TIMESTAMP: [0],
};

test.each(Object.entries(validArgs))("B118: %s はリファレンス記載の引数数を受理する", (func, counts) => {
  for (const count of counts) {
    expect(() => assertStringFunctionArity(func as StringFuncName, Array(count))).not.toThrow();
  }
});

test.each(Object.entries(validArgs))("B118: %s は範囲外の引数数を拒否する", (func, counts) => {
  const min = Math.min(...counts);
  const max = counts.length > 1 && counts[counts.length - 1] > counts[0] + 1
    ? Number.POSITIVE_INFINITY
    : Math.max(...counts);
  if (min > 0) {
    expect(() => assertStringFunctionArity(func as StringFuncName, Array(min - 1)))
      .toThrow(`ArgumentError: ${func} expects`);
  }
  if (Number.isFinite(max)) {
    expect(() => assertStringFunctionArity(func as StringFuncName, Array(max + 1)))
      .toThrow(`ArgumentError: ${func} expects`);
  }
});
