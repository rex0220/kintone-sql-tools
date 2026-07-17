import {
  fieldSemanticsEqual,
  resolveFieldSemantics,
  syntheticSemantics,
  withFieldSemanticSource,
} from "../fieldSemantics";

test.each([
  ["SINGLE_LINE_TEXT", undefined, "string"],
  ["LINK", undefined, "string"],
  ["DATETIME", undefined, "string"],
  ["NUMBER", undefined, "number"],
  ["CALC", "number", "number"],
  ["CALC", "string", "string"],
  ["RECORD_NUMBER", undefined, "recordNumber"],
  ["DROP_DOWN", undefined, "option"],
  ["STATUS", undefined, "option"],
  ["SUBTABLE", undefined, "unsupported"],
] as const)("%s / sortKind=%s を %s 意味型へ分類する", (fieldType, sortKind, compareMode) => {
  expect(resolveFieldSemantics({ fieldType, sortKind }).compareMode).toBe(compareMode);
});

test("選択肢順とサブテーブル所属を意味型へ保持する", () => {
  const semantics = resolveFieldSemantics({
    fieldType: "DROP_DOWN",
    inSubtable: true,
    optionOrder: { B: 1, A: 0 },
  });
  expect(semantics.inSubtable).toBe(true);
  expect([...semantics.optionOrder ?? []]).toEqual([["B", 1], ["A", 0]]);
});

test("物理列来歴を付けても元の意味型を変更しない", () => {
  const base = resolveFieldSemantics({ fieldType: "STATUS" });
  const sourced = withFieldSemanticSource(base, 42, "status");
  expect(base.source).toBeUndefined();
  expect(sourced).toMatchObject({
    fieldType: "STATUS",
    compareMode: "option",
    source: { appId: 42, fieldCode: "status" },
  });
});

test("意味型の同値判定は Map の参照ではなく内容を比較する", () => {
  const left = resolveFieldSemantics({ fieldType: "DROP_DOWN", optionOrder: { A: 0 } });
  const right = resolveFieldSemantics({ fieldType: "DROP_DOWN", optionOrder: { A: 0 } });
  expect(fieldSemanticsEqual(left, right)).toBe(true);
  expect(fieldSemanticsEqual(left, { ...right, optionOrder: new Map([["A", 1]]) })).toBe(false);
  expect(fieldSemanticsEqual(left, syntheticSemantics("string"))).toBe(false);
});
