import * as esbuild from "esbuild";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(rootDir, "dist-engine");
const declarationOutDir = resolve(rootDir, ".tmp", "engine-declarations");
const packageJson = JSON.parse(
  readFileSync(resolve(rootDir, "package.json"), "utf8")
);
const define = {
  __KSQL_ENGINE_VERSION__: JSON.stringify(packageJson.version),
};

rmSync(outDir, { recursive: true, force: true });
rmSync(declarationOutDir, { recursive: true, force: true });
mkdirSync(resolve(outDir, "meta"), { recursive: true });

const builds = [
  {
    entryPoints: [resolve(rootDir, "src", "engine-library", "index.ts")],
    outfile: resolve(outDir, "index.mjs"),
    metafileName: "esm.json",
    platform: "neutral",
    target: ["es2020"],
    format: "esm",
  },
  {
    entryPoints: [resolve(rootDir, "src", "engine-library", "index.ts")],
    outfile: resolve(outDir, "index.cjs"),
    metafileName: "cjs.json",
    platform: "node",
    target: ["node18"],
    format: "cjs",
  },
  {
    entryPoints: [resolve(rootDir, "src", "engine-library", "umd.ts")],
    outfile: resolve(outDir, "ksql-engine.umd.js"),
    metafileName: "umd.json",
    platform: "browser",
    target: ["es2020"],
    format: "iife",
  },
];

for (const { metafileName, ...options } of builds) {
  const result = await esbuild.build({
    ...options,
    absWorkingDir: rootDir,
    bundle: true,
    define,
    legalComments: "none",
    metafile: true,
    minify: true,
    sourcemap: false,
    treeShaking: true,
  });
  await esbuild.analyzeMetafile(result.metafile);
  const metaPath = resolve(outDir, "meta", metafileName);
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(metaPath, `${JSON.stringify(result.metafile, null, 2)}\n`, "utf8")
  );
}

const tscPath = resolve(rootDir, "node_modules", "typescript", "bin", "tsc");
const declaration = spawnSync(
  process.execPath,
  [tscPath, "-p", resolve(rootDir, "tsconfig.engine.json")],
  { cwd: rootDir, encoding: "utf8" }
);
if (declaration.status !== 0) {
  process.stderr.write(declaration.stdout ?? "");
  process.stderr.write(declaration.stderr ?? "");
  throw new Error("Engine declaration build failed.");
}

const publicDeclarationFiles = [
  "index.d.ts",
  "errors.d.ts",
  "browserClient.d.ts",
  "batch.d.ts",
  "query.d.ts",
  "publicTypes.d.ts",
];
for (const name of publicDeclarationFiles) {
  const source = resolve(declarationOutDir, "engine-library", name);
  if (!existsSync(source)) {
    throw new Error(`Engine declaration build did not emit ${source}.`);
  }
  cpSync(source, resolve(outDir, name));
}

console.log(
  `[kSQL] engine build complete (${packageJson.version}) -> dist-engine/`
);
