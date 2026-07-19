import { Lexer } from "../../lexer/lexer";
import { Parser } from "../parser";

const parse = (sql: string, enabled = true) => new Parser(new Lexer(sql).tokenize(), { import: enabled }).parse();

describe("B39 IMPORT parser gate", () => {
  test("is off by default", () => expect(() => parse("IMPORT INTO APP1 (a) FROM CSV src", false)).toThrow("capability is disabled"));
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
  test("rejects path literals and HEADER COLUMNS", () => {
    expect(() => parse("IMPORT INTO APP1 (a) FROM CSV 'x.csv'")).toThrow();
    expect(() => parse("IMPORT INTO APP1 (a) FROM CSV src COLUMNS(a)")).toThrow("NO HEADER");
  });
});
