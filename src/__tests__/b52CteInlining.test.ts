import { canInlineSingleCte } from "../core/cteInlining";
import { parseSqlStatement } from "../core/sql";
import { execute, type KintoneClient, type SelectResult } from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";
import type { WithStatement } from "../types/ast";

function record(fields: Record<string, string>): KintoneRecord {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { value }]));
}

function clientFor(recordsByApp: Record<number, KintoneRecord[]>): KintoneClient & {
  getCalls: Array<{ app: number; query: string; fields: string[] }>;
} {
  const getCalls: Array<{ app: number; query: string; fields: string[] }> = [];
  return {
    getCalls,
    async getRecords(params) {
      getCalls.push({ app: params.app, query: params.query ?? "", fields: [...(params.fields ?? [])] });
      return { records: recordsByApp[params.app] ?? [] };
    },
    async openCursor() { throw new Error("unexpected cursor call"); },
    async postRecords() { return { ids: [] }; },
    async putRecords() { /* noop */ },
    async deleteRecords() { /* noop */ },
    async getApps() { return []; },
    async getFields(appId) {
      const fields = new Set((recordsByApp[appId] ?? []).flatMap((row) => Object.keys(row)));
      return [...fields].map((field) => ({
        code: field,
        label: field,
        fieldType: field === "金額" ? "NUMBER" : "SINGLE_LINE_TEXT",
      }));
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const };
    },
  };
}

function canInline(sql: string): boolean {
  return canInlineSingleCte(parseSqlStatement(sql) as WithStatement);
}

const apps = {
  100: [
    record({ レコード番号: "1", 都道府県: "岐阜県", 金額: "100" }),
    record({ レコード番号: "2", 都道府県: "愛知県", 金額: "200" }),
  ],
  200: [
    record({ レコード番号: "1", 郵便番号: "5008334" }),
    record({ レコード番号: "2", 郵便番号: "4600000" }),
  ],
};

test("B52: 単一 CTE の列別名は実体化し、外側から別名で取得できる", async () => {
  const client = clientFor(apps);
  const result = await execute(
    "WITH a AS (SELECT レコード番号 AS aid, 都道府県 AS apref FROM APP100) " +
      "SELECT a.aid, a.apref FROM a ORDER BY a.aid",
    client
  ) as SelectResult;

  expect(result.rows).toEqual([
    { aid: "1", apref: "岐阜県" },
    { aid: "2", apref: "愛知県" },
  ]);
  expect(client.getCalls[0].fields).toEqual(expect.arrayContaining(["レコード番号", "都道府県"]));
  expect(client.getCalls[0].fields).not.toEqual(expect.arrayContaining(["aid", "apref"]));
});

test("B52: 単一 CTE の列別名を物理アプリとの JOIN でも解決する", async () => {
  const result = await execute(
    "WITH a AS (SELECT レコード番号 AS aid, 都道府県 AS apref FROM APP100) " +
      "SELECT a.aid, a.apref, b.郵便番号 FROM a " +
      "LEFT JOIN APP200 AS b ON a.aid = b.レコード番号 ORDER BY a.aid",
    clientFor(apps)
  ) as SelectResult;

  expect(result.rows).toEqual([
    { aid: "1", apref: "岐阜県", 郵便番号: "5008334" },
    { aid: "2", apref: "愛知県", 郵便番号: "4600000" },
  ]);
});

test.each([
  ["算術式", "SELECT レコード番号, 金額 * 2 AS calc", "calc", ["200", "400"]],
  ["リテラル", "SELECT レコード番号, 'fixed' AS marker", "marker", ["fixed", "fixed"]],
])("B52: CTE 投影の%sは実体化して外側から参照できる", async (_label, projection, output, expected) => {
  const result = await execute(
    `WITH a AS (${projection} FROM APP100) SELECT レコード番号, ${output} FROM a ORDER BY レコード番号`,
    clientFor(apps)
  ) as SelectResult;

  expect(result.rows.map((row) => row[output])).toEqual(expected);
});

test("B52: インライン判定は安全な投影だけを許可する", () => {
  expect(canInline("WITH c AS (SELECT * FROM APP100) SELECT * FROM c")).toBe(true);
  expect(canInline("WITH c AS (SELECT レコード番号, 都道府県 FROM APP100) SELECT レコード番号 FROM c")).toBe(true);
  expect(canInline("WITH c AS (SELECT レコード番号 AS レコード番号 FROM APP100) SELECT レコード番号 FROM c")).toBe(true);

  expect(canInline("WITH c AS (SELECT レコード番号 AS aid FROM APP100) SELECT aid FROM c")).toBe(false);
  expect(canInline("WITH c AS (SELECT 金額 * 1.1 AS calc FROM APP100) SELECT calc FROM c")).toBe(false);
  expect(canInline("WITH c AS (SELECT 'fixed' AS marker FROM APP100) SELECT marker FROM c")).toBe(false);
  expect(canInline("WITH c AS (SELECT UPPER(都道府県) AS upper_pref FROM APP100) SELECT upper_pref FROM c")).toBe(false);
  expect(canInline("WITH c AS (SELECT CASE WHEN 金額 > 0 THEN 'yes' ELSE 'no' END AS flag FROM APP100) SELECT flag FROM c")).toBe(false);
});

test("B52: SELECT * と同名単純フィールドはインライン化と WHERE pushdown を維持する", async () => {
  for (const projection of ["*", "レコード番号, 都道府県"]) {
    const client = clientFor(apps);
    await execute(
      `WITH c AS (SELECT ${projection} FROM APP100 WHERE 都道府県 = '岐阜県') ` +
        "SELECT * FROM c WHERE 金額 > 50",
      client
    );

    expect(client.getCalls).toHaveLength(1);
    expect(client.getCalls[0].query).toContain('都道府県 = "岐阜県"');
    expect(client.getCalls[0].query).toContain("金額 > 50");
    expect(client.getCalls[0].query).toContain(" and ");
  }
});

test("B52: EXPLAIN は別名 CTE を実体化し、安全な CTE だけを inlined と表示する", async () => {
  const materialized = await execute(
    "EXPLAIN WITH c AS (SELECT レコード番号 AS rid FROM APP100) SELECT rid FROM c",
    clientFor(apps)
  ) as SelectResult;
  const inlined = await execute(
    "EXPLAIN WITH c AS (SELECT レコード番号 FROM APP100) SELECT レコード番号 FROM c",
    clientFor(apps)
  ) as SelectResult;

  expect(materialized.rows.some((row) => String(row.plan).includes("effective: inlined CTE"))).toBe(false);
  expect(inlined.rows.some((row) => String(row.plan).includes("effective: inlined CTE"))).toBe(true);
});

test("B52: 従来の実体化対象はインライン化しない", () => {
  expect(canInline("WITH c AS (SELECT 都道府県, COUNT(*) AS cnt FROM APP100 GROUP BY 都道府県) SELECT * FROM c")).toBe(false);
  expect(canInline("WITH c AS (SELECT レコード番号, ROW_NUMBER() OVER (ORDER BY レコード番号) AS rn FROM APP100) SELECT * FROM c")).toBe(false);
  expect(canInline("WITH c AS (SELECT レコード番号 FROM APP100 UNION ALL SELECT レコード番号 FROM APP200) SELECT * FROM c")).toBe(false);
  expect(canInline("WITH a AS (SELECT * FROM APP100), b AS (SELECT * FROM APP200) SELECT * FROM a")).toBe(false);
  expect(canInline("WITH c AS (SELECT * FROM APP100) SELECT * FROM c INNER JOIN APP200 AS b ON c.レコード番号 = b.レコード番号")).toBe(false);
});
