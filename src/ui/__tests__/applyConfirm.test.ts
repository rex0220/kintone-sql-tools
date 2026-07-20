import type { ApplyDiagnostic } from "../../core";
import { buildApplyConfirmMessage, resolvePluginApplyConfirmHtml } from "../applyConfirm";

const detail: ApplyDiagnostic = {
  statementKind: "UPSERT",
  branches: [
    {
      branch: "insert", parentRows: 2, deletedParentRows: 0,
      chunk: { size: 100, plannedChunks: 1 },
      guards: { revisionRequired: false, parentRows: 2, dmlMaxRows: 100, subtableRows: 4, dmlMaxSubtableRows: 500, wouldExceed: false },
      targets: [{
        targetKind: "SUBTABLE", field: "<明細&>", changedCount: 4,
        operations: [{ kind: "APPEND", count: 4, addedRows: 4 }],
      }],
    },
    {
      branch: "update", parentRows: 3, deletedParentRows: 2,
      chunk: { size: 100, plannedChunks: 1 },
      guards: { revisionRequired: true, parentRows: 3, dmlMaxRows: 100, subtableRows: 5, dmlMaxSubtableRows: 500, wouldExceed: false },
      targets: [
        {
          targetKind: "SUBTABLE", field: "内訳", changedCount: 5,
          operations: [
            { kind: "PATCH", count: 2, matchedRows: 3, changedRows: 2 },
            { kind: "APPEND", count: 1, addedRows: 1 },
            { kind: "REMOVE", count: 2, removedRows: 2 },
          ],
        },
        {
          targetKind: "MULTI_VALUE", field: "<タグ>", fieldType: "CHECK_BOX&", changedCount: 2,
          operations: [
            { kind: "ADD", count: 1, value: "<追加&>" },
            { kind: "REMOVE_VALUE", count: 1, value: "'削除'" },
          ],
        },
      ],
    },
  ],
  nonTransactional: true,
  partialSuccess: { possible: true },
};

test("Phase 16c: shared detailからstatement/UPSERT分岐/table/多値/安全注意を表示する", () => {
  const html = buildApplyConfirmMessage(detail);
  expect(html).toContain("APPLY UPSERT: 親 5 件");
  expect(html).toContain("分岐 INSERT: 親 2 件 / 作成親 2 件 / 初期子行 4 件");
  expect(html).toContain("分岐 UPDATE: 親 3 件");
  expect(html).toContain("内訳: PATCH 2 / APPEND 1 / REMOVE 2");
  expect(html).toContain("multiValue=&lt;タグ&gt; (CHECK_BOX&amp;): ADD 1 value=&lt;追加&amp;&gt;, REMOVE 1 value=&#39;削除&#39;");
  expect(html).toContain("削除 2 行 / 削除対象親 2 件");
  expect(html).toContain("revision 必須: はい");
  expect(html).toContain("非トランザクション");
  expect(html).toContain("部分成功あり・自動 retry なし");
  expect(html).toContain("元に戻せない操作: はい");
  expect(html).toContain("サブテーブル子行ガードの対象外");
});

test("Phase 16c: shared detailのfield/type/valueをHTML escapeする", () => {
  const html = buildApplyConfirmMessage(detail);
  expect(html).toContain("table=&lt;明細&amp;&gt;");
  expect(html).not.toContain("<明細&>");
  expect(html).not.toContain("<追加&>");
});

test("Phase 16c: desktop配線はshared detailを選びIMPORT detailとは型経路を分離する", () => {
  const base = { statementIndex: 0, statementCount: 1, statementType: "UPSERT", targetAppId: 4221 };
  expect(resolvePluginApplyConfirmHtml({ ...base, applyDiagnostic: detail, applyDetail: undefined })).toContain("APPLY UPSERT");
  expect(resolvePluginApplyConfirmHtml({
    ...base,
    importDetail: { kind: "IMPORT_CSV_SUBTABLE_REPLACE", parents: [] } as never,
    applyDiagnostic: detail,
  })).toBeNull();
  expect(resolvePluginApplyConfirmHtml({ ...base })).toBeNull();
});
