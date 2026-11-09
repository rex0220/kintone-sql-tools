import { readFileSync } from "fs";
import { join } from "path";
import { materializeReadMaxRecords, TEMP_TABLE_MAX_ROWS } from "../execute";

/**
 * B197 / 依頼 KJ-11 の ②: **`maxRecords` を常に解決して渡す面**（MCP・CLI）の互換。
 *
 * エンジンは v3.93.0 から「`CREATE TEMP TABLE` の読む件数の上限は（明示した）`maxRecords`」。
 * MCP と CLI はどちらも `maxRecords` を**常に**渡す（既定 500）ので、
 * `tempTableReadMaxRecords` を渡さないと
 * 「`tempTableMaxRows` だけ上げて 10,000 行超を実体化する」という公開の契約が 500 件で止まる。
 *
 * 1 回目のレビュー対応では MCP だけに入れて CLI を落としていた（2 回目のレビューの MAJOR）。
 * 面が増えたときに同じ落とし方をしないよう、**式を 1 か所に寄せたこと**も試験で固定する。
 */
test("materializeReadMaxRecords: maxRecords と tempTableMaxRows の大きいほうまで読む", () => {
  // 既定（500）＋ tempTableMaxRows 未指定 → エンジン既定の 10,000（v3.92.0 と同じ読む量）
  expect(materializeReadMaxRecords(500, undefined)).toBe(TEMP_TABLE_MAX_ROWS);
  // tempTableMaxRows を上げたらそこまで読める（この面の公開の契約）
  expect(materializeReadMaxRecords(500, 20_000)).toBe(20_000);
  // maxRecords のほうが大きければ maxRecords（明細の SELECT と同じ上限）
  expect(materializeReadMaxRecords(50_000, 20_000)).toBe(50_000);
  // tempTableMaxRows を小さくしても読む量は下げない（集計して 1 行にする文を通すため）
  expect(materializeReadMaxRecords(500, 5)).toBe(500);
});

describe("maxRecords を常に渡す面は tempTableReadMaxRecords も渡す", () => {
  const read = (path: string) => readFileSync(join(__dirname, "..", path), "utf-8");

  test.each([
    ["mcp/tools.ts", "executeBatchSql("],
    ["cli/index.ts", "await executeBatch("],
  ] as const)("%s", (path, batchCall) => {
    const source = read(path);
    const batchCalls = source.split(batchCall).length - 1;
    const readLimits = source.split("tempTableReadMaxRecords:").length - 1;
    expect(batchCalls).toBeGreaterThan(0);
    // バッチを実行する口の数だけ、読む量の上限を渡していること
    expect(readLimits).toBe(batchCalls);
    // 式は共有の 1 か所（materializeReadMaxRecords）だけで書く
    expect(source.split("tempTableReadMaxRecords: materializeReadMaxRecords(").length - 1)
      .toBe(readLimits);
    // 面で Math.max を書き直していないこと（資料と式が食い違う元）
    expect(source).not.toMatch(/tempTableReadMaxRecords:\s*Math\.max/);
  });
});
