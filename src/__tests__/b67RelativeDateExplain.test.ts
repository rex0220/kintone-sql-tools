import {
  execute,
  renderRelativeDateResidualWhere,
  type KintoneClient,
} from "../execute";
import { parseSqlStatement } from "../core/sql";
import type { SelectStatement, WhereExpr } from "../types/ast";

function makeClient() {
  const calls = {
    records: jest.fn(async (_params: Parameters<KintoneClient["getRecords"]>[0]) => ({ records: [] })),
    cursorOpen: jest.fn(async (_params: Parameters<KintoneClient["openCursor"]>[0]) => ({
      totalCount: 0,
      nextPage: async () => ({ records: [], next: false }),
      close: async () => undefined,
    })),
    fields: jest.fn(async () => [
      { code: "日付", label: "日付", fieldType: "DATE" },
      { code: "区分", label: "区分", fieldType: "SINGLE_LINE_TEXT" },
      { code: "作成日時", label: "作成日時", fieldType: "CREATED_TIME" },
      { code: "更新日時", label: "更新日時", fieldType: "UPDATED_TIME" },
      { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
      { code: "備考", label: "備考", fieldType: "SINGLE_LINE_TEXT" },
      { code: "テーブル", label: "テーブル", fieldType: "SUBTABLE" },
      {
        code: "子",
        label: "子",
        fieldType: "SINGLE_LINE_TEXT",
        inSubtable: true,
        subtableCode: "テーブル",
      },
    ]),
    post: jest.fn(async () => ({ ids: [] })),
    put: jest.fn(async () => undefined),
    delete: jest.fn(async () => undefined),
  };
  const client: KintoneClient = {
    getRecords: calls.records,
    openCursor: calls.cursorOpen,
    postRecords: calls.post,
    putRecords: calls.put,
    deleteRecords: calls.delete,
    getApps: async () => [],
    getFields: calls.fields,
    getProcessStatuses: async () => ({ enable: false, states: [] }),
    getNumberPrecision: async () => ({
      digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN",
    }),
  };
  return { client, calls };
}

function planText(result: Awaited<ReturnType<typeof execute>>): string {
  if (result.type !== "SELECT") throw new Error(`unexpected ${result.type}`);
  return result.rows.map((row) => row.plan).join("\n");
}

function expectNoExecutionApi(calls: ReturnType<typeof makeClient>["calls"]) {
  expect(calls.records).not.toHaveBeenCalled();
  expect(calls.cursorOpen).not.toHaveBeenCalled();
  expect(calls.post).not.toHaveBeenCalled();
  expect(calls.put).not.toHaveBeenCalled();
  expect(calls.delete).not.toHaveBeenCalled();
}

test("EXPLAIN は execution と共有する exact plan の server-only facts と query を表示する", async () => {
  const sql = "SELECT 作成日時 FROM APP100 WHERE 作成日時 < FROM_TODAY(5, DAYS)";
  const explained = makeClient();
  const text = planText(await execute(`EXPLAIN ${sql}`, explained.client));

  expect(text).toContain("relative date function: FROM_TODAY");
  expect(text).toContain("evaluation: kintone server");
  expect(text).toContain("field: 作成日時 (CREATED_TIME)");
  expect(text).toContain("operator: <");
  expect(text).toContain("where capability: EXACT_PUSHDOWN");
  expect(text).toContain("client evaluation: forbidden");
  expect(text).toContain("kintone query: 作成日時 < FROM_TODAY(5, DAYS)");
  expectNoExecutionApi(explained.calls);

  const executed = makeClient();
  await execute(sql, executed.client);
  expect(executed.calls.records).toHaveBeenCalledTimes(1);
  expect(executed.calls.records.mock.calls[0][0].query)
    .toMatch(/^作成日時 < FROM_TODAY\(5, DAYS\)(?: |$)/);
});

test("拒否 EXPLAIN は具体的 R2 reason を保持し GET/Cursor plan を表示しない", async () => {
  const sql = "SELECT 件名 FROM APP100 WHERE 件名 = YESTERDAY() KORDER BY 件名 LIMIT 10";
  const explained = makeClient();
  const text = planText(await execute(`EXPLAIN ${sql}`, explained.client));

  expect(text).toContain("relative date function: YESTERDAY");
  expect(text).toContain("plan status: rejected");
  expect(text).toContain("WHERE_RELATIVE_DATE_FIELD_TYPE_UNSUPPORTED");
  expect(text).toContain("WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN");
  expect(text).not.toContain("order plan:    KORDER_NATIVE");
  expect(text).not.toContain("order plan:    KORDER_CURSOR");
  expect(text).not.toContain("REST execution: single GET");
  expect(text).not.toContain("fetch API: POST/GET/DELETE records/cursor.json");
  expectNoExecutionApi(explained.calls);

  const executed = makeClient();
  await expect(execute(sql, executed.client))
    .rejects.toThrow(/WHERE_RELATIVE_DATE_FIELD_TYPE_UNSUPPORTED/);
  expectNoExecutionApi(executed.calls);
});

test("Phase2 mixed EXPLAIN は共有 prefilterPlan から server/residual/評価0を表示する", async () => {
  const sql = "SELECT $id FROM APP100 "
    + "WHERE 更新日時 >= YESTERDAY() AND LENGTH(件名) > 1";
  const explained = makeClient();
  const text = planText(await execute(`EXPLAIN ${sql}`, explained.client));

  expect(text).toMatch(/mode:\s+FULL_SCAN/);
  expect(text).toContain("where capability: SUPERSET_PREFILTER");
  expect(text).toContain("relative date function: YESTERDAY");
  expect(text).toContain("relative date evaluation: kintone server exact prefilter");
  expect(text).toContain("field: 更新日時 (UPDATED_TIME)");
  expect(text).toContain("operator: >=");
  expect(text).toContain("server prefilter: 更新日時 >= YESTERDAY()");
  expect(text).toContain("client residual: LENGTH(件名) > 1");
  expect(text).toContain("relative date client evaluations: 0");
  expect(text).toContain("kintone query: 更新日時 >= YESTERDAY()");
  expect(text).not.toContain("kintone query: (なし)");
  expectNoExecutionApi(explained.calls);

  const executed = makeClient();
  await execute(sql, executed.client);
  expect(executed.calls.records.mock.calls[0][0].query).toBe(
    "更新日時 >= YESTERDAY() order by $id asc limit 500 offset 0"
  );
});

test.each([
  [
    "FULL_SCAN",
    "SELECT 区分, COUNT(*) AS c FROM APP100 "
      + "WHERE 日付 = THIS_MONTH() OR 日付 = LAST_MONTH() GROUP BY 区分",
  ],
  [
    "canonical ORDER BY",
    "SELECT 日付 FROM APP100 WHERE 日付 = THIS_MONTH() ORDER BY 日付",
  ],
])("B72 %s EXPLAIN は node の whole-WHERE exact plan と評価0を表示する", async (
  _name,
  sql
) => {
  const explained = makeClient();
  const text = planText(await execute(`EXPLAIN ${sql}`, explained.client));

  expect(text).toContain("relative date evaluation: kintone server whole-WHERE exact");
  expect(text).toContain("where capability: EXACT_PUSHDOWN");
  expect(text).toContain("server predicate: ");
  expect(text).toContain("client residual: (none)");
  expect(text).toContain("relative date client evaluations: 0");
  const predicate = text.match(/server predicate: (.+)/)?.[1];
  const query = text.match(/kintone query: (.+)/)?.[1];
  expect(predicate).toBeDefined();
  expect(query).toBe(predicate);
  expect(text).not.toContain("server prefilter:");
  expectNoExecutionApi(explained.calls);
});

test("B72 exact OR EXPLAIN は全関数を列挙し whole query を一度だけ表示する", async () => {
  const explained = makeClient();
  const text = planText(await execute(
    "EXPLAIN SELECT 区分, COUNT(*) AS c FROM APP100 "
      + "WHERE 日付 = THIS_MONTH() OR 日付 = LAST_MONTH() GROUP BY 区分",
    explained.client
  ));

  expect(text.match(/relative date function: THIS_MONTH/g)).toHaveLength(1);
  expect(text.match(/relative date function: LAST_MONTH/g)).toHaveLength(1);
  expect(text.match(/server predicate:/g)).toHaveLength(1);
  expect(text.match(/client residual:/g)).toHaveLength(1);
  expect(text.match(/relative date client evaluations: 0/g)).toHaveLength(1);
  expect(text).toContain(
    "server predicate: 日付 = THIS_MONTH() or 日付 = LAST_MONTH()"
  );
  expect(text).toContain(
    "kintone query: 日付 = THIS_MONTH() or 日付 = LAST_MONTH()"
  );
  expectNoExecutionApi(explained.calls);
});

test("Phase2 複数 leaf は detail を列挙し合成 prefilter/residual を各1回だけ表示する", async () => {
  const explained = makeClient();
  const text = planText(await execute(
    "EXPLAIN SELECT $id FROM APP100 WHERE 更新日時 >= YESTERDAY() "
      + "AND 作成日時 <= TOMORROW() "
      + "AND LENGTH(件名) > 1 AND 備考 LIKE 'A%'",
    explained.client
  ));

  expect(text.match(/relative date function: YESTERDAY/g)).toHaveLength(1);
  expect(text.match(/relative date function: TOMORROW/g)).toHaveLength(1);
  expect(text).toContain("field: 更新日時 (UPDATED_TIME)");
  expect(text).toContain("field: 作成日時 (CREATED_TIME)");
  expect(text).toContain("operator: >=");
  expect(text).toContain("operator: <=");
  expect(text.match(/server prefilter:/g)).toHaveLength(1);
  expect(text.match(/client residual:/g)).toHaveLength(1);
  expect(text).toContain("更新日時 >= YESTERDAY()");
  expect(text).toContain("作成日時 <= TOMORROW()");
  expect(text).toContain("LENGTH(件名) > 1");
  expect(text).toContain("備考 LIKE 'A%'");
  expectNoExecutionApi(explained.calls);
});

test("Phase1 pure exact の relative 表示行は従来と byte-identical", async () => {
  const text = planText(await execute(
    "EXPLAIN SELECT 作成日時 FROM APP100 WHERE 作成日時 < FROM_TODAY(5, DAYS)",
    makeClient().client
  ));
  const allLines = text.split("\n");
  const relativeStart = allLines.indexOf("  relative date function: FROM_TODAY");
  const relativeLines = allLines.slice(relativeStart, relativeStart + 7);

  expect(relativeLines).toEqual([
    "  relative date function: FROM_TODAY",
    "  evaluation: kintone server",
    "  field: 作成日時 (CREATED_TIME)",
    "  operator: <",
    "  where capability: EXACT_PUSHDOWN",
    "  client evaluation: forbidden",
    "  kintone query: 作成日時 < FROM_TODAY(5, DAYS)",
  ]);
  expect(text).not.toContain("SUPERSET_PREFILTER");
  expect(text).not.toContain("client residual:");
  expect(text).not.toContain("relative date client evaluations:");
});

test("Phase2 A の relative 表示行は従来と byte-identical", async () => {
  const text = planText(await execute(
    "EXPLAIN SELECT $id FROM APP100 "
      + "WHERE 更新日時 >= YESTERDAY() AND LENGTH(件名) > 1",
    makeClient().client
  ));
  const allLines = text.split("\n");
  const relativeStart = allLines.indexOf("  relative date function: YESTERDAY");
  const relativeLines = allLines.slice(relativeStart, relativeStart + 9);

  expect(relativeLines).toEqual([
    "  relative date function: YESTERDAY",
    "  relative date evaluation: kintone server exact prefilter",
    "  field: 更新日時 (UPDATED_TIME)",
    "  operator: >=",
    "  where capability: SUPERSET_PREFILTER",
    "  server prefilter: 更新日時 >= YESTERDAY()",
    "  client residual: LENGTH(件名) > 1",
    "  relative date client evaluations: 0",
    "  kintone query: 更新日時 >= YESTERDAY()",
  ]);
});

test.each([
  [
    "OR",
    "SELECT $id FROM APP100 WHERE 更新日時 >= YESTERDAY() OR LENGTH(件名) > 1",
  ],
  [
    "NOT",
    "SELECT $id FROM APP100 "
      + "WHERE NOT (更新日時 >= YESTERDAY() AND LENGTH(件名) > 1)",
  ],
  [
    "KORDER",
    "SELECT $id FROM APP100 WHERE 更新日時 >= YESTERDAY() "
      + "AND LENGTH(件名) > 1 KORDER BY $id LIMIT 10",
  ],
  [
    "DML",
    "UPDATE APP100 SET 件名 = 'x' "
      + "WHERE 更新日時 >= YESTERDAY() AND LENGTH(件名) > 1",
  ],
  [
    "VALIDATE",
    "VALIDATE APP100 WHERE 更新日時 >= YESTERDAY() AND LENGTH(件名) > 1",
  ],
  [
    "subtable",
    "UPDATE APP100$テーブル SET 子 = 'x' WHERE 更新日時 >= YESTERDAY()",
  ],
])("%s reject は execution と同じ reason を表示し executable query を出さない", async (
  _label,
  sql
) => {
  const explained = makeClient();
  const text = planText(await execute(`EXPLAIN ${sql}`, explained.client));
  expect(text).toContain("plan status: rejected");
  expect(text).toContain("WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN");
  expect(text).not.toContain("kintone query:");
  expect(text).not.toContain("server prefilter:");
  expectNoExecutionApi(explained.calls);

  const executed = makeClient();
  await expect(execute(sql, executed.client))
    .rejects.toThrow(/WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN/);
  expectNoExecutionApi(executed.calls);
});

test("B76 Step 4: JOIN第5-LはEXPLAINと実行の両方で同じplanを許可する", async () => {
  const sql = "SELECT a.更新日時 FROM APP100 a JOIN APP200 b ON a.$id = b.$id "
    + "WHERE a.更新日時 >= YESTERDAY()";
  const explained = makeClient();
  const text = planText(await execute(`EXPLAIN ${sql}`, explained.client));
  expect(text).toContain("join pushdown plan: applied (runtime metadata resolved)");
  expect(text).toContain("allow form: JOIN_SERVER_FUNCTION_EXACT (whole-WHERE)");
  expect(text).toContain("pushdown applied: 更新日時 >= YESTERDAY()");
  expect(text).toContain("client residual: (none)");
  expect(text).toContain("relative date client evaluations: 0");
  expectNoExecutionApi(explained.calls);

  const executed = makeClient();
  await expect(execute(sql, executed.client)).resolves.toMatchObject({
    type: "SELECT",
    rows: [],
  });
  expect(executed.calls.records).toHaveBeenCalledTimes(1);
  expect(executed.calls.records.mock.calls[0][0].query)
    .toContain("更新日時 >= YESTERDAY()");
  expect(executed.calls.cursorOpen).not.toHaveBeenCalled();
  expect(executed.calls.post).not.toHaveBeenCalled();
  expect(executed.calls.put).not.toHaveBeenCalled();
  expect(executed.calls.delete).not.toHaveBeenCalled();
});

function parsedWhere(sql: string): WhereExpr {
  const stmt = parseSqlStatement(sql) as SelectStatement;
  if (stmt.where === null) throw new Error("WHERE fixture required");
  return stmt.where;
}

test.each([
  ["BINARY/function", "SELECT * FROM APP100 WHERE LENGTH(件名) > 1", "LENGTH(件名) > 1"],
  [
    "LOGICAL/LIKE/KLIKE",
    "SELECT * FROM APP100 WHERE 件名 LIKE 'A%' AND 備考 KLIKE '至急'",
    "(件名 LIKE 'A%' AND 備考 KLIKE '至急')",
  ],
  [
    "NOT/GROUP",
    "SELECT * FROM APP100 WHERE NOT (件名 NOT LIKE 'A%')",
    "NOT ((件名 NOT LIKE 'A%'))",
  ],
  [
    "NULL_CHECK",
    "SELECT * FROM APP100 WHERE 件名 IS NOT NULL",
    "件名 IS NOT NULL",
  ],
])("residual renderer は %s を読みやすく表示する", (_label, sql, expected) => {
  expect(renderRelativeDateResidualWhere(parsedWhere(sql))).toBe(expected);
});

test("residual renderer は未知 shape でも throw せず安全な token へ退避する", () => {
  expect(() => renderRelativeDateResidualWhere(
    { type: "FUTURE_NODE", payload: BigInt(1) } as unknown as WhereExpr
  )).not.toThrow();
  expect(renderRelativeDateResidualWhere(
    { type: "FUTURE_NODE" } as unknown as WhereExpr
  )).toBe("<expr>");
  expect(renderRelativeDateResidualWhere({
    type: "BINARY",
    op: "=",
    left: { type: "FUTURE_FIELD" },
    right: { type: "FUTURE_VALUE" },
  } as unknown as WhereExpr)).toBe("<expr> = <expr>");
});
