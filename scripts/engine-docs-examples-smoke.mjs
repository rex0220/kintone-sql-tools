#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  createEngineUmdHost,
  loadEngineUmd,
} from "./fixtures/engine-umd-host/host.mjs";

const rootDir = resolve(import.meta.dirname, "..");
const smokeDir = resolve(rootDir, ".tmp", "engine-docs-examples-smoke");
const packageName = "@rex0220/kintone-sql-tools";
const exactVersion = "3.24.0";
let tarballPath;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? rootDir,
    encoding: "utf8",
    env: process.env,
    shell: process.platform === "win32" && command === "npm.cmd",
  });
  if (result.error || result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`${command} ${args.join(" ")} failed (${result.status})`);
  }
  return result;
}

function runNpm(args, options = {}) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && existsSync(npmExecPath)) {
    return run(process.execPath, [npmExecPath, ...args], options);
  }
  return run(process.platform === "win32" ? "npm.cmd" : "npm", args, options);
}

function packFilename(output) {
  const parsed = JSON.parse(output);
  assert(Array.isArray(parsed) && parsed[0]?.filename, "npm pack filename missing");
  return parsed[0].filename;
}

try {
  rmSync(smokeDir, { recursive: true, force: true });
  mkdirSync(smokeDir, { recursive: true });
  writeFileSync(
    resolve(smokeDir, "package.json"),
    `${JSON.stringify({ private: true, name: "engine-docs-examples-smoke", type: "module" }, null, 2)}\n`,
    "utf8"
  );

  const packed = runNpm(["pack", "--json"]);
  tarballPath = resolve(rootDir, packFilename(packed.stdout));
  runNpm(
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath],
    { cwd: smokeDir }
  );

  const esmSource = `
import { createReadonlyKintoneClient, runQuery, version } from "${packageName}/engine";
const client = createReadonlyKintoneClient();
const result = await runQuery("SELECT 'ok' AS status, 24 AS release", { client, maxRecords: 3000, cursorMaxActive: 2 });
if (version !== "${exactVersion}" || result.rows[0].status !== "ok" || result.rows[0].release !== "24") process.exit(1);
`;
  writeFileSync(resolve(smokeDir, "example.mjs"), esmSource, "utf8");
  run(process.execPath, ["example.mjs"], { cwd: smokeDir });

  const cjsDir = resolve(smokeDir, "cjs");
  mkdirSync(cjsDir);
  writeFileSync(resolve(cjsDir, "package.json"), '{"type":"commonjs"}\n', "utf8");
  const cjsSource = `
const { createReadonlyKintoneClient, runQuery, version } = require("${packageName}/engine");
(async () => {
  const client = createReadonlyKintoneClient();
  const result = await runQuery("SELECT 'ok' AS status, 24 AS release", { client });
  if (version !== "${exactVersion}" || result.rows[0].status !== "ok" || result.rows[0].release !== "24") process.exit(1);
})().catch((error) => { console.error(error); process.exit(1); });
`;
  writeFileSync(resolve(cjsDir, "example.cjs"), cjsSource, "utf8");
  run(process.execPath, ["example.cjs"], { cwd: cjsDir });

  const installedDir = resolve(
    smokeDir,
    "node_modules",
    "@rex0220",
    "kintone-sql-tools"
  );
  const umd = readFileSync(
    resolve(installedDir, "dist-engine", "ksql-engine.umd.js"),
    "utf8"
  );
  const fixture = createEngineUmdHost();
  loadEngineUmd(umd, fixture, "packed-ksql-engine.umd.js");
  const engine = fixture.host.ksql.get(exactVersion);
  assert(engine?.version === exactVersion, "UMD exact registry version missing");
  const client = engine.createReadonlyKintoneClient();
  const result = await engine.runQuery(
    "SELECT 'ok' AS status, 24 AS release",
    { client }
  );
  assert(
    result.rows[0].status === "ok" && result.rows[0].release === "24",
    "UMD documentation query result mismatch"
  );

  console.log(
    `[engine-docs-examples-smoke] packed ESM/CJS/UMD ${exactVersion}: ok`
  );
} finally {
  if (tarballPath && existsSync(tarballPath)) rmSync(tarballPath, { force: true });
  rmSync(smokeDir, { recursive: true, force: true });
}
