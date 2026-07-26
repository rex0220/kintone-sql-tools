#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const rootDir = resolve(import.meta.dirname, "..");
const failures = [];

function readText(relativePath) {
  return readFileSync(resolve(rootDir, relativePath), "utf8");
}

function readJson(relativePath) {
  try {
    return JSON.parse(readText(relativePath));
  } catch (error) {
    failures.push(`${relativePath}: valid JSON expected (${error.message})`);
    return {};
  }
}

function expectEqual(location, actual, expected) {
  if (actual !== expected) {
    failures.push(
      `${location}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`
    );
  }
}

function expectReadmeVersion(readme, label, pattern, expected) {
  const match = readme.match(pattern);
  if (!match) {
    failures.push(`release/README.txt (${label}): version notation is missing`);
    return;
  }
  expectEqual(`release/README.txt (${label})`, match[1], expected);
}

const packageJson = readJson("package.json");
const version = packageJson.version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
  failures.push(
    `package.json version: expected X.Y.Z, found ${JSON.stringify(version)}`
  );
}

const packageLock = readJson("package-lock.json");
expectEqual("package-lock.json version", packageLock.version, version);
expectEqual(
  'package-lock.json packages[""].version',
  packageLock.packages?.[""]?.version,
  version
);

const manifest = readJson("prod/manifest.json");
expectEqual("prod/manifest.json version", manifest.version, version);

expectEqual("release/VERSION.txt", readText("release/VERSION.txt").trim(), `v${version}`);

const readme = readText("release/README.txt").replace(/\r\n/g, "\n");
const semver = String.raw`(\d+\.\d+\.\d+)`;
const readmeVersionPatterns = [
  ["package heading", new RegExp(`^ksql 配布パッケージ \\(v${semver}\\)$`, "m")],
  ["plugin artifact name", new RegExp(`^- ksql-plugin-v${semver}\\.zip$`, "m")],
  [
    "MCPB manifest version",
    new RegExp(`^- ksql-mcp\\.mcpb \\(manifest version ${semver}\\)$`, "m"),
  ],
  [
    "MCP server version",
    new RegExp(`^- ksql-mcp\\.js \\(MCP server version ${semver}\\)$`, "m"),
  ],
  [
    "plugin install procedure",
    new RegExp(`^1\\. ksql-plugin-v${semver}\\.zip を`, "m"),
  ],
  ["current release heading", new RegExp(`^本リリース \\(v${semver}\\):`, "m")],
];
for (const [label, pattern] of readmeVersionPatterns) {
  expectReadmeVersion(readme, label, pattern, version);
}

const pluginZip = `release/ksql-plugin-v${version}.zip`;
if (!existsSync(resolve(rootDir, pluginZip))) {
  failures.push(`${pluginZip}: expected release plugin zip to exist`);
}

if (failures.length > 0) {
  console.error(`[version-sync] ${failures.length} problem(s) found:`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`[version-sync] v${version}: all release version pins are synchronized`);
