# B49 MCP read-only metadata API 実装計画 R1

- ステータス: **実装計画 R1・Claude レビュー待ち**（2026-07-21）
- 正本仕様: [ksql_b49_mcp_readonly_metadata_api_spec.md](ksql_b49_mcp_readonly_metadata_api_spec.md) R2（Claude Approved）
- 対象リリース: **v3.9.0 / minor、B43 と同梱**
- 制約: 本文書は計画のみであり、コード実装、version bump、成果物生成、commit、tag、GitHub Release 作成を行わない。
- 実装 gate: 各 Phase / Subphase を `Codex 実装 -> 対象テスト（修正前 fail / 修正後 pass）-> Claude レビュー -> 指摘修正` の独立単位とする。前単位の Claude Approved 後に次へ進む。
- 決定の扱い: R2 の D1〜D13（[spec:626](ksql_b49_mcp_readonly_metadata_api_spec.md#L626)-[644](ksql_b49_mcp_readonly_metadata_api_spec.md#L644)）は確定事項であり、本計画では reopen しない。

## 1. 結論

B49 は SQL / core / plugin を変更せず、Node / MCP に閉じた次の経路で実装する。

```text
MCP strict discriminated union
  -> createKintoneMetadataRuntime（既存 app/profile/token resolver を共有）
  -> RequestGate.runReadOnly
  -> KintoneMetadataReader.getMetadata(AllowedMetadataRequest)
  -> 単一 resource mapper（固定 path / parameter / preview / auth capability）
  -> 共有 Node transport（固定 GET、2 MiB streaming cap）
  -> raw parsed object + responseBytes
  -> type: "KINTONE_METADATA" の audit wrapper
  -> toToolResult（text と structuredContent）
```

read-only は schema と Node mapper/reader の二層で強制する。schema を直接迂回する unit test でも、HTTP method、URL/path、query key を caller が供給できず、初期8 resource 以外は fetch 0 回になることを最重要 gate とする。

P1 は責務とテスト量が大きいため、純粋 mapper を P1a、transport / reader を P1b に分ける。P2 は resolver/routing、P3 は MCP surface、P4 は smoke / 全回帰である。P5 は独立 release phase を設けず、B43 計画 Phase 7c へ委譲するラベルだけとする。

## 2. 現行コードの裏取りと正確な挿入点

### 2.1 core interface は変更禁止

`KintoneClient` は records の read/cursor/mutation と、正規化済み `getApps` / `getFields` / `getNumberPrecision` / `getProcessStatuses` を必須契約に持つ（[execute.ts:179](../../src/execute.ts#L179)-[198](../../src/execute.ts#L198)）。特に metadata に近い現行部分は次である。

```ts
getApps: () => Promise<KintoneAppInfo[]>;
getFields: (appId: number) => Promise<KintoneFieldInfo[]>;
getNumberPrecision: (appId: number) => Promise<NumberPrecision>;
getProcessStatuses: (appId: number) => Promise<KintoneProcessStatuses>;
```

B49 はこの interface に必須・optional のどちらも追加しない。`src/execute.ts`、core export、plugin adapter、既存 mock 群は変更対象ではなく、TypeScript build で「mock 更新不要」を非回帰確認する。

### 2.2 Node transport と connection factory

現行 `createNodeKintoneClient` は host 正規化と通常/guest の `apiBasePath` を内部で作り（[nodeKintoneClient.ts:47](../../src/cli/nodeKintoneClient.ts#L47)-[54](../../src/cli/nodeKintoneClient.ts#L54)）、`requestJsonResponse` が token/userpass、timeout、fetch、kintone error 化を担う（[nodeKintoneClient.ts:56](../../src/cli/nodeKintoneClient.ts#L56)-[126](../../src/cli/nodeKintoneClient.ts#L126)）。成功時は現在 `res.json()` を無制限に読む（同 [121](../../src/cli/nodeKintoneClient.ts#L121)-[124](../../src/cli/nodeKintoneClient.ts#L124)）。body だけを返す helper は [nodeKintoneClient.ts:128](../../src/cli/nodeKintoneClient.ts#L128)-[133](../../src/cli/nodeKintoneClient.ts#L133) である。

P1b の挿入点は `src/cli/nodeKintoneClient.ts:47-133`。内部 `createNodeKintoneConnection` を切り出し、既存 export `createNodeKintoneClient(baseUrl, tokenResolver)` は `connection.client` を返す互換 wrapper として残す。connection は core client と Node-only metadata reader に認証、base path、timeout/error transport を共有させる。既存 record/cursor client の success body に B49 の 2 MiB cap を誤適用しない。

### 2.3 Node-only allowlist / reader

新規候補 `src/node/kintoneMetadata.ts` に次を単一集約する。

- `AllowedMetadataRequest` discriminated union、8 resource 定数、`Lang`。
- resource ごとの production/preview path fragment、`lang` 可否、preview 可否、auth capability。
- resolved physical app ID から `URLSearchParams` だけで query を作る pure mapper。
- `KintoneMetadataReader.getMetadata(request)`。入力に URL/path/endpoint/method/headers/body/free-form query/`RequestInit` は含めない。
- reader 内の transport invocation はコード上常に `{ method: "GET" }`。未知 resource / parameter mismatch / `app + preview:true` / `customize + token` は fetch 前に fail-closed。
- raw response object、実読取 `responseBytes`、audit 用 endpoint/environment/params を返すが、raw cache は持たない。

endpoint switch を `src/mcp` や runtime に複製しない。MCP schema の resource enum はこの Node constants から構築するが、MCP 用 Zod branch と Node mapper の検査は独立して残す。

### 2.4 runtime / resolver / RequestGate

`resolveSqlContext` は config snapshot、default/explicit profile、LAPP binding、physical app policy、source-aware `cacheContext` を解決する（[runtime.ts:99](../../src/node/runtime.ts#L99)-[130](../../src/node/runtime.ts#L130)）。token 解決は logical source を single-token fallback へ逃がさない（[runtime.ts:133](../../src/node/runtime.ts#L133)-[172](../../src/node/runtime.ts#L172)）。現行 runtime は app ID から profile/client/physical ID を route する（[runtime.ts:369](../../src/node/runtime.ts#L369)-[418](../../src/node/runtime.ts#L418)）。

`createKsqlRuntime` の config/auth/client 組立は [runtime.ts:215](../../src/node/runtime.ts#L215)-[355](../../src/node/runtime.ts#L355)、global gate 接続は [runtime.ts:421](../../src/node/runtime.ts#L421)-[439](../../src/node/runtime.ts#L439) にある。GET retry の本体は `RequestGate.runReadOnly`（[requestGate.ts:106](../../src/api/requestGate.ts#L106)-[119](../../src/api/requestGate.ts#L119)）、対象は 408/429/502/503/504、Abort/Timeout、network failure だけである（[requestGate.ts:41](../../src/api/requestGate.ts#L41)-[55](../../src/api/requestGate.ts#L55)）。

P2 は `src/node/runtime.ts:99-130,133-172,215-355,369-439` の内部 primitive を共有/必要最小限抽出し、Node-only `createKintoneMetadataRuntime` を追加する。`KsqlRuntime.client` への optional method/cast は使わない。metadata runtime は resolved source app、physical app ID、binding profile、cacheContext、reader を明示的に返し、reader call を process-global `runReadOnly` へ接続する。

### 2.5 MCP schema / tool / result

現行 MCP dependency seam は `createRuntime` と executor だけである（[tools.ts:68](../../src/mcp/tools.ts#L68)-[79](../../src/mcp/tools.ts#L79)）。factory は既定 runtime を選ぶ（[tools.ts:483](../../src/mcp/tools.ts#L483)-[490](../../src/mcp/tools.ts#L490)）。通常 query の runtime/executor 接続は [tools.ts:705](../../src/mcp/tools.ts#L705)-[720](../../src/mcp/tools.ts#L720) にある。既存 describe は SQL `DESCRIBE APPn` への wrapper のまま（[tools.ts:900](../../src/mcp/tools.ts#L900)-[908](../../src/mcp/tools.ts#L908)）維持する。

P3 の挿入点:

- `src/mcp/schemas.ts:1-25`: 共通 profile を再利用し、Node resource constants から `.strict()` discriminated union を新設。
- `src/mcp/schemas.ts:107-123,165-174`: describe/show schema は不変のまま metadata schema/type/registration shape を加える。
- `src/mcp/tools.ts:26-45,57-79`: `createMetadataRuntime` dependency と input type を純加法で追加。
- `src/mcp/tools.ts:483-490`: metadata runtime factory の既定 dependency を解決。
- `src/mcp/tools.ts:900-919` 付近: 既存 describe/show を変更せず sibling `appMetadata` handler を追加。
- `src/mcp/tools.ts:1035-1057`: raw handler と `appMetadataTool: runSafely(...)` を返す。
- `src/mcp/index.ts:82-116`: `ksql_app_metadata` を独立登録し、tools/list title/description/schema を公開。
- `src/mcp/tools.ts:384-395,460-480`: 現行 error envelope / `toToolResult` を再利用。`toToolResult` は payload と同じ object を `structuredContent` に置くため、`data` は nested object のまま保持される（[tools.ts:460](../../src/mcp/tools.ts#L460)-[470](../../src/mcp/tools.ts#L470)）。

成功 wrapper は R2 §4.3 の `ok/type/resource/environment/request/responseBytes/data` に exact 準拠し、`type: "KINTONE_METADATA"` とする。secret、token、password、auth header、base URL は audit metadata に含めない。error は `runSafely` の `{ok:false,error:{code,message}}` + `isError:true` へ閉じ、失敗後の別 profile/path/environment fallback は行わない。

### 2.6 smoke / release の挿入点

`scripts/mcp-smoke.mjs` は期待 tool 名を列挙し（[mcp-smoke.mjs:15](../../scripts/mcp-smoke.mjs#L15)-[27](../../scripts/mcp-smoke.mjs#L27)）、tools/list schema と description の drift guard を持つ（[mcp-smoke.mjs:46](../../scripts/mcp-smoke.mjs#L46)-[100](../../scripts/mcp-smoke.mjs#L100)）。`mcp:pack-smoke` は pack/install 後の MCP JSON-RPC を検査するため、metadata tools/list と fail-before-network schema case を追加する（[mcp-pack-smoke.mjs:91](../../scripts/mcp-pack-smoke.mjs#L91) 以降）。script 入口は [package.json:22](../../package.json#L22)-[30](../../package.json#L30) にある。

release version/artifact 作業は本計画に独立 phase を作らず、B43 計画 Phase 7c（[B43 plan:321](ksql_b43_dml_prevalidation_impl_plan.md#L321)-[334](ksql_b43_dml_prevalidation_impl_plan.md#L334)）へ B49 の build/smoke/drift guard 完了を合流条件として委譲する。

## 3. Phase 分割

### P1a — Node-only resource model / pure mapper（M）

着地点: HTTP transport から独立した `AllowedMetadataRequest` と唯一の resource-to-path mapper を完成させ、8 resource の最小 allowlist、preview/lang/auth capability、任意 path 不可を pure unit test で固定する。まだ fetch へ接続しない。

変更候補:

- 新規 `src/node/kintoneMetadata.ts`。
- 新規 `src/node/__tests__/kintoneMetadata.test.ts`（mapper/type boundary）。

受入テスト（各 case を先に追加して修正前 fail -> 実装後 pass を保存）:

1. production の `app/fields/layout/settings/status/views/reports/customize` が正本表の固定 path に一致し、query は resolved positive safe integer と許可 `lang` だけを `URLSearchParams` で生成する。
2. preview 対応7 resource は `/v1/preview/...`、`app + preview:true` は request plan を生成せず `ArgumentError`。省略/false は必ず production で、preview/production fallback はない。
3. `lang` は5値だけ、fields/settings/status/views/reports だけに許可。layout/customize/app の `lang` は mapper を直接呼んでも拒否する。
4. allowlist 外の `records/record/cursor/apps/acl/space/file/api-schema`、unknown string、absolute URL、protocol-relative URL、`..`、encoded slash を型 cast で mapper に渡しても path 化できない。
5. mapper の public input/output に caller-controlled URL/path/endpoint/method/headers/body/free-form query がなく、resource string を path fragment へ連結しない。
6. auth capability は `customize=userpass-only`、他7 resource は token/userpass 可と表現され、token customize plan は生成前に `CapabilityError`。自動 auth fallback はない。

独立 gate: mapper unit green、fetch spy call 0、endpoint table/switch がこのファイル1箇所だけであることを `rg` 監査。P1b 接続前に Claude が D2〜D7/D12 をレビューする。

### P1b — shared Node connection / metadata reader / 2 MiB cap（L）

依存: P1a Approved。

着地点: `createNodeKintoneConnection`、互換 `createNodeKintoneClient` wrapper、`KintoneMetadataReader` を完成し、同じ auth/guest/timeout/error transport 上で固定 GET と byte cap を証明する。既存 core client の挙動は不変。

変更候補:

- `src/cli/nodeKintoneClient.ts:47-133`。
- `src/cli/__tests__/nodeKintoneClient.test.ts:1-45,85-93` と metadata reader cases。
- `src/node/kintoneMetadata.ts` の reader/response 型。

受入テスト（修正前 fail -> 修正後 pass）:

1. 8 resource の reader call 全てで fetch `RequestInit.method === "GET"`。transport spy の POST/PUT/DELETE/HEAD は合計0回。
2. schema を通さず reader/mapper を型 cast で攻撃しても、unknown resource、method/path相当の余計な property、records/ACL/apps/space、unsupported preview/lang/customize auth は fetch 0回。failure 後の fallback fetch も0回。
3. normal path は `/k/v1/...`、guest は `/k/guest/{id}/v1/...`、guest preview は `/k/guest/{id}/v1/preview/...`。host/base path は connection config だけから作る。
4. token は resolved physical app ID を `resolveToken` に渡し、userpass/token header と timeout/kintone error 化は既存 client と共有する。audit output に secret/base URLを出さない。
5. `Content-Length > 2,097,152` は body read/JSON parse 前に size error。Content-Length なし/虚偽の chunked body は streaming read 中に上限+1で cancelし、partial dataを返さない。
6. UTF-8 body exactly 2 MiB は許可、2 MiB+1 byte は拒否。`responseBytes` は文字数でなく実 byte 数。invalid JSON/size overflow は retry 対象 error に偽装しない。
7. parsed body は unknown key、nested array/object、empty string、boolean、null を deep-equal で保持する。fields/settings fixture は既存 normalizerを通さない。
8. `createNodeKintoneClient` の既存 cursor/records/apps/fields/settings/status tests が変更前後で同じ結果・request shape。metadata cap は既存 record responses に適用しない。
9. 同じ reader call を2回行えば成功 GET は2回。reader/connection に raw response cache field/map がない。

独立 gate: Node client/metadata unit green、transport spy exact、既存 Node client test green。Claude は固定 GET assertion、stream cancel、2 MiB境界、connection factory 化による既存 transport 非回帰を重点レビューする。

### P2 — metadata runtime / resolver sharing / read-only gate（L）

依存: P1b Approved。

着地点: `createKintoneMetadataRuntime` が単一 AppRef を既存規則で解決し、binding profile の connection/reader と physical app ID を選び、process-global `RequestGate.runReadOnly` で1 GETを実行できるようにする。SQL parser/executor は呼ばない。

変更候補:

- `src/node/runtime.ts:99-130,133-172,203-355,369-439`。
- 新規または拡張 `src/node/__tests__/metadataRuntime.test.ts`。
- `src/node/__tests__/runtime.test.ts:233-279` の resolver/snapshot/token回帰。
- `src/api/__tests__/requestGate.test.ts` の metadata retry routing case（RequestGate本体の意味は変更しない）。

受入テスト（修正前 fail -> 修正後 pass）:

1. positive numeric app と正規表現に合う `LAPP_NAME` が既存 resolution primitiveを通り、source app、mapped/binding、resolved physical app、profile、cacheContext を一貫して返す。
2. unknown LAPP、logicalApps未設定、undefined explicit profile、`allowPhysicalAppRefs:false` の numeric app は connection/fetch作成前に fail-closed。
3. logical binding の token不足は single `KSQL_TOKEN` へ逃げず `AuthError`、resolved physical ID を token resolver/queryへ渡す。default profile clientへの固定や別 profile fallbackはない。
4. profileごとの baseUrl/guestSpaceId/auth/timeoutを選び、LAPP binding先 profileの readerを使う。結果/auditには source appとresolved app/profileを持つがsecretはない。
5. `customize + token profile` は reader/fetch前 `CapabilityError`、userpass profileだけ固定GETへ進む。より広いauth/profileへのfallback 0回。
6. metadata GETは `RequestGate.runReadOnly` を通り、408/429/502/503/504/network/timeoutだけ既存回数でretry。400/401/403/404、parse、size、allowlist/capability errorはretry 0。
7. retryの全attemptで method/endpoint/app/paramsがexact一致。`runMutation`/`runCursorStep`/executorは0回。
8. raw cacheなし: 同一tool相当call 2回で成功GET 2回。preview/profile/cacheContext間でresponseを共有しない。

独立 gate: metadata runtime unit + existing runtime/requestGate tests green。Claude は resolverの重複実装がないこと、private config snapshot維持、logical token fallback禁止、`runReadOnly`だけへの接続を重点レビューする。

### P3 — MCP `ksql_app_metadata` schema / registration / result（L）

依存: P2 Approved。

着地点: 新 tool を純加法で公開し、strict schema、metadata runtime、raw passthrough、audit wrapper、fail-closed error envelope を end-to-end unit testで固定する。既存 `ksql_describe_app` / `ksql_show_apps` / query/mutateは不変。

変更候補:

- `src/mcp/schemas.ts:1-25,107-123,165-174`。
- `src/mcp/tools.ts:26-79,460-490,900-919,1035-1057`。
- `src/mcp/index.ts:72-116`。
- `src/mcp/__tests__/tools.test.ts:394-433` 付近と新規 metadata suite。

受入テスト（修正前 fail -> 修正後 pass）:

1. tools/list に `ksql_app_metadata` title/description/schemaを追加し、resource enumはexact 8件。既存 tool名/schema/output snapshotはmetadata追加以外不変。
2. AppRefはpositive safe integerまたは `/^LAPP_[A-Za-z][A-Za-z0-9_]{0,63}$/i` だけ。`APP123` string、SQL fragment、`@profile`、subtable suffixを拒否する。
3. `.strict()` discriminated union が unknown key と resource不整合を拒否する。特に url/path/endpoint/method/headers/body/query/ids、layout+lang、app+preview:true は handler/runtime/fetch 0回。
4. schemaを迂回し `tools.appMetadata(...)` / injected metadata runtimeへ不正objectを渡しても、P1 mapperが同じ入力を再拒否し fetch 0回。POST/PUT/DELETE・任意path・records/ACL/apps/space到達はtransport spyで0回。
5. 成功は `ok:true,type:"KINTONE_METADATA"`、resource/environment、`request.method:"GET"`、relative endpoint、source app、resolvedAppId/profile、許可params、responseBytes、dataを返す。`structuredContent.data` はparsed raw objectとdeep-equalで、wrapper keyをdata内へ注入しない。
6. text JSONをparseするとstructuredContent全体とdeep-equal。unknown/nested/null等のfixtureを保持する。
7. allowlist/profile/token/capability/size/API errorは`ok:false` error envelopeと`isError:true`。secret/base URLなし、fallback runtime/reader/fetch 0回。
8. `ksql_mutate` の `allowDml`/`confirmText`、executorの`allowApplyMutation`をmetadata toolが設定せず、`createRuntime`/`executeSql`/`executeBatchSql`/mutation APIは0回。
9. R2 §10.2〜10.4のrouting/preview/size/retry fixturesをMCP handlerまで通し、P1/P2の保証がschema追加後も失われない。
10. 既存 `describeApp` は引き続き `DESCRIBE APPn` をqueryへ委譲し、parser/AST/DESCRIBE/CTE/batch/plugin clientには差分がない。

独立 gate: MCP tools/schema/index unit green、P1/P2 safety tests再実行。Claude は「schemaだけでなくmapperでも閉じる」「raw dataとauditの分離」「既存tool非変更」を重点レビューする。

### P4 — MCP smoke / pack smoke / drift guard / 全回帰（M）

依存: P3 Approved。

着地点: source build と packed MCP の公開面を検査し、二重 allowlist・read-only・version同梱前提の drift を release 前に止める。実kintone metadata取得を資格情報なし smoke の必須条件にはせず、schema fail-before-network とtools/listをpackaged artifactで検査する。

変更候補:

- `scripts/mcp-smoke.mjs:15-100` と call/assertion 部。
- `scripts/mcp-pack-smoke.mjs:91` 以降。
- 必要な tools/list/unit snapshot。release/version/changelog/manifestはまだ変更しない。

受入テスト（修正前 fail -> 修正後 pass）:

1. `mcp:smoke` の expectedTools に metadataを追加し、8 resource enum、branch required/optional keys、`additionalProperties:false`、url/path/method/body/query/ids不在を検査する。
2. description drift guardに「read-only metadata」「fixed allowlist」「no records/mutation」相当の契約キーを固定する。全文一致にはしない。
3. built MCPへ `resource:"records"`、`method:"POST"`、`path:"/k/v1/records.json"` を送り、JSON-RPC schema error、metadata handler/network 0を確認する。
4. `mcp:pack-smoke` のinstall済みpackageでもtool登録/schema/error envelopeが同じ。bundleにSDK/Zod外部requireを残さない既存guardも維持する。
5. targeted suites -> `npm test` -> `npm run build` -> `npm run mcp:smoke` -> `npm run mcp:pack-smoke` を実行しgreen。`npm run build:plugin`は回帰確認だけでplugin source差分なし。
6. `git diff -- src/execute.ts src/ui/kintoneClient.ts` と parser/AST/plugin対象の差分0、core client mockのmetadata method追加0を確認する。
7. repo-wide `rg` でallowlist/path tableの重複、records/ACL/apps/spaceのmetadata許可、configurable size cap、raw cache、任意HTTP入力が混入していないことを監査する。

独立 gate: 全自動テスト/build/smoke green、sourceとpacked artifactのtools/list一致、Claude最終実装レビュー Approved。version/artifact更新はまだ行わない。

### P5 — v3.9.0 release は B43 Phase 7c へ委譲（独立 phase なし）

P5 は実装・レビュー単位ではない。B49 P4 Approved を B43 Phase 7c の開始条件へ追加し、次を同じ v3.9.0 一括 releaseで行う。

- package/lock/manifest/changelog/release artifactのversion/content同期。
- B43/B49を含む最終 `npm test` / build / MCP smoke / pack smoke / plugin smoke。
- B49 tool/schema/description、2 MiB固定値、allowlist 8件、core interface不変のrelease artifact drift監査。
- Claude最終release差分レビュー後のcommit/PR/tag/Release/publish。

本計画から独立の version bump、artifact生成、commit、PR、tag、publishは行わない。

## 4. R2 §10 受入観点の Phase 割付

| R2 test section | 観点 | Phase |
|---|---|---|
| §10.1 | schema入力最小性 | P3、P4 |
| §10.1 | Node mapper allowlist、固定GET、任意path/records/ACL/space不可 | P1a、P1b、P3 |
| §10.1 | mutation/executor非接続、failure後fallback 0 | P1b、P2、P3 |
| §10.2 | 8 path、guest、preview、lang、URLSearchParams | P1a、P1b |
| §10.3 | LAPP/profile/physical policy/token/cacheContext routing | P2 |
| §10.3 | customize userpass-only、audit秘匿 | P1a、P1b、P2、P3 |
| §10.4 | raw deep-equal、text一致、2 MiB streaming境界 | P1b、P3 |
| §10.4 | runReadOnly retry分類、attempt不変、cacheなし | P2 |
| §10.5 | registration/error/describe/core/plugin regression | P3、P4 |
| §10.6 | resource fixture raw passthrough | P1b、P3 |

## 5. 安全性の非回帰 gate（全 Phase 共通）

| 不変条件 | 検出方法 | 失敗時の扱い |
|---|---|---|
| schema + Node mapper の二重 allowlist | MCP schema testとschema迂回reader testを別suiteで実行 | fetch 1回でもPhase不合格 |
| 初期allowlistは8件だけ | constants/schema/tools-list exact set比較 | records/ACL/apps/space等が1件でも入れば不合格 |
| transportは固定GET | 全resource transport spy、全retry attempt exact比較 | GET以外が1回でも不合格 |
| 任意HTTP入力なし | schema JSON、TS public request型、dependency seamを監査 | url/path/method/body/query等がcaller入力なら不合格 |
| previewは明示のみ | omitted/false/trueとunsupported app case | production fallbackがあれば不合格 |
| 2 MiB固定cap | header/chunked/exact/+1 byte境界、input/config surface監査 | partial dataまたは可変上限なら不合格 |
| auth/routing fail-closed | unknown LAPP/profile/token/physical policy/customize token spy | fallback requestが1回でも不合格 |
| raw cacheなし | repeated-call countとobject/field監査 | 成功2callでGET<2なら不合格 |
| core interface不変 | `src/execute.ts:179-198` diff、TypeScript build、mock差分 | optionalを含むmethod追加なら不合格 |
| SQL/DESCRIBE/plugin不変 | existing snapshots/buildと対象file diff | B49起因の契約差分なら不合格 |

安全性テストは各 Phase の対象 suite だけで終わらせず、P3/P4 で P1/P2 suite を再実行する。MCP schema が正しくても Node mapper test が欠ければ完了としない。逆に mapper が安全でも tools/list schemaがURL/method等を示唆すれば完了としない。

## 6. 実装時決定点（D1〜D13を覆さない内部詳細）

次だけを各 Phase の Claude コードレビューで確定する。いずれも resource、path、auth、size、cache、SemVer の再選択ではない。

1. `src/node/kintoneMetadata.ts` をtype/mapper/readerの1ファイルに保つか、同一Node module内でmapperとreaderを分けるか。endpoint mappingの正本は必ず1箇所にする。
2. 2 MiB streaming readerをconnection private helperに置くかmetadata module helperに置くか。既存clientへのcap非適用、byte/cancel契約は不変。
3. app resolutionを既存 scannerへ検証済みsynthetic app refで渡すか、`normalizeSqlAppProfiles`の内部primitiveを抽出するか。parser/executor不使用、同一fail-closed規則、source-aware cacheContextは不変。
4. metadata runtimeの戻り型でreader実行functionを返すかresolved reader/requestを返すか。MCPがpath/methodを受け取らず、`runReadOnly`を1回通る契約は不変。
5. Zod discriminated unionへ渡すresource constantsのexport形。Node mapperによる独立再検査は削除しない。

## 7. スコープ外

R2 §12（[spec:648](ksql_b49_mcp_readonly_metadata_api_spec.md#L648)-[659](ksql_b49_mcp_readonly_metadata_api_spec.md#L659)）をそのまま適用する。

- `DESCRIBE ... AS JSON`、SQL grammar / lexer / parser / AST / executor / CTE / batch拡張。
- 既存DESCRIBEの列/raw cell/result type、`ksql_describe_app`、`ksql_show_apps`の変更。
- core `KintoneClient` interfaceの必須/optional method追加。
- plugin/browser client、plugin UI/SQL、CLI raw metadata command。
- records/cursor/comments/file download、ACL、apps raw list、space、identity、通知/action、API discovery。
- arbitrary URL/endpoint/method/header/body/query proxy。
- multi-resource bundle、join/merge、schema normalization。
- raw responseの永続/process/tool-call cache。
- size capのMCP input/operator config化、2 MiB以外への変更。
- official kintone MCP serverとの比較/置換。
- P4以前のversion/changelog/manifest/release artifact更新、および本計画作成時のコード実装/commit。

## 8. Phase 一覧と完了 gate

| Phase | 内容 | 規模 | 依存 | 独立完了 gate |
|---|---|:---:|---|---|
| P1a | resource型 + 単一allowlist/path mapper | M | なし | 8件exact、preview/lang/auth/任意path fail-closed、fetch 0 |
| P1b | shared connection + reader + 固定GET + 2 MiB | L | P1a | transport/guest/size/raw/non-cache + existing client green |
| P2 | metadata runtime + resolver共有 + `runReadOnly` | L | P1b | LAPP/profile/token/policy/routing/retry fail-closed |
| P3 | strict MCP schema + tool + result/error wrapper | L | P2 | schema迂回も安全、raw data/audit分離、既存tool不変 |
| P4 | source/packed smoke + drift guard + 全回帰 | M | P3 | test/build/smoke green、core/SQL/plugin差分なし |
| P5 | B43 Phase 7cへrelease委譲 | - | P4 + B43 7b | 独立phaseなし、v3.9.0一括gateへ合流 |

実装順は `P1a -> P1b -> P2 -> P3 -> P4 -> B43 Phase 7c`。各矢印の前に Claude Approved を必須とする。

## 9. Claude レビュー重点

1. schemaとNode mapperが独立した二重強制になり、schema迂回時もPOST/PUT/DELETE、任意path、records/ACL/apps/spaceへ到達不能か。
2. allowlistが8 resource exactで、endpoint/path/lang/preview/auth表がNodeの1箇所だけにあるか。
3. `createNodeKintoneConnection` 抽出後も既存 `createNodeKintoneClient` とrecords/cursor/error/timeout契約が変わらず、metadataだけが固定GET + 2 MiB capか。
4. Content-Lengthなし/虚偽でも2 MiB+1をstreaming中止し、partial/raw cacheを残さないか。
5. metadata runtimeが既存LAPP/profile/`allowPhysicalAppRefs`/token/private config snapshot/cacheContext resolverを共有し、logical single-token/default-profile fallbackを新設していないか。
6. `customize` token profile、unsupported preview、allowlist/size/auth errorの後にfallback request/retryがないか。
7. MCP outputでparsed raw objectが`structuredContent.data`にdeep-equal、auditは外側、secret/base URLは非公開か。
8. metadata toolがexecutor/mutation capabilityを一切呼ばず、`RequestGate.runReadOnly`だけへ接続するか。
9. `KintoneClient`にoptionalを含む変更がなく、既存mock/plugin adapter/SQL/DESCRIBEにB49差分がないか。
10. P4のsource/packed drift guardがschema最小性とtool descriptionをrelease artifactまで固定し、B43 Phase 7cへ安全に合流できるか。
