// ============================================================
// createKsqlRuntime — tempTableMaxRows 解決チェーンのテスト
//（引数 → env KSQL_TEMP_TABLE_MAX_ROWS → profile.query.tempTableMaxRows → undefined）
// ============================================================

import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createKsqlRuntime } from "../runtime";

const ENV_KEYS = [
  "KSQL_CONFIG",
  "KSQL_BASE_URL",
  "KSQL_TOKEN",
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
