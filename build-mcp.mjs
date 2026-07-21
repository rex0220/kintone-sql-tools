// ============================================================
// build-mcp.mjs — esbuild で ksql MCP server をバンドルする
// ============================================================

import * as esbuild from "esbuild";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { buildDocsResourceMap } from "./src/mcp/docsResourceBuilder.cjs";

if (!existsSync("dist-mcp")) mkdirSync("dist-mcp");

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const embeddedDocs = buildDocsResourceMap(
  readFileSync(resolve("docs/ksql_language_reference.md"), "utf8"),
  readFileSync(resolve("docs/ksql_batch_recipes.md"), "utf8")
);

await esbuild.build({
  entryPoints: [resolve("src/mcp/index.ts")],
  outfile: resolve("dist-mcp/ksql-mcp.js"),
  bundle: true,
  platform: "node",
  target: ["node18"],
  format: "cjs",
  // サーバー申告バージョン(serverInfo.version)を package.json と同期する
  define: {
    __KSQL_VERSION__: JSON.stringify(pkg.version),
    __KSQL_DOCS__: JSON.stringify(embeddedDocs),
  },
});

const outPath = "dist-mcp/ksql-mcp.js";
const shebang = "#!/usr/bin/env node\n";
const current = readFileSync(outPath, "utf8");
if (!current.startsWith("#!/usr/bin/env node")) {
  writeFileSync(outPath, shebang + current, "utf8");
}

const bundled = readFileSync(outPath, "utf8");
const forbiddenRuntimeImports = [
  /require\(["']@modelcontextprotocol\/sdk/,
  /require\(["']zod(?:\/[^"']*)?["']\)/,
];
if (forbiddenRuntimeImports.some((pattern) => pattern.test(bundled))) {
  throw new Error("[kSQL] mcp bundle contains external MCP SDK or zod imports.");
}

console.log("[kSQL] mcp build complete -> dist-mcp/ksql-mcp.js");
