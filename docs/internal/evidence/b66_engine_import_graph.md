# B66 Phase 1 Step 1 — engine import graph 監査 evidence

- 実施日: 2026-07-23
- 対象: `src/execute.ts` をそのまま entry にする選択肢 A と、`src/execute.ts` を import せず read 系 module を直接束ねる選択肢 B floor
- 監査コマンド: `node scripts/engine-import-graph.mjs`
- bundler: esbuild **0.27.5**
- 共通条件: `bundle: true`、`write: false`、`metafile: true`、tree-shaking 有効
- browser 条件: ESM、browser、ES2020
- Node 条件: CJS、Node、Node 18
- gzip 条件: minified JavaScript、gzip level 9、mtime 0

この Step は監査だけであり、`src/` は変更していない。B floor の
`scripts/engine-read-floor-probe.ts` も public API や実行可能な read router ではない。
parser と現行 read path で使用する module を直接 import した、抽出後 bundle の楽観的な
下限測定用 entry である。

## 1. 判定方法

`scripts/engine-import-graph.mjs` は次を毎回実行する。

1. browser ESM/ES2020 と Node CJS/Node18 の各条件で unminified と minified を build する。
2. metafile input を `read path`、`DML・APPLY・IMPORT`、`MCP・docs`、`platform 固有` の4分類に全件振り分ける。
3. named deny rule で MCP instructions、`src/mcp/**`、`docs/**`、statement catalog、`zod`、`@modelcontextprotocol/sdk`、CLI profile/credential、plugin UI/CSS/manifest、Node builtin import、出力中の `Buffer` を検査する。
4. A に存在し B floor に存在しない module（混在 router 自身の `src/execute.ts` は除外）を「DML/APPLY/IMPORT ブランチ経由でのみ到達する module」とする。
5. bundle の unminified/minified/gzip、minified metafile の top contributor、branch-exclusive module の `bytesInOutput` 合計を出す。

gzip は module ごとに加算可能な量ではない。このため branch-exclusive module については、
各 source を esbuild で個別に minify して連結後に gzip した補助実測も出すが、A/B の削減見込みの
主値には、同じ build 条件で得た **A bundle - B floor bundle** の差分を用いる。

## 2. 選択肢 A — `src/execute.ts` 直接 import

| target | input | unminified | minified | gzip |
|---|---:|---:|---:|---:|
| browser ESM / ES2020 | **71** | **849,438 B** | **449,713 B** | **120,556 B** |
| Node CJS / Node18 | **71** | **850,958 B** | **450,437 B** | **120,927 B** |

input 分類は両 target で同一だった。

| 分類 | input 数 |
|---|---:|
| read path | 33 |
| DML・APPLY・IMPORT | **38** |
| MCP・docs | 0 |
| platform 固有 | 0 |
| 合計 | 71 |

したがって A は指定 forbidden を引かない一方、DML/APPLY/IMPORT implementation を
明確に bundle する。`forbidden = 0` と `read-path-only` は同義ではない。

### A の top contributors（minified `bytesInOutput`）

| 順位 | input | browser | Node |
|---:|---|---:|---:|
| 1 | `src/execute.ts` | 162,484 B | 162,862 B |
| 2 | `src/parser/parser.ts` | 87,826 B | 87,826 B |
| 3 | `src/engine/process.ts` | 19,161 B | 19,161 B |
| 4 | `src/core/applyPatchScope.ts` | 12,534 B | 12,534 B |
| 5 | `src/engine/evalFunc.ts` | 11,155 B | 11,155 B |
| 6 | `src/converter/dmlToKintone.ts` | 10,187 B | 10,187 B |
| 7 | `src/core/applyPatchPlanner.ts` | 9,946 B | 9,946 B |
| 8 | `src/converter/selectToKintone.ts` | 8,728 B | 8,728 B |
| 9 | `src/lexer/lexer.ts` | 5,893 B | 5,893 B |
| 10 | `src/core/klikeValidation.ts` | 5,843 B | 5,843 B |
| 11 | `src/core/batch.ts` | 5,499 B | 5,499 B |
| 12 | `src/engine/evalWhere.ts` | 5,497 B | 5,497 B |

## 3. 選択肢 B — read-only 抽出の floor

| target | input | unminified | minified | gzip |
|---|---:|---:|---:|---:|
| browser ESM / ES2020 | **34** | **347,747 B** | **190,029 B** | **47,593 B** |
| Node CJS / Node18 | **34** | **348,690 B** | **190,445 B** | **47,798 B** |

分類は read path 33、DML・APPLY・IMPORT 1、MCP・docs 0、platform 固有 0。
残る1件は `src/core/applyPatchScope.ts` で、`parseSqlStatement()` が呼ぶ
`klikeValidation.ts` から共有 validation helper として推移到達する。probe は DML executor
や mutation client を束ねておらず、この1件は「DML branch が残った」という意味ではない。
ファイル名による保守的分類と、branch-exclusive 判定を分離している。

### B floor の top contributors（minified `bytesInOutput`、両 target 同値）

| 順位 | input | bytes |
|---:|---|---:|
| 1 | `src/parser/parser.ts` | 87,803 B |
| 2 | `src/engine/process.ts` | 19,501 B |
| 3 | `src/engine/evalFunc.ts` | 11,392 B |
| 4 | `src/converter/selectToKintone.ts` | 8,920 B |
| 5 | `src/core/klikeValidation.ts` | 5,931 B |
| 6 | `src/lexer/lexer.ts` | 5,883 B |
| 7 | `src/engine/evalWhere.ts` | 5,601 B |
| 8 | `src/core/groupingValidation.ts` | 5,286 B |
| 9 | `src/core/applyPatchScope.ts` | 4,801 B |
| 10 | `src/converter/whereToKintone.ts` | 3,886 B |
| 11 | `src/core/scalarCompare.ts` | 2,926 B |
| 12 | `src/api/fetchAll.ts` | 2,752 B |

## 4. DML/APPLY/IMPORT branch-exclusive module

A から到達し B floor から到達しない module は **38 input**。

- converter: `applyPatchToKintone.ts`、`dmlToKintone.ts`
- core APPLY: `applyDiagnostic.ts`、`applyInsertExecutePrepared.ts`、`applyInsertPrepare.ts`、
  `applyMultiValuePlan.ts`、`applyPatchExecutePrepared.ts`、`applyPatchPlanner.ts`、
  `applyPatchPrepare.ts`、`applyUpsertExecutePrepared.ts`、`applyUpsertPrepare.ts`
- core DML/batch/validation: `batch.ts`、`batchVariables.ts`、`dmlCustomCheck.ts`、
  `dmlGuard.ts`、`dmlPrevalidation.ts`、`dmlValidation.ts`、
  `dmlValidationCandidates.ts`、`existingRecordValidation.ts`、`numberPrecision.ts`、
  `optimization/applyParentSelectionPlan.ts`、`optimization/whereCapability.ts`、
  `postImageValidation.ts`
- IMPORT: `src/import/` の15 module

| target | branch-exclusive minified `bytesInOutput` 合計 |
|---|---:|
| browser ESM / ES2020 | **93,078 B** |
| Node CJS / Node18 | **93,043 B** |

38 source を個別 minify して連結した補助実測は **103,524 B minified /
30,938 B gzip**（両 target 共通の ES2020 source transform）だった。この gzip 値は
bundle 全体の辞書圧縮を再現しないため、A/B bundle 差分とは混ぜない。

`src/execute.ts` 自身の minified 寄与は browser 162,484 B / Node 162,862 B だが、
read と DML の関数が同一 module に混在するので、import graph だけではこの中の削除可能量を
分離できない。これが B floor を「完成版 B のサイズ」ではなく楽観的下限として扱う理由である。

## 5. A と B floor の差分

| target | unminified 差分 | minified 差分 | gzip 差分 |
|---|---:|---:|---:|
| browser ESM / ES2020 | **501,691 B** | **259,684 B** | **72,963 B** |
| Node CJS / Node18 | **502,268 B** | **259,992 B** | **73,129 B** |

browser の B floor は A に対して minified 57.7%、gzip 60.5% 小さい。ただし完成版 B には、
probe にない read router、metrics/client wrapper、SHOW APPS/DESCRIBE/EXPLAIN orchestration が
必要なので、実際の gzip 削減は **72,963 B より小さくなる**。この Step では `src/execute.ts`
を分割していないため、完成版 B の値を推測で補完しない。

## 6. forbidden 検査

A と B floor、browser と Node の全4 bundle で次はすべて **0**。

| deny rule | A browser | A Node | B floor browser | B floor Node |
|---|---:|---:|---:|---:|
| MCP instructions | 0 | 0 | 0 | 0 |
| `src/mcp/**` | 0 | 0 | 0 | 0 |
| `docs/**` | 0 | 0 | 0 | 0 |
| statement catalog | 0 | 0 | 0 | 0 |
| `zod` | 0 | 0 | 0 | 0 |
| `@modelcontextprotocol/sdk` | 0 | 0 | 0 | 0 |
| CLI profile/credential | 0 | 0 | 0 | 0 |
| plugin UI/CSS/manifest | 0 | 0 | 0 | 0 |
| Node builtin import | 0 | 0 | 0 | 0 |
| emitted `Buffer` | 0 | 0 | 0 | 0 |

## 7. 所見と停止 gate

- A は forbidden 0 で、MCP/docs/platform 固有 surface の混入はない。
- A は DML/APPLY/IMPORT 38 input に到達するため、仕様 §4.4 の read-path-only は未達。
- branch-exclusive module だけでも minified 約93 KB、独立 gzip 補助実測約31 KBある。
- read orchestration 未実装の楽観値ではあるが、browser の A/B floor gzip 差は約73 KBで、
  A 120,556 B の60.5%に相当する。差は測定ノイズや数 KB 程度ではない。

したがって、仕様 §4.4 のサイズ/品質目標を維持するなら **選択肢 B（Step 1.5 として read
router を機械抽出）を推奨**する。安全性だけを優先し engine 無改変を選ぶ場合は A でも
forbidden 条件は満たすが、その場合は計画 §16 のとおり §4.4 を「DML path は将来最適化」と
明示的に緩和する必要がある。現時点では抽出を実装せず、オーナー判断まで Step 2 を停止する。

## 8. 非回帰 gate

| gate | 結果 |
|---|---|
| `node scripts/engine-import-graph.mjs` | PASS |
| `npm test` | PASS — 129 suites / 3,000 tests / 21 snapshots + subprocess 2 suites / 25 tests |
| `npm run build:plugin` | PASS — `prod/js/desktop.js`、`prod/js/config.js`、plugin zip |
| `npm run build:cli` | PASS — `dist-cli/ksql.js` |
| `npm run build:mcp` | PASS — `dist-mcp/ksql-mcp.js` |
| `npm run build:mcpb` | PASS — `dist-mcpb/ksql-mcp.mcpb` |

4 build は `npm run build` の既存直列 gate で実行した。既存 snapshot は全21件 pass。
監査 script/probe/evidence 以外の実装 source は変更していない。
