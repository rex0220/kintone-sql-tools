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
  assert("maxRecords" in explainProps, "ksql_explain.maxRecords input is missing.");
  assert(
    explainProps.maxRecords?.type === "integer" && explainProps.maxRecords?.exclusiveMinimum === 0,
    "ksql_explain.maxRecords must be a positive integer."
  );
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
  assert("dmlMaxSubtableRows" in mutateProps, "ksql_mutate.dmlMaxSubtableRows input is missing.");
  assert(!("dmlMaxSubtableRows" in queryProps), "ksql_query must not expose dmlMaxSubtableRows.");
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

  // v1.11.0: tempTableMaxRows はバッチを受けるツールのみ。保存クエリは単文限定で
  // 一時テーブルが出現し得ないため公開しない(存在しない入力を describe で示唆もしない)
  assert("tempTableMaxRows" in queryProps, "ksql_query.tempTableMaxRows input is missing.");
  assert("tempTableMaxRows" in mutateProps, "ksql_mutate.tempTableMaxRows input is missing.");
  assert(!("tempTableMaxRows" in runSavedQueryProps), "ksql_run_saved_query must not expose tempTableMaxRows.");
}

// description regression guard(fix_plan D5):
// 「実装は正しいが tools/list のメタデータだけ古い」ズレを検出する。
// 全文一致は文言調整のたびに壊れるため、実装能力を表すキー部分文字列のみを固定する。
function assertToolDescriptions(tools) {
  const validateKeys = [
    "All APPLY forms (UPDATE/INSERT/UPSERT/multi-value)",
    "does not enable APPLY mutation",
  ];
  const explainKeys = [
    "every APPLY form (UPDATE/INSERT/UPSERT/multi-value)",
    "never calls records or mutation APIs",
  ];
  const queryKeys = [
    "multi-statement batches with temp tables",
    // v1.10.0: ASSERT は ksql_query で実行できる read-only 文
    "ASSERT",
    // v1.10.0: ASSERT 失敗は常にバッチ停止(continueOnError 無視)
    "always stops the batch",
    // B44 Phase 16d: v2 全 APPLY 形の VALIDATE ONLY は read-only のまま許可
    "UPDATE/INSERT/UPSERT/multi-value APPLY VALIDATE ONLY",
    "fixed default 500",
  ];
  const mutateKeys = [
    "multi-statement DML batches with temp tables",
    // v1.7.0: SELECT-based DML のソース制限を最終解消(APP / temp / 混在とも可)
    "supports app sources, temp tables, or joins of both",
    // v1.6.0: dmlMaxRows は UPSERT では insert + update 合計
    "counts inserts + updates",
    // v1.8.0: dmlMaxRows は影響行数専用(ソース読み取りは runtime maxRecords 解決)
    "caps affected rows only, not source reads",
    // v1.7.0: temp ソースの読み取りは実体化 10,000 行で別建て
    // v1.11.0: 10,000 は既定値になり tempTableMaxRows で変更可
    "temp tables hold at most 10000 rows by default (adjustable via tempTableMaxRows)",
    // B44 Phase 16d: v2 全 APPLY mutation は controls に関係なく runtime/API 前に閉じる
    "Every APPLY mutation form (UPDATE/INSERT/UPSERT/multi-value)",
    "always rejected by MCP v3.8.0 before runtime or records API creation",
    "allowDml and dmlMaxSubtableRows do not enable it",
  ];
  const validate = getTool(tools, "ksql_validate");
  for (const key of validateKeys) {
    assert(
      typeof validate.description === "string" && validate.description.includes(key),
      `ksql_validate.description must mention "${key}".`
    );
  }
  const explain = getTool(tools, "ksql_explain");
  for (const key of explainKeys) {
    assert(
      typeof explain.description === "string" && explain.description.includes(key),
      `ksql_explain.description must mention "${key}".`
    );
  }
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
    ksql_query: ["sql", "profile", "maxRecords", "fetchParallel", "onLimit", "tempTableMaxRows", "timeout", "continueOnError", "maxTotalRecords"],
    ksql_mutate: ["sql", "profile", "allowDml", "confirmText", "dmlMaxRows", "dmlMaxSubtableRows", "fetchParallel", "tempTableMaxRows", "timeout", "dmlTotalMaxRows"],
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

  // v1.8.0: dmlMaxRows は影響行数ガード専用で SELECT-based DML のソース読み取りを
  // 絞らない(読み取りは runtime の maxRecords 解決に従う)こと、
  // v1.6.0: UPSERT_SELECT では insert + update 合計を数えることを describe で宣言する
  //（ksql_run_saved_query の DML 経路は mutate() 委譲のため同じ制約が効く。両ツールで固定する）
  for (const toolName of ["ksql_mutate", "ksql_run_saved_query"]) {
    const dmlMaxRowsDesc =
      getTool(tools, toolName).inputSchema?.properties?.dmlMaxRows?.description ?? "";
    assert(
      dmlMaxRowsDesc.includes("does NOT limit source reads"),
      `${toolName}.dmlMaxRows description must state that it does not limit SELECT-based DML source reads.`
    );
    assert(
      dmlMaxRowsDesc.includes("runtime maxRecords resolution"),
      `${toolName}.dmlMaxRows description must mention the runtime maxRecords resolution for source reads.`
    );
    assert(
      dmlMaxRowsDesc.includes("counts inserts + updates"),
      `${toolName}.dmlMaxRows description must mention the UPSERT inserts + updates total.`
    );
  }

  // v1.11.0: tempTableMaxRows への言及は「その入力を実際に受け付けるツール」のみ。
  // ksql_run_saved_query は単文限定のため、存在しない入力を describe で示唆しない
  const mutateDmlMaxRowsDesc =
    getTool(tools, "ksql_mutate").inputSchema?.properties?.dmlMaxRows?.description ?? "";
  assert(
    mutateDmlMaxRowsDesc.includes("adjustable via tempTableMaxRows"),
    "ksql_mutate.dmlMaxRows description must state the temp table cap is adjustable via tempTableMaxRows."
  );
  const savedDmlMaxRowsDesc =
    getTool(tools, "ksql_run_saved_query").inputSchema?.properties?.dmlMaxRows?.description ?? "";
  assert(
    !savedDmlMaxRowsDesc.includes("tempTableMaxRows"),
    "ksql_run_saved_query.dmlMaxRows description must not mention tempTableMaxRows (input does not exist there)."
  );
  assert(
    savedDmlMaxRowsDesc.includes("single-statement"),
    "ksql_run_saved_query.dmlMaxRows description must state saved queries are single-statement."
  );

  // B44 Phase 16d: schema descriptions also pin the all-form APPLY boundary.
  const querySqlDesc = getTool(tools, "ksql_query").inputSchema?.properties?.sql?.description ?? "";
  assert(
    querySqlDesc.includes("UPDATE/INSERT/UPSERT/multi-value APPLY VALIDATE ONLY")
      && querySqlDesc.includes("fixed dmlMaxSubtableRows default 500"),
    "ksql_query.sql description must document all APPLY VALIDATE ONLY forms and fixed cap."
  );
  const applyCapDesc = getTool(tools, "ksql_mutate")
    .inputSchema?.properties?.dmlMaxSubtableRows?.description ?? "";
  for (const key of [
    "UPDATE/INSERT/UPSERT/multi-value",
    "MCP v3.8.0 before runtime or records API creation",
    "allowDml",
  ]) {
    assert(applyCapDesc.includes(key), `ksql_mutate.dmlMaxSubtableRows must mention "${key}".`);
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

    // B44 Phase 16d: offline smoke でも AST acceptance と runtime 前 fail-close を固定する。
    // VALIDATE ONLY/EXPLAIN の全形許可は tools/list の description guard と unit matrix が担う。
    const applySql = "INSERT INTO APP4221 (親) VALUES ('x') APPLY テーブル (APPEND (子) VALUES ('new'))";
    const applyValidated = await client.callTool({
      name: "ksql_validate",
      arguments: { sql: `${applySql} VALIDATE ONLY` },
    });
    assert(applyValidated.structuredContent?.ok === true, "APPLY VALIDATE ONLY smoke failed.");
    assert(applyValidated.structuredContent?.isReadOnly === true, "APPLY VALIDATE ONLY must be read-only.");

    const applyMutation = await client.callTool({
      name: "ksql_mutate",
      arguments: {
        sql: applySql,
        allowDml: true,
        confirmText: "yes",
        dmlMaxRows: 100,
        dmlMaxSubtableRows: 999,
      },
    });
    assert(applyMutation.structuredContent?.ok === false, "APPLY mutation must be rejected.");
    assert(
      applyMutation.structuredContent?.error?.code === "UnsupportedError"
        && applyMutation.structuredContent?.error?.message?.includes("MCP v3.8.0"),
      "APPLY mutation must fail closed before runtime with UnsupportedError."
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
