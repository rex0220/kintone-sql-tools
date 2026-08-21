import { executeBatch, type KintoneClient } from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";

function record(fields: Record<string, string>): KintoneRecord {
  return Object.fromEntries(Object.entries(fields).map(([code, value]) => [code, { value }]));
}

function client(): KintoneClient & {
  calls: Array<{ method: "GET" | "POST" | "PUT"; app: number; records?: unknown[] }>;
} {
  const calls: Array<{ method: "GET" | "POST" | "PUT"; app: number; records?: unknown[] }> = [];
  const recordsByApp: Record<number, KintoneRecord[]> = {
    100: [record({ k: "A", v: "new-a" }), record({ k: "B", v: "new-b" })],
    200: [record({ $id: "10", k: "A", v: "old-a" })],
  };
  return {
    calls,
    async getRecords(params) {
      calls.push({ method: "GET", app: params.app });
      return { records: recordsByApp[params.app] ?? [] };
    },
    async openCursor() { throw new Error("unexpected cursor call"); },
    async postRecords(params) {
      calls.push({ method: "POST", app: params.app, records: [...params.records] });
      return { ids: params.records.map((_record, index) => String(index + 20)) };
    },
    async putRecords(params) {
      calls.push({ method: "PUT", app: params.app, records: [...params.records] });
    },
    async deleteRecords() { /* not used */ },
    async getApps() { return []; },
    async getFields() {
      return [
        { code: "k", label: "k", fieldType: "SINGLE_LINE_TEXT", isUnique: true },
        { code: "v", label: "v", fieldType: "SINGLE_LINE_TEXT" },
      ];
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() { return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const }; },
  };
}

test("B168 MERGE batch executes through the unchanged UPSERT_SELECT GET -> POST/PUT path", async () => {
  const upsertClient = client();
  const mergeClient = client();
  const header = "-- @ksql dialect: 1\n";
  const upsert = await executeBatch(
    header + "UPSERT INTO APP200 (k,v) SELECT k,v FROM APP100 KEY (k)",
    upsertClient,
    { cacheContext: "b168-stage3-upsert" }
  );
  const merge = await executeBatch(
    header +
      "MERGE INTO APP200 AS t USING APP100 AS s ON t.k = s.k " +
      "WHEN MATCHED THEN UPDATE SET v=s.v " +
      "WHEN NOT MATCHED THEN INSERT (k,v) VALUES (s.k,s.v)",
    mergeClient,
    { cacheContext: "b168-stage3-merge" }
  );

  expect(merge.ok).toBe(true);
  expect(merge.statements[0]).toMatchObject({
    type: "UPSERT_SELECT",
    status: "success",
    result: { type: "UPSERT", insertedCount: 1, updatedCount: 1 },
  });
  expect(mergeClient.calls.map(({ method, app }) => ({ method, app })))
    .toEqual(upsertClient.calls.map(({ method, app }) => ({ method, app })));
  expect(mergeClient.calls).toEqual(upsertClient.calls);
  expect(mergeClient.calls.map((call) => call.method)).toEqual(["GET", "GET", "POST", "PUT"]);
});
