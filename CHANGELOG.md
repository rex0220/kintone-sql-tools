# Changelog

リリースごとの変更点。v1.9.0 以前の詳細は [GitHub Releases](https://github.com/rex0220/kintone-sql-tools/releases) を参照。

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
