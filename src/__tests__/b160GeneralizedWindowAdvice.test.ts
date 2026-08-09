import type { KintoneRecord } from "../converter/dmlToKintone";
import {
  execute,
  type KintoneClient,
  type KintoneFieldInfo,
  type SelectResult,
} from "../execute";

const ADVICE = "ウィンドウの各パーティション内で、ORDER BY の値の組が入力行を一意に識別するとクエリ構造または保証済みのデータ制約から確認できる場合に限り、この警告は無視できます。"
  + "元の集約キーをすべて ORDER BY に含む形や、JOIN 後も同じ系列値が各パーティション内で高々1行と保証できる形が該当します。"
  + "生成列、再帰の深さ列、または $id に由来する列であるという理由だけでは無視できません。";

function record(values: Record<string, string>): KintoneRecord {
  return Object.fromEntries(Object.entries(values).map(([field, value]) => [field, { value }]));
}

function client(recordsByApp: Readonly<Record<number, readonly KintoneRecord[]>>): KintoneClient {
  return {
    async getRecords(params) {
      const rows = (recordsByApp[params.app] ?? []).map((row, index) =>
        row.$id ? row : { ...row, $id: { value: String(index + 1) } }
      );
      const limit = Number(params.query.match(/\blimit\s+(\d+)/i)?.[1] ?? "500");
      const offset = Number(params.query.match(/\boffset\s+(\d+)/i)?.[1] ?? "0");
      return { records: rows.slice(offset, offset + limit) };
    },
    async openCursor() { throw new Error("unexpected cursor call"); },
    async postRecords() { return { ids: [] }; },
    async putRecords() { /* read-only */ },
    async deleteRecords() { /* read-only */ },
    async getApps() { return []; },
    async getFields(appId) {
      const fields = new Set((recordsByApp[appId] ?? []).flatMap((row) => Object.keys(row)));
      return [...fields].filter((field) => !field.startsWith("$")).map((field): KintoneFieldInfo => ({
        code: field,
        label: field,
        fieldType: ["qty", "depth", "系列キー"].includes(field) ? "NUMBER" : "SINGLE_LINE_TEXT",
        sortKind: ["qty", "depth", "系列キー"].includes(field) ? "number" : "string",
      }));
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const };
    },
  };
}

async function run(sql: string, recordsByApp: Readonly<Record<number, readonly KintoneRecord[]>> = {}): Promise<SelectResult> {
  return await execute(sql, client(recordsByApp), {
    cacheContext: `b160-${Math.random()}`,
  }) as SelectResult;
}

function onlyWarning(result: SelectResult): string {
  expect(result.warnings).toHaveLength(1);
  return result.warnings![0];
}

const groupedRows = { 100: [
  record({ k1: "A", k2: "1", qty: "10" }),
  record({ k1: "A", k2: "2", qty: "20" }),
] };

const joinedSeriesRows = { 100: [
  record({ 系列キー: "1", qty: "10" }),
  record({ 系列キー: "1", qty: "20" }),
  record({ 系列キー: "2", qty: "30" }),
] };

describe("B53 §10.6 generalized total-order warning acceptance", () => {
  test("B140: all aggregate keys remain an explicit affirmative example", async () => {
    const result = await run("WITH g AS (SELECT k1,k2,SUM(qty) AS total FROM APP100 GROUP BY k1,k2) SELECT k1,k2,LAG(total) OVER (ORDER BY k1,k2) AS prev FROM g", groupedRows);
    const warning = onlyWarning(result);
    expect(warning.endsWith(ADVICE)).toBe(true);
    expect(warning).toContain("元の集約キーをすべて ORDER BY に含む形");
  });

  test("B140: only part of a composite aggregate key is not enough", async () => {
    const result = await run("WITH g AS (SELECT k1,k2,SUM(qty) AS total FROM APP100 GROUP BY k1,k2) SELECT k1,k2,LAG(total) OVER (ORDER BY k1) AS prev FROM g", groupedRows);
    expect(onlyWarning(result).endsWith(ADVICE)).toBe(true);
    expect(result.rows.filter((row) => row.k1 === "A")).toHaveLength(2);
  });

  test("B160: a generated key duplicated by JOIN is not enough", async () => {
    const result = await run("WITH s AS (GENERATE_SERIES(1,2) AS n),j AS (SELECT s.n,a.qty FROM s INNER JOIN APP100 a ON s.n=a.系列キー),w AS (SELECT n,qty,LAG(n) OVER (ORDER BY n) AS prev FROM j) SELECT n,qty,prev FROM w", joinedSeriesRows);
    expect(onlyWarning(result).endsWith(ADVICE)).toBe(true);
    expect(result.rows.filter((row) => row.n === "1")).toHaveLength(2);
  });

  test("B160: one row per generated value after aggregation matches the affirmative condition", async () => {
    const result = await run("WITH s AS (GENERATE_SERIES(1,2) AS n),j AS (SELECT s.n,a.qty FROM s INNER JOIN APP100 a ON s.n=a.系列キー),g AS (SELECT n,SUM(qty) AS total FROM j GROUP BY n),w AS (SELECT n,total,LAG(total) OVER (ORDER BY n) AS prev FROM g) SELECT n,total,prev FROM w ORDER BY n", joinedSeriesRows);
    expect(onlyWarning(result).endsWith(ADVICE)).toBe(true);
    expect(result.rows).toEqual([
      { n: "1", total: "30", prev: "" },
      { n: "2", total: "30", prev: "30" },
    ]);
  });

  test("B53: recursive depth alone does not identify rows", async () => {
    const rows = { 100: [
      record({ parent: "ROOT", child: "A" }),
      record({ parent: "ROOT", child: "B" }),
    ] };
    const result = await run("WITH RECURSIVE tree(parent,child,depth) AS (SELECT parent,child,1 FROM APP100 WHERE parent='ROOT' UNION ALL SELECT s.parent,s.child,r.depth+1 FROM APP100 s INNER JOIN tree r ON s.parent=r.child) SELECT child,depth,LAG(child) OVER (ORDER BY depth) AS prev FROM tree", rows);
    expect(onlyWarning(result).endsWith(ADVICE)).toBe(true);
    expect(result.rows.filter((row) => row.depth === "1")).toHaveLength(2);
  });

  test("B53: the same node reached through multiple paths is not unique by node column", async () => {
    const rows = { 100: [
      record({ parent: "ROOT", child: "A" }),
      record({ parent: "ROOT", child: "B" }),
      record({ parent: "A", child: "D" }),
      record({ parent: "B", child: "D" }),
    ] };
    const result = await run("WITH RECURSIVE tree(parent,child,depth) AS (SELECT parent,child,1 FROM APP100 WHERE parent='ROOT' UNION ALL SELECT s.parent,s.child,r.depth+1 FROM APP100 s INNER JOIN tree r ON s.parent=r.child) SELECT child,depth,LAG(depth) OVER (ORDER BY child) AS prev_depth FROM tree", rows);
    expect(onlyWarning(result).endsWith(ADVICE)).toBe(true);
    expect(result.rows.filter((row) => row.child === "D")).toHaveLength(2);
  });

  test("existing direct GENERATE_SERIES warning suppression remains unchanged", async () => {
    const result = await run("WITH s AS (GENERATE_SERIES(1,3) AS n) SELECT n,LAG(n) OVER (ORDER BY n) AS prev FROM s ORDER BY n");
    expect(result.warnings).toEqual([]);
  });

  test("warning text is the only change: values, columns, order, and count remain fixed", async () => {
    const result = await run("WITH s AS (GENERATE_SERIES(1,2) AS n),j AS (SELECT s.n,a.qty FROM s INNER JOIN APP100 a ON s.n=a.系列キー),w AS (SELECT n,qty,LAG(n) OVER (ORDER BY n) AS prev FROM j) SELECT n,qty,prev FROM w ORDER BY n,qty", joinedSeriesRows);
    expect(result).toMatchObject({
      columns: ["n", "qty", "prev"],
      rowCount: 3,
      rows: [
        { n: "1", qty: "10", prev: "" },
        { n: "1", qty: "20", prev: "1" },
        { n: "2", qty: "30", prev: "1" },
      ],
    });
    expect(onlyWarning(result).endsWith(ADVICE)).toBe(true);
  });
});
