import {
  explainQuery,
  type ExplainResult,
  type ReadonlyKintoneClient,
} from "../index";

const fields = [
  { code: "登録日", label: "登録日", fieldType: "DATE" },
  { code: "確度", label: "確度", fieldType: "DROP_DOWN", optionOrder: { A: 0, B: 1 } },
  { code: "顧客ID", label: "顧客ID", fieldType: "SINGLE_LINE_TEXT" },
  { code: "顧客名", label: "顧客名", fieldType: "SINGLE_LINE_TEXT" },
] as const;

function makeClient(): ReadonlyKintoneClient {
  return {
    async getRecords() { throw new Error("records API must not be called by EXPLAIN"); },
    async openCursor() { throw new Error("cursor API must not be called by EXPLAIN"); },
    async getApps() { return []; },
    async getFields() { return fields; },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" };
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
  };
}

type FetchSource = NonNullable<ExplainResult["plan"]>["statements"][number]["sources"][number];

function fetchLine(source: FetchSource): string {
  return [
    `  fetch:         ${source.fetch.toUpperCase()}`,
    ...(source.limit === null ? [] : [`(limit ${source.limit})`]),
    ...(source.pending ? ["(未確定)"] : []),
  ].join(" ");
}

function expectTextAndPlanAgree(result: ExplainResult): void {
  expect(result.plan).toBeDefined();
  for (const statement of result.plan!.statements) {
    for (const source of statement.sources) {
      expect(result.lines.some((line) => line.trim() === fetchLine(source).trim())).toBe(true);
      expect(source.kintoneQuery === null).toBe(source.fetch === "all");
    }
  }
}

test.each([
  [
    "COUNT_ONLY + limit",
    "SELECT COUNT(*) FROM APP100",
    { fetch: "count_only", pending: false, kintoneQuery: "limit 1", limit: 1 },
  ],
  [
    "EXACT",
    "SELECT 登録日 FROM APP100 WHERE 登録日 >= '2026-01-01' AND 登録日 < '2027-01-01'",
    { fetch: "exact", pending: false, limit: null },
  ],
  [
    "PREFILTERED + pending",
    "SELECT 確度, COUNT(*) FROM APP100 WHERE 確度 IN ('A') GROUP BY 確度",
    { fetch: "prefiltered", pending: true, kintoneQuery: '確度 in ("A")', limit: null },
  ],
  [
    "ALL + null query",
    "SELECT 顧客名 FROM APP100 WHERE 顧客名 LIKE 'A%'",
    { fetch: "all", pending: false, kintoneQuery: null, limit: null },
  ],
] as const)("B114 structured plan: %s matches the existing text", async (_name, sql, expected) => {
  const result = await explainQuery(sql, { client: makeClient() });
  expect(result.plan?.statements).toHaveLength(1);
  expect(result.plan?.statements[0]).toMatchObject({ index: 0, fetch: expected.fetch });
  expect(result.plan?.statements[0].sources[0]).toMatchObject({
    app: 100,
    alias: "APP100",
    role: "main",
    ...expected,
  });
  expectTextAndPlanAgree(result);
});

test("B114 structured plan: JOIN keeps one source per alias", async () => {
  const result = await explainQuery(
    "SELECT a.顧客ID, b.確度 FROM APP100 a INNER JOIN APP200 b " +
      "ON a.顧客ID = b.顧客ID WHERE a.顧客名 LIKE 'A%' AND b.確度 IN ('A')",
    { client: makeClient() }
  );
  expect(result.plan?.statements[0]).toMatchObject({
    fetch: "all",
    sources: [
      { app: 100, alias: "a", role: "main", fetch: "all", kintoneQuery: null },
      { app: 200, alias: "b", role: "join", fetch: "exact", pending: false },
    ],
  });
  expectTextAndPlanAgree(result);
});

test("B114 structured plan: UNION keeps one ordered source per branch", async () => {
  const result = await explainQuery(
    "SELECT COUNT(*) AS c FROM APP100 UNION ALL " +
      "SELECT COUNT(顧客名) AS c FROM APP200 WHERE 顧客名 LIKE 'A%'",
    { client: makeClient() }
  );
  expect(result.plan?.statements[0]).toMatchObject({
    fetch: "all",
    sources: [
      { app: 100, role: "union", fetch: "count_only", limit: 1 },
      { app: 200, role: "union", fetch: "all", kintoneQuery: null },
    ],
  });
  expectTextAndPlanAgree(result);
});

test("B114 structured plan: CTE sources are retained and temporary-table references are omitted", async () => {
  const cte = await explainQuery(
    "WITH x AS (SELECT 顧客名 FROM APP100 WHERE 顧客名 = 'A' LIMIT 5) " +
      "SELECT 顧客名 FROM x",
    { client: makeClient() }
  );
  expect(cte.plan?.statements[0].sources).toEqual(expect.arrayContaining([
    expect.objectContaining({ app: 100, role: "cte", fetch: "exact", limit: 5 }),
  ]));
  expectTextAndPlanAgree(cte);

  const batch = await explainQuery(
    "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP100; SELECT 顧客名 FROM #t",
    { client: makeClient() }
  );
  expect(batch.plan?.statements).toHaveLength(2);
  expect(batch.plan?.statements[0]).toMatchObject({
    index: 0,
    fetch: "all",
    sources: [expect.objectContaining({ app: 100, role: "main", fetch: "all" })],
  });
  expect(batch.plan?.statements[1]).toEqual({
    index: 1,
    fetch: "none",
    sources: [],
  });
  expectTextAndPlanAgree(batch);
});

test("B114 structured plan: NONE < COUNT_ONLY and both coexist in one batch", async () => {
  const result = await explainQuery(
    "CREATE TEMP TABLE #t AS SELECT COUNT(*) AS 件数 FROM APP100; SELECT 件数 FROM #t",
    { client: makeClient() }
  );
  expect(result.plan?.statements).toEqual([
    {
      index: 0,
      fetch: "count_only",
      sources: [expect.objectContaining({
        app: 100,
        role: "main",
        fetch: "count_only",
        limit: 1,
      })],
    },
    { index: 1, fetch: "none", sources: [] },
  ]);
  expect(result.lines.some((line) => line.trim() === "fetch summary: COUNT_ONLY")).toBe(true);
  expectTextAndPlanAgree(result);
});

test("B114 structured plan: scalar subquery physical sources use the subquery role", async () => {
  const result = await explainQuery(
    "SELECT 顧客名, (SELECT COUNT(*) FROM APP200) AS 件数 FROM APP100",
    { client: makeClient() }
  );
  expect(result.plan?.statements[0].sources).toEqual(expect.arrayContaining([
    expect.objectContaining({ app: 100, role: "main" }),
    expect.objectContaining({ app: 200, role: "subquery", fetch: "all", limit: null }),
  ]));
  expectTextAndPlanAgree(result);
});

test("B114 structured plan: batch planner returns one entry for every statement", async () => {
  const result = await explainQuery(
    "SELECT COUNT(*) FROM APP100; SELECT 顧客名 FROM APP200 WHERE 顧客名 LIKE 'A%'",
    { client: makeClient() }
  );
  expect(result.plan?.statements.map(({ index, fetch }) => ({ index, fetch }))).toEqual([
    { index: 0, fetch: "count_only" },
    { index: 1, fetch: "all" },
  ]);
  expectTextAndPlanAgree(result);
});
