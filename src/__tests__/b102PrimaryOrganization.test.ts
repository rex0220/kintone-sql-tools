import { execute, executeBatch, type KintoneClient } from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";

function makeClient(fieldTypes: Record<string, string> = {}) {
  const calls = {
    records: jest.fn(async (_params: Parameters<KintoneClient["getRecords"]>[0]) => ({
      records: [] as KintoneRecord[],
    })),
    cursorOpen: jest.fn(async () => ({
      totalCount: 0,
      nextPage: async () => ({ records: [], next: false }),
      close: async () => undefined,
    })),
    post: jest.fn(async () => ({ ids: [] as string[] })),
    put: jest.fn(async () => undefined),
    delete: jest.fn(async () => undefined),
    fields: jest.fn(async () => Object.entries({
      担当組織: "ORGANIZATION_SELECT",
      作成者: "CREATOR",
      状態: "SINGLE_LINE_TEXT",
      名前: "SINGLE_LINE_TEXT",
      ...fieldTypes,
    }).map(([code, fieldType]) => ({ code, label: code, fieldType }))),
    confirm: jest.fn(async () => true),
  };
  const client: KintoneClient = {
    getRecords: calls.records,
    openCursor: calls.cursorOpen,
    postRecords: calls.post,
    putRecords: calls.put,
    deleteRecords: calls.delete,
    getApps: async () => [],
    getFields: calls.fields,
    getProcessStatuses: async () => ({ enable: false, states: [] }),
    getNumberPrecision: async () => ({
      digits: 30,
      decimalPlaces: 10,
      roundingMode: "HALF_EVEN",
    }),
  };
  return { client, calls };
}

function expectNoRecordOrWriteApi(calls: ReturnType<typeof makeClient>["calls"]) {
  expect(calls.records).not.toHaveBeenCalled();
  expect(calls.cursorOpen).not.toHaveBeenCalled();
  expect(calls.post).not.toHaveBeenCalled();
  expect(calls.put).not.toHaveBeenCalled();
  expect(calls.delete).not.toHaveBeenCalled();
  expect(calls.confirm).not.toHaveBeenCalled();
}

test.each([
  ["IN", "担当組織 in (PRIMARY_ORGANIZATION())"],
  ["NOT IN", "担当組織 not in (PRIMARY_ORGANIZATION())"],
] as const)("SELECT %s は PRIMARY_ORGANIZATION() を REST query へ素通しする", async (op, query) => {
  const { client, calls } = makeClient();
  await execute(
    `SELECT 名前 FROM APP100 WHERE 担当組織 ${op} (PRIMARY_ORGANIZATION())`,
    client
  );
  expect(calls.records).toHaveBeenCalledTimes(1);
  expect(calls.records.mock.calls[0][0].query).toContain(query);
});

test("PRIMARY_ORGANIZATION() の非対応 field type は records API 前に拒否する", async () => {
  const { client, calls } = makeClient({ 担当組織: "USER_SELECT" });
  await expect(execute(
    "SELECT 名前 FROM APP100 WHERE 担当組織 IN (PRIMARY_ORGANIZATION())",
    client
  )).rejects.toThrow(
    /PRIMARY_ORGANIZATION: WHERE_KINTONE_FUNCTION_REQUIRES_EXACT_PUSHDOWN .*WHERE_KINTONE_FUNCTION_FIELD_TYPE_UNSUPPORTED/
  );
  expect(calls.fields).toHaveBeenCalled();
  expectNoRecordOrWriteApi(calls);
});

test("PRIMARY_ORGANIZATION() の非対応 operator は records API 前に拒否する", async () => {
  const { client, calls } = makeClient();
  await expect(execute(
    "SELECT 名前 FROM APP100 WHERE 担当組織 = PRIMARY_ORGANIZATION()",
    client
  )).rejects.toThrow(
    /PRIMARY_ORGANIZATION: WHERE_KINTONE_FUNCTION_REQUIRES_EXACT_PUSHDOWN .*WHERE_KINTONE_FUNCTION_OPERATOR_UNSUPPORTED/
  );
  expect(calls.fields).toHaveBeenCalled();
  expectNoRecordOrWriteApi(calls);
});

test.each([
  "UPDATE APP100 SET 状態 = '完了' WHERE 担当組織 IN (PRIMARY_ORGANIZATION())",
  "DELETE FROM APP100 WHERE 担当組織 IN (PRIMARY_ORGANIZATION())",
  "INSERT INTO APP100 (名前) SELECT 名前 FROM APP200 WHERE 担当組織 IN (PRIMARY_ORGANIZATION())",
  "UPSERT INTO APP100 (名前) SELECT 名前 FROM APP200 WHERE 担当組織 IN (PRIMARY_ORGANIZATION()) ON DUPLICATE (名前)",
])("DML は records・write・confirm API 前に PRIMARY_ORGANIZATION() を拒否する — %s", async (sql) => {
  const { client, calls } = makeClient();
  await expect(execute(sql, client, { confirm: calls.confirm }))
    .rejects.toThrow(
      "ArgumentError: PRIMARY_ORGANIZATION() は DML の WHERE では使用できません"
    );
  expect(calls.fields).not.toHaveBeenCalled();
  expectNoRecordOrWriteApi(calls);
});

test("batch の DML も PRIMARY_ORGANIZATION() を API 前に拒否する", async () => {
  const { client, calls } = makeClient();
  await expect(executeBatch(
    "DELETE FROM APP100 WHERE 担当組織 IN (PRIMARY_ORGANIZATION()); SELECT 1 AS one",
    client,
    { confirm: calls.confirm }
  )).rejects.toThrow(
    "PRIMARY_ORGANIZATION() は DML の WHERE では使用できません"
  );
  expect(calls.fields).not.toHaveBeenCalled();
  expectNoRecordOrWriteApi(calls);
});

test("LOGINUSER() の既存 DML は PRIMARY_ORGANIZATION 専用 guard の対象外", async () => {
  const { client, calls } = makeClient();
  await execute(
    "DELETE FROM APP100 WHERE 作成者 IN (LOGINUSER())",
    client,
    { confirm: calls.confirm }
  );
  expect(calls.records).toHaveBeenCalledTimes(1);
  expect(calls.records.mock.calls[0][0].query).toContain("作成者 in (LOGINUSER())");
  expect(calls.delete).not.toHaveBeenCalled();
});
