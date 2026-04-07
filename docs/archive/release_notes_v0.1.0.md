# kSQL CLI v0.1.0 Release Notes

- 日付: 2026-04-07
- 対象: kSQL CLI MVP（`SELECT` 限定）

> 注記（2026-04-07）:
> この文書は `v0.1.0` リリース時点の記録です。現行は DML Phase 1 により `--allow-dml` 指定時に `UPDATE/DELETE/INSERT/UPSERT` を実行可能です。

## 1. 概要

`kintone` 向け `ksql` CLI の MVP をリリース。
単発実行とコンソール（REPL）実行を提供し、`SELECT` を安全に実行できる初版を確定しました。

## 2. 主な追加機能

1. CLI 基本実行
- `-e` / `-f` による SQL 単発実行
- `--help` / `--version`
- `--dry-run`
- `--format table|json|jsonl|csv`
- `--max-records` / `--on-limit` / `--timeout`
- `--output` / `--quiet` / `--no-header` / `--pretty` / `--exit-on-empty`

2. 認証
- `token` 認証（`--token`, `--token-map`, `--token-file`）
- `userpass` 認証（`--auth userpass`, `--username`, `--password`）
- `auto` モード（user/pass 優先フォールバック）

3. 実接続診断とデバッグ
- `--diag-record-id`（`GET /k/v1/record.json`）
- `--debug`, `--debug-url`, `--debug-headers`（認証値マスク）
- GET 時 `Content-Type` 非送信へ調整

4. コンソール（REPL）
- メタコマンド:
  `:help`, `:exit/:quit`, `:clear`, `:last`, `:edit`, `:show config`, `:history`, `:rerun <n>`, `:save <path>`, `:save --append <path>`, `:profile <name>`, `:format <...>`, `:dryrun <on|off>`
- 追加:
  `:history <n>`, `:history find <keyword>`
- 履歴永続化: `~/.ksql_history`
- 入力制御:
  `Ctrl+C` バッファキャンセル（空バッファ時2回で終了）、`Ctrl+D` で正常終了

5. 品質・運用
- GitHub Actions CI 追加（test/build）
- Help と README 同期テスト追加（差分検知）
- Console E2E 回帰テスト拡充（`profile/rerun/save` 含む）

## 3. 制約（MVP時点）

1. `SELECT` のみ実行可能
2. `UPDATE` / `DELETE` / `INSERT` は CLI で実行拒否

## 4. 既知事項

1. ワークスペースで `dist/ksql-plugin1.zip`, `prod/js/desktop.js` がローカル差分になる場合があります（CLI MVP リリース対象外）。

## 5. 参考資料

1. `README.md`
2. `docs/archive/cli_mvp_completion_criteria.md`
3. `docs/checklists/cli_test_acceptance_criteria.md`
4. `docs/ksql_cli_console_spec.md`

## 6. Post v0.1.0 Fixes (2026-04-07)

1. REPL DML 確認入力の安定化
- `yes/no` 入力時の二重入力問題を修正
- REPL 側で確認した場合、子実行側の再確認をスキップ

2. Node CLI DML API 実装
- `POST / PUT / DELETE` 呼び出しを実装
- `UPDATE is not supported in CLI MVP.` などの暫定エラーを解消

3. DML 実行前バリデーション強化
- 更新対象フィールドコードを `getFields()` で照合
- 未知フィールドは実行前 `ArgumentError` で停止
