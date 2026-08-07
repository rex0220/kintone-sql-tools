import type { KintoneRecord } from "../converter/dmlToKintone";
import {
  execute,
  executeBatch,
  type KintoneClient,
  type KintoneFieldInfo,
  type SelectResult,
} from "../execute";

const APP = 4228;

function record(id: string, values: Readonly<Record<string, unknown>>): KintoneRecord {
  return Object.fromEntries([
    ["$id", { value: id }],
    ...Object.entries(values).map(([code, value]) => [code, { value }]),
  ]) as KintoneRecord;
}

const fields: readonly KintoneFieldInfo[] = [
  { code: "日付", label: "日付", fieldType: "DATE" },
  { code: "製品名", label: "製品名", fieldType: "SINGLE_LINE_TEXT" },
  { code: "個数", label: "個数", fieldType: "NUMBER" },
  {
    code: "入出庫区分", label: "入出庫区分", fieldType: "DROP_DOWN",
    optionOrder: { 出庫: 0, 入庫: 1 },
  },
  { code: "仕入先", label: "仕入先", fieldType: "SINGLE_LINE_TEXT" },
];

function makeClient(): KintoneClient & {
  queries: string[];
  metadataCalls: number;
} {
  const queries: string[] = [];
  const rows = [
    record("1", { 日付: "2026-07-29", 製品名: "牛乳", 個数: "80", 入出庫区分: "出庫", 仕入先: "zz" }),
    record("2", { 日付: "2026-07-30", 製品名: "牛乳", 個数: "101", 入出庫区分: "出庫", 仕入先: "zz" }),
    record("3", { 日付: "2026-07-31", 製品名: "パン", 個数: "50", 入出庫区分: "出庫", 仕入先: "zz" }),
  ];
  const client = {
    queries,
    metadataCalls: 0,
    async getRecords(params) {
      queries.push(params.query.replace(/(?:^|\s+)order by \$id asc limit 500 offset \d+$/, ""));
      return { records: rows };
    },
    async openCursor() { throw new Error("unexpected cursor"); },
    async postRecords() { throw new Error("unexpected write"); },
    async putRecords() { throw new Error("unexpected write"); },
    async deleteRecords() { throw new Error("unexpected write"); },
    async getApps() { client.metadataCalls++; return []; },
    async getFields() { client.metadataCalls++; return [...fields]; },
    async getProcessStatuses() { client.metadataCalls++; return { enable: false, states: [] }; },
    async getNumberPrecision() {
      client.metadataCalls++;
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const };
    },
  } satisfies KintoneClient & { queries: string[]; metadataCalls: number };
  return client;
}

const CTE_SQL = `WITH s AS (
  GENERATE_SERIES('2026-07-29', '2026-08-04') AS 日付
)
SELECT
  s.日付,
  t.$id,
  t.製品名,
  t.個数
FROM s
INNER JOIN APP4228 AS t
  ON s.日付 = t.日付
WHERE t.製品名 = '牛乳'
  AND t.個数 <= 100
  AND t.入出庫区分 = '出庫'
ORDER BY s.日付, t.$id`;

const COMBINED = '(日付 >= "2026-07-29" and 日付 <= "2026-08-04") and '
  + '((製品名 = "牛乳" and 個数 <= 100) and 入出庫区分 in ("出庫"))';

describe("B155 unified safe leaf policy acceptance", () => {
  test("CTE→APPでrangeとTEXT/NUMBER/selectionの3 leafを逐語合流する", async () => {
    const client = makeClient();
    const result = await execute(CTE_SQL, client, { cacheContext: "b155-cte" }) as SelectResult;
    expect(client.queries).toContain(COMBINED);
    expect(result.rows).toEqual([{
      日付: "2026-07-29", "$id": "1", 製品名: "牛乳", 個数: "80",
    }]);
  });

  test("一時テーブル→APPでも同じ3 leafをJOIN key prefilterへ合流する", async () => {
    const client = makeClient();
    const batch = await executeBatch(
      `CREATE TEMP TABLE #s AS
       WITH d AS (GENERATE_SERIES('2026-07-29','2026-08-04') AS 日付)
       SELECT 日付 FROM d;
       SELECT s.日付,t.$id,t.製品名,t.個数
       FROM #s s INNER JOIN APP4228 t ON s.日付=t.日付
       WHERE t.製品名='牛乳' AND t.個数<=100 AND t.入出庫区分='出庫'
       ORDER BY s.日付,t.$id;`,
      client,
      { cacheContext: "b155-temp" }
    );
    expect(client.queries).toContain(COMBINED);
    expect((batch.statements[1].result as SelectResult).rows).toEqual([{
      日付: "2026-07-29", "$id": "1", 製品名: "牛乳", 個数: "80",
    }]);
  });

  test.each([
    ["< 101", "個数 < 101"],
    ["<= 100", "個数 <= 100"],
  ])("strict/inclusiveを同じfallback経路でそのままserializeする: %s", async (op, expected) => {
    const client = makeClient();
    const sql = `WITH s AS (GENERATE_SERIES('2026-07-29','2026-08-04') AS 日付) `
      + `SELECT s.日付,t.$id FROM s INNER JOIN APP4228 t ON s.日付=t.日付 WHERE t.個数 ${op}`;
    await execute(sql, client, { cacheContext: `b155-${op}` });
    expect(client.queries.some((query) => query.includes(`and (${expected})`))).toBe(true);
  });

  test("単一表FULL_SCANでTEXT equalityだけをLIKE residualから抽出する", async () => {
    const client = makeClient();
    const result = await execute(
      "SELECT $id FROM APP4228 WHERE 製品名 = '牛乳' AND 仕入先 LIKE 'zz' ORDER BY $id",
      client,
      { cacheContext: "b155-single" }
    ) as SelectResult;
    expect(client.queries).toContain('製品名 = "牛乳"');
    expect(client.queries.some((query) => query.includes("仕入先"))).toBe(false);
    expect(result.rows).toEqual([{ "$id": "1" }, { "$id": "2" }]);
  });

  test("EXPLAINは実行と同じmetadata-aware fallback planとB154注記を表示する", async () => {
    const client = makeClient();
    const result = await execute(`EXPLAIN ${CTE_SQL}`, client, {
      cacheContext: "b155-explain",
    }) as SelectResult;
    const text = result.rows.map((row) => row.plan).join("\n");
    expect(text).toContain(
      "join pushdown plan: not applied (join key/WHERE prefilters are reported per source below)"
    );
    expect(text).toContain("join pushdown not applied: SOURCE_KIND");
    expect(text).toContain(`kintone query: ${COMBINED}`);
    expect(text).toContain(`pushdown applied: ${COMBINED}`);
    expect(text).toContain("fetch:         PREFILTERED");
    expect(text).toContain("relation: superset");
    expect(client.queries).toEqual([]);
  });
});
