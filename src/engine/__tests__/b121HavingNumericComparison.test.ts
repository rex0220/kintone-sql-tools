import type { KintoneRecord } from "../../converter/dmlToKintone";
import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";
import type { SelectStatement } from "../../types/ast";
import { syntheticSemantics } from "../../core/fieldSemantics";
import type { FieldSemanticsResolver } from "../evalWhere";
import { runFullScan, type AggregateSortKindResolver } from "../process";

function parseSelect(sql: string): SelectStatement {
  return new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement;
}

function records(rows: Array<Record<string, string>>): KintoneRecord[] {
  return rows.map((row) => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, { value }])
  ));
}

function run(
  sql: string,
  rows: Array<Record<string, string>>,
  aggregateSortKindResolver?: AggregateSortKindResolver,
  havingFieldSemanticsResolver?: FieldSemanticsResolver
) {
  return runFullScan({
    stmt: parseSelect(sql),
    tables: new Map([[null, records(rows)]]),
    aggregateSortKindResolver,
    havingFieldSemanticsResolver,
  });
}

const app4149 = [
  ["A", 10_350_000], ["A", 10_350_000],
  ["B", 4_525_000], ["B", 4_525_000],
  ["C", 5_000_000], ["C", 5_000_000],
  ["D", 6_000_000], ["D", 6_000_000],
  ["E", 4_000_000], ["E", 4_000_000],
  ["F", 50], ["F", 50],
  ["G", 5], ["G", 15],
  ["H", 10], ["H", 10],
  ["I", 0], ["I", 0],
  ["J", 0], ["J", 0],
].map(([company, amount]) => ({ company: String(company), amount: String(amount) }));

test.each([
  ["COUNT", "COUNT(*)", ">", "10", 0],
  ["AVG", "AVG(amount)", ">", "9", 8],
  ["SUM threshold", "SUM(amount)", ">=", "9050000", 4],
  ["SUM digit boundary", "SUM(amount)", ">", "9", 8],
] as const)(
  "B121-E01: %s を桁違い境界で数値比較する",
  (_label, aggregate, op, threshold, expectedRows) => {
    const result = run(
      `SELECT company, ${aggregate} AS value FROM APP1 GROUP BY company ` +
      `HAVING ${aggregate} ${op} ${threshold}`,
      app4149
    );
    expect(result.rows).toHaveLength(expectedRows);
  }
);

const typedAggregateRows = [
  { company: "A", numeric_value: "10", text_value: "10" },
  { company: "A", numeric_value: "20", text_value: "20" },
];

test.each([
  ["MIN(number)", "MIN(numeric_value)", "number", 1],
  ["MAX(number)", "MAX(numeric_value)", "number", 1],
  ["MIN(string)", "MIN(text_value)", "string", 0],
  ["MAX(string)", "MAX(text_value)", "string", 0],
  ["GROUP_CONCAT", "GROUP_CONCAT(text_value)", "string", 0],
  ["MODE", "MODE(text_value)", "string", 0],
] as const)(
  "B121-E02: %s の比較型を維持する",
  (_label, aggregate, _semantics, expectedRows) => {
    const result = run(
      `SELECT company, ${aggregate} AS value FROM APP1 GROUP BY company HAVING ${aggregate} > 9`,
      typedAggregateRows,
      (field) => field.field === "numeric_value" ? "number" : "string"
    );
    expect(result.rows).toHaveLength(expectedRows);
  }
);

test("B121-R01: HAVING の既存の直接集計・条件付き集計・別名参照を維持する", () => {
  const rows = [
    ...Array.from({ length: 10 }, () => ({ company: "A", amount: "1", enabled: "yes" })),
    ...Array.from({ length: 2 }, () => ({ company: "B", amount: "1", enabled: "yes" })),
  ];

  expect(run(
    "SELECT company, COUNT(*) AS count FROM APP1 GROUP BY company HAVING COUNT(*) >= 3",
    rows
  ).rows.map((row) => row.company)).toEqual(["A"]);

  expect(run(
    "SELECT company, SUM(CASE WHEN enabled = 'yes' THEN amount ELSE 0 END) AS total " +
    "FROM APP1 GROUP BY company HAVING SUM(CASE WHEN enabled = 'yes' THEN amount ELSE 0 END) > 9",
    rows
  ).rows.map((row) => row.company)).toEqual(["A"]);

  expect(run(
    "SELECT company, SUM(amount) AS total FROM APP1 GROUP BY company HAVING total > 9",
    rows,
    () => "number",
    (field) => field.field === "total" ? syntheticSemantics("number") : undefined
  ).rows.map((row) => row.company)).toEqual(["A"]);
});
