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

/** File bytes are loaded lazily by the engine; the selected File object is the per-run source snapshot. */
export function createBrowserImportSource(
  file: File,
  encoding: ImportEncoding,
  sourceName = file.name
): BrowserImportSource {
  return {
    name: sourceName,
    encoding,
    resolver: (name) => name === sourceName
      ? { load: async () => ({ bytes: await readFileBytes(file), encoding }) }
      : undefined,
  };
}
