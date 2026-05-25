# kSQL MCPB configPath 指定型仕様

このドキュメントは、`ksql-mcp` を Claude Desktop 向け MCPB 形式で配布する場合の仕様をまとめる。

初期 MCPB は **configPath 指定型** とする。
ユーザーが MCPB の設定画面で指定する値は、原則として `ksql.config.json` のパスだけにする。

## 1. 目的

`ksql-mcp` はすでに stdio MCP サーバーとして動作する。
ただし Claude Desktop で手動設定する場合、以下の負担がある。

1. `claude_desktop_config.json` を直接編集する必要がある
2. Windows で `node.exe` の実体パスを指定する必要がある
3. Nodist shim などが stdout に文字列を出すと JSON-RPC が壊れる
4. `cwd` が `C:\WINDOWS\system32` になる場合がある

MCPB 化により、Claude Desktop へのインストール体験を kintone 標準 MCP サーバーに近づける。
ただし、`node.exe` の実体パス指定問題を MCPB でどこまで解消できるかは、Claude Desktop の MCPB 仕様が Node.js ランタイムをどのように提供するかに依存する。

## 2. スコープ

初期 MCPB で実現すること:

1. Claude Desktop に `.mcpb` としてインストールできる
2. `ksql-mcp` を bundle 済み Node.js MCP サーバーとして起動できる
3. ユーザー設定として `ksql.config.json` のパスを指定できる
4. 既存の `ksql.config.json` 設計をそのまま利用できる
5. 保存 SQL の保存先は `ksql.config.json` の `mcp.savedQueries.path` で管理できる

初期 MCPB でやらないこと:

1. profile / baseUrl / tokenMap を MCPB UI で個別入力する
2. kintone API token を MCPB 側に保存する
3. 保存 SQL カタログを MCPB package 内に保存する
4. 複数 config を MCPB 内で切り替える
5. MCPB 以外の MCP クライアント向け設定を置き換える

## 3. 基本方針

MCPB は「配布と起動設定の簡略化」に徹する。

`ksql.config.json` は引き続き kSQL の接続・profile・保存 SQL 設定の中心とする。

理由:

1. 既存 CLI / MCP の config 仕様を再利用できる
2. `APP@profile` / tokenMap / savedQueries などの複雑設定を MCPB manifest に移さずに済む
3. Claude Desktop 以外の MCP クライアントとも同じ config を共有できる
4. API token を MCPB package や manifest に含めない運用にできる

## 4. ユーザー設定

MCPB の user config は、初期実装では `configPath` のみとする。
MCPB manifest では file picker として定義する。

| 項目 | 必須 | 内容 |
| --- | --- | --- |
| `configPath` | 必須 | `ksql.config.json` の絶対パス |

例:

```text
C:\Users\rex02\Projects\kintone-sql-tools\ksql.config.json
```

相対パスは受け付けない。
Claude Desktop では作業ディレクトリが安定しないため、`configPath` は絶対パス必須とする。

## 5. `ksql.config.json` の責務

`ksql.config.json` には以下を定義する。

1. `defaultProfile`
2. `profiles`
3. `baseUrl`
4. `auth`
5. `tokenMap`
6. `query` 既定値
7. `mcp.savedQueries.path`

例:

```json
{
  "defaultProfile": "prod",
  "mcp": {
    "savedQueries": {
      "path": ".ksql/queries.json"
    }
  },
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
  }
}
```

API token は config に直書きせず、`env:` 参照を推奨する。

## 6. 環境変数の扱い

初期 MCPB では、環境変数は既存 `ksql.config.json` の `env:` 参照で使う。

例:

```json
{
  "tokenMap": {
    "APP100": "env:KSQL_TOKEN_APP100"
  }
}
```

ただし、MCPB UI で token を入力させることは初期スコープ外とする。
Windows では、Claude Desktop が継承できるユーザー環境変数またはシステム環境変数に token を設定する必要がある。
PowerShell セッション内だけの `$env:KSQL_TOKEN_APP100 = "..."` や `.env` ファイルは、Claude Desktop 再起動後の MCPB 実行環境には通常反映されない。

運用案:

1. まずはユーザー環境変数に token を設定する
2. 必要なら次フェーズで MCPB user config に token 入力を追加する
3. token 入力を追加する場合も、profile / tokenMap の複雑な UI 化は別途設計する

## 7. 保存 SQL の保存先

保存 SQL は MCPB package 内に保存しない。

保存先は `ksql.config.json` の `mcp.savedQueries.path` で指定する。

```json
{
  "mcp": {
    "savedQueries": {
      "path": ".ksql/queries.json"
    }
  }
}
```

`mcp.savedQueries.path` の相対パスは、`configPath` で指定した `ksql.config.json` のディレクトリ基準で解決する。

例:

```text
configPath:
C:\Users\rex02\Projects\kintone-sql-tools\ksql.config.json

mcp.savedQueries.path:
.ksql/queries.json

保存先:
C:\Users\rex02\Projects\kintone-sql-tools\.ksql\queries.json
```

これにより、Claude Desktop の `cwd` が `C:\WINDOWS\system32` でも system32 配下に保存しない。

## 8. MCPB package 構成

想定する `.mcpb` の中身:

```text
ksql-mcp.mcpb
  manifest.json
  server/
    ksql-mcp.js
  README.md
  LICENSE
```

`server/ksql-mcp.js` は `build:mcp` で生成した `dist-mcp/ksql-mcp.js` を利用する。

## 8.1 Node.js ランタイムの扱い

MCPB 版 `ksql-mcp` は Node.js で動作する。
Node.js ランタイムの調達方法は、Claude Desktop の MCPB 仕様に依存する未確定事項として扱う。

想定される方式:

| 方式 | メリット | デメリット |
| --- | --- | --- |
| Claude Desktop が提供する Node.js を使う | ユーザー側の Node.js 準備が不要 | Claude Desktop が Node.js 実行を提供する前提が必要 |
| ユーザー環境の Node.js を使う | 実装が単純 | `node.exe` 実体パス問題・shim 問題が残る |
| Node.js を `.mcpb` に同梱する | 自己完結しやすい | bundle size が大きくなる |

初期仕様では、manifest の実行方式を Claude Desktop の MCPB 仕様に合わせて最終決定する。
もしユーザー環境の Node.js を使う仕様であれば、§1 の「node.exe の実体パス指定を減らす」という目的は限定的になるため、導入手順で別途明記する。

## 9. manifest 方針

`manifest.json` は以下の責務を持つ。

1. Claude Desktop に extension 情報を提供する
2. MCP サーバーの起動コマンドを定義する
3. user config として `configPath` を受け取る
4. `configPath` を `ksql-mcp --config` に渡す

概念例:

```json
{
  "manifest_version": "0.3",
  "name": "ksql-mcp",
  "display_name": "kSQL MCP",
  "version": "<package.json version>",
  "description": "Run kSQL against kintone apps through MCP.",
  "author": {
    "name": "rex0220"
  },
  "server": {
    "type": "node",
    "entry_point": "server/index.js",
    "mcp_config": {
      "command": "node",
      "args": [
        "${__dirname}/server/index.js",
        "--config",
        "${user_config.configPath}"
      ],
      "env": {}
    }
  },
  "user_config": {
    "configPath": {
      "type": "file",
      "title": "ksql.config.json path",
      "description": "Absolute path to ksql.config.json",
      "required": true
    }
  }
}
```

実装では MCPB manifest spec `0.3` に合わせる。

## 10. 起動時 validation

MCPB 版 `ksql-mcp` は起動時に以下を確認する。

1. `configPath` が指定されている
2. `configPath` が絶対パスである
3. `configPath` のファイルが存在する
4. config JSON が parse できる

エラー時は stderr に出力し、stdout には JSON-RPC 以外を書かない。

理由:

MCP stdio transport では stdout が JSON-RPC 専用である。
通常テキストを stdout に出すと Claude Desktop が JSON parse に失敗する。

## 11. 既存 `ksql-mcp` との関係

MCPB 版は既存 `ksql-mcp` の別配布形態とする。
MCP tool の仕様は同じ。

MCPB でも提供する tools:

```text
ksql_validate
ksql_explain
ksql_query
ksql_mutate
ksql_describe_app
ksql_show_apps
ksql_save_query
ksql_list_queries
ksql_get_query
ksql_run_saved_query
ksql_delete_query
```

## 12. build 手順案

追加する npm scripts:

```json
{
  "build:mcpb": "node build-mcpb.mjs",
  "mcpb:verify": "npm run build:mcp && npm run build:mcpb && node scripts/mcpb-verify.mjs"
}
```

`build-mcpb.mjs` の責務:

1. `npm run build:mcp` 済みの `dist-mcp/ksql-mcp.js` を確認する
2. `package.json` の `version` を manifest に埋め込む
3. `manifest.json` を生成する
4. `dist-mcpb/` が `.gitignore` に含まれていることを確認する
5. package 公開物に含める場合は `package.json` の `files` に `dist-mcpb/` を追加する
6. `dist-mcp/ksql-mcp.js` を `server/ksql-mcp.js` として配置する
7. `server/index.js` に MCPB 用 launcher を生成し、`main()` を無条件で呼び出す
8. `README.md` / `LICENSE` を含める
9. zip 形式で `dist-mcpb/ksql-mcp.mcpb` を作成する

MCPB の Node 実行環境では Claude Desktop が built-in Node / UtilityProcess で entry point を扱う場合がある。
そのため `require.main === module` に依存せず、MCPB 用 launcher から明示的に `main()` を呼び出す。

`build-mcpb.mjs` は外部 MCPB CLI に依存せず、Node.js 標準 API で zip を生成する。
将来 `@anthropic-ai/mcpb` CLI を使う場合は、生成 manifest の schema 差分を確認してから置き換える。

## 13. 検証手順案

最低限の検証:

1. `npm run build:mcp`
2. `npm run build:mcpb`
3. `npm run mcpb:verify`
4. `.mcpb` を Claude Desktop にインストール
5. `configPath` に `ksql.config.json` の絶対パスを設定
6. `ksql_validate` が成功する
7. `ksql_explain` が成功する
8. `ksql_list_queries` が成功する
9. 実 kintone 環境で `ksql_query` が成功する

Windows で確認すること:

1. `configPath` に `C:\...` の絶対パスを指定できる
2. `cwd` が system32 でも保存 SQL が config file 基準に保存される
3. stdout に JSON-RPC 以外の文字列が出ない

## 14. 将来拡張

configPath 指定型が安定した後に検討する。

1. `profile` を MCPB user config で選択可能にする
2. `savedQueriesPath` を MCPB user config で override 可能にする
3. 単一 app / 単一 token 用の簡易設定 UI を追加する
4. tokenMap を MCPB UI で管理する
5. 複数 config の切り替えをサポートする

ただし、複雑な profile / tokenMap 管理は `ksql.config.json` に残す方針を優先する。

## 15. 採用判断

configPath 指定型 MCPB は採用する価値が高い。

理由:

1. 実装差分が小さい
2. 既存 `ksql.config.json` と互換性が高い
3. Claude Desktop の手動 JSON 設定を減らせる
4. Windows の Node shim 問題を避けやすい（Claude Desktop が Node.js を提供する場合）
5. kintone 標準 MCP サーバーに近い導入体験にできる

初期実装では、configPath 指定型に限定して進める。
