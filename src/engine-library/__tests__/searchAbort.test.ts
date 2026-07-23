import {
  execute,
  SearchAbortedError,
} from "../../execute";
import { createReadonlyKintoneClient } from "../browserClient";
import { KsqlEngineError } from "../errors";
import { runQuery } from "../query";
import type { ReadonlyKintoneClient } from "../publicTypes";

jest.mock("../../execute", () => {
  const actual = jest.requireActual("../../execute");
  return { ...actual, execute: jest.fn() };
});

const mockedExecute = execute as jest.MockedFunction<typeof execute>;

type MockApi = jest.Mock & {
  url: jest.Mock<string, [string, boolean]>;
  urlForGet: jest.Mock<string, [string, object, boolean]>;
};

const root = globalThis as unknown as {
  kintone?: {
    api: MockApi;
    getRequestToken: jest.Mock<string, []>;
  };
};
const originalKintone = root.kintone;
const originalFetch = globalThis.fetch;

const queryMatrix = [
  ["simple SELECT", "SELECT code FROM APP1"],
  [
    "JOIN",
    "SELECT a.code FROM APP1 AS a INNER JOIN APP2 AS b ON a.code = b.code",
  ],
  ["GROUP BY", "SELECT code, COUNT(*) AS count FROM APP1 GROUP BY code"],
  [
    "WITH",
    "WITH source AS (SELECT code FROM APP1) SELECT code FROM source",
  ],
  ["UNION", "SELECT code FROM APP1 UNION ALL SELECT code FROM APP2"],
  [
    "subquery",
    "SELECT code FROM APP1 WHERE code IN (SELECT code FROM APP2)",
  ],
  ["KLIKE", "SELECT code FROM APP1 WHERE code KLIKE 'partial'"],
] as const;

function installBrowserClient(): ReadonlyKintoneClient {
  const api = jest.fn(async () => ({})) as MockApi;
  api.url = jest.fn(
    (path: string, _guest: boolean) => `https://example.cybozu.com${path}`
  );
  api.urlForGet = jest.fn(
    (path: string, _params: object, _guest: boolean) =>
      `https://example.cybozu.com${path}?generated=1`
  );
  root.kintone = {
    api,
    getRequestToken: jest.fn(() => "csrf-token"),
  };
  globalThis.fetch = jest.fn(async () =>
    new Response(
      JSON.stringify({
        records: [{ code: { value: "partial" } }],
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Cybozu-Warning":
            "Filter aborted because of too many search results",
        },
      }
    )
  );
  return createReadonlyKintoneClient();
}

function makeByoClient(
  getRecords: ReadonlyKintoneClient["getRecords"] = async () => ({
    records: [{ code: { value: "partial" } }],
    searchAborted: true,
  })
): ReadonlyKintoneClient {
  return {
    getRecords,
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
    getProcessStatuses: async () => ({ enable: false, states: null }),
  };
}

beforeEach(() => {
  mockedExecute.mockReset();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKintone) root.kintone = originalKintone;
  else delete root.kintone;
});

describe.each([
  ["browser", installBrowserClient],
  ["BYO", makeByoClient],
] as const)("%s readonly client", (_surface, makeClient) => {
  test.each(queryMatrix)(
    "%s search abort is SEARCH_ABORTED before partial rows materialize",
    async (_shape, sql) => {
      const materializedRows: unknown[] = [];
      mockedExecute.mockImplementation(async (_sql, client) => {
        const page = await client.getRecords({
          app: 1,
          query: "",
          fields: ["code"],
        });
        materializedRows.push(...page.records);
        return {
          type: "SELECT",
          rows: page.records.map((record) => ({
            code: String(record.code.value),
          })),
          columns: ["code"],
          rowCount: page.records.length,
          warnings: ["search aborted"],
        };
      });

      const rejection = runQuery(sql, { client: makeClient() });
      await expect(rejection).rejects.toMatchObject({
        name: "KsqlEngineError",
        code: "SEARCH_ABORTED",
        cause: expect.any(SearchAbortedError),
      });
      await expect(rejection).rejects.toBeInstanceOf(KsqlEngineError);
      expect(materializedRows).toHaveLength(0);
    }
  );
});

test("getRecords transport error remains CLIENT_ERROR", async () => {
  const transportError = Object.assign(new Error("records request failed"), {
    code: "GAIA_TM01",
    status: 503,
  });
  mockedExecute.mockImplementation(async (_sql, client) => {
    await client.getRecords({ app: 1, query: "", fields: ["code"] });
    throw new Error("unreachable");
  });

  await expect(
    runQuery("SELECT code FROM APP1", {
      client: makeByoClient(async () => {
        throw transportError;
      }),
    })
  ).rejects.toMatchObject({
    code: "CLIENT_ERROR",
    cause: transportError,
  });
});

test("Cursor API error remains CLIENT_ERROR instead of SEARCH_ABORTED", async () => {
  const cursorError = Object.assign(new Error("cursor request failed"), {
    code: "GAIA_CO02",
    status: 400,
  });
  const client = makeByoClient(async () => ({ records: [] }));
  client.openCursor = async () => {
    throw cursorError;
  };
  mockedExecute.mockImplementation(async (_sql, projected) => {
    await projected.openCursor({
      app: 1,
      query: "order by $id",
      size: 500,
    });
    throw new Error("unreachable");
  });

  await expect(
    runQuery("SELECT code FROM APP1 KORDER BY code", { client })
  ).rejects.toMatchObject({
    code: "CLIENT_ERROR",
    cause: cursorError,
  });
});
