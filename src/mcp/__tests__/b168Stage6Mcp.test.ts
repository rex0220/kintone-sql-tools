import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DiagnosticCodes } from "../../core/diagnostics";
import { createKsqlMcpTools } from "../tools";
import { validateInputSchema } from "../schemas";

const ACCEPTANCE_SCRIPT = `-- @ksql name: monthly_sales_sync
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

async function withFlowTools(
  run: (tools: ReturnType<typeof createKsqlMcpTools>) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(join(process.cwd(), ".tmp-mcp-b168-stage6-"));
  const configPath = join(dir, "ksql.config.json");
  await writeFile(configPath, JSON.stringify({
    defaultProfile: "prod",
    profiles: {
      prod: {
        logicalApps: { 受注: 100, 顧客マスタ: 200 },
      },
    },
  }), "utf8");
  try {
    await run(createKsqlMcpTools({ configPath, profile: "prod" }));
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

describe("B168 Stage 6b MCP dialect 1 validation", () => {
  test("受入 7: sample returns scriptMeta and static-only structured diagnostics", async () => {
    await withFlowTools(async (tools) => {
      const result = await tools.validate({ sql: ACCEPTANCE_SCRIPT });

      expect(result).toMatchObject({
        ok: true,
        batch: true,
        scriptMeta: {
          name: "monthly_sales_sync",
          dependsOn: ["sync_master_customers"],
          timeout: 600,
          dialect: 1,
        },
        diagnostics: [],
      });
      expect(result.diagnostics?.some((item) =>
        item.code === DiagnosticCodes.UPDATE_KEY_FIELD_TYPE
        || item.code === DiagnosticCodes.UPDATE_KEY_NOT_UNIQUE
      )).toBe(false);
    });
  });

  test("strict promotes KSQL1305 without throwing and locations use original LAPP/@profile source", async () => {
    await withFlowTools(async (tools) => {
      const sql = `-- @ksql dialect: 1
CREATE TEMP TABLE flow_rows AS SELECT * FROM LAPP_受注@prod;
INSERT INTO APP200@prod (code) VALUES ('A')`;
      const warning = await tools.validate({ sql });
      const strict = await tools.validate({ sql, strict: true });

      expect(warning.diagnostics).toEqual([
        expect.objectContaining({
          severity: "warning",
          code: DiagnosticCodes.BARE_INSERT_NOT_IDEMPOTENT,
          line: 3,
          column: 1,
          statementIndex: 1,
        }),
      ]);
      expect(strict).toMatchObject({ ok: true });
      expect(strict.diagnostics).toEqual([
        expect.objectContaining({
          severity: "error",
          code: DiagnosticCodes.BARE_INSERT_NOT_IDEMPOTENT,
          line: 3,
          column: 1,
          statementIndex: 1,
        }),
      ]);
    });
  });

  test("parseScript header warnings are additive dialect 1 diagnostics", async () => {
    const tools = createKsqlMcpTools({ profile: "prod" });
    const result = await tools.validate({
      sql: "-- @ksql unknown_key: value\n-- @ksql dialect: 1\nSELECT 1",
    });

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: DiagnosticCodes.HEADER_UNKNOWN_KEY,
        line: 1,
      }),
    ]);
  });

  test("dialect 0 response field set remains byte-for-byte contract compatible", async () => {
    const tools = createKsqlMcpTools({ profile: "prod" });
    const result = await tools.validate({ sql: "SELECT * FROM APP100" });

    expect(Object.keys(result).sort()).toEqual([
      "appBindings", "appIds", "batch", "cacheContext", "canRunWithQueryTool",
      "containsDml", "containsValidationOnly", "hasProfileSyntax", "hasWhere",
      "insertValuesCount", "isDml", "isReadOnly", "isReadOnlyBatch", "normalizedSql",
      "ok", "requiresCompleteInput", "requiresMutationTool", "statementCount",
      "statementType", "statements", "tempTables",
    ].sort());
    expect(result).not.toHaveProperty("diagnostics");
    expect(result).not.toHaveProperty("scriptMeta");
  });

  test("strict input schema documents diagnostic-only behavior", () => {
    expect(validateInputSchema.shape.strict.safeParse(true).success).toBe(true);
    expect(validateInputSchema.shape.strict.description).toContain("KSQL1305");
    expect(validateInputSchema.shape.strict.description).toContain("ok:true");
    expect(validateInputSchema.shape.strict.description).toContain("never executes");
  });
});
