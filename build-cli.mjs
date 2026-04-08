// ============================================================
// build-cli.mjs — esbuild で ksql CLI をバンドルする
// ============================================================

import * as esbuild from "esbuild";
import { existsSync, mkdirSync } from "fs";

if (!existsSync("dist-cli")) mkdirSync("dist-cli");

await esbuild.build({
  entryPoints: ["src/cli/index.ts"],
  outfile: "dist-cli/ksql.js",
  bundle: true,
  platform: "node",
  target: ["node18"],
  format: "cjs",
  banner: { js: "#!/usr/bin/env node" },
});

console.log("[kSQL] cli build complete -> dist-cli/ksql.js");
