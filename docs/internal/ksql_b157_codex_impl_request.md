# B157 実装依頼（codex）——複文バッチ dry-run の metadata 解決回復

**[B157 起票](ksql_b157_batch_dryrun_metadata_regression_issue.md)（原因確定・修正方針確定済み）を実装する。
v3.62.1 候補（表示のみの回帰修正・エンジン意味論不変）。**

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（作業ブランチ `b157/dev`・v3.62.0 相当）

## 0. 禁止事項（従来どおり）

git 操作・version・CHANGELOG・README・release/・台帳の変更・ビルド（`prod/js/desktop.js` に触れない）・
kSQL MCP・MEMORY.md 禁止。エラー本文に内部語を出さない。

## 1. 実装内容（方針は確定・変更しない）

`src/cli/index.ts` のバッチ dry-run 呼び出しで、`buildBatchExplainPlans` へ渡す
`resolveMetadata` を無条件 `false` から **`!dryRunUsesStaticTypedPlan`** へ変更する。

- B155 静的経路（`dryRunUsesStaticTypedPlan === true`＝throwing client）のときだけ `false`
- それ以外（実 client・v3.61.0 相当）は解決する
- `dryRunUsesStaticTypedPlan` は相対日付 resolver 必要時に false になる（B155 最終チェック修正）ため、
  **client の選択と常に対**で動くことをコードで確認し、報告に根拠（ファイル:行）を書く

## 2. テストの要件

- **修正前 fail の確認**＝B157 §5 の受入 1（複文 `SELECT 1 AS x; SELECT COUNT(*) ... WHERE 日付 >= TODAY()`
  の dry-run が `COUNT_ONLY`・`kintone query:` 一致）が修正前は落ちることを固定してから直す
- CLI e2e（`b150_dry_run.e2e.test.ts` の形式）へ回帰テストを追加:
  1. 複文バッチ dry-run が metadata 解決済み plan を表示（fields API は呼んでよい・records API 0 回）
  2. B155 静的形の **API 0 回・candidate 表示**の既存テストが不変で通ること
- 既存テスト変更は不可（あれば「仕様との差分」として報告）

## 3. 進め方と報告（従来どおり）

コード → テスト。`npm test` 全体（認証環境変数はプロセス内除外）。
最終メッセージ＝実装報告のみ（変更ファイル・受入↔テスト対応・テスト結果・差分・Claude 実機残項目）。
