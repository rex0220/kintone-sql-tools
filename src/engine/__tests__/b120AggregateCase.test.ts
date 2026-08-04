import type { KintoneRecord } from "../../converter/dmlToKintone";
import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";
import type { SelectStatement } from "../../types/ast";
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
  aggregateSortKindResolver?: AggregateSortKindResolver
) {
  return runFullScan({
    stmt: parseSelect(sql),
    tables: new Map([[null, records(rows)]]),
    aggregateSortKindResolver,
  });
}

const base = [
  { company: "A", a: "10", b: "2" },
  { company: "A", a: "20", b: "3" },
  { company: "B", a: "5", b: "0" },
];

test("B120-E01: GROUP BY なしの CASE 内 COUNT を 1 行で評価し、空入力も 1 行返す", () => {
  expect(run(
    "SELECT CASE WHEN COUNT(*) = 0 THEN 'none' ELSE 'some' END AS result FROM APP1",
    base
  ).rows).toEqual([{ result: "some" }]);

  expect(run(
    "SELECT CASE WHEN COUNT(*) = 0 THEN 'none' ELSE 'some' END AS result FROM APP1 WHERE company = 'missing'",
    base
  ).rows).toEqual([{ result: "none" }]);
});

test("B120-E02: GROUP BY ごとに CASE 条件の SUM を評価する", () => {
  expect(run(
    "SELECT company, CASE WHEN SUM(b) = 0 THEN 'zero' ELSE 'some' END AS result " +
    "FROM APP1 GROUP BY company ORDER BY company",
    base
  ).rows).toEqual([
    { company: "A", result: "some" },
    { company: "B", result: "zero" },
  ]);
});

test("B120-E03: CASE でゼロ除算を避け、ELSE の集計算術を ROUND できる", () => {
  expect(run(
    "SELECT company, CASE WHEN SUM(b) = 0 THEN '' ELSE ROUND(SUM(a) * 100.0 / SUM(b), 1) END AS rate " +
    "FROM APP1 GROUP BY company ORDER BY company",
    base
  ).rows).toEqual([
    { company: "A", rate: "600" },
    { company: "B", rate: "" },
  ]);
});

test("B120-E04: CASE の THEN/ELSE にある直接集計をグループ単位で評価する", () => {
  expect(run(
    "SELECT company, CASE WHEN company = 'A' THEN SUM(a) ELSE MAX(b) END AS value " +
    "FROM APP1 GROUP BY company ORDER BY company",
    base
  ).rows).toEqual([
    { company: "A", value: "30" },
    { company: "B", value: "0" },
  ]);
});

test("B120-E05: CASE 条件内の集計を桁数が異なる境界でも数値比較する", () => {
  expect(run(
    `SELECT
      CASE WHEN COUNT(*) > 2 THEN 'gt' ELSE 'ng' END AS gt,
      CASE WHEN COUNT(*) < 20 THEN 'lt' ELSE 'ng' END AS lt,
      CASE WHEN SUM(a) >= 35 THEN 'ge' ELSE 'ng' END AS ge,
      CASE WHEN SUM(a) <= 100 THEN 'le' ELSE 'ng' END AS le,
      CASE WHEN AVG(a) > 9 THEN 'avg' ELSE 'ng' END AS avg_gt
    FROM APP1`,
    base
  ).rows).toEqual([{ gt: "gt", lt: "lt", ge: "ge", le: "le", avg_gt: "avg" }]);

  expect(run(
    `SELECT company,
      CASE WHEN SUM(a) > 9 THEN 'gt' ELSE 'ng' END AS gt,
      CASE WHEN SUM(a) < 100 THEN 'lt' ELSE 'ng' END AS lt,
      CASE WHEN COUNT(*) >= 2 THEN 'ge' ELSE 'ng' END AS ge,
      CASE WHEN COUNT(*) <= 10 THEN 'le' ELSE 'ng' END AS le
    FROM APP1 GROUP BY company ORDER BY company`,
    base
  ).rows).toEqual([
    { company: "A", gt: "gt", lt: "lt", ge: "ge", le: "le" },
    { company: "B", gt: "ng", lt: "lt", ge: "ng", le: "le" },
  ]);
});

test("B120-E05b: CASE 条件内の MIN/MAX は引数型、文字列集計は文字列で比較する", () => {
  expect(run(
    `SELECT company,
      CASE WHEN MIN(a) > 9 THEN 'yes' ELSE 'no' END AS min_numeric,
      CASE WHEN MAX(a) > 9 THEN 'yes' ELSE 'no' END AS max_numeric,
      CASE WHEN GROUP_CONCAT(a) < '9' THEN 'yes' ELSE 'no' END AS concat_string,
      CASE WHEN MODE(a) < 20 THEN 'yes' ELSE 'no' END AS mode_string
    FROM APP1 GROUP BY company ORDER BY company`,
    base,
    () => "number"
  ).rows).toEqual([
    { company: "A", min_numeric: "yes", max_numeric: "yes", concat_string: "yes", mode_string: "yes" },
    { company: "B", min_numeric: "no", max_numeric: "no", concat_string: "yes", mode_string: "no" },
  ]);
});

const aggregateComparisonRows = Array.from({ length: 20 }, (_, index) => ({
  company: "A",
  sum_value: index === 0 ? "7200000" : "0",
  avg_value: "7200000",
  min_max_number: index === 0 ? "7100000" : "7200000",
  min_max_text: index === 0 ? "7100000" : "7200000",
  text_value: "7200000",
}));

const aggregateComparisonCases = [
  { label: "COUNT", expression: "COUNT(*)", semantics: "number" },
  { label: "SUM", expression: "SUM(sum_value)", semantics: "number" },
  { label: "AVG", expression: "AVG(avg_value)", semantics: "number" },
  { label: "MIN(number)", expression: "MIN(min_max_number)", semantics: "number" },
  { label: "MAX(number)", expression: "MAX(min_max_number)", semantics: "number" },
  { label: "MIN(string)", expression: "MIN(min_max_text)", semantics: "string" },
  { label: "MAX(string)", expression: "MAX(min_max_text)", semantics: "string" },
  { label: "GROUP_CONCAT", expression: "GROUP_CONCAT(text_value)", semantics: "string" },
  { label: "MODE", expression: "MODE(text_value)", semantics: "string" },
] as const;

test.each(aggregateComparisonCases.flatMap((aggregate) => [false, true].map((grouped) => ({
  ...aggregate,
  grouped,
}))))(
  "B120-E05c: $label, GROUP BY=$grouped の CASE 比較意味論を維持する",
  ({ expression, semantics, grouped }) => {
    const result = run(
      `SELECT
        CASE WHEN ${expression} > 9 THEN 'yes' ELSE 'no' END AS gt_9,
        CASE WHEN ${expression} > 100000000 THEN 'yes' ELSE 'no' END AS gt_100m
      FROM APP1${grouped ? " GROUP BY company" : ""}`,
      aggregateComparisonRows,
      (field) => field.field === "min_max_text" || field.field === "text_value" ? "string" : "number"
    );
    const expected = semantics === "number"
      ? { gt_9: "yes", gt_100m: "no" }
      : { gt_9: "no", gt_100m: "yes" };
    expect(result.rows).toEqual([expected]);
  }
);

test("B120-E06: CASE の THEN/ELSE にある集計値と数値を分岐結果として返す", () => {
  expect(run(
    "SELECT CASE WHEN COUNT(*) > 2 THEN SUM(a) ELSE 0 END AS value FROM APP1",
    base
  ).rows).toEqual([{ value: "35" }]);

  expect(run(
    "SELECT company, CASE WHEN COUNT(*) >= 2 THEN SUM(a) ELSE 0 END AS value " +
    "FROM APP1 GROUP BY company ORDER BY company",
    base
  ).rows).toEqual([
    { company: "A", value: "30" },
    { company: "B", value: "0" },
  ]);
});

test("B120-E07: 別名のない複数 CASE を一意な列キーへ対応付ける", () => {
  const ungrouped = run(
    "SELECT CASE WHEN COUNT(*) > 0 THEN 'some' ELSE 'none' END, " +
    "CASE WHEN SUM(a) > 100 THEN 'large' ELSE 'small' END FROM APP1",
    base
  );
  expect(ungrouped.columns).toEqual(["case", "case_2"]);
  expect(ungrouped.rows).toEqual([{ case: "some", case_2: "small" }]);

  const grouped = run(
    "SELECT CASE WHEN COUNT(*) > 1 THEN 'many' ELSE 'one' END, " +
    "CASE WHEN SUM(a) > 9 THEN 'large' ELSE 'small' END " +
    "FROM APP1 GROUP BY company ORDER BY company",
    base
  );
  expect(grouped.columns).toEqual(["case", "case_2"]);
  expect(grouped.rows).toEqual([
    { case: "many", case_2: "large" },
    { case: "one", case_2: "small" },
  ]);
});

test("B120-E08: CASE の別名あり・なしを混在させても値を取り違えない", () => {
  expect(run(
    "SELECT CASE WHEN COUNT(*) > 0 THEN 'some' ELSE 'none' END, " +
    "CASE WHEN SUM(a) > 100 THEN 'large' ELSE 'small' END AS size FROM APP1",
    base
  )).toMatchObject({
    columns: ["case", "size"],
    rows: [{ case: "some", size: "small" }],
  });

  expect(run(
    "SELECT CASE WHEN COUNT(*) > 1 THEN 'many' ELSE 'one' END AS amount, " +
    "CASE WHEN SUM(a) > 9 THEN 'large' ELSE 'small' END " +
    "FROM APP1 GROUP BY company ORDER BY company",
    base
  )).toMatchObject({
    columns: ["amount", "case"],
    rows: [
      { amount: "many", case: "large" },
      { amount: "one", case: "small" },
    ],
  });
});

test("B120-E09: ORDER BY から集計入り・集計なしの CASE 別名を評価する", () => {
  expect(run(
    "SELECT company, CASE WHEN SUM(a) > 9 THEN 'large' ELSE 'small' END AS size " +
    "FROM APP1 GROUP BY company ORDER BY size, company",
    base
  ).rows).toEqual([
    { company: "A", size: "large" },
    { company: "B", size: "small" },
  ]);

  expect(run(
    "SELECT company, CASE WHEN company = 'A' THEN 'large' ELSE 'small' END AS size " +
    "FROM APP1 ORDER BY size, company",
    base
  ).rows).toEqual([
    { company: "A", size: "large" },
    { company: "A", size: "large" },
    { company: "B", size: "small" },
  ]);
});

test("B120-R02: スカラー関数内集計と集計引数 CASE の既存経路を維持する", () => {
  const scalar = run(`SELECT
    UPPER(MIN(company)) AS upper_min,
    LENGTH(MAX(company)) AS max_length,
    ROUND(SUM(a), -1) AS rounded_sum,
    ROUND(AVG(a), 1) AS rounded_avg,
    GREATEST(SUM(a), 1) AS greatest_sum,
    COALESCE(MAX(company), 'x') AS company_default,
    SUM(CASE WHEN b > 0 THEN a ELSE 0 END) AS conditional_sum
    FROM APP1`, base);

  expect(scalar.rows[0]).toMatchObject({
    upper_min: "A",
    max_length: "1",
    rounded_sum: "40",
    rounded_avg: "11.7",
    greatest_sum: "35",
    company_default: "B",
    conditional_sum: "30",
  });
});
