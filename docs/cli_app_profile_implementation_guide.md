# CLI `APP@profile` 実装手順書（現行実装反映版）

## 1. 目的

`cli-ksql` で `APP@profile` を安全に扱い、同一SQL内で同一APPの profile 混在も許可する。

例:

- `APP100@dev`
- `APP100@guest`
- `APP80$明細@guest`

前提: plugin 側は `@profile` 非対応（現状維持）。

## 2. 現在の仕様（実装済み）

1. `@profile` は CLI 拡張として有効。
2. `@profile` なしは既定 profile を使用。
3. 同一SQL内の同一APP profile 混在を許可。
4. `INSERT/UPDATE/UPSERT` で `@profile` 使用可。
5. `DELETE` の `@profile` は未対応（明示エラー）。

## 3. 実装アーキテクチャ

## 3.1 Parser 非改変方針

共通 lexer/parser に `@profile` を直接入れず、CLI で前処理して正規化SQLを作る。

## 3.2 前処理の要点

対象: `src/cli/index.ts`

1. SQL中の `APP\d+[$sub]?@profile` を走査（文字列リテラル/コメント/バッククォート識別子は除外）。
2. `@profile` を除去した正規化SQLを生成。
3. 同一APPで複数profileがある場合、内部で仮想 appId を採番して参照単位に分離。
4. `mappedAppId -> { real appId, profile }` の束縛Mapを保持。

## 3.3 実行ルーティング

対象: `src/cli/index.ts`

1. `KintoneClient` ラッパーで `mappedAppId` を受ける。
2. API呼び出し直前に `real appId` に戻す。
3. profileごとの client を生成し、束縛Mapの profile で適切な client へ委譲。

## 3.4 キャッシュ分離

対象: `src/execute.ts`

1. 実行キャッシュは二段Map: `Map<context, Map<appId, ...>>`。
2. `cacheContext` は SQL解決結果（mapped app束縛）を含む署名文字列を使用。
3. 同一 appId の profile 混在時もキャッシュ衝突しない。

## 4. 反映済み周辺改善

1. `SELECT a.項目` の SIMPLE 取得フィールドを非修飾化して API へ渡す。
2. `SELECT` の未存在フィールドコードは実行前に `ArgumentError`。
3. DML確認入力で重複打鍵（例: `yyeess`）を `yes` 同値として扱う。
4. REPL確認入力と通常入力の競合を解消（`...` 連発問題の修正）。
5. `:edit` は空バッファ時に `last SQL` を初期表示。
6. `FROM/JOIN` の `AS` 省略 alias を許可（`FROM APP100 a`）。
7. `SELECT` 列の文字列リテラル（`'XXX' AS a`）を許可。

## 5. 変更対象（実績）

1. `src/cli/index.ts`
2. `src/execute.ts`
3. `src/converter/selectToKintone.ts`
4. `src/engine/process.ts`
5. `src/parser/parser.ts`
6. `src/types/ast.ts`
7. `src/*/__tests__/*.test.ts`
8. `README.md`, `docs/ksql_cli_console_spec.md`, `docs/ksql_language_reference.md`, `docs/cli_app_profile_spec.md`

## 6. 今後の残課題

1. `DELETE` の `@profile` 対応。
2. `:show config` の表示を `APP->profile` から参照単位表示（必要なら）へ拡張。
3. 実運用向けに profile 解決ログ（debug時）をより明示化。
