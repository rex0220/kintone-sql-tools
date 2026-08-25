import {
  buildBatchExplainPlans,
  execute,
  type KintoneClient,
  type SelectResult,
} from "../execute";

function explainClient(options: { failFields?: Error } = {}) {
  const calls = {
    fields: [] as number[],
    records: jest.fn(async () => ({ records: [] })),
    cursor: jest.fn(async () => { throw new Error("cursor API must not be called"); }),
    post: jest.fn(async () => ({ ids: [] })),
    put: jest.fn(async () => undefined),
    upsert: jest.fn(async () => ({ records: [] })),
    delete: jest.fn(async () => undefined),
  };
  const client: KintoneClient = {
    getRecords: calls.records,
    openCursor: calls.cursor,
    postRecords: calls.post,
    putRecords: calls.put,
    upsertRecords: calls.upsert,
    deleteRecords: calls.delete,
    async getApps() { return []; },
    async getFields(appId) {
      calls.fields.push(appId);
      if (options.failFields) throw options.failFields;
      return [
        { code: "key", label: "key", fieldType: "SINGLE_LINE_TEXT", isUnique: true },
        { code: "value", label: "value", fieldType: "SINGLE_LINE_TEXT" },
      ];
    },
    async getNumberPrecision() { return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" }; },
    async getProcessStatuses() { return { enable: false, states: null }; },
  };
  return { client, calls };
}

function plan(result: SelectResult): string {
  return result.rows.map((row) => String(row.plan)).join("\n");
}

function expectNoExecutionApis(calls: ReturnType<typeof explainClient>["calls"]): void {
  expect(calls.records).not.toHaveBeenCalled();
  expect(calls.cursor).not.toHaveBeenCalled();
  expect(calls.post).not.toHaveBeenCalled();
  expect(calls.put).not.toHaveBeenCalled();
  expect(calls.upsert).not.toHaveBeenCalled();
  expect(calls.delete).not.toHaveBeenCalled();
}

test("B176: 単独 UPSERT EXPLAIN は target form を 1 回取得して ELIGIBLE を表示する", async () => {
  const { client, calls } = explainClient();
  const result = await execute(
    "EXPLAIN UPSERT INTO APP1 (key,value) VALUES ('K1','V1') ON DUPLICATE (key)",
    client,
    { cacheContext: "b176-single" }
  ) as SelectResult;
  expect(plan(result)).toContain("native UPSERT statement/data eligibility: ELIGIBLE");
  expect(calls.fields).toEqual([1]);
  expect(result.metrics?.fieldCalls).toBe(1);
  expectNoExecutionApis(calls);
});

test("B176: resolveMetadata=false は form API 0 回で条件 3 を UNKNOWN に保つ", async () => {
  const { client, calls } = explainClient();
  const result = await execute(
    "EXPLAIN UPSERT INTO APP1 (key) VALUES ('K1') ON DUPLICATE (key)",
    client,
    { cacheContext: "b176-offline", resolveMetadata: false }
  ) as SelectResult;
  expect(plan(result)).toContain("native UPSERT statement/data eligibility: UNKNOWN");
  expect(plan(result)).toContain("条件 3: KEY_SCHEMA — フォームメタデータ未取得");
  expect(calls.fields).toEqual([]);
  expect(result.metrics?.fieldCalls).toBe(0);
  expectNoExecutionApis(calls);
});

test("B176: 同一 app の複数 UPSERT は invocation cache で form API 1 回", async () => {
  const { client, calls } = explainClient();
  const result = await buildBatchExplainPlans(
    "UPSERT INTO APP1 (key) VALUES ('K1') ON DUPLICATE (key);" +
      "UPSERT INTO APP1 (key) VALUES ('K2') ON DUPLICATE (key)",
    client,
    undefined,
    "b176-same-app"
  );
  expect(result.statements.every((item) => item.plan.join("\n").includes("ELIGIBLE"))).toBe(true);
  expect(calls.fields).toEqual([1]);
  expectNoExecutionApis(calls);
});

test("B176: 異なる 2 app の UPSERT は target form を各 1 回取得する", async () => {
  const { client, calls } = explainClient();
  await buildBatchExplainPlans(
    "UPSERT INTO APP1 (key) VALUES ('K1') ON DUPLICATE (key);" +
      "UPSERT INTO APP2 (key) VALUES ('K2') ON DUPLICATE (key)",
    client,
    undefined,
    "b176-two-apps"
  );
  expect(calls.fields).toEqual([1, 2]);
  expectNoExecutionApis(calls);
});

test("B176: UPSERT SELECT は target schema だけを取得し source records は取得しない", async () => {
  const { client, calls } = explainClient();
  const result = await execute(
    "EXPLAIN UPSERT INTO APP1 (key,value) SELECT key,value FROM APP2 ON DUPLICATE (key)",
    client,
    { cacheContext: "b176-upsert-select" }
  ) as SelectResult;
  expect(plan(result)).toContain("native UPSERT statement/data eligibility: UNKNOWN");
  expect(plan(result)).not.toContain("条件 3: KEY_SCHEMA — フォームメタデータ未取得");
  expect(calls.fields).toEqual([1]);
  expectNoExecutionApis(calls);
});

test("B176: target metadata 取得失敗は UNKNOWN に降格せず伝播する", async () => {
  const { client, calls } = explainClient({ failFields: new Error("form metadata unavailable") });
  await expect(execute(
    "EXPLAIN UPSERT INTO APP1 (key) VALUES ('K1') ON DUPLICATE (key)",
    client,
    { cacheContext: "b176-metadata-error" }
  )).rejects.toThrow("form metadata unavailable");
  expect(calls.fields).toEqual([1]);
  expectNoExecutionApis(calls);
});
