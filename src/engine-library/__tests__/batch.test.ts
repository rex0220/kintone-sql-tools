import {
  KsqlEngineError,
  runBatch,
  type ReadonlyKintoneClient,
  type ReadonlyKintoneRecord,
} from "../index";
import { FetchAllLimitError } from "../../api/fetchAll";
import { AssertError, SearchAbortedError } from "../../execute";

const field = (value: unknown) => ({ value });

type TrackedClient = {
  readonly client: ReadonlyKintoneClient;
  readonly recordsApis: readonly jest.Mock[];
  readonly mutationApis: readonly jest.Mock[];
  readonly allApis: readonly jest.Mock[];
};

function trackedClient(
  overrides: Partial<ReadonlyKintoneClient> = {}
): TrackedClient {
  const getRecords = jest.fn(async () => ({ records: [] }));
  const openCursor = jest.fn(async () => ({
    totalCount: 0,
    nextPage: async () => ({ records: [], next: false }),
    close: async () => undefined,
  }));
  const getApps = jest.fn(async () => []);
  const getFields = jest.fn(async () => []);
  const getNumberPrecision = jest.fn(async () => ({
    digits: 30,
    decimalPlaces: 10,
    roundingMode: "HALF_EVEN" as const,
  }));
  const getProcessStatuses = jest.fn(async () => ({ enable: false, states: [] }));
  const postRecords = jest.fn(async () => {
    throw new Error("postRecords must not be called");
  });
  const putRecords = jest.fn(async () => {
    throw new Error("putRecords must not be called");
  });
  const deleteRecords = jest.fn(async () => {
    throw new Error("deleteRecords must not be called");
  });
  const client = {
    getRecords,
    openCursor,
    getApps,
    getFields,
    getNumberPrecision,
    getProcessStatuses,
    postRecords,
    putRecords,
    deleteRecords,
    ...overrides,
  } as ReadonlyKintoneClient;
  const recordsApis = [getRecords, openCursor];
  const mutationApis = [postRecords, putRecords, deleteRecords];
  return {
    client,
    recordsApis,
    mutationApis,
    allApis: [
      ...recordsApis,
      getApps,
      getFields,
      getNumberPrecision,
      getProcessStatuses,
      ...mutationApis,
    ],
  };
}

function expectNoApiCalls(tracked: TrackedClient): void {
  for (const api of tracked.allApis) expect(api).not.toHaveBeenCalled();
}

test("runBatch reuses QueryResult for temp-table SELECT and VALIDATE results", async () => {
  const sourceRecords: ReadonlyKintoneRecord[] = [
    { $id: field("1"), code: field("A") },
    { $id: field("2"), code: field("B") },
  ];
  const validationRecords: ReadonlyKintoneRecord[] = [
    { $id: field("9"), choice: field("invalid") },
  ];
  const getRecords = jest.fn(async ({ app }: { app: number }) => ({
    records: app === 6801 ? sourceRecords : app === 6802 ? validationRecords : [],
  }));
  const getFields = jest.fn(async (appId: number) => appId === 6802
    ? [{
      code: "choice",
      label: "choice",
      fieldType: "DROP_DOWN",
      optionOrder: { valid: 0 },
    }]
    : [{
      code: "code",
      label: "code",
      fieldType: "SINGLE_LINE_TEXT",
      optionOrder: {},
    }]);
  const tracked = trackedClient({ getRecords, getFields });

  const result = await runBatch(
    "CREATE TEMP TABLE #source AS SELECT code FROM APP6801; " +
      "SELECT code FROM #source ORDER BY code; " +
      "VALIDATE APP6802",
    { client: tracked.client, maxRecords: 1000 }
  );

  expect(result).toMatchObject({
    type: "batch",
    batch: true,
    statementCount: 3,
    warnings: [],
    statements: [
      {
        index: 0,
        type: "CREATE_TEMP_TABLE",
        status: "success",
        tempTable: "#source",
        rowCount: 2,
      },
      {
        index: 1,
        type: "SELECT",
        status: "success",
        resultIndex: 0,
      },
      {
        index: 2,
        type: "VALIDATE",
        status: "success",
        resultIndex: 1,
      },
    ],
  });
  expect(result.results).toHaveLength(2);
  expect(result.results[0]).toMatchObject({
    type: "query",
    rows: [{ code: "A" }, { code: "B" }],
    rowCount: 2,
  });
  expect(result.results[0]).not.toHaveProperty("validateStats");
  expect(result.results[1]).toMatchObject({
    type: "query",
    rowCount: 1,
    validateStats: { errorRecords: 1, errorCount: 1 },
  });
  expect(result.results[1].rows[0]).toMatchObject({
    $id: "9",
    $err_field: "choice",
    $err_code: "ERR_CHOICE_INVALID",
  });
  expect(getRecords).toHaveBeenCalled();
  expect(getFields).toHaveBeenCalledWith(6802);
  for (const api of tracked.mutationApis) expect(api).not.toHaveBeenCalled();
});

test.each([
  [
    "先頭 INSERT",
    "INSERT INTO APP1 (code) VALUES ('x'); SELECT code FROM APP2; SELECT code FROM APP3",
  ],
  [
    "中間 UPDATE",
    "SELECT code FROM APP2; UPDATE APP1 SET code='x' WHERE $id=1; SELECT code FROM APP3",
  ],
  [
    "末尾 DELETE",
    "SELECT code FROM APP2; SELECT code FROM APP3; DELETE FROM APP1 WHERE $id=1",
  ],
] as const)(
  "書き込み文を文単位で全実行前に拒否し records/mutation API 0: %s",
  async (_label, sql) => {
    const tracked = trackedClient();

    await expect(runBatch(sql, { client: tracked.client })).rejects.toMatchObject({
      code: "READ_ONLY_VIOLATION",
    });
    expectNoApiCalls(tracked);
  }
);

test.each([
  [
    "先頭",
    "UPDATE APP1 SET code='x' WHERE $id=1 APPLY Lines (REMOVE ALL ROWS) VALIDATE ONLY; " +
      "SELECT code FROM APP2; SELECT code FROM APP3",
  ],
  [
    "中間",
    "SELECT code FROM APP2; " +
      "UPDATE APP1 SET code='x' WHERE $id=1 APPLY Lines (REMOVE ALL ROWS) VALIDATE ONLY; " +
      "SELECT code FROM APP3",
  ],
  [
    "末尾",
    "SELECT code FROM APP2; SELECT code FROM APP3; " +
      "UPDATE APP1 SET code='x' WHERE $id=1 APPLY Lines (REMOVE ALL ROWS) VALIDATE ONLY",
  ],
] as const)(
  "APPLY VALIDATE ONLY をどの位置でも全実行前に拒否し API 0: %s",
  async (_label, sql) => {
    const tracked = trackedClient();

    await expect(runBatch(sql, { client: tracked.client })).rejects.toMatchObject({
      code: "READ_ONLY_VIOLATION",
      message: "APPLY statements are not allowed in engine library batches",
    });
    expectNoApiCalls(tracked);
  }
);

test.each([
  [
    "IMPORT",
    "SELECT code FROM APP2; IMPORT INTO APP1 (code) FROM CSV source",
    "IMPORT is disabled by default in engine library batches",
  ],
  [
    "DML VALIDATE ONLY",
    "SELECT code FROM APP2; INSERT INTO APP1 (code) VALUES ('x') VALIDATE ONLY",
    "DML VALIDATE ONLY statements are not supported by runBatch",
  ],
] as const)("%s remains fail-closed before every API call", async (_label, sql, message) => {
  const tracked = trackedClient();

  await expect(runBatch(sql, { client: tracked.client })).rejects.toMatchObject({
    code: "READ_ONLY_VIOLATION",
    message,
  });
  expectNoApiCalls(tracked);
});

test.each([
  ["先頭", "SELECT code FROM APP6900; SELECT code FROM APP6801; SELECT code FROM APP6802"],
  ["中間", "SELECT code FROM APP6801; SELECT code FROM APP6900; SELECT code FROM APP6802"],
  ["末尾", "SELECT code FROM APP6801; SELECT code FROM APP6802; SELECT code FROM APP6900"],
] as const)(
  "SEARCH_ABORTED はどの位置でも部分 BatchResult を返さず hard error: %s",
  async (_label, sql) => {
    const getRecords = jest.fn(async ({ app }: { app: number }) => ({
      records: [{ $id: field("1"), code: field("partial") }],
      ...(app === 6900 ? { searchAborted: true } : {}),
    }));
    const getFields = jest.fn(async () => [{
      code: "code",
      label: "code",
      fieldType: "DROP_DOWN",
      optionOrder: { partial: 0 },
    }]);
    const tracked = trackedClient({ getRecords, getFields });

    const rejection = runBatch(sql, { client: tracked.client });
    await expect(rejection).rejects.toMatchObject({
      name: "KsqlEngineError",
      code: "SEARCH_ABORTED",
      cause: expect.any(SearchAbortedError),
    });
    await expect(rejection).rejects.toBeInstanceOf(KsqlEngineError);
    for (const api of tracked.mutationApis) expect(api).not.toHaveBeenCalled();
  }
);

test("unknown runBatch options fail before API calls", async () => {
  const tracked = trackedClient();

  await expect(runBatch(
    "SELECT code FROM APP1",
    { client: tracked.client, surprise: true } as never
  )).rejects.toMatchObject({
    code: "EXECUTION_ERROR",
    message: "Unknown runBatch option: surprise",
  });
  expectNoApiCalls(tracked);
});

test("SET / DECLARE / ASSERT を read-only バッチで実行し variables は DECLARE だけを上書きする", async () => {
  const tracked = trackedClient();

  const result = await runBatch(
    "SET @fixed = 'engine'; " +
      "DECLARE @external = 'default'; " +
      "ASSERT @fixed = 'engine'; " +
      "ASSERT @external = 'injected'; " +
      "SELECT @fixed AS fixed, @external AS external",
    {
      client: tracked.client,
      variables: { ExTeRnAl: "injected" },
    }
  );

  expect(result.statements.map((statement) => statement.status))
    .toEqual(["success", "success", "success", "success", "success"]);
  expect(result.results).toHaveLength(1);
  expect(result.results[0].rows).toEqual([
    { fixed: "engine", external: "injected" },
  ]);
  expectNoApiCalls(tracked);

  await expect(runBatch(
    "SET @fixed = 'engine'; SELECT @fixed AS fixed",
    { client: tracked.client, variables: { fixed: "override" } }
  )).rejects.toMatchObject({
    code: "EXECUTION_ERROR",
    message: expect.stringMatching(/@fixed is not declared/),
  });
  expectNoApiCalls(tracked);
});

test.each([
  ["先頭", "ASSERT 1 = 2; SELECT 1 AS one; SELECT 2 AS two", ["error", "skipped", "skipped"]],
  ["中間", "SELECT 1 AS one; ASSERT 1 = 2; SELECT 2 AS two", ["success", "error", "skipped"]],
  ["末尾", "SELECT 1 AS one; SELECT 2 AS two; ASSERT 1 = 2", ["success", "success", "error"]],
] as const)(
  "ASSERT 失敗はどの位置でも throw し、成功済み文を含む部分結果を公開しない: %s",
  async (_label, sql, _statuses) => {
    const tracked = trackedClient();

    let failure: unknown;
    try {
      await runBatch(sql, { client: tracked.client });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(KsqlEngineError);
    expect(failure).toMatchObject({
      code: "EXECUTION_ERROR",
      cause: expect.any(AssertError),
      statementIndex: _label === "先頭" ? 0 : _label === "中間" ? 1 : 2,
      statementType: "ASSERT",
    });
    expect(failure).not.toHaveProperty("rows");
    expect(failure).not.toHaveProperty("results");
    expect(failure).not.toHaveProperty("statements");
    expectNoApiCalls(tracked);
  }
);

test.each([
  [
    "先頭",
    "CREATE TEMP TABLE #overflow AS SELECT code FROM APP6801; SELECT 1 AS one; SELECT 2 AS two",
    ["error", "skipped", "skipped"],
  ],
  [
    "中間",
    "SELECT 1 AS one; CREATE TEMP TABLE #overflow AS SELECT code FROM APP6801; SELECT 2 AS two",
    ["success", "error", "skipped"],
  ],
  [
    "末尾",
    "SELECT 1 AS one; SELECT 2 AS two; CREATE TEMP TABLE #overflow AS SELECT code FROM APP6801",
    ["success", "success", "error"],
  ],
] as const)(
  "tempTableMaxRows 超過は truncate 指定でもどの位置でも throw し、部分結果を公開しない: %s",
  async (_label, sql, _statuses) => {
    const getRecords = jest.fn(async () => ({
      records: [
        { $id: field("1"), code: field("A") },
        { $id: field("2"), code: field("B") },
      ],
    }));
    const tracked = trackedClient({ getRecords });

    let failure: unknown;
    try {
      await runBatch(sql, {
        client: tracked.client,
        tempTableMaxRows: 1,
        onLimitReached: "truncate",
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(KsqlEngineError);
    expect(failure).toMatchObject({
      code: "FETCH_LIMIT_EXCEEDED",
      cause: expect.any(FetchAllLimitError),
      statementIndex: _label === "先頭" ? 0 : _label === "中間" ? 1 : 2,
      statementType: "CREATE_TEMP_TABLE",
    });
    expect(failure).not.toHaveProperty("rows");
    expect(failure).not.toHaveProperty("results");
    expect(failure).not.toHaveProperty("statements");
    for (const api of tracked.mutationApis) expect(api).not.toHaveBeenCalled();
  }
);

test("文別クライアントエラーは code/cause identity と文診断だけを公開する", async () => {
  const cause = { code: "GAIA_TM01", message: "request timed out", status: 503 };
  const tracked = trackedClient({
    getRecords: jest.fn(async () => {
      throw cause;
    }),
  });

  let failure: unknown;
  try {
    await runBatch(
      "SELECT 1 AS before; SELECT code FROM APP6801; SELECT 2 AS after",
      { client: tracked.client }
    );
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(KsqlEngineError);
  expect(failure).toMatchObject({
    code: "CLIENT_ERROR",
    cause,
    statementIndex: 1,
    statementType: "SELECT",
  });
  expect((failure as KsqlEngineError).cause).toBe(cause);
  expect(failure).not.toHaveProperty("rows");
  expect(failure).not.toHaveProperty("results");
  expect(failure).not.toHaveProperty("statements");
});

test("一時テーブルは同時 16 表までで、DROP により空いた枠を再利用できる", async () => {
  const tracked = trackedClient();
  const creates = Array.from(
    { length: 16 },
    (_, index) => `CREATE TEMP TABLE #t${index} AS SELECT ${index} AS value`
  );

  const reusable = await runBatch(
    [...creates, "DROP TEMP TABLE #t0", "CREATE TEMP TABLE #t16 AS SELECT 16 AS value"].join("; "),
    { client: tracked.client }
  );
  expect(reusable.statementCount).toBe(18);
  expectNoApiCalls(tracked);

  await expect(runBatch(
    [...creates, "CREATE TEMP TABLE #t16 AS SELECT 16 AS value"].join("; "),
    { client: tracked.client }
  )).rejects.toMatchObject({
    code: "EXECUTION_ERROR",
    message: expect.stringMatching(/exceeds 16 temp tables/),
  });
  expectNoApiCalls(tracked);
});

test.each([
  [{ variables: null }, /variables must be an object/],
  [{ variables: { x: 1 } }, /variables\.x must be a string/],
  [{ tempTableMaxRows: 0 }, /tempTableMaxRows must be a positive safe integer/],
  [{ tempTableMaxRows: 1.5 }, /tempTableMaxRows must be a positive safe integer/],
] as const)("invalid Step 3 runBatch option fails before API calls: %p", async (extra, message) => {
  const tracked = trackedClient();

  await expect(runBatch(
    "SELECT 1 AS one",
    { client: tracked.client, ...extra } as never
  )).rejects.toMatchObject({
    code: "EXECUTION_ERROR",
    message: expect.stringMatching(message),
  });
  expectNoApiCalls(tracked);
});
