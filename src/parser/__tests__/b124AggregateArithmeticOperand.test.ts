import { Lexer } from "../../lexer/lexer";
import type { SelectStatement } from "../../types/ast";
import { Parser } from "../parser";

function parseSelect(sql: string): SelectStatement {
  return new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement;
}

test("B124-P01: GROUP BY キーと変数を集計算術式の leaf として保持する", () => {
  const key = parseSelect("SELECT kind, SUM(amount) * price AS total FROM APP1 GROUP BY kind, price");
  expect(key.columns[1]).toMatchObject({
    type: "ARITH_AGG_COL",
    expr: {
      type: "AGG_ARITH",
      left: { type: "AGG_REF", func: "SUM" },
      right: { type: "AGG_GROUP_KEY", field: "price" },
    },
  });

  const variable = parseSelect("SELECT kind, SUM(amount) * @rate AS total FROM APP1 GROUP BY kind");
  expect(variable.columns[1]).toMatchObject({
    type: "ARITH_AGG_COL",
    expr: { right: { type: "VARIABLE", name: "rate" } },
  });
});

test("B124-P02: SELECT・HAVING・CASE・文字列関数で同じ leaf を受理する", () => {
  expect(() => parseSelect(
    "SELECT kind, SUM(amount) * price AS total FROM APP1 GROUP BY kind, price " +
    "HAVING SUM(amount) * price > 9"
  )).not.toThrow();
  expect(() => parseSelect(
    "SELECT kind, CASE WHEN kind = 'A' THEN SUM(amount) * price ELSE 0 END AS total " +
    "FROM APP1 GROUP BY kind, price"
  )).not.toThrow();
  expect(() => parseSelect(
    "SELECT kind, FORMAT(SUM(amount) * price, '#') AS total FROM APP1 GROUP BY kind, price"
  )).not.toThrow();
});

test.each([
  ["GROUP BY に無い", "SELECT kind, SUM(amount) * price FROM APP1 GROUP BY kind", "集計算術式のフィールド参照は GROUP BY に書いた表記と一致する列だけです（price）。グループ内で値が定まらないためです。"],
  ["GROUP BY なし", "SELECT SUM(amount) * price FROM APP1", "集計算術式にフィールドを書くには GROUP BY が必要です（price）。"],
  ["ROLLUP", "SELECT SUM(amount) * price FROM APP1 GROUP BY ROLLUP(price)", "ROLLUP / CUBE / GROUPING SETS では集計算術式にフィールドを書けません（小計・総計行で値が定まらないためです）。"],
  ["CUBE HAVING", "SELECT price, SUM(amount) FROM APP1 GROUP BY CUBE(price) HAVING SUM(amount) * price > 0", "ROLLUP / CUBE / GROUPING SETS では集計算術式にフィールドを書けません（小計・総計行で値が定まらないためです）。"],
  ["GROUPING SETS", "SELECT SUM(amount) * price FROM APP1 GROUP BY GROUPING SETS ((price), ())", "ROLLUP / CUBE / GROUPING SETS では集計算術式にフィールドを書けません（小計・総計行で値が定まらないためです）。"],
  ["表記不一致", "SELECT SUM(amount) * price FROM APP1 m GROUP BY m.price", "集計算術式のフィールド参照は GROUP BY に書いた表記と一致する列だけです（price）。グループ内で値が定まらないためです。"],
  ["内側 SELECT の外側キー", "SELECT kind, (SELECT SUM(value) * kind FROM APP2 GROUP BY other) AS x FROM APP1 GROUP BY kind", "集計算術式のフィールド参照は GROUP BY に書いた表記と一致する列だけです（kind）。グループ内で値が定まらないためです。"],
] as const)("B124-X01: %s を fail-closed で拒否する", (_label, sql, message) => {
  expect(() => parseSelect(sql)).toThrow(message);
});

test.each([
  "SELECT price * SUM(amount) FROM APP1 GROUP BY price",
  "SELECT @rate * SUM(amount) FROM APP1 GROUP BY price",
  "SELECT (price + SUM(amount)) FROM APP1 GROUP BY price",
  "SELECT price, SUM(amount) FROM APP1 GROUP BY price HAVING price * SUM(amount) > 0",
])("B124-X02: 非集計始まりを専用診断で拒否する: %s", (sql) => {
  expect(() => parseSelect(sql)).toThrow("集計算術式は集計関数から始まる必要があります");
});
