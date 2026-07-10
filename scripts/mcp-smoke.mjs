#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = resolve(rootDir, "dist-mcp", "ksql-mcp.js");
const packageVersion = JSON.parse(
  readFileSync(resolve(rootDir, "package.json"), "utf8")
).version;
const smokeSavedQueriesPath = resolve(rootDir, ".tmp", "mcp-smoke-queries.json");
const expectedTools = [
  "ksql_validate",
  "ksql_explain",
  "ksql_query",
  "ksql_mutate",
  "ksql_describe_app",
  "ksql_show_apps",
  "ksql_save_query",
  "ksql_list_queries",
  "ksql_get_query",
  "ksql_run_saved_query",
  "ksql_delete_query",
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertBundleIsSelfContained() {
  assert(existsSync(serverPath), `Missing ${serverPath}. Run npm run build:mcp first.`);
  const bundled = readFileSync(serverPath, "utf8");
  const forbidden = [
    /require\(["']@modelcontextprotocol\/sdk/,
    /require\(["']zod(?:\/[^"']*)?["']\)/,
  ];
  assert(
    !forbidden.some((pattern) => pattern.test(bundled)),
    "dist-mcp/ksql-mcp.js contains external MCP SDK or zod require()."
  );
}

function getTool(tools, name) {
  const tool = tools.find((item) => item.name === name);
  assert(tool, `Tool ${name} is missing.`);
  return tool;
}

function assertSchemas(tools) {
  const explain = getTool(tools, "ksql_explain");
  const explainProps = explain.inputSchema?.properties ?? {};
  assert("sql" in explainProps, "ksql_explain.sql input is missing.");
  assert("profile" in explainProps, "ksql_explain.profile input is missing.");
  assert(!("maxRecords" in explainProps), "ksql_explain must not expose maxRecords.");
  assert(!("onLimit" in explainProps), "ksql_explain must not expose onLimit.");

  const query = getTool(tools, "ksql_query");
  const queryProps = query.inputSchema?.properties ?? {};
  assert(!("format" in queryProps), "ksql_query must not expose CLI-only format.");
  assert(!("configPath" in queryProps), "ksql_query must not expose per-call configPath.");

  const mutate = getTool(tools, "ksql_mutate");
  const mutateProps = mutate.inputSchema?.properties ?? {};
  assert("allowDml" in mutateProps, "ksql_mutate.allowDml input is missing.");
  assert("confirmText" in mutateProps, "ksql_mutate.confirmText input is missing.");
  assert("dmlMaxRows" in mutateProps, "ksql_mutate.dmlMaxRows input is missing.");
  assert(!("allowWithoutWhere" in mutateProps), "ksql_mutate must not expose allowWithoutWhere.");

  const saveQuery = getTool(tools, "ksql_save_query");
  const saveQueryProps = saveQuery.inputSchema?.properties ?? {};
  assert("defaultProfile" in saveQueryProps, "ksql_save_query.defaultProfile input is missing.");
  assert("readOnly" in saveQueryProps, "ksql_save_query.readOnly input is missing.");
  assert(!("catalogPath" in saveQueryProps), "ksql_save_query must not expose per-call catalogPath.");

  const runSavedQuery = getTool(tools, "ksql_run_saved_query");
  const runSavedQueryProps = runSavedQuery.inputSchema?.properties ?? {};
  assert("allowDml" in runSavedQueryProps, "ksql_run_saved_query.allowDml input is missing.");
  assert("dmlMaxRows" in runSavedQueryProps, "ksql_run_saved_query.dmlMaxRows input is missing.");
  assert(!("catalogPath" in runSavedQueryProps), "ksql_run_saved_query must not expose per-call catalogPath.");
}

// description regression guard(fix_plan D5):
// 「実装は正しいが tools/list のメタデータだけ古い」ズレを検出する。
// 全文一致は文言調整のたびに壊れるため、実装能力を表すキー部分文字列のみを固定する。
function assertToolDescriptions(tools) {
  const queryKeys = ["multi-statement batches with temp tables"];
  const mutateKeys = [
    "multi-statement DML batches with temp tables",
    // v1.7.0: SELECT-based DML のソース制限を最終解消(APP / temp / 混在とも可)
    "supports app sources, temp tables, or joins of both",
    // v1.6.0: dmlMaxRows は UPSERT では insert + update 合計
    "counts inserts + updates",
    // v1.7.0: 読み取り上限はソース種類ごとに異なる(APP = dmlMaxRows + 1 / temp = 実体化 10,000 行)
    "temp tables hold at most 10000 rows",
  ];
  const query = getTool(tools, "ksql_query");
  for (const key of queryKeys) {
    assert(
      typeof query.description === "string" && query.description.includes(key),
      `ksql_query.description must mention "${key}".`
    );
  }
  const mutate = getTool(tools, "ksql_mutate");
  for (const key of mutateKeys) {
    assert(
      typeof mutate.description === "string" && mutate.description.includes(key),
      `ksql_mutate.description must mention "${key}".`
    );
  }
}

// inputSchema のパラメータ説明(fix_plan D3/D5): zod .describe() が
// JSON Schema の description に変換されて MCP クライアントへ届くことを固定する
function assertParamDescriptions(tools) {
  const described = {
    ksql_query: ["sql", "profile", "maxRecords", "fetchParallel", "onLimit", "timeout", "continueOnError", "maxTotalRecords"],
    ksql_mutate: ["sql", "profile", "allowDml", "confirmText", "dmlMaxRows", "fetchParallel", "timeout", "dmlTotalMaxRows"],
  };
  for (const [toolName, params] of Object.entries(described)) {
    const props = getTool(tools, toolName).inputSchema?.properties ?? {};
    for (const param of params) {
      const description = props[param]?.description;
      assert(
        typeof description === "string" && description.length > 0,
        `${toolName}.${param} must have a non-empty schema description.`
      );
    }
  }

  // v1.7.0: dmlMaxRows が APP ソース読み取りの上限を兼ねること(temp は実体化 10,000 行で別建て)、
  // v1.6.0: UPSERT_SELECT では insert + update 合計を数えることを describe で宣言する
  //（ksql_run_saved_query の DML 経路は mutate() 委譲のため同じ制約が効く。両ツールで固定する）
  for (const toolName of ["ksql_mutate", "ksql_run_saved_query"]) {
    const dmlMaxRowsDesc =
      getTool(tools, toolName).inputSchema?.properties?.dmlMaxRows?.description ?? "";
    assert(
      dmlMaxRowsDesc.includes("caps app-source reads"),
      `${toolName}.dmlMaxRows description must mention the app-source read cap.`
    );
    assert(
      dmlMaxRowsDesc.includes("counts inserts + updates"),
      `${toolName}.dmlMaxRows description must mention the UPSERT inserts + updates total.`
    );
  }
}

async function main() {
  assertBundleIsSelfContained();

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: rootDir,
    env: {
      ...process.env,
      KSQL_SAVED_QUERIES: smokeSavedQueriesPath,
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => {
    process.stderr.write(chunk.toString());
  });

  const client = new Client(
    { name: "ksql-mcp-smoke", version: "0.0.1" },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);

    const listed = await client.listTools();
    const toolNames = listed.tools.map((tool) => tool.name).sort();
    assert(
      JSON.stringify(toolNames) === JSON.stringify([...expectedTools].sort()),
      `Unexpected tool list: ${toolNames.join(", ")}`
    );
    assertSchemas(listed.tools);
    assertToolDescriptions(listed.tools);
    assertParamDescriptions(listed.tools);

    // サーバー申告バージョンの package.json 同期(fix_plan D4/D5)
    const serverVersion = client.getServerVersion()?.version;
    assert(
      serverVersion === packageVersion,
      `serverInfo.version (${serverVersion}) must match package.json version (${packageVersion}).`
    );

    const validated = await client.callTool({
      name: "ksql_validate",
      arguments: { sql: "SELECT 'ok' AS result" },
    });
    assert(validated.structuredContent?.ok === true, "ksql_validate did not return ok=true.");
    assert(
      validated.structuredContent?.statementType === "SELECT",
      "ksql_validate did not identify SELECT."
    );

    const explained = await client.callTool({
      name: "ksql_explain",
      arguments: { sql: "SELECT 'ok' AS result" },
    });
    assert(explained.structuredContent?.ok === true, "ksql_explain did not return ok=true.");
    assert(
      Array.isArray(explained.structuredContent?.columns)
        && explained.structuredContent.columns.includes("plan"),
      "ksql_explain did not return a plan column."
    );

    const queried = await client.callTool({
      name: "ksql_query",
      arguments: { sql: "SELECT 'ok' AS result", maxRecords: 10, onLimit: "error" },
    });
    assert(queried.structuredContent?.ok === true, "ksql_query no-FROM smoke failed.");
    assert(queried.structuredContent?.rowCount === 1, "ksql_query no-FROM rowCount mismatch.");

    const listedQueries = await client.callTool({
      name: "ksql_list_queries",
      arguments: {},
    });
    assert(listedQueries.structuredContent?.ok === true, "ksql_list_queries smoke failed.");
    assert(
      Array.isArray(listedQueries.structuredContent?.queries),
      "ksql_list_queries did not return a queries array."
    );

    process.stdout.write("[mcp-smoke] ok\n");
  } finally {
    await client.close().catch(() => {});
  }
}

main().catch((err) => {
  process.stderr.write(`[mcp-smoke] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
