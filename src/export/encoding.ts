import type { CsvExportOptions, ExportEncoding, ExportTextEncoder } from "./types";
import {
  ExportSinkEncoderRequiredError,
  ExportSinkEncodingError,
  ExportSinkInvalidEncoderResultError,
} from "./types";

export interface ResolvedExportEncoding {
  readonly encoding: ExportEncoding;
  readonly encoder?: ExportTextEncoder;
}

export function resolveExportEncoding(options: CsvExportOptions = {}): ResolvedExportEncoding {
  const encoding = options.encoding ?? "utf8";
  if (encoding === "utf8") return { encoding };
  const encoder = options.encoder;
  if (
    !encoder || encoder.encoding !== "sjis" || typeof encoder.encode !== "function"
  ) {
    throw new ExportSinkEncoderRequiredError(
      'encoding "sjis" requires an encoder whose encoding is "sjis" and which has an encode function.'
    );
  }
  return { encoding, encoder };
}

function isUint8Array(value: unknown): value is Uint8Array {
  return value !== null
    && typeof value === "object"
    && ArrayBuffer.isView(value)
    && Object.prototype.toString.call(value) === "[object Uint8Array]";
}

export function encodeExportText(text: string, resolved: ResolvedExportEncoding): Uint8Array {
  if (resolved.encoding === "utf8") return new TextEncoder().encode(text);
  let data: unknown;
  try {
    data = resolved.encoder!.encode(text);
  } catch (error) {
    throw new ExportSinkEncodingError("Shift_JIS encoder failed to encode the CSV payload.", error);
  }
  if (!isUint8Array(data)) {
    throw new ExportSinkInvalidEncoderResultError("Shift_JIS encoder must return a Uint8Array.");
  }
  return data;
}
