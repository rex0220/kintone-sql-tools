import type { KintoneFieldInfo } from "../../execute";
import type { MultiValueApplyBlock } from "../../types/ast";
import { buildApplyMultiValueFieldPlan } from "../applyMultiValuePlan";

const block = (...operations: Array<["ADD" | "REMOVE_VALUE", string]>): MultiValueApplyBlock => ({
  field: "対象",
  targetKind: "MULTI_VALUE",
  operations: operations.map(([kind, value]) => ({ kind, value })),
});

const field = (fieldType: string, extra: Partial<KintoneFieldInfo> = {}): KintoneFieldInfo => ({
  code: "対象", label: "対象", fieldType, writable: true, ...extra,
});

test.each(["CHECK_BOX", "MULTI_SELECT"])(
  "%s string[] は既存順を保持し、新規ADDを末尾、重複ADD/不存在REMOVEをno-opにする",
  (fieldType) => {
    const plan = buildApplyMultiValueFieldPlan(
      block(["ADD", "B"], ["REMOVE_VALUE", "X"], ["ADD", "C"], ["ADD", "C"], ["REMOVE_VALUE", "A"]),
      ["A", "B"],
      field(fieldType, { optionOrder: { A: 0, B: 1, C: 2 } })
    );
    expect(plan.postImageValue).toEqual(["B", "C"]);
    expect(plan).toMatchObject({ addedValues: 1, removedValues: 1, changedValues: 2 });
  }
);

test.each(["USER_SELECT", "ORGANIZATION_SELECT", "GROUP_SELECT"])(
  "%s {code}[] はcode集合で演算しpayloadを{code}だけへ正規化する",
  (fieldType) => {
    const plan = buildApplyMultiValueFieldPlan(
      block(["REMOVE_VALUE", "u1"], ["ADD", "u3"], ["ADD", "u2"]),
      [{ code: "u1", name: "One" }, { code: "u2", name: "Two" }],
      field(fieldType)
    );
    expect(plan.postImageValue).toEqual([{ code: "u2" }, { code: "u3" }]);
    expect(plan).toMatchObject({ addedValues: 1, removedValues: 1 });
  }
);

test("全operationを更新前snapshotだけへ解決し、同値ADD+REMOVEは順序を問わずconflictにする", () => {
  for (const operations of [
    [["ADD", "C"], ["REMOVE_VALUE", "C"]],
    [["REMOVE_VALUE", "C"], ["ADD", "C"]],
  ] as Array<Array<["ADD" | "REMOVE_VALUE", string]>>) {
    expect(() => buildApplyMultiValueFieldPlan(
      block(...operations), ["A"], field("MULTI_SELECT", { optionOrder: { A: 0, C: 1 } })
    )).toThrow('ArgumentError: APPLY multi-value field 対象 has conflicting ADD and REMOVE for "C"');
  }
});

test("空文字ADD/REMOVEはB46未選択no-opにする", () => {
  const empty = buildApplyMultiValueFieldPlan(
    block(["ADD", ""], ["REMOVE_VALUE", ""]), [],
    field("MULTI_SELECT", { required: true, optionOrder: { A: 0 } })
  );
  expect(empty.postImageValue).toEqual([]);
  expect(empty.changedValues).toBe(0);
});

test("snapshot payload形をstring[]と{code}[]で厳密に分岐する", () => {
  expect(() => buildApplyMultiValueFieldPlan(block(["ADD", "A"]), [{ code: "A" }], field("CHECK_BOX")))
    .toThrow(/must contain string values/);
  expect(() => buildApplyMultiValueFieldPlan(block(["ADD", "u2"]), ["u1"], field("USER_SELECT")))
    .toThrow(/must contain \{code: string\} values/);
});
