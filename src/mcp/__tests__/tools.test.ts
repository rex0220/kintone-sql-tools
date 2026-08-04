import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseSqlStatement,
  statementHasApplyBlocks,
  type BatchExecuteResult,
  type ExecuteOptions,
  type ExecuteResult,
  type KintoneClient,
} from "../../core";
import type { CreateKsqlRuntimeInput, KsqlRuntime, KsqlRuntimeServerOptions } from "../../node/runtime";
import { createServer } from "../index";
import {
  createKsqlMcpTools,
  MCP_IMPORT_SOURCE_REQUIRED_MESSAGE,
  toMcpImportError,
} from "../tools";
import {
  explainInputSchema,
  mutateInputSchema,
  queryInputSchema,
  validateInputSchema,
} from "../schemas";

const DML_VALIDATION_COLUMNS = [
  "code", "$err_statement", "$err_operation", "$err_row", "$err_field", "$err_code", "$err_message",
  "$err_value", "$err_subtable", "$err_subrow", "$err_subrow_id",
];

function makeClient(): KintoneClient {
  return {
    async getRecords() { return { records: [] }; },
    async openCursor() { throw new Error("unexpected cursor call"); },
    async postRecords() { return { ids: [] }; },
    async putRecords() { },
    async deleteRecords() { },
    async getApps() { return []; },
    async getFields() {
      return [
        { code: "顧客名", label: "顧客名", fieldType: "SINGLE_LINE_TEXT" },
        { code: "ステータス", label: "ステータス", fieldType: "STATUS" },
      ];
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() { return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const }; },
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

  test("B50 tools/list descriptions expose metadata roles and the dialect reference", () => {
    const registered = (createServer({ help: false }) as unknown as {
      _registeredTools: Record<string, { description?: string }>;
    })._registeredTools;

    expect(Object.keys(registered)).toEqual([
      "ksql_validate", "ksql_explain", "ksql_query", "ksql_mutate",
      "ksql_describe_app", "ksql_app_metadata", "ksql_show_apps",
      "ksql_docs",
      "ksql_save_query", "ksql_list_queries", "ksql_get_query",
      "ksql_run_saved_query", "ksql_delete_query",
    ]);
    for (const key of ["fields", "constraints", "raw", "fixed GET allowlist", "records", "mutation"]) {
      expect(registered.ksql_app_metadata.description).toContain(key);
    }
    for (const key of ["field code", "label", "type", "ksql_app_metadata"]) {
      expect(registered.ksql_describe_app.description).toContain(key);
    }
    expect(registered.ksql_query.description).toContain("ksql://language-reference");
    expect(registered.ksql_query.description).toContain("ksql_docs when resources are unavailable");
    expect(registered.ksql_mutate.description).toContain("ksql://language-reference");
    expect(registered.ksql_mutate.description).toContain("ksql_docs when resources are unavailable");
    expect(registered.ksql_validate.description).toContain("Do not use validate probing");
  });

  test("B65-SD12: ksql_validate は DISTINCT + ROLLUP を static に受理する", async () => {
    const tools = createKsqlMcpTools({ profile: "prod" });
    const result = await tools.validateTool({
      sql: "SELECT DISTINCT 会社名, SUM(売上) FROM APP1 GROUP BY ROLLUP(会社名)",
    });
    const payload = result.structuredContent as {
      ok: true;
      statementType: string;
      requiresCompleteInput: boolean;
    };

    expect(result.isError).toBe(false);
    expect(payload).toMatchObject({
      ok: true,
      statementType: "SELECT",
      requiresCompleteInput: true,
    });
  });

  test("B67: ksql_validate は相対日付を構文/引数だけ検査し実行可能とは断定しない", async () => {
    const tools = createKsqlMcpTools({ profile: "prod" });
    await expect(tools.validate({
      sql: "SELECT 日付 FROM APP100 WHERE 日付 = YESTERDAY()",
    })).resolves.toMatchObject({
      ok: true,
      validationScope: "syntax-and-arguments-only",
      executionValidated: false,
      finalValidation: "ksql_query/ksql_explain/runtime schema-aware plan",
    });
    expect(validateInputSchema.shape.sql.description)
      .toContain("final schema-aware decision");
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

  test("explain resolves form metadata through the runtime client", async () => {
    let runtimeCalls = 0;
    const tools = createKsqlMcpTools({ profile: "prod" }, {
      createRuntime: async (_options, input) => {
        runtimeCalls += 1;
        return {
          sql: input.sql,
          client: makeClient(),
          maxRecords: 10_000,
          fetchParallel: 1,
          onLimit: "error",
          timeout: 30_000,
          cacheContext: "mcp-explain-schema",
          profileName: "prod",
        };
      },
    });
    const result = await tools.explain({
      sql: "SELECT 顧客名 FROM APP100 WHERE ステータス = '完了'",
    });

    expect(result.ok).toBe(true);
    expect(result.type).toBe("SELECT");
    expect(result.columns).toEqual(["plan"]);
    expect(JSON.stringify(result.rows)).toContain("mode:");
    expect(JSON.stringify(result.rows)).toContain("metadata API: form definition APP100");
    expect(runtimeCalls).toBe(1);
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

  test("query: VALIDATE ONLY はread-only分類されtruncateをerrorへ上書きする", async () => {
    const runtimeInputs: CreateKsqlRuntimeInput[] = [];
    const createRuntime = async (_options: KsqlRuntimeServerOptions, input: CreateKsqlRuntimeInput): Promise<KsqlRuntime> => {
      runtimeInputs.push(input);
      return {
        sql: input.sql, profileName: "prod", client: makeClient(), cacheContext: "validate-mcp",
        maxRecords: input.maxRecords ?? 500, fetchParallel: input.fetchParallel ?? 3,
        onLimit: input.onLimit ?? "truncate", timeout: input.timeout ?? 30000,
      };
    };
    const executeSql = async (): Promise<ExecuteResult> => ({
      type: "VALIDATION", operation: "INSERT", validatedRows: 1, validRows: 1,
      invalidRows: 0, errorCount: 0, columns: DML_VALIDATION_COLUMNS, errors: [],
    });
    const tools = createKsqlMcpTools({ profile: "prod" }, { createRuntime, executeSql });
    const validation = await tools.validate({ sql: "INSERT INTO APP100 (code) VALUES ('A') VALIDATE ONLY" });
    expect(validation).toMatchObject({
      isReadOnly: true, isDml: false, containsDml: false, containsValidationOnly: true,
      requiresCompleteInput: true, canRunWithQueryTool: true, requiresMutationTool: false,
    });
    const result = await tools.query({ sql: "INSERT INTO APP100 (code) VALUES ('A') VALIDATE ONLY", onLimit: "truncate" });
    expect(runtimeInputs[0].onLimit).toBe("error");
    expect(result).toMatchObject({ ok: true, type: "VALIDATION", validatedRows: 1, errorCount: 0 });
    expect(result.columns).toEqual(DML_VALIDATION_COLUMNS);
  });

  test("B44 Phase 5: query VALIDATE ONLY payload は apply/guards を欠落させず既定100を返す", async () => {
    const createRuntime = async (_options: KsqlRuntimeServerOptions, input: CreateKsqlRuntimeInput): Promise<KsqlRuntime> => ({
      sql: input.sql, profileName: "prod", client: makeClient(), cacheContext: "apply-validate-mcp",
      maxRecords: 500, fetchParallel: 1, onLimit: "error", timeout: 30_000,
    });
    const executeSql = async (): Promise<ExecuteResult> => ({
      type: "VALIDATION", operation: "UPDATE", validatedRows: 1, validRows: 1,
      invalidRows: 0, errorCount: 0, columns: [], errors: [],
      apply: [{
        field: "テーブル", operations: [
          { kind: "PATCH", matchedRows: 2, changedRows: 2 },
          { kind: "APPEND", addedRows: 1 },
        ],
        changedSubtableRows: 3, deletedRows: 0,
      }],
      guards: {
        revisionRequired: true, parentRows: 1, dmlMaxRows: 100,
        subtableRows: 3, dmlMaxSubtableRows: 500, wouldExceed: false,
      },
      deletedRows: { total: 0, parentRows: 0 },
    });
    const tools = createKsqlMcpTools({ profile: "prod" }, { createRuntime, executeSql });
    const result = await tools.query({
      sql: "UPDATE APP4221 SET 親='x' WHERE $id=8 APPLY テーブル (PATCH SET 子='y' ALL ROWS; APPEND (子) VALUES ('new')) VALIDATE ONLY",
    });
    expect(result).toMatchObject({
      apply: [{ field: "テーブル", operations: [
        { kind: "PATCH", matchedRows: 2, changedRows: 2 },
        { kind: "APPEND", addedRows: 1 },
      ] }],
      guards: { dmlMaxSubtableRows: 500, wouldExceed: false },
      deletedRows: { total: 0, parentRows: 0 },
    });
    expect("dmlMaxSubtableRows" in queryInputSchema.shape).toBe(false);
  });

  test("B44 Phase 6: validate/explain は APPLY AST を受理する", async () => {
    const sql = "UPDATE APP4221 SET 親='x' WHERE $id=8 APPLY テーブル (PATCH SET 子='y' ALL ROWS)";
    const createRuntime = jest.fn(async (_options: KsqlRuntimeServerOptions, input: CreateKsqlRuntimeInput): Promise<KsqlRuntime> => ({
      sql: input.sql, profileName: "prod", client: makeClient(), cacheContext: "apply-explain-mcp",
      maxRecords: 500, fetchParallel: 1, onLimit: "error", timeout: 30_000,
    }));
    const executeSql = jest.fn(async (): Promise<ExecuteResult> => ({
      type: "SELECT", columns: ["plan"], rows: [{ plan: "UPDATE APPLY PATCH" }], rowCount: 1,
    }));
    const tools = createKsqlMcpTools({ profile: "prod" }, { createRuntime, executeSql });
    await expect(tools.validate({ sql })).resolves.toMatchObject({ statementType: "UPDATE", isDml: true });
    await expect(tools.explain({ sql })).resolves.toMatchObject({ ok: true, rows: [{ plan: "UPDATE APPLY PATCH" }] });
    expect(createRuntime).toHaveBeenCalledTimes(1);
    expect(executeSql).toHaveBeenCalledTimes(1);
  });

  test("query: IMPORT ... VALIDATE ONLY は importSources 供給で capability gate を通す（回帰）", async () => {
    // 修正前は query の再パースに import フラグを渡しておらず「capability is disabled」で落ちていた。
    const executeSql = async (): Promise<ExecuteResult> => ({
      type: "VALIDATION", operation: "INSERT", validatedRows: 1, validRows: 1,
      invalidRows: 0, errorCount: 0, columns: ["code", "$err_code"], errors: [],
    });
    const createRuntime = async (_o: KsqlRuntimeServerOptions, input: CreateKsqlRuntimeInput): Promise<KsqlRuntime> => ({
      sql: input.sql, profileName: "prod", client: makeClient(), cacheContext: "import-validate-mcp",
      maxRecords: input.maxRecords ?? 500, fetchParallel: input.fetchParallel ?? 3,
      onLimit: input.onLimit ?? "error", timeout: input.timeout ?? 30000,
    });
    const tools = createKsqlMcpTools({ profile: "prod" }, { createRuntime, executeSql });
    const result = await tools.query({
      sql: "IMPORT INTO APP100 (code) FROM CSV src BY NAME VALIDATE ONLY",
      importSources: [{ name: "src", text: "code\nA\n" }],
    });
    expect(result).toMatchObject({ ok: true, type: "VALIDATION" });
    await expect(tools.query({ sql: "IMPORT INTO APP100 (code) FROM CSV src BY NAME VALIDATE ONLY" }))
      .rejects.toThrow("importSources");
  });

  test("query: leading VALIDATE is read-only and forces truncate to error", async () => {
    const runtimeInputs: CreateKsqlRuntimeInput[] = [];
    const createRuntime = async (_options: KsqlRuntimeServerOptions, input: CreateKsqlRuntimeInput): Promise<KsqlRuntime> => {
      runtimeInputs.push(input);
      return {
        sql: input.sql, profileName: "prod", client: makeClient(), cacheContext: "validate-existing-mcp",
        maxRecords: input.maxRecords ?? 500, fetchParallel: input.fetchParallel ?? 3,
        onLimit: input.onLimit ?? "truncate", timeout: input.timeout ?? 30000,
      };
    };
    const executeSql = async (): Promise<ExecuteResult> => ({
      type: "SELECT", columns: ["$id", "$err_field", "$err_code", "$err_message", "$err_value"],
      rows: [{ $id: "1", $err_field: "code", $err_code: "ERR_REQUIRED", $err_message: "required", $err_value: "" }],
      rowCount: 1,
      validateStats: {
        errorRecords: 1,
        errorCount: 2,
        constraintMetadata: {
          present: ["choice"],
          absent: ["required", "length", "range"],
        },
      },
    });
    const tools = createKsqlMcpTools({ profile: "prod" }, { createRuntime, executeSql });
    const validation = await tools.validate({ sql: "VALIDATE APP100" });
    expect(validation).toMatchObject({
      isReadOnly: true, isDml: false, containsDml: false,
      requiresCompleteInput: true, canRunWithQueryTool: true, requiresMutationTool: false,
    });
    const result = await tools.query({ sql: "VALIDATE APP100", onLimit: "truncate" });
    expect(runtimeInputs[0].onLimit).toBe("error");
    expect(result).toMatchObject({
      ok: true, type: "SELECT", rowCount: 1,
      validateStats: {
        errorRecords: 1,
        errorCount: 2,
        constraintMetadata: {
          present: ["choice"],
          absent: ["required", "length", "range"],
        },
      },
    });
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

  test("query maps maxRecords/onLimit and leaves ORDER BY plan choice to the engine", async () => {
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

    await tools.query({
      sql: "SELECT * FROM APP100 ORDER BY name",
      onLimit: "truncate",
    });
    expect(runtimeInputs[1]?.onLimit).toBe("truncate");
    expect(executeOptions?.onLimitReached).toBe("truncate");
  });

  test.each([
    ["DATE_ADD(受注予定日, 1)", "ArgumentError: DATE_ADD expects 3 argument(s)."],
    ["ROUND(売上, 1, 2)", "ArgumentError: ROUND expects 1 to 2 argument(s)."],
  ])("B118: ksql_validate は %s の引数数を実行前に拒否する", async (call, message) => {
    const tools = createKsqlMcpTools({ profile: "prod" });
    await expect(tools.validate({ sql: `SELECT ${call} FROM APP1` })).rejects.toThrow(message);
  });

  test("query inline EXPLAIN は単文・batch の計画だけを復元し SELECT データを保持する", async () => {
    const dir = await mkdtemp(join(process.cwd(), ".tmp-mcp-inline-explain-"));
    const configPath = join(dir, "ksql.config.json");
    await writeFile(configPath, JSON.stringify({
      defaultProfile: "prod",
      profiles: { prod: { logicalApps: { ORDERS: 1234 } } },
    }), "utf8");
    const plan = {
      type: "SELECT" as const,
      columns: ["plan"],
      rows: [{ plan: "app: APP900000000 (900000000)" }],
      rowCount: 1,
      warnings: [],
    };
    const data = {
      type: "SELECT" as const,
      columns: ["x"],
      rows: [{ x: "APP900000000" }],
      rowCount: 1,
      warnings: [],
    };
    const createRuntime = async (
      _options: KsqlRuntimeServerOptions,
      input: CreateKsqlRuntimeInput
    ): Promise<KsqlRuntime> => ({
      sql: input.sql,
      profileName: input.profile ?? "prod",
      client: makeClient(),
      cacheContext: "inline-explain",
      maxRecords: input.maxRecords ?? 500,
      fetchParallel: input.fetchParallel ?? 3,
      onLimit: input.onLimit ?? "error",
      timeout: input.timeout ?? 30_000,
    });
    const executeSql = jest.fn(async (sql: string) => /^\s*EXPLAIN\b/i.test(sql) ? plan : data);
    const executeBatchSql = jest.fn(async (): Promise<BatchExecuteResult> => ({
      ok: true,
      statementCount: 2,
      statements: [
        { index: 0, type: "EXPLAIN", status: "success", result: plan },
        { index: 1, type: "SELECT", status: "success", result: data },
      ],
      analysis: {} as BatchExecuteResult["analysis"],
    }));
    const tools = createKsqlMcpTools(
      { configPath, profile: "prod" },
      { createRuntime, executeSql, executeBatchSql }
    );
    try {
      const single = await tools.query({
        sql: "EXPLAIN SELECT COUNT(*) FROM LAPP_ORDERS",
      });
      expect(JSON.stringify(single)).toContain("LAPP_ORDERS@prod");
      expect(JSON.stringify(single)).not.toContain("APP900000000");

      const singleData = await tools.query({
        sql: "SELECT 'APP900000000' AS x FROM LAPP_ORDERS LIMIT 1",
      }) as { rows: Array<Record<string, unknown>> };
      expect(singleData.rows).toEqual([{ x: "APP900000000" }]);

      const batch = await tools.query({
        sql: "EXPLAIN SELECT COUNT(*) FROM LAPP_ORDERS; SELECT 'APP900000000' AS x",
      }) as { results: Array<{ rows: Array<Record<string, unknown>> }> };
      expect(JSON.stringify(batch.results[0])).toContain("LAPP_ORDERS@prod");
      expect(JSON.stringify(batch.results[0])).not.toContain("APP900000000");
      expect(batch.results[1].rows).toEqual([{ x: "APP900000000" }]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("query schema does not expose CLI-only format or per-call configPath", () => {
    expect("format" in queryInputSchema.shape).toBe(false);
    expect("configPath" in queryInputSchema.shape).toBe(false);
  });

  test("mutate schema exposes explicit safety inputs only", () => {
    expect(Object.keys(mutateInputSchema.shape).sort()).toEqual([
      "allowDml",
      "confirmText",
      "cursorMaxActive",
      "dmlMaxRows",
      "dmlMaxSubtableRows",
      "dmlTotalMaxRows",
      "fetchParallel",
      "importSources",
      "profile",
      "sql",
      "tempTableMaxRows",
      "timeout",
      "variables",
    ]);
    expect("allowWithoutWhere" in mutateInputSchema.shape).toBe(false);
    // DML バッチに続行オプションは存在しない（常に fail-fast）
    expect("continueOnError" in mutateInputSchema.shape).toBe(false);
  });

  test("B44 Phase 6: MCP mutate は AST 判定で runtime/API 前に専用 fail-closed", async () => {
    const client = makeClient();
    client.getRecords = jest.fn(async () => ({ records: [] }));
    client.getFields = jest.fn(async () => []);
    client.postRecords = jest.fn(async () => ({ ids: [] }));
    client.putRecords = jest.fn(async () => undefined);
    const createRuntime = jest.fn(async (_options: KsqlRuntimeServerOptions, input: CreateKsqlRuntimeInput): Promise<KsqlRuntime> => ({
        sql: input.sql,
        profileName: "prod",
        client,
        cacheContext: "mcp-apply-fail-closed",
        maxRecords: 500,
        fetchParallel: 1,
        onLimit: "error",
        timeout: 30_000,
      }));
    const tools = createKsqlMcpTools({ profile: "prod" }, {
      createRuntime,
    });
    await expect(tools.mutate({
      sql: "UPDATE APP4221 SET 親='x' WHERE $id=8 APPLY テーブル (PATCH SET 子='y' ALL ROWS)",
      allowDml: true,
      confirmText: "yes",
      dmlMaxRows: 100,
      dmlMaxSubtableRows: 500,
    })).rejects.toThrow("UnsupportedError: APPLY mutation is disabled in MCP v3.8.0");
    expect(createRuntime).not.toHaveBeenCalled();
    expect(client.getFields).not.toHaveBeenCalled();
    expect(client.getRecords).not.toHaveBeenCalled();
    expect(client.putRecords).not.toHaveBeenCalled();

    await expect(tools.mutate({
      sql: "UPDATE APP4221 SET 親='x' WHERE 状態='open' APPLY テーブル (PATCH SET 子='y' ALL ROWS)",
      allowDml: true,
      confirmText: "yes",
      dmlMaxRows: 100,
      dmlMaxSubtableRows: 500,
    })).rejects.toThrow("UnsupportedError: APPLY mutation is disabled in MCP v3.8.0");
    expect(createRuntime).not.toHaveBeenCalled();
    expect(client.getRecords).not.toHaveBeenCalled();
    expect(client.putRecords).not.toHaveBeenCalled();

    await expect(tools.mutate({
      sql: "UPDATE APP4221 SET 親='x' WHERE $id=8 APPLY テーブル (PATCH SET 子='y' WHERE _idx=0)",
      allowDml: true,
      confirmText: "yes",
      dmlMaxRows: 100,
      dmlMaxSubtableRows: 500,
    })).rejects.toThrow("UnsupportedError: APPLY mutation is disabled in MCP v3.8.0");
    expect(createRuntime).not.toHaveBeenCalled();
    expect(client.getRecords).not.toHaveBeenCalled();
    expect(client.putRecords).not.toHaveBeenCalled();

    await expect(tools.mutate({
      sql: "UPDATE APP4221 SET 親='x' WHERE $id=8 APPLY テーブル (APPEND (子) VALUES ('new'))",
      allowDml: true,
      confirmText: "yes",
      dmlMaxRows: 100,
      dmlMaxSubtableRows: 500,
    })).rejects.toThrow("UnsupportedError: APPLY mutation is disabled in MCP v3.8.0");
    expect(createRuntime).not.toHaveBeenCalled();

    await expect(tools.mutate({
      sql: "SELECT 1; UPDATE APP4221 SET 親='x' WHERE $id=8 APPLY テーブル (PATCH SET 子='y' ALL ROWS)",
      allowDml: true,
      confirmText: "yes",
      dmlMaxRows: 100,
      dmlMaxSubtableRows: 999,
    })).rejects.toThrow("UnsupportedError: APPLY mutation is disabled in MCP v3.8.0");
    expect(createRuntime).not.toHaveBeenCalled();

    await expect(tools.mutate({
      sql: "INSERT INTO APP4221 (親) VALUES ('x') APPLY テーブル (APPEND (子) VALUES ('new'))",
      allowDml: true,
      confirmText: "yes",
      dmlMaxRows: 100,
      dmlMaxSubtableRows: 500,
    })).rejects.toThrow("UnsupportedError: APPLY mutation is disabled in MCP v3.8.0");
    expect(createRuntime).not.toHaveBeenCalled();
    expect(client.postRecords).not.toHaveBeenCalled();
  });

  test("B44 Phase 14a: statementHasApplyBlocks は UPDATE/INSERT/UPSERT を共通検出する", () => {
    expect(statementHasApplyBlocks(parseSqlStatement(
      "UPDATE APP1 SET 親='x' WHERE $id=1 APPLY 表 (APPEND (子) VALUES ('a'))"
    ))).toBe(true);
    expect(statementHasApplyBlocks(parseSqlStatement(
      "INSERT INTO APP1 (親) VALUES ('x') APPLY 表 (APPEND (子) VALUES ('a'))"
    ))).toBe(true);
    expect(statementHasApplyBlocks(parseSqlStatement(
      "UPSERT INTO APP1 (key) VALUES ('K1') ON DUPLICATE (key) "
      + "ON INSERT APPLY 表 (APPEND (子) VALUES ('a'))"
    ))).toBe(true);
    expect(statementHasApplyBlocks(parseSqlStatement(
      "UPSERT INTO APP1 (key) VALUES ('K1') ON DUPLICATE (key) "
      + "ON UPDATE APPLY 表 (REMOVE ALL ROWS)"
    ))).toBe(true);
    expect(statementHasApplyBlocks(parseSqlStatement("INSERT INTO APP1 (APPLY) VALUES ('x')"))).toBe(false);
    expect(statementHasApplyBlocks(parseSqlStatement(
      "UPSERT INTO APP1 (APPLY) VALUES ('x') ON DUPLICATE (APPLY)"
    ))).toBe(false);
    expect(statementHasApplyBlocks(parseSqlStatement(
      "UPDATE APP1 SET 親='x' WHERE $id=1 APPLY tags (ADD '重要'; REMOVE '新規')"
    ))).toBe(true);
  });

  test("B44 Phase 15a: MCP mutate は多値 APPLY をruntime/API前にfail-closedする", async () => {
    const client = makeClient();
    const createRuntime = jest.fn(async (): Promise<KsqlRuntime> => ({
      sql: "", profileName: "prod", client, cacheContext: "mcp-multi-apply-phase15a",
      maxRecords: 500, fetchParallel: 1, onLimit: "error", timeout: 30_000,
    }));
    const tools = createKsqlMcpTools({ profile: "prod" }, { createRuntime });

    await expect(tools.mutate({
      sql: "UPDATE APP4221 SET 親='x' WHERE $id=8 APPLY 複数選択 (ADD '重要'; REMOVE '新規')",
      allowDml: true,
      confirmText: "yes",
      dmlMaxRows: 100,
      dmlMaxSubtableRows: 500,
    })).rejects.toThrow("UnsupportedError: APPLY mutation is disabled in MCP v3.8.0");
    expect(createRuntime).not.toHaveBeenCalled();
  });

  test("B44 Phase 13a: INSERT APPLY の VALIDATE ONLY は read-only、EXPLAIN は許可する", async () => {
    const createRuntime = jest.fn(async (_options: KsqlRuntimeServerOptions, input: CreateKsqlRuntimeInput): Promise<KsqlRuntime> => ({
      sql: input.sql,
      profileName: "prod",
      client: makeClient(),
      cacheContext: "mcp-insert-apply-read-only",
      maxRecords: 500,
      fetchParallel: 1,
      onLimit: "error",
      timeout: 30_000,
    }));
    const executeSql = jest.fn(async (): Promise<ExecuteResult> => ({ type: "SELECT", rows: [], columns: [], rowCount: 0 }));
    const tools = createKsqlMcpTools({ profile: "prod" }, { createRuntime, executeSql });
    const sql = "INSERT INTO APP4221 (親) VALUES ('x') APPLY テーブル (APPEND (子) VALUES ('new'))";

    await expect(tools.validate({ sql: `${sql} VALIDATE ONLY` })).resolves.toMatchObject({
      isReadOnly: true,
      canRunWithQueryTool: true,
    });
    await expect(tools.query({ sql: `${sql} VALIDATE ONLY` })).resolves.toBeDefined();
    await expect(tools.explain({ sql })).resolves.toBeDefined();
    expect(createRuntime).toHaveBeenCalledTimes(1);
    expect(executeSql).toHaveBeenCalledTimes(2);
  });

  test("B44 Phase 14a: UPSERT APPLY mutation は共通 helper で runtime 前拒否し、VALIDATE ONLY/EXPLAIN は許可する", async () => {
    const client = makeClient();
    const createRuntime = jest.fn(async (_options: KsqlRuntimeServerOptions, input: CreateKsqlRuntimeInput): Promise<KsqlRuntime> => ({
      sql: input.sql,
      profileName: "prod",
      client,
      cacheContext: "mcp-upsert-apply-phase14a",
      maxRecords: 500,
      fetchParallel: 1,
      onLimit: "error",
      timeout: 30_000,
    }));
    const executeSql = jest.fn(async (): Promise<ExecuteResult> => ({ type: "SELECT", rows: [], columns: [], rowCount: 0 }));
    const tools = createKsqlMcpTools({ profile: "prod" }, { createRuntime, executeSql });
    const sql = "UPSERT INTO APP4221 (key) VALUES ('K1') ON DUPLICATE (key) "
      + "ON INSERT APPLY テーブル (APPEND (子) VALUES ('new'))";

    await expect(tools.mutate({
      sql,
      allowDml: true,
      confirmText: "yes",
      dmlMaxRows: 100,
    })).rejects.toThrow("UnsupportedError: APPLY mutation is disabled in MCP v3.8.0");
    expect(createRuntime).not.toHaveBeenCalled();
    expect(executeSql).not.toHaveBeenCalled();

    await expect(tools.validate({ sql: `${sql} VALIDATE ONLY` })).resolves.toMatchObject({
      isReadOnly: true,
      canRunWithQueryTool: true,
    });
    await expect(tools.query({ sql: `${sql} VALIDATE ONLY` })).resolves.toBeDefined();
    await expect(tools.explain({ sql })).resolves.toBeDefined();
    expect(createRuntime).toHaveBeenCalledTimes(1);
    expect(executeSql).toHaveBeenCalledTimes(2);
  });

  test.each([
    ["複数親 UPDATE", "UPDATE APP4221 SET 親='x' WHERE 状態='open' APPLY テーブル (PATCH SET 子='y' ALL ROWS)"],
    ["INSERT APPLY", "INSERT INTO APP4221 (親) VALUES ('x') APPLY テーブル (APPEND (子) VALUES ('new'))"],
    ["UPSERT ON INSERT", "UPSERT INTO APP4221 (key) VALUES ('K1') ON DUPLICATE (key) ON INSERT APPLY テーブル (APPEND (子) VALUES ('new'))"],
    ["UPSERT ON UPDATE", "UPSERT INTO APP4221 (key) VALUES ('K1') ON DUPLICATE (key) ON UPDATE APPLY テーブル (REMOVE ALL ROWS)"],
    ["多値 ADD/REMOVE", "UPDATE APP4221 SET 親='x' WHERE $id=8 APPLY 複数選択 (ADD '重要'; REMOVE '新規')"],
  ])("B44 Phase 16d MCP 全経路 matrix: %s", async (_kind, sql) => {
    const client = makeClient();
    const recordApis = [
      jest.spyOn(client, "getRecords"),
      jest.spyOn(client, "openCursor"),
      jest.spyOn(client, "postRecords"),
      jest.spyOn(client, "putRecords"),
      jest.spyOn(client, "deleteRecords"),
    ];
    const allApis = [
      ...recordApis,
      jest.spyOn(client, "getApps"),
      jest.spyOn(client, "getFields"),
      jest.spyOn(client, "getProcessStatuses"),
      jest.spyOn(client, "getNumberPrecision"),
    ];
    const createRuntime = jest.fn(async (_options: KsqlRuntimeServerOptions, input: CreateKsqlRuntimeInput): Promise<KsqlRuntime> => ({
      sql: input.sql,
      profileName: "prod",
      client,
      cacheContext: "mcp-apply-phase16d-matrix",
      maxRecords: 500,
      fetchParallel: 1,
      onLimit: "error",
      timeout: 30_000,
    }));
    const executeSql = jest.fn(async (executedSql: string): Promise<ExecuteResult> =>
      /^\s*EXPLAIN\b/i.test(executedSql)
        ? { type: "SELECT", columns: ["plan"], rows: [{ plan: "APPLY" }], rowCount: 1 }
        : {
            type: "VALIDATION", operation: "UPDATE", validatedRows: 1, validRows: 1,
            invalidRows: 0, errorCount: 0, columns: [], errors: [],
          }
    );
    const executeBatchSql = jest.fn(async (): Promise<never> => {
      throw new Error("executeBatchSql should not be called for APPLY mutation.");
    });
    const tools = createKsqlMcpTools({ profile: "prod" }, { createRuntime, executeSql, executeBatchSql });

    // validate: mutation 構文自体は静的検証を通す（API 0）。
    await expect(tools.validate({ sql })).resolves.toMatchObject({ ok: true, isDml: true });

    // query: 全 APPLY 形の VALIDATE ONLY は read-only として許可する。
    await expect(tools.query({ sql: `${sql} VALIDATE ONLY` })).resolves.toMatchObject({
      ok: true,
      type: "VALIDATION",
    });

    // explain: 全 APPLY 形の plan を許可し、records/mutation API は呼ばない。
    await expect(tools.explain({ sql })).resolves.toMatchObject({ ok: true, type: "SELECT" });
    const runtimeCallsBeforeMutation = createRuntime.mock.calls.length;
    const apiCallsBeforeMutation = allApis.map((api) => api.mock.calls.length);

    const mutationInput = {
      sql,
      allowDml: true as const,
      confirmText: "yes" as const,
      dmlMaxRows: 100,
      dmlMaxSubtableRows: 999,
    };
    await expect(tools.mutate(mutationInput))
      .rejects.toThrow("UnsupportedError: APPLY mutation is disabled in MCP v3.8.0");
    await expect(tools.mutate({ ...mutationInput, sql: `SELECT 1; ${sql}` }))
      .rejects.toThrow("UnsupportedError: APPLY mutation is disabled in MCP v3.8.0");

    // query/EXPLAIN の read-only runtime だけを許可。mutate / mutate-batch は runtime生成も実行も 0。
    expect(createRuntime).toHaveBeenCalledTimes(runtimeCallsBeforeMutation);
    expect(executeSql).toHaveBeenCalledTimes(2);
    expect(executeBatchSql).not.toHaveBeenCalled();
    for (const api of recordApis) expect(api).not.toHaveBeenCalled();
    allApis.forEach((api, index) => expect(api).toHaveBeenCalledTimes(apiCallsBeforeMutation[index]));
  });

  test("B44 Phase 16d: MCP APPLY schema は mutate 専用で、上限を上げても解禁しない", () => {
    expect("dmlMaxSubtableRows" in queryInputSchema.shape).toBe(false);
    const field = mutateInputSchema.shape.dmlMaxSubtableRows;
    expect(field.safeParse(100).success).toBe(true);
    for (const invalid of [0, -1, 1.5]) expect(field.safeParse(invalid).success).toBe(false);
    expect(field.description).toContain("always rejected by MCP v3.8.0");
    expect(field.description).toContain("UPDATE/INSERT/UPSERT/multi-value");
    expect(field.description).toContain("before runtime or records API creation");
    expect(field.description).toContain("allowDml");
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

  test("explain schema exposes planning inputs", () => {
    expect(Object.keys(explainInputSchema.shape).sort()).toEqual(["cursorMaxActive", "importSources", "maxRecords", "profile", "sql"]);
  });

  test("explainはmaxRecordsとcursorMaxActiveをruntimeと表示へ反映する", async () => {
    const runtimeInputs: CreateKsqlRuntimeInput[] = [];
    const tools = createKsqlMcpTools({ profile: "prod" }, {
      createRuntime: async (_options, input) => {
        runtimeInputs.push(input);
        return {
          sql: input.sql,
          profileName: "prod",
          client: makeClient(),
          cacheContext: "mcp-explain-cursor",
          maxRecords: input.maxRecords ?? 500,
          fetchParallel: 1,
          onLimit: "error",
          timeout: 30_000,
          cursorMaxActive: input.cursorMaxActive ?? 2,
        };
      },
    });
    const result = await tools.explain({
      sql: "SELECT $id FROM APP100 KORDER BY $id LIMIT 501",
      maxRecords: 501,
      cursorMaxActive: 4,
    });
    expect(runtimeInputs[0]).toMatchObject({ maxRecords: 501, cursorMaxActive: 4 });
    expect(JSON.stringify(result.rows)).toContain("KORDER_CURSOR");
    expect(JSON.stringify(result.rows)).toContain("cursor concurrency: 4 per domain (process-local)");
  });

  test("cursorMaxActive schema accepts 1..5 only", () => {
    for (const value of [1, 2, 5]) {
      expect(queryInputSchema.safeParse({ sql: "SELECT 1", cursorMaxActive: value }).success).toBe(true);
    }
    for (const value of [0, 6, 1.5]) {
      expect(queryInputSchema.safeParse({ sql: "SELECT 1", cursorMaxActive: value }).success).toBe(false);
    }
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

  test("IMPORT CSV inline text enables the capability and supplies named bytes", async () => {
    let seenOptions: ExecuteOptions | undefined;
    const tools = createKsqlMcpTools({ profile: "prod" }, {
      createRuntime: async (_options, input) => ({
        sql: input.sql, profileName: "prod", client: makeClient(), cacheContext: "import-text",
        maxRecords: 500, fetchParallel: 1, onLimit: "error", timeout: 30_000, cursorMaxActive: 2,
      }),
      executeSql: async (_sql, _client, options) => {
        seenOptions = options;
        return { type: "INSERT", insertedCount: 1, createdIds: [["1"]] };
      },
    });
    await expect(tools.mutate({
      sql: "IMPORT INTO APP100 (顧客名) FROM CSV people",
      allowDml: true, confirmText: "yes", dmlMaxRows: 1,
      importSources: [{ name: "people", text: "顧客名\nAlice\n", encoding: "utf8" }],
    })).resolves.toMatchObject({ ok: true, type: "INSERT", insertedCount: 1 });
    expect(seenOptions?.enableImport).toBe(true);
    const loaded = await seenOptions?.importSource?.("people")?.load();
    expect(new TextDecoder().decode(loaded?.bytes)).toBe("顧客名\nAlice\n");
    expect(loaded?.encoding).toBe("utf8");
  });

  test("IMPORT CSV inline base64 supplies raw bytes; no source keeps gate off", async () => {
    const optionsSeen: ExecuteOptions[] = [];
    const tools = createKsqlMcpTools({ profile: "prod" }, {
      createRuntime: async (_options, input) => ({
        sql: input.sql, profileName: "prod", client: makeClient(), cacheContext: "import-base64",
        maxRecords: 500, fetchParallel: 1, onLimit: "error", timeout: 30_000, cursorMaxActive: 2,
      }),
      executeSql: async (_sql, _client, options) => {
        optionsSeen.push(options ?? {});
        return { type: "INSERT", insertedCount: 1, createdIds: [["1"]] };
      },
    });
    await tools.mutate({
      sql: "IMPORT INTO APP100 (顧客名) FROM CSV raw", allowDml: true, confirmText: "yes", dmlMaxRows: 1,
      importSources: [{ name: "raw", base64: "gQ==", encoding: "sjis" }],
    });
    expect(Array.from((await optionsSeen[0].importSource?.("raw")?.load())!.bytes)).toEqual([0x81]);
    await expect(tools.validate({ sql: "IMPORT INTO APP100 (顧客名) FROM CSV raw" }))
      .rejects.toThrow(MCP_IMPORT_SOURCE_REQUIRED_MESSAGE);
  });

  test.each([
    ["ksql_validate", (tools: ReturnType<typeof createKsqlMcpTools>) => tools.validateTool({
      sql: "IMPORT INTO APP100 (顧客名) FROM CSV people",
    })],
    ["ksql_query", (tools: ReturnType<typeof createKsqlMcpTools>) => tools.queryTool({
      sql: "IMPORT INTO APP100 (顧客名) FROM CSV people",
    })],
    ["ksql_mutate", (tools: ReturnType<typeof createKsqlMcpTools>) => tools.mutateTool({
      sql: "IMPORT INTO APP100 (顧客名) FROM CSV people",
      allowDml: true,
      confirmText: "yes",
      dmlMaxRows: 1,
    })],
    ["ksql_explain", (tools: ReturnType<typeof createKsqlMcpTools>) => tools.explainTool({
      sql: "IMPORT INTO APP100 (顧客名) FROM CSV people",
    })],
  ])("%s は importSources 未指定の IMPORT gate を MCP 案内で返す", async (_name, callTool) => {
    const result = await callTool(createKsqlMcpTools({ profile: "prod" }));
    const payload = result.structuredContent as {
      ok: false;
      error: { code: string; message: string };
    };
    expect(result.isError).toBe(true);
    expect(payload.error).toEqual({
      code: "ParseError",
      message: MCP_IMPORT_SOURCE_REQUIRED_MESSAGE,
    });
  });

  test("MCP IMPORT 案内は gate かつ importSources 未指定の場合だけ適用する", () => {
    const gateError = new Error("IMPORT is not supported (capability is disabled).");
    const syntaxError = new Error("ParseError: unexpected token");
    expect(toMcpImportError(syntaxError, false)).toBe(syntaxError);
    expect(toMcpImportError(gateError, true)).toBe(gateError);
    expect(gateError.message).toContain("capability is disabled");
  });

  test("IMPORT CSV inline text executes through the engine", async () => {
    const client = makeClient();
    client.postRecords = async ({ records }) => ({ ids: records.map((_record, index) => String(index + 1)) });
    const tools = createKsqlMcpTools({ profile: "prod" }, {
      createRuntime: async (_options, input) => ({
        sql: input.sql, profileName: "prod", client, cacheContext: "import-engine",
        maxRecords: 500, fetchParallel: 1, onLimit: "error", timeout: 30_000, cursorMaxActive: 2,
      }),
    });
    await expect(tools.mutate({
      sql: "IMPORT INTO APP100 (顧客名) FROM CSV people",
      allowDml: true, confirmText: "yes", dmlMaxRows: 1,
      importSources: [{ name: "people", text: "顧客名\nAlice\n" }],
    })).resolves.toMatchObject({ ok: true, type: "INSERT", insertedCount: 1 });
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

  test("mutate: UPDATE FROM APP はソース読み取りを dmlMaxRows + 1 で制限しない", async () => {
    const runtimeInputs: CreateKsqlRuntimeInput[] = [];
    const createRuntime = async (
      _serverOptions: KsqlRuntimeServerOptions,
      input: CreateKsqlRuntimeInput
    ): Promise<KsqlRuntime> => {
      runtimeInputs.push(input);
      return {
        sql: input.sql,
        profileName: input.profile ?? "prod",
        client: makeClient(),
        cacheContext: "update-from-mcp",
        maxRecords: input.maxRecords ?? 500,
        fetchParallel: 3,
        onLimit: "error",
        timeout: 30000,
      };
    };
    const tools = createKsqlMcpTools(
      { profile: "prod" },
      {
        createRuntime,
        executeSql: async (_sql, _client, options) => {
          expect(options?.maxRecords).toBe(500);
          await options?.confirm?.(1, "UPDATE");
          return { type: "UPDATE", updatedCount: 1 };
        },
      }
    );
    const result = await tools.mutate({
      sql: "UPDATE APP100 SET dest = s.src FROM APP200 s WHERE APP100.$id = s.k",
      allowDml: true,
      confirmText: "yes",
      dmlMaxRows: 10,
    });
    expect(result).toMatchObject({ ok: true, type: "UPDATE", updatedCount: 1 });
    expect(runtimeInputs[0]?.maxRecords).toBeUndefined();
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
      async openCursor() { throw new Error("unexpected cursor call"); },
      async postRecords() { return { ids: [] }; },
      async putRecords() { },
      async deleteRecords() { },
      async getApps() { return []; },
      async getFields() { return []; },
      async getProcessStatuses() { return { enable: false, states: [] }; },
      async getNumberPrecision() { return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const }; },
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

  test("query: DECLARE 変数を MCP variables で上書きする", async () => {
    const tools = createKsqlMcpTools(
      { profile: "prod" },
      makeBatchRuntimeDeps({ 100: BATCH_APP100 })
    );
    const result = await tools.query({
      sql: "DECLARE @min = '0'; CREATE TEMP TABLE #t AS SELECT 顧客名, 売上 FROM APP100; SELECT 顧客名 FROM #t WHERE 売上 > @min",
      variables: { Min: "200" },
    }) as { results: Array<{ rows: Array<Record<string, string>> }> };
    expect(result.results[0].rows).toEqual([{ 顧客名: "B社" }]);
  });

  test("query/mutate は単文への純粋変数注入を拒否する", async () => {
    const tools = createKsqlMcpTools({ profile: "prod" });
    await expect(tools.query({ sql: "SELECT * FROM APP100", variables: { x: "1" } }))
      .rejects.toThrow(/variables require a batch containing DECLARE/);
    await expect(tools.mutate({
      sql: "UPDATE APP100 SET x = '1' WHERE $id = 1",
      allowDml: true,
      confirmText: "yes",
      dmlMaxRows: 1,
      variables: { x: "1" },
    })).rejects.toThrow(/variables require a batch containing DECLARE/);
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
        async openCursor() { throw new Error("unexpected cursor call"); },
        async postRecords() { return { ids: [] }; },
        async putRecords() { },
        async deleteRecords() { },
        async getApps() { return []; },
        async getFields() { return []; },
        async getProcessStatuses() { return { enable: false, states: [] }; },
        async getNumberPrecision() { return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const }; },
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
      async openCursor() { throw new Error("unexpected cursor call"); },
      async postRecords() { return { ids: [] }; },
      async putRecords() { },
      async deleteRecords() { },
      async getApps() { return []; },
      async getFields() { return []; },
      async getProcessStatuses() { return { enable: false, states: [] }; },
      async getNumberPrecision() { return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const }; },
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

  const MUTATE_FORM_FIELDS = [
    "name", "名前", "顧客コード", "ステータス", "dest", "x", "顧客名", "code", "地域",
  ].map((code) => ({ code, label: code, fieldType: "SINGLE_LINE_TEXT" }));

  function makeMutateRuntimeDeps(
    recordsByApp: Record<number, Array<Record<string, { value: string }>>>,
    fields: Array<{ code: string; label: string; fieldType: string; required?: boolean }> = MUTATE_FORM_FIELDS,
    cacheContext = "mutate-batch-test"
  ) {
    const calls = { post: 0, put: 0, del: 0, get: 0 };
    const runtimeInputs: CreateKsqlRuntimeInput[] = [];
    const client: KintoneClient = {
      async getRecords(params) {
        calls.get += 1;
        return { records: (recordsByApp[params.app] ?? []) as never };
      },
      async openCursor() { throw new Error("unexpected cursor call"); },
      async postRecords(params) {
        calls.post += 1;
        return { ids: params.records.map((_r, i) => String(100 + i)) };
      },
      async putRecords() { calls.put += 1; },
      async deleteRecords() { calls.del += 1; },
      async getApps() { return []; },
      async getFields() { return fields; },
      async getProcessStatuses() { return { enable: false, states: [] }; },
      async getNumberPrecision() { return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const }; },
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
        cacheContext,
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

  test("mutate: ON ERROR SKIP は raw 行数で拒否せず隔離後件数を dmlMaxRows/total に適用", async () => {
    const { deps, calls, runtimeInputs } = makeMutateRuntimeDeps({}, [
      { code: "code", label: "code", fieldType: "SINGLE_LINE_TEXT", required: true },
    ], "on-error-mcp");
    const tools = createKsqlMcpTools({ profile: "prod" }, deps);
    const values = ["'OK'", ...Array.from({ length: 9 }, () => "''")].map((v) => `(${v})`).join(", ");
    const result = await tools.mutate({
      ...MUTATE_BASE,
      sql: `INSERT INTO APP100 (code) VALUES ${values} ON ERROR SKIP INTO #err; SELECT * FROM #err`,
      dmlMaxRows: 1,
      dmlTotalMaxRows: 1,
    }) as { ok: boolean; statements: Array<Record<string, unknown>>; results: Array<Record<string, unknown>> };

    expect(result.ok).toBe(true);
    expect(result.statements[0]).toMatchObject({
      status: "success", insertedCount: 1, affectedRows: 1, skippedRows: 9, errTable: "#err",
    });
    expect(result.results[0]).toMatchObject({ type: "SELECT", rowCount: 9 });
    expect(calls.post).toBe(1);
    expect(runtimeInputs[0].maxRecords).toBeUndefined();
  });

  test("mutate: DECLARE 変数を MCP variables から UPDATE SET へ渡す", async () => {
    const { deps, calls } = makeMutateRuntimeDeps({
      100: [{ $id: { value: "1" }, ステータス: { value: "対応中" } }],
    });
    const tools = createKsqlMcpTools({ profile: "prod" }, deps);
    const result = await tools.mutate({
      ...MUTATE_BASE,
      sql: "DECLARE @status = '既定'; UPDATE APP100 SET ステータス = @status WHERE $id = 1",
      variables: { STATUS: "完了" },
      dmlMaxRows: 10,
    }) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(calls.put).toBe(1);
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

  test("mutate: バッチ内 UPDATE FROM #temp も通常の maxRecords 解決を使う", async () => {
    const runtimeInputs: CreateKsqlRuntimeInput[] = [];
    const createRuntime = async (
      _serverOptions: KsqlRuntimeServerOptions,
      input: CreateKsqlRuntimeInput
    ): Promise<KsqlRuntime> => {
      runtimeInputs.push(input);
      return {
        sql: input.sql,
        profileName: input.profile ?? "prod",
        client: makeClient(),
        cacheContext: "batch-update-from-mcp",
        maxRecords: input.maxRecords ?? 500,
        fetchParallel: 3,
        onLimit: "error",
        timeout: 30000,
      };
    };
    const tools = createKsqlMcpTools(
      { profile: "prod" },
      {
        createRuntime,
        executeBatchSql: async (_sql, _client, options) => {
          await options?.confirm?.(1, "UPDATE");
          return {
            ok: true,
            statementCount: 2,
            statements: [
              { index: 0, type: "CREATE_TEMP_TABLE", status: "success", tempTable: "#e", rowCount: 1 },
              { index: 1, type: "UPDATE", status: "success", result: { type: "UPDATE", updatedCount: 1 } },
            ],
            analysis: {} as never,
            metrics: { apiCalls: 0, fetchedRows: 0, elapsedMs: 0 },
          } as never;
        },
      }
    );
    const result = await tools.mutate({
      ...MUTATE_BASE,
      sql: "CREATE TEMP TABLE #e AS SELECT $id AS k, name AS src FROM APP200; " +
        "UPDATE APP100 SET dest = e.src FROM #e e WHERE APP100.$id = e.k",
      dmlMaxRows: 10,
    }) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(runtimeInputs[0]?.maxRecords).toBeUndefined();
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
