import type { KintoneRecord } from "../../converter/dmlToKintone";
import type { PreparedApplyInsert } from "../applyInsertPrepare";
import { executePreparedApplyInsert } from "../applyInsertExecutePrepared";
import { ApplyWritePartialFailureError } from "../applyPatchExecutePrepared";

function prepared(count: number): PreparedApplyInsert {
  const records = Array.from({ length: count }, (_, index): KintoneRecord => ({
    親: { value: `parent-${index + 1}` },
  }));
  const batches = [];
  for (let index = 0; index < records.length; index += 100) {
    batches.push({ app: 4221, records: records.slice(index, index + 100) });
  }
  return {
    candidates: [],
    records,
    batches,
    validations: [],
    guards: {
      revisionRequired: false,
      parentRows: count,
      dmlMaxRows: Math.max(1, count),
      subtableRows: 0,
      dmlMaxSubtableRows: 1,
      wouldExceed: false,
    },
  };
}

test.each([
  [0, []],
  [100, [100]],
  [101, [100, 1]],
  [201, [100, 100, 1]],
] as const)("internal INSERT writeは%i親を100件chunkで逐次POSTする", async (count, sizes) => {
  let nextId = 1;
  const postRecords = jest.fn(async (
    batch: Parameters<Parameters<typeof executePreparedApplyInsert>[1]["postRecords"]>[0]
  ) => ({ ids: batch.records.map(() => String(nextId++)) }));
  let expectedId = 1;
  const createdIds = sizes.map((size) =>
    Array.from({ length: size }, () => String(expectedId++))
  );

  await expect(executePreparedApplyInsert(prepared(count), { postRecords })).resolves.toEqual({
    type: "INSERT",
    createdIds,
    insertedCount: count,
    successfulChunks: sizes.length,
    successfulParents: count,
    nonTransactional: true,
  });
  expect(postRecords.mock.calls.map(([batch]) => batch.records.length)).toEqual(sizes);
});

test("2nd POST失敗は先行100親を保持しplanning/validation/GET/retryへ到達しない", async () => {
  const planning = jest.fn();
  const validation = jest.fn();
  const getRecords = jest.fn();
  const failure = new Error("CB_VA01: invalid record");
  const postRecords = jest.fn()
    .mockResolvedValueOnce({ ids: Array.from({ length: 100 }, (_, index) => String(index + 1)) })
    .mockRejectedValueOnce(failure);
  const input = Object.assign(prepared(201), { planning, validation });
  const client = { postRecords, getRecords };

  let caught: unknown;
  try {
    await executePreparedApplyInsert(input, client);
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(ApplyWritePartialFailureError);
  expect(caught).toMatchObject({
    cause: failure,
    partialSuccess: {
      successfulChunks: 1,
      successfulParents: 100,
      failedChunkIndex: 1,
      failedStage: "POST_CHUNK",
      nonTransactional: true,
      retryAttempted: false,
    },
  });
  expect((caught as Error).message).toContain("APPLY POST chunk 2 failed");
  expect(postRecords).toHaveBeenCalledTimes(2);
  expect(getRecords).not.toHaveBeenCalled();
  expect(planning).not.toHaveBeenCalled();
  expect(validation).not.toHaveBeenCalled();
});
