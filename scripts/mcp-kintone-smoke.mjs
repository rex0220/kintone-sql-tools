#!/usr/bin/env node

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return `Usage:
  node scripts/mcp-kintone-smoke.mjs --app <appId> [options]

Options:
  --config <path>          Config file path (default: KSQL_CONFIG or ./ksql.config.json)
  --profile <name>         Profile name (default: KSQL_PROFILE or dev)
  --app <appId>            App ID to describe/query (default: KSQL_SMOKE_APP or KSQL_APP)
  --server <path>          MCP server path (default: ./dist-mcp/ksql-mcp.js)
  --node <path>            Node executable for the MCP server (default: current node)
  --query <sql>            Query smoke SQL (default: SELECT $id FROM APP<app>@<profile> ORDER BY $id LIMIT 1)
  --include-show-apps      Also run ksql_show_apps (may require userpass or suitable token setup)
  -h, --help               Show help
`;
}

function parseArgs(argv) {
  const out = {
    config: process.env.KSQL_CONFIG ?? "./ksql.config.json",
    profile: process.env.KSQL_PROFILE ?? "dev",
    app: process.env.KSQL_SMOKE_APP ?? process.env.KSQL_APP ?? null,
    server: "./dist-mcp/ksql-mcp.js",
    node: process.execPath,
    query: null,
    includeShowApps: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "-h" || arg === "--help") {
      out.help = true;
      continue;
    }
    if (arg === "--include-show-apps") {
      out.includeShowApps = true;
      continue;
    }
    if (arg === "--config") {
      out.config = value ?? "";
      i++;
      continue;
    }
    if (arg === "--profile") {
      out.profile = value ?? "";
      i++;
      continue;
    }
    if (arg === "--app") {
      out.app = value ?? "";
      i++;
      continue;
    }
    if (arg === "--server") {
      out.server = value ?? "";
      i++;
      continue;
    }
    if (arg === "--node") {
      out.node = value ?? "";
      i++;
      continue;
    }
    if (arg === "--query") {
      out.query = value ?? "";
      i++;
      continue;
    }
    throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
  }

  return out;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function positiveInt(value, label) {
  const n = Number(value);
  assert(Number.isInteger(n) && n > 0, `${label} must be a positive integer.`);
  return n;
}

function ksqlEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("KSQL_") && value !== undefined) env[key] = value;
  }
  return env;
}

function assertToolOk(result, name) {
  const payload = result.structuredContent;
  if (payload?.ok !== true) {
    throw new Error(`${name} failed: ${JSON.stringify(payload ?? result, null, 2)}`);
  }
  return payload;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }

  const appId = positiveInt(args.app, "--app");
  const configPath = resolve(rootDir, args.config);
  const serverPath = resolve(rootDir, args.server);
  const nodePath = args.node;
  const profile = args.profile;
  const query = args.query
    ?? `SELECT $id FROM APP${appId}@${profile} ORDER BY $id LIMIT 1`;

  assert(existsSync(serverPath), `Missing ${serverPath}. Run npm run build:mcp first.`);
  assert(existsSync(configPath), `Missing config file: ${configPath}`);

  const transport = new StdioClientTransport({
    command: nodePath,
    args: [
      serverPath,
      "--config",
      configPath,
      "--profile",
      profile,
    ],
    cwd: rootDir,
    env: ksqlEnv(),
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => {
    process.stderr.write(chunk.toString());
  });

  const client = new Client(
    { name: "ksql-mcp-kintone-smoke", version: "0.0.1" },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);

    const described = await client.callTool({
      name: "ksql_describe_app",
      arguments: {
        app: appId,
        profile,
        maxRecords: 500,
        onLimit: "error",
      },
    });
    const describePayload = assertToolOk(described, "ksql_describe_app");
    process.stdout.write(
      `[mcp-kintone-smoke] describe app=${appId} rows=${describePayload.rowCount ?? "?"}\n`
    );

    const queried = await client.callTool({
      name: "ksql_query",
      arguments: {
        sql: query,
        profile,
        maxRecords: 10,
        onLimit: "error",
      },
    });
    const queryPayload = assertToolOk(queried, "ksql_query");
    process.stdout.write(
      `[mcp-kintone-smoke] query rows=${queryPayload.rowCount ?? "?"} sql=${query}\n`
    );

    if (args.includeShowApps) {
      const shown = await client.callTool({
        name: "ksql_show_apps",
        arguments: {
          profile,
          maxRecords: 500,
          onLimit: "error",
        },
      });
      const showPayload = assertToolOk(shown, "ksql_show_apps");
      process.stdout.write(
        `[mcp-kintone-smoke] show_apps rows=${showPayload.rowCount ?? "?"}\n`
      );
    }

    process.stdout.write("[mcp-kintone-smoke] ok\n");
  } finally {
    await client.close().catch(() => {});
  }
}

main().catch((err) => {
  process.stderr.write(`[mcp-kintone-smoke] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
