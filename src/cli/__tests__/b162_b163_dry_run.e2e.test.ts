import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runWithArgv } from "../index";

async function runCli(sql: string): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  calls: Record<string, number>;
}> {
  let stdout = "";
  let stderr = "";
  const calls = { records: 0, cursor: 0, metadata: 0, writes: 0 };
  const out = jest.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  });
  const err = jest.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  });
  const fetchMock = jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes("/records/cursor.json")) calls.cursor += 1;
    else if (url.includes("/records.json")) calls.records += 1;
    else calls.metadata += 1;
    if ((init?.method ?? "GET") !== "GET") calls.writes += 1;
    throw new Error("DryRunError: API call should not happen");
  });
  try {
    return {
      code: await runWithArgv(["--config", config, "--dry-run", "-e", sql]),
      stdout,
      stderr,
      calls,
    };
  } finally {
    out.mockRestore();
    err.mockRestore();
    fetchMock.mockRestore();
  }
}

const dir = mkdtempSync(join(tmpdir(), "ksql-b162-b163-dry-run-"));
const config = join(dir, "ksql.config.json");

beforeAll(() => {
  writeFileSync(config, JSON.stringify({
    defaultProfile: "smoke",
    profiles: { smoke: { baseUrl: "http://127.0.0.1:1", tokenMap: { "4229": "dummy" } } },
  }));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("B162 CLI --dry-run は既定値条件付き DATE 13行を全API 0で表示する", async () => {
  const result = await runCli(
    "DECLARE @m_start='2025-08-01'; DECLARE @m_stop='2026-08-01'; " +
      "WITH 月系列 AS (GENERATE_SERIES(@m_start,@m_stop,'1 month') AS 月) SELECT 月 FROM 月系列"
  );
  expect(result.code).toBe(0);
  expect(result.calls).toEqual({ records: 0, cursor: 0, metadata: 0, writes: 0 });
  expect(result.stdout).toContain("series type:   DATE (DECLARE default)");
  expect(result.stdout).toContain("rows:          13 (DECLARE default estimate)");
  expect(result.stdout).toContain("runtime injection may change this plan");
  expect(result.stdout).not.toContain("start:         2025-08-01");
  expect(result.stderr).toBe("");
});

test("B163 CLI --dry-run は resolveMetadata=false でも static schema と group key を全API 0で表示する", async () => {
  const result = await runCli(
    "CREATE TEMP TABLE #t AS " +
      "WITH s AS (GENERATE_SERIES('2025-08-01','2026-08-01','1 month') AS 月) " +
      "SELECT DATE_FORMAT(s.月,'%Y-%m') AS 年月,m.製品名 AS 製品名 FROM s CROSS JOIN APP4229 AS m; " +
      "SELECT 製品名,COUNT(*) AS 月数 FROM #t GROUP BY 製品名"
  );
  expect(result.code).toBe(0);
  expect(result.calls).toEqual({ records: 0, cursor: 0, metadata: 0, writes: 0 });
  expect(result.stdout).toContain("schema:        年月, 製品名");
  expect(result.stdout).toContain("source:        temp table #t (schema from statement 1)");
  expect(result.stdout).toContain("group key 製品名: PHYSICAL (source=0, field=製品名)");
  expect(result.stdout).not.toContain("InternalError");
  expect(result.stderr).toBe("");
});
