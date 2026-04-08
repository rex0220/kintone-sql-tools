# kSQL CLI / Console モード仕様

- 作成日: 2026-04-06
- 版: Ver.1
- 対象: `ksql` プロジェクト（kintone SQL プラグインと同一リポジトリ）
- 目的: `cli-kintone` ライクな操作感で、SQL の単発実行と対話実行を提供する

## 1. スコープ

本仕様で扱う機能は以下とする。

1. 非対話実行（`-e`, `-f`）
2. 対話コンソール（REPL）実行（`--console`）
3. 出力整形（table/json）
4. 安全実行（`--dry-run`、取得件数ガード）
5. 設定ファイルとプロファイル

Ver.1 では `SELECT` を既定とする。
`UPDATE` / `DELETE` / `INSERT` / `UPSERT` は DML Phase 1 で導入し、`--allow-dml` 指定時のみ実行可能とする。

本仕様で扱わないものは以下とする。

1. SQL 補完の高度化（フィールド名推論など）
2. 複数接続先の同時セッション管理
3. 完全 RDBMS 互換（トランザクション、サーバーサイド JOIN 最適化など）は構造上非対応

## 2. コマンド名・配布方針

1. 実行コマンド名は `ksql`
2. npm パッケージ名は `cli-ksql` もしくは `@rex0220/cli-ksql`
3. リポジトリは既存 `ksql` と兼用し、CLI は同一コードベースで実装する

## 3. 想定ディレクトリ構成

```text
kintone-sql-tools/
  src/
    core/        # lexer/parser/AST/変換/実行ロジック（UI非依存）
    ui/          # kintone plugin UI 層
    cli/         # CLI 層（引数、REPL、表示）
    api/ converter/ engine/ lexer/ parser/ types/
  docs/
    ksql_cli_console_spec.md
    examples/
      ksql.config.sample.json
  dist/          # plugin build 出力
  dist-cli/      # CLI build 出力
  prod/          # plugin pack 対象
  plugin/
  build.mjs      # plugin build
  build-cli.mjs  # cli build
  package.json
  tsconfig.json
```

## 4. CLI 基本仕様

## 4.1 実行形式

1. 文字列実行: `ksql -e "SELECT * FROM APP100"`
2. ファイル実行: `ksql -f ./query.sql`
3. 対話実行: `ksql --console`

`-e` と `-f` が同時指定された場合はエラーとする。

## 4.2 オプション

接続系:

1. `--base-url <url>`
2. `--guest-space-id <id>`（ゲストスペース指定。指定時は `/k/guest/<id>/v1` を利用）
3. `--username <name>`
4. `--password <pass>`
5. `--token <token>`（単一APP向け）
6. `--token-map <mapping>`（複数APP向け、例: `APP100=xxx,APP101=yyy`）
7. `--token-file <path>`（複数APP向けJSON）
8. `--auth <type>` (`userpass | token | auto`)

実行系:

1. `-e, --execute <sql>`
2. `-f, --file <path>`
3. `--console`
4. `--app <id>`
5. `--diag-record-id <id>`
6. `--max-records <n>`
7. `--on-limit <error|truncate>`

出力系:

1. `--format <table|json|jsonl|csv>`
2. `--no-header`
3. `--pretty`
4. `--output <path>`
5. `--no-color`
6. `--quiet`
7. `--exit-on-empty`
8. `--user-format <full|name|code>`
9. `--array-format <full|join>`
10. `--table-format <full|count>`
11. `--date-format <full|local>`
12. `--attachment-format <full|name|fileKey>`

安全・挙動系:

1. `--dry-run`
2. `--timeout <ms>`
3. `--debug`
4. `--debug-url`
5. `--debug-headers`
6. `--allow-dml`
7. `--yes`
8. `--allow-without-where`
9. `--dml-max-rows <n>`

設定系:

1. `--config <path>`
2. `--profile <name>`

その他:

1. `-h, --help`
2. `-v, --version`

## 4.3 終了コード

1. `0`: 正常終了
2. `1`: SQL/パース/実行エラー
3. `2`: 引数エラー
4. `3`: 認証/接続エラー

## 4.5 出力仕様（Ver.1）

現行プラグイン相当として、以下の表示整形を CLI に持ち込む。

1. ユーザー型表示（`--user-format`）
2. 配列表示（`--array-format`）
3. サブテーブル表示（`--table-format`）
4. 日付表示（`--date-format`）
5. 添付表示（`--attachment-format`）
6. 上限到達時動作（`--on-limit`）

CLI 追加として以下を提供する。

1. `jsonl`/`csv` 出力
2. ファイル出力（`--output`）
3. ANSI色抑止（`--no-color`）
4. ログ抑止（`--quiet`）
5. 0件時終了コード制御（`--exit-on-empty`）

## 4.4 認証仕様（token）

1. kintone API token はアプリ単位として扱う
2. 複数APPを参照するSQLでは `--token-map` または `--token-file` を使用する
3. `--token` は単一APP実行時のみ許可する（`--app` または SQL 解析で単一APPが確定する場合）
4. 必要APPの token が不足する場合は実行前にエラー終了する
5. `--auth token` 指定時の token 解決優先順位は以下とする

優先順位（高い順）:

1. `--token-map`
2. `--token-file`
3. `KSQL_TOKEN_MAP` 環境変数
4. config (`profiles.<name>.tokenMap` など)
5. `--token` / `KSQL_TOKEN`（単一APPのみ）

## 4.6 APP@profile（CLI 拡張）

1. CLI ではテーブル参照末尾に `@profile` を指定可能（例: `APP100@dev`, `app100@dev`, `APP80$明細@guest`）
2. `@profile` なしの `APPxxx` は既定 profile を使用する
3. 同一SQL内で同一APPに異なるprofileを指定しても許可する（別環境の別アプリとして扱う）
4. plugin 側では `@profile` をサポートしない
5. `@profile` は `INSERT/UPDATE/UPSERT` で使用可能、`DELETE` は未対応として実行前にエラー終了する
6. `app100@プロファイル名` のような指定は「`app100` をその profile で実行する」意味になる（APP 部分は大小文字非区別）

## 4.7 FROM 省略 SELECT

1. `SELECT 'xxx' AS a` のような `FROM` 省略を許可する
2. `SELECT 'ABC' as a;` のように `as` 小文字・末尾セミコロン付きでも許可する
3. `FROM` 省略時は1行評価として返す（API呼び出しなし）
4. `SELECT *` / フィールド参照列は `FROM` 省略時はエラー

## 5. コンソール（REPL）仕様

## 5.1 起動

`ksql --console` で対話モードに入る。

初期表示例:

```text
kSQL Console (type :help)
session:
  profile=(default)
  auth=(auto)
  format=(default)
  dryrun=off
  allow-dml=off
ksql>
```

## 5.2 入力規則

1. SQL は `;` で終端して実行する
2. 複数行入力を許可する
3. 空行のみは無視する
4. `Ctrl+C` は現在入力のキャンセル
5. `Ctrl+D` または `:exit` で終了

## 5.3 メタコマンド

| コマンド | 説明 |
|---|---|
| `:help` | コマンド一覧を表示 |
| `:exit` / `:quit` | console を終了 |
| `:clear` | 入力バッファをクリア |
| `:last` | 直前に実行した SQL を表示 |
| `:buffer` | 現在の入力バッファ内容を表示 |
| `:edit` | 現在の入力バッファを外部エディタで編集して反映（空バッファ時は `:last` 相当を初期表示） |
| `:show config` | 現在の実行設定（profile/format/dryrun など）と直近SQLの `resolved-app-profiles` を表示 |
| `:history` | 実行履歴を表示 |
| `:history <n>` | 直近 `n` 件の履歴を表示 |
| `:history find <keyword>` | キーワードを含む履歴を表示 |
| `:rerun <n>` | 履歴 `n` 番を再実行 |
| `:save <path>` | 直前の実行結果をファイル保存 |
| `:save --append <path>` | 直前の実行結果を追記保存 |
| `:profile <name>` | 実行時 profile を切替 |
| `:format table|json|jsonl|csv` | 出力形式を切替 |
| `:dryrun on|off` | dry-run を切替 |

`Ctrl+C` は入力バッファキャンセル（空バッファ時は 2 回で終了）、`Ctrl+D` は正常終了。

## 5.4 実行フロー

1. 入力 SQL を Lexer/Parser で AST 化
2. AST を kintone API 実行計画へ変換
3. `--dry-run` または `:dryrun on` 時は計画のみ表示
4. 実行時は API 呼び出し結果を整形表示

## 5.5 更新系クエリの安全制御

対象: `UPDATE`, `DELETE`, `INSERT`, `UPSERT`

1. `--allow-dml` 指定時のみ DML を許可する
2. `--yes` 未指定時は対話モード確認プロンプトを既定ONとする
3. `--yes` 明示時のみ確認省略可とする
4. `UPDATE` / `DELETE` の `WHERE` なしは既定で禁止する
5. `--dml-max-rows` 超過時は実行前に拒否する
6. 確認入力は `yes/no`（大小文字・前後空白は非区別）で判定する
7. 端末依存で同一キー重複入力が起きるケース（例: `yyeess`）は `yes` と同値に扱う

## 5.6 Ver.1 安全ポリシー（DML Phase 1 反映）

1. 非SELECT文は `--allow-dml` 未指定時に実行禁止（終了コード `2`）
2. `--dry-run` では API 実行せず、実行計画のみを表示する
3. `--max-records` の既定値は `500` とし、超過時は打ち切り＋警告する
4. `--timeout` の既定値は `30000ms` とする
5. 認証情報はログに出力しない（`--debug` 時もマスク）
6. `APPxxx` 形式不正・APP解決不能時は実行前にエラー終了する
7. DML 実行時は確認プロンプトを既定有効（`--yes` で省略）とする

## 6. 設定ファイル仕様

ファイル名既定: `./ksql.config.json`

```json
{
  "$schema": "https://example.com/ksql.config.schema.json",
  "version": 1,
  "defaultProfile": "dev",
  "profiles": {
    "dev": {
      "baseUrl": "https://example.kintone.com",
      "auth": "token",
      "app": 100,
      "tokenMap": {
        "APP100": "env:KSQL_TOKEN_APP100",
        "APP101": "env:KSQL_TOKEN_APP101"
      },
      "query": {
        "maxRecords": 500,
        "onLimit": "error",
        "timeout": 30000
      },
      "output": {
        "format": "table",
        "pretty": false,
        "noHeader": false,
        "noColor": false,
        "quiet": false,
        "exitOnEmpty": false,
        "userFormat": "name",
        "arrayFormat": "join",
        "tableFormat": "count",
        "dateFormat": "local",
        "attachmentFormat": "name"
      }
    },
    "guest": {
      "baseUrl": "https://example.kintone.com",
      "guestSpaceId": 5,
      "auth": "token",
      "app": 200,
      "tokenMap": {
        "APP200": "env:KSQL_TOKEN_APP200",
        "APP201": "env:KSQL_TOKEN_APP201"
      }
    }
  }
}
```

優先順位（高い順）:

1. CLI 引数
2. 環境変数
3. 設定ファイル
4. 既定値

運用ルール:

1. `tokenMap` では `env:KEY` 記法を許可する（機密値の直書き非推奨）
2. `defaultProfile` 未指定時は `dev` を既定選択する
3. `guestSpaceId` を指定した profile はゲストスペース API パスを使用する

## 7. エラー表示方針

1. ユーザー向けの短い要約を先に表示
2. `--debug` で原因詳細を追加
3. `--debug-url` で実HTTPリクエストURLのみを表示
4. `--debug-headers` でマスク済みヘッダーを表示
5. パースエラーは位置情報（行・列）を必ず表示

表示例:

```text
[ParseError] Unexpected token near "FROMM" at line 1, column 15
hint: Did you mean "FROM"?
```

## 8. プラグイン構成との整合

1. SQL 言語仕様はプラグインと CLI で共通にする
2. 実行エンジン（AST→kintone API）は `src/core` に集約する
3. `src/ui` は画面イベントと表示に限定する
4. `src/cli` は入力受付と表示に限定する

この分離により、仕様差分と不具合修正を単一実装で管理できる。

## 9. 実装済み機能（Ver.1）

1. 非対話実行（`-e` / `-f`）
2. 対話 console（`--console`）と複数行入力
3. 表示形式切替（`table/json/jsonl/csv`）
4. dry-run（実API未実行）
5. 認証（`token` / `userpass` / `auto`）
6. profile / config 読み込み
7. DML 安全制御（`--allow-dml`, `--yes`, `--dml-max-rows`）
8. 履歴表示・再実行・保存（`:history`, `:rerun`, `:save`）
9. バッファ表示・外部編集（`:buffer`, `:edit`）
10. 診断GET・デバッグ表示（`--diag-record-id`, `--debug-url`, `--debug-headers`）

## 10. 既知の制約

1. kintone API 上限により大量データ取得は分割実行が必要
2. SQL の一部演算はクライアント側後処理になる
3. RDBMS のトランザクション保証とは異なる

---

本仕様は現行CLI仕様であり、`docs/kintone_sql_plugin_spec.md` の SQL 仕様と矛盾する場合は同仕様を優先する。
