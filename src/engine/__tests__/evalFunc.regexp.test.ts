import { evalStringFunc } from "../evalFunc";
import type { StringFuncArg, StringFuncName } from "../../types/ast";

const arg = (value: string): StringFuncArg => ({ type: "STRING", value });

function evaluate(func: StringFuncName, ...values: string[]): string {
  return evalStringFunc({ type: "STRING_FUNC", func, args: values.map(arg) }, {});
}

test("B20 正規表現3関数の基本動作・空文字・全件置換", () => {
  expect(evaluate("REGEXP_LIKE", "103-6027", "^[0-9]{3}-[0-9]{4}$")).toBe("1");
  expect(evaluate("REGEXP_LIKE", "abc-defg", "^[0-9]{3}-[0-9]{4}$")).toBe("0");
  expect(evaluate("REGEXP_REPLACE", "a-b-c", "-", "/")).toBe("a/b/c");
  expect(evaluate("REGEXP_SUBSTR", "受付 AB-123456 完了", "[A-Z]{2}-[0-9]{6}")).toBe("AB-123456");
  expect(evaluate("REGEXP_SUBSTR", "none", "[0-9]+")).toBe("");
  expect(evaluate("REGEXP_LIKE", "", "^$")).toBe("1");
  expect(evaluate("REGEXP_LIKE", "", "a")).toBe("0");
  expect(evaluate("REGEXP_LIKE", "anything", "")).toBe("1");
  expect(evaluate("REGEXP_REPLACE", "", "a", "b")).toBe("");
});

test("B20 i/m/s を受理し u を強制する", () => {
  expect(evaluate("REGEXP_LIKE", "ABC", "^abc$", "i")).toBe("1");
  expect(evaluate("REGEXP_LIKE", "x\nabc\ny", "^abc$", "m")).toBe("1");
  expect(evaluate("REGEXP_LIKE", "a\nb", "^a.b$", "s")).toBe("1");
  expect(evaluate("REGEXP_LIKE", "😀", "^.$")).toBe("1");
});

test.each(["v", "g", "y", "d", "u", "x", "ii"])(
  "B20 不許可または重複フラグ %s は ArgumentError",
  (flags) => expect(() => evaluate("REGEXP_LIKE", "x", "x", flags)).toThrow(/ArgumentError/)
);

test.each([
  ["REGEXP_LIKE", ["x"]],
  ["REGEXP_LIKE", ["x", "x", "i", "extra"]],
  ["REGEXP_REPLACE", ["x", "x"]],
  ["REGEXP_REPLACE", ["x", "x", "y", "i", "1", "extra"]],
  ["REGEXP_SUBSTR", ["x"]],
  ["REGEXP_SUBSTR", ["x", "x", "i", "extra"]],
] as [StringFuncName, string[]][])("B20 %s arity 違反は ArgumentError", (func, args) => {
  expect(() => evaluate(func, ...args)).toThrow(/ArgumentError/);
});

test("B20 不正パターンは ArgumentError に包み直す", () => {
  expect(() => evaluate("REGEXP_LIKE", "x", "[")).toThrow(/ArgumentError: invalid regular expression/);
});

test("B20 実需パターンと置換参照", () => {
  expect(evaluate("REGEXP_LIKE", "03-1234-5678", "^0[0-9-]+$")).toBe("1");
  expect(evaluate("REGEXP_REPLACE", "03-(1234)-5678", "[^0-9]", "")).toBe("0312345678");
  expect(evaluate("REGEXP_SUBSTR", "期間 2026-07-01〜2026-07-31", "[0-9]{4}-[0-9]{2}-[0-9]{2}")).toBe("2026-07-01");
  expect(evaluate("REGEXP_REPLACE", "A   B\tC", "\\s+", " ")).toBe("A B C");
  expect(evaluate("REGEXP_REPLACE", "0312345678", "^(0[0-9])([0-9]{4})([0-9]{4})$", "$1-$2-$3"))
    .toBe("03-1234-5678");
  expect(evaluate("REGEXP_REPLACE", "abc", "b", "[$&]$$")).toBe("a[b]$c");
});

test("B20 置換文字列の前後挿入参照は拒否する", () => {
  expect(() => evaluate("REGEXP_REPLACE", "abc", "b", "$`")).toThrow(/ArgumentError/);
  expect(() => evaluate("REGEXP_REPLACE", "abc", "b", "$'")).toThrow(/ArgumentError/);
});

test("B36 occurrence の省略・0 は全置換、N は N 番目だけを置換する", () => {
  expect(evaluate("REGEXP_REPLACE", "a-a-a", "a", "x")).toBe("x-x-x");
  expect(evaluate("REGEXP_REPLACE", "a-a-a", "a", "x", "", "0")).toBe("x-x-x");
  expect(evaluate("REGEXP_REPLACE", "a-a-a", "a", "x", "", "1")).toBe("x-a-a");
  expect(evaluate("REGEXP_REPLACE", "a-a-a", "a", "x", "", "2")).toBe("a-x-a");
  expect(evaluate("REGEXP_REPLACE", "a-a", "a", "x", "", "5")).toBe("a-a");
});

test("B36 occurrence は flags と併用できる", () => {
  expect(evaluate("REGEXP_REPLACE", "aAbA", "a", "_", "i", "2")).toBe("a_bA");
});

test("B36 N 番目置換でも JavaScript 標準の置換参照を展開する", () => {
  expect(evaluate("REGEXP_REPLACE", "12-34", "([0-9]+)", "[$1]", "", "1")).toBe("[12]-34");
  expect(evaluate("REGEXP_REPLACE", "ab-ab", "(a)(b)", "$$:$&:$2$1", "", "2"))
    .toBe("ab-$:ab:ba");
  expect(evaluate("REGEXP_REPLACE", "ab-ab", "(?<first>a)(?<second>b)", "$<second>$<first>", "", "2"))
    .toBe("ab-ba");
});

test("B36 ゼロ幅一致でも停止し、指定した一致だけを置換する", () => {
  expect(evaluate("REGEXP_REPLACE", "abc", "x*", "_", "", "1")).toBe("_abc");
  expect(evaluate("REGEXP_REPLACE", "abc", "x*", "_", "", "2")).toBe("a_bc");
});

test.each(["-1", "1.5", "abc", ""])(
  "B36 occurrence=%p は ArgumentError",
  (occurrence) => expect(() => evaluate(
    "REGEXP_REPLACE", "abc", "a", "x", "", occurrence
  )).toThrow("ArgumentError: REGEXP_REPLACE occurrence must be a non-negative integer.")
);

test("B36 occurrence はフィールドと式を行ごとに実行時評価する", () => {
  const baseArgs: StringFuncArg[] = [arg("a-a-a"), arg("a"), arg("x"), arg("")];
  expect(evalStringFunc({
    type: "STRING_FUNC",
    func: "REGEXP_REPLACE",
    args: [...baseArgs, { type: "FIELD_REF", field: "occurrence" }],
  }, { occurrence: "2" })).toBe("a-x-a");
  expect(evalStringFunc({
    type: "STRING_FUNC",
    func: "REGEXP_REPLACE",
    args: [...baseArgs, {
      type: "ARITH",
      op: "+",
      left: { type: "NUMBER", value: 1, raw: "1" },
      right: { type: "NUMBER", value: 1, raw: "1" },
    }],
  }, {})).toBe("a-x-a");
});
