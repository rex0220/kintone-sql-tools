import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { resetGlobalRequestGate } from "../api/requestGate";
import {
  execute,
  type KintoneClient,
  type KintoneFieldInfo,
  type SelectResult,
} from "../execute";
import { runWithArgv } from "../cli";
import { runQuery } from "../engine-library/query";
import {
  createKsqlMcpTools,
  type KsqlMcpToolDependencies,
} from "../mcp/tools";
import type {
  CreateKsqlRuntimeInput,
  KsqlRuntime,
  KsqlRuntimeServerOptions,
} from "../node/runtime";

function makeClient() {
  const queries: string[] = [];
  const client: KintoneClient = {
    async getRecords(params) {
      queries.push(params.query);
      return { records: [] };
    },
    async openCursor() { throw new Error("unexpected cursor"); },
    async postRecords() { return { ids: [] }; },
    async putRecords() { },
    async deleteRecords() { },
    async getApps() { return []; },
    async getFields() {
      return [{ code: "日付", label: "日付", fieldType: "DATE" }];
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const };
    },
  };
  return { client, queries };
}

test("Node library と共有 engine 実行は同じ relative-date REST query を生成する", async () => {
  const sql = "SELECT 日付 FROM APP100 WHERE 日付 = YESTERDAY() LIMIT 1";
  const core = makeClient();
  const library = makeClient();
  await execute(sql, core.client);
  await runQuery(sql, { client: library.client });
  expect(library.queries).toEqual(core.queries);
  expect(core.queries[0]).toContain("日付 = YESTERDAY()");
});

test("CLI/MCP/plugin/Node library は shared engine を import し B67 allowlist を複製しない", () => {
  const surfaces = [
    ["CLI", "src/cli/index.ts", /from "\.\.\/core"/],
    ["MCP", "src/mcp/tools.ts", /from "\.\.\/core"/],
    ["plugin", "src/ui/desktop.ts", /from "\.\.\/core"/],
    ["Node library", "src/engine-library/query.ts", /from "\.\.\/execute"/],
  ] as const;
  for (const [label, path, sharedImport] of surfaces) {
    const source = readFileSync(resolve(process.cwd(), path), "utf8");
    expect(source).toMatch(sharedImport);
    expect(source).toContain("execute");
    expect(source).not.toMatch(/\bYESTERDAY\b|\bFROM_TODAY\b|WHERE_RELATIVE_DATE_FIELD_TYPE_UNSUPPORTED/);
    expect(label).toBeTruthy();
  }
});

const B72_FIELDS: KintoneFieldInfo[] = [
  { code: "日付", label: "日付", fieldType: "DATE" },
  { code: "区分", label: "区分", fieldType: "SINGLE_LINE_TEXT" },
  { code: "子", label: "子", fieldType: "SINGLE_LINE_TEXT", inSubtable: true, subtableCode: "テーブル" },
  { code: "テーブル", label: "テーブル", fieldType: "SUBTABLE" },
];

function makeB72Client() {
  const queries: string[] = [];
  const client: KintoneClient = {
    async getRecords(params) {
      queries.push(params.query);
      return { records: [] };
    },
    async openCursor() { throw new Error("unexpected cursor"); },
    async postRecords() { return { ids: [] }; },
    async putRecords() { },
    async deleteRecords() { },
    async getApps() { return []; },
    async getFields() { return B72_FIELDS; },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const };
    },
  };
  return { client, queries };
}

function mcpTools(client: KintoneClient) {
  const createRuntime: NonNullable<KsqlMcpToolDependencies["createRuntime"]> = async (
    _serverOptions: KsqlRuntimeServerOptions,
    input: CreateKsqlRuntimeInput
  ): Promise<KsqlRuntime> => ({
    sql: input.sql,
    profileName: input.profile ?? "test",
    client,
    cacheContext: "b72-surface",
    maxRecords: input.maxRecords ?? 500,
    fetchParallel: input.fetchParallel ?? 3,
    onLimit: input.onLimit ?? "error",
    timeout: input.timeout ?? 30000,
    cursorMaxActive: input.cursorMaxActive ?? 2,
  });
  return createKsqlMcpTools({ profile: "test" }, { createRuntime });
}

function planText(result: SelectResult): string {
  return result.rows.map((row) => row["plan"]).join("\n");
}

function mcpPlanText(result: Record<string, unknown>): string {
  const rows = result["rows"] as Array<Record<string, unknown>>;
  return rows.map((row) => String(row["plan"])).join("\n");
}

function cliPlanText(stdout: string): string {
  const payload = JSON.parse(stdout) as { rows: Array<Record<string, unknown>> };
  return payload.rows.map((row) => String(row["plan"])).join("\n");
}

const B72_PLAN_FACTS = [
  "relative date evaluation:",
  "where capability:",
  "server predicate:",
  "client residual:",
  "relative date client evaluations:",
  "kintone query:",
] as const;

function surfacePlanFacts(text: string): string[] {
  return B72_PLAN_FACTS.flatMap((label) => {
    const line = text.split(/\r?\n/).find((candidate) => candidate.includes(label));
    return line ? [line.trim()] : [];
  });
}

async function captureCli(
  configPath: string,
  sql: string,
  dryRun: boolean
): Promise<{ code: number; stdout: string; stderr: string; queries: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const queries: string[] = [];
  const fetchMock = jest.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/app/form/fields.json")) {
      return new Response(JSON.stringify({
        properties: {
          日付: { code: "日付", label: "日付", type: "DATE" },
          区分: { code: "区分", label: "区分", type: "SINGLE_LINE_TEXT" },
          テーブル: {
            code: "テーブル",
            label: "テーブル",
            type: "SUBTABLE",
            fields: {
              子: { code: "子", label: "子", type: "SINGLE_LINE_TEXT" },
            },
          },
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/app/status.json")) {
      return new Response(JSON.stringify({ enable: false, states: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/app/settings.json")) {
      return new Response(JSON.stringify({
        numberPrecision: {
          digits: "30",
          decimalPlaces: "10",
          roundingMode: "HALF_EVEN",
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/records.json")) {
      queries.push(new URL(url).searchParams.get("query") ?? "");
      return new Response(JSON.stringify({ records: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ code: "UNEXPECTED_API", message: url }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  });
  jest.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
  jest.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
  try {
    const code = await runWithArgv([
      "--config", configPath,
      "--format", "json",
      ...(dryRun ? ["--dry-run"] : []),
      ...(sql.trimStart().toUpperCase().startsWith("INSERT ") ? ["--allow-dml", "--yes"] : []),
      "-e", sql,
    ]);
    return { code, stdout: stdout.join(""), stderr: stderr.join(""), queries };
  } finally {
    fetchMock.mockRestore();
    jest.restoreAllMocks();
    resetGlobalRequestGate();
  }
}

describe("B72 Step 4 Node/CLI/MCP surface parity", () => {
  const dir = mkdtempSync(join(tmpdir(), "ksql-b72-surfaces-"));
  const configPath = join(dir, "ksql.config.json");

  beforeAll(() => {
    writeFileSync(configPath, JSON.stringify({
      defaultProfile: "test",
      profiles: {
        test: {
          baseUrl: "https://example.cybozu.com",
          tokenMap: { APP100: "fixture-token", APP200: "fixture-token" },
        },
      },
    }));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test.each([
    [
      "GROUP BY",
      "SELECT 区分, COUNT(*) AS c FROM APP100 WHERE 日付 = THIS_MONTH() GROUP BY 区分",
    ],
    [
      "canonical ORDER BY",
      "SELECT 日付 FROM APP100 WHERE 日付 = THIS_MONTH() ORDER BY 日付",
    ],
    [
      "DISTINCT",
      "SELECT DISTINCT 区分 FROM APP100 WHERE 日付 = THIS_MONTH()",
    ],
    [
      "fully-exact OR",
      "SELECT 区分, COUNT(*) AS c FROM APP100 "
        + "WHERE 日付 = THIS_MONTH() OR 日付 = LAST_MONTH() GROUP BY 区分",
    ],
  ])("%s は accept/query/EXPLAIN が3面で一致する", async (_label, sql) => {
    const node = makeB72Client();
    await execute(sql, node.client);
    const nodeExplain = planText(await execute(`EXPLAIN ${sql}`, node.client) as SelectResult);

    const mcp = makeB72Client();
    const tools = mcpTools(mcp.client);
    const mcpResult = await tools.query({ sql });
    const mcpExplain = mcpPlanText(await tools.explain({ sql }));

    const cli = await captureCli(configPath, sql, false);
    const cliExplain = await captureCli(configPath, sql, true);

    expect(mcpResult["ok"]).toBe(true);
    expect(cli.code).toBe(0);
    expect(cliExplain.code).toBe(0);
    expect(node.queries).toHaveLength(1);
    expect(mcp.queries).toEqual(node.queries);
    expect(cli.queries).toEqual(node.queries);
    expect(surfacePlanFacts(mcpExplain)).toEqual(surfacePlanFacts(nodeExplain));
    expect(surfacePlanFacts(cliPlanText(cliExplain.stdout))).toEqual(surfacePlanFacts(nodeExplain));
  });

  test.each([
    [
      "KORDER BY",
      "SELECT COUNT(*) AS c FROM APP100 WHERE 日付 = THIS_MONTH() KORDER BY $id LIMIT 10",
    ],
    [
      "INSERT SELECT source",
      "INSERT INTO APP200 (区分) SELECT 区分 FROM APP100 "
        + "WHERE 日付 = THIS_MONTH() GROUP BY 区分",
    ],
    [
      "JOIN",
      "SELECT a.区分, COUNT(*) AS c FROM APP100 a JOIN APP200 b ON a.$id = b.$id "
        + "WHERE a.日付 = THIS_MONTH() GROUP BY a.区分",
    ],
    ["VALIDATE", "VALIDATE APP100 WHERE 日付 = THIS_MONTH()"],
    [
      "subtable",
      "SELECT 子, COUNT(*) AS c FROM APP100$テーブル "
        + "WHERE 日付 = THIS_MONTH() GROUP BY 子",
    ],
    [
      "materialized CTE",
      "WITH c AS (SELECT 区分, COUNT(*) AS c FROM APP100 "
        + "WHERE 日付 = THIS_MONTH() GROUP BY 区分) SELECT * FROM c",
    ],
  ])("%s は reject/reason/records API 0 が3面で一致する", async (_label, sql) => {
    const node = makeB72Client();
    const nodeExplain = planText(await execute(`EXPLAIN ${sql}`, node.client) as SelectResult);

    const mcp = makeB72Client();
    const mcpExplain = mcpPlanText(await mcpTools(mcp.client).explain({ sql }));
    const cliExplain = await captureCli(configPath, sql, true);

    expect(nodeExplain).toContain("WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN");
    expect(mcpExplain).toContain("WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN");
    expect(cliExplain.stdout).toContain("WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN");
    expect(cliExplain.code).toBe(0);
    expect(node.queries).toEqual([]);
    expect(mcp.queries).toEqual([]);
    expect(cliExplain.queries).toEqual([]);
  });
});
