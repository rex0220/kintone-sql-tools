import {
  buildBatchExplainPlans,
  execute,
  type KintoneClient,
  type KintoneFieldInfo,
  type SelectResult,
} from "../execute";

const fields: readonly KintoneFieldInfo[] = [
  { code: "登録日", label: "登録日", fieldType: "DATE" },
  { code: "確度", label: "確度", fieldType: "DROP_DOWN", optionOrder: { A: 0, B: 1 } },
  { code: "顧客ID", label: "顧客ID", fieldType: "SINGLE_LINE_TEXT" },
  { code: "顧客名", label: "顧客名", fieldType: "SINGLE_LINE_TEXT" },
];

function makeClient(): KintoneClient {
  return {
    async getRecords() { throw new Error("records API must not be called by EXPLAIN"); },
    async openCursor() { throw new Error("cursor API must not be called by EXPLAIN"); },
    async postRecords() { throw new Error("unexpected write"); },
    async putRecords() { throw new Error("unexpected write"); },
    async deleteRecords() { throw new Error("unexpected write"); },
    async getApps() { return []; },
    async getFields() { return [...fields]; },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const };
    },
  };
}

async function explain(sql: string): Promise<string[]> {
  const result = await execute(`EXPLAIN ${sql}`, makeClient()) as SelectResult;
  return result.rows.map((row) => String(row.plan));
}

function sourceFetch(plan: readonly string[], source: RegExp): string {
  const sourceIndex = plan.findIndex((line) => source.test(line));
  expect(sourceIndex).toBeGreaterThanOrEqual(0);
  const nextSource = plan.findIndex((line, index) =>
    index > sourceIndex && /^\s*(?:app:|(?:LEFT |RIGHT )?JOIN:)\s+/.test(line)
  );
  const blockEnd = nextSource < 0 ? plan.length : nextSource;
  return plan.slice(sourceIndex, blockEnd).find((line) => /^\s*fetch:\s+/.test(line)) ?? "";
}

test.each([
  ["COUNT_TOTAL_COUNT", "SELECT COUNT(*) FROM APP100", "fetch summary: COUNT_ONLY", "  fetch:         COUNT_ONLY (limit 1)"],
  [
    "whole-WHERE exact",
    "SELECT 登録日 FROM APP100 WHERE 登録日 >= '2026-01-01' AND 登録日 < '2027-01-01'",
    "fetch summary: EXACT",
    "  fetch:         EXACT",
  ],
  [
    "metadata-resolved exact prefilter",
    "SELECT 確度, COUNT(*) FROM APP100 WHERE 確度 IN ('A') GROUP BY 確度",
    "fetch summary: EXACT",
    "  fetch:         EXACT",
  ],
  ["LIKE full scan", "SELECT 顧客名 FROM APP100 WHERE 顧客名 LIKE 'A%'", "fetch summary: ALL", "  fetch:         ALL"],
] as const)("B114: 実測4形 %s", async (_name, sql, summary, fetch) => {
  const plan = await explain(sql);
  expect(plan[0]).toBe(summary);
  expect(plan).toContain(fetch);
  const queryIndex = plan.findIndex((line) => /^\s*kintone query:/.test(line));
  expect(plan[queryIndex + 1]).toBe(fetch);
});

test("B114: JOIN は alias ごとに EXACT / ALL、summary は ALL", async () => {
  const plan = await explain(
    "SELECT a.顧客ID, b.確度 FROM APP100 a INNER JOIN APP200 b " +
      "ON a.顧客ID = b.顧客ID WHERE a.顧客名 LIKE 'A%' AND b.確度 IN ('A')"
  );
  expect(plan[0]).toBe("fetch summary: ALL");
  expect(sourceFetch(plan, /^\s*app:\s+APP100 AS a/)).toBe("  fetch:         ALL");
  expect(sourceFetch(plan, /^\s*JOIN:\s+APP200 AS b/)).toBe("  fetch:         EXACT");
});

test("B114: UNION は枝ごとに COUNT_ONLY / ALL、summary は文全体で1行の ALL", async () => {
  const plan = await explain(
    "SELECT COUNT(*) AS c FROM APP100 UNION ALL " +
      "SELECT COUNT(顧客名) AS c FROM APP200 WHERE 顧客名 LIKE 'A%'"
  );
  expect(plan[0]).toBe("fetch summary: ALL");
  expect(plan.filter((line) => line.startsWith("fetch summary:"))).toEqual(["fetch summary: ALL"]);
  const first = plan.indexOf("[union:1]");
  const second = plan.indexOf("[union:2]");
  expect(plan.slice(first, second)).toContain("  fetch:         COUNT_ONLY (limit 1)");
  expect(plan.slice(second)).toContain("  fetch:         ALL");
});

test("B114: 一時テーブルだけを読む文には fetch summary / fetch を出さない", async () => {
  const plans = await buildBatchExplainPlans(
    "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP100; SELECT 顧客名 FROM #t",
    makeClient()
  );
  const tempOnly = plans.statements[1].plan;
  expect(tempOnly).not.toEqual(expect.arrayContaining([
    expect.stringMatching(/^fetch summary:/),
    expect.stringMatching(/^\s*fetch:/),
  ]));
  expect(tempOnly[0]).toBe("  mode:          FULL_SCAN（一時テーブル参照）");
});

test("B114: COUNT_ONLY と物理 source なしの NONE が同じバッチで併存する", async () => {
  const plans = await buildBatchExplainPlans(
    "CREATE TEMP TABLE #t AS SELECT COUNT(*) AS 件数 FROM APP100; SELECT 件数 FROM #t",
    makeClient()
  );
  expect(plans.statements[0].plan.some((line) =>
    line.trim() === "fetch summary: COUNT_ONLY"
  )).toBe(true);
  expect(plans.statements[0].plan.some((line) =>
    line.trim() === "fetch:         COUNT_ONLY (limit 1)"
  )).toBe(true);
  expect(plans.statements[1].plan).not.toEqual(expect.arrayContaining([
    expect.stringMatching(/^fetch summary:/),
    expect.stringMatching(/^\s*fetch:/),
  ]));
});

test("B114: CTE の物理 source と effective plan に limit 接尾辞を出す", async () => {
  const plan = await explain(
    "WITH x AS (SELECT 顧客名 FROM APP100 WHERE 顧客名 = 'A' LIMIT 5) SELECT 顧客名 FROM x"
  );
  expect(plan[0]).toBe("fetch summary: EXACT");
  expect(plan).toContain("  fetch:         EXACT (limit 5)");
  expect(plan.filter((line) => /^\s*fetch:\s+/.test(line))).toEqual([
    "  fetch:         EXACT (limit 5)",
    "  fetch:         EXACT (limit 5)",
  ]);
});

test("B114: DML / VALIDATE の計画と mode 行は変更対象外", async () => {
  const select = await explain("SELECT 顧客名 FROM APP100 WHERE 顧客名 = 'A'");
  expect(select).toContain("  mode:          SIMPLE");

  const dml = await explain("INSERT INTO APP200 (顧客名) SELECT 顧客名 FROM APP100");
  const validate = await explain("VALIDATE APP100");
  for (const plan of [dml, validate]) {
    expect(plan).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/^fetch summary:/),
      expect.stringMatching(/^\s*fetch:/),
    ]));
  }
});
