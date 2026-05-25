# kintone-sql-tools

kintone アプリを SQL 風の構文で操作するツールセットです。

- kintone プラグイン（UI）
- CLI（`ksql`）

## 機能概要

- `SELECT`（JOIN/GROUP BY/HAVING/CTE/UNION）
- `INSERT` / `UPDATE` / `UPSERT` / `DELETE` / `REORDER`（`--allow-dml` 必須）
- `EXPLAIN`
- サブテーブル仮想テーブル（`APP100$明細`）
- CLI 拡張 `APP@profile`
  - 同一 SQL 内で同一 APP の profile 混在を許可
  - `INSERT/UPDATE/UPSERT` 対応、`DELETE` は未対応
- `FROM` 省略 SELECT（例: `SELECT 'xxx' AS a`）

## インストール

## npm（グローバル）

```bash
npm install -g @rex0220/kintone-sql-tools
ksql --help
```

## ローカル開発

```bash
npm install
npm run build:cli
node dist-cli/ksql.js --help
```

プラグインをビルドする場合:

```bash
npm run build:plugin
```

## 使い分け（CLI / Plugin）

- CLI を使うケース:
  - バッチ実行
  - CI/CD 連携
  - `APP@profile` を使った環境切替
  - `--dry-run` / `EXPLAIN` による安全確認

- Plugin を使うケース:
  - kintone 画面内での対話操作
  - 非エンジニア向けの運用
  - UI で結果確認したい場合

注意:

- `@profile` は CLI 拡張です。plugin 側では非対応です。

## 最短実行例（CLI）

```bash
node dist-cli/ksql.js --base-url https://example.cybozu.com --token xxx -e "SELECT * FROM APP100 LIMIT 5"
```

`FROM` 省略 SELECT:

```bash
node dist-cli/ksql.js -e "SELECT 'xxx' AS a"
```

DML（確認付き）:

```bash
node dist-cli/ksql.js \
  --base-url https://example.cybozu.com \
  --token xxx \
  --allow-dml \
  -e "UPDATE APP100 SET 状態 = '完了' WHERE ステータス = '未着手'"
```

コンソール:

```bash
node dist-cli/ksql.js --console --base-url https://example.cybozu.com --token xxx
```

## 設定ファイル

- 既定: `./ksql.config.json`
- profile 切替: `--profile <name>`

例:

```bash
node dist-cli/ksql.js --config ./ksql.config.json --profile dev -e "SELECT * FROM APP100"
```

## CLI オプション

<!-- BEGIN_HELP_SYNC -->
```text
ksql - Execute SQL against kintone apps

Usage:
  ksql [options]
  ksql -e "<SQL>"
  ksql -f <file.sql>

Options:
  -e, --execute <sql>        Execute SQL string
  -f, --file <path>          Execute SQL file
  --console                  Start interactive console mode
  --dry-run                  Parse and show execution plan only
  --format <type>            Output format: table | json | jsonl | csv | markdown | md
  --max-records <n>          Max records to fetch (default: 500)
  --on-limit <mode>          On record limit: error | truncate
  --timeout <ms>             Request timeout in milliseconds (default: 30000)
  --config <path>            Config file path (default: ./ksql.config.json)
  --profile <name>           Profile name in config
  --base-url <url>           kintone base URL
  --guest-space-id <id>      Guest space ID (uses /k/guest/<id>/v1 APIs)
  --auth <type>              Auth type: token | userpass | auto
  --username <name>          Login username (for userpass auth)
  --password <pass>          Login password (for userpass auth)
  --token <token>            Single-app token
  --token-map <mapping>      App token map (APP100=...,APP101=...)
  --token-file <path>        JSON file for app token map
  --app <id>                 Default app id context
  --diag-record-id <id>      Diagnostic: GET record.json by app+id
  --no-header                Hide table header
  --pretty                   Pretty-print JSON output
  --user-format <mode>       User field format: full | name | code
  --array-format <mode>      Array field format: full | join
  --table-format <mode>      Subtable format: full | count
  --date-format <mode>       Date format: full | local
  --attachment-format <mode> Attachment format: full | name | fileKey
  --output <path>            Write output to file
  --no-color                 Disable ANSI colors
  --quiet                    Suppress non-result logs
  --debug                    Show request/response debug logs
  --debug-url                Show only HTTP request URL debug logs
  --debug-headers            Show request headers in debug logs (masked)
  --exit-on-empty            Return exit code 1 when rowCount is 0
  --allow-dml                Enable UPDATE/DELETE/INSERT/UPSERT/REORDER execution
  --yes                      Skip DML confirmation prompt
  --allow-without-where      Allow UPDATE/DELETE without WHERE
  --dml-max-rows <n>         Max affected rows for DML guard (default: 100)
  -h, --help                 Show help
  -v, --version              Show version
```
<!-- END_HELP_SYNC -->

## 最低限のトラブルシュート

1. `ArgumentError: no APPxxx found...`
- `FROM` ありクエリでは `APPxxx` 指定が必要です。
- `SELECT 'xxx' AS a` のような式 SELECT は実行可能です。

2. `AuthError: token is missing...`
- `--token-map` / `--token-file` / config の `tokenMap` を確認してください。

3. `ArgumentError: unknown field code(s)...`
- フィールドコード名を確認してください（ラベル名ではなくコード）。

4. `DML is disabled`
- `--allow-dml` を付けて再実行してください。

5. `@profile` を使った DELETE が失敗する
- 現在 `DELETE` の `@profile` は未対応です。

6. Windows で `ksql --help` 実行時にエディタが開いてしまう
- `.js` 関連付けの影響の可能性があります。`ksql.cmd --help` または `node dist-cli/ksql.js --help` で確認してください。

## 機密情報の取り扱い

- token / password は直書きせず、環境変数または `env:` 参照を推奨します。
- `ksql.config.json` はローカル運用ファイルとして `.gitignore` 済みです。
- `private.ppk` / `pluginId.txt` は `.gitignore` 済みです。

## ドキュメント

- [Docs Index](docs/README.md)
- [言語リファレンス](docs/ksql_language_reference.md)
- [CLI / Console 仕様](docs/ksql_cli_console_spec.md)
- [APP@profile 仕様](docs/cli_app_profile_spec.md)
- [公開前チェックリスト](docs/internal/public_release_checklist.md)

## ライセンス

MIT License. See [LICENSE](LICENSE).
