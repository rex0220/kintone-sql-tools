import { DiagnosticCodes } from "../diagnostics";
import { parseScript } from "../script";
import { parseScriptHeader } from "../scriptHeader";

describe("B168 script header", () => {
  test("parses all known keys, strips trailing comments, and defaults dialect to 0", () => {
    const parsed = parseScriptHeader([
      "-- ordinary leading comment",
      "-- @ksql name: monthly_sales # note",
      "-- @ksql depends_on: job_a, job_b # note",
      "-- @ksql timeout: 600",
      "SELECT 1",
    ].join("\r\n"));
    expect(parsed.meta).toEqual({
      name: "monthly_sales",
      dependsOn: ["job_a", "job_b"],
      timeout: 600,
      dialect: 0,
    });
    expect(parsed.diagnostics).toEqual([]);
  });

  test.each(["1.5", "0", "-1", "abc"])("rejects invalid timeout %s", (value) => {
    const parsed = parseScriptHeader(`-- @ksql timeout: ${value}\nSELECT 1`);
    expect(parsed.diagnostics).toEqual([
      expect.objectContaining({ severity: "error", code: DiagnosticCodes.HEADER_INVALID_TIMEOUT }),
    ]);
  });

  test("rejects dialect 2 at the value position", () => {
    const parsed = parseScriptHeader("-- @ksql dialect: 2\r\nSELECT 1");
    expect(parsed.meta.dialect).toBe(0);
    expect(parsed.diagnostics[0]).toMatchObject({
      severity: "error",
      code: DiagnosticCodes.HEADER_INVALID_DIALECT,
      line: 1,
      column: 19,
    });
  });

  test("warns for unknown and duplicate keys, retaining the first value", () => {
    const parsed = parseScriptHeader([
      "-- @ksql name: first",
      "-- @ksql future: enabled",
      "-- @ksql name: second",
      "-- @ksql dialect: 1",
    ].join("\n"));
    expect(parsed.meta.name).toBe("first");
    expect(parsed.meta.dialect).toBe(1);
    expect(parsed.diagnostics.map((item) => item.code)).toEqual([
      DiagnosticCodes.HEADER_UNKNOWN_KEY,
      DiagnosticCodes.HEADER_DUPLICATE_KEY,
    ]);
    expect(parsed.diagnostics.every((item) => item.severity === "warning")).toBe(true);
  });

  test("does not scan directives after the leading contiguous comment block", () => {
    const parsed = parseScriptHeader("\n-- @ksql dialect: 1\nSELECT 1");
    expect(parsed.hasDirectives).toBe(false);
    expect(parsed.meta.dialect).toBe(0);
  });
});

describe("B168 parseScript", () => {
  test("string literal ;, --, and @ksql text do not split statements or become headers", () => {
    const source = "SELECT '; -- @ksql dialect: 1' AS note; SELECT '@ksql' AS marker";
    const parsed = parseScript(source);
    expect(parsed.meta.dialect).toBe(0);
    expect(parsed.statements).toHaveLength(2);
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.statementRanges.map((range) => source.slice(range.start, range.end))).toEqual([
      "SELECT '; -- @ksql dialect: 1' AS note",
      "SELECT '@ksql' AS marker",
    ]);
  });

  test("unresolved LAPP references are returned as diagnostics instead of thrown", () => {
    const parsed = parseScript("SELECT * FROM LAPP_受注");
    expect(parsed.statements).toEqual([]);
    expect(parsed.diagnostics[0]).toMatchObject({
      severity: "error",
      code: DiagnosticCodes.LOGICAL_APP_UNRESOLVED,
      line: 1,
      column: 15,
    });
  });

  test("parse diagnostics use original CRLF coordinates and non-empty statement indexes", () => {
    const parsed = parseScript("-- leading\r\n;;SELECT 1;\r\nBOGUS");
    expect(parsed.diagnostics).toEqual([
      expect.objectContaining({
        code: DiagnosticCodes.PARSE_ERROR,
        line: 3,
        column: 1,
        statementIndex: 1,
      }),
    ]);
  });

  test("acceptance sample reads four headers and reports Stage 2/3 syntax without crashing", () => {
    const source = `-- @ksql name: monthly_sales_sync
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
    const parsed = parseScript(source, { apps: { 受注: 100, 顧客マスタ: 200 } });
    expect(parsed.meta).toEqual({
      name: "monthly_sales_sync",
      dependsOn: ["sync_master_customers"],
      timeout: 600,
      dialect: 1,
    });
    expect(parsed.diagnostics).toEqual([
      expect.objectContaining({ severity: "error", code: DiagnosticCodes.PARSE_ERROR }),
    ]);
  });
});
