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
