import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RequestGate, resetGlobalRequestGate } from "../../api/requestGate";
import * as nodeKintoneClient from "../../cli/nodeKintoneClient";
import { KINTONE_METADATA_MAX_RESPONSE_BYTES } from "../kintoneMetadata";
import { createKintoneMetadataRuntime } from "../runtime";

const ENV_KEYS = [
  "KSQL_CONFIG",
  "KSQL_BASE_URL",
  "KSQL_GUEST_SPACE_ID",
  "KSQL_TOKEN",
  "KSQL_TOKEN_MAP",
  "KSQL_AUTH",
  "KSQL_USERNAME",
  "KSQL_PASSWORD",
  "KSQL_PROFILE",
  "KSQL_TIMEOUT",
  "KSQL_RETRY",
  "KSQL_RETRY_BASE_DELAY_MS",
  "KSQL_RETRY_MAX_DELAY_MS",
] as const;

describe("createKintoneMetadataRuntime", () => {
  let tempDir: string;
  let configPath: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    tempDir = mkdtempSync(join(tmpdir(), "ksql-metadata-runtime-"));
    configPath = join(tempDir, "ksql.config.json");
    resetGlobalRequestGate();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    resetGlobalRequestGate();
    rmSync(tempDir, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  function writeConfig(config: Record<string, unknown>): void {
    writeFileSync(configPath, JSON.stringify(config), "utf-8");
  }

  function jsonResponse(data: Record<string, unknown>, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  test.each([
    0,
    -1,
    Number.MAX_SAFE_INTEGER + 1,
    "APP42",
    "LAPP_1BAD",
    "LAPP_ORDERS@prod",
    "LAPP_ORDERS$rows",
    "SELECT * FROM APP42",
  ])("invalid AppRef %p は resolver/connection/fetch 前に拒否する", async (app) => {
    writeConfig({ defaultProfile: "dev", profiles: { dev: {} } });
    const connectionSpy = jest.spyOn(nodeKintoneClient, "createNodeKintoneConnection");
    const fetchMock = jest.spyOn(globalThis, "fetch");
    await expect(createKintoneMetadataRuntime(
      { configPath },
      {
        app: app as Parameters<typeof createKintoneMetadataRuntime>[1]["app"],
        request: { resource: "fields" },
      }
    )).rejects.toThrow("ArgumentError: app must be a positive safe integer or LAPP_<NAME>.");
    expect(connectionSpy).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("numeric app は既存 physical policy/cacheContext を通り resolved app を返す", async () => {
    writeConfig({
      defaultProfile: "dev",
      profiles: {
        dev: { baseUrl: "https://dev.example.cybozu.com", tokenMap: { APP42: "dev-secret" } },
      },
    });
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ properties: {}, revision: "7" })
    );

    const runtime = await createKintoneMetadataRuntime(
      { configPath },
      { app: 42, request: { resource: "fields", lang: "user" } }
    );

    expect(runtime).toMatchObject({
      sourceApp: 42,
      mappedAppId: 42,
      resolvedAppId: 42,
      profileName: "dev",
      environment: "production",
      metadata: {
        resource: "fields",
        params: { app: "42", lang: "user" },
        data: { properties: {}, revision: "7" },
      },
    });
    expect(runtime.cacheContext).toContain("physical:APP42@dev");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "https://dev.example.cybozu.com/k/v1/app/form/fields.json?app=42&lang=user"
    );
    expect(new Headers(init?.headers).get("X-Cybozu-API-Token")).toBe("dev-secret");
  });

  test("LAPP は binding の mapped ID と physical ID/profile/cacheContext を一貫して返す", async () => {
    writeConfig({
      defaultProfile: "dev",
      profiles: {
        dev: { baseUrl: "https://dev.invalid", tokenMap: { APP7: "dev-token" } },
        prod: {
          baseUrl: "https://prod.example.cybozu.com",
          guestSpaceId: 9,
          logicalApps: { ORDERS: 321 },
          tokenMap: { APP321: "prod-token" },
          query: { timeout: 1234 },
        },
      },
    });
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ views: {} }));

    const runtime = await createKintoneMetadataRuntime(
      { configPath },
      { app: "LAPP_ORDERS", profile: "prod", request: { resource: "views", preview: true } }
    );

    expect(runtime.sourceApp).toBe("LAPP_ORDERS");
    expect(runtime.mappedAppId).not.toBe(321);
    expect(runtime.resolvedAppId).toBe(321);
    expect(runtime.profileName).toBe("prod");
    expect(runtime.cacheContext).toContain("logical:ORDERS:APP321@prod");
    expect(runtime.environment).toBe("preview");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "https://prod.example.cybozu.com/k/guest/9/v1/preview/app/views.json?app=321"
    );
    expect(new Headers(init?.headers).get("X-Cybozu-API-Token")).toBe("prod-token");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(runtime)).not.toMatch(/prod-token|dev-token|dev\.invalid|password/i);
  });

  test.each([
    ["unknown LAPP", { app: "LAPP_UNKNOWN" as const, profile: "dev" }, /logical app LAPP_UNKNOWN@dev is not defined/],
    ["logicalApps 未設定", { app: "LAPP_ORDERS" as const, profile: "plain" }, /logical app LAPP_ORDERS@plain is not defined/],
    ["undefined explicit profile", { app: 42 as const, profile: "missing" }, /profile "missing" is not defined/],
    ["physical refs disabled", { app: 42 as const, profile: "locked" }, /physical app references are not allowed/],
  ])("%s は connection/fetch 前に fail-closed", async (_label, appInput, expected) => {
    writeConfig({
      defaultProfile: "dev",
      profiles: {
        dev: { baseUrl: "https://dev.invalid", logicalApps: { ORDERS: 10 }, tokenMap: {} },
        plain: { baseUrl: "https://plain.invalid", tokenMap: {} },
        locked: {
          baseUrl: "https://locked.invalid",
          allowPhysicalAppRefs: false,
          tokenMap: { APP42: "must-not-be-used" },
        },
      },
    });
    const connectionSpy = jest.spyOn(nodeKintoneClient, "createNodeKintoneConnection");
    const fetchMock = jest.spyOn(globalThis, "fetch");

    await expect(createKintoneMetadataRuntime(
      { configPath },
      { ...appInput, request: { resource: "fields" } }
    )).rejects.toThrow(expected);

    expect(connectionSpy).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("logical token 欠落は single token/default profile/別 profile に fallback しない", async () => {
    writeConfig({
      defaultProfile: "dev",
      profiles: {
        dev: { baseUrl: "https://dev.invalid", tokenMap: { APP500: "wide-token" } },
        prod: {
          baseUrl: "https://prod.invalid",
          logicalApps: { ORDERS: 500 },
          tokenMap: {},
        },
      },
    });
    process.env.KSQL_TOKEN = "single-token-must-not-be-used";
    const connectionSpy = jest.spyOn(nodeKintoneClient, "createNodeKintoneConnection");
    const fetchMock = jest.spyOn(globalThis, "fetch");

    await expect(createKintoneMetadataRuntime(
      { configPath },
      { app: "LAPP_ORDERS", profile: "prod", request: { resource: "fields" } }
    )).rejects.toThrow("AuthError: token is missing for LAPP_ORDERS (APP500)@prod.");
    expect(connectionSpy).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("customize は token profile で request 前に停止し userpass profile だけ固定 GET へ進む", async () => {
    writeConfig({
      defaultProfile: "token",
      profiles: {
        token: { baseUrl: "https://token.invalid", tokenMap: { APP77: "token-secret" } },
        user: {
          baseUrl: "https://user.example.cybozu.com",
          auth: "userpass",
          username: "alice",
          password: "user-secret",
        },
      },
    });
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ desktop: {} }));
    await expect(createKintoneMetadataRuntime(
      { configPath },
      { app: 77, profile: "token", request: { resource: "customize" } }
    )).rejects.toThrow('CapabilityError: resource "customize" requires userpass authentication.');
    expect(fetchMock).not.toHaveBeenCalled();

    const runtime = await createKintoneMetadataRuntime(
      { configPath },
      { app: 77, profile: "user", request: { resource: "customize" } }
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://user.example.cybozu.com/k/v1/app/customize.json?app=77");
    expect(new Headers(init?.headers).get("X-Cybozu-Authorization")).toBeTruthy();
    expect(new Headers(init?.headers).get("X-Cybozu-API-Token")).toBeNull();
    expect(JSON.stringify(runtime)).not.toMatch(/alice|user-secret|token-secret/);
  });

  test.each([408, 429, 502, 503, 504])(
    "HTTP %i は runReadOnly の既存回数だけ exact request で retry",
    async (status) => {
      writeConfig({
        defaultProfile: "dev",
        profiles: {
          dev: {
            baseUrl: "https://retry.example.cybozu.com",
            tokenMap: { APP12: "retry-token" },
            query: { retry: 2, retryBaseDelayMs: 1, retryMaxDelayMs: 1 },
          },
        },
      });
      const fetchMock = jest.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response("temporary", { status }))
        .mockResolvedValueOnce(new Response("temporary", { status }))
        .mockResolvedValueOnce(jsonResponse({ ok: true }));

      await createKintoneMetadataRuntime(
        { configPath },
        { app: 12, request: { resource: "settings", lang: "ja" } }
      );

      expect(fetchMock).toHaveBeenCalledTimes(3);
      const signatures = fetchMock.mock.calls.map(([url, init]) => ({
        url: String(url),
        method: init?.method,
        token: new Headers(init?.headers).get("X-Cybozu-API-Token"),
      }));
      expect(new Set(signatures.map((signature) => JSON.stringify(signature))).size).toBe(1);
    }
  );

  test.each([
    ["network", new TypeError("fetch failed")],
    ["timeout", Object.assign(new Error("timed out"), { name: "TimeoutError" })],
    ["abort", Object.assign(new Error("aborted"), { name: "AbortError" })],
  ])("%s error だけは retry する", async (_label, error) => {
    writeConfig({
      defaultProfile: "dev",
      profiles: {
        dev: {
          baseUrl: "https://retry.invalid",
          tokenMap: { APP12: "retry-token" },
          query: { retry: 1, retryBaseDelayMs: 1, retryMaxDelayMs: 1 },
        },
      },
    });
    const fetchMock = jest.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await createKintoneMetadataRuntime(
      { configPath },
      { app: 12, request: { resource: "fields" } }
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test.each([400, 401, 403, 404])("HTTP %i は retry しない", async (status) => {
    writeConfig({
      defaultProfile: "dev",
      profiles: {
        dev: {
          baseUrl: "https://no-retry.invalid",
          tokenMap: { APP12: "token" },
          query: { retry: 3, retryBaseDelayMs: 1, retryMaxDelayMs: 1 },
        },
      },
    });
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("permanent", { status })
    );
    await expect(createKintoneMetadataRuntime(
      { configPath },
      { app: 12, request: { resource: "fields" } }
    )).rejects.toThrow(`kintone API error ${status}:`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("parse/size error は retry せず runMutation/runCursorStep を使わない", async () => {
    writeConfig({
      defaultProfile: "dev",
      profiles: {
        dev: {
          baseUrl: "https://safe.invalid",
          tokenMap: { APP12: "token" },
          query: { retry: 3, retryBaseDelayMs: 1, retryMaxDelayMs: 1 },
        },
      },
    });
    const readOnlySpy = jest.spyOn(RequestGate.prototype, "runReadOnly");
    const mutationSpy = jest.spyOn(RequestGate.prototype, "runMutation");
    const cursorSpy = jest.spyOn(RequestGate.prototype, "runCursorStep");
    const fetchMock = jest.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("not-json", { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", {
        status: 200,
        headers: { "Content-Length": String(KINTONE_METADATA_MAX_RESPONSE_BYTES + 1) },
      }));

    await expect(createKintoneMetadataRuntime(
      { configPath },
      { app: 12, request: { resource: "fields" } }
    )).rejects.toThrow("InvalidJsonResponseError");
    await expect(createKintoneMetadataRuntime(
      { configPath },
      { app: 12, request: { resource: "fields" } }
    )).rejects.toThrow("ResponseTooLargeError");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readOnlySpy).toHaveBeenCalledTimes(2);
    expect(mutationSpy).not.toHaveBeenCalled();
    expect(cursorSpy).not.toHaveBeenCalled();
  });

  test("raw cache を持たず同一 call 2回で GET も2回", async () => {
    writeConfig({
      defaultProfile: "dev",
      profiles: {
        dev: { baseUrl: "https://fresh.invalid", tokenMap: { APP12: "token" } },
      },
    });
    const fetchMock = jest.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ revision: "1" }))
      .mockResolvedValueOnce(jsonResponse({ revision: "2" }));

    const first = await createKintoneMetadataRuntime(
      { configPath },
      { app: 12, request: { resource: "fields" } }
    );
    const second = await createKintoneMetadataRuntime(
      { configPath },
      { app: 12, request: { resource: "fields" } }
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(first.metadata.data).toEqual({ revision: "1" });
    expect(second.metadata.data).toEqual({ revision: "2" });
  });
});
