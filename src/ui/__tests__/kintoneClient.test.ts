import { createKintoneClient, isPluginAlreadyReleasedCursorError } from "../kintoneClient";
import { resetCursorLeaseManagers } from "../../api/cursorLeaseManager";
import { execute, SearchAbortedError, type SelectResult } from "../../execute";

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
  resetCursorLeaseManagers();
});

function installKintone(
  implementation: (...args: unknown[]) => Promise<unknown> = async () => ({})
): MockKintone {
  const api = jest.fn(implementation) as MockApi;
  api.url = jest.fn((path: string, _guest: boolean) => `https://example.cybozu.com${path}`);
  api.urlForGet = jest.fn((path: string, _params: object, _guest: boolean) =>
    `https://example.cybozu.com${path}?generated=1`
  );
  const mocked = { api, getRequestToken: jest.fn(() => "csrf-token") };
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

test("短い records GET は直列化を urlForGet に委譲して raw Fetch する", async () => {
  const mocked = installKintone();
  mocked.api.urlForGet.mockReturnValue("https://example.cybozu.com/k/v1/records.json?generated=1");
  globalThis.fetch = jest.fn(async () => jsonResponse({ records: [] }));

  const response = await createKintoneClient().getRecords({
    app: 1,
    query: 'name = "日本 語"',
    fields: ["name", "code"],
  });

  expect(response).toEqual({ records: [] });
  expect(mocked.api).not.toHaveBeenCalled();
  expect(mocked.api.urlForGet).toHaveBeenCalledWith(
    "/k/v1/records.json",
    { app: 1, query: 'name = "日本 語"', fields: ["name", "code"] },
    true
  );
  expect(mocked.api.url).not.toHaveBeenCalled();
  expect(globalThis.fetch).toHaveBeenCalledWith(
    "https://example.cybozu.com/k/v1/records.json?generated=1",
    {
      method: "GET",
      credentials: "include",
      headers: { "X-Requested-With": "XMLHttpRequest" },
    }
  );
});

test("空 fields は urlForGet の params から省く", async () => {
  const mocked = installKintone();
  globalThis.fetch = jest.fn(async () => jsonResponse({ records: [] }));

  await createKintoneClient().getRecords({ app: 7, query: "", fields: [] });

  expect(mocked.api.urlForGet).toHaveBeenCalledWith(
    "/k/v1/records.json",
    { app: 7, query: "" },
    true
  );
});

test.each([
  [4096, "GET"],
  [4097, "POST"],
])("生成 URL が %i UTF-8 bytes のとき %s を使う", async (urlBytes, method) => {
  const mocked = installKintone();
  mocked.api.urlForGet.mockReturnValue("x".repeat(urlBytes));
  globalThis.fetch = jest.fn(async () => jsonResponse({ records: [] }));

  await createKintoneClient().getRecords({
    app: 1,
    query: "x".repeat(5000),
    fields: ["code"],
  });

  const [url, init] = (globalThis.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
  expect(init.method).toBe(method);
  if (method === "GET") {
    expect(url).toBe("x".repeat(4096));
    expect(mocked.getRequestToken).not.toHaveBeenCalled();
  } else {
    expect(url).toBe("https://example.cybozu.com/k/v1/records.json");
    expect(mocked.api.url).toHaveBeenCalledWith("/k/v1/records.json", true);
    expect(mocked.getRequestToken).toHaveBeenCalledTimes(1);
  }
});

test("4KB 超は guest URL への POST override と JSON body を使う", async () => {
  const mocked = installKintone();
  mocked.api.urlForGet.mockReturnValue("あ".repeat(1400));
  globalThis.fetch = jest.fn(async () => jsonResponse({ records: [] }));
  const params = { app: 9, query: "条件".repeat(2200), fields: ["名前"] };

  await createKintoneClient().getRecords(params);

  expect(mocked.api).not.toHaveBeenCalled();
  expect(globalThis.fetch).toHaveBeenCalledWith(
    "https://example.cybozu.com/k/v1/records.json",
    {
      method: "POST",
      credentials: "include",
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        "X-HTTP-Method-Override": "GET",
        "Content-Type": "application/json",
        "X-Cybozu-Request-Token": "csrf-token",
      },
      body: JSON.stringify(params),
    }
  );
});

test.each([
  ["GET", "https://example.cybozu.com/short"],
  ["POST", "x".repeat(4097)],
])("%s 成功応答の既知 warning header だけを searchAborted にする", async (_method, generatedUrl) => {
  const mocked = installKintone();
  mocked.api.urlForGet.mockReturnValue(generatedUrl);
  globalThis.fetch = jest.fn(async () => jsonResponse(
    { records: [] },
    { headers: { "X-Cybozu-Warning": "other; Filter aborted because of too many search results" } }
  ));

  await expect(createKintoneClient().getRecords({ app: 1, query: "", fields: [] }))
    .resolves.toEqual({ records: [], searchAborted: true });
});

test.each([
  ["header なし", undefined],
  ["別 warning", "another warning"],
])("成功応答の%sでは searchAborted property を省く", async (_label, warning) => {
  installKintone();
  globalThis.fetch = jest.fn(async () => jsonResponse(
    { records: [] },
    warning ? { headers: { "X-Cybozu-Warning": warning } } : {}
  ));

  const response = await createKintoneClient().getRecords({ app: 1, query: "", fields: [] });
  expect(response).toEqual({ records: [] });
  expect(response).not.toHaveProperty("searchAborted");
});

test("400 JSON error は code/errors/status を既存詳細 Error 契約へ渡す", async () => {
  installKintone();
  const raw = {
    code: "CB_VA01",
    id: "request-id",
    message: "入力内容が正しくありません。",
    errors: { "records[0].name.value": { messages: ["必須です。"] } },
  };
  globalThis.fetch = jest.fn(async () => jsonResponse(raw, {
    status: 400,
    headers: { "X-Cybozu-Warning": "Filter aborted because of too many search results" },
  }));

  const promise = createKintoneClient().getRecords({ app: 1, query: "", fields: [] });
  await expect(promise).rejects.toMatchObject({
    name: "CB_VA01",
    code: "CB_VA01",
    status: 400,
    message: "入力内容が正しくありません。（CB_VA01）\nrecords[0].name.value: 必須です。",
  });
});

test.each([
  ["非 JSON", new Response("not-json", { status: 502 })],
  ["空 body", new Response(null, { status: 503 })],
])("%s の HTTP error は status/cause を持つ明示 Error にする", async (_label, response) => {
  installKintone();
  globalThis.fetch = jest.fn(async () => response);

  const promise = createKintoneClient().getRecords({ app: 1, query: "", fields: [] });
  await expect(promise).rejects.toMatchObject({ status: response.status });
  await expect(promise).rejects.toBeInstanceOf(Error);
  await expect(promise).rejects.toHaveProperty("cause");
});

test("Fetch reject は toDetailedApiError で明示 Error にして cause を保持する", async () => {
  installKintone();
  const rejection = { reason: "offline" };
  globalThis.fetch = jest.fn(async () => Promise.reject(rejection));

  const promise = createKintoneClient().getRecords({ app: 1, query: "", fields: [] });
  await expect(promise).rejects.toMatchObject({ cause: rejection });
  await expect(promise).rejects.toBeInstanceOf(Error);
});

test("plugin Cursor handleはCreate/Get/Deleteをkintone.apiで実行する", async () => {
  const responses = [
    { id: "secret-cursor", totalCount: "2" },
    { records: [{ $id: { value: "1" } }], next: true },
    {},
  ];
  const mocked = installKintone(async () => responses.shift());
  const handle = await createKintoneClient().openCursor({ app: 1, query: "order by $id asc", size: 500 });
  await handle.nextPage();
  await handle.close();
  expect(mocked.api.mock.calls.map((call) => call[1])).toEqual(["POST", "GET", "DELETE"]);
  expect(globalThis.fetch).toBe(originalFetch);
});

test("plugin の write/metadata API は kintone.api を使い続ける", async () => {
  const responses = [
    { ids: ["1"] },
    {},
    {},
    { apps: [] },
    { properties: {} },
  ];
  const mocked = installKintone(async () => responses.shift());
  const client = createKintoneClient();

  await client.postRecords({ app: 1, records: [{}] });
  await client.putRecords({ app: 1, records: [] });
  await client.deleteRecords({ app: 1, ids: [1] });
  await client.getApps();
  await client.getFields(1);

  expect(mocked.api.mock.calls.map((call) => call[1])).toEqual(["POST", "PUT", "DELETE", "GET", "GET"]);
  expect(globalThis.fetch).toBe(originalFetch);
});

test("plugin adapter の warning は execute の SELECT warning と DML fail-closed に届く", async () => {
  const mocked = installKintone(async (_url, method) => {
    if (method === "GET") {
      return {
        properties: {
          f: { code: "f", label: "f", type: "SINGLE_LINE_TEXT" },
          subject: { code: "subject", label: "subject", type: "SINGLE_LINE_TEXT" },
        },
      };
    }
    throw new Error(`unexpected mutation: ${String(method)}`);
  });
  globalThis.fetch = jest.fn(async () => jsonResponse(
    { records: [{ $id: { value: "1" }, f: { value: "x" }, subject: { value: "至急" } }] },
    { headers: { "X-Cybozu-Warning": "Filter aborted because of too many search results" } }
  ));
  const client = createKintoneClient();

  const selected = await execute(
    "SELECT subject FROM APP100 WHERE subject KLIKE '至急' LIMIT 1",
    client
  ) as SelectResult;
  expect(selected.warnings).toEqual([expect.stringContaining("10 万件で打ち切られ")]);

  const confirm = jest.fn(async () => true);
  await expect(execute("UPDATE APP100 SET f = 'y' WHERE f = 'x'", client, { confirm }))
    .rejects.toBeInstanceOf(SearchAbortedError);
  expect(confirm).not.toHaveBeenCalled();
  expect(mocked.api.mock.calls.every((call) => call[1] === "GET")).toBe(true);
});

test("pluginはstatus不可視のGAIA_CN01を既解放扱いにするが別statusは許可しない", () => {
  expect(isPluginAlreadyReleasedCursorError({ code: "GAIA_CN01" })).toBe(true);
  expect(isPluginAlreadyReleasedCursorError({ code: "GAIA_CN01", status: 404 })).toBe(true);
  expect(isPluginAlreadyReleasedCursorError({ code: "GAIA_CN01", status: 500 })).toBe(false);
  expect(isPluginAlreadyReleasedCursorError({ code: "OTHER" })).toBe(false);
});

test("plugin DELETEのstatusなしGAIA_CN01はquarantineせず解放済みとする", async () => {
  const mocked = installKintone(async (_url, method) => {
    if (method === "POST") return { id: "secret-cursor", totalCount: "1" };
    if (method === "DELETE") throw { code: "GAIA_CN01", message: "Cursor not found" };
    return {};
  });
  const handle = await createKintoneClient().openCursor({ app: 1, query: "order by $id asc", size: 500 });
  await expect(handle.close()).resolves.toBeUndefined();
  expect(mocked.api.mock.calls.map((call) => call[1])).toEqual(["POST", "DELETE"]);
});

test("plugin クライアントは STATUS の name と index を保持し states=null を空配列化しない", async () => {
  const responses = [
    { enable: true, states: { open: { name: "未処理", index: "3" } } },
    { enable: false, states: null },
  ];
  const mocked = installKintone(async () => responses.shift());
  const client = createKintoneClient();
  await expect(client.getProcessStatuses(1)).resolves.toEqual({
    enable: true,
    states: [{ name: "未処理", index: 3 }],
  });
  await expect(client.getProcessStatuses(1)).resolves.toEqual({ enable: false, states: null });
  expect(mocked.api).toHaveBeenCalledWith(
    "https://example.cybozu.com/k/v1/app/status.json",
    "GET",
    { app: 1, lang: "user" }
  );
});

test("plugin クライアントは運用app/settings.jsonを読みnumberPrecisionを検証する", async () => {
  const mocked = installKintone(async () => ({
    numberPrecision: { digits: "16", decimalPlaces: "4", roundingMode: "DOWN" },
  }));
  await expect(createKintoneClient().getNumberPrecision(123)).resolves.toEqual({
    digits: 16, decimalPlaces: 4, roundingMode: "DOWN",
  });
  expect(mocked.api).toHaveBeenCalledWith(
    "https://example.cybozu.com/k/v1/app/settings.json",
    "GET",
    { app: 123 }
  );
});
