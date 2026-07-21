import * as fs from "node:fs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildDocsResourceMap } from "../docsResourceBuilder.cjs";
import { KSQL_DOCS } from "../docsResources";
import { createServer } from "../index";

const languageSource = readFileSync(resolve("docs/ksql_language_reference.md"), "utf8");
const recipesSource = readFileSync(resolve("docs/ksql_batch_recipes.md"), "utf8");

describe("B50 embedded documentation resources", () => {
  test("splits the two source documents into the required stable sections", () => {
    const docs = buildDocsResourceMap(languageSource, recipesSource);

    expect(Object.keys(docs.languageReference.sections)).toHaveLength(26);
    expect(Object.keys(docs.recipes.sections)).toEqual(
      Array.from({ length: 12 }, (_, index) => `r${index + 1}`)
    );
    expect(docs.languageReference.sections["02-select"].text).toContain("## 2. SELECT");
    expect(docs.languageReference.sections["10-order-by"].text).toContain("## 10.1 ウィンドウ関数");
    expect(docs.languageReference.sections["17-upsert"].text).toContain("## 17.1 VALIDATE ONLY");
    expect(docs.languageReference.sections["22-limitations"].text).toContain("## 22. 制限事項");
    expect(docs.recipes.sections.r6.text).toContain("ON ERROR SKIP");

    for (const [key, section] of Object.entries(docs.languageReference.sections)) {
      expect(section.uri).toBe(`ksql://language-reference/${key}`);
      expect(docs.languageReference.index).toContain(section.uri);
    }
    for (const [key, section] of Object.entries(docs.recipes.sections)) {
      expect(section.uri).toBe(`ksql://recipes/${key}`);
      expect(docs.recipes.index).toContain(section.uri);
    }
    expect(docs.recipes.index).toContain("## 設計原則（リラン可能バッチ）");
  });

  test.each([
    ["empty language document", "", recipesSource, /empty/i],
    ["language H2 parse failure", "# title\n\ntext", recipesSource, /H2|section/i],
    ["duplicate language key", "# x\n\n## 1. A\nbody\n\n## 1. B\nbody", recipesSource, /duplicate section key/i],
    ["empty language chapter", "# x\n\n## 1. A\n\n## 2. B\nbody", recipesSource, /empty/i],
    ["missing required language chapters", "# x\n\n## 1. A\nbody", recipesSource, /missing/i],
    ["empty recipe document", languageSource, "", /empty/i],
    ["missing required recipes", languageSource, "# x\n\n## R1. A\nbody", /missing/i],
  ])("rejects %s", (_label, language, recipes, expected) => {
    expect(() => buildDocsResourceMap(language, recipes)).toThrow(expected);
  });

  test("non-bundle access builds the same immutable map from repository docs", () => {
    expect(KSQL_DOCS.languageReference.sections["02-select"].heading).toBe("2. SELECT");
    expect(KSQL_DOCS.recipes.sections.r12.heading).toContain("cli-kintone");
    expect(Object.isFrozen(KSQL_DOCS)).toBe(true);
    expect(Object.isFrozen(KSQL_DOCS.languageReference.sections)).toBe(true);
  });

  test("lists and reads indexes/templates and rejects every non-allowlisted key without I/O", async () => {
    const server = createServer({ help: false });
    const client = new Client({ name: "docs-resource-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const fetchMock = jest.spyOn(globalThis, "fetch");
    const fsModule = require("node:fs") as typeof fs;
    const readFileMock = jest.spyOn(fsModule, "readFileSync");
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const listed = await client.listResources();
      expect(listed.resources.map(({ uri }) => uri)).toEqual([
        "ksql://language-reference",
        "ksql://recipes",
      ]);
      expect(listed.resources.every(({ mimeType }) => mimeType === "text/markdown")).toBe(true);

      const templates = await client.listResourceTemplates();
      expect(templates.resourceTemplates.map(({ uriTemplate }) => uriTemplate)).toEqual([
        "ksql://language-reference/{section}",
        "ksql://recipes/{recipe}",
      ]);

      const index = await client.readResource({ uri: "ksql://language-reference" });
      expect(index.contents[0]).toMatchObject({
        uri: "ksql://language-reference",
        mimeType: "text/markdown",
      });
      expect("text" in index.contents[0] && index.contents[0].text).toContain("ksql://language-reference/02-select");

      for (const [uri, heading] of [
        ["ksql://language-reference/02-select", "## 2. SELECT"],
        ["ksql://language-reference/17-upsert", "## 17.1 VALIDATE ONLY"],
        ["ksql://language-reference/22-limitations", "## 22. 制限事項"],
        ["ksql://recipes/r6", "## R6."],
      ]) {
        const result = await client.readResource({ uri });
        expect(result.contents[0]).toMatchObject({ uri, mimeType: "text/markdown" });
        expect("text" in result.contents[0] && result.contents[0].text).toContain(heading);
      }

      for (const uri of [
        "ksql://language-reference/unknown",
        "ksql://language-reference/..",
        "ksql://language-reference/https%3A%2F%2Fevil.example",
        "ksql://recipes/not-a-recipe",
      ]) {
        await expect(client.readResource({ uri })).rejects.toThrow();
      }
      expect(fetchMock).not.toHaveBeenCalled();
      expect(readFileMock.mock.calls.filter(([path]) =>
        /[\\/]docs[\\/]ksql_(?:language_reference|batch_recipes)\.md$/.test(String(path))
      )).toEqual([]);
    } finally {
      jest.restoreAllMocks();
      await client.close();
      await server.close();
    }
  });
});
