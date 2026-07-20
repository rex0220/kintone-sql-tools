import { parseSqlStatement, parseSqlStatements } from "../../core/sql";
import { ParseError } from "../parser";

const prefix = "UPDATE APP4221 SET 親 = 'x' WHERE $id = 8 ";

describe("UPDATE APPLY parser", () => {
  test("PATCH / selector / EXPECT ROWS を AST に保持する", () => {
    const stmt = parseSqlStatement(`${prefix}APPLY テーブル (
      PATCH SET 子 = 'a', 数値 = 1 WHERE _rid = '101' EXPECT ROWS BETWEEN 1 AND 2;
      REMOVE ALL ROWS EXPECT ROWS AT MOST 5;
      APPEND (子, 数値) VALUES ('b', 2), ('c', 3)
    ) VALIDATE ONLY`);
    expect(stmt).toMatchObject({
      type: "UPDATE",
      validateOnly: true,
      applyBlocks: [{
        field: "テーブル",
        operations: [
          { kind: "PATCH", selector: { kind: "WHERE" }, expectRows: { kind: "BETWEEN", min: 1, max: 2 } },
          { kind: "REMOVE", selector: { kind: "ALL_ROWS" }, expectRows: { kind: "AT_MOST", count: 5 } },
          { kind: "APPEND", fields: ["子", "数値"], values: expect.any(Array) },
        ],
      }],
    });
  });

  test.each([
    ["EXPECT ROWS 0", { kind: "EXACT", count: 0 }],
    ["EXPECT ROWS BETWEEN 1 AND 3", { kind: "BETWEEN", min: 1, max: 3 }],
    ["EXPECT ROWS AT LEAST 1", { kind: "AT_LEAST", count: 1 }],
    ["EXPECT ROWS AT MOST 2", { kind: "AT_MOST", count: 2 }],
  ])("EXPECT ROWS grammar を AST 化する: %s", (guard, expected) => {
    const stmt = parseSqlStatement(`${prefix}APPLY テーブル (PATCH SET 子 = 'x' ALL ROWS ${guard})`);
    expect(stmt).toMatchObject({ applyBlocks: [{ operations: [{ expectRows: expected }] }] });
  });

  test("_idxの等値/IN selectorを0-based数値リテラルのASTとして保持する", () => {
    const stmt = parseSqlStatement(`${prefix}APPLY テーブル (
      PATCH SET 子='first' WHERE _idx=0;
      REMOVE WHERE _idx IN (0,2)
    )`);
    expect(stmt).toMatchObject({ applyBlocks: [{ operations: [
      {
        kind: "PATCH",
        selector: { kind: "WHERE", where: {
          type: "BINARY", op: "=", left: { type: "FIELD", field: "_idx" },
          right: { type: "NUMBER", value: 0 },
        } },
      },
      {
        kind: "REMOVE",
        selector: { kind: "WHERE", where: {
          type: "BINARY", op: "IN", left: { type: "FIELD", field: "_idx" },
          right: { type: "IN_LIST", values: [{ type: "NUMBER", value: 0 }, { type: "NUMBER", value: 2 }] },
        } },
      },
    ] }] });
  });

  test("ブロック内セミコロン、末尾省略、文字列・コメント内セミコロンを区別する", () => {
    const statements = parseSqlStatements(`${prefix}APPLY テーブル (
      PATCH SET 子 = 'a;b' WHERE _rid = '1'; -- ; is data
      /* ; is also data */ PATCH SET 子 = 'c' ALL ROWS;
    ); SELECT APPLY AS APPLY FROM APP1;`);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatchObject({ type: "UPDATE", applyBlocks: [{ operations: [{ kind: "PATCH" }, { kind: "PATCH" }] }] });
  });

  test.each([
    `${prefix}APPLY テーブル ()`,
    `${prefix}APPLY テーブル (; PATCH SET 子 = 1 ALL ROWS)`,
    `${prefix}APPLY テーブル (PATCH SET 子 = 1 ALL ROWS;; PATCH SET 子 = 2 ALL ROWS)`,
    `${prefix}APPLY テーブル (PATCH SET 子 = 1)`,
  ])("空ブロック・空操作・selector 省略を拒否する: %s", (sql) => {
    expect(() => parseSqlStatement(sql)).toThrow(ParseError);
  });

  test("APPLY SUBTABLE noun を専用エラーで拒否する", () => {
    expect(() => parseSqlStatement(`${prefix}APPLY SUBTABLE テーブル (PATCH SET 子 = 1 ALL ROWS)`))
      .toThrow(/APPLY SUBTABLE noun is not supported/);
  });

  test.each([
    `${prefix}APPLY テーブル (PATCH SET 子 = 1 ALL ROWS) WHERE $id = 9`,
    `${prefix}APPLY テーブル (PATCH SET 子 = 1 ALL ROWS) CHECK WHEN x = 1 THEN 'x'`,
    `${prefix}APPLY テーブル (PATCH SET 子 = 1 ALL ROWS) ON ERROR SKIP INTO #e`,
    `${prefix}VALIDATE ONLY APPLY テーブル (PATCH SET 子 = 1 ALL ROWS)`,
  ])("APPLY の句順違反を拒否する: %s", (sql) => {
    expect(() => parseSqlStatement(sql)).toThrow(ParseError);
  });

  test("APPLY は既存のフィールド名・alias として非回帰", () => {
    expect(parseSqlStatement("UPDATE APP1 SET APPLY = 'x' WHERE $id = 1")).toMatchObject({
      type: "UPDATE", assignments: [{ field: "APPLY" }],
    });
    expect(parseSqlStatement("SELECT APPLY AS APPLY FROM APP1 APPLY")).toMatchObject({
      type: "SELECT", from: { alias: "APPLY" },
    });
  });
});
