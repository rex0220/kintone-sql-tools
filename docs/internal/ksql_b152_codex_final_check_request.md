# B152 実装の最終チェック依頼（codex）

**チェックのみ。コードは 1 行も変更しないこと。ファイルへの書き込みも不要。**
git 操作・kSQL MCP・MEMORY.md 禁止。

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（B152 実装コミット `b327957` 済み）

## 0. 依頼

**B152 Phase 2+3 の実装を [仕様 R1](ksql_b152_join_pushdown_phase234_spec_r1.md)＋
[レビューでの Phase 4 見送り確定](ksql_b152_codex_review_1.md)に対して検査する。**
**自分が書いた仕様の自分の実装である。甘く見ないこと**（B149・B151 とも本工程が出荷前に指摘を出した）。

## 1. 重点観点

1. **fail-open**＝exact にしてはならない組（非 canonical 日付/日時・空文字・空文字混在 IN・
   TEXT/LINK の範囲比較・**ユーザー系全般（Phase 4 不触の確認）**・STATUS_ASSIGNEE・
   CALC・外部結合）が exact に落ちる経路が 1 つでもあれば Critical
2. **canonical policy の厳密性**＝`isCanonical*` の共通化で `=` 用と range 用に判定差が
   生まれていないか・うるう年/`24:00`/秒付き/offset/小数秒/前後空白の拒否
3. **既存テスト書き換えの妥当性**＝報告の「server-only 関数との whole-WHERE exact 消費」
   「B76 mock client の変更」が**仕様が明示的に変えた挙動の範囲内**か（範囲外の意味変更が
   混ざっていれば High）
4. **§受入との逐語照合**＝SQL・query 文字列（実 serializer 形）・relation・空セル固定表
5. **residual 維持・B151 回帰なし**（NUMBER policy・`$id`・KLIKE・選択系）

## 2. 出力

検査報告のみ: 指摘（重大度・ファイル:行・根拠・修正案。無ければ「指摘なし」と明言）／
観点別結論／Claude の実測が必要なもの。
