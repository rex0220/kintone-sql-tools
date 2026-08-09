import {
  buildBatchExplainPlans,
  execute,
  type KintoneClient,
  type KintoneFieldInfo,
} from "../execute";
import { parseArgs } from "../cli/index";
import { explainQuery } from "../engine-library/query";
import { explainInputShape, queryInputSchema } from "../mcp/schemas";
import { z } from "zod";

const RECURSIVE = `WITH RECURSIVE tree (parent, child, depth) AS (
  SELECT parent, child, 1 FROM APP100 WHERE parent = 'ROOT'
  UNION ALL
  SELECT s.parent, s.child, r.depth + 1
  FROM APP100 s INNER JOIN tree r ON s.parent = r.child
) SELECT parent, child, depth FROM tree`;

function client(): KintoneClient & { recordFields: string[][] } {
  const recordFields: string[][] = [];
  const fields: KintoneFieldInfo[] = ["parent", "child", "qty", "unused"].map((field) => ({
    code: field,
    label: field,
    fieldType: field === "qty" ? "NUMBER" : "SINGLE_LINE_TEXT",
    sortKind: field === "qty" ? "number" : "string",
  }));
  return {
    recordFields,
    async getRecords(params) { recordFields.push([...params.fields]); return { records: [] }; },
    async openCursor() { throw new Error("cursor API must not be called"); },
    async postRecords() { return { ids: [] }; },
    async putRecords() {},
    async deleteRecords() {},
    async getApps() { return []; },
    async getFields() { return fields; },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() { return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const }; },
  };
}

describe("B53 Stage 3 settings and EXPLAIN", () => {
  test("single EXPLAIN shows effective limits, cycle:none, sources, and performs no records read", async () => {
    const mock = client();
    const result = await execute(`EXPLAIN ${RECURSIVE}`, mock, {
      maxRecords: 321,
      recursiveCteMaxDepth: 7,
      recursiveCteMaxRows: 80,
      recursiveCteMaxExpansions: 900,
    });
    expect(result.type).toBe("SELECT");
    const text = result.type === "SELECT" ? result.rows.map((row) => row.plan).join("\n") : "";
    expect(text).toContain("strategy: B (materialize each source once, iterate in memory)");
    expect(text).toContain("cycle: none (absolute limits still enforced)");
    expect(text).toContain("limits: depth=7, rows=80, expansions=900 (always fail-closed)");
    expect(text).toContain("source APP100: R unknown, pageSize=500, estimated calls=ceil(R/500), maxRecords=321");
    expect(text).toContain("empty-key recursive join: runtime checked");
    expect(mock.recordFields).toEqual([]);
  });

  test("batch plan and engine-library plan use the same recursive meaning", async () => {
    const batchClient = client();
    const batch = await buildBatchExplainPlans(
      `${RECURSIVE}; SELECT 1 FROM APP200`, batchClient, undefined, "b53-stage3", 456, 2,
      false, 100, undefined, true, 8, 90, 1_000
    );
    const batchText = batch.statements[0].plan.join("\n");
    expect(batchText).toContain("limits: depth=8, rows=90, expansions=1000 (always fail-closed)");
    expect(batchText).toContain("maxRecords=456");
    expect(batchClient.recordFields).toEqual([]);

    const engineClient = client();
    const engine = await explainQuery(RECURSIVE, {
      client: engineClient,
      maxRecords: 456,
      recursiveCteMaxDepth: 8,
      recursiveCteMaxRows: 90,
      recursiveCteMaxExpansions: 1_000,
    });
    expect(engine.text).toContain("limits: depth=8, rows=90, expansions=1000 (always fail-closed)");
    expect(engine.text).toContain("maxRecords=456");
    expect(engineClient.recordFields).toEqual([]);
  });

  test.each([
    ["recursiveCteMaxDepth", 0],
    ["recursiveCteMaxRows", -1],
    ["recursiveCteMaxExpansions", Number.MAX_SAFE_INTEGER + 1],
  ] as const)("engine rejects invalid %s before API access", async (name, value) => {
    const mock = client();
    await expect(execute(RECURSIVE, mock, { [name]: value })).rejects.toThrow("positive safe integer");
    expect(mock.recordFields).toEqual([]);
  });

  test("CLI and MCP accept all three positive-safe-integer inputs and reject unsafe values", () => {
    expect(parseArgs([
      "--recursive-cte-max-depth", "7",
      "--recursive-cte-max-rows", "80",
      "--recursive-cte-max-expansions", "900",
    ])).toMatchObject({
      recursiveCteMaxDepth: 7,
      recursiveCteMaxRows: 80,
      recursiveCteMaxExpansions: 900,
    });
    expect(() => parseArgs(["--recursive-cte-max-depth", "0"])).toThrow("positive safe integer");
    const input = {
      sql: RECURSIVE,
      recursiveCteMaxDepth: 7,
      recursiveCteMaxRows: 80,
      recursiveCteMaxExpansions: 900,
    };
    expect(z.object(explainInputShape).parse(input)).toMatchObject(input);
    expect(queryInputSchema.parse(input)).toMatchObject(input);
    expect(() => queryInputSchema.parse({
      ...input, recursiveCteMaxRows: Number.MAX_SAFE_INTEGER + 1,
    })).toThrow();
  });
});

describe("B53 Stage 2 projection review fix", () => {
  test("physical materialization fetches the union of seed/term references instead of wildcard fields", async () => {
    const mock = client();
    await execute(`WITH RECURSIVE tree (parent, child, depth, qty) AS (
      SELECT parent, child, 1, qty FROM APP100 WHERE parent = 'ROOT'
      UNION ALL
      SELECT s.parent, s.child, r.depth + 1, r.qty * s.qty
      FROM APP100 s INNER JOIN tree r ON s.parent = r.child
    ) CYCLE child SET is_cycle TO 'Y' DEFAULT 'N'
    SELECT parent, child, depth, qty, is_cycle FROM tree`, mock);
    expect(mock.recordFields).toHaveLength(1);
    expect(mock.recordFields[0]).toEqual(expect.arrayContaining(["parent", "child", "qty"]));
    expect(mock.recordFields[0]).not.toContain("unused");
  });
});
