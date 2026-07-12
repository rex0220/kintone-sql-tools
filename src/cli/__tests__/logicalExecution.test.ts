import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resetGlobalRequestGate } from "../../api/requestGate";
import { runWithArgv } from "../index";

describe("CLI logical app execution", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    resetGlobalRequestGate();
  });

  test("2 logical app JOIN を実HTTP直前までdriveし各 physical app/token を使う", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ksql-cli-logical-exec-"));
    const configPath = join(dir, "ksql.config.json");
    writeFileSync(configPath, JSON.stringify({
      defaultProfile: "prod",
      profiles: {
        prod: {
          baseUrl: "https://example.cybozu.com",
          logicalApps: { ORDERS: 1234, CUSTOMERS: 1235 },
          tokenMap: {
            APP1234: "physical-1234-token",
            APP1235: "physical-1235-token",
          },
        },
      },
    }));
    const fetchMock = jest.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      const body = url.includes("/app/form/fields.json")
        ? { properties: { "$id": { code: "$id", label: "Record ID", type: "__ID__" } } }
        : { records: [{ "$id": { value: "1" } }] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const stdout = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const code = await runWithArgv([
        "--config", configPath,
        "--format", "json",
        "-e", "SELECT o.$id FROM LAPP_ORDERS o JOIN LAPP_CUSTOMERS c ON o.$id = c.$id LIMIT 1",
      ]);
      expect(code).toBe(0);
      expect(stdout).toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalled();
      const routed = fetchMock.mock.calls.map(([url, init]) => ({
        url: String(url),
        token: new Headers(init?.headers).get("X-Cybozu-API-Token"),
      }));
      expect(routed.some((call) => call.url.includes("app=1234") && call.token === "physical-1234-token")).toBe(true);
      expect(routed.some((call) => call.url.includes("app=1235") && call.token === "physical-1235-token")).toBe(true);
      expect(routed.some((call) => call.url.includes("app=1234") && call.token === "physical-1235-token")).toBe(false);
      expect(routed.some((call) => call.url.includes("app=1235") && call.token === "physical-1234-token")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each([
    // SELECT のソース app: 行は論理名 + profile（仕様 §9.2 の app 参照）
    ["SELECT", "SELECT $id FROM LAPP_ORDERS LIMIT 1", "app:", "LAPP_ORDERS@prod"],
    // DML の書き込み先 target: 行は論理名 -> 物理ID@profile を併記（仕様 §9.2）
    ["UPSERT", "UPSERT INTO LAPP_ORDERS (顧客コード, 名前) VALUES ('C001','b') ON DUPLICATE (顧客コード)", "target:", "LAPP_ORDERS -> APP1234@prod"],
    ["UPDATE", "UPDATE LAPP_ORDERS SET 名前='x' WHERE $id=1", "target:", "LAPP_ORDERS -> APP1234@prod"],
  ])("dry-run %s プランは内部 mapped ID を露出せず仕様 §9.2 の参照へ復元する", async (_type, sql, label, expected) => {
    const dir = mkdtempSync(join(tmpdir(), "ksql-cli-logical-plan-"));
    const configPath = join(dir, "ksql.config.json");
    writeFileSync(configPath, JSON.stringify({
      defaultProfile: "prod",
      profiles: {
        prod: {
          baseUrl: "https://example.cybozu.com",
          logicalApps: { ORDERS: 1234 },
          tokenMap: { APP1234: "physical-1234-token" },
        },
      },
    }));
    const out: string[] = [];
    jest.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    try {
      const code = await runWithArgv([
        "--config", configPath,
        "--allow-dml",
        "--dry-run",
        "-e", sql,
      ]);
      expect(code).toBe(0);
      const lines = out.join("").split("\n");
      const header = lines.find((l) => l.includes(label)) ?? "";
      expect(header).toContain(expected);
      // 内部 mapped APP 表記（APP9xxxxxxxx）を出力してはならない（仕様 §8.1 / §9.2）
      expect(out.join("")).not.toMatch(/APP9\d{8}/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
