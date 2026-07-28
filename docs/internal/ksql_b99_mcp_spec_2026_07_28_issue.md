# B99 MCP サーバーの新規格（プロトコル改訂 2026-07-28）対応

- 起票: 2026-07-29
- ステータス: 📝 **評価**（**いま着手できない**。SDK 未対応・§3）
- 出典: オーナー指示「MCP サーバーの新規格対応」
- 関連: [B91 MCP 互換モード（クローズ）](ksql_b91_mcp_plugin_compat_mode_issue.md)

## 1. 現状（実測 2026-07-29）

| | |
|---|---|
| SDK | `@modelcontextprotocol/sdk` **1.29.0**（依存 `^1.29.0`・npm latest は **1.30.0**） |
| 対応プロトコル | `LATEST_PROTOCOL_VERSION = "2025-11-25"` ／ 受理は `2025-11-25` / `2025-06-18` / `2025-03-26` / `2024-11-05` / `2024-10-07` |
| transport | **stdio のみ**（`StdioServerTransport`） |
| 公開面 | **tools 13 個・resources 4 個**（`McpServer.registerTool` / `registerResource`） |
| ログ | エラーは **stderr**（`process.stderr.write`） |

## 2. **廃止・削除予定の機能は 1 つも使っていない**（実測）

`src/mcp/` を検索した結果、**該当ゼロ**。

| 2026-07-28 で削除・非推奨 | 使用 |
|---|---|
| `ping` / `logging/setLevel` | ❌ |
| `resources/subscribe` / `unsubscribe` | ❌ |
| Roots / Sampling / Logging（非推奨化） | ❌ |
| Elicitation | ❌ |
| セッション（`Mcp-Session-Id`） | ❌（stdio なのでそもそも無関係） |
| HTTP+SSE transport（非推奨化） | ❌ |

**位置としては良好。**新仕様が消すものを何も使っていない。

## 3. **いま着手できない**＝SDK が新仕様に未対応

**プロトコル改訂 `2026-07-28` は公開されている**が、**それを実装した SDK が存在しない。**

```
npm view @modelcontextprotocol/sdk dist-tags   → { "latest": "1.30.0" }
npm view @modelcontextprotocol/sdk versions    → 79 版・2.x は 0 件
1.30.0（2026-07-27 公開）の LATEST_PROTOCOL_VERSION → "2025-11-25"
```

> **【調査上の注意】WebFetch の要約が「2026-07-28 対応の SDK v2.0.0 が同日公開された」と答えたが、誤りだった。**
> **npm の実データ（`dist-tags` と 79 版の一覧）で否定できる。**
> **今後この件を再評価するときは、要約ではなく `npm view` を根拠にすること。**

**仕様の「現行版」表記も揺れている**＝
[versioning ページ](https://modelcontextprotocol.io/specification/versioning) は
「現行は **2025-11-25**」と書きながら、本文のリンクは全部 `2026-07-28` を指している。
**改訂が出た直後で、表記が追いついていない可能性が高い。**

→ **いま決めるべきは「対応する／しない」ではなく「何を準備し、何を待つか」。**

## 4. 2026-07-28 は何を変えるか

**基盤の作り直しに近い。**（[changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)）

| # | 変更 | 影響 |
|---|---|---|
| 1 | **`initialize` / `notifications/initialized` ハンドシェイクを削除**＝**ステートレス化**。各リクエストが `_meta` にプロトコル版とクライアント能力を載せる | **SDK が吸収** |
| 2 | **セッションと `Mcp-Session-Id` を削除**（Streamable HTTP） | **無関係**（stdio） |
| 3 | **`server/discover` をサーバーが MUST 実装** | **SDK が吸収** |
| 4 | `resources/subscribe` を **`subscriptions/listen`** へ置換 | **無関係**（未使用） |
| 5 | `ping` / `logging/setLevel` を削除 | **無関係**（未使用） |
| 6 | **MRTR**＝サーバー起点リクエスト（`roots/list` / `sampling` / `elicitation`）を廃し、`InputRequiredResult` の往復へ | **無関係**（未使用） |
| 7 | **全 result に `resultType` 必須** | **SDK が吸収** |
| 8 | SSE の再開・再送（`Last-Event-ID`）を削除 | **無関係**（stdio） |
| 9 | **`tools/list` / `resources/list` / `resources/read` の result に `ttlMs` と `cacheScope` が必須**（`CacheableResult`） | ⚠️ **こちらが値を決める** |
| 10 | `tools/list` は**決定的な順序**で返すべき（SHOULD） | ✅ **既に固定順**（`registerTool` の登録順） |
| 11 | `inputSchema` / `outputSchema` が JSON Schema 2020-12 の全キーワードを許容 | 影響なし（緩和方向） |

### 4.1 **こちらが書く必要があるのは §4-9 だけ**

**`ttlMs`（鮮度ヒント・ミリ秒）と `cacheScope`（`"public"` / `"private"`）**を、
**tools / resources のそれぞれについて決める必要がある。**

**判断材料**:

- **tools 13 個の定義は版に固定**＝リリースしない限り変わらない → **長め・`public`** が妥当
- **resources 4 個**は言語リファレンス・レシピ等の**静的文書** → 同上
- **ただし `ksql_docs` などは版で内容が変わる**ので、**版が変われば別サーバー**という前提で良いか要確認

**これは仕様が要求する新しい値**であり、**既存の実装から導けない。**

## 5. いま実施できること

### 5.1 SDK を 1.29.0 → 1.30.0 へ上げる（プロトコルとは無関係）

**1.30.0（2026-07-27）の中身は保守リリース**で、**プロトコル版は 2025-11-25 のまま。**

| 変更 | こちらへの影響 |
|---|---|
| **`@hono/node-server` の脆弱性対応（GHSA-frvp-7c67-39w9）** | ⚠️ **依存木に実在する**（SDK の直接依存）。**stdio なので実行経路には入らないはず**だが、**バンドルに入るかは要確認** |
| Zod スキーマの改善 | 影響あり得る（`src/mcp/schemas.ts` が Zod） |
| SSE keep-alive / Content-Type 検証 | **無関係**（HTTP transport のみ） |

**破壊的変更なし**とのこと。**`mcp:verify` で確かめれば済む規模。**

### 5.2 準備しておけること

- **`ttlMs` / `cacheScope` の値を先に決めておく**（§4.1）。SDK 対応を待たずに議論できる
- **`server/discover` が SDK 実装になることを前提に、こちらの `instructions` が長すぎないか見直す**
  （discover は「能力と識別情報を 1 リクエストで返す」ので、**instructions がそこに載る可能性**がある）

## 6. 対応案

### 6.1 案 A（推奨）— **1.30.0 だけ上げて、2026-07-28 は待つ**

- **SDK が対応するまで着手できない**（§3）
- **廃止される機能を何も使っていない**ので、**待っても負債が増えない**（§2）
- **1.30.0 は保守リリース**なので安く上げられる（§5.1）

### 6.2 案 B — 新仕様を先取りして自前で実装

**採らない。**`server/discover` も `_meta` の版交渉も **JSON-RPC 層の話**であり、
**`McpServer` を迂回して自前で書くことになる。**SDK が対応した時点で**全部捨てる。**

### 6.3 案 C — 何もしない

**1.30.0 の脆弱性対応を見送る理由が無い**ので、案 A のほうが良い。

## 7. 決めること

1. **1.30.0 へ上げるか**（推奨。`mcp:verify` で確認）
2. **`@hono/node-server` が `release/ksql-mcp.js` に実際に入っているか**を確認するか
   （**stdio しか使わないなら bundle から落とせる可能性**があり、それ自体が別の改善になる）
3. **`ttlMs` / `cacheScope` の方針を先に決めるか**（SDK 対応前でも決められる）
4. **再評価の時期**＝SDK が `2026-07-28` に対応した時点。
   **判定は `npm view @modelcontextprotocol/sdk` の実データで行う**（§3 の注意）

## 8. 規模

- 案 A（1.30.0 へ更新＋ゲート確認）: **0.25 人日**
- 2026-07-28 対応（SDK 対応後・`ttlMs` / `cacheScope` を含む）: **未見積もり**。SDK の形が出てから

## 9. 優先度

**低い。**

- **新仕様に着手できない**（SDK 未対応）
- **廃止される機能を使っていない**ので、**待つコストがほぼゼロ**
- **利用者からの要望も出ていない**

**ただし 1.30.0 の脆弱性対応だけは、安いので先に済ませてよい。**
