import { parseSqlStatement } from "../sql";
import type { KintoneFieldInfo } from "../../execute";
import type { KintoneRecord } from "../../converter/dmlToKintone";
import type { UpdateStatement } from "../../types/ast";
import {
  buildApplyPatchPlan,
  collectApplySnapshotFields,
  resolveApplyPatchMetadata,
} from "../applyPatchPlanner";

const fields: KintoneFieldInfo[] = [
  { code: "親", label: "親", fieldType: "SINGLE_LINE_TEXT", writable: true },
  { code: "親数値", label: "親数値", fieldType: "NUMBER", writable: true },
  { code: "添付", label: "添付", fieldType: "FILE", writable: true },
  { code: "テーブル", label: "テーブル", fieldType: "SUBTABLE", writable: false },
  { code: "数値", label: "数値", fieldType: "NUMBER", writable: true, inSubtable: true, subtableCode: "テーブル" },
  { code: "結果", label: "結果", fieldType: "NUMBER", writable: true, inSubtable: true, subtableCode: "テーブル" },
  { code: "未指定", label: "未指定", fieldType: "SINGLE_LINE_TEXT", writable: true, inSubtable: true, subtableCode: "テーブル" },
  { code: "子添付", label: "子添付", fieldType: "FILE", writable: true, inSubtable: true, subtableCode: "テーブル" },
  { code: "別表", label: "別表", fieldType: "SUBTABLE", writable: false },
  { code: "別子", label: "別子", fieldType: "SINGLE_LINE_TEXT", writable: true, inSubtable: true, subtableCode: "別表" },
];

function statement(operations: string, parentSet = "親 = 'after'"): UpdateStatement {
  return parseSqlStatement(
    `UPDATE APP4221 SET ${parentSet} WHERE $id = 8 APPLY テーブル (${operations})`
  ) as UpdateStatement;
}

function snapshot(rows: Array<{ id: string; value: Record<string, { value: unknown }> }> = [
  { id: "101", value: { 数値: { value: "1" }, 結果: { value: "0" }, 未指定: { value: "keep-a" } } },
  { id: "102", value: { 数値: { value: "2" }, 結果: { value: "0" }, 未指定: { value: "keep-b" } } },
]): KintoneRecord {
  return {
    "$id": { value: "8" },
    "$revision": { value: "3" },
    親: { value: "before" },
    親数値: { value: "10" },
    テーブル: { value: rows },
    別表: { value: [] },
  } as unknown as KintoneRecord;
}

describe("collectApplySnapshotFields", () => {
  test("$id/$revision・全top-level/tableを重複なく集め、FILEとchild直指定を除外する", () => {
    expect(collectApplySnapshotFields(statement("PATCH SET 結果 = 1 ALL ROWS"), fields)).toEqual([
      "$id", "$revision", "親", "親数値", "テーブル", "別表",
    ]);
  });
});

describe("buildApplyPatchPlan", () => {
  test("全 selector/RHS と親SETを更新前snapshotで評価し、行順/id/未指定cellを保持する", () => {
    const stmt = statement(
      "PATCH SET 数値 = 数値 + 1 WHERE _rid = '101'; " +
      "PATCH SET 結果 = 数値 + 10 WHERE 数値 = 1",
      "親数値 = 親数値 + 1"
    );
    const plan = buildApplyPatchPlan({ statement: stmt, snapshot: snapshot(), fieldInfos: fields });
    expect(plan).toMatchObject({ app: 4221, parentId: 8, revision: 3, parentRows: 1, changedSubtableRows: 1 });
    expect(plan.parentValues).toEqual({ 親数値: { value: "11" } });
    expect(plan.tables[0].payloadShape).toBe("PATCH_ONLY");
    expect(plan.tables[0].payloadRows).toEqual([
      { id: "101", value: { 数値: { value: "2" }, 結果: { value: "11" } } },
      { id: "102" },
    ]);
    expect(plan.tables[0].postImageRows).toEqual([
      { id: "101", value: { 数値: { value: "2" }, 結果: { value: "11" }, 未指定: { value: "keep-a" } } },
      { id: "102", value: { 数値: { value: "2" }, 結果: { value: "0" }, 未指定: { value: "keep-b" } } },
    ]);
    expect(plan.postImage.別表).toEqual({ value: [] });
    expect(plan.postImage.親数値).toEqual({ value: "11" });
  });

  test.each([
    ["一般述語0行", "PATCH SET 結果 = 1 WHERE 数値 = 999", snapshot()],
    ["空table ALL ROWS", "PATCH SET 結果 = 1 ALL ROWS", snapshot([])],
  ])("%s は no-op plan", (_label, operation, record) => {
    const plan = buildApplyPatchPlan({ statement: statement(operation), snapshot: record, fieldInfos: fields });
    expect(plan.tables[0].payloadRows).toEqual(plan.tables[0].snapshotRowIds.map((id) => ({ id })));
    expect(plan.changedSubtableRows).toBe(0);
    expect(plan.tables[0]).toMatchObject({ changedSubtableRows: 0, deletedRows: 0 });
  });

  test("同一行の複数cellは1、異なる行は行数どおり distinct count にする", () => {
    const one = buildApplyPatchPlan({
      statement: statement("PATCH SET 結果 = 1, 数値 = 9 WHERE _rid = '101'"),
      snapshot: snapshot(), fieldInfos: fields,
    });
    expect(one.changedSubtableRows).toBe(1);

    const two = buildApplyPatchPlan({
      statement: statement("PATCH SET 結果 = 1 ALL ROWS"),
      snapshot: snapshot(), fieldInfos: fields,
    });
    expect(two.changedSubtableRows).toBe(2);
  });

  test("_rid 0行を ArgumentError にする", () => {
    expect(() => buildApplyPatchPlan({
      statement: statement("PATCH SET 結果 = 1 WHERE _rid = '999'"),
      snapshot: snapshot(), fieldInfos: fields,
    })).toThrow("ArgumentError: APPLY _rid 999 does not exist");
  });

  test("同一cell多重PATCHを拒否し、同一行別cellは許可する", () => {
    expect(() => buildApplyPatchPlan({
      statement: statement("PATCH SET 結果 = 1 ALL ROWS; PATCH SET 結果 = 2 WHERE _rid = '101'"),
      snapshot: snapshot(), fieldInfos: fields,
    })).toThrow("ArgumentError: APPLY patches cell 101.結果 more than once");
    expect(() => buildApplyPatchPlan({
      statement: statement("PATCH SET 結果 = 1 WHERE _rid = '101'; PATCH SET 数値 = 2 WHERE _rid = '101'"),
      snapshot: snapshot(), fieldInfos: fields,
    })).not.toThrow();
  });

  test("snapshot内の重複/未採番ridを拒否する", () => {
    const duplicate = snapshot([
      { id: "101", value: { 数値: { value: "1" } } },
      { id: "101", value: { 数値: { value: "2" } } },
    ]);
    expect(() => buildApplyPatchPlan({ statement: statement("PATCH SET 結果 = 1 ALL ROWS"), snapshot: duplicate, fieldInfos: fields }))
      .toThrow("duplicate _rid 101");
    expect(() => buildApplyPatchPlan({
      statement: statement("PATCH SET 結果 = 1 ALL ROWS"),
      snapshot: snapshot([{ id: "", value: {} }]), fieldInfos: fields,
    })).toThrow("row without _rid");
  });

  test("複数tableを1 planへ合成し、APPENDをsnapshot PATCHから不可視のまま末尾・記述順に置く", () => {
    const stmt = parseSqlStatement(
      "UPDATE APP4221 SET 親='after' WHERE $id=8 "
      + "APPLY テーブル (APPEND (結果) VALUES (7), (8); PATCH SET 数値=9 ALL ROWS) "
      + "APPLY 別表 (APPEND (別子) VALUES ('new'))"
    ) as UpdateStatement;
    const appendFields = fields.map((field) => field.code === "未指定" ? { ...field, defaultValue: "DEFAULT" } : field);
    const plan = buildApplyPatchPlan({ statement: stmt, snapshot: snapshot(), fieldInfos: appendFields });

    expect(plan.changedSubtableRows).toBe(5); // existing PATCH 2 + APPEND 2 + other table APPEND 1
    expect(plan.tables.map((table) => table.table)).toEqual(["テーブル", "別表"]);
    expect(plan.tables[0].operations).toEqual([
      { kind: "APPEND", addedRows: 2 },
      { kind: "PATCH", matchedRows: 2, changedRows: 2 },
    ]);
    expect(plan.tables[0].payloadRows).toEqual([
      { id: "101", value: { 数値: { value: "9" } } },
      { id: "102", value: { 数値: { value: "9" } } },
      { value: { 数値: { value: "" }, 結果: { value: "7" }, 未指定: { value: "DEFAULT" } } },
      { value: { 数値: { value: "" }, 結果: { value: "8" }, 未指定: { value: "DEFAULT" } } },
    ]);
    expect(plan.tables[0].postImageRows.slice(2).map((row) => row.value.結果.value)).toEqual(["7", "8"]);
    expect(plan.tables[1].payloadRows).toEqual([{ value: { 別子: { value: "new" } } }]);
  });

  test.each([
    ["先頭", "101", ["102", "103"]],
    ["中間", "102", ["101", "103"]],
    ["末尾", "103", ["101", "102"]],
  ])("REMOVE %s行はFULL_SURVIVORSで存続順と全値を保持する", (_label, rid, survivors) => {
    const record = snapshot([
      { id: "101", value: { 数値: { value: "1" }, 結果: { value: "11" }, 未指定: { value: "a" } } },
      { id: "102", value: { 数値: { value: "2" }, 結果: { value: "22" }, 未指定: { value: "b" } } },
      { id: "103", value: { 数値: { value: "3" }, 結果: { value: "33" }, 未指定: { value: "c" } } },
    ]);
    const plan = buildApplyPatchPlan({
      statement: statement(`REMOVE WHERE _rid='${rid}'`), snapshot: record, fieldInfos: fields,
    });
    const table = plan.tables[0];
    expect(table).toMatchObject({ payloadShape: "FULL_SURVIVORS", deletedRows: 1, changedSubtableRows: 1 });
    expect(table.operations).toEqual([{ kind: "REMOVE", removedRows: 1 }]);
    expect(table.postImageRows.map((row) => row.id)).toEqual(survivors);
    expect(table.payloadRows).toEqual(table.postImageRows);
  });

  test("複数REMOVE・全削除・0件一般述語・空table ALL ROWSをsnapshot上で解決する", () => {
    const multiple = buildApplyPatchPlan({
      statement: statement("REMOVE WHERE 数値 >= 1"), snapshot: snapshot(), fieldInfos: fields,
    });
    expect(multiple.tables[0]).toMatchObject({ payloadShape: "FULL_SURVIVORS", deletedRows: 2 });
    expect(multiple.tables[0].payloadRows).toEqual([]);

    const zero = buildApplyPatchPlan({
      statement: statement("REMOVE WHERE 数値 = 999"), snapshot: snapshot(), fieldInfos: fields,
    });
    expect(zero.tables[0]).toMatchObject({ payloadShape: "FULL_SURVIVORS", deletedRows: 0, changedSubtableRows: 0 });
    expect(zero.tables[0].payloadRows).toEqual(zero.tables[0].postImageRows);

    const empty = buildApplyPatchPlan({
      statement: statement("REMOVE ALL ROWS"), snapshot: snapshot([]), fieldInfos: fields,
    });
    expect(empty.tables[0]).toMatchObject({ payloadShape: "FULL_SURVIVORS", deletedRows: 0 });
    expect(empty.tables[0].payloadRows).toEqual([]);
  });

  test("REMOVE tableだけFULL_SURVIVORSにし、APPENDは削除selectorから不可視・存続行末尾に置く", () => {
    const stmt = parseSqlStatement(
      "UPDATE APP4221 SET 親='after' WHERE $id=8 "
      + "APPLY テーブル (APPEND (結果) VALUES (7), (8); REMOVE WHERE 数値=7) "
      + "APPLY 別表 (APPEND (別子) VALUES ('new'))"
    ) as UpdateStatement;
    const plan = buildApplyPatchPlan({ statement: stmt, snapshot: snapshot(), fieldInfos: fields });
    expect(plan.tables.map((table) => table.payloadShape)).toEqual(["FULL_SURVIVORS", "PATCH_ONLY"]);
    expect(plan.tables[0]).toMatchObject({ deletedRows: 0, changedSubtableRows: 2 });
    expect(plan.tables[0].postImageRows.map((row) => row.id)).toEqual(["101", "102", undefined, undefined]);
    expect(plan.tables[0].postImageRows.slice(2).map((row) => row.value.結果.value)).toEqual(["7", "8"]);
  });

  test("PATCH/REMOVE行重複と同一行の複数REMOVEをPUT plan前に拒否する", () => {
    expect(() => buildApplyPatchPlan({
      statement: statement("PATCH SET 結果=1 WHERE _rid='101'; REMOVE WHERE _rid='101'"),
      snapshot: snapshot(), fieldInfos: fields,
    })).toThrow("ArgumentError: APPLY row 101 is selected by both PATCH and REMOVE");
    expect(() => buildApplyPatchPlan({
      statement: statement("REMOVE WHERE _rid='101'; PATCH SET 結果=1 WHERE _rid='101'"),
      snapshot: snapshot(), fieldInfos: fields,
    })).toThrow("ArgumentError: APPLY row 101 is selected by both PATCH and REMOVE");
    expect(() => buildApplyPatchPlan({
      statement: statement("REMOVE WHERE _rid='101'; REMOVE WHERE 数値=1"),
      snapshot: snapshot(), fieldInfos: fields,
    })).toThrow("ArgumentError: APPLY removes row 101 more than once");
  });
});

describe("resolveApplyPatchMetadata", () => {
  test("別table child・非writable/system代入を records API 前契約として拒否する", () => {
    expect(() => resolveApplyPatchMetadata(statement("PATCH SET 別子 = 'x' ALL ROWS"), fields))
      .toThrow("does not belong to subtable テーブル");
    const nonWritable = [...fields, { code: "計算", label: "計算", fieldType: "CALC", writable: false, inSubtable: true, subtableCode: "テーブル" }];
    expect(() => resolveApplyPatchMetadata(statement("PATCH SET 計算 = 1 ALL ROWS"), nonWritable))
      .toThrow("is not writable (CALC)");
    expect(() => resolveApplyPatchMetadata(statement("PATCH SET _rid = 'x' ALL ROWS"), fields))
      .toThrow("is a system field");
  });


  test("APPEND指定field重複とFILE指定をrecords API前に拒否する", () => {
    expect(() => resolveApplyPatchMetadata(statement("APPEND (結果, 結果) VALUES (1, 2)"), fields))
      .toThrow("ArgumentError: APPLY APPEND specifies child 結果 more than once");
    expect(() => resolveApplyPatchMetadata(statement("APPEND (子添付) VALUES ('x')"), fields))
      .toThrow("ArgumentError: APPLY assignment target 子添付 is not writable (FILE)");
  });
});
