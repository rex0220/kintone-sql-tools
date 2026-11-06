import {
  assertUsableOptionNamePairs,
  buildAppOptionNameMap,
  toCanonicalTranslate,
  toDisplayTranslate,
  type OptionNameSource,
} from "../optionNameMap";
import type { KintoneFieldInfo } from "../../execute";

const canonicalFields: KintoneFieldInfo[] = [
  { code: "ラジオボタン", label: "ラジオボタン", fieldType: "RADIO_BUTTON", optionOrder: { sample1: 0, sample2: 1 } },
  { code: "処理状況", label: "処理状況", fieldType: "DROP_DOWN", optionOrder: { 未処理: 0, 処理済: 1 } },
  { code: "担当者", label: "担当者", fieldType: "SINGLE_LINE_TEXT" },
  { code: "ステータス", label: "ステータス", fieldType: "STATUS" },
];

const userFields: KintoneFieldInfo[] = [
  { code: "ラジオボタン", label: "ラジオボタン", fieldType: "RADIO_BUTTON", optionOrder: { サンプル１: 0, サンプル２: 1 } },
  { code: "処理状況", label: "処理状況", fieldType: "DROP_DOWN", optionOrder: { 未処理: 0, 処理済: 1 } },
  { code: "担当者", label: "担当者", fieldType: "SINGLE_LINE_TEXT" },
  { code: "ステータス", label: "ステータス", fieldType: "STATUS" },
];

const source = (overrides: Partial<OptionNameSource> = {}): OptionNameSource => ({
  appId: 4387,
  fields: userFields,
  statusStates: [
    { canonical: "未処理", display: "みしょり", index: 0 },
    { canonical: "処理中", display: "しょりちゅう", index: 1 },
    { canonical: "完了", display: "かんりょう", index: 2 },
  ],
  ...overrides,
});

test("B205: index で突き合わせて両方向の表を作る", () => {
  const map = buildAppOptionNameMap(4387, canonicalFields, source());
  expect(map.identity).toBe(false);
  const radio = map.fields.get("ラジオボタン")!;
  expect(radio.toDisplay.get("sample1")).toBe("サンプル１");
  expect(radio.toCanonical.get("サンプル２")).toBe("sample2");
  // 言語ごとの表示名が無い項目は恒等のまま入る
  const dropdown = map.fields.get("処理状況")!;
  expect(dropdown.toDisplay.get("未処理")).toBe("未処理");
  // 選択肢ではない項目は表に入らない
  expect(map.fields.has("担当者")).toBe(false);
});

test("B205: ステータスはキー（既定名）と name（表示名）で入る", () => {
  const map = buildAppOptionNameMap(4387, canonicalFields, source());
  const status = map.fields.get("ステータス")!;
  expect(status.toDisplay.get("未処理")).toBe("みしょり");
  expect(status.toCanonical.get("かんりょう")).toBe("完了");
});

test("B205: 言語ごとの表示名が 1 つも無ければ identity（包みを通さない判断に使う）", () => {
  const map = buildAppOptionNameMap(4387, canonicalFields, source({
    fields: canonicalFields,
    statusStates: [{ canonical: "未処理", display: "未処理", index: 0 }],
  }));
  expect(map.identity).toBe(true);
});

test("B205: 変換関数は知らない項目・知らない値をそのまま返す", () => {
  const map = buildAppOptionNameMap(4387, canonicalFields, source());
  const toDisplay = toDisplayTranslate(map);
  const toCanonical = toCanonicalTranslate(map);
  expect(toDisplay("ラジオボタン", "sample1")).toBe("サンプル１");
  expect(toCanonical("ラジオボタン", "サンプル１")).toBe("sample1");
  // 表示名を設定する前に入った値（どちらの表にも無い）はそのまま
  expect(toCanonical("ラジオボタン", "sample9")).toBe("sample9");
  expect(toDisplay("担当者", "sample1")).toBe("sample1");
});

test("B205: 別のアプリの表を返されたら拒む", () => {
  expect(() => buildAppOptionNameMap(4387, canonicalFields, source({ appId: 9999 })))
    .toThrow("option names were fetched for app 9999 but app 4387 was requested.");
});

test("B205: 表示言語の側に選択肢の項目が無ければ拒む（一部だけ返すクライアント）", () => {
  expect(() => buildAppOptionNameMap(4387, canonicalFields, source({
    fields: userFields.filter((field) => field.code !== "ラジオボタン"),
  }))).toThrow("the user-language form does not describe this choice field");
});

test("B205: 選択肢の数が違えば拒む", () => {
  expect(() => buildAppOptionNameMap(4387, canonicalFields, source({
    fields: [
      { code: "ラジオボタン", label: "", fieldType: "RADIO_BUTTON", optionOrder: { サンプル１: 0 } },
      ...userFields.slice(1),
    ],
  }))).toThrow("the mapping cannot be paired by index");
});

test.each([
  ["index の欠落", { サンプル１: 0, サンプル２: 2 }, "is missing option index 1"],
  ["index の重複", { サンプル１: 0, サンプル２: 0 }, "duplicate option index 0"],
  ["index が負", { サンプル１: -1, サンプル２: 1 }, "invalid index"],
])("B205: index が全単射でなければ拒む: %s", (_label, optionOrder, message) => {
  expect(() => buildAppOptionNameMap(4387, canonicalFields, source({
    fields: [
      { code: "ラジオボタン", label: "", fieldType: "RADIO_BUTTON", optionOrder },
      ...userFields.slice(1),
    ],
  }))).toThrow(message);
});

test("B205: 表示名が重複していたら拒む（逆変換が多対一になる）", () => {
  expect(() => assertUsableOptionNamePairs("ラジオボタン", [
    { canonical: "sample1", display: "同じ名前", index: 0 },
    { canonical: "sample2", display: "同じ名前", index: 1 },
  ])).toThrow('display name "同じ名前" is used by more than one option');
});

test("B205: 表示名が空なら拒む", () => {
  expect(() => assertUsableOptionNamePairs("ラジオボタン", [
    { canonical: "sample1", display: "", index: 0 },
  ])).toThrow("has an empty display name");
});

test("B205: 既定名と表示名が交差していたら拒む（交換・循環・identity との衝突）", () => {
  // A → B, B → A の交換
  expect(() => assertUsableOptionNamePairs("選択", [
    { canonical: "a", display: "b", index: 0 },
    { canonical: "b", display: "a", index: 1 },
  ])).toThrow("could not be told apart");
  // A → B, B → C, C → A の循環
  expect(() => assertUsableOptionNamePairs("選択", [
    { canonical: "a", display: "b", index: 0 },
    { canonical: "b", display: "c", index: 1 },
    { canonical: "c", display: "a", index: 2 },
  ])).toThrow("could not be told apart");
  // A → A（恒等）と B → A の衝突は「表示名の重複」で先に止まる
  expect(() => assertUsableOptionNamePairs("選択", [
    { canonical: "a", display: "a", index: 0 },
    { canonical: "b", display: "a", index: 1 },
  ])).toThrow("is used by more than one option");
});

test("B205: 全部が恒等なら交差の検査は通る（表示名を設定していないアプリ）", () => {
  expect(() => assertUsableOptionNamePairs("処理状況", [
    { canonical: "未処理", display: "未処理", index: 0 },
    { canonical: "処理済", display: "処理済", index: 1 },
  ])).not.toThrow();
});
