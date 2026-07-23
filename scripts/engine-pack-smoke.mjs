#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const rootDir = resolve(import.meta.dirname, "..");
const smokeDir = resolve(rootDir, ".tmp", "engine-pack-smoke");
const packageName = "@rex0220/kintone-sql-tools";
const installedDir = resolve(
  smokeDir,
  "node_modules",
  "@rex0220",
  "kintone-sql-tools"
);
const tscPath = resolve(rootDir, "node_modules", "typescript", "bin", "tsc");
let tarballPath;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? rootDir,
    encoding: "utf8",
    env: process.env,
    input: options.input,
  });
  if (result.error || result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status}): ${result.error?.message ?? "non-zero exit"}`
    );
  }
  return result;
}

function runNpm(args, options = {}) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && existsSync(npmExecPath)) {
    return run(process.execPath, [npmExecPath, ...args], options);
  }
  return run(
    process.platform === "win32" ? "npm.cmd" : "npm",
    args,
    { ...options, shell: process.platform === "win32" }
  );
}

function parsePackFilename(output) {
  const match = output.match(/"filename"\s*:\s*"([^"]+\.tgz)"/);
  assert(match, `npm pack did not report a tarball filename:\n${output}`);
  return match[1];
}

try {
  rmSync(smokeDir, { recursive: true, force: true });
  mkdirSync(smokeDir, { recursive: true });
  writeFileSync(
    resolve(smokeDir, "package.json"),
    JSON.stringify({ private: true, name: "ksql-engine-pack-smoke" }, null, 2),
    "utf8"
  );

  const packed = runNpm(["pack", "--json"]);
  tarballPath = resolve(rootDir, parsePackFilename(packed.stdout));
  assert(existsSync(tarballPath), `Missing packed tarball ${tarballPath}.`);

  runNpm(
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath],
    { cwd: smokeDir }
  );

  const installedPackage = JSON.parse(
    readFileSync(resolve(installedDir, "package.json"), "utf8")
  );
  assert(
    JSON.stringify(installedPackage.bin) === JSON.stringify({
      ksql: "dist-cli/ksql.js",
      "ksql-mcp": "dist-mcp/ksql-mcp.js",
    }),
    "Existing bin paths changed in the packed package."
  );
  assert(!("." in installedPackage.exports), "Packed package must not add a root export.");
  assert(
    installedPackage.exports?.["./engine"]?.types === "./dist-engine/index.d.ts" &&
      installedPackage.exports?.["./engine"]?.import === "./dist-engine/index.mjs" &&
      installedPackage.exports?.["./engine"]?.require === "./dist-engine/index.cjs",
    "Packed ./engine export conditions are incorrect."
  );
  assert(
    installedPackage.exports?.["./package.json"] === "./package.json",
    "Packed package.json tooling subpath is missing."
  );

  const required = [
    "dist-cli/ksql.js",
    "dist-mcp/ksql-mcp.js",
    "dist-mcpb/ksql-mcp.mcpb",
    "dist-engine/index.mjs",
    "dist-engine/index.cjs",
    "dist-engine/ksql-engine.umd.js",
    "dist-engine/index.d.ts",
    "dist-engine/meta/esm.json",
    "dist-engine/meta/cjs.json",
    "dist-engine/meta/umd.json",
    "dist-engine/meta/bundle-baseline.json",
    "README.md",
    "LICENSE",
  ];
  for (const name of required) {
    assert(existsSync(resolve(installedDir, name)), `Packed package is missing ${name}.`);
  }

  for (const fixture of ["engine-consumer-esm", "engine-consumer-cjs"]) {
    const destination = resolve(smokeDir, fixture);
    cpSync(resolve(rootDir, "scripts", "fixtures", fixture), destination, {
      recursive: true,
    });
    const entry = fixture.endsWith("esm") ? "index.mjs" : "index.cjs";
    run(process.execPath, [entry], { cwd: destination });
  }
  run(
    process.execPath,
    [
      "-e",
      `const p=require(${JSON.stringify(`${packageName}/package.json`)});if(p.version!==${JSON.stringify(installedPackage.version)})process.exit(1)`,
    ],
    { cwd: smokeDir }
  );

  const typesDir = resolve(smokeDir, "engine-consumer-types");
  cpSync(
    resolve(rootDir, "scripts", "fixtures", "engine-consumer-types"),
    typesDir,
    { recursive: true }
  );
  for (const config of ["tsconfig.nodenext.json", "tsconfig.node16.json"]) {
    run(process.execPath, [tscPath, "-p", config], { cwd: typesDir });
  }

  run(process.execPath, [resolve(installedDir, installedPackage.bin.ksql), "--help"], {
    cwd: smokeDir,
  });
  run(
    process.execPath,
    [resolve(installedDir, installedPackage.bin["ksql-mcp"]), "--help"],
    { cwd: smokeDir }
  );

  console.log(
    `[engine-pack-smoke] ${packageName} ESM/CJS/types/bins/artifacts: ok`
  );
} finally {
  if (tarballPath && existsSync(tarballPath)) {
    rmSync(tarballPath, { force: true });
  }
  if (existsSync(smokeDir)) {
    rmSync(smokeDir, { recursive: true, force: true });
  }
}
