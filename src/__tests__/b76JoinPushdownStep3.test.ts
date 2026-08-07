import { execute, type KintoneClient, type SelectResult } from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";

type GetRecordsParams = Parameters<KintoneClient["getRecords"]>[0];

interface FieldDef {
  readonly code: string;
  readonly fieldType: string;
  readonly optionOrder?: Readonly<Record<string, number>>;
}

function record(values: Readonly<Record<string, unknown>>): KintoneRecord {
  return Object.fromEntries(
    Object.entries(values).map(([code, value]) => [code, { value }])
  ) as KintoneRecord;
}

function requestedFieldsOnly(
  source: readonly KintoneRecord[],
  fields: readonly string[]
): KintoneRecord[] {
  return source.map((row) => Object.fromEntries(
    fields.flatMap((field) => row[field] === undefined ? [] : [[field, row[field]]])
  ) as KintoneRecord);
}

function withoutPaging(query: string): string {
  return query.replace(/(?:^|\s+)order by \$id asc limit 500 offset \d+$/, "");
}

function makeClient(
  response?: (params: GetRecordsParams, rows: readonly KintoneRecord[]) => readonly KintoneRecord[]
): KintoneClient & { readonly calls: GetRecordsParams[] } {
  const calls: GetRecordsParams[] = [];
  return {
    calls,
    async getRecords(params) {
      calls.push({ ...params, fields: [...params.fields] });
      const source = params.app === 76300 ? mainRows : joinRows;
      const rows = response?.(params, source) ?? source;
      return { records: requestedFieldsOnly(rows, params.fields) };
    },
    async openCursor() { throw new Error("unexpected cursor call"); },
    async postRecords() { throw new Error("unexpected write"); },
    async putRecords() { throw new Error("unexpected write"); },
    async deleteRecords() { throw new Error("unexpected write"); },
    async getApps() { return []; },
    async getFields(appId) {
      return (fieldsByApp[appId as keyof typeof fieldsByApp] ?? []).map((field) => ({
        code: field.code,
        label: field.code,
        fieldType: field.fieldType,
        ...(field.optionOrder ? { optionOrder: field.optionOrder } : {}),
      }));
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const };
    },
  };
}

function appQuery(client: { readonly calls: GetRecordsParams[] }, app: number): string {
  return withoutPaging(client.calls.find((call) => call.app === app)!.query);
}

const mainRows = [
  record({
    $id: "1", 顧客ID: "C1", 担当者: "佐藤", 日付: "2026-07-27", 数値: "1", 件名: "urgent task",
  }),
  record({
    $id: "2", 顧客ID: "C2", 担当者: "佐藤 ", 日付: "2026-07-26", 数値: "2", 件名: "ordinary",
  }),
  record({
    $id: "3", 顧客ID: "C3", 担当者: "田中", 日付: "2026-07-26", 数値: "3", 件名: "urgent note",
  }),
];

const joinRows = [
  record({ $id: "11", 顧客ID: "C1", 区分: "A", タグ: ["X"] }),
  record({ $id: "12", 顧客ID: "C2", 区分: "A", タグ: ["X", "Y"] }),
  record({ $id: "13", 顧客ID: "C3", 区分: "B", タグ: [] }),
];

const fieldsByApp: Readonly<Record<number, readonly FieldDef[]>> = {
  76300: [
    { code: "顧客ID", fieldType: "SINGLE_LINE_TEXT" },
    { code: "担当者", fieldType: "SINGLE_LINE_TEXT" },
    { code: "日付", fieldType: "DATE" },
    { code: "数値", fieldType: "NUMBER" },
    { code: "件名", fieldType: "SINGLE_LINE_TEXT" },
  ],
  76400: [
    { code: "顧客ID", fieldType: "SINGLE_LINE_TEXT" },
    { code: "区分", fieldType: "DROP_DOWN", optionOrder: { A: 0, B: 1 } },
    { code: "タグ", fieldType: "CHECK_BOX", optionOrder: { X: 0, Y: 1 } },
  ],
};

const baseSql =
  "SELECT a.$id, b.区分 FROM APP76300 a INNER JOIN APP76400 b "
  + "ON a.顧客ID = b.顧客ID WHERE ";

test("B76 Step 3: same-alias OR/GROUP と選択系を両 APP の共有 plan へ統合し residual で超集合を落とす", async () => {
  const baseline = makeClient();
  const pushed = makeClient((params, rows) => {
    if (params.app === 76300 && params.query.includes('担当者 = "佐藤"')) {
      // server equality が JS より広く、末尾空白の id=2 も返す状況を模擬する。
      return rows.slice(0, 2);
    }
    if (params.app === 76400 && params.query.includes('区分 in ("A")')) {
      return rows.slice(0, 2);
    }
    return rows;
  });
  const predicate =
    "(a.担当者 = '佐藤' OR a.日付 = '2026-07-25') AND b.区分 IN ('A')";

  const before = await execute(
    `${baseSql}(${predicate}) OR a.$id = 0`,
    baseline,
    { cacheContext: "b76-step3-or-before" }
  ) as SelectResult;
  const after = await execute(
    `${baseSql}${predicate}`,
    pushed,
    { cacheContext: "b76-step3-or-after" }
  ) as SelectResult;

  expect(after.rows).toEqual(before.rows);
  expect(after.rows).toEqual([{ $id: "1", 区分: "A" }]);
  expect(appQuery(baseline, 76300)).toBe("");
  expect(appQuery(baseline, 76400)).toBe('顧客ID in ("C1","C2","C3")');
  expect(appQuery(pushed, 76300)).toBe(
    '(担当者 = "佐藤" or 日付 = "2026-07-25")'
  );
  expect(appQuery(pushed, 76400)).toBe('区分 in ("A")');
});

test("B76 Step 3: cross-alias OR はどちらの APP にも採用しない", async () => {
  const client = makeClient();
  const result = await execute(
    `${baseSql}a.担当者 = '佐藤' OR b.区分 IN ('B')`,
    client,
    { cacheContext: "b76-step3-cross-or" }
  ) as SelectResult;

  expect(result.rows).toEqual([
    { $id: "1", 区分: "A" },
    { $id: "3", 区分: "B" },
  ]);
  expect(appQuery(client, 76300)).toBe("");
  expect(appQuery(client, 76400)).toBe('顧客ID in ("C1","C2","C3")');
});

test.each(["KLIKE", "NOT KLIKE"] as const)(
  "B76 Step 3: %s を含む OR は非採用で、records API 前に既存 fail-closed gate が止める",
  async (op) => {
    const client = makeClient();
    await expect(execute(
      `${baseSql}a.件名 ${op} 'urgent' OR a.担当者 = '佐藤'`,
      client,
      { cacheContext: `b76-step3-${op.toLowerCase()}` }
    )).rejects.toThrow("FULL_SCAN の KLIKE / NOT KLIKE");
    expect(client.calls).toEqual([]);
  }
);

test("B152 exact inequality を含む安全な AND 因子を各 APP に送る", async () => {
  const client = makeClient();
  const result = await execute(
    `${baseSql}a.担当者 = '佐藤' AND a.担当者 != '田中' AND b.区分 IN ('A')`,
    client,
    { cacheContext: "b76-step3-and-factor" }
  ) as SelectResult;

  expect(result.rows).toEqual([{ $id: "1", 区分: "A" }]);
  expect(appQuery(client, 76300)).toBe('担当者 = "佐藤" and 担当者 != "田中"');
  expect(appQuery(client, 76400)).toBe('区分 in ("A")');
});

test("B76 Step 3: NUMBER・$id・選択系・KLIKEを同じ planでvalidate/fetch/evalへ共有する", async () => {
  const client = makeClient((params, rows) => {
    if (params.app === 76300) return rows.slice(0, 1);
    if (params.app === 76400) return rows.slice(0, 2);
    return rows;
  });
  const result = await execute(
    `${baseSql}a.数値 = 1 AND a.件名 KLIKE 'urgent' `
    + "AND b.$id > 10 AND b.区分 IN ('A') AND b.タグ IN ('X')",
    client,
    { cacheContext: "b76-step3-shared-plan" }
  ) as SelectResult;

  expect(result.rows).toEqual([{ $id: "1", 区分: "A" }]);
  expect(appQuery(client, 76300)).toBe('数値 = 1 and 件名 like "urgent"');
  expect(appQuery(client, 76400)).toBe(
    '($id > 10 and 区分 in ("A")) and タグ in ("X")'
  );
  for (const call of client.calls) {
    const source = call.app === 76300 ? mainRows : joinRows;
    const projected = requestedFieldsOnly(source, call.fields);
    expect(projected.every((row) =>
      Object.keys(row).every((field) => call.fields.includes(field))
    )).toBe(true);
  }
});
