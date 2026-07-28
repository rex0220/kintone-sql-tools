import {
  isOuterJoinNonPreservedTable,
  statementContainsOuterJoin,
} from "../outerJoinSearchAbortGuard";
import { parseSqlStatement } from "../sql";
import type { SelectStatement } from "../../types/ast";

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

test("保持されない側は alias ではなく TableRef のオブジェクト同一性で照合する", () => {
  const statement = parseSqlStatement(
    "SELECT a.key FROM APP1 a LEFT JOIN APP2 b ON a.key = b.key"
  ) as SelectStatement;
  const joined = statement.joins[0].table;

  expect(isOuterJoinNonPreservedTable(statement, joined, false)).toBe(true);
  expect(isOuterJoinNonPreservedTable(statement, { ...joined }, false)).toBe(false);
});

test("RIGHT JOIN は main とそれ以前の join テーブルを保持されない側にする", () => {
  const statement = parseSqlStatement(
    "SELECT a.key FROM APP1 a " +
    "INNER JOIN APP2 b ON a.key = b.key " +
    "RIGHT JOIN APP3 c ON b.key = c.key"
  ) as SelectStatement;

  expect(isOuterJoinNonPreservedTable(statement, statement.from, true)).toBe(true);
  expect(isOuterJoinNonPreservedTable(statement, statement.joins[0].table, false)).toBe(true);
  expect(isOuterJoinNonPreservedTable(statement, statement.joins[1].table, false)).toBe(false);
});
