# B66 Phase1 engine browser smoke 手順・結果

- 対象: B66 Phase1 Step 8 / 仕様 §8
- fixture: `scripts/engine-browser-smoke/index.html`
- Firefox: **ユーザー実施待ち**
- Chrome: **ユーザー実施待ち**
- 注意: Node test / JSDOM / VM smoke は、この実ブラウザ gate の代替ではない

## 1. 前提

1. リポジトリルートで `npm run build:engine` を実行する。
2. 2version用の選択ファイルを生成する。

   ```powershell
   node scripts/engine-umd-smoke.mjs --write-browser-fixtures
   ```

   次の2ファイルが `.tmp/engine-browser-smoke/` に生成される。

   - `ksql-engine-3.19.0-smoke-x.umd.js`
   - `ksql-engine-4.0.0-smoke-y.umd.js`

3. リポジトリルートをHTTP配信する。

   ```powershell
   python -m http.server 8765 --directory .
   ```

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

- 状態: **ユーザー実施待ち**
- 実施日時:
- Firefox version:
- primary UMD version:
- 結果JSON:
- Console error:
- スクリーンショット:
- 備考:

### Chrome 結果

- 状態: **ユーザー実施待ち**
- 実施日時:
- Chrome version:
- primary UMD version:
- 結果JSON:
- Console error:
- スクリーンショット:
- 備考:

## 4. UMD 2version 共存

1. `Secondary UMD` で `.tmp/engine-browser-smoke/` のうち、primaryの
   `3.18.0` と異なる任意の1ファイルを選ぶ。
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

- 状態: **ユーザー実施待ち**
- 実施日時:
- load order:
- `versions`:
- registry identity:
- listener増分:
- Console warning/error:
- スクリーンショット:
- 備考:

### Chrome 結果

- 状態: **ユーザー実施待ち**
- 実施日時:
- load order:
- `versions`:
- registry identity:
- listener増分:
- Console warning/error:
- スクリーンショット:
- 備考:

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

- 状態: **ユーザー実施待ち**
- 実施日時:
- plugin artifact:
- app / query:
- read:
- EXPLAIN:
- DML guard:
- KORDER success/error close:
- スクリーンショット:
- 備考:

### Chrome plugin 結果

- 状態: **ユーザー実施待ち**
- 実施日時:
- plugin artifact:
- app / query:
- read:
- EXPLAIN:
- DML guard:
- KORDER success/error close:
- スクリーンショット:
- 備考:

## 6. 最終判定欄

- Firefox engine fixture: **ユーザー実施待ち**
- Chrome engine fixture: **ユーザー実施待ち**
- Firefox plugin regression: **ユーザー実施待ち**
- Chrome plugin regression: **ユーザー実施待ち**
- 両browserで全項目PASS後の判定:
- 判定者:
- 判定日時:
