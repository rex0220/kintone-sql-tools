import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";

const temporaryDirectory = await mkdtemp(join(tmpdir(), "ksql-b65-benchmark-"));
const outfile = join(temporaryDirectory, "benchmark.mjs");

try {
  await build({
    entryPoints: [fileURLToPath(new URL("./b65-grouping-benchmark-entry.ts", import.meta.url))],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    sourcemap: false,
    logLevel: "silent",
  });
  const { runBenchmark } = await import(pathToFileURL(outfile).href);
  process.stdout.write(`${JSON.stringify(runBenchmark(), null, 2)}\n`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
