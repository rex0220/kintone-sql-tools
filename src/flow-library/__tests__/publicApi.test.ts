import {
  createExecutionContext,
  createKintoneClient,
  disposeExecutionContext,
  executeStatement,
  explainScript,
  parseScript,
  validateScript,
  type FlowKintoneClient,
} from "../index";

function mockClient(): FlowKintoneClient {
  return {
    async getRecords(params) {
      return params.totalCount
        ? { records: [], totalCount: "0" }
        : { records: [] };
    },
    async openCursor() {
      return { totalCount: 0, async nextPage() { return { records: [], next: false }; }, async close() {} };
    },
    async postRecords() { return { ids: [] }; },
    async putRecords() {},
    async deleteRecords() {},
    async getApps() { return []; },
    async getFields(appId) {
      return appId === 2
        ? [
            { code: "顧客コード", label: "顧客コード", fieldType: "SINGLE_LINE_TEXT", isUnique: true },
            { code: "当月受注件数", label: "当月受注件数", fieldType: "NUMBER" },
            { code: "当月売上実績", label: "当月売上実績", fieldType: "NUMBER" },
            { code: "最終集計日時", label: "最終集計日時", fieldType: "DATETIME" },
          ]
        : [
            { code: "受注日", label: "受注日", fieldType: "DATE" },
            { code: "金額", label: "金額", fieldType: "NUMBER" },
            { code: "顧客コード", label: "顧客コード", fieldType: "SINGLE_LINE_TEXT" },
            { code: "レコード番号", label: "レコード番号", fieldType: "RECORD_NUMBER" },
            { code: "ステータス", label: "ステータス", fieldType: "STATUS" },
          ];
    },
    async getNumberPrecision() { return { digits: 16, decimalPlaces: 4, roundingMode: "HALF_EVEN" }; },
    async getProcessStatuses() { return { enable: false, states: null }; },
  };
}

const acceptanceScript = `-- @ksql name: monthly_sales_sync
-- @ksql depends_on: sync_master_customers
-- @ksql timeout: 600
-- @ksql dialect: 1
ASSERT (
  SELECT COUNT(*) FROM LAPP_受注
  WHERE 受注日 >= @MONTH_START() AND 受注日 < @NEXT_MONTH_START() AND 金額 < 0
) = 0, '【異常中断】マイナスの売上データが存在するため処理を停止しました';

CREATE TEMP TABLE temp_monthly_summary AS
SELECT 顧客コード, COUNT(レコード番号) AS 受注件数, SUM(金額) AS 当月売上合計
FROM LAPP_受注
WHERE 受注日 >= @MONTH_START() AND 受注日 < @NEXT_MONTH_START() AND ステータス = '受注完了'
GROUP BY 顧客コード;

EXIT SUCCESS IF (SELECT COUNT(*) FROM temp_monthly_summary) = 0,
  '集計対象となる受注データが 0 件のためスキップ';

UPSERT INTO LAPP_顧客マスタ (顧客コード, 当月受注件数, 当月売上実績, 最終集計日時)
SELECT 顧客コード, 受注件数, 当月売上合計, @NOW()
FROM temp_monthly_summary
KEY (顧客コード);`;

test("parseScript resolves LAPP and validateScript positions strict/schema diagnostics", async () => {
  const parsed = parseScript(acceptanceScript, { apps: { 受注: 1, 顧客マスタ: 2 } });
  expect(parsed.diagnostics).toEqual([]);
  expect(parsed.statements).toHaveLength(4);
  expect(parsed.statementRanges).toHaveLength(4);
  await expect(validateScript(acceptanceScript, {
    apps: { 受注: 1, 顧客マスタ: 2 },
    schema: (appId) => mockClient().getFields(appId),
  })).resolves.toEqual([]);

  const insert = `-- @ksql dialect: 1\n\nINSERT INTO APP1 (name) VALUES ('x');`;
  const warning = await validateScript(insert);
  expect(warning[0]).toMatchObject({ severity: "warning", line: 3, column: 1 });
  const strict = await validateScript(insert, { strict: true });
  expect(strict[0]).toMatchObject({ severity: "error", line: 3, column: 1 });

  const noSchema = await validateScript(
    "-- @ksql dialect: 1\nUPSERT INTO APP2 (顧客コード) VALUES ('x') KEY (顧客コード);"
  );
  expect(noSchema).toEqual([]);
  const badSchema = await validateScript(
    "-- @ksql dialect: 1\nUPSERT INTO APP2 (顧客コード) VALUES ('x') KEY (顧客コード);",
    { schema: () => [{ code: "顧客コード", label: "顧客コード", fieldType: "SINGLE_LINE_TEXT", isUnique: false }] }
  );
  expect(badSchema[0]).toMatchObject({ code: "KSQL1303", line: 2, column: 1 });
});

test("explainScript exposes dialect 1 estimated API lines", async () => {
  const explained = await explainScript(
    "-- @ksql dialect: 1\nSELECT * FROM APP1 LIMIT 10;",
    { client: mockClient(), resolveMetadata: false }
  );
  expect(explained.statements[0].plan.join("\n")).toContain("estimated API consumption (dialect 1)");
});

test("statement execution shares temp/as-of, continues WARN, stops at EXIT, and rejects reuse after dispose", async () => {
  const source = `-- @ksql dialect: 1
CREATE TEMP TABLE clock_table AS SELECT @NOW() AS captured;
ASSERT WARN (SELECT COUNT(*) FROM clock_table) = 0, 'warning and continue';
SELECT captured, @NOW() AS current FROM clock_table;
EXIT SUCCESS IF (SELECT COUNT(*) FROM clock_table) = 1, 'done';
SELECT 999 AS unreachable;`;
  const parsed = parseScript(source);
  expect(parsed.diagnostics).toEqual([]);
  const context = createExecutionContext({
    client: mockClient(),
    statements: parsed.statements,
    meta: parsed.meta,
    asOf: new Date("2026-08-21T12:34:56.000Z"),
    timezone: "UTC",
  });
  const results = [];
  for (const statement of parsed.statements) results.push(await executeStatement(statement, context));
  expect(results.map((item) => item.kind)).toEqual([
    "STATEMENT", "ASSERT_WARNING", "STATEMENT", "EXIT_NO_DATA", "STATEMENT",
  ]);
  expect(results[1]).toMatchObject({ status: "success" });
  expect(results[2].result).toMatchObject({
    type: "SELECT",
    rows: [{ captured: "2026-08-21T12:34:56.000Z", current: "2026-08-21T12:34:56.000Z" }],
  });
  expect(results[4]).toMatchObject({ status: "skipped", skippedReason: "exit" });
  await disposeExecutionContext(context);
  await expect(executeStatement(parsed.statements[0], context)).rejects.toMatchObject({
    code: "ExecutionContextDisposedError",
  });
});

test("acceptance sample executes one statement at a time through /flow", async () => {
  const parsed = parseScript(acceptanceScript, { apps: { 受注: 1, 顧客マスタ: 2 } });
  const context = createExecutionContext({
    client: mockClient(),
    statements: parsed.statements,
    meta: parsed.meta,
    asOf: new Date("2026-08-01T00:00:00.000Z"),
    timezone: "Asia/Tokyo",
  });
  const results = [];
  for (const statement of parsed.statements) results.push(await executeStatement(statement, context));
  expect(results[0].error).toBeUndefined();
  expect(results[0]).toMatchObject({ status: "success", kind: "ASSERT_PASSED" });
  expect(results[1]).toMatchObject({ status: "success", tempTable: "#temp_monthly_summary", rowCount: 0 });
  expect(results[2]).toMatchObject({ status: "success", kind: "EXIT_NO_DATA" });
  expect(results[3]).toMatchObject({ status: "skipped", skippedReason: "exit" });
  await disposeExecutionContext(context);
});

test("createKintoneClient is writable and uses injected fetch", async () => {
  const fetchMock = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify(
    JSON.parse(String(init?.body ?? "{}")).upsert
      ? { records: [{ id: "1", revision: "1", operation: "INSERT" }] }
      : { ids: ["1"] }
  ), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })) as jest.MockedFunction<typeof fetch>;
  const client = createKintoneClient({
    baseUrl: "https://example.cybozu.com",
    auth: { type: "apiToken", apiToken: "secret" },
    fetch: fetchMock,
  });
  expect(typeof client.postRecords).toBe("function");
  expect(typeof client.putRecords).toBe("function");
  expect(typeof client.upsertRecords).toBe("function");
  expect(typeof client.deleteRecords).toBe("function");
  await expect(client.postRecords({ app: 1, records: [{}] })).resolves.toEqual({ ids: ["1"] });
  expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST" });
  await expect(client.upsertRecords!({
    app: 1, upsert: true,
    records: [{ updateKey: { field: "key", value: "A" }, record: {} }],
  })).resolves.toEqual({ records: [{ id: "1", revision: "1", operation: "INSERT" }] });
  expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "PUT" });
  expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
    app: 1, upsert: true,
    records: [{ updateKey: { field: "key", value: "A" }, record: {} }],
  });
});
