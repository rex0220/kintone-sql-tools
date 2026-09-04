import { ExportSinkInvalidValueError } from "./types";

export const MAX_EXPANDED_DECIMAL_LENGTH = 1024;

const EXPONENTIAL_DECIMAL = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))[eE]([+-]?\d+)$/;

/** Expands an exponential decimal lexeme without converting it through Number. */
export function expandExponentialDecimal(text: string): string {
  const match = EXPONENTIAL_DECIMAL.exec(text);
  if (!match) {
    throw new ExportSinkInvalidValueError("numeric value has invalid exponential notation.");
  }

  const sign = match[1];
  const integer = match[2] ?? "";
  const fraction = match[3] ?? match[4] ?? "";
  const digits = integer + fraction;
  if (/^0+$/.test(digits)) return `${sign}0`;
  const decimalIndex = BigInt(integer.length) + BigInt(match[5]);
  const digitCount = BigInt(digits.length);
  let outputLength: bigint;
  if (decimalIndex <= 0n) {
    outputLength = BigInt(sign.length + 2 + digits.length) - decimalIndex;
  } else if (decimalIndex >= digitCount) {
    outputLength = BigInt(sign.length) + decimalIndex;
  } else {
    outputLength = BigInt(sign.length + digits.length + 1);
  }
  if (outputLength > BigInt(MAX_EXPANDED_DECIMAL_LENGTH)) {
    throw new ExportSinkInvalidValueError(
      `expanded numeric value exceeds ${MAX_EXPANDED_DECIMAL_LENGTH} characters.`
    );
  }

  const position = Number(decimalIndex);
  if (position <= 0) return `${sign}0.${"0".repeat(-position)}${digits}`;
  if (position >= digits.length) return `${sign}${digits}${"0".repeat(position - digits.length)}`;
  return `${sign}${digits.slice(0, position)}.${digits.slice(position)}`;
}
