import { execute } from "../../execute";
import { FetchAllLimitError } from "../../api/fetchAll";
import { explainQuery, runQuery, type ReadonlyKintoneClient } from "../index";

jest.mock("../../execute", () => {
  const actual = jest.requireActual("../../execute");
  return { ...actual, execute: jest.fn() };
});

const mockedExecute = execute as jest.MockedFunction<typeof execute>;

function makeClient(overrides: Partial<ReadonlyKintoneClient> = {}): ReadonlyKintoneClient {
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
    ...overrides,
  };
}

beforeEach(() => mockedExecute.mockReset());

test("malformed and parseable non-read SQL have distinct codes", async () => {
  const client = makeClient();
  await expect(runQuery("SELECT FROM", { client })).rejects.toMatchObject({
    code: "PARSE_ERROR",
  });
  await expect(runQuery("DELETE FROM APP1 WHERE $id = 1", { client }))
    .rejects.toMatchObject({ code: "READ_ONLY_VIOLATION" });
  expect(mockedExecute).not.toHaveBeenCalled();
});

test.each([
  ["simple", "SELECT code FROM APP1"],
  ["JOIN", "SELECT a.code FROM APP1 a JOIN APP2 b ON a.code = b.code"],
  ["GROUP BY", "SELECT code, COUNT(*) FROM APP1 GROUP BY code"],
] as const)("search aborted %s is SEARCH_ABORTED with no result rows", async (_shape, sql) => {
  const materialized: Record<string, string>[] = [];
  mockedExecute.mockImplementation(async (_sql, client) => {
    await client.getRecords({ app: 1, query: "", fields: ["code"] });
    materialized.push({ code: "must-not-escape" });
    return { type: "SELECT", rows: materialized, columns: ["code"], rowCount: materialized.length };
  });
  const client = makeClient({
    getRecords: async () => ({
      records: [{ code: { value: "must-not-escape" } }],
      searchAborted: true,
    }),
  });
  let error: unknown;
  try {
    await runQuery(sql, { client });
  } catch (caught) {
    error = caught;
  }
  expect(error).toMatchObject({ code: "SEARCH_ABORTED" });
  expect(materialized).toHaveLength(0);
});

test("maxRecords maps to FETCH_LIMIT_EXCEEDED and truncate simple returns warning", async () => {
  const client = makeClient();
  const limit = new FetchAllLimitError("maxRecords exceeded");
  mockedExecute.mockRejectedValueOnce(limit);
  await expect(runQuery("SELECT code FROM APP1", { client, maxRecords: 1 }))
    .rejects.toMatchObject({ code: "FETCH_LIMIT_EXCEEDED", cause: limit });

  mockedExecute.mockResolvedValueOnce({
    type: "SELECT",
    rows: [{ code: "A" }],
    columns: ["code"],
    rowCount: 1,
    warnings: ["Result truncated at maxRecords=1"],
  });
  await expect(runQuery("SELECT code FROM APP1", {
    client,
    maxRecords: 1,
    onLimitReached: "truncate",
  })).resolves.toMatchObject({
    rowCount: 1,
    warnings: ["Result truncated at maxRecords=1"],
  });
});

test.each([
  "SELECT a.code FROM APP1 a JOIN APP2 b ON a.code = b.code",
  "SELECT code, COUNT(*) FROM APP1 GROUP BY code",
] as const)("complete-input plan remains fail-closed under truncate: %s", async (sql) => {
  const cause = new FetchAllLimitError("complete input required");
  mockedExecute.mockRejectedValueOnce(cause);
  await expect(runQuery(sql, {
    client: makeClient(),
    maxRecords: 1,
    onLimitReached: "truncate",
  })).rejects.toMatchObject({ code: "FETCH_LIMIT_EXCEEDED", cause });
});

test("client and executor errors retain classification and cause", async () => {
  const transport = Object.assign(new Error("transport failed"), {
    code: "GAIA_TM01",
    status: 503,
  });
  mockedExecute.mockImplementationOnce(async (_sql, client) => {
    await client.getRecords({ app: 1, query: "", fields: [] });
    throw new Error("unreachable");
  });
  await expect(runQuery("SELECT code FROM APP1", {
    client: makeClient({ getRecords: async () => { throw transport; } }),
  })).rejects.toMatchObject({ code: "CLIENT_ERROR", cause: transport });

  const planner = new Error("unknown planner failure");
  mockedExecute.mockRejectedValueOnce(planner);
  await expect(runQuery("SELECT code FROM APP1", { client: makeClient() }))
    .rejects.toMatchObject({ code: "EXECUTION_ERROR", cause: planner });
});

test.each([
  ["unknown key", { surprise: true }],
  ["maxRecords non-integer", { maxRecords: 1.5 }],
  ["maxRecords out of range", { maxRecords: 0 }],
  ["fetchParallel non-integer", { fetchParallel: 1.5 }],
  ["cursorMaxActive out of range", { cursorMaxActive: 6 }],
] as const)("invalid option (%s) is rejected before execution", async (_label, extra) => {
  await expect(runQuery("SELECT 1", {
    client: makeClient(),
    ...extra,
  } as never)).rejects.toMatchObject({ code: "EXECUTION_ERROR" });
  expect(mockedExecute).not.toHaveBeenCalled();
});

test("explain rejects run-only option before execution", async () => {
  await expect(explainQuery("SELECT 1", {
    client: makeClient(),
    onLimitReached: "truncate",
  } as never)).rejects.toMatchObject({ code: "EXECUTION_ERROR" });
  expect(mockedExecute).not.toHaveBeenCalled();
});
