/* QueryColumn の列メタ(fieldType / sortKind / sourceApp)公開を
 * runQuery の実フロー（モック client）で検証する。 */
import { runBatch, runQuery, type QueryColumn, type ReadonlyKintoneClient } from "../index";

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
  const result = await runQuery("SELECT ステータス FROM APP100", { client: makeClient() });
  expect(result.columns[0]?.name).toBe("ステータス");
  expect(result.columns[0]?.valueType).toBe("string");
});

test("MIN / CASE は物理フィールドを継承しても sourceApp を公開しない", async () => {
  const minResult = await runQuery(
    "SELECT MIN(ステータス) AS m FROM APP100",
    { client: makeClient() }
  );
  expect(minResult.columns[0]).toMatchObject({
    name: "m", fieldType: "DROP_DOWN", sortKind: "string",
  });
  expect(minResult.columns[0]?.sourceApp).toBeUndefined();

  const caseResult = await runQuery(
    "SELECT CASE WHEN 受注金額 > 0 THEN ステータス ELSE '' END AS c FROM APP100",
    { client: makeClient() }
  );
  expect(caseResult.columns[0]).toMatchObject({
    name: "c", fieldType: "KSQL_UNKNOWN", sortKind: "string",
  });
  expect(caseResult.columns[0]?.sourceApp).toBeUndefined();
});

test("CTE の列来歴は inline / materialize とも opaque", async () => {
  const inline = await runQuery(
    "WITH t AS (SELECT $id, ステータス FROM APP100) SELECT $id, ステータス FROM t",
    { client: makeClient() }
  );
  expect(inline.columns[0]).toMatchObject({ fieldType: "__ID__", sortKind: "number" });
  expect(inline.columns[1]).toMatchObject({ fieldType: "DROP_DOWN", sortKind: "string" });
  expect(inline.columns.every((column) => column.sourceApp === undefined)).toBe(true);

  // CTE を2個にして単一 CTE inline 最適化を外し、実体化経路を通す。
  const materialized = await runQuery(
    "WITH t AS (SELECT $id, ステータス FROM APP100), "
      + "unused AS (SELECT $id FROM APP100) "
      + "SELECT $id, ステータス FROM t",
    { client: makeClient() }
  );
  expect(materialized.columns[0]).toMatchObject({ fieldType: "__ID__", sortKind: "number" });
  expect(materialized.columns[1]).toMatchObject({ fieldType: "DROP_DOWN", sortKind: "string" });
  expect(materialized.columns.every((column) => column.sourceApp === undefined)).toBe(true);
});

test("UNION は左右の直接参照元 app が一致するときだけ sourceApp を保持する", async () => {
  const sameApp = await runQuery(
    "SELECT ステータス FROM APP100 UNION ALL SELECT ステータス FROM APP100",
    { client: makeClient() }
  );
  expect(sameApp.columns[0]).toMatchObject({
    fieldType: "DROP_DOWN", sortKind: "string", sourceApp: 100,
  });

  const differentApps = await runQuery(
    "SELECT ステータス FROM APP100 UNION ALL SELECT ステータス FROM APP200",
    { client: makeClient() }
  );
  expect(differentApps.columns[0]).toMatchObject({
    fieldType: "DROP_DOWN", sortKind: "string",
  });
  expect(differentApps.columns[0]?.sourceApp).toBeUndefined();
});

test("明示別名は name を正規化したまま displayName に記述表記を保持し、行キーを変えない", async () => {
  const result = await runQuery(
    "SELECT $id AS ランクA, $id AS `ランクC`, $id AS AVG, $id AS Ａ FROM APP100 LIMIT 1",
    { client: makeClient() }
  );
  expect(result.columns).toMatchObject([
    { name: "ランクa", displayName: "ランクA" },
    { name: "ランクc", displayName: "ランクC" },
    { name: "avg", displayName: "AVG" },
    { name: "ａ", displayName: "Ａ" },
  ]);
  expect(result.rows[0]).toEqual({
    "ランクa": "1",
    "ランクc": "1",
    avg: "1",
    "ａ": "1",
  });
  expect(result.rows[0]).not.toHaveProperty("ランクA");
});

test("別名なしの列は displayName が name と同一", async () => {
  const result = await runQuery(
    "SELECT $id, ステータス, COUNT(*) FROM APP100 GROUP BY $id, ステータス",
    { client: makeClient() }
  );
  expect(result.columns.every((column) => column.displayName === column.name)).toBe(true);
});

test("0 行 SELECT でも AST 由来の name / displayName を返す", async () => {
  const emptyClient: ReadonlyKintoneClient = {
    ...makeClient(),
    async getRecords() { return { records: [] }; },
    async openCursor() {
      return {
        totalCount: 0,
        async nextPage() { return { records: [], next: false }; },
        async close() {},
      };
    },
  };
  const result = await runQuery(
    "SELECT $id AS ランクA FROM APP100",
    { client: emptyClient }
  );
  expect(result.rows).toEqual([]);
  expect(result.columns[0]).toMatchObject({ name: "ランクa", displayName: "ランクA" });
});

test("UNION の displayName は第 1 枝の SELECT リストを使う", async () => {
  const result = await runQuery(
    "SELECT $id AS ランクA FROM APP100 UNION ALL SELECT $id AS 別名B FROM APP100",
    { client: makeClient() }
  );
  expect(result.columns[0]).toMatchObject({ name: "ランクa", displayName: "ランクA" });
  expect(result.rows.every((row) => Object.keys(row).includes("ランクa"))).toBe(true);
});

test("temp passthrough は displayName を引き継ぎ、明示再選択はその位置の表記を使う", async () => {
  const result = await runBatch(
    "CREATE TEMP TABLE #t AS SELECT $id AS ランクA FROM APP100; " +
      "SELECT * FROM #t; " +
      "SELECT ランクa FROM #t",
    { client: makeClient() }
  );
  expect(result.results[0]?.columns[0]).toMatchObject({
    name: "ランクa", displayName: "ランクA",
  });
  expect(result.results[1]?.columns[0]).toMatchObject({
    name: "ランクa", displayName: "ランクa",
  });
});
