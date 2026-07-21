# B55 — MCP read-only ドキュメントツール `ksql_docs` 仕様（R2）

- ステータス: **R2.1 実装済み・実機 PASS（2026-07-21・v3.12.0・[evidence](evidence/b55_claude_desktop_smoke.md)・リリース手順のみ残）**
- 課題: [B55 issue](ksql_b55_mcp_docs_tool_fallback_issue.md)（§6 に根本原因確定＝中継プロキシが resources/prompts capability を通さない）
- 関連: **B50**（`docsResourceBuilder.cjs` の embed・章別 resource template・fail-closed key＝本仕様の土台）／**B49**（read-only ツールの前例）
- 対象面: **Node MCP のみ**（core interface / SQL / CLI / plugin 非改変）
- SemVer: **minor**（新ツール追加・既存挙動の変更なし）
- 改訂履歴: R1（2026-07-21）→ **R2** = codex レビュー P1×2/P2×5/P3×2 反映（関数カタログ全量化・空文字エラー経路の整合・双方向 drift guard・変更対象ファイル完備・instructions 予算再定義・安全性主張の限定・§7 未決論点の確定）→ **R2.1** = §4.5 の言語リファレンス現況を訂正（計画 R1 §4.1 の指摘＝未記載は `SUBSTR` のみ）

## 1. 背景（1段落）

B50（v3.9.0）で言語リファレンス・レシピを MCP resource として公開したが、**MCP resources / prompts はクライアント任意機能**であり、Claude Desktop のデバイスブリッジ（`remote-devices` プロキシ）のように **tools だけ中継し resources/prompts capability を通さない**経路が実在する（2026-07-21 実測：読み取り `does not support resources`・列挙 `No resources found`→モデルが `ksql_validate` 総当たりで不完全な関数洗い出しを実施）。tools はどのクライアントでも届く唯一の経路のため、**同じ embed 済みドキュメントへ tool 経由で到達できる導線**を追加する。prompts を代替導線にする案は同じ理由で不成立（課題 §6）。

## 2. 目的 / 非目的

**目的**
- resources 非対応（capability 非中継含む）クライアントでも、tool 呼び出しだけで言語リファレンス・レシピの索引と各章本文へ到達できる。
- server instructions に**全量の関数カタログ**（名前のみ・分類付き）と `ksql_docs` への導線を追記し、プローブ行動（validate 総当たり）自体を抑止する。

**非目的**
- 全文検索・キーワード検索（v1 対象外。章キー指定のみ）。
- 既存 resource 公開（B50）の変更・削除（**resource は不変のまま並存**）。
- ドキュメント本文の生成方法の変更（`docsResourceBuilder.cjs` の embed・章分割ロジックは非改変・再利用）。
- kintone API 呼び出し（本ツールは**ゼロ**）。records/ACL 系の露出（該当なし）。

## 3. ツール仕様 `ksql_docs`

### 3.1 登録

- `src/mcp/index.ts` の `createServer` 内で `server.registerTool("ksql_docs", …)` として登録する。
- ハンドラは `KSQL_DOCS` / `LANGUAGE_SECTION_KEYS` / `RECIPE_KEYS`（`docsResources.ts`）の**固定プロパティ lookup のみ**。`createKsqlMcpTools`（config/profile/認証配管）・runtime・config loader・`fetch`・`fs` を**呼ばない**＝資格情報・設定ファイルなしでも常に応答する。
- `annotations: { readOnlyHint: true, openWorldHint: false }` を付与する（MCP 2025-06-18。クライアント向け表示補助であり安全ガードの代替ではない）。

### 3.2 入力（zod）と二層エラー契約

```ts
export const ksqlDocsInputShape = z.object({
  section: z.string().max(128).optional(),
}).strict();
```

- **`.min(1)` は置かない**（R1 から変更）。`section: ""` を schema で弾くと protocol error（`-32602`）になり §3.5 のアプリレベル fail-closed と矛盾するため、空文字・空白のみは **handler 側で trim 後にアプリレベル `ArgumentError`** に統一する。
- **二層契約を明文化する**: ①未知プロパティ（`.strict()`）・非文字列・128 文字超 → **protocol error `-32602`**（schema 層・B49 と同じ）。②文字列としては妥当だがキーとして無効（未知キー・空文字・空白のみ）→ **アプリレベル `ok:false ArgumentError`**（§3.5・discovery 目的のため有効キーへの誘導文を返す）。B49 の `-32602` は HTTP/API 安全境界の強制、B55 のアプリレベルエラーは教育的導線、という使い分け。
- `section` **省略時**: 統合インデックスを返す（§3.4）。「まず引数なしで呼べば有効キーが全部わかる」導線を成立させる。

### 3.3 キー体系（resource URI と同一の語彙）

| `section` 値 | 返す内容 | 対応 resource |
|---|---|---|
| （省略） | 統合インデックス（§3.4） | — |
| `language-reference` | 言語リファレンス索引 | `ksql://language-reference` |
| `language-reference/<key>` | 言語リファレンス 1 章（`<key>` は既存 26 キー: `01-basic-rules` … `26-assert`） | `ksql://language-reference/{section}` |
| `recipes` | レシピ索引 | `ksql://recipes` |
| `recipes/r1` … `recipes/r12` | レシピ 1 章 | `ksql://recipes/{recipe}` |

- キーは **B50 の既存キーをそのまま使う**（`LANGUAGE_SECTION_KEYS` / `RECIPE_KEYS` が唯一の正・新規キー定義なし）。resource template の `complete` コールバックも同じ定数を参照しており、**resource で読める環境と tool しか使えない環境で同じキーが通る**ことを不変条件とする（一致テスト §6-11）。
- 正規化は 2 点のみ: 前後空白 trim・先頭の `ksql://` プレフィックス除去（resource URI をそのまま貼っても通す）。大文字小文字の同一視・部分一致・曖昧マッチは**行わない**（fail-closed の明確さを優先）。

### 3.4 出力

- 成功時は **markdown テキストのみ**を `content: [{ type: "text", text }]` に載せる（embed 済み `section.text` / `index` を無加工で返す）。**`outputSchema` は宣言せず、成功時の `structuredContent` も返さない**（R1 の「小メタのみ structuredContent」から変更。根拠: MCP 2025-06-18 は structuredContent を返す場合に同一 JSON の text ミラーを推奨しており、markdown 本文が主体の本ツールでは「本文 text＋別内容の structuredContent」が推奨と半端にずれる。純テキストに倒すのが最も単純で、本文の二重掲載（トークン二重化）も避けられる）。
- エラー時は既存規約どおり **JSON エラー envelope を text と structuredContent の両方**に載せる（§3.5・既存ツールとの一貫性維持）。
- 統合インデックス（`section` 省略時）= 言語リファレンス索引＋レシピ索引を連結し、末尾に「`ksql_docs` の有効 `section` キー一覧」（`language-reference` / `language-reference/<26キー>` / `recipes` / `recipes/r1..r12`）を機械可読な列挙で付す。索引内の `ksql://…` リンクの直後に tool での読み方（`ksql_docs {"section":"language-reference/05-string-number-functions"}` の形）を 1 行注記する。
- サイズ上限: 新設しない（embed 済み静的テキスト・最大章でも数十 KB・B49 の 2 MiB ガードは外部 API 応答向けで該当しない）。

### 3.5 エラー（fail-closed）と共有 error builder

未知キー・空文字・空白のみ（trim 後空）はすべて:

```json
{ "ok": false, "error": { "code": "ArgumentError",
  "message": "Unknown ksql_docs section key: <入力値>. Valid keys: language-reference, language-reference/<key>, recipes, recipes/r1..r12. Call ksql_docs without arguments for the full key list." } }
```

- `isError: true`・既存 `toErrorPayload` 規約（メッセージ接頭辞 `ArgumentError:` から code 導出）に従う。
- **実装上の前提（R2 で明確化）**: `toErrorPayload` / `runSafely` は `tools.ts` の private（tools.ts:393）で、`createKsqlMcpTools` を経由しない本ハンドラからは現状再利用できない。**`toErrorPayload` を export して共有する**（推奨・挙動不変の可視性変更のみ）か、同一規約の docs 専用 error builder を新設するかを実装時に確定し、**エラー envelope の形は既存ツールとバイト互換**にする。成功側は既存 `toToolResult`（payload を text/structuredContent 両載せ）と契約が異なるため**使わず**、docs 専用の success builder（text のみ）を新設する。
- message には**キー族の形**を載せ、全 40 キーの列挙は引数なし呼び出しへ誘導する（メッセージ肥大回避）。

## 4. instructions / 既存 description / 言語リファレンスの変更

### 4.1 server instructions への追記（`KSQL_MCP_INSTRUCTIONS`）

末尾段落（現行「Read ksql://language-reference and ksql://recipes …」）を次の趣旨に差し替える:

1. **導線の一本化**: 「言語リファレンス・レシピは MCP resource（`ksql://…`）**または** `ksql_docs` ツールで読める。resource が列挙できないクライアントでは `ksql_docs` を引数なしで呼び、索引から必要な章だけ読むこと。**関数の有無を validate の試行錯誤で推定しないこと**」。
2. **関数カタログ（名前のみ・6 分類・R2 で全量化）**:
   - **Scalar**: `UPPER LOWER TRIM LTRIM RTRIM LENGTH LENGTH_CHAR SUBSTRING LEFT RIGHT INSTR CONCAT REPLACE REGEXP_LIKE REGEXP_REPLACE REGEXP_SUBSTR TRANSLATE COALESCE ISNULL NULLIF GREATEST LEAST LPAD RPAD ROUND FLOOR CEIL TRUNCATE ABS MOD POWER SQRT FORMAT CAST YEAR MONTH DAY DATE_FORMAT DATEDIFF DATE_ADD LAST_DAY CURRENT_DATE CURRENT_TIMESTAMP`
   - **Aggregate**: `COUNT SUM AVG MIN MAX GROUP_CONCAT`
   - **Window**: `ROW_NUMBER RANK DENSE_RANK`（`OVER` 必須・`AS alias` 必須）
   - **Contextual（kintone 文脈関数）**: `TODAY NOW LOGINUSER`（WHERE 等の kintone 文脈で使用。`LOGINUSER` は Node/MCP 実行では空文字解決）
   - **Aliases（パーサ正規化）**: `SUBSTR`→`SUBSTRING`・`CONVERT`→`CAST`・`CEILING`→`CEIL`・`TRUNC`→`TRUNCATE`・`POW`→`POWER`
   - **Syntax**: `IF(cond, then, else)`（`CASE WHEN` へ脱糖）・演算子 `||`（連結）・`LIKE`（JS 意味論）・`KLIKE`・`IN`・`BETWEEN`・`IS NULL`・`CASE WHEN`
   - 注記 1 行: **この一覧が全量**（`IFNULL`/`STDDEV`/`MEDIAN` 等の他方言関数は存在しない。~~NOW は存在しない~~ ← R1 の誤り・NOW は Contextual に実在。詳細な引数・制約は `ksql_docs` の該当章で確認）。

### 4.2 カタログの単一ソースと双方向 drift guard（R2 で強化）

- カタログは frozen 定数 **`KSQL_FUNCTION_CATALOG`**（`{ scalar, aggregate, window, contextual, aliases, syntax }`）として `docsResources.ts`（または隣接ファイル）に定義し、instructions 文字列はそこから組み立てる。
- **順方向 guard**: カタログの全受理スペルについて、**スペルごとの正しい最小 SQL fixture** でパース通過を検証する（一律 `SELECT F(x)` ではなく: `CAST(x AS TEXT)`・`CURRENT_DATE()`・`IF(条件, a, b)`・集計は `SELECT SUM(x) … GROUP BY`・window は `OVER () AS rn` 付き・contextual は `WHERE 日付 = TODAY()` 系）。
- **逆方向 guard（R1 の「網羅不能」を撤回）**: パーサの受理集合は無限ではなく**明示的な token map（parser.ts:1609 の `tryStringFuncName`）＋IDENT 先読み 2 名（`CURRENT_DATE`/`CURRENT_TIMESTAMP`）＋集計/ウィンドウ/文脈関数の有限列挙**で構成される。この受理集合を実装から導出（または並置定数として export）し、**カタログ集合との双方向一致**をテストで固定する。関数追加時はカタログ更新がテストで強制される。

### 4.3 既存 tool description の微修正（3 箇所・R2 で 1 箇所追加）

- `ksql_query` / `ksql_mutate` の description 末尾「read ksql://language-reference」→「read ksql://language-reference (or call ksql_docs when resources are unavailable)」。
- **`ksql_validate` の description に追記**（codex 提案採用）: 「Do not use validate probing to discover functions or syntax; call ksql_docs instead.」

### 4.4 instructions ガードテストの再定義（R2 新設）

- 現行テストは instructions を **150〜220 語・3 段落**に固定している（metadataTools.test.ts:100-102）。カタログ追加で確実に超過するため、**上限を単に外すのではなく**: 既存 3 段落を圧縮した上でカタログ段落を加えた**新予算（語数レンジ・段落数）を実装時に確定し、テストを新予算で再固定**する。既存の包含アサーション（"not generic SQL" 等 5 キー）は維持し、新たに `ksql_docs`・カタログ代表名の包含を追加する。

### 4.5 言語リファレンスの同期（R2 新設・R2.1 訂正）

- **R2.1 訂正（計画 R1 §4.1 の指摘・現物確認済み）**: `CEILING`（言語 §5 :504「も可」）・`TRUNC`（:505「も可」）・`POW`（:530「も可」）は**既に記載済み**。未記載は **`SUBSTR` のみ**（`SUBSTRING` 行 :426 に注記なし）。R2 の「4 名とも未記載」は誤りだった。
- 実装では: `SUBSTRING` 行へ「`SUBSTR` も可」を追記し、5 エイリアス（`SUBSTR`/`CONVERT`/`CEILING`/`TRUNC`/`POW`）の canonical 対応を 1 箇所で確認できる注記を §5 に追加する。既記載 3 名の重複行は増やさない。

## 5. 実装方針・変更対象ファイル（R2 で完備）

- `src/mcp/index.ts` — tool 登録＋instructions 組み立て＋docs 専用 success/error builder（または `tools.ts` から `toErrorPayload` export）。
- `src/mcp/schemas.ts` — `ksqlDocsInputShape`。
- `src/mcp/docsResources.ts` — 統合インデックス組み立てヘルパ＋`KSQL_FUNCTION_CATALOG`。
- `src/mcp/tools.ts` — `toErrorPayload` の export 化（採用時のみ・挙動不変）。
- **既存 exact 検証の更新（追加漏れ厳禁・codex P2-2）**: `src/mcp/__tests__/tools.test.ts`（tool list）・`src/mcp/__tests__/metadataTools.test.ts`（tool list 完全一致 :56 と instructions 予算 :100）・`scripts/mcp-smoke.mjs`（`expectedTools` :19）・`scripts/mcp-pack-smoke.mjs`（`expectedTools` :20）・`build-mcpb.mjs`（manifest 手書き tool list :58）・`scripts/mcpb-verify.mjs`（manifest assertion）。
- `docs/ksql_language_reference.md` — §4.5 のエイリアス追記。
- `docsResourceBuilder.cjs`・build embed（`build-mcp.mjs` の `__KSQL_DOCS__` define）・resource 登録は**非改変**。

## 6. テスト（受入条件を兼ねる・R2 改訂）

1. 引数なし → 統合インデックス（両索引＋有効キー全列挙）を返す。text のみ・成功時 structuredContent なし。
2. `section:"language-reference"` / `"recipes"` → 各索引（resource と同一テキスト）。
3. `section:"language-reference/05-string-number-functions"` / `"recipes/r3"` → 章本文（resource template と**バイト同一**）。
4. `ksql://language-reference/02-select` の URI 形 → プレフィックス除去で同一結果。
5. **アプリレベル fail-closed**: 未知キー（`language-reference/99-x`・`STDDEV`）・`""`・空白のみ → `ok:false ArgumentError`＋誘導 message・`isError:true`・envelope は既存ツールとバイト互換・kintone API 呼び出しゼロ。
6. **protocol error 契約**: 未知プロパティ・非文字列（数値等）・128 文字超 → `-32602`（handler 未到達）。
7. 26＋12＋2 の全キーで成功（全キー往復・resource 実装との一致）。
8. **双方向 drift guard**（§4.2）: スペル別 fixture 全通過＋パーサ受理集合とカタログ集合の一致。
9. instructions: 新予算（語数・段落数）で固定＋既存 5 キー・`ksql_docs`・カタログ代表名の包含。
10. `mcp:smoke` / pack-smoke: `expectedTools` へ `ksql_docs` 追加・引数なし/1 章/未知キーの 3 呼び出し・pack-smoke（docs 非同梱の npm install 環境）で全キー応答＝embed standalone 検証。
11. **ResourceTemplate completion との同語彙**（codex P3-1）: `completion/complete` の prefix ケースと、tool の有効キー集合が同じ定数（`LANGUAGE_SECTION_KEYS`/`RECIPE_KEYS`）から得られることの一致テスト。
12. **安全性**（§7）: config 不在で全キー応答＋fetch spy で HTTP 呼び出しゼロ。

## 7. 安全性の主張（R2 で範囲限定）

- **配布 bundle（MCPB / npm install の dist-mcp）runtime の `ksql_docs` 呼び出しにおいて**: kintone API・資格情報・ネットワーク・**ファイルシステム I/O ゼロ**（`__KSQL_DOCS__` build-time embed の固定 map lookup のみ・入力を path/URL として解釈しない・128 文字超の入力は本文へ反映されない）。
- 非 bundle 実行（ts-jest / dev import）では `docsResources.ts` のモジュール初期化が repo の markdown を `readFileSync` する（既存 B50 挙動・ツール呼び出し起因ではない）。「全実行形態で fs ゼロ」とは**主張しない**。

## 8. 確定した設計判断（R1 §7 未決論点の解決・codex 回答一致）

1. **引数体系** = 単一 `section`（codex 支持。`doc`+`section` 2 引数は不正な組合せを増やすだけ）。
2. **未知キーのアプリレベルエラー** = 採用（codex 支持。B49 は安全境界＝schema 拒否・B55 は discovery＝誘導。ただし `""` の経路を §3.2 で schema から外し一貫化。型違い・未知プロパティ・過長は `-32602` のまま）。
3. **structuredContent** = 成功時は返さない・純テキスト（codex は「小メタ可」だったが、MCP 2025-06-18 のミラー推奨との整合を優先し R2 でより単純な純テキストに確定。エラー時のみ既存 JSON envelope 両載せ）。
4. **カタログ配置** = instructions に掲載を維持（codex 支持。統合インデックスだけではツールを呼ぶ前のプローブを止められない）。canonical/alias/contextual を短く分離し語数予算を §4.4 で再固定。
5. **エイリアス確定** = パーサ受理表から確定: `SUBSTR`/`CONVERT`/`CEILING`/`TRUNC`/`POW`＋構文 alias `IF`（§4.2 の双方向テストで固定）。

## 9. 次アクション

- R2 のユーザー承認 → codex 実装 → Claude コードレビュー → MCP 実機（resources 非対応経路の Claude Desktop 含む）→ リリース版数判断（v3.12.0 候補・minor）。
