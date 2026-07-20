import type {
  KintonePostParams,
  KintonePutParams,
  KintoneRecord,
  KintoneUpdateRecord,
} from "../../converter/dmlToKintone";
import { ApplyWritePartialFailureError } from "../applyPatchExecutePrepared";
import { executePreparedApplyUpsert } from "../applyUpsertExecutePrepared";
import type { PreparedApplyUpsert } from "../applyUpsertPrepare";

function prepared(createCount: number, updateCount: number): PreparedApplyUpsert {
  const creates: KintoneRecord[] = Array.from({ length: createCount }, (_, index) => ({
    key: { value: `new-${index}` },
  }));
  const updates: KintoneUpdateRecord[] = Array.from({ length: updateCount }, (_, index) => ({
    id: index + 1,
    revision: index + 10,
    record: { key: { value: `old-${index}` } },
  }));
  const chunk = <T>(records: readonly T[]) => Array.from(
    { length: Math.ceil(records.length / 100) },
    (_, index) => ({ app: 4221, records: records.slice(index * 100, index * 100 + 100) })
  );
  return {
    createBatches: chunk(creates),
    updateBatches: chunk(updates),
  } as unknown as PreparedApplyUpsert;
}

test.each([
  ["all create", 201, 0, ["POST:100", "POST:100", "POST:1"]],
  ["all update", 0, 201, ["PUT:100", "PUT:100", "PUT:1"]],
  ["mixed", 101, 101, ["POST:100", "POST:1", "PUT:100", "PUT:1"]],
] as const)("PreparedApplyUpsert writer: %sを100件chunkでPOST→PUTする", async (
  _label, createCount, updateCount, expectedOrder
) => {
  const calls: string[] = [];
  const postRecords = jest.fn(async (batch: KintonePostParams) => {
    calls.push(`POST:${batch.records.length}`);
    return { ids: batch.records.map((_record, index) => String(index + 1)) };
  });
  const putRecords = jest.fn(async (batch: KintonePutParams) => {
    calls.push(`PUT:${batch.records.length}`);
  });

  await expect(executePreparedApplyUpsert(prepared(createCount, updateCount), {
    postRecords,
    putRecords,
  })).resolves.toMatchObject({
    type: "UPSERT",
    insertedCount: createCount,
    updatedCount: updateCount,
    successfulChunks: expectedOrder.length,
    successfulParents: createCount + updateCount,
    nonTransactional: true,
  });
  expect(calls).toEqual(expectedOrder);
});

test("POST完了後のUPDATE 2nd chunk失敗はinsert全件とupdate成功prefixを共通partial-success型へ保持しretryしない", async () => {
  const conflict = new Error("GAIA_CO02: revision conflict");
  const postRecords = jest.fn(async (batch: KintonePostParams) => ({
    ids: batch.records.map((_record, index) => String(index + 1)),
  }));
  const putRecords = jest.fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(conflict);
  let caught: unknown;

  try {
    await executePreparedApplyUpsert(prepared(101, 201), { postRecords, putRecords });
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(ApplyWritePartialFailureError);
  expect(caught).toMatchObject({
    cause: conflict,
    partialSuccess: {
      successfulChunks: 3,
      successfulParents: 201,
      successfulInserts: 101,
      successfulUpdates: 100,
      failedChunkIndex: 1,
      failedBranch: "UPDATE",
      failedStage: "PUT_CHUNK",
      nonTransactional: true,
      retryAttempted: false,
    },
  });
  expect(postRecords).toHaveBeenCalledTimes(2);
  expect(putRecords).toHaveBeenCalledTimes(2);
});

test("writer client capabilityはPOST/PUTだけでplanning/validation/GETを受け取らない", async () => {
  type WriterClient = Parameters<typeof executePreparedApplyUpsert>[1];
  type ExtraKeys = Exclude<keyof WriterClient, "postRecords" | "putRecords">;
  const hasOnlyWriteKeys: ExtraKeys extends never ? true : false = true;
  const client: WriterClient = {
    postRecords: async () => ({ ids: [] }),
    putRecords: async () => undefined,
  };
  expect(hasOnlyWriteKeys).toBe(true);
  expect(Object.keys(client).sort()).toEqual(["postRecords", "putRecords"]);
  await expect(executePreparedApplyUpsert(prepared(0, 0), client)).resolves.toMatchObject({
    insertedCount: 0,
    updatedCount: 0,
  });
});
