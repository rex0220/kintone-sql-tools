import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseSqlStatement } from "../core/sql";
import { KSQL_DOCS } from "../mcp/docsResources";

const source = readFileSync(resolve("docs/ksql_batch_recipes.md"), "utf8")
  .replace(/\r\n/g, "\n");

function sqlAfterHeading(heading: string): string {
  const start = source.indexOf(`### ${heading}`);
  if (start < 0) throw new Error(`recipe heading not found: ${heading}`);
  const fenceStart = source.indexOf("```sql\n", start);
  if (fenceStart < 0) throw new Error(`SQL fence not found: ${heading}`);
  const sqlStart = fenceStart + "```sql\n".length;
  const fenceEnd = source.indexOf("\n```", sqlStart);
  if (fenceEnd < 0) throw new Error(`SQL fence is not closed: ${heading}`);
  return source.slice(sqlStart, fenceEnd).trim();
}

describe("B165 option B recipes", () => {
  test.each([
    ["固定深さの階層は自己 JOIN で書く", "SELECT"],
    ["再帰 CTE の基本レシピ", "WITH"],
  ] as const)("published SQL parses and passes static validation: %s", (heading, type) => {
    expect(parseSqlStatement(sqlAfterHeading(heading)).type).toBe(type);
  });

  test("both recipes are embedded in ksql://recipes", () => {
    const recipe = KSQL_DOCS.recipes.sections.r17.text;
    expect(recipe).toContain("### 固定深さの階層は自己 JOIN で書く");
    expect(recipe).toContain("### 再帰 CTE の基本レシピ");
  });
});
