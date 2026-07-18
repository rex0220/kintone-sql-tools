import { Lexer, LexError } from "../../lexer/lexer";
import { Parser, ParseError } from "../parser";
import type { SelectStatement, UpdateStatement } from "../../types/ast";

function parseScalar(sql: string) {
  return new Parser(new Lexer(sql).tokenize()).parseScalarValueExpr();
}

function parse(sql: string) {
  return new Parser(new Lexer(sql).tokenize()).parse();
}

test("|| は + / - と同順位で左結合、* / は高順位", () => {
  expect(parseScalar("'a'||'b'||'c'")).toEqual({
    type: "CONCAT_OP",
    left: {
      type: "CONCAT_OP",
      left: { type: "STRING", value: "a" },
      right: { type: "STRING", value: "b" },
    },
    right: { type: "STRING", value: "c" },
  });
  const expr = parseScalar("1||2+3*4");
  expect(expr.type).toBe("SCALAR_ARITH");
  if (expr.type === "SCALAR_ARITH") {
    expect(expr.left.type).toBe("CONCAT_OP");
    expect(expr.right).toMatchObject({ type: "SCALAR_ARITH", op: "*" });
  }
});

test("parseScalarValueExpr は修飾 FIELD・@var・関数・停止トークンを受理する", () => {
  expect(parseScalar("APP100.name||CONCAT('-', @v), ignored")).toMatchObject({
    type: "CONCAT_OP",
    left: { type: "FIELD", tableAlias: "APP100", field: "name" },
    right: {
      type: "STRING_FUNC",
      args: [{ type: "STRING", value: "-" }, { type: "VARIABLE", name: "v" }],
    },
  });
});

test.each(["(SELECT x FROM APP1)", "SUM(x)", "FORMAT(SUM(x))", "x IS NULL", "x = 1"])(
  "parseScalarValueExpr は値式外の構文を拒否する: %s",
  (sql) => expect(() => parseScalar(sql)).toThrow(ParseError)
);

test("関数引数は @var・||・入れ子 scalar-value を受理する", () => {
  const stmt = parse("SELECT CONCAT('x=', @v)||'!', CONCAT(UPPER(@v), x), CONCAT('a'||'b', x) FROM APP100") as SelectStatement;
  expect(stmt.columns[0]).toMatchObject({ type: "SCALAR_VALUE_COL" });
  expect(stmt.columns[1]).toMatchObject({
    type: "STRFUNC_COL",
    expr: { args: [{ type: "STRING_FUNC", args: [{ type: "VARIABLE", name: "v" }] }, { type: "FIELD", field: "x" }] },
  });
});

test("SELECT・UPDATE SET・CASE 結果で || を解析する", () => {
  expect((parse("SELECT a||b FROM APP100") as SelectStatement).columns[0]).toMatchObject({ type: "SCALAR_VALUE_COL" });
  const update = parse("UPDATE APP100 SET label = prefix||'-'||suffix WHERE $id = 1") as UpdateStatement;
  expect(update.assignments[0].value).toMatchObject({ type: "CONCAT_OP" });
  const caseCol = (parse("SELECT CASE WHEN x = 1 THEN 'a'||x ELSE '' END FROM APP100") as SelectStatement).columns[0];
  expect(caseCol).toMatchObject({ type: "CASE_COL", expr: { branches: [{ result: { type: "CONCAT_OP" } }] } });
});

test("単独 | はトークン化されない", () => {
  expect(() => new Lexer("'a'|'b'").tokenize()).toThrow(LexError);
});
