import { analyzeBatch } from "../batch";
import { parseSqlStatements } from "../sql";

describe("B71 Step 2 schema-free validation non-regression", () => {
  test.each([
    "SELECT 金額 AS 区分, COUNT(*) AS c FROM APP100 GROUP BY 区分",
    "SELECT 区分 AS g, COUNT(*) AS c FROM APP100 GROUP BY g",
    "SELECT 金額 AS g, 区分 AS g FROM APP100 GROUP BY g",
    "SELECT COUNT(*) AS c FROM APP100 GROUP BY c",
    "SELECT SUM(金額) FROM APP100 GROUP BY `SUM(金額)`",
  ])("analyzeBatch は name matching だけで拒否しない: %s", (sql) => {
    expect(() => analyzeBatch(parseSqlStatements(sql))).not.toThrow();
  });
});
