import { validateAndNormalizeDmlValue } from "../dmlValidation";
import {
  exactDecimalDigitCounts,
  parseNumberPrecisionSettings,
  type NumberPrecision,
} from "../numberPrecision";
import { parseExactDecimal } from "../exactDecimal";

const numberField = { code: "amount", label: "amount", fieldType: "NUMBER" };

describe("numberPrecision settings", () => {
  test("文字列レスポンスを検証済み内部型へ変換する", () => {
    expect(parseNumberPrecisionSettings({
      numberPrecision: { digits: "30", decimalPlaces: "10", roundingMode: "HALF_EVEN" },
    })).toEqual({ digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" });
  });

  test.each([
    {},
    { numberPrecision: {} },
    { numberPrecision: { digits: "0", decimalPlaces: "4", roundingMode: "HALF_EVEN" } },
    { numberPrecision: { digits: "31", decimalPlaces: "4", roundingMode: "HALF_EVEN" } },
    { numberPrecision: { digits: "16", decimalPlaces: "-1", roundingMode: "HALF_EVEN" } },
    { numberPrecision: { digits: "16", decimalPlaces: "11", roundingMode: "HALF_EVEN" } },
    { numberPrecision: { digits: "16", decimalPlaces: "4", roundingMode: "HALF_UP" } },
    { numberPrecision: { digits: 16, decimalPlaces: "4", roundingMode: "HALF_EVEN" } },
  ])("欠落・範囲外・unknown modeをfail-closedする %#", (response) => {
    expect(() => parseNumberPrecisionSettings(response)).toThrow("SettingsError");
  });
});

describe("numberPrecision digit validation", () => {
  test.each([
    ["0", 0, 0], ["-0.000", 0, 0], ["001.2300", 1, 2],
    [".001", 0, 3], ["1e21", 22, 0], ["1e-10", 0, 10],
  ] as const)("ExactDecimalから %s の桁数を導出する", (text, integerDigits, fractionDigits) => {
    expect(exactDecimalDigitCounts(parseExactDecimal(text)!)).toEqual({ integerDigits, fractionDigits });
  });

  const settings: NumberPrecision[] = [1, 16, 30].flatMap((digits) =>
    [0, 10].flatMap((decimalPlaces) =>
      (["HALF_EVEN", "UP", "DOWN"] as const).map((roundingMode) => ({ digits, decimalPlaces, roundingMode }))
    )
  );
  test.each(settings)("digits/decimalPlaces/mode直積を同じ検証規則へ通す %j", (precision) => {
    const integerBudget = precision.digits - precision.decimalPlaces;
    expect(validateAndNormalizeDmlValue("0", numberField, precision)).toMatchObject(
      integerBudget >= 0 ? { ok: true } : { ok: false, code: "ERR_NUMBER_INTEGER_DIGITS" }
    );
    if (integerBudget >= 1) {
      expect(validateAndNormalizeDmlValue("9".repeat(integerBudget), numberField, precision)).toMatchObject({ ok: true });
      expect(validateAndNormalizeDmlValue("1" + "0".repeat(integerBudget), numberField, precision))
        .toMatchObject({ ok: false, code: "ERR_NUMBER_INTEGER_DIGITS" });
    } else {
      expect(validateAndNormalizeDmlValue("0.1", numberField, precision))
        .toMatchObject({ ok: false, code: "ERR_NUMBER_INTEGER_DIGITS" });
    }
  });

  test("decimalPlaces超過の小数部は検証せず素通しする", () => {
    const precision: NumberPrecision = { digits: 16, decimalPlaces: 4, roundingMode: "HALF_EVEN" };
    expect(validateAndNormalizeDmlValue("0.123456789", numberField, precision)).toMatchObject({ ok: true });
    expect(validateAndNormalizeDmlValue("-1.23456789", numberField, precision)).toMatchObject({ ok: true });
  });

  test("required→finite→min→max→integer順で1フィールド1エラー", () => {
    const field = { ...numberField, required: true, minValue: "-10", maxValue: "10" };
    const precision: NumberPrecision = { digits: 2, decimalPlaces: 1, roundingMode: "DOWN" };
    expect(validateAndNormalizeDmlValue("", field, precision)).toMatchObject({ code: "ERR_REQUIRED" });
    expect(validateAndNormalizeDmlValue("NaN", field, precision)).toMatchObject({ code: "ERR_TYPE_NUMBER" });
    expect(validateAndNormalizeDmlValue("-11.22", field, precision)).toMatchObject({ code: "ERR_RANGE_MIN" });
    expect(validateAndNormalizeDmlValue("11.22", field, precision)).toMatchObject({ code: "ERR_RANGE_MAX" });
    expect(validateAndNormalizeDmlValue("12.34", numberField, precision)).toMatchObject({ code: "ERR_NUMBER_INTEGER_DIGITS" });
    expect(validateAndNormalizeDmlValue("1.23456789", numberField, precision)).toMatchObject({ ok: true });
  });
});
