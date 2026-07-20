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

  test("EXPECT ROWS BETWEENの逆範囲とAPPEND後のEXPECTをparse errorにする", () => {
    expect(() => parseSqlStatement("UPDATE APP1 SET 親='x' WHERE $id=1 APPLY 表 (PATCH SET 子='x' ALL ROWS EXPECT ROWS BETWEEN 2 AND 1)"))
      .toThrow("EXPECT ROWS BETWEEN の下限は上限以下にしてください");
    expect(() => parseSqlStatement("UPDATE APP1 SET 親='x' WHERE $id=1 APPLY 表 (APPEND (子) VALUES ('x') EXPECT ROWS 1)"))
      .toThrow();
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

describe("INSERT APPLY parser", () => {
  test("VALUES 後の APPEND を AST に保持し validation suffix を後置できる", () => {
    const stmt = parseSqlStatement(
      "INSERT INTO APP4221 (親) VALUES ('x'), ('y') "
      + "APPLY テーブル (APPEND (子, 数値) VALUES ('a', 1), ('b', 2)) VALIDATE ONLY"
    );
    expect(stmt).toMatchObject({
      type: "INSERT",
      values: expect.any(Array),
      validateOnly: true,
      applyBlocks: [{
        field: "テーブル",
        operations: [{ kind: "APPEND", fields: ["子", "数値"], values: expect.any(Array) }],
      }],
    });
  });

  test("PATCH / REMOVE も将来構文として kind を失わず AST 化する", () => {
    const stmt = parseSqlStatement(
      "INSERT INTO APP4221 (親) VALUES ('x') APPLY テーブル ("
      + "PATCH SET 子='y' WHERE _idx=0 EXPECT ROWS 1; REMOVE ALL ROWS EXPECT ROWS 0)"
    );
    expect(stmt).toMatchObject({ applyBlocks: [{ operations: [
      { kind: "PATCH", expectRows: { kind: "EXACT", count: 1 } },
      { kind: "REMOVE", expectRows: { kind: "EXACT", count: 0 } },
    ] }] });
  });

  test.each([
    "INSERT INTO APP1 (親) VALUES ('x') VALIDATE ONLY APPLY 表 (APPEND (子) VALUES ('a'))",
    "INSERT INTO APP1 (親) VALUES ('x') CHECK WHEN 親='x' THEN 'ng' APPLY 表 (APPEND (子) VALUES ('a'))",
    "INSERT INTO APP1 (親) VALUES ('x') APPLY 表 (APPEND (子) VALUES ('a')) CHECK WHEN 親='x' THEN 'ng'",
  ])("APPLY の句順違反を ParseError にする: %s", (sql) => {
    expect(() => parseSqlStatement(sql)).toThrow(ParseError);
  });

  test("INSERT INTO ... SELECT と APPLY の併用を明示拒否する", () => {
    expect(() => parseSqlStatement(
      "INSERT INTO APP1 (親) SELECT 親 FROM APP2 APPLY 表 (APPEND (子) VALUES ('a'))"
    )).toThrow("INSERT INTO ... SELECT は APPLY に対応していません");
  });

  test("APPLY は既存 INSERT の識別子として非回帰", () => {
    const stmt = parseSqlStatement("INSERT INTO APP1 (APPLY) VALUES ('APPLY')");
    expect(stmt).toMatchObject({ type: "INSERT", fields: ["APPLY"] });
    expect(stmt).not.toHaveProperty("applyBlocks");
  });
});

describe("UPSERT branch APPLY parser", () => {
  const base = "UPSERT INTO APP4221 (key, 親) VALUES ('K1', 'x') ON DUPLICATE (key)";

  test("ON INSERT / ON UPDATE を順不同で分岐別 AST に保持する", () => {
    const stmt = parseSqlStatement(
      `${base} ON UPDATE APPLY テーブル (`
      + "PATCH SET 子='updated' WHERE _idx=0 EXPECT ROWS 1; REMOVE ALL ROWS; APPEND (子) VALUES ('new')"
      + ") ON INSERT APPLY テーブル (APPEND (子) VALUES ('initial')) VALIDATE ONLY"
    );
    expect(stmt).toMatchObject({
      type: "UPSERT",
      validateOnly: true,
      onInsertApplyBlocks: [{ field: "テーブル", operations: [{ kind: "APPEND" }] }],
      onUpdateApplyBlocks: [{ field: "テーブル", operations: [
        { kind: "PATCH", expectRows: { kind: "EXACT", count: 1 } },
        { kind: "REMOVE" },
        { kind: "APPEND" },
      ] }],
    });
  });

  test("片方または両方の分岐省略を undefined で表す", () => {
    const insertOnly = parseSqlStatement(`${base} ON INSERT APPLY 表 (APPEND (子) VALUES ('a'))`);
    expect(insertOnly).toHaveProperty("onInsertApplyBlocks");
    expect(insertOnly).not.toHaveProperty("onUpdateApplyBlocks");

    const updateOnly = parseSqlStatement(`${base} ON UPDATE APPLY 表 (REMOVE ALL ROWS)`);
    expect(updateOnly).not.toHaveProperty("onInsertApplyBlocks");
    expect(updateOnly).toHaveProperty("onUpdateApplyBlocks");

    const neither = parseSqlStatement(base);
    expect(neither).not.toHaveProperty("onInsertApplyBlocks");
    expect(neither).not.toHaveProperty("onUpdateApplyBlocks");
  });

  test.each([
    `${base} ON INSERT APPLY 表 (APPEND (子) VALUES ('a')) ON INSERT APPLY 別表 (APPEND (子) VALUES ('b'))`,
    `${base} APPLY 表 (APPEND (子) VALUES ('a'))`,
    `${base} VALIDATE ONLY ON UPDATE APPLY 表 (REMOVE ALL ROWS)`,
    `${base} ON INSERT APPLY 表 (APPEND (子) VALUES ('a')) CHECK WHEN 親='x' THEN 'ng'`,
    `${base} ON UPDATE APPLY 表 (REMOVE ALL ROWS) ON ERROR SKIP INTO #err`,
  ])("分岐重複・句順違反・CHECK/ON ERROR 併用を拒否する: %s", (sql) => {
    expect(() => parseSqlStatement(sql)).toThrow(ParseError);
  });

  test("UPSERT SELECT と分岐 APPLY の併用を明示拒否する", () => {
    expect(() => parseSqlStatement(
      "UPSERT INTO APP1 (key) SELECT key FROM APP2 ON DUPLICATE (key) "
      + "ON UPDATE APPLY 表 (PATCH SET 子='x' ALL ROWS)"
    )).toThrow("UPSERT INTO ... SELECT は ON INSERT / ON UPDATE APPLY に対応していません");
  });

  test("APPLY は既存 UPSERT の識別子として非回帰", () => {
    const stmt = parseSqlStatement("UPSERT INTO APP1 (APPLY) VALUES ('x') ON DUPLICATE (APPLY)");
    expect(stmt).toMatchObject({ type: "UPSERT", fields: ["APPLY"], keyFields: ["APPLY"] });
    expect(stmt).not.toHaveProperty("onInsertApplyBlocks");
    expect(stmt).not.toHaveProperty("onUpdateApplyBlocks");
  });
});
