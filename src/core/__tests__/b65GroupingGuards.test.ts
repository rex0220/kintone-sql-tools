import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";
import type { FieldRef, SelectStatement } from "../../types/ast";
import {
  B65_MAX_GENERATED_ROWS,
  B65_MAX_GROUPING_ITEMS,
  B65_MAX_GROUPING_SETS,
  resolveGroupingSpec,
} from "../grouping";
import {
  enforceGroupingPlanningCandidateLimits,
  validateGroupingPlanning,
  type GroupingFieldResolver,
} from "../groupingValidation";
import { applyGroupingSets, runFullScan } from "../../engine/process";

function parse(sql: string): SelectStatement {
  return new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement;
}

const resolve: GroupingFieldResolver = (field: FieldRef) => ({
  canonicalId: `APP1:${field.field}`,
  directKey: field.field,
  unqualifiedBridgeKey: field.field,
  physical: true,
});

function validate(sql: string): void {
  validateGroupingPlanning(parse(sql), resolve, enforceGroupingPlanningCandidateLimits);
}

describe("B65 Phase1 Step 4 candidate guards", () => {
  test("B65-G01: 64 sets は成功し、65 sets は実数・上限・reason 付きで失敗する", () => {
    const sets = (count: number) => Array.from({ length: count }, () => "()").join(",");
    expect(() => validate(
      `SELECT COUNT(*) FROM APP1 GROUP BY GROUPING SETS (${sets(B65_MAX_GROUPING_SETS)})`
    )).not.toThrow();
    expect(() => validate(
      `SELECT COUNT(*) FROM APP1 GROUP BY GROUPING SETS (${sets(B65_MAX_GROUPING_SETS + 1)})`
    )).toThrow(
      new RegExp(`${B65_MAX_GROUPING_SETS + 1}.*${B65_MAX_GROUPING_SETS}.*GROUPING_SET_LIMIT_EXCEEDED`)
    );
  });

  test("B65-G01: 16 canonical items は成功し、17 items は専用 reason で失敗する", () => {
    const items = (count: number) =>
      Array.from({ length: count }, (_, index) => `f${index + 1}`).join(",");
    expect(() => validate(
      `SELECT COUNT(*) FROM APP1 GROUP BY GROUPING SETS ((${items(B65_MAX_GROUPING_ITEMS)}))`
    )).not.toThrow();
    expect(() => validate(
      `SELECT COUNT(*) FROM APP1 GROUP BY GROUPING SETS ((${items(B65_MAX_GROUPING_ITEMS + 1)}))`
    )).toThrow(
      new RegExp(`${B65_MAX_GROUPING_ITEMS + 1}.*${B65_MAX_GROUPING_ITEMS}.*GROUPING_ITEM_LIMIT_EXCEEDED`)
    );
  });

  test("B65-G02: ROLLUP は糖衣展開後・重複 set 込みで数える", () => {
    const repeated = (count: number) => Array.from({ length: count }, () => "a").join(",");
    expect(() => validate(
      `SELECT COUNT(*) FROM APP1 GROUP BY ROLLUP(${repeated(B65_MAX_GROUPING_SETS - 1)})`
    )).not.toThrow();
    expect(() => validate(
      `SELECT COUNT(*) FROM APP1 GROUP BY ROLLUP(${repeated(B65_MAX_GROUPING_SETS)})`
    )).toThrow(/65.*64.*GROUPING_SET_LIMIT_EXCEEDED/);
  });

  test("B65-CU03: CUBE は 64 set まで展開し 128 set は展開前 guard で拒否する", () => {
    const fields = (count: number) =>
      Array.from({ length: count }, (_, index) => `f${index + 1}`).join(",");
    const accepted = parse(`SELECT COUNT(*) FROM APP1 GROUP BY CUBE(${fields(6)})`);
    expect(accepted.grouping?.sets).toHaveLength(B65_MAX_GROUPING_SETS);
    expect(() => parse(`SELECT COUNT(*) FROM APP1 GROUP BY CUBE(${fields(7)})`))
      .toThrow(/128.*64.*GROUPING_SET_LIMIT_EXCEEDED/);
  });

  test("B65-G01/G03: 50,000 rows は成功し、50,001 行目を作る前に専用 reason で失敗する", () => {
    const stmt = parse("SELECT a, COUNT(*) AS n FROM APP1 GROUP BY GROUPING SETS ((a))");
    const spec = resolveGroupingSpec(stmt, resolve)!;
    const rows = Array.from(
      { length: B65_MAX_GENERATED_ROWS },
      (_, index) => ({ a: String(index) })
    );
    expect(applyGroupingSets(
      rows,
      spec,
      stmt.columns,
      undefined,
      { maxGeneratedRows: B65_MAX_GENERATED_ROWS }
    )).toHaveLength(B65_MAX_GENERATED_ROWS);
    expect(() => applyGroupingSets(
      [...rows, { a: String(B65_MAX_GENERATED_ROWS) }],
      spec,
      stmt.columns,
      undefined,
      { maxGeneratedRows: B65_MAX_GENERATED_ROWS }
    )).toThrow(
      new RegExp(
        `${B65_MAX_GENERATED_ROWS + 1}.*${B65_MAX_GENERATED_ROWS}.*GROUPING_OUTPUT_LIMIT_EXCEEDED`
      )
    );
  });

  test("B65-G03/H10: runFullScan は HAVING GROUPING/LIMIT より前に generated-row guard を適用する", () => {
    const stmt = parse(
      "SELECT a, COUNT(*) AS n FROM APP1 GROUP BY GROUPING SETS ((a)) " +
      "HAVING GROUPING(a)=1 AND COUNT(*) < 0 LIMIT 1"
    );
    const spec = resolveGroupingSpec(stmt, resolve)!;
    const records = Array.from(
      { length: B65_MAX_GENERATED_ROWS + 1 },
      (_, index) => ({
        "$id": { value: String(index + 1) },
        a: { value: String(index) },
      })
    );
    expect(() => runFullScan({
      stmt,
      tables: new Map([[null, records]]),
      resolvedGroupingSpec: spec,
    })).toThrow(/50001.*50000.*GROUPING_OUTPUT_LIMIT_EXCEEDED/);
  });
});
