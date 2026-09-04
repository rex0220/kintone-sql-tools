// ============================================================
// CLI 専用 atomic write（B179 仕様 R2 §3.5 / §3.6 / §4.6）。
// 同一 directory の一時 file を exclusive create → 全量 write → fsync → close →
// rename。失敗時は open handle を close し、この呼出しが作成した一時 file だけを削除する。
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

/** Filesystem seam so fault injection tests do not need to patch the `fs` namespace. */
export interface ExportFileIo {
  openExclusive(path: string): number;
  write(fd: number, data: Uint8Array, offset: number, length: number): number;
  fsync(fd: number): void;
  close(fd: number): void;
  rename(from: string, to: string): void;
  unlink(path: string): void;
  exists(path: string): boolean;
  randomSuffix(): string;
}

export const nodeExportFileIo: ExportFileIo = {
  openExclusive: (path) => openSync(path, "wx"),
  write: (fd, data, offset, length) => writeSync(fd, data, offset, length),
  fsync: (fd) => fsyncSync(fd),
  close: (fd) => closeSync(fd),
  rename: (from, to) => renameSync(from, to),
  unlink: (path) => unlinkSync(path),
  exists: (path) => existsSync(path),
  randomSuffix: () => randomBytes(6).toString("hex"),
};

export function resolveExportTargetPath(path: string): string {
  return resolve(path);
}

/** Replace `targetPath` with `data` atomically, or leave the existing file untouched. */
export function writeExportFileAtomically(targetPath: string, data: Uint8Array, io: ExportFileIo = nodeExportFileIo): void {
  const target = resolveExportTargetPath(targetPath);
  const temp = join(dirname(target), `.${basename(target)}.${io.randomSuffix()}.tmp`);
  let fd: number | null = null;
  let created = false;
  try {
    fd = io.openExclusive(temp);
    created = true;
    let offset = 0;
    while (offset < data.byteLength) {
      const written = io.write(fd, data, offset, data.byteLength - offset);
      if (written <= 0) throw new Error(`write returned ${written} bytes at offset ${offset}`);
      offset += written;
    }
    io.fsync(fd);
    io.close(fd);
    fd = null;
    io.rename(temp, target);
  } catch (error) {
    if (fd !== null) {
      try { io.close(fd); } catch { /* keep the original error */ }
    }
    // Only remove a temp file this call created; a name collision must not delete someone else's file.
    if (created) {
      try { if (io.exists(temp)) io.unlink(temp); } catch { /* keep the original error */ }
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new ExportSinkWriteError(`could not replace ${JSON.stringify(target)}: ${reason}`, error);
  }
}
