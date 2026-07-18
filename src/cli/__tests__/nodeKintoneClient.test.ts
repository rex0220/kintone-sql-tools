import { createNodeKintoneClient } from "../nodeKintoneClient";
import { resetCursorLeaseManagers } from "../../api/cursorLeaseManager";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  jest.restoreAllMocks();
  resetCursorLeaseManagers();
});

test("Cursor Create/Get/Deleteを同じNode clientへ束縛する", async () => {
  globalThis.fetch = jest.fn()
    .mockResolvedValueOnce(jsonResponse({ id: "secret-cursor", totalCount: "600" }))
    .mockResolvedValueOnce(jsonResponse({ records: [{ $id: { value: "1" } }], next: true }))
    .mockResolvedValueOnce(jsonResponse({}));
  const handle = await makeClient().openCursor({ app: 1, query: "order by $id asc", size: 500 });
  expect(handle.totalCount).toBe(600);
  await expect(handle.nextPage()).resolves.toMatchObject({ next: true });
  await handle.close();
  expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  const createInit = (globalThis.fetch as jest.Mock).mock.calls[0][1] as RequestInit;
  expect(JSON.parse(String(createInit.body))).toEqual({ app: 1, query: "order by $id asc", size: 500 });
  expect(((globalThis.fetch as jest.Mock).mock.calls[1][0] as string)).toContain("records/cursor.json?id=secret-cursor");
  const deleteInit = (globalThis.fetch as jest.Mock).mock.calls[2][1] as RequestInit;
  expect(deleteInit.method).toBe("DELETE");
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
