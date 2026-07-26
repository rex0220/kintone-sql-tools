import { Lexer } from "../../../lexer/lexer";
import { Parser } from "../../../parser/parser";
import type {
  GroupByKey,
  SelectColumn,
  SelectStatement,
  TableRef,
} from "../../../types/ast";
import {
  classifyPreGroupAlias,
  planPlainGroupByResolution,
  resolvePlainGroupBySourceSchemas,
  type PlainGroupByResolution,
  type PlainGroupBySourceSchema,
  type PlainGroupBySourceSchemaInput,
} from "../plainGroupByPlan";

function statement(sql: string): SelectStatement {
  return new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement;
}

function schemas(
  stmt: Pick<SelectStatement, "from" | "joins">,
  inputs: readonly PlainGroupBySourceSchemaInput[]
): readonly PlainGroupBySourceSchema[] {
  return resolvePlainGroupBySourceSchemas(stmt, (_source, index) => {
    const input = inputs[index];
    if (!input) throw new Error(`test schema missing for source ${index}`);
    return input;
  });
}

const app = (...fieldCodes: string[]): PlainGroupBySourceSchemaInput => ({
  kind: "APP",
  fieldCodes,
});

function onlyResolution(
  sql: string,
  inputs: readonly PlainGroupBySourceSchemaInput[]
): PlainGroupByResolution {
  const stmt = statement(sql);
  return planPlainGroupByResolution(
    stmt.groupBy,
    stmt.columns,
    schemas(stmt, inputs)
  ).items[0];
}

describe("B71 plain GROUP BY source schema resolution", () => {
  test.each([
    ["S1", "SELECT 金額 AS 区分, 区分 FROM APP100 GROUP BY 区分"],
    ["S2", "SELECT 区分 AS 区分 FROM APP100 GROUP BY 区分"],
    ["S3", "SELECT 金額 AS 区分 FROM APP100 GROUP BY 区分"],
    ["S4", "SELECT DATE_FORMAT(作成日時, '%Y-%m') AS 区分, 区分 AS orig FROM APP100 GROUP BY 区分"],
  ])("%s は SELECT/fetch 列に依存せず source schema の PHYSICAL になる", (_caseName, sql) => {
    expect(onlyResolution(sql, [app("金額", "区分", "作成日時")])).toEqual({
      kind: "PHYSICAL",
      sourceIndex: 0,
      fieldCode: "区分",
      runtimeKey: "APP100.区分",
    });
  });

  test.each(["$id", "$revision"])("既知 system column %s は APP schema の PHYSICAL になる", (field) => {
    const stmt = statement(`SELECT ${field} FROM APP100 GROUP BY ${field}`);
    expect(planPlainGroupByResolution(stmt.groupBy, stmt.columns, schemas(stmt, [app()])).items[0])
      .toEqual({ kind: "PHYSICAL", sourceIndex: 0, fieldCode: field, runtimeKey: `APP100.${field}` });
  });

  test("alias 付き source は flatten と同じ修飾 runtimeKey を保持する", () => {
    const stmt = statement("SELECT a.区分 FROM APP100 a GROUP BY a.区分");
    expect(planPlainGroupByResolution(stmt.groupBy, stmt.columns, schemas(stmt, [app("区分")])).items[0])
      .toEqual({ kind: "PHYSICAL", sourceIndex: 0, fieldCode: "区分", runtimeKey: "a.区分" });
  });

  test.each([
    ["_pid", "_pid"],
    ["_rid", "_rid"],
    ["_idx", "_idx"],
    ["_p.親項目", "_p.親項目"],
  ])("subtable virtual column %s を正しい runtimeKey の PHYSICAL にする", (name, runtimeKey) => {
    const table: TableRef = {
      appId: 100,
      alias: "s",
      cteName: null,
      subtableCode: "明細",
    };
    const sourceSchemas = resolvePlainGroupBySourceSchemas(
      { from: table, joins: [] },
      () => ({
        kind: "SUBTABLE",
        childFieldCodes: ["数量"],
        parentFieldCodes: ["親項目"],
      })
    );
    const groupBy: GroupByKey[] = [{ type: "FIELD_NAME", name }];
    expect(planPlainGroupByResolution(groupBy, [], sourceSchemas).items[0]).toEqual({
      kind: "PHYSICAL",
      sourceIndex: 0,
      fieldCode: name,
      runtimeKey: `s.${runtimeKey}`,
    });
  });

  test("_p.<field> は parent schema に存在するときだけ PHYSICAL になる", () => {
    const table: TableRef = {
      appId: 100,
      alias: null,
      cteName: null,
      subtableCode: "明細",
    };
    const sourceSchemas = resolvePlainGroupBySourceSchemas(
      { from: table, joins: [] },
      () => ({ kind: "SUBTABLE", childFieldCodes: [], parentFieldCodes: ["存在"] })
    );
    const plan = planPlainGroupByResolution(
      [
        { type: "FIELD_NAME", name: "_p.存在" },
        { type: "FIELD_NAME", name: "_p.不存在" },
      ],
      [],
      sourceSchemas
    );
    expect(plan.items).toEqual([
      { kind: "PHYSICAL", sourceIndex: 0, fieldCode: "_p.存在", runtimeKey: "_p.存在" },
      { kind: "UNKNOWN", name: "_p.不存在" },
    ]);
  });

  test("0 rows の CTE/temp でも MaterializedTable.columns 相当から PHYSICAL にする", () => {
    const table: TableRef = { appId: 0, alias: null, cteName: "#empty" };
    const sourceSchemas = resolvePlainGroupBySourceSchemas(
      { from: table, joins: [] },
      () => ({ kind: "MATERIALIZED", columns: ["kept_column"] })
    );
    expect(planPlainGroupByResolution(
      [{ type: "FIELD_NAME", name: "kept_column" }],
      [],
      sourceSchemas
    ).items[0]).toEqual({
      kind: "PHYSICAL",
      sourceIndex: 0,
      fieldCode: "kept_column",
      runtimeKey: "#empty.kept_column",
    });
  });

  test("非修飾名が 2 sources に一致したら alias fallback せず ambiguity にする", () => {
    const stmt = statement(
      "SELECT a.other AS shared FROM APP100 a JOIN APP200 b ON a.id = b.id GROUP BY shared"
    );
    expect(() => planPlainGroupByResolution(
      stmt.groupBy,
      stmt.columns,
      schemas(stmt, [app("id", "shared"), app("id", "shared")])
    )).toThrow(/GROUP_BY_FIELD_AMBIGUOUS/);
  });

  test("存在しない修飾 source/field は alias fallback せず UNKNOWN にする", () => {
    const stmt = statement("SELECT a.value AS missing FROM APP100 a GROUP BY b.missing");
    expect(planPlainGroupByResolution(
      stmt.groupBy,
      stmt.columns,
      schemas(stmt, [app("value")])
    ).items[0]).toEqual({ kind: "UNKNOWN", name: "b.missing" });
  });
});

describe("B71 pre-group-safe alias classifier and plan", () => {
  test.each([
    ["A1 DATE_FORMAT", "SELECT DATE_FORMAT(作成日時, '%Y-%m') AS 年月 FROM APP100 GROUP BY 年月"],
    ["A2 field", "SELECT 区分 AS g FROM APP100 GROUP BY g"],
    ["A3 arithmetic", "SELECT 金額 * 2 AS m FROM APP100 GROUP BY m"],
    ["literal", "SELECT 'fixed' AS g FROM APP100 GROUP BY g"],
    ["CASE", "SELECT CASE WHEN 区分 = 'A' THEN 'Y' ELSE 'N' END AS g FROM APP100 GROUP BY g"],
    ["string function", "SELECT UPPER(区分) AS g FROM APP100 GROUP BY g"],
    ["scalar concat", "SELECT 区分 || '-x' AS g FROM APP100 GROUP BY g"],
    ["scalar subquery", "SELECT (SELECT 'x' FROM APP200) AS g FROM APP100 GROUP BY g"],
  ])("%s alias は ALIAS_SAFE", (_name, sql) => {
    expect(onlyResolution(sql, [app("作成日時", "区分", "金額")])).toEqual({
      kind: "ALIAS_SAFE",
      columnIndex: 0,
    });
  });

  test.each([
    "COUNT",
    "SUM",
    "AVG",
    "MAX",
    "MIN",
    "GROUP_CONCAT",
    "STDDEV_POP",
    "STDDEV_SAMP",
    "VAR_POP",
    "VAR_SAMP",
    "MEDIAN",
    "MODE",
  ])("%s alias は aggregate-dependent", (func) => {
    const arg = func === "COUNT" ? "*" : "金額";
    expect(onlyResolution(
      `SELECT ${func}(${arg}) AS g FROM APP100 GROUP BY g`,
      [app("金額")]
    )).toEqual({ kind: "ALIAS_REJECT", reason: "AGGREGATE" });
  });

  test.each([
    ["ARITH_AGG_COL", "SELECT SUM(金額) + 1 AS g FROM APP100 GROUP BY g"],
    ["aggregate ARITH_COL", "SELECT FORMAT(SUM(金額), '0') + 1 AS g FROM APP100 GROUP BY g"],
    ["aggregate CASE_COL", "SELECT CASE WHEN SUM(金額) > 0 THEN 'Y' ELSE 'N' END AS g FROM APP100 GROUP BY g"],
    ["aggregate STRFUNC_COL", "SELECT FORMAT(SUM(金額), '0') AS g FROM APP100 GROUP BY g"],
    ["aggregate SCALAR_VALUE_COL", "SELECT FORMAT(SUM(金額), '0') || '円' AS g FROM APP100 GROUP BY g"],
  ])("%s は ALIAS_REJECT AGGREGATE", (_name, sql) => {
    expect(onlyResolution(sql, [app("金額")])).toEqual({
      kind: "ALIAS_REJECT",
      reason: "AGGREGATE",
    });
  });

  test("alias なし aggregate の合成出力名は projection 共通 helper で拒否する", () => {
    expect(onlyResolution(
      "SELECT SUM(金額) FROM APP100 GROUP BY `SUM(金額)`",
      [app("金額")]
    )).toEqual({ kind: "ALIAS_REJECT", reason: "AGGREGATE" });
  });

  test("GROUPING_COL は POST_GROUP_ONLY", () => {
    const groupingColumn: SelectColumn = {
      type: "GROUPING_COL",
      ref: {
        type: "GROUPING_REF",
        field: { type: "FIELD", tableAlias: null, field: "区分" },
      },
      alias: "g",
    };
    expect(classifyPreGroupAlias(groupingColumn)).toBe("POST_GROUP_ONLY");
    expect(planPlainGroupByResolution(
      [{ type: "FIELD_NAME", name: "g" }],
      [groupingColumn],
      []
    ).items[0]).toEqual({ kind: "ALIAS_REJECT", reason: "POST_GROUP_ONLY" });
  });

  test("WINDOW_COL は POST_GROUP_ONLY", () => {
    const windowColumn: SelectColumn = {
      type: "WINDOW_COL",
      func: "ROW_NUMBER",
      partitionBy: [],
      orderBy: [],
      alias: "rn",
    };
    expect(classifyPreGroupAlias(windowColumn)).toBe("POST_GROUP_ONLY");
  });

  test("nested scalar subquery 内部の aggregate は外側 alias dependency にしない", () => {
    const stmt = statement("SELECT (SELECT SUM(金額) FROM APP200) AS g FROM APP100 GROUP BY g");
    expect(classifyPreGroupAlias(stmt.columns[0])).toBe("SAFE");
  });

  test("重複 alias は物理一致 0 の alias 解決時だけ DUPLICATE", () => {
    const noPhysical = statement("SELECT a AS g, b AS g FROM APP100 GROUP BY g");
    expect(planPlainGroupByResolution(
      noPhysical.groupBy,
      noPhysical.columns,
      schemas(noPhysical, [app("a", "b")])
    ).items[0]).toEqual({ kind: "ALIAS_REJECT", reason: "DUPLICATE" });

    const physical = statement("SELECT a AS g, SUM(b) AS g FROM APP100 GROUP BY g");
    expect(planPlainGroupByResolution(
      physical.groupBy,
      physical.columns,
      schemas(physical, [app("a", "b", "g")])
    ).items[0]).toEqual({
      kind: "PHYSICAL",
      sourceIndex: 0,
      fieldCode: "g",
      runtimeKey: "APP100.g",
    });
  });

  test("ARITH_KEY/FUNC_KEY は EXPRESSION で item index 順を保持する", () => {
    const stmt = statement(
      "SELECT 金額 FROM APP100 GROUP BY 金額 * 2, UPPER(区分)"
    );
    expect(planPlainGroupByResolution(
      stmt.groupBy,
      stmt.columns,
      schemas(stmt, [app("金額", "区分")])
    ).items).toEqual([
      { kind: "EXPRESSION" },
      { kind: "EXPRESSION" },
    ]);
  });
});
