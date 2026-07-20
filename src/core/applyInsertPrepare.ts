import type { KintoneFieldInfo } from "../execute";
import { insertToPostBatches, type FieldTypeMap, type KintoneRecord } from "../converter/dmlToKintone";
import type { AppendOperation, ApplyBlock, InsertStatement } from "../types/ast";
import {
  appendDefaultValue,
  buildApplyAppendRows,
  type ApplyPatchMetadata,
  type ApplyPatchPostImageRow,
} from "./applyPatchPlanner";
import type { NumberPrecision } from "./numberPrecision";
import {
  buildPostImageFieldIndex,
  postImageNeedsNumberPrecision,
  validatePostImage,
  type PostImageValidationResult,
} from "./postImageValidation";

const NON_WRITABLE_FIELD_TYPES = new Set([
  "CALC", "RECORD_NUMBER", "CREATOR", "CREATED_TIME", "MODIFIER", "UPDATED_TIME",
  "STATUS", "STATUS_ASSIGNEE", "CATEGORY", "REFERENCE_TABLE",
]);

export interface ApplyInsertTableCandidate {
  readonly table: string;
  readonly rows: readonly ApplyPatchPostImageRow[];
  readonly addedRows: number;
}

export interface ApplyInsertCandidate {
  readonly parentRowNumber: number;
  readonly tables: readonly ApplyInsertTableCandidate[];
  /** Complete create image used only for validation. */
  readonly postImage: Readonly<Record<string, { readonly value: unknown }>>;
  /** POST material: specified parent fields plus explicit APPLY table rows. */
  readonly record: KintoneRecord;
}

export interface PreparedApplyInsertBatch {
  readonly app: number;
  readonly records: readonly KintoneRecord[];
}

export interface PreparedApplyInsertGuards {
  readonly revisionRequired: false;
  readonly parentRows: number;
  readonly dmlMaxRows: number;
  readonly subtableRows: number;
  readonly dmlMaxSubtableRows: number;
  readonly wouldExceed: boolean;
}

export type PreparedApplyInsertValidation = Readonly<Pick<
  PostImageValidationResult,
  "errors" | "columns" | "invalidRows" | "errorCount"
>>;

/** Phase 13b boundary: immutable POST materials with no client/writer reference. */
export interface PreparedApplyInsert {
  /** Immutable operation template retained for shared diagnostics. */
  readonly applyBlocks?: readonly ApplyBlock[];
  readonly candidates: readonly ApplyInsertCandidate[];
  readonly records: readonly KintoneRecord[];
  readonly batches: readonly PreparedApplyInsertBatch[];
  readonly validations: readonly PreparedApplyInsertValidation[];
  readonly guards: PreparedApplyInsertGuards;
}

export interface PrepareApplyInsertInput {
  readonly statement: InsertStatement;
  readonly fieldInfos: readonly KintoneFieldInfo[];
  readonly metadata?: ApplyPatchMetadata;
  readonly dmlMaxRows: number;
  readonly dmlMaxSubtableRows: number;
  readonly statementNumber?: number;
  /** Original source row numbers when a caller prepares a filtered VALUES subset. */
  readonly parentRowNumbers?: readonly number[];
  readonly loadNumberPrecision?: () => Promise<NumberPrecision>;
}

/** Resolve create ownership/writability without reading or writing records. */
export function resolveApplyInsertMetadata(
  statement: InsertStatement,
  fieldInfos: readonly KintoneFieldInfo[]
): ApplyPatchMetadata {
  if (new Set(statement.fields).size !== statement.fields.length) {
    return argument("DML target fields contain duplicates.");
  }
  const fieldsByCode = new Map(fieldInfos.map((field) => [field.code, field]));
  for (const code of statement.fields) assertWritable(code, null, fieldsByCode);

  const targetTables = new Map<string, KintoneFieldInfo>();
  const childrenByTable = new Map<string, ReadonlyMap<string, KintoneFieldInfo>>();
  for (const block of statement.applyBlocks ?? []) {
    if (targetTables.has(block.field)) return argument(`APPLY has more than one block for table ${block.field}.`);
    const table = fieldInfos.find((field) => field.code === block.field && !field.inSubtable);
    if (!table || table.fieldType !== "SUBTABLE") return argument(`APPLY target ${block.field} is not a SUBTABLE.`);
    const children = new Map(fieldInfos
      .filter((field) => field.inSubtable && field.subtableCode === block.field)
      .map((field) => [field.code, field]));
    targetTables.set(block.field, table);
    childrenByTable.set(block.field, children);
    for (const operation of block.operations) {
      if (operation.kind !== "APPEND") return argument(`APPLY INSERT supports APPEND only (${operation.kind}).`);
      const specified = new Set<string>();
      for (const code of operation.fields) {
        if (specified.has(code)) return argument(`APPLY APPEND specifies child ${code} more than once.`);
        specified.add(code);
        assertWritable(code, block.field, fieldsByCode, children);
      }
      for (const row of operation.values) {
        if (row.length !== operation.fields.length) {
          return argument(`APPLY APPEND for ${block.field} has ${row.length} values for ${operation.fields.length} fields.`);
        }
      }
    }
  }
  return { targetTables, targetMultiValueFields: new Map(), childrenByTable, fieldsByCode };
}

/** Expand every VALUES parent with the same fixed APPLY APPEND template. */
export function buildApplyInsertCandidates(
  statement: InsertStatement,
  fieldInfos: readonly KintoneFieldInfo[],
  metadata = resolveApplyInsertMetadata(statement, fieldInfos),
  parentRowNumbers?: readonly number[]
): readonly ApplyInsertCandidate[] {
  const fieldTypes: FieldTypeMap = new Map(fieldInfos.map((field) => [field.code, field.fieldType]));
  const parentRecords = insertToPostBatches(statement, fieldTypes).flatMap((batch) => batch.records);
  if (parentRowNumbers && parentRowNumbers.length !== parentRecords.length) {
    throw new Error("InternalError: APPLY create parent row number count differs from VALUES rows.");
  }
  const templates = (statement.applyBlocks ?? []).map((block): ApplyInsertTableCandidate => {
    const children = metadata.childrenByTable.get(block.field)!;
    const rows = block.operations.flatMap((operation) =>
      buildApplyAppendRows(operation as AppendOperation, children, block.field)
    );
    return { table: block.field, rows, addedRows: rows.length };
  });

  return parentRecords.map((parentRecord, index) => {
    const postImage: Record<string, { value: unknown }> = {};
    for (const field of fieldInfos) {
      if (field.inSubtable || field.fieldType === "SUBTABLE" || field.fieldType === "FILE"
          || field.writable === false || NON_WRITABLE_FIELD_TYPES.has(field.fieldType)) continue;
      postImage[field.code] = parentRecord[field.code] ?? { value: appendDefaultValue(field) };
    }
    const record: KintoneRecord = { ...parentRecord };
    for (const template of templates) {
      const rows = template.rows.map((row) => ({ value: row.value }));
      postImage[template.table] = { value: rows };
      record[template.table] = { value: rows } as never;
    }
    return {
      parentRowNumber: parentRowNumbers?.[index] ?? index + 1,
      tables: templates,
      postImage,
      record,
    };
  });
}

/** Build, validate, normalize, guard, and chunk create materials without POST. */
export async function prepareApplyInsert(input: PrepareApplyInsertInput): Promise<PreparedApplyInsert> {
  const {
    statement,
    fieldInfos,
    dmlMaxRows,
    dmlMaxSubtableRows,
    statementNumber = 1,
  } = input;
  assertPositiveLimit(dmlMaxRows, "dmlMaxRows");
  assertPositiveLimit(dmlMaxSubtableRows, "dmlMaxSubtableRows");
  const metadata = input.metadata ?? resolveApplyInsertMetadata(statement, fieldInfos);
  const rawCandidates = buildApplyInsertCandidates(statement, fieldInfos, metadata, input.parentRowNumbers);
  // Create post-images contain only fields the client can supply. Generated/FILE fields are
  // deliberately outside both validation and POST payload ownership.
  const creatableFieldInfos = fieldInfos.filter((field) =>
    field.fieldType === "SUBTABLE"
    || (field.fieldType !== "FILE" && field.writable !== false && !NON_WRITABLE_FIELD_TYPES.has(field.fieldType))
  );
  const fieldIndex = buildPostImageFieldIndex(creatableFieldInfos, statement.fields);
  const needsNumberPrecision = rawCandidates.some((candidate) =>
    postImageNeedsNumberPrecision(candidate.postImage, fieldIndex)
  );
  if (needsNumberPrecision && !input.loadNumberPrecision) {
    throw new Error("InternalError: APPLY number precision loader is required for NUMBER post-images.");
  }
  const numberPrecision = needsNumberPrecision ? await input.loadNumberPrecision!() : undefined;
  const results = rawCandidates.map((candidate) => validatePostImage(
    candidate.postImage,
    fieldIndex,
    numberPrecision,
    statementNumber,
    candidate.parentRowNumber,
    "INSERT"
  ));

  if (!statement.validateOnly) {
    const errors = results.flatMap((result) => result.errors);
    if (errors.length > 0) {
      throw new Error(`ArgumentError: APPLY post-image validation failed: ${JSON.stringify({
        columns: results[0]?.columns ?? [],
        errors,
      })}`);
    }
  }

  const parentRows = rawCandidates.length;
  const subtableRows = rawCandidates.reduce(
    (sum, candidate) => sum + candidate.tables.reduce((tableSum, table) => tableSum + table.addedRows, 0),
    0
  );
  const wouldExceed = parentRows > dmlMaxRows || subtableRows > dmlMaxSubtableRows;
  if (!statement.validateOnly && parentRows > dmlMaxRows) {
    throw new Error(`ArgumentError: APPLY parent rows (${parentRows}) exceed dmlMaxRows (${dmlMaxRows}).`);
  }
  if (!statement.validateOnly && subtableRows > dmlMaxSubtableRows) {
    throw new Error(`ArgumentError: APPLY changed subtable rows (${subtableRows}) exceed dmlMaxSubtableRows (${dmlMaxSubtableRows}).`);
  }

  const candidates = rawCandidates.map((candidate, index): ApplyInsertCandidate => {
    const normalized = results[index].normalizedRecord;
    const record: KintoneRecord = {};
    for (const code of statement.fields) record[code] = normalized[code];
    for (const table of candidate.tables) {
      const normalizedRows = normalized[table.table]?.value as Array<{
        value?: Record<string, { value: unknown }>;
      }>;
      record[table.table] = { value: table.rows.map((sourceRow, rowIndex) => ({
        value: Object.fromEntries(Object.keys(sourceRow.value).map((code) => [
          code,
          normalizedRows[rowIndex]?.value?.[code] ?? sourceRow.value[code],
        ])),
      })) } as never;
    }
    return { ...candidate, postImage: normalized, record };
  });
  const records = candidates.map((candidate) => candidate.record);
  const batches: PreparedApplyInsertBatch[] = [];
  for (let index = 0; index < records.length; index += 100) {
    batches.push({ app: statement.appId, records: records.slice(index, index + 100) });
  }
  const validations = results.map((result) => ({
    errors: result.errors,
    columns: result.columns,
    invalidRows: result.invalidRows,
    errorCount: result.errorCount,
  }));
  return deepFreeze({
    applyBlocks: statement.applyBlocks ?? [],
    candidates,
    records,
    batches,
    validations,
    guards: {
      revisionRequired: false,
      parentRows,
      dmlMaxRows,
      subtableRows,
      dmlMaxSubtableRows,
      wouldExceed,
    },
  });
}

function assertWritable(
  code: string,
  table: string | null,
  fieldsByCode: ReadonlyMap<string, KintoneFieldInfo>,
  children?: ReadonlyMap<string, KintoneFieldInfo>
): void {
  if (code.startsWith("_") || code.startsWith("$")) return argument(`APPLY assignment target ${code} is a system field.`);
  const field = table === null
    ? [...fieldsByCode.values()].find((candidate) => candidate.code === code && !candidate.inSubtable)
    : children?.get(code);
  if (!field) {
    const elsewhere = fieldsByCode.get(code);
    if (table !== null && elsewhere?.inSubtable) return argument(`APPLY child ${code} does not belong to subtable ${table}.`);
    return argument(`APPLY ${table === null ? "parent field" : "child"} ${code} does not exist.`);
  }
  if (field.fieldType === "SUBTABLE" || field.fieldType === "FILE" || field.writable === false
      || NON_WRITABLE_FIELD_TYPES.has(field.fieldType)) {
    return argument(`APPLY assignment target ${code} is not writable (${field.fieldType}).`);
  }
}

function assertPositiveLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`ArgumentError: ${name} must be a positive safe integer.`);
  }
}

function argument(message: string): never {
  throw new Error(`ArgumentError: ${message}`);
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value as object)) return value;
  seen.add(value as object);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}
