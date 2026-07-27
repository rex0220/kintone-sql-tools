import { execute, type KintoneClient, type SelectResult } from "../execute";
import { runQuery } from "../engine-library/query";
import * as joinPushdownModule from "../core/optimization/joinPredicatePushdown";

type GetRecordsParams = Parameters<KintoneClient["getRecords"]>[0];

function withoutPaging(query: string): string {
  return query.replace(/(?:^|\s+)order by \$id asc limit 500 offset \d+$/, "");
}

const knownQueryParts = [
  "日付",
  "更新日時",
  "作成者",
  "更新者",
  "担当者",
  "件名",
  "顧客ID in",
] as const;

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
      const query = withoutPaging(params.query);
      if (query !== "" && !knownQueryParts.some((part) => query.includes(part))) {
        throw new Error(`unexpected records query for APP${params.app}: ${query}`);
      }
      calls.push({ ...params, fields: [...params.fields] });
      return { records: [], searchAborted: options.searchAborted };
    },
    async openCursor() { throw new Error("unexpected cursor call"); },
    async postRecords() { throw new Error("unexpected write"); },
    async putRecords() { throw new Error("unexpected write"); },
    async deleteRecords() { throw new Error("unexpected write"); },
    async getApps() { return []; },
    async getFields(appId) {
      fieldCalls.push(appId);
      if (appId === 77620) {
        return [
          { code: "顧客ID", label: "顧客ID", fieldType: "SINGLE_LINE_TEXT" },
          { code: "日付", label: "日付", fieldType: "DATE" },
          { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
          { code: "作成者", label: "作成者", fieldType: "CREATOR" },
          { code: "担当者", label: "担当者", fieldType: "USER_SELECT" },
          { code: "グループ", label: "グループ", fieldType: "GROUP_SELECT" },
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

const innerJoin =
  "SELECT a.$id FROM APP77620 a INNER JOIN APP77621 b "
  + "ON a.顧客ID = b.顧客ID WHERE ";

function planText(result: SelectResult): string {
  return result.rows.map((row) => row.plan).join("\n");
}

async function runtimeAllowed(sql: string, cacheContext: string): Promise<{
  readonly allowed: boolean;
  readonly calls: number;
  readonly error: string;
}> {
  const client = makeClient();
  try {
    await execute(sql, client, { cacheContext });
    return { allowed: true, calls: client.calls.length, error: "" };
  } catch (error) {
    return { allowed: false, calls: client.calls.length, error: String(error) };
  }
}

async function explainAllowed(sql: string, cacheContext: string): Promise<{
  readonly allowed: boolean;
  readonly calls: number;
  readonly text: string;
}> {
  const client = makeClient();
  try {
    const text = planText(await execute(
      `EXPLAIN ${sql}`,
      client,
      { cacheContext }
    ) as SelectResult);
    return {
      allowed: !text.includes("plan status: rejected"),
      calls: client.calls.length,
      text,
    };
  } catch (error) {
    return { allowed: false, calls: client.calls.length, text: String(error) };
  }
}

test.each([
  ["第5-L main relative", `${innerJoin}a.日付 = THIS_MONTH()`, true],
  ["第5-L JOIN relative", `${innerJoin}b.更新日時 >= TODAY()`, true],
  [
    "第5-L residual",
    `${innerJoin}a.日付 = THIS_MONTH() AND LENGTH(a.件名) > 1`,
    true,
  ],
  [
    "第5-L multiple aliases",
    `${innerJoin}a.日付 = THIS_MONTH() AND b.更新日時 >= TODAY()`,
    true,
  ],
  [
    "第5-W same-alias OR",
    `${innerJoin}a.日付 = THIS_MONTH() OR a.日付 = LAST_MONTH()`,
    true,
  ],
  ["第5-W NOT", `${innerJoin}NOT (a.日付 = THIS_MONTH())`, true],
  [
    "第5-W KLIKE OR",
    `${innerJoin}a.日付 = THIS_MONTH() OR a.件名 KLIKE 'urgent'`,
    true,
  ],
  ["LOGINUSER CREATOR", `${innerJoin}a.作成者 IN (LOGINUSER())`, true],
  ["LOGINUSER USER_SELECT", `${innerJoin}a.担当者 IN (LOGINUSER())`, true],
  ["LOGINUSER MODIFIER", `${innerJoin}b.更新者 NOT IN (LOGINUSER())`, true],
  [
    "mixed function sets",
    `${innerJoin}a.日付 = THIS_MONTH() AND b.更新者 NOT IN (LOGINUSER())`,
    true,
  ],
  [
    "cross-alias OR",
    `${innerJoin}a.日付 = THIS_MONTH() OR b.更新日時 >= TODAY()`,
    false,
  ],
  ["GROUP_SELECT", `${innerJoin}a.グループ IN (LOGINUSER())`, false],
  [
    "LEFT JOIN",
    "SELECT a.$id FROM APP77620 a LEFT JOIN APP77621 b "
      + "ON a.顧客ID = b.顧客ID WHERE a.日付 = THIS_MONTH()",
    false,
  ],
  [
    "non-whole KLIKE OR",
    `${innerJoin}(a.日付 = THIS_MONTH() OR a.件名 KLIKE 'urgent') `
      + "AND LENGTH(a.件名) > 1",
    false,
  ],
] as const)(
  "B76 Phase B Step 4 decision parity: %s",
  async (label, sql, expectedAllowed) => {
    const runtime = await runtimeAllowed(sql, `b76-step4-run-${label}`);
    const explained = await explainAllowed(sql, `b76-step4-explain-${label}`);

    expect(runtime.allowed).toBe(expectedAllowed);
    expect(explained.allowed).toBe(expectedAllowed);
    expect(explained.calls).toBe(0);
    if (expectedAllowed) {
      expect(runtime.calls).toBeGreaterThan(0);
      expect(explained.text).toContain("JOIN_SERVER_FUNCTION_EXACT");
    } else {
      expect(runtime.calls).toBe(0);
      expect(explained.text).toMatch(
        /REQUIRES_EXACT_PUSHDOWN|FIELD_TYPE_UNSUPPORTED/
      );
    }
  }
);

test("B76 Phase B Step 4 renderer は共有 plan の alias/query/relation/consumption/residual を表示する", async () => {
  const bindSpy = jest.spyOn(joinPushdownModule, "bindJoinServerFunctionFetches");
  const client = makeClient();
  const text = planText(await execute(
    `EXPLAIN ${innerJoin}a.日付 = THIS_MONTH() AND b.更新者 NOT IN (LOGINUSER())`,
    client,
    { cacheContext: "b76-step4-shared-render-plan" }
  ) as SelectResult);

  expect(bindSpy).toHaveBeenCalledTimes(1);
  expect(client.calls).toEqual([]);
  expect(text).toContain("join pushdown plan: applied (runtime metadata resolved)");
  expect(text).toContain("allow form: JOIN_SERVER_FUNCTION_EXACT (leaf)");
  expect(text).toContain("target alias / APP: a / APP77620");
  expect(text).toContain("target alias / APP: b / APP77621");
  expect(text).toContain("pushdown applied: 日付 = THIS_MONTH()");
  expect(text).toContain("pushdown applied: 更新者 not in (LOGINUSER())");
  expect(text).toContain("function leaf relation: function-leaf-exact");
  expect(text).toContain("consumption: leaf");
  expect(text).toContain("client residual: (none)");
  expect(text).toContain("KLIKE applied nodes: 0");
  expect(text).toContain("KLIKE unapplied nodes: 0");
  expect(text.match(/relative date client evaluations: 0/g)).toHaveLength(1);
  expect(text.match(/kintone function client evaluations: 0/g)).toHaveLength(1);
  bindSpy.mockRestore();
});

test("B76 Phase B Step 4 rejected renderer は関数・alias/field・reason・API 0を表示する", async () => {
  const client = makeClient();
  const text = planText(await execute(
    `EXPLAIN ${innerJoin}a.グループ IN (LOGINUSER())`,
    client,
    { cacheContext: "b76-step4-rejected-render-plan" }
  ) as SelectResult);

  expect(client.calls).toEqual([]);
  expect(text).toContain("kintone function: LOGINUSER");
  expect(text).toContain("target alias / field: a / グループ");
  expect(text).toContain("WHERE_KINTONE_FUNCTION_FIELD_TYPE_UNSUPPORTED");
  expect(text).toContain("WHERE_KINTONE_FUNCTION_REQUIRES_EXACT_PUSHDOWN");
  expect(text).toContain("client evaluation: forbidden");
  expect(text).toContain("records/cursor/mutation API during EXPLAIN: none");
});

test("B76 Phase B Step 4 limit policy は同値 literal と同じ既存 complete-input 表示を使う", async () => {
  const functionSql = `${innerJoin}a.日付 = THIS_MONTH() ORDER BY a.$id`;
  const literalSql = `${innerJoin}a.日付 >= '2026-07-01' ORDER BY a.$id`;
  const functionText = (await explainAllowed(
    functionSql,
    "b76-step4-limit-function"
  )).text;
  const literalText = (await explainAllowed(
    literalSql,
    "b76-step4-limit-literal"
  )).text;
  const policyLines = (text: string) => text.split("\n").filter((line) =>
    line.includes("complete input")
    || line.includes("onLimit=truncate")
  );

  expect(policyLines(functionText)).toEqual(policyLines(literalText));
  expect(functionText).not.toContain("JOIN_SERVER_FUNCTION_COMPLETE_INPUT");
});

test("B76 Phase B Step 4 searchAborted は INNER warning、engine library hard errorを維持する", async () => {
  const sql = `${innerJoin}a.日付 = THIS_MONTH()`;
  const literalSql = `${innerJoin}a.日付 >= '2026-07-01'`;
  const functionClient = makeClient({ searchAborted: true });
  const literalClient = makeClient({ searchAborted: true });
  const functionResult = await execute(
    sql,
    functionClient,
    { cacheContext: "b76-step4-abort-function" }
  ) as SelectResult;
  const literalResult = await execute(
    literalSql,
    literalClient,
    { cacheContext: "b76-step4-abort-literal" }
  ) as SelectResult;

  expect(functionResult.warnings).toEqual(literalResult.warnings);
  expect(functionResult.warnings?.some((warning) => warning.includes("打ち切"))).toBe(true);

  const libraryClient = makeClient({ searchAborted: true });
  await expect(runQuery(sql, { client: libraryClient }))
    .rejects.toMatchObject({ code: "SEARCH_ABORTED" });
  expect(libraryClient.calls).toHaveLength(1);
});
