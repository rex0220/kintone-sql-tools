import {
  createExecutionContext,
  disposeExecutionContext,
  executeStatement,
  explainScript,
  isDmlResult,
  parseScript,
  type FlowChunkWrittenInfo,
  type FlowDeleteResult,
  type FlowDmlResult,
  type FlowInsertResult,
  type FlowKintoneClient,
  type FlowUpdateResult,
  type FlowUpsertResult,
} from "../index";

function client(existingKeys = new Set<string>()): FlowKintoneClient {
  let nextId = 1000;
  return {
    async getRecords(params) {
      const keys = [...params.query.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
      const records = keys.filter((key) => existingKeys.has(key)).map((key) => ({
        $id: { value: String(++nextId) },
        key: { value: key },
      }));
      return params.totalCount ? { records, totalCount: String(records.length) } : { records };
    },
    async openCursor() {
      return { totalCount: 0, async nextPage() { return { records: [], next: false }; }, async close() {} };
    },
    async postRecords({ records }) { return { ids: records.map(() => String(++nextId)) }; },
    async putRecords() {},
    async deleteRecords() {},
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
}

const AS_OF_SCRIPT = `-- @ksql dialect: 1
CREATE TEMP TABLE clock AS SELECT @NOW() AS captured;
SELECT captured, @MONTH_START() AS month_start FROM clock;`;

test("E-6 explainScript initializes one shared as-of clock with explicit and default options", async () => {
  const explicit = await explainScript(AS_OF_SCRIPT, {
    client: client(),
    resolveMetadata: false,
    asOf: new Date("2026-08-21T12:34:56.000Z"),
    timezone: "Asia/Tokyo",
  });
  expect(explicit.statementCount).toBe(2);
  await expect(explainScript(AS_OF_SCRIPT, {
    client: client(),
    resolveMetadata: false,
  })).resolves.toMatchObject({ statementCount: 2 });
});

test("E-3 public DML union and guard accept exactly the stable four DML shapes", () => {
  const values: FlowDmlResult[] = [
    { type: "INSERT", createdIds: [["1"]], insertedCount: 1 } satisfies FlowInsertResult,
    { type: "UPDATE", updatedCount: 1 } satisfies FlowUpdateResult,
    { type: "DELETE", deletedCount: 1 } satisfies FlowDeleteResult,
    { type: "UPSERT", insertedCount: 1, updatedCount: 1 } satisfies FlowUpsertResult,
  ];
  expect(values.every(isDmlResult)).toBe(true);
  expect(isDmlResult({ type: "SELECT", rows: [], columns: [], rowCount: 0 })).toBe(false);
  expect(isDmlResult({ type: "ASSERT", passed: true })).toBe(false);
  expect(isDmlResult({ type: "INSERT", insertedCount: 1 })).toBe(false);
});

test("E-5 StatementResult metrics are cumulative deep-copy snapshots", async () => {
  const parsed = parseScript("SELECT * FROM APP1 LIMIT 1; SELECT * FROM APP1 LIMIT 1;");
  const context = createExecutionContext({ client: client(), statements: parsed.statements, meta: parsed.meta });
  const first = await executeStatement(parsed.statements[0], context);
  const firstGetCalls = first.metrics.getCalls;
  const firstLimitApps = first.metrics.limitReachedApps;
  const second = await executeStatement(parsed.statements[1], context);

  expect(first.metrics.getCalls).toBe(firstGetCalls);
  expect(first.metrics.limitReachedApps).toBe(firstLimitApps);
  expect(first.metrics.limitReachedApps).not.toBe(second.metrics.limitReachedApps);
  expect(second.metrics.getCalls - first.metrics.getCalls).toBe(1);
  await disposeExecutionContext(context);
  expect(first.metrics.getCalls).toBe(firstGetCalls);
});

function upsertSql(count: number): string {
  const values = Array.from({ length: count }, (_, index) => `('K${index + 1}','V${index + 1}')`);
  return `-- @ksql dialect: 1\nUPSERT INTO APP1 (key,value) VALUES ${values.join(",")} KEY (key);`;
}

test("E-1 250-row UPSERT emits awaited INSERT/UPDATE chunk callbacks in write order", async () => {
  const existing = new Set(Array.from({ length: 50 }, (_, index) => `K${index + 1}`));
  const parsed = parseScript(upsertSql(250));
  const events: FlowChunkWrittenInfo[] = [];
  let releaseFirst!: () => void;
  const firstCheckpoint = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let markCallbackEntered!: () => void;
  const callbackEntered = new Promise<void>((resolve) => { markCallbackEntered = resolve; });
  const context = createExecutionContext({
    client: client(existing),
    statements: parsed.statements,
    meta: parsed.meta,
    onChunkWritten: async (info) => {
      events.push(info);
      if (info.chunkIndex === 0) {
        markCallbackEntered();
        await firstCheckpoint;
      }
    },
  });

  let settled = false;
  const execution = executeStatement(parsed.statements[0], context).then((result) => {
    settled = true;
    return result;
  });
  await Promise.race([
    callbackEntered,
    new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error("callback was not reached")), 2_000)),
  ]);
  expect(settled).toBe(false);
  releaseFirst();
  const result = await execution;

  expect(result.status).toBe("success");
  expect(isDmlResult(result.result)).toBe(true);
  expect(result.result).toEqual({ type: "UPSERT", insertedCount: 200, updatedCount: 50 });
  expect(events).toEqual([
    { statementIndex: 0, appId: 1, operation: "INSERT", records: 100, chunkIndex: 0, lastKeyValue: "K150" },
    { statementIndex: 0, appId: 1, operation: "INSERT", records: 100, chunkIndex: 1, lastKeyValue: "K250" },
    { statementIndex: 0, appId: 1, operation: "UPDATE", records: 50, chunkIndex: 2, lastKeyValue: "K50" },
  ]);
  await disposeExecutionContext(context);
});

test("E-1 callback throw becomes the statement error after the successful write", async () => {
  const parsed = parseScript(upsertSql(1));
  let writes = 0;
  const base = client();
  const context = createExecutionContext({
    client: { ...base, async postRecords(params) { writes += 1; return base.postRecords(params); } },
    statements: parsed.statements,
    meta: parsed.meta,
    onChunkWritten() { throw new Error("checkpoint failed"); },
  });
  const result = await executeStatement(parsed.statements[0], context);
  expect(writes).toBe(1);
  expect(result).toMatchObject({ status: "error", error: { message: "checkpoint failed" } });
  await disposeExecutionContext(context);
});

test("E-1 omitted callback preserves ordinary UPSERT behavior", async () => {
  const parsed = parseScript(upsertSql(1));
  const context = createExecutionContext({ client: client(), statements: parsed.statements, meta: parsed.meta });
  await expect(executeStatement(parsed.statements[0], context)).resolves.toMatchObject({
    status: "success",
    result: { type: "UPSERT", insertedCount: 1, updatedCount: 0 },
  });
  await disposeExecutionContext(context);
});

test("E-1 callback exposes the physical appId for a logical app", async () => {
  const source = "-- @ksql dialect: 1\nUPSERT INTO LAPP_TARGET (key,value) VALUES ('K1','V1') KEY (key);";
  const parsed = parseScript(source, { apps: { TARGET: 321 } });
  const events: FlowChunkWrittenInfo[] = [];
  const context = createExecutionContext({
    client: client(),
    statements: parsed.statements,
    meta: parsed.meta,
    onChunkWritten(info) { events.push(info); },
  });
  await executeStatement(parsed.statements[0], context);
  expect(events[0]).toMatchObject({ appId: 321, lastKeyValue: "K1" });
  await disposeExecutionContext(context);
});
