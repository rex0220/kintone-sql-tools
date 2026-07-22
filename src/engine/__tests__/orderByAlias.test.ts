import { execute, type KintoneClient, type SelectResult } from "../../execute";
import type { KintoneRecord } from "../../converter/dmlToKintone";
import { resolveFieldSemantics } from "../../core/fieldSemantics";
import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";
import type { SelectStatement } from "../../types/ast";
import { runFullScan, type FieldSemanticsMap } from "../process";

function record(fields: Record<string, string>): KintoneRecord {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { value }]));
}

function statement(sql: string): SelectStatement {
  return new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement;
}

function run(
  sql: string,
  records: KintoneRecord[],
  options: {
    scalarCache?: Map<number, string>;
    orderSemantics?: FieldSemanticsMap;
  } = {}
) {
  return runFullScan({
    stmt: statement(sql),
    tables: new Map([[null, records]]),
    scalarCache: options.scalarCache,
    orderSemantics: options.orderSemantics,
  });
}

const numericAlias = new Map([["sort_key", resolveFieldSemantics({ fieldType: "NUMBER" })]]);
const baseRows = [
  record({ $id: "1", amount: "10", name: "bbb", suffix: "z", status: "Done" }),
  record({ $id: "2", amount: "9", name: "a", suffix: "y", status: "Todo" }),
];

test.each([
  ["FIELD", "amount AS sort_key", numericAlias, ["2", "1"]],
  ["ARITH_COL", "amount * 2 AS sort_key", numericAlias, ["2", "1"]],
  ["STRFUNC_COL", "LENGTH(name) AS sort_key", numericAlias, ["2", "1"]],
  ["CASE_COL", "CASE WHEN amount = 10 THEN 'z' ELSE 'a' END AS sort_key", undefined, ["2", "1"]],
  ["SCALAR_VALUE_COL", "name || suffix AS sort_key", undefined, ["2", "1"]],
] as const)("runFullScan: %s alias を ASC/DESC の値として評価する", (_kind, expression, semantics, asc) => {
  const prefix = `SELECT $id AS id, ${expression} FROM APP100 ORDER BY sort_key`;
  expect(run(`${prefix} ASC`, baseRows, { orderSemantics: semantics }).rows.map((row) => row.id)).toEqual(asc);
  expect(run(`${prefix} DESC`, baseRows, { orderSemantics: semantics }).rows.map((row) => row.id)).toEqual([...asc].reverse());
});

test("runFullScan: LITERAL / SCALAR_SUBQUERY alias は project と同じ値を使い安定ソートする", () => {
  expect(run(
    "SELECT $id AS id, 'same' AS sort_key FROM APP100 ORDER BY sort_key DESC",
    baseRows
  ).rows.map((row) => row.id)).toEqual(["1", "2"]);

  const sql = "SELECT $id AS id, (SELECT name FROM APP200 LIMIT 1) AS sort_key " +
    "FROM APP100 ORDER BY sort_key ASC";
  expect(run(sql, baseRows, { scalarCache: new Map([[1, "cached"]]) }).rows).toEqual([
    { id: "1", sort_key: "cached" },
    { id: "2", sort_key: "cached" },
  ]);
});

test("runFullScan: STRFUNC alias は GROUP BY の有無と DISTINCT の両経路で解決する", () => {
  const rows = [record({ name: "bbb" }), record({ name: "a" }), record({ name: "a" })];
  const grouped = run(
    "SELECT name, LENGTH(name) AS sort_key FROM APP100 GROUP BY name ORDER BY sort_key DESC",
    rows,
    { orderSemantics: numericAlias }
  );
  expect(grouped.rows.map((row) => row.name)).toEqual(["bbb", "a"]);

  const distinct = run(
    "SELECT DISTINCT name AS sort_key FROM APP100 ORDER BY sort_key ASC",
    rows
  );
  expect(distinct.rows.map((row) => row.sort_key)).toEqual(["a", "bbb"]);
});

test("alias semantics は numeric と STATUS 定義順を維持する", () => {
  const numeric = run(
    "SELECT $id AS id, amount AS sort_key FROM APP100 ORDER BY sort_key ASC",
    baseRows,
    { orderSemantics: numericAlias }
  );
  expect(numeric.rows.map((row) => row.id)).toEqual(["2", "1"]); // 9, 10（文字列順ではない）

  const statusSemantics = resolveFieldSemantics({
    fieldType: "STATUS",
    optionOrder: { Todo: 0, Doing: 1, Done: 2 },
  });
  const status = run(
    "SELECT $id AS id, status AS sort_key FROM APP100 ORDER BY sort_key ASC",
    baseRows,
    { orderSemantics: new Map([["sort_key", statusSemantics]]) }
  );
  expect(status.rows.map((row) => row.id)).toEqual(["2", "1"]);
});

test("日付関数 alias は数値順、テキスト alias はコードポイント順で並べる", () => {
  const dates = [
    record({ $id: "1", date: "2026-07-21" }), // Tuesday=3
    record({ $id: "2", date: "2026-07-19" }), // Sunday=1
  ];
  const day = run(
    "SELECT $id AS id, DAYOFWEEK(date) AS sort_key FROM APP100 ORDER BY sort_key ASC",
    dates,
    { orderSemantics: numericAlias }
  );
  expect(day.rows.map((row) => row.id)).toEqual(["2", "1"]);

  const text = run(
    "SELECT $id AS id, name AS sort_key FROM APP100 ORDER BY sort_key ASC",
    [record({ $id: "1", name: "𠮟" }), record({ $id: "2", name: "😀" })]
  );
  expect(text.rows.map((row) => row.id)).toEqual(["2", "1"]);
});

test("CASE alias は型付き IN の project 評価コンテキストと一致する", () => {
  const rows = [record({ $id: "1", amount: "10" }), record({ $id: "2", amount: "9" })];
  const numberType = () => "NUMBER";
  const numberSemantics = () => resolveFieldSemantics({ fieldType: "NUMBER" });
  const result = runFullScan({
    stmt: statement(
      "SELECT $id AS id, CASE WHEN amount IN ('9') THEN 'a' ELSE 'z' END AS sort_key " +
      "FROM APP100 ORDER BY sort_key ASC"
    ),
    tables: new Map([[null, rows]]),
    fieldTypeResolver: numberType,
    fieldSemanticsResolver: numberSemantics,
  });
  expect(result.rows).toEqual([
    { id: "2", sort_key: "a" },
    { id: "1", sort_key: "z" },
  ]);
});

test("SELECT alias は同名物理列より優先し、重複 alias は後勝ちにする", () => {
  const collisionRows = [
    record({ $id: "1", amount: "20", name: "a" }),
    record({ $id: "2", amount: "3", name: "z" }),
  ];
  const collision = run(
    "SELECT $id AS id, amount AS name FROM APP100 ORDER BY name ASC",
    collisionRows,
    { orderSemantics: new Map([["name", resolveFieldSemantics({ fieldType: "NUMBER" })]]) }
  );
  expect(collision.rows.map((row) => row.id)).toEqual(["2", "1"]);

  const duplicate = run(
    "SELECT $id AS id, amount AS x, name AS x FROM APP100 ORDER BY x ASC",
    collisionRows
  );
  expect(duplicate.rows.map((row) => row.id)).toEqual(["1", "2"]);
  expect(duplicate.rows.map((row) => row.x)).toEqual(["a", "z"]);
});

test("ドットを含む alias は完全一致で入力行キーより優先する", () => {
  const rows = [
    record({ $id: "1", amount: "20", "a.value": "a" }),
    record({ $id: "2", amount: "3", "a.value": "z" }),
  ];
  const result = run(
    "SELECT $id AS id, amount AS `a.value` FROM APP100 ORDER BY `a.value` ASC",
    rows,
    { orderSemantics: new Map([["a.value", resolveFieldSemantics({ fieldType: "NUMBER" })]]) }
  );
  expect(result.rows.map((row) => row.id)).toEqual(["2", "1"]);
});

test("OVER 内 ORDER BY は同一 SELECT alias を解決しない", () => {
  const result = run(
    "SELECT amount AS x, ROW_NUMBER() OVER (ORDER BY x ASC) AS rn FROM APP100",
    baseRows,
    { orderSemantics: numericAlias }
  );
  expect(result.rows).toEqual([
    { x: "10", rn: "1" },
    { x: "9", rn: "2" },
  ]);
});

test("alias sort の後に OFFSET / LIMIT を適用する", () => {
  const rows = [
    record({ $id: "1", amount: "30" }),
    record({ $id: "2", amount: "10" }),
    record({ $id: "3", amount: "20" }),
  ];
  const result = run(
    "SELECT $id AS id, amount AS sort_key FROM APP100 ORDER BY sort_key ASC LIMIT 1 OFFSET 1",
    rows,
    { orderSemantics: numericAlias }
  );
  expect(result.rows).toEqual([{ id: "3", sort_key: "20" }]);
});

test("既存の集計 alias・合成名・関数直書き ORDER BY を変えない", () => {
  const rows = [record({ kind: "B", amount: "1" }), record({ kind: "A", amount: "2" })];
  expect(run(
    "SELECT kind, SUM(amount) AS total FROM APP100 GROUP BY kind ORDER BY total DESC",
    rows
  ).rows.map((row) => row.kind)).toEqual(["A", "B"]);
  expect(run(
    "SELECT kind, SUM(amount) FROM APP100 GROUP BY kind ORDER BY `SUM(amount)` DESC",
    rows
  ).rows.map((row) => row.kind)).toEqual(["A", "B"]);
  expect(run(
    "SELECT name FROM APP100 ORDER BY LENGTH(name) ASC",
    baseRows
  ).rows.map((row) => row.name)).toEqual(["a", "bbb"]);
});

function clientFor(recordsByApp: Record<number, KintoneRecord[]>, fieldTypes: Record<string, string> = {}): KintoneClient {
  return {
    async getRecords(params) {
      const all = recordsByApp[params.app] ?? [];
      const offset = Number(params.query.match(/\boffset\s+(\d+)/i)?.[1] ?? "0");
      const limit = Number(params.query.match(/\blimit\s+(\d+)/i)?.[1] ?? "500");
      return { records: all.slice(offset, offset + limit) };
    },
    async openCursor() { throw new Error("unexpected cursor call"); },
    async postRecords() { return { ids: [] }; },
    async putRecords() {},
    async deleteRecords() {},
    async getApps() { return []; },
    async getFields(appId) {
      const codes = new Set((recordsByApp[appId] ?? []).flatMap((row) => Object.keys(row)));
      Object.keys(fieldTypes).forEach((code) => codes.add(code));
      return [...codes].filter((code) => !code.startsWith("$")).map((code) => ({
        code,
        label: code,
        fieldType: fieldTypes[code] ?? "SINGLE_LINE_TEXT",
      }));
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() { return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const }; },
  };
}

test("execute SIMPLE local sort も SELECT alias evaluator を供給する", async () => {
  const result = await execute(
    "SELECT $id AS id, amount AS m FROM APP100 ORDER BY m ASC",
    clientFor({ 100: baseRows }, { amount: "NUMBER" }),
    { cacheContext: "b59-simple" }
  ) as SelectResult;
  expect(result.rows.map((row) => row.id)).toEqual(["2", "1"]);
});

test("サブテーブル仮想テーブルでも SELECT alias を ORDER BY 値として評価する", async () => {
  const parent = {
    $id: { value: "1" },
    details: {
      value: [
        { id: "r1", value: { amount: { value: "20" } } },
        { id: "r2", value: { amount: { value: "3" } } },
      ],
    },
  } as unknown as KintoneRecord;
  const result = await execute(
    "SELECT _rid, amount AS m FROM APP100$details ORDER BY m ASC",
    clientFor({ 100: [parent] }, { amount: "NUMBER" }),
    { cacheContext: "b59-subtable" }
  ) as SelectResult;
  expect(result.rows).toEqual([
    { _rid: "r2", m: "3" },
    { _rid: "r1", m: "20" },
  ]);
});

test.each(["UNION", "UNION ALL"])("%s の各 SELECT 分岐で alias ORDER BY を評価する", async (operator) => {
  const result = await execute(
    `SELECT $id AS id, amount AS m FROM APP100 ORDER BY m ASC ${operator} ` +
      "SELECT $id AS id, amount AS m FROM APP200 ORDER BY m ASC",
    clientFor({
      100: [record({ $id: "1", amount: "20" }), record({ $id: "2", amount: "3" })],
      200: [record({ $id: "3", amount: "40" }), record({ $id: "4", amount: "1" })],
    }, { amount: "NUMBER" }),
    { cacheContext: `b59-${operator}` }
  ) as SelectResult;
  expect(result.rows.map((row) => row.id)).toEqual(["2", "1", "4", "3"]);
});

test("存在しない ORDER BY key は ORDER_KEY_UNRESOLVED のまま fail-closed", async () => {
  await expect(execute(
    "SELECT $id FROM APP100 ORDER BY missing",
    clientFor({ 100: baseRows }),
    { cacheContext: "b59-unresolved" }
  )).rejects.toThrow(/ORDER_KEY_UNRESOLVED/);
});
