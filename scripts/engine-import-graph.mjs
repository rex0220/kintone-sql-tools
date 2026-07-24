import { builtinModules } from "node:module";
import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import * as esbuild from "esbuild";

const ROOT = path.resolve(import.meta.dirname, "..");
const ENTRY_A = path.join(ROOT, "src", "execute.ts");
const ENTRY_B_FLOOR = path.join(ROOT, "scripts", "engine-read-floor-probe.ts");
const ESBUILD_REQUIRED = "0.27.5";

const TARGETS = [
  {
    id: "browser-esm-es2020",
    platform: "browser",
    format: "esm",
    target: ["es2020"],
  },
  {
    id: "node-cjs-node18",
    platform: "node",
    format: "cjs",
    target: ["node18"],
  },
];

const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

/*
 * Exact deny rules are intentionally centralized here.  Path tests operate on
 * normalized repo-relative metafile input names; text tests operate on emitted
 * JavaScript.  Adding a new platform surface requires an explicit rule change.
 */
const DENY_RULES = [
  {
    id: "mcp-instructions",
    kind: "input",
    matches: (name) =>
      name === "src/mcp/instructions.ts" ||
      name === "src/mcp/instructions.js" ||
      name.startsWith("src/mcp/instructions/"),
  },
  {
    id: "src-mcp",
    kind: "input",
    matches: (name) => name.startsWith("src/mcp/"),
  },
  {
    id: "docs",
    kind: "input",
    matches: (name) => name.startsWith("docs/"),
  },
  {
    id: "statement-catalog",
    kind: "input",
    matches: (name) =>
      name === "src/mcp/statementSyntaxCatalog.ts" ||
      name === "src/mcp/statementSyntaxCatalog.js" ||
      name.endsWith("/statement-catalog.ts") ||
      name.endsWith("/statementCatalog.ts"),
  },
  {
    id: "zod",
    kind: "input",
    matches: (name) =>
      name === "node_modules/zod/index.js" ||
      name.startsWith("node_modules/zod/"),
  },
  {
    id: "modelcontextprotocol-sdk",
    kind: "input",
    matches: (name) =>
      name.startsWith("node_modules/@modelcontextprotocol/sdk/"),
  },
  {
    id: "cli-profile-credential",
    kind: "input",
    matches: (name) =>
      /^src\/cli\/(?:profile|profiles|credential|credentials)(?:[./]|$)/.test(name) ||
      name === "src/cli/nodeKintoneClient.ts",
  },
  {
    id: "plugin-ui-css-manifest",
    kind: "input",
    matches: (name) =>
      name.startsWith("src/ui/") ||
      name.startsWith("src/css/") ||
      name.startsWith("plugin/") ||
      name === "src/index.ts" ||
      /(?:^|\/)manifest\.json$/.test(name) ||
      /\.(?:css|scss|sass|less)$/.test(name),
  },
  {
    id: "node-builtin",
    kind: "import",
    matches: (name) => NODE_BUILTINS.has(name),
  },
  {
    id: "Buffer",
    kind: "text",
    matches: (text) => /\bBuffer\b/.test(text),
  },
];

const DML_INPUT_PATTERNS = [
  /^src\/import\//,
  /^src\/core\/apply/,
  /^src\/core\/dml/,
  /^src\/core\/batch(?:Variables)?\.ts$/,
  /^src\/core\/existingRecordValidation\.ts$/,
  /^src\/core\/postImageValidation\.ts$/,
  /^src\/core\/optimization\/applyParentSelectionPlan\.ts$/,
  /^src\/core\/optimization\/whereCapability\.ts$/,
  /^src\/converter\/apply/,
  /^src\/converter\/dml/,
];

const PLATFORM_INPUT_PATTERNS = [
  /^src\/cli\//,
  /^src\/mcp\//,
  /^src\/ui\//,
  /^src\/css\//,
  /^plugin\//,
  /^node_modules\//,
  /(?:^|\/)manifest\.json$/,
  /\.(?:css|scss|sass|less)$/,
];

const normalize = (value) => value.replaceAll("\\", "/").replace(/^\.\//, "");
const relative = (value) => normalize(path.relative(ROOT, path.resolve(ROOT, value)));
const gzipBytes = (contents) => gzipSync(contents, { level: 9, mtime: 0 }).byteLength;

function classifyInput(name) {
  if (name.startsWith("src/mcp/") || name.startsWith("docs/")) return "MCP・docs";
  if (DML_INPUT_PATTERNS.some((pattern) => pattern.test(name))) return "DML・APPLY・IMPORT";
  if (PLATFORM_INPUT_PATTERNS.some((pattern) => pattern.test(name))) return "platform 固有";
  return "read path";
}

function outputFile(result, suffix = ".js") {
  const file = result.outputFiles.find((candidate) => candidate.path.endsWith(suffix));
  if (!file) throw new Error(`esbuild did not return a ${suffix} output`);
  return file;
}

async function bundle(entryPoint, target, minify) {
  return esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    metafile: true,
    minify,
    treeShaking: true,
    platform: target.platform,
    format: target.format,
    target: target.target,
    logLevel: "silent",
    sourcemap: false,
    outdir: "out",
  });
}

function inspectForbidden(result, jsText) {
  const inputs = Object.keys(result.metafile.inputs).map(normalize);
  const imports = Object.values(result.metafile.inputs)
    .flatMap((input) => input.imports)
    .map((item) => item.path);
  return DENY_RULES.map((rule) => {
    const matches =
      rule.kind === "input"
        ? inputs.filter(rule.matches)
        : rule.kind === "import"
          ? imports.filter(rule.matches)
          : rule.matches(jsText)
            ? ["emitted JavaScript"]
            : [];
    return { id: rule.id, matches: [...new Set(matches)].sort() };
  });
}

function outputContributions(metafile) {
  const output = Object.values(metafile.outputs).find((item) => item.inputs);
  if (!output) throw new Error("esbuild metafile has no bundled output");
  return Object.entries(output.inputs).map(([name, detail]) => ({
    input: normalize(name),
    bytes: detail.bytesInOutput,
  }));
}

function topContributors(metafile, limit = 12) {
  return outputContributions(metafile)
    .sort((a, b) => b.bytes - a.bytes || a.input.localeCompare(b.input))
    .slice(0, limit);
}

async function exclusiveSourceEstimate(exclusiveInputs) {
  const pieces = [];
  for (const name of [...exclusiveInputs].sort()) {
    const source = await readFile(path.join(ROOT, name), "utf8");
    const loader = name.endsWith(".tsx") ? "tsx" : name.endsWith(".ts") ? "ts" : "js";
    const transformed = await esbuild.transform(source, {
      loader,
      minify: true,
      target: "es2020",
      format: "esm",
      treeShaking: true,
      legalComments: "none",
    });
    pieces.push(transformed.code);
  }
  const joined = pieces.join("\n");
  return {
    minifiedBytes: Buffer.byteLength(joined),
    gzipBytes: gzipBytes(joined),
  };
}

async function measureEntry(entryPoint, target) {
  const [plain, minified] = await Promise.all([
    bundle(entryPoint, target, false),
    bundle(entryPoint, target, true),
  ]);
  const plainFile = outputFile(plain);
  const minifiedFile = outputFile(minified);
  const jsText = minifiedFile.text;
  const inputs = Object.keys(plain.metafile.inputs).map(normalize).sort();
  const classification = {};
  for (const name of inputs) {
    const category = classifyInput(name);
    (classification[category] ??= []).push(name);
  }
  return {
    inputCount: inputs.length,
    inputs,
    classification,
    unminifiedBytes: plainFile.contents.byteLength,
    minifiedBytes: minifiedFile.contents.byteLength,
    gzipBytes: gzipBytes(minifiedFile.contents),
    forbidden: inspectForbidden(minified, jsText),
    topContributors: topContributors(minified.metafile),
    metafile: minified.metafile,
  };
}

function printMeasurement(label, target, value) {
  console.log(`\n## ${label} — ${target.id}`);
  console.log(`inputs: ${value.inputCount}`);
  console.log(
    `bytes: unminified=${value.unminifiedBytes} minified=${value.minifiedBytes} gzip=${value.gzipBytes}`
  );
  for (const category of ["read path", "DML・APPLY・IMPORT", "MCP・docs", "platform 固有"]) {
    const names = value.classification[category] ?? [];
    console.log(`classification ${category}: ${names.length}`);
    for (const name of names) console.log(`  ${name}`);
  }
  console.log("forbidden:");
  for (const rule of value.forbidden) {
    console.log(`  ${rule.id}: ${rule.matches.length}${rule.matches.length ? ` (${rule.matches.join(", ")})` : ""}`);
  }
  console.log("top contributors (minified bytesInOutput):");
  for (const item of value.topContributors) console.log(`  ${item.bytes}\t${item.input}`);
}

async function main() {
  if (esbuild.version !== ESBUILD_REQUIRED) {
    throw new Error(`B66 audit requires esbuild ${ESBUILD_REQUIRED}; found ${esbuild.version}`);
  }

  const report = {
    esbuildVersion: esbuild.version,
    generatedAt: new Date().toISOString(),
    targets: {},
  };

  for (const target of TARGETS) {
    const [a, floor] = await Promise.all([
      measureEntry(ENTRY_A, target),
      measureEntry(ENTRY_B_FLOOR, target),
    ]);
    const allInputs = new Set(Object.keys(a.metafile.inputs).map(normalize));
    const floorInputs = new Set(Object.keys(floor.metafile.inputs).map(normalize));
    /*
     * The probe is the explicit read-root set.  A module is branch-exclusive
     * only when A reaches it and the read probe does not.  execute.ts itself is
     * excluded: extraction replaces its mixed router, so its internal DML code
     * cannot be attributed as a removable module by an import graph.
     */
    const exclusive = new Set(
      [...allInputs].filter((name) => name !== relative(ENTRY_A) && !floorInputs.has(name))
    );
    const contributions = outputContributions(a.metafile);
    const exclusiveMinifiedBytes = contributions
      .filter((item) => exclusive.has(item.input))
      .reduce((sum, item) => sum + item.bytes, 0);
    const sourceEstimate = await exclusiveSourceEstimate(exclusive);
    const dmlReached = (a.classification["DML・APPLY・IMPORT"] ?? []).length > 0;
    const forbiddenCount =
      a.forbidden.reduce((sum, rule) => sum + rule.matches.length, 0) +
      floor.forbidden.reduce((sum, rule) => sum + rule.matches.length, 0);

    report.targets[target.id] = {
      optionA: { ...a, metafile: undefined },
      optionBFloor: { ...floor, metafile: undefined },
      dmlReached,
      forbiddenCount,
      dmlExclusive: {
        inputCount: exclusive.size,
        inputs: [...exclusive].sort(),
        minifiedBytesInAOutput: exclusiveMinifiedBytes,
        individuallyTransformedSource: sourceEstimate,
      },
      aMinusBFloor: {
        unminifiedBytes: a.unminifiedBytes - floor.unminifiedBytes,
        minifiedBytes: a.minifiedBytes - floor.minifiedBytes,
        gzipBytes: a.gzipBytes - floor.gzipBytes,
      },
    };

    printMeasurement("Option A (src/execute.ts)", target, a);
    printMeasurement("Option B optimistic floor probe", target, floor);
    console.log(`\nDML/APPLY/IMPORT reached: ${dmlReached ? "yes" : "no"}`);
    console.log(`forbidden total: ${forbiddenCount}`);
    console.log(`DML-exclusive inputs: ${exclusive.size}`);
    for (const name of [...exclusive].sort()) console.log(`  ${name}`);
    console.log(`DML-exclusive minified bytesInOutput: ${exclusiveMinifiedBytes}`);
    console.log(
      `DML-exclusive individually transformed source: minified=${sourceEstimate.minifiedBytes} gzip=${sourceEstimate.gzipBytes}`
    );
    console.log(
      `A - B floor: unminified=${a.unminifiedBytes - floor.unminifiedBytes} minified=${a.minifiedBytes - floor.minifiedBytes} gzip=${a.gzipBytes - floor.gzipBytes}`
    );
  }

  const failures = Object.values(report.targets).flatMap((target) => [
    ...(target.forbiddenCount === 0 ? [] : [`forbidden=${target.forbiddenCount}`]),
    ...(target.dmlReached ? [] : ["expected current Option A to reach DML/APPLY/IMPORT inputs"]),
  ]);
  if (process.argv.includes("--json")) {
    console.log(`\n${JSON.stringify(report, null, 2)}`);
  }
  if (failures.length) {
    throw new Error(`B66 audit failed: ${failures.join(", ")}`);
  }
}

await main();
