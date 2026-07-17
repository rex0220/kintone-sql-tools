# kSQL MCP サーバー実装手順

- 作成日: 2026-05-24
- 対象: `kintone-sql-tools`
- 関連仕様: `docs/ksql_mcp_server_spec.md`
- 目的: kSQL MCP サーバーを段階的に実装するための作業順序、変更対象、テスト観点を定義する

> **v3.0.0で変更:** 本書中の「`ksql_explain`はAPIを呼ばない」は初期実装時の履歴である。現行契約は、フォーム定義と必要時のプロセス状態metadataを取得するが、レコード取得・書込みAPIは呼ばない。

## 1. 実装方針

初期実装は read-only MCP サーバーとする。

最初から DML や保存 SQL まで入れると、安全制御・永続化・MCP 接続検証が同時に膨らむため、以下の順に進める。

1. read-only MVP
2. CLI runtime の共通化
3. 保存 SQL
4. 承認付き DML
5. 接続例・運用ドキュメント

重要な方針:

1. `execute(sql, client, options)` を MCP から直接利用する
2. `ksql_query` は read-only 文だけ許可する
3. DML は `ksql_mutate` に分離する
4. `APP@profile`、config、auth 解決は CLI と MCP で同じ実装を使う
5. AI が誤認しないよう、取得上限到達時は明示的にエラーまたは warning を返す
6. 既存 CLI / Plugin の挙動を壊さない
7. MCP tool result は常に構造化 JSON とし、CLI の `format` 概念を持ち込まない
8. config path は tool input ではなく MCP サーバー起動引数で固定する

## 2. ブランチと作業単位

推奨ブランチ:

```bash
git switch -c codex/add-ksql-mcp-server
```

推奨コミット単位:

1. `Add MCP server spec and implementation plan`
2. `Add read-only MCP server entrypoint`
3. `Extract shared node runtime for CLI and MCP`
4. `Add saved query catalog for MCP`
5. `Add guarded MCP mutation tool`

実装は Phase 1 までで一度 PR 可能にする。

## 3. 事前確認

## 3.1 現状テスト

作業開始前に既存テストを確認する。

```bash
npm test -- --runInBand
```

期待:

1. 既存テストがすべて成功する
2. 失敗がある場合は MCP 実装前に原因を切り分ける

## 3.2 現状の依存境界

確認するファイル:

| ファイル | 確認内容 |
|---|---|
| `src/core/index.ts` | MCP から再利用する公開 API |
| `src/execute.ts` | `execute()`、`ExecuteOptions`、`KintoneClient` |
| `src/cli/index.ts` | config/profile/auth/DML guard の現状 |
| `src/cli/nodeKintoneClient.ts` | Node.js 用 kintone client |
| `build-cli.mjs` | esbuild 設定 |
| `package.json` | bin/scripts/files/devDependencies |

注意:

1. `parseSqlStatement` は `src/core/index.ts` から公開済み
2. `ExecuteOptions` は現状 `src/core/index.ts` から公開されていない
3. MCP 実装で `ExecuteOptions` 型が必要な場合は、`src/execute.ts` から直接 import するか、`src/core/index.ts` の type export に追加する

## 4. Phase 1: read-only MCP MVP

## 4.1 MCP SDK を追加

MCP TypeScript SDK を追加する。

候補:

```bash
npm install --save-dev @modelcontextprotocol/sdk zod
```

`ksql-mcp` は `dist-mcp/ksql-mcp.js` に完全 bundle して配布するため、SDK と schema validation 用の `zod` は runtime `dependencies` ではなく `devDependencies` に置く。

確認:

```bash
npm test -- --runInBand
```

## 4.2 build-mcp.mjs を追加

追加ファイル:

```text
build-mcp.mjs
```

内容:

1. `src/mcp/index.ts` を entry point にする
2. `dist-mcp/ksql-mcp.js` に bundle する
3. `platform: "node"`
4. `target: ["node18"]`
5. `format: "cjs"`
6. shebang を付与する

`build-cli.mjs` と同じ書き方に寄せる。

## 4.3 package.json を更新

変更:

```json
{
  "bin": {
    "ksql": "dist-cli/ksql.js",
    "ksql-mcp": "dist-mcp/ksql-mcp.js"
  },
  "scripts": {
    "build": "npm run build:plugin && npm run build:cli && npm run build:mcp",
    "build:mcp": "node build-mcp.mjs"
  },
  "files": [
    "dist-cli/",
    "dist-mcp/",
    "README.md",
    "LICENSE",
    "package.json"
  ]
}
```

注意:

1. `prepack` で MCP build も実行する
2. npm パッケージ利用者に MCP SDK / zod を runtime dependency としてインストールさせない

依存関係の方針:

Phase 1 MVP では `ksql` と `ksql-mcp` を同一 npm package に含める。
ただし、`@modelcontextprotocol/sdk` と `zod` は `build:mcp` 時に `dist-mcp/ksql-mcp.js` へ bundle するため、`devDependencies` に置く。

理由:

1. CLI / Plugin だけを使う npm 利用者に MCP SDK を取得させない
2. `optionalDependencies` にすると `npm install --no-optional` で `ksql-mcp` が壊れる
3. 完全 bundle なら `bin.ksql-mcp` は devDependencies なしの利用者環境でも起動できる
4. 別 package 化は依存分離としては理想だが、MVP では管理対象が増える

公開前の確認では、`npm pack` した tarball を devDependencies なしの環境に install し、`dist-mcp/ksql-mcp.js --help` と API なし smoke test が動くことを確認する。

MCP が大きくなり bundle size や release 管理が問題になる場合は、Phase 2 以降で `@rex0220/ksql-mcp` のような別 package 化を再評価する。

## 4.4 Phase 1 で必要な最小共通化

Phase 1 でも `APP@profile` は対応する。
複数環境比較は kSQL MCP の主要な差別化要素であるため、Phase 2 まで先送りしない。

追加または切り出し候補:

```text
src/node/appProfiles.ts
```

切り出す関数:

1. `normalizeSqlAppProfiles`
2. `extractAppIds`
3. `normalizeAppKey`
4. `parseTokenMap`
5. `parseTokenFile`

切り出し後の確認:

```bash
npm test -- --runInBand
```

Phase 1 では CLI 全体を共通 runtime に寄せなくてもよい。
ただし MCP が `APP100@prod` のような SQL を扱えるよう、`APP@profile` 正規化だけは先に共有する。

config path は MCP サーバー起動時に読み込む。
tool input には `configPath` を含めない。

起動時オプション例:

```bash
node dist-mcp/ksql-mcp.js --config ./ksql.config.json --profile prod
```

## 4.5 src/mcp ディレクトリを追加

追加ファイル:

```text
src/mcp/index.ts
src/mcp/tools.ts
src/mcp/schemas.ts
src/mcp/errors.ts
```

役割:

| ファイル | 役割 |
|---|---|
| `index.ts` | MCP server 起動、stdio transport 接続 |
| `tools.ts` | `ksql_query` / `ksql_explain` / `ksql_validate` などの実装 |
| `schemas.ts` | tool input schema |
| `errors.ts` | エラーの構造化変換 |

## 4.6 最小ツールを実装

Phase 1 で実装するツール:

1. `ksql_explain`
2. `ksql_query`
3. `ksql_validate`
4. `ksql_describe_app`
5. `ksql_show_apps`

`ksql_describe_app` と `ksql_show_apps` は Phase 1 の必須範囲とする。
AI が SQL を組み立てる前に、アプリ一覧とフィールド定義を確認できる必要があるためである。

## 4.7 read-only 判定を実装

実装候補:

1. `parseSqlStatement(sql)` を呼ぶ
2. statement type を判定する
3. read-only 文だけ許可する

read-only として許可:

1. `SELECT`
2. `UNION`
3. `WITH`
4. `EXPLAIN`
5. `SHOW_APPS`
6. `DESCRIBE`

拒否:

1. `INSERT`
2. `INSERT_SELECT`
3. `UPDATE`
4. `UPSERT`
5. `UPSERT_SELECT`
6. `DELETE`
7. `REORDER`

この判定は後で `src/node/dmlGuard.ts` に移す前提で、初期実装では `src/mcp/tools.ts` 内に小さく持ってよい。

## 4.8 ksql_explain の実装

入力:

```ts
{
  sql: string;
  profile?: string;
}
```

処理:

1. SQL が空でないことを確認
2. `EXPLAIN ` を先頭につける
3. dry-run client で `execute()` を呼ぶ
4. 結果を構造化して返す

注意:

1. `EXPLAIN` 自体が渡された場合は二重にしない
2. `ksql_explain` は kintone API を呼ばない
3. config / auth は不要にできる
4. tool input に `configPath` は含めない
5. TypeScript の型要件を満たすため、no-op `KintoneClient` を渡す

no-op client は、実際に呼ばれたら例外を投げる実装でよい。
`EXPLAIN` 実行では client は利用されない。

```ts
const noOpClient: KintoneClient = {
  getRecords: async () => { throw new Error("No-op client should not be called."); },
  postRecords: async () => { throw new Error("No-op client should not be called."); },
  putRecords: async () => { throw new Error("No-op client should not be called."); },
  deleteRecords: async () => { throw new Error("No-op client should not be called."); },
  getApps: async () => { throw new Error("No-op client should not be called."); },
  getFields: async () => { throw new Error("No-op client should not be called."); },
};
```

## 4.9 ksql_query の実装

入力:

```ts
{
  sql: string;
  profile?: string;
  maxRecords?: number;
  onLimit?: "error" | "truncate";
  timeout?: number;
}
```

処理:

1. SQL を parse
2. read-only 文か確認
3. config/profile/auth を解決
4. `KintoneClient` を作る
5. `execute(sql, client, options)` を呼ぶ
6. `SelectResult` を構造化して返す

初期実装では、CLI の `run()` を内部呼び出しして stdout を parse する方式は避ける。
MCP は `execute()` を直接呼ぶ。

実装上の注意:

1. `format` は input schema に入れない
2. `maxRecords` は `input.maxRecords ?? 500` を `execute()` に必ず渡す
3. `onLimit` は `execute()` の `onLimitReached` に明示的にマッピングする
4. `timeout` は `execute()` option ではなく `createNodeKintoneClient()` の `timeoutMs` に渡す
5. `APP@profile` 正規化後の SQL と `cacheContext` を使う

## 4.10 ksql_validate の実装

入力:

```ts
{
  sql: string;
  profile?: string;
}
```

返す情報:

1. `statementType`
2. `isDml`
3. `isReadOnly`
4. `appIds`
5. `hasWhere`
6. `insertValuesCount`
7. `canRunWithQueryTool`
8. `requiresMutationTool`

初期実装では CLI 内の private helper をコピーしすぎない。
Phase 2 で共通化する。

## 4.11 エラー形式を統一

MCP tool result は以下の形に寄せる。

```json
{
  "ok": false,
  "error": {
    "code": "ArgumentError",
    "message": "DML is not allowed by ksql_query.",
    "details": {
      "statementType": "UPDATE"
    }
  }
}
```

方針:

1. 認証情報は出さない
2. token / password は絶対に返さない
3. kintone API エラー本文に機密が含まれる可能性を考慮する
4. `--debug-headers` 相当は MCP MVP では提供しない

## 4.12 Phase 1 テスト

追加候補:

```text
src/mcp/__tests__/tools.test.ts
```

テスト項目:

1. `ksql_explain` は `SELECT` の実行計画を返す
2. `ksql_explain` は API client を呼ばない
3. `ksql_query` は SELECT を許可する
4. `ksql_query` は UPDATE を拒否する
5. `ksql_validate` は DML を判定する
6. parse error を構造化 error に変換する
7. `maxRecords` が既定 500 で `execute()` options に渡る
8. `onLimit` が `onLimitReached` として `execute()` options に渡る
9. `timeout` が HTTP client の `timeoutMs` に渡る
10. `format` と `configPath` が tool input schema に存在しない
11. `APP100@prod` の SQL が正規化される

実行:

```bash
npm test -- --runInBand
npm run build:mcp
```

Phase 1 完了条件:

1. `npm test -- --runInBand` が成功
2. `npm run build:mcp` が成功
3. `node dist-mcp/ksql-mcp.js --help` または起動確認ができる
4. read-only DML 拒否テストがある
5. `APP@profile` 正規化テストがある

## 5. Phase 2: CLI runtime 共通化

Phase 1 では MCP から `execute()` を直接呼べても、config/profile/auth 解決が CLI に残る。
このままだと CLI と MCP の挙動が分岐するため、Phase 2 で共通化する。

## 5.1 src/node/config.ts

切り出すもの:

1. `CliConfig` 型
2. config 読み込み
3. profile 取得
4. 環境変数 helper
5. `env:` 参照解決

公開 API 候補:

```ts
export interface KsqlConfig { ... }
export function loadKsqlConfig(path: string): KsqlConfig;
export function resolveProfileName(input: ResolveProfileNameInput): string;
```

## 5.2 src/node/appProfiles.ts

切り出すもの:

1. `normalizeSqlAppProfiles`
2. `extractAppIds`
3. `normalizeAppKey`
4. `parseTokenMap`
5. `parseTokenFile`

既存 CLI テストを移動または追加する。

Phase 1 でこのファイルを先行作成した場合、Phase 2 では CLI 側をこの実装へ寄せる。

## 5.3 src/node/runtime.ts

責務:

1. config/profile/auth を解決する
2. profile ごとの `KintoneClient` を生成する
3. `APP@profile` の mapped appId を実 appId に戻す routing client を作る
4. `cacheContext` を生成する

公開 API 候補:

```ts
export interface CreateRuntimeInput {
  sql?: string;
  serverConfigPath?: string;
  profile?: string;
  maxRecords?: number;
  onLimit?: "error" | "truncate";
  timeout?: number;
}

export interface KsqlRuntime {
  sql: string;
  client: KintoneClient;
  cacheContext: string;
  maxRecords: number;
  onLimit: "error" | "truncate";
  timeout: number;
}

export async function createKsqlRuntime(input: CreateRuntimeInput): Promise<KsqlRuntime>;
```

`serverConfigPath` は MCP サーバー起動時に解決した値を渡す内部引数であり、tool input として公開しない。

## 5.4 src/node/dmlGuard.ts

切り出すもの:

1. statement type 判定
2. DML 判定
3. WHERE 有無判定
4. INSERT 行数判定
5. DML 対象フィールド収集
6. read-only 判定

公開 API 候補:

```ts
export function getStatementType(stmt: Statement): string;
export function isDmlStatementType(type: string): boolean;
export function isReadOnlyStatementType(type: string): boolean;
export function validateReadOnlySql(sql: string): ReadOnlyValidationResult;
```

## 5.5 CLI を共通 runtime に寄せる

変更対象:

```text
src/cli/index.ts
```

進め方:

1. 既存テストを見ながら小さく切り出す
2. private helper を一度に大量移動しない
3. 移動した関数には既存テストを移植する
4. CLI の終了コードと stderr 文言は原則維持する

確認:

```bash
npm test -- --runInBand
npm run build:cli
npm run build:mcp
```

Phase 2 完了条件:

1. CLI テストが成功
2. MCP テストが成功
3. `ksql` と `ksql-mcp` が同じ config/profile 解決を使う
4. `APP@profile` の既存挙動が変わらない
5. MCP tool input ではなくサーバー起動時の config path を使う

## 6. Phase 3: 保存 SQL

## 6.0 Phase 3 着手条件

保存 SQL の実装前に、以下を決定する。

決定済みの方針:

1. 既定の保存先はプロジェクトローカルの `.ksql/queries.json`
2. `.ksql/queries.json` は個人用のローカルカタログとして扱い、commit しない
3. 保存先を変える場合は tool input ではなく、`ksql.config.json` の `mcp.savedQueries.path` で指定する
4. 同名保存は上書きし、`createdAt` は維持して `updatedAt` を更新する
5. query name は ASCII 英数字開始、英数字・`_`・`-` のみ、最大 64 文字

profile override の方針:

1. 保存 SQL は `defaultProfile` を持つ
2. 実行時 profile override は既定で禁止する
3. override を許可する場合は `allowProfileOverride: true` を保存 SQL に明示する
4. override 実行時も validate と EXPLAIN を再実行する

## 6.1 保存先を決める

初期実装:

```text
.ksql/queries.json
```

設定例:

```json
{
  "mcp": {
    "savedQueries": {
      "path": ".ksql/queries.json"
    }
  }
}
```

優先順位:

1. `KSQL_SAVED_QUERIES`
2. `ksql.config.json` の `mcp.savedQueries.path`
3. 既定値 `.ksql/queries.json`

`mcp.savedQueries.path` と既定値の相対パスは、`--config` で指定した config ファイルのディレクトリ基準で解決する。
Claude Desktop / Windows で `cwd` が `C:\WINDOWS\system32` になる場合でも、保存先が system32 配下にならないようにする。

一時的に上書きしたい場合:

```text
KSQL_SAVED_QUERIES=/path/to/queries.json
```

チーム共有カタログは初期実装の対象外とする。
必要になった場合は `queries/` 配下の SQL ファイル群、または別の共有 JSON を Phase 3 以降で検討する。

## 6.2 src/mcp/savedQueries.ts を追加

責務:

1. 保存ファイル読み込み
2. 保存ファイル書き込み
3. query name の validate
4. 保存形式の parse / validate
5. read-only フラグ確認
6. profile override 許可確認
7. 同名 upsert / get / delete

前準備として `src/mcp/savedQueries.ts` を追加済み。
Phase 3 本体では、このモジュールを `ksql_save_query` などの MCP tool から呼び出し、保存時・実行時の SQL validation は既存の `validate()` と接続する。

## 6.3 保存 SQL ツールを追加

追加済みツール:

1. `ksql_save_query`
2. `ksql_list_queries`
3. `ksql_get_query`
4. `ksql_run_saved_query`
5. `ksql_delete_query`

`ksql_run_saved_query` の実行方針:

1. `readOnly: true` の保存 SQL は `ksql_query` と同じ安全条件で実行する
2. `readOnly: false` の保存 SQL は `allowDml: true`、`confirmText: "yes"`、`dmlMaxRows` を実行時に要求し、`ksql_mutate` と同じ安全条件で実行する
3. 実行時 profile override は `allowProfileOverride: true` の保存 SQL のみ許可する

## 6.4 保存 SQL テスト

テスト項目:

1. SQL を保存できる
2. 同名保存は `createdAt` を維持して更新される
3. 一覧取得できる
4. 保存 SQL を実行できる
5. `readOnly: true` で DML SQL を保存できない
6. 破損 JSON を安全に扱う
7. profile override 未許可の保存 SQL は別 profile 実行を拒否する
8. DML 保存 SQL は実行時承認なしで実行できない

Phase 3 完了条件:

1. 保存 SQL の CRUD が動く
2. 保存時と実行時の両方で validation する
3. token / password を保存しない

## 7. Phase 1.5 / Phase 2: 承認付き DML

## 7.1 ksql_mutate を追加

入力:

```ts
{
  sql: string;
  profile?: string;
  allowDml: boolean;
  confirmText: "yes";
  dmlMaxRows: number;
  timeout?: number;
}
```

初期実装で許可する文:

1. `INSERT`（VALUES 形式）
2. `UPDATE`
3. `UPSERT`
4. `DELETE`
5. `REORDER`

初期実装で拒否する文:

1. `INSERT_SELECT`
2. `UPSERT_SELECT`

`INSERT_SELECT` / `UPSERT_SELECT` は、書き込み確認より前に source SELECT や既存レコード照合の API 読み取りが発生する。
また、現行 `executeInsertSelect` では `ExecuteOptions.confirm` が呼ばれない。
初期実装では、確認前に API 読み取りを行う SELECT-based DML をまとめて対象外にする。
将来対応する場合は SELECT source 件数確定後の confirm hook を追加するか、source SELECT preflight を仕様化する。

## 7.2 安全条件

必須:

1. `allowDml === true`
2. `confirmText === "yes"`
3. `dmlMaxRows` が正の整数
4. `UPDATE` / `DELETE` は WHERE 必須
5. 対象件数が `dmlMaxRows` 以下

推奨:

1. WHERE なし UPDATE / DELETE は MCP では常に拒否
2. `allowWithoutWhere` は初期実装では提供しない
3. `ksql_explain` または `ksql_validate` の直前実行を要求する設計を検討する

## 7.3 対象件数確認フロー

`UPDATE` / `DELETE` / `UPSERT` / `REORDER` の対象件数は、MCP 側で別 SELECT を組み立てて推定しない。
既存の `execute()` が対象 ID または対象件数を解決し、その後 `ExecuteOptions.confirm(count, operation)` を呼ぶ流れを利用する。

MCP 側の `confirm` 実装:

```ts
const confirm = async (count, operation) => {
  if (count > dmlMaxRows) {
    throw new Error(`ArgumentError: ${operation} affected rows (${count}) exceed dmlMaxRows (${dmlMaxRows}).`);
  }
  return confirmText === "yes";
};
```

注意:

1. `count > dmlMaxRows` はキャンセルではなく引数エラーとして扱う
2. `confirmText !== "yes"` は実行前に拒否する
3. ユーザーに対象を確認させたい場合は、`ksql_explain` と read-only SELECT を先行させる
4. `INSERT`（VALUES 形式）は `execute()` を呼ぶ前に `stmt.values.length` を確認する
5. `INSERT_SELECT` / `UPSERT_SELECT` は初期実装では拒否する
6. `UPDATE` / `DELETE` / `UPSERT` / `REORDER` の対象件数上限は `confirm` コールバック内で確認する

`INSERT`（VALUES 形式）の事前チェック例:

```ts
const stmt = parseSqlStatement(sql);
if (stmt.type === "INSERT" && stmt.values.length > dmlMaxRows) {
  throw new Error(`ArgumentError: INSERT rows (${stmt.values.length}) exceed dmlMaxRows (${dmlMaxRows}).`);
}
if (stmt.type === "INSERT_SELECT" || stmt.type === "UPSERT_SELECT") {
  throw new Error(`ArgumentError: ${stmt.type} is not supported by ksql_mutate yet.`);
}
```

## 7.4 DML テスト

テスト項目:

1. `allowDml` なしで拒否
2. `confirmText` なしで拒否
3. `dmlMaxRows` なしで拒否
4. WHERE なし UPDATE を拒否
5. 対象件数超過で拒否
6. 正常な UPDATE は `updatedCount` を返す
7. `OperationCancelledError` を構造化 error にする
8. `INSERT`（VALUES 形式）は `stmt.values.length > dmlMaxRows` で `execute()` 前に拒否する
9. `INSERT_SELECT` / `UPSERT_SELECT` は初期実装では拒否する

Phase 1.5 / Phase 2 完了条件:

1. DML は `ksql_query` では実行できない
2. DML は `ksql_mutate` でのみ実行できる
3. DML ガードのテストがある
4. 既存 CLI DML ガードテストが成功する
5. `INSERT` と `INSERT_SELECT` / `UPSERT_SELECT` の件数ガード方針がテストされている

## 8. Phase 5: 接続例と運用ドキュメント

## 8.1 README 追記

追加内容:

1. `ksql-mcp` の概要
2. インストール方法
3. Claude Desktop 接続例
4. Claude Code 接続例
5. read-only 推奨
6. 標準 kintone MCP との使い分け

## 8.2 examples を追加

候補:

```text
docs/examples/mcp.claude-desktop.json
docs/examples/mcp.prompts.md
docs/examples/mcp.saved-queries.sample.json
```

## 8.3 プロンプト例

最低限入れる例:

1. 金額集計
2. 複数アプリ JOIN
3. prod/stg 差分比較
4. 移行前後の件数・金額比較
5. 保存 SQL の実行

Phase 5 完了条件:

1. 初回利用者が設定できる
2. read-only の安全な使い方が分かる
3. 標準 kintone MCP との役割分担が分かる

## 9. 最終確認チェックリスト

実装完了前に以下を確認する。

1. `npm test -- --runInBand`
2. `npm run build`
3. `node dist-cli/ksql.js --help`
4. `node dist-mcp/ksql-mcp.js` の起動確認
5. `ksql_query` で SELECT が動く
6. `ksql_query` で UPDATE が拒否される
7. `ksql_explain` が API を呼ばない
8. `APP@profile` が MCP 経由でも動く
9. token / password が tool result に出ない
10. README / docs が更新されている

## 10. リスクと対策

| リスク | 対策 |
|---|---|
| DML 誤実行 | read-only 既定、DML ツール分離、確認必須 |
| token 漏洩 | env 参照推奨、エラー整形、debug headers 非公開 |
| 大量取得 | `maxRecords` 既定 500、`onLimit=error` 推奨 |
| CLI と MCP の挙動差分 | `src/node/` runtime 共通化 |
| SQL 生成ミス | `ksql_validate` と `ksql_explain` を先行利用 |
| 保存 SQL の誤用 | 保存時・実行時 validation |

## 11. 実装順序の推奨結論

最初に作るべきものは `ksql_query` ではなく、以下の最小セットである。

1. `ksql_validate`
2. `ksql_explain`
3. `ksql_query`

理由:

1. AI が SQL を作る前提では validation が重要
2. `EXPLAIN` で API 実行前に安全確認できる
3. `ksql_query` は read-only に限定すれば価値を早く確認できる

その後、CLI の config/profile/auth 解決を共通化し、保存 SQL と DML を段階的に追加する。
