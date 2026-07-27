import {
  execute,
  executeBatch,
  SearchAbortedError,
  type KintoneClient,
  type SelectResult,
} from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";
import { whereToKintone } from "../converter/whereToKintone";
import { resolveFieldSemantics } from "../core/fieldSemantics";
import type { KlikeExpr } from "../core/like";
import {
  decomposeRelativeDatePrefilter,
  type RelativeDatePrefilterDecomposition,
  type RelativeDatePrefilterTestSeam,
} from "../core/optimization/relativeDatePrefilterPlan";
import { classifyWhereCapability } from "../core/optimization/whereCapability";
import { parseSqlStatement } from "../core/sql";
import { applyFilter } from "../engine/process";
import type {
  BinaryExpr,
  SelectStatement,
  WhereExpr,
} from "../types/ast";

type GetRecordsParams = Parameters<KintoneClient["getRecords"]>[0];
type GetRecordsResponse = Awaited<ReturnType<KintoneClient["getRecords"]>>;

const FIELD_TYPES = new Map<string, string>([
  ["$id", "__ID__"],
  ["日付", "DATE"],
  ["日時", "DATETIME"],
  ["作成日時", "CREATED_TIME"],
  ["更新日時", "UPDATED_TIME"],
  ["作成者", "CREATOR"],
  ["件名", "SINGLE_LINE_TEXT"],
  ["備考", "SINGLE_LINE_TEXT"],
  ["状態", "SINGLE_LINE_TEXT"],
  ["金額", "NUMBER"],
  ["テーブル", "SUBTABLE"],
  ["子", "SINGLE_LINE_TEXT"],
]);

function record(id: number, fields: Record<string, string>): KintoneRecord {
  return {
    $id: { value: String(id) },
    ...Object.fromEntries(
      Object.entries(fields).map(([code, value]) => [code, { value }])
    ),
  };
}

function makeClient(
  responder: (
    params: GetRecordsParams,
    callIndex: number
  ) => GetRecordsResponse | Promise<GetRecordsResponse> = async () => ({
    records: [],
  })
) {
  let callIndex = 0;
  const calls = {
    records: jest.fn(async (params: GetRecordsParams) =>
      responder(params, callIndex++)),
    cursorOpen: jest.fn(async () => ({
      totalCount: 0,
      nextPage: jest.fn(async () => ({ records: [], next: false })),
      close: jest.fn(async () => undefined),
    })),
    post: jest.fn(async () => ({ ids: [] })),
    put: jest.fn(async () => undefined),
    delete: jest.fn(async () => undefined),
    confirm: jest.fn(async () => true),
  };
  const client: KintoneClient = {
    getRecords: calls.records,
    openCursor: calls.cursorOpen,
    postRecords: calls.post,
    putRecords: calls.put,
    deleteRecords: calls.delete,
    async getApps() { return []; },
    async getFields() {
      return [
        { code: "日付", label: "日付", fieldType: "DATE" },
        { code: "日時", label: "日時", fieldType: "DATETIME" },
        { code: "作成日時", label: "作成日時", fieldType: "CREATED_TIME" },
        { code: "更新日時", label: "更新日時", fieldType: "UPDATED_TIME" },
        { code: "作成者", label: "作成者", fieldType: "CREATOR" },
        { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
        { code: "備考", label: "備考", fieldType: "SINGLE_LINE_TEXT" },
        { code: "状態", label: "状態", fieldType: "SINGLE_LINE_TEXT" },
        { code: "金額", label: "金額", fieldType: "NUMBER" },
        { code: "テーブル", label: "テーブル", fieldType: "SUBTABLE" },
        {
          code: "子",
          label: "子",
          fieldType: "SINGLE_LINE_TEXT",
          inSubtable: true,
          subtableCode: "テーブル",
        },
      ];
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" };
    },
  };
  return { client, calls };
}

function expectNoExecutionApi(calls: ReturnType<typeof makeClient>["calls"]) {
  expect(calls.records).not.toHaveBeenCalled();
  expect(calls.cursorOpen).not.toHaveBeenCalled();
  expect(calls.post).not.toHaveBeenCalled();
  expect(calls.put).not.toHaveBeenCalled();
  expect(calls.delete).not.toHaveBeenCalled();
  expect(calls.confirm).not.toHaveBeenCalled();
}

function select(sql: string): SelectStatement {
  return parseSqlStatement(sql) as SelectStatement;
}

function resolveAcceptanceField(field: { field: string }) {
  const fieldType = FIELD_TYPES.get(field.field);
  return fieldType ? resolveFieldSemantics({ fieldType }) : undefined;
}

function decompose(
  sql: string,
  seam: RelativeDatePrefilterTestSeam = {}
): RelativeDatePrefilterDecomposition {
  return decomposeRelativeDatePrefilter(
    select(sql),
    resolveAcceptanceField,
    seam
  );
}

function eligible(sql: string) {
  const result = decompose(sql);
  expect(result.eligible).toBe(true);
  if (!result.eligible) {
    throw new Error(`eligible plan expected: ${result.reasonCodes.join(",")}`);
  }
  return result.plan;
}

function binaryLeaves(where: WhereExpr | null): BinaryExpr[] {
  if (where === null) return [];
  switch (where.type) {
    case "BINARY":
      return [where];
    case "LOGICAL":
      return [...binaryLeaves(where.left), ...binaryLeaves(where.right)];
    case "NOT":
    case "GROUP":
      return binaryLeaves(where.expr);
    case "EXISTS":
      return binaryLeaves(where.query.where);
    case "NULL_CHECK":
    case "BOOLEAN":
      return [];
  }
}

function relativeNames(where: WhereExpr | null): string[] {
  const names: string[] = [];
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const node = value as Record<string, unknown>;
    if (
      node["type"] === "KINTONE_FUNC"
      && typeof node["name"] === "string"
      && !["TODAY", "NOW", "LOGINUSER"].includes(node["name"])
    ) {
      names.push(node["name"]);
    }
    Object.values(node).forEach(visit);
  };
  visit(where);
  return names;
}

function resultRows(result: unknown): SelectResult {
  return result as SelectResult;
}

function planText(result: Awaited<ReturnType<typeof execute>>): string {
  if (result.type !== "SELECT") throw new Error(`unexpected ${result.type}`);
  return result.rows.map((row) => row.plan).join("\n");
}

test("9.1-1 relative exact + LENGTH を server prefilter と client residual に分離する", async () => {
  const sql = "SELECT $id, 件名 FROM APP100 "
    + "WHERE 更新日時 >= YESTERDAY() AND LENGTH(件名) > 1";
  const plan = eligible(sql);
  expect(whereToKintone(plan.prefilterWhere!)).toBe("更新日時 >= YESTERDAY()");
  expect(relativeNames(plan.residualWhere)).toEqual([]);

  const { client, calls } = makeClient(async () => ({
    records: [
      record(1, { 更新日時: "2026-07-24T00:00:00Z", 件名: "A" }),
      record(2, { 更新日時: "2026-07-24T00:00:00Z", 件名: "AB" }),
    ],
  }));
  expect(resultRows(await execute(sql, client)).rows)
    .toEqual([{ $id: "2", 件名: "AB" }]);
  expect(calls.records.mock.calls[0][0].query).toBe(
    "更新日時 >= YESTERDAY() order by $id asc limit 500 offset 0"
  );
});

test("9.1-2 初回・後続 GET は relative base predicate を保ち client relative 評価を0件にする", async () => {
  const sql = "SELECT $id FROM APP100 "
    + "WHERE 更新日時 >= YESTERDAY() AND LENGTH(件名) > 1";
  expect(relativeNames(eligible(sql).residualWhere)).toEqual([]);
  const firstPage = Array.from({ length: 500 }, (_, index) =>
    record(index + 1, {
      更新日時: "2026-07-24T00:00:00Z",
      件名: "AB",
    }));
  const { client, calls } = makeClient(async (_params, callIndex) => ({
    records: callIndex === 0
      ? firstPage
      : [record(501, {
        更新日時: "2026-07-24T00:00:00Z",
        件名: "ABC",
      })],
  }));

  expect(resultRows(await execute(sql, client, { maxRecords: 1_000 })).rowCount)
    .toBe(501);
  expect(calls.records.mock.calls.map(([params]) => params.query)).toEqual([
    "更新日時 >= YESTERDAY() order by $id asc limit 500 offset 0",
    "更新日時 >= YESTERDAY() order by $id asc limit 500 offset 500",
  ]);
});

test("9.1-3 relative exact + normal LIKE は LIKE を query に載せず client 評価する", async () => {
  const sql = "SELECT $id FROM APP100 "
    + "WHERE 更新日時 >= YESTERDAY() AND 件名 LIKE 'A%'";
  const { client, calls } = makeClient(async () => ({
    records: [
      record(1, { 更新日時: "2026-07-24T00:00:00Z", 件名: "Alpha" }),
      record(2, { 更新日時: "2026-07-24T00:00:00Z", 件名: "Beta" }),
    ],
  }));

  expect(resultRows(await execute(sql, client)).rows).toEqual([{ $id: "1" }]);
  expect(calls.records.mock.calls[0][0].query)
    .toBe("更新日時 >= YESTERDAY() order by $id asc limit 500 offset 0");
});

test("9.1-4 relative exact + KLIKE + LIKE は KLIKE identity を保ち LIKE だけで最終結果を絞る", async () => {
  const sql = "SELECT $id FROM APP100 WHERE 更新日時 >= YESTERDAY() "
    + "AND 件名 KLIKE '至急' AND 備考 LIKE '対%'";
  const stmt = select(sql);
  const leaves = binaryLeaves(stmt.where);
  const klike = leaves.find((leaf) => leaf.op === "KLIKE") as KlikeExpr;
  const like = leaves.find((leaf) => leaf.op === "LIKE")!;
  const decomposition = decomposeRelativeDatePrefilter(
    stmt,
    resolveAcceptanceField
  );
  if (!decomposition.eligible) throw new Error("eligible plan expected");
  expect(decomposition.plan.appliedKlikes.has(klike)).toBe(true);
  expect(binaryLeaves(decomposition.plan.residualWhere)).toEqual(
    expect.arrayContaining([klike, like])
  );

  const { client, calls } = makeClient(async () => ({
    records: [
      record(1, {
        更新日時: "2026-07-24T00:00:00Z",
        件名: "至急",
        備考: "対象",
      }),
      record(2, {
        更新日時: "2026-07-24T00:00:00Z",
        件名: "至急",
        備考: "除外",
      }),
    ],
  }));
  expect(resultRows(await execute(sql, client)).rows).toEqual([{ $id: "1" }]);
  expect(calls.records.mock.calls[0][0].query).toContain('件名 like "至急"');
  expect(calls.records.mock.calls[0][0].query).not.toContain("備考 like");
});

test("9.1-5 複数 relative leaf は全て query に載り residual occurrence は0件になる", async () => {
  const sql = "SELECT $id FROM APP100 WHERE 更新日時 >= YESTERDAY() "
    + "AND 作成日時 <= TOMORROW() AND LENGTH(件名) > 1";
  const plan = eligible(sql);
  expect([...plan.relativeFunctionNames]).toEqual(["YESTERDAY", "TOMORROW"]);
  expect(plan.exactRelativeLeaves).toHaveLength(2);
  expect(relativeNames(plan.residualWhere)).toEqual([]);

  const { client, calls } = makeClient(async () => ({
    records: [record(1, {
      更新日時: "2026-07-24T00:00:00Z",
      作成日時: "2026-07-25T00:00:00Z",
      件名: "AB",
    })],
  }));
  expect(resultRows(await execute(sql, client)).rowCount).toBe(1);
  expect(calls.records.mock.calls[0][0].query).toContain(
    "更新日時 >= YESTERDAY()"
  );
  expect(calls.records.mock.calls[0][0].query).toContain(
    "作成日時 <= TOMORROW()"
  );
});

test("9.1-6 relative-free OR subtree は identity を保った client residual として許可する", async () => {
  const sql = "SELECT $id FROM APP100 WHERE 更新日時 >= YESTERDAY() "
    + "AND (件名 LIKE 'A%' OR 備考 LIKE 'B%')";
  const stmt = select(sql);
  if (stmt.where?.type !== "LOGICAL") throw new Error("unexpected fixture AST");
  const originalOr = stmt.where.right;
  const decomposition = decomposeRelativeDatePrefilter(
    stmt,
    resolveAcceptanceField
  );
  if (!decomposition.eligible) throw new Error("eligible plan expected");
  expect(decomposition.plan.residualWhere).toBe(originalOr);

  const { client } = makeClient(async () => ({
    records: [
      record(1, { 更新日時: "2026-07-24T00:00:00Z", 件名: "Alpha", 備考: "" }),
      record(2, { 更新日時: "2026-07-24T00:00:00Z", 件名: "No", 備考: "Beta" }),
      record(3, { 更新日時: "2026-07-24T00:00:00Z", 件名: "No", 備考: "No" }),
    ],
  }));
  expect(resultRows(await execute(sql, client)).rows)
    .toEqual([{ $id: "1" }, { $id: "2" }]);
});

test("9.1-7 Phase1 pure exact は EXACT_PUSHDOWN と server-only query を維持する", async () => {
  const sql = "SELECT 日付 FROM APP100 WHERE 日付 = YESTERDAY()";
  expect(decompose(sql)).toMatchObject({
    eligible: false,
    disposition: "DEFER_PHASE1",
    capability: "EXACT_PUSHDOWN",
    reasonCodes: ["DEFER_TO_PHASE1"],
  });
  const { client, calls } = makeClient();
  await expect(execute(sql, client)).resolves.toMatchObject({ type: "SELECT" });
  expect(calls.records.mock.calls[0][0].query)
    .toBe("日付 = YESTERDAY() order by $id asc limit 500 offset 0");
});

test.each([
  [
    "9.2-1 OR",
    "SELECT $id FROM APP100 WHERE 更新日時 >= YESTERDAY() OR LENGTH(件名) > 1",
  ],
  [
    "9.2-1 NOT",
    "SELECT $id FROM APP100 WHERE NOT (更新日時 >= YESTERDAY()) "
      + "AND LENGTH(件名) > 1",
  ],
  [
    "9.2-1 non-exact operator",
    "SELECT $id FROM APP100 WHERE 更新日時 LIKE YESTERDAY() "
      + "AND LENGTH(件名) > 1",
  ],
  [
    "9.2-1 non-exact type",
    "SELECT $id FROM APP100 WHERE 件名 >= YESTERDAY() AND LENGTH(備考) > 1",
  ],
  [
    "9.2-1 non-exact context",
    "SELECT $id FROM APP100 WHERE UPPER(更新日時) >= YESTERDAY() "
      + "AND LENGTH(件名) > 1",
  ],
])("%s は records/cursor/mutation API 前に拒否する", async (_label, sql) => {
  const { client, calls } = makeClient();
  await expect(execute(sql, client, { confirm: calls.confirm }))
    .rejects.toThrow(/WHERE_RELATIVE_DATE/);
  expectNoExecutionApi(calls);
});

test.each([
  [
    "9.2-2 serialize failure",
    { serialize: () => { throw new Error("fault"); } },
    "PREFILTER_SERIALIZATION_FAILED",
  ],
  [
    "9.2-2 missing function",
    { containsFunctions: () => false },
    "PREFILTER_FUNCTION_MISSING",
  ],
  [
    "9.2-2 residual remained",
    { rewriteResidual: (where: WhereExpr) => where },
    "RESIDUAL_RELATIVE_DATE_REMAINED",
  ],
] as const)("%s は decomposition seam で ineligible になり API 開始不能", (
  _label,
  seam,
  reason
) => {
  expect(decompose(
    "SELECT $id FROM APP100 "
      + "WHERE 更新日時 >= YESTERDAY() AND LENGTH(件名) > 1",
    seam
  )).toMatchObject({
    eligible: false,
    disposition: "INELIGIBLE",
    reasonCodes: [reason],
  });
});

test.each([
  [
    "9.2-3 KORDER native",
    "SELECT $id FROM APP100 WHERE 更新日時 >= YESTERDAY() "
      + "AND LENGTH(件名) > 1 KORDER BY $id LIMIT 10",
  ],
  [
    "9.2-3 KORDER cursor",
    "SELECT $id FROM APP100 WHERE 更新日時 >= YESTERDAY() "
      + "AND LENGTH(件名) > 1 KORDER BY $id LIMIT 501",
  ],
])("%s は records API 前に拒否し cursor creation 0", async (_label, sql) => {
  const { client, calls } = makeClient();
  await expect(execute(sql, client)).rejects.toThrow(
    /WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN/
  );
  expectNoExecutionApi(calls);
});

test.each([
  [
    "9.2-4 UPDATE",
    "UPDATE APP100 SET 状態 = 'x' WHERE 更新日時 >= YESTERDAY() "
      + "AND LENGTH(件名) > 1",
  ],
  [
    "9.2-4 DELETE",
    "DELETE FROM APP100 WHERE 更新日時 >= YESTERDAY() AND LENGTH(件名) > 1",
  ],
  [
    "9.2-4 SELECT-based DML source",
    "INSERT INTO APP200 (件名) SELECT 件名 FROM APP100 "
      + "WHERE 更新日時 >= YESTERDAY() AND LENGTH(件名) > 1",
  ],
  [
    "9.2-4 UPSERT SELECT source",
    "UPSERT INTO APP200 (件名) SELECT 件名 FROM APP100 "
      + "WHERE 更新日時 >= YESTERDAY() AND LENGTH(件名) > 1 "
      + "ON DUPLICATE (件名)",
  ],
  [
    "9.2-4 VALIDATE",
    "VALIDATE APP100 WHERE 更新日時 >= YESTERDAY() AND LENGTH(件名) > 1",
  ],
  [
    "9.2-4 subtable",
    "SELECT $id FROM APP100$テーブル WHERE 更新日時 >= YESTERDAY() "
      + "AND LENGTH(子) > 1",
  ],
  [
    "9.2-4 materialized CTE",
    "WITH c AS (SELECT 更新日時, 件名 FROM APP100), "
      + "unused AS (SELECT 件名 FROM APP200) SELECT 件名 FROM c "
      + "WHERE 更新日時 >= YESTERDAY() AND LENGTH(件名) > 1",
  ],
])("%s は mutation/confirm を含む execution API 0で拒否する", async (
  _label,
  sql
) => {
  const { client, calls } = makeClient();
  await expect(execute(sql, client, { confirm: calls.confirm }))
    .rejects.toThrow(/WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN/);
  expectNoExecutionApi(calls);
});

test("9.2-4 JOIN residual は第5-Lで関数leafだけを消費し新しいrowsを固定する", async () => {
  const { client, calls } = makeClient(async (params) => {
    const source = params.app === 100
      ? [record(1, { 更新日時: "2026-07-26T00:00:00Z", 件名: "ok" })]
      : [record(1, {})];
    return {
      records: source.map((row) => Object.fromEntries(
        params.fields.flatMap((field) =>
          row[field] === undefined ? [] : [[field, row[field]]]
        )
      ) as KintoneRecord),
    };
  });
  const result = await execute(
    "SELECT a.$id FROM APP100 a JOIN APP200 b ON a.$id = b.$id "
      + "WHERE a.更新日時 >= YESTERDAY() AND LENGTH(a.件名) > 1",
    client,
    { confirm: calls.confirm }
  ) as SelectResult;

  expect(result.rows).toEqual([{ $id: "1" }]);
  expect(calls.records.mock.calls.find(([params]) => params.app === 100)?.[0].query)
    .toContain("更新日時 >= YESTERDAY()");
  expect(calls.cursorOpen).not.toHaveBeenCalled();
  expect(calls.post).not.toHaveBeenCalled();
  expect(calls.put).not.toHaveBeenCalled();
  expect(calls.delete).not.toHaveBeenCalled();
  expect(calls.confirm).not.toHaveBeenCalled();
});

test("9.2-4 pure-exact SELECT-based DML source は Phase1 許可形を維持する", async () => {
  const { client, calls } = makeClient(async () => ({
    records: [record(1, { 日付: "2026-07-24", 件名: "exact" })],
  }));

  await expect(execute(
    "INSERT INTO APP200 (件名) SELECT 件名 FROM APP100 WHERE 日付 = YESTERDAY()",
    client,
    { confirm: calls.confirm }
  )).resolves.toBeDefined();

  expect(calls.records).toHaveBeenCalledTimes(1);
  expect(calls.records.mock.calls[0][0].query).toContain("日付 = YESTERDAY()");
  expect(calls.confirm).toHaveBeenCalledTimes(1);
  expect(calls.post).toHaveBeenCalledTimes(1);
});

test("9.2-4 temp materialization は batch でも API 0で拒否する", async () => {
  const { client, calls } = makeClient();
  const result = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT 更新日時, 件名 FROM APP100 "
      + "WHERE 更新日時 >= YESTERDAY() AND LENGTH(件名) > 1; "
      + "SELECT * FROM #t",
    client,
    { confirm: calls.confirm }
  );
  expect(result.ok).toBe(false);
  expect(result.statements[0].error?.message)
    .toContain("WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN");
  expectNoExecutionApi(calls);
});

test("9.2-5 planner bypass で relative node が evalWhere に到達すると backstop が throw する", () => {
  const stmt = select(
    "SELECT $id FROM APP100 WHERE 更新日時 >= YESTERDAY()"
  );
  expect(() => applyFilter(
    [{ $id: "1", 更新日時: "2026-07-24T00:00:00Z" }],
    stmt.where
  )).toThrow(
    /YESTERDAY: WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN/
  );
});

test("9.2-6 relative REST error は空 query/full scan retryせず error として伝播する", async () => {
  const failure = new Error("relative REST failure");
  const { client, calls } = makeClient(async () => {
    throw failure;
  });
  await expect(execute(
    "SELECT $id FROM APP100 "
      + "WHERE 更新日時 >= YESTERDAY() AND LENGTH(件名) > 1",
    client
  )).rejects.toBe(failure);
  expect(calls.records).toHaveBeenCalledTimes(1);
  expect(calls.records.mock.calls[0][0].query).toContain("YESTERDAY()");
  expect(calls.records.mock.calls[0][0].query).not.toMatch(/^order by/);
});

test.each([
  ["9.3-1 TODAY", "日付 = TODAY()", "日付 = TODAY()"],
  ["9.3-1 NOW", "日時 <= NOW()", "日時 <= NOW()"],
  ["9.3-1 LOGINUSER", "作成者 = LOGINUSER()", "作成者 = LOGINUSER()"],
])("%s は既存 parse/query byte を維持する", (_label, predicate, expected) => {
  const stmt = select(`SELECT * FROM APP100 WHERE ${predicate}`);
  expect(whereToKintone(stmt.where!)).toBe(expected);
});

test("9.3-2 B32/LIKE/safe-leaf/KLIKE の capability・reason・identity を維持する", async () => {
  const likeOnly = select("SELECT $id FROM APP100 WHERE 件名 LIKE 'A%'");
  expect(classifyWhereCapability(likeOnly.where, resolveAcceptanceField))
    .toMatchObject({
      capability: "LOCAL_ONLY",
      reasons: expect.arrayContaining([
        expect.objectContaining({ code: "WHERE_RESIDUAL" }),
      ]),
    });

  const safeSql = "SELECT $id FROM APP100 WHERE $id > 1 AND 件名 LIKE 'A%'";
  const safe = makeClient(async () => ({
    records: [
      record(2, { 件名: "Alpha" }),
      record(3, { 件名: "Beta" }),
    ],
  }));
  expect(resultRows(await execute(safeSql, safe.client)).rows)
    .toEqual([{ $id: "2" }]);
  expect(safe.calls.records.mock.calls[0][0].query).toContain("$id > 1");
  expect(safe.calls.records.mock.calls[0][0].query).not.toContain("件名 like");

  const klikeSql = "SELECT $id FROM APP100 WHERE 件名 KLIKE '至急'";
  const klikeStmt = select(klikeSql);
  const klikeLeaf = binaryLeaves(klikeStmt.where)[0] as KlikeExpr;
  expect(classifyWhereCapability(klikeStmt.where, resolveAcceptanceField))
    .toMatchObject({ capability: "EXACT_PUSHDOWN" });
  const klikeClient = makeClient(async () => ({
    records: [record(1, { 件名: "server matched fixture" })],
  }));
  expect(resultRows(await execute(klikeSql, klikeClient.client)).rowCount).toBe(1);
  expect(klikeLeaf.op).toBe("KLIKE");
  expect(klikeClient.calls.records.mock.calls[0][0].query)
    .toContain('件名 like "至急"');
});

test("9.3-3 Node execution と EXPLAIN は同じ core planner の server prefilter query を返す", async () => {
  const sql = "SELECT $id FROM APP100 "
    + "WHERE 更新日時 >= YESTERDAY() AND LENGTH(件名) > 1";
  const explained = makeClient();
  const text = planText(await execute(`EXPLAIN ${sql}`, explained.client));
  expectNoExecutionApi(explained.calls);
  const explainPrefilter = text.match(/server prefilter: (.+)/)?.[1];
  expect(explainPrefilter).toBe("更新日時 >= YESTERDAY()");

  const executed = makeClient();
  await execute(sql, executed.client);
  const executionBase = executed.calls.records.mock.calls[0][0].query
    .replace(/ order by \$id asc limit 500 offset 0$/, "");
  expect(executionBase).toBe(explainPrefilter);

  // CLI/MCP/plugin は同一 core planner を共有するため query/result/EXPLAIN/reason
  // は構造上同一。built artifact と Firefox/Chrome は別 acceptance gate で確認する。
});

test("9.3-4 maxRecords/complete-input/SearchAbortedError は部分結果を返さない", async () => {
  const mixed = makeClient(async () => ({
    records: [
      record(1, {
        更新日時: "2026-07-24T00:00:00Z",
        件名: "AB",
        金額: "1",
      }),
      record(2, {
        更新日時: "2026-07-24T00:00:00Z",
        件名: "ABC",
        金額: "2",
      }),
    ],
  }));
  await expect(execute(
    "SELECT STDDEV_POP(金額) AS sd FROM APP100 "
      + "WHERE 更新日時 >= YESTERDAY() AND LENGTH(件名) > 1",
    mixed.client,
    { maxRecords: 1, onLimitReached: "truncate" }
  )).rejects.toThrow(/complete input|正しい結果/);
  expect(mixed.calls.records).toHaveBeenCalledTimes(1);

  const aborted = makeClient(async () => ({
    records: [record(1, { 件名: "x" })],
    searchAborted: true,
  }));
  await expect(execute(
    "UPDATE APP100 SET 状態 = 'x' WHERE 件名 = 'x'",
    aborted.client,
    { confirm: aborted.calls.confirm }
  )).rejects.toBeInstanceOf(SearchAbortedError);
  expect(aborted.calls.confirm).not.toHaveBeenCalled();
  expect(aborted.calls.put).not.toHaveBeenCalled();
});
