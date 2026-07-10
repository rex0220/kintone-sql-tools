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
    description: "Parse and validate kSQL without calling kintone APIs. Use this before executing generated SQL.",
    inputSchema: validateInputShape,
  }, tools.validateTool);

  server.registerTool("ksql_explain", {
    title: "Explain kSQL",
    description: "Return the kSQL execution plan without calling kintone APIs.",
    inputSchema: explainInputShape,
  }, tools.explainTool);

  server.registerTool("ksql_query", {
    title: "Run read-only kSQL",
    description: "Execute read-only kSQL: SELECT, WITH, UNION, EXPLAIN, SHOW APPS, DESCRIBE. Supports multi-statement batches with temp tables (CREATE TEMP TABLE #t AS SELECT ...; SELECT ... FROM #t;). DML is rejected.",
    inputSchema: queryInputShape,
  }, tools.queryTool);

  server.registerTool("ksql_mutate", {
    title: "Run mutating kSQL",
    description: "Execute DML kSQL with explicit allowDml, confirmText, and dmlMaxRows safety controls. Supports multi-statement DML batches with temp tables. INSERT INTO app ... SELECT is supported (single statement or batch); the source may be apps or temp tables, but not both in one statement. The source SELECT reads at most dmlMaxRows + 1 records. UPSERT ... SELECT is rejected.",
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
