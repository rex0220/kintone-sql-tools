#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
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

// B82: リリース時だけ、公開文書に未リリース表記が残っていないかを検査する。
// version-sync-guard は「版数の一致」を見るもので、v3.25.0 では言語リファレンスに
// 「Unreleased の破壊的変更」が2箇所残ったまま出荷した。語の残存は別の失敗モードなので
// ここで追加する。開発中の npm test では未リリース機能の記述が正常なため無効にし、
// prepack（--release）からのみ有効化する。
const releaseMode = process.argv.includes("--release");
if (releaseMode) {
  const staleMarkers = [
    ["Unreleased", /Unreleased/g],
    ["未リリース", /未リリース/g],
    ["次回リリース", /次回リリース/g],
  ];
  // CHANGELOG.md は開発中に "## Unreleased" を持つのが正常なので対象外
  // （リリース時は版数見出しへ確定させる運用）。
  for (const relativePath of ["docs/ksql_language_reference.md", "release/README.txt"]) {
    const lines = readText(relativePath).split(/\r?\n/);
    for (const [label, pattern] of staleMarkers) {
      lines.forEach((line, index) => {
        pattern.lastIndex = 0;
        if (!pattern.test(line)) return;
        failures.push(
          `${relativePath}:${index + 1}: 未リリース表記「${label}」が残っています -> ${line.trim().slice(0, 80)}`
        );
      });
    }
  }

  // B93: release/ が版ごとに肥大するのを防ぐ。README は 911 行・v1.12.0 まで遡り、
  // プラグイン zip は 15 本 4.0MB まで溜まっていた（v3.31.1 で整理）。
  // どちらもリリースのたびに 1 つずつ増える構造なので、手順書ではなく機械で止める。
  // 過去版は GitHub Releases の各タグと git 履歴の二重で残るため、release/ に置き続ける必要はない。
  const readmeLineLimit = 150;
  const readmeLines = readme.split(/\r?\n/).length;
  if (readmeLines > readmeLineLimit) {
    failures.push(
      `release/README.txt: ${readmeLines} 行（上限 ${readmeLineLimit} 行）。`
      + "古い版の節を削り、CHANGELOG.md と GitHub Releases への案内に置き換えてください"
    );
  }

  const expectedZip = `ksql-plugin-v${version}.zip`;
  const staleZips = readdirSync(resolve(rootDir, "release"))
    .filter((name) => /^ksql-plugin-v.+\.zip$/.test(name) && name !== expectedZip)
    .sort();
  if (staleZips.length > 0) {
    failures.push(
      `release/: 旧版のプラグイン zip が ${staleZips.length} 本残っています -> ${staleZips.join(", ")}。`
      + "最新版だけを残してください（過去版は GitHub Releases の各タグに添付されています）"
    );
  }
}

if (failures.length > 0) {
  console.error(`[version-sync] ${failures.length} problem(s) found:`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `[version-sync] v${version}: all release version pins are synchronized`
  + (releaseMode ? " (release mode: 未リリース表記なし)" : "")
);
