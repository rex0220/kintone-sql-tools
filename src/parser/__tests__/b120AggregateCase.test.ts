import { Lexer } from "../../lexer/lexer";
import { Parser } from "../parser";
import type { SelectStatement } from "../../types/ast";

function parseSelect(sql: string): SelectStatement {
  return new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement;
}

test("B120-P01: CASE 条件の集計参照を合成フィールド名とともに保持する", () => {
  const stmt = parseSelect(
    "SELECT CASE WHEN COUNT(*) = 0 THEN 'none' ELSE 'some' END AS result FROM APP1"
  );
  expect(stmt.columns[0]).toMatchObject({
    type: "CASE_COL",
    expr: {
      branches: [{
        condition: {
          type: "BINARY",
          left: {
            type: "FIELD",
            field: "COUNT(*)",
            aggregateRef: { type: "AGG_REF", func: "COUNT", distinct: false },
          },
        },
      }],
    },
  });
});

test("B120-P02: CASE の THEN/ELSE に直接集計と集計入りスカラー関数を書ける", () => {
  const direct = parseSelect(
    "SELECT CASE WHEN flag = 1 THEN SUM(a) ELSE MAX(b) END FROM APP1"
  );
  expect(direct.columns[0]).toMatchObject({
    type: "CASE_COL",
    expr: {
      branches: [{ result: { type: "AGG_REF", func: "SUM" } }],
      elseResult: { type: "AGG_REF", func: "MAX" },
    },
  });

  const guarded = parseSelect(
    "SELECT CASE WHEN SUM(b) = 0 THEN '' ELSE ROUND(SUM(a) * 100.0 / SUM(b), 1) END FROM APP1"
  );
  const guardedColumn = guarded.columns[0];
  expect(guardedColumn).toMatchObject({ type: "CASE_COL" });
  if (guardedColumn.type !== "CASE_COL") throw new Error("expected CASE_COL");
  expect(guardedColumn.expr.branches[0].condition).toMatchObject({
    left: { aggregateRef: { func: "SUM" } },
  });
  expect(guardedColumn.expr.elseResult).toMatchObject({
    type: "STRING_FUNC",
    func: "ROUND",
  });
  const elseResult = guardedColumn.expr.elseResult;
  if (elseResult?.type !== "STRING_FUNC") throw new Error("expected ROUND result");
  expect(elseResult.args[0]).toMatchObject({ type: "AGG_ARITH" });
});

test("B120-R01: 既存の集計算術式と ROUND 診断を変えない", () => {
  expect(() => parseSelect(
    "SELECT SUM(a) * 100.0 / GREATEST(SUM(b), 1) FROM APP1"
  )).toThrow("集計算術式には集計関数または数値が必要です");
  expect(() => parseSelect(
    "SELECT ROUND(SUM(a) / GREATEST(SUM(b), 1), 1) FROM APP1"
  )).toThrow("ROUND の引数構文が不正です。スカラー値式に集約関数は使用できません");
});
