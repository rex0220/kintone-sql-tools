import {
  execute,
  executeBatch,
  type KintoneClient,
  type SelectResult,
} from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";

const field = (value: unknown) => ({ value });

function record(values: Record<string, unknown>): KintoneRecord {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name, field(value)])
  ) as KintoneRecord;
}

function makeClient(recordsByApp: Record<number, KintoneRecord[]> = {}): KintoneClient & {
  readonly startedApps: number[];
} {
  const startedApps: number[] = [];
  return {
    startedApps,
    async getRecords({ app }) {
      startedApps.push(app);
      return { records: recordsByApp[app] ?? [] };
    },
    async openCursor() { throw new Error("unexpected cursor call"); },
    async postRecords() { throw new Error("unexpected write call"); },
    async putRecords() { throw new Error("unexpected write call"); },
    async deleteRecords() { throw new Error("unexpected write call"); },
    async getApps() {
      return [{ appId: 100, name: "fixture", description: "B137" }];
    },
    async getFields(appId) {
      const names = new Set(
        (recordsByApp[appId] ?? []).flatMap((item) => Object.keys(item))
      );
      return [...names]
        .filter((name) => !name.startsWith("$"))
        .map((name) => ({ code: name, label: name, fieldType: "SINGLE_LINE_TEXT" }));
    },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const };
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
  };
}

const mismatchMessage =
  "ArgumentError: UNION の左右で列数が一致しません（左 2 列 / 右 1 列）。";

test.each([
  ["右辺が少ない UNION", "SELECT a, b FROM APP100 UNION SELECT c FROM APP200", mismatchMessage],
  [
    "右辺が多い UNION ALL",
    "SELECT a FROM APP100 UNION ALL SELECT b, c FROM APP200",
    "ArgumentError: UNION の左右で列数が一致しません（左 1 列 / 右 2 列）。",
  ],
])("B137: %s は両辺の実体化後に ArgumentError", async (_label, sql, message) => {
  const client = makeClient({
    100: [record({ a: "A", b: "B" })],
    200: [record({ b: "B", c: "C" })],
  });

  await expect(execute(sql, client)).rejects.toThrow(message);
  expect(client.startedApps).toEqual(expect.arrayContaining([100, 200]));
  expect(client.startedApps).toHaveLength(2);
});

test("B137: CTE 内の UNION も列数不一致を拒否する", async () => {
  const client = makeClient({
    100: [record({ a: "A", b: "B" })],
    200: [record({ c: "C" })],
  });

  await expect(execute(
    "WITH u AS (SELECT a, b FROM APP100 UNION SELECT c FROM APP200) SELECT * FROM u",
    client
  )).rejects.toThrow(mismatchMessage);
});

test("B137: 列数不一致の UNION は一時テーブルへ実体化しない", async () => {
  const result = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT a, b FROM APP100 UNION SELECT c FROM APP200; " +
      "SELECT * FROM #t",
    makeClient({
      100: [record({ a: "A", b: "B" })],
      200: [record({ c: "C" })],
    })
  );

  expect(result.ok).toBe(false);
  expect(result.statements[0]).toMatchObject({
    type: "CREATE_TEMP_TABLE",
    status: "error",
    error: { code: "ArgumentError", message: expect.stringContaining("左 2 列 / 右 1 列") },
  });
  expect(result.statements[1]).toMatchObject({ status: "skipped" });
});

test.each([
  [
    "内側",
    "SELECT a FROM APP100 UNION ALL SELECT b, c FROM APP200 UNION ALL SELECT d FROM APP300",
    "左 1 列 / 右 2 列",
  ],
  [
    "外側",
    "SELECT a FROM APP100 UNION ALL SELECT b FROM APP200 UNION ALL SELECT c, d FROM APP300",
    "左 1 列 / 右 2 列",
  ],
])("B137: 3 段連鎖の%s不一致でも全枝を開始する", async (_node, sql, counts) => {
  const client = makeClient({
    100: [record({ a: "A" })],
    200: [record({ b: "B", c: "C" })],
    300: [record({ c: "C", d: "D" })],
  });

  await expect(execute(sql, client)).rejects.toThrow(counts);
  expect(client.startedApps.sort((a, b) => a - b)).toEqual([100, 200, 300]);
});

test("B137: 列数が同じなら列名が違っても左辺名で UNION / UNION ALL できる", async () => {
  const client = makeClient({
    100: [record({ a: "A", b: "B" })],
    200: [record({ c: "C", d: "D" }), record({ c: "A", d: "B" })],
  });
  const distinct = await execute(
    "SELECT a, b FROM APP100 UNION SELECT c, d FROM APP200",
    client
  ) as SelectResult;
  const all = await execute(
    "SELECT a, b FROM APP100 UNION ALL SELECT c, d FROM APP200",
    client
  ) as SelectResult;

  expect(distinct.columns).toEqual(["a", "b"]);
  expect(distinct.rows).toEqual([{ a: "A", b: "B" }, { a: "C", b: "D" }]);
  expect(all.rows).toEqual([
    { a: "A", b: "B" },
    { a: "C", b: "D" },
    { a: "A", b: "B" },
  ]);
});

test("B137: FROM なしの同列数 UNION ALL は従来どおり通る", async () => {
  const result = await execute(
    "SELECT 'A' AS value UNION ALL SELECT 'B' AS other",
    makeClient()
  ) as SelectResult;

  expect(result.columns).toEqual(["value"]);
  expect(result.rows).toEqual([{ value: "A" }, { value: "B" }]);
});

test("B137: SHOW APPS と同じ 3 列なら UNION ALL できる", async () => {
  const result = await execute(
    "WITH listed AS (SHOW APPS) SELECT * FROM listed " +
      "UNION ALL SELECT '200' AS id, 'other' AS name, '' AS description",
    makeClient()
  ) as SelectResult;

  expect(result.columns).toEqual(["アプリID", "アプリ名", "説明"]);
  expect(result.rowCount).toBe(2);
});

test("B137: DESCRIBE と同じ 8 列なら UNION ALL できる", async () => {
  // B145 でサブテーブル列が増えたため 7 → 8。
  const result = await execute(
    "WITH d AS (DESCRIBE APP100) SELECT * FROM d UNION ALL " +
      "SELECT 'code', 'label', 'type', '', '', '', '', ''",
    makeClient({ 100: [record({ code: "x" })] })
  ) as SelectResult;

  expect(result.columns).toHaveLength(8);
  expect(result.rowCount).toBe(2);
});

test("B137: EXPLAIN は列数が違う UNION でも計画を返し records API を呼ばない", async () => {
  const client = makeClient();
  const result = await execute(
    "EXPLAIN SELECT a, b FROM APP100 UNION SELECT c FROM APP200",
    client
  ) as SelectResult;

  expect(result.columns).toEqual(["plan"]);
  expect(result.rows.some((row) => String(row.plan).includes("[union:1]"))).toBe(true);
  expect(result.rows.some((row) => String(row.plan).includes("[union:2]"))).toBe(true);
  expect(client.startedApps).toEqual([]);
});
