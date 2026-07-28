# B99 MCP サーバーの新規格（プロトコル改訂 2026-07-28）対応

- 起票: 2026-07-29
- ステータス: ✅ **spike 完了・移行可能**（2026-07-29・§11）。**5 点すべて成立**。次は実装仕様。R2 の経緯は §2
- 出典: オーナー指示「MCP サーバーの新規格対応」
- 関連: [B91 MCP 互換モード（クローズ）](ksql_b91_mcp_plugin_compat_mode_issue.md)

## 1. 現状（実測 2026-07-29）

| | |
|---|---|
| SDK | `@modelcontextprotocol/sdk` **1.29.0**（旧モノリシック package・npm latest は 1.30.0） |
| 対応プロトコル | `LATEST_PROTOCOL_VERSION = "2025-11-25"` |
| transport | **stdio のみ**（`StdioServerTransport`・引数なし） |
| 公開面 | **tools 13 個・resources 4 個** |
| bundle target | **Node 18**（`build-mcp.mjs:23`）／MCPB manifest も **`node >=18.0.0`**（`build-mcpb.mjs:79`） |
| inline import | **1 source あたり 10 MiB**（`IMPORT_MAX_BYTES`・最大 16 source） |

---

## 2. **初版の誤りと、その原因**（R2 で修正）

**初版は「2026-07-28 に対応した SDK が存在しないので着手できない」と結論した。誤りだった。**

### 2.1 原因＝**旧 package 名だけを調べた**

**SDK は v2 で package が分割されていた。**

| | |
|---|---|
| 旧 | `@modelcontextprotocol/sdk`（モノリシック・**1.30.0 で打ち止め**） |
| 新 | **`@modelcontextprotocol/server` 2.0.0** / `@modelcontextprotocol/client` 2.0.0 / `@modelcontextprotocol/core` 2.0.0 |

```
npm view @modelcontextprotocol/server version engines.node
→ 2.0.0  >=20
```

**初版は `@modelcontextprotocol/sdk` の `dist-tags` と全 79 版を丁寧に調べ、「2.x は 0 件」を確認した。**
**その観測自体は正しい。結論だけが誤っていた。**

> **【教訓】「正しく調べた」と「正しいものを調べた」は別。**
> **package 名が変わる可能性を疑わなかった。**
> 初版は「WebFetch の要約が誤りだった」ことを教訓として書いたが、
> **その要約（v2.0.0 が存在する）のほうが実は正しく、否定したこちらが誤っていた。**
> **要約を実データで否定するときは、実データの探索範囲そのものを疑うこと。**

### 2.2 「廃止機能を 1 つも使っていない」も誤り

**アプリコードには無いが、SDK が暗黙に実装している。**

```
node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js:33
  this.setRequestHandler(PingRequestSchema, ...)
```

`initialize` / `notifications/initialized` も `server/index.js` が自動登録する。

→ **`ping` と initialize ライフサイクルは「使っている」。**
**grep で該当ゼロなのは `src/` の話であって、公開しているサーバーの話ではない。**

**ただし Roots / Sampling / Logging / Elicitation / `resources/subscribe` は本当に未使用**
（codex も `src/` 全体で確認し、同意している）。
**しかもこれらは「削除」ではなく「非推奨」**で、除去は **2027-07-28 以降**。初版はここも一緒くたにしていた。

### 2.3 `@hono/node-server` は**既に bundle に入っていない**

初版は「入っているなら落とせる可能性がある」と書いたが、**前提が成立しない。**

```
grep -c "hono\|createAdaptorServer" release/ksql-mcp.js → 0
```

esbuild の import graph（`write:false` で確認・codex）でも `honoNodeServerInputs: []`、
transport は `server/stdio.js` のみ。**tree-shaking で既に落ちている。**

→ **`npm audit` が報告する GHSA-frvp-7c67-39w9 は依存木の衛生問題であって、
配布物の実行経路の脆弱性ではない。**

---

## 3. 2026-07-28 は何を変えるか

| # | 変更 | このサーバーへの影響 |
|---|---|---|
| 1 | **`initialize` ハンドシェイク削除＝ステートレス化**。各リクエストの `_meta` に版・能力・識別 | **stdio でも適用される**（初版は「無関係」と誤記） |
| 2 | セッションと `Mcp-Session-Id` 削除（HTTP） | **無関係**（stdio） |
| 3 | **`server/discover` をサーバーが MUST 実装** | **stdio では era 判定の probe にも使われる** |
| 4 | `resources/subscribe` → `subscriptions/listen` | 無関係（未使用） |
| 5 | `ping` / `logging/setLevel` 削除 | **`ping` は SDK 経由で実装済み**（§2.2）。v2 で SDK ごと置き換わる |
| 6 | **MRTR** がサーバー起点リクエストを置換 | 無関係（未使用） |
| 7 | 全 result に `resultType` 必須 | **SDK が付与** |
| 8 | SSE 再開・再送を削除 | **無関係**（stdio） |
| 9 | **`ttlMs` / `cacheScope` が必須**（`CacheableResult`） | **SDK が既定値 `{ttlMs: 0, cacheScope: "private"}` を補う**→ **適合の blocker ではない** |
| 10 | `tools/list` は決定的順序（SHOULD） | ✅ **既に満たしている**（登録順） |

### 3.1 cacheable な operation は 6 つ（初版は 3 つしか挙げていなかった）

`server/discover` / `tools/list` / `prompts/list` / `resources/list` /
**`resources/templates/list`** / `resources/read`

**初版は `server/discover` と `resources/templates/list` を落としていた。**

---

## 4. ~~本当の blocker は SDK ではなく Node 20~~ → **【オーナー決定 2026-07-29】Node 20 で可**

**最低要件を Node 20 へ引き上げてよい**（オーナー判断）。**これで v2 移行の判断材料が揃った。**

以下は決定前の整理として残す。

### 4.1 引き上げる対象（実装時に 4 点そろえる）

| | 現在 | v2 後 |
|---|---|---|
| MCP bundle の target | `node18`（`build-mcp.mjs:23`） | **`node20`** |
| MCPB manifest | `node >=18.0.0`（`build-mcpb.mjs:79`） | **`>=20.0.0`** |
| `package.json` の `engines` | 要確認 | **`>=20`** |
| 文書（導入手順・README） | 要確認 | **Node 20 必須と明記** |

## 4bis. 旧整理

| | |
|---|---|
| v2 の要件 | **`node >=20`**（server / client / core すべて） |
| こちらの現状 | **bundle target Node 18**／**MCPB manifest `>=18.0.0`** |

**利用者に Node 18 が残っているかが分からない。**これが移行の実質的な判断点である。

## 5. アプリ側に必要な変更（初版は「`ttlMs` / `cacheScope` だけ」と誤記）

1. **依存と import の移行**（`@modelcontextprotocol/sdk` → `@modelcontextprotocol/server`）
2. **stdio entry の作り直し**＝v2 は **`serveStdio(factory)`** が
   **modern（`server/discover`）と legacy（`initialize`）を判定して振り分ける**。
   **現在の `new StdioServerTransport(); server.connect(...)` を機械的に残すだけでは dual-era にならない**
3. **Node 最低要件の引き上げ判断**（§4）
4. **`McpError` / `ErrorCode` の移行**（`src/mcp/index.ts:101-109` で使用）→ `ProtocolError` / `INVALID_PARAMS` へ。
   **~~resource not found の code が `-32002` → `-32602` に変わる~~ → こちらには当てはまらない**（§11.3）＝
   **既に `ErrorCode.InvalidParams`（`-32602`）を使っており、`-32002` を固定した箇所は存在しない**。
   **実際に壊れるのは「エラー文言の接頭辞」のほう**（§11.3）
5. **smoke / pack-smoke / MCPB verify を v1 client と v2 client の両方で確認**
6. bundle / manifest / runtime / 版数文書の同期

**引き継げるもの**＝サーバー名・版・**`KSQL_MCP_INSTRUCTIONS`**。
**v2 では `ServerOptions.instructions` に渡せば `server/discover` の応答に載る**
（初版は「載る可能性がある」と弱く書いていた。**載る**）。

---

## 6. **1.30.0 への更新は単純ではない**（初版の「0.25 人日・安全」は誤り）

**1.30.0 は stdio に既定 10 MiB の読み取りバッファ上限を導入する。**

```
1.30.0  dist/esm/shared/stdio.js:2
  export const STDIO_DEFAULT_MAX_BUFFER_SIZE = 10 * 1024 * 1024;
  → 超過で ReadBuffer exceeded maximum size ... を throw

1.29.0  同ファイル → 該当 0 件（上限なし）
```

**こちらの inline import は 1 source あたり 10 MiB を許し、最大 16 source。**

```
src/import/sourceLoader.ts:3  IMPORT_MAX_BYTES = 10 * 1024 * 1024
```

**JSON-RPC の封筒が加わり、base64 なら約 4/3 に膨らむ。**
→ **いま受理できている最大近傍の import リクエストが、更新後に transport 切断になり得る。**

**現在の `new StdioServerTransport()` は引数なし**なので、既定値がそのまま効く。

### 6.1 上げる場合の最低条件

- **`maxBufferSize` を明示する**（inline import の最大メッセージ長と整合させる）
- **境界テストを足す**＝10 MiB のテキスト source／10 MiB の base64／複数 source の合計
- **超過時のエラーが利用者に読めるか**を確認する（transport 切断は診断しにくい）
- `mcp:verify` だけでは足りない

---

## 7. 対応案（R2）

### 7.1 案 A'（推奨）— **Node 20 を先に決め、v2 の dual-era 移行を spike する**

1. **MCP / MCPB の最低要件を Node 20 にできるかを決める**（§4）
2. **`@modelcontextprotocol/server@2.0.0` で dual-era stdio の spike**
   〔`serveStdio(factory)`／既存の name・version・instructions を再利用／
   tools 13・resources 4 の面の同一性／v1 client の initialize fallback／v2 client の `server/discover`〕
3. **Node 18 の維持が必要なら**、v1 を production に残しつつ v2 を別ターゲットとして準備
4. **1.30.0 の更新は v2 対応と切り離し、§6.1 を済ませてから**

### 7.2 案 B（自前実装）— **不採用**

**v2 stable が存在する以上、検討する理由がない。**

### 7.3 案 C（何もしない）— **不採用**

`ping` / initialize を SDK 経由で実装しており、**新仕様では消える**。放置すると v2 移行の負債になる。

---

## 8. `ttlMs` / `cacheScope` を決めるのに要る情報

**適合のためには不要**（SDK が `{ttlMs: 0, cacheScope: "private"}` を補う・§3-9）。
**最適化として決めるなら**、次が要る。

1. **対象 host / client が result cache を実装しているか**。プロセス再起動や更新をまたいで保持するか
2. **更新の反映遅延をどこまで許すか**（リリース後、旧 cache が何分残ってよいか）
3. **面が caller / config で変わるか**（profile・configPath・認証主体）。**現状は固定に見える**
4. **operation ごとの機密性**（`resources/read` の埋め込み文書に利用者固有情報が混ざらないか）
5. **無効化の手段**（`listChanged` を送るか・再起動で client cache を落とせるか）
6. **resource 単位の方針**（言語リファレンス索引／レシピ索引／各セクション で TTL を変えるか）

**暫定方針**＝**まず SDK 既定（`0` / `private`）で移行し、実際の cache 挙動を測ってから、
面が固定のものだけ `public` と有限 TTL を入れる。**
stdio では共有中間者がいないので `public` / `private` の実効差は小さいが、
**将来 HTTP 化しても安全な値にしておく。**

---

## 9. 優先度（R2 で 低 → **中**）

**初版の「低」の根拠が 2 つとも崩れた。**

| 初版の根拠 | R2 |
|---|---|
| SDK 未対応で着手できない | ❌ **v2 stable が公開済み** |
| 廃止機能を何も使っていない | ❌ **`ping` / initialize を SDK 経由で実装している** |

**ただし即時の本番切替を「高」にする根拠も無い。**

- **versioning ページは現行を `2025-11-25` と表示したまま**（反映遅れか意図的かは不明）
- **利用者要望が出ていない**
- **modern-only client がいつ現れるかが分からない**
- **Node 20 の利用者影響が分からない**

→ **評価・spike は「中」。本番切替は Node 20 と host の状況を確認してから再判定。**

---

## 10. 分からないこと（推測で埋めない）

- 対象 host（Claude Desktop / Codex ほか）が **いつ modern-only client になるか**
- **MCP / MCPB 利用者に Node 18 が残っているか**
- 各 host が **cache hint を実際にどう扱うか**
- **v2 へ移した場合のコンパイルエラー・bundle サイズ・smoke の結果**（実装していないため未確認）
- **versioning ページの `current = 2025-11-25` が反映遅れか意図的か**

---

## 11. spike 結果（2026-07-29・codex 実施）

**5 点すべて成立。dual-era stdio は謳いどおり動く。**

### 11.1 確かめた 5 点

| # | 結果 | 実測 |
|---|---|---|
| ① **13 tools・4 resources が乗るか** | ✅ | **Zod は変更不要**（repo は既に `zod 4.4.3`・v2 の要件は `^4.2.0`）。strict schema と discriminated union の拒否も維持 |
| ② **v1 client が繋がるか** | ✅ | `@modelcontextprotocol/sdk@1.29.0` の client が `initialize` で接続。tools 13・resources 2・templates 2 を取得。**`legacy` は省略（既定 `'serve'`）** |
| ③ **v2 client が正しい面を見るか** | ✅ | `supportedVersions: ["2026-07-28"]`／**`KSQL_MCP_INSTRUCTIONS` が全文載る**／`ttlMs: 0`／`cacheScope: "private"`／`resultType: "complete"`／**`tools/list` は 13 個を登録順** |
| ④ **bundle** | ✅ | `node20` target で通る。**2,744,642 → 2,761,641 bytes（+0.62%）**。**`@hono/node-server` は metafile・bundle 文字列とも 0 のまま** |
| ⑤ **既存ゲートの落下点** | ✅（把握できた） | **落ちるのは 4 箇所だけ**（§11.3） |

### 11.2 コード差は 3 点だけ

1. import を `@modelcontextprotocol/server` / `@modelcontextprotocol/server/stdio` へ
2. `McpError(ErrorCode.InvalidParams, ...)` → `ProtocolError(INVALID_PARAMS, ...)`
3. `new StdioServerTransport(); server.connect(...)` → **`serveStdio(() => createServer(args))`**

**`registerTool` 13 個と `registerResource` 4 個は無変更。**

### 11.3 **壊れるのは 4 箇所。原因は 1 つ**

**エラー**コード**ではなく、エラー**文言**の固定。**

| 場所 | 固定している文字列 |
|---|---|
| `scripts/mcp-smoke.mjs:103` | `MCP error -32602` |
| `scripts/mcp-pack-smoke.mjs:196` | `MCP error -32602` |
| `src/mcp/__tests__/docsTool.test.ts:107` | `-32602` |
| （`scripts/mcp-smoke.mjs:545` は `-32602` または invalid/unknown なので **v2 でも通る**） |

**v2 は `isError: true` と検証内容を保つが、tool result の text から v1 の `MCP error -32602` 接頭辞が消える。**

```
v1: MCP error -32602: Invalid arguments for tool ksql_docs: Unrecognized key: "extra"
v2: Input validation error: Invalid arguments for tool ksql_docs: Unrecognized key: "extra"
```

> **§5-4 の想定は外れていた。**
> **`-32002` → `-32602` の仕様変更はこちらに当てはまらない**＝
> **もともと `ErrorCode.InvalidParams`（`-32602`）を使っており、`-32002` を固定した箇所は 1 つも無い**
> （v1 client でも v2 client でも `-32602` を実測）。
> **当てはまったのは「文言に code を埋め込んで固定していた」ほう。**

### 11.4 spike で新たに分かったこと

1. **`serveStdio` の既定読み取りバッファも 10 MiB。**
   → **§6 の問題は 1.30.0 固有ではなく、v2 でも同じ**。
   **inline import の最大メッセージ長に合わせて `maxBufferSize` を明示し、境界試験を足す必要がある**（どちらの道でも避けられない）
2. **raw `.shape` を渡す overload は v2 で deprecated**（動くが非推奨）。
   `z.object({...})` を渡す形へ直すか、別課題にするかの判断が要る
3. **`build-mcp.mjs` の self-contained guard が旧 SDK と Zod の import しか検査していない。**
   **新 package も禁止対象に加える必要がある**

### 11.5 本番移行の作業一覧

1. 依存と import を分割 package へ（runtime は `@modelcontextprotocol/server@2`）
2. stdio entry を `serveStdio(factory)` へ
3. エラー class の置換（`ProtocolError` / `INVALID_PARAMS` / `ResourceNotFoundError`）
4. **Node >=20 を 4 箇所そろえる**（§4.1）
5. **test / smoke の検証契約を更新**＝**文言の `MCP error -32602` 固定を外し、
   code を観測できる層では code を、tool result では `isError` と検証内容を見る**
6. **v1 の `initialize` と v2 の `server/discover` の二本立て smoke を足す**
7. raw `.shape` の扱いを決める（同時にやるか別課題か）
8. **`maxBufferSize` を明示し境界試験を足す**（§11.4-1）
9. `build-mcp.mjs` の self-contained guard を新 package へ拡張

### 11.6 spike の後片付け（実施済み）

- `scripts/b99-spike-*.mjs` 2 本を削除
- `npm ci` で `node_modules` を lock どおりに再構築（v2 の extraneous package を除去）
- **`package.json` と `package-lock.json` は spike 中も無変更**（SHA256 が前後一致）
- **復旧確認**＝196 suites / 4,982 tests green・`mcp:verify` ok

### 11.7 spike でも分からなかったこと

- 実 host（Claude Desktop / Codex 等）が**いつ modern-only になるか**
- 各 host の **cache hint の実装と保持期間**
- **Node 20 引き上げの実利用者影響**
- **安全な `maxBufferSize` の具体値**（最大 16 source の合計 envelope を別途測る必要がある）
- v2 の deprecated raw-shape overload が**いつ削除されるか**
