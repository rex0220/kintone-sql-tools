/* QueryColumn の列メタ(fieldType / sortKind / sourceApp)公開のテスト(v3.22.0)。
 * runQuery の実フロー(モック client)で 3 系統を検証する:
 *   ①単純フィールド参照 ②集計関数 ③文字列・日付関数(導出列) */
import { runQuery, type QueryColumn, type ReadonlyKintoneClient } from "../index";

const records = [
  { $id: { value: "1" }, 受注金額: { value: "1000" }, ステータス: { value: "受注" }, 受注日: { value: "2026-07-01" } },
  { $id: { value: "2" }, 受注金額: { value: "2500" }, ステータス: { value: "受注" }, 受注日: { value: "2026-07-02" } },
  { $id: { value: "3" }, 受注金額: { value: "400" }, ステータス: { value: "失注" }, 受注日: { value: "2026-06-15" } },
];

function makeClient(): ReadonlyKintoneClient {
  return {
    async getRecords() {
      return { records };
    },
    async openCursor() {
      let served = false;
      return {
        totalCount: records.length,
        async nextPage() {
          const page = { records: served ? [] : [...records], next: false };
          served = true;
          return page;
        },
        async close() {},
      };
    },
    async getApps() {
      return [{ appId: 100, name: "案件管理", description: "" }];
    },
    async getFields() {
      return [
        { code: "受注金額", label: "受注金額", fieldType: "NUMBER", sortKind: "number" as const },
        { code: "ステータス", label: "ステータス", fieldType: "DROP_DOWN", sortKind: "string" as const },
        { code: "受注日", label: "受注日", fieldType: "DATE", sortKind: "string" as const },
      ];
    },
    async getNumberPrecision() {
      return { digits: 16, decimalPlaces: 4, roundingMode: "HALF_EVEN" as const };
    },
    async getProcessStatuses() {
      return { enable: false, states: null };
    },
  };
}

function byName(columns: readonly QueryColumn[]): Map<string, QueryColumn> {
  return new Map(columns.map((column) => [column.name, column]));
}

test("単純フィールド参照列に fieldType / sortKind / sourceApp が付く", async () => {
  const result = await runQuery(
    "SELECT $id, ステータス, 受注金額 FROM APP100",
    { client: makeClient() }
  );
  const cols = byName(result.columns);
  expect(cols.get("ステータス")).toMatchObject({
    valueType: "string", fieldType: "DROP_DOWN", sortKind: "string", sourceApp: 100,
  });
  expect(cols.get("受注金額")).toMatchObject({
    valueType: "string", fieldType: "NUMBER", sortKind: "number", sourceApp: 100,
  });
  expect(cols.get("$id")).toMatchObject({
    valueType: "string", fieldType: "__ID__", sortKind: "number", sourceApp: 100,
  });
});

test("集計列は数値の導出型・sourceApp なし", async () => {
  const result = await runQuery(
    "SELECT ステータス, COUNT(*) AS 件数, SUM(受注金額) AS 合計 FROM APP100 GROUP BY ステータス",
    { client: makeClient() }
  );
  const cols = byName(result.columns);
  expect(cols.get("件数")).toMatchObject({ fieldType: "KSQL_NUMBER", sortKind: "number" });
  expect(cols.get("件数")?.sourceApp).toBeUndefined();
  expect(cols.get("合計")).toMatchObject({ fieldType: "KSQL_NUMBER", sortKind: "number" });
  expect(cols.get("ステータス")).toMatchObject({ fieldType: "DROP_DOWN", sourceApp: 100 });
});

test("日付関数の導出列は文字列系メタになる", async () => {
  const result = await runQuery(
    "SELECT DATE_FORMAT(受注日, '%Y-%m') AS 年月, SUM(受注金額) AS 売上 FROM APP100 GROUP BY DATE_FORMAT(受注日, '%Y-%m')",
    { client: makeClient() }
  );
  const cols = byName(result.columns);
  const 年月 = cols.get("年月");
  expect(年月?.sortKind).toBe("string");
  expect(年月?.sourceApp).toBeUndefined();
  expect(cols.get("売上")).toMatchObject({ fieldType: "KSQL_NUMBER", sortKind: "number" });
});

test("メタ非対応の後方互換: name / valueType は従来どおり", async () => {
  const result = await runQuery("SELECT 顧客名 FROM APP100", { client: makeClient() });
  expect(result.columns[0]?.name).toBe("顧客名");
  expect(result.columns[0]?.valueType).toBe("string");
});
