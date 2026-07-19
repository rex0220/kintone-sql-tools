# kintone を SQL ライクに扱える `kintone-sql-tools` を作ったので紹介します

## はじめに

kintone のデータ確認や抽出をするとき、
「一覧を作るほどではないけど、条件を少し指定して取りたい」
という場面は多いと思います。

`kintone-sql-tools` は、kintone アプリを SQL 風の構文で扱えるツールセットです。

- CLI（`ksql`）
- kintone プラグイン（UI）

の 2 つを用意していて、用途に応じて使い分けできます。

## できること

主な対応機能は次のとおりです。

- `SELECT`（JOIN / GROUP BY / HAVING / CTE / UNION）
- `EXPLAIN`
- `INSERT` / `UPDATE` / `UPSERT` / `DELETE`（`--allow-dml` 必須）
- サブテーブル仮想テーブル（`APP100$明細`）
- CLI 拡張 `APP@profile`（環境切替）

## 前提条件

- Node.js 18 以上（CLI 利用時）
- kintone 環境と対象アプリ
- API トークン（CLI で token 認証を使う場合）

## CLI のインストール

```bash
npm install -g @rex0220/kintone-sql-tools
ksql --help
```

## kintone プラグイン（UI）の場所

プラグイン版はリポジトリの `release` フォルダに配置しています。

- `release/ksql-plugin-v1.0.0.zip`（kintone へアップロードするプラグイン本体）
- `release/ksql-app-template-v1.11.0.zip`（ksql プラグインの専用アプリテンプレート）
- `release/README.txt`（同梱物の説明）

初回セットアップは次の流れです。

1. kintone のプラグイン画面で `ksql-plugin-*.zip` を読み込む
2. `ksql-app-template-*.zip` を読み込んで専用アプリを作成する
3. 専用アプリはプラグイン設定済みテンプレートのため、作成後の追加設定は不要

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

## 使い分け（CLI / Plugin）

CLI が向いているケース:

- バッチ処理
- CI/CD 連携
- `APP@profile` を使った環境切替
- `EXPLAIN` や `--dry-run` を使った事前確認

Plugin が向いているケース:

- kintone 画面内で対話的に操作したい
- 非エンジニア向け運用
- UI で結果を確認しながら使いたい

## ハマりどころ

- `FROM` ありクエリでは `APPxxx` 指定が必要
- `tokenMap` は APP ごとに設定が必要
- `unknown field code` が出たらフィールドコード名を確認
- `DELETE` の `@profile` は現時点で未対応

## まとめ

`kintone-sql-tools` は、kintone データ操作を「GUI 一覧作成より軽く、スクリプトより読みやすく」するための選択肢です。

最初は次の順で試すのがおすすめです。

1. `SELECT 'hello ksql' AS msg`（式 SELECT で基本動作を確認）
2. 1 アプリ SELECT
3. JOIN / エクスポート
4. `APP@profile` / DML

---

リポジトリ:

- https://github.com/rex0220/kintone-sql-tools
