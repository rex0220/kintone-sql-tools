import { compareScalarValues, selectScalarExtreme, type ScalarCompareOp } from "../scalarCompare";

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

function permutations(values: string[]): string[][] {
  if (values.length < 2) return [values];
  return values.flatMap((value, index) =>
    permutations([...values.slice(0, index), ...values.slice(index + 1)])
      .map((rest) => [value, ...rest])
  );
}

test.each([
  [["2", "10", "1a"], "2", "10"],
  [["1", "01", "1.0"], "1.0", "01"],
] as const)("n 項比較は全順列で一意: %j", (values, greatest, least) => {
  for (const args of permutations([...values])) {
    expect(selectScalarExtreme(args, "greatest")).toBe(greatest);
    expect(selectScalarExtreme(args, "least")).toBe(least);
  }
});

test("数値同値は元文字列を二次キーにし、表記を保持する", () => {
  expect(selectScalarExtreme(["0", "-0"], "greatest")).toBe("0");
  expect(selectScalarExtreme(["-0", "0"], "least")).toBe("-0");
  expect(selectScalarExtreme(["007", "008"], "greatest")).toBe("008");
  expect(selectScalarExtreme(["007", "008"], "least")).toBe("007");
});

test("空文字は常に最小として比較前に確定する", () => {
  expect(selectScalarExtreme(["", "-1"], "greatest")).toBe("-1");
  expect(selectScalarExtreme(["-1", ""], "greatest")).toBe("-1");
  expect(selectScalarExtreme(["", "5"], "least")).toBe("");
  expect(selectScalarExtreme(["", ""], "greatest")).toBe("");
});
