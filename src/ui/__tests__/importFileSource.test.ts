import { createBrowserImportSource } from "../importFileSource";

class MockFileReader {
  result: ArrayBuffer | null = null;
  error: Error | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsArrayBuffer(file: Blob): void {
    void file.arrayBuffer().then((value) => {
      this.result = value;
      this.onload?.();
    }, (error) => {
      this.error = error;
      this.onerror?.();
    });
  }
}

describe("browser IMPORT file source", () => {
  beforeAll(() => { (globalThis as { FileReader?: unknown }).FileReader = MockFileReader; });

  test("binds selected file name, bytes, and encoding to a resolver", async () => {
    const file = new Blob([new Uint8Array([0x82, 0xa0])]) as File;
    Object.defineProperty(file, "name", { value: "people.csv" });
    const source = createBrowserImportSource(file, "sjis");
    expect(source.resolver("other")).toBeUndefined();
    const loaded = await source.resolver("people.csv")?.load();
    expect(Array.from(loaded!.bytes)).toEqual([0x82, 0xa0]);
    expect(loaded!.encoding).toBe("sjis");
  });
});
