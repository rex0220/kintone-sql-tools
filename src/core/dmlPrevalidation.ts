import type { KintoneRecord } from "../converter/dmlToKintone";
import type { ProcessRow } from "../engine/process";
import type { PostImageFieldIndex } from "./postImageValidation";

export interface DmlCandidateValidationMergeInput {
  readonly rowNumber: number;
  readonly setFields: readonly string[];
  readonly normalizedPostImage: KintoneRecord;
  readonly preErrors: readonly ProcessRow[];
  readonly postImageErrors: readonly ProcessRow[];
  readonly checkErrors: readonly ProcessRow[];
}

export interface MergedDmlCandidateValidation {
  readonly errors: ProcessRow[];
  readonly invalidRows: number;
  readonly invalidRowNumbers: Set<number>;
  /** Normalized SET fields only. Complete snapshot fields never cross the write boundary. */
  readonly writeRecord: KintoneRecord;
}

/** Collect the complete-record GET field set understood by the shared post-image validator. */
export function collectDmlPrevalidationSnapshotFields(
  fieldIndex: PostImageFieldIndex
): string[] {
  return [
    "$id",
    ...new Set([
      ...fieldIndex.topLevel.map((field) => field.code).filter((code) => code !== "$id" && code !== "$revision"),
      ...fieldIndex.subtables.keys(),
    ]),
  ];
}

/** Build a validation-only complete post-image without sharing mutable state with either input. */
export function buildDmlValidationPostImage(
  snapshot: Readonly<KintoneRecord>,
  sparseRecord: Readonly<KintoneRecord>
): KintoneRecord {
  const postImage = deepClone(snapshot) as KintoneRecord;
  for (const [field, cell] of Object.entries(sparseRecord)) {
    postImage[field] = deepClone(cell) as KintoneRecord[string];
  }
  return postImage;
}

/** Merge one candidate's ordered validation categories and project its normalized sparse write. */
export function mergeDmlCandidateValidation(
  input: DmlCandidateValidationMergeInput
): MergedDmlCandidateValidation {
  const errors = [
    ...input.preErrors.map((row) => normalizePlainError(row)),
    ...input.postImageErrors.map((row) => normalizePlainError(row, row["$err_subtable"] !== "")),
    ...input.checkErrors.map((row) => normalizePlainError(row)),
  ];
  const invalidRowNumbers = new Set<number>();
  if (errors.length > 0) invalidRowNumbers.add(input.rowNumber);

  const writeRecord: KintoneRecord = {};
  for (const field of new Set(input.setFields)) {
    if (!Object.prototype.hasOwnProperty.call(input.normalizedPostImage, field)) {
      throw new Error(`InternalError: normalized post-image is missing SET field: ${field}`);
    }
    writeRecord[field] = deepClone(input.normalizedPostImage[field]);
  }
  return {
    errors,
    invalidRows: invalidRowNumbers.size,
    invalidRowNumbers,
    writeRecord,
  };
}

function normalizePlainError(row: ProcessRow, childCell = false): ProcessRow {
  return {
    ...row,
    $err_value: childCell ? row["$err_value"] ?? "" : "",
    $err_subtable: childCell ? row["$err_subtable"] ?? "" : "",
    $err_subrow: childCell ? row["$err_subrow"] ?? "" : "",
    $err_subrow_id: childCell ? row["$err_subrow_id"] ?? "" : "",
  };
}

function deepClone<T>(value: T, seen = new Map<object, unknown>()): T {
  if (value === null || typeof value !== "object") return value;
  const object = value as object;
  const existing = seen.get(object);
  if (existing !== undefined) return existing as T;
  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(object, clone);
    for (const item of value) clone.push(deepClone(item, seen));
    return clone as T;
  }
  const clone: Record<string, unknown> = {};
  seen.set(object, clone);
  for (const [key, child] of Object.entries(value)) clone[key] = deepClone(child, seen);
  return clone as T;
}
