import type { KintoneRecord } from "../../converter/dmlToKintone";
import type { KintoneFieldInfo } from "../../execute";
import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";
import type { UpdateStatement } from "../../types/ast";
import { prepareApplyPatchWrite } from "../applyPatchPrepare";
import { resolveApplyPatchMetadata } from "../applyPatchPlanner";

const fields: KintoneFieldInfo[] = [
  { code: "親", label: "親", fieldType: "SINGLE_LINE_TEXT", writable: true },
  { code: "タグ", label: "タグ", fieldType: "MULTI_SELECT", writable: true, optionOrder: { A: 0, B: 1, C: 2 } },
  { code: "担当", label: "担当", fieldType: "USER_SELECT", writable: true },
  { code: "表", label: "表", fieldType: "SUBTABLE", writable: false },
  { code: "子", label: "子", fieldType: "SINGLE_LINE_TEXT", writable: true, inSubtable: true, subtableCode: "表" },
];

function parse(sql: string): UpdateStatement {
  return new Parser(new Lexer(sql).tokenize()).parse() as UpdateStatement;
}

function snapshot(id: number, tags: string[], users: string[]): KintoneRecord {
  return {
    "$id": { value: String(id) },
    "$revision": { value: String(id + 10) },
    親: { value: "before" },
    タグ: { value: tags },
    担当: { value: users.map((code) => ({ code, name: code.toUpperCase() })) },
    表: { value: [{ id: `r${id}`, value: { 子: { value: "old" } } }] },
  } as unknown as KintoneRecord;
}

test("複数親を各snapshotで独立計画し、SET・string[]・{code}[]・SUBTABLEを1親1PUT recordへ合成する", async () => {
  const stmt = parse(
    "UPDATE APP4221 SET 親='after' WHERE 親='before' "
    + "APPLY タグ (REMOVE 'A'; ADD 'C') "
    + "APPLY 担当 (REMOVE 'u1'; ADD 'u3') "
    + "APPLY 表 (PATCH SET 子='patched' ALL ROWS)"
  );
  const prepared = await prepareApplyPatchWrite({
    statement: stmt,
    snapshots: [snapshot(1, ["A", "B"], ["u1", "u2"]), snapshot(2, ["B"], ["u2"])],
    fieldInfos: fields,
    metadata: resolveApplyPatchMetadata(stmt, fields),
    dmlMaxRows: 2,
    dmlMaxSubtableRows: 2,
  });

  expect(prepared.records).toHaveLength(2);
  expect(prepared.records[0]).toMatchObject({
    id: 1, revision: 11,
    record: {
      親: { value: "after" },
      タグ: { value: ["B", "C"] },
      担当: { value: [{ code: "u2" }, { code: "u3" }] },
      表: { value: [{ id: "r1", value: { 子: { value: "patched" } } }] },
    },
  });
  expect(prepared.records[1]).toMatchObject({
    id: 2, revision: 12,
    record: {
      タグ: { value: ["B", "C"] },
      担当: { value: [{ code: "u2" }, { code: "u3" }] },
    },
  });
  expect(prepared.guards).toMatchObject({ parentRows: 2, subtableRows: 2 });
});

test("全要素REMOVE後のrequiredはmutationを拒否し、VALIDATE ONLYはERR_REQUIRED診断を保持する", async () => {
  const requiredFields = fields.map((item) => item.code === "タグ" ? { ...item, required: true } : item);
  const mutation = parse("UPDATE APP4221 SET 親='after' WHERE $id=1 APPLY タグ (REMOVE 'A')");
  const input = {
    statement: mutation,
    snapshots: [snapshot(1, ["A"], [])],
    fieldInfos: requiredFields,
    metadata: resolveApplyPatchMetadata(mutation, requiredFields),
    dmlMaxRows: 1,
    dmlMaxSubtableRows: 1,
  };
  await expect(prepareApplyPatchWrite(input)).rejects.toThrow(/APPLY post-image validation failed.*ERR_REQUIRED/);

  const validation = { ...mutation, validateOnly: true };
  const prepared = await prepareApplyPatchWrite({
    ...input,
    statement: validation,
    metadata: resolveApplyPatchMetadata(validation, requiredFields),
  });
  expect(prepared.validations[0].errors).toEqual([
    expect.objectContaining({ $err_field: "タグ", $err_code: "ERR_REQUIRED" }),
  ]);
});

test.each(["CHECK_BOX", "MULTI_SELECT"])(
  "%sの定義外ADDはmutationを拒否し、VALIDATE ONLYはERR_CHOICE_INVALID診断にする",
  async (fieldType) => {
    const choiceFields = fields.map((item) => item.code === "タグ" ? { ...item, fieldType } : item);
    const mutation = parse("UPDATE APP4221 SET 親='after' WHERE $id=1 APPLY タグ (ADD 'X')");
    const input = {
      statement: mutation,
      snapshots: [snapshot(1, ["A"], [])],
      fieldInfos: choiceFields,
      metadata: resolveApplyPatchMetadata(mutation, choiceFields),
      dmlMaxRows: 1,
      dmlMaxSubtableRows: 1,
    };
    await expect(prepareApplyPatchWrite(input)).rejects.toThrow(/APPLY post-image validation failed.*ERR_CHOICE_INVALID/);
    const validation = { ...mutation, validateOnly: true };
    const prepared = await prepareApplyPatchWrite({
      ...input,
      statement: validation,
      metadata: resolveApplyPatchMetadata(validation, choiceFields),
    });
    expect(prepared.records[0].record.タグ).toEqual({ value: ["A", "X"] });
    expect(prepared.validations[0].errors).toEqual([
      expect.objectContaining({ $err_field: "タグ", $err_code: "ERR_CHOICE_INVALID" }),
    ]);
  }
);

test("metadataは多値op→SUBTABLE、行op→多値、親SETとの同一fieldをrecords API前ArgumentErrorにする", () => {
  const multiOnTable = parse("UPDATE APP4221 SET 親='x' WHERE $id=1 APPLY 表 (ADD 'A')");
  expect(() => resolveApplyPatchMetadata(multiOnTable, fields)).toThrow(/multi-value operations require/);

  const rowsOnMulti = parse("UPDATE APP4221 SET 親='x' WHERE $id=1 APPLY タグ (REMOVE ALL ROWS)");
  expect(() => resolveApplyPatchMetadata(rowsOnMulti, fields)).toThrow(/row operations require a SUBTABLE/);

  const duplicateSet = parse("UPDATE APP4221 SET タグ=['A'] WHERE $id=1 APPLY タグ (ADD 'B')");
  expect(() => resolveApplyPatchMetadata(duplicateSet, fields)).toThrow("APPLY target タグ is also assigned by parent SET");
});
