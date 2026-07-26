# B70 リリース時の版数同期をガードで守る（旧「`engine:docs-smoke` の version pin 自動化」）

- 起票: 2026-07-25
- **2026-07-27 改題・スコープ拡大**（v3.25.0 のリリース準備で実害が出たため）
- ステータス: 📝 **起票（優先 中）**。未着手。旧題は「`engine:docs-smoke` の version pin 自動化」。

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
