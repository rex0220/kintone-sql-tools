import type { ExactDecimal } from "./exactDecimal";

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
