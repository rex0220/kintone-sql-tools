#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  RESOURCE_INDEX_URIS,
  RESOURCE_TEMPLATE_URIS,
  indexedUris,
  chapterUri,
  textResource,
} from "./mcp-resource-smoke.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { buildDocsResourceMap } = require("../src/mcp/docsResourceBuilder.cjs");
const sourceDocs = buildDocsResourceMap(
  readFileSync(resolve(rootDir, "docs", "ksql_language_reference.md"), "utf8"),
  readFileSync(resolve(rootDir, "docs", "ksql_batch_recipes.md"), "utf8")
);
const docsSectionKeys = [
  "language-reference",
  ...Object.keys(sourceDocs.languageReference.sections).map((key) => `language-reference/${key}`),
  "recipes",
  ...Object.keys(sourceDocs.recipes.sections).map((key) => `recipes/${key}`),
];
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
  "ksql_docs",
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
    ksql_validate: ["Do not use validate probing", "call ksql_docs instead"],
    ksql_query: ["ksql://language-reference", "ksql_docs when resources are unavailable"],
    ksql_mutate: ["ksql://language-reference", "ksql_docs when resources are unavailable"],
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
  assert(!existsSync(resolve(packageDir, "docs")), "Packed package must not contain docs/.");
  const installedPackageJson = JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8"));
  assert(!installedPackageJson.dependencies, "Published package should not declare runtime dependencies.");

  const serverPath = resolve(packageDir, "dist-mcp", "ksql-mcp.js");
  run(process.execPath, [serverPath, "--help"], { cwd: tmpDir });

  let nextRequestId = 1;
  const requestIds = new Map();
  const request = (name, method, params) => {
    const id = nextRequestId++;
    requestIds.set(name, id);
    return { jsonrpc: "2.0", id, method, params };
  };
  const rpcInput = [
    request("initialize", "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mcp-pack-smoke", version: "0.0.1" },
    }),
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    request("tools-list", "tools/list", {}),
    request("validate", "tools/call", {
      name: "ksql_validate", arguments: { sql: "SELECT 'ok' AS result" },
    }),
    request("apply-validation", "tools/call", {
      name: "ksql_validate",
      arguments: {
        sql: "UPSERT INTO APP4221 (key) VALUES ('K1') ON DUPLICATE (key) ON UPDATE APPLY テーブル (REMOVE ALL ROWS) VALIDATE ONLY",
      },
    }),
    request("apply-mutation", "tools/call", {
      name: "ksql_mutate",
      arguments: {
        sql: "UPSERT INTO APP4221 (key) VALUES ('K1') ON DUPLICATE (key) ON INSERT APPLY テーブル (APPEND (子) VALUES ('new'))",
        allowDml: true,
        confirmText: "yes",
        dmlMaxRows: 100,
        dmlMaxSubtableRows: 999,
      },
    }),
    request("metadata-http-attack", "tools/call", {
      name: "ksql_app_metadata",
      arguments: { resource: "records", app: 1, method: "POST", path: "/k/v1/records.json" },
    }),
    request("metadata-app-preview", "tools/call", {
      name: "ksql_app_metadata", arguments: { resource: "app", app: 1, preview: true },
    }),
    request("metadata-layout-lang", "tools/call", {
      name: "ksql_app_metadata", arguments: { resource: "layout", app: 1, lang: "ja" },
    }),
    request("resources-list", "resources/list", {}),
    request("resource-templates-list", "resources/templates/list", {}),
    request("language-index-resource", "resources/read", { uri: "ksql://language-reference" }),
    request("select-resource", "resources/read", { uri: "ksql://language-reference/02-select" }),
    request("recipe-resource", "resources/read", { uri: "ksql://recipes/r3" }),
    request("docs-index", "tools/call", { name: "ksql_docs", arguments: {} }),
    ...docsSectionKeys.map((section) => request(`docs:${section}`, "tools/call", {
      name: "ksql_docs", arguments: { section },
    })),
    request("docs-unknown", "tools/call", {
      name: "ksql_docs", arguments: { section: "STDDEV" },
    }),
  ].map((msg) => JSON.stringify(msg)).join("\n") + "\n";

  const rpc = run(process.execPath, [serverPath], { cwd: tmpDir, input: rpcInput });
  const messages = readJsonLines(rpc.stdout);
  const response = (name) => messages.find((message) => message.id === requestIds.get(name));
  const initialized = response("initialize");
  const instructions = initialized?.result?.instructions;
  assert(typeof instructions === "string" && instructions.trim().length > 0, "Packed initialize instructions are missing.");
  for (const key of [
    "not generic SQL",
    "VALIDATE ONLY",
    "ksql_app_metadata",
    "ksql://language-reference",
    "APPLY mutation is disabled",
    "ksql_docs",
    "Complete function catalog",
    "CURRENT_TIMESTAMP",
    "GROUP_CONCAT",
    "DENSE_RANK",
    "LOGINUSER",
    "SUBSTR→SUBSTRING",
    "IFNULL",
  ]) {
    assert(instructions.includes(key), `Packed initialize instructions must mention "${key}".`);
  }
  const listed = response("tools-list");
  assert(Array.isArray(listed?.result?.tools), "Packed tools/list response is missing.");
  const packedToolNames = listed.result.tools.map((tool) => tool.name);
  assert(
    JSON.stringify(packedToolNames) === JSON.stringify(expectedTools),
    `Unexpected packed tool list: ${packedToolNames.join(", ")}`
  );
  assertPackedMetadataTool(listed.result.tools);
  assertPackedToolDescriptions(listed.result.tools);
  const validation = response("validate");
  assert(validation?.result?.structuredContent?.ok === true, "Packed ksql_validate smoke failed.");
  const applyValidation = response("apply-validation");
  assert(
    applyValidation?.result?.structuredContent?.ok === true
      && applyValidation.result.structuredContent.isReadOnly === true,
    "Packed APPLY VALIDATE ONLY smoke failed."
  );
  const applyMutation = response("apply-mutation");
  assert(
    applyMutation?.result?.structuredContent?.ok === false
      && applyMutation.result.structuredContent.error?.code === "UnsupportedError"
      && applyMutation.result.structuredContent.error?.message?.includes("MCP v3.8.0"),
    "Packed APPLY mutation must fail closed before runtime."
  );
  assertPackedMetadataSchemaError(
    response("metadata-http-attack"),
    "Packed metadata arbitrary HTTP attack"
  );
  assertPackedMetadataSchemaError(
    response("metadata-app-preview"),
    "Packed metadata app preview branch"
  );
  assertPackedMetadataSchemaError(
    response("metadata-layout-lang"),
    "Packed metadata layout lang branch"
  );
  const resources = response("resources-list")?.result?.resources;
  assert(
    JSON.stringify(resources?.map(({ uri }) => uri)) === JSON.stringify(RESOURCE_INDEX_URIS),
    "Packed resources/list must expose the two fixed indexes."
  );
  const resourceTemplates = response("resource-templates-list")?.result?.resourceTemplates;
  assert(
    JSON.stringify(resourceTemplates?.map(({ uriTemplate }) => uriTemplate))
      === JSON.stringify(RESOURCE_TEMPLATE_URIS),
    "Packed resources/templates/list must expose the section and recipe templates."
  );
  const packedIndex = textResource(
    response("language-index-resource")?.result,
    RESOURCE_INDEX_URIS[0],
    assert,
    "Packed language index"
  );
  const packedLanguageUris = indexedUris(
    packedIndex,
    RESOURCE_INDEX_URIS[0],
    /^\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/,
    assert,
    "Packed language"
  );
  const packedSelectUri = chapterUri(packedLanguageUris, "02-", assert, "Packed SELECT chapter");
  assert(
    packedSelectUri === "ksql://language-reference/02-select",
    "Packed SELECT URI must match the P2-generated key used by the standalone request."
  );
  const packedSelect = textResource(
    response("select-resource")?.result,
    packedSelectUri,
    assert,
    "Packed SELECT chapter"
  );
  assert(packedSelect.includes("## 2. SELECT"), "Packed SELECT chapter source text is missing.");
  const packedRecipe = textResource(
    response("recipe-resource")?.result,
    "ksql://recipes/r3",
    assert,
    "Packed recipe chapter"
  );

  const docsIndex = response("docs-index")?.result;
  assert(docsIndex?.content?.length === 1 && docsIndex.content[0]?.type === "text", "Packed ksql_docs index must be text-only.");
  assert(!("structuredContent" in docsIndex), "Packed ksql_docs success must not include structuredContent.");
  for (const section of docsSectionKeys) {
    const result = response(`docs:${section}`)?.result;
    assert(result?.content?.length === 1 && result.content[0]?.type === "text", `Packed ksql_docs ${section} must return text.`);
    assert(result.content[0].text.length > 0, `Packed ksql_docs ${section} returned empty text.`);
    assert(!("structuredContent" in result), `Packed ksql_docs ${section} must not include structuredContent.`);
  }
  assert(
    response("docs:language-reference")?.result?.content?.[0]?.text === packedIndex,
    "Packed ksql_docs language index must be byte-identical to the resource."
  );
  assert(
    response("docs:language-reference/02-select")?.result?.content?.[0]?.text === packedSelect,
    "Packed ksql_docs SELECT chapter must be byte-identical to the resource."
  );
  assert(
    response("docs:recipes/r3")?.result?.content?.[0]?.text === packedRecipe,
    "Packed ksql_docs recipe chapter must be byte-identical to the resource."
  );
  const docsUnknown = response("docs-unknown")?.result;
  assert(
    docsUnknown?.isError === true
      && docsUnknown.structuredContent?.ok === false
      && docsUnknown.structuredContent?.error?.code === "ArgumentError",
    "Packed ksql_docs unknown key must use the application error envelope."
  );

  process.stdout.write("[mcp-pack-smoke] ok\n");
} catch (err) {
  process.stderr.write(`[mcp-pack-smoke] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
} finally {
  cleanup([tmpDir, tarballPath]);
}
