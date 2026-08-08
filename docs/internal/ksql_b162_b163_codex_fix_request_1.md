# B162/B163 修正依頼 1（codex）——最終チェック Major の修正

**[最終チェック報告](ksql_b162_b163_codex_final_check_report.md)の Major 1 件を修正する。
対象ブランチ `b162-b163/dev`。禁止事項は[実装依頼](ksql_b162_b163_codex_impl_request.md) §0 と同じ。**

## 修正内容

混在バッチで `resolveMetadata=false` が全文へ波及する問題（`src/cli/index.ts` の
`dryRunUsesStaticTypedPlan` が `some()` ベースのため）。

**方針＝静的経路の採用条件を「metadata を必要とする文がすべて静的形」へ絞る**:

```
staticEligible = statements.every(s =>
  !explainNeedsAppMetadata(s) || hasStaticTypedPushdownCandidate(s))
dryRunUsesStaticTypedPlan =
  statements.some(hasStaticTypedPushdownCandidate)
  && staticEligible
  && !statements.some(statementUsesRelativeDateResolution)   // B157 修正の維持
```

- 混在時（静的形＋metadata 必須の通常文）→ **実 client＋`resolveMetadata=true`**＝
  全文が解決表示（fields API 可・records 0 回）。B163 の ledger は resolveMetadata=true でも
  動くこと（§13.2）をテストで固定
- 純静的バッチ（B155/B158/B163 形のみ・または metadata 不要文との同居）→ 従来どおり
  **全 API 0 回**の静的経路
- 文単位の resolveMetadata 分割（大規模リファクタ）は**しない**

## テストの要件

1. **修正前 fail**＝「B163 逐語形＋`SELECT COUNT(*) FROM APP4228 WHERE 日付 >= TODAY()` 以外の
   metadata 必須文（例: `SELECT キー FROM APP4228 WHERE 製品名 = '牛乳'`）」の混在バッチで、
   通常文が悲観表示（candidate/全件取得）に落ちることを固定してから直す
2. 修正後＝同バッチで通常文が解決表示（確定 query）・B163 文は static schema 表示・
   records API 0 回・fields API 可
3. B163 単独バッチの**全 API 0 回**既存テストが不変
4. B155 単文/B157/B161 の既存 e2e が不変

## 報告

最終メッセージ＝修正報告のみ（変更箇所・修正前 fail 実測・テスト結果・仕様との差分）。
`npm test` 全体（認証環境変数はプロセス内除外）。
