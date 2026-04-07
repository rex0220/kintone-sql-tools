import { readFileSync } from "fs";
import { join } from "path";
import { HELP_TEXT } from "../index";

function normalizeText(v: string): string {
  return v.replace(/\r\n/g, "\n").trim();
}

function extractHelpSyncBlock(readme: string): string {
  const begin = "<!-- BEGIN_HELP_SYNC -->";
  const end = "<!-- END_HELP_SYNC -->";
  const startIdx = readme.indexOf(begin);
  const endIdx = readme.indexOf(end);
  if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) {
    throw new Error("README help sync markers are missing.");
  }
  const region = readme.slice(startIdx + begin.length, endIdx).trim();
  const fenceStart = region.indexOf("```text");
  const fenceEnd = region.lastIndexOf("```");
  if (fenceStart < 0 || fenceEnd <= fenceStart) {
    throw new Error("README help sync block must be fenced with ```text.");
  }
  return region.slice(fenceStart + "```text".length, fenceEnd).trim();
}

test("README help sync block matches CLI --help text", () => {
  const readmePath = join(process.cwd(), "README.md");
  const readme = readFileSync(readmePath, "utf-8");
  const readmeHelp = extractHelpSyncBlock(readme);
  expect(normalizeText(readmeHelp)).toBe(normalizeText(HELP_TEXT));
});
