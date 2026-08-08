# B162/B163 実装の最終チェック報告（codex・2026-08-08）

- 対象: `b162-b163/dev` の実装（`93bf316` 相当）
- 結論: **Major 1 件（混在バッチの resolveMetadata 全波及）→ 修正依頼 1 で対応**・他 5 観点は指摘なし

指摘は1件です。

- **Major — 混在バッチで `resolveMetadata=false` が全ステートメントへ波及する**
  - `src/cli/index.ts:1870`
  - `src/cli/index.ts:2034`
  - `src/cli/index.ts:2294`
  - B163 の逐語形は CTE と物理 APP の `CROSS JOIN` を含むため、`src/cli/index.ts:1047` の `hasStaticTypedPushdownCandidate()` が true になる。
  - その結果、バッチ内に B157 型の metadata 必須文が混在していても、`some(...)` で作られた単一の `dryRunUsesStaticTypedPlan` により throwing client が選択され、`buildBatchExplainPlans(..., resolveMetadata=false)` がバッチ全体へ渡される。
  - したがって B163 自体の ledger は動いても、同居する通常文の metadata 解決が失われる。これは仕様 §13.3-4「混在バッチで診断と計画本文の metadata 前提を一致」、§13.3-5「全バッチを一律 false/true にしない」、§15.7-6 に反する。
  - 新規 CLI テストは B163 単独しか確認しておらず、混在条件を捕捉していない（`src/cli/__tests__/b162_b163_dry_run.e2e.test.ts:71`）。

観点別結論:

1. **B162 Phase 線引き:** 問題なし。default map は `GENERATE_SERIES` ノードの引数だけに適用され、通常の placeholder map は維持されている（`src/execute.ts:11005`）。
2. **外部注入値の間接漏えい:** 問題なし。非注釈 `DECLARE` の注入値は系列束縛に使われず、rows/type は SQL 本文のリテラル既定値からのみ算出される。
3. **B163 ledger／空 schema:** 問題なし。ledger は EXPLAIN ローカルで、推論不能は構造化 `DEFERRED` となり空 schema を確定しない（`src/execute.ts:10984`、`src/execute.ts:11219`）。通常実行の `tempTables` map への接続もない。
4. **InternalError 防止:** 問題なし。`STATIC` / `DEFERRED` の判別で planner 呼び出しを制御しており、`InternalError` 文字列 catch はない。
5. **`resolveMetadata=false` ledger:** ledger と static GROUP BY plan 自体は動作する（`src/execute.ts:11202`）。ただし上記 Major の全バッチ波及が残る。
6. **B155/B157/B161 六条件:** B155、B163単独、B157単独、B161単独の経路は維持されているが、混在条件4・5を満たさないため総合不合格。

コード変更・ファイル書き込み・git・MCP・テスト実行は行っていません。