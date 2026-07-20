import { execute, executeBatch, type KintoneClient, type KintoneFieldInfo, type SelectResult } from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";
import { Lexer } from "../lexer/lexer";
import { Parser, ParseError } from "../parser/parser";
import { analyzeBatch } from "../core/batch";
import { isDmlType, isReadOnlyType, requiresCompleteInput, writesKintone } from "../core/dmlGuard";
import { renderExistingValidationValue } from "../core/existingRecordValidation";
import { parseSqlStatements } from "../core/sql";

function record(values: Record<string, unknown>): KintoneRecord {
  return Object.fromEntries(Object.entries(values).map(([code, value]) => [code, { value }])) as KintoneRecord;
}

const BASE_FIELDS: KintoneFieldInfo[] = [
  { code: "requiredText", label: "requiredText", fieldType: "SINGLE_LINE_TEXT", required: true },
  { code: "requiredUser", label: "requiredUser", fieldType: "USER_SELECT", required: true },
  { code: "requiredOrg", label: "requiredOrg", fieldType: "ORGANIZATION_SELECT", required: true },
  { code: "requiredGroup", label: "requiredGroup", fieldType: "GROUP_SELECT", required: true },
  { code: "requiredMulti", label: "requiredMulti", fieldType: "MULTI_SELECT", required: true, optionOrder: { A: 0 } },
  { code: "n", label: "n", fieldType: "NUMBER", minValue: "1", maxValue: "99" },
  { code: "freeNumber", label: "freeNumber", fieldType: "NUMBER" },
  { code: "shortText", label: "shortText", fieldType: "SINGLE_LINE_TEXT", minLength: "2", maxLength: "4" },
  { code: "choice", label: "choice", fieldType: "DROP_DOWN", optionOrder: { A: 0, B: 1 } },
  { code: "plain", label: "plain", fieldType: "SINGLE_LINE_TEXT" },
  { code: "table", label: "table", fieldType: "SUBTABLE" },
  { code: "child", label: "child", fieldType: "NUMBER", inSubtable: true, subtableCode: "table" },
  { code: "created", label: "created", fieldType: "CREATED_TIME", writable: false },
];

function makeClient(options: {
  fields?: KintoneFieldInfo[];
  records?: KintoneRecord[];
  precision?: { digits: number; decimalPlaces: number; roundingMode: "HALF_EVEN" };
} = {}) {
  const calls = {
    get: [] as Array<{ query: string; fields: string[] }>,
    fields: 0,
    precision: 0,
    post: 0,
    put: 0,
    delete: 0,
    cursor: 0,
  };
  const client: KintoneClient = {
    async getRecords(params) {
      calls.get.push({ query: params.query ?? "", fields: [...(params.fields ?? [])] });
      return { records: options.records ?? [] };
    },
    async openCursor() { calls.cursor++; throw new Error("Cursor API must not be used"); },
    async postRecords() { calls.post++; return { ids: [] }; },
    async putRecords() { calls.put++; },
    async deleteRecords() { calls.delete++; },
    async getApps() { return []; },
    async getFields() { calls.fields++; return options.fields ?? BASE_FIELDS; },
    async getNumberPrecision() {
      calls.precision++;
      return options.precision ?? { digits: 4, decimalPlaces: 2, roundingMode: "HALF_EVEN" };
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
  };
  return { client, calls };
}

function parse(sql: string) {
  return new Parser(new Lexer(sql).tokenize()).parse();
}

test("parser separates leading VALIDATE from DML VALIDATE ONLY and supports EXPLAIN", () => {
  const stmt = parse("VALIDATE APP41 (n, shortText) WHERE n BETWEEN 1 AND 9 CHECK WHEN n > 5 THEN 'high' INTO #err");
  expect(stmt).toMatchObject({
    type: "VALIDATE", appId: 41, targets: [
      { kind: "FIELD", field: "n" }, { kind: "FIELD", field: "shortText" },
    ], errorTable: "#err",
    where: { type: "LOGICAL", op: "AND" },
  });
  if (stmt.type === "VALIDATE") expect(stmt.checkGroups?.[0].rules).toHaveLength(1);
  expect(parse("INSERT INTO APP41 (n) VALUES (1) VALIDATE ONLY")).toMatchObject({ type: "INSERT", validateOnly: true });
  expect(parse("EXPLAIN VALIDATE APP41")).toMatchObject({ type: "EXPLAIN", query: { type: "VALIDATE", appId: 41 } });
});

test("read-only classification requires complete input without being DML", () => {
  const stmt = parse("VALIDATE APP41");
  expect(isReadOnlyType(stmt.type)).toBe(true);
  expect(isDmlType(stmt.type)).toBe(false);
  expect(writesKintone(stmt)).toBe(false);
  expect(requiresCompleteInput(stmt)).toBe(true);
  expect(analyzeBatch([stmt]).isReadOnlyBatch).toBe(true);
});

test("raw values catch empty USER/ORG/GROUP/MULTI selections and render empty values as empty strings", async () => {
  const { client, calls } = makeClient({ records: [record({
    $id: "1", requiredText: "ok", requiredUser: [], requiredOrg: [], requiredGroup: [], requiredMulti: [],
    n: "10", freeNumber: "1", shortText: "okay", choice: "A", plain: "x",
  })] });
  const result = await execute("VALIDATE APP41", client, { cacheContext: "b41-raw-empty" }) as SelectResult;
  expect(result.rows.map((row) => [row.$err_field, row.$err_code, row.$err_value])).toEqual([
    ["requiredUser", "ERR_REQUIRED", ""],
    ["requiredOrg", "ERR_REQUIRED", ""],
    ["requiredGroup", "ERR_REQUIRED", ""],
    ["requiredMulti", "ERR_REQUIRED", ""],
  ]);
  expect(calls).toMatchObject({ post: 0, put: 0, delete: 0, cursor: 0, precision: 1 });
});

test("built-in range, length, choice, B29 precision and non-empty raw rendering", async () => {
  const { client } = makeClient({ records: [record({
    $id: "7", requiredText: "ok", requiredUser: [{ code: "u1", name: "User" }],
    requiredOrg: [{ code: "o1", name: "Org" }], requiredGroup: [{ code: "g1", name: "Group" }],
    requiredMulti: ["A"], n: "100", freeNumber: "123", shortText: "x", choice: "Z", plain: "x",
  })] });
  const result = await execute("VALIDATE APP41", client, { cacheContext: "b41-builtins" }) as SelectResult;
  expect(result.rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ $id: "7", $err_field: "n", $err_code: "ERR_RANGE_MAX", $err_value: "100" }),
    expect.objectContaining({ $err_field: "freeNumber", $err_code: "ERR_NUMBER_INTEGER_DIGITS", $err_value: "123" }),
    expect.objectContaining({ $err_field: "shortText", $err_code: "ERR_LENGTH_MIN", $err_value: "x" }),
    expect.objectContaining({ $err_field: "choice", $err_code: "ERR_CHOICE_INVALID", $err_value: "Z" }),
  ]));
});

test("B41 value renderer keeps empty selections blank and non-empty USER values code-only", () => {
  expect(renderExistingValidationValue([], "USER_SELECT")).toBe("");
  expect(renderExistingValidationValue([{ code: "u1", name: "User 1" }], "USER_SELECT")).toBe('["u1"]');
  expect(renderExistingValidationValue("001.20", "NUMBER")).toBe("001.20");
});

test("omitted fields include constraints plus every top-level NUMBER; explicit target errors are fail-fast", async () => {
  const omitted = makeClient({ records: [record({ $id: "1", requiredText: "", freeNumber: "123" })] });
  const result = await execute("VALIDATE APP41", omitted.client, { cacheContext: "b41-auto-target" }) as SelectResult;
  expect(result.rows.map((row) => row.$err_field)).toEqual(expect.arrayContaining(["requiredText", "freeNumber"]));

  for (const [sql, message] of [
    ["VALIDATE APP41 (missing)", "存在しません"],
    ["VALIDATE APP41 (n,n)", "重複"],
    ["VALIDATE APP41 (child)", "T(child) 形式"],
    ["VALIDATE APP41 ($id)", "システムフィールド"],
    ["VALIDATE APP41 (plain)", "監査可能な制約"],
    ["VALIDATE APP41 (created)", "監査可能な制約"],
  ] as const) {
    const current = makeClient();
    await expect(execute(sql, current.client, { cacheContext: `b41-target-${sql}` })).rejects.toThrow(message);
    expect(current.calls.get).toHaveLength(0);
  }
});

test("CHECK uses flat rows and emits blank field/value with one error per matching group", async () => {
  const { client } = makeClient({ records: [record({ $id: "1", n: "10", shortText: "ok", plain: "P" })] });
  const result = await execute(
    "VALIDATE APP41 (n) CHECK WHEN n > 5 THEN 'n=' || n CHECK WHEN plain = 'P' THEN 'plain'",
    client,
    { cacheContext: "b41-check" }
  ) as SelectResult;
  expect(result.rows.map((row) => [row.$err_field, row.$err_code, row.$err_message, row.$err_value])).toEqual([
    ["", "ERR_CHECK", "n=10", ""], ["", "ERR_CHECK", "plain", ""],
  ]);
});

test.each([
  "VALIDATE APP41 WHERE plain KLIKE 'x'",
  "VALIDATE APP41 WHERE $id IN (SELECT $id FROM APP42)",
  "VALIDATE APP41 WHERE EXISTS (SELECT $id FROM APP42)",
  "VALIDATE APP41 WHERE n = (SELECT n FROM APP42)",
  "VALIDATE APP41 WHERE APP41.n > 0",
  "VALIDATE APP41 CHECK WHEN APP41.n > 0 THEN 'bad'",
])("WHERE/CHECK v1 static rejection: %s", (sql) => {
  expect(() => analyzeBatch([parse(sql)])).toThrow();
});

test.each([
  ["n BETWEEN 1 AND 20", ["1", "2"]],
  ["n > 15", ["2", "3"]],
  ["n IN (10,30)", ["1", "3"]],
  ["choice IN ('A')", ["1"]],
  ["plain IS NULL", ["2"]],
  ["plain LIKE '%x%'", ["1"]],
])("allowed WHERE %s is always re-evaluated locally", async (where, ids) => {
  const { client } = makeClient({ records: [
    record({ $id: "1", n: "10", requiredText: "", plain: "xx", choice: "A" }),
    record({ $id: "2", n: "20", requiredText: "", plain: "", choice: "B" }),
    record({ $id: "3", n: "30", requiredText: "", plain: "yy", choice: "B" }),
  ] });
  const result = await execute(`VALIDATE APP41 (requiredText) WHERE ${where}`, client, { cacheContext: `b41-where-${where}` }) as SelectResult;
  expect(result.rows.map((row) => row.$id)).toEqual(ids);
});

test("prefilter uses exact WHERE or safe AND leaves, then applies the original predicate locally", async () => {
  const exact = makeClient({ records: [record({ $id: "1", n: "10", requiredText: "" })] });
  await execute("VALIDATE APP41 (requiredText) WHERE n > 0", exact.client, { cacheContext: "b41-prefilter-exact" });
  expect(exact.calls.get[0].query).toContain("n > 0");

  const residual = makeClient({ records: [
    record({ $id: "1", n: "10", requiredText: "", plain: "no" }),
    record({ $id: "2", n: "20", requiredText: "", plain: "x" }),
  ] });
  const result = await execute(
    "VALIDATE APP41 (requiredText) WHERE n > 0 AND plain LIKE '%x%'",
    residual.client,
    { cacheContext: "b41-prefilter-safe-leaf" }
  ) as SelectResult;
  expect(residual.calls.get[0].query).toContain("n > 0");
  expect(residual.calls.get[0].query).not.toContain("plain");
  expect(result.rows.map((row) => row.$id)).toEqual(["2"]);
});

test("single result preserves fixed columns at zero errors and single INTO is rejected", async () => {
  const valid = makeClient({ fields: [{ code: "n", label: "n", fieldType: "NUMBER" }], records: [record({ $id: "1", n: "1" })] });
  const result = await execute("VALIDATE APP41", valid.client, { cacheContext: "b41-empty" }) as SelectResult;
  expect(result).toMatchObject({ type: "SELECT", rowCount: 0, rows: [], columns: [
    "$id", "$err_field", "$err_code", "$err_message", "$err_value", "$err_subtable", "$err_subrow", "$err_subrow_id", "$err_count",
  ], validateStats: { errorRecords: 0, errorCount: 0 } });
  await expect(execute("VALIDATE APP41 INTO #err", valid.client, { cacheContext: "b41-single-into" }))
    .rejects.toThrow("requires a batch");
});

test("batch INTO materializes the fixed nine columns with locator and count metadata", async () => {
  const { client } = makeClient({ records: [record({ $id: "2", requiredText: "", n: "100" })] });
  const batch = await executeBatch(
    "VALIDATE APP41 (requiredText,n) INTO #err; SELECT $id,$err_field,$err_code,$err_message,$err_value,$err_subtable,$err_subrow,$err_subrow_id,$err_count FROM #err ORDER BY $id",
    client,
    { cacheContext: "b41-batch-into" }
  );
  expect(batch.ok).toBe(true);
  expect((batch.statements[1].result as SelectResult).columns).toEqual([
    "$id", "$err_field", "$err_code", "$err_message", "$err_value", "$err_subtable", "$err_subrow", "$err_subrow_id", "$err_count",
  ]);
  expect((batch.statements[1].result as SelectResult).rows).toHaveLength(2);
  expect((batch.statements[0].result as SelectResult).validateStats).toEqual({ errorRecords: 1, errorCount: 2 });
  expect((batch.statements[1].result as SelectResult).validateStats).toBeUndefined();
});

test("maxRecords is fail-closed even when truncate is requested and no write API is called", async () => {
  const limited = makeClient({ records: [record({ $id: "1", n: "1" }), record({ $id: "2", n: "2" })] });
  await expect(execute("VALIDATE APP41", limited.client, {
    cacheContext: "b41-limit", maxRecords: 1, onLimitReached: "truncate",
  })).rejects.toThrow("取得件数が上限");
  expect(limited.calls).toMatchObject({ post: 0, put: 0, delete: 0, cursor: 0 });
});

test("EXPLAIN VALIDATE reads only form/precision metadata and emits a dedicated plan", async () => {
  const { client, calls } = makeClient();
  const result = await execute("EXPLAIN VALIDATE APP41 WHERE n > 0", client, { cacheContext: "b41-explain" }) as SelectResult;
  const plan = result.rows.map((row) => row.plan).join("\n");
  expect(plan).toContain("VALIDATE APP41");
  expect(plan).toContain("number precision APP41");
  expect(plan).toContain("writesKintone=false");
  expect(plan).toContain("violation count unavailable");
  expect(calls).toMatchObject({ fields: 1, precision: 1, post: 0, put: 0, delete: 0, cursor: 0 });
  expect(calls.get).toHaveLength(0);
});

const B42_FIELDS: KintoneFieldInfo[] = [
  { code: "top", label: "top", fieldType: "SINGLE_LINE_TEXT", required: true },
  { code: "whereTop", label: "whereTop", fieldType: "SINGLE_LINE_TEXT" },
  { code: "T1", label: "T1", fieldType: "SUBTABLE" },
  { code: "req", label: "req", fieldType: "SINGLE_LINE_TEXT", required: true, inSubtable: true, subtableCode: "T1" },
  { code: "num", label: "num", fieldType: "NUMBER", inSubtable: true, subtableCode: "T1" },
  { code: "minNum", label: "minNum", fieldType: "NUMBER", minValue: "1", inSubtable: true, subtableCode: "T1" },
  { code: "maxNum", label: "maxNum", fieldType: "NUMBER", maxValue: "9", inSubtable: true, subtableCode: "T1" },
  { code: "minText", label: "minText", fieldType: "SINGLE_LINE_TEXT", minLength: "2", inSubtable: true, subtableCode: "T1" },
  { code: "maxText", label: "maxText", fieldType: "SINGLE_LINE_TEXT", maxLength: "3", inSubtable: true, subtableCode: "T1" },
  { code: "choiceChild", label: "choiceChild", fieldType: "DROP_DOWN", optionOrder: { A: 0 }, inSubtable: true, subtableCode: "T1" },
  { code: "plainChild", label: "plainChild", fieldType: "SINGLE_LINE_TEXT", inSubtable: true, subtableCode: "T1" },
  { code: "fileChild", label: "fileChild", fieldType: "FILE", inSubtable: true, subtableCode: "T1" },
  { code: "T2", label: "T2", fieldType: "SUBTABLE" },
  { code: "req", label: "req", fieldType: "SINGLE_LINE_TEXT", required: true, inSubtable: true, subtableCode: "T2" },
];

function subrow(id: string, values: Record<string, unknown>) {
  return { id, value: Object.fromEntries(Object.entries(values).map(([code, value]) => [code, { value }])) };
}

test("B42 parser accepts scoped targets and SUMMARY only before WHERE", () => {
  expect(parse("VALIDATE APP41 (top,T1(req,num)) SUMMARY WHERE whereTop = 'x'")).toMatchObject({
    type: "VALIDATE", summary: true, targets: [
      { kind: "FIELD", field: "top" },
      { kind: "SUBTABLE", subtableCode: "T1", children: ["req", "num"] },
    ],
  });
  expect(parse("VALIDATE APP41 (SUMMARY)")).toMatchObject({ targets: [{ kind: "FIELD", field: "SUMMARY" }] });
  expect(() => parse("VALIDATE APP41 WHERE whereTop='x' SUMMARY")).toThrow(ParseError);
  expect(() => parse("VALIDATE APP41 SUMMARY SUMMARY")).toThrow(ParseError);
  expect(() => parse("VALIDATE APP41$T1")).toThrow("VALIDATE APP41 (T1) を使用");
});

test("B42 omitted targets audit child cells with stable 1-based and persistent row locators", async () => {
  const { client, calls } = makeClient({ fields: B42_FIELDS, records: [record({
    $id: "9", top: "", whereTop: "x",
    T1: [subrow("r10", { req: "", num: "123", minNum: "0", maxNum: "10", minText: "x", maxText: "long", choiceChild: "A", plainChild: "", fileChild: [] }),
        subrow("r20", { req: "", num: "1", minNum: "1", maxNum: "9", minText: "ok", maxText: "ok", choiceChild: "Z", plainChild: "", fileChild: [] })],
    T2: [subrow("r30", { req: "" })],
  })] });
  const result = await execute("VALIDATE APP41 CHECK WHEN whereTop='x' THEN 'check'", client, { cacheContext: "b42-detail" }) as SelectResult;
  expect(result.columns).toEqual(["$id", "$err_field", "$err_code", "$err_message", "$err_value", "$err_subtable", "$err_subrow", "$err_subrow_id", "$err_count"]);
  expect(result.rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ $id: "9", $err_field: "top", $err_message: "top は必須です", $err_subtable: "", $err_subrow: "", $err_subrow_id: "", $err_count: "1" }),
    expect.objectContaining({ $err_field: "req", $err_message: "req は必須です（2行: 1,2）", $err_subtable: "T1", $err_subrow: "1,2", $err_count: "2" }),
    expect.objectContaining({ $err_field: "num", $err_code: "ERR_NUMBER_INTEGER_DIGITS", $err_value: "123", $err_subtable: "T1", $err_subrow: "1", $err_subrow_id: "r10" }),
    expect.objectContaining({ $err_field: "choiceChild", $err_code: "ERR_CHOICE_INVALID", $err_subrow: "2", $err_subrow_id: "r20" }),
    expect.objectContaining({ $err_field: "minNum", $err_code: "ERR_RANGE_MIN", $err_subrow_id: "r10" }),
    expect.objectContaining({ $err_field: "maxNum", $err_code: "ERR_RANGE_MAX", $err_subrow_id: "r10" }),
    expect.objectContaining({ $err_field: "minText", $err_code: "ERR_LENGTH_MIN", $err_subrow_id: "r10" }),
    expect.objectContaining({ $err_field: "maxText", $err_code: "ERR_LENGTH_MAX", $err_subrow_id: "r10" }),
    expect.objectContaining({ $err_field: "req", $err_message: "req は必須です", $err_subtable: "T2", $err_subrow: "1", $err_subrow_id: "r30", $err_count: "1" }),
    expect.objectContaining({ $err_field: "", $err_code: "ERR_CHECK", $err_message: "check", $err_subtable: "", $err_subrow: "", $err_subrow_id: "", $err_count: "1" }),
  ]));
  expect(result.rows.map((row) => [row.$err_field, row.$err_subrow_id])).toEqual([
    ["top", ""],
    ["req", "r10,r20"], ["num", "r10"], ["minNum", "r10"], ["maxNum", "r10"], ["minText", "r10"], ["maxText", "r10"],
    ["choiceChild", "r20"],
    ["req", "r30"],
    ["", ""],
  ]);
  expect(calls.get[0].fields).toEqual(expect.arrayContaining(["$id", "top", "T1", "T2", "whereTop"]));
  expect(calls.get[0].fields).not.toEqual(expect.arrayContaining(["req", "num", "minNum", "maxNum", "minText", "maxText", "choiceChild", "plainChild", "fileChild"]));
  expect(calls.precision).toBe(1);
});

test("VALIDATE detail stats count distinct error records and pre-aggregation violations", async () => {
  const { client } = makeClient({ fields: B42_FIELDS, records: [
    record({
      $id: "9", top: "ok",
      T1: [subrow("a", { req: "" }), subrow("b", { req: "" })], T2: [],
    }),
    record({ $id: "10", top: "", T1: [subrow("c", { req: "ok" })], T2: [] }),
  ] });
  const result = await execute(
    "VALIDATE APP41 (top,T1(req))",
    client,
    { cacheContext: "validate-stats-detail" }
  ) as SelectResult;

  expect(result.validateStats).toEqual({ errorRecords: 2, errorCount: 3 });
  expect(result.rows).toHaveLength(2);
  expect(result.rows.reduce((sum, row) => sum + Number(row.$err_count), 0)).toBe(3);
});

test("B42 zero-row table does not fire child required and scoped targets are resolved before fetch", async () => {
  const empty = makeClient({ fields: B42_FIELDS, records: [record({ $id: "1", top: "ok", T1: [], T2: [] })] });
  const result = await execute("VALIDATE APP41 (T1(req))", empty.client, { cacheContext: "b42-zero-row" }) as SelectResult;
  expect(result.rows).toEqual([]);

  for (const [sql, message] of [
    ["VALIDATE APP41 (T1)", "監査可能な子フィールド"],
    ["VALIDATE APP41 (T1())", "1つ以上の子フィールド"],
    ["VALIDATE APP41 (Missing(req))", "存在しません"],
    ["VALIDATE APP41 (T1(missing))", "存在しません"],
    ["VALIDATE APP41 (T1(req),T2(req))", null],
    ["VALIDATE APP41 (T1(req),T1(req))", "重複"],
    ["VALIDATE APP41 (T1(req),T2(num))", "属していません"],
    ["VALIDATE APP41 (T1(plainChild))", "監査可能な制約"],
  ] as const) {
    const fields = sql === "VALIDATE APP41 (T1)"
      ? B42_FIELDS.map((field) => field.subtableCode === "T1" ? {
          ...field, required: undefined, fieldType: "SINGLE_LINE_TEXT", optionOrder: undefined,
          minValue: undefined, maxValue: undefined, minLength: undefined, maxLength: undefined,
        } : field)
      : B42_FIELDS;
    const current = makeClient({ fields });
    if (message === null) await expect(execute(sql, current.client, { cacheContext: `b42-scope-${sql}` })).resolves.toBeDefined();
    else await expect(execute(sql, current.client, { cacheContext: `b42-scope-${sql}` })).rejects.toThrow(message);
    if (message !== null) expect(current.calls.get).toHaveLength(0);
  }
});

test.each([
  "VALIDATE APP41 WHERE req = ''",
  "VALIDATE APP41 CHECK WHEN req = '' THEN 'bad'",
])("B42 rejects child references before records fetch: %s", async (sql) => {
  const current = makeClient({ fields: B42_FIELDS });
  await expect(execute(sql, current.client, { cacheContext: `b42-child-ref-${sql}` })).rejects.toThrow("サブテーブル子フィールド req");
  expect(current.calls.get).toHaveLength(0);
});

test("B42 SUMMARY directly aggregates child rows and CHECK groups into the fixed five columns", async () => {
  const { client } = makeClient({ fields: B42_FIELDS, records: [record({
    $id: "5", top: "", whereTop: "x",
    T1: [subrow("a", { req: "", num: "123", choiceChild: "A" }), subrow("b", { req: "", num: "123", choiceChild: "A" })], T2: [],
  })] });
  const result = await execute(
    "VALIDATE APP41 (top,T1(req,num)) SUMMARY CHECK WHEN whereTop='x' THEN 'one' CHECK WHEN top='' THEN 'two'",
    client, { cacheContext: "b42-summary" }
  ) as SelectResult;
  expect(result.columns).toEqual(["$id", "$err_subtable", "$err_field", "$err_code", "$err_count"]);
  expect(result.rows).toEqual(expect.arrayContaining([
    { $id: "5", $err_subtable: "", $err_field: "top", $err_code: "ERR_REQUIRED", $err_count: "1" },
    { $id: "5", $err_subtable: "T1", $err_field: "req", $err_code: "ERR_REQUIRED", $err_count: "2" },
    { $id: "5", $err_subtable: "T1", $err_field: "num", $err_code: "ERR_NUMBER_INTEGER_DIGITS", $err_count: "2" },
    { $id: "5", $err_subtable: "", $err_field: "", $err_code: "ERR_CHECK", $err_count: "2" },
  ]));
  expect(result.validateStats).toEqual({ errorRecords: 1, errorCount: 7 });
  expect(result.rows.reduce((sum, row) => sum + Number(row.$err_count), 0)).toBe(7);
});

test("B42 detail groups by the original message, then decorates three-row child output only", async () => {
  const { client } = makeClient({ fields: B42_FIELDS, records: [record({
    $id: "5", top: "", whereTop: "x",
    T1: [subrow("first", { minText: "x" }), subrow("second", { minText: "y" }), subrow("third", { minText: "z" })], T2: [],
  })] });
  const result = await execute(
    "VALIDATE APP41 (top,T1(minText)) CHECK WHEN whereTop='x' THEN 'one' CHECK WHEN top='' THEN 'two'",
    client, { cacheContext: "b42-detail-group" }
  ) as SelectResult;
  expect(result.rows).toEqual([
    expect.objectContaining({ $err_field: "top", $err_message: "top は必須です", $err_count: "1", $err_subrow: "", $err_subrow_id: "" }),
    expect.objectContaining({
      $err_field: "minText", $err_code: "ERR_LENGTH_MIN",
      $err_message: "minText は 2 文字以上で指定してください（3行: 1,2,3）", $err_count: "3",
      $err_subrow: "1,2,3", $err_subrow_id: "first,second,third", $err_value: "x",
    }),
    expect.objectContaining({ $err_field: "", $err_code: "ERR_CHECK", $err_message: "one", $err_count: "1" }),
    expect.objectContaining({ $err_field: "", $err_code: "ERR_CHECK", $err_message: "two", $err_count: "1" }),
  ]);
});

test("B42 SUMMARY preserves its five-column schema at zero errors", async () => {
  const current = makeClient({ fields: B42_FIELDS, records: [record({
    $id: "1", top: "ok", T1: [], T2: [],
  })] });
  const result = await execute("VALIDATE APP41 SUMMARY", current.client, { cacheContext: "b42-summary-empty" }) as SelectResult;
  expect(result).toMatchObject({
    columns: ["$id", "$err_subtable", "$err_field", "$err_code", "$err_count"], rows: [], rowCount: 0,
    validateStats: { errorRecords: 0, errorCount: 0 },
  });
});

test("B42 detail temp limit is applied after message aggregation", async () => {
  const records = [record({ $id: "1", top: "ok", T1: [subrow("a", { req: "" }), subrow("b", { req: "" })], T2: [] })];
  const detail = makeClient({ fields: B42_FIELDS, records });
  const detailBatch = await executeBatch(
    "VALIDATE APP41 (T1(req)) INTO #detail; SELECT $id,$err_field,$err_code,$err_message,$err_value FROM #detail",
    detail.client, { cacheContext: "b42-detail-limit", tempTableMaxRows: 1 }
  );
  expect(detailBatch.ok).toBe(true);
  expect(detailBatch.statements[1].result).toMatchObject({
    rowCount: 1,
    rows: [{
      $id: "1", $err_field: "req", $err_code: "ERR_REQUIRED",
      $err_message: "req は必須です（2行: 1,2）", $err_value: "",
    }],
  });

  const summary = makeClient({ fields: B42_FIELDS, records });
  const summaryBatch = await executeBatch(
    "VALIDATE APP41 (T1(req)) SUMMARY INTO #summary; SELECT * FROM #summary",
    summary.client, { cacheContext: "b42-summary-limit", tempTableMaxRows: 1 }
  );
  expect(summaryBatch.ok).toBe(true);
  expect(summaryBatch.statements[1].result).toMatchObject({
    rowCount: 1, rows: [{ $id: "1", $err_subtable: "T1", $err_field: "req", $err_code: "ERR_REQUIRED", $err_count: "2" }],
  });
});

test("B42 detail INTO keeps subrow as string metadata and count as number metadata", async () => {
  const locatorRows = Array.from({ length: 10 }, (_, index) => subrow(`r${index + 1}`, {
    choiceChild: index === 1 ? "Z" : "A",
    minText: index === 9 ? "x" : "ok",
  }));
  const locator = makeClient({ fields: B42_FIELDS, records: [record({
    $id: "1", top: "ok", T1: locatorRows, T2: [],
  })] });
  const locatorBatch = await executeBatch(
    "VALIDATE APP41 (T1(choiceChild,minText)) INTO #err; SELECT $err_field,$err_subrow FROM #err ORDER BY $err_subrow",
    locator.client, { cacheContext: "b42-subrow-string-meta" }
  );
  expect(locatorBatch.statements[1].result).toMatchObject({
    rows: [
      { $err_field: "minText", $err_subrow: "10" },
      { $err_field: "choiceChild", $err_subrow: "2" },
    ],
  });

  const countRows = Array.from({ length: 10 }, (_, index) => subrow(`r${index + 1}`, {
    req: index < 2 ? "" : "ok",
    minText: "x",
  }));
  const count = makeClient({ fields: B42_FIELDS, records: [record({
    $id: "1", top: "ok", T1: countRows, T2: [],
  })] });
  const countBatch = await executeBatch(
    "VALIDATE APP41 (T1(req,minText)) INTO #err; SELECT $err_field,$err_count FROM #err ORDER BY $err_count",
    count.client, { cacheContext: "b42-count-number-meta" }
  );
  expect(countBatch.statements[1].result).toMatchObject({
    rows: [
      { $err_field: "req", $err_count: "2" },
      { $err_field: "minText", $err_count: "10" },
    ],
  });
});

test("B42 detail and SUMMARY schemas fail fast when appended to the same error table", () => {
  expect(() => analyzeBatch(parseSqlStatements(
    "VALIDATE APP41 INTO #err; VALIDATE APP41 SUMMARY INTO #err"
  ))).toThrow("different payload schema");
});

test("B42 EXPLAIN reports scoped audit/fetch fields, schemas and row locator without records API", async () => {
  const detail = makeClient({ fields: B42_FIELDS });
  const detailResult = await execute("EXPLAIN VALIDATE APP41 (T1(num))", detail.client, { cacheContext: "b42-explain-detail" }) as SelectResult;
  const detailPlan = detailResult.rows.map((row) => row.plan).join("\n");
  expect(detailPlan).toContain("T1(num)");
  expect(detailPlan).toContain("fetch fields:  $id, T1");
  expect(detailPlan).toContain("$err_subrow_id");
  expect(detailPlan).toContain("$err_count");
  expect(detailPlan).toContain("grouped by message");
  expect(detailPlan).toContain("list all matching rows (first-occurrence order)");
  expect(detail.calls.get).toHaveLength(0);
  expect(detail.calls.precision).toBe(1);

  const summary = makeClient({ fields: B42_FIELDS });
  const summaryResult = await execute("EXPLAIN VALIDATE APP41 (T1(req)) SUMMARY", summary.client, { cacheContext: "b42-explain-summary" }) as SelectResult;
  const summaryPlan = summaryResult.rows.map((row) => row.plan).join("\n");
  expect(summaryPlan).toContain("mode:          SUMMARY");
  expect(summaryPlan).toContain("$err_count");
  expect(summaryPlan).toContain("row locator=none");
  expect(summary.calls.get).toHaveLength(0);
});

test("B46: 空（未選択）の選択系セルはトップレベル・子とも ERR_CHOICE_INVALID にしない", async () => {
  const { client } = makeClient({ fields: B42_FIELDS.concat([
    { code: "topChoice", label: "topChoice", fieldType: "DROP_DOWN", optionOrder: { A: 0 } },
  ]), records: [record({
    $id: "11", top: "ok", topChoice: "",
    T1: [subrow("c1", { req: "x", choiceChild: "" })], T2: [],
  })] });
  const result = await execute(
    "VALIDATE APP41 (topChoice, T1(choiceChild))", client, { cacheContext: "b46-empty-choice" }
  ) as SelectResult;
  expect(result.rows).toEqual([]);
});
