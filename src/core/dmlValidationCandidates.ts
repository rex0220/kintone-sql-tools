import type { KintoneFieldInfo } from "../execute";
import type { ProcessRow } from "../engine/process";
import { isEmptyDmlValue, normalizeRaw, validateAndNormalizeDmlValue, type DmlValidationErrorCode } from "./dmlValidation";
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
  /** 通常 UPDATE validation の共有 GET で取得した complete snapshot。書込みには使用しない。 */
  validationSnapshot?: KintoneRecord;
  /** CHECK 専用の読み取り行。書込み payload とは分離する。 */
  evaluationRow?: ProcessRow;
  evaluationFieldTypes?: ReadonlyMap<string, string>;
}

export const VALIDATION_META_COLUMNS = [
  "$err_statement", "$err_operation", "$err_row", "$err_field", "$err_code", "$err_message",
  "$err_value", "$err_subtable", "$err_subrow", "$err_subrow_id",
] as const;

export interface DmlCandidateValidationResult {
  readonly rowNumber: number;
  readonly preErrors: ProcessRow[];
  readonly builtInErrors: ProcessRow[];
  readonly checkErrors: ProcessRow[];
}

export interface ValidateDmlCandidatesOptions {
  /** B43 prepared post-image path owns update-mode built-in validation. */
  readonly validateUpdateBuiltIns?: boolean;
}

/** Prepare only the sparse write shape needed to build an update-mode post-image. */
export function materializeDmlUpdateModeSparseRecords(
  candidates: readonly DmlValidationCandidate[],
  targetFields: readonly string[],
  fieldInfos: readonly KintoneFieldInfo[]
): void {
  const infoByCode = new Map(fieldInfos.map((field) => [field.code, field]));
  for (const candidate of candidates) {
    if (candidate.mode !== "update") continue;
    candidate.record ??= {};
    for (const code of targetFields) {
      if (!candidate.payload.has(code)) continue;
      const original = candidate.payload.get(code);
      const type = infoByCode.get(code)!.fieldType;
      const preserveCodes = ["USER_SELECT", "ORGANIZATION_SELECT", "GROUP_SELECT"].includes(type)
        && Array.isArray(original) && original.every((item) => typeof item === "object" && item !== null && "code" in item);
      let normalized: unknown = original;
      try {
        normalized = normalizeRaw(original, type);
      } catch { /* validatePostImage owns the deterministic error row. */ }
      candidate.record[code] = { value: preserveCodes ? original as Array<{ code: string }> : normalized as never };
    }
  }
}

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
  includePreErrors = true,
  validationOptions: ValidateDmlCandidatesOptions = {}
): {
  errors: ProcessRow[];
  invalidRows: number;
  invalidRowNumbers: Set<number>;
  candidateResults: DmlCandidateValidationResult[];
} {
  // Create-mode and the pre-B43 fallback validate payload cells here. The prepared B43
  // update-mode path delegates every built-in cell check to validatePostImage.
  const infoByCode = new Map(fieldInfos.map((field) => [field.code, field]));
  const errors: ProcessRow[] = [];
  const invalid = new Set<number>();
  const candidateResults: DmlCandidateValidationResult[] = [];
  if (validationOptions.validateUpdateBuiltIns === false) {
    materializeDmlUpdateModeSparseRecords(candidates, targetFields, fieldInfos);
  }
  let firstEvaluationError: unknown;
  for (const candidate of candidates) {
    candidate.record ??= {};
    const preErrors = includePreErrors ? [...candidate.preErrors] : [];
    const builtInErrors: Array<{ field: string; code: DmlValidationErrorCode; message: string }> = [];
    const checkErrors: Array<{ field: string; code: DmlValidationErrorCode; message: string }> = [];
    const validateBuiltIns = candidate.mode === "create" || validationOptions.validateUpdateBuiltIns !== false;
    for (const code of targetFields) {
      if (!candidate.payload.has(code)) continue;
      const original = candidate.payload.get(code);
      const type = infoByCode.get(code)!.fieldType;
      const preserveCodes = ["USER_SELECT", "ORGANIZATION_SELECT", "GROUP_SELECT"].includes(type)
        && Array.isArray(original) && original.every((item) => typeof item === "object" && item !== null && "code" in item);
      if (!validateBuiltIns) continue;
      const result = validateAndNormalizeDmlValue(original, infoByCode.get(code)!, numberPrecision);
      if (!result.ok) builtInErrors.push({ field: code, code: result.code, message: result.message });
      else candidate.record[code] = { value: preserveCodes ? original as Array<{ code: string }> : result.value };
    }
    if (validateMissingCreateFields && candidate.mode === "create") {
      for (const info of fieldInfos) {
        if (info.inSubtable) continue;
        if (candidate.payload.has(info.code)) continue;
        const emptyDefault = isEmptyDmlValue(info.defaultValue);
        if (!emptyDefault) {
          const defaultResult = validateAndNormalizeDmlValue(info.defaultValue, info, numberPrecision);
          if (!defaultResult.ok) builtInErrors.push({
            field: info.code, code: defaultResult.code, message: `既定値: ${defaultResult.message}`,
          });
        } else {
          const emptyResult = validateAndNormalizeDmlValue("", info, numberPrecision);
          if (!emptyResult.ok) {
            builtInErrors.push({ field: info.code, code: emptyResult.code, message: emptyResult.message });
          } else if (info.required) {
            builtInErrors.push({ field: info.code, code: "ERR_REQUIRED", message: `${info.code} は必須です` });
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
          checkErrors.push({ field: "", code: "ERR_CHECK", message: custom.message });
        }
      } catch (error) {
        firstEvaluationError ??= error;
      }
    }
    const materializeErrors = (source: readonly { field: string; code: DmlValidationErrorCode; message: string }[]): ProcessRow[] => source.map((error) => {
      const row: ProcessRow = {};
      for (const field of payloadFields) row[field] = renderValidationValue(candidate.payload.get(field));
      row["$err_statement"] = String(statementNumber);
      row["$err_operation"] = operation;
      row["$err_row"] = String(candidate.rowNumber);
      row["$err_field"] = error.field;
      row["$err_code"] = error.code;
      row["$err_message"] = error.message;
      row["$err_value"] = "";
      row["$err_subtable"] = "";
      row["$err_subrow"] = "";
      row["$err_subrow_id"] = "";
      return row;
    });
    const materialized = {
      rowNumber: candidate.rowNumber,
      preErrors: materializeErrors(preErrors),
      builtInErrors: materializeErrors(builtInErrors),
      checkErrors: materializeErrors(checkErrors),
    };
    candidateResults.push(materialized);
    const rowErrors = [...materialized.preErrors, ...materialized.builtInErrors, ...materialized.checkErrors];
    if (rowErrors.length > 0) invalid.add(candidate.rowNumber);
    errors.push(...rowErrors);
  }
  if (firstEvaluationError !== undefined) throw firstEvaluationError;
  return { errors, invalidRows: invalid.size, invalidRowNumbers: invalid, candidateResults };
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
