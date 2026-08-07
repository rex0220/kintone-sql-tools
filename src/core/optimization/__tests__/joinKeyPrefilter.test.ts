import { resolveFieldSemantics } from "../../fieldSemantics";
import {
  JOIN_KEY_EMPTY_IN_FIELD_TYPES,
  planJoinKeyPrefilter,
} from "../joinKeyPrefilter";

const plan = (
  fieldType: string | undefined,
  values: readonly string[] | undefined,
  overrides: Partial<Parameters<typeof planJoinKeyPrefilter>[0]> = {}
) => planJoinKeyPrefilter({
  fieldType,
  values,
  sourceRowCount: values?.length,
  sourceSemantics: fieldType ? resolveFieldSemantics({ fieldType }) : undefined,
  hasEmptyValue: values?.some((value) => value === ""),
  maxInKeys: 300,
  ...overrides,
});

describe("B150 join key prefilter planner", () => {
  test.each(["SINGLE_LINE_TEXT", "LINK", "NUMBER", "DROP_DOWN"])(
    "%s は range より in を優先する",
    (fieldType) => {
      expect(plan(fieldType, ["B", "A", "B", ""])).toEqual({
        kind: "IN",
        values: ["B", "A", ""],
        relation: "exact",
      });
    }
  );

  test.each(["DATE", "TIME", "DATETIME", "CREATED_TIME", "UPDATED_TIME"])(
    "%s は canonical 値から共有比較器で range を作る",
    (fieldType) => {
      const values = fieldType === "DATE"
        ? ["2025-08-06", "2025-08-04", "2025-08-06"]
        : fieldType === "TIME"
          ? ["17:30", "09:00", "12:00"]
          : ["2025-08-06T23:59:59Z", "2025-08-04T00:00:00Z"];
      expect(plan(fieldType, values)).toEqual({
        kind: "RANGE",
        min: values[1],
        max: values[0],
        relation: "superset",
      });
    }
  );

  test("min=max でも二境界 range のままにする", () => {
    expect(plan("DATE", ["2025-08-04", "2025-08-04"])).toEqual({
      kind: "RANGE",
      min: "2025-08-04",
      max: "2025-08-04",
      relation: "superset",
    });
  });

  test.each([
    [undefined, ["x"], "JOIN_KEY_FIELD_TYPE_UNRESOLVED"],
    ["MULTI_LINE_TEXT", ["x"], "JOIN_KEY_OPERATOR_UNAVAILABLE"],
    ["DATE", ["", "2025-08-04"], "JOIN_KEY_EMPTY_VALUE"],
    ["DATE", ["2025-8-4"], "JOIN_KEY_NON_CANONICAL_VALUE"],
  ] as const)("fallback reason %s / %s", (fieldType, values, reason) => {
    expect(plan(fieldType, values)).toEqual({ kind: "FALLBACK", reason });
  });

  test("source semantics 不明は逐語 reason で fallback する", () => {
    expect(plan("DATE", ["2025-08-04"], { sourceSemantics: undefined })).toEqual({
      kind: "FALLBACK",
      reason: "JOIN_KEY_SEMANTICS_UNRESOLVED",
    });
  });

  test("in は300件まで、301件で逐語 reason、range は301件でも二境界", () => {
    const values300 = Array.from({ length: 300 }, (_, index) => `K${index}`);
    expect(plan("SINGLE_LINE_TEXT", values300)).toMatchObject({ kind: "IN" });
    expect(plan("SINGLE_LINE_TEXT", [...values300, "K300"])).toEqual({
      kind: "FALLBACK",
      reason: "JOIN_KEY_LIMIT_EXCEEDED",
    });
    const dates = Array.from({ length: 301 }, (_, index) => {
      const day = (index % 28) + 1;
      return `2025-${String(Math.floor(index / 28) % 12 + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    });
    expect(plan("DATE", dates)).toMatchObject({ kind: "RANGE" });
  });

  test("実値未解決の range 候補を区別する", () => {
    expect(plan("DATE", undefined, { sourceRowCount: undefined })).toEqual({
      kind: "RANGE_CANDIDATE",
      relation: "superset",
      reason: "JOIN_KEY_VALUES_RUNTIME",
    });
  });
});

describe("B153 empty JOIN key policy", () => {
  test("in (\"\") の受理確認済み型を pure policy として固定する", () => {
    expect([...JOIN_KEY_EMPTY_IN_FIELD_TYPES]).toEqual([
      "SINGLE_LINE_TEXT",
      "LINK",
      "NUMBER",
      "CALC",
      "DROP_DOWN",
      "RADIO_BUTTON",
      "CHECK_BOX",
      "MULTI_SELECT",
      "STATUS",
    ]);
  });

  test.each([...JOIN_KEY_EMPTY_IN_FIELD_TYPES])(
    "%s は空値を重複除去して in に残す",
    (fieldType) => {
      expect(plan(fieldType, ["", "A", ""])).toEqual({
        kind: "IN",
        values: ["", "A"],
        relation: "exact",
      });
      expect(plan(fieldType, [""])).toEqual({
        kind: "IN",
        values: [""],
        relation: "exact",
      });
    }
  );

  test.each(["RECORD_NUMBER", "__ID__", "USER_SELECT", "ORGANIZATION_SELECT", "GROUP_SELECT"])(
    "%s は空値を含むと全件取得へ fallback する",
    (fieldType) => {
      expect(plan(fieldType, ["", "A"])).toEqual({
        kind: "FALLBACK",
        reason: "JOIN_KEY_EMPTY_VALUE",
      });
    }
  );
});
