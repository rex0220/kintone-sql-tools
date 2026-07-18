import type { KintoneFieldInfo } from "../execute";
import type { ProcessRow } from "../engine/process";
import { isEmptyDmlValue, validateAndNormalizeDmlValue, type DmlValidationErrorCode } from "./dmlValidation";
import type { KintoneRecord } from "../converter/dmlToKintone";

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
  statementNumber: number
): { errors: ProcessRow[]; invalidRows: number; invalidRowNumbers: Set<number> } {
  const infoByCode = new Map(fieldInfos.map((field) => [field.code, field]));
  const errors: ProcessRow[] = [];
  const invalid = new Set<number>();
  for (const candidate of candidates) {
    candidate.record ??= {};
    const rowErrors = [...candidate.preErrors];
    for (const code of targetFields) {
      const result = validateAndNormalizeDmlValue(candidate.payload.get(code), infoByCode.get(code)!);
      if (!result.ok) rowErrors.push({ field: code, code: result.code, message: result.message });
      else candidate.record[code] = { value: result.value };
    }
    if (candidate.mode === "create") {
      for (const info of fieldInfos) {
        if (info.inSubtable) continue;
        if (candidate.payload.has(info.code)) continue;
        const emptyDefault = isEmptyDmlValue(info.defaultValue);
        if (!emptyDefault) {
          const defaultResult = validateAndNormalizeDmlValue(info.defaultValue, info);
          if (!defaultResult.ok) rowErrors.push({
            field: info.code, code: defaultResult.code, message: `既定値: ${defaultResult.message}`,
          });
        } else {
          const emptyResult = validateAndNormalizeDmlValue("", info);
          if (!emptyResult.ok) {
            rowErrors.push({ field: info.code, code: emptyResult.code, message: emptyResult.message });
          } else if (info.required) {
            rowErrors.push({ field: info.code, code: "ERR_REQUIRED", message: `${info.code} は必須です` });
          }
        }
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
