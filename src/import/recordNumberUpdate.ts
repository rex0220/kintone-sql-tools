import type { DmlValidationErrorCode } from "../core/dmlValidation";

export interface RecordNumberKeyError {
  field: string;
  code: DmlValidationErrorCode;
  message: string;
}

/** Record numbers are raw ASCII decimal integers. No trim or display-prefix syntax. */
export function normalizeImportRecordNumber(raw: string): string | null {
  return /^[0-9]+$/.test(raw) ? raw.replace(/^0+(?=\d)/, "") : null;
}

export function preflightImportRecordNumbers(values: readonly string[], header: string): {
  normalized: Array<string | null>;
  errors: RecordNumberKeyError[][];
} {
  const normalized = values.map(normalizeImportRecordNumber);
  const seen = new Set<string>();
  for (const key of normalized) {
    if (key === null) continue;
    if (seen.has(key)) {
      throw new Error("ERR_RECORD_NUMBER_DUP_SOURCE: source contains a duplicate record number");
    }
    seen.add(key);
  }
  return {
    normalized,
    errors: normalized.map((key) => key === null ? [{
      field: header,
      code: "ERR_RECORD_NUMBER_INVALID",
      message: `${header} must be a non-empty ASCII decimal record number`,
    }] : []),
  };
}
