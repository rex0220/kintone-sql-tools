# kintone-sql-tools

kintone アプリを SQL 風の構文で操作するツールセットです。

- kintone プラグイン（UI）
- CLI（`ksql`）
- MCP サーバー（AI クライアントから kintone を SQL 操作。Claude Desktop 用 MCPB 同梱）
- read-only エンジン・ライブラリ（ESM / CJS / UMD）

他の kintone プラグインやカスタマイズへ read-only kSQL エンジンを組み込む場合は、
[エンジン・ライブラリ利用ガイド](docs/ksql_engine_library.md)を参照してください。

engine ライブラリでは、`runQuery()` が単文の `SELECT` / `WITH` / `UNION` /
`SHOW APPS` / `DESCRIBE` / 既存レコード `VALIDATE` を、`runBatch()` がそれらに加えて
`CREATE` / `DROP TEMP TABLE`、`SET` / `DECLARE`、`ASSERT`、`EXPLAIN` を実行します。
書き込み DML、DML `VALIDATE ONLY`、`IMPORT`、`APPLY` は対象外です。
生成 AI が MCP で作った SQL を library で実行する場合は、この API 別の境界を確認してください。

## 機能概要

- `SELECT`（JOIN/GROUP BY/HAVING/CTE/UNION）
- `INSERT` / `UPDATE` / `UPDATE ... FROM` / `UPSERT` / `DELETE` / `REORDER`（`--allow-dml` 必須）
- `EXPLAIN`
- **型付きcanonical `ORDER BY`とkintone固有順を選ぶ`KORDER BY`**（v3.0.0）
- **最大30桁のNUMBERをraw字句のまま比較する厳密10進primitive**（v3.3.0）
- **バッチ実行（`;` 区切りの複文）と一時テーブル `CREATE TEMP TABLE #t AS SELECT ...`**
  - CLI / MCP: read-only バッチ + DML バッチ（一時テーブル経由の `INSERT ... SELECT` を含む）
  - プラグイン: read-only バッチのみ（最終結果を表示）
- **`ASSERT`（実行時ゲート。DML 前の件数ガード / CLI ヘルスチェック）**
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

### テストを実行するときは `KSQL_*` を外す

CLI は**環境変数を設定ファイルより優先**します（CLI 引数 → 環境変数 → 設定ファイル）。
シェルに `KSQL_USERNAME` / `KSQL_PASSWORD` / `KSQL_CONFIG` / `KSQL_PROFILE` などが
残っていると、**テストが別の認証・別の設定で走り、リポジトリを変えていないのに
落ちたり通ったりします**。

```bash
env -u KSQL_USERNAME -u KSQL_PASSWORD npm test
```

日常の CLI 利用のために `KSQL_*` を設定している場合は、上のように外して実行してください。
**テストが落ちたら、まず `env | grep KSQL_` を確認**すると早いことがあります
（実装が読む `KSQL_*` は 32 個あります）。

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

言語リファレンス・レシピは MCP resources（`ksql://language-reference` / `ksql://recipes`）に加えて、read-only ツール **`ksql_docs`** でも読めます。中継環境（リモート接続のプロキシ等）が resources を通さないクライアントでは、`ksql_docs` を引数なしで呼ぶと全章キーの索引が返るので、必要な章だけ `{"section":"language-reference/05-string-number-functions"}` の形で取得してください。

**今つながっている MCP が何版かは、`ksql_docs` を引数なしで呼ぶと索引の先頭行で分かります**（v3.56.3〜）。**MCP は常駐プロセスなので、`npm install` してもクライアントを再読み込みするまで差し替わりません。**`ksql.js --version` は別プロセス（CLI）の版なので、常駐 MCP の版とは食い違うことがあります。**測定結果が期待と違うときは、まず索引の先頭行で版を確かめてください。**

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
  --import-csv <name=path>   Supply named CSV and enable IMPORT (repeatable)
  --import-json <name=path>  Supply named JSON and enable IMPORT (repeatable)
  --format <type>            Output format: table | json | jsonl | csv | markdown | md
                             (batch + json: prints one JSON envelope for the whole batch)
  --max-records <n>          Max records to fetch (default: 500)
  --fetch-parallel <n>       Parallel page fetches per query: 1-10 (default: 3)
  --on-limit <mode>          On record limit: error | truncate (local ORDER BY needs complete input)
  --temp-table-max-rows <n>  Max rows per temp table (default: 10000, always errors on overflow)
  --timeout <ms>             Request timeout in milliseconds (default: 30000)
  --max-concurrent <n>       Max concurrent kintone requests: 1-50 (default: 10)
                             (process-wide; fixed at first resolution; KSQL_MAX_CONCURRENT wins)
  --cursor-max-active <n>    Max active cursors per host: 1-5 (default: 2; KSQL_CURSOR_MAX_ACTIVE wins)
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
  --dml-max-rows <n>         Max affected parent rows for DML/APPLY guard (default: 100)
  --dml-max-subtable-rows <n> Max changed subtable rows for APPLY guard; multi-value fields excluded (default: 500)
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

## 公式 API（プログラムから使う）

npm パッケージは 2 つのサブパスを **semver 対象の公開 API** として提供します。
ここに載る export のシグネチャ・挙動の互換性は semver（破壊的変更＝メジャー、追加＝マイナー）で管理します。

| サブパス | 用途 | 主な export |
|---|---|---|
| `@rex0220/kintone-sql-tools/engine` | **read-only** のクエリ実行（ダッシュボード等）。書込 API は構造的に遮断 | `runQuery` / `runBatch` / `explainQuery` / `createReadonlyKintoneClient` / `KsqlEngineError` / `version` |
| `@rex0220/kintone-sql-tools/flow` | **Flow dialect 1**（→ [言語リファレンス §27](docs/ksql_language_reference.md)）のスクリプト解析・検証・**文単位実行**（バッチランナー向け・書込可能） | `parseScript` / `validateScript` / `explainScript`（`asOf`/`timezone` 注入可） / `createExecutionContext`（`onChunkWritten` 書込チャンク通知） / `executeStatement` / `previewStatement`（dry-run 差分プレビュー・書込 0 回） / `disposeExecutionContext` / `createKintoneClient` / `isDmlResult`（`FlowDmlResult` 型ガード） / `version` |

`/flow` の典型的な使い方（1 文ずつ実行して結果で継続判断する）:

```ts
import { parseScript, createExecutionContext, executeStatement, disposeExecutionContext, createKintoneClient } from "@rex0220/kintone-sql-tools/flow";

const client = createKintoneClient({ baseUrl, auth: { type: "apiToken", apiToken } });
const { statements, meta, diagnostics } = parseScript(source, { apps: { 受注: 100 } });
const ctx = createExecutionContext({ client, script: source, apps: { 受注: 100, 顧客マスタ: 200 }, asOf: new Date("2026-08-01T00:00:00+09:00"), timezone: "Asia/Tokyo" });
try {
  for (const stmt of statements) {
    const result = await executeStatement(stmt, ctx);
    // result で ASSERT 違反 / EXIT 成立 / skipped を判別して継続を判断する
  }
} finally {
  await disposeExecutionContext(ctx);
}
```

### エンジンバージョン × dialect 対応表

| エンジン | dialect 0（既定・宣言なし） | dialect 1（`-- @ksql dialect: 1`） |
|---|---|---|
| 〜 v3.67.0 | ✅ | —（未実装） |
| v3.68.0 | ✅ | 解析のみ（エンジン内部 API。実行できる出荷面なし・実験的） |
| v3.69.0 〜 | ✅ | ✅ CLI / MCP / プラグイン / `/flow` で実行可 |

dialect は後方互換で管理します: dialect 0 のスクリプトはどのエンジン版でも挙動不変・破壊的変更は dialect 番号の繰り上げでのみ導入します。変更履歴は [CHANGELOG.md](CHANGELOG.md) を参照してください。

## 機密情報の取り扱い

- token / password は直書きせず、環境変数または `env:` 参照を推奨します。
- `ksql.config.json` はローカル運用ファイルとして `.gitignore` 済みです。
- `private.ppk` / `pluginId.txt` は `.gitignore` 済みです。

## ドキュメント

- [Docs Index](docs/README.md)
- [言語リファレンス](docs/ksql_language_reference.md)
- [CLI / Console 仕様](docs/internal/ksql_cli_console_spec.md)
- [バッチ実行・一時テーブル仕様](docs/internal/ksql_batch_temp_table_spec.md)
- [MCP サーバー仕様](docs/internal/ksql_mcp_server_spec.md) / [Claude Desktop への導入（MCPB）](docs/ksql_mcpb_claude_desktop_install.md)
- [APP@profile 仕様](docs/internal/cli_app_profile_spec.md)
- [公開前チェックリスト](docs/internal/public_release_checklist.md)

## ライセンス

MIT License. See [LICENSE](LICENSE).
