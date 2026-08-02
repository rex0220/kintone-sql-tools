import {
  buildBatchExplainPlans,
  executeBatch,
  type KintoneClient,
} from "../execute";

function makeClient() {
  const calls: string[] = [];
  const queries: string[] = [];
  const client: KintoneClient = {
    async getRecords(params) {
      calls.push("getRecords");
      queries.push(params.query ?? "");
      return { records: [] };
    },
    async openCursor() { calls.push("openCursor"); throw new Error("unexpected cursor call"); },
    async postRecords() { calls.push("postRecords"); return { ids: [] }; },
    async putRecords() { calls.push("putRecords"); },
    async deleteRecords() { calls.push("deleteRecords"); },
    async getApps() { calls.push("getApps"); return []; },
    async getFields() {
      calls.push("getFields");
      return [
        { code: "受注予定日", label: "受注予定日", fieldType: "DATE" },
        { code: "作成日時", label: "作成日時", fieldType: "CREATED_TIME" },
        { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
      ];
    },
    async getProcessStatuses() { calls.push("getProcessStatuses"); return { enable: false, states: [] }; },
    async getNumberPrecision() {
      calls.push("getNumberPrecision");
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const };
    },
  };
  return { client, calls, queries };
}

test("RELATIVE_DATE 既定値を EXACT_PUSHDOWN し、日時フィールドにも同じ既存判定を使う", async () => {
  for (const field of ["受注予定日", "作成日時"]) {
    const { client } = makeClient();
    const result = await buildBatchExplainPlans(
      `DECLARE @p RELATIVE_DATE = THIS_MONTH(); SELECT * FROM APP100 WHERE ${field} = @p`,
      client
    );
    const text = result.statements.flatMap((statement) => statement.plan).join("\n");
    expect(text).toContain(`${field} = THIS_MONTH()`);
    expect(text).toContain("EXACT_PUSHDOWN");
  }
});

test.each([
  ["THIS_YEAR()", "THIS_YEAR()"],
  ["FROM_TODAY(-1, MONTHS)", "FROM_TODAY(-1, MONTHS)"],
  ["THIS_MONTH(LAST)", "THIS_MONTH(LAST)"],
  ["THIS_WEEK(MONDAY)", "THIS_WEEK(MONDAY)"],
])("RELATIVE_DATE 注入値 %s を関数ノードとして実行 query へ渡す", async (value, expected) => {
  const { client, queries } = makeClient();
  const result = await executeBatch(
    "DECLARE @p RELATIVE_DATE = TODAY(); SELECT * FROM APP100 WHERE 受注予定日 = @p",
    client,
    { variables: { p: value } }
  );
  expect(result.ok).toBe(true);
  expect(queries.some((query) => query.startsWith(`受注予定日 = ${expected}`))).toBe(true);
});

test.each([
  "2026-08-01",
  "'2026-08-01'",
  "LOGINUSER()",
  "THIS_MONTH",
  "THIS_MONTH() AND 1=1",
])("ホワイトリスト外の注入値 %s は名前入りエラー・API 0 回", async (value) => {
  const { client, calls } = makeClient();
  await expect(executeBatch(
    "DECLARE @p RELATIVE_DATE = THIS_MONTH(); SELECT * FROM APP100 WHERE 受注予定日 = @p",
    client,
    { variables: { p: value } }
  )).rejects.toThrow(/RELATIVE_DATE variable @p/);
  expect(calls).toEqual([]);
});

test.each([
  "SELECT @p AS period FROM APP100",
  "SELECT * FROM APP100 WHERE 受注予定日 IN (@p)",
  "SELECT 受注予定日, COUNT(*) FROM APP100 GROUP BY 受注予定日 HAVING 受注予定日 = @p",
  "UPDATE APP100 SET 受注予定日 = @p WHERE $id = 1",
  "DELETE FROM APP100 WHERE 受注予定日 = @p",
])("配置違反・DML %s は API 0 回", async (statement) => {
  const { client, calls } = makeClient();
  await expect(executeBatch(
    `DECLARE @p RELATIVE_DATE = THIS_MONTH(); ${statement}`,
    client
  )).rejects.toThrow(/RELATIVE_DATE variable @p/);
  expect(calls).toEqual([]);
});

test("注釈なし DECLARE TODAY はクライアント評価の日付リテラルのまま", async () => {
  const { client, queries } = makeClient();
  const result = await executeBatch(
    "DECLARE @p = TODAY(); SELECT * FROM APP100 WHERE 受注予定日 = @p",
    client
  );
  expect(result.ok).toBe(true);
  expect(queries[0]).toMatch(/^受注予定日 = "\d{4}-\d{2}-\d{2}"/);
  expect(queries[0]).not.toContain("TODAY()");
});
