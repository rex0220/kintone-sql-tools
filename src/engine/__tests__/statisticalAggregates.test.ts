import { completeInputReasons, requiresCompleteInput } from "../../core/dmlGuard";
import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";
import type { SelectStatement, Statement } from "../../types/ast";
import { applyGroupBy, type ProcessRow } from "../process";

function parse(sql: string): Statement {
  return new Parser(new Lexer(sql).tokenize()).parse();
}

function parseSelect(sql: string): SelectStatement {
  return parse(sql) as SelectStatement;
}

const STATISTICAL_FUNCTIONS = [
  "STDDEV_POP",
  "STDDEV_SAMP",
  "VAR_POP",
  "VAR_SAMP",
  "MEDIAN",
] as const;

test("B56: 5 統計集約を SELECT 列として構文解析する", () => {
  const stmt = parseSelect(
    "SELECT STDDEV_POP(x), STDDEV_SAMP(x), VAR_POP(x), VAR_SAMP(x), MEDIAN(x) FROM APP100"
  );
  expect(stmt.columns.map((column) => column.type === "AGGREGATE" ? column.func : null))
    .toEqual(STATISTICAL_FUNCTIONS);
});

test.each(STATISTICAL_FUNCTIONS)("B56: %s(*) は SELECT と HAVING の両方で拒否する", (func) => {
  expect(() => parseSelect(`SELECT ${func}(*) FROM APP100`)).toThrow(/\(\*\) は使用できません/);
  expect(() => parseSelect(
    `SELECT kind, ${func}(x) FROM APP100 GROUP BY kind HAVING ${func}(*) > 0`
  )).toThrow(/\(\*\) は使用できません/);
});

test.each(STATISTICAL_FUNCTIONS)("B56: %s は予約語でバッククォート参照は可能", (func) => {
  expect(() => parseSelect(`SELECT ${func} FROM APP100`)).toThrow();
  expect(parseSelect(`SELECT \`${func}\` FROM APP100`).columns[0]).toMatchObject({
    type: "FIELD",
    field: func,
  });
});

test("B56: ウィンドウ形と無印 STDDEV / VARIANCE は ParseError", () => {
  expect(() => parseSelect("SELECT STDDEV_POP(x) OVER (ORDER BY x) FROM APP100")).toThrow();
  expect(() => parseSelect("SELECT STDDEV(x) FROM APP100")).toThrow();
  expect(() => parseSelect("SELECT VARIANCE(x) FROM APP100")).toThrow();
});

test("B56: 5 統計量、式引数、偶数・奇数 MEDIAN を計算する", () => {
  const rows: ProcessRow[] = [1, 2, 3, 4].map((value) => ({ x: String(value) }));
  const stmt = parseSelect(
    "SELECT VAR_POP(x) AS vp, VAR_SAMP(x) AS vs, " +
      "STDDEV_POP(x) AS sp, STDDEV_SAMP(x) AS ss, " +
      "MEDIAN(x) AS even_med, MEDIAN(x * 2) AS expr_med FROM APP100"
  );
  const result = applyGroupBy(rows, stmt.groupBy, stmt.columns)[0];
  expect(Number(result.vp)).toBeCloseTo(1.25, 14);
  expect(Number(result.vs)).toBeCloseTo(5 / 3, 14);
  expect(Number(result.sp)).toBeCloseTo(Math.sqrt(1.25), 14);
  expect(Number(result.ss)).toBeCloseTo(Math.sqrt(5 / 3), 14);
  expect(result.even_med).toBe("2.5");
  expect(result.expr_med).toBe("5");

  const odd = applyGroupBy(
    rows.slice(0, 3),
    parseSelect("SELECT MEDIAN(x) AS med FROM APP100").groupBy,
    parseSelect("SELECT MEDIAN(x) AS med FROM APP100").columns
  );
  expect(odd[0].med).toBe("2");
});

test("B56: Welford により大オフセット・微小分散を安定計算する", () => {
  const values = [
    1_000_000_000.001,
    1_000_000_000.002,
    1_000_000_000.003,
    1_000_000_000.004,
  ];
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const expected = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const stmt = parseSelect("SELECT VAR_POP(x) AS variance FROM APP100");
  const result = applyGroupBy(
    values.map((value) => ({ x: String(value) })),
    stmt.groupBy,
    stmt.columns
  );
  const actual = Number(result[0].variance);
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1e-12 + 1e-9 * Math.abs(expected));
});

test("B56: DISTINCT は Number 化後の数値同値単位", () => {
  const rows: ProcessRow[] = [{ x: "1" }, { x: "01" }, { x: "10" }];
  const stmt = parseSelect("SELECT MEDIAN(DISTINCT x) AS med FROM APP100");
  const result = applyGroupBy(rows, stmt.groupBy, stmt.columns);
  expect(result[0].med).toBe("5.5");
});

test("B56: 未定義統計量は空文字、singleton の母集団統計と中央値は定義値", () => {
  const emptyStmt = parseSelect(
    "SELECT VAR_POP(x) AS vp, VAR_SAMP(x) AS vs, STDDEV_POP(x) AS sp, " +
      "STDDEV_SAMP(x) AS ss, MEDIAN(x) AS med FROM APP100"
  );
  expect(applyGroupBy([], emptyStmt.groupBy, emptyStmt.columns)[0]).toMatchObject({
    vp: "", vs: "", sp: "", ss: "", med: "",
  });

  const singleton = applyGroupBy([{ x: "7" }], emptyStmt.groupBy, emptyStmt.columns)[0];
  expect(singleton).toMatchObject({ vp: "0", vs: "", sp: "0", ss: "", med: "7" });
});

test.each(["not-a-number", "Infinity", "-Infinity"])(
  "B56: 非数値・非有限値 %s は関数名と値を含む ArgumentError",
  (value) => {
    const stmt = parseSelect("SELECT VAR_POP(x) AS variance FROM APP100");
    expect(() => applyGroupBy([{ x: value }], stmt.groupBy, stmt.columns))
      .toThrow(new RegExp(`ArgumentError:.*VAR_POP.*${value}`));
  }
);

test("B56: 統計集約は入れ子の式・CTE・UNION・スカラーサブクエリでも完全入力必須", () => {
  const statements = [
    parse("SELECT STDDEV_POP(x) FROM APP100"),
    parse("SELECT STDDEV_POP(x) + 1 AS adjusted FROM APP100"),
    parse("SELECT FORMAT(STDDEV_POP(x), '#,##0.00') AS formatted FROM APP100"),
    parse("SELECT (SELECT MEDIAN(x) FROM APP200) AS med FROM APP100"),
    parse("WITH stats AS (SELECT VAR_POP(x) AS v FROM APP100) SELECT v FROM stats"),
    parse("SELECT x FROM APP100 UNION ALL SELECT VAR_SAMP(x) FROM APP200"),
  ];
  for (const stmt of statements) expect(requiresCompleteInput(stmt)).toBe(true);
});

test("B56: HAVING の直接統計集約も完全入力理由として検出する", () => {
  const stmt = parse("SELECT kind, MEDIAN(x) AS med FROM APP100 GROUP BY kind HAVING MEDIAN(x) > 0");
  expect([...completeInputReasons(stmt)]).toContain("STATISTICAL_AGGREGATE");
});

test("B56: 同一値の統計量と空文字だけの入力を処理する", () => {
  const stmt = parseSelect(
    "SELECT VAR_POP(x) AS vp, VAR_SAMP(x) AS vs, STDDEV_POP(x) AS sp, " +
      "STDDEV_SAMP(x) AS ss, MEDIAN(x) AS med FROM APP100"
  );
  expect(applyGroupBy(Array.from({ length: 100 }, () => ({ x: "5" })), stmt.groupBy, stmt.columns)[0])
    .toMatchObject({ vp: "0", vs: "0", sp: "0", ss: "0", med: "5" });
  expect(applyGroupBy([{ x: "" }, { x: "" }], stmt.groupBy, stmt.columns)[0])
    .toMatchObject({ vp: "", vs: "", sp: "", ss: "", med: "" });
});

test("B56: 既存集約の DISTINCT と空集合規約は不変", () => {
  const rows: ProcessRow[] = [{ x: "1" }, { x: "01" }, { x: "10" }];
  const stmt = parseSelect("SELECT COUNT(DISTINCT x) AS count, AVG(DISTINCT x) AS avg FROM APP100");
  expect(applyGroupBy(rows, stmt.groupBy, stmt.columns)[0]).toMatchObject({ count: "3", avg: "4" });

  const empty = parseSelect("SELECT COUNT(x) AS count, SUM(x) AS sum, AVG(x) AS avg FROM APP100");
  expect(applyGroupBy([], empty.groupBy, empty.columns)[0]).toMatchObject({
    count: "0", sum: "0", avg: "0",
  });
});
