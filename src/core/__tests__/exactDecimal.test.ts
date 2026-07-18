import {
  compareDecimal,
  compareExactDecimal,
  formatPlainDecimal,
  isFiniteDecimal,
  parseExactDecimal,
  toPlainDecimal,
} from "../exactDecimal";

describe("exact decimal primitive", () => {
  test.each([
    ["9007199254740992", "9007199254740993", -1],
    ["-9007199254740993", "-9007199254740992", -1],
    ["1.10", "1.1", 0],
    ["-0", "0", 0],
    ["1e21", "1000000000000000000000", 0],
    ["+0001.2300E+2", "123", 0],
    ["999999999999999999999999999999", "1000000000000000000000000000000", -1],
    ["0.1234567890", "0.1234567891", -1],
    ["-0.1234567891", "-0.1234567890", -1],
    ["1e-9007199254740991", "2e-9007199254740991", -1],
  ] as const)("compareDecimal(%s, %s)", (left, right, expected) => {
    expect(compareDecimal(left, right)).toBe(expected);
    expect(compareDecimal(right, left)).toBe(expected === 0 ? 0 : -expected);
  });

  test("公開正規形は signed scale と canonical zero を返す", () => {
    expect(parseExactDecimal("1e21")).toEqual({ sign: 1, coefficient: "1", scale: -21 });
    expect(parseExactDecimal("-0.000e99")).toEqual({ sign: 0, coefficient: "0", scale: 0 });
    expect(parseExactDecimal("001.2300")).toEqual({ sign: 1, coefficient: "123", scale: 2 });
    const value = parseExactDecimal("100e-2");
    expect(value).not.toBeNull();
    expect(compareExactDecimal(value!, parseExactDecimal("1")!)).toBe(0);
  });

  test.each([
    "", "   ", "Infinity", "-Infinity", "NaN", "1e", "1e+", "1..0", ".", "１２", "1x",
    "1e9007199254740991", "1e9007199254740992", "1e-9007199254740992",
  ])("rejects invalid input %p", (input) => {
    expect(parseExactDecimal(input)).toBeNull();
    expect(isFiniteDecimal(input)).toBe(false);
  });

  test("compareDecimal は不正domainをfail-closedする", () => {
    expect(() => compareDecimal("NaN", "0")).toThrow("ArgumentError");
  });

  test.each([
    ["1e3", "1000"],
    ["1E3", "1000"],
    ["1.5e2", "150"],
    ["1e21", "1000000000000000000000"],
    ["1e-5", "0.00001"],
    ["5e-5", "0.00005"],
    ["+5", "5"],
    ["-0", "0"],
    ["007", "7"],
    ["1.50", "1.5"],
    ["9007199254740993", "9007199254740993"],
    ["1.23456789012345678901234567890", "1.2345678901234567890123456789"],
  ])("toPlainDecimal は指数・符号・冗長ゼロを平文10進へ正規化する %p -> %p", (input, expected) => {
    expect(toPlainDecimal(input)).toBe(expected);
  });

  test("toPlainDecimal は非有限を null にする", () => {
    expect(toPlainDecimal("NaN")).toBeNull();
    expect(toPlainDecimal("1e")).toBeNull();
  });

  test("formatPlainDecimal は指数表記を出さない", () => {
    expect(formatPlainDecimal(parseExactDecimal("1e30")!)).toBe(`1${"0".repeat(30)}`);
    expect(formatPlainDecimal(parseExactDecimal("-1e-10")!)).toBe("-0.0000000001");
  });
});
