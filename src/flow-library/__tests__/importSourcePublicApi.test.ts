import {
  createExecutionContext,
  createImportSourceResolver,
  disposeExecutionContext,
  executeStatement,
  explainScript,
  FlowImportProviderError,
  parseScript,
  validateScript,
  type FlowImportSourceLoader,
  type FlowImportSourceMaterializedInfo,
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
  const getFields = jest.fn<
    ReturnType<FlowKintoneClient["getFields"]>,
    Parameters<FlowKintoneClient["getFields"]>
  >(async () => [
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

const mutationCount = (mock: ReturnType<typeof client>) =>
  mock.postRecords.mock.calls.length
  + mock.putRecords.mock.calls.length
  + mock.deleteRecords.mock.calls.length
  + mock.upsertRecords.mock.calls.length;

async function executeImportWithReceipt(
  sql: string,
  payload: FlowImportSourcePayload,
  customize?: (mock: ReturnType<typeof client>) => void
) {
  const mock = client();
  customize?.(mock);
  const receipts: FlowImportSourceMaterializedInfo[] = [];
  const loader = { load: jest.fn(async () => payload) };
  const parsed = parseScript(sql, { enableImport: true });
  expect(parsed.diagnostics).toEqual([]);
  const context = createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta, enableImport: true,
    importSource: createImportSourceResolver([{ name: "source", loader }]),
    onImportSourceMaterialized: async (info) => { receipts.push(info); },
  });
  const result = await executeStatement(parsed.statements[0], context);
  await disposeExecutionContext(context);
  return { mock, loader, receipts, result };
}

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
  const receipt = jest.fn();
  const parsed = parseScript(sql, { enableImport: true });
  const context = createExecutionContext({
    client: mock.value,
    statements: parsed.statements,
    meta: parsed.meta,
    enableImport: true,
    importSource: createImportSourceResolver([{
      name: "source", loader: { load: async () => ({ bytes }) },
    }]),
    onImportSourceMaterialized: receipt,
  });
  await expect(executeStatement(parsed.statements[0], context)).resolves.toMatchObject({
    status: "error", error: { code: "ImportSourceError" },
  });
  expect(mock.postRecords).not.toHaveBeenCalled();
  expect(mock.putRecords).not.toHaveBeenCalled();
  expect(mock.deleteRecords).not.toHaveBeenCalled();
  expect(mock.upsertRecords).not.toHaveBeenCalled();
  expect(receipt).not.toHaveBeenCalled();
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
  const receipt = jest.fn();
  const parsed = parseScript(sql, { enableImport: true });
  await validateScript(sql, { enableImport: true, client: mock.value });
  await explainScript(sql, { enableImport: true, client: mock.value, resolveMetadata: false });
  const context = createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta,
    enableImport: true, importSource: resolver,
    onImportSourceMaterialized: receipt,
  });
  expect(loader.load).toHaveBeenCalledTimes(0);
  expect(receipt).not.toHaveBeenCalled();
  await executeStatement(parsed.statements[0], context);
  expect(loader.load).toHaveBeenCalledTimes(1);
  expect(receipt).toHaveBeenCalledTimes(1);
  await disposeExecutionContext(context);
});

test("an EXIT-skipped IMPORT never loads", async () => {
  const sql = "-- @ksql dialect: 1\nEXIT SUCCESS IF 1 = 1, 'done'; IMPORT INTO APP1 (code) FROM CSV source";
  const mock = client();
  const loader = { load: jest.fn(async () => ({ bytes: utf8("code\nA") })) };
  const receipt = jest.fn();
  const parsed = parseScript(sql, { enableImport: true });
  const context = createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta,
    enableImport: true, importSource: createImportSourceResolver([{ name: "source", loader }]),
    onImportSourceMaterialized: receipt,
  });
  await executeStatement(parsed.statements[0], context);
  await expect(executeStatement(parsed.statements[1], context)).resolves.toMatchObject({
    status: "skipped", skippedReason: "exit",
  });
  expect(loader.load).not.toHaveBeenCalled();
  expect(receipt).not.toHaveBeenCalled();
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
  ["invalid handle", {} as FlowImportSourceLoader, "ImportSourceInvalidPayloadError"],
  ["invalid bytes", { load: async () => ({ bytes: "path.csv" } as unknown as FlowImportSourcePayload) }, "ImportSourceInvalidPayloadError"],
  ["invalid encoding", { load: async () => ({ bytes: utf8("code\nA"), encoding: "utf16" } as unknown as FlowImportSourcePayload) }, "ImportSourceInvalidPayloadError"],
])("%s is returned as a statement error with zero mutations", async (_label, loader, code) => {
  const sql = "IMPORT INTO APP1 (code) FROM CSV source";
  const mock = client();
  const receipt = jest.fn();
  const parsed = parseScript(sql, { enableImport: true });
  const context = createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta, enableImport: true,
    ...(loader ? { importSource: createImportSourceResolver([{ name: "source", loader }]) } : {}),
    onImportSourceMaterialized: receipt,
  });
  const result = await executeStatement(parsed.statements[0], context);
  expect(result).toMatchObject({ status: "error", error: { code } });
  expect(mock.postRecords).not.toHaveBeenCalled();
  expect(mock.putRecords).not.toHaveBeenCalled();
  expect(mock.deleteRecords).not.toHaveBeenCalled();
  expect(mock.upsertRecords).not.toHaveBeenCalled();
  expect(receipt).not.toHaveBeenCalled();
  if (_label === "missing" || _label === "invalid handle") {
    expect(mock.getFields).not.toHaveBeenCalled();
  }
  if (_label === "missing") {
    expect(result.error?.message).toBe(
      'ImportSourceNotSuppliedError: the named IMPORT source "source" was not supplied.'
    );
  }
  if (code === "ImportSourceReadError") {
    expect(result.error?.message).not.toContain("private");
    expect(Object.keys(result.error ?? {})).not.toContain("cause");
  }
  await disposeExecutionContext(context);
});

test("a raw resolver exception becomes ImportSourceReadError before kintone API calls", async () => {
  const sql = "IMPORT INTO APP1 (code) FROM CSV source";
  const mock = client();
  const receipt = jest.fn();
  const parsed = parseScript(sql, { enableImport: true });
  const context = createExecutionContext({
    client: mock.value,
    statements: parsed.statements,
    meta: parsed.meta,
    enableImport: true,
    importSource: () => { throw new Error("resolver failure"); },
    onImportSourceMaterialized: receipt,
  });
  const result = await executeStatement(parsed.statements[0], context);
  expect(result).toMatchObject({ status: "error", error: { code: "ImportSourceReadError" } });
  expect(mock.getFields).not.toHaveBeenCalled();
  expect(mock.postRecords).not.toHaveBeenCalled();
  expect(receipt).not.toHaveBeenCalled();
  await disposeExecutionContext(context);
});

describe("B178 materialized source receipt public API", () => {
  test.each([
    ["quoted LF", "IMPORT INTO APP1 (code,name) FROM CSV source", utf8('code,name\nA,"x\ny"\nB,z'), 2, "utf8"],
    ["CRLF", "IMPORT INTO APP1 (code,name) FROM CSV source", utf8("code,name\r\nA,x\r\nB,y"), 2, "utf8"],
    ["trailing LF", "IMPORT INTO APP1 (code,name) FROM CSV source", utf8("code,name\nA,x\nB,y\n"), 2, "utf8"],
    ["no trailing LF", "IMPORT INTO APP1 (code,name) FROM CSV source", utf8("code,name\nA,x\nB,y"), 2, "utf8"],
    ["UTF-8 BOM", "IMPORT INTO APP1 (code,name) FROM CSV source", new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("code,name\nA,x")]), 1, "utf8"],
    ["NO HEADER", "IMPORT INTO APP1 (code,name) FROM CSV source NO HEADER COLUMNS(code,name)", utf8("A,x\nB,y"), 2, "utf8"],
    ["SJIS payload", "IMPORT INTO APP1 (code,name) FROM CSV source", sjisCsv, 1, "sjis"],
    ["SJIS SQL override", "IMPORT INTO APP1 (code,name) FROM CSV source ENCODING SJIS", sjisCsv, 1, "sjis"],
  ] as const)("reports raw CSV records for %s", async (_label, sql, bytes, rows, encoding) => {
    const observed = await executeImportWithReceipt(sql, { bytes, ...(encoding === "sjis" && _label === "SJIS payload" ? { encoding } : {}) });
    expect(observed.result).toMatchObject({ status: "success", index: 0 });
    expect(observed.receipts).toEqual([{ statementIndex: 0, name: "source", kind: "CSV", rows, encoding }]);
    expect(Object.keys(observed.receipts[0]).sort()).toEqual(["encoding", "kind", "name", "rows", "statementIndex"]);
  });

  test("one-column trailing empty line is a data record, while a multi-column empty line errors without notification", async () => {
    const one = await executeImportWithReceipt("IMPORT INTO APP1 (code) FROM CSV source", { bytes: utf8("code\nA\n\n") });
    expect(one.receipts).toEqual([{ statementIndex: 0, name: "source", kind: "CSV", rows: 2, encoding: "utf8" }]);
    const multi = await executeImportWithReceipt("IMPORT INTO APP1 (code,name) FROM CSV source", { bytes: utf8("code,name\nA,x\n\n") });
    expect(multi.result).toMatchObject({ status: "error", error: { code: "ImportSourceError" } });
    expect(multi.receipts).toEqual([]);
    expect(mutationCount(multi.mock)).toBe(0);
  });

  test("reports JSON top-level records and CSV projection input rows", async () => {
    const json = await executeImportWithReceipt(
      "IMPORT INTO APP1 (code,name) FROM JSON source",
      { bytes: utf8('[{"code":"A","name":"x"},{"code":"B","name":"y"}]') }
    );
    expect(json.receipts).toEqual([{ statementIndex: 0, name: "source", kind: "JSON", rows: 2, encoding: "utf8" }]);
    const projected = await executeImportWithReceipt(
      "IMPORT INTO APP1 (code) FROM CSV source SELECT code",
      { bytes: utf8("code\nA\nB") }
    );
    expect(projected.receipts[0]).toMatchObject({ rows: 2 });
    expect(projected.mock.postRecords.mock.calls[0][0].records).toHaveLength(2);
  });

  test("flat UPSERT, VALIDATE ONLY, and ON ERROR SKIP each notify exactly once with raw rows", async () => {
    const upsert = await executeImportWithReceipt(
      "IMPORT INTO APP1 (code,name) FROM CSV source ON DUPLICATE (code)",
      { bytes: utf8("code,name\nA,x\nB,y") }
    );
    expect(upsert.result).toMatchObject({ status: "success" });
    expect(upsert.receipts).toHaveLength(1);

    const validated = await executeImportWithReceipt(
      "IMPORT INTO APP1 (code) FROM CSV source VALIDATE ONLY",
      { bytes: utf8("code\nA\nB") }
    );
    expect(validated.result).toMatchObject({ status: "success", result: { type: "VALIDATION", validRows: 2 } });
    expect(validated.receipts).toEqual([expect.objectContaining({ rows: 2 })]);
    expect(mutationCount(validated.mock)).toBe(0);

    const sql = "IMPORT INTO APP1 (code) FROM CSV source SELECT CASE WHEN code = 'A' THEN code ELSE '' END AS code "
      + "ON ERROR SKIP INTO #err; SELECT * FROM #err";
    const skipped = await executeImportWithReceipt(sql, { bytes: utf8("code\nA\nB") });
    expect(skipped.result).toMatchObject({ status: "success", result: { insertedCount: 1, skippedRows: 1 } });
    expect(skipped.receipts).toEqual([expect.objectContaining({ rows: 2 })]);
    expect(skipped.mock.postRecords).toHaveBeenCalledTimes(1);
  });

  test("subtable JSON reports parent count rather than child count", async () => {
    const observed = await executeImportWithReceipt(
      "IMPORT INTO APP1 (code, Lines(name)) FROM JSON source VALIDATE ONLY",
      { bytes: utf8('[{"code":"A","Lines":[{"name":"x"},{"name":"y"}]},{"code":"B","Lines":[]}]') },
      (mock) => mock.getFields.mockResolvedValue([
        { code: "code", label: "code", fieldType: "SINGLE_LINE_TEXT", required: true, writable: true },
        { code: "Lines", label: "Lines", fieldType: "SUBTABLE", writable: false },
        { code: "name", label: "name", fieldType: "SINGLE_LINE_TEXT", writable: true, inSubtable: true, subtableCode: "Lines" },
      ])
    );
    expect(observed.result).toMatchObject({ status: "success", result: { validatedRows: 2 } });
    expect(observed.receipts).toEqual([{ statementIndex: 0, name: "source", kind: "JSON", rows: 2, encoding: "utf8" }]);
    expect(mutationCount(observed.mock)).toBe(0);
  });

  test("subtable CSV reports parent and continuation physical rows", async () => {
    const observed = await executeImportWithReceipt(
      "IMPORT UPDATE INTO APP1 (code, Lines(name) ROW ID SOURCE rid) FROM CSV source BY NAME "
        + "MATCH RECORD NUMBER SOURCE recno REPLACE SUBTABLES (Lines) VALIDATE ONLY",
      { bytes: utf8("*,recno,code,rid,name\n*,7,A,101,x\n,7,A,102,y") },
      (mock) => {
        mock.getFields.mockResolvedValue([
          { code: "code", label: "code", fieldType: "SINGLE_LINE_TEXT", writable: true },
          { code: "Lines", label: "Lines", fieldType: "SUBTABLE", writable: false },
          { code: "name", label: "name", fieldType: "SINGLE_LINE_TEXT", writable: true, inSubtable: true, subtableCode: "Lines" },
        ]);
        mock.getRecords.mockResolvedValue({ records: [{
          $id: { value: "7" }, $revision: { value: "1" },
          Lines: { value: [{ id: "101", value: { name: { value: "old" } } }, { id: "102", value: { name: { value: "old" } } }] },
        }] as never[] });
      }
    );
    expect(observed.result).toMatchObject({ status: "success", result: { validatedRows: 1 } });
    expect(observed.receipts).toEqual([{ statementIndex: 0, name: "source", kind: "CSV", rows: 2, encoding: "utf8" }]);
    expect(mutationCount(observed.mock)).toBe(0);
  });

  test("record-number UPDATE notifies before lookup and PUT", async () => {
    const order: string[] = [];
    const mock = client();
    mock.getRecords.mockImplementation(async () => { order.push("lookup"); return { records: [{ $id: { value: "7" } }] }; });
    mock.putRecords.mockImplementation(async () => { order.push("put"); });
    const parsed = parseScript("IMPORT UPDATE INTO APP1 (name) FROM CSV source BY NAME MATCH RECORD NUMBER SOURCE recno", { enableImport: true });
    const context = createExecutionContext({
      client: mock.value, statements: parsed.statements, meta: parsed.meta, enableImport: true,
      importSource: createImportSourceResolver([{ name: "source", loader: { load: async () => ({ bytes: utf8("recno,name\n7,new") }) } }]),
      onImportSourceMaterialized: () => { order.push("receipt"); },
    });
    await expect(executeStatement(parsed.statements[0], context)).resolves.toMatchObject({ status: "success" });
    expect(order).toEqual(["receipt", "lookup", "put"]);
    await disposeExecutionContext(context);
  });

  test("materialize errors and maxRecords overflow do not notify or mutate", async () => {
    for (const [sql, payload, maxRecords] of [
      ["IMPORT INTO APP1 (code) FROM CSV source", { bytes: utf8("code\nA\nB") }, 1],
      ["IMPORT INTO APP1 (code) FROM JSON source", { bytes: utf8("{") }, 10],
    ] as const) {
      const mock = client(); const receipts = jest.fn();
      const parsed = parseScript(sql, { enableImport: true });
      const context = createExecutionContext({
        client: mock.value, statements: parsed.statements, meta: parsed.meta, enableImport: true, maxRecords,
        importSource: createImportSourceResolver([{ name: "source", loader: { load: async () => payload } }]),
        onImportSourceMaterialized: receipts,
      });
      await expect(executeStatement(parsed.statements[0], context)).resolves.toMatchObject({ status: "error" });
      expect(receipts).not.toHaveBeenCalled();
      expect(mutationCount(mock)).toBe(0);
      await disposeExecutionContext(context);
    }
  });

  test.each([
    ["named Error", Object.assign(new Error("stop"), { name: "ReceiptRejectedError" }), "ReceiptRejectedError"],
    ["plain Error", new Error("CallbackError: stop"), "CallbackError"],
    ["object", { code: "OBJECT_REJECTED", message: "stop" }, "OBJECT_REJECTED"],
  ])("callback %s preserves existing error conversion and causes zero mutation", async (_label, thrown, code) => {
    const mock = client(); const callback = jest.fn(async () => { throw thrown; });
    const parsed = parseScript("IMPORT INTO APP1 (code) FROM CSV source", { enableImport: true });
    const context = createExecutionContext({
      client: mock.value, statements: parsed.statements, meta: parsed.meta, enableImport: true,
      importSource: createImportSourceResolver([{ name: "source", loader: { load: async () => ({ bytes: utf8("code\nA") }) } }]),
      onImportSourceMaterialized: callback,
    });
    const result = await executeStatement(parsed.statements[0], context);
    expect(result).toMatchObject({ status: "error", index: 0, error: { code } });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(mutationCount(mock)).toBe(0);
    await disposeExecutionContext(context);
  });

  test("awaits callback before mutation and orders it before onChunkWritten", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    const mock = client();
    const parsed = parseScript("IMPORT INTO APP1 (code) FROM CSV source", { enableImport: true });
    const context = createExecutionContext({
      client: mock.value, statements: parsed.statements, meta: parsed.meta, enableImport: true,
      importSource: createImportSourceResolver([{ name: "source", loader: { load: async () => ({ bytes: utf8("code\nA") }) } }]),
      onImportSourceMaterialized: async () => { order.push("receipt-start"); await gate; order.push("receipt-end"); },
      onChunkWritten: () => { order.push("chunk"); },
    });
    const execution = executeStatement(parsed.statements[0], context);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order).toEqual(["receipt-start"]);
    expect(mutationCount(mock)).toBe(0);
    release();
    await expect(execution).resolves.toMatchObject({ status: "success" });
    expect(order).toEqual(["receipt-start", "receipt-end", "chunk"]);
    await disposeExecutionContext(context);
  });

  test("a callback that resolves after the execution deadline cannot mutate in detached work", async () => {
    const mock = client();
    const parsed = parseScript("IMPORT INTO APP1 (code) FROM CSV source", { enableImport: true });
    const context = createExecutionContext({
      client: mock.value, statements: parsed.statements, meta: parsed.meta, enableImport: true, timeoutMs: 5,
      importSource: createImportSourceResolver([{ name: "source", loader: { load: async () => ({ bytes: utf8("code\nA") }) } }]),
      onImportSourceMaterialized: () => new Promise<void>((resolve) => setTimeout(resolve, 30)),
    });
    await expect(executeStatement(parsed.statements[0], context)).resolves.toMatchObject({
      status: "error", error: { code: "TimeoutError" },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    expect(mutationCount(mock)).toBe(0);
    await disposeExecutionContext(context);
  });

  test("callback failure fail-fast skips later IMPORT and same source otherwise notifies per statement index", async () => {
    const sql = "IMPORT INTO APP1 (code) FROM CSV source; IMPORT INTO APP1 (code) FROM CSV source";
    const parsed = parseScript(sql, { enableImport: true });
    const failedMock = client(); const failedReceipts = jest.fn(() => { throw new Error("stop"); });
    const failedContext = createExecutionContext({
      client: failedMock.value, statements: parsed.statements, meta: parsed.meta, enableImport: true,
      importSource: createImportSourceResolver([{ name: "source", loader: { load: async () => ({ bytes: utf8("code\nA") }) } }]),
      onImportSourceMaterialized: failedReceipts,
    });
    await expect(executeStatement(parsed.statements[0], failedContext)).resolves.toMatchObject({ status: "error" });
    await expect(executeStatement(parsed.statements[1], failedContext)).resolves.toMatchObject({ status: "skipped", skippedReason: "fail-fast" });
    expect(failedReceipts).toHaveBeenCalledTimes(1);
    expect(mutationCount(failedMock)).toBe(0);
    await disposeExecutionContext(failedContext);

    const okMock = client(); const receipts: FlowImportSourceMaterializedInfo[] = [];
    const okContext = createExecutionContext({
      client: okMock.value, statements: parsed.statements, meta: parsed.meta, enableImport: true,
      importSource: createImportSourceResolver([{ name: "source", loader: { load: async () => ({ bytes: utf8("code\nA") }) } }]),
      onImportSourceMaterialized: (info) => { receipts.push(info); },
    });
    await executeStatement(parsed.statements[0], okContext);
    await executeStatement(parsed.statements[1], okContext);
    expect(receipts.map((info) => info.statementIndex)).toEqual([0, 1]);
    expect(receipts.map(({ statementIndex: _index, ...metadata }) => metadata)).toEqual([
      { name: "source", kind: "CSV", rows: 1, encoding: "utf8" },
      { name: "source", kind: "CSV", rows: 1, encoding: "utf8" },
    ]);
    await disposeExecutionContext(okContext);
  });

  test("omitted callback and no-op callback preserve result and API counts", async () => {
    const run = async (withCallback: boolean) => {
      const mock = client(); const parsed = parseScript("IMPORT INTO APP1 (code) FROM CSV source", { enableImport: true });
      const context = createExecutionContext({
        client: mock.value, statements: parsed.statements, meta: parsed.meta, enableImport: true,
        importSource: createImportSourceResolver([{ name: "source", loader: { load: async () => ({ bytes: utf8("code\nA") }) } }]),
        ...(withCallback ? { onImportSourceMaterialized: async () => undefined } : {}),
      });
      const result = await executeStatement(parsed.statements[0], context);
      await disposeExecutionContext(context);
      return {
        result: { ...result, metrics: { ...result.metrics, elapsedMs: 0 } },
        calls: [mock.getRecords, mock.getFields, mock.postRecords, mock.putRecords, mock.deleteRecords, mock.upsertRecords]
          .map((fn) => fn.mock.calls.length),
      };
    };
    await expect(run(true)).resolves.toEqual(await run(false));
  });
});

describe("B178 review follow-up (codex final check)", () => {
  const subtableFields = [
    { code: "code", label: "code", fieldType: "SINGLE_LINE_TEXT", writable: true },
    { code: "Lines", label: "Lines", fieldType: "SUBTABLE", writable: false },
    { code: "name", label: "name", fieldType: "SINGLE_LINE_TEXT", writable: true, inSubtable: true, subtableCode: "Lines" },
  ];
  const subtableRecord = (ids: string[]) => ({ records: [{
    $id: { value: "7" }, $revision: { value: "1" },
    Lines: { value: ids.map((id) => ({ id, value: { name: { value: "old" } } })) },
  }] as never[] });
  const subtableCsvSql = "IMPORT UPDATE INTO APP1 (code, Lines(name) ROW ID SOURCE rid) FROM CSV source BY NAME "
    + "MATCH RECORD NUMBER SOURCE recno REPLACE SUBTABLES (Lines) VALIDATE ONLY";

  test("receipt is already delivered when the projection fails after raw materialize", async () => {
    const observed = await executeImportWithReceipt(
      "IMPORT INTO APP1 (code) FROM CSV source SELECT missing_column AS code",
      { bytes: utf8("code\nA\nB") }
    );
    expect(observed.result).toMatchObject({ status: "error" });
    expect(observed.receipts).toEqual([{ statementIndex: 0, name: "source", kind: "CSV", rows: 2, encoding: "utf8" }]);
    expect(mutationCount(observed.mock)).toBe(0);
  });

  test.each([
    ["flat INSERT", "IMPORT INTO APP1 (code,name) FROM CSV source", "code,name\nA,x", ""],
    ["flat UPSERT", "IMPORT INTO APP1 (code,name) FROM CSV source ON DUPLICATE (code)", "code,name\nA,x", ""],
    ["VALIDATE ONLY", "IMPORT INTO APP1 (code,name) FROM CSV source VALIDATE ONLY", "code,name\nA,x", ""],
    ["ON ERROR SKIP", "IMPORT INTO APP1 (code,name) FROM CSV source ON ERROR SKIP INTO #err; SELECT * FROM #err", "code,name\nA,x", ""],
    ["record-number UPDATE", "IMPORT UPDATE INTO APP1 (name) FROM CSV source BY NAME MATCH RECORD NUMBER SOURCE recno", "recno,name\n7,new", "lookup"],
    ["subtable CSV", subtableCsvSql, "*,recno,code,rid,name\n*,7,A,101,x", "subtable"],
    ["subtable JSON", "IMPORT INTO APP1 (code, Lines(name)) FROM JSON source VALIDATE ONLY", '[{"code":"A","Lines":[{"name":"x"}]}]', "subtable"],
  ])("callback throw on %s leaves mutation APIs at zero", async (_label, sql, text, setup) => {
    const mock = client();
    if (setup === "lookup") mock.getRecords.mockResolvedValue({ records: [{ $id: { value: "7" } }] });
    if (setup === "subtable") {
      mock.getFields.mockResolvedValue(subtableFields);
      mock.getRecords.mockResolvedValue(subtableRecord(["101"]));
    }
    const callback = jest.fn(async () => { throw Object.assign(new Error("stop"), { name: "ReceiptRejectedError" }); });
    const parsed = parseScript(sql, { enableImport: true });
    expect(parsed.diagnostics).toEqual([]);
    const context = createExecutionContext({
      client: mock.value, statements: parsed.statements, meta: parsed.meta, enableImport: true,
      importSource: createImportSourceResolver([{ name: "source", loader: { load: async () => ({ bytes: utf8(text) }) } }]),
      onImportSourceMaterialized: callback,
    });
    const result = await executeStatement(parsed.statements[0], context);
    expect(result).toMatchObject({ status: "error", index: 0, error: { code: "ReceiptRejectedError" } });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(mutationCount(mock)).toBe(0);
    await disposeExecutionContext(context);
  });

  test("timeout after the callback started still ends in TimeoutError with zero mutation", async () => {
    let started = false;
    const mock = client();
    const parsed = parseScript("IMPORT INTO APP1 (code) FROM CSV source", { enableImport: true });
    const context = createExecutionContext({
      client: mock.value, statements: parsed.statements, meta: parsed.meta, enableImport: true, timeoutMs: 40,
      importSource: createImportSourceResolver([{ name: "source", loader: { load: async () => ({ bytes: utf8("code\nA") }) } }]),
      onImportSourceMaterialized: () => { started = true; return new Promise<void>((resolve) => setTimeout(resolve, 80)); },
    });
    await expect(executeStatement(parsed.statements[0], context)).resolves.toMatchObject({
      status: "error", error: { code: "TimeoutError" },
    });
    expect(started).toBe(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(mutationCount(mock)).toBe(0);
    await disposeExecutionContext(context);
  });

  test("subtable CSV: maxRecords limits parents while the receipt counts physical rows", async () => {
    const mock = client();
    mock.getFields.mockResolvedValue(subtableFields);
    mock.getRecords.mockResolvedValue(subtableRecord(["101", "102", "103"]));
    const receipts: FlowImportSourceMaterializedInfo[] = [];
    const parsed = parseScript(subtableCsvSql, { enableImport: true });
    const context = createExecutionContext({
      client: mock.value, statements: parsed.statements, meta: parsed.meta, enableImport: true, maxRecords: 1,
      importSource: createImportSourceResolver([{ name: "source", loader: { load: async () => ({ bytes: utf8("*,recno,code,rid,name\n*,7,A,101,x\n,7,A,102,y\n,7,A,103,z") }) } }]),
      onImportSourceMaterialized: (info) => { receipts.push(info); },
    });
    await expect(executeStatement(parsed.statements[0], context)).resolves.toMatchObject({ status: "success", result: { validatedRows: 1 } });
    expect(receipts).toEqual([{ statementIndex: 0, name: "source", kind: "CSV", rows: 3, encoding: "utf8" }]);
    expect(mutationCount(mock)).toBe(0);
    await disposeExecutionContext(context);
  });

  test.each([
    ["SQL UTF8 over payload sjis", "IMPORT INTO APP1 (code,name) FROM CSV source ENCODING UTF8", { bytes: utf8("code,name\nA,日本"), encoding: "sjis" as const }, "utf8"],
    ["SQL SJIS over payload utf8", "IMPORT INTO APP1 (code,name) FROM CSV source ENCODING SJIS", { bytes: sjisCsv, encoding: "utf8" as const }, "sjis"],
  ])("receipt encoding follows SQL over payload metadata (%s)", async (_label, sql, payload, encoding) => {
    const observed = await executeImportWithReceipt(sql, payload);
    expect(observed.result).toMatchObject({ status: "success" });
    expect(observed.mock.postRecords.mock.calls[0][0].records).toEqual([{ code: { value: "A" }, name: { value: "日本" } }]);
    expect(observed.receipts).toEqual([{ statementIndex: 0, name: "source", kind: "CSV", rows: 1, encoding }]);
  });

  test("a second source that fails to decode is not notified while the first receipt stays", async () => {
    const sql = "IMPORT INTO APP1 (code) FROM CSV good; IMPORT INTO APP1 (code) FROM CSV bad";
    const mock = client();
    const receipts: FlowImportSourceMaterializedInfo[] = [];
    const parsed = parseScript(sql, { enableImport: true });
    const context = createExecutionContext({
      client: mock.value, statements: parsed.statements, meta: parsed.meta, enableImport: true,
      importSource: createImportSourceResolver([
        { name: "good", loader: { load: async () => ({ bytes: utf8("code\nA") }) } },
        { name: "bad", loader: { load: async () => ({ bytes: new Uint8Array([0xff]) }) } },
      ]),
      onImportSourceMaterialized: (info) => { receipts.push(info); },
    });
    await expect(executeStatement(parsed.statements[0], context)).resolves.toMatchObject({ status: "success" });
    await expect(executeStatement(parsed.statements[1], context)).resolves.toMatchObject({ status: "error", error: { code: "ImportSourceError" } });
    expect(receipts).toEqual([{ statementIndex: 0, name: "good", kind: "CSV", rows: 1, encoding: "utf8" }]);
    expect(mock.postRecords).toHaveBeenCalledTimes(1);
    await disposeExecutionContext(context);
  });

  test("an IMPORT projection cannot reference a temp table, so no temp-dependency skip form exists", () => {
    const parsed = parseScript(
      "CREATE TEMP TABLE #t AS SELECT code FROM APP1; IMPORT INTO APP1 (code) FROM CSV source SELECT code FROM #t",
      { enableImport: true }
    );
    expect(parsed.diagnostics).toEqual([expect.objectContaining({ code: "KSQL1202", message: "IMPORT projection cannot use FROM or JOIN." })]);
  });

  test("omitted callback: fixed golden of result and API counts for a one-row INSERT", async () => {
    const mock = client();
    const loader = { load: jest.fn(async () => ({ bytes: utf8("code\nA") })) };
    const parsed = parseScript("IMPORT INTO APP1 (code) FROM CSV source", { enableImport: true });
    const context = createExecutionContext({
      client: mock.value, statements: parsed.statements, meta: parsed.meta, enableImport: true,
      importSource: createImportSourceResolver([{ name: "source", loader }]),
    });
    const result = await executeStatement(parsed.statements[0], context);
    await disposeExecutionContext(context);
    expect(result).toMatchObject({ status: "success", index: 0, result: { type: "INSERT", insertedCount: 1 } });
    expect(loader.load).toHaveBeenCalledTimes(1);
    expect([mock.getFields, mock.getRecords, mock.postRecords, mock.putRecords, mock.deleteRecords, mock.upsertRecords]
      .map((fn) => fn.mock.calls.length)).toEqual([1, 0, 1, 0, 0, 0]);
  });
});
