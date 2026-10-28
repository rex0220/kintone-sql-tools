import { assertApplyScope } from "../applyPatchScope";
import { buildApplyAppendRows, resolveApplyPatchMetadata } from "../applyPatchPlanner";
import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";
import type { AppendOperation, UpdateStatement } from "../../types/ast";
import type { KintoneFieldInfo } from "../../execute";

const fieldInfos: KintoneFieldInfo[] = [
  { code: "親", label: "親", fieldType: "SINGLE_LINE_TEXT", writable: true },
  { code: "テーブル", label: "テーブル", fieldType: "SUBTABLE", writable: false },
  { code: "子", label: "子", fieldType: "SINGLE_LINE_TEXT", writable: true, inSubtable: true, subtableCode: "テーブル" },
  { code: "数", label: "数", fieldType: "NUMBER", writable: true, inSubtable: true, subtableCode: "テーブル" },
];

function parse(text: string): UpdateStatement {
  return new Parser(new Lexer(text).tokenize()).parse() as UpdateStatement;
}

const appendSelectSql = "UPDATE APP4221 SET 親 = 'x' WHERE 親 = 'y'"
  + " APPLY テーブル (REMOVE ALL ROWS; APPEND (子, 数) SELECT 子, 数 FROM APP1)";

test("phase16a は APPEND ... SELECT を通す", () => {
  expect(() => assertApplyScope("phase16a", parse(appendSelectSql))).not.toThrow();
});

// 単一親の形（$id = n）で比べる。v1 / v1.1 は APPEND / REMOVE 自体が無いので先に別の理由で落ちる。
const appendSelectByIdSql = "UPDATE APP4221 SET 親 = 'x' WHERE $id = 8"
  + " APPLY テーブル (REMOVE ALL ROWS; APPEND (子, 数) SELECT 子, 数 FROM APP1)";

test.each(["v1.2", "phase10a", "phase12", "phase13a", "phase14c", "phase15a", "phase15b"] as const)(
  "%s は APPEND ... SELECT を通さない（既存の phase はすべて fail-closed）",
  (version) => {
    expect(() => assertApplyScope(version, parse(appendSelectByIdSql)))
      .toThrow(/does not support APPEND \.\.\. SELECT/);
  }
);

test.each([
  ["v1", /does not support REMOVE in this phase/],
  ["v1.1", /does not support REMOVE in this phase/],
] as const)("%s は APPEND ... SELECT に届く前に既存の理由で落ちる", (version, expected) => {
  expect(() => assertApplyScope(version, parse(appendSelectByIdSql))).toThrow(expected);
});

test("phase15b までの既存の形は phase16a でも今までどおり通る", () => {
  const sql = "UPDATE APP4221 SET 親 = 'x' WHERE $id = 8"
    + " APPLY テーブル (PATCH SET 子 = 'a' WHERE _rid = '101'; APPEND (子) VALUES ('b'); REMOVE ALL ROWS)";
  expect(() => assertApplyScope("phase16a", parse(sql))).not.toThrow();
  expect(() => assertApplyScope("phase15b", parse(sql))).not.toThrow();
});

test("解決していない SELECT が planner へ届いたら、書かずに InternalError で止まる", () => {
  const statement = parse(appendSelectSql);
  const metadata = resolveApplyPatchMetadata(statement, fieldInfos);
  const children = metadata.childrenByTable.get("テーブル")!;
  const operation = statement.applyBlocks![0].operations
    .find((item) => item.kind === "APPEND") as AppendOperation;
  expect(() => buildApplyAppendRows(operation, children, "テーブル"))
    .toThrow(/InternalError: APPLY APPEND for テーブル has an unresolved SELECT source/);
});

test("解決済みの行を渡せば、その行がそのまま APPEND の行になる", () => {
  const statement = parse(appendSelectSql);
  const metadata = resolveApplyPatchMetadata(statement, fieldInfos);
  const children = metadata.childrenByTable.get("テーブル")!;
  const operation = statement.applyBlocks![0].operations
    .find((item) => item.kind === "APPEND") as AppendOperation;
  const rows = buildApplyAppendRows(operation, children, "テーブル", {}, [
    { value: { 子: { value: "a" }, 数: { value: "1" } } },
    { value: { 子: { value: "b" }, 数: { value: "2" } } },
  ]);
  expect(rows).toEqual([
    { value: { 子: { value: "a" }, 数: { value: "1" } } },
    { value: { 子: { value: "b" }, 数: { value: "2" } } },
  ]);
});

test("metadata 解決は SELECT 形でも APPEND の対象項目の writable を見る", () => {
  const statement = parse("UPDATE APP4221 SET 親 = 'x' WHERE 親 = 'y'"
    + " APPLY テーブル (REMOVE ALL ROWS; APPEND (子, テーブル) SELECT 子, 子 FROM APP1)");
  expect(() => resolveApplyPatchMetadata(statement, fieldInfos))
    .toThrow(/APPLY child テーブル does not exist|not writable/);
});
