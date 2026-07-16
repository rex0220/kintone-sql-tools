import { flattenFormFieldProperties } from "../formFieldInfo";

test("TABLE.fields を再帰展開し、子フィールドの型・選択肢を保持する", () => {
  const fields = flattenFormFieldProperties({
    親選択: {
      code: "親選択",
      label: "親選択",
      type: "CHECK_BOX",
      options: { A: { index: "0" }, B: { index: 1 } },
    },
    明細: {
      code: "明細",
      label: "明細",
      type: "SUBTABLE",
      fields: {
        子選択: {
          code: "子選択",
          label: "子選択",
          type: "MULTI_SELECT",
          options: { X: { index: "2" } },
        },
        入れ子: {
          code: "入れ子",
          label: "入れ子",
          type: "SUBTABLE",
          fields: {
            深い数値: { code: "深い数値", label: "深い数値", type: "NUMBER" },
          },
        },
      },
    },
  });

  expect(fields.map((field) => field.code)).toEqual([
    "親選択",
    "明細",
    "子選択",
    "入れ子",
    "深い数値",
  ]);
  expect(fields.find((field) => field.code === "親選択")?.optionOrder).toEqual({ A: 0, B: 1 });
  expect(fields.find((field) => field.code === "子選択")?.fieldType).toBe("MULTI_SELECT");
  expect(fields.find((field) => field.code === "深い数値")?.sortKind).toBe("number");
});

test("VALIDATE ONLY用のフォーム制約メタデータを保持する", () => {
  const [field] = flattenFormFieldProperties({
    code: {
      code: "code", label: "コード", type: "SINGLE_LINE_TEXT", required: true,
      minLength: "2", maxLength: "10", defaultValue: "AA",
    },
  });
  expect(field).toMatchObject({
    required: true, minLength: "2", maxLength: "10", defaultValue: "AA",
  });
});

test("未設定制約は空文字ではなく undefined に正規化する", () => {
  const [field] = flattenFormFieldProperties({
    title: {
      code: "title", label: "タイトル", type: "SINGLE_LINE_TEXT",
      minLength: "", maxLength: "", minValue: "", maxValue: "",
    },
  });
  expect(field.minLength).toBeUndefined();
  expect(field.maxLength).toBeUndefined();
  expect(field.minValue).toBeUndefined();
  expect(field.maxValue).toBeUndefined();
});

test("サブテーブルの子フィールドに inSubtable マークを付ける", () => {
  const fields = flattenFormFieldProperties({
    テーブル: {
      code: "テーブル",
      label: "テーブル",
      type: "SUBTABLE",
      fields: {
        数値T1: {
          code: "数値T1",
          label: "数値T1",
          type: "NUMBER",
        },
      },
    },
  });
  expect(fields.find((field) => field.code === "数値T1")?.inSubtable).toBe(true);
});

test("ルックアップコピー先を書込不可として展開する", () => {
  const fields = flattenFormFieldProperties({
    customer: {
      code: "customer", label: "customer", type: "SINGLE_LINE_TEXT",
      lookup: { fieldMappings: [{ field: "customerName" }] },
    },
    customerName: { code: "customerName", label: "customerName", type: "SINGLE_LINE_TEXT" },
  });
  expect(fields.find((f) => f.code === "customer")?.writable).toBe(true);
  expect(fields.find((f) => f.code === "customerName")?.writable).toBe(false);
});
