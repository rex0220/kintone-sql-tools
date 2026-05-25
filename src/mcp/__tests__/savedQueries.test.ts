import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  assertProfileOverrideAllowed,
  assertSavedQuerySafety,
  deleteSavedQuery,
  emptySavedQueryCatalog,
  getSavedQuery,
  loadSavedQueryCatalog,
  parseSavedQueryCatalog,
  resolveSavedQueryCatalogPath,
  saveSavedQueryCatalog,
  upsertSavedQuery,
} from "../savedQueries";
import {
  runSavedQueryInputSchema,
  saveQueryInputSchema,
  savedQueryNameInputSchema,
} from "../schemas";

describe("saved query catalog", () => {
  const savedEnv = process.env.KSQL_SAVED_QUERIES;

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.KSQL_SAVED_QUERIES;
    } else {
      process.env.KSQL_SAVED_QUERIES = savedEnv;
    }
  });

  test("resolves the project-local catalog path by default", () => {
    delete process.env.KSQL_SAVED_QUERIES;
    expect(resolveSavedQueryCatalogPath()).toBe(join(process.cwd(), ".ksql", "queries.json"));
  });

  test("prepares saved query schemas without per-call catalog path", () => {
    expect("catalogPath" in saveQueryInputSchema.shape).toBe(false);
    expect("catalogPath" in savedQueryNameInputSchema.shape).toBe(false);
    expect("catalogPath" in runSavedQueryInputSchema.shape).toBe(false);
    expect(() => saveQueryInputSchema.parse({
      name: "monthly_sales",
      sql: "SELECT * FROM APP100",
      defaultProfile: "prod",
      readOnly: true,
    })).not.toThrow();
    expect(() => savedQueryNameInputSchema.parse({ name: "../secret" })).toThrow();
  });

  test("allows server-level catalog path override through env", () => {
    process.env.KSQL_SAVED_QUERIES = ".tmp/saved/queries.json";
    expect(resolveSavedQueryCatalogPath()).toBe(join(process.cwd(), ".tmp", "saved", "queries.json"));
  });

  test("resolves config saved query paths relative to the config file", () => {
    delete process.env.KSQL_SAVED_QUERIES;
    const configPath = join(process.cwd(), ".local", "ksql.config.json");

    expect(resolveSavedQueryCatalogPath({
      configPath,
      configSavedQueriesPath: "catalog/queries.json",
    })).toBe(join(process.cwd(), ".local", "catalog", "queries.json"));
    expect(resolveSavedQueryCatalogPath({
      configPath,
    })).toBe(join(process.cwd(), ".local", ".ksql", "queries.json"));
  });

  test("upserts and preserves createdAt on update", () => {
    const first = upsertSavedQuery(emptySavedQueryCatalog(), {
      name: "monthly_sales",
      title: "Monthly sales",
      sql: "SELECT SUM(金額) AS total FROM APP100",
      defaultProfile: "prod",
      readOnly: true,
      tags: [" sales ", "sales", ""],
    }, new Date("2026-05-24T00:00:00.000Z"));
    const second = upsertSavedQuery(first.catalog, {
      name: "monthly_sales",
      title: "Monthly sales v2",
      sql: "SELECT COUNT(*) AS count FROM APP100",
      defaultProfile: "prod",
      readOnly: true,
      allowProfileOverride: true,
    }, new Date("2026-05-25T00:00:00.000Z"));

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.catalog.queries).toHaveLength(1);
    expect(second.query.createdAt).toBe("2026-05-24T00:00:00.000Z");
    expect(second.query.updatedAt).toBe("2026-05-25T00:00:00.000Z");
    expect(second.query.allowProfileOverride).toBe(true);
    expect(first.query.tags).toEqual(["sales"]);
  });

  test("rejects unsafe saved query names", () => {
    expect(() => upsertSavedQuery(emptySavedQueryCatalog(), {
      name: "../secret",
      sql: "SELECT * FROM APP100",
      defaultProfile: "prod",
      readOnly: true,
    })).toThrow(/saved query name/);
  });

  test("enforces readOnly and DML safety decisions", () => {
    expect(() => assertSavedQuerySafety({
      name: "bad_readonly",
      sql: "UPDATE APP100 SET name = 'x' WHERE $id = 1",
      defaultProfile: "prod",
      readOnly: true,
    }, {
      isDml: true,
      statementType: "UPDATE",
    })).toThrow(/readOnly saved query cannot contain UPDATE/);

    expect(() => assertSavedQuerySafety({
      name: "bad_dml_flag",
      sql: "SELECT * FROM APP100",
      defaultProfile: "prod",
      readOnly: false,
    }, {
      isDml: false,
      statementType: "SELECT",
    })).toThrow(/readOnly: false is only allowed/);
  });

  test("blocks profile override unless the query opts in", () => {
    const { query } = upsertSavedQuery(emptySavedQueryCatalog(), {
      name: "monthly_sales",
      sql: "SELECT * FROM APP100",
      defaultProfile: "prod",
      readOnly: true,
    });

    expect(() => assertProfileOverrideAllowed(query, "stg")).toThrow(/does not allow profile override/);
    expect(() => assertProfileOverrideAllowed(query, "prod")).not.toThrow();
  });

  test("loads missing catalogs as empty and round-trips JSON files", async () => {
    const dir = await mkdtemp(join(process.cwd(), ".tmp-saved-queries-"));
    try {
      const filePath = join(dir, ".ksql", "queries.json");
      await expect(loadSavedQueryCatalog(filePath)).resolves.toEqual(emptySavedQueryCatalog());

      const { catalog } = upsertSavedQuery(emptySavedQueryCatalog(), {
        name: "b_query",
        sql: "SELECT * FROM APP100",
        defaultProfile: "prod",
        readOnly: true,
      });
      const { catalog: catalog2 } = upsertSavedQuery(catalog, {
        name: "a_query",
        sql: "SELECT * FROM APP200",
        defaultProfile: "prod",
        readOnly: true,
      });
      await saveSavedQueryCatalog(filePath, catalog2);

      const loaded = await loadSavedQueryCatalog(filePath);
      expect(loaded.queries.map((query) => query.name)).toEqual(["a_query", "b_query"]);
      expect(getSavedQuery(loaded, "a_query").sql).toBe("SELECT * FROM APP200");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("reports invalid and duplicate catalog entries as argument errors", () => {
    expect(() => parseSavedQueryCatalog("{")).toThrow(/catalog JSON is invalid/);
    expect(() => parseSavedQueryCatalog(JSON.stringify({
      version: 1,
      queries: [
        {
          name: "same",
          sql: "SELECT * FROM APP100",
          defaultProfile: "prod",
          readOnly: true,
          createdAt: "2026-05-24T00:00:00.000Z",
          updatedAt: "2026-05-24T00:00:00.000Z",
        },
        {
          name: "same",
          sql: "SELECT * FROM APP200",
          defaultProfile: "prod",
          readOnly: true,
          createdAt: "2026-05-24T00:00:00.000Z",
          updatedAt: "2026-05-24T00:00:00.000Z",
        },
      ],
    }))).toThrow(/duplicate saved query name same/);
  });

  test("deletes saved queries without throwing on missing names", () => {
    const { catalog } = upsertSavedQuery(emptySavedQueryCatalog(), {
      name: "monthly_sales",
      sql: "SELECT * FROM APP100",
      defaultProfile: "prod",
      readOnly: true,
    });

    const deleted = deleteSavedQuery(catalog, "monthly_sales");
    const missing = deleteSavedQuery(deleted.catalog, "monthly_sales");

    expect(deleted.deleted).toBe(true);
    expect(deleted.catalog.queries).toEqual([]);
    expect(missing.deleted).toBe(false);
  });
});
