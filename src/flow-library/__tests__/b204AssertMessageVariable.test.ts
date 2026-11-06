import {
  createExecutionContext,
  disposeExecutionContext,
  executeStatement,
  explainScript,
  parseScript,
  type FlowKintoneClient,
} from "../index";
import type { AssertStatement, ExitStatement } from "../../types/ast";

type Rec = Record<string, { value: unknown }>;

const fields = [
  { code: "残数", label: "残数", fieldType: "NUMBER", writable: true },
];

/** 残数 < 0 の行を count 件返す（ASSERT を不成立にするため）。 */
function mockClient(count: number) {
  const records = (): Rec[] => Array.from({ length: count }, (_, index) => ({
    $id: { value: String(index + 1) }, $revision: { value: "1" }, 残数: { value: "-1" },
  }));
  const value = {
    async getRecords(params: { totalCount?: boolean }) {
      const rows = records();
      return params.totalCount ? { records: rows, totalCount: String(rows.length) } : { records: rows };
    },
    async openCursor() {
      const rows = records();
      return { totalCount: rows.length, async nextPage() { return { records: rows, next: false }; }, async close() {} };
    },
    async postRecords({ records: rows }: { records: unknown[] }) {
      return { ids: rows.map((_, index) => String(900 + index)) };
    },
    async putRecords() { /* noop */ },
    async deleteRecords() { /* noop */ },
    async getApps() { return []; },
    async getFields() { return fields; },
    async getNumberPrecision() { return { digits: 16, decimalPlaces: 4, roundingMode: "HALF_EVEN" as const }; },
    async getProcessStatuses() { return { enable: false, states: null }; },
  } as unknown as FlowKintoneClient;
  return value;
}

const header = "-- @ksql dialect: 1\n";
const assertSql = `${header}DECLARE @m_no_stock = '';\nASSERT (SELECT COUNT(*) FROM APP1 WHERE 残数 < 0) = 0, @m_no_stock;`;

async function runScript(sql: string, count: number, options: Record<string, unknown> = {}) {
  const client = mockClient(count);
  const parsed = parseScript(sql);
  const errors = parsed.diagnostics.filter((item) => item.severity === "error");
  if (errors.length > 0) return { parsed, parseErrors: errors, results: [] };
  const context = createExecutionContext({
    client, statements: parsed.statements, meta: parsed.meta, ...options,
  });
  const results = [];
  for (const statement of parsed.statements) results.push(await executeStatement(statement, context));
  await disposeExecutionContext(context);
  return { parsed, parseErrors: [], results };
}

test("B204 AC1: ASSERT のメッセージに変数を書いても parse を通り、AST に参照が入る", () => {
  const parsed = parseScript(assertSql);
  expect(parsed.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  const statement = parsed.statements[1] as AssertStatement;
  expect(statement.messageVar).toEqual({ type: "VARIABLE", name: "m_no_stock" });
  // 依頼元は未解決の AST を読む（解決は実行時の内部で、渡した statements は書き換わらない）
  expect(statement.message).toBeUndefined();
});

test("B204 AC3: EXIT SUCCESS IF も同じ", () => {
  const parsed = parseScript(
    `${header}DECLARE @m_done = '';\nEXIT SUCCESS IF (SELECT COUNT(*) FROM APP1) = 0, @m_done;`
  );
  expect(parsed.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  const statement = parsed.statements[1] as ExitStatement;
  expect(statement.messageVar).toEqual({ type: "VARIABLE", name: "m_done" });
  expect(statement.message).toBe("");
});

test("B204 AC4: 注入した値が不成立のときのメッセージに出る（kind も ASSERT_VIOLATION）", async () => {
  const { results } = await runScript(assertSql, 3, { variables: { m_no_stock: "在庫が足りません" } });
  expect(results[1]).toMatchObject({
    status: "error",
    kind: "ASSERT_VIOLATION",
    error: { code: "AssertError" },
  });
  expect(results[1].error?.message).toBe(
    "AssertError: assertion failed: (SELECT COUNT(*) FROM APP1 WHERE 残数 < 0) = 0 (actual: 3). 在庫が足りません"
  );
});

test("B204 AC5: 空に解決した変数はメッセージを省いたのと同じ", async () => {
  const { results } = await runScript(assertSql, 3, { variables: { m_no_stock: "" } });
  expect(results[1].error?.message).toBe(
    "AssertError: assertion failed: (SELECT COUNT(*) FROM APP1 WHERE 残数 < 0) = 0 (actual: 3)."
  );
});

test("B204 AC6: 条件が成立すれば従来どおり成功（メッセージは使われない）", async () => {
  const { results } = await runScript(assertSql, 0, { variables: { m_no_stock: "在庫が足りません" } });
  expect(results.map((item) => item.status)).toEqual(["success", "success"]);
  expect(results[1].kind).toBe("ASSERT_PASSED");
});

test("B204 AC7: ASSERT WARN の警告にも注入した文が出る", async () => {
  const { results } = await runScript(
    `${header}DECLARE @m_x = '';\nASSERT WARN (SELECT COUNT(*) FROM APP1 WHERE 残数 < 0) = 0, @m_x;\nSELECT 残数 FROM APP1;`,
    3,
    { variables: { m_x: "在庫注意" } }
  );
  expect(results.map((item) => item.status)).toEqual(["success", "success", "success"]);
  expect(results[1]).toMatchObject({ kind: "ASSERT_WARNING", result: { warning: "在庫注意" } });
});

test("B204: EXIT の結果のメッセージは解決後の文（利用者の言語）", async () => {
  const { results } = await runScript(
    `${header}DECLARE @m_done = '';\nEXIT SUCCESS IF (SELECT COUNT(*) FROM APP1 WHERE 残数 < 0) = 0, @m_done;`,
    0,
    { variables: { m_done: "Nothing to do" } }
  );
  expect(results[1]).toMatchObject({
    kind: "EXIT_NO_DATA",
    result: { type: "EXIT", exited: true, message: "Nothing to do" },
  });
});

test("B204 E-2: 配列を宣言した変数をメッセージに書くと createExecutionContext で止まる", () => {
  const parsed = parseScript(`${header}DECLARE @ids = [];\nASSERT 1 = 1, @ids;`);
  expect(parsed.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  expect(() => createExecutionContext({
    client: mockClient(0), statements: parsed.statements, meta: parsed.meta,
    variables: { ids: ["1"] },
  })).toThrow("ParseError: array variable @ids can only be used as IN @ids.");
});

test("B204 E-3: 未宣言の変数も createExecutionContext で止まる", () => {
  const parsed = parseScript(`${header}ASSERT 1 = 1, @m_nope;`);
  expect(() => createExecutionContext({
    client: mockClient(0), statements: parsed.statements, meta: parsed.meta,
  })).toThrow("ParseError: variable @m_nope is not defined before statement 1.");
});

test("B204: EXPLAIN は変数の名前だけを出す（注入した値を計画に出さない）", async () => {
  const plans = await explainScript(assertSql, {
    client: mockClient(3),
    variables: { m_no_stock: "在庫が足りません" },
  });
  expect(plans.statements[1].plan[0]).toBe(
    "ASSERT (SELECT COUNT(*) FROM APP1 WHERE 残数 < 0) = 0, '@m_no_stock'"
  );
  expect(JSON.stringify(plans)).not.toContain("在庫が足りません");
});

test("B204: EXPLAIN が伏せるのは外部注入した値だけ（as-of の時刻は従来どおり計画に出る）", async () => {
  const asOf = new Date("2030-01-02T03:04:05Z");
  // 既存の動き: as-of 関数は押し下げの実値として計画に出る（B204 で変えていない）。
  const plans = await explainScript(`${header}ASSERT 1 = 2, @NOW();\nSELECT 残数 FROM APP1;`, {
    client: mockClient(0), asOf,
  });
  expect(plans.statements[0].plan[0]).toBe("ASSERT 1 = 2, '2030-01-02T03:04:05.000Z'");
  // 伏せるのは `DECLARE` + `variables` で注入した値（＝設定のメッセージ）。
  const injected = await explainScript(assertSql, {
    client: mockClient(0), asOf, variables: { m_no_stock: "在庫が足りません" },
  });
  expect(JSON.stringify(injected)).not.toContain("在庫が足りません");
});

test("B204 AC6: リテラルの形は退行なし（文も EXPLAIN も従来どおり）", async () => {
  const literalSql = `${header}ASSERT (SELECT COUNT(*) FROM APP1 WHERE 残数 < 0) = 0, '在庫が足りません';`;
  const { results } = await runScript(literalSql, 3);
  expect(results[0].error?.message).toBe(
    "AssertError: assertion failed: (SELECT COUNT(*) FROM APP1 WHERE 残数 < 0) = 0 (actual: 3). 在庫が足りません"
  );
  const plans = await explainScript(literalSql, { client: mockClient(3) });
  expect(plans.statements[0].plan[0]).toBe(
    "ASSERT (SELECT COUNT(*) FROM APP1 WHERE 残数 < 0) = 0, '在庫が足りません'"
  );
});
