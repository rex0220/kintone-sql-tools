import { execute, type KintoneClient, type SelectResult } from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";

type GetRecordsParams = Parameters<KintoneClient["getRecords"]>[0];

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

const mainRows = [
  record({ $id: "1", 顧客ID: "C1", 日付: "2026-07-27", 件名: "urgent task" }),
  record({ $id: "2", 顧客ID: "C2", 日付: "2026-06-30", 件名: "urgent old" }),
  record({ $id: "3", 顧客ID: "C3", 日付: "2026-07-28", 件名: "short" }),
];
const joinRows = [
  record({ $id: "11", 顧客ID: "C1", 有効日: "2026-07-27", 区分: "A" }),
  record({ $id: "12", 顧客ID: "C2", 有効日: "2026-06-30", 区分: "A" }),
  record({ $id: "13", 顧客ID: "C3", 有効日: "2026-07-28", 区分: "B" }),
];

function makeClient(): KintoneClient & { readonly calls: GetRecordsParams[] } {
  const calls: GetRecordsParams[] = [];
  return {
    calls,
    async getRecords(params) {
      calls.push({ ...params, fields: [...params.fields] });
      let rows = params.app === 77600 ? mainRows : joinRows;
      const query = withoutPaging(params.query);
      if (
        query.includes("日付 = THIS_MONTH()")
        || (
          query.includes('日付 >= "2026-07-01"')
          && query.includes('日付 <= "2026-07-31"')
        )
      ) {
        rows = rows.filter((row) => String(row["日付"]?.value).startsWith("2026-07-"));
      }
      if (query.includes("有効日 = THIS_MONTH()")) {
        rows = rows.filter((row) => String(row["有効日"]?.value).startsWith("2026-07-"));
      }
      if (query.includes('件名 like "urgent"')) {
        rows = rows.filter((row) => String(row["件名"]?.value).includes("urgent"));
      }
      if (query.includes('件名 = "urgent task"')) {
        rows = rows.filter((row) => String(row["件名"]?.value) === "urgent task");
      }
      return { records: requestedFieldsOnly(rows, params.fields) };
    },
    async openCursor() { throw new Error("unexpected cursor call"); },
    async postRecords() { throw new Error("unexpected write"); },
    async putRecords() { throw new Error("unexpected write"); },
    async deleteRecords() { throw new Error("unexpected write"); },
    async getApps() { return []; },
    async getFields(appId) {
      if (appId === 77600) {
        return [
          { code: "顧客ID", label: "顧客ID", fieldType: "SINGLE_LINE_TEXT" },
          { code: "日付", label: "日付", fieldType: "DATE" },
          { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
        ];
      }
      return [
        { code: "顧客ID", label: "顧客ID", fieldType: "SINGLE_LINE_TEXT" },
        { code: "有効日", label: "有効日", fieldType: "DATE" },
        {
          code: "区分",
          label: "区分",
          fieldType: "DROP_DOWN",
          optionOrder: { A: 0, B: 1 },
        },
      ];
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const };
    },
  };
}

const baseSql =
  "SELECT a.$id, b.区分 FROM APP77600 a INNER JOIN APP77601 b "
  + "ON a.顧客ID = b.顧客ID WHERE ";

test("B76 Phase B Step 2: main 第5-Lを実fetchへ束縛し、literal parityとclient評価0を保つ", async () => {
  const functionClient = makeClient();
  const literalClient = makeClient();
  const functionResult = await execute(
    `${baseSql}a.日付 = THIS_MONTH()`,
    functionClient,
    { cacheContext: "b76-phase-b-step2-main-function" }
  ) as SelectResult;
  const literalResult = await execute(
    `${baseSql}a.日付 >= '2026-07-01' AND a.日付 <= '2026-07-31'`,
    literalClient,
    { cacheContext: "b76-phase-b-step2-main-literal" }
  ) as SelectResult;

  expect(functionResult.rows).toEqual(literalResult.rows);
  expect(functionResult.rows).toEqual([
    { $id: "1", 区分: "A" },
    { $id: "3", 区分: "B" },
  ]);
  expect(withoutPaging(
    functionClient.calls.find((call) => call.app === 77600)!.query
  )).toBe("日付 = THIS_MONTH()");
});

test("B76 Phase B Step 2: JOIN側 fetch、通常residual、appliedKlikesが同じplanで共存する", async () => {
  const joinTargetClient = makeClient();
  const joinTarget = await execute(
    `${baseSql}b.有効日 = THIS_MONTH()`,
    joinTargetClient,
    { cacheContext: "b76-phase-b-step2-join-function" }
  ) as SelectResult;
  expect(joinTarget.rows).toEqual([
    { $id: "1", 区分: "A" },
    { $id: "3", 区分: "B" },
  ]);
  expect(withoutPaging(
    joinTargetClient.calls.find((call) => call.app === 77601)!.query
  )).toBe("有効日 = THIS_MONTH()");

  const coexistClient = makeClient();
  const coexist = await execute(
    `${baseSql}a.日付 = THIS_MONTH() AND a.件名 KLIKE 'urgent' `
    + "AND LENGTH(a.件名) > 5",
    coexistClient,
    { cacheContext: "b76-phase-b-step2-klike" }
  ) as SelectResult;
  expect(coexist.rows).toEqual([{ $id: "1", 区分: "A" }]);
  expect(withoutPaging(
    coexistClient.calls.find((call) => call.app === 77600)!.query
  )).toBe('(件名 like "urgent") and (日付 = THIS_MONTH())');

  const exactClient = makeClient();
  const exact = await execute(
    `${baseSql}a.日付 = THIS_MONTH() AND a.件名 = 'urgent task'`,
    exactClient,
    { cacheContext: "b76-phase-b-step2-b152-exact" }
  ) as SelectResult;
  expect(exact.rows).toEqual([{ $id: "1", 区分: "A" }]);
  expect(withoutPaging(
    exactClient.calls.find((call) => call.app === 77600)!.query
  )).toBe('日付 = THIS_MONTH() and 件名 = "urgent task"');
});

test.each([
  ["cross-alias OR", "a.日付 = THIS_MONTH() OR b.区分 = 'A'"],
] as const)(
  "B76 Phase B Step 2: %s はrecords API前に従来reasonで拒否する",
  async (label, predicate) => {
    const client = makeClient();
    await expect(execute(
      `${baseSql}${predicate}`,
      client,
      { cacheContext: `b76-phase-b-step2-negative-${label}` }
    )).rejects.toThrow(/WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN/);
    expect(client.calls).toEqual([]);
  }
);

test.each(["LEFT", "RIGHT"] as const)(
  "B76 Phase B Step 2: %s JOIN は第5-Lを許可せずrecords API 0",
  async (joinType) => {
    const client = makeClient();
    await expect(execute(
      "SELECT a.$id FROM APP77600 a "
      + `${joinType} JOIN APP77601 b ON a.顧客ID = b.顧客ID `
      + "WHERE a.日付 = THIS_MONTH()",
      client,
      { cacheContext: `b76-phase-b-step2-${joinType.toLowerCase()}` }
    )).rejects.toThrow(/WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN/);
    expect(client.calls).toEqual([]);
  }
);

test("B76 Phase B Step 3: 複数APP関数を各aliasのfetchへ束縛する", async () => {
  const client = makeClient();
  const result = await execute(
    `${baseSql}a.日付 = THIS_MONTH() AND b.有効日 = THIS_MONTH()`,
    client,
    { cacheContext: "b76-phase-b-step2-multiple-apps" }
  ) as SelectResult;
  expect(result.rows).toEqual([
    { $id: "1", 区分: "A" },
    { $id: "3", 区分: "B" },
  ]);
  expect(withoutPaging(client.calls.find((call) => call.app === 77600)!.query))
    .toBe("日付 = THIS_MONTH()");
  expect(withoutPaging(client.calls.find((call) => call.app === 77601)!.query))
    .toBe("有効日 = THIS_MONTH()");
});

test("B76 Phase B Step 2: truncateは同値literal queryと同じ既存policyを使う", async () => {
  const functionClient = makeClient();
  const literalClient = makeClient();
  const options = { maxRecords: 1, onLimitReached: "truncate" as const };
  const functionResult = await execute(
    `${baseSql}a.日付 = THIS_MONTH()`,
    functionClient,
    { ...options, cacheContext: "b76-phase-b-step2-truncate-function" }
  ) as SelectResult;
  const literalResult = await execute(
    `${baseSql}a.日付 >= '2026-07-01' AND a.日付 <= '2026-07-31'`,
    literalClient,
    { ...options, cacheContext: "b76-phase-b-step2-truncate-literal" }
  ) as SelectResult;
  expect(functionResult.rows).toEqual(literalResult.rows);
  expect(functionResult.warnings).toEqual(literalResult.warnings);
});
