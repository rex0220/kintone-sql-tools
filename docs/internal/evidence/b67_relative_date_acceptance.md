# B67 Phase1 Step 8 — acceptance matrix / 自動 gate evidence

- 実施日: 2026-07-24
- 対象仕様: `ksql_b67_rest_query_functions_phase1_spec.md` R2 §10.2〜§10.5
- 状態: **Node / CLI / MCP 自動 gate 完了、browser release gate 未完了**
- 実ブラウザ: [Firefox / Chrome 手順・貼付欄](b67_relative_date_browser_smoke.md)。
  **ユーザー実施待ち**であり、Node testでは代替しない。

## 1. R2 §10 対応表

| 受入ID | R2 | 項目 | test / evidence | 状態 |
|---|---|---|---|---|
| R2-10.2-01 | 10.2 | 全12関数大小文字、4型×6比較、FROM_TODAY境界、週/月/年引数、BETWEEN | `b67RelativeDateAcceptance.test.ts`、parser / capability tests | PASS |
| R2-10.2-02 | 10.2 | REST serializer byte、soft keyword / 同名field | converter / parser tests | PASS |
| R2-10.2-03 | 10.2 | SIMPLE、UPDATE / DELETE / VALIDATE ONLY、KORDER native / cursor | execution-path / DML / KORDER tests | PASS |
| R2-10.3-01 | 10.3 | 全引数エラー、safe integer外、禁止位置、IN / NOT IN / NOT BETWEEN | parser tests | PASS |
| R2-10.3-02 | 10.3 | TIME / 非日付 / 未知型 / subtable / 関連、関数左辺 | capability / execution-path tests | PASS |
| R2-10.4-01 | 10.4 | planner拒否matrix、records / Cursor / mutation / confirm 0 | plan-guard / execution-path tests | PASS |
| R2-10.4-02 | 10.4 | AND/OR部分exact、server REST error、KORDER fallback 0 | capability / KORDER tests | PASS |
| R2-10.4-03 | 10.4 | planner bypass runtime backstop | backstop tests | PASS |
| R2-10.4-04 | 10.4 | EXPLAINと実行のquery / reason一致 | EXPLAIN / execution-path / MCP smoke | PASS |
| R2-10.5-01 | 10.5 | 既存3関数 AST / converter / SELECT / DML / EXPLAIN / resolver byte不変 | parser / converter / backstop legacy tests | PASS |
| R2-10.5-02 | 10.5 | Node / built CLI / built MCP / plugin共有engine | surfaces test、built CLI e2e、MCP smoke | 自動面 PASS、実browser待ち |
| R2-10.5-03 | 10.5 | catalog / parser / fixture / docs / instructions drift guard | MCP docs / catalog tests、MCP smoke | PASS |
| R2-10.5-04 | 10.5 | Firefox / Chrome plugin実機 | `b67_relative_date_browser_smoke.md` | **ユーザー実施待ち** |

## 2. 自動 gate 実測

| gate | 実測結果 |
|---|---|
| B67 Step 1〜8対象 | 14 suites / 1,109 tests / snapshot 1、全green |
| `npm test` 通常suite | 155 suites / 4,146 tests / snapshots 22、全green |
| `npm test` subprocess | CLI 2 suites / 26 tests、全green |
| 既存snapshot | update実行なし、22 passed。B67対象snapshot 1 passed |
| `npm run build` | plugin / CLI / MCP / MCPB / engine 全成功。plugin ZIP `3.19.0` |
| `npm run mcp:smoke` | built MCPで構文validate、schema-aware EXPLAIN/query、正負ともPASS |
| `npm run mcp:pack-smoke` | PASS |
| `npm run mcpb:verify` | MCP / MCPB再buildを含めPASS |
| engine bundle / declaration / pack | 3 smokeともPASS |
| built CLI | 正例実行query＋EXPLAIN、負例reason、負例records/Cursor/mutation 0 |
| planner拒否 / runtime bypass | 独立suiteで双方PASS |
| legacy byte | AST / converter / SELECT / DML / EXPLAIN snapshot・resolver既存3case PASS |

built CLIとbuilt MCPが同一fixtureで送信した代表query:

```text
日付 >= FROM_TODAY(-7, DAYS) order by $id asc limit 1
```

非対応型 `SELECT 件名 FROM APP100 WHERE 件名 = YESTERDAY()` は両面で
`WHERE_RELATIVE_DATE_FIELD_TYPE_UNSUPPORTED` と
`WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN` を保持し、records APIを追加で呼ばない。
MCP `ksql_validate` は正例を
`validationScope=syntax-and-arguments-only` / `executionValidated=false` とし、不正引数を
ParseErrorにする。`ksql_explain` / `ksql_query` はmetadata fixtureを用いたschema-aware結果。

## 3. 未達 / 未解決

- Firefox / Chrome plugin実機: **ユーザー実施待ち**。
- Node / CLI / MCP側の未解決点: なし。
- browser evidenceが揃うまでB67 Phase1のbrowser release gateは未完了。
