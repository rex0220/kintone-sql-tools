#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const rootDir = resolve(import.meta.dirname, "..");
const distDir = resolve(rootDir, "dist-engine");
const fixtureDir = resolve(rootDir, "scripts", "fixtures", "engine-consumer-types");
const smokeDir = resolve(rootDir, ".tmp", "engine-declaration-smoke");
const packageDir = resolve(
  smokeDir,
  "node_modules",
  "@rex0220",
  "kintone-sql-tools"
);
const tscPath = resolve(rootDir, "node_modules", "typescript", "bin", "tsc");
const forbiddenImport =
  /(?:^|\/)(?:src\/)?(?:execute|types\/ast|parser\/|mcp\/|core\/(?:apply|dml)|converter\/dml|import\/)/i;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(existsSync(resolve(distDir, "index.d.ts")), "Missing dist-engine/index.d.ts.");
rmSync(smokeDir, { recursive: true, force: true });
mkdirSync(packageDir, { recursive: true });
cpSync(fixtureDir, smokeDir, { recursive: true });
cpSync(distDir, resolve(packageDir, "dist-engine"), { recursive: true });

const packageJson = JSON.parse(
  readFileSync(resolve(rootDir, "package.json"), "utf8")
);
writeFileSync(
  resolve(packageDir, "package.json"),
  JSON.stringify({
    name: packageJson.name,
    version: packageJson.version,
    exports: packageJson.exports,
  }, null, 2),
  "utf8"
);

const declarations = readdirSync(distDir)
  .filter((name) => name.endsWith(".d.ts"))
  .map((name) => ({
    name,
    text: readFileSync(resolve(distDir, name), "utf8"),
  }));
assert(declarations.length > 0, "No engine declarations were emitted.");
const leaks = declarations.flatMap(({ name, text }) =>
  text.split(/\r?\n/)
    .filter((line) => /\b(?:import|export)\b.*?from\s+["']/.test(line))
    .filter((line) => forbiddenImport.test(line))
    .map((line) => `${name}: ${line.trim()}`)
);
assert(leaks.length === 0, `Internal declaration imports leaked:\n${leaks.join("\n")}`);

for (const config of ["tsconfig.nodenext.json", "tsconfig.node16.json"]) {
  const result = spawnSync(process.execPath, [tscPath, "-p", config], {
    cwd: smokeDir,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`${config} typecheck failed.`);
  }
  console.log(`[engine-declaration-smoke] ${config}: ok`);
}
console.log("[engine-declaration-smoke] internal imports: 0");
