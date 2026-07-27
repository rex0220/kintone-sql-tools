import {
  execute,
  executeBatch,
  type KintoneClient,
  type SelectResult,
} from "../execute";
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

function baseQuery(query: string): string {
  return query.replace(/(?:^|\s+)order by \$id asc limit 500 offset \d+$/, "");
}

const rowsByApp: Readonly<Record<number, readonly KintoneRecord[]>> = {
  76600: [
    record({ $id: "1", 顧客ID: "C1", 担当者: "佐藤", 共通: "main", 金額: "10", 件名: "urgent" }),
    record({ $id: "2", 顧客ID: "C2", 担当者: "田中", 共通: "other", 金額: "20", 件名: "normal" }),
  ],
  76601: [
    record({ $id: "11", 顧客ID: "C1", 区分: "A", 共通: "join" }),
    record({ $id: "12", 顧客ID: "C2", 区分: "B", 共通: "other" }),
  ],
  76602: [
    record({ $id: "21", 顧客ID: "C1", 地域: "東" }),
    record({ $id: "22", 顧客ID: "C2", 地域: "西" }),
  ],
  76603: [record({ $id: "31", 値: "A" })],
};

const fieldsByApp: Readonly<Record<number, readonly FieldDef[]>> = {
  76600: [
    { code: "顧客ID", fieldType: "SINGLE_LINE_TEXT" },
    { code: "担当者", fieldType: "SINGLE_LINE_TEXT" },
    { code: "共通", fieldType: "SINGLE_LINE_TEXT" },
    { code: "金額", fieldType: "NUMBER" },
    { code: "件名", fieldType: "SINGLE_LINE_TEXT" },
  ],
  76601: [
    { code: "顧客ID", fieldType: "SINGLE_LINE_TEXT" },
    { code: "区分", fieldType: "DROP_DOWN", optionOrder: { A: 0, B: 1 } },
    { code: "共通", fieldType: "SINGLE_LINE_TEXT" },
  ],
  76602: [
    { code: "顧客ID", fieldType: "SINGLE_LINE_TEXT" },
    { code: "地域", fieldType: "SINGLE_LINE_TEXT" },
  ],
  76603: [{ code: "値", fieldType: "SINGLE_LINE_TEXT" }],
};

function makeClient(options: { readonly searchAborted?: boolean } = {}): KintoneClient & {
  readonly calls: GetRecordsParams[];
  readonly fieldCalls: number[];
} {
  const calls: GetRecordsParams[] = [];
  const fieldCalls: number[] = [];
  return {
    calls,
    fieldCalls,
    async getRecords(params) {
      calls.push({ ...params, fields: [...params.fields] });
      return {
        records: requestedFieldsOnly(rowsByApp[params.app] ?? [], params.fields),
        searchAborted: options.searchAborted,
      };
    },
    async openCursor() { throw new Error("unexpected cursor call"); },
    async postRecords() { throw new Error("unexpected write"); },
    async putRecords() { throw new Error("unexpected write"); },
    async deleteRecords() { throw new Error("unexpected write"); },
    async getApps() { return []; },
    async getFields(appId) {
      fieldCalls.push(appId);
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

function queryFor(client: { readonly calls: GetRecordsParams[] }, app: number): string {
  return baseQuery(client.calls.find((call) => call.app === app)!.query);
}

function planText(result: SelectResult): string {
  return result.rows.map((row) => row.plan).join("\n");
}

const twoTable =
  "SELECT a.$id, b.区分 FROM APP76600 a INNER JOIN APP76601 b "
  + "ON a.顧客ID = b.顧客ID WHERE ";

test("B76 Step 4: EXPLAIN renderer は生成済み runtime plan の applied query/relation/residual を表示する", async () => {
  const sql = `${twoTable}a.担当者 = '佐藤' AND b.区分 IN ('A')`;
  const runtime = makeClient();
  const explained = makeClient();

  const rows = await execute(sql, runtime, { cacheContext: "b76-step4-runtime-plan" }) as SelectResult;
  const text = planText(await execute(
    `EXPLAIN ${sql}`,
    explained,
    { cacheContext: "b76-step4-explain-plan" }
  ) as SelectResult);

  expect(rows.rows).toEqual([{ $id: "1", 区分: "A" }]);
  expect(explained.calls).toEqual([]);
  expect(text).toContain("join pushdown plan: applied (runtime metadata resolved)");
  expect(text).toContain(
    "runtime plan timing: variables/subqueries resolved -> metadata resolved -> immutable plan"
  );
  expect(text).toContain("EXPLAIN unresolved subqueries: not applied (records API is not called)");
  expect(text).toContain("pushdown applied: 担当者 = \"佐藤\"");
  expect(text).toContain("pushdown applied: 区分 in (\"A\")");
  expect(text).toContain("relation: superset");
  expect(text).toContain("relation: exact");
  expect(text).toContain("residual: original WHERE");
  expect(text).not.toContain("pushdown candidate:");

  const displayedQueries = [...text.matchAll(/kintone query: (.+)/g)].map((match) => match[1]);
  expect(displayedQueries).toEqual([queryFor(runtime, 76600), queryFor(runtime, 76601)]);
  expect(new Set(explained.fieldCalls)).toEqual(new Set([76600, 76601]));
});

test("B76 Step 4: batch variable は値解決後の plan に入り、subquery RHS は serializer に到達しない", async () => {
  const variable = makeClient();
  const batch = await executeBatch(
    "SET @who = '佐藤'; "
      + `${twoTable}a.担当者 = @who`,
    variable,
    { cacheContext: "b76-step4-variable" }
  );
  expect(batch.ok).toBe(true);
  expect(queryFor(variable, 76600)).toBe('担当者 = "佐藤"');

  const subquery = makeClient();
  const result = await execute(
    `${twoTable}b.区分 IN (SELECT 値 FROM APP76603)`,
    subquery,
    { cacheContext: "b76-step4-subquery" }
  ) as SelectResult;
  expect(result.rows).toEqual([{ $id: "1", 区分: "A" }]);
  expect(queryFor(subquery, 76601)).not.toContain("区分");
  expect(subquery.calls.some((call) => call.app === 76603)).toBe(true);
});

test("B76 §16: SearchAborted は JOIN plan の有無で挙動を変えず既存どおり警告を返す", async () => {
  // B76 は性能改善であり、検索打ち切りの安全性という別問題を副作用で持ち込まない。
  // JOIN plan があってもエラー化せず、単一表・INNER JOIN と同じ警告経路を維持する。
  // （LEFT/RIGHT JOIN は B79 で fail-closed になったため、本テストの対象は INNER JOIN。）
  const client = makeClient({ searchAborted: true });
  const result = await execute(
    `${twoTable}a.担当者 = '佐藤'`,
    client,
    { cacheContext: "b76-step4-search-aborted" }
  ) as SelectResult;
  expect(client.calls.length).toBeGreaterThan(0);
  expect(result.warnings?.some((w) => w.includes("打ち切"))).toBe(true);
});

test("B76 Step 4: B76 固有の truncate 禁止を足さず既存 limit policy を維持する", async () => {
  const client = makeClient();
  const result = await execute(
    `${twoTable}a.担当者 = '佐藤' OR a.担当者 = '田中'`,
    client,
    {
      cacheContext: "b76-step4-complete-input",
      maxRecords: 1,
      onLimitReached: "truncate",
    }
  ) as SelectResult;
  expect(result.warnings).toEqual([
    "取得上限（1 件）に達したため、1 件で打ち切って表示しています。",
  ]);
  expect(result.rows).toEqual([{ $id: "1", 区分: "A" }]);
});

test("B76 Step 4: 同名 field と3 table ownership は修飾先だけへ適用し曖昧参照を拒否表示する", async () => {
  const qualified = makeClient();
  await execute(
    `${twoTable}a.共通 = 'main'`,
    qualified,
    { cacheContext: "b76-step4-qualified" }
  );
  expect(queryFor(qualified, 76600)).toBe('共通 = "main"');
  expect(queryFor(qualified, 76601)).not.toContain("共通");

  const ambiguous = makeClient();
  const ambiguousText = planText(await execute(
    `EXPLAIN ${twoTable}共通 = 'main'`,
    ambiguous,
    { cacheContext: "b76-step4-ambiguous" }
  ) as SelectResult);
  expect(ambiguousText).toContain("join pushdown not applied: AMBIGUOUS_FIELD");
  expect([...ambiguousText.matchAll(/kintone query: (.+)/g)].every((match) =>
    !match[1].includes("共通")
  )).toBe(true);

  const three = makeClient();
  await execute(
    "SELECT a.$id FROM APP76600 a INNER JOIN APP76601 b ON a.顧客ID = b.顧客ID "
      + "INNER JOIN APP76602 c ON a.顧客ID = c.顧客ID WHERE c.地域 = '東'",
    three,
    { cacheContext: "b76-step4-three-tables" }
  );
  expect(queryFor(three, 76602)).toBe('地域 = "東"');
  expect(queryFor(three, 76600)).not.toContain("地域");
  expect(queryFor(three, 76601)).not.toContain("地域");
});

test.each([
  ["cross-alias OR", "a.担当者 = '佐藤' OR b.区分 IN ('A')", "CROSS_ALIAS_OR"],
  ["NOT", "NOT (a.担当者 = '佐藤')", "NOT"],
  ["cross-table binary", "a.担当者 = b.共通", "CROSS_TABLE_BINARY"],
  ["nonexistent option", "b.区分 IN ('Z')", "UNSAFE_RELATION"],
] as const)(
  "B76 Step 4 negative: %s は押し下げない",
  async (_label, predicate, reason) => {
    const client = makeClient();
    const text = planText(await execute(
      `EXPLAIN ${twoTable}${predicate}`,
      client,
      { cacheContext: `b76-step4-negative-${reason}` }
    ) as SelectResult);
    expect(text).toContain(`join pushdown not applied: ${reason}`);
    expect([...text.matchAll(/kintone query: (.+)/g)].every((match) =>
      !match[1].includes("担当者") && !match[1].includes("区分")
    )).toBe(true);
  }
);

test.each(["LEFT", "RIGHT"] as const)(
  "B76 Step 4 negative: %s JOIN は plan 非適用を表示し実行 query に新規述語を入れない",
  async (joinType) => {
    const sql =
      `SELECT a.$id FROM APP76600 a ${joinType} JOIN APP76601 b `
      + "ON a.顧客ID = b.顧客ID WHERE a.担当者 = '佐藤'";
    const explained = makeClient();
    const text = planText(await execute(
      `EXPLAIN ${sql}`,
      explained,
      { cacheContext: `b76-step4-${joinType}-explain` }
    ) as SelectResult);
    expect(text).toContain("join pushdown not applied: OUTER_JOIN");

    const runtime = makeClient();
    await execute(sql, runtime, { cacheContext: `b76-step4-${joinType}-runtime` });
    expect(runtime.calls.every((call) => !call.query.includes("担当者"))).toBe(true);
  }
);

test("B76 Step 4 negative: KLIKE を含む OR は EXPLAIN も実行も records API 前に fail-closed", async () => {
  for (const prefix of ["", "EXPLAIN "]) {
    const client = makeClient();
    await expect(execute(
      `${prefix}${twoTable}a.件名 KLIKE 'urgent' OR a.担当者 = '佐藤'`,
      client,
      { cacheContext: `b76-step4-klike-or-${prefix === "" ? "run" : "explain"}` }
    )).rejects.toThrow("FULL_SCAN の KLIKE / NOT KLIKE");
    expect(client.calls).toEqual([]);
  }
});
