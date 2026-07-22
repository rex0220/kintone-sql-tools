#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { assertResourceCatalog } from "./mcp-resource-smoke.mjs";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJson = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8"));
const mcpbPath = resolve(rootDir, "dist-mcpb", "ksql-mcp.mcpb");
const smokeDir = resolve(rootDir, ".tmp", "mcpb-verify");
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

function readZipEntries(filePath) {
  const zip = readFileSync(filePath);
  const eocdOffset = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert(eocdOffset >= 0, "Missing ZIP end of central directory.");

  const entryCount = zip.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = zip.readUInt32LE(eocdOffset + 16);
  const entries = new Map();
  let offset = centralDirOffset;

  for (let i = 0; i < entryCount; i++) {
    assert(zip.readUInt32LE(offset) === 0x02014b50, "Invalid ZIP central directory header.");
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const uncompressedSize = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localHeaderOffset = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    assert(method === 0, `Unsupported ZIP compression method for ${name}.`);

    const localNameLength = zip.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = zip.readUInt16LE(localHeaderOffset + 28);
    const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const data = zip.subarray(dataOffset, dataOffset + compressedSize);
    assert(data.length === uncompressedSize, `ZIP size mismatch for ${name}.`);
    entries.set(name, data);

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

async function smokeLauncher(entries) {
  rmSync(smokeDir, { recursive: true, force: true });
  for (const path of ["server/index.js", "server/ksql-mcp.js"]) {
    const outPath = resolve(smokeDir, path);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, entries.get(path));
  }

  const client = new Client(
    { name: "ksql-mcpb-verify", version: "0.0.1" },
    { capabilities: {} }
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["-e", "require('./server/index.js')"],
    cwd: smokeDir,
    env: {
      ...process.env,
      KSQL_SAVED_QUERIES: resolve(smokeDir, "saved-queries.json"),
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => {
    process.stderr.write(chunk.toString());
  });

  try {
    await client.connect(transport);
    const instructions = client.getInstructions();
    assert(typeof instructions === "string" && instructions.trim().length > 0, "MCPB launcher instructions are missing.");
    for (const key of ["Statement templates", "ON ERROR SKIP INTO", "Complete function catalog"]) {
      assert(instructions.includes(key), `MCPB launcher instructions must mention "${key}".`);
    }
    const listed = await client.listTools();
    assert(
      JSON.stringify(listed.tools.map((tool) => tool.name)) === JSON.stringify(expectedTools),
      `MCPB launcher tool list mismatch: ${listed.tools.map((tool) => tool.name).join(", ")}`
    );
    const docs = await client.callTool({ name: "ksql_docs", arguments: {} });
    assert(docs.content?.length === 1 && docs.content[0]?.type === "text", "MCPB launcher ksql_docs must return one text item.");
    assert(!("structuredContent" in docs), "MCPB launcher ksql_docs success must be text-only.");
    assert(docs.content[0].text.includes("language-reference/05-string-number-functions"), "MCPB launcher ksql_docs index is incomplete.");
    await assertResourceCatalog(client, assert, { extended: false });
  } finally {
    await client.close().catch(() => {});
  }
}

async function main() {
  assert(existsSync(mcpbPath), `Missing ${mcpbPath}. Run npm run build:mcpb first.`);
  const entries = readZipEntries(mcpbPath);
  const required = [
    "manifest.json",
    "server/index.js",
    "server/ksql-mcp.js",
    "README.md",
    "LICENSE",
  ];
  for (const path of required) {
    assert(entries.has(path), `MCPB is missing ${path}.`);
  }

  const manifest = JSON.parse(entries.get("manifest.json").toString("utf8"));
  assert(manifest.manifest_version === "0.3", "Unexpected MCPB manifest_version.");
  assert(manifest.name === "ksql-mcp", "Unexpected MCPB name.");
  assert(manifest.version === packageJson.version, "Manifest version does not match package.json.");
  assert(manifest.server?.type === "node", "MCPB server.type must be node.");
  assert(manifest.server?.entry_point === "server/index.js", "Unexpected MCPB entry_point.");
  assert(manifest.server?.mcp_config?.command === "node", "Unexpected MCPB command.");
  assert(
    manifest.server?.mcp_config?.args?.includes("${user_config.configPath}"),
    "MCPB args must include ${user_config.configPath}."
  );
  assert(
    manifest.server?.mcp_config?.args?.includes("${__dirname}/server/index.js"),
    "MCPB args must launch server/index.js."
  );
  assert(manifest.user_config?.configPath?.type === "file", "configPath must use file picker type.");
  assert(manifest.user_config?.configPath?.required === true, "configPath must be required.");
  assert(
    JSON.stringify(manifest.tools?.map((tool) => tool.name)) === JSON.stringify(expectedTools),
    `MCPB manifest tool list mismatch: ${manifest.tools?.map((tool) => tool.name).join(", ")}`
  );
  const metadataTool = manifest.tools?.find((tool) => tool.name === "ksql_app_metadata");
  assert(metadataTool, "MCPB manifest must include ksql_app_metadata.");
  assert(
    typeof metadataTool.description === "string"
      && metadataTool.description.includes("raw")
      && metadataTool.description.includes("constraints"),
    "MCPB ksql_app_metadata description must be purpose-oriented."
  );
  const docsTool = manifest.tools?.find((tool) => tool.name === "ksql_docs");
  assert(docsTool, "MCPB manifest must include ksql_docs.");
  for (const key of ["read-only", "resources", "ksql_docs"]) {
    assert(
      typeof docsTool.description === "string" && docsTool.description.includes(key),
      `MCPB ksql_docs description must mention ${key}.`
    );
  }

  const launcher = entries.get("server/index.js").toString("utf8");
  assert(launcher.startsWith("#!/usr/bin/env node"), "MCPB launcher must keep the node shebang.");
  assert(launcher.includes('require("./ksql-mcp.js")'), "MCPB launcher must load the bundled server.");
  assert(launcher.includes("main().catch"), "MCPB launcher must call main() unconditionally.");

  const server = entries.get("server/ksql-mcp.js").toString("utf8");
  assert(server.startsWith("#!/usr/bin/env node"), "Bundled MCP server must keep the node shebang.");
  assert(!/require\(["']@modelcontextprotocol\/sdk/.test(server), "MCPB server contains external MCP SDK require.");
  assert(!/require\(["']zod(?:\/[^"']*)?["']\)/.test(server), "MCPB server contains external zod require.");

  await smokeLauncher(entries);

  process.stdout.write("[mcpb-verify] ok\n");
}

try {
  await main();
} catch (err) {
  process.stderr.write(`[mcpb-verify] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
