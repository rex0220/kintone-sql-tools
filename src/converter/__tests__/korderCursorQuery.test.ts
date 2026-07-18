import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";
import type { SelectStatement } from "../../types/ast";
import { buildKorderCursorQuery } from "../korderCursorQuery";

function parse(sql: string): SelectStatement {
  return new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement;
}

test("WHEREと利用者指定キーだけを保持しLIMIT/OFFSETや暗黙$idを含めない", () => {
  const query = buildKorderCursorQuery(parse(
    "SELECT 名前 FROM APP100 WHERE 金額 >= 10 KORDER BY 金額 DESC, 名前 ASC LIMIT 501 OFFSET 7"
  ));
  expect(query).toBe("金額 >= 10 order by 金額 desc, 名前 asc");
  expect(query).not.toMatch(/limit|offset|\$id/i);
});
