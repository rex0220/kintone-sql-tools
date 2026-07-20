import { applyPatchPlanToKintone } from "../../converter/applyPatchToKintone";
import type { PreparedApplyWrite } from "../applyPatchPrepare";
import type { ApplyPatchPlan } from "../applyPatchPlanner";
import {
  ApplyWritePartialFailureError,
  executePreparedApplyWrite,
} from "../applyPatchExecutePrepared";

function plan(parentId: number): ApplyPatchPlan {
  return {
    app: 4221,
    parentId,
    revision: parentId + 100,
    parentRows: 1,
    changedSubtableRows: 0,
    parentValues: { 親: { value: `after-${parentId}` } },
    postImage: { 親: { value: `after-${parentId}` } },
    tables: [],
  };
}

function prepared(count: number): PreparedApplyWrite {
  const plans = Array.from({ length: count }, (_, index) => plan(index + 1));
  return {
    plans,
    records: plans.flatMap((item) => applyPatchPlanToKintone(item).records),
    validations: [],
    guards: {
      revisionRequired: true,
      parentRows: count,
      dmlMaxRows: Math.max(1, count),
      subtableRows: 0,
      dmlMaxSubtableRows: 1,
      wouldExceed: false,
    },
  };
}

test("internal writeは全prepared chunkを順にPUTし成功件数を返す", async () => {
  const putRecords = jest.fn(async (
    _batch: Parameters<Parameters<typeof executePreparedApplyWrite>[1]["putRecords"]>[0]
  ) => undefined);
  await expect(executePreparedApplyWrite(prepared(201), { putRecords })).resolves.toEqual({
    type: "UPDATE",
    updatedCount: 201,
    successfulChunks: 3,
    successfulParents: 201,
    nonTransactional: true,
  });
  expect(putRecords.mock.calls.map(([batch]) => batch.records.length)).toEqual([100, 100, 1]);
});

test("2nd chunk conflictは先行100親を部分成功として保持しGET/PUT retryしない", async () => {
  const getRecords = jest.fn();
  const planning = jest.fn();
  const validation = jest.fn();
  const conflict = new Error("GAIA_CO02: revision conflict");
  const putRecords = jest.fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(conflict);
  const input = Object.assign(prepared(201), { planning, validation });
  const client = { putRecords, getRecords };

  let caught: unknown;
  try {
    await executePreparedApplyWrite(input, client);
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(ApplyWritePartialFailureError);
  expect(caught).toMatchObject({
    cause: conflict,
    partialSuccess: {
      successfulChunks: 1,
      successfulParents: 100,
      failedChunkIndex: 1,
      failedStage: "PUT_CHUNK",
      nonTransactional: true,
      retryAttempted: false,
    },
  });
  expect((caught as Error).message).toContain("writes are non-transactional and were not retried");
  expect(putRecords).toHaveBeenCalledTimes(2);
  expect(getRecords).not.toHaveBeenCalled();
  expect(planning).not.toHaveBeenCalled();
  expect(validation).not.toHaveBeenCalled();
});

test("1st chunk failureも成功0件を握りつぶさずpartial-success型で表す", async () => {
  const putRecords = jest.fn(async () => { throw new Error("CB_VA01"); });
  await expect(executePreparedApplyWrite(prepared(1), { putRecords })).rejects.toMatchObject({
    partialSuccess: {
      successfulChunks: 0,
      successfulParents: 0,
      failedChunkIndex: 0,
      failedStage: "PUT_CHUNK",
    },
  });
  expect(putRecords).toHaveBeenCalledTimes(1);
});
