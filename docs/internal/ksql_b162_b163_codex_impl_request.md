# B162・B163 実装依頼（codex）——EXPLAIN の未解決情報の扱い（Phase 1）

**[仕様 R1](ksql_b162_b163_explain_deferred_spec_r1.md) を実装する。
レビューは[ブロッカーなしで通過](ksql_b162_b163_codex_review_1.md)（注記 2 件＝本依頼へ反映済み）。
v3.64.0 候補（B162＋B163 同梱）。**

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（作業ブランチ `b162-b163/dev`・v3.63.0 相当）

## 0. 禁止事項（従来どおり）

git 操作・version・CHANGELOG・README・release/・台帳・リリース履歴の変更・ビルド
（`prod/js/desktop.js` に触れない）・kSQL MCP・MEMORY.md 禁止。
エラー本文に内部語を出さない。公開型への必須プロパティ追加禁止。
**§16.4 の plugin 検証・§17 の実測は Claude 工程**（実施しない）。

## 1. 実装範囲

仕様 R1 の Phase 1 全部（§18）:

- **B162**＝系列引数限定のリテラル `DECLARE` 既定値束縛（§3.2〜3.3）＋deferred fallback（§3.4）・
  条件付き計画表示（§4.1 の意味要素・**文言は既存 renderer の語彙で日本語化可**）・
  外部注入値の不使用/非表示（§4.2）・**他の変数用途は不変**（§5 の Phase 線引き厳守）
- **B163**＝静的 temp schema ledger（§7＝DROP 削除・temp→temp 連鎖・行なし）・
  明示 SELECT 列の schema 伝播 → 既存 plain GROUP BY planner への接続（§9.2 の 5 点・
  **専用 resolver 新設禁止**）・deferred fallback（§10.4＝空 schema での確定禁止）・
  **InternalError の公開禁止＝構造化分類**（§11・文字列 catch 置換禁止）
- **dry-run 静的経路対応**（§13＝`resolveMetadata=false` でも ledger が動く・
  B155/B157/B161 非回帰の 6 条件）

## 2. テストの要件

- 受入は §15 の全部（逐語 SQL・意味要素）＋§16 のテスト配置（engine / CLI e2e / MCP・
  plugin bundle 確認は静的検査まで）
- **修正前 fail の確認**＝起票 2 件の逐語形が修正前は起票どおりのエラー
  （日付 ArgumentError／InternalError）で落ちることを固定してから直す
- 既存テスト変更は仕様が明示的に変える範囲のみ（全件列挙）

## 3. 進め方と報告（従来どおり）

コード → テスト → 文書（言語リファレンス §24 EXPLAIN への deferred/条件付き計画の説明追加は
codex 担当・README/CHANGELOG 等は Claude）。`npm test` 全体（認証環境変数はプロセス内除外）。
仕様どおりにできない箇所は「仕様との差分」として報告。
最終メッセージ＝実装報告のみ（変更ファイル・受入↔テスト対応表・テスト結果・既存テスト変更・
差分・Claude 実機残項目）。
