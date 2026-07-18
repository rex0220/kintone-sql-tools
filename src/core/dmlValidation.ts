import type { KintoneFieldInfo } from "../execute";
import type { SqlValue } from "../types/ast";
import { numberLiteralText } from "../types/ast";
import { normalizeDmlSqlValue, type KintoneValue } from "../converter/dmlToKintone";
import { compareDecimal, parseExactDecimal } from "./exactDecimal";
import { exactDecimalDigitCounts, type NumberPrecision } from "./numberPrecision";

export { compareDecimal, isFiniteDecimal } from "./exactDecimal";

export type DmlValidationErrorCode =
  | "ERR_REQUIRED"
  | "ERR_TYPE_NUMBER"
  | "ERR_TYPE_DATE"
  | "ERR_RANGE_MAX"
  | "ERR_RANGE_MIN"
  | "ERR_NUMBER_INTEGER_DIGITS"
  | "ERR_NUMBER_DECIMAL_PLACES"
  | "ERR_LENGTH_MAX"
  | "ERR_LENGTH_MIN"
  | "ERR_CHOICE_INVALID"
  | "ERR_KEY_EMPTY"
  | "ERR_KEY_DUP_SOURCE";

export type DmlValueValidation =
  | { ok: true; value: KintoneValue }
  | { ok: false; code: DmlValidationErrorCode; message: string };

const ARRAY_TYPES = new Set(["CHECK_BOX", "MULTI_SELECT"]);
const CHOICE_TYPES = new Set(["DROP_DOWN", "RADIO_BUTTON", "CHECK_BOX", "MULTI_SELECT"]);

export function validateAndNormalizeDmlValue(
  raw: unknown,
  field: KintoneFieldInfo,
  numberPrecision?: NumberPrecision
): DmlValueValidation {
  if (field.fieldType === "DATE" || field.fieldType === "TIME" || field.fieldType === "DATETIME") {
    const original = rawScalarText(raw);
    if (original !== "" && !isValidTemporalInput(original, field.fieldType)) {
      return { ok: false, code: "ERR_TYPE_DATE", message: `${field.code} の日付・時刻形式が不正です` };
    }
  }
  let value: KintoneValue;
  try {
    value = normalizeRaw(raw, field.fieldType);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, code: typeCode(field.fieldType), message };
  }

  if (field.required && isEmpty(value)) {
    return { ok: false, code: "ERR_REQUIRED", message: `${field.code} は必須です` };
  }
  if (!isEmpty(value) && field.fieldType === "NUMBER") {
    const text = String(value);
    const decimal = parseExactDecimal(text);
    if (decimal === null) {
      return { ok: false, code: "ERR_TYPE_NUMBER", message: `${field.code} は数値で指定してください` };
    }
    if (field.minValue != null && compareDecimal(text, field.minValue) < 0) {
      return { ok: false, code: "ERR_RANGE_MIN", message: `${field.code} は ${field.minValue} 以上で指定してください` };
    }
    if (field.maxValue != null && compareDecimal(text, field.maxValue) > 0) {
      return { ok: false, code: "ERR_RANGE_MAX", message: `${field.code} は ${field.maxValue} 以下で指定してください` };
    }
    if (numberPrecision !== undefined) {
      const { integerDigits, fractionDigits } = exactDecimalDigitCounts(decimal);
      // R1 §5.2: I = digits - decimalPlaces. kintone 実機境界は §11-4 で確定する。
      const integerBudget = numberPrecision.digits - numberPrecision.decimalPlaces;
      if (integerDigits > integerBudget) {
        return {
          ok: false,
          code: "ERR_NUMBER_INTEGER_DIGITS",
          message: `${field.code} の整数部は ${integerDigits} 桁です。許容は ${integerBudget} 桁までです (digits=${numberPrecision.digits}, decimalPlaces=${numberPrecision.decimalPlaces})`,
        };
      }
      if (fractionDigits > numberPrecision.decimalPlaces) {
        return {
          ok: false,
          code: "ERR_NUMBER_DECIMAL_PLACES",
          message: `${field.code} の小数部は ${fractionDigits} 桁です。許容は ${numberPrecision.decimalPlaces} 桁までです (digits=${numberPrecision.digits}, decimalPlaces=${numberPrecision.decimalPlaces})`,
        };
      }
    }
  }
  if (!isEmpty(value) && (field.fieldType === "DATE" || field.fieldType === "TIME" || field.fieldType === "DATETIME")) {
    if (!isValidTemporal(String(value), field.fieldType)) {
      return { ok: false, code: "ERR_TYPE_DATE", message: `${field.code} の日付・時刻形式が不正です` };
    }
  }
  if (typeof value === "string") {
    const length = value.length;
    const min = field.minLength == null ? null : Number(field.minLength);
    const max = field.maxLength == null ? null : Number(field.maxLength);
    if (Number.isFinite(min) && length < min!) {
      return { ok: false, code: "ERR_LENGTH_MIN", message: `${field.code} は ${min} 文字以上で指定してください` };
    }
    if (Number.isFinite(max) && length > max!) {
      return { ok: false, code: "ERR_LENGTH_MAX", message: `${field.code} は ${max} 文字以下で指定してください` };
    }
  }
  if (CHOICE_TYPES.has(field.fieldType) && field.optionOrder) {
    const selected = Array.isArray(value) ? value.map(String) : [String(value)];
    if (selected.some((choice) => !(choice in field.optionOrder!))) {
      return { ok: false, code: "ERR_CHOICE_INVALID", message: `${field.code} に定義外の選択肢があります` };
    }
  }
  return { ok: true, value };
}

function rawScalarText(raw: unknown): string {
  if (raw == null) return "";
  if (isSqlValue(raw) && raw.type === "NUMBER") return numberLiteralText(raw);
  if (isSqlValue(raw) && raw.type === "STRING") return raw.value;
  return typeof raw === "string" || typeof raw === "number" ? String(raw) : "";
}

function isValidTemporalInput(value: string, type: string): boolean {
  if (type === "DATE") return isValidTemporal(value.replace(/\//g, "-"), "DATE");
  if (type === "TIME") return isValidTemporal(value, "TIME");
  let normalized = value.replace(/\//g, "-").replace(" ", "T");
  if (/T\d{2}:\d{2}$/.test(normalized)) normalized += ":00";
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(normalized)) {
    return isValidTemporal(normalized.slice(0, 10), "DATE") && isValidTemporal(normalized.slice(11), "TIME");
  }
  return isValidTemporal(normalized, "DATETIME");
}

function normalizeRaw(raw: unknown, fieldType: string): KintoneValue {
  if (isSqlValue(raw)) {
    const normalized = normalizeDmlSqlValue(raw, fieldType);
    if (!normalized.ok) throw new Error(normalized.message);
    return normalized.value;
  }
  if (Array.isArray(raw)) return raw.map((v) => typeof v === "object" && v !== null && "code" in v ? String((v as { code: unknown }).code) : String(v));
  const text = raw == null ? "" : String(raw);
  if (ARRAY_TYPES.has(fieldType)) {
    if (text === "") return [];
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch { /* comma separated fallback */ }
    return text.split(",").map((v) => v.trim());
  }
  return text;
}

function isSqlValue(value: unknown): value is SqlValue {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

export function isEmptyDmlValue(value: unknown): boolean {
  if (value == null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isSqlValue(value)) {
    if (value.type === "STRING") return value.value === "";
    if (value.type === "ARRAY") return value.elements.length === 0;
  }
  return false;
}

function isEmpty(value: KintoneValue): boolean {
  return value === "" || (Array.isArray(value) && value.length === 0);
}

function typeCode(type: string): DmlValidationErrorCode {
  return type === "NUMBER" ? "ERR_TYPE_NUMBER" : "ERR_TYPE_DATE";
}

function isValidTemporal(value: string, type: string): boolean {
  if (type === "TIME") {
    const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
    return m !== null && Number(m[1]) <= 23 && Number(m[2]) <= 59 && Number(m[3] ?? 0) <= 59;
  }
  const datePart = type === "DATE" ? value : value.slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datePart);
  if (!m) return false;
  const year = Number(m[1]); const month = Number(m[2]); const day = Number(m[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return false;
  if (type === "DATE") return true;
  const timePart = value
    .slice(11, value.endsWith("Z") ? -1 : value.length - 6)
    .replace(/\.\d+$/, "");
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    isValidTemporal(timePart, "TIME");
}
