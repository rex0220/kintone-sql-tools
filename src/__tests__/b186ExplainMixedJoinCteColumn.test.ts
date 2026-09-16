import {
  execute,
  type KintoneClient,
  type KintoneFieldInfo,
  type SelectResult,
} from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";

function record(fields: Record<string, string>): KintoneRecord {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { value }]));
}

function mixedClient(): KintoneClient {
  const fields: Record<number, KintoneFieldInfo[]> = {
    4148: [
      { code: "顧客No", label: "顧客No", fieldType: "SINGLE_LINE_TEXT" },
      { code: "会社名", label: "会社名", fieldType: "SINGLE_LINE_TEXT" },
      { code: "Amount", label: "Amount", fieldType: "NUMBER" },
    ],
    4149: [
      { code: "顧客No_", label: "顧客No_", fieldType: "SINGLE_LINE_TEXT" },
      { code: "売上", label: "売上", fieldType: "NUMBER" },
    ],
  };
  const records: Record<number, KintoneRecord[]> = {
    4148: [
      record({ $id: "1", 顧客No: "C1", 会社名: "A社", Amount: "1" }),
      record({ $id: "2", 顧客No: "C2", 会社名: "B社", Amount: "2" }),
    ],
    4149: [
      record({ $id: "11", 顧客No_: "C1", 売上: "9000000" }),
      record({ $id: "12", 顧客No_: "C2", 売上: "6000000" }),
      record({ $id: "13", 顧客No_: "C2", 売上: "5000000" }),
    ],
  };
  return {
    async getRecords(params) { return { records: records[params.app] ?? [] }; },
    async openCursor() { throw new Error("unexpected cursor"); },
    async postRecords() { return { ids: [] }; },
    async putRecords() { return undefined; },
    async deleteRecords() { return undefined; },
    async getApps() { return []; },
    async getFields(appId) { return fields[appId] ?? []; },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() { return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const }; },
  };
}

function plan(result: SelectResult): string[] {
  return result.rows.map((row) => String(row.plan));
}

function mainPlan(lines: readonly string[]): string[] {
  const start = lines.indexOf("[main]");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((line, index) => index > start && /^\[/.test(line));
  return lines.slice(start, end < 0 ? undefined : end);
}

const aggregateCte =
  "WITH s AS (SELECT 顧客No_ AS custno, SUM(売上) AS amount FROM APP4149 GROUP BY 顧客No_) ";
const joinedSelect =
  "SELECT c.会社名, amount FROM APP4148 AS c INNER JOIN s ON c.顧客No = s.custno ";

test("B186: 集計 CTE の未修飾 WHERE は修飾済み WHERE と同じ EXPLAIN main plan になる", async () => {
  const unqualified = await execute(
    `EXPLAIN ${aggregateCte}${joinedSelect}WHERE amount > 10000000 ORDER BY amount DESC LIMIT 3`,
    mixedClient()
  ) as SelectResult;
  const qualified = await execute(
    `EXPLAIN ${aggregateCte}${joinedSelect}WHERE s.amount > 10000000 ORDER BY amount DESC LIMIT 3`,
    mixedClient()
  ) as SelectResult;

  expect(mainPlan(plan(unqualified))).toEqual(mainPlan(plan(qualified)));
});

test("B186: 非集計 CTE の未修飾 WHERE も修飾済み WHERE と同じ EXPLAIN main plan になる", async () => {
  const cte = "WITH s AS (SELECT 顧客No_ AS custno, 売上 AS amount FROM APP4149) ";
  const unqualified = await execute(
    `EXPLAIN ${cte}${joinedSelect}WHERE amount > 8000000 ORDER BY amount DESC`,
    mixedClient()
  ) as SelectResult;
  const qualified = await execute(
    `EXPLAIN ${cte}${joinedSelect}WHERE s.amount > 8000000 ORDER BY amount DESC`,
    mixedClient()
  ) as SelectResult;

  expect(mainPlan(plan(unqualified))).toEqual(mainPlan(plan(qualified)));
});

test("B186: 未修飾同名列は物理側で解析され fields に物理列が載る", async () => {
  const unqualified = await execute(
    "EXPLAIN WITH s AS (SELECT 顧客No_ AS custno, 売上 AS Amount FROM APP4149) " +
      "SELECT c.会社名 FROM APP4148 AS c INNER JOIN s ON c.顧客No = s.custno WHERE Amount > 1",
    mixedClient()
  ) as SelectResult;
  const main = mainPlan(plan(unqualified));

  expect(main.some((line) => line.includes("fields:") && line.includes("Amount"))).toBe(true);
});

test("B186: 存在しない未修飾列は従来どおり WHERE_FIELD_UNRESOLVED", async () => {
  await expect(execute(
    `EXPLAIN ${aggregateCte}${joinedSelect}WHERE missing > 1`,
    mixedClient()
  )).rejects.toThrow(/field=missing.*WHERE_FIELD_UNRESOLVED/);
});

test("B186: EXPLAIN が受理する未修飾 CTE 列の SQL は実行でも行を返す", async () => {
  const sql = `${aggregateCte}${joinedSelect}WHERE amount > 10000000 ORDER BY amount DESC LIMIT 3`;
  await expect(execute(`EXPLAIN ${sql}`, mixedClient())).resolves.toMatchObject({ type: "SELECT" });

  const result = await execute(sql, mixedClient()) as SelectResult;
  expect(result.rows).toEqual([{ 会社名: "B社", amount: "11000000" }]);
});
