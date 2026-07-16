# kSQL MCP サーバー仕様

- 作成日: 2026-05-25
- 対象: `kintone-sql-tools`
- 目的: kSQL の SQL 実行エンジンを MCP サーバーとして公開し、AI クライアントから安全に kintone データの検索・集計・比較・検証を行えるようにする
- ステータス: 仕様

## 1. 背景

`kintone-sql-tools` は、kintone アプリを SQL 風の構文で操作する CLI / Plugin を提供している。

既存実装では、SQL パーサー、実行エンジン、Node.js 向け kintone API クライアント、DML ガード、`APP@profile` による複数環境参照が実装済みである。

MCP サーバー化により、これらの機能を AI クライアントから構造化ツールとして呼び出せるようにする。

主な狙いは以下である。

1. AI による kintone データ分析の精度を上げる
2. 複数アプリ JOIN / GROUP BY / UNION / CTE を AI から安全に利用する
3. 本番・検証・移行元・移行先などの複数環境比較を SQL として再現可能にする
4. 金額集計や移行検証など、AI 側の手作業集計で間違いやすい処理を SQL 実行エンジン側に寄せる
5. `EXPLAIN` / dry-run / DML ガードを MCP ツール設計に組み込む

## 2. 位置づけ

## 2.1 標準 kintone MCP サーバーとの関係

kSQL MCP サーバーは、標準 kintone MCP サーバーの置き換えではなく補完として位置づける。

| 項目 | 標準 kintone MCP サーバー | kSQL MCP サーバー |
|---|---|---|
| 主目的 | kintone REST API の標準操作 | SQL による検索・集計・比較 |
| 得意領域 | アプリ情報、フィールド、レコード CRUD、設定操作 | JOIN、GROUP BY、UNION、CTE、EXPLAIN、環境比較 |
| 操作粒度 | REST API に近い | 業務問い合わせ・分析に近い |
| 複数アプリ統合 | AI 側で処理しがち | SQL 実行エンジン側で処理 |
| 複数環境比較 | 可能だが比較処理は AI 側に寄りがち | `APP100@prod` のように SQL で表現 |
| アプリ設定操作 | 強い | 対象外 |
| 金額集計・差分検証 | 実装次第で可能 | 主用途 |

推奨する使い分けは以下である。

| 用途 | 推奨 |
|---|---|
| kintone アプリ設定の取得・変更 | 標準 kintone MCP |
| フィールド定義やフォーム設定の操作 | 標準 kintone MCP |
| 単純なレコード取得・更新 | 標準 kintone MCP |
| 複数アプリ JOIN | kSQL MCP |
| 金額集計、部門別集計、月次集計 | kSQL MCP |
| 本番・検証・旧新環境の差分比較 | kSQL MCP |
| 移行検証レポート | kSQL MCP |
| SQL として再利用できる検証条件 | kSQL MCP |

## 2.2 kSQL MCP の基本方針

1. 初期版は read-only を既定とする
2. DML は SELECT 系ツールとは分離する
3. DML は明示的な許可、対象件数上限、確認文字列を必須にする
4. 実行結果は文字列ではなく構造化データとして返す
5. AI が作成した SQL は、保存ツールを使った場合のみ永続化する
6. SQL の実行前検証として `EXPLAIN` を利用できるようにする
7. 既存 CLI の config / profile / auth / DML ガード仕様と矛盾させない

## 3. 想定利用者

1. kintone データを AI から分析したい開発者
2. 複数アプリのデータ統合・突合を行う運用担当者
3. 本番・検証・移行先環境の差分を確認したい管理者
4. 月次集計、売上集計、案件集計などを再利用可能な SQL として管理したい利用者
5. Claude Desktop / Claude Code / Codex / Cursor / VS Code 拡張などの MCP 対応クライアント利用者

## 4. スコープ

## 4.1 MVP スコープ

MVP では以下を対象とする。

1. MCP stdio transport
2. SELECT / SHOW APPS / DESCRIBE / EXPLAIN の実行
3. `APP@profile` を含む SQL の実行
4. config / profile / tokenMap / userpass 認証の利用
5. `maxRecords` / `onLimit` / `timeout` の指定
6. 構造化 JSON 結果の返却
7. DML の拒否
8. Jest による MCP 実行層の単体テスト

## 4.2 実用版スコープ

実用版では以下を追加する。

1. 保存 SQL の登録・一覧・取得・実行・削除
2. read-only ツールと DML ツールの明確な分離
3. `INSERT` / `UPDATE` / `UPSERT` / `DELETE` の承認付き実行
4. DML 対象件数上限
5. `EXPLAIN` 先行を要求する安全モード
6. query catalog のファイル保存
7. MCP ツール説明文の改善
8. Claude Desktop / Claude Code での接続例

## 4.3 将来スコープ

将来検討として以下を扱う。

1. Streamable HTTP transport
2. OAuth または外部認可との連携
3. 保存 SQL の署名・承認フロー
4. query catalog のチーム共有
5. 実行履歴・監査ログ
6. スケジュール実行
7. 標準 kintone MCP サーバーとの併用ガイド
8. フィールド定義キャッシュの MCP resource 化

## 4.4 対象外

初期版では以下を対象外とする。

1. kintone アプリ設定の変更
2. フォームレイアウト編集
3. プロセス管理設定変更
4. プラグイン設定変更
5. kintone REST API 全体のラップ
6. AI モデルの内蔵

MCP サーバーは AI ではなく、AI クライアントから呼ばれるツールサーバーである。

## 5. アーキテクチャ

## 5.1 推奨ディレクトリ構成

```text
src/
  core/
    index.ts
    sql.ts
    displayFormat.ts
  cli/
    index.ts
    nodeKintoneClient.ts
  node/
    config.ts
    appProfiles.ts
    runtime.ts
    dmlGuard.ts
    output.ts
  mcp/
    index.ts
    tools.ts
    schemas.ts
    savedQueries.ts
    errors.ts
```

## 5.2 共通化方針

現在 CLI に閉じている処理のうち、MCP でも必要なものを `src/node/` に切り出す。

| 既存の責務 | 現状 | 移動先候補 |
|---|---|---|
| config 読み込み | `src/cli/index.ts` | `src/node/config.ts` |
| profile 解決 | `src/cli/index.ts` | `src/node/runtime.ts` |
| `APP@profile` 正規化 | `src/cli/index.ts` | `src/node/appProfiles.ts` |
| token/env 解決 | `src/cli/index.ts` | `src/node/runtime.ts` |
| DML ガード | `src/cli/index.ts` | `src/node/dmlGuard.ts` |
| 出力整形 | `src/cli/index.ts` | `src/node/output.ts` |
| Node kintone client | `src/cli/nodeKintoneClient.ts` | 当面既存利用、将来 `src/node/` へ移動検討 |

CLI は `src/node/` の共通 runtime を利用する。
MCP も同じ runtime を利用する。

これにより、CLI と MCP の profile / auth / DML 安全ルールを一致させる。

## 5.3 実行フロー

```text
AI クライアント
  -> MCP tool call
  -> src/mcp/tools.ts
  -> src/node/runtime.ts
  -> src/core/execute()
  -> KintoneClient
  -> kintone REST API
```

`EXPLAIN` や `dryRun` の場合は、kintone API を呼び出さない。

## 6. 設定

## 6.1 設定ファイル

既存 CLI と同じ `ksql.config.json` を利用する。

```json
{
  "defaultProfile": "prod",
  "profiles": {
    "prod": {
      "baseUrl": "https://example.cybozu.com",
      "auth": "token",
      "allowPhysicalAppRefs": true,
      "logicalApps": {
        "ORDERS": 100,
        "CUSTOMERS": 200
      },
      "tokenMap": {
        "APP100": "env:KSQL_TOKEN_APP100",
        "APP200": "env:KSQL_TOKEN_APP200"
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
      "logicalApps": {
        "ORDERS": 100
      },
      "tokenMap": {
        "APP100": "env:KSQL_STG_TOKEN_APP100"
      }
    }
  }
}
```

`logicalApps` は `LAPP_<NAME>` をprofileごとの物理アプリ IDへ解決する。キーは `LAPP_` を除いたASCII論理名で、`APP100`、`100`、`LAPP_ORDERS`は拒否される。`allowPhysicalAppRefs` の既定は `true`。`false` にすると、そのprofileに対する物理 `APPxxx` 参照をkSQL SQL surfaceで拒否するが、他ツールやREST APIの物理ID指定までは制限しない。

### 6.1.1 レート制御（requestGate）設定（v1.10.0 で公開）

kintone API 呼び出しには、プロセス内グローバルのレートゲート（セマフォ + GET 系リトライ）が適用される。

| 項目 | config（`profile.query`） | env | 既定 |
|---|---|---|---|
| 同時リクエスト上限 | `maxConcurrent`（1〜50） | `KSQL_MAX_CONCURRENT` | 10 |
| GET リトライ回数 | `retry`（0〜10。0 で無効） | `KSQL_RETRY` | 3 |
| バックオフ初期値（ミリ秒） | `retryBaseDelayMs` | — | 500 |
| バックオフ上限（ミリ秒） | `retryMaxDelayMs` | — | 8000 |

- 解決優先順は **env > config > 既定**。ゲートはプロセス内グローバル1個で、**初回に解決された値で固定**される（複数 profile 同時利用では最初に解決された値が使われる）。config 経由の不正値・範囲外値はゲート側で安全側に clamp される（同時上限 1〜50 / リトライ 0〜10 / バックオフ初期値 1〜60,000ms / 上限 1〜600,000ms かつ初期値以上）
- **MCP ツール入力には公開しない**（設計判断 D4: レート制御は運用者が決める環境設定であり、LLM が呼び出しごとに操作できるべきではない）
- リトライは **GET 系（レコード・アプリ一覧・フィールド情報の取得）限定**。対象は HTTP **408 / 429 / 502 / 503 / 504** とネットワーク層の一時エラー（fetch failed / タイムアウト中断）で、指数バックオフ + ジッタで再試行する
- **書き込み系（POST / PUT / DELETE）はリトライしない**（応答喪失時の二重実行を避けるため。セマフォのみ適用）。再実行が必要な場合は呼び出し側で冪等な再実行（UPSERT 等）を設計する

## 6.2 MCP 起動設定

Claude Desktop などの MCP クライアントからは以下のように起動する。

```json
{
  "mcpServers": {
    "ksql": {
      "command": "ksql-mcp",
      "args": [
        "--config",
        "C:/path/to/ksql.config.json"
      ],
      "env": {
        "KSQL_TOKEN_APP100": "...",
        "KSQL_TOKEN_APP200": "..."
      }
    }
  }
}
```

ローカル開発時は以下を想定する。

```bash
node dist-mcp/ksql-mcp.js --config ./ksql.config.json
```

MCP サーバーでは、config path は原則としてサーバー起動時に固定する。
各 tool call の入力には `configPath` を持たせない。

理由:

1. MCP サーバーは起動時設定に基づいて安定して動作するほうが単純で安全
2. tool call ごとに config を切り替えると、AI が意図せず接続先を変更するリスクがある
3. 複数環境は config path の差し替えではなく `APP@profile` と `profile` 入力で扱う
4. 配置先ごとに物理 ID が異なる同型アプリは `LAPP_<NAME>` と profile 内 `logicalApps` で扱う。mappingはtool inputから変更できない

将来、複数 config を扱う必要が出た場合は、明示的な multi-config mode として別途設計する。

## 7. MCP ツール仕様

## 7.1 `ksql_explain`

SQL の実行計画を返す。
kintone API は呼ばない。

入力:

```json
{
  "sql": "SELECT 顧客コード, SUM(金額) AS 合計 FROM LAPP_ORDERS GROUP BY 顧客コード",
  "profile": "prod"
}
```

出力:

```json
{
  "ok": true,
  "type": "EXPLAIN",
  "columns": ["plan"],
  "rows": [
    { "plan": "  mode:          FULL_SCAN" }
  ],
  "rowCount": 1,
  "warnings": []
}
```

論理参照を含む場合、`appBindings` は最終解決先を返す。EXPLAINでは内部 `mappedAppId` を公開しない。

```json
{
  "appBindings": [
    {
      "source": "logical",
      "logicalName": "ORDERS",
      "appId": 100,
      "profile": "prod"
    }
  ]
}
```

用途:

1. AI が作成した SQL の事前確認
2. kintone API 呼び出し予定の把握
3. DML 前の安全確認

## 7.2 `ksql_query`

read-only SQL を実行する。

許可する文:

1. `SELECT`
2. `WITH`
3. `UNION`
4. `SHOW APPS`
5. `DESCRIBE`
6. `EXPLAIN`
7. `ASSERT`（v1.10.0。read-only 扱い。成功時は `{ ok: true, type: "ASSERT", condition: "<条件>" }`、不成立は `AssertError`。バッチ内では result を持たない no-result 文）
8. `INSERT` / `UPSERT` / `UPDATE` の `VALIDATE ONLY`（書き込みAPI 0のread-only検証。`allowDml` / `confirmText`不要）

拒否する文:

1. `INSERT`
2. `UPDATE`
3. `UPSERT`
4. `DELETE`
5. `REORDER`

入力:

```json
{
  "sql": "SELECT 部門, SUM(金額) AS 合計金額 FROM APP100@prod GROUP BY 部門",
  "profile": "prod",
  "maxRecords": 500,
  "onLimit": "error"
}
```

`format` パラメーターは持たせない。
MCP tool result は常に構造化 JSON として返す。

`onLimit` は tool input 上の名前であり、`execute()` に渡すときは `ExecuteOptions.onLimitReached` に明示的にマッピングする。
ただし `VALIDATE ONLY` は候補全件の完全性が必要なため、入力が `truncate` でも無視して `error` として実行する。バッチ内に `VALIDATE ONLY` が1文でもあればバッチ全体を同じ扱いにする。

`maxRecords` は MCP 層で既定値 500 を明示し、`execute()` に必ず渡す。
`execute()` 内部の既定値とは独立して、AI 利用時の安全側の既定値を MCP 層で固定する。

`timeout` は `execute()` の option ではなく、Node.js kintone client 作成時の HTTP timeout として解決する。
tool input として受ける場合も、`execute()` ではなく runtime/client 生成に渡す。

出力:

```json
{
  "ok": true,
  "type": "SELECT",
  "columns": ["部門", "合計金額"],
  "rows": [
    { "部門": "営業", "合計金額": "1200000" }
  ],
  "rowCount": 1,
  "warnings": []
}
```

`VALIDATE ONLY` の単文出力は `type: "VALIDATION"` とし、`operation`、`validatedRows`、`validRows`、`invalidRows`、`errorCount`、`columns`、`errors`を返す。`VALIDATE ONLY INTO #err` は複文バッチ専用で、validation結果セットに加えて後続文から `#err` を参照できる。

### 7.2.1 バッチ（複文）入力（v1.4.0）

`;` 区切りの複文を **read-only バッチ**として受理する（DML を1文でも含む場合は
`ArgumentError: batch contains DML statements. Use ksql_mutate.`）。
一時テーブル（`CREATE TEMP TABLE #t AS SELECT ...`）を含められる。
詳細仕様は [ksql_batch_temp_table_spec.md](ksql_batch_temp_table_spec.md) §6〜§7 を参照。

追加の入力パラメーター（バッチ専用・任意）:

- `continueOnError`: 実行時エラー後も後続文を実行する（既定 false = fail-fast）
- `maxTotalRecords`: 返却する結果セットの合計行数上限（超過はエラー）
- `tempTableMaxRows`（v1.11.0）: 一時テーブル1個の実体化行数上限。解決順は
  tool input → env `KSQL_TEMP_TABLE_MAX_ROWS` → profile `query.tempTableMaxRows` →
  エンジン既定 `TEMP_TABLE_MAX_ROWS`（10,000）。**超過は `onLimit` 設定によらず常にエラー**
  （truncate による暗黙の欠損が後続文を静かに歪めるため。batch spec §5.6）。
  `ksql_mutate` でも同名 input を受ける。上限を引き上げるとバッチ内最大16テーブル ×
  指定値がメモリに滞留し得る点に注意

バッチ時の `timeout` は**バッチ合計**のタイムアウトとして扱う。

出力はバッチエンベロープになる（単文入力の出力は従来と不変）:

```json
{
  "ok": true,
  "batch": true,
  "statementCount": 2,
  "statements": [
    { "index": 0, "type": "CREATE_TEMP_TABLE", "status": "success", "tempTable": "#t", "rowCount": 120 },
    { "index": 1, "type": "SELECT", "status": "success", "resultIndex": 0 }
  ],
  "results": [
    { "columns": ["顧客名"], "rows": [{ "顧客名": "A社" }], "rowCount": 1, "warnings": [] }
  ],
  "warnings": []
}
```

## 7.3 `ksql_describe_app`

指定アプリのフィールド一覧を返す。

入力:

```json
{
  "app": 100,
  "profile": "prod"
}
```

内部的には以下の SQL と等価に扱ってよい。

```sql
DESCRIBE APP100
```

出力:

```json
{
  "ok": true,
  "app": 100,
  "profile": "prod",
  "fields": [
    {
      "code": "顧客コード",
      "label": "顧客コード",
      "fieldType": "SINGLE_LINE_TEXT"
    },
    {
      "code": "金額",
      "label": "金額",
      "fieldType": "NUMBER"
    }
  ]
}
```

## 7.4 `ksql_show_apps`

利用可能な kintone アプリ一覧を返す。

入力:

```json
{
  "profile": "prod"
}
```

内部的には以下の SQL と等価に扱ってよい。

```sql
SHOW APPS
```

## 7.5 `ksql_validate`

SQL を解析し、実行前チェックのみ行う。

実施する検証:

1. 構文解析
2. 文種別判定
3. `APP@profile` / `LAPP_<NAME>[@profile]` 正規化と論理解決
4. 参照 APP 抽出
5. DML かどうか
6. read-only ツールで実行可能か
7. `UPDATE` / `DELETE` の WHERE 有無
8. `INSERT` 行数

入力:

```json
{
  "sql": "UPDATE LAPP_ORDERS SET ステータス = '完了' WHERE 顧客コード = 'C001'",
  "profile": "prod"
}
```

出力:

```json
{
  "ok": true,
  "statementType": "UPDATE",
  "isDml": true,
  "hasWhere": true,
  "appIds": [900000000],
  "canRunWithQueryTool": false,
  "requiresMutationTool": true,
  "appBindings": [
    {
      "source": "logical",
      "logicalName": "ORDERS",
      "mappedAppId": 900000000,
      "appId": 100,
      "profile": "prod"
    }
  ]
}
```

`mappedAppId` はparser/runtime内部の参照をvalidationで対応付けるための値であり、物理アプリ IDではない。論理参照を含む場合、従来互換の `appIds` にもこの内部IDが現れるため、実際の接続先は必ず `appBindings[].appId` と `profile` で確認する。EXPLAIN、ログ、利用者向けエラーには内部IDを公開しない。物理参照では `source: "physical"` となり `logicalName` は省略される。

### 7.5.1 バッチ（複文）対応（v1.4.0）

- 単文入力は従来のスカラー形を維持しつつ、`statements[]`（要素1）が追加される
- バッチ入力は ParseError にならず、サマリ（`batch: true` / `statementCount` /
  `isReadOnlyBatch` / `containsDml` / `tempTables` / `canRunWithQueryTool` /
  `requiresMutationTool`）と文ごとの `statements[]`（`statementType` / `isDml` /
  `hasWhere` / `insertValuesCount` / `appIds` / `tempTablesCreated` /
  `tempTablesReferenced` / `tempTablesDropped`）を返す
- 一時テーブルの静的検証（未定義参照・再定義・DROP 後参照・同時16個上限）と
  単文 `CREATE / DROP TEMP TABLE` の拒否をここで行う
- `appIds` は文字列走査から AST ベース（文ごと）に変更（文字列リテラル内の誤検出を解消）

詳細は [ksql_batch_temp_table_spec.md](ksql_batch_temp_table_spec.md) §7.1 を参照。

## 7.6 `ksql_mutate`

DML を承認付きで実行する。
Phase 1.5 / Phase 2 で初期実装する。

許可する文:

1. `INSERT`（VALUES 形式）
2. `INSERT_SELECT`（v1.5.0 で APP ソース解禁 → **v1.7.0 でソース制限なし**。APP / 一時テーブル / 混在（JOIN・サブクエリ）とも可）
3. `UPSERT_SELECT`（v1.6.0 で APP ソース解禁 → **v1.7.0 でソース制限なし**。同上）
4. `UPDATE`
5. `UPSERT`
6. `DELETE`
7. `REORDER`

`DELETE FROM LAPP_ORDERS@prod ...` はMCPでは既存runtimeの挙動どおり許可される。CLIでは同じSQLを明示profile制約により拒否するため、surface差を前提にすること。

拒否する文（**SELECT-based DML のソース制限としての拒否**）: なし — v1.7.0 で最終解消。
なお、これとは別に **DELETE / UPSERT および通常 UPDATE 内の一時テーブル参照**は、
エンジン未実装（`temp table references in X are not supported yet.`）として引き続き実行前拒否される。
`UPDATE ... FROM #temp` は専用経路として対応し、通常 UPDATE のサブクエリ内 temp 参照とは区別する。

`INSERT_SELECT` は初期実装（〜v1.4.1）では拒否していたが、v1.4.0（M4）で `executeInsertSelect()` に
書き込み前 confirm hook が実装された（source SELECT 実行後・POST 前に `confirm(rows.length, "INSERT")`）
ことで `dmlMaxRows` ガードが書き込み前に効くようになり、v1.5.0 で解禁した。
v1.7.0 で混在ソース（APP + 一時テーブルの JOIN・サブクエリ）も解禁 — 実行は read-only バッチで
実戦投入済みの FULL_SCAN 注入経路（`executeQueryWithCte`）による。

**読み取り上限（v1.8.0 で dmlMaxRows から分離）**: SELECT-based DML または `UPDATE ... FROM` を含む `ksql_mutate` では、
APP テーブルの fetch は **runtime の通常 `maxRecords` 解決**（`KSQL_MAX_RECORDS` →
profile `query.maxRecords` → 既定 500。`onLimit = "error"` 固定）に従い、
`dmlMaxRows` はソース読み取りを**絞らない**（影響行数ガード専用）。
一時テーブルは実体化上限（既定 `TEMP_TABLE_MAX_ROWS` = 10,000 行。v1.11.0 から tool input
`tempTableMaxRows` / env `KSQL_TEMP_TABLE_MAX_ROWS` / profile `query.tempTableMaxRows` で変更可。
超過は常にエラー）の下にある。
〜v1.7.0 は APP fetch も `maxRecords = dmlMaxRows + 1` で拘束していたが、
「書き込みは少数だがソース読み取りは大量」という JOIN・集計ソースで、
MCP クライアントが影響行数基準で小さい `dmlMaxRows` を選ぶと読み取り上限エラーになる
実害が確認されたため分離した（CLI は当初から `--max-records` と `--dml-max-rows` を
分離しており、同じモデルに揃えた形。経緯は
`docs/internal/ksql_mcp_dml_source_read_limit_issue.md` を参照）。
なお SELECT-based DML・`UPDATE ... FROM` を**含まない** DML（通常 UPDATE / DELETE / INSERT VALUES / UPSERT VALUES /
REORDER のみ）では、対象読み取り件数 ≒ 影響行数が成立するため、従来どおり
`maxRecords = dmlMaxRows + 1`（超過検出用に 1 件多く読む）を維持する。
経緯は `docs/internal/ksql_mcp_insert_select_app_source_spec.md`（v1.5.0）と
`docs/internal/ksql_mcp_insert_select_mixed_source_spec.md`（v1.7.0）を参照。

`UPSERT_SELECT` は v1.6.0 で APP ソースを、v1.7.0 で一時テーブル・混在ソースを解禁した。
`executeUpsertSelect()` は source SELECT → 列数・キー検証 → 既存レコード照合 →
`confirm(toInsert + toUpdate, "UPDATE")` → POST / PUT の順で実行し、confirm は
**照合後・書き込み前**に呼ばれるため `dmlMaxRows` は確定件数（insert + update 合計）に対して効く。
留意点: ①書き込み先 APP への既存レコード照合読み取りはソース種類に関わらず発生する
（一時テーブルに実体化しても回避されない）。②照合読み取りは第1キーのみの `in (...)` 検索のため、
target 側で第1キーの重複が多いと読み取り件数が膨らむ。v1.8.0 で照合読み取りも runtime
`maxRecords`（既定 500）に従うようになり、〜v1.7.0 の「source 1 行でも `dmlMaxRows + 1`
超過で安全側エラー」は解消されたが、`maxRecords` を超える照合はなお安全側エラーになる。
③超過時のエラーは confirm の operation 表記により `UPDATE affected rows ...` となる
（UPSERT VALUES 形式と同じ）。
経緯は `docs/internal/ksql_mcp_upsert_select_unlock_spec.md`（v1.6.0）と
`docs/internal/ksql_mcp_insert_select_mixed_source_spec.md`（v1.7.0）を参照。

### 7.6.1 SELECT-based DML のリスク（v1.7.0 時点の再評価）

`INSERT_SELECT` / `UPSERT_SELECT` は、通常の `INSERT VALUES` / `UPDATE` / `UPSERT` よりも MCP での安全制御が難しいとして初期実装では拒否していた。当初挙げたリスクの v1.7.0 時点の評価:

| リスク | 当初の内容 | v1.7.0 時点の評価 |
| --- | --- | --- |
| 確認前の API 読み取り | source SELECT が書き込み確認より前に実行される | `ksql_mutate` 呼び出し自体が承認（`allowDml` / `confirmText`）であり、推奨していた一時テーブル経由のバッチ形も同じ承認の下で同じ読み取りを行うため、実質差なし。UPSERT（VALUES 形式・許可済み）も confirm 前に照合読み取りを行っており性質は同等 |
| `INSERT_SELECT` の confirm 不足 | `executeInsertSelect()` が書き込み前に confirm を呼ばない | **v1.4.0（M4）で解消**。source SELECT 実行後・POST 前に `confirm(rows.length, "INSERT")` が呼ばれる |
| `UPSERT_SELECT` の照合コスト | source SELECT 後、既存レコード照合が必要 | **v1.6.0 で解禁時に評価済み**。照合はユニークキー組の第1キー `in (...)` チャンク検索。各 fetch は v1.8.0 以降 runtime `maxRecords`（既定 500）拘束（超過は安全側エラー。〜v1.7.0 は `dmlMaxRows + 1` 拘束で、第1キーが低選択性だと source が少なくても上限エラーになり得た） |
| MCP 側 preflight の二重実行 / TOCTOU | 件数確認 SELECT と本実行の二重化・不一致 | preflight を行わない方式（エンジン内 confirm）を採用したため発生しない。SELECT 結果を実体化してから POST するため confirm 時点の件数と書き込み件数は一致する |
| 件数の意味の曖昧さ | `UPSERT_SELECT` は insert / update 件数が混在 | **v1.6.0 で明文化により解消**。`dmlMaxRows` は insert + update **合計**に適用（実装は従来から合計を confirm に渡しており、UPSERT VALUES 形式と同じ意味論） |
| 大量読み取り | — | source SELECT は runtime `maxRecords`（`KSQL_MAX_RECORDS` / profile `query.maxRecords`、既定 500）・`onLimit = "error"` で拘束される（v1.8.0。〜v1.7.0 は `dmlMaxRows + 1`） |

### 7.6.2 SELECT-based DML の対応方針（達成状況）

当初の段階対応と v1.7.0 時点の状況:

1. `executeInsertSelect()` に source SELECT 後・POST 前の confirm hook を追加する — **済（v1.4.0 M4）**
2. `ExecuteOptions.confirm` を operation 種別付きの object 引数へ拡張する — **見送り**（現行の `(count, operation)` 形式で INSERT_SELECT / UPSERT_SELECT とも成立。operation の `"UPSERT"` 表記を導入する場合の将来課題として残す）
3. MCP の `ksql_mutate` に `allowSelectBasedDml: true` を追加する — **不採用（v1.5.0）**。フラグ案は confirm 未実装時代の前提であり、既存の `allowDml` + `confirmText` + `dmlMaxRows` で書き込み承認は表現済み。入力仕様の分岐を増やすことは MCP クライアントの誤用・誤学習の温床になる
4. `INSERT_SELECT` のみ先に解禁する — **済（v1.5.0）**
5. `UPSERT_SELECT` を解禁する — **済（v1.6.0）**。照合コスト・insert/update 内訳の扱いは §7.6.1 の再評価と `dmlMaxRows` の合計適用の明文化で整理した
6. （追加）SELECT-based DML のソース制限（混在 INSERT_SELECT / temp・混在 UPSERT_SELECT）を解消する — **済（v1.7.0）**。実行は read-only バッチと同じ FULL_SCAN 注入経路で、書き込み側ガードは不変
7. （追加）SELECT-based DML のソース読み取り上限を `dmlMaxRows` から分離する — **済（v1.8.0）**。読み取りは runtime `maxRecords` 解決（既定 500）、`dmlMaxRows` は影響行数ガード専用。読み取り上限超過エラーには「`dmlMaxRows` は読み取り上限ではない」旨のヒントを付与する

`UPSERT_SELECT` の件数は source SELECT 件数だけでは確定しないが、`executeUpsertSelect()` は
既存レコード照合後に `toInsert.length + toUpdate.length` を confirm に渡すため、
`dmlMaxRows` ガードは確定件数に対して書き込み前に機能する。

### 7.6.3 confirm hook の現行仕様と将来の拡張案

現行の `ExecuteOptions.confirm` は以下の形で、`INSERT_SELECT` / `UPSERT_SELECT` ともこの形式のまま対応済み
（UPSERT 系は operation `"UPDATE"` で合計件数を渡す）。

```ts
confirm?: (count: number, operation: "UPDATE" | "DELETE" | "INSERT") => Promise<boolean>;
```

operation と statement type をより明示できる object 型への拡張は、`"UPSERT"` 表記の導入とセットの将来課題。

```ts
confirm?: (info: {
  count: number;
  operation: "INSERT" | "UPDATE" | "DELETE" | "UPSERT" | "REORDER";
  statementType:
    | "INSERT"
    | "INSERT_SELECT"
    | "UPDATE"
    | "DELETE"
    | "UPSERT"
    | "UPSERT_SELECT"
    | "REORDER";
  phase: "beforeWrite";
}) => Promise<boolean>;
```

後方互換が必要な場合は、既存 callback 形式を維持しつつ、新しい `confirmMutation` を追加する案もある。

```ts
confirmMutation?: (info: {
  count: number;
  operation: "INSERT" | "UPDATE" | "DELETE" | "UPSERT" | "REORDER";
  statementType: string;
  phase: "beforeWrite";
}) => Promise<boolean>;
```

`INSERT_SELECT` の実装済みフロー（v1.4.0 M4 で confirm hook 実装、v1.5.0 で MCP 解禁。object 拡張は不要だった）:

1. source SELECT を実行して行数を確定する（**APP ソースの fetch は runtime `maxRecords`（既定 500）・`onLimit = "error"`**（v1.8.0。〜v1.7.0 は `dmlMaxRows + 1`）。一時テーブルソースは実体化済み行のメモリ注入で追加読み取りなし — 実体化自体は `tempTableMaxRows`（既定 10,000 行）上限。v1.7.0 以降は両者の混在も可）
2. SELECT 列数と INSERT フィールド数の一致を検証する
3. `confirm(rows.length, "INSERT")` を呼ぶ
4. `dmlMaxRows` 超過なら MCP 側 confirm 実装が `ArgumentError` を投げる（POST は行われない）
5. 確認成功後に転送先フィールド型を解決し、100 件ごとに POST する

`UPSERT_SELECT` の実装済みフロー（confirm hook は初回公開実装から存在、v1.6.0 で MCP 解禁。object 拡張は不要だった）:

1. source SELECT を実行する（読み取り上限は INSERT_SELECT と同じ: APP ソース = runtime `maxRecords`（既定 500。v1.8.0）、一時テーブルソース = 実体化済み注入。v1.7.0 以降は混在も可）
2. SELECT 列数と UPSERT フィールド数の一致・key field を検証する
3. 既存レコード照合（**書き込み先 APP** への第1キー `in (...)` チャンク検索、各 fetch は runtime `maxRecords` 拘束（v1.8.0）。**ソース種類に関わらず発生する**）で `toInsert` / `toUpdate` を確定する
4. `confirm(toInsert.length + toUpdate.length, "UPDATE")` を呼ぶ
5. `dmlMaxRows` 超過なら MCP 側 confirm 実装が `ArgumentError` を投げる（POST / PUT は行われない）
6. 確認成功後に 100 件ごとに POST / PUT する

### 7.6.4 SELECT-based DML の MCP 入力（v1.5.0〜v1.7.0）

`INSERT_SELECT` / `UPSERT_SELECT` は通常 DML と同じ承認入力で実行する。当初案にあった追加フラグ
`allowSelectBasedDml` は**不採用**（理由は §7.6.2-3）。

```json
{
  "sql": "INSERT INTO APP200 (顧客名) SELECT 顧客名 FROM APP100 WHERE ランク = 'A'",
  "profile": "prod",
  "allowDml": true,
  "confirmText": "yes",
  "dmlMaxRows": 100
}
```

解禁後も、以下は必須とする。

1. `dmlMaxRows` による上限確認（confirm hook 経由。書き込み前）
2. confirm hook が呼ばれない文種は実行しない
3. `UPSERT_SELECT` は insert/update **合計**件数を `dmlMaxRows` と比較する（v1.6.0 で明文化。実装は従来から合計を渡す）
4. `ksql_explain` または read-only SELECT による事前確認を推奨する

安全条件:

1. `allowDml: true` が必須
2. `confirmText: "yes"` が必須
3. `dmlMaxRows` が必須
4. `UPDATE` / `DELETE` は WHERE 必須
5. WHERE なし実行を許可する `allowWithoutWhere` は初期実装では提供しない
6. 対象件数が `dmlMaxRows` を超える場合は拒否
7. `EXPLAIN` 結果または直前の validation 結果を要求するモードを検討する

DML の対象件数確認は、`execute()` の `ExecuteOptions.confirm` コールバックで行う。
`UPDATE` / `DELETE` / `UPSERT` / `REORDER` / `INSERT_SELECT` / `UPSERT_SELECT` は実行エンジンが対象 ID または対象件数を解決した後（SELECT-based DML は source SELECT 実行後・書き込み前）に `confirm(count, operation)` を呼ぶため、MCP 側ではこの `count` を `dmlMaxRows` と比較し、超過時は false ではなく `ArgumentError` として拒否する。

`INSERT`（VALUES 形式）は `confirm` が呼ばれないため、`execute()` を呼ぶ前に `parseSqlStatement()` の結果から `stmt.values.length` を取得し、`dmlMaxRows` と比較する。

この方式では、件数確認のために MCP 側で別 SELECT を組み立てる必要はない。
ただし、ユーザー確認用には `ksql_explain` と read-only SELECT を先行させる運用を推奨する。

入力:

```json
{
  "sql": "UPDATE APP100@prod SET ステータス = '完了' WHERE 顧客コード = 'C001'",
  "profile": "prod",
  "allowDml": true,
  "confirmText": "yes",
  "dmlMaxRows": 10
}
```

出力:

```json
{
  "ok": true,
  "type": "UPDATE",
  "updatedCount": 1
}
```

## 7.7 保存 SQL ツール

実用版では、AI が作成した SQL を保存・再利用するためのツールを提供する。

### `ksql_save_query`

入力:

```json
{
  "name": "monthly_sales_summary",
  "title": "月別売上集計",
  "description": "APP100 の金額を受注月ごとに集計する",
  "sql": "SELECT DATE_FORMAT(受注日, 'YYYY-MM') AS 月, SUM(金額) AS 合計金額 FROM APP100@prod GROUP BY 月 ORDER BY 月",
  "defaultProfile": "prod",
  "readOnly": true,
  "allowProfileOverride": false,
  "tags": ["sales", "monthly"]
}
```

### `ksql_list_queries`

保存済み SQL の一覧を返す。

### `ksql_get_query`

保存済み SQL の内容を返す。

### `ksql_run_saved_query`

保存済み SQL を実行する。
`readOnly: true` の保存 SQL は `ksql_query` と同じ安全条件で実行する。
`readOnly: false` の保存 SQL は `ksql_mutate` と同じく `allowDml: true`、`confirmText: "yes"`、`dmlMaxRows` を実行時に要求する。
注意: このツールの入力 `maxRecords` / `onLimit` は **read-only 保存 SQL の実行時のみ有効**。
DML 保存 SQL は `ksql_mutate` へ委譲され、読み取り上限は `ksql_mutate` と同じ規則
（SELECT-based DML を含む場合は runtime `maxRecords` 解決、それ以外は `dmlMaxRows + 1`。§7.6）、
`onLimit` は `"error"` 固定となる。

### `ksql_delete_query`

保存済み SQL を削除する。

## 8. 保存 SQL カタログ

## 8.1 保存場所

初期実装では、プロジェクトローカルの JSON ファイルを利用する。

```text
.ksql/queries.json
```

`.ksql/queries.json` は個人用のローカルカタログとして扱い、commit しない。
保存先は tool input では指定しない。
優先順位は以下の通り。

1. MCP サーバー起動環境の `KSQL_SAVED_QUERIES`
2. `ksql.config.json` の `mcp.savedQueries.path`
3. 既定値 `.ksql/queries.json`

`mcp.savedQueries.path` と既定値の相対パスは、`--config` で指定した config ファイルのディレクトリ基準で解決する。
これにより Claude Desktop / Windows で `cwd` が `C:\WINDOWS\system32` になっても、保存先が system32 配下にならない。

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

リポジトリ配布物として共有したい場合は、以下のようなディレクトリを検討する。

```text
queries/
  monthly_sales_summary.sql
  migration_diff_app100.sql
```

## 8.2 保存形式

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
      "createdAt": "2026-05-24T00:00:00+09:00",
      "updatedAt": "2026-05-24T00:00:00+09:00",
      "tags": ["sales", "monthly"]
    }
  ]
}
```

## 8.3 保存 SQL の安全ルール

1. `readOnly: true` の保存 SQL は DML 文を拒否する
2. DML 保存 SQL は `readOnly: false` を明示する
3. 保存時に `ksql_validate` 相当の検証を行う
4. 実行時にも再検証する
5. 保存 SQL は `defaultProfile` を持つ
6. 実行時 profile override は既定で禁止する
7. override を許可する保存 SQL は `allowProfileOverride: true` を明示する
8. `allowProfileOverride: true` の場合も、実行時に `ksql_validate` と `EXPLAIN` を再実行する

保存 SQL の profile 方針は「既定は禁止、必要なクエリだけ明示許可」とする。
同名保存は上書きし、`createdAt` は維持して `updatedAt` を更新する。
query name は ASCII 英数字開始、英数字・`_`・`-` のみ、最大 64 文字とする。

## 9. 複数環境比較

## 9.1 基本方針

既存 CLI の `APP@profile` 記法を MCP でも利用する。

例:

```sql
SELECT p.顧客コード, p.会社名
FROM APP100@prod p
LEFT JOIN APP100@stg s
  ON p.顧客コード = s.顧客コード
WHERE s.顧客コード IS NULL
LIMIT 50
```

これにより、同一 SQL 内で本番環境と検証環境を比較できる。

## 9.2 代表ユースケース

1. prod にだけ存在するレコード
2. stg にだけ存在するレコード
3. prod と stg で値が異なるレコード
4. 移行元と移行先の件数比較
5. 移行元と移行先の金額合計比較
6. マスタ未反映の検出
7. 同一キー重複の検出

## 9.3 差分確認 SQL 例

prod にだけ存在する顧客:

```sql
SELECT p.顧客コード, p.会社名
FROM APP100@prod p
LEFT JOIN APP100@stg s
  ON p.顧客コード = s.顧客コード
WHERE s.顧客コード IS NULL
LIMIT 50
```

値が異なる顧客:

```sql
SELECT
  p.顧客コード,
  p.会社名 AS prod会社名,
  s.会社名 AS stg会社名,
  p.ステータス AS prodステータス,
  s.ステータス AS stgステータス
FROM APP100@prod p
JOIN APP100@stg s
  ON p.顧客コード = s.顧客コード
WHERE
  p.会社名 != s.会社名
  OR p.ステータス != s.ステータス
LIMIT 50
```

移行前後の金額合計比較:

```sql
SELECT 'old' AS 環境, SUM(金額) AS 合計金額 FROM APP200@old
UNION ALL
SELECT 'new' AS 環境, SUM(金額) AS 合計金額 FROM APP200@new
```

## 10. 金額集計・複数アプリ統合

## 10.1 kSQL MCP が向いている理由

標準 MCP で金額集計や複数アプリ統合を行う場合、AI が以下を自前で行うことになりやすい。

1. ページング
2. 件数上限の扱い
3. JOIN キーの突合
4. 数値文字列の変換
5. NULL / 空文字の扱い
6. 重複キーの扱い
7. 集計ロジックの再利用

kSQL MCP では、これらを SQL と実行エンジン側に寄せられる。

## 10.2 集計 SQL 例

部門別金額集計:

```sql
SELECT 部門, SUM(金額) AS 合計金額
FROM APP100@prod
GROUP BY 部門
ORDER BY 合計金額 DESC
```

顧客マスタと受注アプリの JOIN:

```sql
SELECT
  c.顧客コード,
  c.会社名,
  SUM(o.金額) AS 受注合計
FROM APP100@prod c
JOIN APP200@prod o
  ON c.顧客コード = o.顧客コード
GROUP BY c.顧客コード, c.会社名
ORDER BY 受注合計 DESC
LIMIT 100
```

## 11. プロンプト例

## 11.1 環境比較

```text
prod と stg の APP100 を比較してください。
キーは 顧客コード です。

以下を確認してください。
1. prod にだけ存在するレコード
2. stg にだけ存在するレコード
3. 両方に存在するが、会社名・担当者・ステータス が異なるレコード

最初に EXPLAIN を実行してください。
SELECT のみ実行してください。
INSERT / UPDATE / DELETE は実行しないでください。
```

## 11.2 金額集計

```text
APP200@prod の受注データを部門別に集計してください。
集計対象は 金額 フィールドです。
上位20件を合計金額の降順で表示してください。
実行前に DESCRIBE APP200 と EXPLAIN を確認してください。
```

## 11.3 保存 SQL の再利用

```text
このSQLを「月別売上集計」として保存してください。
保存後、保存済みSQLとして実行してください。
```

## 12. セキュリティと安全制御

## 12.1 認証情報

1. token / password は MCP tool result に含めない
2. debug 出力でも認証ヘッダーはマスクする
3. `env:` 参照を推奨する
4. 保存 SQL に token を含めない
5. エラーに baseUrl や token を過剰に含めない

## 12.2 read-only 既定

`ksql_query` は read-only 文のみ許可する。
DML は `ksql_mutate` に分離する。

## 12.3 DML ガード

DML 実行時は以下を必須とする。

1. `allowDml: true`
2. `confirmText: "yes"`
3. `dmlMaxRows`
4. WHERE あり
5. 実行前 validation
6. 対象件数上限チェック

## 12.4 件数上限

MCP では `maxRecords` の既定値を CLI と同じく 500 とする。

`onLimit` の既定は `error` を推奨する。

実装上は、MCP tool input の `onLimit` を `execute()` の `onLimitReached` にマッピングする。
また、`execute()` 内部の既定値に依存せず、MCP 層から `maxRecords: input.maxRecords ?? 500` を必ず渡す。

DML（`ksql_mutate`）の読み取り上限は文種で異なる（v1.8.0。詳細は §7.6）:

1. SELECT-based DML（`INSERT_SELECT` / `UPSERT_SELECT`）を含む場合: runtime の通常
   `maxRecords` 解決（`KSQL_MAX_RECORDS` → profile `query.maxRecords` → 500）。
   `dmlMaxRows` は影響行数ガード専用でソース読み取りを絞らない
2. それ以外の DML のみの場合: `maxRecords = dmlMaxRows + 1`（対象読み取り ≒ 影響行数のため。
   超過検出用に 1 件多く読む）

いずれも `onLimit` は `"error"` 固定（DML 実行での truncate は暗黙の部分書き込みを生むため提供しない）。
SELECT-based DML の読み取り上限超過エラーには、`dmlMaxRows` ではなく `maxRecords` 側の調整を
促すヒントを付与する。

AI が集計結果を誤認しないよう、上限到達時は以下のいずれかとする。

1. エラーで停止する
2. `warnings` に明示し、結果に `truncated: true` を含める

## 12.5 トランザクション制約

kintone 複数環境・複数アプリをまたぐ処理は、RDBMS のようなトランザクション保証を持たない。

統合作業では、以下の順序を推奨する。

1. `ksql_explain`
2. read-only SELECT による対象確認
3. 件数・金額・キー重複の検証
4. 保存 SQL として記録
5. 必要な場合のみ `ksql_mutate`

## 13. エラー形式

MCP tool result は、例外をそのまま返すのではなく、構造化された失敗結果に変換する。

```json
{
  "ok": false,
  "error": {
    "code": "ArgumentError",
    "message": "DML is not allowed by ksql_query. Use ksql_mutate.",
    "details": {
      "statementType": "UPDATE"
    }
  }
}
```

代表的な `code`:

| code | 意味 |
|---|---|
| `ParseError` | SQL 構文エラー |
| `ArgumentError` | 引数・安全制御エラー |
| `AuthError` | 認証・token 解決エラー |
| `KintoneApiError` | kintone API エラー |
| `LimitError` | 取得件数上限 |
| `OperationCancelled` | DML キャンセル |

## 14. build / package

## 14.1 package.json

`bin` に `ksql-mcp` を追加する。

```json
{
  "bin": {
    "ksql": "dist-cli/ksql.js",
    "ksql-mcp": "dist-mcp/ksql-mcp.js"
  }
}
```

scripts には MCP build を追加する。

```json
{
  "scripts": {
    "build": "npm run build:plugin && npm run build:cli && npm run build:mcp",
    "build:mcp": "node build-mcp.mjs"
  }
}
```

Phase 1 MVP では、`ksql` CLI と `ksql-mcp` を同一 npm package から提供する。
ただし、`ksql-mcp` の実行時に使う `@modelcontextprotocol/sdk` と `zod` は `dependencies` ではなく `devDependencies` に置く。
`build:mcp` で `dist-mcp/ksql-mcp.js` に完全 bundle し、npm 利用者が CLI / Plugin だけを使う場合に MCP SDK を追加取得しないようにする。

`optionalDependencies` は採用しない。
`npm install --no-optional` で `ksql-mcp` bin が壊れるためである。

公開前には、pack した tarball を devDependencies なしの環境に install し、`ksql-mcp --help` と API なし smoke test が動くことを確認する。

MCP が大きくなり bundle size や release 管理が問題になる場合は、Phase 2 以降で `ksql-mcp` の別 package 化を検討する。
ただし MVP では、同一 package の別 bin として提供する。

## 14.2 build-mcp.mjs

MCP サーバーは Node.js 向けに bundle する。

```text
entry: src/mcp/index.ts
outfile: dist-mcp/ksql-mcp.js
platform: node
target: node18
format: cjs
```

## 15. テスト方針

## 15.1 単体テスト

追加するテスト:

1. `ksql_explain` が API を呼ばない
2. `ksql_query` が SELECT を実行する
3. `ksql_query` が UPDATE を拒否する
4. `ksql_validate` が DML / WHERE 有無を判定する
5. `APP@profile` が MCP 経由でも解決される
6. `maxRecords` / `onLimit` が `maxRecords` / `onLimitReached` として `execute()` に反映される
7. 保存 SQL の保存・一覧・取得・削除
8. `format` と `configPath` が tool input に存在しない
9. `timeout` が HTTP client 作成に渡る

## 15.2 既存テスト

既存の以下のテストを継続して通す。

1. parser
2. lexer
3. execute
4. converter
5. fetchAll
6. CLI DML guard
7. CLI console
8. display format

## 15.3 手動検証

1. `node dist-mcp/ksql-mcp.js --config ./ksql.config.json`
2. MCP クライアントから `ksql_explain`
3. MCP クライアントから `ksql_query`
4. DML が拒否されること
5. `APP@profile` の環境比較 SQL が実行できること

## 16. 実装ロードマップ

## 16.1 Phase 0: 調査

1. MCP TypeScript SDK の追加方法確認
2. CLI の共通化対象関数を洗い出す
3. DML ガードの MCP 向け仕様確定

## 16.2 Phase 1: read-only MVP

1. `src/node/appProfiles.ts` に `APP@profile` 正規化の最小共通化を追加
2. `src/mcp/index.ts` 追加
3. `ksql_explain` 追加
4. `ksql_query` 追加
5. `ksql_describe_app` 追加
6. `ksql_show_apps` 追加
7. `build-mcp.mjs` 追加
8. `package.json` に `ksql-mcp` bin 追加
9. Jest テスト追加

`ksql_describe_app` と `ksql_show_apps` は Phase 1 の必須範囲とする。
AI が SQL 構文を組み立てる前に、アプリ一覧とフィールド定義を確認できる必要があるためである。

Phase 1 では `APP@profile` を先送りしない。
複数環境比較は kSQL MCP の主要な差別化要素であるため、CLI runtime 全体の共通化前でも `normalizeSqlAppProfiles`、`extractAppIds`、`normalizeAppKey` などの最小関数は `src/node/appProfiles.ts` へ切り出して MCP から利用する。

## 16.3 Phase 2: runtime 共通化

1. config 読み込みを `src/node/config.ts` に切り出す
2. Phase 1 で作成した `src/node/appProfiles.ts` を CLI 側にも適用する
3. profile / auth 解決を `src/node/runtime.ts` に切り出す
4. CLI を共通 runtime 利用へ変更
5. MCP も共通 runtime 利用へ変更

## 16.4 Phase 3: 保存 SQL

1. `ksql_save_query`
2. `ksql_list_queries`
3. `ksql_get_query`
4. `ksql_run_saved_query`
5. `ksql_delete_query`
6. 保存形式のテスト

## 16.5 Phase 1.5 / Phase 2: 承認付き DML

1. `ksql_mutate`
2. DML validation
3. `dmlMaxRows`
4. `confirmText`
5. WHERE なし拒否
6. 実行結果の構造化

## 16.6 Phase 5: ドキュメントと接続例

1. README 追記
2. Claude Desktop 接続例
3. Claude Code 接続例
4. Codex 利用例
5. 標準 kintone MCP との併用ガイド

## 17. 評価

## 17.1 実現性

評価: 高い

理由:

1. `execute(sql, client, options)` が既に存在する
2. `KintoneClient` が注入式で MCP から呼びやすい
3. Node.js 向け kintone client がある
4. `EXPLAIN` が既にある
5. DML ガード思想が既にある
6. 既存テストが多い

## 17.2 価値

評価: 高い

特に価値が高い用途:

1. 金額集計
2. 複数アプリ JOIN
3. 本番・検証差分
4. 移行検証
5. 保存 SQL による再利用
6. AI の集計ミス削減

## 17.3 リスク

評価: 中

主なリスク:

1. DML の誤実行
2. token / password の漏洩
3. 大量取得による API 負荷
4. 複数環境更新時のトランザクション不在
5. SQL 生成ミス
6. 保存 SQL の管理不備

対応:

1. read-only 既定
2. DML ツール分離
3. `EXPLAIN` 先行
4. `maxRecords` と `onLimit=error`
5. 認証情報マスク
6. 保存 SQL の validate

## 18. 推奨結論

kSQL MCP サーバーは、`kintone-sql-tools` 本体リポジトリに `src/mcp/` として追加するのがよい。

ただし、CLI と密結合させず、CLI に閉じている config / profile / auth / DML ガード処理を `src/node/` に共通化する。

初期版は read-only MCP として実装し、金額集計・複数アプリ JOIN・複数環境比較の価値を確認する。

DML と保存 SQL は、read-only MVP の安定後に段階的に追加する。

最終的には以下の役割分担を推奨する。

```text
標準 kintone MCP:
  kintone REST API 操作、アプリ設定、フォーム設定、標準 CRUD

kSQL MCP:
  SQL 検索、金額集計、複数アプリ JOIN、環境比較、移行検証、保存 SQL
```
