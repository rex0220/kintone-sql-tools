# B151 修正依頼 1（codex・最終チェック指摘 Medium 2 件）

**[最終チェック報告](ksql_b151_codex_final_check_report.md)の指摘 2 件を修正する。**

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`

## 0. 禁止事項（実装依頼と同じ）

git 操作・version・CHANGELOG・README・release/・台帳の変更・ビルド禁止。
kSQL MCP を叩かない。MEMORY.md を読まない。

## 1. 修正内容

### Medium 1 — 単項 `+` の受理を「PLUS + NUMBER の単純リテラル」に限定する

指摘の修正案どおり: `parseWhereSqlValue()` に `PLUS + NUMBER` 専用分岐を設け、
`parseSqlValue()` の汎用算術入口から `PLUS` / `allowUnaryPlusNumber` を外す。

- **受理を維持**: `= +5`・`BETWEEN +5 AND +6`（仕様 §4.5 の範囲）
- **従来どおり拒否へ戻す**: `= +5 + 1`・`LIKE +5` / `NOT LIKE +5`・符号の重複（`++5` 等）
- 回帰テストを追加（受理 2 形・拒否 3 形。**修正前の実装で拒否形が通ることを確認してから直す**）

### Medium 2 — 受入テストを仕様の逐語形に揃える（正本の確定を含む）

1. **§11.19（外部結合）**: テスト SQL を仕様の逐語形
   `SELECT m.製品名, t.個数 ... LEFT JOIN ... ORDER BY m.$id` の専用定数に差し替える
2. **§11.13 の `IN` query 文字列**: **serializer は変更しない**（既存公開挙動）。
   仕様 §8.4 が「空白は既存 formatter 契約に従ってよい」と認めているため、
   **仕様 R1 §11.13 / §8.4 の query 例を実 serializer の出力形へ訂正**し、
   訂正箇所に日付付きの注記（`【2026-08-07 訂正】実 serializer の出力形へ統一`）を付ける。
   テストは実 serializer 形を明示期待値として固定する

## 2. 実行と報告

- `npm test` を全体で回す（認証環境変数はテストプロセス内だけ除外可）
- 最終メッセージ＝修正報告のみ: 変更ファイル・追加テストと修正前挙動の確認結果・
  全体テスト結果・仕様との差分（あれば）
