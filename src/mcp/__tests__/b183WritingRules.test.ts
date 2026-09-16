import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { KintoneRecord } from "../../converter/dmlToKintone";
import {
  execute,
  type KintoneClient,
  type KintoneFieldInfo,
  type SelectResult,
} from "../../execute";
import { KSQL_MCP_INSTRUCTIONS } from "../index";

const languageReference = readFileSync(
  resolve("docs/ksql_language_reference.md"),
  "utf8"
).replace(/\r\n/g, "\n");
const batchRecipes = readFileSync(
  resolve("docs/ksql_batch_recipes.md"),
  "utf8"
).replace(/\r\n/g, "\n");

const WRITING_RULE_MARKERS = [
  "Writing rules (learned from real failures):",
  "ksql_describe_app first",
  "join-key prefilter flows only FROM",
  "Relative-date functions are WHERE-only",
  "there is no NULL",
  "may share a SELECT with aggregates",
  "lowercased in result names",
  "Output only the requested columns",
  "ksql_validate, then ksql_explain",
] as const;

function occurrences(text: string, value: string): number {
  return text.split(value).length - 1;
}

function record(values: Record<string, string>): KintoneRecord {
  return Object.fromEntries(
    Object.entries(values).map(([code, value]) => [code, { value }])
  );
}

function client(records: KintoneRecord[], fields: KintoneFieldInfo[]): KintoneClient {
  return {
    async getRecords() { return { records }; },
    async openCursor() { throw new Error("unexpected cursor call"); },
    async postRecords() { return { ids: [] }; },
    async putRecords() {},
    async deleteRecords() {},
    async getApps() { return []; },
    async getFields() { return fields; },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const };
    },
  };
}

describe("B183 MCP Writing rules", () => {
  test.each(WRITING_RULE_MARKERS)("instructions contain %s exactly once", (marker) => {
    expect(occurrences(KSQL_MCP_INSTRUCTIONS, marker)).toBe(1);
  });

  test("every rule has an existing public-reference heading", () => {
    for (const heading of [
      "### DESCRIBE / DESC — フィールド一覧取得",
      "## 7. JOIN",
      "### WHERE の REST 押し下げ",
      "### 相対日付関数",
      "### 算術の精度と空セル（重要な制約）",
      "## 5. 文字列・数値関数",
      "## 10.1 ウィンドウ関数",
      "### 大文字・小文字",
      "### 特定フィールド指定",
      "## 24. EXPLAIN",
      "### 出力の読み方",
    ]) {
      expect(languageReference).toContain(heading);
    }
    for (const heading of [
      "## R2. 事前ゲート（件数チェック・inserts/updates 内訳）",
      "## R14. 累積残高（台帳）を取引順で計算する",
      "## R17. 「行の無いもの」を 0 として並べる（マスタ起点の `LEFT JOIN`）",
    ]) {
      expect(batchRecipes).toContain(heading);
    }
  });

  test("Writing rules do not duplicate either catalog paragraph", () => {
    const paragraphs = KSQL_MCP_INSTRUCTIONS.trim().split(/\n\n/);
    const writingRules = paragraphs.find((paragraph) =>
      paragraph.startsWith("Writing rules (learned from real failures):")
    );
    const catalogs = paragraphs.filter((paragraph) =>
      paragraph.startsWith("Statement templates")
      || paragraph.startsWith("Complete function catalog")
    );
    expect(writingRules).toBeDefined();
    expect(catalogs).toHaveLength(2);
    for (const rule of writingRules?.split("\n").slice(1) ?? []) {
      expect(rule.startsWith("- ")).toBe(true);
      for (const catalog of catalogs) expect(catalog).not.toContain(rule.slice(2));
    }
  });

  test("documented zero-fill, denominator guard, rank, and ROWS SQL executes numerically", async () => {
    const mock = client([
      record({ key: "A", x: "", total: "5" }),
      record({ key: "B", x: "2", total: "2" }),
      record({ key: "C", x: "10", total: "5" }),
      // LEFT JOIN の不一致側や 0 件集計で分母が '' になる行。= 0 だけでは捕まらない
      record({ key: "D", x: "1", total: "" }),
    ], [
      { code: "key", label: "key", fieldType: "SINGLE_LINE_TEXT", sortKind: "string" },
      { code: "x", label: "x", fieldType: "NUMBER", sortKind: "number" },
      { code: "total", label: "total", fieldType: "NUMBER", sortKind: "number" },
    ]);
    const result = await execute(`WITH prepared AS (
  SELECT key, x, CASE WHEN x = '' THEN 0 ELSE x END AS x0, total
  FROM APP183
), windowed AS (
  SELECT key, x0,
         CASE WHEN total = '' OR total = 0 THEN 0 ELSE x0 / total END AS ratio,
         RANK() OVER (ORDER BY x DESC) AS ranking,
         SUM(x) OVER (
           ORDER BY x, key
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
         ) AS running_total
  FROM prepared
)
SELECT key, x0, ratio, ranking, running_total
FROM windowed
ORDER BY ranking`, mock, { cacheContext: "b183-writing-rules" }) as SelectResult;

    expect(result.rows).toEqual([
      { key: "C", x0: "10", ratio: "2", ranking: "1", running_total: "13" },
      { key: "B", x0: "2", ratio: "1", ranking: "2", running_total: "3" },
      { key: "D", x0: "1", ratio: "0", ranking: "3", running_total: "1" },
      { key: "A", x0: "0", ratio: "0", ranking: "4", running_total: "0" },
    ]);
  });
});
