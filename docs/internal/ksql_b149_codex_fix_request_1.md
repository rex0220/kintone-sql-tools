# B149 修正依頼 1（codex・最終チェック指摘 2 件）

**[最終チェック報告](ksql_b149_codex_final_check_request.md)で自分が出した指摘 2 件を修正する。**

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`

## 0. 禁止事項（実装依頼と同じ）

- **git 操作を一切しない**。version・CHANGELOG・README を変更しない。ビルドしない
- kSQL MCP を叩かない。自分の MEMORY.md を読まない
- エラー本文に内部語を出さない

## 1. 修正内容

### High — 数値リテラルの整数判定を丸め前の字句で行う

`src/core/generateSeries.ts` が `Number(...)` 変換後に `Number.isSafeInteger()` で判定しているため:

- `GENERATE_SERIES(1e-400, 1e-400)` → 本来 `ArgumentError`、現状 `"0"` を 1 行生成
- `GENERATE_SERIES(1.0000000000000000001, 2)` → `"1"` として誤受理
- `GENERATE_SERIES(9007199254740990.9, ...)` → 丸めて誤受理

**数値引数は丸め前の正規化字句で「正確な整数かつ安全整数範囲」を検証する。**
既存の `src/core/exactDecimal.ts`（`parseExactDecimal`）が使えるなら再利用を優先する。
仕様 R2 §3.1 の許可例 `1e2` / `5e2`（指数を解決すると整数）は**通り続けること**。

### Medium — TIME を所定の診断に載せる

`GENERATE_SERIES('12:00', '13:00', '1 day')` が「実在する YYYY-MM-DD 形式の DATE」を返す。
仕様 R2 §10.9 のとおり **`DATETIME と TIME は使用できません`** の公開文にする
（TIME 形式＝`HH:mm` / `HH:mm:ss` を DATE 判定より前に未対応 temporal として分類する）。

## 2. テスト

- 上記 4 例（High 3 例 + TIME 1 例）の回帰テストを `b149GenerateSeries.test.ts` へ追加し、
  **公開メッセージ全文を固定**する
- **追加テストが修正前の実装で落ちることを確認してから直す**
- 既存テストの期待挙動は変えない（変える必要が出たら止めて報告）

## 3. 実行と報告

- `npm test` を全体で回す。ホストの `KSQL_USERNAME` / `KSQL_PASSWORD` は
  テストプロセス内だけ除外してよい（既存の環境要因）
- 最終メッセージ＝修正報告のみ: 変更ファイル・追加テストと修正前 fail の確認結果・
  全体テスト結果・仕様との差分（あれば）
