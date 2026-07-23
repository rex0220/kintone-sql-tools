import { Lexer } from "../../../lexer/lexer";
import { Parser } from "../../../parser/parser";
import type { SelectStatement } from "../../../types/ast";
import { resolveSelectMode } from "../../../converter/selectToKintone";
import { resolveFieldSemantics } from "../../fieldSemantics";
import { planCanonicalOrder } from "../canonicalOrderPlanner";

function statement(sql: string): SelectStatement {
  return new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement;
}

function plan(sql: string, capability: "EXACT_PUSHDOWN" | "LOCAL_ONLY" = "EXACT_PUSHDOWN") {
  const stmt = statement(sql);
  return planCanonicalOrder({
    stmt,
    staticMode: resolveSelectMode(stmt),
    whereCapability: capability,
    orderSemantics: new Map([
      ["$id", resolveFieldSemantics({ fieldType: "__ID__" })],
      ["レコード番号", resolveFieldSemantics({ fieldType: "RECORD_NUMBER" })],
      ["文字列", resolveFieldSemantics({ fieldType: "SINGLE_LINE_TEXT" })],
    ]),
    maxRecords: 10_000,
    hasKlike: false,
  });
}

test("$id + exact WHERE + LIMIT 5 だけを canonical REST top-N にする", () => {
  expect(plan("SELECT $id FROM APP100 WHERE $id > 0 ORDER BY $id DESC LIMIT 5")).toMatchObject({
    kind: "CANONICAL_REST_TOP_N",
    requiresCompleteInput: false,
  });
});

test("$id という SELECT alias は canonical REST top-N の直接列とみなさない", () => {
  expect(plan("SELECT 文字列 AS `$id` FROM APP100 ORDER BY `$id` LIMIT 5")).toMatchObject({
    kind: "CANONICAL_LOCAL",
    reasonCodes: expect.arrayContaining(["ORDER_KEY_NOT_REST_EQUIVALENT"]),
  });
});

test.each([
  ["SELECT $id FROM APP100 ORDER BY レコード番号 LIMIT 5", "ORDER_KEY_NOT_REST_EQUIVALENT"],
  ["SELECT $id FROM APP100 ORDER BY 文字列 LIMIT 5", "ORDER_KEY_NOT_REST_EQUIVALENT"],
  ["SELECT $id FROM APP100 ORDER BY $id", "LIMIT_NOT_REST_WINDOW"],
  ["SELECT $id FROM APP100 ORDER BY $id LIMIT 501", "LIMIT_NOT_REST_WINDOW"],
  ["SELECT $id FROM APP100 ORDER BY $id LIMIT 5 OFFSET 10001", "OFFSET_NOT_REST_WINDOW"],
] as const)("%s は canonical local (%s)", (sql, reason) => {
  expect(plan(sql)).toMatchObject({ kind: "CANONICAL_LOCAL", reasonCodes: expect.arrayContaining([reason]) });
});

test("残余 WHERE は $id top-N でも local にする", () => {
  expect(plan("SELECT $id FROM APP100 WHERE $id > 0 ORDER BY $id LIMIT 5", "LOCAL_ONLY"))
    .toMatchObject({ kind: "CANONICAL_LOCAL", reasonCodes: expect.arrayContaining(["WHERE_NOT_EXACT"]) });
});

test("REST window が maxRecords を超える場合は local にする", () => {
  const stmt = statement("SELECT $id FROM APP100 ORDER BY $id LIMIT 5");
  expect(planCanonicalOrder({
    stmt,
    staticMode: "SIMPLE",
    whereCapability: "EXACT_PUSHDOWN",
    orderSemantics: new Map([["$id", resolveFieldSemantics({ fieldType: "__ID__" })]]),
    maxRecords: 4,
    hasKlike: false,
  })).toMatchObject({
    kind: "CANONICAL_LOCAL",
    reasonCodes: expect.arrayContaining(["MAX_RECORDS_WINDOW"]),
  });
});

test("unsupported ORDER key は planning 時に拒否する", () => {
  const stmt = statement("SELECT $id FROM APP100 ORDER BY 利用者 LIMIT 5");
  expect(() => planCanonicalOrder({
    stmt,
    staticMode: "SIMPLE",
    whereCapability: "EXACT_PUSHDOWN",
    orderSemantics: new Map([["利用者", resolveFieldSemantics({ fieldType: "USER_SELECT" })]]),
    maxRecords: 10_000,
    hasKlike: false,
  })).toThrow(/ORDER_KEY_UNSUPPORTED/);
});

test("未解決 ORDER key は planning 時に拒否する", () => {
  const stmt = statement("SELECT $id FROM APP100 ORDER BY typo LIMIT 5");
  expect(() => planCanonicalOrder({
    stmt,
    staticMode: "SIMPLE",
    whereCapability: "EXACT_PUSHDOWN",
    orderSemantics: new Map(),
    maxRecords: 10_000,
    hasKlike: false,
  })).toThrow(/ORDER_KEY_UNRESOLVED/);
});

test("JOIN の曖昧な非修飾 ORDER key は専用 planning error にする", () => {
  const stmt = statement("SELECT a.$id FROM APP100 a JOIN APP200 b ON a.code = b.code ORDER BY name LIMIT 5");
  expect(() => planCanonicalOrder({
    stmt,
    staticMode: "FULL_SCAN",
    whereCapability: "EXACT_PUSHDOWN",
    orderSemantics: new Map([["name", resolveFieldSemantics({ fieldType: "KSQL_AMBIGUOUS" })]]),
    maxRecords: 10_000,
    hasKlike: false,
  })).toThrow(/ambiguous column reference.*ORDER_KEY_AMBIGUOUS/);
});

test("B65-O04: direct GROUPING_KEY は未解決 field 扱いにせず CANONICAL_LOCAL にする", () => {
  const stmt = statement(
    "SELECT GROUPING(a) AS g, SUM(x) AS total FROM APP100 " +
    "GROUP BY ROLLUP(a) ORDER BY GROUPING(a), total DESC"
  );
  expect(planCanonicalOrder({
    stmt,
    staticMode: resolveSelectMode(stmt),
    whereCapability: "EXACT_PUSHDOWN",
    orderSemantics: new Map([
      ["total", resolveFieldSemantics({ fieldType: "NUMBER" })],
    ]),
    maxRecords: 10_000,
    hasKlike: false,
  })).toMatchObject({
    kind: "CANONICAL_LOCAL",
    requiresCompleteInput: true,
    localOrderBy: true,
    reasonCodes: expect.arrayContaining(["ORDER_KEY_NOT_REST_EQUIVALENT", "QUERY_SHAPE_LOCAL"]),
  });
});

test("B65-O04: GROUPING alias は number semantics があれば ORDER_KEY_UNRESOLVED にならない", () => {
  const stmt = statement(
    "SELECT GROUPING(a) AS g, SUM(x) FROM APP100 GROUP BY ROLLUP(a) ORDER BY g"
  );
  expect(planCanonicalOrder({
    stmt,
    staticMode: resolveSelectMode(stmt),
    whereCapability: "EXACT_PUSHDOWN",
    orderSemantics: new Map([
      ["g", resolveFieldSemantics({ fieldType: "NUMBER" })],
    ]),
    maxRecords: 10_000,
    hasKlike: false,
  })).toMatchObject({
    kind: "CANONICAL_LOCAL",
    reasonCodes: expect.not.arrayContaining(["ORDER_KEY_UNRESOLVED"]),
  });
});
