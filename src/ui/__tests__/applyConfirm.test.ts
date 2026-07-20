import { buildApplyConfirmMessage } from "../applyConfirm";

test("B44 Phase 6: APPLY 専用確認は親/子/PATCH/削除/revision/非retry/不可逆を表示する", () => {
  const message = buildApplyConfirmMessage({
    kind: "APPLY_PATCH",
    parentRows: 1,
    changedSubtableRows: 3,
    tables: [
      { table: "明細", patchRows: 2 },
      { table: "内訳", patchRows: 1 },
    ],
    deletedRows: 0,
    revisionRequired: true,
  });
  expect(message).toContain("親 1 件、変更子行 3 件");
  expect(message).toContain("明細: PATCH 2");
  expect(message).toContain("内訳: PATCH 1");
  expect(message).toContain("削除 0 件");
  expect(message).toContain("revision 必須: はい");
  expect(message).toContain("自動再試行しません");
  expect(message).toContain("元に戻せません");
});
