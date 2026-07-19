// ============================================================
// renderResult のテスト — ExecuteResult 網羅 switch の ASSERT 分岐
//（バッチ強化第1弾 A3: case "ASSERT" がないと表示が undefined になる）
// ============================================================

import { renderResult } from "../renderResult";

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
