import { execute, executeBatch, type KintoneClient, type KintoneFieldInfo, type SelectResult } from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";
import { Lexer } from "../lexer/lexer";
import { Parser, ParseError } from "../parser/parser";
import { analyzeBatch } from "../core/batch";
import { isDmlType, isReadOnlyType, requiresCompleteInput, writesKintone } from "../core/dmlGuard";
import { renderExistingValidationValue } from "../core/existingRecordValidation";

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
  { code: "child", label: "child", fieldType: "NUMBER", inSubtable: true },
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
    type: "VALIDATE", appId: 41, fields: ["n", "shortText"], errorTable: "#err",
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
    ["VALIDATE APP41 (missing)", "does not exist"],
    ["VALIDATE APP41 (n,n)", "duplicated"],
    ["VALIDATE APP41 (child)", "subtable child"],
    ["VALIDATE APP41 ($id)", "system field"],
    ["VALIDATE APP41 (plain)", "no auditable constraint"],
    ["VALIDATE APP41 (created)", "no auditable constraint"],
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
  expect(result).toMatchObject({ type: "SELECT", rowCount: 0, rows: [], columns: ["$id", "$err_field", "$err_code", "$err_message", "$err_value"] });
  await expect(execute("VALIDATE APP41 INTO #err", valid.client, { cacheContext: "b41-single-into" }))
    .rejects.toThrow("requires a batch");
});

test("batch INTO materializes the fixed five columns with numeric $id metadata", async () => {
  const { client } = makeClient({ records: [record({ $id: "2", requiredText: "", n: "100" })] });
  const batch = await executeBatch(
    "VALIDATE APP41 (requiredText,n) INTO #err; SELECT $id,$err_field,$err_code,$err_message,$err_value FROM #err ORDER BY $id",
    client,
    { cacheContext: "b41-batch-into" }
  );
  expect(batch.ok).toBe(true);
  expect((batch.statements[1].result as SelectResult).columns).toEqual(["$id", "$err_field", "$err_code", "$err_message", "$err_value"]);
  expect((batch.statements[1].result as SelectResult).rows).toHaveLength(2);
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
