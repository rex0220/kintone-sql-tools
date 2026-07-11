# Changelog

リリースごとの変更点。v1.9.0 以前の詳細は [GitHub Releases](https://github.com/rex0220/kintone-sql-tools/releases) を参照。

## v1.12.1（2026-07-11）

### 修正（バグ）

- **SQL コメント・文字列リテラル・バッククォート識別子の中に書いた `APPxxxx` を、トークン解決の対象から除外**。
  従来は `extractAppIds` が生 SQL を素の正規表現で走査していたため、
  `-- 通知(APP4206)` のようなコメントや `'APP4206の件'` のような文字列に現れた
  アプリ番号まで「参照アプリ」とみなし、profile の tokenMap に無いと
  `AuthError: token is missing for APPxxxx@profile.` で実行不能になっていた。
  `@profile` 正規化と同じスキャナ（`collectAppProfileTokens`）に統一し、
  コメント・文字列・バッククォートを除外してから APP 参照を拾うようにした。
  本文の `FROM APPxxxx`（`@profile` / `$subtable` 付き含む）は従来どおり解決する。
  誤って要求していたトークンを要求しなくなる方向のみの変更で、後方互換。
  （詳細: `docs/internal/ksql_extract_app_ids_comment_string_issue.md`）

## v1.12.0（2026-07-11）

### 変更（挙動変更）

- **GROUP BY なしの集計 SELECT は対象 0 件でも常に 1 行を返す**（SQL 標準準拠化）。
  COUNT は `0`、SUM / AVG / MAX / MIN も `0`（全値が空のグループと同じ既存規約。標準 SQL の NULL とは異なる）。
  GROUP BY が**ある**場合は従来どおり 0 行。詳細は言語リファレンス §8「0 件時の挙動」
- これにより健全性チェックの定番 `ASSERT (SELECT COUNT(*) ... WHERE 異常条件) = 0` が
  該当 0 件（健全時）に成立するようになった（従来は `AssertError: scalar subquery returned no rows` で失敗）。
  ASSERT の 0 行エラー自体は維持され、非集計プローブの空振り検出は従来どおり機能する
- 波及する挙動変更（いずれも標準準拠化の方向）:
  - `WHERE f = (SELECT COUNT(*) ...)` / SELECT 列 / UPDATE SET のスカラーサブクエリ:
    0 件集計が「値を返しませんでした」エラーではなく `0` に解決される
  - `f IN (SELECT COUNT(*) ...)`: 空集合ではなく `{0}` との照合になる
  - **`EXISTS (SELECT COUNT(*) ...)` は常に真になる**（従来は 0 件で偽 — 標準 SQL でも
    集計サブクエリは 1 行返すため EXISTS は常に真。EXISTS に集計を書くこと自体が誤用）
  - `CREATE TEMP TABLE #t AS SELECT COUNT(*) ...`: 0 件でも 1 行実体化される（列名も導出される）
  - `INSERT INTO app (...) SELECT COUNT(*) ...`: 0 件でも 1 行書き込まれる
    （従来は「SELECT の列数(0)」エラー。`dmlMaxRows` / confirm の件数判定に 1 行として乗る）

## v1.11.0（2026-07-11）

### 追加

- **`tempTableMaxRows` オプション**: 一時テーブル1個の実体化行数上限（従来 10,000 固定）を変更可能に。
  MCP `ksql_query` / `ksql_mutate` のツール引数、CLI `--temp-table-max-rows`、
  env `KSQL_TEMP_TABLE_MAX_ROWS`、profile `query.tempTableMaxRows` で指定できる
  （優先順は引数 → env → profile → 既定 10,000）。console の `:run` 子実行にも伝搬する。
  `ksql_run_saved_query` は単文限定（一時テーブルが出現しない）のため対象外
- **プラグイン: 一時テーブル上限の実行画面指定**: 「⚙ オプション → 取得」に
  「一時テーブル上限(行)」入力を追加（空欄 = 既定 10,000。スピナーは 10,000 刻み）。
  一覧ページは localStorage に永続化、レコード編集画面は保存SQL アプリの
  任意フィールド **`一時テーブル上限行`（数値）** があればレコードに保持
  （「最大取得件数」と同様。フィールドがなければ従来どおり）。
  SQL 履歴にもスナップショット保存。超過は「打ち切って続行」設定でも常にエラー

### 互換性

- 未指定時の挙動は完全に従来どおり（既定 10,000・**超過は `onLimit` 設定によらず常にエラー**。
  truncate は一時テーブルの実体化に適用されない — 暗黙の欠損が後続文を静かに歪めるため）
- 上限を引き上げるとバッチ内最大16テーブル × 指定値がメモリに滞留し得る点に注意
  （一時テーブルの参照は常にインメモリ FULL_SCAN）。まず WHERE での絞り込みを推奨

## v1.10.0（2026-07-10）

### 追加

- **ASSERT 文**: `ASSERT <式> <比較演算子> <式>` / `ASSERT <式> BETWEEN <式> AND <式>`。
  条件が成立しなければ `AssertError` で停止する実行時ゲート（DML 前の件数ガード・CLI ヘルスチェック用途）。
  read-only 扱いで単文・バッチのどちらでも実行可能。バッチ内での失敗は `continueOnError` 指定でも常に停止し、
  以降の文は `skipped`（`skippedReason: "assertion"`）になる。詳細は言語リファレンス §26
- **CLI バッチ JSON 出力**: バッチ入力 + `--format json` で、MCP と同一のエンベロープ
  （`ok` / `batch` / `statementCount` / `statements[]` / `results[]` / `warnings`）を stdout に
  単一 JSON ドキュメントとして出力（`--pretty` / `--output` 対応）。CI からバッチ全体の成否・
  文ごとの状態を機械可読に取得できる
- **requestGate 設定の公開**: 同時リクエスト上限・GET リトライ回数・バックオフを
  CLI フラグ / config / env で調整可能に（詳細は CLI 仕様書）

### 破壊的変更

- **バッチ入力 + `--format json` の CLI 出力形を置き換え**（v1.4.0 で導入した
  「SELECT 結果 JSON の空行区切り連結」を廃止）。複数 JSON ドキュメントの連結は機械可読でないため、
  上記の単一エンベロープに統一した。従来の「結果セットだけ欲しい」用途は
  `ksql -e "..." --format json | jq '.results[].rows'` で代替できる。
  単文入力の `--format json`、および `table` / `csv` / `markdown` / `jsonl` の出力は従来どおり

### 互換性

- 単文入力の既存文タイプの応答形は全ツール・CLI で不変（ASSERT は新規文タイプの追加）
- exit code の割り当ては不変（`AssertError` は 1）
- requestGate の既定値・既存の env / config 解決順は不変（公開が増えるだけ）
