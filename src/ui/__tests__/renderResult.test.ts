// ============================================================
// renderResult のテスト — ExecuteResult 網羅 switch の ASSERT 分岐
//（バッチ強化第1弾 A3: case "ASSERT" がないと表示が undefined になる）
// ============================================================

import { formatValidateIntoStats, renderBatchResult, renderResult } from "../renderResult";

test("ASSERT 成功は success 表示を返す（undefined にならない）", () => {
  const html = renderResult({ type: "ASSERT", condition: "(SELECT COUNT(*) FROM APP100) = 3" });
  expect(html).toBeDefined();
  expect(html).toContain("ksql-success");
  expect(html).toContain("アサーション成立");
  // 条件テキストは HTML エスケープされて表示される
  expect(html).toContain("(SELECT COUNT(*) FROM APP100) = 3");
});

test("VALIDATIONは件数サマリとエラー表を表示する", () => {
  const html = renderResult({
    type: "VALIDATION", operation: "INSERT", validatedRows: 1, validRows: 0,
    invalidRows: 1, errorCount: 1, columns: ["code", "$err_code"],
    errors: [{ code: "", $err_code: "ERR_REQUIRED" }],
  });
  expect(html).toContain("検証 1 件");
  expect(html).toContain("ERR_REQUIRED");
});

test("VALIDATE SelectResult はエラーレコード数・エラー件数・表示行数を表示する", () => {
  const html = renderResult({
    type: "SELECT", columns: ["$id", "$err_count"], rowCount: 1,
    rows: [{ $id: "1", $err_count: "2" }],
    validateStats: { errorRecords: 1, errorCount: 2 },
  });
  expect(html).toContain("エラー 1 レコード / 2 件（表示 <span class=\"ksql-result-count\">1</span> 行）");
});

test("汎用 SELECT は従来の表示行数ヘッダーを維持する", () => {
  const html = renderResult({ type: "SELECT", columns: ["value"], rowCount: 1, rows: [{ value: "x" }] });
  expect(html).toContain('<span class="ksql-result-count">1</span> 件');
  expect(html).not.toContain("エラー 1 レコード");
});

test("エラー0件の VALIDATE も 0/0 統計を表示する", () => {
  const html = renderResult({
    type: "SELECT", columns: ["$id"], rowCount: 0, rows: [],
    validateStats: { errorRecords: 0, errorCount: 0 },
  });
  expect(html).toContain("エラー 0 レコード / 0 件（表示 0 行）");
});

test("VALIDATE INTO バッチは実体化統計を後段 SELECT の上に情報表示する", () => {
  const validateResult = {
    type: "SELECT" as const, columns: ["$id", "$err_count"], rowCount: 3,
    rows: [{ $id: "1", $err_count: "2" }, { $id: "2", $err_count: "1" }, { $id: "3", $err_count: "1" }],
    validateStats: { errorRecords: 3, errorCount: 4 },
  };
  const selectResult = {
    type: "SELECT" as const, columns: ["$id"], rowCount: 10,
    rows: Array.from({ length: 10 }, (_, i) => ({ $id: String(i + 1) })),
  };
  const summary = formatValidateIntoStats(validateResult, "#err");
  const html = renderBatchResult(selectResult, [summary!]);

  expect(html).toContain("VALIDATE: エラー 3 レコード / 4 件（#err へ 3 行）");
  expect(html.indexOf("VALIDATE:")).toBeLessThan(html.indexOf("ksql-result-meta"));
  expect(html).toContain('<span class="ksql-result-count">10</span> 件');
  expect(html).not.toContain("エラー 3 レコード / 4 件（表示");
});

test("INTO なし VALIDATE は従来のテーブル表示付きヘッダーを維持する", () => {
  const html = renderBatchResult({
    type: "SELECT", columns: ["$id", "$err_count"], rowCount: 1,
    rows: [{ $id: "1", $err_count: "2" }],
    validateStats: { errorRecords: 1, errorCount: 2 },
  }, []);

  expect(html).toContain("エラー 1 レコード / 2 件（表示 <span class=\"ksql-result-count\">1</span> 行）");
  expect(html).not.toContain("VALIDATE:");
});

test("UPDATE で ON ERROR SKIP 無し（errTable 未定義）は「（undefined）」も「隔離」も出さない", () => {
  const html = renderResult({ type: "UPDATE", updatedCount: 3, skippedRows: 0 } as never);
  expect(html).toContain("3 件のレコードを更新しました");
  expect(html).not.toContain("undefined");
  expect(html).not.toContain("隔離");
});

test("UPDATE で ON ERROR SKIP あり（errTable 定義）は隔離件数を表示する", () => {
  const html = renderResult({ type: "UPDATE", updatedCount: 3, skippedRows: 2, errTable: "#err" } as never);
  expect(html).toContain("隔離 2 件（#err）");
});
