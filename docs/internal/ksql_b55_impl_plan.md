- ステータス: 計画 R1 **実装完了（2026-07-21・Phase 0〜5 全ステップ＋Phase 6 Step 6-1 実施済み・c4da29d）**。自動 gate 全 green（npm test 2,729=110+2 suites・mcp:smoke・pack-smoke・build:mcpb・mcpb-verify）。instructions 実測 257 語・4 段落（guard 240〜280 語）・annotations は SDK ^1.29.0 対応につき採用。Step 6-2 版数 3.12.0 更新・release アセット差し替え済（1107139）。**MCP 実機 PASS（resources 非対応経路・[evidence](evidence/b55_claude_desktop_smoke.md)）**。残=PR→merge→tag v3.12.0→GitHub Release→npm publish

# B55 — MCP read-only ドキュメントツール `ksql_docs` 実装計画

- 対象課題: **B55**
- 正となる仕様: [B55 MCP docs tool 仕様 R2](ksql_b55_mcp_docs_tool_spec.md)
- 背景: [B55 fallback issue](ksql_b55_mcp_docs_tool_fallback_issue.md)
- 対象面: **Node MCP のみ**（core interface / SQL / CLI / plugin は非改変）
- SemVer: **minor**（仕様 R2 の候補は v3.12.0。版数確定と version 更新は Claude レビュー後の release phase で行う）

本書は仕様 R2 を実ファイル・実シンボル単位へ展開する実装計画である。仕様と本書が衝突する場合は仕様 R2 を正とする。現行コードと仕様の事実記述が食い違う箇所だけは §4 の「仕様側の修正提案」に分離し、実装で黙って逸脱しない。

## 1. 完了条件と実装順

B55 の完了は、次のすべてを満たす状態を指す。

1. 仕様 R2 §6 の受入条件 1〜12 を §7 の対応表どおりに満たす。
2. `ksql_docs` は資格情報・有効な config・resource capability がなくても、固定 map lookup だけで全 40 キー（索引 2＋言語 26＋レシピ 12）へ応答する。
3. 成功は markdown の text だけ、アプリエラーは既存 JSON envelope の text / `structuredContent` 両載せ、schema エラーは `-32602` という二層契約を固定する。
4. instructions の関数カタログとパーサ受理集合を双方向 guard し、関数追加時に片側だけの更新を許さない。
5. unit、built `dist-mcp` smoke、docs 非同梱 npm install smoke、MCPB manifest/launcher verify を通す。
6. 言語リファレンス、README、B55 issue/spec、課題台帳、CHANGELOG と release metadata を実装結果へ同期する。

実装順は次で固定する。

```text
Phase 0 契約テストを fail-first で追加
  -> Phase 1 docsResources のカタログ・キー・統合インデックスと parser export
  -> Phase 2 schema
  -> Phase 3 index.ts の tool / builder / instructions
  -> Phase 4 description 3 箇所・言語リファレンス
  -> Phase 5 built smoke / pack smoke / MCPB manifest / verify
  -> Phase 6 公開文書・台帳・release metadata
```

Phase 0 の期待値を先にレビュー可能にし、Phase 1〜3 で green にする。Phase 5 は Phase 1〜4 の統合後に行い、`mcp:smoke` の前に必ず `npm run build:mcp` を実行する。Phase 6 の version 確定は Claude コードレビューと全自動 gate の後とする。

## 2. 現行コードで確認した接続点

行番号は 2026-07-21 の現物を基準とする。実装時に前後の編集でずれた場合は識別子を正として再確認する。

| 領域 | 現行の事実 | 実装接続点 |
|---|---|---|
| embed docs | `src/mcp/docsResources.ts:1-12` は非 bundle 時だけ repo markdown を読み、`:24-29` で `KSQL_DOCS`、`LANGUAGE_SECTION_KEYS`、`RECIPE_KEYS` を公開する | 同ファイルへ frozen `KSQL_FUNCTION_CATALOG`、全 tool key、統合インデックス helper を置く。`docsResourceBuilder.cjs` と build-time embed 方式は変えない |
| MCP 初期化 | `src/mcp/index.ts:79-97` が 3 段落 instructions、`:116-127` が server と既存 tools を作る | カタログから instructions を組み立て、config/runtime に依存しない `ksql_docs` handler を `createServer` 内へ登録する |
| resources | `src/mcp/index.ts:202-250` が固定索引と 2 template を登録し、completion は `:217` / `:237` で既存キー定数を使う | resource 登録は不変。tool key も同じ 2 定数から導出する |
| schema | `src/mcp/schemas.ts:216-225` が tool 用 input schema/shape export を集約する | strict な `ksqlDocsInputSchema` / `ksqlDocsInputShape` を追加する。空文字は schema で拒否しない |
| error envelope | `src/mcp/tools.ts:393-404` の private `toErrorPayload` が code/message を作り、`:487-507` の `toToolResult` / `runSafely` が JSON text と `structuredContent` を同一 payload から作る | `toErrorPayload` だけ export し、docs error も `toToolResult(toErrorPayload(err), true)` を通す |
| parser scalar | `src/parser/parser.ts:1602-1669`。token map は `:1609-1654`、`CURRENT_DATE` / `CURRENT_TIMESTAMP` の IDENT 先読みは `:1658-1667` | 受理表を module-level exported frozen 定数へ持ち上げ、parser 本体と drift test が同じ定数を使う |
| parser aggregate/window/contextual | aggregate は `src/parser/parser.ts:1770-1781`、window は `:1169-1176`、contextual は少なくとも `:2217-2229`。型の有限集合は `src/types/ast.ts:273-308` と `:569-573` | 各 token map / IDENT 名 / contextual 判定 helper を export 可能な有限集合へ集約する。型 union だけから runtime 集合を推測しない |
| instructions guard | `src/mcp/__tests__/metadataTools.test.ts:98-110`。語数 150〜220、3 段落、既存 5 文字列を固定する | §3.2 の実文 257 語・4 段落に合わせて予算を再固定し、`ksql_docs` と代表関数を追加する |
| language aliases | `docs/ksql_language_reference.md:426` の `SUBSTRING` は `SUBSTR` を書いていない。一方 `CEILING` / `TRUNC` は `:504-505`、`POW` は `:530`、`CONVERT` は `:567` に既に記載済み | §4.1 の仕様側修正提案に従い、`SUBSTR` を追記し、alias 一覧を明示して散在記述の drift を防ぐ |
| bundle | `build-mcp.mjs:13-29` が docs map を `__KSQL_DOCS__` へ埋め込む | define や builder は変更しない。`docsResources.ts` の追加ロジックが bundle / ts-jest の両方で評価可能であることをテストする |

## 3. R2 が実装時確定とした 3 点の決定案

以下は **計画 R1 の提案**であり、最終確定は Claude レビューで行う。

### 3.1 エラー builder: `toErrorPayload` を export して共有する

**提案:** docs 専用エラー payload builder は複製せず、`src/mcp/tools.ts:393` の `toErrorPayload` を `export function` に変える。`index.ts` 側の docs error builder は `toToolResult(toErrorPayload(err), true)` へ委譲する薄い関数にする。成功側だけ `content: [{ type: "text", text }]` を返す docs 専用 builder に分ける。

**根拠:**

- 既存 code 導出は Error.name 優先、次にメッセージ先頭の `XxxError:`、最後に `Error` という順序であり（`tools.ts:393-403`）、複製すると将来ここだけ drift する。
- `toToolResult` は既に export 済みで（`:487`）、同一 payload object を pretty JSON text と `structuredContent` に載せる。共有すれば property 順・indent・末尾 newline の有無まで同じ serializer になり、仕様の「バイト互換」を最小の変更で担保できる。
- `runSafely` 全体の export は不要である。docs 成功契約は既存 tool と異なるため、成功時に `toToolResult` を使わない境界を明瞭に保てる。

**互換テスト:** `docsTool.test.ts` で同じ `Error("ArgumentError: ...")` を `toToolResult(toErrorPayload(error), true)` に渡した期待値と実際の `ksql_docs` エラーの `content[0].text` を `toBe` で比較し、`structuredContent` も `toEqual`、`isError` も true とする。これにより shape だけでなく JSON text のバイト列を固定する。

### 3.2 instructions: 257 語・4 段落、guard は 240〜280 語

**提案:** 現行 3 段落を能力索引、重要ルール、行動導線の 3 段落へ圧縮し、4 段落目をカタログ専用にする。次の実文は `metadataTools.test.ts:100` と同じ `trim().split(/\s+/)` で **257 語**、`split(/\n\n/)` で **4 段落**である。テスト予算は **240〜280 語・4 段落固定**とする。

```text
kSQL is a SQL-like dialect for kintone, not generic SQL. It supports SELECT, JOIN, aggregates, CTEs, UNION, window functions, DML, subtable virtual tables, REORDER, IMPORT, VALIDATE/VALIDATE ONLY, ON ERROR SKIP, CHECK, KLIKE, KORDER BY, multi-statement batches, temp tables, @variables, and LAPP_<NAME> logical apps.

Key rules: LIKE/NOT LIKE has JavaScript semantics; JOIN ON accepts one equality; derived tables are unsupported (use WITH or temp tables); empty numeric cells become 0 in arithmetic. APPLY may be validated, explained, or used with VALIDATE ONLY, but APPLY mutation is disabled by this MCP server.

Before execution, use ksql_validate. Before DML, run VALIDATE ONLY through ksql_query, inspect constraints with ksql_app_metadata, then use ksql_mutate. Read ksql://language-reference and ksql://recipes, or call ksql_docs when resources are unavailable. Start ksql_docs without arguments and read only needed sections. Do not probe ksql_validate to discover functions or syntax.

Complete function catalog — Scalar: UPPER LOWER TRIM LTRIM RTRIM LENGTH LENGTH_CHAR SUBSTRING LEFT RIGHT INSTR CONCAT REPLACE REGEXP_LIKE REGEXP_REPLACE REGEXP_SUBSTR TRANSLATE COALESCE ISNULL NULLIF GREATEST LEAST LPAD RPAD ROUND FLOOR CEIL TRUNCATE ABS MOD POWER SQRT FORMAT CAST YEAR MONTH DAY DATE_FORMAT DATEDIFF DATE_ADD LAST_DAY CURRENT_DATE CURRENT_TIMESTAMP. Aggregate: COUNT SUM AVG MIN MAX GROUP_CONCAT. Window: ROW_NUMBER RANK DENSE_RANK (OVER and AS alias required). Contextual: TODAY NOW LOGINUSER (kintone predicates; LOGINUSER resolves to an empty string in Node/MCP). Aliases: SUBSTR→SUBSTRING, CONVERT→CAST, CEILING→CEIL, TRUNC→TRUNCATE, POW→POWER. Syntax: IF(cond, then, else), ||, LIKE, KLIKE, IN, BETWEEN, IS NULL, CASE WHEN. This list is complete; functions from other dialects such as IFNULL, STDDEV, and MEDIAN do not exist. Use ksql_docs for arguments and constraints.
```

**根拠:** 4 段落なら既存の役割分離を保ったままカタログだけを機械的に生成できる。257 語に対する 240〜280 は軽微な英文修正の余白を持ちつつ、カタログ脱落や説明の無制限な肥大を検知する。既存 5 key（`not generic SQL`、`VALIDATE ONLY`、`ksql_app_metadata`、`ksql://language-reference`、`APPLY mutation is disabled`）はすべて維持する。

**組み立て規則:** カタログ段落は `KSQL_FUNCTION_CATALOG` の各配列を必ず半角空白で `join(" ")` し、分類間は固定英文で連結する。カンマ区切りや `SUBSTR → SUBSTRING` のように矢印前後へ空白を足すだけでも `split(/\s+/)` の語数が変わるため、実装後に同じ式で再実測し、257 語から変わる場合は理由と新実測値を Claude レビューへ提示して guard を同時更新する。

### 3.3 双方向 drift guard: parser の実受理表を export する

**提案:** docs 側から parser の private 実装を正規表現で読む方式や、`StringFuncName` 等の型 union を実行時に再列挙する方式は採らない。`src/parser/parser.ts` の既存 private map/switch を次の module-level frozen 定数へ持ち上げ、parser 自身もそれらを参照する。

- `PARSER_SCALAR_FUNCTION_TOKEN_MAP`: `parser.ts:1609-1654` の token→canonical 名。`LEFT` / `RIGHT` の「直後が `(` のときだけ」の条件は維持する。
- `PARSER_IDENT_SCALAR_FUNCTIONS`: `CURRENT_DATE` / `CURRENT_TIMESTAMP`（`:1658-1667`）。
- `PARSER_AGGREGATE_FUNCTION_TOKEN_MAP`: `COUNT` / `SUM` / `AVG` / `MAX` / `MIN` / `GROUP_CONCAT`（`:1770-1781`）。
- `PARSER_WINDOW_FUNCTION_TOKEN_MAP`: `ROW_NUMBER` / `RANK` / `DENSE_RANK`（`:1169-1176` の switch を map lookup に置換）。
- `PARSER_CONTEXTUAL_FUNCTION_TOKEN_MAP` と `isContextualFunctionToken`: `TODAY` / `NOW` / `LOGINUSER`。`parseSqlValue` 等の全 contextual 分岐を helper 参照にし、列挙の並置コピーを残さない。
- `PARSER_FUNCTION_SPELLINGS`: 上記 5 集合と `IF` を公開 spellings へ平坦化した derived frozen 配列。alias は token spelling を保持し、canonical 値へ潰さない。

`KSQL_FUNCTION_CATALOG` は instructions の正であり、parser export は parser 実装の正とする。test で次を比較する。

1. カタログ側 callable 集合 = scalar canonical＋alias の左辺＋aggregate＋window＋contextual＋syntax の `IF`。
2. parser 側集合 = `PARSER_FUNCTION_SPELLINGS`。
3. `expect(catalogOnly).toEqual([])` と `expect(parserOnly).toEqual([])` の両方向差分を別 assertion にし、失敗時に不足側を表示する。
4. alias の右辺は各 token map の canonical 値と一致することも検証する。
5. syntax の `||` / `LIKE` / `KLIKE` / `IN` / `BETWEEN` / `IS NULL` / `CASE WHEN` は関数 spellings 比較から除外し、既存 parser test と代表 fixture で受理を固定する。

**根拠:** 現行受理集合は private map、IDENT 2 名、3 つの有限列挙へ分散している。実際に parser が参照する runtime 定数を export すれば、テスト専用の第二の列挙を作らず逆方向 guard を成立させられる。`types/ast.ts` の union は canonical AST 名しか持たず `SUBSTR` 等の入力 alias を失うため、逆方向の正には使えない。

## 4. 仕様側の修正提案

### 4.1 言語リファレンス alias の現況訂正

仕様 R2 §4.5 / §5 は `SUBSTR` / `TRUNC` / `CEILING` / `POW` がすべて言語リファレンス §5 に未記載とするが、現物では次の 3 名が既に記載されている。

- `CEILING`: `docs/ksql_language_reference.md:504`
- `TRUNC`: `docs/ksql_language_reference.md:505`（予約語注記も `:522`）
- `POW`: `docs/ksql_language_reference.md:530`

未記載なのは `SUBSTR`（`SUBSTRING` 行は `:426`）である。実装では `SUBSTRING` 行へ「`SUBSTR` も可」を追記し、§5 に `SUBSTR` / `CONVERT` / `CEILING` / `TRUNC` / `POW` の canonical 対応を 1 箇所で確認できる alias 注記を追加する。既存 3 名を重複行として増やさない。Phase 6 で仕様 R2 §4.5 の「4 名とも未記載」を「`SUBSTR` が未記載、他 3 名は散在記載のため一覧化」へ訂正する。

これは公開契約の変更ではなく現行文書の事実訂正である。Claude レビューで「仕様本文は履歴として不変」と決まった場合は、仕様を直接直さず改訂履歴または R3 へ correction を記録する。

## 5. 実装フェーズとステップ

各 Step は独立レビュー単位とし、変更ファイル、変更内容、完了判定を明記する。

### Phase 0: 契約テスト先行

#### Step 0-1: `ksql_docs` protocol / success / fail-closed 契約を fail-first 化

- **変更ファイル**: なし
- **新規ファイル**: `src/mcp/__tests__/docsTool.test.ts`
- **変更内容**:
  - InMemoryTransport で実際の `createServer` に接続し、tools/list の title、description、strict schema、`annotations: { readOnlyHint: true, openWorldHint: false }` を固定する。
  - 引数なし、2 索引、代表言語章、代表 recipe、`ksql://` URI 形、前後空白を検証する。
  - 全 40 key を table-driven に呼び、resource read と text を `toBe` で比較する。成功時は content が text 1 件だけで、`structuredContent` / `outputSchema` がないことを検証する。
  - 未知 key 2 種、空文字、空白だけはアプリ `ArgumentError`、未知 property、数値、129 文字は protocol `-32602` とする。
  - 存在しない config path で server を作り、`jest.spyOn(globalThis, "fetch")` を tool 呼び出し前に置く。全成功・アプリエラー・schema エラー後に `expect(fetchMock).not.toHaveBeenCalled()` とする。
  - error text は §3.1 の共有 builder 基準値と `toBe` で比較する。
- **完了判定**: 実装前に期待どおり fail し、成功 text-only、二層 error、全 key、HTTP 0 の期待値が仕様 R2 §3 / §6 と一致するとレビューできる。
- **依存**: なし。

#### Step 0-2: カタログ / parser 双方向 guard と spellings 別 SQL fixture

- **変更ファイル**: なし
- **新規ファイル**: `src/mcp/__tests__/functionCatalog.test.ts`、`src/mcp/__tests__/fixtures/ksqlFunctionCatalogFixtures.ts`
- **変更内容**:
  - fixture は `Record<ParserFunctionSpelling, string>` 相当の明示表にし、各 spelling に正しい最小 SQL を 1 本置く。一律 `SELECT F(x)` は使わない。
  - 例: `CAST(x AS TEXT)`、`CONVERT(x, TEXT)`、`CURRENT_DATE()`、`IF(x = 1, 'a', 'b')`、`COUNT(*)`、`SUM(x) ... GROUP BY k`、`ROW_NUMBER() OVER () AS rn`、`WHERE 日付 = TODAY()`、`WHERE 更新日時 < NOW()`、`WHERE 作成者 = LOGINUSER()`。
  - 全 fixture を `parseSqlStatement` へ通し、parser 集合と fixture key、catalog callable 集合をそれぞれ双方向比較する。alias 左辺→canonical 右辺も token map へ照合する。
  - `syntax` の非関数要素は代表 SQL で別 table-driven test にする。
- **完了判定**: parser だけ／catalog だけ／fixture だけの spelling がいずれも 0 件で、全 fixture が parse できる。将来どの受理関数を追加しても catalog または fixture 未更新で test が落ちる。
- **依存**: なし。

#### Step 0-3: 既存 metadata / exact tool list 契約を先に更新

- **変更ファイル**: `src/mcp/__tests__/tools.test.ts`、`src/mcp/__tests__/metadataTools.test.ts`
- **新規ファイル**: なし
- **変更内容**:
  - §6.1 の 2 つの exact tool list へ既存登録順どおり `ksql_docs` を追加する。
  - `metadataTools.test.ts:98-110` を 240〜280 語・4 段落へ変更し、既存 5 key を維持した上で `ksql_docs`、`Complete function catalog`、`CURRENT_TIMESTAMP`、`GROUP_CONCAT`、`DENSE_RANK`、`LOGINUSER`、`SUBSTR→SUBSTRING`、`IFNULL` を包含確認する。
  - `tools.test.ts:66-67` と `metadataTools.test.ts:81-83` の query/mutate description guard に fallback 文言を追加し、validate の probe 禁止文言も確認する。
- **完了判定**: tool 未登録・instructions 未更新・description 未更新の各状態で、対応 assertion が個別に fail する。
- **依存**: Step 0-1 と並行可。

### Phase 1: docsResources と parser の単一ソース化

#### Step 1-1: `KSQL_FUNCTION_CATALOG` と統合 key/index helper

- **変更ファイル**: `src/mcp/docsResources.ts`、`src/mcp/__tests__/docsResources.test.ts`
- **新規ファイル**: なし
- **変更内容**:
  - `{ scalar, aggregate, window, contextual, aliases, syntax }` の全プロパティと配列を deep freeze した `KSQL_FUNCTION_CATALOG` を追加する。配列順は仕様 R2 §4.1 の掲載順とし、instructions の表示順を安定させる。
  - `LANGUAGE_SECTION_KEYS` / `RECIPE_KEYS` から `KSQL_DOCS_SECTION_KEYS`（40 件）を導出し、新しい文字列リテラル一覧を複製しない。
  - `buildKsqlDocsIndex()` を追加し、両既存 index、各 index 直後の tool 呼出し例、機械可読な全 40 key 一覧を固定順で連結する。module 初期化時に 1 回生成した frozen/static text を export して呼出しごとに組み直さない。
  - `resolveKsqlDocsSection(section)` は trim と先頭 1 回の `ksql://` 除去だけを行い、索引または固定 section object の text を返す。case folding、部分一致、URL/path 解釈はしない。空／未知は `ArgumentError:` を throw する。
  - 既存 `docsResources.test.ts:14-55` に catalog freeze、40 key、統合 index 内容・順序・重複なしを追記する。さらに InMemoryTransport の `client.complete(...)` で言語 prefix `05-` と recipe prefix `r1`（`r1` / `r10` / `r11` / `r12`）を取得し、その completion 値を tool key の同じ family と集合比較する。
- **完了判定**: Step 0-1 の lookup/index 系と docsResources unit が green になり、既存 B50 resource index/section text は変わらない。
- **依存**: Phase 0。

#### Step 1-2: parser 受理集合 export と既存 parser の参照切替

- **変更ファイル**: `src/parser/parser.ts`
- **新規ファイル**: なし
- **変更内容**: §3.3 の 5 つの map/list/helper と derived `PARSER_FUNCTION_SPELLINGS` を export し、`tryStringFuncName`、`tryAggregateFunc`、`tryWindowFunc`、contextual 各分岐をその定数参照へ切り替える。AST 形、alias 正規化、error 文言、予約語は変えない。`src/lexer/tokens.ts` と `src/types/ast.ts` は変更しない。
- **完了判定**: Step 0-2 が green で、既存 parser/window/batch tests の期待 AST とエラーが不変である。
- **依存**: Step 0-2。Step 1-1 と並行可だが、Phase 3 より前に統合する。

### Phase 2: input schema

#### Step 2-1: `ksqlDocsInputSchema` / `ksqlDocsInputShape`

- **変更ファイル**: `src/mcp/schemas.ts`
- **新規ファイル**: なし
- **変更内容**: `z.object({ section: z.string().max(128).optional() }).strict()` を schema として追加し、MCP 登録用 shape/export を既存 `:216-225` の並びへ追加する。`.min(1)`、default、transform は置かず、trim は handler 層だけで行う。
- **完了判定**: tools/list JSON schema が `additionalProperties:false`、optional string、`maxLength:128` となり、Step 0-1 の 3 種 protocol error が handler 未到達の `-32602` になる。
- **依存**: Phase 0。Phase 1 と並行可、Phase 3 の前提。

### Phase 3: MCP tool 登録・builder・instructions

#### Step 3-1: error helper の共有化と docs success builder

- **変更ファイル**: `src/mcp/tools.ts`、`src/mcp/index.ts`
- **新規ファイル**: なし
- **変更内容**:
  - `tools.ts:393` の `toErrorPayload` を export する。実装本体は変えない。
  - `index.ts` に text 1 件だけを返す `toDocsSuccessResult(text)` と、共有 `toErrorPayload` / `toToolResult` に委譲する `toDocsErrorResult(err)` を置く。
  - docs handler は同期 lookup を `try/catch` し、成功時に `structuredContent` を付けず、未知 key だけ既存 envelope へ変換する。
- **完了判定**: Step 0-1 の text-only success と error byte comparison が green、既存 tool error test も不変である。
- **依存**: Step 1-1、Step 2-1。

#### Step 3-2: `ksql_docs` 登録

- **変更ファイル**: `src/mcp/index.ts`
- **新規ファイル**: なし
- **変更内容**:
  - `createServer` 内で `server.registerTool("ksql_docs", ...)` を登録し、`ksqlDocsInputShape`、`readOnlyHint:true`、`openWorldHint:false`、用途起点の title/description を与える。
  - handler は Step 1-1 helper だけを呼び、`tools` object、runtime、config loader、`fetch`、`fs` を参照しない。既存 `createKsqlMcpTools` の生成順や既存 tool callback は変えない。
  - tool の登録位置を `ksql_app_metadata` 等の read-only discovery tools と一貫する位置へ固定し、全 exact list を同じ順で更新する。
- **完了判定**: config 不在で全 40 key とアプリエラーに応答し、fetch 0、annotations/schema/title/description が tools/list に現れる。
- **依存**: Step 3-1。

#### Step 3-3: instructions を catalog から組み立てる

- **変更ファイル**: `src/mcp/index.ts`
- **新規ファイル**: なし
- **変更内容**: `KSQL_FUNCTION_CATALOG` を import し、§3.2 の固定 3 段落＋catalog 生成段落で `KSQL_MCP_INSTRUCTIONS` を構成する。scalar 等の関数名を template literal へ再列挙しない。tool/resource の両導線、引数なし discovery、validate probe 禁止、全量注記を含める。
- **完了判定**: 実測 257 語、4 段落、既存 5 key＋新 key の guard、Step 0-2 の catalog guard が green。ts-jest import と `build:mcp` bundle の双方で instructions が同一になる。
- **依存**: Step 1-1、Step 3-2。

### Phase 4: 既存 description と言語リファレンス

#### Step 4-1: 既存 tool description 3 箇所

- **変更ファイル**: `src/mcp/index.ts`、`src/mcp/__tests__/tools.test.ts`、`src/mcp/__tests__/metadataTools.test.ts`
- **新規ファイル**: なし
- **変更内容**:
  - `ksql_validate`（`index.ts:129-133`）へ `Do not use validate probing to discover functions or syntax; call ksql_docs instead.` を追記する。
  - `ksql_query`（`:141-145`）と `ksql_mutate`（`:147-151`）末尾を `read ksql://language-reference (or call ksql_docs when resources are unavailable)` の趣旨へ変える。
  - 他の長い安全契約文は変えない。
- **完了判定**: 3 description の狙った追加を unit と built smoke の両方が検証し、既存 safety 文言 guard が維持される。
- **依存**: Step 3-2。

#### Step 4-2: 言語リファレンス §5 alias 同期

- **変更ファイル**: `docs/ksql_language_reference.md`、`src/mcp/__tests__/docsResources.test.ts`
- **新規ファイル**: なし
- **変更内容**: §4.1 の correction に従い `SUBSTRING` 行へ `SUBSTR` を追記し、5 alias の canonical 対応をまとめた注記を §5 に置く。embed map の `05-string-number-functions` がこの記述を含むことを unit で固定する。
- **完了判定**: source markdown、非 bundle `KSQL_DOCS`、build embed 後の tool/resource 章が同じ alias 記述を返す。
- **依存**: Step 1-1。Phase 5 build の前に完了する。

### Phase 5: exact 検証・smoke・manifest・配布 verify

#### Step 5-1: 既存 exact 検証 6 箇所を更新

- **変更ファイル**: `src/mcp/__tests__/tools.test.ts`、`src/mcp/__tests__/metadataTools.test.ts`、`scripts/mcp-smoke.mjs`、`scripts/mcp-pack-smoke.mjs`、`build-mcpb.mjs`、`scripts/mcpb-verify.mjs`
- **新規ファイル**: なし
- **変更内容**: §6 の現物行番号と具体策どおりに `ksql_docs` を追加する。単なる `some()` ではなく tool 集合の完全一致を維持／追加する。
- **完了判定**: server list、built list、npm packed list、MCPB manifest list、MCPB launcher list のいずれか一面だけ `ksql_docs` を外すと対応 gate が fail する。
- **依存**: Phase 3、Step 4-1。

#### Step 5-2: built `mcp:smoke`

- **変更ファイル**: `scripts/mcp-smoke.mjs`
- **新規ファイル**: なし
- **変更内容**:
  - `npm run build:mcp` 後の `dist-mcp/ksql-mcp.js` に対して、引数なし、代表章 `language-reference/05-string-number-functions`、未知 key の 3 呼出しを追加する。
  - success が text-only、unknown が byte-compatible envelope / `isError:true`、instructions にカタログと fallback 導線があることを assert する。
  - 既存 `mcp-resource-io-guard.cjs` の active 区間を tool の不正 key 呼出しにも適用し、bundle runtime の fs/network I/O 0 を固定する。
- **完了判定**: built bundle で 3 呼出しと I/O guard が通り、resource smoke も従来どおり通る。
- **依存**: Phase 4、Step 5-1。**実行前に `npm run build:mcp` 必須**。

#### Step 5-3: docs 非同梱 npm install の全 key pack-smoke

- **変更ファイル**: `scripts/mcp-pack-smoke.mjs`
- **新規ファイル**: なし
- **変更内容**:
  - 既存 raw JSON-RPC request 列（現行 `:229` 以降）へ `ksql_docs` の全 40 key、引数なし、未知 key を追加し、response id を名前付き map/helper で管理して連番ずれを避ける。
  - 現行 `:221-224` の「consumer に docs/ と runtime dependencies がない」確認を維持し、全 40 key の text が空でなく、代表 2 章は resource response とバイト同一、未知 key は application envelope であることを確認する。
- **完了判定**: npm package の `docs/` が存在しない状態で全 40 key が成功する。これを build-time embed standalone の主証跡とする。
- **依存**: Step 4-2、Step 5-1。`npm pack` の prepack が build を行うが、単独 smoke の前提はスクリプト内で明示する。

#### Step 5-4: MCPB manifest / launcher verify

- **変更ファイル**: `build-mcpb.mjs`、`scripts/mcpb-verify.mjs`
- **新規ファイル**: なし
- **変更内容**:
  - manifest の tool 配列へ `ksql_docs` と read-only docs fallback の用途説明を追加する。
  - MCPB zip 内 manifest の tool name 配列を expected list と完全一致させ、description に `read-only` / `resources` / `ksql_docs` の用途語を要求する。
  - launcher smoke でも `listTools()` を exact list 比較へ強化し、`ksql_docs` 引数なしを 1 回呼んで text-only 応答を確認する。
- **完了判定**: 手書き manifest、zip manifest、実ランチャーの 3 面で同じ tool list と `ksql_docs` 応答が確認できる。
- **依存**: Step 5-1〜5-3。`npm run build:mcpb` 前に `npm run build:mcp` を行う。

### Phase 6: ドキュメント・台帳・release 同期

#### Step 6-1: 利用者向け導線と B55 状態同期

- **変更ファイル**: `README.md`、`docs/internal/ksql_b55_mcp_docs_tool_fallback_issue.md`、`docs/internal/ksql_b55_mcp_docs_tool_spec.md`、`docs/ksql_issue_tracker.md`
- **新規ファイル**: なし
- **変更内容**:
  - README の MCP 導線へ、resources が使えない場合は `ksql_docs` を引数なしで呼ぶ手順と section 例を追加する。
  - issue/spec/台帳を「実装済み・自動検証済み・Claude コードレビュー／実機待ち」へ揃え、採用した §3 の 3 決定と §4 correction を反映する。
  - resources は削除・代替せず並存すること、core/SQL/CLI/plugin 不変、HTTP 0 の主張範囲を bundle runtime に限定する。
- **完了判定**: `rg -n "B55|ksql_docs|resources"` で status・導線・安全性の矛盾がなく、台帳から spec/issue へ辿れる。
- **依存**: Phase 5 自動 gate、Claude コードレビュー結果。

#### Step 6-2: changelog と release metadata

- **変更ファイル**: `CHANGELOG.md`、`package.json`、`package-lock.json`、`prod/manifest.json`、build 成果物（release 方針で追跡対象のもののみ）
- **新規ファイル**: なし
- **変更内容**: Claude レビューで minor 版（仕様候補 v3.12.0）を確定後、機能・fallback 理由・text/error 契約を changelog に記載し、現在 3.11.0 の version 面を一括同期する。版数を Phase 0〜5 の機能 commit に先行混入させない。
- **完了判定**: package/lock/plugin manifest/MCP serverInfo/MCPB manifest の version が一致し、再 build 後の全 verify が green である。
- **依存**: Step 6-1 と release 版数承認。

## 6. 既存 exact 検証 6 箇所の具体的変更

| 箇所（現行行） | 現行検証 | B55 の具体的変更 |
|---|---|---|
| `src/mcp/__tests__/tools.test.ts:54-59` | `_registeredTools` の登録順を 12 件で完全一致 | 採用した登録位置へ `ksql_docs` を 1 件追加する。`:66-67` の query/mutate resource 文言 guard も fallback 文言へ広げ、validate probe 禁止を追加する |
| `src/mcp/__tests__/metadataTools.test.ts:56-69` | `_registeredTools` を改行形式で 12 件完全一致 | 同じ登録順で `ksql_docs` を追加する。`:81-84` の description/schema guard と `:98-110` の instructions guard を Phase 0 Step 0-3 どおり更新する |
| `scripts/mcp-smoke.mjs:19-32` | built server の `expectedTools`。実比較は `:383-388` | `expectedTools` へ `ksql_docs` を追加し exact equality を維持する。`:371-381` の instructions guard、新規 3 tool calls、I/O guard も更新する |
| `scripts/mcp-pack-smoke.mjs:20-33` | npm install 後 server の `expectedTools`。実比較は `:344-350` | `ksql_docs` を追加し exact equality を維持する。raw JSON-RPC request/response に全 40 key＋index＋unknown を追加する |
| `build-mcpb.mjs:58-71` | MCPB manifest の手書き 12 tool 配列 | read-only docs fallback の description 付き `{ name: "ksql_docs", ... }` を server 登録と同じ位置へ追加する |
| `scripts/mcpb-verify.mjs:107-131` | manifest 基本値と `ksql_app_metadata` の存在・説明だけを確認。launcher 側は `:82-86` で `ksql_validate` の `some()` のみ | `manifest.tools.map(name)` を 13 件 expected list と完全一致させ、`ksql_docs` description を検証する。launcher の `some()` も同じ exact list 比較へ置換し、引数なし tool call を追加する |

この 6 箇所は同じ tool 名を複製する必要がある配布境界であり、いずれも削除しない。unit だけを green にして manifest/smoke の追加漏れを見逃さない。

## 7. 仕様 R2 §6 受入条件対応表

| R2 §6 | 受入条件の要点 | 充足 Phase / Step・テスト |
|---:|---|---|
| 1 | 引数なしで統合 index、text-only | Phase 0 Step 0-1、Phase 1 Step 1-1、Phase 3 Step 3-1/3-2、`docsTool.test.ts` |
| 2 | `language-reference` / `recipes` は各 resource index と同一 | Phase 0 Step 0-1、Phase 1 Step 1-1、`docsTool.test.ts` |
| 3 | 代表言語章 / recipe が resource template とバイト同一 | Phase 0 Step 0-1、Phase 3 Step 3-2、Phase 5 Step 5-2/5-3 |
| 4 | `ksql://language-reference/02-select` を正規化 | Phase 1 Step 1-1、`docsTool.test.ts` |
| 5 | unknown / 空 / 空白は app `ArgumentError`、既存 envelope とバイト互換、API 0 | Phase 0 Step 0-1、Phase 3 Step 3-1/3-2、Phase 5 Step 5-2 |
| 6 | unknown property / 非文字列 / 128 超は `-32602` | Phase 0 Step 0-1、Phase 2 Step 2-1、`docsTool.test.ts` |
| 7 | 26＋12＋2 の全 key 往復 | Phase 0 Step 0-1、Phase 1 Step 1-1、Phase 5 Step 5-3 |
| 8 | spelling 別 fixture＋parser/catalog 双方向 drift guard | Phase 0 Step 0-2、Phase 1 Step 1-2、`functionCatalog.test.ts` |
| 9 | instructions の新予算・既存 5 key・docs/catalog key | Phase 0 Step 0-3、Phase 3 Step 3-3、`metadataTools.test.ts`、built/pack instructions guard |
| 10 | smoke 3 呼出し、pack 全 key、embed standalone | Phase 5 Step 5-1/5-2/5-3 |
| 11 | ResourceTemplate `completion/complete` の prefix 結果と tool の同語彙 | Phase 1 Step 1-1、`docsResources.test.ts` / `docsTool.test.ts`。`client.complete(...)` の `05-` / `r1` prefix ケースと、`LANGUAGE_SECTION_KEYS` / `RECIPE_KEYS` 由来の tool key family を集合一致させる |
| 12 | config 不在、全 key、fetch 0 | Phase 0 Step 0-1、Phase 3 Step 3-2、Phase 5 Step 5-2/5-3 |

## 8. テスト戦略

### 8.1 新規 test と既存 test の分担

| 種別 | ファイル | 責務 |
|---|---|---|
| 新規 | `src/mcp/__tests__/docsTool.test.ts` | MCP protocol を通した schema、annotations、index/section、text-only success、二層 error、全 40 key、resource byte equality、config 不在、fetch 0 |
| 新規 | `src/mcp/__tests__/functionCatalog.test.ts` | parser 受理集合・catalog・fixture の三者双方向一致、alias canonical、全 SQL fixture parse |
| 新規 fixture | `src/mcp/__tests__/fixtures/ksqlFunctionCatalogFixtures.ts` | spelling ごとの正しい最小 SQL。実装定数と同じファイルへ埋めず、契約データとしてレビュー可能にする |
| 既存追記 | `src/mcp/__tests__/docsResources.test.ts` | frozen catalog、40 key、統合 index、completion/tool vocabulary、source/embed alias 記述。既存 B50 resource contract を維持 |
| 既存追記 | `src/mcp/__tests__/tools.test.ts` | 登録 exact list と 3 description |
| 既存追記 | `src/mcp/__tests__/metadataTools.test.ts` | 登録 exact list、実 tools/list schema、instructions 240〜280 語・4 段落・包含語 |
| script | `scripts/mcp-smoke.mjs` | fresh built `dist-mcp` の代表 3 calls と bundle I/O 0 |
| script | `scripts/mcp-pack-smoke.mjs` | docs 非同梱 consumer install の全 key embed standalone |
| script | `scripts/mcpb-verify.mjs` | MCPB manifest exact list と実 launcher call |

### 8.2 fetch spy 方針

unit では次の順序を守る。

1. `createServer({ help:false, configPath: 存在しない一時 path })` と InMemoryTransport を用意する。
2. `jest.spyOn(globalThis, "fetch")` を server 接続／tool 呼出し前に置く。
3. client から全 40 key、unknown、空、schema error を実際に `callTool` する。
4. 各結果の契約 assertion 後、`expect(fetchMock).not.toHaveBeenCalled()` を 1 回だけでなく成功群・error 群の境界でも確認する。
5. `finally` で `jest.restoreAllMocks()` と client/server close を必ず行う。

非 bundle ts-jest では `docsResources.ts` import 時に既存 `readFileSync` が走るため、「fs 0」をこの unit で主張しない。fs/network 0 は build embed 済み subprocess に既存 I/O guard を適用する Step 5-2 と、docs ディレクトリ自体がない Step 5-3 で証明する。

### 8.3 実装後の検証コマンド

計画作成時点では実行しない。実装時は対象 test を先に回し、統合時に次を順番どおり実行する。

```powershell
npm test -- --runInBand
npm run build:mcp
npm run mcp:smoke
npm run mcp:pack-smoke
npm run build:mcpb
node scripts/mcpb-verify.mjs
npm run build
git diff --check
```

`npm run mcp:verify` と `npm run mcpb:verify` はそれぞれ `package.json:33-34` で必要 build を内包するため、最終再確認では個別列の代わりに両 verify を使ってよい。ただし `npm run mcp:smoke` 単独は build を内包しない。

## 9. リスクと落とし穴

1. **stale `dist-mcp`:** `scripts/mcp-smoke.mjs:11` は source ではなく `dist-mcp/ksql-mcp.js` を起動する。`index.ts` / docs / catalog の変更後に `npm run build:mcp` を省くと旧 bundle を green と誤認する。
2. **instructions 語数の delimiter 依存:** `metadataTools.test.ts:100-102` は空白分割と空行分割である。catalog のカンマ、矢印周囲の空白、改行位置を変えるだけで語数・段落数が変わる。生成規則と実測値を同時にレビューする。
3. **ts-jest は bundle ではない:** `docsResources.ts:24-26` は ts-jest/dev import で repo markdown を読む。`KSQL_FUNCTION_CATALOG` や instructions builder が `__KSQL_DOCS__` define の存在を前提にしたり、esbuild 専用構文に依存したりしないこと。逆に bundle runtime fs 0 と非 bundle module 初期化時 fs を混同しない。
4. **success builder の誤共有:** 既存 `toToolResult` は成功 payload を JSON text＋`structuredContent` にするため、docs success に使うと仕様 R2 §3.4 違反になる。共有するのは error payload/serialization だけである。
5. **schema と handler の境界:** `.min(1)` や zod transform を入れると空文字が `-32602` になり、誘導付き app error を返せない。trim は handler/helper だけで行う。
6. **URI 正規化の広げ過ぎ:** 除去するのは先頭の `ksql://` 1 回だけ。case folding、URL decode、`..`、partial match、末尾 slash、HTTP URL を受理しない。
7. **tool key の第二定義:** 統合 index、handler、全 key test、completion が別々の配列を持つと B50/B55 が drift する。production key は `LANGUAGE_SECTION_KEYS` / `RECIPE_KEYS` からだけ導出する。
8. **parser の型 union は入力 spelling を失う:** `StringFuncName` は `SUBSTR` を `SUBSTRING` へ正規化後の型しか表せない。runtime token map を export せず `ast.ts` だけを列挙すると alias 逆方向 guard が偽装される。
9. **contextual 関数は使用文脈が異なる:** `TODAY` / `NOW` / `LOGINUSER` を `SELECT F(x)` fixture へ入れてはいけない。特に `LOGINUSER` は SET/DECLARE で拒否される既存契約があるため WHERE fixture にする。
10. **window の alias/OVER:** `parser.ts:1181-1205` は引数なし、`OVER (...)`、`AS alias` を強制する。catalog test の fixture がこの条件を落とすと「カタログ drift」ではなく fixture 自身の構文誤りになる。
11. **pack-smoke の JSON-RPC id ずれ:** 現行 `scripts/mcp-pack-smoke.mjs:330-416` は数値 id を直接参照する。40 calls を挿入すると既存 resource response の id がずれるため、request 名→id map/helper を先に導入する。
12. **MCPB は別の手書き manifest:** server tools/list が正しくても `build-mcpb.mjs:58-71` を更新しなければ配布 UI に出ない。`mcpb-verify` も現在は全 tool exact でないため同時強化する。
13. **言語 alias の仕様記述が現物とずれる:** `CEILING` / `TRUNC` / `POW` は既に記載済みである。重複表を増やさず §4 の correction を先にレビューする。
14. **既存 resource の不変性:** tool 用 index 注記を `KSQL_DOCS.languageReference.index` / `recipes.index` 自体へ書き戻すと resource text が変わる。統合 index は新 helper の返値としてのみ構成する。
15. **大きな output の二重化:** success に `structuredContent` を付けると本文を二重掲載し得る。MCP SDK の返却 object を exact assertion し、`outputSchema` も登録しない。
16. **未コミット作業との混在:** 計画作成時点で `.claude/settings*.json`、`docs/ksql_issue_tracker.md`、B55 issue/spec に既存変更がある。実装 commit では所有外変更を取り込まず、Phase 6 の台帳同期は現行差分を再読して最小 patch にする。

## 10. やらないこと

- 全文検索、キーワード検索、曖昧検索、部分一致、大文字小文字の同一視を追加しない。
- B50 の resources、resource URI、completion、`docsResourceBuilder.cjs`、章分割、build embed define を変更・削除しない。
- 成功時 `structuredContent` / `outputSchema`、本文サイズ上限、本文 truncation を追加しない。
- kintone API、records、ACL、User API、任意 HTTP、任意 path/file read を `ksql_docs` へ接続しない。
- config/profile/token を tool input に追加せず、`createKsqlMcpTools` / runtime / config loader を handler から呼ばない。
- core interface、SQL 文法・意味論、CLI、plugin、ブラウザ UI を変更しない。
- parser が受理する関数を追加・削除・改名しない。Phase 1 Step 1-2 は既存有限集合の export/refactor と guard だけである。
- `IFNULL` / `STDDEV` / `MEDIAN` 等の他方言関数を実装しない。
- prompts を fallback にせず、resources 非対応プロキシ自体を修正対象にしない。
- annotations を security enforcement とみなさない。安全性は固定 lookup、strict schema、I/O 0 test で担保する。
- Claude レビュー前に version bump、release tag、publish、実機結果の完了記載を行わない。
- 本計画書作成タスクでは実装コード、既存文書、テスト、manifest、version を変更しない。

## 11. Claude レビュー重点項目

1. §3.1 の `toErrorPayload` export が public surface を不必要に広げず、docs 専用複製より妥当か。
2. §3.2 の実文 257 語・4 段落と 240〜280 語 guard が、全量 catalog と既存 instructions key を過不足なく保つか。
3. §3.3 の parser runtime 定数 export が実受理経路を本当に一元化し、test 専用第二リストになっていないか。
4. §4 の言語リファレンス現況訂正を仕様 R2 へ直接反映するか、R3/correction として記録するか。
5. `ksql_docs` の登録位置と exact list 6 箇所の順序が配布面で一貫するか。
6. unit の fetch 0、built smoke の fs/network 0、pack-smoke の docs 非同梱が、安全性主張の各範囲を正しく分担しているか。
7. Phase 6 の release 候補 v3.12.0 を B55 単独 minor として確定してよいか。

## 12. Claude レビュー結果（2026-07-21・承認）

計画の記載行番号・シンボルを抽出裏取りし、全件現物一致を確認した（parser の aggregate map :1770-1781／window switch :1169-1176／contextual KINTONE_FUNC :2217-2229／`LOGINUSER` の SET/DECLARE 右辺拒否 :347／`scripts/mcp-resource-io-guard.cjs` 実在／`package.json` の mcp:verify・mcpb:verify が build 内包／`createKsqlMcpTools` は構築時に config を読まない lazy 構造＝Step 0-1 の「config 不在で createServer」成立）。§11 への回答:

1. **承認**。`toErrorPayload` の export 1 点＋docs 専用 success builder は最小変更で「バイト互換」を担保する正解。複製案は将来 drift するため不採用で良い。
2. **承認**。実文案は既存 5 key を全て保持し、仕様 R2 §4.1 のカタログ 6 分類・全量注記・`ksql_docs` 導線・probe 禁止を過不足なく含む。§3.2 の組み立て規則（`join(" ")` 固定・変更時は再実測して guard 同時更新）を実装の必須条件とする。
3. **承認**。`types/ast.ts` union は alias 入力綴りを失うため逆方向の正に使えない、という根拠も正しい。window switch→map 化は AST・エラー文言不変を条件に許容。
4. **仕様へ直接反映で確定**（本プロジェクトの仕様は living doc・R 改訂運用）。仕様 R2 §4.5 は **R2.1 として訂正済み**（未記載は `SUBSTR` のみ・既記載 3 名は重複行を増やさない）。
5. **登録位置を確定**: `ksql_docs` は **`ksql_show_apps` の直後**（read-only discovery 群=describe_app/app_metadata/show_apps/docs の末尾・保存クエリ群の前）。6 箇所の exact list すべて同位置で統一する。
6. **承認**。三層分担（unit=fetch 0／built smoke=io-guard で fs/network 0／pack-smoke=docs 非同梱 standalone）は仕様 §7 の主張範囲と正確に対応する。
7. **v3.12.0 単独 minor を計画上の前提として承認**（最終確定はリリース時のユーザー判断）。

軽微指摘（実装時に対応・計画本文の修正不要）:
- **P3-a**: §8.3 の `npm test -- --runInBand` は不可。`npm test` は `scripts/run-tests.mjs`（parallel＋subprocess の 2 段ランナー）であり jest フラグを素通ししない。素の `npm test` を使うこと（両段の要約を確認する既知の運用）。
- **P3-b**: `registerTool` の `annotations` は使用中 MCP SDK の対応可否を実装冒頭で確認する。非対応版なら annotations を省略し、仕様 §3.1 に「SDK 非対応のため省略」を注記する（安全性はもともと annotations に依存しない）。
