# B66 Phase1 実装計画 — read-only kSQL エンジン・ライブラリ公開

- ステータス: ✅ **Step 1〜9 完了・v3.19.0 リリース完全完了（2026-07-24・npm latest 3.19.0）**。判断 A（DML 同梱・forbidden 群 0）で公開 docs、evidence、3.19.0 metadata、5面 build、release 3成果物、全 gate、pack 済み ESM/CJS/UMD docs 例まで完了。git/commit/tag/Release/publish は未実施で Claude／ユーザー作業。
- 正仕様: [B66 Phase1 仕様 R2](ksql_b66_engine_library_phase1_spec.md)
- 背景評価: [B66 評価](ksql_b66_engine_library_evaluation.md)
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B66
- 手本: [B65 実装計画](ksql_b65_impl_plan.md)
- 実装分担: codex はファイル編集と自動検証まで。git 操作、差分レビュー、commit、branch、push、PR、tag、GitHub Release、npm publish はすべて Claude／ユーザー側で行う。codex sandbox では `.git` が拒否される前提とし、codex は `git` を実行しない。

## 1. 結論と段階マージ方針

B66 Phase1 は、既存の `execute(sql, client, options)` を別実装へ置き換えず、その外側に read-only の安全境界、安定 public DTO、browser readonly adapter、配布 entry を純加法で追加する。公開面は `@rex0220/kintone-sql-tools/engine` と UMD `window.ksql` version registry に限定し、既存 plugin／CLI／MCP／MCPB は従来 entry と client を使い続ける。

実装は次の9 Stepに分ける。

1. engine entry の import グラフ監査と entry 分割可否の確定
2. public DTO、`runQuery()`／`explainQuery()`、options、結果・error 正規化
3. parse allowlist と readonly client 射影による read-only 二重強制
4. browser `createReadonlyKintoneClient()`、BYO client、per-instance Cursor lifecycle
5. 検索打ち切りの常時 fail-closed
6. ESM／CJS／UMD／`.d.ts` build、package exports／files／prepack
7. version registry、2バージョン共存、global 副作用禁止
8. §8 受入テスト、bundle guard、全既存面の非回帰
9. public docs、evidence、v3.19.0 release 準備

Step 1 は後続全 Step の前提 gate である。監査または必要な entry 分割方針が Claude に承認されるまで Step 2 へ進まない。Step 2〜5 の source entry は Step 6 まで `package.json#exports` に載せず、二重強制と受入テストが揃う前の npm 公開を防ぐ。Step 6 でも publish はせず、Step 7〜9 の全 gate 後にだけ v3.19.0 の release 候補とする。

### 1.1 各 Step の共通 gate

各 Step は Claude が単独レビューし、独立 commit／必要なら独立 PR にできる単位とする。全 Step の末尾で次を必須とする。

1. `npm test` が全 green。`scripts/run-tests.mjs` の既存二段 runner をそのまま使い、通常 gate に Jest 引数を追加しない。
2. `npm run build` が成功し、既存 `build:plugin`、`build:cli`、`build:mcp`、`build:mcpb` が無回帰。
3. Step 固有の test／smoke と、影響面に対応する既存 smoke が成功する。
4. `src/parser/__tests__/__snapshots__/parser_compat.test.ts.snap` を含む既存 snapshot は無変更。B66 の public export／bundle baseline が snapshot を要する場合は B66 専用 fixture／snapshot を新設する。
5. 既存 plugin／CLI／MCP／MCPB の entry、bin path、runtime contract、生成物名を変えない。
6. Claude が対象差分、test output、smoke output、必要な実測 evidence をレビューし、Claude が commit する。codex は `git add`／`git commit` を含む git 操作を一切行わない。

### 1.2 engine 本体を変えない絶対条件

原則として次を変更しない。

- `src/execute.ts` の `execute()`、`executeParsedStatement()`、`wrapClientWithMetrics()`、既存 `KintoneClient`、SQL plan／result 意味論
- `src/parser/parser.ts`、`src/lexer/lexer.ts`、`src/types/ast.ts`
- `src/ui/kintoneClient.ts` の既存 `createKintoneClient()` と plugin の Cursor page lifecycle
- `src/cli/nodeKintoneClient.ts` と CLI／MCP の認証・route・mutation client

Step 1 の実測で仕様 §4.4 の read-path-only bundle がこの前提では成立しない場合だけ、必要な最小分割を Step 1 の判断事項として明示し、実装前に Claude の承認を得る。承認対象は機械的な entry／module 分割に限定し、SQL 意味論、parser AST、既存 `execute()` の公開 contract は変えない。Claude が既存 engine ファイルの分割を承認しない場合、仕様 §4.4 を満たせないため B66 を後続へ進めない。

## 2. 現行コードで確認した実装境界

### 2.1 `execute()` と public wrapper の境界

- `src/execute.ts:680-704` の `execute()` は parse、metrics client、検索打ち切り guard、statement 実行、metrics 付与を1入口で行う。
- `src/execute.ts:735-814` の `wrapClientWithMetrics()` は read 6メソッドだけでなく `postRecords`／`putRecords`／`deleteRecords` の遅延委譲 closure も必ず作る。したがって「writeメソッド不在」の検査対象は metrics wrapper 前の readonly client でなければならない。
- `src/execute.ts:816-831` の現行 search-abort wrapper は `SELECT`／`WITH`／`UNION` では warning collector として動く。B66 は既存挙動を変えず、public wrapper が渡す `getRecords()` 側で常時 error 化する。
- `src/execute.ts:881-943` の `executeParsedStatement()` は read と DML／IMPORT／batch系を同じ switch で扱う。public wrapper はこの router の前で fail-closed な再帰 allowlist を完了させる。
- `src/execute.ts:312-328` の `SelectResult` は `rows`、列名 `columns`、`rowCount`、optional `warnings`／`metrics` を持つ。B66 はこれをコピーして、小文字 `type: "query"`、`QueryColumn[]`、固定 `QueryMetrics` へ写像する。
- `src/core/sql.ts` に既存 `parseSqlStatement(sql, { import })` と `parseSqlStatements()` がある。B66 の分類は前者を IMPORT capability 付きで用い、AST／parser自体は公開しない。

### 2.2 browser client と Cursor state

- `src/ui/kintoneClient.ts:165-283` の `createKintoneClient()` は、records GET の raw `fetch`、app／field／settings／status の `kintone.api`、Cursor API、record mutation 3メソッドを1 objectにまとめる。
- 同 factory は `src/ui/kintoneClient.ts:166` で `installCursorPageLifecycle(window)`、Cursor 作成で `getCursorLeaseManager()` と `registerCursorHandle()` を使う。
- `src/api/cursorLeaseManager.ts:151-165` の `managers` は module-level host map、`src/ui/cursorPageLifecycle.ts:3-4` の `activeHandles`／`installed` も module-level singletonである。B66 browser adapter はこれらの singleton helperを importせず、`CursorLeaseManager` の instance、handle set、close処理を factory instance に閉じる。
- `src/execute.ts:834-863` には batch用の per-scope Cursor handle追跡があるが、単文 public queryの lifecycle APIではない。B66 wrapperは各 `runQuery()`／`explainQuery()` 呼出しの client projectionで handleを追跡し、成功・失敗の `finally` で自分が開いた handleだけを closeする。
- `src/api/kintoneCursor.ts` の `createKintoneCursorHandle()` は routeに束縛した idempotent close、release／quarantine hookを既に持つ。B66 browser adapterはこれを再利用し、page lifecycle listenerは登録しない。

### 2.3 build、package、smoke

- `build.mjs` は browser ES2020 IIFE の plugin、`build-cli.mjs` は Node 18 CJS、`build-mcp.mjs` は Node 18 CJS＋docs／version define、`build-mcpb.mjs` は既存 MCP bundle を `.mcpb` 化する。
- `package.json` は現在 `main`／`module`／`types`／`exports` を持たず、`files` は `dist-cli/`、`dist-mcp/`、`dist-mcpb/` と文書だけである。`prepack` も CLI／MCP／MCPB のみ。
- 既存全 build gate は `npm run build`。既存 smoke は `scripts/mcp-smoke.mjs`、`scripts/mcp-pack-smoke.mjs`、`scripts/mcp-kintone-smoke.mjs`、`scripts/mcpb-verify.mjs`。plugin browser実機は `docs/internal/evidence/` の evidenceを release gateとして扱う。
- `tsconfig.json` は CommonJS／`src` 全体向けであり、public declaration専用ではない。B66 は専用 `tsconfig.engine.json` から `emitDeclarationOnly` し、内部 importを残さない。

### 2.4 計画作成時の予備 import グラフ実測

2026-07-23 の現行 source、esbuild 0.27.5 で `src/execute.ts` を browser／ESM／ES2020、bundle、`write:false`、metafile有効、minifyなしで計測した。

| 項目 | 予備実測 |
|---|---:|
| 到達 input | 71 files |
| output | 849,438 bytes（unminified） |
| MCP instructions／`src/mcp/**`／docs／statement catalog | 0 |
| `zod`／`@modelcontextprotocol/sdk` | 0 |
| Node builtin／polyfill | 0 |
| DML／APPLY／IMPORT module | 多数到達 |

MCP／docs／zod／SDK／Node builtinの禁止群は現時点では引いていない。一方、`execute()` の単純 importは `apply*`、`dml*`、`import/*` を含む read-only でない実装まで到達するため、仕様 §4.4 の「read pathだけをbundle」は現状のままでは満たさない可能性が高い。この値は最終 bundle baselineではなく、Step 1 の最初に再現可能な監査scriptへ固定し、実際の `src/engine-library/index.ts` に対して再測定する。

## 3. Step 1 — engine entry の import グラフ監査

### 3.1 目的

仕様 §4.4 の最初の関門として、`execute()` の推移依存と、予定する engine public entry の tree-shaking後グラフを実測する。軽量 read-only bundleを既存 engine無改変で作れるか、最小 entry分割が必要かを確定するまで後続へ進まない。

### 3.2 対象ファイル

- 既存監査対象
  - `src/execute.ts`
  - `src/core/index.ts`
  - `src/core/sql.ts`
  - `src/parser/parser.ts`
  - `src/lexer/lexer.ts`
  - `src/types/ast.ts`
  - `src/engine/process.ts`
  - `src/converter/selectToKintone.ts`
  - `src/core/optimization/korderPlanner.ts`
  - `src/core/optimization/korderCursorExecutor.ts`
- 新規
  - `scripts/engine-import-graph.mjs`
  - `docs/internal/evidence/b66_engine_import_graph.md`
- 条件付き候補（Claude 承認前は変更しない）
  - `src/engine/readOnlyExecute.ts` または同等の dedicated read executor entry
  - `src/execute.ts` の read router委譲箇所

### 3.3 実装内容

1. `scripts/engine-import-graph.mjs` は esbuild `write:false`＋metafileで、少なくとも browser ESM／ES2020 と Node CJS／Node18 の2条件を測る。
2. MCP instructions、`src/mcp/**`、`docs/**`、statement catalog、`zod`、`@modelcontextprotocol/sdk`、CLI profile／credential、plugin UI／CSS／manifest、Node builtin、`Buffer`を exact allow/deny listで検査する。
3. source input一覧を read path、DML／APPLY／IMPORT、MCP／docs、platform固有に分類し、unminified／minified／gzip byte、top contributorsを evidenceへ残す。
4. 予定 entryが `execute()` をimportした場合のグラフと、read-only専用 entry候補のグラフを比較する。単なる禁止文字列の不在だけで「軽量」と判定しない。
5. 既存 engine無改変で read pathだけにtree-shakeできる場合は、その entry境界を確定する。
6. DML／APPLY／IMPORTが残る場合は、次の最小分割案をClaudeへ提示する。
   - parser／planner／read executorの実装は複製しない。
   - read routerを dedicated moduleへ機械的に抽出し、既存 `execute()` も同じ関数を呼ぶ。
   - `execute()` の引数、結果、error、metrics、cache、SQL意味論を変えない。
   - extraction前後の既存 SELECT／WITH／UNION／SHOW APPS／DESCRIBE／EXPLAIN testを同一fixtureで一致させる。
7. Claudeが既存 `src/execute.ts` の最小委譲変更を承認しない場合は、仕様 §4.4 未達としてB66を停止する。bundleへのDML混入を黙認して後続へは進まない。

### 3.4 gate

共通 gate（`npm test`全green、`npm run build`の4既存面無回帰、該当監査smoke、既存snapshot無変更、Claudeレビュー→Claude commit）に加え、`node scripts/engine-import-graph.mjs` 成功、予備実測の再現、forbidden 0、entry別のinput／minified／gzip値、DML／APPLY／IMPORT到達有無を evidence化する。必要なentry分割案または「分割不要」の根拠をClaudeがレビューし、Claudeが方針を承認してcommitするまでStep 2へ進まない。

### 3.5 Claude 確認観点

- 71 input／849,438 bytesの予備値が再現し、計測条件と分類が妥当か。
- 「forbidden 0」と「read path only」を混同していないか。
- entry分割が必要な場合、既存 `execute()`／parser／`KintoneClient` の意味論変更ではなく機械的抽出に限定されているか。
- engine本体変更を承認するか。承認しない場合にB66を停止する判断でよいか。

想定: **0.5〜1.0人日**。既存 engineの機械的抽出が承認された場合の追加工数は再見積り§13に含める。

## 4. Step 2 — public DTO、query API、options、結果・error 正規化

### 4.1 目的

内部型を1つも re-exportせず、仕様 §2／§6 の最小 public APIを専用source entryに実装する。Step 6までpackage subpathは開通しない。

### 4.2 対象ファイル

- 新規
  - `src/engine-library/index.ts`
  - `src/engine-library/publicTypes.ts`
  - `src/engine-library/errors.ts`
  - `src/engine-library/query.ts`
  - `src/engine-library/options.ts`
  - `src/engine-library/__tests__/publicApi.test.ts`
  - `src/engine-library/__tests__/queryResult.test.ts`
  - `src/engine-library/__tests__/errorMapping.test.ts`
- 参照のみ
  - `src/execute.ts` の `execute()`、`SelectResult`、`ExecuteMetrics`
  - Step 1で承認された dedicated read entry（必要な場合）

### 4.3 実装内容

- `ReadonlyKintoneClient` と6メソッドの parameter／result／Cursor／app／field／precision／process status専用DTOを定義する。内部型のalias、`extends`、conditional type、`import type`を公開 declarationへ残さない。
- `RunQueryOptions`、`QueryColumn`、`QueryMetrics`、`QueryResult`、`ExplainResult`、`CreateReadonlyKintoneClientOptions`、`KsqlEngineError`、`version`の公開面を仕様 §2と完全一致させる。
- `runQuery()` はread-only gate通過後の既存 SELECT resultをコピーし、全cellを`string`契約のまま、列順を`QueryColumn[]`へ、metricsを4項目へ写像する。0行でもcolumnsを保持する。
- `explainQuery()` は先頭 `EXPLAIN` の有無を正規化し、内部plan列を`lines`／`text`へ変換する。records GET／Cursor APIは0を維持する。
- `maxRecords`、`fetchParallel`は正のsafe integer、`cursorMaxActive`は1〜5、`onLimitReached`は`runQuery()`だけ、未知keyはruntimeで実行前拒否する。暗黙clampはしない。
- internal error classはre-exportせず、`PARSE_ERROR`、`READ_ONLY_VIOLATION`、`SEARCH_ABORTED`、`FETCH_LIMIT_EXCEEDED`、`CLIENT_ERROR`、`EXECUTION_ERROR`へcause付きで正規化する。message完全一致はtestしない。
- `version` はStep 6のbuild defineから固定注入し、test時はdev fixture値を使う。runtime変更可能なstateにしない。

### 4.4 gate

共通 gate（`npm test`全green、`npm run build`の4既存面無回帰、該当unit smoke、既存snapshot無変更、Claudeレビュー→Claude commit）に加え、Step 2の3 test、0行columns、全値string、metrics写像、EXPLAIN API 0、未知option／境界値、全error codeとcause保持を確認する。既存 `src/__tests__/execute.test.ts` と `src/__tests__/explain.test.ts` を回帰実行する。Claudeはpublic export一覧、内部型漏洩のないsource設計、error分類順をレビューしてcommitする。

### 4.5 Claude 確認観点

- §2の公開名以外をexportしていないか。
- internal `ExecuteResult`／AST／client／DML型がDTOへ漏れていないか。
- `CLIENT_ERROR` と `EXECUTION_ERROR` の分類がtransport shapeだけに過適合していないか。
- `runQuery()` と `explainQuery()` のresult unionを増やしていないか。

想定: **0.75〜1.25人日**。

## 5. Step 3 — parse allowlist と readonly client 射影の二重強制

### 5.1 目的

既存 engineを呼ぶ前の再帰statement allowlistと、writeメソッドを渡さないruntime client射影を独立に成立させる。片方のtest seamをbypassしてもmutation API 0、cleanな`READ_ONLY_VIOLATION`にする。

### 5.2 対象ファイル

- 新規
  - `src/engine-library/statementGuard.ts`
  - `src/engine-library/readonlyClient.ts`
  - `src/engine-library/__tests__/statementGuard.test.ts`
  - `src/engine-library/__tests__/readonlyProjection.test.ts`
  - `src/engine-library/__tests__/readonlyBypass.test.ts`
- 既存接続
  - `src/engine-library/query.ts`
- 参照のみ
  - `src/core/sql.ts`
  - `src/types/ast.ts`
  - `src/execute.ts:735-814` の `wrapClientWithMetrics()`

### 5.3 実装内容

- `parseSqlStatement(sql, { import: true })` で入力全体をparseし、空文／複文／余剰tokenは`PARSE_ERROR`にする。
- `runQuery()` はtop-level `SELECT`／`WITH`／`UNION`／`SHOW_APPS`／`DESCRIBE`だけを許す。`WITH`の全CTE bodyとmain、`UNION`の左右枝を再帰検査し、未知variantはdefault denyにする。
- `explainQuery()` は内側を`SELECT`／`WITH`／`UNION`だけに限定し、`EXPLAIN UPDATE`／`EXPLAIN IMPORT`を拒否する。
- INSERT／UPDATE／UPSERT／DELETE／REORDER／APPLY／IMPORT／VALIDATE ONLY、VALIDATE、temp、SET／DECLARE、ASSERT、batchを`READ_ONLY_VIOLATION`とし、engine実行0にする。
- BYO objectから6 readメソッドだけを新objectへbind付きで射影する。余分なwriteメソッド、prototype property、symbol、getterを実行clientへ渡さない。
- metrics wrapper前の射影済みclientにwrite 3メソッドがown／prototypeとも存在しないことをtest seamで確認する。
- allowlistを意図的にbypassするtestでは、明示write trapまたはwrapper境界の専用検出により、各write closureが`READ_ONLY_VIOLATION`となることを固定する。生の`TypeError`や一般`EXECUTION_ERROR`は許さない。

### 5.4 gate

共通 gate（`npm test`全green、`npm run build`の4既存面無回帰、該当DML guard smoke、既存snapshot無変更、Claudeレビュー→Claude commit）に加え、全read-only負例でengine実行0／mutation API 0、再帰WITH／UNIONと未来type fixtureのdefault deny、BYO余分property除去、3 write bypassのcleanな`READ_ONLY_VIOLATION`を確認する。parser既存snapshotは1 byteも変更しない。B66専用unitに加え、既存CLI／MCPのDML guard testを回帰実行する。Claudeは二境界が独立にtestされていることをレビューしてcommitする。

### 5.5 Claude 確認観点

- classifierがtop-levelだけでなくWITH／UNION／EXPLAIN内側を全再帰しているか。
- parse可能な非read文とmalformed SQLを別codeにしているか。
- structural typingだけに依存せずruntime射影しているか。
- bypass seamが実装詳細の自己証明ではなく、mutation call 0とpublic errorを観測しているか。

想定: **0.75〜1.25人日**。

## 6. Step 4 — browser readonly factory、BYO client、per-instance Cursor

### 6.1 目的

既存plugin factoryを公開せず、read routeだけを実装するbrowser adapterと正式BYO contractを追加する。Cursor状態をfactory／query instanceに閉じ、global listener／module singletonを持ち込まない。

### 6.2 対象ファイル

- 新規
  - `src/engine-library/browserClient.ts`
  - `src/engine-library/cursorScope.ts`
  - `src/engine-library/__tests__/browserClient.test.ts`
  - `src/engine-library/__tests__/cursorScope.test.ts`
  - `src/engine-library/__tests__/byoClient.test.ts`
- 既存接続
  - `src/engine-library/index.ts`
  - `src/engine-library/readonlyClient.ts`
  - `src/engine-library/query.ts`
- 再利用する既存read helper／型実装
  - `src/core/formFieldInfo.ts`
  - `src/core/processStatus.ts`
  - `src/core/numberPrecision.ts`
  - `src/core/searchAbortWarning.ts`
  - `src/api/kintoneCursor.ts`
  - `src/api/cursorLeaseManager.ts` の `CursorLeaseManager` classのみ
- 参照・非変更
  - `src/ui/kintoneClient.ts`
  - `src/ui/cursorPageLifecycle.ts`
  - `src/api/cursorLeaseManager.ts` の `getCursorLeaseManager()`／`managers`

### 6.3 実装内容

- records readは現行と同じGET URL長判定、長いqueryの`X-HTTP-Method-Override: GET`、request token、`X-Cybozu-Warning`検出を持つ。app／fields／settings／statusも現行routeとerror詳細を保つ。
- 返却objectに`postRecords`／`putRecords`／`deleteRecords`を実装しない。既存full `createKintoneClient()`はimport／exportせず、変更しない。
- factoryごとに`CursorLeaseManager` instance、active handle set、実効`cursorMaxActive`を所有する。`getCursorLeaseManager()`、`registerCursorHandle()`、`installCursorPageLifecycle()`を使わない。
- Cursor作成routeへget／deleteを束縛し、lease release／quarantineとidempotent closeを維持する。各queryのsuccess／errorで`finally` closeする。
- instance内capacity超過はCursor作成前にfail-closed。host合算超過のAPI rejectはretry／fallbackせず`CLIENT_ERROR`。
- BYO guest／proxy fixtureのrouteはprojectionとscope wrapperを通しても失わない。認証／retry／tenant routeはBYO責務のままとする。

### 6.4 gate

共通 gate（`npm test`全green、`npm run build`の4既存面無回帰、該当browser/Cursor smoke、既存snapshot無変更、Claudeレビュー→Claude commit）に加え、browserとBYOの同一fixture結果、guest route保持、KORDER Cursorのsuccess／nextPage error／query error／close error、idempotent close、instance分離、capacity超過をtestする。`window.addEventListener`のpagehide／beforeunload登録0、`kintone.api` identity不変を確認する。既存 `src/ui/__tests__/kintoneClient.test.ts`、`cursorPageLifecycle.test.ts`、`src/api/__tests__/cursorLeaseManager.test.ts`、`kintoneCursor.test.ts`を回帰実行する。Claudeは既存singletonをpublic entryがimportしていないことをレビューしてcommitする。

### 6.5 Claude 確認観点

- current browser read routeとの意味差がないか。
- `CursorLeaseManager` classのinstance利用とmodule-level `managers`利用を混同していないか。
- query `finally`が元から存在するBYO handleまで勝手にcloseせず、そのqueryが開いたhandleだけを対象にしているか。
- close failureが元のquery errorを不適切に上書きしないか。

想定: **0.75〜1.25人日**。

## 7. Step 5 — 検索打ち切り常時 fail-closed

### 7.1 目的

browser／BYOの全read queryで`searchAborted: true`を即時`SEARCH_ABORTED`へ変換し、部分行・warningを返さない。既存pluginの部分結果＋warning挙動は変更しない。

### 7.2 対象ファイル

- 既存B66 source
  - `src/engine-library/readonlyClient.ts`
  - `src/engine-library/errors.ts`
  - `src/engine-library/query.ts`
- 新規
  - `src/engine-library/__tests__/searchAbort.test.ts`
- 回帰参照
  - `src/__tests__/searchAbort.execute.test.ts`
  - `src/ui/__tests__/kintoneClient.test.ts`
  - `src/api/__tests__/fetchAll.test.ts`

### 7.3 実装内容

- 6メソッド射影後の`getRecords()`に共通guardを被せ、browser／BYOを同じ経路にする。
- `searchAborted: true`を見た時点でpublic `KsqlEngineError`の`SEARCH_ABORTED`をthrowし、内部 `execute()` へpartial pageを返さない。
- simple SELECT、JOIN、GROUP BY、WITH、UNION、subquery、KLIKEを代表するtest matrixで結果行0を固定する。
- Cursor pathのAPI error／capacity errorとrecords検索打ち切りを混同しない。

### 7.4 gate

共通 gate（`npm test`全green、`npm run build`の4既存面無回帰、該当search-abort smoke、既存snapshot無変更、Claudeレビュー→Claude commit）に加え、browser／BYO × simple／JOIN／GROUP BYで`SEARCH_ABORTED`、result 0、cause保持を確認する。既存plugin `execute()` のsimple SELECT warning testとDML fail-closed testは無変更でpassさせ、UX差がB66 entry内だけであることを証明する。Claudeは常時fail-closedが仕様R2の確定事項として実装され、Phase2 opt-inを先行追加していないことをレビューしてcommitする。

### 7.5 Claude 確認観点

- guardがBYOにも必ず適用されるか。
- partial rowsを一度でもpublic resultへmaterializeしていないか。
- 既存plugin surfaceをhard errorへ変えていないか。

想定: **0.25〜0.5人日**。

## 8. Step 6 — engine build、declaration、package subpath

### 8.1 目的

同じpublic entryからESM／CJS／UMDを生成し、専用public sourceから`.d.ts`を生成する。npm `./engine`だけを追加し、root importと既存bin／distを変えない。

### 8.2 対象ファイル

- 新規
  - `build-engine.mjs`
  - `tsconfig.engine.json`
  - `src/engine-library/umd.ts`
  - `scripts/engine-bundle-guard.mjs`
  - `scripts/engine-declaration-smoke.mjs`
  - `scripts/engine-pack-smoke.mjs`
  - `scripts/fixtures/engine-consumer-esm/`
  - `scripts/fixtures/engine-consumer-cjs/`
  - `scripts/fixtures/engine-consumer-types/`
- 既存
  - `package.json`
  - `package-lock.json`（script／files変更に伴うlock metadataのみ。v3.19.0化はStep 9）
- 出力
  - `dist-engine/index.mjs`
  - `dist-engine/index.cjs`
  - `dist-engine/ksql-engine.umd.js`
  - `dist-engine/index.d.ts`
  - `dist-engine/meta/*.json`

### 8.3 実装内容

- esbuildでESM browser／neutral ES2020、CJS Node18、UMD用IIFEを同一public entryから生成する。`__KSQL_ENGINE_VERSION__`を`package.json#version`からdefineする。
- `tsc -p tsconfig.engine.json --emitDeclarationOnly`でpublic declarationだけを生成する。
- `package.json#exports["./engine"]`へtypes／import／requireを追加し、root exportは追加しない。
- `files`へ`dist-engine/`を追加し、既存3 dist、README、LICENSE、package.jsonを維持する。
- `build:engine`、`engine:bundle-guard`、`engine:declaration-smoke`、`engine:pack-smoke`を追加する。`build`は既存4 buildにengineを加え、`prepack`はCLI／MCP／MCPB／engine／declarationを生成する。
- bundle metafile、文字列guard、Node builtin import guard、forbidden module guardを自動化する。初回minified／gzip値はbaselineとして記録し、恣意的な事前上限は置かない。
- declarationから`src/execute.ts`、AST、parser、MCP、DML型へのimportが0であることを検査する。
- `npm pack`したtarballを一時consumerへinstallし、ESM import、CJS require、NodeNext／Node16 typecheck、既存bin起動、既存3 dist＋engine4成果物を検査する。

### 8.4 gate

共通 gate（`npm test`全green、`npm run build`の既存4面＋engine無回帰、該当build/pack smoke、既存snapshot無変更、Claudeレビュー→Claude commit）に加え、`npm run build:engine`、bundle guard、declaration smoke、engine pack smokeを通す。既存bin pathと既存package内容が欠落しないことを確認する。public `.d.ts` export snapshotはB66専用とする。Claudeはexports条件順、NodeNext／Node16解決、prepack順序、tarball内容、metafile baselineをレビューしてcommitする。

### 8.5 Claude 確認観点

- `./engine`以外のroot resolutionを意図せず変更していないか。
- ESM／CJS／UMDでpublic名、version、意味論が同じか。
- declarationが内部pathを参照していないか。
- engine build追加が既存MCP docs embedding、plugin pack、MCPB入力順を変えていないか。

想定: **0.75〜1.25人日**。

## 9. Step 7 — version registry、複数版共存、global 副作用禁止

### 9.1 目的

仕様 §4.5 のUMD registry、public `version`、per-instance状態、同版重複、非registry既存global、独立Cursor leaseを固定する。

### 9.2 対象ファイル

- 既存B66 source
  - `src/engine-library/umd.ts`
  - `src/engine-library/index.ts`
  - `src/engine-library/browserClient.ts`
  - `src/engine-library/cursorScope.ts`
- 新規
  - `src/engine-library/versionRegistry.ts`
  - `src/engine-library/__tests__/versionRegistry.test.ts`
  - `scripts/engine-umd-smoke.mjs`
  - `scripts/fixtures/engine-umd-host/`

### 9.3 実装内容

- `window.ksql`を`{ versions, get }` registryとして初期化し、`versions[version]`に凍結したpublic API objectを登録する。`get()`は完全一致だけを返す。
- 別versionを上書きせず、同version再loadは先着entryを維持して`console.warn` 1回、非registryの既存`window.ksql`は上書きせず初期化errorでfail-closed。
- npm／CJS／ESM／UMDの`version`とregistry keyをartifact内で一致させる。
- Node `vm`または同等のbrowser fixtureで2つのversion defineを持つUMDを順不同loadし、両entry、選択、同版duplicate、非registry衝突を検査する。
- 2版でclient／Cursor queryを動かし、active handles、lease snapshot、capacity変更が版間で伝播しないことを確認する。
- `window.addEventListener`のpagehide／beforeunload登録数、`kintone.api` identity、global property差分をload前後で比較する。
- host合算超過のmock API rejectは`CLIENT_ERROR`、retry 0、fallback 0、partial result 0とする。

### 9.4 gate

共通 gate（`npm test`全green、`npm run build`の4既存面＋engine無回帰、該当UMD smoke、既存snapshot無変更、Claudeレビュー→Claude commit）に加え、`node scripts/engine-umd-smoke.mjs`で2版順不同、同版duplicate、非registry衝突、global listener 0、monkey-patch 0、per-instance分離をpassさせる。engine bundle guardとpack smokeを再実行する。Claudeはregistryの先着保持、exact get、version固定、共有coordinatorをPhase1へ持ち込んでいないことをレビューしてcommitする。

### 9.5 Claude 確認観点

- UMD load順による後勝ち上書きがないか。
- registry自体をruntime service／共有lease coordinatorとして使っていないか。
- global副作用検査が単なる文字列検索でなくruntime観測を含むか。
- 3コピー以上は通常`cursorMaxActive: 1`という運用制約をdocsへ引き渡せる状態か。

想定: **0.5〜1.0人日**。

## 10. Step 8 — §8 受入テスト、bundle guard、全非回帰

### 10.1 目的

仕様 §8 の正例、read-only負例、境界、型／bundle、2version共存、既存4面非回帰をrelease候補相当のmatrixで完了する。

### 10.2 対象ファイル

- 新規
  - `src/engine-library/__tests__/acceptance.test.ts`
  - `src/engine-library/__tests__/readonlyNegativeMatrix.test.ts`
  - `src/engine-library/__tests__/boundaryErrors.test.ts`
  - `scripts/engine-browser-smoke.mjs` または既存browser harnessに対応するB66 fixture
  - `docs/internal/evidence/b66_engine_acceptance.md`
  - `docs/internal/evidence/b66_engine_browser_smoke.md`
- 更新
  - `scripts/engine-bundle-guard.mjs`
  - `scripts/engine-pack-smoke.mjs`
  - `scripts/engine-umd-smoke.mjs`
  - 必要に応じて `scripts/mcp-smoke.mjs` の非回帰assertionのみ
- 既存回帰
  - `scripts/mcp-smoke.mjs`
  - `scripts/mcp-pack-smoke.mjs`
  - `scripts/mcpb-verify.mjs`
  - `src/__tests__/execute.test.ts`
  - `src/__tests__/explain.test.ts`
  - `src/__tests__/searchAbort.execute.test.ts`
  - `src/ui/__tests__/kintoneClient.test.ts`
  - KORDER／WITH／UNION／JOIN／aggregate関連既存test

### 10.3 実装内容

- 正例
  - browser factoryとBYOでSELECT JOIN GROUP BY、WITH、UNION ALL、SHOW APPS、DESCRIBE。
  - KORDER Cursorのsuccess／error双方でclose。
  - guest route BYO。
  - EXPLAINはrecords／Cursor 0、field metadataだけ許可。
  - ESM／CJS／UMDのpublic名、version、結果一致。
- read-only負例
  - INSERT／UPDATE／UPSERT／DELETE／REORDER／APPLY／IMPORT／VALIDATE ONLY。
  - EXPLAIN UPDATE／IMPORT。
  - VALIDATE、CREATE／DROP TEMP、SET／DECLARE、ASSERT、複文、future type。
  - browser元clientとBYO射影clientのwrite 3メソッド不在、bypass時mutation 0。
- 境界
  - malformed=`PARSE_ERROR`、非read=`READ_ONLY_VIOLATION`。
  - search aborted全shape=`SEARCH_ABORTED`、row 0。
  - maxRecords、truncate許可simple、完全入力plan fail-closed。
  - client／executor error分類とcause。
  - option未知key、非整数、範囲外。
- 配布
  - declaration export snapshot。
  - forbidden module／Node builtin／embedded docs／catalog不在。
  - tarballに既存bin／3 dist／engine 4成果物。
  - UMD 2version、duplicate、非registry、global副作用、per-instance lease。

### 10.4 gate

1. 共通 gate。
2. `npm test` 全green、既存snapshot無変更。
3. `npm run build` でplugin／CLI／MCP／MCPB／engine全成功。
4. `npm run mcp:smoke`、`npm run mcp:pack-smoke`、`node scripts/mcpb-verify.mjs`。
5. engine bundle／declaration／pack／UMD smoke全成功。
6. build済みCLIの`--help`／`--version`／代表read-only dry-run、build済みMCPのquery／EXPLAIN／DML guardを無回帰確認。
7. Firefox／Chromeで同じUMDまたはnpm取込browser fixtureを実行し、正例、search abort、Cursor close、2version、listener 0をevidence化する。Node testでbrowser release gateを代替しない。
8. Claudeが受入ID対応表、全output、bundle baseline、両browser evidenceをレビューし、Claudeがcommitする。

### 10.5 Claude 確認観点

- 仕様 §8の全箇条書きがtestまたは実機evidenceへ1対1で対応するか。
- browser factoryとBYOの片方だけで済ませていないか。
- `npm test`／Node smokeをFirefox／Chrome実機の代替にしていないか。
- bundle guardがStep 1のimport graph方針を継続して守っているか。

想定: **0.75〜1.25人日**。

## 11. Step 9 — docs、evidence、v3.19.0 release 準備

### 11.1 目的

実装済みpublic API、全値string、read-only安全境界、検索打ち切りUX、Cursor共存運用、配布方法を公開文書とrelease metadataへ同期する。

### 11.2 対象ファイル

- 新規
  - `docs/ksql_engine_library.md`
- 更新
  - `README.md`
  - `CHANGELOG.md`
  - `docs/ksql_issue_tracker.md`
  - `docs/internal/ksql_b66_engine_library_phase1_spec.md`（実装完了status／実測baselineのみ。仕様意味論は変更しない）
  - 本計画 `docs/internal/ksql_b66_impl_plan.md`
  - `docs/internal/evidence/b66_engine_import_graph.md`
  - `docs/internal/evidence/b66_engine_acceptance.md`
  - `docs/internal/evidence/b66_engine_browser_smoke.md`
  - `package.json`
  - `package-lock.json` 先頭2箇所
  - `prod/manifest.json`
  - `release/VERSION.txt`
  - `release/README.txt`
  - release用plugin／MCP／MCPB成果物（Claude／ユーザー作業）

### 11.3 実装内容

- `docs/ksql_engine_library.md` にESM／CJS／UMD使用例、public API、全cell string、BYO contract、error code、options、read-only拒否一覧、search abort常時hard error、Cursor close、複数copy運用を記載する。
- UMD consumerは必ず`window.ksql.get("3.19.0")`でexact versionを選ぶ。npm取込可能なpluginはnpm bundleを優先する。
- 独立copyの`cursorMaxActive`合計を5以下、3copy以上は通常1、第三者plugin込みでは合算保証不能と明記する。
- READMEは最小導線、CHANGELOGと台帳はv3.19.0の純加法、Phase2対象外、evidenceを同期する。
- package／lock／plugin manifest／release VERSIONを3.19.0へ揃える。public `version`、UMD key、npm tarball、plugin zip内manifest、MCP server version、MCPB manifestの一致を検査する。
- 初回bundleのminified／gzip値をevidenceへ記録し、以後の回帰baselineとして採用する。数値は実測前に文書へ推測記入しない。
- tag、GitHub Release、npm publishはユーザー作業。codexはrelease用git操作を行わない。

### 11.4 gate

共通 gate（`npm test`全green、`npm run build`の4既存面＋engine無回帰、Step 8の全smoke、既存snapshot無変更、Claudeレビュー→Claude commit）を3.19.0 release candidateで再実行する。package／lock／manifest／public version／UMD key／MCP／MCPB／release file／zip内manifest／npm pack内容を一致させる。public docsのexampleをpack済みESM／CJS／UMDで実行する。Firefox／Chrome evidenceが欠ける場合はrelease不可。Claudeがdocsとartifactをレビューしてcommit／PRし、tag／GitHub Release／npm publishはユーザーが行う。

### 11.5 Claude 確認観点

- 全値stringとsearch abort hard errorを利用者が見落とさない配置か。
- UMD exact version選択とCursor合算運用が明記されているか。
- `./engine`追加以外のroot／bin contractを変えていないか。
- 3.19.0が全artifactとpublic `version`で一致するか。
- Phase2のDML client／`runMutation()`／partial-on-abort opt-inを先行公開していないか。

想定: **0.5〜0.75人日**（tag／Release／npm publishのユーザー作業を除く）。

## 12. 段階マージ順と依存関係

| 順 | 独立レビュー単位 | 開く能力 | merge時の安全境界 |
|---:|---|---|---|
| 1 | import graph／entry判断 | 実現可能性だけ確定 | Claude承認まで後続停止 |
| 2 | public DTO／wrapper内部実装 | stable envelope | package export未開通 |
| 3 | read-only二重強制 | statement／client安全境界 | package export未開通 |
| 4 | browser／BYO／Cursor | transport供給 | singleton／global副作用なし |
| 5 | search abort | public常時fail-closed | 既存plugin UX不変 |
| 6 | build／types／pack | `./engine` artifact生成 | publishしない |
| 7 | version共存 | UMD registry／2版分離 | exact version／先着保持 |
| 8 | acceptance／実機 | release可否の証拠 | 両browser必須 |
| 9 | docs／3.19.0 | release candidate | publishはユーザーのみ |

Step 2〜5はsource-levelにmergeできるが、Step 6までnpm public subpathを開かない。Step 6のartifactもStep 7／8の共存・受入gateが完了するまでpublishしない。

## 13. 再見積り

| Step | 領域 | 人日 |
|---:|---|---:|
| 1 | import graph監査／entry分割判断 | 0.5〜1.0 |
| 2 | DTO／query API／error | 0.75〜1.25 |
| 3 | allowlist／readonly射影／bypass | 0.75〜1.25 |
| 4 | browser／BYO／per-instance Cursor | 0.75〜1.25 |
| 5 | search abort常時fail-closed | 0.25〜0.5 |
| 6 | build／declaration／exports／pack | 0.75〜1.25 |
| 7 | version registry／global guard | 0.5〜1.0 |
| 8 | acceptance／browser／全非回帰 | 0.75〜1.25 |
| 9 | docs／v3.19.0 release準備 | 0.5〜0.75 |
| **基本合計** | **既存 engine 無改変で成立する場合** | **5.5〜9.5** |
| 条件付き追加 | Step 1でread routerの機械的抽出が必要な場合 | +1.5〜3.0 |
| **最大合計** | **抽出承認＋全受入まで** | **7.0〜12.5** |

仕様R2の4〜7人日より増えた理由は、予備実測でdirect `execute()` bundleがread path以外のDML／APPLY／IMPORT moduleまで到達すること、Step 1を独立停止gateにしたこと、UMD 2versionと両browser実機を独立release gateとして見積もったことである。Claudeが既存 engineの機械的抽出を不要と判断できる実測根拠が得られれば基本合計へ戻る。

## 14. 着手前に Claude 確認が要る点

仕様上の意味論はR2で確定済みであり、再選択しない。着手前のClaude確認は次に限定する。

1. **最重要:** Step 1の予備実測（71 input、849,438 bytes、指定forbidden 0だがDML／APPLY／IMPORT到達）を踏まえ、仕様 §4.4 のread-path-onlyを満たすentry分割監査を最初の停止gateにすること。
2. Step 1でtree-shakingだけでは不足した場合、`src/execute.ts`からread routerを機械的に抽出し、既存 `execute()`も同じ実装へ委譲する最小変更を許可するか。許可しない場合はB66を停止すること。
3. 9 Stepのcommit分割と、Step 6までpackage exportを開かず、Step 8両browser gateまでpublishしない順序。
4. public DTOの専用directoryを`src/engine-library/`、buildを`build-engine.mjs`／`tsconfig.engine.json`、成果物を`dist-engine/`とする配置。
5. browser readonly adapterが既存 `createKintoneClient()`をimportせず、`CursorLeaseManager` classだけをper-instance利用し、page lifecycle listenerを登録しない境界。
6. `CLIENT_ERROR`／`EXECUTION_ERROR`の分類とbypass時`READ_ONLY_VIOLATION`の検出方式。生TypeErrorのmessage一致に依存しないこと。
7. 初回bundleは実測値をbaselineにし、v3.19.0では恣意的な容量上限を置かないこと。
8. Firefox／ChromeのB66 browser fixture実行方法と、UMD 2versionをrelease evidenceとして必須にすること。
9. 再見積りを基本5.5〜9.5人日、機械的抽出が必要なら合計7.0〜12.5人日とすること。

## 15. 最終要約

1. Step 1はengine entryのimport graph実測であり、後続へ進む前の必須停止gateである。予備実測では指定forbiddenは0だが、direct `execute()`はDML／APPLY／IMPORTまでbundleする。
2. 実装はpublic wrapper、read-only二重強制、browser／BYO、search abort、build／types、version共存、受入、docs／releaseの順に9 Stepでmergeする。
3. 各Step末で`npm test`全green、既存plugin／CLI／MCP／MCPB build無回帰、該当smoke、既存snapshot無変更、Claudeレビュー後のClaude commitを必須にする。codexはgit操作をしない。
4. `src/execute.ts`／parser／既存clientは原則変更しない。Step 1で最小分割が不可避と判明した場合だけClaude判断を仰ぎ、未承認のまま実装しない。
5. 再見積りは基本5.5〜9.5人日。read routerの機械的抽出が必要なら7.0〜12.5人日である。

## 16. Claude レビュー（実装計画）

2026-07-23・Claude レビュー。**承認**。9 Step・各 Step gate（npm test 全 green／既存 build 4面無回帰／snapshot 無変更／Claude レビュー→Claude commit・codex は git 非実行）・Step 1 停止 gate・code 裏取り（execute.ts:680-704/735-814・cursorLeaseManager.ts:151-165・cursorPageLifecycle.ts:3-4 等）・エンジン非改変原則は妥当で、そのまま着手できる。以下は着手時に反映する指摘。

1. **【重要・再フレーム】Step 1 の判断を「抽出 or 停止」の二択から3択へ。** 予備実測で `execute()` が DML/APPLY/IMPORT を bundle する（指定 forbidden は 0）。ここで §3.3.7／§14.2 は「機械抽出を Claude が承認しなければ B66 停止」としているが、**§4.4 の read-path-only は安全要件ではなくサイズ/品質目標**である（read-only の安全性は §3 の二重強制＝parse allowlist＋書込みメソッド無し client で保証され、bundle に DML コードが残っても実行不能な dead code）。したがって選択肢は3つ:
   - **A（既定候補）: DML 同梱のまま出荷し、§4.4 を「MCP/docs/zod/catalog/Node builtin を除外（達成済み）／コア executor の DML パスは当面残置・クリーン抽出は将来最適化」に緩和する。** エンジン無改変・工数 5.5〜9.5 人日・安全性は不変。
   - **B: read router を機械抽出（execute() は委譲）＝§4.4 完全達成・+1.5〜3.0 人日・execute.ts に振る舞い保存の最小変更。** 実測 gzip 肥大が許容不可のときのみ。
   - **C: 停止。** A が実行可能なので原則採らない。
   - Step 1 は A（execute() ベース）と B（read-only 専用 entry 候補）双方の **minified/gzip 実測値と差分**を出し、オーナーが「肥大が許容できるか」をデータで A/B 判断する。「B か停止」に狭めない。
2. **【小】B を採る場合は Step 1.5 として独立化**し、execute() 既存全 test が fixture 完全一致（byte 一致）で回帰することを gate にする（計画 §3.3.6 が意図する内容の明示）。
3. **【小・既に計画内】** Step 1 の A/B グラフ比較（§3.3.4）・extraction 制約（§3.3.6）・両 browser evidence 必須（§10.4-7）は妥当。維持する。

**着手方針**: Step 1 から順に進め、Step 1 の実測後に A/B/C をオーナー判断（Claude 推奨＝肥大が gzip で数十 KB 程度なら A、明確に大きければ B）。それ以外の 14 確認点（§14）は計画どおりで着手可。

### 16.1 Step 1 完了・判断（2026-07-23）

- **監査完了**（[evidence](evidence/b66_engine_import_graph.md)・`scripts/engine-import-graph.mjs`＋`scripts/engine-read-floor-probe.ts`）。**forbidden 群（MCP/docs/catalog/zod/SDK/Node builtin）は全条件 0**。A（execute() 同梱）browser 449,713 B min / 120,556 B gzip・71 inputs（うち 38 が DML/APPLY/IMPORT 到達）。B floor 190,029 B min / 47,593 B gzip・34 inputs。A−B floor ≈73 KB gzip（楽観上限）・DML 専用死にコード独立寄与 ≈31 KB gzip（現実的削減量）。`npm test` 3,025 green・build 4面 PASS・src 無変更。
- **オーナー判断＝A（DML 同梱で出荷・§4.4 緩和）。** read-only の安全性は §3 二重強制で保証・DML は実行不能な dead code。read router 機械抽出（B）は core execute() を触るためライブラリ採用実証後の fast-follow（v3.20.0 候補）とする。spec §4.4 に緩和を反映済み。
- **→ Step 2（public DTO＋runQuery/explainQuery）へ進む。** 以後 §3.3.7 の「B か停止」は「A 採用」で解消。エンジン本体は無改変を貫く。

### 16.2 Step 9 完了（2026-07-24）

- `docs/ksql_engine_library.md` を公開し、ESM/CJS/UMD、public API/型、全cell string、BYO 6 read method、guest/proxy責務、error/options、read-only拒否、search abort hard error、Cursor close、複数copy運用を記載。UMD は `window.ksql.get("3.19.0")` の exact 選択を必須化。
- package/lock/prod manifest/release metadata/CHANGELOG を 3.19.0 へ同期し、`npm run build` で plugin/CLI/MCP/MCPB/engine を全面再生成。release の plugin zip、`ksql-mcp.mcpb`、`ksql-mcp.js` を同じ候補から更新。
- `npm test` は 145 suites / 3,184 tests PASS、snapshot 21件不変。MCP smoke/pack、MCPB verify、engine bundle/declaration/pack/UMD、pack 済み ESM/CJS/UMD docs 例は全 PASS。
- 初回 production bundle baseline: ESM 444,578 B min / 119,684 B gzip、CJS 445,113 B / 119,990 B、UMD 445,605 B / 120,031 B。全 forbidden 0。
- Step 8 の Firefox/Chrome gate は 3.18.0 build で PASS 済み。3.19.0 の実装差は版数 metadata と docs/release preparation のみで、engine/plugin source意味論は不変。再実行判断の材料として browser evidence に明記。
