# 仕様: B101 案 A' — `instructions` に MCP サーバーの版数を載せる

- 作成: 2026-07-29
- 対象課題: [B101](ksql_b101_mcp_stale_process_version_issue.md)（**§2ter が経緯・§4 の案 A'**）
- ステータス: ✅ **完了（v3.34.1 でリリース）**（2026-07-29）＝**受入 1〜7 すべて満たし全ゲート green**。**語数は予想と一致**（`{ total: 553, catalog: 258, prose: 295 }`）
- 分担: Claude=仕様/レビュー、codex=実装/テスト
- SemVer: **patch**（挙動・公開型・ツールの面はいずれも不変。`instructions` の文面に 1 行増えるだけ）

## 1. 何を解決するか

**常駐 MCP サーバーが古い版のまま答えても、利用者に分からない。**

**実際に起きた**——Pro は v3.34.0 の検証として「B98 が再現しない」と報告したが、
その測定はすべて v3.33.0 の挙動だった。`npm install` はディスクを置き換えるが、
**常駐プロセスが読み込み済みのモジュールは差し替わらない。**

**標準の `_meta['io.modelcontextprotocol/serverInfo']` は届かない。**
**実クライアント 2 つ（Pro のクライアント・Claude Code）で、ツール結果の中身しか受け取れない**
ことを確認済み（[B101 §2ter](ksql_b101_mcp_stale_process_version_issue.md)）。

## 2. 決めたこと

**`KSQL_MCP_INSTRUCTIONS` の先頭に、版数の 1 行を置く。**

```
kSQL MCP server version ${SERVER_VERSION}.
```

**`SERVER_VERSION` は `src/mcp/index.ts:89` に既にある。**
**新しい定数を作らないこと。**

### 2.1 なぜ `instructions` か

| | |
|---|---|
| **`_meta` が落ちるクライアントにも届く** | `instructions` は AI の文脈にそのまま入る |
| **プロセスの版を測る** | **接続時に、その常駐プロセス自身が返す**。ディスクの版ではない |
| **era を選ばない** | **v1 の `initialize` と v2 の `server/discover` の両方**に載る（`_meta` は v2 のみ） |

### 2.2 なぜ `ksql_docs` ではないか

**`ksql_docs` は文書を返す tool であり、版数は文書ではない。**
**`instructions` は「このサーバーは何者か」を伝える場所なので、版数はそこに属する。**

## 3. 置き場所

**`KSQL_MCP_INSTRUCTIONS` の 1 行目。**現在の 1 行目の前に、独立した段落として置く。

```
kSQL MCP server version ${SERVER_VERSION}.

kSQL is a SQL-like dialect for kintone, not generic SQL. ...
```

**既存の段落・文言を書き換えないこと。**

## 4. 語数予算（B81）

**`src/mcp/__tests__/metadataTools.test.ts:120` の exact 固定を更新する。**

```
現在: { total: 548, catalog: 258, prose: 290 }
```

**予想＝5 語増**（`kSQL` / `MCP` / `server` / `version` / `<版数>.`）。

```
予想: { total: 553, catalog: 258, prose: 295 }
```

- **`catalog` は変わらない。**カタログ「データ」から数えるため
- **`prose` の上限 320 に収まる**（295）
- **版数の語数は版によらず 1 語**なので、**リリースのたびに期待値が動くことはない**

> **実測が予想と違ったら、期待値を勝手に合わせず、止めて報告すること。**
> **こちらの数え方が誤っている可能性がある。**

### 4.1 テスト環境と bundle で値が変わらないこと

**jest では `__KSQL_VERSION__` が未定義なので `SERVER_VERSION` は `"0.0.0-dev"` になる。**
**bundle では `"3.34.1"` のように実際の版数になる。**
**どちらも 1 語**なので語数は一致する。**この前提が崩れたら止めて報告すること。**

### 4.2 段落数の exact 固定（**R2 で追記**）

**同じテストに段落数の exact 固定がある。**

```ts
expect(instructions?.trim().split(/

/)).toHaveLength(5);   // → 6 へ更新する
```

**初版は「語数予算の exact 値のみ」と書いた。狭すぎた。**
**codex が実装前に指摘した。**

**この assertion は語数予算と同じ「意図しない増減を捕まえる検知装置」**であり、
**段落数そのものに独立した意味があるわけではない。**
**段落を足すのは意図した構造変更**なので、**5 → 6 の更新はこの装置の正しい使い方**である。

> **別段落にする判断は変えない。**
> **版数はサーバーの素性であって方言の説明ではない。**
> **先頭で目に入る形が適切で、grep もしやすい。**
> **1 段落目に混ぜれば段落数は変わらないが、素性と方言の説明が同じ塊になる。**

## 5. 受入条件

1. **`instructions` の 1 行目が版数を含む**
2. **v1（`initialize`）と v2（`server/discover`）の両方で届く**
3. **その版数が `package.json` の `version` と一致する**
4. **語数予算のテストが更新後の値で通る**（`catalog` は 258 のまま）
5. **既存の `instructions` 検査（`includes(key)`）がすべて通る**
6. **13 tools・4 resources の面が不変**
7. **既存テスト全 green・snapshot 22 不変**

## 6. テスト / smoke

### 6.1 二本立て smoke へ追加する

**`scripts/mcp-dual-era-smoke.mjs` に、両 era で版数が届くことを固定する。**

```js
// 形は任せる。要件は 2 つ。
// ① v1 の instructions と v2 の discover.instructions の両方が package.json の version を含む
// ② 版数を literal で書かない（package.json から読む。既に packageVersion がある）
```

**既存の `discover?.instructions === legacyInstructions` の assertion は残すこと。**

### 6.2 足さないもの

**`mcp-smoke.mjs` / `mcp-pack-smoke.mjs` / `mcpb-verify.mjs` の `includes(key)` 一覧に
版数を足さないこと。** 版数は**そこで固定すべき語彙ではない**（リリースごとに変わる）。
**6.1 の二本立て smoke が `package.json` と突き合わせる形で一本化する。**

## 7. 変更してよい既存ファイル

| ファイル | 変更 |
|---|---|
| `src/mcp/index.ts` | `KSQL_MCP_INSTRUCTIONS` の先頭に 1 段落 |
| `src/mcp/__tests__/metadataTools.test.ts` | **検知装置の exact 値のみ**＝語数予算と**段落数**（§4.2） |
| `scripts/mcp-dual-era-smoke.mjs` | §6.1 の assertion 追加 |

**これ以外の既存テスト・smoke を書き換えないこと。**
**書き換えが要ると判断したら、黙って直さず、止めて報告すること。**

## 8. 今回やらないこと

| | 理由 |
|---|---|
| **案 B（陳腐化の自己検出）** | **案 A' の後で要否を判断する**（[B101 §5](ksql_b101_mcp_stale_process_version_issue.md)） |
| **`ksql_docs` へ版数を出す** | **取り下げ済み**（§2.2） |
| **`_meta` への独自キー追加** | **標準の `io.modelcontextprotocol/serverInfo` がある**。増やさない |
| **版数の書式変更** | `package.json` の `version` をそのまま出す |
| **`release/README.txt` の編集** | **リリース時にこちらで書く** |
