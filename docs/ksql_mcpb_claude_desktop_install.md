# kSQL MCPB Claude Desktop インストール手順

この手順は、`ksql-mcp.mcpb` を Claude Desktop の拡張機能としてインストールし、`ksql.config.json` のパスだけを設定して `ksql-mcp` を利用するためのものです。

MCPB 版では、Claude Desktop の `claude_desktop_config.json` に `node.exe` や `dist-mcp/ksql-mcp.js` を手動設定しない。
Claude Desktop の拡張機能画面から `.mcpb` をインストールし、設定画面で `ksql.config.json` の絶対パスを指定する。

## 1. 前提

必要なもの:

1. Claude Desktop
2. このリポジトリの作業コピー
3. `ksql.config.json`
4. kintone 接続に使う環境変数

Windows では、Claude Desktop が参照できるユーザー環境変数またはシステム環境変数に API token を設定する。
PowerShell セッション内だけの `$env:KSQL_TOKEN_APP100 = "..."` は、Claude Desktop を通常起動した場合には反映されない。

例:

```powershell
[Environment]::SetEnvironmentVariable("KSQL_TOKEN_APP100", "your-api-token", "User")
```

設定後、Claude Desktop を完全終了してから再起動する。

## 2. ksql.config.json を準備

`ksql.config.json` は任意のユーザー書き込み可能な場所に置く。
Windows では Claude Desktop の作業ディレクトリが `C:\WINDOWS\system32` になることがあるため、MCPB の設定には必ず絶対パスを指定する。

例:

```text
C:\Users\rex02\Projects\kintone-sql-tools\ksql.config.json
```

保存 SQL カタログを使う場合は、`mcp.savedQueries.path` を設定しておく。
相対パスは `ksql.config.json` のあるディレクトリ基準で解決される。

例:

```json
{
  "version": 1,
  "defaultProfile": "prod",
  "profiles": {
    "prod": {
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
    }
  },
  "mcp": {
    "savedQueries": {
      "path": ".ksql/queries.json"
    }
  }
}
```

## 3. MCPB を作成

PowerShell:

```powershell
npm install
npm run mcpb:verify
```

成功すると次のファイルが生成される。

```text
dist-mcpb\ksql-mcp.mcpb
```

`mcpb:verify` は以下を確認する。

1. `dist-mcp/ksql-mcp.js` の生成
2. `dist-mcpb/ksql-mcp.mcpb` の生成
3. MCPB manifest の `configPath` 設定
4. MCPB 用 launcher の疎通確認

MCPB だけ作成する場合:

```powershell
npm run build:mcp
npm run build:mcpb
```

## 4. Claude Desktop にインストール

1. Claude Desktop を開く
2. `設定` を開く
3. `デスクトップアプリ` の `拡張機能` を開く
4. `拡張機能をインストール` または同等のボタンから `.mcpb` を選択する
5. 次のファイルを選ぶ

```text
C:\Users\rex02\Projects\kintone-sql-tools\dist-mcpb\ksql-mcp.mcpb
```

6. `ksql-mcp` が拡張機能一覧に追加されたことを確認する
7. `ksql.config.json` の入力欄に絶対パスを指定する

```text
C:\Users\rex02\Projects\kintone-sql-tools\ksql.config.json
```

8. `保存` を押す
9. 拡張機能を `有効` にする

インストール後に `ksql.config.json` を変更しただけなら、通常は拡張機能の再インストールは不要。
`.mcpb` を作り直した場合は、既存の `ksql-mcp` をアンインストールしてから新しい `.mcpb` をインストールする。

## 5. 動作確認

Claude Desktop のチャットで、次のように依頼する。

```text
kSQL MCP の ksql_validate で SELECT 'ok' AS result を検証して
```

期待する結果:

1. `ksql_validate` が呼ばれる
2. `ok: true` が返る
3. statement type が `SELECT` になる

kintone 接続まで確認する場合:

```text
kSQL MCP の ksql_query で SELECT $id FROM APP100@prod ORDER BY $id LIMIT 1 を実行して
```

`APP100` と `prod` は、自分の `ksql.config.json` に合わせて変更する。

## 6. ログ確認

接続できない場合は Claude Desktop のログを見る。

Windows:

```text
C:\Users\<ユーザー名>\AppData\Local\packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\logs
```

主に確認するファイル:

```text
mcp.log
mcp-server-kSQL MCP.log
main.log
```

PowerShell 例:

```powershell
Get-Content "$env:LOCALAPPDATA\packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\logs\mcp-server-kSQL MCP.log" -Tail 120
```

正常な場合、`initialize` に対して `Message from server` が出る。

```text
Message from client: {"method":"initialize", ...}
Message from server: {"jsonrpc":"2.0","id":0,"result": ...}
```

`Message from client` の後に `Message from server` が出ず、`Request timed out` になる場合は、MCPB の entry point または launcher が正しく動いていない可能性がある。
最新の `.mcpb` を再生成し、既存拡張機能をアンインストールしてから再インストールする。

## 7. よくあるエラー

### 拡張機能サーバーに接続できません

表示例:

```text
拡張機能サーバーに接続できません。拡張機能を無効にしてから再度有効にしてください。
```

確認すること:

1. `npm run mcpb:verify` が成功している
2. 古い `.mcpb` ではなく、再生成後の `dist-mcpb\ksql-mcp.mcpb` をインストールしている
3. 既存の `ksql-mcp` をアンインストールしてから再インストールしている
4. `ksql.config.json` が絶対パスで指定されている
5. `ksql.config.json` が存在し、JSON として正しい
6. `env:` 参照している環境変数が Claude Desktop 起動環境に設定されている

### Request timed out

ログ例:

```text
McpError: MCP error -32001: Request timed out
```

`initialize` 応答前にタイムアウトしている場合、MCPB 内の launcher が正しく起動していない可能性がある。
次を実行してから再インストールする。

```powershell
npm run mcpb:verify
```

### Unexpected token 'P', "Please set"... is not valid JSON

このエラーは、stdio の stdout に JSON-RPC 以外の文字列が出た場合に発生する。
手動 MCP 設定で Node version manager の shim を指定したときに起きやすい。

MCPB 版では Claude Desktop の built-in Node を使うため、通常この問題は避けられる。
手動 `claude_desktop_config.json` 設定と MCPB 版を同時に有効化している場合は、切り分けのため手動設定側を一時的に無効化する。

### 保存 SQL が C:\WINDOWS\system32 に保存されようとする

`ksql.config.json` に `mcp.savedQueries.path` を設定する。

例:

```json
{
  "mcp": {
    "savedQueries": {
      "path": ".ksql/queries.json"
    }
  }
}
```

この設定があれば、相対パスは `ksql.config.json` のあるディレクトリ基準で解決される。

## 8. 更新手順

`ksql-mcp` のコードを変更した場合:

1. MCPB を再生成する

```powershell
npm run mcpb:verify
```

2. Claude Desktop で既存の `ksql-mcp` 拡張機能をアンインストールする
3. 新しい `dist-mcpb\ksql-mcp.mcpb` をインストールする
4. `ksql.config.json` の絶対パスを再設定する
5. Claude Desktop を完全終了して再起動する

`ksql.config.json` だけを変更した場合:

1. `.mcpb` の再生成は不要
2. Claude Desktop の拡張機能設定で同じ `ksql.config.json` パスを保存し直す
3. 必要に応じて拡張機能を無効化して再度有効化する
