import { execute, type KintoneClient } from "../execute";
import * as evalWhereModule from "../engine/evalWhere";

function makeClient() {
  const calls = {
    records: jest.fn(async (_params: Parameters<KintoneClient["getRecords"]>[0]) => ({ records: [] })),
    cursorOpen: jest.fn(async (_params: Parameters<KintoneClient["openCursor"]>[0]) => ({
      totalCount: 0,
      nextPage: async () => ({ records: [], next: false }),
      close: async () => undefined,
    })),
    post: jest.fn(async () => ({ ids: [] })),
    put: jest.fn(async () => undefined),
    delete: jest.fn(async () => undefined),
    confirm: jest.fn(async () => true),
  };
  const client: KintoneClient = {
    getRecords: calls.records,
    openCursor: calls.cursorOpen,
    postRecords: calls.post,
    putRecords: calls.put,
    deleteRecords: calls.delete,
    getApps: async () => [],
    getFields: async () => [
      { code: "日付", label: "日付", fieldType: "DATE" },
      { code: "状態", label: "状態", fieldType: "SINGLE_LINE_TEXT" },
      { code: "金額", label: "金額", fieldType: "NUMBER" },
    ],
    getProcessStatuses: async () => ({ enable: false, states: [] }),
    getNumberPrecision: async () => ({
      digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN",
    }),
  };
  return { client, calls };
}

test.each([
  "UPDATE APP100 SET 状態='完了' WHERE 日付 = YESTERDAY()",
  "DELETE FROM APP100 WHERE 日付 = YESTERDAY()",
  "UPDATE APP100 SET 状態='完了' WHERE 日付 = YESTERDAY() VALIDATE ONLY",
])("UPDATE/DELETE/VALIDATE ONLY は同じ exact guard と server query を使う: %s", async (sql) => {
  const { client, calls } = makeClient();
  const evaluator = jest.spyOn(evalWhereModule, "evalWhere");
  await expect(execute(sql, client, { confirm: calls.confirm })).resolves.toBeDefined();
  expect(calls.records.mock.calls.map(([params]) => params.query).join("\n"))
    .toContain("日付 = YESTERDAY()");
  expect(evaluator).not.toHaveBeenCalled();
  evaluator.mockRestore();
});

test.each([
  "UPDATE APP100 SET 状態='完了' WHERE 金額 = YESTERDAY()",
  "DELETE FROM APP100 WHERE 金額 = YESTERDAY()",
  "UPDATE APP100 SET 状態='完了' WHERE 金額 = YESTERDAY() VALIDATE ONLY",
])("非exact DML は具体 reason を保ったまま records/Cursor/mutation/confirm 前に拒否する: %s", async (sql) => {
  const { client, calls } = makeClient();
  await expect(execute(sql, client, { confirm: calls.confirm }))
    .rejects.toThrow(/WHERE_RELATIVE_DATE_FIELD_TYPE_UNSUPPORTED/);
  expect(calls.records).not.toHaveBeenCalled();
  expect(calls.cursorOpen).not.toHaveBeenCalled();
  expect(calls.post).not.toHaveBeenCalled();
  expect(calls.put).not.toHaveBeenCalled();
  expect(calls.delete).not.toHaveBeenCalled();
  expect(calls.confirm).not.toHaveBeenCalled();
});
