import { createKintoneClient, isPluginAlreadyReleasedCursorError } from "../kintoneClient";
import { resetCursorLeaseManagers } from "../../api/cursorLeaseManager";

afterEach(resetCursorLeaseManagers);

test("plugin クライアントは本文だけを返し searchAborted を推測しない", async () => {
  const api = jest.fn(async () => ({ records: [] })) as jest.Mock & {
    url: (path: string, guest: boolean) => string;
  };
  api.url = (path) => path;
  const root = globalThis as unknown as { kintone?: { api: typeof api } };
  const previous = root.kintone;
  root.kintone = { api };
  try {
    const response = await createKintoneClient().getRecords({ app: 1, query: "", fields: [] });
    expect(response).toEqual({ records: [] });
    expect(response.searchAborted).toBeUndefined();
  } finally {
    if (previous) root.kintone = previous;
    else delete root.kintone;
  }
});

test("plugin Cursor handleはCreate/Get/Deleteをkintone.apiで実行する", async () => {
  const responses = [
    { id: "secret-cursor", totalCount: "2" },
    { records: [{ $id: { value: "1" } }], next: true },
    {},
  ];
  const api = jest.fn(async () => responses.shift()) as jest.Mock & {
    url: (path: string, guest: boolean) => string;
  };
  api.url = (path) => `https://example.cybozu.com${path}`;
  const root = globalThis as unknown as { kintone?: { api: typeof api } };
  const previous = root.kintone;
  root.kintone = { api };
  try {
    const handle = await createKintoneClient().openCursor({ app: 1, query: "order by $id asc", size: 500 });
    await handle.nextPage();
    await handle.close();
    expect(api.mock.calls.map((call) => call[1])).toEqual(["POST", "GET", "DELETE"]);
  } finally {
    if (previous) root.kintone = previous;
    else delete root.kintone;
  }
});

test("pluginはstatus不可視のGAIA_CN01を既解放扱いにするが別statusは許可しない", () => {
  expect(isPluginAlreadyReleasedCursorError({ code: "GAIA_CN01" })).toBe(true);
  expect(isPluginAlreadyReleasedCursorError({ code: "GAIA_CN01", status: 404 })).toBe(true);
  expect(isPluginAlreadyReleasedCursorError({ code: "GAIA_CN01", status: 500 })).toBe(false);
  expect(isPluginAlreadyReleasedCursorError({ code: "OTHER" })).toBe(false);
});

test("plugin DELETEのstatusなしGAIA_CN01はquarantineせず解放済みとする", async () => {
  const api = jest.fn(async (_url: string, method: string) => {
    if (method === "POST") return { id: "secret-cursor", totalCount: "1" };
    if (method === "DELETE") throw { code: "GAIA_CN01", message: "Cursor not found" };
    return {};
  }) as jest.Mock & { url: (path: string, guest: boolean) => string };
  api.url = (path) => `https://example.cybozu.com${path}`;
  const root = globalThis as unknown as { kintone?: { api: typeof api } };
  const previous = root.kintone;
  root.kintone = { api };
  try {
    const handle = await createKintoneClient().openCursor({ app: 1, query: "order by $id asc", size: 500 });
    await expect(handle.close()).resolves.toBeUndefined();
    expect(api.mock.calls.map((call) => call[1])).toEqual(["POST", "DELETE"]);
  } finally {
    if (previous) root.kintone = previous;
    else delete root.kintone;
  }
});

test("plugin クライアントは STATUS の name と index を保持し states=null を空配列化しない", async () => {
  const responses = [
    { enable: true, states: { open: { name: "未処理", index: "3" } } },
    { enable: false, states: null },
  ];
  const api = jest.fn(async () => responses.shift()) as jest.Mock & {
    url: (path: string, guest: boolean) => string;
  };
  api.url = (path) => path;
  const root = globalThis as unknown as { kintone?: { api: typeof api } };
  const previous = root.kintone;
  root.kintone = { api };
  try {
    const client = createKintoneClient();
    await expect(client.getProcessStatuses(1)).resolves.toEqual({
      enable: true,
      states: [{ name: "未処理", index: 3 }],
    });
    await expect(client.getProcessStatuses(1)).resolves.toEqual({ enable: false, states: null });
    expect(api).toHaveBeenCalledWith(
      "/k/v1/app/status.json",
      "GET",
      { app: 1, lang: "user" }
    );
  } finally {
    if (previous) root.kintone = previous;
    else delete root.kintone;
  }
});

test("plugin クライアントは運用app/settings.jsonを読みnumberPrecisionを検証する", async () => {
  const api = jest.fn(async () => ({
    numberPrecision: { digits: "16", decimalPlaces: "4", roundingMode: "DOWN" },
  })) as jest.Mock & { url: (path: string, guest: boolean) => string };
  api.url = (path) => path;
  const root = globalThis as unknown as { kintone?: { api: typeof api } };
  const previous = root.kintone;
  root.kintone = { api };
  try {
    await expect(createKintoneClient().getNumberPrecision(123)).resolves.toEqual({
      digits: 16, decimalPlaces: 4, roundingMode: "DOWN",
    });
    expect(api).toHaveBeenCalledWith("/k/v1/app/settings.json", "GET", { app: 123 });
  } finally {
    if (previous) root.kintone = previous;
    else delete root.kintone;
  }
});
