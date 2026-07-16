# kintone-sql-tools

kintone アプリを SQL 風の構文で操作するツールセットです。

- kintone プラグイン（UI）
- CLI（`ksql`）
- MCP サーバー（AI クライアントから kintone を SQL 操作。Claude Desktop 用 MCPB 同梱）

## 機能概要

- `SELECT`（JOIN/GROUP BY/HAVING/CTE/UNION）
- `INSERT` / `UPDATE` / `UPDATE ... FROM` / `UPSERT` / `DELETE` / `REORDER`（`--allow-dml` 必須）
- `EXPLAIN`
- **バッチ実行（`;` 区切りの複文）と一時テーブル `CREATE TEMP TABLE #t AS SELECT ...`**（v1.4.0）
  - CLI / MCP: read-only バッチ + DML バッチ（一時テーブル経由の `INSERT ... SELECT` を含む）
  - プラグイン: read-only バッチのみ（最終結果を表示）
- **`ASSERT`（実行時ゲート。DML 前の件数ガード / CLI ヘルスチェック）**（v1.10.0）
- サブテーブル仮想テーブル（`APP100$明細`）
- CLI 拡張 `APP@profile`
  - 同一 SQL 内で同一 APP の profile 混在を許可
  - `INSERT/UPDATE/UPSERT` 対応、`DELETE` は未対応
- CLI / MCP の論理アプリ参照 `LAPP_<NAME>`
  - profile ごとの `logicalApps` で、同じ SQL を異なる物理アプリ ID へ安全に解決
  - `APP100` は常に物理 ID 100 のまま（暗黙変換なし）
  - `allowPhysicalAppRefs: false` で、その profile の物理 `APPxxx` 直接参照を禁止可能
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
  - DML を含むバッチ実行・SQL ファイル実行（`-f`）
  - CI/CD 連携
  - `APP@profile` を使った環境切替
  - `LAPP_<NAME>` を使った配置非依存 SQL
  - `--dry-run` / `EXPLAIN` による安全確認

- Plugin を使うケース:
  - kintone 画面内での対話操作（read-only バッチ + 一時テーブルも利用可）
  - 非エンジニア向けの運用
  - UI で結果確認したい場合

- MCP を使うケース:
  - Claude 等の AI クライアントから kintone を照会・更新
  - 一時テーブルで中間結果をサーバー内に保持し、AI のコンテキスト消費を抑えたい場合
  - validation / EXPLAIN で論理名から最終的な物理アプリ ID への解決を確認したい場合

注意:

- `APP@profile` と `LAPP_<NAME>[@profile]` は Node.js runtime（CLI / MCP）の拡張です。plugin 側では非対応です。

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

論理アプリ参照を使う場合、profile ごとに論理名と物理 ID を定義します。

```json
{
  "defaultProfile": "dev",
  "profiles": {
    "dev": {
      "baseUrl": "https://dev.example.cybozu.com",
      "logicalApps": { "ORDERS": 100 },
      "tokenMap": { "APP100": "env:DEV_ORDERS_TOKEN" }
    },
    "prod": {
      "baseUrl": "https://prod.example.cybozu.com",
      "allowPhysicalAppRefs": false,
      "logicalApps": { "ORDERS": 1200 },
      "tokenMap": { "APP1200": "env:PROD_ORDERS_TOKEN" }
    }
  }
}
```

```bash
node dist-cli/ksql.js --config ./ksql.config.json --profile dev -e "SELECT * FROM LAPP_ORDERS"
node dist-cli/ksql.js --config ./ksql.config.json --profile prod -e "SELECT * FROM LAPP_ORDERS"
```

どちらも同じ SQL ですが、前者は `APP100`、後者は `APP1200` に解決されます。`logicalApps` のキーは `LAPP_` を付けない ASCII 論理名です。`APP100`、`100`、`LAPP_ORDERS` は設定キーとして拒否されます。

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
  --var <name=value>         Override a DECLARE variable (repeatable; not for secrets)
  --format <type>            Output format: table | json | jsonl | csv | markdown | md
                             (batch + json: prints one JSON envelope for the whole batch)
  --max-records <n>          Max records to fetch (default: 500)
  --fetch-parallel <n>       Parallel page fetches per query: 1-10 (default: 3)
  --on-limit <mode>          On record limit: error | truncate
  --temp-table-max-rows <n>  Max rows per temp table (default: 10000, always errors on overflow)
  --timeout <ms>             Request timeout in milliseconds (default: 30000)
  --max-concurrent <n>       Max concurrent kintone requests: 1-50 (default: 10)
                             (process-wide; fixed at first resolution; KSQL_MAX_CONCURRENT wins)
  --retry <n>                GET retry count: 0-10, 0 disables (default: 3; KSQL_RETRY wins)
  --retry-base-delay <ms>    GET retry backoff base delay (default: 500)
  --retry-max-delay <ms>     GET retry backoff max delay (default: 8000)
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
  --continue-on-error        Batch: keep executing after a statement error (read-only batch only)
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
- [バッチ実行・一時テーブル仕様](docs/ksql_batch_temp_table_spec.md)
- [MCP サーバー仕様](docs/ksql_mcp_server_spec.md) / [Claude Desktop への導入（MCPB）](docs/ksql_mcpb_claude_desktop_install.md)
- [APP@profile 仕様](docs/cli_app_profile_spec.md)
- [公開前チェックリスト](docs/internal/public_release_checklist.md)

## ライセンス

MIT License. See [LICENSE](LICENSE).
