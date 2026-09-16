import type { BatchExecuteResult, SelectResult } from "../../core";
import {
  collectPrecedingBatchWarnings,
  renderBatchResult,
  renderResult,
} from "../renderResult";

const RANGE_WARNING = "累計 は既定フレーム（RANGE）で評価されます。";

function selectResult(warnings: string[] = []): SelectResult {
  return {
    type: "SELECT",
    columns: ["x"],
    rows: [{ x: "1" }],
    rowCount: 1,
    warnings,
  };
}

function batchResult(overrides: Partial<BatchExecuteResult> = {}): BatchExecuteResult {
  return {
    ok: true,
    statementCount: 2,
    statements: [],
    analysis: {} as BatchExecuteResult["analysis"],
    ...overrides,
  };
}

test("CREATE TEMP の警告を文番号付きで最終 SELECT の警告より前に表示する", () => {
  const ownWarning = "表示結果自身の警告";
  const batch = batchResult({
    statements: [
      { index: 0, type: "CREATE_TEMP_TABLE", status: "success", warnings: [RANGE_WARNING] },
      { index: 1, type: "SELECT", status: "success", result: selectResult([ownWarning]) },
    ],
    warnings: [RANGE_WARNING],
  });
  const preceding = collectPrecedingBatchWarnings(batch, 1);
  const html = renderBatchResult(batch.statements[1].result!, [], {}, preceding);

  expect(preceding).toEqual([`[1] ${RANGE_WARNING}`]);
  expect(html.indexOf(`[1] ${RANGE_WARNING}`)).toBeLessThan(html.indexOf(ownWarning));
  expect(html.match(new RegExp(ownWarning, "g"))).toHaveLength(1);
});

test("途中 SELECT の警告に文番号を付け、表示結果自身の警告は重複させない", () => {
  const ownWarning = "最終 SELECT の警告";
  const batch = batchResult({
    statements: [
      { index: 0, type: "SELECT", status: "success", result: selectResult([RANGE_WARNING]) },
      { index: 1, type: "SELECT", status: "success", result: selectResult([ownWarning]) },
    ],
    warnings: [ownWarning],
  });
  const preceding = collectPrecedingBatchWarnings(batch, 1);
  const html = renderBatchResult(batch.statements[1].result!, [], {}, preceding);

  expect(preceding).toEqual([`[1] ${RANGE_WARNING}`]);
  expect(html.match(new RegExp(ownWarning, "g"))).toHaveLength(1);
});

test("dialect 1 のバッチ警告だけを接頭辞なしで表示する", () => {
  const dialectWarning = "dialect 1 の警告";
  const batch = batchResult({
    statements: [
      { index: 0, type: "CREATE_TEMP_TABLE", status: "success", warnings: [RANGE_WARNING] },
      { index: 1, type: "SELECT", status: "success", result: selectResult() },
    ],
    warnings: [RANGE_WARNING, dialectWarning],
  });

  expect(collectPrecedingBatchWarnings(batch, 1)).toEqual([
    `[1] ${RANGE_WARNING}`,
    dialectWarning,
  ]);
});

test("警告の無いバッチは従来と同じ HTML を返す", () => {
  const result = selectResult();
  expect(renderBatchResult(result, ["バッチ 2 文を実行しました。"], {}, []))
    .toBe(renderBatchResult(result, ["バッチ 2 文を実行しました。"]));
});

test("単文 SELECT の描画はバッチ警告の集約に影響されない", () => {
  const result = selectResult(["単文の警告"]);
  const before = renderResult(result);
  collectPrecedingBatchWarnings(batchResult(), null);
  expect(renderResult(result)).toBe(before);
});

test("結果セットなしのバッチは note の後ろに警告を表示する", () => {
  const batch = batchResult({
    statementCount: 1,
    statements: [
      { index: 0, type: "CREATE_TEMP_TABLE", status: "success", warnings: [RANGE_WARNING] },
    ],
    warnings: [RANGE_WARNING],
  });
  const preceding = collectPrecedingBatchWarnings(batch, null);
  const html = renderBatchResult(null, ["バッチ 1 文を実行しました（結果セットなし）。"], {}, preceding);

  expect(html.indexOf("結果セットなし")).toBeLessThan(html.indexOf(`[1] ${RANGE_WARNING}`));
  expect(html).toContain('class="ksql-warn"');
});
