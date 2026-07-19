import { assertImportRejectLimit, prepareImportRecords } from "../importRecordValidation";
import { materializeImportValidationErrors, IMPORT_VALIDATION_META_COLUMNS } from "../importErrors";
import { materializeCliKintoneCsvImportRecords, materializeJsonImportRecords } from "../importRecordsMaterializer";
import type { KintoneFieldInfo } from "../../execute";

const bytes = (value: string) => new TextEncoder().encode(value);
const targets = [
  { kind: "FIELD" as const, field: "code" },
  { kind: "SUBTABLE" as const, subtableCode: "Lines", children: ["text", "num", "choice", "multi", "users", "required", "defaulted"] },
];
const fields: KintoneFieldInfo[] = [
  { code: "code", label: "code", fieldType: "SINGLE_LINE_TEXT", required: true },
  { code: "Lines", label: "Lines", fieldType: "SUBTABLE", writable: false },
  { code: "text", label: "text", fieldType: "SINGLE_LINE_TEXT", inSubtable: true, subtableCode: "Lines", writable: true },
  { code: "num", label: "num", fieldType: "NUMBER", inSubtable: true, subtableCode: "Lines", writable: true },
  { code: "choice", label: "choice", fieldType: "DROP_DOWN", optionOrder: { A: 0 }, inSubtable: true, subtableCode: "Lines", writable: true },
  { code: "multi", label: "multi", fieldType: "CHECK_BOX", optionOrder: { X: 0, Y: 1 }, inSubtable: true, subtableCode: "Lines", writable: true },
  { code: "users", label: "users", fieldType: "USER_SELECT", inSubtable: true, subtableCode: "Lines", writable: true },
  { code: "required", label: "required", fieldType: "SINGLE_LINE_TEXT", required: true, inSubtable: true, subtableCode: "Lines", writable: true },
  { code: "defaulted", label: "defaulted", fieldType: "SINGLE_LINE_TEXT", required: true, defaultValue: "D", inSubtable: true, subtableCode: "Lines", writable: true },
];

test("validates child primitives, defaults, original NUMBER lexeme, and isolates the whole parent", () => {
  const materialized = materializeJsonImportRecords(
    { kind: "JSON", sourceName: "src" },
    { bytes: bytes('[{"code":"A","Lines":[{"text":null,"num":123456,"choice":"BAD","multi":["X","BAD"],"users":["u1"],"required":""}]},{"code":"B","Lines":[{"num":"12","choice":"A","multi":["X","Y"],"users":["u1"],"required":"ok"}]}]') },
    targets, 10
  );
  const prepared = prepareImportRecords(materialized, targets, fields, { digits: 5, decimalPlaces: 0, roundingMode: "HALF_EVEN" }, "INSERT");
  expect(prepared.invalidParentRows).toEqual(new Set([1]));
  expect(prepared.parents[0].valid).toBe(false);
  expect(prepared.parents[1].valid).toBe(true);
  expect(prepared.parents[1].subtables.get("Lines")?.[0].defaulted).toEqual({ value: "D" });
  expect(prepared.errors.map((error) => error.code)).toEqual(expect.arrayContaining([
    "ERR_NUMBER_INTEGER_DIGITS", "ERR_CHOICE_INVALID", "ERR_REQUIRED",
  ]));
  expect(prepared.tableCounts.get("Lines")).toMatchObject({ childRows: 2, validChildRows: 1, invalidChildRows: 1 });
  expect(() => assertImportRejectLimit(prepared, 0)).toThrow("rejected parents (1)");
  expect(() => assertImportRejectLimit(prepared, 1)).not.toThrow();
});

test("Phase 5 error rows add only the three location columns and keep same-parent multiple errors", () => {
  const materialized = materializeJsonImportRecords(
    { kind: "JSON", sourceName: "src" }, { bytes: bytes('[{"code":"A","Lines":[{"choice":"BAD","required":""}]}]') }, targets, 10
  );
  const prepared = prepareImportRecords(materialized, targets, fields, undefined, "INSERT");
  const rows = materializeImportValidationErrors(prepared.errors, ["code", "choice", "required"]);
  expect(rows.length).toBeGreaterThanOrEqual(2);
  expect(new Set(rows.map((row) => row.$err_row))).toEqual(new Set(["1"]));
  expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ $err_subtable: "Lines", $err_subrow: "1", $err_source_row: null })]));
  expect(IMPORT_VALIDATION_META_COLUMNS).toEqual(expect.arrayContaining(["$err_subtable", "$err_subrow", "$err_source_row"]));
});

test("CSV child errors retain marker/continuation physical source rows", () => {
  const csvTargets = [
    { kind: "FIELD" as const, field: "code" },
    { kind: "SUBTABLE" as const, subtableCode: "Lines", children: ["name"], rowIdSourceHeader: "rid" },
  ];
  const csvFields: KintoneFieldInfo[] = [
    { code: "code", label: "code", fieldType: "SINGLE_LINE_TEXT", writable: true },
    { code: "Lines", label: "Lines", fieldType: "SUBTABLE", writable: false },
    { code: "name", label: "name", fieldType: "SINGLE_LINE_TEXT", required: true, writable: true, inSubtable: true, subtableCode: "Lines" },
  ];
  const materialized = materializeCliKintoneCsvImportRecords(
    { kind: "CSV", sourceName: "src", hasHeader: true, mappingMode: "BY_NAME", ignoreUnknownColumns: false },
    { bytes: bytes("*,code,rid,name\n*,A,10,\n,,11,\n") }, csvTargets, ["Lines"], 10
  );
  const prepared = prepareImportRecords(materialized, csvTargets, csvFields, undefined, "INSERT");
  expect(prepared.invalidParentRows.size).toBe(1);
  expect(prepared.errors.map((error) => error.sourceRow)).toEqual([2, 3]);
  expect(materializeImportValidationErrors(prepared.errors, ["code", "name"]).map((row) => row.$err_source_row)).toEqual(["2", "3"]);
});

test.each([
  [{ code: "other", label: "other", fieldType: "SINGLE_LINE_TEXT", inSubtable: true, subtableCode: "Other", writable: true }, "does not belong"],
  [{ code: "text", label: "text", fieldType: "FILE", inSubtable: true, subtableCode: "Lines", writable: true }, "not writable"],
] as const)("rejects child ownership and unsupported types", (replacement, message) => {
  const changed = fields.filter((field) => field.code !== "text").concat(replacement);
  const materialized = materializeJsonImportRecords({ kind: "JSON", sourceName: "src" }, { bytes: bytes('[{"code":"A","Lines":[]}]') }, targets, 10);
  expect(() => prepareImportRecords(materialized, targets, changed, undefined, "INSERT")).toThrow(message);
});
