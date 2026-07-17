import { resetGlobalRequestGate } from "../../api/requestGate";
import { runWithArgv } from "../index";

const DUMMY_AUTH = [
  "--base-url", "https://example.cybozu.com",
  "--auth", "token",
  "--token-map", "APP100=dummy,APP200=dummy",
];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeRecord(id: number, name: string) {
  return {
    $id: { value: String(id) },
    顧客名: { value: name },
    名前: { value: name },
  };
}

function installFetchMock() {
  const postBodies: unknown[] = [];
  const fetchMock = jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/app/form/fields.json")) {
      return jsonResponse({
        properties: {
          $id: { code: "$id", label: "Record ID", type: "__ID__" },
          顧客名: { code: "顧客名", label: "顧客名", type: "SINGLE_LINE_TEXT" },
          名前: { code: "名前", label: "名前", type: "SINGLE_LINE_TEXT" },
        },
      });
    }
    if (url.pathname.endsWith("/records.json") && String(init?.method ?? "GET").toUpperCase() === "GET") {
      const app = Number(url.searchParams.get("app"));
      return jsonResponse({
        records: app === 100
          ? [makeRecord(1, "A社"), makeRecord(2, "B社"), makeRecord(3, "C社")]
          : [],
      });
    }
    if (url.pathname.endsWith("/records.json") && String(init?.method ?? "GET").toUpperCase() === "POST") {
      postBodies.push(JSON.parse(String(init?.body ?? "{}")));
      return jsonResponse({ ids: ["1", "2"] });
    }
    return jsonResponse({});
  });
  return { fetchMock, postBodies };
}

async function runCaptured(argv: string[]) {
  let stdout = "";
  let stderr = "";
  const outSpy = jest.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  const errSpy = jest.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write);
  try {
    const code = await runWithArgv(argv);
    return { code, stdout, stderr };
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
}

describe("CLI DML on-limit handling", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    resetGlobalRequestGate();
  });

  test("single INSERT_SELECT forces onLimit=error and emits a note for truncate", async () => {
    const { postBodies } = installFetchMock();
    const res = await runCaptured([
      ...DUMMY_AUTH,
      "--allow-dml",
      "--yes",
      "--max-records", "2",
      "--on-limit", "truncate",
      "-e", "INSERT INTO APP200 (名前) SELECT 顧客名 FROM APP100",
    ]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("note: onLimit=truncate is ignored for DML (forced to error)");
    expect(res.stderr).toContain("取得件数が上限（2 件）を超えました。");
    expect(postBodies).toHaveLength(0);
  });

  test("batch INSERT_SELECT forces onLimit=error and emits a note for truncate", async () => {
    const { postBodies } = installFetchMock();
    const res = await runCaptured([
      ...DUMMY_AUTH,
      "--allow-dml",
      "--yes",
      "--max-records", "2",
      "--on-limit", "truncate",
      "-e", "SELECT 顧客名 FROM APP100; INSERT INTO APP200 (名前) SELECT 顧客名 FROM APP100",
    ]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("note: onLimit=truncate is ignored for DML (forced to error)");
    expect(res.stderr).toContain("取得件数が上限（2 件）を超えました。");
    expect(postBodies).toHaveLength(0);
  });

  test("--quiet suppresses the DML truncate note", async () => {
    installFetchMock();
    const res = await runCaptured([
      ...DUMMY_AUTH,
      "--allow-dml",
      "--yes",
      "--quiet",
      "--max-records", "2",
      "--on-limit", "truncate",
      "-e", "INSERT INTO APP200 (名前) SELECT 顧客名 FROM APP100",
    ]);

    expect(res.code).toBe(1);
    expect(res.stderr).not.toContain("onLimit=truncate is ignored for DML");
    expect(res.stderr).toContain("取得件数が上限（2 件）を超えました。");
  });

  test("read-only SELECT keeps onLimit=truncate", async () => {
    installFetchMock();
    const res = await runCaptured([
      "--base-url", "https://example.cybozu.com",
      "--auth", "token",
      "--token", "dummy",
      "--max-records", "2",
      "--on-limit", "truncate",
      "-e", "SELECT 顧客名 FROM APP100",
    ]);

    expect(res.code).toBe(0);
    expect(res.stderr).not.toContain("onLimit=truncate is ignored for DML");
    expect(res.stderr).toContain("rowCount=2");
    expect(res.stdout).toContain("A社");
    expect(res.stdout).toContain("B社");
    expect(res.stdout).not.toContain("C社");
  });

  test("local ORDER BY is rejected by the engine without a misleading surface note", async () => {
    installFetchMock();
    const res = await runCaptured([
      "--base-url", "https://example.cybozu.com",
      "--auth", "token",
      "--token", "dummy",
      "--max-records", "2",
      "--on-limit", "truncate",
      "-e", "SELECT 顧客名 FROM APP100 ORDER BY 顧客名",
    ]);

    expect(res.code).toBe(1);
    expect(res.stderr).not.toContain("note: onLimit=truncate is ignored for ORDER BY");
    expect(res.stderr).toContain("ORDER BYの正しい結果には完全な候補集合が必要です");
    expect(res.stderr).toContain("取得件数が上限（2 件）を超えました。");
    expect(res.stdout).not.toContain("A社");
  });
});
