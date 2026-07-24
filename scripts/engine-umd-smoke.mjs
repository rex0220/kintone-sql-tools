#!/usr/bin/env node

import * as esbuild from "esbuild";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createEngineUmdHost,
  loadEngineUmd,
} from "./fixtures/engine-umd-host/host.mjs";

const rootDir = resolve(import.meta.dirname, "..");
const entryPoint = resolve(rootDir, "src", "engine-library", "umd.ts");
const versions = ["3.19.0-smoke-x", "4.0.0-smoke-y"];
const builtPackage = JSON.parse(
  await readFile(resolve(rootDir, "package.json"), "utf8")
);
const writeBrowserFixtures = process.argv.includes("--write-browser-fixtures");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function build(version) {
  const result = await esbuild.build({
    absWorkingDir: rootDir,
    bundle: true,
    define: {
      __KSQL_ENGINE_VERSION__: JSON.stringify(version),
    },
    entryPoints: [entryPoint],
    format: "iife",
    legalComments: "none",
    minify: true,
    platform: "browser",
    target: ["es2020"],
    treeShaking: true,
    write: false,
  });
  return result.outputFiles[0].text;
}

function publicGlobals(host) {
  return Reflect.ownKeys(host).map(String).sort();
}

function listenerCount(state) {
  return state.listeners.filter(
    ([event]) => event === "pagehide" || event === "beforeunload"
  ).length;
}

function apiCalls(state, method, suffix = "/k/v1/records/cursor.json") {
  return state.apiCalls.filter(
    (call) => call.method === method && call.url.endsWith(suffix)
  );
}

async function closeAll(handles) {
  await Promise.all(handles.map((handle) => handle.close()));
}

const bundles = Object.fromEntries(
  await Promise.all(versions.map(async (version) => [version, await build(version)]))
);
if (writeBrowserFixtures) {
  const outputDir = resolve(rootDir, ".tmp", "engine-browser-smoke");
  await mkdir(outputDir, { recursive: true });
  await Promise.all(
    versions.map((version) =>
      writeFile(
        resolve(outputDir, `ksql-engine-${version}.umd.js`),
        bundles[version],
        "utf8"
      )
    )
  );
  console.log(`[engine-umd-smoke] browser fixtures -> ${outputDir}`);
}

for (const order of [versions, [...versions].reverse()]) {
  const fixture = createEngineUmdHost();
  const registryIdentity = fixture.host.ksql;
  const apiIdentity = fixture.kintone.api;
  const globalsBefore = publicGlobals(fixture.host);
  const listenersBefore = listenerCount(fixture.state);

  for (const version of order) {
    loadEngineUmd(bundles[version], fixture, `ksql-engine-${version}.umd.js`);
  }

  assert(fixture.host.ksql === registryIdentity, `${order}: registry was replaced`);
  assert(fixture.kintone.api === apiIdentity, `${order}: kintone.api was replaced`);
  assert(
    JSON.stringify(publicGlobals(fixture.host)) === JSON.stringify(globalsBefore),
    `${order}: global properties changed`
  );
  assert(
    listenerCount(fixture.state) === listenersBefore,
    `${order}: page lifecycle listener was registered`
  );
  for (const version of versions) {
    const selected = fixture.host.ksql.get(version);
    assert(selected === fixture.host.ksql.versions[version], `${version}: get mismatch`);
    assert(selected?.version === version, `${version}: embedded version mismatch`);
    assert(Object.isFrozen(selected), `${version}: public API is not frozen`);
  }
  assert(fixture.host.ksql.get("3.19.0") === undefined, "get accepted a partial version");

  const firstVersion = order[0];
  const firstEntry = fixture.host.ksql.get(firstVersion);
  loadEngineUmd(
    bundles[firstVersion],
    fixture,
    `ksql-engine-${firstVersion}-duplicate.umd.js`
  );
  assert(
    fixture.host.ksql.get(firstVersion) === firstEntry,
    `${firstVersion}: duplicate replaced the first entry`
  );
  assert(fixture.state.warnings.length === 1, "duplicate load did not warn exactly once");
  assert(fixture.state.errors.length === 0, "valid registry load emitted an error");
}

{
  const collision = createEngineUmdHost({ registry: false });
  const naive = { version: "other-library" };
  collision.host.ksql = naive;
  const globalsBefore = publicGlobals(collision.host);
  loadEngineUmd(bundles[versions[0]], collision, "ksql-engine-collision.umd.js");
  assert(collision.host.ksql === naive, "non-registry collision was overwritten");
  assert(collision.state.errors.length === 1, "non-registry collision did not fail closed");
  assert(collision.state.warnings.length === 0, "collision emitted a duplicate warning");
  assert(
    JSON.stringify(publicGlobals(collision.host)) === JSON.stringify(globalsBefore),
    "collision changed global properties"
  );
}

{
  const fixture = createEngineUmdHost();
  for (const version of versions) {
    loadEngineUmd(bundles[version], fixture, `ksql-engine-${version}.umd.js`);
  }
  const [x, y] = versions.map((version) => fixture.host.ksql.get(version));
  const xClient = x.createReadonlyKintoneClient({ cursorMaxActive: 1 });
  const yClient = y.createReadonlyKintoneClient({ cursorMaxActive: 2 });
  const cursorParams = {
    app: 1,
    query: "order by $id asc",
    size: 500,
  };

  const xFirst = await xClient.openCursor(cursorParams);
  const createsAfterX = apiCalls(fixture.state, "POST").length;
  await xClient.openCursor(cursorParams).then(
    () => {
      throw new Error("version X capacity did not reject");
    },
    (error) => assert(error?.name === "CursorCapacityError", "unexpected X capacity error")
  );
  assert(
    apiCalls(fixture.state, "POST").length === createsAfterX,
    "instance capacity rejection reached the Cursor API"
  );

  const yHandles = [
    await yClient.openCursor(cursorParams),
    await yClient.openCursor(cursorParams),
  ];
  await yClient.openCursor(cursorParams).then(
    () => {
      throw new Error("version Y capacity did not reject");
    },
    (error) => assert(error?.name === "CursorCapacityError", "unexpected Y capacity error")
  );
  assert(
    fixture.state.activeCursorIds.size === 3,
    "version-local active handles propagated or were not retained"
  );
  await xFirst.close();
  assert(
    fixture.state.activeCursorIds.size === 2,
    "closing version X affected version Y handles"
  );
  const xReopened = await xClient.openCursor(cursorParams);
  await closeAll([xReopened, ...yHandles]);
  assert(fixture.state.activeCursorIds.size === 0, "cursor cleanup leaked handles");

  for (const engine of [x, y]) {
    const client = engine.createReadonlyKintoneClient({ cursorMaxActive: 1 });
    const result = await engine.runQuery(
      "SELECT $id FROM APP1 KORDER BY $id LIMIT 501",
      { client, maxRecords: 501, cursorMaxActive: 1 }
    );
    assert(result.rowCount === 501, `${engine.version}: Cursor query row count mismatch`);
    assert(
      result.metrics.cursorRecordsScanned === 501,
      `${engine.version}: Cursor metrics mismatch`
    );
  }
  assert(fixture.state.activeCursorIds.size === 0, "query finally cleanup leaked handles");
}

{
  const fixture = createEngineUmdHost({ hostCursorLimit: 1 });
  for (const version of versions) {
    loadEngineUmd(bundles[version], fixture, `ksql-engine-${version}.umd.js`);
  }
  const x = fixture.host.ksql.get(versions[0]);
  const y = fixture.host.ksql.get(versions[1]);
  const blocker = await x.createReadonlyKintoneClient({ cursorMaxActive: 1 })
    .openCursor({ app: 1, query: "order by $id asc", size: 500 });
  const createsBefore = apiCalls(fixture.state, "POST").length;
  const fetchesBefore = fixture.state.fetchCalls.length;
  let rejected;
  try {
    await y.runQuery(
      "SELECT $id FROM APP1 KORDER BY $id LIMIT 501",
      {
        client: y.createReadonlyKintoneClient({ cursorMaxActive: 1 }),
        maxRecords: 501,
        cursorMaxActive: 1,
      }
    );
  } catch (error) {
    rejected = error;
  }
  assert(rejected?.code === "CLIENT_ERROR", "host aggregate reject was not CLIENT_ERROR");
  assert(
    apiCalls(fixture.state, "POST").length === createsBefore + 1,
    "host aggregate reject retried Cursor creation"
  );
  assert(
    fixture.state.fetchCalls.length === fetchesBefore,
    "host aggregate reject fell back to Records GET"
  );
  assert(
    apiCalls(fixture.state, "GET").length === 0,
    "host aggregate reject returned a partial Cursor page"
  );
  await blocker.close();
}

{
  const distDir = resolve(rootDir, "dist-engine");
  const fixture = createEngineUmdHost();
  const umdSource = await readFile(resolve(distDir, "ksql-engine.umd.js"), "utf8");
  loadEngineUmd(umdSource, fixture, "dist-engine/ksql-engine.umd.js");
  const umd = fixture.host.ksql.get(builtPackage.version);
  const esm = await import(
    `${pathToFileURL(resolve(distDir, "index.mjs")).href}?umd-smoke=${Date.now()}`
  );
  const require = createRequire(import.meta.url);
  const cjs = require(resolve(distDir, "index.cjs"));
  assert(umd?.version === builtPackage.version, "UMD version/key != package version");
  assert(esm.version === builtPackage.version, "ESM version != package version");
  assert(cjs.version === builtPackage.version, "CJS version != package version");

  const publicNames = [
    "KsqlEngineError",
    "createReadonlyKintoneClient",
    "explainQuery",
    "runQuery",
    "version",
  ];
  for (const [surface, engine] of Object.entries({ ESM: esm, CJS: cjs, UMD: umd })) {
    assert(
      JSON.stringify(Object.keys(engine).sort()) === JSON.stringify(publicNames),
      `${surface} public names mismatch: ${Object.keys(engine).sort().join(",")}`
    );
  }
  const byo = {
    getRecords: async () => ({ records: [] }),
    openCursor: async () => ({
      totalCount: 0,
      nextPage: async () => ({ records: [], next: false }),
      close: async () => undefined,
    }),
    getApps: async () => [],
    getFields: async () => [],
    getNumberPrecision: async () => ({
      digits: 30,
      decimalPlaces: 10,
      roundingMode: "HALF_EVEN",
    }),
    getProcessStatuses: async () => ({ enable: false, states: [] }),
  };
  const normalizeResult = (result) => ({
    type: result.type,
    rows: result.rows,
    columns: result.columns,
    rowCount: result.rowCount,
    warnings: result.warnings,
    metrics: {
      recordGetCalls: result.metrics.recordGetCalls,
      fetchedRows: result.metrics.fetchedRows,
      cursorRecordsScanned: result.metrics.cursorRecordsScanned,
    },
  });
  const results = await Promise.all(
    [esm, cjs, umd].map((engine) =>
      engine.runQuery("SELECT 1 AS one", { client: byo }).then(normalizeResult)
    )
  );
  assert(
    results.every((result) => JSON.stringify(result) === JSON.stringify(results[0])),
    "ESM/CJS/UMD runQuery results differ"
  );
}

console.log(
  `[engine-umd-smoke] registry order/duplicate/collision, ${versions.join(" + ")}, ` +
  `per-version Cursor isolation, globals=0, public names/result parity, ` +
  `package=${builtPackage.version}: ok`
);
