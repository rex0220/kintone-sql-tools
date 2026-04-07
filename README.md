# kintone-sql-tools

kintone アプリを SQL で操作するためのプロジェクトです。  
現在はプラグイン本体に加えて、CLI では `SELECT` を既定、`UPDATE/DELETE/INSERT/UPSERT` を安全オプション付きで利用できます。

## CLI Ver.1

既定では `SELECT` を安全に実行します。  
`UPDATE` / `DELETE` / `INSERT` / `UPSERT` は `--allow-dml` 指定時のみ実行できます。

### Live Check (Verified)

実接続での確認手順（PowerShell）:

1. 診断GET（`record.json`）で認証/接続を確認

```powershell
node dist-cli/ksql.js --debug-url --debug-headers `
  --base-url https://<your-subdomain>.cybozu.com `
  --token '<APP_TOKEN>' `
  --app 88 `
  --diag-record-id 1
```

2. SQL実行（`records.json`）を確認

```powershell
node dist-cli/ksql.js --debug `
  --base-url https://<your-subdomain>.cybozu.com `
  --token '<APP_TOKEN>' `
  -e "SELECT * FROM APP88 LIMIT 5"
```

補足:

- GET では `Content-Type` を送らない実装になっています。
- `--debug-url` は URL のみ、`--debug-headers` 併用でマスク済みヘッダーを表示します。

### Build

```bash
npm run build:cli
```

Plugin ZIP をビルドする場合:

```bash
# どちらかで pluginId を指定
$env:KSQL_PLUGIN_ID="YOUR_PLUGIN_ID"
# または pluginId.txt を配置

# 署名鍵をパス指定（任意）
$env:KSQL_PPK_PATH="private.ppk"

npm run build:plugin
```

CI (GitHub Actions) で署名付きプラグインをビルドする場合は、Repository Secrets に以下を設定してください。

- `KSQL_PLUGIN_ID` (必須): kintone の Plugin ID
- `KSQL_PLUGIN_PPK_BASE64` (必須): `.ppk` ファイルを base64 化した文字列

この2つが設定されている場合のみ、`.github/workflows/ci.yml` の `Build plugin (signed)` ステップが実行されます。

### Install (npm)

```bash
npm install -g kintone-sql-tools
ksql --help
```

### Help

```bash
node dist-cli/ksql.js --help
```

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
  --format <type>            Output format: table | json | jsonl | csv
  --max-records <n>          Max records to fetch (default: 500)
  --on-limit <mode>          On record limit: error | truncate
  --timeout <ms>             Request timeout in milliseconds (default: 30000)
  --config <path>            Config file path (default: ./ksql.config.json)
  --profile <name>           Profile name in config
  --base-url <url>           kintone base URL
  --auth <type>              Auth type: token | userpass | auto
  --username <name>          Login username (for userpass auth)
  --password <pass>          Login password (for userpass auth)
  --token <token>            Single-app token
  --token-map <mapping>      App token map (APP100=...,APP101=...)
  --token-file <path>        JSON file for app token map
  --app <id>                 Default app id context
  --diag-record-id <id>      Diagnostic: GET /k/v1/record.json by app+id
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
  --allow-dml                Enable UPDATE/DELETE/INSERT/UPSERT execution
  --yes                      Skip DML confirmation prompt
  --allow-without-where      Allow UPDATE/DELETE without WHERE
  --dml-max-rows <n>         Max affected rows for DML guard (default: 100)
  -h, --help                 Show help
  -v, --version              Show version
```
<!-- END_HELP_SYNC -->

### Execute SQL

```bash
node dist-cli/ksql.js --base-url https://example.cybozu.com --token xxx -e "SELECT * FROM APP100"
```

デバッグログを出す場合:

```bash
node dist-cli/ksql.js --debug --base-url https://example.cybozu.com --token xxx -e "SELECT * FROM APP100 LIMIT 1"
```

実HTTPリクエストURLだけ出す場合:

```bash
node dist-cli/ksql.js --debug-url --base-url https://example.cybozu.com --token xxx -e "SELECT * FROM APP100 LIMIT 1"
```

## License

Licensed under the MIT License. See [LICENSE](LICENSE).

実HTTPリクエストURL + ヘッダー（マスク済み）を出す場合:

```bash
node dist-cli/ksql.js --debug-url --debug-headers --base-url https://example.cybozu.com --token xxx -e "SELECT * FROM APP100 LIMIT 1"
```

診断用に単一レコード GET（`/k/v1/record.json`）を直接叩く場合:

```bash
node dist-cli/ksql.js --debug-url --debug-headers --base-url https://example.cybozu.com --token xxx --app 100 --diag-record-id 1
```

`user/pass` 認証の例:

```bash
node dist-cli/ksql.js \
  --base-url https://example.cybozu.com \
  --auth userpass \
  --username your_user \
  --password your_password \
  -e "SELECT * FROM APP100 LIMIT 5"
```

### Execute File

```bash
node dist-cli/ksql.js --base-url https://example.cybozu.com --token xxx -f ./query.sql
```

### Execute DML (Safe)

```bash
node dist-cli/ksql.js \
  --base-url https://example.cybozu.com \
  --token xxx \
  --allow-dml \
  --dml-max-rows 50 \
  -e "UPDATE APP100 SET 状態 = '完了' WHERE ステータス = '未着手'"
```

非対話実行で確認を省略する場合のみ `--yes` を指定してください。

### Console (REPL)

```bash
node dist-cli/ksql.js --console --base-url https://example.cybozu.com --token xxx
```

Console commands:

- `:help`
- `:exit` / `:quit`
- `:clear` (input buffer clear)
- `:last` (show last executed SQL)
- `:buffer` (show current input buffer)
- `:edit` (open current input buffer in external editor)
- `:show config`
- `:history`
- `:history <n>`
- `:history find <keyword>`
- `:rerun <n>`
- `:save <path>`
- `:save --append <path>`
- `:profile <name>`
- `:format table|json|jsonl|csv`
- `:dryrun on|off`

SQL is executed when a statement ends with `;`.
Executed SQL history is saved to `~/.ksql_history`.
`Ctrl+C` は入力中バッファをキャンセルします。空バッファ時は 2 回連続で `Ctrl+C` を押すと終了します。
`Ctrl+D` は console を終了し、終了コード `0` を返します。

### Dry Run

```bash
node dist-cli/ksql.js --dry-run -e "SELECT * FROM APP100 WHERE 状態 = '完了'"
```

### Multi-app Token

```bash
node dist-cli/ksql.js \
  --base-url https://example.cybozu.com \
  --token-map APP100=token100,APP101=token101 \
  -e "SELECT * FROM APP100 JOIN APP101 ON APP100.レコード番号 = APP101.レコード番号"
```

`--token-file` を使う場合の例:

```json
{
  "APP100": "token100",
  "APP101": "token101"
}
```

```bash
node dist-cli/ksql.js \
  --base-url https://example.cybozu.com \
  --token-file ./tokens.json \
  -e "SELECT * FROM APP100 JOIN APP101 ON APP100.レコード番号 = APP101.レコード番号"
```

### Config File

`docs/examples/ksql.config.sample.json` を参考に `ksql.config.json` を作成してください。

```bash
node dist-cli/ksql.js --config ./ksql.config.json --profile dev -e "SELECT * FROM APP100"
```

`user/pass` を config で使う場合は `passwordEnv` を推奨します。

```json
{
  "defaultProfile": "dev",
  "profiles": {
    "dev": {
      "baseUrl": "https://example.cybozu.com",
      "auth": "userpass",
      "username": "your_user",
      "passwordEnv": "KSQL_PASSWORD_DEV"
    }
  }
}
```

### Environment Variables

CLI は以下の環境変数をサポートします。

- `KSQL_CONFIG`
- `KSQL_PROFILE`
- `KSQL_BASE_URL`
- `KSQL_AUTH`
- `KSQL_USERNAME`
- `KSQL_PASSWORD`
- `KSQL_TOKEN`
- `KSQL_TOKEN_MAP`
- `KSQL_APP`
- `KSQL_MAX_RECORDS`
- `KSQL_ON_LIMIT`
- `KSQL_TIMEOUT`
- `KSQL_FORMAT`
- `KSQL_NO_HEADER`
- `KSQL_PRETTY`
- `KSQL_NO_COLOR`
- `KSQL_QUIET`
- `KSQL_DEBUG`
- `KSQL_DEBUG_URL`
- `KSQL_DEBUG_HEADERS`
- `KSQL_OUTPUT`
- `KSQL_EXIT_ON_EMPTY`
- `KSQL_ALLOW_DML`
- `KSQL_YES`
- `KSQL_ALLOW_WITHOUT_WHERE`
- `KSQL_DML_MAX_ROWS`

### Option Priority

同じ設定が複数箇所にある場合、以下の順で適用されます。

1. CLI 引数
2. 環境変数
3. `ksql.config.json`
4. 既定値

## Documents

- `docs/README.md`
- `docs/ksql_cli_console_spec.md`
