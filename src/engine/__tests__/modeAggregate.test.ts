import { completeInputReasons, requiresCompleteInput } from "../../core/dmlGuard";
import { resolveFieldSemantics, syntheticSemantics } from "../../core/fieldSemantics";
import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";
import type { SelectStatement, Statement } from "../../types/ast";
import { applyGroupBy, type AggregateSortKindResolver, type ProcessRow } from "../process";

function parse(sql: string): Statement {
  return new Parser(new Lexer(sql).tokenize()).parse();
}

function parseSelect(sql: string): SelectStatement {
  return parse(sql) as SelectStatement;
}

function mode(rows: ProcessRow[], resolver?: AggregateSortKindResolver, arg = "x"): string {
  const stmt = parseSelect(`SELECT MODE(${arg}) AS result FROM APP100`);
  return applyGroupBy(rows, stmt.groupBy, stmt.columns, resolver)[0].result;
}

test("B58: MODE を SELECT 列として構文解析する", () => {
  expect(parseSelect("SELECT MODE(x) AS m FROM APP100").columns[0]).toMatchObject({
    type: "AGGREGATE",
    func: "MODE",
    distinct: false,
    alias: "m",
  });
});

test("B58: 一意最頻値・空集合・全空セル・singleton を処理する", () => {
  expect(mode([{ x: "A" }, { x: "B" }, { x: "A" }])).toBe("A");
  expect(mode([])).toBe("");
  expect(mode([{ x: "" }, { x: "" }])).toBe("");
  expect(mode([{ x: "only" }])).toBe("only");
});

test("B58: テキストのタイはコードポイント最小で入力順に依存しない", () => {
  const rows = [{ x: "B" }, { x: "A" }, { x: "B" }, { x: "A" }];
  expect(mode(rows)).toBe("A");
  expect(mode([...rows].reverse())).toBe("A");
  expect(mode([{ x: "C" }, { x: "A" }, { x: "B" }])).toBe("A");
});

test("B58: 数値 canonical 同値のタイは raw コードポイント順で決定する", () => {
  const resolver: AggregateSortKindResolver = () => syntheticSemantics("number");
  const rows = [{ x: "1" }, { x: "01" }, { x: "1" }, { x: "01" }];
  expect(mode(rows, resolver)).toBe("01");
  expect(mode([...rows].reverse(), resolver)).toBe("01");
});

test("B58: 数値型と STATUS optionOrder のタイは source semantics の最小値", () => {
  expect(mode([{ x: "10" }, { x: "2" }], () => syntheticSemantics("number"))).toBe("2");
  const statusSemantics = resolveFieldSemantics({
    fieldType: "STATUS",
    optionOrder: { 進行中: 0, 未着手: 1, 完了: 2 },
  });
  expect(mode([{ x: "完了" }, { x: "進行中" }], () => statusSemantics)).toBe("進行中");
});

test("B58: 算術式引数は number semantics でタイを決定する", () => {
  expect(mode([{ x: "10" }, { x: "2" }], undefined, "x + 0")).toBe("2");
});

test("B58: MODE(*) と MODE(DISTINCT x) は SELECT/HAVING の両経路で拒否する", () => {
  expect(() => parseSelect("SELECT MODE(*) FROM APP100")).toThrow(/MODE\(\*\) は使用できません/);
  expect(() => parseSelect(
    "SELECT kind, MODE(x) FROM APP100 GROUP BY kind HAVING MODE(*) = 'A'"
  )).toThrow(/MODE\(\*\) は使用できません/);
  expect(() => parseSelect("SELECT MODE(DISTINCT x) FROM APP100")).toThrow(/MODE.*DISTINCT.*使用できません/);
  expect(() => parseSelect(
    "SELECT kind, MODE(x) FROM APP100 GROUP BY kind HAVING MODE(DISTINCT x) = 'A'"
  )).toThrow(/MODE.*DISTINCT.*使用できません/);
});

test("B58: OVER・2 引数は ParseError、予約語はバッククォート参照可能、MODEL は非影響", () => {
  expect(() => parseSelect("SELECT MODE(x) OVER (ORDER BY x) FROM APP100")).toThrow();
  expect(() => parseSelect("SELECT MODE(x, y) FROM APP100")).toThrow();
  expect(() => parseSelect("SELECT MODE FROM APP100")).toThrow();
  expect(parseSelect("SELECT `MODE`, MODEL FROM APP100").columns).toMatchObject([
    { type: "FIELD", field: "MODE" },
    { type: "FIELD", field: "MODEL" },
  ]);
});

test("B58: MODE は入れ子の式・CTE・HAVING でも完全入力必須", () => {
  const statements = [
    parse("SELECT MODE(x) FROM APP100"),
    parse("SELECT MODE(x) + 1 AS adjusted FROM APP100"),
    parse("WITH stats AS (SELECT MODE(x) AS m FROM APP100) SELECT m FROM stats"),
  ];
  for (const stmt of statements) expect(requiresCompleteInput(stmt)).toBe(true);

  const having = parse(
    "SELECT kind, MODE(x) AS m FROM APP100 GROUP BY kind HAVING MODE(x) = 'A'"
  );
  expect([...completeInputReasons(having)]).toContain("STATISTICAL_AGGREGATE");
});
