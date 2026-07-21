import { compareDecimal, validateAndNormalizeDmlValue } from "../dmlValidation";
import { validateDmlCandidates } from "../dmlValidationCandidates";

const field = (fieldType: string, extra: Record<string, unknown> = {}) => ({
  code: "f", label: "f", fieldType, ...extra,
});
const sqlString = (value: string) => ({ type: "STRING" as const, value });

test("required / number range / length / choice を安定codeで返す", () => {
  expect(validateAndNormalizeDmlValue("", field("SINGLE_LINE_TEXT", { required: true }))).toMatchObject({ ok: false, code: "ERR_REQUIRED" });
  expect(validateAndNormalizeDmlValue("x", field("NUMBER"))).toMatchObject({ ok: false, code: "ERR_TYPE_NUMBER" });
  expect(validateAndNormalizeDmlValue("10.01", field("NUMBER", { maxValue: "10" }))).toMatchObject({ ok: false, code: "ERR_RANGE_MAX" });
  expect(validateAndNormalizeDmlValue("😀😀", field("SINGLE_LINE_TEXT", { maxLength: "1" }))).toMatchObject({ ok: false, code: "ERR_LENGTH_MAX" });
  expect(validateAndNormalizeDmlValue("X", field("DROP_DOWN", { optionOrder: { A: 0 } }))).toMatchObject({ ok: false, code: "ERR_CHOICE_INVALID" });
});

test("B46: 空（未選択）は選択肢照合の対象外（kintone は空の DROP_DOWN を受理・RADIO の空指定もエラーにしない実機パリティ）", () => {
  expect(validateAndNormalizeDmlValue("", field("DROP_DOWN", { optionOrder: { A: 0 } }))).toMatchObject({ ok: true });
  expect(validateAndNormalizeDmlValue("", field("RADIO_BUTTON", { optionOrder: { A: 0 } }))).toMatchObject({ ok: true });
  expect(validateAndNormalizeDmlValue([], field("CHECK_BOX", { optionOrder: { A: 0 } }))).toMatchObject({ ok: true });
  // 必須性は ERR_REQUIRED が担う（選択肢エラーへ化けない）
  expect(validateAndNormalizeDmlValue("", field("DROP_DOWN", { required: true, optionOrder: { A: 0 } })))
    .toMatchObject({ ok: false, code: "ERR_REQUIRED" });
  // 非空の定義外は引き続き拒否
  expect(validateAndNormalizeDmlValue(["A", "X"], field("MULTI_SELECT", { optionOrder: { A: 0 } })))
    .toMatchObject({ ok: false, code: "ERR_CHOICE_INVALID" });
});

test("DATE/TIME/DATETIMEの実在性を検証する", () => {
  expect(validateAndNormalizeDmlValue("2025-02-29", field("DATE"))).toMatchObject({ ok: false, code: "ERR_TYPE_DATE" });
  expect(validateAndNormalizeDmlValue("23:59:59", field("TIME"))).toMatchObject({ ok: true });
  expect(validateAndNormalizeDmlValue("2024-02-29T12:00:00Z", field("DATETIME"))).toMatchObject({ ok: true });
  expect(validateAndNormalizeDmlValue("2025-02-29 12:00", field("DATETIME"))).toMatchObject({ ok: false, code: "ERR_TYPE_DATE" });
});

test.each([
  "2026-07-16T11:21:25.1Z",
  "2026-07-16T11:21:25.174Z",
  "2026-07-16T11:21:25.123456Z",
  "2026-07-16T11:21:25.174+09:00",
  "2026-07-16T11:21Z",
  "2026-07-16T11:21:25Z",
  "2026-07-16 11:21:25",
  "2026/07/16 11:21:25",
])("DATETIMEの有効形式を受理する: %s", (value) => {
  expect(validateAndNormalizeDmlValue(sqlString(value), field("DATETIME"))).toMatchObject({ ok: true });
});

test.each([
  "2026-13-01T00:00Z",
  "2026-07-16T25:00Z",
  "2026-07-16T99:99:99.1Z",
  "abc",
])("DATETIMEの無効形式を拒否する: %s", (value) => {
  expect(validateAndNormalizeDmlValue(sqlString(value), field("DATETIME"))).toMatchObject({
    ok: false,
    code: "ERR_TYPE_DATE",
  });
});

test("DATE/TIMEでは小数秒の受理範囲を広げない", () => {
  expect(validateAndNormalizeDmlValue("2026-07-16", field("DATE"))).toMatchObject({ ok: true });
  expect(validateAndNormalizeDmlValue("11:21:25", field("TIME"))).toMatchObject({ ok: true });
  expect(validateAndNormalizeDmlValue("11:21:25.174", field("TIME"))).toMatchObject({
    ok: false,
    code: "ERR_TYPE_DATE",
  });
});

test("10進文字列を浮動小数化せず比較する", () => {
  expect(compareDecimal("9007199254740993", "9007199254740992")).toBe(1);
  expect(compareDecimal("-1.20", "-1.2")).toBe(0);
});

test("UTF-16 code units を長さ制約に使い、空文字でも minLength を適用する", () => {
  expect(validateAndNormalizeDmlValue("𩸽𩸽𩸽𩸽𩸽𩸽", field("SINGLE_LINE_TEXT", { maxLength: "10" }))).toMatchObject({ ok: false, code: "ERR_LENGTH_MAX" });
  expect(validateAndNormalizeDmlValue("𩸽𩸽", field("SINGLE_LINE_TEXT", { minLength: "3" }))).toMatchObject({ ok: true });
  expect(validateAndNormalizeDmlValue("", field("SINGLE_LINE_TEXT", { minLength: "3" }))).toMatchObject({ ok: false, code: "ERR_LENGTH_MIN" });
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

test("create バリデーションで未指定フィールドの空値にも minLength を適用する", () => {
  const candidates = [{
    rowNumber: 1,
    operation: "INSERT" as const,
    mode: "create" as const,
    payload: new Map<string, unknown>([["title", "abc"]]),
    preErrors: [],
  }];
  const fieldInfos = [
    { code: "title", label: "タイトル", fieldType: "SINGLE_LINE_TEXT" },
    { code: "memo", label: "メモ", fieldType: "SINGLE_LINE_TEXT", minLength: "3" },
  ];
  const result = validateDmlCandidates(candidates, "INSERT", ["title"], ["title"], fieldInfos, 1);
  expect(result.errors).toEqual([expect.objectContaining({ $err_field: "memo", $err_code: "ERR_LENGTH_MIN" })]);
  expect(result.invalidRows).toBe(1);
});

test("既存 DML validation は payload-only のままで非 payload post-image 違反を見ない", () => {
  const fieldInfos = [
    { code: "payload", label: "payload", fieldType: "SINGLE_LINE_TEXT" },
    { code: "outsidePayload", label: "outsidePayload", fieldType: "SINGLE_LINE_TEXT", required: true },
  ];
  const result = validateDmlCandidates([{
    rowNumber: 1,
    operation: "UPDATE",
    mode: "update",
    payload: new Map([["payload", "ok"]]),
    preErrors: [],
  }], "UPDATE", ["payload"], ["payload", "outsidePayload"], fieldInfos, 1);
  expect(result.errors).toEqual([]);
  expect(result.invalidRows).toBe(0);
});

test("B43 Phase 2: update-mode は post-image 境界向けに built-in を抑止して pre/CHECK と sparse record を分離できる", () => {
  const candidate = {
    rowNumber: 1,
    operation: "UPDATE" as const,
    mode: "update" as const,
    payload: new Map<string, unknown>([["payload", "11"]]),
    preErrors: [{ field: "payload", code: "ERR_KEY_EMPTY" as const, message: "pre" }],
    record: {},
    evaluationRow: { payload: "11" },
  };
  const result = validateDmlCandidates(
    [candidate], "UPDATE", ["payload"], ["payload"],
    [{ code: "payload", label: "payload", fieldType: "NUMBER", maxValue: "10" }],
    1, undefined,
    [{ rules: [{ condition: { type: "BINARY", left: { type: "FIELD", field: "payload", tableAlias: null }, op: ">", right: { type: "NUMBER", value: 0, raw: "0" } }, message: { type: "STRING", value: "check" } }] }],
    true, true, { validateUpdateBuiltIns: false }
  );

  expect(result.candidateResults[0].preErrors.map((row) => row.$err_message)).toEqual(["pre"]);
  expect(result.candidateResults[0].builtInErrors).toEqual([]);
  expect(result.candidateResults[0].checkErrors.map((row) => row.$err_message)).toEqual(["check"]);
  expect(candidate.record).toEqual({ payload: { value: "11" } });
});

test("B43 Phase 2: create-mode の required/default/type/range/choice/precision code・message は不変", () => {
  const result = validateDmlCandidates([{
    rowNumber: 1,
    operation: "INSERT",
    mode: "create",
    payload: new Map<string, unknown>([
      ["required", ""], ["typed", "x"], ["ranged", "11"], ["choice", "X"], ["precise", "123"],
    ]),
    preErrors: [],
  }], "INSERT", ["required", "typed", "ranged", "choice", "precise"],
  ["required", "typed", "ranged", "choice", "precise"], [
    { code: "required", label: "required", fieldType: "SINGLE_LINE_TEXT", required: true },
    { code: "typed", label: "typed", fieldType: "NUMBER" },
    { code: "ranged", label: "ranged", fieldType: "NUMBER", maxValue: "10" },
    { code: "choice", label: "choice", fieldType: "DROP_DOWN", optionOrder: { A: 0 } },
    { code: "precise", label: "precise", fieldType: "NUMBER" },
    { code: "defaulted", label: "defaulted", fieldType: "NUMBER", defaultValue: "x" },
  ], 2, { digits: 2, decimalPlaces: 0, roundingMode: "HALF_EVEN" });

  expect(result.errors.map((row) => [row.$err_field, row.$err_code, row.$err_message])).toEqual([
    ["required", "ERR_REQUIRED", "required は必須です"],
    ["typed", "ERR_TYPE_NUMBER", "typed は数値で指定してください"],
    ["ranged", "ERR_RANGE_MAX", "ranged は 10 以下で指定してください"],
    ["choice", "ERR_CHOICE_INVALID", "choice に定義外の選択肢があります"],
    ["precise", "ERR_NUMBER_INTEGER_DIGITS", "precise の整数部は 3 桁です。許容は 2 桁までです (digits=2, decimalPlaces=0)"],
    ["defaulted", "ERR_TYPE_NUMBER", "既定値: defaulted は数値で指定してください"],
  ]);
});
