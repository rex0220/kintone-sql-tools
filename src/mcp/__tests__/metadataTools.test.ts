import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { resetGlobalRequestGate } from "../../api/requestGate";
import { KINTONE_METADATA_RESOURCES, mapKintoneMetadataRequest } from "../../node/kintoneMetadata";
import type {
  CreateKintoneMetadataRuntimeInput,
  KintoneMetadataRuntime,
  KsqlRuntimeServerOptions,
} from "../../node/runtime";
import { createServer } from "../index";
import { ksqlAppMetadataInputSchema, ksqlAppMetadataInputShape } from "../schemas";
import { createKsqlMcpTools } from "../tools";

function metadataRuntime(
  input: CreateKintoneMetadataRuntimeInput,
  data: Record<string, unknown> = {}
): KintoneMetadataRuntime {
  const preview = input.request.preview === true;
  return {
    sourceApp: input.app,
    mappedAppId: 900_000_000,
    resolvedAppId: 1234,
    profileName: input.profile ?? "prod",
    environment: preview ? "preview" : "production",
    cacheContext: "metadata-test",
    metadata: {
      resource: input.request.resource,
      environment: preview ? "preview" : "production",
      path: preview ? "/k/v1/preview/app/form/fields.json" : "/k/v1/app/form/fields.json",
      params: {
        app: "1234",
        ...(input.request.resource === "fields" && input.request.lang !== undefined
          ? { lang: input.request.lang }
          : {}),
      },
      responseBytes: 321,
      data,
    },
  };
}

describe("ksql_app_metadata MCP surface", () => {
  test("tools/list registration is purely additive and exposes the strict resource union", () => {
    const server = createServer({ help: false });
    const registered = (server as unknown as {
      _registeredTools: Record<string, {
        title?: string;
        description?: string;
        inputSchema: typeof ksqlAppMetadataInputShape;
      }>;
    })._registeredTools;

    expect(Object.keys(registered)).toEqual([
      "ksql_validate",
      "ksql_explain",
      "ksql_query",
      "ksql_mutate",
      "ksql_describe_app",
      "ksql_app_metadata",
      "ksql_show_apps",
      "ksql_save_query",
      "ksql_list_queries",
      "ksql_get_query",
      "ksql_run_saved_query",
      "ksql_delete_query",
    ]);
    const metadata = registered.ksql_app_metadata;
    expect(metadata.title).toBe("Get kintone app metadata");
    for (const key of [
      "fields", "constraints", "raw", "read-only", "fixed GET allowlist", "records", "mutation",
    ]) {
      expect(metadata.description).toContain(key);
    }
    const describe = registered.ksql_describe_app;
    for (const key of ["field code", "label", "type", "ksql_app_metadata"]) {
      expect(describe.description).toContain(key);
    }
    for (const toolName of ["ksql_query", "ksql_mutate"]) {
      expect(registered[toolName].description).toContain("ksql://language-reference");
    }
    expect(metadata.inputSchema).toBe(ksqlAppMetadataInputShape);
    expect([...KINTONE_METADATA_RESOURCES]).toEqual([
      "app", "fields", "layout", "settings", "status", "views", "reports", "customize",
    ]);
  });

  test("actual tools/list JSON schema is strict and invalid calls stop before fetch", async () => {
    const server = createServer({ help: false });
    const client = new Client({ name: "metadata-unit-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const fetchMock = jest.spyOn(globalThis, "fetch");
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const instructions = client.getInstructions();
      expect(instructions).toBeTruthy();
      expect(instructions?.trim().split(/\s+/).length).toBeGreaterThanOrEqual(150);
      expect(instructions?.trim().split(/\s+/).length).toBeLessThanOrEqual(220);
      expect(instructions?.trim().split(/\n\n/)).toHaveLength(3);
      for (const key of [
        "not generic SQL",
        "VALIDATE ONLY",
        "ksql_app_metadata",
        "ksql://language-reference",
        "APPLY mutation is disabled",
      ]) {
        expect(instructions).toContain(key);
      }
      const listed = await client.listTools();
      const metadata = listed.tools.find((tool) => tool.name === "ksql_app_metadata");
      expect(metadata).toMatchObject({
        name: "ksql_app_metadata",
        title: "Get kintone app metadata",
      });
      const inputSchema = metadata?.inputSchema as {
        additionalProperties?: boolean;
        properties?: Record<string, { enum?: string[] }>;
      };
      expect(inputSchema.additionalProperties).toBe(false);
      expect(inputSchema.properties?.resource.enum).toEqual([...KINTONE_METADATA_RESOURCES]);
      expect(Object.keys(inputSchema.properties ?? {}).sort()).toEqual([
        "app", "lang", "preview", "profile", "resource",
      ]);

      for (const args of [
        { resource: "fields", app: 1, url: "https://evil.example" },
        { resource: "layout", app: 1, lang: "ja" },
        { resource: "app", app: 1, preview: true },
      ]) {
        const invalid = await client.callTool({ name: "ksql_app_metadata", arguments: args });
        expect(invalid.isError).toBe(true);
        expect(JSON.stringify(invalid.content)).toContain("Invalid arguments");
      }
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      jest.restoreAllMocks();
      await client.close();
      await server.close();
    }
  });

  test("schema accepts only positive safe integer or LAPP app references", () => {
    for (const app of [1, Number.MAX_SAFE_INTEGER, "LAPP_Orders", "lapp_a_1"]) {
      expect(ksqlAppMetadataInputSchema.safeParse({ resource: "fields", app }).success).toBe(true);
    }
    for (const app of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "APP123", "SELECT * FROM APP1", "LAPP_A@prod", "LAPP_A.Subtable", "LAPP_1A"]) {
      expect(ksqlAppMetadataInputSchema.safeParse({ resource: "fields", app }).success).toBe(false);
    }
  });

  test.each([
    { resource: "fields", app: 1, url: "https://evil.example/k/v1/records.json" },
    { resource: "fields", app: 1, path: "/k/v1/records.json" },
    { resource: "fields", app: 1, endpoint: "/k/v1/apps.json" },
    { resource: "fields", app: 1, method: "POST" },
    { resource: "fields", app: 1, headers: { Authorization: "secret" } },
    { resource: "fields", app: 1, body: {} },
    { resource: "fields", app: 1, query: "app=1" },
    { resource: "fields", app: 1, ids: [1] },
    { resource: "layout", app: 1, lang: "ja" },
    { resource: "app", app: 1, preview: true },
    { resource: "records", app: 1 },
  ])("strict discriminated union rejects $resource mismatch or unknown key", (input) => {
    expect(ksqlAppMetadataInputSchema.safeParse(input).success).toBe(false);
  });

  test("raw handler forwards bypassed invalid input to the P1 mapper and performs no transport/executor work", async () => {
    const transport = jest.fn();
    const createRuntime = jest.fn();
    const executeSql = jest.fn();
    const executeBatchSql = jest.fn();
    const createMetadataRuntime = jest.fn(async (
      _serverOptions: KsqlRuntimeServerOptions,
      input: CreateKintoneMetadataRuntimeInput
    ) => {
      mapKintoneMetadataRequest(input.request, 1234, "/k/v1", "userpass");
      transport();
      return metadataRuntime(input);
    });
    const tools = createKsqlMcpTools({ profile: "prod" }, {
      createMetadataRuntime,
      createRuntime,
      executeSql,
      executeBatchSql,
    });

    for (const input of [
      { resource: "records", app: 1 },
      { resource: "layout", app: 1, lang: "ja" },
      { resource: "app", app: 1, preview: true },
      { resource: "fields", app: 1, method: "DELETE", path: "/k/v1/records.json" },
      { resource: "acl", app: 1, endpoint: "/k/v1/app/acl.json" },
      { resource: "apps", app: 1, ids: [1] },
      { resource: "space", app: 1 },
    ]) {
      await expect(tools.appMetadata(input as never)).rejects.toThrow();
    }
    expect(createMetadataRuntime).toHaveBeenCalledTimes(7);
    expect(transport).not.toHaveBeenCalled();
    expect(createRuntime).not.toHaveBeenCalled();
    expect(executeSql).not.toHaveBeenCalled();
    expect(executeBatchSql).not.toHaveBeenCalled();
  });

  test("success preserves raw nested data and keeps audit metadata outside data", async () => {
    const raw = {
      properties: { x: { type: "UNKNOWN_FUTURE", nested: [null, true, ""] } },
      revision: "7",
      unknown: { child: [{ value: null }] },
    };
    const createRuntime = jest.fn();
    const executeSql = jest.fn();
    const executeBatchSql = jest.fn();
    const createMetadataRuntime = jest.fn(async (
      _serverOptions: KsqlRuntimeServerOptions,
      input: CreateKintoneMetadataRuntimeInput
    ) => metadataRuntime(input, raw));
    const tools = createKsqlMcpTools({ profile: "prod" }, {
      createMetadataRuntime,
      createRuntime,
      executeSql,
      executeBatchSql,
    });

    const result = await tools.appMetadataTool({
      resource: "fields",
      app: "LAPP_ORDERS",
      profile: "prod",
      preview: false,
      lang: "user",
    });
    const payload = result.structuredContent as Record<string, unknown>;
    expect(result.isError).toBe(false);
    expect(payload).toEqual({
      ok: true,
      type: "KINTONE_METADATA",
      resource: "fields",
      environment: "production",
      request: {
        method: "GET",
        endpoint: "/k/v1/app/form/fields.json",
        app: "LAPP_ORDERS",
        resolvedAppId: 1234,
        profile: "prod",
        params: { app: "1234", lang: "user" },
      },
      responseBytes: 321,
      data: raw,
    });
    expect(payload.data).toEqual(raw);
    expect(payload.data).toBe(raw);
    expect(raw).not.toHaveProperty("ok");
    expect(raw).not.toHaveProperty("request");
    expect(JSON.parse(result.content[0].type === "text" ? result.content[0].text : "null")).toEqual(payload);
    expect(createMetadataRuntime).toHaveBeenCalledWith(
      { profile: "prod" },
      {
        app: "LAPP_ORDERS",
        profile: "prod",
        request: { resource: "fields", preview: false, lang: "user" },
      }
    );
    expect(createRuntime).not.toHaveBeenCalled();
    expect(executeSql).not.toHaveBeenCalled();
    expect(executeBatchSql).not.toHaveBeenCalled();
  });

  test("handler preserves logical/profile/guest/preview routing and read-only retry guarantees", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ksql-mcp-metadata-"));
    const configPath = join(dir, "ksql.config.json");
    writeFileSync(configPath, JSON.stringify({
      defaultProfile: "prod",
      profiles: {
        prod: {
          baseUrl: "https://metadata.example.cybozu.com",
          guestSpaceId: 9,
          logicalApps: { ORDERS: 321 },
          tokenMap: { APP321: "do-not-expose-token" },
          query: { retry: 1, retryBaseDelayMs: 1, retryMaxDelayMs: 1 },
        },
      },
    }), "utf8");
    resetGlobalRequestGate();
    const fetchMock = jest.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("temporary", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ views: { future: null } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    try {
      const result = await createKsqlMcpTools({ configPath }).appMetadataTool({
        resource: "views",
        app: "LAPP_ORDERS",
        profile: "prod",
        preview: true,
        lang: "ja",
      });
      const payload = result.structuredContent as Record<string, unknown>;
      expect(result.isError).toBe(false);
      expect(payload).toMatchObject({
        ok: true,
        type: "KINTONE_METADATA",
        resource: "views",
        environment: "preview",
        request: {
          method: "GET",
          endpoint: "/k/guest/9/v1/preview/app/views.json",
          app: "LAPP_ORDERS",
          resolvedAppId: 321,
          profile: "prod",
          params: { app: "321", lang: "ja" },
        },
        data: { views: { future: null } },
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const signatures = fetchMock.mock.calls.map(([url, init]) => ({
        url: String(url),
        method: init?.method,
      }));
      expect(signatures).toEqual([
        { url: "https://metadata.example.cybozu.com/k/guest/9/v1/preview/app/views.json?app=321&lang=ja", method: "GET" },
        { url: "https://metadata.example.cybozu.com/k/guest/9/v1/preview/app/views.json?app=321&lang=ja", method: "GET" },
      ]);
      expect(JSON.stringify(payload)).not.toMatch(/do-not-expose-token|metadata\.example\.cybozu\.com/i);
    } finally {
      jest.restoreAllMocks();
      resetGlobalRequestGate();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("handler closes size overflow in the standard envelope without retry or fallback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ksql-mcp-metadata-size-"));
    const configPath = join(dir, "ksql.config.json");
    writeFileSync(configPath, JSON.stringify({
      defaultProfile: "prod",
      profiles: {
        prod: {
          baseUrl: "https://size.example.cybozu.com",
          tokenMap: { APP12: "size-secret-token" },
          query: { retry: 3, retryBaseDelayMs: 1, retryMaxDelayMs: 1 },
        },
      },
    }), "utf8");
    resetGlobalRequestGate();
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", {
      status: 200,
      headers: { "Content-Length": "2097153" },
    }));
    try {
      const result = await createKsqlMcpTools({ configPath }).appMetadataTool({
        resource: "fields",
        app: 12,
      });
      const payload = result.structuredContent as { ok: false; error: { code: string; message: string } };
      expect(result.isError).toBe(true);
      expect(payload.error.code).toBe("ResponseTooLargeError");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(payload)).not.toMatch(/size-secret-token|size\.example\.cybozu\.com/i);
    } finally {
      jest.restoreAllMocks();
      resetGlobalRequestGate();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("handler does not expose a raw kintone API error body", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ksql-mcp-metadata-api-error-"));
    const configPath = join(dir, "ksql.config.json");
    writeFileSync(configPath, JSON.stringify({
      defaultProfile: "prod",
      profiles: {
        prod: {
          baseUrl: "https://api-error.example.cybozu.com",
          tokenMap: { APP12: "configured-secret-token" },
          query: { retry: 3, retryBaseDelayMs: 1, retryMaxDelayMs: 1 },
        },
      },
    }), "utf8");
    resetGlobalRequestGate();
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      code: "CB_NO02",
      message: "raw secret at https://api-error.example.cybozu.com configured-secret-token",
    }), { status: 403 }));
    try {
      const result = await createKsqlMcpTools({ configPath }).appMetadataTool({
        resource: "fields",
        app: 12,
      });
      const payload = result.structuredContent as { ok: false; error: { code: string; message: string } };
      expect(result.isError).toBe(true);
      expect(payload).toEqual({
        ok: false,
        error: { code: "KintoneApiError", message: "kintone API error 403 (CB_NO02)." },
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(payload)).not.toMatch(/configured-secret-token|api-error\.example\.cybozu\.com|raw secret/i);
    } finally {
      jest.restoreAllMocks();
      resetGlobalRequestGate();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each([
    ["ArgumentError", "unsupported metadata resource"],
    ["AuthError", "token is missing"],
    ["CapabilityError", "requires userpass authentication"],
    ["ResponseTooLargeError", "response exceeds 2097152 bytes"],
    ["KintoneApiError", "kintone API error 403: forbidden"],
  ])("%s is fail-closed in the standard error envelope without fallback or secrets", async (name, message) => {
    const createMetadataRuntime = jest.fn(async () => {
      const error = new Error(`${name}: ${message}`);
      error.name = name;
      throw error;
    });
    const createRuntime = jest.fn();
    const executeSql = jest.fn();
    const executeBatchSql = jest.fn();
    const tools = createKsqlMcpTools({ profile: "prod" }, {
      createMetadataRuntime,
      createRuntime,
      executeSql,
      executeBatchSql,
    });
    const result = await tools.appMetadataTool({ resource: "fields", app: 1234 });
    const payload = result.structuredContent as { ok: false; error: { code: string; message: string } };
    expect(result.isError).toBe(true);
    expect(payload).toEqual({ ok: false, error: { code: name, message: `${name}: ${message}` } });
    expect(JSON.stringify(payload)).not.toMatch(/https?:\/\//i);
    expect(JSON.stringify(payload)).not.toMatch(/authorization|password|secret|x-cybozu-api-token/i);
    expect(createMetadataRuntime).toHaveBeenCalledTimes(1);
    expect(createRuntime).not.toHaveBeenCalled();
    expect(executeSql).not.toHaveBeenCalled();
    expect(executeBatchSql).not.toHaveBeenCalled();
  });
});
