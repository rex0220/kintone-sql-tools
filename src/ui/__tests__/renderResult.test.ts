// ============================================================
// renderResult のテスト — ExecuteResult 網羅 switch の ASSERT 分岐
//（バッチ強化第1弾 A3: case "ASSERT" がないと表示が undefined になる）
// ============================================================

import { formatValidateIntoStats, renderBatchResult, renderError, renderResult } from "../renderResult";

const sharedDiagnostic = {
  statementKind: "UPDATE" as const,
  branches: [{
    branch: "update" as const, parentRows: 2, deletedParentRows: 1, successfulParents: 2,
    chunk: { size: 100 as const, plannedChunks: 1, successfulChunks: 1 },
    guards: { revisionRequired: true, parentRows: 2, dmlMaxRows: 100, subtableRows: 3, dmlMaxSubtableRows: 500, wouldExceed: false },
    targets: [
      { targetKind: "SUBTABLE" as const, field: "<明細&>", changedCount: 2, operations: [
        { kind: "PATCH" as const, count: 1, matchedRows: 2, changedRows: 1 }, { kind: "REMOVE" as const, count: 1 },
      ] },
      { targetKind: "MULTI_VALUE" as const, field: "<タグ>", fieldType: "MULTI_SELECT", changedCount: 1, operations: [
        { kind: "ADD" as const, count: 1, value: "<重要&>" },
      ] },
    ],
  }],
  nonTransactional: true as const,
  partialSuccess: { possible: true as const, successfulParents: 2, successfulChunks: 1 },
};

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

test("APPLY VALIDATION は件数summaryとguard警告をHTML escapeして表示する", () => {
  const html = renderResult({
    type: "VALIDATION", operation: "UPDATE", validatedRows: 1, validRows: 1,
    invalidRows: 0, errorCount: 0, columns: [], errors: [],
    apply: [{
      field: "<テーブル&>", operations: [
        { kind: "PATCH", matchedRows: 2, changedRows: 1 },
        { kind: "REMOVE", removedRows: 1 },
      ],
      changedSubtableRows: 2, deletedRows: 1,
    }],
    guards: {
      revisionRequired: true, parentRows: 1, dmlMaxRows: 1,
      subtableRows: 2, dmlMaxSubtableRows: 1, wouldExceed: true,
    },
    deletedRows: { total: 1, parentRows: 1 },
  });
  expect(html).toContain("APPLY &lt;テーブル&amp;&gt;: PATCH 一致 2 / 変更 1");
  expect(html).toContain("REMOVE 削除 1");
  expect(html).toContain('class="ksql-warn"');
  expect(html).toContain("安全ガード超過: 親 1/1, 子 2/1（書込み 0）");
  expect(html).toContain("削除合計 1 行 / 削除対象親 1 件");
  expect(html).not.toContain("<テーブル&>");
});

test("既存 VALIDATION は APPLY summary/guardを追加表示しない", () => {
  const html = renderResult({
    type: "VALIDATION", operation: "INSERT", validatedRows: 0, validRows: 0,
    invalidRows: 0, errorCount: 0, columns: [], errors: [],
  });
  expect(html).not.toContain("APPLY");
  expect(html).not.toContain("安全ガード");
});

test("Phase 16c: VALIDATE ONLYはshared detailで複数親/table/多値/guardをescape表示する", () => {
  const html = renderResult({
    type: "VALIDATION", operation: "UPDATE", validatedRows: 2, validRows: 2,
    invalidRows: 0, errorCount: 0, columns: [], errors: [], diagnostic: sharedDiagnostic,
  });
  expect(html).toContain("APPLY UPDATE: 親 2 件");
  expect(html).toContain("table=&lt;明細&amp;&gt;: PATCH 1 / APPEND 0 / REMOVE 1");
  expect(html).toContain("PATCH 一致 2 / 変更 1");
  expect(html).toContain("multiValue=&lt;タグ&gt; (MULTI_SELECT): ADD 1 value=&lt;重要&amp;&gt;");
  expect(html).toContain("guard: 親 2/100 / 子 3/500 / revision 必須: はい");
  expect(html).toContain("APPLY VALIDATE ONLY（書込み 0）");
  expect(html).not.toContain("<重要&>");
});

test("Phase 16c: APPLY実行成功はshared detailの成功進捗を表示する", () => {
  const html = renderResult({ type: "UPDATE", updatedCount: 2, diagnostic: sharedDiagnostic });
  expect(html).toContain("2 件のレコードを更新しました");
  expect(html).toContain("成功進捗: 親 2 件 / chunk 1");
  expect(html).toContain("非トランザクション");
});

test("Phase 16c: APPLY部分失敗は成功prefix・失敗stage・shared detailをescape表示する", () => {
  const diagnostic = {
    ...sharedDiagnostic,
    branches: [{
      ...sharedDiagnostic.branches[0], successfulParents: 1,
      chunk: { ...sharedDiagnostic.branches[0].chunk, successfulChunks: 1, failedChunkIndex: 1, failedStage: "PUT_CHUNK" as const },
    }],
    partialSuccess: {
      possible: true as const, successfulParents: 1, successfulChunks: 1,
      failedBranch: "update" as const, retryAttempted: false as const,
    },
  };
  const html = renderError({
    partialSuccess: {
      successfulParents: 1, successfulChunks: 1, nonTransactional: true,
      failedChunkIndex: 1, failedStage: "PUT_CHUNK", failedBranch: "UPDATE",
      retryAttempted: false, diagnostic,
    },
  });
  expect(html).toContain("APPLY 部分成功: 成功親 1 件 / 成功 chunk 1");
  expect(html).toContain("失敗 UPDATE PUT_CHUNK chunk 2");
  expect(html).toContain("【部分成功】失敗分岐 UPDATE / stage PUT_CHUNK / chunk 2");
  expect(html).toContain("table=&lt;明細&amp;&gt;");
  expect(html).not.toContain("<明細&>");
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
