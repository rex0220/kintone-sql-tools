import { decodeJsonRecords } from "../jsonDecoder";
import { materializeJsonDmlSource } from "../jsonMaterializer";

const bytes = (text: string) => new TextEncoder().encode(text);

test("JSON decoder accepts an object or object array and retains number lexemes", () => {
  const one = decodeJsonRecords(bytes('{"n":1e3}'));
  expect(one[0].get("n")).toEqual({ kind: "number", lexeme: "1e3" });
  expect(decodeJsonRecords(bytes('[{"a":"x"},{"a":"y"}]'))).toHaveLength(2);
});

test.each([
  ["empty", ""],
  ["whitespace", "  \r\n"],
  ["scalar root", "1"],
  ["non-object element", "[null]"],
  ["empty array", "[]"],
  ["trailing garbage", '{"a":1} false'],
  ["top duplicate", '{"a":1,"a":2}'],
  ["nested duplicate", '{"a":{"b":1,"b":2}}'],
])("JSON decoder rejects %s with a position/error", (_label, text) => {
  expect(() => decodeJsonRecords(bytes(text))).toThrow(/ImportSourceError: JSON|contains no records/);
});

test("JSON decoder rejects malformed UTF-8", () => {
  expect(() => decodeJsonRecords(new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x80, 0x7d])))
    .toThrow("not valid UTF-8");
});

test("JSON materializer name-maps, distinguishes null/missing, and enforces safe integers", () => {
  const table = materializeJsonDmlSource(
    { kind: "JSON", sourceName: "x" },
    { bytes: bytes('[{"b":null,"a":9007199254740991},{"a":1}]') },
    [{ code: "a", fieldType: "SINGLE_LINE_TEXT" }, { code: "b", fieldType: "SINGLE_LINE_TEXT" }],
    10
  );
  expect(table.rows).toEqual([{ a: "9007199254740991", b: "" }, { a: "1" }]);
  expect(table.importPresence?.map((set) => [...set])).toEqual([["a", "b"], ["a"]]);
  expect(() => materializeJsonDmlSource(
    { kind: "JSON", sourceName: "x" }, { bytes: bytes('{"a":9007199254740992}') },
    [{ code: "a", fieldType: "SINGLE_LINE_TEXT" }], 10
  )).toThrow("outside the safe integer range");
});

test.each(["1.5", "1e2", "-0"])("JSON materializer rejects non-safe integer lexeme %s", (lexeme) => {
  expect(() => materializeJsonDmlSource(
    { kind: "JSON", sourceName: "x" }, { bytes: bytes(`{"a":${lexeme}}`) },
    [{ code: "a", fieldType: "SINGLE_LINE_TEXT" }], 10
  )).toThrow("safe integer");
});

test("JSON materializer requires NUMBER values to be strings and rejects unknown/type-invalid keys", () => {
  expect(() => materializeJsonDmlSource(
    { kind: "JSON", sourceName: "x" }, { bytes: bytes('{"n":1}') },
    [{ code: "n", fieldType: "NUMBER" }], 10
  )).toThrow("requires a JSON string");
  expect(() => materializeJsonDmlSource(
    { kind: "JSON", sourceName: "x" }, { bytes: bytes('{"x":"1"}') },
    [{ code: "n", fieldType: "NUMBER" }], 10
  )).toThrow("unknown key");
  for (const invalid of ["true", "{}", "[]"]) {
    expect(() => materializeJsonDmlSource(
      { kind: "JSON", sourceName: "x" }, { bytes: bytes(`{"n":${invalid}}`) },
      [{ code: "n", fieldType: "NUMBER" }], 10
    )).toThrow();
  }
  const thirtyDigits = "123456789012345678901234567890";
  expect(materializeJsonDmlSource(
    { kind: "JSON", sourceName: "x" }, { bytes: bytes(`{"n":"${thirtyDigits}"}`) },
    [{ code: "n", fieldType: "NUMBER" }], 10
  ).rows[0].n).toBe(thirtyDigits);
});
