import { createBrowserImportSource, defaultImportSourceName } from "../importFileSource";

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

  test("既定ソース名は拡張子を除いた識別子で、bytes と encoding を resolver に束ねる", async () => {
    const file = new Blob([new Uint8Array([0x82, 0xa0])]) as File;
    Object.defineProperty(file, "name", { value: "people.csv" });
    const source = createBrowserImportSource(file, "sjis");
    // FROM CSV <name> は識別子1つ。拡張子つきファイル名は SQL 参照できないため basename を使う。
    expect(source.name).toBe("people");
    expect(source.resolver("people.csv")).toBeUndefined();
    const loaded = await source.resolver("people")?.load();
    expect(Array.from(loaded!.bytes)).toEqual([0x82, 0xa0]);
    expect(loaded!.encoding).toBe("sjis");
  });
});

describe("defaultImportSourceName", () => {
  test("拡張子除去・日本語保持・非識別子文字を _ 化・空は fallback", () => {
    expect(defaultImportSourceName("plugin_import_10.csv")).toBe("plugin_import_10");
    expect(defaultImportSourceName("顧客データ.csv")).toBe("顧客データ");
    expect(defaultImportSourceName("my.data.v2.json")).toBe("my_data_v2");
    expect(defaultImportSourceName("a b-c.csv")).toBe("a_b_c");
    expect(defaultImportSourceName(".csv")).toBe("import_source");
  });
});
