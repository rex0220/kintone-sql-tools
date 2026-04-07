# CLI APP@profile 仕様案（Plugin 非対応）

## 1. 前提

本仕様は `cli-ksql` 専用拡張とする。  
プラグイン側では `@profile` 指定をサポートしない。

## 2. 対象範囲

1. 対象は CLI（`ksql`）のみ。
2. プラグイン（UI/保存SQL実行）は `@profile` を許可しない。
3. プラグインで `@profile` を含む SQL は構文エラー扱いとする。

## 3. 記法

1. テーブル参照の末尾に `@profile` を付与可能とする。  
   例: `APP100@guest`, `APP80$明細@dev`
2. `@profile` なしは既定プロファイルを使用する。
3. 大文字小文字は非区別とする（例: `app80@Dev` を許可）。

## 4. 実行ルール（CLI）

1. `APP@profile` は指定 profile の `baseUrl` / `guestSpaceId` / `auth` / `tokenMap` で解決する。
2. `APP`（`@profile` なし）は既定 profile を使用する。
3. JOIN を含む複数 APP で profile 混在を許可する。
4. 同一 APP に複数 profile 指定が混在しても許可する（別環境の別アプリとして扱う）。

## 5. 既定 profile の優先順位

1. SQL 内 `@profile`（最優先）
2. `--profile`
3. `KSQL_PROFILE`
4. `config.defaultProfile`
5. fallback `dev`

## 6. 認証・トークン解決

1. token 解決は「参照 APP の profile 文脈」で行う。
2. 未解決 token がある場合は実行前にエラー終了する（不足した `APP@profile` を明示）。
3. `auth=userpass|token|auto` は profile ごとに適用する。

## 7. 初期実装の制約

1. `@profile` は `SELECT` / `INSERT` / `UPDATE` / `UPSERT` で使用可能。
2. `DELETE` での `@profile` は未対応とし、エラーにする。
3. `--app` は従来どおり数値のみ受理する（`100@dev` は将来検討）。

## 8. CLI 表示

1. 実行前に利用 profile 一覧を表示する（`--quiet` 時は非表示）。
2. `:show config` で既定 profile と、直近 SQL で解決した `APP@profile` マップを表示する。
3. 同一 APP の profile 混在時は、内部的に参照単位で識別し実行する（キャッシュ衝突を回避）。

## 9. Plugin 側ポリシー

1. 言語仕様書に「`@profile` は CLI 拡張記法」であることを明記する。
2. プラグインは `@` を含む APP 参照を受け付けない。
3. CLI 例と Plugin 例をドキュメントで明確に分離する。

## 10. エラーメッセージ例

1. `ArgumentError: profile "guest" is not defined.`
2. `AuthError: token is missing for APP80@guest.`
3. `ArgumentError: @profile is not supported for DELETE yet.`
4. `ArgumentError: unknown field code(s): 存在しない (APP100)`

## 11. SELECT フィールド解決ルール

1. `SIMPLE SELECT` での API 取得フィールドは、修飾付き参照を非修飾化して解決する。  
   例: `SELECT a.オーダー番号 FROM APP69 AS a` は `オーダー番号` を取得対象にする。
2. 算術式・文字列関数内の修飾付き参照も同様に非修飾化する。  
   例: `UPPER(a.担当者)`, `a.金額 + 1`
3. `SELECT` 実行時は参照フィールドコードを app 単位で検証し、未定義コードを検出した場合は実行前にエラー終了する。
