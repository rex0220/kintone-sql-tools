// ============================================================
// CLI 専用 Shift_JIS(CP932) encoder（B179 仕様 R2 §2.6 / §4.5）。
// encoding-japanese は表現不能文字を黙って '?' 等へ置換するため、
// encode 後に TextDecoder("shift_jis") で decode し、canonical text と
// code unit 単位で完全一致しなければ throw する（fail-closed）。
// /flow bundle からは参照しない（Node CLI bundle 限定）。
// ============================================================

import Encoding from "encoding-japanese";
import type { ExportTextEncoder } from "../export/types";

export class CliShiftJisEncodingError extends Error {
  readonly code = "ExportSinkEncodingError";

  constructor(message: string) {
    super(`ExportSinkEncodingError: ${message}`);
    this.name = "ExportSinkEncodingError";
  }
}

function describeCodePoint(text: string, index: number): string {
  const codePoint = text.codePointAt(index) ?? 0xfffd;
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

function firstMismatch(expected: string, actual: string): number {
  const length = Math.min(expected.length, actual.length);
  for (let i = 0; i < length; i++) {
    if (expected.charCodeAt(i) !== actual.charCodeAt(i)) return i;
  }
  return length;
}

/** Shift_JIS encoder that refuses any text it cannot round-trip exactly. */
export function createCliShiftJisEncoder(): ExportTextEncoder {
  const decoder = new TextDecoder("shift_jis", { fatal: true });
  return {
    encoding: "sjis",
    encode(text: string): Uint8Array {
      const bytes = new Uint8Array(
        Encoding.convert(Encoding.stringToCode(text), { to: "SJIS", from: "UNICODE" })
      );
      let decoded: string;
      try {
        decoded = decoder.decode(bytes);
      } catch {
        throw new CliShiftJisEncodingError("Shift_JIS output could not be decoded back for verification.");
      }
      if (decoded !== text) {
        const index = firstMismatch(text, decoded);
        throw new CliShiftJisEncodingError(
          `character ${describeCodePoint(text, index)} at offset ${index} cannot be represented in Shift_JIS.`
        );
      }
      return bytes;
    },
  };
}
