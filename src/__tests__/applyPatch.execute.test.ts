import { execute, type KintoneClient, type KintoneFieldInfo } from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";

const fieldInfos: KintoneFieldInfo[] = [
  { code: "親", label: "親", fieldType: "SINGLE_LINE_TEXT", writable: true },
  { code: "親数値", label: "親数値", fieldType: "NUMBER", writable: true },
  { code: "添付", label: "添付", fieldType: "FILE", writable: true },
  { code: "作成者", label: "作成者", fieldType: "CREATOR", writable: false },
  { code: "テーブル", label: "テーブル", fieldType: "SUBTABLE", writable: false },
  { code: "子", label: "子", fieldType: "SINGLE_LINE_TEXT", writable: true, inSubtable: true, subtableCode: "テーブル" },
  { code: "子添付", label: "子添付", fieldType: "FILE", writable: true, inSubtable: true, subtableCode: "テーブル" },
  { code: "別表", label: "別表", fieldType: "SUBTABLE", writable: false },
  { code: "別子", label: "別子", fieldType: "SINGLE_LINE_TEXT", writable: true, inSubtable: true, subtableCode: "別表" },
];

function parent(id = "8"): KintoneRecord {
  return {
    "$id": { value: id },
    "$revision": { value: "3" },
    親: { value: "before" },
    親数値: { value: "1" },
    テーブル: { value: [{ id: "101", value: { 子: { value: "old" }, 子添付: { value: [{ fileKey: "opaque" }] } } }] },
    別表: { value: [] },
  } as unknown as KintoneRecord;
}

function makeClient(records: KintoneRecord[], infos = fieldInfos) {
  const getRecords = jest.fn(async () => ({ records }));
  const putRecords = jest.fn(async () => undefined);
  const getFields = jest.fn(async () => infos);
  const getNumberPrecision = jest.fn(async () => ({ digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const }));
  const client: KintoneClient = {
    getRecords,
    openCursor: async () => { throw new Error("unexpected cursor"); },
    postRecords: async () => { throw new Error("unexpected post"); },
    putRecords,
    deleteRecords: async () => { throw new Error("unexpected delete"); },
    getApps: async () => [],
    getFields,
    getNumberPrecision,
    getProcessStatuses: async () => ({ enable: false, states: [] }),
  };
  return { client, getRecords, putRecords, getFields, getNumberPrecision };
}

const sql = "UPDATE APP4221 SET 親 = 'after' WHERE $id = 8 " +
  "APPLY テーブル (PATCH SET 子 = 'patched' WHERE _rid = '101')";

test.each(["", " VALIDATE ONLY"])(
  "APPLY は metadata→専用単一GET→plan/draft 後に停止し PUT しない: %s",
  async (tail) => {
    const mock = makeClient([parent()]);
    await expect(execute(`${sql}${tail}`, mock.client, { cacheContext: `apply-exact-${tail}` }))
      .rejects.toThrow("UnsupportedError: APPLY execution is not enabled in this phase");
    expect(mock.getFields).toHaveBeenCalledWith(4221);
    expect(mock.getRecords).toHaveBeenCalledTimes(1);
    expect(mock.getRecords).toHaveBeenCalledWith({
      app: 4221,
      query: "$id = 8 limit 2",
      fields: ["$id", "$revision", "親", "親数値", "作成者", "テーブル", "別表"],
    });
    expect(mock.putRecords).not.toHaveBeenCalled();
  }
);

test.each([
  ["0件", [], /ArgumentError: APPLY parent \$id 8 does not exist/],
  ["2件", [parent(), parent()], /ArgumentError: APPLY parent \$id 8 returned multiple records/],
  ["$id不一致", [parent("9")], /ArgumentError: APPLY snapshot \$id 9 does not match requested \$id 8/],
] as const)("親GETの%sを fail-closed にし PUT 0", async (_label, records, error) => {
  const mock = makeClient([...records]);
  await expect(execute(sql, mock.client, { cacheContext: `apply-parent-${_label}` })).rejects.toThrow(error);
  expect(mock.getRecords).toHaveBeenCalledTimes(1);
  expect(mock.putRecords).not.toHaveBeenCalled();
});

test("target/child/writable metadata error は records API 前に拒否する", async () => {
  const wrongChild = makeClient([parent()]);
  const wrongChildSql = "UPDATE APP4221 SET 親 = 'after' WHERE $id = 8 " +
    "APPLY テーブル (PATCH SET 別子 = 'x' ALL ROWS)";
  await expect(execute(wrongChildSql, wrongChild.client, { cacheContext: "apply-wrong-child" }))
    .rejects.toThrow("ArgumentError: APPLY child 別子 does not belong to subtable テーブル");
  expect(wrongChild.getRecords).not.toHaveBeenCalled();
  expect(wrongChild.putRecords).not.toHaveBeenCalled();

  const missingTable = makeClient([parent()], fieldInfos.filter((field) => field.code !== "テーブル"));
  await expect(execute(sql, missingTable.client, { cacheContext: "apply-missing-table" }))
    .rejects.toThrow("ArgumentError: APPLY target テーブル is not a SUBTABLE");
  expect(missingTable.getRecords).not.toHaveBeenCalled();
});

test("post-image error は固定列順の診断を含む ArgumentError で停止し PUT 0", async () => {
  const constrained = fieldInfos.map((field) => field.code === "別子"
    ? { ...field, required: true }
    : field.code === "子"
      ? { ...field, minLength: "2" }
      : field);
  const invalid = parent();
  invalid.別表 = { value: [{ id: "201", value: { 別子: { value: "" } } }] } as never;
  const mock = makeClient([invalid], constrained);

  let error: Error | undefined;
  try {
    await execute(sql, mock.client, { cacheContext: "apply-post-image-errors" });
  } catch (caught) {
    error = caught as Error;
  }
  expect(error?.message).toContain("ArgumentError: APPLY post-image validation failed");
  const diagnostic = JSON.parse(error!.message.slice(error!.message.indexOf("{") )) as {
    columns: string[]; errors: Array<Record<string, string>>;
  };
  expect(diagnostic.columns).toEqual([
    "$id", "親",
    "$err_statement", "$err_operation", "$err_row", "$err_field", "$err_code", "$err_message",
    "$err_value", "$err_subtable", "$err_subrow", "$err_subrow_id",
  ]);
  expect(diagnostic.errors).toEqual([
    expect.objectContaining({
      $id: "8", 親: "after", $err_field: "別子", $err_subtable: "別表", $err_subrow: "1", $err_subrow_id: "201",
    }),
  ]);
  expect(mock.putRecords).not.toHaveBeenCalled();
});

test("トップレベル post-image error の locator 3列は空で $id は重複しない", async () => {
  const constrained = fieldInfos.map((field) => field.code === "親数値"
    ? { ...field, maxValue: "0" }
    : field);
  const mock = makeClient([parent()], constrained);
  await expect(execute(sql, mock.client, { cacheContext: "apply-post-image-top-error" }))
    .rejects.toThrow(/\"\$err_subtable\":\"\",\"\$err_subrow\":\"\",\"\$err_subrow_id\":\"\"/);
  expect(mock.putRecords).not.toHaveBeenCalled();
});

test("post-image に NUMBER セルがない場合は precision cache を読まない", async () => {
  const withoutNumbers = fieldInfos.filter((field) => field.code !== "親数値");
  const record = parent();
  delete record.親数値;
  const mock = makeClient([record], withoutNumbers);
  await expect(execute(sql, mock.client, { cacheContext: "apply-no-number-precision" }))
    .rejects.toThrow("UnsupportedError: APPLY execution is not enabled in this phase");
  expect(mock.getNumberPrecision).not.toHaveBeenCalled();
  expect(mock.putRecords).not.toHaveBeenCalled();
});
