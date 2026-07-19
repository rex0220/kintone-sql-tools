import {
  execute,
  executeBatch,
  KintoneClient,
  SelectResult,
  InsertResult,
  UpdateResult,
  DeleteResult,
  OperationCancelledError,
  dmlSourceMaterializer,
  DmlValidationResult,
} from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";
import type {
  KintonePostParams,
  KintonePutParams,
  KintoneDeleteParams,
} from "../converter/dmlToKintone";

// ----------------------------------------------------------------
// モッククライアント生成ヘルパー
// ----------------------------------------------------------------

function makeRecord(fields: Record<string, string>): KintoneRecord {
  return Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [k, { value: v }])
  );
}

function makeTypedRecord(fields: Record<string, unknown>): KintoneRecord {
  return Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [k, { value: v }])
  ) as KintoneRecord;
}

interface MockClientOptions {
  records?: KintoneRecord[];          // GET で返すレコード（全アプリ共通）
  recordsByApp?: Record<number, KintoneRecord[]>; // アプリ ID ごとにレコードを分ける
  postIds?: string[];                 // POST レスポンスの id リスト
  fieldTypes?: Record<string, string>; // schema-aware planner 用の明示フィールド型
}

function makeClient(opts: MockClientOptions = {}): KintoneClient & {
  putCalls: KintonePutParams[];
  deleteCalls: KintoneDeleteParams[];
  postCalls: KintonePostParams[];
  getCalls: { app: number; query: string; fields: string[] }[];
} {
  const putCalls: KintonePutParams[]    = [];
  const deleteCalls: KintoneDeleteParams[] = [];
  const postCalls: KintonePostParams[]  = [];
  const getCalls: { app: number; query: string; fields: string[] }[] = [];

  return {
    putCalls,
    deleteCalls,
    postCalls,
    getCalls,

    async getRecords(params) {
      getCalls.push({ app: params.app, query: params.query ?? "", fields: [...(params.fields ?? [])] });
      if (opts.recordsByApp) {
        return { records: opts.recordsByApp[params.app] ?? [] };
      }
      return { records: opts.records ?? [] };
    },
    async openCursor() { throw new Error("unexpected cursor call"); },
    async postRecords(params) {
      postCalls.push(params);
      return { ids: opts.postIds ?? [] };
    },
    async putRecords(params) {
      putCalls.push(params);
    },
    async deleteRecords(params) {
      deleteCalls.push(params);
    },
    async getApps() {
      return [];
    },
    async getFields(appId) {
      const records = opts.recordsByApp?.[appId] ?? opts.records ?? [];
      const codes = new Set(records.flatMap((record) => Object.keys(record)));
      const types = opts.fieldTypes ?? {};
      Object.keys(types).forEach((code) => codes.add(code));
      return [...codes]
        .filter((code) => !code.startsWith("$"))
        .map((code) => ({ code, label: code, fieldType: types[code] ?? "SINGLE_LINE_TEXT" }));
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() { return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const }; },
  };
}

/** kintone の limit / offset と $id の昇降順を再現するページング用クライアント。 */
function makePagedClient(
  records: KintoneRecord[],
  options: { searchAborted?: boolean } = {}
): ReturnType<typeof makeClient> {
  // Phase 3 の schema-aware planner も実レコードと同じフィールド定義を参照できるようにする。
  const client = makeClient({ records });
  client.getRecords = async (params) => {
    client.getCalls.push({ app: params.app, query: params.query, fields: [...params.fields] });
    const limit = Number(params.query.match(/\blimit\s+(\d+)/i)?.[1] ?? "100");
    const offset = Number(params.query.match(/\boffset\s+(\d+)/i)?.[1] ?? "0");
    const ordered = /order by \$id desc/i.test(params.query)
      ? [...records].reverse()
      : records;
    return {
      records: ordered.slice(offset, offset + limit),
      searchAborted: options.searchAborted,
    };
  };
  return client;
}

test("FULL_SCAN WHERE/CASE/HAVINGは16桁超NUMBERを同じ厳密比較器で評価する", async () => {
  const records = [
    makeRecord({ $id: "1", kind: "low", n: "9007199254740992" }),
    makeRecord({ $id: "2", kind: "high", n: "9007199254740993" }),
  ];
  const client = makeClient({ records, fieldTypes: { kind: "SINGLE_LINE_TEXT", n: "NUMBER" } });
  const selected = await execute(
    "SELECT $id AS id, CASE WHEN n = 9007199254740993 THEN 'H' ELSE 'L' END AS band " +
      "FROM APP100 ORDER BY $id ASC",
    client,
    { cacheContext: "exact-where-case" }
  ) as SelectResult;
  expect(selected.rows).toEqual([{ id: "1", band: "L" }, { id: "2", band: "H" }]);

  const having = await execute(
    "SELECT kind, MAX(n) AS mx FROM APP100 GROUP BY kind HAVING mx = 9007199254740993",
    client,
    { cacheContext: "exact-having" }
  ) as SelectResult;
  expect(having.rows).toEqual([expect.objectContaining({ kind: "high", mx: "9007199254740993" })]);
});

test("通常UPDATE/DELETEは16桁超NUMBERのraw REST条件で対象選定する", async () => {
  const records = [
    makeRecord({ $id: "1", n: "9007199254740992", mark: "" }),
    makeRecord({ $id: "2", n: "9007199254740993", mark: "" }),
  ];
  const updateClient = makeClient({ records, fieldTypes: { n: "NUMBER", mark: "SINGLE_LINE_TEXT" } });
  updateClient.getRecords = async (params) => {
    updateClient.getCalls.push({ app: params.app, query: params.query ?? "", fields: [...(params.fields ?? [])] });
    return { records: params.query.includes("n < 9007199254740993") ? [records[0]] : records };
  };
  const updated = await execute(
    "UPDATE APP100 SET mark = 'low' WHERE n < 9007199254740993",
    updateClient,
    { cacheContext: "exact-normal-update" }
  ) as UpdateResult;
  expect(updated.updatedCount).toBe(1);
  expect(updateClient.getCalls[0].query).toContain("n < 9007199254740993");
  expect(updateClient.putCalls.flatMap((call) => call.records).map((record) => record.id)).toEqual([1]);

  const deleteClient = makeClient({ records, fieldTypes: { n: "NUMBER" } });
  deleteClient.getRecords = async (params) => {
    deleteClient.getCalls.push({ app: params.app, query: params.query ?? "", fields: [...(params.fields ?? [])] });
    return { records: params.query.includes("n > 9007199254740992") ? [records[1]] : records };
  };
  const deleted = await execute(
    "DELETE FROM APP100 WHERE n > 9007199254740992",
    deleteClient,
    { cacheContext: "exact-normal-delete" }
  ) as DeleteResult;
  expect(deleted.deletedCount).toBe(1);
  expect(deleteClient.getCalls[0].query).toContain("n > 9007199254740992");
  expect(deleteClient.deleteCalls[0].ids).toEqual([2]);
});

test("INSERT VALIDATE ONLY は全エラーを返しwrite APIを呼ばない", async () => {
  const client = makeClient();
  client.getFields = async () => [
    { code: "code", label: "code", fieldType: "SINGLE_LINE_TEXT", required: true, minLength: "2" },
    { code: "amount", label: "amount", fieldType: "NUMBER", minValue: "0", maxValue: "10" },
  ];
  const result = await execute(
    "INSERT INTO APP100 (code, amount) VALUES ('', 11), ('OK', 5) VALIDATE ONLY",
    client,
    { cacheContext: "validate-insert" }
  );
  expect(result).toMatchObject({
    type: "VALIDATION", operation: "INSERT", validatedRows: 2, validRows: 1, invalidRows: 1, errorCount: 2,
  });
  if (result.type !== "VALIDATION") throw new Error("unexpected result");
  expect(result.errors.map((row) => row.$err_code)).toEqual(["ERR_REQUIRED", "ERR_RANGE_MAX"]);
  expect(client.postCalls).toHaveLength(0);
  expect(client.putCalls).toHaveLength(0);
  expect(result.metrics).toMatchObject({ postCalls: 0, putCalls: 0, deleteCalls: 0 });
});

test("UPSERT VALIDATE ONLY は照合readのみ行いsource重複を全行へ返す", async () => {
  const client = makeClient({ records: [] });
  client.getFields = async () => [
    { code: "code", label: "code", fieldType: "SINGLE_LINE_TEXT", required: true },
    { code: "name", label: "name", fieldType: "SINGLE_LINE_TEXT" },
  ];
  const result = await execute(
    "UPSERT INTO APP100 (code, name) VALUES ('A', 'one'), ('A', 'two') ON DUPLICATE (code) VALIDATE ONLY",
    client,
    { cacheContext: "validate-upsert" }
  );
  expect(result).toMatchObject({
    type: "VALIDATION", operation: "UPSERT", validatedRows: 2, validRows: 0, invalidRows: 2, errorCount: 2,
  });
  if (result.type !== "VALIDATION") throw new Error("unexpected result");
  expect(result.errors.map((row) => row.$err_code)).toEqual(["ERR_KEY_DUP_SOURCE", "ERR_KEY_DUP_SOURCE"]);
  expect(client.getCalls.length).toBeGreaterThan(0);
  expect(client.postCalls).toHaveLength(0);
  expect(client.putCalls).toHaveLength(0);
});

test("IMPORT UPSERT はsource重複を照合read前に文全体拒否する", async () => {
  const client = makeClient({ records: [] });
  client.getFields = async () => [
    { code: "code", label: "code", fieldType: "SINGLE_LINE_TEXT", required: true },
    { code: "name", label: "name", fieldType: "SINGLE_LINE_TEXT" },
  ];
  await expect(execute(
    "IMPORT INTO APP100 (code, name) FROM CSV people ON DUPLICATE (code)",
    client,
    {
      enableImport: true,
      importSource: () => ({ load: async () => ({ bytes: new TextEncoder().encode("code,name\nA,one\nA,two") }) }),
      cacheContext: "import-upsert-duplicate",
    }
  )).rejects.toThrow("ERR_KEY_DUP_SOURCE");
  expect(client.getCalls).toHaveLength(0);
  expect(client.postCalls).toHaveLength(0);
  expect(client.putCalls).toHaveLength(0);
});

test("非IMPORT UPSERT SELECT はsource重複をhard throwせず従来どおり照合する", async () => {
  const sourceRows = [
    makeRecord({ $id: "1", code: "A", name: "one" }),
    makeRecord({ $id: "2", code: "A", name: "two" }),
  ];
  const client = makeClient({ recordsByApp: { 100: [], 200: sourceRows }, postIds: ["1", "2"] });
  client.getFields = async (appId) => appId === 100
    ? [
        { code: "code", label: "code", fieldType: "SINGLE_LINE_TEXT" },
        { code: "name", label: "name", fieldType: "SINGLE_LINE_TEXT" },
      ]
    : [
        { code: "code", label: "code", fieldType: "SINGLE_LINE_TEXT" },
        { code: "name", label: "name", fieldType: "SINGLE_LINE_TEXT" },
      ];
  const result = await execute(
    "UPSERT INTO APP100 (code, name) SELECT code, name FROM APP200 ON DUPLICATE (code)",
    client,
    { cacheContext: "non-import-upsert-select-duplicate" }
  );
  expect(result).toMatchObject({ type: "UPSERT", insertedCount: 2, updatedCount: 0 });
  expect(client.getCalls.some((call) => call.app === 100)).toBe(true);
  expect(client.postCalls.flatMap((call) => call.records)).toHaveLength(2);
});

test("IMPORT CSV INSERT はnamed sourceを遅延loadして位置対応する", async () => {
  const client = makeClient({ records: [], postIds: ["1", "2"] });
  client.getFields = async () => [
    { code: "code", label: "code", fieldType: "SINGLE_LINE_TEXT" },
    { code: "name", label: "name", fieldType: "SINGLE_LINE_TEXT" },
  ];
  const load = jest.fn(async () => ({ bytes: new TextEncoder().encode("c,n\nA,Alice\nB,Bob") }));
  const result = await execute("IMPORT INTO APP100 (code,name) FROM CSV people", client, {
    enableImport: true,
    importSource: (name) => name === "people" ? { load } : undefined,
    cacheContext: "import-insert",
  });
  expect(result).toMatchObject({ type: "INSERT", insertedCount: 2 });
  expect(load).toHaveBeenCalledTimes(1);
  expect(client.postCalls[0].records).toEqual([
    { code: { value: "A" }, name: { value: "Alice" } },
    { code: { value: "B" }, name: { value: "Bob" } },
  ]);
});

test("IMPORT CSV BY NAME はヘッダ順を INTO 順へ写像し NUMBER 字面と5型LFを保持する", async () => {
  const client = makeClient({ records: [], postIds: ["1"] });
  client.getFields = async () => [
    { code: "num", label: "num", fieldType: "NUMBER" },
    { code: "cb", label: "cb", fieldType: "CHECK_BOX" },
    { code: "ms", label: "ms", fieldType: "MULTI_SELECT" },
    { code: "users", label: "users", fieldType: "USER_SELECT" },
    { code: "orgs", label: "orgs", fieldType: "ORGANIZATION_SELECT" },
    { code: "groups", label: "groups", fieldType: "GROUP_SELECT" },
    { code: "calc", label: "calc", fieldType: "CALC", writable: false },
    { code: "$id", label: "record number", fieldType: "RECORD_NUMBER", writable: false },
    { code: "files", label: "files", fieldType: "FILE" },
  ];
  const csv = 'calc,groups,num,cb,ms,users,orgs,$id,files\nignored,"g1\ng2",12345678901234567890,"a\nb","m1\r\nm2","u1\nu2",o1,99,';
  const imported = await execute("IMPORT INTO APP100 (num,cb,ms,users,orgs,groups) FROM CSV src BY NAME", client, {
    enableImport: true,
    importSource: () => ({ load: async () => ({ bytes: new TextEncoder().encode(csv) }) }),
    cacheContext: "import-by-name-roundtrip",
  });
  expect(client.postCalls[0].records).toEqual([{
    num: { value: "12345678901234567890" },
    cb: { value: ["a", "b"] }, ms: { value: ["m1", "m2"] },
    users: { value: [{ code: "u1" }, { code: "u2" }] },
    orgs: { value: [{ code: "o1" }] }, groups: { value: [{ code: "g1" }, { code: "g2" }] },
  }]);
  expect((imported as InsertResult & { importAudit?: { ignoredKnownColumns: unknown[] } }).importAudit?.ignoredKnownColumns)
    .toEqual(expect.arrayContaining([
      expect.objectContaining({ column: "calc", nonEmptyCells: 1 }),
      expect.objectContaining({ column: "$id", nonEmptyCells: 1 }),
      expect.objectContaining({ column: "files", nonEmptyCells: 0 }),
    ]));

  const upsert = makeClient({ records: [], postIds: ["2"] });
  upsert.getFields = client.getFields;
  await execute("IMPORT INTO APP100 (num,cb,ms,users,orgs,groups) FROM CSV src BY NAME ON DUPLICATE (num)", upsert, {
    enableImport: true,
    importSource: () => ({ load: async () => ({ bytes: new TextEncoder().encode(csv) }) }),
    cacheContext: "import-by-name-upsert-roundtrip",
  });
  expect(upsert.postCalls[0].records).toEqual(client.postCalls[0].records);
  const precise = await execute("IMPORT INTO APP100 (num) FROM CSV src BY NAME VALIDATE ONLY", client, {
    enableImport: true,
    importSource: () => ({ load: async () => ({ bytes: new TextEncoder().encode("num\n123456789012345678901234567890") }) }),
    cacheContext: "import-by-name-30-digit",
  }) as DmlValidationResult;
  expect(precise.errors).toEqual([expect.objectContaining({
    num: "123456789012345678901234567890", $err_code: "ERR_NUMBER_INTEGER_DIGITS",
    $err_message: expect.stringContaining("30 桁"),
  })]);
});

test("IMPORT CSV BY NAME は未知列を既定拒否し opt-in 時だけ監査付きで無視する", async () => {
  const source = () => ({ load: async () => ({ bytes: new TextEncoder().encode("code,mystery\nA,x\nB,") }) });
  const make = () => {
    const client = makeClient({ records: [], postIds: ["1", "2"] });
    client.getFields = async () => [{ code: "code", label: "code", fieldType: "SINGLE_LINE_TEXT" }];
    return client;
  };
  const rejected = make();
  await expect(execute("IMPORT INTO APP100 (code) FROM CSV src BY NAME", rejected, {
    enableImport: true, importSource: source, cacheContext: "import-by-name-unknown-reject",
  })).rejects.toThrow("ERR_IMPORT_UNKNOWN_COLUMN");
  expect(rejected.postCalls).toHaveLength(0);

  const allowed = make();
  const spy = jest.spyOn(dmlSourceMaterializer, "materialize");
  try {
    const result = await execute("IMPORT INTO APP100 (code) FROM CSV src BY NAME IGNORE UNKNOWN COLUMNS", allowed, {
      enableImport: true, importSource: source, cacheContext: "import-by-name-unknown-ignore",
    });
    const table = await spy.mock.results[0].value;
    expect(table.importAudit?.ignoredUnknownColumns).toEqual([
      { column: "mystery", reason: "unknown column ignored by explicit policy", nonEmptyCells: 1 },
    ]);
    expect((result as InsertResult & { importAudit?: unknown }).importAudit).toEqual(table.importAudit);
  } finally { spy.mockRestore(); }
});

test("IMPORT CSV BY NAME schema errors are global; LF empty items are isolated by parent row", async () => {
  const client = makeClient({ records: [], postIds: ["1"] });
  client.getFields = async () => [
    { code: "code", label: "code", fieldType: "SINGLE_LINE_TEXT" },
    { code: "cb", label: "cb", fieldType: "CHECK_BOX" },
  ];
  const options = (csv: string, context: string) => ({
    enableImport: true,
    importSource: () => ({ load: async () => ({ bytes: new TextEncoder().encode(csv) }) }),
    cacheContext: context,
  });
  await expect(execute("IMPORT INTO APP100 (code,cb) FROM CSV src BY NAME", client,
    options("code\nA", "import-by-name-missing"))).rejects.toThrow("ERR_IMPORT_MISSING_COLUMN");
  const validated = await execute(
    "IMPORT INTO APP100 (code,cb) FROM CSV src BY NAME VALIDATE ONLY",
    client, options('code,cb\nOK,"a\nb"\nBAD,"x\n"', "import-by-name-lf-validate")
  ) as DmlValidationResult;
  expect(validated).toMatchObject({ validatedRows: 2, validRows: 1, invalidRows: 1 });
  expect(validated.errors).toEqual([
    expect.objectContaining({ code: "BAD", $err_field: "cb", $err_code: "ERR_IMPORT_MULTI_EMPTY_ITEM" }),
  ]);
  const batch = await executeBatch(
    "IMPORT INTO APP100 (code,cb) FROM CSV src BY NAME ON ERROR SKIP INTO #err; SELECT * FROM #err",
    client,
    options('code,cb\nOK,"a\nb"\nBAD,"x\n"', "import-by-name-lf-isolation")
  );
  expect(batch.ok).toBe(true);
  expect(client.postCalls.flatMap((call) => call.records)).toEqual([{ code: { value: "OK" }, cb: { value: ["a", "b"] } }]);
  expect((batch.statements[1].result as SelectResult).rows).toEqual([
    expect.objectContaining({ code: "BAD", $err_field: "cb", $err_code: "ERR_IMPORT_MULTI_EMPTY_ITEM" }),
  ]);
});

test("IMPORT CSV BY NAME は非書込み/FILE の INTO 指定を拒否し EXPLAIN に互換契約を出す", async () => {
  for (const [field, fieldType] of [["calc", "CALC"], ["files", "FILE"]] as const) {
    const client = makeClient();
    client.getFields = async () => [{ code: field, label: field, fieldType, writable: fieldType !== "CALC" }];
    await expect(execute(`IMPORT INTO APP100 (${field}) FROM CSV src BY NAME`, client, {
      enableImport: true,
      importSource: () => ({ load: async () => ({ bytes: new TextEncoder().encode(`${field}\nx`) }) }),
      cacheContext: `import-by-name-nonwritable-${field}`,
    })).rejects.toThrow("not writable");
  }
  const plan = await execute("EXPLAIN IMPORT INTO APP100 (num) FROM CSV src BY NAME IGNORE UNKNOWN COLUMNS", makeClient(), { enableImport: true }) as SelectResult;
  const text = plan.rows.map((row) => row.plan).join("\n");
  expect(text).toContain("mapping:       BY_NAME");
  expect(text).toContain("multipleValueDelimiter: LF");
  expect(text).toContain("sourceValueMode: string-preserving");
  expect(text).toContain("roundTripNumericGuarantee");
  expect(text).toContain("unknownColumnPolicy: ignore with audit/non-empty count");
});

test("IMPORT JSON INSERT は名前対応し、null と欠落を payload で区別する", async () => {
  const client = makeClient({ records: [], postIds: ["1", "2"] });
  client.getFields = async () => [
    { code: "code", label: "code", fieldType: "SINGLE_LINE_TEXT", required: true },
    { code: "name", label: "name", fieldType: "SINGLE_LINE_TEXT", defaultValue: "default" },
  ];
  const result = await execute("IMPORT INTO APP100 (code,name) FROM JSON people", client, {
    enableImport: true,
    importSource: () => ({ load: async () => ({ bytes: new TextEncoder().encode('[{"name":null,"code":"A"},{"code":"B"}]') }) }),
    cacheContext: "import-json-insert",
  });
  expect(result).toMatchObject({ type: "INSERT", insertedCount: 2 });
  expect(client.postCalls[0].records).toEqual([
    { code: { value: "A" }, name: { value: "" } },
    { code: { value: "B" } },
  ]);
});

test("IMPORT JSON はアプリ全フィールドではなく INTO 2列へ名前対応する (INSERT/UPSERT/VALIDATE ONLY)", async () => {
  const fields = [
    { code: "a", label: "a", fieldType: "SINGLE_LINE_TEXT", required: true },
    { code: "b", label: "b", fieldType: "SINGLE_LINE_TEXT" },
    { code: "extra1", label: "extra1", fieldType: "SINGLE_LINE_TEXT" },
    { code: "extra2", label: "extra2", fieldType: "NUMBER" },
    { code: "extra3", label: "extra3", fieldType: "DATE" },
  ];
  const source = () => ({
    load: async () => ({ bytes: new TextEncoder().encode('{"b":"B","a":"A"}') }),
  });
  const makeWideClient = () => {
    const client = makeClient({ records: [], postIds: ["1"] });
    client.getFields = async () => fields;
    return client;
  };

  // 修正前は materializer が5列を返し、INTO/DML 2列との列数不一致で失敗していた。
  const insertClient = makeWideClient();
  await expect(execute("IMPORT INTO APP100 (a,b) FROM JSON src", insertClient, {
    enableImport: true, importSource: source, cacheContext: "import-json-wide-insert",
  })).resolves.toMatchObject({ type: "INSERT", insertedCount: 1 });
  expect(insertClient.postCalls[0].records).toEqual([{ a: { value: "A" }, b: { value: "B" } }]);

  const upsertClient = makeWideClient();
  await expect(execute("IMPORT INTO APP100 (a,b) FROM JSON src ON DUPLICATE (a)", upsertClient, {
    enableImport: true, importSource: source, cacheContext: "import-json-wide-upsert",
  })).resolves.toMatchObject({ type: "UPSERT", insertedCount: 1, updatedCount: 0 });
  expect(upsertClient.postCalls[0].records).toEqual([{ a: { value: "A" }, b: { value: "B" } }]);

  const validateClient = makeWideClient();
  await expect(execute("IMPORT INTO APP100 (a,b) FROM JSON src VALIDATE ONLY", validateClient, {
    enableImport: true, importSource: source, cacheContext: "import-json-wide-validate",
  })).resolves.toMatchObject({ type: "VALIDATION", validRows: 1, invalidRows: 0 });
  expect(validateClient.postCalls).toHaveLength(0);
  expect(validateClient.putCalls).toHaveLength(0);
});

test("IMPORT JSON UPSERT update は欠落 field を PUT から省略する", async () => {
  const client = makeClient({ records: [makeRecord({ $id: "10", code: "A", name: "old" })] });
  client.getFields = async () => [
    { code: "code", label: "code", fieldType: "SINGLE_LINE_TEXT", required: true },
    { code: "name", label: "name", fieldType: "SINGLE_LINE_TEXT" },
  ];
  await execute("IMPORT INTO APP100 (code,name) FROM JSON people ON DUPLICATE (code)", client, {
    enableImport: true,
    importSource: () => ({ load: async () => ({ bytes: new TextEncoder().encode('{"code":"A"}') }) }),
    cacheContext: "import-json-upsert",
  });
  expect(client.putCalls[0].records).toEqual([{ id: 10, record: { code: { value: "A" } } }]);
});

test("IMPORT JSON decode failure and source duplicate key perform zero mutation", async () => {
  for (const json of ['{"code":', '{"code":"A","code":"B"}']) {
    const client = makeClient({ fieldTypes: { code: "SINGLE_LINE_TEXT" } });
    await expect(execute("IMPORT INTO APP100 (code) FROM JSON bad", client, {
      enableImport: true,
      importSource: () => ({ load: async () => ({ bytes: new TextEncoder().encode(json) }) }),
      cacheContext: `import-json-bad-${json.length}`,
    })).rejects.toThrow("ImportSourceError");
    expect(client.postCalls).toHaveLength(0);
    expect(client.putCalls).toHaveLength(0);
  }
});

test("IMPORT JSON VALIDATE ONLY / ON ERROR SKIP share validation materialization and write only valid rows", async () => {
  const source = () => ({ load: async () => ({ bytes: new TextEncoder().encode('[{"code":"OK"},{"code":null}]') }) });
  const client = makeClient({ postIds: ["1"] });
  client.getFields = async () => [{ code: "code", label: "code", fieldType: "SINGLE_LINE_TEXT", required: true }];
  const spy = jest.spyOn(dmlSourceMaterializer, "materialize");
  try {
    const validation = await execute("IMPORT INTO APP100 (code) FROM JSON src VALIDATE ONLY", client, {
      enableImport: true, importSource: source, cacheContext: "import-json-validate",
    });
    expect(validation).toMatchObject({ type: "VALIDATION", validRows: 1, invalidRows: 1 });
    expect(client.postCalls).toHaveLength(0);
    const skipped = await executeBatch(
      "IMPORT INTO APP100 (code) FROM JSON src ON ERROR SKIP INTO #err; SELECT * FROM #err",
      client,
      { enableImport: true, importSource: source, cacheContext: "import-json-skip" }
    );
    expect(skipped.ok).toBe(true);
    expect(client.postCalls.flatMap((call) => call.records)).toEqual([{ code: { value: "OK" } }]);
    expect(spy).toHaveBeenCalledTimes(2);
  } finally {
    spy.mockRestore();
  }
});

test("EXPLAIN IMPORT JSON exposes strict source policies", async () => {
  const plan = await execute("EXPLAIN IMPORT INTO APP100 (code) FROM JSON people", makeClient(), { enableImport: true }) as SelectResult;
  const text = plan.rows.map((row) => row.plan).join("\n");
  expect(text).toContain("sourceFormat:  JSON");
  expect(text).toContain("duplicateKeyPolicy: reject");
  expect(text).toContain("precisionTargetsRequireString: true");
  expect(text).toContain("presenceAware: true");
});

test("IMPORT CSV 射影は全式を評価し、列metaとINTO位置対応を保つ", async () => {
  const client = makeClient({ records: [], postIds: ["1"] });
  client.getFields = async () => [
    { code: "dest_code", label: "dest_code", fieldType: "SINGLE_LINE_TEXT" },
    { code: "金額", label: "金額", fieldType: "NUMBER" },
    { code: "combined", label: "combined", fieldType: "SINGLE_LINE_TEXT" },
  ];
  const options = {
    enableImport: true,
    importSource: () => ({ load: async () => ({ bytes: new TextEncoder().encode("code,amount,a,b\nA,12.5,x,y") }) }),
    cacheContext: "import-projection",
  };
  const sourceSpy = jest.spyOn(dmlSourceMaterializer, "materialize");
  try {
    await execute(
      "IMPORT INTO APP100 (dest_code, 金額, combined) FROM CSV src " +
        "SELECT code, CAST(amount AS NUMBER) AS 金額, a || b AS c",
      client,
      options
    );
    const materialized = await sourceSpy.mock.results[0].value;
    expect(materialized.columns).toEqual(["code", "金額", "c"]);
    expect(materialized.columnMeta?.get("金額")).toMatchObject({
      sortKind: "number", semantics: { compareMode: "number" },
    });
  } finally {
    sourceSpy.mockRestore();
  }
  expect(client.postCalls[0].records).toEqual([{
    dest_code: { value: "A" }, 金額: { value: "12.5" }, combined: { value: "xy" },
  }]);
  await expect(execute(
    "IMPORT INTO APP100 (dest_code, 金額) FROM CSV src SELECT code",
    makeClient({ fieldTypes: { dest_code: "SINGLE_LINE_TEXT", 金額: "NUMBER" } }),
    { ...options, cacheContext: "import-projection-width" }
  )).rejects.toThrow(/projection has 1 columns|列数/);
});

test("IMPORT ON ERROR SKIP/VALIDATE ONLY は不良行を#errorへ隔離し単文#errorを拒否する", async () => {
  const csv = "code\nOK\nBAD\n";
  const importSource = () => ({ load: async () => ({ bytes: new TextEncoder().encode(csv) }) });
  const client = makeClient({ postIds: ["1"] });
  client.getFields = async () => [
    { code: "code", label: "code", fieldType: "SINGLE_LINE_TEXT", required: true },
  ];
  // Projection creates one valid and one invalid row from a two-row fixture.
  const twoRows = () => ({ load: async () => ({ bytes: new TextEncoder().encode(csv) }) });
  const skipped = await executeBatch(
    "IMPORT INTO APP100 (code) FROM CSV src SELECT CASE WHEN code = 'OK' THEN code ELSE '' END AS code " +
      "ON ERROR SKIP INTO #err; SELECT * FROM #err",
    client,
    { enableImport: true, importSource: twoRows, cacheContext: "import-skip" }
  );
  expect(skipped.ok).toBe(true);
  expect(client.postCalls.flatMap((call) => call.records)).toHaveLength(1);
  expect((skipped.statements[1].result as SelectResult).rows).toEqual([
    expect.objectContaining({ code: "", $err_code: "ERR_REQUIRED" }),
  ]);

  const validationClient = makeClient();
  validationClient.getFields = client.getFields;
  const validated = await executeBatch(
    "IMPORT INTO APP100 (code) FROM CSV src SELECT CASE WHEN code = 'OK' THEN code ELSE '' END AS code " +
      "VALIDATE ONLY INTO #err; SELECT * FROM #err",
    validationClient,
    { enableImport: true, importSource: twoRows, cacheContext: "import-validate" }
  );
  expect(validated.ok).toBe(true);
  expect(validationClient.postCalls).toHaveLength(0);
  expect((validated.statements[1].result as SelectResult).rows).toEqual([
    expect.objectContaining({ code: "", $err_code: "ERR_REQUIRED" }),
  ]);

  await expect(execute(
    "IMPORT INTO APP100 (code) FROM CSV src VALIDATE ONLY INTO #err",
    client,
    { enableImport: true, importSource, cacheContext: "import-validate-single" }
  )).rejects.toThrow("requires a batch");
});

test("IMPORT gate/source absence fail before form API", async () => {
  const client = makeClient({ records: [] });
  await expect(execute("IMPORT INTO APP100 (code) FROM CSV missing", client, { enableImport: true })).rejects.toThrow("capability is not available");
  expect(client.getFields).toBeDefined();
  expect(client.postCalls).toHaveLength(0);
});

test("INSERT/UPSERT/検証候補は共通materializeDmlSourceを通り、通常SELECT経路も維持する", async () => {
  const rows = [makeRecord({ $id: "1", code: "A", name: "Alice" })];
  const client = makeClient({ records: rows, postIds: ["10"], fieldTypes: { code: "SINGLE_LINE_TEXT", name: "SINGLE_LINE_TEXT" } });
  const spy = jest.spyOn(dmlSourceMaterializer, "materialize");
  try {
    await execute("INSERT INTO APP100 (code, name) SELECT code, name FROM APP200", client, { cacheContext: "source-route-insert" });
    await execute("UPSERT INTO APP100 (code, name) SELECT code, name FROM APP200 ON DUPLICATE (code)", client, { cacheContext: "source-route-upsert" });
    await execute("INSERT INTO APP100 (code, name) SELECT code, name FROM APP200 VALIDATE ONLY", client, { cacheContext: "source-route-validation" });
    const selected = await execute("SELECT code FROM APP200", client, { cacheContext: "source-route-select" }) as SelectResult;
    expect(selected.rows).toEqual([{ code: "A" }]);
    expect(spy.mock.calls.map(([stmt]) => stmt.type)).toEqual(["INSERT_SELECT", "UPSERT_SELECT", "INSERT_SELECT"]);
  } finally {
    spy.mockRestore();
  }
});

test("非IMPORT INSERT/UPSERT SELECT は USER/ORG/GROUP の {code} 配列を REST payload まで保持する", async () => {
  const selected = makeTypedRecord({
    $id: "20", key: "A",
    users: [{ code: "u1" }, { code: "u2" }],
    orgs: [{ code: "o1" }], groups: [{ code: "g1" }],
  });
  const destination = makeTypedRecord({ $id: "10", key: "A" });
  const fields = [
    { code: "key", label: "key", fieldType: "SINGLE_LINE_TEXT" },
    { code: "users", label: "users", fieldType: "USER_SELECT" },
    { code: "orgs", label: "orgs", fieldType: "ORGANIZATION_SELECT" },
    { code: "groups", label: "groups", fieldType: "GROUP_SELECT" },
  ];
  const make = () => {
    const client = makeClient({ recordsByApp: { 100: [destination], 200: [selected] }, postIds: ["1"] });
    client.getFields = async () => fields;
    return client;
  };
  const expected = {
    key: { value: "A" },
    users: { value: [{ code: "u1" }, { code: "u2" }] },
    orgs: { value: [{ code: "o1" }] }, groups: { value: [{ code: "g1" }] },
  };

  const inserted = make();
  await execute(
    "INSERT INTO APP100 (key,users,orgs,groups) SELECT key,users,orgs,groups FROM APP200",
    inserted, { cacheContext: "select-code-objects-insert" }
  );
  // preserveCodes 修正前は normalizeRaw({code}[]) が string[] へ平坦化していた。
  expect(inserted.postCalls[0].records).toEqual([expected]);

  const upserted = make();
  await execute(
    "UPSERT INTO APP100 (key,users,orgs,groups) SELECT key,users,orgs,groups FROM APP200 ON DUPLICATE (key)",
    upserted, { cacheContext: "select-code-objects-upsert" }
  );
  expect(upserted.putCalls[0].records).toEqual([{ id: 10, record: expected }]);
});

test("非IMPORT VALUES の USER/ORG/GROUP 文字列変換は従来どおり {code} 配列を書く", async () => {
  const client = makeClient({ postIds: ["1"] });
  client.getFields = async () => [
    { code: "users", label: "users", fieldType: "USER_SELECT" },
    { code: "orgs", label: "orgs", fieldType: "ORGANIZATION_SELECT" },
    { code: "groups", label: "groups", fieldType: "GROUP_SELECT" },
  ];
  await execute(
    "INSERT INTO APP100 (users,orgs,groups) VALUES ('u1','o1','g1')",
    client, { cacheContext: "values-code-objects-unchanged" }
  );
  expect(client.postCalls[0].records).toEqual([{
    users: { value: [{ code: "u1" }] },
    orgs: { value: [{ code: "o1" }] }, groups: { value: [{ code: "g1" }] },
  }]);
});

test("UPDATE VALIDATE ONLY は対象を読み取るがPUTせず$id順で検証する", async () => {
  const client = makeClient({ records: [makeRecord({ $id: "2" }), makeRecord({ $id: "1" })] });
  client.getFields = async () => [
    { code: "amount", label: "amount", fieldType: "NUMBER", maxValue: "10" },
  ];
  const result = await execute(
    "UPDATE APP100 SET amount = 11 WHERE $id in (1, 2) VALIDATE ONLY",
    client,
    { cacheContext: "validate-update" }
  );
  expect(result).toMatchObject({ type: "VALIDATION", validatedRows: 2, invalidRows: 2, errorCount: 2 });
  if (result.type !== "VALIDATION") throw new Error("unexpected result");
  expect(result.errors.map((row) => row.$id)).toEqual(["1", "2"]);
  expect(client.putCalls).toHaveLength(0);
});

test("B21 UPDATE SET 文字列関数は別フィールドを取得してレコードごとに評価する", async () => {
  const client = makeClient({
    records: [makeRecord({ $id: "1", source: "abc", code: "7" })],
    fieldTypes: {
      source: "SINGLE_LINE_TEXT", code: "SINGLE_LINE_TEXT",
      upper_value: "SINGLE_LINE_TEXT", padded: "SINGLE_LINE_TEXT",
    },
  });
  await execute(
    "UPDATE APP100 SET upper_value = UPPER(source), padded = LPAD(code, 5, '0') WHERE $id = 1",
    client,
    { cacheContext: "b21-update-string-func" }
  );
  expect(client.getCalls[0].fields).toEqual(expect.arrayContaining(["$id", "source", "code"]));
  expect(client.putCalls[0].records[0]).toEqual({
    id: 1,
    record: { upper_value: { value: "ABC" }, padded: { value: "00007" } },
  });
});

test("B21 VALIDATE ONLY は文字列関数の評価結果で ERR_LENGTH_MAX を検出する", async () => {
  const client = makeClient({ records: [makeRecord({ $id: "1", source: "abcd" })] });
  client.getFields = async () => [
    { code: "source", label: "source", fieldType: "SINGLE_LINE_TEXT" },
    { code: "dest", label: "dest", fieldType: "SINGLE_LINE_TEXT", maxLength: "4" },
  ];
  const result = await execute(
    "UPDATE APP100 SET dest = CONCAT(source, 'x') WHERE $id = 1 VALIDATE ONLY",
    client,
    { cacheContext: "b21-validate-string-func" }
  );
  expect(result).toMatchObject({
    type: "VALIDATION", validatedRows: 1, invalidRows: 1, errorCount: 1,
  });
  if (result.type !== "VALIDATION") throw new Error("unexpected result");
  expect(result.errors[0].$err_code).toBe("ERR_LENGTH_MAX");
  expect(client.putCalls).toHaveLength(0);
});

test("INSERT SELECT VALIDATE ONLY はsourceを検証してPOSTしない", async () => {
  const client = makeClient({ recordsByApp: { 200: [makeRecord({ amount: "bad" })] } });
  client.getFields = async (appId) => appId === 100
    ? [{ code: "amount", label: "amount", fieldType: "NUMBER" }]
    : [{ code: "amount", label: "amount", fieldType: "SINGLE_LINE_TEXT" }];
  const result = await execute(
    "INSERT INTO APP100 (amount) SELECT amount FROM APP200 VALIDATE ONLY",
    client,
    { cacheContext: "validate-insert-select" }
  );
  expect(result).toMatchObject({ type: "VALIDATION", validatedRows: 1, invalidRows: 1, errorCount: 1 });
  if (result.type !== "VALIDATION") throw new Error("unexpected result");
  expect(result.errors[0].$err_code).toBe("ERR_TYPE_NUMBER");
  expect(client.postCalls).toHaveLength(0);
});

// ----------------------------------------------------------------
// SELECT
// ----------------------------------------------------------------

test("SELECT * FROM APP100（SIMPLE モード）", async () => {
  const records = [
    makeRecord({ 名前: "田中", 金額: "1000" }),
    makeRecord({ 名前: "鈴木", 金額: "2000" }),
  ];
  const client = makeClient({ records });
  const result = await execute("SELECT * FROM APP100", client) as SelectResult;

  expect(result.type).toBe("SELECT");
  expect(result.rowCount).toBe(2);
  expect(result.rows[0]["名前"]).toBe("田中");
});

test("SIMPLE LIMIT 500 は単発 GET を維持する", async () => {
  const records = Array.from({ length: 501 }, (_, i) => makeRecord({ $id: String(i + 1) }));
  const client = makePagedClient(records);

  const result = await execute("SELECT $id FROM APP100 LIMIT 500", client) as SelectResult;

  expect(result.rowCount).toBe(500);
  expect(client.getCalls).toHaveLength(1);
  expect(client.getCalls[0].query).toContain("limit 500");
});

test("SIMPLE LIMIT 501 は limit 500 以下でページングする", async () => {
  const records = Array.from({ length: 501 }, (_, i) => makeRecord({ $id: String(i + 1) }));
  const client = makePagedClient(records);

  const result = await execute(
    "SELECT $id FROM APP100 LIMIT 501",
    client,
    { maxRecords: 100_000 }
  ) as SelectResult;

  expect(result.rowCount).toBe(501);
  expect(client.getCalls).toHaveLength(2);
  expect(client.getCalls.map((call) => call.query)).toEqual([
    "order by $id asc limit 500 offset 0",
    "order by $id asc limit 500 offset 500",
  ]);
  expect(client.getCalls.every((call) => !/\blimit\s+(?:50[1-9]|[6-9]\d{2}|\d{4,})\b/.test(call.query))).toBe(true);
});

test("SIMPLE LIMIT 1000 は実対象 1000 件をページングして返す", async () => {
  const records = Array.from({ length: 1_000 }, (_, i) => makeRecord({ $id: String(i + 1) }));
  const client = makePagedClient(records);

  const result = await execute(
    "SELECT $id FROM APP100 LIMIT 1000",
    client,
    { maxRecords: 100_000 }
  ) as SelectResult;

  expect(result.rowCount).toBe(1_000);
  // ORDER BY なしでは LIMIT 窓を満たした時点で軟停止する。
  expect(client.getCalls).toHaveLength(2);
  expect(client.getCalls.every((call) => !call.query.includes("limit 1000"))).toBe(true);
});

test("SIMPLE OFFSET + LIMIT は必要件数で軟停止し、OFFSET 適用後の行を返す", async () => {
  const records = Array.from({ length: 5_000 }, (_, i) => makeRecord({ $id: String(i + 1) }));
  const client = makePagedClient(records);

  const result = await execute(
    "SELECT $id FROM APP100 LIMIT 1000 OFFSET 200",
    client,
    { maxRecords: 10_000 }
  ) as SelectResult;

  expect(result.rowCount).toBe(1_000);
  expect(result.rows[0].$id).toBe("201");
  expect(result.rows[999].$id).toBe("1200");
  expect(client.getCalls).toHaveLength(3);
});

test.each(["error", "truncate"] as const)(
  "SIMPLE LIMIT 窓を満たせば対象総数が maxRecords 超でも %s モードで成功する",
  async (onLimitReached) => {
    const records = Array.from({ length: 20_000 }, (_, i) => makeRecord({ $id: String(i + 1) }));
    const client = makePagedClient(records);

    const result = await execute(
      "SELECT $id FROM APP100 LIMIT 1000",
      client,
      { maxRecords: 10_000, onLimitReached }
    ) as SelectResult;

    expect(result.rowCount).toBe(1_000);
    expect(result.warnings).toEqual([]);
    expect(client.getCalls).toHaveLength(2);
  }
);

test("SIMPLE OFFSET + LIMIT が maxRecords を超える場合は従来どおり上限エラー", async () => {
  const records = Array.from({ length: 2_000 }, (_, i) => makeRecord({ $id: String(i + 1) }));
  const client = makePagedClient(records);

  await expect(execute(
    "SELECT $id FROM APP100 LIMIT 1000 OFFSET 200",
    client,
    { maxRecords: 1_000 }
  )).rejects.toThrow("取得件数が上限");
});

test("SIMPLE OFFSET + LIMIT が maxRecords を超える truncate は従来どおり警告する", async () => {
  const records = Array.from({ length: 2_000 }, (_, i) => makeRecord({ $id: String(i + 1) }));
  const client = makePagedClient(records);

  const result = await execute(
    "SELECT $id FROM APP100 LIMIT 1000 OFFSET 200",
    client,
    { maxRecords: 1_000, onLimitReached: "truncate" }
  ) as SelectResult;

  expect(result.rowCount).toBe(800);
  expect(result.warnings).toEqual([expect.stringContaining("取得上限")]);
});

test("B30: truncated local ORDER BY は部分候補の top-1 を返さず fail-closed", async () => {
  const records = Array.from({ length: 101 }, (_, i) => makeRecord({
    $id: String(i + 1),
    会社名: i === 100 ? "a" : `z${String(i).padStart(3, "0")}`,
  }));
  const client = makePagedClient(records);

  await expect(execute(
    "SELECT 会社名 FROM APP100 WHERE 会社名 LIKE '%' ORDER BY 会社名 ASC LIMIT 1",
    client,
    { maxRecords: 100, onLimitReached: "truncate" }
  )).rejects.toThrow("ORDER BYの正しい結果には完全な候補集合が必要");
});

test("B27: $id canonical REST top-N は B30 の完全入力要求を免除する", async () => {
  const records = Array.from({ length: 101 }, (_, i) => makeRecord({ $id: String(i + 1) }));
  const client = makePagedClient(records);

  const result = await execute(
    "SELECT $id FROM APP100 ORDER BY $id DESC LIMIT 1",
    client,
    { maxRecords: 1, onLimitReached: "truncate" }
  ) as SelectResult;

  expect(result.rows).toEqual([{ $id: "101" }]);
  expect(client.getCalls).toHaveLength(1);
  expect(client.getCalls[0].query).toContain("order by $id desc limit 1");
  expect(client.getCalls[0].query.match(/\$id/g)).toHaveLength(1);
});

test("B27: local ORDER key は SELECT 出力列でなくても取得して並べ替える", async () => {
  const client = makePagedClient([
    makeRecord({ $id: "1", 会社名: "z" }),
    makeRecord({ $id: "2", 会社名: "a" }),
  ]);
  client.getFields = async () => [
    { code: "会社名", label: "会社名", fieldType: "SINGLE_LINE_TEXT" },
  ];

  const result = await execute(
    "SELECT $id FROM APP100 ORDER BY 会社名 ASC LIMIT 1",
    client
  ) as SelectResult;

  expect(result.rows).toEqual([{ $id: "2" }]);
  expect(client.getCalls[0].fields).toEqual(expect.arrayContaining(["$id", "会社名"]));
  expect(client.getCalls[0].query).not.toContain("order by 会社名");
});

test("B27: local同値群は stable $id ASC の後に OFFSET/LIMIT を適用する", async () => {
  const client = makePagedClient([
    makeRecord({ $id: "1", 会社名: "same" }),
    makeRecord({ $id: "2", 会社名: "same" }),
    makeRecord({ $id: "3", 会社名: "same" }),
  ]);
  client.getFields = async () => [
    { code: "会社名", label: "会社名", fieldType: "SINGLE_LINE_TEXT" },
  ];

  const result = await execute(
    "SELECT $id, 会社名 FROM APP100 ORDER BY 会社名 ASC LIMIT 1 OFFSET 1",
    client
  ) as SelectResult;

  expect(result.rows).toEqual([{ $id: "2", 会社名: "same" }]);
});

test("B27: compareMode unsupported は行数に依存せず records GET 前に拒否する", async () => {
  const client = makeClient({ records: [] });
  client.getFields = async () => [
    { code: "利用者", label: "利用者", fieldType: "USER_SELECT" },
  ];

  await expect(execute(
    "SELECT $id FROM APP100 ORDER BY 利用者 ASC LIMIT 1",
    client
  )).rejects.toThrow(/ORDER_KEY_UNSUPPORTED/);
  expect(client.getCalls).toHaveLength(0);
});

test("B27: 未解決 ORDER key も空集合として成功させない", async () => {
  const client = makeClient({ records: [] });
  client.getFields = async () => [];

  await expect(execute(
    "SELECT $id FROM APP100 ORDER BY typo ASC LIMIT 1",
    client
  )).rejects.toThrow(/ORDER_KEY_UNRESOLVED/);
  expect(client.getCalls).toHaveLength(0);
});

test("B27: JOIN の曖昧な非修飾 ORDER key は型未解決と区別して拒否する", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [makeRecord({ $id: "1", code: "A", name: "left" })],
      200: [makeRecord({ $id: "2", code: "A", name: "right" })],
    },
  });

  await expect(execute(
    "SELECT a.$id FROM APP100 a JOIN APP200 b ON a.code = b.code ORDER BY name LIMIT 1",
    client
  )).rejects.toThrow(/ambiguous column reference.*ORDER_KEY_AMBIGUOUS/);
  expect(client.getCalls).toHaveLength(0);
});

test("B27: JOIN の曖昧な ORDER key は表修飾すれば実行できる", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [makeRecord({ $id: "1", code: "A", name: "left" })],
      200: [makeRecord({ $id: "2", code: "A", name: "right" })],
    },
  });

  const result = await execute(
    "SELECT a.$id FROM APP100 a JOIN APP200 b ON a.code = b.code ORDER BY a.name LIMIT 1",
    client
  );
  expect(result.type).toBe("SELECT");
  if (result.type === "SELECT") expect(result.rows).toEqual([{ "$id": "1" }]);
});

test("B27: window ORDER BY の unsupported key も records GET 前に拒否する", async () => {
  const client = makeClient({ records: [] });
  client.getFields = async () => [
    { code: "利用者", label: "利用者", fieldType: "USER_SELECT" },
  ];

  await expect(execute(
    "SELECT RANK() OVER (ORDER BY 利用者 ASC) AS r FROM APP100",
    client
  )).rejects.toThrow(/ORDER_KEY_UNSUPPORTED/);
  expect(client.getCalls).toHaveLength(0);
});

test("B31: KORDER BY は kintone native 順を単発 GET のまま保持する", async () => {
  const client = makeClient({
    records: [
      makeRecord({ $id: "9", 金額: "10" }),
      makeRecord({ $id: "2", 金額: "2" }),
    ],
    fieldTypes: { 金額: "NUMBER" },
  });

  const result = await execute(
    "SELECT $id, 金額 FROM APP100 WHERE 金額 > 0 KORDER BY 金額 DESC, $id ASC LIMIT 5 OFFSET 2",
    client,
    { maxRecords: 5, onLimitReached: "truncate" }
  ) as SelectResult;

  // mock の返却順をローカルで並べ直さず、そのまま kintone native 順として採用する。
  expect(result.rows).toEqual([
    { $id: "9", 金額: "10" },
    { $id: "2", 金額: "2" },
  ]);
  expect(client.getCalls).toHaveLength(1);
  expect(client.getCalls[0].query).toContain("金額 > 0");
  expect(client.getCalls[0].query).toContain("order by 金額 desc, $id asc limit 5 offset 2");
  expect(result.warnings).toEqual([]);
});

test("B31: canonical ORDER BY と KORDER BY は同値群の順序を意図的に共有しない", async () => {
  const canonicalClient = makePagedClient([
    makeRecord({ $id: "1", 名前: "same" }),
    makeRecord({ $id: "2", 名前: "same" }),
  ]);
  canonicalClient.getFields = async () => [
    { code: "名前", label: "名前", fieldType: "SINGLE_LINE_TEXT" },
  ];
  const canonical = await execute(
    "SELECT $id FROM APP100 ORDER BY 名前 LIMIT 2",
    canonicalClient
  ) as SelectResult;

  // native mock は kintone の暗黙 tie 順を表す。KORDER はこれを canonical $id ASC へ直さない。
  const nativeClient = makeClient({
    records: [
      makeRecord({ $id: "2", 名前: "same" }),
      makeRecord({ $id: "1", 名前: "same" }),
    ],
    fieldTypes: { 名前: "SINGLE_LINE_TEXT" },
  });
  const native = await execute(
    "SELECT $id FROM APP100 KORDER BY 名前 LIMIT 2",
    nativeClient
  ) as SelectResult;

  expect(canonical.rows).toEqual([{ $id: "1" }, { $id: "2" }]);
  expect(native.rows).toEqual([{ $id: "2" }, { $id: "1" }]);
});

test("B31: KORDER BY LIMIT 0 は全 planning 検査後に records GET なしで空結果を返す", async () => {
  const client = makeClient({ fieldTypes: { 金額: "NUMBER" } });

  const result = await execute(
    "SELECT $id, 金額 FROM APP100 KORDER BY 金額 LIMIT 0",
    client
  ) as SelectResult;

  expect(result).toMatchObject({ rowCount: 0, rows: [], columns: ["$id", "金額"] });
  expect(client.getCalls).toHaveLength(0);
});

test("B33: KORDER_CURSOR は複数pageを連結し、LIMIT到達後に明示closeする", async () => {
  const client = makeClient();
  let page = 0;
  let closes = 0;
  client.openCursor = async (params) => {
    expect(params.query).toBe("order by $id asc");
    expect(params.size).toBe(500);
    return {
      totalCount: 600,
      async nextPage() {
        page += 1;
        const start = (page - 1) * 500 + 1;
        const count = page === 1 ? 500 : 1;
        return {
          records: Array.from({ length: count }, (_v, i) => makeRecord({ $id: String(start + i) })),
          next: true,
        };
      },
      async close() { closes += 1; },
    };
  };
  const result = await execute(
    "SELECT $id FROM APP100 KORDER BY $id LIMIT 501",
    client,
    { maxRecords: 501 }
  ) as SelectResult;
  expect(result.rowCount).toBe(501);
  expect(result.rows[500]).toEqual({ $id: "501" });
  expect(page).toBe(2);
  expect(closes).toBe(1);
  expect(client.getCalls).toHaveLength(0);
  expect(result.metrics).toMatchObject({
    cursorCreateCalls: 1,
    cursorGetCalls: 2,
    cursorDeleteCalls: 1,
    cursorRecordsScanned: 501,
    cursorActiveCurrent: 0,
    cursorActivePeak: 1,
    cursorCleanupFailures: 0,
  });
});

test.each([0, 1])("B31: native allowlist 外は LIMIT %i でも records GET 前に拒否する", async (limit) => {
  const client = makeClient({ fieldTypes: { 利用者: "USER_SELECT" } });

  await expect(execute(
    `SELECT $id FROM APP100 KORDER BY 利用者 LIMIT ${limit}`,
    client
  )).rejects.toThrow(/KORDER_TYPE_UNSUPPORTED/);
  expect(client.getCalls).toHaveLength(0);
});

test.each([
  ["SELECT $id FROM APP100 KORDER BY $id", "KORDER_LIMIT_INVALID"],
] as const)("B31: native REST window 条件を fail-closed にする: %s", async (sql, reason) => {
  const client = makeClient();
  await expect(execute(sql, client)).rejects.toThrow(reason);
  expect(client.getCalls).toHaveLength(0);
});

test("B31: LIMIT が実行時 maxRecords を超える KORDER BY を拒否する", async () => {
  const client = makeClient();
  await expect(execute(
    "SELECT $id FROM APP100 KORDER BY $id LIMIT 5",
    client,
    { maxRecords: 4 }
  )).rejects.toThrow(/KORDER_SCAN_ROWS_EXCEEDS_MAX_RECORDS/);
  expect(client.getCalls).toHaveLength(0);
});

test("B31: residual WHERE と KLIKE を native order へ混在させない", async () => {
  const residual = makeClient({ fieldTypes: { 名前: "SINGLE_LINE_TEXT" } });
  await expect(execute(
    "SELECT $id FROM APP100 WHERE 名前 > 'a' KORDER BY $id LIMIT 5",
    residual
  )).rejects.toThrow(/KORDER_WHERE_NOT_EXACT/);
  expect(residual.getCalls).toHaveLength(0);

  const klike = makeClient({ fieldTypes: { 名前: "SINGLE_LINE_TEXT" } });
  await expect(execute(
    "SELECT $id FROM APP100 WHERE 名前 KLIKE 'a' KORDER BY $id LIMIT 5",
    klike
  )).rejects.toThrow(/KORDER_KLIKE_UNSUPPORTED/);
  expect(klike.getCalls).toHaveLength(0);
});

test("B31: SELECT alias は native order の物理フィールドとして扱わない", async () => {
  const client = makeClient({ fieldTypes: { 金額: "NUMBER" } });
  await expect(execute(
    "SELECT 金額 AS 別名 FROM APP100 KORDER BY 別名 LIMIT 5",
    client
  )).rejects.toThrow(/KORDER_KEY_NOT_DIRECT_FIELD/);
  expect(client.getCalls).toHaveLength(0);
});

test("B31: STATUS native order は process status metadata を取得しない", async () => {
  const client = makeClient({ fieldTypes: { ステータス: "STATUS" } });
  let statusCalls = 0;
  client.getProcessStatuses = async () => {
    statusCalls += 1;
    return { enable: true, states: [{ name: "完了", index: 0 }] };
  };

  await execute(
    "SELECT ステータス FROM APP100 KORDER BY ステータス LIMIT 1",
    client
  );
  expect(statusCalls).toBe(0);
  expect(client.getCalls).toHaveLength(1);
});

test("B30: window ORDER BY も truncate を fail-closed にする", async () => {
  const records = Array.from({ length: 101 }, (_, i) => makeRecord({
    $id: String(i + 1),
    会社名: String.fromCodePoint(0x7a + (i % 2)),
  }));
  const client = makePagedClient(records);

  await expect(execute(
    "SELECT 会社名, ROW_NUMBER() OVER (ORDER BY 会社名 ASC) AS rn FROM APP100",
    client,
    { maxRecords: 100, onLimitReached: "truncate" }
  )).rejects.toThrow("ORDER BYの正しい結果には完全な候補集合が必要");
});

test.each([
  [
    "UNION",
    "SELECT 会社名 FROM APP200 UNION ALL " +
      "SELECT 会社名 FROM APP100 WHERE 会社名 LIKE '%' ORDER BY 会社名",
  ],
  [
    "WITH",
    "WITH x AS (SELECT 会社名 FROM APP100 WHERE 会社名 LIKE '%' ORDER BY 会社名) " +
      "SELECT 会社名 FROM x",
  ],
])("B30: %s 内の ORDER BY も完全入力を要求する", async (_label, sql) => {
  const records = Array.from({ length: 101 }, (_, i) => makeRecord({
    $id: String(i + 1),
    会社名: i === 100 ? "a" : `z${String(i).padStart(3, "0")}`,
  }));
  const client = makeClient({ recordsByApp: { 100: records, 200: [] } });

  await expect(execute(sql, client, {
    maxRecords: 100,
    onLimitReached: "truncate",
  })).rejects.toThrow("ORDER BYの正しい結果には完全な候補集合が必要");
});

test("B32: SINGLE_LINE_TEXT の範囲比較は押し下げず local WHERE で評価", async () => {
  const client = makeClient({
    records: [
      makeRecord({ $id: "1", 郵便番号: "20" }),
      makeRecord({ $id: "2", 郵便番号: "99" }),
      makeRecord({ $id: "3", 郵便番号: "10" }),
    ],
  });
  client.getFields = async () => [
    { code: "郵便番号", label: "郵便番号", fieldType: "SINGLE_LINE_TEXT" },
  ];
  const originalGetRecords = client.getRecords;
  client.getRecords = async (params) => {
    if (params.query.includes('郵便番号 > "100"')) {
      throw new Error("GAIA_IQ03: 郵便番号フィールドに演算子>を使用できません");
    }
    return originalGetRecords(params);
  };

  const result = await execute(
    "SELECT 郵便番号 FROM APP100 WHERE 郵便番号 > '100' LIMIT 5",
    client,
    { cacheContext: "b32-baseline" }
  ) as SelectResult;
  expect(result.rows.map((row) => row.郵便番号)).toEqual(["20", "99"]);
  expect(client.getCalls.every((call) => !call.query.includes('郵便番号 > "100"'))).toBe(true);
});

test("B32 Phase 3: SINGLE_LINE_TEXT の範囲比較は REST query へ押し下げない", async () => {
  const client = makeClient({ records: [
    makeRecord({ $id: "1", 郵便番号: "20" }),
    makeRecord({ $id: "2", 郵便番号: "99" }),
  ] });
  client.getFields = async () => [
    { code: "郵便番号", label: "郵便番号", fieldType: "SINGLE_LINE_TEXT" },
  ];
  const result = await execute(
    "SELECT 郵便番号 FROM APP100 WHERE 郵便番号 > '100' LIMIT 5",
    client,
    { cacheContext: "b32-phase3-select" }
  ) as SelectResult;

  expect(result.type).toBe("SELECT");
  expect(client.getCalls.length).toBeGreaterThan(0);
  expect(client.getCalls.every((call) => !call.query.includes("郵便番号 >"))).toBe(true);
});

test("B32 Phase 3: DML の REST 非対応 WHERE は GET/PUT 前に拒否する", async () => {
  const client = makeClient({ fieldTypes: { 郵便番号: "SINGLE_LINE_TEXT" } });
  await expect(execute(
    "UPDATE APP100 SET 郵便番号 = '200' WHERE 郵便番号 > '100'",
    client,
    { cacheContext: "b32-phase3-dml" }
  )).rejects.toThrow(/DmlConvertError|cannot be represented by kintone REST/);
  expect(client.getCalls).toHaveLength(0);
  expect(client.putCalls).toHaveLength(0);
});

test("SIMPLE ORDER BY は LIMIT 500 / 501 境界で同じ先頭 500 行を返す", async () => {
  const records = Array.from({ length: 501 }, (_, i) => makeRecord({ $id: String(i + 1) }));
  const singleClient = makePagedClient(records);
  const pagedClient = makePagedClient(records);

  const single = await execute(
    "SELECT $id FROM APP100 ORDER BY $id DESC LIMIT 500",
    singleClient
  ) as SelectResult;
  const paged = await execute(
    "SELECT $id FROM APP100 ORDER BY $id DESC LIMIT 501",
    pagedClient,
    { maxRecords: 100_000 }
  ) as SelectResult;

  expect(paged.rows.slice(0, 500)).toEqual(single.rows);
  expect(singleClient.getCalls).toHaveLength(1);
  expect(pagedClient.getCalls.length).toBeGreaterThan(1);
});

test("SIMPLE KLIKE LIMIT 501 はページングし、クライアント層の検索打ち切り捕捉を維持する", async () => {
  const records = Array.from({ length: 501 }, (_, i) => makeRecord({
    $id: String(i + 1),
    件名: "至急",
  }));
  const client = makePagedClient(records, { searchAborted: true });

  const result = await execute(
    "SELECT $id FROM APP100 WHERE 件名 KLIKE '至急' LIMIT 501",
    client,
    { maxRecords: 100_000 }
  ) as SelectResult;

  expect(result.rowCount).toBe(501);
  expect(client.getCalls.length).toBeGreaterThan(1);
  expect(client.getCalls.every((call) => call.query.includes('件名 like "至急"'))).toBe(true);
  // fetchAll の個別 callback ではなく wrapClientWithSearchAbort が全 GET を捕捉する。
  expect(result.warnings).toEqual([expect.stringContaining("10 万件で打ち切られ")]);
});

test("SIMPLE KLIKE は LIMIT 窓で軟停止せず全ページを検査する", async () => {
  const records = Array.from({ length: 1_500 }, (_, i) => makeRecord({
    $id: String(i + 1),
    件名: "至急",
  }));
  const client = makePagedClient(records, { searchAborted: true });

  const result = await execute(
    "SELECT $id FROM APP100 WHERE 件名 KLIKE '至急' LIMIT 1000",
    client,
    { maxRecords: 10_000 }
  ) as SelectResult;

  expect(result.rowCount).toBe(1_000);
  expect(client.getCalls).toHaveLength(4);
  expect(result.warnings).toEqual([expect.stringContaining("10 万件で打ち切られ")]);
});

test("SIMPLE ORDER BY は LIMIT 窓で軟停止せず全件を取得してから並べ替える", async () => {
  const records = Array.from({ length: 1_500 }, (_, i) => makeRecord({ $id: String(i + 1) }));
  const client = makePagedClient(records);

  const result = await execute(
    "SELECT $id FROM APP100 ORDER BY $id DESC LIMIT 1000",
    client,
    { maxRecords: 10_000 }
  ) as SelectResult;

  expect(result.rowCount).toBe(1_000);
  expect(result.rows[0].$id).toBe("1500");
  expect(result.rows[999].$id).toBe("501");
  expect(client.getCalls).toHaveLength(4);
});

test("SELECT ORDER BY（並列取得時）: API クエリに元の order by を混在させない", async () => {
  const records = [
    makeRecord({ $id: "1", 担当者名: "田中" }),
  ];
  const client = makeClient({ records });
  const result = await execute(
    "SELECT * FROM APP440 ORDER BY 担当者名",
    client,
    { fetchParallel: 2 }
  ) as SelectResult;

  expect(result.type).toBe("SELECT");
  expect(client.getCalls[0].query).toBe("order by $id asc limit 500 offset 0");
  expect(client.getCalls[0].query).not.toContain("担当者名 asc and");
});

test("SELECT ORDER BY（並列取得時）: フィールド定義取得は1回だけ", async () => {
  const records = [makeRecord({ $id: "1", 担当者名: "田中" })];
  const client = makeClient({ records });
  let getFieldsCount = 0;
  const origGetFields = client.getFields.bind(client);
  client.getFields = async (appId: number) => {
    getFieldsCount += 1;
    return origGetFields(appId);
  };

  await execute(
    "SELECT * FROM APP9440 ORDER BY 担当者名",
    client,
    { fetchParallel: 2 }
  );

  expect(getFieldsCount).toBe(1);
});

test("SELECT WHERE = 文字列", async () => {
  const records = [makeRecord({ ステータス: "完了", 金額: "500" })];
  const client = makeClient({ records });
  const result = await execute(
    "SELECT ステータス, 金額 FROM APP100 WHERE ステータス = '完了'",
    client
  ) as SelectResult;

  expect(result.rowCount).toBe(1);
  expect(result.rows[0]).toEqual({ ステータス: "完了", 金額: "500" });
});

test("負数の IN は SIMPLE で引用符なしに押し下げ、FULL_SCAN と同じ結果になる", async () => {
  const records = [
    makeRecord({ 金額: "-1" }),
    makeRecord({ 金額: "0" }),
    makeRecord({ 金額: "1" }),
  ];
  const client = makeClient();
  client.getFields = async () => [
    { code: "金額", label: "金額", fieldType: "NUMBER" },
  ];
  client.getRecords = async (params) => {
    client.getCalls.push({
      app: params.app,
      query: params.query ?? "",
      fields: [...(params.fields ?? [])],
    });
    return {
      records: params.query?.includes("金額 in (-1)") ? [records[0]] : records,
    };
  };

  const simple = await execute(
    "SELECT 金額 FROM APP100 WHERE 金額 IN (-1)",
    client,
    { cacheContext: "negative-in-simple" }
  ) as SelectResult;
  const fullScan = await execute(
    "SELECT DISTINCT 金額 FROM APP100 WHERE 金額 IN (-1)",
    client,
    { cacheContext: "negative-in-full-scan" }
  ) as SelectResult;

  expect(simple.rows).toEqual([{ 金額: "-1" }]);
  expect(fullScan.rows).toEqual(simple.rows);
  expect(client.getCalls[0].query).toContain("金額 in (-1)");
  expect(client.getCalls[0].query).not.toContain('"-1"');
  expect(client.getCalls[1].query).toContain("金額 in (-1)");
  expect(client.getCalls[1].query).not.toContain('"-1"');
});

test("FULL_SCAN: CHECK_BOX IN は JSON 全体でなく選択要素を評価する", async () => {
  const client = makeClient({ records: [
    makeTypedRecord({ $id: "1", 選択: ["A", "B"], 件名: "one" }),
    makeTypedRecord({ $id: "2", 選択: ["B"], 件名: "two" }),
  ] });
  client.getFields = async () => [
    { code: "選択", label: "選択", fieldType: "CHECK_BOX" },
    { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
  ];

  const result = await execute(
    "SELECT $id FROM APP98101 WHERE 選択 IN ('A') AND 件名 LIKE '%'",
    client,
    { cacheContext: "typed-in-checkbox" }
  ) as SelectResult;

  expect(result.rows).toEqual([{ $id: "1" }]);
});

test("FULL_SCAN: SELECT CASE WHEN 内の USER_SELECT IN も code 評価する", async () => {
  const client = makeClient({ records: [
    makeTypedRecord({ 主担当: [{ code: "rex0220", name: "開発太郎" }] }),
  ] });
  client.getFields = async () => [
    { code: "主担当", label: "主担当", fieldType: "USER_SELECT" },
  ];

  const result = await execute(
    "SELECT CASE WHEN 主担当 IN ('rex0220') THEN 'yes' ELSE 'no' END AS hit FROM APP98102",
    client,
    { cacheContext: "typed-in-case" }
  ) as SelectResult;

  expect(result.rows).toEqual([{ hit: "yes" }]);
});

test("FULL_SCAN: USER_SELECT IN (SELECT ...) は解決済み code 集合を評価する", async () => {
  const client = makeClient({ recordsByApp: {
    98103: [makeTypedRecord({ $id: "1", 主担当: [{ code: "rex0220", name: "開発太郎" }] })],
    98104: [makeRecord({ code: "rex0220" })],
  } });
  client.getFields = async (appId) => appId === 98103
    ? [{ code: "主担当", label: "主担当", fieldType: "USER_SELECT" }]
    : [{ code: "code", label: "code", fieldType: "SINGLE_LINE_TEXT" }];

  const result = await execute(
    "SELECT $id FROM APP98103 WHERE 主担当 IN (SELECT code FROM APP98104) AND $id LIKE '%'",
    client,
    { cacheContext: "typed-in-subquery" }
  ) as SelectResult;

  expect(result.rows).toEqual([{ $id: "1" }]);
});

test("FULL_SCAN JOIN: 修飾列は各型、衝突する非修飾列は従来比較を使う", async () => {
  const client = makeClient({ recordsByApp: {
    98105: [makeTypedRecord({ $id: "1", 共通: ["A"] })],
    98106: [makeRecord({ $id: "1", 共通: '["A"]' })],
  } });
  client.getFields = async (appId) => appId === 98105
    ? [{ code: "共通", label: "共通", fieldType: "CHECK_BOX" }]
    : [{ code: "共通", label: "共通", fieldType: "SINGLE_LINE_TEXT" }];

  const qualified = await execute(
    "SELECT a.$id FROM APP98105 a JOIN APP98106 b ON a.$id = b.$id " +
      "WHERE a.共通 IN ('A') AND b.共通 IN ('[\"A\"]')",
    client,
    { cacheContext: "typed-in-join-qualified" }
  ) as SelectResult;
  expect(qualified.rowCount).toBe(1);

  const unqualified = await execute(
    "SELECT a.$id FROM APP98105 a JOIN APP98106 b ON a.$id = b.$id " +
      "WHERE 共通 IN ('[\"A\"]')",
    client,
    { cacheContext: "typed-in-join-unqualified" }
  ) as SelectResult;
  expect(unqualified.rowCount).toBe(1);
});

test("SELECT 算術式: field * number AS alias", async () => {
  const records = [
    makeRecord({ 金額: "1000" }),
    makeRecord({ 金額: "2000" }),
  ];
  const client = makeClient({ records });
  const result = await execute(
    "SELECT 金額 * 1.1 AS 税込 FROM APP100",
    client
  ) as SelectResult;

  expect(result.rowCount).toBe(2);
  expect(result.rows[0]["税込"]).toBe("1100");
  expect(result.rows[1]["税込"]).toBe("2200");
});

test("SELECT 算術式: alias なしはデフォルトキー名", async () => {
  const records = [makeRecord({ $id: "5" })];
  const client = makeClient({ records });
  const result = await execute(
    "SELECT $id * 1.1 FROM APP100",
    client
  ) as SelectResult;

  expect(result.rows[0]["$id*1.1"]).toBe("5.5");
});

test("SELECT 文字列リテラル列", async () => {
  const records = [makeRecord({ 顧客名: "A社" })];
  const client = makeClient({ records });
  const result = await execute(
    "SELECT 顧客名, 'XXX' AS a FROM APP60",
    client
  ) as SelectResult;
  expect(result.rowCount).toBe(1);
  expect(result.rows[0]).toEqual({ 顧客名: "A社", a: "XXX" });
});

test("SELECT literal without FROM returns one row", async () => {
  const client = makeClient({});
  const result = await execute(
    "SELECT 'xxx' AS a",
    client
  ) as SelectResult;
  expect(result.rowCount).toBe(1);
  expect(result.rows[0]).toEqual({ a: "xxx" });
});

test("SELECT field without FROM is rejected", async () => {
  const client = makeClient({});
  await expect(
    execute("SELECT 顧客名", client)
  ).rejects.toThrow("not supported without FROM");
});

test("SELECT: 未存在フィールドコードを指定するとエラー", async () => {
  const records = [makeRecord({ 名前: "田中" })];
  const client = makeClient({ records });
  client.getFields = async (_appId) => ([
    { code: "名前", label: "名前", fieldType: "SINGLE_LINE_TEXT" },
  ]);

  await expect(
    execute("SELECT 存在しない FROM APP100", client, { cacheContext: "unknown-field-test" })
  ).rejects.toThrow("ArgumentError: unknown field code(s): 存在しない (APP100)");
});

test("SELECT COUNT(*) GROUP BY（FULL_SCAN モード）", async () => {
  const records = [
    makeRecord({ 種別: "A", 金額: "100" }),
    makeRecord({ 種別: "A", 金額: "200" }),
    makeRecord({ 種別: "B", 金額: "300" }),
  ];
  const client = makeClient({ records });
  const result = await execute(
    "SELECT 種別, COUNT(*) AS cnt FROM APP100 GROUP BY 種別 ORDER BY 種別 ASC",
    client
  ) as SelectResult;

  expect(result.type).toBe("SELECT");
  expect(result.rows).toEqual([
    { 種別: "A", cnt: "2" },
    { 種別: "B", cnt: "1" },
  ]);
});

test("GROUP_CONCAT: GROUP BY・HAVING/ORDER BY alias・DISTINCT・SEPARATOR", async () => {
  const client = makeClient({
    records: [
      makeRecord({ 種別: "A", 担当者: "田中" }),
      makeRecord({ 種別: "A", 担当者: "鈴木" }),
      makeRecord({ 種別: "A", 担当者: "田中" }),
      makeRecord({ 種別: "B", 担当者: "佐藤" }),
      makeRecord({ 種別: "C", 担当者: "" }),
    ],
  });
  const result = await execute(
    "SELECT 種別, GROUP_CONCAT(DISTINCT 担当者 SEPARATOR ' / ') AS members " +
    "FROM APP100 GROUP BY 種別 " +
    "HAVING GROUP_CONCAT(DISTINCT 担当者 SEPARATOR ' / ') != '' ORDER BY members DESC",
    client
  ) as SelectResult;

  expect(result.rows).toEqual([
    { 種別: "A", members: "田中 / 鈴木" },
    { 種別: "B", members: "佐藤" },
  ]);
  expect(client.getCalls[0].fields).not.toContain("members");
});

test("GROUP_CONCAT: UNION で alias 列を位置対応させる", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [makeRecord({ 名前: "A" }), makeRecord({ 名前: "B" })],
      200: [makeRecord({ 名前: "C" }), makeRecord({ 名前: "D" })],
    },
  });
  const result = await execute(
    "SELECT GROUP_CONCAT(名前 SEPARATOR '/') AS members FROM APP100 " +
    "UNION ALL SELECT GROUP_CONCAT(名前 SEPARATOR '/') AS members FROM APP200",
    client
  ) as SelectResult;

  expect(result.columns).toEqual(["members"]);
  expect(result.rows).toEqual([{ members: "A/B" }, { members: "C/D" }]);
});

test("集計算術式: 末尾が集計関数でも alias と値を保持する", async () => {
  const client = makeClient({
    records: [
      makeRecord({ a: "10", b: "3", c: "2" }),
      makeRecord({ a: "10", b: "2", c: "3" }),
    ],
  });

  const result = await execute(
    "SELECT SUM(a) - SUM(b) AS diff, SUM(a) / COUNT(*) AS ratio, " +
    "SUM(DISTINCT a) - SUM(b) AS distinct_diff, " +
    "SUM(c) + (SUM(a) - SUM(b)) AS nested, SUM(c) + -SUM(a) AS negated " +
    "FROM APP77100",
    client
  ) as SelectResult;

  expect(result.columns).toEqual(["diff", "ratio", "distinct_diff", "nested", "negated"]);
  expect(result.rows).toEqual([{
    diff: "15",
    ratio: "10",
    distinct_diff: "5",
    nested: "20",
    negated: "-15",
  }]);
});

test("集計算術式 alias: HAVING と ORDER BY が alias 値で解決される", async () => {
  const client = makeClient({
    records: [
      makeRecord({ 種別: "A", a: "10", b: "3" }),
      makeRecord({ 種別: "B", a: "5", b: "10" }),
      makeRecord({ 種別: "C", a: "20", b: "1" }),
    ],
  });

  const result = await execute(
    "SELECT 種別, SUM(a) - SUM(b) AS diff FROM APP77101 " +
    "GROUP BY 種別 HAVING diff > 0 ORDER BY diff DESC",
    client
  ) as SelectResult;

  expect(result.columns).toEqual(["種別", "diff"]);
  expect(result.rows).toEqual([
    { 種別: "C", diff: "19" },
    { 種別: "A", diff: "7" },
  ]);
  expect(client.getCalls[0].fields).not.toContain("diff");
});

test("集計算術式 alias: CTE 後段から alias で参照できる", async () => {
  const client = makeClient({
    recordsByApp: {
      77102: [makeRecord({ 種別: "A", a: "10", b: "3" })],
    },
  });

  const result = await execute(
    "WITH g AS (SELECT 種別, SUM(a) - SUM(b) AS diff FROM APP77102 GROUP BY 種別) " +
    "SELECT diff FROM g",
    client
  ) as SelectResult;

  expect(result.columns).toEqual(["diff"]);
  expect(result.rows).toEqual([{ diff: "7" }]);
});

test("集計算術式 alias: UNION の左辺列名として使われる", async () => {
  const client = makeClient({
    recordsByApp: {
      77103: [makeRecord({ a: "10", b: "3" })],
      77104: [makeRecord({ value: "9" })],
    },
  });

  const result = await execute(
    "SELECT SUM(a) - SUM(b) AS diff FROM APP77103 UNION ALL SELECT value FROM APP77104",
    client
  ) as SelectResult;

  expect(result.columns).toEqual(["diff"]);
  expect(result.rows).toEqual([{ diff: "7" }, { diff: "9" }]);
});

test("SELECT DISTINCT（FULL_SCAN モード）", async () => {
  const records = [
    makeRecord({ 種別: "B" }),
    makeRecord({ 種別: "A" }),
    makeRecord({ 種別: "A" }),
  ];
  const client = makeClient({ records });
  const result = await execute(
    "SELECT DISTINCT 種別 FROM APP100 ORDER BY 種別 ASC",
    client
  ) as SelectResult;

  expect(result.rows.map((r) => r["種別"])).toEqual(["A", "B"]);
});

test("FULL_SCAN: JOIN + GROUP BY は必要フィールドのみ取得", async () => {
  const client = makeClient({
    recordsByApp: {
      89: [makeRecord({ 顧客名: "A", 顧客ランク: "S" })],
      88: [makeRecord({ 顧客名: "A", 合計費用: "1000" })],
    },
  });

  await execute(
    "SELECT a.顧客ランク AS 顧客ランク, FORMAT(SUM(b.合計費用),'#,##0') AS 合計 FROM APP89 AS a INNER JOIN APP88 AS b ON a.顧客名 = b.顧客名 GROUP BY a.顧客ランク",
    client
  );

  const app89Call = client.getCalls.find((c) => c.app === 89);
  const app88Call = client.getCalls.find((c) => c.app === 88);
  expect(app89Call).toBeDefined();
  expect(app88Call).toBeDefined();

  const app89Fields = new Set(app89Call?.fields ?? []);
  const app88Fields = new Set(app88Call?.fields ?? []);
  expect(app89Fields.has("顧客名")).toBe(true);
  expect(app89Fields.has("顧客ランク")).toBe(true);
  expect(app89Fields.has("$id")).toBe(true);
  expect(app89Fields.size).toBe(3);
  expect(app88Fields.has("顧客名")).toBe(true);
  expect(app88Fields.has("合計費用")).toBe(true);
  expect(app88Fields.has("$id")).toBe(true);
  expect(app88Fields.size).toBe(3);
});

test("FULL_SCAN: 単純 INNER JOIN は join 側を IN 条件で取得する", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [
        makeRecord({ $id: "1", 顧客名: "A" }),
        makeRecord({ $id: "2", 顧客名: "B" }),
      ],
      101: [
        makeRecord({ $id: "10", 顧客名: "A", 金額: "1000" }),
      ],
    },
  });

  await execute(
    "SELECT a.顧客名, b.金額 FROM APP100 AS a INNER JOIN APP101 AS b ON a.顧客名 = b.顧客名",
    client
  );

  const joinCall = client.getCalls.find((c) => c.app === 101);
  expect(joinCall).toBeDefined();
  expect(joinCall?.query).toContain(" in (");
  expect(joinCall?.query).toContain("顧客名");
});

test("FULL_SCAN: JOIN の非 AS 列は結果ヘッダを非修飾名にする", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [makeRecord({ $id: "1", 顧客名: "A" })],
      101: [makeRecord({ $id: "10", 顧客名: "A", 金額: "1000" })],
    },
  });

  const result = await execute(
    "SELECT a.顧客名, b.金額 FROM APP100 AS a INNER JOIN APP101 AS b ON a.顧客名 = b.顧客名",
    client
  ) as SelectResult;

  expect(result.columns).toEqual(["顧客名", "金額"]);
  expect(result.rows[0]).toEqual({ 顧客名: "A", 金額: "1000" });
});

test("FULL_SCAN: JOINキーが多い場合は ON 最適化をスキップして全件取得にフォールバック", async () => {
  const sourceRows = Array.from({ length: 301 }).map((_, i) =>
    makeRecord({ $id: String(i + 1), 顧客名: `C${i + 1}` })
  );
  const client = makeClient({
    recordsByApp: {
      100: sourceRows,
      101: [makeRecord({ $id: "10", 顧客名: "C1", 金額: "1000" })],
    },
  });

  const result = await execute(
    "SELECT a.顧客名, b.金額 FROM APP100 AS a INNER JOIN APP101 AS b ON a.顧客名 = b.顧客名",
    client
  );

  const joinCall = client.getCalls.find((c) => c.app === 101);
  expect(joinCall).toBeDefined();
  expect(joinCall?.query).toContain("limit 500 offset 0");
  expect(joinCall?.query).not.toContain(" in (");
  expect(result.type).toBe("SELECT");
  if (result.type === "SELECT") {
    expect(result.warnings?.some((w) => w.includes("ON 最適化をスキップ"))).toBe(true);
  }
});

test("FULL_SCAN: JOIN + WHERE（join側フィールド）は API WHERE に押し込まず JS で評価する", async () => {
  const client = makeClient({
    recordsByApp: {
      4148: [
        makeRecord({ $id: "1", 顧客No: "C001", 会社名: "A社", 顧客ランク: "A" }),
        makeRecord({ $id: "2", 顧客No: "C002", 会社名: "B社", 顧客ランク: "B" }),
      ],
      4149: [
        makeRecord({ $id: "10", 顧客No_: "C001", 案件No_: "K-10", 案件名: "案件A", 商談フェーズ: "提案中", 売上: "1000" }),
        makeRecord({ $id: "11", 顧客No_: "C002", 案件No_: "K-11", 案件名: "案件B", 商談フェーズ: "失注", 売上: "2000" }),
      ],
    },
  });

  const result = await execute(
    "SELECT a.顧客No AS 顧客No, a.会社名, a.顧客ランク, b.案件No_ AS 案件No, b.案件名, b.商談フェーズ, b.売上 " +
    "FROM APP4148 AS a INNER JOIN APP4149 AS b ON a.顧客No = b.顧客No_ " +
    "WHERE b.商談フェーズ IN ('提案中', '内示', '受注') " +
    "ORDER BY b.案件No_ DESC LIMIT 50",
    client
  ) as SelectResult;

  expect(result.rowCount).toBe(1);

  const mainCall = client.getCalls.find((c) => c.app === 4148);
  expect(mainCall).toBeDefined();
  expect(mainCall?.query).toContain("limit 500 offset 0");
  expect(mainCall?.query).not.toContain("商談フェーズ");
});

test("ワイルドカードなし LIKE も押し下げず JS の部分一致で評価する", async () => {
  const client = makeClient({ records: [
    makeRecord({ 会社名: "東京支店" }),
    makeRecord({ 会社名: "大阪支店" }),
  ] });
  const result = await execute(
    "SELECT 会社名 FROM APP100 WHERE 会社名 LIKE '東京'",
    client
  ) as SelectResult;

  expect(result.rows.map((row) => row["会社名"])).toEqual(["東京支店"]);
  expect(client.getCalls.every((call) => !call.query.toLowerCase().includes("like"))).toBe(true);
});

test("FULL_SCAN: JOIN + ワイルドカード LIKE は押し下げず JS で評価する", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [
        makeRecord({ $id: "1", 顧客ID: "C1", 文字列: "てすと２０" }),
        makeRecord({ $id: "2", 顧客ID: "C2", 文字列: "すと２０" }),
      ],
      101: [
        makeRecord({ $id: "10", 顧客ID: "C1" }),
        makeRecord({ $id: "11", 顧客ID: "C2" }),
      ],
    },
  });

  const result = await execute(
    "SELECT a.文字列 FROM APP100 AS a INNER JOIN APP101 AS b ON a.顧客ID = b.顧客ID " +
    "WHERE a.文字列 LIKE 'すと%'",
    client
  ) as SelectResult;

  expect(result.rows).toEqual([{ 文字列: "すと２０" }]);
  expect(client.getCalls.every((call) => !call.query.toLowerCase().includes("like"))).toBe(true);
});

test("FULL_SCAN: 単一テーブル無エイリアスで $id 条件だけをプレフィルタする", async () => {
  const client = makeClient({ records: [
    makeRecord({ $id: "999", 会社名: "A社" }),
    makeRecord({ $id: "1000", 会社名: "A社" }),
    makeRecord({ $id: "1001", 会社名: "B社" }),
  ] });

  const result = await execute(
    "SELECT $id, 会社名 FROM APP100 WHERE $id >= 1000 AND 会社名 LIKE '%A%'",
    client
  ) as SelectResult;

  expect(result.rows).toEqual([{ $id: "1000", 会社名: "A社" }]);
  expect(client.getCalls[0].query).toContain("$id >= 1000");
  expect(client.getCalls[0].query.toLowerCase()).not.toContain("like");
});

test("FULL_SCAN: 単一テーブルの正しいエイリアス付き $id 条件をプレフィルタする", async () => {
  const client = makeClient({ records: [
    makeRecord({ $id: "999", 会社名: "A社" }),
    makeRecord({ $id: "1000", 会社名: "A社" }),
  ] });

  const result = await execute(
    "SELECT a.$id, a.会社名 FROM APP100 AS a WHERE a.$id >= 1000 AND a.会社名 LIKE '%A%'",
    client
  ) as SelectResult;

  expect(result.rows).toEqual([{ "$id": "1000", "会社名": "A社" }]);
  expect(client.getCalls[0].query).toContain("$id >= 1000");
});

test("FULL_SCAN: 第0段の $id 押し下げは型メタデータを取得しない", async () => {
  const client = makeClient({ records: [makeRecord({ $id: "1000" })] });
  let getFieldsCount = 0;
  client.getFields = async () => {
    getFieldsCount += 1;
    return [];
  };

  await execute(
    "SELECT $id FROM APP100 WHERE $id >= 1000 AND LENGTH($id) >= 1",
    client
  );

  expect(client.getCalls[0].query).toContain("$id >= 1000");
  expect(getFieldsCount).toBe(0);
});

test("FULL_SCAN: NUMBER フィールドの strict 比較を型確認後にプレフィルタする", async () => {
  const client = makeClient({ records: [
    makeRecord({ $id: "1", 金額: "", 会社名: "A空" }),
    makeRecord({ $id: "2", 金額: "-2", 会社名: "A負" }),
    makeRecord({ $id: "3", 金額: "0", 会社名: "A零" }),
    makeRecord({ $id: "4", 金額: "5", 会社名: "B正" }),
  ] });
  let getFieldsCount = 0;
  client.getFields = async () => {
    getFieldsCount += 1;
    return [
      { code: "金額", label: "金額", fieldType: "NUMBER" },
      { code: "会社名", label: "会社名", fieldType: "SINGLE_LINE_TEXT" },
    ];
  };

  const result = await execute(
    "SELECT $id, 金額, 会社名 FROM APP99101 WHERE 金額 > -1 AND 会社名 LIKE '%A%'",
    client
  ) as SelectResult;

  expect(result.rows).toEqual([{ $id: "3", 金額: "0", 会社名: "A零" }]);
  expect(client.getCalls[0].query).toContain("金額 > -1");
  expect(client.getCalls[0].query.toLowerCase()).not.toContain("like");
  expect(getFieldsCount).toBe(1);
});

test("FULL_SCAN: NUMBER 等値は押し下げても JS の文字列表現で再評価する", async () => {
  const client = makeClient({ records: [
    makeRecord({ $id: "1", 金額: "100.0", 会社名: "A社" }),
    makeRecord({ $id: "2", 金額: "100", 会社名: "A社" }),
  ] });
  client.getFields = async () => [
    { code: "金額", label: "金額", fieldType: "NUMBER" },
    { code: "会社名", label: "会社名", fieldType: "SINGLE_LINE_TEXT" },
  ];

  const result = await execute(
    "SELECT $id, 金額 FROM APP99102 WHERE 金額 = 100 AND 会社名 LIKE '%A%'",
    client
  ) as SelectResult;

  expect(client.getCalls[0].query).toContain("金額 = 100");
  expect(result.rows).toEqual([
    { $id: "1", 金額: "100.0" },
    { $id: "2", 金額: "100" },
  ]);
});

test.each([
  ["DROP_DOWN", "A"],
  ["RADIO_BUTTON", "A"],
  ["CHECK_BOX", ["A", "B"]],
  ["MULTI_SELECT", ["A", "B"]],
] as const)("FULL_SCAN: %s の実在 IN を型・選択肢確認後に押し下げる", async (fieldType, value) => {
  const client = makeClient({ records: [
    makeTypedRecord({ $id: "1", 選択: value, 件名: "one" }),
  ] });
  let getFieldsCount = 0;
  client.getFields = async () => {
    getFieldsCount += 1;
    return [
      { code: "選択", label: "選択", fieldType, optionOrder: { A: 0, B: 1 } },
      { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
    ];
  };

  const result = await execute(
    "SELECT $id FROM APP99201 WHERE 選択 IN ('A') AND 件名 LIKE '%'",
    client,
    { cacheContext: `selection-pushdown-${fieldType}` }
  ) as SelectResult;

  expect(result.rows).toEqual([{ $id: "1" }]);
  expect(client.getCalls[0].query).toContain('選択 in ("A")');
  expect(client.getCalls[0].query.toLowerCase()).not.toContain("like");
  expect(getFieldsCount).toBe(1);
});

test("FULL_SCAN: MULTI_SELECT NOT IN を押し下げ、空配列は最終JS評価でも包含する", async () => {
  const client = makeClient({ records: [
    makeTypedRecord({ $id: "1", 選択: [], 件名: "empty" }),
    makeTypedRecord({ $id: "2", 選択: ["A"], 件名: "selected" }),
  ] });
  client.getFields = async () => [
    { code: "選択", label: "選択", fieldType: "MULTI_SELECT", optionOrder: { A: 0 } },
    { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
  ];

  const result = await execute(
    "SELECT $id FROM APP99202 WHERE 選択 NOT IN ('A') AND 件名 LIKE '%'",
    client,
    { cacheContext: "selection-pushdown-not-in" }
  ) as SelectResult;

  expect(client.getCalls[0].query).toContain('選択 not in ("A")');
  expect(result.rows).toEqual([{ $id: "1" }]);
});

test("FULL_SCAN: 選択系の空スカラー・空配列を IN ('') と投影・CASEで一貫して扱う", async () => {
  const client = makeClient({ records: [
    makeTypedRecord({ $id: "1", ドロップダウン: null, 複数選択: [], 件名: "empty" }),
    makeTypedRecord({ $id: "2", ドロップダウン: "A", 複数選択: ["A"], 件名: "set" }),
  ] });
  client.getFields = async () => [
    { code: "ドロップダウン", label: "ドロップダウン", fieldType: "DROP_DOWN", optionOrder: { A: 0 } },
    { code: "複数選択", label: "複数選択", fieldType: "MULTI_SELECT", optionOrder: { A: 0 } },
    { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
  ];

  const result = await execute(
    "SELECT $id, ドロップダウン, " +
      "CASE WHEN 複数選択 IN ('') THEN 'empty' ELSE 'set' END AS 配列状態 " +
      "FROM APP98107 WHERE ドロップダウン IN ('') AND 件名 LIKE '%'",
    client,
    { cacheContext: "selection-empty-scalar-array" }
  ) as SelectResult;

  expect(result.rows).toEqual([{ $id: "1", ドロップダウン: "", 配列状態: "empty" }]);
  expect(client.getCalls[0].query).not.toContain("ドロップダウン in");
});

test("FULL_SCAN: 選択系 NOT IN ('') は非空セルだけを返す", async () => {
  const client = makeClient({ records: [
    makeTypedRecord({ $id: "1", 選択: [], 件名: "empty" }),
    makeTypedRecord({ $id: "2", 選択: ["A"], 件名: "set" }),
  ] });
  client.getFields = async () => [
    { code: "選択", label: "選択", fieldType: "CHECK_BOX", optionOrder: { A: 0 } },
    { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
  ];

  const result = await execute(
    "SELECT $id FROM APP98108 WHERE 選択 NOT IN ('') AND 件名 LIKE '%'",
    client,
    { cacheContext: "selection-empty-not-in" }
  ) as SelectResult;
  expect(result.rows).toEqual([{ $id: "2" }]);
});

test("FULL_SCAN: IN (SELECT ...) の空文字は空配列選択に一致する", async () => {
  const client = makeClient({ recordsByApp: {
    98109: [makeTypedRecord({ $id: "1", 選択: [], 件名: "empty" })],
    98110: [makeRecord({ code: "" })],
  } });
  client.getFields = async (appId) => appId === 98109
    ? [
      { code: "選択", label: "選択", fieldType: "USER_SELECT" },
      { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
    ]
    : [{ code: "code", label: "code", fieldType: "SINGLE_LINE_TEXT" }];

  const result = await execute(
    "SELECT $id FROM APP98109 WHERE 選択 IN (SELECT code FROM APP98110) AND 件名 LIKE '%'",
    client,
    { cacheContext: "selection-empty-subquery" }
  ) as SelectResult;
  expect(result.rows).toEqual([{ $id: "1" }]);
});

test.each(["'X'", "''"])(
  "FULL_SCAN: 非実在または空の選択肢 %s はリーフだけ非押し下げにする",
  async (literal) => {
    const client = makeClient({ records: [
      makeTypedRecord({ $id: "10", 選択: literal === "'X'" ? "X" : "", 件名: "one" }),
    ] });
    client.getFields = async () => [
      { code: "選択", label: "選択", fieldType: "DROP_DOWN", optionOrder: { A: 0 } },
      { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
    ];

    await execute(
      `SELECT $id FROM APP99203 WHERE $id >= 1 AND 選択 IN (${literal}) AND 件名 LIKE '%'`,
      client,
      { cacheContext: `selection-pushdown-invalid-${literal}` }
    );

    expect(client.getCalls[0].query).toContain("$id >= 1");
    expect(client.getCalls[0].query).not.toContain("選択 in");
  }
);

test.each(["USER_SELECT", "STATUS_ASSIGNEE"])(
  "FULL_SCAN: %s の IN は押し下げず最終JS評価に残す",
  async (fieldType) => {
    const value = [{ code: "A", name: "Alice" }];
    const client = makeClient({ records: [makeTypedRecord({ $id: "1", 選択: value, 件名: "one" })] });
    client.getFields = async () => [
      { code: "選択", label: "選択", fieldType, optionOrder: { A: 0 } },
      { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
    ];

    const result = await execute(
      "SELECT $id FROM APP99204 WHERE 選択 IN ('A') AND 件名 LIKE '%'",
      client,
      { cacheContext: `selection-pushdown-excluded-${fieldType}` }
    ) as SelectResult;

    expect(client.getCalls[0].query).not.toContain("選択 in");
    expect(result.rows).toEqual([{ $id: "1" }]);
  }
);

test.each(["IN", "NOT IN"])(
  "FULL_SCAN: 有効な STATUS の実在値を %s で押し下げる",
  async (op) => {
    const client = makeClient({ records: [
      makeTypedRecord({ $id: "1", ステータス: "処理中", 件名: "one" }),
      makeTypedRecord({ $id: "2", ステータス: "完了", 件名: "two" }),
    ] });
    client.getFields = async () => [
      { code: "ステータス", label: "ステータス", fieldType: "STATUS" },
      { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
    ];
    let statusCalls = 0;
    client.getProcessStatuses = async () => {
      statusCalls += 1;
      return { enable: true, states: [{ name: "処理中", index: 0 }, { name: "完了", index: 1 }] };
    };

    const result = await execute(
      `SELECT $id FROM APP99301 WHERE ステータス ${op} ('処理中') AND 件名 LIKE '%'`,
      client,
      { cacheContext: `status-pushdown-${op}` }
    ) as SelectResult;

    expect(client.getCalls[0].query).toContain(`ステータス ${op === "IN" ? "in" : "not in"} ("処理中")`);
    expect(result.rows).toEqual(op === "IN" ? [{ $id: "1" }] : [{ $id: "2" }]);
    expect(statusCalls).toBe(1);
    expect(result.metrics?.processStatusCalls).toBe(1);
  }
);

test.each([
  ["非実在", true, ["処理中"]],
  ["処理中", false, ["処理中"]],
  ["処理中", true, []],
] as const)(
  "FULL_SCAN: STATUS値=%s enable=%s states=%j は非押し下げ",
  async (value, enable, states) => {
    const client = makeClient({ records: [
      makeTypedRecord({ $id: "10", ステータス: value, 件名: "one" }),
    ] });
    client.getFields = async () => [
      { code: "ステータス", label: "ステータス", fieldType: "STATUS" },
      { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
    ];
    client.getProcessStatuses = async () => ({
      enable,
      states: states.map((name, index) => ({ name, index })),
    });

    const result = await execute(
      `SELECT $id FROM APP99302 WHERE $id >= 1 AND ステータス IN ('${value}') AND 件名 LIKE '%'`,
      client,
      { cacheContext: `status-pushdown-disabled-${value}-${enable}-${states.length}` }
    ) as SelectResult;

    expect(client.getCalls[0].query).toContain("$id >= 1");
    expect(client.getCalls[0].query).not.toContain("ステータス in");
    expect(result.rows).toEqual([{ $id: "10" }]);
  }
);

test("FULL_SCAN: NUMBER / DROP_DOWN候補だけなら status.json を呼ばない", async () => {
  const client = makeClient({ records: [
    makeTypedRecord({ $id: "1", 金額: "2", 区分: "A", 件名: "one" }),
  ] });
  client.getFields = async () => [
    { code: "金額", label: "金額", fieldType: "NUMBER" },
    { code: "区分", label: "区分", fieldType: "DROP_DOWN", optionOrder: { A: 0 } },
    { code: "ステータス", label: "ステータス", fieldType: "STATUS" },
    { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
  ];
  let statusCalls = 0;
  client.getProcessStatuses = async () => {
    statusCalls += 1;
    return { enable: true, states: [{ name: "処理中", index: 0 }] };
  };

  await execute(
    "SELECT $id FROM APP99303 WHERE 金額 > 1 AND 区分 IN ('A') AND 件名 LIKE '%'",
    client,
    { cacheContext: "status-candidate-two-stage" }
  );
  expect(statusCalls).toBe(0);

  await execute(
    "SELECT $id FROM APP99303 WHERE ステータス IN ('') AND 件名 LIKE '%'",
    client,
    { cacheContext: "status-empty-not-candidate" }
  );
  expect(statusCalls).toBe(0);
});

test("ORDER BY の実キーが STATUS のときだけ定義順 metadata を取得する", async () => {
  const client = makeClient({ records: [
    makeTypedRecord({ $id: "1", ステータス: "未処理", 件名: "one" }),
    makeTypedRecord({ $id: "2", ステータス: "完了", 件名: "two" }),
  ] });
  client.getFields = async () => [
    { code: "ステータス", label: "ステータス", fieldType: "STATUS" },
    { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
  ];
  let statusCalls = 0;
  client.getProcessStatuses = async () => {
    statusCalls += 1;
    return {
      enable: true,
      states: [{ name: "未処理", index: 0 }, { name: "完了", index: 1 }],
    };
  };

  await execute(
    "SELECT ステータス AS s FROM APP99308 ORDER BY s ASC",
    client,
    { cacheContext: "status-order-meta" }
  );
  expect(statusCalls).toBe(1);

  const statusOrdered = await execute(
    "SELECT ステータス FROM APP99308 ORDER BY ステータス ASC",
    client,
    { cacheContext: "status-order-meta-result-boundary" }
  ) as SelectResult;
  expect(statusCalls).toBe(2);
  expect(statusOrdered.rows).toEqual([{ ステータス: "未処理" }, { ステータス: "完了" }]);

  await execute(
    "SELECT $id FROM APP99308 ORDER BY 件名 ASC",
    client,
    { cacheContext: "text-order-no-status-meta" }
  );
  await execute(
    "SELECT $id FROM APP99308",
    client,
    { cacheContext: "no-order-no-status-meta" }
  );
  expect(statusCalls).toBe(2);
});

test("STATUS の範囲比較は定義順 metadata を使う", async () => {
  const client = makeClient({ records: [
    makeTypedRecord({ $id: "1", ステータス: "未処理", 件名: "one" }),
    makeTypedRecord({ $id: "2", ステータス: "完了", 件名: "two" }),
  ] });
  client.getFields = async () => [
    { code: "ステータス", label: "ステータス", fieldType: "STATUS" },
    { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
  ];
  let statusCalls = 0;
  client.getProcessStatuses = async () => {
    statusCalls += 1;
    return {
      enable: true,
      states: [{ name: "未処理", index: 0 }, { name: "完了", index: 1 }],
    };
  };

  const ranged = await execute(
    "SELECT $id FROM APP99308 WHERE ステータス > '未処理' AND 件名 LIKE '%'",
    client,
    { cacheContext: "status-range-meta" }
  ) as SelectResult;
  expect(ranged.rows).toEqual([{ $id: "2" }]);
  expect(statusCalls).toBe(1);
});

test("CTE を越えて STATUS の物理列来歴を ORDER BY metadata へ伝播する", async () => {
  const client = makeClient({ records: [
    makeTypedRecord({ $id: "1", ステータス: "未処理" }),
    makeTypedRecord({ $id: "2", ステータス: "完了" }),
  ] });
  client.getFields = async () => [
    { code: "ステータス", label: "ステータス", fieldType: "STATUS" },
  ];
  let statusCalls = 0;
  client.getProcessStatuses = async () => {
    statusCalls += 1;
    return {
      enable: true,
      states: [{ name: "未処理", index: 0 }, { name: "完了", index: 1 }],
    };
  };

  const result = await execute(
    "WITH x AS (SELECT ステータス FROM APP99309) SELECT ステータス FROM x ORDER BY ステータス ASC",
    client,
    { cacheContext: "status-order-cte-lineage" }
  ) as SelectResult;

  expect(result.rowCount).toBe(2);
  expect(statusCalls).toBe(1);
});

test("FULL_SCAN: status.json の reject をレコード取得前に伝播する", async () => {
  const client = makeClient();
  client.getFields = async () => [
    { code: "ステータス", label: "ステータス", fieldType: "STATUS" },
    { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
  ];
  client.getProcessStatuses = async () => {
    throw new Error("status metadata failed");
  };

  await expect(execute(
    "SELECT $id FROM APP99304 WHERE ステータス IN ('処理中') AND 件名 LIKE '%'",
    client,
    { cacheContext: "status-pushdown-reject" }
  )).rejects.toThrow("status metadata failed");
  expect(client.getCalls).toHaveLength(0);
});

test("FULL_SCAN: status.json は同一APP/profileの同時実行でも1回だけ取得する", async () => {
  const client = makeClient({ records: [
    makeTypedRecord({ $id: "1", ステータス: "処理中", 件名: "one" }),
  ] });
  client.getFields = async () => [
    { code: "ステータス", label: "ステータス", fieldType: "STATUS" },
    { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
  ];
  let statusCalls = 0;
  client.getProcessStatuses = async () => {
    statusCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { enable: true, states: [{ name: "処理中", index: 0 }] };
  };
  const sql = "SELECT $id FROM APP99305 WHERE ステータス IN ('処理中') AND 件名 LIKE '%'";

  await Promise.all([
    execute(sql, client, { cacheContext: "status-cache-profile-a" }),
    execute(sql, client, { cacheContext: "status-cache-profile-a" }),
  ]);
  expect(statusCalls).toBe(1);
});

test("FULL_SCAN JOIN: STATUS候補のある側だけ status.json を取得して押し下げる", async () => {
  const client = makeClient({ recordsByApp: {
    99306: [makeTypedRecord({ $id: "1", 顧客ID: "C1", ステータス: "処理中" })],
    99307: [makeTypedRecord({ $id: "2", 顧客ID: "C1", 区分: "A" })],
  } });
  client.getFields = async (appId) => appId === 99306
    ? [
      { code: "顧客ID", label: "顧客ID", fieldType: "SINGLE_LINE_TEXT" },
      { code: "ステータス", label: "ステータス", fieldType: "STATUS" },
    ]
    : [
      { code: "顧客ID", label: "顧客ID", fieldType: "SINGLE_LINE_TEXT" },
      { code: "区分", label: "区分", fieldType: "DROP_DOWN", optionOrder: { A: 0 } },
    ];
  const statusApps: number[] = [];
  client.getProcessStatuses = async (appId) => {
    statusApps.push(appId);
    return { enable: true, states: [{ name: "処理中", index: 0 }] };
  };

  const result = await execute(
    "SELECT a.$id FROM APP99306 a JOIN APP99307 b ON a.顧客ID = b.顧客ID " +
      "WHERE a.ステータス IN ('処理中') AND b.区分 IN ('A')",
    client,
    { cacheContext: "status-pushdown-join" }
  ) as SelectResult;

  expect(result.rowCount).toBe(1);
  expect(statusApps).toEqual([99306]);
  expect(client.getCalls.find((call) => call.app === 99306)?.query).toContain('ステータス in ("処理中")');
  expect(client.getCalls.find((call) => call.app === 99307)?.query).toContain('区分 in ("A")');
});

test("FULL_SCAN: 選択系候補の型メタ取得失敗をレコード取得前に伝播する", async () => {
  const client = makeClient();
  client.getFields = async () => {
    throw new Error("selection metadata failed");
  };

  await expect(execute(
    "SELECT $id FROM APP99205 WHERE 選択 IN ('A') AND 件名 LIKE '%'",
    client,
    { cacheContext: "selection-pushdown-reject" }
  )).rejects.toThrow("selection metadata failed");
  expect(client.getCalls).toHaveLength(0);
});

test("FULL_SCAN JOIN: 各アプリの実在選択系 IN を別々に押し下げる", async () => {
  const client = makeClient({ recordsByApp: {
    99206: [makeTypedRecord({ $id: "1", 顧客ID: "C1", 選択A: "A", 件名: "one" })],
    99207: [makeTypedRecord({ $id: "2", 顧客ID: "C1", 選択B: ["B"] })],
  } });
  const getFieldsCount = new Map<number, number>();
  client.getFields = async (appId) => {
    getFieldsCount.set(appId, (getFieldsCount.get(appId) ?? 0) + 1);
    return appId === 99206
      ? [
        { code: "顧客ID", label: "顧客ID", fieldType: "SINGLE_LINE_TEXT" },
        { code: "選択A", label: "選択A", fieldType: "DROP_DOWN", optionOrder: { A: 0 } },
        { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
      ]
      : [
        { code: "顧客ID", label: "顧客ID", fieldType: "SINGLE_LINE_TEXT" },
        { code: "選択B", label: "選択B", fieldType: "CHECK_BOX", optionOrder: { B: 0 } },
      ];
  };

  const result = await execute(
    "SELECT a.$id FROM APP99206 a JOIN APP99207 b ON a.顧客ID = b.顧客ID " +
      "WHERE a.選択A IN ('A') AND b.選択B IN ('B') AND a.件名 LIKE '%'",
    client,
    { cacheContext: "selection-pushdown-join" }
  ) as SelectResult;

  expect(result.rowCount).toBe(1);
  expect(client.getCalls.find((call) => call.app === 99206)?.query).toContain('選択A in ("A")');
  expect(client.getCalls.find((call) => call.app === 99207)?.query).toContain('選択B in ("B")');
  expect(getFieldsCount).toEqual(new Map([[99206, 1], [99207, 1]]));
});

test.each([">=", "<="])(
  "FULL_SCAN: 一般 NUMBER の %s は型が確定しても押し下げない",
  async (op) => {
    const client = makeClient({ records: [makeRecord({ $id: "1", 金額: "1", 会社名: "A社" })] });
    client.getFields = async () => [
      { code: "金額", label: "金額", fieldType: "NUMBER" },
      { code: "会社名", label: "会社名", fieldType: "SINGLE_LINE_TEXT" },
    ];

    await execute(
      `SELECT $id, 金額 FROM APP99103 WHERE 金額 ${op} 1 AND 会社名 LIKE '%A%'`,
      client,
      { cacheContext: `numeric-inclusive-${op}` }
    );

    expect(client.getCalls[0].query).not.toContain(`金額 ${op} 1`);
  }
);

test("FULL_SCAN: 数値候補の型が NUMBER でなければ押し下げない", async () => {
  const client = makeClient({ records: [makeRecord({ $id: "1", 金額: "2", 会社名: "A社" })] });
  client.getFields = async () => [
    { code: "金額", label: "金額", fieldType: "SINGLE_LINE_TEXT" },
    { code: "会社名", label: "会社名", fieldType: "SINGLE_LINE_TEXT" },
  ];

  await execute(
    "SELECT $id FROM APP99104 WHERE 金額 > 1 AND 会社名 LIKE '%A%'",
    client
  );

  expect(client.getCalls[0].query).not.toContain("金額 > 1");
});

test("FULL_SCAN: 数値候補の型メタ取得失敗を伝播する", async () => {
  const client = makeClient();
  client.getFields = async () => {
    throw new Error("getFields failed");
  };

  await expect(execute(
    "SELECT $id FROM APP99105 WHERE 金額 > 1 AND 会社名 LIKE '%A%'",
    client
  )).rejects.toThrow("getFields failed");
  expect(client.getCalls).toHaveLength(0);
});

test("FULL_SCAN: JOIN は各アプリの NUMBER 候補だけをプレフィルタする", async () => {
  const client = makeClient({
    recordsByApp: {
      99106: [makeRecord({ $id: "1", 顧客ID: "C1", 金額: "2", 会社名: "A社" })],
      99107: [makeRecord({ $id: "10", 顧客ID: "C1", 数量: "3" })],
    },
  });
  client.getFields = async (appId) => appId === 99106
    ? [
      { code: "顧客ID", label: "顧客ID", fieldType: "SINGLE_LINE_TEXT" },
      { code: "金額", label: "金額", fieldType: "NUMBER" },
      { code: "会社名", label: "会社名", fieldType: "SINGLE_LINE_TEXT" },
    ]
    : [
      { code: "顧客ID", label: "顧客ID", fieldType: "SINGLE_LINE_TEXT" },
      { code: "数量", label: "数量", fieldType: "NUMBER" },
    ];

  const result = await execute(
    "SELECT a.$id FROM APP99106 AS a INNER JOIN APP99107 AS b ON a.顧客ID = b.顧客ID " +
    "WHERE a.金額 > 1 AND b.数量 = 3 AND a.会社名 LIKE '%A%'",
    client
  ) as SelectResult;

  expect(result.rowCount).toBe(1);
  expect(client.getCalls.find((call) => call.app === 99106)?.query).toContain("金額 > 1");
  expect(client.getCalls.find((call) => call.app === 99107)?.query).toContain("数量 = 3");
});

test("FULL_SCAN: JOIN の $id 条件は維持し、テキスト等値は押し下げない", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [makeRecord({ $id: "1", 顧客ID: "C1", 文字列: "A社" })],
      101: [makeRecord({ $id: "10", 顧客ID: "C1", 状態: "完了" })],
    },
  });

  await execute(
    "SELECT a.$id FROM APP100 AS a INNER JOIN APP101 AS b ON a.顧客ID = b.顧客ID " +
    "WHERE b.$id >= 10 AND b.状態 = '完了' AND a.文字列 LIKE '%A%'",
    client
  );

  const joinCall = client.getCalls.find((call) => call.app === 101);
  expect(joinCall?.query).toContain("$id >= 10");
  expect(joinCall?.query).not.toContain("状態");
});

test("FULL_SCAN: サブテーブルは $id / サブテーブル本体 / _p.参照親項目のみ取得", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [
        {
          $id: { value: "1" },
          案件名: { value: "案件A" },
          明細: {
            value: [
              { id: "r1", value: { 商品コード: { value: "A-001" }, 数量: { value: "2" } } },
            ],
          },
        } as unknown as KintoneRecord,
      ],
    },
  });

  await execute(
    "SELECT _p.案件名, 商品コード, _rid FROM APP100$明細",
    client
  );

  expect(client.getCalls.length).toBeGreaterThan(0);
  const fields = new Set(client.getCalls[0].fields);
  expect(fields.has("$id")).toBe(true);
  expect(fields.has("明細")).toBe(true);
  expect(fields.has("案件名")).toBe(true);
  expect(fields.has("商品コード")).toBe(false);
});

test("SELECT サブテーブル仮想テーブル + _p.項目", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [
        {
          $id: { value: "1" },
          案件名: { value: "案件A" },
          明細: {
            value: [
              { id: "r1", value: { 商品コード: { value: "A-001" }, 数量: { value: "2" } } },
              { id: "r2", value: { 商品コード: { value: "A-002" }, 数量: { value: "5" } } },
            ],
          },
        } as unknown as KintoneRecord,
      ],
    },
    fieldTypes: { 案件名: "SINGLE_LINE_TEXT", 商品コード: "SINGLE_LINE_TEXT", 数量: "NUMBER" },
  });

  const result = await execute(
    "SELECT _p.案件名, 商品コード, _rid FROM APP100$明細 ORDER BY 商品コード ASC",
    client
  ) as SelectResult;

  expect(result.rowCount).toBe(2);
  expect(result.rows[0]).toEqual({ "_p.案件名": "案件A", 商品コード: "A-001", _rid: "r1" });
  expect(result.rows[1]).toEqual({ "_p.案件名": "案件A", 商品コード: "A-002", _rid: "r2" });
});

test("SELECT _p.* 親項目一括展開", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [
        {
          $id: { value: "1" },
          案件名: { value: "案件A" },
          顧客コード: { value: "C-001" },
          明細: {
            value: [
              { id: "r1", value: { 商品コード: { value: "A-001" } } },
            ],
          },
        } as unknown as KintoneRecord,
      ],
    },
  });

  const result = await execute(
    "SELECT _p.*, 商品コード FROM APP100$明細",
    client
  ) as SelectResult;

  expect(result.rowCount).toBe(1);
  expect(result.rows[0]["_p.案件名"]).toBe("案件A");
  expect(result.rows[0]["_p.顧客コード"]).toBe("C-001");
  expect(result.rows[0]["商品コード"]).toBe("A-001");
});

test("SELECT * は _p.* を暗黙表示しない", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [
        {
          $id: { value: "1" },
          案件名: { value: "案件A" },
          明細: {
            value: [
              { id: "r1", value: { 商品コード: { value: "A-001" } } },
            ],
          },
        } as unknown as KintoneRecord,
      ],
    },
  });

  const result = await execute(
    "SELECT * FROM APP100$明細",
    client
  ) as SelectResult;

  expect(result.rowCount).toBe(1);
  expect(result.rows[0]["_rid"]).toBe("r1");
  expect(result.rows[0]["商品コード"]).toBe("A-001");
  expect(result.rows[0]["_p.案件名"]).toBeUndefined();
});

// ----------------------------------------------------------------
// INSERT
// ----------------------------------------------------------------

test("INSERT 単一行 → POST 1回", async () => {
  const client = makeClient({ postIds: ["101"], fieldTypes: { 名前: "SINGLE_LINE_TEXT", 金額: "NUMBER" } });
  const result = await execute(
    "INSERT INTO APP100 (名前, 金額) VALUES ('田中', 1000)",
    client
  ) as InsertResult;

  expect(result.type).toBe("INSERT");
  expect(result.insertedCount).toBe(1);
  expect(client.postCalls).toHaveLength(1);
  expect(client.postCalls[0].records[0]).toEqual({
    名前: { value: "田中" },
    金額: { value: "1000" },
  });
});

test("INSERT 101行 → POST 2回（バッチ分割）", async () => {
  const rows = Array.from({ length: 101 }, (_, i) => `('名前${i}')`).join(", ");
  const client = makeClient({ postIds: [], fieldTypes: { 名前: "SINGLE_LINE_TEXT" } });
  await execute(`INSERT INTO APP100 (名前) VALUES ${rows}`, client);

  expect(client.postCalls).toHaveLength(2);
  expect(client.postCalls[0].records).toHaveLength(100);
  expect(client.postCalls[1].records).toHaveLength(1);
});

test("INSERT サブテーブル行 → 親レコードに PUT", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [
        {
          $id: { value: "1" },
          $revision: { value: "3" },
          明細: { value: [{ id: "r1", value: { 商品コード: { value: "A-001" } } }] },
        } as unknown as KintoneRecord,
      ],
    },
  });

  const result = await execute(
    "INSERT INTO APP100$明細 (_pid, 商品コード, 数量) VALUES (1, 'A-002', 2)",
    client
  ) as InsertResult;

  expect(result.type).toBe("INSERT");
  expect(result.insertedCount).toBe(1);
  expect(client.putCalls).toHaveLength(1);
  const table = client.putCalls[0].records[0].record["明細"].value as unknown as Array<{ value: Record<string, { value: string }> }>;
  expect(table).toHaveLength(2);
  expect(table[1].value["商品コード"].value).toBe("A-002");
  expect(table[1].value["数量"].value).toBe("2");
});

// ----------------------------------------------------------------
// UPDATE
// ----------------------------------------------------------------

test("UPDATE → GET して PUT", async () => {
  const records = [
    makeRecord({ $id: "1", ステータス: "未完了" }),
    makeRecord({ $id: "2", ステータス: "未完了" }),
  ];
  const client = makeClient({ records });
  const result = await execute(
    "UPDATE APP100 SET ステータス = '完了' WHERE ステータス = '未完了'",
    client
  ) as UpdateResult;

  expect(result.type).toBe("UPDATE");
  expect(result.updatedCount).toBe(2);
  expect(client.putCalls).toHaveLength(1);
  expect(client.putCalls[0].records).toHaveLength(2);
  expect(client.putCalls[0].records[0].record).toEqual({
    ステータス: { value: "完了" },
  });
});

test("UPDATE → 確認コールバックで OK", async () => {
  const records = [makeRecord({ $id: "1", f: "old" })];
  const client = makeClient({ records });
  let confirmed = false;

  await execute(
    "UPDATE APP100 SET f = 'v' WHERE f = 'old'",
    client,
    {
      confirm: async (count, op) => {
        confirmed = true;
        expect(count).toBe(1);
        expect(op).toBe("UPDATE");
        return true;
      },
    }
  );

  expect(confirmed).toBe(true);
  expect(client.putCalls).toHaveLength(1);
});

test("UPDATE → 確認コールバックでキャンセル", async () => {
  const client = makeClient({ records: [makeRecord({ $id: "1", f: "old" })] });
  await expect(
    execute("UPDATE APP100 SET f = 'v' WHERE f = 'old'", client, {
      confirm: async () => false,
    })
  ).rejects.toThrow(OperationCancelledError);
  expect(client.putCalls).toHaveLength(0);
});

test("UPDATE 算術式: 現在値を取得して計算結果で PUT", async () => {
  const records = [
    makeRecord({ $id: "1", 金額: "1000", ステータス: "対象" }),
    makeRecord({ $id: "2", 金額: "2000", ステータス: "対象" }),
  ];
  const client = makeClient({ records });
  const result = await execute(
    "UPDATE APP100 SET 金額 = 金額 * 2 WHERE ステータス = '対象'",
    client
  ) as UpdateResult;

  expect(result.updatedCount).toBe(2);
  expect(client.putCalls).toHaveLength(1);
  expect(client.putCalls[0].records[0]).toEqual({ id: 1, record: { 金額: { value: "2000" } } });
  expect(client.putCalls[0].records[1]).toEqual({ id: 2, record: { 金額: { value: "4000" } } });
});

test("UPDATE 算術式: 確認コールバックが件数を受け取る", async () => {
  const records = [
    makeRecord({ $id: "10", 金額: "500", ステータス: "対象" }),
    makeRecord({ $id: "11", 金額: "800", ステータス: "対象" }),
    makeRecord({ $id: "12", 金額: "300", ステータス: "対象" }),
  ];
  const client = makeClient({ records });
  let confirmedCount = 0;

  await execute(
    "UPDATE APP100 SET 金額 = 金額 + 100 WHERE ステータス = '対象'",
    client,
    {
      confirm: async (count, op) => {
        confirmedCount = count;
        expect(op).toBe("UPDATE");
        return true;
      },
    }
  );

  expect(confirmedCount).toBe(3);
  expect(client.putCalls[0].records[0].record["金額"].value).toBe("600");
});

test("UPDATE 算術式: 確認コールバックでキャンセル", async () => {
  const records = [makeRecord({ $id: "1", 金額: "100", f: "v" })];
  const client = makeClient({ records });
  await expect(
    execute("UPDATE APP100 SET 金額 = 金額 * 10 WHERE f = 'v'", client, {
      confirm: async () => false,
    })
  ).rejects.toThrow(OperationCancelledError);
  expect(client.putCalls).toHaveLength(0);
});

test("UPDATE 算術式と通常代入の混在", async () => {
  const records = [makeRecord({ $id: "5", 金額: "1000" })];
  const client = makeClient({ records, fieldTypes: { 備考: "SINGLE_LINE_TEXT" } });
  await execute(
    "UPDATE APP100 SET 金額 = 金額 * 1.1, 備考 = '値上げ後' WHERE $id = 5",
    client
  );

  expect(client.putCalls[0].records[0].record).toEqual({
    金額: { value: "1100" },
    備考: { value: "値上げ後" },
  });
});

test("UPDATE FROM APP: ソース値・リテラル・ターゲット算術を行ごとに PUT", async () => {
  const client = makeClient({
    recordsByApp: {
      200: [
        makeRecord({ k: "1", src: "A" }),
        makeRecord({ k: "2", src: "B" }),
      ],
      100: [
        makeRecord({ $id: "1", amount: "10" }),
        makeRecord({ $id: "2", amount: "20" }),
      ],
    },
  });
  client.getFields = async (appId) => appId === 200
    ? [{ code: "k", label: "k", fieldType: "NUMBER" }, { code: "src", label: "src", fieldType: "SINGLE_LINE_TEXT" }]
    : [{ code: "dest", label: "dest", fieldType: "SINGLE_LINE_TEXT" }, { code: "amount", label: "amount", fieldType: "NUMBER" }, { code: "status", label: "status", fieldType: "SINGLE_LINE_TEXT" }];

  const result = await execute(
    "UPDATE APP100 SET dest = s.src, status = 'done', amount = amount * 2 FROM APP200 s WHERE APP100.$id = s.k",
    client,
    { cacheContext: "update-from-basic" }
  ) as UpdateResult;

  expect(result.updatedCount).toBe(2);
  expect(client.putCalls).toHaveLength(1);
  expect(client.putCalls[0].records).toEqual([
    { id: 1, record: { dest: { value: "A" }, status: { value: "done" }, amount: { value: "20" } } },
    { id: 2, record: { dest: { value: "B" }, status: { value: "done" }, amount: { value: "40" } } },
  ]);
});

test("UPDATE FROM APP: 正規化後の重複キーは全 PUT 前に拒否", async () => {
  const client = makeClient({ recordsByApp: { 200: [makeRecord({ k: "1", src: "A" }), makeRecord({ k: " 1 ", src: "B" })] } });
  client.getFields = async () => [
    { code: "k", label: "k", fieldType: "NUMBER" },
    { code: "src", label: "src", fieldType: "SINGLE_LINE_TEXT" },
    { code: "dest", label: "dest", fieldType: "SINGLE_LINE_TEXT" },
  ];
  await expect(execute(
    "UPDATE APP100 SET dest = s.src FROM APP200 s WHERE APP100.$id = s.k",
    client,
    { cacheContext: "update-from-duplicate" }
  )).rejects.toThrow(/multiple rows/);
  expect(client.putCalls).toHaveLength(0);
  expect(client.getCalls.filter((c) => c.app === 100)).toHaveLength(0);
});

test.each(["", "abc", "0", "-1", "1.5", "9007199254740992"])(
  "UPDATE FROM APP: 不正なソースキー %p は PUT 前に拒否",
  async (key) => {
    const client = makeClient({ recordsByApp: { 200: [makeRecord({ k: key, src: "A" })] } });
    client.getFields = async () => [
      { code: "k", label: "k", fieldType: "NUMBER" },
      { code: "src", label: "src", fieldType: "SINGLE_LINE_TEXT" },
      { code: "dest", label: "dest", fieldType: "SINGLE_LINE_TEXT" },
    ];
    await expect(execute(
      "UPDATE APP100 SET dest = s.src FROM APP200 s WHERE APP100.$id = s.k",
      client,
      { cacheContext: `update-from-invalid-${key}` }
    )).rejects.toThrow(/positive safe integer/);
    expect(client.putCalls).toHaveLength(0);
  }
);

test("UPDATE FROM APP: ソース0件は no-op", async () => {
  const client = makeClient({ recordsByApp: { 200: [] } });
  client.getFields = async () => [
    { code: "k", label: "k", fieldType: "NUMBER" },
    { code: "src", label: "src", fieldType: "SINGLE_LINE_TEXT" },
    { code: "dest", label: "dest", fieldType: "SINGLE_LINE_TEXT" },
  ];
  const result = await execute(
    "UPDATE APP100 SET dest = s.src FROM APP200 s WHERE APP100.$id = s.k",
    client,
    { cacheContext: "update-from-empty" }
  ) as UpdateResult;
  expect(result.updatedCount).toBe(0);
  expect(client.putCalls).toHaveLength(0);
});

test("UPDATE FROM APP: 複合型ソース列を PUT 前に拒否", async () => {
  const client = makeClient({ recordsByApp: { 200: [makeTypedRecord({ k: "1", src: ["A"] })] } });
  client.getFields = async (appId) => appId === 200
    ? [{ code: "k", label: "k", fieldType: "NUMBER" }, { code: "src", label: "src", fieldType: "CHECK_BOX" }]
    : [{ code: "dest", label: "dest", fieldType: "SINGLE_LINE_TEXT" }];
  await expect(execute(
    "UPDATE APP100 SET dest = s.src FROM APP200 s WHERE APP100.$id = s.k",
    client,
    { cacheContext: "update-from-complex" }
  )).rejects.toThrow(/does not support source field type CHECK_BOX/);
  expect(client.putCalls).toHaveLength(0);
});

test("UPDATE FROM APP: ソースが maxRecords を超えると truncate 指定でも fail-closed", async () => {
  const client = makeClient({ recordsByApp: {
    200: [makeRecord({ k: "1", src: "A" }), makeRecord({ k: "2", src: "B" }), makeRecord({ k: "3", src: "C" })],
  } });
  client.getFields = async () => [
    { code: "k", label: "k", fieldType: "NUMBER" },
    { code: "src", label: "src", fieldType: "SINGLE_LINE_TEXT" },
    { code: "dest", label: "dest", fieldType: "SINGLE_LINE_TEXT" },
  ];
  await expect(execute(
    "UPDATE APP100 SET dest = s.src FROM APP200 s WHERE APP100.$id = s.k",
    client,
    { maxRecords: 2, onLimitReached: "truncate", cacheContext: "update-from-max-records" }
  )).rejects.toThrow(/上限/);
  expect(client.putCalls).toHaveLength(0);
});

test("UPDATE FROM APP: 130 IDs は50件ずつ3クエリで対象取得する", async () => {
  const source = Array.from({ length: 130 }, (_, i) => makeRecord({ k: String(i + 1), src: `v${i + 1}` }));
  const target = Array.from({ length: 130 }, (_, i) => makeRecord({ $id: String(i + 1) }));
  const client = makeClient();
  client.getFields = async (appId) => appId === 200
    ? [{ code: "k", label: "k", fieldType: "NUMBER" }, { code: "src", label: "src", fieldType: "SINGLE_LINE_TEXT" }]
    : [{ code: "dest", label: "dest", fieldType: "SINGLE_LINE_TEXT" }];
  client.getRecords = async (params) => {
    client.getCalls.push({ app: params.app, query: params.query ?? "", fields: [...(params.fields ?? [])] });
    if (params.app === 200) return { records: source };
    const ids = [...(params.query ?? "").matchAll(/\"(\d+)\"/g)].map((m) => Number(m[1]));
    return { records: target.filter((r) => ids.includes(Number(r.$id.value))) };
  };
  const result = await execute(
    "UPDATE APP100 SET dest = s.src FROM APP200 s WHERE APP100.$id = s.k",
    client,
    { maxRecords: 500, cacheContext: "update-from-chunks" }
  ) as UpdateResult;
  expect(result.updatedCount).toBe(130);
  expect(client.getCalls.filter((c) => c.app === 100)).toHaveLength(3);
  expect(client.putCalls.flatMap((c) => c.records)).toHaveLength(130);
});

test("UPDATE FROM APP: 文字列業務キーでtarget重複を全件更新しconfirmへ実件数を渡す", async () => {
  const client = makeClient({ recordsByApp: {
    200: [makeRecord({ code: "C001", src: "updated" })],
    100: [
      makeRecord({ $id: "1", 顧客コード: "C001" }),
      makeRecord({ $id: "2", 顧客コード: "C001" }),
    ],
  } });
  client.getFields = async (appId) => appId === 200
    ? [{ code: "code", label: "code", fieldType: "SINGLE_LINE_TEXT" }, { code: "src", label: "src", fieldType: "SINGLE_LINE_TEXT" }]
    : [{ code: "顧客コード", label: "顧客コード", fieldType: "SINGLE_LINE_TEXT" }, { code: "dest", label: "dest", fieldType: "SINGLE_LINE_TEXT" }];
  const confirms: number[] = [];
  const result = await execute(
    "UPDATE APP100 SET dest = s.src FROM APP200 s WHERE APP100.顧客コード = s.code",
    client,
    { cacheContext: "update-from-business-duplicate-target", confirm: async (count) => { confirms.push(count); return true; } }
  ) as UpdateResult;

  expect(result.updatedCount).toBe(2);
  expect(confirms).toEqual([2]);
  expect(client.putCalls.flatMap((call) => call.records).map((record) => record.id)).toEqual([1, 2]);
  expect(client.getCalls.find((call) => call.app === 100)?.fields).toContain("顧客コード");
});

test("UPDATE FROM APP: 65文字キーの先頭64文字だけ一致する過剰取得行を更新しない", async () => {
  const prefix = "A".repeat(64);
  const exact = `${prefix}X`;
  const overFetched = `${prefix}Y`;
  const client = makeClient({ recordsByApp: {
    200: [makeRecord({ code: exact, src: "updated" })],
    100: [
      makeRecord({ $id: "1", 顧客コード: exact }),
      makeRecord({ $id: "2", 顧客コード: overFetched }),
    ],
  } });
  client.getFields = async (appId) => appId === 200
    ? [{ code: "code", label: "code", fieldType: "SINGLE_LINE_TEXT" }, { code: "src", label: "src", fieldType: "SINGLE_LINE_TEXT" }]
    : [{ code: "顧客コード", label: "顧客コード", fieldType: "SINGLE_LINE_TEXT" }, { code: "dest", label: "dest", fieldType: "SINGLE_LINE_TEXT" }];

  const result = await execute(
    "UPDATE APP100 SET dest = s.src FROM APP200 s WHERE 顧客コード = s.code",
    client,
    { cacheContext: "update-from-65-char" }
  ) as UpdateResult;

  expect(result.updatedCount).toBe(1);
  expect(client.putCalls.flatMap((call) => call.records).map((record) => record.id)).toEqual([1]);
});

test("UPDATE FROM APP: 64文字過剰取得分も全チャンク合計maxRecordsを消費する", async () => {
  const prefix = "A".repeat(64);
  const client = makeClient({ recordsByApp: {
    200: [makeRecord({ code: `${prefix}X`, src: "updated" })],
    100: [
      makeRecord({ $id: "1", 顧客コード: `${prefix}X` }),
      makeRecord({ $id: "2", 顧客コード: `${prefix}Y` }),
    ],
  } });
  client.getFields = async (appId) => appId === 200
    ? [{ code: "code", label: "code", fieldType: "SINGLE_LINE_TEXT" }, { code: "src", label: "src", fieldType: "SINGLE_LINE_TEXT" }]
    : [{ code: "顧客コード", label: "顧客コード", fieldType: "SINGLE_LINE_TEXT" }, { code: "dest", label: "dest", fieldType: "SINGLE_LINE_TEXT" }];

  await expect(execute(
    "UPDATE APP100 SET dest = s.src FROM APP200 s WHERE 顧客コード = s.code",
    client,
    { maxRecords: 1, cacheContext: "update-from-65-char-limit" }
  )).rejects.toThrow(/上限/);
  expect(client.putCalls).toHaveLength(0);
});

test("UPDATE FROM APP: NUMBER業務キーはNumber変換せず高精度値を区別する", async () => {
  const client = makeClient({ recordsByApp: {
    200: [
      makeRecord({ code: "9007199254740992.10", src: "A" }),
      makeRecord({ code: "9007199254740993.1", src: "B" }),
    ],
    100: [
      makeRecord({ $id: "1", 顧客番号: "9007199254740992.1" }),
      makeRecord({ $id: "2", 顧客番号: "9007199254740993.10" }),
    ],
  } });
  client.getFields = async (appId) => appId === 200
    ? [{ code: "code", label: "code", fieldType: "NUMBER" }, { code: "src", label: "src", fieldType: "SINGLE_LINE_TEXT" }]
    : [{ code: "顧客番号", label: "顧客番号", fieldType: "NUMBER" }, { code: "dest", label: "dest", fieldType: "SINGLE_LINE_TEXT" }];

  const result = await execute(
    "UPDATE APP100 SET dest = s.src FROM APP200 s WHERE 顧客番号 = s.code",
    client,
    { cacheContext: "update-from-exact-decimal" }
  ) as UpdateResult;
  expect(result.updatedCount).toBe(2);
  expect(client.putCalls.flatMap((call) => call.records)).toEqual([
    { id: 1, record: { dest: { value: "A" } } },
    { id: 2, record: { dest: { value: "B" } } },
  ]);
});

test("UPDATE FROM APP: NUMBERターゲットの空値は非一致として除外する", async () => {
  const client = makeClient({ recordsByApp: {
    200: [makeRecord({ code: "1", src: "A" })],
    100: [makeRecord({ $id: "1", 顧客番号: "" }), makeRecord({ $id: "2", 顧客番号: "1" })],
  } });
  client.getFields = async (appId) => appId === 200
    ? [{ code: "code", label: "code", fieldType: "NUMBER" }, { code: "src", label: "src", fieldType: "SINGLE_LINE_TEXT" }]
    : [{ code: "顧客番号", label: "顧客番号", fieldType: "NUMBER" }, { code: "dest", label: "dest", fieldType: "SINGLE_LINE_TEXT" }];
  const result = await execute(
    "UPDATE APP100 SET dest = s.src FROM APP200 s WHERE 顧客番号 = s.code",
    client,
    { cacheContext: "update-from-empty-number-target" }
  ) as UpdateResult;
  expect(result.updatedCount).toBe(1);
  expect(client.putCalls.flatMap((call) => call.records).map((record) => record.id)).toEqual([2]);
});

test("UPDATE FROM APP: NUMBER業務キーの正規化後source重複をtarget取得前に拒否する", async () => {
  const client = makeClient({ recordsByApp: {
    200: [makeRecord({ code: "+01.0", src: "A" }), makeRecord({ code: "1", src: "B" })],
  } });
  client.getFields = async (appId) => appId === 200
    ? [{ code: "code", label: "code", fieldType: "NUMBER" }, { code: "src", label: "src", fieldType: "SINGLE_LINE_TEXT" }]
    : [{ code: "顧客番号", label: "顧客番号", fieldType: "NUMBER" }, { code: "dest", label: "dest", fieldType: "SINGLE_LINE_TEXT" }];

  await expect(execute(
    "UPDATE APP100 SET dest = s.src FROM APP200 s WHERE 顧客番号 = s.code",
    client,
    { cacheContext: "update-from-normalized-duplicate" }
  )).rejects.toThrow(/multiple rows/);
  expect(client.getCalls.filter((call) => call.app === 100)).toHaveLength(0);
  expect(client.putCalls).toHaveLength(0);
});

test.each(["", "NaN", "Infinity"])(
  "UPDATE FROM APP: NUMBER source業務キー %p を有限10進表記として拒否する",
  async (key) => {
    const client = makeClient({ recordsByApp: { 200: [makeRecord({ code: key, src: "A" })] } });
    client.getFields = async (appId) => appId === 200
      ? [{ code: "code", label: "code", fieldType: "NUMBER" }, { code: "src", label: "src", fieldType: "SINGLE_LINE_TEXT" }]
      : [{ code: "顧客番号", label: "顧客番号", fieldType: "NUMBER" }, { code: "dest", label: "dest", fieldType: "SINGLE_LINE_TEXT" }];
    await expect(execute(
      "UPDATE APP100 SET dest = s.src FROM APP200 s WHERE 顧客番号 = s.code",
      client,
      { cacheContext: `update-from-invalid-decimal-${key}` }
    )).rejects.toThrow(/finite decimal/);
    expect(client.getCalls.filter((call) => call.app === 100)).toHaveLength(0);
    expect(client.putCalls).toHaveLength(0);
  }
);

test("UPDATE FROM APP: NUMBER業務キーは指数同値を単一primitiveで照合する", async () => {
  const client = makeClient({ recordsByApp: {
    200: [makeRecord({ code: "1e3", src: "A" })],
    100: [makeRecord({ $id: "1", 顧客番号: "1000" })],
  } });
  client.getFields = async (appId) => appId === 200
    ? [{ code: "code", label: "code", fieldType: "NUMBER" }, { code: "src", label: "src", fieldType: "SINGLE_LINE_TEXT" }]
    : [{ code: "顧客番号", label: "顧客番号", fieldType: "NUMBER" }, { code: "dest", label: "dest", fieldType: "SINGLE_LINE_TEXT" }];
  const result = await execute(
    "UPDATE APP100 SET dest = s.src FROM APP200 s WHERE 顧客番号 = s.code",
    client,
    { cacheContext: "update-from-exact-exponent" }
  ) as UpdateResult;
  expect(result.updatedCount).toBe(1);
  expect(client.getCalls.find((call) => call.app === 100)?.query).toContain('"1e3"');
});

test("UPDATE FROM APP: target/sourceの非対応業務キー型をtarget取得前に拒否する", async () => {
  const targetClient = makeClient();
  targetClient.getFields = async (appId) => appId === 100
    ? [{ code: "計算キー", label: "計算キー", fieldType: "CALC", writable: false }, { code: "dest", label: "dest", fieldType: "SINGLE_LINE_TEXT" }]
    : [{ code: "code", label: "code", fieldType: "NUMBER" }, { code: "src", label: "src", fieldType: "SINGLE_LINE_TEXT" }];
  await expect(execute(
    "UPDATE APP100 SET dest = s.src FROM APP200 s WHERE 計算キー = s.code",
    targetClient,
    { cacheContext: "update-from-invalid-target-type" }
  )).rejects.toThrow(/target join field type CALC/);
  expect(targetClient.getCalls).toHaveLength(0);

  const sourceClient = makeClient();
  sourceClient.getFields = async (appId) => appId === 100
    ? [{ code: "顧客コード", label: "顧客コード", fieldType: "SINGLE_LINE_TEXT" }, { code: "dest", label: "dest", fieldType: "SINGLE_LINE_TEXT" }]
    : [{ code: "code", label: "code", fieldType: "DROP_DOWN" }, { code: "src", label: "src", fieldType: "SINGLE_LINE_TEXT" }];
  await expect(execute(
    "UPDATE APP100 SET dest = s.src FROM APP200 s WHERE 顧客コード = s.code",
    sourceClient,
    { cacheContext: "update-from-invalid-source-join-type" }
  )).rejects.toThrow(/source join field type DROP_DOWN/);
  expect(sourceClient.getCalls).toHaveLength(0);
});

test("UPDATE FROM APP VALIDATE ONLY: 通常実行と同じ業務キーmatchedだけを検証する", async () => {
  const prefix = "A".repeat(64);
  const exact = `${prefix}X`;
  const client = makeClient({ recordsByApp: {
    200: [makeRecord({ code: exact, src: "11" })],
    100: [
      makeRecord({ $id: "1", 顧客コード: exact }),
      makeRecord({ $id: "2", 顧客コード: `${prefix}Y` }),
    ],
  } });
  client.getFields = async (appId) => appId === 200
    ? [{ code: "code", label: "code", fieldType: "SINGLE_LINE_TEXT" }, { code: "src", label: "src", fieldType: "SINGLE_LINE_TEXT" }]
    : [{ code: "顧客コード", label: "顧客コード", fieldType: "SINGLE_LINE_TEXT" }, { code: "amount", label: "amount", fieldType: "NUMBER", maxValue: "10" }];

  const result = await execute(
    "UPDATE APP100 SET amount = s.src FROM APP200 s WHERE 顧客コード = s.code VALIDATE ONLY",
    client,
    { cacheContext: "validate-update-from-business" }
  );
  expect(result).toMatchObject({ type: "VALIDATION", validatedRows: 1, invalidRows: 1, errorCount: 1 });
  if (result.type !== "VALIDATION") throw new Error("unexpected result");
  expect(result.errors.map((row) => row.$id)).toEqual(["1"]);
  expect(client.putCalls).toHaveLength(0);
});

test("UPDATE FROM APP: 複数チャンクのtarget取得合計がmaxRecordsを超えるとPUT前に拒否する", async () => {
  const source = Array.from({ length: 51 }, (_, i) => makeRecord({ code: `K${i + 1}`, src: "x" }));
  const target = [
    ...Array.from({ length: 50 }, (_, i) => makeRecord({ $id: String(i + 1), 顧客コード: `K${i + 1}` })),
    ...Array.from({ length: 11 }, (_, i) => makeRecord({ $id: String(51 + i), 顧客コード: "K51" })),
  ];
  const client = makeClient();
  client.getFields = async (appId) => appId === 200
    ? [{ code: "code", label: "code", fieldType: "SINGLE_LINE_TEXT" }, { code: "src", label: "src", fieldType: "SINGLE_LINE_TEXT" }]
    : [{ code: "顧客コード", label: "顧客コード", fieldType: "SINGLE_LINE_TEXT" }, { code: "dest", label: "dest", fieldType: "SINGLE_LINE_TEXT" }];
  client.getRecords = async (params) => {
    client.getCalls.push({ app: params.app, query: params.query ?? "", fields: [...(params.fields ?? [])] });
    if (params.app === 200) return { records: source };
    const keys = new Set([...params.query.matchAll(/"(K\d+)"/g)].map((match) => match[1]));
    return { records: target.filter((record) => keys.has(String(record.顧客コード.value))) };
  };

  await expect(execute(
    "UPDATE APP100 SET dest = s.src FROM APP200 s WHERE 顧客コード = s.code",
    client,
    { maxRecords: 60, cacheContext: "update-from-global-target-limit" }
  )).rejects.toThrow(/上限（60 件）/);
  expect(client.getCalls.filter((call) => call.app === 100)).toHaveLength(2);
  expect(client.putCalls).toHaveLength(0);
});

test("UPDATE FROM APP: 64文字前方一致で複数チャンクに現れるtargetを二重更新しない", async () => {
  const prefix = "Z".repeat(64);
  const source = [
    makeRecord({ code: `${prefix}X`, src: "X" }),
    ...Array.from({ length: 49 }, (_, i) => makeRecord({ code: `K${i + 2}`, src: "other" })),
    makeRecord({ code: `${prefix}Y`, src: "Y" }),
  ];
  const target = [
    makeRecord({ $id: "1", 顧客コード: `${prefix}X` }),
    makeRecord({ $id: "2", 顧客コード: `${prefix}Y` }),
  ];
  const client = makeClient();
  client.getFields = async (appId) => appId === 200
    ? [{ code: "code", label: "code", fieldType: "SINGLE_LINE_TEXT" }, { code: "src", label: "src", fieldType: "SINGLE_LINE_TEXT" }]
    : [{ code: "顧客コード", label: "顧客コード", fieldType: "SINGLE_LINE_TEXT" }, { code: "dest", label: "dest", fieldType: "SINGLE_LINE_TEXT" }];
  client.getRecords = async (params) => {
    client.getCalls.push({ app: params.app, query: params.query ?? "", fields: [...(params.fields ?? [])] });
    if (params.app === 200) return { records: source };
    // kintoneの先頭64文字比較を再現し、どちらのチャンクにも同じ2行を返す。
    return { records: params.query.includes(prefix) ? target : [] };
  };

  const result = await execute(
    "UPDATE APP100 SET dest = s.src FROM APP200 s WHERE 顧客コード = s.code",
    client,
    { maxRecords: 100, cacheContext: "update-from-cross-chunk-prefix" }
  ) as UpdateResult;
  expect(client.getCalls.filter((call) => call.app === 100)).toHaveLength(2);
  expect(result.updatedCount).toBe(2);
  expect(client.putCalls.flatMap((call) => call.records)).toEqual([
    { id: 1, record: { dest: { value: "X" } } },
    { id: 2, record: { dest: { value: "Y" } } },
  ]);
});

test("UPDATE サブテーブル行（_rid 条件）", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [
        {
          $id: { value: "1" },
          $revision: { value: "7" },
          伝票番号: { value: "S-001" },
          明細: {
            value: [
              { id: "r1", value: { 商品コード: { value: "A-001" }, 数量: { value: "1" } } },
              { id: "r2", value: { 商品コード: { value: "A-002" }, 数量: { value: "2" } } },
            ],
          },
        } as unknown as KintoneRecord,
      ],
    },
  });

  const result = await execute(
    "UPDATE APP100$明細 SET 数量 = 5 WHERE _rid = 'r2'",
    client
  ) as UpdateResult;

  expect(result.updatedCount).toBe(1);
  expect(client.putCalls).toHaveLength(1);
  const table = client.putCalls[0].records[0].record["明細"].value as unknown as Array<{ id?: string; value?: Record<string, { value: string }> }>;
  expect(table[0]).toEqual({ id: "r1" });
  expect(table[1].id).toBe("r2");
  expect(table[1].value?.["数量"].value).toBe("5");
  expect(table[1].value?.["商品コード"]).toBeUndefined();
});

test("UPDATE サブテーブル行はワイルドカード LIKE を JS 評価する", async () => {
  const client = makeClient({ recordsByApp: { 100: [{
    $id: { value: "1" }, $revision: { value: "1" },
    明細: { value: [
      { id: "r1", value: { 商品コード: { value: "A-001" }, 数量: { value: "1" } } },
      { id: "r2", value: { 商品コード: { value: "B-001" }, 数量: { value: "2" } } },
    ] },
  } as unknown as KintoneRecord] } });
  const result = await execute(
    "UPDATE APP100$明細 SET 数量 = 9 WHERE _rid LIKE 'r_' AND 商品コード LIKE 'A%'",
    client
  ) as UpdateResult;
  expect(result.updatedCount).toBe(1);
  expect(client.putCalls).toHaveLength(1);
});

test("SELECT サブテーブル: 子 CHECK_BOX と _p.親 CHECK_BOX を型付き IN 評価する", async () => {
  const client = makeClient({ recordsByApp: { 100: [{
    $id: { value: "1" },
    親選択: { value: ["P"] },
    明細: { value: [
      { id: "r1", value: { 子選択: { value: ["A", "B"] }, 商品コード: { value: "A-001" } } },
      { id: "r2", value: { 子選択: { value: ["B"] }, 商品コード: { value: "A-002" } } },
    ] },
  } as unknown as KintoneRecord] } });
  client.getFields = async () => [
    { code: "明細", label: "明細", fieldType: "SUBTABLE" },
    { code: "親選択", label: "親選択", fieldType: "CHECK_BOX" },
    { code: "子選択", label: "子選択", fieldType: "CHECK_BOX" },
    { code: "商品コード", label: "商品コード", fieldType: "SINGLE_LINE_TEXT" },
  ];

  const result = await execute(
    "SELECT _rid FROM APP100$明細 WHERE 子選択 IN ('A') AND _p.親選択 IN ('P')",
    client,
    { cacheContext: "typed-in-subtable-select" }
  ) as SelectResult;

  expect(result.rows).toEqual([{ _rid: "r1" }]);
});

test("UPDATE サブテーブル: CHECK_BOX IN の要素一致を対象件数・確認件数へ反映する", async () => {
  const client = makeClient({ recordsByApp: { 100: [{
    $id: { value: "1" }, $revision: { value: "1" },
    明細: { value: [
      { id: "r1", value: { 選択: { value: ["A", "B"] }, 数量: { value: "1" } } },
      { id: "r2", value: { 選択: { value: ["B"] }, 数量: { value: "2" } } },
    ] },
  } as unknown as KintoneRecord] } });
  client.getFields = async () => [
    { code: "選択", label: "選択", fieldType: "CHECK_BOX" },
    { code: "数量", label: "数量", fieldType: "NUMBER" },
  ];
  let confirmedCount = -1;

  const result = await execute(
    "UPDATE APP100$明細 SET 数量 = 9 WHERE _rid LIKE '%' AND 選択 IN ('A')",
    client,
    { cacheContext: "typed-in-subtable-update", confirm: async (count) => { confirmedCount = count; return true; } }
  ) as UpdateResult;

  expect(confirmedCount).toBe(1);
  expect(result.updatedCount).toBe(1);
});

test("UPDATE サブテーブル: 空 CHECK_BOX は IN ('') の対象になる", async () => {
  const client = makeClient({ recordsByApp: { 100: [{
    $id: { value: "1" }, $revision: { value: "1" },
    明細: { value: [
      { id: "r1", value: { 選択: { value: [] }, 数量: { value: "1" } } },
      { id: "r2", value: { 選択: { value: ["A"] }, 数量: { value: "2" } } },
    ] },
  } as unknown as KintoneRecord] } });
  client.getFields = async () => [
    { code: "選択", label: "選択", fieldType: "CHECK_BOX" },
    { code: "数量", label: "数量", fieldType: "NUMBER" },
  ];
  let confirmedCount = -1;

  const result = await execute(
    "UPDATE APP100$明細 SET 数量 = 9 WHERE _rid LIKE '%' AND 選択 IN ('')",
    client,
    { cacheContext: "typed-in-empty-subtable-update", confirm: async (count) => { confirmedCount = count; return true; } }
  ) as UpdateResult;

  expect(confirmedCount).toBe(1);
  expect(result.updatedCount).toBe(1);
  const table = client.putCalls[0].records[0].record["明細"].value as unknown as Array<{
    id?: string; value?: Record<string, { value: string }>;
  }>;
  expect(table.find((row) => row.id === "r1")?.value?.["数量"].value).toBe("9");
  expect(table.find((row) => row.id === "r2")?.value).toBeUndefined();
});

test("UPDATE サブテーブル: 空数値セルを >= の対象から外し、確認件数と更新件数を揃える", async () => {
  const client = makeClient({ recordsByApp: { 100: [{
    $id: { value: "1" }, $revision: { value: "1" },
    明細: { value: [
      { id: "r1", value: { 商品コード: { value: "A" }, 数量: { value: "" } } },
      { id: "r2", value: { 商品コード: { value: "B" }, 数量: { value: "0" } } },
    ] },
  } as unknown as KintoneRecord] } });
  let confirmedCount = -1;

  const result = await execute(
    "UPDATE APP100$明細 SET 商品コード = '更新' WHERE _rid LIKE '%' AND 数量 >= -1000000",
    client,
    { confirm: async (count) => { confirmedCount = count; return true; } }
  ) as UpdateResult;

  expect(confirmedCount).toBe(1);
  expect(result.updatedCount).toBe(1);
  const table = client.putCalls[0].records[0].record["明細"].value as unknown as Array<{ id?: string; value?: Record<string, { value: string }> }>;
  expect(table.find((row) => row.id === "r1")?.value).toBeUndefined();
  expect(table.find((row) => row.id === "r2")?.value?.["商品コード"].value).toBe("更新");
});

test("UPDATE サブテーブルの取得上限は truncate 指定でも error のまま", async () => {
  const row = (id: string) => ({
    $id: { value: id }, $revision: { value: "1" },
    明細: { value: [{ id: `r${id}`, value: { 商品コード: { value: "A-001" }, 数量: { value: "1" } } }] },
  } as unknown as KintoneRecord);
  const client = makeClient({ recordsByApp: { 100: [row("1"), row("2")] } });

  await expect(execute(
    "UPDATE APP100$明細 SET 数量 = 9 WHERE _rid LIKE 'r'",
    client,
    { maxRecords: 1, onLimitReached: "truncate" }
  )).rejects.toThrow("取得件数が上限（1 件）を超えました");
  expect(client.putCalls).toHaveLength(0);
});

test("UPDATE サブテーブルは _rid 条件必須", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [
        {
          $id: { value: "1" },
          $revision: { value: "1" },
          明細: { value: [{ id: "r1", value: { 数量: { value: "1" } } }] },
        } as unknown as KintoneRecord,
      ],
    },
  });
  await expect(
    execute("UPDATE APP100$明細 SET 数量 = 9 WHERE _pid = 1", client)
  ).rejects.toThrow("_rid 条件が必須");
});

// ----------------------------------------------------------------
// DELETE
// ----------------------------------------------------------------

test("DELETE → GET して DELETE", async () => {
  const records = [makeRecord({ $id: "10", 作成日: "2022-01-01" }), makeRecord({ $id: "20", 作成日: "2022-01-01" })];
  const client = makeClient({ records, fieldTypes: { 作成日: "DATE" } });
  const result = await execute(
    "DELETE FROM APP100 WHERE 作成日 < '2023-01-01'",
    client
  ) as DeleteResult;

  expect(result.type).toBe("DELETE");
  expect(result.deletedCount).toBe(2);
  expect(client.deleteCalls[0].ids).toEqual([10, 20]);
});

test("DELETE → 確認コールバックでキャンセル", async () => {
  const client = makeClient({ records: [makeRecord({ $id: "1", f: "v" })] });
  await expect(
    execute("DELETE FROM APP100 WHERE f = 'v'", client, {
      confirm: async () => false,
    })
  ).rejects.toThrow(OperationCancelledError);
  expect(client.deleteCalls).toHaveLength(0);
});

test("DELETE サブテーブル行（_rid 条件）", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [
        {
          $id: { value: "1" },
          $revision: { value: "2" },
          明細: {
            value: [
              { id: "r1", value: { 商品コード: { value: "A-001" } } },
              { id: "r2", value: { 商品コード: { value: "A-002" } } },
            ],
          },
        } as unknown as KintoneRecord,
      ],
    },
  });

  const result = await execute(
    "DELETE FROM APP100$明細 WHERE _rid = 'r1'",
    client
  ) as DeleteResult;

  expect(result.deletedCount).toBe(1);
  expect(client.putCalls).toHaveLength(1);
  const table = client.putCalls[0].records[0].record["明細"].value as unknown as Array<{ id?: string }>;
  expect(table).toHaveLength(1);
  expect(table[0].id).toBe("r2");
});

test("DELETE サブテーブル: 空数値セルを <= の対象に含め、確認件数と削除件数を揃える", async () => {
  const client = makeClient({ recordsByApp: { 100: [{
    $id: { value: "1" }, $revision: { value: "1" },
    明細: { value: [
      { id: "r1", value: { 商品コード: { value: "A" }, 数量: { value: "" } } },
      { id: "r2", value: { 商品コード: { value: "B" }, 数量: { value: "0" } } },
    ] },
  } as unknown as KintoneRecord] } });
  let confirmedCount = -1;

  const result = await execute(
    "DELETE FROM APP100$明細 WHERE _rid LIKE '%' AND 数量 <= -1000000",
    client,
    { confirm: async (count) => { confirmedCount = count; return true; } }
  ) as DeleteResult;

  expect(confirmedCount).toBe(1);
  expect(result.deletedCount).toBe(1);
  const table = client.putCalls[0].records[0].record["明細"].value as unknown as Array<{ id?: string }>;
  expect(table.map((row) => row.id)).toEqual(["r2"]);
});

test("DELETE サブテーブル: MULTI_SELECT NOT IN の要素一致を反映する", async () => {
  const client = makeClient({ recordsByApp: { 100: [{
    $id: { value: "1" }, $revision: { value: "1" },
    明細: { value: [
      { id: "r1", value: { 選択: { value: ["A"] } } },
      { id: "r2", value: { 選択: { value: ["B"] } } },
    ] },
  } as unknown as KintoneRecord] } });
  client.getFields = async () => [
    { code: "選択", label: "選択", fieldType: "MULTI_SELECT" },
  ];

  const result = await execute(
    "DELETE FROM APP100$明細 WHERE _rid LIKE '%' AND 選択 NOT IN ('A')",
    client,
    { cacheContext: "typed-in-subtable-delete" }
  ) as DeleteResult;

  expect(result.deletedCount).toBe(1);
  const table = client.putCalls[0].records[0].record["明細"].value as unknown as Array<{ id?: string }>;
  expect(table.map((row) => row.id)).toEqual(["r1"]);
});

test("REORDER サブテーブル行（親単位）", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [
        {
          $id: { value: "1" },
          $revision: { value: "2" },
          明細: {
            value: [
              { id: "r1", value: { 商品コード: { value: "B-002" }, 数量: { value: "1" } } },
              { id: "r2", value: { 商品コード: { value: "A-001" }, 数量: { value: "2" } } },
            ],
          },
        } as unknown as KintoneRecord,
      ],
    },
  });

  const result = await execute(
    "REORDER APP100$明細 BY 商品コード ASC WHERE _pid = 1",
    client
  ) as any;

  expect(result.type).toBe("REORDER");
  expect(result.reorderedParentCount).toBe(1);
  expect(client.putCalls).toHaveLength(1);
  const table = client.putCalls[0].records[0].record["明細"].value as unknown as Array<{ id?: string; value?: unknown }>;
  expect(table[0].id).toBe("r2");
  expect(table[1].id).toBe("r1");
  expect(table.every((r) => r.value === undefined)).toBe(true);
});

test("B26: REORDER はtyped stringをコードポイント順、typed numberを数値順にする", async () => {
  const parent = {
    $id: { value: "1" },
    $revision: { value: "1" },
    明細: { value: [
      { id: "r1", value: { コード: { value: "2" }, 数量: { value: "10" } } },
      { id: "r2", value: { コード: { value: "10" }, 数量: { value: "2" } } },
    ] },
  } as unknown as KintoneRecord;
  const client = makeClient({ recordsByApp: { 100: [parent] } });
  client.getFields = async () => [
    { code: "コード", label: "コード", fieldType: "SINGLE_LINE_TEXT", inSubtable: true },
    { code: "数量", label: "数量", fieldType: "NUMBER", inSubtable: true },
  ];

  await execute("REORDER ALL APP100$明細 BY コード ASC", client, { cacheContext: "reorder-string" });
  await execute("REORDER ALL APP100$明細 BY 数量 ASC", client, { cacheContext: "reorder-number" });

  const stringOrder = client.putCalls[0].records[0].record["明細"].value as unknown as Array<{ id: string }>;
  const numberOrder = client.putCalls[1].records[0].record["明細"].value as unknown as Array<{ id: string }>;
  expect(stringOrder.map((row) => row.id)).toEqual(["r2", "r1"]);
  expect(numberOrder.map((row) => row.id)).toEqual(["r2", "r1"]);
});

test("サブテーブルUPDATE/DELETE/REORDERは16桁超NUMBERを厳密評価する", async () => {
  const makeExactClient = () => {
    const parent = {
      $id: { value: "1" }, $revision: { value: "1" },
      明細: { value: [
        { id: "high", value: { 数量: { value: "9007199254740993" }, 印: { value: "" } } },
        { id: "low", value: { 数量: { value: "9007199254740992" }, 印: { value: "" } } },
      ] },
    } as unknown as KintoneRecord;
    const client = makeClient({ recordsByApp: { 100: [parent] } });
    client.getFields = async () => [
      { code: "数量", label: "数量", fieldType: "NUMBER", inSubtable: true },
      { code: "印", label: "印", fieldType: "SINGLE_LINE_TEXT", inSubtable: true },
    ];
    return client;
  };

  const updateClient = makeExactClient();
  const updated = await execute(
    "UPDATE APP100$明細 SET 印 = 'L' WHERE _rid LIKE '%' AND 数量 < 9007199254740993",
    updateClient,
    { cacheContext: "exact-subtable-update" }
  ) as UpdateResult;
  expect(updated.updatedCount).toBe(1);
  const updatedTable = updateClient.putCalls[0].records[0].record["明細"].value as unknown as Array<{ id: string; value?: Record<string, { value: string }> }>;
  expect(updatedTable.find((row) => row.id === "low")?.value?.["印"].value).toBe("L");
  expect(updatedTable.find((row) => row.id === "high")?.value).toBeUndefined();

  const deleteClient = makeExactClient();
  const deleted = await execute(
    "DELETE FROM APP100$明細 WHERE _rid LIKE '%' AND 数量 > 9007199254740992",
    deleteClient,
    { cacheContext: "exact-subtable-delete" }
  ) as DeleteResult;
  expect(deleted.deletedCount).toBe(1);
  const remaining = deleteClient.putCalls[0].records[0].record["明細"].value as unknown as Array<{ id: string }>;
  expect(remaining.map((row) => row.id)).toEqual(["low"]);

  const reorderClient = makeExactClient();
  await execute("REORDER ALL APP100$明細 BY 数量 ASC", reorderClient, {
    cacheContext: "exact-subtable-reorder",
  });
  const reordered = reorderClient.putCalls[0].records[0].record["明細"].value as unknown as Array<{ id: string }>;
  expect(reordered.map((row) => row.id)).toEqual(["low", "high"]);
});

test("REORDER: 空数値セルだけの親を >= の対象から外し、確認件数と親件数を揃える", async () => {
  const parent = (id: string, quantity: string, rowId: string) => ({
    $id: { value: id }, $revision: { value: "1" },
    明細: { value: [
      { id: rowId, value: { 商品コード: { value: `P-${id}` }, 数量: { value: quantity } } },
    ] },
  } as unknown as KintoneRecord);
  const client = makeClient({ recordsByApp: { 100: [
    parent("1", "", "r1"),
    parent("2", "0", "r2"),
  ] } });
  let confirmedCount = -1;

  const result = await execute(
    "REORDER APP100$明細 BY 商品コード ASC WHERE 数量 >= -1000000",
    client,
    { confirm: async (count) => { confirmedCount = count; return true; } }
  ) as any;

  expect(confirmedCount).toBe(1);
  expect(result.reorderedParentCount).toBe(1);
  expect(client.putCalls).toHaveLength(1);
  expect(client.putCalls[0].records[0].id).toBe(2);
});

test("REORDER: CHECK_BOX IN の要素一致を親件数・確認件数へ反映する", async () => {
  const parent = (id: string, selected: string, rowId: string) => ({
    $id: { value: id }, $revision: { value: "1" },
    明細: { value: [
      { id: rowId, value: { 商品コード: { value: `P-${id}` }, 選択: { value: [selected] } } },
    ] },
  } as unknown as KintoneRecord);
  const client = makeClient({ recordsByApp: { 100: [
    parent("1", "A", "r1"),
    parent("2", "B", "r2"),
  ] } });
  client.getFields = async () => [
    { code: "選択", label: "選択", fieldType: "CHECK_BOX" },
    { code: "商品コード", label: "商品コード", fieldType: "SINGLE_LINE_TEXT" },
  ];
  let confirmedCount = -1;

  const result = await execute(
    "REORDER APP100$明細 BY 商品コード ASC WHERE 選択 IN ('A')",
    client,
    { cacheContext: "typed-in-subtable-reorder", confirm: async (count) => { confirmedCount = count; return true; } }
  ) as any;

  expect(confirmedCount).toBe(1);
  expect(result.reorderedParentCount).toBe(1);
  expect(client.putCalls).toHaveLength(1);
  expect(client.putCalls[0].records[0].id).toBe(1);
});

test("REORDER は WHERE 必須", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [
        {
          $id: { value: "1" },
          $revision: { value: "1" },
          明細: { value: [{ id: "r1", value: { 数量: { value: "1" } } }] },
        } as unknown as KintoneRecord,
      ],
    },
  });

  await expect(
    execute("REORDER APP100$明細 BY 数量 ASC", client)
  ).rejects.toThrow("WHERE 句が必須");
});

test("REORDER ALL サブテーブル行（全親対象）", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [
        {
          $id: { value: "1" },
          $revision: { value: "2" },
          明細: {
            value: [
              { id: "r1", value: { 商品コード: { value: "B-002" } } },
              { id: "r2", value: { 商品コード: { value: "A-001" } } },
            ],
          },
        } as unknown as KintoneRecord,
        {
          $id: { value: "2" },
          $revision: { value: "5" },
          明細: {
            value: [
              { id: "r3", value: { 商品コード: { value: "D-002" } } },
              { id: "r4", value: { 商品コード: { value: "C-001" } } },
            ],
          },
        } as unknown as KintoneRecord,
      ],
    },
  });

  const result = await execute(
    "REORDER ALL APP100$明細 BY 商品コード ASC",
    client
  ) as any;

  expect(result.type).toBe("REORDER");
  expect(result.reorderedParentCount).toBe(2);
  expect(client.putCalls).toHaveLength(2);
});

// ----------------------------------------------------------------
// INSERT INTO ... SELECT
// ----------------------------------------------------------------

test("INSERT INTO APP200 ... SELECT FROM APP100 — 基本", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [
        makeRecord({ 名前: "田中", 金額: "1000" }),
        makeRecord({ 名前: "鈴木", 金額: "2000" }),
      ],
    },
    postIds: ["201", "202"],
    fieldTypes: { 顧客名: "SINGLE_LINE_TEXT", 単価: "NUMBER" },
  });

  const result = await execute(
    "INSERT INTO APP200 (顧客名, 単価) SELECT 名前, 金額 FROM APP100",
    client
  ) as InsertResult;

  expect(result.type).toBe("INSERT");
  expect(result.insertedCount).toBe(2);
  expect(client.postCalls).toHaveLength(1);
  expect(client.postCalls[0].app).toBe(200);
  expect(client.postCalls[0].records[0]).toEqual({
    顧客名: { value: "田中" },
    単価:   { value: "1000" },
  });
  expect(client.postCalls[0].records[1]).toEqual({
    顧客名: { value: "鈴木" },
    単価:   { value: "2000" },
  });
});

test("INSERT INTO ... SELECT — 101行 → POST 2回", async () => {
  const sourceRecords = Array.from({ length: 101 }, (_, i) =>
    makeRecord({ 名前: `名前${i}` })
  );
  const client = makeClient({
    recordsByApp: { 100: sourceRecords },
    postIds: [],
    fieldTypes: { 顧客名: "SINGLE_LINE_TEXT" },
  });

  await execute(
    "INSERT INTO APP200 (顧客名) SELECT 名前 FROM APP100",
    client
  );

  expect(client.postCalls).toHaveLength(2);
  expect(client.postCalls[0].records).toHaveLength(100);
  expect(client.postCalls[1].records).toHaveLength(1);
});

test("INSERT INTO ... SELECT — 明示列の空ソースは insertedCount=0 の no-op", async () => {
  const client = makeClient({ recordsByApp: { 100: [] }, fieldTypes: { 顧客名: "SINGLE_LINE_TEXT", 単価: "NUMBER", 名前: "SINGLE_LINE_TEXT", 金額: "NUMBER" } });

  const result = await execute(
    "INSERT INTO APP200 (顧客名, 単価) SELECT 名前, 金額 FROM APP100",
    client,
    { cacheContext: "empty-insert-select" }
  ) as InsertResult;

  expect(result).toMatchObject({ type: "INSERT", insertedCount: 0 });
  expect(client.postCalls).toHaveLength(0);
  expect(client.putCalls).toHaveLength(0);
});

test("INSERT INTO ... SELECT * — 空ソースの列数エラーは明示列を案内する", async () => {
  const client = makeClient({ recordsByApp: { 100: [] }, fieldTypes: { 顧客名: "SINGLE_LINE_TEXT" } });

  await expect(
    execute(
      "INSERT INTO APP200 (顧客名) SELECT * FROM APP100",
      client,
      { cacheContext: "empty-insert-wildcard-message" }
    )
  ).rejects.toThrow(
    "結果が 0 行のため列を特定できませんでした（SELECT * を空ソースに使うと列を決定できません。明示列で指定してください）"
  );
  expect(client.postCalls).toHaveLength(0);
  expect(client.putCalls).toHaveLength(0);
});

test("INSERT INTO ... SELECT * — 非空結果の 0 列エラーでは 0 行と誤案内しない", async () => {
  const client = makeClient({ recordsByApp: { 100: [makeRecord({ "_p.hidden": "x" })] }, fieldTypes: { 顧客名: "SINGLE_LINE_TEXT" } });
  const execution = execute(
    "INSERT INTO APP200 (顧客名) SELECT * FROM APP100",
    client,
    { cacheContext: "nonempty-zero-column-message" }
  );

  await expect(execution).rejects.toThrow(
    "SELECT の列数（0）と INSERT のフィールド数（1）が一致しません"
  );
  await expect(execution).rejects.not.toThrow("結果が 0 行のため");
  expect(client.postCalls).toHaveLength(0);
  expect(client.putCalls).toHaveLength(0);
});

test("INSERT INTO ... SELECT — 列数不一致はエラー", async () => {
  const client = makeClient({
    recordsByApp: { 100: [makeRecord({ 名前: "田中" })] },
    fieldTypes: { f1: "SINGLE_LINE_TEXT", f2: "SINGLE_LINE_TEXT" },
  });

  await expect(
    execute(
      "INSERT INTO APP200 (f1, f2) SELECT 名前 FROM APP100",
      client
    )
  ).rejects.toThrow("列数");
});

test("INSERT INTO ... SELECT — 集計結果を別アプリに登録", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [
        makeRecord({ 種別: "A", 金額: "100" }),
        makeRecord({ 種別: "A", 金額: "200" }),
        makeRecord({ 種別: "B", 金額: "500" }),
      ],
    },
    postIds: [],
    fieldTypes: { 種別: "SINGLE_LINE_TEXT", 合計: "NUMBER" },
  });

  await execute(
    "INSERT INTO APP200 (種別, 合計) SELECT 種別, SUM(金額) AS 合計 FROM APP100 GROUP BY 種別",
    client
  );

  expect(client.postCalls).toHaveLength(1);
  // SUM(金額): A=300, B=500
  const posted = client.postCalls[0].records.sort((a, b) =>
    (a["種別"].value as string).localeCompare(b["種別"].value as string)
  );
  expect(posted[0]).toEqual({ 種別: { value: "A" }, 合計: { value: "300" } });
  expect(posted[1]).toEqual({ 種別: { value: "B" }, 合計: { value: "500" } });
});

// ----------------------------------------------------------------
// UNION / UNION ALL
// ----------------------------------------------------------------

test("UNION — 重複行を除去して結合", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [makeRecord({ 名前: "田中" }), makeRecord({ 名前: "鈴木" })],
      200: [makeRecord({ 名前: "田中" }), makeRecord({ 名前: "佐藤" })],
    },
  });

  const result = await execute(
    "SELECT 名前 FROM APP100 UNION SELECT 名前 FROM APP200",
    client
  ) as SelectResult;

  expect(result.type).toBe("SELECT");
  expect(result.rowCount).toBe(3);
  const names = result.rows.map((r) => r["名前"]).sort();
  expect(names).toEqual(["佐藤", "田中", "鈴木"]);
});

test("UNION ALL — 重複を保持して結合", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [makeRecord({ 名前: "田中" }), makeRecord({ 名前: "鈴木" })],
      200: [makeRecord({ 名前: "田中" }), makeRecord({ 名前: "佐藤" })],
    },
  });

  const result = await execute(
    "SELECT 名前 FROM APP100 UNION ALL SELECT 名前 FROM APP200",
    client
  ) as SelectResult;

  expect(result.rowCount).toBe(4);
  const names = result.rows.map((r) => r["名前"]).sort();
  expect(names).toEqual(["佐藤", "田中", "田中", "鈴木"]);
});

test("UNION — 右辺の列名を左辺の列名に位置対応でリマップ", async () => {
  // 左辺: SELECT 名前 AS n, 金額 AS amt FROM APP100
  // 右辺: SELECT 顧客名 AS name, 価格 AS price FROM APP200
  // 結果の列名は左辺 ["n", "amt"] になり、右辺の値が position で入る
  const client = makeClient({
    recordsByApp: {
      100: [makeRecord({ 名前: "田中", 金額: "1000" })],
      200: [makeRecord({ 顧客名: "鈴木", 価格: "2000" })],
    },
  });

  const result = await execute(
    "SELECT 名前 AS n, 金額 AS amt FROM APP100 UNION SELECT 顧客名 AS name, 価格 AS price FROM APP200",
    client
  ) as SelectResult;

  expect(result.columns).toEqual(["n", "amt"]);
  expect(result.rows[0]).toEqual({ n: "田中", amt: "1000" });
  expect(result.rows[1]).toEqual({ n: "鈴木", amt: "2000" });
});

test.each([
  { operator: "UNION ALL", expected: ["X", "X", "Y"] },
  { operator: "UNION", expected: ["X", "Y"] },
])("$operator — 左辺が空でも左辺列名で右辺を保持する", async ({ operator, expected }) => {
  const client = makeClient({
    recordsByApp: {
      100: [],
      200: [makeRecord({ b: "X" }), makeRecord({ b: "X" }), makeRecord({ b: "Y" })],
    },
  });

  const result = await execute(
    `SELECT a FROM APP100 ${operator} SELECT b FROM APP200`,
    client
  ) as SelectResult;

  expect(result.columns).toEqual(["a"]);
  expect(result.rows.map((row) => row.a)).toEqual(expected);
});

test("UNION 3ウェイチェーン — 左結合で順番通り結合", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [makeRecord({ 名前: "田中" })],
      200: [makeRecord({ 名前: "鈴木" })],
      300: [makeRecord({ 名前: "佐藤" })],
    },
  });

  const result = await execute(
    "SELECT 名前 FROM APP100 UNION ALL SELECT 名前 FROM APP200 UNION ALL SELECT 名前 FROM APP300",
    client
  ) as SelectResult;

  expect(result.rowCount).toBe(3);
  expect(result.rows.map((r) => r["名前"])).toEqual(["田中", "鈴木", "佐藤"]);
});

test("UNION — 全行重複はすべて1件に", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [makeRecord({ 種別: "A" }), makeRecord({ 種別: "B" })],
      200: [makeRecord({ 種別: "A" }), makeRecord({ 種別: "B" })],
    },
  });

  const result = await execute(
    "SELECT 種別 FROM APP100 UNION SELECT 種別 FROM APP200",
    client
  ) as SelectResult;

  expect(result.rowCount).toBe(2);
});

// ----------------------------------------------------------------
// WHERE 句の算術式・関数（FULL_SCAN モード）
// ----------------------------------------------------------------

test("WHERE 左辺算術式: 金額 * 1.1 > 10000", async () => {
  const records = [
    makeRecord({ 金額: "9000" }),   // 9000 * 1.1 = 9900 → NG
    makeRecord({ 金額: "10000" }),  // 10000 * 1.1 = 11000 → OK
    makeRecord({ 金額: "5000" }),   // 5000 * 1.1 = 5500 → NG
  ];
  const client = makeClient({ records });
  const result = await execute(
    "SELECT 金額 FROM APP100 WHERE 金額 * 1.1 > 10000",
    client
  ) as SelectResult;

  expect(result.rowCount).toBe(1);
  expect(result.rows[0]["金額"]).toBe("10000");
});

test("WHERE 左辺算術式: (単価 + 送料) * 数量 < 5000", async () => {
  const records = [
    makeRecord({ 単価: "100", 送料: "50", 数量: "20" }), // 150 * 20 = 3000 → OK
    makeRecord({ 単価: "200", 送料: "50", 数量: "20" }), // 250 * 20 = 5000 → NG（< なので等値は除外）
    makeRecord({ 単価: "300", 送料: "50", 数量: "10" }), // 350 * 10 = 3500 → OK
  ];
  const client = makeClient({ records });
  const result = await execute(
    "SELECT 単価 FROM APP100 WHERE (単価 + 送料) * 数量 < 5000",
    client
  ) as SelectResult;

  expect(result.rowCount).toBe(2);
  const prices = result.rows.map((r) => r["単価"]).sort();
  expect(prices).toEqual(["100", "300"]);
});

test("WHERE 左辺関数の算術式: LENGTH(備考) * 2 > 10", async () => {
  const records = [
    makeRecord({ 備考: "AB" }),       // LENGTH=2, 2*2=4 → NG
    makeRecord({ 備考: "ABCDEF" }),   // LENGTH=6, 6*2=12 → OK
    makeRecord({ 備考: "ABCDE" }),    // LENGTH=5, 5*2=10 → NG（> なので等値は除外）
  ];
  const client = makeClient({ records });
  const result = await execute(
    "SELECT 備考 FROM APP100 WHERE LENGTH(備考) * 2 > 10",
    client
  ) as SelectResult;

  expect(result.rowCount).toBe(1);
  expect(result.rows[0]["備考"]).toBe("ABCDEF");
});

test("WHERE 右辺算術式: WHERE 税込 = 金額 * 1.1", async () => {
  const records = [
    makeRecord({ 税込: "1100", 金額: "1000" }), // 1000 * 1.1 = 1100 → OK
    makeRecord({ 税込: "2000", 金額: "2000" }), // 2000 * 1.1 = 2200 → NG
  ];
  const client = makeClient({ records });
  const result = await execute(
    "SELECT 税込, 金額 FROM APP100 WHERE 税込 = 金額 * 1.1",
    client
  ) as SelectResult;

  expect(result.rowCount).toBe(1);
  expect(result.rows[0]["金額"]).toBe("1000");
});

test("WHERE 算術式と通常条件の AND 複合", async () => {
  const records = [
    makeRecord({ 種別: "A", 金額: "10000" }),  // 10000 * 1.1 = 11000 > 10000 → OK
    makeRecord({ 種別: "B", 金額: "10000" }),  // 種別が B → NG
    makeRecord({ 種別: "A", 金額: "5000" }),   // 5000 * 1.1 = 5500 → NG
  ];
  const client = makeClient({ records });
  const result = await execute(
    "SELECT * FROM APP100 WHERE 種別 = 'A' AND 金額 * 1.1 > 10000",
    client
  ) as SelectResult;

  expect(result.rowCount).toBe(1);
  expect(result.rows[0]["金額"]).toBe("10000");
});

// ----------------------------------------------------------------
// WITH 句（CTE）
// ----------------------------------------------------------------

test("WITH — 基本: 単純 CTE はインライン化され WHERE が REST API クエリに渡る", async () => {
  // CTE が SIMPLE モード → インライン化により最終 WHERE が REST API へ送られる
  // モックはクエリを評価しないため全件返すが、実 kintone では API 側でフィルタされる
  const client = makeClient({
    records: [
      makeRecord({ 種別: "A", 金額: "100" }),
      makeRecord({ 種別: "B", 金額: "200" }),
      makeRecord({ 種別: "A", 金額: "300" }),
    ],
  });

  const result = await execute(
    `WITH 全件 AS (SELECT 種別, 金額 FROM APP100)
     SELECT 種別, 金額 FROM 全件 WHERE 種別 = 'A'`,
    client
  ) as SelectResult;

  expect(result.type).toBe("SELECT");
  // インライン化後は REST API が WHERE を評価する（モックは全件返す）
  expect(client.getCalls[0].query).toContain('種別 = "A"');
});

test("WITH — GROUP BY 集計 CTE を最終クエリで LIMIT", async () => {
  const client = makeClient({
    records: [
      makeRecord({ 種別: "A", 金額: "100" }),
      makeRecord({ 種別: "A", 金額: "200" }),
      makeRecord({ 種別: "B", 金額: "500" }),
      makeRecord({ 種別: "C", 金額: "50" }),
    ],
  });

  const result = await execute(
    `WITH 集計 AS (
       SELECT 種別, SUM(金額) AS 合計 FROM APP100 GROUP BY 種別
     )
     SELECT 種別, 合計 FROM 集計 ORDER BY 合計 DESC LIMIT 2`,
    client
  ) as SelectResult;

  expect(result.rowCount).toBe(2);
  expect(result.rows[0]["種別"]).toBe("B"); // 合計 500 が最大
  expect(result.rows[0]["合計"]).toBe("500");
});

test("WITH — CTE を JOIN で使う", async () => {
  // APP100: 顧客マスタ, APP200: 注文（集計してから JOIN）
  const client = makeClient({
    recordsByApp: {
      100: [
        makeRecord({ 顧客ID: "1", 顧客名: "田中" }),
        makeRecord({ 顧客ID: "2", 顧客名: "鈴木" }),
      ],
      200: [
        makeRecord({ 顧客ID: "1", 金額: "1000" }),
        makeRecord({ 顧客ID: "1", 金額: "2000" }),
        makeRecord({ 顧客ID: "2", 金額: "500" }),
      ],
    },
  });

  // SELECT * で結合結果を取得。行は "c.フィールド" / "r.フィールド" キー付き
  const result = await execute(
    `WITH 受注集計 AS (
       SELECT 顧客ID, SUM(金額) AS 合計 FROM APP200 GROUP BY 顧客ID
     )
     SELECT *
     FROM APP100 AS c
     INNER JOIN 受注集計 AS r ON c.顧客ID = r.顧客ID`,
    client
  ) as SelectResult;

  // 合計で降順ソート（テスト側で整列）
  const rows = result.rows.sort((a, b) => Number(b["r.合計"]) - Number(a["r.合計"]));
  expect(result.rowCount).toBe(2);
  expect(rows[0]["c.顧客名"]).toBe("田中"); // 合計 3000
  expect(rows[0]["r.合計"]).toBe("3000");
  expect(rows[1]["c.顧客名"]).toBe("鈴木"); // 合計 500
});

test("WITH — 複数 CTE を順番に定義して最終クエリで絞り込み", async () => {
  // GROUP BY を使うことで CTE が FULL_SCAN モードになり JS 側でフィルタが機能する
  const client = makeClient({
    records: [
      makeRecord({ 種別: "A", 金額: "100" }),
      makeRecord({ 種別: "A", 金額: "200" }),
      makeRecord({ 種別: "B", 金額: "50" }),
    ],
  });

  // 各 CTE は GROUP BY で集計（FULL_SCAN モード）→ JS 集計
  // 最終クエリは CTE 参照なので JS 側 WHERE が機能する
  const result = await execute(
    `WITH
       A類 AS (SELECT 種別, SUM(金額) AS 合計 FROM APP100 WHERE 種別 = 'A' GROUP BY 種別),
       B類 AS (SELECT 種別, SUM(金額) AS 合計 FROM APP100 WHERE 種別 = 'B' GROUP BY 種別)
     SELECT 種別, 合計 FROM A類 WHERE 合計 > 0`,
    client
  ) as SelectResult;

  // A類: A の SUM = 300、最終 WHERE 合計 > 0 → 1行
  expect(result.rowCount).toBe(1);
  expect(result.rows[0]["種別"]).toBe("A");
  expect(result.rows[0]["合計"]).toBe("300");
});

test("WITH インライン化 — 単純 CTE の WHERE が REST API クエリに渡る", async () => {
  const client = makeClient({
    records: [
      makeRecord({ 種別: "A", 金額: "100" }),
      makeRecord({ 種別: "B", 金額: "200" }),
    ],
    fieldTypes: { 金額: "NUMBER" },
  });

  // CTE が SIMPLE モード + 最終 WHERE が単純比較 → インライン化される
  await execute(
    `WITH 全件 AS (SELECT * FROM APP100 WHERE 種別 = 'A')
     SELECT * FROM 全件 WHERE 金額 > 50`,
    client
  ) as SelectResult;

  // インライン化により CTE WHERE と最終 WHERE が AND で合成されて REST API へ
  expect(client.getCalls.length).toBeGreaterThan(0);
  const sentQuery = client.getCalls[0].query;
  expect(sentQuery).toContain('種別 = "A"');
  expect(sentQuery).toContain("金額 > 50");
  expect(sentQuery).toContain(" and ");
});

test("WITH インライン化 — CTE WHERE のみ（最終 WHERE なし）", async () => {
  const client = makeClient({
    records: [makeRecord({ 種別: "A" }), makeRecord({ 種別: "B" })],
  });

  await execute(
    `WITH 対象 AS (SELECT * FROM APP100 WHERE 種別 = 'A')
     SELECT * FROM 対象`,
    client
  ) as SelectResult;

  // CTE WHERE がそのまま REST API へ
  expect(client.getCalls[0].query).toContain('種別 = "A"');
});

test("WITH インライン化 — GROUP BY CTE は非インライン（FULL_SCAN のまま）", async () => {
  const client = makeClient({
    records: [
      makeRecord({ 種別: "A", 金額: "100" }),
      makeRecord({ 種別: "A", 金額: "200" }),
    ],
  });

  await execute(
    `WITH 集計 AS (SELECT 種別, SUM(金額) AS 合計 FROM APP100 GROUP BY 種別)
     SELECT * FROM 集計 WHERE 合計 > 100`,
    client
  ) as SelectResult;

  // GROUP BY があるため非インライン → CTE と最終クエリで別個に評価
  expect(client.getCalls.length).toBeGreaterThan(0);
});

test("WITH インライン化 — allowlist外 ORDER BY は LIMIT を REST API に渡さない", async () => {
  const client = makeClient({
    records: [
      makeRecord({ 金額: "300" }),
      makeRecord({ 金額: "100" }),
      makeRecord({ 金額: "200" }),
    ],
    fieldTypes: { 金額: "NUMBER" },
  });

  const result = await execute(
    `WITH 全件 AS (SELECT * FROM APP100)
     SELECT * FROM 全件 ORDER BY 金額 ASC LIMIT 2`,
    client
  ) as SelectResult;

  expect(client.getCalls[0].query).not.toContain("limit 2");
  expect(result.rows.map((row) => row.金額)).toEqual(["100", "200"]);
});

test("WITH インライン化 — エイリアス付き FROM (FROM cte AS c WHERE c.field)", async () => {
  const client = makeClient({
    records: [makeRecord({ 金額: "500", 種別: "A" }), makeRecord({ 金額: "100", 種別: "A" })],
    fieldTypes: { 金額: "NUMBER" },
  });
  await execute(
    `WITH 全件 AS (SELECT * FROM APP100 WHERE 種別 = 'A')
     SELECT * FROM 全件 AS c WHERE c.金額 > 200`,
    client
  ) as SelectResult;

  // エイリアス c が除去されて 金額 > 200 が kintone クエリに変換される
  const sentQuery = client.getCalls[0].query;
  expect(sentQuery).toContain("金額 > 200");
});

test("WITH — CTE 内で UNION ALL", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [makeRecord({ 名前: "田中" })],
      200: [makeRecord({ 名前: "田中" }), makeRecord({ 名前: "鈴木" })],
    },
  });

  const result = await execute(
    `WITH 合算 AS (
       SELECT 名前 FROM APP100
       UNION ALL
       SELECT 名前 FROM APP200
     )
     SELECT 名前 FROM 合算`,
    client
  ) as SelectResult;

  // UNION ALL なので重複保持: 田中, 田中, 鈴木
  expect(result.rowCount).toBe(3);
});

test("WITH: 非インライン CTE の空 SELECT * は実体化時の列を返す", async () => {
  const client = makeClient({ recordsByApp: { 100: [] } });
  const result = await execute(
    `WITH c AS (
       SELECT a, COUNT(*) AS cnt FROM APP100 GROUP BY a
     )
     SELECT * FROM c`,
    client
  ) as SelectResult;

  // CTE 本体が GROUP BY のため canInlineSingleCte=false。MaterializedTable 経路を通る。
  expect(result).toMatchObject({ rows: [], columns: ["a", "cnt"], rowCount: 0 });
});

// ----------------------------------------------------------------
// CASE WHEN — WHERE フィルタ / UPDATE SET
// ----------------------------------------------------------------

test("CASE WHEN WHERE フィルタ — 左辺 CASE: 区分で金額を切り替えて比較", async () => {
  const client = makeClient({
    records: [
      makeRecord({ 区分: "特別", 金額: "800",  名前: "田中" }),
      makeRecord({ 区分: "通常", 金額: "1500", 名前: "鈴木" }),
      makeRecord({ 区分: "特別", 金額: "1200", 名前: "佐藤" }),
    ],
  });
  client.getFields = async () => [
    { code: "区分", label: "区分", fieldType: "SINGLE_LINE_TEXT" },
    { code: "金額", label: "金額", fieldType: "NUMBER" },
    { code: "名前", label: "名前", fieldType: "SINGLE_LINE_TEXT" },
  ];

  // CASE WHEN 区分 = '特別' THEN 金額 ELSE 0 END > 1000
  // → 特別かつ金額>1000 の行だけ通過: 佐藤(1200)
  const result = await execute(
    "SELECT 名前 FROM APP100 WHERE CASE WHEN 区分 = '特別' THEN 金額 ELSE 0 END > 1000",
    client
  ) as SelectResult;

  expect(result.rowCount).toBe(1);
  expect(result.rows[0]["名前"]).toBe("佐藤");
});

test("CASE WHEN WHERE フィルタ — 右辺 CASE: ELSE を持つ分岐比較", async () => {
  const client = makeClient({
    records: [
      makeRecord({ 区分: "A", スコア: "90" }),
      makeRecord({ 区分: "B", スコア: "60" }),
      makeRecord({ 区分: "A", スコア: "70" }),
    ],
  });

  // WHERE スコア > CASE WHEN 区分 = 'A' THEN 80 ELSE 50 END
  // 区分A→閾値80: 90 > 80 ✓, 70 > 80 ✗
  // 区分B→閾値50: 60 > 50 ✓
  const result = await execute(
    "SELECT * FROM APP100 WHERE スコア > CASE WHEN 区分 = 'A' THEN 80 ELSE 50 END",
    client
  ) as SelectResult;

  expect(result.rowCount).toBe(2);
});

test("CASE WHEN WHERE フィルタ — ELSE なし: マッチしない行は ELSE 相当が空文字", async () => {
  const client = makeClient({
    records: [
      makeRecord({ 区分: "X", 名前: "山田" }),
      makeRecord({ 区分: "A", 名前: "田中" }),
    ],
  });

  // CASE WHEN 区分 = 'A' THEN 区分 END = 'A'
  // 区分Aの行: THEN 区分 → 'A' = 'A' ✓
  // 区分Xの行: ELSE なし → '' = 'A' ✗
  const result = await execute(
    "SELECT 名前 FROM APP100 WHERE CASE WHEN 区分 = 'A' THEN 区分 END = 'A'",
    client
  ) as SelectResult;

  expect(result.rowCount).toBe(1);
  expect(result.rows[0]["名前"]).toBe("田中");
});

test("UPDATE SET CASE WHEN — 区分に応じて金額を更新", async () => {
  const records = [
    makeRecord({ $id: "1", 区分: "特別", 金額: "1000" }),
    makeRecord({ $id: "2", 区分: "通常", 金額: "1000" }),
  ];
  const client = makeClient({ records });

  await execute(
    "UPDATE APP100 SET 金額 = CASE WHEN 区分 = '特別' THEN 500 ELSE 1200 END WHERE $id > 0",
    client
  );

  expect(client.putCalls).toHaveLength(1);
  const batch = client.putCalls[0].records;
  const rec1 = batch.find((r) => r.id === 1)!;
  const rec2 = batch.find((r) => r.id === 2)!;
  expect(rec1.record["金額"].value).toBe("500");
  expect(rec2.record["金額"].value).toBe("1200");
});

test("UPDATE SET CASE WHEN — 複数フィールドを混在更新（ARITH と CASE）", async () => {
  const records = [
    makeRecord({ $id: "1", 区分: "A", 単価: "100", 数量: "3" }),
  ];
  const client = makeClient({ records, fieldTypes: { 合計: "NUMBER", ランク: "SINGLE_LINE_TEXT" } });

  // SET 合計 = 単価 * 数量, ランク = CASE WHEN 区分 = 'A' THEN '上位' ELSE '下位' END
  await execute(
    "UPDATE APP100 SET 合計 = 単価 * 数量, ランク = CASE WHEN 区分 = 'A' THEN '上位' ELSE '下位' END WHERE $id = 1",
    client
  );

  expect(client.putCalls).toHaveLength(1);
  const batch = client.putCalls[0].records;
  expect(batch[0].record["合計"].value).toBe("300");
  expect(batch[0].record["ランク"].value).toBe("上位");
});

// ----------------------------------------------------------------
// UPDATE SET スカラーサブクエリ
// ----------------------------------------------------------------

test("UPDATE SET スカラーサブクエリ — サブクエリの値で全件 PUT", async () => {
  // GET 1回目: MAX(合計費用) のサブクエリ → 5000 を返す
  // GET 2回目: UPDATE 対象の $id 取得
  const subqueryRecords = [makeRecord({ 合計費用: "5000" })];
  const updateRecords   = [makeRecord({ $id: "1" }), makeRecord({ $id: "2" })];
  let getCallCount = 0;
  const client = makeClient({ fieldTypes: { 合計費用: "NUMBER", 上限費用: "NUMBER", 確度: "DROP_DOWN" } });
  (client as KintoneClient & { getRecords: KintoneClient["getRecords"] }).getRecords = async () => {
    getCallCount++;
    if (getCallCount === 1) return { records: subqueryRecords }; // SELECT MAX(合計費用)
    return { records: updateRecords };                            // UPDATE 対象 $id
  };

  const result = await execute(
    "UPDATE APP88 SET 上限費用 = (SELECT MAX(合計費用) FROM APP88) WHERE 確度 in ('80%', '100%')",
    client
  ) as UpdateResult;

  expect(result.updatedCount).toBe(2);
  expect(client.putCalls).toHaveLength(1);
  // 解決済みの値 '5000' がそのまま SET される
  expect(client.putCalls[0].records[0].record["上限費用"].value).toBe("5000");
  expect(client.putCalls[0].records[1].record["上限費用"].value).toBe("5000");
});

test("UPDATE SET スカラーサブクエリ — 非集計で 0 行返す場合はエラー", async () => {
  // v1.12.0: 集計サブクエリ（MAX 等）は 0 件でも 1 行（0）を返すため、
  // 0 行エラーが残るのは非集計プローブの空振りのみ
  const client = makeClient({ records: [], fieldTypes: { 合計費用: "NUMBER", 上限費用: "NUMBER", 確度: "DROP_DOWN" } }); // サブクエリが 0 件
  await expect(
    execute(
      "UPDATE APP88 SET 上限費用 = (SELECT 合計費用 FROM APP88) WHERE 確度 in ('80%')",
      client
    )
  ).rejects.toThrow("値を返しませんでした");
});

test("UPDATE SET スカラーサブクエリ — 0 件集計は 0 に解決される（v1.12.0）", async () => {
  // GET 1回目: MAX(合計費用) のサブクエリ → 0 件 → 0 に解決
  // GET 2回目: UPDATE 対象の $id 取得
  const updateRecords = [makeRecord({ $id: "1" })];
  let getCallCount = 0;
  const client = makeClient({ fieldTypes: { 合計費用: "NUMBER", 上限費用: "NUMBER", 確度: "DROP_DOWN" } });
  (client as KintoneClient & { getRecords: KintoneClient["getRecords"] }).getRecords = async () => {
    getCallCount++;
    if (getCallCount === 1) return { records: [] }; // SELECT MAX(合計費用) — 0 件
    return { records: updateRecords };
  };

  await execute(
    "UPDATE APP88 SET 上限費用 = (SELECT MAX(合計費用) FROM APP88) WHERE 確度 in ('80%')",
    client
  ) as UpdateResult;

  expect(client.putCalls).toHaveLength(1);
  expect(client.putCalls[0].records[0].record["上限費用"].value).toBe("0");
});

test("UPDATE SET スカラーサブクエリ — 通常 SET との混在", async () => {
  const subqueryRecords = [makeRecord({ 合計費用: "9999" })];
  const updateRecords   = [makeRecord({ $id: "10" })];
  let getCallCount = 0;
  const client = makeClient({ fieldTypes: { 合計費用: "NUMBER", 上限費用: "NUMBER", 確度: "DROP_DOWN", ステータス: "SINGLE_LINE_TEXT" } });
  (client as KintoneClient & { getRecords: KintoneClient["getRecords"] }).getRecords = async () => {
    getCallCount++;
    if (getCallCount === 1) return { records: subqueryRecords };
    return { records: updateRecords };
  };

  await execute(
    "UPDATE APP88 SET ステータス = '完了', 上限費用 = (SELECT MAX(合計費用) FROM APP88) WHERE 確度 in ('80%')",
    client
  ) as UpdateResult;

  const record = client.putCalls[0].records[0].record;
  expect(record["ステータス"].value).toBe("完了");
  expect(record["上限費用"].value).toBe("9999");
});

// ----------------------------------------------------------------
// 0 件集計サブクエリ — GROUP BY なし集計は常に 1 行を返す（v1.12.0）
// ----------------------------------------------------------------

test("WHERE スカラーサブクエリ — 0 件集計は 0 として比較される", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [
        makeRecord({ $id: "1", 名前: "田中", 金額: "100" }),
        makeRecord({ $id: "2", 名前: "鈴木", 金額: "0" }),
      ],
      300: [], // 空アプリ
    },
  });
  // サブクエリ入り WHERE は FULL_SCAN → JS 評価。金額 > 0 の行のみ残る
  const result = await execute(
    "SELECT 名前 FROM APP100 WHERE 金額 > (SELECT COUNT(*) FROM APP300)",
    client
  ) as SelectResult;
  expect(result.rowCount).toBe(1);
  expect(result.rows[0]["名前"]).toBe("田中");
});

test("SELECT 列スカラーサブクエリ — 0 件集計は 0 が出力される", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [makeRecord({ $id: "1", 名前: "田中" })],
      300: [],
    },
  });
  const result = await execute(
    "SELECT 名前, (SELECT COUNT(*) FROM APP300) AS 件数 FROM APP100",
    client
  ) as SelectResult;
  expect(result.rowCount).toBe(1);
  expect(result.rows[0]["件数"]).toBe("0");
});

test("IN サブクエリ — 0 件集計は {0} との照合になる（旧: 空集合）", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [
        makeRecord({ $id: "1", 名前: "田中", 金額: "100" }),
        makeRecord({ $id: "2", 名前: "鈴木", 金額: "0" }),
      ],
      300: [],
    },
  });
  const result = await execute(
    "SELECT 名前 FROM APP100 WHERE 金額 IN (SELECT COUNT(*) FROM APP300)",
    client
  ) as SelectResult;
  expect(result.rowCount).toBe(1); // 金額 "0" のみ一致（v1.11.0 では空集合 → 0 行）
  expect(result.rows[0]["名前"]).toBe("鈴木");
});

test("EXISTS サブクエリ — 0 件集計は常に真になる（v1.11.0 の false から反転）", async () => {
  // 標準 SQL でも EXISTS(SELECT COUNT(*)...) は常に真（集計が 1 行返すため）
  const client = makeClient({
    recordsByApp: {
      100: [makeRecord({ $id: "1", 名前: "田中" })],
      300: [],
    },
  });
  const result = await execute(
    "SELECT 名前 FROM APP100 WHERE EXISTS (SELECT COUNT(*) FROM APP300)",
    client
  ) as SelectResult;
  expect(result.rowCount).toBe(1);
});

test("INSERT INTO ... SELECT COUNT(*) — 0 件でも 1 行書き込まれる（旧: 列数 0 エラー）", async () => {
  const client = makeClient({
    recordsByApp: { 300: [] },
    postIds: ["1"],
    fieldTypes: { 件数: "NUMBER" },
  });
  // confirm / dmlMaxRows の件数判定に 1 行として乗ることも固定する
  // （dmlMaxRows は上位層が confirm を構成する仕組みのため、件数伝播の検証で足りる）
  let confirmedCount = -1;
  let confirmedOp = "";
  const result = await execute(
    "INSERT INTO APP200 (件数) SELECT COUNT(*) FROM APP300",
    client,
    {
      confirm: async (count, op) => {
        confirmedCount = count;
        confirmedOp = op;
        return true;
      },
    }
  ) as InsertResult;
  expect(confirmedCount).toBe(1);
  expect(confirmedOp).toBe("INSERT");
  expect(result.insertedCount).toBe(1);
  expect(client.postCalls).toHaveLength(1);
  expect(client.postCalls[0].records[0]["件数"].value).toBe("0");
});

// ----------------------------------------------------------------
// エラー
// ----------------------------------------------------------------

test("構文エラーは ParseError として伝播する", async () => {
  const client = makeClient();
  const { ParseError } = await import("../parser/parser");
  await expect(execute("SELECT FROM", client)).rejects.toThrow(ParseError);
});

test("未知の文字は LexError として伝播する", async () => {
  const client = makeClient();
  const { LexError } = await import("../lexer/lexer");
  await expect(execute("^invalid", client)).rejects.toThrow(LexError);
});

test("DELETE WHERE なしは ParseError", async () => {
  const client = makeClient();
  const { ParseError } = await import("../parser/parser");
  await expect(execute("DELETE FROM APP100", client)).rejects.toThrow(ParseError);
});

// ----------------------------------------------------------------
// metrics（API 呼び出し計測）
// ----------------------------------------------------------------

test("metrics: SIMPLE SELECT は getCalls=1 / fetchedRows=取得件数", async () => {
  const records = [
    makeRecord({ 名前: "田中" }),
    makeRecord({ 名前: "鈴木" }),
  ];
  const client = makeClient({ records });
  const result = await execute("SELECT * FROM APP77001", client) as SelectResult;

  expect(result.metrics).toBeDefined();
  expect(result.metrics!.getCalls).toBe(1);
  expect(result.metrics!.fetchedRows).toBe(2);
  expect(result.metrics!.postCalls).toBe(0);
  expect(result.metrics!.putCalls).toBe(0);
  expect(result.metrics!.deleteCalls).toBe(0);
  expect(result.metrics!.appsCalls).toBe(0);
  expect(result.metrics!.elapsedMs).toBeGreaterThanOrEqual(0);
});

test("metrics: フィールド定義取得はキャッシュ込みで実呼び出し回数を数える", async () => {
  const records = [makeRecord({ $id: "1", 名前: "田中" })];
  const client = makeClient({ records });
  // 検証 + 選択肢順 + ソート種別で getFieldsCached が複数回呼ばれるが、
  // 同一アプリはキャッシュされるため実 API 呼び出しは 1 回
  const result = await execute("SELECT 名前 FROM APP77002", client) as SelectResult;

  expect(result.metrics!.fieldCalls).toBe(1);
});

test("MIN / MAX: 物理テキスト列は辞書順、NUMBER 列は従来の数値順で集約する", async () => {
  const client = makeClient({
    records: [makeRecord({ text: "9", amount: "9" }), makeRecord({ text: "10", amount: "10" })],
  });
  client.getFields = async () => [
    { code: "text", label: "text", fieldType: "SINGLE_LINE_TEXT" },
    { code: "amount", label: "amount", fieldType: "NUMBER" },
  ];
  const result = await execute(
    "SELECT MIN(text) AS textMin, MAX(text) AS textMax, MIN(amount) AS numberMin, MAX(amount) AS numberMax FROM APP77005",
    client,
    { cacheContext: "aggregate-sort-physical" }
  ) as SelectResult;

  expect(result.rows[0]).toMatchObject({ textmin: "10", textmax: "9", numbermin: "9", numbermax: "10" });
  expect(result.metrics!.fieldCalls).toBe(1);
});

test("MIN / MAX: フォーム定義は既存 cacheContext キャッシュを共有する", async () => {
  const client = makeClient({ records: [makeRecord({ text: "B" }), makeRecord({ text: "A" })] });
  client.getFields = async () => [
    { code: "text", label: "text", fieldType: "MULTI_LINE_TEXT" },
  ];
  const options = { cacheContext: "aggregate-sort-cache" };
  const first = await execute("SELECT MIN(text) AS value FROM APP77006", client, options) as SelectResult;
  const second = await execute("SELECT MAX(text) AS value FROM APP77006", client, options) as SelectResult;

  expect(first.rows[0].value).toBe("A");
  expect(second.rows[0].value).toBe("B");
  expect(first.metrics!.fieldCalls).toBe(1);
  expect(second.metrics!.fieldCalls).toBe(0);
});

test("MIN / MAX: CALC は sortKind を一次判定に使う", async () => {
  const client = makeClient({
    records: [makeRecord({ calcText: "9", calcNumber: "9" }), makeRecord({ calcText: "10", calcNumber: "10" })],
  });
  client.getFields = async () => [
    { code: "calcText", label: "calcText", fieldType: "CALC", sortKind: "string" },
    { code: "calcNumber", label: "calcNumber", fieldType: "CALC", sortKind: "number" },
  ];
  const result = await execute(
    "SELECT MIN(calcText) AS textMin, MIN(calcNumber) AS numberMin FROM APP77007",
    client,
    { cacheContext: "aggregate-sort-calc" }
  ) as SelectResult;

  expect(result.rows[0]).toMatchObject({ textmin: "10", numbermin: "9" });
});

test("MIN / MAX: 日時・RICH_TEXT は文字列、CREATOR は型不明の従来経路になる", async () => {
  const client = makeClient({
    records: [
      makeRecord({ 日付: "2026-07-16", 更新日時: "2026-07-16T02:00:00Z", リッチ: "B", 作成者: "B" }),
      makeRecord({ 日付: "2025-12-31", 更新日時: "2026-07-16T01:00:00Z", リッチ: "A", 作成者: "A" }),
    ],
  });
  client.getFields = async () => [
    { code: "日付", label: "日付", fieldType: "DATE" },
    { code: "更新日時", label: "更新日時", fieldType: "UPDATED_TIME" },
    { code: "リッチ", label: "リッチ", fieldType: "RICH_TEXT" },
    { code: "作成者", label: "作成者", fieldType: "CREATOR" },
  ];
  const result = await execute(
    "SELECT MIN(日付) AS oldest, MAX(更新日時) AS latest, MIN(リッチ) AS richmin, MIN(作成者) AS unsupported FROM APP77010",
    client,
    { cacheContext: "aggregate-sort-field-types" }
  ) as SelectResult;

  expect(result.rows[0]).toMatchObject({
    oldest: "2025-12-31",
    latest: "2026-07-16T02:00:00Z",
    richmin: "A",
    unsupported: "A",
  });
});

test("MIN / MAX: JOIN の修飾フィールドを各物理アプリの型へ解決する", async () => {
  const client = makeClient({
    recordsByApp: {
      77008: [makeRecord({ key: "1", value: "9" }), makeRecord({ key: "2", value: "10" })],
      77009: [makeRecord({ key: "1", amount: "9" }), makeRecord({ key: "2", amount: "10" })],
    },
  });
  client.getFields = async (appId) => appId === 77008
    ? [
        { code: "key", label: "key", fieldType: "SINGLE_LINE_TEXT" },
        { code: "value", label: "value", fieldType: "SINGLE_LINE_TEXT" },
      ]
    : [
        { code: "key", label: "key", fieldType: "SINGLE_LINE_TEXT" },
        { code: "amount", label: "amount", fieldType: "NUMBER" },
      ];
  const result = await execute(
    "SELECT MIN(a.value) AS textMin, MIN(b.amount) AS numberMin FROM APP77008 a JOIN APP77009 b ON a.key = b.key",
    client,
    { cacheContext: "aggregate-sort-join" }
  ) as SelectResult;

  expect(result.rows[0]).toMatchObject({ textmin: "10", numbermin: "9" });
  expect(result.metrics!.fieldCalls).toBe(2);
});

test("MIN / MAX: JOIN 非修飾名は一意なら型解決し、同名競合なら従来経路へ戻す", async () => {
  const client = makeClient({
    recordsByApp: {
      77011: [makeRecord({ key: "1", uniqueText: "9", shared: "9" }), makeRecord({ key: "2", uniqueText: "10", shared: "10" })],
      77012: [makeRecord({ key: "1", shared: "B" }), makeRecord({ key: "2", shared: "A" })],
    },
  });
  client.getFields = async (appId) => appId === 77011
    ? [
        { code: "key", label: "key", fieldType: "SINGLE_LINE_TEXT" },
        { code: "uniqueText", label: "uniqueText", fieldType: "SINGLE_LINE_TEXT" },
        { code: "shared", label: "shared", fieldType: "SINGLE_LINE_TEXT" },
      ]
    : [
        { code: "key", label: "key", fieldType: "SINGLE_LINE_TEXT" },
        { code: "shared", label: "shared", fieldType: "SINGLE_LINE_TEXT" },
      ];
  const result = await execute(
    "SELECT MIN(uniqueText) AS uniqueMin, MIN(shared) AS collision FROM APP77011 a JOIN APP77012 b ON a.key = b.key",
    client,
    { cacheContext: "aggregate-sort-unqualified-join" }
  ) as SelectResult;

  expect(result.rows[0]).toMatchObject({ uniquemin: "10", collision: "A" });
});

test("metrics: INSERT は postCalls を数える", async () => {
  const client = makeClient({ postIds: ["1"], fieldTypes: { 名前: "SINGLE_LINE_TEXT" } });
  const result = await execute(
    "INSERT INTO APP77003 (名前) VALUES ('田中')",
    client
  ) as InsertResult;

  expect(result.metrics!.postCalls).toBe(1);
  expect(result.metrics!.getCalls).toBe(0);
});

test("metrics: UPDATE は getCalls（$id 取得）と putCalls を数える", async () => {
  const records = [makeRecord({ $id: "10" })];
  const client = makeClient({ records, fieldTypes: { ステータス: "SINGLE_LINE_TEXT" } });
  const result = await execute(
    "UPDATE APP77004 SET ステータス = '完了' WHERE $id = 10",
    client
  ) as UpdateResult;

  expect(result.metrics!.getCalls).toBe(1);
  expect(result.metrics!.putCalls).toBe(1);
});

test("metrics: SHOW APPS は appsCalls を数える", async () => {
  const client = makeClient();
  const result = await execute("SHOW APPS", client) as SelectResult;

  expect(result.metrics!.appsCalls).toBe(1);
  expect(result.metrics!.getCalls).toBe(0);
});

// ----------------------------------------------------------------
// UPSERT — 既存判定の挙動固定
// ----------------------------------------------------------------

test("UPSERT: キーが複数レコードにヒットした場合は最大 $id（最新）を更新する", async () => {
  const records = [
    makeRecord({ $id: "5", 顧客名: "X" }),
    makeRecord({ $id: "9", 顧客名: "X" }),
    makeRecord({ $id: "7", 顧客名: "X" }),
  ];
  const client = makeClient({ records, fieldTypes: { ランク: "SINGLE_LINE_TEXT" } });
  await execute(
    "UPSERT INTO APP77010 (顧客名, ランク) VALUES ('X', 'A') ON DUPLICATE (顧客名)",
    client
  );

  expect(client.putCalls).toHaveLength(1);
  expect(client.putCalls[0].records[0].id).toBe(9);
  expect(client.postCalls).toHaveLength(0);
});

test("UPSERT: キーがヒットしない場合は INSERT する", async () => {
  const client = makeClient({ records: [], postIds: ["1"], fieldTypes: { 顧客名: "SINGLE_LINE_TEXT", ランク: "SINGLE_LINE_TEXT" } });
  await execute(
    "UPSERT INTO APP77011 (顧客名, ランク) VALUES ('Y', 'B') ON DUPLICATE (顧客名)",
    client
  );

  expect(client.postCalls).toHaveLength(1);
  expect(client.putCalls).toHaveLength(0);
});

// ----------------------------------------------------------------
// スカラーサブクエリ列 — 重複排除
// ----------------------------------------------------------------

test("SELECT 列の同一スカラーサブクエリは 1 回だけ実行される", async () => {
  const client = makeClient({
    recordsByApp: {
      77020: [makeRecord({ $id: "1", 名前: "田中" })],
      77021: [makeRecord({ 金額: "9999" })],
    },
  });
  const result = await execute(
    "SELECT 名前, (SELECT MAX(金額) FROM APP77021) AS a, (SELECT MAX(金額) FROM APP77021) AS b FROM APP77020",
    client
  ) as SelectResult;

  expect(result.rows[0]["a"]).toBe("9999");
  expect(result.rows[0]["b"]).toBe("9999");
  const subqueryCalls = client.getCalls.filter((c) => c.app === 77021);
  expect(subqueryCalls).toHaveLength(1);
});

test("UPSERT: 既存判定はキーを 50 件ずつの in (...) チャンクでまとめて検索する", async () => {
  const client = makeClient({ records: [], postIds: ["1"], fieldTypes: { 顧客コード: "SINGLE_LINE_TEXT", ランク: "SINGLE_LINE_TEXT" } });
  const values = Array.from({ length: 120 }, (_, i) => `('K${i}', 'v')`).join(", ");
  await execute(
    `UPSERT INTO APP77012 (顧客コード, ランク) VALUES ${values} ON DUPLICATE (顧客コード)`,
    client
  );

  // 120 ユニークキー → 50 件チャンク × 3 回の GET
  expect(client.getCalls).toHaveLength(3);
  expect(client.getCalls[0].query).toContain("顧客コード in (");
  expect(client.getCalls[0].fields).toEqual(["$id", "顧客コード"]);
  // 全行 INSERT → 100 件バッチ × 2 回
  expect(client.postCalls).toHaveLength(2);
});

test("UPSERT: 複合キーは第 1 キーで検索し残りキーをクライアント側で照合する", async () => {
  const records = [
    makeRecord({ $id: "1", k1: "A", k2: "1" }),
    makeRecord({ $id: "2", k1: "A", k2: "2" }),
  ];
  const client = makeClient({ records, postIds: ["9"], fieldTypes: { v: "SINGLE_LINE_TEXT" } });
  await execute(
    "UPSERT INTO APP77013 (k1, k2, v) VALUES ('A', '2', 'x'), ('A', '3', 'y') ON DUPLICATE (k1, k2)",
    client
  );

  // (A,2) → $id=2 の UPDATE、(A,3) → INSERT
  expect(client.putCalls).toHaveLength(1);
  expect(client.putCalls[0].records[0].id).toBe(2);
  expect(client.postCalls).toHaveLength(1);
});

test("UPSERT: 空文字キーは in にまとめず行ごとに検索する（従来挙動）", async () => {
  const client = makeClient({ records: [], postIds: ["1"], fieldTypes: { 顧客コード: "SINGLE_LINE_TEXT", ランク: "SINGLE_LINE_TEXT" } });
  await execute(
    "UPSERT INTO APP77014 (顧客コード, ランク) VALUES ('', 'v') ON DUPLICATE (顧客コード)",
    client
  );

  expect(client.getCalls).toHaveLength(1);
  expect(client.getCalls[0].query).toContain('顧客コード = ""');
  expect(client.getCalls[0].query).not.toContain("in (");
});

test("UPSERT SELECT: 既存判定が一括検索になる", async () => {
  const client = makeClient({
    recordsByApp: {
      77031: [
        makeRecord({ $id: "1", 顧客名: "X" }),
        makeRecord({ $id: "2", 顧客名: "Y" }),
      ],
      77030: [makeRecord({ $id: "3", 顧客名: "X" })],
    },
    postIds: ["9"],
  });
  await execute(
    "UPSERT INTO APP77030 (顧客名) SELECT 顧客名 FROM APP77031 ON DUPLICATE (顧客名)",
    client
  );

  // 転送先アプリへの既存判定 GET は 1 回だけ
  const destGets = client.getCalls.filter((c) => c.app === 77030);
  expect(destGets).toHaveLength(1);
  expect(destGets[0].query).toContain("顧客名 in (");
  // X → UPDATE($id=3)、Y → INSERT
  expect(client.putCalls).toHaveLength(1);
  expect(client.putCalls[0].records[0].id).toBe(3);
  expect(client.postCalls).toHaveLength(1);
});

test("UPSERT: テキストキーは数値正規化しない（'001' と '1' を区別する）", async () => {
  const client = makeClient({
    records: [makeRecord({ $id: "1", 顧客コード: "1" })],
    postIds: ["9"],
  });
  client.getFields = async () => ([
    { code: "顧客コード", label: "顧客コード", fieldType: "SINGLE_LINE_TEXT" },
    { code: "ランク", label: "ランク", fieldType: "SINGLE_LINE_TEXT" },
  ]);
  await execute(
    "UPSERT INTO APP77015 (顧客コード, ランク) VALUES ('001', 'A'), ('1', 'B') ON DUPLICATE (顧客コード)",
    client,
    { cacheContext: "upsert-text-key-test" }
  );

  // '1' → 既存 $id=1 を UPDATE、'001' → 別キーとして INSERT
  expect(client.putCalls).toHaveLength(1);
  expect(client.putCalls[0].records[0].id).toBe(1);
  expect(client.postCalls).toHaveLength(1);
});

test("UPSERT: NUMBER キーは表記ゆれ（'5.0' と '5'）を同一視する", async () => {
  const client = makeClient({
    records: [makeRecord({ $id: "7", 商品番号: "5.0" })],
    postIds: ["9"],
  });
  client.getFields = async () => ([
    { code: "商品番号", label: "商品番号", fieldType: "NUMBER" },
    { code: "ランク", label: "ランク", fieldType: "SINGLE_LINE_TEXT" },
  ]);
  await execute(
    "UPSERT INTO APP77016 (商品番号, ランク) VALUES (5, 'A') ON DUPLICATE (商品番号)",
    client,
    { cacheContext: "upsert-number-key-test" }
  );

  expect(client.putCalls).toHaveLength(1);
  expect(client.putCalls[0].records[0].id).toBe(7);
  expect(client.postCalls).toHaveLength(0);
});

test("UPSERT VALUESは2^53境界キーを区別しraw payloadを保持する", async () => {
  const client = makeClient({
    records: [makeRecord({ $id: "7", 商品番号: "9007199254740992" })],
    postIds: ["9"],
  });
  client.getFields = async () => ([
    { code: "商品番号", label: "商品番号", fieldType: "NUMBER" },
    { code: "ランク", label: "ランク", fieldType: "SINGLE_LINE_TEXT" },
  ]);
  await execute(
    "UPSERT INTO APP77016 (商品番号, ランク) VALUES (9007199254740993, 'A') ON DUPLICATE (商品番号)",
    client,
    { cacheContext: "upsert-exact-number-key" }
  );
  expect(client.putCalls).toHaveLength(0);
  expect(client.postCalls[0].records[0]["商品番号"].value).toBe("9007199254740993");
});

test("UPSERT SELECT: 複合キーの値に区切り文字（\\u0000）を含んでも誤同一視しない", async () => {
  const client = makeClient({
    recordsByApp: {
      77033: [makeRecord({ $id: "1", k1: "a", k2: "b\u0000c" })],
      77032: [makeRecord({ $id: "5", k1: "a\u0000b", k2: "c" })],
    },
    postIds: ["9"],
  });
  await execute(
    "UPSERT INTO APP77032 (k1, k2) SELECT k1, k2 FROM APP77033 ON DUPLICATE (k1, k2)",
    client
  );

  // ("a", "b\u0000c") と既存 ("a\u0000b", "c") は別キー → INSERT になる
  expect(client.putCalls).toHaveLength(0);
  expect(client.postCalls).toHaveLength(1);
});

// ----------------------------------------------------------------
// サブクエリ / UNION の並列実行
// ----------------------------------------------------------------

function makeConcurrencyClient(recordsByApp: Record<number, KintoneRecord[]>): KintoneClient & { maxActive: () => number } {
  let active = 0;
  let max = 0;
  return {
    async getRecords(params) {
      active += 1;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 10));
      active -= 1;
      return { records: recordsByApp[params.app] ?? [] };
    },
    async openCursor() { throw new Error("unexpected cursor call"); },
    async postRecords() { return { ids: [] }; },
    async putRecords() { /* noop */ },
    async deleteRecords() { /* noop */ },
    async getApps() { return []; },
    async getFields(appId) {
      const codes = new Set((recordsByApp[appId] ?? []).flatMap((record) => Object.keys(record)));
      return [...codes].filter((code) => !code.startsWith("$"))
        .map((code) => ({ code, label: code, fieldType: "SINGLE_LINE_TEXT" }));
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() { return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const }; },
    maxActive: () => max,
  };
}

test("WHERE の複数サブクエリは並列に実行される", async () => {
  const client = makeConcurrencyClient({
    77041: [makeRecord({ $id: "1", a: "1", b: "1" })],
    77042: [makeRecord({ a: "1" })],
    77043: [makeRecord({ b: "1" })],
  });
  await execute(
    "SELECT * FROM APP77041 WHERE a in (SELECT a FROM APP77042) or b in (SELECT b FROM APP77043)",
    client
  );
  expect(client.maxActive()).toBeGreaterThanOrEqual(2);
});

test("UNION ALL の左辺と右辺は並列に実行される", async () => {
  const client = makeConcurrencyClient({
    77044: [makeRecord({ x: "1" })],
    77045: [makeRecord({ x: "2" })],
  });
  const result = await execute(
    "SELECT x FROM APP77044 UNION ALL SELECT x FROM APP77045",
    client
  ) as SelectResult;
  expect(result.rowCount).toBe(2);
  expect(result.rows.map((r) => r["x"])).toEqual(["1", "2"]);
  expect(client.maxActive()).toBeGreaterThanOrEqual(2);
});

// ----------------------------------------------------------------
// ORDER BY なし時のフィールド定義取得スキップ
// ----------------------------------------------------------------

test("SIMPLE SELECT: ORDER BY なしならフィールド定義を取得しない", async () => {
  const records = [makeRecord({ $id: "1", 名前: "田中" })];
  const client = makeClient({ records });
  const result = await execute("SELECT * FROM APP77060", client) as SelectResult;

  expect(result.metrics!.fieldCalls).toBe(0);
});

test("FULL_SCAN SELECT: ORDER BY なしならフィールド定義を取得しない", async () => {
  const records = [makeRecord({ $id: "1", 種別: "A" })];
  const client = makeClient({ records });
  const result = await execute("SELECT COUNT(*) AS c FROM APP77061", client) as SelectResult;

  expect(result.rows[0]["c"]).toBe("1");
  expect(result.metrics!.fieldCalls).toBe(0);
});

test("SIMPLE SELECT: ORDER BY ありならフィールド定義を取得する（従来動作）", async () => {
  const records = [makeRecord({ $id: "1", 名前: "田中" })];
  const client = makeClient({ records });
  const result = await execute("SELECT * FROM APP77062 ORDER BY 名前", client) as SelectResult;

  expect(result.metrics!.fieldCalls).toBe(1);
});

// ----------------------------------------------------------------
// 一時テーブル（バッチスコープ）: 単文実行では拒否
// ----------------------------------------------------------------

test("単文の CREATE TEMP TABLE は ArgumentError", async () => {
  const client = makeClient();
  await expect(
    execute("CREATE TEMP TABLE #t AS SELECT * FROM APP100", client)
  ).rejects.toThrow(/CREATE TEMP TABLE requires a batch/);
});

test("単文の DROP TEMP TABLE は ArgumentError", async () => {
  const client = makeClient();
  await expect(
    execute("DROP TEMP TABLE #t", client)
  ).rejects.toThrow(/DROP TEMP TABLE requires a batch/);
});

test("単文実行の FROM #t は APP0 に到達せず拒否される", async () => {
  const client = makeClient();
  await expect(
    execute("SELECT * FROM #t", client)
  ).rejects.toThrow(/temp table #t is not defined in this batch/);
  expect(client.getCalls).toHaveLength(0);
});

// ----------------------------------------------------------------
// HAVING × 集計列 alias（v1.4.0 実機検証で発見した既存バグの回帰テスト）
// 集計列に alias を付けると HAVING の合成名参照（SUM(売上) 等）が
// 解決できず常に偽になっていた
// ----------------------------------------------------------------

test("HAVING: 集計列に alias があっても SUM(field) 参照が解決される", async () => {
  const records = [
    makeRecord({ $id: "1", 商談フェーズ: "受注", 売上: "40800000" }),
    makeRecord({ $id: "2", 商談フェーズ: "受注", 売上: "0" }),
    makeRecord({ $id: "3", 商談フェーズ: "提案中", 売上: "28250000" }),
    makeRecord({ $id: "4", 商談フェーズ: "内示", 売上: "12750000" }),
  ];
  const client = makeClient({ records });
  const result = await execute(
    "SELECT 商談フェーズ, COUNT(*) AS 件数, SUM(売上) AS 売上合計 FROM APP77070 GROUP BY 商談フェーズ HAVING SUM(売上) > 0 ORDER BY 売上合計 DESC",
    client
  ) as SelectResult;

  expect(result.rowCount).toBe(3);
  expect(result.rows[0]["商談フェーズ"]).toBe("受注");
  expect(result.rows[0]["売上合計"]).toBe("40800000");
  // 合成名キー（SUM(売上)）が出力に漏れていないこと
  expect(result.columns).toEqual(["商談フェーズ", "件数", "売上合計"]);
  expect(Object.keys(result.rows[0])).not.toContain("SUM(売上)");
});

test("HAVING: alias 付き COUNT(*) の参照と閾値での絞り込み", async () => {
  const records = [
    makeRecord({ $id: "1", 商談フェーズ: "受注" }),
    makeRecord({ $id: "2", 商談フェーズ: "受注" }),
    makeRecord({ $id: "3", 商談フェーズ: "提案中" }),
  ];
  const client = makeClient({ records });
  const result = await execute(
    "SELECT 商談フェーズ, COUNT(*) AS 件数 FROM APP77071 GROUP BY 商談フェーズ HAVING COUNT(*) >= 2",
    client
  ) as SelectResult;

  expect(result.rowCount).toBe(1);
  expect(result.rows[0]["商談フェーズ"]).toBe("受注");
});

test("HAVING: alias なし集計（従来から動作していた形）の回帰確認", async () => {
  const records = [
    makeRecord({ $id: "1", 商談フェーズ: "受注", 売上: "100" }),
    makeRecord({ $id: "2", 商談フェーズ: "提案中", 売上: "0" }),
  ];
  const client = makeClient({ records });
  const result = await execute(
    "SELECT 商談フェーズ, SUM(売上) FROM APP77072 GROUP BY 商談フェーズ HAVING SUM(売上) > 0",
    client
  ) as SelectResult;

  expect(result.rowCount).toBe(1);
  expect(result.rows[0]["商談フェーズ"]).toBe("受注");
});
