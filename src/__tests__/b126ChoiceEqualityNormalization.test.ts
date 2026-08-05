import { execute, type KintoneClient, type KintoneFieldInfo, type SelectResult } from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";

const FIELDS: KintoneFieldInfo[] = [
  { code: "choice", label: "choice", fieldType: "DROP_DOWN", optionOrder: { A: 0, B: 1 } },
  { code: "text", label: "text", fieldType: "SINGLE_LINE_TEXT" },
  { code: "users", label: "users", fieldType: "USER_SELECT" },
  { code: "checks", label: "checks", fieldType: "CHECK_BOX", optionOrder: { A: 0 } },
  { code: "status", label: "status", fieldType: "STATUS" },
];

function record(id: number, choice: string): KintoneRecord {
  return {
    $id: { value: String(id) },
    choice: { value: choice },
    text: { value: `row-${id}` },
    users: { value: [] },
    checks: { value: [] },
    status: { value: id === 1 ? "Open" : "Done" },
  } as KintoneRecord;
}

const SOURCE = [record(1, "A"), record(2, "B"), record(3, "")];

function makeClient() {
  const getRecords = jest.fn(async (params: Parameters<KintoneClient["getRecords"]>[0]) => {
    const query = params.query ?? "";
    let records = SOURCE;
    if (query.includes('choice in ("A")')) records = SOURCE.filter((row) => row.choice.value === "A");
    if (query.includes('choice not in ("A")')) records = SOURCE.filter((row) => row.choice.value !== "A");
    if (query.includes("$id > 1")) records = records.filter((row) => Number(row.$id.value) > 1);
    return {
      records,
      ...((params as typeof params & { totalCount?: boolean }).totalCount
        ? { totalCount: String(records.length) }
        : {}),
    };
  });
  const getProcessStatuses = jest.fn(async () => ({
    enable: true,
    states: [{ name: "Open", index: 0 }, { name: "Done", index: 1 }],
  }));
  const client: KintoneClient = {
    getRecords,
    async openCursor() { throw new Error("unexpected cursor call"); },
    async postRecords() { return { ids: [] }; },
    async putRecords() { /* noop */ },
    async deleteRecords() { /* noop */ },
    async getApps() { return []; },
    async getFields() { return FIELDS; },
    getProcessStatuses,
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" };
    },
  };
  return { client, getRecords, getProcessStatuses };
}

function plan(result: SelectResult): string[] {
  return result.rows.map((row) => String(row.plan));
}

function withoutNormalizationLine(lines: string[]): string[] {
  return lines.filter((line) => !line.includes("pushdown normalized:"));
}

describe("B126 choice equality normalization execution", () => {
  test("実在しない値は REST へ押し下げず、エラーなしの 0 行を維持する", async () => {
    const { client, getRecords } = makeClient();
    const result = await execute("SELECT $id FROM APP100 WHERE choice = 'missing'", client) as SelectResult;
    expect(result.rows).toEqual([]);
    expect(getRecords.mock.calls.every(([params]) => !String(params.query).includes("missing"))).toBe(true);
  });

  test("実在値の = は singleton IN と同じ REST query へ載る", async () => {
    const { client, getRecords } = makeClient();
    const result = await execute("SELECT $id, choice FROM APP100 WHERE choice = 'A'", client) as SelectResult;
    expect(result.rows).toEqual([{ $id: "1", choice: "A" }]);
    expect(getRecords.mock.calls[0]?.[0].query).toContain('choice in ("A")');
  });

  test("!= は singleton NOT IN と同じ経路で未選択行を含む", async () => {
    const { client, getRecords } = makeClient();
    const result = await execute("SELECT $id, choice FROM APP100 WHERE choice != 'A'", client) as SelectResult;
    expect(result.rows).toEqual([{ $id: "2", choice: "B" }, { $id: "3", choice: "" }]);
    expect(getRecords.mock.calls[0]?.[0].query).toContain('choice not in ("A")');
  });

  test("空文字は正規化せずローカル評価する", async () => {
    const { client, getRecords } = makeClient();
    const result = await execute("SELECT $id FROM APP100 WHERE choice = ''", client) as SelectResult;
    expect(result.rows).toEqual([{ $id: "3" }]);
    expect(getRecords.mock.calls.every(([params]) => !String(params.query).includes("choice"))).toBe(true);
  });

  test("AND 内の choice leaf だけを正規化する", async () => {
    const { client, getRecords } = makeClient();
    const result = await execute(
      "SELECT $id FROM APP100 WHERE choice = 'A' AND $id > 1",
      client
    ) as SelectResult;
    expect(result.rows).toEqual([]);
    expect(getRecords.mock.calls[0]?.[0].query).toContain('choice in ("A")');
    expect(getRecords.mock.calls[0]?.[0].query).toContain("$id > 1");
  });

  test("COUNT(*) も IN と同じ totalCount 経路を使う", async () => {
    const { client, getRecords } = makeClient();
    const result = await execute(
      "SELECT COUNT(*) AS c FROM APP100 WHERE choice = 'A'",
      client
    ) as SelectResult;
    expect(result.rows).toEqual([{ c: "1" }]);
    expect(getRecords.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      query: 'choice in ("A") limit 1',
      totalCount: true,
    }));
  });

  test("STATUS は process status の optionOrder を解決して正規化する", async () => {
    const { client, getRecords, getProcessStatuses } = makeClient();
    await execute("SELECT $id FROM APP100 WHERE status = 'Open'", client);
    expect(getProcessStatuses).toHaveBeenCalledTimes(1);
    expect(getRecords.mock.calls[0]?.[0].query).toContain('status in ("Open")');
  });

  test.each([
    ["=", "IN"],
    ["!=", "NOT IN"],
  ])("EXPLAIN の %s は利用者記述の %s と正規化表示以外完全一致", async (op, inOp) => {
    const left = await execute(
      `EXPLAIN SELECT $id FROM APP100 WHERE choice ${op} 'A'`,
      makeClient().client
    ) as SelectResult;
    const right = await execute(
      `EXPLAIN SELECT $id FROM APP100 WHERE choice ${inOp} ('A')`,
      makeClient().client
    ) as SelectResult;
    expect(withoutNormalizationLine(plan(left))).toEqual(plan(right));
    expect(plan(left)).toContain(
      `  pushdown normalized: choice ${op} 'A' -> choice ${inOp.toLowerCase()} ("A")`
    );
  });

  test.each([
    [
      "JOIN",
      "SELECT a.$id FROM APP100 a JOIN APP101 b ON a.$id = b.$id WHERE a.choice OP 'A'",
    ],
    [
      "KORDER",
      "SELECT $id FROM APP100 WHERE choice OP 'A' KORDER BY $id LIMIT 5",
    ],
  ])("EXPLAIN %s でも = と IN の下流計画が一致する", async (_label, template) => {
    const equality = await execute(
      `EXPLAIN ${template.replace("OP", "=")}`,
      makeClient().client
    ) as SelectResult;
    const inList = await execute(
      `EXPLAIN ${template.replace("OP 'A'", "IN ('A')")}`,
      makeClient().client
    ) as SelectResult;
    expect(withoutNormalizationLine(plan(equality))).toEqual(plan(inList));
  });

  test("複数値型は正規化せず、CHECK_BOX の = は従来どおり UNSUPPORTED", async () => {
    const userPlan = await execute(
      "EXPLAIN SELECT $id FROM APP100 WHERE users = 'u1'",
      makeClient().client
    ) as SelectResult;
    expect(plan(userPlan).some((line) => line.includes("pushdown normalized:"))).toBe(false);
    await expect(execute(
      "SELECT $id FROM APP100 WHERE checks = 'A'",
      makeClient().client
    )).rejects.toThrow(/WHERE_OPERATOR_INVALID_FOR_FIELD_TYPE/);
  });
});
