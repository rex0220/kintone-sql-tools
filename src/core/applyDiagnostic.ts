import type { PreparedApplyInsert } from "./applyInsertPrepare";
import type { PreparedApplyWrite } from "./applyPatchPrepare";
import type { PreparedApplyUpsert } from "./applyUpsertPrepare";
import type { ApplyBlock, ApplyOperation, InsertStatement, UpdateStatement, UpsertStatement } from "../types/ast";

export type ApplyDiagnosticStatementKind = "UPDATE" | "INSERT" | "UPSERT";
export type ApplyDiagnosticBranchKind = "insert" | "update";
export type ApplyDiagnosticTargetKind = "SUBTABLE" | "MULTI_VALUE";
export type ApplyDiagnosticOperationKind = "PATCH" | "APPEND" | "REMOVE" | "ADD" | "REMOVE_VALUE";

export interface ApplyDiagnosticOperation {
  readonly kind: ApplyDiagnosticOperationKind;
  /** Primary affected-item count. null means EXPLAIN cannot know it without records access. */
  readonly count: number | null;
  readonly matchedRows?: number | null;
  readonly changedRows?: number | null;
  readonly addedRows?: number | null;
  readonly removedRows?: number | null;
  readonly value?: string;
  /** Legacy per-operation compatibility value (the first prepared parent). */
  readonly changed?: boolean;
}

export interface ApplyDiagnosticTarget {
  readonly targetKind: ApplyDiagnosticTargetKind;
  readonly field: string;
  readonly fieldType?: string;
  readonly operations: readonly ApplyDiagnosticOperation[];
  /** Distinct changed subtable rows or changed collection values. */
  readonly changedCount: number | null;
  readonly postImages?: readonly { readonly parentId: number; readonly value: readonly unknown[] }[];
}

export interface ApplyDiagnosticGuard {
  readonly revisionRequired: boolean;
  readonly parentRows: number | null;
  readonly dmlMaxRows: number;
  readonly subtableRows: number | null;
  readonly dmlMaxSubtableRows: number;
  readonly wouldExceed: boolean | null;
}

export interface ApplyDiagnosticChunk {
  readonly size: 100;
  readonly plannedChunks: number | null;
  readonly successfulChunks?: number;
  readonly failedChunkIndex?: number;
  readonly failedStage?: "PUT_CHUNK" | "POST_CHUNK";
}

export interface ApplyDiagnosticBranch {
  readonly branch: ApplyDiagnosticBranchKind;
  readonly parentRows: number | null;
  readonly targets: readonly ApplyDiagnosticTarget[];
  readonly guards: ApplyDiagnosticGuard;
  readonly chunk: ApplyDiagnosticChunk;
  readonly deletedParentRows: number | null;
  readonly successfulParents?: number;
}

export interface ApplyDiagnostic {
  readonly statementKind: ApplyDiagnosticStatementKind;
  readonly branches: readonly ApplyDiagnosticBranch[];
  readonly nonTransactional: true;
  readonly partialSuccess: {
    readonly possible: true;
    readonly successfulParents?: number;
    readonly successfulChunks?: number;
    readonly failedBranch?: ApplyDiagnosticBranchKind;
    readonly retryAttempted?: false;
  };
}

export interface ApplyDiagnosticProgress {
  readonly successfulParents: number;
  readonly successfulChunks: number;
  readonly successfulInserts?: number;
  readonly successfulUpdates?: number;
  readonly successfulInsertChunks?: number;
  readonly successfulUpdateChunks?: number;
  readonly failedBranch?: "INSERT" | "UPDATE";
  readonly failedChunkIndex?: number;
  readonly failedStage?: "PUT_CHUNK" | "POST_CHUNK";
  readonly retryAttempted?: false;
}

export function buildPreparedApplyUpdateDiagnostic(prepared: PreparedApplyWrite): ApplyDiagnostic {
  return diagnostic("UPDATE", [buildPreparedUpdateBranch(prepared)]);
}

export function buildPreparedApplyInsertDiagnostic(prepared: PreparedApplyInsert): ApplyDiagnostic {
  return diagnostic("INSERT", [buildPreparedInsertBranch(prepared)]);
}

export function buildPreparedApplyUpsertDiagnostic(prepared: PreparedApplyUpsert): ApplyDiagnostic {
  return diagnostic("UPSERT", [
    buildPreparedInsertBranch(prepared.create),
    buildPreparedUpdateBranch(prepared.update),
  ]);
}

export function withApplyDiagnosticProgress(
  base: ApplyDiagnostic,
  progress: ApplyDiagnosticProgress
): ApplyDiagnostic {
  const failedBranch = progress.failedBranch?.toLowerCase() as ApplyDiagnosticBranchKind | undefined;
  const branches = base.branches.map((branch): ApplyDiagnosticBranch => {
    const successfulParents = base.statementKind === "UPSERT"
      ? branch.branch === "insert" ? progress.successfulInserts : progress.successfulUpdates
      : progress.successfulParents;
    const successfulChunks = base.statementKind === "UPSERT"
      ? branch.branch === "insert" ? progress.successfulInsertChunks : progress.successfulUpdateChunks
      : progress.successfulChunks;
    const isFailedBranch = failedBranch === branch.branch;
    return {
      ...branch,
      ...(successfulParents !== undefined ? { successfulParents } : {}),
      chunk: {
        ...branch.chunk,
        ...(successfulChunks !== undefined ? { successfulChunks } : {}),
        ...(isFailedBranch && progress.failedChunkIndex !== undefined
          ? { failedChunkIndex: progress.failedChunkIndex } : {}),
        ...(isFailedBranch && progress.failedStage !== undefined ? { failedStage: progress.failedStage } : {}),
      },
    };
  });
  return {
    ...base,
    branches,
    partialSuccess: {
      possible: true,
      successfulParents: progress.successfulParents,
      successfulChunks: progress.successfulChunks,
      ...(failedBranch ? { failedBranch } : {}),
      ...(progress.retryAttempted !== undefined ? { retryAttempted: progress.retryAttempted } : {}),
    },
  };
}

export function buildStaticApplyDiagnostic(
  statement: UpdateStatement | InsertStatement | UpsertStatement,
  dmlMaxRows: number,
  dmlMaxSubtableRows: number
): ApplyDiagnostic {
  if (statement.type === "UPDATE") {
    return diagnostic("UPDATE", [staticBranch(
      "update", statement.applyBlocks ?? [], null, true, dmlMaxRows, dmlMaxSubtableRows
    )]);
  }
  if (statement.type === "INSERT") {
    return diagnostic("INSERT", [staticBranch(
      "insert", statement.applyBlocks ?? [], statement.values.length, false, dmlMaxRows, dmlMaxSubtableRows
    )]);
  }
  return diagnostic("UPSERT", [
    staticBranch("insert", statement.onInsertApplyBlocks ?? [], null, false, dmlMaxRows, dmlMaxSubtableRows),
    staticBranch("update", statement.onUpdateApplyBlocks ?? [], null, true, dmlMaxRows, dmlMaxSubtableRows),
  ]);
}

function diagnostic(
  statementKind: ApplyDiagnosticStatementKind,
  branches: readonly ApplyDiagnosticBranch[]
): ApplyDiagnostic {
  return {
    statementKind,
    branches,
    nonTransactional: true,
    partialSuccess: { possible: true },
  };
}

function buildPreparedInsertBranch(prepared: PreparedApplyInsert): ApplyDiagnosticBranch {
  const targets = new Map<string, ApplyDiagnosticTarget>();
  if (prepared.applyBlocks) {
    for (const block of prepared.applyBlocks) {
      const operations = block.operations.map((operation): ApplyDiagnosticOperation => {
        if (operation.kind !== "APPEND") {
          throw new Error(`InternalError: prepared APPLY INSERT contains ${operation.kind}.`);
        }
        const addedRows = operation.values.length * prepared.guards.parentRows;
        return { kind: "APPEND", count: addedRows, addedRows };
      });
      targets.set(block.field, {
        targetKind: block.targetKind,
        field: block.field,
        operations,
        changedCount: operations.reduce((sum, operation) => sum + (operation.addedRows ?? 0), 0),
      });
    }
  } else {
    // Compatibility for internal writer fixtures constructed before Phase 16a.
    for (const candidate of prepared.candidates) {
      for (const table of candidate.tables) {
        const current = targets.get(table.table);
        const addedRows = (current?.operations[0]?.addedRows ?? 0) as number;
        targets.set(table.table, {
          targetKind: "SUBTABLE",
          field: table.table,
          operations: [{ kind: "APPEND", count: addedRows + table.addedRows, addedRows: addedRows + table.addedRows }],
          changedCount: (current?.changedCount ?? 0) + table.addedRows,
        });
      }
    }
  }
  return {
    branch: "insert",
    parentRows: prepared.guards.parentRows,
    targets: [...targets.values()],
    guards: prepared.guards,
    chunk: { size: 100, plannedChunks: prepared.batches.length },
    deletedParentRows: 0,
  };
}

function buildPreparedUpdateBranch(prepared: PreparedApplyWrite): ApplyDiagnosticBranch {
  const targets = new Map<string, ApplyDiagnosticTarget>();
  let deletedParentRows = 0;
  for (const plan of prepared.plans) {
    let parentHasDeletes = false;
    for (const table of plan.tables) {
      const current = targets.get(table.table);
      targets.set(table.table, {
        targetKind: "SUBTABLE",
        field: table.table,
        operations: mergeOperations(current?.operations, table.operations.map((operation) => ({
          ...operation,
          count: operation.kind === "PATCH" ? operation.changedRows
            : operation.kind === "APPEND" ? operation.addedRows : operation.removedRows,
        }))),
        changedCount: (current?.changedCount ?? 0)! + table.changedSubtableRows,
      });
      parentHasDeletes ||= table.deletedRows > 0;
    }
    for (const field of plan.multiValues) {
      const current = targets.get(field.field);
      const postImage = { parentId: plan.parentId, value: field.postImageValue };
      targets.set(field.field, {
        targetKind: "MULTI_VALUE",
        field: field.field,
        fieldType: field.fieldType,
        operations: mergeOperations(current?.operations, field.operations.map((operation) => ({
          kind: operation.kind,
          value: operation.value,
          count: operation.changed ? 1 : 0,
          changed: operation.changed,
        }))),
        changedCount: (current?.changedCount ?? 0)! + field.changedValues,
        postImages: [...(current?.postImages ?? []), postImage],
      });
    }
    if (parentHasDeletes) deletedParentRows += 1;
  }
  return {
    branch: "update",
    parentRows: prepared.guards.parentRows,
    targets: [...targets.values()],
    guards: prepared.guards,
    chunk: { size: 100, plannedChunks: Math.ceil(prepared.records.length / 100) },
    deletedParentRows,
  };
}

function mergeOperations(
  current: readonly ApplyDiagnosticOperation[] | undefined,
  next: readonly ApplyDiagnosticOperation[]
): ApplyDiagnosticOperation[] {
  if (!current) return next.map((operation) => ({ ...operation }));
  return next.map((operation, index) => {
    const previous = current[index];
    if (!previous || previous.kind !== operation.kind || previous.value !== operation.value) {
      throw new Error("InternalError: APPLY diagnostic operation shape differs between parents.");
    }
    return {
      ...operation,
      ...(previous.changed !== undefined ? { changed: previous.changed } : {}),
      count: addNullable(previous.count, operation.count),
      ...(operation.matchedRows !== undefined
        ? { matchedRows: addNullable(previous.matchedRows, operation.matchedRows) } : {}),
      ...(operation.changedRows !== undefined
        ? { changedRows: addNullable(previous.changedRows, operation.changedRows) } : {}),
      ...(operation.addedRows !== undefined
        ? { addedRows: addNullable(previous.addedRows, operation.addedRows) } : {}),
      ...(operation.removedRows !== undefined
        ? { removedRows: addNullable(previous.removedRows, operation.removedRows) } : {}),
    };
  });
}

function addNullable(left: number | null | undefined, right: number | null): number | null {
  return left === null || left === undefined || right === null ? null : left + right;
}

function staticBranch(
  branch: ApplyDiagnosticBranchKind,
  blocks: readonly ApplyBlock[],
  parentRows: number | null,
  revisionRequired: boolean,
  dmlMaxRows: number,
  dmlMaxSubtableRows: number
): ApplyDiagnosticBranch {
  const targets: ApplyDiagnosticTarget[] = blocks.map((block) => {
    const operations = block.operations.map((operation) => staticOperation(operation, parentRows));
    const changedCount = operations.every((operation) => operation.count !== null)
      ? operations.reduce((sum, operation) => sum + operation.count!, 0)
      : null;
    return {
      targetKind: block.targetKind,
      field: block.field,
      operations,
      changedCount,
    };
  });
  const subtableTargets = targets.filter((target) => target.targetKind === "SUBTABLE");
  const subtableRows = subtableTargets.every((target) => target.changedCount !== null)
    ? subtableTargets.reduce((sum, target) => sum + target.changedCount!, 0)
    : null;
  const wouldExceed = parentRows === null || subtableRows === null
    ? null
    : parentRows > dmlMaxRows || subtableRows > dmlMaxSubtableRows;
  return {
    branch,
    parentRows,
    targets,
    guards: {
      revisionRequired,
      parentRows,
      dmlMaxRows,
      subtableRows,
      dmlMaxSubtableRows,
      wouldExceed,
    },
    chunk: { size: 100, plannedChunks: parentRows === null ? null : Math.ceil(parentRows / 100) },
    deletedParentRows: branch === "insert" ? 0 : null,
  };
}

function staticOperation(operation: ApplyOperation, parentRows: number | null): ApplyDiagnosticOperation {
  if (operation.kind === "APPEND") {
    const addedRows = parentRows === null ? null : operation.values.length * parentRows;
    return { kind: operation.kind, count: addedRows, addedRows };
  }
  if (operation.kind === "PATCH") return { kind: operation.kind, count: null, matchedRows: null, changedRows: null };
  if (operation.kind === "REMOVE") return { kind: operation.kind, count: null, removedRows: null };
  return { kind: operation.kind, value: operation.value, count: null };
}
