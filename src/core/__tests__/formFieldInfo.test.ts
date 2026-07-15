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
