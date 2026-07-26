import {
  execute,
  type KintoneClient,
  type SelectResult,
} from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";

const FIELD_DEFINITIONS = [
  { code: "作成者", label: "作成者", fieldType: "CREATOR" },
  { code: "更新者", label: "更新者", fieldType: "MODIFIER" },
  { code: "担当者", label: "担当者", fieldType: "USER_SELECT" },
  { code: "グループ", label: "グループ", fieldType: "GROUP_SELECT" },
  { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
];

const SOURCE_RECORDS: KintoneRecord[] = [
  {
    $id: { value: "1" },
    作成者: { value: [{ code: "user" }] },
    更新者: { value: [{ code: "user" }] },
    担当者: { value: [{ code: "user" }] },
    グループ: { value: [{ code: "group" }] },
    件名: { value: "AB" },
  } as KintoneRecord,
];

function makeClient() {
  const calls = {
    records: jest.fn(async (
      params: Parameters<KintoneClient["getRecords"]>[0]
    ) => ({
      // B71: REST mock returns only the fields requested by the runtime.
      records: SOURCE_RECORDS.map((source) => Object.fromEntries(
        (params.fields ?? []).flatMap((code) =>
          source[code] === undefined ? [] : [[code, source[code]]]
        )
      ) as KintoneRecord),
    })),
    cursorOpen: jest.fn(async () => ({
      totalCount: 0,
      nextPage: async () => ({ records: [], next: false }),
      close: async () => undefined,
    })),
    post: jest.fn(async () => ({ ids: [] })),
    put: jest.fn(async () => undefined),
    delete: jest.fn(async () => undefined),
  };
  const client: KintoneClient = {
    getRecords: calls.records,
    openCursor: calls.cursorOpen,
    postRecords: calls.post,
    putRecords: calls.put,
    deleteRecords: calls.delete,
    async getApps() { return []; },
    async getFields() { return FIELD_DEFINITIONS; },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" };
    },
  };
  return { client, calls };
}

function expectNoRecordApi(calls: ReturnType<typeof makeClient>["calls"]): void {
  expect(calls.records).not.toHaveBeenCalled();
  expect(calls.cursorOpen).not.toHaveBeenCalled();
  expect(calls.post).not.toHaveBeenCalled();
  expect(calls.put).not.toHaveBeenCalled();
  expect(calls.delete).not.toHaveBeenCalled();
}

test.each([
  ["作成者", "IN", "in"],
  ["作成者", "NOT IN", "not in"],
  ["更新者", "NOT IN", "not in"],
] as const)("%s %s (LOGINUSER()) は REST query へそのまま押し下げる", async (
  field,
  sqlOperator,
  restOperator
) => {
  const { client, calls } = makeClient();
  await expect(execute(
    `SELECT ${field} FROM APP100 WHERE ${field} ${sqlOperator} (LOGINUSER())`,
    client
  )).resolves.toMatchObject({ type: "SELECT", rowCount: 1 });
  expect(calls.records).toHaveBeenCalledTimes(1);
  expect(calls.records.mock.calls[0][0].query)
    .toBe(`${field} ${restOperator} (LOGINUSER()) order by $id asc limit 500 offset 0`);
});

test("USER_SELECT × LOGINUSER() も exact pushdown する", async () => {
  const { client, calls } = makeClient();
  await expect(execute(
    "SELECT 担当者 FROM APP100 WHERE 担当者 IN (LOGINUSER())",
    client
  )).resolves.toMatchObject({ type: "SELECT", rowCount: 1 });
  expect(calls.records.mock.calls[0][0].query)
    .toBe("担当者 in (LOGINUSER()) order by $id asc limit 500 offset 0");
});

test("LOGINUSER() leaf と非関数 residual は Phase2 A で分離する", async () => {
  const { client, calls } = makeClient();
  const result = await execute(
    "SELECT 件名 FROM APP100 "
      + "WHERE 作成者 IN (LOGINUSER()) AND LENGTH(件名) > 1",
    client
  ) as SelectResult;
  expect(result.rows).toEqual([{ 件名: "AB" }]);
  expect(calls.records.mock.calls[0][0]).toMatchObject({
    fields: ["件名", "作成者", "$id"],
    query: "作成者 in (LOGINUSER()) order by $id asc limit 500 offset 0",
  });
});

test("GROUP_SELECT × LOGINUSER() は metadata 後・records API 前に拒否する", async () => {
  const { client, calls } = makeClient();
  await expect(execute(
    "SELECT グループ FROM APP100 WHERE グループ IN (LOGINUSER())",
    client
  )).rejects.toThrow(
    /LOGINUSER: WHERE_KINTONE_FUNCTION_REQUIRES_EXACT_PUSHDOWN.*WHERE_KINTONE_FUNCTION_FIELD_TYPE_UNSUPPORTED/
  );
  expectNoRecordApi(calls);
});

test("LOGINUSER() を = で書くと operator unsupported で拒否する", async () => {
  const { client, calls } = makeClient();
  await expect(execute(
    "SELECT 作成者 FROM APP100 WHERE 作成者 = LOGINUSER()",
    client
  )).rejects.toThrow(
    /LOGINUSER: WHERE_KINTONE_FUNCTION_REQUIRES_EXACT_PUSHDOWN.*WHERE_KINTONE_FUNCTION_OPERATOR_UNSUPPORTED/
  );
  expectNoRecordApi(calls);
});

test("押し下げ不能 OR 内の LOGINUSER() は client fallback せず拒否する", async () => {
  const { client, calls } = makeClient();
  await expect(execute(
    "SELECT 作成者 FROM APP100 "
      + "WHERE 作成者 IN (LOGINUSER()) OR LENGTH(件名) > 1",
    client
  )).rejects.toThrow(
    /LOGINUSER: WHERE_KINTONE_FUNCTION_REQUIRES_EXACT_PUSHDOWN/
  );
  expectNoRecordApi(calls);
});
