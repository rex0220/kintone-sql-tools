import { decodeCsv, parseRfc4180 } from "../csvDecoder";

describe("B39 CSV decoder", () => {
  test("RFC4180 quotes, escaped quote, comma, CRLF and quoted newline", () => {
    expect(parseRfc4180('a,b\r\n"x,y","z""q"\r\n"line1\nline2",v\r\n')).toEqual([
      ["a", "b"], ["x,y", 'z"q'], ["line1\nline2", "v"],
    ]);
  });
  test("UTF-8 BOM header and rows", () => {
    const bytes = new TextEncoder().encode("\uFEFFa,b\r\n1,2");
    expect(decodeCsv(bytes, { encoding: "utf8", hasHeader: true })).toEqual({ columns: ["a", "b"], rows: [["1", "2"]] });
  });
  test.each(["", "a,b\r\n"])("rejects zero data rows", (text) => {
    expect(() => decodeCsv(new TextEncoder().encode(text), { encoding: "utf8", hasHeader: true })).toThrow("no data rows");
  });
  test("NO HEADER derives cN and enforces width", () => {
    expect(decodeCsv(new TextEncoder().encode("1,2\n3,4"), { encoding: "utf8", hasHeader: false })).toEqual({ columns: ["c1", "c2"], rows: [["1", "2"], ["3", "4"]] });
    expect(() => decodeCsv(new TextEncoder().encode("1,2\n3"), { encoding: "utf8", hasHeader: false })).toThrow("expected 2");
  });
  test("rejects duplicate and empty header names", () => {
    expect(() => decodeCsv(new TextEncoder().encode("a,a\n1,2"), { encoding: "utf8", hasHeader: true })).toThrow("duplicated");
    expect(() => decodeCsv(new TextEncoder().encode("a,\n1,2"), { encoding: "utf8", hasHeader: true })).toThrow("empty name");
  });
  test("fatal UTF-8", () => {
    expect(() => decodeCsv(new Uint8Array([0xff]), { encoding: "utf8", hasHeader: false })).toThrow("invalid UTF8");
  });
  test("実 SJIS バイト列をdecodeする", () => {
    const ascii = Array.from(new TextEncoder().encode("code,name\r\nA,"));
    const bytes = new Uint8Array([...ascii, 0x83, 0x65, 0x83, 0x58, 0x83, 0x67]); // テスト
    expect(decodeCsv(bytes, { encoding: "sjis", hasHeader: true })).toEqual({
      columns: ["code", "name"], rows: [["A", "テスト"]],
    });
  });
  test("不正 SJIS バイト列を拒否する", () => {
    expect(() => decodeCsv(new Uint8Array([0x81]), { encoding: "sjis", hasHeader: false })).toThrow("invalid SJIS");
  });
});
