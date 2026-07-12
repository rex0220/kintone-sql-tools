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

  test("logical validation payload は source/binding を公開し、EXPLAIN はmappedAppIdを公開しない", async () => {
    const dir = await mkdtemp(join(process.cwd(), ".tmp-mcp-logical-"));
    const configPath = join(dir, "ksql.config.json");
    await writeFile(configPath, JSON.stringify({
      defaultProfile: "prod",
      profiles: {
        prod: { logicalApps: { ORDERS: 1234 }, allowPhysicalAppRefs: false },
      },
    }), "utf8");
    const tools = createKsqlMcpTools({ configPath, profile: "prod" });
    try {
      const validation = await tools.validate({ sql: "SELECT * FROM LAPP_ORDERS" });
      expect(validation.appBindings).toEqual([{
        source: "logical",
        logicalName: "ORDERS",
        mappedAppId: 900_000_000,
        appId: 1234,
        profile: "prod",
      }]);

      const explanation = await tools.explain({
        sql: "SELECT * FROM LAPP_ORDERS; SELECT * FROM LAPP_ORDERS",
      });
      expect(explanation.appBindings).toEqual([{
        source: "logical",
        logicalName: "ORDERS",
        appId: 1234,
        profile: "prod",
      }]);
      expect(JSON.stringify(explanation)).not.toContain("mappedAppId");
      expect(JSON.stringify(explanation)).not.toContain("APP900000000");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("allowPhysicalAppRefs:false はrewrite後APPではなく binding source=physical だけを拒否する", async () => {
    const dir = await mkdtemp(join(process.cwd(), ".tmp-mcp-logical-"));
    const configPath = join(dir, "ksql.config.json");
    await writeFile(configPath, JSON.stringify({
      defaultProfile: "prod",
      profiles: {
        prod: { logicalApps: { ORDERS: 1234 }, allowPhysicalAppRefs: false },
      },
    }), "utf8");
    const tools = createKsqlMcpTools({ configPath, profile: "prod" });
    try {
      await expect(tools.validate({ sql: "SELECT * FROM APP1234" }))
        .rejects.toThrow(/physical app references are not allowed/);
      await expect(tools.validate({ sql: "SELECT * FROM LAPP_ORDERS" })).resolves.toMatchObject({ ok: true });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("parser error の table表記と位置を offset map から元 LAPP へ復元する", async () => {
    const dir = await mkdtemp(join(process.cwd(), ".tmp-mcp-logical-"));
    const configPath = join(dir, "ksql.config.json");
    await writeFile(configPath, JSON.stringify({
      defaultProfile: "prod",
      profiles: { prod: { logicalApps: { ORDERS: 1234 } } },
    }), "utf8");
    const tools = createKsqlMcpTools({ configPath, profile: "prod" });
    try {
      await expect(tools.validate({ sql: "DESCRIBE LAPP_ORDERS$明細" }))
        .rejects.toThrow(/LAPP_ORDERS\$明細/);
      await expect(tools.validate({ sql: "DESCRIBE LAPP_ORDERS$明細" }))
        .rejects.not.toThrow(/APP900000000/);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("physical multi-profile の parser error も元 APP@profile 表記へ復元する", async () => {
    const dir = await mkdtemp(join(process.cwd(), ".tmp-mcp-physical-"));
    const configPath = join(dir, "ksql.config.json");
    await writeFile(configPath, JSON.stringify({
      profiles: { dev: {}, prod: {} },
    }), "utf8");
    const tools = createKsqlMcpTools({ configPath, profile: "dev" });
    try {
      const promise = tools.validate({
        sql: "SELECT * FROM APP88@dev; DESCRIBE APP88$明細@prod",
      });
      await expect(promise).rejects.toThrow(/APP88\$明細@prod/);
      await expect(tools.validate({
        sql: "SELECT * FROM APP88@dev; DESCRIBE APP88$明細@prod",
      })).rejects.not.toThrow(/APP90000000/);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("MCP validation allows DELETE + @profile", async () => {
    const tools = createKsqlMcpTools({ profile: "prod" });
    const result = await tools.validate({
      sql: "DELETE FROM APP100@stg WHERE $id = 1",
    });

    expect(result).toMatchObject({
      ok: true,
      statementType: "DELETE",
      isDml: true,
      hasProfileSyntax: true,
    });
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
      { source: "physical", mappedAppId: 100, appId: 100, profile: "stg" },
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
      { source: "physical", mappedAppId: 100, appId: 100, profile: "prod" },
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

  test("query: 単文 ASSERT は非 SELECT 拒否ガードを通らず専用 payload を返す", async () => {
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
    const tools = createKsqlMcpTools({ profile: "prod" }, { createRuntime });

    const result = await tools.query({ sql: "ASSERT 1 = 1" });
    expect(result).toEqual({ ok: true, type: "ASSERT", condition: "1 = 1" });
  });

  test("query: 単文 ASSERT の不成立は AssertError で reject する", async () => {
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
    const tools = createKsqlMcpTools({ profile: "prod" }, { createRuntime });

    await expect(tools.query({ sql: "ASSERT 1 = 2" }))
      .rejects.toThrow(/^AssertError: assertion failed: 1 = 2 \(actual: 1\)\./);
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
      "tempTableMaxRows",
      "timeout",
    ]);
    expect("allowWithoutWhere" in mutateInputSchema.shape).toBe(false);
    // DML バッチに続行オプションは存在しない（常に fail-fast）
    expect("continueOnError" in mutateInputSchema.shape).toBe(false);
  });

  test("tempTableMaxRows schema rejects 0 / negative / non-integer", () => {
    for (const schema of [queryInputSchema, mutateInputSchema]) {
      const base = schema === queryInputSchema
        ? { sql: "SELECT 1" }
        : { sql: "UPDATE APP100 SET x = '1' WHERE $id = 1", allowDml: true, confirmText: "yes", dmlMaxRows: 1 };
      expect(schema.safeParse({ ...base, tempTableMaxRows: 20000 }).success).toBe(true);
      for (const invalid of [0, -1, 1.5]) {
        expect(schema.safeParse({ ...base, tempTableMaxRows: invalid }).success).toBe(false);
      }
    }
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

  // ----------------------------------------------------------------
  // 単文 INSERT_SELECT(APP ソース)の解禁(v1.5.0)
  // ----------------------------------------------------------------

  test("mutate: 単文 INSERT_SELECT(APP ソース)を実行できる", async () => {
    const { deps, calls } = makeMutateRuntimeDeps({
      100: [
        { $id: { value: "1" }, 顧客名: { value: "A社" } },
        { $id: { value: "2" }, 顧客名: { value: "B社" } },
      ],
    });
    const tools = createKsqlMcpTools({ profile: "prod" }, deps);
    const result = await tools.mutate({
      sql: "INSERT INTO APP200 (名前) SELECT 顧客名 FROM APP100",
      allowDml: true,
      confirmText: "yes",
      dmlMaxRows: 10,
    });

    expect(result).toMatchObject({ ok: true, type: "INSERT", insertedCount: 2 });
    expect(calls.post).toBe(1);
  });

  test("mutate: 単文 INSERT_SELECT は source 件数が dmlMaxRows 超過なら書き込み前に拒否", async () => {
    const { deps, calls } = makeMutateRuntimeDeps({
      100: [
        { $id: { value: "1" }, 顧客名: { value: "A社" } },
        { $id: { value: "2" }, 顧客名: { value: "B社" } },
        { $id: { value: "3" }, 顧客名: { value: "C社" } },
      ],
    });
    const tools = createKsqlMcpTools({ profile: "prod" }, deps);
    await expect(tools.mutate({
      sql: "INSERT INTO APP200 (名前) SELECT 顧客名 FROM APP100",
      allowDml: true,
      confirmText: "yes",
      dmlMaxRows: 2,
    })).rejects.toThrow(/INSERT affected rows \(3\) exceed dmlMaxRows \(2\)/);
    expect(calls.post).toBe(0); // confirm(POST 前)で止まる
  });

  test("mutate: 単文 INSERT_SELECT の source 読み取りは dmlMaxRows で絞られない(読み取り成功→影響行数ガードで拒否)", async () => {
    const { deps, calls, runtimeInputs } = makeMutateRuntimeDeps({
      100: [
        { $id: { value: "1" }, 顧客名: { value: "A社" } },
        { $id: { value: "2" }, 顧客名: { value: "B社" } },
        { $id: { value: "3" }, 顧客名: { value: "C社" } },
        { $id: { value: "4" }, 顧客名: { value: "D社" } },
      ],
    });
    const tools = createKsqlMcpTools({ profile: "prod" }, deps);
    // 案A(v1.8.0): SELECT-based DML では maxRecords を dmlMaxRows + 1 で上書きしない。
    // source 4 行は読み取れて、書き込み前の confirm(影響行数ガード)で拒否される
    await expect(tools.mutate({
      sql: "INSERT INTO APP200 (名前) SELECT 顧客名 FROM APP100",
      allowDml: true,
      confirmText: "yes",
      dmlMaxRows: 2,
    })).rejects.toThrow(/INSERT affected rows \(4\) exceed dmlMaxRows \(2\)/);
    expect(runtimeInputs[0]?.maxRecords).toBeUndefined(); // runtime の通常解決に委ねる
    expect(calls.post).toBe(0);
  });

  test("mutate: 単文 INSERT_SELECT(JOIN)は source 読み取り > dmlMaxRows でも影響行数が収まれば成功", async () => {
    const { deps, calls } = makeMutateRuntimeDeps({
      100: [
        { $id: { value: "1" }, 顧客名: { value: "A社" } },
        { $id: { value: "2" }, 顧客名: { value: "B社" } },
      ],
      300: [
        { $id: { value: "1" }, 顧客名: { value: "A社" } },
        { $id: { value: "2" }, 顧客名: { value: "B社" } },
        { $id: { value: "3" }, 顧客名: { value: "C社" } },
        { $id: { value: "4" }, 顧客名: { value: "D社" } },
      ],
    });
    const tools = createKsqlMcpTools({ profile: "prod" }, deps);
    // 旧仕様では APP300 の読み取り(4 行 > dmlMaxRows + 1 = 3)で失敗していたケース。
    // JOIN 結果(影響行数)は 2 行 ≦ dmlMaxRows なので新仕様では成功する
    const result = await tools.mutate({
      sql: "INSERT INTO APP200 (名前) SELECT a.顧客名 FROM APP100 a INNER JOIN APP300 b ON a.顧客名 = b.顧客名",
      allowDml: true,
      confirmText: "yes",
      dmlMaxRows: 2,
    });

    expect(result).toMatchObject({ ok: true, type: "INSERT", insertedCount: 2 });
    expect(calls.post).toBe(1);
  });

  test("mutate: 単文 INSERT_SELECT の source が runtime maxRecords(既定 500)を超えるとヒント付きで失敗", async () => {
    const { deps, calls } = makeMutateRuntimeDeps({
      100: Array.from({ length: 501 }, (_v, i) => ({
        $id: { value: String(i + 1) },
        顧客名: { value: `会社${i + 1}` },
      })),
    });
    const tools = createKsqlMcpTools({ profile: "prod" }, deps);
    await expect(tools.mutate({
      sql: "INSERT INTO APP200 (名前) SELECT 顧客名 FROM APP100",
      allowDml: true,
      confirmText: "yes",
      dmlMaxRows: 2,
    })).rejects.toThrow(/取得件数が上限（500 件）を超えました.*dmlMaxRows は影響行数ガードです/);
    expect(calls.post).toBe(0);
  });

  test("mutate: 単文 INSERT_SELECT でも DML 承認3点セットは必須", async () => {
    const tools = createKsqlMcpTools({ profile: "prod" });
    const result = await tools.mutateTool({
      sql: "INSERT INTO APP200 (名前) SELECT 顧客名 FROM APP100",
      allowDml: true,
      dmlMaxRows: 10,
    } as never);

    expect(result.isError).toBe(true);
    expect((result.structuredContent as { error: { message: string } }).error.message)
      .toContain("confirmText");
  });

  // ----------------------------------------------------------------
  // 単文 UPSERT_SELECT(APP ソース)の解禁(v1.6.0)
  // ----------------------------------------------------------------

  test("mutate: 単文 UPSERT_SELECT(APP ソース)を実行でき insert / update が混在する", async () => {
    const { deps, calls } = makeMutateRuntimeDeps({
      100: [
        { $id: { value: "1" }, 顧客コード: { value: "C001" } },
        { $id: { value: "2" }, 顧客コード: { value: "C003" } },
      ],
      300: [
        { $id: { value: "9" }, 顧客コード: { value: "C001" } }, // C001 のみ既存 → update
      ],
    });
    const tools = createKsqlMcpTools({ profile: "prod" }, deps);
    const result = await tools.mutate({
      sql: "UPSERT INTO APP300 (顧客コード) SELECT 顧客コード FROM APP100 ON DUPLICATE (顧客コード)",
      allowDml: true,
      confirmText: "yes",
      dmlMaxRows: 10,
    });

    expect(result).toMatchObject({ ok: true, type: "UPSERT", insertedCount: 1, updatedCount: 1 });
    expect(calls.post).toBe(1); // C003 の INSERT
    expect(calls.put).toBe(1); // C001 の UPDATE
  });

  test("mutate: 単文 UPSERT_SELECT は insert + update 合計が dmlMaxRows 超過なら書き込み前に拒否", async () => {
    const { deps, calls } = makeMutateRuntimeDeps({
      100: [
        { $id: { value: "1" }, 顧客コード: { value: "C001" } },
        { $id: { value: "2" }, 顧客コード: { value: "C002" } },
        { $id: { value: "3" }, 顧客コード: { value: "C003" } },
      ],
      300: [
        { $id: { value: "9" }, 顧客コード: { value: "C001" } },
      ],
    });
    const tools = createKsqlMcpTools({ profile: "prod" }, deps);
    // update 1 + insert 2 = 3 > dmlMaxRows 2。超過メッセージは operation("UPDATE")表記
    await expect(tools.mutate({
      sql: "UPSERT INTO APP300 (顧客コード) SELECT 顧客コード FROM APP100 ON DUPLICATE (顧客コード)",
      allowDml: true,
      confirmText: "yes",
      dmlMaxRows: 2,
    })).rejects.toThrow(/UPDATE affected rows \(3\) exceed dmlMaxRows \(2\)/);
    expect(calls.post).toBe(0); // POST / PUT とも書き込み前に止まる
    expect(calls.put).toBe(0);
  });

  test("mutate: 単文 UPSERT_SELECT の source 読み取りは dmlMaxRows で絞られない(読み取り成功→影響行数ガードで拒否)", async () => {
    const { deps, calls, runtimeInputs } = makeMutateRuntimeDeps({
      100: [
        { $id: { value: "1" }, 顧客コード: { value: "C001" } },
        { $id: { value: "2" }, 顧客コード: { value: "C002" } },
        { $id: { value: "3" }, 顧客コード: { value: "C003" } },
        { $id: { value: "4" }, 顧客コード: { value: "C004" } },
      ],
      300: [],
    });
    const tools = createKsqlMcpTools({ profile: "prod" }, deps);
    // 案A(v1.8.0): source 4 行は読み取れて、照合後の insert + update 合計(4)が
    // dmlMaxRows(2)を超えるため confirm で書き込み前に拒否される
    await expect(tools.mutate({
      sql: "UPSERT INTO APP300 (顧客コード) SELECT 顧客コード FROM APP100 ON DUPLICATE (顧客コード)",
      allowDml: true,
      confirmText: "yes",
      dmlMaxRows: 2,
    })).rejects.toThrow(/UPDATE affected rows \(4\) exceed dmlMaxRows \(2\)/);
    expect(runtimeInputs[0]?.maxRecords).toBeUndefined(); // runtime の通常解決に委ねる
    expect(calls.post).toBe(0);
    expect(calls.put).toBe(0);
  });

  test("mutate: 単文 UPSERT_SELECT は照合読み取り(第1キー低選択性)が dmlMaxRows 超でも成功する", async () => {
    // 旧仕様(〜v1.7.0)では照合読み取りが dmlMaxRows + 1 で上限され source 1 行でも
    // 安全側エラーになり得た(R2)。案A(v1.8.0)では照合読み取りも runtime maxRecords
    // (既定 500)に従うため成功する。重複キーは最大 $id を採用して 1 件の update になる
    const { deps, calls } = makeMutateRuntimeDeps({
      100: [
        { $id: { value: "1" }, 顧客コード: { value: "C001" } },
      ],
      300: [
        { $id: { value: "11" }, 顧客コード: { value: "C001" } },
        { $id: { value: "12" }, 顧客コード: { value: "C001" } },
        { $id: { value: "13" }, 顧客コード: { value: "C001" } },
        { $id: { value: "14" }, 顧客コード: { value: "C001" } },
      ],
    });
    const tools = createKsqlMcpTools({ profile: "prod" }, deps);
    const result = await tools.mutate({
      sql: "UPSERT INTO APP300 (顧客コード) SELECT 顧客コード FROM APP100 ON DUPLICATE (顧客コード)",
      allowDml: true,
      confirmText: "yes",
      dmlMaxRows: 2,
    });

    expect(result).toMatchObject({ ok: true, type: "UPSERT", insertedCount: 0, updatedCount: 1 });
    expect(calls.post).toBe(0);
    expect(calls.put).toBe(1);
  });

  test("mutate: 単文 UPSERT_SELECT でも DML 承認3点セットは必須", async () => {
    const tools = createKsqlMcpTools({ profile: "prod" });
    const result = await tools.mutateTool({
      sql: "UPSERT INTO APP300 (顧客コード) SELECT 顧客コード FROM APP100 ON DUPLICATE (顧客コード)",
      allowDml: true,
      dmlMaxRows: 10,
    } as never);

    expect(result.isError).toBe(true);
    expect((result.structuredContent as { error: { message: string } }).error.message)
      .toContain("confirmText");
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

  test("LAPP saved query は defaultProfile と override profile で別の物理 app へ解決する", async () => {
    const dir = await mkdtemp(join(process.cwd(), ".tmp-mcp-logical-saved-"));
    const configPath = join(dir, "ksql.config.json");
    await writeFile(configPath, JSON.stringify({
      defaultProfile: "dev",
      mcp: { savedQueries: { path: "queries.json" } },
      profiles: {
        dev: { logicalApps: { ORDERS: 899 } },
        prod: { logicalApps: { ORDERS: 1234 } },
      },
    }), "utf8");
    const resolvedApps: number[] = [];
    const createRuntime = async (_options: KsqlRuntimeServerOptions, input: CreateKsqlRuntimeInput): Promise<KsqlRuntime> => {
      resolvedApps.push([...input.sqlContext!.bindings.values()][0].appId);
      return {
        sql: input.sqlContext!.normalizedSql,
        profileName: input.sqlContext!.profileName,
        client: makeClient(),
        cacheContext: input.sqlContext!.cacheContext,
        maxRecords: 500,
        fetchParallel: 1,
        onLimit: "error",
        timeout: 30000,
      };
    };
    const executeSql = async (): Promise<ExecuteResult> => ({
      type: "SELECT", columns: [], rows: [], rowCount: 0,
    });
    const tools = createKsqlMcpTools({ configPath }, { createRuntime, executeSql });
    try {
      await tools.saveQuery({
        name: "logical_orders",
        sql: "SELECT * FROM LAPP_ORDERS",
        defaultProfile: "dev",
        readOnly: true,
        allowProfileOverride: true,
      });
      await tools.runSavedQuery({ name: "logical_orders" });
      await tools.runSavedQuery({ name: "logical_orders", profile: "prod" });
      expect(resolvedApps).toEqual([899, 1234]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("runSavedQuery requires profile override opt-in and DML approval", async () => {
    const dir = await mkdtemp(join(process.cwd(), ".tmp-mcp-tools-"));
    const configPath = join(dir, "ksql.config.json");
    await writeFile(configPath, JSON.stringify({
      profiles: {
        prod: { baseUrl: "https://example.invalid", tokenMap: { APP100: "test-token" } },
        stg: { baseUrl: "https://example.invalid", tokenMap: { APP100: "test-token" } },
      },
    }), "utf8");
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
      { configPath, profile: "prod" },
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
    const configPath = join(dir, "ksql.config.json");
    await writeFile(configPath, JSON.stringify({
      profiles: {
        prod: { baseUrl: "https://example.invalid", tokenMap: { APP100: "test-token" } },
      },
    }), "utf8");
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
      { configPath, profile: "prod" },
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

  test("validate: バッチ内 ASSERT は statementType / isReadOnly / tempTablesReferenced が入る", async () => {
    const tools = createKsqlMcpTools({ profile: "prod" });
    const result = await tools.validate({
      sql:
        "CREATE TEMP TABLE #t AS SELECT $id FROM APP100;" +
        "ASSERT (SELECT COUNT(*) FROM #t) BETWEEN 1 AND 500",
    });

    expect(result.batch).toBe(true);
    expect(result.isReadOnlyBatch).toBe(true);
    expect(result.canRunWithQueryTool).toBe(true);
    expect(result.statements[1]).toMatchObject({
      index: 1,
      statementType: "ASSERT",
      isDml: false,
      isReadOnly: true,
      tempTablesReferenced: ["#t"],
      appIds: [],
    });
  });

  test("validate: 単文 ASSERT は従来スカラー形（statementType: ASSERT / isReadOnly: true）", async () => {
    const tools = createKsqlMcpTools({ profile: "prod" });
    const result = await tools.validate({
      sql: "ASSERT (SELECT COUNT(*) FROM APP100) = 0",
    });

    expect(result.batch).toBe(false);
    expect(result.statementType).toBe("ASSERT");
    expect(result.isReadOnly).toBe(true);
    expect(result.appIds).toEqual([100]);
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
      // 実 runtime と同じく input をそのまま解決（env / profile はテスト対象外）
      tempTableMaxRows: input.tempTableMaxRows,
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

  test("query: tempTableMaxRows が一時テーブルの実体化上限に効く（超過は error・後続 skipped）", async () => {
    const tools = createKsqlMcpTools(
      { profile: "prod" },
      makeBatchRuntimeDeps({ 100: BATCH_APP100 }) // 実体化 2 行
    );
    const result = await tools.query({
      sql: "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP100; SELECT 顧客名 FROM #t",
      tempTableMaxRows: 1,
    }) as {
      ok: boolean;
      statements: Array<{ status: string; error?: { message: string } }>;
    };

    expect(result.ok).toBe(false);
    expect(result.statements[0].status).toBe("error");
    expect(result.statements[0].error?.message).toMatch(/取得件数が上限（1 件）を超えました/);
    expect(result.statements[1].status).toBe("skipped");
  });

  test("query: tempTableMaxRows 指定で既定 10,000 を超える実体化が可能・未指定は従来どおりエラー", async () => {
    // fetchAll のページング（limit/offset + $id カーソル）に応答するモック。
    // makeBatchRuntimeDeps は全件を毎回返すため 10,000 件超のテストには使えない
    const manyRows = Array.from({ length: 10001 }, (_v, i) => ({
      $id: { value: String(i + 1) },
      顧客名: { value: `会社${i + 1}` },
    }));
    function makePagingDeps() {
      const client: KintoneClient = {
        async getRecords(params) {
          const limitMatch = /limit (\d+) offset (\d+)/.exec(params.query);
          const limit = limitMatch ? Number(limitMatch[1]) : 500;
          const offset = limitMatch ? Number(limitMatch[2]) : 0;
          const cursorMatch = /\$id > (\d+)/.exec(params.query);
          const cursor = cursorMatch ? Number(cursorMatch[1]) : 0;
          const filtered = manyRows.filter((r) => Number(r.$id.value) > cursor);
          return { records: filtered.slice(offset, offset + limit) as never };
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
        cacheContext: "paging-batch-test",
        maxRecords: input.maxRecords ?? 500,
        fetchParallel: input.fetchParallel ?? 3,
        onLimit: input.onLimit ?? "error",
        timeout: input.timeout ?? 30000,
        tempTableMaxRows: input.tempTableMaxRows,
      });
      return { createRuntime };
    }
    const sql = "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP100; SELECT COUNT(*) AS 件数 FROM #t";

    // 未指定: エンジン既定 TEMP_TABLE_MAX_ROWS(10,000)で従来どおりエラー（回帰）
    const toolsDefault = createKsqlMcpTools({ profile: "prod" }, makePagingDeps());
    const defaultResult = await toolsDefault.query({ sql }) as {
      ok: boolean;
      statements: Array<{ status: string; error?: { message: string } }>;
    };
    expect(defaultResult.ok).toBe(false);
    expect(defaultResult.statements[0].error?.message).toMatch(/取得件数が上限（10000 件）を超えました/);

    // 指定: 10,001 行の実体化が成功する
    const toolsRaised = createKsqlMcpTools({ profile: "prod" }, makePagingDeps());
    const raisedResult = await toolsRaised.query({ sql, tempTableMaxRows: 20000 }) as {
      ok: boolean;
      statements: Array<Record<string, unknown>>;
      results: Array<{ rows: Array<Record<string, string>> }>;
    };
    expect(raisedResult.ok).toBe(true);
    expect(raisedResult.statements[0]).toMatchObject({ status: "success", rowCount: 10001 });
    expect(raisedResult.results[0].rows).toEqual([{ 件数: "10001" }]);
  });

  test("query: onLimit truncate を指定しても一時テーブルの実体化は error のまま（§5.6 不変条件）", async () => {
    const tools = createKsqlMcpTools(
      { profile: "prod" },
      makeBatchRuntimeDeps({ 100: BATCH_APP100 }) // 実体化 2 行
    );
    const result = await tools.query({
      sql: "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP100; SELECT 顧客名 FROM #t",
      tempTableMaxRows: 1,
      onLimit: "truncate",
    }) as {
      ok: boolean;
      statements: Array<{ status: string; error?: { message: string } }>;
    };

    // truncate で 1 行に切り詰められることはなく、実体化は常に error
    expect(result.ok).toBe(false);
    expect(result.statements[0].status).toBe("error");
    expect(result.statements[0].error?.message).toMatch(/取得件数が上限（1 件）を超えました/);
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
    const runtimeInputs: CreateKsqlRuntimeInput[] = [];
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
    ): Promise<KsqlRuntime> => {
      runtimeInputs.push(input);
      return {
        sql: input.sql,
        profileName: input.profile ?? "prod",
        client,
        cacheContext: "mutate-batch-test",
        // 実 runtime(createKsqlRuntime)と同じく、input 未指定なら既定 500 を解決する
        maxRecords: input.maxRecords ?? 500,
        fetchParallel: input.fetchParallel ?? 3,
        onLimit: input.onLimit ?? "error",
        timeout: input.timeout ?? 30000,
        tempTableMaxRows: input.tempTableMaxRows,
      };
    };
    return { deps: { createRuntime }, calls, runtimeInputs };
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

  test("mutate: バッチ内の APP ソース INSERT_SELECT を実行できる(v1.5.0 解禁)", async () => {
    const { deps, calls } = makeMutateRuntimeDeps({
      200: [
        { $id: { value: "1" }, 顧客名: { value: "A社" } },
        { $id: { value: "2" }, 顧客名: { value: "B社" } },
      ],
    });
    const tools = createKsqlMcpTools({ profile: "prod" }, deps);
    const result = await tools.mutate({
      ...MUTATE_BASE,
      sql: "INSERT INTO APP100 (x) VALUES ('a'); INSERT INTO APP300 (名前) SELECT 顧客名 FROM APP200",
      dmlMaxRows: 10,
    }) as { ok: boolean; statements: Array<Record<string, unknown>> };

    expect(result.ok).toBe(true);
    expect(result.statements[0]).toMatchObject({ type: "INSERT", status: "success", insertedCount: 1 });
    expect(result.statements[1]).toMatchObject({ type: "INSERT_SELECT", status: "success", insertedCount: 2 });
    expect(calls.post).toBe(2);
  });

  test("mutate: 混在ソース(#t JOIN APP)の INSERT_SELECT を実行できる(v1.7.0 解禁)", async () => {
    const { deps, calls } = makeMutateRuntimeDeps({
      100: [
        { $id: { value: "1" }, 顧客名: { value: "A社" } },
        { $id: { value: "2" }, 顧客名: { value: "B社" } },
      ],
      300: [
        { $id: { value: "1" }, 顧客名: { value: "A社" }, 地域: { value: "東京" } }, // A社のみ JOIN 一致
      ],
    });
    const tools = createKsqlMcpTools({ profile: "prod" }, deps);
    const result = await tools.mutate({
      ...MUTATE_BASE,
      sql:
        "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP100;" +
        "INSERT INTO APP200 (名前, 地域) SELECT a.顧客名, b.地域 FROM #t a INNER JOIN APP300 b ON a.顧客名 = b.顧客名",
      dmlMaxRows: 10,
    }) as { ok: boolean; statements: Array<Record<string, unknown>> };

    expect(result.ok).toBe(true);
    expect(result.statements[1]).toMatchObject({ type: "INSERT_SELECT", status: "success", insertedCount: 1 });
    expect(calls.post).toBe(1);
  });

  test("mutate: 混在ソース INSERT_SELECT の dmlMaxRows 超過は当該文 POST ゼロ件", async () => {
    const { deps, calls } = makeMutateRuntimeDeps({
      100: [
        { $id: { value: "1" }, 顧客名: { value: "A社" } },
        { $id: { value: "2" }, 顧客名: { value: "B社" } },
        { $id: { value: "3" }, 顧客名: { value: "C社" } },
      ],
      300: [
        { $id: { value: "1" }, 顧客名: { value: "A社" } },
        { $id: { value: "2" }, 顧客名: { value: "B社" } },
        { $id: { value: "3" }, 顧客名: { value: "C社" } },
      ],
    });
    const tools = createKsqlMcpTools({ profile: "prod" }, deps);
    const result = await tools.mutate({
      ...MUTATE_BASE,
      // JOIN 結果 3 行 > dmlMaxRows 2 → confirm で書き込み前拒否(fail-fast)
      sql:
        "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP100;" +
        "INSERT INTO APP200 (名前) SELECT a.顧客名 FROM #t a INNER JOIN APP300 b ON a.顧客名 = b.顧客名",
      dmlMaxRows: 2,
    }) as { ok: boolean; statements: Array<Record<string, unknown>> };

    expect(result.ok).toBe(false);
    expect(result.statements[1]).toMatchObject({ status: "error" });
    expect((result.statements[1].error as { message: string }).message)
      .toMatch(/INSERT affected rows \(3\) exceed dmlMaxRows \(2\)/);
    expect(calls.post).toBe(0);
  });

  test("mutate: 混在ソースの JOIN APP 側 fetch は dmlMaxRows で絞られず、影響行数が収まれば成功", async () => {
    // v1.7.0 実機確認で発覚した再現シナリオ(CREATE TEMP TABLE ... LIMIT n; UPSERT ... JOIN)。
    // 旧仕様では JOIN の APP300 側 4 行が dmlMaxRows + 1 = 3 で読み取り失敗していた。
    // 案A(v1.8.0)では読み取りは runtime maxRecords(既定 500)に従い、JOIN 結果 1 行 ≦
    // dmlMaxRows で成功する
    const { deps, calls, runtimeInputs } = makeMutateRuntimeDeps({
      100: [
        { $id: { value: "1" }, 顧客名: { value: "A社" } },
      ],
      300: [
        { $id: { value: "1" }, 顧客名: { value: "A社" } },
        { $id: { value: "2" }, 顧客名: { value: "B社" } },
        { $id: { value: "3" }, 顧客名: { value: "C社" } },
        { $id: { value: "4" }, 顧客名: { value: "D社" } },
      ],
    });
    const tools = createKsqlMcpTools({ profile: "prod" }, deps);
    const result = await tools.mutate({
      ...MUTATE_BASE,
      sql:
        "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP100;" +
        "INSERT INTO APP200 (名前) SELECT a.顧客名 FROM #t a INNER JOIN APP300 b ON a.顧客名 = b.顧客名",
      dmlMaxRows: 2,
    }) as { ok: boolean; statements: Array<Record<string, unknown>> };

    expect(result.ok).toBe(true);
    expect(result.statements[1]).toMatchObject({
      type: "INSERT_SELECT",
      status: "success",
      insertedCount: 1,
    });
    expect(runtimeInputs[0]?.maxRecords).toBeUndefined(); // runtime の通常解決に委ねる
    expect(calls.post).toBe(1);
    expect(calls.put).toBe(0);
  });

  test("mutate: tempTableMaxRows 超過は実体化で error・書き込みゼロ件", async () => {
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
        "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP100;" +
        "INSERT INTO APP200 (名前) SELECT 顧客名 FROM #t",
      dmlMaxRows: 10,
      tempTableMaxRows: 2, // 実体化 3 行 > 2
    }) as { ok: boolean; statements: Array<Record<string, unknown>> };

    expect(result.ok).toBe(false);
    expect(result.statements[0]).toMatchObject({ status: "error" });
    expect((result.statements[0].error as { message: string }).message)
      .toMatch(/取得件数が上限（2 件）を超えました/);
    expect(result.statements[1]).toMatchObject({ status: "skipped" });
    expect(calls.post).toBe(0);
  });

  test("mutate: tempTableMaxRows で実体化が通っても dmlMaxRows / 書き込みガードは不変", async () => {
    const records = {
      100: [
        { $id: { value: "1" }, 顧客名: { value: "A社" } },
        { $id: { value: "2" }, 顧客名: { value: "B社" } },
        { $id: { value: "3" }, 顧客名: { value: "C社" } },
      ],
    };
    const sql =
      "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP100;" +
      "INSERT INTO APP200 (名前) SELECT 顧客名 FROM #t";

    // 実体化 3 行 ≦ tempTableMaxRows 5 だが、INSERT 3 行 > dmlMaxRows 2 → confirm で書き込み前拒否
    const guarded = makeMutateRuntimeDeps(records);
    const guardedResult = await createKsqlMcpTools({ profile: "prod" }, guarded.deps).mutate({
      ...MUTATE_BASE,
      sql,
      dmlMaxRows: 2,
      tempTableMaxRows: 5,
    }) as { ok: boolean; statements: Array<Record<string, unknown>> };
    expect(guardedResult.ok).toBe(false);
    expect((guardedResult.statements[1].error as { message: string }).message)
      .toMatch(/INSERT affected rows \(3\) exceed dmlMaxRows \(2\)/);
    expect(guarded.calls.post).toBe(0);

    // dmlMaxRows 内なら成功
    const allowed = makeMutateRuntimeDeps(records);
    const allowedResult = await createKsqlMcpTools({ profile: "prod" }, allowed.deps).mutate({
      ...MUTATE_BASE,
      sql,
      dmlMaxRows: 10,
      tempTableMaxRows: 5,
    }) as { ok: boolean; statements: Array<Record<string, unknown>> };
    expect(allowedResult.ok).toBe(true);
    expect(allowedResult.statements[1]).toMatchObject({
      type: "INSERT_SELECT",
      status: "success",
      insertedCount: 3,
    });
    expect(allowed.calls.post).toBe(1);
  });

  test("mutate: バッチの SELECT-based DML が runtime maxRecords 超で失敗した場合はヒントを付与する", async () => {
    const { deps, calls } = makeMutateRuntimeDeps({
      100: [
        { $id: { value: "1" }, 顧客名: { value: "A社" } },
      ],
      300: Array.from({ length: 501 }, (_v, i) => ({
        $id: { value: String(i + 1) },
        顧客名: { value: `会社${i + 1}` },
      })),
    });
    const tools = createKsqlMcpTools({ profile: "prod" }, deps);
    const result = await tools.mutate({
      ...MUTATE_BASE,
      sql:
        "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP100;" +
        "INSERT INTO APP200 (名前) SELECT a.顧客名 FROM #t a INNER JOIN APP300 b ON a.顧客名 = b.顧客名",
      dmlMaxRows: 2,
    }) as { ok: boolean; statements: Array<Record<string, unknown>> };

    expect(result.ok).toBe(false);
    expect(result.statements[1]).toMatchObject({ type: "INSERT_SELECT", status: "error" });
    expect((result.statements[1].error as { message: string }).message)
      .toMatch(/取得件数が上限（500 件）を超えました.*dmlMaxRows は影響行数ガードです/);
    expect(calls.post).toBe(0);
  });

  test("mutate: SELECT-based DML を含まないバッチの読み取り上限は従来どおり dmlMaxRows + 1", async () => {
    const { deps, runtimeInputs } = makeMutateRuntimeDeps({
      100: [{ $id: { value: "1" }, ステータス: { value: "対応中" } }],
    });
    const tools = createKsqlMcpTools({ profile: "prod" }, deps);
    const result = await tools.mutate({
      ...MUTATE_BASE,
      sql: "INSERT INTO APP100 (顧客名) VALUES ('A社'); UPDATE APP100 SET ステータス = '完了' WHERE $id = 1",
      dmlMaxRows: 2,
    }) as { ok: boolean };

    expect(result.ok).toBe(true);
    expect(runtimeInputs[0]?.maxRecords).toBe(3); // dmlMaxRows + 1(超過検出用)
  });

  test("mutate: dmlTotalMaxRows は INSERT VALUES(静的)と APP ソース INSERT_SELECT(confirm)を二重計上なしで合算する", async () => {
    const { deps, calls } = makeMutateRuntimeDeps({
      200: [
        { $id: { value: "1" }, 顧客名: { value: "A社" } },
        { $id: { value: "2" }, 顧客名: { value: "B社" } },
      ],
    });
    const tools = createKsqlMcpTools({ profile: "prod" }, deps);
    const result = await tools.mutate({
      ...MUTATE_BASE,
      // INSERT VALUES 2 行(静的) + INSERT_SELECT 2 行(confirm 加算) = 4 > dmlTotalMaxRows 3
      // (二重計上があれば合計は 6 と報告されるため、メッセージの (4) が非二重計上の証明になる)
      sql: "INSERT INTO APP100 (x) VALUES ('a'), ('b'); INSERT INTO APP300 (名前) SELECT 顧客名 FROM APP200",
      dmlMaxRows: 10,
      dmlTotalMaxRows: 3,
    }) as { ok: boolean; statements: Array<Record<string, unknown>> };

    expect(result.ok).toBe(false);
    expect(result.statements[0]).toMatchObject({ status: "success", insertedCount: 2 });
    expect(result.statements[1]).toMatchObject({ status: "error" });
    expect((result.statements[1].error as { message: string }).message)
      .toMatch(/batch affected rows \(4\) exceed dmlTotalMaxRows \(3\)/);
    expect(calls.post).toBe(1); // INSERT_SELECT の書き込み前に止まる
  });

  test("mutate: バッチ内の APP ソース UPSERT_SELECT を実行できる(v1.6.0 解禁)", async () => {
    const { deps, calls } = makeMutateRuntimeDeps({
      200: [
        { $id: { value: "1" }, 顧客コード: { value: "C001" } },
        { $id: { value: "2" }, 顧客コード: { value: "C003" } },
      ],
      300: [
        { $id: { value: "9" }, 顧客コード: { value: "C001" } }, // update 対象
      ],
    });
    const tools = createKsqlMcpTools({ profile: "prod" }, deps);
    const result = await tools.mutate({
      ...MUTATE_BASE,
      sql:
        "INSERT INTO APP100 (x) VALUES ('a'); " +
        "UPSERT INTO APP300 (顧客コード) SELECT 顧客コード FROM APP200 ON DUPLICATE (顧客コード)",
      dmlMaxRows: 10,
    }) as { ok: boolean; statements: Array<Record<string, unknown>> };

    expect(result.ok).toBe(true);
    expect(result.statements[0]).toMatchObject({ type: "INSERT", status: "success", insertedCount: 1 });
    expect(result.statements[1]).toMatchObject({
      type: "UPSERT_SELECT",
      status: "success",
      insertedCount: 1,
      updatedCount: 1,
    });
    expect(calls.put).toBe(1);
  });

  test("mutate: dmlTotalMaxRows は INSERT VALUES(静的)と UPSERT_SELECT(confirm)を二重計上なしで合算する", async () => {
    const { deps, calls } = makeMutateRuntimeDeps({
      200: [
        { $id: { value: "1" }, 顧客コード: { value: "C001" } },
        { $id: { value: "2" }, 顧客コード: { value: "C003" } },
      ],
      300: [
        { $id: { value: "9" }, 顧客コード: { value: "C001" } },
      ],
    });
    const tools = createKsqlMcpTools({ profile: "prod" }, deps);
    const result = await tools.mutate({
      ...MUTATE_BASE,
      // INSERT VALUES 2 行(静的) + UPSERT_SELECT 2 行(update 1 + insert 1、confirm 加算) = 4 > 3
      sql:
        "INSERT INTO APP100 (x) VALUES ('a'), ('b'); " +
        "UPSERT INTO APP300 (顧客コード) SELECT 顧客コード FROM APP200 ON DUPLICATE (顧客コード)",
      dmlMaxRows: 10,
      dmlTotalMaxRows: 3,
    }) as { ok: boolean; statements: Array<Record<string, unknown>> };

    expect(result.ok).toBe(false);
    expect(result.statements[0]).toMatchObject({ status: "success", insertedCount: 2 });
    expect(result.statements[1]).toMatchObject({ status: "error" });
    expect((result.statements[1].error as { message: string }).message)
      .toMatch(/batch affected rows \(4\) exceed dmlTotalMaxRows \(3\)/);
    expect(calls.put).toBe(0); // UPSERT_SELECT の書き込み前に止まる
    expect(calls.post).toBe(1); // 先行 INSERT の1回のみ
  });

  test("mutate: 一時テーブルソースの UPSERT_SELECT を実行できる(v1.7.0 解禁)", async () => {
    const { deps, calls } = makeMutateRuntimeDeps({
      100: [
        { $id: { value: "1" }, 顧客コード: { value: "C001" } },
        { $id: { value: "2" }, 顧客コード: { value: "C003" } },
      ],
      300: [
        { $id: { value: "9" }, 顧客コード: { value: "C001" } }, // update 対象
      ],
    });
    const tools = createKsqlMcpTools({ profile: "prod" }, deps);
    const result = await tools.mutate({
      ...MUTATE_BASE,
      sql:
        "CREATE TEMP TABLE #t AS SELECT 顧客コード FROM APP100;" +
        "UPSERT INTO APP300 (顧客コード) SELECT 顧客コード FROM #t ON DUPLICATE (顧客コード)",
      dmlMaxRows: 10,
    }) as { ok: boolean; statements: Array<Record<string, unknown>> };

    expect(result.ok).toBe(true);
    expect(result.statements[1]).toMatchObject({
      type: "UPSERT_SELECT",
      status: "success",
      insertedCount: 1,
      updatedCount: 1,
    });
    expect(calls.put).toBe(1);
  });

  test("mutate: dmlTotalMaxRows は INSERT VALUES(静的)と temp ソース UPSERT_SELECT(confirm)を合算する", async () => {
    const { deps, calls } = makeMutateRuntimeDeps({
      100: [
        { $id: { value: "1" }, 顧客コード: { value: "C001" } },
        { $id: { value: "2" }, 顧客コード: { value: "C003" } },
      ],
      300: [
        { $id: { value: "9" }, 顧客コード: { value: "C001" } },
      ],
    });
    const tools = createKsqlMcpTools({ profile: "prod" }, deps);
    const result = await tools.mutate({
      ...MUTATE_BASE,
      // INSERT VALUES 2 行(静的) + UPSERT_SELECT 2 行(confirm 加算) = 4 > 3
      sql:
        "INSERT INTO APP200 (x) VALUES ('a'), ('b'); " +
        "CREATE TEMP TABLE #t AS SELECT 顧客コード FROM APP100;" +
        "UPSERT INTO APP300 (顧客コード) SELECT 顧客コード FROM #t ON DUPLICATE (顧客コード)",
      dmlMaxRows: 10,
      dmlTotalMaxRows: 3,
    }) as { ok: boolean; statements: Array<Record<string, unknown>> };

    expect(result.ok).toBe(false);
    expect(result.statements[0]).toMatchObject({ status: "success", insertedCount: 2 });
    expect(result.statements[2]).toMatchObject({ status: "error" });
    expect((result.statements[2].error as { message: string }).message)
      .toMatch(/batch affected rows \(4\) exceed dmlTotalMaxRows \(3\)/);
    expect(calls.put).toBe(0); // UPSERT_SELECT の書き込み前に止まる
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

  // ----------------------------------------------------------------
  // UPSERT のガード対象の回帰(doc-drift 修正 提案A)
  // 実装は従来から confirm(insert + update 合計)経由で dmlMaxRows /
  // dmlTotalMaxRows の対象。ドキュメント修正の裏付けとして固定する
  // ----------------------------------------------------------------

  test("mutate: 単文 UPSERT は照合後の insert + update 合計に dmlMaxRows が効く(書き込み前拒否)", async () => {
    const { deps, calls } = makeMutateRuntimeDeps({
      100: [
        { $id: { value: "1" }, 顧客コード: { value: "C001" }, ステータス: { value: "旧" } },
        { $id: { value: "2" }, 顧客コード: { value: "C002" }, ステータス: { value: "旧" } },
      ],
    });
    const tools = createKsqlMcpTools({ profile: "prod" }, deps);
    // C001 は既存(update)、C003 / C004 は新規(insert) → 合計 3 > dmlMaxRows 2
    // 超過メッセージは confirm の operation("UPDATE")表記になる(仕様 §3.4 の既知課題)
    await expect(tools.mutate({
      ...MUTATE_BASE,
      sql:
        "UPSERT INTO APP100 (顧客コード, ステータス) VALUES ('C001', '新'), ('C003', '新'), ('C004', '新') " +
        "ON DUPLICATE (顧客コード)",
      dmlMaxRows: 2,
    })).rejects.toThrow(/UPDATE affected rows \(3\) exceed dmlMaxRows \(2\)/);
    expect(calls.post).toBe(0); // POST / PUT とも書き込み前に止まる
    expect(calls.put).toBe(0);
  });

  test("mutate: dmlTotalMaxRows は INSERT VALUES(静的)と UPSERT(confirm)を二重計上なしで合算する", async () => {
    const { deps, calls } = makeMutateRuntimeDeps({
      200: [
        { $id: { value: "1" }, 顧客コード: { value: "C001" } },
      ],
    });
    const tools = createKsqlMcpTools({ profile: "prod" }, deps);
    const result = await tools.mutate({
      ...MUTATE_BASE,
      // INSERT VALUES 2 行(静的) + UPSERT 2 行(C001 = update / C003 = insert、confirm 加算) = 4 > 3
      // (UPSERT が静的にも計上される二重計上があれば合計は 6 と報告される)
      sql:
        "INSERT INTO APP100 (顧客コード) VALUES ('A'), ('B'); " +
        "UPSERT INTO APP200 (顧客コード) VALUES ('C001'), ('C003') ON DUPLICATE (顧客コード)",
      dmlMaxRows: 10,
      dmlTotalMaxRows: 3,
    }) as { ok: boolean; statements: Array<Record<string, unknown>> };

    expect(result.ok).toBe(false);
    expect(result.statements[0]).toMatchObject({ status: "success", insertedCount: 2 });
    expect(result.statements[1]).toMatchObject({ status: "error" });
    expect((result.statements[1].error as { message: string }).message)
      .toMatch(/batch affected rows \(4\) exceed dmlTotalMaxRows \(3\)/);
    expect(calls.put).toBe(0); // UPSERT の書き込み(POST / PUT)は実行されない
    expect(calls.post).toBe(1); // 先行 INSERT の1回のみ
  });
});
