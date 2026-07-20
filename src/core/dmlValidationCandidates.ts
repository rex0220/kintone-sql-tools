import type { KintoneFieldInfo } from "../execute";
import type { ProcessRow } from "../engine/process";
import { isEmptyDmlValue, validateAndNormalizeDmlValue, type DmlValidationErrorCode } from "./dmlValidation";
import type { KintoneRecord } from "../converter/dmlToKintone";
import type { NumberPrecision } from "./numberPrecision";
import type { CheckGroup, FieldRef } from "../types/ast";
import { evaluateCustomChecks } from "./dmlCustomCheck";

export type ValidationOperation = "INSERT" | "UPDATE" | "UPSERT";

export interface DmlValidationCandidate {
  rowNumber: number;
  operation: ValidationOperation;
  mode: "create" | "update";
  payload: Map<string, unknown>;
  preErrors: Array<{ field: string; code: DmlValidationErrorCode; message: string }>;
  /** 検証成功値だけで構成した、そのまま POST/PUT 可能なペイロード。 */
  record?: KintoneRecord;
  /** UPDATE / UPSERT-update の書き込み先レコード ID。 */
  targetId?: number;
  /** CHECK 専用の読み取り行。書込み payload とは分離する。 */
  evaluationRow?: ProcessRow;
  evaluationFieldTypes?: ReadonlyMap<string, string>;
}

export const VALIDATION_META_COLUMNS = [
  "$err_statement", "$err_operation", "$err_row", "$err_field", "$err_code", "$err_message",
] as const;

export function validateDmlCandidates(
  candidates: DmlValidationCandidate[],
  operation: ValidationOperation,
  payloadFields: string[],
  targetFields: string[],
  fieldInfos: KintoneFieldInfo[],
  statementNumber: number,
  numberPrecision?: NumberPrecision,
  checkGroups: readonly CheckGroup[] = [],
  validateMissingCreateFields = true,
  includePreErrors = true
): { errors: ProcessRow[]; invalidRows: number; invalidRowNumbers: Set<number> } {
  // Existing DML contract: only fields present in each write payload are validated here.
  // B44 APPLY must validate the complete post-image via validatePostImage instead.
  const infoByCode = new Map(fieldInfos.map((field) => [field.code, field]));
  const errors: ProcessRow[] = [];
  const invalid = new Set<number>();
  let firstEvaluationError: unknown;
  for (const candidate of candidates) {
    candidate.record ??= {};
    const rowErrors = includePreErrors ? [...candidate.preErrors] : [];
    for (const code of targetFields) {
      if (!candidate.payload.has(code)) continue;
      const result = validateAndNormalizeDmlValue(candidate.payload.get(code), infoByCode.get(code)!, numberPrecision);
      if (!result.ok) rowErrors.push({ field: code, code: result.code, message: result.message });
      else {
        const original = candidate.payload.get(code);
        const type = infoByCode.get(code)!.fieldType;
        const preserveCodes = ["USER_SELECT", "ORGANIZATION_SELECT", "GROUP_SELECT"].includes(type)
          && Array.isArray(original) && original.every((item) => typeof item === "object" && item !== null && "code" in item);
        candidate.record[code] = { value: preserveCodes ? original as Array<{ code: string }> : result.value };
      }
    }
    if (validateMissingCreateFields && candidate.mode === "create") {
      for (const info of fieldInfos) {
        if (info.inSubtable) continue;
        if (candidate.payload.has(info.code)) continue;
        const emptyDefault = isEmptyDmlValue(info.defaultValue);
        if (!emptyDefault) {
          const defaultResult = validateAndNormalizeDmlValue(info.defaultValue, info, numberPrecision);
          if (!defaultResult.ok) rowErrors.push({
            field: info.code, code: defaultResult.code, message: `既定値: ${defaultResult.message}`,
          });
        } else {
          const emptyResult = validateAndNormalizeDmlValue("", info, numberPrecision);
          if (!emptyResult.ok) {
            rowErrors.push({ field: info.code, code: emptyResult.code, message: emptyResult.message });
          } else if (info.required) {
            rowErrors.push({ field: info.code, code: "ERR_REQUIRED", message: `${info.code} は必須です` });
          }
        }
      }
    }
    if (checkGroups.length > 0) {
      const row = candidate.evaluationRow ?? Object.fromEntries(
        [...candidate.payload].map(([field, value]) => [field, renderValidationValue(value)])
      );
      const types = candidate.evaluationFieldTypes;
      const resolveType = (field: FieldRef): string | undefined => {
        const qualified = field.tableAlias ? `${field.tableAlias}.${field.field}` : field.field;
        return types?.get(qualified) ?? types?.get(field.field);
      };
      try {
        for (const custom of evaluateCustomChecks(checkGroups, row, resolveType)) {
          rowErrors.push({ field: "", code: "ERR_CHECK", message: custom.message });
        }
      } catch (error) {
        firstEvaluationError ??= error;
      }
    }
    if (rowErrors.length > 0) invalid.add(candidate.rowNumber);
    for (const error of rowErrors) {
      const row: ProcessRow = {};
      for (const field of payloadFields) row[field] = renderValidationValue(candidate.payload.get(field));
      row["$err_statement"] = String(statementNumber);
      row["$err_operation"] = operation;
      row["$err_row"] = String(candidate.rowNumber);
      row["$err_field"] = error.field;
      row["$err_code"] = error.code;
      row["$err_message"] = error.message;
      errors.push(row);
    }
  }
  if (firstEvaluationError !== undefined) throw firstEvaluationError;
  return { errors, invalidRows: invalid.size, invalidRowNumbers: invalid };
}

export function renderValidationValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object" && "type" in value) {
    const sql = value as { type: string; value?: unknown; raw?: string; elements?: Array<{ value: string }> };
    if (sql.type === "NUMBER") return sql.raw ?? String(sql.value ?? "");
    if (sql.type === "STRING") return String(sql.value ?? "");
    if (sql.type === "ARRAY") return JSON.stringify(sql.elements?.map((e) => e.value) ?? []);
  }
  if (Array.isArray(value)) return JSON.stringify(value);
  return String(value);
}
