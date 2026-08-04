import type { KintoneRecord } from "../../converter/dmlToKintone";
import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";
import type { SelectStatement } from "../../types/ast";
import { runFullScan } from "../process";

function parseSelect(sql: string): SelectStatement {
  return new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement;
}

function records(rows: Array<Record<string, string>>): KintoneRecord[] {
  return rows.map((row) => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, { value }])
  ));
}

function run(sql: string, rows: Array<Record<string, string>>) {
  return runFullScan({
    stmt: parseSelect(sql),
    tables: new Map([[null, records(rows)]]),
  });
}

const base = [
  { company: "alpha", phase: "提案中", amount: "10" },
  { company: "beta", phase: "", amount: "20" },
  { company: "alpha", phase: "受注", amount: "30" },
];

test("B119-E01: 文字列関数の値を COUNT/MAX/GROUP_CONCAT が文字列のまま集計する", () => {
  const result = run(`SELECT
    COUNT(DISTINCT UPPER(company)) AS distinct_upper,
    COUNT(UPPER(company)) AS count_upper,
    MAX(UPPER(company)) AS max_upper,
    GROUP_CONCAT(DISTINCT UPPER(company) SEPARATOR '/') AS names
    FROM APP1`, base);

  expect(result.rows[0]).toMatchObject({
    distinct_upper: "2",
    count_upper: "3",
    max_upper: "BETA",
    names: "ALPHA/BETA",
  });
});

test("B119-E02: COALESCE は空セルの代替値を DISTINCT の種類数へ含める", () => {
  expect(run(
    "SELECT COUNT(DISTINCT COALESCE(phase, '未選択')) AS phases FROM APP1",
    base
  ).rows[0].phases).toBe("3");
});

test("B119-R01: 数値関数・算術式・CASE の既存集計値を維持する", () => {
  const result = run(`SELECT
    SUM(ROUND(amount)) AS rounded,
    SUM(LENGTH(company)) AS lengths,
    COUNT(DISTINCT amount * 1) AS distinct_amounts,
    COUNT(DISTINCT CASE WHEN amount > 0 THEN company END) AS distinct_companies
    FROM APP1`, base);

  expect(result.rows[0]).toMatchObject({
    rounded: "60",
    lengths: "14",
    distinct_amounts: "3",
    distinct_companies: "2",
  });
});

test("B119-R02: 統計集計は文字列関数が返す非数値を引き続き拒否する", () => {
  expect(() => run(
    "SELECT STDDEV_SAMP(UPPER(company)) AS deviation FROM APP1",
    base
  )).toThrow("ArgumentError: STDDEV_SAMP の引数に非数値または非有限の値があります: ALPHA");
});

test("B119-M01: MIN/MAX/MODE は文字列関数の戻り値を文字列比較する", () => {
  const result = run(`SELECT
    MIN(UPPER(company)) AS min_company,
    MAX(UPPER(company)) AS max_company,
    MODE(UPPER(company)) AS mode_company
    FROM APP1`, base);

  expect(result.rows[0]).toMatchObject({
    min_company: "ALPHA",
    max_company: "BETA",
    mode_company: "ALPHA",
  });
});
