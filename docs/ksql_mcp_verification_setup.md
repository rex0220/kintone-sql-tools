# kSQL MCP サーバー確認環境構築手順

この手順は、`ksql-mcp` をローカルで起動し、MCP クライアントから `ksql_validate` / `ksql_explain` / `ksql_query` などを確認するためのものです。

確認は次の 2 段階で行う。

1. kintone API を呼ばない疎通確認
2. 実 kintone 環境に接続する確認

## 1. 前提

必要なもの:

1. Node.js 18 以上
2. npm
3. このリポジトリの作業コピー
4. MCP クライアント
   - MCP Inspector
   - Claude Desktop
   - Codex などの MCP 対応クライアント

実 kintone 接続まで確認する場合は、追加で以下を用意する。

1. kintone の接続先 URL
2. 確認用アプリ ID
3. アプリの API トークン、またはユーザー認証情報
4. 複数環境比較を確認する場合は、prod / stg など複数 profile の接続情報

API トークンは、確認に必要な権限だけを付与する。
read-only 確認では、レコード閲覧とアプリ管理情報の閲覧に必要な権限を中心にする。

## 2. ローカルビルド

PowerShell:

```powershell
npm install
npm test -- --runInBand
npm run build:mcp
node .\dist-mcp\ksql-mcp.js --help
npm run mcp:smoke
```

期待結果:

1. `npm test` が通る
2. `dist-mcp/ksql-mcp.js` が生成される
3. `ksql-mcp --help` 相当のヘルプが表示される
4. API なし smoke test が成功する

パッケージ全体のビルドも確認する場合:

```powershell
npm run build
```

## 3. レコードAPIなし疎通確認

`ksql_validate`と、no-FROM SQLに対する`ksql_explain`はkintone APIを呼ばずに確認できる。物理アプリを参照する`ksql_explain`はv3.0.0以降、フォーム定義と必要時のプロセス状態metadataを取得するが、レコード取得・書込みは行わない。
MCPクライアント設定前の切り分けとして、Node.jsのMCP SDKクライアントからno-FROM SQLを直接呼び出す。

PowerShell:

```powershell
npm run build:mcp
npm run mcp:smoke
```

期待結果:

1. `ksql_validate`
2. `ksql_explain`
3. `ksql_query`
4. `ksql_describe_app`
5. `ksql_show_apps`

が tool 一覧に表示される。

`ksql_validate` の結果は `ok: true` になり、`ksql_explain` は `plan` 列を返す。
`ksql_query` は `SELECT 'ok' AS result` の no-FROM SELECT を API なしで実行する。

## 3.1 package smoke 確認

`ksql-mcp` は `dist-mcp/ksql-mcp.js` に完全 bundle して配布する。
そのため、npm 利用者環境では `@modelcontextprotocol/sdk` と `zod` を runtime dependency としてインストールしない。

PowerShell:

```powershell
npm run mcp:pack-smoke
```

確認内容:

1. `npm pack --json` で tarball を作る
2. `.tmp/` 配下の一時環境に `npm install --omit=dev` する
3. 一時環境に `@modelcontextprotocol/sdk` と `zod` が入らないことを確認する
4. pack 済み `dist-mcp/ksql-mcp.js --help` が成功する
5. manual JSON-RPC で `ksql_validate` が成功する

API なしの確認をまとめて実行する場合:

```powershell
npm run mcp:verify
```

## 4. kintone 接続設定

確認用に `ksql.config.json` を作る。
機密値は config に直書きせず、`env:` 参照にする。
サンプルは `docs/examples/ksql.mcp.config.sample.json` を使う。

例:

```json
{
  "version": 1,
  "defaultProfile": "dev",
  "profiles": {
    "dev": {
      "baseUrl": "https://example.cybozu.com",
      "auth": "token",
      "tokenMap": {
        "APP100": "env:KSQL_TOKEN_APP100"
      },
      "query": {
        "maxRecords": 500,
        "onLimit": "error",
        "timeout": 30000
      }
    },
    "stg": {
      "baseUrl": "https://example-stg.cybozu.com",
      "auth": "token",
      "tokenMap": {
        "APP100": "env:KSQL_STG_TOKEN_APP100"
      },
      "query": {
        "maxRecords": 500,
        "onLimit": "error",
        "timeout": 30000
      }
    }
  }
}
```

環境変数を設定する。

PowerShell:

```powershell
$env:KSQL_TOKEN_APP100 = "your-dev-app100-token"
$env:KSQL_STG_TOKEN_APP100 = "your-stg-app100-token"
```

macOS / Linux:

```bash
export KSQL_TOKEN_APP100="your-dev-app100-token"
export KSQL_STG_TOKEN_APP100="your-stg-app100-token"
```

起動確認:

```powershell
node .\dist-mcp\ksql-mcp.js --config .\ksql.config.json --profile dev --help
```

## 4.1 実 kintone 接続 smoke 確認

実 kintone 環境への接続は、secrets が必要なため CI ではなく手動で確認する。
確認用 script は `ksql_describe_app` と小さな `ksql_query` を実行する。

PowerShell:

```powershell
npm run build:mcp
$env:KSQL_TOKEN_APP100 = "your-dev-app100-token"
npm run mcp:kintone-smoke -- --config .\ksql.config.json --profile dev --app 100
```

確認内容:

1. `ksql_describe_app` で APP100 のフィールド定義を取得できる
2. `ksql_query` で `SELECT $id FROM APP100@dev ORDER BY $id LIMIT 1` を実行できる
3. `maxRecords: 10` / `onLimit: error` で小さく安全に確認する

任意の SQL を使う場合:

```powershell
npm run mcp:kintone-smoke -- `
  --config .\ksql.config.json `
  --profile dev `
  --app 100 `
  --query "SELECT $id FROM APP100@dev ORDER BY $id LIMIT 3"
```

Claude Desktop と同じ Node 実体で確認する場合:

```powershell
npm run mcp:kintone-smoke -- `
  --node "C:\Program Files (x86)\Nodist\v-x64\24.14.0\node.exe" `
  --config .\ksql.config.json `
  --profile prod `
  --app 100
```

`ksql_show_apps` も確認する場合:

```powershell
npm run mcp:kintone-smoke -- --config .\ksql.config.json --profile dev --app 100 --include-show-apps
```

`ksql_show_apps` は `/apps.json` を使うため、認証方式や token 設定によっては失敗することがある。
API token の `tokenMap` だけで確認している場合は、まず `ksql_describe_app` と `ksql_query` の成功を接続確認の基準にする。

## 5. MCP クライアント設定

### 5.0 Claude Desktop / Windows の注意

Windows の Claude Desktop では、`command` に `node` や Node version manager の shim を指定しない。
stdio MCP サーバーでは stdout が JSON-RPC 専用であり、shim が通常テキストを stdout に出すと Claude Desktop が JSON parse に失敗する。

特に Nodist を使っている場合、以下は避ける。

```json
{
  "command": "node"
}
```

```json
{
  "command": "C:\\Program Files (x86)\\Nodist\\bin\\node.exe"
}
```

代わりに、Node 本体の `node.exe` を絶対パスで指定する。

Nodist の例:

```json
{
  "command": "C:\\Program Files (x86)\\Nodist\\v-x64\\24.14.0\\node.exe"
}
```

通常の Node.js installer の例:

```json
{
  "command": "C:\\Program Files\\nodejs\\node.exe"
}
```

Claude Desktop のログに次のようなエラーが出る場合は、ほぼ stdout に JSON-RPC 以外の文字列が出ている。

```text
Unexpected token 'P', "Please set"... is not valid JSON
```

この場合は `command` を shim ではなく実体 Node に変更し、Claude Desktop を完全終了して再起動する。
タスクトレイに残っている場合も終了する。

手動確認:

```powershell
@'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"manual","version":"0.0.1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
'@ | & "C:\Program Files (x86)\Nodist\v-x64\24.14.0\node.exe" "C:\Users\rex02\Projects\kintone-sql-tools\dist-mcp\ksql-mcp.js" --config "C:\Users\rex02\Projects\kintone-sql-tools\ksql.config.json" --profile prod
```

`tools` の JSON が返れば、MCP サーバー本体は正常に起動できている。

### 5.1 ローカルビルドを使う場合

MCP クライアントの server 設定に、生成済みの `dist-mcp/ksql-mcp.js` を指定する。
サンプルは `docs/examples/mcp-client.sample.json` に置いている。

例:

```json
{
  "mcpServers": {
    "ksql": {
      "command": "C:\\Program Files (x86)\\Nodist\\v-x64\\24.14.0\\node.exe",
      "args": [
        "C:\\Users\\rex02\\Projects\\kintone-sql-tools\\dist-mcp\\ksql-mcp.js",
        "--config",
        "C:\\Users\\rex02\\Projects\\kintone-sql-tools\\ksql.config.json",
        "--profile",
        "dev"
      ],
      "env": {
        "KSQL_TOKEN_APP100": "your-dev-app100-token",
        "KSQL_STG_TOKEN_APP100": "your-stg-app100-token"
      }
    }
  }
}
```

`command` と `args` は、MCP クライアントから見える絶対パスで指定する。
Windows の JSON では `\` を `\\` にエスケープする。
Claude Desktop on Windows では `command` に `node` や Nodist shim を指定せず、実体の `node.exe` を指定する。

保存 SQL を使う場合は、`ksql.config.json` に保存先を明示する。
相対パスは `ksql.config.json` のあるディレクトリ基準で解決されるため、Claude Desktop の作業ディレクトリが `C:\WINDOWS\system32` でも system32 配下には保存されない。

```json
{
  "mcp": {
    "savedQueries": {
      "path": ".ksql/queries.json"
    }
  }
}
```

### 5.2 npm package を使う場合

公開済み package から確認する場合は、以下のように `npx --package` で `ksql-mcp` bin を起動できる。

```json
{
  "mcpServers": {
    "ksql": {
      "command": "npx",
      "args": [
        "-y",
        "--package",
        "@rex0220/kintone-sql-tools",
        "ksql-mcp",
        "--config",
        "C:\\path\\to\\ksql.config.json",
        "--profile",
        "dev"
      ],
      "env": {
        "KSQL_TOKEN_APP100": "your-dev-app100-token"
      }
    }
  }
}
```

ローカル実装の確認では、まず `node dist-mcp/ksql-mcp.js` を使う。
npm package 経由の確認は、publish 後の利用者向け動作確認として行う。

## 6. MCP Inspector で確認する場合

MCP Inspector を使う場合の起動例:

```powershell
npx -y @modelcontextprotocol/inspector node .\dist-mcp\ksql-mcp.js --config .\ksql.config.json --profile dev
```

Inspector の画面で確認すること:

1. tools 一覧に `ksql_validate` / `ksql_explain` / `ksql_query` / `ksql_describe_app` / `ksql_show_apps` が表示される
2. `ksql_validate` が API なしで成功する
3. `ksql_explain`がno-FROM SQLではAPIなしで成功し、物理アプリ参照時はmetadataだけを取得して成功する
4. `ksql_query` が実 kintone 環境に対して成功する
5. 手動接続確認では `npm run mcp:kintone-smoke -- --config ... --profile ... --app ...` を使う

## 7. 確認用プロンプト

MCP クライアントから以下を順番に実行する。

### 7.1 SQL 検証

```text
ksql_validate で次の SQL を検証してください。

SELECT 'ok' AS result
```

期待結果:

1. `ok: true`
2. `statementType: "SELECT"`
3. `isReadOnly: true`

### 7.2 EXPLAIN

```text
ksql_explain で次の SQL の実行計画を確認してください。

SELECT 'ok' AS result
```

期待結果:

1. `ok: true`
2. `columns` に `plan` が含まれる
3. kintone API 接続情報がなくても成功する

### 7.3 アプリ定義確認

```text
ksql_describe_app で APP100 のフィールド定義を確認してください。
profile は dev を使ってください。
```

期待結果:

1. APP100 のフィールド定義が返る
2. `AuthError` が出ない
3. token に対象アプリの閲覧権限がある

### 7.4 read-only クエリ

```text
ksql_query で次の SQL を実行してください。
profile は dev、maxRecords は 10、onLimit は error にしてください。

SELECT $id FROM APP100@dev ORDER BY $id LIMIT 3
```

期待結果:

1. `ok: true`
2. `rowCount` が 0 以上
3. 最大 3 行だけ返る

### 7.5 複数環境比較

prod / stg の両 profile に APP100 を設定してから確認する。

```text
ksql_query で prod と stg の APP100 を比較してください。
maxRecords は 50、onLimit は error にしてください。

SELECT
  p.$id AS prod_id,
  s.$id AS stg_id
FROM APP100@prod AS p
LEFT JOIN APP100@stg AS s
  ON p.$id = s.$id
ORDER BY p.$id
LIMIT 10
```

期待結果:

1. `APP100@prod` と `APP100@stg` が別 profile として解決される
2. 同一 APP ID でも環境別に routing される
3. `maxRecords` 超過時は `onLimit: error` で止まる

## 8. トラブルシュート

| 症状 | 確認点 |
| --- | --- |
| `dist-mcp/ksql-mcp.js` がない | `npm run build:mcp` を実行する |
| tools が表示されない | MCP クライアントを再起動し、`command` / `args` の絶対パスを確認する |
| `Unexpected token 'P', "Please set"... is not valid JSON` | `command` が Nodist shim などになっている。実体 Node (`Nodist\v-x64\<version>\node.exe` など) を指定する |
| Server disconnected immediately | stdout に JSON-RPC 以外が出ていないか確認する。MCP サーバーの通常ログは stderr に出す |
| `AuthError: --base-url is required` | `--config` のパス、`--profile`、`profiles.<name>.baseUrl` を確認する |
| `AuthError: token is missing` | `tokenMap` と環境変数名、対象 APP ID を確認する |
| `AuthError: token is not resolved` | SQL 内の APP ID と `tokenMap` の APP ID が一致しているか確認する |
| `ksql_show_apps` だけ失敗する | tokenMap 構成では `/apps.json` 用 token 解決が合わない場合がある。まず `ksql_describe_app` / `ksql_query` で接続確認する |
| `ParseError` | まず `ksql_validate` で SQL 構文を確認する |
| タイムアウトする | `profiles.<name>.query.timeout` または tool input の `timeout` を増やす |
| 取得件数で止まる | `maxRecords` と `onLimit` を確認する。初期確認では `maxRecords` を小さめにする |

## 9. セキュリティ確認

確認完了前に以下を確認する。

1. `ksql.config.json` に token や password を直書きしていない
2. `ksql.config.json` を commit 対象にしない
3. MCP クライアント設定に入れた env 値を共有しない
4. API token は確認に必要な最小権限にする
5. 複数環境比較では、本番 token と検証 token を取り違えていない

PowerShell の一時環境変数を消す例:

```powershell
Remove-Item Env:\KSQL_TOKEN_APP100 -ErrorAction SilentlyContinue
Remove-Item Env:\KSQL_STG_TOKEN_APP100 -ErrorAction SilentlyContinue
```

## 10. 完了条件

確認環境の構築完了条件:

1. `node dist-mcp/ksql-mcp.js --help` が成功する
2. MCP クライアントに 11 個の tool が表示される
3. `ksql_validate` が API なしで成功する
4. `ksql_explain`がno-FROM SQLではAPIなしで成功し、物理アプリ参照時はmetadataだけを取得して成功する
5. `mcp:kintone-smoke` で `ksql_describe_app` と `ksql_query` が実 kintone 環境で成功する
6. `APP100@prod` / `APP100@stg` のような複数 profile 指定が期待どおり動く
7. token や password をリポジトリに保存していない
