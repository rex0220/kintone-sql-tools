import { execute } from "../../execute";
import { createReadonlyKintoneClient } from "../browserClient";
import { explainQuery, runQuery } from "../query";
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

afterEach(() => {
  mockedExecute.mockReset();
  globalThis.fetch = originalFetch;
  if (originalKintone) root.kintone = originalKintone;
  else delete root.kintone;
});

function installBrowserFixture(): void {
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
    new Response(JSON.stringify({
      records: [{ code: { value: "same" } }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
}

test("BYO guest routeをprojection/scope後も保持しbrowser fixtureと同じ結果", async () => {
  installBrowserFixture();
  const browser = createReadonlyKintoneClient();
  const routes: string[] = [];
  const byo: ReadonlyKintoneClient = {
    async getRecords() {
      routes.push("/k/guest/42/v1/records.json");
      return { records: [{ code: { value: "same" } }] };
    },
    async openCursor() {
      routes.push("/k/guest/42/v1/records/cursor.json");
      return {
        totalCount: 1,
        nextPage: async () => ({
          records: [{ code: { value: "same" } }],
          next: false,
        }),
        close: async () => {
          routes.push("/k/guest/42/v1/records/cursor.json#delete");
        },
      };
    },
    getApps: async () => [],
    getFields: async () => [],
    getNumberPrecision: async () => ({
      digits: 30,
      decimalPlaces: 10,
      roundingMode: "HALF_EVEN",
    }),
    getProcessStatuses: async () => ({ enable: false, states: null }),
  };

  mockedExecute.mockImplementation(async (_sql, client) => {
    const response = await client.getRecords({
      app: 1,
      query: "",
      fields: ["code"],
    });
    return {
      type: "SELECT",
      rows: [{ code: String(response.records[0].code.value) }],
      columns: ["code"],
      rowCount: 1,
    };
  });

  const browserResult = await runQuery("SELECT code FROM APP1", {
    client: browser,
  });
  const byoResult = await runQuery("SELECT code FROM APP1", { client: byo });
  expect(byoResult).toEqual(browserResult);
  expect(routes).toEqual(["/k/guest/42/v1/records.json"]);
});

test("BYO Cursor guest routeはquery scopeのfinally closeまで失われない", async () => {
  const routes: string[] = [];
  const byo: ReadonlyKintoneClient = {
    getRecords: async () => ({ records: [] }),
    async openCursor() {
      routes.push("/k/guest/42/v1/records/cursor.json#post");
      return {
        totalCount: 1,
        nextPage: async () => {
          routes.push("/k/guest/42/v1/records/cursor.json#get");
          return { records: [], next: true };
        },
        close: async () => {
          routes.push("/k/guest/42/v1/records/cursor.json#delete");
        },
      };
    },
    getApps: async () => [],
    getFields: async () => [],
    getNumberPrecision: async () => ({
      digits: 30,
      decimalPlaces: 10,
      roundingMode: "HALF_EVEN",
    }),
    getProcessStatuses: async () => ({ enable: false, states: null }),
  };
  mockedExecute.mockImplementation(async (_sql, client) => {
    const handle = await client.openCursor({
      app: 1,
      query: "order by $id",
      size: 500,
    });
    await handle.nextPage();
    return {
      type: "SELECT",
      rows: [],
      columns: ["code"],
      rowCount: 0,
    };
  });

  await runQuery("SELECT code FROM APP1 KORDER BY code", { client: byo });
  expect(routes).toEqual([
    "/k/guest/42/v1/records/cursor.json#post",
    "/k/guest/42/v1/records/cursor.json#get",
    "/k/guest/42/v1/records/cursor.json#delete",
  ]);
});

test("host合算超過相当のCursor API rejectはretryせずCLIENT_ERROR", async () => {
  const createReject = Object.assign(new Error("cursor host limit"), {
    code: "GAIA_CO02",
    status: 400,
  });
  let creates = 0;
  const byo: ReadonlyKintoneClient = {
    getRecords: async () => ({ records: [] }),
    async openCursor() {
      creates += 1;
      throw createReject;
    },
    getApps: async () => [],
    getFields: async () => [],
    getNumberPrecision: async () => ({
      digits: 30,
      decimalPlaces: 10,
      roundingMode: "HALF_EVEN",
    }),
    getProcessStatuses: async () => ({ enable: false, states: null }),
  };
  mockedExecute.mockImplementation(async (_sql, client) => {
    await client.openCursor({
      app: 1,
      query: "order by $id",
      size: 500,
    });
    throw new Error("unreachable");
  });

  await expect(
    runQuery("SELECT code FROM APP1 KORDER BY code", { client: byo })
  ).rejects.toMatchObject({
    code: "CLIENT_ERROR",
    cause: createReject,
  });
  expect(creates).toBe(1);
});

test("explainQueryも呼出し中に開いたhandleだけをfinally closeする", async () => {
  const close = jest.fn(async () => undefined);
  const byo: ReadonlyKintoneClient = {
    getRecords: async () => ({ records: [] }),
    openCursor: async () => ({
      totalCount: 1,
      nextPage: async () => ({ records: [], next: true }),
      close,
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
  mockedExecute.mockImplementation(async (_sql, client) => {
    await client.openCursor({
      app: 1,
      query: "order by $id",
      size: 500,
    });
    return {
      type: "SELECT",
      rows: [{ plan: "statement: SELECT" }],
      columns: ["plan"],
      rowCount: 1,
    };
  });

  await explainQuery("EXPLAIN SELECT code FROM APP1", { client: byo });
  expect(close).toHaveBeenCalledTimes(1);
});

test("query成功後のCursor close failureはCLIENT_ERRORになる", async () => {
  const closeError = Object.assign(new Error("delete failed"), {
    code: "GAIA_CO02",
  });
  const byo: ReadonlyKintoneClient = {
    getRecords: async () => ({ records: [] }),
    openCursor: async () => ({
      totalCount: 1,
      nextPage: async () => ({ records: [], next: true }),
      close: async () => {
        throw closeError;
      },
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
  mockedExecute.mockImplementation(async (_sql, client) => {
    await client.openCursor({
      app: 1,
      query: "order by $id",
      size: 500,
    });
    return {
      type: "SELECT",
      rows: [],
      columns: ["code"],
      rowCount: 0,
    };
  });

  await expect(
    runQuery("SELECT code FROM APP1 KORDER BY code", { client: byo })
  ).rejects.toMatchObject({
    code: "CLIENT_ERROR",
    cause: closeError,
  });
});
