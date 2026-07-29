import { ReadBuffer } from "@modelcontextprotocol/server";
import { IMPORT_MAX_BYTES } from "../../import/sourceLoader";
import {
  MCP_IMPORT_MAX_SOURCES,
  MCP_STDIO_MAX_BUFFER_BYTES,
  MCP_STDIO_REQUIRED_BUFFER_BYTES,
} from "../stdioLimits";

const MEBIBYTE = 1024 * 1024;

describe("B99 MCP stdio buffer contract", () => {
  test("covers the declared 10 MiB x 16 source limit after base64 expansion", () => {
    expect(MCP_IMPORT_MAX_SOURCES).toBe(16);
    expect(MCP_STDIO_REQUIRED_BUFFER_BYTES).toBe(
      Math.ceil(IMPORT_MAX_BYTES * MCP_IMPORT_MAX_SOURCES * 4 / 3)
    );
    expect(MCP_STDIO_MAX_BUFFER_BYTES).toBe(256 * MEBIBYTE);
    expect(MCP_STDIO_MAX_BUFFER_BYTES).toBeGreaterThanOrEqual(MCP_STDIO_REQUIRED_BUFFER_BYTES);
  });

  test("covers one maximum text source and one maximum binary source encoded as base64", () => {
    const textRequestBytes = Buffer.byteLength(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "ksql_validate",
        arguments: { sql: "IMPORT INTO APP1 (x) FROM CSV src", importSources: [{ name: "src", text: "x".repeat(IMPORT_MAX_BYTES) }] },
      },
    }) + "\n");
    const base64Length = Math.ceil(IMPORT_MAX_BYTES / 3) * 4;
    const base64RequestBytes = Buffer.byteLength(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "ksql_validate",
        arguments: { sql: "IMPORT INTO APP1 (x) FROM CSV src", importSources: [{ name: "src", base64: "A".repeat(base64Length) }] },
      },
    }) + "\n");

    expect(textRequestBytes).toBeGreaterThanOrEqual(10 * MEBIBYTE);
    expect(base64RequestBytes).toBeGreaterThanOrEqual(Math.ceil(IMPORT_MAX_BYTES * 4 / 3));
    expect(textRequestBytes).toBeLessThan(MCP_STDIO_MAX_BUFFER_BYTES);
    expect(base64RequestBytes).toBeLessThan(MCP_STDIO_MAX_BUFFER_BYTES);
  });

  test("keeps sixteen maximum base64 sources plus the JSON-RPC envelope below 256 MiB", () => {
    const base64Length = Math.ceil(IMPORT_MAX_BYTES / 3) * 4;
    const emptyEnvelopeBytes = Buffer.byteLength(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "ksql_validate",
        arguments: { sql: "IMPORT INTO APP1 (x) FROM CSV src", importSources: [] },
      },
    }) + "\n");
    const perSourceEnvelopeBytes = Buffer.byteLength(JSON.stringify({
      name: "source-15",
      base64: "",
      encoding: "utf8",
    })) + 1;
    const nearLimitRequestBytes = emptyEnvelopeBytes
      + MCP_IMPORT_MAX_SOURCES * (base64Length + perSourceEnvelopeBytes);

    expect(nearLimitRequestBytes).toBeGreaterThanOrEqual(MCP_STDIO_REQUIRED_BUFFER_BYTES);
    expect(nearLimitRequestBytes).toBeLessThan(MCP_STDIO_MAX_BUFFER_BYTES);
  });

  test("reports a readable diagnostic when the configured transport buffer is exceeded", () => {
    const buffer = new ReadBuffer({ maxBufferSize: 32 });
    expect(() => buffer.append(Buffer.alloc(33))).toThrow(
      "ReadBuffer exceeded maximum size of 32 bytes"
    );
  });
});
