export type CompareResult = -1 | 0 | 1;
export type DecimalSign = -1 | 0 | 1;

export interface ExactDecimal {
  sign: DecimalSign;
  /** 0, or ASCII digits with no leading or trailing zero. */
  coefficient: string;
  /** value = sign * coefficient * 10^(-scale). */
  scale: number;
}

const DECIMAL_PATTERN = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?)(\d+))?$/;

function parseSafeExponent(sign: string | undefined, digits: string | undefined): number | null {
  if (digits === undefined) return 0;
  let value = 0;
  for (const digit of digits) {
    value = value * 10 + (digit.charCodeAt(0) - 48);
    if (!Number.isSafeInteger(value)) return null;
  }
  return sign === "-" ? -value : value;
}

export function parseExactDecimal(input: string): ExactDecimal | null {
  const match = DECIMAL_PATTERN.exec(input.trim());
  if (match === null) return null;

  const exponent = parseSafeExponent(match[5], match[6]);
  if (exponent === null) return null;
  const fraction = match[3] ?? match[4] ?? "";
  let coefficient = `${match[2] ?? ""}${fraction}`.replace(/^0+/, "");
  if (coefficient === "") return { sign: 0, coefficient: "0", scale: 0 };

  let scale = fraction.length - exponent;
  if (!Number.isSafeInteger(scale)) return null;
  const trailingZeros = /0+$/.exec(coefficient)?.[0].length ?? 0;
  if (trailingZeros > 0) {
    coefficient = coefficient.slice(0, -trailingZeros);
    scale -= trailingZeros;
    if (!Number.isSafeInteger(scale)) return null;
  }
  if (!Number.isSafeInteger(coefficient.length - scale)) return null;
  const sign: DecimalSign = match[1] === "-" ? -1 : 1;
  return { sign, coefficient, scale };
}

export function isFiniteDecimal(input: string): boolean {
  return parseExactDecimal(input) !== null;
}

/**
 * Formats an ExactDecimal as a plain decimal string with no exponent and no
 * leading `+` (e.g. `1e3` -> `1000`, `1e-5` -> `0.00005`). Lossless: all digits
 * are preserved without `Number()`. This is the canonical form for values sent
 * to kintone query/DML, which reject exponent notation.
 */
export function formatPlainDecimal(dec: ExactDecimal): string {
  if (dec.sign === 0) return "0";
  const digits = dec.coefficient;
  let magnitude: string;
  if (dec.scale <= 0) {
    magnitude = `${digits}${"0".repeat(-dec.scale)}`;
  } else if (digits.length > dec.scale) {
    const point = digits.length - dec.scale;
    magnitude = `${digits.slice(0, point)}.${digits.slice(point)}`;
  } else {
    magnitude = `0.${"0".repeat(dec.scale - digits.length)}${digits}`;
  }
  return dec.sign === -1 ? `-${magnitude}` : magnitude;
}

/** Canonical plain-decimal string for a finite decimal input, or null if not finite. */
export function toPlainDecimal(input: string): string | null {
  const dec = parseExactDecimal(input);
  return dec === null ? null : formatPlainDecimal(dec);
}

function compareMagnitudes(left: ExactDecimal, right: ExactDecimal): CompareResult {
  const leftPoint = left.coefficient.length - left.scale;
  const rightPoint = right.coefficient.length - right.scale;
  if (!Number.isSafeInteger(leftPoint) || !Number.isSafeInteger(rightPoint)) {
    throw new Error("ArgumentError: exact decimal scale is outside the supported range.");
  }
  if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;

  const width = Math.max(left.coefficient.length, right.coefficient.length);
  for (let index = 0; index < width; index++) {
    const a = index < left.coefficient.length ? left.coefficient.charCodeAt(index) : 48;
    const b = index < right.coefficient.length ? right.coefficient.charCodeAt(index) : 48;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

export function compareExactDecimal(left: ExactDecimal, right: ExactDecimal): CompareResult {
  if (left.sign !== right.sign) return left.sign < right.sign ? -1 : 1;
  if (left.sign === 0) return 0;
  const magnitude = compareMagnitudes(left, right);
  return left.sign === -1 ? (magnitude === 0 ? 0 : magnitude === -1 ? 1 : -1) : magnitude;
}

export function compareDecimal(left: string, right: string): CompareResult {
  const a = parseExactDecimal(left);
  const b = parseExactDecimal(right);
  if (a === null || b === null) {
    throw new Error("ArgumentError: compareDecimal requires finite decimal inputs.");
  }
  return compareExactDecimal(a, b);
}
