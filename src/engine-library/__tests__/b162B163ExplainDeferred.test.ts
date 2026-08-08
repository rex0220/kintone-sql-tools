import { explainQuery, type ReadonlyKintoneClient } from "../index";

function client(): { client: ReadonlyKintoneClient; records: jest.Mock } {
  const records = jest.fn(async () => ({ records: [] }));
  return {
    records,
    client: {
      getRecords: records,
      async openCursor() {
        throw new Error("cursor API must not be called by EXPLAIN");
      },
      async getApps() { return []; },
      async getFields() { return []; },
      async getProcessStatuses() { return { enable: false, states: [] }; },
      async getNumberPrecision() {
        return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const };
      },
    },
  };
}

test("B162/B163 engine library batch EXPLAIN は共有計画を構造化結果で返し records API 0", async () => {
  const tracked = client();
  const result = await explainQuery(
    "DECLARE @a='2025-08-01'; DECLARE @b='2026-08-01'; " +
      "WITH s AS (GENERATE_SERIES(@a,@b,'1 month') AS 月) SELECT 月 FROM s; " +
      "CREATE TEMP TABLE #t AS SELECT 'x' AS 年月; " +
      "SELECT 年月,COUNT(*) AS n FROM #t GROUP BY 年月",
    { client: tracked.client }
  );
  expect(result.type).toBe("explain");
  expect(result.text).toContain("series type:   DATE (DECLARE default)");
  expect(result.text).toContain("schema source: SELECT output of statement 4");
  expect(result.text).toContain("group key 年月: PHYSICAL (source=0, field=年月)");
  expect(tracked.records).not.toHaveBeenCalled();
});
