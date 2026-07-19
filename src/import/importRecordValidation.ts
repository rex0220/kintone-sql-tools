import type { KintoneFieldInfo } from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";
import { isEmptyDmlValue, validateAndNormalizeDmlValue, type DmlValidationErrorCode } from "../core/dmlValidation";
import type { NumberPrecision } from "../core/numberPrecision";
import type { ImportTarget } from "../types/ast";
import type { DecodedJsonValue, JsonNumberValue } from "./jsonDecoder";
import type { MaterializedImportRecord, MaterializedImportRecords } from "./types";

const USER_TYPES = new Set(["USER_SELECT", "ORGANIZATION_SELECT", "GROUP_SELECT"]);
const UNSUPPORTED_CHILD_TYPES = new Set(["SUBTABLE", "FILE", "CALC", "RECORD_NUMBER", "CREATOR", "CREATED_TIME", "MODIFIER", "UPDATED_TIME", "STATUS", "STATUS_ASSIGNEE", "CATEGORY", "REFERENCE_TABLE"]);

export interface ImportValidationError {
  operation: "INSERT" | "UPSERT";
  parentRow: number;
  field: string;
  subtable?: string;
  subrow?: number;
  sourceRow?: number;
  code: DmlValidationErrorCode;
  message: string;
  sourceValues: ReadonlyMap<string, unknown>;
}

export interface PreparedImportParent {
  parentRow: number;
  valid: boolean;
  top: KintoneRecord;
  subtables: ReadonlyMap<string, readonly KintoneRecord[]>;
  replacementTables: ReadonlySet<string>;
  errors: readonly ImportValidationError[];
}

export interface PreparedImportRecords {
  parents: readonly PreparedImportParent[];
  errors: readonly ImportValidationError[];
  invalidParentRows: ReadonlySet<number>;
  tableCounts: ReadonlyMap<string, { parentsPresent: number; childRows: number; validChildRows: number; invalidChildRows: number }>;
}

/** Counts rejected parents, never child errors. Used by the later write phase after read-only preflight. */
export function assertImportRejectLimit(prepared: PreparedImportRecords, rejectLimit: number | null | undefined): void {
  if (rejectLimit != null && prepared.invalidParentRows.size > rejectLimit) {
    throw new Error(`RejectLimitExceededError: rejected parents (${prepared.invalidParentRows.size}) exceed REJECT LIMIT (${rejectLimit}).`);
  }
}

export function prepareImportRecords(
  materialized: MaterializedImportRecords,
  targets: readonly ImportTarget[],
  fieldInfos: readonly KintoneFieldInfo[],
  numberPrecision: NumberPrecision | undefined,
  operation: "INSERT" | "UPSERT"
): PreparedImportRecords {
  const topInfos = new Map(fieldInfos.filter((f) => !f.inSubtable).map((f) => [f.code, f]));
  const scoped = new Map<string, Map<string, KintoneFieldInfo>>();
  for (const info of fieldInfos) if (info.inSubtable && info.subtableCode) {
    let children = scoped.get(info.subtableCode);
    if (!children) scoped.set(info.subtableCode, children = new Map());
    children.set(info.code, info);
  }
  const targetTop = targets.filter((t): t is Extract<ImportTarget, { kind: "FIELD" }> => t.kind === "FIELD");
  const targetTables = targets.filter((t): t is Extract<ImportTarget, { kind: "SUBTABLE" }> => t.kind === "SUBTABLE");
  for (const target of targetTop) assertWritable(target.field, topInfos.get(target.field), undefined);
  for (const target of targetTables) {
    const table = topInfos.get(target.subtableCode);
    if (!table || table.fieldType !== "SUBTABLE") throw new Error(`ArgumentError: IMPORT subtable ${target.subtableCode} does not exist.`);
    const children = scoped.get(target.subtableCode) ?? new Map();
    for (const child of target.children) assertWritable(child, children.get(child), target.subtableCode);
  }

  const tableCounts = new Map(targetTables.map((t) => [t.subtableCode, { parentsPresent: 0, childRows: 0, validChildRows: 0, invalidChildRows: 0 }]));
  const parents = materialized.records.map((record) => validateParent(record, targetTop, targetTables, topInfos, scoped, numberPrecision, operation, tableCounts));
  const errors = parents.flatMap((parent) => [...parent.errors]);
  return { parents, errors, invalidParentRows: new Set(parents.filter((p) => !p.valid).map((p) => p.parentRow)), tableCounts };
}

function validateParent(
  source: MaterializedImportRecord,
  topTargets: readonly Extract<ImportTarget, { kind: "FIELD" }>[],
  tableTargets: readonly Extract<ImportTarget, { kind: "SUBTABLE" }>[],
  topInfos: ReadonlyMap<string, KintoneFieldInfo>,
  scoped: ReadonlyMap<string, ReadonlyMap<string, KintoneFieldInfo>>,
  precision: NumberPrecision | undefined,
  operation: "INSERT" | "UPSERT",
  tableCounts: Map<string, { parentsPresent: number; childRows: number; validChildRows: number; invalidChildRows: number }>
): PreparedImportParent {
  const errors: ImportValidationError[] = [];
  const top: KintoneRecord = {};
  for (const target of topTargets) {
    if (!source.top.has(target.field)) continue;
    validateValue(source.top.get(target.field), topInfos.get(target.field)!, precision, top, target.field, errors, location(source, operation, target.field));
  }
  const createValidationOnly: KintoneRecord = {};
  if (operation === "INSERT") for (const info of topInfos.values()) {
    if (info.fieldType === "SUBTABLE" || info.writable === false || source.top.has(info.code)) continue;
    // Form-wide create validation must not expand the write payload beyond INTO targets.
    // kintone applies defaults for omitted fields; emitting them also creates invalid FILE values.
    validateMissing(info, precision, createValidationOnly, errors, location(source, operation, info.code));
  }
  const subtables = new Map<string, KintoneRecord[]>();
  for (const target of tableTargets) {
    if (!source.subtables.has(target.subtableCode)) continue;
    const count = tableCounts.get(target.subtableCode)!;
    count.parentsPresent++;
    const preparedRows: KintoneRecord[] = [];
    for (const child of source.subtables.get(target.subtableCode)!) {
      count.childRows++;
      const before = errors.length;
      const record: KintoneRecord = {};
      const infos = scoped.get(target.subtableCode)!;
      for (const code of target.children) {
        const info = infos.get(code)!;
        const loc = location(source, operation, code, target.subtableCode, child.childRowNumber, child.sourceRowNumber ?? source.markerRowNumber);
        if (child.values.has(code)) validateValue(child.values.get(code), info, precision, record, code, errors, loc);
        else validateMissing(info, precision, record, errors, loc);
      }
      if (errors.length === before) { count.validChildRows++; preparedRows.push(record); }
      else count.invalidChildRows++;
    }
    subtables.set(target.subtableCode, preparedRows);
  }
  // Parent isolation: candidates are only meaningful when every top/child value is valid.
  return { parentRow: source.rowNumber, valid: errors.length === 0, top, subtables, replacementTables: source.replacementTables, errors };
}

function assertWritable(code: string, info: KintoneFieldInfo | undefined, table: string | undefined): void {
  if (!info) throw new Error(table
    ? `ArgumentError: IMPORT child ${code} does not belong to subtable ${table}.`
    : `ArgumentError: IMPORT top-level field ${code} does not exist.`);
  if (info.writable === false || (table && UNSUPPORTED_CHILD_TYPES.has(info.fieldType))) {
    throw new Error(`ArgumentError: IMPORT ${table ? `child ${table}.${code}` : `field ${code}`} is not writable (${info.fieldType}).`);
  }
}

function validateMissing(info: KintoneFieldInfo, precision: NumberPrecision | undefined, record: KintoneRecord, errors: ImportValidationError[], loc: Omit<ImportValidationError, "code" | "message">): void {
  const raw = isEmptyDmlValue(info.defaultValue) ? "" : info.defaultValue;
  validateValue(raw, info, precision, record, info.code, errors, loc, !isEmptyDmlValue(info.defaultValue));
}

function validateValue(raw: unknown, info: KintoneFieldInfo, precision: NumberPrecision | undefined, record: KintoneRecord, code: string, errors: ImportValidationError[], loc: Omit<ImportValidationError, "code" | "message">, isDefault = false): void {
  const normalizedRaw = decodeRaw(raw);
  const result = validateAndNormalizeDmlValue(normalizedRaw, info, precision);
  if (!result.ok) errors.push({ ...loc, code: result.code, message: isDefault ? `既定値: ${result.message}` : result.message });
  else record[code] = { value: preserveUserCodes(normalizedRaw, info) ? normalizedRaw as Array<{ code: string }> : result.value };
}

function decodeRaw(raw: unknown): unknown {
  if (isJsonNumber(raw)) return raw.lexeme;
  if (Array.isArray(raw)) return raw.map((value) => value instanceof Map ? value : isJsonNumber(value) ? value.lexeme : value);
  return raw;
}
function isJsonNumber(raw: unknown): raw is JsonNumberValue { return typeof raw === "object" && raw !== null && (raw as { kind?: string }).kind === "number"; }
function preserveUserCodes(raw: unknown, info: KintoneFieldInfo): boolean { return USER_TYPES.has(info.fieldType) && Array.isArray(raw) && raw.every((v) => typeof v === "object" && v !== null && "code" in v); }
function location(source: MaterializedImportRecord, operation: "INSERT" | "UPSERT", field: string, subtable?: string, subrow?: number, sourceRow?: number): Omit<ImportValidationError, "code" | "message"> {
  const physicalRow = sourceRow ?? source.markerRowNumber;
  return { operation, parentRow: source.rowNumber, field, ...(subtable ? { subtable } : {}), ...(subrow == null ? {} : { subrow }), ...(physicalRow == null ? {} : { sourceRow: physicalRow }), sourceValues: subtable ? source.subtables.get(subtable)?.[subrow! - 1]?.values ?? new Map() : source.top };
}
