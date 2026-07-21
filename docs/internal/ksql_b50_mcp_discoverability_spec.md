# B50 — MCP の能力・方言 discoverability 仕様 R1

- 作成日: 2026-07-21
- ステータス: **R1・Claude レビュー Approved・v3.9.0 実装中**（SDK 1.29.0 の instructions/registerResource 対応を裏取り済み）
- 対象: B50「MCP で kSQL の能力・方言が discoverable でない」
- 一次情報: [ksql_issue_tracker.md B50](../ksql_issue_tracker.md#L41)
- 対象リリース: **v3.9.0（B43 / B49 と同梱）**
- 対象ブランチ: `feat/b43-dml-prevalidation`

## 0. R1 の結論

B50 は次の3層を、費用対効果の高い順に純加法で追加する。

1. **必須:** MCP server `instructions` に、kSQL の能力、標準 SQL と異なる要注意点、検証／メタデータ／詳細文書への導線を短く載せる。
2. **必須:** 言語リファレンスとバッチレシピを、MCP の固定 index resource と章別 resource template で公開する。新 `ksql_help` tool は R1 では追加しない。
3. **必須:** `ksql_app_metadata` / `ksql_describe_app` の description を用途起点に直し、`ksql_query` / `ksql_mutate` から instructions と language-reference resource へ誘導する。

文書は **build 時に文字列として `dist-mcp/ksql-mcp.js` へ埋め込む**。実行時ファイル読みは採らない。index resource は短い目次と URI 導線だけを返し、本文は章単位でオンデマンド取得する。これにより initialize 時のコンテキストを増やすのは短い instructions だけで、約3,000行の言語リファレンス全文を毎回投入しない。

ただし、SDK が initialize 応答に `instructions` を含められることと、個々の MCP クライアントがそれを LLM へどう提示するかは別契約である。SDK 型自身も「system prompt に追加 **され得る**（MAY）」とするだけである（[SDK spec.types.d.ts:251-267](../../node_modules/@modelcontextprotocol/sdk/dist/esm/spec.types.d.ts#L251)）。したがって Claude 実クライアントでの instructions / resources 可視性を v3.9.0 の受入 smoke に含める。

## 1. 症状

B50 の一次情報は、Claude が kSQL 独自機能・方言を知らず標準 SQL 前提で生成し、`ksql_validate` エラーを経て試行錯誤すること、現状の知識経路が tool description とモデル学習知識に限られることを記録している（[ksql_issue_tracker.md:41](../ksql_issue_tracker.md#L41)）。同じ行は対策順を server instructions、language reference / recipes の resource または help tool、tool description 改善とし、v3.9.0 で B43 / B49 と同梱すると決めている。

kSQL の入口は標準 SQL に似るが、実装済み statement 群は SELECT だけではない。parser の dispatch は `WITH`、SELECT、INSERT、UPDATE、DELETE、REORDER、UPSERT、SHOW、DESCRIBE、EXPLAIN、SET、ASSERT、CREATE/DROP TEMP TABLE、DECLARE、VALIDATE、capability-gated IMPORT を受理する（[src/parser/parser.ts:245-281](../../src/parser/parser.ts#L245)）。

```ts
switch (tok.kind) {
  case TokenKind.WITH:     return this.parseWith();
  case TokenKind.SELECT:   return this.tryParseUnionChain(this.parseSelect(true));
  case TokenKind.INSERT:   return this.parseInsert();
  case TokenKind.UPDATE:   return this.parseUpdate();
  case TokenKind.DELETE:   return this.parseDelete();
  case TokenKind.REORDER:  return this.parseReorder();
  case TokenKind.UPSERT:   return this.parseUpsert();
  // ... SET / ASSERT / DECLARE / VALIDATE / IMPORT
}
```

集計には `GROUP_CONCAT`、ウィンドウ関数には `ROW_NUMBER` / `RANK` / `DENSE_RANK` が実装されている（[src/parser/parser.ts:1100-1118](../../src/parser/parser.ts#L1100)、[src/parser/parser.ts:1169-1185](../../src/parser/parser.ts#L1169)）。バッチ変数は `SET @name = ...` と `DECLARE @name = ...` を別 AST にする（[src/parser/parser.ts:290-309](../../src/parser/parser.ts#L290)）。これらを個別 tool の実行契約だけから推測させるのは、言語 discoverability として不十分である。

## 2. 現状の裏取り

### 2.1 MCP server に `instructions` がない

現行 `createServer` は `McpServer` の第1引数に name / version だけを渡し、第2引数を渡していない（[src/mcp/index.ts:68-81](../../src/mcp/index.ts#L68)）。

```ts
export function createServer(args: ServerArgs): McpServer {
  const server = new McpServer({
    name: "ksql-mcp",
    version: SERVER_VERSION,
  });
```

依存宣言は `@modelcontextprotocol/sdk: ^1.29.0`（[package.json:49-54](../../package.json#L49)）、lockfile の実解決版は **1.29.0**（[package-lock.json:1302-1306](../../package-lock.json#L1302)）である。

この SDK の型では `McpServer` constructor は `constructor(serverInfo: Implementation, options?: ServerOptions)` である（[SDK server/mcp.d.ts:14-24](../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts#L14)）。`instructions` は第1引数の `Implementation` ではなく、第2引数 `ServerOptions` の optional string である（[SDK server/index.d.ts:7-15](../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.d.ts#L7)）。したがって実装形は次でなければならない。

```ts
export type ServerOptions = ProtocolOptions & {
  capabilities?: ServerCapabilities;
  instructions?: string;
};

export declare class McpServer {
  constructor(serverInfo: Implementation, options?: ServerOptions);
}
```

```ts
new McpServer(
  { name: "ksql-mcp", version: SERVER_VERSION },
  { instructions: KSQL_MCP_INSTRUCTIONS }
)
```

runtime も `options?.instructions` を保持し（[SDK server/index.js:49-52](../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js#L49)）、initialize 応答へ条件付きで含める（[SDK server/index.js:270-280](../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js#L270)）。SDK client は応答値を保存し `getInstructions()` で公開する（[SDK client/index.js:305-345](../../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js#L305)）。

```js
this._instructions = options?.instructions;
// ... initialize response
...(this._instructions && { instructions: this._instructions })
```

**結論:** SDK 1.29.0 は server instructions を型・runtime・client の三層でサポートする。B50 の A は SDK 更新なしで実装可能である。

### 2.2 MCP resource は未公開だが SDK は対応済み

現行 server 登録部は `server.registerTool(...)` を並べ、最後の tool 登録後にそのまま server を返す（[src/mcp/index.ts:83-155](../../src/mcp/index.ts#L83)）。次の検索は0件である。

```text
rg -n "registerResource|\.resource\(" src/mcp/index.ts src/mcp/tools.ts
# no matches
```

SDK 1.29.0 の `McpServer` 型は、固定 URI と `ResourceTemplate` の両方に `registerResource` overload を持つ（[SDK server/mcp.d.ts:78-103](../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts#L78)）。固定 resource callback は `ReadResourceResult` を返す（[SDK server/mcp.d.ts:294-302](../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts#L294)）。

```ts
registerResource(
  name: string,
  uriOrTemplate: string,
  config: ResourceMetadata,
  readCallback: ReadResourceCallback
): RegisteredResource;
```

resource を1件でも登録すると、SDK runtime は resource capability を登録し、`resources/list` と `resources/read` handler を設定する（[SDK server/mcp.js:332-395](../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js#L332)）。protocol 型にも `resources/list` と `resources/read` があり、read 結果は text/blob contents の配列である（[SDK spec.types.d.ts:619-632](../../node_modules/@modelcontextprotocol/sdk/dist/esm/spec.types.d.ts#L619)、[SDK spec.types.d.ts:664-685](../../node_modules/@modelcontextprotocol/sdk/dist/esm/spec.types.d.ts#L664)）。text resource は `uri`、optional `mimeType`、`text` を持つ（[SDK spec.types.d.ts:827-852](../../node_modules/@modelcontextprotocol/sdk/dist/esm/spec.types.d.ts#L827)）。

```js
this.server.registerCapabilities({ resources: { listChanged: true } });
this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return { resources: [...resources, ...templateResources] };
});
this.server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
  // fixed URI または template の callback を呼ぶ
});
```

**結論:** SDK 1.29.0 は `resources/list` / `resources/read` と `McpServer.registerResource` をサポートする。B50 の B も SDK 更新なしで実装可能である。

### 2.3 現行 tool description の情報量

`ksql_query` の tool description は read-only statement、LIMIT / ORDER、VALIDATE、APPLY VALIDATE ONLY、batch / temp table、安全境界を詳述するが、JOIN / CTE / UNION の一部を除き `GROUP_CONCAT`、window、KLIKE / KORDER、UPDATE FROM、IMPORT、サブテーブル仮想テーブル、LAPP 等の全体像や言語リファレンスへの導線はない（[src/mcp/index.ts:95-99](../../src/mcp/index.ts#L95)）。input schema の SQL description も batch / temp / APPLY VALIDATE ONLY が中心である（[src/mcp/schemas.ts:67-87](../../src/mcp/schemas.ts#L67)）。

`ksql_mutate` は DML safety、SELECT-based DML、UPDATE FROM、ON ERROR SKIP、APPLY mutation の fail-close を詳述する（[src/mcp/index.ts:101-105](../../src/mcp/index.ts#L101)）。input schema も DML batch と APPLY rejection を説明する（[src/mcp/schemas.ts:89-111](../../src/mcp/schemas.ts#L89)）。これは実行安全契約として有用だが、言語全体の索引ではない。

`ksql_describe_app` は現在 `"Return field definitions ..."` の1文だけで（[src/mcp/index.ts:107-111](../../src/mcp/index.ts#L107)）、実体も `DESCRIBE APP...` を query へ委譲する（[src/mcp/tools.ts:928-936](../../src/mcp/tools.ts#L928)）。DESCRIBE の結果はフィールドコード／ラベル／タイプの3列である（[src/execute.ts:7505-7517](../../src/execute.ts#L7505)）。完全な制約 JSON を得る tool への誘導はない。

`ksql_app_metadata` は現在、固定 allowlist の read-only metadata で records / mutation は不可とだけ説明する（[src/mcp/index.ts:113-117](../../src/mcp/index.ts#L113)）。実装上は `app`, `fields`, `layout`, `settings`, `status`, `views`, `reports`, `customize` の8 resource が列挙済み（[src/node/kintoneMetadata.ts:1-10](../../src/node/kintoneMetadata.ts#L1)）で、戻り値には GET endpoint、解決 app/profile、response bytes、生 `data` が入る（[src/mcp/tools.ts:939-970](../../src/mcp/tools.ts#L939)）。description はこの具体的な利用価値を伝えていない。

現行 description の情報密度は次の実コードに表れている（tool 本体: [src/mcp/index.ts:95-117](../../src/mcp/index.ts#L95)、SQL parameter: [src/mcp/schemas.ts:67-91](../../src/mcp/schemas.ts#L67)）。

```ts
sql: z.string().min(1).describe(
  "Read-only kSQL text. May contain multiple ;-separated statements (batch) with temp tables, e.g. CREATE TEMP TABLE #t AS SELECT ...; SELECT ... FROM #t. UPDATE/INSERT/UPSERT/multi-value APPLY VALIDATE ONLY is allowed with the fixed dmlMaxSubtableRows default 500; this schema exposes no override and never enables APPLY mutation."
)
sql: z.string().min(1).describe(
  "DML kSQL text. May contain multiple ;-separated statements (batch) with temp tables, e.g. CREATE TEMP TABLE #t AS SELECT ...; INSERT INTO APPx (...) SELECT ... FROM #t. Every APPLY mutation form (UPDATE/INSERT/UPSERT/multi-value) is rejected by MCP v3.8.0 before runtime or records API creation."
)
server.registerTool("ksql_describe_app", {
  description: "Return field definitions for a kintone app using DESCRIBE APPxxx.",
});
server.registerTool("ksql_app_metadata", {
  description: "Read-only app metadata (GET) from a fixed allowlist; records and mutation operations are not available.",
});
```

description drift guard はすでに `mcp-smoke` にあり、全文一致ではなく重要部分文字列を固定する設計である（[scripts/mcp-smoke.mjs:150-192](../../scripts/mcp-smoke.mjs#L150)）。B50 の変更もこの方式へ追加する。

### 2.4 公開済み文書資産

`docs/ksql_language_reference.md` は「利用できる構文・演算子・関数をすべて説明する」と明記し（[docs/ksql_language_reference.md:1-8](../ksql_language_reference.md#L1)）、目次は SELECT、JOIN、GROUP BY、window、UNION、CTE、DML、IMPORT、サブテーブル、REORDER、制限事項、batch、ASSERT まで26章を持つ（[docs/ksql_language_reference.md:12-41](../ksql_language_reference.md#L12)）。ファイル末尾は2977行目である（[docs/ksql_language_reference.md:2966-2977](../ksql_language_reference.md#L2966)）。作業時実測は UTF-8 160,416 bytes であり、全文を1回の `resources/read` で返すには大きい。

`docs/ksql_batch_recipes.md` は batch / temp / ASSERT / UPSERT / variables を組み合わせた安全なリラン可能バッチ集であり、CLI と MCP を対象にする（[docs/ksql_batch_recipes.md:1-7](../ksql_batch_recipes.md#L1)）。R1〜R12 の章があり（例: [docs/ksql_batch_recipes.md:48-133](../ksql_batch_recipes.md#L48)、[docs/ksql_batch_recipes.md:454-532](../ksql_batch_recipes.md#L454)）、末尾は559行目（[docs/ksql_batch_recipes.md:548-559](../ksql_batch_recipes.md#L548)、作業時実測 48,571 bytes）である。

```md
# kSQL 言語リファレンス
1. 基本ルール
2. SELECT
...
25. バッチ実行と一時テーブル
26. ASSERT

# kSQL バッチ設計レシピ集
## R1. 差分更新バッチ（復旧 → 確保 → 処理 → 完了）
...
## R12. cli-kintone と round-trip する
```

よって新たな help 文書を複製する必要はない。上記2文書を source of truth とし、MCP は索引と章別 view を生成する。

### 2.5 方言上の要注意点は実装に存在する

instructions に入れる注意点は台帳の列挙だけでなく、次の実コードで固定されている。

- JOIN `ON` は左右の識別子を `=` 1個で結ぶ AST しか生成しない（[src/parser/parser.ts:1881-1920](../../src/parser/parser.ts#L1881)）。AND / OR や不等値 JOIN 条件を読む経路はない。
- FROM は table name、temp table、CTE、APP / subtable 参照を読む `parseTableRef()` で、`FROM (` の派生テーブルを読む分岐がない（[src/parser/parser.ts:1823-1847](../../src/parser/parser.ts#L1823)）。代替は WITH / temp table とする。
- LIKE は kintone query へ変換せず JS 評価が必要である（[src/converter/whereToKintone.ts:58-66](../../src/converter/whereToKintone.ts#L58)）。一方 KLIKE は parser が専用 `KLIKE` / `NOT_KLIKE` AST を生成する（[src/parser/parser.ts:2047-2077](../../src/parser/parser.ts#L2047)）。
- KORDER BY は top-level SELECT だけで許可し、nested 利用を parser が拒否する（[src/parser/parser.ts:939-950](../../src/parser/parser.ts#L939)）。
- 数値算術で空セルを0とする挙動は公開仕様に明記され、`金額 + 1` の例もある（[docs/ksql_language_reference.md:266-298](../ksql_language_reference.md#L266)）。
- subtable virtual table の synthetic columns は `_rid`=string、`_idx` / `_pid`=number として実行器が解決する（[src/execute.ts:2078-2085](../../src/execute.ts#L2078)）。
- APPLY、VALIDATE ONLY、ON ERROR SKIP、CHECK は INSERT / UPSERT AST に明示的に保持される（[src/types/ast.ts:618-661](../../src/types/ast.ts#L618)）。ただし現行 MCP は APPLY mutation を明示的に拒否し、VALIDATE ONLY / EXPLAIN だけを許す（[src/mcp/index.ts:83-103](../../src/mcp/index.ts#L83)）。instructions は「APPLY が使える」とだけ書いて mutation 可能と誤認させてはならない。
- `ksql_validate` は kintone API を呼ばない parse/static validation tool である（[src/mcp/index.ts:83-87](../../src/mcp/index.ts#L83)）。DML のデータ／フォーム制約を事前確認する場合は `... VALIDATE ONLY` を `ksql_query` で実行する（[src/mcp/index.ts:95-99](../../src/mcp/index.ts#L95)）。この2種類を instructions で区別する。

### 2.6 bundle / package 制約

MCP build は `src/mcp/index.ts` を entry point とし、esbuild の `bundle: true`、Node 18、CJS、出力1ファイル `dist-mcp/ksql-mcp.js` である（[build-mcp.mjs:13-22](../../build-mcp.mjs#L13)）。build 後に SDK / Zod の外部 require が残れば失敗する（[build-mcp.mjs:31-37](../../build-mcp.mjs#L31)）。同じ禁止条件を `mcp-smoke` も検査する（[scripts/mcp-smoke.mjs:34-45](../../scripts/mcp-smoke.mjs#L34)）。

```js
await esbuild.build({
  entryPoints: [resolve("src/mcp/index.ts")],
  outfile: resolve("dist-mcp/ksql-mcp.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
});

if (forbiddenRuntimeImports.some((pattern) => pattern.test(bundled))) {
  throw new Error("[kSQL] mcp bundle contains external MCP SDK or zod imports.");
}
```

npm package の `files` は `dist-cli/`, `dist-mcp/`, `dist-mcpb/`, README, LICENSE, package.json だけで、`docs/` を含まない（[package.json:41-47](../../package.json#L41)）。pack smoke は production consumer に SDK / Zod が入らないことと、packed `dist-mcp/ksql-mcp.js` が起動することを確認する（[scripts/mcp-pack-smoke.mjs:181-195](../../scripts/mcp-pack-smoke.mjs#L181)）。MCPB も `dist-mcp/ksql-mcp.js` をそのまま `server/ksql-mcp.js` として格納する（[build-mcpb.mjs:108-124](../../build-mcpb.mjs#L108)）。

したがって runtime `readFileSync("docs/...")` は、npm install 先・MCPB・cwd のいずれでも成立を保証できない。docs を package files に追加して相対 path を解決する案より、build 時 embed の方が既存 self-contained 契約を保ち、配布面を1つにできる。

## 3. 設計 A — server `instructions`

### 3.1 粒度

instructions は **英語 150〜220 words 程度、3段落以内**を目安とする。initialize 時に毎回渡るため、構文例、全関数一覧、resource 本文、個別 safety option の説明は載せない。

必須情報は次の3群に絞る。

1. **能力索引:** SELECT / JOIN / aggregate / CTE / UNION / window / `GROUP_CONCAT`; INSERT / UPDATE / UPSERT / DELETE / UPDATE FROM; subtable virtual table / APPLY / REORDER / IMPORT; VALIDATE / VALIDATE ONLY / ON ERROR SKIP / CHECK; KLIKE / KORDER; batch/temp/SET/DECLARE; LAPP; app metadata。
2. **誤生成しやすい差分:** LIKE は JS、JOIN ON は単一等値、FROM 派生テーブルなし、数値算術の空セル=0、APPLY mutation は MCP では閉じる。
3. **行動導線:** generated SQL はまず `ksql_validate`; DML の実データ制約確認は `VALIDATE ONLY`; form 制約は `ksql_app_metadata`; 詳細は resource index。

### 3.2 文面ドラフト

```text
kSQL is a SQL-like dialect for kintone, not generic SQL. It supports SELECT,
JOIN, aggregates, CTEs, UNION, ROW_NUMBER/RANK/DENSE_RANK, GROUP_CONCAT,
INSERT/UPDATE/UPSERT/DELETE, UPDATE ... FROM, subtable virtual tables
(APPxxx$table with _pid/_rid/_idx), REORDER, IMPORT, VALIDATE/VALIDATE ONLY,
ON ERROR SKIP, CHECK, KLIKE, KORDER BY, and multi-statement batches with temp
tables and SET/DECLARE @variables. LAPP_<NAME> resolves logical apps.

Important dialect rules: LIKE/NOT LIKE uses JavaScript semantics and is not a
kintone-native predicate; JOIN ON accepts one equality only; FROM (SELECT ...)
derived tables are unsupported (use WITH or a temp table); numeric arithmetic
treats an empty cell as 0. APPLY syntax can be validated/explained and used with
VALIDATE ONLY, but APPLY mutation is disabled by this MCP server.

Validate generated syntax with ksql_validate before execution. For DML form/data
preflight, execute the statement with VALIDATE ONLY through ksql_query before
ksql_mutate. Use ksql_app_metadata (especially resource=fields/settings) to
inspect raw app constraints before generating SQL or DML. Read
ksql://language-reference and ksql://recipes for section indexes, then read only
the relevant section resource.
```

文面は tool schema を置き換えない。`allowDml` / `confirmText` / row caps 等の正確な実行契約は各 tool description / schema に残す。

## 4. 設計 B — language reference / recipes の MCP 露出

### 4.1 resource vs tool

R1 は **resource を採用し、`ksql_help` tool は追加しない**。

理由は次のとおり。

- SDK 1.29.0 に正式な `registerResource`、`resources/list`、`resources/read` があり、SDK 更新コストがない（§2.2）。
- 文書は副作用のない参照情報であり、実行 action を表す tool より resource の意味に合う。
- tools/list に新しい擬似実行 tool と section schema を増やさず、既存 tool と文書の責務を分離できる。
- build 時 embed なら runtime path / package 同梱問題はない。

弱点は、SDK 対応が Claude 等すべての client の resource UX を保証しないことである。R1 は Claude 実クライアント smoke を gate とし、resource が一覧／読取できない場合だけ、同じ埋め込み asset を返す `ksql_help(section)` を B50 の互換 fallback として再判断する。検証せず最初から二重 surface を持たない。

### 4.2 URI と出力 contract

固定 index resource:

| name | URI | MIME | 内容 |
|---|---|---|---|
| `ksql-language-reference` | `ksql://language-reference` | `text/markdown` | 文書概要、H2章一覧、各章 URI、更新元 |
| `ksql-recipes` | `ksql://recipes` | `text/markdown` | 文書概要、設計原則、R1〜R12 URI |

章別 resource template:

| name | URI template | 内容 |
|---|---|---|
| `ksql-language-reference-section` | `ksql://language-reference/{section}` | 指定した top-level H2 章本文 |
| `ksql-recipe` | `ksql://recipes/{recipe}` | 指定した Rn 章本文 |

`section` / `recipe` は build 時に生成した allowlist key だけを許可する。未知 key は `InvalidParams` 相当で fail-closed とし、任意 file path、URL、doc path を受け付けない。index には機械生成した有効 key と URI をすべて載せる。

固定 index を `resources/list` に出し、template は SDK の `resources/templates/list` に出す。client が template UI を持たなくても、index 本文に具体的な read URI があるため、resource read capability があれば章へ到達できる。受入テストでは index と代表章を実際に `resources/read` する。

章別 template は `new ResourceTemplate(pattern, { list: undefined, complete: ... })` とする。SDK 型は `list` を明示必須（値は `undefined` 可）とし、variable ごとの completion callback も持てる（[SDK server/mcp.d.ts:219-244](../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts#L219)）。`list: undefined` により全章を `resources/list` へ重複列挙せず、`complete.section` / `complete.recipe` は build 時 allowlist key を返す。

### 4.3 全文1 resource を採らない理由

言語リファレンスは2977行／160,416 bytes、レシピは559行／48,571 bytes ある（§2.4）。bundle へ全内容を入れること自体は現行約2.0 MB bundle に対して約209 KBの増加で許容候補だが、`resources/read` 1回で全文を LLM context に返すと必要章以外まで消費する。

よって **bundle への格納は全文、resource 応答は index + 章別**とする。bundle size と prompt size を分けて評価する。initialize 応答には本文を含めない。

### 4.4 build 時 embed

`build-mcp.mjs` が2文書を UTF-8 で読み、H2見出し単位に分割して、esbuild `define` または build 専用 virtual module で immutable string map として bundle へ埋め込む。実装方式の細部は実装計画で選べるが、次の contract は固定する。

1. production bundle の resource callback は filesystem / cwd / `__dirname` に依存しない。
2. source of truth は既存2文書だけで、本文コピーを `src/` に手管理しない。
3. H2 parse 失敗、重複 key、必須章欠落、空文書は build error。
4. index と section map は同じ build artifact から生成し、URI drift を作らない。
5. build / smoke の外部 require guard を維持する。
6. resource response は `{ contents: [{ uri, mimeType: "text/markdown", text }] }` とする。

実行時ファイル読み案は却下する。`docs/` が npm `files` に入らず、MCPB も bundle だけを server 配下へ入れる現状（§2.6）と両立しないためである。

### 4.5 公開範囲

- **必須:** `docs/ksql_language_reference.md`
- **推奨かつ R1 対象:** `docs/ksql_batch_recipes.md`
- **対象外:** migration guide、internal specs、issue tracker、README、CHANGELOG、release notes

internal 文書を resource 化すると未確定設計や実装履歴まで一般利用者へ露出するため、B50 の言語 discoverability 目的を超える。

## 5. 設計 C — tool description 改善

### 5.1 `ksql_app_metadata`

用途起点の draft:

```text
Inspect raw read-only kintone app metadata before generating SQL or DML: app,
fields (constraints and field properties), layout, settings, status, views,
reports, and customize. This is the primary route for constraints not included
in ksql_describe_app. Returns raw JSON through a fixed GET allowlist; records and
mutation operations are not available.
```

これにより B49 の安全契約（read-only / fixed GET allowlist / recordsなし / mutationなし）を落とさず、fields=制約、layout/settings/status/views/reports/customize、生 JSON、SQL/DML 構築前の主経路を伝える。resource enum と raw result の実装根拠は §2.3 のとおりである。

### 5.2 `ksql_describe_app`

draft:

```text
Return kSQL's compact field list (field code, label, and type) for a kintone app.
For complete raw field constraints, layout, settings, status, views, reports, or
customize metadata, use ksql_app_metadata.
```

3列 contract を明記し、完全 metadata の主経路へ誘導する。既存 schema / handler は変更しない。

### 5.3 `ksql_query` / `ksql_mutate`

既存の長い safety description を削らず、末尾に次の短い導線を加える。

```text
For kSQL dialect details, follow the server instructions and read
ksql://language-reference.
```

`ksql_query.sql` / `ksql_mutate.sql` の parameter description へ同じ文を重複させない。tool description と server instructions / resource で十分であり、schema description は入力固有契約に集中させる。

### 5.4 drift guard

`scripts/mcp-smoke.mjs` の重要部分文字列 guard に次を加える。

- `ksql_app_metadata`: `fields`, `constraints`, `raw`, `fixed GET allowlist`, `records`, `mutation`
- `ksql_describe_app`: `field code`, `label`, `type`, `ksql_app_metadata`
- `ksql_query` / `ksql_mutate`: `ksql://language-reference`

MCPB manifest の tool summary は runtime `tools/list` の全文とは別 surface である。現行 manifest は tool 名と短い説明を build scriptに手書きし、`ksql_describe_app` の次が `ksql_show_apps` で、B49 の `ksql_app_metadata` が欠落している（[build-mcpb.mjs:58-71](../../build-mcpb.mjs#L58)）。

```js
{ name: "ksql_describe_app", description: "Describe a kintone app." },
{ name: "ksql_show_apps", description: "Show kintone apps." },
```

B50 は `ksql_app_metadata` を manifest tool list へ同期し、description を用途起点へ合わせる。これは runtime schema 変更ではなく配布 metadata drift の是正である。

## 6. 設計 D — 安全性・非破壊性

1. server instructions、resource、description は純加法である。
2. 既存 tool 名、input/output schema、handler、SQL parser / AST / executor、core interface を変更しない。
3. resource callback は static embedded text だけを返し、kintone API、records、metadata API、filesystem、network、saved query catalogを呼ばない。
4. resource URI は固定 scheme / allowlist key だけとし、path traversal や任意 URL を受けない。
5. plugin / CLI / SQL surface は不変である。
6. APPLY の MCP mutation fail-close、DML approval、record caps 等の既存 safety description を短縮・削除しない。
7. docs embed 後も SDK / Zod external require なしの self-contained guard を通す。

## 7. 出力例

### 7.1 initialize 応答

```json
{
  "protocolVersion": "2025-06-18",
  "capabilities": {
    "tools": { "listChanged": true },
    "resources": { "listChanged": true }
  },
  "serverInfo": { "name": "ksql-mcp", "version": "3.9.0" },
  "instructions": "kSQL is a SQL-like dialect for kintone, not generic SQL. ..."
}
```

### 7.2 `resources/list`

```json
{
  "resources": [
    {
      "uri": "ksql://language-reference",
      "name": "ksql-language-reference",
      "description": "Index of kSQL syntax, dialect rules, and section resources.",
      "mimeType": "text/markdown"
    },
    {
      "uri": "ksql://recipes",
      "name": "ksql-recipes",
      "description": "Index of safe, rerunnable kSQL batch recipes.",
      "mimeType": "text/markdown"
    }
  ]
}
```

### 7.3 index read

```json
{
  "contents": [
    {
      "uri": "ksql://language-reference",
      "mimeType": "text/markdown",
      "text": "# kSQL language reference index\n\n- SELECT: ksql://language-reference/02-select\n..."
    }
  ]
}
```

## 8. SemVer / release

B50 は **minor** とする。新 server metadata と read-only resources の追加であり、既存 tool / schema / SQL / core を壊さない。package version はすでに3.9.0である（[package.json:1-4](../../package.json#L1)）。台帳 B50 は B43 / B49 と v3.9.0 同梱を一次決定としている（[docs/ksql_issue_tracker.md:41](../ksql_issue_tracker.md#L41)）。

B50 単独の version bump、release、commit は行わず、B43 / B49 と同じ v3.9.0 release gate に合流する。

## 9. 費用対効果

| 順位 | 変更 | 実装費 | 初期コンテキスト | 効果 | R1 |
|---|---|---:|---:|---|---|
| 1 | server instructions | 小 | 約150〜220 words / initialize | 全 tool 利用前に方言の存在と主要罠を伝える | 必須 |
| 2 | resource index + 章別 read | 小〜中 | index/resource を読んだ時だけ | 完全な既存文書へオンデマンド到達 | 必須 |
| 3 | metadata / describe description | 小 | tools/list metadata 分 | B49 の使い分けを用途から発見 | 必須 |
| 4 | query / mutate 導線 | 極小 | 1文×2 tool | 詳細文書への escape hatch | 必須 |
| 5 | `ksql_help` tool | 中 | tools/list schema 分 | resource 非対応 client fallback | R1 保留 |

最大の効果は instructions、最大の情報量は resource が担う。instructions へ全文を寄せないことで、効果とコンテキスト費を分離する。

## 10. テスト観点

### 10.1 initialize / instructions

- `client.getInstructions()` が non-empty である。
- instructions が `kSQL ... not generic SQL`、`VALIDATE ONLY`、`ksql_app_metadata`、`ksql://language-reference`、APPLY mutation disabled の重要語を含む。
- package version と server version の既存同期 guard を維持する。
- raw initialize JSON pack smoke でも `result.instructions` を確認する。

### 10.2 resources

- `client.listResources()` が2個の固定 index URIを返す。
- `client.listResourceTemplates()` が language-reference section / recipe template を返す。
- `client.readResource({ uri: "ksql://language-reference" })` が `text/markdown` の index を返す。
- SELECT、制限事項、VALIDATE ONLY、代表 recipe の各 URIを read し、source doc の固有見出し／文を含む。
- 未知 section、path traversal 風 key、任意 URL は拒否し、filesystem / network を呼ばない。
- 章の順序、重複 key、空章、必須章を build/test で固定する。

### 10.3 description drift

- `tools/list` で §5.4 の重要語を固定する。
- `ksql_describe_app` の3列と `ksql_app_metadata` の完全 raw metadata という役割分担を固定する。
- `ksql_query` / `ksql_mutate` の既存 safety key guardを全て維持する。
- MCPB manifest の tool list に `ksql_app_metadata` があり、短い説明が runtime と矛盾しない。

### 10.4 bundle / package

- `npm run build:mcp` 後、bundle に docs 固有の見出しが埋め込まれている。
- `dist-mcp/ksql-mcp.js` だけを temp directory へ移して server 起動・resource list/read が成功する。
- `docs/` を含まない `npm pack` → `--omit=dev` install でも resource list/read が成功する。
- 現行の SDK / Zod external require guard が pass する。
- MCPB archive 内の `server/ksql-mcp.js` でも同じ resource read が成功する。
- bundle 増加量を記録し、埋め込み元2文書の合計から不自然な重複がないことを確認する。

### 10.5 Claude 実クライアント

- 接続直後、Claude が kSQL を generic SQL と誤認せず、instructions の主要能力と罠を説明できる。
- Claude が resource index を発見し、指定章を必要時に読める。
- 「フィールド制約を確認して DML を作る」で `ksql_app_metadata(resource="fields")` を選べる。
- generated SQL に対し、syntax/static は `ksql_validate`、DML form/data preflight は `VALIDATE ONLY` と使い分ける。
- resource template が client UI / model から到達不能なら D11 を再判断し、`ksql_help(section)` fallback を実装前に確定する。

## 11. 決定点

次は R1 の推奨であり、Claude / ユーザー承認までは実装確定としない。

| ID | 決定点 | 選択肢 | R1 推奨 |
|---|---|---|---|
| D1 | instructions | なし / 短い索引 / 詳細リファレンス | **短い索引**。150〜220 words、能力・罠・導線の3群 |
| D2 | instructions API | 第1引数へ混在 / 第2引数 `ServerOptions` | **第2引数**。SDK 1.29.0 型どおり |
| D3 | 文書 surface | resource / help tool / 両方 | **resource**。help tool は client smoke 不成立時だけ再判断 |
| D4 | resource 粒度 | 全文2件 / 固定 index + 章別 template / 全章を固定列挙 | **固定 index + 章別 template**。初期 list と read contextを抑える |
| D5 | URI | `ksql://language-reference`, `ksql://recipes` / file URI / HTTP | **`ksql://` 固定 URI**。外部 server / path 不要 |
| D6 | 同梱 | runtime docs read / packageへdocs追加 / build-time embed | **build-time embed**。単一 bundle / npm / MCPB 全面で同じ |
| D7 | source of truth | 新 help 文書 / 既存 public docs | **既存 language reference + recipes**。重複本文なし |
| D8 | 公開文書 | language referenceのみ / +recipes / +internal docs | **language reference + recipes**。internal / migration は対象外 |
| D9 | metadata description | safetyのみ / 用途+具体resource+safety | **用途+具体resource+safety**。raw JSON とSQL/DML前確認を明記 |
| D10 | query/mutate | 導線なし / 短いresource導線 | **末尾に1文**。既存 safety description は削らない |
| D11 | client compatibility | SDK対応だけで完了 / Claude実機gate / 最初からtool併設 | **Claude実機gate**。不成立時のみ `ksql_help` fallback を再判断 |
| D12 | SemVer | patch / minor / major | **minor**。純加法、v3.9.0 同梱 |
| D13 | MCPB manifest | 対象外 / tool list・description driftも同期 | **同期**。B49 tool 欠落と説明差を残さない |

Claude レビューでは特に **D1（instructions の長さと誤解のなさ）、D3〜D6（resource/template と embed）、D11（Claude client の resource 到達性）、APPLY と2種類の validation の表現**を確認する。

## 12. スコープ外

- SQL grammar、lexer、parser、AST、executor、core API の変更。
- plugin / CLI UI、plugin manifest、SQL help command の追加。
- `ksql_validate`、`ksql_query`、`ksql_mutate` の schema / safety semantics 変更。
- APPLY mutation の MCP 解禁。
- 新しい言語機能、既存方言制約の緩和。
- docs 本文の全面改稿、翻訳、検索 index、embedding / vector search。
- migration guide、internal specs、issue tracker、README、CHANGELOG の resource 公開。
- 外部 URL、任意 file path、repository browser を読む resource。
- B50 R1 作成時点でのコード実装、version bump、release artifact 作成、git commit。

## 13. 完了条件

1. initialize 応答に短い `instructions` が入り、generic SQL との差、検証、metadata、resource 導線がある。
2. `resources/list` で2つの index が見え、章別 resource を `resources/read` できる。
3. resource 本文は既存 public docs から build 時生成され、runtime filesystem に依存しない。
4. `ksql_app_metadata` / `ksql_describe_app` の役割分担と query/mutate の resource 導線が tools/list に出る。
5. existing tool schema / behavior、SQL/core、plugin/CLI、APPLY fail-close が不変である。
6. build / mcp-smoke / pack-smoke / MCPB verify が self-contained bundle と resource read を固定する。
7. Claude 実クライアントで instructions と resource の到達性を確認し、D11 を確定する。
