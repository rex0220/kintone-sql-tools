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

describe("B158 CLI --dry-run API 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "ksql-b158-dry-run-"));
  const config = join(dir, "ksql.config.json");

  beforeAll(() => {
    writeFileSync(config, JSON.stringify({
      defaultProfile: "smoke",
      profiles: {
        smoke: {
          baseUrl: "http://127.0.0.1:1",
          tokenMap: { APP4229: "must-not-be-used" },
        },
      },
    }));
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const sql = `WITH
d AS (
  GENERATE_SERIES('2026-08-01', '2026-08-07') AS 日付
),
m AS (
  SELECT 製品名 FROM APP4229
)
SELECT d.日付, m.製品名
FROM d
CROSS JOIN m
ORDER BY d.日付, m.製品名`;

  test.each([
    ["単文", sql],
    ["複文", `SELECT 1 AS x; ${sql}`],
  ])("%sは API に到達せず計画を表示する", async (_label, input) => {
    const result = await runCli(["--config", config, "--dry-run", "-e", input]);
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain("DryRunError");
    expect(result.stderr).not.toContain("ECONNREFUSED");
    expect(result.stdout).toContain("cross join:    d × m");
    expect(result.stdout).toContain("left rows:     7");
    expect(result.stdout).toContain("right rows:    runtime");
    expect(result.stdout).toContain("row guard:     runtime checked / 10000");
    expect(result.stdout).toContain("records API:   none");
    expect(result.stdout).not.toContain("join key prefilter:");
  });
});
