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

type ApiCounts = {
  fields: number;
  status: number;
  process: number;
  settings: number;
  records: number;
};

async function runCliCountingApis(
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string; apiCounts: ApiCounts }> {
  const apiCounts: ApiCounts = { fields: 0, status: 0, process: 0, settings: 0, records: 0 };
  const fetchMock = jest.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/app/form/fields.json")) apiCounts.fields += 1;
    if (url.includes("/app/status.json")) apiCounts.status += 1;
    if (url.includes("/record/status.json") || url.includes("/records/status.json")) apiCounts.process += 1;
    if (url.includes("/app/settings.json")) apiCounts.settings += 1;
    if (url.includes("/records.json") || url.includes("/records/cursor.json")) apiCounts.records += 1;
    throw new Error("DryRunError: API call should not happen in dry-run.");
  });
  try {
    return { ...(await runCli(args)), apiCounts };
  } finally {
    fetchMock.mockRestore();
  }
}

function statementPlan(stdout: string, index: number, type: string): string {
  const marker = `[${index}] ${type}\n`;
  const start = stdout.indexOf(marker);
  if (start < 0) return "";
  const body = stdout.slice(start + marker.length);
  const next = body.search(/\n\n\[\d+\] /);
  return (next < 0 ? body : body.slice(0, next)).trimEnd();
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
日付系列 AS (
  GENERATE_SERIES('2025-08-01', '2026-07-31', '1 day') AS 日付
),
製品マスタ AS (
  SELECT 製品名
  FROM APP4229
),
日次実績 AS (
  SELECT
    日付,
    製品名,
    CONCAT(日付, '|', 製品名) AS 格子キー,
    SUM(個数_在庫計算用) AS 日次増減
  FROM APP4228
  GROUP BY 日付, 製品名
),
格子 AS (
  SELECT
    d.日付,
    m.製品名,
    CONCAT(d.日付, '|', m.製品名) AS 格子キー
  FROM 日付系列 AS d
  CROSS JOIN 製品マスタ AS m
),
0埋め AS (
  SELECT
    g.日付,
    g.製品名,
    CASE
      WHEN f.日次増減 = '' THEN 0
      ELSE f.日次増減
    END AS 日次増減
  FROM 格子 AS g
  LEFT JOIN 日次実績 AS f ON g.格子キー = f.格子キー
)
SELECT
  日付,
  製品名,
  日次増減,
  SUM(日次増減) OVER (
    PARTITION BY 製品名
    ORDER BY 日付
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  ) AS 暦日在庫
FROM 0埋め
ORDER BY 製品名, 日付`;

  test("R17 逐語 SQL の単文・複文は全 API 0 で同じ計画を表示する", async () => {
    const single = await runCliCountingApis(["--config", config, "--dry-run", "-e", sql]);
    const batch = await runCliCountingApis(["--config", config, "--dry-run", "-e", `SELECT 1 AS x; ${sql}`]);

    for (const result of [single, batch]) {
      expect(result.apiCounts).toEqual({ fields: 0, status: 0, process: 0, settings: 0, records: 0 });
      expect(result.code).toBe(0);
      expect(result.stderr).not.toContain("DryRunError");
      expect(result.stdout).toContain("cross join:    d × m");
      expect(result.stdout).toContain("left rows:     365");
      expect(result.stdout).toContain("right rows:    runtime");
      expect(result.stdout).toContain("row guard:     runtime checked / 10000");
      expect(result.stdout).toContain("records API:   none");
      expect(result.stdout).not.toContain("join key prefilter:");
    }
    expect(statementPlan(batch.stdout, 2, "WITH")).toBe(statementPlan(single.stdout, 1, "WITH"));
  });
});
