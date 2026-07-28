import {
  execute,
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
  { code: "期限", label: "期限", fieldType: "DATE" },
  { code: "日時", label: "日時", fieldType: "DATETIME" },
  { code: "作成者", label: "作成者", fieldType: "CREATOR" },
  { code: "更新者", label: "更新者", fieldType: "MODIFIER" },
  { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
];

function record(values: Record<string, unknown>): KintoneRecord {
  return Object.fromEntries(
    Object.entries(values).map(([code, value]) => [code, { value }])
  ) as KintoneRecord;
}

const SOURCE = [
  record({
    $id: "1",
    日付: "2026-07-27",
    期限: "2026-07-27",
    日時: "2026-07-27T00:00:00Z",
    作成者: [{ code: "user" }],
    更新者: [{ code: "user" }],
    件名: "A",
  }),
  record({
    $id: "2",
    日付: "2026-07-27",
    期限: "2026-07-27",
    日時: "2026-07-27T01:00:00Z",
    作成者: [{ code: "user" }],
    更新者: [{ code: "user" }],
    件名: "AB",
  }),
  record({
    $id: "3",
    日付: "2026-07-27",
    期限: "2026-07-27",
    日時: "2026-07-27T02:00:00Z",
    作成者: [{ code: "user" }],
    更新者: [{ code: "user" }],
    件名: "ABC",
  }),
];

function makeClient() {
  const calls = {
    records: jest.fn(async (params: GetParams) => ({
      // B71: the mock must expose only fields requested by the runtime.
      records: SOURCE.map((source) => Object.fromEntries(
        (params.fields ?? []).flatMap((code) =>
          source[code] === undefined ? [] : [[code, source[code]]]
        )
      ) as KintoneRecord),
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

describe("B77+B78 Step 4: B75 composition contexts", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test.each([
    ["TODAY", "日付 = TODAY()", "日付 = TODAY()"],
    ["NOW", "日時 <= NOW()", "日時 <= NOW()"],
    ["LOGINUSER", "作成者 IN (LOGINUSER())", "作成者 in (LOGINUSER())"],
  ] as const)(
    "materialized aggregate CTE accepts %s as whole-WHERE exact",
    async (_name, predicate, restPredicate) => {
      const { client, calls } = makeClient();
      const evaluator = jest.spyOn(evalWhereModule, "evalWhere");
      const sql = "WITH c AS (SELECT COUNT(*) AS n FROM APP100 "
        + `WHERE ${predicate}) SELECT * FROM c`;

      await expect(execute(sql, client)).resolves.toMatchObject({
        type: "SELECT",
        rows: [{ n: "3" }],
      });
      expect(evaluator).not.toHaveBeenCalled();
      expect(calls.records).toHaveBeenCalledTimes(1);
      expect(calls.records.mock.calls[0][0].query)
        .toBe(`${restPredicate} order by $id asc limit 500 offset 0`);
    }
  );

  test.each([
    ["TODAY", "日付", "日付 = TODAY()", ["日付", "$id"]],
    ["LOGINUSER", "作成者", "作成者 IN (LOGINUSER())", ["作成者", "$id"]],
  ] as const)(
    "materialized SIMPLE CTE accepts %s and succeeds with requested fields only",
    async (_name, field, predicate, expectedFields) => {
      const { client, calls } = makeClient();
      const result = await execute(
        `WITH c AS (SELECT ${field} FROM APP100 WHERE ${predicate}) `
          + "SELECT COUNT(*) AS n FROM c",
        client
      ) as SelectResult;

      expect(result.rows).toEqual([{ n: "3" }]);
      expect(calls.records.mock.calls[0][0].fields).toEqual(expectedFields);
    }
  );

  test.each([
    ["TODAY", "日付", "日付 = TODAY()", "日付 = TODAY()"],
    ["LOGINUSER", "作成者", "作成者 IN (LOGINUSER())", "作成者 in (LOGINUSER())"],
  ] as const)(
    "WITH final physical SELECT accepts %s",
    async (_name, field, predicate, restPredicate) => {
      const { client, calls } = makeClient();
      await expect(execute(
        "WITH unused AS (SELECT 'x' AS x) "
          + `SELECT ${field} FROM APP100 WHERE ${predicate}`,
        client
      )).resolves.toMatchObject({ type: "SELECT", rowCount: 3 });
      expect(calls.records.mock.calls[0][0].query)
        .toBe(`${restPredicate} order by $id asc limit 500 offset 0`);
    }
  );

  test.each([
    ["TODAY", "日付", "日付 = TODAY()", "日付 = TODAY()"],
    ["LOGINUSER", "作成者", "作成者 IN (LOGINUSER())", "作成者 in (LOGINUSER())"],
  ] as const)(
    "single-CTE inline expansion accepts %s",
    async (_name, field, predicate, restPredicate) => {
      const { client, calls } = makeClient();
      await expect(execute(
        `WITH c AS (SELECT ${field} FROM APP100 WHERE ${predicate} ORDER BY ${field}) `
          + "SELECT * FROM c",
        client
      )).resolves.toMatchObject({ type: "SELECT", rowCount: 3 });
      expect(calls.records.mock.calls[0][0].query)
        .toBe(`${restPredicate} order by $id asc limit 500 offset 0`);
    }
  );

  test("temporary table AS SELECT accepts TODAY()", async () => {
    const { client, calls } = makeClient();
    const result = await executeBatch(
      "CREATE TEMP TABLE #t AS SELECT 日付 FROM APP100 WHERE 日付 = TODAY(); "
        + "SELECT * FROM #t",
      client
    );

    expect(result.ok).toBe(true);
    expect(calls.records).toHaveBeenCalledTimes(1);
    expect(calls.records.mock.calls[0][0]).toMatchObject({
      fields: ["日付", "$id"],
      query: "日付 = TODAY() order by $id asc limit 500 offset 0",
    });
  });

  test("temporary table AS WITH accepts TODAY()", async () => {
    const { client, calls } = makeClient();
    const result = await executeBatch(
      "CREATE TEMP TABLE #t AS WITH c AS "
        + "(SELECT 日付 FROM APP100 WHERE 日付 = TODAY()) "
        + "SELECT COUNT(*) AS n FROM c; SELECT * FROM #t",
      client
    );

    expect(result.ok).toBe(true);
    expect(calls.records).toHaveBeenCalledTimes(1);
    expect(calls.records.mock.calls[0][0].query)
      .toBe("日付 = TODAY() order by $id asc limit 500 offset 0");
  });

  test.each([
    [
      "nested TODAY",
      "WITH c AS (SELECT (SELECT 日付 FROM APP200 WHERE 日付 = TODAY() LIMIT 1) AS d "
        + "FROM APP100) SELECT * FROM c",
      "TODAY",
    ],
    [
      "nested NOW",
      "WITH c AS (SELECT (SELECT 日時 FROM APP200 WHERE 日時 <= NOW() LIMIT 1) AS d "
        + "FROM APP100) SELECT * FROM c",
      "NOW",
    ],
    [
      "nested LOGINUSER",
      "WITH c AS (SELECT (SELECT 作成者 FROM APP200 "
        + "WHERE 作成者 IN (LOGINUSER()) LIMIT 1) AS u FROM APP100) SELECT * FROM c",
      "LOGINUSER",
    ],
    [
      "CTE Phase2 TODAY",
      "WITH c AS (SELECT 日付 FROM APP100 "
        + "WHERE 日付 = TODAY() AND LENGTH(件名) > 1) SELECT COUNT(*) AS n FROM c",
      "TODAY",
    ],
    [
      "CTE Phase2 LOGINUSER",
      "WITH c AS (SELECT 作成者 FROM APP100 "
        + "WHERE 作成者 IN (LOGINUSER()) AND LENGTH(件名) > 1) "
        + "SELECT COUNT(*) AS n FROM c",
      "LOGINUSER",
    ],
    [
      "materialized UNION TODAY",
      "WITH c AS (SELECT 日付 FROM APP100 WHERE 日付 = TODAY() "
        + "UNION ALL SELECT 日付 FROM APP200) SELECT * FROM c",
      "TODAY",
    ],
    [
      "materialized UNION LOGINUSER",
      "WITH c AS (SELECT 作成者 FROM APP100 WHERE 作成者 IN (LOGINUSER()) "
        + "UNION ALL SELECT 作成者 FROM APP200) SELECT * FROM c",
      "LOGINUSER",
    ],
  ] as const)("%s remains fail-closed before execution APIs", async (_label, sql, name) => {
    const { client, calls } = makeClient();
    await expect(execute(sql, client, { confirm: calls.confirm })).rejects.toThrow(
      new RegExp(`${name}: WHERE_KINTONE_FUNCTION_REQUIRES_EXACT_PUSHDOWN`)
    );
    expectNoExecutionApi(calls);
  });

  test("inheritedForbidden=true remains forbidden for legacy functions in child nodes", () => {
    const statement = parseSqlStatement(
      "WITH c AS (SELECT 日付 FROM APP100 WHERE 日付 = TODAY()) "
        + "SELECT 作成者 FROM APP100 WHERE 作成者 IN (LOGINUSER())"
    ) as WithStatement;
    const candidates: Parameters<typeof collectWith>[2] = [];

    collectWith(statement, "statement", candidates, true);

    expect(candidates.map((candidate) => ({
      kind: candidate.kind,
      path: candidate.path,
      allowPhase2Prefilter: candidate.allowPhase2Prefilter,
      allowFullScanExact: candidate.allowFullScanExact,
    }))).toEqual([
      {
        kind: "FORBIDDEN",
        path: "statement.cte[0]",
        allowPhase2Prefilter: false,
        allowFullScanExact: false,
      },
      {
        kind: "FORBIDDEN",
        path: "statement.main",
        allowPhase2Prefilter: false,
        allowFullScanExact: false,
      },
    ]);
  });

  test("composition context preserves the server-function occurrence multiset", async () => {
    const { client, calls } = makeClient();
    const sql = "WITH c AS (SELECT COUNT(*) AS n FROM APP100 "
      + "WHERE 日付 = TODAY() AND 期限 = TODAY()) SELECT * FROM c";

    await expect(execute(sql, client)).resolves.toMatchObject({
      type: "SELECT",
      rows: [{ n: "3" }],
    });
    expect(calls.records.mock.calls[0][0]).toMatchObject({
      fields: ["日付", "期限", "$id"],
      query: "日付 = TODAY() and 期限 = TODAY() order by $id asc limit 500 offset 0",
    });

    const explained = planText(await execute(`EXPLAIN ${sql}`, client) as SelectResult);
    expect(explained.match(/kintone function: TODAY/g)).toHaveLength(2);
    expect(explained).toContain("server predicate: 日付 = TODAY() and 期限 = TODAY()");
    expect(explained).toContain("client residual: (none)");
    expect(explained).toContain("kintone function client evaluations: 0");
  });

  test("LOGINUSER occurrence multiset is preserved inside a materialized CTE", async () => {
    const { client, calls } = makeClient();
    const sql = "WITH c AS (SELECT COUNT(*) AS n FROM APP100 "
      + "WHERE 作成者 IN (LOGINUSER()) AND 更新者 NOT IN (LOGINUSER())) "
      + "SELECT * FROM c";

    await expect(execute(sql, client)).resolves.toMatchObject({
      type: "SELECT",
      rows: [{ n: "3" }],
    });
    expect(calls.records.mock.calls[0][0]).toMatchObject({
      fields: ["作成者", "更新者", "$id"],
      query: "作成者 in (LOGINUSER()) and 更新者 not in (LOGINUSER()) "
        + "order by $id asc limit 500 offset 0",
    });

    const explained = planText(await execute(`EXPLAIN ${sql}`, client) as SelectResult);
    expect(explained.match(/kintone function: LOGINUSER/g)).toHaveLength(2);
    expect(explained).toContain(
      "server predicate: 作成者 in (LOGINUSER()) and 更新者 not in (LOGINUSER())"
    );
  });

  test("EXPLAIN fixes LOGINUSER identity and exact server-only payload in aggregate CTE", async () => {
    const { client, calls } = makeClient();
    const sql = "WITH c AS (SELECT COUNT(*) AS n FROM APP100 "
      + "WHERE 作成者 IN (LOGINUSER())) SELECT * FROM c";
    const explained = planText(await execute(`EXPLAIN ${sql}`, client) as SelectResult);

    expect(explained).toContain("kintone function: LOGINUSER");
    expect(explained).not.toContain("kintone function: (unknown)");
    expect(explained).toContain(
      "kintone function evaluation: kintone server whole-WHERE exact"
    );
    expect(explained).toContain("where capability: EXACT_PUSHDOWN");
    expect(explained).toContain("server predicate: 作成者 in (LOGINUSER())");
    expect(explained).toContain("client residual: (none)");
    expect(explained).toContain("kintone function client evaluations: 0");
    expect(explained).toContain("kintone query: 作成者 in (LOGINUSER())");
    expectNoExecutionApi(calls);
  });

  test("Phase2 EXPLAIN keeps LOGINUSER as prefilter and requests residual fields", async () => {
    const { client, calls } = makeClient();
    const sql = "SELECT 作成者, 件名 FROM APP100 "
      + "WHERE 作成者 IN (LOGINUSER()) AND LENGTH(件名) > 1";
    const result = await execute(sql, client) as SelectResult;

    expect(result.rows).toEqual([
      { 作成者: "[{\"code\":\"user\"}]", 件名: "AB" },
      { 作成者: "[{\"code\":\"user\"}]", 件名: "ABC" },
    ]);
    expect(calls.records.mock.calls[0][0]).toMatchObject({
      fields: ["作成者", "件名", "$id"],
      query: "作成者 in (LOGINUSER()) order by $id asc limit 500 offset 0",
    });

    const explainClient = makeClient();
    const explained = planText(
      await execute(`EXPLAIN ${sql}`, explainClient.client) as SelectResult
    );
    expect(explained).toContain("kintone function: LOGINUSER");
    expect(explained).toContain(
      "kintone function evaluation: kintone server exact prefilter"
    );
    expect(explained).toContain("where capability: SUPERSET_PREFILTER");
    expect(explained).toContain("server prefilter: 作成者 in (LOGINUSER())");
    expect(explained).toContain("client residual: LENGTH(件名) > 1");
    expect(explained).toContain("kintone function client evaluations: 0");
    expect(explained).not.toContain("kintone function: (unknown)");
    expectNoExecutionApi(explainClient.calls);
  });

  test.each(["truncate", "error"] as const)(
    "aggregate CTE requires complete input for TODAY/literal onLimit=%s symmetrically",
    async (onLimitReached) => {
      const todaySql = "WITH c AS (SELECT COUNT(*) AS n FROM APP100 "
        + "WHERE 日付 >= TODAY()) SELECT * FROM c";
      const literalSql = "WITH c AS (SELECT COUNT(*) AS n FROM APP100 "
        + "WHERE 日付 >= '2026-07-27') SELECT * FROM c";
      const options = { maxRecords: 2, onLimitReached };
      const expected = onLimitReached === "truncate"
        ? /complete input reason: AGGREGATE。onLimit=truncateは使用できません。.*上限（2 件）/
        : /complete input reason: AGGREGATE。.*上限（2 件）/;

      await expect(execute(todaySql, makeClient().client, options))
        .rejects.toThrow(expected);
      await expect(execute(literalSql, makeClient().client, options))
        .rejects.toThrow(expected);
    }
  );
});
