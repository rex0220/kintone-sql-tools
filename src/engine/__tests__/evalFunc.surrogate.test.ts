import { evalStringFunc } from "../evalFunc";
import type { StringFuncArg, StringFuncName } from "../../types/ast";

const stringArg = (value: string): StringFuncArg => ({ type: "STRING", value });
const numberArg = (value: number): StringFuncArg => ({ type: "NUMBER", value });

function evaluate(func: StringFuncName, args: StringFuncArg[]): string {
  return evalStringFunc({ type: "STRING_FUNC", func, args }, {});
}

function left(value: string, n: number): string {
  return evaluate("LEFT", [stringArg(value), numberArg(n)]);
}

function right(value: string, n: number): string {
  return evaluate("RIGHT", [stringArg(value), numberArg(n)]);
}

function substring(value: string, start: number, length?: number): string {
  const args = [stringArg(value), numberArg(start)];
  if (length !== undefined) args.push(numberArg(length));
  return evaluate("SUBSTRING", args);
}

function pad(func: "LPAD" | "RPAD", value: string, n: number, fill: string): string {
  return evaluate(func, [stringArg(value), numberArg(n), stringArg(fill)]);
}

function isHigh(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLow(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function splitsPair(value: string, index: number): boolean {
  return index > 0
    && index < value.length
    && isHigh(value.charCodeAt(index - 1))
    && isLow(value.charCodeAt(index));
}

const inputs = [
  "ABCDE",
  "東京都千代田区",
  "😀",
  "😀".repeat(3),
  "😀".repeat(10),
  "😀".repeat(40),
  "😀あ😀い😀う",
  "あ😀い😀う😀",
  "😀ABCDE",
  "ABCDE😀",
  "AB😀CDE",
  "𩸽😀𩸽😀",
  "𩸽あ😀",
  "あ\ud83dい",
  "あ\ude00い",
  "\ud83d\ud83dあ",
  "",
  "東京都😀千代田区𩸽ABC".repeat(12),
] as const;

const fills = ["0", "😀", "a😀", "😀b"] as const;

test("B22 LEFT / RIGHT は18種の入力と全境界で予算・包含・ペア保存・最大性を満たす", () => {
  for (const value of inputs) {
    for (let n = 0; n <= value.length + 2; n += 1) {
      const prefix = left(value, n);
      expect(prefix.length).toBeLessThanOrEqual(n);
      expect(value.startsWith(prefix)).toBe(true);
      expect(splitsPair(value, prefix.length)).toBe(false);
      if (prefix.length < Math.min(n, value.length)) {
        expect(splitsPair(value, prefix.length + 1)).toBe(true);
      }

      const suffix = right(value, n);
      const suffixStart = value.length - suffix.length;
      expect(suffix.length).toBeLessThanOrEqual(n);
      expect(value.endsWith(suffix)).toBe(true);
      expect(splitsPair(value, suffixStart)).toBe(false);
      if (suffix.length < Math.min(n, value.length)) {
        expect(splitsPair(value, suffixStart - 1)).toBe(true);
      }
    }
  }
});

test("B22 SUBSTRING は18種の入力で開始・長さ全境界と長さ省略の性質を満たす", () => {
  for (const value of inputs) {
    for (let start = 1; start <= value.length + 1; start += 1) {
      for (const length of [undefined, ...Array.from({ length: value.length + 2 }, (_, i) => i)]) {
        const result = substring(value, start, length);
        const requestedStart = Math.min(start - 1, value.length);
        const requestedEnd = length === undefined
          ? value.length
          : Math.min(requestedStart + length, value.length);
        const hasRequestedUnits = requestedEnd > requestedStart;
        const resultStart = requestedStart + (hasRequestedUnits && splitsPair(value, requestedStart) ? 1 : 0);
        const resultEnd = resultStart + result.length;

        if (length !== undefined) expect(result.length).toBeLessThanOrEqual(length);
        expect(value.slice(resultStart, resultEnd)).toBe(result);
        expect(resultStart).toBeGreaterThanOrEqual(requestedStart);
        expect(resultEnd).toBeLessThanOrEqual(requestedEnd);
        if (hasRequestedUnits) {
          expect(splitsPair(value, resultStart)).toBe(false);
          expect(splitsPair(value, resultEnd)).toBe(false);
        }

        if (resultStart > requestedStart) {
          expect(resultStart).toBe(requestedStart + 1);
          expect(splitsPair(value, requestedStart)).toBe(true);
        }
        if (resultEnd < requestedEnd) {
          expect(resultEnd).toBe(requestedEnd - 1);
          expect(splitsPair(value, requestedEnd)).toBe(true);
        }
      }
    }
  }
});

test("B22 LPAD / RPAD は切り詰めと4種の埋めを全境界で最大安全長にする", () => {
  for (const value of inputs) {
    for (let n = 0; n <= value.length + 8; n += 1) {
      for (const fill of fills) {
        for (const func of ["LPAD", "RPAD"] as const) {
          const result = pad(func, value, n, fill);
          expect(result.length).toBeLessThanOrEqual(n);

          if (value.length >= n) {
            expect(value.startsWith(result)).toBe(true);
            expect(splitsPair(value, result.length)).toBe(false);
            if (result.length < Math.min(n, value.length)) {
              expect(splitsPair(value, result.length + 1)).toBe(true);
            }
            continue;
          }

          const gap = n - value.length;
          const padding = func === "LPAD"
            ? result.slice(0, result.length - value.length)
            : result.slice(value.length);
          const repeated = fill.repeat(Math.ceil(gap / fill.length) + 1);
          expect(func === "LPAD" ? result.endsWith(value) : result.startsWith(value)).toBe(true);
          expect(repeated.startsWith(padding)).toBe(true);
          expect(splitsPair(repeated, padding.length)).toBe(false);
          if (padding.length < gap) {
            expect(splitsPair(repeated, padding.length + 1)).toBe(true);
          }
        }
      }
    }
  }
});

test("B22 の代表的な切り詰め・埋めと64コードユニット上限を守る", () => {
  expect(pad("LPAD", "😀😀", 3, "0")).not.toBe("😀\ud83d");
  expect(pad("LPAD", "7", 4, "😀")).not.toBe("😀\ud83d7");
  expect(pad("RPAD", "7", 4, "😀")).not.toBe("7😀\ud83d");
  expect(left("😀".repeat(40), 64).length).toBeLessThanOrEqual(64);
});
