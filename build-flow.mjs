import * as esbuild from "esbuild";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(rootDir, "dist-flow");
const declarationOutDir = resolve(rootDir, ".tmp", "flow-declarations");
const packageJson = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8"));

rmSync(outDir, { recursive: true, force: true });
rmSync(declarationOutDir, { recursive: true, force: true });
mkdirSync(resolve(outDir, "meta"), { recursive: true });

for (const build of [
  { outfile: "index.mjs", metafile: "esm.json", platform: "neutral", target: ["es2020"], format: "esm" },
  { outfile: "index.cjs", metafile: "cjs.json", platform: "node", target: ["node18"], format: "cjs" },
]) {
  const result = await esbuild.build({
    entryPoints: ["./src/flow-library/index.ts"],
    outfile: resolve(rootDir, "dist-flow", build.outfile),
    absWorkingDir: rootDir,
    bundle: true,
    define: { __KSQL_FLOW_VERSION__: JSON.stringify(packageJson.version) },
    legalComments: "none",
    metafile: true,
    minify: true,
    sourcemap: false,
    treeShaking: true,
    platform: build.platform,
    target: build.target,
    format: build.format,
  });
  await import("node:fs/promises").then(({ writeFile }) => writeFile(
    resolve(outDir, "meta", build.metafile),
    `${JSON.stringify(result.metafile, null, 2)}\n`,
    "utf8"
  ));
}

const declaration = spawnSync(
  process.execPath,
  [resolve(rootDir, "node_modules", "typescript", "bin", "tsc"), "-p", resolve(rootDir, "tsconfig.flow.json")],
  { cwd: rootDir, encoding: "utf8" }
);
if (declaration.status !== 0) {
  process.stderr.write(declaration.stdout ?? "");
  process.stderr.write(declaration.stderr ?? "");
  throw new Error("Flow declaration build failed.");
}
mkdirSync(resolve(outDir, "flow-library"), { recursive: true });
mkdirSync(resolve(outDir, "types"), { recursive: true });
for (const name of ["index.d.ts", "errors.d.ts", "publicTypes.d.ts", "writableClient.d.ts"]) {
  cpSync(
    resolve(declarationOutDir, "flow-library", name),
    resolve(outDir, "flow-library", name)
  );
}
cpSync(
  resolve(declarationOutDir, "types", "ast.d.ts"),
  resolve(outDir, "types", "ast.d.ts")
);
console.log(`[kSQL] flow build complete (${packageJson.version}) -> dist-flow/`);
