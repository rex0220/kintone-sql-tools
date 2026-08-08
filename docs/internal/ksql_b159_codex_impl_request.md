# B159 実装依頼（codex）——GENERATE_SERIES の month / year step

**[仕様 R1](ksql_b159_generate_series_month_step_spec_r1.md) を実装する。
レビューは[ブロッカーなしで通過](ksql_b159_codex_review_1.md)（注記 2 件＝本依頼へ反映済み）。
v3.63.0 同梱。B158（CROSS JOIN）は main へ統合済み＝§14 の前提どおり追随実装。**

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（作業ブランチ `b159/dev`）

## 0. 禁止事項（従来どおり）

git 操作・version・CHANGELOG・**README**・release/・台帳・リリース履歴の変更・ビルド
（`prod/js/desktop.js` に触れない）・kSQL MCP・MEMORY.md 禁止。
**§16 の文書同期のうち codex 担当は「言語リファレンス・MCP schema/説明・syntax catalog・
smoke assertion」まで**（README・CHANGELOG・台帳・履歴・version metadata は Claude 工程）。
エラー本文に内部語を出さない。

## 1. 実装範囲

仕様 R1 の全部＝§15 実装変更点・§19 実装順序（1〜12。13 の公開文書は上記分担・14 は Claude）。
特に:

- **アンカー＋行番号の直接算出**（§5.1＝累積加算禁止）・月初/年初アンカー検証（§4）・
  stop の方向別期間境界（§5.4）・行数事前算出と 10,000 ガード合流（§6）
- **B158 の共通定数**（`GENERATED_ROW_MAX_ROWS`）があれば参照・カウンタは統合しない（§6.3）
- エラー文の逐語（§8。既存 day のエラー不変・型不一致文言の更新含む）
- EXPLAIN の step 正規化表示（§11.3）・DATE メタ・警告抑止の維持（§9）
- B158 統合受入（§14.3 の月×製品 SQL）

## 2. テストの要件

- 受入は §13 の逐語全部＋§12 の月次 0 埋め＋`LAG`（**空月直後の前月値が 0**）
- **修正前 fail の確認**＝`'1 month'` が修正前は §17.1 の逐語エラーで落ちることを固定してから開放
- **既存テストの変更は §15.3 の 1 件のみ**（B149 の month 拒否テスト→成功テストへ置換）。
  それ以外の既存テスト変更は「仕様との差分」として報告
- CLI e2e＝§13.13 の dry-run（正常・エラー系とも API 0 回）

## 3. 進め方と報告（従来どおり）

コード → テスト → 文書。`npm test` 全体（認証環境変数はプロセス内除外）。
最終メッセージ＝実装報告のみ（変更ファイル・受入↔テスト対応表・テスト結果・既存テスト変更・
差分・Claude 実機残項目）。
