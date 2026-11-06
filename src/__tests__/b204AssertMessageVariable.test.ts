import {
  buildBatchExplainPlans, execute, executeBatch,
  type ExitResult, type KintoneClient,
} from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";
import { renderResult } from "../ui/renderResult";

function client(records: KintoneRecord[] = []): KintoneClient {
  return {
    async getRecords() { return { records }; },
    async openCursor() { throw new Error("unexpected cursor call"); },
    async postRecords(params) { return { ids: params.records.map((_, i) => String(i + 1)) }; },
    async putRecords() { /* noop */ },
    async deleteRecords() { /* noop */ },
    async getApps() { return []; },
    async getFields() { return []; },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() { return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const }; },
  };
}

/**
 * 「API 0 回」を証明するための厳しい代役。
 * どのメソッドも呼ばれた時点で記録し、読み書きは値を返さず失敗させる
 * （成功を返すと「呼ばれていない」と「呼ばれて成功した」が区別できない）。
 */
function strictClient() {
  const calls: string[] = [];
  const fail = (name: string) => async (): Promise<never> => {
    calls.push(name);
    throw new Error(`unexpected ${name} call`);
  };
  const value = {
    getRecords: fail("getRecords"),
    openCursor: fail("openCursor"),
    postRecords: fail("postRecords"),
    putRecords: fail("putRecords"),
    deleteRecords: fail("deleteRecords"),
    getApps: fail("getApps"),
    getFields: fail("getFields"),
    getProcessStatuses: fail("getProcessStatuses"),
    getNumberPrecision: fail("getNumberPrecision"),
  } as unknown as KintoneClient;
  return { value, calls };
}

const header = "-- @ksql dialect: 1\n";
const declare = `${header}DECLARE @m_no_stock = '';\n`;

test("B204: 注入した文が ASSERT の失敗メッセージに出る", async () => {
  const result = await executeBatch(
    `${declare}ASSERT 1 = 2, @m_no_stock; SELECT 1 AS skipped`,
    client(),
    { variables: { m_no_stock: "在庫が足りません" } }
  );
  expect(result.ok).toBe(false);
  expect(result.statements[1].error?.message).toBe(
    "AssertError: assertion failed: 1 = 2 (actual: 1). 在庫が足りません"
  );
  expect(result.statements[2]).toMatchObject({ status: "skipped", skippedReason: "assertion" });
});

test("B204: 言語ごとに注入した文がそのまま出る（同じ SQL・違う variables）", async () => {
  for (const text of ["在庫が足りません", "Out of stock", "库存不足"]) {
    const result = await executeBatch(
      `${declare}ASSERT 1 = 2, @m_no_stock`,
      client(),
      { variables: { m_no_stock: text } }
    );
    expect(result.statements[1].error?.message).toBe(
      `AssertError: assertion failed: 1 = 2 (actual: 1). ${text}`
    );
  }
});

test("B204: 注入が無ければ DECLARE の既定値を使う", async () => {
  const result = await executeBatch(
    `${header}DECLARE @m_x = '既定の文';\nASSERT 1 = 2, @m_x`,
    client()
  );
  expect(result.statements[1].error?.message).toBe(
    "AssertError: assertion failed: 1 = 2 (actual: 1). 既定の文"
  );
});

test("B204: 空に解決した変数はメッセージを省いたのと同じ（末尾に空白を付けない）", async () => {
  const injected = await executeBatch(
    `${declare}ASSERT 1 = 2, @m_no_stock`,
    client(),
    { variables: { m_no_stock: "" } }
  );
  expect(injected.statements[1].error?.message).toBe(
    "AssertError: assertion failed: 1 = 2 (actual: 1)."
  );

  // 既定値が空（宣言したまま注入しない）でも同じ
  const fallback = await executeBatch(`${declare}ASSERT 1 = 2, @m_no_stock`, client());
  expect(fallback.statements[1].error?.message).toBe(
    "AssertError: assertion failed: 1 = 2 (actual: 1)."
  );

  // リテラルの '' も同じ規則（B204 で揃えた）
  const literal = await executeBatch(`${header}ASSERT 1 = 2, ''`, client());
  expect(literal.statements[0].error?.message).toBe(
    "AssertError: assertion failed: 1 = 2 (actual: 1)."
  );
});

test("B204: ASSERT WARN の警告も注入した文になる", async () => {
  const result = await executeBatch(
    `${declare}ASSERT WARN 1 = 2, @m_no_stock; SELECT 1 AS continued`,
    client(),
    { variables: { m_no_stock: "在庫注意" } }
  );
  expect(result.ok).toBe(true);
  expect(result.statements[1].result).toMatchObject({
    type: "ASSERT", passed: false, warning: "在庫注意",
  });
  expect(result.statements[2].status).toBe("success");
});

test("B204: 空に解決した WARN は既定の文に落ちる", async () => {
  const result = await executeBatch(
    `${declare}ASSERT WARN 1 = 2, @m_no_stock`,
    client(),
    { variables: { m_no_stock: "" } }
  );
  expect(result.statements[1].result).toMatchObject({
    type: "ASSERT", passed: false, warning: "assertion failed: 1 = 2 (actual: 1).",
  });
});

test("B204: BETWEEN の形でも注入した文が出る", async () => {
  const result = await executeBatch(
    `${declare}ASSERT 5 BETWEEN 1 AND 3, @m_no_stock`,
    client(),
    { variables: { m_no_stock: "範囲外です" } }
  );
  expect(result.statements[1].error?.message).toBe(
    "AssertError: assertion failed: 5 BETWEEN 1 AND 3 (actual: 5). 範囲外です"
  );
});

test("B204: EXIT SUCCESS IF の結果のメッセージが注入した文になる", async () => {
  const result = await executeBatch(
    `${header}DECLARE @m_done = '';\nEXIT SUCCESS IF 1 = 1, @m_done; SELECT 1 AS skipped`,
    client(),
    { variables: { m_done: "対象がありません" } }
  );
  expect(result.ok).toBe(true);
  expect(result.statements[1]).toMatchObject({
    status: "success",
    result: { type: "EXIT", exited: true, message: "対象がありません" },
  });
  expect(result.statements[2]).toMatchObject({ status: "skipped", skippedReason: "exit" });
});

test("B204: EXIT のメッセージが空なら \"\" を返す（呼び出し側が既定の文に落とす）", async () => {
  const result = await executeBatch(
    `${header}DECLARE @m_done = '';\nEXIT SUCCESS IF 1 = 1, @m_done`,
    client()
  );
  expect(result.statements[1].result).toMatchObject({
    type: "EXIT", exited: true, message: "",
  });
});

// 以下の 3 件はバッチ解析（analyzeBatch）で止まる＝文を 1 つも実行せず、読み書き 0 回。
// /flow では createExecutionContext が同じエラーを投げる。
test("B204: 配列を宣言した変数はメッセージに書けない（実行前・読み書き 0 回）", async () => {
  await expect(executeBatch(
    `${header}DECLARE @ids = [];\nASSERT 1 = 1, @ids`,
    client(),
    { variables: { ids: ["1", "2"] } }
  )).rejects.toThrow("ParseError: array variable @ids can only be used as IN @ids.");
});

test("B204: 未宣言の変数はメッセージでも拒否する", async () => {
  await expect(executeBatch(`${header}ASSERT 1 = 1, @m_nope`, client()))
    .rejects.toThrow("ParseError: variable @m_nope is not defined before statement 1.");
});

test("B204: RELATIVE_DATE の変数はメッセージに書けない", async () => {
  await expect(executeBatch(
    `${header}DECLARE @d RELATIVE_DATE = THIS_MONTH();\nASSERT 1 = 1, @d`,
    client()
  )).rejects.toThrow(
    "ArgumentError: RELATIVE_DATE variable @d can only be used as a WHERE comparison right operand or BETWEEN boundary."
  );
});

test("B204: 注入していない名前は拒否する（タイポ）", async () => {
  await expect(executeBatch(
    `${declare}ASSERT 1 = 1, @m_no_stock`,
    client(),
    { variables: { m_nostock: "typo" } }
  )).rejects.toThrow("ArgumentError: injected variable @m_nostock is not declared.");
});

test("B204: EXPLAIN は変数の名前を出し、注入した値を出さない", async () => {
  const plans = await buildBatchExplainPlans(
    `${declare}ASSERT 1 = 2, @m_no_stock;\nEXIT SUCCESS IF 1 = 1, @m_no_stock`,
    client(),
    { m_no_stock: "在庫が足りません" }
  );
  const lines = plans.statements.map((item) => item.plan[0]);
  expect(lines[1]).toBe("ASSERT 1 = 2, '@m_no_stock'");
  expect(lines[2]).toBe("EXIT SUCCESS IF 1 = 1, '@m_no_stock'");
  expect(JSON.stringify(plans)).not.toContain("在庫が足りません");
});

// --- Codex レビュー（2026-11-06）で足した境界 ---

test("B204: メッセージの変数は単文では書けない（dialect 1 の宣言が要る・API 0 回）", async () => {
  // 単文実行（execute）は -- @ksql dialect: 1 のヘッダーを読まないので、構文の段階で止まる
  const strict = strictClient();
  await expect(execute("ASSERT 1 = 1, @m_x", strict.value))
    .rejects.toThrow("この構文には -- @ksql dialect: 1 の宣言が必要です");
  expect(strict.calls).toEqual([]);

  // 1 文だけのバッチも、バッチ解析（純粋な AST の検査）が先に拒否する
  const batch = strictClient();
  await expect(executeBatch(`${header}ASSERT 1 = 1, @m_x`, batch.value))
    .rejects.toThrow("ParseError: variable @m_x is not defined before statement 1.");
  expect(batch.calls).toEqual([]);
});

test("B204 付随: 単文の未解決変数は相対日付の計画（フォーム定義の取得）より前に拒否する", async () => {
  // 条件に TODAY() があると相対日付の計画でフォーム定義を読む。検査の順序を入れ替えたので
  // 「未解決の変数がある文は API を 1 回も呼ばずに止まる」が全文型で成り立つ。
  const strict = strictClient();
  await expect(execute(
    "SELECT 残数 FROM APP1 WHERE 日付 = TODAY() AND 残数 = @n",
    strict.value
  )).rejects.toThrow("ParseError: variable @n is not defined in a batch.");
  expect(strict.calls).toEqual([]);
});

test("B204: 配列・未宣言をメッセージに書いた形も API を 1 回も呼ばない", async () => {
  for (const sql of [
    `${header}DECLARE @ids = [];\nASSERT 1 = 1, @ids`,
    `${header}ASSERT 1 = 1, @m_nope`,
  ]) {
    const strict = strictClient();
    await expect(executeBatch(sql, strict.value, { variables: {} })).rejects.toThrow("ParseError:");
    expect(strict.calls).toEqual([]);
  }
});

test("B204: 数値の変数をメッセージに書いたら文字表現が入る", async () => {
  const records = Array.from({ length: 3 }, (_, index) => ({ $id: { value: String(index + 1) } }));
  const result = await executeBatch(
    `${header}SET @n = (SELECT COUNT(*) FROM APP1);\nASSERT 1 = 2, @n`,
    client(records)
  );
  expect(result.statements[1].error?.message).toBe(
    "AssertError: assertion failed: 1 = 2 (actual: 1). 3"
  );
});

test("B204: EXIT 不成立でも解決後のメッセージを返す", async () => {
  const result = await executeBatch(
    `${header}DECLARE @m_done = '';\nEXIT SUCCESS IF 1 = 2, @m_done; SELECT 1 AS continued`,
    client(),
    { variables: { m_done: "対象がありません" } }
  );
  expect(result.ok).toBe(true);
  expect(result.statements[1].result).toMatchObject({
    type: "EXIT", exited: false, message: "対象がありません",
  });
  expect(result.statements[2].status).toBe("success");
});

test("B204: ASSERT WARN のリテラル（非空）は従来どおり", async () => {
  const result = await executeBatch(`${header}ASSERT WARN 1 = 2, '警告の文'`, client());
  expect(result.statements[0].result).toMatchObject({
    type: "ASSERT", passed: false, warning: "警告の文",
  });
});

test("B204: 空の EXIT は CLI 表示で条件に落ちる（意図した 3 点目の退行）", () => {
  const empty: ExitResult = { type: "EXIT", condition: "1 = 1", exited: true, message: "" };
  expect(renderResult(empty)).toContain("終了条件成立: 1 = 1");
  const filled: ExitResult = { type: "EXIT", condition: "1 = 1", exited: true, message: "対象なし" };
  expect(renderResult(filled)).toContain("対象なし");
  const notExited: ExitResult = { type: "EXIT", condition: "1 = 2", exited: false, message: "対象なし" };
  expect(renderResult(notExited)).toContain("終了条件不成立: 1 = 2");
});

test("B204: as-of 関数をメッセージに書くと基準時刻が入る（禁じない）", async () => {
  const asOf = new Date("2030-01-02T03:04:05Z");
  const result = await executeBatch(`${header}ASSERT 1 = 2, @NOW(); SELECT 1 AS skipped`, client(), { asOf });
  expect(result.statements[0].error?.message).toBe(
    "AssertError: assertion failed: 1 = 2 (actual: 1). 2030-01-02T03:04:05.000Z"
  );
});

test("B204: リテラルのメッセージは EXPLAIN でも従来どおり書き戻す", async () => {
  const plans = await buildBatchExplainPlans(
    `${header}ASSERT 1 = 2, 'それは''困る''';\nEXIT SUCCESS IF 1 = 1, '対象なし'`,
    client()
  );
  expect(plans.statements[0].plan[0]).toBe("ASSERT 1 = 2, 'それは''困る'''");
  expect(plans.statements[1].plan[0]).toBe("EXIT SUCCESS IF 1 = 1, '対象なし'");
});
