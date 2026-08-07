# B150+B153 実装の最終チェック依頼（codex）

**チェックのみ。コード変更・ファイル書き込み・git・MCP・MEMORY.md 禁止。**

対象: `b150/dev` ブランチの B150（[仕様 R1](ksql_b150_join_key_range_prefilter_spec_r1.md)）＋
B153（[実装依頼](ksql_b153_codex_impl_request.md)）。**自分の実装への検査。甘く見ないこと**
（B149/B151/B152 とも本工程が出荷前に指摘を出した）。

## 重点観点

1. **型の受けない演算子を送る経路の全廃**＝`in` も範囲も受けない型・空キー混在の未確認型で、
   `in ("")` や範囲 query が漏れて送られる経路が 1 つでもあれば Critical
2. **範囲 prefilter の superset 保証**＝空値・非 canonical・意味型不足のフォールバックが
   全経路（CTE / 一時テーブル / APP→APP）で効くか。min/max の比較器が `Date` 変換や
   文字列既定順に落ちていないか
3. **trim 廃止の影響範囲**＝押し下げと JOIN 突合の意味論が本当に一致したか。
   trim に依存していた既存挙動（前後空白付きキーの in リスト・escape）が壊れていないか
4. **`in ("")` の型集合**＝pure policy の確認済み型集合が実測（TEXT/LINK/NUMBER/CALC/選択系）と
   一致し、未確認型がフォールバックへ落ちるか
5. **受入の逐語照合**＝B150 再現形・reason code・EXPLAIN の query 文字列（実 serializer 形）
6. **既存回帰**＝B151/B152 の field-vs-literal 分類・`$id`・KLIKE・外部結合非適用・300 上限警告文

## 出力

検査報告のみ: 指摘（重大度・ファイル:行・根拠・修正案／無ければ「指摘なし」）／観点別結論／
Claude の実測が必要なもの。
