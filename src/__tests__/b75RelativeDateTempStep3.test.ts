import {
  executeBatch,
  type KintoneClient,
  type KintoneFieldInfo,
  type SelectResult,
} from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";
import * as evalWhereModule from "../engine/evalWhere";
import { parseSqlStatement } from "../core/sql";
import { collectWith } from "../core/optimization/relativeDatePushdownGuard";
import type { WithStatement } from "../types/ast";

type GetParams = Parameters<KintoneClient["getRecords"]>[0];

const FIELDS: KintoneFieldInfo[] = [
  { code: "日付", label: "日付", fieldType: "DATE" },
  { code: "区分", label: "区分", fieldType: "SINGLE_LINE_TEXT" },
  { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
];

function record(values: Record<string, unknown>): KintoneRecord {
  return Object.fromEntries(
    Object.entries(values).map(([code, value]) => [code, { value }])
  ) as KintoneRecord;
}

const SOURCES: Record<number, KintoneRecord[]> = {
  100: [
    record({ $id: "1", 日付: "2026-07-01", 区分: "A", 件名: "one" }),
    record({ $id: "2", 日付: "2026-07-02", 区分: "A", 件名: "two" }),
    record({ $id: "3", 日付: "2026-07-03", 区分: "B", 件名: "three" }),
  ],
  200: [
    record({ $id: "10", 区分: "X" }),
  ],
};

function makeClient() {
  const calls = {
    records: jest.fn(async (params: GetParams) => ({
      records: (SOURCES[Number(params.app)] ?? []).map((row) =>
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

function rows(result: Awaited<ReturnType<typeof executeBatch>>): Record<string, unknown>[] {
  return (result.statements[1].result as SelectResult).rows;
}

function expectNoExecutionApi(calls: ReturnType<typeof makeClient>["calls"]): void {
  expect(calls.records).not.toHaveBeenCalled();
  expect(calls.cursorOpen).not.toHaveBeenCalled();
  expect(calls.post).not.toHaveBeenCalled();
  expect(calls.put).not.toHaveBeenCalled();
  expect(calls.delete).not.toHaveBeenCalled();
  expect(calls.confirm).not.toHaveBeenCalled();
}

describe("B75 Step 3 temporary-table relative dates", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("SELECT sourceはwhole WHEREを押し下げclient評価0で実体化する", async () => {
    const { client, calls } = makeClient();
    const evaluator = jest.spyOn(evalWhereModule, "evalWhere");
    const result = await executeBatch(
      "CREATE TEMP TABLE #t AS SELECT 区分, COUNT(*) AS n FROM APP100 "
        + "WHERE 日付 = YESTERDAY() GROUP BY 区分; SELECT * FROM #t",
      client
    );

    expect(result.ok).toBe(true);
    expect(result.statements[0]).toMatchObject({ status: "success", rowCount: 2 });
    expect(rows(result)).toEqual([{ 区分: "A", n: "2" }, { 区分: "B", n: "1" }]);
    expect(evaluator).not.toHaveBeenCalled();
    expect(calls.records).toHaveBeenCalledTimes(1);
    expect(calls.records.mock.calls[0][0]).toMatchObject({
      fields: ["区分", "日付", "$id"],
      query: "日付 = YESTERDAY() order by $id asc limit 500 offset 0",
    });
  });

  test("WITH sourceのCTE本体にある相対日付を許可する", async () => {
    const { client, calls } = makeClient();
    const evaluator = jest.spyOn(evalWhereModule, "evalWhere");
    const result = await executeBatch(
      "CREATE TEMP TABLE #t AS WITH c AS "
        + "(SELECT 日付 FROM APP100 WHERE 日付 = YESTERDAY()) "
        + "SELECT COUNT(*) AS n FROM c; SELECT * FROM #t",
      client
    );

    expect(result.ok).toBe(true);
    expect(rows(result)).toEqual([{ n: "3" }]);
    expect(evaluator).not.toHaveBeenCalled();
    expect(calls.records.mock.calls[0][0]).toMatchObject({
      fields: ["日付", "$id"],
      query: "日付 = YESTERDAY() order by $id asc limit 500 offset 0",
    });
  });

  test("WITH sourceのmainにある相対日付を許可する", async () => {
    const { client, calls } = makeClient();
    const evaluator = jest.spyOn(evalWhereModule, "evalWhere");
    const result = await executeBatch(
      "CREATE TEMP TABLE #t AS WITH c AS (SELECT 区分 FROM APP200) "
        + "SELECT 日付 FROM APP100 WHERE 日付 = YESTERDAY(); SELECT * FROM #t",
      client
    );

    expect(result.ok).toBe(true);
    expect(rows(result)).toEqual([
      { 日付: "2026-07-01" },
      { 日付: "2026-07-02" },
      { 日付: "2026-07-03" },
    ]);
    expect(evaluator).not.toHaveBeenCalled();
    expect(calls.records).toHaveBeenCalledTimes(2);
    expect(calls.records.mock.calls[1][0]).toMatchObject({
      fields: ["日付", "$id"],
      query: "日付 = YESTERDAY() order by $id asc limit 500 offset 0",
    });
  });

  test("UNION sourceはAPI実行前にfail-closedを維持する", async () => {
    const { client, calls } = makeClient();
    const result = await executeBatch(
      "CREATE TEMP TABLE #t AS SELECT 日付 FROM APP100 WHERE 日付 = YESTERDAY() "
        + "UNION ALL SELECT 日付 FROM APP100; SELECT * FROM #t",
      client,
      { confirm: calls.confirm }
    );

    expect(result.ok).toBe(false);
    expect(result.statements[0].error?.message)
      .toContain("WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN");
    expectNoExecutionApi(calls);
  });

  test("後続の#t参照は実体化済み結果を読み相対日付を再評価しない", async () => {
    const { client, calls } = makeClient();
    const evaluator = jest.spyOn(evalWhereModule, "evalWhere");
    const result = await executeBatch(
      "CREATE TEMP TABLE #t AS SELECT 日付 FROM APP100 WHERE 日付 = YESTERDAY(); "
        + "SELECT * FROM #t",
      client
    );

    expect(result.ok).toBe(true);
    expect(rows(result)).toHaveLength(3);
    expect(calls.records).toHaveBeenCalledTimes(1);
    expect(evaluator).not.toHaveBeenCalled();
  });

  test("collectWith inheritedForbidden=trueはCTE本体とmainをfail-closedにする", () => {
    const statement = parseSqlStatement(
      "WITH c AS (SELECT 日付 FROM APP100 WHERE 日付 = YESTERDAY()) "
        + "SELECT 日付 FROM APP100 WHERE 日付 = TOMORROW()"
    ) as WithStatement;
    const candidates: Parameters<typeof collectWith>[2] = [];

    collectWith(statement, "statement", candidates, true);

    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => ({
      kind: candidate.kind,
      path: candidate.path,
      allowFullScanExact: candidate.allowFullScanExact,
    }))).toEqual([
      { kind: "FORBIDDEN", path: "statement.cte[0]", allowFullScanExact: false },
      { kind: "FORBIDDEN", path: "statement.main", allowFullScanExact: false },
    ]);
  });

  test.each([
    [
      "入れ子SELECT",
      "CREATE TEMP TABLE #t AS SELECT "
        + "(SELECT 日付 FROM APP200 WHERE 日付 = YESTERDAY() LIMIT 1) AS d FROM APP100; "
        + "SELECT * FROM #t",
    ],
    [
      "whole WHEREがexactでないPhase2候補",
      "CREATE TEMP TABLE #t AS SELECT 日付 FROM APP100 "
        + "WHERE 日付 = YESTERDAY() AND LENGTH(件名) > 1; SELECT * FROM #t",
    ],
  ])("%sはAPI実行前にfail-closedを維持する", async (_label, sql) => {
    const { client, calls } = makeClient();
    const result = await executeBatch(sql, client, { confirm: calls.confirm });

    expect(result.ok).toBe(false);
    expect(result.statements[0].error?.message)
      .toContain("WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN");
    expectNoExecutionApi(calls);
  });

  test.each(["truncate", "error"] as const)(
    "SELECT sourceの一時テーブル上限は onLimit=%s でもliteral/relativeが同じくerror",
    async (onLimitReached) => {
      const relativeSql = "CREATE TEMP TABLE #t AS SELECT 日付 FROM APP100 "
        + "WHERE 日付 >= THIS_MONTH(); SELECT * FROM #t";
      const literalSql = "CREATE TEMP TABLE #t AS SELECT 日付 FROM APP100 "
        + "WHERE 日付 >= '2026-07-01'; SELECT * FROM #t";
      const options = { tempTableMaxRows: 2, onLimitReached };

      const relative = await executeBatch(relativeSql, makeClient().client, options);
      const literal = await executeBatch(literalSql, makeClient().client, options);
      expect(relative.ok).toBe(false);
      expect(literal.ok).toBe(false);
      expect(relative.statements[0].error?.message)
        .toMatch(/取得件数が上限（2 件）を超えました/);
      expect(literal.statements[0].error?.message)
        .toBe(relative.statements[0].error?.message);
    }
  );
});
