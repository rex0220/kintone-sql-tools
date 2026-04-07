# kSQL CLI MVP 完了条件

- 作成日: 2026-04-06
- 対象: kSQL CLI 初版（`SELECT` 限定）
- 目的: MVP 完了（リリース可能）を判定する基準を定義する

> 注記（2026-04-07）:
> 本書は MVP 時点の判定基準を記録した履歴資料です。現行運用は DML Phase 1 反映済み（`--allow-dml` 前提で `UPDATE/DELETE/INSERT/UPSERT` 実行可）です。

## 1. MVP の定義

MVP は「kintone アプリを対象に、CLI から安全に `SELECT` を単発実行できる最小機能セット」とする。

## 2. 必須機能要件（全て必須）

1. `-e` / `-f` で SQL 単発実行ができる
2. `SELECT` を実行できる
3. `UPDATE` / `DELETE` / `INSERT` は実行拒否できる
4. `--dry-run` で実行計画のみ表示できる
5. `--format table|json` を切替できる
6. `--max-records` と `--on-limit` が機能する
7. `--help` / `--version` が機能する

## 3. 認証・設定要件（全て必須）

1. `--auth token` が利用できる
2. 単一APP時 `--token` が利用できる
3. 複数APP時 `--token-map` または `--token-file` が利用できる
4. 必要APPの token 欠落時は実行前にエラー終了する
5. 設定ファイル `ksql.config.json` を読み込める
6. 優先順位が守られる（CLI引数 > 環境変数 > config > 既定値）

## 4. 安全要件（全て必須）

1. 非SELECT文は終了コード `2` で拒否
2. 認証情報（token/password）をログに平文出力しない
3. `APPxxx` 形式不正時は実行前エラー
4. 上限到達時の動作が `error|truncate` で明確に分岐する
5. 未捕捉例外でプロセスが落ちない

## 5. 品質要件（全て必須）

1. `docs/checklists/cli_test_acceptance_criteria.md` の P0 項目が 100% 合格
2. 重大不具合（データ破壊・認証漏えい・クラッシュ）が 0 件
3. 終了コード `0/1/2/3` が仕様どおりに返る
4. エラー文言に原因と最低限の対処ヒントがある

## 6. ドキュメント要件（全て必須）

1. `--help` 表示内容と仕様書が一致している
2. 初版制約（SELECT限定）が明記されている
3. token 指定方法（単一/複数APP）が明記されている
4. 最低3つの実行例（`-e`, `-f`, `--dry-run`）がある

## 7. MVP 完了判定（GO 条件）

以下をすべて満たした場合に MVP 完了（GO）とする。

1. 必須機能要件: 完了
2. 認証・設定要件: 完了
3. 安全要件: 完了
4. 品質要件: 完了
5. ドキュメント要件: 完了

1つでも未達がある場合は NO-GO とする。

## 8. 判定テンプレート

1. 機能要件: PASS / FAIL
2. 認証・設定要件: PASS / FAIL
3. 安全要件: PASS / FAIL
4. 品質要件: PASS / FAIL
5. ドキュメント要件: PASS / FAIL
6. 総合判定: GO / NO-GO

## 9. Current Status (2026-04-07)

1. 機能要件: PASS
2. 認証・設定要件: PASS（token / userpass / auto）
3. 安全要件: PASS（MVP時点: SELECT限定、非SELECT拒否）
4. 品質要件: PASS（テスト通過）
5. ドキュメント要件: PASS
6. 総合判定: GO

## 10. DML Phase 1 Status (2026-04-07)

1. 安全フラグ実装: PASS（`--allow-dml`, `--yes`, `--allow-without-where`, `--dml-max-rows`）
2. ガード挙動: PASS（allow必須、WHEREなし拒否、maxRows超過拒否）
3. REPL確認: PASS（確認プロンプト、キャンセル時停止）
4. 未知フィールド検証: PASS（実行前 `ArgumentError`）
5. 実接続確認: PASS（UPDATE/INSERT/UPSERT の未知フィールドケース確認済み）
6. 総合判定: GO（Phase 1）

---

関連資料:

1. `docs/ksql_cli_console_spec.md`
2. `docs/implementation/cli_implementation_steps.md`
3. `docs/checklists/cli_test_acceptance_criteria.md`
