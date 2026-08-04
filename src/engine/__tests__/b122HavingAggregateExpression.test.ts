import type { KintoneRecord } from "../../converter/dmlToKintone";
import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";
import type { SelectStatement } from "../../types/ast";
import { syntheticSemantics } from "../../core/fieldSemantics";
import { runFullScan } from "../process";

function parseSelect(sql: string): SelectStatement {
  return new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement;
}

function records(rows: Array<Record<string, string>>): KintoneRecord[] {
  return rows.map((row) => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, { value }])
  ));
}

function run(sql: string) {
  return runFullScan({
    stmt: parseSelect(sql),
    tables: new Map([[null, records(app4149)]]),
    havingFieldSemanticsResolver: (field) => field.field === "metric"
      ? syntheticSemantics("number")
      : undefined,
  });
}

const app4149 = [
  ...["A", "B", "C", "D"].flatMap((company) =>
    Array.from({ length: 3 }, () => ({ company, amount: "4000000", enabled: "yes" }))
  ),
  ...Array.from({ length: 3 }, () => ({ company: "E", amount: "10", enabled: "yes" })),
  ...["F", "G", "H"].map((company) => ({ company, amount: "10", enabled: "yes" })),
  { company: "I", amount: "9", enabled: "yes" },
  { company: "J", amount: "0", enabled: "yes" },
];

test.each([
  ["SUM - literal", "SUM(amount) - 0", "> 9", 8],
  ["SUM * literal", "SUM(amount) * 1", "> 9", 8],
  ["aggregate difference", "SUM(amount) - SUM(amount)", "> -1", 10],
  ["COUNT arithmetic", "COUNT(*) + 0", "> 1", 5],
  ["scalar wrapper", "ROUND(AVG(amount), 0)", "> 9", 8],
] as const)("B122-E01: %s の直接参照と別名参照を桁違い境界で一致させる", (
  _label,
  expression,
  condition,
  expectedRows
) => {
  const direct = run(
    `SELECT company, ${expression} AS metric FROM APP1 GROUP BY company HAVING ${expression} ${condition}`
  );
  const alias = run(
    `SELECT company, ${expression} AS metric FROM APP1 GROUP BY company HAVING metric ${condition}`
  );

  expect(direct.rows.map((row) => row.company)).toEqual(alias.rows.map((row) => row.company));
  expect(direct.rows).toHaveLength(expectedRows);
});

test("B122-R01: B119/B120/B121 の集計引数・CASE・直接集計・別名参照を維持する", () => {
  expect(run(
    "SELECT company, SUM(CASE WHEN enabled = 'yes' THEN amount ELSE 0 END) AS metric " +
    "FROM APP1 GROUP BY company HAVING SUM(CASE WHEN enabled = 'yes' THEN amount ELSE 0 END) > 9"
  ).rows).toHaveLength(8);

  expect(run(
    "SELECT company, SUM(ROUND(amount)) AS metric FROM APP1 GROUP BY company HAVING metric > 9"
  ).rows).toHaveLength(8);

  expect(run(
    "SELECT company, CASE WHEN SUM(amount) > 9 THEN SUM(amount) ELSE 0 END AS metric " +
    "FROM APP1 GROUP BY company HAVING metric > 9"
  ).rows).toHaveLength(8);

  expect(run(
    "SELECT company, COUNT(*) AS metric FROM APP1 GROUP BY company HAVING COUNT(*) >= 3"
  ).rows).toHaveLength(5);
});
