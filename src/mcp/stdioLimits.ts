import { IMPORT_MAX_BYTES } from "../import/sourceLoader";

export const MCP_IMPORT_MAX_SOURCES = 16;
export const MCP_STDIO_REQUIRED_BUFFER_BYTES = Math.ceil(
  IMPORT_MAX_BYTES * MCP_IMPORT_MAX_SOURCES * 4 / 3
);
export const MCP_STDIO_MAX_BUFFER_BYTES = 256 * 1024 * 1024;
