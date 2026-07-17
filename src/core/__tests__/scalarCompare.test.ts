import {
  compareCanonicalValues,
  compareCodePointStrings,
  compareScalarValues,
  selectScalarExtreme,
  type ScalarCompareOp,
} from "../scalarCompare";
import { resolveFieldSemantics, syntheticSemantics } from "../fieldSemantics";

const numberSemantics = syntheticSemantics("number");
const stringSemantics = syntheticSemantics("string");

test.each<[string, ScalarCompareOp, string, boolean]>([
  ["", "<",  "-1000000", true],
  ["", ">=", "-1000000", false],
  ["", ">=", "0", false],
  ["", "<=", "0", true],
  ["-1", ">", "", true],
  ["-1", "<", "", false],
  ["", ">=", "", true],
  ["A", ">", "", true],
])("compareScalarValues(%j, %s, %j) → %s", (left, op, right, expected) => {
  expect(compareScalarValues(op, left, right, numberSemantics)).toBe(expected);
});

test.each<[string, ScalarCompareOp, string, boolean]>([
  ["", "<", "Infinity", true],
  ["", ">=", "-Infinity", false],
  ["", "<", "-Infinity", true],
])("固定数値バンドで比較する: %j %s %j → %s", (left, op, right, expected) => {
  expect(compareScalarValues(op, left, right, numberSemantics)).toBe(expected);
});

test("等値・非等値は空セルの範囲規則に影響されない", () => {
  expect(compareScalarValues("=", "", "0", numberSemantics)).toBe(false);
  expect(compareScalarValues("!=", "", "0", numberSemantics)).toBe(true);
  expect(compareScalarValues("=", "", "", numberSemantics)).toBe(true);
});

test("包含境界は高精度小数が安全整数へ丸まるため数値プレフィルタに使えない", () => {
  expect(compareScalarValues(">=", "0.99999999999999999", "1", numberSemantics)).toBe(true);
  expect(compareScalarValues("<=", "1.00000000000000001", "1", numberSemantics)).toBe(true);
});

test("コードポイント順はBMP・補助平面・孤立サロゲートをホスト非依存で比較する", () => {
  const values = ["亜", String.fromCodePoint(0xfa00), "ｱ", "😀", "𠮟", "\ud800", "\udc00"];
  const sorted = [...values].sort(compareCodePointStrings);
  expect(sorted).toEqual(["亜", "\ud800", "\udc00", String.fromCodePoint(0xfa00), "ｱ", "😀", "𠮟"]);
});

test("typed string は数値らしい値もコードポイント順にする", () => {
  expect(compareScalarValues(">", "20", "100", stringSemantics)).toBe(true);
  expect(compareScalarValues("<", "10", "9", stringSemantics)).toBe(true);
});

test("typed number は固定バンド順にする", () => {
  const values = ["x", "NaN", "Infinity", "10", "2", "-Infinity", "", "1a"];
  expect([...values].sort((a, b) => compareCanonicalValues(a, b, numberSemantics))).toEqual([
    "", "-Infinity", "2", "10", "Infinity", "NaN", "1a", "x",
  ]);
});

test("typed number の空白のみは Number 規則により有限数 0 の peer とする", () => {
  expect(compareCanonicalValues(" ", "0", numberSemantics)).toBe(0);
  expect(compareCanonicalValues(" ", "-Infinity", numberSemantics)).toBe(1);
  expect(compareCanonicalValues(" ", "Infinity", numberSemantics)).toBe(-1);
});

test("RECORD_NUMBER は末尾IDをbinary64へ変換せず比較する", () => {
  const semantics = resolveFieldSemantics({ fieldType: "RECORD_NUMBER" });
  expect(compareCanonicalValues("APPCODE-2", "APPCODE-10", semantics)).toBe(-1);
  expect(compareCanonicalValues("AAA-2", "BBB-2", semantics)).toBe(-1);
  expect(compareCanonicalValues("9007199254740993", "9007199254740992", semantics)).toBe(1);
  expect(() => compareCanonicalValues("APPCODE-X", "APPCODE-2", semantics)).toThrow(/ArgumentError/);
});

test("複数選択は保存配列順を捨てたcanonical vectorで比較する", () => {
  const semantics = resolveFieldSemantics({
    fieldType: "MULTI_SELECT",
    optionOrder: { X: 0, Y: 1, Z: 2 },
  });
  expect(compareCanonicalValues('["Y","Z"]', '["Z","Y"]', semantics)).toBe(0);
  expect(compareCanonicalValues('["Y"]', '["Y","Z"]', semantics)).toBe(-1);
  expect(compareCanonicalValues('["Z"]', '["unknown"]', semantics)).toBe(-1);
});

test("共有leafは -1/0/1・反対称性・推移律を満たす", () => {
  const samples = ["", "-Infinity", "-1", "0", "-0", " ", "2", "10", "Infinity", "NaN", "1a", "x"];
  for (const a of samples) {
    expect(compareCanonicalValues(a, a, numberSemantics)).toBe(0);
    for (const b of samples) {
      const ab = compareCanonicalValues(a, b, numberSemantics);
      const ba = compareCanonicalValues(b, a, numberSemantics);
      expect([-1, 0, 1]).toContain(ab);
      expect(ab).toBe(ba === 0 ? 0 : -ba);
      for (const c of samples) {
        const bc = compareCanonicalValues(b, c, numberSemantics);
        if (ab <= 0 && bc <= 0) {
          expect(compareCanonicalValues(a, c, numberSemantics)).toBeLessThanOrEqual(0);
        }
      }
    }
  }
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

test("GREATEST/LEAST の文字列モードと数値tieはコードポイント順を使う", () => {
  expect(selectScalarExtreme(["ｱ", "😀", "x"], "greatest")).toBe("😀");
  expect(selectScalarExtreme(["ｱ", "😀", "x"], "least")).toBe("x");
  expect(selectScalarExtreme(["0", "-0"], "greatest")).toBe("0");
});

test("空文字は常に最小として比較前に確定する", () => {
  expect(selectScalarExtreme(["", "-1"], "greatest")).toBe("-1");
  expect(selectScalarExtreme(["-1", ""], "greatest")).toBe("-1");
  expect(selectScalarExtreme(["", "5"], "least")).toBe("");
  expect(selectScalarExtreme(["", ""], "greatest")).toBe("");
});
