import type { ApplyPatchPlan } from "../../core/applyPatchPlanner";
import { applyPatchPlanToKintone, requireRevision } from "../applyPatchToKintone";
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

test("PATCH_ONLY と FULL_SURVIVORS のtable単位shape混在を検証する", () => {
  const plan = basePlan();
  const converted = applyPatchPlanToKintone({
    ...plan,
    tables: [
      ...plan.tables,
      {
        table: "別表",
        operations: [{ kind: "PATCH", matchedRows: 1, changedRows: 1 }],
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
    operations: [{ kind: "PATCH" as const, matchedRows: 1, changedRows: 1 }],
    payloadShape: "FULL_SURVIVORS" as const,
    changedSubtableRows: 1,
    deletedRows: 1,
    snapshotRowIds: ["201", "202", "203"],
    removedRowIds: ["202"],
    payloadRows: [{ id: "201", value: { 子: { value: "a" } } }],
    postImageRows: [{ id: "201", value: { 子: { value: "a" } } }],
  };
  expect(() => applyPatchPlanToKintone({ ...plan, tables: [invalid] }))
    .toThrow("does not partition every snapshot row");
  expect(() => applyPatchPlanToKintone({
    ...plan,
    tables: [{ ...invalid, removedRowIds: ["201", "202", "203"] }],
  })).toThrow("intersecting survivor/removed id 201");
});
