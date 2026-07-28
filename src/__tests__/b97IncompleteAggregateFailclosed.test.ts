import {
  execute,
  type KintoneClient,
  type KintoneFieldInfo,
  type SelectResult,
} from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";
import { FetchAllLimitError } from "../api/fetchAll";
import { completeInputReasons } from "../core/dmlGuard";
import { Lexer } from "../lexer/lexer";
import { Parser } from "../parser/parser";
import type { Statement } from "../types/ast";

function parse(sql: string): Statement {
  return new Parser(new Lexer(sql).tokenize()).parse();
}

function record(id: number, values: Record<string, string>): KintoneRecord {
  return Object.fromEntries(
    Object.entries({ $id: String(id), ...values })
      .map(([code, value]) => [code, { value }])
  );
}

const SOURCE = [
  record(1, { 顧客No: "1", 案件名: "one", 区分: "A", 金額: "10" }),
  record(2, { 顧客No: "2", 案件名: "two", 区分: "A", 金額: "20" }),
  record(3, { 顧客No: "3", 案件名: "three", 区分: "B", 金額: "30" }),
  record(4, { 顧客No: "6", 案件名: "six", 区分: "B", 金額: "40" }),
  record(5, { 顧客No: "16", 案件名: "sixteen", 区分: "C", 金額: "50" }),
  record(6, { 顧客No: "26", 案件名: "twenty-six", 区分: "C", 金額: "60" }),
];

const FIELDS: KintoneFieldInfo[] = [
  { code: "顧客No", label: "顧客No", fieldType: "SINGLE_LINE_TEXT" },
  { code: "案件名", label: "案件名", fieldType: "SINGLE_LINE_TEXT" },
  { code: "区分", label: "区分", fieldType: "SINGLE_LINE_TEXT" },
  { code: "金額", label: "金額", fieldType: "NUMBER" },
];

function makeClient(totalCount?: string): KintoneClient {
  return {
    async getRecords(params) {
      if (params.totalCount === true) {
        return { records: SOURCE.slice(0, 1), totalCount };
      }
      const query = params.query ?? "";
      const limit = Number(/\blimit\s+(\d+)/i.exec(query)?.[1] ?? SOURCE.length);
      const offset = Number(/\boffset\s+(\d+)/i.exec(query)?.[1] ?? 0);
      return { records: SOURCE.slice(offset, offset + limit) };
    },
    async openCursor() {
      throw new Error("unexpected cursor call");
    },
    async postRecords() {
      return { ids: [] };
    },
    async putRecords() { /* noop */ },
    async deleteRecords() { /* noop */ },
    async getApps() {
      return [];
    },
    async getFields() {
      return FIELDS;
    },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" };
    },
    async getProcessStatuses() {
      return { enable: false, states: [] };
    },
  };
}

test.each([
  ["SELECT COUNT(*) FROM APP4147", ["AGGREGATE"]],
  ["SELECT SUM(金額) + 1 FROM APP4147", ["AGGREGATE"]],
  ["SELECT 区分 FROM APP4147 GROUP BY 区分", ["GROUP_BY"]],
  ["SELECT DISTINCT 区分 FROM APP4147", ["DISTINCT"]],
  ["SELECT 区分 FROM APP4147 UNION SELECT 区分 FROM APP4148", ["DISTINCT"]],
  ["SELECT MEDIAN(金額) FROM APP4147", ["STATISTICAL_AGGREGATE"]],
])("B97: %s の完全入力理由を AST から判定する", (sql, expected) => {
  expect([...completeInputReasons(parse(sql))]).toEqual(expected);
});

test("B97: UNION ALL は DISTINCT 理由を持たない", () => {
  expect([...completeInputReasons(parse(
    "SELECT 区分 FROM APP4147 UNION ALL SELECT 区分 FROM APP4148"
  ))]).toEqual([]);
});

test("B97: APP4147 再現形の local LIKE COUNT(*) は 0 を返さず fail-closed", async () => {
  await expect(execute(
    "SELECT COUNT(*) AS c FROM APP4147 WHERE 顧客No LIKE '%6%'",
    makeClient(),
    { maxRecords: 3, onLimitReached: "truncate" }
  )).rejects.toThrow(
    /集計の正しい結果.*complete input reason: AGGREGATE.*onLimit=truncateは使用できません/
  );
});

test.each(["SUM", "AVG", "MIN", "MAX"] as const)(
  "B97: %s は部分入力を集計せず fail-closed",
  async (func) => {
    await expect(execute(
      `SELECT ${func}(金額) AS value FROM APP4147`,
      makeClient(),
      { maxRecords: 3, onLimitReached: "truncate" }
    )).rejects.toThrow(/complete input reason: AGGREGATE/);
  }
);

test.each([
  [
    "SELECT 区分 FROM APP4147 GROUP BY 区分",
    /グループ集計の正しい結果.*complete input reason: GROUP_BY/,
  ],
  [
    "SELECT DISTINCT 区分 FROM APP4147",
    /DISTINCT の正しい結果.*complete input reason: DISTINCT/,
  ],
] as const)("B97: 単独理由に対応したエラー主語を使う", async (sql, message) => {
  await expect(execute(
    sql,
    makeClient(),
    { maxRecords: 3, onLimitReached: "truncate" }
  )).rejects.toThrow(message);
});

test.each([
  [
    "集計系だけは具体性の優先順を使う",
    "SELECT DISTINCT 区分, COUNT(*) AS c FROM APP4147 GROUP BY 区分",
    /集計の正しい結果.*complete input reason: GROUP_BY, DISTINCT, AGGREGATE/,
  ],
  [
    "並び系だけは ORDER BY を主語にする",
    "SELECT 案件名 FROM APP4147 WHERE 案件名 LIKE '%' ORDER BY 案件名",
    /ORDER BYの正しい結果.*complete input reason: LOCAL_ORDER/,
  ],
  [
    "集計系と並び系の両方はクエリを主語にする",
    "SELECT 区分, MEDIAN(金額) AS m FROM APP4147 GROUP BY 区分 ORDER BY m",
    /クエリの正しい結果.*complete input reason: GROUP_BY, LOCAL_ORDER, STATISTICAL_AGGREGATE/,
  ],
] as const)("B97: 主語規則 — %s", async (_label, sql, message) => {
  await expect(execute(
    sql,
    makeClient(),
    { maxRecords: 3, onLimitReached: "truncate" }
  )).rejects.toThrow(message);
});

test("B97: UNION は fail-closed、UNION ALL は従来どおり成功する", async () => {
  const union = "SELECT 案件名 FROM APP4147 UNION SELECT 案件名 FROM APP4148";
  try {
    await execute(
      union,
      makeClient(),
      { maxRecords: 3, onLimitReached: "truncate" }
    );
    throw new Error("expected FetchAllLimitError");
  } catch (error) {
    expect(error).toBeInstanceOf(FetchAllLimitError);
    expect(error).toMatchObject({ completeInputWrapped: true });
    const message = (error as Error).message;
    expect(message).toMatch(/DISTINCT の正しい結果.*complete input reason: DISTINCT/);
    expect(message.match(/complete input reason:/g)).toHaveLength(1);
  }

  const unionAll = await execute(
    union.replace(" UNION ", " UNION ALL "),
    makeClient(),
    { maxRecords: 3, onLimitReached: "truncate" }
  ) as SelectResult;
  expect(unionAll.rows).toHaveLength(6);
});

test("B97: 素の明細は従来どおり行と警告を返す", async () => {
  const result = await execute(
    "SELECT 案件名 FROM APP4147",
    makeClient(),
    { maxRecords: 3, onLimitReached: "truncate" }
  ) as SelectResult;

  expect(result.rows).toEqual([
    { 案件名: "one" },
    { 案件名: "two" },
    { 案件名: "three" },
  ]);
  expect(result.warnings).toEqual([
    "取得上限（3 件）に達したため、3 件で打ち切って表示しています。",
  ]);
});

test("B97: onLimitReached=error の既存 FetchAllLimitError を維持する", async () => {
  await expect(execute(
    "SELECT 案件名 FROM APP4147",
    makeClient(),
    { maxRecords: 3, onLimitReached: "error" }
  )).rejects.toThrow("取得件数が上限（3 件）を超えました。");
});

test("B97: B94 exact COUNT(*) は truncate と maxRecords を無視して totalCount を返す", async () => {
  const result = await execute(
    "SELECT COUNT(*) AS c FROM APP4147 WHERE 金額 > 0",
    makeClient("123456"),
    { maxRecords: 1, onLimitReached: "truncate" }
  ) as SelectResult;

  expect(result.rows).toEqual([{ c: "123456" }]);
  expect(result.warnings).toEqual([]);
});
