// ============================================================
// createKsqlRuntime — tempTableMaxRows 解決チェーンのテスト
//（引数 → env KSQL_TEMP_TABLE_MAX_ROWS → profile.query.tempTableMaxRows → undefined）
// ============================================================

import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createKsqlRuntime,
  resolveSqlContext,
  resolveTokenByMappedApp,
} from "../runtime";

const ENV_KEYS = [
  "KSQL_CONFIG",
  "KSQL_BASE_URL",
  "KSQL_TOKEN",
  "KSQL_TOKEN_MAP",
  "KSQL_AUTH",
  "KSQL_USERNAME",
  "KSQL_PASSWORD",
  "KSQL_TEMP_TABLE_MAX_ROWS",
  "KSQL_MAX_RECORDS",
  "KSQL_PROFILE",
] as const;

describe("createKsqlRuntime: tempTableMaxRows resolution", () => {
  let tempDir: string;
  let configPath: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    tempDir = mkdtempSync(join(tmpdir(), "ksql-runtime-test-"));
    configPath = join(tempDir, "ksql.config.json");
    process.env.KSQL_BASE_URL = "https://example.cybozu.com";
    process.env.KSQL_TOKEN = "dummy-token";
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  function writeConfig(query: Record<string, unknown> = {}): void {
    writeFileSync(
      configPath,
      JSON.stringify({ defaultProfile: "dev", profiles: { dev: { query } } }),
      "utf-8"
    );
  }

  async function resolve(input: { tempTableMaxRows?: number } = {}): Promise<number | undefined> {
    const runtime = await createKsqlRuntime(
      { configPath },
      { sql: "SELECT 1", ...input }
    );
    return runtime.tempTableMaxRows;
  }

  test("未指定なら undefined（エンジン既定 TEMP_TABLE_MAX_ROWS に委ねる）", async () => {
    writeConfig();
    await expect(resolve()).resolves.toBeUndefined();
  });

  test("入力引数が最優先", async () => {
    writeConfig({ tempTableMaxRows: 30000 });
    process.env.KSQL_TEMP_TABLE_MAX_ROWS = "20000";
    await expect(resolve({ tempTableMaxRows: 50000 })).resolves.toBe(50000);
  });

  test("引数なしなら env KSQL_TEMP_TABLE_MAX_ROWS", async () => {
    writeConfig({ tempTableMaxRows: 30000 });
    process.env.KSQL_TEMP_TABLE_MAX_ROWS = "20000";
    await expect(resolve()).resolves.toBe(20000);
  });

  test("env が不正値（非数値・0・負数）なら無視して profile へフォールスルー", async () => {
    writeConfig({ tempTableMaxRows: 30000 });
    for (const invalid of ["abc", "0", "-1", "1.5"]) {
      process.env.KSQL_TEMP_TABLE_MAX_ROWS = invalid;
      await expect(resolve()).resolves.toBe(30000);
    }
  });

  test("profile の query.tempTableMaxRows が最後のフォールバック", async () => {
    writeConfig({ tempTableMaxRows: 30000 });
    await expect(resolve()).resolves.toBe(30000);
  });
});

describe("createKsqlRuntime: コメント内 APPxxx は token 要求に混入しない（P5 回帰）", () => {
  let tempDir: string;
  let configPath: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    tempDir = mkdtempSync(join(tmpdir(), "ksql-runtime-p5-"));
    configPath = join(tempDir, "ksql.config.json");
    process.env.KSQL_BASE_URL = "https://example.cybozu.com";
    // 単一トークンフォールバックに逃げないよう KSQL_TOKEN は設定しない
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  // dev profile は APP4205 のトークンのみを持つ
  function writeConfigWithToken(): void {
    writeFileSync(
      configPath,
      JSON.stringify({
        defaultProfile: "dev",
        profiles: { dev: { tokenMap: { APP4205: "tok-4205" } } },
      }),
      "utf-8"
    );
  }

  test("コメント内の APP4206 を含んでも AuthError にならず構築できる", async () => {
    writeConfigWithToken();
    await expect(
      createKsqlRuntime(
        { configPath },
        { sql: "-- 通知(APP4206)\nSELECT COUNT(*) FROM APP4205" }
      )
    ).resolves.toBeDefined();
  });

  test("本文で参照する APP4206 のトークンが無ければ従来どおり AuthError", async () => {
    writeConfigWithToken();
    await expect(
      createKsqlRuntime(
        { configPath },
        { sql: "SELECT COUNT(*) FROM APP4205 JOIN APP4206 ON 1=1" }
      )
    ).rejects.toThrow(/token is missing/);
  });
});

describe("createKsqlRuntime: baseline auth/config flows", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.KSQL_BASE_URL = "https://example.cybozu.com";
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  test("config 未設定でも env の single token で構築できる", async () => {
    process.env.KSQL_TOKEN = "single-token";
    await expect(
      createKsqlRuntime(
        { configPath: join(tmpdir(), "ksql-config-that-does-not-exist.json") },
        { sql: "SELECT * FROM APP4205" }
      )
    ).resolves.toMatchObject({ profileName: "dev" });
  });

  test("env の userpass 認証で構築できる", async () => {
    process.env.KSQL_AUTH = "userpass";
    process.env.KSQL_USERNAME = "user1";
    process.env.KSQL_PASSWORD = "pass1";
    await expect(
      createKsqlRuntime(
        { configPath: join(tmpdir(), "ksql-config-that-does-not-exist.json") },
        { sql: "SELECT * FROM APP4205" }
      )
    ).resolves.toMatchObject({ profileName: "dev" });
  });
});

describe("logical app runtime context and token routing", () => {
  let tempDir: string;
  let configPath: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    tempDir = mkdtempSync(join(tmpdir(), "ksql-logical-runtime-"));
    configPath = join(tempDir, "ksql.config.json");
  });

  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  function writeLogicalConfig(tokenMap: Record<string, string> = { APP1234: "snapshot-token" }): void {
    writeFileSync(configPath, JSON.stringify({
      defaultProfile: "prod",
      profiles: {
        prod: {
          baseUrl: "https://example.cybozu.com",
          logicalApps: { ORDERS: 1234 },
          tokenMap,
        },
      },
    }));
  }

  test("LAPP を解決し source-aware cacheContext を生成する", () => {
    writeLogicalConfig();
    const context = resolveSqlContext({ configPath }, "SELECT * FROM LAPP_ORDERS", "prod");
    const [binding] = [...context.bindings.values()];
    expect(context.normalizedSql).toBe(`SELECT * FROM APP${binding.mappedAppId}`);
    expect(context.cacheContext).toContain(`logical:ORDERS:APP1234@prod`);
    expect(context.logicalBindingLabels.get(binding.mappedAppId)).toBe("LAPP_ORDERS@prod");
  });

  test("ResolvedSqlContext の列挙値に token/password を露出しない", () => {
    writeLogicalConfig();
    const context = resolveSqlContext({ configPath }, "SELECT * FROM LAPP_ORDERS", "prod");
    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain("snapshot-token");
    expect(serialized).not.toContain("password");
    expect(serialized).toContain('"APP1234":"inline"');
  });

  test("validate 後に config を差し替えても runtime は同一 snapshot を使う", async () => {
    writeLogicalConfig();
    const context = resolveSqlContext({ configPath }, "SELECT * FROM LAPP_ORDERS", "prod");
    writeFileSync(configPath, JSON.stringify({ defaultProfile: "prod", profiles: { prod: {} } }));

    await expect(createKsqlRuntime(
      { configPath },
      { sql: "SELECT * FROM LAPP_ORDERS", profile: "prod", sqlContext: context }
    )).resolves.toMatchObject({ sql: context.normalizedSql, cacheContext: context.cacheContext });
  });

  test("logical source はsingle-token fallbackを使わない", async () => {
    writeLogicalConfig({});
    process.env.KSQL_TOKEN = "single-token-must-not-be-used";
    await expect(createKsqlRuntime(
      { configPath },
      { sql: "SELECT * FROM LAPP_ORDERS", profile: "prod" }
    )).rejects.toThrow(/token is missing for LAPP_ORDERS \(APP1234\)@prod/);
  });

  test("logical binding 欠落時は物理ID fallbackせず元の論理名で停止する", () => {
    expect(() => resolveTokenByMappedApp({
      mappedAppIds: [900_000_000],
      profileName: "prod",
      bindings: new Map(),
      logicalBindingLabels: new Map([[900_000_000, "LAPP_ORDERS@prod"]]),
      effectiveTokenMap: { APP900000000: "wrong-token" },
      singleToken: "wrong-fallback",
    })).toThrow("InternalError: binding is missing for logical app LAPP_ORDERS@prod.");
  });

  test("logical routing は実 API 直前に physical app ID とその token を使う", async () => {
    writeLogicalConfig();
    const fetchMock = jest.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ records: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const context = resolveSqlContext({ configPath }, "SELECT * FROM LAPP_ORDERS", "prod");
    const [binding] = [...context.bindings.values()];
    const runtime = await createKsqlRuntime(
      { configPath },
      { sql: "SELECT * FROM LAPP_ORDERS", profile: "prod", sqlContext: context }
    );

    await runtime.client.getRecords({ app: binding.mappedAppId, query: "", fields: [] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("app=1234");
    expect(new Headers(init?.headers).get("X-Cybozu-API-Token")).toBe("snapshot-token");
  });

  test("logical status routing は physical app ID と lang=user を使い states.name を返す", async () => {
    writeLogicalConfig();
    const fetchMock = jest.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({
        enable: true,
        states: { internal: { name: "In Progress", index: "10" } },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const context = resolveSqlContext({ configPath }, "SELECT * FROM LAPP_ORDERS", "prod");
    const [binding] = [...context.bindings.values()];
    const runtime = await createKsqlRuntime(
      { configPath },
      { sql: "SELECT * FROM LAPP_ORDERS", profile: "prod", sqlContext: context }
    );

    await expect(runtime.client.getProcessStatuses(binding.mappedAppId)).resolves.toEqual({
      enable: true,
      states: [{ name: "In Progress", index: 10 }],
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("app/status.json?app=1234&lang=user");
    expect(new Headers(init?.headers).get("X-Cybozu-API-Token")).toBe("snapshot-token");
  });

  test("logical numberPrecision routing は physical app ID とそのtokenを使う", async () => {
    writeLogicalConfig();
    const fetchMock = jest.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({
        numberPrecision: { digits: "16", decimalPlaces: "4", roundingMode: "HALF_EVEN" },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const context = resolveSqlContext({ configPath }, "SELECT * FROM LAPP_ORDERS", "prod");
    const [binding] = [...context.bindings.values()];
    const runtime = await createKsqlRuntime(
      { configPath },
      { sql: "SELECT * FROM LAPP_ORDERS", profile: "prod", sqlContext: context }
    );

    await expect(runtime.client.getNumberPrecision(binding.mappedAppId)).resolves.toEqual({
      digits: 16, decimalPlaces: 4, roundingMode: "HALF_EVEN",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("app/settings.json?app=1234");
    expect(new Headers(init?.headers).get("X-Cybozu-API-Token")).toBe("snapshot-token");
  });

  test("status.json の states=null は enable=false の残存statesと区別して保持する", async () => {
    writeLogicalConfig();
    jest.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ enable: false, states: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const context = resolveSqlContext({ configPath }, "SELECT * FROM LAPP_ORDERS", "prod");
    const [binding] = [...context.bindings.values()];
    const runtime = await createKsqlRuntime(
      { configPath },
      { sql: "SELECT * FROM LAPP_ORDERS", profile: "prod", sqlContext: context }
    );
    await expect(runtime.client.getProcessStatuses(binding.mappedAppId)).resolves.toEqual({
      enable: false,
      states: null,
    });
  });

  test("multi-profile physical routing も実 API 直前に profileごとの physical token を使う", async () => {
    writeFileSync(configPath, JSON.stringify({
      defaultProfile: "dev",
      profiles: {
        dev: { baseUrl: "https://dev.example.cybozu.com", tokenMap: { APP88: "dev-token" } },
        prod: { baseUrl: "https://prod.example.cybozu.com", tokenMap: { APP88: "prod-token" } },
      },
    }));
    const fetchMock = jest.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ records: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const context = resolveSqlContext(
      { configPath },
      "SELECT * FROM APP88@dev d JOIN APP88@prod p ON 1=1",
      "dev"
    );
    const runtime = await createKsqlRuntime(
      { configPath },
      { sql: "SELECT * FROM APP88@dev d JOIN APP88@prod p ON 1=1", profile: "dev", sqlContext: context }
    );

    for (const binding of context.bindings.values()) {
      await runtime.client.getRecords({ app: binding.mappedAppId, query: "", fields: [] });
    }

    const calls = fetchMock.mock.calls.map(([url, init]) => ({
      url: String(url),
      token: new Headers(init?.headers).get("X-Cybozu-API-Token"),
    }));
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: expect.stringContaining("https://dev.example.cybozu.com"), token: "dev-token" }),
      expect.objectContaining({ url: expect.stringContaining("https://prod.example.cybozu.com"), token: "prod-token" }),
    ]));
    expect(calls.every((call) => call.url.includes("app=88"))).toBe(true);
  });
});
