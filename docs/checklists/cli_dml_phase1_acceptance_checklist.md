# kSQL CLI DML Phase 1 最終受け入れチェック表

- 作成日: 2026-04-07
- 対象: `UPDATE` / `DELETE` / `INSERT` / `UPSERT`（CLI Phase 1）
- 判定目的: 実装完了可否を `GO / NO-GO` で明確化する

## 1. 判定サマリ

| 項目 | 判定 |
|---|---|
| 必須項目合格率 | 15 / 15 (100%) |
| 重大不具合 | 0 件 |
| 総合判定 | **GO** |

## 2. 最終チェック表（P0）

| ID | 分類 | チェック内容 | 実施方法 | 結果 | エビデンス |
|---|---|---|---|---|---|
| DML-P0-01 | 安全フラグ | `--allow-dml` 未指定で DML 拒否 | 自動テスト | PASS | `src/cli/__tests__/dml_guard.e2e.test.ts` |
| DML-P0-02 | 安全フラグ | `--allow-dml` 指定で DML 経路に入る | 自動テスト | PASS | `src/cli/__tests__/dml_guard.e2e.test.ts` |
| DML-P0-03 | WHERE ガード | `UPDATE/DELETE` WHERE なし既定拒否 | 自動テスト | PASS | `src/cli/__tests__/dml_guard.e2e.test.ts` |
| DML-P0-04 | WHERE ガード | `--allow-without-where` で解除可能 | 手動確認 | PASS | CLI 実行確認ログ |
| DML-P0-05 | 件数ガード | `--dml-max-rows` 超過で実行前拒否 | 自動テスト | PASS | `src/cli/__tests__/dml_guard.e2e.test.ts` |
| DML-P0-06 | 確認プロンプト | `--yes` なしで確認表示 | 手動確認 | PASS | REPL 実行確認 |
| DML-P0-07 | 確認プロンプト | `yes` 入力で実行継続 | 手動確認 | PASS | REPL 実行確認 |
| DML-P0-08 | 確認プロンプト | `no` 入力で中断（終了コード2） | 手動確認 | PASS | REPL 実行確認 |
| DML-P0-09 | REPL 安定性 | DML 確認入力の二重入力不具合がない | 修正 + 手動確認 | PASS | 修正コミット `c7fb591` |
| DML-P0-10 | 実行実装 | Node CLI で POST/PUT/DELETE 実行可能 | 修正 + 手動確認 | PASS | 修正コミット `c7fb591` |
| DML-P0-11 | 事前検証 | 未知フィールドコードを実行前エラー化 | 修正 + 手動確認 | PASS | 修正コミット `66829aa` |
| DML-P0-12 | 実接続 | UPDATE 未知フィールドケース | 実接続 | PASS | ユーザー確認済み |
| DML-P0-13 | 実接続 | INSERT 未知フィールドケース | 実接続 | PASS | ユーザー確認済み |
| DML-P0-14 | 実接続 | UPSERT 未知フィールドケース | 実接続 | PASS | ユーザー確認済み |
| DML-P0-15 | 回帰 | 既存 SELECT 系が回帰していない | 自動テスト | PASS | `npm test -- --runInBand`（13 suites / 314 tests） |

## 3. 補足（実装範囲）

1. DML Phase 1 は安全制御を優先した段階導入
2. 高度最適化・バルク再試行・トランザクション相当は Phase 2 以降

## 4. 関連資料

1. `docs/implementation/cli_dml_phase1_spec.md`
2. `docs/archive/cli_mvp_completion_criteria.md`
3. `docs/archive/release_notes_v0.1.0.md`
