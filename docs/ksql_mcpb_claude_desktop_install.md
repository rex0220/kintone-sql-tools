# kSQL MCPB Claude Desktop インストール手順

この手順は、一般ユーザー向けに `ksql-mcp.mcpb` を GitHub からダウンロードし、Claude Desktop の拡張機能として利用する方法をまとめたものです。

MCPB 版では、`claude_desktop_config.json` を直接編集しない。
Claude Desktop の拡張機能画面から `.mcpb` をインストールし、設定画面で `ksql.config.json` の絶対パスだけを指定する。

## 1. 用意するもの

必要なもの:

1. Claude Desktop
2. GitHub からダウンロードした `ksql-mcp.mcpb`
3. `ksql.config.json`
4. kintone 接続用の API トークン

Node.js や npm は通常不要。
MCPB 版は Claude Desktop 側の Node.js 実行環境で起動する。

## 2. ksql-mcp.mcpb をダウンロード

GitHub Releases から最新版をダウンロードする。

```text
https://github.com/rex0220/kintone-sql-tools/releases
```

ダウンロードするファイル:

```text
ksql-mcp.mcpb
```

任意の場所に保存する。

例:

```text
C:\Users\<ユーザー名>\Downloads\ksql-mcp.mcpb
```

リポジトリを clone したり、`npm install` を実行したりする必要はない。

## 3. ksql.config.json を作成

`ksql.config.json` は、kintone の接続先や API トークンの参照方法を定義する設定ファイル。
ユーザーが書き込みできる任意のフォルダに作成する。

例:

```text
C:\Users\<ユーザー名>\Documents\ksql\ksql.config.json
```

最小例:

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

変更する箇所:

| 項目 | 内容 |
| --- | --- |
| `baseUrl` | 自分の kintone URL |
| `APP100` | 接続したいアプリ ID |
| `KSQL_TOKEN_APP100` | API トークンを入れる環境変数名 |
| `defaultProfile` | 通常使う接続先名 |

複数アプリを使う場合は `tokenMap` に追加する。

```json
{
  "tokenMap": {
    "APP100": "env:KSQL_TOKEN_APP100",
    "APP101": "env:KSQL_TOKEN_APP101"
  }
}
```

保存 SQL を使う場合、`mcp.savedQueries.path` を設定しておく。
相対パスは `ksql.config.json` のあるフォルダ基準で解決される。

上の例では、保存先は次のようになる。

```text
C:\Users\<ユーザー名>\Documents\ksql\.ksql\queries.json
```

## 4. API トークンを環境変数に設定

`ksql.config.json` の `env:KSQL_TOKEN_APP100` は、Windows のユーザー環境変数 `KSQL_TOKEN_APP100` を参照する。

PowerShell で設定する例:

```powershell
[Environment]::SetEnvironmentVariable("KSQL_TOKEN_APP100", "your-api-token", "User")
```

複数アプリの場合:

```powershell
[Environment]::SetEnvironmentVariable("KSQL_TOKEN_APP100", "your-app100-token", "User")
[Environment]::SetEnvironmentVariable("KSQL_TOKEN_APP101", "your-app101-token", "User")
```

設定後、Claude Desktop を完全終了してから再起動する。

注意:

- PowerShell で `$env:KSQL_TOKEN_APP100 = "..."` と設定しただけでは、Claude Desktop には通常反映されない
- `.env` ファイルは Claude Desktop から自動では読み込まれない
- API トークンは `.mcpb` や `ksql.config.json` に直書きしない運用を推奨

API トークンには、実行したい操作に必要な権限を付与する。
SELECT だけならレコード閲覧権限を中心にする。
UPDATE / INSERT / DELETE を使う場合は、変更系の権限が必要になる。

## 5. Claude Desktop にインストール

1. Claude Desktop を開く
2. `設定` を開く
3. `デスクトップアプリ` の `拡張機能` を開く
4. `拡張機能をインストール` または同等のボタンを押す
5. ダウンロードした `ksql-mcp.mcpb` を選択する
6. `ksql-mcp` が拡張機能一覧に追加されたことを確認する

## 6. ksql.config.json のパスを設定

拡張機能 `ksql-mcp` の設定画面で、`ksql.config.json` の絶対パスを指定する。

例:

```text
C:\Users\<ユーザー名>\Documents\ksql\ksql.config.json
```

その後、`保存` を押して、拡張機能を `有効` にする。

重要:

- 相対パスではなく絶対パスを指定する
- `C:\WINDOWS\system32` 配下には設定ファイルや保存 SQL を置かない
- パスを変更した場合は、設定画面で保存し直す

## 7. 動作確認

Claude Desktop のチャットで、まず API を呼ばない確認を行う。

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

集計の例:

```text
APP100@prod のステータス別件数を kSQL で集計して
```

複数環境比較の例:

```text
APP100@prod と APP100@stg を顧客コードで突き合わせて、金額が違うレコードを抽出して
```

## 8. 保存 SQL を使う場合

SQL を保存したい場合は、Claude Desktop で次のように依頼する。

```text
このSQLを monthly_sales という名前で保存して
```

保存先は `ksql.config.json` の `mcp.savedQueries.path` で決まる。

保存 SQL を一覧する例:

```text
kSQL MCP の保存 SQL 一覧を表示して
```

保存 SQL を実行する例:

```text
保存 SQL monthly_sales を実行して
```

## 9. 更新手順

新しいバージョンの `ksql-mcp.mcpb` に更新する場合:

1. GitHub Releases から新しい `ksql-mcp.mcpb` をダウンロードする
2. Claude Desktop の拡張機能画面で既存の `ksql-mcp` をアンインストールする
3. 新しい `ksql-mcp.mcpb` をインストールする
4. `ksql.config.json` の絶対パスを再設定する
5. Claude Desktop を完全終了して再起動する

`ksql.config.json` だけを変更した場合:

1. `.mcpb` の再ダウンロードは不要
2. Claude Desktop の拡張機能設定で同じ `ksql.config.json` パスを保存し直す
3. 必要に応じて拡張機能を無効化して再度有効化する

## 10. ログ確認

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

`Message from client` の後に `Message from server` が出ず、`Request timed out` になる場合は、古い `.mcpb` を使っている可能性がある。
GitHub Releases から最新版をダウンロードし直し、既存拡張機能をアンインストールしてから再インストールする。

## 11. よくあるエラー

### 拡張機能サーバーに接続できません

表示例:

```text
拡張機能サーバーに接続できません。拡張機能を無効にしてから再度有効にしてください。
```

確認すること:

1. GitHub Releases からダウンロードした最新の `ksql-mcp.mcpb` を使っている
2. 既存の `ksql-mcp` をアンインストールしてから再インストールしている
3. `ksql.config.json` が絶対パスで指定されている
4. `ksql.config.json` が存在し、JSON として正しい
5. `env:` 参照している環境変数が Windows のユーザー環境変数またはシステム環境変数に設定されている
6. 環境変数の設定後に Claude Desktop を完全再起動している

### Request timed out

ログ例:

```text
McpError: MCP error -32001: Request timed out
```

古い `.mcpb` では、MCPB の起動方式によって initialize 応答が返らずタイムアウトする場合がある。
最新版をダウンロードして再インストールする。

### AuthError

認証エラーが出る場合は、以下を確認する。

1. `baseUrl` が正しい
2. `tokenMap` の `APPxxx` が実際のアプリ ID と一致している
3. 環境変数名が `ksql.config.json` と一致している
4. API トークンに必要な権限がある
5. Claude Desktop を再起動済み

### unknown field code

SQL に指定したフィールドコードが kintone 側と一致していない。
kintone のフォーム設定でフィールドコードを確認する。

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

この設定があれば、相対パスは `ksql.config.json` のあるフォルダ基準で解決される。

## 12. 開発者向け: 自分で MCPB を作成する場合

ソースコードから自分で `.mcpb` を作成する場合のみ、Node.js と npm が必要。

```powershell
git clone https://github.com/rex0220/kintone-sql-tools.git
cd kintone-sql-tools
npm install
npm run mcpb:verify
```

生成されるファイル:

```text
dist-mcpb\ksql-mcp.mcpb
```

通常の利用者はこの手順を実行する必要はない。
