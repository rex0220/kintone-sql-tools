#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createKsqlMcpTools } from "./tools";
import {
  describeAppInputShape,
  explainInputShape,
  listQueriesInputShape,
  mutateInputShape,
  queryInputShape,
  runSavedQueryInputShape,
  savedQueryNameInputShape,
  saveQueryInputShape,
  showAppsInputShape,
  validateInputShape,
} from "./schemas";

interface ServerArgs {
  configPath?: string;
  profile?: string;
  help: boolean;
}

function parseServerArgs(argv: string[]): ServerArgs {
  const out: ServerArgs = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      out.help = true;
      continue;
    }
    const v = argv[i + 1];
    if (a === "--config") {
      out.configPath = v ?? "";
      i++;
      continue;
    }
    if (a === "--profile") {
      out.profile = v ?? "";
      i++;
      continue;
    }
    throw new Error(`ArgumentError: unknown option ${a}`);
  }
  return out;
}

function printHelp(): void {
  process.stdout.write(`ksql-mcp - MCP server for kintone-sql-tools

Usage:
  ksql-mcp [options]

Options:
  --config <path>    Config file path (default: ./ksql.config.json or KSQL_CONFIG)
  --profile <name>   Default profile name
  -h, --help         Show help

IMPORT CSV/JSON is call-scoped and disabled by default. Supply named
inline importSources (text or base64 bytes) to enable it; filesystem paths are not accepted.
Nested JSON/CSV subtable mutation is fail-closed on MCP: use VALIDATE ONLY/EXPLAIN.
JSON child IDs are rejected and replacement renumbers all rows.
`);
}

/** esbuild の define(build-mcp.mjs)で package.json の version が埋め込まれる。
 *  バンドル外(ts-jest 等)では未定義のため typeof ガードでフォールバックする */
declare const __KSQL_VERSION__: string;
const SERVER_VERSION = typeof __KSQL_VERSION__ === "string" ? __KSQL_VERSION__ : "0.0.0-dev";

export function createServer(args: ServerArgs): McpServer {
  const server = new McpServer({
    name: "ksql-mcp",
    version: SERVER_VERSION,
  });
  const tools = createKsqlMcpTools({
    configPath: args.configPath,
    profile: args.profile,
  });

  server.registerTool("ksql_validate", {
    title: "Validate kSQL",
    description: "Parse and validate kSQL without calling kintone APIs. Use this before executing generated SQL. IMPORT CSV/JSON is enabled only when named inline importSources are supplied.",
    inputSchema: validateInputShape,
  }, tools.validateTool);

  server.registerTool("ksql_explain", {
    title: "Explain kSQL",
    description: "Return the schema-aware kSQL execution plan. Reads form metadata and, when needed, process status metadata; never reads or writes records. IMPORT CSV/JSON is enabled only when named inline importSources are supplied.",
    inputSchema: explainInputShape,
  }, tools.explainTool);

  server.registerTool("ksql_query", {
    title: "Run read-only kSQL",
    description: "Execute read-only kSQL: SELECT, WITH, UNION, EXPLAIN, SHOW APPS, DESCRIBE, ASSERT, leading VALIDATE app existing-record audits, and INSERT/UPSERT/UPDATE ... VALIDATE ONLY. ASSERT failure always stops the batch. Local ORDER BY plans require complete input and fail instead of returning a truncated top-N; REST top-N and KORDER_NATIVE do not fetch a partial candidate set. VALIDATE and VALIDATE ONLY always treat onLimit=truncate as error and perform zero write API calls. UPDATE APPLY VALIDATE ONLY evaluates dmlMaxSubtableRows with the fixed default 500; ksql_query does not expose an override. Existing-record VALIDATE applies built-in form constraints plus optional CHECK groups and can materialize its fixed five diagnostic columns with INTO #err in a batch. NUMBER targets use the app numberPrecision settings for integer-digit validation and fail closed if settings cannot be read. Excess fractional digits pass through for kintone to round automatically. Supports multi-statement batches with temp tables, including VALIDATE ONLY INTO #err for later SELECT. APPLY mutation remains fail-closed; mutating DML is rejected.",
    inputSchema: queryInputShape,
  }, tools.queryTool);

  server.registerTool("ksql_mutate", {
    title: "Run mutating kSQL (IMPORT CSV/JSON via importSources)",
    description: "Execute DML kSQL with explicit allowDml, confirmText, and dmlMaxRows safety controls. APPLY mutation is always rejected by MCP v1 before runtime or records API creation; dmlMaxSubtableRows does not enable it. Supports multi-statement DML batches with temp tables. ON ERROR SKIP INTO #err optionally isolates local Tier-0 validation failures and writes only valid rows; REJECT LIMIT stops with zero writes while returning diagnostics. NUMBER targets use the destination app numberPrecision settings for integer-digit validation in normal, validation-only, and skip paths; settings failures are fail-closed. Excess fractional digits pass through for kintone to round automatically. INSERT/UPSERT INTO app ... SELECT supports app sources, temp tables, or joins of both. UPDATE ... FROM supports copying scalar fields from an app or temp table by matching target $id or a single-line-text/number business key to one source key. For UPSERT, dmlMaxRows counts inserts + updates. dmlMaxRows caps affected rows only, not source reads: source SELECT, ON ERROR SKIP candidates, and UPDATE ... FROM app reads use the runtime maxRecords (KSQL_MAX_RECORDS / profile query.maxRecords, default 500); temp tables hold at most 10000 rows by default (adjustable via tempTableMaxRows).",
    inputSchema: mutateInputShape,
  }, tools.mutateTool);

  server.registerTool("ksql_describe_app", {
    title: "Describe kintone app",
    description: "Return field definitions for a kintone app using DESCRIBE APPxxx.",
    inputSchema: describeAppInputShape,
  }, tools.describeAppTool);

  server.registerTool("ksql_show_apps", {
    title: "Show kintone apps",
    description: "Return the app list for the selected profile using SHOW APPS.",
    inputSchema: showAppsInputShape,
  }, tools.showAppsTool);

  server.registerTool("ksql_save_query", {
    title: "Save kSQL query",
    description: "Save a validated kSQL statement into the local saved query catalog.",
    inputSchema: saveQueryInputShape,
  }, tools.saveQueryTool);

  server.registerTool("ksql_list_queries", {
    title: "List saved kSQL queries",
    description: "List saved kSQL query metadata from the local saved query catalog.",
    inputSchema: listQueriesInputShape,
  }, tools.listQueriesTool);

  server.registerTool("ksql_get_query", {
    title: "Get saved kSQL query",
    description: "Return a saved kSQL query, including SQL text, by name.",
    inputSchema: savedQueryNameInputShape,
  }, tools.getQueryTool);

  server.registerTool("ksql_run_saved_query", {
    title: "Run saved kSQL query",
    description: "Run a saved kSQL query. Read-only queries use ksql_query safety; DML queries require ksql_mutate safety inputs.",
    inputSchema: runSavedQueryInputShape,
  }, tools.runSavedQueryTool);

  server.registerTool("ksql_delete_query", {
    title: "Delete saved kSQL query",
    description: "Delete a saved kSQL query from the local saved query catalog.",
    inputSchema: savedQueryNameInputShape,
  }, tools.deleteQueryTool);

  return server;
}

export async function main(): Promise<void> {
  const args = parseServerArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const server = createServer(args);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
