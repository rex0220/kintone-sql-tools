import type { KintoneFieldInfo } from "../../execute";
import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";
import type { InsertStatement } from "../../types/ast";
import {
  prepareApplyInsert,
  resolveApplyInsertMetadata,
} from "../applyInsertPrepare";

const fields: KintoneFieldInfo[] = [
  { code: "親", label: "親", fieldType: "SINGLE_LINE_TEXT", writable: true, required: true },
  { code: "親既定", label: "親既定", fieldType: "SINGLE_LINE_TEXT", writable: true, defaultValue: "PDEF" },
  { code: "親添付", label: "親添付", fieldType: "FILE", writable: true },
  { code: "自動", label: "自動", fieldType: "SINGLE_LINE_TEXT", writable: false },
  { code: "表A", label: "表A", fieldType: "SUBTABLE", writable: false },
  { code: "子文字", label: "子文字", fieldType: "SINGLE_LINE_TEXT", writable: true, inSubtable: true, subtableCode: "表A" },
  { code: "子既定", label: "子既定", fieldType: "DROP_DOWN", writable: true, inSubtable: true, subtableCode: "表A", defaultValue: "A", optionOrder: { A: 0, B: 1 } },
  { code: "子添付", label: "子添付", fieldType: "FILE", writable: true, inSubtable: true, subtableCode: "表A" },
  { code: "子自動", label: "子自動", fieldType: "SINGLE_LINE_TEXT", writable: false, inSubtable: true, subtableCode: "表A" },
  { code: "表B", label: "表B", fieldType: "SUBTABLE", writable: false },
  { code: "別子", label: "別子", fieldType: "NUMBER", writable: true, inSubtable: true, subtableCode: "表B" },
];

function parse(sql: string): InsertStatement {
  return new Parser(new Lexer(sql).tokenize()).parse() as InsertStatement;
}

const multiSql = "INSERT INTO APP4221 (親) VALUES ('p1'), ('p2') "
  + "APPLY 表A (APPEND (子文字) VALUES ('a1'), ('a2')) "
  + "APPLY 表B (APPEND (別子) VALUES (1))";

test("VALUES各親へ同じAPPEND templateを適用し、既定値を明示した複数table POST材料を返す", async () => {
  const stmt = parse(multiSql);
  const writer = jest.fn();
  const prepared = await prepareApplyInsert({
    statement: stmt,
    fieldInfos: fields,
    metadata: resolveApplyInsertMetadata(stmt, fields),
    dmlMaxRows: 2,
    dmlMaxSubtableRows: 6,
    loadNumberPrecision: async () => ({ digits: 10, decimalPlaces: 2, roundingMode: "HALF_EVEN" }),
    writer,
  } as Parameters<typeof prepareApplyInsert>[0] & { writer: typeof writer });

  expect(prepared.guards).toEqual({
    revisionRequired: false,
    parentRows: 2,
    dmlMaxRows: 2,
    subtableRows: 6,
    dmlMaxSubtableRows: 6,
    wouldExceed: false,
  });
  expect(prepared.records).toHaveLength(2);
  expect(prepared.batches).toHaveLength(1);
  expect(prepared.batches[0].records).toHaveLength(2);
  expect(prepared.records.map((record) => record.表A.value)).toEqual([
    [
      { value: { 子文字: { value: "a1" }, 子既定: { value: "A" } } },
      { value: { 子文字: { value: "a2" }, 子既定: { value: "A" } } },
    ],
    [
      { value: { 子文字: { value: "a1" }, 子既定: { value: "A" } } },
      { value: { 子文字: { value: "a2" }, 子既定: { value: "A" } } },
    ],
  ]);
  expect(prepared.records[0].表B.value).toEqual([{ value: { 別子: { value: "1" } } }]);
  expect(prepared.records[0].表A.value).not.toBe(prepared.records[1].表A.value);
  const firstChild = (prepared.records[0].表A.value as unknown as Array<{ value: Record<string, unknown> }>)[0].value;
  expect(firstChild).not.toHaveProperty("子添付");
  expect(firstChild).not.toHaveProperty("子自動");
  // Top-level defaults participate in complete post-image validation, while ordinary INSERT-compatible
  // POST material leaves them omitted for kintone to apply.
  expect(prepared.candidates[0].postImage.親既定).toEqual({ value: "PDEF" });
  expect(prepared.records[0]).not.toHaveProperty("親既定");
  expect(prepared.records[0]).not.toHaveProperty("親添付");
  expect(prepared.records[0]).not.toHaveProperty("自動");
  expect(writer).not.toHaveBeenCalled();
  expect(Object.isFrozen(prepared)).toBe(true);
  expect(Object.isFrozen(prepared.batches[0].records)).toBe(true);
});

test("prepared POST材料は100件chunkでimmutable、prepareはwriterを持たない", async () => {
  const stmt = parse("INSERT INTO APP4221 (親) VALUES ('p') APPLY 表A (APPEND (子文字) VALUES ('c'))");
  stmt.values = Array.from({ length: 101 }, (_, index) => [{ type: "STRING", value: `p${index + 1}` }]);
  const prepared = await prepareApplyInsert({
    statement: stmt,
    fieldInfos: fields,
    dmlMaxRows: 101,
    dmlMaxSubtableRows: 101,
  });
  expect(prepared.batches.map((batch) => batch.records.length)).toEqual([100, 1]);
  expect(prepared.batches.every((batch) => batch.app === 4221)).toBe(true);
  expect(Object.isFrozen(prepared.batches)).toBe(true);
  expect(Object.isFrozen(prepared.records[0])).toBe(true);
});

test("全create post-imageでrequired・型・選択肢・長さ・数値精度を検証する", async () => {
  const constrained: KintoneFieldInfo[] = [
    ...fields.map((field) => field.code === "親" ? { ...field, maxLength: "2" } : field),
    { code: "必須表", label: "必須表", fieldType: "SUBTABLE", writable: false },
    { code: "必須子", label: "必須子", fieldType: "SINGLE_LINE_TEXT", writable: true, required: true, inSubtable: true, subtableCode: "必須表" },
    { code: "選択", label: "選択", fieldType: "DROP_DOWN", writable: true, inSubtable: true, subtableCode: "必須表", optionOrder: { OK: 0 } },
    { code: "精度", label: "精度", fieldType: "NUMBER", writable: true, inSubtable: true, subtableCode: "必須表" },
  ];
  const stmt = parse("INSERT INTO APP4221 (親) VALUES ('toolong') "
    + "APPLY 必須表 (APPEND (選択, 精度) VALUES ('NG', 'not-number')) VALIDATE ONLY");
  const prepared = await prepareApplyInsert({
    statement: stmt,
    fieldInfos: constrained,
    dmlMaxRows: 1,
    dmlMaxSubtableRows: 1,
    loadNumberPrecision: async () => ({ digits: 3, decimalPlaces: 1, roundingMode: "HALF_EVEN" }),
  });
  expect(prepared.validations[0].errors.map((error) => [error.$err_field, error.$err_code])).toEqual(expect.arrayContaining([
    ["親", "ERR_LENGTH_MAX"],
    ["必須子", "ERR_REQUIRED"],
    ["選択", "ERR_CHOICE_INVALID"],
    ["精度", "ERR_TYPE_NUMBER"],
  ]));
  expect(prepared.validations[0].errors.every((error) => error.$err_operation === "INSERT")).toBe(true);

  const precisionStmt = parse("INSERT INTO APP4221 (親) VALUES ('ok') "
    + "APPLY 表B (APPEND (別子) VALUES (123)) VALIDATE ONLY");
  const precision = await prepareApplyInsert({
    statement: precisionStmt,
    fieldInfos: fields,
    dmlMaxRows: 1,
    dmlMaxSubtableRows: 1,
    loadNumberPrecision: async () => ({ digits: 3, decimalPlaces: 1, roundingMode: "HALF_EVEN" }),
  });
  expect(precision.validations[0].errors[0]).toMatchObject({
    $err_field: "別子",
    $err_code: "ERR_NUMBER_INTEGER_DIGITS",
  });
});

test("required child/parent missingはmutation preparedを拒否し、validate-onlyは診断だけ返す", async () => {
  const required = fields.map((field) =>
    field.code === "子文字" ? { ...field, required: true, defaultValue: undefined } : field
  );
  const childStmt = parse("INSERT INTO APP4221 (親) VALUES ('ok') APPLY 表A (APPEND (子既定) VALUES ('A'))");
  await expect(prepareApplyInsert({
    statement: childStmt,
    fieldInfos: required,
    dmlMaxRows: 1,
    dmlMaxSubtableRows: 1,
  })).rejects.toThrow(/APPLY post-image validation failed.*ERR_REQUIRED/);

  const parentStmt = parse("INSERT INTO APP4221 (親既定) VALUES ('x') APPLY 表A (APPEND (子文字) VALUES ('c')) VALIDATE ONLY");
  const parent = await prepareApplyInsert({
    statement: parentStmt,
    fieldInfos: fields,
    dmlMaxRows: 1,
    dmlMaxSubtableRows: 1,
  });
  expect(parent.validations[0].errors[0]).toMatchObject({ $err_field: "親", $err_code: "ERR_REQUIRED" });
});

test("親件数と初期子行合計の二重guardを全件prepare後・POST前に強制する", async () => {
  const stmt = parse(multiSql);
  await expect(prepareApplyInsert({
    statement: stmt, fieldInfos: fields, dmlMaxRows: 1, dmlMaxSubtableRows: 6,
    loadNumberPrecision: async () => ({ digits: 10, decimalPlaces: 2, roundingMode: "HALF_EVEN" }),
  })).rejects.toThrow("ArgumentError: APPLY parent rows (2) exceed dmlMaxRows (1)");
  await expect(prepareApplyInsert({
    statement: stmt, fieldInfos: fields, dmlMaxRows: 2, dmlMaxSubtableRows: 5,
    loadNumberPrecision: async () => ({ digits: 10, decimalPlaces: 2, roundingMode: "HALF_EVEN" }),
  })).rejects.toThrow("ArgumentError: APPLY changed subtable rows (6) exceed dmlMaxSubtableRows (5)");

  const validation = parse(`${multiSql} VALIDATE ONLY`);
  const prepared = await prepareApplyInsert({
    statement: validation, fieldInfos: fields, dmlMaxRows: 1, dmlMaxSubtableRows: 5,
    loadNumberPrecision: async () => ({ digits: 10, decimalPlaces: 2, roundingMode: "HALF_EVEN" }),
  });
  expect(prepared.guards).toMatchObject({ parentRows: 2, subtableRows: 6, wouldExceed: true });
});
