#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const rootDir = resolve(import.meta.dirname, "..");
const distDir = resolve(rootDir, "dist-flow");
const metaDir = resolve(distDir, "meta");
if (!existsSync(metaDir)) throw new Error("Missing dist-flow/meta. Run npm run build:flow first.");

const forbiddenInputs = [
  ["node-builtins", (name) => name.startsWith("node:")],
  ["mcp", (name) => name.startsWith("src/mcp/") || name.startsWith("node_modules/@modelcontextprotocol/")],
  ["cli", (name) => name.startsWith("src/cli/")],
  ["plugin-ui", (name) => name.startsWith("src/ui/") || name.startsWith("src/css/") || name.startsWith("plugin/") || name === "src/index.ts" || /(?:^|\/)manifest\.json$/.test(name)],
  ["zod", (name) => name.startsWith("node_modules/zod/")],
];
const emittedRules = [
  ["node-builtins", /(?:from\s*|require\()["'](?:node:)?(?:fs|path|child_process)["']/],
  ["mcp", /KSQL_MCP_INSTRUCTIONS|statementSyntaxCatalog|@modelcontextprotocol/i],
  ["plugin-ui", /plugin\/manifest\.json|src\/ui\/desktop/i],
  ["zod", /Zod(?:Object|String|Error)/],
];
const failures = [];
const metaNames = readdirSync(metaDir).filter((item) => item === "esm.json" || item === "cjs.json");
if (metaNames.length !== 2 || !metaNames.includes("esm.json") || !metaNames.includes("cjs.json")) {
  throw new Error("Flow bundle guard failed closed: expected ESM and CJS metafiles.");
}
for (const name of metaNames) {
  const output = name === "esm.json" ? "index.mjs" : "index.cjs";
  if (!existsSync(resolve(distDir, output))) {
    throw new Error(`Flow bundle guard failed closed: missing ${output}.`);
  }
  const meta = JSON.parse(readFileSync(resolve(metaDir, name), "utf8"));
  const inputs = Object.keys(meta.inputs).map((item) => item.replaceAll("\\", "/"));
  const externalImports = Object.values(meta.outputs)
    .flatMap((item) => item.imports ?? [])
    .filter((item) => item.external)
    .map((item) => item.path);
  const code = readFileSync(resolve(distDir, output), "utf8");
  for (const [id, match] of forbiddenInputs) {
    const hits = inputs.filter(match);
    if (hits.length > 0) failures.push(`${output}:${id}=${hits.join(",")}`);
  }
  for (const [id, pattern] of emittedRules) {
    if (pattern.test(code)) failures.push(`${output}:emitted-${id}`);
  }
  const nodeImports = externalImports.filter((item) => item.startsWith("node:"));
  if (nodeImports.length > 0) failures.push(`${output}:node-builtins=${nodeImports.join(",")}`);
}
if (failures.length > 0) throw new Error(`Flow bundle guard failed: ${failures.join("; ")}`);
console.log("[flow-bundle-guard] ESM/CJS checked; forbidden Node/MCP/CLI/plugin UI/zod inputs and strings = 0");
