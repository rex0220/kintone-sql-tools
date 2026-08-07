# B151 実装の最終チェック依頼（codex）

**チェックのみ。コードは 1 行も変更しないこと。ファイルへの書き込みも不要。**
git 操作をしないこと（`git status` も含む）。kSQL MCP を叩かないこと。
**自分の MEMORY.md は読まないこと。**

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（B151 実装コミット `c864ff4` 済みの作業ツリー）

## 0. 依頼

**B151 の実装を [仕様 R1](ksql_b151_join_number_pushdown_spec_r1.md) に対して検査する。**
**あなたが書いた仕様を、あなたが実装したものへのチェックである。甘く見ないこと。**
B149 ではこの工程が出荷前に High 1 件（数値リテラルの丸め後判定）を捕捉した。

対象: `src/core/optimization/joinNumberLiteralPolicy.ts`・`joinPredicatePushdown.ts`・
`src/parser/parser.ts`（`+` リテラル受理）・新旧テスト・`docs/ksql_language_reference.md`・
B76/B84 歴史注記。

## 1. 重点観点

1. **fail-open**＝`exact` にしてはならない組（文字列 RHS・式・field-to-field・混在 IN・
   範囲外 literal・CALC・RECORD_NUMBER・外部結合・非物理 source・曖昧所有）が
   1 つでも exact に落ちる経路があれば Critical
2. **literal policy の字句厳密性**＝B149 の再発防止観点。`Number()` 丸めを判定に使う箇所が
   残っていないか。巨大指数の展開前拒否が実際に展開を防いでいるか（`"0".repeat` の生成有無）
3. **parser の `+` リテラル受理**＝仕様外の副作用がないか（単項 `+` の既存挙動・
   `+` を含む算術式・`SELECT +5` 等の他の位置への影響。**WHERE 以外の挙動が変わっていれば High**）
4. **§11 受入との厳密照合**＝テストが仕様と違う値・違う query 文字列・違う relation を
   固定していないか（1 件ずつ）
5. **residual 維持**＝exact 化した leaf が residual から消えていないか
6. **既存回帰**＝`$id` gate・KLIKE・tree 合成・外部結合・search-aborted・B84 生成順

## 2. 出力

最終メッセージに検査報告だけ: 指摘（Critical/High/Medium/Low・ファイル:行・根拠・修正案。
無ければ「指摘なし」と明言）／観点別結論（1 行ずつ）／Claude の実測が必要なもの。
