import { assertApplyScope, assertApplyV1Scope } from "../applyPatchScope";
import type { UpdateStatement } from "../../types/ast";
import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";
import { execute, type KintoneClient } from "../../execute";

const sql = (parentWhere: string, operation: string, tail = "") =>
  `UPDATE APP4221 SET 親 = 'x' WHERE ${parentWhere} APPLY テーブル (${operation}) ${tail}`;

function validate(text: string): void {
  assertApplyV1Scope(new Parser(new Lexer(text).tokenize()).parse());
}

describe("assertApplyV1Scope", () => {
  test.each([
    "PATCH SET 子 = 'x' WHERE _rid = '101'",
    "PATCH SET 子 = 'x' WHERE LENGTH(子) < 3",
    "PATCH SET 子 = 'x' ALL ROWS",
  ])("v1 PATCH scope を許可する: %s", (operation) => {
    expect(() => validate(sql("$id = 8", operation))).not.toThrow();
  });

  test.each([
    ["APPEND", "APPEND (子) VALUES ('x')"],
    ["REMOVE", "REMOVE ALL ROWS"],
    ["EXPECT ROWS", "PATCH SET 子 = 'x' ALL ROWS EXPECT ROWS 1"],
    ["_idx", "PATCH SET 子 = 'x' WHERE _idx = 0"],
    ["parent ref", "PATCH SET 子 = 'x' WHERE _p.親 = 'x'"],
    ["subquery", "PATCH SET 子 = 'x' WHERE 子 IN (SELECT 子 FROM APP2)"],
    ["aggregate", "PATCH SET 子 = 'x' WHERE COUNT(*) > 0"],
    ["KLIKE", "PATCH SET 子 = 'x' WHERE 子 KLIKE 'x'"],
  ])("v1 外 child capability を対象フェーズ付きで拒否する: %s", (_label, operation) => {
    expect(() => validate(sql("$id = 8", operation))).toThrow(/^UnsupportedError: APPLY v1 scope/);
  });

  test.each([
    "$id = 0",
    "$id = -1",
    "$id = 1.5",
    "$id = 8 AND 状態 = 'open'",
    "状態 = 'open'",
  ])("単一の正の安全な整数 $id 以外を拒否する: %s", (where) => {
    expect(() => validate(sql(where, "PATCH SET 子 = 'x' ALL ROWS"))).toThrow(/^UnsupportedError: APPLY v1 scope/);
  });

  test("複数ブロックを拒否し、同一テーブル重複は ArgumentError を優先する", () => {
    const distinct = `${sql("$id = 8", "PATCH SET 子 = 'x' ALL ROWS")} APPLY 別表 (PATCH SET 子 = 'y' ALL ROWS)`;
    expect(() => validate(distinct)).toThrow(/UnsupportedError: APPLY v1 scope.*multiple APPLY/);

    const duplicate = `${sql("$id = 8", "PATCH SET 子 = 'x' ALL ROWS")} APPLY テーブル (PATCH SET 子 = 'y' ALL ROWS)`;
    expect(() => validate(duplicate)).toThrow(/^ArgumentError: APPLY v1 scope/);
  });

  test("UPDATE FROM / CHECK / ON ERROR SKIP / REJECT LIMIT の AST 併用を拒否する", () => {
    const base = new Parser(new Lexer(sql("$id = 8", "PATCH SET 子 = 'x' ALL ROWS")).tokenize()).parse() as UpdateStatement;
    const variants: UpdateStatement[] = [
      { ...base, from: { appId: 2, cteName: null, alias: "s", targetJoinField: "$id", joinKeyField: "$id", targetFilter: null } },
      { ...base, checkGroups: [{ rules: [] }] },
      { ...base, onErrorSkip: true, errorTable: "#e" },
      { ...base, rejectLimit: 1 },
    ];
    for (const stmt of variants) expect(() => assertApplyV1Scope(stmt)).toThrow(/^UnsupportedError: APPLY v1 scope/);
  });

  test("parser が AST 化した UPDATE FROM + APPLY を scope で明示拒否する", () => {
    expect(() => validate(
      "UPDATE APP4221 SET 親 = s.親 FROM APP2 s WHERE APP4221.$id = s.$id "
      + "APPLY テーブル (PATCH SET 子 = 'x' ALL ROWS)"
    )).toThrow(/UnsupportedError: APPLY v1 scope does not support UPDATE \.\.\. FROM/);
  });

  test("EXPLAIN executor は APPLY metadata だけを読み records/mutation API 0", async () => {
      const calls = {
        getRecords: jest.fn(), openCursor: jest.fn(), postRecords: jest.fn(), putRecords: jest.fn(),
        deleteRecords: jest.fn(), getApps: jest.fn(), getFields: jest.fn(async () => [
          { code: "親", label: "親", fieldType: "SINGLE_LINE_TEXT", writable: true },
          { code: "テーブル", label: "テーブル", fieldType: "SUBTABLE", writable: false },
          { code: "子", label: "子", fieldType: "SINGLE_LINE_TEXT", writable: true, inSubtable: true, subtableCode: "テーブル" },
        ]),
        getNumberPrecision: jest.fn(), getProcessStatuses: jest.fn(),
      };
      const client = calls as unknown as KintoneClient;
      const statement = sql("$id = 8", "PATCH SET 子 = 'x' ALL ROWS");
      await expect(execute(`EXPLAIN ${statement}`, client)).resolves.toMatchObject({ type: "SELECT" });
      expect(calls.getFields).toHaveBeenCalledWith(4221);
      for (const fn of [calls.getRecords, calls.openCursor, calls.postRecords, calls.putRecords, calls.deleteRecords]) {
        expect(fn).not.toHaveBeenCalled();
      }
  });
});

describe("assertApplyScope v1.1", () => {
  const validateV11 = (text: string): void => {
    assertApplyScope("v1.1", new Parser(new Lexer(text).tokenize()).parse());
  };

  test("異なるtableの複数blockとPATCH/APPENDだけを明示許可する", () => {
    expect(() => validateV11(
      `${sql("$id = 8", "PATCH SET 子 = 'x' ALL ROWS; APPEND (子) VALUES ('a'), ('b')")}`
      + " APPLY 別表 (APPEND (別子) VALUES ('y'))"
    )).not.toThrow();
  });

  test("同一table複数blockはArgumentError、REMOVE/EXPECT/_idx/複数親はv1.1 UnsupportedError", () => {
    expect(() => validateV11(`${sql("$id = 8", "PATCH SET 子='x' ALL ROWS")} APPLY テーブル (APPEND (子) VALUES ('y'))`))
      .toThrow(/^ArgumentError: APPLY v1\.1 scope allows only one block for table テーブル/);
    for (const statement of [
      sql("$id = 8", "REMOVE ALL ROWS"),
      sql("$id = 8", "PATCH SET 子='x' ALL ROWS EXPECT ROWS 1"),
      sql("$id = 8", "PATCH SET 子='x' WHERE _idx=0"),
      sql("$id = 8 OR $id = 9", "APPEND (子) VALUES ('x')"),
    ]) expect(() => validateV11(statement)).toThrow(/^UnsupportedError: APPLY v1\.1 scope/);
  });
});

describe("assertApplyScope v1.2", () => {
  const validateV12 = (text: string): void => {
    assertApplyScope("v1.2", new Parser(new Lexer(text).tokenize()).parse());
  };

  test("v1.1集合にREMOVE WHERE/ALL ROWSを加法許可する", () => {
    expect(() => validateV12(sql("$id = 8", "REMOVE WHERE 子 = 'x'; APPEND (子) VALUES ('new')"))).not.toThrow();
    expect(() => validateV12(sql("$id = 8", "REMOVE ALL ROWS"))).not.toThrow();
  });

  test("EXPECT ROWS/_idx/複数親はv1.2でも明示拒否する", () => {
    for (const statement of [
      sql("$id = 8", "REMOVE ALL ROWS EXPECT ROWS 1"),
      sql("$id = 8", "REMOVE WHERE _idx=0"),
      sql("$id = 8 OR $id = 9", "REMOVE ALL ROWS"),
    ]) expect(() => validateV12(statement)).toThrow(/^UnsupportedError: APPLY v1\.2 scope/);
  });
});
