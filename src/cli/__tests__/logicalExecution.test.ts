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
});
