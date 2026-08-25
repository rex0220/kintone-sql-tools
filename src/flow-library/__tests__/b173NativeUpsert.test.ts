import {
  createExecutionContext,
  createKintoneClient,
  disposeExecutionContext,
  executeStatement,
  parseScript,
  type FlowChunkWrittenInfo,
  type FlowKintoneClient,
  type KintoneNativeUpsertParams,
  type KintoneNativeUpsertResult,
} from "../index";
import {
  createManagedStatementExecutionContext,
  disposeManagedStatementExecutionContext,
  execute,
  executeManagedStatement,
  NativeUpsertResponseError,
} from "../../execute";

type NativeHandler = (params: KintoneNativeUpsertParams) => Promise<KintoneNativeUpsertResult>;

function clientFixture(options: {
  keyType?: string;
  unique?: boolean;
  omitUnique?: boolean;
  includeKeySchema?: boolean;
  native?: NativeHandler;
  records?: Array<Record<string, { value: string }>>;
  extraFields?: Array<{ code: string; label: string; fieldType: string; isUnique?: boolean }>;
} = {}) {
  const calls = {
    fields: [] as number[],
    get: [] as Array<Parameters<FlowKintoneClient["getRecords"]>[0]>,
    post: [] as Array<Parameters<FlowKintoneClient["postRecords"]>[0]>,
    put: [] as Array<Parameters<FlowKintoneClient["putRecords"]>[0]>,
    native: [] as KintoneNativeUpsertParams[],
  };
  const client: FlowKintoneClient = {
    async getRecords(params) {
      calls.get.push(params);
      return { records: options.records ?? [] };
    },
    async openCursor() { throw new Error("unexpected cursor call"); },
    async postRecords(params) {
      calls.post.push(params);
      return { ids: params.records.map((_, index) => String(index + 1)) };
    },
    async putRecords(params) { calls.put.push(params); },
    async deleteRecords() {},
    async getApps() { return []; },
    async getFields(appId) {
      calls.fields.push(appId);
      return [
        ...(options.includeKeySchema === false ? [] : [{
          code: "key", label: "key", fieldType: options.keyType ?? "SINGLE_LINE_TEXT",
          ...(options.omitUnique ? {} : { isUnique: options.unique ?? true }),
        }]),
        { code: "value", label: "value", fieldType: "SINGLE_LINE_TEXT" },
        ...(options.extraFields ?? []),
      ];
    },
    async getNumberPrecision() { return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" }; },
    async getProcessStatuses() { return { enable: false, states: null }; },
  };
  if (options.native) client.upsertRecords = async (params) => {
    calls.native.push(params);
    return options.native!(params);
  };
  return { client, calls };
}

async function runFlow(
  sql: string,
  client: FlowKintoneClient,
  options: { enableNativeUpsert?: boolean; onChunkWritten?: (info: FlowChunkWrittenInfo) => void | Promise<void> } = {}
) {
  const parsed = parseScript(sql);
  expect(parsed.diagnostics).toEqual([]);
  const context = createExecutionContext({ client, statements: parsed.statements, meta: parsed.meta, ...options });
  try { return await executeStatement(parsed.statements[0], context); }
  finally { await disposeExecutionContext(context); }
}

const success: NativeHandler = async (params) => ({ records: params.records.map((_, index) => ({
  id: String(index + 1), revision: "1", operation: index % 2 === 0 ? "INSERT" : "UPDATE",
})) });

test("AC-1/4/8/12/13: /flow default ON sends native body, aggregates response, metrics, and one callback", async () => {
  const fixture = clientFixture({ native: success });
  const chunks: FlowChunkWrittenInfo[] = [];
  const result = await runFlow(
    "UPSERT INTO APP1 (key,value) VALUES ('A','one'),('B','two') ON DUPLICATE (key);",
    fixture.client,
    { onChunkWritten: (info) => { chunks.push(info); } }
  );
  expect(result).toMatchObject({
    status: "success",
    result: { type: "UPSERT", insertedCount: 1, updatedCount: 1 },
    metrics: { fieldCalls: 1, getCalls: 0, postCalls: 0, putCalls: 1, nativeUpsertCalls: 1 },
  });
  expect(fixture.calls.fields).toEqual([1]);
  expect(fixture.calls.native).toEqual([{
    app: 1,
    upsert: true,
    records: [
      { updateKey: { field: "key", value: "A" }, record: { value: { value: "one" } } },
      { updateKey: { field: "key", value: "B" }, record: { value: { value: "two" } } },
    ],
  }]);
  expect(chunks).toEqual([{
    statementIndex: 0, appId: 1, operation: "UPSERT", records: 2, chunkIndex: 0,
    insertedCount: 1, updatedCount: 1, lastKeyValue: "B",
  }]);
});

test("AC-5/6: key-only and large NUMBER keys remain strings and are removed from record", async () => {
  const fixture = clientFixture({ keyType: "NUMBER", native: success });
  await runFlow(
    "UPSERT INTO APP1 (key) VALUES (12345678901234567890) ON DUPLICATE (key);",
    fixture.client
  );
  expect(fixture.calls.native[0].records).toEqual([{
    updateKey: { field: "key", value: "12345678901234567890" }, record: {},
  }]);
});

test("AC-3: ordinary core execution stays native-OFF even when the client is capable", async () => {
  const fixture = clientFixture({ native: success });
  const result = await execute(
    "UPSERT INTO APP1 (key,value) VALUES ('A','one') ON DUPLICATE (key)",
    fixture.client
  );
  expect(result).toMatchObject({
    type: "UPSERT", insertedCount: 1, updatedCount: 0,
    metrics: { nativeUpsertCalls: 0, getCalls: 1, postCalls: 1, putCalls: 0 },
  });
  expect(fixture.calls.native).toHaveLength(0);
});

test.each([
  ["opt-out", { enableNativeUpsert: false }, {}, "('A','one')"],
  ["no capability", {}, { native: undefined }, "('A','one')"],
  ["unsupported schema", {}, { keyType: "DATE" }, "('A','one')"],
  ["non-unique schema", {}, { unique: false }, "('A','one')"],
  ["unknown uniqueness", {}, { omitUnique: true }, "('A','one')"],
  ["missing schema", {}, { includeKeySchema: false }, "('A','one')"],
  ["empty key", {}, {}, "('','empty'),('A','one')"],
  ["duplicate key", {}, {}, "('A','one'),('A','two')"],
] as const)("AC-2/3/7/19: %s falls back for the whole statement", async (_name, flowOptions, fixtureOptions, values) => {
  const fixture = clientFixture({ native: success, ...fixtureOptions });
  if (_name === "no capability") delete fixture.client.upsertRecords;
  const result = await runFlow(
    `UPSERT INTO APP1 (key,value) VALUES ${values} ON DUPLICATE (key);`,
    fixture.client,
    flowOptions
  );
  expect(result).toMatchObject({ metrics: { nativeUpsertCalls: 0 } });
  expect(result.metrics.fieldCalls).toBe(1);
  expect(fixture.calls.fields).toEqual([1]);
  expect(fixture.calls.native).toHaveLength(0);
  if (_name === "unsupported schema" || _name === "missing schema") {
    expect(result.status).toBe("error");
    expect(fixture.calls.post).toHaveLength(0);
  } else {
    expect(result.status).toBe("success");
    expect(fixture.calls.get.length).toBeGreaterThan(0);
    expect(fixture.calls.post).toHaveLength(1);
  }
});

test("AC-6/7: NUMBER 5 and 5.0 duplicate across the statement falls back", async () => {
  const fixture = clientFixture({ keyType: "NUMBER", native: success });
  await runFlow(
    "UPSERT INTO APP1 (key,value) VALUES (5,'one'),(5.0,'two') ON DUPLICATE (key);",
    fixture.client
  );
  expect(fixture.calls.native).toHaveLength(0);
  expect(fixture.calls.post).toHaveLength(1);
});

test("AC-2: composite update keys are ineligible and retain the legacy route", async () => {
  const fixture = clientFixture({
    native: success,
    extraFields: [{ code: "key2", label: "key2", fieldType: "SINGLE_LINE_TEXT", isUnique: true }],
  });
  const result = await runFlow(
    "UPSERT INTO APP1 (key,key2,value) VALUES ('A','B','one') ON DUPLICATE (key,key2);",
    fixture.client
  );
  expect(result).toMatchObject({ status: "success", metrics: { nativeUpsertCalls: 0 } });
  expect(fixture.calls.native).toHaveLength(0);
  expect(fixture.calls.get.length).toBeGreaterThan(0);
});

test.each([
  ["CHECK", "UPSERT INTO APP1 (key,value) VALUES ('A','one') ON DUPLICATE (key) CHECK WHEN value = 'blocked' THEN 'bad';"],
  ["VALIDATE ONLY", "UPSERT INTO APP1 (key,value) VALUES ('A','one') ON DUPLICATE (key) VALIDATE ONLY;"],
] as const)("AC-2/3: %s UPSERT retains its existing non-native path", async (_name, sql) => {
  const fixture = clientFixture({ native: success });
  const result = await runFlow(sql, fixture.client);
  expect(result.status).toBe("success");
  expect(result.metrics.nativeUpsertCalls).toBe(0);
  expect(fixture.calls.native).toHaveLength(0);
});

test("AC-8: 101 rows are sent in source-order 100/1 chunks and aggregated", async () => {
  const fixture = clientFixture({ native: success });
  const values = Array.from({ length: 101 }, (_, index) => `('K${index}','V${index}')`).join(",");
  const result = await runFlow(`UPSERT INTO APP1 (key,value) VALUES ${values} ON DUPLICATE (key);`, fixture.client);
  expect(fixture.calls.native.map((call) => call.records.length)).toEqual([100, 1]);
  expect(fixture.calls.native[1].records[0].updateKey.value).toBe("K100");
  expect(result.result).toMatchObject({ insertedCount: 51, updatedCount: 50 });
});

test("AC-7: a duplicate crossing the 100-record boundary falls back before native starts", async () => {
  const fixture = clientFixture({ native: success });
  const values = Array.from({ length: 101 }, (_, index) =>
    `('${index === 100 ? "K0" : `K${index}`}','V${index}')`
  ).join(",");
  const result = await runFlow(`UPSERT INTO APP1 (key,value) VALUES ${values} ON DUPLICATE (key);`, fixture.client);
  expect(result).toMatchObject({ status: "success", metrics: { nativeUpsertCalls: 0 } });
  expect(fixture.calls.native).toHaveLength(0);
  expect(fixture.calls.post.map((call) => call.records.length)).toEqual([100, 1]);
});

test("AC-1/4: plain UPSERT SELECT uses the materialized source and skips target lookup", async () => {
  const fixture = clientFixture({
    native: success,
    records: [
      { key: { value: "S1" }, value: { value: "one" } },
      { key: { value: "S2" }, value: { value: "two" } },
    ],
  });
  const result = await runFlow(
    "UPSERT INTO APP1 (key,value) SELECT key,value FROM APP2 ON DUPLICATE (key);",
    fixture.client
  );
  expect(result.result).toMatchObject({ type: "UPSERT", insertedCount: 1, updatedCount: 1 });
  expect(fixture.calls.native[0].records.map((record) => record.updateKey.value)).toEqual(["S1", "S2"]);
  expect(fixture.calls.get.every((call) => call.app === 2)).toBe(true);
});

test("B176: actual /flow client -> LAPP route -> metrics -> callback を native UPSERT で通す", async () => {
  const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/app/form/fields.json?app=42")) {
      return new Response(JSON.stringify({
        properties: {
          key: { code: "key", label: "key", type: "SINGLE_LINE_TEXT", unique: true },
          value: { code: "value", label: "value", type: "SINGLE_LINE_TEXT" },
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    expect(url).toContain("/records.json");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toMatchObject({ app: 42, upsert: true });
    return new Response(JSON.stringify({
      records: [{ id: "10", revision: "1", operation: "INSERT" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as jest.MockedFunction<typeof fetch>;
  const client = createKintoneClient({
    baseUrl: "https://example.cybozu.com",
    auth: { type: "apiToken", apiToken: "secret" },
    fetch: fetchMock,
  });
  const parsed = parseScript(
    "-- @ksql dialect: 1\nUPSERT INTO LAPP_TARGET (key,value) VALUES ('K1','V1') KEY (key);",
    { apps: { TARGET: 42 } }
  );
  expect(parsed.diagnostics).toEqual([]);
  const chunks: FlowChunkWrittenInfo[] = [];
  const context = createExecutionContext({
    client,
    statements: parsed.statements,
    meta: parsed.meta,
    onChunkWritten: (info) => { chunks.push(info); },
  });
  try {
    const result = await executeStatement(parsed.statements[0], context);
    expect(result).toMatchObject({
      status: "success",
      result: { insertedCount: 1, updatedCount: 0 },
      metrics: { fieldCalls: 1, getCalls: 0, nativeUpsertCalls: 1, putCalls: 1 },
    });
    expect(chunks).toEqual([expect.objectContaining({ appId: 42, operation: "UPSERT", records: 1 })]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally {
    await disposeExecutionContext(context);
  }
});

test.each([
  ["not array", {}],
  ["wrong length", { records: [] }],
  ["bad operation", { records: [{ id: "1", revision: "1", operation: "OTHER" }] }],
  ["bad id", { records: [{ id: 1, revision: "1", operation: "INSERT" }] }],
  ["bad revision", { records: [{ id: "1", revision: 1, operation: "INSERT" }] }],
] as const)("AC-9/14: invalid native response (%s) fails without legacy retry", async (_name, response) => {
  const fixture = clientFixture({ native: async () => response as unknown as KintoneNativeUpsertResult });
  const result = await runFlow("UPSERT INTO APP1 (key,value) VALUES ('A','one') ON DUPLICATE (key);", fixture.client);
  expect(result).toMatchObject({ status: "error", error: { code: "NativeUpsertResponseError" } });
  expect(result.error?.message).toBe(new NativeUpsertResponseError().message);
  expect(fixture.calls.get).toHaveLength(0);
  expect(fixture.calls.post).toHaveLength(0);
  expect(fixture.calls.put).toHaveLength(0);
});

test("AC-14: API and callback errors never retry through the legacy path", async () => {
  const apiFixture = clientFixture({ native: async () => { throw new Error("GAIA_IQ28"); } });
  const apiResult = await runFlow(
    "UPSERT INTO APP1 (key,value) VALUES ('A','one') ON DUPLICATE (key);",
    apiFixture.client
  );
  expect(apiResult).toMatchObject({
    status: "error", error: { message: "GAIA_IQ28" },
    metrics: { putCalls: 1, nativeUpsertCalls: 1, postCalls: 0 },
  });
  expect(apiFixture.calls.native).toHaveLength(1);
  expect(apiFixture.calls.post).toHaveLength(0);

  const callbackFixture = clientFixture({ native: success });
  const callbackResult = await runFlow(
    "UPSERT INTO APP1 (key,value) VALUES ('A','one') ON DUPLICATE (key);",
    callbackFixture.client,
    { onChunkWritten: async () => { throw new Error("checkpoint failed"); } }
  );
  expect(callbackResult).toMatchObject({
    status: "error", error: { message: "checkpoint failed" },
    metrics: { putCalls: 1, nativeUpsertCalls: 1, postCalls: 0 },
  });
  expect(callbackFixture.calls.native).toHaveLength(1);
  expect(callbackFixture.calls.post).toHaveLength(0);
});

test("AC-18: confirm is once before native write; refusal writes nothing", async () => {
  const parsed = parseScript("UPSERT INTO APP1 (key,value) VALUES ('A','one'),('B','two') ON DUPLICATE (key);");
  const fixture = clientFixture({ native: success });
  const confirm = jest.fn(async () => false);
  const managed = createManagedStatementExecutionContext(
    parsed.statements, parsed.meta.dialect, fixture.client, { confirm }, undefined, true
  );
  try {
    const result = await executeManagedStatement(parsed.statements[0], managed);
    expect(result).toMatchObject({ status: "error", error: { code: "OperationCancelledError" } });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(2, "UPDATE", expect.objectContaining({ statementIndex: 0 }));
    expect(fixture.calls.native).toHaveLength(0);
    expect(fixture.calls.post).toHaveLength(0);
    expect(fixture.calls.put).toHaveLength(0);
  } finally {
    await disposeManagedStatementExecutionContext(managed);
  }
});

test("AC-18: zero-row native-eligible UPSERT SELECT calls neither confirm nor write", async () => {
  const parsed = parseScript("UPSERT INTO APP1 (key,value) SELECT key,value FROM APP2 ON DUPLICATE (key);");
  const fixture = clientFixture({ native: success, records: [] });
  const confirm = jest.fn(async () => true);
  const managed = createManagedStatementExecutionContext(
    parsed.statements, parsed.meta.dialect, fixture.client, { confirm }, undefined, true
  );
  try {
    const result = await executeManagedStatement(parsed.statements[0], managed);
    expect(result).toMatchObject({
      status: "success", result: { type: "UPSERT", insertedCount: 0, updatedCount: 0 },
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(fixture.calls.native).toHaveLength(0);
  } finally {
    await disposeManagedStatementExecutionContext(managed);
  }
});
