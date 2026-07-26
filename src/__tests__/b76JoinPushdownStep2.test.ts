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
  recordsByApp: Readonly<Record<number, readonly KintoneRecord[]>>,
  fieldsByApp: Readonly<Record<number, readonly FieldDef[]>>,
  serverResponse?: (params: GetRecordsParams, rows: readonly KintoneRecord[]) => readonly KintoneRecord[]
): KintoneClient & { readonly calls: GetRecordsParams[] } {
  const calls: GetRecordsParams[] = [];
  return {
    calls,
    async getRecords(params) {
      calls.push({ ...params, fields: [...params.fields] });
      const rows = serverResponse?.(params, recordsByApp[params.app] ?? [])
        ?? recordsByApp[params.app]
        ?? [];
      return { records: requestedFieldsOnly(rows, params.fields) };
    },
    async openCursor() { throw new Error("unexpected cursor call"); },
    async postRecords() { throw new Error("unexpected write"); },
    async putRecords() { throw new Error("unexpected write"); },
    async deleteRecords() { throw new Error("unexpected write"); },
    async getApps() { return []; },
    async getFields(appId) {
      return (fieldsByApp[appId] ?? []).map((field) => ({
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

const mainRows = [
  record({
    $id: "1",
    顧客ID: "C1",
    担当者: "佐藤",
    日付: "2026-07-27",
    時刻: "09:30",
    更新日時: "2026-07-27T00:30:00Z",
  }),
  // server equality の superset で余分に返る行を模擬する。JS residual では不一致。
  record({
    $id: "2",
    顧客ID: "C2",
    担当者: "佐藤 ",
    日付: "2026-07-27",
    時刻: "09:30",
    更新日時: "2026-07-27T00:30:00Z",
  }),
  record({
    $id: "3",
    顧客ID: "C3",
    担当者: "田中",
    日付: "2026-07-26",
    時刻: "10:00",
    更新日時: "2026-07-26T00:30:00Z",
  }),
];
const joinRows = [
  record({ $id: "11", 顧客ID: "C1", 担当者: "佐藤", 件名: "one" }),
  record({ $id: "12", 顧客ID: "C2", 担当者: "佐藤 ", 件名: "two" }),
  record({ $id: "13", 顧客ID: "C3", 担当者: "田中", 件名: "three" }),
];
const fieldsByApp = {
  76100: [
    { code: "顧客ID", fieldType: "SINGLE_LINE_TEXT" },
    { code: "担当者", fieldType: "SINGLE_LINE_TEXT" },
    { code: "日付", fieldType: "DATE" },
    { code: "時刻", fieldType: "TIME" },
    { code: "更新日時", fieldType: "UPDATED_TIME" },
  ],
  76200: [
    { code: "顧客ID", fieldType: "SINGLE_LINE_TEXT" },
    { code: "担当者", fieldType: "SINGLE_LINE_TEXT" },
    { code: "件名", fieldType: "SINGLE_LINE_TEXT" },
  ],
} as const;

test("B76 Step 2: rows parity を保ち、main fetch だけ DATE/TIME/DATETIME/TEXT 等値で絞る", async () => {
  const recordsByApp = { 76100: mainRows, 76200: joinRows };
  const baselineClient = makeClient(recordsByApp, fieldsByApp);
  const pushedClient = makeClient(recordsByApp, fieldsByApp, (params, rows) => {
    if (params.app === 76100 && params.query.includes('担当者 = "佐藤"')) {
      // kintone 集合が JS 集合より広いケースとして id=2 も返す。
      return rows.slice(0, 2);
    }
    return rows;
  });
  const predicate =
    "a.担当者 = '佐藤' AND a.日付 = '2026-07-27' "
    + "AND a.時刻 = '09:30' AND a.更新日時 = '2026-07-27T00:30:00Z'";
  const baseSql =
    "SELECT a.$id, b.件名 FROM APP76100 a INNER JOIN APP76200 b "
    + "ON a.顧客ID = b.顧客ID ";

  // GROUP は Step 3 対象なので、同値な全件 baseline として pushdown されない。
  const before = await execute(
    `${baseSql}WHERE (${predicate})`,
    baselineClient,
    { cacheContext: "b76-step2-before" }
  ) as SelectResult;
  const after = await execute(
    `${baseSql}WHERE ${predicate}`,
    pushedClient,
    { cacheContext: "b76-step2-after" }
  ) as SelectResult;

  expect(after.rows).toEqual(before.rows);
  expect(after.rows).toEqual([{ $id: "1", 件名: "one" }]);
  expect(withoutPaging(
    baselineClient.calls.find((call) => call.app === 76100)!.query
  )).toBe("");
  expect(withoutPaging(
    pushedClient.calls.find((call) => call.app === 76100)!.query
  )).toBe(
    '((担当者 = "佐藤" and 日付 = "2026-07-27") and 時刻 = "09:30") '
    + 'and 更新日時 = "2026-07-27T00:30:00Z"'
  );
  for (const call of [...baselineClient.calls, ...pushedClient.calls]) {
    const returned = recordsByApp[call.app as keyof typeof recordsByApp] ?? [];
    const requested = new Set(call.fields);
    expect(requested.size).toBeGreaterThan(0);
    for (const row of requestedFieldsOnly(returned, call.fields)) {
      expect(Object.keys(row).every((field) => requested.has(field))).toBe(true);
    }
  }
});

test("B76 Step 2: 両 APP 同名 field は修飾時だけ対象 APP へ送り、非修飾は送らない", async () => {
  const recordsByApp = { 76100: mainRows.slice(0, 1), 76200: joinRows.slice(0, 1) };
  const qualified = makeClient(recordsByApp, fieldsByApp);
  const ambiguous = makeClient(recordsByApp, fieldsByApp);
  const baseSql =
    "SELECT a.$id FROM APP76100 a INNER JOIN APP76200 b ON a.顧客ID = b.顧客ID WHERE ";

  const qualifiedResult = await execute(
    `${baseSql}a.担当者 = '佐藤'`,
    qualified,
    { cacheContext: "b76-step2-same-qualified" }
  ) as SelectResult;
  const ambiguousResult = await execute(
    `${baseSql}担当者 = '佐藤'`,
    ambiguous,
    { cacheContext: "b76-step2-same-ambiguous" }
  ) as SelectResult;

  expect(qualifiedResult.rows).toEqual(ambiguousResult.rows);
  expect(withoutPaging(
    qualified.calls.find((call) => call.app === 76100)!.query
  )).toBe('担当者 = "佐藤"');
  expect(qualified.calls.find((call) => call.app === 76200)?.query)
    .not.toContain('担当者 = "佐藤"');
  expect(ambiguous.calls.every((call) => !call.query.includes('担当者 = "佐藤"'))).toBe(true);
});

test.each(["LEFT", "RIGHT"] as const)(
  "B76 Step 2: %s JOIN には新規等値を押し下げない",
  async (joinType) => {
    const client = makeClient(
      { 76100: mainRows.slice(0, 1), 76200: joinRows.slice(0, 1) },
      fieldsByApp
    );
    await execute(
      `SELECT a.$id FROM APP76100 a ${joinType} JOIN APP76200 b `
      + "ON a.顧客ID = b.顧客ID WHERE a.担当者 = '佐藤'",
      client,
      { cacheContext: `b76-step2-${joinType.toLowerCase()}` }
    );
    expect(client.calls.every((call) => !call.query.includes('担当者 = "佐藤"'))).toBe(true);
  }
);
