import { buildBatchExplainPlans, executeBatch, type KintoneClient } from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";
import { parseScript } from "../core/script";

function client(records: KintoneRecord[] = []): KintoneClient {
  return {
    async getRecords() { return { records }; },
    async openCursor() { throw new Error("unexpected cursor call"); },
    async postRecords(params) { return { ids: params.records.map((_, i) => String(i + 1)) }; },
    async putRecords() { /* noop */ },
    async deleteRecords() { /* noop */ },
    async getApps() { return []; },
    async getFields() { return []; },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() { return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const }; },
  };
}

const header = "-- @ksql dialect: 1\n";

test("ASSERT WARN failure records a warning and continues", async () => {
  const result = await executeBatch(
    `${header}ASSERT WARN 1 = 2, 'check data'; SELECT 1 AS continued`,
    client()
  );
  expect(result.ok).toBe(true);
  expect(result.statements.map((item) => item.status)).toEqual(["success", "success"]);
  expect(result.statements[0].result).toMatchObject({
    type: "ASSERT", passed: false, warning: "check data",
  });
});

test("B171: ASSERT WARN の COUNT 大小比較は数値 provenance を使う", async () => {
  const records = Array.from({ length: 12 }, (_, index) => ({ $id: { value: String(index + 1) } }));
  const result = await executeBatch(
    `${header}ASSERT WARN (SELECT COUNT(*) FROM APP1) <= 9, 'too many'; SELECT 1 AS continued`,
    client(records)
  );
  expect(result.ok).toBe(true);
  expect(result.statements[0].result).toMatchObject({
    type: "ASSERT", passed: false, warning: "too many",
  });
  expect(result.statements[1].status).toBe("success");
});

test("ASSERT failure includes its message and skips following statements", async () => {
  const result = await executeBatch(
    `${header}ASSERT 1 = 2, 'business message'; SELECT 1 AS skipped`,
    client()
  );
  expect(result.ok).toBe(false);
  expect(result.statements[0].error?.message).toMatch(
    /^AssertError: assertion failed: 1 = 2 \(actual: 1\)\. business message$/
  );
  expect(result.statements[1]).toMatchObject({ status: "skipped", skippedReason: "assertion" });
});

test("EXIT true skips following statements as exit and keeps ok true", async () => {
  const result = await executeBatch(
    `${header}EXIT SUCCESS IF 1 = 1, 'no work'; SELECT 1 AS skipped`,
    client()
  );
  expect(result.ok).toBe(true);
  expect(result.statements[0]).toMatchObject({
    status: "success",
    result: { type: "EXIT", exited: true, message: "no work" },
  });
  expect(result.statements[1]).toMatchObject({ status: "skipped", skippedReason: "exit" });
});

test("EXIT false records the decision and continues", async () => {
  const result = await executeBatch(
    `${header}EXIT SUCCESS IF 1 = 2, 'no work'; SELECT 1 AS continued`,
    client()
  );
  expect(result.ok).toBe(true);
  expect(result.statements[0].result).toMatchObject({ type: "EXIT", exited: false });
  expect(result.statements[1].status).toBe("success");
});

test("B171: EXIT SUCCESS IF の COUNT 大小比較は数値 provenance を使う", async () => {
  const records = Array.from({ length: 3 }, (_, index) => ({ $id: { value: String(index + 1) } }));
  const result = await executeBatch(
    `${header}EXIT SUCCESS IF (SELECT COUNT(*) FROM APP1) < 10, 'small'; SELECT 1 AS skipped`,
    client(records)
  );
  expect(result.ok).toBe(true);
  expect(result.statements[0].result).toMatchObject({ type: "EXIT", exited: true });
  expect(result.statements[1]).toMatchObject({ status: "skipped", skippedReason: "exit" });
});

test("acceptance-style scalar ASSERT and EXIT run through parseScript and executeBatch", async () => {
  const sql = `${header}ASSERT (SELECT COUNT(*) FROM APP1) = 0, 'must be empty';\n`
    + "EXIT SUCCESS IF (SELECT COUNT(*) FROM APP1) = 0, 'nothing to do';\n"
    + "SELECT 1 AS skipped";
  const parsed = parseScript(sql);
  expect(parsed.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  expect(parsed.statements.map((item) => item.type)).toEqual(["ASSERT", "EXIT", "SELECT"]);

  const result = await executeBatch(sql, client([]));
  expect(result.ok).toBe(true);
  expect(result.statements.map((item) => item.status)).toEqual(["success", "success", "skipped"]);
  expect(result.statements[2].skippedReason).toBe("exit");
});

test("batch EXPLAIN displays dialect 1 ASSERT and EXIT plans", async () => {
  const explained = await buildBatchExplainPlans(
    `${header}ASSERT WARN 1 = 2, 'warn'; EXIT SUCCESS IF 1 = 1, 'done'`,
    client(), undefined, "b168-stage2", 10_000, 2, false, 100, 10_000, false
  );
  expect(explained.statements[0].plan[0]).toBe("ASSERT WARN 1 = 2, 'warn'");
  expect(explained.statements[1].plan[0]).toBe("EXIT SUCCESS IF 1 = 1, 'done'");
});
