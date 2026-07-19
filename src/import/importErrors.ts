import type { ProcessRow } from "../engine/process";
import type { ImportValidationError } from "./importRecordValidation";

/** Phase 5-only extension. Existing B12/B34 meta columns remain unchanged. */
export const IMPORT_VALIDATION_META_COLUMNS = [
  "$err_statement", "$err_operation", "$err_row", "$err_field",
  "$err_subtable", "$err_subrow", "$err_source_row", "$err_code", "$err_message",
] as const;

export function materializeImportValidationErrors(
  errors: readonly ImportValidationError[],
  payloadFields: readonly string[],
  statementNumber = 1
): ProcessRow[] {
  return errors.map((error) => {
    const row: ProcessRow = {};
    for (const field of payloadFields) row[field] = error.sourceValues.get(field) == null ? "" : render(error.sourceValues.get(field));
    row["$err_statement"] = String(statementNumber);
    row["$err_operation"] = error.operation;
    row["$err_row"] = String(error.parentRow);
    row["$err_field"] = error.field;
    row["$err_subtable"] = error.subtable ?? "";
    row["$err_subrow"] = error.subrow == null ? "" : String(error.subrow);
    // ProcessRow is historically string-only, but the Phase 5 JSON contract requires a real null.
    row["$err_source_row"] = error.sourceRow == null ? null as unknown as string : String(error.sourceRow);
    row["$err_code"] = error.code;
    row["$err_message"] = error.message;
    return row;
  });
}

function render(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && value !== null && "kind" in value && "lexeme" in value && (value as { kind?: string }).kind === "number") {
    return String(value.lexeme);
  }
  if (Array.isArray(value)) return JSON.stringify(value);
  return String(value);
}
