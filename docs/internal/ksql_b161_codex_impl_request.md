# B161 実装依頼（codex）——CTE 物理ソースの metadata 要否検出

**[B161 起票](ksql_b161_cte_dryrun_metadata_gap_issue.md)（原因確定・修正方針確定）を実装する。
v3.63.0 同梱（B157・B158 と同時リリース）。**

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（作業ブランチ `b161/dev`）

## 0. 禁止事項（従来どおり）

git 操作・version・CHANGELOG・README・release/・台帳の変更・ビルド・kSQL MCP・MEMORY.md 禁止。

## 1. 実装内容

`src/core/explainMetadata.ts` の `explainNeedsAppMetadata` 系判定へ
「WITH/CTE チェーンに物理ソースの SELECT を含む」トリガを追加する。

- 消費点（`buildExplainWhereAnalysis` の CTE 列 metadata 解決が `getFields()` へ到達する経路）を
  コードで特定し、**要否判定が消費点と過不足なく対応する**ことを報告に根拠（ファイル:行）付きで書く
- 過剰検出側の許容範囲＝実 client へ倒すだけ（表示・意味論不変）なので、
  安全側に広くてよい。ただし **B155 静的経路（`dryRunUsesStaticTypedPlan`）と
  非 CTE 単一表の既存挙動は変えない**

## 2. テストの要件

- **修正前 fail の確認**＝起票 §1 の単文・複文（逐語）が修正前は DryRunError で落ちることを
  固定してから直す
- CLI e2e（`b150_dry_run.e2e.test.ts` 形式）へ回帰テスト追加:
  1. 単文 `WITH c AS (SELECT $id FROM APP4228) SELECT $id FROM c` → exit 0・records 0 回
  2. 複文 `SELECT 1 AS x; WITH ...` → 同上
  3. B155 静的形の**全 API 0 回**既存テストが不変
- 既存テスト変更は不可（あれば「仕様との差分」として報告）

## 3. 進め方と報告（従来どおり）

コード → テスト。`npm test` 全体（認証環境変数はプロセス内除外）。
最終メッセージ＝実装報告のみ（変更ファイル・受入↔テスト対応・テスト結果・差分・Claude 実機残項目）。
