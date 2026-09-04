import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { nodeExportFileIo, writeExportFileAtomically, type ExportFileIo } from "../exportCsvFiles";

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ksql-export-files-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const bytes = (text: string) => new TextEncoder().encode(text);
const faulty = (overrides: Partial<ExportFileIo>): ExportFileIo => ({ ...nodeExportFileIo, ...overrides });

test("writes a new file and replaces an existing one leaving no temp file", () => {
  const target = join(dir, "out.csv");
  writeExportFileAtomically(target, bytes("a\r\n1\r\n"));
  expect(readFileSync(target, "utf8")).toBe("a\r\n1\r\n");
  writeExportFileAtomically(target, bytes("a\r\n2\r\n"));
  expect(readFileSync(target, "utf8")).toBe("a\r\n2\r\n");
  expect(readdirSync(dir)).toEqual(["out.csv"]);
});

test("a zero-byte write fails closed instead of looping, keeps the old file, and cleans its temp file", () => {
  const target = join(dir, "out.csv");
  writeFileSync(target, "OLD");
  const io = faulty({ write: () => 0 });
  expect(() => writeExportFileAtomically(target, bytes("NEW"), io)).toThrow(expect.objectContaining({
    name: "ExportSinkWriteError",
    message: expect.stringContaining("write returned 0 bytes"),
  }));
  expect(readFileSync(target, "utf8")).toBe("OLD");
  expect(readdirSync(dir)).toEqual(["out.csv"]);
});

test("a short write is completed by looping over the remaining bytes", () => {
  const target = join(dir, "out.csv");
  let calls = 0;
  const io = faulty({
    write: (fd, data, offset, length) => {
      calls += 1;
      return nodeExportFileIo.write(fd, data, offset, Math.min(length, 2));
    },
  });
  writeExportFileAtomically(target, bytes("abcdef"), io);
  expect(readFileSync(target, "utf8")).toBe("abcdef");
  expect(calls).toBe(3);
});

test("a temp-name collision fails without deleting the file this call did not create", () => {
  const target = join(dir, "out.csv");
  const io = faulty({ randomSuffix: () => "fixedfix" });
  const collidingTemp = join(dir, ".out.csv.fixedfix.tmp");
  writeFileSync(collidingTemp, "SOMEONE ELSE");
  expect(() => writeExportFileAtomically(target, bytes("NEW"), io)).toThrow(expect.objectContaining({
    name: "ExportSinkWriteError",
  }));
  expect(readFileSync(collidingTemp, "utf8")).toBe("SOMEONE ELSE");
  expect(existsSync(target)).toBe(false);
});

test.each([
  ["fsync", { fsync: () => { throw Object.assign(new Error("EIO: fsync failed"), { code: "EIO" }); } }],
  ["close", { close: () => { throw Object.assign(new Error("EIO: close failed"), { code: "EIO" }); } }],
  ["rename", { rename: () => { throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }); } }],
] as const)("a %s failure keeps the old file and removes the temp file", (_label, overrides) => {
  const target = join(dir, "out.csv");
  writeFileSync(target, "OLD");
  expect(() => writeExportFileAtomically(target, bytes("NEW"), faulty(overrides))).toThrow(expect.objectContaining({
    name: "ExportSinkWriteError",
  }));
  expect(readFileSync(target, "utf8")).toBe("OLD");
  expect(readdirSync(dir)).toEqual(["out.csv"]);
});
