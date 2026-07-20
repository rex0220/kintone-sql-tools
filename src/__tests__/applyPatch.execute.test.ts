import { execute, executeBatch, type KintoneClient, type KintoneFieldInfo, type SelectResult } from "../execute";
import type { KintonePostParams, KintonePutParams, KintoneRecord } from "../converter/dmlToKintone";
import { ApplyWritePartialFailureError } from "../core/applyPatchExecutePrepared";
import { buildBatchEnvelope } from "../output/batchEnvelope";

const fieldInfos: KintoneFieldInfo[] = [
  { code: "親", label: "親", fieldType: "SINGLE_LINE_TEXT", writable: true },
  { code: "親数値", label: "親数値", fieldType: "NUMBER", writable: true },
  { code: "添付", label: "添付", fieldType: "FILE", writable: true },
  { code: "作成者", label: "作成者", fieldType: "CREATOR", writable: false },
  { code: "テーブル", label: "テーブル", fieldType: "SUBTABLE", writable: false },
  { code: "子", label: "子", fieldType: "SINGLE_LINE_TEXT", writable: true, inSubtable: true, subtableCode: "テーブル" },
  { code: "子添付", label: "子添付", fieldType: "FILE", writable: true, inSubtable: true, subtableCode: "テーブル" },
  { code: "別表", label: "別表", fieldType: "SUBTABLE", writable: false },
  { code: "別子", label: "別子", fieldType: "SINGLE_LINE_TEXT", writable: true, inSubtable: true, subtableCode: "別表" },
];

function parent(id = "8", childCount = 1): KintoneRecord {
  return {
    "$id": { value: id },
    "$revision": { value: "3" },
    親: { value: "before" },
    親数値: { value: "1" },
    テーブル: { value: Array.from({ length: childCount }, (_, index) => ({
      id: String(101 + index),
      value: { 子: { value: "old" }, 子添付: { value: [{ fileKey: "opaque" }] } },
    })) },
    別表: { value: [] },
  } as unknown as KintoneRecord;
}

function makeClient(records: KintoneRecord[], infos = fieldInfos) {
  const getRecords = jest.fn(async () => ({ records }));
  const putRecords = jest.fn(async (_params: KintonePutParams) => undefined);
  const openCursor = jest.fn(async () => { throw new Error("unexpected cursor"); });
  const postRecords = jest.fn(async (_params: KintonePostParams): Promise<{ ids: string[] }> => {
    throw new Error("unexpected post");
  });
  const deleteRecords = jest.fn(async () => { throw new Error("unexpected delete"); });
  const getFields = jest.fn(async () => infos);
  const getNumberPrecision = jest.fn(async () => ({ digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const }));
  const client: KintoneClient = {
    getRecords,
    openCursor,
    postRecords,
    putRecords,
    deleteRecords,
    getApps: async () => [],
    getFields,
    getNumberPrecision,
    getProcessStatuses: async () => ({ enable: false, states: [] }),
  };
  return { client, getRecords, openCursor, postRecords, putRecords, deleteRecords, getFields, getNumberPrecision };
}

const sql = "UPDATE APP4221 SET 親 = 'after' WHERE $id = 8 " +
  "APPLY テーブル (PATCH SET 子 = 'patched' WHERE _rid = '101')";

const insertApplySql = "INSERT INTO APP4221 (親) VALUES ('new') "
  + "APPLY テーブル (APPEND (子) VALUES ('child'))";

const upsertApplySql = "UPSERT INTO APP4221 (親) VALUES ('new'), ('old') ON DUPLICATE (親) "
  + "ON INSERT APPLY テーブル (APPEND (子) VALUES ('initial')) "
  + "ON UPDATE APPLY テーブル (PATCH SET 子='patched' WHERE 子='old')";

const multiApplySql = "UPDATE APP4221 SET 親='after' WHERE $id=8 "
  + "APPLY タグ (REMOVE 'A'; ADD 'C') APPLY 担当 (REMOVE 'u1'; ADD 'u3')";

const multiFieldInfos: KintoneFieldInfo[] = [
  ...fieldInfos,
  { code: "タグ", label: "タグ", fieldType: "MULTI_SELECT", writable: true, optionOrder: { A: 0, B: 1, C: 2 } },
  { code: "担当", label: "担当", fieldType: "USER_SELECT", writable: true },
];

function multiParent(): KintoneRecord {
  return {
    ...parent(),
    タグ: { value: ["A", "B"] },
    担当: { value: [{ code: "u1", name: "User 1" }, { code: "u2", name: "User 2" }] },
  } as unknown as KintoneRecord;
}

test("Phase 15b: 多値ADD/REMOVEをrevision付き1親1PUTへ接続し、確認detailはprepared post-imageを渡す", async () => {
  const mock = makeClient([multiParent()], multiFieldInfos);
  const confirm = jest.fn(async () => true);
  const result = await execute(multiApplySql, mock.client, {
    cacheContext: "apply-phase15b-multi-single",
    allowApplyMutation: true,
    confirm,
  });
  expect(result).toMatchObject({ type: "UPDATE", updatedCount: 1 });
  expect(mock.putRecords).toHaveBeenCalledWith({
    app: 4221,
    records: [{
      id: 8,
      revision: 3,
      record: {
        親: { value: "after" },
        タグ: { value: ["B", "C"] },
        担当: { value: [{ code: "u2" }, { code: "u3" }] },
      },
    }],
  });
  expect(confirm).toHaveBeenCalledWith(1, "UPDATE", expect.objectContaining({
    applyDetail: expect.objectContaining({
      tables: [],
      multiValues: [
        expect.objectContaining({ field: "タグ", addedValues: 1, removedValues: 1,
          parents: [{ parentId: 8, postImage: ["B", "C"] }] }),
        expect.objectContaining({ field: "担当", addedValues: 1, removedValues: 1,
          parents: [{ parentId: 8, postImage: [{ code: "u2" }, { code: "u3" }] }] }),
      ],
    }),
  }));
});

test("Phase 15b: VALIDATE ONLYは多値post-image/検証診断を返しPUTしない", async () => {
  const mock = makeClient([multiParent()], multiFieldInfos);
  const result = await execute(`${multiApplySql} VALIDATE ONLY`, mock.client, {
    cacheContext: "apply-phase15b-multi-validate",
  });
  expect(result).toMatchObject({
    type: "VALIDATION", operation: "UPDATE", validatedRows: 1, errorCount: 0,
    apply: [
      { field: "タグ", multiValue: { fieldType: "MULTI_SELECT", addedValues: 1, removedValues: 1,
        postImages: [{ parentId: 8, value: ["B", "C"] }] } },
      { field: "担当", multiValue: { fieldType: "USER_SELECT", addedValues: 1, removedValues: 1,
        postImages: [{ parentId: 8, value: [{ code: "u2" }, { code: "u3" }] }] } },
    ],
  });
  expect(mock.putRecords).not.toHaveBeenCalled();
});

test("Phase 15b: SUBTABLEと多値APPLYを同一文の同じPUT recordへ共存させる", async () => {
  const mock = makeClient([multiParent()], multiFieldInfos);
  await execute(
    "UPDATE APP4221 SET 親='after' WHERE $id=8 "
      + "APPLY タグ (ADD 'C') APPLY テーブル (PATCH SET 子='patched' ALL ROWS)",
    mock.client,
    { cacheContext: "apply-phase15b-mixed", allowApplyMutation: true }
  );
  expect(mock.putRecords).toHaveBeenCalledWith(expect.objectContaining({ records: [expect.objectContaining({
    record: expect.objectContaining({
      親: { value: "after" }, タグ: { value: ["A", "B", "C"] },
      テーブル: { value: [{ id: "101", value: { 子: { value: "patched" } } }] },
    }),
  })] }));
});

test("Phase 15b: 多値の複数親を独立post-imageで100件chunkし、後続失敗をpartial-success型で返す", async () => {
  const records = Array.from({ length: 101 }, (_, index) => ({
    ...multiParent(),
    "$id": { value: String(index + 1) },
    "$revision": { value: String(index + 10) },
    タグ: { value: index % 2 === 0 ? ["A"] : ["B"] },
  })) as unknown as KintoneRecord[];
  const mock = makeClient(records, multiFieldInfos);
  mock.putRecords.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("revision conflict"));
  const promise = execute(
    "UPDATE APP4221 SET 親='after' WHERE 親='before' APPLY タグ (REMOVE 'A'; ADD 'C')",
    mock.client,
    { cacheContext: "apply-phase15b-multi-partial", allowApplyMutation: true, dmlMaxRows: 101 }
  );
  await expect(promise).rejects.toMatchObject({
    partialSuccess: {
      successfulChunks: 1,
      successfulParents: 100,
      failedChunkIndex: 1,
      failedStage: "PUT_CHUNK",
      retryAttempted: false,
    },
  });
  expect(mock.putRecords.mock.calls.map(([batch]) => batch.records.length)).toEqual([100, 1]);
  expect(mock.putRecords.mock.calls[0][0].records[0].record.タグ).toEqual({ value: ["C"] });
  expect(mock.putRecords.mock.calls[0][0].records[1].record.タグ).toEqual({ value: ["B", "C"] });
  expect(mock.getRecords).toHaveBeenCalledTimes(1);
});

function upsertParent(id: number, key: string): KintoneRecord {
  const record = parent(String(id));
  record.親 = { value: key };
  return record;
}

test("Phase 14c: allowApplyMutationなしのUPSERT APPLYはexecute/batchでAPI 0 fail-closed", async () => {
  const single = makeClient([]);
  await expect(execute(upsertApplySql, single.client, { cacheContext: "apply-phase14c-upsert-closed" }))
    .rejects.toThrow("UnsupportedError: APPLY mutation requires allowApplyMutation=true");
  for (const api of [single.getFields, single.getRecords, single.openCursor, single.postRecords, single.putRecords]) {
    expect(api).not.toHaveBeenCalled();
  }

  const batch = makeClient([]);
  await expect(executeBatch(
    upsertApplySql,
    batch.client,
    { cacheContext: "apply-phase14c-upsert-batch-closed" }
  )).rejects.toThrow("UnsupportedError: APPLY mutation requires allowApplyMutation=true");
  for (const api of [batch.getFields, batch.getRecords, batch.openCursor, batch.postRecords, batch.putRecords]) {
    expect(api).not.toHaveBeenCalled();
  }
});

test.each([
  ["all create", [], 2, 0],
  ["all update", [upsertParent(8, "new"), upsertParent(9, "old")], 0, 2],
  ["mixed", [upsertParent(9, "old")], 1, 1],
] as const)("Phase 14c: UPSERT APPLY core %sをprepare後POST→PUTで実行する", async (
  _label, records, insertedCount, updatedCount
) => {
  const mock = makeClient([...records]);
  mock.postRecords.mockImplementation(async (batch) => ({
    ids: batch.records.map((_record, index) => String(index + 100)),
  }));
  const result = await execute(upsertApplySql, mock.client, {
    cacheContext: `apply-phase14c-upsert-${_label}`,
    allowApplyMutation: true,
    dmlMaxRows: 2,
    dmlMaxSubtableRows: 2,
  });
  expect(result).toMatchObject({
    type: "UPSERT",
    insertedCount,
    updatedCount,
    successfulParents: 2,
    nonTransactional: true,
  });
  expect(mock.postRecords).toHaveBeenCalledTimes(insertedCount > 0 ? 1 : 0);
  expect(mock.putRecords).toHaveBeenCalledTimes(updatedCount > 0 ? 1 : 0);
  if (insertedCount > 0 && updatedCount > 0) {
    expect(mock.postRecords.mock.invocationCallOrder[0]).toBeLessThan(mock.putRecords.mock.invocationCallOrder[0]);
  }
});

test("Phase 14c: UPSERT APPLY confirmはprepared済みinsert/update内訳を1回だけ渡しwrite前に完了する", async () => {
  const mock = makeClient([upsertParent(9, "old")]);
  mock.postRecords.mockResolvedValue({ ids: ["100"] });
  const confirm = jest.fn(async () => true);
  await expect(execute(upsertApplySql, mock.client, {
    cacheContext: "apply-phase14c-upsert-confirm",
    allowApplyMutation: true,
    dmlMaxRows: 2,
    dmlMaxSubtableRows: 2,
    confirm,
  })).resolves.toMatchObject({ type: "UPSERT", insertedCount: 1, updatedCount: 1 });
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(confirm).toHaveBeenCalledWith(2, "UPDATE", expect.objectContaining({
    statementType: "UPSERT",
    applyDetail: expect.objectContaining({
      kind: "APPLY_UPSERT",
      parentRows: 2,
      insertedParentRows: 1,
      initialSubtableRows: 1,
      updatedParentRows: 1,
      revisionRequired: true,
      nonTransactional: true,
      partialSuccessPossible: true,
      applyBranches: {
        insert: expect.objectContaining({ parentRows: 1, initialSubtableRows: 1 }),
        update: expect.objectContaining({ parentRows: 1, changedSubtableRows: 1 }),
      },
    }),
  }));
  expect(confirm.mock.invocationCallOrder[0]).toBeLessThan(mock.postRecords.mock.invocationCallOrder[0]);
  expect(confirm.mock.invocationCallOrder[0]).toBeLessThan(mock.putRecords.mock.invocationCallOrder[0]);
});

test("Phase 14c: create全件後のupdate 2nd chunk失敗を公開errorとbatch envelopeへ伝播しfail-fastする", async () => {
  const updates = Array.from({ length: 101 }, (_, index) => upsertParent(index + 1, `u${index}`));
  const values = [
    ...Array.from({ length: 101 }, (_, index) => `('n${index}')`),
    ...Array.from({ length: 101 }, (_, index) => `('u${index}')`),
  ].join(", ");
  const sql = `UPSERT INTO APP4221 (親) VALUES ${values} ON DUPLICATE (親) `
    + "ON INSERT APPLY テーブル (APPEND (子) VALUES ('initial')) "
    + "ON UPDATE APPLY テーブル (PATCH SET 子='patched' WHERE 子='old')";
  const mock = makeClient(updates);
  mock.postRecords.mockImplementation(async (batch) => ({ ids: batch.records.map((_record, index) => String(index + 1)) }));
  mock.putRecords.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("GAIA_CO02"));

  const batch = await executeBatch(`${sql}; INSERT INTO APP4221 (親) VALUES ('later')`, mock.client, {
    cacheContext: "apply-phase14c-upsert-partial",
    allowApplyMutation: true,
    dmlMaxRows: 202,
    dmlMaxSubtableRows: 202,
  });
  expect(batch.statements[0]).toMatchObject({ status: "error", error: {
    code: "ApplyWritePartialFailureError",
    partialSuccess: {
      successfulParents: 201,
      successfulInserts: 101,
      successfulUpdates: 100,
      failedChunkIndex: 1,
      failedBranch: "UPDATE",
      failedStage: "PUT_CHUNK",
      retryAttempted: false,
    },
  } });
  expect(batch.statements[1]).toMatchObject({ status: "skipped", skippedReason: "fail-fast" });
  expect(mock.postRecords).toHaveBeenCalledTimes(2);
  expect(mock.putRecords).toHaveBeenCalledTimes(2);
});

test("Phase 14c: UPSERT APPLY batch成功はbranch件数と進捗をenvelopeへ伝播する", async () => {
  const mock = makeClient([upsertParent(9, "old")]);
  mock.postRecords.mockResolvedValue({ ids: ["100"] });
  const batch = await executeBatch(upsertApplySql, mock.client, {
    cacheContext: "apply-phase14c-upsert-batch-success",
    allowApplyMutation: true,
    dmlMaxRows: 2,
    dmlMaxSubtableRows: 2,
  });
  expect(buildBatchEnvelope(batch).statements[0]).toMatchObject({
    status: "success",
    insertedCount: 1,
    updatedCount: 1,
    successfulChunks: 2,
    successfulParents: 2,
    successfulInsertChunks: 1,
    successfulUpdateChunks: 1,
    nonTransactional: true,
  });
});

test("Phase 14c: UPSERT APPLYの合算二重guardはconfirm/write前に拒否する", async () => {
  const mock = makeClient([upsertParent(9, "old")]);
  const confirm = jest.fn(async () => true);
  await expect(execute(upsertApplySql, mock.client, {
    cacheContext: "apply-phase14c-upsert-guard",
    allowApplyMutation: true,
    dmlMaxRows: 1,
    dmlMaxSubtableRows: 2,
    confirm,
  })).rejects.toThrow("ArgumentError: APPLY parent rows (2) exceed dmlMaxRows (1).");
  expect(confirm).not.toHaveBeenCalled();
  expect(mock.postRecords).not.toHaveBeenCalled();
  expect(mock.putRecords).not.toHaveBeenCalled();
});

test("Phase 13c: allowApplyMutationなしのINSERT APPLYはexecute/batchでAPI 0 fail-closed", async () => {
  const single = makeClient([]);
  await expect(execute(insertApplySql, single.client, { cacheContext: "apply-phase13a-insert" }))
    .rejects.toThrow("UnsupportedError: APPLY mutation requires allowApplyMutation=true");
  for (const api of [single.getFields, single.getRecords, single.openCursor, single.postRecords, single.putRecords]) {
    expect(api).not.toHaveBeenCalled();
  }

  const batch = makeClient([]);
  const result = await executeBatch(insertApplySql, batch.client, { cacheContext: "apply-phase13a-insert-batch" });
  expect(result.statements[0]).toMatchObject({
    status: "error",
    error: { message: "UnsupportedError: APPLY mutation requires allowApplyMutation=true" },
  });
  for (const api of [batch.getFields, batch.getRecords, batch.openCursor, batch.postRecords, batch.putRecords]) {
    expect(api).not.toHaveBeenCalled();
  }
});

test("Phase 13c: INSERT APPLYをprepare後confirm 1回からPOSTへ接続し初期子行を作成する", async () => {
  const mock = makeClient([]);
  mock.postRecords.mockImplementation(async (batch) => ({
    ids: batch.records.map((_record, index) => String(index + 1)),
  }));
  const confirm = jest.fn(async () => true);
  const result = await execute(
    "INSERT INTO APP4221 (親) VALUES ('p1'), ('p2') "
      + "APPLY テーブル (APPEND (子) VALUES ('c1'), ('c2'))",
    mock.client,
    { cacheContext: "apply-phase13c-insert-success", allowApplyMutation: true, confirm,
      dmlMaxRows: 2, dmlMaxSubtableRows: 4 }
  );
  expect(result).toMatchObject({
    type: "INSERT", insertedCount: 2, createdIds: [["1", "2"]],
    successfulChunks: 1, successfulParents: 2, nonTransactional: true,
  });
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(confirm).toHaveBeenCalledWith(2, "INSERT", expect.objectContaining({
    applyDetail: {
      kind: "APPLY_INSERT", parentRows: 2, changedSubtableRows: 4, addedSubtableRows: 4,
      tables: [{ table: "テーブル", patchRows: 0, appendRows: 4, removeRows: 0 }],
      deletedRows: 0, deletedParentRows: 0, revisionRequired: false, irreversible: true,
      retryOnRevisionConflict: false, nonTransactional: true, partialSuccessPossible: true,
      insertedParentRows: 2, initialSubtableRows: 4,
    },
  }));
  expect(mock.getFields.mock.invocationCallOrder[0]).toBeLessThan(confirm.mock.invocationCallOrder[0]);
  expect(confirm.mock.invocationCallOrder[0]).toBeLessThan(mock.postRecords.mock.invocationCallOrder[0]);
  expect(mock.postRecords).toHaveBeenCalledWith({ app: 4221, records: [
    { 親: { value: "p1" }, テーブル: { value: [
      { value: { 子: { value: "c1" } } }, { value: { 子: { value: "c2" } } },
    ] } },
    { 親: { value: "p2" }, テーブル: { value: [
      { value: { 子: { value: "c1" } } }, { value: { 子: { value: "c2" } } },
    ] } },
  ] });
  for (const api of [mock.getRecords, mock.openCursor, mock.putRecords, mock.deleteRecords]) {
    expect(api).not.toHaveBeenCalled();
  }
});

test("Phase 13c: 201親の2nd POST失敗は公開errorへ成功済み100親を保持する", async () => {
  const mock = makeClient([]);
  mock.postRecords
    .mockResolvedValueOnce({ ids: Array.from({ length: 100 }, (_, index) => String(index + 1)) })
    .mockRejectedValueOnce(new Error("CB_VA01: invalid record"));
  const values = Array.from({ length: 201 }, (_, index) => `('p${index + 1}')`).join(", ");
  let caught: unknown;
  try {
    await execute(
      `INSERT INTO APP4221 (親) VALUES ${values} APPLY テーブル (APPEND (子) VALUES ('c'))`,
      mock.client,
      { cacheContext: "apply-phase13c-insert-partial", allowApplyMutation: true,
        dmlMaxRows: 201, dmlMaxSubtableRows: 201 }
    );
  } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(ApplyWritePartialFailureError);
  expect(caught).toMatchObject({ partialSuccess: {
    successfulChunks: 1, successfulParents: 100, failedChunkIndex: 1,
    failedStage: "POST_CHUNK", retryAttempted: false,
  } });
  expect(mock.postRecords).toHaveBeenCalledTimes(2);
  expect(mock.getRecords).not.toHaveBeenCalled();
});

test("Phase 13c: INSERT APPLY batchは成功進捗をenvelopeへ渡し部分成功時はfail-fast", async () => {
  const success = makeClient([]);
  success.postRecords.mockResolvedValue({ ids: ["1"] });
  const completed = await executeBatch(insertApplySql, success.client, {
    cacheContext: "apply-phase13c-insert-batch-success", allowApplyMutation: true,
  });
  expect(buildBatchEnvelope(completed).statements[0]).toMatchObject({
    status: "success", insertedCount: 1, successfulChunks: 1,
    successfulParents: 1, nonTransactional: true,
  });

  const partial = makeClient([]);
  partial.postRecords
    .mockResolvedValueOnce({ ids: Array.from({ length: 100 }, (_, index) => String(index + 1)) })
    .mockRejectedValueOnce(new Error("CB_VA01"));
  const values = Array.from({ length: 201 }, (_, index) => `('p${index + 1}')`).join(", ");
  const failed = await executeBatch(
    `INSERT INTO APP4221 (親) VALUES ${values} APPLY テーブル (APPEND (子) VALUES ('c')); `
      + "INSERT INTO APP4221 (親) VALUES ('later')",
    partial.client,
    { cacheContext: "apply-phase13c-insert-batch-partial", allowApplyMutation: true,
      dmlMaxRows: 201, dmlMaxSubtableRows: 201 }
  );
  expect(failed.statements[0]).toMatchObject({ status: "error", error: {
    code: "ApplyWritePartialFailureError",
    partialSuccess: { successfulParents: 100, failedStage: "POST_CHUNK" },
  } });
  expect(failed.statements[1]).toMatchObject({ status: "skipped", skippedReason: "fail-fast" });
  expect(partial.postRecords).toHaveBeenCalledTimes(2);
});

test("Phase 13a: APPLY なし INSERT の既存 POST 経路は非回帰", async () => {
  const mock = makeClient([]);
  mock.postRecords.mockResolvedValue({ ids: ["1"] });
  await expect(execute(
    "INSERT INTO APP4221 (親) VALUES ('new')",
    mock.client,
    { cacheContext: "apply-phase13a-plain-insert" }
  )).resolves.toMatchObject({ type: "INSERT", insertedCount: 1 });
  expect(mock.postRecords).toHaveBeenCalledTimes(1);
});

test("Phase 13b: INSERT APPLY VALIDATE ONLY はprepared診断を返して mutation API 0", async () => {
  const mock = makeClient([]);
  await expect(execute(
    `${insertApplySql} VALIDATE ONLY`,
    mock.client,
    { cacheContext: "apply-phase13a-insert-validate" }
  )).resolves.toMatchObject({
    type: "VALIDATION",
    operation: "INSERT",
    validatedRows: 1,
    validRows: 1,
    apply: [{
      field: "テーブル",
      operations: [{ kind: "APPEND", addedRows: 1 }],
      changedSubtableRows: 1,
      deletedRows: 0,
    }],
    guards: {
      revisionRequired: false,
      parentRows: 1,
      subtableRows: 1,
      dmlMaxRows: 100,
      dmlMaxSubtableRows: 500,
      wouldExceed: false,
    },
  });
  expect(mock.getFields).toHaveBeenCalledTimes(1);
  for (const api of [mock.getRecords, mock.openCursor, mock.postRecords, mock.putRecords, mock.deleteRecords]) {
    expect(api).not.toHaveBeenCalled();
  }
});

test("Phase 13b: 複数VALUES×固定templateのVALIDATE ONLYは二重guardを診断しPOST 0", async () => {
  const mock = makeClient([]);
  const result = await execute(
    "INSERT INTO APP4221 (親) VALUES ('p1'), ('p2') "
      + "APPLY テーブル (APPEND (子) VALUES ('c1'), ('c2')) VALIDATE ONLY",
    mock.client,
    { cacheContext: "apply-phase13b-insert-multi-validate", dmlMaxRows: 1, dmlMaxSubtableRows: 3 }
  );
  expect(result).toMatchObject({
    type: "VALIDATION",
    operation: "INSERT",
    validatedRows: 2,
    apply: [{ operations: [{ kind: "APPEND", addedRows: 4 }], changedSubtableRows: 4 }],
    guards: { parentRows: 2, subtableRows: 4, wouldExceed: true },
  });
  expect(mock.postRecords).not.toHaveBeenCalled();
  expect(mock.putRecords).not.toHaveBeenCalled();
});

test("Phase 13b: INSERT APPLY post-imageは未指定required親子を重複なく各1件診断しPOST 0", async () => {
  const constrained = fieldInfos.map((field) => {
    if (field.code === "親数値") return { ...field, required: true };
    if (field.code === "子") return { ...field, required: true };
    return field;
  });
  constrained.push({
    code: "省略用", label: "省略用", fieldType: "SINGLE_LINE_TEXT", writable: true,
    inSubtable: true, subtableCode: "テーブル",
  });
  const mock = makeClient([], constrained);
  const result = await execute(
    "INSERT INTO APP4221 (親) VALUES ('new') APPLY テーブル (APPEND (省略用) VALUES ('x')) VALIDATE ONLY",
    mock.client,
    { cacheContext: "apply-phase13b-insert-required" }
  );
  expect(result).toMatchObject({ type: "VALIDATION", invalidRows: 1, errorCount: 2 });
  if (result.type !== "VALIDATION") throw new Error("expected validation");
  expect(result.errors.map((error) => [error.$err_field, error.$err_code])).toEqual([
    ["親数値", "ERR_REQUIRED"],
    ["子", "ERR_REQUIRED"],
  ]);
  expect(result.errors.every((error) => error.$err_operation === "INSERT")).toBe(true);
  expect(mock.postRecords).not.toHaveBeenCalled();
});

test("allowApplyMutation なしの mutation は API 前に fail-closed", async () => {
  const mock = makeClient([parent()]);
  await expect(execute(sql, mock.client, { cacheContext: "apply-no-capability" }))
    .rejects.toThrow("UnsupportedError: APPLY mutation requires allowApplyMutation=true");
  expect(mock.getFields).not.toHaveBeenCalled();
  expect(mock.getRecords).not.toHaveBeenCalled();
  expect(mock.putRecords).not.toHaveBeenCalled();
});

test("Phase 10d: 複数親mutationもallowApplyMutationなしならcoreでAPI 0 fail-closed", async () => {
  const mock = makeClient([parent(), parent("9")]);
  await expect(execute(
    "UPDATE APP4221 SET 親='after' WHERE 状態='open' APPLY テーブル (PATCH SET 子='x' ALL ROWS)",
    mock.client,
    { cacheContext: "apply-phase10d-no-capability" }
  )).rejects.toThrow("UnsupportedError: APPLY mutation requires allowApplyMutation=true");
  expect(mock.getFields).not.toHaveBeenCalled();
  expect(mock.getRecords).not.toHaveBeenCalled();
  expect(mock.putRecords).not.toHaveBeenCalled();
});

test.each([2, 100, 101])("Phase 10d: %i親APPLY mutationを1親1record・100件chunkで公開executeする", async (count) => {
  const mock = makeClient(Array.from({ length: count }, (_, index) => parent(String(index + 1))));
  const multipleParentSql = "UPDATE APP4221 SET 親='after' WHERE 状態 IN ('open','hold') "
    + "APPLY テーブル (PATCH SET 子='patched' ALL ROWS)";
  await expect(execute(multipleParentSql, mock.client, {
    cacheContext: `apply-phase10d-${count}`, allowApplyMutation: true,
    dmlMaxRows: count, dmlMaxSubtableRows: count,
  })).resolves.toMatchObject({
    type: "UPDATE",
    updatedCount: count,
    successfulChunks: Math.ceil(count / 100),
    successfulParents: count,
    nonTransactional: true,
  });
  expect(mock.getFields).toHaveBeenCalledTimes(1);
  expect(mock.getRecords).toHaveBeenCalledWith(expect.objectContaining({
    app: 4221,
    query: `状態 in ("open","hold") order by $id asc limit ${count + 1} offset 0`,
    fields: ["$id", "$revision", "親", "親数値", "作成者", "テーブル", "別表"],
  }));
  expect(mock.putRecords.mock.calls.map(([batch]) => batch.records.length))
    .toEqual(count <= 100 ? [count] : [100, count - 100]);
  expect(mock.putRecords.mock.calls.flatMap(([batch]) => batch.records)).toHaveLength(count);
  for (const api of [mock.openCursor, mock.postRecords, mock.deleteRecords]) {
    expect(api).not.toHaveBeenCalled();
  }
});

test("Phase 10d: 複数親confirm detailを全親・table別に集計し、prepare後write前に1回だけ確認する", async () => {
  const mock = makeClient([parent(), parent("9")]);
  const confirm = jest.fn(async () => true);
  await execute(
    "UPDATE APP4221 SET 親='after' WHERE 状態='open' "
      + "APPLY テーブル (REMOVE ALL ROWS)",
    mock.client,
    { cacheContext: "apply-phase10d-confirm", allowApplyMutation: true, confirm, dmlMaxRows: 2 }
  );
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(confirm).toHaveBeenCalledWith(2, "UPDATE", expect.objectContaining({
    applyDetail: {
      kind: "APPLY_PATCH",
      parentRows: 2,
      changedSubtableRows: 2,
      addedSubtableRows: 0,
      tables: [{ table: "テーブル", patchRows: 0, appendRows: 0, removeRows: 2 }],
      deletedRows: 2,
      deletedParentRows: 2,
      revisionRequired: true,
      irreversible: true,
      retryOnRevisionConflict: false,
      nonTransactional: true,
      partialSuccessPossible: true,
    },
  }));
  expect(mock.getRecords.mock.invocationCallOrder[0]).toBeLessThan(confirm.mock.invocationCallOrder[0]);
  expect(confirm.mock.invocationCallOrder[0]).toBeLessThan(mock.putRecords.mock.invocationCallOrder[0]);
});

test("Phase 10d: 2nd chunk conflictは成功済み100親を公開errorに保持しretryしない", async () => {
  const mock = makeClient(Array.from({ length: 201 }, (_, index) => parent(String(index + 1))));
  mock.putRecords
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("ConflictError: revision mismatch"));
  let caught: unknown;
  try {
    await execute(
      "UPDATE APP4221 SET 親='after' WHERE 状態='open' APPLY テーブル (PATCH SET 子='x' ALL ROWS)",
      mock.client,
      { cacheContext: "apply-phase10d-partial", allowApplyMutation: true, dmlMaxRows: 201, dmlMaxSubtableRows: 201 }
    );
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ApplyWritePartialFailureError);
  expect(caught).toMatchObject({
    partialSuccess: {
      successfulChunks: 1,
      successfulParents: 100,
      failedChunkIndex: 1,
      failedStage: "PUT_CHUNK",
      nonTransactional: true,
      retryAttempted: false,
    },
  });
  expect(mock.getRecords).toHaveBeenCalledTimes(1);
  expect(mock.putRecords).toHaveBeenCalledTimes(2);
});

test("Phase 10d: batch success envelopeへ進捗を伝播する", async () => {
  const mock = makeClient([parent(), parent("9")]);
  const result = await executeBatch(
    "UPDATE APP4221 SET 親='after' WHERE 状態='open' APPLY テーブル (PATCH SET 子='patched' ALL ROWS)",
    mock.client,
    { cacheContext: "apply-phase10d-batch-success", allowApplyMutation: true, dmlMaxRows: 2 }
  );
  expect(buildBatchEnvelope(result).statements[0]).toMatchObject({
    status: "success",
    updatedCount: 2,
    successfulChunks: 1,
    successfulParents: 2,
    nonTransactional: true,
  });
});

test("Phase 10d: batch部分成功error envelopeへ成功済みprefixを伝播し後続文をfail-fastする", async () => {
  const mock = makeClient(Array.from({ length: 201 }, (_, index) => parent(String(index + 1))));
  mock.putRecords
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("ConflictError: revision mismatch"));
  const result = await executeBatch(
    "UPDATE APP4221 SET 親='after' WHERE 状態='open' APPLY テーブル (PATCH SET 子='x' ALL ROWS); "
      + "UPDATE APP4221 SET 親='later' WHERE $id=1",
    mock.client,
    { cacheContext: "apply-phase10d-batch-partial", allowApplyMutation: true, dmlMaxRows: 201, dmlMaxSubtableRows: 201 }
  );
  expect(result.statements[0]).toMatchObject({
    status: "error",
    error: {
      code: "ApplyWritePartialFailureError",
      partialSuccess: { successfulChunks: 1, successfulParents: 100, failedChunkIndex: 1 },
    },
  });
  expect(result.statements[1]).toMatchObject({ status: "skipped", skippedReason: "fail-fast" });
  expect(mock.getRecords).toHaveBeenCalledTimes(1);
  expect(mock.putRecords).toHaveBeenCalledTimes(2);
  expect(buildBatchEnvelope(result).statements[0]).toMatchObject({
    error: { partialSuccess: { successfulParents: 100, retryAttempted: false } },
  });
});

test("Phase 10b: 複数親VALIDATE ONLYは全親のapply/guards/validationを集計しwrite 0", async () => {
  const first = parent("8", 2);
  const second = parent("9", 1);
  const mock = makeClient([first, second]);
  const result = await execute(
    "UPDATE APP4221 SET 親='after' WHERE 親='before' "
      + "APPLY テーブル (PATCH SET 子='patched' ALL ROWS) VALIDATE ONLY",
    mock.client,
    { cacheContext: "apply-phase10b-validate", dmlMaxRows: 2, dmlMaxSubtableRows: 2 }
  );
  expect(result).toMatchObject({
    type: "VALIDATION",
    validatedRows: 2,
    validRows: 2,
    invalidRows: 0,
    apply: [{
      field: "テーブル",
      operations: [{ kind: "PATCH", matchedRows: 3, changedRows: 3 }],
      changedSubtableRows: 3,
    }],
    guards: { parentRows: 2, subtableRows: 3, wouldExceed: true },
  });
  expect(mock.getRecords).toHaveBeenCalledWith(expect.objectContaining({
    query: '親 = "before" order by $id asc limit 3 offset 0',
  }));
  expect(mock.putRecords).not.toHaveBeenCalled();
  expect(mock.postRecords).not.toHaveBeenCalled();
});

test.each([
  ["mutation", ""],
  ["VALIDATE ONLY", " VALIDATE ONLY"],
])("Phase 12: EXPECT ROWS違反は%sでもArgumentErrorで全件preflightしwrite 0", async (_label, tail) => {
  const mock = makeClient([parent("8", 1), parent("9", 2)]);
  await expect(execute(
    "UPDATE APP4221 SET 親='after' WHERE 親='before' "
      + `APPLY テーブル (PATCH SET 子='patched' ALL ROWS EXPECT ROWS 1)${tail}`,
    mock.client,
    { cacheContext: `apply-phase12-expect-${_label}`, allowApplyMutation: true, dmlMaxRows: 2 }
  )).rejects.toThrow(
    "ArgumentError: APPLY EXPECT ROWS mismatch for parent $id 9, table テーブル, operation 1 (PATCH): expected exactly 1, actual 2."
  );
  expect(mock.getRecords).toHaveBeenCalledTimes(1);
  expect(mock.putRecords).not.toHaveBeenCalled();
  expect(mock.postRecords).not.toHaveBeenCalled();
});

test("Phase 10b: 一般WHERE 0件は空prepared由来の成功診断、単一$id 0件は従来どおりerror", async () => {
  const empty = makeClient([]);
  await expect(execute(
    "UPDATE APP4221 SET 親='after' WHERE 親='missing' "
      + "APPLY テーブル (PATCH SET 子='patched' ALL ROWS) VALIDATE ONLY",
    empty.client,
    { cacheContext: "apply-phase10b-empty" }
  )).resolves.toMatchObject({
    type: "VALIDATION", validatedRows: 0, validRows: 0, invalidRows: 0,
    guards: { parentRows: 0, subtableRows: 0, wouldExceed: false },
  });
  expect(empty.putRecords).not.toHaveBeenCalled();

  const single = makeClient([]);
  await expect(execute(sql, single.client, {
    cacheContext: "apply-phase10b-single-empty", allowApplyMutation: true,
  })).rejects.toThrow("ArgumentError: APPLY parent $id 8 does not exist");
});

test("Phase 10b: dmlMaxRows+1件で超過を確定しtruncateせずwrite 0", async () => {
  const mock = makeClient(Array.from({ length: 101 }, (_, index) => parent(String(index + 1))));
  await expect(execute(
    "UPDATE APP4221 SET 親='after' WHERE 親='before' APPLY テーブル (PATCH SET 子='x' ALL ROWS)",
    mock.client,
    { cacheContext: "apply-phase10b-overflow", allowApplyMutation: true, dmlMaxRows: 100 }
  )).rejects.toThrow("ArgumentError: APPLY parent rows (101) exceed dmlMaxRows (100)");
  expect(mock.getRecords).toHaveBeenCalledWith(expect.objectContaining({
    query: '親 = "before" order by $id asc limit 101 offset 0',
  }));
  expect(mock.putRecords).not.toHaveBeenCalled();
  expect(mock.postRecords).not.toHaveBeenCalled();
});

test("Phase 10b: VALIDATE ONLYはdmlMaxRows+1親をtruncateせず全件診断しwouldExceedを返す", async () => {
  const mock = makeClient(Array.from({ length: 101 }, (_, index) => parent(String(index + 1))));
  const result = await execute(
    "UPDATE APP4221 SET 親='after' WHERE 親='before' "
      + "APPLY テーブル (PATCH SET 子='x' ALL ROWS) VALIDATE ONLY",
    mock.client,
    { cacheContext: "apply-phase10b-validate-overflow", dmlMaxRows: 100, dmlMaxSubtableRows: 101 }
  );
  expect(result).toMatchObject({
    type: "VALIDATION",
    validatedRows: 101,
    validRows: 101,
    guards: { parentRows: 101, subtableRows: 101, wouldExceed: true },
  });
  expect(mock.putRecords).not.toHaveBeenCalled();
  expect(mock.postRecords).not.toHaveBeenCalled();
});

test("Phase 10b: 複数親post-image validationは親別に集計し$error rowを保持する", async () => {
  const constrained = fieldInfos.map((field) => field.code === "親"
    ? { ...field, minLength: "2" }
    : field);
  const mock = makeClient([parent("8"), parent("9")], constrained);
  const result = await execute(
    "UPDATE APP4221 SET 親='' WHERE 親='before' "
      + "APPLY テーブル (PATCH SET 子='x' ALL ROWS) VALIDATE ONLY",
    mock.client,
    { cacheContext: "apply-phase10b-validation-errors", dmlMaxRows: 2 }
  );
  expect(result).toMatchObject({
    type: "VALIDATION", validatedRows: 2, validRows: 0, invalidRows: 2, errorCount: 2,
  });
  if (result.type !== "VALIDATION") throw new Error("expected validation result");
  expect(result.errors.map((error) => [error.$id, error.$err_row])).toEqual([["8", "1"], ["9", "2"]]);
  expect(mock.putRecords).not.toHaveBeenCalled();
});

test(
  "VALIDATE ONLY は共通plan/validation/guardの全件数を返し confirm/PUT しない",
  async () => {
    const mock = makeClient([parent()]);
    const confirm = jest.fn(async () => true);
    await expect(execute(`${sql} VALIDATE ONLY`, mock.client, {
      cacheContext: "apply-validate", confirm, dmlMaxRows: 2, dmlMaxSubtableRows: 3,
    })).resolves.toMatchObject({
      type: "VALIDATION", operation: "UPDATE",
      validatedRows: 1, validRows: 1, invalidRows: 0, errorCount: 0,
      apply: [{
        field: "テーブル",
        operations: [{ kind: "PATCH", matchedRows: 1, changedRows: 1 }],
        changedSubtableRows: 1,
        deletedRows: 0,
      }],
      guards: {
        revisionRequired: true, parentRows: 1, dmlMaxRows: 2,
        subtableRows: 1, dmlMaxSubtableRows: 3, wouldExceed: false,
      },
    });
    expect(mock.getFields).toHaveBeenCalledWith(4221);
    expect(mock.getRecords).toHaveBeenCalledTimes(1);
    expect(mock.getRecords).toHaveBeenCalledWith({
      app: 4221,
      query: "$id = 8 limit 2",
      fields: ["$id", "$revision", "親", "親数値", "作成者", "テーブル", "別表"],
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(mock.putRecords).not.toHaveBeenCalled();
  }
);

test("VALIDATE ONLY はガード超過を wouldExceed=true の成功診断にして mutation 0", async () => {
  const mock = makeClient([parent("8", 2)]);
  const result = await execute(
    "UPDATE APP4221 SET 親='after' WHERE $id=8 APPLY テーブル (PATCH SET 子='x' ALL ROWS) VALIDATE ONLY",
    mock.client,
    { cacheContext: "apply-validate-guard", dmlMaxRows: 1, dmlMaxSubtableRows: 1 }
  );
  expect(result).toMatchObject({
    type: "VALIDATION",
    apply: [{ operations: [{ matchedRows: 2, changedRows: 2 }], changedSubtableRows: 2 }],
    guards: { parentRows: 1, subtableRows: 2, wouldExceed: true },
  });
  expect(mock.putRecords).not.toHaveBeenCalled();
});

test("VALIDATE ONLY apply[]はtable別PATCH/APPENDとtable横断追加合計を返す", async () => {
  const mock = makeClient([parent()]);
  const result = await execute(
    "UPDATE APP4221 SET 親='after' WHERE $id=8 "
      + "APPLY テーブル (PATCH SET 子='x' ALL ROWS; APPEND (子) VALUES ('a'), ('b')) "
      + "APPLY 別表 (APPEND (別子) VALUES ('c')) VALIDATE ONLY",
    mock.client,
    { cacheContext: "apply-v11-validate-detail", dmlMaxRows: 1, dmlMaxSubtableRows: 4 }
  );
  expect(result).toMatchObject({
    type: "VALIDATION",
    apply: [
      {
        field: "テーブル",
        operations: [
          { kind: "PATCH", matchedRows: 1, changedRows: 1 },
          { kind: "APPEND", addedRows: 2 },
        ],
        changedSubtableRows: 3,
      },
      {
        field: "別表",
        operations: [{ kind: "APPEND", addedRows: 1 }],
        changedSubtableRows: 1,
      },
    ],
    guards: { subtableRows: 4, dmlMaxSubtableRows: 4, wouldExceed: false },
  });
  expect(mock.putRecords).not.toHaveBeenCalled();
});

test("VALIDATE ONLY の post-image error は親単位/セル単位件数と固定列順を返す", async () => {
  const constrained = fieldInfos.map((field) => field.code === "別子" ? { ...field, required: true } : field);
  const invalid = parent();
  invalid.別表 = { value: [{ id: "201", value: { 別子: { value: "" } } }] } as never;
  const mock = makeClient([invalid], constrained);
  const result = await execute(`${sql} VALIDATE ONLY`, mock.client, { cacheContext: "apply-validate-errors" });
  expect(result).toMatchObject({
    type: "VALIDATION", validatedRows: 1, validRows: 0, invalidRows: 1, errorCount: 1,
  });
  if (result.type !== "VALIDATION") throw new Error("expected validation result");
  expect(result.columns).toEqual([
    "$id", "親",
    "$err_statement", "$err_operation", "$err_row", "$err_field", "$err_code", "$err_message",
    "$err_value", "$err_subtable", "$err_subrow", "$err_subrow_id",
  ]);
  expect(mock.putRecords).not.toHaveBeenCalled();
});

test("APPLY VALIDATE ONLY INTO #err は batch で固定列/型を実体化し後続SELECTへ列順を保つ", async () => {
  const constrained = fieldInfos.map((field) => field.code === "別子" ? { ...field, required: true } : field);
  const invalid = parent();
  invalid.別表 = { value: Array.from({ length: 10 }, (_, index) => ({
    id: String(201 + index), value: { 別子: { value: "" } },
  })) } as never;
  const mock = makeClient([invalid], constrained);
  const batch = await executeBatch(
    `${sql} VALIDATE ONLY INTO #err; SELECT * FROM #err ORDER BY $err_subrow`,
    mock.client,
    { cacheContext: "apply-validate-into" }
  );
  expect(batch.ok).toBe(true);
  const selected = batch.statements[1].result as SelectResult;
  expect(selected.columns).toEqual([
    "$id", "親",
    "$err_statement", "$err_operation", "$err_row", "$err_field", "$err_code", "$err_message",
    "$err_value", "$err_subtable", "$err_subrow", "$err_subrow_id",
  ]);
  expect(selected.rows[0]).toMatchObject({ $id: "8", $err_subrow: "1", $err_subrow_id: "201" });
  // B42 locator と同じ string metadata。number 扱いなら "2" が先になる。
  expect(selected.rows.slice(0, 3).map((row) => row.$err_subrow)).toEqual(["1", "10", "2"]);
  expect(mock.putRecords).not.toHaveBeenCalled();
});

test("APPLY VALIDATE ONLY INTO #err は単文では拒否する", async () => {
  const mock = makeClient([parent()]);
  await expect(execute(`${sql} VALIDATE ONLY INTO #err`, mock.client, { cacheContext: "apply-into-single" }))
    .rejects.toThrow("ArgumentError: VALIDATE ONLY INTO requires a batch");
  expect(mock.getRecords).not.toHaveBeenCalled();
});

test("二重ガード以内は revision 付き1-record PUTを1回だけ行う", async () => {
  const mock = makeClient([parent()]);
  await expect(execute(sql, mock.client, {
    cacheContext: "apply-success", allowApplyMutation: true, dmlMaxRows: 1, dmlMaxSubtableRows: 1,
  })).resolves.toMatchObject({ type: "UPDATE", updatedCount: 1 });
  expect(mock.putRecords).toHaveBeenCalledTimes(1);
  expect(mock.putRecords).toHaveBeenCalledWith({
    app: 4221,
    records: [{
      id: 8,
      revision: 3,
      record: {
        親: { value: "after" },
        テーブル: { value: [{ id: "101", value: { 子: { value: "patched" } } }] },
      },
    }],
  });
});

test("Phase 11: 単一親PATCHの_idx=0は先頭行だけをrevision付きPUTする", async () => {
  const mock = makeClient([parent("8", 3)]);
  await expect(execute(
    "UPDATE APP4221 SET 親='after' WHERE $id=8 APPLY テーブル (PATCH SET 子='idx-first' WHERE _idx=0)",
    mock.client,
    { cacheContext: "apply-phase11-single-idx", allowApplyMutation: true }
  )).resolves.toMatchObject({ type: "UPDATE", updatedCount: 1 });
  const payload = (mock.putRecords.mock.calls as unknown as [[KintonePutParams]])[0][0];
  expect(payload.records[0]).toMatchObject({ id: 8, revision: 3 });
  expect(payload.records[0].record.テーブル.value).toEqual([
    { id: "101", value: { 子: { value: "idx-first" } } },
    { id: "102" },
    { id: "103" },
  ]);
});

test("Phase 11: 複数親REMOVEの_idx=0は各親の先頭行をrevision付きで削除する", async () => {
  const first = parent("8", 2);
  const second = parent("9", 2);
  second["$revision"] = { value: "4" };
  const mock = makeClient([first, second]);
  await expect(execute(
    "UPDATE APP4221 SET 親='after' WHERE 親='before' APPLY テーブル (REMOVE WHERE _idx=0)",
    mock.client,
    { cacheContext: "apply-phase11-multi-idx", allowApplyMutation: true, dmlMaxRows: 2 }
  )).resolves.toMatchObject({ type: "UPDATE", updatedCount: 2 });
  const records = (mock.putRecords.mock.calls as unknown as [[KintonePutParams]])[0][0].records;
  expect(records.map((record) => record.revision)).toEqual([3, 4]);
  expect(records.map((record) =>
    (record.record.テーブル.value as unknown as Array<{ id: string }>).map((row) => row.id)
  )).toEqual([
    ["102"], ["102"],
  ]);
});

test("Phase 11: VALIDATE ONLYの_idx INはmatched/changedを反映しwrite 0", async () => {
  const mock = makeClient([parent("8", 3)]);
  const result = await execute(
    "UPDATE APP4221 SET 親='after' WHERE $id=8 "
      + "APPLY テーブル (PATCH SET 子='selected' WHERE _idx IN (0,2)) VALIDATE ONLY",
    mock.client,
    { cacheContext: "apply-phase11-validate-idx" }
  );
  expect(result).toMatchObject({
    type: "VALIDATION",
    apply: [{
      field: "テーブル",
      operations: [{ kind: "PATCH", matchedRows: 2, changedRows: 2 }],
      changedSubtableRows: 2,
    }],
    guards: { subtableRows: 2, revisionRequired: true, wouldExceed: false },
  });
  expect(mock.putRecords).not.toHaveBeenCalled();
});

test("複数tableのPATCH/APPENDを1 recordへ合成し、defaultを明示payload化してFILEを送らない", async () => {
  const infos: KintoneFieldInfo[] = [
    ...fieldInfos.map((field) => field.code === "子" ? { ...field, defaultValue: "DEFAULT" } : field),
    { code: "必須", label: "必須", fieldType: "SINGLE_LINE_TEXT", writable: true, required: true, inSubtable: true, subtableCode: "テーブル" },
  ];
  const record = parent();
  (record.テーブル.value as any[])[0].value.必須 = { value: "existing" };
  const mock = makeClient([record], infos);
  const statement = "UPDATE APP4221 SET 親='after' WHERE $id=8 "
    + "APPLY テーブル (APPEND (必須) VALUES ('first'), ('second'); PATCH SET 子='patched' ALL ROWS) "
    + "APPLY 別表 (APPEND (別子) VALUES ('other'))";
  const confirm = jest.fn(async (_count, _operation, context) => {
    expect(context?.applyDetail).toEqual({
      kind: "APPLY_PATCH", parentRows: 1, changedSubtableRows: 4, addedSubtableRows: 3,
      tables: [
        { table: "テーブル", patchRows: 1, appendRows: 2, removeRows: 0 },
        { table: "別表", patchRows: 0, appendRows: 1, removeRows: 0 },
      ],
      deletedRows: 0, deletedParentRows: 0, revisionRequired: true,
      irreversible: true, retryOnRevisionConflict: false,
    });
    return true;
  });
  await expect(execute(statement, mock.client, {
    cacheContext: "apply-v11-multi", allowApplyMutation: true, confirm,
  })).resolves.toMatchObject({ updatedCount: 1 });
  expect(mock.putRecords).toHaveBeenCalledTimes(1);
  const payload = (mock.putRecords.mock.calls as unknown as [[KintonePutParams]])[0][0];
  expect(payload.records).toHaveLength(1);
  expect(payload.records[0].record).toEqual({
    親: { value: "after" },
    テーブル: { value: [
      { id: "101", value: { 子: { value: "patched" } } },
      { value: { 子: { value: "DEFAULT" }, 必須: { value: "first" } } },
      { value: { 子: { value: "DEFAULT" }, 必須: { value: "second" } } },
    ] },
    別表: { value: [{ value: { 別子: { value: "other" } } }] },
  });
});

test("APPEND未指定required既定値なしとnumber precision違反をPUT前に拒否する", async () => {
  const requiredInfos: KintoneFieldInfo[] = [
    ...fieldInfos,
    { code: "必須", label: "必須", fieldType: "SINGLE_LINE_TEXT", writable: true, required: true, inSubtable: true, subtableCode: "テーブル" },
  ];
  const requiredRecord = parent();
  (requiredRecord.テーブル.value as any[])[0].value.必須 = { value: "existing" };
  const requiredMock = makeClient([requiredRecord], requiredInfos);
  await expect(execute(
    "UPDATE APP4221 SET 親='after' WHERE $id=8 APPLY テーブル (APPEND (子) VALUES ('x'))",
    requiredMock.client,
    { cacheContext: "apply-v11-required", allowApplyMutation: true }
  )).rejects.toThrow(/APPLY post-image validation failed.*ERR_REQUIRED/);
  expect(requiredMock.putRecords).not.toHaveBeenCalled();

  const numberInfos: KintoneFieldInfo[] = [
    ...fieldInfos,
    { code: "子数値", label: "子数値", fieldType: "NUMBER", writable: true, inSubtable: true, subtableCode: "テーブル" },
  ];
  const numberRecord = parent();
  (numberRecord.テーブル.value as any[])[0].value.子数値 = { value: "1" };
  const numberMock = makeClient([numberRecord], numberInfos);
  numberMock.getNumberPrecision.mockResolvedValueOnce({ digits: 3, decimalPlaces: 1, roundingMode: "HALF_EVEN" });
  await expect(execute(
    "UPDATE APP4221 SET 親='after' WHERE $id=8 APPLY テーブル (APPEND (子数値) VALUES (100))",
    numberMock.client,
    { cacheContext: "apply-v11-precision", allowApplyMutation: true }
  )).rejects.toThrow(/APPLY post-image validation failed.*ERR_NUMBER_INTEGER_DIGITS/);
  expect(numberMock.putRecords).not.toHaveBeenCalled();
});

test("APPENDのmetadata既定値も通常値と同じchoice primitiveで検証する", async () => {
  const infos: KintoneFieldInfo[] = [
    ...fieldInfos,
    {
      code: "選択", label: "選択", fieldType: "DROP_DOWN", writable: true,
      optionOrder: { A: 0 }, defaultValue: "UNKNOWN", inSubtable: true, subtableCode: "テーブル",
    },
  ];
  const record = parent();
  (record.テーブル.value as any[])[0].value.選択 = { value: "A" };
  const mock = makeClient([record], infos);
  await expect(execute(
    "UPDATE APP4221 SET 親='after' WHERE $id=8 APPLY テーブル (APPEND (子) VALUES ('x'))",
    mock.client,
    { cacheContext: "apply-v11-default-choice", allowApplyMutation: true }
  )).rejects.toThrow(/APPLY post-image validation failed.*ERR_CHOICE_INVALID/);
  expect(mock.putRecords).not.toHaveBeenCalled();
});

test("親1・子501は既定子ガード500で PUT 0", async () => {
  const mock = makeClient([parent("8", 501)]);
  const allRowsSql = "UPDATE APP4221 SET 親 = 'after' WHERE $id = 8 " +
    "APPLY テーブル (PATCH SET 子 = 'patched' ALL ROWS)";
  await expect(execute(allRowsSql, mock.client, { cacheContext: "apply-default-child-guard", allowApplyMutation: true }))
    .rejects.toThrow("ArgumentError: APPLY changed subtable rows (501) exceed dmlMaxSubtableRows (500)");
  expect(mock.putRecords).not.toHaveBeenCalled();
});

test("親ガードと両ガードの正整数契約を core で強制する", async () => {
  const parentGuard = makeClient([parent()]);
  await expect(execute(sql, parentGuard.client, {
    cacheContext: "apply-parent-guard", allowApplyMutation: true, dmlMaxRows: 0,
  })).rejects.toThrow("ArgumentError: dmlMaxRows must be a positive safe integer");
  expect(parentGuard.putRecords).not.toHaveBeenCalled();

  const childGuard = makeClient([parent()]);
  await expect(execute(sql, childGuard.client, {
    cacheContext: "apply-child-guard-invalid", allowApplyMutation: true, dmlMaxSubtableRows: 1.5,
  })).rejects.toThrow("ArgumentError: dmlMaxSubtableRows must be a positive safe integer");
  expect(childGuard.putRecords).not.toHaveBeenCalled();
});

test.each([
  [
    "unknown rid",
    "UPDATE APP4221 SET 親='after' WHERE $id=8 APPLY テーブル (PATCH SET 子='x' WHERE _rid='999')",
    /ArgumentError: APPLY _rid 999 does not exist/,
  ],
  [
    "duplicate cell",
    "UPDATE APP4221 SET 親='after' WHERE $id=8 APPLY テーブル (" +
      "PATCH SET 子='x' ALL ROWS; PATCH SET 子='y' WHERE _rid='101')",
    /ArgumentError: APPLY patches cell 101\.子 more than once/,
  ],
] as const)("%s は plan 完了前に拒否し PUT 0", async (_label, statement, error) => {
  const mock = makeClient([parent()]);
  await expect(execute(statement, mock.client, {
    cacheContext: `apply-plan-${_label}`, allowApplyMutation: true,
  })).rejects.toThrow(error);
  expect(mock.putRecords).not.toHaveBeenCalled();
});

test("全 preflight とガード完了後に applyDetail 付き confirm を1回呼び、拒否なら PUT 0", async () => {
  const mock = makeClient([parent()]);
  const confirm = jest.fn(async (count, operation, context) => {
    expect(mock.getFields).toHaveBeenCalledTimes(1);
    expect(mock.getRecords).toHaveBeenCalledTimes(1);
    expect(mock.getNumberPrecision).toHaveBeenCalledTimes(1);
    expect(mock.putRecords).not.toHaveBeenCalled();
    expect(count).toBe(1);
    expect(operation).toBe("UPDATE");
    expect(context?.importDetail).toBeUndefined();
    expect(context?.applyDetail).toEqual({
      kind: "APPLY_PATCH",
      parentRows: 1,
      changedSubtableRows: 1,
      addedSubtableRows: 0,
      tables: [{ table: "テーブル", patchRows: 1, appendRows: 0, removeRows: 0 }],
      deletedRows: 0,
      deletedParentRows: 0,
      revisionRequired: true,
      irreversible: true,
      retryOnRevisionConflict: false,
    });
    return false;
  });
  await expect(execute(sql, mock.client, {
    cacheContext: "apply-confirm-order", allowApplyMutation: true, confirm,
  })).rejects.toThrow("UPDATE をキャンセルしました（対象: 1 件）");
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(mock.putRecords).not.toHaveBeenCalled();
});

test("revision conflict を再GET・retryせずそのまま失敗させる", async () => {
  const mock = makeClient([parent()]);
  mock.putRecords.mockRejectedValueOnce(new Error("GAIA_CO02: revision conflict"));
  await expect(execute(sql, mock.client, {
    cacheContext: "apply-revision-conflict", allowApplyMutation: true,
  })).rejects.toThrow("GAIA_CO02: revision conflict");
  expect(mock.getRecords).toHaveBeenCalledTimes(1);
  expect(mock.putRecords).toHaveBeenCalledTimes(1);
});

test("REMOVE tableだけFULL_SURVIVORS payloadに切替え、存続順・全child値とAPPEND順を保持する", async () => {
  const record = parent("8", 3);
  const rows = record.テーブル.value as any[];
  rows[0].value.子.value = "a";
  rows[1].value.子.value = "b";
  rows[2].value.子.value = "c";
  const mock = makeClient([record]);
  const statement = "UPDATE APP4221 SET 親='after' WHERE $id=8 "
    + "APPLY テーブル (REMOVE WHERE _rid='102'; APPEND (子) VALUES ('new')) "
    + "APPLY 別表 (APPEND (別子) VALUES ('other'))";
  await expect(execute(statement, mock.client, {
    cacheContext: "apply-remove-full-survivors", allowApplyMutation: true,
  })).resolves.toMatchObject({ updatedCount: 1 });
  const payload = (mock.putRecords.mock.calls as unknown as [[KintonePutParams]])[0][0];
  expect(payload.records[0].record.テーブル.value).toEqual([
    { id: "101", value: { 子: { value: "a" }, 子添付: { value: [{ fileKey: "opaque" }] } } },
    { id: "103", value: { 子: { value: "c" }, 子添付: { value: [{ fileKey: "opaque" }] } } },
    { value: { 子: { value: "new" } } },
  ]);
  expect(payload.records[0].record.別表.value).toEqual([{ value: { 別子: { value: "other" } } }]);
});

test("VALIDATE ONLYはREMOVE内訳・table別/合計削除数・削除対象親を返しPUT 0", async () => {
  const mock = makeClient([parent("8", 3)]);
  const result = await execute(
    "UPDATE APP4221 SET 親='after' WHERE $id=8 APPLY テーブル (REMOVE WHERE _rid='102') VALIDATE ONLY",
    mock.client,
    { cacheContext: "apply-remove-validate" }
  );
  expect(result).toMatchObject({
    type: "VALIDATION",
    apply: [{
      field: "テーブル",
      operations: [{ kind: "REMOVE", removedRows: 1 }],
      changedSubtableRows: 1,
      deletedRows: 1,
    }],
    deletedRows: { total: 1, parentRows: 1 },
    guards: { subtableRows: 1, revisionRequired: true, wouldExceed: false },
  });
  expect(mock.putRecords).not.toHaveBeenCalled();
});

test("削除確認detailはtable別REMOVE・総削除・削除対象親・不可逆・非retryを明示する", async () => {
  const mock = makeClient([parent("8", 2)]);
  const confirm = jest.fn(async (_count, _operation, context) => {
    expect(context?.applyDetail).toEqual({
      kind: "APPLY_PATCH",
      parentRows: 1,
      changedSubtableRows: 1,
      addedSubtableRows: 0,
      tables: [{ table: "テーブル", patchRows: 0, appendRows: 0, removeRows: 1 }],
      deletedRows: 1,
      deletedParentRows: 1,
      revisionRequired: true,
      irreversible: true,
      retryOnRevisionConflict: false,
    });
    return false;
  });
  await expect(execute(
    "UPDATE APP4221 SET 親='after' WHERE $id=8 APPLY テーブル (REMOVE WHERE _rid='101')",
    mock.client,
    { cacheContext: "apply-remove-confirm", allowApplyMutation: true, confirm }
  )).rejects.toThrow("UPDATE をキャンセルしました");
  expect(mock.putRecords).not.toHaveBeenCalled();
});

test("PATCH∪REMOVE∪APPEND distinct総和がdmlMaxSubtableRows超過ならPUT 0", async () => {
  const mock = makeClient([parent("8", 3)]);
  await expect(execute(
    "UPDATE APP4221 SET 親='after' WHERE $id=8 APPLY テーブル ("
      + "PATCH SET 子='x' WHERE _rid='101'; REMOVE WHERE _rid='102'; APPEND (子) VALUES ('new'))",
    mock.client,
    { cacheContext: "apply-remove-guard-union", allowApplyMutation: true, dmlMaxSubtableRows: 2 }
  )).rejects.toThrow("APPLY changed subtable rows (3) exceed dmlMaxSubtableRows (2)");
  expect(mock.putRecords).not.toHaveBeenCalled();
});

test("REMOVE revision conflictも再GET・retryしない", async () => {
  const mock = makeClient([parent("8", 2)]);
  mock.putRecords.mockRejectedValueOnce(new Error("GAIA_CO02: revision conflict"));
  await expect(execute(
    "UPDATE APP4221 SET 親='after' WHERE $id=8 APPLY テーブル (REMOVE WHERE _rid='101')",
    mock.client,
    { cacheContext: "apply-remove-revision-conflict", allowApplyMutation: true }
  )).rejects.toThrow("GAIA_CO02: revision conflict");
  expect(mock.getRecords).toHaveBeenCalledTimes(1);
  expect(mock.putRecords).toHaveBeenCalledTimes(1);
});

test.each([
  ["0件", [], /ArgumentError: APPLY parent \$id 8 does not exist/],
  ["2件", [parent(), parent()], /ArgumentError: APPLY parent \$id 8 returned multiple records/],
  ["$id不一致", [parent("9")], /ArgumentError: APPLY snapshot \$id 9 does not match requested \$id 8/],
] as const)("親GETの%sを fail-closed にし PUT 0", async (_label, records, error) => {
  const mock = makeClient([...records]);
  await expect(execute(sql, mock.client, { cacheContext: `apply-parent-${_label}`, allowApplyMutation: true })).rejects.toThrow(error);
  expect(mock.getRecords).toHaveBeenCalledTimes(1);
  expect(mock.putRecords).not.toHaveBeenCalled();
});

test("target/child/writable metadata error は records API 前に拒否する", async () => {
  const wrongChild = makeClient([parent()]);
  const wrongChildSql = "UPDATE APP4221 SET 親 = 'after' WHERE $id = 8 " +
    "APPLY テーブル (PATCH SET 別子 = 'x' ALL ROWS)";
  await expect(execute(wrongChildSql, wrongChild.client, { cacheContext: "apply-wrong-child", allowApplyMutation: true }))
    .rejects.toThrow("ArgumentError: APPLY child 別子 does not belong to subtable テーブル");
  expect(wrongChild.getRecords).not.toHaveBeenCalled();
  expect(wrongChild.putRecords).not.toHaveBeenCalled();

  const missingTable = makeClient([parent()], fieldInfos.filter((field) => field.code !== "テーブル"));
  await expect(execute(sql, missingTable.client, { cacheContext: "apply-missing-table", allowApplyMutation: true }))
    .rejects.toThrow("ArgumentError: APPLY target テーブル is not a SUBTABLE");
  expect(missingTable.getRecords).not.toHaveBeenCalled();
});

test("post-image error は固定列順の診断を含む ArgumentError で停止し PUT 0", async () => {
  const constrained = fieldInfos.map((field) => field.code === "別子"
    ? { ...field, required: true }
    : field.code === "子"
      ? { ...field, minLength: "2" }
      : field);
  const invalid = parent();
  invalid.別表 = { value: [{ id: "201", value: { 別子: { value: "" } } }] } as never;
  const mock = makeClient([invalid], constrained);

  let error: Error | undefined;
  try {
    await execute(sql, mock.client, { cacheContext: "apply-post-image-errors", allowApplyMutation: true });
  } catch (caught) {
    error = caught as Error;
  }
  expect(error?.message).toContain("ArgumentError: APPLY post-image validation failed");
  const diagnostic = JSON.parse(error!.message.slice(error!.message.indexOf("{") )) as {
    columns: string[]; errors: Array<Record<string, string>>;
  };
  expect(diagnostic.columns).toEqual([
    "$id", "親",
    "$err_statement", "$err_operation", "$err_row", "$err_field", "$err_code", "$err_message",
    "$err_value", "$err_subtable", "$err_subrow", "$err_subrow_id",
  ]);
  expect(diagnostic.errors).toEqual([
    expect.objectContaining({
      $id: "8", 親: "after", $err_field: "別子", $err_subtable: "別表", $err_subrow: "1", $err_subrow_id: "201",
    }),
  ]);
  expect(mock.putRecords).not.toHaveBeenCalled();
});

test("トップレベル post-image error の locator 3列は空で $id は重複しない", async () => {
  const constrained = fieldInfos.map((field) => field.code === "親数値"
    ? { ...field, maxValue: "0" }
    : field);
  const mock = makeClient([parent()], constrained);
  await expect(execute(sql, mock.client, { cacheContext: "apply-post-image-top-error", allowApplyMutation: true }))
    .rejects.toThrow(/\"\$err_subtable\":\"\",\"\$err_subrow\":\"\",\"\$err_subrow_id\":\"\"/);
  expect(mock.putRecords).not.toHaveBeenCalled();
});

test("post-image に NUMBER セルがない場合は precision cache を読まない", async () => {
  const withoutNumbers = fieldInfos.filter((field) => field.code !== "親数値");
  const record = parent();
  delete record.親数値;
  const mock = makeClient([record], withoutNumbers);
  await expect(execute(sql, mock.client, { cacheContext: "apply-no-number-precision", allowApplyMutation: true }))
    .resolves.toMatchObject({ updatedCount: 1 });
  expect(mock.getNumberPrecision).not.toHaveBeenCalled();
  expect(mock.putRecords).toHaveBeenCalledTimes(1);
});
