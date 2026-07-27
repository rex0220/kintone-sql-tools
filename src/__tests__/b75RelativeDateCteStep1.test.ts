import {
  execute,
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
  { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
];

function record(values: Record<string, unknown>): KintoneRecord {
  return Object.fromEntries(
    Object.entries(values).map(([code, value]) => [code, { value }])
  ) as KintoneRecord;
}

const SOURCE = [
  record({ $id: "1", 受注日: "2026-07-01", 担当者: "佐藤", 受注金額: "100", 件名: "one" }),
  record({ $id: "2", 受注日: "2026-07-02", 担当者: "佐藤", 受注金額: "300", 件名: "two" }),
  record({ $id: "3", 受注日: "2026-07-03", 担当者: "鈴木", 受注金額: "200", 件名: "three" }),
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

describe("B75 Step 1 materialized CTE relative dates", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("集計 CTE は whole WHERE を押し下げ client評価0で正しい集計とEXPLAINを返す", async () => {
    const { client, calls } = makeClient();
    const sql = "WITH cur AS (SELECT 担当者, SUM(受注金額) AS 売上 FROM APP100 "
      + "WHERE 受注日 = THIS_MONTH() GROUP BY 担当者) SELECT * FROM cur";
    const evaluator = jest.spyOn(evalWhereModule, "evalWhere");

    const result = await execute(sql, client) as SelectResult;
    expect(result.rows).toEqual([
      { 担当者: "佐藤", 売上: "400" },
      { 担当者: "鈴木", 売上: "200" },
    ]);
    expect(evaluator).not.toHaveBeenCalled();
    expect(calls.records).toHaveBeenCalledTimes(1);
    expect(calls.records.mock.calls[0][0]).toMatchObject({
      fields: ["担当者", "受注金額", "受注日", "$id"],
      query: "受注日 = THIS_MONTH() order by $id asc limit 500 offset 0",
    });

    const explained = planText(await execute(`EXPLAIN ${sql}`, client) as SelectResult);
    expect(explained).toContain("relative date evaluation: kintone server");
    expect(explained).toContain("client residual: (none)");
    expect(explained).toContain("relative date client evaluations: 0");
  });

  test("SIMPLE CTE は相対日付をREST queryへ保ち requested fieldsだけで結果を返す", async () => {
    const { client, calls } = makeClient();
    const evaluator = jest.spyOn(evalWhereModule, "evalWhere");

    const result = await execute(
      "WITH c AS (SELECT 受注日 AS d FROM APP100 WHERE 受注日 = YESTERDAY()) SELECT * FROM c",
      client
    ) as SelectResult;
    expect(result.rows).toEqual([
      { d: "2026-07-01" },
      { d: "2026-07-02" },
      { d: "2026-07-03" },
    ]);
    expect(evaluator).not.toHaveBeenCalled();
    expect(calls.records.mock.calls[0][0]).toMatchObject({
      fields: ["受注日", "$id"],
      query: "受注日 = YESTERDAY() order by $id asc limit 500 offset 0",
    });
  });

  test.each([
    [
      "CTE本体のUNION枝",
      "WITH c AS (SELECT 受注日 FROM APP100 WHERE 受注日 = YESTERDAY() "
      + "UNION ALL SELECT 受注日 FROM APP200) SELECT * FROM c",
    ],
    [
      "whole WHEREがexactでないPhase2候補",
      "WITH c AS (SELECT 担当者, COUNT(*) AS n FROM APP100 "
      + "WHERE 受注日 = THIS_MONTH() AND LENGTH(件名) > 1 GROUP BY 担当者) SELECT * FROM c",
    ],
    [
      "DML source",
      "INSERT INTO APP200 (担当者) SELECT 担当者 FROM APP100 "
      + "WHERE 受注日 = THIS_MONTH() GROUP BY 担当者",
    ],
    [
      "CTE本体内のscalar subquery",
      "WITH c AS (SELECT (SELECT 受注日 FROM APP200 "
      + "WHERE 受注日 = YESTERDAY() LIMIT 1) AS d FROM APP100) SELECT * FROM c",
    ],
  ])("%s はAPI実行前にfail-closedを維持する", async (_name, sql) => {
    const { client, calls } = makeClient();
    await expect(execute(sql, client, { confirm: calls.confirm }))
      .rejects.toThrow(/WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN/);
    expectNoExecutionApi(calls);
  });

  test("物理APP JOINを含むCTE本体は第5-Lで新しいrowsとclient評価0を固定する", async () => {
    const { client, calls } = makeClient();
    const evaluator = jest.spyOn(evalWhereModule, "evalWhere");
    const result = await execute(
      "WITH c AS (SELECT a.受注日 FROM APP100 a JOIN APP200 b ON a.$id = b.$id "
      + "WHERE a.受注日 = YESTERDAY()) SELECT * FROM c",
      client,
      { confirm: calls.confirm }
    ) as SelectResult;

    expect(result.rows).toEqual([
      { 受注日: "2026-07-01" },
      { 受注日: "2026-07-02" },
      { 受注日: "2026-07-03" },
    ]);
    expect(evaluator).not.toHaveBeenCalled();
    expect(calls.records).toHaveBeenCalledTimes(2);
    expect(calls.records.mock.calls.find(([params]) => params.app === 100)?.[0])
      .toMatchObject({
        fields: ["受注日", "$id"],
        query: "受注日 = YESTERDAY() order by $id asc limit 500 offset 0",
      });
    expect(calls.cursorOpen).not.toHaveBeenCalled();
    expect(calls.post).not.toHaveBeenCalled();
    expect(calls.put).not.toHaveBeenCalled();
    expect(calls.delete).not.toHaveBeenCalled();
    expect(calls.confirm).not.toHaveBeenCalled();
  });

  test.each(["truncate", "error"] as const)(
    "materialized集計CTEの取得上限は onLimit=%s でliteral/relativeが対称",
    async (onLimitReached) => {
      const relativeSql = "WITH c AS (SELECT 担当者, SUM(受注金額) AS 売上 FROM APP100 "
        + "WHERE 受注日 >= THIS_MONTH() GROUP BY 担当者) SELECT * FROM c";
      const literalSql = "WITH c AS (SELECT 担当者, SUM(受注金額) AS 売上 FROM APP100 "
        + "WHERE 受注日 >= '2026-07-01' GROUP BY 担当者) SELECT * FROM c";
      const options = { maxRecords: 2, onLimitReached };

      if (onLimitReached === "truncate") {
        const relative = await execute(relativeSql, makeClient().client, options) as SelectResult;
        const literal = await execute(literalSql, makeClient().client, options) as SelectResult;
        expect(relative.rows).toEqual([{ 担当者: "佐藤", 売上: "400" }]);
        expect(literal.rows).toEqual(relative.rows);
      } else {
        await expect(execute(relativeSql, makeClient().client, options))
          .rejects.toThrow(/上限（2 件）/);
        await expect(execute(literalSql, makeClient().client, options))
          .rejects.toThrow(/上限（2 件）/);
      }
    }
  );
});
