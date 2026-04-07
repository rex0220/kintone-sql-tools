# Public Release Checklist

private リポジトリから public 化する直前の確認項目です。

## 1. ドキュメント整備

1. インストール手順が README にある
2. CLI / Plugin の使い分けが README にある
3. 最低限のトラブルシュートが README にある
4. ライセンス表記が README と `LICENSE` で一致している
5. `docs/README.md` のリンクが実在ファイルを指している

## 2. 実行確認（第三者目線）

1. `npm install`
2. `npm run build:cli`
3. `node dist-cli/ksql.js --help`
4. `node dist-cli/ksql.js -e "SELECT 'xxx' AS a"`
5. `node dist-cli/ksql.js --dry-run -e "SELECT * FROM APP100 LIMIT 1"`

## 3. 機密情報チェック

1. token/password が tracked ファイルに含まれていない
2. `.env` / `ksql.config.json` / `private.ppk` / `pluginId.txt` が未追跡である
3. debug ログ断片（Authorization ヘッダー等）がコミットに含まれていない

推奨コマンド:

```bash
git ls-files
git grep -n -I -E "(token|password|authorization|api[-_ ]?key|secret)"
```

## 4. Git 履歴チェック

1. 公開したくない履歴（検証用URL、秘密鍵、社内メモ）がない
2. 必要に応じて公開前に履歴整理を完了している

## 5. 公開手順

1. private リポジトリへ push
2. 最終レビュー（README / docs / Actions / リリースタグ）
3. GitHub リポジトリ可視性を `public` に変更
