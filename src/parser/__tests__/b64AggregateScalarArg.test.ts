import { Lexer } from "../../lexer/lexer";
import type { AggregateColumn, SelectStatement } from "../../types/ast";
import { Parser, ParseError } from "../parser";

function parseSelect(sql: string): SelectStatement {
  return new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement;
}

function aggregate(sql: string): AggregateColumn {
  return parseSelect(sql).columns[0] as AggregateColumn;
}

test("B64-P01/P02: CASE と括弧付き CASE を集計引数として受理する", () => {
  const plain = aggregate("SELECT SUM(CASE WHEN p = 1 THEN n ELSE 0 END) FROM APP1");
  const wrapped = aggregate("SELECT SUM((CASE WHEN p = 1 THEN n ELSE 0 END)) FROM APP1");
  expect(plain.arg.type).toBe("CASE_WHEN");
  expect(wrapped.arg).toEqual(plain.arg);
  expect(aggregate("SELECT SUM((CASE WHEN p = 1 THEN n ELSE 0 END) + 0) FROM APP1").arg.type).toBe("SCALAR_ARITH");
});

test("B64-P03: 全12集計が CASE 引数を受理する", () => {
  const functions = [
    "COUNT", "SUM", "AVG", "MIN", "MAX", "GROUP_CONCAT",
    "STDDEV_POP", "STDDEV_SAMP", "VAR_POP", "VAR_SAMP", "MEDIAN", "MODE",
  ];
  for (const func of functions) {
    expect(aggregate(`SELECT ${func}(CASE WHEN p = 1 THEN n END) FROM APP1`).arg.type).toBe("CASE_WHEN");
  }
});

test("B64-P04: DISTINCT と GROUP_CONCAT SEPARATOR を保持する", () => {
  expect(aggregate("SELECT COUNT(DISTINCT CASE WHEN p = 1 THEN n END) FROM APP1")).toMatchObject({
    distinct: true, arg: { type: "CASE_WHEN" },
  });
  expect(aggregate("SELECT GROUP_CONCAT(DISTINCT CASE WHEN p = 1 THEN n END SEPARATOR '/') FROM APP1")).toMatchObject({
    distinct: true, separator: "/", arg: { type: "CASE_WHEN" },
  });
});

test("B64-P05/P13: HAVING と SELECT は空白・大小によらず同じ canonical 集計名を使う", () => {
  const a = parseSelect("SELECT x, SUM(CASE WHEN x=1 THEN 1 END) FROM APP1 GROUP BY x HAVING sum( CASE WHEN x = 1 THEN 1 END ) > 0");
  const b = parseSelect("SELECT x, SUM( CASE WHEN x = 1 THEN 1 END ) FROM APP1 GROUP BY x HAVING SUM(CASE WHEN x=1 THEN 1 END) > 0");
  expect(a.having).toMatchObject({ type: "BINARY", left: { type: "FIELD" } });
  expect(b.having).toMatchObject({ type: "BINARY", left: { type: "FIELD" } });
  const ah = a.having!;
  const bh = b.having!;
  const aName = ah.type === "BINARY" && ah.left.type === "FIELD" ? ah.left.field : "";
  const bName = bh.type === "BINARY" && bh.left.type === "FIELD" ? bh.left.field : "";
  expect(aName).toBe("SUM(CASE WHEN x = 1 THEN 1 END)");
  expect(bName).toBe(aName);
});

test("B64-P06: 既存算術引数 AST は変わらない", () => {
  expect(aggregate("SELECT SUM((amount + 1) * 2) FROM APP1").arg).toEqual({
    type: "ARITH",
    left: { type: "ARITH", left: { type: "FIELD_REF", field: "amount" }, op: "+", right: { type: "NUMBER", value: 1, raw: "1" } },
    op: "*",
    right: { type: "NUMBER", value: 2, raw: "2" },
  });
});

test.each([
  "SELECT SUM(SUM(x)) FROM APP1",
  "SELECT SUM(CASE WHEN SUM(x) > 0 THEN 1 END) FROM APP1",
  "SELECT SUM(CASE WHEN x = 1 THEN SUM(x) END) FROM APP1",
])("B64-P07/P08: ネスト集約を専用エラーで拒否する: %s", (sql) => {
  expect(() => parseSelect(sql)).toThrow("集計関数の引数内に集計関数は使用できません");
});

test.each(["SUM(amount > 0)", "COUNT(amount > 0)"])(
  "B64-P09: 比較引数を拒否し CASE を案内する: %s",
  (expr) => expect(() => parseSelect(`SELECT ${expr} FROM APP1`)).toThrow(/CASE.*SUM\(CASE WHEN amount > 0 THEN 1 ELSE 0 END\)/)
);

test("B64-P10: wildcard の既存拒否を維持する", () => {
  expect(() => parseSelect("SELECT GROUP_CONCAT(*) FROM APP1")).toThrow(ParseError);
});

test("B64-P11/P12: || と裸の @var を受理する", () => {
  expect(aggregate("SELECT GROUP_CONCAT(name || '!') FROM APP1").arg.type).toBe("CONCAT_OP");
  expect(aggregate("SELECT SUM(@rate) FROM APP1").arg).toEqual({ type: "VARIABLE", name: "rate" });
  for (const func of ["COUNT", "SUM", "AVG", "MIN", "MAX", "GROUP_CONCAT", "STDDEV_POP", "STDDEV_SAMP", "VAR_POP", "VAR_SAMP", "MEDIAN", "MODE"]) {
    expect(aggregate(`SELECT ${func}('1' || '') FROM APP1`).arg.type).toBe("CONCAT_OP");
    expect(aggregate(`SELECT ${func}(@v) FROM APP1`).arg.type).toBe("VARIABLE");
  }
});
