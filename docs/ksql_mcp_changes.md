# kSQL MCP Server Changes

このドキュメントは、`kintone-sql-tools` に MCP サーバー機能を追加した変更点のまとめです。

## 1. 追加された実行入口

`package.json` に MCP サーバー用 bin を追加した。

```json
{
  "bin": {
    "ksql": "dist-cli/ksql.js",
    "ksql-mcp": "dist-mcp/ksql-mcp.js"
  }
}
```

MCP サーバーは `dist-mcp/ksql-mcp.js` として bundle される。

起動例:

```powershell
node .\dist-mcp\ksql-mcp.js --config .\ksql.config.json --profile prod
```

Claude Desktop on Windows では、`node` や Nodist shim ではなく実体の `node.exe` を `command` に指定する。

## 2. 追加された npm scripts

MCP 用の build / smoke / pack 検証を追加した。

```json
{
  "build": "npm run build:plugin && npm run build:cli && npm run build:mcp",
  "build:mcp": "node build-mcp.mjs",
  "mcp:smoke": "node scripts/mcp-smoke.mjs",
  "mcp:pack-smoke": "node scripts/mcp-pack-smoke.mjs",
  "mcp:kintone-smoke": "node scripts/mcp-kintone-smoke.mjs",
  "mcp:verify": "npm run build:mcp && npm run mcp:smoke && npm run mcp:pack-smoke"
}
```

`@modelcontextprotocol/sdk` と `zod` は `devDependencies` に置き、`build:mcp` で `dist-mcp/ksql-mcp.js` に bundle する方針にした。
これにより、通常の CLI / Plugin 利用者が MCP SDK を runtime dependency として取得しない。

## 3. MCP サーバー構成

主な追加ファイル:

```text
build-mcp.mjs
src/mcp/index.ts
src/mcp/tools.ts
src/mcp/schemas.ts
src/mcp/savedQueries.ts
src/mcp/__tests__/tools.test.ts
src/mcp/__tests__/savedQueries.test.ts
scripts/mcp-smoke.mjs
scripts/mcp-pack-smoke.mjs
scripts/mcp-kintone-smoke.mjs
```

Node / CLI 共通化用の追加ファイル:

```text
src/node/appProfiles.ts
src/node/config.ts
src/node/dmlGuard.ts
src/node/runtime.ts
```

MCP 層は `execute(sql, client, options)` を直接再利用し、SQL 実行エンジン本体への変更を最小化している。

## 4. 提供 MCP tools

現在の MCP tools は 11 個。

| Tool | 用途 |
| --- | --- |
| `ksql_validate` | SQL を解析し、DML 判定・APP@profile 正規化結果を返す |
| `ksql_explain` | kintone API なしで実行計画を返す |
| `ksql_query` | read-only SQL を実行する |
| `ksql_mutate` | 明示承認付きで DML を実行する |
| `ksql_describe_app` | `DESCRIBE APPxxx` を実行する |
| `ksql_show_apps` | `SHOW APPS` を実行する |
| `ksql_save_query` | SQL を保存 SQL カタログに登録する |
| `ksql_list_queries` | 保存 SQL の一覧を返す |
| `ksql_get_query` | 保存 SQL の SQL 本文を含めて取得する |
| `ksql_run_saved_query` | 保存 SQL を実行する |
| `ksql_delete_query` | 保存 SQL を削除する |

## 5. 複数環境対応

既存 CLI と同じ `APP@profile` 記法を MCP でも利用できる。

例:

```sql
SELECT p.顧客コード, p.金額 AS prod金額, s.金額 AS stg金額
FROM APP100@prod p
JOIN APP100@stg s ON p.顧客コード = s.顧客コード
WHERE p.金額 <> s.金額
```

同じ appId が複数 profile に現れる場合は、MCP runtime が仮想 appId を割り当て、profile 別 client に routing する。
これにより `execute()` 内部を大きく改造せず、複数環境比較を実現している。

## 6. `ksql_query` の安全制御

`ksql_query` は read-only 専用。

許可する主な文:

```text
SELECT
WITH
UNION
EXPLAIN
SHOW APPS
DESCRIBE
```

DML は拒否し、`ksql_mutate` の利用を促す。

`maxRecords` の MCP 既定値は 500。
`onLimit` は MCP tool input では `onLimit`、内部 `ExecuteOptions` では `onLimitReached` に明示的に mapping する。

## 7. `ksql_mutate` の安全制御

`ksql_mutate` は DML 専用。
実行には以下が必須。

```json
{
  "allowDml": true,
  "confirmText": "yes",
  "dmlMaxRows": 10
}
```

初期実装で許可する文:

```text
INSERT VALUES
UPDATE
UPSERT
DELETE
REORDER
```

初期実装で拒否する文:

```text
INSERT_SELECT
UPSERT_SELECT
```

`INSERT_SELECT` / `UPSERT_SELECT` は、書き込み確認より前に source SELECT や既存レコード照合の API 読み取りが発生する。
そのため、MCP 初期実装では SELECT-based DML をまとめて拒否する。

その他の安全条件:

1. `UPDATE` / `DELETE` は WHERE 必須
2. `INSERT VALUES` は実行前に values 件数を `dmlMaxRows` と比較する
3. `UPDATE` / `DELETE` / `UPSERT` / `REORDER` は `ExecuteOptions.confirm` 内で対象件数を確認する
4. `allowWithoutWhere` は MCP tool input として公開しない

## 8. 保存 SQL カタログ

保存 SQL 用に `src/mcp/savedQueries.ts` を追加した。

責務:

1. カタログ JSON の parse / validate
2. 保存ファイルの読み書き
3. query name の検証
4. upsert / get / delete
5. `readOnly` と DML の整合性確認
6. profile override 許可確認

保存形式:

```json
{
  "version": 1,
  "queries": [
    {
      "name": "monthly_sales_summary",
      "title": "月別売上集計",
      "description": "APP100 の金額を受注月ごとに集計する",
      "sql": "SELECT ...",
      "defaultProfile": "prod",
      "readOnly": true,
      "allowProfileOverride": false,
      "createdAt": "2026-05-24T00:00:00.000Z",
      "updatedAt": "2026-05-24T00:00:00.000Z",
      "tags": ["sales", "monthly"]
    }
  ]
}
```

`ksql_list_queries` は SQL 本文を返さない。
SQL 本文が必要な場合は `ksql_get_query` を使う。

## 9. 保存先設定

保存 SQL カタログの保存先は tool input では指定しない。
優先順位は以下の通り。

1. `KSQL_SAVED_QUERIES`
2. `ksql.config.json` の `mcp.savedQueries.path`
3. 既定値 `.ksql/queries.json`

設定例:

```json
{
  "defaultProfile": "prod",
  "mcp": {
    "savedQueries": {
      "path": ".ksql/queries.json"
    }
  }
}
```

`mcp.savedQueries.path` と既定値の相対パスは、`--config` で指定した config ファイルのディレクトリ基準で解決する。
Claude Desktop / Windows で `cwd` が `C:\WINDOWS\system32` になっても、保存先が system32 配下にならない。

`.ksql/queries.json` は個人用ローカルカタログとして `.gitignore` 対象にした。

## 10. 保存 SQL 実行時の安全制御

`ksql_run_saved_query` は保存 SQL の `readOnly` に応じて実行経路を分ける。

`readOnly: true` の場合:

```text
ksql_query と同じ安全条件で実行
```

`readOnly: false` の場合:

```text
ksql_mutate と同じ承認条件で実行
allowDml: true
confirmText: "yes"
dmlMaxRows: number
```

profile override は既定で禁止。
保存 SQL に `allowProfileOverride: true` が明示されている場合のみ、実行時 `profile` override を許可する。

## 11. 設定サンプル

追加・更新したサンプル:

```text
docs/examples/ksql.mcp.config.sample.json
docs/examples/mcp-client.sample.json
docs/examples/mcp-verification.env.sample
docs/examples/mcp.saved-queries.sample.json
```

Claude Desktop 設定例:

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
        "prod"
      ],
      "env": {
        "KSQL_TOKEN_APP100": "replace-with-token"
      }
    }
  }
}
```

## 11.5 バッチ実行・一時テーブル対応（v1.4.0 予定）

`;` 区切りの複文（バッチ）と一時テーブル（`CREATE TEMP TABLE #t AS SELECT ...`）に対応した。
フェーズ2 の M1（DML バッチ）・M2（CLI の DML バッチ確認）・M3（バッチ EXPLAIN）・
M4（temp 経由 INSERT_SELECT）まで実装済み。残りは v1.4.0 リリース（M6。実機検証と表記確定）。
詳細仕様は `docs/ksql_batch_temp_table_spec.md`。

対応ツールと変更点:

| Tool | 変更 |
| --- | --- |
| `ksql_validate` | バッチ入力を受理し、サマリ + 文ごとの `statements[]` を返す。単文は従来スカラー形を維持（`statements[]` が追加）。一時テーブルの静的検証・単文 CREATE/DROP の拒否・空入力の拒否を実施。`appIds` は AST ベース（文ごと）に変更 |
| `ksql_query` | read-only バッチを実行しバッチエンベロープ（`statements[]` + `results[]`）を返す。入力に `continueOnError` / `maxTotalRecords` を追加。DML 混在バッチは `ksql_mutate` へ誘導するエラー。バッチの `timeout` は合計タイムアウト |
| `ksql_mutate` | DML バッチを受理（フェーズ2 M1）。dmlMaxRows は文ごと + 任意の dmlTotalMaxRows で合計ガード。常に fail-fast。一時テーブル経由の INSERT_SELECT に対応（M4。ソースが一時テーブルのみの場合） |
| `ksql_explain` | バッチ入力で全文プランの配列を返す（M3）。一時テーブル参照文は FULL_SCAN（インメモリ）と行数不明を明示 |
| `ksql_save_query` / `ksql_run_saved_query` | 保存 SQL は単文のみ（バッチは明示エラー） |

安全制御の要点:

- validate-all-first: 1文でも不正ならバッチ全体を拒否（実行前）
- `ksql_query` が受けるのは read-only 文のみのバッチ（ツール分離の維持）
- `CREATE TEMP TABLE` の実体化結果は返却しない（`tempTable` / `rowCount` のみ）。
  中間結果を LLM のコンテキストに載せないための設計
- 一時テーブルはバッチ内スコープ（呼び出し終了で破棄）。同時 16 個・1個 10,000 行上限

## 12. CLI / Plugin への影響

Plugin:

```text
src/ui/ は src/core/ 中心の参照であり、MCP 追加による動作影響はない。
```

CLI:

```text
共通化した dmlGuard / config / runtime の一部を利用。
REORDER は共有 DML 判定に含まれる。
v1.4.0: dmlGuard の実体は src/core/ へ移動（src/node/ は再エクスポートで互換維持）。
CLI も -e / -f / --console でバッチ実行に対応（docs/ksql_cli_console_spec.md 参照）。
```

MCP SDK と zod は bundle 用 devDependencies であり、npm package の runtime dependencies には追加しない方針。

## 13. 検証

主な確認コマンド:

```powershell
npm test -- --runInBand
npm run build
npm run mcp:verify
npm audit --omit dev
git diff --check
```

直近の確認結果:

```text
npm test -- --runInBand: 374 tests passed
npm run build: passed
npm run mcp:verify: passed
npm audit --omit dev: 0 vulnerabilities
git diff --check: passed
```

`mcp:verify` では以下を確認する。

1. `build:mcp`
2. API なし MCP stdio smoke
3. npm pack 後の MCP smoke

実 kintone 接続確認は `mcp:kintone-smoke` を使う。

```powershell
npm run mcp:kintone-smoke -- --config .\ksql.config.json --profile prod --app 100
```

## 14. 関連ドキュメント

```text
docs/ksql_mcp_server_spec.md
docs/ksql_mcp_verification_setup.md
docs/ksql_batch_temp_table_spec.md
docs/internal/ksql_mcp_server_implementation_steps.md
```
