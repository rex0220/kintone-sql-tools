# Public Repo 準備リスト

- 作成日: 2026-04-07
- 目的: private リポジトリから public 公開用に安全な構成を切り出す

## 1. 公開用に含めるフォルダー

1. `src/`
2. `docs/`（ただし `docs/test/` は除外）
3. `.github/`
4. `scripts/`（公開して問題ないもののみ）
5. `plugin/`（必要な場合）
6. `prod/`（必要な場合）
7. `docs/examples/`

## 2. 公開用に含めるルートファイル

1. `README.md`
2. `package.json`
3. `package-lock.json`
4. `tsconfig.json`
5. `build.mjs`
6. `build-cli.mjs`
7. `.gitignore`
8. `.env.example`
9. `LICENSE`（公開時に追加）

## 3. 公開から除外するもの

### 3.1 実環境情報・個人名・アプリ情報を含む資料

1. `docs/test/`
2. `docs/archive/APP_4141_KSQL-20260404-1808.md`
3. `docs/archive/APP_4141_KSQL-20260404-2142.md`

### 3.2 ローカル運用設定（内部権限ルール・ローカルパス）

1. `.claude/`

### 3.3 配布不要 / 内部用成果物

1. `dist/`
2. `dist-cli/`（必要なければ除外）
3. `template/`（特に zip は除外推奨）
4. `pluginId.txt`
5. `private.ppk`
6. `ksql.config.json`

## 4. 公開前チェック

1. 秘密情報スキャン（token/password/private key）
2. 公開対象の最終一覧を確認
3. `npm test` と `npm run build` の実行
4. README の利用手順が public 向けになっているか確認
5. ライセンス（`LICENSE` / `package.json`）を確認

## 5. 推奨運用

1. 公開用は履歴なし新規リポジトリで管理する
2. 秘密鍵は Git 管理せず CI Secret で運用する
3. 公開対象は allowlist 方式で固定する
