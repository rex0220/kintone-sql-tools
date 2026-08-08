import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runWithArgv } from "../index";

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const out = jest.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  });
  const err = jest.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  });
  try {
    return { code: await runWithArgv(args), stdout, stderr };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

async function runCountingApis(args: string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  calls: Record<string, number>;
}> {
  const calls = { records: 0, cursor: 0, fields: 0, apps: 0, writes: 0 };
  const fetchMock = jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("/records/cursor.json")) calls.cursor += 1;
    else if (url.includes("/records.json")) calls.records += 1;
    if (url.includes("/app/form/fields.json")) calls.fields += 1;
    if (url.includes("/apps.json") || url.includes("/app.json")) calls.apps += 1;
    if (method !== "GET") calls.writes += 1;
    throw new Error("DryRunError: API call should not happen in dry-run.");
  });
  try {
    return { ...(await runCli(args)), calls };
  } finally {
    fetchMock.mockRestore();
  }
}

describe("B159 CLI --dry-run API 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "ksql-b159-dry-run-"));
  const config = join(dir, "ksql.config.json");

  beforeAll(() => {
    writeFileSync(config, JSON.stringify({
      defaultProfile: "smoke",
      profiles: { smoke: { baseUrl: "http://127.0.0.1:1", tokenMap: {} } },
    }));
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("正常な month/year は計画を表示し全 API 0", async () => {
    for (const [sql, normalizedStep] of [
      ["WITH m AS (GENERATE_SERIES('2025-08-01','2026-08-01','1 months') AS 月) SELECT 月 FROM m", "1 month"],
      ["WITH y AS (GENERATE_SERIES('2022-01-01','2026-12-31','+2 year') AS 年) SELECT 年 FROM y", "2 years"],
    ]) {
      const result = await runCountingApis(["--config", config, "--dry-run", "-e", sql]);
      expect(result.code).toBe(0);
      expect(result.calls).toEqual({ records: 0, cursor: 0, fields: 0, apps: 0, writes: 0 });
      expect(result.stdout).toContain("series type:   DATE");
      expect(result.stdout).toContain(`step:          ${normalizedStep}`);
      expect(result.stdout).toContain("records API:   none");
      expect(result.stderr).not.toContain("DryRunError");
    }
  });

  test.each([
    ["step 0", "WITH m AS (GENERATE_SERIES('2025-08-01','2026-08-01','0 month') AS 月) SELECT 月 FROM m", "0 month は指定できません"],
    ["非アンカー", "WITH m AS (GENERATE_SERIES('2025-08-15','2026-08-01','1 month') AS 月) SELECT 月 FROM m", "start に月初"],
    ["上限超過", "WITH m AS (GENERATE_SERIES('1000-01-01','1833-05-01','1 month') AS 月) SELECT 月 FROM m", "生成件数 10001 行"],
  ])("%s も全 API 0で拒否する", async (_name, sql, errorText) => {
    const result = await runCountingApis(["--config", config, "--dry-run", "-e", sql]);
    expect(result.code).toBe(1);
    expect(result.calls).toEqual({ records: 0, cursor: 0, fields: 0, apps: 0, writes: 0 });
    expect(result.stderr).toContain(errorText);
    expect(result.stderr).not.toContain("DryRunError");
  });
});
