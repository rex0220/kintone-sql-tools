import { execute, type KintoneClient, type SelectResult } from "../../execute";
import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";
import type {
  BinaryExpr,
  DeleteStatement,
  RelativeDateFunction,
  SelectStatement,
  UpdateStatement,
  WhereExpr,
} from "../../types/ast";
import { deleteToGetQuery, updateToGetQuery } from "../dmlToKintone";
import { selectToKintoneParams } from "../selectToKintone";
import { whereToKintone } from "../whereToKintone";

function parse(sql: string) {
  return new Parser(new Lexer(sql).tokenize()).parse();
}

function relativeComparison(
  field: string,
  op: BinaryExpr["op"],
  value: RelativeDateFunction
): BinaryExpr {
  return {
    type: "BINARY",
    op,
    left: { type: "FIELD", field, tableAlias: null },
    right: value,
  };
}

function legacyExplainClient(): KintoneClient {
  return {
    async getRecords() { return { records: [] }; },
    async openCursor() { throw new Error("unexpected cursor call"); },
    async postRecords() { return { ids: [] }; },
    async putRecords() {},
    async deleteRecords() {},
    async getApps() { return []; },
    async getFields() {
      return [
        { code: "作成日", label: "作成日", fieldType: "DATE" },
        { code: "受注予定日", label: "受注予定日", fieldType: "DATE" },
        { code: "更新日時", label: "更新日時", fieldType: "DATETIME" },
        { code: "作成者", label: "作成者", fieldType: "CREATOR" },
      ];
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const };
    },
  };
}

describe("B67 Step 3 legacy byte baseline", () => {
  const legacyWhere =
    "作成日 >= TODAY() AND 更新日時 < NOW() AND 作成者 = LOGINUSER()";
  const legacyQuery =
    "(作成日 >= TODAY() and 更新日時 < NOW()) and 作成者 = LOGINUSER()";

  test.each([
    ["TODAY", "TODAY()"],
    ["NOW", "NOW()"],
    ["LOGINUSER", "LOGINUSER()"],
  ] as const)("既存 %s serializer は byte 不変", (name, expected) => {
    const expr: WhereExpr = {
      type: "BINARY",
      op: "=",
      left: { type: "FIELD", field: "日付", tableAlias: null },
      right: { type: "KINTONE_FUNC", name },
    };
    expect(whereToKintone(expr)).toBe(`日付 = ${expected}`);
  });

  test("SELECT query は空白・括弧・論理式を含め byte baseline と一致する", () => {
    const stmt = parse(`SELECT 作成日 FROM APP100 WHERE ${legacyWhere}`) as SelectStatement;
    expect(selectToKintoneParams(stmt).query).toBe(legacyQuery);
  });

  test("UPDATE query は legacy byte baseline と一致する", () => {
    const stmt = parse(
      "UPDATE APP100 SET 作成日 = '2026-01-01' WHERE 作成日 < TODAY()"
    ) as UpdateStatement;
    expect(updateToGetQuery(stmt).query).toBe("作成日 < TODAY()");
  });

  test("DELETE query は legacy byte baseline と一致する", () => {
    const stmt = parse(
      "DELETE FROM APP100 WHERE 更新日時 >= NOW() AND 作成者 = LOGINUSER()"
    ) as DeleteStatement;
    expect(deleteToGetQuery(stmt).query)
      .toBe("更新日時 >= NOW() and 作成者 = LOGINUSER()");
  });

  test("EXPLAIN query は legacy byte baseline と一致する", async () => {
    const result = await execute(
      "EXPLAIN DELETE FROM APP100 WHERE 受注予定日 < TODAY()",
      legacyExplainClient(),
      { cacheContext: "b67-step3-legacy-byte-baseline" }
    ) as SelectResult;
    const queryLine = result.rows
      .map((row) => String(row.plan))
      .find((line) => line.includes("kintone query:"));
    expect(queryLine).toBe("  kintone query: 受注予定日 < TODAY()");
  });
});

describe("B67 Step 3 relative date serializer", () => {
  const calls: ReadonlyArray<readonly [RelativeDateFunction, string]> = [
    [
      { type: "KINTONE_FUNC", name: "YESTERDAY", args: { kind: "NONE" } },
      "YESTERDAY()",
    ],
    [
      { type: "KINTONE_FUNC", name: "TOMORROW", args: { kind: "NONE" } },
      "TOMORROW()",
    ],
    [
      {
        type: "KINTONE_FUNC",
        name: "FROM_TODAY",
        args: { kind: "FROM_TODAY", offset: -5, offsetText: "-5", unit: "DAYS" },
      },
      "FROM_TODAY(-5, DAYS)",
    ],
    [
      { type: "KINTONE_FUNC", name: "THIS_WEEK", args: { kind: "WEEK", weekday: null } },
      "THIS_WEEK()",
    ],
    [
      { type: "KINTONE_FUNC", name: "LAST_WEEK", args: { kind: "WEEK", weekday: "MONDAY" } },
      "LAST_WEEK(MONDAY)",
    ],
    [
      { type: "KINTONE_FUNC", name: "NEXT_WEEK", args: { kind: "WEEK", weekday: "SATURDAY" } },
      "NEXT_WEEK(SATURDAY)",
    ],
    [
      { type: "KINTONE_FUNC", name: "THIS_MONTH", args: { kind: "MONTH", day: null } },
      "THIS_MONTH()",
    ],
    [
      { type: "KINTONE_FUNC", name: "LAST_MONTH", args: { kind: "MONTH", day: "LAST" } },
      "LAST_MONTH(LAST)",
    ],
    [
      { type: "KINTONE_FUNC", name: "NEXT_MONTH", args: { kind: "MONTH", day: 31 } },
      "NEXT_MONTH(31)",
    ],
    [
      { type: "KINTONE_FUNC", name: "THIS_YEAR", args: { kind: "NONE" } },
      "THIS_YEAR()",
    ],
    [
      { type: "KINTONE_FUNC", name: "LAST_YEAR", args: { kind: "NONE" } },
      "LAST_YEAR()",
    ],
    [
      { type: "KINTONE_FUNC", name: "NEXT_YEAR", args: { kind: "NONE" } },
      "NEXT_YEAR()",
    ],
  ];

  test.each(calls)("全12関数を byte 比較する: %j", (value, expected) => {
    expect(whereToKintone(relativeComparison("日付", "=", value)))
      .toBe(`日付 = ${expected}`);
  });

  test.each([
    ["DAYS", "FROM_TODAY(-5, DAYS)"],
    ["WEEKS", "FROM_TODAY(-5, WEEKS)"],
    ["MONTHS", "FROM_TODAY(-5, MONTHS)"],
    ["YEARS", "FROM_TODAY(-5, YEARS)"],
  ] as const)("FROM_TODAY の単位 %s と `, ` を byte 比較する", (unit, expected) => {
    const value: RelativeDateFunction = {
      type: "KINTONE_FUNC",
      name: "FROM_TODAY",
      args: { kind: "FROM_TODAY", offset: -5, offsetText: "-5", unit },
    };
    expect(whereToKintone(relativeComparison("作成日時", "<", value)))
      .toBe(`作成日時 < ${expected}`);
  });

  test.each([
    "SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY",
    "THURSDAY", "FRIDAY", "SATURDAY",
  ] as const)("全曜日を quote/escape せず byte 比較する: %s", (weekday) => {
    const value: RelativeDateFunction = {
      type: "KINTONE_FUNC",
      name: "THIS_WEEK",
      args: { kind: "WEEK", weekday },
    };
    expect(whereToKintone(relativeComparison("更新日時", "=", value)))
      .toBe(`更新日時 = THIS_WEEK(${weekday})`);
  });

  test("offset は Number から再文字列化せず offsetText を出力する", () => {
    const value: RelativeDateFunction = {
      type: "KINTONE_FUNC",
      name: "FROM_TODAY",
      args: {
        kind: "FROM_TODAY",
        offset: Number.MAX_SAFE_INTEGER,
        offsetText: "9007199254740991",
        unit: "YEARS",
      },
    };
    expect(whereToKintone(relativeComparison("日付", ">=", value)))
      .toBe("日付 >= FROM_TODAY(9007199254740991, YEARS)");
  });

  test("既存 field/operator serializer を再利用し <> を != へ正規化する", () => {
    const value: RelativeDateFunction = {
      type: "KINTONE_FUNC",
      name: "TOMORROW",
      args: { kind: "NONE" },
    };
    expect(whereToKintone(relativeComparison("締切 日", "<>", value)))
      .toBe('"締切 日" != TOMORROW()');
  });

  test("BETWEEN 展開後の論理式を byte snapshot する", () => {
    const fromToday: RelativeDateFunction = {
      type: "KINTONE_FUNC",
      name: "FROM_TODAY",
      args: { kind: "FROM_TODAY", offset: -7, offsetText: "-7", unit: "DAYS" },
    };
    const expr: WhereExpr = {
      type: "LOGICAL",
      op: "AND",
      left: relativeComparison("日付", ">=", fromToday),
      right: {
        type: "BINARY",
        op: "<=",
        left: { type: "FIELD", field: "日付", tableAlias: null },
        right: { type: "KINTONE_FUNC", name: "TODAY" },
      },
    };
    expect(whereToKintone(expr))
      .toMatchInlineSnapshot(`"日付 >= FROM_TODAY(-7, DAYS) and 日付 <= TODAY()"`);
  });

  test.each([
    {
      type: "KINTONE_FUNC",
      name: "THIS_WEEK",
      args: { kind: "MONTH", day: null },
    },
    {
      type: "KINTONE_FUNC",
      name: "FROM_TODAY",
      args: { kind: "FROM_TODAY", offset: -5, offsetText: "'-5'", unit: "DAYS" },
    },
    {
      type: "KINTONE_FUNC",
      name: "THIS_WEEK",
      args: { kind: "WEEK", weekday: "monday" },
    },
    {
      type: "KINTONE_FUNC",
      name: "NEXT_MONTH",
      args: { kind: "MONTH", day: 32 },
    },
    {
      type: "KINTONE_FUNC",
      name: "tomorrow",
      args: { kind: "NONE" },
    },
  ])("不正な discriminant/引数は internal fail-closed: %j", (malformed) => {
    const expr = relativeComparison(
      "日付",
      "=",
      malformed as unknown as RelativeDateFunction
    );
    expect(() => whereToKintone(expr))
      .toThrow("internal error: invalid relative date function AST");
  });
});
