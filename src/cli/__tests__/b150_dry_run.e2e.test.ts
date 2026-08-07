import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer, type Server } from "http";
import { runWithArgv } from "../index";

jest.setTimeout(20000);

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const stdoutWrite = jest.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  });
  const stderrWrite = jest.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  });
  try {
    return { code: await runWithArgv(args), stdout, stderr };
  } finally {
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
  }
}

describe("B150 CLI --dry-run CTE -> APP JOIN", () => {
  let server: Server;
  let configDir: string;
  let configPath: string;
  const recordRequests: string[] = [];
  const fieldRequests: string[] = [];
  const apiRequests: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      apiRequests.push(req.url ?? "");
      res.setHeader("Content-Type", "application/json");
      if (req.url?.includes("/app/form/fields.json")) {
        fieldRequests.push(req.url);
        res.end(JSON.stringify({
          properties: {
            キー: { code: "キー", label: "キー", type: "SINGLE_LINE_TEXT" },
            日付: { code: "日付", label: "日付", type: "DATE" },
            メモ: { code: "メモ", label: "メモ", type: "MULTI_LINE_TEXT" },
          },
        }));
        return;
      }
      if (req.url?.includes("/app/status.json")) {
        res.end(JSON.stringify({ enable: false, states: {} }));
        return;
      }
      if (req.url?.includes("/app/settings.json")) {
        res.end(JSON.stringify({
          numberPrecision: { digits: "30", decimalPlaces: "10", roundingMode: "HALF_EVEN" },
        }));
        return;
      }
      if (req.url?.includes("/records.json")) {
        recordRequests.push(req.url);
        res.statusCode = 500;
        res.end(JSON.stringify({ code: "RECORDS_API_MUST_NOT_BE_CALLED" }));
        return;
      }
      res.statusCode = 500;
      res.end(JSON.stringify({ code: "UNEXPECTED_API", message: req.url }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("fixture server has no TCP port");
    configDir = mkdtempSync(join(tmpdir(), "ksql-b150-cli-dry-run-"));
    configPath = join(configDir, "ksql.config.json");
    writeFileSync(configPath, JSON.stringify({
      defaultProfile: "smoke",
      profiles: {
        smoke: {
          baseUrl: `http://127.0.0.1:${address.port}`,
          tokenMap: { APP4228: "fixture-token" },
        },
      },
    }));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(configDir, { recursive: true, force: true });
  });

  test("修正依頼2の GENERATE_SERIES 日付範囲経路が計画を表示する", async () => {
    const sql = "WITH s AS (GENERATE_SERIES('2025-08-04','2025-08-06') AS 日付) "
      + "SELECT s.日付 FROM s INNER JOIN APP4228 AS t ON s.日付 = t.日付";
    const result = await runCli(["--config", configPath, "--dry-run", "-e", sql]);
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain("DryRunError");
    expect(result.stdout).toContain("join key prefilter: range");
    expect(fieldRequests.length).toBeGreaterThan(0);
    expect(recordRequests).toEqual([]);
  });

  test.each([
    [
      "in",
      "WITH s AS (SELECT '食パン' AS k) SELECT s.k FROM s INNER JOIN APP4228 AS t ON s.k = t.キー",
      "join key prefilter reason: JOIN_KEY_VALUES_RUNTIME",
    ],
    [
      "range",
      "WITH s AS (SELECT '2025-08-04' AS 日付) SELECT s.日付 FROM s INNER JOIN APP4228 AS t ON s.日付 = t.日付",
      "join key prefilter reason: JOIN_KEY_VALUES_RUNTIME",
    ],
    [
      "fallback",
      "WITH s AS (SELECT '食パン' AS k) SELECT s.k FROM s INNER JOIN APP4228 AS t ON s.k = t.メモ",
      "join key prefilter reason: JOIN_KEY_OPERATOR_UNAVAILABLE",
    ],
  ] as const)("%s 経路は実行計画を表示し records API を呼ばない", async (_kind, sql, expected) => {
    const result = await runCli(["--config", configPath, "--dry-run", "-e", sql]);
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain("DryRunError");
    expect(result.stdout).toContain(expected);
    expect(recordRequests).toEqual([]);
  });

  test("B155 CTE→APP＋WHERE候補はAPI 0回でexit 0になる", async () => {
    const sql = `WITH s AS (
  GENERATE_SERIES('2026-07-29', '2026-08-04') AS 日付
)
SELECT s.日付, t.$id, t.製品名, t.個数
FROM s
INNER JOIN APP4228 AS t ON s.日付 = t.日付
WHERE t.製品名 = '牛乳'
  AND t.個数 <= 100
  AND t.入出庫区分 = '出庫'
ORDER BY s.日付, t.$id`;
    const before = apiRequests.length;
    const result = await runCli(["--config", configPath, "--dry-run", "-e", sql]);
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain("DryRunError");
    expect(result.stdout).toContain("join key prefilter: runtime candidate");
    expect(result.stdout).toContain(
      'pushdown candidate: (製品名 = "牛乳" and 個数 <= 100) and 入出庫区分 = "出庫"'
    );
    expect(result.stdout).toContain("実行時の型・実在確認待ち");
    expect(apiRequests).toHaveLength(before);
  });
});
