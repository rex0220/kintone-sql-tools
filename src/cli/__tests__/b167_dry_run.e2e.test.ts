import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runWithArgv } from "../index";

const dir = mkdtempSync(join(tmpdir(), "ksql-b167-dry-run-"));
const config = join(dir, "ksql.config.json");

beforeAll(() => {
  writeFileSync(config, JSON.stringify({
    defaultProfile: "smoke",
    profiles: {
      smoke: {
        baseUrl: "https://example.invalid",
        tokenMap: { "4228": "dummy", "4229": "dummy" },
      },
    },
  }));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function runCli(sql: string): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  apiApps: number[];
  recordCalls: number;
}> {
  let stdout = "";
  let stderr = "";
  let recordCalls = 0;
  const apiApps: number[] = [];
  const out = jest.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  });
  const err = jest.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  });
  const fetchMock = jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as { app?: number } : {};
    const rawApp = url.searchParams.get("app") ?? body.app;
    if (rawApp !== undefined && rawApp !== null) {
      const app = Number(rawApp);
      apiApps.push(app);
      if (app <= 0) throw new Error(`B167: app must be positive, got ${app}`);
    }
    if (url.pathname.endsWith("/records.json") || url.pathname.endsWith("/records/cursor.json")) {
      recordCalls += 1;
      throw new Error("records API must not be called by --dry-run");
    }
    if (url.pathname.endsWith("/app/form/fields.json")) {
      return new Response(JSON.stringify({
        properties: {
          製品名: { code: "製品名", label: "製品名", type: "SINGLE_LINE_TEXT" },
          個数_在庫計算用: { code: "個数_在庫計算用", label: "個数_在庫計算用", type: "NUMBER" },
          在庫数: { code: "在庫数", label: "在庫数", type: "NUMBER" },
          仕入価格: { code: "仕入価格", label: "仕入価格", type: "NUMBER" },
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`unexpected API call: ${url.pathname}`);
  });
  try {
    const code = await runWithArgv(["--config", config, "--dry-run", "-e", sql]);
    return { code, stdout, stderr, apiApps, recordCalls };
  } finally {
    out.mockRestore();
    err.mockRestore();
    fetchMock.mockRestore();
  }
}

const CREATE = "CREATE TEMP TABLE #z AS "
  + "SELECT 製品名, SUM(個数_在庫計算用) AS 在庫数 FROM APP4228 GROUP BY 製品名";
const SELECT = "SELECT SUM(z.在庫数 * m.仕入価格) AS メイン値 "
  + "FROM APP4229 m INNER JOIN #z z ON m.製品名 = z.製品名";

test.each([
  ["起票の batch", `${CREATE}; ${SELECT}`, "SELECT"],
  ["UNION ALL 付き batch", `${CREATE}; ${SELECT} UNION ALL SELECT 0 AS メイン値`, "UNION"],
])("B167 CLI --dry-run: %s は成功し app<=0 API 呼び出し 0 回", async (_name, sql, type) => {
  const result = await runCli(sql);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain(`[2] ${type}`);
  expect(result.apiApps.filter((app) => app <= 0)).toEqual([]);
  expect(result.recordCalls).toBe(0);
});
