kintone を SQL ライクに扱える `kintone-sql-tools` を作成したので紹介します

リポジトリ:

- https://github.com/rex0220/kintone-sql-tools

関連記事

- [rex0220 kSQL プラグイン](https://qiita.com/rex0220/items/ed9e101cb28b0ed40869)
- [rex0220 kSQL 言語リファレンス](https://qiita.com/rex0220/items/e089fddf4229d74be699)
- [rex0220 kSQL 実行フロー解説](https://qiita.com/rex0220/items/3fe51339158f7a5b2766)
- [rex0220 kSQL CLI コード解説](https://qiita.com/rex0220/items/8e14efe120d55e090668)
- [rex0220 kSQL MCP サーバー仕様](https://qiita.com/rex0220/items/b604519f03ad1494f8be)

## はじめに

kintone のデータ確認や抽出をするとき、
「一覧を作るほどではないけど、条件を少し指定して取りたい」
という場面は多いと思います。

`kintone-sql-tools` は、kintone アプリを SQL 風の構文で扱えるツールセットです。

- CLI（`ksql`）
- kintone プラグイン（UI）
- MCP サーバー（Claude Desktop / Claude Code など）

の 3 つを用意していて、用途に応じて使い分けできます。

## できること

主な対応機能は次のとおりです。

- `SELECT`（JOIN / GROUP BY / HAVING / CTE / UNION）
- `EXPLAIN`
- `INSERT` / `UPDATE` / `UPSERT` / `DELETE`（`--allow-dml` 必須）
- サブテーブル仮想テーブル（`APP100$明細`）
- CLI 拡張 `APP@profile`（環境切替）
- MCP サーバーからの自然言語 SQL 実行
- 保存 SQL カタログ（MCP）

## 前提条件

- Node.js 18 以上（CLI 利用時）
- kintone 環境と対象アプリ
- API トークン（CLI で token 認証を使う場合）
- Claude Desktop などの MCP クライアント（MCP 利用時）

## CLI のインストール

```bash
npm install -g @rex0220/kintone-sql-tools
ksql --help
```

## kintone プラグイン（UI）の場所

プラグイン版はリポジトリの `release` フォルダに配置しています。

- `release/ksql-plugin-v3.4.0.zip`（kintone へアップロードするプラグイン本体）
- `release/ksql-app-template-v1.11.0.zip`（ksql プラグインの専用アプリテンプレート）
- `release/README.txt`（同梱物の説明）

初回セットアップは次の流れです。

1. kintone のプラグイン画面で `ksql-plugin-*.zip` を読み込む
2. `ksql-app-template-*.zip` を読み込んで専用アプリを作成する
3. 専用アプリはプラグイン設定済みテンプレートのため、作成後の追加設定は不要

## MCP サーバーとして使う

`kintone-sql-tools` は MCP サーバーとしても利用できます。

Claude Desktop や Claude Code などの MCP クライアントから、自然言語で SQL を作成・検証・実行できます。

例:

```text
APP100 のステータス別件数を kSQL で集計して
```

```text
APP100@prod と APP100@stg の金額差分を比較して
```

MCP 版では、AI が直接 kintone API を組み立てるのではなく、`ksql_validate` / `ksql_explain` / `ksql_query` などの tool を通して kSQL を実行します。
そのため、集計や複数アプリ JOIN、複数環境比較のような処理を SQL として明示しやすくなります。

### MCPB 形式で Claude Desktop にインストール

Claude Desktop では `.mcpb` 形式の拡張機能としてインストールできます。

```bash
npm install
npm run mcpb:verify
```

生成されるファイル:

```text
dist-mcpb/ksql-mcp.mcpb
```

Claude Desktop の拡張機能画面から `ksql-mcp.mcpb` をインストールし、設定画面で `ksql.config.json` の絶対パスを指定します。

Windows では例として次のようなパスを指定します。

```text
C:\Users\rex02\Projects\kintone-sql-tools\ksql.config.json
```

API トークンは `.mcpb` に含めず、`ksql.config.json` から `env:` 参照する運用を推奨します。

```json
{
  "defaultProfile": "prod",
  "profiles": {
    "prod": {
      "baseUrl": "https://example.cybozu.com",
      "auth": "token",
      "tokenMap": {
        "APP100": "env:KSQL_TOKEN_APP100"
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

### 手動で MCP サーバーを起動する場合

MCPB を使わず、手動設定で起動する場合は `ksql-mcp` を使います。

```bash
npm run build:mcp
node ./dist-mcp/ksql-mcp.js --config ./ksql.config.json --profile prod
```

Claude Desktop on Windows で手動設定する場合は、`node` や Node version manager の shim ではなく、実体の `node.exe` を指定するのが安全です。
stdio MCP サーバーでは stdout が JSON-RPC 専用のため、shim が通常テキストを stdout に出すと接続エラーになります。

### MCP tools

主な tool は次のとおりです。

| Tool | 用途 |
| --- | --- |
| `ksql_validate` | SQL を解析し、実行前に構文や DML 判定を確認 |
| `ksql_explain` | フォーム定義と必要時のプロセス状態metadataを使って実行計画を確認（レコード取得・書込みなし） |
| `ksql_query` | SELECT / EXPLAIN / SHOW / DESCRIBE など read-only SQL を実行 |
| `ksql_mutate` | 明示承認付きで INSERT / UPDATE / UPSERT / DELETE を実行 |
| `ksql_describe_app` | アプリのフィールド定義を取得 |
| `ksql_show_apps` | アプリ一覧を取得 |
| `ksql_save_query` | SQL を保存 |
| `ksql_list_queries` | 保存 SQL 一覧を取得 |
| `ksql_run_saved_query` | 保存 SQL を再実行 |

特に便利なのは、AI が作った SQL をその場で `ksql_validate` し、必要に応じて `ksql_explain` で確認してから `ksql_query` で実行できる点です。

## まずは 1 本実行（式 SELECT）

```bash
ksql --base-url https://example.cybozu.com -e "SELECT 'hello ksql' AS msg"
```

## profile 必須の補足（最小設定）

- CLI は起動時に `defaultProfile` を解決するため、profile には最低限 `baseUrl` が必要です。
- 設定ファイルを使わない場合は、上のように `--base-url` を指定します。
- 設定ファイルを使う場合は、カレントディレクトリの `./ksql.config.json` に保存します。

最小構成の `ksql.config.json` 例:

```json
{
  "defaultProfile": "dev",
  "profiles": {
    "dev": {
      "baseUrl": "https://example.cybozu.com"
    }
  }
}
```

確認用（`user/pass`）の `ksql.config.json` 例:

```json
{
  "defaultProfile": "dev-userpass",
  "profiles": {
    "dev-userpass": {
      "baseUrl": "https://example.cybozu.com",
      "auth": "userpass",
      "username": "your-user",
      "password": "env:KSQL_PASSWORD"
    }
  }
}
```

```bash
export KSQL_PASSWORD='your-pass'
ksql -e "SELECT 'hello ksql' AS msg"
```

```powershell
$env:KSQL_PASSWORD = "your-pass"
ksql -e "SELECT 'hello ksql' AS msg"
```

## kintone 接続して実行（SELECT）

以下は bash の例です。

```bash
ksql \
  --base-url https://example.cybozu.com \
  --token YOUR_API_TOKEN \
  -e "SELECT * FROM APP100 LIMIT 5"
```

PowerShell の場合は 1 行で実行できます。

```powershell
ksql --base-url https://example.cybozu.com --token YOUR_API_TOKEN -e "SELECT * FROM APP100 LIMIT 5"
```

Console 接続例（`user/pass`）:

```bash
export KSQL_PASSWORD='your-password'
ksql --console --username your-username --password "$KSQL_PASSWORD" --base-url https://example.cybozu.com/
```

PowerShell 例（環境変数で password を渡す）:

```powershell
$env:KSQL_PASSWORD = "your-password"
ksql --console --username your-username --password $env:KSQL_PASSWORD --base-url https://example.cybozu.com/
```

少し実践的な例（JOIN）:

```sql
SELECT
  a.顧客No,
  a.会社名,
  b.案件No_ AS 案件No,
  b.案件名,
  b.商談フェーズ,
  b.売上
FROM APP4148 AS a
INNER JOIN APP4149 AS b
  ON a.顧客No = b.顧客No_
WHERE b.商談フェーズ IN ('提案中', '内示', '受注')
ORDER BY b.案件No_ DESC
LIMIT 50;
```

## `APP@profile` で環境を切り替える（CLI）

`APP@profile` を使うと、SQL 内で APP ごとに接続先プロファイルを指定できます。

```sql
SELECT * FROM APP4148@dev LIMIT 10;
SELECT * FROM APP4149@guest LIMIT 10;
```

`ksql.config.json` の例:

```json
{
  "defaultProfile": "dev",
  "profiles": {
    "dev": {
      "baseUrl": "https://example.cybozu.com",
      "auth": "token",
      "tokenMap": {
        "APP4148": "env:KSQL_TOKEN_DEV_4148"
      }
    },
    "guest": {
      "baseUrl": "https://example.cybozu.com",
      "guestSpaceId": 1,
      "auth": "token",
      "tokenMap": {
        "APP4149": "env:KSQL_TOKEN_GUEST_4149"
      }
    }
  }
}
```

## DML は安全ガード付きで実行

DML は明示的に有効化しないと実行されません。

```bash
ksql \
  --base-url https://example.cybozu.com \
  --token YOUR_API_TOKEN \
  --allow-dml \
  -e "UPDATE APP100 SET 状態 = '完了' WHERE ステータス = '未着手'"
```

必要に応じて `--dry-run` や `EXPLAIN` と組み合わせると、変更前確認がしやすいです。

## 出力形式

CLI は `table / json / jsonl / csv / markdown` 形式で出力できます。

```bash
ksql \
  --base-url https://example.cybozu.com \
  --token YOUR_API_TOKEN \
  --format csv \
  --output ./out/customers.csv \
  -e "SELECT * FROM APP4148 LIMIT 100"
```

## 使い分け（CLI / Plugin / MCP）

CLI が向いているケース:

- バッチ処理
- CI/CD 連携
- `APP@profile` を使った環境切替
- `EXPLAIN` や `--dry-run` を使った事前確認

Plugin が向いているケース:

- kintone 画面内で対話的に操作したい
- 非エンジニア向け運用
- UI で結果を確認しながら使いたい

MCP が向いているケース:

- 自然言語で SQL を作りながら探索したい
- 金額集計や複数アプリ JOIN を AI に手伝わせたい
- `APP@profile` で本番 / 検証環境を比較したい
- 作成した SQL を保存して再利用したい
- Claude Desktop など普段使っている AI クライアントから kintone を分析したい

## ハマりどころ

- `FROM` ありクエリでは `APPxxx` 指定が必要
- `tokenMap` は APP ごとに設定が必要
- `unknown field code` が出たらフィールドコード名を確認
- `DELETE` の `@profile` は現時点で未対応

## まとめ

最初は次の順で試すのがおすすめです。

1. `SELECT 'hello ksql' AS msg`（式 SELECT で基本動作を確認）
2. 1 アプリ SELECT
3. JOIN / エクスポート
4. `APP@profile` / DML
5. MCP で自然言語から SQL 作成・検証・実行

---
