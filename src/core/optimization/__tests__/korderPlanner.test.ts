import { resolveSelectMode } from "../../../converter/selectToKintone";
import { Lexer } from "../../../lexer/lexer";
import { Parser } from "../../../parser/parser";
import type { SelectStatement } from "../../../types/ast";
import { resolveFieldSemantics, withFieldSemanticSource } from "../../fieldSemantics";
import { planKorderNative } from "../korderPlanner";

function statement(sql: string): SelectStatement {
  return new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement;
}

function semantics(fieldCode: string, fieldType: string) {
  return withFieldSemanticSource(resolveFieldSemantics({ fieldType }), 100, fieldCode);
}

function plan(
  sql: string,
  options: {
    capability?: "EXACT_PUSHDOWN" | "LOCAL_ONLY";
    maxRecords?: number;
    hasKlike?: boolean;
    orderSemantics?: ReadonlyMap<string, ReturnType<typeof semantics>>;
  } = {}
) {
  const stmt = statement(sql);
  return planKorderNative({
    stmt,
    staticMode: resolveSelectMode(stmt),
    whereCapability: options.capability ?? "EXACT_PUSHDOWN",
    orderSemantics: options.orderSemantics ?? new Map([
      ["$id", resolveFieldSemantics({ fieldType: "__ID__" })],
      ["金額", semantics("金額", "NUMBER")],
      ["名前", semantics("名前", "SINGLE_LINE_TEXT")],
      ["利用者", semantics("利用者", "USER_SELECT")],
    ]),
    maxRecords: options.maxRecords ?? 10_000,
    hasKlike: options.hasKlike ?? false,
  });
}

test("native allowlist の直接物理列を KORDER_NATIVE にする", () => {
  expect(plan("SELECT $id FROM APP100 KORDER BY 金額 DESC, $id ASC LIMIT 5 OFFSET 2"))
    .toEqual({
      kind: "KORDER_NATIVE",
      requiresCompleteInput: false,
      localOrderBy: false,
      applyLocalOffsetLimit: false,
      reasonCodes: [],
  });
});

test.each([
  "RECORD_NUMBER", "SINGLE_LINE_TEXT", "NUMBER", "CALC", "DATE", "DATETIME", "TIME",
  "CREATED_TIME", "UPDATED_TIME", "DROP_DOWN", "RADIO_BUTTON", "STATUS", "LINK",
  "CREATOR", "MODIFIER",
])("公式受理型 %s を明示 native allowlist に含める", (fieldType) => {
  expect(plan(
    "SELECT 値 FROM APP100 KORDER BY 値 LIMIT 1",
    { orderSemantics: new Map([["値", semantics("値", fieldType)]]) }
  )).toMatchObject({ kind: "KORDER_NATIVE" });
});

test.each(["RICH_TEXT", "USER_SELECT", "MULTI_SELECT", "CHECK_BOX", "FILE", "UNKNOWN_FUTURE"])(
  "native allowlist 外の %s は denylist 的に通さない",
  (fieldType) => {
    expect(() => plan(
      "SELECT 値 FROM APP100 KORDER BY 値 LIMIT 1",
      { orderSemantics: new Map([["値", semantics("値", fieldType)]]) }
    )).toThrow(new RegExp(`KORDER_TYPE_UNSUPPORTED\\(field=値, type=${fieldType}\\)`));
  }
);

test.each([9999, 10000])("OFFSET %i は公式契約内として受理する", (offset) => {
  expect(plan(`SELECT $id FROM APP100 KORDER BY $id LIMIT 1 OFFSET ${offset}`))
    .toMatchObject({ kind: "KORDER_NATIVE" });
});

test.each([
  ["SELECT $id FROM APP100 KORDER BY 金額", "KORDER_LIMIT_INVALID"],
  ["SELECT $id FROM APP100 KORDER BY 金額 LIMIT 501", "KORDER_LIMIT_INVALID"],
  ["SELECT $id FROM APP100 KORDER BY 金額 LIMIT 5 OFFSET 10001", "KORDER_OFFSET_INVALID"],
  ["SELECT $id FROM APP100 KORDER BY 利用者 LIMIT 5", "KORDER_TYPE_UNSUPPORTED"],
  ["SELECT $id FROM APP100 KORDER BY typo LIMIT 5", "KORDER_KEY_UNRESOLVED"],
  ["SELECT $id FROM APP100 KORDER BY LENGTH(名前) LIMIT 5", "KORDER_KEY_NOT_DIRECT_FIELD"],
  ["SELECT DISTINCT $id FROM APP100 KORDER BY $id LIMIT 5", "KORDER_QUERY_SHAPE_UNSUPPORTED"],
] as const)("%s を fail-closed で拒否する (%s)", (sql, reason) => {
  expect(() => plan(sql)).toThrow(reason);
});

test("LIMIT は実行時 maxRecords 以下でなければならない", () => {
  expect(() => plan(
    "SELECT $id FROM APP100 KORDER BY $id LIMIT 500",
    { maxRecords: 100 }
  )).toThrow(/KORDER_LIMIT_EXCEEDS_MAX_RECORDS/);
});

test("残余 WHERE と KLIKE は native plan にしない", () => {
  const sql = "SELECT $id FROM APP100 WHERE 名前 = 'x' KORDER BY $id LIMIT 5";
  expect(() => plan(sql, { capability: "LOCAL_ONLY" })).toThrow(/KORDER_WHERE_NOT_EXACT/);
  expect(() => plan(sql, { hasKlike: true })).toThrow(/KORDER_KLIKE_UNSUPPORTED/);
});

test("SELECT alias は物理列コードとして扱わない", () => {
  const map = new Map([
    ["別名", semantics("金額", "NUMBER")],
  ]);
  expect(() => plan(
    "SELECT 金額 AS 別名 FROM APP100 KORDER BY 別名 LIMIT 5",
    { orderSemantics: map }
  )).toThrow(/KORDER_KEY_NOT_DIRECT_FIELD/);
});
