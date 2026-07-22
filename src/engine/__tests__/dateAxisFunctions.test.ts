import { Lexer } from "../../lexer/lexer";
import { Parser, ParseError } from "../../parser/parser";
import type { KintoneRecord } from "../../converter/dmlToKintone";
import type { SelectStatement } from "../../types/ast";
import { runFullScan } from "../process";
import { resolveSelectMode } from "../../converter/selectToKintone";
import { buildSingleTableKlikePushdownPlan } from "../../core/optimization/klikePushdownPlan";

function makeRecord(fields: Record<string, string>): KintoneRecord {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, { value }])
  );
}

function parseSelect(sql: string): SelectStatement {
  return new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement;
}

function run(sql: string, fields: Record<string, string>): Record<string, string> {
  const stmt = parseSelect(sql);
  const result = runFullScan({
    stmt,
    tables: new Map([[null, [makeRecord(fields)]]]),
  });
  return result.rows[0] ?? {};
}

describe("B57 date-axis scalar functions", () => {
  test.each([
    ["2025-12-29", "1", "01", "2026"],
    ["2026-01-01", "1", "01", "2026"],
    ["2026-12-31", "53", "53", "2026"],
    ["2027-01-01", "53", "53", "2026"],
    ["2020-12-31", "53", "53", "2020"],
    ["2021-01-01", "53", "53", "2020"],
  ])("ISO week boundary %s", (date, week, paddedWeek, weekYear) => {
    expect(run(
      "SELECT WEEK(d) AS w, DATE_FORMAT(d, '%v') AS v, DATE_FORMAT(d, '%G') AS g, DATE_FORMAT(d, '%G-%v') AS label FROM APP1",
      { d: date }
    )).toMatchObject({ w: week, v: paddedWeek, g: weekYear, label: `${weekYear}-${paddedWeek}` });
  });

  test("DAYOFWEEK = %w + 1 and %a is the kSQL Japanese weekday", () => {
    const dates = [
      ["2026-01-04", "1", "0", "日"],
      ["2026-01-05", "2", "1", "月"],
      ["2026-01-06", "3", "2", "火"],
      ["2026-01-07", "4", "3", "水"],
      ["2026-01-08", "5", "4", "木"],
      ["2026-01-09", "6", "5", "金"],
      ["2026-01-10", "7", "6", "土"],
    ];
    for (const [date, dayOfWeek, w, a] of dates) {
      const actual = run(
        "SELECT DAYOFWEEK(d) AS dow, DATE_FORMAT(d, '%w') AS w, DATE_FORMAT(d, '%a') AS a FROM APP1",
        { d: date }
      );
      expect(actual).toMatchObject({ dow: dayOfWeek, w, a });
      expect(Number(actual.dow)).toBe(Number(actual.w) + 1);
    }
  });

  test("QUARTER covers all twelve months and accepts leap-day", () => {
    for (let month = 1; month <= 12; month += 1) {
      const date = `2024-${String(month).padStart(2, "0")}-01`;
      expect(run("SELECT QUARTER(d) AS q FROM APP1", { d: date }).q)
        .toBe(String(Math.ceil(month / 3)));
    }
    expect(run(
      "SELECT DAYOFWEEK(d) AS dow, QUARTER(d) AS q, WEEK(d) AS w, DATE_FORMAT(d, '%w|%a|%G-%v') AS fmt FROM APP1",
      { d: "2024-02-29" }
    )).toMatchObject({ dow: "5", q: "1", w: "9", fmt: "4|木|2024-09" });
  });

  test.each([
    "", "12:34:56", "2026-02-31", "2025-02-29", "2026-00-01", "2026-13-01",
    "2026/02/01", "202A-02-01",
  ])("invalid YMD %j returns empty for new functions/specifiers", (date) => {
    expect(run(
      "SELECT DAYOFWEEK(d) AS dow, QUARTER(d) AS q, WEEK(d) AS w, DATE_FORMAT(d, '%w|%a|%G|%v') AS fmt FROM APP1",
      { d: date }
    )).toMatchObject({ dow: "", q: "", w: "", fmt: date.length < 10 ? "" : "|||" });
  });

  test("invalid date replaces only new DATE_FORMAT specifiers", () => {
    expect(run(
      "SELECT DATE_FORMAT(d, '%Y|%w|%G-%v') AS fmt FROM APP1",
      { d: "2026-02-31" }
    ).fmt).toBe("2026||-");
  });

  test.each(["DAYOFWEEK", "QUARTER", "WEEK"])("%s requires exactly one argument", (func) => {
    expect(() => run(`SELECT ${func}() AS v FROM APP1`, {})).toThrow(`ArgumentError: ${func} expects 1 argument(s).`);
    expect(run(`SELECT ${func}(d) AS v FROM APP1`, { d: "2026-01-01" }).v).not.toBe("");
    expect(() => run(`SELECT ${func}(d, d) AS v FROM APP1`, { d: "2026-01-01" }))
      .toThrow(`ArgumentError: ${func} expects 1 argument(s).`);
  });

  test("unsupported and literal percent sequences pass through", () => {
    expect(run(
      "SELECT DATE_FORMAT(d, '%Q') AS q, DATE_FORMAT(d, '%') AS pct, DATE_FORMAT(d, '%%Y') AS yy FROM APP1",
      { d: "2026-01-01" }
    )).toMatchObject({ q: "%Q", pct: "%", yy: "%2026" });
  });

  test("existing nine DATE_FORMAT specifiers and legacy date functions remain byte-compatible", () => {
    expect(run(
      "SELECT DATE_FORMAT(dt, '%Y|%y|%m|%c|%d|%e|%H|%i|%s') AS fmt, YEAR(bad) AS y, MONTH(bad) AS m, DAY(bad) AS d, DATEDIFF(bad, '2026-03-01') AS diff FROM APP1",
      { dt: "2024-03-05T09:07:00Z", bad: "2026-02-31" }
    )).toMatchObject({ fmt: "2024|24|03|3|05|5|09|07|00", y: "2026", m: "2", d: "31", diff: "2" });
  });

  test("reserved words require backticks while WEEKLY is unaffected", () => {
    for (const name of ["DAYOFWEEK", "QUARTER", "WEEK"]) {
      expect(() => parseSelect(`SELECT ${name} FROM APP1`)).toThrow(ParseError);
      expect(parseSelect(`SELECT \`${name}\` FROM APP1`).columns[0]).toMatchObject({ field: name });
    }
    expect(parseSelect("SELECT WEEKLY FROM APP1").columns[0]).toMatchObject({ field: "WEEKLY" });
  });

  test("GROUP BY function key equals SELECT output and HAVING uses numeric semantics", () => {
    const stmt = parseSelect(
      "SELECT WEEK(d) AS week_no, COUNT(*) AS cnt FROM APP1 GROUP BY WEEK(d) HAVING WEEK(d) >= 10 ORDER BY WEEK(d)"
    );
    const records = [
      makeRecord({ d: "2026-01-05" }), // W02: excluded numerically
      makeRecord({ d: "2026-03-02" }), // W10
      makeRecord({ d: "2026-03-03" }), // W10
      makeRecord({ d: "2026-03-09" }), // W11
    ];
    const result = runFullScan({ stmt, tables: new Map([[null, records]]) });
    expect(result.rows).toEqual([
      { week_no: "10", cnt: "2" },
      { week_no: "11", cnt: "1" },
    ]);
  });

  test("WHERE and ORDER BY compare WEEK numerically", () => {
    const stmt = parseSelect(
      "SELECT d, WEEK(d) AS week_no FROM APP1 WHERE WEEK(d) >= 10 ORDER BY WEEK(d) DESC"
    );
    const records = [
      makeRecord({ d: "2026-01-05" }),
      makeRecord({ d: "2026-03-02" }),
      makeRecord({ d: "2026-03-09" }),
    ];
    expect(runFullScan({ stmt, tables: new Map([[null, records]]) }).rows).toEqual([
      { d: "2026-03-09", week_no: "11" },
      { d: "2026-03-02", week_no: "10" },
    ]);
  });

  test("plain projection stays SIMPLE and an AND sibling remains a safe prefilter", () => {
    const simple = parseSelect("SELECT DAYOFWEEK(d) AS dow, QUARTER(d) AS q, WEEK(d) AS w FROM APP1");
    expect(resolveSelectMode(simple)).toBe("SIMPLE");
    expect(runFullScan({
      stmt: simple,
      tables: new Map([[null, [makeRecord({ d: "2026-01-01" })]]]),
    }).rows).toEqual([{ dow: "5", q: "1", w: "1" }]);

    const residual = parseSelect(
      "SELECT d FROM APP1 WHERE $id >= 1000 AND DAYOFWEEK(d) >= 2"
    );
    expect(resolveSelectMode(residual)).toBe("FULL_SCAN");
    const plan = buildSingleTableKlikePushdownPlan(residual.where, {
      allowUnqualifiedFields: true,
    });
    expect(plan.condition).toMatchObject({
      type: "BINARY",
      op: ">=",
      left: { type: "FIELD", field: "$id" },
      right: { type: "NUMBER", value: 1000 },
    });
  });
});
