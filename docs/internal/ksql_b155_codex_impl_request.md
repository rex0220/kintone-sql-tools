# B155 実装依頼（codex）

**[仕様 R1](ksql_b155_unified_leaf_policy_spec_r1.md) を実装する。
レビューは[指摘なしで通過](ksql_b155_codex_review_1.md)。B154（§9.2 の表示注記）を同梱する。**

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（作業ブランチ `b155/dev`・v3.61.0 相当）

## 0. 禁止事項（従来どおり）

git 操作・version・CHANGELOG・README・release/・台帳の変更・ビルド（`prod/js/desktop.js` に触れない）・
kSQL MCP・MEMORY.md 禁止。エラー本文に内部語を出さない。公開型への必須プロパティ追加禁止。

## 1. 実装範囲

仕様の全部＝共有 leaf policy の抽出（§4）・旧抽出器の差し替え（複製の残存禁止）・
**metadata 候補 helper の追随と parity test**（§5）・単一表 FULL_SCAN プレフィルタ（§3.2）・
**実行と EXPLAIN の同一 plan 共有**（§9.1）・B154 注記（§9.2）・dry-run 契約（§5.3）・
受入テスト（mock / オフラインで検証できる全項目）・言語リファレンス同期。

## 2. テストの要件（従来どおり）

- 受入 SQL は逐語・query 文字列は実 serializer 形（§8.1〜8.3 の必須形を含む）
- **修正前 fail の確認**＝§8.1 の合流・§8.2 の `<= 100`・§8.3 の単一表プレフィルタが
  修正前は落ちる/乗らないことを固定してから直す
- KLIKE identity・`$id`・選択系実在検証・B126 正規化の回帰なし
- **CLI e2e**＝dry-run（CTE→APP JOIN＋WHERE 合流形）が exit 0・API 0 回・候補表示
- 既存テスト変更は仕様が明示的に変える挙動の範囲内で（全件列挙）

## 3. 進め方と報告（従来どおり）

コード → テスト → 文書。`npm test` 全体（認証環境変数はプロセス内除外・EPERM 時は報告のみ）。
仕様どおりにできない箇所は「仕様との差分」として報告。
最終メッセージ＝実装報告のみ（変更ファイル・受入↔テスト対応表・テスト結果・既存テスト変更・
差分・Claude 実機残項目）。
