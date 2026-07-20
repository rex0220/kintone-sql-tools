import { applyPatchPlanToKintone } from "../../converter/applyPatchToKintone";
import type { KintoneRecord } from "../../converter/dmlToKintone";
import type { KintoneFieldInfo } from "../../execute";
import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";
import type { UpdateStatement } from "../../types/ast";
import { prepareApplyPatchWrite } from "../applyPatchPrepare";
import { resolveApplyPatchMetadata } from "../applyPatchPlanner";

const fields: KintoneFieldInfo[] = [
  { code: "親", label: "親", fieldType: "SINGLE_LINE_TEXT", writable: true },
  { code: "テーブル", label: "テーブル", fieldType: "SUBTABLE", writable: false },
  { code: "子", label: "子", fieldType: "SINGLE_LINE_TEXT", writable: true, inSubtable: true, subtableCode: "テーブル" },
];

function statement(validateOnly = false): UpdateStatement {
  return new Parser(new Lexer(
    "UPDATE APP4221 SET 親='after' WHERE 親='before' "
      + `APPLY テーブル (PATCH SET 子='patched' ALL ROWS)${validateOnly ? " VALIDATE ONLY" : ""}`
  ).tokenize()).parse() as UpdateStatement;
}

function snapshot(id: number, revision = id + 10): KintoneRecord {
  return {
    "$id": { value: String(id) },
    "$revision": { value: String(revision) },
    親: { value: "before" },
    テーブル: { value: [{ id: `r${id}`, value: { 子: { value: "old" } } }] },
  } as unknown as KintoneRecord;
}

test.each([0, 1, 2, 100])("prepareは%i親を全件plan/validate/guardしimmutable converter材料を返す", async (count) => {
  const stmt = statement();
  const writer = jest.fn();
  const prepared = await prepareApplyPatchWrite({
    statement: stmt,
    snapshots: Array.from({ length: count }, (_, index) => snapshot(index + 1)),
    fieldInfos: fields,
    metadata: resolveApplyPatchMetadata(stmt, fields),
    dmlMaxRows: 100,
    dmlMaxSubtableRows: 100,
    // Deliberately injected through an untyped caller: prepare has no writer slot and ignores it.
    writer,
  } as Parameters<typeof prepareApplyPatchWrite>[0] & { writer: typeof writer });

  expect(prepared.plans).toHaveLength(count);
  expect(prepared.validations).toHaveLength(count);
  expect(prepared.records).toHaveLength(count);
  expect(prepared.guards).toMatchObject({ parentRows: count, subtableRows: count, wouldExceed: false });
  expect(writer).not.toHaveBeenCalled();
  expect(Object.isFrozen(prepared)).toBe(true);
  expect(Object.isFrozen(prepared.plans)).toBe(true);
  if (count > 0) {
    expect(prepared.records[0]).toEqual(applyPatchPlanToKintone(prepared.plans[0]).records[0]);
    expect(Object.isFrozen(prepared.plans[0].tables)).toBe(true);
  }
});

test("prepareはrevision欠落・非正整数、子guard超過をconverter/write境界前に拒否する", async () => {
  const stmt = statement();
  const metadata = resolveApplyPatchMetadata(stmt, fields);
  for (const revision of [undefined, "0", "x", "1.5"]) {
    const record = snapshot(1);
    record["$revision"] = { value: revision as never };
    await expect(prepareApplyPatchWrite({
      statement: stmt, snapshots: [record], fieldInfos: fields, metadata,
      dmlMaxRows: 1, dmlMaxSubtableRows: 1,
    })).rejects.toThrow("ArgumentError: APPLY snapshot $revision must be a positive integer");
  }

  await expect(prepareApplyPatchWrite({
    statement: stmt, snapshots: [snapshot(1), snapshot(2)], fieldInfos: fields, metadata,
    dmlMaxRows: 2, dmlMaxSubtableRows: 1,
  })).rejects.toThrow("ArgumentError: APPLY changed subtable rows (2) exceed dmlMaxSubtableRows (1)");
});

test("VALIDATE ONLY preparedは101親guard超過をwouldExceed診断として保持する", async () => {
  const stmt = statement(true);
  const prepared = await prepareApplyPatchWrite({
    statement: stmt,
    snapshots: Array.from({ length: 101 }, (_, index) => snapshot(index + 1)),
    fieldInfos: fields,
    metadata: resolveApplyPatchMetadata(stmt, fields),
    dmlMaxRows: 100,
    dmlMaxSubtableRows: 101,
  });
  expect(prepared.guards).toMatchObject({ parentRows: 101, subtableRows: 101, wouldExceed: true });
});
