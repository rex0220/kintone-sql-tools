import { execute, type KintoneClient } from "../execute";

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
  };
  const client: KintoneClient = {
    getRecords: calls.records,
    openCursor: calls.cursorOpen,
    postRecords: calls.post,
    putRecords: calls.put,
    deleteRecords: calls.delete,
    getApps: async () => [],
    getFields: async () => [
      { code: "作成日時", label: "作成日時", fieldType: "CREATED_TIME" },
      { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
    ],
    getProcessStatuses: async () => ({ enable: false, states: [] }),
    getNumberPrecision: async () => ({
      digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN",
    }),
  };
  return { client, calls };
}

function planText(result: Awaited<ReturnType<typeof execute>>): string {
  if (result.type !== "SELECT") throw new Error(`unexpected ${result.type}`);
  return result.rows.map((row) => row.plan).join("\n");
}

function expectNoExecutionApi(calls: ReturnType<typeof makeClient>["calls"]) {
  expect(calls.records).not.toHaveBeenCalled();
  expect(calls.cursorOpen).not.toHaveBeenCalled();
  expect(calls.post).not.toHaveBeenCalled();
  expect(calls.put).not.toHaveBeenCalled();
  expect(calls.delete).not.toHaveBeenCalled();
}

test("EXPLAIN は execution と共有する exact plan の server-only facts と query を表示する", async () => {
  const sql = "SELECT 作成日時 FROM APP100 WHERE 作成日時 < FROM_TODAY(5, DAYS)";
  const explained = makeClient();
  const text = planText(await execute(`EXPLAIN ${sql}`, explained.client));

  expect(text).toContain("relative date function: FROM_TODAY");
  expect(text).toContain("evaluation: kintone server");
  expect(text).toContain("field: 作成日時 (CREATED_TIME)");
  expect(text).toContain("operator: <");
  expect(text).toContain("where capability: EXACT_PUSHDOWN");
  expect(text).toContain("client evaluation: forbidden");
  expect(text).toContain("kintone query: 作成日時 < FROM_TODAY(5, DAYS)");
  expectNoExecutionApi(explained.calls);

  const executed = makeClient();
  await execute(sql, executed.client);
  expect(executed.calls.records).toHaveBeenCalledTimes(1);
  expect(executed.calls.records.mock.calls[0][0].query)
    .toMatch(/^作成日時 < FROM_TODAY\(5, DAYS\)(?: |$)/);
});

test("拒否 EXPLAIN は具体的 R2 reason を保持し GET/Cursor plan を表示しない", async () => {
  const sql = "SELECT 件名 FROM APP100 WHERE 件名 = YESTERDAY() KORDER BY 件名 LIMIT 10";
  const explained = makeClient();
  const text = planText(await execute(`EXPLAIN ${sql}`, explained.client));

  expect(text).toContain("relative date function: YESTERDAY");
  expect(text).toContain("plan status: rejected");
  expect(text).toContain("WHERE_RELATIVE_DATE_FIELD_TYPE_UNSUPPORTED");
  expect(text).toContain("WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN");
  expect(text).not.toContain("order plan:    KORDER_NATIVE");
  expect(text).not.toContain("order plan:    KORDER_CURSOR");
  expect(text).not.toContain("REST execution: single GET");
  expect(text).not.toContain("fetch API: POST/GET/DELETE records/cursor.json");
  expectNoExecutionApi(explained.calls);

  const executed = makeClient();
  await expect(execute(sql, executed.client))
    .rejects.toThrow(/WHERE_RELATIVE_DATE_FIELD_TYPE_UNSUPPORTED/);
  expectNoExecutionApi(executed.calls);
});
