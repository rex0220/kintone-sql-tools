import { expandExponentialDecimal, MAX_EXPANDED_DECIMAL_LENGTH } from "../decimalText";

describe("B179 exponential decimal expansion", () => {
  test.each([
    ["1.25e+22", "12500000000000000000000"],
    ["1e-7", "0.0000001"],
    ["-0e+10", "-0"],
    ["0.00e-999999999999999999999", "0"],
    [".5E1", "5"],
    ["+12.30e-1", "+1.230"],
  ])("expands %s lexically without rounding", (input, expected) => {
    expect(expandExponentialDecimal(input)).toBe(expected);
  });

  test("accepts an expanded value of exactly 1,024 characters", () => {
    const result = expandExponentialDecimal("1e1023");
    expect(result).toHaveLength(MAX_EXPANDED_DECIMAL_LENGTH);
    expect(result).toMatch(/^10+$/);
  });

  test("rejects expansion beyond 1,024 characters before allocating it", () => {
    expect(() => expandExponentialDecimal("1e1024")).toThrow(expect.objectContaining({
      name: "ExportSinkInvalidValueError",
      code: "ExportSinkInvalidValueError",
    }));
    expect(() => expandExponentialDecimal("1e999999999999999999999999999999"))
      .toThrow("exceeds 1024 characters");
  });

  test.each(["1e", "e3", "1e+", "1.2.3e4", "NaNe2"])("rejects malformed exponent %s", (input) => {
    expect(() => expandExponentialDecimal(input)).toThrow("invalid exponential notation");
  });
});
