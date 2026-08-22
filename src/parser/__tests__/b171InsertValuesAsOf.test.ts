import { parseSqlStatementsForScript } from "../../core/sql";
import { asOfVariableName } from "../../core/asOfClock";
import type { InsertStatement } from "../../types/ast";

const header = "-- @ksql dialect: 1\n";

test("B171: dialect 1 の通常 INSERT VALUES は as-of 4関数を内部変数として受理する", () => {
  const statement = parseSqlStatementsForScript(
    `${header}INSERT INTO APP1 (n,d,m,nm,tags,flag) VALUES (`
      + "@NOW(),@TODAY(),@MONTH_START(),@NEXT_MONTH_START(),['A','B'],CASE WHEN missing='x' THEN 'yes' ELSE 'no' END)"
  ).statements[0] as InsertStatement;
  expect(statement.values[0].slice(0, 4)).toEqual([
    { type: "VARIABLE", name: asOfVariableName("NOW") },
    { type: "VARIABLE", name: asOfVariableName("TODAY") },
    { type: "VARIABLE", name: asOfVariableName("MONTH_START") },
    { type: "VARIABLE", name: asOfVariableName("NEXT_MONTH_START") },
  ]);
  expect(statement.values[0][4]).toMatchObject({ type: "ARRAY" });
  expect(statement.values[0][5]).toMatchObject({ type: "CASE_VALUE" });
});

test.each([
  "INSERT INTO APP1 (v) VALUES (@x)",
  "INSERT INTO APP1 (v) VALUES (TODAY())",
])("B171: 通常変数と bare 関数は dialect 1 INSERT VALUES でも従来どおり拒否: %s", (sql) => {
  expect(() => parseSqlStatementsForScript(`${header}${sql}`))
    .toThrow("INSERT の値には文字列・数値・配列リテラル・CASE WHEN が必要です");
});

test("B171: dialect 0 は as-of INSERT VALUES を従来メッセージで拒否する", () => {
  expect(() => parseSqlStatementsForScript("INSERT INTO APP1 (v) VALUES (@TODAY())"))
    .toThrow("INSERT の値には文字列・数値・配列リテラル・CASE WHEN が必要です");
  try {
    parseSqlStatementsForScript("INSERT INTO APP1 (v) VALUES (@TODAY())");
  } catch (error) {
    expect(String(error)).not.toContain("INSERT ... SELECT");
  }
});

test.each([
  "UPSERT INTO APP1 (key,v) VALUES ('A',@TODAY()) KEY (key)",
  "UPDATE APP1 SET key = 'A' WHERE $id = 1 APPLY table (APPEND (v) VALUES (@TODAY()))",
])("B171: UPSERT VALUES / APPLY APPEND は拒否し文型限定ヒントを返す: %s", (sql) => {
  expect(() => parseSqlStatementsForScript(`${header}${sql}`))
    .toThrow("INSERT ... VALUES では使用できます。この文型では INSERT ... SELECT で注入してください");
});
