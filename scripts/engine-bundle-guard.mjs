#!/usr/bin/env node

import { builtinModules } from "node:module";
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

const rootDir = resolve(import.meta.dirname, "..");
const distDir = resolve(rootDir, "dist-engine");
const metaDir = resolve(distDir, "meta");
const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

const inputRules = [
  ["mcp-instructions", (name) =>
    name === "src/mcp/instructions.ts" ||
    name === "src/mcp/instructions.js" ||
    name.startsWith("src/mcp/instructions/")],
  ["src-mcp", (name) => name.startsWith("src/mcp/")],
  ["docs", (name) => name.startsWith("docs/")],
  ["statement-catalog", (name) =>
    name === "src/mcp/statementSyntaxCatalog.ts" ||
    name === "src/mcp/statementSyntaxCatalog.js" ||
    name.endsWith("/statement-catalog.ts") ||
    name.endsWith("/statementCatalog.ts")],
  ["zod", (name) =>
    name === "node_modules/zod/index.js" ||
    name.startsWith("node_modules/zod/")],
  ["modelcontextprotocol", (name) =>
    name.startsWith("node_modules/@modelcontextprotocol/")],
  ["cli-profile-credential", (name) =>
    name.startsWith("src/cli/") ||
    name === "src/cli/nodeKintoneClient.ts"],
  ["plugin-ui-css-manifest", (name) =>
    name.startsWith("src/ui/") ||
    name.startsWith("src/css/") ||
    name.startsWith("plugin/") ||
    name === "src/index.ts" ||
    /(?:^|\/)manifest\.json$/.test(name) ||
    /\.(?:css|scss|sass|less)$/.test(name)],
];

const emittedStringRules = [
  ["embedded-doc-path", /docs\/(?:internal\/)?ksql|docs\\(?:internal\\)?ksql/i],
  [
    "embedded-catalog",
    /statementSyntaxCatalog|STATEMENT_SYNTAX_CATALOG|ksql_statement_catalog/i,
  ],
  [
    "embedded-mcp-instructions",
    /KSQL_MCP_INSTRUCTIONS|mcp\/instructions|mcp\\instructions/i,
  ],
];

const normalize = (value) =>
  value.replaceAll("\\", "/").replace(/^.*?\/(?=(?:src|docs|node_modules)\/)/, "");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function bundleForMeta(name) {
  return {
    "esm.json": "index.mjs",
    "cjs.json": "index.cjs",
    "umd.json": "ksql-engine.umd.js",
  }[name];
}

assert(existsSync(metaDir), "Missing dist-engine/meta. Run npm run build:engine first.");

const report = {
  generatedAt: new Date().toISOString(),
  baseline: "B66 Phase1 initial measured values; no arbitrary size ceiling",
  bundles: {},
};
const failures = [];

for (const metaName of readdirSync(metaDir).filter((name) =>
  ["esm.json", "cjs.json", "umd.json"].includes(name)
)) {
  const outputName = bundleForMeta(metaName);
  const meta = JSON.parse(readFileSync(resolve(metaDir, metaName), "utf8"));
  const code = readFileSync(resolve(distDir, outputName));
  const inputs = Object.keys(meta.inputs).map(normalize).sort();
  const imports = Object.values(meta.inputs)
    .flatMap((input) => input.imports ?? [])
    .map((item) => item.path);
  const forbidden = Object.fromEntries(
    inputRules.map(([id, matches]) => [id, inputs.filter(matches)])
  );
  forbidden["node-builtin"] = [...new Set(imports.filter((name) =>
    nodeBuiltins.has(name)
  ))].sort();
  forbidden.Buffer = /\bBuffer\b/.test(code.toString("utf8"))
    ? ["emitted JavaScript"]
    : [];
  for (const [id, pattern] of emittedStringRules) {
    forbidden[id] = pattern.test(code.toString("utf8"))
      ? ["emitted JavaScript"]
      : [];
  }

  for (const [id, matches] of Object.entries(forbidden)) {
    if (matches.length > 0) {
      failures.push(`${outputName}:${id}=${matches.join(",")}`);
    }
  }

  report.bundles[outputName] = {
    inputCount: inputs.length,
    minifiedBytes: code.byteLength,
    gzipBytes: gzipSync(code, { level: 9, mtime: 0 }).byteLength,
    forbidden,
  };
}

assert(Object.keys(report.bundles).length === 3, "Expected ESM, CJS, and UMD metafiles.");
if (failures.length > 0) {
  throw new Error(`Engine bundle guard failed: ${failures.join("; ")}`);
}

writeFileSync(
  resolve(metaDir, "bundle-baseline.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8"
);
for (const [name, value] of Object.entries(report.bundles)) {
  console.log(
    `[engine-bundle-guard] ${name}: minified=${value.minifiedBytes} gzip=${value.gzipBytes} forbidden=0`
  );
}
