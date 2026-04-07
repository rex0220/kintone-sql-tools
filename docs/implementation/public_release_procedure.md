# Public 公開手順書（履歴分離方式）

- 作成日: 2026-04-07
- 対象: `ksql` を private から安全に public 公開する
- 前提: 公開用は「履歴なし新規リポジトリ」で作成する

## 1. 方針

1. 公開対象は allowlist（公開するものだけ選ぶ）で構成する
2. 公開用リポジトリはローカルで新規作成し、既存 private の履歴を持ち込まない
3. `GO/NO-GO` 判定に合格してから初回公開する
4. 履歴なし新規リポジトリ方式では、公開直前の履歴リセットは不要

## 2. 事前準備

1. private 側で最新状態を取得する
2. 公開用作業ディレクトリを別パスに作る
3. 以下ドキュメントを確認する
   - `docs/checklists/public_repo_preparation.md`
   - `docs/checklists/plugin_zip_release_preparation.md`（ZIP 配布する場合）
   - `docs/implementation/public_license_guide.md`

## 3. 公開用リポジトリ作成（ローカル）

1. 新規フォルダを作成する（例: `ksql-public`）
2. `git init` を実行する
3. default branch（`main`）を作成する

## 4. 公開対象のコピー（allowlist）

1. 公開対象フォルダをコピーする
   - `src/`
   - `docs/`（`docs/test/` は除外）
   - `.github/`
   - `scripts/`（公開可能なもののみ）
   - `plugin/`（必要時）
   - `prod/`（必要時）
2. 公開対象ファイルをコピーする
   - `README.md`
   - `package.json`
   - `package-lock.json`
   - `tsconfig.json`
   - `build.mjs`
   - `build-cli.mjs`
   - `.gitignore`
   - `.env.example`
3. 以下を含めない
   - `private.ppk`
   - `pluginId.txt`
   - `ksql.config.json`
   - `.claude/`
   - `dist/`（配布方針により判断）
   - `dist-cli/`（配布方針により判断）
   - `template/`（配布不要物）

## 5. ライセンス・公開メタ情報の追加

1. `LICENSE` を追加（MIT など採用ライセンス）
2. `package.json` を public 向けに調整
   - `private: true` の扱いを決める
   - `license` を設定する
   - `repository` / `bugs` / `homepage` を設定する
3. `README.md` に公開利用者向け情報を明記する
   - インストール手順
   - 最小実行例
   - 制約事項
   - 問い合わせ先（Issues）
4. Plugin 署名は CI Secret 運用を前提にする
   - `KSQL_PLUGIN_ID`
   - `KSQL_PLUGIN_PPK_BASE64`
   - Actions では `KSQL_PLUGIN_PPK_BASE64` を復元して `KSQL_PPK_PATH` に渡す

## 6. GO/NO-GO チェック

1. 秘密情報スキャン
   - token / password / private key / 実 URL / 個人情報
2. ビルド・テスト
   - `npm test`
   - `npm run build`
3. ドキュメント整合
   - Ver.1 表記
   - 実装済み機能と記述の一致
4. 配布導線
   - CLI 公開（npm）を行うか
   - Plugin 公開（GitHub Release ZIP）を行うか

## 7. 公開判断

1. GO 条件
   - セキュリティ懸念なし
   - 主要機能の動作確認済み
   - ライセンス記述が完了
2. NO-GO 条件
   - 秘密情報混入の疑い
   - 主要手順の再現不可
   - README の実行手順が不完全

## 8. 初回公開

1. 公開用リポジトリで初回コミット
2. GitHub に public リポジトリを作成
3. `main` を push
4. 必要なら `v1.0.0` などのタグとリリースノートを作成

## 9. 補足（履歴リセットについて）

1. 本手順は「履歴なし新規リポジトリ」を前提とするため、公開直前の履歴リセットは不要
2. 既存 private リポジトリをそのまま public 化する場合のみ、履歴再構成（filter/rewrite）が必要
3. 安全性優先なら、常に本手順（履歴分離方式）を採用する
