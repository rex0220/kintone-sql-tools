import type { KintoneFieldInfo } from "../execute";
import { applyPatchPlanToKintone, requireRevision } from "../converter/applyPatchToKintone";
import type { KintoneRecord, KintoneUpdateRecord } from "../converter/dmlToKintone";
import type { UpdateStatement } from "../types/ast";
import {
  buildApplyPatchPlans,
  normalizeApplyPatchPlan,
  type ApplyPatchMetadata,
  type ApplyPatchPlan,
} from "./applyPatchPlanner";
import type { NumberPrecision } from "./numberPrecision";
import {
  buildPostImageFieldIndex,
  postImageNeedsNumberPrecision,
  validatePostImage,
  type PostImageValidationResult,
} from "./postImageValidation";

export interface PreparedApplyGuards {
  readonly revisionRequired: true;
  readonly parentRows: number;
  readonly dmlMaxRows: number;
  readonly subtableRows: number;
  readonly dmlMaxSubtableRows: number;
  readonly wouldExceed: boolean;
}

/**
 * Phase 10b write boundary. This value contains only fully planned, validated,
 * guard-checked data. It deliberately contains no client or writer reference.
 */
export interface PreparedApplyWrite {
  readonly plans: readonly ApplyPatchPlan[];
  /** Phase 10c chunks these already-converted record materials into PUT batches. */
  readonly records: readonly KintoneUpdateRecord[];
  readonly validations: readonly PreparedApplyValidation[];
  readonly guards: PreparedApplyGuards;
}

export type PreparedApplyValidation = Readonly<Pick<
  PostImageValidationResult,
  "errors" | "columns" | "invalidRows" | "errorCount"
>>;

export interface PrepareApplyPatchWriteInput {
  readonly statement: UpdateStatement;
  readonly snapshots: readonly KintoneRecord[];
  readonly fieldInfos: readonly KintoneFieldInfo[];
  readonly metadata: ApplyPatchMetadata;
  readonly dmlMaxRows: number;
  readonly dmlMaxSubtableRows: number;
  readonly statementNumber?: number;
  /** Read-only metadata loader. No records writer can cross the prepare boundary. */
  readonly loadNumberPrecision?: () => Promise<NumberPrecision>;
}

/** Plan, validate, normalize and guard every parent without performing any write. */
export async function prepareApplyPatchWrite(
  input: PrepareApplyPatchWriteInput
): Promise<PreparedApplyWrite> {
  const {
    statement,
    snapshots,
    fieldInfos,
    metadata,
    dmlMaxRows,
    dmlMaxSubtableRows,
    statementNumber = 1,
  } = input;
  assertPositiveLimit(dmlMaxRows, "dmlMaxRows");
  assertPositiveLimit(dmlMaxSubtableRows, "dmlMaxSubtableRows");

  // Keep the converter's revision contract as an explicit preflight gate.
  for (const snapshot of snapshots) requireRevision(snapshot);
  const rawPlans = buildApplyPatchPlans(statement, snapshots, fieldInfos, metadata);
  const fieldIndex = buildPostImageFieldIndex(
    fieldInfos,
    statement.assignments.map((assignment) => assignment.field)
  );
  const needsNumberPrecision = rawPlans.some((plan) =>
    postImageNeedsNumberPrecision(plan.postImage, fieldIndex)
  );
  if (needsNumberPrecision && !input.loadNumberPrecision) {
    throw new Error("InternalError: APPLY number precision loader is required for NUMBER post-images.");
  }
  const numberPrecision = needsNumberPrecision
    ? await input.loadNumberPrecision!()
    : undefined;
  const validationResults = rawPlans.map((plan, index) =>
    validatePostImage(plan.postImage, fieldIndex, numberPrecision, statementNumber, index + 1)
  );

  if (!statement.validateOnly) {
    const errors = validationResults.flatMap((validation) => validation.errors);
    if (errors.length > 0) {
      throw new Error(`ArgumentError: APPLY post-image validation failed: ${JSON.stringify({
        columns: validationResults[0]?.columns ?? [],
        errors,
      })}`);
    }
  }

  const parentRows = rawPlans.length;
  const subtableRows = rawPlans.reduce((sum, plan) => sum + plan.changedSubtableRows, 0);
  const wouldExceed = parentRows > dmlMaxRows || subtableRows > dmlMaxSubtableRows;
  if (!statement.validateOnly && parentRows > dmlMaxRows) {
    throw new Error(`ArgumentError: APPLY parent rows (${parentRows}) exceed dmlMaxRows (${dmlMaxRows}).`);
  }
  if (!statement.validateOnly && subtableRows > dmlMaxSubtableRows) {
    throw new Error(
      `ArgumentError: APPLY changed subtable rows (${subtableRows}) exceed dmlMaxSubtableRows (${dmlMaxSubtableRows}).`
    );
  }

  const plans = rawPlans.map((plan, index) =>
    normalizeApplyPatchPlan(plan, validationResults[index].normalizedRecord)
  );
  const records = plans.flatMap((plan) => applyPatchPlanToKintone(plan).records);
  const validations: PreparedApplyValidation[] = validationResults.map((validation) => ({
    errors: validation.errors,
    columns: validation.columns,
    invalidRows: validation.invalidRows,
    errorCount: validation.errorCount,
  }));
  return deepFreeze({
    plans,
    records,
    validations,
    guards: {
      revisionRequired: true,
      parentRows,
      dmlMaxRows,
      subtableRows,
      dmlMaxSubtableRows,
      wouldExceed,
    },
  });
}

function assertPositiveLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`ArgumentError: ${name} must be a positive safe integer.`);
  }
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value as object)) return value;
  seen.add(value as object);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}
