import { execute, executeBatch, type KintoneClient, type KintoneFieldInfo } from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";
import type { NumberPrecision } from "../core/numberPrecision";

function makeClient(options: {
  fields?: KintoneFieldInfo[];
  records?: KintoneRecord[];
  recordsByApp?: Record<number, KintoneRecord[]>;
  precision?: NumberPrecision;
  settingsError?: Error;
} = {}) {
  const fields = options.fields ?? [
    { code: "n", label: "n", fieldType: "NUMBER" },
    { code: "text", label: "text", fieldType: "SINGLE_LINE_TEXT" },
  ];
  const calls = { settings: 0, post: 0, put: 0, get: 0 };
  const client: KintoneClient = {
    async getRecords(params) { calls.get++; return { records: options.recordsByApp?.[params.app] ?? options.records ?? [] }; },
    async openCursor() { throw new Error("unexpected cursor"); },
    async postRecords(params) { calls.post++; return { ids: params.records.map((_, index) => String(index + 1)) }; },
    async putRecords() { calls.put++; },
    async deleteRecords() {},
    async getApps() { return []; },
    async getFields() { return fields; },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() {
      calls.settings++;
      if (options.settingsError) throw options.settingsError;
      return options.precision ?? { digits: 4, decimalPlaces: 2, roundingMode: "HALF_EVEN" };
    },
  };
  return { client, calls };
}

test("NUMBER対象だけsettingsを取得し、read-only・文字列DML・CALC直接指定では取得しない", async () => {
  const plain = makeClient();
  await execute("SELECT text FROM APP92001", plain.client, { cacheContext: "b29-select" });
  await execute("INSERT INTO APP92001 (text) VALUES ('x')", plain.client, { cacheContext: "b29-text" });
  expect(plain.calls.settings).toBe(0);

  const calc = makeClient({ fields: [{ code: "c", label: "c", fieldType: "CALC", writable: false }] });
  await expect(execute("INSERT INTO APP92002 (c) VALUES (1)", calc.client, { cacheContext: "b29-calc" }))
    .rejects.toThrow(/not writable \(CALC\)/);
  expect(calc.calls.settings).toBe(0);
});

test("通常INSERTは同じprecision primitiveでAPI前に停止し、valid payloadを変えない", async () => {
  const invalid = makeClient();
  await expect(execute("INSERT INTO APP92003 (n) VALUES (100)", invalid.client, { cacheContext: "b29-normal-ng" }))
    .rejects.toThrow(/ERR_NUMBER_INTEGER_DIGITS/);
  expect(invalid.calls).toMatchObject({ settings: 1, post: 0 });

  const valid = makeClient();
  await execute("INSERT INTO APP92004 (n) VALUES (99.99)", valid.client, { cacheContext: "b29-normal-ok" });
  expect(valid.calls).toMatchObject({ settings: 1, post: 1 });
});

test("VALIDATE ONLYとON ERROR SKIPは小数超過を隔離せず元値を通す", async () => {
  const validate = makeClient();
  const result = await execute(
    "INSERT INTO APP92005 (n) VALUES (1.234) VALIDATE ONLY",
    validate.client,
    { cacheContext: "b29-validate" }
  );
  expect(result).toMatchObject({ type: "VALIDATION", validRows: 1, invalidRows: 0, errors: [] });
  expect(validate.calls.post).toBe(0);

  const skip = makeClient();
  const batch = await executeBatch(
    "INSERT INTO APP92006 (n) VALUES (1.23), (1.234) ON ERROR SKIP INTO #err; SELECT * FROM #err",
    skip.client,
    { cacheContext: "b29-skip" }
  );
  expect(skip.calls).toMatchObject({ settings: 1, post: 1 });
  expect(batch.statements[1].result).toMatchObject({
    type: "SELECT",
    rows: [],
  });
});

test("同一cacheContext×appIdの複数文はin-flight Promiseを含め最大1回、別scopeは共有しない", async () => {
  const shared = makeClient();
  await executeBatch(
    "INSERT INTO APP92007 (n) VALUES (1); INSERT INTO APP92007 (n) VALUES (2)",
    shared.client,
    { cacheContext: "b29-cache-shared" }
  );
  expect(shared.calls.settings).toBe(1);
  await execute("INSERT INTO APP92007 (n) VALUES (3)", shared.client, { cacheContext: "b29-cache-other" });
  expect(shared.calls.settings).toBe(2);

  const concurrent = makeClient();
  await Promise.all([
    execute("INSERT INTO APP92008 (n) VALUES (1)", concurrent.client, { cacheContext: "b29-cache-concurrent" }),
    execute("INSERT INTO APP92008 (n) VALUES (2)", concurrent.client, { cacheContext: "b29-cache-concurrent" }),
  ]);
  expect(concurrent.calls.settings).toBe(1);
});

test("settings失敗はVALIDATE ONLY/ON ERROR SKIPでも既定値を補わず文全体をfail-closedする", async () => {
  const failed = makeClient({ settingsError: new Error("settings unavailable") });
  await expect(execute(
    "INSERT INTO APP92009 (n) VALUES (1) VALIDATE ONLY",
    failed.client,
    { cacheContext: "b29-settings-fail" }
  )).rejects.toThrow("settings unavailable");
  expect(failed.calls.post).toBe(0);
});

test("空のINSERT SELECTでも書込先NUMBERが確定すればsettingsを取得する", async () => {
  const empty = makeClient();
  const result = await execute(
    "INSERT INTO APP92010 (n) SELECT n FROM APP92011",
    empty.client,
    { cacheContext: "b29-empty-select" }
  );
  expect(result).toMatchObject({ type: "INSERT", insertedCount: 0 });
  expect(empty.calls).toMatchObject({ settings: 1, post: 0 });
});

describe("§6.2 DML横断precision matrix", () => {
  const targetRecord: KintoneRecord = {
    $id: { value: "1" }, key: { value: "A" }, n: { value: "99" }, joinKey: { value: "K" },
  };
  const sourceRecord: KintoneRecord = {
    $id: { value: "2" }, key: { value: "B" }, n: { value: "100" }, joinKey: { value: "K" },
  };
  const fields: KintoneFieldInfo[] = [
    { code: "key", label: "key", fieldType: "SINGLE_LINE_TEXT" },
    { code: "joinKey", label: "joinKey", fieldType: "SINGLE_LINE_TEXT" },
    { code: "n", label: "n", fieldType: "NUMBER" },
  ];
  const routes: Array<{ name: string; sql: string; recordsByApp: Record<number, KintoneRecord[]> }> = [
    { name: "INSERT VALUES", sql: "INSERT INTO APP92100 (n) VALUES (100)", recordsByApp: {} },
    { name: "INSERT SELECT", sql: "INSERT INTO APP92100 (n) SELECT n FROM APP92101", recordsByApp: { 92101: [sourceRecord] } },
    { name: "UPSERT VALUES create/update", sql: "UPSERT INTO APP92100 (key, n) VALUES ('A', 100) ON DUPLICATE (key)", recordsByApp: { 92100: [targetRecord] } },
    { name: "UPSERT SELECT create/update", sql: "UPSERT INTO APP92100 (key, n) SELECT key, n FROM APP92101 ON DUPLICATE (key)", recordsByApp: { 92100: [targetRecord], 92101: [sourceRecord] } },
    { name: "UPDATE normal", sql: "UPDATE APP92100 SET n = 100 WHERE $id = 1", recordsByApp: { 92100: [targetRecord] } },
    { name: "UPDATE arithmetic", sql: "UPDATE APP92100 SET n = n + 1 WHERE $id = 1", recordsByApp: { 92100: [targetRecord] } },
    { name: "UPDATE CASE", sql: "UPDATE APP92100 SET n = CASE WHEN key = 'A' THEN 100 ELSE 1 END WHERE $id = 1", recordsByApp: { 92100: [targetRecord] } },
    { name: "UPDATE FROM", sql: "UPDATE APP92100 SET n = s.n FROM APP92101 s WHERE APP92100.joinKey = s.joinKey", recordsByApp: { 92100: [targetRecord], 92101: [sourceRecord] } },
  ];

  test.each(routes)("$name: 通常/VALIDATE ONLY/ON ERROR SKIPが同じinteger errorでAPI前停止", async ({ sql, recordsByApp }) => {
    const normal = makeClient({ fields, recordsByApp: { ...recordsByApp } });
    await expect(execute(sql, normal.client, { cacheContext: `b29-matrix-normal-${sql}` }))
      .rejects.toThrow(/ERR_NUMBER_INTEGER_DIGITS/);
    expect(normal.calls.post + normal.calls.put).toBe(0);

    const validate = makeClient({ fields, recordsByApp: { ...recordsByApp } });
    const validation = await execute(`${sql} VALIDATE ONLY`, validate.client, {
      cacheContext: `b29-matrix-validate-${sql}`,
    });
    expect(validation).toMatchObject({ type: "VALIDATION", invalidRows: 1 });
    if (validation.type === "VALIDATION") {
      expect(validation.errors[0]["$err_code"]).toBe("ERR_NUMBER_INTEGER_DIGITS");
    }
    expect(validate.calls.post + validate.calls.put).toBe(0);

    const skip = makeClient({ fields, recordsByApp: { ...recordsByApp } });
    const skipped = await executeBatch(`${sql} ON ERROR SKIP INTO #err; SELECT * FROM #err`, skip.client, {
      cacheContext: `b29-matrix-skip-${sql}`,
    });
    expect(skip.calls.post + skip.calls.put).toBe(0);
    expect(skipped.statements[1].result).toMatchObject({
      type: "SELECT",
      rows: [expect.objectContaining({ $err_code: "ERR_NUMBER_INTEGER_DIGITS" })],
    });
  });
});
