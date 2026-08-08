# B158 実装の最終チェック依頼（codex）

**チェックのみ。コード変更・ファイル書き込み・git・MCP・MEMORY.md 禁止。**

対象: `b158/dev` の B158 実装（[仕様 R1](ksql_b158_cross_join_spec_r1.md)・
[レビュー](ksql_b158_codex_review_1.md)）。
**自分の仕様を自分が実装したものへの検査。甘く見ないこと**（B149〜B157 まで本工程が
毎回出荷前に指摘を出している。B157 では既存穴 B161 まで検出した——同じ深さで）。

## 重点観点

1. **ガードの位置**＝`planCrossJoinRows()` の判定が**行生成前**か。nested loop の途中や
   結果配列確保後に置かれた経路が 1 つでもあれば Critical。多段 CROSS の段ごと判定・
   サブテーブル展開後行数・DML source での mutation API 前停止も机上で追う
2. **narrowing の漏れ**＝`join.on` を読む箇所が報告の 6 箇所で本当に全部か。
   `as any`・optional chaining・`on!` で黙って通した箇所がないか grep で確認。
   **CROSS を INNER 扱いで JOIN キー prefilter へ流す経路**（`on` 欠如の fallback）が
   ないかは特に厳しく
3. **完全入力**＝`CROSS_JOIN` reason の発火条件と truncate 無効化。通常 JOIN の
   既存 truncate 契約が変わっていないか
4. **EXPLAIN/dry-run の API 契約**＝物理入力の行数を捏造して exact 表示していないか・
   dry-run（単文・複文）の全 API 0 回・B157/B161 の表示回帰なし（診断と計画の一致）
5. **既存 JOIN の非回帰**＝INNER/LEFT/RIGHT の AST・実行・EXPLAIN が CROSS 追加以外
   不変か（parser snapshot 差分の妥当性）
6. **受入の逐語照合**＝§11.1〜11.6・§12 R17 形（730 行・0 埋め・累計・metadata）・
   §6.4 エラー文

## 出力

検査報告のみ: 指摘（重大度・ファイル:行・根拠・修正案／無ければ「指摘なし」）／観点別結論／
Claude の実測が必要なもの。
