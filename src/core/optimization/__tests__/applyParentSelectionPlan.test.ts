import { evalWhere } from "../../../engine/evalWhere";
import { Lexer } from "../../../lexer/lexer";
import { Parser } from "../../../parser/parser";
import type { KlikeExpr } from "../../like";
import type { SelectStatement, WhereExpr } from "../../../types/ast";
import { buildApplyParentSelectionPlan } from "../applyParentSelectionPlan";

const metadata = {
  fieldTypes: new Map([
    ["金額", "NUMBER"],
    ["件名", "SINGLE_LINE_TEXT"],
    ["備考", "MULTI_LINE_TEXT"],
  ]),
  fieldOptions: new Map<string, ReadonlySet<string>>(),
};

function where(sql: string): WhereExpr {
  return (new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement).where!;
}

function binaryNodes(expr: WhereExpr): Array<Extract<WhereExpr, { type: "BINARY" }>> {
  switch (expr.type) {
    case "BINARY":
      return [expr];
    case "LOGICAL":
      return [...binaryNodes(expr.left), ...binaryNodes(expr.right)];
    case "NOT":
    case "GROUP":
      return binaryNodes(expr.expr);
    case "NULL_CHECK":
    case "EXISTS":
    case "BOOLEAN":
      return [];
  }
}

function klikeNodes(expr: WhereExpr): KlikeExpr[] {
  return binaryNodes(expr).filter(
    (node): node is KlikeExpr => node.op === "KLIKE" || node.op === "NOT_KLIKE"
  );
}

test("safe scalar と KLIKE を同じ prefilter に抽出し、元 leaf identity を保つ", () => {
  const original = where("SELECT * FROM APP100 WHERE 金額 > 10 AND 件名 KLIKE '至急'");
  const [scalar, originalKlike] = binaryNodes(original);

  const plan = buildApplyParentSelectionPlan(original, metadata);

  expect(plan.prefilter).not.toBeNull();
  expect(binaryNodes(plan.prefilter!)).toEqual([scalar, originalKlike]);
  expect(binaryNodes(plan.prefilter!)[0]).toBe(scalar);
  expect(binaryNodes(plan.prefilter!)[1]).toBe(originalKlike);
  expect(plan.appliedKlikes.has(originalKlike as KlikeExpr)).toBe(true);
  expect(plan.unappliedKlikes).toEqual([]);
});

test.each([
  ["LIKE-only", "SELECT * FROM APP100 WHERE 件名 LIKE '%A%'", false],
  ["safe scalar + LIKE", "SELECT * FROM APP100 WHERE 金額 > 10 AND 件名 LIKE '%A%'", true],
])("%s は LIKE を push しない", (_name, sql, hasScalar) => {
  const original = where(sql as string);
  const plan = buildApplyParentSelectionPlan(original, metadata);

  if (hasScalar) {
    expect(plan.prefilter).toBe(binaryNodes(original)[0]);
  } else {
    expect(plan.prefilter).toBeNull();
  }
  expect(plan.appliedKlikes.size).toBe(0);
  expect(plan.unappliedKlikes).toEqual([]);
});

test.each([
  "SELECT * FROM APP100 WHERE 件名 KLIKE '至急' OR 金額 > 10",
  "SELECT * FROM APP100 WHERE NOT (件名 KLIKE '至急')",
])("OR / NOT subtree の KLIKE を部分抽出せず unapplied に残す — %s", (sql) => {
  const original = where(sql);
  const [originalKlike] = klikeNodes(original);
  const plan = buildApplyParentSelectionPlan(original, metadata);

  expect(plan.prefilter).toBeNull();
  expect(plan.appliedKlikes.size).toBe(0);
  expect(plan.unappliedKlikes).toEqual([originalKlike]);
  expect(plan.unappliedKlikes[0]).toBe(originalKlike);
});

test("複数 KLIKE のうち安全な leaf だけ applied にし、OR 配下を unapplied にする", () => {
  const original = where(
    "SELECT * FROM APP100 WHERE 件名 KLIKE '至急' "
    + "AND (備考 NOT KLIKE '保留' OR 金額 > 10)"
  );
  const [applied, unapplied] = klikeNodes(original);
  const plan = buildApplyParentSelectionPlan(original, metadata);

  expect(plan.prefilter).toBe(applied);
  expect(plan.appliedKlikes.has(applied)).toBe(true);
  expect(plan.appliedKlikes.has(unapplied)).toBe(false);
  expect(plan.unappliedKlikes).toEqual([unapplied]);
  expect(plan.unappliedKlikes[0]).toBe(unapplied);
});

test("clone node は applied 集合の identity 証明にならず evalWhere が拒否する", () => {
  const original = where("SELECT * FROM APP100 WHERE 件名 KLIKE '至急'");
  const [originalKlike] = klikeNodes(original);
  const clonedKlike = { ...originalKlike } as KlikeExpr;

  expect(clonedKlike).not.toBe(originalKlike);
  expect(() => evalWhere(original, { 件名: "至急" }, undefined, new Set([clonedKlike])))
    .toThrow(/押し下げ済み集合/);
});
