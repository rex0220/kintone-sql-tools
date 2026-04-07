# kSQL CLI テスト合格基準（Ver.1）

- 作成日: 2026-04-06
- 対象: kSQL CLI Ver.1
- 目的: リリース可否を判断するための最低合格ラインを定義する

## 1. 合格判定ルール

リリース合格は以下をすべて満たすこと。

1. 必須テスト項目（P0）が 100% 合格
2. 重大不具合（データ破壊・認証漏えい・クラッシュ）が 0 件
3. 既知不具合は回避策付きで記録されている

## 2. 対象範囲（Ver.1）

1. `-e` / `-f` による単発実行
2. `SELECT` 実行
3. DML 実行ガード（`--allow-dml`, `--yes`, `--allow-without-where`, `--dml-max-rows`）
4. `--dry-run`
5. `--format table|json`（追加形式は任意）
6. `--max-records`, `--on-limit`
7. `--help`, `--version`
8. token 認証（`--token-map`, `--token-file`, 単一APP時 `--token`）

## 3. 必須テスト項目（P0）

## 3.1 引数・起動

1. `ksql --help` が 0 で終了し、主要オプションが表示される
2. `ksql --version` が 0 で終了し、バージョン文字列を返す
3. `-e` と `-f` 同時指定で終了コード `2`
4. 必須接続情報不足時に終了コード `3`（認証/接続エラー）

## 3.2 SQL 実行制御（DML Phase 1 安全ポリシー）

1. `SELECT` は正常実行できる（終了コード `0`）
2. `--allow-dml` なしの DML は実行拒否（終了コード `2`）
3. `--allow-dml` ありの DML は実行経路に入る
4. `UPDATE/DELETE` WHERE なしは既定拒否（終了コード `2`）
5. `--dml-max-rows` 超過時は実行前拒否（終了コード `2`）
6. `APPxxx` 形式不正は実行前エラー（終了コード `2`）
7. `--dry-run` で API 実行せず計画のみ返す

## 3.3 出力

1. `--format table` で表形式が出る
2. `--format json` で JSON 文字列が出る
3. `--no-header` 指定時に表ヘッダが消える
4. `--quiet` 指定時に不要メタログが抑制される

## 3.4 件数制御

1. `--max-records` 超過時、`--on-limit=error` でエラー終了
2. `--max-records` 超過時、`--on-limit=truncate` で切り詰め成功
3. 出力件数と rowCount が仕様どおり整合する

## 3.5 token 解決

1. 単一APP + `--token` で成功
2. 複数APP + `--token` のみは実行前エラー
3. `--token-map` で複数APP実行できる
4. `--token-file` で複数APP実行できる
5. 必要APPの token 欠落時は実行前エラー
6. ログに token 平文が出ない（debug時もマスク）

## 3.6 終了コード

1. 正常終了: `0`
2. SQL/実行エラー: `1`
3. 引数エラー: `2`
4. 認証/接続エラー: `3`

## 4. 推奨テスト項目（P1）

1. `--config` + `--profile` 読み込み
2. 優先順位（CLI引数 > 環境変数 > config > 既定値）
3. `env:KEY` トークン参照
4. `--output` ファイル出力
5. `--no-color` の ANSI 抑止
6. `--exit-on-empty` の挙動

## 5. 非機能基準（Ver.1）

1. 1000件規模の `SELECT` でタイムアウト・メモリ異常が発生しない
2. 不正入力で未捕捉例外によりプロセスが異常終了しない
3. エラーメッセージに原因と対処ヒントが含まれる

## 6. テストデータ基準

1. 単一APPケース（APP100想定）
2. 複数APPケース（JOIN/サブクエリ想定）
3. 日本語フィールドコードを含むケース
4. 0件・境界件数（`maxRecords` 直前/直後）ケース

## 7. 合格エビデンス

1. テスト実行ログ
2. 失敗時の再現手順
3. 既知課題一覧（優先度付き）

上記を PR またはリリースノートに紐づけること。

## 8. リリース判定テンプレート

1. P0合格率: `xx/xx`
2. 重大不具合: `0` 件 / `n` 件
3. 既知課題: `n` 件（回避策あり/なし）
4. 判定: `GO` / `NO-GO`

---

関連資料:

1. `docs/ksql_cli_console_spec.md`
2. `docs/implementation/cli_implementation_steps.md`
3. `docs/kintone_sql_plugin_spec.md`
