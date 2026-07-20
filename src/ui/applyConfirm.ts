import type { ApplyDiagnostic, ApplyDiagnosticOperation, ApplyDiagnosticTarget, DmlConfirmContext } from "../core";

/** desktop confirm routing用。IMPORT detail を APPLY formatter に渡さない。 */
export function resolvePluginApplyConfirmHtml(context: DmlConfirmContext): string | null {
  if (context.importDetail || !context.applyDiagnostic) return null;
  return buildApplyConfirmMessage(context.applyDiagnostic);
}

/**
 * Phase 16a の shared detail だけから APPLY 確認 HTML を構築する。
 * IMPORT detail とは型も formatter も共有しない。
 */
export function buildApplyConfirmMessage(detail: ApplyDiagnostic): string {
  const lines: string[] = [];
  const subtableTargets = detail.branches.flatMap((branch) =>
    branch.targets.filter((target) => target.targetKind === "SUBTABLE")
  );
  const deletedRows = sumNullable(subtableTargets.map((target) => operationCount(target, "REMOVE")));
  const deletedParents = sumNullable(detail.branches.map((branch) => branch.deletedParentRows));
  const parentRows = sumNullable(detail.branches.map((branch) => branch.parentRows));
  const changedRows = sumNullable(subtableTargets.map((target) => target.changedCount));
  const addedRows = sumNullable(subtableTargets.map((target) => operationCount(target, "APPEND")));

  if (deletedRows !== null && deletedRows > 0) {
    lines.push(`【最重要警告】サブテーブル ${deletedRows} 行を削除します。`);
  }
  lines.push(
    `APPLY ${detail.statementKind}: 親 ${count(parentRows)} 件、変更子行 ${count(changedRows)} 件、追加 ${count(addedRows)} 件`
  );

  for (const branch of detail.branches) {
    const initialRows = branch.branch === "insert"
      ? sumNullable(branch.targets.filter((target) => target.targetKind === "SUBTABLE").map((target) => target.changedCount))
      : null;
    lines.push(
      `分岐 ${branch.branch.toUpperCase()}: 親 ${count(branch.parentRows)} 件`
      + (branch.branch === "insert"
        ? ` / 作成親 ${count(branch.parentRows)} 件 / 初期子行 ${count(initialRows)} 件`
        : "")
    );
    for (const target of branch.targets) lines.push(formatTarget(target));
    lines.push(
      `  guard: 親 ${count(branch.guards.parentRows)}/${branch.guards.dmlMaxRows}`
      + ` / 子 ${count(branch.guards.subtableRows)}/${branch.guards.dmlMaxSubtableRows}`
      + ` / revision 必須: ${branch.guards.revisionRequired ? "はい" : "いいえ"}`
      + ` / 超過: ${branch.guards.wouldExceed === null ? "不明" : branch.guards.wouldExceed ? "はい" : "いいえ"}`
    );
    if (branch.successfulParents !== undefined || branch.chunk.successfulChunks !== undefined) {
      lines.push(
        `  成功進捗: 親 ${branch.successfulParents ?? 0} 件 / chunk ${branch.chunk.successfulChunks ?? 0}`
      );
    }
    if (branch.chunk.failedStage !== undefined) {
      lines.push(
        `  【部分成功】失敗分岐 ${branch.branch.toUpperCase()}`
        + ` / stage ${branch.chunk.failedStage}`
        + ` / chunk ${(branch.chunk.failedChunkIndex ?? 0) + 1}`
      );
    }
  }

  if (detail.branches.some((branch) => branch.targets.some((target) => target.targetKind === "MULTI_VALUE"))) {
    lines.push("多値 ADD/REMOVE はサブテーブル子行ガードの対象外です（親件数ガードは適用）。");
  }
  lines.push(
    `削除 ${count(deletedRows)} 行 / 削除対象親 ${count(deletedParents)} 件`,
    `revision 必須: ${detail.branches.some((branch) => branch.guards.revisionRequired) ? "はい" : "いいえ"}`,
    "revision conflict 時の自動再試行: なし",
    "元に戻せない操作: はい",
    "【注意】非トランザクションです。後続 chunk が失敗しても、先に成功した親への書込みは残ります（部分成功あり・自動 retry なし）。"
  );
  return lines.map(escHtml).join("<br>");
}

function formatTarget(target: ApplyDiagnosticTarget): string {
  if (target.targetKind === "SUBTABLE") {
    const matchedRows = operationMetricCount(target, "PATCH", "matchedRows");
    const changedRows = operationMetricCount(target, "PATCH", "changedRows");
    return `  table=${target.field}: PATCH ${count(operationCount(target, "PATCH"))}`
      + ` / APPEND ${count(operationCount(target, "APPEND"))}`
      + ` / REMOVE ${count(operationCount(target, "REMOVE"))}`
      + (matchedRows === null && changedRows === null ? ""
        : ` / PATCH 一致 ${count(matchedRows)} / 変更 ${count(changedRows)}`);
  }
  const operations = target.operations.map(formatMultiValueOperation).join(", ");
  return `  multiValue=${target.field} (${target.fieldType ?? "UNKNOWN"}): ${operations}`;
}

function formatMultiValueOperation(operation: ApplyDiagnosticOperation): string {
  const kind = operation.kind === "REMOVE_VALUE" ? "REMOVE" : operation.kind;
  return `${kind} ${count(operation.count)}${operation.value === undefined ? "" : ` value=${operation.value}`}`;
}

function operationCount(target: ApplyDiagnosticTarget, kind: ApplyDiagnosticOperation["kind"]): number | null {
  const operations = target.operations.filter((operation) => operation.kind === kind);
  return sumNullable(operations.map((operation) => operation.count));
}

function operationMetricCount(
  target: ApplyDiagnosticTarget,
  kind: ApplyDiagnosticOperation["kind"],
  metric: "matchedRows" | "changedRows"
): number | null {
  const operations = target.operations.filter((operation) => operation.kind === kind);
  if (operations.length === 0 || operations.every((operation) => operation[metric] === undefined)) return null;
  return sumNullable(operations.map((operation) => operation[metric] ?? null));
}

function sumNullable(values: readonly (number | null)[]): number | null {
  return values.some((value) => value === null) ? null : values.reduce<number>((sum, value) => sum + value!, 0);
}

function count(value: number | null): string {
  return value === null ? "不明" : String(value);
}

function escHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
