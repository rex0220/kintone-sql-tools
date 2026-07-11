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

## 11.5 バッチ実行・一時テーブル対応（v1.4.0）

`;` 区切りの複文（バッチ）と一時テーブル（`CREATE TEMP TABLE #t AS SELECT ...`）に対応した
（read-only / DML バッチ、バッチ EXPLAIN、一時テーブル経由の INSERT_SELECT、
プラグインの read-only バッチまで実装・実機検証済み）。
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

## 11.6 ツールメタデータの実態合わせ（v1.4.1）

Claude Desktop が `ksql_mutate` の description（「INSERT_SELECT and UPSERT_SELECT are rejected」）を根拠に、
対応済みの一時テーブル経由バッチ INSERT_SELECT を「非対応」と誤判定してツールを呼ばない事象への対応。
実装は v1.4.0 のままで、モデルに見えるメタデータのみを実態に合わせた。
計画: `docs/internal/ksql_mcp_tool_description_fix_plan.md`

| 変更 | 内容 |
| --- | --- |
| description 修正 | `ksql_query` / `ksql_mutate` にバッチ + 一時テーブル対応を明記し SQL 例を埋め込み。mutate は「Standalone INSERT_SELECT and UPSERT_SELECT are rejected」に限定 |
| エラーメッセージ | 単文 INSERT_SELECT の拒否時に、対応済みのバッチ経路（CREATE TEMP TABLE を挟む書き方）への誘導ヒントを追加 |
| パラメータ説明 | 全入力スキーマに zod `.describe()` を追加（従来は TypeScript コメントのみで MCP クライアントに渡っていなかった） |
| serverInfo.version | `"1.0.0"` 固定を廃止し、esbuild define で package.json の version を埋め込み |
| smoke 回帰ガード | `scripts/mcp-smoke.mjs` に description キー部分文字列・パラメータ説明の存在・version 一致の機械的 assertion を追加（メタデータだけ古くなるズレを検出） |

## 11.7 APP ソース INSERT_SELECT の解禁（v1.5.0）

`INSERT INTO APPx (...) SELECT ... FROM APPy ...`（APP ソースの INSERT_SELECT）を
`ksql_mutate` で実行可能にした（単文・バッチとも）。
v1.4.0（M4）で `executeInsertSelect()` に書き込み前 confirm フックが実装済みで、
拒否を続ける根拠が失効していたための解禁。変更の本体はガード削除2箇所のみで、新規の安全機構はない。
仕様・経緯: `docs/internal/ksql_mcp_insert_select_app_source_spec.md`（codex レビュー R1〜R3）

| 変更 | 内容 |
| --- | --- |
| 単文 INSERT_SELECT | 拒否を削除。既存の単文 DML 経路で実行（source SELECT 実行後・POST 前に confirm で `dmlMaxRows` 判定。超過時はゼロ書き込みで ArgumentError） |
| バッチ INSERT_SELECT | 「ソースが一時テーブルのみ」の制限を削除。APP のみソースも実行可能。source 行数は confirm 経由で `dmlTotalMaxRows` にも合算される |
| 混在ソース（APP + 一時テーブル） | 引き続き拒否（エンジン層）。メッセージを実態に合わせて変更: `INSERT_SELECT mixing app and temp table sources is not supported. Select from apps only, or materialize the app data into a temp table first (temp tables hold at most 10000 rows). (statement N)` |
| 読み取り上限 | source SELECT は `maxRecords = dmlMaxRows + 1`（`onLimit = "error"`）で実行。集計等で読み取りが多いソースは一時テーブル経由（実体化上限 10,000 行）でのみ回避可能。それを超える大規模集計は非対応 |
| description / describe | `ksql_mutate` description を「INSERT INTO app ... SELECT is supported (single statement or batch); ... UPSERT ... SELECT is rejected.」に更新。`dmlMaxRows` の describe に source SELECT 読み取り上限を兼ねる旨を追記（`ksql_run_saved_query` も同様 — DML 保存クエリは `mutate()` 委譲のため保存済み INSERT_SELECT に同じ上限が効く） |
| smoke 回帰ガード | `mcp-smoke.mjs` の description キーを新文言に差し替え（旧バンドルで失敗することを確認してから適用）。`dmlMaxRows` describe のキー assertion を `ksql_mutate` / `ksql_run_saved_query` の両ツールに追加 |
| 挙動変化 | 従来 `ArgumentError` だった呼び出しが成功（= 書き込み発生）するようになる。既存の成功ケースの挙動・レスポンス形式は不変 |

`UPSERT_SELECT` は引き続き拒否（insert / update 件数が既存レコード照合後まで確定しないため。将来課題）。

## 11.8 APP ソース UPSERT_SELECT の解禁（v1.6.0）

`UPSERT INTO APPx (...) SELECT ... FROM APPy ON DUPLICATE (...)`（APP ソースの UPSERT_SELECT）を
`ksql_mutate` で実行可能にした（単文・バッチとも）。
`executeUpsertSelect()` は初回公開実装から照合後・書き込み前に confirm（insert + update 合計）を
呼んでおり、v1.5.0 の INSERT_SELECT と同型の「根拠が失効した拒否」だったための解禁。
変更の本体はガード削除2箇所のみ。
仕様・経緯: `docs/internal/ksql_mcp_upsert_select_unlock_spec.md`（codex R1〜R4）

| 変更 | 内容 |
| --- | --- |
| 単文 / バッチ UPSERT_SELECT | 拒否を削除。照合後の insert + update **合計**が `dmlMaxRows` 超過なら POST / PUT ともゼロ書き込みで ArgumentError。合計は confirm 経由で `dmlTotalMaxRows` にも合算 |
| 一時テーブルソース | 引き続きエンジン層で実行前拒否（`executeUpsertSelect` が temp 注入に未対応）。**INSERT_SELECT と異なり大きい集計ソースの temp 迂回路はない**（read-only SELECT で事前確認 → dmlMaxRows 設定の運用のみ） |
| 読み取り上限 | source SELECT・既存レコード照合とも `maxRecords = dmlMaxRows + 1`（`onLimit = "error"`）。照合は第1キーのみの `in (...)` 検索のため、target 側で第1キーの重複が多いと source 行数が少なくても安全側の上限エラーになり得る |
| エラー表記 | 超過時は confirm の operation 表記により `UPDATE affected rows ...`（UPSERT VALUES 形式と同じ。既知の表記課題として許容） |
| description / describe | `ksql_mutate` description に「UPSERT INTO app ... SELECT is supported for app sources only (temp-table sources are not supported); dmlMaxRows counts inserts + updates.」を追加。`dmlMaxRows` describe（mutate / run_saved_query 両方）を INSERT/UPSERT 共通表現に更新 |
| smoke 回帰ガード | description キーを新文言に差し替え（旧バンドルで失敗確認後に適用）。dmlMaxRows describe の「counts inserts + updates」assertion を両ツールに追加 |
| 挙動変化 | 従来 `ArgumentError` だった呼び出しが成功（= 書き込み発生）するようになる。既存の成功ケースは不変 |

## 11.9 SELECT-based DML のソース制限 最終解消（v1.7.0）

`INSERT_SELECT` の混在ソース（APP + 一時テーブルの JOIN・サブクエリ）と、
`UPSERT_SELECT` の一時テーブル・混在ソースを解禁した。
実行は read-only バッチで実戦投入済みの FULL_SCAN 注入経路（`executeQueryWithCte`）で、
エンジン変更はガード緩和 + `executeUpsertSelect` への cteCache 配管（INSERT_SELECT 経路の鏡写し）のみ。
仕様・経緯: `docs/internal/ksql_mcp_insert_select_mixed_source_spec.md`（codex R1〜R5）

| 変更 | 内容 |
| --- | --- |
| 混在 INSERT_SELECT | `FROM #t JOIN APPx` / サブクエリ内 temp 参照とも実行可能。v1.5.0 の混在拒否エラー（`mixing app and temp table sources ...`）は発生しなくなった |
| temp / 混在 UPSERT_SELECT | 実行可能。v1.6.0 の「temp 迂回路なし」制約は source 側について解消 |
| 読み取り側の上限（ソース種類別） | APP fetch = `dmlMaxRows + 1`（JOIN の APP 側も同様。大きい APP は安全側の上限エラーになり得る）/ temp = 実体化上限 10,000 行 / UPSERT 系はこれに書き込み先 APP の照合読み取りが加わる（**temp 化では回避されない**） |
| 書き込み側ガード | 不変（書き込み前 confirm / `dmlMaxRows` / `dmlTotalMaxRows`。超過時は当該文ゼロ書き込み。DML バッチは非アトミックのため前段の成功文は残る） |
| description / describe | 「but not both in one statement」「for app sources only」を撤回し統合文言へ。`dmlMaxRows` describe（mutate / run_saved_query 両方）を「caps app-source reads（temp は実体化 10,000 行で別建て）」に更新 |
| smoke 回帰ガード | description キーを新文言に差し替え（旧バンドルで失敗確認後に適用）。describe キーも `"caps app-source reads"` に差し替え |
| 挙動変化 | 従来 `ArgumentError` だった呼び出しが成功（= 書き込み発生）するようになる。既存の成功ケースは不変 |

## 11.10 SELECT-based DML のソース読み取り上限を dmlMaxRows から分離（v1.8.0）

v1.7.0 の実機確認で、MCP クライアントが影響行数基準で小さい `dmlMaxRows`（例: 2）を
選んだ結果、UPSERT_SELECT の JOIN ソース読み取り（APP 全件走査）が
`maxRecords = dmlMaxRows + 1` で上限エラーになる実害を確認した。
`dmlMaxRows` の describe に読み取りキャップの記載があっても誤設定は防げなかったため、
説明改善ではなく上限自体を分離した（案A。経緯・対策比較:
`docs/internal/ksql_mcp_dml_source_read_limit_issue.md`）。

| 変更 | 内容 |
| --- | --- |
| 読み取り上限の分岐 | SELECT-based DML（INSERT_SELECT / UPSERT_SELECT）を含む `ksql_mutate` は `createRuntime` へ `maxRecords` を上書きせず、runtime の通常解決（`KSQL_MAX_RECORDS` → profile `query.maxRecords` → 500）に委ねる。含まない DML は従来どおり `dmlMaxRows + 1`。CLI の `--max-records` / `--dml-max-rows` 分離と同じモデル |
| dmlMaxRows の意味 | 影響行数ガード専用に純化（confirm フック。UPSERT 系は insert + update 合計）。ソース読み取り・UPSERT 照合読み取りを絞らない |
| エラーヒント | SELECT-based DML の読み取り上限超過エラー（`取得件数が上限...`）に「読み取り上限は maxRecords 解決値で制御され、dmlMaxRows は影響行数ガード」のヒントを付与（単文 = 例外メッセージ、バッチ = 当該文の error.message） |
| description / describe | ツール description を「dmlMaxRows caps affected rows only, not source reads」へ、`dmlMaxRows` describe（mutate / run_saved_query 両方）を「does NOT limit source reads ... runtime maxRecords resolution」へ更新。run_saved_query 側には「maxRecords / onLimit 入力は read-only 保存 SQL のみ有効」も明記 |
| smoke 回帰ガード | describe キーを `"does NOT limit source reads"` / `"runtime maxRecords resolution"` に、description キーに `"caps affected rows only, not source reads"` を追加（旧バンドル相当の文言で失敗することを確認後に適用） |
| 挙動変化 | ①従来読み取り上限エラーだった JOIN・集計ソースの SELECT-based DML が、影響行数が `dmlMaxRows` 以内なら成功する。②UPSERT_SELECT の照合読み取り（第1キー低選択性）も runtime `maxRecords` に従い、「source 1 行でも安全側エラー」が解消。③書き込みガード（confirm / dmlMaxRows / dmlTotalMaxRows）は不変 |

## 11.11 一時テーブル実体化上限の可変化 — tempTableMaxRows（v1.11.0）

一時テーブル1個の実体化行数上限（従来 10,000 固定）を、エンジン既存の
`BatchExecuteOptions.tempTableMaxRows` を入口公開する形で変更可能にした
（仕様: `docs/internal/ksql_temp_table_max_rows_option_spec.md`）。

| 変更 | 内容 |
| --- | --- |
| MCP tool input | `ksql_query` / `ksql_mutate` に `tempTableMaxRows`（正整数・任意）を追加。解決順は tool input → env `KSQL_TEMP_TABLE_MAX_ROWS` → profile `query.tempTableMaxRows` → エンジン既定 `TEMP_TABLE_MAX_ROWS`（10,000） |
| 非公開ツール | `ksql_run_saved_query` には追加しない（保存クエリは単文限定で一時テーブルが出現し得ない）。同ツールの `dmlMaxRows` describe から temp table 節を削除し「saved queries are single-statement」を明示（存在しない入力をモデルに示唆しない） |
| CLI | `--temp-table-max-rows <n>` を追加（env / profile の解決は MCP と対称）。console の `:run` 子実行にも伝搬 |
| セマンティクス不変 | 既定 10,000・**超過は `onLimit` 設定によらず常にエラー**（truncate 不適用）は変更なし。素の SELECT の `maxRecords` / `onLimit` とは独立 |
| EXPLAIN | CREATE TEMP TABLE のプラン行を「既定上限 10,000 行、tempTableMaxRows で変更可」表記に変更（静的プランのため実効値は表示しない） |
| smoke 回帰ガード | schema に `tempTableMaxRows`（query / mutate）、description キーに `"by default (adjustable via tempTableMaxRows)"`、run_saved_query の非公開・非言及 assertion を追加（旧バンドルで失敗することを確認後に適用） |
| 注意 | 上限を引き上げるとバッチ内最大16テーブル × 指定値がメモリに滞留し得る（参照は常にインメモリ FULL_SCAN）。まず WHERE での絞り込みを推奨 |

## 11.12 GROUP BY なし集計の 0 件時「1 行」返却（v1.12.0）

GROUP BY のない集計 SELECT が対象 0 件のとき「0 行」ではなく「1 行（COUNT = 0、
SUM/AVG/MAX/MIN = 0）」を返すようにした（SQL 標準準拠化。エンジン層の変更で
MCP のスキーマ・ツール実装は無変更。仕様: `docs/internal/ksql_ungrouped_aggregate_empty_result_spec.md`）。

| 変更 | 内容 |
| --- | --- |
| 動機 | 健全性チェックの定番 `ASSERT (SELECT COUNT(*) ... WHERE 異常条件) = 0` が健全時（該当 0 件）にこそ `AssertError: scalar subquery returned no rows` で失敗していた（言語リファレンス自身の CLI 例が実行不能だった） |
| `ksql_query` / `ksql_mutate` で観測可能な変化 | 0 件集計 SELECT が 1 行を返す / ASSERT `= 0` ゲートが成立 / WHERE・SELECT 列・UPDATE SET のスカラーサブクエリが `0` に解決 / `IN (SELECT COUNT(*)...)` が `{0}` 照合 / **`EXISTS (SELECT COUNT(*)...)` が常に真**（従来 0 件で偽） / `CREATE TEMP TABLE ... AS SELECT COUNT(*)` が 0 件でも 1 行実体化 / `INSERT ... SELECT COUNT(*)` が 0 件でも 1 行書き込み（confirm / `dmlMaxRows` 判定に 1 行として乗る） |
| 不変 | GROUP BY ありの空入力は 0 行のまま。ASSERT の 0 行 / 複数行 / 複数列エラーは維持（0 行エラーは非集計プローブの空振り等に限られる） |
| メタデータ | 更新なし（grep で確認 — 旧挙動を前提にした describe / description は存在せず、新挙動は標準 SQL でモデルの既定想定と一致） |

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

直近の確認結果(v1.7.0 時点):

```text
npm test: 616 tests passed
npm run build: passed
npm run mcp:verify: passed
npm audit --omit dev: 0 vulnerabilities
git diff --check: passed
tsc --noEmit: 既存 10 件のみ(src/ui/desktop.ts。新規エラーなし)
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
