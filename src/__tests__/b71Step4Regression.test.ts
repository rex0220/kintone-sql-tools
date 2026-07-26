import {
  execute,
  executeBatch,
  type KintoneClient,
  type KintoneFieldInfo,
  type SelectResult,
} from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";
import { normalizeSqlAppProfiles } from "../node/appProfiles";

function record(values: Record<string, unknown>): KintoneRecord {
  return Object.fromEntries(
    Object.entries(values).map(([code, value]) => [code, { value }])
  ) as KintoneRecord;
}

interface RegressionClient extends KintoneClient {
  readonly getRecords: jest.MockedFunction<KintoneClient["getRecords"]>;
  readonly getFields: jest.MockedFunction<KintoneClient["getFields"]>;
  readonly postRecords: jest.MockedFunction<KintoneClient["postRecords"]>;
}

const defaultRecords: Record<number, KintoneRecord[]> = {
  100: [
    record({ $id: "1", id: "1", 区分: "A", 金額: "20", 名前: "z", 作成日時: "2026-01-01T00:00:00Z" }),
    record({ $id: "2", id: "2", 区分: "A", 金額: "3", 名前: "a", 作成日時: "2026-01-02T00:00:00Z" }),
    record({ $id: "3", id: "3", 区分: "B", 金額: "10", 名前: "m", 作成日時: "2026-02-01T00:00:00Z" }),
  ],
  200: [
    record({ $id: "11", id: "1", 区分: "A", 種別: "L" }),
    record({ $id: "12", id: "3", 区分: "B", 種別: "R" }),
  ],
};

const defaultFields: Record<number, KintoneFieldInfo[]> = {
  100: [
    { code: "id", label: "id", fieldType: "SINGLE_LINE_TEXT" },
    { code: "区分", label: "区分", fieldType: "SINGLE_LINE_TEXT" },
    { code: "金額", label: "金額", fieldType: "NUMBER" },
    { code: "名前", label: "名前", fieldType: "SINGLE_LINE_TEXT" },
    { code: "作成日時", label: "作成日時", fieldType: "DATETIME" },
  ],
  200: [
    { code: "id", label: "id", fieldType: "SINGLE_LINE_TEXT" },
    { code: "区分", label: "区分", fieldType: "SINGLE_LINE_TEXT" },
    { code: "種別", label: "種別", fieldType: "SINGLE_LINE_TEXT" },
  ],
  900: [
    { code: "区分", label: "区分", fieldType: "SINGLE_LINE_TEXT", writable: true },
  ],
};

function makeClient(options: {
  records?: Record<number, KintoneRecord[]>;
  fields?: Record<number, KintoneFieldInfo[]>;
} = {}): RegressionClient {
  const records = options.records ?? defaultRecords;
  const fields = options.fields ?? defaultFields;
  const getRecords = jest.fn(async (params: Parameters<KintoneClient["getRecords"]>[0]) => {
    const source = records[params.app] ?? [];
    const requested = params.fields ?? [];
    // B71 §9.11.1: fields 指定外の値は返さない。
    return {
      records: source.map((row) => Object.fromEntries(
        requested.flatMap((code) => row[code] === undefined ? [] : [[code, row[code]]])
      ) as KintoneRecord),
    };
  });
  const getFields = jest.fn(async (appId: number) => fields[appId] ?? []);
  const postRecords = jest.fn(async (
    _params: Parameters<KintoneClient["postRecords"]>[0]
  ) => ({ ids: [] as string[] }));
  return {
    getRecords,
    getFields,
    postRecords,
    async openCursor() { throw new Error("unexpected cursor call"); },
    async putRecords() {},
    async deleteRecords() {},
    async getApps() { return []; },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const };
    },
  };
}

function fetchedFields(client: RegressionClient, app: number): string[][] {
  return client.getRecords.mock.calls
    .filter(([params]) => params.app === app)
    .map(([params]) => [...(params.fields ?? [])]);
}

describe("B71 Step 4 narrow ambiguity regression", () => {
  test("GROUP BY が参照しない重複 alias は projection・ORDER BY 後勝ちを維持する", async () => {
    const client = makeClient();
    const result = await execute(
      "SELECT 区分, 金額 AS x, 名前 AS x, COUNT(*) AS c " +
      "FROM APP100 GROUP BY 区分 ORDER BY x ASC",
      client
    ) as SelectResult;

    expect(result.rows).toEqual([
      { 区分: "B", x: "m", c: "1" },
      { 区分: "A", x: "z", c: "2" },
    ]);
    expect(result.columns).toEqual(["区分", "x", "x", "c"]);
  });

  test("重複 alias と同名の実列があれば PHYSICAL として受理する", async () => {
    const client = makeClient();
    const result = await execute(
      "SELECT 金額 AS 区分, 名前 AS 区分, COUNT(*) AS c FROM APP100 GROUP BY 区分",
      client
    ) as SelectResult;

    expect(result.rowCount).toBe(2);
    expect(fetchedFields(client, 100)[0]).toEqual(["金額", "名前", "区分", "$id"]);
  });

  test("DISTINCT tuple と projection key は GROUP BY 後も従来どおり", async () => {
    const client = makeClient();
    const result = await execute(
      "SELECT DISTINCT 区分 AS k, 'same' AS v FROM APP100 GROUP BY 区分 ORDER BY k",
      client
    ) as SelectResult;

    expect(result.columns).toEqual(["k", "v"]);
    expect(result.rows).toEqual([{ k: "A", v: "same" }, { k: "B", v: "same" }]);
  });

  test("qualified GROUP BY field は同名 SELECT alias に fallback しない", async () => {
    const client = makeClient();
    await expect(execute(
      "SELECT 金額 AS `a.missing`, COUNT(*) AS c FROM APP100 a GROUP BY a.missing",
      client
    )).rejects.toThrow(
      "ArgumentError: unknown field code(s): a.missing (APP100)"
    );
    expect(client.getRecords).not.toHaveBeenCalled();
  });
});

describe("B71 Step 4 fetched-fields regression", () => {
  test.each([
    ["plain SELECT", "SELECT 区分 FROM APP100", ["区分", "$id"]],
    ["ORDER BY alias", "SELECT 金額 AS m FROM APP100 ORDER BY m", ["金額", "$id"]],
    [
      "HAVING alias",
      "SELECT 区分, COUNT(*) AS c FROM APP100 GROUP BY 区分 HAVING c > 1",
      ["区分", "$id"],
    ],
    ["DISTINCT", "SELECT DISTINCT 区分 FROM APP100", ["区分", "$id"]],
  ])("%s は B71 前の取得列を維持する", async (_name, sql, expected) => {
    const client = makeClient();
    await execute(sql, client);
    const calls = fetchedFields(client, 100);
    expect(calls).toHaveLength(1);
    expect(new Set(calls[0])).toEqual(new Set(expected));
    expect(client.getFields).toHaveBeenCalledTimes(1);
  });

  test("JOIN は source ごとの取得列を維持する", async () => {
    const client = makeClient();
    await execute(
      "SELECT a.区分, b.種別 FROM APP100 a JOIN APP200 b ON a.id = b.id",
      client
    );
    expect(fetchedFields(client, 100)).toEqual([["区分", "id", "$id"]]);
    expect(fetchedFields(client, 200)).toEqual([["種別", "id", "$id"]]);
    expect(client.getFields).toHaveBeenCalledTimes(2);
  });

  test("subtable と _p.<親 field> は必要な親 field・subtable 本体だけ取得する", async () => {
    const client = makeClient({
      records: {
        100: [record({
          $id: "1",
          親項目: "P1",
          明細: [{ id: "r1", value: { 数量: { value: "2" } } }],
        })],
      },
      fields: {
        100: [
          { code: "親項目", label: "親項目", fieldType: "SINGLE_LINE_TEXT" },
          { code: "明細", label: "明細", fieldType: "SUBTABLE" },
          { code: "数量", label: "数量", fieldType: "NUMBER", inSubtable: true, subtableCode: "明細" },
        ],
      },
    });
    const result = await execute(
      "SELECT 数量, _p.親項目 FROM APP100$明細",
      client
    ) as SelectResult;
    expect(result.rows).toEqual([{ 数量: "2", "_p.親項目": "P1" }]);
    const calls = fetchedFields(client, 100);
    expect(calls).toHaveLength(1);
    expect(new Set(calls[0])).toEqual(new Set(["明細", "親項目", "$id"]));
    expect(client.getFields).toHaveBeenCalledTimes(1);
  });
});

describe("B71 Step 4 surface regression", () => {
  test("DISTINCT + PHYSICAL/ALIAS_SAFE GROUP BY は同じ tuple を返す", async () => {
    const physical = await execute(
      "SELECT DISTINCT 区分 AS g, COUNT(*) AS c FROM APP100 GROUP BY 区分 ORDER BY g",
      makeClient()
    ) as SelectResult;
    const alias = await execute(
      "SELECT DISTINCT 区分 AS g, COUNT(*) AS c FROM APP100 GROUP BY g ORDER BY g",
      makeClient()
    ) as SelectResult;
    expect(alias.rows).toEqual(physical.rows);
    expect(alias.rows).toEqual([{ g: "A", c: "2" }, { g: "B", c: "1" }]);
  });

  test("B59 alias shadowing・重複 alias 後勝ちを GROUP BY query でも維持する", async () => {
    const shadow = await execute(
      "SELECT 区分, 金額 AS 名前, COUNT(*) AS c FROM APP100 GROUP BY 区分 ORDER BY 名前",
      makeClient()
    ) as SelectResult;
    const duplicate = await execute(
      "SELECT 区分, 金額 AS x, 名前 AS x, COUNT(*) AS c FROM APP100 GROUP BY 区分 ORDER BY x",
      makeClient()
    ) as SelectResult;
    expect(shadow.rows.map((row) => row.区分)).toEqual(["B", "A"]);
    expect(duplicate.rows.map((row) => row.区分)).toEqual(["B", "A"]);
  });

  test("GROUP BY は canonical ORDER を受理し KORDER は既存 shape error で拒否する", async () => {
    await expect(execute(
      "SELECT 区分, COUNT(*) AS c FROM APP100 GROUP BY 区分 ORDER BY 区分",
      makeClient()
    )).resolves.toMatchObject({ rowCount: 2 });
    await expect(execute(
      "SELECT 区分, COUNT(*) AS c FROM APP100 GROUP BY 区分 KORDER BY 区分 LIMIT 2",
      makeClient()
    )).rejects.toThrow(/KORDER_QUERY_SHAPE_UNSUPPORTED/);
  });

  test.each([
    ["ROLLUP", "SELECT 金額 AS g, COUNT(*) FROM APP100 GROUP BY ROLLUP(g)"],
    [
      "GROUPING SETS",
      "SELECT 金額 AS g, COUNT(*) FROM APP100 GROUP BY GROUPING SETS ((g),())",
    ],
  ])("B65 %s の alias grouping item は既存 message で拒否する", async (_name, sql) => {
    const client = makeClient();
    await expect(execute(sql, client)).rejects.toThrow(
      /B65 field g does not exist in a physical APP source/
    );
    expect(client.getRecords).not.toHaveBeenCalled();
  });

  test.each([
    ["physical", "SELECT 区分, COUNT(*) AS c FROM APP1234 GROUP BY 区分"],
    ["alias", "SELECT 区分 AS g, COUNT(*) AS c FROM APP1234 GROUP BY g"],
  ])("LAPP %s GROUP BY は direct APP と同じ planning/result", async (_name, directSql) => {
    const logicalSql = directSql.replace("APP1234", "LAPP_ORDERS");
    const normalized = normalizeSqlAppProfiles(logicalSql, "prod", {
      resolveLogicalApp: () => 1234,
    });
    const [binding] = [...normalized.appBindingByMappedApp.values()];
    const mappedAppId = binding.mappedAppId;
    const rows = [
      record({ $id: "1", 区分: "A" }),
      record({ $id: "2", 区分: "A" }),
      record({ $id: "3", 区分: "B" }),
    ];
    const appFields = [
      { code: "区分", label: "区分", fieldType: "SINGLE_LINE_TEXT" },
    ];
    const direct = await execute(directSql, makeClient({
      records: { 1234: rows },
      fields: { 1234: appFields },
    })) as SelectResult;
    const logical = await execute(normalized.normalizedSql, makeClient({
      records: { [mappedAppId]: rows },
      fields: { [mappedAppId]: appFields },
    })) as SelectResult;

    expect(normalized.normalizedSql).toContain(`APP${mappedAppId}`);
    expect(logical.rows).toEqual(direct.rows);
  });
});

describe("B71 Step 4 PHYSICAL nested paths", () => {
  test("CTE body: alias shadow より PHYSICAL を優先する", async () => {
    const result = await execute(
      "WITH c AS (" +
      "SELECT 金額 AS 区分, COUNT(*) AS c FROM APP100 GROUP BY 区分" +
      ") SELECT * FROM c",
      makeClient()
    ) as SelectResult;
    expect(result.rowCount).toBe(2);
  });

  test("UNION の左右 branch: alias shadow より PHYSICAL を優先する", async () => {
    const result = await execute(
      "SELECT 金額 AS 区分, COUNT(*) AS c FROM APP100 GROUP BY 区分 UNION ALL " +
      "SELECT 種別 AS 区分, COUNT(*) AS c FROM APP200 GROUP BY 区分",
      makeClient()
    ) as SelectResult;
    expect(result.rowCount).toBe(4);
  });

  test("scalar subquery body: alias shadow より PHYSICAL を優先する", async () => {
    const result = await execute(
      "SELECT (SELECT 種別 AS 区分 FROM APP200 GROUP BY 区分 LIMIT 1) AS n " +
      "FROM APP100 LIMIT 1",
      makeClient()
    ) as SelectResult;
    expect(result.rows).toEqual([{ n: "L" }]);
  });

  test("DML source SELECT: alias shadow より PHYSICAL を優先する", async () => {
    const client = makeClient();
    const result = await execute(
      "INSERT INTO APP900 (区分) " +
      "SELECT 金額 AS 区分 FROM APP100 GROUP BY 区分 VALIDATE ONLY",
      client
    );
    expect(result).toMatchObject({ type: "VALIDATION", validatedRows: 2, errorCount: 0 });
    expect(client.postRecords).not.toHaveBeenCalled();
  });

  test("CREATE TEMP TABLE AS SELECT: alias shadow より PHYSICAL を優先する", async () => {
    const result = await executeBatch(
      "CREATE TEMP TABLE #t AS " +
      "SELECT 金額 AS 区分, COUNT(*) AS c FROM APP100 GROUP BY 区分; " +
      "SELECT * FROM #t",
      makeClient()
    );
    expect(result.statements[1]).toMatchObject({
      status: "success",
      result: { rowCount: 2 },
    });
  });
});

describe("B71 Step 4 PHYSICAL empty-value regression", () => {
  test("空セルと値欠落は従来どおり同じ空文字 group に入る", async () => {
    const client = makeClient({
      records: {
        100: [
          record({ $id: "1", 区分: "" }),
          record({ $id: "2" }),
          record({ $id: "3", 区分: "A" }),
        ],
      },
      fields: {
        100: [{ code: "区分", label: "区分", fieldType: "SINGLE_LINE_TEXT" }],
      },
    });
    const result = await execute(
      "SELECT 区分, COUNT(*) AS c FROM APP100 GROUP BY 区分 ORDER BY 区分",
      client
    ) as SelectResult;
    expect(result.rows).toEqual([{ 区分: "", c: "2" }, { 区分: "A", c: "1" }]);
    expect(fetchedFields(client, 100)).toEqual([["区分", "$id"]]);
  });
});
