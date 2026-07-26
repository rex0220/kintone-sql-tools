/** B71 の物理 APP schema で、getFields() の結果に依存させない system field codes。 */
export const APP_SYSTEM_FIELD_CODES = [
  "$id",
  "$revision",
  "レコード番号",
  "作成者",
  "作成日時",
  "更新者",
  "更新日時",
  "ステータス",
  "作業者",
] as const;

/**
 * フィールド定義による実在検証の対象外となる system/virtual field code を判定する。
 * B71 より前の validation semantics（`_` / `$` prefix のみ）を維持する。
 */
export function isSystemLikeFieldCode(code: string): boolean {
  return code.startsWith("_") || code.startsWith("$");
}
