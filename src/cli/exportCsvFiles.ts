// ============================================================
// CLI 専用 atomic write（B179 仕様 R2 §3.5 / §3.6 / §4.6）。
// 同一 directory の一時 file を exclusive create → 全量 write → fsync → close →
// rename。失敗時は open handle を close し未 rename の一時 file を削除する。
// 旧 file を先に削除する fallback は行わない（Windows の EPERM は error のまま）。
// ============================================================

import { closeSync, existsSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { randomBytes } from "crypto";

export class ExportSinkWriteError extends Error {
  readonly code = "ExportSinkWriteError";
  declare readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(`ExportSinkWriteError: ${message}`);
    this.name = "ExportSinkWriteError";
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", { value: cause, enumerable: false, configurable: false, writable: false });
    }
  }
}

export function resolveExportTargetPath(path: string): string {
  return resolve(path);
}

/** Replace `targetPath` with `data` atomically, or leave the existing file untouched. */
export function writeExportFileAtomically(targetPath: string, data: Uint8Array): void {
  const target = resolveExportTargetPath(targetPath);
  const temp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(temp, "wx");
    let offset = 0;
    while (offset < data.byteLength) {
      offset += writeSync(fd, data, offset, data.byteLength - offset);
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temp, target);
  } catch (error) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* keep the original error */ }
    }
    try { if (existsSync(temp)) unlinkSync(temp); } catch { /* keep the original error */ }
    const reason = error instanceof Error ? error.message : String(error);
    throw new ExportSinkWriteError(`could not replace ${JSON.stringify(target)}: ${reason}`, error);
  }
}
