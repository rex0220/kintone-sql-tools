import type { ImportSourceHandle, ImportSourcePayload, ImportSourceResolver } from "./types";

export const IMPORT_MAX_BYTES = 10 * 1024 * 1024;

export class ImportSourceError extends Error {
  constructor(message: string) {
    super(`ImportSourceError: ${message}`);
    this.name = "ImportSourceError";
  }
}

type ImportSourceBoundaryErrorCode =
  | "ImportSourceNotSuppliedError"
  | "ImportSourceReadError"
  | "ImportSourceNotRegularFileError"
  | "ImportSourceTooLargeError"
  | "ImportSourceInvalidPayloadError";

class ImportSourceBoundaryError extends Error {
  readonly code: ImportSourceBoundaryErrorCode;
  declare readonly cause?: unknown;

  constructor(code: ImportSourceBoundaryErrorCode, message: string, cause?: unknown) {
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

function providerError(error: unknown): ImportSourceBoundaryError | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const shaped = error as { code?: unknown; name?: unknown; message?: unknown };
  const code = shaped.code === "ImportSourceReadError" || shaped.code === "ImportSourceNotRegularFileError"
    ? shaped.code
    : shaped.name === "ImportSourceReadError" || shaped.name === "ImportSourceNotRegularFileError"
      ? shaped.name
      : undefined;
  if (!code) return undefined;
  const fallback = code === "ImportSourceReadError"
    ? "IMPORT source could not be read."
    : "IMPORT source is not a regular file.";
  return new ImportSourceBoundaryError(
    code,
    typeof shaped.message === "string" && shaped.message.length > 0 ? shaped.message : fallback,
    error
  );
}

function isUint8Array(value: unknown): value is Uint8Array {
  return value !== null
    && typeof value === "object"
    && ArrayBuffer.isView(value)
    && Object.prototype.toString.call(value) === "[object Uint8Array]";
}

export function resolveImportSource(name: string, resolver?: ImportSourceResolver): ImportSourceHandle {
  if (!resolver) {
    throw new ImportSourceBoundaryError(
      "ImportSourceNotSuppliedError",
      `the named IMPORT source ${JSON.stringify(name)} was not supplied.`
    );
  }
  try {
    const handle = resolver(name);
    if (!handle) {
      throw new ImportSourceBoundaryError(
        "ImportSourceNotSuppliedError",
        `the named IMPORT source ${JSON.stringify(name)} was not supplied.`
      );
    }
    if (typeof handle !== "object" || typeof handle.load !== "function") {
      throw new ImportSourceBoundaryError(
        "ImportSourceInvalidPayloadError",
        "resolver must return a handle with a load function."
      );
    }
    return handle;
  } catch (error) {
    if (error instanceof ImportSourceBoundaryError) throw error;
    throw providerError(error)
      ?? new ImportSourceBoundaryError("ImportSourceReadError", "IMPORT source resolution failed.", error);
  }
}

export async function loadImportSource(
  handle: ImportSourceHandle,
  cache: Map<ImportSourceHandle, Promise<ImportSourcePayload>>
): Promise<ImportSourcePayload> {
  let pending = cache.get(handle);
  if (!pending) {
    pending = Promise.resolve()
      .then(() => handle.load())
      .catch((error) => {
        throw providerError(error)
          ?? new ImportSourceBoundaryError("ImportSourceReadError", "IMPORT source could not be read.", error);
      })
      .then((payload) => {
        if (payload === null || typeof payload !== "object" || !isUint8Array(payload.bytes)) {
          throw new ImportSourceBoundaryError(
            "ImportSourceInvalidPayloadError",
            "loader must return Uint8Array bytes."
          );
        }
        if (payload.encoding !== undefined && payload.encoding !== "utf8" && payload.encoding !== "sjis") {
          throw new ImportSourceBoundaryError(
            "ImportSourceInvalidPayloadError",
            "loader returned an unsupported encoding."
          );
        }
        if (payload.bytes.byteLength > IMPORT_MAX_BYTES) {
          throw new ImportSourceBoundaryError(
            "ImportSourceTooLargeError",
            `source exceeds the ${IMPORT_MAX_BYTES} byte limit.`
          );
        }
        return payload;
      });
    cache.set(handle, pending);
  }
  return pending;
}
