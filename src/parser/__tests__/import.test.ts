import { Lexer } from "../../lexer/lexer";
import { Parser } from "../parser";

const parse = (sql: string, enabled = true) => new Parser(new Lexer(sql).tokenize(), { import: enabled }).parse();

describe("B39 IMPORT parser gate", () => {
  test("is off by default", () => {
    expect(() => parse("IMPORT INTO APP1 (a) FROM CSV src", false)).toThrow("capability is disabled");
    expect(() => parse("IMPORT INTO APP1 (a) FROM JSON src", false)).toThrow("capability is disabled");
  });
  test("parses CSV options, projection, UPSERT, CHECK and disposition", () => {
    expect(parse("IMPORT INTO APP1 (a,b) FROM CSV src ENCODING SJIS NO HEADER COLUMNS(x,y) SELECT x, CAST(y AS NUMBER) ON DUPLICATE (a) CHECK WHEN y = '' THEN 'bad' ON ERROR SKIP INTO #err REJECT LIMIT 2")).toMatchObject({
      type: "IMPORT", appId: 1, fields: ["a", "b"],
      source: { kind: "CSV", sourceName: "src", encoding: "sjis", hasHeader: false, columns: ["x", "y"] },
      keyFields: ["a"], onErrorSkip: true, errorTable: "#err", rejectLimit: 2,
    });
  });
  test("EXPLAIN dispatch and soft keyword field compatibility", () => {
    expect(parse("EXPLAIN IMPORT INTO APP1 (a) FROM CSV src")).toMatchObject({ type: "EXPLAIN", query: { type: "IMPORT" } });
    expect(parse("SELECT IMPORT, CSV, ENCODING, COLUMNS FROM APP1")).toMatchObject({ type: "SELECT" });
  });
  test("parses JSON as a soft source keyword and rejects CSV-only clauses", () => {
    expect(parse("IMPORT INTO APP1 (a,b) FROM JSON src")).toMatchObject({
      type: "IMPORT", fields: ["a", "b"], source: { kind: "JSON", sourceName: "src" },
    });
    expect(parse("SELECT JSON FROM APP1")).toMatchObject({ type: "SELECT" });
    for (const suffix of ["ENCODING SJIS", "NO HEADER", "COLUMNS(a)", "SELECT a"]) {
      expect(() => parse(`IMPORT INTO APP1 (a) FROM JSON src ${suffix}`)).toThrow(/JSON|CSV-only/);
    }
  });

  test("parses BY NAME soft keywords and enforces its Phase 3 exclusions", () => {
    expect(parse("IMPORT INTO APP1 (a,b) FROM CSV src BY NAME IGNORE UNKNOWN COLUMNS")).toMatchObject({
      source: { kind: "CSV", mappingMode: "BY_NAME", ignoreUnknownColumns: true },
    });
    expect(() => parse("IMPORT INTO APP1 (a) FROM CSV src SELECT a BY NAME")).toThrow("mutually exclusive");
    expect(() => parse("IMPORT INTO APP1 (a) FROM CSV src NO HEADER BY NAME")).toThrow("requires HEADER");
    expect(() => parse("IMPORT INTO APP1 (a) FROM JSON src BY NAME")).toThrow("CSV-only");
    expect(parse("SELECT NAME, IGNORE, UNKNOWN, COLUMNS FROM APP1")).toMatchObject({ type: "SELECT" });
  });
  test("rejects path literals and HEADER COLUMNS", () => {
    expect(() => parse("IMPORT INTO APP1 (a) FROM CSV 'x.csv'")).toThrow();
    expect(() => parse("IMPORT INTO APP1 (a) FROM CSV src COLUMNS(a)")).toThrow("NO HEADER");
  });
  test("parses pure record-number UPDATE and enforces exclusions", () => {
    expect(parse("IMPORT UPDATE INTO APP1 (a,b) FROM CSV src BY NAME MATCH RECORD NUMBER SOURCE recno")).toMatchObject({
      type: "IMPORT", writeMode: "UPDATE_RECORD_NUMBER", recordNumberSourceHeader: "recno",
      source: { kind: "CSV", mappingMode: "BY_NAME" },
    });
    expect(() => parse("IMPORT UPDATE INTO APP1 (a) FROM CSV src MATCH RECORD NUMBER SOURCE recno")).toThrow("requires BY NAME");
    expect(() => parse("IMPORT UPDATE INTO APP1 (a) FROM CSV src BY NAME")).toThrow("requires MATCH RECORD NUMBER SOURCE");
    expect(() => parse("IMPORT UPDATE INTO APP1 (a) FROM CSV src BY NAME MATCH RECORD NUMBER SOURCE recno ON DUPLICATE (a)"))
      .toThrow("mutually exclusive");
    expect(() => parse("IMPORT INTO APP1 (a) FROM CSV src BY NAME MATCH RECORD NUMBER SOURCE recno"))
      .toThrow("requires IMPORT UPDATE");
    expect(parse("SELECT MATCH, RECORD, NUMBER, SOURCE FROM APP1")).toMatchObject({ type: "SELECT" });
  });
  test("parses nested JSON targets without exposing row IDs", () => {
    expect(parse("IMPORT INTO APP1 (code, Lines(name, qty), Notes(body)) FROM JSON src ON DUPLICATE (code)")).toMatchObject({
      fields: ["code"],
      targets: [
        { kind: "FIELD", field: "code" },
        { kind: "SUBTABLE", subtableCode: "Lines", children: ["name", "qty"] },
        { kind: "SUBTABLE", subtableCode: "Notes", children: ["body"] },
      ],
    });
    expect(() => parse("IMPORT INTO APP1 (Lines(name) ROW ID SOURCE rid) FROM JSON src")).toThrow("does not accept ROW ID");
  });
  test("parses cli-kintone table replacement and fails closed without its allow-list", () => {
    expect(parse("IMPORT UPDATE INTO APP1 (code, Lines(name,qty) ROW ID SOURCE line_id) FROM CSV src BY NAME MATCH RECORD NUMBER SOURCE recno REPLACE SUBTABLES (Lines)")).toMatchObject({
      fields: ["code"], replaceSubtables: ["Lines"],
      targets: [{ kind: "FIELD" }, { kind: "SUBTABLE", subtableCode: "Lines", rowIdSourceHeader: "line_id" }],
    });
    expect(() => parse("IMPORT UPDATE INTO APP1 (Lines(name) ROW ID SOURCE rid) FROM CSV src BY NAME MATCH RECORD NUMBER SOURCE recno"))
      .toThrow("requires REPLACE SUBTABLES");
    expect(() => parse("IMPORT UPDATE INTO APP1 (Lines(name) ROW ID SOURCE rid) FROM CSV src BY NAME MATCH RECORD NUMBER SOURCE recno REPLACE SUBTABLES (Other)"))
      .toThrow(/non-replaced|not declared/);
    expect(() => parse("IMPORT INTO APP1 (Lines(name) ROW ID SOURCE rid) FROM CSV src BY NAME REPLACE SUBTABLES (Lines)"))
      .toThrow("requires IMPORT UPDATE");
  });
});
