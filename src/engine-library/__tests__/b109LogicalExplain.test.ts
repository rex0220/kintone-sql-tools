import {
  explainQuery,
  runBatch,
  type ReadonlyKintoneClient,
} from "../index";

function createClient(): ReadonlyKintoneClient {
  return {
    getRecords: jest.fn(async () => ({ records: [] })),
    openCursor: jest.fn(async () => ({
      totalCount: 0,
      nextPage: async () => ({ records: [], next: false }),
      close: async () => undefined,
    })),
    getApps: jest.fn(async () => []),
    getFields: jest.fn(async () => []),
    getNumberPrecision: jest.fn(async () => ({
      digits: 30,
      decimalPlaces: 10,
      roundingMode: "HALF_EVEN" as const,
    })),
    getProcessStatuses: jest.fn(async () => ({ enable: false, states: [] })),
  };
}

describe("B109 engine-library logical app EXPLAIN diagnostics", () => {
  test("explainQuery shows the logical-to-physical mapping without browser profile or mapped ID", async () => {
    const result = await explainQuery("SELECT * FROM LAPP_案件管理", {
      client: createClient(),
      logicalApps: { 案件管理: 4149 },
    });

    expect(result.text).toContain("LAPP_案件管理 -> APP4149");
    expect(result.text).not.toContain("APP900000000");
    expect(result.text).not.toContain("@browser");
  });

  test("runBatch restores only EXPLAIN output and preserves an identical SELECT data value", async () => {
    const result = await runBatch(
      "EXPLAIN SELECT * FROM LAPP_案件管理; SELECT 'APP900000000' AS x",
      {
        client: createClient(),
        logicalApps: { 案件管理: 4149 },
      }
    );

    expect(JSON.stringify(result.results[0].rows)).toContain("LAPP_案件管理 -> APP4149");
    expect(JSON.stringify(result.results[0].rows)).not.toContain("APP900000000");
    expect(result.results[1].rows).toEqual([{ x: "APP900000000" }]);
  });

  test("SQL without LAPP_ keeps explainQuery output byte-for-byte unchanged", async () => {
    const sql = "SELECT * FROM APP4149";
    const baseline = await explainQuery(sql, { client: createClient() });
    const withUnusedLogicalApps = await explainQuery(sql, {
      client: createClient(),
      logicalApps: { 案件管理: 4149 },
    });

    expect(withUnusedLogicalApps.lines).toEqual(baseline.lines);
    expect(withUnusedLogicalApps.text).toBe(baseline.text);
    expect(withUnusedLogicalApps.metrics).toEqual({
      ...baseline.metrics,
      elapsedMs: withUnusedLogicalApps.metrics.elapsedMs,
    });
  });
});
