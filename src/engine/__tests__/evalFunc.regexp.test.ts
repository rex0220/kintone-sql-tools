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
  ["REGEXP_REPLACE", ["x", "x", "y", "i", "extra"]],
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
