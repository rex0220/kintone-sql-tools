import { parseSqlStatement } from "../../core";
import {
  IMPORT_FILE_REQUIRED_MESSAGE,
  isImportCapabilityGateError,
  toPluginImportError,
} from "../importGateError";

describe("plugin IMPORT capability gate error", () => {
  const gateError = (() => {
    try {
      parseSqlStatement("IMPORT INTO APP1 (code) FROM CSV people", { import: false });
      throw new Error("IMPORT gate error was not thrown");
    } catch (error) {
      return error;
    }
  })();

  test("ファイル未選択時の gate エラーを案内文へ置き換える", () => {
    expect(isImportCapabilityGateError(gateError)).toBe(true);
    expect(toPluginImportError(gateError, false)).toEqual(new Error(IMPORT_FILE_REQUIRED_MESSAGE));
  });

  test("gate 以外のエラーは変更しない", () => {
    const syntaxError = new Error("予期しないトークンです。");
    expect(toPluginImportError(syntaxError, false)).toBe(syntaxError);
  });

  test("ファイル選択済みなら capability 文言を含むエラーも変更しない", () => {
    expect(toPluginImportError(gateError, true)).toBe(gateError);
  });
});
