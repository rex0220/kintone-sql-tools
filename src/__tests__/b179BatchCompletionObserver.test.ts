import { executeBatch, withBatchCompletionObserver, type KintoneClient } from "../execute";

function client(): KintoneClient {
  return {
    async getRecords() { return { records: [] }; },
    async openCursor() { return { totalCount: 0, async nextPage() { return { records: [], next: false }; }, async close() {} }; },
    async postRecords() { return { ids: [] }; },
    async putRecords() {},
    async deleteRecords() {},
    async getApps() { return []; },
    async getFields() { return []; },
    async getNumberPrecision() { return { digits: 16, decimalPlaces: 4, roundingMode: "HALF_EVEN" }; },
    async getProcessStatuses() { return { enable: false, states: null }; },
  } as unknown as KintoneClient;
}

const sql = "CREATE TEMP TABLE #export AS SELECT 'A' AS code; SELECT * FROM #export";

test("the observer sees the final result and the temp tables before the batch returns", async () => {
  const seen: Array<{ ok: boolean; tables: string[] }> = [];
  const result = await executeBatch(sql, client(), withBatchCompletionObserver({}, ({ result: batch, tempTables }) => {
    seen.push({ ok: batch.ok, tables: [...tempTables.keys()] });
  }));
  expect(result.ok).toBe(true);
  expect(seen).toEqual([{ ok: true, tables: ["#export"] }]);
});

test("a throwing observer does not turn a completed batch into a rejection", async () => {
  const result = await executeBatch(sql, client(), withBatchCompletionObserver({}, () => {
    throw new Error("observer failure");
  }));
  expect(result.ok).toBe(true);
  expect(result.statements.map((statement) => statement.status)).toEqual(["success", "success"]);
});

test("the observer key is a private symbol, not a string property of the options", () => {
  const options = withBatchCompletionObserver({ maxRecords: 5 }, () => undefined);
  expect(Object.keys(options)).toEqual(["maxRecords"]);
  expect(Object.getOwnPropertySymbols(options)).toHaveLength(1);
});
