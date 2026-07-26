import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PARSER_IDENT_RELATIVE_DATE_FUNCTIONS } from "../../parser/parser";
import { KSQL_MCP_INSTRUCTIONS } from "../index";
import {
  KSQL_DOCS,
  KSQL_FUNCTION_CATALOG,
  resolveKsqlDocsSection,
} from "../docsResources";
import { KSQL_FUNCTION_SQL_FIXTURES } from "./fixtures/ksqlFunctionCatalogFixtures";

const languageSource = readFileSync(resolve("docs/ksql_language_reference.md"), "utf8");
const relativeDateFunctions = [...PARSER_IDENT_RELATIVE_DATE_FUNCTIONS];

describe("B67 Step 7 relative-date catalog and documentation", () => {
  test("catalog, parser, fixtures, and generated instructions contain the same 12 spellings", () => {
    expect(relativeDateFunctions).toHaveLength(12);
    for (const name of relativeDateFunctions) {
      expect(KSQL_FUNCTION_CATALOG.contextual).toContain(name);
      expect(KSQL_FUNCTION_SQL_FIXTURES).toHaveProperty(name);
      expect(KSQL_MCP_INSTRUCTIONS).toContain(name);
    }
  });

  test("instructions stay a generated catalog pointer instead of duplicating server-only details", () => {
    expect(KSQL_MCP_INSTRUCTIONS).toContain("Use ksql_docs for arguments and constraints.");
    expect(KSQL_MCP_INSTRUCTIONS).not.toContain("WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN");
    expect(KSQL_MCP_INSTRUCTIONS).not.toContain("client fallback");
  });

  test("repository language reference documents the complete Phase1 contract", () => {
    for (const name of relativeDateFunctions) expect(languageSource).toContain(name);
    for (const key of [
      "DATE", "DATETIME", "CREATED_TIME", "UPDATED_TIME",
      "server-only", "exact pushdown", "client fallback", "BETWEEN",
      "soft keyword", "バッククォート",
      "WHERE_RELATIVE_DATE_ARGUMENT_INVALID",
      "WHERE_RELATIVE_DATE_FIELD_TYPE_UNSUPPORTED",
      "WHERE_RELATIVE_DATE_OPERATOR_UNSUPPORTED",
      "WHERE_RELATIVE_DATE_CONTEXT_UNSUPPORTED",
      "WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN",
    ]) {
      expect(languageSource).toContain(key);
    }
    expect(languageSource).toContain("`=` / `!=` / `<` / `<=` / `>` / `>=`");
  });

  test("non-bundle and ksql_docs embedded sections expose the same B67 explanation", () => {
    const functionSection = KSQL_DOCS.languageReference.sections["05-string-number-functions"].text;
    const whereSection = KSQL_DOCS.languageReference.sections["06-where"].text;
    expect(resolveKsqlDocsSection("language-reference/05-string-number-functions"))
      .toBe(functionSection);
    expect(resolveKsqlDocsSection("language-reference/06-where")).toBe(whereSection);
    for (const text of [functionSection, whereSection]) {
      expect(text).toContain("相対日付関数");
      expect(text).toContain("server-only");
      expect(text).toContain("exact pushdown");
    }
    expect(functionSection).toContain("WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN");
    expect(functionSection).toContain("client fallback");
  });

  test("B75 CTE/temp exact-pushdown contract is embedded into ksql_docs without a second source", () => {
    const functionSection = resolveKsqlDocsSection(
      "language-reference/05-string-number-functions"
    );
    const whereSection = resolveKsqlDocsSection("language-reference/06-where");
    const cteSection = resolveKsqlDocsSection("language-reference/13-with-cte");
    const batchSection = resolveKsqlDocsSection("language-reference/25-batch-temp-tables");

    for (const text of [functionSection, whereSection]) {
      expect(text).toContain("実体化 CTE");
      expect(text).toContain("一時テーブル source");
      expect(text).toContain("WHERE` 全体");
      expect(text).toContain("UNION");
      expect(text).toContain("入れ子 SELECT");
    }
    expect(functionSection).toContain("CTE・一時テーブルに残る非対称");
    expect(functionSection).toContain("トップレベル SELECT として書いてください");
    expect(functionSection).toContain("tempTableMaxRows");
    expect(cteSection).toContain("### CTE と相対日付");
    expect(batchSection).toContain("日付リテラルと相対日付で扱いは同一");

    for (const text of [languageSource, functionSection, whereSection]) {
      expect(text).not.toContain("一時テーブル・実体化 CTE・派生表");
    }
  });
});
