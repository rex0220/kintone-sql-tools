import { buildBatchExplainPlans, type KintoneClient } from "../execute";

function client(): KintoneClient {
  return {
    async getRecords() { throw new Error("records API must not be called by EXPLAIN"); },
    async openCursor() { throw new Error("cursor API must not be called by EXPLAIN"); },
    async postRecords() { throw new Error("unexpected write"); },
    async putRecords() { throw new Error("unexpected write"); },
    async deleteRecords() { throw new Error("unexpected write"); },
    async getApps() { return []; },
    async getFields() {
      return [
        { code: "製品名", label: "製品名", fieldType: "SINGLE_LINE_TEXT" as const },
        { code: "状態", label: "状態", fieldType: "STATUS" as const },
      ];
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const };
    },
  };
}

const B162_SQL = `
DECLARE @m_start = '2025-08-01';
DECLARE @m_stop  = '2026-08-01';
WITH 月系列 AS (GENERATE_SERIES(@m_start, @m_stop, '1 month') AS 月)
SELECT 月 FROM 月系列`;

const B163_SQL = `
CREATE TEMP TABLE #t AS
WITH s AS (GENERATE_SERIES('2025-08-01', '2026-08-01', '1 month') AS 月)
SELECT DATE_FORMAT(s.月, '%Y-%m') AS 年月, m.製品名 AS 製品名
FROM s CROSS JOIN APP4229 AS m;

SELECT 製品名, COUNT(*) AS 月数 FROM #t GROUP BY 製品名`;

describe("B162 conditional DECLARE binding", () => {
  test("逐語 SQL は DATE 13行を値非表示の条件付き計画として表示する", async () => {
    const result = await buildBatchExplainPlans(B162_SQL, client(), {
      m_start: "secret-start",
      m_stop: "secret-stop",
    });
    const text = result.statements[2].plan.join("\n");
    expect(text).toContain("series type:   DATE (DECLARE default)");
    expect(text).toContain("rows:          13 (DECLARE default estimate)");
    expect(text).toContain("runtime injection may change this plan");
    expect(text).toContain("@m_start (DECLARE default; value hidden)");
    expect(text).toContain("records API:   none");
    expect(text).not.toContain("2025-08-01");
    expect(text).not.toContain("secret-start");
  });

  test("SET と非リテラル DECLARE は系列全体を deferred にする", async () => {
    for (const sql of [
      "SET @start = TODAY(); WITH s AS (GENERATE_SERIES(@start, '2026-08-01', '1 month') AS 月) SELECT 月 FROM s",
      "DECLARE @start = TODAY(); WITH s AS (GENERATE_SERIES(@start, '2026-08-01', '1 month') AS 月) SELECT 月 FROM s",
    ]) {
      const result = await buildBatchExplainPlans(sql, client());
      const text = result.statements[1].plan.join("\n");
      expect(text).toContain("series type:   deferred (variable)");
      expect(text).toContain("start:         @start (runtime)");
      expect(text).toContain("rows:          runtime");
      expect(text).toContain("records API:   none");
    }
  });

  test("系列だけ既定値束縛し WHERE は従来の placeholder/candidate のまま", async () => {
    const result = await buildBatchExplainPlans(
      "DECLARE @start='2026-08-01'; " +
        "WITH s AS (GENERATE_SERIES(@start,'2026-08-03') AS 日付) " +
        "SELECT 日付 FROM s; " +
        "SELECT 製品名 FROM APP4229 WHERE 状態=@start AND 製品名 LIKE '%'",
      client()
    );
    expect(result.statements[1].plan.join("\n")).toContain("series type:   DATE (DECLARE default)");
    const whereText = result.statements[2].plan.join("\n");
    expect(whereText).toContain("pushdown candidate:");
    expect(whereText).toContain("@start");
  });

  test("数値 DECLARE は実行規則どおり文字列束縛から整数系列を解決する", async () => {
    const result = await buildBatchExplainPlans(
      "DECLARE @a=1; DECLARE @b=5; WITH s AS (GENERATE_SERIES(@a,@b,2) AS n) SELECT n FROM s",
      client()
    );
    expect(result.statements[2].plan.join("\n")).toContain("series type:   INTEGER (DECLARE default)");
    expect(result.statements[2].plan.join("\n")).toContain("rows:          3 (DECLARE default estimate)");
  });
});

describe("B163 static temp schema ledger", () => {
  test.each([true, false])("逐語 SQL を static schema で既存 GROUP BY planner へ接続する (metadata=%s)", async (resolveMetadata) => {
    const result = await buildBatchExplainPlans(
      B163_SQL, client(), undefined, "b163-verbatim", 10_000, 2, false, 100, 500, resolveMetadata
    );
    const create = result.statements[0].plan.join("\n");
    const select = result.statements[1].plan.join("\n");
    expect(create).toContain("schema:        年月, 製品名");
    expect(create).toContain("schema source: SELECT output of statement 1");
    expect(select).toContain("source:        temp table #t (schema from statement 1)");
    expect(select).toContain("group key 製品名: PHYSICAL (source=0, field=製品名)");
    expect(select).toContain("plan status:   static schema / runtime rows");
    expect(select).toContain("records API:   none");
    expect(select).not.toContain("InternalError");
  });

  test("存在しない group key と B148 依存違反は既存公開診断になる", async () => {
    await expect(buildBatchExplainPlans(
      "CREATE TEMP TABLE #t AS SELECT 製品名 FROM APP4229; SELECT missing, COUNT(*) FROM #t GROUP BY missing",
      client()
    )).rejects.toThrow(/unknown field code\(s\): missing/i);
    await expect(buildBatchExplainPlans(
      "CREATE TEMP TABLE #t AS SELECT 製品名, 状態 FROM APP4229; SELECT 状態, COUNT(*) FROM #t GROUP BY 製品名",
      client()
    )).rejects.toThrow(/非グループ化依存: 状態/);
  });

  test.each([true, false])("wildcard schema は空 schema にせず deferred として成功する (metadata=%s)", async (resolveMetadata) => {
    const result = await buildBatchExplainPlans(
      "CREATE TEMP TABLE #t AS SELECT * FROM APP4229; SELECT x, COUNT(*) FROM #t GROUP BY x",
      client(), undefined, "b163-deferred", 10_000, 2, false, 100, 500, resolveMetadata
    );
    expect(result.statements[0].plan.join("\n")).toContain("schema:        deferred");
    const text = result.statements[1].plan.join("\n");
    expect(text).toContain("group key x: DEFERRED (temp table schema unavailable)");
    expect(text).toContain("plan status:   deferred (temp table schema)");
    expect(text).not.toContain("InternalError");
  });

  test("temp→temp は producer index を保って連鎖し DROP 後は参照を拒否する", async () => {
    const result = await buildBatchExplainPlans(
      "CREATE TEMP TABLE #a AS SELECT 製品名 FROM APP4229; " +
        "CREATE TEMP TABLE #b AS SELECT 製品名 FROM #a; " +
        "SELECT 製品名, COUNT(*) FROM #b GROUP BY 製品名",
      client(), undefined, "b163-chain", 10_000, 2, false, 100, 500, false
    );
    expect(result.statements[1].plan.join("\n")).toContain("schema:        製品名");
    expect(result.statements[2].plan.join("\n")).toContain("schema from statement 2");
    await expect(buildBatchExplainPlans(
      "CREATE TEMP TABLE #t AS SELECT 製品名 FROM APP4229; DROP TEMP TABLE #t; SELECT 製品名 FROM #t",
      client()
    )).rejects.toThrow(/temp table #t is not defined/i);
  });

  test("複数 temp table の producer index を混同せず同名列は既存 ambiguity 診断になる", async () => {
    const result = await buildBatchExplainPlans(
      "CREATE TEMP TABLE #a AS SELECT 製品名 FROM APP4229; " +
        "CREATE TEMP TABLE #b AS SELECT 製品名 FROM APP4229; " +
        "SELECT a.製品名,COUNT(*) FROM #a a CROSS JOIN #b b GROUP BY a.製品名",
      client(), undefined, "b163-multiple", 10_000, 2, false, 100, 500, false
    );
    const text = result.statements[2].plan.join("\n");
    expect(text).toContain("#a (schema from statement 1)");
    expect(text).toContain("#b (schema from statement 2)");
    await expect(buildBatchExplainPlans(
      "CREATE TEMP TABLE #a AS SELECT 製品名 FROM APP4229; " +
        "CREATE TEMP TABLE #b AS SELECT 製品名 FROM APP4229; " +
        "SELECT 製品名,COUNT(*) FROM #a a CROSS JOIN #b b GROUP BY 製品名",
      client()
    )).rejects.toThrow(/ambiguous/i);
  });
});
