import {
  B65_EXECUTION_CLOSED_MESSAGE,
  execute,
  type KintoneClient,
} from "../execute";

function client(fieldsByApp: Record<number, string[]>): KintoneClient & { recordCalls: number } {
  return {
    recordCalls: 0,
    async getRecords() {
      this.recordCalls++;
      return { records: [] };
    },
    async openCursor() { throw new Error("unexpected cursor"); },
    async postRecords() { throw new Error("unexpected write"); },
    async putRecords() { throw new Error("unexpected write"); },
    async deleteRecords() { throw new Error("unexpected write"); },
    async getApps() { return []; },
    async getFields(appId) {
      return (fieldsByApp[appId] ?? []).map((code) => ({
        code,
        label: code,
        fieldType: "SINGLE_LINE_TEXT",
      }));
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() { return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const }; },
  };
}

test("B65 Step1 execution-closed gate: accepted syntax/planning stops before records fetch", async () => {
  const mock = client({ 1: ["a", "x"] });
  await expect(execute(
    "SELECT CASE WHEN GROUPING(a)=1 THEN 'total' ELSE a END AS a, SUM(x) AS total " +
    "FROM APP1 GROUP BY ROLLUP(a)",
    mock,
    { cacheContext: "b65-gate" }
  )).rejects.toThrow(B65_EXECUTION_CLOSED_MESSAGE);
  expect(mock.recordCalls).toBe(0);
});

test("B65 planning rejects unknown/ambiguous/GROUPING-not-item/alias collision before fetch", async () => {
  const cases = [
    ["SELECT a FROM APP1 GROUP BY ROLLUP(missing)", /does not exist/],
    ["SELECT GROUPING(b), SUM(x) FROM APP1 GROUP BY ROLLUP(a)", /NOT_ITEM/],
    ["SELECT a, SUM(x) AS a FROM APP1 GROUP BY ROLLUP(a)", /ALIAS_COLLISION/],
    [
      "SELECT a.a FROM APP1 a JOIN APP2 b ON a.id=b.id GROUP BY ROLLUP(id)",
      /ambiguous/,
    ],
  ] as const;
  for (const [sql, message] of cases) {
    const mock = client({ 1: ["a", "b", "x", "id"], 2: ["id"] });
    await expect(execute(sql, mock, { cacheContext: `b65-reject-${sql}` })).rejects.toThrow(message);
    expect(mock.recordCalls).toBe(0);
  }
});

test("B65 materialized CTE grouping item is rejected before the CTE body fetches", async () => {
  const mock = client({ 1: ["a"] });
  await expect(execute(
    "WITH c AS (SELECT a FROM APP1) SELECT a FROM c GROUP BY ROLLUP(a)",
    mock,
    { cacheContext: "b65-cte-reject" }
  )).rejects.toThrow(/materialized CTE\/temp column/);
  expect(mock.recordCalls).toBe(0);
});

test("B65 qualified physical grouping item may coexist with a materialized CTE, then hits the closed gate", async () => {
  const mock = client({ 1: ["a", "id"], 2: ["id"] });
  await expect(execute(
    "WITH c AS (SELECT id FROM APP2) SELECT p.a FROM APP1 p JOIN c ON p.id=c.id GROUP BY ROLLUP(p.a)",
    mock,
    { cacheContext: "b65-cte-physical" }
  )).rejects.toThrow(B65_EXECUTION_CLOSED_MESSAGE);
  expect(mock.recordCalls).toBe(0);
});

test("B65 EXPLAIN は execution gate を開けず records API 0 で planning を通る", async () => {
  const mock = client({ 1: ["a", "x"] });
  await expect(execute(
    "EXPLAIN SELECT GROUPING(a) AS g, CASE WHEN GROUPING(a)=1 THEN 'total' ELSE a END AS a, " +
    "SUM(x) AS total FROM APP1 GROUP BY ROLLUP(a) ORDER BY GROUPING(a), total DESC",
    mock,
    { cacheContext: "b65-explain" }
  )).resolves.toMatchObject({ type: "SELECT" });
  expect(mock.recordCalls).toBe(0);
});
