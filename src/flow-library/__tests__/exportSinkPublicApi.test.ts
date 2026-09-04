import {
  createExecutionContext,
  disposeExecutionContext,
  executeStatement,
  exportSinkStatus,
  parseScript,
  serializeCsvExport,
  serializeExportSink,
  serializeSelectResultAsCsv,
  type FlowKintoneClient,
  type StatementResult,
} from "../index";

function mockClient(rows: Record<string, { value: unknown }>[] = []) {
  const getRecords = jest.fn(async (params: { totalCount?: boolean }) => params.totalCount
    ? { records: [], totalCount: String(rows.length) }
    : { records: rows });
  const getFields = jest.fn(async () => [
    { code: "code", label: "code", fieldType: "SINGLE_LINE_TEXT" },
    { code: "choices", label: "choices", fieldType: "MULTI_SELECT" },
    { code: "Lines", label: "Lines", fieldType: "SUBTABLE" },
    { code: "Files", label: "Files", fieldType: "FILE" },
  ]);
  const value: FlowKintoneClient = {
    getRecords: getRecords as FlowKintoneClient["getRecords"],
    async openCursor() {
      return { totalCount: rows.length, async nextPage() { return { records: rows as never[], next: false }; }, async close() {} };
    },
    async postRecords() { return { ids: [] }; },
    async putRecords() {},
    async deleteRecords() {},
    async getApps() { return []; },
    getFields,
    async getNumberPrecision() { return { digits: 16, decimalPlaces: 4, roundingMode: "HALF_EVEN" }; },
    async getProcessStatuses() { return { enable: false, states: null }; },
  };
  const apiCalls = () => getRecords.mock.calls.length + getFields.mock.calls.length;
  return { value, getRecords, getFields, apiCalls };
}

function prepared(script: string, exportNames?: readonly string[], client = mockClient()) {
  const parsed = parseScript(script);
  expect(parsed.diagnostics).toEqual([]);
  const context = createExecutionContext({
    client: client.value,
    statements: parsed.statements,
    meta: parsed.meta,
    ...(exportNames ? { exportSinks: exportNames.map((name) => ({ name })) } : {}),
  });
  return { ...parsed, context, client };
}

async function executeAll(run: ReturnType<typeof prepared>): Promise<StatementResult[]> {
  const results: StatementResult[] = [];
  for (const statement of run.statements) results.push(await executeStatement(statement, run.context));
  return results;
}

const sinkScript = "CREATE TEMP TABLE #export AS SELECT 'A' AS code; SELECT * FROM #export";

describe("B179 /flow public CSV export API", () => {
  test("a declared sink is accepted and named/single SELECT use identical bytes", async () => {
    const named = prepared(sinkScript, ["export"]);
    expect(exportSinkStatus(named.context, "export")).toBe("incomplete");
    const namedResults = await executeAll(named);
    expect(namedResults[0]).toMatchObject({ status: "success", tempTable: "#export", rowCount: 1 });
    const namedCsv = serializeExportSink(named.context, "export");

    const single = prepared("SELECT 'A' AS code");
    const singleResult = (await executeAll(single))[0];
    const singleCsv = serializeSelectResultAsCsv(singleResult);
    expect(namedCsv.data).toEqual(singleCsv.data);
    expect(namedCsv.text).toBe("code\r\nA\r\n");
    await disposeExecutionContext(named.context);
    await disposeExecutionContext(single.context);
  });

  test.each([
    ["empty", [{ name: "" }], "ExportSinkInvalidNameError"],
    ["leading hash", [{ name: "#export" }], "ExportSinkInvalidNameError"],
    ["invalid identifier", [{ name: "bad-name" }], "ExportSinkInvalidNameError"],
    ["duplicate declaration", [{ name: "export" }, { name: "export" }], "ExportSinkDuplicateError"],
  ])("rejects %s synchronously before APIs", (_label, exportSinks, code) => {
    const client = mockClient();
    const parsed = parseScript(sinkScript);
    expect(() => createExecutionContext({ client: client.value, statements: parsed.statements, meta: parsed.meta, exportSinks }))
      .toThrow(expect.objectContaining({ code }));
    expect(client.apiCalls()).toBe(0);
  });

  test.each([
    ["missing CREATE", "SELECT 'A' AS code", "ExportSinkNotFoundError"],
    ["duplicate CREATE", "CREATE TEMP TABLE #export AS SELECT 1 AS n; DROP TEMP TABLE #export; CREATE TEMP TABLE #export AS SELECT 2 AS n; SELECT 1 AS done", "ExportSinkDuplicateError"],
    ["dropped final table", "CREATE TEMP TABLE #export AS SELECT 1 AS n; DROP TEMP TABLE #export", "ExportSinkNotFoundError"],
  ])("rejects %s synchronously before APIs", (_label, script, code) => {
    const client = mockClient();
    const parsed = parseScript(script);
    expect(parsed.diagnostics).toEqual([]);
    expect(() => createExecutionContext({
      client: client.value, statements: parsed.statements, meta: parsed.meta, exportSinks: [{ name: "export" }],
    })).toThrow(expect.objectContaining({ code }));
    expect(client.apiCalls()).toBe(0);
  });

  test("a DML-created error table is not accepted as a named export target", () => {
    const client = mockClient();
    const parsed = parseScript("UPDATE APP1 SET code = 'x' WHERE code = 'a' VALIDATE ONLY INTO #export; SELECT * FROM #export");
    expect(parsed.diagnostics).toEqual([]);
    expect(() => createExecutionContext({
      client: client.value, statements: parsed.statements, meta: parsed.meta, exportSinks: [{ name: "export" }],
    })).toThrow(expect.objectContaining({ code: "ExportSinkInvalidTargetError" }));
    expect(client.apiCalls()).toBe(0);
  });

  test("single SELECT uses multiple-value metadata and rejects SUBTABLE/FILE like a named sink", async () => {
    const multi = prepared("SELECT choices FROM APP1", undefined, mockClient([
      { choices: { value: ["A", "B"] } },
    ]));
    const multiResult = (await executeAll(multi))[0];
    expect(serializeSelectResultAsCsv(multiResult).text).toBe('choices\r\n"A\nB"\r\n');

    for (const [column, value] of [["Lines", []], ["Files", []]] as const) {
      const unsupported = prepared(`SELECT ${column} FROM APP1`, undefined, mockClient([
        { [column]: { value } },
      ]));
      const unsupportedResult = (await executeAll(unsupported))[0];
      expect(() => serializeSelectResultAsCsv(unsupportedResult)).toThrow(expect.objectContaining({
        code: "ExportSinkUnsupportedColumnError",
      }));
      await disposeExecutionContext(unsupported.context);
    }
    await disposeExecutionContext(multi.context);
  });

  test("managed /flow always captures SELECT metadata even if an untyped caller supplies false", async () => {
    const parsed = parseScript("SELECT 'A' AS code");
    const client = mockClient();
    const context = createExecutionContext({
      client: client.value,
      statements: parsed.statements,
      meta: parsed.meta,
      captureColumnMeta: false,
    } as Parameters<typeof createExecutionContext>[0] & { captureColumnMeta: boolean });
    const result = await executeStatement(parsed.statements[0], context);
    expect(serializeSelectResultAsCsv(result).text).toBe("code\r\nA\r\n");
    expect(Object.keys(result.result as object)).toEqual(["type", "rows", "columns", "rowCount", "warnings"]);
    await disposeExecutionContext(context);
  });

  test("clone, JSON restoration, hand-built SELECT, and DML are invalid targets", async () => {
    const single = prepared("SELECT 'A' AS code");
    const result = (await executeAll(single))[0];
    for (const invalid of [
      { ...result, result: { ...(result.result as object) } },
      JSON.parse(JSON.stringify(result)),
      { index: 0, type: "SELECT", status: "success", kind: "STATEMENT", result: { type: "SELECT", columns: ["code"], rows: [], rowCount: 0 }, metrics: result.metrics },
    ] as StatementResult[]) {
      expect(() => serializeSelectResultAsCsv(invalid)).toThrow(expect.objectContaining({
        code: "ExportSinkInvalidTargetError",
      }));
    }
    const dml = prepared("INSERT INTO APP1 (code) VALUES ('A')");
    const dmlResult = (await executeAll(dml))[0];
    expect(() => serializeSelectResultAsCsv(dmlResult)).toThrow(expect.objectContaining({
      code: "ExportSinkInvalidTargetError",
    }));
    await disposeExecutionContext(single.context);
    await disposeExecutionContext(dml.context);
  });

  test("incomplete status blocks serialization without API calls", async () => {
    const run = prepared(sinkScript, ["export"]);
    const before = run.client.apiCalls();
    expect(exportSinkStatus(run.context, "export")).toBe("incomplete");
    expect(() => serializeExportSink(run.context, "export")).toThrow(expect.objectContaining({
      code: "ExportSinkExecutionIncompleteError",
    }));
    expect(run.client.apiCalls()).toBe(before);
    await disposeExecutionContext(run.context);
  });

  test("EXIT after CREATE stays materialized after all exit skips are collected", async () => {
    const run = prepared(
      "-- @ksql dialect: 1\nCREATE TEMP TABLE #export AS SELECT 'A' AS code; EXIT SUCCESS IF 1 = 1, 'done'; SELECT 9 AS skipped",
      ["export"]
    );
    const results = await executeAll(run);
    expect(results[2]).toMatchObject({ status: "skipped", skippedReason: "exit" });
    expect(exportSinkStatus(run.context, "export")).toBe("materialized");
    expect(serializeExportSink(run.context, "export").receipt.rows).toBe(1);
    await disposeExecutionContext(run.context);
  });

  test("EXIT before CREATE is not-created only after all exit skips are collected", async () => {
    const run = prepared(
      "-- @ksql dialect: 1\nEXIT SUCCESS IF 1 = 1, 'done'; CREATE TEMP TABLE #export AS SELECT 'A' AS code; SELECT 9 AS skipped",
      ["export"]
    );
    await executeStatement(run.statements[0], run.context);
    expect(exportSinkStatus(run.context, "export")).toBe("incomplete");
    const rest = [
      await executeStatement(run.statements[1], run.context),
      await executeStatement(run.statements[2], run.context),
    ];
    expect(rest.every((result) => result.skippedReason === "exit")).toBe(true);
    expect(exportSinkStatus(run.context, "export")).toBe("not-created");
    expect(() => serializeExportSink(run.context, "export")).toThrow(expect.objectContaining({
      code: "ExportSinkNotMaterializedError",
    }));
    await disposeExecutionContext(run.context);
  });

  test("statement failure wins over incomplete and serialization returns no result", async () => {
    const client = mockClient();
    client.getFields.mockRejectedValueOnce(new Error("schema unavailable"));
    const run = prepared("CREATE TEMP TABLE #export AS SELECT code FROM APP1; SELECT 1 AS later", ["export"], client);
    await expect(executeStatement(run.statements[0], run.context)).resolves.toMatchObject({ status: "error" });
    expect(exportSinkStatus(run.context, "export")).toBe("failed");
    expect(() => serializeExportSink(run.context, "export")).toThrow(expect.objectContaining({
      code: "ExportSinkExecutionFailedError",
    }));
    await disposeExecutionContext(run.context);
  });

  test("temp-table row overflow fails and yields no export", async () => {
    const client = mockClient([{ code: { value: "A" } }, { code: { value: "B" } }]);
    const parsed = parseScript("CREATE TEMP TABLE #export AS SELECT code FROM APP1; SELECT 1 AS later");
    const context = createExecutionContext({
      client: client.value, statements: parsed.statements, meta: parsed.meta,
      exportSinks: [{ name: "export" }], tempTableMaxRows: 1,
    });
    await expect(executeStatement(parsed.statements[0], context)).resolves.toMatchObject({ status: "error" });
    expect(exportSinkStatus(context, "export")).toBe("failed");
    expect(() => serializeExportSink(context, "export")).toThrow(expect.objectContaining({
      code: "ExportSinkExecutionFailedError",
    }));
    await disposeExecutionContext(context);
  });

  test("a sink at the configured row limit reports the complete receipt", async () => {
    const client = mockClient([{ code: { value: "A" } }, { code: { value: "B" } }]);
    const parsed = parseScript("CREATE TEMP TABLE #export AS SELECT code FROM APP1; SELECT 1 AS later");
    const context = createExecutionContext({
      client: client.value, statements: parsed.statements, meta: parsed.meta,
      exportSinks: [{ name: "export" }], tempTableMaxRows: 2,
    });
    for (const statement of parsed.statements) await executeStatement(statement, context);
    expect(serializeExportSink(context, "export").receipt).toMatchObject({ rows: 2, columns: 1 });
    await disposeExecutionContext(context);
  });

  test("omitting exportSinks preserves the public result golden and API counts", async () => {
    const run = prepared("SELECT 'A' AS code");
    const result = (await executeAll(run))[0];
    expect({ ...result, metrics: { ...result.metrics, elapsedMs: 0 } }).toEqual({
      index: 0,
      type: "SELECT",
      status: "success",
      kind: "STATEMENT",
      result: { type: "SELECT", rows: [{ code: "A" }], columns: ["code"], rowCount: 1, warnings: [] },
      metrics: {
        getCalls: 0, postCalls: 0, putCalls: 0, nativeUpsertCalls: 0, deleteCalls: 0,
        fieldCalls: 0, numberPrecisionCalls: 0, appsCalls: 0, processStatusCalls: 0,
        cursorCreateCalls: 0, cursorGetCalls: 0, cursorDeleteCalls: 0,
        cursorRecordsScanned: 0, cursorActiveCurrent: 0, cursorActivePeak: 0,
        cursorCleanupFailures: 0, cursorCreateOutcomeUnknown: 0, cursorQuarantinedCurrent: 0,
        fetchedRows: 0, limitReached: false, limitReachedApps: [], elapsedMs: 0,
      },
    });
    expect(run.client.apiCalls()).toBe(0);
    await disposeExecutionContext(run.context);
  });

  test("status and serializers never add API calls; serializer errors are KsqlFlowError with cause", async () => {
    const run = prepared(sinkScript, ["export"]);
    await executeAll(run);
    const before = run.client.apiCalls();
    expect(exportSinkStatus(run.context, "export")).toBe("materialized");
    serializeExportSink(run.context, "export");
    expect(run.client.apiCalls()).toBe(before);
    try {
      serializeCsvExport({ columns: ["Lines"], rows: [], columnMeta: new Map([["Lines", { fieldType: "SUBTABLE" }]]) });
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toMatchObject({ name: "KsqlFlowError", code: "ExportSinkUnsupportedColumnError" });
      expect((error as { cause?: unknown }).cause).toBeDefined();
    }
    await disposeExecutionContext(run.context);
  });

  test("unknown sink and disposed contexts fail without APIs", async () => {
    const run = prepared(sinkScript, ["export"]);
    expect(() => exportSinkStatus(run.context, "other")).toThrow(expect.objectContaining({ code: "ExportSinkNotFoundError" }));
    await disposeExecutionContext(run.context);
    const before = run.client.apiCalls();
    expect(() => exportSinkStatus(run.context, "export")).toThrow(expect.objectContaining({ code: "ExecutionContextDisposedError" }));
    expect(() => serializeExportSink(run.context, "export")).toThrow(expect.objectContaining({ code: "ExecutionContextDisposedError" }));
    expect(run.client.apiCalls()).toBe(before);
  });
});
