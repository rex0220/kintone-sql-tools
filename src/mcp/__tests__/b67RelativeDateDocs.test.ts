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

// B103: 作業ツリーの行末に依存させない（検査対象は文書の内容）。
const languageSource = readFileSync(resolve("docs/ksql_language_reference.md"), "utf8")
  .replace(/\r\n/g, "\n");
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
    expect(KSQL_MCP_INSTRUCTIONS).toContain(
      "WHERE server-only/fail-closed"
    );
    expect(KSQL_MCP_INSTRUCTIONS).toContain(
      "INNER JOIN direct-APP exact pushdown supported"
    );
    expect(KSQL_MCP_INSTRUCTIONS).toContain(
      "local LOGINUSER is empty on all surfaces"
    );
    expect(KSQL_MCP_INSTRUCTIONS).not.toContain(
      "LOGINUSER resolves to an empty string in Node/MCP"
    );
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

  test("B77/B78 migration, function constraints, and KORDER correction are embedded in ksql_docs", () => {
    const functionSection = resolveKsqlDocsSection(
      "language-reference/05-string-number-functions"
    );
    const whereSection = resolveKsqlDocsSection("language-reference/06-where");

    for (const text of [functionSection, whereSection]) {
      expect(text).toContain("作成者 in (LOGINUSER())");
      expect(text).toContain("日付 = TODAY()");
      expect(text).toContain("server prefilter");
      expect(text).toContain("whole-WHERE exact");
      expect(text).toContain("KORDER BY");
      expect(text).toContain("FULL_SCAN_EXACT");
    }
    // v3.25.0 の移行告知（"minor" / "破壊的" の文言）は v3.54.4 で言語リファレンスから
    // 削除した（29 版前の案内で、リファレンスに置く段階を過ぎたため。移行案内は
    // CHANGELOG と GitHub Releases にある）。拒否される代表例そのものは現行仕様として
    // §6 に残っているので、そちらは引き続き固定する。
    for (const text of [languageSource, whereSection]) {
      expect(text).toContain("作成者 = 'taro'");
      expect(text).toContain("日付 = NOW()");
      expect(text).toContain("$id >= TODAY()");
    }
    expect(functionSection).toContain("グループ選択には使用できません");
    expect(functionSection).toContain("`DATE` には使用不可");
    expect(functionSection).toContain("CURRENT_DATE()");
    expect(functionSection).toContain("実行環境のローカルタイムゾーン");
    expect(functionSection).toContain("WHERE_KINTONE_FUNCTION_REQUIRES_EXACT_PUSHDOWN");
    expect(functionSection).not.toContain("`KORDER BY`（native・Cursor とも）");
  });

  test("B76 Phase B fifth allow-form and rejection boundary are embedded in MCP docs", () => {
    const functionSection = resolveKsqlDocsSection(
      "language-reference/05-string-number-functions"
    );
    const whereSection = resolveKsqlDocsSection("language-reference/06-where");
    const joinSection = resolveKsqlDocsSection("language-reference/07-join");

    for (const text of [languageSource, functionSection, whereSection, joinSection]) {
      expect(text).toContain("第5-W");
      expect(text).toContain("第5-L");
      expect(text).toContain("cross-alias `OR`");
      expect(text).toContain("LEFT");
      expect(text).toContain("RIGHT");
    }
    expect(functionSection).toContain("使える SELECT の形は次の4つ");
    expect(functionSection).toContain("複数 alias");
    expect(functionSection).toContain("GROUP_SELECT");
    expect(joinSection).toContain("plan status: rejected");
    expect(joinSection).toContain("client evaluation: forbidden");
    expect(joinSection).not.toContain("JOIN では使用できません");
  });
});
