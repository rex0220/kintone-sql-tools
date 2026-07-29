#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport as LegacyStdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Client as ModernClient } from "@modelcontextprotocol/client";
import { StdioClientTransport as ModernStdioClientTransport } from "@modelcontextprotocol/client/stdio";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = resolve(rootDir, "dist-mcp", "ksql-mcp.js");
const packageVersion = JSON.parse(
  readFileSync(resolve(rootDir, "package.json"), "utf8")
).version;
const expectedTools = [
  "ksql_validate",
  "ksql_explain",
  "ksql_query",
  "ksql_mutate",
  "ksql_describe_app",
  "ksql_app_metadata",
  "ksql_show_apps",
  "ksql_docs",
  "ksql_save_query",
  "ksql_list_queries",
  "ksql_get_query",
  "ksql_run_saved_query",
  "ksql_delete_query",
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function serverParams() {
  return {
    command: process.execPath,
    args: [serverPath],
    cwd: rootDir,
    stderr: "pipe",
  };
}

async function assertResourceNotFound(client, era) {
  const uri = `ksql://missing-${era}`;
  try {
    await client.readResource({ uri });
    throw new Error(`${era} resource-not-found path unexpectedly succeeded.`);
  } catch (error) {
    assert(error?.code === -32602, `${era} resource-not-found must preserve code -32602.`);
    assert(error?.data?.uri === uri, `${era} resource-not-found must preserve data.uri.`);
  }
}

async function smokeLegacy() {
  const transport = new LegacyStdioClientTransport(serverParams());
  transport.stderr?.on("data", (chunk) => process.stderr.write(chunk));
  const client = new LegacyClient(
    { name: "ksql-mcp-v1-smoke", version: "0.0.1" },
    { capabilities: {} }
  );
  try {
    await client.connect(transport);
    const [tools, resources, templates] = await Promise.all([
      client.listTools(),
      client.listResources(),
      client.listResourceTemplates(),
    ]);
    assert(
      JSON.stringify(tools.tools.map((tool) => tool.name)) === JSON.stringify(expectedTools),
      "v1 initialize path must expose all 13 tools in registration order."
    );
    assert(resources.resources.length === 2, "v1 initialize path must expose 2 static resources.");
    assert(templates.resourceTemplates.length === 2, "v1 initialize path must expose 2 resource templates.");
    assert(
      client.getServerVersion()?.version === packageVersion,
      "v1 initialize path must report the package version."
    );
    await assertResourceNotFound(client, "v1");
    const instructions = client.getInstructions();
    assert(typeof instructions === "string" && instructions.length > 0, "v1 initialize instructions are missing.");
    return instructions;
  } finally {
    await client.close();
  }
}

async function smokeModern(legacyInstructions) {
  const transport = new ModernStdioClientTransport(serverParams());
  transport.stderr?.on("data", (chunk) => process.stderr.write(chunk));
  const client = new ModernClient(
    { name: "ksql-mcp-v2-smoke", version: "0.0.1" },
    {
      capabilities: {},
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    }
  );
  try {
    await client.connect(transport);
    const discover = client.getDiscoverResult();
    assert(client.getProtocolEra() === "modern", "v2 path must negotiate the modern protocol era.");
    assert(
      discover?.instructions === legacyInstructions,
      "server/discover must expose the complete instructions text used by v1 initialize."
    );
    const [tools, resources, templates] = await Promise.all([
      client.listTools(),
      client.listResources(),
      client.listResourceTemplates(),
    ]);
    assert(
      JSON.stringify(tools.tools.map((tool) => tool.name)) === JSON.stringify(expectedTools),
      "v2 tools/list must expose all 13 tools in registration order."
    );
    assert(resources.resources.length === 2, "v2 discover path must expose 2 static resources.");
    assert(templates.resourceTemplates.length === 2, "v2 discover path must expose 2 resource templates.");
    await assertResourceNotFound(client, "v2");
  } finally {
    await client.close();
  }
}

const legacyInstructions = await smokeLegacy();
await smokeModern(legacyInstructions);
console.log("[mcp-dual-era-smoke] v1 initialize + v2 server/discover: ok");
