# B152 実装依頼（codex）——スコープ＝Phase 2 + Phase 3（Phase 4 は見送り確定）

**[仕様 R1](ksql_b152_join_pushdown_phase234_spec_r1.md) を実装する。ただし
[レビュー](ksql_b152_codex_review_1.md)の実測により仕様 §4.5-9 の条件が発動し、
Phase 4（ユーザー・組織・グループ・作業者系の `IN` / `NOT IN`）は今回実装しない。**

- 実測＝`主担当 IN ('存在しないcode')` は kintone が **GAIA_IL26 の query error**
  （空集合ではない）。開放すると動いていたクエリが壊れる・code のローカル実在検証は不可（B54 待ち）
- **Phase 4 に触れない**＝classifier・whereCapability（`STATUS_ASSIGNEE` の `NATIVE_OPERATORS`
  追加を含む）・B84 表のユーザー系セルは現状維持（全✕）。仕様 §4.5〜4.6・§5 のユーザー系行に
  「【2026-08-07・レビューで見送り確定＝GAIA_IL26 実測。B54 後に再評価】」の注記を付ける
- **Phase 2（DATE/TIME/DATETIME/CREATED_TIME/UPDATED_TIME の 6 比較演算子）と
  Phase 3（SINGLE_LINE_TEXT/LINK の `=` `!=` `<>` `IN` `NOT IN`）は仕様どおり実装**。
  レビュー実測＝TIME/DATETIME の空セル両方向一致・**TEXT の `=` は大文字小文字・全半角を
  逐語区別**（§4.4 の条件節は発動しない＝exact でよい）

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（B151 実装済みの作業ツリー）

## 0. 禁止事項（B151 実装依頼と同じ）

git 操作・version・CHANGELOG・README・release/・台帳の変更・ビルド禁止。
kSQL MCP を叩かない。MEMORY.md を読まない。エラー本文に内部語を出さない。
公開型への必須プロパティ追加禁止（`?` を付ける）。

## 1. 実装範囲

仕様 §7（canonical policy の共通化・classifier・serializer 再利用・relation・residual 維持・
fail-closed）の Phase 2+3 部分、§8 の EXPLAIN、§9 の B84 表・言語リファレンス・歴史注記の同期、
§10〜11 相当の受入テスト（mock client / オフラインで検証できる全項目）。

## 2. テストの要件（B151 と同じ）

- 受入 SQL は逐語・query 文字列は**実 serializer 形**を明示期待値に
- 受入 ↔ テスト対応表（実機必須の残りは「実機（Claude）」と明記）
- B84 パリティ＝分類器/文書の 1 セル破壊で落ちることを確認
- 新規テストは修正前 fail を確認してから
- 既存テストの書き換え＝仕様が明示的に変える挙動（DATE 系 `=` の superset→exact 等）は
  仕様に従って書き換えてよい。全件を報告に列挙

## 3. 進め方と報告（B151 と同じ）

コード → テスト → 文書。`npm test` 全体（認証環境変数はプロセス内除外可）。
仕様どおりにできない箇所は「仕様との差分」として報告。
最終メッセージ＝実装報告のみ（変更ファイル・対応表・テスト結果・既存テスト変更・差分・実機残項目）。
