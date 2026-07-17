import { parseSqlStatement } from "../../sql";
import { resolveFieldSemantics } from "../../fieldSemantics";
import { classifyWhereCapability, nativeWhereOperatorsForType } from "../whereCapability";
import type { SelectStatement } from "../../../types/ast";

function whereOf(sql: string) {
  return (parseSqlStatement(sql) as SelectStatement).where;
}

function classify(sql: string, fields: Record<string, {
  fieldType: string;
  inSubtable?: boolean;
  requiresCollectionOperators?: boolean;
}>) {
  return classifyWhereCapability(whereOf(sql), (field) => {
    const source = fields[field.field];
    return source ? resolveFieldSemantics(source) : undefined;
  });
}

test.each([
  ["RECORD_NUMBER", ["=", "!=", ">", "<", ">=", "<=", "in", "not in"]],
  ["SINGLE_LINE_TEXT", ["=", "!=", "in", "not in", "like", "not like"]],
  ["NUMBER", ["=", "!=", ">", "<", ">=", "<=", "in", "not in"]],
  ["MULTI_LINE_TEXT", ["like", "not like"]],
  ["DROP_DOWN", ["in", "not in"]],
  ["STATUS", ["=", "!=", "in", "not in"]],
  ["STATUS_ASSIGNEE", []],
  ["FUTURE_FIELD", []],
] as const)("native capability matrix: %s", (fieldType, operators) => {
  expect([...nativeWhereOperatorsForType(fieldType)]).toEqual(operators);
});

test.each([
  ["SELECT x FROM APP1 WHERE x > '100'", "SINGLE_LINE_TEXT", "LOCAL_ONLY"],
  ["SELECT x FROM APP1 WHERE x = '100'", "SINGLE_LINE_TEXT", "EXACT_PUSHDOWN"],
  ["SELECT x FROM APP1 WHERE x > 100", "NUMBER", "EXACT_PUSHDOWN"],
  ["SELECT x FROM APP1 WHERE x IN ('A')", "DROP_DOWN", "EXACT_PUSHDOWN"],
  ["SELECT x FROM APP1 WHERE x LIKE '%A%'", "SINGLE_LINE_TEXT", "LOCAL_ONLY"],
  ["SELECT x FROM APP1 WHERE x KLIKE 'A'", "SINGLE_LINE_TEXT", "EXACT_PUSHDOWN"],
  ["SELECT x FROM APP1 WHERE x > 1", "CHECK_BOX", "UNSUPPORTED"],
  ["SELECT x FROM APP1 WHERE x = 'A'", "DROP_DOWN", "LOCAL_ONLY"],
] as const)("%s / %s => %s", (sql, fieldType, expected) => {
  expect(classify(sql, { x: { fieldType } }).capability).toBe(expected);
});

test("AND は exact leaf を上位集合prefilterとして残し、OR は全体をlocalにする", () => {
  const fields = { n: { fieldType: "NUMBER" }, s: { fieldType: "SINGLE_LINE_TEXT" } };
  expect(classify("SELECT n FROM APP1 WHERE n > 1 AND s > '1'", fields).capability)
    .toBe("SUPERSET_PREFILTER");
  expect(classify("SELECT n FROM APP1 WHERE n > 1 OR s > '1'", fields).capability)
    .toBe("LOCAL_ONLY");
});

test("サブテーブル内の = はnative不可、INは基底型能力を使う", () => {
  const fields = { x: { fieldType: "SINGLE_LINE_TEXT", inSubtable: true } };
  expect(classify("SELECT x FROM APP1 WHERE x = 'A'", fields).capability).toBe("LOCAL_ONLY");
  expect(classify("SELECT x FROM APP1 WHERE x IN ('A')", fields).capability).toBe("EXACT_PUSHDOWN");
});

test("関連レコード参照先も = を使わずIN系の構造制約を優先する", () => {
  const fields = { x: { fieldType: "SINGLE_LINE_TEXT", requiresCollectionOperators: true } };
  expect(classify("SELECT x FROM APP1 WHERE x = 'A'", fields).capability).toBe("LOCAL_ONLY");
  expect(classify("SELECT x FROM APP1 WHERE x IN ('A')", fields).capability).toBe("EXACT_PUSHDOWN");
});

test("未知フィールド・未知型はfail-closedにする", () => {
  expect(classify("SELECT x FROM APP1 WHERE x = 'A'", {}).capability).toBe("UNSUPPORTED");
  expect(classify("SELECT x FROM APP1 WHERE x = 'A'", { x: { fieldType: "FUTURE_FIELD" } }).capability)
    .toBe("UNSUPPORTED");
});
