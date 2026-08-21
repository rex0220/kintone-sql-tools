import { sourceLocationAt } from "../diagnostics";

describe("B168 source diagnostics", () => {
  test("mixed CRLF, CR, and LF are counted as single line breaks", () => {
    const source = "one\r\ntwo\rthree\nfour";
    expect(sourceLocationAt(source, source.indexOf("two"))).toEqual({ line: 2, column: 1 });
    expect(sourceLocationAt(source, source.indexOf("three") + 2)).toEqual({ line: 3, column: 3 });
    expect(sourceLocationAt(source, source.indexOf("four"))).toEqual({ line: 4, column: 1 });
  });

  test("offsets are clamped to the original source", () => {
    expect(sourceLocationAt("a\r\n", 99)).toEqual({ line: 2, column: 1 });
    expect(sourceLocationAt("abc", -1)).toEqual({ line: 1, column: 1 });
  });
});
