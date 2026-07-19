import type { ImportSourceHandle, ImportSourcePayload, ImportSourceResolver } from "./types";

export const IMPORT_MAX_BYTES = 10 * 1024 * 1024;

export class ImportSourceError extends Error {
  constructor(message: string) {
    super(`ImportSourceError: ${message}`);
    this.name = "ImportSourceError";
  }
}

export function resolveImportSource(name: string, resolver?: ImportSourceResolver): ImportSourceHandle {
  if (!resolver) throw new ImportSourceError("IMPORT source capability is not available.");
  const handle = resolver(name);
  if (!handle) throw new ImportSourceError(`source \"${name}\" is not supplied.`);
  return handle;
}

export async function loadImportSource(
  handle: ImportSourceHandle,
  cache: Map<ImportSourceHandle, Promise<ImportSourcePayload>>
): Promise<ImportSourcePayload> {
  let pending = cache.get(handle);
  if (!pending) {
    pending = handle.load().then((payload) => {
      if (!(payload.bytes instanceof Uint8Array)) throw new ImportSourceError("loader must return Uint8Array bytes.");
      if (payload.bytes.byteLength > IMPORT_MAX_BYTES) {
        throw new ImportSourceError(`source exceeds the ${IMPORT_MAX_BYTES} byte limit.`);
      }
      return payload;
    });
    cache.set(handle, pending);
  }
  return pending;
}
