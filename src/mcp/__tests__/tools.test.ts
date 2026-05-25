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
      "profile",
      "sql",
      "timeout",
    ]);
    expect("allowWithoutWhere" in mutateInputSchema.shape).toBe(false);
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

  test("mutate rejects SELECT-based DML in the initial implementation", async () => {
    const tools = createKsqlMcpTools({ profile: "prod" });

    await expect(tools.mutate({
      sql: "INSERT INTO APP200 (name) SELECT name FROM APP100",
      allowDml: true,
      confirmText: "yes",
      dmlMaxRows: 10,
    })).rejects.toThrow(/INSERT_SELECT is not supported/);
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
});
