import { execute, type KintoneClient, type SelectResult } from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";
import * as evalWhereModule from "../engine/evalWhere";

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
  record({
    $id: "1",
    顧客ID: "C1",
    日付: "2026-07-10",
    件名: "normal",
    作成者: { code: "rex", name: "Rex" },
    担当者: [{ code: "rex", name: "Rex" }],
    グループ: [{ code: "dev", name: "Dev" }],
    区分: "A",
  }),
  record({
    $id: "2",
    顧客ID: "C2",
    日付: "2026-06-15",
    件名: "urgent old",
    作成者: { code: "other", name: "Other" },
    担当者: [{ code: "other", name: "Other" }],
    グループ: [{ code: "ops", name: "Ops" }],
    区分: "B",
  }),
  record({
    $id: "3",
    顧客ID: "C3",
    日付: "2026-05-01",
    件名: "urgent ancient",
    作成者: { code: "rex", name: "Rex" },
    担当者: [{ code: "rex", name: "Rex" }],
    グループ: [{ code: "dev", name: "Dev" }],
    区分: "A",
  }),
];

const joinRows = [
  record({
    $id: "11",
    顧客ID: "C1",
    更新日時: "2026-07-27T10:00:00Z",
    更新者: { code: "other", name: "Other" },
  }),
  record({
    $id: "12",
    顧客ID: "C2",
    更新日時: "2026-07-26T10:00:00Z",
    更新者: { code: "rex", name: "Rex" },
  }),
  record({
    $id: "13",
    顧客ID: "C3",
    更新日時: "2026-07-28T10:00:00Z",
    更新者: { code: "other", name: "Other" },
  }),
];

function filterRows(app: number, rawQuery: string): readonly KintoneRecord[] {
  const query = withoutPaging(rawQuery);
  const rows = app === 77610 ? mainRows : joinRows;
  if (query === "") return rows;
  const joinKeys = /^顧客ID in \((.+)\)$/.exec(query);
  if (joinKeys) {
    const values = new Set(
      [...joinKeys[1].matchAll(/"([^"]+)"/g)].map((match) => match[1])
    );
    return rows.filter((row) => values.has(String(row["顧客ID"].value)));
  }

  if (app === 77610) {
    if (
      query === "日付 = THIS_MONTH() or 日付 = LAST_MONTH()"
      || query === '日付 >= "2026-06-01" and 日付 <= "2026-07-31"'
    ) {
      return rows.filter((row) => {
        const value = String(row["日付"].value);
        return value.startsWith("2026-06-") || value.startsWith("2026-07-");
      });
    }
    if (
      query === '日付 = THIS_MONTH() or 件名 like "urgent"'
      || query === '日付 >= "2026-07-01" or 件名 like "urgent"'
    ) {
      return rows.filter((row) =>
        String(row["日付"].value).startsWith("2026-07-")
        || String(row["件名"].value).includes("urgent")
      );
    }
    if (
      query === "日付 != THIS_MONTH()"
      || query === "(日付 != THIS_MONTH())"
      || query === '日付 < "2026-07-01"'
    ) {
      return rows.filter((row) => !String(row["日付"].value).startsWith("2026-07-"));
    }
    if (
      query === "作成者 in (LOGINUSER())"
      || query === '作成者 in ("rex")'
      || query === "担当者 in (LOGINUSER())"
      || query === '担当者 in ("rex")'
    ) {
      const field = query.startsWith("作成者") ? "作成者" : "担当者";
      return rows.filter((row) => JSON.stringify(row[field].value).includes('"code":"rex"'));
    }
    if (query === "日付 = THIS_MONTH()") {
      return rows.filter((row) => String(row["日付"].value).startsWith("2026-07-"));
    }
  }

  if (app === 77611) {
    if (query === "更新日時 >= TODAY()" || query === '更新日時 >= "2026-07-27T00:00:00Z"') {
      return rows.filter((row) =>
        String(row["更新日時"].value) >= "2026-07-27T00:00:00Z"
      );
    }
    if (query === "更新者 not in (LOGINUSER())" || query === '更新者 not in ("rex")') {
      return rows.filter((row) => !JSON.stringify(row["更新者"].value).includes('"code":"rex"'));
    }
  }
  throw new Error(`unexpected records query for APP${app}: ${query}`);
}

function makeClient(): KintoneClient & { readonly calls: GetRecordsParams[] } {
  const calls: GetRecordsParams[] = [];
  return {
    calls,
    async getRecords(params) {
      calls.push({ ...params, fields: [...params.fields] });
      return {
        records: requestedFieldsOnly(
          filterRows(params.app, params.query),
          params.fields
        ),
      };
    },
    async openCursor() { throw new Error("unexpected cursor call"); },
    async postRecords() { throw new Error("unexpected write"); },
    async putRecords() { throw new Error("unexpected write"); },
    async deleteRecords() { throw new Error("unexpected write"); },
    async getApps() { return []; },
    async getFields(appId) {
      if (appId === 77610) {
        return [
          { code: "顧客ID", label: "顧客ID", fieldType: "SINGLE_LINE_TEXT" },
          { code: "日付", label: "日付", fieldType: "DATE" },
          { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
          { code: "作成者", label: "作成者", fieldType: "CREATOR" },
          { code: "担当者", label: "担当者", fieldType: "USER_SELECT" },
          { code: "グループ", label: "グループ", fieldType: "GROUP_SELECT" },
          {
            code: "区分",
            label: "区分",
            fieldType: "DROP_DOWN",
            optionOrder: { A: 0, B: 1 },
          },
        ];
      }
      return [
        { code: "顧客ID", label: "顧客ID", fieldType: "SINGLE_LINE_TEXT" },
        { code: "更新日時", label: "更新日時", fieldType: "UPDATED_TIME" },
        { code: "更新者", label: "更新者", fieldType: "MODIFIER" },
      ];
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const };
    },
  };
}

const joinSql =
  "SELECT a.$id FROM APP77610 a INNER JOIN APP77611 b "
  + "ON a.顧客ID = b.顧客ID WHERE ";

async function rows(sql: string, client: KintoneClient, cacheContext: string) {
  return (await execute(sql, client, { cacheContext }) as SelectResult).rows;
}

test.each([
  [
    "OR",
    "a.日付 = THIS_MONTH() OR a.日付 = LAST_MONTH()",
    "a.日付 >= '2026-06-01' AND a.日付 <= '2026-07-31'",
    "日付 = THIS_MONTH() or 日付 = LAST_MONTH()",
  ],
  [
    "NOT",
    "NOT (a.日付 = THIS_MONTH())",
    "a.日付 < '2026-07-01'",
    "(日付 != THIS_MONTH())",
  ],
] as const)(
  "第5-W %sはwhole WHEREを一度だけ送りresidual null・literal parity・client評価0",
  async (label, functionWhere, literalWhere, expectedQuery) => {
    const functionClient = makeClient();
    const literalClient = makeClient();
    const evaluator = jest.spyOn(evalWhereModule, "evalWhere");
    const functionRows = await rows(
      `${joinSql}${functionWhere}`,
      functionClient,
      `b76-step3-whole-${label}`
    );
    expect(evaluator).not.toHaveBeenCalled();
    evaluator.mockRestore();
    const literalRows = await rows(
      `${joinSql}${literalWhere}`,
      literalClient,
      `b76-step3-whole-literal-${label}`
    );

    expect(functionRows).toEqual(literalRows);
    expect(withoutPaging(
      functionClient.calls.find((call) => call.app === 77610)!.query
    )).toBe(expectedQuery);
  }
);

test("第5-WだけがKLIKE-containing ORを許可し、whole queryでliteral parityを保つ", async () => {
  const functionClient = makeClient();
  const literalClient = makeClient();
  const evaluator = jest.spyOn(evalWhereModule, "evalWhere");
  const functionRows = await rows(
    `${joinSql}a.日付 = THIS_MONTH() OR a.件名 KLIKE 'urgent'`,
    functionClient,
    "b76-step3-whole-klike"
  );
  expect(evaluator).not.toHaveBeenCalled();
  evaluator.mockRestore();
  const literalRows = await rows(
    `${joinSql}a.$id IN (1,2,3)`,
    literalClient,
    "b76-step3-whole-klike-literal"
  );
  expect(functionRows).toEqual(literalRows);
  expect(withoutPaging(
    functionClient.calls.find((call) => call.app === 77610)!.query
  )).toBe('日付 = THIS_MONTH() or 件名 like "urgent"');

  const rejected = makeClient();
  await expect(execute(
    `${joinSql}(a.日付 = THIS_MONTH() OR a.件名 KLIKE 'urgent') `
      + "AND LENGTH(a.件名) > 1",
    rejected,
    { cacheContext: "b76-step3-non-whole-klike-or" }
  )).rejects.toThrow(/WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN/);
  expect(rejected.calls).toEqual([]);
});

test.each([
  [
    "CREATOR IN",
    "a.作成者 IN (LOGINUSER())",
    "a.作成者 IN ('rex')",
    77610,
    "作成者 in (LOGINUSER())",
  ],
  [
    "USER_SELECT IN",
    "a.担当者 IN (LOGINUSER())",
    "a.担当者 IN ('rex')",
    77610,
    "担当者 in (LOGINUSER())",
  ],
  [
    "MODIFIER NOT IN",
    "b.更新者 NOT IN (LOGINUSER())",
    "b.更新者 NOT IN ('rex')",
    77611,
    "更新者 not in (LOGINUSER())",
  ],
] as const)(
  "JOINのLOGINUSER singleton %sをexact pushdownする",
  async (label, functionWhere, literalWhere, expectedApp, expectedQuery) => {
    const functionClient = makeClient();
    const literalClient = makeClient();
    expect(await rows(
      `${joinSql}${functionWhere}`,
      functionClient,
      `b76-step3-login-${label}`
    )).toEqual(await rows(
      `${joinSql}${literalWhere}`,
      literalClient,
      `b76-step3-login-literal-${label}`
    ));
    expect(withoutPaging(
      functionClient.calls.find((call) => call.app === expectedApp)!.query
    )).toBe(expectedQuery);
  }
);

test("複数aliasの関数leafを各APPへ分離しliteral parityを保つ", async () => {
  const functionClient = makeClient();
  const literalClient = makeClient();
  const functionRows = await rows(
    `${joinSql}a.日付 = THIS_MONTH() AND b.更新日時 >= TODAY()`,
    functionClient,
    "b76-step3-multi-alias"
  );
  const literalRows = await rows(
    `${joinSql}a.日付 >= '2026-07-01' AND b.更新日時 >= '2026-07-27T00:00:00Z'`,
    literalClient,
    "b76-step3-multi-alias-literal"
  );
  expect(functionRows).toEqual(literalRows);
  expect(withoutPaging(
    functionClient.calls.find((call) => call.app === 77610)!.query
  )).toBe("日付 = THIS_MONTH()");
  expect(withoutPaging(
    functionClient.calls.find((call) => call.app === 77611)!.query
  )).toBe("更新日時 >= TODAY()");
});

test.each([
  ["GROUP_SELECT", "a.グループ IN (LOGINUSER())"],
  ["cross-alias OR", "a.日付 = THIS_MONTH() OR b.更新日時 >= TODAY()"],
  ["cross-alias NOT", "NOT (a.日付 = THIS_MONTH() AND b.更新日時 >= TODAY())"],
] as const)("%sはrecords API前に拒否する", async (label, predicate) => {
  const client = makeClient();
  await expect(execute(
    `${joinSql}${predicate}`,
    client,
    { cacheContext: `b76-step3-negative-${label}` }
  )).rejects.toThrow(/REQUIRES_EXACT_PUSHDOWN|FIELD_TYPE_UNSUPPORTED/);
  expect(client.calls).toEqual([]);
});

test.each(["LEFT", "RIGHT"] as const)(
  "%s JOINはB79外部結合境界を維持してrecords API前に拒否する",
  async (joinType) => {
    const client = makeClient();
    await expect(execute(
      "SELECT a.$id FROM APP77610 a "
        + `${joinType} JOIN APP77611 b ON a.顧客ID = b.顧客ID `
        + "WHERE a.日付 = THIS_MONTH()",
      client,
      { cacheContext: `b76-step3-outer-${joinType}` }
    )).rejects.toThrow(/WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN/);
    expect(client.calls).toEqual([]);
  }
);
