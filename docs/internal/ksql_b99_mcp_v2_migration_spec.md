# 仕様: B99 — MCP サーバーを SDK v2（プロトコル 2026-07-28）へ移行する

- 作成: 2026-07-29
- 対象課題: [B99](ksql_b99_mcp_spec_2026_07_28_issue.md)（**§11 が spike 結果**）
- ステータス: 📋 **実装待ち**
- 分担: Claude=仕様/レビュー、codex=実装/テスト
- SemVer: **minor**（§9 で根拠。**公開型は不変**・Node 要件は **MCP の面だけ**に閉じる）

---

## 1. 目的

**新旧 2 世代の MCP client を、1 つの stdio サーバーで両方受けられるようにする。**

`2026-07-28` で client の開幕が変わる（`initialize` が無くなる）。
**host ごとに移行時期が違う**ため、**移行期は両方受ける必要がある**。

**spike で成立を確認済み**（[B99 §11](ksql_b99_mcp_spec_2026_07_28_issue.md)）。**本仕様はその実装。**

---

## 2. **Node 20 は MCP の面だけに閉じる**（重要）

**`package.json` の `engines` を宣言しないこと。**

| 面 | Node 20 が要るか | 根拠 |
|---|---|---|
| **MCP サーバー** | ✅ **要る** | `@modelcontextprotocol/server@2` が `node >=20` |
| **CLI** | ❌ **要らない** | `dist-cli/ksql.js` に MCP の import が **0 件**（実測） |
| **engine ライブラリ** | ❌ **要らない** | 別バンドル。MCP を含まないことを guard が保証している |
| **プラグイン** | ❌ **要らない** | ブラウザ面 |

**`engines` は現在そもそも宣言されていない。**ここで `>=20` を足すと、
**CLI 利用者と engine ライブラリ利用者（Pro を含む）に、技術的根拠のない要件を課す**ことになる。

### 2.1 **Node 版を宣言・強制している箇所**は 3 つだけ

| | 現在 | 変更後 |
|---|---|---|
| [`build-mcp.mjs:23`](../../build-mcp.mjs#L23) の target | `node18` | **`node20`** |
| [`build-mcpb.mjs:79`](../../build-mcpb.mjs#L79) の manifest | `>=18.0.0` | **`>=20.0.0`** |
| MCP の導入文書 | — | **Node 20 必須と明記** |

**`build-cli.mjs` の target（`node18`）は変えないこと。**

> **「3 つだけ」は「Node 版を宣言・強制している箇所」の話。**
> **CHANGELOG は要件を**説明**する場所なので、当然書く**（§9）。
> **`release/README.txt` はリリース時にこちらが書く**（§11）。

---

## 3. 依存と import

### 3.1 **すべて devDependency**（R2 で修正）

**初版は `@modelcontextprotocol/server@2` を runtime dependency と書いた。誤り。**
**codex が実装前に指摘した。**

**この package は「runtime 依存ゼロ」で公開している。**

```
package.json の dependencies → （無し）
@modelcontextprotocol/sdk    → devDependencies
dist-mcp/ksql-mcp.js         → SDK をバンドル済み（自己完結）
```

**`scripts/mcp-pack-smoke.mjs` がこの契約を明示的に固定している。**

```js
assert(!existsSync(.../"node_modules"/"@modelcontextprotocol"),
  "@modelcontextprotocol should not be installed in an --omit=dev consumer install.");
assert(!installedPackageJson.dependencies,
  "Published package should not declare runtime dependencies.");
```

→ **v2 も同じ扱いにする。**

```
devDependencies:
  @modelcontextprotocol/server@2   （esbuild がバンドルする・旧 SDK と同じ扱い）
  @modelcontextprotocol/client@2   （v2 smoke 用）
  @modelcontextprotocol/sdk@1.29.0 （v1 smoke 用・残す）
```

> **`mcp-pack-smoke.mjs` の 2 つの assertion は変更しないこと。**
> **「公開 package は runtime 依存ゼロ」は意図して守っている性質**であり、
> **供給網・インストールサイズ・engine ライブラリ利用者との版衝突回避**のためにある。
> **プロトコル移行のために壊すものではない。**

### 3.2 import 元

`@modelcontextprotocol/server` / `@modelcontextprotocol/server/stdio`。

**`@modelcontextprotocol/sdk` を消さないこと**——v1 client で dual-era を検証し続ける（§7.2）。

---

## 4. entry を `serveStdio` にする

```ts
// 現在（src/mcp/index.ts:278-280）
const server = createServer(args);
const transport = new StdioServerTransport();
await server.connect(transport);

// 変更後
serveStdio(() => createServer(args), { transport: <§6 の transport> });
```

- **`legacy` は指定しないこと**（既定 `'serve'` が dual-era）
- **`createServer` の中身（`registerTool` 13・`registerResource` 4）は変更しない**
- **`instructions` は現在どおり `KSQL_MCP_INSTRUCTIONS` を渡す**
  （spike で `server/discover` に全文載ることを確認済み）

---

## 5. エラー class

| 現在 | 変更後 |
|---|---|
| `McpError(ErrorCode.InvalidParams, ...)`（`src/mcp/index.ts:101-109`） | `ProtocolError(INVALID_PARAMS, ...)` |

### 5.1 **経路が 2 つある**（R2 で明確化）

**初版は「`data.uri` を落とさないこと」と書いたが、2 つの経路を混同していた。**
**codex が実装前に指摘した。**

| URI | 経路 | `data` |
|---|---|---|
| どの resource / template にも一致しない | **SDK の resource-not-found** | **`{ uri }` あり** |
| template に一致するがキーが未知 | **こちらの `invalidResourceKey()`** | **なし**（現行） |

**spike で観測した `data.uri` は前者＝SDK 側の性質**であり、**こちらの handler にはもともと無い。**

#### 決めたこと＝**現行維持**

- **こちらの handler に `data` を新設しない**（挙動を変えない）
- **文言と code（`INVALID_PARAMS`）を変えない**
- **SDK 側の経路が `data.uri` を返し続けることは、二本立て smoke で確認する**（§7.2）

> **`data.uri` の新設は改善だが、プロトコル移行と混ぜない。**必要なら別課題。

> **`-32002` → `-32602` の仕様変更はこちらに当てはまらない。**
> **もともと `-32602` を使っており、`-32002` を固定した箇所は 1 つも無い。**

---

## 6. **`maxBufferSize` を明示する**（避けられない）

**v2 の `serveStdio` も既定 10 MiB の読み取り上限を持つ**（1.30.0 と同じ・[B99 §11.4](ksql_b99_mcp_spec_2026_07_28_issue.md)）。
**現在は上限なし**なので、**明示しないと今日受理できている入力が拒否される。**

### 6.1 **【オーナー決定 2026-07-29】256 MiB**（R2 で修正）

**初版は「今日の契約を変えない」と書いたが、原理的に達成できない。**
**codex が実装前に指摘した。**

| 理由 | |
|---|---|
| `sql` に長さ制限が無い | `z.string().min(1)`（`src/mcp/schemas.ts:52`） |
| source `name` に長さ制限が無い | 同 `:39` |
| **text の JSON エスケープは最悪 6 倍** | 全文字が `\\uXXXX` になる場合。**160 MiB → 960 MiB** |

→ **有限の上限を置く以上、「今日受理できる入力の全体」は保てない。**
**どこまで保つかを決めるしかない。**

#### 決めた線

**宣言済みの上限（10 MiB × 16 source）を base64 換算（4/3）した値を覆う。**

```
IMPORT_MAX_BYTES    = 10 MiB
importSources の最大 = 16
  → 生の合計         160 MiB
  → base64 換算（4/3） 213.33 MiB
  → ＋封筒の余裕      → **256 MiB**
```

#### **対象外と明記するもの**

- **text の病的な JSON エスケープ**（制御文字で埋めた 160 MiB＝最悪 960 MiB）
- **`sql` と source `name` の長さ**（**現在も無制限のまま。ここでは制限を新設しない**）

**これらは今日も事実上メモリ枯渇で落ちる。**
**無制限の失敗を有界にする改善**であって、実用上の受理は変わらない
（CSV / JSON の text はエスケープがほとんど増えない）。

#### 実装の形

**値は宣言済みの定数から導いたうえで、選んだ上限がそれを覆っていることをテストで固定する。**

```ts
// 形は任せる。要件は 2 つ。
// ① 宣言済みの定数から「必要な最小値」を導く
// ② 選んだ上限（256 MiB）がそれ以上であることを **テストで固定する**
const REQUIRED = Math.ceil(IMPORT_MAX_BYTES * IMPORT_MAX_SOURCES * 4 / 3);
const MCP_STDIO_MAX_BUFFER_BYTES = 256 * 1024 * 1024;
```

> **テストが要る理由**＝**誰かが `IMPORT_MAX_BYTES` や source 上限を引き上げたとき、
> 上限が足りなくなったことに気づけるようにするため。**
> **マジックナンバーを置くこと自体は許容するが、根拠との整合は機械が見張る。**

### 6.2 境界試験を足す

- **10 MiB のテキスト source 1 本**
- **10 MiB 相当の base64 source 1 本**
- **複数 source の合計が上限近傍**
- **超過時に何が起きるか**（transport 切断は診断しにくいので、**利用者に読めるか**を確認する）

---

## 7. **test / smoke の契約を更新する**

### 7.1 **書き換えを許可する 3 箇所**（これが本移行の必然）

**v2 は `isError: true` と検証内容を保つが、tool result の text から v1 の接頭辞が消える。**

```
v1: MCP error -32602: Invalid arguments for tool ksql_docs: Unrecognized key: "extra"
v2: Input validation error: Invalid arguments for tool ksql_docs: Unrecognized key: "extra"
```

| 場所 | 現在 | 変更後 |
|---|---|---|
| [`scripts/mcp-smoke.mjs:103`](../../scripts/mcp-smoke.mjs#L103) | `text.includes("MCP error -32602")` | **`isError: true` ＋ 検証内容の部分一致** |
| [`scripts/mcp-pack-smoke.mjs:196`](../../scripts/mcp-pack-smoke.mjs#L196) | 同上 | 同上 |
| [`src/mcp/__tests__/docsTool.test.ts:107`](../../src/mcp/__tests__/docsTool.test.ts#L107) | `toContain("-32602")` | 同上 |

**`scripts/mcp-smoke.mjs:545` は変更不要**（`-32602` **または** invalid/unknown なので v2 でも通る）。

#### 7.1.1 **主張を弱めないこと**

**「エラーになった」だけを見る形にしないこと。**最低でも次を保つ:

- **`isError: true`**
- **拒否がハンドラ**前**であること**（現在の smoke が確かめている性質）
- **どのキーが拒否されたか**が文言に出ること（`Unrecognized key: "extra"` など）

**code を観測できる層（client の error object）では code を検査すること。**
**tool result の text に code を埋め込んで照合するのをやめる**——**それが今回壊れた原因**である。

### 7.2 **二本立ての smoke を足す**

**dual-era が成立していることを、以後ずっと検出できるようにする。**

| | 使うもの | 確かめること |
|---|---|---|
| **v1 経路** | `@modelcontextprotocol/sdk@1.29.0` の client | `initialize` で接続でき、**tools 13・resources 2・templates 2** が見える |
| **v2 経路** | `@modelcontextprotocol/client@2` | `server/discover` に **`instructions` が載り**、`tools/list` が **13 個を登録順**で返す |

**片方だけになったら落ちること。**これが本移行の受入の中核。

### 7.3 上記以外で書き換えが必要になったら**止めて報告すること**

---

## 8. bundle guard を新 package へ広げる

**2 つある。両方直すこと。**

| | 現在 | 問題 |
|---|---|---|
| `build-mcp.mjs` の self-contained guard | 旧 SDK と Zod の import しか見ていない | **新 package が素通りする** |
| [`scripts/engine-bundle-guard.mjs:36-37`](../../scripts/engine-bundle-guard.mjs#L36) | `node_modules/@modelcontextprotocol/sdk/` で照合 | **`/server/` `/client/` `/core/` を捕まえない** |

**engine バンドルに MCP が混ざらないことを保証しているのは後者**なので、
**パターンを広げないと保証が抜ける。**

---

## 9. SemVer と移行案内

**minor** とする。

| | |
|---|---|
| 公開型 | **不変**（engine ライブラリの面は一切変わらない） |
| CLI | **不変**（Node 18 のまま） |
| プラグイン | **不変** |
| **MCP サーバー** | **Node 20 が必要になる**＝**この面だけの要件変更** |

**CHANGELOG に、MCP 面の Node 20 要件を明記する。**
**CLI と engine ライブラリには影響しないことも書く**（誤解を防ぐため）。

> **`release/README.txt` は実装では触らない。**
> **リリース時にこちらが書く**（§11）。

> **オーナー確認**: Node 要件の引き上げを major にすべきという判断もあり得る。
> **こちらは「面が MCP に閉じており、公開型も CLI も変わらない」ことから minor を推す。**

---

## 10. 受入条件

1. **v1 client が繋がる**＝`initialize` で接続し、**tools 13・resources 2・templates 2** が見える
2. **v2 client が繋がる**＝`server/discover` に **`KSQL_MCP_INSTRUCTIONS` が全文**載り、
   `tools/list` が **13 個を登録順**で返す
3. **1 と 2 が smoke で恒久的に検出される**（§7.2）
4. **`registerTool` 13 個・`registerResource` 4 個の面が同一**（名前・順序・スキーマ）
5. **stdio の上限が 256 MiB で、宣言済みの上限（`IMPORT_MAX_BYTES` × source 上限 × 4/3）を覆っている**こと。
   **その整合がテストで固定されている**こと（§6.1）＝**上限を引き上げた人が気づける**
6. **`package.json` に `engines` を足していない**（§2）
7. **`build-cli.mjs` の target が `node18` のまま**（§2.1）
8. **engine バンドルに MCP が混ざらない**＝guard が新 package も捕まえる（§8）
8bis. **公開 package の runtime 依存がゼロのまま**＝`mcp-pack-smoke.mjs` の
   `--omit=dev` と `dependencies` の 2 assertion が**無変更で通る**こと（§3.1）
9. **bundle が `node20` target で通る**
10. **既存テスト全 green・snapshot 22 不変**
11. **§7.1 の 3 箇所以外に、挙動の期待を変えた書き換えが無い**

---

## 11. 注意点

- **git 操作は一切しないこと。**
- **`package.json` に `engines` を足さないこと**（§2。最重要）
- **`build-cli.mjs` を変えないこと。**
- **`@modelcontextprotocol/sdk` を削除しないこと**（devDependency として残す・§3）
- **`createServer` の中身（tool / resource の登録）を変えないこと。**
- **`legacy` option を指定しないこと**（既定 `'serve'`）
- **raw `.shape` の非推奨対応をここでやらないこと**（§12）
- **`release/README.txt` は編集しないこと**（リリース時にこちらで書く）
- **`docs/internal/ksql_*.md` を編集しないこと。**
- **snapshot 22 件を更新しないこと。**
- **仕様に矛盾・不足・誤りを見つけたら、黙って直さず、止めて報告すること。**

### 12. **今回やらないこと**

| | 理由 |
|---|---|
| **raw `.shape` overload の解消** | v2 で **deprecated だが動く**。**同時にやると差分が広がり、「面が同一」の検証がしにくくなる**。**別課題** |
| **import の上限自体を下げる** | **§6.1 で 256 MiB と決めた**＝**import の契約（10 MiB × 16）は触らない**。絞るなら別課題 |
| **`sql` / source `name` に長さ制限を新設** | **§6.1 で対象外と明記した**。**現在も無制限**であり、ここで足すと別の挙動変更になる |
| **`ttlMs` / `cacheScope` の作り込み** | **SDK の既定（`0` / `private`）で移行する**。最適化は実 host の cache 挙動を測ってから（[B99 §8](ksql_b99_mcp_spec_2026_07_28_issue.md)） |
| **HTTP transport の追加** | 要望が無い |
