import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildOutput, parseTokenFile } from "../index";

describe("cli integration helpers", () => {
  test("parseTokenFile normalizes APP keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "ksql-cli-test-"));
    const p = join(dir, "tokens.json");
    writeFileSync(p, JSON.stringify({ APP100: "t100", "101": "t101" }), "utf-8");

    const map = parseTokenFile(p);
    expect(map.APP100).toBe("t100");
    expect(map.APP101).toBe("t101");
  });

  test("buildOutput applies display options for table/csv", () => {
    const result = {
      type: "SELECT" as const,
      columns: ["担当者", "タグ"],
      rowCount: 1,
      rows: [
        {
          担当者: JSON.stringify({ code: "u001", name: "田中" }),
          タグ: JSON.stringify(["A", "B"]),
        },
      ],
      warnings: [],
    };

    const table = buildOutput(result, "table", false, false, {
      userFormat: "name",
      arrayFormat: "join",
      tableFormat: "full",
      dateFormat: "full",
      attachmentFormat: "full",
    });
    expect(table).toContain("担当者\tタグ");
    expect(table).toContain("田中\tA, B");

    const csv = buildOutput(result, "csv", false, false, {
      userFormat: "name",
      arrayFormat: "join",
      tableFormat: "full",
      dateFormat: "full",
      attachmentFormat: "full",
    });
    expect(csv).toContain("担当者,タグ");
    expect(csv).toContain("田中,\"A, B\"");
  });
});
