import { compareDecimal, validateAndNormalizeDmlValue } from "../dmlValidation";
import { validateDmlCandidates } from "../dmlValidationCandidates";

const field = (fieldType: string, extra: Record<string, unknown> = {}) => ({
  code: "f", label: "f", fieldType, ...extra,
});

test("required / number range / length / choice を安定codeで返す", () => {
  expect(validateAndNormalizeDmlValue("", field("SINGLE_LINE_TEXT", { required: true }))).toMatchObject({ ok: false, code: "ERR_REQUIRED" });
  expect(validateAndNormalizeDmlValue("x", field("NUMBER"))).toMatchObject({ ok: false, code: "ERR_TYPE_NUMBER" });
  expect(validateAndNormalizeDmlValue("10.01", field("NUMBER", { maxValue: "10" }))).toMatchObject({ ok: false, code: "ERR_RANGE_MAX" });
  expect(validateAndNormalizeDmlValue("😀😀", field("SINGLE_LINE_TEXT", { maxLength: "1" }))).toMatchObject({ ok: false, code: "ERR_LENGTH_MAX" });
  expect(validateAndNormalizeDmlValue("X", field("DROP_DOWN", { optionOrder: { A: 0 } }))).toMatchObject({ ok: false, code: "ERR_CHOICE_INVALID" });
});

test("DATE/TIME/DATETIMEの実在性を検証する", () => {
  expect(validateAndNormalizeDmlValue("2025-02-29", field("DATE"))).toMatchObject({ ok: false, code: "ERR_TYPE_DATE" });
  expect(validateAndNormalizeDmlValue("23:59:59", field("TIME"))).toMatchObject({ ok: true });
  expect(validateAndNormalizeDmlValue("2024-02-29T12:00:00Z", field("DATETIME"))).toMatchObject({ ok: true });
  expect(validateAndNormalizeDmlValue("2025-02-29 12:00", field("DATETIME"))).toMatchObject({ ok: false, code: "ERR_TYPE_DATE" });
});

test("10進文字列を浮動小数化せず比較する", () => {
  expect(compareDecimal("9007199254740993", "9007199254740992")).toBe(1);
  expect(compareDecimal("-1.20", "-1.2")).toBe(0);
});

test("create バリデーションではサブテーブル子フィールドを必須/既定値走査から除外する", () => {
  const candidates = [{
    rowNumber: 1,
    operation: "INSERT" as const,
    mode: "create" as const,
    payload: new Map<string, unknown>([["title", "abc"]]),
    preErrors: [],
  }];
  const fieldInfos = [
    { code: "title", label: "タイトル", fieldType: "SINGLE_LINE_TEXT", required: true },
    { code: "子文字列", label: "子文字列", fieldType: "SINGLE_LINE_TEXT", required: true, inSubtable: true },
  ];
  const result = validateDmlCandidates(candidates, "INSERT", ["title"], ["title"], fieldInfos, 1);
  expect(result.errors).toHaveLength(0);
  expect(result.invalidRows).toBe(0);
});
