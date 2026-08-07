# B152 修正依頼 3（codex・kintone 演算子表への全面整合＝オーナー判断）

**オーナー判断（2026-08-07・[起票 §3.4](ksql_b152_join_pushdown_all_types_issue.md)）:
kintone の演算子表（レコード取得操作）に記載の型×演算子は、単一表と同様に JOIN でも押し下げる。
書式・値が合わない指定は kintone エラーになって構わない。**

修正依頼 2（CALC）まで適用済みの作業ツリーへ追加実装する。禁止事項は従来どおり。

## 1. 実装内容

### 1.1 ユーザー系 6 型の `IN` / `NOT IN` を開放（Phase 4 の見送り撤回）

- 対象: `CREATOR` / `MODIFIER` / `USER_SELECT` / `ORGANIZATION_SELECT` / `GROUP_SELECT` / `STATUS_ASSIGNEE`
- 仕様 R1 §4.5〜4.6 の値契約（`code` 逐語・非空 literal のみ・`name` 不使用）をそのまま実装
- **relation は `exact`**（membership 意味論は実測で一致済み＝レビュー §1）
- **存在しない code の kintone query error（GAIA_IL26 等）はそのまま表面化**
  （オーナー判断で許容。単一表と同じ挙動。silent retry 禁止）
- `STATUS_ASSIGNEE` は `NATIVE_OPERATORS` へ `in` / `not in` を追加（単一表にも効く）。
  仕様 §4.6 のプロセス有効性 gate は**簡素化してよい**＝プロセス無効時のエラーも
  kintone に表面化させる方針（単一表と同じ）。ただし追加の metadata 取得を増やさない形を優先し、
  実装の選択と理由を報告に書く

### 1.2 RECORD_NUMBER の 8 演算子を開放

- `=` `!=` `<>` `<` `>` `<=` `>=` `IN` `NOT IN`
- literal: B151 numeric literal policy を満たす数値 literal、または非空 string literal
  （アプリコード付き形式 `CODE-1` を書く利用者のため）
- **relation は `superset`**（アプリコード形式の server/local 順序意味論が未証明。
  残余再評価が最終判定）。`$id` の既存 exact 契約は変更しない
- 値が形式に合わない場合の kintone エラーは表面化

### 1.3 文書

- B84 表: ユーザー系 6 型の `in`/`not in` → ○、RECORD_NUMBER → ○×8（パリティ生成器経由）
- 凡例注記: 「superset の組は取得後に再評価・値が不正な指定は kintone のエラーになる
  （存在しないユーザー code 等）」
- 仕様 R1 §4.5/§4.6/§5・レビューの見送り記述・B151 仕様の該当注記へ
  **日付付きのオーナー判断（撤回・全面整合）注記**を追加
- 言語リファレンス同期

## 2. テスト

- ユーザー系: 実在 code の `IN`（membership・code 逐語・`name` 不一致）・`NOT IN` の空値包含・
  mock error の表面化（握りつぶさない）・3 経路一致（mock）
- RECORD_NUMBER: 数値 literal・文字列 literal・`relation: superset` の EXPLAIN・残余維持
- B84 パリティ 1 セル破壊・修正前 fail 確認・既存テスト変更の列挙
- `npm test` 全体（環境変数除外可・EPERM 時は報告のみ＝ゲートは Claude）

最終メッセージ＝修正報告のみ。
