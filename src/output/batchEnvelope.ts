// ============================================================
// バッチ実行結果のエンベロープ整形（バッチ仕様 §6.2）
//
// MCP `ksql_query` / `ksql_mutate` のバッチ応答と CLI `--format json` の
// バッチ出力で共有する純関数。`BatchExecuteResult` / `ExecuteResult` に
// 依存するため `src/core` ではなく上位層（src/output）に置く
// （execute.ts は core を import しており、core 配下に値 import を
// 持ち込むと循環するため。バッチ強化第1弾 §3.3）。
// ============================================================

import type {
  AssertResult,
  BatchExecuteResult,
  ExecuteResult,
  DmlValidationResult,
  SelectResult,
} from "../execute";

export interface BatchEnvelopeResultSet {
  type?: "SELECT" | "VALIDATION";
  columns: string[];
  rows: SelectResult["rows"];
  rowCount: number;
  warnings: string[];
  operation?: DmlValidationResult["operation"];
  validatedRows?: number;
  validRows?: number;
  invalidRows?: number;
  errorCount?: number;
  validateStats?: SelectResult["validateStats"];
  errTable?: string;
  importDetail?: DmlValidationResult["importDetail"];
  apply?: DmlValidationResult["apply"];
  guards?: DmlValidationResult["guards"];
  deletedRows?: DmlValidationResult["deletedRows"];
}

export interface BatchEnvelope {
  ok: boolean;
  batch: true;
  statementCount: number;
  statements: Array<Record<string, unknown>>;
  results: BatchEnvelopeResultSet[];
  warnings: string[];
}

export interface BuildBatchEnvelopeOptions {
  /** 返却合計行数の上限（MCP の maxTotalRecords）。超過時は ArgumentError を投げる。
   *  CLI に同等オプションはないため未指定なら無制限 */
  maxTotalRecords?: number;
}

/** ミューテーション結果から影響件数フィールドを取り出す（文ごとエンベロープ用） */
function toMutationSummary(
  result: Exclude<ExecuteResult, SelectResult | AssertResult | DmlValidationResult>
): Record<string, unknown> {
  if (result.type === "INSERT") {
    return {
      insertedCount: result.insertedCount, createdIds: result.createdIds,
      ...(result.affectedRows !== undefined ? { affectedRows: result.affectedRows } : {}),
      ...(result.skippedRows !== undefined ? { skippedRows: result.skippedRows } : {}),
      ...(result.rejectLimit !== undefined ? { rejectLimit: result.rejectLimit } : {}),
      ...(result.errTable !== undefined ? { errTable: result.errTable } : {}),
    };
  }
  if (result.type === "UPDATE") return {
    updatedCount: result.updatedCount,
    ...(result.successfulChunks !== undefined ? { successfulChunks: result.successfulChunks } : {}),
    ...(result.successfulParents !== undefined ? { successfulParents: result.successfulParents } : {}),
    ...(result.nonTransactional !== undefined ? { nonTransactional: result.nonTransactional } : {}),
    ...(result.affectedRows !== undefined ? { affectedRows: result.affectedRows } : {}),
    ...(result.skippedRows !== undefined ? { skippedRows: result.skippedRows } : {}),
    ...(result.rejectLimit !== undefined ? { rejectLimit: result.rejectLimit } : {}),
    ...(result.errTable !== undefined ? { errTable: result.errTable } : {}),
  };
  if (result.type === "DELETE") return { deletedCount: result.deletedCount };
  if (result.type === "UPSERT") {
    return {
      insertedCount: result.insertedCount, updatedCount: result.updatedCount,
      ...(result.affectedRows !== undefined ? { affectedRows: result.affectedRows } : {}),
      ...(result.skippedRows !== undefined ? { skippedRows: result.skippedRows } : {}),
      ...(result.rejectLimit !== undefined ? { rejectLimit: result.rejectLimit } : {}),
      ...(result.errTable !== undefined ? { errTable: result.errTable } : {}),
    };
  }
  return { reorderedParentCount: result.reorderedParentCount };
}

/**
 * バッチ実行結果を仕様 §6.2 のエンベロープに整形する。
 * - results には結果セットを返した read-only 文の結果のみ入れる
 *   （CREATE TEMP TABLE の実体化結果は tempTable / rowCount のみ）
 * - DML 文の影響件数は statements[] のエントリに展開する（途中失敗時に
 *   「どこまで反映されたか」を文ごとに読み取れるようにする）
 * - maxTotalRecords 指定時は返却合計行数を超えた時点でエラー
 */
export function buildBatchEnvelope(
  batch: BatchExecuteResult,
  options: BuildBatchEnvelopeOptions = {}
): BatchEnvelope {
  const { maxTotalRecords } = options;
  const results: BatchEnvelopeResultSet[] = [];
  let totalRows = 0;

  const statements = batch.statements.map((s) => {
    const entry: Record<string, unknown> = {
      index: s.index,
      type: s.type,
      status: s.status,
    };
    if (s.status === "error" && s.error) entry.error = s.error;
    if (s.status === "skipped" && s.skippedReason) entry.skippedReason = s.skippedReason;
    if (s.tempTable !== undefined) entry.tempTable = s.tempTable;
    if (s.rowCount !== undefined) entry.rowCount = s.rowCount;

    if (s.status === "success" && s.result?.type === "SELECT") {
      totalRows += s.result.rowCount;
      if (maxTotalRecords !== undefined && totalRows > maxTotalRecords) {
        throw new Error(
          `ArgumentError: batch total rows (${totalRows}) exceed maxTotalRecords (${maxTotalRecords}).`
        );
      }
      entry.resultIndex = results.length;
      results.push({
        type: "SELECT",
        columns: s.result.columns,
        rows: s.result.rows,
        rowCount: s.result.rowCount,
        warnings: s.result.warnings ?? [],
        ...(s.result.validateStats ? { validateStats: s.result.validateStats } : {}),
      });
    } else if (s.result?.type === "VALIDATION") {
      totalRows += s.result.errorCount;
      if (maxTotalRecords !== undefined && totalRows > maxTotalRecords) {
        throw new Error(`ArgumentError: batch total rows (${totalRows}) exceed maxTotalRecords (${maxTotalRecords}).`);
      }
      entry.resultIndex = results.length;
      results.push({
        type: "VALIDATION",
        columns: s.result.columns,
        rows: s.result.errors,
        rowCount: s.result.errorCount,
        warnings: [],
        operation: s.result.operation,
        validatedRows: s.result.validatedRows,
        validRows: s.result.validRows,
        invalidRows: s.result.invalidRows,
        errorCount: s.result.errorCount,
        ...(s.result.errTable ? { errTable: s.result.errTable } : {}),
        ...(s.result.importDetail ? { importDetail: s.result.importDetail } : {}),
        ...(s.result.apply ? { apply: s.result.apply } : {}),
        ...(s.result.guards ? { guards: s.result.guards } : {}),
        ...(s.result.deletedRows ? { deletedRows: s.result.deletedRows } : {}),
      });
    } else if (s.status === "success" && s.result && s.result.type !== "SELECT" && s.result.type !== "ASSERT") {
      // バッチ内 ASSERT の成功は result を持たない no-result 文のためここには来ない
      //（ExecuteResult 型上は含まれるため型の除外も兼ねる）
      Object.assign(entry, toMutationSummary(s.result));
    }
    return entry;
  });

  return {
    ok: batch.ok,
    batch: true,
    statementCount: batch.statementCount,
    statements,
    results,
    // バッチ全体の警告（仕様 §6.2）。文ごとの警告は results[].warnings に入る
    warnings: [],
  };
}
