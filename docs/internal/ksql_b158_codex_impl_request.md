# B158 実装依頼（codex）——CROSS JOIN（直積）

**[仕様 R1](ksql_b158_cross_join_spec_r1.md) を実装する。
レビューは[ブロッカーなしで通過](ksql_b158_codex_review_1.md)（注記 3 件＝本依頼へ反映済み）。
v3.63.0 同梱（B157・B161 は main に実装済み・B159 は別途）。**

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（作業ブランチ `b158/dev`）

## 0. 禁止事項（従来どおり）

git 操作・version・CHANGELOG・README・release/・台帳の変更・**ビルド禁止**（`prod/js/desktop.js` に
触れない。仕様 §14.4 の `npm run build` 系は Claude 工程＝実行しない）・kSQL MCP・MEMORY.md 禁止。
エラー本文に内部語を出さない。公開型への必須プロパティ追加禁止
（`JoinClause` の discriminated union 化は仕様 §2.1 が明示する変更で、この禁止の対象外）。

## 1. 実装範囲

仕様 R1 の全部＝§18 の Step 1〜7（Step 8 のリリース工程は Claude）。
特に:

- **discriminated `JoinClause`**＝`join.on` を読む全箇所の narrowing（仕様 §2.1 の 6 箇所を含め
  全列挙して報告）。`on?: ...` で黙って通す形は禁止
- **`planCrossJoinRows()` 1 実装**＝runtime・EXPLAIN 静的解析・テストが同じ helper を使う
- **ガードは行生成前**（§6.3）・出力 10,000・多段は段ごと判定・エラー文は §6.4 の逐語
- **完全入力 `CROSS_JOIN`**・truncate 無効化（§7.2）
- **JOIN キー prefilter 非適用の明示**（§8.1＝`on` 欠如を INNER 経路へ流さない）と
  **B155 共有 leaf policy による alias-local WHERE prefilter**（§8.2〜8.4）
- **EXPLAIN**＝exact は証明可能な場合のみ・物理入力は runtime 算出式表示（§10）・
  dry-run 全 API 0 回（§10.4・B157/B161 の複文表示回帰を含む）
- **言語リファレンス同期**＝§7 JOIN に CROSS JOIN・**§1 の予約語リストへ `CROSS` を追記**
  （レビュー注記 2＝未引用 `CROSS` フィールドが要バッククォートになる旨）

## 2. テストの要件

- 受入 SQL は逐語（§11.1〜11.6・§12 R17 形・§13 parser 回帰・§14）。
  **§12 の R17 3 段 SQL は掲載どおり逐語でテスト実行して固定**（レビュー注記 3・B141 原則）
- **修正前 fail の確認**＝§16.1 の 3 形（ParseError）を修正前挙動として固定してから開放
- CLI e2e＝§14.3 の dry-run（単文・複文とも API 0 回）
- 既存テスト変更は仕様が明示的に変える範囲のみ（全件列挙・parser snapshot の CROSS 差分含む）

## 3. 進め方と報告（従来どおり）

コード → テスト → 文書。`npm test` 全体（認証環境変数はプロセス内除外）。
仕様どおりにできない箇所は「仕様との差分」として報告。
最終メッセージ＝実装報告のみ（変更ファイル・受入↔テスト対応表・テスト結果・既存テスト変更・
差分・Claude 実機残項目）。
