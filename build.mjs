// ============================================================
// build.mjs — esbuild でプラグイン JS をバンドルする
// 使い方:
//   node build.mjs           # 本番ビルド（minify）
//   node build.mjs --watch   # 開発: 変更を監視してビルド & パック
// ============================================================

import * as esbuild from "esbuild";
import { execSync } from "child_process";

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";

const watch     = process.argv.includes("--watch");
const pluginIdFromEnv = (process.env.KSQL_PLUGIN_ID ?? "").trim();
const pluginIdFromFile = existsSync("pluginId.txt")
  ? readFileSync("pluginId.txt", "utf-8").trim()
  : "";
const PLUGIN_ID = pluginIdFromEnv || pluginIdFromFile;
if (!PLUGIN_ID) {
  console.error(
    "[kSQL] pluginId is required. Set KSQL_PLUGIN_ID or create pluginId.txt."
  );
  process.exit(1);
}

const ppkFromEnvPath = (process.env.KSQL_PPK_PATH ?? "").trim();
const localPpkPath = "private.ppk";
const PPK = ppkFromEnvPath || (existsSync(localPpkPath) ? localPpkPath : "");
const packageJson = JSON.parse(readFileSync("package.json", "utf-8"));
const OUT_ZIP   = `dist/ksql-plugin-v${packageJson.version}.zip`;
const PLUGIN_DIR = "prod";
const MANIFEST_PATH = `${PLUGIN_DIR}/manifest.json`;

function synchronizeManifestVersion() {
  const source = readFileSync(MANIFEST_PATH, "utf-8");
  const manifest = JSON.parse(source);
  if (manifest.version === packageJson.version) return;

  const versionPattern = /("version"\s*:\s*")[^"]*(")/;
  const matches = source.match(new RegExp(versionPattern.source, "g")) ?? [];
  if (matches.length !== 1) {
    throw new Error(
      `[kSQL] ${MANIFEST_PATH}: expected exactly one version field, found ${matches.length}`
    );
  }

  const updated = source.replace(
    versionPattern,
    (_match, prefix, suffix) => `${prefix}${packageJson.version}${suffix}`
  );
  writeFileSync(MANIFEST_PATH, updated, "utf-8");
  console.log(
    `[kSQL] synchronized ${MANIFEST_PATH} version → ${packageJson.version}`
  );
}

synchronizeManifestVersion();

const sharedOpts = {
  bundle:    true,
  platform:  "browser",
  target:    ["es2020"],
  format:    "iife",
  minify:    !watch,
  sourcemap: watch ? "inline" : false,
  define: {
    "kintone.$PLUGIN_ID": JSON.stringify(PLUGIN_ID),
  },
};

// ビルド後にプラグインをパックする esbuild プラグイン
const packPlugin = {
  name: "pack",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) return;
      try {
        const ppkOpt = existsSync(PPK) ? `--ppk ${PPK}` : "";
        execSync(
          `kintone-plugin-packer ${ppkOpt} --out ${OUT_ZIP} ${PLUGIN_DIR}`,
          { stdio: "pipe" }
        );
        console.log(`[kSQL] packed → ${OUT_ZIP}`);
      } catch (e) {
        console.error("[kSQL] pack failed:", e.stderr?.toString() ?? e.message);
      }
    });
  },
};

// dist/ がなければ作成
if (!existsSync("dist")) mkdirSync("dist");

// desktop.js と config.js を同時にビルド
const [desktopCtx, configCtx] = await Promise.all([
  esbuild.context({
    ...sharedOpts,
    entryPoints: ["src/ui/desktop.ts"],
    outfile:     "prod/js/desktop.js",
    plugins:     [packPlugin],   // desktop ビルド後にパック
  }),
  esbuild.context({
    ...sharedOpts,
    entryPoints: ["src/ui/config.ts"],
    outfile:     "prod/js/config.js",
    // config はサブエントリなので desktop 側のパックに任せる
  }),
]);

if (watch) {
  await Promise.all([desktopCtx.watch(), configCtx.watch()]);
  console.log("[kSQL] watching for changes... (Ctrl+C to stop)");
} else {
  await Promise.all([desktopCtx.rebuild(), configCtx.rebuild()]);
  await Promise.all([desktopCtx.dispose(), configCtx.dispose()]);
  console.log(`[kSQL] build complete → prod/js/desktop.js, prod/js/config.js, ${OUT_ZIP}`);
}
