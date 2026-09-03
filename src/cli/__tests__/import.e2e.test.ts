import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const postRecords = jest.fn(async (params: { records: unknown[] }) => ({ ids: params.records.map((_r, i) => String(i + 1)) }));

jest.mock("../nodeKintoneClient", () => ({
  createNodeKintoneClient: () => ({
    getRecords: jest.fn(async () => ({ records: [] })),
    openCursor: jest.fn(async () => { throw new Error("unexpected cursor"); }),
    postRecords,
    putRecords: jest.fn(async () => undefined),
    deleteRecords: jest.fn(async () => undefined),
    getApps: jest.fn(async () => []),
    getFields: jest.fn(async () => [
      { code: "code", label: "code", fieldType: "SINGLE_LINE_TEXT" },
      { code: "name", label: "name", fieldType: "SINGLE_LINE_TEXT" },
    ]),
    getProcessStatuses: jest.fn(async () => ({ enable: false, states: [] })),
    getNumberPrecision: jest.fn(async () => ({ digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" })),
  }),
}));

import { runWithArgv } from "../index";

test("CLI --import-csv <name>=<path> supplies a named source to IMPORT", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ksql-import-e2e-"));
  const csvPath = join(dir, "people.csv");
  writeFileSync(csvPath, "code,name\nA,Alice\nB,Bob", "utf8");
  const stdout = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    const code = await runWithArgv([
      "--base-url", "https://example.cybozu.com", "--auth", "token", "--token", "dummy", "--app", "100",
      "--allow-dml", "--yes", "--format", "json", "--import-csv", `people=${csvPath}`,
      "-e", "IMPORT INTO APP100 (code,name) FROM CSV people",
    ]);
    expect(code).toBe(0);
    expect(postRecords).toHaveBeenCalledWith(expect.objectContaining({
      records: [
        { code: { value: "A" }, name: { value: "Alice" } },
        { code: { value: "B" }, name: { value: "Bob" } },
      ],
    }));
  } finally {
    stdout.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI --import-json <name>=<path> supplies a named source to IMPORT", async () => {
  postRecords.mockClear();
  const dir = mkdtempSync(join(tmpdir(), "ksql-import-json-e2e-"));
  const jsonPath = join(dir, "people.json");
  writeFileSync(jsonPath, '[{"name":"Alice","code":"A"}]', "utf8");
  const stdout = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    const code = await runWithArgv([
      "--base-url", "https://example.cybozu.com", "--auth", "token", "--token", "dummy", "--app", "100",
      "--allow-dml", "--yes", "--format", "json", "--import-json", `people=${jsonPath}`,
      "-e", "IMPORT INTO APP100 (code,name) FROM JSON people",
    ]);
    expect(code).toBe(0);
    expect(postRecords).toHaveBeenCalledWith(expect.objectContaining({
      records: [{ code: { value: "A" }, name: { value: "Alice" } }],
    }));
  } finally {
    stdout.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI import source fs failures retain the path and OS cause", async () => {
  postRecords.mockClear();
  const dir = mkdtempSync(join(tmpdir(), "ksql-import-missing-"));
  const missingPath = join(dir, "missing.csv");
  const stderr = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const code = await runWithArgv([
      "--base-url", "https://example.cybozu.com", "--auth", "token", "--token", "dummy", "--app", "100",
      "--allow-dml", "--yes", "--import-csv", `people=${missingPath}`,
      "-e", "IMPORT INTO APP100 (code,name) FROM CSV people",
    ]);
    const output = stderr.mock.calls.flat().join("");
    expect(code).toBe(1);
    expect(output).toContain("ImportSourceReadError");
    expect(output).toContain(missingPath);
    expect(output).toContain("ENOENT");
    expect(postRecords).not.toHaveBeenCalled();
  } finally {
    stderr.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI rejects a directory import source with its path", async () => {
  postRecords.mockClear();
  const dir = mkdtempSync(join(tmpdir(), "ksql-import-directory-"));
  const stderr = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const code = await runWithArgv([
      "--base-url", "https://example.cybozu.com", "--auth", "token", "--token", "dummy", "--app", "100",
      "--allow-dml", "--yes", "--import-json", `people=${dir}`,
      "-e", "IMPORT INTO APP100 (code,name) FROM JSON people",
    ]);
    const output = stderr.mock.calls.flat().join("");
    expect(code).toBe(1);
    expect(output).toContain("ImportSourceNotRegularFileError");
    expect(output).toContain(dir);
    expect(postRecords).not.toHaveBeenCalled();
  } finally {
    stderr.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});
