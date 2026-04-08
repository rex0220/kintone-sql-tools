# kintone を SQL っぽく扱える `cli-ksql` を作ったので紹介します

## はじめに

kintone のデータ確認やエクスポートをするとき、  
「一覧で絞り込みを作るほどではないけど、ちょっと条件指定して取りたい」  
という場面がよくあります。

そこで、SQL ライクに kintone データを扱える CLI ツール `cli-ksql` を作りました。

- 1アプリ検索
- 2アプリ JOIN
- JSON/CSV エクスポート
- REPL（対話モード）
- `APP@profile` で環境切り替え

ができます。

## `cli-ksql` でできること

```sql
-- 文字列だけの最小実行（接続不要）
SELECT 'ABC' as a;
```

```sql
-- 1アプリ検索
SELECT 顧客No, 会社名, 顧客ランク
FROM APP4148
WHERE 顧客ランク IN ('A')
ORDER BY 顧客No DESC
LIMIT 20;
```

```sql
-- 2アプリ JOIN
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
ORDER BY b.案件No_ DESC
LIMIT 50;
```

## インストール

```bash
npm install
npm run build:cli
```

```bash
node dist-cli/ksql.js --help
```

## まずは 1 本動かす（認証なし）

```powershell
node .\dist-cli\ksql.js -e "SELECT 'ABC' as a;"
```

`FROM` なしの式クエリなので、接続設定なしで動作確認できます。

## 接続して実行（user/pass）

PowerShell では、パスワードを直書きせず環境変数に入れるのがおすすめです。

```powershell
$env:KSQL_PASSWORD = "your-pass"
node .\dist-cli\ksql.js `
  --base-url "https://example.cybozu.com" `
  --auth userpass `
  --username "your-user" `
  --password $env:KSQL_PASSWORD `
  -e "SELECT `$id, 顧客No, 会社名, 顧客ランク, 業種 FROM APP4148 WHERE 顧客ランク IN ('A') ORDER BY 顧客No DESC LIMIT 20;"
```

## SFA テンプレート（営業支援）での実例

今回は以下のアプリを使っています。

- `APP4148`: 顧客管理
- `APP4149`: 案件管理
- JOIN キー: `APP4148.顧客No = APP4149.顧客No_`

```powershell
node .\dist-cli\ksql.js `
  --base-url "https://example.cybozu.com" `
  --auth userpass `
  --username "your-user" `
  --password $env:KSQL_PASSWORD `
  -e "SELECT a.顧客No AS 顧客No, a.会社名, a.顧客ランク, b.案件No_ AS 案件No, b.案件名, b.商談フェーズ, b.売上 FROM APP4148 AS a INNER JOIN APP4149 AS b ON a.顧客No = b.顧客No_ WHERE b.商談フェーズ IN ('提案中', '内示', '受注') ORDER BY b.案件No_ DESC LIMIT 50;"
```

## `APP@profile` で環境を切り替える

`APP@profile` は「この APP はこの接続先で実行する」という指定です。

```sql
SELECT * FROM app4148@dev LIMIT 10;
SELECT * FROM APP4149@guest LIMIT 10;
```

### `profile` の定義例（`ksql.config.json`）

```json
{
  "defaultProfile": "dev",
  "profiles": {
    "dev": {
      "baseUrl": "https://example.cybozu.com",
      "auth": "userpass"
    },
    "guest": {
      "baseUrl": "https://example.cybozu.com",
      "guestSpaceId": 1,
      "auth": "userpass"
    }
  }
}
```

## エクスポート（JSON / CSV）

```powershell
node .\dist-cli\ksql.js `
  --base-url "https://example.cybozu.com" `
  --auth userpass `
  --username "your-user" `
  --password $env:KSQL_PASSWORD `
  --format json `
  --output ".\out\app4148_customers.json" `
  -e "SELECT * FROM APP4148 WHERE 顧客ランク IN ('A');"
```

```powershell
node .\dist-cli\ksql.js `
  --base-url "https://example.cybozu.com" `
  --auth userpass `
  --username "your-user" `
  --password $env:KSQL_PASSWORD `
  --format csv `
  --output ".\out\customers_opportunities_join.csv" `
  -e "SELECT a.顧客No AS 顧客No, a.会社名, b.案件No_ AS 案件No, b.案件名, b.商談フェーズ, b.売上 FROM APP4148 a JOIN APP4149 b ON a.顧客No = b.顧客No_;"
```

## REPL（対話モード）

```powershell
node .\dist-cli\ksql.js --console --base-url "https://example.cybozu.com" --auth userpass --username "your-user" --password $env:KSQL_PASSWORD
```

使えるコマンド例:

- `:history`
- `:rerun 1`
- `:save .\out\last_result.json`
- `:profile dev`

## ハマりどころ

- 選択系フィールド（例: ラジオボタン）は `=` ではなく `IN (...)` が必要な場合があります
- `APP@profile` の profile 名は config に定義済みである必要があります
- `DELETE` での `APP@profile` は未対応です

## まとめ

`cli-ksql` を使うと、kintone のデータ操作が「GUIの一覧作成」より軽くなります。

- まずは `SELECT 'ABC' as a;`
- 次に 1アプリ検索
- その後 JOIN / エクスポート

の順で試すとスムーズです。

---

必要なら次回、`EXPLAIN` の見方や DML（INSERT/UPDATE/UPSERT）編も書きます。
