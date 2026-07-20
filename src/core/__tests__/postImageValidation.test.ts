import type { KintoneRecord } from "../../converter/dmlToKintone";
import type { KintoneFieldInfo } from "../../execute";
import {
  buildPostImageFieldIndex,
  postImageNeedsNumberPrecision,
  validatePostImage,
} from "../postImageValidation";

const fields: KintoneFieldInfo[] = [
  { code: "unchangedRequired", label: "unchangedRequired", fieldType: "SINGLE_LINE_TEXT", required: true },
  { code: "parentNumber", label: "parentNumber", fieldType: "NUMBER", minValue: "0", maxValue: "10" },
  { code: "normalizedParent", label: "normalizedParent", fieldType: "CHECK_BOX", optionOrder: { A: 0, B: 1 } },
  { code: "attachment", label: "attachment", fieldType: "FILE" },
  { code: "creator", label: "creator", fieldType: "CREATOR" },
  { code: "Target", label: "Target", fieldType: "SUBTABLE" },
  { code: "changedChild", label: "changedChild", fieldType: "SINGLE_LINE_TEXT", minLength: "2", inSubtable: true, subtableCode: "Target" },
  { code: "unchangedChoice", label: "unchangedChoice", fieldType: "DROP_DOWN", optionOrder: { OK: 0 }, inSubtable: true, subtableCode: "Target" },
  { code: "childFile", label: "childFile", fieldType: "FILE", inSubtable: true, subtableCode: "Target" },
  { code: "Other", label: "Other", fieldType: "SUBTABLE" },
  { code: "otherRequired", label: "otherRequired", fieldType: "SINGLE_LINE_TEXT", required: true, inSubtable: true, subtableCode: "Other" },
  { code: "otherNumber", label: "otherNumber", fieldType: "NUMBER", inSubtable: true, subtableCode: "Other" },
  { code: "Empty", label: "Empty", fieldType: "SUBTABLE" },
  { code: "emptyRequired", label: "emptyRequired", fieldType: "SINGLE_LINE_TEXT", required: true, inSubtable: true, subtableCode: "Empty" },
  { code: "emptyNumber", label: "emptyNumber", fieldType: "NUMBER", inSubtable: true, subtableCode: "Empty" },
];

function postImage(): KintoneRecord {
  return {
    "$id": { value: "8" },
    unchangedRequired: { value: "" },
    parentNumber: { value: "11" },
    normalizedParent: { value: "A,B" },
    attachment: { value: [{ fileKey: "opaque" }] },
    creator: { value: { code: "u1" } },
    Target: { value: [
      { id: "t1", value: { changedChild: { value: "x" }, unchangedChoice: { value: "OK" }, childFile: { value: [{ fileKey: "f" }] } } },
      { id: "t2", value: { changedChild: { value: "fine" }, unchangedChoice: { value: "BAD" } } },
    ] },
    Other: { value: [
      { id: "o1", value: { otherRequired: { value: "" }, otherNumber: { value: "123" } } },
    ] },
    Empty: { value: [] },
  } as unknown as KintoneRecord;
}

test("全 post-image を変更有無・対象 table に関係なく検証し 1-based locator を返す", () => {
  const index = buildPostImageFieldIndex(fields, ["$id", "normalizedParent"]);
  const result = validatePostImage(
    postImage(),
    index,
    { digits: 3, decimalPlaces: 1, roundingMode: "HALF_EVEN" },
    4
  );

  expect(result.columns).toEqual([
    "$id", "normalizedParent",
    "$err_statement", "$err_operation", "$err_row", "$err_field", "$err_code", "$err_message",
    "$err_value", "$err_subtable", "$err_subrow", "$err_subrow_id",
  ]);
  expect(result.invalidRows).toBe(1);
  expect(result.invalidRowNumbers).toEqual(new Set([1]));
  expect(result.errorCount).toBe(6);
  expect(result.errors.map((row) => [row.$err_field, row.$err_code])).toEqual([
    ["unchangedRequired", "ERR_REQUIRED"],
    ["parentNumber", "ERR_RANGE_MAX"],
    ["changedChild", "ERR_LENGTH_MIN"],
    ["unchangedChoice", "ERR_CHOICE_INVALID"],
    ["otherRequired", "ERR_REQUIRED"],
    ["otherNumber", "ERR_NUMBER_INTEGER_DIGITS"],
  ]);
  expect(result.errors[0]).toMatchObject({
    $id: "8", normalizedParent: "A,B", $err_statement: "4", $err_operation: "UPDATE",
    $err_row: "1", $err_subtable: "", $err_subrow: "", $err_subrow_id: "",
  });
  expect(result.errors[2]).toMatchObject({ $err_subtable: "Target", $err_subrow: "1", $err_subrow_id: "t1" });
  expect(result.errors[3]).toMatchObject({ $err_subtable: "Target", $err_subrow: "2", $err_subrow_id: "t2" });
  expect(result.errors[4]).toMatchObject({ $err_subtable: "Other", $err_subrow: "1", $err_subrow_id: "o1" });

  expect(result.normalizedRecord.normalizedParent.value).toEqual(["A", "B"]);
  expect((result.normalizedRecord.Target.value as any[])[1].value.changedChild.value).toBe("fine");
  expect(result.normalizedRecord.attachment.value).toEqual([{ fileKey: "opaque" }]);
  expect((result.normalizedRecord.Target.value as any[])[0].value.childFile.value).toEqual([{ fileKey: "f" }]);
});

test("0行 table は required child error を作らず NUMBER の親子を同じ precision 判定へ含める", () => {
  const index = buildPostImageFieldIndex(fields);
  expect(postImageNeedsNumberPrecision(postImage(), index)).toBe(true);
  const record = postImage();
  record.unchangedRequired = { value: "ok" };
  record.parentNumber = { value: "1" };
  record.Target = { value: [] } as never;
  record.Other = { value: [] } as never;
  const result = validatePostImage(record, index, { digits: 3, decimalPlaces: 1, roundingMode: "HALF_EVEN" }, 1);
  expect(result.errors).toEqual([]);
});

test("NUMBER が0行 table にしか定義されない post-image は precision を要求しない", () => {
  const numberOnlyInEmptyTable = fields.filter((field) =>
    !["parentNumber", "otherNumber"].includes(field.code)
  );
  const index = buildPostImageFieldIndex(numberOnlyInEmptyTable);
  const record = postImage();
  delete record.parentNumber;
  record.Other = { value: [] } as never;
  expect(postImageNeedsNumberPrecision(record, index)).toBe(false);
});
