import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  KSQL_DOCS,
  KSQL_DOCS_INDEX,
  KSQL_DOCS_SECTION_KEYS,
} from "../docsResources";
import { createServer } from "../index";
import { toErrorPayload, toToolResult } from "../tools";

function textOf(result: unknown): string {
  const content = (result as { content?: unknown[] }).content ?? [];
  const item = content[0] as { type?: string; text?: string } | undefined;
  expect(item?.type).toBe("text");
  return item?.text ?? "";
}

function expectedText(key: string): string {
  if (key === "language-reference") return KSQL_DOCS.languageReference.index;
  if (key === "recipes") return KSQL_DOCS.recipes.index;
  if (key.startsWith("language-reference/")) {
    return KSQL_DOCS.languageReference.sections[key.slice("language-reference/".length)].text;
  }
  return KSQL_DOCS.recipes.sections[key.slice("recipes/".length)].text;
}

describe("B55 ksql_docs MCP tool", () => {
  test("publishes strict read-only metadata and serves all fixed keys without config or HTTP", async () => {
    const server = createServer({
      help: false,
      configPath: join(tmpdir(), `missing-ksql-config-${process.pid}.json`),
    });
    const client = new Client({ name: "ksql-docs-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const fetchMock = jest.spyOn(globalThis, "fetch");
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const listed = await client.listTools();
      const docs = listed.tools.find((tool) => tool.name === "ksql_docs");
      expect(docs).toMatchObject({
        name: "ksql_docs",
        title: "Read kSQL documentation",
        annotations: { readOnlyHint: true, openWorldHint: false },
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { section: { type: "string", maxLength: 128 } },
        },
      });
      expect(docs?.description).toContain("resources are unavailable");
      expect(docs).not.toHaveProperty("outputSchema");

      const index = await client.callTool({ name: "ksql_docs", arguments: {} });
      expect(textOf(index)).toBe(KSQL_DOCS_INDEX);
      expect(index.content).toHaveLength(1);
      expect(index).not.toHaveProperty("structuredContent");
      expect(index.isError).not.toBe(true);

      for (const key of KSQL_DOCS_SECTION_KEYS) {
        const result = await client.callTool({ name: "ksql_docs", arguments: { section: key } });
        expect(textOf(result)).toBe(expectedText(key));
        expect(result.content).toHaveLength(1);
        expect(result).not.toHaveProperty("structuredContent");
        expect(result.isError).not.toBe(true);

        const resource = await client.readResource({ uri: `ksql://${key}` });
        const resourceItem = resource.contents[0];
        expect("text" in resourceItem ? resourceItem.text : undefined).toBe(textOf(result));
      }

      for (const [input, normalized] of [
        [" ksql://language-reference/02-select ", "language-reference/02-select"],
        [" recipes/r3 ", "recipes/r3"],
      ] as const) {
        const result = await client.callTool({ name: "ksql_docs", arguments: { section: input } });
        expect(textOf(result)).toBe(expectedText(normalized));
      }
      expect(fetchMock).not.toHaveBeenCalled();

      for (const section of ["language-reference/99-x", "STDDEV", "", "   "]) {
        const result = await client.callTool({ name: "ksql_docs", arguments: { section } });
        const normalized = section.trim();
        const error = new Error(
          `ArgumentError: Unknown ksql_docs section key: ${normalized}. `
          + "Valid keys: language-reference, language-reference/<key>, recipes, recipes/r1..r13. "
          + "Call ksql_docs without arguments for the full key list."
        );
        const expected = toToolResult(toErrorPayload(error), true);
        expect(result.isError).toBe(true);
        expect(textOf(result)).toBe(textOf(expected));
        expect(result.structuredContent).toEqual(expected.structuredContent);
      }
      expect(fetchMock).not.toHaveBeenCalled();

      for (const args of [
        { section: "recipes", extra: true },
        { section: 1 },
        { section: "x".repeat(129) },
      ]) {
        const result = await client.callTool({ name: "ksql_docs", arguments: args });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("Invalid arguments");
        expect(textOf(result)).toContain("-32602");
      }
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      jest.restoreAllMocks();
      await client.close();
      await server.close();
    }
  });
});
