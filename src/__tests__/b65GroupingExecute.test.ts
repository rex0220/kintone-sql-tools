import { execute, type KintoneClient, type SelectResult } from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";
import { analyzeBatch } from "../core/batch";
import { parseSqlStatements } from "../core/sql";

function record(fields: Record<string, string>): KintoneRecord {
  return Object.fromEntries(Object.entries(fields).map(([code, value]) => [code, { value }]));
}

function client(
  recordsByApp: Record<number, KintoneRecord[]>,
  fieldTypes: Record<string, string> = {}
): KintoneClient & { recordCalls: number } {
  return {
    recordCalls: 0,
    async getRecords(params) {
      this.recordCalls++;
      const records = recordsByApp[params.app] ?? [];
      const limit = Number(params.query.match(/\blimit\s+(\d+)/i)?.[1] ?? "500");
      const offset = Number(params.query.match(/\boffset\s+(\d+)/i)?.[1] ?? "0");
      return { records: records.slice(offset, offset + limit) };
    },
    async openCursor() { throw new Error("unexpected cursor"); },
    async postRecords() { throw new Error("unexpected write"); },
    async putRecords() { throw new Error("unexpected write"); },
    async deleteRecords() { throw new Error("unexpected write"); },
    async getApps() { return []; },
    async getFields(appId) {
      const codes = new Set((recordsByApp[appId] ?? []).flatMap((row) => Object.keys(row)));
      Object.keys(fieldTypes).forEach((code) => codes.add(code));
      return [...codes]
        .filter((code) => !code.startsWith("$"))
        .map((code) => ({
          code,
          label: code,
          fieldType: fieldTypes[code] ?? "SINGLE_LINE_TEXT",
        }));
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const };
    },
  };
}

const sales = [
  record({ $id: "1", 会社名: "", 売上: "5", 商談フェーズ: "受注" }),
  record({ $id: "2", 会社名: "A", 売上: "20", 商談フェーズ: "提案中" }),
  record({ $id: "3", 会社名: "A", 売上: "10", 商談フェーズ: "受注" }),
];

test("B65-M01: 看板 SQL は CASE/discriminator と会社明細を返し total を末尾にする", async () => {
  const result = await execute(
    "SELECT CASE WHEN GROUPING(会社名)=1 THEN '合計' ELSE 会社名 END AS 会社名, " +
    "GROUPING(会社名) AS grouping_company, COUNT(*) AS 案件数, SUM(売上) AS 売上合計, " +
    "SUM(CASE WHEN 商談フェーズ='受注' THEN 売上 ELSE 0 END) AS 受注済売上, " +
    "SUM(CASE WHEN 商談フェーズ IN ('提案中','内示') THEN 売上 ELSE 0 END) AS 見込売上 " +
    "FROM APP4149 GROUP BY ROLLUP(会社名) " +
    "ORDER BY GROUPING(会社名), 売上合計 DESC",
    client({ 4149: sales }, { 売上: "NUMBER" }),
    { cacheContext: "b65-billboard" }
  ) as SelectResult;

  expect(result.rows).toEqual([
    { 会社名: "A", grouping_company: "0", 案件数: "2", 売上合計: "30", 受注済売上: "10", 見込売上: "20" },
    { 会社名: "", grouping_company: "0", 案件数: "1", 売上合計: "5", 受注済売上: "5", 見込売上: "0" },
    { 会社名: "合計", grouping_company: "1", 案件数: "3", 売上合計: "35", 受注済売上: "15", 見込売上: "20" },
  ]);
});

test("B65-O02: direct GROUPING key と GROUPING alias は同じ順序を返す", async () => {
  const mock = client({ 4149: sales }, { 売上: "NUMBER" });
  const prefix = "SELECT 会社名, GROUPING(会社名) AS g, SUM(売上) AS total FROM APP4149 GROUP BY ROLLUP(会社名) ";
  const direct = await execute(prefix + "ORDER BY GROUPING(会社名), total DESC", mock, {
    cacheContext: "b65-direct-order",
  }) as SelectResult;
  const alias = await execute(prefix + "ORDER BY g, total DESC", mock, {
    cacheContext: "b65-alias-order",
  }) as SelectResult;
  expect(direct.rows).toEqual(alias.rows);
  expect(direct.rows[direct.rows.length - 1]).toMatchObject({ 会社名: "", g: "1", total: "35" });
});

test.each([
  [
    "B65-H01",
    1,
    [{ 会社名: "", g: "1", total: "35" }],
  ],
  [
    "B65-H02",
    0,
    [
      { 会社名: "", g: "0", total: "5" },
      { 会社名: "A", g: "0", total: "30" },
    ],
  ],
] as const)("%s: HAVING GROUPING(会社名)=%i は membership で階層を絞る", async (
  _id,
  groupingValue,
  expected
) => {
  const result = await execute(
    "SELECT 会社名, GROUPING(会社名) AS g, SUM(売上) AS total " +
    `FROM APP4149 GROUP BY ROLLUP(会社名) HAVING GROUPING(会社名)=${groupingValue} ` +
    "ORDER BY 会社名",
    client({ 4149: sales }, { 売上: "NUMBER" }),
    { cacheContext: `b65-having-${groupingValue}` }
  ) as SelectResult;

  expect(result.rows).toEqual(expected);
});

test("B65-H03: 複数列 ROLLUP の membership 組合せで地域小計だけ返す", async () => {
  const rows = [
    record({ $id: "1", 地域: "東", 会社名: "A", 売上: "10" }),
    record({ $id: "2", 地域: "東", 会社名: "B", 売上: "20" }),
    record({ $id: "3", 地域: "西", 会社名: "A", 売上: "5" }),
  ];
  const result = await execute(
    "SELECT 地域, 会社名, GROUPING(地域) AS g_region, GROUPING(会社名) AS g_company, " +
    "SUM(売上) AS total FROM APP4149 GROUP BY ROLLUP(地域,会社名) " +
    "HAVING GROUPING(地域)=0 AND GROUPING(会社名)=1 ORDER BY 地域",
    client({ 4149: rows }, { 売上: "NUMBER" }),
    { cacheContext: "b65-h03" }
  ) as SelectResult;

  expect(result.rows).toEqual([
    { 地域: "東", 会社名: "", g_region: "0", g_company: "1", total: "30" },
    { 地域: "西", 会社名: "", g_region: "0", g_company: "1", total: "5" },
  ]);
});

test("B65-H04: HAVING GROUPING は set ごとの集計条件と AND 併用できる", async () => {
  const result = await execute(
    "SELECT 会社名, GROUPING(会社名) AS g, SUM(売上) AS total " +
    "FROM APP4149 GROUP BY ROLLUP(会社名) " +
    "HAVING GROUPING(会社名)=1 AND SUM(売上)>0",
    client({ 4149: sales }, { 売上: "NUMBER" }),
    { cacheContext: "b65-h04" }
  ) as SelectResult;

  expect(result.rows).toEqual([{ 会社名: "", g: "1", total: "35" }]);
});

test("B65-H04-OR: HAVING GROUPING は set ごとの集計条件と OR 併用できる", async () => {
  const result = await execute(
    "SELECT 会社名, GROUPING(会社名) AS g, SUM(売上) AS total " +
    "FROM APP4149 GROUP BY ROLLUP(会社名) " +
    "HAVING GROUPING(会社名)=1 OR SUM(売上)=30 ORDER BY GROUPING(会社名), 会社名",
    client({ 4149: sales }, { 売上: "NUMBER" }),
    { cacheContext: "b65-h04-or" }
  ) as SelectResult;

  expect(result.rows).toEqual([
    { 会社名: "A", g: "0", total: "30" },
    { 会社名: "", g: "1", total: "35" },
  ]);
});

test("B65-H05: 空セル detail は total と値が同じ空文字でも membership で区別する", async () => {
  const result = await execute(
    "SELECT 会社名, GROUPING(会社名) AS g, SUM(売上) AS total " +
    "FROM APP4149 GROUP BY ROLLUP(会社名) " +
    "HAVING GROUPING(会社名)=0 AND 会社名=''",
    client({ 4149: sales }, { 売上: "NUMBER" }),
    { cacheContext: "b65-h05" }
  ) as SelectResult;

  expect(result.rows).toEqual([{ 会社名: "", g: "0", total: "5" }]);
});

test("B65-H08: analyzeBatch 受理後の実行でも HAVING GROUPING は同じ結果を返す", async () => {
  const sql =
    "SELECT 会社名, GROUPING(会社名) AS g, SUM(売上) AS total " +
    "FROM APP4149 GROUP BY ROLLUP(会社名) HAVING GROUPING(会社名)=1";
  expect(() => analyzeBatch(parseSqlStatements(sql))).not.toThrow();

  const result = await execute(
    sql,
    client({ 4149: sales }, { 売上: "NUMBER" }),
    { cacheContext: "b65-h08" }
  ) as SelectResult;
  expect(result.rows).toEqual([{ 会社名: "", g: "1", total: "35" }]);
});

test("B65-M04/F03/H09: HAVING GROUPING で結果を減らしても完全入力 policy は免除しない", async () => {
  const records = Array.from({ length: 101 }, (_, index) =>
    record({ $id: String(index + 1), 会社名: `C${index}`, 売上: "1" })
  );
  await expect(execute(
    "SELECT 会社名, GROUPING(会社名) AS g, SUM(売上) AS total " +
    "FROM APP4149 GROUP BY ROLLUP(会社名) HAVING GROUPING(会社名)=1",
    client({ 4149: records }, { 売上: "NUMBER" }),
    { cacheContext: "b65-complete-input", maxRecords: 100, onLimitReached: "truncate" }
  )).rejects.toThrow(
    /小計・総計の正しい結果.*complete input reason: GROUPING_SETS.*onLimit=truncateは使用できません/
  );
});

test("B65-M02: 2列 ROLLUP は明細・地域小計・総計と正しい GROUPING bit を返す", async () => {
  const rows = [
    record({ $id: "1", 地域: "東", 会社名: "A", 売上: "10" }),
    record({ $id: "2", 地域: "東", 会社名: "B", 売上: "20" }),
    record({ $id: "3", 地域: "西", 会社名: "A", 売上: "5" }),
  ];
  const result = await execute(
    "SELECT 地域, 会社名, GROUPING(地域) AS g_region, GROUPING(会社名) AS g_company, " +
    "SUM(売上) AS total FROM APP4149 GROUP BY ROLLUP(地域,会社名) " +
    "ORDER BY GROUPING(地域), 地域, GROUPING(会社名), 会社名",
    client({ 4149: rows }, { 売上: "NUMBER" }),
    { cacheContext: "b65-m02" }
  ) as SelectResult;

  expect(result.rows).toEqual([
    { 地域: "東", 会社名: "A", g_region: "0", g_company: "0", total: "10" },
    { 地域: "東", 会社名: "B", g_region: "0", g_company: "0", total: "20" },
    { 地域: "東", 会社名: "", g_region: "0", g_company: "1", total: "30" },
    { 地域: "西", 会社名: "A", g_region: "0", g_company: "0", total: "5" },
    { 地域: "西", 会社名: "", g_region: "0", g_company: "1", total: "5" },
    { 地域: "", 会社名: "", g_region: "1", g_company: "1", total: "35" },
  ]);
});

test("B65-M03: 明示 GROUPING SETS は不要階層を作らず ORDER BY が明示 set 順を上書きする", async () => {
  const rows = [
    record({ $id: "1", 地域: "東", 会社名: "A", 売上: "10" }),
    record({ $id: "2", 地域: "東", 会社名: "B", 売上: "20" }),
    record({ $id: "3", 地域: "西", 会社名: "A", 売上: "5" }),
  ];
  const result = await execute(
    "SELECT 地域, 会社名, GROUPING(地域) AS g_region, GROUPING(会社名) AS g_company, " +
    "SUM(売上) AS total FROM APP4149 " +
    "GROUP BY GROUPING SETS ((),(地域),(地域,会社名)) " +
    "ORDER BY GROUPING(地域), 地域, GROUPING(会社名), total DESC",
    client({ 4149: rows }, { 売上: "NUMBER" }),
    { cacheContext: "b65-m03" }
  ) as SelectResult;

  expect(result.rows).toEqual([
    { 地域: "東", 会社名: "B", g_region: "0", g_company: "0", total: "20" },
    { 地域: "東", 会社名: "A", g_region: "0", g_company: "0", total: "10" },
    { 地域: "東", 会社名: "", g_region: "0", g_company: "1", total: "30" },
    { 地域: "西", 会社名: "A", g_region: "0", g_company: "0", total: "5" },
    { 地域: "西", 会社名: "", g_region: "0", g_company: "1", total: "5" },
    { 地域: "", 会社名: "", g_region: "1", g_company: "1", total: "35" },
  ]);
  expect(result.rows).not.toContainEqual(expect.objectContaining({
    地域: "", 会社名: "A", g_region: "1", g_company: "0",
  }));
});

test("B65-F06: materialized CTE 併用経路も物理 APP fetch に完全入力 policy を適用する", async () => {
  const physical = Array.from({ length: 101 }, (_, index) =>
    record({ $id: String(index + 1), id: "join", a: `C${index}` })
  );
  await expect(execute(
    "WITH c AS (SELECT id FROM APP2) " +
    "SELECT p.a, GROUPING(p.a) AS g, COUNT(*) AS n FROM APP1 p " +
    "JOIN c ON p.id=c.id GROUP BY ROLLUP(p.a)",
    client({
      1: physical,
      2: [record({ $id: "1", id: "join" })],
    }),
    { cacheContext: "b65-cte-complete-input", maxRecords: 100, onLimitReached: "truncate" }
  )).rejects.toThrow(
    /小計・総計の正しい結果.*complete input reason: GROUPING_SETS.*onLimit=truncateは使用できません/
  );
});

test("B65 planning errors remain fetch-free after execution gate removal", async () => {
  const cases = [
    ["SELECT a FROM APP1 GROUP BY ROLLUP(missing)", /does not exist/],
    ["SELECT GROUPING(b), SUM(x) FROM APP1 GROUP BY ROLLUP(a)", /NOT_ITEM/],
    ["SELECT a, SUM(x) AS a FROM APP1 GROUP BY ROLLUP(a)", /ALIAS_COLLISION/],
  ] as const;
  for (const [sql, message] of cases) {
    const mock = client({ 1: [] }, { a: "SINGLE_LINE_TEXT", b: "SINGLE_LINE_TEXT", x: "NUMBER" });
    await expect(execute(sql, mock, { cacheContext: `b65-reject-${sql}` })).rejects.toThrow(message);
    expect(mock.recordCalls).toBe(0);
  }
});

test("B65-G01: candidate set/item planning guard は records fetch 前に fail-closed", async () => {
  const sets = Array.from({ length: 65 }, () => "()").join(",");
  const fields = Array.from({ length: 17 }, (_, index) => `f${index + 1}`);
  const cases = [
    [
      `SELECT COUNT(*) FROM APP1 GROUP BY GROUPING SETS (${sets})`,
      /65.*64.*GROUPING_SET_LIMIT_EXCEEDED/,
    ],
    [
      `SELECT COUNT(*) FROM APP1 GROUP BY GROUPING SETS ((${fields.join(",")}))`,
      /17.*16.*GROUPING_ITEM_LIMIT_EXCEEDED/,
    ],
  ] as const;
  for (const [sql, message] of cases) {
    const mock = client(
      { 1: [] },
      Object.fromEntries(fields.map((field) => [field, "SINGLE_LINE_TEXT"]))
    );
    await expect(execute(sql, mock, { cacheContext: `b65-guard-${message.source}` }))
      .rejects.toThrow(message);
    expect(mock.recordCalls).toBe(0);
  }
});

test("B65-O05: KORDER BY 併用は records fetch 前に拒否する", async () => {
  const mock = client({ 1: [] }, { a: "SINGLE_LINE_TEXT", x: "NUMBER" });
  await expect(execute(
    "SELECT a, SUM(x) FROM APP1 GROUP BY ROLLUP(a) KORDER BY a LIMIT 1",
    mock,
    { cacheContext: "b65-korder-reject" }
  )).rejects.toThrow(/KORDER/);
  expect(mock.recordCalls).toBe(0);
});

test("B65 materialized CTE grouping item remains fetch-free rejected", async () => {
  const mock = client({ 1: [] }, { a: "SINGLE_LINE_TEXT" });
  await expect(execute(
    "WITH c AS (SELECT a FROM APP1) SELECT a FROM c GROUP BY ROLLUP(a)",
    mock,
    { cacheContext: "b65-cte-reject" }
  )).rejects.toThrow(/materialized CTE\/temp column/);
  expect(mock.recordCalls).toBe(0);
});

test("B65 EXPLAIN remains records API free", async () => {
  const mock = client({ 1: [] }, { a: "SINGLE_LINE_TEXT", x: "NUMBER" });
  await expect(execute(
    "EXPLAIN SELECT GROUPING(a) AS g, CASE WHEN GROUPING(a)=1 THEN 'total' ELSE a END AS a, " +
    "SUM(x) AS total FROM APP1 GROUP BY ROLLUP(a) ORDER BY GROUPING(a), total DESC",
    mock,
    { cacheContext: "b65-explain" }
  )).resolves.toMatchObject({ type: "SELECT" });
  expect(mock.recordCalls).toBe(0);
});

test("B65-X01: EXPLAIN は candidate guard・完全入力・local order を静的表示する", async () => {
  const mock = client({ 1: [] }, { a: "SINGLE_LINE_TEXT", x: "NUMBER" });
  const result = await execute(
    "EXPLAIN SELECT a, GROUPING(a) AS g, SUM(x) AS total FROM APP1 " +
    "GROUP BY GROUPING SETS ((a),(),(a))",
    mock,
    { cacheContext: "b65-explain-static" }
  ) as SelectResult;
  const plan = result.rows.map((row) => row.plan);
  expect(plan).toEqual(expect.arrayContaining([
    expect.stringMatching(/mode:\s+FULL_SCAN/),
    "  grouping source: GROUPING_SETS",
    "  grouping sets: 3 (limit: 64)",
    "  grouping items: 1 (limit: 16)",
    "  grouping output rows: runtime checked (limit: 50000, before HAVING/DISTINCT/LIMIT)",
    "  complete input: required (onLimit=truncate disabled)",
    "  complete input reason: GROUPING_SETS",
    expect.stringMatching(/order plan:\s+CANONICAL_LOCAL/),
  ]));
  expect(mock.recordCalls).toBe(0);
});
