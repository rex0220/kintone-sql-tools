import { evalWhere, type FieldTypeResolver } from "../evalWhere";
import type { SelectStatement, WhereExpr } from "../../types/ast";
import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";

function parseWhere(sql: string): WhereExpr {
  const stmt = new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement;
  if (!stmt.where) throw new Error("test query must contain WHERE");
  return stmt.where;
}

function resolver(types: Record<string, string>): FieldTypeResolver {
  return (field) => types[field.field];
}

test("符号付き IN / NOT IN は = と同じ負数文字列表現を評価する", () => {
  const inNegative = parseWhere("SELECT * FROM APP1 WHERE 金額 IN (-1)");
  const notInNegative = parseWhere("SELECT * FROM APP1 WHERE 金額 NOT IN (-1)");
  const equalNegative = parseWhere("SELECT * FROM APP1 WHERE 金額 = -1");
  const betweenNegative = parseWhere("SELECT * FROM APP1 WHERE 金額 BETWEEN -10 AND 10");
  const mixed = parseWhere("SELECT * FROM APP1 WHERE 金額 IN (0, 1000, -1, +1)");
  const numberResolver = resolver({ 金額: "NUMBER" });

  for (const value of ["-1", "0", "1", "1000", "2"]) {
    expect(evalWhere(inNegative, { 金額: value }))
      .toBe(evalWhere(equalNegative, { 金額: value }));
    expect(evalWhere(notInNegative, { 金額: value }))
      .toBe(!evalWhere(equalNegative, { 金額: value }));
  }
  expect(["-1", "0", "1", "1000", "2"].filter((金額) =>
    evalWhere(mixed, { 金額 })
  )).toEqual(["-1", "0", "1", "1000"]);
  expect(["-11", "-10", "0", "10", "11"].filter((金額) =>
    evalWhere(betweenNegative, { 金額 }, numberResolver)
  )).toEqual(["-10", "0", "10"]);
});

test("CHECK_BOX / MULTI_SELECT の IN は文字列配列の要素を比較する", () => {
  const expr = parseWhere("SELECT * FROM APP1 WHERE 選択 IN ('A', 'C')");
  expect(evalWhere(expr, { 選択: '["A","B"]' }, resolver({ 選択: "CHECK_BOX" }))).toBe(true);
  expect(evalWhere(expr, { 選択: '["B"]' }, resolver({ 選択: "MULTI_SELECT" }))).toBe(false);
});

test("複数値の NOT IN は IN の否定で、空配列は true", () => {
  const expr = parseWhere("SELECT * FROM APP1 WHERE 選択 NOT IN ('A')");
  const types = resolver({ 選択: "CHECK_BOX" });
  expect(evalWhere(expr, { 選択: '["A","B"]' }, types)).toBe(false);
  expect(evalWhere(expr, { 選択: '["B"]' }, types)).toBe(true);
  expect(evalWhere(expr, { 選択: "[]" }, types)).toBe(true);
});

test.each(["CHECK_BOX", "MULTI_SELECT", "USER_SELECT", "ORGANIZATION_SELECT", "GROUP_SELECT", "STATUS_ASSIGNEE"])(
  "%s の空配列は IN ('') に一致し NOT IN ('') から除外する",
  (fieldType) => {
    const inEmpty = parseWhere("SELECT * FROM APP1 WHERE 選択 IN ('')");
    const notInEmpty = parseWhere("SELECT * FROM APP1 WHERE 選択 NOT IN ('')");
    const types = resolver({ 選択: fieldType });
    expect(evalWhere(inEmpty, { 選択: "[]" }, types)).toBe(true);
    expect(evalWhere(notInEmpty, { 選択: "[]" }, types)).toBe(false);
  }
);

test("空配列は空文字を含む集合だけに一致し、既存の NOT IN 非空値包含を維持する", () => {
  const mixed = parseWhere("SELECT * FROM APP1 WHERE 選択 IN ('', 'A')");
  const inValue = parseWhere("SELECT * FROM APP1 WHERE 選択 IN ('A')");
  const notInValue = parseWhere("SELECT * FROM APP1 WHERE 選択 NOT IN ('A')");
  const types = resolver({ 選択: "CHECK_BOX" });
  expect(evalWhere(mixed, { 選択: "[]" }, types)).toBe(true);
  expect(evalWhere(inValue, { 選択: "[]" }, types)).toBe(false);
  expect(evalWhere(notInValue, { 選択: "[]" }, types)).toBe(true);
});

test.each(["DROP_DOWN", "RADIO_BUTTON", "STATUS"])(
  "%s の正規化済み空スカラーは IN ('') に一致する",
  (fieldType) => {
    const expr = parseWhere("SELECT * FROM APP1 WHERE 選択 IN ('')");
    expect(evalWhere(expr, { 選択: "" }, resolver({ 選択: fieldType }))).toBe(true);
  }
);

test("USER 系は表示名ではなく code を比較する", () => {
  const byCode = parseWhere("SELECT * FROM APP1 WHERE 主担当 IN ('rex0220')");
  const byName = parseWhere("SELECT * FROM APP1 WHERE 主担当 IN ('開発太郎')");
  const row = { 主担当: '[{"code":"rex0220","name":"開発太郎"}]' };
  const types = resolver({ 主担当: "USER_SELECT" });
  expect(evalWhere(byCode, row, types)).toBe(true);
  expect(evalWhere(byName, row, types)).toBe(false);
});

test("CREATOR / MODIFIER は単一オブジェクトの code を比較する", () => {
  const expr = parseWhere("SELECT * FROM APP1 WHERE 作成者 IN ('u1')");
  expect(evalWhere(
    expr,
    { 作成者: '{"code":"u1","name":"User 1"}' },
    resolver({ 作成者: "CREATOR" })
  )).toBe(true);
});

test("テキストの JSON 風文字列は配列化せず従来の完全一致を維持する", () => {
  const exact = parseWhere("SELECT * FROM APP1 WHERE テキスト IN ('[\"A\"]')");
  const element = parseWhere("SELECT * FROM APP1 WHERE テキスト IN ('A')");
  const row = { テキスト: '["A"]' };
  const types = resolver({ テキスト: "SINGLE_LINE_TEXT" });
  expect(evalWhere(exact, row, types)).toBe(true);
  expect(evalWhere(element, row, types)).toBe(false);
});

test.each([
  ["CHECK_BOX", '"A"', '"A"'],
  ["CHECK_BOX", "not-json", "not-json"],
  ["USER_SELECT", '["A"]', '["A"]'],
  ["USER_SELECT", '[{"name":"A"}]', '[{"name":"A"}]'],
] as const)("%s の形不一致値は従来比較へフォールバックする", (fieldType, left, expected) => {
  const expr = parseWhere(`SELECT * FROM APP1 WHERE f IN ('${expected.replace(/'/g, "''")}')`);
  expect(evalWhere(expr, { f: left }, resolver({ f: fieldType }))).toBe(true);
});

test("SUBQUERY_IN_LIST も複数値フィールドの共通 membership を使う", () => {
  const expr = parseWhere("SELECT * FROM APP1 WHERE 主担当 IN (SELECT code FROM APP2)");
  if (expr.type !== "BINARY" || expr.right.type !== "SUBQUERY_IN_LIST") {
    throw new Error("unexpected test AST");
  }
  Object.assign(expr.right, { resolved: new Set(["rex0220"]) });
  expect(evalWhere(
    expr,
    { 主担当: '[{"code":"rex0220","name":"開発太郎"}]' },
    resolver({ 主担当: "USER_SELECT" })
  )).toBe(true);
});

test("SUBQUERY_IN_LIST の空文字は空配列フィールドに一致する", () => {
  const expr = parseWhere("SELECT * FROM APP1 WHERE 選択 IN (SELECT code FROM APP2)");
  if (expr.type !== "BINARY" || expr.right.type !== "SUBQUERY_IN_LIST") {
    throw new Error("unexpected test AST");
  }
  Object.assign(expr.right, { resolved: new Set([""]) });
  expect(evalWhere(
    expr,
    { 選択: "[]" },
    resolver({ 選択: "MULTI_SELECT" })
  )).toBe(true);
});
