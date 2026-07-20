import type { ApplyConfirmDetail } from "../core";

/** APPLY PATCH/APPEND/REMOVE 専用の不可逆操作確認。IMPORT の置換確認とは契約を混在させない。 */
export function buildApplyConfirmMessage(detail: ApplyConfirmDetail): string {
  const tableLines = detail.tables.map((table) =>
    `  ${table.table}: PATCH ${table.patchRows} / APPEND ${table.appendRows} / REMOVE ${table.removeRows}`
  );
  return [
    ...(detail.deletedRows > 0 ? [`【最重要警告】サブテーブル ${detail.deletedRows} 行を削除します。`] : []),
    `APPLY PATCH/APPEND/REMOVE: 親 ${detail.parentRows} 件、変更子行 ${detail.changedSubtableRows} 件、追加 ${detail.addedSubtableRows} 件`,
    "テーブル別:",
    ...tableLines,
    `削除 ${detail.deletedRows} 行 / 削除対象親 ${detail.deletedParentRows} 件`,
    `revision 必須: ${detail.revisionRequired ? "はい" : "いいえ"}`,
    `revision conflict 時の自動再試行: ${detail.retryOnRevisionConflict ? "あり" : "なし"}`,
    `元に戻せない操作: ${detail.irreversible ? "はい" : "いいえ"}`,
  ].join("\n");
}
