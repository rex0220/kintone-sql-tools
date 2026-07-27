import { statementContainsOuterJoin } from "../outerJoinSearchAbortGuard";
import { parseSqlStatement } from "../sql";

test.each([
  "SELECT a.$id FROM APP100 a LEFT JOIN APP200 b ON a.key = b.key",
  "SELECT a.$id FROM APP100 a RIGHT JOIN APP200 b ON a.key = b.key",
  "WITH c AS (SELECT a.$id FROM APP100 a LEFT JOIN APP200 b ON a.key = b.key) SELECT * FROM c",
  "SELECT $id FROM APP100 UNION ALL SELECT a.$id FROM APP200 a RIGHT JOIN APP300 b ON a.key = b.key",
  "SELECT $id FROM APP100 WHERE EXISTS (SELECT a.$id FROM APP200 a LEFT JOIN APP300 b ON a.key = b.key)",
  "CREATE TEMP TABLE #x AS SELECT a.$id FROM APP100 a RIGHT JOIN APP200 b ON a.key = b.key",
])("文全体の外部結合を検出する: %s", (sql) => {
  expect(statementContainsOuterJoin(parseSqlStatement(sql))).toBe(true);
});

test.each([
  "SELECT $id FROM APP100",
  "SELECT a.$id FROM APP100 a INNER JOIN APP200 b ON a.key = b.key",
  "WITH c AS (SELECT a.$id FROM APP100 a INNER JOIN APP200 b ON a.key = b.key) SELECT * FROM c",
])("単一表と INNER JOIN は外部結合として扱わない: %s", (sql) => {
  expect(statementContainsOuterJoin(parseSqlStatement(sql))).toBe(false);
});
