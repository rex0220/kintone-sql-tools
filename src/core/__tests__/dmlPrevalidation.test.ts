import type { KintoneRecord } from "../../converter/dmlToKintone";
import type { KintoneFieldInfo } from "../../execute";
import type { ProcessRow } from "../../engine/process";
import {
  buildDmlValidationPostImage,
  collectDmlPrevalidationSnapshotFields,
  mergeDmlCandidateValidation,
} from "../dmlPrevalidation";
import { buildPostImageFieldIndex, validatePostImage } from "../postImageValidation";

const fields: KintoneFieldInfo[] = [
  { code: "$id", label: "$id", fieldType: "RECORD_NUMBER" },
  { code: "$revision", label: "$revision", fieldType: "REVISION" },
  { code: "topRequired", label: "topRequired", fieldType: "SINGLE_LINE_TEXT", required: true },
  { code: "setNumber", label: "setNumber", fieldType: "NUMBER", maxValue: "10" },
  { code: "setChoice", label: "setChoice", fieldType: "CHECK_BOX", optionOrder: { A: 0, B: 1 } },
  { code: "attachment", label: "attachment", fieldType: "FILE" },
  { code: "calculated", label: "calculated", fieldType: "CALC" },
  { code: "creator", label: "creator", fieldType: "CREATOR" },
  { code: "Lines", label: "Lines", fieldType: "SUBTABLE" },
  { code: "requiredChild", label: "requiredChild", fieldType: "SINGLE_LINE_TEXT", required: true, inSubtable: true, subtableCode: "Lines" },
  { code: "minText", label: "minText", fieldType: "SINGLE_LINE_TEXT", minLength: "2", inSubtable: true, subtableCode: "Lines" },
  { code: "maxText", label: "maxText", fieldType: "SINGLE_LINE_TEXT", maxLength: "2", inSubtable: true, subtableCode: "Lines" },
  { code: "minNumber", label: "minNumber", fieldType: "NUMBER", minValue: "1", inSubtable: true, subtableCode: "Lines" },
  { code: "maxNumber", label: "maxNumber", fieldType: "NUMBER", maxValue: "9", inSubtable: true, subtableCode: "Lines" },
  { code: "choiceChild", label: "choiceChild", fieldType: "DROP_DOWN", optionOrder: { A: 0 }, inSubtable: true, subtableCode: "Lines" },
  { code: "precisionChild", label: "precisionChild", fieldType: "NUMBER", inSubtable: true, subtableCode: "Lines" },
  { code: "childFile", label: "childFile", fieldType: "FILE", inSubtable: true, subtableCode: "Lines" },
  { code: "Other", label: "Other", fieldType: "SUBTABLE" },
  { code: "untouchedChild", label: "untouchedChild", fieldType: "SINGLE_LINE_TEXT", inSubtable: true, subtableCode: "Other" },
];

function snapshot(): KintoneRecord {
  return {
    "$id": { value: "9" },
    topRequired: { value: "ok" },
    setNumber: { value: "1" },
    Lines: { value: [
      { id: "line-1", value: {
        requiredChild: { value: "" }, minText: { value: "x" }, maxText: { value: "long" },
        minNumber: { value: "0" }, maxNumber: { value: "10" }, choiceChild: { value: "X" },
        precisionChild: { value: "123" }, childFile: { value: [{ fileKey: "f1" }] },
      } },
      { id: "line-2", value: {
        requiredChild: { value: "" }, minText: { value: "ok" }, maxText: { value: "ok" },
        minNumber: { value: "1" }, maxNumber: { value: "9" }, choiceChild: { value: "A" },
        precisionChild: { value: "1" },
      } },
    ] },
    Other: { value: [
      { id: "other-1", value: { untouchedChild: { value: "keep" } } },
      { id: "other-2", value: { untouchedChild: { value: "also keep" } } },
    ] },
  } as unknown as KintoneRecord;
}

test("snapshot field collector は検証対象 top-level と table 親だけを収集する", () => {
  const index = buildPostImageFieldIndex(fields);
  expect(collectDmlPrevalidationSnapshotFields(index)).toEqual([
    "$id", "topRequired", "setNumber", "setChoice", "Lines", "Other",
  ]);
});

test("post-image builder は両入力を mutate せず SET field だけ上書きして全 table 行を deep clone する", () => {
  const before = snapshot();
  const sparse = { setNumber: { value: "2" } } as KintoneRecord;
  const beforeCopy = JSON.parse(JSON.stringify(before));
  const sparseCopy = JSON.parse(JSON.stringify(sparse));
  const postImage = buildDmlValidationPostImage(before, sparse);

  expect(postImage).toEqual({ ...beforeCopy, setNumber: { value: "2" } });
  expect(before).toEqual(beforeCopy);
  expect(sparse).toEqual(sparseCopy);
  expect(postImage.Lines.value).not.toBe(before.Lines.value);
  expect((postImage.Lines.value as any[])[0]).not.toBe((before.Lines.value as any[])[0]);
  expect((postImage.Lines.value as any[])[0].value.childFile.value)
    .not.toBe((before.Lines.value as any[])[0].value.childFile.value);
  expect((postImage.Other.value as any[]).map((row) => row.id)).toEqual(["other-1", "other-2"]);
  expect((postImage.Other.value as any[]).map((row) => row.value.untouchedChild.value))
    .toEqual(["keep", "also keep"]);
});

test("complete post-image の全子制約を検出し locator と distinct parent count を保持する", () => {
  const index = buildPostImageFieldIndex(fields, ["$id", "setNumber"]);
  const postImage = buildDmlValidationPostImage(snapshot(), { setNumber: { value: "2" } } as KintoneRecord);
  const validation = validatePostImage(
    postImage, index, { digits: 2, decimalPlaces: 0, roundingMode: "HALF_EVEN" }, 3, 7, "UPSERT"
  );

  expect(validation.errorCount).toBe(8);
  expect(validation.invalidRows).toBe(1);
  expect(validation.invalidRowNumbers).toEqual(new Set([7]));
  expect(validation.errors.map((row) => row.$err_code)).toEqual([
    "ERR_REQUIRED", "ERR_LENGTH_MIN", "ERR_LENGTH_MAX", "ERR_RANGE_MIN",
    "ERR_RANGE_MAX", "ERR_CHOICE_INVALID", "ERR_NUMBER_INTEGER_DIGITS", "ERR_REQUIRED",
  ]);
  expect(validation.errors[0]).toMatchObject({
    $err_operation: "UPSERT", $err_value: "", $err_subtable: "Lines",
    $err_subrow: "1", $err_subrow_id: "line-1",
  });
  expect(validation.errors[7]).toMatchObject({
    $err_operation: "UPSERT", $err_value: "", $err_subtable: "Lines",
    $err_subrow: "2", $err_subrow_id: "line-2",
  });
});

test("同じ子 field の2行違反は errorCount=2 でも invalid parent は1件だけ数える", () => {
  const requiredOnly = fields.filter((field) =>
    ["$id", "Lines", "requiredChild"].includes(field.code)
  );
  const validation = validatePostImage(
    snapshot(), buildPostImageFieldIndex(requiredOnly), undefined, 1, 5, "UPDATE"
  );
  expect(validation.errors.map((row) => [row.$err_field, row.$err_subrow_id])).toEqual([
    ["requiredChild", "line-1"], ["requiredChild", "line-2"],
  ]);
  expect(validation.errorCount).toBe(2);
  expect(validation.invalidRows).toBe(1);
  expect(validation.invalidRowNumbers).toEqual(new Set([5]));
});

test("merger はカテゴリ順・distinct invalid set を保ち normalized SET field だけ write record へ射影する", () => {
  const index = buildPostImageFieldIndex(fields, ["$id", "setChoice"]);
  const invalidSnapshot = snapshot();
  invalidSnapshot.topRequired = { value: "" };
  invalidSnapshot.setNumber = { value: "11" };
  const postImage = buildDmlValidationPostImage(invalidSnapshot, { setChoice: { value: "A,B" } } as KintoneRecord);
  const validation = validatePostImage(
    postImage, index, { digits: 3, decimalPlaces: 0, roundingMode: "HALF_EVEN" }, 3, 7, "UPSERT"
  );
  const plain = (code: string): ProcessRow => ({
    $err_statement: "3", $err_operation: "UPSERT", $err_row: "7", $err_field: "",
    $err_code: code, $err_message: code, $err_value: "", $err_subtable: "",
    $err_subrow: "", $err_subrow_id: "",
  });
  const merged = mergeDmlCandidateValidation({
    rowNumber: 7,
    setFields: ["setChoice"],
    normalizedPostImage: validation.normalizedRecord,
    preErrors: [plain("PRE")],
    postImageErrors: validation.errors,
    checkErrors: [plain("CHECK")],
  });

  expect(merged.errors.map((row) => row.$err_code)).toEqual([
    "PRE", ...validation.errors.map((row) => row.$err_code), "CHECK",
  ]);
  expect(merged.errors.find((row) => row.$err_field === "setNumber")).toMatchObject({
    $err_value: "", $err_subtable: "", $err_subrow: "", $err_subrow_id: "",
  });
  expect(merged.errors.find((row) => row.$err_field === "maxText")).toMatchObject({
    $err_value: "long", $err_subtable: "Lines", $err_subrow: "1", $err_subrow_id: "line-1",
  });
  expect(merged.invalidRows).toBe(1);
  expect(merged.invalidRowNumbers).toEqual(new Set([7]));
  expect(merged.writeRecord).toEqual({ setChoice: { value: ["A", "B"] } });
  expect(Object.keys(merged.writeRecord)).toEqual(["setChoice"]);
  expect(merged.writeRecord.setChoice).not.toBe(validation.normalizedRecord.setChoice);
});
