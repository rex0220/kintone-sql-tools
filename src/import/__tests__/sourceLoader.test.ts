import { IMPORT_MAX_BYTES, loadImportSource, resolveImportSource } from "../sourceLoader";
import type { ImportSourceHandle, ImportSourcePayload, ImportSourceResolver } from "../types";

test("loadImportSource caches the loader promise and accepts the exact byte limit", async () => {
  const load = jest.fn(async () => ({ bytes: new Uint8Array(IMPORT_MAX_BYTES) }));
  const handle: ImportSourceHandle = { load };
  const cache = new Map<ImportSourceHandle, Promise<ImportSourcePayload>>();
  const [first, second] = await Promise.all([
    loadImportSource(handle, cache),
    loadImportSource(handle, cache),
  ]);
  expect(first).toBe(second);
  expect(first.bytes).toHaveLength(IMPORT_MAX_BYTES);
  expect(load).toHaveBeenCalledTimes(1);
});

test("source boundary returns stable missing, read, type, encoding, and size codes", async () => {
  for (const resolver of [undefined, () => undefined]) {
    expect(() => resolveImportSource("missing", resolver)).toThrow(expect.objectContaining({
      name: "ImportSourceNotSuppliedError",
      message: 'ImportSourceNotSuppliedError: the named IMPORT source "missing" was not supplied.',
    }));
  }

  expect(() => resolveImportSource(
    "invalid",
    (() => ({ load: "not a function" })) as unknown as ImportSourceResolver
  )).toThrow(expect.objectContaining({ name: "ImportSourceInvalidPayloadError" }));

  const cases: Array<[string, ImportSourceHandle]> = [
    ["ImportSourceReadError", { load: async () => { throw new Error("private path"); } }],
    ["ImportSourceInvalidPayloadError", { load: async () => ({ bytes: "not bytes" } as unknown as ImportSourcePayload) }],
    ["ImportSourceInvalidPayloadError", { load: async () => ({ bytes: new Uint8Array(), encoding: "utf16" } as unknown as ImportSourcePayload) }],
    ["ImportSourceTooLargeError", { load: async () => ({ bytes: new Uint8Array(IMPORT_MAX_BYTES + 1) }) }],
  ];
  for (const [name, handle] of cases) {
    await expect(loadImportSource(handle, new Map())).rejects.toMatchObject({ name });
  }
});

test("raw resolver exceptions map to ImportSourceReadError", () => {
  const cause = new Error("resolver failed");
  try {
    resolveImportSource("source", () => { throw cause; });
    throw new Error("expected resolveImportSource to throw");
  } catch (error) {
    expect(error).toMatchObject({
      name: "ImportSourceReadError",
      code: "ImportSourceReadError",
      message: "ImportSourceReadError: IMPORT source resolution failed.",
    });
    expect((error as Error & { cause?: unknown }).cause).toBe(cause);
    expect(Object.keys(error as object)).not.toContain("cause");
  }
});

test("provider stable codes survive wrapping and cause stays non-enumerable", async () => {
  for (const name of ["ImportSourceReadError", "ImportSourceNotRegularFileError"] as const) {
    const provider = Object.assign(new Error("safe provider failure"), { name, code: name });
    await expect(loadImportSource({ load: async () => { throw provider; } }, new Map()))
      .rejects.toMatchObject({ name, code: name });
    try {
      await loadImportSource({ load: async () => { throw provider; } }, new Map());
    } catch (error) {
      expect(Object.keys(error as object)).not.toContain("cause");
    }
  }
});
