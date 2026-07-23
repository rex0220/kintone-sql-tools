import { createReadonlyKintoneClient } from "../browserClient";

type MockApi = jest.Mock & {
  url: jest.Mock<string, [string, boolean]>;
  urlForGet: jest.Mock<string, [string, object, boolean]>;
};

type MockKintone = {
  api: MockApi;
  getRequestToken: jest.Mock<string, []>;
};

const root = globalThis as unknown as { kintone?: MockKintone };
const originalKintone = root.kintone;
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKintone) root.kintone = originalKintone;
  else delete root.kintone;
  jest.restoreAllMocks();
});

function installKintone(
  implementation: (...args: unknown[]) => Promise<unknown> = async () => ({})
): MockKintone {
  const api = jest.fn(implementation) as MockApi;
  api.url = jest.fn(
    (path: string, _guest: boolean) => `https://example.cybozu.com${path}`
  );
  api.urlForGet = jest.fn(
    (path: string, _params: object, _guest: boolean) =>
      `https://example.cybozu.com${path}?generated=1`
  );
  const mocked = {
    api,
    getRequestToken: jest.fn(() => "csrf-token"),
  };
  root.kintone = mocked;
  return mocked;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

test("factory は6 readメソッドだけを持ち、現行routeで全readを実行する", async () => {
  const apiResponses = [
    { id: "cursor-1", totalCount: "1" },
    { records: [{ code: { value: "A" } }], next: false },
    { apps: [{ appId: "1", name: "App", description: "desc" }] },
    {
      properties: {
        code: { code: "code", label: "Code", type: "SINGLE_LINE_TEXT" },
      },
    },
    {
      numberPrecision: {
        digits: "16",
        decimalPlaces: "4",
        roundingMode: "DOWN",
      },
    },
    {
      enable: true,
      states: { open: { name: "Open", index: "2" } },
    },
  ];
  const mocked = installKintone(async () => apiResponses.shift());
  globalThis.fetch = jest.fn(async () =>
    jsonResponse({ records: [{ code: { value: "A" } }] })
  );
  const client = createReadonlyKintoneClient();

  await expect(
    client.getRecords({ app: 1, query: "", fields: ["code"] })
  ).resolves.toEqual({ records: [{ code: { value: "A" } }] });
  const cursor = await client.openCursor({
    app: 1,
    query: "order by $id asc",
    size: 500,
  });
  await expect(cursor.nextPage()).resolves.toEqual({
    records: [{ code: { value: "A" } }],
    next: false,
  });
  await expect(cursor.close()).resolves.toBeUndefined();
  await expect(client.getApps()).resolves.toEqual([
    { appId: 1, name: "App", description: "desc" },
  ]);
  await expect(client.getFields(1)).resolves.toEqual([
    expect.objectContaining({
      code: "code",
      label: "Code",
      fieldType: "SINGLE_LINE_TEXT",
    }),
  ]);
  await expect(client.getNumberPrecision(1)).resolves.toEqual({
    digits: 16,
    decimalPlaces: 4,
    roundingMode: "DOWN",
  });
  await expect(client.getProcessStatuses(1)).resolves.toEqual({
    enable: true,
    states: [{ name: "Open", index: 2 }],
  });

  expect(Object.keys(client).sort()).toEqual([
    "getApps",
    "getFields",
    "getNumberPrecision",
    "getProcessStatuses",
    "getRecords",
    "openCursor",
  ]);
  for (const method of ["postRecords", "putRecords", "deleteRecords"]) {
    expect(method in client).toBe(false);
    expect((client as unknown as Record<string, unknown>)[method]).toBeUndefined();
  }
  expect(mocked.api.mock.calls.map((call) => call[1])).toEqual([
    "POST",
    "GET",
    "GET",
    "GET",
    "GET",
    "GET",
  ]);
  expect(mocked.api.mock.calls.map((call) => call[0])).toEqual([
    "https://example.cybozu.com/k/v1/records/cursor.json",
    "https://example.cybozu.com/k/v1/records/cursor.json",
    "https://example.cybozu.com/k/v1/apps.json",
    "https://example.cybozu.com/k/v1/app/form/fields.json",
    "https://example.cybozu.com/k/v1/app/settings.json",
    "https://example.cybozu.com/k/v1/app/status.json",
  ]);
});

test.each([
  [4096, "GET"],
  [4097, "POST"],
] as const)("records URL が %i UTF-8 bytes のとき %s", async (bytes, method) => {
  const mocked = installKintone();
  mocked.api.urlForGet.mockReturnValue("x".repeat(bytes));
  globalThis.fetch = jest.fn(async () => jsonResponse({ records: [] }));

  await createReadonlyKintoneClient().getRecords({
    app: 9,
    query: "条件".repeat(2200),
    fields: ["名前"],
  });

  const [url, init] = (globalThis.fetch as jest.Mock).mock.calls[0] as [
    string,
    RequestInit,
  ];
  expect(init.method).toBe(method);
  if (method === "GET") {
    expect(url).toBe("x".repeat(4096));
    expect(mocked.getRequestToken).not.toHaveBeenCalled();
  } else {
    expect(url).toBe("https://example.cybozu.com/k/v1/records.json");
    expect(init).toEqual({
      method: "POST",
      credentials: "include",
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        "X-HTTP-Method-Override": "GET",
        "Content-Type": "application/json",
        "X-Cybozu-Request-Token": "csrf-token",
      },
      body: JSON.stringify({
        app: 9,
        query: "条件".repeat(2200),
        fields: ["名前"],
      }),
    });
  }
});

test("X-Cybozu-Warning を searchAborted:true のまま返す", async () => {
  installKintone();
  globalThis.fetch = jest.fn(async () =>
    jsonResponse(
      { records: [] },
      {
        headers: {
          "X-Cybozu-Warning":
            "other; Filter aborted because of too many search results",
        },
      }
    )
  );

  await expect(
    createReadonlyKintoneClient().getRecords({
      app: 1,
      query: "",
      fields: [],
    })
  ).resolves.toEqual({ records: [], searchAborted: true });
});

test("factory instance ごとに lease とhandleを分離しcapacityをAPI前に拒否する", async () => {
  let cursorNumber = 0;
  const mocked = installKintone(async (_url, method) => {
    if (method === "POST") {
      cursorNumber += 1;
      return { id: `cursor-${cursorNumber}`, totalCount: "1" };
    }
    return {};
  });
  const first = createReadonlyKintoneClient({ cursorMaxActive: 1 });
  const second = createReadonlyKintoneClient({ cursorMaxActive: 1 });
  const firstHandle = await first.openCursor({
    app: 1,
    query: "order by $id",
    size: 500,
  });

  await expect(
    first.openCursor({ app: 1, query: "order by $id", size: 500 })
  ).rejects.toMatchObject({ name: "CursorCapacityError" });
  expect(mocked.api.mock.calls.filter((call) => call[1] === "POST")).toHaveLength(1);

  const secondHandle = await second.openCursor({
    app: 1,
    query: "order by $id",
    size: 500,
  });
  expect(mocked.api.mock.calls.filter((call) => call[1] === "POST")).toHaveLength(2);
  await firstHandle.close();
  await secondHandle.close();
  expect(mocked.api.mock.calls.filter((call) => call[1] === "DELETE")).toHaveLength(2);
});

test("engine load/factory はglobal listenerを登録せずkintone.apiを置換しない", () => {
  const mocked = installKintone();
  const apiIdentity = mocked.api;
  const addEventListener = jest.fn();
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { addEventListener },
  });
  try {
    jest.isolateModules(() => {
      const engine = require("../index") as typeof import("../index");
      engine.createReadonlyKintoneClient();
    });
    expect(addEventListener.mock.calls.filter(
      ([event]) => event === "pagehide" || event === "beforeunload"
    )).toHaveLength(0);
    expect(mocked.api).toBe(apiIdentity);
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, "window", previousWindow);
    } else {
      delete (globalThis as unknown as { window?: unknown }).window;
    }
  }
});
