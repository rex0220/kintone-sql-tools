import { isImportCapabilityGateError } from "../import/importGateError";

export { isImportCapabilityGateError } from "../import/importGateError";

export const IMPORT_FILE_REQUIRED_MESSAGE =
  "IMPORT を実行するにはファイルを選択してください。ヘッダー上部の「ファイルを選択」で CSV/JSON を指定してください。";

/** ファイル未選択時の IMPORT gate だけをプラグイン利用者向けメッセージへ置き換える。 */
export function toPluginImportError(error: unknown, importSourceSelected: boolean): unknown {
  if (importSourceSelected || !isImportCapabilityGateError(error)) return error;
  return new Error(IMPORT_FILE_REQUIRED_MESSAGE);
}
