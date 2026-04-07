# kSQL CLI 実装手順

- 作成日: 2026-04-06
- 対象: `ksql` リポジトリ内での CLI / Console モード実装

## 1. 先に決める方針

結論:

1. 実装開始は「現行プラグインとの責務分離」から行う
2. ただしリポジトリは分割しない（同一repoで `core/ui/cli` 分離）
3. CLI は `core` を利用する薄い層として実装する

## 2. 全体ロードマップ

1. Phase 1: コア分離（既存プラグインを壊さない）
2. Phase 2: 最小CLI（非対話実行）
3. Phase 3: コンソール（REPL）
4. Phase 4: 安全機能と設定強化
5. Phase 5: 運用整備（配布・テスト・ドキュメント）

## 3. 詳細実装ステップ

## Step 0. 事前確認

1. 現在テストが通る状態を確認する
2. `docs/kintone_sql_plugin_spec.md` と整合する対象範囲を固定する
3. 既存 `src/ui/*` の `core` 依存候補を洗い出す

完了条件:

1. 既存挙動の基準（テスト/期待動作）が明確

## Step 1. `src/core` への責務分離

1. `lexer/parser/converter/engine/api/types/execute` を `src/core` 配下へ移動
2. `src/core` から UI 依存 import が無い状態にする
3. 共通エラー型・実行結果型を `src/core/types` に集約する

完了条件:

1. プラグインUI以外から `src/core` を単体で呼べる

## Step 2. プラグイン層の接続差し替え

1. `src/ui/desktop.ts` と `src/ui/config.ts` から `src/core` を呼ぶように修正
2. UI固有処理（DOM/イベント/表示）とSQL実行ロジックを分離
3. プラグインビルド（`build.mjs`）が継続成功することを確認

完了条件:

1. 従来のプラグイン機能が回帰なしで動作

## Step 3. テスト再編（回帰防止）

1. 既存テストの import パスを `src/core` 構成へ更新
2. `core` テストを優先して成功させる
3. UI層テストは必要最小限（接続点中心）に整理

完了条件:

1. 既存仕様に対する回帰が検知できる状態

## Step 4. CLI 最小機能（M1）

1. `src/cli/index.ts` を追加
2. `--help`, `--version` を実装
3. `-e/--execute`, `-f/--file` を実装
4. `--format table|json`, `--dry-run` を実装
5. 終了コード規約（0/1/2/3）を実装

完了条件:

1. 非対話のSQL実行が安定して使える

## Step 5. CLI ビルド・配布準備

1. `build-cli.mjs` を追加
2. `package.json` scripts を分離する
3. `bin` エントリ（`ksql`）を設定する
4. ローカルで `ksql --help` が実行できることを確認する

完了条件:

1. CLI とプラグインを独立ビルド可能

## Step 6. コンソールモード（M2）

1. `--console` で REPL 起動
2. `;` 終端まで複数行入力を受け付ける
3. `:help`, `:exit`, `:format`, `:dryrun` を実装
4. `Ctrl+C` キャンセルと `Ctrl+D` 終了を実装

完了条件:

1. RDBクライアント風の基本対話操作が可能

## Step 7. 安全制御（更新系）

1. `UPDATE/DELETE/INSERT` 時の確認プロンプト（対話モード）を実装
2. `WHERE` なし更新警告を実装
3. `--dry-run` で実行計画と見積件数表示を強化

完了条件:

1. 誤更新リスクを抑えた運用が可能

## Step 8. 設定ファイルとプロファイル（M3）

1. `ksql.config.json` の読み込みを実装
2. `--profile` 切替を実装
3. 優先順位を統一する（CLI引数 > 環境変数 > config > 既定値）

完了条件:

1. チーム運用向けの再現可能な実行設定が使える

## Step 9. 運用整備

1. ヘルプ文面と docs を同期
2. 利用例（READMEまたはdocs）を追加
3. CIで `core` と `cli` の基本テストを自動化

完了条件:

1. 新規メンバーが同じ手順で開発・利用できる

## Step 10. DML Phase 1（更新系の段階導入）

1. `UPDATE/DELETE/INSERT` を `--allow-dml` 前提で許可する
2. `--dry-run` で DML 計画表示（実API未実行）を実装する
3. `WHERE` なし `UPDATE/DELETE` を既定拒否にする
4. `--yes` なしで実行前確認を必須化する
5. `--dml-max-rows` で影響件数ガードを実装する

完了条件:

1. `docs/implementation/cli_dml_phase1_spec.md` の受け入れ条件を満たす

## 4. 実行順チェックリスト（短縮版）

1. `core` 分離
2. plugin 参照差し替え
3. テスト回帰確認
4. CLI最小実装
5. CLIビルド導入
6. REPL追加
7. 安全制御追加
8. config/profile対応
9. docs/CI整備
10. DML Phase 1

## 5. リポジトリ分割の判断基準（将来）

以下を満たした時のみ別repo化を検討する。

1. CLI をプラグインと独立したリリース周期で運用する
2. CLI 専用 Issue/PR が大半になり保守単位を分ける利点が大きい
3. `core` をパッケージとして安定提供できる見通しがある

現段階では、同一repoのまま進める方が実装速度と整合性で有利。

---

関連資料:

1. `docs/ksql_cli_console_spec.md`
2. `docs/others/development_folder_structure.md`
3. `docs/kintone_sql_plugin_spec.md`
4. `docs/implementation/cli_dml_phase1_spec.md`
