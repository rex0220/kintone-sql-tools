import {
  execute,
  executeBatch,
  type KintoneClient,
  type KintoneFieldInfo,
  type SelectResult,
} from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";

function record(values: Record<string, unknown>): KintoneRecord {
  return Object.fromEntries(
    Object.entries(values).map(([code, value]) => [code, { value }])
  ) as KintoneRecord;
}

interface B71Client extends KintoneClient {
  readonly getCalls: Array<{ app: number; fields: string[] }>;
  readonly postCalls: unknown[];
}

function makeClient(options: {
  records?: Record<number, KintoneRecord[]>;
  fields?: Record<number, KintoneFieldInfo[]>;
} = {}): B71Client {
  const getCalls: Array<{ app: number; fields: string[] }> = [];
  const postCalls: unknown[] = [];
  const records = options.records ?? {
    100: [
      record({ $id: "1", 金額: "10", 区分: "A", 作成日時: "2026-01-01T00:00:00Z", id: "1", shared: "L1" }),
      record({ $id: "2", 金額: "20", 区分: "A", 作成日時: "2026-01-02T00:00:00Z", id: "2", shared: "L2" }),
      record({ $id: "3", 金額: "30", 区分: "B", 作成日時: "2026-02-01T00:00:00Z", id: "3", shared: "L3" }),
    ],
    200: [
      record({ $id: "11", 区分: "A", id: "1", shared: "R1" }),
      record({ $id: "12", 区分: "B", id: "2", shared: "R2" }),
    ],
  };
  const fields: Record<number, KintoneFieldInfo[]> = options.fields ?? {
    100: ["金額", "区分", "作成日時", "id", "shared"].map((code) => ({
      code,
      label: code,
      fieldType: code === "金額" ? "NUMBER" : "SINGLE_LINE_TEXT",
    })),
    200: ["区分", "id", "shared"].map((code) => ({
      code,
      label: code,
      fieldType: "SINGLE_LINE_TEXT",
    })),
    900: [{ code: "区分", label: "区分", fieldType: "SINGLE_LINE_TEXT", writable: true }],
  };

  return {
    getCalls,
    postCalls,
    async getRecords(params) {
      const requested = [...(params.fields ?? [])];
      getCalls.push({ app: params.app, fields: requested });
      const source = records[params.app] ?? [];
      if (requested.length === 0) return { records: source };
      return {
        records: source.map((row) =>
          Object.fromEntries(
            requested.flatMap((code) => row[code] === undefined ? [] : [[code, row[code]]])
          ) as KintoneRecord
        ),
      };
    },
    async openCursor() { throw new Error("unexpected cursor call"); },
    async postRecords(params) {
      postCalls.push(params);
      return { ids: [] };
    },
    async putRecords() {},
    async deleteRecords() {},
    async getApps() { return []; },
    async getFields(appId) { return fields[appId] ?? []; },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const };
    },
  };
}

function firstFields(client: B71Client, app = 100): string[] {
  return client.getCalls.find((call) => call.app === app)?.fields ?? [];
}

describe("B71 Step 3 schema-aware PHYSICAL / ALIAS_SAFE resolution", () => {
  test.each([
    {
      name: "S2",
      sql: "SELECT 区分 AS 区分, COUNT(*) AS c FROM APP100 GROUP BY 区分",
      fields: ["区分", "$id"],
    },
  ])("$name は実列 区分 で 2 groups を作り必要列だけ fetch する", async ({ sql, fields }) => {
    const client = makeClient();
    const result = await execute(sql, client) as SelectResult;
    expect(result.rowCount).toBe(2);
    expect(firstFields(client)).toEqual(fields);
  });

  test.each([
    {
      name: "S1",
      sql: "SELECT 金額 AS 区分, 区分 AS orig, COUNT(*) AS c FROM APP100 GROUP BY 区分",
      dependency: "金額",
    },
    {
      name: "S3",
      sql: "SELECT 金額 AS 区分, COUNT(*) AS c FROM APP100 GROUP BY 区分",
      dependency: "金額",
    },
    {
      name: "S4",
      sql: "SELECT DATE_FORMAT(作成日時, '%Y-%m') AS 区分, 区分 AS orig, COUNT(*) AS c FROM APP100 GROUP BY 区分",
      dependency: "作成日時",
    },
  ])("$name は実列 区分 を alias より優先し非 grouping dependency を拒否する", async ({ sql, dependency }) => {
    const client = makeClient();
    await expect(execute(sql, client)).rejects.toThrow(
      new RegExp(`非グループ化依存: ${dependency}.*B65_NON_GROUPED_DEPENDENCY`)
    );
    expect(client.getCalls).toHaveLength(0);
  });

  test.each([
    ["A1 DATE_FORMAT", "DATE_FORMAT(作成日時, '%Y-%m')", "年月", "DATE_FORMAT(作成日時, '%Y-%m')"],
    ["A2 field", "区分", "g", "区分"],
    ["A3 arithmetic", "金額 * 2", "m", "金額 * 2"],
    ["literal", "'fixed'", "g", "LEFT(区分, 0)"],
    ["CASE", "CASE WHEN 区分 = 'A' THEN 'A' ELSE 'B' END", "g", "区分"],
    ["string function", "LOWER(区分)", "g", "LOWER(区分)"],
    ["concat", "区分 || '-group'", "g", "区分"],
    ["scalar subquery", "(SELECT 区分 FROM APP200 LIMIT 1)", "g", "LEFT(区分, 0)"],
  ])("%s alias は同じ partition の direct GROUP BY 結果と一致する", async (
    name,
    expression,
    alias,
    directGroup
  ) => {
    const clientOptions = name === "scalar subquery"
      ? { records: {
          100: [
            record({ $id: "1", 金額: "10", 区分: "A", 作成日時: "2026-01-01T00:00:00Z" }),
            record({ $id: "2", 金額: "20", 区分: "A", 作成日時: "2026-01-02T00:00:00Z" }),
            record({ $id: "3", 金額: "30", 区分: "B", 作成日時: "2026-02-01T00:00:00Z" }),
          ],
          200: [record({ $id: "11", 区分: "A" })],
        } }
      : {};
    const aliasClient = makeClient(clientOptions);
    const directClient = makeClient(clientOptions);
    const aliased = await execute(
      `SELECT ${expression} AS ${alias}, COUNT(*) AS c FROM APP100 GROUP BY ${alias}`,
      aliasClient
    ) as SelectResult;
    const direct = await execute(
      `SELECT ${expression} AS ${alias}, COUNT(*) AS c FROM APP100 GROUP BY ${directGroup}`,
      directClient
    ) as SelectResult;
    expect(aliased.rows).toEqual(direct.rows);
    expect(aliased.rowCount).toBe(direct.rowCount);
  });

  test("alias-only GROUP BY は alias 名を fetch せず SELECT 式の依存列だけを取得する", async () => {
    const client = makeClient();
    await execute(
      "SELECT DATE_FORMAT(作成日時, '%Y-%m') AS 年月, COUNT(*) AS c FROM APP100 GROUP BY 年月",
      client
    );
    expect(firstFields(client)).toEqual(["作成日時", "$id"]);
    expect(firstFields(client)).not.toContain("年月");
  });

  test("PHYSICAL + ALIAS_SAFE + direct expression を item 順に組み合わせられる", async () => {
    const aliasClient = makeClient();
    const directClient = makeClient();
    const aliased = await execute(
      "SELECT 区分, DATE_FORMAT(作成日時, '%Y-%m') AS 年月, 金額 * 2 AS 倍額, COUNT(*) AS c " +
      "FROM APP100 GROUP BY 区分, 年月, 金額 * 2",
      aliasClient
    ) as SelectResult;
    const direct = await execute(
      "SELECT 区分, DATE_FORMAT(作成日時, '%Y-%m') AS 年月, 金額 * 2 AS 倍額, COUNT(*) AS c " +
      "FROM APP100 GROUP BY 区分, DATE_FORMAT(作成日時, '%Y-%m'), 金額 * 2",
      directClient
    ) as SelectResult;
    expect(aliased.rows).toEqual(direct.rows);
    expect(firstFields(aliasClient)).toEqual(["区分", "作成日時", "金額", "$id"]);
  });

  test.each([
    "COUNT",
    "SUM",
    "AVG",
    "MAX",
    "MIN",
    "GROUP_CONCAT",
    "STDDEV_POP",
    "STDDEV_SAMP",
    "VAR_POP",
    "VAR_SAMP",
    "MEDIAN",
    "MODE",
  ])("%s alias は aggregate reason code で records API 前に拒否する", async (func) => {
    const arg = func === "COUNT" ? "*" : "金額";
    const client = makeClient();
    await expect(
      execute(`SELECT ${func}(${arg}) AS g FROM APP100 GROUP BY g`, client)
    ).rejects.toThrow(/GROUP_BY_ALIAS_AGGREGATE/);
    expect(client.getCalls).toHaveLength(0);
  });

  test.each([
    ["ARITH_AGG", "SELECT SUM(金額) + 1 AS g FROM APP100 GROUP BY g"],
    ["aggregate CASE", "SELECT CASE WHEN SUM(金額) > 0 THEN 'Y' ELSE 'N' END AS g FROM APP100 GROUP BY g"],
    ["aggregate STRFUNC", "SELECT FORMAT(SUM(金額), '0') AS g FROM APP100 GROUP BY g"],
    ["aggregate SCALAR", "SELECT FORMAT(SUM(金額), '0') || '円' AS g FROM APP100 GROUP BY g"],
    ["aggregate synthetic", "SELECT SUM(金額) FROM APP100 GROUP BY `SUM(金額)`"],
  ])("%s も aggregate reason code で fail-closed", async (_name, sql) => {
    const client = makeClient();
    await expect(execute(sql, client)).rejects.toThrow(/GROUP_BY_ALIAS_AGGREGATE/);
    expect(client.getCalls).toHaveLength(0);
  });

  test("物理 miss の duplicate alias は ambiguous reason code で拒否する", async () => {
    const client = makeClient();
    await expect(
      execute("SELECT 金額 AS g, 区分 AS g FROM APP100 GROUP BY g", client)
    ).rejects.toThrow(/GROUP_BY_ALIAS_AMBIGUOUS/);
    expect(client.getCalls).toHaveLength(0);
  });

  test("GROUPING alias は既存 B65 static guard が records API 前に拒否する", async () => {
    const client = makeClient();
    await expect(
      execute("SELECT GROUPING(区分) AS g FROM APP100 GROUP BY g", client)
    ).rejects.toThrow(/GROUPING\(\) requires GROUP BY ROLLUP or GROUPING SETS/);
    expect(client.getCalls).toHaveLength(0);
  });

  test("JOIN の非修飾物理列 ambiguity は alias fallback せず拒否する", async () => {
    const client = makeClient();
    await expect(execute(
      "SELECT a.金額 AS shared, COUNT(*) AS c FROM APP100 a " +
      "JOIN APP200 b ON a.id = b.id GROUP BY shared",
      client
    )).rejects.toThrow(/GROUP_BY_FIELD_AMBIGUOUS/);
    expect(client.getCalls).toHaveLength(0);
  });

  test.each(["a.unknown", "unknown"])("%s は unknown field として records API 前に拒否する", async (name) => {
    const client = makeClient();
    await expect(
      execute(`SELECT COUNT(*) AS c FROM APP100 a GROUP BY ${name}`, client)
    ).rejects.toThrow(/unknown field code\(s\)/);
    expect(client.getCalls).toHaveLength(0);
  });

  test.each([
    "レコード番号",
    "作成者",
    "作成日時",
    "更新者",
    "更新日時",
    "ステータス",
    "作業者",
  ])("getFields() にない kintone system field %s も APP の PHYSICAL になる", async (field) => {
    const client = makeClient({
      records: { 100: [record({ $id: "1", [field]: "system-value" })] },
      fields: { 100: [] },
    });
    const result = await execute(
      `SELECT ${field}, COUNT(*) AS c FROM APP100 GROUP BY ${field}`,
      client
    ) as SelectResult;
    expect(result.rows).toEqual([{ [field]: "system-value", c: "1" }]);
    expect(firstFields(client)).toEqual([field, "$id"]);
  });
});

describe("B71 Step 2 subtable/materialized schema", () => {
  function subtableClient(): B71Client {
    return makeClient({
      records: {
        100: [
          record({
            $id: "1",
            親項目: "P1",
            明細: [
              { id: "r1", value: { 数量: { value: "1" } } },
              { id: "r2", value: { 数量: { value: "2" } } },
            ],
          }),
          record({
            $id: "2",
            親項目: "P2",
            明細: [{ id: "r3", value: { 数量: { value: "1" } } }],
          }),
        ],
      },
      fields: {
        100: [
          { code: "親項目", label: "親項目", fieldType: "SINGLE_LINE_TEXT" },
          { code: "明細", label: "明細", fieldType: "SUBTABLE" },
          { code: "数量", label: "数量", fieldType: "NUMBER", inSubtable: true, subtableCode: "明細" },
        ],
      },
    });
  }

  test.each([
    ["_pid", 2, ["明細", "$id"]],
    ["_rid", 3, ["明細", "$id"]],
    ["_idx", 2, ["明細", "$id"]],
    ["数量", 2, ["明細", "$id"]],
    ["_p.親項目", 2, ["親項目", "明細", "$id"]],
  ])("%s は subtable virtual PHYSICAL として解決する", async (key, groups, fields) => {
    const client = subtableClient();
    const result = await execute(
      `SELECT ${key}, COUNT(*) AS c FROM APP100$明細 GROUP BY ${key}`,
      client
    ) as SelectResult;
    expect(result.rowCount).toBe(groups);
    expect(firstFields(client)).toEqual(fields);
  });

  test("0 rows の CTE columns は同名 alias より PHYSICAL を優先する", async () => {
    const client = makeClient({ records: { 100: [] } });
    const result = await execute(
      "WITH c AS (SELECT DISTINCT 区分 AS g FROM APP100) " +
      "SELECT g AS g, COUNT(*) AS c FROM c GROUP BY g",
      client
    ) as SelectResult;
    expect(result).toMatchObject({ rows: [], rowCount: 0 });
    expect(client.getCalls).toHaveLength(1);
  });

  test("0 rows の temp columns も同名 alias より PHYSICAL を優先する", async () => {
    const client = makeClient({ records: { 100: [] } });
    await expect(executeBatch(
      "CREATE TEMP TABLE #t AS SELECT 区分 AS g FROM APP100; " +
      "SELECT g AS g, COUNT(*) AS c FROM #t GROUP BY g",
      client
    )).resolves.toBeDefined();
    expect(client.getCalls).toHaveLength(1);
  });
});

describe("B71 Step 3 nested SELECT paths", () => {
  test("CTE body: ALIAS_SAFE positive", async () => {
    const positive = makeClient();
    const result = await execute(
      "WITH c AS (SELECT 区分 AS g, COUNT(*) AS c FROM APP100 GROUP BY g) SELECT * FROM c",
      positive
    ) as SelectResult;
    expect(result.rowCount).toBe(2);
    expect(result.rows).toEqual([{ g: "A", c: "2" }, { g: "B", c: "1" }]);
  });

  test("UNION の左右 branch: ALIAS_SAFE positive", async () => {
    const positive = makeClient();
    const result = await execute(
      "SELECT 区分 AS g, COUNT(*) AS c FROM APP100 GROUP BY g " +
      "UNION ALL SELECT 区分 AS g, COUNT(*) AS c FROM APP200 GROUP BY g",
      positive
    ) as SelectResult;
    expect(result.rowCount).toBe(4);
  });

  test("scalar subquery body: ALIAS_SAFE positive", async () => {
    const positive = makeClient({
      records: {
        100: [record({ $id: "1", 区分: "outer" })],
        200: [
          record({ $id: "2", 区分: "inner" }),
          record({ $id: "3", 区分: "inner" }),
        ],
      },
    });
    const result = await execute(
      "SELECT (SELECT 区分 AS g FROM APP200 GROUP BY g) AS n FROM APP100 LIMIT 1",
      positive
    ) as SelectResult;
    expect(result.rows).toEqual([{ n: "inner" }]);
  });

  test("DML source SELECT: ALIAS_SAFE positive", async () => {
    const positive = makeClient();
    const result = await execute(
      "INSERT INTO APP900 (区分) SELECT 区分 AS g FROM APP100 GROUP BY g VALIDATE ONLY",
      positive
    );
    expect(result).toMatchObject({ type: "VALIDATION", validatedRows: 2, errorCount: 0 });
    expect(positive.getCalls.length).toBeGreaterThan(0);
    expect(positive.postCalls).toHaveLength(0);
  });

  test("CREATE TEMP TABLE AS SELECT: ALIAS_SAFE positive", async () => {
    const positive = makeClient();
    const batch = await executeBatch(
      "CREATE TEMP TABLE #t AS SELECT 区分 AS g, COUNT(*) AS c FROM APP100 GROUP BY g; " +
      "SELECT * FROM #t",
      positive
    );
    expect(batch).toMatchObject({ ok: true });
    expect(batch.statements[1]).toMatchObject({
      status: "success",
      result: { rows: [{ g: "A", c: "2" }, { g: "B", c: "1" }] },
    });
  });
});

describe("B71 Step 2 EXPLAIN", () => {
  test("direct APP は runtime と同じ PHYSICAL 解決後に bare dependency を拒否する", async () => {
    const client = makeClient();
    await expect(execute(
      "EXPLAIN SELECT 金額 AS 区分, COUNT(*) AS c FROM APP100 GROUP BY 区分",
      client
    )).rejects.toThrow(/非グループ化依存: 金額.*B65_NON_GROUPED_DEPENDENCY/);
    expect(client.getCalls).toHaveLength(0);
  });

  test("materialized schema を伝播して alias を ALIAS_SAFE と確定する", async () => {
    const client = makeClient();
    const result = await execute(
      "EXPLAIN WITH c AS (SELECT 区分 AS g FROM APP100) " +
      "SELECT g AS x, COUNT(*) AS c FROM c GROUP BY x",
      client
    ) as SelectResult;
    const plan = result.rows.map((row) => row["plan"]).join("\n");
    expect(plan).toContain("group key x: ALIAS_SAFE (column=0)");
    expect(client.getCalls).toHaveLength(0);
  });
});
