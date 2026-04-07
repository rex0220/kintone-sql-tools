# kSQL 開発用フォルダー構成案

- 作成日: 2026-04-06
- 目的: 既存プラグイン開発フローを維持しながら、CLI/Console 機能を同一リポジトリで拡張する

## 1. 方針

1. リポジトリは `ksql` に統一し、プラグインと CLI を兼用する
2. SQL の言語処理・実行計画変換は `core` に集約する
3. 画面(UI)とCLIは入出力層として分離する
4. 既存の `prod/`, `plugin/`, `dist/` 運用は維持する

## 2. 推奨フォルダー構成

```text
ksql/
  docs/
    kintone_sql_plugin_spec.md
    ksql_cli_console_spec.md
    development_folder_structure.md

  src/
    core/
      lexer/
      parser/
      converter/
      engine/
      api/
      types/
      execute.ts
    ui/
      desktop.ts
      config.ts
      kintoneClient.ts
      renderResult.ts
      types.d.ts
    cli/
      index.ts
      repl.ts
      commands/
      formatters/
      config/

  tests/
    core/
    cli/
    integration/

  scripts/
    plugin-uploader.cjs
    npm-start.cjs
    ...

  prod/
    manifest.json
    js/
    css/
    html/
    image/

  plugin/
    js/
    config assets...

  dist/
    *.zip

  build.mjs
  build-cli.mjs
  package.json
  tsconfig.json
```

## 3. 既存構成からの対応表

現在の `src` 配下にある要素を以下へ整理する。

1. `src/lexer/*` → `src/core/lexer/*`
2. `src/parser/*` → `src/core/parser/*`
3. `src/converter/*` → `src/core/converter/*`
4. `src/engine/*` → `src/core/engine/*`
5. `src/api/*` → `src/core/api/*`
6. `src/types/*` → `src/core/types/*`
7. `src/execute.ts` → `src/core/execute.ts`
8. `src/ui/*` は現状維持（UI層）
9. `src/cli/*` を新規追加（CLI層）

## 4. レイヤ責務

`src/core`:

1. SQL解析（Lexer/Parser）
2. AST定義
3. AST→kintone API 変換
4. 実行計画と結果データ処理

依存ルール:

1. DOM / kintone画面API / CLI入出力への依存を持たない

`src/ui`:

1. kintone プラグイン画面イベント処理
2. UI表示・フォーム操作
3. `core` 呼び出しと結果反映

依存ルール:

1. `core` へ依存してよい
2. `cli` へ依存しない

`src/cli`:

1. 引数解釈（`-e`, `-f`, `--console` 等）
2. REPL（対話入力）
3. 出力整形（table/json）
4. `core` 呼び出し

依存ルール:

1. `core` へ依存してよい
2. `ui` へ依存しない

## 4.1 依存方向（固定）

1. `ui -> core`
2. `cli -> core`
3. `core` は上位レイヤへ依存しない

## 4.2 core 公開API案

`src/core` から外部に公開する主要関数を限定する。

1. `parse(sql) -> AST`
2. `plan(ast, context) -> ExecutionPlan`（dry-run/EXPLAIN用途）
3. `execute(sql|ast, client, options) -> ExecuteResult`
4. `formatValue(value, options)`（UI/CLI共通表示整形の最小単位）

上記以外の内部モジュール（lexer/parser詳細、変換ヘルパー等）は
原則として `core` 内部実装として扱う。

## 5. ビルド・実行の分離

1. `build.mjs`: プラグイン向けビルド（既存維持）
2. `build-cli.mjs`: CLI向けビルド（新規）
3. npm script は `build:plugin` / `build:cli` / `build`（集約）で整理する

## 6. テスト構成

1. `tests/core`: SQL仕様・変換仕様の主テスト
2. `tests/cli`: 引数/ヘルプ/REPLメタコマンド
3. `tests/integration`: 実行フローの結合確認

優先度は `core` を最優先とし、UI/CLIは薄く保つ。

## 7. 移行ステップ

1. `src/core` ディレクトリを作成
2. 既存ロジックを `src/core` へ移動し import を更新
3. `src/ui` から `src/core` を参照する形に統一
4. `src/cli` 最小実装（`--help`, `-e`, `-f`）
5. `--console` を追加

## 8. 命名ルール

1. 機能を示す英語ディレクトリ名を使用する（`core`, `ui`, `cli`）
2. 仕様書は `docs/*_spec.md` を基本とする
3. 開発運用系ドキュメントは `docs/development_*.md` を使用する

---

本構成案は、`docs/kintone_sql_plugin_spec.md` と `docs/ksql_cli_console_spec.md` を実装可能な形に落とし込むための開発レイアウト指針とする。
