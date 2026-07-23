import * as publicApi from "../index";
import {
  explainQuery,
  KsqlEngineError,
  runQuery,
  version,
  type CreateReadonlyKintoneClientOptions,
  type ExplainResult,
  type QueryResult,
  type ReadonlyKintoneClient,
  type RunQueryOptions,
} from "../index";

function makeClient(overrides: Partial<ReadonlyKintoneClient> = {}): ReadonlyKintoneClient {
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
    ...overrides,
  };
}

test("runtime entry exposes only the implemented public values", () => {
  expect(Object.keys(publicApi).sort()).toEqual([
    "KsqlEngineError",
    "createReadonlyKintoneClient",
    "explainQuery",
    "runQuery",
    "version",
  ]);
  expect(runQuery).toBeInstanceOf(Function);
  expect(explainQuery).toBeInstanceOf(Function);
  expect(KsqlEngineError).toBeInstanceOf(Function);
});

test("version uses the immutable development fixture outside an engine build", () => {
  expect(version).toBe("0.0.0-dev");
  expect(typeof version).toBe("string");
});

test("public DTO signatures are usable without importing engine internals", () => {
  const client = makeClient();
  const runOptions: RunQueryOptions = {
    client,
    maxRecords: 10_000,
    onLimitReached: "error",
    fetchParallel: 2,
    cursorMaxActive: 2,
  };
  const browserOptions: CreateReadonlyKintoneClientOptions = { cursorMaxActive: 2 };
  const queryResult: QueryResult = {
    type: "query",
    rows: [{ value: "1" }],
    columns: [{ name: "value", valueType: "string" }],
    rowCount: 1,
    warnings: [],
    metrics: {
      recordGetCalls: 1,
      fetchedRows: 1,
      elapsedMs: 1,
      cursorRecordsScanned: 0,
    },
  };
  const explainResult: ExplainResult = {
    type: "explain",
    lines: ["statement: SELECT"],
    text: "statement: SELECT",
    metrics: {
      recordGetCalls: 0,
      fetchedRows: 0,
      elapsedMs: 1,
      cursorRecordsScanned: 0,
    },
  };

  expect(runOptions.client).toBe(client);
  expect(browserOptions.cursorMaxActive).toBe(2);
  expect(queryResult.type).toBe("query");
  expect(explainResult.type).toBe("explain");
});

test("explainQuery accepts either spelling and performs no Records GET or Cursor call", async () => {
  const getRecords = jest.fn(async () => ({ records: [] }));
  const openCursor = jest.fn(async () => {
    throw new Error("unexpected Cursor call");
  });
  const client = makeClient({ getRecords, openCursor });

  const plain = await explainQuery("SELECT 1 AS one", { client });
  const prefixed = await explainQuery("  EXPLAIN SELECT 1 AS one", { client });

  expect(plain.type).toBe("explain");
  expect(plain.lines.length).toBeGreaterThan(0);
  expect(plain.text).toBe(plain.lines.join("\n"));
  expect(prefixed.lines).toEqual(plain.lines);
  expect(plain.metrics.recordGetCalls).toBe(0);
  expect(plain.metrics.cursorRecordsScanned).toBe(0);
  expect(getRecords).not.toHaveBeenCalled();
  expect(openCursor).not.toHaveBeenCalled();
});

test("a plain BYO transport failure is normalized as CLIENT_ERROR", async () => {
  const cause = new Error("BYO transport failed");
  const client = makeClient({
    getRecords: async () => {
      throw cause;
    },
  });

  await expect(runQuery("SELECT $id FROM APP1", { client })).rejects.toMatchObject({
    name: "KsqlEngineError",
    code: "CLIENT_ERROR",
    cause,
  });
});
