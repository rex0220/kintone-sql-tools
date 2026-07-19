import { renderValidationValue } from "./dmlValidationCandidates";
import { isEmptyDmlValue, normalizeRaw } from "./dmlValidation";

/** B41 $err_value contract: empty raw selections stay empty; non-empty arrays are code-only JSON. */
export function renderExistingValidationValue(raw: unknown, fieldType: string): string {
  return isEmptyDmlValue(raw) ? "" : renderValidationValue(normalizeRaw(raw, fieldType));
}
