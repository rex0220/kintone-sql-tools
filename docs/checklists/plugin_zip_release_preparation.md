# Plugin ZIP 配布準備チェックリスト

- 作成日: 2026-04-07
- 対象: kintone プラグイン ZIP（GitHub Releases 配布）

## 1. 事前確認

1. 作業ブランチが最新であることを確認する
2. 配布対象バージョン（例: `v1.0.0`）を決める
3. 変更点（ユーザー向け）を3〜5項目に要約する

## 2. ビルド

1. `npm install`
2. `npm run build:plugin`
3. 生成 ZIP を確認する（例: `dist/ksql-plugin1.zip`）
4. CI Secret 運用時は以下を設定する
   - `KSQL_PLUGIN_ID`
   - `KSQL_PLUGIN_PPK_BASE64`

## 3. 配布前検証

1. kintone 管理画面で ZIP を読み込みできる
2. プラグイン設定画面が開ける
3. 一覧画面で SQL 実行UIが表示される
4. `SELECT` が期待どおり動作する
5. 想定する主要機能（Ver.1）を最低1回ずつ確認する

## 4. セキュリティ確認

1. ZIP 内に秘密情報（token/password/秘密鍵）が含まれていない
2. 配布不要ファイル（`.ppk`, ローカル設定）が含まれていない
3. README / リリースノートのコマンド例がサンプル値になっている

## 5. GitHub Release 作成

1. タグ作成（例: `v1.0.0`）
2. Release タイトル作成（例: `kSQL Plugin v1.0.0`）
3. 変更点を記載
4. 既知制約を記載
5. `dist/ksql-plugin1.zip` を Asset 添付

## 6. 公開後確認

1. Release ページから ZIP をダウンロードできる
2. ダウンロード ZIP で再インポート確認する
3. README の配布リンクが正しい

## 7. ロールバック準備

1. 直前版 ZIP を保持する
2. 問題発生時に戻す手順をメモする
3. 問題報告窓口（Issue テンプレート等）を明記する
