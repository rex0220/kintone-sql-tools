import {
  execute,
  executeBatch,
  type KintoneClient,
  type KintoneFieldInfo,
  type SelectResult,
} from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";
import * as evalWhereModule from "../engine/evalWhere";

type GetParams = Parameters<KintoneClient["getRecords"]>[0];

const FIELDS: KintoneFieldInfo[] = [
  { code: "受注日", label: "受注日", fieldType: "DATE" },
  { code: "担当者", label: "担当者", fieldType: "SINGLE_LINE_TEXT", writable: true },
  { code: "受注金額", label: "受注金額", fieldType: "NUMBER" },
];

function record(values: Record<string, unknown>): KintoneRecord {
  return Object.fromEntries(
    Object.entries(values).map(([code, value]) => [code, { value }])
  ) as KintoneRecord;
}

const SOURCE = [
  record({ $id: "1", 受注日: "2026-07-01", 担当者: "佐藤", 受注金額: "100" }),
  record({ $id: "2", 受注日: "2026-07-02", 担当者: "佐藤", 受注金額: "300" }),
  record({ $id: "3", 受注日: "2026-07-03", 担当者: "鈴木", 受注金額: "200" }),
];

function makeClient() {
  const calls = {
    records: jest.fn(async (params: GetParams) => ({
      records: SOURCE.map((row) =>
        Object.fromEntries(
          (params.fields ?? []).flatMap((code) =>
            row[code] === undefined ? [] : [[code, row[code]]]
          )
        ) as KintoneRecord
      ),
    })),
    cursorOpen: jest.fn(async () => ({
      totalCount: 0,
      nextPage: jest.fn(async () => ({ records: [], next: false })),
      close: jest.fn(async () => undefined),
    })),
    post: jest.fn(async () => ({ ids: [] })),
    put: jest.fn(async () => undefined),
    delete: jest.fn(async () => undefined),
    confirm: jest.fn(async () => true),
  };
  const client: KintoneClient = {
    getRecords: calls.records,
    openCursor: calls.cursorOpen,
    postRecords: calls.post,
    putRecords: calls.put,
    deleteRecords: calls.delete,
    async getApps() { return []; },
    async getFields() { return FIELDS; },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" };
    },
  };
  return { client, calls };
}

function planText(result: SelectResult): string {
  return result.rows.map((row) => row["plan"]).join("\n");
}

function expectNoExecutionApi(calls: ReturnType<typeof makeClient>["calls"]): void {
  expect(calls.records).not.toHaveBeenCalled();
  expect(calls.cursorOpen).not.toHaveBeenCalled();
  expect(calls.post).not.toHaveBeenCalled();
  expect(calls.put).not.toHaveBeenCalled();
  expect(calls.delete).not.toHaveBeenCalled();
  expect(calls.confirm).not.toHaveBeenCalled();
}

describe("B75 Step 2 inline and WITH main relative dates", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("inline経路は相対日付を押し下げ、client評価0で通常の物理SELECTとして実行する", async () => {
    const { client, calls } = makeClient();
    const sql = "WITH cur AS (SELECT 担当者, 受注金額 FROM APP100 "
      + "WHERE 受注日 >= FROM_TODAY(-30, DAYS) ORDER BY 受注金額) SELECT * FROM cur";
    const evaluator = jest.spyOn(evalWhereModule, "evalWhere");

    const result = await execute(sql, client) as SelectResult;
    expect(result.rows).toEqual([
      { 担当者: "佐藤", 受注金額: "100" },
      { 担当者: "鈴木", 受注金額: "200" },
      { 担当者: "佐藤", 受注金額: "300" },
    ]);
    expect(evaluator).not.toHaveBeenCalled();
    expect(calls.records).toHaveBeenCalledTimes(1);
    expect(calls.records.mock.calls[0][0]).toMatchObject({
      fields: ["担当者", "受注金額", "受注日", "$id"],
      query: "受注日 >= FROM_TODAY(-30, DAYS) order by $id asc limit 500 offset 0",
    });

    const explained = planText(await execute(`EXPLAIN ${sql}`, client) as SelectResult);
    expect(explained).toContain("client residual: (none)");
    expect(explained).toContain("relative date client evaluations: 0");
  });

  test("WITH mainの物理アプリSELECTは相対日付を押し下げclient評価0で実行する", async () => {
    const { client, calls } = makeClient();
    const sql = "WITH c AS (SELECT 'unused' AS x) "
      + "SELECT 受注日 FROM APP100 WHERE 受注日 = YESTERDAY() ORDER BY 受注日 DESC";
    const evaluator = jest.spyOn(evalWhereModule, "evalWhere");

    const result = await execute(sql, client) as SelectResult;
    expect(result.rows).toEqual([
      { 受注日: "2026-07-03" },
      { 受注日: "2026-07-02" },
      { 受注日: "2026-07-01" },
    ]);
    expect(evaluator).not.toHaveBeenCalled();
    expect(calls.records).toHaveBeenCalledTimes(1);
    expect(calls.records.mock.calls[0][0]).toMatchObject({
      fields: ["受注日", "$id"],
      query: "受注日 = YESTERDAY() order by $id asc limit 500 offset 0",
    });

    const explained = planText(await execute(`EXPLAIN ${sql}`, client) as SelectResult);
    expect(explained).toContain("client residual: (none)");
    expect(explained).toContain("relative date client evaluations: 0");
  });

  test("WITH mainのSIMPLE物理SELECTも相対日付をREST queryへ保つ", async () => {
    const { client, calls } = makeClient();
    const evaluator = jest.spyOn(evalWhereModule, "evalWhere");

    const result = await execute(
      "WITH c AS (SELECT 'unused' AS x) "
        + "SELECT 受注日 FROM APP100 WHERE 受注日 = YESTERDAY()",
      client
    ) as SelectResult;
    expect(result.rows).toEqual([
      { 受注日: "2026-07-01" },
      { 受注日: "2026-07-02" },
      { 受注日: "2026-07-03" },
    ]);
    expect(evaluator).not.toHaveBeenCalled();
    expect(calls.records.mock.calls[0][0]).toMatchObject({
      fields: ["受注日", "$id"],
      query: "受注日 = YESTERDAY() order by $id asc limit 500 offset 0",
    });
  });

  test.each([
    [
      "WITH mainがCTEを読む形",
      "WITH cur AS (SELECT 受注日, COUNT(*) AS n FROM APP100 GROUP BY 受注日) "
        + "SELECT 受注日 FROM cur WHERE 受注日 = YESTERDAY()",
    ],
    [
      "WITH mainがUNIONの形",
      "WITH c AS (SELECT 'unused' AS x) "
        + "SELECT 受注日 FROM APP100 WHERE 受注日 = YESTERDAY() "
        + "UNION ALL SELECT 受注日 FROM APP200",
    ],
    [
      "WITH main内のscalar subquery",
      "WITH c AS (SELECT 'unused' AS x) "
        + "SELECT (SELECT 受注日 FROM APP200 WHERE 受注日 = YESTERDAY() LIMIT 1) AS d "
        + "FROM APP100 LIMIT 1",
    ],
    [
      "WITH mainのwhole WHEREがexactでないPhase2候補",
      "WITH c AS (SELECT 'unused' AS x) "
        + "SELECT 受注日 FROM APP100 "
        + "WHERE 受注日 = THIS_MONTH() AND LENGTH(担当者) > 1",
    ],
  ])("%s はAPI実行前にfail-closedを維持する", async (_name, sql) => {
    const { client, calls } = makeClient();
    await expect(execute(sql, client, { confirm: calls.confirm }))
      .rejects.toThrow(/WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN/);
    expectNoExecutionApi(calls);
  });

  test("CREATE TEMP TABLE SELECT sourceはStep 3でwhole WHERE exactを許可する", async () => {
    const { client, calls } = makeClient();
    const evaluator = jest.spyOn(evalWhereModule, "evalWhere");
    const result = await executeBatch(
      "CREATE TEMP TABLE #t AS SELECT 受注日 FROM APP100 "
        + "WHERE 受注日 = YESTERDAY(); SELECT * FROM #t",
      client
    );
    expect(result.ok).toBe(true);
    expect(result.statements[0]).toMatchObject({ status: "success", rowCount: 3 });
    expect((result.statements[1].result as SelectResult).rows).toEqual([
      { 受注日: "2026-07-01" },
      { 受注日: "2026-07-02" },
      { 受注日: "2026-07-03" },
    ]);
    expect(evaluator).not.toHaveBeenCalled();
    expect(calls.records.mock.calls[0][0]).toMatchObject({
      fields: ["受注日", "$id"],
      query: "受注日 = YESTERDAY() order by $id asc limit 500 offset 0",
    });
  });

  test.each(["truncate", "error"] as const)(
    "WITH main物理SELECTの取得上限は onLimit=%s でliteral/relativeが対称",
    async (onLimitReached) => {
      const relativeSql = "WITH c AS (SELECT 'unused' AS x) "
        + "SELECT 受注日 FROM APP100 WHERE 受注日 >= THIS_MONTH()";
      const literalSql = "WITH c AS (SELECT 'unused' AS x) "
        + "SELECT 受注日 FROM APP100 WHERE 受注日 >= '2026-07-01'";
      const options = { maxRecords: 2, onLimitReached };

      if (onLimitReached === "truncate") {
        const relative = await execute(relativeSql, makeClient().client, options) as SelectResult;
        const literal = await execute(literalSql, makeClient().client, options) as SelectResult;
        expect(relative.rows).toEqual([
          { 受注日: "2026-07-01" },
          { 受注日: "2026-07-02" },
        ]);
        expect(literal.rows).toEqual(relative.rows);
      } else {
        await expect(execute(relativeSql, makeClient().client, options))
          .rejects.toThrow(/上限（2 件）/);
        await expect(execute(literalSql, makeClient().client, options))
          .rejects.toThrow(/上限（2 件）/);
      }
    }
  );

  test.each(["truncate", "error"] as const)(
    "inline local ORDERの取得上限は onLimit=%s でもliteral/relativeが対称",
    async (onLimitReached) => {
      const relativeSql = "WITH cur AS (SELECT 担当者, 受注金額 FROM APP100 "
        + "WHERE 受注日 >= THIS_MONTH() ORDER BY 受注金額) SELECT * FROM cur";
      const literalSql = "WITH cur AS (SELECT 担当者, 受注金額 FROM APP100 "
        + "WHERE 受注日 >= '2026-07-01' ORDER BY 受注金額) SELECT * FROM cur";
      const options = { maxRecords: 2, onLimitReached };

      await expect(execute(relativeSql, makeClient().client, options))
        .rejects.toThrow(/complete input reason: LOCAL_ORDER/);
      await expect(execute(literalSql, makeClient().client, options))
        .rejects.toThrow(/complete input reason: LOCAL_ORDER/);
    }
  );
});
