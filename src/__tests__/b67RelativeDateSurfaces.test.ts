import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execute, type KintoneClient } from "../execute";
import { runQuery } from "../engine-library/query";

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
