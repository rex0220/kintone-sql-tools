# B159 仕様 R1 作成依頼（codex）——GENERATE_SERIES の month / year step

**仕様の作成依頼。コードは 1 行も変更しないこと。ファイルへの書き込みも不要。**
git 操作・kSQL MCP・MEMORY.md 禁止。

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（main・v3.63.0 開発中）

## 0. 依頼

**[B159 起票](ksql_b159_generate_series_month_step_issue.md)（設計整理は最終形まで確定済み）の
仕様 R1 を、そのまま実装依頼に出せる形で書く。** v3.63.0 同梱（B158 CROSS JOIN と同時）。

## 1. 決まっていること（変更しない・起票 §3 で確定済み）

- **step に `'1 month'`（`months` 可）・`'1 year'`（`years` 可）を追加**。係数付き（`'2 months'` 等）の
  可否はあなたがコードの day step 実装との一貫性から決める
- **月初アンカー限定**＝start が月の 1 日（year は 1 月 1 日）でなければ ArgumentError。
  **丸め規則を系列に持ち込まない**（月末が欲しい場合は既存 `LAST_DAY(月初)` で変換＝文書に併記）
- **累積方式は採らない**。将来任意日起点を開く場合の規則は `DATE_ADD` 準拠（アンカー＋月末丸め）と
  申し送りに固定済み——本 Phase では任意日起点自体を開かない
- **出力は DATE 型（`YYYY-MM-01`）**＝B149 の型メタ伝播・`LAST_DAY`/`DATE_ADD` 合成・
  ソート意味論と一貫。`'YYYY-MM'` 文字列が欲しい場合は `DATE_FORMAT` を CTE で 1 段（文書に併記）
- B149 の既存契約は不変＝PG 準拠境界（stop を超えない・向き逆は 0 行・step 0 エラー・負 step 可）・
  上限 10,000 行（WITH 内合計・事前算出）・警告抑止（厳密単調）・`EXPLAIN` の `row guard:` 表示

## 2. あなたがコードから決めること（ファイル:行を添えて）

1. step 構文の受理形（day step の `'1 day'`/`'2 days'` 実装との一貫・負の month step の扱い）
2. 行数の事前算出式（month/year の場合）と 10,000 ガードへの合流点
3. 月初アンカー検証の位置とエラー文（実行前静的検査か・変数解決後か）
4. 警告抑止（厳密単調証明）が month/year でも同じ根拠で成立するか
5. `EXPLAIN` 表示（`series type:` / `step:` の形）
6. B158（CROSS JOIN）と同時開発になる。**parser・AST の衝突が無いこと**を確認し、
   依存があれば明記（無いはず＝GENERATE_SERIES は CTE 本体・CROSS は JOIN 句）

## 3. 仕様に必ず含めること

B149 と同じ型＝規則・受入条件（逐語 SQL・**月次 0 埋め＋LAG の実需形**＝
`WITH m AS (GENERATE_SERIES('2025-08-01','2026-08-01','1 month') AS 月) ... LEFT JOIN 月次実績 → LAG`
で**空月が 0 で現れ LAG が正しく 1 か月前を見る**こと・`LAST_DAY` 合成・うるう年 2 月・
step 0/逆向き/非月初エラーの逐語）・dry-run API 0 回・Claude 実測項目。

## 4. 書き方の制約

従来どおり。**仕様の全文（Markdown）を最終メッセージで出力**。
