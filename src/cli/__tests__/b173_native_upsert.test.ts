import { runWithArgv } from "../index";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function installKintoneFetch(): jest.SpyInstance {
  return jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes("/app/form/fields.json")) {
      return json({
        properties: {
          key: { code: "key", label: "key", type: "SINGLE_LINE_TEXT", unique: true },
          value: { code: "value", label: "value", type: "SINGLE_LINE_TEXT" },
        },
      });
    }
    if (url.includes("/app/settings.json")) {
      return json({ numberPrecision: { digits: "30", decimalPlaces: "10", roundingMode: "HALF_EVEN" } });
    }
    if (url.includes("/records.json") && init?.method === "GET") return json({ records: [] });
    if (url.includes("/records.json") && init?.method === "POST") return json({ ids: ["1"] });
    if (url.includes("/records.json") && init?.method === "PUT") {
      return json({ records: [{ id: "1", revision: "1", operation: "INSERT" }] });
    }
    throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
  });
}

const BASE = [
  "--base-url", "https://example.cybozu.com",
  "--token", "token",
  "--allow-dml",
  "--yes",
  "--format", "json",
];

const SQL = "UPSERT INTO APP1 (key,value) VALUES ('K1','v') ON DUPLICATE (key)";

test("B173 AC-20: CLI は既定 OFF で現行 GET+POST、明示 flag のときだけ native PUT を使う", async () => {
  const fetchMock = installKintoneFetch();
  const stdout = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    expect(await runWithArgv([...BASE, "-e", SQL])).toBe(0);
    const defaultCalls = fetchMock.mock.calls.map(([input, init]) => ({
      url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null,
    }));
    expect(defaultCalls.some((call) => call.url.includes("/records.json") && call.method === "PUT")).toBe(false);
    expect(defaultCalls.some((call) => call.url.includes("/records.json") && call.method === "GET")).toBe(true);
    expect(defaultCalls.some((call) => call.url.includes("/records.json") && call.method === "POST")).toBe(true);

    fetchMock.mockClear();
    expect(await runWithArgv([...BASE, "--native-upsert", "-e", SQL])).toBe(0);
    const nativeCalls = fetchMock.mock.calls.map(([input, init]) => ({
      url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null,
    }));
    const writes = nativeCalls.filter((call) => call.url.includes("/records.json") && call.method === "PUT");
    expect(writes).toHaveLength(1);
    expect(writes[0].body).toMatchObject({ app: 1, upsert: true });
    expect(nativeCalls.some((call) => call.url.includes("/records.json") && call.method === "GET")).toBe(false);
    expect(nativeCalls.some((call) => call.url.includes("/records.json") && call.method === "POST")).toBe(false);
  } finally {
    fetchMock.mockRestore();
    stdout.mockRestore();
    stderr.mockRestore();
  }
});

test("B173 AC-15: native opt-in でも --dml-max-rows 超過は書込 API 前に拒否する", async () => {
  const fetchMock = installKintoneFetch();
  const stdout = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
  let stderrText = "";
  const stderr = jest.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderrText += String(chunk);
    return true;
  }) as typeof process.stderr.write);
  try {
    const sql = "UPSERT INTO APP1 (key,value) VALUES ('K1','v'),('K2','v') ON DUPLICATE (key)";
    expect(await runWithArgv([...BASE, "--native-upsert", "--dml-max-rows", "1", "-e", sql])).toBe(2);
    expect(stderrText).toContain("affected rows (2) exceed --dml-max-rows (1)");
    expect(fetchMock.mock.calls.some(([input, init]) =>
      String(input).includes("/records.json") && (init?.method === "POST" || init?.method === "PUT")
    )).toBe(false);
  } finally {
    fetchMock.mockRestore();
    stdout.mockRestore();
    stderr.mockRestore();
  }
});
