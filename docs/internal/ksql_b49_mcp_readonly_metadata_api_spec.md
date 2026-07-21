# B49 — MCP 読み取り専用 kintone メタデータ API 仕様 R2

- 作成日: 2026-07-21
- ステータス: **R2・Claude レビュー Approved・v3.9.0 実装中**（実装計画: [ksql_b49_mcp_readonly_metadata_api_impl_plan.md](ksql_b49_mcp_readonly_metadata_api_impl_plan.md)）
- 対象: B49「MCP から取得系（GET）kintone REST API（フィールド／フォーム／アプリ情報等）を安全に汎用実行する」
- 一次情報: [ksql_issue_tracker.md B49](../ksql_issue_tracker.md#L40)
- 旧仕様: [B49 R1 — DESCRIBE 制約付き JSON 出力](ksql_b49_describe_constraints_spec.md)

## 0. R2 の位置づけ

本 R2 は R1 を **supersede（置換）**する。R1 の実装には進まない。

R1 は `DESCRIBE APPxxx AS JSON` という SQL 言語拡張を提案したが、lexer / parser / AST / executor / CTE / batch の契約へ波及し、さらに公開 `KintoneClient` に raw 取得メソッドを必須追加すると core 埋め込み利用者に source-breaking となる。ユーザー判断により次へ方針転換した。

1. SQL 言語を拡張しない。オプションなし `DESCRIBE` の現行3列表も変更しない。
2. MCP 専用の新ツールで、fields だけでなく app / form / settings 等の取得系メタデータ API を扱う。
3. MCP に URL・path・HTTP method・body を入力させず、列挙した GET resource だけを実行する。
4. core `KintoneClient` interface とプラグインには能力を追加せず、Node / MCP 層に閉じる。

R1 の目的だった「Claude がフィールド制約の生 JSON を読む」は、本 R2 の `resource: "fields"` という1リソースで内包する。

## 1. 症状

現行 `DESCRIBE` は form fields API から得た正規化済みフィールド情報を、フィールドコード／ラベル／タイプの3列へ投影するだけである（[src/execute.ts:7290-7302](../../src/execute.ts#L7290)）。

```ts
const fields = await getFieldsCached(stmt.appId, client, cacheContext);
const columns = ["フィールドコード", "ラベル", "タイプ"];
const rows: ProcessRow[] = fields.map((f) => ({
  "フィールドコード": f.code,
  "ラベル":           f.label,
  "タイプ":           f.fieldType,
}));
return { type: "SELECT", rows, columns, rowCount: rows.length };
```

専用 MCP ツール `ksql_describe_app` も `query()` に同じ SQL を渡すだけである（[src/mcp/tools.ts:900-908](../../src/mcp/tools.ts#L900)）。

```ts
async function describeApp(input: DescribeAppInput): Promise<Record<string, unknown>> {
  return await query({
    sql: `DESCRIBE APP${input.app}`,
    profile: input.profile,
    // ...
  });
}
```

このため Claude がフィールド制約、フォーム配置、数値精度、プロセス、一覧、グラフ等を踏まえて SQL / DML を組み立てるには、kSQL MCP の外で kintone REST API を別途呼ぶ必要がある。B49 R2 は、対象を安全なメタデータ GET に限定した1本の MCP ツールでこの往復をなくす。

## 2. 現状の裏取り

### 2.1 生 fields JSON は保持されていない

公開 `KintoneClient.getFields` の戻り値は `KintoneFieldInfo[]` である（[src/execute.ts:184-191](../../src/execute.ts#L184)）。

```ts
/** GET /k/v1/app/form/fields.json（DESCRIBE） */
getFields: (appId: number) => Promise<KintoneFieldInfo[]>;
/** GET /k/v1/app/settings.json（数値の有効桁数と丸め設定） */
getNumberPrecision: (appId: number) => Promise<NumberPrecision>;
/** GET /k/v1/app/status.json（プロセス管理設定） */
getProcessStatuses: (appId: number) => Promise<KintoneProcessStatuses>;
```

Node クライアントは `/app/form/fields.json` を取得後、response の `properties` を `flattenFormFieldProperties` へ渡し、raw response を破棄する（[src/cli/nodeKintoneClient.ts:308-318](../../src/cli/nodeKintoneClient.ts#L308)）。

```ts
const res = await requestJson<{ properties: Record<string, FormFieldProperty> }>(
  `${apiBasePath}/app/form/fields.json?${qs.toString()}`,
  { method: "GET" },
  appId
);
return flattenFormFieldProperties(res.properties);
```

`getFieldsCached` も `Promise<KintoneFieldInfo[]>` だけを `cacheContext + appId` scope で保持する（[src/execute.ts:3933-3938](../../src/execute.ts#L3933)、[src/execute.ts:3966-3972](../../src/execute.ts#L3966)）。

```ts
const fieldInfoCache = new Map<string, Map<number, Promise<KintoneFieldInfo[]>>>();

async function getFieldsCached(...) {
  const cached = getScopedCacheValue(fieldInfoCache, cacheContext, appId);
  if (cached) return cached;
  const loading = client.getFields(appId);
  setScopedCacheValue(fieldInfoCache, cacheContext, appId, loading);
  return loading;
}
```

従って `fields` の raw JSON は `KintoneFieldInfo[]` から逆生成せず、新しい raw GET 経路で取得する必要がある。

### 2.2 Node クライアントには共有可能な GET transport の足場がある

`createNodeKintoneClient` は host 末尾を正規化し、通常 space と guest space の API base path を接続設定だけから組み立てる（[src/cli/nodeKintoneClient.ts:47-54](../../src/cli/nodeKintoneClient.ts#L47)）。MCP 入力から host や base path を受ける必要はない。

```ts
const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
const apiBasePath = tokenResolver.guestSpaceId && tokenResolver.guestSpaceId > 0
  ? `/k/guest/${tokenResolver.guestSpaceId}/v1`
  : "/k/v1";
```

内部 `requestJsonResponse` はアプリ単位 token または user/password 認証、JSON Accept header、AbortController timeout、kintone error 化を共通実装する（[src/cli/nodeKintoneClient.ts:56-76](../../src/cli/nodeKintoneClient.ts#L56)、[src/cli/nodeKintoneClient.ts:91-124](../../src/cli/nodeKintoneClient.ts#L91)）。`requestJson` はその body だけを返す private helper である（[src/cli/nodeKintoneClient.ts:128-133](../../src/cli/nodeKintoneClient.ts#L128)）。

```ts
async function requestJson<T>(path: string, init: RequestInit, appIdForToken: number): Promise<T> {
  return (await requestJsonResponse<T>(path, init, appIdForToken)).body;
}
```

ただし現行 success response は `res.json()` を直接呼び（[src/cli/nodeKintoneClient.ts:121-124](../../src/cli/nodeKintoneClient.ts#L121)）、byte 上限を持たない。R2 ではこの transport を内部共有できるよう分離しつつ、metadata reader の success body に別途サイズ境界を設ける。

GET 系の同時実行と retry は `RequestGate.runReadOnly` に既存実装がある。408 / 429 / 502 / 503 / 504、network failure、timeout だけを retry し（[src/api/requestGate.ts:41-55](../../src/api/requestGate.ts#L41)）、書き込み系は retry しない（[src/api/requestGate.ts:106-128](../../src/api/requestGate.ts#L106)）。

```ts
async runReadOnly<T>(fn: () => Promise<T>): Promise<T> { /* semaphore + retry */ }
async runMutation<T>(fn: () => Promise<T>): Promise<T> { return this.withSlot(fn); }
async runCursorStep<T>(fn: () => Promise<T>): Promise<T> { return this.withSlot(fn); }
```

### 2.3 MCP tool / runtime / routing の足場

`createKsqlMcpTools` は dependency から `createRuntime` を受け、既定では Node の `createKsqlRuntime` を使う（[src/mcp/tools.ts:483-490](../../src/mcp/tools.ts#L483)）。通常 query は runtime の `sql`、routed `client`、`cacheContext` を executor へ渡す（[src/mcp/tools.ts:705-720](../../src/mcp/tools.ts#L705)）。

```ts
const runtime = await createRuntime(serverOptions, { /* resolved input */ });
const result = await executeSql(runtime.sql, runtime.client, {
  cacheContext: runtime.cacheContext,
  // ...
});
```

runtime は profile ごとの client map を持ち（[src/node/runtime.ts:72-76](../../src/node/runtime.ts#L72)）、routed client の `getFields` は mapped app ID から binding を解決し、正しい profile client と物理 app ID を選ぶ（[src/node/runtime.ts:369-405](../../src/node/runtime.ts#L369)）。

```ts
getFields: (appId) => {
  const binding = resolveRuntimeBinding(runtimeContext.sqlContext, appId);
  const routed = runtimeContext.clientsByProfile.get(binding.profile);
  if (!routed) throw new Error(...);
  return routed.getFields(binding.appId);
},
```

従って「SQL executor を通さずに metadata GET する」ために不足するのは、Node-only metadata reader と、その reader を routed binding に結び付ける metadata runtime である。既存 routed `KintoneClient` に raw method を足す必要はない。

### 2.4 LAPP / profile / token の fail-closed 境界

`resolveSqlContext` は config snapshot と default profile を解決し、`normalizeSqlAppProfiles` の binding、source-aware `cacheContext`、logical binding label を作る。さらに物理参照を `assertPhysicalAppAllowed` で検査する（[src/node/runtime.ts:99-130](../../src/node/runtime.ts#L99)）。

```ts
const normalized = normalizeSqlAppProfiles(sql, profileName, resolutionContext);
const bindings = normalized.appBindingByMappedApp;
for (const binding of bindings.values()) {
  if (binding.source === "physical") resolutionContext.assertPhysicalAppAllowed(binding.profile);
}
// ...
cacheContext: buildCacheContext(profileName, bindings),
```

`normalizeSqlAppProfiles` は未知 LAPP または logicalApps 設定なしを error にし（[src/node/appProfiles.ts:284-296](../../src/node/appProfiles.ts#L284)）、logical source を物理 app ID / profile へ binding する（[src/node/appProfiles.ts:342-370](../../src/node/appProfiles.ts#L342)）。token 解決は logical source を single token fallback へ逃がさず（[src/node/runtime.ts:148-170](../../src/node/runtime.ts#L148)）、不足を runtime 作成前に `AuthError` にする（[src/node/runtime.ts:313-355](../../src/node/runtime.ts#L313)）。

R2 metadata runtime も同じ resolver と private config snapshot を再利用し、別の簡易 LAPP parser、default profile 固定、token fallback を新設してはならない。

### 2.5 kSQL がすでに利用するメタデータ GET

現行 `KintoneClient` 契約は `apps.json`（SHOW APPS）、`app/form/fields.json`（DESCRIBE）、`app/settings.json`（NumberPrecision）、`app/status.json`（process）を明示する（[src/execute.ts:184-191](../../src/execute.ts#L184)）。Node 実装も次の固定 GET を行う。

- SHOW APPS: `/apps.json` を limit 100 で page し、全件を正規化する（[src/cli/nodeKintoneClient.ts:282-305](../../src/cli/nodeKintoneClient.ts#L282)）。
- fields: `/app/form/fields.json?app=...`（[src/cli/nodeKintoneClient.ts:308-318](../../src/cli/nodeKintoneClient.ts#L308)）。
- number precision: `/app/settings.json?app=...`（[src/cli/nodeKintoneClient.ts:320-328](../../src/cli/nodeKintoneClient.ts#L320)）。
- process: `/app/status.json?app=...&lang=user`（[src/cli/nodeKintoneClient.ts:331-342](../../src/cli/nodeKintoneClient.ts#L331)）。

`app/settings.json` の response は raw のままではなく、`numberPrecision` の存在・範囲・roundingMode を検証して `NumberPrecision` に変換される（[src/core/numberPrecision.ts:31-43](../../src/core/numberPrecision.ts#L31)）。R2 の `settings` はこの正規化結果ではなく API response object 全体を返す。

### 2.6 MCP result は nested object を返せる

`toToolResult` は payload を pretty JSON text にし、同じ object を `structuredContent` に載せる（[src/mcp/tools.ts:460-470](../../src/mcp/tools.ts#L460)）。

```ts
return {
  content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  structuredContent: payload as Record<string, unknown>,
  isError,
};
```

従って raw API object は core の `SelectResult` や JSON string cell を経由せず、MCP payload の `data` に直接保持できる。

### 2.7 現行の書き込み安全境界を迂回してはならない

`ksql_query` は DML を検出すると `ksql_mutate` へ誘導して拒否する（[src/mcp/tools.ts:647-684](../../src/mcp/tools.ts#L647)）。`ksql_mutate` は `allowDml:true`、`confirmText:"yes"`、正の `dmlMaxRows` を必須とし（[src/mcp/tools.ts:397-412](../../src/mcp/tools.ts#L397)）、APPLY mutation は MCP ではさらに常時拒否する（[src/mcp/tools.ts:831-840](../../src/mcp/tools.ts#L831)）。

R2 ツールはこの mutation tool とは独立するが、POST / PUT / DELETE へ到達できる入力や fallback を一切持たないことで、これらの安全境界を迂回不能にする。

### 2.8 プラグインは別 surface

MCP bundle は Node platform で `src/mcp/index.ts` を entry point にする（[build-mcp.mjs:13-21](../../build-mcp.mjs#L13)）。プラグイン build は browser platform を使い（[build.mjs:33-43](../../build.mjs#L33)）、entry point も `src/ui/desktop.ts` / `src/ui/config.ts` という別 bundle である（[build.mjs:68-82](../../build.mjs#L68)）。また plugin client は `kintone.api()` を core `KintoneClient` へ変換する adapter である（[src/ui/kintoneClient.ts:1-18](../../src/ui/kintoneClient.ts#L1)）。R2 は Node / MCP-only とし、plugin client、plugin SQL、plugin DESCRIBE を変更しない。

## 3. 設計 A — 安全設計（fail-closed）

### 3.1 二重の read-only 強制

R2 は次の2層を両方必須とする。

1. **schema 層:** MCP input に `url`、`path`、`endpoint`、`method`、`headers`、`body`、自由な query object を置かない。Zod schema は `.strict()` と resource discriminated union で未定義 key と resource 不整合 parameter を拒否する。
2. **Node 層:** metadata reader の public operation は `getMetadata(request)` だけとし、`RequestInit` や HTTP method を引数にしない。resource mapper が固定 path と許可 parameter を作り、transport 呼び出しはコード上常に `{ method: "GET" }` とする。mapper にない resource は request 前に `ArgumentError` で終了する。

MCP schema だけに allowlist を置く案は禁止する。テストや将来の別 caller が schema を迂回しても、Node mapper が同じ enum で閉じなければならない。逆に private `requestJson(path, init, ...)` を MCP dependency として直接公開する案も禁止する。

### 3.2 R2 初期 allowlist

resource 名は endpoint 名ではなく、安定した product-level enum とする。公式契約の確認先は次のとおりである。

- [`app.json` — 1件のアプリ情報](https://cybozu.dev/ja/kintone/docs/rest-api/apps/get-app/)
- [`form/fields.json` — フィールド](https://cybozu.dev/ja/kintone/docs/rest-api/apps/form/get-form-fields/)
- [`form/layout.json` — レイアウト](https://cybozu.dev/ja/kintone/docs/rest-api/apps/form/get-form-layout/)
- [`app/settings.json` — 一般設定](https://cybozu.dev/ja/kintone/docs/rest-api/apps/settings/get-general-settings/)
- [`app/status.json` — プロセス管理](https://cybozu.dev/ja/kintone/docs/rest-api/apps/settings/get-process-management-settings/)
- [`app/views.json` — 一覧](https://cybozu.dev/ja/kintone/docs/rest-api/apps/view/get-views/)
- [`app/reports.json` — グラフ](https://cybozu.dev/ja/kintone/docs/rest-api/apps/report/get-graph-settings/)
- [`app/customize.json` — JavaScript / CSS customize](https://cybozu.dev/ja/kintone/docs/rest-api/apps/settings/get-customization/)

| `resource` | production path | `preview:true` path | 許可 parameter | R2 備考 |
|---|---|---|---|---|
| `app` | `{apiBasePath}/app.json` | **なし** | 固定 `id=<resolved app>` | 公開済みの単一アプリ情報。`preview:true` は schema error |
| `fields` | `{apiBasePath}/app/form/fields.json` | `{apiBasePath}/preview/app/form/fields.json` | 固定 `app=<resolved app>`、任意 `lang` | R1 の目的を内包。response 全体を返す |
| `layout` | `{apiBasePath}/app/form/layout.json` | `{apiBasePath}/preview/app/form/layout.json` | 固定 `app=<resolved app>` | フォーム配置 |
| `settings` | `{apiBasePath}/app/settings.json` | `{apiBasePath}/preview/app/settings.json` | 固定 `app=<resolved app>`、任意 `lang` | `numberPrecision` を含む raw 一般設定 |
| `status` | `{apiBasePath}/app/status.json` | `{apiBasePath}/preview/app/status.json` | 固定 `app=<resolved app>`、任意 `lang` | process states / actions |
| `views` | `{apiBasePath}/app/views.json` | `{apiBasePath}/preview/app/views.json` | 固定 `app=<resolved app>`、任意 `lang` | 一覧定義。custom view HTML も raw の一部として返る |
| `reports` | `{apiBasePath}/app/reports.json` | `{apiBasePath}/preview/app/reports.json` | 固定 `app=<resolved app>`、任意 `lang` | グラフ／集計定義 |
| `customize` | `{apiBasePath}/app/customize.json` | `{apiBasePath}/preview/app/customize.json` | 固定 `app=<resolved app>` | URL / file metadata のみ。ファイル download はしない |

`lang` は公式 enum に合わせて `"default" | "user" | "ja" | "en" | "zh"` だけを許す。省略時は API default を使い、R2 が暗黙に `user` を注入しない。query string は `URLSearchParams` だけで生成する。

### 3.3 明示的に除外する endpoint

| endpoint / group | R2 結論 | 根拠 |
|---|---|---|
| `records.json`、`record.json`、cursor、record comments | **除外** | 業務データであり metadata ではない。SELECT の `maxRecords`、complete-input、cursor、search-abort governance を二重化・迂回し、大量取得に使えるため |
| `apps.json` | **R2 初期は除外** | 公式契約上 API token 認証非対応で、Node token profile と不整合。さらに無条件 list を raw passthrough すると `allowPhysicalAppRefs:false` の logical-only 境界を結果 filter なしで保てない。既存 `ksql_show_apps` / SHOW APPS は維持する。将来追加するなら userpass-only、最大100 `ids` / `limit`、logical-only policy を別仕様で確定する |
| `app/acl.json`、`record/acl.json`、`field/acl.json` | **除外** | GET ではあるが user / group / organization code と権限条件を返す security metadata で、SQL schema 組み立ての中核ではない。最小権限 allowlist を優先し、必要性確認後に operator opt-in を伴う別 phase とする |
| space / member / thread metadata | **除外** | app 参照とは別 ID・権限・routing model で、B49 の app schema / settings 目的を越える |
| file download、plugin config、通知、action、category、admin memo、usage | **除外** | binary、秘密設定、API Lab、または目的の薄い管理情報まで allowlist を膨らませない。需要ごとに契約・認証・size をレビューして追加する |
| kintone API schema/list、外部 URL、任意 `/k/v1/*` | **除外** | allowlist 自体を実行時 discovery にすると未知 endpoint と write endpoint の混入を防げない。SSRF / capability escalation を避ける |

ACL は「GET だから安全」とはみなさない。公式の [アプリ ACL GET](https://cybozu.dev/ja/kintone/docs/rest-api/apps/settings/get-app-permissions/) が user / group / organization code を返すことを踏まえ、R2 は機密性と最小用途の観点から外す。

### 3.4 preview / production

- 既定は `preview:false`（運用環境）。
- `preview:true` は明示時のみ許可し、query parameter ではなく `{apiBasePath}/preview/...` path を選ぶ。
- `app` のように公式 preview GET がない resource で `preview:true` は production fallback せず schema error とする。
- preview GET で必要なアプリ管理権限は kintone に判定させ、権限不足を production へ fallback しない。
- response / audit metadata の `environment` に `"production" | "preview"` を必ず残す。

未デプロイ設定は SQL をデプロイ前に組み立てる用途に有効で、operation 自体は GET であるため R2 に含める。ただし暗黙 preview は採用しない。

### 3.5 response size、timeout、retry

- raw success body は **UTF-8 2 MiB（2,097,152 bytes）** を上限とする。MCP は text と structured content に同内容を持つため、無制限 response は process memory を二重に消費する。
- `Content-Length` が上限超過なら body parse 前に拒否する。header がない／信用できない場合も stream 読み取り中に実 byte を数え、超過時に body を cancel して `ResponseTooLargeError` とする。途中までの JSON を返さない。
- 2 MiB は R2 固定値とし、MCP input で引き上げられない。実機で正当な metadata が超える evidence が出た場合に operator-side config 化を再検討する。
- timeout は新しい自由入力を設けず、既存 runtime の env / profile / 既定30,000ms 解決を使う。現行は `input.timeout ?? env KSQL_TIMEOUT ?? profile.query.timeout ?? 30000` である（[src/node/runtime.ts:239-246](../../src/node/runtime.ts#L239)）。
- metadata GET は既存の process-global `RequestGate.runReadOnly` を通し、既存 retryable error のみ retry する。4xx、JSON parse error、size overflow、allowlist error は retry しない。
- retry の各 attempt も同じ固定 GET request を再構築する。POST fallback、method downgrade、別 endpoint fallback は禁止する。

### 3.6 監査性と秘匿

成功 payload に少なくとも次を含める。

```ts
{
  resource,
  environment,
  request: {
    method: "GET",
    endpoint,          // host を含まない allowlisted path
    app,               // caller が指定した number または LAPP string
    resolvedAppId,
    profile,
    params             // lang 等、secret を含まない正規化済み値
  },
  responseBytes,
  data
}
```

error payload にも解決済みで安全な範囲の `resource` / `environment` / `profile` / `app` を付ける。ただし token、password、Authorization header、base URL、raw error body 全体は audit metadata / log に出さない。既存 debug logger を使う場合も method、allowlisted endpoint、app、profile、status、bytes、duration、retry count までとし、`data` は log しない。

## 4. 設計 B — MCP ツール形

### 4.1 新ツール `ksql_app_metadata`

R2 は `ksql_describe_app` の拡張ではなく、**新ツール `ksql_app_metadata`** を追加する。

根拠は次のとおり。

- `ksql_describe_app` は SQL `DESCRIBE` の3列表という明確な既存契約である。
- layout / settings / views 等は「field describe」ではなく、format option を増やすと resource selector へ意味が変わる。
- 新ツールなら既存 schema / output / SQL parser / executor を変更しない純加法になる。
- `ksql_kintone_get` という名前は任意 URL / 任意 GET を期待させるため採用しない。`metadata` と命名して allowlist の狭さを contract にする。

`ksql_describe_app`、`ksql_query`、`DESCRIBE APPxxx` は一切変更しない。

### 4.2 入力 schema

概念型は次とする。

```ts
type AppRef = number | `LAPP_${string}`;
type Lang = "default" | "user" | "ja" | "en" | "zh";

type KsqlAppMetadataInput =
  | { resource: "app"; app: AppRef; profile?: string; preview?: false }
  | { resource: "layout" | "customize"; app: AppRef; profile?: string; preview?: boolean }
  | {
      resource: "fields" | "settings" | "status" | "views" | "reports";
      app: AppRef;
      profile?: string;
      preview?: boolean;
      lang?: Lang;
    };
```

制約:

- number app は positive safe integer。
- string app は `/^LAPP_[A-Za-z][A-Za-z0-9_]{0,63}$/i` だけを許す。SQL 断片、`APP123` string、`@profile`、subtable suffix を許さない。
- profile は既存 input と同じ独立 parameter。app string 内 profile と二重指定させない。
- discriminated union の各 branch を `.strict()` にし、たとえば `layout + lang`、`app + preview:true`、`ids`、`url`、`method` を拒否する。
- `apps.json` を R2 初期 allowlist に含めないため `ids` は R2 schema に存在しない。

### 4.3 出力 contract

API response を JSON object として parse した値を `structuredContent.data` に置く。`data` 内の key を rename / flatten / filter / type-normalize しない。wrapper の監査 metadata は `data` の外に置き、kintone response と混ぜない。

```json
{
  "ok": true,
  "type": "KINTONE_METADATA",
  "resource": "fields",
  "environment": "production",
  "request": {
    "method": "GET",
    "endpoint": "/k/v1/app/form/fields.json",
    "app": "LAPP_ORDERS",
    "resolvedAppId": 100,
    "profile": "prod",
    "params": { "lang": "user" }
  },
  "responseBytes": 12345,
  "data": {
    "properties": {},
    "revision": "7"
  }
}
```

`toToolResult` にこの wrapper を渡すため、text content も同じ wrapper の JSON、`structuredContent.data` は nested object になる。raw passthrough の同一性は「HTTP JSON を parse した object と `data` が deep-equal」で定義し、raw byte の whitespace、key order、JSON text の完全一致は契約にしない。

`resource:"fields"` では、必須、長さ／数値上下限、options、lookup / calc、SUBTABLE の入れ子、将来追加された unknown key を正規化前の response のまま `data` から読める。これが R1 の「Claude が制約を読む」を満たす主経路である。

## 5. 設計 C — 取得経路と非破壊性

### 5.1 core interface を変更しない

R2 では `src/execute.ts` の `KintoneClient` に必須・optional いずれの raw method も追加しない。現行 interface は record mutation と4種類の正規化 GET を必須メソッドとして持つ（[src/execute.ts:175-192](../../src/execute.ts#L175)）ため、ここへ `getRaw` や `getMetadata?` を追加する必要はない。

Node-only に別 interface を置く。

```ts
// src/node/kintoneMetadata.ts（概念）
export interface KintoneMetadataReader {
  getMetadata(request: AllowedMetadataRequest): Promise<RawMetadataResponse>;
}
```

`AllowedMetadataRequest` 自体が resource discriminated union であり、path / method を含まない。これにより core adapter / mock 群と plugin client は更新不要となる。

### 5.2 transport を共有する Node connection

現行 `requestJsonResponse` の認証、guest path、timeout、error 化を重複実装しないため、Node 内部に connection factory を切り出す。

```ts
// 概念。公開 core 型ではない。
createNodeKintoneConnection(baseUrl, tokenResolver): {
  client: KintoneClient;
  metadataReader: KintoneMetadataReader;
}
```

既存 `createNodeKintoneClient()` export は `createNodeKintoneConnection(...).client` を返す互換 wrapper として残す。metadata reader は同じ host、`apiBasePath`、auth resolver、AbortController transport を使うが、success response size cap と固定 GET assertion を有効にする。

### 5.3 allowlist / path 変換は1箇所

`src/node/kintoneMetadata.ts`（実装時の推奨配置）に次を1箇所だけ持つ。

- resource enum / discriminated request type
- resource ごとの production / preview path fragment
- 許可 parameter と `lang` 可否
- preview 可否
- auth capability（例: `customize` は Node の userpass profile のみ）
- fixed GET executor

MCP schema はこの resource constants から enum を構築する。MCP tools 側に第2の endpoint switch を複製しない。unknown resource、parameter mismatch、unsupported preview / auth は fetch 前に fail-closed とする。

### 5.4 metadata runtime と routing

Node-only `createKintoneMetadataRuntime` を追加し、既存 `createKsqlRuntime` と connection / config / binding resolver を内部共有する。MCP tool は安全な app ref から単一 binding context を作り、次を同じ順で行う。

1. default / explicit profile を既存規則で解決。
2. LAPP を `normalizeSqlAppProfiles` と同じ resolver で物理 app / profile へ解決。
3. `allowPhysicalAppRefs:false` を物理 app input に適用。
4. source-aware `cacheContext` を生成。
5. token map を物理 app / profile へ解決し、未知 profile / LAPP / token 欠落を request 前に拒否。
6. binding profile の `KintoneMetadataReader` を選び、物理 app ID を mapper に渡す。
7. process-global request gate の `runReadOnly` で1 GET を実行。

単一 app ref の解決で SQL executor は呼ばない。実装都合で safe synthetic SQL text を resolver scanner に渡す場合も parser / execute は呼ばず、生成文字列は検証済み AppRef だけから作る。より望ましい実装は既存 app resolution の内部 primitive を抽出し、SQL resolver と metadata resolver が共有することである。

`KsqlRuntime.client` に optional metadata 能力を cast して取り出す案は禁止する。runtime mock や core client が偶然 method を持つかどうかで安全性を変えず、MCP dependencies に `createMetadataRuntime` を明示注入できる別 contract とする。

### 5.5 cache

R2 は raw metadata cache を持たない。

- 1 tool call = 1 endpoint GET（retry attempt は除く）。
- metadata は頻繁に呼ばれず、production / preview の freshness が重要。
- raw object、とくに customize URL 等を process memory に長期保持しない。
- `cacheContext` は routing / source identity / audit の整合に使うが、raw response cache key にはまだ使わない。

同一 tool call 内で複数 resource を bundle する input も R2 では提供しない。必要な resource だけを明示的に1件取得し、size / error / audit を endpoint 単位に保つ。

### 5.6 auth capability の例外

公式契約上 `customize` GET は API token 認証をサポートしない。Node がサポートする auth は token と userpass なので、R2 の `customize` は userpass profile だけで実行可能とし、token profile では fetch 前に `CapabilityError` を返す。別 auth へ自動切替しない。

他の初期 allowlist resource は公式契約上 API token または password auth を利用できる。権限不足は kintone error をそのまま安全な MCP error envelope に変換し、より広い権限の profile や production path へ fallback しない。

## 6. 設計 D — その他

### 6.1 SQL / DESCRIBE / plugin の不変条件

- lexer、parser、AST、executor、CTE、batch envelope を変更しない。
- `DESCRIBE APPxxx` / `DESC APPxxx` は従来の3列、複数行の `SelectResult` のまま。
- `ksql_describe_app` は従来どおり `DESCRIBE` query wrapper のまま。
- plugin client と plugin build に metadata reader を追加しない。
- CLI に raw metadata command を追加しない。R2 は MCP-only。

### 6.2 既存／他 MCP との境界

R2 は kSQL MCP が SQL 作成に必要な app metadata を self-contained に取得するための機構である。別の公式 kintone MCP server の機能比較、置換、全 REST API proxy 化はスコープにしない。

## 7. 出力例

入力:

```json
{
  "resource": "fields",
  "app": "LAPP_ORDERS",
  "profile": "prod",
  "lang": "user",
  "preview": false
}
```

MCP text / structured payload の共通 object:

```json
{
  "ok": true,
  "type": "KINTONE_METADATA",
  "resource": "fields",
  "environment": "production",
  "request": {
    "method": "GET",
    "endpoint": "/k/v1/app/form/fields.json",
    "app": "LAPP_ORDERS",
    "resolvedAppId": 1234,
    "profile": "prod",
    "params": {
      "lang": "user"
    }
  },
  "responseBytes": 6412,
  "data": {
    "properties": {
      "案件名": {
        "code": "案件名",
        "label": "案件名",
        "type": "SINGLE_LINE_TEXT",
        "required": true,
        "minLength": "1",
        "maxLength": "100"
      },
      "明細": {
        "code": "明細",
        "label": "明細",
        "type": "SUBTABLE",
        "fields": {
          "数量": {
            "code": "数量",
            "label": "数量",
            "type": "NUMBER",
            "minValue": "0"
          }
        }
      }
    },
    "revision": "7"
  }
}
```

この JSON は passthrough contract を示す合成例であり、個々の field property の存在を kintone 全環境へ断定する fixture ではない。

allowlist 外 input の例:

```json
{
  "resource": "records",
  "app": 1234,
  "method": "GET",
  "path": "/k/v1/records.json"
}
```

これは schema で `resource`、`method`、`path` のすべてについて request 前に拒否され、Node transport 呼び出し回数は0でなければならない。

## 8. SemVer

推奨は **minor** である。現行 version は `3.8.0`（[package.json:1-4](../../package.json#L1)）。

- MCP に optional な新ツールを1本追加する純加法。
- 既存 tool 名、input schema、output shape、SQL 文法、DESCRIBE 結果を変更しない。
- public core `KintoneClient` interface を変更しない。
- Node 内部に metadata reader / runtime を追加するだけで plugin client を変更しない。

R1 のように `KintoneClient` へ必須メソッドを足す案は source-breaking のため採用しない。将来 allowlist resource を追加する変更も、既存 enum 値の意味を変えず追加だけなら minor とする。既存 resource の path / raw response を kSQL 独自 shape に変更する場合は別途互換性判断が必要である。

## 9. 費用対効果

### 効果

- Claude の「DESCRIBE → 不足発見 → 別 REST tool 探索 → GET → 統合」を `ksql_app_metadata` 1 call に短縮する。
- fields、layout、settings、status、views、reports、customize を同じ routing / auth / audit / error contract で扱える。
- raw passthrough により kSQL の正規化型が未追随の property も読むことができる。
- URL / method を開放しないため、「REST proxy 1本」の利便性を危険な万能 proxy にしない。
- SQL / core / plugin を変更しないので R1 より回帰面と adapter / mock 更新量が小さい。

### コスト

- Node transport の内部 factory 化と success body size cap。
- metadata resource map、reader、runtime、LAPP/profile/token routing の配管。
- MCP schema / tool registration / error and audit wrapper。
- resource ごとの公式 endpoint、preview、lang、auth 契約を allowlist 追加時に保守するコスト。
- MCP smoke と Node integration test の追加。

allowlist の保守は意図的なコストである。kintone の GET endpoint が増えても自動 discovery / prefix 許可せず、resource ごとに用途・認証・size・機密性をレビューして明示追加する。

## 10. テスト観点

### 10.1 read-only / allowlist

- MCP schema に `url` / `path` / `endpoint` / `method` / `headers` / `body` / arbitrary query が存在しない。
- schema `.strict()` が unknown key を拒否する。
- Node mapper も unknown resource / parameter combination を fetch 前に拒否する。
- allowlist の全 entry が固定 `GET` であり、transport spy で POST / PUT / DELETE が0回。
- `records`、`record`、`cursor`、ACL、space、file、API discovery、absolute URL、protocol-relative URL、`..`、encoded slash を一切 path 化できない。
- `ksql_mutate` の `allowDml` / `confirmText` や executor の `allowApplyMutation` を metadata tool が設定・呼出ししない。
- allowlist failure、auth failure、size overflow の後も fallback request が0回。

### 10.2 endpoint mapping / guest / preview

- 8 resource の production path が表と一致する。
- guest space は `/k/guest/{id}/v1/...` を使う。
- preview は `/v1/preview/...`、guest preview は `/k/guest/{id}/v1/preview/...` の順になる。
- `app + preview:true` を拒否し、production へ fallback しない。
- `lang` は5 enum だけ。対応 resource 以外の `lang` を拒否する。
- query value は `URLSearchParams` で encode され、resource / path fragment は入力値から作られない。

### 10.3 LAPP / profile / auth routing

- positive numeric app と `LAPP_NAME` が同じ resolver を通る。
- unknown LAPP、undefined profile、`allowPhysicalAppRefs:false` の物理 app、token 欠落を request 前に fail-closed。
- logical binding は single `KSQL_TOKEN` fallback を使わない。
- mapped ID ではなく resolved physical ID を query parameter と token resolver に渡す。
- profile ごとに base URL / guestSpaceId / auth が正しく選ばれ、default profile client に固定されない。
- `customize + token profile` は request 前 `CapabilityError`、userpass profile は固定 GET を実行する。
- error / result に profile、source app、resolved app を記録し、secret を含めない。

### 10.4 response / size / retry

- `structuredContent.data` が response object と deep-equal。unknown key、nested object / array、empty string、boolean、null を保持する。
- text JSON を parse すると structuredContent 全体と deep-equal。
- wrapper metadata を `data` 内に注入しない。
- `Content-Length > 2 MiB` を body parse 前に拒否。
- Content-Length なし／虚偽で chunked body が2 MiBを超える場合も読み取り途中で cancel し、partial data を返さない。
- exactly 2 MiB は許可し、2 MiB + 1 byte は拒否する。
- timeout / 408 / 429 / 502 / 503 / 504 / network error は既存 `runReadOnly` 規則で retry。
- 400 / 401 / 403 / 404、parse error、size overflow、allowlist error は retry しない。
- retry 後も request method / endpoint / app / params が完全一致する。
- raw cache を持たないため、同じ tool call を2回行うと成功 GET も2回。異なる preview/profile を誤共有しない。

### 10.5 MCP / regression

- `ksql_app_metadata` registration、title、description、resource enum の tools/list snapshot。
- `runSafely` error envelope と `isError:true`。
- 現行 `ksql_describe_app` が `DESCRIBE APPn` を生成し続け、schema / output snapshot が不変。
- parser / AST / DESCRIBE executor / CTE / batch tests に差分がない。
- core mock clients に新しい必須／optional method が要求されないことを TypeScript build で確認。
- `npm run build:mcp`、`npm run mcp:smoke`、`npm run mcp:pack-smoke`。
- plugin bundle source / `src/ui/kintoneClient.ts` / plugin DESCRIBE test が無変更で、`npm run build:plugin` の回帰のみ確認。

### 10.6 公式契約の fixture

- resource ごとに公式 response の最小 fixture を持つが、kSQL 独自 schema validation はしない。
- fields fixture は options、lookup、calc、SUBTABLE nested fields、unknown sentinel を含める。
- settings fixture は `numberPrecision` と unknown setting を含め、`parseNumberPrecisionSettings` を通らず保持する。
- views custom HTML、reports filter / aggregation、customize URL / file metadata を byte cap 内で保持する。
- preview 権限不足と production 権限不足を別 error として保持し、環境 fallback しない。

## 11. 決定点

次は R2 の推奨であり、Claude / ユーザー承認までは実装確定としない。

| ID | 決定点 | 選択肢 | R2 推奨 |
|---|---|---|---|
| D1 | MCP surface | `ksql_describe_app` 拡張 / 新 tool / SQL | **新 `ksql_app_metadata`**。既存 DESCRIBE と SQL は不変 |
| D2 | request abstraction | 任意 GET path / allowlisted resource enum | **resource enum**。URL / method / body は入力不可 |
| D3 | 初期 allowlist | 最小8 resource / 全 app settings GET | **app, fields, layout, settings, status, views, reports, customize** |
| D4 | records | GET なので含める / 除外 | **除外**。SELECT governance 迂回と大量業務データ取得を防ぐ |
| D5 | ACL | 初期 allowlist / opt-in / 除外 | **R2 は除外**。identity / security metadata は需要確認後の別 phase |
| D6 | apps.json | 初期 allowlist / 既存 SHOW APPS に残す | **R2 は除外**。API token 非対応と logical-only policy / raw の不整合 |
| D7 | preview | 禁止 / default preview / explicit boolean | **既定 production、明示 `preview:true` のみ許可**。非対応 resource は fail-closed |
| D8 | response | 正規化 / raw data + wrapper | **`structuredContent.data` に parse 済み raw object**。監査 metadata は外側 |
| D9 | size cap | なし / 1 MiB / 2 MiB / configurable | **固定2 MiB**。正当な超過 evidence 後に再検討 |
| D10 | cache | raw cache / tool-call cache / なし | **なし**。freshness と memory / sensitive metadata 保持を優先 |
| D11 | client capability | core 必須 / core optional / Node-only separate interface | **Node-only `KintoneMetadataReader`**。core interface を触らない |
| D12 | auth-specific resource | token で試行 / auth fallback / preflight | **`customize` は userpass-only preflight**。fallback なし |
| D13 | SemVer | patch / minor / major | **minor**。新 MCP tool の純加法、core / SQL 非破壊 |

Claude レビューでは特に D2〜D7、D9、D11〜D12 を安全性観点で確認する。

## 12. スコープ外

- `DESCRIBE ... AS JSON`、その他の SQL grammar / AST / executor 拡張。
- 既存 DESCRIBE の列追加、raw cell、新 result type。
- core `KintoneClient` interface の必須／optional method 追加。
- plugin / browser client、plugin UI、plugin SQL、CLI command の raw metadata 対応。
- records / cursor / comments / file download、ACL、space、user / group / organization、通知、action、API Lab、API discovery。
- arbitrary URL / endpoint / HTTP method / header / body / query proxy。
- 複数 resource の bundle fetch、resource 間 join / merge、schema normalization。
- raw response の永続／process cache。
- official kintone MCP server との機能比較や置換。
- B49 R2 作成時点でのコード実装、version bump、manifest / changelog 更新、commit。

## 13. 完了条件

1. MCP input から GET 以外、allowlist 外 path、records / ACL / space へ到達不能である。
2. allowlist と resource-to-path / parameter / preview / auth mapping がNodeの1箇所に集約される。
3. fields raw response が `structuredContent.data` に欠落なく入り、R1 の目的を満たす。
4. LAPP / profile / `allowPhysicalAppRefs` / token / guest space を既存 resolver と同じ fail-closed 規則で扱う。
5. response 2 MiB上限、既存 timeout、`runReadOnly` retry、audit metadata が機能する。
6. core `KintoneClient`、SQL、DESCRIBE、CTE、batch、plugin が不変である。
7. D1〜D13 がレビューされ、特に read-only 二重強制と allowlist の最小性が承認される。
