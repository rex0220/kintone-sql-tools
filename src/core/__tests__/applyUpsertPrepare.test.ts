import type { KintoneRecord } from "../../converter/dmlToKintone";
import type { KintoneFieldInfo } from "../../execute";
import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";
import type { UpsertStatement } from "../../types/ast";
import { prepareApplyUpsert, type ApplyUpsertMatch } from "../applyUpsertPrepare";

const fields: KintoneFieldInfo[] = [
  { code: "key", label: "key", fieldType: "SINGLE_LINE_TEXT", writable: true, required: true },
  { code: "親", label: "親", fieldType: "SINGLE_LINE_TEXT", writable: true, required: true },
  { code: "親既定", label: "親既定", fieldType: "SINGLE_LINE_TEXT", writable: true, defaultValue: "PDEF" },
  { code: "表", label: "表", fieldType: "SUBTABLE", writable: false },
  { code: "子", label: "子", fieldType: "SINGLE_LINE_TEXT", writable: true, inSubtable: true, subtableCode: "表" },
  { code: "子既定", label: "子既定", fieldType: "DROP_DOWN", writable: true, inSubtable: true, subtableCode: "表", defaultValue: "A", optionOrder: { A: 0, B: 1 } },
];

function parse(sql: string): UpsertStatement {
  return new Parser(new Lexer(sql).tokenize()).parse() as UpsertStatement;
}

function snapshot(id: number): KintoneRecord {
  return {
    "$id": { value: String(id) },
    "$revision": { value: String(id + 10) },
    key: { value: "KOLD" },
    親: { value: "old-parent" },
    親既定: { value: "existing-default" },
    表: { value: [
      { id: `r${id}-1`, value: { 子: { value: "patch" }, 子既定: { value: "A" } } },
      { id: `r${id}-2`, value: { 子: { value: "remove" }, 子既定: { value: "B" } } },
    ] },
  } as unknown as KintoneRecord;
}

const mixedSql = "UPSERT INTO APP4221 (key, 親) VALUES ('KNEW', 'new-parent'), ('KOLD', 'updated-parent') "
  + "ON DUPLICATE (key) "
  + "ON INSERT APPLY 表 (APPEND (子) VALUES ('initial')) "
  + "ON UPDATE APPLY 表 (PATCH SET 子='patched' WHERE 子='patch'; APPEND (子) VALUES ('added'); REMOVE WHERE 子='remove')";

test("create=Phase13b/update=Phase10bを再利用し、混在POST/PUT材料を全件immutable preparedへ統合する", async () => {
  const stmt = parse(mixedSql);
  const writer = jest.fn();
  const matches: ApplyUpsertMatch[] = [
    { sourceRowIndex: 0 },
    { sourceRowIndex: 1, targetId: 9, snapshot: snapshot(9) },
  ];
  const prepared = await prepareApplyUpsert({
    statement: stmt,
    matches,
    fieldInfos: fields,
    dmlMaxRows: 2,
    dmlMaxSubtableRows: 4,
    writer,
  } as Parameters<typeof prepareApplyUpsert>[0] & { writer: typeof writer });

  expect(prepared.guards).toMatchObject({ parentRows: 2, subtableRows: 4, wouldExceed: false });
  expect(prepared.create.guards).toMatchObject({ parentRows: 1, subtableRows: 1, revisionRequired: false });
  expect(prepared.update.guards).toMatchObject({ parentRows: 1, subtableRows: 3, revisionRequired: true });
  expect(prepared.createBatches[0].records[0]).toMatchObject({
    key: { value: "KNEW" },
    親: { value: "new-parent" },
    表: { value: [{ value: { 子: { value: "initial" }, 子既定: { value: "A" } } }] },
  });
  expect(prepared.create.candidates[0].postImage.親既定).toEqual({ value: "PDEF" });
  expect(prepared.updateBatches[0].records[0]).toMatchObject({
    id: 9,
    revision: 19,
    record: { key: { value: "KOLD" }, 親: { value: "updated-parent" } },
  });
  expect(prepared.update.plans[0].postImage.表.value).toEqual([
    { id: "r9-1", value: { 子: { value: "patched" }, 子既定: { value: "A" } } },
    { value: { 子: { value: "added" }, 子既定: { value: "A" } } },
  ]);
  expect(writer).not.toHaveBeenCalled();
  expect(Object.isFrozen(prepared)).toBe(true);
  expect(Object.isFrozen(prepared.createBatches)).toBe(true);
  expect(Object.isFrozen(prepared.updateBatches)).toBe(true);
  expect(prepared).not.toHaveProperty("client");
  expect(prepared).not.toHaveProperty("writer");
});

test.each([
  ["all create", [{ sourceRowIndex: 0 }, { sourceRowIndex: 1 }], 2, 0],
  ["all update", [
    { sourceRowIndex: 0, targetId: 8, snapshot: snapshot(8) },
    { sourceRowIndex: 1, targetId: 9, snapshot: snapshot(9) },
  ], 0, 2],
])("分岐 %s", async (_label, matches, creates, updates) => {
  const prepared = await prepareApplyUpsert({
    statement: parse(`${mixedSql} VALIDATE ONLY`),
    matches: matches as ApplyUpsertMatch[],
    fieldInfos: fields,
    dmlMaxRows: 2,
    dmlMaxSubtableRows: 8,
  });
  expect(prepared.create.guards.parentRows).toBe(creates);
  expect(prepared.update.guards.parentRows).toBe(updates);
});

test("分岐省略はcreate=kintone既定、update=既存subtable保持、両省略=子変更0", async () => {
  const insertOnly = parse("UPSERT INTO APP4221 (key, 親) VALUES ('KNEW', 'n'), ('KOLD', 'u') ON DUPLICATE (key) "
    + "ON INSERT APPLY 表 (APPEND (子) VALUES ('initial')) VALIDATE ONLY");
  const insertPrepared = await prepareApplyUpsert({
    statement: insertOnly,
    matches: [{ sourceRowIndex: 0 }, { sourceRowIndex: 1, targetId: 9, snapshot: snapshot(9) }],
    fieldInfos: fields, dmlMaxRows: 2, dmlMaxSubtableRows: 1,
  });
  expect(insertPrepared.update.guards.subtableRows).toBe(0);
  expect(insertPrepared.update.records[0].record).not.toHaveProperty("表");
  expect(insertPrepared.update.plans[0].postImage.表).toEqual(snapshot(9).表);

  const updateOnly = parse("UPSERT INTO APP4221 (key, 親) VALUES ('KNEW', 'n'), ('KOLD', 'u') ON DUPLICATE (key) "
    + "ON UPDATE APPLY 表 (PATCH SET 子='patched' WHERE 子='patch') VALIDATE ONLY");
  const updatePrepared = await prepareApplyUpsert({
    statement: updateOnly,
    matches: [{ sourceRowIndex: 0 }, { sourceRowIndex: 1, targetId: 9, snapshot: snapshot(9) }],
    fieldInfos: fields, dmlMaxRows: 2, dmlMaxSubtableRows: 1,
  });
  expect(updatePrepared.create.guards.subtableRows).toBe(0);
  expect(updatePrepared.create.records[0]).not.toHaveProperty("表");

  const omitted = parse("UPSERT INTO APP4221 (key, 親) VALUES ('KNEW', 'n'), ('KOLD', 'u') ON DUPLICATE (key) VALIDATE ONLY");
  const omittedPrepared = await prepareApplyUpsert({
    statement: omitted,
    matches: [{ sourceRowIndex: 0 }, { sourceRowIndex: 1, targetId: 9, snapshot: snapshot(9) }],
    fieldInfos: fields, dmlMaxRows: 2, dmlMaxSubtableRows: 1,
  });
  expect(omittedPrepared.guards.subtableRows).toBe(0);
});

test("混在二重guard・post-image・重複targetをwrite境界前に拒否し、VALIDATE ONLYはwouldExceedを返す", async () => {
  const stmt = parse(mixedSql);
  const matches: ApplyUpsertMatch[] = [
    { sourceRowIndex: 0 },
    { sourceRowIndex: 1, targetId: 9, snapshot: snapshot(9) },
  ];
  await expect(prepareApplyUpsert({
    statement: stmt, matches, fieldInfos: fields, dmlMaxRows: 1, dmlMaxSubtableRows: 4,
  })).rejects.toThrow("ArgumentError: APPLY parent rows (2) exceed dmlMaxRows (1)");
  await expect(prepareApplyUpsert({
    statement: stmt, matches, fieldInfos: fields, dmlMaxRows: 2, dmlMaxSubtableRows: 3,
  })).rejects.toThrow("ArgumentError: APPLY changed subtable rows (4) exceed dmlMaxSubtableRows (3)");

  const validation = await prepareApplyUpsert({
    statement: parse(`${mixedSql} VALIDATE ONLY`), matches, fieldInfos: fields,
    dmlMaxRows: 1, dmlMaxSubtableRows: 3,
  });
  expect(validation.guards).toMatchObject({ parentRows: 2, subtableRows: 4, wouldExceed: true });

  await expect(prepareApplyUpsert({
    statement: stmt,
    matches: [
      { sourceRowIndex: 0, targetId: 9, snapshot: snapshot(9) },
      { sourceRowIndex: 1, targetId: 9, snapshot: snapshot(9) },
    ],
    fieldInfos: fields, dmlMaxRows: 2, dmlMaxSubtableRows: 8,
  })).rejects.toThrow("resolves more than one source row to parent $id 9");

  const requiredChildFields = fields.map((field) => field.code === "子"
    ? { ...field, required: true, defaultValue: undefined }
    : field);
  const invalidCreate = parse("UPSERT INTO APP4221 (key, 親) VALUES ('KNEW', 'n') ON DUPLICATE (key) "
    + "ON INSERT APPLY 表 (APPEND (子既定) VALUES ('A'))");
  await expect(prepareApplyUpsert({
    statement: invalidCreate,
    matches: [{ sourceRowIndex: 0 }],
    fieldInfos: requiredChildFields,
    dmlMaxRows: 1,
    dmlMaxSubtableRows: 1,
  })).rejects.toThrow(/APPLY post-image validation failed.*ERR_REQUIRED/);
});
