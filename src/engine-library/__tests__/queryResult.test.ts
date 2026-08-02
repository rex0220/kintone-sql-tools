import {
  execute,
  type ExecuteMetrics,
  type SelectResult,
} from "../../execute";
import {
  explainQuery,
  KsqlEngineError,
  runQuery,
  type ReadonlyKintoneClient,
} from "../index";

jest.mock("../../execute", () => {
  const actual = jest.requireActual("../../execute");
  return { ...actual, execute: jest.fn() };
});

const mockedExecute = execute as jest.MockedFunction<typeof execute>;

function makeClient(): ReadonlyKintoneClient {
  return {
    getRecords: async () => ({ records: [] }),
    openCursor: async () => ({
      totalCount: 0,
      nextPage: async () => ({ records: [], next: false }),
      close: async () => undefined,
    }),
    getApps: async () => [],
    getFields: async () => [],
    getNumberPrecision: async () => ({
      digits: 30,
      decimalPlaces: 10,
      roundingMode: "HALF_EVEN",
    }),
    getProcessStatuses: async () => ({ enable: false, states: [] }),
  };
}

function metrics(overrides: Partial<ExecuteMetrics> = {}): ExecuteMetrics {
  return {
    getCalls: 3,
    postCalls: 8,
    putCalls: 9,
    deleteCalls: 10,
    fieldCalls: 2,
    numberPrecisionCalls: 1,
    appsCalls: 0,
    processStatusCalls: 0,
    cursorCreateCalls: 1,
    cursorGetCalls: 2,
    cursorDeleteCalls: 1,
    cursorRecordsScanned: 777,
    cursorActiveCurrent: 0,
    cursorActivePeak: 1,
    cursorCleanupFailures: 0,
    cursorCreateOutcomeUnknown: 0,
    cursorQuarantinedCurrent: 0,
    fetchedRows: 123,
    limitReached: false,
    limitReachedApps: [],
    elapsedMs: 45,
    ...overrides,
  };
}

beforeEach(() => {
  mockedExecute.mockReset();
});

test("runQuery copies VALIDATE stats into the stable query envelope when present", async () => {
  const internal = {
    type: "SELECT",
    rows: [{ b: 2, a: "x" }],
    columns: ["b", "a"],
    rowCount: 1,
    warnings: ["truncated"],
    validateStats: {
      errorRecords: 5,
      errorCount: 6,
      constraintMetadata: {
        present: ["choice"],
        absent: ["required", "length", "range"],
      },
    },
    metrics: metrics(),
  } as unknown as SelectResult;
  mockedExecute.mockResolvedValue(internal);

  const result = await runQuery("VALIDATE APP1", {
    client: makeClient(),
    maxRecords: 100,
    onLimitReached: "truncate",
    fetchParallel: 2,
    cursorMaxActive: 4,
  });

  expect(result).toEqual({
    type: "query",
    rows: [{ b: "2", a: "x" }],
    columns: [
      { name: "b", displayName: "b", valueType: "string" },
      { name: "a", displayName: "a", valueType: "string" },
    ],
    rowCount: 1,
    warnings: ["truncated"],
    validateStats: {
      errorRecords: 5,
      errorCount: 6,
      constraintMetadata: {
        present: ["choice"],
        absent: ["required", "length", "range"],
      },
    },
    metrics: {
      recordGetCalls: 3,
      fetchedRows: 123,
      elapsedMs: 45,
      cursorRecordsScanned: 777,
      limitReached: false,
      limitReachedApps: [],
    },
  });
  expect(result.metrics).not.toHaveProperty("getCalls");
  expect(mockedExecute).toHaveBeenCalledWith(
    "VALIDATE APP1",
    expect.any(Object),
    {
      captureColumnMeta: true,
      maxRecords: 100,
      onLimitReached: "error",
      fetchParallel: 2,
      cursorMaxActive: 4,
    }
  );
});

test("runQuery preserves columns and supplies fixed metrics for zero rows", async () => {
  mockedExecute.mockResolvedValue({
    type: "SELECT",
    rows: [],
    columns: ["empty_value"],
    rowCount: 0,
  });

  const result = await runQuery("SELECT empty_value FROM APP1", {
    client: makeClient(),
  });

  expect(result.rows).toEqual([]);
  expect(result.columns).toEqual([{ name: "empty_value", displayName: "empty_value", valueType: "string" }]);
  expect(result).not.toHaveProperty("validateStats");
  expect(result.metrics).toEqual({
    recordGetCalls: 0,
    fetchedRows: 0,
    elapsedMs: 0,
    cursorRecordsScanned: 0,
    limitReached: false,
    limitReachedApps: [],
  });
});

test.each([
  ["maxRecords", 0],
  ["maxRecords", Number.MAX_SAFE_INTEGER + 1],
  ["fetchParallel", -1],
  ["fetchParallel", 1.5],
  ["cursorMaxActive", 0],
  ["cursorMaxActive", 6],
] as const)("runQuery rejects invalid %s before execution", async (key, value) => {
  await expect(runQuery("SELECT 1", {
    client: makeClient(),
    [key]: value,
  })).rejects.toMatchObject({ code: "EXECUTION_ERROR" });
  expect(mockedExecute).not.toHaveBeenCalled();
});

test("unknown options and explain-only onLimitReached are rejected before execution", async () => {
  await expect(runQuery("SELECT 1", {
    client: makeClient(),
    surprise: true,
  } as never)).rejects.toBeInstanceOf(KsqlEngineError);

  await expect(explainQuery("SELECT 1", {
    client: makeClient(),
    onLimitReached: "truncate",
  } as never)).rejects.toMatchObject({ code: "EXECUTION_ERROR" });

  expect(mockedExecute).not.toHaveBeenCalled();
});

test("minimal Step 2 top-level gate rejects writes before execution", async () => {
  await expect(runQuery("UPDATE APP1 SET 名前 = 'x' WHERE $id = 1", {
    client: makeClient(),
  })).rejects.toMatchObject({ code: "READ_ONLY_VIOLATION" });
  await expect(explainQuery("EXPLAIN DELETE FROM APP1 WHERE $id = 1", {
    client: makeClient(),
  })).rejects.toMatchObject({ code: "READ_ONLY_VIOLATION" });
  expect(mockedExecute).not.toHaveBeenCalled();
});

test("minimal Step 2 top-level gate accepts parser-supported leading comments", async () => {
  mockedExecute.mockResolvedValue({
    type: "SELECT",
    rows: [],
    columns: ["one"],
    rowCount: 0,
  });

  await runQuery("/* dashboard */ SELECT 1 AS one", { client: makeClient() });
  await explainQuery("/* dashboard */ EXPLAIN SELECT 1 AS one", {
    client: makeClient(),
  });

  expect(mockedExecute.mock.calls[0][0]).toBe("/* dashboard */ SELECT 1 AS one");
  expect(mockedExecute.mock.calls[1][0]).toBe("/* dashboard */ EXPLAIN SELECT 1 AS one");
});

test("explainQuery normalizes one EXPLAIN and maps plan rows to lines and text", async () => {
  mockedExecute.mockResolvedValue({
    type: "SELECT",
    rows: [{ plan: "statement: SELECT" }, { plan: "records API: 0" }],
    columns: ["plan"],
    rowCount: 2,
    metrics: metrics({
      getCalls: 0,
      fetchedRows: 0,
      cursorRecordsScanned: 0,
    }),
  });

  const result = await explainQuery(" EXPLAIN SELECT value FROM APP1", {
    client: makeClient(),
    cursorMaxActive: 2,
  });

  expect(result).toEqual({
    type: "explain",
    lines: ["statement: SELECT", "records API: 0"],
    text: "statement: SELECT\nrecords API: 0",
    metrics: {
      recordGetCalls: 0,
      fetchedRows: 0,
      elapsedMs: 45,
      cursorRecordsScanned: 0,
      limitReached: false,
      limitReachedApps: [],
    },
  });
  expect(mockedExecute.mock.calls[0][0]).toBe("EXPLAIN SELECT value FROM APP1");
  expect(mockedExecute.mock.calls[0][2]).not.toHaveProperty("onLimitReached");
});
