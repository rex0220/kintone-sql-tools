import { compareDecimal } from "../core/exactDecimal";
import type { KintoneRecord } from "../converter/dmlToKintone";
import {
  execute,
  type KintoneClient,
  type KintoneFieldInfo,
  type SelectResult,
} from "../execute";

type GetRecordsParams = Parameters<KintoneClient["getRecords"]>[0];

const MASTER = 4229;
const TRANSACTION = 4228;
const IN_QUERY = "個数 in (-6,10,1000)";

function record(values: Readonly<Record<string, unknown>>): KintoneRecord {
  return Object.fromEntries(
    Object.entries(values).map(([code, value]) => [code, { value }])
  ) as KintoneRecord;
}

const products = [
  ["B151_BOUNDARY", "999999999999.9999"],
  ["B151_EMPTY", ""],
  ["B151_NINE", "9"],
  ["B151_TEN", "10"],
  ["B151_NEGATIVE", "-6"],
  ["B151_ZERO", "0"],
  ["B151_THOUSAND", "1000"],
  ["B151_SAFE_PLUS_ONE", "9007199254740993"],
] as const;

const rowsByApp: Readonly<Record<number, readonly KintoneRecord[]>> = {
  [MASTER]: products.map(([製品名], index) => record({
    $id: String(index + 1),
    製品名,
  })),
  [TRANSACTION]: products.map(([製品名, 個数], index) => record({
    $id: String(index + 101),
    製品名,
    個数,
    備考: index % 2 === 0 ? "確認" : "",
    計算値: 個数,
  })),
};

const fieldsByApp: Readonly<Record<number, readonly KintoneFieldInfo[]>> = {
  [100]: [
    { code: "キー", label: "キー", fieldType: "SINGLE_LINE_TEXT" },
    { code: "計算値", label: "計算値", fieldType: "CALC" },
  ],
  [101]: [
    { code: "キー", label: "キー", fieldType: "SINGLE_LINE_TEXT" },
  ],
  [MASTER]: [
    { code: "製品名", label: "製品名", fieldType: "SINGLE_LINE_TEXT" },
  ],
  [TRANSACTION]: [
    { code: "製品名", label: "製品名", fieldType: "SINGLE_LINE_TEXT" },
    { code: "個数", label: "個数", fieldType: "NUMBER" },
    { code: "備考", label: "備考", fieldType: "SINGLE_LINE_TEXT" },
    { code: "計算値", label: "計算値", fieldType: "CALC" },
  ],
};

function withoutPaging(query: string): string {
  return query.replace(/(?:^|\s+)order by \$id asc limit 500 offset \d+$/, "");
}

function numericPredicate(query: string): ((value: string) => boolean) | null {
  const list = /個数\s+(not in|in)\s+\(([^)]*)\)/i.exec(query);
  if (list !== null) {
    const expected = list[2].split(",").map((value) => value.trim());
    const positive = list[1].toLowerCase() === "in";
    return (value) => {
      const found = value !== "" && expected.some((candidate) => compareDecimal(value, candidate) === 0);
      return positive ? found : !found;
    };
  }

  const scalar = /個数\s*(<=|>=|!=|=|<|>)\s*(-?\d+(?:\.\d+)?)/.exec(query);
  if (scalar === null) return null;
  const [, op, expected] = scalar;
  return (value) => {
    if (value === "") {
      return op === "!=" || op === "<" || op === "<=";
    }
    const compared = compareDecimal(value, expected);
    if (op === "=") return compared === 0;
    if (op === "!=") return compared !== 0;
    if (op === "<") return compared < 0;
    if (op === "<=") return compared <= 0;
    if (op === ">") return compared > 0;
    return compared >= 0;
  };
}

function makeClient(): KintoneClient & { readonly calls: GetRecordsParams[] } {
  const calls: GetRecordsParams[] = [];
  return {
    calls,
    async getRecords(params) {
      calls.push({ ...params, fields: [...params.fields] });
      const predicate = params.app === TRANSACTION ? numericPredicate(params.query) : null;
      const rows = (rowsByApp[params.app] ?? []).filter((row) =>
        predicate === null || predicate(String(row.個数?.value ?? ""))
      );
      return {
        records: rows.map((row) => Object.fromEntries(
          params.fields.flatMap((field) => row[field] === undefined ? [] : [[field, row[field]]])
        ) as KintoneRecord),
      };
    },
    async openCursor() { throw new Error("unexpected cursor call"); },
    async postRecords() { throw new Error("unexpected write"); },
    async putRecords() { throw new Error("unexpected write"); },
    async deleteRecords() { throw new Error("unexpected write"); },
    async getApps() { return []; },
    async getFields(appId) { return [...(fieldsByApp[appId] ?? [])]; },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const };
    },
  };
}

const JOIN_PREFIX =
  "SELECT t.$id, t.製品名, t.個数 "
  + `FROM APP${MASTER} AS m JOIN APP${TRANSACTION} AS t ON m.製品名 = t.製品名 WHERE `;

const OUTER_JOIN_SQL =
  "SELECT m.製品名, t.個数 "
  + `FROM APP${MASTER} AS m LEFT JOIN APP${TRANSACTION} AS t ON m.製品名 = t.製品名 `
  + "WHERE t.個数 <= 100 ORDER BY m.$id";

function joinSql(condition: string): string {
  return `${JOIN_PREFIX}${condition} ORDER BY t.$id`;
}

function residualSql(condition: string): string {
  return `${JOIN_PREFIX}${condition} OR t.製品名 LIKE '__B151_NO_MATCH__' ORDER BY t.$id`;
}

function singleSql(condition: string): string {
  return `SELECT $id, 製品名, 個数 FROM APP${TRANSACTION} WHERE ${condition} ORDER BY $id`;
}

function productNames(result: SelectResult): string[] {
  return result.rows.map((row) => String(row.製品名));
}

function planText(result: SelectResult): string {
  return result.rows.map((row) => String(row.plan)).join("\n");
}

function expectedQuery(condition: string): string {
  if (condition === "個数 = -0" || condition === "個数 = +0") return "個数 = 0";
  if (condition === "個数 IN (-6, 10, 1e3)") return IN_QUERY;
  return condition
    .replace("1e3", "1000")
    .replace("<> ", "!= ")
    .replace(" IN (", " in (")
    .replace(" NOT in (", " not in (")
    .replace(/, /g, ",");
}

const acceptance = [
  ["個数 <= 999999999999.99985", ["B151_EMPTY", "B151_NINE", "B151_TEN", "B151_NEGATIVE", "B151_ZERO", "B151_THOUSAND"]],
  ["個数 >= 999999999999.99985", ["B151_BOUNDARY", "B151_SAFE_PLUS_ONE"]],
  ["個数 < 100", ["B151_EMPTY", "B151_NINE", "B151_TEN", "B151_NEGATIVE", "B151_ZERO"]],
  ["個数 <= 100", ["B151_EMPTY", "B151_NINE", "B151_TEN", "B151_NEGATIVE", "B151_ZERO"]],
  ["個数 >= -5", ["B151_BOUNDARY", "B151_NINE", "B151_TEN", "B151_ZERO", "B151_THOUSAND", "B151_SAFE_PLUS_ONE"]],
  ["個数 > -5", ["B151_BOUNDARY", "B151_NINE", "B151_TEN", "B151_ZERO", "B151_THOUSAND", "B151_SAFE_PLUS_ONE"]],
  ["個数 < 10", ["B151_EMPTY", "B151_NINE", "B151_NEGATIVE", "B151_ZERO"]],
  ["個数 >= 10", ["B151_BOUNDARY", "B151_TEN", "B151_THOUSAND", "B151_SAFE_PLUS_ONE"]],
  ["個数 <= -5", ["B151_EMPTY", "B151_NEGATIVE"]],
  ["個数 = 1e3", ["B151_THOUSAND"]],
  ["個数 = -0", ["B151_ZERO"]],
  ["個数 = 9007199254740993", ["B151_SAFE_PLUS_ONE"]],
  ["個数 != 10", ["B151_BOUNDARY", "B151_EMPTY", "B151_NINE", "B151_NEGATIVE", "B151_ZERO", "B151_THOUSAND", "B151_SAFE_PLUS_ONE"]],
  ["個数 <> 10", ["B151_BOUNDARY", "B151_EMPTY", "B151_NINE", "B151_NEGATIVE", "B151_ZERO", "B151_THOUSAND", "B151_SAFE_PLUS_ONE"]],
  ["個数 IN (-6, 10, 1e3)", ["B151_TEN", "B151_NEGATIVE", "B151_THOUSAND"]],
  ["個数 NOT IN (-6, 10, 1e3)", ["B151_BOUNDARY", "B151_EMPTY", "B151_NINE", "B151_ZERO", "B151_SAFE_PLUS_ONE"]],
] as const;

describe("B151 mock-client acceptance", () => {
  test.each(acceptance)("§11 three paths and records query: %s", async (condition, expected) => {
    const pushed = makeClient();
    const residual = makeClient();
    const single = makeClient();
    const pushedResult = await execute(
      joinSql(`t.${condition}`),
      pushed,
      { cacheContext: `b151-pushed-${condition}` }
    ) as SelectResult;
    const residualResult = await execute(
      residualSql(`t.${condition}`),
      residual,
      { cacheContext: `b151-residual-${condition}` }
    ) as SelectResult;
    const singleResult = await execute(
      singleSql(condition),
      single,
      { cacheContext: `b151-single-${condition}` }
    ) as SelectResult;

    expect(new Set(productNames(pushedResult))).toEqual(new Set(expected));
    expect(pushedResult).toMatchObject({
      columns: residualResult.columns,
      rows: residualResult.rows,
      rowCount: residualResult.rowCount,
    });
    expect(singleResult).toMatchObject({
      columns: pushedResult.columns,
      rows: pushedResult.rows,
      rowCount: pushedResult.rowCount,
    });
    expect(new Set(productNames(singleResult))).toEqual(new Set(expected));
    expect(pushed.calls).toHaveLength(2);
    expect(residual.calls).toHaveLength(2);
    expect(single.calls).toHaveLength(1);
    expect(withoutPaging(pushed.calls.find((call) => call.app === MASTER)!.query)).toBe("");
    const transactionCalls = pushed.calls.filter((call) => call.app === TRANSACTION);
    expect(transactionCalls).toHaveLength(1);
    expect(withoutPaging(transactionCalls[0].query)).toBe(
      expectedQuery(condition)
    );
  });

  test("§11.9 raw +0 は query 0 になり -0 と同じ公開 rows", async () => {
    const minus = makeClient();
    const plus = makeClient();
    const minusResult = await execute(joinSql("t.個数 = -0"), minus) as SelectResult;
    const plusResult = await execute(joinSql("t.個数 = +0"), plus) as SelectResult;
    expect(plusResult.rows).toEqual(minusResult.rows);
    expect(withoutPaging(plus.calls.find((call) => call.app === TRANSACTION)!.query)).toBe("個数 = 0");
  });

  test("§11.2/8/10/11/13 EXPLAIN は runtime query・exact・EXACT を表示する", async () => {
    for (const [condition, query] of [
      ["t.個数 <= 999999999999.99985", "個数 <= 999999999999.99985"],
      ["t.個数 >= 1e3", "個数 >= 1000"],
      ["t.個数 = 9007199254740993", "個数 = 9007199254740993"],
      ["t.個数 = 10", "個数 = 10"],
      ["t.個数 != 10", "個数 != 10"],
      ["t.個数 IN (-6, 10, 1e3)", IN_QUERY],
      ["t.個数 NOT IN (-6, 10, 1e3)", "個数 not in (-6,10,1000)"],
    ] as const) {
      const client = makeClient();
      const text = planText(await execute(`EXPLAIN ${joinSql(condition)}`, client) as SelectResult);
      expect(client.calls).toEqual([]);
      expect(text).toContain(`kintone query: ${query}`);
      expect(text).toContain(`pushdown applied: ${query}`);
      expect(text).toContain("relation: exact");
      expect(text).toMatch(/fetch:\s+EXACT/);
      expect(text).toContain(`client residual: ${condition}`);
    }
  });

  test("§11.16-19 対象外・CALC・outer join は NUMBER exact を適用しない", async () => {
    const cases = [
      [`EXPLAIN ${joinSql("t.個数 + 0 >= 999999999999.99985")}`, "join pushdown not applied:"],
      [
        "EXPLAIN SELECT a.$id, a.計算値 FROM APP100 AS a "
          + "JOIN APP101 AS b ON a.キー = b.キー WHERE a.計算値 <= 100 ORDER BY a.$id",
        "join pushdown not applied:",
      ],
      [`EXPLAIN ${joinSql("t.個数 >= '100'")}`, "join pushdown not applied:"],
      [`EXPLAIN ${joinSql("t.個数 IN (10, '20')")}`, "join pushdown not applied:"],
      [`EXPLAIN ${joinSql("t.個数 >= 1e-11")}`, "join pushdown not applied:"],
      [`EXPLAIN ${joinSql("t.個数 >= 1000000000000000000000000000000")}`, "join pushdown not applied:"],
      [`EXPLAIN ${OUTER_JOIN_SQL}`, "OUTER_JOIN"],
    ] as const;
    for (const [sql, reason] of cases) {
      const client = makeClient();
      const text = planText(await execute(sql, client) as SelectResult);
      expect(text).toContain(reason);
      expect(text).not.toContain("pushdown applied: 個数");
      expect(text).not.toContain("pushdown applied: 計算値");
    }
  });

  test("§13.5 NUMBER exact と text superset の AND は PREFILTERED", async () => {
    const client = makeClient();
    const sql = joinSql("t.個数 >= 10 AND t.備考 = '確認'");
    const text = planText(await execute(`EXPLAIN ${sql}`, client) as SelectResult);
    expect(text).toContain('kintone query: 個数 >= 10 and 備考 = "確認"');
    expect(text).toContain("relation: superset");
    expect(text).toMatch(/fetch:\s+PREFILTERED/);
  });
});
