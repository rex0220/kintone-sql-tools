import { parseScript } from "../core/script";
import { parseSqlStatementsForScript } from "../core/sql";
import { normalizeSqlAppProfiles } from "../core/logicalApps";
import { executeBatch, type KintoneClient, type SelectResult } from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";

function record(values: Record<string, string>): KintoneRecord {
  return Object.fromEntries(Object.entries(values).map(([code, value]) => [code, { value }]));
}

function client(options: { advanceOnGet?: Date; records?: KintoneRecord[] } = {}): KintoneClient & {
  queries: string[];
  posts: Array<Parameters<KintoneClient["postRecords"]>[0]>;
} {
  const queries: string[] = [];
  const posts: Array<Parameters<KintoneClient["postRecords"]>[0]> = [];
  let advanced = false;
  const records = options.records ?? [record({ $id: "1", 日付: "2026-08-22" })];
  return {
    queries,
    posts,
    async getRecords(params) {
      queries.push(params.query ?? "");
      if (!advanced && options.advanceOnGet) {
        advanced = true;
        jest.setSystemTime(options.advanceOnGet);
      }
      return { records };
    },
    async openCursor() {
      return {
        totalCount: records.length,
        async nextPage() { return { records, next: false }; },
        async close() { /* noop */ },
      };
    },
    async postRecords(params) {
      posts.push(params);
      return { ids: params.records.map((_, index) => String(index + 1)) };
    },
    async putRecords() { /* noop */ },
    async deleteRecords() { /* noop */ },
    async getApps() { return []; },
    async getFields() {
      return [
        { code: "$id", label: "レコード番号", fieldType: "RECORD_NUMBER" },
        { code: "日付", label: "日付", fieldType: "DATE" },
        { code: "n", label: "n", fieldType: "DATETIME" },
        { code: "d", label: "d", fieldType: "DATE" },
        { code: "m", label: "m", fieldType: "DATE" },
        { code: "nm", label: "nm", fieldType: "DATE" },
        { code: "tags", label: "tags", fieldType: "MULTI_SELECT" },
        { code: "flag", label: "flag", fieldType: "SINGLE_LINE_TEXT" },
      ];
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() { return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const }; },
  };
}

const header = "-- @ksql dialect: 1\n";

test("injected asOf drives all four functions across statements while B169 remains statement-scoped", async () => {
  const asOf = new Date("2026-08-21T18:00:00.123Z");
  const later = new Date("2026-08-21T19:30:00.456Z");
  jest.useFakeTimers().setSystemTime(asOf);
  try {
    const result = await executeBatch(
      header
        + "SELECT @NOW() AS n, @TODAY() AS d, @MONTH_START() AS m, @NEXT_MONTH_START() AS nm, CURRENT_TIMESTAMP() AS c FROM APP100;"
        + "SELECT @NOW() AS n, @TODAY() AS d, @MONTH_START() AS m, @NEXT_MONTH_START() AS nm, CURRENT_TIMESTAMP() AS c;",
      client({ advanceOnGet: later }),
      { asOf, timezone: "Asia/Tokyo" }
    );
    expect((result.statements[0].result as SelectResult).rows[0]).toEqual({
      n: "2026-08-21T18:00:00.123Z",
      d: "2026-08-22",
      m: "2026-08-01",
      nm: "2026-09-01",
      c: "2026-08-21T18:00:00.123Z",
    });
    expect((result.statements[1].result as SelectResult).rows[0]).toEqual({
      n: "2026-08-21T18:00:00.123Z",
      d: "2026-08-22",
      m: "2026-08-01",
      nm: "2026-09-01",
      c: "2026-08-21T19:30:00.456Z",
    });
  } finally {
    jest.useRealTimers();
  }
});

test("B171: INSERT VALUES の as-of 4関数は実行時に同一バッチ時刻へ展開される", async () => {
  const asOf = new Date("2026-08-21T18:00:00.123Z");
  const mock = client();
  const result = await executeBatch(
    `${header}INSERT INTO APP171 (n,d,m,nm,tags,flag) VALUES (`
      + "@NOW(),@TODAY(),@MONTH_START(),@NEXT_MONTH_START(),['A','B'],CASE WHEN missing='x' THEN 'yes' ELSE 'no' END),"
      + "(@NOW(),@TODAY(),@MONTH_START(),@NEXT_MONTH_START(),['C'],'no')",
    mock,
    { asOf, timezone: "Asia/Tokyo" }
  );
  expect(result.statements[0]?.error).toBeUndefined();
  expect(result.ok).toBe(true);
  expect(mock.posts).toHaveLength(1);
  expect(mock.posts[0].records).toEqual([
    {
      n: { value: asOf.toISOString() }, d: { value: "2026-08-22" },
      m: { value: "2026-08-01" }, nm: { value: "2026-09-01" },
      tags: { value: ["A", "B"] }, flag: { value: "no" },
    },
    {
      n: { value: asOf.toISOString() }, d: { value: "2026-08-22" },
      m: { value: "2026-08-01" }, nm: { value: "2026-09-01" },
      tags: { value: ["C"] }, flag: { value: "no" },
    },
  ]);
});

test("omitted asOf is captured once at executeBatch entry", async () => {
  const first = new Date("2026-08-21T12:34:56.789Z");
  const second = new Date("2026-08-21T12:35:30.123Z");
  jest.useFakeTimers().setSystemTime(first);
  try {
    const result = await executeBatch(
      `${header}SELECT @NOW() AS n FROM APP100; SELECT @NOW() AS n;`,
      client({ advanceOnGet: second }),
      { timezone: "UTC" }
    );
    expect((result.statements[0].result as SelectResult).rows[0].n).toBe(first.toISOString());
    expect((result.statements[1].result as SelectResult).rows[0].n).toBe(first.toISOString());
  } finally {
    jest.useRealTimers();
  }
});

test("timezone controls calendar boundaries and invalid IANA names fail before API calls", async () => {
  const asOf = new Date("2026-08-21T18:00:00.000Z");
  const tokyo = await executeBatch(
    `${header}SELECT @TODAY() AS d, @MONTH_START() AS m, @NEXT_MONTH_START() AS n`,
    client(), { asOf, timezone: "Asia/Tokyo" }
  );
  const utc = await executeBatch(
    `${header}SELECT @TODAY() AS d, @MONTH_START() AS m, @NEXT_MONTH_START() AS n`,
    client(), { asOf, timezone: "UTC" }
  );
  expect((tokyo.statements[0].result as SelectResult).rows[0]).toEqual({ d: "2026-08-22", m: "2026-08-01", n: "2026-09-01" });
  expect((utc.statements[0].result as SelectResult).rows[0]).toEqual({ d: "2026-08-21", m: "2026-08-01", n: "2026-09-01" });
  await expect(executeBatch(`${header}SELECT @NOW() AS n`, client(), {
    asOf, timezone: "Not/A_Real_Zone",
  })).rejects.toThrow("invalid IANA timezone");
});

test("as-of syntax is dialect gated, validates names, and does not collide with @now variable", async () => {
  expect(() => parseSqlStatementsForScript("SELECT @now() AS n"))
    .toThrow();
  expect(() => parseSqlStatementsForScript(`${header}SELECT @unknown() AS n`))
    .toThrow("使用可能な as-of 関数は @NOW/@TODAY/@MONTH_START/@NEXT_MONTH_START です");

  const result = await executeBatch(
    `${header}SET @now = 'variable'; SELECT @now AS v, @NOW() AS n`,
    client(), { asOf: new Date("2026-08-21T00:00:00.000Z"), timezone: "UTC" }
  );
  expect((result.statements[1].result as SelectResult).rows[0]).toEqual({
    v: "variable", n: "2026-08-21T00:00:00.000Z",
  });
});

test("dialect 1 bare server time functions warn once without stopping execution; dialect 0 does not", async () => {
  const flow = await executeBatch(
    `${header}SELECT 日付 FROM APP100 WHERE 日付 = TODAY() OR 日付 = YESTERDAY()`,
    client()
  );
  expect(flow.ok).toBe(true);
  expect(flow.warnings).toHaveLength(1);
  expect(flow.warnings?.[0]).toContain("kintone サーバー評価のため as-of の対象外");
  expect((flow.statements[0].result as SelectResult).warnings).toHaveLength(1);

  const legacy = await executeBatch("SELECT 日付 FROM APP100 WHERE 日付 = TODAY()", client());
  expect(legacy.warnings).toBeUndefined();
  expect((legacy.statements[0].result as SelectResult).warnings).toEqual([]);
});

test("parseScript accepts all as-of locations used by acceptance SQL after LAPP resolution", () => {
  expect(() => parseSqlStatementsForScript(
    `${header}SELECT * FROM APP100 WHERE 日付 >= @MONTH_START() AND 日付 < @NEXT_MONTH_START();`
  )).not.toThrow();
  const parsed = parseScript(
    `${header}SELECT * FROM LAPP_受注 WHERE 日付 >= @MONTH_START() AND 日付 < @NEXT_MONTH_START();\n`
      + "UPSERT INTO LAPP_顧客 (日時) SELECT @NOW() FROM LAPP_受注 KEY (日時);",
    { apps: { 受注: 100, 顧客: 200 } }
  );
  expect(parsed.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  expect(parsed.statements.map((item) => item.type)).toEqual(["SELECT", "UPSERT_SELECT"]);
});

test("acceptance 2 Flow job parses with apps and executes UPSERT @NOW() as one literal", async () => {
  const sql = `-- @ksql name: monthly_sales_sync
-- @ksql depends_on: sync_master_customers
-- @ksql timeout: 600
-- @ksql dialect: 1
ASSERT (
  SELECT COUNT(*) FROM LAPP_受注
  WHERE 受注日 >= @MONTH_START() AND 受注日 < @NEXT_MONTH_START() AND 金額 < 0
) = 0, '【異常中断】マイナスの売上データが存在するため処理を停止しました';

CREATE TEMP TABLE temp_monthly_summary AS
SELECT 顧客コード, COUNT(レコード番号) AS 受注件数, SUM(金額) AS 当月売上合計
FROM LAPP_受注
WHERE 受注日 >= @MONTH_START() AND 受注日 < @NEXT_MONTH_START() AND ステータス = '受注完了'
GROUP BY 顧客コード;

EXIT SUCCESS IF (SELECT COUNT(*) FROM temp_monthly_summary) = 0,
  '集計対象となる受注データが 0 件のためスキップ';

UPSERT INTO LAPP_顧客マスタ (顧客コード, 当月受注件数, 当月売上実績, 最終集計日時)
SELECT 顧客コード, 受注件数, 当月売上合計, @NOW()
FROM temp_monthly_summary
KEY (顧客コード);`;
  const apps = { 受注: 100, 顧客マスタ: 200 };
  const parsed = parseScript(sql, { apps });
  expect(parsed.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  expect(parsed.statements.map((item) => item.type))
    .toEqual(["ASSERT", "CREATE_TEMP_TABLE", "EXIT", "UPSERT_SELECT"]);

  const posts: Array<Parameters<KintoneClient["postRecords"]>[0]> = [];
  const sourceRows = [
    record({ $id: "1", レコード番号: "1", 顧客コード: "A", 金額: "100", 受注日: "2026-08-05", ステータス: "受注完了" }),
    record({ $id: "2", レコード番号: "2", 顧客コード: "B", 金額: "200", 受注日: "2026-08-10", ステータス: "受注完了" }),
  ];
  const mock: KintoneClient = {
    async getRecords(params) {
      const query = params.query ?? "";
      if (query.includes("受注日") || query.includes("ステータス") || query.includes("金額")) {
        return { records: query.includes("金額 < 0") ? [] : sourceRows };
      }
      return { records: [] };
    },
    async openCursor() { throw new Error("unexpected cursor call"); },
    async postRecords(params) {
      posts.push(params);
      return { ids: params.records.map((_, index) => String(index + 10)) };
    },
    async putRecords() { /* noop */ },
    async deleteRecords() { /* noop */ },
    async getApps() { return []; },
    async getFields() {
      return [
        { code: "レコード番号", label: "レコード番号", fieldType: "RECORD_NUMBER" },
        { code: "顧客コード", label: "顧客コード", fieldType: "SINGLE_LINE_TEXT", isUnique: true },
        { code: "金額", label: "金額", fieldType: "NUMBER" },
        { code: "受注日", label: "受注日", fieldType: "DATE" },
        { code: "ステータス", label: "ステータス", fieldType: "SINGLE_LINE_TEXT" },
        { code: "当月受注件数", label: "当月受注件数", fieldType: "NUMBER" },
        { code: "当月売上実績", label: "当月売上実績", fieldType: "NUMBER" },
        { code: "最終集計日時", label: "最終集計日時", fieldType: "DATETIME" },
      ];
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() { return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const }; },
  };
  const normalized = normalizeSqlAppProfiles(sql, "flow", {
    resolveLogicalApp(name) { return apps[name as keyof typeof apps]; },
  }).normalizedSql;
  const asOf = new Date("2026-08-21T18:00:00.123Z");
  const executed = await executeBatch(normalized, mock, { asOf, timezone: "Asia/Tokyo" });
  expect(executed.ok).toBe(true);
  expect(executed.statements.map((item) => item.status)).toEqual(["success", "success", "success", "success"]);
  expect(posts).toHaveLength(1);
  expect(posts[0].records.map((item) => item.最終集計日時.value))
    .toEqual([asOf.toISOString(), asOf.toISOString()]);
});
