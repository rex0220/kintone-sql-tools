// ============================================================
// build-cli.mjs — esbuild で ksql CLI をバンドルする
// ============================================================

import * as esbuild from "esbuild";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

if (!existsSync("dist-cli")) mkdirSync("dist-cli");

await esbuild.build({
  entryPoints: ["src/cli/index.ts"],
  outfile: "dist-cli/ksql.js",
  bundle: true,
  platform: "node",
  target: ["node18"],
  format: "cjs",
});

const outPath = "dist-cli/ksql.js";
const shebang = "#!/usr/bin/env node\n";
const current = readFileSync(outPath, "utf8");
if (!current.startsWith("#!/usr/bin/env node")) {
  writeFileSync(outPath, shebang + current, "utf8");
}

console.log("[kSQL] cli build complete -> dist-cli/ksql.js");
