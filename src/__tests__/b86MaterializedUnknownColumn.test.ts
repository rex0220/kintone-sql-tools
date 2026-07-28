import {
  execute,
  executeBatch,
  type KintoneClient,
  type KintoneFieldInfo,
  type SelectResult,
} from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";
import { runQuery } from "../engine-library/query";
import { runBatch } from "../engine-library/batch";

function record(fields: Record<string, string>): KintoneRecord {
  return Object.fromEntries(
    Object.entries(fields).map(([field, value]) => [field, { value }])
  );
}

function makeClient(options: {
  records?: Record<number, KintoneRecord[]>;
  fields?: Record<number, KintoneFieldInfo[]>;
  emptyMetadata?: boolean;
} = {}) {
  const getRecords = jest.fn(async (params: { app: number }) => ({
    records: options.records?.[params.app] ?? [],
  }));
  const openCursor = jest.fn(async () => { throw new Error("unexpected cursor"); });
  const postRecords = jest.fn(async () => ({ ids: ["1"] }));
  const putRecords = jest.fn(async () => undefined);
  const deleteRecords = jest.fn(async () => undefined);
  const getApps = jest.fn(async () => [
    { appId: 100, name: "顧客管理", description: "顧客" },
    { appId: 200, name: "案件管理", description: "案件" },
  ]);
  const getFields = jest.fn(async (appId: number) => {
    if (options.emptyMetadata) return [];
    return options.fields?.[appId] ?? [];
  });
  const client: KintoneClient = {
    getRecords,
    openCursor,
    postRecords,
    putRecords,
    deleteRecords,
    getApps,
    getFields,
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const };
    },
  };
  return {
    client,
    getRecords,
    openCursor,
    postRecords,
    putRecords,
    deleteRecords,
    getApps,
    getFields,
  };
}

const physicalFields: Record<number, KintoneFieldInfo[]> = {
  100: [
    { code: "x", label: "x", fieldType: "SINGLE_LINE_TEXT" },
    { code: "k", label: "k", fieldType: "SINGLE_LINE_TEXT" },
  ],
  200: [
    { code: "z", label: "z", fieldType: "SINGLE_LINE_TEXT" },
    { code: "k", label: "k", fieldType: "SINGLE_LINE_TEXT" },
    { code: "dest", label: "dest", fieldType: "SINGLE_LINE_TEXT" },
  ],
};

test.each(["LIKE", "="])("B86: SHOW APPS CTE の不存在右辺を %s でも拒否する", async (op) => {
  const mock = makeClient();
  await expect(execute(
    `WITH a AS (SHOW APPS) SELECT アプリ名 FROM a WHERE アプリ名 ${op} missing`,
    mock.client
  )).rejects.toThrow(/unknown field code\(s\): missing \(a\)/);
  expect(mock.getRecords).not.toHaveBeenCalled();
  expect(mock.postRecords).not.toHaveBeenCalled();
  expect(mock.putRecords).not.toHaveBeenCalled();
});

test("B86: 引用済み literal と実在列同士の LIKE は従来どおり成功する", async () => {
  const mock = makeClient();
  const literal = await execute(
    "WITH a AS (SHOW APPS) SELECT アプリ名 FROM a WHERE アプリ名 LIKE '顧客'",
    mock.client
  ) as SelectResult;
  const field = await execute(
    "WITH a AS (SHOW APPS) SELECT アプリ名 FROM a WHERE アプリ名 LIKE 説明",
    mock.client
  ) as SelectResult;
  expect(literal.rows).toEqual([{ アプリ名: "顧客管理" }]);
  expect(field.rows).toEqual([{ アプリ名: "顧客管理" }, { アプリ名: "案件管理" }]);
});

test("B86: alias 実体化後は出力名だけを有効にする", async () => {
  const mock = makeClient();
  const valid = await execute(
    "WITH c AS (SELECT 'ok' AS y) SELECT y FROM c",
    mock.client
  ) as SelectResult;
  expect(valid.rows).toEqual([{ y: "ok" }]);
  await expect(execute(
    "WITH c AS (SELECT 'ok' AS y) SELECT x FROM c",
    mock.client
  )).rejects.toThrow(/unknown field code\(s\): x \(c\)/);
});

test("B86: defs=[] でも materialized columns が非空なら検証を省略しない", async () => {
  const mock = makeClient({ emptyMetadata: true });
  await expect(execute(
    "WITH c AS (SELECT 'ok' AS y) SELECT y FROM c WHERE y = x",
    mock.client
  )).rejects.toThrow(/unknown field code\(s\): x \(c\)/);
});

test("B86: DESCRIBE と物理由来の非インライン CTE も同じ source schema で検証する", async () => {
  const describe = makeClient({ fields: physicalFields });
  await expect(execute(
    "WITH d AS (DESCRIBE APP100) " +
      "SELECT フィールドコード FROM d WHERE フィールドコード = missing",
    describe.client
  )).rejects.toThrow(/unknown field code\(s\): missing \(d\)/);

  const physical = makeClient({
    fields: physicalFields,
    records: { 100: [record({ x: "ok", k: "1" })] },
  });
  await expect(execute(
    "WITH c AS (SELECT x AS y FROM APP100 WHERE x LIKE '%') " +
      "SELECT y FROM c WHERE y = missing",
    physical.client
  )).rejects.toThrow(/unknown field code\(s\): missing \(c\)/);
});

test.each([
  "SELECT missing FROM #t",
  "SELECT y FROM #t WHERE missing = 'x'",
  "SELECT missing + 1 AS v FROM #t",
  "SELECT UPPER(missing) AS v FROM #t",
  "SELECT CASE WHEN missing = 'x' THEN 'a' ELSE 'b' END AS v FROM #t",
  "SELECT MAX(missing) AS v FROM #t",
  "SELECT y, COUNT(*) AS n FROM #t GROUP BY y HAVING missing = 'x'",
  "SELECT y FROM #t ORDER BY missing",
  "SELECT ROW_NUMBER() OVER (PARTITION BY missing ORDER BY y) AS rn FROM #t",
])("B86: 全列参照位置を同じ collector で拒否する: %s", async (query) => {
  const mock = makeClient();
  const result = await executeBatch(
    `CREATE TEMP TABLE #t AS SELECT 'ok' AS y;${query}`,
    mock.client
  );
  expect(result.ok).toBe(false);
  expect(result.statements[1].error?.message).toMatch(/unknown field code\(s\): missing \(#t\)/);
});

test.each([
  [
    "materialized",
    "WITH c AS (SELECT '1' AS k, 'left' AS y) " +
      "SELECT c.y FROM c INNER JOIN APP200 AS p ON c.k = p.k WHERE c.y = c.missing",
    /unknown field code\(s\): missing \(c\)/,
  ],
  [
    "physical",
    "WITH c AS (SELECT '1' AS k, 'left' AS y) " +
      "SELECT c.y FROM c INNER JOIN APP200 AS p ON c.k = p.k WHERE p.z = p.missing",
    /unknown field code\(s\): missing \(APP200\)/,
  ],
])("B86: mixed JOIN の %s 側を records GET 前に検証する", async (_side, sql, message) => {
  const mock = makeClient({ fields: physicalFields });
  await expect(execute(sql, mock.client)).rejects.toThrow(message);
  expect(mock.getRecords).not.toHaveBeenCalled();
});

test("B86: JOIN ON の materialized 不存在列は B51 message のまま取得前に拒否する", async () => {
  const mock = makeClient({ fields: physicalFields });
  await expect(execute(
    "WITH c AS (SELECT '1' AS k) " +
      "SELECT c.k FROM c INNER JOIN APP200 AS p ON c.missing = p.k",
    mock.client
  )).rejects.toThrow(/JOIN key c\.missing is not available/);
  expect(mock.getRecords).not.toHaveBeenCalled();
});

test("B86: UNION の不正枝を sibling records GET 開始前に拒否する", async () => {
  const mock = makeClient({ fields: physicalFields });
  const result = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT 'ok' AS y;" +
      "SELECT missing FROM #t UNION ALL SELECT z FROM APP200",
    mock.client
  );
  expect(result.ok).toBe(false);
  expect(result.statements[1].error?.message).toMatch(/unknown field code\(s\): missing \(#t\)/);
  expect(mock.getRecords).not.toHaveBeenCalled();
});

test("B86: UNION の右不正枝も左枝 records GET 開始前に拒否する", async () => {
  const mock = makeClient({ fields: physicalFields });
  const result = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT 'ok' AS y;" +
      "SELECT z FROM APP200 UNION ALL SELECT missing FROM #t",
    mock.client
  );
  expect(result.ok).toBe(false);
  expect(result.statements[1].error?.message).toMatch(/unknown field code\(s\): missing \(#t\)/);
  expect(mock.getRecords).not.toHaveBeenCalled();
});

test("B86: UNION 実体化後は左枝の列名だけを有効にする", async () => {
  const mock = makeClient();
  const valid = await execute(
    "WITH c AS (SELECT 'a' AS y UNION ALL SELECT 'b' AS q) SELECT y FROM c",
    mock.client
  ) as SelectResult;
  expect(valid.rows).toEqual([{ y: "a" }, { y: "b" }]);
  await expect(execute(
    "WITH c AS (SELECT 'a' AS y UNION ALL SELECT 'b' AS q) SELECT q FROM c",
    mock.client
  )).rejects.toThrow(/unknown field code\(s\): q \(c\)/);
});

test.each([
  "SELECT z FROM APP200 WHERE z IN (SELECT missing FROM #t)",
  "SELECT z FROM APP200 WHERE z = (SELECT missing FROM #t LIMIT 1)",
  "SELECT z FROM APP200 WHERE EXISTS (SELECT missing FROM #t)",
  "SELECT (SELECT missing FROM #t LIMIT 1) AS v FROM APP200",
])("B86: subquery の不存在列を外側 records GET 前に拒否する: %s", async (query) => {
  const mock = makeClient({ fields: physicalFields });
  const result = await executeBatch(
    `CREATE TEMP TABLE #t AS SELECT 'ok' AS y;${query}`,
    mock.client
  );
  expect(result.ok).toBe(false);
  expect(result.statements[1].error?.message).toMatch(/unknown field code\(s\): missing \(#t\)/);
  expect(mock.getRecords).not.toHaveBeenCalled();
});

test("B86: 不正な外側 SELECT は subquery の records GET も開始しない", async () => {
  const mock = makeClient({ fields: physicalFields });
  const result = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT 'ok' AS y;" +
      "SELECT missing FROM #t WHERE y IN (SELECT z FROM APP200)",
    mock.client
  );
  expect(result.ok).toBe(false);
  expect(result.statements[1].error?.message).toMatch(/unknown field code\(s\): missing \(#t\)/);
  expect(mock.getRecords).not.toHaveBeenCalled();
});

test("B86: INSERT SELECT の検証失敗時は records GET / confirm / POST / PUT がすべて 0", async () => {
  const mock = makeClient({ fields: physicalFields });
  const confirm = jest.fn(async () => true);
  const result = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT 'ok' AS y;" +
      "INSERT INTO APP200 (dest) SELECT missing FROM #t",
    mock.client,
    { confirm }
  );
  expect(result.ok).toBe(false);
  expect(result.statements[1].error?.message).toMatch(/unknown field code\(s\): missing \(#t\)/);
  expect(mock.getRecords).toHaveBeenCalledTimes(0);
  expect(confirm).toHaveBeenCalledTimes(0);
  expect(mock.postRecords).toHaveBeenCalledTimes(0);
  expect(mock.putRecords).toHaveBeenCalledTimes(0);
  expect(mock.deleteRecords).toHaveBeenCalledTimes(0);
});

test.each([
  "INSERT INTO APP200 (dest) SELECT missing FROM #t VALIDATE ONLY",
  "INSERT INTO APP200 (dest) SELECT missing FROM #t ON ERROR SKIP INTO #err",
  "UPSERT INTO APP200 (dest) SELECT missing FROM #t ON DUPLICATE (dest)",
  "UPSERT INTO APP200 (dest) SELECT missing FROM #t ON DUPLICATE (dest) VALIDATE ONLY",
  "UPSERT INTO APP200 (dest) SELECT missing FROM #t ON DUPLICATE (dest) ON ERROR SKIP INTO #err",
])("B86: SELECT-based DML の全制御形を source preflight で書込み前拒否する: %s", async (dml) => {
  const mock = makeClient({ fields: physicalFields });
  const confirm = jest.fn(async () => true);
  const result = await executeBatch(
    `CREATE TEMP TABLE #t AS SELECT 'ok' AS y;${dml}`,
    mock.client,
    { confirm }
  );
  expect(result.ok).toBe(false);
  expect(result.statements[1].error?.message).toMatch(/unknown field code\(s\): missing \(#t\)/);
  expect(mock.getRecords).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
  expect(mock.postRecords).not.toHaveBeenCalled();
  expect(mock.putRecords).not.toHaveBeenCalled();
  expect(mock.deleteRecords).not.toHaveBeenCalled();
});

test("B86: 0行でも columns が保存済みなら不存在列を拒否する", async () => {
  const mock = makeClient({ fields: physicalFields });
  const result = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT x AS y FROM APP100;" +
      "SELECT missing FROM #t",
    mock.client
  );
  expect(result.ok).toBe(false);
  expect(result.statements[1].error?.message).toMatch(/unknown field code\(s\): missing \(#t\)/);
});

test("B86: rows=[] && columns=[] の JOIN なし読出しは既存の 0 行挙動を維持する", async () => {
  const mock = makeClient({ fields: physicalFields });
  const result = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT * FROM APP100;" +
      "SELECT missing FROM #t",
    mock.client
  );
  expect(result.ok).toBe(true);
  expect((result.statements[1].result as SelectResult).rows).toEqual([]);
});

test("B86: rows=[] && columns=[] を JOIN 入力にすると downstream records GET 前に拒否する", async () => {
  const mock = makeClient({ fields: physicalFields });
  const result = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT * FROM APP100;" +
      "SELECT p.z FROM #t AS t INNER JOIN APP200 AS p ON t.k = p.k",
    mock.client
  );
  expect(result.ok).toBe(false);
  expect(result.statements[1].error?.message)
    .toMatch(/column schema is unavailable for materialized JOIN source #t/);
  expect(mock.getRecords.mock.calls.map(([params]) => params.app)).toEqual([100]);
});

test("B86: engine library runQuery も shared runtime の ArgumentError を返す", async () => {
  const mock = makeClient();
  await expect(runQuery(
    "WITH a AS (SHOW APPS) SELECT アプリ名 FROM a WHERE アプリ名 LIKE missing",
    { client: mock.client }
  )).rejects.toMatchObject({
    name: "KsqlEngineError",
    code: "EXECUTION_ERROR",
    message: expect.stringMatching(/ArgumentError: unknown field code\(s\): missing \(a\)/),
  });
  expect(mock.getRecords).not.toHaveBeenCalled();
});

test("B86: engine library runBatch は失敗文を示し部分結果を返さない", async () => {
  const mock = makeClient();
  await expect(runBatch(
    "CREATE TEMP TABLE #t AS SELECT 'ok' AS y;SELECT missing FROM #t",
    { client: mock.client }
  )).rejects.toMatchObject({
    name: "KsqlEngineError",
    code: "EXECUTION_ERROR",
    message: expect.stringMatching(/ArgumentError: unknown field code\(s\): missing \(#t\)/),
    statementIndex: 1,
    statementType: "SELECT",
  });
  expect(mock.getRecords).not.toHaveBeenCalled();
});
