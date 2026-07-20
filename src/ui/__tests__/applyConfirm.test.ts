import { buildApplyConfirmMessage } from "../applyConfirm";

test("B44 Phase 8: APPLY 専用確認はtable別REMOVE/削除親/revision/非retry/不可逆を表示する", () => {
  const message = buildApplyConfirmMessage({
    kind: "APPLY_PATCH",
    parentRows: 1,
    changedSubtableRows: 3,
    addedSubtableRows: 1,
    tables: [
      { table: "明細", patchRows: 2, appendRows: 1, removeRows: 2 },
      { table: "内訳", patchRows: 0, appendRows: 0, removeRows: 0 },
    ],
    deletedRows: 2,
    deletedParentRows: 1,
    revisionRequired: true,
    irreversible: true,
    retryOnRevisionConflict: false,
  });
  expect(message).toContain("親 1 件、変更子行 3 件");
  expect(message).toContain("【最重要警告】サブテーブル 2 行を削除します");
  expect(message).toContain("明細: PATCH 2 / APPEND 1 / REMOVE 2");
  expect(message).toContain("内訳: PATCH 0 / APPEND 0 / REMOVE 0");
  expect(message).toContain("追加 1 件");
  expect(message).toContain("削除 2 行 / 削除対象親 1 件");
  expect(message).toContain("revision 必須: はい");
  expect(message).toContain("自動再試行: なし");
  expect(message).toContain("元に戻せない操作: はい");
});
