# B66 Phase1 engine browser smoke 手順・結果

- 対象: B66 Phase1 Step 8 / 仕様 §8
- fixture: `scripts/engine-browser-smoke/index.html`
- Firefox: **engine fixture（§3 primary / §4 2版共存）PASS・§5 plugin 非回帰 PASS**
- Chrome: **engine fixture（§3 primary / §4 2版共存）PASS・§5 plugin 非回帰 PASS**
- 注意: Node test / JSDOM / VM smoke は、この実ブラウザ gate の代替ではない
- Step 9 注記: この実ブラウザ gate は **3.18.0 build** に対して実施済み。v3.19.0
  release candidate での変更は package/manifest/public registry key 等の**版数 metadata、
  公開 docs、release 成果物準備のみ**で、engine/plugin source の意味論は変更していない。
  3.19.0 の自動 build/UMD/version/pack gate は再実行済みだが、実ブラウザは再実行して
  いない。この差分境界を、3.19.0 実ブラウザ gate を再度行うかの判断材料とする。

## 1. 前提

1. リポジトリルートで `npm run build:engine` を実行する。
2. 2version用の選択ファイルを生成する。

   ```powershell
   node scripts/engine-umd-smoke.mjs --write-browser-fixtures
   ```

   次の2ファイルが `.tmp/engine-browser-smoke/` に生成される。

   - `ksql-engine-3.19.0-smoke-x.umd.js`
   - `ksql-engine-4.0.0-smoke-y.umd.js`

3. リポジトリルートをHTTP配信する（**依存ゼロの Node 静的サーバ**。Windows で python が未導入／ストア版スタブでも動く）。

   ```powershell
   node scripts/serve-static.mjs 8765
   ```

   起動すると配信ルートと fixture URL が表示される。停止は Ctrl+C。
   （python が使える環境なら `python -m http.server 8765 --directory .` でも可。ただし
   Windows のストア版 python はバージョンも返さず起動しないため、上の Node 版を推奨する。）

4. 対象ブラウザで次を開く。

   `http://localhost:8765/scripts/engine-browser-smoke/`

fixture は実kintoneへの通信を行わない。HTML内の mock browser host と BYO clientを
使い、build済み UMD の public `runQuery()` / `explainQuery()` を実行する。

## 2. 実施時の記録

各ブラウザで DevTools Console と Network を開き、Console errorがないこと、
結果欄のJSON、ブラウザ名・version、実施日時を記録する。可能なら結果欄とConsoleを
1枚のスクリーンショットに含める。

## 3. Primary smoke

1. `Run primary smoke` を押す。
2. 結果JSONが `"ok": true` であることを確認する。
3. 次を確認する。

   - browser factory と BYO の両方で JOIN+GROUP BY、WITH、UNION ALL、
     SHOW APPS、DESCRIBE が成功
   - `EXPLAIN` は field metadataだけを許し、records / Cursor call増加0
   - KORDER Cursor success後の active cursor 0
   - KORDER Cursor error後の `cursorErrorCloseCalls: 1`
   - simple / JOIN / GROUP BY の search abort 3 shape が `SEARCH_ABORTED`
   - write 3文が `READ_ONLY_VIOLATION`、`mutationCalls: 0`
   - `pagehide` / `beforeunload` listener増加0
   - public名と registry key / `version` 一致

### Firefox 結果

- 状態: **PASS（ユーザー実施・報告）**
- 実施日時: 2026-07-24
- Firefox version: 未記録
- primary UMD version: `3.18.0`（`dist-engine/ksql-engine.umd.js` build 済み）
- 結果JSON: `ok: true`（詳細 JSON 未記録）
- Console error: 未記録
- スクリーンショット: 未取得
- 備考: §3 の全確認項目を含む primary smoke が PASS。

### Chrome 結果

- 状態: **PASS（ユーザー実施・報告）**
- 実施日時: 2026-07-24
- Chrome version: 未記録
- primary UMD version: `3.18.0`（`dist-engine/ksql-engine.umd.js` build 済み）
- 結果JSON: `ok: true`（詳細 JSON 未記録）
- Console error: 未記録
- スクリーンショット: 未取得
- 備考: §3 の全確認項目を含む primary smoke が PASS。version/JSON/スクショの詳細欄は追記可。

## 4. UMD 2version 共存

1. **先に** `Secondary UMD` のファイル入力で `.tmp/engine-browser-smoke/` のうち
   primary（`3.18.0`）と異なる任意の1ファイルを選ぶ。
   - `ksql-engine-3.19.0-smoke-x.umd.js` または `ksql-engine-4.0.0-smoke-y.umd.js`
   - **未選択のままボタンを押すと** `No file chosen...`（旧版は
     `Select a differently-versioned UMD file first.`）で `ok:false` になる。これは
     不具合ではなくファイル未選択の意味。
2. `Load secondary and check coexistence` を押す。
3. 結果JSONが `"ok": true` で、`versions` に primary と secondary の両方が
   あり、`registryIdentityPreserved: true` であることを確認する。
4. ページを再読込し、もう一方の secondary ファイルでも繰り返す。
5. DevToolsで `window.ksql.get(version).version === version` を各entryについて
   確認する。

順不同、同版duplicate、非registry collision、per-instance lease、host合算rejectは
`engine-umd-smoke.mjs` が Node VM で検査済みだが、2versionの実ブラウザロード、
registry保持、listener 0はこの節の実機結果が必要である。

### Firefox 結果

- 状態: **PASS（ユーザー実施・報告）**
- 実施日時: 2026-07-24
- load order: primary `3.18.0`（dist-engine）→ secondary（`.tmp/engine-browser-smoke/` の別版 UMD）
- `versions`: primary と secondary の両版を保持（`ok: true`）
- registry identity: `registryIdentityPreserved: true`
- listener増分: 未記録
- Console warning/error: 未記録
- スクリーンショット: 未取得
- 備考: 2版共存 PASS。逆順ロード／もう一方のファイルでの再確認は未実施。

### Chrome 結果

- 状態: **PASS（ユーザー実施・報告）**
- 実施日時: 2026-07-24
- load order: primary `3.18.0`（dist-engine）→ secondary（`.tmp/engine-browser-smoke/` の別版 UMD）
- `versions`: primary と secondary の両版を保持（`ok: true`）
- registry identity: `registryIdentityPreserved: true`
- listener増分: 未記録
- Console warning/error: 未記録
- スクリーンショット: 未取得
- 備考: 初回は Secondary UMD 未選択のため `ok:false`（ファイル未選択の意味）。ファイル選択後に PASS。逆順ロード／もう一方のファイルでの再確認は未実施。

## 5. plugin browser非回帰

Step 8 計画 §10.4.7 の既存plugin面も、今回buildした
`dist/ksql-plugin-v3.18.0.zip` をテスト環境へアップロードして両ブラウザで確認する。
既存のB33実機手順
[`b33_plugin_smoke.md`](b33_plugin_smoke.md) の代表項目を同じアプリ条件で再実施する。

最低記録:

- read queryが従来結果を返す
- EXPLAINがrecords / mutation 0
- DML guardが書込み前に拒否または確認へ進む
- KORDER Cursor successが `POST -> GET -> DELETE`
- KORDER Cursor errorでも `DELETE`

### Firefox plugin 結果

- 状態: **PASS（ユーザー実施・報告）**
- 実施日時: 2026-07-24
- plugin artifact: `dist/ksql-plugin-v3.18.0.zip`（本 Step で build したもの）
- app / query: 未記録
- read: PASS（従来結果を返す）
- EXPLAIN: PASS（records / mutation 0）
- DML guard: PASS（書込み前に拒否 or 確認へ）
- KORDER success/error close: PASS
- スクリーンショット: 未取得
- 備考: B33 実機手順の代表項目を再実施し非回帰を確認。個別値の詳細欄は追記可。

### Chrome plugin 結果

- 状態: **PASS（ユーザー実施・報告）**
- 実施日時: 2026-07-24
- plugin artifact: `dist/ksql-plugin-v3.18.0.zip`（本 Step で build したもの）
- app / query: 未記録
- read: PASS（従来結果を返す）
- EXPLAIN: PASS（records / mutation 0）
- DML guard: PASS（書込み前に拒否 or 確認へ）
- KORDER success/error close: PASS
- スクリーンショット: 未取得
- 備考: B33 実機手順の代表項目を再実施し非回帰を確認。個別値の詳細欄は追記可。

## 6. 最終判定欄

- Firefox engine fixture: **PASS（2026-07-24・§3 primary / §4 2版共存）**
- Chrome engine fixture: **PASS（2026-07-24・§3 primary / §4 2版共存）**
- Firefox plugin regression: **PASS（2026-07-24）**
- Chrome plugin regression: **PASS（2026-07-24）**
- 両browserで全項目PASS後の判定: **PASS＝実ブラウザ gate 充足。Step 8 受入完了（release 可）**
- 判定者: ユーザー実施・報告／Claude 記録
- 判定日時: 2026-07-24

> 未記録の詳細欄（ブラウザ version・結果 JSON 全文・listener 増分の実測値・スクリーンショット・
> 逆順ロード再確認・app/query 個別値）は、必要に応じて後から追記できる。判定に必要な
> 各項目の PASS/FAIL はユーザー実機で確認済み。
