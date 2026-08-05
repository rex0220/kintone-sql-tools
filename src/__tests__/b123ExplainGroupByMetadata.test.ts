import { execute, type KintoneClient, type KintoneFieldInfo, type SelectResult } from "../execute";

const fields: KintoneFieldInfo[] = [
  { code: "category", label: "category", fieldType: "SINGLE_LINE_TEXT" },
  { code: "id", label: "id", fieldType: "NUMBER", sortKind: "number" },
  { code: "amount", label: "amount", fieldType: "NUMBER", sortKind: "number" },
];

function makeClient(): KintoneClient & {
  getFieldsCalls: jest.Mock;
  getRecordsCalls: jest.Mock;
  openCursorCalls: jest.Mock;
} {
  const getFieldsCalls = jest.fn(async () => fields);
  const getRecordsCalls = jest.fn(async () => {
    throw new Error("records API must not be called by EXPLAIN");
  });
  const openCursorCalls = jest.fn(async () => {
    throw new Error("cursor API must not be called by EXPLAIN");
  });
  return {
    getFieldsCalls,
    getRecordsCalls,
    openCursorCalls,
    getRecords: getRecordsCalls,
    openCursor: openCursorCalls,
    async postRecords() { throw new Error("unexpected write"); },
    async putRecords() { throw new Error("unexpected write"); },
    async deleteRecords() { throw new Error("unexpected write"); },
    async getApps() { return []; },
    getFields: getFieldsCalls,
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() { return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const }; },
  };
}

test.each([
  "SELECT category, COUNT(*) FROM APP100 GROUP BY category",
  "SELECT category FROM APP100 GROUP BY category",
  "SELECT category, COUNT(*) FROM APP100 GROUP BY category HAVING COUNT(*) > 1",
  "SELECT a.category, SUM(b.amount) FROM APP100 a LEFT JOIN APP200 b ON a.id=b.id GROUP BY a.category",
  "WITH grouped AS (SELECT category, COUNT(*) AS n FROM APP100 GROUP BY category) SELECT category, n FROM grouped",
])("B123: 通常 GROUP BY の EXPLAIN 受入: %s", async (sql) => {
  const client = makeClient();
  const result = await execute(`EXPLAIN ${sql}`, client, { cacheContext: `b123-${sql.length}` }) as SelectResult;
  expect(result.rows.length).toBeGreaterThan(0);
  expect(result.rows.some((row) => String(row.plan).includes("GROUP BY あり"))).toBe(true);
  expect(client.getFieldsCalls).toHaveBeenCalled();
  expect(client.getRecordsCalls).not.toHaveBeenCalled();
  expect(client.openCursorCalls).not.toHaveBeenCalled();
});

test("B123: GROUP BY の無い COUNT(*) はフォーム定義取得を増やさない", async () => {
  const client = makeClient();
  const result = await execute("EXPLAIN SELECT COUNT(*) FROM APP100", client) as SelectResult;
  expect(result.rows.some((row) => String(row.plan).includes("COUNT_TOTAL_COUNT"))).toBe(true);
  expect(client.getFieldsCalls).not.toHaveBeenCalled();
  expect(client.getRecordsCalls).not.toHaveBeenCalled();
  expect(client.openCursorCalls).not.toHaveBeenCalled();
});
