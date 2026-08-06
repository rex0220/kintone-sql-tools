/**
 * B101 常駐 MCP プロセスの版数。
 *
 * esbuild の define(build-mcp.mjs)で package.json の version が埋め込まれる。
 * バンドル外(ts-jest 等)では未定義のため typeof ガードでフォールバックする。
 *
 * MCP は常駐プロセスなので、npm install しても再読み込みするまで差し替わらない。
 * CLI の `--version` は別プロセスの版で、常駐 MCP の版ではない。
 * 「確かめたつもりで別のものを測る」ことが独立に 2 回起きたため、
 * ここを唯一の出所にして initialize と ksql_docs の両方から名乗る。
 */
declare const __KSQL_VERSION__: string;

export const SERVER_VERSION: string =
  typeof __KSQL_VERSION__ === "string" ? __KSQL_VERSION__ : "0.0.0-dev";
