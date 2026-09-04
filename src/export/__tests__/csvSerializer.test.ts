import { serializeCsvExport } from "../csvSerializer";
import type { CsvExportColumnMeta, CsvExportInput, ExportTextEncoder } from "../types";

const meta = (...entries: readonly (readonly [string, string])[]): ReadonlyMap<string, CsvExportColumnMeta> =>
  new Map(entries.map(([column, fieldType]) => [column, { fieldType }]));

describe("B179 CSV serializer", () => {
  test("keeps scalar strings and maps null, undefined, missing properties, and empty strings to empty cells", () => {
    const result = serializeCsvExport({
      columns: ["scalar", "nil", "undef", "missing", "empty"],
      rows: [{ scalar: "0012.50", nil: null, undef: undefined, empty: "" }],
    });
    expect(result.text).toBe("scalar,nil,undef,missing,empty\r\n0012.50,,,,\r\n");
  });

  test.each([123, true, { value: "x" }, ["x"]])("rejects non-string row value %#", (value) => {
    const input = { columns: ["c"], rows: [{ c: value }] } as unknown as CsvExportInput;
    expect(() => serializeCsvExport(input)).toThrow(expect.objectContaining({
      name: "ExportSinkInvalidValueError",
      code: "ExportSinkInvalidValueError",
      message: expect.stringMatching(/data row 1.*column "c"/),
    }));
  });

  test("turns empty and populated string arrays into empty and LF-joined quoted cells", () => {
    const result = serializeCsvExport({
      columns: ["empty", "choices"],
      rows: [{ empty: "[]", choices: '["A","B"]' }],
      columnMeta: meta(["empty", "CHECK_BOX"], ["choices", "MULTI_SELECT"]),
    });
    expect(result.text).toBe('empty,choices\r\n,"A\nB"\r\n');
  });

  test.each(["CATEGORY", "CHECK_BOX", "MULTI_SELECT"])("handles %s as a string array", (fieldType) => {
    expect(serializeCsvExport({
      columns: ["c"], rows: [{ c: '["x","y"]' }], columnMeta: meta(["c", fieldType]),
    }).text).toBe('c\r\n"x\ny"\r\n');
  });

  test.each(["USER_SELECT", "ORGANIZATION_SELECT", "GROUP_SELECT", "STATUS_ASSIGNEE"])(
    "uses only ordered codes for %s",
    (fieldType) => {
      expect(serializeCsvExport({
        columns: ["people"],
        rows: [{ people: '[{"code":"u1","name":"One"},{"code":"u2","name":"Two"}]' }],
        columnMeta: meta(["people", fieldType]),
      }).text).toBe('people\r\n"u1\nu2"\r\n');
    }
  );

  test.each([
    ["CHECK_BOX", "not-json"],
    ["MULTI_SELECT", "{}"],
    ["CATEGORY", '["ok",1]'],
    ["USER_SELECT", '[{"name":"missing"}]'],
    ["GROUP_SELECT", '[{"code":null}]'],
  ])("rejects malformed %s values without echoing the cell", (fieldType, value) => {
    try {
      serializeCsvExport({ columns: ["c"], rows: [{ c: value }], columnMeta: meta(["c", fieldType]) });
      throw new Error("expected serializer to fail");
    } catch (error) {
      expect(error).toMatchObject({ name: "ExportSinkInvalidValueError" });
      expect((error as Error).message).not.toContain(value);
    }
  });

  test("does not interpret a JSON-looking value when fieldType is unknown", () => {
    expect(serializeCsvExport({ columns: ["expr"], rows: [{ expr: '["A","B"]' }] }).text)
      .toBe('expr\r\n"[""A"",""B""]"\r\n');
  });

  test.each(["SUBTABLE", "FILE"])("rejects %s metadata before row conversion", (fieldType) => {
    const input = {
      columns: ["c"], rows: [{ c: 123 }], columnMeta: meta(["c", fieldType]),
    } as unknown as CsvExportInput;
    expect(() => serializeCsvExport(input)).toThrow(expect.objectContaining({
      name: "ExportSinkUnsupportedColumnError",
      message: expect.stringContaining('column "c"'),
    }));
  });

  test("SUBTABLE error directs callers to APP$明細 and FILE explains its exclusion", () => {
    expect(() => serializeCsvExport({ columns: ["Lines"], rows: [], columnMeta: meta(["Lines", "SUBTABLE"]) }))
      .toThrow("APP$明細");
    expect(() => serializeCsvExport({ columns: ["Files"], rows: [], columnMeta: meta(["Files", "FILE"]) }))
      .toThrow("attachment export is not supported");
  });

  test("quotes quote, comma, CR, and LF using RFC 4180 and always ends records with CRLF", () => {
    const result = serializeCsvExport({
      columns: ['h"', "comma,", "cr", "lf"],
      rows: [{ 'h"': 'a"b', "comma,": "x,y", cr: "x\ry", lf: "x\ny" }],
    });
    expect(result.text).toBe('"h""","comma,",cr,lf\r\n"a""b","x,y","x\ry","x\ny"\r\n');
  });

  test("rejects an exact duplicate header before touching row values", () => {
    const input = { columns: ["A", "A"], rows: [{ A: 123 }] } as unknown as CsvExportInput;
    expect(() => serializeCsvExport(input)).toThrow(expect.objectContaining({
      name: "ExportSinkDuplicateHeaderError",
      code: "ExportSinkDuplicateHeaderError",
    }));
    expect(serializeCsvExport({ columns: ["A", "a"], rows: [] }).text).toBe("A,a\r\n");
  });

  test("returns a header and CRLF for an empty result", () => {
    expect(serializeCsvExport({ columns: ["a", "b"], rows: [] }).text).toBe("a,b\r\n");
  });

  test("expands numeric exponents but leaves non-exponent NUMBER and scalar text unchanged", () => {
    expect(serializeCsvExport({
      columns: ["n", "plain", "scalar"],
      rows: [{ n: "1.25e+22", plain: "0.3333333333333333", scalar: "1e3" }],
      columnMeta: meta(["n", "KSQL_NUMBER"], ["plain", "NUMBER"]),
    }).text).toBe("n,plain,scalar\r\n12500000000000000000000,0.3333333333333333,1e3\r\n");
  });

  test("keeps DATE and TIME unchanged, keeps default DATETIME UTC, and converts only DATETIME with timezone", () => {
    const input = {
      columns: ["date", "time", "dt"],
      rows: [{ date: "2026-03-08", time: "01:02:03", dt: "2026-03-08T07:00:00.123Z" }],
      columnMeta: meta(["date", "DATE"], ["time", "TIME"], ["dt", "DATETIME"]),
    };
    expect(serializeCsvExport(input).text)
      .toBe("date,time,dt\r\n2026-03-08,01:02:03,2026-03-08T07:00:00.123Z\r\n");
    expect(serializeCsvExport(input, { timezone: "America/New_York" }).text)
      .toBe("date,time,dt\r\n2026-03-08,01:02:03,2026-03-08T03:00:00.123-04:00\r\n");
  });

  test("validates timezone before duplicate headers and values", () => {
    const input = { columns: ["c", "c"], rows: [{ c: 123 }] } as unknown as CsvExportInput;
    expect(() => serializeCsvExport(input, { timezone: "Invalid/Zone" })).toThrow(expect.objectContaining({
      name: "ExportSinkInvalidTimezoneError",
    }));
  });

  test("UTF-8 has no BOM and receipt uses the actual byte length", () => {
    const result = serializeCsvExport({ columns: ["name"], rows: [{ name: "髙" }] });
    expect(Array.from(result.data.slice(0, 3))).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(result.data)).toBe(result.text);
    expect(result.receipt).toEqual({ rows: 1, columns: 1, bytes: result.data.byteLength, encoding: "utf8" });
  });

  test("passes the whole canonical text once to a supplied Shift_JIS encoder", () => {
    const encode = jest.fn((_text: string) => new Uint8Array([0x61, 0x62]));
    const encoder: ExportTextEncoder = { encoding: "sjis", encode };
    const result = serializeCsvExport({ columns: ["c"], rows: [{ c: "x" }] }, { encoding: "sjis", encoder });
    expect(encode).toHaveBeenCalledTimes(1);
    expect(encode).toHaveBeenCalledWith("c\r\nx\r\n");
    expect(result.data).toEqual(new Uint8Array([0x61, 0x62]));
    expect(result.receipt).toEqual({ rows: 1, columns: 1, bytes: 2, encoding: "sjis" });
  });

  test("requires a Shift_JIS encoder", () => {
    expect(() => serializeCsvExport({ columns: ["c"], rows: [] }, { encoding: "sjis" }))
      .toThrow(expect.objectContaining({ name: "ExportSinkEncoderRequiredError" }));
  });

  test("wraps encoder throws as ExportSinkEncodingError without returning a result", () => {
    const encoder: ExportTextEncoder = { encoding: "sjis", encode: () => { throw new Error("U+301C"); } };
    expect(() => serializeCsvExport({ columns: ["c"], rows: [{ c: "〜" }] }, { encoding: "sjis", encoder }))
      .toThrow(expect.objectContaining({
        name: "ExportSinkEncodingError",
        code: "ExportSinkEncodingError",
        message: expect.not.stringContaining("〜"),
      }));
  });

  test("rejects a non-Uint8Array encoder result", () => {
    const encoder = { encoding: "sjis", encode: () => [1, 2] } as unknown as ExportTextEncoder;
    expect(() => serializeCsvExport({ columns: ["c"], rows: [] }, { encoding: "sjis", encoder }))
      .toThrow(expect.objectContaining({ name: "ExportSinkInvalidEncoderResultError" }));
  });

  test("is deterministic for repeated serialization", () => {
    const input = { columns: ["c"], rows: [{ c: "日本語" }] };
    const first = serializeCsvExport(input);
    const second = serializeCsvExport(input);
    expect(second.text).toBe(first.text);
    expect(second.data).toEqual(first.data);
    expect(second.receipt).toEqual(first.receipt);
  });
});
