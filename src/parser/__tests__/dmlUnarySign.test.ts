import { Lexer } from "../../lexer/lexer";
import { Parser, ParseError } from "../parser";
import type { ExplainStatement, InsertStatement, UpdateStatement, UpsertStatement } from "../../types/ast";

function parse(sql: string) {
  return new Parser(new Lexer(sql).tokenize()).parse();
}

const signedNumbers = [
  ["-5", -5],
  ["+5", 5],
  ["-0", -0],
  ["+0", 0],
  ["-0.5", -0.5],
  ["+0.5", 0.5],
] as const;

function numberValue(value: InsertStatement["values"][number][number]): number {
  expect(value.type).toBe("NUMBER");
  return (value as { type: "NUMBER"; value: number }).value;
}

test.each(signedNumbers)("親 INSERT VALUES が %s を NumberLiteral として受理する", (source, value) => {
  const ast = parse(`INSERT INTO APP100 (n) VALUES (${source})`) as InsertStatement;
  expect(Object.is(numberValue(ast.values[0][0]), value)).toBe(true);
});

test.each(signedNumbers)("サブテーブル INSERT VALUES が %s を NumberLiteral として受理する", (source, value) => {
  const ast = parse(`INSERT INTO APP100$rows (_pid, n) VALUES (1, ${source})`) as InsertStatement;
  expect(Object.is(numberValue(ast.values[0][1]), value)).toBe(true);
});

test.each(signedNumbers)("UPSERT VALUES が %s を NumberLiteral として受理する", (source, value) => {
  const ast = parse(`UPSERT INTO APP100 (key, n) VALUES ('A', ${source}) ON DUPLICATE (key)`) as UpsertStatement;
  expect(Object.is(numberValue(ast.values[0][1]), value)).toBe(true);
});

test.each(signedNumbers)("UPDATE SET が %s を NumberLiteral として受理する", (source, value) => {
  const ast = parse(`UPDATE APP100 SET n = ${source} WHERE $id = 1`) as UpdateStatement;
  const literal = ast.assignments[0].value as { type: "NUMBER"; value: number };
  expect(Object.is(literal.value, value)).toBe(true);
});

test("複数行 VALUES の正負混在を各行に保持する", () => {
  const ast = parse("INSERT INTO APP100 (n) VALUES (-5), (+5), (-0.5), (+0.5)") as InsertStatement;
  expect(ast.values.map((row) => row[0])).toEqual([
    { type: "NUMBER", value: -5, raw: "-5" },
    { type: "NUMBER", value: 5, raw: "+5" },
    { type: "NUMBER", value: -0.5, raw: "-0.5" },
    { type: "NUMBER", value: 0.5, raw: "+0.5" },
  ]);
});

test.each([
  ["INSERT", "INSERT INTO APP100 (n) VALUES (+5)"],
  ["UPSERT", "UPSERT INTO APP100 (key, n) VALUES ('A', +5) ON DUPLICATE (key)"],
  ["UPDATE", "UPDATE APP100 SET n = +5 WHERE $id = 1"],
])("%s の通常・VALIDATE ONLY・ON ERROR SKIP が同じ NumberLiteral を持つ", (_label, baseSql) => {
  const normal = parse(baseSql) as InsertStatement | UpsertStatement | UpdateStatement;
  const validate = parse(`${baseSql} VALIDATE ONLY`) as typeof normal;
  const skip = parse(`${baseSql} ON ERROR SKIP INTO #err`) as typeof normal;
  const valuesOf = (ast: typeof normal) => ast.type === "UPDATE"
    ? ast.assignments.map((a) => a.value)
    : ast.values;
  expect(valuesOf(validate)).toEqual(valuesOf(normal));
  expect(valuesOf(skip)).toEqual(valuesOf(normal));
});

test.each([
  "INSERT INTO APP100 (n) VALUES (+5)",
  "UPSERT INTO APP100 (key, n) VALUES ('A', -5) ON DUPLICATE (key)",
  "UPDATE APP100 SET n = +0.5 WHERE $id = 1",
])("EXPLAIN と通常解析が同じ DML AST を持つ: %s", (sql) => {
  const direct = parse(sql);
  const explained = parse(`EXPLAIN ${sql}`) as ExplainStatement;
  expect(explained.query).toEqual(direct);
});

test.each(["--5", "+-5", "-+5", "++5"])("符号のネスト %s を VALUES と UPDATE で拒否する", (source) => {
  expect(() => parse(`INSERT INTO APP100 (n) VALUES (${source})`)).toThrow(ParseError);
  expect(() => parse(`UPDATE APP100 SET n = ${source} WHERE $id = 1`)).toThrow(ParseError);
});

test.each([
  "-'x'", "+'x'",
  "-['x']", "+['x']",
  "-CASE WHEN 1 = 1 THEN 1 ELSE 2 END", "+CASE WHEN 1 = 1 THEN 1 ELSE 2 END",
  "-@x", "+@x",
  "-)", "+)",
])("VALUES / UPDATE で符号直後の非 NUMBER を拒否する: %s", (source) => {
  expect(() => parse(`INSERT INTO APP100 (n) VALUES (${source})`)).toThrow(ParseError);
  expect(() => parse(`UPDATE APP100 SET n = ${source} WHERE $id = 1`)).toThrow(ParseError);
});

test.each(["-", "+"])("VALUES / UPDATE で符号直後の EOF を拒否する: %s", (source) => {
  expect(() => parse(`INSERT INTO APP100 (n) VALUES (${source}`)).toThrow(ParseError);
  expect(() => parse(`UPDATE APP100 SET n = ${source}`)).toThrow(ParseError);
});

test("単項 + は数値リテラル直前だけを受理し、単項 - の式・フィールド範囲は維持する", () => {
  expect(() => parse("UPDATE APP100 SET n = +field WHERE $id = 1")).toThrow(ParseError);
  expect(() => parse("UPDATE APP100 SET n = +(1 + 2) WHERE $id = 1")).toThrow(ParseError);
  expect(parse("UPDATE APP100 SET n = -field WHERE $id = 1")).toMatchObject({ type: "UPDATE" });
  expect(parse("UPDATE APP100 SET n = -(field + 2) WHERE $id = 1")).toMatchObject({ type: "UPDATE" });
});

test.each([
  "INSERT INTO APP100 (n) VALUES (1 + 2)",
  "INSERT INTO APP100 (n) VALUES (field)",
  "INSERT INTO APP100 (n) VALUES (ROUND(1))",
])("VALUES の算術式・フィールド参照・関数は従来どおり拒否する: %s", (sql) => {
  expect(() => parse(sql)).toThrow(ParseError);
});

test("引用符内の '-5' は文字列のまま保持する", () => {
  const ast = parse("INSERT INTO APP100 (n) VALUES ('-5')") as InsertStatement;
  expect(ast.values[0][0]).toEqual({ type: "STRING", value: "-5" });
});

test.each([
  "INSERT INTO #tmp (n) VALUES (-5)",
  "UPSERT INTO #tmp (key, n) VALUES ('A', +5) ON DUPLICATE (key)",
  "UPDATE #tmp SET n = -5 WHERE $id = 1",
])("一時テーブル対象 DML は引き続き拒否する: %s", (sql) => {
  expect(() => parse(sql)).toThrow(ParseError);
});

test("INSERT/UPSERT SELECT の既存の算術式を維持する", () => {
  expect(parse("INSERT INTO APP100 (n) SELECT 0 - 5 AS n")).toMatchObject({ type: "INSERT_SELECT" });
  expect(parse("UPSERT INTO APP100 (key, n) SELECT key, n - 5 AS n FROM APP200 ON DUPLICATE (key)"))
    .toMatchObject({ type: "UPSERT_SELECT" });
  expect(() => parse("INSERT INTO APP100 (n) SELECT n + +5 FROM APP200")).toThrow(ParseError);
  expect(() => parse("UPSERT INTO APP100 (key, n) SELECT key, n + +5 FROM APP200 ON DUPLICATE (key)"))
    .toThrow(ParseError);
});
