import { flattenFormFieldProperties } from "../core/formFieldInfo";
import { execute, type KintoneClient, type KintoneFieldInfo, type SelectResult } from "../execute";
import { runQuery } from "../engine-library";
import type { ReadonlyKintoneClient } from "../engine-library/publicTypes";

const describeColumns = [
  "フィールドコード",
  "ラベル",
  "タイプ",
  // B145 で追加（v3.56.0）。明細項目ならサブテーブル名、親項目なら空文字。
  "サブテーブル",
  "ルックアップ",
  "コピー元",
  "重複禁止",
  "計算式",
];

function makeClient(fields: KintoneFieldInfo[]): KintoneClient {
  return {
    async getRecords() { return { records: [] }; },
    async openCursor() { throw new Error("unexpected cursor call"); },
    async postRecords() { throw new Error("unexpected write call"); },
    async putRecords() { throw new Error("unexpected write call"); },
    async deleteRecords() { throw new Error("unexpected write call"); },
    async getApps() { return []; },
    async getFields() { return fields; },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" };
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
  };
}

test("B130: フォーム定義から値の由来4フラグをトップレベルとサブテーブル子へ導出する", () => {
  const fields = flattenFormFieldProperties({
    製品名: {
      code: "製品名",
      label: "製品名",
      type: "SINGLE_LINE_TEXT",
      lookup: { fieldMappings: [{ field: "仕入先" }, { field: "明細仕入先" }] },
    },
    権限なしルックアップ: {
      code: "権限なしルックアップ",
      label: "権限なしルックアップ",
      type: "SINGLE_LINE_TEXT",
      lookup: null,
    },
    仕入先: {
      code: "仕入先",
      label: "仕入先",
      type: "SINGLE_LINE_TEXT",
      expression: "",
    },
    製品名_マスタ: {
      code: "製品名_マスタ",
      label: "製品名",
      type: "SINGLE_LINE_TEXT",
      unique: true,
    },
    製品番号: {
      code: "製品番号",
      label: "製品番号",
      type: "SINGLE_LINE_TEXT",
    },
    個数_在庫計算用: {
      code: "個数_在庫計算用",
      label: "個数_在庫計算用",
      type: "CALC",
      expression: "個数 * 係数",
    },
    明細: {
      code: "明細",
      label: "明細",
      type: "SUBTABLE",
      fields: {
        明細仕入先: {
          code: "明細仕入先",
          label: "明細仕入先",
          type: "SINGLE_LINE_TEXT",
        },
        明細計算: {
          code: "明細計算",
          label: "明細計算",
          type: "SINGLE_LINE_TEXT",
          expression: "明細仕入先 & '-x'",
        },
      },
    },
    レコード番号: {
      code: "レコード番号",
      label: "レコード番号",
      type: "RECORD_NUMBER",
    },
  });
  const byCode = new Map(fields.map((field) => [field.code, field]));

  expect(byCode.get("製品名")).toMatchObject({
    hasLookup: true,
    isLookupCopyTarget: false,
    isUnique: false,
    isCalculated: false,
  });
  expect(byCode.get("権限なしルックアップ")?.hasLookup).toBe(true);
  expect(byCode.get("仕入先")).toMatchObject({
    hasLookup: false,
    isLookupCopyTarget: true,
    isUnique: false,
    isCalculated: false,
  });
  expect(byCode.get("製品名_マスタ")?.isUnique).toBe(true);
  expect(byCode.get("製品番号")?.isUnique).toBe(false);
  expect(byCode.get("個数_在庫計算用")?.isCalculated).toBe(true);
  expect(byCode.get("明細仕入先")).toMatchObject({
    inSubtable: true,
    isLookupCopyTarget: true,
  });
  expect(byCode.get("明細計算")).toMatchObject({
    inSubtable: true,
    isCalculated: true,
  });
  expect(byCode.get("レコード番号")).toMatchObject({
    hasLookup: false,
    isLookupCopyTarget: false,
    isUnique: false,
    isCalculated: false,
  });
});

test("B130: DESCRIBE は既存3列とサブテーブル列を保ったまま値の由来4列を文字列で返す", async () => {
  const fields = [
    {
      code: "製品名", label: "製品名", fieldType: "SINGLE_LINE_TEXT",
      hasLookup: true, isLookupCopyTarget: false, isUnique: false, isCalculated: false,
    },
    {
      code: "仕入先", label: "仕入先", fieldType: "SINGLE_LINE_TEXT",
      hasLookup: false, isLookupCopyTarget: true, isUnique: false, isCalculated: false,
    },
    {
      code: "個数_在庫計算用", label: "個数_在庫計算用", fieldType: "CALC",
      hasLookup: false, isLookupCopyTarget: false, isUnique: false, isCalculated: true,
    },
    {
      code: "製品名_マスタ", label: "製品名", fieldType: "SINGLE_LINE_TEXT",
      hasLookup: false, isLookupCopyTarget: false, isUnique: true, isCalculated: false,
    },
  ] as unknown as KintoneFieldInfo[];
  const result = await execute("DESCRIBE APP4228", makeClient(fields), {
    cacheContext: "b130-direct",
  }) as SelectResult;

  expect(result.columns).toEqual(describeColumns);
  expect(result.rows).toEqual([
    {
      フィールドコード: "製品名", ラベル: "製品名", タイプ: "SINGLE_LINE_TEXT",
      サブテーブル: "", ルックアップ: "YES", コピー元: "", 重複禁止: "", 計算式: "",
    },
    {
      フィールドコード: "仕入先", ラベル: "仕入先", タイプ: "SINGLE_LINE_TEXT",
      サブテーブル: "", ルックアップ: "", コピー元: "YES", 重複禁止: "", 計算式: "",
    },
    {
      フィールドコード: "個数_在庫計算用", ラベル: "個数_在庫計算用", タイプ: "CALC",
      サブテーブル: "", ルックアップ: "", コピー元: "", 重複禁止: "", 計算式: "YES",
    },
    {
      フィールドコード: "製品名_マスタ", ラベル: "製品名", タイプ: "SINGLE_LINE_TEXT",
      サブテーブル: "", ルックアップ: "", コピー元: "", 重複禁止: "YES", 計算式: "",
    },
  ]);
  expect(result.rows.every((row) =>
    Object.values(row).every((value) => typeof value === "string")
  )).toBe(true);
});

test("B130: CTE 経由の SELECT * は8列で新列を絞り込める", async () => {
  const fields = [{
    code: "製品名", label: "製品名", fieldType: "SINGLE_LINE_TEXT", hasLookup: true,
  }] as unknown as KintoneFieldInfo[];
  const client = makeClient(fields);
  const wildcard = await execute(
    "WITH d AS (DESCRIBE APP100) SELECT * FROM d",
    client,
    { cacheContext: "b130-cte-wildcard" }
  ) as SelectResult;
  const filtered = await execute(
    "WITH d AS (DESCRIBE APP100) SELECT ルックアップ FROM d WHERE ルックアップ = 'YES'",
    client,
    { cacheContext: "b130-cte-filter" }
  ) as SelectResult;

  expect(wildcard.columns).toEqual(describeColumns);
  expect(filtered.rows).toEqual([{ ルックアップ: "YES" }]);
});

// B137: UNION の左右は実体化後の列数が一致しなければならない。
test("B137: 8列のDESCRIBEと3列SELECTのUNIONはエラー", async () => {
  const fields = [{
    code: "製品名", label: "製品名", fieldType: "SINGLE_LINE_TEXT", hasLookup: true,
  }] as unknown as KintoneFieldInfo[];
  await expect(execute(
    "WITH d AS (DESCRIBE APP100) " +
      "SELECT * FROM d UNION ALL SELECT 'code' AS c, 'label' AS l, 'type' AS t",
    makeClient(fields),
    { cacheContext: "b130-union" }
  )).rejects.toThrow("ArgumentError: UNION の左右で列数が一致しません（左 8 列 / 右 3 列）。");
});

test("B130: JOINの同名列はDESCRIBE側を修飾して参照できる", async () => {
  const describeFields = [{
    code: "製品名", label: "製品名", fieldType: "SINGLE_LINE_TEXT", hasLookup: true,
  }] as unknown as KintoneFieldInfo[];
  const client = makeClient(describeFields);
  client.getRecords = async () => ({
    records: [{
      フィールドコード: { value: "製品名" },
      ルックアップ: { value: "physical" },
    }],
  });
  client.getFields = async (appId) => appId === 100 ? describeFields : [
    { code: "フィールドコード", label: "フィールドコード", fieldType: "SINGLE_LINE_TEXT" },
    { code: "ルックアップ", label: "ルックアップ", fieldType: "SINGLE_LINE_TEXT" },
  ];

  const result = await execute(
    "WITH d AS (DESCRIBE APP100) " +
      "SELECT d.ルックアップ AS describe_flag, p.ルックアップ AS physical_value " +
      "FROM d INNER JOIN APP200 p ON d.フィールドコード = p.フィールドコード",
    client,
    { cacheContext: "b130-join" }
  ) as SelectResult;

  expect(result.rows).toEqual([{ describe_flag: "YES", physical_value: "physical" }]);
});

test("B130: 0行のBYO DESCRIBEでも8列を返し、フラグ欠落時は空文字になる", async () => {
  const base: ReadonlyKintoneClient = {
    async getRecords() { return { records: [] }; },
    async openCursor() { throw new Error("unexpected cursor call"); },
    async getApps() { return []; },
    async getFields() { return []; },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" };
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
  };
  const empty = await runQuery("DESCRIBE APP100", { client: base });
  const missingFlags = await runQuery("DESCRIBE APP100", {
    client: {
      ...base,
      async getFields() {
        return [{ code: "plain", label: "Plain", fieldType: "SINGLE_LINE_TEXT" }];
      },
    },
  });

  expect(empty.columns.map((column) => column.name)).toEqual(describeColumns);
  expect(empty.rows).toEqual([]);
  expect(missingFlags.rows).toEqual([{
    フィールドコード: "plain",
    ラベル: "Plain",
    タイプ: "SINGLE_LINE_TEXT",
    サブテーブル: "",
    ルックアップ: "",
    コピー元: "",
    重複禁止: "",
    計算式: "",
  }]);
});
