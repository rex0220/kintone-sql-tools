import type { BatchExecuteResult } from "../../execute";
import { buildBatchEnvelope } from "../batchEnvelope";

test("VALIDATION result set は optional apply/guards を伝播する", () => {
  const batch = {
    ok: true,
    statementCount: 1,
    statements: [{
      index: 0, type: "UPDATE", status: "success",
      result: {
        type: "VALIDATION", operation: "UPDATE", validatedRows: 1, validRows: 1,
        invalidRows: 0, errorCount: 0, columns: [], errors: [],
        apply: [{
          field: "テーブル", operations: [{ kind: "PATCH", matchedRows: 2, changedRows: 2 }],
          changedSubtableRows: 2, deletedRows: 0,
        }],
        guards: {
          revisionRequired: true, parentRows: 1, dmlMaxRows: 100,
          subtableRows: 2, dmlMaxSubtableRows: 500, wouldExceed: false,
        },
        applyBranches: {
          create: { apply: [], guards: { revisionRequired: false, parentRows: 0, dmlMaxRows: 100, subtableRows: 0, dmlMaxSubtableRows: 500, wouldExceed: false } },
          update: { apply: [], guards: { revisionRequired: true, parentRows: 1, dmlMaxRows: 100, subtableRows: 2, dmlMaxSubtableRows: 500, wouldExceed: false } },
        },
        diagnostic: {
          statementKind: "UPDATE", nonTransactional: true, partialSuccess: { possible: true },
          branches: [{
            branch: "update", parentRows: 1, deletedParentRows: 0,
            targets: [{ targetKind: "SUBTABLE", field: "テーブル", changedCount: 2,
              operations: [{ kind: "PATCH", count: 2, matchedRows: 2, changedRows: 2 }] }],
            guards: { revisionRequired: true, parentRows: 1, dmlMaxRows: 100, subtableRows: 2, dmlMaxSubtableRows: 500, wouldExceed: false },
            chunk: { size: 100, plannedChunks: 1 },
          }],
        },
        deletedRows: { total: 0, parentRows: 0 },
      },
    }],
  } as unknown as BatchExecuteResult;
  expect(buildBatchEnvelope(batch).results[0]).toMatchObject({
    apply: [{ operations: [{ matchedRows: 2, changedRows: 2 }] }],
    guards: { dmlMaxSubtableRows: 500, wouldExceed: false },
    deletedRows: { total: 0, parentRows: 0 },
    applyBranches: { update: { guards: { parentRows: 1 } } },
    diagnostic: { statementKind: "UPDATE", branches: [{ branch: "update" }] },
  });
});

test("既存 VALIDATION result set は apply/guards key を追加しない", () => {
  const batch = {
    ok: true,
    statementCount: 1,
    statements: [{
      index: 0, type: "INSERT", status: "success",
      result: {
        type: "VALIDATION", operation: "INSERT", validatedRows: 1, validRows: 1,
        invalidRows: 0, errorCount: 0, columns: [], errors: [],
      },
    }],
  } as unknown as BatchExecuteResult;
  const result = buildBatchEnvelope(batch).results[0];
  expect(result).not.toHaveProperty("apply");
  expect(result).not.toHaveProperty("guards");
});

test("複数親 APPLY UPDATE の成功進捗を statement summary へ伝播する", () => {
  const batch = {
    ok: true,
    statementCount: 1,
    statements: [{
      index: 0, type: "UPDATE", status: "success",
      result: {
        type: "UPDATE", updatedCount: 101,
        successfulChunks: 2, successfulParents: 101, nonTransactional: true,
      },
    }],
  } as unknown as BatchExecuteResult;
  expect(buildBatchEnvelope(batch).statements[0]).toMatchObject({
    updatedCount: 101,
    successfulChunks: 2,
    successfulParents: 101,
    nonTransactional: true,
  });
});

test("既存 UPDATE は APPLY progress key を追加しない", () => {
  const batch = {
    ok: true,
    statementCount: 1,
    statements: [{
      index: 0, type: "UPDATE", status: "success",
      result: { type: "UPDATE", updatedCount: 1 },
    }],
  } as unknown as BatchExecuteResult;
  const statement = buildBatchEnvelope(batch).statements[0];
  expect(statement).not.toHaveProperty("successfulChunks");
  expect(statement).not.toHaveProperty("successfulParents");
  expect(statement).not.toHaveProperty("nonTransactional");
});

test("UPSERT APPLY envelopeはbranch別を含む成功進捗を保持する", () => {
  const batch = {
    ok: true,
    statementCount: 1,
    statements: [{
      index: 0, type: "UPSERT", status: "success",
      result: {
        type: "UPSERT", insertedCount: 101, updatedCount: 1,
        successfulChunks: 3, successfulParents: 102,
        successfulInsertChunks: 2, successfulUpdateChunks: 1,
        nonTransactional: true,
      },
    }],
  } as unknown as BatchExecuteResult;
  expect(buildBatchEnvelope(batch).statements[0]).toMatchObject({
    insertedCount: 101,
    updatedCount: 1,
    successfulChunks: 3,
    successfulParents: 102,
    successfulInsertChunks: 2,
    successfulUpdateChunks: 1,
    nonTransactional: true,
  });
});
