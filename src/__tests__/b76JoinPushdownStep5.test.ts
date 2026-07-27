import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetGlobalRequestGate } from "../api/requestGate";
import type { KintoneRecord } from "../converter/dmlToKintone";
import { runWithArgv } from "../cli";
import { explainQuery, runQuery } from "../engine-library/query";
import {
  execute,
  type KintoneClient,
  type KintoneFieldInfo,
  type SelectResult,
} from "../execute";
import {
  createKsqlMcpTools,
  type KsqlMcpToolDependencies,
} from "../mcp/tools";
import type {
  CreateKsqlRuntimeInput,
  KsqlRuntime,
  KsqlRuntimeServerOptions,
} from "../node/runtime";

type GetRecordsParams = Parameters<KintoneClient["getRecords"]>[0];

const MAIN_APP = 76800;
const JOIN_APP = 76801;

function record(values: Readonly<Record<string, unknown>>): KintoneRecord {
  return Object.fromEntries(
    Object.entries(values).map(([code, value]) => [code, { value }])
  ) as KintoneRecord;
}

const rowsByApp: Readonly<Record<number, readonly KintoneRecord[]>> = {
  [MAIN_APP]: [
    record({ $id: "1", 顧客ID: "C1", 担当者: "佐藤", 日付: "2026-07-27", 件名: "urgent" }),
    record({ $id: "2", 顧客ID: "C2", 担当者: "佐藤 ", 日付: "2026-07-26", 件名: "normal" }),
    record({ $id: "3", 顧客ID: "C3", 担当者: "田中", 日付: "2026-07-25", 件名: "urgent" }),
  ],
  [JOIN_APP]: [
    record({ $id: "11", 顧客ID: "C1", 区分: "A" }),
    record({ $id: "12", 顧客ID: "C2", 区分: "A" }),
    record({ $id: "13", 顧客ID: "C3", 区分: "B" }),
  ],
};

const fieldsByApp: Readonly<Record<number, readonly KintoneFieldInfo[]>> = {
  [MAIN_APP]: [
    { code: "顧客ID", label: "顧客ID", fieldType: "SINGLE_LINE_TEXT" },
    { code: "担当者", label: "担当者", fieldType: "SINGLE_LINE_TEXT" },
    { code: "日付", label: "日付", fieldType: "DATE" },
    { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
    { code: "作成者", label: "作成者", fieldType: "CREATOR" },
  ],
  [JOIN_APP]: [
    { code: "顧客ID", label: "顧客ID", fieldType: "SINGLE_LINE_TEXT" },
    {
      code: "区分",
      label: "区分",
      fieldType: "DROP_DOWN",
      optionOrder: { A: 0, B: 1 },
    },
  ],
};

function withoutPaging(query: string): string {
  return query.replace(/(?:^|\s+)order by \$id asc limit 500 offset \d+$/, "");
}

function projected(
  source: readonly KintoneRecord[],
  fields: readonly string[]
): KintoneRecord[] {
  return source.map((row) => Object.fromEntries(
    fields.flatMap((field) => row[field] === undefined ? [] : [[field, row[field]]])
  ) as KintoneRecord);
}

function serverRows(app: number, query: string): readonly KintoneRecord[] {
  const rows = rowsByApp[app] ?? [];
  if (app === MAIN_APP && query.includes('担当者 = "佐藤"')) return rows.slice(0, 2);
  if (app === JOIN_APP && query.includes('区分 in ("A")')) return rows.slice(0, 2);
  return rows;
}

function makeClient() {
  const calls: GetRecordsParams[] = [];
  const client: KintoneClient = {
    async getRecords(params) {
      calls.push({ ...params, fields: [...params.fields] });
      return {
        records: projected(serverRows(params.app, params.query), params.fields),
      };
    },
    async openCursor() { throw new Error("unexpected cursor"); },
    async postRecords() { throw new Error("unexpected write"); },
    async putRecords() { throw new Error("unexpected write"); },
    async deleteRecords() { throw new Error("unexpected write"); },
    async getApps() { return []; },
    async getFields(appId) { return [...(fieldsByApp[appId] ?? [])]; },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const };
    },
  };
  return { client, calls };
}

function mcpTools(client: KintoneClient) {
  const createRuntime: NonNullable<KsqlMcpToolDependencies["createRuntime"]> = async (
    _serverOptions: KsqlRuntimeServerOptions,
    input: CreateKsqlRuntimeInput
  ): Promise<KsqlRuntime> => ({
    sql: input.sql.replace(/@test\b/g, ""),
    profileName: input.profile ?? "test",
    client,
    cacheContext: "b76-step5-mcp",
    maxRecords: input.maxRecords ?? 500,
    fetchParallel: input.fetchParallel ?? 3,
    onLimit: input.onLimit ?? "error",
    timeout: input.timeout ?? 30000,
    cursorMaxActive: input.cursorMaxActive ?? 2,
  });
  return createKsqlMcpTools({ profile: "test" }, { createRuntime });
}

function planText(result: SelectResult): string {
  return result.rows.map((row) => String(row.plan)).join("\n");
}

function mcpPlanText(result: Record<string, unknown>): string {
  const rows = result.rows as Array<Record<string, unknown>>;
  return rows.map((row) => String(row.plan)).join("\n");
}

function cliPlanText(stdout: string): string {
  const payload = JSON.parse(stdout) as { rows: Array<Record<string, unknown>> };
  return payload.rows.map((row) => String(row.plan)).join("\n");
}

function cliJson(capture: CliCapture): Record<string, unknown> {
  if (capture.stdout.trim() === "") {
    throw new Error(`CLI returned no JSON (code=${capture.code}): ${capture.stderr}`);
  }
  return JSON.parse(capture.stdout) as Record<string, unknown>;
}

function normalizeProfile(text: string): string {
  return text.replace(/(APP7680[01])@test/g, "$1");
}

const PLAN_FACTS = [
  "join pushdown plan:",
  "residual:",
  "join pushdown not applied:",
  "app:",
  "JOIN:",
  "LEFT JOIN:",
  "RIGHT JOIN:",
  "kintone query:",
  "pushdown applied:",
  "pushdown candidate:",
  "relation:",
] as const;

function planFacts(text: string): string[] {
  return normalizeProfile(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => PLAN_FACTS.some((label) => line.startsWith(label)));
}

function surfaceSql(sql: string): string {
  return sql.replace(/APP7680([01])/g, "APP7680$1@test");
}

interface CliCapture {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly calls: Array<{ app: number; query: string }>;
}

async function captureCli(configPath: string, sql: string, dryRun: boolean): Promise<CliCapture> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const calls: Array<{ app: number; query: string }> = [];
  const fetchMock = jest.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    const app = Number(url.searchParams.get("app"));
    if (url.pathname.endsWith("/app/form/fields.json")) {
      const properties = Object.fromEntries((fieldsByApp[app] ?? []).map((field) => [
        field.code,
        {
          code: field.code,
          label: field.label,
          type: field.fieldType,
          ...(field.optionOrder
            ? {
                options: Object.fromEntries(Object.entries(field.optionOrder).map(
                  ([label, index]) => [label, { label, index: String(index) }]
                )),
              }
            : {}),
        },
      ]));
      return new Response(JSON.stringify({ properties }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname.endsWith("/app/status.json")) {
      return new Response(JSON.stringify({ enable: false, states: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname.endsWith("/app/settings.json")) {
      return new Response(JSON.stringify({
        numberPrecision: { digits: "30", decimalPlaces: "10", roundingMode: "HALF_EVEN" },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname.endsWith("/records.json")) {
      const query = url.searchParams.get("query") ?? "";
      const fields = [...url.searchParams.entries()]
        .filter(([key]) => key === "fields[]" || /^fields\[\d+\]$/.test(key))
        .map(([, value]) => value);
      calls.push({ app, query });
      return new Response(JSON.stringify({
        records: projected(serverRows(app, query), fields),
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ code: "UNEXPECTED_API", message: url.toString() }), {
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
      "-e", surfaceSql(sql),
    ]);
    return { code, stdout: stdout.join(""), stderr: stderr.join(""), calls };
  } finally {
    fetchMock.mockRestore();
    jest.restoreAllMocks();
    resetGlobalRequestGate();
  }
}

function queries(calls: readonly GetRecordsParams[]): string[] {
  return calls.map((call) => `${call.app}:${withoutPaging(call.query)}`);
}

const BASE =
  `SELECT a.$id, b.区分 FROM APP${MAIN_APP} a INNER JOIN APP${JOIN_APP} b `
  + "ON a.顧客ID = b.顧客ID WHERE ";

describe("B76 Phase A Step 5 distribution parity", () => {
  const dir = mkdtempSync(join(tmpdir(), "ksql-b76-step5-"));
  const configPath = join(dir, "ksql.config.json");

  beforeAll(() => {
    writeFileSync(configPath, JSON.stringify({
      defaultProfile: "test",
      profiles: {
        test: {
          baseUrl: "https://example.cybozu.com",
          tokenMap: {
            [`APP${MAIN_APP}`]: "fixture-token",
            [`APP${JOIN_APP}`]: "fixture-token",
          },
        },
      },
    }));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("DATE/TEXT、same-alias OR、APP別query、rows、EXPLAINが各配布面で一致する", async () => {
    const sql = `${BASE}(a.担当者 = '佐藤' OR a.日付 = '2026-07-24') AND b.区分 IN ('A')`;

    const firefox = makeClient();
    const firefoxResult = await execute(sql, firefox.client) as SelectResult;
    const firefoxExplain = planText(
      await execute(`EXPLAIN ${sql}`, firefox.client) as SelectResult
    );

    const chrome = makeClient();
    const chromeResult = await execute(sql, chrome.client) as SelectResult;
    const chromeExplain = planText(
      await execute(`EXPLAIN ${sql}`, chrome.client) as SelectResult
    );

    const library = makeClient();
    const libraryResult = await runQuery(sql, { client: library.client });
    const libraryExplain = (await explainQuery(sql, { client: library.client })).text;

    const mcp = makeClient();
    const tools = mcpTools(mcp.client);
    const mcpValidation = await tools.validate({ sql: surfaceSql(sql), profile: "test" });
    const mcpResult = await tools.query({ sql: surfaceSql(sql), profile: "test" });
    const mcpExplain = mcpPlanText(
      await tools.explain({ sql: surfaceSql(sql), profile: "test" })
    );

    const cliResult = await captureCli(configPath, sql, false);
    const cliExplain = await captureCli(configPath, sql, true);
    const cliPayload = cliJson(cliResult) as { rows: Array<Record<string, unknown>> };

    expect(mcpValidation).toMatchObject({ ok: true });
    expect(mcpResult).toMatchObject({ ok: true, rows: firefoxResult.rows });
    expect(cliResult.code).toBe(0);
    expect(cliExplain.code).toBe(0);
    expect(chromeResult.rows).toEqual(firefoxResult.rows);
    expect(libraryResult.rows).toEqual(firefoxResult.rows);
    expect(cliPayload.rows).toEqual(firefoxResult.rows);
    expect(firefoxResult.rows).toEqual([{ $id: "1", 区分: "A" }]);

    const expectedQueries = [
      `${MAIN_APP}:(担当者 = "佐藤" or 日付 = "2026-07-24")`,
      `${JOIN_APP}:区分 in ("A")`,
    ];
    expect(queries(firefox.calls.slice(0, 2))).toEqual(expectedQueries);
    expect(queries(chrome.calls.slice(0, 2))).toEqual(expectedQueries);
    expect(queries(library.calls.slice(0, 2))).toEqual(expectedQueries);
    expect(queries(mcp.calls.slice(0, 2))).toEqual(expectedQueries);
    expect(cliResult.calls.map((call) => `${call.app}:${withoutPaging(call.query)}`))
      .toEqual(expectedQueries);

    const expectedPlan = planFacts(firefoxExplain);
    expect(planFacts(chromeExplain)).toEqual(expectedPlan);
    expect(planFacts(libraryExplain)).toEqual(expectedPlan);
    expect(planFacts(mcpExplain)).toEqual(expectedPlan);
    expect(planFacts(cliPlanText(cliExplain.stdout))).toEqual(expectedPlan);
    expect(expectedPlan).toContain("residual: original WHERE");
    expect(expectedPlan).toContain("relation: superset");
    expect(expectedPlan).toContain("relation: exact");
  });

  test.each([
    ["cross-alias OR", `${BASE}a.担当者 = '佐藤' OR b.区分 IN ('B')`, "CROSS_ALIAS_OR"],
    [
      "LEFT JOIN",
      `${BASE.replace("INNER JOIN", "LEFT JOIN")}a.担当者 = '佐藤'`,
      "OUTER_JOIN",
    ],
    [
      "RIGHT JOIN",
      `${BASE.replace("INNER JOIN", "RIGHT JOIN")}a.担当者 = '佐藤'`,
      "OUTER_JOIN",
    ],
  ])("%s は各APPへ新規述語を送らずEXPLAIN reasonが一致する", async (
    _label,
    sql,
    reason
  ) => {
    const firefox = makeClient();
    const firefoxResult = await execute(sql, firefox.client) as SelectResult;
    const firefoxExplain = planText(
      await execute(`EXPLAIN ${sql}`, firefox.client) as SelectResult
    );
    const chrome = makeClient();
    const chromeResult = await execute(sql, chrome.client) as SelectResult;
    const library = makeClient();
    const libraryResult = await runQuery(sql, { client: library.client });
    const mcp = makeClient();
    const mcpResult = await mcpTools(mcp.client).query({ sql });
    const cliResult = await captureCli(configPath, sql, false);

    expect(chromeResult.rows).toEqual(firefoxResult.rows);
    expect(libraryResult.rows).toEqual(firefoxResult.rows);
    expect(mcpResult).toMatchObject({ ok: true, rows: firefoxResult.rows });
    expect(cliJson(cliResult)).toMatchObject({ rows: firefoxResult.rows });
    expect(firefoxExplain).toContain(reason);
    for (const calls of [firefox.calls, chrome.calls, library.calls, mcp.calls]) {
      expect(calls.every((call) => !call.query.includes("担当者")
        && !call.query.includes("区分 in"))).toBe(true);
    }
    expect(cliResult.calls.every((call) => !call.query.includes("担当者")
      && !call.query.includes("区分 in"))).toBe(true);
  });

  test("KLIKEを含むORはrun/explainとも全配布面でrecords API前に拒否し、reasonが一致する", async () => {
    const sql = `${BASE}a.件名 KLIKE 'urgent' OR a.担当者 = '佐藤'`;
    const reason = "FULL_SCAN の KLIKE / NOT KLIKE";
    const firefox = makeClient();
    const chrome = makeClient();
    const library = makeClient();
    const mcp = makeClient();

    for (const mode of ["run", "explain"] as const) {
      const pluginSql = mode === "run" ? sql : `EXPLAIN ${sql}`;
      const firefoxError = await execute(pluginSql, firefox.client)
        .then(() => "", (error: unknown) => String(error));
      const chromeError = await execute(pluginSql, chrome.client)
        .then(() => "", (error: unknown) => String(error));
      const libraryError = await (
        mode === "run"
          ? runQuery(sql, { client: library.client })
          : explainQuery(sql, { client: library.client })
      ).then(() => "", (error: unknown) => String(error));
      const tools = mcpTools(mcp.client);
      const mcpError = await (
        mode === "run" ? tools.query({ sql }) : tools.explain({ sql })
      ).then(() => "", (error: unknown) => String(error));
      const cli = await captureCli(configPath, sql, mode === "explain");
      const cliError = `${cli.stdout}\n${cli.stderr}`;

      expect(firefoxError).toContain(reason);
      expect(chromeError).toBe(firefoxError);
      expect(libraryError).toContain(reason);
      expect(mcpError).toContain(reason);
      expect(cliError).toContain(reason);
      expect(cli.code).toBe(1);
      expect(cli.calls).toEqual([]);
    }
    expect(firefox.calls).toEqual([]);
    expect(chrome.calls).toEqual([]);
    expect(library.calls).toEqual([]);
    expect(mcp.calls).toEqual([]);
  });
});
