#!/usr/bin/env node

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  KSQL_DOCS,
  LANGUAGE_SECTION_KEYS,
  RECIPE_KEYS,
} from "./docsResources";
import { createKsqlMcpTools } from "./tools";
import {
  describeAppInputShape,
  explainInputShape,
  listQueriesInputShape,
  ksqlAppMetadataInputShape,
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

export const KSQL_MCP_INSTRUCTIONS = `kSQL is a SQL-like dialect for kintone, not generic SQL. It supports SELECT,
JOIN, aggregates, CTEs, UNION, ROW_NUMBER/RANK/DENSE_RANK, GROUP_CONCAT,
INSERT/UPDATE/UPSERT/DELETE, UPDATE ... FROM, subtable virtual tables
(APPxxx$table with _pid/_rid/_idx), REORDER, IMPORT, VALIDATE/VALIDATE ONLY,
ON ERROR SKIP, CHECK, KLIKE, KORDER BY, and multi-statement batches with temp
tables and SET/DECLARE @variables. LAPP_<NAME> resolves logical apps.

Important dialect rules: LIKE/NOT LIKE uses JavaScript semantics and is not a
kintone-native predicate; JOIN ON accepts one equality only; FROM (SELECT ...)
derived tables are unsupported (use WITH or a temp table); numeric arithmetic
treats an empty cell as 0. APPLY syntax can be validated/explained and used with
VALIDATE ONLY, but APPLY mutation is disabled by this MCP server.

Validate generated syntax with ksql_validate before execution. For DML form/data
preflight, execute the statement with VALIDATE ONLY through ksql_query before
ksql_mutate. Use ksql_app_metadata (especially resource=fields/settings) to
inspect raw app constraints before generating SQL or DML. Read
ksql://language-reference and ksql://recipes for section indexes, then read only
the relevant section resource.`;

const MARKDOWN_MIME_TYPE = "text/markdown";

function staticTextResource(uri: string, text: string) {
  return { contents: [{ uri, mimeType: MARKDOWN_MIME_TYPE, text }] };
}

function requiredTemplateKey(value: string | string[], kind: string): string {
  if (typeof value !== "string") {
    throw new McpError(ErrorCode.InvalidParams, `Invalid ${kind} resource key.`);
  }
  return value;
}

function invalidResourceKey(kind: string, key: string): never {
  throw new McpError(ErrorCode.InvalidParams, `Unknown kSQL ${kind} resource key: ${key}`);
}

export function createServer(args: ServerArgs): McpServer {
  const server = new McpServer(
    {
      name: "ksql-mcp",
      version: SERVER_VERSION,
    },
    { instructions: KSQL_MCP_INSTRUCTIONS }
  );
  const tools = createKsqlMcpTools({
    configPath: args.configPath,
    profile: args.profile,
  });

  server.registerTool("ksql_validate", {
    title: "Validate kSQL",
    description: "Parse and validate kSQL without calling kintone APIs. All APPLY forms (UPDATE/INSERT/UPSERT/multi-value) are accepted for syntax and static validation, but this does not enable APPLY mutation. Use this before executing generated SQL. IMPORT CSV/JSON is enabled only when named inline importSources are supplied.",
    inputSchema: validateInputShape,
  }, tools.validateTool);

  server.registerTool("ksql_explain", {
    title: "Explain kSQL",
    description: "Return the schema-aware kSQL execution plan, including every APPLY form (UPDATE/INSERT/UPSERT/multi-value). Reads form metadata and, when needed, process status metadata; never calls records or mutation APIs. IMPORT CSV/JSON is enabled only when named inline importSources are supplied.",
    inputSchema: explainInputShape,
  }, tools.explainTool);

  server.registerTool("ksql_query", {
    title: "Run read-only kSQL",
    description: "Execute read-only kSQL: SELECT, WITH, UNION, EXPLAIN, SHOW APPS, DESCRIBE, ASSERT, leading VALIDATE app existing-record audits, and INSERT/UPSERT/UPDATE ... VALIDATE ONLY. ASSERT failure always stops the batch. Local ORDER BY plans require complete input and fail instead of returning a truncated top-N; REST top-N and KORDER_NATIVE do not fetch a partial candidate set. VALIDATE and VALIDATE ONLY always treat onLimit=truncate as error and perform zero write API calls. UPDATE/INSERT/UPSERT/multi-value APPLY VALIDATE ONLY evaluates dmlMaxSubtableRows with the fixed default 500; ksql_query does not expose an override. Existing-record VALIDATE applies built-in form constraints plus optional CHECK groups and can materialize its fixed five diagnostic columns with INTO #err in a batch. NUMBER targets use the app numberPrecision settings for integer-digit validation and fail closed if settings cannot be read. Excess fractional digits pass through for kintone to round automatically. Supports multi-statement batches with temp tables, including VALIDATE ONLY INTO #err for later SELECT. APPLY mutation remains fail-closed; mutating DML is rejected. For kSQL dialect details, follow the server instructions and read ksql://language-reference.",
    inputSchema: queryInputShape,
  }, tools.queryTool);

  server.registerTool("ksql_mutate", {
    title: "Run mutating kSQL (IMPORT CSV/JSON via importSources)",
    description: "Execute DML kSQL with explicit allowDml, confirmText, and dmlMaxRows safety controls. Every APPLY mutation form (UPDATE/INSERT/UPSERT/multi-value) is always rejected by MCP v3.8.0 before runtime or records API creation; allowDml and dmlMaxSubtableRows do not enable it. Supports multi-statement DML batches with temp tables. ON ERROR SKIP INTO #err optionally isolates local Tier-0 validation failures and writes only valid rows; REJECT LIMIT stops with zero writes while returning diagnostics. NUMBER targets use the destination app numberPrecision settings for integer-digit validation in normal, validation-only, and skip paths; settings failures are fail-closed. Excess fractional digits pass through for kintone to round automatically. INSERT/UPSERT INTO app ... SELECT supports app sources, temp tables, or joins of both. UPDATE ... FROM supports copying scalar fields from an app or temp table by matching target $id or a single-line-text/number business key to one source key. For UPSERT, dmlMaxRows counts inserts + updates. dmlMaxRows caps affected rows only, not source reads: source SELECT, ON ERROR SKIP candidates, and UPDATE ... FROM app reads use the runtime maxRecords (KSQL_MAX_RECORDS / profile query.maxRecords, default 500); temp tables hold at most 10000 rows by default (adjustable via tempTableMaxRows). For kSQL dialect details, follow the server instructions and read ksql://language-reference.",
    inputSchema: mutateInputShape,
  }, tools.mutateTool);

  server.registerTool("ksql_describe_app", {
    title: "Describe kintone app",
    description: "Return kSQL's compact field list (field code, label, and type) for a kintone app. For complete raw field constraints, layout, settings, status, views, reports, or customize metadata, use ksql_app_metadata.",
    inputSchema: describeAppInputShape,
  }, tools.describeAppTool);

  server.registerTool("ksql_app_metadata", {
    title: "Get kintone app metadata",
    description: "Inspect raw read-only kintone app metadata before generating SQL or DML: app, fields (constraints and field properties), layout, settings, status, views, reports, and customize. This is the primary route for constraints not included in ksql_describe_app. Returns raw JSON through a fixed GET allowlist; records and mutation operations are not available.",
    inputSchema: ksqlAppMetadataInputShape,
  }, tools.appMetadataTool);

  server.registerTool("ksql_show_apps", {
    title: "Show kintone apps",
    description:
      "Return the full app list (id, name, description) for the selected profile using SHOW APPS. This enumerates every app and can be large on big domains; use it only to discover an unknown app id by name. When you already know the target app, fetch just that one with ksql_app_metadata (resource=app for basics via GET /k/v1/app.json, or fields/settings for constraints) instead of listing all apps.",
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

  server.registerResource("ksql-language-reference", "ksql://language-reference", {
    description: "Index of kSQL syntax, dialect rules, and section resources.",
    mimeType: MARKDOWN_MIME_TYPE,
  }, () => staticTextResource("ksql://language-reference", KSQL_DOCS.languageReference.index));

  server.registerResource("ksql-recipes", "ksql://recipes", {
    description: "Index of safe, rerunnable kSQL batch recipes.",
    mimeType: MARKDOWN_MIME_TYPE,
  }, () => staticTextResource("ksql://recipes", KSQL_DOCS.recipes.index));

  server.registerResource(
    "ksql-language-reference-section",
    new ResourceTemplate("ksql://language-reference/{section}", {
      list: undefined,
      complete: {
        section: (value) => LANGUAGE_SECTION_KEYS.filter((key) => key.startsWith(value)),
      },
    }),
    {
      description: "One allowlisted chapter of the embedded kSQL language reference.",
      mimeType: MARKDOWN_MIME_TYPE,
    },
    (uri, variables) => {
      const key = requiredTemplateKey(variables.section, "language-reference section");
      const section = KSQL_DOCS.languageReference.sections[key];
      if (!section) invalidResourceKey("language-reference section", key);
      return staticTextResource(uri.href, section.text);
    }
  );

  server.registerResource(
    "ksql-recipe",
    new ResourceTemplate("ksql://recipes/{recipe}", {
      list: undefined,
      complete: {
        recipe: (value) => RECIPE_KEYS.filter((key) => key.startsWith(value)),
      },
    }),
    {
      description: "One allowlisted chapter of the embedded kSQL batch recipes.",
      mimeType: MARKDOWN_MIME_TYPE,
    },
    (uri, variables) => {
      const key = requiredTemplateKey(variables.recipe, "recipe");
      const recipe = KSQL_DOCS.recipes.sections[key];
      if (!recipe) invalidResourceKey("recipe", key);
      return staticTextResource(uri.href, recipe.text);
    }
  );

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
