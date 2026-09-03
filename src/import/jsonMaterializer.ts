import type { ProcessRow } from "../engine/process";
import type { JsonDmlSource } from "../types/ast";
import type { ImportMaterializedTable, ImportSourcePayload } from "./types";
import { decodeJsonRecords, type DecodedJsonValue, type JsonNumberValue } from "./jsonDecoder";
import { ImportSourceError } from "./sourceLoader";

export interface JsonTargetField { code: string; fieldType: string }

const STRING_ARRAY_TYPES = new Set(["CHECK_BOX", "MULTI_SELECT"]);
const CODE_ARRAY_TYPES = new Set(["USER_SELECT", "ORGANIZATION_SELECT", "GROUP_SELECT"]);

function fail(row: number, field: string, message: string): never {
  throw new ImportSourceError(`JSON field validation failed (row=${row}, field=${field}): ${message}`);
}

function isNumber(value: DecodedJsonValue): value is JsonNumberValue {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Map) && value.kind === "number";
}

function materializeValue(value: DecodedJsonValue, target: JsonTargetField, row: number): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") fail(row, target.code, "boolean is not accepted.");
  if (isNumber(value)) {
    if (target.fieldType === "NUMBER") fail(row, target.code, "precision target requires a JSON string.");
    if (!/^-?(?:0|[1-9]\d*)$/.test(value.lexeme) || value.lexeme === "-0") {
      fail(row, target.code, `JSON number ${value.lexeme} must be a non-negative-zero safe integer lexeme.`);
    }
    const number = Number(value.lexeme);
    if (!Number.isSafeInteger(number)) fail(row, target.code, `JSON number ${value.lexeme} is outside the safe integer range.`);
    return String(number);
  }
  if (value instanceof Map) fail(row, target.code, "object is not accepted for a flat field.");
  if (!Array.isArray(value)) fail(row, target.code, "unsupported value type.");
  if (!STRING_ARRAY_TYPES.has(target.fieldType) && !CODE_ARRAY_TYPES.has(target.fieldType)) {
    fail(row, target.code, "array is accepted only for multi-value fields.");
  }
  const strings = value.map((entry) => {
    if (typeof entry !== "string") fail(row, target.code, "array elements must be strings.");
    return entry;
  });
  if (new Set(strings).size !== strings.length) fail(row, target.code, "array elements must not contain duplicates.");
  return CODE_ARRAY_TYPES.has(target.fieldType)
    ? JSON.stringify(strings.map((code) => ({ code })))
    : JSON.stringify(strings);
}

/** Name-maps flat JSON records to the declared INTO order and preserves key presence. */
export function materializeJsonDmlSource(
  _source: JsonDmlSource,
  payload: ImportSourcePayload,
  targets: readonly JsonTargetField[],
  maxRows: number
): ImportMaterializedTable {
  if (payload.encoding && payload.encoding !== "utf8") throw new ImportSourceError("JSON source is UTF-8 only.");
  const records = decodeJsonRecords(payload.bytes);
  if (records.length > maxRows) throw new ImportSourceError(`source rows (${records.length}) exceed maxRecords (${maxRows}).`);
  const targetByCode = new Map(targets.map((target) => [target.code, target]));
  if (targetByCode.size !== targets.length) throw new ImportSourceError("JSON target fields contain duplicates.");
  const rows: ProcessRow[] = [];
  const importPresence: ReadonlySet<string>[] = [];
  records.forEach((record, index) => {
    for (const key of record.keys()) {
      if (!targetByCode.has(key)) fail(index + 1, key, "unknown key (not declared in INTO).");
    }
    const row: ProcessRow = {};
    const present = new Set<string>();
    for (const target of targets) {
      if (!record.has(target.code)) continue;
      present.add(target.code);
      row[target.code] = materializeValue(record.get(target.code)!, target, index + 1);
    }
    rows.push(row);
    importPresence.push(present);
  });
  return {
    receipt: { rows: records.length, encoding: "utf8" },
    rows,
    columns: targets.map((target) => target.code),
    columnMeta: new Map(targets.map((target) => [target.code, { fieldType: target.fieldType }])),
    importPresence,
  };
}
