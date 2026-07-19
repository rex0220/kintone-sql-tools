import type { ImportEncoding } from "../types/ast";
import type { ImportSourceResolver } from "../import/types";

export interface BrowserImportSource {
  name: string;
  encoding: ImportEncoding;
  resolver: ImportSourceResolver;
}

export function readFileBytes(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed."));
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * FROM CSV <name> は識別子1つとしてパースされるため、拡張子とドット等を含む
 * ファイル名はそのままでは SQL 参照できない。既定のソース名は拡張子を除き、
 * 識別子として使えない文字（ドット・空白・記号）を `_` に正規化する
 * （日本語・英数字・`_` は保持）。例: "plugin_import_10.csv" → "plugin_import_10"。
 */
export function defaultImportSourceName(fileName: string): string {
  const base = fileName.replace(/\.[^.]*$/, "");
  const normalized = base.replace(/[^\p{L}\p{N}_]/gu, "_");
  return normalized || "import_source";
}

/** File bytes are loaded lazily by the engine; the selected File object is the per-run source snapshot. */
export function createBrowserImportSource(
  file: File,
  encoding: ImportEncoding,
  sourceName = defaultImportSourceName(file.name)
): BrowserImportSource {
  return {
    name: sourceName,
    encoding,
    resolver: (name) => name === sourceName
      ? { load: async () => ({ bytes: await readFileBytes(file), encoding }) }
      : undefined,
  };
}
