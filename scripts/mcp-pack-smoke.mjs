#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmpRoot = resolve(rootDir, ".tmp");
const tmpDir = resolve(tmpRoot, `mcp-pack-smoke-${process.pid}`);
const npmExecPath = process.env.npm_execpath;
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const expectedTools = [
  "ksql_validate",
  "ksql_explain",
  "ksql_query",
  "ksql_mutate",
  "ksql_describe_app",
  "ksql_app_metadata",
  "ksql_show_apps",
  "ksql_save_query",
  "ksql_list_queries",
  "ksql_get_query",
  "ksql_run_saved_query",
  "ksql_delete_query",
];
const metadataResources = [
  "app",
  "fields",
  "layout",
  "settings",
  "status",
  "views",
  "reports",
  "customize",
];
const forbiddenMetadataInputs = ["url", "path", "method", "body", "query", "ids"];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function ensureInsideRoot(target) {
  const resolved = resolve(target);
  assert(
    resolved === rootDir || resolved.startsWith(`${rootDir}\\`) || resolved.startsWith(`${rootDir}/`),
    `Refusing to touch outside repository: ${resolved}`
  );
  return resolved;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? rootDir,
    input: options.input,
    encoding: "utf8",
    shell: options.shell ?? false,
    windowsHide: true,
  });

  if (result.error || result.status !== 0) {
    const output = [
      result.error?.message,
      result.stdout?.trim(),
      result.stderr?.trim(),
    ].filter(Boolean).join("\n");
    throw new Error(`Command failed: ${command} ${args.join(" ")}\n${output}`);
  }
  return result;
}

function runNpm(args, options = {}) {
  if (npmExecPath && existsSync(npmExecPath)) {
    return run(process.execPath, [npmExecPath, ...args], options);
  }
  return run(npmCmd, args, { ...options, shell: process.platform === "win32" });
}

function parsePackFilename(stdout) {
  const trimmed = stdout.trim();
  const jsonStart = trimmed.indexOf("[");
  const jsonEnd = trimmed.lastIndexOf("]");
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    try {
      const parsed = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1));
      if (Array.isArray(parsed) && parsed[0]?.filename) return parsed[0].filename;
    } catch {
      // Fall back to line parsing below.
    }
  }

  const tgzLine = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .reverse()
    .find((line) => line.endsWith(".tgz"));
  assert(tgzLine, `Could not determine npm pack filename from output:\n${stdout}`);
  return tgzLine;
}

function readJsonLines(stdout) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function assertPackedMetadataTool(tools) {
  const metadata = tools.find((tool) => tool.name === "ksql_app_metadata");
  assert(metadata, "Packed ksql_app_metadata tool is missing.");
  const schema = metadata.inputSchema ?? {};
  const props = schema.properties ?? {};
  assert(schema.type === "object", "Packed metadata input schema must be an object.");
  assert(schema.additionalProperties === false, "Packed metadata input schema must be strict.");
  assert(
    JSON.stringify([...(schema.required ?? [])].sort()) === JSON.stringify(["app", "resource"]),
    "Packed metadata schema must require exactly resource and app."
  );
  assert(
    JSON.stringify(Object.keys(props).sort())
      === JSON.stringify(["app", "lang", "preview", "profile", "resource"]),
    "Packed metadata schema must expose only the branch keys resource/app/profile/preview/lang."
  );
  assert(
    JSON.stringify([...(props.resource?.enum ?? [])].sort())
      === JSON.stringify([...metadataResources].sort()),
    "Packed metadata resource enum must be the exact fixed eight-resource allowlist."
  );
  for (const key of forbiddenMetadataInputs) {
    assert(!(key in props), `Packed metadata schema must not expose ${key}.`);
  }
  for (const key of [
    "fields",
    "constraints",
    "raw",
    "read-only",
    "fixed GET allowlist",
    "records",
    "mutation",
  ]) {
    assert(
      typeof metadata.description === "string" && metadata.description.includes(key),
      `Packed ksql_app_metadata.description must mention "${key}".`
    );
  }
}

function assertPackedToolDescriptions(tools) {
  const required = {
    ksql_app_metadata: [
      "fields", "constraints", "raw", "read-only", "fixed GET allowlist", "records", "mutation",
    ],
    ksql_describe_app: ["field code", "label", "type", "ksql_app_metadata"],
    ksql_query: ["ksql://language-reference"],
    ksql_mutate: ["ksql://language-reference"],
  };
  for (const [toolName, keys] of Object.entries(required)) {
    const description = tools.find((tool) => tool.name === toolName)?.description;
    for (const key of keys) {
      assert(
        typeof description === "string" && description.includes(key),
        `Packed ${toolName}.description must mention "${key}".`
      );
    }
  }
}

function assertPackedMetadataSchemaError(message, label) {
  const text = message?.result?.content?.find((item) => item.type === "text")?.text ?? "";
  assert(message?.result?.isError === true, `${label} must return isError=true.`);
  assert(message?.result?.structuredContent === undefined, `${label} must fail before the metadata handler.`);
  assert(
    text.includes("MCP error -32602")
      && text.includes("Input validation error")
      && text.includes("ksql_app_metadata"),
    `${label} must return the packed JSON-RPC schema error envelope.`
  );
}

function cleanup(paths) {
  for (const target of paths) {
    if (!target || !existsSync(target)) continue;
    rmSync(ensureInsideRoot(target), { recursive: true, force: true });
  }
}

let tarballPath = null;

try {
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(
    resolve(tmpDir, "package.json"),
    JSON.stringify({ private: true, name: "ksql-mcp-pack-smoke" }, null, 2),
    "utf8"
  );

  const packed = runNpm(["pack", "--json"]);
  const filename = parsePackFilename(packed.stdout);
  tarballPath = resolve(rootDir, filename);
  assert(existsSync(tarballPath), `npm pack did not create ${tarballPath}.`);

  runNpm(["install", "--omit=dev", tarballPath], { cwd: tmpDir });

  assert(
    !existsSync(resolve(tmpDir, "node_modules", "@modelcontextprotocol")),
    "@modelcontextprotocol should not be installed in an --omit=dev consumer install."
  );
  assert(
    !existsSync(resolve(tmpDir, "node_modules", "zod")),
    "zod should not be installed in an --omit=dev consumer install."
  );

  const packageDir = resolve(tmpDir, "node_modules", "@rex0220", "kintone-sql-tools");
  const installedPackageJson = JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8"));
  assert(!installedPackageJson.dependencies, "Published package should not declare runtime dependencies.");

  const serverPath = resolve(packageDir, "dist-mcp", "ksql-mcp.js");
  run(process.execPath, [serverPath, "--help"], { cwd: tmpDir });

  const rpcInput = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "mcp-pack-smoke", version: "0.0.1" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "ksql_validate",
        arguments: { sql: "SELECT 'ok' AS result" },
      },
    },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "ksql_validate",
        arguments: {
          sql: "UPSERT INTO APP4221 (key) VALUES ('K1') ON DUPLICATE (key) ON UPDATE APPLY テーブル (REMOVE ALL ROWS) VALIDATE ONLY",
        },
      },
    },
    {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "ksql_mutate",
        arguments: {
          sql: "UPSERT INTO APP4221 (key) VALUES ('K1') ON DUPLICATE (key) ON INSERT APPLY テーブル (APPEND (子) VALUES ('new'))",
          allowDml: true,
          confirmText: "yes",
          dmlMaxRows: 100,
          dmlMaxSubtableRows: 999,
        },
      },
    },
    {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "ksql_app_metadata",
        arguments: {
          resource: "records",
          app: 1,
          method: "POST",
          path: "/k/v1/records.json",
        },
      },
    },
    {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "ksql_app_metadata",
        arguments: { resource: "app", app: 1, preview: true },
      },
    },
    {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "ksql_app_metadata",
        arguments: { resource: "layout", app: 1, lang: "ja" },
      },
    },
  ].map((msg) => JSON.stringify(msg)).join("\n") + "\n";

  const rpc = run(process.execPath, [serverPath], { cwd: tmpDir, input: rpcInput });
  const messages = readJsonLines(rpc.stdout);
  const initialized = messages.find((message) => message.id === 1);
  const instructions = initialized?.result?.instructions;
  assert(typeof instructions === "string" && instructions.trim().length > 0, "Packed initialize instructions are missing.");
  for (const key of [
    "not generic SQL",
    "VALIDATE ONLY",
    "ksql_app_metadata",
    "ksql://language-reference",
    "APPLY mutation is disabled",
  ]) {
    assert(instructions.includes(key), `Packed initialize instructions must mention "${key}".`);
  }
  const listed = messages.find((message) => message.id === 2);
  assert(Array.isArray(listed?.result?.tools), "Packed tools/list response is missing.");
  const packedToolNames = listed.result.tools.map((tool) => tool.name).sort();
  assert(
    JSON.stringify(packedToolNames) === JSON.stringify([...expectedTools].sort()),
    `Unexpected packed tool list: ${packedToolNames.join(", ")}`
  );
  assertPackedMetadataTool(listed.result.tools);
  assertPackedToolDescriptions(listed.result.tools);
  const validation = messages.find((message) => message.id === 3);
  assert(validation?.result?.structuredContent?.ok === true, "Packed ksql_validate smoke failed.");
  const applyValidation = messages.find((message) => message.id === 4);
  assert(
    applyValidation?.result?.structuredContent?.ok === true
      && applyValidation.result.structuredContent.isReadOnly === true,
    "Packed APPLY VALIDATE ONLY smoke failed."
  );
  const applyMutation = messages.find((message) => message.id === 5);
  assert(
    applyMutation?.result?.structuredContent?.ok === false
      && applyMutation.result.structuredContent.error?.code === "UnsupportedError"
      && applyMutation.result.structuredContent.error?.message?.includes("MCP v3.8.0"),
    "Packed APPLY mutation must fail closed before runtime."
  );
  assertPackedMetadataSchemaError(
    messages.find((message) => message.id === 6),
    "Packed metadata arbitrary HTTP attack"
  );
  assertPackedMetadataSchemaError(
    messages.find((message) => message.id === 7),
    "Packed metadata app preview branch"
  );
  assertPackedMetadataSchemaError(
    messages.find((message) => message.id === 8),
    "Packed metadata layout lang branch"
  );

  process.stdout.write("[mcp-pack-smoke] ok\n");
} catch (err) {
  process.stderr.write(`[mcp-pack-smoke] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
} finally {
  cleanup([tmpDir, tarballPath]);
}
