import { evalStringFunc } from "../evalFunc";
import type { StringFuncArg, StringFuncName } from "../../types/ast";

const FROM = "啞焰鷗摑麴噓俠頰軀俱繫姸鹼嚙攢𠮟繡蔣醬蟬搔瘦驒簞塡顚禱瀆吞囊剝潑醱屛幷麵萊屢沪蠟";
const TO = "唖焔鴎掴麹嘘侠頬躯倶繋妍鹸噛攅叱繍蒋醤蝉掻痩騨箪填顛祷涜呑嚢剥溌醗屏并麺莱屡濾蝋";

const arg = (value: string): StringFuncArg => ({ type: "STRING", value });

function evaluate(func: StringFuncName, ...values: string[]): string {
  return evalStringFunc({ type: "STRING_FUNC", func, args: values.map(arg) }, {});
}

test.each([
  ["日本語", "3", "3"],
  ["𠮟", "1", "2"],
  ["𠮷野家", "3", "4"],
  ["😀", "1", "2"],
  ["", "0", "0"],
  ["\ud83d", "1", "1"],
  ["葛󠄀城", "3", "4"],
  ["👨‍👩‍👧‍👦", "7", "11"],
])("B23 LENGTH_CHAR(%p) はコードポイント数、LENGTH はコードユニット数", (value, points, units) => {
  expect(evaluate("LENGTH_CHAR", value)).toBe(points);
  expect(evaluate("LENGTH", value)).toBe(units);
});

test.each([
  ["éé", 0],
  ["ΑΒ", 0],
  ["йц", 0],
  ["😀", 1],
  ["𩸽", 1],
  ["Aあ😀", 1],
  ["\ud83d", 0],
])("B23 LENGTH - LENGTH_CHAR はサロゲートペア数になる: %p", (value, pairs) => {
  const units = Number(evaluate("LENGTH", value));
  const points = Number(evaluate("LENGTH_CHAR", value));
  expect(units - points).toBe(pairs);
});

test("B23 LENGTH_CHAR は arity 1 固定", () => {
  expect(() => evaluate("LENGTH_CHAR")).toThrow("ArgumentError: LENGTH_CHAR expects 1 argument(s).");
  expect(() => evaluate("LENGTH_CHAR", "a", "b")).toThrow("ArgumentError: LENGTH_CHAR expects 1 argument(s).");
});

test("B24 Shift_JIS 非対応漢字の40字表をコードポイント位置どおり全数変換する", () => {
  expect([...FROM]).toHaveLength(40);
  expect([...TO]).toHaveLength(40);
  [...FROM].forEach((ch, index) => {
    expect(evaluate("TRANSLATE", ch, FROM, TO)).toBe([...TO][index]);
  });
  expect(evaluate("TRANSLATE", "𠮟責と嚙み合わせ", FROM, TO)).toBe("叱責と噛み合わせ");
  expect(evaluate("TRANSLATE", "屢々沪過して蠟燭", FROM, TO)).toBe("屡々濾過して蝋燭");
});

test("B24 TRANSLATE はコードポイント整列・重複先頭優先・非対象素通し・空文字を満たす", () => {
  expect(evaluate("TRANSLATE", "x", "𠮟", "叱")).toBe("x");
  expect(evaluate("TRANSLATE", "𠮟", "𠮟", "叱")).toBe("叱");
  expect(evaluate("TRANSLATE", "a", "aa", "XY")).toBe("X");
  expect(evaluate("TRANSLATE", "普通の日本語", FROM, TO)).toBe("普通の日本語");
  expect(evaluate("TRANSLATE", "", FROM, TO)).toBe("");
  expect(evaluate("TRANSLATE", "abc", "", "")).toBe("abc");
});

test("B24 TRANSLATE は入力中のペアを割らず、既存の孤立サロゲートを保持する", () => {
  const paired = "A😀𠮟B";
  expect(evaluate("TRANSLATE", paired, "AB", "XY")).toBe("X😀𠮟Y");
  const isolated = "A\ud83dB\ude00C";
  expect(evaluate("TRANSLATE", isolated, "ABC", "XYZ")).toBe("X\ud83dY\ude00Z");
});

test("B24 TRANSLATE の長さ不一致はコードポイント数を示す ArgumentError", () => {
  expect(() => evaluate("TRANSLATE", "x", "abc", "AB")).toThrow(
    "ArgumentError: TRANSLATE の from と to は同じ文字数である必要があります（from=3, to=2）"
  );
  expect(() => evaluate("TRANSLATE", "x", "𠮟a", "叱")).toThrow(
    "ArgumentError: TRANSLATE の from と to は同じ文字数である必要があります（from=2, to=1）"
  );
});

test("B24 TRANSLATE は arity 3 固定", () => {
  expect(() => evaluate("TRANSLATE", "x", "x")).toThrow("ArgumentError: TRANSLATE expects 3 argument(s).");
  expect(() => evaluate("TRANSLATE", "x", "x", "X", "extra")).toThrow("ArgumentError: TRANSLATE expects 3 argument(s).");
});
