const IMPORT_CAPABILITY_GATE_MARKER = "capability is disabled";

export const IMPORT_FILE_REQUIRED_MESSAGE =
  "IMPORT を実行するにはファイルを選択してください。ヘッダー上部の「ファイルを選択」で CSV/JSON を指定してください。";

function errorMessage(error: unknown): string | null {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return null;
}

/** parser の IMPORT capability gate だけを識別する。 */
export function isImportCapabilityGateError(error: unknown): boolean {
  return errorMessage(error)?.includes(IMPORT_CAPABILITY_GATE_MARKER) === true;
}

/** ファイル未選択時の IMPORT gate だけをプラグイン利用者向けメッセージへ置き換える。 */
export function toPluginImportError(error: unknown, importSourceSelected: boolean): unknown {
  if (importSourceSelected || !isImportCapabilityGateError(error)) return error;
  return new Error(IMPORT_FILE_REQUIRED_MESSAGE);
}
