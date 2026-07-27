# B70 リリース時の版数同期をガードで守る（旧「`engine:docs-smoke` の version pin 自動化」）

- 起票: 2026-07-25
- **2026-07-27 改題・スコープ拡大**（v3.25.0 のリリース準備で実害が出たため）
- ステータス: ✅ **リリース済み（v3.26.0・2026-07-27）**。`scripts/version-sync-guard.mjs` を新設し `prepack` と `npm test` に配線。**初の実戦投入で `package.json` のみ更新した時点の 11 件を検出**し、`prod/manifest.json` は `build.mjs` が自動同期＝v3.25.0 で漏らした2箇所が予防と検出の二層で塞がれた。

## 1. 事象（改題の理由）

起票時は「`scripts/engine-docs-examples-smoke.mjs` が版数をハードコードしており毎リリース
手動 bump が要る」というスクリプト1本の課題として扱っていた。

**v3.25.0 のリリース準備で、実際には版数のハードコードが6箇所あり、うち3箇所を漏らした。**
自動検出できたのは1件だけで、**残り2件はどのゲートにも掛からずオーナーの指摘で発覚**した。

| 箇所 | v3.25.0 準備時 | 検出方法 |
|---|---|---|
| `package.json` の `version` | ✅ | — |
| `scripts/engine-docs-examples-smoke.mjs`（`exactVersion` ＋ `N AS release` リテラル/比較 6 箇所） | ⚠️ **1 箇所漏れ** | `engine:docs-smoke` が失敗 |
| `release/VERSION.txt` / `release/README.txt` | ✅ | — |
| `package-lock.json` の `version` × 2 | ⚠️ **漏れ** | **オーナー指摘** |
| **`prod/manifest.json` の `version`** | ⚠️ **漏れ** | **オーナー指摘** |

### 1.1 最も重い漏れ＝`prod/manifest.json`

`build.mjs` は `prod/` を `kintone-plugin-packer` でそのまま固めるだけで、
**`prod/manifest.json` を更新しない**。過去のリリースでは毎回手動で bump されていた。

v3.25.0 では bump を忘れたため、**`ksql-plugin-v3.25.0.zip` の中身の manifest が 3.24.0**
という状態になっていた。zip 名は正しいのでファイル一覧では気づけず、
**kintone のプラグイン画面に v3.24.0 と表示される成果物を配布する寸前**だった。
利用者が実際に目にする版数であり、影響は最も大きい。

### 1.2 過去にも同種の事故がある

`engine:docs-smoke` の pin 忘れにより **v3.20.0 / v3.21.0 で壊れたまま放置**され、
B69 の実装中に検出して v3.22.0 で手動同期して green 化した経緯がある。
このスクリプトは pack/install を伴い重いため標準 gate（`npm test` / `build` / `prepack`）の
外にあり、silently 腐る。

## 2. 本質

**`package.json` の `version` を単一の真実として、他の版数表記が一致していることを
検査する仕組みが存在しない。** リリース工程が人手の注意力だけに依存している。

スクリプト1本の pin 自動化（旧スコープ）では、今回の2件は防げなかった。

## 3. 対策

### 3.1 版数同期ガード（推奨・本体）

`package.json` の `version` を基準に、次の一致を検査する軽量スクリプトを追加する。

| 検査対象 | 期待値 |
|---|---|
| `package-lock.json` の `version` および `packages[""].version` | `package.json` と一致 |
| `prod/manifest.json` の `version` | 同上 |
| `release/VERSION.txt` | `v` ＋ 同上 |
| `release/README.txt` の版数表記（`ksql 配布パッケージ (vX.Y.Z)`・成果物名・手順の zip 名・manifest/MCP server version） | 同上 |
| `scripts/engine-docs-examples-smoke.mjs` の `exactVersion` | 同上 |

**実行タイミング**: `prepack` に含める（`npm pack` / `npm publish` の前に必ず走る）。
あわせて `npm test` からも呼べる軽量チェックにしておくと、リリース前に気づける。

`release/` の zip ファイル名（`ksql-plugin-vX.Y.Z.zip`）の実在確認も含めると、
「ビルドし忘れ」も同時に検出できる。

### 3.2 ハードコードそのものを減らす

- **`scripts/engine-docs-examples-smoke.mjs`**: `exactVersion` を廃し
  **実行時に `package.json` を読む**。`N AS release` のリテラルも版数から導出するか、
  版数に依存しない固定値（例 `1 AS release`）へ単純化する。以後 bump 不要になる。
- **`prod/manifest.json`**: `build.mjs` が `package.json` の版数で**書き換えてからパックする**。
  これが入れば 3.1 の manifest 検査は二重の防御になる。
- **`package-lock.json`**: `npm install --package-lock-only` をリリース手順に明記する
  （検査で落ちれば気づけるので、手順の明記＋ガードで足りる）。

### 3.3 スコープ外

- `dist-engine` の UMD version registry の設計自体（現行のままでよい）
- CI の導入可否（本リポジトリの運用方針に依存するため、まず `prepack` で足りる）

## 4. 影響・規模

- **テスト/スクリプトのみの改修**で、SQL・engine・公開面の挙動に影響なし
- 想定 **0.5〜0.75 人日**（3.1 のガード＋3.2 の smoke 側 self-read＋`build.mjs` の manifest 書き換え）
- 着手時に、他の guard / fixture に残るハードコード版数も横断確認すること

## 5. 優先度

小粒だが、**利用者が目にする版数を誤って配布しかけた**実績があるため、
起票時の「低」から **中** へ引き上げる。次のリリースでも同じ漏れが起きうる。


## 6. 実装結果（2026-07-27）

### 6.1 追加・変更

| ファイル | 内容 |
|---|---|
| `scripts/version-sync-guard.mjs`（新規） | `package.json` の `version` を単一の真実として一致を検査 |
| `package.json` | `version:check` を追加し、**`prepack` と `test` の両方**に配線 |
| `build.mjs` | `prod/manifest.json` を `package.json` の版数で**自動同期してからパック**。version フィールドが1つであることを検証し、**文字列置換で他フィールド・整形・キー順を保持** |
| `scripts/engine-docs-examples-smoke.mjs` | `exactVersion` を廃し**実行時に `package.json` を読む**。`N AS release` は版数非依存の `1 AS release` へ単純化＝**以後 bump 不要** |

### 6.2 破壊テストによる検証（Claude 実施）

各箇所を1つずつ壊してガードが失敗することを確認した。**7 ケースすべて検出**。

```
検出 OK   package-lock.json      - package-lock.json version: expected "3.25.0", found "9.9.9"
検出 OK   prod/manifest.json     - prod/manifest.json version: expected "3.25.0", found "9.9.9"
検出 OK   release/VERSION.txt    - release/VERSION.txt: expected "v3.25.0", found "v9.9.9"
検出 OK   release/README.txt     - (package heading) / (plugin artifact name) / (MCPB manifest version) の3パターン
検出 OK   zip 実在               - release/ksql-plugin-v3.25.0.zip: expected release plugin zip to exist
```

**v3.25.0 で漏らした3箇所（`package-lock.json` / `prod/manifest.json` / smoke）は、
いずれも今後は自動で止まる。**

### 6.3 設計判断

- **README の履歴版数は検査対象外**。全体を現行版へ一致させると履歴記述を壊すため、
  冒頭の現行リリース表記（見出し・成果物名・手順の zip 名・manifest / MCP server version）だけを検査する。
- **zip 実在検査を `npm test` にも含めた**。版数 bump 後に該当 zip が未作成なら
  通常テストの冒頭で失敗する。リリース前に気づける代わりに、
  bump 直後・ビルド前は `npm test` が失敗する点は意図した動作である。
- `prod/manifest.json` は `JSON.stringify` せず、**唯一の `version` 値だけを文字列置換**する。
  復元前後の SHA-256 が同一であることを確認済み。

### 6.4 残る手動作業

`package-lock.json` は `npm install --package-lock-only` が必要（ガードで検出はできる）。
`release/` 成果物のビルドと `CHANGELOG` の版数見出し確定も手動のまま。
**「漏れたまま配布する」ことは構造的に不可能になった**が、bump 作業自体は自動化していない。


## 7. 【2026-07-27】残る抜け＝公開文書の「Unreleased」表記

v3.27.0 の docs 作業の着手時に codex が検出。**v3.25.0 でリリース済みの B75/B77/B78 が、
言語リファレンスでは「Unreleased の破壊的変更」のまま残っていた**（2箇所）。

```
docs/ksql_language_reference.md:10   > **⚠ Unreleased の破壊的変更（minor リリース）**
docs/ksql_language_reference.md:758  > **⚠ Unreleased 移行注意（minor だが破壊的）:**
```

リリース時に `CHANGELOG.md` の `## Unreleased` → `## vX.Y.Z` は直したが、
**言語リファレンスの同種表記を見落とした**。version-sync-guard は**版数の一致**を
検査するもので、**「Unreleased」という語の残存**は対象外である。

### 対策案 → **B82 として実装済み（2026-07-27）**

リリース時（`prepack`）に限り、**公開文書に「Unreleased」が残っていたら失敗**させる。

- 対象: `docs/ksql_language_reference.md` / `release/README.txt`
- `CHANGELOG.md` は開発中に `## Unreleased` を持つのが正常なので**対象外**
  （リリース時は版数見出しへ確定させる運用）
- **開発中の `npm test` では失敗させない**（未リリース機能の記述は正常なため）。
  `prepack` からのみ有効にする引数か環境変数で切り替える

**規模は小さい（0.25 人日程度）が、version-sync-guard に新しい失敗モードを足すため、
リリース直前ではなく落ち着いたタイミングで入れること。**


> **§7 は [B82](ksql_b82_release_stale_marker_guard_issue.md) として実装済み（2026-07-27）。**
> `version-sync-guard.mjs` に `--release` モードを追加し、`prepack` からのみ有効化した。
> 対象は言語リファレンスと `release/README.txt`、検出語は `Unreleased` / `未リリース` / `次回リリース`。
> `npm test` は従来どおり失敗させない。
