import {
  KintoneApiError,
  createNodeKintoneClient,
  createNodeKintoneConnection,
} from "../nodeKintoneClient";
import { resetCursorLeaseManagers } from "../../api/cursorLeaseManager";
import { isRetryableError } from "../../api/requestGate";
import {
  InvalidJsonResponseError,
  KINTONE_METADATA_MAX_RESPONSE_BYTES,
  ResponseTooLargeError,
  type AllowedMetadataRequest,
} from "../../node/kintoneMetadata";

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

test("Node clientは運用app/settings.jsonを既存app routeで読みnumberPrecisionを検証する", async () => {
  globalThis.fetch = jest.fn(async () => jsonResponse({
    numberPrecision: { digits: "30", decimalPlaces: "10", roundingMode: "UP" },
  }));
  await expect(makeClient().getNumberPrecision(321)).resolves.toEqual({
    digits: 30, decimalPlaces: 10, roundingMode: "UP",
  });
  expect(String((globalThis.fetch as jest.Mock).mock.calls[0][0])).toContain("/k/v1/app/settings.json?app=321");
});

test("互換wrapperのapps/fields/settings/statusは従来の結果とGET request shapeを保つ", async () => {
  globalThis.fetch = jest.fn()
    .mockResolvedValueOnce(jsonResponse({ apps: [] }))
    .mockResolvedValueOnce(jsonResponse({ properties: {} }))
    .mockResolvedValueOnce(jsonResponse({
      numberPrecision: { digits: "20", decimalPlaces: "5", roundingMode: "HALF_EVEN" },
    }))
    .mockResolvedValueOnce(jsonResponse({ enable: false, states: null }));
  const client = makeClient();
  await expect(client.getApps()).resolves.toEqual([]);
  await expect(client.getFields(12)).resolves.toEqual([]);
  await expect(client.getNumberPrecision(12)).resolves.toEqual({
    digits: 20,
    decimalPlaces: 5,
    roundingMode: "HALF_EVEN",
  });
  await expect(client.getProcessStatuses(12)).resolves.toEqual({ enable: false, states: null });

  expect((globalThis.fetch as jest.Mock).mock.calls.map(([url, init]) => ({
    url: String(url),
    method: init.method,
  }))).toEqual([
    { url: "https://example.cybozu.com/k/v1/apps.json?limit=100&offset=0", method: "GET" },
    { url: "https://example.cybozu.com/k/v1/app/form/fields.json?app=12", method: "GET" },
    { url: "https://example.cybozu.com/k/v1/app/settings.json?app=12", method: "GET" },
    { url: "https://example.cybozu.com/k/v1/app/status.json?app=12&lang=user", method: "GET" },
  ]);
});

test("metadata readerの8 resourceはallowlist endpointへGETだけを送る", async () => {
  globalThis.fetch = jest.fn(async () => jsonResponse({ revision: "1" }));
  const { metadataReader } = makeConnection({
    auth: { type: "userpass", username: "user", password: "password" },
  });
  const requests: AllowedMetadataRequest[] = [
    { resource: "app" },
    { resource: "fields", lang: "user" },
    { resource: "layout" },
    { resource: "settings" },
    { resource: "status" },
    { resource: "views" },
    { resource: "reports" },
    { resource: "customize" },
  ];

  for (const request of requests) {
    await metadataReader.getMetadata(request, 123);
  }

  expect(globalThis.fetch).toHaveBeenCalledTimes(8);
  const methods = (globalThis.fetch as jest.Mock).mock.calls.map((call) => call[1]?.method);
  expect(methods).toEqual(Array(8).fill("GET"));
  expect(methods.filter((method) => ["POST", "PUT", "DELETE", "HEAD"].includes(method))).toHaveLength(0);
  expect((globalThis.fetch as jest.Mock).mock.calls.map((call) => String(call[0]))).toEqual([
    "https://example.cybozu.com/k/v1/app.json?id=123",
    "https://example.cybozu.com/k/v1/app/form/fields.json?app=123&lang=user",
    "https://example.cybozu.com/k/v1/app/form/layout.json?app=123",
    "https://example.cybozu.com/k/v1/app/settings.json?app=123",
    "https://example.cybozu.com/k/v1/app/status.json?app=123",
    "https://example.cybozu.com/k/v1/app/views.json?app=123",
    "https://example.cybozu.com/k/v1/app/reports.json?app=123",
    "https://example.cybozu.com/k/v1/app/customize.json?app=123",
  ]);
});

test("metadata readerはschema迂回のresource・余計なproperty・preview/lang/auth違反をfetch前に再拒否する", async () => {
  globalThis.fetch = jest.fn(async () => jsonResponse({ unexpected: true }));
  const userpassReader = makeConnection({
    auth: { type: "userpass", username: "user", password: "password" },
  }).metadataReader;
  const attacks: unknown[] = [
    { resource: "unknown" },
    { resource: "records" },
    { resource: "acl" },
    { resource: "apps" },
    { resource: "space" },
    { resource: "fields", method: "POST" },
    { resource: "fields", path: "/k/v1/records.json" },
    { resource: "app", preview: true },
    { resource: "layout", lang: "user" },
    { resource: "fields", lang: "fr" },
  ];
  for (const attack of attacks) {
    await expect(userpassReader.getMetadata(attack as AllowedMetadataRequest, 123)).rejects.toThrow();
  }
  const tokenReader = makeConnection().metadataReader;
  await expect(tokenReader.getMetadata({ resource: "customize" }, 123)).rejects.toThrow();
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

test("metadata pathはconnectionのnormal・guest base pathだけから構築する", async () => {
  globalThis.fetch = jest.fn(async () => jsonResponse({}));
  await makeConnection().metadataReader.getMetadata({ resource: "fields" }, 7);
  await makeConnection({ guestSpaceId: 55 }).metadataReader.getMetadata({ resource: "layout" }, 7);
  await makeConnection({ guestSpaceId: 55 }).metadataReader.getMetadata(
    { resource: "settings", preview: true },
    7
  );
  expect((globalThis.fetch as jest.Mock).mock.calls.map((call) => String(call[0]))).toEqual([
    "https://example.cybozu.com/k/v1/app/form/fields.json?app=7",
    "https://example.cybozu.com/k/guest/55/v1/app/form/layout.json?app=7",
    "https://example.cybozu.com/k/guest/55/v1/preview/app/settings.json?app=7",
  ]);
});

test("metadata readerはresolvedAppId token・token/userpass header・安全なaudit値を共有する", async () => {
  globalThis.fetch = jest.fn(async () => jsonResponse({ raw: true }));
  const resolveToken = jest.fn(() => "super-secret-token");
  const tokenResult = await makeConnection({
    auth: { type: "token", resolveToken },
  }).metadataReader.getMetadata({ resource: "fields", lang: "ja" }, 987);
  expect(resolveToken).toHaveBeenCalledWith(987);
  const tokenHeaders = (globalThis.fetch as jest.Mock).mock.calls[0][1].headers as Headers;
  expect(tokenHeaders.get("X-Cybozu-API-Token")).toBe("super-secret-token");
  expect(tokenHeaders.get("Accept")).toBe("application/json");
  expect(tokenHeaders.get("Content-Type")).toBeNull();
  expect(tokenResult).toMatchObject({
    resource: "fields",
    environment: "production",
    path: "/k/v1/app/form/fields.json",
    params: { app: "987", lang: "ja" },
    data: { raw: true },
  });
  expect(JSON.stringify(tokenResult)).not.toContain("super-secret-token");
  expect(JSON.stringify(tokenResult)).not.toContain("example.cybozu.com");

  await makeConnection({
    auth: { type: "userpass", username: "user", password: "password" },
  }).metadataReader.getMetadata({ resource: "app" }, 987);
  const userpassHeaders = (globalThis.fetch as jest.Mock).mock.calls[1][1].headers as Headers;
  expect(userpassHeaders.get("X-Cybozu-Authorization")).toBe(
    Buffer.from("user:password", "utf-8").toString("base64")
  );
  expect(userpassHeaders.get("X-Cybozu-API-Token")).toBeNull();
});

test("metadata readerは既存timeout signalとKintoneApiError化を共有する", async () => {
  globalThis.fetch = jest.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  })) as jest.Mock;
  await expect(makeConnection({ timeoutMs: 1 }).metadataReader.getMetadata(
    { resource: "fields" },
    1
  )).rejects.toMatchObject({ name: "AbortError" });

  globalThis.fetch = jest.fn(async () => jsonResponse(
    { code: "CB_NO02", message: "permission denied" },
    { status: 403 }
  ));
  const failure = makeConnection().metadataReader.getMetadata({ resource: "fields" }, 1);
  await expect(failure).rejects.toBeInstanceOf(KintoneApiError);
  await expect(failure).rejects.toMatchObject({ status: 403, code: "CB_NO02" });
});

test("Content-Length上限超過はstream read前にcancelしてResponseTooLargeErrorにする", async () => {
  const pull = jest.fn();
  const cancel = jest.fn();
  const stream = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
  globalThis.fetch = jest.fn(async () => new Response(stream, {
    headers: { "Content-Length": String(KINTONE_METADATA_MAX_RESPONSE_BYTES + 1) },
  }));

  const failure = makeConnection().metadataReader.getMetadata({ resource: "fields" }, 1);
  await expect(failure).rejects.toBeInstanceOf(ResponseTooLargeError);
  expect(pull).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledTimes(1);
});

test.each([
  ["Content-Lengthなし", undefined],
  ["虚偽Content-Length", "1"],
])("%s のchunked bodyは2MiB+1でstreamをcancelしpartialを返さない", async (_label, contentLength) => {
  const cancel = jest.fn();
  const chunks = [
    new Uint8Array(KINTONE_METADATA_MAX_RESPONSE_BYTES),
    new Uint8Array(1),
  ];
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk !== undefined) controller.enqueue(chunk);
    },
    cancel,
  }, { highWaterMark: 0 });
  globalThis.fetch = jest.fn(async () => new Response(stream, {
    headers: contentLength === undefined ? undefined : { "Content-Length": contentLength },
  }));

  await expect(makeConnection().metadataReader.getMetadata(
    { resource: "fields" },
    1
  )).rejects.toBeInstanceOf(ResponseTooLargeError);
  expect(cancel).toHaveBeenCalledTimes(1);
});

test("metadata bodyはexactly 2MiBを許可し2MiB+1を拒否する", async () => {
  const exactBody = `{"value":"${"a".repeat(KINTONE_METADATA_MAX_RESPONSE_BYTES - 12)}"}`;
  expect(Buffer.byteLength(exactBody, "utf-8")).toBe(KINTONE_METADATA_MAX_RESPONSE_BYTES);
  globalThis.fetch = jest.fn()
    .mockResolvedValueOnce(new Response(exactBody, {
      headers: { "Content-Length": String(KINTONE_METADATA_MAX_RESPONSE_BYTES) },
    }))
    .mockResolvedValueOnce(new Response(`${exactBody} `, {
      headers: { "Content-Length": String(KINTONE_METADATA_MAX_RESPONSE_BYTES + 1) },
    }));
  const reader = makeConnection().metadataReader;

  await expect(reader.getMetadata({ resource: "fields" }, 1)).resolves.toMatchObject({
    responseBytes: KINTONE_METADATA_MAX_RESPONSE_BYTES,
  });
  await expect(reader.getMetadata({ resource: "fields" }, 1)).rejects.toBeInstanceOf(
    ResponseTooLargeError
  );
});

test("responseBytesはUTF-8実byteでraw objectをdeep-equal保持しnormalizerを通さない", async () => {
  const raw = {
    unknown: "あ",
    nested: [{ empty: "", enabled: false, nullable: null }],
    properties: { rawField: { type: "UNKNOWN_FUTURE_TYPE", extra: true } },
  };
  const body = JSON.stringify(raw);
  globalThis.fetch = jest.fn(async () => new Response(body));
  const result = await makeConnection().metadataReader.getMetadata({ resource: "fields" }, 1);
  expect(result.data).toEqual(raw);
  expect(result.responseBytes).toBe(Buffer.byteLength(body, "utf-8"));
  expect(result.responseBytes).toBeGreaterThan(body.length);
});

test("invalid JSONとsize overflowは独立errorでretryableではない", async () => {
  globalThis.fetch = jest.fn(async () => new Response("not-json"));
  const invalid = await makeConnection().metadataReader.getMetadata(
    { resource: "settings" },
    1
  ).catch((error: unknown) => error);
  expect(invalid).toBeInstanceOf(InvalidJsonResponseError);
  expect(isRetryableError(invalid)).toBe(false);

  globalThis.fetch = jest.fn(async () => new Response("", {
    headers: { "Content-Length": String(KINTONE_METADATA_MAX_RESPONSE_BYTES + 1) },
  }));
  const overflow = await makeConnection().metadataReader.getMetadata(
    { resource: "settings" },
    1
  ).catch((error: unknown) => error);
  expect(overflow).toBeInstanceOf(ResponseTooLargeError);
  expect(isRetryableError(overflow)).toBe(false);
});

test("metadata readerはraw cacheを持たず同じcallを2回ともGETする", async () => {
  globalThis.fetch = jest.fn(async () => jsonResponse({ revision: "1" }));
  const { metadataReader } = makeConnection();
  await metadataReader.getMetadata({ resource: "views" }, 1);
  await metadataReader.getMetadata({ resource: "views" }, 1);
  expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  expect(Object.keys(metadataReader)).toEqual(["getMetadata"]);
});

test("既存client成功bodyにはmetadata 2MiB capを適用しない", async () => {
  globalThis.fetch = jest.fn(async () => jsonResponse({
    records: [],
    padding: "x".repeat(KINTONE_METADATA_MAX_RESPONSE_BYTES + 1),
  }));
  await expect(makeClient().getRecords({ app: 1, query: "", fields: [] })).resolves.toEqual({
    records: [],
    padding: expect.any(String),
  });
});

function makeConnection(overrides: Partial<Parameters<typeof createNodeKintoneConnection>[1]> = {}) {
  return createNodeKintoneConnection("https://example.cybozu.com/", {
    auth: { type: "token", resolveToken: () => "token" },
    ...overrides,
  });
}
