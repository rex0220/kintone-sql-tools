import { compareScalarValues, type ScalarCompareOp } from "../scalarCompare";

test.each<[string, ScalarCompareOp, string, boolean]>([
  ["", "<",  "-1000000", true],
  ["", ">=", "-1000000", false],
  ["", ">=", "0", false],
  ["", "<=", "0", true],
  ["-1", ">", "", false],
  ["-1", "<", "", true],
  ["", ">=", "", true],
  ["A", ">", "", true],
])("compareScalarValues(%j, %s, %j) → %s", (left, op, right, expected) => {
  expect(compareScalarValues(op, left, right)).toBe(expected);
});

test.each<[string, ScalarCompareOp, string, boolean]>([
  ["", "<", "Infinity", true],
  ["", ">=", "-Infinity", true],
  ["", "<", "-Infinity", false],
])("非有限右辺は従来の数値比較を維持: %j %s %j → %s", (left, op, right, expected) => {
  expect(compareScalarValues(op, left, right)).toBe(expected);
});

test("等値・非等値は空セルの範囲規則に影響されない", () => {
  expect(compareScalarValues("=", "", "0")).toBe(false);
  expect(compareScalarValues("!=", "", "0")).toBe(true);
  expect(compareScalarValues("=", "", "")).toBe(true);
});

test("包含境界は高精度小数が安全整数へ丸まるため数値プレフィルタに使えない", () => {
  expect(compareScalarValues(">=", "0.99999999999999999", "1")).toBe(true);
  expect(compareScalarValues("<=", "1.00000000000000001", "1")).toBe(true);
});
