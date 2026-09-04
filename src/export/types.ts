export type ExportEncoding = "utf8" | "sjis";

export interface CsvExportColumnMeta {
  readonly fieldType?: string;
}

export interface CsvExportInput {
  readonly columns: readonly string[];
  readonly rows: readonly Readonly<Record<string, string | null | undefined>>[];
  readonly columnMeta?: ReadonlyMap<string, CsvExportColumnMeta>;
}

export interface ExportTextEncoder {
  readonly encoding: "sjis";
  encode(text: string): Uint8Array;
}

export interface CsvExportOptions {
  readonly encoding?: ExportEncoding;
  readonly timezone?: string;
  readonly encoder?: ExportTextEncoder;
}

export interface CsvExportReceipt {
  readonly rows: number;
  readonly columns: number;
  readonly bytes: number;
  readonly encoding: ExportEncoding;
}

export interface CsvExportResult {
  readonly text: string;
  readonly data: Uint8Array;
  readonly receipt: CsvExportReceipt;
}

export type ExportSerializerErrorCode =
  | "ExportSinkDuplicateHeaderError"
  | "ExportSinkUnsupportedColumnError"
  | "ExportSinkInvalidValueError"
  | "ExportSinkInvalidTimezoneError"
  | "ExportSinkEncoderRequiredError"
  | "ExportSinkEncodingError"
  | "ExportSinkInvalidEncoderResultError";

export class ExportSerializerError extends Error {
  readonly code: ExportSerializerErrorCode;
  declare readonly cause?: unknown;

  constructor(code: ExportSerializerErrorCode, message: string, cause?: unknown) {
    super(`${code}: ${message}`);
    this.name = code;
    this.code = code;
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", {
        value: cause,
        enumerable: false,
        configurable: false,
        writable: false,
      });
    }
  }
}

export class ExportSinkDuplicateHeaderError extends ExportSerializerError {
  constructor(message: string) { super("ExportSinkDuplicateHeaderError", message); }
}

export class ExportSinkUnsupportedColumnError extends ExportSerializerError {
  constructor(message: string) { super("ExportSinkUnsupportedColumnError", message); }
}

export class ExportSinkInvalidValueError extends ExportSerializerError {
  constructor(message: string) { super("ExportSinkInvalidValueError", message); }
}

export class ExportSinkInvalidTimezoneError extends ExportSerializerError {
  constructor(message: string, cause?: unknown) { super("ExportSinkInvalidTimezoneError", message, cause); }
}

export class ExportSinkEncoderRequiredError extends ExportSerializerError {
  constructor(message: string) { super("ExportSinkEncoderRequiredError", message); }
}

export class ExportSinkEncodingError extends ExportSerializerError {
  constructor(message: string, cause?: unknown) { super("ExportSinkEncodingError", message, cause); }
}

export class ExportSinkInvalidEncoderResultError extends ExportSerializerError {
  constructor(message: string) { super("ExportSinkInvalidEncoderResultError", message); }
}
