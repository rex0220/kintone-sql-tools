# B152 最終チェック依頼 2（codex・全面整合分＝コミット `a6d65b0`）

**チェックのみ。コード変更・ファイル書き込み・git・MCP・MEMORY.md 禁止。**

対象: [修正依頼 2](ksql_b152_codex_fix_request_2.md)（CALC）＋[修正依頼 3](ksql_b152_codex_fix_request_3.md)
（ユーザー系 6 型・RECORD_NUMBER）の実装。**自分の実装への検査である。甘く見ないこと。**

## 重点観点

1. **fail-open**＝空文字 literal・空/混在リスト・式・field-to-field・未解決変数が
   exact/superset に落ちる経路が 1 つでもあれば Critical。ユーザー系の **scalar 比較**
   （`作成者 = '...'`）が誤って開いていないか
2. **relation の割り当て**＝ユーザー系 `IN`/`NOT IN` は exact・CALC/RECORD_NUMBER は
   superset で固定されているか（逆転や混在があれば High）。superset leaf が residual から
   消えていないか
3. **エラー表面化**＝kintone query error（GAIA_IL26 等）を捕捉して全件取得へ silent retry
   する経路が無いか
4. **STATUS_ASSIGNEE の native operator 追加**＝単一表の既存挙動（LOCAL_ONLY だった経路）への
   影響列挙。プロセス無効アプリで query を送る場合の挙動が「エラー表面化」で一貫しているか
5. **B151/B152 既存分の回帰なし**＝NUMBER/日付/TEXT の exact・canonical policy・`$id`・KLIKE・選択系
6. **B84 表・凡例・仕様注記の整合**（superset とエラー表面化の注記があるか）

## 出力

検査報告のみ: 指摘（重大度・ファイル:行・根拠・修正案／無ければ「指摘なし」）／観点別結論／
Claude の実測が必要なもの。
