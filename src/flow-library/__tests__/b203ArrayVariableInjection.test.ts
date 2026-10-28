import {
  createExecutionContext,
  disposeExecutionContext,
  executeStatement,
  explainScript,
  parseScript,
  type FlowKintoneClient,
} from "../index";

type Rec = Record<string, { value: unknown }>;

/** APP1 = 読み取り元（$id 1..3）、APP2 = APPLY の親（サブテーブル 明細）。 */
const srcFields = [
  { code: "担当者", label: "担当者", fieldType: "SINGLE_LINE_TEXT", writable: true },
  { code: "金額", label: "金額", fieldType: "NUMBER", writable: true },
];
const aggFields = [
  { code: "キー", label: "キー", fieldType: "SINGLE_LINE_TEXT", writable: true, isUnique: true },
  { code: "明細", label: "明細", fieldType: "SUBTABLE", writable: false },
  { code: "受注番号", label: "受注番号", fieldType: "SINGLE_LINE_TEXT", writable: true, inSubtable: true, subtableCode: "明細" },
  { code: "金額", label: "金額", fieldType: "NUMBER", writable: true, inSubtable: true, subtableCode: "明細" },
];

const srcRecords: Rec[] = [
  { $id: { value: "311" }, $revision: { value: "1" }, 担当者: { value: "a" }, 金額: { value: "30" } },
  { $id: { value: "301" }, $revision: { value: "1" }, 担当者: { value: "b" }, 金額: { value: "10" } },
  { $id: { value: "295" }, $revision: { value: "1" }, 担当者: { value: "c" }, 金額: { value: "20" } },
];
const aggRecords = (): Rec[] => [{
  $id: { value: "1" }, $revision: { value: "1" }, キー: { value: "K1" },
  明細: { value: [{ id: "11", value: { 受注番号: { value: "old" }, 金額: { value: "1" } } }] },
}];

function mockClient() {
  const queries: Array<{ app: number; query: string }> = [];
  const putRecords = jest.fn(async (_params: unknown) => undefined);
  const postRecords = jest.fn(async ({ records }: { records: unknown[] }) => ({
    ids: records.map((_, index) => String(900 + index)),
  }));
  const deleteRecords = jest.fn(async (_params: unknown) => undefined);
  /** 押し下げが効いていることを書込側でも見るため、モックも $id in (...) を絞る。 */
  const rowsOf = (app: number, query = ""): Rec[] => {
    if (app === 2) return aggRecords();
    const match = /\$id (not )?in \(([^)]*)\)/.exec(query);
    if (!match) return srcRecords;
    const ids = new Set([...match[2].matchAll(/"([^"]*)"/g)].map((item) => item[1]));
    return srcRecords.filter((record) => ids.has(String(record.$id.value)) !== Boolean(match[1]));
  };
  const value = {
    async getRecords(params: { app: number; query: string; totalCount?: boolean }) {
      queries.push({ app: params.app, query: params.query });
      const records = rowsOf(params.app, params.query);
      return params.totalCount ? { records, totalCount: String(records.length) } : { records };
    },
    async openCursor(params: { app: number; query: string }) {
      queries.push({ app: params.app, query: params.query });
      const records = rowsOf(params.app, params.query);
      return { totalCount: records.length, async nextPage() { return { records, next: false }; }, async close() {} };
    },
    postRecords,
    putRecords,
    deleteRecords,
    async getApps() { return []; },
    async getFields(appId: number) { return appId === 2 ? aggFields : srcFields; },
    async getNumberPrecision() { return { digits: 16, decimalPlaces: 4, roundingMode: "HALF_EVEN" as const }; },
    async getProcessStatuses() { return { enable: false, states: null }; },
  } as unknown as FlowKintoneClient;
  const writes = () => putRecords.mock.calls.length + postRecords.mock.calls.length + deleteRecords.mock.calls.length;
  return { value, queries, putRecords, writes };
}

const header = "-- @ksql dialect: 1\n";
const selectSql = `${header}DECLARE @ids = [];\nSELECT 担当者 FROM APP1 WHERE $id IN @ids;`;

async function runScript(sql: string, options: Record<string, unknown> = {}) {
  const mock = mockClient();
  const parsed = parseScript(sql);
  const errors = parsed.diagnostics.filter((item) => item.severity === "error");
  if (errors.length > 0) return { mock, parseErrors: errors, results: [] };
  const context = createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta, ...options,
  });
  const results = [];
  for (const statement of parsed.statements) results.push(await executeStatement(statement, context));
  await disposeExecutionContext(context);
  return { mock, parseErrors: [], results };
}

test("AC1 配列を注入すると IN @list が in (\"…\") に押し下がる", async () => {
  const { mock, results } = await runScript(selectSql, { variables: { ids: ["311", "301"] } });
  expect(results.map((item) => item.status)).toEqual(["success", "success"]);
  expect(mock.queries).toEqual([{ app: 1, query: '$id in ("311","301") order by $id asc limit 500 offset 0' }]);
});

test("AC1 補足: DECLARE の既定値の配列は注入が無いときに使われる", async () => {
  const { mock, results } = await runScript(
    `${header}DECLARE @ids = ['295'];\nSELECT 担当者 FROM APP1 WHERE $id IN @ids;`
  );
  expect(results.every((item) => item.status === "success")).toBe(true);
  expect(mock.queries[0].query).toContain('$id in ("295")');
});

test("AC2 空配列は 0 件・kintone を読まない・書込 0", async () => {
  const { mock, results } = await runScript(
    `${header}DECLARE @ids = [];\nUPDATE APP1 SET 担当者 = 'x' WHERE $id IN @ids;`,
    { variables: { ids: [] } }
  );
  expect(results.map((item) => item.status)).toEqual(["success", "success"]);
  expect(mock.queries).toEqual([]);
  expect(mock.writes()).toBe(0);
});

test("AC3 配列をスカラーの位置に書いたら createExecutionContext が止める（読み書き 0 回）", () => {
  const mock = mockClient();
  const parsed = parseScript(`${header}DECLARE @ids = [];\nSELECT 担当者 FROM APP1 WHERE 担当者 = @ids;`);
  expect(parsed.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  expect(() => createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta, variables: { ids: ["a"] },
  })).toThrow(/array variable @ids can only be used as IN @ids/);
  expect(mock.queries).toEqual([]);
  expect(mock.writes()).toBe(0);
});

test("AC4 スカラーを IN @list に書いた既存のエラーは変わらない", () => {
  const mock = mockClient();
  const parsed = parseScript(`${header}DECLARE @ids = '';\nSELECT 担当者 FROM APP1 WHERE $id IN @ids;`);
  expect(() => createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta,
  })).toThrow("ParseError: scalar variable @ids cannot be used as IN @ids; use IN (@ids) instead.");
});

test("AC5 NOT IN @list も同じ規則で押し下がる", async () => {
  const { mock, results } = await runScript(
    `${header}DECLARE @ids = [];\nSELECT 担当者 FROM APP1 WHERE $id NOT IN @ids;`,
    { variables: { ids: ["311"] } }
  );
  expect(results.every((item) => item.status === "success")).toBe(true);
  expect(mock.queries[0].query).toContain('$id not in ("311")');
});

test("AC5 補足: 空配列の NOT IN が DML の対象 WHERE を全件真にする形は従来どおり拒否", async () => {
  const { mock, results } = await runScript(
    `${header}DECLARE @ids = [];\nUPDATE APP1 SET 担当者 = 'x' WHERE $id NOT IN @ids;`,
    { variables: { ids: [] } }
  );
  expect(results[1].status).toBe("error");
  expect(results[1].error?.message).toContain("empty-array simplification makes the target WHERE always true");
  expect(mock.writes()).toBe(0);
});

describe("AC6 要素数の上限", () => {
  const sql = (n: number) => ({ ids: Array.from({ length: n }, (_, i) => String(i)) });

  test("既定は 500 まで通る", async () => {
    const { results } = await runScript(selectSql, { variables: sql(500) });
    expect(results.every((item) => item.status === "success")).toBe(true);
  });

  test("既定を超えると createExecutionContext が ArgumentError", () => {
    const mock = mockClient();
    const parsed = parseScript(selectSql);
    expect(() => createExecutionContext({
      client: mock.value, statements: parsed.statements, meta: parsed.meta, variables: sql(501),
    })).toThrow(/array variable @ids has 501 elements \(injected value\) and exceeds variableArrayMaxElements \(500\)/);
    expect(mock.queries).toEqual([]);
  });

  test("variableArrayMaxElements で下げられる", () => {
    const mock = mockClient();
    const parsed = parseScript(selectSql);
    expect(() => createExecutionContext({
      client: mock.value, statements: parsed.statements, meta: parsed.meta,
      variables: sql(201), variableArrayMaxElements: 200,
    })).toThrow(/exceeds variableArrayMaxElements \(200\)/);
  });

  test("DECLARE の既定値の配列にも効く", () => {
    const mock = mockClient();
    const list = Array.from({ length: 3 }, (_, i) => `'${i}'`).join(",");
    const parsed = parseScript(`${header}DECLARE @ids = [${list}];\nSELECT 担当者 FROM APP1 WHERE $id IN @ids;`);
    expect(() => createExecutionContext({
      client: mock.value, statements: parsed.statements, meta: parsed.meta, variableArrayMaxElements: 2,
    })).toThrow(/has 3 elements \(DECLARE default\) and exceeds variableArrayMaxElements \(2\)/);
  });

  test("variableArrayMaxElements が正の整数でなければ RangeError", () => {
    const mock = mockClient();
    const parsed = parseScript(selectSql);
    expect(() => createExecutionContext({
      client: mock.value, statements: parsed.statements, meta: parsed.meta, variableArrayMaxElements: 0,
    })).toThrow(/variableArrayMaxElements must be a positive safe integer/);
  });
});

test("AC7 APPEND ... SELECT のソースの WHERE で使える", async () => {
  const { mock, results } = await runScript(
    `${header}DECLARE @ids = [];\n`
    + "UPDATE APP2 SET キー = 'K1' WHERE キー = 'K1'\n"
    + " APPLY 明細 (\n"
    + "   REMOVE ALL ROWS;\n"
    + "   APPEND (受注番号, 金額) SELECT $id, 金額 FROM APP1 WHERE $id IN @ids ORDER BY $id\n"
    + " );",
    { variables: { ids: ["311", "301"] }, allowApplyMutation: true, confirm: () => true }
  );
  expect(results.map((item) => item.status)).toEqual(["success", "success"]);
  expect(mock.queries.some((item) => item.app === 1 && item.query.includes('$id in ("311","301")'))).toBe(true);
  const rows = (mock.putRecords.mock.calls[0][0] as { records: { record: Rec }[] })
    .records[0].record["明細"]?.value as Array<{ value: Rec }>;
  expect(rows.map((row) => [row.value["受注番号"]?.value, row.value["金額"]?.value]))
    .toEqual([["301", "10"], ["311", "30"]]);
});

describe("AC8 既存の文字列注入は不変", () => {
  test("スカラーの注入はそのまま", async () => {
    const { mock, results } = await runScript(
      `${header}DECLARE @who = '';\nSELECT 金額 FROM APP1 WHERE 担当者 = @who;`,
      { variables: { who: "a" } }
    );
    expect(results.every((item) => item.status === "success")).toBe(true);
    expect(mock.queries[0].query).toContain('担当者 = "a"');
  });

  test("宣言と注入の種類が食い違えば ArgumentError（配列の宣言に文字列）", () => {
    const mock = mockClient();
    const parsed = parseScript(selectSql);
    expect(() => createExecutionContext({
      client: mock.value, statements: parsed.statements, meta: parsed.meta, variables: { ids: "311" },
    })).toThrow(/@ids is declared as an array/);
  });

  test("宣言と注入の種類が食い違えば ArgumentError（スカラーの宣言に配列）", () => {
    const mock = mockClient();
    const parsed = parseScript(`${header}DECLARE @who = '';\nSELECT 金額 FROM APP1 WHERE 担当者 = @who;`);
    expect(() => createExecutionContext({
      client: mock.value, statements: parsed.statements, meta: parsed.meta,
      variables: { who: ["a", "b"] },
    })).toThrow(/@who is declared as a scalar/);
  });

  test("RELATIVE_DATE の宣言に配列は注入できない", () => {
    const mock = mockClient();
    const parsed = parseScript(`${header}DECLARE @d RELATIVE_DATE = TODAY();\nSELECT 金額 FROM APP1 WHERE 担当者 = 'a';`);
    expect(() => createExecutionContext({
      client: mock.value, statements: parsed.statements, meta: parsed.meta, variables: { d: ["TODAY()"] },
    })).toThrow(/@d is declared as RELATIVE_DATE/);
  });

  test.each([
    ["数値を含む配列", [1]],
    ["null を含む配列", [null]],
    ["入れ子の配列", [["a"]]],
    ["数値", 7],
  ])("文字列以外は ArgumentError: %s", (_label, injected) => {
    const mock = mockClient();
    const parsed = parseScript(selectSql);
    expect(() => createExecutionContext({
      client: mock.value, statements: parsed.statements, meta: parsed.meta,
      variables: { ids: injected } as never,
    })).toThrow(/must be (an array of strings|a string or an array of strings)/);
  });
});

test("宣言していない名前への注入は従来どおり ArgumentError", () => {
  const mock = mockClient();
  const parsed = parseScript(selectSql);
  expect(() => createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta,
    variables: { ids: ["a"], other: ["b"] },
  })).toThrow("ArgumentError: injected variable @other is not declared.");
});

test("EXPLAIN でも配列の宣言は配列として計画される", async () => {
  const mock = mockClient();
  const result = await explainScript(selectSql, { client: mock.value, variables: { ids: ["311", "301"] } });
  const plan = result.statements[1].plan.join("\n");
  expect(plan).toContain('$id in ("311","301")');
});

test("EXPLAIN は注入が無くても既定値の配列で計画できる", async () => {
  const mock = mockClient();
  const result = await explainScript(
    `${header}DECLARE @ids = ['295'];\nSELECT 担当者 FROM APP1 WHERE $id IN @ids;`,
    { client: mock.value }
  );
  expect(result.statements[1].plan.join("\n")).toContain('$id in ("295")');
});
