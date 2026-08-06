import { KSQL_DOCS_INDEX, KSQL_DOCS_VERSION_LINE, resolveKsqlDocsSection } from "../docsResources";
import { KSQL_MCP_INSTRUCTIONS } from "../index";
import { SERVER_VERSION } from "../serverVersion";

/**
 * B101 再開 — 常駐 MCP の版を tool の返り値から取れるようにする。
 *
 * v3.34.1 で案 A'（instructions の 1 行目）を入れたが、1 週間後に同じ罠が出た。
 * 依頼元は「版を確かめよう」と思った瞬間に CLI の `--version` へ手を伸ばし、
 * 常駐プロセスではなく別プロセスの版を測っていた。
 *
 * instructions は接続時に 1 回配られるだけ（B101 §4 の案 A' の限界欄に書いてあった）。
 * 押し付けは、探しに行く人には届かない。取りに行ける場所にも置く。
 */

test("B101: ksql_docs の索引が先頭で版を名乗る", () => {
  const index = resolveKsqlDocsSection(undefined);
  expect(index.startsWith(KSQL_DOCS_VERSION_LINE)).toBe(true);
  expect(index).toContain(`kSQL MCP server version ${SERVER_VERSION}`);
});

test("B101: 版数の出所は 1 つ（instructions と索引が食い違わない）", () => {
  // 版を 2 か所に書くと、片方だけ古くなる（B141 で 5 回やった形）。
  // SERVER_VERSION を唯一の出所にして、両方がそこから引く。
  expect(KSQL_MCP_INSTRUCTIONS).toContain(`kSQL MCP server version ${SERVER_VERSION}`);
  expect(KSQL_DOCS_VERSION_LINE).toContain(`kSQL MCP server version ${SERVER_VERSION}`);
});

test("B101: CLI の版と食い違い得ることを索引に書く", () => {
  // 「常駐なので再読み込みするまで差し替わらない」は依頼元の文書にも書いてあった。
  // 書いてあっても踏んだので、測る場所そのものに書く。
  expect(KSQL_DOCS_VERSION_LINE).toContain("resident process");
  expect(KSQL_DOCS_VERSION_LINE).toContain("CLI");
});

test("B101: 索引の中身は従来どおり（版の行を足しただけ）", () => {
  expect(KSQL_DOCS_INDEX).toContain("language-reference/05-string-number-functions");
  expect(KSQL_DOCS_INDEX).toContain("- recipes/r17");
  expect(KSQL_DOCS_INDEX).toContain("## ksql_docs section keys");
});
