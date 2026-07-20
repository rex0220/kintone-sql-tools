import type { ApplyConfirmDetail } from "../core";

/** APPLY PATCH/APPEND 専用の不可逆操作確認。IMPORT の置換確認とは契約を混在させない。 */
export function buildApplyConfirmMessage(detail: ApplyConfirmDetail): string {
  const tableLines = detail.tables.map((table) =>
    `  ${table.table}: PATCH ${table.patchRows} / APPEND ${table.appendRows}`
  );
  return [
    `APPLY PATCH/APPEND: 親 ${detail.parentRows} 件、変更子行 ${detail.changedSubtableRows} 件、追加 ${detail.addedSubtableRows} 件`,
    "テーブル別:",
    ...tableLines,
    `削除 ${detail.deletedRows} 件`,
    `revision 必須: ${detail.revisionRequired ? "はい" : "いいえ"}`,
    "revision conflict 時は自動再試行しません。",
    "この操作は元に戻せません。",
  ].join("\n");
}
