import { execute, executeBatch, type KintoneClient, type DmlValidationResult, type SelectResult } from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";
import { Lexer } from "../lexer/lexer";
import { Parser } from "../parser/parser";
import { ParseError } from "../parser/parser";

const record = (values: Record<string, string>): KintoneRecord => Object.fromEntries(
  Object.entries(values).map(([field, value]) => [field, { value }])
);

function client(recordsByApp: Record<number, KintoneRecord[]> = {}, types: Record<string, string> = {}): KintoneClient & {
  postCalls: KintoneRecord[][]; putCalls: Array<Array<{ id: number; record: KintoneRecord }>>; getFieldsSeen: string[][];
} {
  const postCalls: KintoneRecord[][] = [];
  const putCalls: Array<Array<{ id: number; record: KintoneRecord }>> = [];
  const getFieldsSeen: string[][] = [];
  return {
    postCalls, putCalls, getFieldsSeen,
    async getRecords(params) {
      getFieldsSeen.push([...(params.fields ?? [])]);
      return { records: recordsByApp[params.app] ?? [] };
    },
    async openCursor() { throw new Error("unexpected cursor"); },
    async postRecords(params) { postCalls.push([...params.records]); return { ids: params.records.map((_, i) => String(i + 1)) }; },
    async putRecords(params) { putCalls.push([...params.records]); },
    async deleteRecords() {},
    async getApps() { return []; },
    async getFields(appId) {
      const fields = new Set(Object.keys(types));
      for (const row of recordsByApp[appId] ?? []) Object.keys(row).forEach((field) => { if (!field.startsWith("$")) fields.add(field); });
      return [...fields].map((code) => ({ code, label: code, fieldType: types[code] ?? "SINGLE_LINE_TEXT" }));
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() { return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const }; },
  };
}

test("CHECK parser: soft keyword boundary, groups, and CASE rejection", () => {
  const stmt = new Parser(new Lexer(
    "INSERT INTO APP1 (a) SELECT x FROM APP2 CHECK WHEN x > 0 THEN 'x=' || x CHECK WHEN x > 1 THEN 'high' VALIDATE ONLY"
  ).tokenize()).parse();
  expect(stmt.type).toBe("INSERT_SELECT");
  if (stmt.type !== "INSERT_SELECT") return;
  expect(stmt.select.from.alias).toBe("APP2");
  expect(stmt.checkGroups?.map((group) => group.rules.length)).toEqual([1, 1]);
  expect(() => new Parser(new Lexer("INSERT INTO APP1 (a) VALUES (1) CHECK WHEN a > 0 THEN CASE WHEN a > 1 THEN 'x' END").tokenize()).parse())
    .toThrow("CASE");
});

test("VALUES: group first-match, independent groups, message concat, and ERR_CHECK", async () => {
  const c = client({}, { a: "NUMBER", b: "NUMBER" });
  const result = await execute(
    "INSERT INTO APP1 (a,b) VALUES (3,2) " +
    "CHECK WHEN a > b THEN 'first=' || a WHEN a > 0 THEN 'second' " +
    "CHECK WHEN b > 0 THEN CONCAT('b=', b) VALIDATE ONLY",
    c,
    { cacheContext: "b37-values" }
  ) as DmlValidationResult;
  expect(result.errors.map((row) => [row.$err_code, row.$err_field, row.$err_message])).toEqual([
    ["ERR_CHECK", "", "first=3"], ["ERR_CHECK", "", "b=2"],
  ]);
});

test("INSERT SELECT keeps trailing CHECK-only columns out of payload", async () => {
  const c = client({ 2: [record({ a: "1", b: "2", extra: "9" })] }, { a: "NUMBER", b: "NUMBER", extra: "NUMBER" });
  const result = await execute(
    "INSERT INTO APP1 (a,b) SELECT a,b,extra FROM APP2 CHECK WHEN extra > 10 THEN 'bad'",
    c,
    { cacheContext: "b37-insert-select" }
  );
  expect(result).toMatchObject({ type: "INSERT", insertedCount: 1 });
  expect(c.postCalls[0][0]).toEqual({ a: { value: "1" }, b: { value: "2" } });
  expect(c.postCalls[0][0]).not.toHaveProperty("extra");
});

test("UPDATE uses pre-update evaluation row and unions right/message-only fields", async () => {
  const c = client({ 100: [record({ $id: "1", 金額: "120", 上限額: "100", 備考: "old" })] }, {
    金額: "NUMBER", 上限額: "NUMBER", 備考: "SINGLE_LINE_TEXT",
  });
  const result = await execute(
    "UPDATE APP100 SET 金額 = 80 WHERE $id = 1 " +
    "CHECK WHEN 金額 * 1.1 > 上限額 THEN 'old=' || 金額 || ',note=' || 備考 VALIDATE ONLY",
    c,
    { cacheContext: "b37-update" }
  ) as DmlValidationResult;
  expect(result.errors[0]).toMatchObject({ 金額: "80", $err_code: "ERR_CHECK", $err_message: "old=120,note=old" });
  expect(c.getFieldsSeen.some((fields) => fields.includes("上限額") && fields.includes("備考"))).toBe(true);
});

test("UPDATE FROM resolves target/source qualifiers and rejects unqualified source", async () => {
  const c = client({
    100: [record({ $id: "1", k: "A", 金額: "100" })],
    200: [record({ k: "A", 金額: "80" })],
  }, { k: "SINGLE_LINE_TEXT", 金額: "NUMBER" });
  const result = await execute(
    "UPDATE APP100 SET 金額 = s.金額 FROM APP200 s WHERE APP100.k = s.k " +
    "CHECK WHEN s.金額 < APP100.金額 THEN 'old=' || APP100.金額 || ',new=' || s.金額 VALIDATE ONLY",
    c,
    { cacheContext: "b37-update-from" }
  ) as DmlValidationResult;
  expect(result.errors[0]).toMatchObject({ 金額: "80", $err_message: "old=100,new=80" });
  await expect(execute(
    "UPDATE APP100 SET 金額 = s.金額 FROM APP200 s WHERE APP100.k = s.k CHECK WHEN 金額 < 0 THEN 'bad' VALIDATE ONLY",
    c,
    { cacheContext: "b37-update-from-ambiguous" }
  )).rejects.toThrow("曖昧");
});

test("plain DML CHECK is fail-fast without partial write", async () => {
  const c = client({}, { a: "NUMBER" });
  await expect(execute(
    "INSERT INTO APP1 (a) VALUES (1),(2) CHECK WHEN a = 2 THEN 'blocked'",
    c,
    { cacheContext: "b37-plain" }
  )).rejects.toThrow("ERR_CHECK blocked (row=2");
  expect(c.postCalls).toHaveLength(0);
});

test("batch variable is available inside CHECK message", async () => {
  const c = client({}, { a: "NUMBER" });
  const batch = await executeBatch(
    "SET @v = 'V'; INSERT INTO APP1 (a) VALUES (1) CHECK WHEN a > 0 THEN CONCAT(@v, '=', a) VALIDATE ONLY",
    c,
    { cacheContext: "b37-variable" }
  );
  expect((batch.statements[1].result as DmlValidationResult).errors[0].$err_message).toBe("V=1");
});

test("ON ERROR SKIP counts rejected rows, not multiple group entries", async () => {
  const c = client({}, { a: "NUMBER" });
  const batch = await executeBatch(
    "INSERT INTO APP1 (a) VALUES (1),(2) " +
    "CHECK WHEN a = 2 THEN 'g1' CHECK WHEN a > 1 THEN 'g2' " +
    "ON ERROR SKIP INTO #err REJECT LIMIT 1; SELECT * FROM #err",
    c,
    { cacheContext: "b37-skip" }
  );
  expect(batch.ok).toBe(true);
  expect(batch.statements[0].result).toMatchObject({ insertedCount: 1, skippedRows: 1 });
  expect(c.postCalls[0]).toHaveLength(1);
  expect((batch.statements[1].result as SelectResult).rows.map((row) => row.$err_message)).toEqual(["g1", "g2"]);
});

test("UPSERT evaluates the incoming VALUES row for create and update candidates", async () => {
  const c = client({ 1: [record({ $id: "10", key: "A", amount: "5" })] }, { key: "SINGLE_LINE_TEXT", amount: "NUMBER" });
  const result = await execute(
    "UPSERT INTO APP1 (key,amount) VALUES ('A',3),('B',7) ON DUPLICATE (key) " +
    "CHECK WHEN amount < 5 THEN 'small=' || amount VALIDATE ONLY",
    c,
    { cacheContext: "b37-upsert" }
  ) as DmlValidationResult;
  expect(result.validatedRows).toBe(2);
  expect(result.errors.map((row) => row.$err_message)).toEqual(["small=3"]);
});

test("preparation rejects duplicate SELECT names and unsupported comparison types as ParseError", async () => {
  const c = client({ 2: [record({ a: "x" })] }, { a: "CHECK_BOX" });
  await expect(execute(
    "INSERT INTO APP1 (a) SELECT a,a FROM APP2 CHECK WHEN a IS NULL THEN 'bad' VALIDATE ONLY",
    c,
    { cacheContext: "b37-duplicate-output" }
  )).rejects.toBeInstanceOf(ParseError);
  await expect(execute(
    "INSERT INTO APP1 (a) VALUES (['x']) CHECK WHEN a = 'x' THEN 'bad' VALIDATE ONLY",
    c,
    { cacheContext: "b37-composite" }
  )).rejects.toBeInstanceOf(ParseError);
});

test("UPSERT SELECT accepts trailing CHECK-only output after ON DUPLICATE", async () => {
  const c = client({ 2: [record({ key: "B", amount: "7", cap_value: "10" })] }, {
    key: "SINGLE_LINE_TEXT", amount: "NUMBER", cap_value: "NUMBER",
  });
  const result = await execute(
    "UPSERT INTO APP1 (key,amount) SELECT key,amount,cap_value FROM APP2 ON DUPLICATE (key) " +
    "CHECK WHEN amount > cap_value THEN 'over'",
    c,
    { cacheContext: "b37-upsert-select" }
  );
  expect(result).toMatchObject({ type: "UPSERT", insertedCount: 1, updatedCount: 0 });
  expect(c.postCalls[0][0]).toEqual({ key: { value: "B" }, amount: { value: "7" } });
});

test("UPDATE CASE keeps its fetched pre-update row for CHECK", async () => {
  const c = client({ 100: [record({ $id: "1", amount: "2", cap_value: "3" })] }, { amount: "NUMBER", cap_value: "NUMBER" });
  const result = await execute(
    "UPDATE APP100 SET amount = CASE WHEN amount > 0 THEN 9 ELSE 0 END WHERE $id = 1 " +
    "CHECK WHEN amount < cap_value THEN 'old=' || amount VALIDATE ONLY",
    c,
    { cacheContext: "b37-update-case" }
  ) as DmlValidationResult;
  expect(result.errors[0]).toMatchObject({ amount: "9", $err_message: "old=2" });
});

test("CHECK SELECT still rejects a source with fewer columns than target fields", async () => {
  const c = client({ 2: [record({ a: "1" })] }, { a: "NUMBER", b: "NUMBER" });
  await expect(execute(
    "INSERT INTO APP1 (a,b) SELECT a FROM APP2 CHECK WHEN a > 0 THEN 'bad' VALIDATE ONLY",
    c,
    { cacheContext: "b37-short-select" }
  )).rejects.toThrow("列数（1）");
});

test("evaluator exceptions fail closed after candidate collection and outrank row errors", async () => {
  const c = client({}, { a: "NUMBER" });
  await expect(execute(
    "INSERT INTO APP1 (a) VALUES (1),(2) " +
    "CHECK WHEN a = 1 THEN 'ordinary' " +
    "CHECK WHEN a = 2 THEN TRANSLATE('x', 'a', 'AB') VALIDATE ONLY",
    c,
    { cacheContext: "b37-evaluator-fail-closed" }
  )).rejects.toThrow("TRANSLATE");
  expect(c.postCalls).toHaveLength(0);
});
