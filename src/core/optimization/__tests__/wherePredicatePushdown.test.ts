import { Lexer } from "../../../lexer/lexer";
import { Parser } from "../../../parser/parser";
import type { SelectStatement } from "../../../types/ast";
import { extractSafePushdownLeaves } from "../wherePredicatePushdown";

function where(sql: string) {
  return (new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement).where!;
}

test.each(["=", ">", "<", ">=", "<="])(
  "$id %s NUMBER を安全なリーフとして抽出する",
  (op) => {
    const expr = where(`SELECT * FROM APP100 WHERE $id ${op} 1000`);
    expect(extractSafePushdownLeaves(expr)).toEqual(expr);
  }
);

test("AND を分解し GROUP 内の安全な $id リーフだけを抽出する", () => {
  const expr = where(
    "SELECT * FROM APP100 WHERE ($id >= 1000 AND 会社名 LIKE '%A%') AND 状態 = '完了'"
  );
  const extracted = extractSafePushdownLeaves(expr) as any;
  expect(extracted.type).toBe("BINARY");
  expect(extracted.left.field).toBe("$id");
  expect(extracted.op).toBe(">=");
});

test("JOIN は対象エイリアスの明示的な $id だけを抽出する", () => {
  const target = where("SELECT * FROM APP100 AS a WHERE a.$id >= 1000");
  const other = where("SELECT * FROM APP100 AS a WHERE b.$id >= 1000");
  const unqualified = where("SELECT * FROM APP100 AS a WHERE $id >= 1000");

  expect(extractSafePushdownLeaves(target, { tableAlias: "a" })).toEqual(target);
  expect(extractSafePushdownLeaves(other, { tableAlias: "a" })).toBeNull();
  expect(extractSafePushdownLeaves(unqualified, { tableAlias: "a" })).toBeNull();
});

test("単一テーブルは修飾なしまたは正しい別名の $id を許可する", () => {
  const unqualified = where("SELECT * FROM APP100 AS a WHERE $id >= 1000");
  const qualified = where("SELECT * FROM APP100 AS a WHERE a.$id >= 1000");
  const wrong = where("SELECT * FROM APP100 AS a WHERE b.$id >= 1000");
  const options = { tableAlias: "a", allowUnqualifiedFields: true };

  expect(extractSafePushdownLeaves(unqualified, options)).toEqual(unqualified);
  expect(extractSafePushdownLeaves(qualified, options)).toEqual(qualified);
  expect(extractSafePushdownLeaves(wrong, options)).toBeNull();
});

test.each([
  "SELECT * FROM APP100 WHERE $id != 1000",
  "SELECT * FROM APP100 WHERE $id <> 1000",
  "SELECT * FROM APP100 WHERE $id IN (1000, 1001)",
  "SELECT * FROM APP100 WHERE $id NOT IN (1000, 1001)",
  "SELECT * FROM APP100 WHERE $id = '1000'",
  "SELECT * FROM APP100 WHERE $id >= TODAY()",
  "SELECT * FROM APP100 WHERE 会社名 = 'A社'",
  "SELECT * FROM APP100 WHERE LENGTH($id) >= 1",
  "SELECT * FROM APP100 WHERE $id + 1 >= 1000",
  "SELECT * FROM APP100 WHERE CASE WHEN $id >= 1 THEN $id ELSE 0 END >= 1000",
  "SELECT * FROM APP100 WHERE $id IS NULL",
  "SELECT * FROM APP100 WHERE $id LIKE '10%'",
  "SELECT * FROM APP100 WHERE $id NOT LIKE '10%'",
  "SELECT * FROM APP100 WHERE NOT ($id >= 1000)",
  "SELECT * FROM APP100 WHERE ($id >= 1000 OR 会社名 = 'A社')",
  "SELECT * FROM APP100 WHERE EXISTS (SELECT * FROM APP101)",
])("危険または第0段対象外の述語を押し下げない: %s", (sql) => {
  expect(extractSafePushdownLeaves(where(sql))).toBeNull();
});

test("fieldTypes が渡されても第0段では一般フィールドを押し下げない", () => {
  const expr = where("SELECT * FROM APP100 WHERE 状態 IN ('完了')");
  const fieldTypes = new Map([["状態", "DROP_DOWN"]]);
  expect(extractSafePushdownLeaves(expr, { fieldTypes })).toBeNull();
});
