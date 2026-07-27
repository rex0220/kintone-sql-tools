import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { resetGlobalRequestGate } from "../api/requestGate";
import {
  buildBatchExplainPlans,
  execute,
  executeBatch,
  type KintoneClient,
  type KintoneFieldInfo,
  type SelectResult,
} from "../execute";
import { runWithArgv } from "../cli";
import { explainQuery, runQuery } from "../engine-library/query";
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
  { code: "日時", label: "日時", fieldType: "DATETIME" },
  { code: "区分", label: "区分", fieldType: "SINGLE_LINE_TEXT" },
  { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
  { code: "作成者", label: "作成者", fieldType: "CREATOR" },
  { code: "グループ", label: "グループ", fieldType: "GROUP_SELECT" },
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

function batchPlanText(result: {
  statements: Array<{ plan?: string[] }>;
}): string {
  return result.statements.flatMap((statement) => statement.plan ?? []).join("\n");
}

function rejectionDiagnostic(text: string): string {
  return text.split(/\r?\n/).find((line) =>
    line.includes("WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN")
  )?.trim() ?? "";
}

function reasonPath(text: string): { reason: string; path: string } {
  return {
    reason: text.match(/WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN/)?.[0] ?? "",
    path: text.match(/path=([A-Za-z0-9_.[\]-]+)/)?.[1] ?? "",
  };
}

const B72_PLAN_FACTS = [
  "relative date evaluation:",
  "kintone function:",
  "kintone function evaluation:",
  "where capability:",
  "server predicate:",
  "client residual:",
  "client evaluation:",
  "relative date client evaluations:",
  "kintone function client evaluations:",
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
          日時: { code: "日時", label: "日時", type: "DATETIME" },
          区分: { code: "区分", label: "区分", type: "SINGLE_LINE_TEXT" },
          件名: { code: "件名", label: "件名", type: "SINGLE_LINE_TEXT" },
          作成者: { code: "作成者", label: "作成者", type: "CREATOR" },
          グループ: { code: "グループ", label: "グループ", type: "GROUP_SELECT" },
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

describe("B75+B77+B78+B76 plugin/CLI/MCP/engine-library surface parity", () => {
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
    [
      "materialized CTE",
      "WITH c AS (SELECT 区分, COUNT(*) AS c FROM APP100 "
        + "WHERE 日付 = THIS_MONTH() GROUP BY 区分) SELECT * FROM c",
    ],
    [
      "SIMPLE CTE",
      "WITH c AS (SELECT 日付 FROM APP100 WHERE 日付 = YESTERDAY()) SELECT * FROM c",
    ],
    [
      "TODAY Phase2 prefilter",
      "SELECT 日付, 件名 FROM APP100 "
        + "WHERE 日付 = TODAY() AND LENGTH(件名) > 1",
    ],
    [
      "LOGINUSER singleton IN",
      "SELECT 作成者 FROM APP100 WHERE 作成者 IN (LOGINUSER())",
    ],
    [
      "TODAY whole-WHERE exact KORDER native",
      "SELECT 日付 FROM APP100 WHERE 日付 = TODAY() KORDER BY 日付 LIMIT 5",
    ],
    [
      "B76 JOIN exact leaf",
      "SELECT a.区分, COUNT(*) AS c FROM APP100 a JOIN APP200 b ON a.$id = b.$id "
        + "WHERE a.日付 = THIS_MONTH() GROUP BY a.区分",
    ],
    [
      "B76 JOIN mixed function sets",
      "SELECT a.日付 FROM APP100 a JOIN APP200 b ON a.$id = b.$id "
        + "WHERE a.日付 = THIS_MONTH() AND b.作成者 IN (LOGINUSER())",
    ],
    [
      "B76 第5-W same-alias OR",
      "SELECT a.日付 FROM APP100 a JOIN APP200 b ON a.$id = b.$id "
        + "WHERE a.日付 = THIS_MONTH() OR a.日付 = LAST_MONTH()",
    ],
    [
      "B76 第5-W KLIKE coexistence",
      "SELECT a.日付 FROM APP100 a JOIN APP200 b ON a.$id = b.$id "
        + "WHERE a.日付 = THIS_MONTH() OR a.件名 KLIKE 'urgent'",
    ],
    [
      "B76 第5-L multiple aliases and residual",
      "SELECT a.日付 FROM APP100 a JOIN APP200 b ON a.$id = b.$id "
        + "WHERE a.日付 = THIS_MONTH() AND b.作成者 IN (LOGINUSER()) "
        + "AND LENGTH(a.件名) > 1",
    ],
  ])("%s は accept/query/EXPLAIN が4面で一致する", async (_label, sql) => {
    // plugin は desktop.ts から同じ execute を直接 import するため、ここでは共有 engine 呼出しを
    // plugin surface の実行プロキシとして使う。共有 import 自体は上の静的 parity test で固定する。
    const plugin = makeB72Client();
    await execute(sql, plugin.client);
    const pluginExplain = planText(await execute(`EXPLAIN ${sql}`, plugin.client) as SelectResult);

    const library = makeB72Client();
    await runQuery(sql, { client: library.client });
    const libraryExplain = (await explainQuery(sql, { client: library.client })).text;

    const mcp = makeB72Client();
    const tools = mcpTools(mcp.client);
    const mcpResult = await tools.query({ sql });
    const mcpExplain = mcpPlanText(await tools.explain({ sql }));

    const cli = await captureCli(configPath, sql, false);
    const cliExplain = await captureCli(configPath, sql, true);

    expect(mcpResult["ok"]).toBe(true);
    expect(cli.code).toBe(0);
    expect(cliExplain.code).toBe(0);
    expect(plugin.queries).toHaveLength(
      _label === "B76 JOIN mixed function sets"
        || _label === "B76 第5-L multiple aliases and residual"
        ? 2
        : 1
    );
    expect(library.queries).toEqual(plugin.queries);
    expect(mcp.queries).toEqual(plugin.queries);
    expect(cli.queries).toEqual(plugin.queries);
    expect(surfacePlanFacts(libraryExplain)).toEqual(surfacePlanFacts(pluginExplain));
    expect(surfacePlanFacts(mcpExplain)).toEqual(surfacePlanFacts(pluginExplain));
    expect(surfacePlanFacts(cliPlanText(cliExplain.stdout))).toEqual(surfacePlanFacts(pluginExplain));
  });

  test.each([
    [
      "DATE × NOW",
      "SELECT 日付 FROM APP100 WHERE 日付 = NOW()",
      "WHERE_KINTONE_FUNCTION_FIELD_TYPE_UNSUPPORTED",
    ],
    [
      "record id × TODAY",
      "SELECT $id FROM APP100 WHERE $id >= TODAY()",
      "WHERE_KINTONE_FUNCTION_FIELD_TYPE_UNSUPPORTED",
    ],
    [
      "GROUP_SELECT × LOGINUSER",
      "SELECT グループ FROM APP100 WHERE グループ IN (LOGINUSER())",
      "WHERE_KINTONE_FUNCTION_FIELD_TYPE_UNSUPPORTED",
    ],
    [
      "non-exact OR × LOGINUSER",
      "SELECT 作成者 FROM APP100 "
        + "WHERE 作成者 IN (LOGINUSER()) OR LENGTH(件名) > 1",
      "WHERE_KINTONE_FUNCTION_REQUIRES_EXACT_PUSHDOWN",
    ],
    [
      "B76 JOIN GROUP_SELECT × LOGINUSER",
      "SELECT a.日付 FROM APP100 a JOIN APP200 b ON a.$id = b.$id "
        + "WHERE b.グループ IN (LOGINUSER())",
      "WHERE_KINTONE_FUNCTION_FIELD_TYPE_UNSUPPORTED",
    ],
    [
      "B76 cross-alias OR",
      "SELECT a.日付 FROM APP100 a JOIN APP200 b ON a.$id = b.$id "
        + "WHERE a.日付 = THIS_MONTH() OR b.作成者 IN (LOGINUSER())",
      "WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN",
    ],
    [
      "B76 non-exact KLIKE-containing OR",
      "SELECT a.日付 FROM APP100 a JOIN APP200 b ON a.$id = b.$id "
        + "WHERE a.日付 = THIS_MONTH() "
        + "OR (a.件名 KLIKE 'urgent' AND LENGTH(a.件名) > 1)",
      "WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN",
    ],
  ])("%s は reason と records API 0 が4面で一致する", async (
    _label,
    sql,
    reason
  ) => {
    const plugin = makeB72Client();
    const pluginExplain = planText(await execute(`EXPLAIN ${sql}`, plugin.client) as SelectResult);
    const library = makeB72Client();
    const libraryExplain = (await explainQuery(sql, { client: library.client })).text;
    const mcp = makeB72Client();
    const mcpExplain = mcpPlanText(await mcpTools(mcp.client).explain({ sql }));
    const cliExplain = await captureCli(configPath, sql, true);
    const cliText = cliPlanText(cliExplain.stdout);
    const diagnostic = (text: string) =>
      text.split(/\r?\n/).find((line) => line.includes(reason))?.trim() ?? "";

    expect(diagnostic(pluginExplain)).toContain(reason);
    expect(diagnostic(libraryExplain)).toBe(diagnostic(pluginExplain));
    expect(diagnostic(mcpExplain)).toBe(diagnostic(pluginExplain));
    expect(diagnostic(cliText)).toBe(diagnostic(pluginExplain));
    expect(cliExplain.code).toBe(0);
    expect(plugin.queries).toEqual([]);
    expect(library.queries).toEqual([]);
    expect(mcp.queries).toEqual([]);
    expect(cliExplain.queries).toEqual([]);
  });

  test.each([
    [
      "cross-alias OR",
      "SELECT a.日付 FROM APP100 a JOIN APP200 b ON a.$id = b.$id "
        + "WHERE a.日付 = THIS_MONTH() OR b.作成者 IN (LOGINUSER())",
    ],
    [
      "non-exact KLIKE-containing OR",
      "SELECT a.日付 FROM APP100 a JOIN APP200 b ON a.$id = b.$id "
        + "WHERE a.日付 = THIS_MONTH() "
        + "OR (a.件名 KLIKE 'urgent' AND LENGTH(a.件名) > 1)",
    ],
  ])("B76 %s は実行時 reason と records API 0 が4面で一致する", async (_label, sql) => {
    const reason = "WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN";
    const plugin = makeB72Client();
    const library = makeB72Client();
    const mcp = makeB72Client();

    const pluginError = await execute(sql, plugin.client)
      .then(() => "", (error: unknown) => String(error));
    const libraryError = await runQuery(sql, { client: library.client })
      .then(() => "", (error: unknown) => String(error));
    const mcpError = await mcpTools(mcp.client).query({ sql })
      .then(() => "", (error: unknown) => String(error));
    const cli = await captureCli(configPath, sql, false);

    for (const text of [pluginError, libraryError, mcpError, `${cli.stdout}\n${cli.stderr}`]) {
      expect(text).toContain(reason);
    }
    expect(cli.code).toBe(1);
    expect(plugin.queries).toEqual([]);
    expect(library.queries).toEqual([]);
    expect(mcp.queries).toEqual([]);
    expect(cli.queries).toEqual([]);
  });

  test("CREATOR × = は実行 error と records API 0 が4面で一致する", async () => {
    const sql = "SELECT 作成者 FROM APP100 WHERE 作成者 = 'taro'";
    const reason = "WHERE_OPERATOR_INVALID_FOR_FIELD_TYPE";
    const plugin = makeB72Client();
    const library = makeB72Client();
    const mcp = makeB72Client();

    const pluginError = await execute(sql, plugin.client)
      .then(() => "", (error: unknown) => String(error));
    const libraryError = await runQuery(sql, { client: library.client })
      .then(() => "", (error: unknown) => String(error));
    const mcpError = await mcpTools(mcp.client).query({ sql })
      .then(() => "", (error: unknown) => String(error));
    const cli = await captureCli(configPath, sql, false);
    const diagnostic = (text: string) => text.slice(text.indexOf("ArgumentError:"));

    expect(pluginError).toContain(reason);
    expect(diagnostic(libraryError)).toBe(diagnostic(pluginError));
    expect(diagnostic(mcpError)).toBe(diagnostic(pluginError));
    expect(`${cli.stdout}\n${cli.stderr}`).toContain(reason);
    expect(cli.code).toBe(2);
    expect(plugin.queries).toEqual([]);
    expect(library.queries).toEqual([]);
    expect(mcp.queries).toEqual([]);
    expect(cli.queries).toEqual([]);
  });

  test.each([
    [
      "KORDER BY",
      "SELECT COUNT(*) AS c FROM APP100 WHERE 日付 = THIS_MONTH() KORDER BY $id LIMIT 10",
    ],
    [
      "subtable",
      "SELECT 子, COUNT(*) AS c FROM APP100$テーブル "
        + "WHERE 日付 = THIS_MONTH() GROUP BY 子",
    ],
    [
      "UNION branch",
      "WITH c AS (SELECT 日付 FROM APP100 WHERE 日付 = THIS_MONTH() "
        + "UNION ALL SELECT 日付 FROM APP200) SELECT * FROM c",
    ],
    [
      "non exact materialized CTE",
      "WITH c AS (SELECT 日付 FROM APP100 "
        + "WHERE 日付 = THIS_MONTH() AND LENGTH(区分) > 1) SELECT * FROM c",
    ],
  ])("%s は reject/reason/path/records API 0 が4面で一致する", async (_label, sql) => {
    const plugin = makeB72Client();
    const pluginExplain = planText(await execute(`EXPLAIN ${sql}`, plugin.client) as SelectResult);

    const library = makeB72Client();
    const libraryExplain = (await explainQuery(sql, { client: library.client })).text;

    const mcp = makeB72Client();
    const mcpExplain = mcpPlanText(await mcpTools(mcp.client).explain({ sql }));
    const cliExplain = await captureCli(configPath, sql, true);
    const cliText = cliPlanText(cliExplain.stdout);

    expect(pluginExplain).toContain("WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN");
    expect(rejectionDiagnostic(libraryExplain)).toBe(rejectionDiagnostic(pluginExplain));
    expect(rejectionDiagnostic(mcpExplain)).toBe(rejectionDiagnostic(pluginExplain));
    expect(rejectionDiagnostic(cliText)).toBe(rejectionDiagnostic(pluginExplain));
    expect(mcpExplain).toContain("WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN");
    expect(cliExplain.stdout).toContain("WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN");
    expect(cliExplain.code).toBe(0);
    expect(plugin.queries).toEqual([]);
    expect(library.queries).toEqual([]);
    expect(mcp.queries).toEqual([]);
    expect(cliExplain.queries).toEqual([]);
  });

  test.each([
    [
      "SELECT source",
      "CREATE TEMP TABLE #t AS SELECT 日付 FROM APP100 "
        + "WHERE 日付 = YESTERDAY(); SELECT * FROM #t",
    ],
    [
      "WITH source",
      "CREATE TEMP TABLE #t AS WITH c AS "
        + "(SELECT 日付 FROM APP100 WHERE 日付 = YESTERDAY()) "
        + "SELECT COUNT(*) AS n FROM c; SELECT * FROM #t",
    ],
  ])("一時テーブル %s は accept/query/EXPLAIN が共有4面で一致する", async (_label, sql) => {
    // plugin/CLI/MCP は同じ executeBatch/buildBatchExplainPlans を利用する。
    // engine library のバッチ核として直接呼び、各 surface の adapter 出力と比較する。
    const engine = makeB72Client();
    const engineResult = await executeBatch(sql, engine.client);
    const engineExplain = batchPlanText(await buildBatchExplainPlans(sql, engine.client));

    const mcp = makeB72Client();
    const tools = mcpTools(mcp.client);
    const mcpResult = await tools.query({ sql });
    const mcpExplainResult = await tools.explain({ sql }) as unknown as {
      statements: Array<{ plan?: string[] }>;
    };

    const cli = await captureCli(configPath, sql, false);
    const cliExplain = await captureCli(configPath, sql, true);
    const cliPayload = JSON.parse(cli.stdout) as { ok: boolean; batch: boolean };

    expect(engineResult.ok).toBe(true);
    expect(mcpResult).toMatchObject({ ok: true, batch: true });
    expect(cliPayload).toMatchObject({ ok: true, batch: true });
    expect(engine.queries).toHaveLength(1);
    expect(mcp.queries).toEqual(engine.queries);
    expect(cli.queries).toEqual(engine.queries);
    expect(surfacePlanFacts(batchPlanText(mcpExplainResult)))
      .toEqual(surfacePlanFacts(engineExplain));
    expect(surfacePlanFacts(cliExplain.stdout)).toEqual(surfacePlanFacts(engineExplain));
    expect(engineExplain).toContain("where capability: EXACT_PUSHDOWN");
    expect(engineExplain).toContain("client evaluation: forbidden");
  });

  test.each([
    [
      "UNION branch",
      "CREATE TEMP TABLE #t AS SELECT 日付 FROM APP100 WHERE 日付 = YESTERDAY() "
        + "UNION ALL SELECT 日付 FROM APP200; SELECT * FROM #t",
      "statement.query.left",
    ],
    [
      "non exact",
      "CREATE TEMP TABLE #t AS SELECT 日付 FROM APP100 "
        + "WHERE 日付 = YESTERDAY() AND LENGTH(区分) > 1; SELECT * FROM #t",
      "statement.query",
    ],
  ])("一時テーブル %s は reason/path/API 0 が共有4面で一致する", async (
    _label,
    sql,
    expectedPath
  ) => {
    const engine = makeB72Client();
    const engineResult = await executeBatch(sql, engine.client);
    const mcp = makeB72Client();
    const mcpResult = await mcpTools(mcp.client).query({ sql });
    const cli = await captureCli(configPath, sql, false);
    const engineText = JSON.stringify(engineResult);
    const mcpText = JSON.stringify(mcpResult);

    expect(engineResult.ok).toBe(false);
    expect(reasonPath(engineText)).toEqual({
      reason: "WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN",
      path: expectedPath,
    });
    expect(reasonPath(mcpText)).toEqual(reasonPath(engineText));
    expect(reasonPath(cli.stdout)).toEqual(reasonPath(engineText));
    expect(engine.queries).toEqual([]);
    expect(mcp.queries).toEqual([]);
    expect(cli.queries).toEqual([]);
  });
});
