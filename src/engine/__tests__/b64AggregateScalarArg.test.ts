import type { KintoneRecord } from "../../converter/dmlToKintone";
import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";
import type { SelectStatement } from "../../types/ast";
import { runFullScan } from "../process";
import { completeInputReasons } from "../../core/dmlGuard";
import { resolveBatchVariableReferences } from "../../execute";

function parseSelect(sql: string): SelectStatement {
  return new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement;
}

function records(rows: Array<Record<string, string>>): KintoneRecord[] {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, { value }])));
}

function run(sql: string, rows: Array<Record<string, string>>, sort: "number" | "string" = "string") {
  return runFullScan({
    stmt: parseSelect(sql),
    tables: new Map([[null, records(rows)]]),
    aggregateSortKindResolver: () => sort,
  });
}

const base = [
  { status: "done", amount: "2", label: "B" },
  { status: "other", amount: "10", label: "Z" },
  { status: "done", amount: "4", label: "A" },
  { status: "other", amount: "", label: "" },
];

test("B64-E01: COUNT nullable / COUNT ELSE / SUM は 2/4/2", () => {
  const result = run(`SELECT
    COUNT(CASE WHEN status = 'done' THEN 1 END) AS c_null,
    COUNT(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS c_else,
    SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS s
    FROM APP1`, base);
  expect(result.rows[0]).toMatchObject({ c_null: "2", c_else: "4", s: "2" });
});

test("B64-E02/E03: 条件付き SUM と AVG は一致した非NULL値だけを使う", () => {
  const result = run(`SELECT
    SUM(CASE WHEN status = 'done' THEN amount ELSE 0 END) AS s,
    AVG(CASE WHEN status = 'done' THEN amount END) AS a
    FROM APP1`, base);
  expect(result.rows[0]).toMatchObject({ s: "6", a: "3" });
});

test("B64-E04/E05/E06: MIN/MAX は非一致NULL・選択空セル・明示空文字を区別する", () => {
  expect(run("SELECT MIN(CASE WHEN status = 'done' THEN label END) AS lo, MAX(CASE WHEN status = 'done' THEN label END) AS hi FROM APP1", base).rows[0])
    .toMatchObject({ lo: "A", hi: "B" });
  const selectedEmpty = [{ p: "yes", v: "" }, { p: "yes", v: "B" }, { p: "no", v: "A" }];
  expect(run("SELECT MIN(CASE WHEN p = 'yes' THEN v END) AS lo, MAX(CASE WHEN p = 'yes' THEN v END) AS hi FROM APP1", selectedEmpty).rows[0])
    .toMatchObject({ lo: "", hi: "B" });
  expect(run("SELECT MIN(CASE WHEN p = 'yes' THEN v ELSE '' END) AS lo FROM APP1", [{ p: "yes", v: "B" }, { p: "no", v: "A" }]).rows[0].lo).toBe("");
});

test("B64-E07: GROUP_CONCAT CASE は NULL/空値を飛ばし DISTINCT 初出順と separator を保つ", () => {
  const rows = [{ p: "1", v: "B" }, { p: "0", v: "X" }, { p: "1", v: "" }, { p: "1", v: "B" }, { p: "1", v: "A" }];
  expect(run("SELECT GROUP_CONCAT(DISTINCT CASE WHEN p = 1 THEN v END SEPARATOR '/') AS g FROM APP1", rows).rows[0].g).toBe("B/A");
});

test("B64-E08: CASE 集計の外側算術と関数内集計を評価する", () => {
  const result = run("SELECT SUM(CASE WHEN status = 'done' THEN amount ELSE 0 END)*2 AS twice, FORMAT(SUM(CASE WHEN status = 'done' THEN amount ELSE 0 END), '#') AS formatted FROM APP1", base);
  expect(result.rows[0]).toMatchObject({ twice: "12", formatted: "6" });
});

test("B64-E09: 空入力と全CASE false は関数別の既存空集合規約を保つ", () => {
  expect(run("SELECT COUNT(CASE WHEN p = 1 THEN 1 END) AS c, SUM(CASE WHEN p = 1 THEN n END) AS s, MODE(CASE WHEN p = 1 THEN n END) AS m FROM APP1", []).rows[0])
    .toMatchObject({ c: "0", s: "0", m: "" });
});

test("B64-E10: 解決済み裸変数相当の定数は行数分集計される", () => {
  const parsed = parseSelect("SELECT SUM(@rate) AS s, COUNT(@rate) AS c FROM APP1");
  const resolved = resolveBatchVariableReferences(parsed, new Map([["rate", { type: "number" as const, value: 3, raw: "3" }]]));
  const result = runFullScan({ stmt: resolved, tables: new Map([[null, records(base)]]) });
  expect(result.rows[0]).toMatchObject({ s: "12", c: "4" });
});

test("B64-S01/S03: 5統計関数とMODEの CASE 入力・全false未定義値", () => {
  const result = run(`SELECT
    STDDEV_POP(CASE WHEN p = 1 THEN n END) AS sp,
    STDDEV_SAMP(CASE WHEN p = 1 THEN n END) AS ss,
    VAR_POP(CASE WHEN p = 1 THEN n END) AS vp,
    VAR_SAMP(CASE WHEN p = 1 THEN n END) AS vs,
    MEDIAN(CASE WHEN p = 1 THEN n END) AS med,
    MODE(CASE WHEN p = 1 THEN n END) AS mode
    FROM APP1`, [{ p: "1", n: "2" }, { p: "1", n: "4" }, { p: "0", n: "100" }], "number");
  expect(result.rows[0]).toMatchObject({ sp: "1", ss: String(Math.sqrt(2)), vp: "1", vs: "2", med: "3", mode: "2" });
  const empty = run("SELECT STDDEV_POP(CASE WHEN p = 1 THEN n END) AS sp, VAR_SAMP(CASE WHEN p = 1 THEN n END) AS vs, MEDIAN(CASE WHEN p = 1 THEN n END) AS med, MODE(CASE WHEN p = 1 THEN n END) AS mode FROM APP1", [{ p: "0", n: "2" }]);
  expect(empty.rows[0]).toMatchObject({ sp: "", vs: "", med: "", mode: "" });
});

test("B64-S02: 選択された非数値だけを統計集約が拒否する", () => {
  expect(() => run("SELECT VAR_POP(CASE WHEN p = 1 THEN n END) AS v FROM APP1", [{ p: "1", n: "bad" }]))
    .toThrow(/VAR_POP.*bad/);
  expect(run("SELECT VAR_POP(CASE WHEN p = 1 THEN n END) AS v FROM APP1", [{ p: "0", n: "bad" }]).rows[0].v).toBe("");
});

test("B64-S04: 新 AST 内の統計集約でも完全入力理由を検出する", () => {
  for (const sql of [
    "SELECT STDDEV_POP(CASE WHEN p = 1 THEN n END) FROM APP1",
    "SELECT STDDEV_POP(CASE WHEN p = 1 THEN n END)*2 FROM APP1",
    "SELECT FORMAT(STDDEV_POP(CASE WHEN p = 1 THEN n END), '#') FROM APP1",
    "SELECT p, COUNT(*) FROM APP1 GROUP BY p HAVING STDDEV_POP(CASE WHEN p = 1 THEN n END) > 0",
  ]) expect([...completeInputReasons(parseSelect(sql))]).toContain("STATISTICAL_AGGREGATE");
});

test("B64-M01/M02/M03: CASE の number/string/mixed sortKind を式全体から決める", () => {
  const rows = [{ p: "1", n: "10", s: "10" }, { p: "1", n: "2", s: "2" }];
  expect(run("SELECT MIN(CASE WHEN p = 1 THEN n END) AS v FROM APP1", rows, "number").rows[0].v).toBe("2");
  expect(run("SELECT MIN(CASE WHEN p = 1 THEN s ELSE 'x' END) AS v FROM APP1", rows, "string").rows[0].v).toBe("10");
  expect(run("SELECT MIN(CASE WHEN p = 1 THEN n ELSE 'x' END) AS v FROM APP1", rows, "number").rows[0].v).toBe("10");
});

test("B64-P13/X05: SELECT 合成キーを HAVING が byte 一致で参照する", () => {
  const result = run("SELECT p, SUM(CASE WHEN p=1 THEN 1 END) FROM APP1 GROUP BY p HAVING sum( CASE WHEN p = 1 THEN 1 END ) > 1", [{ p: "1" }, { p: "1" }]);
  expect(result.columns).toEqual(["p", "SUM(CASE WHEN p = 1 THEN 1 END)"]);
  expect(result.rows).toHaveLength(1);
});
