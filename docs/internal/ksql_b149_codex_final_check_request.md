# B149 実装の最終チェック依頼（codex）

**チェックのみ。コードは 1 行も変更しないこと。ファイルへの書き込みも不要。**
git 操作をしないこと（`git status` も含む）。kSQL MCP を叩かないこと。
**自分の MEMORY.md は読まないこと。**

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（B149 実装コミット済みの作業ツリー）

## 0. 依頼

**B149 の実装（コミット `4b2aae1`）を、[仕様 R2](ksql_b149_generate_series_spec_r2.md) に対して検査する。**

**あなたが書いた仕様を、あなたが実装したものへのチェックである。甘く見ないこと。**
B148 では、この最終チェックが「従うと壊れる助言」の 4 度目をリリース直前で止めた
（仕様レビューも実装者も見落としていた）。同じ役割を期待している。

対象ファイル: `src/core/generateSeries.ts`・`src/parser/parser.ts`・`src/types/ast.ts`・
`src/execute.ts`・`src/core/statementValidation.ts`・`src/core/dmlGuard.ts`・
`src/__tests__/b149GenerateSeries.test.ts`・`src/mcp/schemas.ts`・`src/mcp/index.ts`・
`src/mcp/statementSyntaxCatalog.ts`・`docs/ksql_language_reference.md`

## 1. 重点観点

1. **仕様 R2 との突き合わせ**＝§12 の受入条件で、テストが実は仕様と違う値・違う例外・
   違う警告を固定していないか（1 件ずつ SQL と期待値を仕様と照合する）
2. **診断文・文書の SQL が「従うと壊れる」形になっていないか**＝
   エラーメッセージ内の修正例・言語リファレンスに追記した例文を、実装した文法で機械的に検査する
3. **警告抑止の fail-open**＝`uniqueGeneratedColumn` 経由の抑止が、
   仕様 §6.6 の「証明対象外」リスト（JOIN・自己 JOIN・`UNION`・一時テーブル・再実体化・
   式参照・曖昧な列参照）で誤って抑止しないか。**抑止してはならないのに抑止する経路が
   1 つでもあれば Critical**
4. **上限ガードの回避経路**＝`validateGenerateSeriesInStatement` の走査が届かない位置に
   生成 CTE を書ける形がないか（サブクエリ内 `WITH`・`CREATE TEMP TABLE AS WITH`・
   `EXPLAIN` 経由・保存クエリ経由）
5. **境界の 1 行ずれ**＝`countRows` と実生成の件数が全 4 象限・`start = stop`・
   `stop` ちょうど／またぐ直前で一致するか（BigInt 経路と生成ループの整合）
6. **既存挙動の回帰**＝`GENERATE_SERIES` という識別子・バッククォート識別子・
   既存の `$id` 証明・既存警告文・`DECLARE` 契約に影響がないか

## 2. 出力

最終メッセージに検査報告だけを出力する:

- 指摘（Critical / High / Medium / Low・ファイル:行・根拠・修正案）。**無ければ「指摘なし」と明言**
- 検査した観点と、それぞれの結論（1 行ずつ）
- 静的に確定できず Claude の実測が必要なもの（あれば）
