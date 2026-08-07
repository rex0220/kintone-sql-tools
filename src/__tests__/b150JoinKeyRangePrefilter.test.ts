import type { KintoneRecord } from "../converter/dmlToKintone";
import { execute, executeBatch, type KintoneClient, type KintoneFieldInfo, type SelectResult } from "../execute";

const SOURCE = 4227;
const TARGET = 4228;

function record(id: string, values: Readonly<Record<string, unknown>>): KintoneRecord {
  return Object.fromEntries([
    ["$id", { value: id }],
    ...Object.entries(values).map(([code, value]) => [code, { value }]),
  ]) as KintoneRecord;
}

const fields: Readonly<Record<number, readonly KintoneFieldInfo[]>> = {
  [SOURCE]: [
    { code: "日付", label: "日付", fieldType: "DATE" },
    { code: "キー", label: "キー", fieldType: "SINGLE_LINE_TEXT" },
    { code: "時刻", label: "時刻", fieldType: "TIME" },
    { code: "日時", label: "日時", fieldType: "DATETIME" },
    { code: "作成日時", label: "作成日時", fieldType: "CREATED_TIME" },
    { code: "更新日時", label: "更新日時", fieldType: "UPDATED_TIME" },
    { code: "数", label: "数", fieldType: "NUMBER" },
    { code: "レコード番号", label: "レコード番号", fieldType: "RECORD_NUMBER" },
  ],
  [TARGET]: [
    { code: "日付", label: "日付", fieldType: "DATE" },
    { code: "キー", label: "キー", fieldType: "SINGLE_LINE_TEXT" },
    { code: "個数", label: "個数", fieldType: "NUMBER" },
    { code: "メモ", label: "メモ", fieldType: "MULTI_LINE_TEXT" },
    { code: "時刻", label: "時刻", fieldType: "TIME" },
    { code: "日時", label: "日時", fieldType: "DATETIME" },
    { code: "作成日時", label: "作成日時", fieldType: "CREATED_TIME" },
    { code: "更新日時", label: "更新日時", fieldType: "UPDATED_TIME" },
    { code: "数", label: "数", fieldType: "NUMBER" },
    { code: "レコード番号", label: "レコード番号", fieldType: "RECORD_NUMBER" },
  ],
};

function stripPaging(query: string): string {
  return query.replace(/(?:^|\s+)order by \$id asc limit 500 offset \d+$/, "");
}

function makeClient(options: {
  sourceRows?: KintoneRecord[];
  targetRows?: KintoneRecord[];
  rangeError?: Error;
} = {}): KintoneClient & { queries: Array<{ app: number; query: string }> } {
  const queries: Array<{ app: number; query: string }> = [];
  const rows: Record<number, KintoneRecord[]> = {
    [SOURCE]: options.sourceRows ?? [],
    [TARGET]: options.targetRows ?? [
      record("11", { 日付: "2025-08-04", 個数: "4", キー: "A" }),
      record("12", { 日付: "2025-08-05", 個数: "5", キー: "GAP" }),
      record("13", { 日付: "2025-08-06", 個数: "6", キー: "B" }),
      record("14", { 日付: "2025-08-07", 個数: "7", キー: "C" }),
    ],
  };
  return {
    queries,
    async getRecords(params) {
      queries.push({ app: params.app, query: params.query });
      const bare = stripPaging(params.query);
      if (/日付 in \(/.test(bare)) {
        throw new Error("GAIA_IQ03: DATE does not accept in");
      }
      if (options.rangeError && /日付 >=/.test(bare)) throw options.rangeError;
      let selected = rows[params.app] ?? [];
      const range = /日付 >= "([^"]+)" and 日付 <= "([^"]+)"/.exec(bare);
      if (range) {
        selected = selected.filter((row) => {
          const value = String(row["日付"]?.value ?? "");
          return value >= range[1] && value <= range[2];
        });
      }
      const temporalRange = /(時刻|日時|作成日時|更新日時) >= "([^"]+)" and \1 <= "([^"]+)"/.exec(bare);
      if (temporalRange) {
        selected = selected.filter((row) => {
          const value = String(row[temporalRange[1]]?.value ?? "");
          return value >= temporalRange[2] && value <= temporalRange[3];
        });
      }
      const inList = /キー in \((.*)\)/.exec(bare);
      if (inList) {
        const values = (inList[1].match(/"(?:\\.|[^"\\])*"/g) ?? [])
          .map((value) => JSON.parse(value) as string);
        selected = selected.filter((row) => values.includes(String(row["キー"]?.value ?? "")));
      }
      return { records: selected };
    },
    async openCursor() { throw new Error("unexpected cursor"); },
    async postRecords() { return { ids: [] }; },
    async putRecords() {},
    async deleteRecords() {},
    async getApps() { return []; },
    async getFields(appId) { return [...(fields[appId] ?? [])]; },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() { return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const }; },
  };
}

const ACCEPTANCE_SQL = `WITH s AS (
  GENERATE_SERIES('2025-08-04', '2025-08-06') AS 日付
)
SELECT s.日付, t.個数
FROM s
INNER JOIN APP4228 AS t
  ON s.日付 = t.日付
ORDER BY s.日付`;

describe("B150 JOIN key range prefilter acceptance", () => {
  test("B150再現形は旧 in の GAIA_IQ03 条件を踏まず正しい結果を返す", async () => {
    const client = makeClient();
    const result = await execute(ACCEPTANCE_SQL, client, { cacheContext: "b150-acceptance" }) as SelectResult;
    expect(result.rows).toEqual([
      { 日付: "2025-08-04", 個数: "4" },
      { 日付: "2025-08-05", 個数: "5" },
      { 日付: "2025-08-06", 個数: "6" },
    ]);
    const targetQueries = client.queries.filter((call) => call.app === TARGET).map((call) => stripPaging(call.query));
    expect(targetQueries).toContain('日付 >= "2025-08-04" and 日付 <= "2025-08-06"');
    expect(targetQueries.join("\n")).not.toContain("日付 in (");
  });

  test("range は superset 候補を取っても JOIN 後に未使用キーを除外する", async () => {
    const client = makeClient({
      sourceRows: [
        record("1", { 日付: "2025-08-04", キー: "A" }),
        record("2", { 日付: "2025-08-06", キー: "B" }),
      ],
    });
    const result = await execute(
      "SELECT s.日付,t.個数 FROM APP4227 s INNER JOIN APP4228 t ON s.日付=t.日付 ORDER BY s.日付",
      client,
      { cacheContext: "b150-superset" }
    ) as SelectResult;
    expect(result.rows).toEqual([
      { 日付: "2025-08-04", 個数: "4" },
      { 日付: "2025-08-06", 個数: "6" },
    ]);
  });

  test("一時テーブル→APP も同じ range query と結果になる", async () => {
    const client = makeClient({
      sourceRows: [
        record("1", { 日付: "2025-08-04", キー: "A" }),
        record("2", { 日付: "2025-08-06", キー: "B" }),
      ],
    });
    const batch = await executeBatch(
      "CREATE TEMP TABLE #s AS SELECT 日付 FROM APP4227; " +
      "SELECT s.日付,t.個数 FROM #s s INNER JOIN APP4228 t ON s.日付=t.日付 ORDER BY s.日付;",
      client,
      { cacheContext: "b150-temp" }
    );
    expect((batch.statements[1].result as SelectResult).rows).toEqual([
      { 日付: "2025-08-04", 個数: "4" },
      { 日付: "2025-08-06", 個数: "6" },
    ]);
    expect(client.queries.some((call) => stripPaging(call.query) ===
      '日付 >= "2025-08-04" and 日付 <= "2025-08-06"')).toBe(true);
  });

  test.each([
    ["時刻", "09:00", "17:30"],
    ["日時", "2025-08-04T00:00:00Z", "2025-08-06T23:59:59Z"],
    ["作成日時", "2025-08-04T00:00:00Z", "2025-08-06T23:59:59Z"],
    ["更新日時", "2025-08-04T00:00:00Z", "2025-08-06T23:59:59Z"],
  ] as const)("%s canonical key も range prefilter を使う", async (field, min, max) => {
    const client = makeClient({
      sourceRows: [record("1", { [field]: max }), record("2", { [field]: min })],
      targetRows: [record("11", { [field]: min, 個数: "1" }), record("12", { [field]: max, 個数: "2" })],
    });
    const result = await execute(
      `SELECT s.${field},t.個数 FROM APP4227 s INNER JOIN APP4228 t ON s.${field}=t.${field} ORDER BY s.${field}`,
      client,
      { cacheContext: `b150-${field}` }
    ) as SelectResult;
    expect(result.rowCount).toBe(2);
    expect(client.queries.some((call) => stripPaging(call.query) ===
      `${field} >= "${min}" and ${field} <= "${max}"`)).toBe(true);
  });

  test("空値混在・非canonical・非対応型は結合キー query を送らず全件基準を保つ", async () => {
    for (const [name, sourceRows] of [
      ["empty", [record("1", { 日付: "", キー: "" }), record("2", { 日付: "2025-08-04", キー: "A" })]],
      ["noncanonical", [record("1", { 日付: "2025-8-4", キー: "A" }), record("2", { 日付: "2025-08-04", キー: "A" })]],
    ] as const) {
      const client = makeClient({ sourceRows: [...sourceRows] });
      await execute(
        "SELECT s.日付,t.個数 FROM APP4227 s INNER JOIN APP4228 t ON s.日付=t.日付",
        client,
        { cacheContext: `b150-${name}` }
      );
      const target = client.queries.filter((call) => call.app === TARGET).map((call) => stripPaging(call.query));
      expect(target).toContain("");
      expect(target.join("\n")).not.toMatch(/日付 (?:in|>=)/);
    }
  });

  test("in 可能型は既存 serializer と exact query を維持する", async () => {
    const client = makeClient({
      sourceRows: [record("1", { 日付: "2025-08-04", キー: 'A"\\B' })],
      targetRows: [record("11", { 日付: "2025-08-04", 個数: "4", キー: 'A"\\B' })],
    });
    const result = await execute(
      "SELECT s.キー,t.個数 FROM APP4227 s INNER JOIN APP4228 t ON s.キー=t.キー",
      client,
      { cacheContext: "b150-in" }
    ) as SelectResult;
    expect(result.rows).toEqual([{ キー: 'A"\\B', 個数: "4" }]);
    expect(client.queries.some((call) => stripPaging(call.query) === 'キー in ("A\\"\\\\B")')).toBe(true);
  });

  test.each([
    [50, 1, false],
    [51, 2, false],
    [300, 6, false],
    [301, 0, true],
  ] as const)("in キー %i件は query %i本・limit fallback=%s", async (count, expectedInQueries, fallback) => {
    const sourceRows = Array.from({ length: count }, (_, index) =>
      record(String(index + 1), { キー: `K${index}` })
    );
    const client = makeClient({ sourceRows, targetRows: [] });
    const result = await execute(
      "SELECT s.キー,t.個数 FROM APP4227 s INNER JOIN APP4228 t ON s.キー=t.キー",
      client,
      { cacheContext: `b150-in-${count}` }
    ) as SelectResult;
    const targetQueries = client.queries
      .filter((call) => call.app === TARGET)
      .map((call) => stripPaging(call.query));
    expect(targetQueries.filter((query) => query.startsWith("キー in (")).length).toBe(expectedInQueries);
    if (fallback) {
      expect(targetQueries).toContain("");
      expect(result.warnings).toContain(
        "JOINキーが 301 件のため ON 最適化をスキップし、JOIN先を全件取得します（上限 300 件）。"
      );
    }
  });

  test("有効な range query の mock error を握りつぶさない", async () => {
    const injected = new Error("injected range failure");
    await expect(execute(ACCEPTANCE_SQL, makeClient({ rangeError: injected }), {
      cacheContext: "b150-error",
    })).rejects.toBe(injected);
  });

  test("EXPLAIN は既知の系列境界を range・superset として逐語表示し records API を呼ばない", async () => {
    const client = makeClient();
    const result = await execute(`EXPLAIN
WITH s AS (
  GENERATE_SERIES('2025-08-04', '2025-08-06') AS 日付
)
SELECT s.日付, t.個数
FROM s
INNER JOIN APP4228 AS t
  ON s.日付 = t.日付`, client, { cacheContext: "b150-explain" }) as SelectResult;
    const text = result.rows.map((row) => row.plan).join("\n");
    for (const expected of [
      'kintone query: 日付 >= "2025-08-04" and 日付 <= "2025-08-06"',
      "fetch:         PREFILTERED",
      "join key prefilter: range",
      'pushdown applied: 日付 >= "2025-08-04" and 日付 <= "2025-08-06"',
      "relation: superset",
    ]) expect(text).toContain(expected);
    expect(text).not.toContain("日付 in (");
    expect(client.queries).toEqual([]);
  });

  test("range と独立条件は実 serializer 順で合成し relation を superset に保つ", async () => {
    const client = makeClient();
    const sql = `WITH s AS (GENERATE_SERIES('2025-08-04','2025-08-06') AS 日付)
SELECT s.日付,t.個数 FROM s INNER JOIN APP4228 t ON s.日付=t.日付 WHERE t.個数 > 4 ORDER BY s.日付`;
    const result = await execute(sql, client, { cacheContext: "b150-combined" }) as SelectResult;
    expect(result.rows).toEqual([{ 日付: "2025-08-05", 個数: "5" }, { 日付: "2025-08-06", 個数: "6" }]);
    const combined = '(日付 >= "2025-08-04" and 日付 <= "2025-08-06") and (個数 > 4)';
    expect(client.queries.some((call) => stripPaging(call.query) === combined)).toBe(true);

    const explainClient = makeClient();
    const explained = await execute(`EXPLAIN ${sql}`, explainClient, { cacheContext: "b150-combined-explain" }) as SelectResult;
    const text = explained.rows.map((row) => row.plan).join("\n");
    expect(text).toContain(`kintone query: ${combined}`);
    expect(text).toContain(`pushdown applied: ${combined}`);
    expect(text).toContain("relation: superset");
    expect(explainClient.queries).toEqual([]);
  });

  test("EXPLAIN は range 非対応型の fallback reason を逐語表示する", async () => {
    const client = makeClient();
    const result = await execute(
      "EXPLAIN WITH s AS (GENERATE_SERIES('2025-08-04','2025-08-06') AS 日付) " +
      "SELECT s.日付,t.メモ FROM s INNER JOIN APP4228 t ON s.日付=t.メモ",
      client,
      { cacheContext: "b150-explain-fallback" }
    ) as SelectResult;
    const text = result.rows.map((row) => row.plan).join("\n");
    expect(text).toContain("kintone query: (全件取得)");
    expect(text).toContain("fetch:         ALL");
    expect(text).toContain("join key prefilter: not applied");
    expect(text).toContain("join key prefilter reason: JOIN_KEY_OPERATOR_UNAVAILABLE");
    expect(text).not.toContain("relation: exact");
    expect(text).not.toContain("relation: superset");
    expect(client.queries).toEqual([]);
  });

  test("EXPLAIN は min=max と in exact の serializer を逐語固定する", async () => {
    const rangeClient = makeClient();
    const range = await execute(
      "EXPLAIN WITH s AS (GENERATE_SERIES('2025-08-04','2025-08-04') AS 日付) " +
      "SELECT s.日付,t.個数 FROM s INNER JOIN APP4228 t ON s.日付=t.日付",
      rangeClient,
      { cacheContext: "b150-explain-minmax" }
    ) as SelectResult;
    expect(range.rows.map((row) => row.plan).join("\n"))
      .toContain('日付 >= "2025-08-04" and 日付 <= "2025-08-04"');

    const inClient = makeClient();
    const exact = await execute(
      "EXPLAIN WITH s AS (GENERATE_SERIES(1,2) AS 数) " +
      "SELECT s.数,t.個数 FROM s INNER JOIN APP4228 t ON s.数=t.数",
      inClient,
      { cacheContext: "b150-explain-in" }
    ) as SelectResult;
    const text = exact.rows.map((row) => row.plan).join("\n");
    expect(text).toContain('kintone query: 数 in ("1","2")');
    expect(text).toContain("fetch:         EXACT");
    expect(text).toContain("join key prefilter: in");
    expect(text).toContain('pushdown applied: 数 in ("1","2")');
    expect(text).toContain("relation: exact");
    expect(inClient.queries).toEqual([]);
  });

  test.each([
    ["", "JOIN_KEY_EMPTY_VALUE"],
    ["2025-8-4", "JOIN_KEY_NON_CANONICAL_VALUE"],
  ] as const)("materialized key %s の EXPLAIN fallback reason を逐語固定する", async (value, reason) => {
    const client = makeClient({ sourceRows: [record("1", { 日付: value })] });
    const batch = await executeBatch(
      "CREATE TEMP TABLE #s AS SELECT 日付 FROM APP4227; " +
      "EXPLAIN SELECT s.日付,t.個数 FROM #s s INNER JOIN APP4228 t ON s.日付=t.日付;",
      client,
      { cacheContext: `b150-explain-${reason}` }
    );
    const result = batch.statements[1].result as SelectResult;
    const text = result.rows.map((row) => row.plan).join("\n");
    expect(text).toContain("join key prefilter: not applied");
    expect(text).toContain(`join key prefilter reason: ${reason}`);
    expect(text).not.toContain("relation: superset");
  });
});

describe("B153 empty JOIN key acceptance", () => {
  test("空キー混在でも物理側の空キー行を取得し、空=空の一致を返す", async () => {
    const client = makeClient({
      sourceRows: [
        record("1", { キー: "" }),
        record("2", { キー: "A" }),
      ],
      targetRows: [
        record("11", { キー: "", 個数: "0" }),
        record("12", { キー: "A", 個数: "1" }),
      ],
    });
    const result = await execute(
      "SELECT s.キー,t.個数 FROM APP4227 s INNER JOIN APP4228 t ON s.キー=t.キー ORDER BY t.個数",
      client,
      { cacheContext: "b153-empty-mixed" }
    ) as SelectResult;
    expect(result.rows).toEqual([{ キー: "", 個数: "0" }, { キー: "A", 個数: "1" }]);
    expect(client.queries.some((call) => stripPaging(call.query) === 'キー in ("","A")')).toBe(true);
  });

  test("全キー空でも取得ゼロへ短絡せず in (\"\") を逐語送信する", async () => {
    const client = makeClient({
      sourceRows: [
        record("1", { キー: "" }),
        record("2", { キー: null }),
        record("3", { キー: undefined }),
      ],
      targetRows: [record("11", { キー: "", 個数: "0" })],
    });
    const result = await execute(
      "SELECT s.キー,t.個数 FROM APP4227 s INNER JOIN APP4228 t ON s.キー=t.キー",
      client,
      { cacheContext: "b153-empty-only" }
    ) as SelectResult;
    expect(result.rowCount).toBe(3);
    expect(client.queries.some((call) => stripPaging(call.query) === 'キー in ("")')).toBe(true);
  });

  test("空値受理未確認の RECORD_NUMBER は JOIN_KEY_EMPTY_VALUE 方針で全件取得する", async () => {
    const client = makeClient({
      sourceRows: [record("1", { レコード番号: "" })],
      targetRows: [record("11", { レコード番号: "", 個数: "0" })],
    });
    const result = await execute(
      "SELECT s.レコード番号,t.個数 FROM APP4227 s INNER JOIN APP4228 t ON s.レコード番号=t.レコード番号",
      client,
      { cacheContext: "b153-record-number-fallback" }
    ) as SelectResult;
    expect(result.rows).toEqual([{ レコード番号: "", 個数: "0" }]);
    const targetQueries = client.queries
      .filter((call) => call.app === TARGET)
      .map((call) => stripPaging(call.query));
    expect(targetQueries).toContain("");
    expect(targetQueries.join("\n")).not.toContain("レコード番号 in (");
  });

  test("JOIN ローカル評価器と同じく空白キーを trim せず逐語照合する", async () => {
    const client = makeClient({
      sourceRows: [record("1", { キー: " " })],
      targetRows: [record("11", { キー: " ", 個数: "1" }), record("12", { キー: "", 個数: "0" })],
    });
    const result = await execute(
      "SELECT s.キー,t.個数 FROM APP4227 s INNER JOIN APP4228 t ON s.キー=t.キー",
      client,
      { cacheContext: "b153-whitespace" }
    ) as SelectResult;
    expect(result.rows).toEqual([{ キー: " ", 個数: "1" }]);
    expect(client.queries.some((call) => stripPaging(call.query) === 'キー in (" ")')).toBe(true);
  });
});
