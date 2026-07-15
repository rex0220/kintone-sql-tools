import { Lexer } from "../../../lexer/lexer";
import { Parser } from "../../../parser/parser";
import type { SelectStatement, WithStatement } from "../../../types/ast";
import { buildInlinedQuery } from "../../cteInlining";
import { evalWhere } from "../../../engine/evalWhere";
import { buildKlikePushdownPlan, unappliedKlikes } from "../klikePushdownPlan";

function select(sql: string): SelectStatement {
  return new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement;
}

test("AND リーフの KLIKE をメイン計画と適用済み集合へ同時に記録する", () => {
  const stmt = select("SELECT * FROM APP100 WHERE 件名 KLIKE '至急' AND 備考 LIKE '%A%'");
  const plan = buildKlikePushdownPlan(stmt);
  expect(plan.mainCondition).toMatchObject({ type: "BINARY", op: "KLIKE" });
  expect(plan.appliedKlikes.size).toBe(1);
  expect(unappliedKlikes(plan)).toHaveLength(0);
  expect(evalWhere(stmt.where!, { 件名: "x", 備考: "A" }, undefined, plan.appliedKlikes)).toBe(true);
});

test("集合外の KLIKE は evalWhere が fail-closed で拒否する", () => {
  const stmt = select("SELECT * FROM APP100 WHERE 件名 KLIKE '至急'");
  expect(() => evalWhere(stmt.where!, { 件名: "至急" })).toThrow(/押し下げ済み集合/);
});

test.each([
  "SELECT DISTINCT * FROM APP100 WHERE 件名 KLIKE '至急' OR 種別 = 'A'",
  "SELECT DISTINCT * FROM APP100 WHERE NOT (件名 KLIKE '至急')",
  "SELECT * FROM APP100 a LEFT JOIN APP200 b ON a.ID = b.ID WHERE a.件名 KLIKE '至急'",
  "SELECT * FROM APP100 a RIGHT JOIN APP200 b ON a.ID = b.ID WHERE b.件名 KLIKE '至急'",
])("押し下げ不能な KLIKE を適用済み集合へ入れない — %s", (sql) => {
  const plan = buildKlikePushdownPlan(select(sql));
  expect(plan.appliedKlikes.size).toBe(0);
  expect(unappliedKlikes(plan)).toHaveLength(1);
});

test("INNER JOIN は KLIKE を参照先テーブルの条件へ割り当てる", () => {
  const stmt = select(
    "SELECT * FROM APP100 a INNER JOIN APP200 b ON a.ID = b.ID "
    + "WHERE a.件名 KLIKE '至急' AND b.説明 NOT KLIKE '保留'"
  );
  const plan = buildKlikePushdownPlan(stmt);
  expect(plan.mainCondition).toMatchObject({ op: "KLIKE" });
  expect(plan.joinConditions.get("b")).toMatchObject({ op: "NOT_KLIKE" });
  expect(plan.appliedKlikes.size).toBe(2);
  expect(unappliedKlikes(plan)).toHaveLength(0);
});

test("CTE エイリアス除去後の同一 AST から計画を生成する", () => {
  const withStmt = new Parser(new Lexer(
    "WITH c AS (SELECT * FROM APP100 WHERE 件名 KLIKE '至急') "
    + "SELECT * FROM c AS x WHERE x.備考 LIKE '%A%'"
  ).tokenize()).parse() as WithStatement;
  const inlined = buildInlinedQuery(withStmt);
  const plan = buildKlikePushdownPlan(inlined);
  expect(unappliedKlikes(plan)).toHaveLength(0);
  expect(plan.appliedKlikes.size).toBe(1);
});
