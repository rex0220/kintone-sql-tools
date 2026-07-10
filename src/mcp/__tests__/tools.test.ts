import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExecuteOptions, ExecuteResult, KintoneClient } from "../../core";
import type { CreateKsqlRuntimeInput, KsqlRuntime, KsqlRuntimeServerOptions } from "../../node/runtime";
import { createKsqlMcpTools } from "../tools";
import { explainInputSchema, mutateInputSchema, queryInputSchema } from "../schemas";

function makeClient(): KintoneClient {
  return {
    async getRecords() { return { records: [] }; },
    async postRecords() { return { ids: [] }; },
    async putRecords() { },
    async deleteRecords() { },
    async getApps() { return []; },
    async getFields() { return []; },
  };
}

describe("MCP tools", () => {
  const savedQueriesEnv = process.env.KSQL_SAVED_QUERIES;

  afterEach(() => {
    if (savedQueriesEnv === undefined) {
      delete process.env.KSQL_SAVED_QUERIES;
    } else {
      process.env.KSQL_SAVED_QUERIES = savedQueriesEnv;
    }
  });

  test("validate detects DML and normalizes APP@profile", async () => {
    const tools = createKsqlMcpTools({ profile: "prod" });
    const result = await tools.validate({
      sql: "UPDATE APP100@stg SET ステータス = '完了' WHERE 顧客コード = 'C001'",
      profile: "prod",
    });

    expect(result.statementType).toBe("UPDATE");
    expect(result.isDml).toBe(true);
    expect(result.isReadOnly).toBe(false);
    expect(result.hasWhere).toBe(true);
    expect(result.normalizedSql).not.toContain("@stg");
    expect(result.appBindings).toEqual([
      { mappedAppId: 100, appId: 100, profile: "stg" },
    ]);
  });

  test("validate keeps explicit single-profile APP binding", async () => {
    const tools = createKsqlMcpTools({ profile: "prod" });
    const result = await tools.validate({
      sql: "SELECT * FROM APP100@prod",
    });

    expect(result.statementType).toBe("SELECT");
    expect(result.normalizedSql).toBe("SELECT * FROM APP100");
    expect(result.appBindings).toEqual([
      { mappedAppId: 100, appId: 100, profile: "prod" },
    ]);
  });

  test("explain returns a plan without a real kintone client", async () => {
    const tools = createKsqlMcpTools({ profile: "prod" });
    const result = await tools.explain({
      sql: "SELECT 顧客名 FROM APP100 WHERE ステータス = '完了'",
    });

    expect(result.ok).toBe(true);
    expect(result.type).toBe("SELECT");
    expect(result.columns).toEqual(["plan"]);
    expect(JSON.stringify(result.rows)).toContain("mode:");
  });

  test("query executes no-FROM SELECT without runtime auth", async () => {
    const tools = createKsqlMcpTools({ profile: "prod" });
    const result = await tools.query({
      sql: "SELECT 'APP100@stg' AS sample",
    });

    expect(result.ok).toBe(true);
    expect(result.type).toBe("SELECT");
    expect(result.rowCount).toBe(1);
    expect(result.rows).toEqual([{ sample: "APP100@stg" }]);
  });

  test("describeApp and showApps delegate to query SQL", async () => {
    const runtimeInputs: CreateKsqlRuntimeInput[] = [];
    const executedSql: string[] = [];
    const createRuntime = async (
      _serverOptions: KsqlRuntimeServerOptions,
      input: CreateKsqlRuntimeInput
    ): Promise<KsqlRuntime> => {
      runtimeInputs.push(input);
      return {
        sql: input.sql,
        profileName: input.profile ?? "prod",
        client: makeClient(),
        cacheContext: "test",
        maxRecords: input.maxRecords ?? 500,
        fetchParallel: input.fetchParallel ?? 3,
        onLimit: input.onLimit ?? "error",
        timeout: input.timeout ?? 30000,
      };
    };
    const executeSql = async (
      sql: string,
      _client: KintoneClient,
      _options?: ExecuteOptions
    ): Promise<ExecuteResult> => {
      executedSql.push(sql);
      return {
        type: "SELECT",
        columns: ["x"],
        rows: [{ x: "1" }],
        rowCount: 1,
        warnings: [],
      };
    };
    const tools = createKsqlMcpTools(
      { profile: "prod" },
      { createRuntime, executeSql }
    );

    await tools.describeApp({ app: 100, profile: "prod" });
    await tools.showApps({ profile: "prod" });

    expect(runtimeInputs.map((input) => input.sql)).toEqual([
      "DESCRIBE APP100",
      "SHOW APPS",
    ]);
    expect(executedSql).toEqual(["DESCRIBE APP100", "SHOW APPS"]);
  });

  test("query rejects DML", async () => {
    const tools = createKsqlMcpTools({ profile: "prod" });
    await expect(tools.query({
      sql: "UPDATE APP100 SET ステータス = '完了' WHERE 顧客コード = 'C001'",
    })).rejects.toThrow(/not allowed by ksql_query/);
  });

  test("query maps maxRecords/onLimit to execute options and timeout to runtime", async () => {
    const runtimeInputs: CreateKsqlRuntimeInput[] = [];
    let executeOptions: ExecuteOptions | undefined;

    const createRuntime = async (
      _serverOptions: KsqlRuntimeServerOptions,
      input: CreateKsqlRuntimeInput
    ): Promise<KsqlRuntime> => {
      runtimeInputs.push(input);
      return {
        sql: input.sql,
        profileName: input.profile ?? "prod",
        client: makeClient(),
        cacheContext: "test",
        maxRecords: input.maxRecords ?? 500,
        fetchParallel: input.fetchParallel ?? 3,
        onLimit: input.onLimit ?? "error",
        timeout: input.timeout ?? 30000,
      };
    };
    const executeSql = async (
      _sql: string,
      _client: KintoneClient,
      options?: ExecuteOptions
    ): Promise<ExecuteResult> => {
      executeOptions = options;
      return {
        type: "SELECT",
        columns: ["x"],
        rows: [{ x: "1" }],
        rowCount: 1,
        warnings: [],
      };
    };

    const tools = createKsqlMcpTools(
      { profile: "prod" },
      { createRuntime, executeSql }
    );
    const result = await tools.query({
      sql: "SELECT * FROM APP100",
      maxRecords: 123,
      onLimit: "truncate",
      timeout: 45000,
    });

    expect(result.ok).toBe(true);
    expect(runtimeInputs[0]?.timeout).toBe(45000);
    expect(executeOptions?.maxRecords).toBe(123);
    expect(executeOptions?.onLimitReached).toBe("truncate");
  });

  test("query schema does not expose CLI-only format or per-call configPath", () => {
    expect("format" in queryInputSchema.shape).toBe(false);
    expect("configPath" in queryInputSchema.shape).toBe(false);
  });

  test("mutate schema exposes explicit safety inputs only", () => {
    expect(Object.keys(mutateInputSchema.shape).sort()).toEqual([
      "allowDml",
      "confirmText",
      "dmlMaxRows",
      "dmlTotalMaxRows",
      "fetchParallel",
      "profile",
      "sql",
      "timeout",
    ]);
    expect("allowWithoutWhere" in mutateInputSchema.shape).toBe(false);
    // DML バッチに続行オプションは存在しない（常に fail-fast）
    expect("continueOnError" in mutateInputSchema.shape).toBe(false);
  });

  test("explain schema exposes only sql and profile", () => {
    expect(Object.keys(explainInputSchema.shape).sort()).toEqual(["profile", "sql"]);
  });

  test("mutate rejects missing explicit DML approval", async () => {
    const tools = createKsqlMcpTools({ profile: "prod" });
    const result = await tools.mutateTool({
      sql: "UPDATE APP100 SET ステータス = '完了' WHERE 顧客コード = 'C001'",
      confirmText: "yes",
      dmlMaxRows: 1,
    } as never);
    const payload = result.structuredContent as {
      ok: false;
      error: { code: string; message: string };
    };

    expect(result.isError).toBe(true);
    expect(payload.error.code).toBe("ArgumentError");
    expect(payload.error.message).toContain("allowDml");
  });

  test("mutate rejects read-only SQL", async () => {
    const tools = createKsqlMcpTools({ profile: "prod" });
    await expect(tools.mutate({
      sql: "SELECT * FROM APP100",
      allowDml: true,
      confirmText: "yes",
      dmlMaxRows: 1,
    })).rejects.toThrow(/Use ksql_query/);
  });

  test("mutate rejects INSERT values above dmlMaxRows before runtime", async () => {
    const createRuntime = async (): Promise<KsqlRuntime> => {
      throw new Error("createRuntime should not be called.");
    };
    const tools = createKsqlMcpTools(
      { profile: "prod" },
      { createRuntime }
    );

    await expect(tools.mutate({
      sql: "INSERT INTO APP100 (name) VALUES ('a'), ('b')",
      allowDml: true,
      confirmText: "yes",
      dmlMaxRows: 1,
    })).rejects.toThrow(/INSERT rows \(2\) exceed dmlMaxRows \(1\)/);
  });

  test("mutate rejects standalone SELECT-based DML with a batch hint for INSERT_SELECT", async () => {
    const tools = createKsqlMcpTools({ profile: "prod" });

    // 単文 INSERT_SELECT の拒否メッセージは対応済みのバッチ経路(M4)へ誘導する
    await expect(tools.mutate({
      sql: "INSERT INTO APP200 (name) SELECT name FROM APP100",
      allowDml: true,
      confirmText: "yes",
      dmlMaxRows: 10,
    })).rejects.toThrow(
      /INSERT_SELECT is not supported by ksql_mutate as a single statement\. Wrap it in a batch: CREATE TEMP TABLE #t AS SELECT/
    );
    await expect(tools.mutate({
      sql: "UPSERT INTO APP200 (name) SELECT name FROM APP100 ON DUPLICATE (name)",
      allowDml: true,
      confirmText: "yes",
      dmlMaxRows: 10,
    })).rejects.toThrow(/UPSERT_SELECT is not supported/);
  });

  test("mutate maps dmlMaxRows to runtime and returns mutation payload", async () => {
    const runtimeInputs: CreateKsqlRuntimeInput[] = [];
    let executeOptions: ExecuteOptions | undefined;
    const createRuntime = async (
      _serverOptions: KsqlRuntimeServerOptions,
      input: CreateKsqlRuntimeInput
    ): Promise<KsqlRuntime> => {
      runtimeInputs.push(input);
      return {
        sql: input.sql,
        profileName: input.profile ?? "prod",
        client: makeClient(),
        cacheContext: "test",
        maxRecords: input.maxRecords ?? 500,
        fetchParallel: input.fetchParallel ?? 3,
        onLimit: input.onLimit ?? "error",
        timeout: input.timeout ?? 30000,
      };
    };
    const executeSql = async (
      _sql: string,
      _client: KintoneClient,
      options?: ExecuteOptions
    ): Promise<ExecuteResult> => {
      executeOptions = options;
      const confirmed = await options?.confirm?.(2, "UPDATE");
      expect(confirmed).toBe(true);
      return {
        type: "UPDATE",
        updatedCount: 2,
      };
    };
    const tools = createKsqlMcpTools(
      { profile: "prod" },
      { createRuntime, executeSql }
    );

    const result = await tools.mutate({
      sql: "UPDATE APP100 SET ステータス = '完了' WHERE 顧客コード = 'C001'",
      allowDml: true,
      confirmText: "yes",
      dmlMaxRows: 2,
      timeout: 45000,
    });

    expect(result).toEqual({
      ok: true,
      type: "UPDATE",
      updatedCount: 2,
    });
    expect(runtimeInputs[0]?.maxRecords).toBe(3);
    expect(runtimeInputs[0]?.timeout).toBe(45000);
    expect(executeOptions?.maxRecords).toBe(3);
    expect(executeOptions?.onLimitReached).toBe("error");
  });

  test("mutate rejects confirm counts above dmlMaxRows", async () => {
    const createRuntime = async (
      _serverOptions: KsqlRuntimeServerOptions,
      input: CreateKsqlRuntimeInput
    ): Promise<KsqlRuntime> => ({
      sql: input.sql,
      profileName: input.profile ?? "prod",
      client: makeClient(),
      cacheContext: "test",
      maxRecords: input.maxRecords ?? 500,
      fetchParallel: input.fetchParallel ?? 3,
      onLimit: input.onLimit ?? "error",
      timeout: input.timeout ?? 30000,
    });
    const executeSql = async (
      _sql: string,
      _client: KintoneClient,
      options?: ExecuteOptions
    ): Promise<ExecuteResult> => {
      await options?.confirm?.(2, "UPDATE");
      return {
        type: "UPDATE",
        updatedCount: 2,
      };
    };
    const tools = createKsqlMcpTools(
      { profile: "prod" },
      { createRuntime, executeSql }
    );

    await expect(tools.mutate({
      sql: "UPDATE APP100 SET ステータス = '完了' WHERE 顧客コード = 'C001'",
      allowDml: true,
      confirmText: "yes",
      dmlMaxRows: 1,
    })).rejects.toThrow(/affected rows \(2\) exceed dmlMaxRows \(1\)/);
  });

  test("saved query tools save, list, get, run, and delete read-only SQL", async () => {
    const dir = await mkdtemp(join(process.cwd(), ".tmp-mcp-tools-"));
    process.env.KSQL_SAVED_QUERIES = join(dir, "queries.json");
    const executedSql: string[] = [];
    const executeSql = async (
      sql: string,
      _client: KintoneClient,
      _options?: ExecuteOptions
    ): Promise<ExecuteResult> => {
      executedSql.push(sql);
      return {
        type: "SELECT",
        columns: ["result"],
        rows: [{ result: "ok" }],
        rowCount: 1,
        warnings: [],
      };
    };
    const tools = createKsqlMcpTools(
      { profile: "prod" },
      { executeSql }
    );

    try {
      const saved = await tools.saveQuery({
        name: "hello_query",
        title: "Hello query",
        sql: "SELECT 'ok' AS result",
        defaultProfile: "prod",
        readOnly: true,
        allowProfileOverride: true,
      });
      const listed = await tools.listQueries({});
      const got = await tools.getQuery({ name: "hello_query" });
      const ran = await tools.runSavedQuery({ name: "hello_query", profile: "stg" });
      const deleted = await tools.deleteQuery({ name: "hello_query" });
      const listedAfterDelete = await tools.listQueries({});

      expect(saved.created).toBe(true);
      const querySummaries = listed.queries as Array<{ name: string; sql?: string }>;
      expect(querySummaries).toEqual([
        expect.objectContaining({ name: "hello_query" }),
      ]);
      expect(querySummaries[0]).not.toHaveProperty("sql");
      expect(got.query).toEqual(expect.objectContaining({
        name: "hello_query",
        sql: "SELECT 'ok' AS result",
      }));
      expect(ran).toEqual({
        ok: true,
        name: "hello_query",
        result: expect.objectContaining({
          ok: true,
          rowCount: 1,
        }),
      });
      expect(deleted).toEqual({
        ok: true,
        name: "hello_query",
        deleted: true,
      });
      expect(listedAfterDelete.queries).toEqual([]);
      expect(executedSql).toEqual(["SELECT 'ok' AS result"]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("saveQuery rejects read-only DML", async () => {
    const dir = await mkdtemp(join(process.cwd(), ".tmp-mcp-tools-"));
    process.env.KSQL_SAVED_QUERIES = join(dir, "queries.json");
    const tools = createKsqlMcpTools({ profile: "prod" });

    try {
      await expect(tools.saveQuery({
        name: "unsafe_update",
        sql: "UPDATE APP100 SET ステータス = '完了' WHERE 顧客コード = 'C001'",
        defaultProfile: "prod",
        readOnly: true,
      })).rejects.toThrow(/readOnly saved query cannot contain UPDATE/);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("saved query tools use mcp.savedQueries.path relative to config file", async () => {
    const dir = await mkdtemp(join(process.cwd(), ".tmp-mcp-tools-"));
    const configPath = join(dir, "config", "ksql.config.json");
    await mkdir(join(dir, "config"), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      defaultProfile: "prod",
      mcp: {
        savedQueries: {
          path: "catalog/queries.json",
        },
      },
    }, null, 2), "utf8");
    const tools = createKsqlMcpTools({ configPath, profile: "prod" });

    try {
      await tools.saveQuery({
        name: "config_path_query",
        sql: "SELECT 'ok' AS result",
        defaultProfile: "prod",
        readOnly: true,
      });

      const raw = await readFile(join(dir, "config", "catalog", "queries.json"), "utf8");
      expect(raw).toContain("config_path_query");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("runSavedQuery requires profile override opt-in and DML approval", async () => {
    const dir = await mkdtemp(join(process.cwd(), ".tmp-mcp-tools-"));
    process.env.KSQL_SAVED_QUERIES = join(dir, "queries.json");
    const executeSql = async (
      _sql: string,
      _client: KintoneClient,
      options?: ExecuteOptions
    ): Promise<ExecuteResult> => {
      await options?.confirm?.(1, "UPDATE");
      return {
        type: "UPDATE",
        updatedCount: 1,
      };
    };
    const tools = createKsqlMcpTools(
      { profile: "prod" },
      { executeSql }
    );

    try {
      await tools.saveQuery({
        name: "status_update",
        sql: "UPDATE APP100 SET ステータス = '完了' WHERE 顧客コード = 'C001'",
        defaultProfile: "prod",
        readOnly: false,
      });

      await expect(tools.runSavedQuery({
        name: "status_update",
        profile: "stg",
        allowDml: true,
        confirmText: "yes",
        dmlMaxRows: 1,
      })).rejects.toThrow(/does not allow profile override/);

      await expect(tools.runSavedQuery({
        name: "status_update",
      })).rejects.toThrow(/allowDml: true is required by ksql_run_saved_query/);

      const result = await tools.runSavedQuery({
        name: "status_update",
        allowDml: true,
        confirmText: "yes",
        dmlMaxRows: 1,
      });
      expect(result).toEqual({
        ok: true,
        name: "status_update",
        result: {
          ok: true,
          type: "UPDATE",
          updatedCount: 1,
        },
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("query maps fetchParallel to runtime and execute options", async () => {
    const runtimeInputs: CreateKsqlRuntimeInput[] = [];
    let executeOptions: ExecuteOptions | undefined;

    const createRuntime = async (
      _serverOptions: KsqlRuntimeServerOptions,
      input: CreateKsqlRuntimeInput
    ): Promise<KsqlRuntime> => {
      runtimeInputs.push(input);
      return {
        sql: input.sql,
        profileName: input.profile ?? "prod",
        client: makeClient(),
        cacheContext: "test",
        maxRecords: input.maxRecords ?? 500,
        fetchParallel: input.fetchParallel ?? 3,
        onLimit: input.onLimit ?? "error",
        timeout: input.timeout ?? 30000,
      };
    };
    const executeSql = async (
      _sql: string,
      _client: KintoneClient,
      options?: ExecuteOptions
    ): Promise<ExecuteResult> => {
      executeOptions = options;
      return {
        type: "SELECT",
        columns: ["x"],
        rows: [{ x: "1" }],
        rowCount: 1,
        warnings: [],
      };
    };

    const tools = createKsqlMcpTools(
      { profile: "prod" },
      { createRuntime, executeSql }
    );
    await tools.query({
      sql: "SELECT * FROM APP100",
      fetchParallel: 7,
    });

    expect(runtimeInputs[0]?.fetchParallel).toBe(7);
    expect(executeOptions?.fetchParallel).toBe(7);
  });

  test("runSavedQuery forwards fetchParallel to read-only and DML paths", async () => {
    const dir = await mkdtemp(join(process.cwd(), ".tmp-mcp-tools-"));
    process.env.KSQL_SAVED_QUERIES = join(dir, "queries.json");
    const executeOptionsList: (ExecuteOptions | undefined)[] = [];
    const executeSql = async (
      sql: string,
      _client: KintoneClient,
      options?: ExecuteOptions
    ): Promise<ExecuteResult> => {
      executeOptionsList.push(options);
      if (sql.startsWith("UPDATE")) {
        await options?.confirm?.(1, "UPDATE");
        return { type: "UPDATE", updatedCount: 1 };
      }
      return {
        type: "SELECT",
        columns: ["x"],
        rows: [{ x: "1" }],
        rowCount: 1,
        warnings: [],
      };
    };
    const tools = createKsqlMcpTools(
      { profile: "prod" },
      { executeSql }
    );

    try {
      await tools.saveQuery({
        name: "ro_query",
        sql: "SELECT * FROM APP100",
        defaultProfile: "prod",
        readOnly: true,
      });
      await tools.saveQuery({
        name: "dml_query",
        sql: "UPDATE APP100 SET ステータス = '完了' WHERE 顧客コード = 'C001'",
        defaultProfile: "prod",
        readOnly: false,
      });

      await tools.runSavedQuery({ name: "ro_query", fetchParallel: 7 });
      await tools.runSavedQuery({
        name: "dml_query",
        allowDml: true,
        confirmText: "yes",
        dmlMaxRows: 1,
        fetchParallel: 7,
      });

      expect(executeOptionsList).toHaveLength(2);
      expect(executeOptionsList[0]?.fetchParallel).toBe(7);
      expect(executeOptionsList[1]?.fetchParallel).toBe(7);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("tool errors preserve ParseError code in structured content", async () => {
    const tools = createKsqlMcpTools({ profile: "prod" });
    const result = await tools.validateTool({ sql: "SELECT FROM" });
    const payload = result.structuredContent as {
      ok: false;
      error: { code: string; message: string };
    };

    expect(result.isError).toBe(true);
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe("ParseError");
  });

  // ----------------------------------------------------------------
  // バッチ validate（フェーズ1 S5）
  // ----------------------------------------------------------------

  test("validate: バッチ入力は statements[] とサマリを返す", async () => {
    const tools = createKsqlMcpTools({ profile: "prod" });
    const result = await tools.validate({
      sql: "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP100; SELECT 顧客名 FROM #t",
    });

    expect(result.batch).toBe(true);
    expect(result.statementCount).toBe(2);
    expect(result.isReadOnlyBatch).toBe(true);
    expect(result.containsDml).toBe(false);
    expect(result.canRunWithQueryTool).toBe(true);
    expect(result.requiresMutationTool).toBe(false);
    expect(result.tempTables).toEqual(["#t"]);
    expect(result.statements[0]).toMatchObject({
      index: 0,
      statementType: "CREATE_TEMP_TABLE",
      isReadOnly: true,
      appIds: [100],
      tempTablesCreated: ["#t"],
    });
    expect(result.statements[1]).toMatchObject({
      index: 1,
      statementType: "SELECT",
      tempTablesReferenced: ["#t"],
      appIds: [],
    });
    // バッチではトップレベルのスカラーは持たない
    expect(result.statementType).toBeUndefined();
  });

  test("validate: 単文は従来スカラー形を維持しつつ statements[]（要素1）も持つ", async () => {
    const tools = createKsqlMcpTools({ profile: "prod" });
    const result = await tools.validate({ sql: "SELECT * FROM APP100" });

    expect(result.batch).toBe(false);
    expect(result.statementType).toBe("SELECT");
    expect(result.appIds).toEqual([100]);
    expect(result.statements).toHaveLength(1);
    expect(result.statements[0].statementType).toBe("SELECT");
  });

  test("validate: DML 混在バッチは containsDml / requiresMutationTool が立つ", async () => {
    const tools = createKsqlMcpTools({ profile: "prod" });
    const result = await tools.validate({
      sql: "SELECT * FROM APP100; UPDATE APP200 SET x = '1' WHERE $id = 1",
    });

    expect(result.batch).toBe(true);
    expect(result.containsDml).toBe(true);
    expect(result.isReadOnlyBatch).toBe(false);
    expect(result.canRunWithQueryTool).toBe(false);
    expect(result.requiresMutationTool).toBe(true);
    expect(result.statements[1]).toMatchObject({ isDml: true, hasWhere: true, appIds: [200] });
  });

  test("validate: 未定義の一時テーブル参照はバッチ全体を拒否", async () => {
    const tools = createKsqlMcpTools({ profile: "prod" });
    await expect(
      tools.validate({ sql: "SELECT * FROM APP100; SELECT * FROM #t" })
    ).rejects.toThrow(/temp table #t is not defined in this batch/);
  });

  test("validate: 単文の CREATE TEMP TABLE は ArgumentError", async () => {
    const tools = createKsqlMcpTools({ profile: "prod" });
    await expect(
      tools.validate({ sql: "CREATE TEMP TABLE #t AS SELECT * FROM APP100" })
    ).rejects.toThrow(/CREATE TEMP TABLE requires a batch/);
  });

  // ----------------------------------------------------------------
  // ksql_query のバッチ受理（フェーズ1 S6）
  // ----------------------------------------------------------------

  function makeBatchRuntimeDeps(recordsByApp: Record<number, Array<Record<string, { value: string }>>>) {
    const client: KintoneClient = {
      async getRecords(params) {
        const records = recordsByApp[params.app];
        if (records === undefined) {
          throw new Error(`FetchError: mock failure for APP${params.app}`);
        }
        return { records: records as never };
      },
      async postRecords() { return { ids: [] }; },
      async putRecords() { },
      async deleteRecords() { },
      async getApps() { return []; },
      async getFields() { return []; },
    };
    const createRuntime = async (
      _serverOptions: KsqlRuntimeServerOptions,
      input: CreateKsqlRuntimeInput
    ): Promise<KsqlRuntime> => ({
      sql: input.sql,
      profileName: input.profile ?? "prod",
      client,
      cacheContext: "batch-test",
      maxRecords: input.maxRecords ?? 500,
      fetchParallel: input.fetchParallel ?? 3,
      onLimit: input.onLimit ?? "error",
      timeout: input.timeout ?? 30000,
    });
    return { createRuntime };
  }

  const BATCH_APP100 = [
    { $id: { value: "1" }, 顧客名: { value: "A社" }, 売上: { value: "100" } },
    { $id: { value: "2" }, 顧客名: { value: "B社" }, 売上: { value: "300" } },
  ];

  test("query: read-only バッチを実行し §6.2 エンベロープを返す", async () => {
    const tools = createKsqlMcpTools(
      { profile: "prod" },
      makeBatchRuntimeDeps({ 100: BATCH_APP100 })
    );
    const result = await tools.query({
      sql: "CREATE TEMP TABLE #t AS SELECT 顧客名, 売上 FROM APP100; SELECT 顧客名 FROM #t WHERE 売上 > 200",
    }) as {
      ok: boolean;
      batch: boolean;
      statementCount: number;
      statements: Array<Record<string, unknown>>;
      results: Array<{ rows: Array<Record<string, string>>; rowCount: number }>;
    };

    expect(result.ok).toBe(true);
    expect(result.batch).toBe(true);
    expect(result.statementCount).toBe(2);
    // CREATE は実体化結果を返さない（tempTable / rowCount のみ）
    expect(result.statements[0]).toEqual({
      index: 0,
      type: "CREATE_TEMP_TABLE",
      status: "success",
      tempTable: "#t",
      rowCount: 2,
    });
    // 素の SELECT は resultIndex で results[] に対応付く
    expect(result.statements[1]).toMatchObject({
      index: 1,
      type: "SELECT",
      status: "success",
      resultIndex: 0,
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].rows).toEqual([{ 顧客名: "B社" }]);
    expect((result as unknown as { warnings: string[] }).warnings).toEqual([]);
  });

  test("query: DML 混在バッチは ksql_mutate へ誘導", async () => {
    const tools = createKsqlMcpTools({ profile: "prod" });
    await expect(
      tools.query({ sql: "SELECT * FROM APP100; DELETE FROM APP100 WHERE $id = 1" })
    ).rejects.toThrow(/batch contains DML statements\. Use ksql_mutate\./);
  });

  test("query: maxTotalRecords 超過はエラー", async () => {
    const tools = createKsqlMcpTools(
      { profile: "prod" },
      makeBatchRuntimeDeps({ 100: BATCH_APP100 })
    );
    await expect(
      tools.query({
        sql: "SELECT 顧客名 FROM APP100; SELECT 顧客名 FROM APP100",
        maxTotalRecords: 3, // 2 + 2 = 4 で超過
      })
    ).rejects.toThrow(/batch total rows \(4\) exceed maxTotalRecords \(3\)/);
  });

  test("query: timeout 未指定でも runtime 解決値がバッチ合計タイムアウトとして効く", async () => {
    const slowClient: KintoneClient = {
      async getRecords() {
        await new Promise((r) => setTimeout(r, 200));
        return { records: [] };
      },
      async postRecords() { return { ids: [] }; },
      async putRecords() { },
      async deleteRecords() { },
      async getApps() { return []; },
      async getFields() { return []; },
    };
    const createRuntime = async (
      _serverOptions: KsqlRuntimeServerOptions,
      input: CreateKsqlRuntimeInput
    ): Promise<KsqlRuntime> => ({
      sql: input.sql,
      profileName: "prod",
      client: slowClient,
      cacheContext: "timeout-test",
      maxRecords: 500,
      fetchParallel: 1,
      onLimit: "error",
      timeout: 30, // profile/env 由来の解決値を想定（入力では未指定）
    });
    const tools = createKsqlMcpTools({ profile: "prod" }, { createRuntime });
    const result = await tools.query({
      sql: "SELECT 顧客名 FROM APP100; SELECT 顧客名 FROM APP100",
    }) as { ok: boolean; statements: Array<{ status: string; error?: { code: string } }> };

    expect(result.ok).toBe(false);
    expect(result.statements[0].error?.code).toBe("TimeoutError");
    expect(result.statements[1].status).toBe("skipped");
  });

  test("query: continueOnError でエラー文以降も実行され文ごとに報告される", async () => {
    const tools = createKsqlMcpTools(
      { profile: "prod" },
      makeBatchRuntimeDeps({ 100: BATCH_APP100 }) // APP999 は失敗する
    );
    const result = await tools.query({
      sql: "SELECT 顧客名 FROM APP999; SELECT 顧客名 FROM APP100",
      continueOnError: true,
    }) as {
      ok: boolean;
      statements: Array<{ status: string; error?: { code: string } }>;
      results: unknown[];
    };

    expect(result.ok).toBe(false);
    expect(result.statements.map((s) => s.status)).toEqual(["error", "success"]);
    expect(result.statements[0].error?.code).toBe("FetchError");
    expect(result.results).toHaveLength(1);
  });

  // ----------------------------------------------------------------
  // ksql_mutate の DML バッチ受理（フェーズ2 M1）
  // ----------------------------------------------------------------

  function makeMutateRuntimeDeps(recordsByApp: Record<number, Array<Record<string, { value: string }>>>) {
    const calls = { post: 0, put: 0, del: 0, get: 0 };
    const client: KintoneClient = {
      async getRecords(params) {
        calls.get += 1;
        return { records: (recordsByApp[params.app] ?? []) as never };
      },
      async postRecords(params) {
        calls.post += 1;
        return { ids: params.records.map((_r, i) => String(100 + i)) };
      },
      async putRecords() { calls.put += 1; },
      async deleteRecords() { calls.del += 1; },
      async getApps() { return []; },
      async getFields() { return []; },
    };
    const createRuntime = async (
      _serverOptions: KsqlRuntimeServerOptions,
      input: CreateKsqlRuntimeInput
    ): Promise<KsqlRuntime> => ({
      sql: input.sql,
      profileName: input.profile ?? "prod",
      client,
      cacheContext: "mutate-batch-test",
      maxRecords: input.maxRecords ?? 500,
      fetchParallel: input.fetchParallel ?? 3,
      onLimit: input.onLimit ?? "error",
      timeout: input.timeout ?? 30000,
    });
    return { deps: { createRuntime }, calls };
  }

  const MUTATE_BASE = { allowDml: true as const, confirmText: "yes" as const };

  test("mutate: DML バッチを実行し文ごとの影響件数を返す", async () => {
    const { deps } = makeMutateRuntimeDeps({
      100: [{ $id: { value: "1" }, ステータス: { value: "対応中" } }],
    });
    const tools = createKsqlMcpTools({ profile: "prod" }, deps);
    const result = await tools.mutate({
      ...MUTATE_BASE,
      sql: "INSERT INTO APP100 (顧客名) VALUES ('A社'), ('B社'); UPDATE APP100 SET ステータス = '完了' WHERE $id = 1",
      dmlMaxRows: 10,
    }) as {
      ok: boolean;
      batch: boolean;
      statements: Array<Record<string, unknown>>;
    };

    expect(result.ok).toBe(true);
    expect(result.batch).toBe(true);
    expect(result.statements[0]).toMatchObject({
      type: "INSERT",
      status: "success",
      insertedCount: 2,
    });
    expect(result.statements[1]).toMatchObject({
      type: "UPDATE",
      status: "success",
      updatedCount: 1,
    });
  });

  test("mutate: read-only のみのバッチは ksql_query へ誘導", async () => {
    const tools = createKsqlMcpTools({ profile: "prod" });
    await expect(
      tools.mutate({
        ...MUTATE_BASE,
        sql: "SELECT * FROM APP100; SELECT * FROM APP200",
        dmlMaxRows: 10,
      })
    ).rejects.toThrow(/batch contains no DML statements\. Use ksql_query\./);
  });

  test("mutate: 静的ガードは validate-all-first で効く（違反があれば1文も実行しない）", async () => {
    // WHERE なし UPDATE / DELETE はパーサ段階で拒否されるため（tools 層のガードは防御的併設）、
    // ここでは INSERT 行数超過（statement 1）で「先頭文すら実行されない」ことを検証する
    const { deps, calls } = makeMutateRuntimeDeps({});
    const tools = createKsqlMcpTools({ profile: "prod" }, deps);
    await expect(
      tools.mutate({
        ...MUTATE_BASE,
        sql: "INSERT INTO APP100 (x) VALUES ('a'); INSERT INTO APP100 (x) VALUES ('b'), ('c'), ('d')",
        dmlMaxRows: 2,
      })
    ).rejects.toThrow(/INSERT rows \(3\) exceed dmlMaxRows \(2\)\. \(statement 1\)/);
    expect(calls.post).toBe(0);
  });

  test("mutate: APP をソースとする INSERT_SELECT は文番号付きで拒否（temp のみ許可）", async () => {
    const tools = createKsqlMcpTools({ profile: "prod" });
    await expect(
      tools.mutate({
        ...MUTATE_BASE,
        sql: "DELETE FROM APP100 WHERE $id = 1; INSERT INTO APP100 (x) SELECT x FROM APP200",
        dmlMaxRows: 10,
      })
    ).rejects.toThrow(/INSERT_SELECT in a batch must select from temp tables only\. \(statement 1\)/);
  });

  test("mutate: UPSERT_SELECT はバッチでも引き続き拒否", async () => {
    const tools = createKsqlMcpTools({ profile: "prod" });
    await expect(
      tools.mutate({
        ...MUTATE_BASE,
        sql: "DELETE FROM APP100 WHERE $id = 1; UPSERT INTO APP100 (x) SELECT x FROM APP200 ON DUPLICATE (x)",
        dmlMaxRows: 10,
      })
    ).rejects.toThrow(/UPSERT_SELECT is not supported by ksql_mutate yet\. \(statement 1\)/);
  });

  // ----------------------------------------------------------------
  // バッチ EXPLAIN（フェーズ2 M3）
  // ----------------------------------------------------------------

  test("explain: バッチ入力は全文プランの配列を返す（実行なし）", async () => {
    const tools = createKsqlMcpTools({ profile: "prod" });
    const result = await tools.explain({
      sql:
        "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP100;" +
        "SELECT 顧客名 FROM #t",
    }) as {
      ok: boolean;
      batch: boolean;
      statementCount: number;
      statements: Array<{ index: number; type: string; plan: string[] }>;
    };

    expect(result.ok).toBe(true);
    expect(result.batch).toBe(true);
    expect(result.statementCount).toBe(2);
    expect(result.statements[0].type).toBe("CREATE_TEMP_TABLE");
    expect(result.statements[1].plan.join("\n")).toMatch(/FULL_SCAN（一時テーブル参照）/);
  });

  test("explain: 単文入力は従来ペイロードのまま", async () => {
    const tools = createKsqlMcpTools({ profile: "prod" });
    const result = await tools.explain({ sql: "SELECT 顧客名 FROM APP100" });
    expect(result.ok).toBe(true);
    expect(result.type).toBe("SELECT"); // 従来の SelectResult 形
  });

  // ----------------------------------------------------------------
  // 一時テーブル経由の INSERT_SELECT（フェーズ2 M4）— 2段階 DML フロー
  // ----------------------------------------------------------------

  test("mutate: CREATE TEMP → INSERT_SELECT の2段階 DML フローが動く", async () => {
    const { deps } = makeMutateRuntimeDeps({
      100: [
        { $id: { value: "1" }, 顧客名: { value: "A社" } },
        { $id: { value: "2" }, 顧客名: { value: "B社" } },
      ],
    });
    const tools = createKsqlMcpTools({ profile: "prod" }, deps);
    const result = await tools.mutate({
      ...MUTATE_BASE,
      sql:
        "CREATE TEMP TABLE #targets AS SELECT 顧客名 FROM APP100;" +
        "INSERT INTO APP200 (名前) SELECT 顧客名 FROM #targets",
      dmlMaxRows: 5,
    }) as { ok: boolean; statements: Array<Record<string, unknown>> };

    expect(result.ok).toBe(true);
    expect(result.statements[0]).toMatchObject({
      type: "CREATE_TEMP_TABLE",
      status: "success",
      tempTable: "#targets",
      rowCount: 2,
    });
    expect(result.statements[1]).toMatchObject({
      type: "INSERT_SELECT",
      status: "success",
      insertedCount: 2,
    });
  });

  test("mutate: INSERT_SELECT の実体化済み行数に dmlMaxRows が効く（fail-fast）", async () => {
    const { deps, calls } = makeMutateRuntimeDeps({
      100: [
        { $id: { value: "1" }, 顧客名: { value: "A社" } },
        { $id: { value: "2" }, 顧客名: { value: "B社" } },
        { $id: { value: "3" }, 顧客名: { value: "C社" } },
      ],
    });
    const tools = createKsqlMcpTools({ profile: "prod" }, deps);
    const result = await tools.mutate({
      ...MUTATE_BASE,
      sql:
        "CREATE TEMP TABLE #targets AS SELECT 顧客名 FROM APP100;" +
        "INSERT INTO APP200 (名前) SELECT 顧客名 FROM #targets",
      dmlMaxRows: 2, // 実体化 3 行 > 2
    }) as { ok: boolean; statements: Array<Record<string, unknown>> };

    expect(result.ok).toBe(false);
    expect(result.statements[0]).toMatchObject({ status: "success", rowCount: 3 });
    expect(result.statements[1]).toMatchObject({ status: "error" });
    expect((result.statements[1].error as { message: string }).message)
      .toMatch(/INSERT affected rows \(3\) exceed dmlMaxRows \(2\)/);
    expect(calls.post).toBe(0); // 書き込み前に止まる
  });

  test("mutate: 文ごとの dmlMaxRows 超過(INSERT 行数)は実行前に拒否", async () => {
    const tools = createKsqlMcpTools({ profile: "prod" });
    await expect(
      tools.mutate({
        ...MUTATE_BASE,
        sql: "UPDATE APP100 SET x = '1' WHERE $id = 1; INSERT INTO APP100 (x) VALUES ('a'), ('b'), ('c')",
        dmlMaxRows: 2,
      })
    ).rejects.toThrow(/INSERT rows \(3\) exceed dmlMaxRows \(2\)\. \(statement 1\)/);
  });

  test("mutate: dmlTotalMaxRows の静的超過(INSERT 合計)は実行前に拒否", async () => {
    const tools = createKsqlMcpTools({ profile: "prod" });
    await expect(
      tools.mutate({
        ...MUTATE_BASE,
        sql: "INSERT INTO APP100 (x) VALUES ('a'), ('b'); INSERT INTO APP100 (x) VALUES ('c'), ('d')",
        dmlMaxRows: 3,
        dmlTotalMaxRows: 3,
      })
    ).rejects.toThrow(/batch INSERT rows \(4\) exceed dmlTotalMaxRows \(3\)/);
  });

  test("mutate: dmlTotalMaxRows の実行時超過は fail-fast し反映済みが読み取れる", async () => {
    const { deps } = makeMutateRuntimeDeps({
      200: [
        { $id: { value: "1" }, x: { value: "a" } },
        { $id: { value: "2" }, x: { value: "b" } },
      ],
    });
    const tools = createKsqlMcpTools({ profile: "prod" }, deps);
    const result = await tools.mutate({
      ...MUTATE_BASE,
      // INSERT 2 行(静的) + UPDATE 2 行(実行時) = 4 > dmlTotalMaxRows 3
      sql: "INSERT INTO APP100 (x) VALUES ('a'), ('b'); UPDATE APP200 SET x = 'z' WHERE $id > 0",
      dmlMaxRows: 10,
      dmlTotalMaxRows: 3,
    }) as {
      ok: boolean;
      statements: Array<Record<string, unknown>>;
    };

    expect(result.ok).toBe(false);
    expect(result.statements[0]).toMatchObject({ status: "success", insertedCount: 2 });
    expect(result.statements[1]).toMatchObject({ status: "error" });
    expect((result.statements[1].error as { message: string }).message)
      .toMatch(/batch affected rows \(4\) exceed dmlTotalMaxRows \(3\)/);
  });
});
