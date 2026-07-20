import { assertApplyV1Scope } from "../applyPatchScope";
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

  test.each(["", " VALIDATE ONLY", "EXPLAIN "])(
    "executor は Phase 1 APPLY を API 0 回で停止する: %s",
    async (mode) => {
      const calls = {
        getRecords: jest.fn(), openCursor: jest.fn(), postRecords: jest.fn(), putRecords: jest.fn(),
        deleteRecords: jest.fn(), getApps: jest.fn(), getFields: jest.fn(),
        getNumberPrecision: jest.fn(), getProcessStatuses: jest.fn(),
      };
      const client = calls as unknown as KintoneClient;
      const statement = sql("$id = 8", "PATCH SET 子 = 'x' ALL ROWS");
      const text = mode === "EXPLAIN " ? `${mode}${statement}` : `${statement}${mode}`;
      await expect(execute(text, client)).rejects.toThrow(
        "UnsupportedError: APPLY execution is not enabled in this phase"
      );
      for (const fn of Object.values(calls)) expect(fn).not.toHaveBeenCalled();
    }
  );
});
