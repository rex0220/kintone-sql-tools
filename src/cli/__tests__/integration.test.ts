import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildBatchStatementSummary, buildOutput, buildSelectSummary, parseTokenFile } from "../index";
import type { BatchStatementResult, SelectResult } from "../../core";

describe("cli integration helpers", () => {
  test("parseTokenFile normalizes APP keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "ksql-cli-test-"));
    const p = join(dir, "tokens.json");
    writeFileSync(p, JSON.stringify({ APP100: "t100", "101": "t101" }), "utf-8");

    const map = parseTokenFile(p);
    expect(map.APP100).toBe("t100");
    expect(map.APP101).toBe("t101");
  });

  test("buildOutput applies display options for table/csv", () => {
    const result = {
      type: "SELECT" as const,
      columns: ["担当者", "タグ"],
      rowCount: 1,
      rows: [
        {
          担当者: JSON.stringify({ code: "u001", name: "田中" }),
          タグ: JSON.stringify(["A", "B"]),
        },
      ],
      warnings: [],
    };

    const table = buildOutput(result, "table", false, false, {
      userFormat: "name",
      arrayFormat: "join",
      tableFormat: "full",
      dateFormat: "full",
      attachmentFormat: "full",
    });
    expect(table).toContain("担当者\tタグ");
    expect(table).toContain("田中\tA, B");

    const csv = buildOutput(result, "csv", false, false, {
      userFormat: "name",
      arrayFormat: "join",
      tableFormat: "full",
      dateFormat: "full",
      attachmentFormat: "full",
    });
    expect(csv).toContain("担当者,タグ");
    expect(csv).toContain("田中,\"A, B\"");
  });

  test("buildOutput renders markdown and escapes pipe/newline", () => {
    const result = {
      type: "SELECT" as const,
      columns: ["A|B", "memo"],
      rowCount: 1,
      rows: [
        {
          "A|B": "x|y",
          memo: "line1\nline2",
        },
      ],
      warnings: [],
    };
    const markdown = buildOutput(result, "markdown", false, false, {
      userFormat: "full",
      arrayFormat: "full",
      tableFormat: "full",
      dateFormat: "full",
      attachmentFormat: "full",
    });

    expect(markdown).toContain("| A\\|B | memo |");
    expect(markdown).toContain("| --- | --- |");
    expect(markdown).toContain("| x\\|y | line1<br>line2 |");
  });

  test("VALIDATE JSON includes validateStats and CLI summary appends both counts", () => {
    const result: SelectResult = {
      type: "SELECT", columns: ["$id", "$err_count"], rowCount: 1,
      rows: [{ $id: "1", $err_count: "2" }],
      validateStats: { errorRecords: 1, errorCount: 2 },
    };
    expect(JSON.parse(buildOutput(result, "json", false, false, {})).validateStats)
      .toEqual({ errorRecords: 1, errorCount: 2 });
    expect(buildSelectSummary(result)).toBe("rowCount=1 errorRecords=1 errorCount=2");

    const summary = buildBatchStatementSummary({
      index: 0, type: "VALIDATE", status: "success", result,
    } as BatchStatementResult);
    expect(summary).toBe("[1] VALIDATE success rowCount=1 errorRecords=1 errorCount=2");
  });
});

// ----------------------------------------------------------------
// DML バッチ確認プロンプト本文（フェーズ2 M2、仕様 §8.3）
// ----------------------------------------------------------------

import { buildBatchDmlConfirmMessage } from "../index";
import { parseSqlStatements, analyzeBatch } from "../../core";

test("buildBatchDmlConfirmMessage: 全 DML 文の一覧（タイプ/対象アプリ/WHERE 有無）", () => {
  const analysis = analyzeBatch(parseSqlStatements(
    "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP88;" +
    "SELECT 顧客名 FROM #t;" +
    "INSERT INTO APP89 (名前) SELECT 顧客名 FROM #t;" +
    "DELETE FROM APP90 WHERE $id = 1"
  ));
  const message = buildBatchDmlConfirmMessage(analysis);
  const lines = message.split("\n");

  expect(lines[0]).toBe("[DML Confirm] batch");
  // read-only 文（CREATE / SELECT）は一覧に含まれない
  expect(message).not.toContain("CREATE_TEMP_TABLE");
  expect(lines[1]).toBe("  [3] INSERT_SELECT app=APP89 where=no");
  expect(lines[2]).toBe("  [4] DELETE app=APP90 where=yes");
  expect(lines).toHaveLength(3);
});

test("buildBatchDmlConfirmMessage: app= は書き込み先のみ（サブクエリの参照アプリを混ぜない）", () => {
  const analysis = analyzeBatch(parseSqlStatements(
    "SELECT 顧客名 FROM APP88;" +
    "UPDATE APP89 SET 状態 = '完了' WHERE $id IN (SELECT $id FROM APP88)"
  ));
  const message = buildBatchDmlConfirmMessage(analysis);
  expect(message).toContain("[2] UPDATE app=APP89 where=yes");
  expect(message).not.toContain("APP88");
});
