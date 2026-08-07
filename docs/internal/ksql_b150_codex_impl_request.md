# B150 実装依頼（codex）

**[仕様 R1](ksql_b150_join_key_range_prefilter_spec_r1.md) を実装する。
レビューは[指摘なしで通過](ksql_b150_codex_review_1.md)**（空=空 JOIN 一致の実測が
空値フォールバック設計を裏づけ。既存 `in` 経路の空キー問題は B153 として別起票済み＝**触らない**）。

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（作業ブランチ `b150/dev`・v3.60.0 相当）

## 0. 禁止事項（従来どおり）

git 操作・version・CHANGELOG・README・release/・台帳の変更・ビルド（`prod/js/desktop.js` に触れない）・
kSQL MCP・MEMORY.md 禁止。エラー本文に内部語を出さない。公開型への必須プロパティ追加禁止。

## 1. 実装範囲

仕様 §3〜§8 の全部＝型別選択（`nativeWhereOperatorsForType()` を正とする）・
範囲 prefilter の min/max（共有比較器・canonical 全数検査・空値/非 canonical/意味型不足の
フォールバック）・query 生成と relation 合成・フォールバック reason code・EXPLAIN・
仕様の受入条件のうち mock / オフラインで検証できる全項目のテスト化・言語リファレンス同期。

## 2. テストの要件（従来どおり）

- 受入 SQL は逐語・query 文字列は実 serializer 形・**B150 再現形（日付系列→APP 直接 JOIN）が
  エラーなく正しい結果**を返すことを最重要受入に
- `in` 可能型の既存挙動（チャンク・300 上限・警告文）の回帰なし
- mock error の非握りつぶし・フォールバック reason code の逐語固定
- 修正前 fail の確認（再現形は修正前 GAIA_IQ03 相当の mock error）・既存テスト変更の列挙
- `npm test` 全体（認証環境変数はプロセス内除外・EPERM 時は報告のみ）

## 3. 報告

最終メッセージ＝実装報告のみ（変更ファイル・受入↔テスト対応表・テスト結果・
既存テスト変更・仕様との差分・Claude 実機残項目）。
