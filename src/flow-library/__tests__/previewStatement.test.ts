import {
  createExecutionContext,
  disposeExecutionContext,
  executeStatement,
  parseScript,
  previewStatement,
  type FlowKintoneClient,
  type PreviewResult,
} from "../index";
import { wrapClientWithPreviewWriteBlock } from "../../execute";

type Stored = Record<string, { value: string }>;

function mockClient(stored: Stored[] = []) {
  const writes = { post: 0, put: 0, delete: 0 };
  const getRecords = jest.fn(async (params: Parameters<FlowKintoneClient["getRecords"]>[0]) => {
    let rows = stored;
    const quoted = [...params.query.matchAll(/"((?:\\.|[^"])*)"/g)]
      .map((match) => JSON.parse(`"${match[1]}"`) as string);
    if (/\bkey\s+in\s*\(/i.test(params.query)) {
      const wanted = new Set(quoted);
      rows = rows.filter((record) => wanted.has(record.key?.value ?? ""));
    }
    const records = rows.map((record) => Object.fromEntries(
      params.fields.filter((field) => record[field] !== undefined).map((field) => [field, record[field]])
    ));
    return params.totalCount
      ? { records, totalCount: String(records.length) }
      : { records };
  });
  const client: FlowKintoneClient = {
    getRecords,
    async openCursor() {
      return { totalCount: 0, async nextPage() { return { records: [], next: false }; }, async close() {} };
    },
    async postRecords({ records }) { writes.post += 1; return { ids: records.map((_, i) => String(i + 1)) }; },
    async putRecords() { writes.put += 1; },
    async deleteRecords() { writes.delete += 1; },
    async getApps() { return []; },
    async getFields() {
      return [
        { code: "key", label: "key", fieldType: "SINGLE_LINE_TEXT", isUnique: true },
        { code: "value", label: "value", fieldType: "SINGLE_LINE_TEXT" },
      ];
    },
    async getNumberPrecision() { return { digits: 16, decimalPlaces: 4, roundingMode: "HALF_EVEN" }; },
    async getProcessStatuses() { return { enable: false, states: null }; },
  };
  return { client, getRecords, writes };
}

async function previewOne(
  source: string,
  client: FlowKintoneClient,
  maxSamples?: number,
  enableNativeUpsert?: boolean
): Promise<PreviewResult> {
  const parsed = parseScript(`-- @ksql dialect: 1\n${source}`);
  expect(parsed.diagnostics).toEqual([]);
  const context = createExecutionContext({
    client, statements: parsed.statements, meta: parsed.meta,
    ...(enableNativeUpsert === undefined ? {} : { enableNativeUpsert }),
  });
  try {
    return await previewStatement(parsed.statements[0], context, maxSamples === undefined ? undefined : { maxSamples });
  } finally {
    await disposeExecutionContext(context);
  }
}

test("AC-11/19: native eligibility changes only UPSERT estimatedWrites; opt-out keeps legacy estimate", async () => {
  const stored = [{ $id: { value: "1" }, key: { value: "A" }, value: { value: "old" } }];
  const native = mockClient(stored);
  native.client.upsertRecords = async () => { throw new Error("preview must not write"); };
  const sql = "UPSERT INTO APP1 (key,value) VALUES ('A','new'),('B','new') ON DUPLICATE (key);";
  const nativePreview = await previewOne(sql, native.client);
  expect(nativePreview).toMatchObject({
    counts: { insert: 1, update: 1, delete: 0 }, reads: 1, estimatedWrites: 1,
  });
  expect(native.writes).toEqual({ post: 0, put: 0, delete: 0 });

  const legacy = mockClient(stored);
  legacy.client.upsertRecords = async () => { throw new Error("preview must not write"); };
  const legacyPreview = await previewOne(sql, legacy.client, undefined, false);
  expect(legacyPreview).toMatchObject({
    counts: { insert: 1, update: 1, delete: 0 }, reads: 1, estimatedWrites: 2,
  });
  expect(legacy.writes).toEqual({ post: 0, put: 0, delete: 0 });
});

test("previews INSERT, UPDATE, and DELETE with write-order samples and no writes", async () => {
  const insertMock = mockClient();
  const insert = await previewOne(
    "INSERT INTO APP1 (key,value) VALUES ('A','one'),('B','two'),('C','three'),('D','four'),('E','five'),('F','six');",
    insertMock.client
  );
  expect(insert).toEqual({
    kind: "PREVIEW", operation: "INSERT", appId: 1,
    counts: { insert: 6, update: 0, delete: 0 },
    samples: ["A", "B", "C", "D", "E"].map((key, index) => ({
      kind: "insert", after: { key, value: ["one", "two", "three", "four", "five"][index] },
    })),
    reads: 0, estimatedWrites: 1,
  });
  expect(insertMock.writes).toEqual({ post: 0, put: 0, delete: 0 });

  const rows = [
    { $id: { value: "1" }, key: { value: "A" }, value: { value: "old-a" } },
    { $id: { value: "2" }, key: { value: "B" }, value: { value: "old-b" } },
  ];
  const updateMock = mockClient(rows);
  const update = await previewOne("UPDATE APP1 SET value = 'new' WHERE $id >= 1;", updateMock.client);
  expect(update).toMatchObject({
    operation: "UPDATE", counts: { insert: 0, update: 2, delete: 0 }, reads: 1, estimatedWrites: 1,
    samples: [
      { kind: "update", before: { value: "old-a" }, after: { value: "new" } },
      { kind: "update", before: { value: "old-b" }, after: { value: "new" } },
    ],
  });
  expect(updateMock.writes).toEqual({ post: 0, put: 0, delete: 0 });

  const deleteMock = mockClient(rows);
  const deleted = await previewOne("DELETE FROM APP1 WHERE $id >= 1;", deleteMock.client, 1);
  expect(deleted).toMatchObject({
    operation: "DELETE", counts: { insert: 0, update: 0, delete: 2 },
    samples: [{ kind: "delete", key: "1" }], reads: 1, estimatedWrites: 1,
  });
  expect(deleteMock.writes).toEqual({ post: 0, put: 0, delete: 0 });
});

test("B171: previewStatement は INSERT VALUES の as-of 4関数を注入時刻へ展開する", async () => {
  const parsed = parseScript(`-- @ksql dialect: 1
INSERT INTO APP1 (key,value) VALUES (@TODAY(),@NOW()),(@MONTH_START(),@NEXT_MONTH_START());`);
  expect(parsed.diagnostics).toEqual([]);
  const mock = mockClient();
  const context = createExecutionContext({
    client: mock.client,
    statements: parsed.statements,
    meta: parsed.meta,
    asOf: new Date("2026-08-21T18:00:00.123Z"),
    timezone: "Asia/Tokyo",
  });
  try {
    await expect(previewStatement(parsed.statements[0], context)).resolves.toMatchObject({
      operation: "INSERT",
      samples: [
        { kind: "insert", after: { key: "2026-08-22", value: "2026-08-21T18:00:00.123Z" } },
        { kind: "insert", after: { key: "2026-08-01", value: "2026-09-01" } },
      ],
    });
    expect(mock.writes).toEqual({ post: 0, put: 0, delete: 0 });
  } finally {
    await disposeExecutionContext(context);
  }
});

test("250-row UPSERT classifies 120 inserts and 130 updates and estimates four writes", async () => {
  const existing = Array.from({ length: 130 }, (_, index) => ({
    $id: { value: String(index + 1) },
    key: { value: `K${index + 1}` },
    value: { value: `OLD${index + 1}` },
  }));
  const mock = mockClient(existing);
  const values = Array.from({ length: 250 }, (_, index) => `('K${index + 1}','NEW${index + 1}')`).join(",");
  const result = await previewOne(`UPSERT INTO APP1 (key,value) VALUES ${values} KEY (key);`, mock.client, 3);
  expect(result).toMatchObject({
    operation: "UPSERT", counts: { insert: 120, update: 130, delete: 0 }, reads: 5, estimatedWrites: 4,
    samples: [
      { kind: "insert", key: "K131", after: { key: "K131", value: "NEW131" } },
      { kind: "insert", key: "K132", after: { key: "K132", value: "NEW132" } },
      { kind: "insert", key: "K133", after: { key: "K133", value: "NEW133" } },
    ],
  });
  expect(mock.writes).toEqual({ post: 0, put: 0, delete: 0 });
});

test("maxSamples defaults to 5, accepts 50, and rejects invalid values before every client call", async () => {
  const accepted = mockClient();
  const values = Array.from({ length: 60 }, (_, index) => `('K${index}','V${index}')`).join(",");
  const result = await previewOne(`INSERT INTO APP1 (key,value) VALUES ${values};`, accepted.client, 50);
  expect(result.samples).toHaveLength(50);

  for (const invalid of [0, 51, 1.5]) {
    const mock = mockClient();
    const parsed = parseScript("-- @ksql dialect: 1\nDELETE FROM APP1 WHERE $id > 0;");
    const context = createExecutionContext({ client: mock.client, statements: parsed.statements, meta: parsed.meta });
    await expect(previewStatement(parsed.statements[0], context, { maxSamples: invalid })).rejects.toMatchObject({
      code: "ArgumentError",
    });
    expect(mock.getRecords).not.toHaveBeenCalled();
    expect(mock.writes).toEqual({ post: 0, put: 0, delete: 0 });
    await disposeExecutionContext(context);
  }
});

test("preview write blocker fails closed for every write method", async () => {
  const mock = mockClient();
  const blocked = wrapClientWithPreviewWriteBlock(mock.client);
  await expect(blocked.postRecords({ app: 1, records: [] })).rejects.toThrow("PreviewWriteBlockedError");
  await expect(blocked.putRecords({ app: 1, records: [] })).rejects.toThrow("PreviewWriteBlockedError");
  await expect(blocked.deleteRecords({ app: 1, ids: [] })).rejects.toThrow("PreviewWriteBlockedError");
  expect(mock.writes).toEqual({ post: 0, put: 0, delete: 0 });
});

test("temp table and as-of survive preview, and EXIT makes a later preview an empty skipped equivalent", async () => {
  const source = `-- @ksql dialect: 1
CREATE TEMP TABLE source_rows AS SELECT 'K1' AS key, @NOW() AS value;
UPSERT INTO APP1 (key,value) SELECT key,value FROM source_rows KEY (key);
SELECT key,value,@NOW() AS current FROM source_rows;`;
  const parsed = parseScript(source);
  const mock = mockClient([{
    $id: { value: "1" }, key: { value: "K1" }, value: { value: "old" },
  }]);
  const context = createExecutionContext({
    client: mock.client, statements: parsed.statements, meta: parsed.meta,
    asOf: new Date("2026-08-22T01:02:03.000Z"), timezone: "UTC",
  });
  await expect(executeStatement(parsed.statements[0], context)).resolves.toMatchObject({ status: "success" });
  await expect(previewStatement(parsed.statements[1], context)).resolves.toMatchObject({
    counts: { insert: 0, update: 1, delete: 0 },
    samples: [{
      kind: "update", key: "K1",
      before: { key: "K1", value: "old" },
      after: { key: "K1", value: "2026-08-22T01:02:03.000Z" },
    }],
  });
  await expect(executeStatement(parsed.statements[2], context)).resolves.toMatchObject({
    result: { rows: [{ key: "K1", value: "2026-08-22T01:02:03.000Z", current: "2026-08-22T01:02:03.000Z" }] },
  });
  await disposeExecutionContext(context);

  const exitParsed = parseScript(`-- @ksql dialect: 1
EXIT SUCCESS IF (SELECT 1) = 1, 'done';
DELETE FROM APP1 WHERE $id > 0;`);
  const exitContext = createExecutionContext({ client: mock.client, statements: exitParsed.statements, meta: exitParsed.meta });
  await executeStatement(exitParsed.statements[0], exitContext);
  await expect(previewStatement(exitParsed.statements[1], exitContext)).resolves.toMatchObject({
    operation: "DELETE", counts: { insert: 0, update: 0, delete: 0 }, reads: 0, estimatedWrites: 0,
  });
  await disposeExecutionContext(exitContext);
});

test("UPDATE FROM a bare temp-table name previews evaluated before/after values", async () => {
  const parsed = parseScript(`-- @ksql dialect: 1
CREATE TEMP TABLE changes AS SELECT 'A' AS key, 'new' AS next_value;
UPDATE APP1 SET value = s.next_value FROM changes s WHERE APP1.key = s.key;`);
  expect(parsed.diagnostics).toEqual([]);
  const mock = mockClient([{
    $id: { value: "1" }, key: { value: "A" }, value: { value: "old" },
  }]);
  const context = createExecutionContext({ client: mock.client, statements: parsed.statements, meta: parsed.meta });
  await executeStatement(parsed.statements[0], context);
  await expect(previewStatement(parsed.statements[1], context)).resolves.toMatchObject({
    counts: { insert: 0, update: 1, delete: 0 },
    samples: [{ kind: "update", before: { value: "old" }, after: { value: "new" } }],
    estimatedWrites: 1,
  });
  expect(mock.writes).toEqual({ post: 0, put: 0, delete: 0 });
  await disposeExecutionContext(context);
});

test("preview returns a physical LAPP id and rejects a concurrent call with the managed busy rule", async () => {
  const logical = parseScript("-- @ksql dialect: 1\nDELETE FROM LAPP_TARGET WHERE $id > 0;", {
    apps: { TARGET: 321 },
  });
  const logicalMock = mockClient();
  const logicalContext = createExecutionContext({
    client: logicalMock.client, statements: logical.statements, meta: logical.meta,
  });
  await expect(previewStatement(logical.statements[0], logicalContext)).resolves.toMatchObject({ appId: 321 });
  await disposeExecutionContext(logicalContext);

  const parsed = parseScript("-- @ksql dialect: 1\nDELETE FROM APP1 WHERE $id > 0; DELETE FROM APP1 WHERE $id > 0;");
  const mock = mockClient([{ $id: { value: "1" }, key: { value: "A" }, value: { value: "x" } }]);
  const baseGet = mock.client.getRecords;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let first = true;
  mock.client.getRecords = async (params) => {
    if (first) {
      first = false;
      entered();
      await gate;
    }
    return baseGet(params);
  };
  const context = createExecutionContext({ client: mock.client, statements: parsed.statements, meta: parsed.meta });
  const running = previewStatement(parsed.statements[0], context);
  await started;
  await expect(previewStatement(parsed.statements[1], context)).rejects.toMatchObject({
    code: "ExecutionContextBusyError",
  });
  release();
  await running;
  await expect(previewStatement(parsed.statements[1], context)).resolves.toMatchObject({
    counts: { delete: 1 },
  });
  await disposeExecutionContext(context);
});

test("rejects unsupported statements/modifiers before reads and enforces dialect 1 unique key", async () => {
  const cases = [
    "SELECT * FROM APP1;",
    "ASSERT (SELECT 1) = 1, 'ok';",
    "UPSERT INTO APP1 (key,value) VALUES ('K','V') KEY (key) VALIDATE ONLY;",
    "INSERT INTO APP1$detail (value) VALUES ('V');",
  ];
  for (const source of cases) {
    const parsed = parseScript(`-- @ksql dialect: 1\n${source}`);
    expect(parsed.diagnostics).toEqual([]);
    const mock = mockClient();
    const context = createExecutionContext({ client: mock.client, statements: parsed.statements, meta: parsed.meta });
    await expect(previewStatement(parsed.statements[0], context)).rejects.toMatchObject({ code: "ArgumentError" });
    expect(mock.getRecords).not.toHaveBeenCalled();
    await disposeExecutionContext(context);
  }

  const parsed = parseScript("-- @ksql dialect: 1\nUPSERT INTO APP1 (key,value) VALUES ('K','V') KEY (key);");
  const mock = mockClient();
  mock.client.getFields = async () => [
    { code: "key", label: "key", fieldType: "SINGLE_LINE_TEXT", isUnique: false },
    { code: "value", label: "value", fieldType: "SINGLE_LINE_TEXT" },
  ];
  const context = createExecutionContext({ client: mock.client, statements: parsed.statements, meta: parsed.meta });
  await expect(previewStatement(parsed.statements[0], context)).rejects.toMatchObject({ code: "ArgumentError" });
  expect(mock.getRecords).not.toHaveBeenCalled();
  await disposeExecutionContext(context);
});

test("rejects CHECK, APPLY, and IMPORT with actionable messages before record reads", async () => {
  const fixtures: Array<{ source: string; mutate?: (statement: any) => void; message: RegExp }> = [
    {
      source: "INSERT INTO APP1 (key,value) VALUES ('K','V');",
      mutate: (statement) => { statement.checkGroups = [{}]; },
      message: /CHECK.*executeStatement/,
    },
    {
      source: "UPSERT INTO APP1 (key,value) VALUES ('K','V') KEY (key);",
      mutate: (statement) => { statement.onUpdateApplyBlocks = [{}]; },
      message: /APPLY.*executeStatement/,
    },
    {
      source: "INSERT INTO APP1 (key,value) VALUES ('K','V');",
      mutate: (statement) => { statement.type = "IMPORT"; },
      message: /IMPORT.*executeStatement/,
    },
  ];
  for (const fixture of fixtures) {
    const parsed = parseScript(`-- @ksql dialect: 1\n${fixture.source}`);
    expect(parsed.statements).toHaveLength(1);
    const mock = mockClient();
    const context = createExecutionContext({ client: mock.client, statements: parsed.statements, meta: parsed.meta });
    // Mutate only after context analysis so this test reaches previewStatement's own
    // pre-read contract guard without changing createExecutionContext behavior.
    fixture.mutate?.(parsed.statements[0]);
    await expect(previewStatement(parsed.statements[0], context)).rejects.toThrow(fixture.message);
    expect(mock.getRecords).not.toHaveBeenCalled();
    await disposeExecutionContext(context);
  }
});
