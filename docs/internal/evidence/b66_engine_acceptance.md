# B66 Phase1 Step 8 engine acceptance evidence

- 実施日: 2026-07-24
- 判断: A
- 対象: B66 Phase1 Step 8（仕様 §8、実装計画 §10）
- Node 実施者: Codex
- 実ブラウザ: **ユーザー実施待ち**
- git 操作: 未実施

## 1. 判定

Node で実施可能な受入、build、bundle/declaration/pack/UMD smoke、CLI/MCP
非回帰はすべて PASS した。Firefox / Chrome の実機 gate は Codex 実行環境では
実施しておらず、Node test で代替していない。したがって Step 8 の最終受入は
**実ブラウザ evidence 待ち**であり、release 可とは判定しない。

実ブラウザの手順と結果記入欄は
[`b66_engine_browser_smoke.md`](b66_engine_browser_smoke.md) に分離した。

## 2. 仕様 §8 の1対1対応表

「Node PASS / browser待ち」は、Node 側の自動検査は成功したが、仕様または計画が
要求する実ブラウザ確認をまだ満たしていないことを表す。

| ID | 仕様 §8 の箇条書き | test / evidence | 結果 |
|---|---|---|---|
| 8.1-1 | browser factory の SELECT JOIN GROUP BY と QueryResult | `acceptance.test.ts` の両surface正例、browser smoke §3 | Node PASS / browser待ち |
| 8.1-2 | WITH、UNION ALL、SHOW APPS、DESCRIBE の同一契約 | `acceptance.test.ts` の両surface正例、browser smoke §3 | Node PASS / browser待ち |
| 8.1-3 | KORDER Cursor success / error の双方で close | `acceptance.test.ts` の KORDER 3件、`cursorScope.test.ts`、browser smoke §3 | Node PASS / browser待ち |
| 8.1-4 | BYO は browser と同じ結果、guest route 保持 | `acceptance.test.ts` の BYO正例・guest route、browser smoke §3 | PASS |
| 8.1-5 | EXPLAIN は plan、records / Cursor 0、field metadataのみ | `acceptance.test.ts` の EXPLAIN、browser smoke §3 | Node PASS / browser待ち |
| 8.1-6 | ESM / CJS / UMD の version・public名・結果一致 | `engine-umd-smoke.mjs` の public names/result parity、browser smoke §3/§4 | Node PASS / browser待ち |
| 8.1-7 | pack consumer runtime import と `.d.ts` typecheck | `engine-pack-smoke.mjs`、`engine-declaration-smoke.mjs` | PASS |
| 8.2-1 | INSERT / UPDATE / UPSERT / DELETE / REORDER / APPLY / IMPORT / VALIDATE ONLY 拒否、execute 0、mutation 0 | `readonlyNegativeMatrix.test.ts` の文種matrix | PASS |
| 8.2-2 | EXPLAIN UPDATE / IMPORT 拒否 | `readonlyNegativeMatrix.test.ts` の EXPLAIN matrix | PASS |
| 8.2-3 | VALIDATE、CREATE / DROP TEMP、SET / DECLARE、ASSERT、複文拒否 | `readonlyNegativeMatrix.test.ts` の文種matrix・複文 | PASS |
| 8.2-4 | future statement type を default-deny | `readonlyNegativeMatrix.test.ts` の future fixture | PASS |
| 8.2-5 | browser factory のラップ前 client に write 3メソッドなし | `readonlyNegativeMatrix.test.ts` の original/projection検査、browser smoke §3 | Node PASS / browser待ち |
| 8.2-6 | BYO 射影済み client に write 3メソッドなし | `readonlyNegativeMatrix.test.ts` の original/projection検査 | PASS |
| 8.2-7 | guard bypass でも mutation 0、clean READ_ONLY_VIOLATION | `readonlyNegativeMatrix.test.ts` の bypass 3メソッド | PASS |
| 8.3-1 | malformed=PARSE_ERROR、parse可能な非read=READ_ONLY_VIOLATION | `boundaryErrors.test.ts` の code分離 | PASS |
| 8.3-2 | browser / BYO search aborted の simple / JOIN / GROUP BY は SEARCH_ABORTED・row 0 | `boundaryErrors.test.ts`、`searchAbort.test.ts`、browser smoke §3 | Node PASS / browser待ち |
| 8.3-3 | maxRecords、simple truncate許可、完全入力plan fail-closed | `boundaryErrors.test.ts` の limit/truncate matrix、既存 complete-input test | PASS |
| 8.3-4 | client / executor error分類と cause 保持 | `boundaryErrors.test.ts`、`errorMapping.test.ts` | PASS |
| 8.3-5 | option未知key・非整数・範囲外を実行前拒否 | `boundaryErrors.test.ts` の option matrix | PASS |
| 8.4-1 | public `.d.ts` は §2 の面のみで内部型/DML型なし | `engine-public-exports.snapshot.json` + `engine-declaration-smoke.mjs` | PASS（5 value / 20 type） |
| 8.4-2 | forbidden Node builtin / MCP SDK / zod / embedded docs/catalogなし | `engine-bundle-guard.mjs` の metafile + emitted string guard | PASS（全bundle forbidden 0） |
| 8.4-3 | npm test、plugin/CLI/MCP/MCPB/engine build、MCP smoke/pack無回帰 | §3 Node gate | PASS |
| 8.4-4 | plugin browser smoke、CLI/MCP query / EXPLAIN / DML guard無回帰 | CLI dry-run + `mcp-smoke.mjs`、browser smoke §5 | Node面 PASS / plugin browser待ち |
| 8.4-5 | tarball に既存bin・既存3 dist・engine 4成果物 | `engine-pack-smoke.mjs` | PASS |
| 8.5-1 | UMD 2版を順不同ロードし versions保持・exact get | `engine-umd-smoke.mjs`、browser smoke §4 | Node PASS / browser待ち |
| 8.5-2 | duplicateは先着保持+warning、非registryは上書きせずfail-closed | `engine-umd-smoke.mjs` | PASS |
| 8.5-3 | 2版client/Cursor、listener増加0、kintone.api identity不変 | `engine-umd-smoke.mjs`、browser smoke §4 | Node PASS / browser待ち |
| 8.5-4 | per-instance lease分離、capacity事前拒否、host rejectはretry/fallback/部分結果なし | `engine-umd-smoke.mjs`、`versionRegistry.test.ts` | PASS |

## 3. Node gate 結果

| Gate | コマンド | 結果 |
|---|---|---|
| 新規受入3 suite | `npm test -- --runInBand src/engine-library/__tests__/acceptance.test.ts src/engine-library/__tests__/readonlyNegativeMatrix.test.ts src/engine-library/__tests__/boundaryErrors.test.ts` | **50/50 PASS**、snapshot 0 |
| 全test | `npm test` | **3,184/3,184 PASS**（parallel 3,159 + subprocess 25）。既存3,134 + 新規50 |
| snapshot | 同上 | **21/21 PASS**、更新なし |
| 全build | `npm run build` | plugin / CLI / MCP / MCPB / engine 全成功 |
| MCP smoke | `npm run mcp:smoke` | PASS。build済みMCPの no-FROM query、EXPLAIN、APPLY mutation guardを含む |
| MCP pack smoke | `npm run mcp:pack-smoke` | PASS |
| MCPB verify | `node scripts/mcpb-verify.mjs` | PASS |
| engine bundle | `npm run engine:bundle-guard` | PASS、全3bundle forbidden 0 |
| declaration | `npm run engine:declaration-smoke` | NodeNext / Node16 PASS、内部import 0、B66 snapshot一致 |
| engine pack | `npm run engine:pack-smoke` | 既存bin/3 dist + engine 4成果物、ESM/CJS/types/runtime PASS |
| UMD | `node scripts/engine-umd-smoke.mjs` | 2版順不同、duplicate、collision、global 0、per-instance、3面parity PASS |
| targeted回帰 | 指定8 suiteを `--runInBand` | **497/497 PASS**、snapshot 0 |
| build済みCLI | `--help` / `--version` / `--dry-run -e "SELECT 1 AS one"` | PASS、version 3.18.0、SIMPLE plan、record/mutation API不要 |

targeted回帰の8 suite:

- `src/__tests__/execute.test.ts`
- `src/__tests__/explain.test.ts`
- `src/__tests__/searchAbort.execute.test.ts`
- `src/ui/__tests__/kintoneClient.test.ts`
- `src/__tests__/b51CteJoinAlias.test.ts`
- `src/__tests__/b52CteInlining.test.ts`
- `src/__tests__/b65GroupingExecute.test.ts`
- `src/__tests__/b65AggregateInteraction.test.ts`

全testには上記に加えて parser、KORDER planner/executor、WITH/UNION/JOIN、
aggregate、CLI subprocess 等の既存 suite が含まれる。

## 4. bundle baseline

| bundle | inputs | minified bytes | gzip bytes | forbidden |
|---|---:|---:|---:|---:|
| `index.mjs` | 85 | 444,578 | 119,684 | 0 |
| `index.cjs` | 85 | 445,113 | 119,990 | 0 |
| `ksql-engine.umd.js` | 87 | 445,605 | 120,031 | 0 |

guard対象は MCP instructions / `src/mcp` / docs / statement catalog / zod /
MCP SDK / CLI credential / plugin UI / Node builtin / Buffer に加え、emitted bundle
中の docs path / catalog / MCP instruction marker である。

## 5. public declaration snapshot

B66専用 snapshot:
`scripts/fixtures/engine-public-exports.snapshot.json`

- value export: 5
  - `version`
  - `createReadonlyKintoneClient`
  - `runQuery`
  - `explainQuery`
  - `KsqlEngineError`
- type export: 20（仕様 §2 の readonly client / option / result DTO のみ）
- `execute.ts`、AST、DML、IMPORT、APPLY、MCP型の export/import: 0

## 6. 変更境界

この Step で変更した `src` は次の新規3ファイルだけで、すべて
`src/engine-library` 配下である。engine本体、parser、core、既存client、uiは
変更していない。

- `src/engine-library/__tests__/acceptance.test.ts`
- `src/engine-library/__tests__/readonlyNegativeMatrix.test.ts`
- `src/engine-library/__tests__/boundaryErrors.test.ts`

git コマンドは使用していない。変更境界の確認は、この実行で適用した patch 一覧と
ファイル更新時刻の列挙で行った。

## 7. 未達・未解決

1. **Firefox 実機: ユーザー実施待ち**
2. **Chrome 実機: ユーザー実施待ち**
3. 現在の実装versionは `3.18.0`。Step 9 の `3.19.0` release metadata更新は
   本 Step の対象外。
4. 上記実ブラウザ2面の結果が記入されるまで、仕様 §8 / 計画 §10 の受入は未完了で
   release不可。Node PASS は実機の代替ではない。
