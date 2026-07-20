import type { ApplyPatchPlan } from "../../core/applyPatchPlanner";
import type { PreparedApplyWrite } from "../../core/applyPatchPrepare";
import { applyPatchPlansToKintoneBatches, applyPatchPlanToKintone, requireRevision } from "../applyPatchToKintone";
import type { KintoneRecord } from "../dmlToKintone";

function basePlan(): ApplyPatchPlan {
  return {
    app: 4221,
    parentId: 8,
    revision: 3,
    parentRows: 1,
    changedSubtableRows: 1,
    parentValues: { 親: { value: "after" } },
    postImage: { 親: { value: "after" } },
    tables: [{
      table: "テーブル",
      operations: [{ kind: "PATCH", matchedRows: 1, changedRows: 1 }],
      payloadShape: "PATCH_ONLY",
      changedSubtableRows: 1,
      deletedRows: 0,
      snapshotRowIds: ["101", "102"],
      payloadRows: [{ id: "101", value: { 子: { value: "patched" } } }, { id: "102" }],
      postImageRows: [
        { id: "101", value: { 子: { value: "patched" }, 未指定: { value: "keep" } } },
        { id: "102", value: { 子: { value: "untouched" } } },
      ],
    }],
  };
}

function prepared(count: number): PreparedApplyWrite {
  const plans = Array.from({ length: count }, (_, index) => ({
    ...basePlan(),
    parentId: index + 1,
    revision: index + 101,
  }));
  return {
    plans,
    records: plans.flatMap((plan) => applyPatchPlanToKintone(plan).records),
    validations: [],
    guards: {
      revisionRequired: true,
      parentRows: count,
      dmlMaxRows: Math.max(1, count),
      subtableRows: count,
      dmlMaxSubtableRows: Math.max(1, count),
      wouldExceed: false,
    },
  };
}

test("親SETとtableをrevision付きの単一 records[] elementへ合成する", () => {
  expect(applyPatchPlanToKintone(basePlan())).toEqual({
    app: 4221,
    records: [{
      id: 8,
      revision: 3,
      record: {
        親: { value: "after" },
        テーブル: { value: [{ id: "101", value: { 子: { value: "patched" } } }, { id: "102" }] },
      },
    }],
  });
});

test.each([
  [0, []],
  [100, [100]],
  [101, [100, 1]],
  [201, [100, 100, 1]],
] as const)("prepared %i親を最大100件のPUT batchへ変換する", (count, sizes) => {
  const batches = applyPatchPlansToKintoneBatches(prepared(count));
  expect(batches.map((batch) => batch.records.length)).toEqual(sizes);
  expect(batches.flatMap((batch) => batch.records).map((record) => record.id))
    .toEqual(Array.from({ length: count }, (_, index) => index + 1));
  expect(batches.every((batch) => batch.app === 4221)).toBe(true);
  expect(batches.flatMap((batch) => batch.records)).toHaveLength(count);
});

test.each([undefined, "", "0", 0, "x", 1.5])("requireRevision は欠落・非正整数を拒否する: %p", (value) => {
  const record = value === undefined ? {} : { "$revision": { value } };
  expect(() => requireRevision(record as unknown as KintoneRecord)).toThrow(
    "ArgumentError: APPLY snapshot $revision must be a positive integer"
  );
});

test("PATCH_ONLY は全snapshot idと順序の保持を必須にする", () => {
  const plan = basePlan();
  const table = plan.tables[0];
  expect(() => applyPatchPlanToKintone({
    ...plan,
    tables: [{ ...table, payloadRows: [{ id: "101" }] }],
  })).toThrow("PATCH_ONLY table テーブル must retain every snapshot row id in order");
});

test("PATCH_ONLY APPENDは全snapshot idの後ろに未採番value行を保持する", () => {
  const plan = basePlan();
  const table = plan.tables[0];
  const appended = {
    ...table,
    operations: [...table.operations, { kind: "APPEND" as const, addedRows: 1 }],
    changedSubtableRows: 2,
    payloadRows: [...table.payloadRows, { value: { 子: { value: "new" } } }],
    postImageRows: [...table.postImageRows, { value: { 子: { value: "new" } } }],
  };
  expect((applyPatchPlanToKintone({ ...plan, changedSubtableRows: 2, tables: [appended] })
    .records[0].record.テーブル.value as unknown[])).toHaveLength(3);
  expect(() => applyPatchPlanToKintone({
    ...plan,
    tables: [{
      ...appended,
      payloadRows: [appended.payloadRows[2], ...appended.payloadRows.slice(0, 2)],
    }],
  })).toThrow("must retain every snapshot row id in order");
});

test("PATCH_ONLY と FULL_SURVIVORS のtable単位shape混在を検証する", () => {
  const plan = basePlan();
  const converted = applyPatchPlanToKintone({
    ...plan,
    tables: [
      ...plan.tables,
      {
        table: "別表",
        operations: [{ kind: "REMOVE", removedRows: 1 }],
        payloadShape: "FULL_SURVIVORS",
        changedSubtableRows: 1,
        deletedRows: 1,
        snapshotRowIds: ["201", "202", "203"],
        removedRowIds: ["202"],
        payloadRows: [
          { id: "201", value: { 子: { value: "a" } } },
          { id: "203", value: { 子: { value: "c" } } },
        ],
        postImageRows: [
          { id: "201", value: { 子: { value: "a" } } },
          { id: "203", value: { 子: { value: "c" } } },
        ],
      },
    ],
  });
  expect((converted.records[0].record.別表.value as unknown[]).map((row) => (row as { id: string }).id))
    .toEqual(["201", "203"]);
});

test("FULL_SURVIVORS の列挙漏れ・集合交差を拒否する", () => {
  const plan = basePlan();
  const invalid = {
    table: "別表",
    operations: [{ kind: "REMOVE" as const, removedRows: 1 }],
    payloadShape: "FULL_SURVIVORS" as const,
    changedSubtableRows: 1,
    deletedRows: 1,
    snapshotRowIds: ["201", "202", "203"],
    removedRowIds: ["202"],
    payloadRows: [{ id: "201", value: { 子: { value: "a" } } }],
    postImageRows: [{ id: "201", value: { 子: { value: "a" } } }],
  };
  expect(() => applyPatchPlanToKintone({ ...plan, tables: [invalid] }))
    .toThrow("must retain every survivor in snapshot order");
  expect(() => applyPatchPlanToKintone({
    ...plan,
    tables: [{
      ...invalid,
      operations: [{ kind: "REMOVE", removedRows: 3 }],
      deletedRows: 3,
      removedRowIds: ["201", "202", "203"],
    }],
  })).toThrow("intersecting survivor/removed id 201");
});

test("FULL_SURVIVORS payloadの存続行からchild値を1つでも落とすと拒否しPUTしない", async () => {
  const putRecords = jest.fn(async (_params: unknown) => undefined);
  const plan = basePlan();
  const full = {
    table: "別表",
    operations: [{ kind: "REMOVE" as const, removedRows: 1 }],
    payloadShape: "FULL_SURVIVORS" as const,
    changedSubtableRows: 1,
    deletedRows: 1,
    snapshotRowIds: ["201", "202"],
    removedRowIds: ["202"],
    payloadRows: [{ id: "201", value: { 子: { value: "keep" } } }],
    postImageRows: [{ id: "201", value: { 子: { value: "keep" }, 未指定: { value: "also-keep" } } }],
  };
  await expect((async () => {
    const params = applyPatchPlanToKintone({ ...plan, tables: [full] });
    await putRecords(params);
  })()).rejects.toThrow("payload must contain every post-image child value");
  expect(putRecords).not.toHaveBeenCalled();
});

test("FULL_SURVIVORS plan/payloadからsnapshot存続rowを1件落とすとconverter拒否・PUT 0", async () => {
  const putRecords = jest.fn(async (_params: unknown) => undefined);
  const plan = basePlan();
  const omitted = {
    table: "別表",
    operations: [{ kind: "REMOVE" as const, removedRows: 1 }],
    payloadShape: "FULL_SURVIVORS" as const,
    changedSubtableRows: 1,
    deletedRows: 1,
    snapshotRowIds: ["201", "202", "203"],
    removedRowIds: ["202"],
    payloadRows: [{ id: "201", value: { 子: { value: "a" } } }],
    postImageRows: [{ id: "201", value: { 子: { value: "a" } } }],
  };
  await expect((async () => {
    const params = applyPatchPlanToKintone({ ...plan, tables: [omitted] });
    await putRecords(params);
  })()).rejects.toThrow("must retain every survivor in snapshot order");
  expect(putRecords).not.toHaveBeenCalled();
});
