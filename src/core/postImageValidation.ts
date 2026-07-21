import type { KintoneRecord } from "../converter/dmlToKintone";
import type { KintoneFieldInfo } from "../execute";
import type { ProcessRow } from "../engine/process";
import { validateAndNormalizeDmlValue } from "./dmlValidation";
import {
  VALIDATION_META_COLUMNS,
  renderValidationValue,
  type ValidationOperation,
} from "./dmlValidationCandidates";
import {
  buildValidationFieldMetadataIndex,
  buildValidationCellLocator,
  renderExistingValidationValue,
} from "./existingRecordValidation";
import type { NumberPrecision } from "./numberPrecision";

const NON_AUDIT_SYSTEM_TYPES = new Set([
  "CALC", "RECORD_NUMBER", "CREATOR", "CREATED_TIME", "MODIFIER", "UPDATED_TIME",
  "STATUS", "STATUS_ASSIGNEE", "CATEGORY", "REFERENCE_TABLE",
]);

export interface PostImageFieldIndex {
  readonly topLevel: readonly KintoneFieldInfo[];
  readonly subtables: ReadonlyMap<string, readonly KintoneFieldInfo[]>;
  /** B44 diagnostic payload columns. `$id` is always normalized to the first column. */
  readonly payloadFields: readonly string[];
}

export interface PostImageValidationResult {
  readonly normalizedRecord: KintoneRecord;
  readonly errors: ProcessRow[];
  readonly columns: readonly string[];
  readonly invalidRows: number;
  readonly invalidRowNumbers: Set<number>;
  readonly errorCount: number;
}

export const POST_IMAGE_VALIDATION_SUFFIX_COLUMNS = VALIDATION_META_COLUMNS;

export function buildPostImageFieldIndex(
  fieldInfos: readonly KintoneFieldInfo[],
  payloadFields: readonly string[] = ["$id"]
): PostImageFieldIndex {
  const metadata = buildValidationFieldMetadataIndex(fieldInfos);
  const topLevel = metadata.topLevel.filter((field) =>
    field.fieldType !== "SUBTABLE"
    && field.fieldType !== "FILE"
    && !NON_AUDIT_SYSTEM_TYPES.has(field.fieldType));
  const subtables = new Map<string, KintoneFieldInfo[]>();
  for (const [tableCode, fields] of metadata.childrenByTable) {
    subtables.set(tableCode, fields.filter((field) => field.fieldType !== "FILE"));
  }
  return {
    topLevel,
    subtables,
    payloadFields: ["$id", ...new Set(payloadFields.filter((field) => field !== "$id"))],
  };
}

export function postImageNeedsNumberPrecision(
  record: Readonly<Record<string, { readonly value: unknown }>>,
  fieldIndex: PostImageFieldIndex
): boolean {
  if (fieldIndex.topLevel.some((field) => field.fieldType === "NUMBER" && field.code in record)) return true;
  for (const [tableCode, children] of fieldIndex.subtables) {
    if (!children.some((field) => field.fieldType === "NUMBER")) continue;
    const rows = record[tableCode]?.value;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const values = (row as { value?: Record<string, unknown> })?.value;
      if (children.some((field) => field.fieldType === "NUMBER" && !!values && field.code in values)) return true;
    }
  }
  return false;
}

/** APPLY AST independent complete-record validator shared with the future B43 path. */
export function validatePostImage(
  record: Readonly<Record<string, { readonly value: unknown }>>,
  fieldIndex: PostImageFieldIndex,
  numberPrecision: NumberPrecision | undefined,
  statementNumber: number,
  parentRowNumber = 1,
  operation: ValidationOperation = "UPDATE"
): PostImageValidationResult {
  const normalizedRecord = cloneRecord(record);
  const errors: ProcessRow[] = [];
  const invalidRowNumbers = new Set<number>();
  const columns = [...fieldIndex.payloadFields, ...POST_IMAGE_VALIDATION_SUFFIX_COLUMNS];
  const parentId = renderValidationValue(record["$id"]?.value);

  const appendError = (
    field: KintoneFieldInfo,
    raw: unknown,
    validation: { code: string; message: string },
    locator?: { subtable: string; subrow: number; subrowId: string }
  ): void => {
    invalidRowNumbers.add(parentRowNumber);
    const row: ProcessRow = {};
    for (const code of fieldIndex.payloadFields) {
      row[code] = code === "$id" ? parentId : renderValidationValue(record[code]?.value);
    }
    row["$err_statement"] = String(statementNumber);
    row["$err_operation"] = operation;
    row["$err_row"] = String(parentRowNumber);
    row["$err_field"] = field.code;
    row["$err_code"] = validation.code;
    row["$err_message"] = validation.message;
    row["$err_value"] = renderExistingValidationValue(raw, field.fieldType);
    row["$err_subtable"] = locator?.subtable ?? "";
    row["$err_subrow"] = locator ? String(locator.subrow) : "";
    row["$err_subrow_id"] = locator?.subrowId ?? "";
    errors.push(row);
  };

  for (const field of fieldIndex.topLevel) {
    const raw = record[field.code]?.value;
    const result = validateAndNormalizeDmlValue(raw, field, numberPrecision);
    if (!result.ok) appendError(field, raw, result);
    else normalizedRecord[field.code] = { value: preserveCodeObjects(raw, field.fieldType, result.value) } as never;
  }
  for (const [tableCode, children] of fieldIndex.subtables) {
    const sourceRows = record[tableCode]?.value;
    if (!Array.isArray(sourceRows)) continue;
    const normalizedRows = normalizedRecord[tableCode]?.value as Array<{
      id?: string | number; value?: Record<string, { value?: unknown }>;
    }>;
    for (let rowIndex = 0; rowIndex < sourceRows.length; rowIndex++) {
      const sourceRow = sourceRows[rowIndex] as { id?: string | number; value?: Record<string, { value?: unknown }> };
      const normalizedRow = normalizedRows[rowIndex];
      for (const field of children) {
        const raw = sourceRow.value?.[field.code]?.value;
        const result = validateAndNormalizeDmlValue(raw, field, numberPrecision);
        if (!result.ok) appendError(field, raw, result, buildValidationCellLocator(tableCode, rowIndex, sourceRow));
        else {
          normalizedRow.value ??= {};
          normalizedRow.value[field.code] = { value: preserveCodeObjects(raw, field.fieldType, result.value) };
        }
      }
    }
  }
  return {
    normalizedRecord: normalizedRecord as KintoneRecord,
    errors,
    columns,
    invalidRows: invalidRowNumbers.size,
    invalidRowNumbers,
    errorCount: errors.length,
  };
}

function preserveCodeObjects(raw: unknown, fieldType: string, normalized: unknown): unknown {
  return ["USER_SELECT", "ORGANIZATION_SELECT", "GROUP_SELECT"].includes(fieldType)
    && Array.isArray(raw)
    && raw.every((item) => typeof item === "object" && item !== null && "code" in item)
    ? raw
    : normalized;
}

function cloneRecord(
  record: Readonly<Record<string, { readonly value: unknown }>>
): Record<string, { value: unknown }> {
  const clone: Record<string, { value: unknown }> = {};
  for (const [code, cell] of Object.entries(record)) {
    const value = cell?.value;
    clone[code] = { value: Array.isArray(value)
      ? value.map((item) => {
          if (item === null || typeof item !== "object") return item;
          const row = item as { id?: string | number; value?: Record<string, { value?: unknown }> };
          if (!row.value) return { ...row };
          return {
            ...row,
            value: Object.fromEntries(Object.entries(row.value).map(([field, child]) => [field, { ...child }])),
          };
        })
      : value };
  }
  return clone;
}
