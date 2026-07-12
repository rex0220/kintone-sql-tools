# kSQL CLI チュートリアル

このチュートリアルでは、kSQL CLI で「まず1本動かす」ところから、2アプリ JOIN とエクスポートまでを短時間で体験します。

## 1. チュートリアルの目的

- kSQL CLI をインストールして実行できるようにする
- `SELECT 'ABC' as a;` で動作確認する
- アプリ1つの検索 SQL を実行する
- アプリ2つの JOIN SQL を実行する
- 結果をファイルにエクスポートする

## 2. 前提条件

- kintone 環境にアクセスできること
- 対象環境にログイン可能なユーザー名/パスワードがあること（6章以降の APP クエリで使用）
- Node.js / npm が使えること
- `sample-app` 配下の SFA（営業支援）パックアプリを利用すること

## 3. インストール

```bash
npm install
npm run build:cli
```

実行例:

```bash
node dist-cli/ksql.js --help
```

## 4. 接続設定（最小）

まずは API 呼び出しを行わないクエリで動作確認します（この段階では認証情報不要）。

```bash
node dist-cli/ksql.js -e "SELECT 'ABC' as a;"
```

Windows PowerShell 例:

```powershell
node .\dist-cli\ksql.js -e "SELECT 'ABC' as a;"
```

## 5. テーブル例（このチュートリアルで使う想定）

`APP4148`（顧客管理）

| フィールドコード | 型 | 例 |
|---|---|---|
| `$id` | レコードID | `1` |
| `顧客No` | レコード番号 | `1` |
| `会社名` | 文字列(1行) | `株式会社サンプル` |
| `顧客ランク` | ラジオボタン | `A` |
| `業種` | ドロップダウン | `製造業` |

`APP4149`（案件管理）

| フィールドコード | 型 | 例 |
|---|---|---|
| `$id` | レコードID | `10` |
| `案件No_` | レコード番号 | `10` |
| `顧客No_` | 数値 | `1` |
| `案件名` | 文字列(1行) | `見積案件A` |
| `商談フェーズ` | ドロップダウン | `提案中` |
| `売上` | 数値 | `240000` |

JOIN キー:
- `APP4148.顧客No = APP4149.顧客No_`

## 6. 基本クエリ（アプリ1つ）

```sql
SELECT
  $id,
  顧客No,
  会社名,
  顧客ランク,
  業種
FROM APP4148
WHERE 顧客ランク IN ('A')
ORDER BY 顧客No DESC
LIMIT 20;
```

実行例:

```bash
node dist-cli/ksql.js ^
  --base-url "https://example.cybozu.com" ^
  --auth userpass ^
  --username "your-user" ^
  --password "your-pass" ^
  -e "SELECT $id, 顧客No, 会社名, 顧客ランク, 業種 FROM APP4148 WHERE 顧客ランク IN ('A') ORDER BY 顧客No DESC LIMIT 20;"
```

Windows PowerShell 1行例:

```powershell
node .\dist-cli\ksql.js --base-url "https://example.cybozu.com" --auth userpass --username "your-user" --password "your-pass" -e "SELECT `$id, 顧客No, 会社名, 顧客ランク, 業種 FROM APP4148 WHERE 顧客ランク IN ('A') ORDER BY 顧客No DESC LIMIT 20;"
```

## 7. JOIN クエリ（アプリ2つ）

```sql
SELECT
  a.顧客No      AS 顧客No,
  a.会社名,
  a.顧客ランク,
  b.案件No_     AS 案件No,
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

実行例:

```bash
node dist-cli/ksql.js ^
  --base-url "https://example.cybozu.com" ^
  --auth userpass ^
  --username "your-user" ^
  --password "your-pass" ^
  -e "SELECT a.顧客No AS 顧客No, a.会社名, a.顧客ランク, b.案件No_ AS 案件No, b.案件名, b.商談フェーズ, b.売上 FROM APP4148 AS a INNER JOIN APP4149 AS b ON a.顧客No = b.顧客No_ WHERE b.商談フェーズ IN ('提案中', '内示', '受注') ORDER BY b.案件No_ DESC LIMIT 50;"
```

Windows PowerShell 1行例:

```powershell
node .\dist-cli\ksql.js --base-url "https://example.cybozu.com" --auth userpass --username "your-user" --password "your-pass" -e "SELECT a.顧客No AS 顧客No, a.会社名, a.顧客ランク, b.案件No_ AS 案件No, b.案件名, b.商談フェーズ, b.売上 FROM APP4148 AS a INNER JOIN APP4149 AS b ON a.顧客No = b.顧客No_ WHERE b.商談フェーズ IN ('提案中', '内示', '受注') ORDER BY b.案件No_ DESC LIMIT 50;"
```

## 8. `APP@profile` 指定

CLI 拡張として `APP@profile` を使えます。

### profile とは

`profile` は、接続先（`baseUrl` や認証方式など）を名前付きで管理する設定です。  
例: `dev` は開発環境、`guest` はゲストスペース環境、のように使い分けます。

事前に `ksql.config.json` の `profiles` に定義しておきます。

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

`FROM APP4148@dev` は「APP4148 を `dev` profile の接続先で実行する」という意味です。

```sql
SELECT * FROM app4148@dev LIMIT 10;
SELECT * FROM APP4149@guest LIMIT 10;
```

ポイント:
- `app4148@dev` のように `APP` 部分は大小文字どちらでも可
- `@profile` なしは既定 profile を使用
- `DELETE` での `@profile` は未対応
- profile 名が未定義だと `ArgumentError: profile "..." is not defined.` になる

### 論理アプリ名で環境差を吸収する

開発・本番でアプリ ID が異なる場合は `LAPP_<NAME>` を使います。profile設定のキーには `LAPP_` を付けません。

```json
{
  "defaultProfile": "dev",
  "profiles": {
    "dev": {
      "baseUrl": "https://example.cybozu.com",
      "logicalApps": { "CUSTOMERS": 4148 },
      "tokenMap": { "APP4148": "env:DEV_CUSTOMERS_TOKEN" }
    },
    "prod": {
      "baseUrl": "https://example.cybozu.com",
      "allowPhysicalAppRefs": false,
      "logicalApps": { "CUSTOMERS": 5148 },
      "tokenMap": { "APP5148": "env:PROD_CUSTOMERS_TOKEN" }
    }
  }
}
```

```powershell
node .\dist-cli\ksql.js --config .\ksql.config.json --profile dev `
  -e "SELECT 顧客No, 会社名 FROM LAPP_CUSTOMERS LIMIT 10"

node .\dist-cli\ksql.js --config .\ksql.config.json --profile prod `
  -e "SELECT 顧客No, 会社名 FROM LAPP_CUSTOMERS LIMIT 10"
```

同じ SQL が `dev` では APP4148、`prod` では APP5148 へ解決されます。`--dry-run` または `EXPLAIN` で解決先を確認してからDMLを実行してください。

注意:

- `APP4148` は常に物理 APP4148。`logicalApps` を追加しても意味は変わらない
- `logicalApps` にない `LAPP_UNKNOWN` は fallback せず失敗する
- `allowPhysicalAppRefs: false` の profile では `APP5148` の直接参照を拒否する
- CLIの `DELETE` は `LAPP_CUSTOMERS@prod` のような明示 profile を拒否する。`--profile prod` と `LAPP_CUSTOMERS` を使う

## 9. エクスポート

JSON で保存:

```bash
node dist-cli/ksql.js ^
  --base-url "https://example.cybozu.com" ^
  --auth userpass ^
  --username "your-user" ^
  --password "your-pass" ^
  --format json ^
  --output ".\\out\\app4148_customers.json" ^
  -e "SELECT * FROM APP4148 WHERE 顧客ランク IN ('A');"
```

Windows PowerShell 例:

```powershell
node .\dist-cli\ksql.js `
  --base-url "https://example.cybozu.com" `
  --auth userpass `
  --username "your-user" `
  --password "your-pass" `
  --format json `
  --output ".\out\app4148_customers.json" `
  -e "SELECT * FROM APP4148 WHERE 顧客ランク IN ('A');"
```

CSV で保存:

```bash
node dist-cli/ksql.js ^
  --base-url "https://example.cybozu.com" ^
  --auth userpass ^
  --username "your-user" ^
  --password "your-pass" ^
  --format csv ^
  --output ".\\out\\customers_opportunities_join.csv" ^
  -e "SELECT a.顧客No AS 顧客No, a.会社名, b.案件No_ AS 案件No, b.案件名, b.商談フェーズ, b.売上 FROM APP4148 a JOIN APP4149 b ON a.顧客No = b.顧客No_;"
```

## 10. よくあるエラー

- `AuthError: username/password are required for profile \"...\".`
  - `--auth userpass` 指定時は `--username` / `--password` を必ず指定
- `ArgumentError: profile \"...\" is not defined.`
  - `--profile` 名と設定ファイル定義を確認
- `ArgumentError: @profile is not supported for DELETE yet.`
  - `DELETE` では `APP@profile` を使わず、既定 profile 側で実行
- `ArgumentError: logical app LAPP_... is not defined.`
  - 実効 profile の `logicalApps` と論理名を確認
- `ArgumentError: physical app references are not allowed...`
  - 対象 profile は論理参照専用。対応する `LAPP_<NAME>` を使用

## 11. 次のステップ

1. `--console` で対話実行を試す
2. `--max-records` / `--on-limit` を調整して大量データ時の挙動を確認する
3. 定期バックアップ用途で `--output` を組み合わせる

## 12. 続き: 集計クエリを試す

顧客ランクごとの件数を確認します。

```sql
SELECT
  顧客ランク,
  COUNT(*) AS 件数
FROM APP4148
GROUP BY 顧客ランク
ORDER BY 件数 DESC;
```

Windows PowerShell 例:

```powershell
node .\dist-cli\ksql.js --base-url "https://example.cybozu.com" --auth userpass --username "your-user" --password "your-pass" -e "SELECT 顧客ランク, COUNT(*) AS 件数 FROM APP4148 GROUP BY 顧客ランク ORDER BY 件数 DESC;"
```

案件の商談フェーズ別に売上合計を確認します。

```sql
SELECT
  商談フェーズ,
  SUM(売上) AS 売上合計
FROM APP4149
GROUP BY 商談フェーズ
ORDER BY 売上合計 DESC;
```

## 13. 続き: コンソール(REPL)で反復実行する

起動:

```powershell
node .\dist-cli\ksql.js --console --base-url "https://example.cybozu.com" --auth userpass --username "your-user" --password "your-pass"
```

よく使う流れ:

1. `SELECT 'ABC' as a;` で起動直後の動作確認
2. 基本クエリを貼り付けて実行
3. `:history` で履歴を確認
4. `:rerun 1` で再実行
5. `:save .\out\last_result.json` で保存

## 14. 続き: `APP@profile` を実運用で使う

複数環境（例: `dev` / `guest`）を使い分ける場合、SQL内で profile を明示できます。

```sql
SELECT 顧客No, 会社名
FROM app4148@dev
ORDER BY 顧客No DESC
LIMIT 10;
```

```sql
SELECT 案件No_, 案件名, 売上
FROM APP4149@guest
ORDER BY 案件No_ DESC
LIMIT 10;
```

注意:
- `DELETE` では `APP@profile` は未対応
- profile 名は config に定義済みである必要がある
