import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";
import type { ScalarValueExpr, SelectStatement, UpdateStatement } from "../../types/ast";
import { evalScalarValueExpr, evalStringFunc } from "../evalFunc";
import { project, runFullScan } from "../process";
import { updateToGetQueryForArith, updateToPutBatchesArith } from "../../converter/dmlToKintone";
import { selectToKintoneParams } from "../../converter/selectToKintone";

function scalar(sql: string): ScalarValueExpr {
  return new Parser(new Lexer(sql).tokenize()).parseScalarValueExpr();
}

function parse(sql: string) {
  return new Parser(new Lexer(sql).tokenize()).parse();
}

test("|| は CONCAT と同じ文字列化・空値規則で評価する", () => {
  expect(evalScalarValueExpr(scalar("'a'||'b'"), {})).toBe("ab");
  expect(evalScalarValueExpr(scalar("1||2"), {})).toBe("12");
  expect(evalScalarValueExpr(scalar("9007199254740993||''"), {})).toBe("9007199254740993");
  expect(evalScalarValueExpr(scalar("'x'||empty"), {})).toBe("x");
  const row = { a: "A", b: "", c: "C" };
  const op = evalScalarValueExpr(scalar("a||b||c"), row);
  const fn = evalStringFunc({ type: "STRING_FUNC", func: "CONCAT", args: [
    { type: "FIELD", tableAlias: null, field: "a" },
    { type: "FIELD", tableAlias: null, field: "b" },
    { type: "FIELD", tableAlias: null, field: "c" },
  ] }, row);
  expect(op).toBe(fn);
});

test("関数引数の変数解決後 AST と入れ子 scalar-value を評価する", () => {
  const expr = scalar("CONCAT(UPPER(@v), x)||'!'");
  const resolved = JSON.parse(JSON.stringify(expr).replace(
    JSON.stringify({ type: "VARIABLE", name: "v" }),
    JSON.stringify({ type: "STRING", value: "ab" })
  )) as ScalarValueExpr;
  expect(evalScalarValueExpr(resolved, { x: "X" })).toBe("ABX!");
  expect(() => evalScalarValueExpr(expr, { x: "X" })).toThrow("unresolved variable @v");
});

test("SELECT 射影と alias なし出力名で || を評価する", () => {
  const stmt = parse("SELECT a||'-'||b, CONCAT('x=', a) FROM APP100") as SelectStatement;
  expect(project([{ a: "A", b: "B" }], stmt.columns)).toEqual({
    rows: [{ "a||'-'||b": "A-B", "CONCAT('x=',a)": "x=A" }],
    columns: ["a||'-'||b", "CONCAT('x=',a)"],
  });
});

test("SELECT 列収集は VARIABLE を無視し CONCAT_OP 内の FIELD を収集する", () => {
  const stmt = parse("SELECT CONCAT('x=', @v)||APP100.name FROM APP100") as SelectStatement;
  expect(selectToKintoneParams(stmt).fields).toEqual(["name"]);
});

test("UPDATE SET の || は参照列を収集し行ごとに評価する", () => {
  const stmt = parse("UPDATE APP100 SET label = prefix||'-'||suffix WHERE $id = 1") as UpdateStatement;
  expect(updateToGetQueryForArith(stmt).fields).toEqual(["$id", "prefix", "suffix"]);
  const records = [{
    $id: { value: "1" }, prefix: { value: "A" }, suffix: { value: "B" },
  }];
  expect(updateToPutBatchesArith(stmt, records)[0].records[0].record.label.value).toBe("A-B");
});

test("|| 内の集約入り関数を保持して解決する", () => {
  const stmt = parse("SELECT FORMAT(SUM(amount), '#,##0')||' yen' AS total FROM APP100") as SelectStatement;
  const result = runFullScan({
    tables: new Map([[null, [
      { amount: { value: "100" } },
      { amount: { value: "200" } },
    ]]]),
    stmt,
  });
  expect(result.rows).toEqual([{ total: "300 yen" }]);
});
