import {
  createReadonlyKintoneClient,
  explainQuery,
  runQuery,
  type QueryResult,
  type ReadonlyKintoneClient,
  type ReadonlyKintoneRecord,
} from "../index";

type MockApi = jest.Mock & {
  url: jest.Mock<string, [string, boolean]>;
  urlForGet: jest.Mock<string, [string, Record<string, unknown>, boolean]>;
};

const root = globalThis as unknown as {
  kintone?: {
    api: MockApi;
    getRequestToken: () => string;
  };
};
const originalKintone = root.kintone;
const originalFetch = globalThis.fetch;

const field = (value: unknown) => ({ value });
const recordsByApp: Record<number, ReadonlyKintoneRecord[]> = {
  6601: [
    { $id: field("1"), key: field("K1"), kind: field("A") },
    { $id: field("2"), key: field("K2"), kind: field("A") },
    { $id: field("3"), key: field("K3"), kind: field("B") },
  ],
  6602: [
    { $id: field("11"), key: field("K1") },
    { $id: field("12"), key: field("K2") },
  ],
};

function fieldsFor(appId: number) {
  const codes = new Set(
    (recordsByApp[appId] ?? []).flatMap((record) => Object.keys(record))
  );
  return [...codes]
    .filter((code) => !code.startsWith("$"))
    .map((code) => ({
      code,
      label: code,
      fieldType: "SINGLE_LINE_TEXT",
    }));
}

function byoClient(overrides: Partial<ReadonlyKintoneClient> = {}): ReadonlyKintoneClient {
  return {
    async getRecords({ app }) {
      return { records: recordsByApp[app] ?? [] };
    },
    async openCursor() {
      let page = 0;
      return {
        totalCount: 501,
        async nextPage() {
          page += 1;
          const start = page === 1 ? 1 : 501;
          const count = page === 1 ? 500 : 1;
          return {
            records: Array.from({ length: count }, (_unused, index) => ({
              $id: field(String(start + index)),
            })),
            next: true,
          };
        },
        async close() {},
      };
    },
    async getApps() {
      return [{ appId: 6601, name: "B66 fixture", description: "acceptance" }];
    },
    async getFields(appId) {
      return fieldsFor(appId);
    },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" };
    },
    async getProcessStatuses() {
      return { enable: false, states: [] };
    },
    ...overrides,
  };
}

function installBrowserFactoryFixture(): {
  client: ReadonlyKintoneClient;
  calls: { records: number; cursor: number; fields: number };
} {
  const calls = { records: 0, cursor: 0, fields: 0 };
  let cursorPage = 0;
  const api = jest.fn(async (url: string, method: string) => {
    if (url.endsWith("/k/v1/records/cursor.json")) {
      calls.cursor += 1;
      if (method === "POST") return { id: "b66-cursor", totalCount: "501" };
      if (method === "GET") {
        cursorPage += 1;
        const start = cursorPage === 1 ? 1 : 501;
        const count = cursorPage === 1 ? 500 : 1;
        return {
          records: Array.from({ length: count }, (_unused, index) => ({
            $id: field(String(start + index)),
          })),
          next: true,
        };
      }
      return {};
    }
    if (url.endsWith("/k/v1/apps.json")) {
      return {
        apps: [{ appId: "6601", name: "B66 fixture", description: "acceptance" }],
      };
    }
    if (url.endsWith("/k/v1/app/form/fields.json")) {
      calls.fields += 1;
      const lastCall = api.mock.calls[api.mock.calls.length - 1];
      const appId = Number((lastCall?.[2] as { app?: number })?.app);
      return {
        properties: Object.fromEntries(
          fieldsFor(appId).map((item) => [
            item.code,
            { code: item.code, label: item.label, type: item.fieldType },
          ])
        ),
      };
    }
    if (url.endsWith("/k/v1/app/settings.json")) {
      return {
        numberPrecision: {
          digits: "30",
          decimalPlaces: "10",
          roundingMode: "HALF_EVEN",
        },
      };
    }
    if (url.endsWith("/k/v1/app/status.json")) {
      return { enable: false, states: null };
    }
    throw new Error(`unexpected browser fixture call: ${method} ${url}`);
  }) as MockApi;
  api.url = jest.fn(
    (path: string, _guest: boolean) => `https://example.cybozu.com${path}`
  );
  api.urlForGet = jest.fn(
    (path: string, params: Record<string, unknown>, _guest: boolean) =>
      `https://example.cybozu.com${path}?app=${String(params.app ?? "")}`
  );
  root.kintone = { api, getRequestToken: () => "b66-token" };
  globalThis.fetch = jest.fn(async (input) => {
    calls.records += 1;
    const appId = Number(new URL(String(input)).searchParams.get("app"));
    return new Response(JSON.stringify({ records: recordsByApp[appId] ?? [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { client: createReadonlyKintoneClient(), calls };
}

function expectStableResult(result: QueryResult): void {
  expect(result.type).toBe("query");
  expect(result.rowCount).toBe(result.rows.length);
  expect(result.columns.every((column) => column.valueType === "string")).toBe(true);
  expect(result.rows.every((row) =>
    Object.values(row).every((value) => typeof value === "string")
  )).toBe(true);
  expect(result.metrics).toEqual({
    recordGetCalls: expect.any(Number),
    fetchedRows: expect.any(Number),
    elapsedMs: expect.any(Number),
    cursorRecordsScanned: expect.any(Number),
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKintone) root.kintone = originalKintone;
  else delete root.kintone;
  jest.restoreAllMocks();
});

describe.each([
  ["BYO", () => byoClient()],
  ["browser factory", () => installBrowserFactoryFixture().client],
] as const)("%s positive acceptance", (_surface, makeClient) => {
  test.each([
    [
      "SELECT JOIN GROUP BY",
      "SELECT a.kind, COUNT(*) AS count FROM APP6601 a " +
        "INNER JOIN APP6602 b ON a.key = b.key GROUP BY a.kind",
    ],
    [
      "WITH",
      "WITH x AS (SELECT kind FROM APP6601) SELECT kind FROM x ORDER BY kind",
    ],
    [
      "UNION ALL",
      "SELECT 'left' AS side UNION ALL SELECT 'right' AS side",
    ],
    ["SHOW APPS", "SHOW APPS"],
    ["DESCRIBE", "DESCRIBE APP6601"],
  ])("%s returns the stable QueryResult contract", async (_label, sql) => {
    const result = await runQuery(sql, { client: makeClient(), maxRecords: 1000 });
    expectStableResult(result);
    expect(result.rowCount).toBeGreaterThan(0);
  });
});

test.each(["BYO", "browser factory"] as const)(
  "KORDER Cursor success closes the handle on %s",
  async (surface) => {
    const close = jest.fn(async () => undefined);
    const base = surface === "BYO"
      ? byoClient()
      : installBrowserFactoryFixture().client;
    const openCursor = base.openCursor.bind(base);
    const client: ReadonlyKintoneClient = {
      ...base,
      async openCursor(params) {
        const handle = await openCursor(params);
        return { ...handle, close };
      },
    };

    const result = await runQuery(
      "SELECT $id FROM APP6601 KORDER BY $id LIMIT 501",
      { client, maxRecords: 501 }
    );
    expect(result.rowCount).toBe(501);
    expect(result.metrics.cursorRecordsScanned).toBe(501);
    expect(close).toHaveBeenCalledTimes(1);
  }
);

test("KORDER Cursor error also closes the handle", async () => {
  const close = jest.fn(async () => undefined);
  const cause = Object.assign(new Error("cursor page failed"), {
    code: "GAIA_TM01",
    status: 503,
  });
  const client = byoClient({
    async openCursor() {
      return {
        totalCount: 501,
        async nextPage() {
          throw cause;
        },
        close,
      };
    },
  });

  await expect(runQuery(
    "SELECT $id FROM APP6601 KORDER BY $id LIMIT 501",
    { client, maxRecords: 501 }
  )).rejects.toMatchObject({ code: "CLIENT_ERROR", cause });
  expect(close).toHaveBeenCalledTimes(1);
});

test("BYO guest route survives projection", async () => {
  const routes: string[] = [];
  const client = byoClient({
    async getRecords({ app }) {
      routes.push(`/k/guest/66/v1/records.json?app=${app}`);
      return { records: recordsByApp[app] ?? [] };
    },
  });
  await runQuery("SELECT kind FROM APP6601", { client });
  expect(routes).toEqual([
    "/k/guest/66/v1/records.json?app=6601",
  ]);
});

test("VALIDATE returns validateStats and uses real optionOrder metadata shape", async () => {
  const getRecords = jest.fn(async () => ({
    records: [{ $id: field("1"), choice: field("invalid") }],
  }));
  const getFields = jest.fn(async () => [{
    code: "choice",
    label: "choice",
    fieldType: "DROP_DOWN",
    optionOrder: { valid: 0 },
  }]);
  const client = byoClient({ getRecords, getFields });

  const result = await runQuery("VALIDATE APP6701", { client });

  expect(result.validateStats).toEqual({
    errorRecords: 1,
    errorCount: 1,
    constraintMetadata: {
      present: ["choice"],
      absent: ["required", "length", "range"],
    },
  });
  expect(result.rowCount).toBe(1);
  expect(result.rows[0]).toMatchObject({
    $id: "1",
    $err_field: "choice",
    $err_code: "ERR_CHOICE_INVALID",
  });
  expect(getRecords).toHaveBeenCalled();
  expect(getFields).toHaveBeenCalledWith(6701);
});

test.each([
  [
    "constraint metadata is supplied",
    [{
      code: "name",
      label: "name",
      fieldType: "SINGLE_LINE_TEXT",
      required: true,
      minLength: "3",
    }],
    {
      errorRecords: 2,
      errorCount: 2,
      constraintMetadata: {
        present: ["required", "length"],
        absent: ["range", "choice"],
      },
    },
    ["ERR_REQUIRED", "ERR_LENGTH_MIN"],
  ],
  [
    "constraint metadata is omitted",
    [{
      code: "name",
      label: "name",
      fieldType: "SINGLE_LINE_TEXT",
    }],
    {
      errorRecords: 0,
      errorCount: 0,
      constraintMetadata: {
        present: [],
        absent: ["required", "length", "range", "choice"],
      },
    },
    [],
  ],
] as const)(
  "VALIDATE reflects whether BYO client %s",
  async (_label, fields, expectedStats, expectedCodes) => {
    const getRecords = jest.fn(async () => ({
      records: [
        { $id: field("1"), name: field("") },
        { $id: field("2"), name: field("ab") },
      ],
    }));
    const getFields = jest.fn(async () => fields);
    const client = byoClient({ getRecords, getFields });

    const result = await runQuery("VALIDATE APP6702", { client });

    expect(result.validateStats).toEqual(expectedStats);
    expect(result.rowCount).toBe(expectedCodes.length);
    expect(result.rows.map((row) => row.$err_code)).toEqual(expectedCodes);
    expect(result.warnings).toEqual([]);
    expect(getFields).toHaveBeenCalledWith(6702);
  }
);

test("EXPLAIN permits field metadata only and performs no records or Cursor calls", async () => {
  const getRecords = jest.fn(async () => ({ records: [] }));
  const openCursor = jest.fn(async () => {
    throw new Error("Cursor must not be opened by EXPLAIN");
  });
  const getFields = jest.fn(async (appId: number) => fieldsFor(appId));
  const client = byoClient({ getRecords, openCursor, getFields });

  const result = await explainQuery(
    "SELECT kind FROM APP6601 WHERE kind = 'A'",
    { client }
  );
  expect(result.type).toBe("explain");
  expect(result.lines.length).toBeGreaterThan(0);
  expect(getFields).toHaveBeenCalled();
  expect(getRecords).not.toHaveBeenCalled();
  expect(openCursor).not.toHaveBeenCalled();
  expect(result.metrics).toMatchObject({
    recordGetCalls: 0,
    fetchedRows: 0,
    cursorRecordsScanned: 0,
  });
});
