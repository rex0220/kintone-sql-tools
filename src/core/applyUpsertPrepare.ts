import type { KintoneFieldInfo } from "../execute";
import type { KintoneRecord, KintoneUpdateRecord } from "../converter/dmlToKintone";
import type { Assignment, InsertStatement, UpdateStatement, UpsertStatement } from "../types/ast";
import {
  prepareApplyInsert,
  resolveApplyInsertMetadata,
  type PreparedApplyInsert,
  type PreparedApplyInsertBatch,
} from "./applyInsertPrepare";
import {
  prepareApplyPatchWrite,
  type PreparedApplyWrite,
} from "./applyPatchPrepare";
import { resolveApplyPatchMetadata, type ApplyPatchMetadata } from "./applyPatchPlanner";
import type { NumberPrecision } from "./numberPrecision";

export interface ApplyUpsertMatch {
  readonly sourceRowIndex: number;
  readonly targetId?: number;
  readonly snapshot?: KintoneRecord;
}

export interface PreparedApplyUpsertBatch<T> {
  readonly app: number;
  readonly records: readonly T[];
}

export interface PreparedApplyUpsertGuards {
  readonly revisionRequired: boolean;
  readonly parentRows: number;
  readonly dmlMaxRows: number;
  readonly subtableRows: number;
  readonly dmlMaxSubtableRows: number;
  readonly wouldExceed: boolean;
  readonly create: PreparedApplyInsert["guards"];
  readonly update: PreparedApplyWrite["guards"];
}

/** Phase 14b boundary. It contains POST/PUT materials but no client or writer. */
export interface PreparedApplyUpsert {
  readonly create: PreparedApplyInsert;
  readonly update: PreparedApplyWrite;
  readonly createBatches: readonly PreparedApplyInsertBatch[];
  readonly updateBatches: readonly PreparedApplyUpsertBatch<KintoneUpdateRecord>[];
  readonly guards: PreparedApplyUpsertGuards;
}

export interface PrepareApplyUpsertInput {
  readonly statement: UpsertStatement;
  readonly matches: readonly ApplyUpsertMatch[];
  readonly fieldInfos: readonly KintoneFieldInfo[];
  readonly dmlMaxRows: number;
  readonly dmlMaxSubtableRows: number;
  readonly statementNumber?: number;
  readonly loadNumberPrecision?: () => Promise<NumberPrecision>;
}

/**
 * Reuses Phase 13b for creates and Phase 10b for updates, then performs the
 * mixed guard only after every candidate has been planned and validated.
 */
export async function prepareApplyUpsert(input: PrepareApplyUpsertInput): Promise<PreparedApplyUpsert> {
  const { statement, matches, fieldInfos, dmlMaxRows, dmlMaxSubtableRows, statementNumber = 1 } = input;
  assertPositiveLimit(dmlMaxRows, "dmlMaxRows");
  assertPositiveLimit(dmlMaxSubtableRows, "dmlMaxSubtableRows");
  assertMatchCoverage(statement, matches);

  const createMatches = matches.filter((match) => match.targetId === undefined);
  const updateMatches = matches.filter((match) => match.targetId !== undefined);
  const createStatement = toInsertStatement(statement, createMatches.map((match) => match.sourceRowIndex));
  const create = await prepareApplyInsert({
    statement: createStatement,
    fieldInfos,
    metadata: resolveApplyInsertMetadata(createStatement, fieldInfos),
    dmlMaxRows,
    dmlMaxSubtableRows,
    statementNumber,
    parentRowNumbers: createMatches.map((match) => match.sourceRowIndex + 1),
    loadNumberPrecision: input.loadNumberPrecision,
  });

  const updateParts: PreparedApplyWrite[] = [];
  const seenTargets = new Set<number>();
  for (const match of updateMatches) {
    const targetId = match.targetId!;
    if (seenTargets.has(targetId)) argument(`UPSERT APPLY resolves more than one source row to parent $id ${targetId}.`);
    seenTargets.add(targetId);
    if (!match.snapshot) argument(`UPSERT APPLY snapshot for parent $id ${targetId} is missing.`);
    const snapshotId = Number(match.snapshot["$id"]?.value);
    if (snapshotId !== targetId) argument(`UPSERT APPLY snapshot $id ${snapshotId} does not match target $id ${targetId}.`);
    const updateStatement = toUpdateStatement(statement, match.sourceRowIndex, targetId);
    const metadata: ApplyPatchMetadata = updateStatement.applyBlocks?.length
      ? resolveApplyPatchMetadata(updateStatement, fieldInfos)
      : emptyPatchMetadata(fieldInfos);
    updateParts.push(await prepareApplyPatchWrite({
      statement: updateStatement,
      snapshots: [match.snapshot],
      fieldInfos,
      metadata,
      dmlMaxRows,
      dmlMaxSubtableRows,
      statementNumber,
      parentRowNumbers: [match.sourceRowIndex + 1],
      loadNumberPrecision: input.loadNumberPrecision,
    }));
  }
  const update = combineUpdatePrepared(updateParts, dmlMaxRows, dmlMaxSubtableRows);
  const parentRows = create.guards.parentRows + update.guards.parentRows;
  const subtableRows = create.guards.subtableRows + update.guards.subtableRows;
  const wouldExceed = parentRows > dmlMaxRows || subtableRows > dmlMaxSubtableRows;
  if (!statement.validateOnly) {
    const validationErrors = [
      ...create.validations.flatMap((validation) => validation.errors),
      ...update.validations.flatMap((validation) => validation.errors),
    ];
    if (validationErrors.length > 0) {
      throw new Error(`ArgumentError: APPLY post-image validation failed: ${JSON.stringify({
        columns: create.validations[0]?.columns ?? update.validations[0]?.columns ?? [],
        errors: validationErrors,
      })}`);
    }
  }
  if (!statement.validateOnly && parentRows > dmlMaxRows) {
    throw new Error(`ArgumentError: APPLY parent rows (${parentRows}) exceed dmlMaxRows (${dmlMaxRows}).`);
  }
  if (!statement.validateOnly && subtableRows > dmlMaxSubtableRows) {
    throw new Error(`ArgumentError: APPLY changed subtable rows (${subtableRows}) exceed dmlMaxSubtableRows (${dmlMaxSubtableRows}).`);
  }

  return deepFreeze({
    create,
    update,
    createBatches: create.batches,
    updateBatches: chunk(update.records, statement.appId),
    guards: {
      revisionRequired: update.guards.parentRows > 0,
      parentRows,
      dmlMaxRows,
      subtableRows,
      dmlMaxSubtableRows,
      wouldExceed,
      create: create.guards,
      update: update.guards,
    },
  });
}

function toInsertStatement(statement: UpsertStatement, indices: readonly number[]): InsertStatement {
  return {
    type: "INSERT",
    appId: statement.appId,
    fields: [...statement.fields],
    values: indices.map((index) => statement.values[index]),
    applyBlocks: statement.onInsertApplyBlocks ?? [],
    // Branch planners must finish every candidate before mixed errors/guards are raised below.
    validateOnly: true,
  };
}

function toUpdateStatement(statement: UpsertStatement, sourceRowIndex: number, targetId: number): UpdateStatement {
  const assignments: Assignment[] = statement.fields.map((field, index) => ({
    field,
    value: statement.values[sourceRowIndex][index],
  }));
  return {
    type: "UPDATE",
    appId: statement.appId,
    subtableCode: null,
    assignments,
    from: null,
    where: {
      type: "BINARY",
      op: "=",
      left: { type: "FIELD", tableAlias: null, field: "$id" },
      right: { type: "NUMBER", value: targetId, raw: String(targetId) },
    },
    applyBlocks: statement.onUpdateApplyBlocks ?? [],
    validateOnly: true,
  };
}

function emptyPatchMetadata(fieldInfos: readonly KintoneFieldInfo[]): ApplyPatchMetadata {
  return {
    targetTables: new Map(),
    childrenByTable: new Map(),
    fieldsByCode: new Map(fieldInfos.map((field) => [field.code, field])),
  };
}

function combineUpdatePrepared(
  parts: readonly PreparedApplyWrite[],
  dmlMaxRows: number,
  dmlMaxSubtableRows: number
): PreparedApplyWrite {
  const plans = parts.flatMap((part) => part.plans);
  const records = parts.flatMap((part) => part.records);
  const validations = parts.flatMap((part) => part.validations);
  const subtableRows = plans.reduce((sum, plan) => sum + plan.changedSubtableRows, 0);
  return deepFreeze({
    plans,
    records,
    validations,
    guards: {
      revisionRequired: true,
      parentRows: plans.length,
      dmlMaxRows,
      subtableRows,
      dmlMaxSubtableRows,
      wouldExceed: plans.length > dmlMaxRows || subtableRows > dmlMaxSubtableRows,
    },
  });
}

function assertMatchCoverage(statement: UpsertStatement, matches: readonly ApplyUpsertMatch[]): void {
  if (matches.length !== statement.values.length) {
    throw new Error("InternalError: UPSERT APPLY match count differs from VALUES rows.");
  }
  const seen = new Set<number>();
  for (const match of matches) {
    if (!Number.isSafeInteger(match.sourceRowIndex) || match.sourceRowIndex < 0
        || match.sourceRowIndex >= statement.values.length || seen.has(match.sourceRowIndex)) {
      throw new Error("InternalError: UPSERT APPLY matches must cover each source row exactly once.");
    }
    seen.add(match.sourceRowIndex);
  }
}

function chunk(records: readonly KintoneUpdateRecord[], app: number): PreparedApplyUpsertBatch<KintoneUpdateRecord>[] {
  const batches: PreparedApplyUpsertBatch<KintoneUpdateRecord>[] = [];
  for (let index = 0; index < records.length; index += 100) {
    batches.push({ app, records: records.slice(index, index + 100) });
  }
  return batches;
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
