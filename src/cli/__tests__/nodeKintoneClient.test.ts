import { createNodeKintoneClient } from "../nodeKintoneClient";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  jest.restoreAllMocks();
});

function jsonResponse(
  body: unknown,
  init: ResponseInit = {}
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

function makeClient() {
  return createNodeKintoneClient("https://example.cybozu.com", {
    auth: { type: "token", resolveToken: () => "token" },
  });
}

test("X-Cybozu-Warning の既知メッセージを searchAborted に変換する", async () => {
  globalThis.fetch = jest.fn(async () => jsonResponse(
    { records: [] },
    { headers: { "X-Cybozu-Warning": "Filter aborted because of too many search results" } }
  ));

  const response = await makeClient().getRecords({ app: 1, query: "limit 1", fields: [] });
  expect(response).toEqual({ records: [], searchAborted: true });
});

test("CB_IL02 リトライ後の成功レスポンでも警告ヘッダーを検出する", async () => {
  globalThis.fetch = jest.fn()
    .mockResolvedValueOnce(jsonResponse({ code: "CB_IL02" }, { status: 400 }))
    .mockResolvedValueOnce(jsonResponse(
      { records: [] },
      { headers: { "X-Cybozu-Warning": "Filter aborted because of too many search results" } }
    ));

  const response = await makeClient().getRecords({
    app: 1,
    query: "limit 1 offset 0",
    fields: [],
  });
  expect(response.searchAborted).toBe(true);
  expect(globalThis.fetch).toHaveBeenCalledTimes(2);
});

test("無関係な警告ヘッダーは searchAborted にしない", async () => {
  globalThis.fetch = jest.fn(async () => jsonResponse(
    { records: [] },
    { headers: { "X-Cybozu-Warning": "another warning" } }
  ));

  const response = await makeClient().getRecords({ app: 1, query: "", fields: [] });
  expect(response).toEqual({ records: [] });
});
