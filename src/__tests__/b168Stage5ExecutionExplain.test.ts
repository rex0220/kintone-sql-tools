import {
  buildBatchExplainPlans,
  executeBatch,
  type KintoneClient,
} from "../execute";

function client(isUnique: boolean | undefined = true): KintoneClient & {
  recordCalls: jest.Mock;
  postCalls: jest.Mock;
} {
  const recordCalls = jest.fn(async () => ({ records: [] }));
  const postCalls = jest.fn(async (params: { records: unknown[] }) => ({
    ids: params.records.map((_record, index) => String(index + 1)),
  }));
  return {
    recordCalls,
    postCalls,
    getRecords: recordCalls,
    async openCursor() { throw new Error("unexpected cursor call"); },
    postRecords: postCalls,
    async putRecords() { /* unused */ },
    async deleteRecords() { /* unused */ },
    async getApps() { return []; },
    async getFields() {
      return [
        { code: "key", label: "key", fieldType: "SINGLE_LINE_TEXT", writable: true, isUnique },
        { code: "value", label: "value", fieldType: "SINGLE_LINE_TEXT", writable: true },
      ];
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() { return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const }; },
  };
}

test("dialect 1 prepare rejects non-unique UPSERT before records/write APIs", async () => {
  const mock = client(false);
  const result = await executeBatch(
    "-- @ksql dialect: 1\nUPSERT INTO APP1 (key,value) VALUES ('A','x') KEY (key)",
    mock,
    { cacheContext: "b168-stage5-nonunique" }
  );
  expect(result.statements[0]).toMatchObject({
    status: "error",
    error: { message: expect.stringContaining("重複禁止ではありません") },
  });
  expect(mock.recordCalls).not.toHaveBeenCalled();
  expect(mock.postCalls).not.toHaveBeenCalled();
});

test("dialect 0 UPSERT keeps the existing non-unique-key behavior", async () => {
  const mock = client(false);
  const result = await executeBatch(
    "UPSERT INTO APP1 (key,value) VALUES ('A','x') ON DUPLICATE (key)",
    mock,
    { cacheContext: "b168-stage5-dialect0" }
  );
  expect(result.statements[0]).toMatchObject({ status: "success" });
  expect(mock.recordCalls).toHaveBeenCalled();
  expect(mock.postCalls).toHaveBeenCalled();
});

test("dialect 1 batch EXPLAIN adds unknown-bound estimates for read and UPSERT", async () => {
  const explained = await buildBatchExplainPlans(
    "-- @ksql dialect: 1\n" +
      "CREATE TEMP TABLE source AS SELECT key,value FROM APP1;" +
      "UPSERT INTO APP2 (key,value) SELECT key,value FROM source KEY (key)",
    client(),
    undefined,
    "b168-stage5-explain",
    10_000,
    2,
    false,
    100,
    10_000,
    false
  );
  const read = explained.statements[0].plan.join("\n");
  const upsert = explained.statements[1].plan.join("\n");
  expect(read).toContain("read APP1: 不明（上限 maxRecords=10000 と仮定: 最大 20 回、500 件/回）");
  expect(upsert).toContain("UPSERT pre-read: 不明（上限 dmlMaxRows=100 と仮定: 最大 2 回、50 キー/回）");
  expect(upsert).toContain("write: 不明（上限 dmlMaxRows=100 と仮定: 最大 1 回、100 件/HTTP リクエスト）");
  expect(upsert).toContain("bulkRequest は未実装");
  expect(read).not.toMatch(/想定件数[=:]\s*\d/);
});

test("dialect 0 batch EXPLAIN adds no estimate line", async () => {
  const explained = await buildBatchExplainPlans(
    "SELECT key FROM APP1; UPSERT INTO APP2 (key) VALUES ('A') ON DUPLICATE (key)",
    client(),
    undefined,
    "b168-stage5-explain-dialect0",
    10_000,
    2,
    false,
    100,
    10_000,
    false
  );
  expect(explained.statements.flatMap((statement) => statement.plan).join("\n"))
    .not.toContain("estimated API consumption");
});
