import { mapRecordOptionValues, mapRecordsOptionValues, type OptionValueTranslate } from "../recordOptionValues";
import type { KintoneRecord } from "../../converter/dmlToKintone";

/** 「ラジオボタン」と「明細の選択」だけを 表示名 → 既定名 に直す変換（ほかは恒等）。 */
const toCanonical: OptionValueTranslate = (code, value) => {
  const table: Record<string, Record<string, string>> = {
    ラジオボタン: { サンプル１: "sample1", サンプル２: "sample2" },
    タグ: { 赤: "red", 青: "blue" },
    選択: { 甲: "a", 乙: "b" },
    ステータス: { みしょり: "未処理" },
  };
  return table[code]?.[value] ?? value;
};

test("B205: トップレベルの文字列を変換する", () => {
  const record: KintoneRecord = {
    $id: { value: "227" },
    ラジオボタン: { value: "サンプル１" },
    担当者: { value: "サンプル１" },   // 変換表に無い項目は触らない
  };
  const mapped = mapRecordOptionValues(record, toCanonical);
  expect(mapped.ラジオボタン.value).toBe("sample1");
  expect(mapped.担当者.value).toBe("サンプル１");
  expect(mapped.$id.value).toBe("227");
});

test("B205: 文字列の配列（CHECK_BOX / MULTI_SELECT）は要素ごとに変換する", () => {
  const record: KintoneRecord = { タグ: { value: ["赤", "青", "緑"] } };
  const mapped = mapRecordOptionValues(record, toCanonical);
  // 変換表に無い「緑」はそのまま通す（言語ごとの表示名を設定する前に入った値）
  expect(mapped.タグ.value).toEqual(["red", "blue", "緑"]);
});

test("B205: サブテーブルの入れ子（value[].value[項目].value）を辿る", () => {
  const record = {
    明細: {
      value: [
        { id: "11", value: { 選択: { value: "甲" }, 金額: { value: "100" } } },
        { id: "12", value: { 選択: { value: "乙" } } },
      ],
    },
  } as unknown as KintoneRecord;
  const mapped = mapRecordOptionValues(record, toCanonical) as unknown as {
    明細: { value: Array<{ id: string; value: Record<string, { value: unknown }> }> };
  };
  expect(mapped.明細.value[0].value.選択.value).toBe("a");
  expect(mapped.明細.value[0].value.金額.value).toBe("100");
  expect(mapped.明細.value[1].value.選択.value).toBe("b");
  // 行 id は保つ
  expect(mapped.明細.value.map((row) => row.id)).toEqual(["11", "12"]);
});

test("B205: サブテーブルの中の文字列の配列も要素ごとに変換する", () => {
  const record = {
    明細: { value: [{ id: "11", value: { タグ: { value: ["赤", "緑"] } } }] },
  } as unknown as KintoneRecord;
  const mapped = mapRecordOptionValues(record, toCanonical) as unknown as {
    明細: { value: Array<{ value: Record<string, { value: unknown }> }> };
  };
  expect(mapped.明細.value[0].value.タグ.value).toEqual(["red", "緑"]);
});

test("B205: ユーザー選択などの { code } の配列は触らない", () => {
  const record: KintoneRecord = {
    作業者: { value: [{ code: "user1" }, { code: "user2" }] },
  };
  const mapped = mapRecordOptionValues(record, toCanonical);
  expect(mapped.作業者.value).toEqual([{ code: "user1" }, { code: "user2" }]);
  expect(mapped).toBe(record);   // 何も変わらないので同じ参照
});

test("B205: 空・null・数値の形は触らない", () => {
  const record = {
    ラジオボタン: { value: null },
    メモ: { value: "" },
    件数: { value: 3 },
  } as unknown as KintoneRecord;
  const mapped = mapRecordOptionValues(record, toCanonical);
  expect(mapped).toBe(record);
});

test("B205: 1 つも変わらなければ同じ参照を返す（レコードと並びの両方）", () => {
  const records: KintoneRecord[] = [
    { $id: { value: "1" }, 担当者: { value: "山田" } },
    { $id: { value: "2" }, 担当者: { value: "佐藤" } },
  ];
  expect(mapRecordsOptionValues(records, toCanonical)).toBe(records);
  expect(mapRecordOptionValues(records[0], toCanonical)).toBe(records[0]);
});

test("B205: 変わった行だけ作り直し、変わらない行は同じ参照を保つ", () => {
  const unchanged: KintoneRecord = { 担当者: { value: "山田" } };
  const changed: KintoneRecord = { ラジオボタン: { value: "サンプル２" } };
  const mapped = mapRecordsOptionValues([unchanged, changed], toCanonical);
  expect(mapped).not.toBe([unchanged, changed]);
  expect(mapped[0]).toBe(unchanged);
  expect(mapped[1]).not.toBe(changed);
  expect(mapped[1].ラジオボタン.value).toBe("sample2");
  // 元のレコードは書き換えない
  expect(changed.ラジオボタン.value).toBe("サンプル２");
});

test("B205: ステータスも同じ関数で変換できる（向きは translate が決める）", () => {
  const toDisplay: OptionValueTranslate = (code, value) =>
    code === "ステータス" && value === "未処理" ? "みしょり" : value;
  const record: KintoneRecord = { ステータス: { value: "未処理" } };
  expect(mapRecordOptionValues(record, toDisplay).ステータス.value).toBe("みしょり");
  expect(mapRecordOptionValues({ ステータス: { value: "みしょり" } }, toCanonical).ステータス.value)
    .toBe("未処理");
});
