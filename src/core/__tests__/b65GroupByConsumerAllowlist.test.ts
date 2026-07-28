import { readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";

/** Portable (no external ripgrep) recursive scan of production *.ts, excluding __tests__. */
function collectTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      collectTsFiles(join(dir, entry.name), acc);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      acc.push(join(dir, entry.name));
    }
  }
  return acc;
}

test("B65 consumer allowlist: production の直接 .groupBy 参照を AST 境界だけに固定する", () => {
  const root = resolve(__dirname, "../../..");
  const srcDir = join(root, "src");
  const pattern = /\.groupBy\b/;
  const locations: string[] = [];
  for (const file of collectTsFiles(srcDir)) {
    const rel = file.slice(root.length + 1).replace(/\\/g, "/");
    readFileSync(file, "utf8").split(/\r?\n/).forEach((line, index) => {
      if (pattern.test(line)) locations.push(`${rel}:${index + 1}`);
    });
  }
  expect(locations.sort()).toEqual([
    "src/core/grouping.ts:72",
    "src/core/grouping.ts:76",
    "src/core/grouping.ts:78",
    // B71 plain GROUP BY planning: AST-boundary reads, not grouping-semantics consumers.
    "src/execute.ts:2615",
    "src/execute.ts:2654",
    "src/parser/parser.ts:724",
  ].sort());
});
