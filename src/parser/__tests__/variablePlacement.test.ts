import { analyzeBatch } from "../../core/batch";
import { parseSqlStatements } from "../../core/sql";
import { Lexer } from "../../lexer/lexer";
import { TokenKind } from "../../lexer/tokens";

type PlacementCase = {
  id: string;
  placement: string;
  sql: string;
  import?: boolean;
};

type RejectedPlacementCase = Omit<PlacementCase, "sql" | "import"> & {
  sql: string | string[];
};

const acceptedPlacements: PlacementCase[] = [
  { id: "A01", placement: "WHERE comparison right operand", sql: "SET @x = 10; SELECT * FROM APP1 WHERE amount >= @x" },
  { id: "A02", placement: "HAVING comparison right operand", sql: "SET @x = 10; SELECT category, COUNT(*) AS count FROM APP1 GROUP BY category HAVING COUNT(*) >= @x" },
  { id: "A03", placement: "CHECK WHEN condition", sql: "SET @x = 10; UPDATE APP1 SET amount = 1 WHERE $id = 1 CHECK WHEN amount >= @x THEN 'too large' VALIDATE ONLY" },
  { id: "A04", placement: "CASE and IF conditions", sql: "SET @x = 10; SELECT CASE WHEN amount >= @x THEN 'high' ELSE 'low' END AS c, IF(amount >= @x, 'high', 'low') AS i FROM APP1" },
  { id: "A05", placement: "KLIKE right operand", sql: "SET @x = 'urgent'; SELECT * FROM APP1 WHERE subject KLIKE @x" },
  { id: "A06", placement: "IN list element", sql: "SET @x = 'A'; SELECT * FROM APP1 WHERE category IN (@x, 'B')" },
  { id: "A07", placement: "parenthesis-free IN array", sql: "SET @list = ['A', 'B']; SELECT * FROM APP1 WHERE category IN @list" },
  { id: "A08", placement: "SELECT constant column", sql: "SET @x = 'A'; SELECT @x AS constant_value" },
  { id: "A09", placement: "IMPORT SELECT projection", sql: "SET @x = 'A'; IMPORT INTO APP1 (value) FROM CSV source SELECT @x AS value", import: true },
  { id: "A10", placement: "UPDATE SET value", sql: "SET @x = 10; UPDATE APP1 SET amount = @x WHERE $id = 1" },
  { id: "A11", placement: "UPDATE FROM SET value", sql: "SET @x = 10; UPDATE APP1 SET amount = @x FROM APP2 AS source WHERE APP1.$id = source.$id" },
  { id: "A12", placement: "ASSERT operand", sql: "SET @x = 10; ASSERT @x >= 0" },
  { id: "A13", placement: "prior variable in a SET scalar subquery", sql: "SET @a = 10; SET @b = (SELECT COUNT(*) FROM APP1 WHERE amount >= @a); ASSERT @b >= 0" },
];

test.each(acceptedPlacements)("$id accepts a variable in $placement", ({ sql, import: importEnabled }) => {
  const statements = parseSqlStatements(sql, { import: importEnabled });
  expect(() => analyzeBatch(statements)).not.toThrow();
});

const rejectedPlacements: RejectedPlacementCase[] = [
  {
    id: "R01",
    placement: "a direct INSERT/UPSERT VALUES element",
    sql: [
      "SET @x = 10; INSERT INTO APP1 (amount) VALUES (@x)",
      "SET @x = 10; UPSERT INTO APP1 (amount) VALUES (@x) ON DUPLICATE (amount)",
    ],
  },
  {
    id: "R02",
    placement: "LIMIT/OFFSET",
    sql: [
      "SET @n = 10; SELECT * FROM APP1 LIMIT @n",
      "SET @n = 10; SELECT * FROM APP1 LIMIT 10 OFFSET @n",
    ],
  },
  { id: "R03", placement: "a condition left operand", sql: "SET @x = 10; SELECT * FROM APP1 WHERE @x = amount" },
  {
    id: "R04",
    placement: "an outer SET/DECLARE expression",
    sql: [
      "SET @a = 10; SET @b = @a / 2; SELECT @b AS value",
      "DECLARE @a = 10; DECLARE @b = @a; SELECT @b AS value",
    ],
  },
];

test.each(rejectedPlacements)("$id rejects a variable in $placement", ({ sql }) => {
  for (const statement of Array.isArray(sql) ? sql : [sql]) {
    expect(() => parseSqlStatements(statement)).toThrow();
  }
});

test("R05 tokenizes @max金額 as @max followed by 金額 and the placement is rejected", () => {
  expect(new Lexer("@max金額").tokenize().map(({ kind, value }) => ({ kind, value }))).toEqual([
    { kind: TokenKind.VARIABLE, value: "@max" },
    { kind: TokenKind.IDENT, value: "金額" },
    { kind: TokenKind.EOF, value: "" },
  ]);
  expect(() => parseSqlStatements(
    "SET @max = 10; SELECT * FROM APP1 WHERE amount = @max金額"
  )).toThrow();
});
