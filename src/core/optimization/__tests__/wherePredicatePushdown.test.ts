import { Lexer } from "../../../lexer/lexer";
import { Parser } from "../../../parser/parser";
import type { SelectStatement } from "../../../types/ast";
import { extractTableCondition } from "../wherePredicatePushdown";

function where(sql: string) {
  return (new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement).where!;
}

test("LIKE はワイルドカードの有無にかかわらず JOIN テーブルへ押し下げない", () => {
  const wildcard = where("SELECT * FROM APP100 AS a WHERE a.文字列 LIKE 'すと%'");
  const bare = where("SELECT * FROM APP100 AS a WHERE a.文字列 LIKE 'すと'");
  expect(extractTableCondition(wildcard, "a")).toBeNull();
  expect(extractTableCondition(bare, "a")).toBeNull();
});

test("AND の安全な条件だけを JOIN テーブルへ押し下げる", () => {
  const expr = where("SELECT * FROM APP100 AS a WHERE a.状態 = '完了' AND a.文字列 LIKE 'すと%'");
  const extracted = extractTableCondition(expr, "a") as any;
  expect(extracted.type).toBe("BINARY");
  expect(extracted.left.field).toBe("状態");
});

test("OR / NOT 内の LIKE も押し下げない", () => {
  const orExpr = where("SELECT * FROM APP100 AS a WHERE a.状態 = '完了' OR a.文字列 LIKE 'すと'");
  const notExpr = where("SELECT * FROM APP100 AS a WHERE NOT (a.文字列 LIKE 'すと')");
  expect(extractTableCondition(orExpr, "a")).toBeNull();
  expect(extractTableCondition(notExpr, "a")).toBeNull();
});
