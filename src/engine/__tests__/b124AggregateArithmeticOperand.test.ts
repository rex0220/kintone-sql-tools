import type { KintoneRecord } from "../../converter/dmlToKintone";
import { resolveBatchVariableReferences } from "../../execute";
import { syntheticSemantics } from "../../core/fieldSemantics";
import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";
import type { SelectStatement } from "../../types/ast";
import { runFullScan } from "../process";

function parseSelect(sql: string): SelectStatement {
  return new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement;
}

function records(rows: Array<Record<string, string>>): KintoneRecord[] {
  return rows.map((row) => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, { value }])
  ));
}

function run(sql: string, rows: Array<Record<string, string>>) {
  return runFullScan({
    stmt: parseSelect(sql),
    tables: new Map([[null, records(rows)]]),
    havingFieldSemanticsResolver: (field) => field.field === "total" ? syntheticSemantics("number") : undefined,
  });
}

const base = [
  { kind: "A", amount: "4", price: "10" },
  { kind: "A", amount: "7", price: "10" },
  { kind: "B", amount: "3", price: "100" },
];

test("B124-E01: GROUP BY キーを SELECT と HAVING 直接・別名で同じ値に評価する", () => {
  const select = run(
    "SELECT kind, SUM(amount) * price AS total FROM APP1 GROUP BY kind, price ORDER BY kind",
    base
  );
  expect(select.rows).toEqual([{ kind: "A", total: "110" }, { kind: "B", total: "300" }]);

  const direct = run(
    "SELECT kind, SUM(amount) * price AS total FROM APP1 GROUP BY kind, price " +
    "HAVING SUM(amount) * price > 99 AND SUM(amount) * price < 250 ORDER BY kind",
    base
  );
  const alias = run(
    "SELECT kind, SUM(amount) * price AS total FROM APP1 GROUP BY kind, price " +
    "HAVING total > 99 AND total < 250 ORDER BY kind",
    base
  );
  expect(direct.rows.map((row) => row.kind)).toEqual(["A"]);
  expect(alias.rows.map((row) => row.kind)).toEqual(["A"]);
});

test("B124-E02: 修飾 GROUP BY キーを resolveFieldRef 経由で SELECT と HAVING に使う", () => {
  const sql = "SELECT m.kind, SUM(m.amount) * m.price AS total FROM APP1 m " +
    "GROUP BY m.kind, m.price HAVING SUM(m.amount) * m.price > 100 ORDER BY m.kind";
  const result = runFullScan({
    stmt: parseSelect(sql),
    tables: new Map([["m", records(base)]]),
  });
  expect(result.rows).toEqual([{ kind: "A", total: "110" }, { kind: "B", total: "300" }]);
});

test("B124-E03: 非数値キーの外側 NaN と内側 SUM の 0 を独立に固定する", () => {
  const result = run(
    "SELECT kind, SUM(amount) * kind AS outer_value, SUM(amount * kind) AS inner_value " +
    "FROM APP1 GROUP BY kind ORDER BY kind",
    base
  );
  expect(result.rows).toEqual([
    { kind: "A", outer_value: "NaN", inner_value: "0" },
    { kind: "B", outer_value: "NaN", inner_value: "0" },
  ]);
});

test("B124-E04: 小数は外側と内側を独立に相対誤差で確認する", () => {
  const rows = Array.from({ length: 10 }, () => ({ kind: "A", amount: "0.1", price: "0.1" }));
  const row = run(
    "SELECT kind, SUM(amount) * price AS outer_value, SUM(amount * price) AS inner_value " +
    "FROM APP1 GROUP BY kind, price",
    rows
  ).rows[0];
  expect(Number(row.outer_value)).toBeCloseTo(0.09999999999999999, 15);
  expect(Number(row.inner_value)).toBeCloseTo(0.10000000000000003, 15);
});

test("B124-E05: 数値変数は既存 resolver で NUMBER へ置換し、非数値は ArgumentError", () => {
  const parsed = parseSelect("SELECT kind, SUM(amount) * @rate AS total FROM APP1 GROUP BY kind ORDER BY kind");
  const resolved = resolveBatchVariableReferences(parsed, new Map([
    ["rate", { type: "number" as const, value: 2, raw: "2" }],
  ]));
  expect(runFullScan({ stmt: resolved, tables: new Map([[null, records(base)]]) }).rows)
    .toEqual([{ kind: "A", total: "22" }, { kind: "B", total: "6" }]);

  const withoutAlias = resolveBatchVariableReferences(
    parseSelect("SELECT kind, SUM(amount) * @rate FROM APP1 GROUP BY kind"),
    new Map([["rate", { type: "number" as const, value: 2, raw: "2" }]])
  );
  expect(runFullScan({ stmt: withoutAlias, tables: new Map([[null, records(base)]]) }).columns)
    .toEqual(["kind", "SUM(amount)*@rate"]);

  expect(() => resolveBatchVariableReferences(parsed, new Map([
    ["rate", { type: "string" as const, value: "bad" }],
  ]))).toThrow("ArgumentError: variable @rate is not numeric");
});

test("B124-E06: 変数式も SELECT・HAVING 直接・別名の行集合を一致させる", () => {
  const variables = new Map([["rate", { type: "number" as const, value: 2, raw: "2" }]]);
  const executeResolved = (sql: string) => runFullScan({
    stmt: resolveBatchVariableReferences(parseSelect(sql), variables),
    tables: new Map([[null, records(base)]]),
    havingFieldSemanticsResolver: (field) => field.field === "total" ? syntheticSemantics("number") : undefined,
  });
  const direct = executeResolved(
    "SELECT kind, SUM(amount) * @rate AS total FROM APP1 GROUP BY kind " +
    "HAVING SUM(amount) * @rate > 9 AND SUM(amount) * @rate < 30 ORDER BY kind"
  );
  const alias = executeResolved(
    "SELECT kind, SUM(amount) * @rate AS total FROM APP1 GROUP BY kind " +
    "HAVING total > 9 AND total < 30 ORDER BY kind"
  );
  expect(direct.rows.map((row) => row.kind)).toEqual(["A"]);
  expect(alias.rows.map((row) => row.kind)).toEqual(["A"]);
});

test("B124-E07: 実需の 8 製品を既知期待値と合計 482710 で固定する", () => {
  const expected = [
    ["01", "緑茶", 10680], ["02", "牛乳", 147350], ["03", "バター", 29200],
    ["04", "野菜ジュース", 18050], ["05", "食パン", 137800], ["06", "トマト缶", 78840],
    ["07", "ほうじ茶", 27040], ["08", "ライ麦パン", 33750],
  ] as const;
  const masters = expected.map(([code, name]) => ({ 製品番号: code, 製品名: name, 仕入価格: "10" }));
  const transactions = expected.map(([, name, amount]) => ({ 製品名: name, 個数_在庫計算用: String(amount / 10) }));
  const stmt = parseSelect(
    "SELECT m.製品番号, m.製品名, m.仕入価格, " +
    "SUM(t.個数_在庫計算用) * m.仕入価格 AS 在庫金額 " +
    "FROM APP4229 m LEFT JOIN APP4228 t ON m.製品名 = t.製品名 " +
    "GROUP BY m.製品番号, m.製品名, m.仕入価格 ORDER BY m.製品番号"
  );
  const result = runFullScan({
    stmt,
    tables: new Map([["m", records(masters)], ["t", records(transactions)]]),
  });
  expect(result.rows.map((row) => [row.製品名, Number(row.在庫金額)])).toEqual(
    expected.map(([, name, amount]) => [name, amount])
  );
  expect(result.rows.reduce((sum, row) => sum + Number(row.在庫金額), 0)).toBe(482710);
});

test("B124-E08: 空の GROUP BY キーは既存の Number 空文字規則で 0 にする", () => {
  expect(run(
    "SELECT kind, SUM(amount) * price AS total FROM APP1 GROUP BY kind, price",
    [{ kind: "A", amount: "4", price: "" }]
  ).rows).toEqual([{ kind: "A", total: "0" }]);
});

test("B124-E09: CASE 結果と文字列関数引数の集計開始形へ GROUP BY leaf を波及させる", () => {
  expect(run(
    "SELECT kind, CASE WHEN kind = 'A' THEN SUM(amount) * price ELSE 0 END AS total, " +
    "FORMAT(SUM(amount) * price, '#') AS formatted " +
    "FROM APP1 GROUP BY kind, price ORDER BY kind",
    base
  ).rows).toEqual([
    { kind: "A", total: "110", formatted: "110" },
    { kind: "B", total: "0", formatted: "300" },
  ]);
});

test("B124-R01: alias なしの既存合成キー名を変えず、新 leaf は安定表記にする", () => {
  expect(run("SELECT SUM(amount) - SUM(price) FROM APP1", base).columns)
    .toEqual(["SUM(amount)-SUM(price)"]);
  expect(run("SELECT kind, SUM(amount) * price FROM APP1 GROUP BY kind, price", base).columns)
    .toEqual(["kind", "SUM(amount)*price"]);
});
