import { parseExactDecimal, type ExactDecimal } from "./exactDecimal";

export type NumberRoundingMode = "HALF_EVEN" | "UP" | "DOWN";

export interface NumberPrecision {
  digits: number;
  decimalPlaces: number;
  roundingMode: NumberRoundingMode;
}

export interface RawNumberPrecisionSettings {
  numberPrecision?: {
    digits?: unknown;
    decimalPlaces?: unknown;
    roundingMode?: unknown;
  };
}

function parseIntegerSetting(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(`SettingsError: numberPrecision.${name} must be an integer string.`);
  }
  let parsed = 0;
  for (const digit of value) parsed = parsed * 10 + digit.charCodeAt(0) - 48;
  if (parsed < min || parsed > max) {
    throw new Error(`SettingsError: numberPrecision.${name} must be between ${min} and ${max}.`);
  }
  return parsed;
}

/** Validates the operational app/settings.json response without supplying defaults. */
export function parseNumberPrecisionSettings(response: RawNumberPrecisionSettings): NumberPrecision {
  const raw = response.numberPrecision;
  if (raw === undefined || raw === null || typeof raw !== "object") {
    throw new Error("SettingsError: numberPrecision is missing from app settings.");
  }
  const digits = parseIntegerSetting(raw.digits, "digits", 1, 30);
  const decimalPlaces = parseIntegerSetting(raw.decimalPlaces, "decimalPlaces", 0, 10);
  const roundingMode = raw.roundingMode;
  if (roundingMode !== "HALF_EVEN" && roundingMode !== "UP" && roundingMode !== "DOWN") {
    throw new Error("SettingsError: numberPrecision.roundingMode is unsupported.");
  }
  return { digits, decimalPlaces, roundingMode };
}

export function exactDecimalDigitCounts(value: ExactDecimal): {
  integerDigits: number;
  fractionDigits: number;
} {
  if (value.sign === 0) return { integerDigits: 0, fractionDigits: 0 };
  return {
    integerDigits: Math.max(value.coefficient.length - value.scale, 0),
    fractionDigits: Math.max(value.scale, 0),
  };
}

function incrementDigits(input: string): string {
  const digits = input.split("");
  for (let index = digits.length - 1; index >= 0; index--) {
    if (digits[index] !== "9") {
      digits[index] = String.fromCharCode(digits[index].charCodeAt(0) + 1);
      return digits.join("");
    }
    digits[index] = "0";
  }
  return `1${digits.join("")}`;
}

function fixedScaleText(sign: ExactDecimal["sign"], digits: string, scale: number): string {
  const padded = digits.padStart(scale + 1, "0");
  const point = padded.length - scale;
  const magnitude = scale === 0
    ? padded
    : `${padded.slice(0, point)}.${padded.slice(point)}`;
  const nonZero = /[1-9]/.test(padded);
  return sign === -1 && nonZero ? `-${magnitude}` : magnitude;
}

/**
 * Quantizes a finite decimal using decimal digits only. This primitive is for an
 * explicit rounding surface; normal DML validation must not call it implicitly.
 */
export function quantizeDecimal(value: string, scale: number, mode: NumberRoundingMode): string {
  if (scale % 1 !== 0 || scale < 0 || scale > 10) {
    throw new Error("ArgumentError: quantizeDecimal scale must be an integer between 0 and 10.");
  }
  const parsed = parseExactDecimal(value);
  if (parsed === null) throw new Error("ArgumentError: quantizeDecimal requires a finite decimal input.");
  if (parsed.sign === 0) return fixedScaleText(0, "0", scale);

  const currentScale = Math.max(parsed.scale, 0);
  const magnitudeDigits = parsed.scale < 0
    ? `${parsed.coefficient}${"0".repeat(-parsed.scale)}`
    : parsed.coefficient;
  if (currentScale <= scale) {
    return fixedScaleText(parsed.sign, `${magnitudeDigits}${"0".repeat(scale - currentScale)}`, scale);
  }

  const cut = magnitudeDigits.length - (currentScale - scale);
  let kept = cut > 0 ? magnitudeDigits.slice(0, cut) : "0";
  const discarded = `${cut < 0 ? "0".repeat(-cut) : ""}${magnitudeDigits.slice(Math.max(cut, 0))}`;
  const anyDiscarded = /[1-9]/.test(discarded);
  let increment = mode === "UP" && anyDiscarded;
  if (mode === "HALF_EVEN" && anyDiscarded) {
    const first = discarded[0];
    increment = first > "5" ||
      (first === "5" && (/[1-9]/.test(discarded.slice(1)) || ((kept.charCodeAt(kept.length - 1) - 48) & 1) === 1));
  }
  if (increment) kept = incrementDigits(kept);
  return fixedScaleText(parsed.sign, kept, scale);
}
