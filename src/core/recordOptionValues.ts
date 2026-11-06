import type { KintoneFieldValue, KintoneRecord } from "../converter/dmlToKintone";

/**
 * B205 段階 1: レコードの値を**項目ごとに変換する**明示の再帰関数。
 *
 * 選択肢とステータスに「言語ごとの表示名」を設定したアプリでは、kintone が読み書きする値が
 * 利用者の表示言語の名称になる。`optionNames: "canonical"` では
 *
 * - **読んだレコード**は 表示名 → 既定名（段階 2 で `getRecords` / カーソルの包みから呼ぶ）
 * - **書くレコード**は 既定名 → 表示名（段階 2 で `postRecords` / `putRecords` の包みから呼ぶ）
 *
 * のどちらにも同じ関数を使う（向きは `translate` が決める）。
 *
 * **なぜ明示の再帰にするか**: サブテーブルの実体は `value[].value[項目].value` の入れ子で、
 * 今のコードはキャストで扱っている。入れ子を取りこぼすと「親だけ既定名・子は表示名」という
 * 一部だけ canonical な状態になる（設計レビューの指摘）。
 *
 * **変わらなければ同じ参照を返す**（結果が大きいときに無駄な複製をしないため）。
 */

/** 値 1 つを変換する。知らない項目・知らない値は**そのまま返す**（恒等）。 */
export type OptionValueTranslate = (fieldCode: string, value: string) => string;

interface SubtableRowLike {
  readonly id?: string;
  readonly value: Record<string, { value: unknown }>;
}

function isSubtableRowLike(value: unknown): value is SubtableRowLike {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && "value" in value
    && typeof (value as { value: unknown }).value === "object"
    && (value as { value: unknown }).value !== null
    && !Array.isArray((value as { value: unknown }).value);
}

/** サブテーブルの 1 行（`{ id?, value: { 項目: { value } } }`）を変換する。 */
function mapSubtableRow(row: SubtableRowLike, translate: OptionValueTranslate): SubtableRowLike {
  let changed = false;
  const mappedCells: Record<string, { value: unknown }> = {};
  for (const [code, cell] of Object.entries(row.value)) {
    const mapped = mapCellValue(code, cell?.value, translate);
    if (mapped !== cell?.value) changed = true;
    mappedCells[code] = cell === null || cell === undefined ? cell : { ...cell, value: mapped };
  }
  if (!changed) return row;
  return { ...row, value: mappedCells };
}

/** 1 項目の値（文字列・文字列の配列・サブテーブルの行の配列）を変換する。 */
function mapCellValue(code: string, value: unknown, translate: OptionValueTranslate): unknown {
  if (typeof value === "string") {
    return translate(code, value);
  }
  if (Array.isArray(value)) {
    let changed = false;
    const mapped = value.map((element) => {
      // CHECK_BOX / MULTI_SELECT は文字列の配列（要素ごとに変換する）
      if (typeof element === "string") {
        const next = translate(code, element);
        if (next !== element) changed = true;
        return next;
      }
      // サブテーブルは行の配列（入れ子を再帰で辿る）
      if (isSubtableRowLike(element)) {
        const next = mapSubtableRow(element, translate);
        if (next !== element) changed = true;
        return next;
      }
      // USER_SELECT / ORGANIZATION_SELECT / GROUP_SELECT の { code } などは触らない
      return element;
    });
    return changed ? mapped : value;
  }
  // null / undefined / 数値など、選択肢ではない形は触らない
  return value;
}

/** レコード 1 件を変換する（変わらなければ同じ参照を返す）。 */
export function mapRecordOptionValues(
  record: KintoneRecord,
  translate: OptionValueTranslate
): KintoneRecord {
  let changed = false;
  const mapped: Record<string, KintoneFieldValue> = {};
  for (const [code, field] of Object.entries(record)) {
    if (field === null || field === undefined) {
      mapped[code] = field;
      continue;
    }
    const nextValue = mapCellValue(code, field.value, translate);
    if (nextValue !== field.value) changed = true;
    mapped[code] = nextValue === field.value
      ? field
      : { ...field, value: nextValue as KintoneFieldValue["value"] };
  }
  return changed ? mapped : record;
}

/** レコードの並びを変換する（1 件も変わらなければ同じ参照を返す）。 */
export function mapRecordsOptionValues(
  records: readonly KintoneRecord[],
  translate: OptionValueTranslate
): readonly KintoneRecord[] {
  let changed = false;
  const mapped = records.map((record) => {
    const next = mapRecordOptionValues(record, translate);
    if (next !== record) changed = true;
    return next;
  });
  return changed ? mapped : records;
}
