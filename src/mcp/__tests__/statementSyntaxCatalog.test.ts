import { analyzeBatch, parseSqlStatements } from "../../core";
import { KSQL_MCP_INSTRUCTIONS } from "../index";
import {
  STATEMENT_SYNTAX_CATALOG,
  type StatementSyntaxEntry,
  type StatementSyntaxId,
} from "../statementSyntaxCatalog";

function parseExample(example: string, entry: StatementSyntaxEntry) {
  return parseSqlStatements(example, entry.capabilities);
}

describe("MCP statement syntax catalog contract", () => {
  test("catalog has every supported top-level statement family in definition order", () => {
    expect(Object.keys(STATEMENT_SYNTAX_CATALOG)).toMatchInlineSnapshot(`
      [
        "select",
        "with",
        "union",
        "insert",
        "update",
        "updateFrom",
        "upsert",
        "delete",
        "subtableDml",
        "apply",
        "validate",
        "import",
        "tempTable",
        "variables",
        "assert",
        "flowHeader",
        "flowAssert",
        "flowExit",
        "flowTempTable",
        "flowUpsert",
        "flowMerge",
        "reorder",
        "showDescribe",
        "explain",
      ]
    `);
  });

  test("every example parses to its declared AST types and batch examples analyze", () => {
    const entries = Object.entries(STATEMENT_SYNTAX_CATALOG) as [StatementSyntaxId, StatementSyntaxEntry][];
    for (const [id, entry] of entries) {
      expect(entry.expectedTypes).toHaveLength(entry.examples.length);
      entry.examples.forEach((example, index) => {
        const statements = parseExample(example, entry);
        expect(statements.map((statement) => statement.type)).toEqual(entry.expectedTypes[index]);
        if (entry.batch) expect(() => analyzeBatch(statements)).not.toThrow();
      });
      if (id === "import") expect(entry.capabilities).toEqual({ import: true });
    }
  });

  test("batch-only control tails are rejected as single statements", () => {
    for (const sql of [
      "INSERT INTO APP1 (code) VALUES ('A') ON ERROR SKIP INTO #err",
      "INSERT INTO APP1 (code) VALUES ('A') VALIDATE ONLY INTO #err",
      "VALIDATE APP1 INTO #err",
    ]) {
      expect(() => analyzeBatch(parseSqlStatements(sql))).toThrow(/requires a batch/i);
    }
  });

  test("APPLY rejects CHECK and ON ERROR SKIP combinations", () => {
    const prefix = "UPDATE APP1 SET status = 'done' WHERE $id = 1 APPLY details (REMOVE ALL ROWS)";
    expect(() => parseSqlStatements(`${prefix} CHECK WHEN status = '' THEN 'required'`)).toThrow();
    expect(() => parseSqlStatements(`${prefix} ON ERROR SKIP INTO #err`)).toThrow();
  });

  test("instructions contain each template exactly once and preserve catalog order", () => {
    let previous = -1;
    for (const entry of Object.values(STATEMENT_SYNTAX_CATALOG) as StatementSyntaxEntry[]) {
      const first = KSQL_MCP_INSTRUCTIONS.indexOf(entry.template);
      expect(first).toBeGreaterThan(previous);
      expect(KSQL_MCP_INSTRUCTIONS.indexOf(entry.template, first + entry.template.length)).toBe(-1);
      previous = first;
    }
  });

  test("high-risk examples keep the documented mandatory syntax", () => {
    const upsertExamples = STATEMENT_SYNTAX_CATALOG.upsert.examples.join("\n");
    expect(upsertExamples).toContain("ON DUPLICATE");

    const updateFromExamples = STATEMENT_SYNTAX_CATALOG.updateFrom.examples.join("\n");
    expect(updateFromExamples).toMatch(/FROM\s+#\w+\s+(?:AS\s+)?\w+/i);
    expect(updateFromExamples).toMatch(/SET\s+\w+\s*=\s*\w+\.\w+/i);
    expect(updateFromExamples).toMatch(/APP\d+\.\w+\s*=\s*\w+\.\w+/i);

    expect(STATEMENT_SYNTAX_CATALOG.apply.examples).toHaveLength(3);
    for (const example of STATEMENT_SYNTAX_CATALOG.apply.examples) {
      expect(example).toContain("VALIDATE ONLY");
    }

    for (const id of [
      "flowHeader", "flowAssert", "flowExit", "flowTempTable", "flowUpsert", "flowMerge",
    ] as const) {
      const entry = STATEMENT_SYNTAX_CATALOG[id];
      expect(entry.template).toContain("-- @ksql dialect: 1 の宣言が必要");
      for (const example of entry.examples) {
        expect(example).toContain("-- @ksql dialect: 1");
      }
    }
  });
});
