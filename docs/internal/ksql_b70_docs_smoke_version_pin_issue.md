# B70 — `engine:docs-smoke` の version pin 自動化（毎リリース手動 bump の解消）

- 作成日: 2026-07-25
- ステータス: **📝 起票（改善・小粒）**（2026-07-25）。B69（v3.22.0）実装中に表面化した既存 release-hygiene バグの恒久対策。
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B70
- 対象: `scripts/engine-docs-examples-smoke.mjs`（npm script `engine:docs-smoke`）

## 1. 問題

`scripts/engine-docs-examples-smoke.mjs` は engine UMD version registry の docs 例を検証するため、**版数をハードコード**している。

- `const exactVersion = "3.22.0";`（line 20）
- 例 SQL の `SELECT 'ok' AS status, 22 AS release`（line 75 / 88 / 111）と、その結果 `release` を `"22"` と突き合わせる assert（line 76 / 89 / 115）

パッケージ版数が上がるたびに、この `exactVersion` と `release` リテラル/チェックを**手動で bump しないと必ず失敗する**（`get(exactVersion)` が packed engine の新版と不一致になる）。

### 実害（既に発生）

- **v3.20.0 / v3.21.0 のリリースで pin の bump を忘れ**、`engine:docs-smoke` が壊れたまま放置されていた（B69 実装中に検出）。
- `engine:docs-smoke` は `npm test` / `npm run build` / `prepack` の**標準 gate に含まれていない**（`npm pack` + install を伴い重いため）。よって silently 腐り、リリース時に気づかない。

## 2. 原因

- 版数がスクリプト内の**定数**で、`package.json` の実際の版数と自動同期しない。
- `release` リテラル（minor 番号を表す narrative 値）も版数に連動してハードコードされている。

## 3. 対策案

### 案A（推奨）: `package.json` から版数を実行時に読む

- `exactVersion` を `package.json` の `version` から動的に取得（`readFileSync`/`import` で `version` を読む）。以後 bump 不要。
- `release` リテラルは版数の minor から導出するか、narrative なので**単純化**（例: `SELECT 'ok' AS status` だけにして version 検証は `version === pkg.version` と `ksql.get(pkg.version)` に集約）。
- packed engine の版数＝現 `package.json` 版数なので、動的読み取りで常に一致。

### 案B（補完）: 版数整合を軽量 guard 化

- `engine:docs-smoke` は重いため標準 gate に入れづらいが、**「pin == package.version」を検査する軽量アサーション**（pack/install なし）を `prepack` か既存 guard に加え、pin の腐りを CI で早期検出する。
- 案A を入れれば pin 自体が消えるため、案B は将来の別種ハードコード対策としての位置づけ。

## 4. スコープ / 見積り

- 案A のみ: `scripts/engine-docs-examples-smoke.mjs` の 1 ファイル改修（0.25〜0.5 人日）。挙動不変（テストが版数非依存になるだけ）。
- SQL 方言・engine・公開面への影響なし（テストスクリプトのみ）。

## 5. 備考

- B69 リリース（v3.22.0）では pin を 3.22.0 へ手動同期して green 化済み。本課題はその**恒久化**。
- 同様のハードコード版数が他の guard/fixture にないか、着手時に横断確認する（`grep -rn "3\.2[0-9]\.0" scripts/`）。
