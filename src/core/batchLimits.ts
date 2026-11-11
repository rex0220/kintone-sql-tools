/**
 * B217: バッチの文の数と、同時に残っている一時テーブルの数の上限。
 *
 * 既定（20 文・16 個）は CLI・MCP・engine ライブラリ・/flow で共通。/flow の呼び出し側だけが
 * `maxBatchStatements` / `maxTempTables` で変えられる（kSQL アクションの依頼 KJ-13）。
 * 既定の一時テーブルの数は、合計の行数の上限（`tempTablesMaxTotalRows`）が既定で無い面での
 * メモリの事実上の上限（16 個 × 1 個 `tempTableMaxRows`）なので、16 を超えるには合計の上限を求める。
 *
 * このモジュールは何も取り込まない（parser と core/batch の両方から使うため）。
 */

/** 1 回の呼び出しで書ける文の数の既定。 */
export const MAX_BATCH_STATEMENTS = 20;
/** 同時に残っている一時テーブルの数の既定（DROP TEMP TABLE で外した表は数えない）。 */
export const MAX_TEMP_TABLES = 16;
/** `maxBatchStatements` で渡せる値の天井。 */
export const MAX_BATCH_STATEMENTS_CEILING = 100;
/** `maxTempTables` で渡せる値の天井。 */
export const MAX_TEMP_TABLES_CEILING = 64;

export interface BatchLimitOptions {
  /** 文の数の上限（1〜100。省略時 20）。 */
  maxBatchStatements?: number;
  /** 同時に残っている一時テーブルの数の上限（1〜64。省略時 16）。 */
  maxTempTables?: number;
}

export interface ResolvedBatchLimits {
  readonly maxStatements: number;
  readonly maxTempTables: number;
}

function limitValue(name: string, value: number | undefined, fallback: number, ceiling: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {
    throw new RangeError(`${name} must be an integer from 1 through ${ceiling}`);
  }
  return value;
}

/** オプションの値を確かめて、効く上限を返す（範囲外は RangeError）。 */
export function resolveBatchLimits(options: BatchLimitOptions = {}): ResolvedBatchLimits {
  return {
    maxStatements: limitValue("maxBatchStatements", options.maxBatchStatements, MAX_BATCH_STATEMENTS, MAX_BATCH_STATEMENTS_CEILING),
    maxTempTables: limitValue("maxTempTables", options.maxTempTables, MAX_TEMP_TABLES, MAX_TEMP_TABLES_CEILING),
  };
}
