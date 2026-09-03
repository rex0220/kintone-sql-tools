import {
  createExecutionContext,
  createImportSourceResolver,
  disposeExecutionContext,
  executeStatement,
  explainScript,
  FlowImportProviderError,
  parseScript,
  validateScript,
  type FlowImportSourcePayload,
  type FlowKintoneClient,
} from "../index";

function client() {
  const postRecords = jest.fn(async (params: Parameters<FlowKintoneClient["postRecords"]>[0]) => ({
    ids: params.records.map((_, index) => String(index + 1)),
  }));
  const putRecords = jest.fn(async () => undefined);
  const deleteRecords = jest.fn(async () => undefined);
  const upsertRecords = jest.fn(async () => ({ records: [] }));
  const getRecords = jest.fn<
    ReturnType<FlowKintoneClient["getRecords"]>,
    Parameters<FlowKintoneClient["getRecords"]>
  >(async () => ({ records: [] }));
  const getFields = jest.fn(async () => [
    { code: "code", label: "code", fieldType: "SINGLE_LINE_TEXT", required: true, isUnique: true },
    { code: "name", label: "name", fieldType: "SINGLE_LINE_TEXT" },
  ]);
  const value: FlowKintoneClient = {
    getRecords,
    async openCursor() {
      return { totalCount: 0, async nextPage() { return { records: [], next: false }; }, async close() {} };
    },
    postRecords,
    putRecords,
    upsertRecords,
    deleteRecords,
    async getApps() { return []; },
    getFields,
    async getNumberPrecision() { return { digits: 16, decimalPlaces: 4, roundingMode: "HALF_EVEN" }; },
    async getProcessStatuses() { return { enable: false, states: null }; },
  };
  return { value, getRecords, postRecords, putRecords, deleteRecords, upsertRecords, getFields };
}

const utf8 = (text: string) => new TextEncoder().encode(text);
const sjisCsv = new Uint8Array([
  ...utf8("code,name\nA,"),
  0x93, 0xfa, 0x96, 0x7b,
]);

async function runImport(sql: string, payload: FlowImportSourcePayload) {
  const mock = client();
  const loader = { load: jest.fn(async () => payload) };
  const parsed = parseScript(sql, { enableImport: true });
  expect(parsed.diagnostics).toEqual([]);
  await expect(validateScript(sql, { enableImport: true, client: mock.value })).resolves.toEqual([]);
  const context = createExecutionContext({
    client: mock.value,
    statements: parsed.statements,
    meta: parsed.meta,
    enableImport: true,
    importSource: createImportSourceResolver([{ name: "source", loader }]),
  });
  const result = await executeStatement(parsed.statements[0], context);
  expect(result).toMatchObject({ status: "success" });
  expect(loader.load).toHaveBeenCalledTimes(1);
  const records = mock.postRecords.mock.calls[0][0].records;
  await disposeExecutionContext(context);
  return records;
}

test.each([
  ["UTF-8 default", "IMPORT INTO APP1 (code,name) FROM CSV source", { bytes: utf8("code,name\nA,日本") }],
  ["SJIS metadata", "IMPORT INTO APP1 (code,name) FROM CSV source", { bytes: sjisCsv, encoding: "sjis" as const }],
  ["SQL UTF8 overrides metadata", "IMPORT INTO APP1 (code,name) FROM CSV source ENCODING UTF8", { bytes: utf8("code,name\nA,日本"), encoding: "sjis" as const }],
  ["SQL SJIS overrides metadata", "IMPORT INTO APP1 (code,name) FROM CSV source ENCODING SJIS", { bytes: sjisCsv, encoding: "utf8" as const }],
])("public API executes %s", async (_label, sql, payload) => {
  await expect(runImport(sql, payload)).resolves.toEqual([{
    code: { value: "A" },
    name: { value: "日本" },
  }]);
});

test("IMPORT ON ERROR SKIP UPSERT keeps the pre-read then POST/PUT route and never uses native UPSERT", async () => {
  const sql = "IMPORT INTO APP1 (code,name) FROM CSV source BY NAME "
    + "ON DUPLICATE (code) ON ERROR SKIP INTO #err; SELECT * FROM #err";
  const mock = client();
  mock.getRecords.mockImplementation(async (params) => {
    if (params.query.startsWith("code in")) {
      return { records: [{ $id: { value: "1" }, code: { value: "A" } }] };
    }
    if (params.query.startsWith("$id in")) {
      return { records: [{ $id: { value: "1" }, code: { value: "A" }, name: { value: "old" } }] };
    }
    return { records: [] };
  });
  const parsed = parseScript(sql, { enableImport: true });
  const context = createExecutionContext({
    client: mock.value,
    statements: parsed.statements,
    meta: parsed.meta,
    enableImport: true,
    importSource: createImportSourceResolver([{
      name: "source",
      loader: { load: async () => ({ bytes: utf8("code,name\nA,updated\nB,created") }) },
    }]),
  });
  await expect(executeStatement(parsed.statements[0], context)).resolves.toMatchObject({
    status: "success",
    result: { type: "UPSERT", insertedCount: 1, updatedCount: 1 },
  });
  expect(mock.getRecords).toHaveBeenCalled();
  expect(mock.postRecords).toHaveBeenCalledWith({
    app: 1,
    records: [{ code: { value: "B" }, name: { value: "created" } }],
  });
  expect(mock.putRecords).toHaveBeenCalledWith({
    app: 1,
    records: [{ id: 1, record: { code: { value: "A" }, name: { value: "updated" } } }],
  });
  expect(mock.upsertRecords).not.toHaveBeenCalled();
  await disposeExecutionContext(context);
});

test.each([
  ["malformed UTF-8", "IMPORT INTO APP1 (code) FROM CSV source", new Uint8Array([0xff])],
  ["malformed SJIS", "IMPORT INTO APP1 (code) FROM CSV source ENCODING SJIS", new Uint8Array([0x82])],
])("%s remains ImportSourceError and performs no mutation", async (_label, sql, bytes) => {
  const mock = client();
  const parsed = parseScript(sql, { enableImport: true });
  const context = createExecutionContext({
    client: mock.value,
    statements: parsed.statements,
    meta: parsed.meta,
    enableImport: true,
    importSource: createImportSourceResolver([{
      name: "source", loader: { load: async () => ({ bytes }) },
    }]),
  });
  await expect(executeStatement(parsed.statements[0], context)).resolves.toMatchObject({
    status: "error", error: { code: "ImportSourceError" },
  });
  expect(mock.postRecords).not.toHaveBeenCalled();
  expect(mock.putRecords).not.toHaveBeenCalled();
  expect(mock.deleteRecords).not.toHaveBeenCalled();
  expect(mock.upsertRecords).not.toHaveBeenCalled();
  await disposeExecutionContext(context);
});

test("resolver is lazy, exact, case-sensitive, and rejects empty/duplicate names synchronously", () => {
  const upper = { load: jest.fn(async () => ({ bytes: utf8("code\nA") })) };
  const lower = { load: jest.fn(async () => ({ bytes: utf8("code\nB") })) };
  const resolver = createImportSourceResolver([
    { name: "Orders", loader: upper },
    { name: "orders", loader: lower },
  ]);
  expect(resolver("Orders")).toBe(upper);
  expect(resolver("orders")).toBe(lower);
  expect(resolver("ORDERS")).toBeUndefined();
  expect(upper.load).not.toHaveBeenCalled();
  expect(lower.load).not.toHaveBeenCalled();
  expect(() => createImportSourceResolver([{ name: "", loader: upper }])).toThrow(expect.objectContaining({
    code: "ArgumentError",
  }));
  expect(() => createImportSourceResolver([
    { name: "same", loader: upper },
    { name: "same", loader: lower },
  ])).toThrow(expect.objectContaining({ code: "ImportSourceDuplicateError" }));
  expect(upper.load).not.toHaveBeenCalled();
  expect(lower.load).not.toHaveBeenCalled();
});

test("parse, validate, explain, and context creation do not load; execution loads once", async () => {
  const sql = "IMPORT INTO APP1 (code) FROM CSV source";
  const mock = client();
  const loader = { load: jest.fn(async () => ({ bytes: utf8("code\nA") })) };
  const resolver = createImportSourceResolver([{ name: "source", loader }]);
  const parsed = parseScript(sql, { enableImport: true });
  await validateScript(sql, { enableImport: true, client: mock.value });
  await explainScript(sql, { enableImport: true, client: mock.value, resolveMetadata: false });
  const context = createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta,
    enableImport: true, importSource: resolver,
  });
  expect(loader.load).toHaveBeenCalledTimes(0);
  await executeStatement(parsed.statements[0], context);
  expect(loader.load).toHaveBeenCalledTimes(1);
  await disposeExecutionContext(context);
});

test("an EXIT-skipped IMPORT never loads", async () => {
  const sql = "-- @ksql dialect: 1\nEXIT SUCCESS IF 1 = 1, 'done'; IMPORT INTO APP1 (code) FROM CSV source";
  const mock = client();
  const loader = { load: jest.fn(async () => ({ bytes: utf8("code\nA") })) };
  const parsed = parseScript(sql, { enableImport: true });
  const context = createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta,
    enableImport: true, importSource: createImportSourceResolver([{ name: "source", loader }]),
  });
  await executeStatement(parsed.statements[0], context);
  await expect(executeStatement(parsed.statements[1], context)).resolves.toMatchObject({
    status: "skipped", skippedReason: "exit",
  });
  expect(loader.load).not.toHaveBeenCalled();
  await disposeExecutionContext(context);
});

test("disabled capability preserves KSQL1202 and rejects supplied AST before loader or APIs", async () => {
  const sql = "IMPORT INTO APP1 (code) FROM CSV source";
  const mock = client();
  const loader = { load: jest.fn(async () => ({ bytes: utf8("code\nA") })) };
  for (const enableImport of [undefined, false]) {
    const options = enableImport === undefined ? {} : { enableImport };
    expect(parseScript(sql, options).diagnostics[0]).toMatchObject({ code: "KSQL1202" });
    await expect(validateScript(sql, options)).resolves.toEqual([
      expect.objectContaining({ code: "KSQL1202" }),
    ]);
  }
  expect(() => createExecutionContext({ client: mock.value, script: sql })).toThrow(expect.objectContaining({
    code: "KSQL1202",
  }));
  const parsed = parseScript(sql, { enableImport: true });
  expect(() => createExecutionContext({
    client: mock.value,
    statements: parsed.statements,
    meta: parsed.meta,
    importSource: createImportSourceResolver([{ name: "source", loader }]),
  })).toThrow(expect.objectContaining({ code: "KSQL1202" }));
  expect(loader.load).not.toHaveBeenCalled();
  expect(mock.getFields).not.toHaveBeenCalled();
  expect(mock.getRecords).not.toHaveBeenCalled();
  expect(mock.postRecords).not.toHaveBeenCalled();
});

test.each([
  ["missing", undefined, "ImportSourceNotSuppliedError"],
  ["unknown rejection", { load: async () => { throw new Error("C:\\private\\token.csv"); } }, "ImportSourceReadError"],
  ["not regular", { load: async () => { throw new FlowImportProviderError("ImportSourceNotRegularFileError", "source is not a regular file"); } }, "ImportSourceNotRegularFileError"],
  ["too large", { load: async () => ({ bytes: new Uint8Array(10 * 1024 * 1024 + 1) }) }, "ImportSourceTooLargeError"],
  ["invalid bytes", { load: async () => ({ bytes: "path.csv" } as unknown as FlowImportSourcePayload) }, "ImportSourceInvalidPayloadError"],
  ["invalid encoding", { load: async () => ({ bytes: utf8("code\nA"), encoding: "utf16" } as unknown as FlowImportSourcePayload) }, "ImportSourceInvalidPayloadError"],
])("%s is returned as a statement error with zero mutations", async (_label, loader, code) => {
  const sql = "IMPORT INTO APP1 (code) FROM CSV source";
  const mock = client();
  const parsed = parseScript(sql, { enableImport: true });
  const context = createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta, enableImport: true,
    ...(loader ? { importSource: createImportSourceResolver([{ name: "source", loader }]) } : {}),
  });
  const result = await executeStatement(parsed.statements[0], context);
  expect(result).toMatchObject({ status: "error", error: { code } });
  expect(mock.postRecords).not.toHaveBeenCalled();
  expect(mock.putRecords).not.toHaveBeenCalled();
  expect(mock.deleteRecords).not.toHaveBeenCalled();
  expect(mock.upsertRecords).not.toHaveBeenCalled();
  if (code === "ImportSourceReadError") {
    expect(result.error?.message).not.toContain("private");
    expect(Object.keys(result.error ?? {})).not.toContain("cause");
  }
  await disposeExecutionContext(context);
});
