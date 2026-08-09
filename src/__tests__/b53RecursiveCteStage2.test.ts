import { FetchAllLimitError } from "../api/fetchAll";
import type { KintoneRecord } from "../converter/dmlToKintone";
import {
  execute,
  getSelectColumnMeta,
  type KintoneClient,
  type KintoneFieldInfo,
  type SelectResult,
} from "../execute";
import {
  RECURSIVE_CTE_MAX_DEPTH,
  RECURSIVE_CTE_MAX_EXPANSIONS,
  RECURSIVE_CTE_MAX_ROWS,
  RecursiveCteLimitCounter,
  RecursiveCteLimitError,
} from "../core/recursiveCte";
import { normalizeEngineError } from "../engine-library/errors";
import { Lexer } from "../lexer/lexer";
import { Parser } from "../parser/parser";

function record(values: Record<string, string>): KintoneRecord {
  return Object.fromEntries(Object.entries(values).map(([field, value]) => [field, { value }]));
}

interface MockClient extends KintoneClient {
  readonly recordCalls: Map<number, number>;
}

function mockClient(
  recordsByApp: Readonly<Record<number, readonly KintoneRecord[]>>,
  fieldTypes: Readonly<Record<string, string>> = {}
): MockClient {
  const recordCalls = new Map<number, number>();
  return {
    recordCalls,
    async getRecords(params) {
      recordCalls.set(params.app, (recordCalls.get(params.app) ?? 0) + 1);
      const cursor = Number(params.query.match(/\$id\s*>\s*(\d+)/i)?.[1] ?? "0");
      const rows = (recordsByApp[params.app] ?? []).map((row, index) =>
        row["$id"] ? row : { ...row, $id: { value: String(index + 1) } }
      ).filter((row) => Number(row["$id"]?.value ?? "0") > cursor);
      const limit = Number(params.query.match(/\blimit\s+(\d+)/i)?.[1] ?? "500");
      const offset = Number(params.query.match(/\boffset\s+(\d+)/i)?.[1] ?? "0");
      return { records: rows.slice(offset, offset + limit) };
    },
    async openCursor() { throw new Error("unexpected cursor call"); },
    async postRecords() { return { ids: [] }; },
    async putRecords() { /* read-only mock */ },
    async deleteRecords() { /* read-only mock */ },
    async getApps() { return []; },
    async getFields(appId) {
      const fields = new Set((recordsByApp[appId] ?? []).flatMap((row) => Object.keys(row)));
      return [...fields].filter((field) => !field.startsWith("$")).map((field): KintoneFieldInfo => ({
        code: field,
        label: field,
        fieldType: fieldTypes[field] ?? (field === "depth" || field === "qty" || field === "n" ? "NUMBER" : "SINGLE_LINE_TEXT"),
        sortKind: fieldTypes[field] === "NUMBER" || field === "depth" || field === "qty" || field === "n"
          ? "number"
          : "string",
      }));
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const };
    },
  };
}

function sql(cycle = true, outer?: string): string {
  return `WITH RECURSIVE tree (parent, child, depth, qty) AS (
    SELECT parent, child, 1, qty FROM APP100 WHERE parent = 'ROOT'
    UNION ALL
    SELECT s.parent, s.child, r.depth + 1, r.qty * s.qty
    FROM APP100 AS s INNER JOIN tree AS r ON s.parent = r.child
  )${cycle ? " CYCLE child SET is_cycle TO 'Y' DEFAULT 'N'" : ""}
  ${outer ?? `SELECT parent, child, depth, qty${cycle ? ", is_cycle" : ""} FROM tree`}`;
}

async function run(
  text: string,
  client: KintoneClient,
  options: Parameters<typeof execute>[2] = {}
): Promise<SelectResult> {
  return await execute(text, client, {
    ...options,
    cacheContext: `b53-stage2-${Math.random()}`,
  }) as SelectResult;
}

async function failure(text: string, client: KintoneClient, maxRecords = 200_000): Promise<unknown> {
  try {
    await run(text, client, { maxRecords });
  } catch (error) {
    return error;
  }
  throw new Error("expected failure");
}

describe("B53 Stage 2 §3/§4 positive recursion", () => {
  test("BOM 7-path convergence keeps UNION ALL multiplicity and rolls up in the outer aggregate", async () => {
    const rows = Array.from({ length: 7 }, (_, index) => record({ parent: "ROOT", child: `B${index + 1}`, qty: "1" }))
      .concat(Array.from({ length: 7 }, (_, index) => record({ parent: `B${index + 1}`, child: "MAT-001", qty: String(index + 1) })));
    const client = mockClient({ 100: rows });
    const result = await run(sql(true,
      "SELECT child, SUM(qty) AS required FROM tree WHERE is_cycle = 'N' GROUP BY child ORDER BY child"
    ), client);
    expect(result.rows.find((row) => row.child === "MAT-001")).toEqual({ child: "MAT-001", required: "28" });
    expect(client.recordCalls.get(100)).toBe(1);
  });

  test("diamond convergence is path-scoped rather than global-visited", async () => {
    const client = mockClient({ 100: [
      record({ parent: "ROOT", child: "A", qty: "1" }),
      record({ parent: "ROOT", child: "B", qty: "1" }),
      record({ parent: "A", child: "D", qty: "1" }),
      record({ parent: "B", child: "D", qty: "1" }),
      record({ parent: "D", child: "E", qty: "1" }),
    ] });
    const result = await run(sql(), client);
    expect(result.rows.filter((row) => row.child === "D" && row.is_cycle === "N")).toHaveLength(2);
    expect(result.rows.filter((row) => row.child === "E" && row.is_cycle === "N")).toHaveLength(2);
  });

  test("A to B to C to A emits only the returning A as a marked row and stops that path", async () => {
    const client = mockClient({ 100: [
      record({ parent: "ROOT", child: "A", qty: "1" }),
      record({ parent: "A", child: "B", qty: "1" }),
      record({ parent: "B", child: "C", qty: "1" }),
      record({ parent: "C", child: "A", qty: "1" }),
    ] });
    const result = await run(sql(), client);
    expect(result.rows.map((row) => [row.child, row.is_cycle])).toEqual([
      ["A", "N"], ["B", "N"], ["C", "N"], ["A", "Y"],
    ]);
  });

  test("independent seed occurrences do not share path state", async () => {
    const client = mockClient({ 100: [
      record({ parent: "ROOT", child: "A", qty: "1" }),
      record({ parent: "ROOT", child: "A", qty: "2" }),
      record({ parent: "A", child: "B", qty: "1" }),
    ] });
    const result = await run(sql(), client);
    expect(result.rows.filter((row) => row.child === "B" && row.is_cycle === "N")).toHaveLength(2);
  });

  test("preceding and following non-recursive CTEs work with aliases and static NUMBER metadata", async () => {
    const client = mockClient({ 100: [
      record({ parent: "ROOT", child: "A", qty: "2" }),
      record({ parent: "A", child: "B", qty: "3" }),
    ] });
    const result = await run(`WITH RECURSIVE src AS (SELECT parent, child, qty FROM APP100),
      tree (parent, child, depth, qty) AS (
        SELECT parent, child, 1, qty FROM src WHERE parent = 'ROOT'
        UNION ALL SELECT s.parent, s.child, r.depth + 1, r.qty * s.qty
        FROM src AS s INNER JOIN tree AS r ON s.parent = r.child
      ), totals AS (SELECT child, SUM(qty) AS required FROM tree GROUP BY child)
      SELECT child, required FROM totals ORDER BY child`, client, { captureColumnMeta: true });
    expect(result.rows).toEqual([{ child: "A", required: "2" }, { child: "B", required: "6" }]);
    expect(getSelectColumnMeta(result)?.get("required")?.semantics?.compareMode).toBe("number");
  });

  test("omitted CTE column list and explicitly projected $id keep names, values, and record identity metadata", async () => {
    const client = mockClient({ 100: [
      record({ $id: "10", parent: "ROOT", child: "A", qty: "1" }),
      record({ $id: "11", parent: "A", child: "B", qty: "1" }),
    ] });
    const result = await run(`WITH RECURSIVE tree AS (
      SELECT $id AS source_id, parent, child FROM APP100 WHERE parent = 'ROOT'
      UNION ALL SELECT s.$id AS source_id, s.parent, s.child
      FROM APP100 s INNER JOIN tree r ON s.parent=r.child
    ) SELECT source_id, parent, child FROM tree ORDER BY source_id`, client, { captureColumnMeta: true });
    expect(result.rows).toEqual([
      { source_id: "10", parent: "ROOT", child: "A" },
      { source_id: "11", parent: "A", child: "B" },
    ]);
    expect(getSelectColumnMeta(result)?.get("source_id")?.fieldType).toBe("__ID__");
    expect(result.rows.some((row) => "$id" in row)).toBe(false);
  });
});

describe("B53 Stage 2 §3.4 planning-time proof", () => {
  test("three-branch UNION with self-reference only in branch 3 has the recursive-shape diagnostic", () => {
    const text = `WITH RECURSIVE t (key) AS (
      SELECT parent FROM APP100
      UNION ALL SELECT parent FROM APP100
      UNION ALL SELECT s.parent FROM APP100 s INNER JOIN t r ON s.parent=r.key
    ) SELECT key FROM t`;
    expect(() => new Parser(new Lexer(text).tokenize()).parse())
      .toThrow("再帰 CTE は seed SELECT UNION ALL recursive SELECT の2分岐で指定してください");
  });

  test.each([
    ["unnamed expression", `WITH RECURSIVE t AS (SELECT parent, 1 FROM APP100 UNION ALL SELECT s.parent, r.parent + 1 FROM APP100 s INNER JOIN t r ON s.parent=r.parent) SELECT parent FROM t`, /AS 別名/],
    ["duplicate implicit name", `WITH RECURSIVE t AS (SELECT parent, parent FROM APP100 UNION ALL SELECT s.parent, s.parent FROM APP100 s INNER JOIN t r ON s.parent=r.parent) SELECT parent FROM t`, /重複/],
    ["unknown field", `WITH RECURSIVE t (a) AS (SELECT missing FROM APP100 UNION ALL SELECT s.missing FROM APP100 s INNER JOIN t r ON s.parent=r.a) SELECT a FROM t`, /型を証明できません/],
    ["string arithmetic", `WITH RECURSIVE t (a) AS (SELECT parent FROM APP100 UNION ALL SELECT r.a + 1 FROM APP100 s INNER JOIN t r ON s.parent=r.a) SELECT a FROM t`, /数値でない列/],
  ])("rejects %s before record fetching", async (_label, text, expected) => {
    const client = mockClient({ 100: [record({ parent: "ROOT", child: "A", qty: "1" })] });
    await expect(run(text, client)).rejects.toThrow(expected);
    expect(client.recordCalls.size).toBe(0);
  });

  test("rejects a seed/term positional type mismatch", async () => {
    const client = mockClient({ 100: [record({ parent: "ROOT", child: "A", qty: "1" })] });
    const text = `WITH RECURSIVE t (value) AS (
      SELECT parent FROM APP100
      UNION ALL SELECT r.value + 1 FROM APP100 s INNER JOIN t r ON s.parent=r.value
    ) SELECT value FROM t`;
    await expect(run(text, client)).rejects.toThrow(/数値でない列|型が一致しません/);
    expect(client.recordCalls.size).toBe(0);
  });

  test("rejects incompatible recursive JOIN key metadata before record fetching", async () => {
    const client = mockClient({ 100: [record({ parent: "ROOT", child: "A", n: "1" })] });
    const text = `WITH RECURSIVE t (parent, child) AS (
      SELECT parent, child FROM APP100
      UNION ALL SELECT s.parent, s.child FROM APP100 s INNER JOIN t r ON s.n=r.child
    ) SELECT child FROM t`;
    await expect(run(text, client)).rejects.toThrow(/JOIN キーの型が一致しません/);
    expect(client.recordCalls.size).toBe(0);
  });
});

describe("B53 Stage 2 §4.6 empty-key warning", () => {
  test("empty root exposure warns once without changing empty-equals-empty multiplicity", async () => {
    const client = mockClient({ 100: [
      record({ parent: "ROOT", child: "", qty: "1" }),
      record({ parent: "", child: "A", qty: "1" }),
      record({ parent: "", child: "B", qty: "1" }),
    ] });
    const result = await run(sql(), client);
    expect(result.rows.filter((row) => row.child === "A" || row.child === "B")).toHaveLength(2);
    expect(result.warnings?.filter((warning) => warning.includes("両側の空キー"))).toHaveLength(1);
    expect(result.warnings?.[0]).toContain("第 1 反復");
  });

  test("empty leaf warns at the later iteration; one-sided and whitespace keys do not warn", async () => {
    const later = await run(sql(), mockClient({ 100: [
      record({ parent: "ROOT", child: "A", qty: "1" }),
      record({ parent: "A", child: "", qty: "1" }),
      record({ parent: "", child: "B", qty: "1" }),
    ] }));
    expect(later.warnings?.[0]).toContain("第 2 反復");

    const oneSided = await run(sql(), mockClient({ 100: [
      record({ parent: "ROOT", child: "", qty: "1" }),
      record({ parent: " ", child: "B", qty: "1" }),
    ] }));
    expect(oneSided.warnings ?? []).toEqual([]);
  });

  test("empty CYCLE value and empty JOIN key are evaluated independently", async () => {
    const client = mockClient({ 100: [
      record({ parent: "ROOT", child: "", qty: "1" }),
      record({ parent: "", child: "", qty: "1" }),
    ] });
    const result = await run(sql(), client);
    expect(result.rows.map((row) => row.is_cycle)).toEqual(["N", "Y"]);
    expect(result.warnings?.filter((warning) => warning.includes("両側の空キー"))).toHaveLength(1);
  });
});

describe("B53 Stage 2 §5.1/§6 absolute limits", () => {
  test("depth 101 is a structured error while natural termination at depth 100 succeeds", async () => {
    const chain = (lastEdge: number) => Array.from({ length: lastEdge + 1 }, (_, index) =>
      record({ parent: index === 0 ? "ROOT" : `N${index}`, child: `N${index + 1}`, qty: "1" })
    );
    const exact = await run(sql(false), mockClient({ 100: chain(100) }));
    expect(exact.rows).toHaveLength(101);

    const error = await failure(sql(false), mockClient({ 100: chain(101) }));
    expect(error).toBeInstanceOf(RecursiveCteLimitError);
    expect(error).toMatchObject({
      kind: "DEPTH", limit: RECURSIVE_CTE_MAX_DEPTH, detected: 101, cteName: "tree",
    });
  });

  test("row 10,001 is rejected and exactly 10,000 rows succeed", async () => {
    const make = (count: number) => Array.from({ length: count }, (_, index) =>
      record({ parent: "ROOT", child: `L${index}`, qty: "1" })
    );
    expect((await run(sql(false), mockClient({ 100: make(10_000) }), { maxRecords: 10_002 })).rows).toHaveLength(10_000);
    const error = await failure(sql(false), mockClient({ 100: make(10_001) }), 10_003);
    expect(error).toMatchObject({
      kind: "ROWS", limit: RECURSIVE_CTE_MAX_ROWS, detected: 10_001, cteName: "tree",
    });
  }, 30_000);

  test("expansion counter accepts exactly 100,000 and rejects candidate pair 100,001", () => {
    const counter = new RecursiveCteLimitCounter("t");
    for (let index = 0; index < RECURSIVE_CTE_MAX_EXPANSIONS; index++) counter.addExpansion();
    expect(() => counter.addExpansion()).toThrow(expect.objectContaining({
      kind: "EXPANSIONS", limit: RECURSIVE_CTE_MAX_EXPANSIONS, detected: 100_001, cteName: "t",
    }));
  });

  test("runtime counts JOIN pairs before recursive WHERE: exactly 100,000 succeeds and 100,001 fails", async () => {
    const text = `WITH RECURSIVE t (key) AS (
      SELECT child FROM APP100 WHERE parent = 'ROOT'
      UNION ALL SELECT s.child FROM APP100 s INNER JOIN t r ON s.parent=r.key WHERE s.keep = 'never'
    ) SELECT key FROM t`;
    const make = (seedCount: number) => [
      ...Array.from({ length: seedCount }, () => record({ parent: "ROOT", child: "K", keep: "seed" })),
      ...Array.from({ length: 400 }, (_, index) => record({ parent: "K", child: `X${index}`, keep: "source" })),
    ];
    expect((await run(text, mockClient({ 100: make(250) }))).rows).toHaveLength(250);
    const error = await failure(text, mockClient({ 100: make(251) }));
    expect(error).toMatchObject({
      kind: "EXPANSIONS", limit: RECURSIVE_CTE_MAX_EXPANSIONS, detected: 100_001, cteName: "t",
    });
  }, 30_000);

  test("limit error message is Japanese, has no R2 identifier, and engine normalization stays EXECUTION_ERROR", () => {
    const error = new RecursiveCteLimitError("ROWS", 10_000, 10_001, "tree");
    expect(error.message).toContain("tree");
    expect(error.message).toContain("10000");
    expect(error.message).toContain("10001");
    expect(error.message).not.toMatch(/^RECURSIVE_CTE_MAX_/);
    const normalized = normalizeEngineError(error);
    expect(normalized.code).toBe("EXECUTION_ERROR");
    expect(normalized.cause).toBe(error);
  });

  test("source overflow remains FetchAllLimitError and truncate is disabled", async () => {
    const rows = Array.from({ length: 3 }, (_, index) => record({ parent: "ROOT", child: `L${index}`, qty: "1" }));
    const error = await failure(sql(false), mockClient({ 100: rows }), 2);
    expect(error).toBeInstanceOf(FetchAllLimitError);
    await expect(run(sql(false), mockClient({ 100: rows }), { maxRecords: 2, onLimitReached: "truncate" }))
      .rejects.toBeInstanceOf(FetchAllLimitError);
  });

  test("maxRecords is enforced per physical app and one overflowing app prevents iteration", async () => {
    const text = `WITH RECURSIVE t (parent, child) AS (
      SELECT parent, child FROM APP100 WHERE parent = 'ROOT'
      UNION ALL SELECT s.parent, s.child FROM APP200 s INNER JOIN t r ON s.parent=r.child
    ) SELECT child FROM t`;
    const client = mockClient({
      100: [record({ parent: "ROOT", child: "A" }), record({ parent: "ROOT", child: "B" })],
      200: Array.from({ length: 4 }, (_, index) => record({ parent: "A", child: `X${index}` })),
    });
    const error = await failure(text, client, 3);
    expect(error).toBeInstanceOf(FetchAllLimitError);
    expect(client.recordCalls.get(100)).toBe(1);
    expect(client.recordCalls.get(200)).toBe(1);

    const withinPerApp = await run(text, mockClient({
      100: [record({ parent: "ROOT", child: "A" }), record({ parent: "ROOT", child: "B" })],
      200: [record({ parent: "A", child: "X" }), record({ parent: "B", child: "Y" })],
    }), { maxRecords: 3 });
    expect(withinPerApp.rows).toHaveLength(4);
  });

  test("outer LIMIT does not bypass recursive row limits and no partial result is returned", async () => {
    const rows = Array.from({ length: 10_001 }, (_, index) =>
      record({ parent: "ROOT", child: `L${index}`, qty: "1" })
    );
    const error = await failure(sql(false, "SELECT parent FROM tree LIMIT 1"), mockClient({ 100: rows }), 10_003);
    expect(error).toMatchObject({ kind: "ROWS", detected: 10_001 });
  }, 30_000);
});
