# B155 実装の最終チェック報告

- 実施: 2026-08-08（**Claude 実施**。codex はワークスペースのクレジット切れで起動不能——
  `ERROR: Your workspace is out of credits`。オーナーの補充まで codex 工程は再開できない）
- 対象: `b155/dev` の実装コミット `0b4c939`（[依頼](ksql_b155_codex_final_check_request.md)の 6 観点）

## 指摘: Critical 1 件（実測で確定・**Claude が修正済み**）

### CLI --dry-run が「B155 形＋相対日付関数」で DryRunError（回帰）

- **再現**（e2e ハーネス・修正前 exit 1 を実測）:
  - 単文: `WITH s AS (GENERATE_SERIES(...)) SELECT ... INNER JOIN APP4228 AS t ... WHERE t.日付 <= TODAY() AND t.キー = 'A'`
  - 混在バッチ: B155 形の文 ＋ `SELECT キー FROM APP4228 WHERE 日付 <= TODAY()`
  - いずれも `DryRunError: API call should not happen in dry-run.` で exit 1
- **原因**: 新条件 `(!dryRunNeedsMetadata || dryRunUsesStaticTypedPlan)` がバッチ内に B155 形が
  1 つでもあると throwing client を選ぶが、`resolveRelativeDateExecutionPlan` は
  `resolveMetadata=false` の外側で従来どおり resolver（`getFieldsCached`）を呼ぶ。
  v3.61.0 では実 client で通っていた形＝回帰。B150 修正 2 と同族の per-surface 穴
- **修正**: 静的経路の採用条件に「バッチ全体が resolver 不要」を追加。判定は
  `statementUsesRelativeDateResolution()`（`relativeDatePushdownGuard.ts` に新設）が
  **buildRelativeDatePushdownPlan と同じ collector** を使う——列挙の複製を作らない。
  相対日付を含むバッチは従来の実 client 経路（metadata API 可・records 0 回）へ戻る
- **検証**: `resolveMetadata=false` 経路で client に触るのは相対日付 resolver のみと確認
  （`buildBatchStatementPlan` 系は同期関数で client 非参照・`prepareRelativeDateVariables` も同期）。
  回帰テスト 2 本を `b150_dry_run.e2e.test.ts` に追加（修正前 fail を実測してから修正）

## 観点別結論（指摘なしの 5 観点）

1. **fail-open なし**: `classifySafeComparison` は isTargetField→型メタ解決→
   `classifyWhereCapability` EXACT ゲート→共有 policy の直列。RHS field・未解決型・
   KSQL_ 仮想型はすべて unsafe。単一表とJOIN の所有権契約は `tableAlias`/
   `allowUnqualifiedFields` で分離維持
2. **複製なし**: 型×演算子の本体は `supportedLeafPolicy.ts` のみ。旧 `isSelectionInComparison`／
   selection 型一覧は削除。metadata 候補は `isSupportedLeafMetadataCandidate`（policy と同居）へ
   統一。parity test あり（`wherePredicatePushdown.test.ts:202`）
3. **plan 共有**: EXPLAIN は `explainPushdownPlans` WeakMap で実行時と同じ metadata-aware plan を
   参照（§9.1）。B154 注記あり（§9.2）
4. **KLIKE identity 維持**: `extractAndLeafPlan` は LOGICAL 節のみ再構成し BINARY 葉は
   同一オブジェクトを返す。`appliedKlikes` の identity 照合は壊れない
5. **既存テスト変更・受入逐語**: §8.1 の必須 serializer 文字列を逐語確認。explain/B114 群の
   期待更新は §9.1（確定 query 表示）の範囲内

## Claude 実機残項目

実装報告どおり（APP4228 合流 4 形・3 経路一致・KLIKE/選択系/STATUS・MCP・plugin smoke）。
