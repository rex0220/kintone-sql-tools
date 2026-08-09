import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  RECURSIVE_CTE_MAX_DEPTH,
  RECURSIVE_CTE_MAX_EXPANSIONS,
  RECURSIVE_CTE_MAX_ROWS,
} from "../core/recursiveCte";

const source = readFileSync(resolve("docs/ksql_language_reference.md"), "utf8")
  .replace(/\r\n/g, "\n");

function readBoundaryTable(): Array<{ setting: string; value: number }> {
  const heading = "#### 再帰 CTE の境界既定値";
  const start = source.indexOf(heading);
  if (start < 0) throw new Error(`${heading} heading not found`);
  const end = source.indexOf("\n### ", start + heading.length);
  const section = source.slice(start, end < 0 ? source.length : end);
  const lines = section.split("\n");
  const header = lines.findIndex((line) => /^\|\s*設定\s*\|\s*既定値\s*\|\s*計測対象\s*\|$/.test(line));
  if (header < 0 || !/^\|[-:|\s]+\|$/.test(lines[header + 1] ?? "")) {
    throw new Error("recursive CTE boundary table header not found");
  }
  const rows: Array<{ setting: string; value: number }> = [];
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith("|")) break;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length !== 3) throw new Error(`unexpected boundary table row: ${line}`);
    rows.push({
      setting: cells[0].replace(/`/g, ""),
      value: Number(cells[1].replace(/,/g, "")),
    });
  }
  return rows;
}

test("B53 §13.8: recursive boundary defaults and setting names match exported constants", () => {
  expect(readBoundaryTable()).toEqual([
    { setting: "recursiveCteMaxDepth", value: RECURSIVE_CTE_MAX_DEPTH },
    { setting: "recursiveCteMaxRows", value: RECURSIVE_CTE_MAX_ROWS },
    { setting: "recursiveCteMaxExpansions", value: RECURSIVE_CTE_MAX_EXPANSIONS },
  ]);

  for (const stale of ["recursiveCTEMaxDepth", "recursiveCTEMaxRows", "recursiveCTEMaxExpansions", "recursiveCteMaxIterations"]) {
    expect(source).not.toContain(stale);
  }
});
