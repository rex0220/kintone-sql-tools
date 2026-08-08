# B159 実装の最終チェック報告（codex・2026-08-08）

- 対象: `b159/dev` の B159 実装（`4c9c1a1` 相当）
- 結論: **実装欠陥なし・テスト不足 3 点（中 2・低 1）→ 追補済み（10 ケース・実装変更なし）**

指摘あり。実装ロジック上の仕様違反は見つかりませんでしたが、受入テストに3点の不足があります。

- 中 — 変数解決後の検証一致をテストし切れていない  
  `b159GenerateSeriesMonthYear.test.ts`  
  テスト名は「アンカー・step・上限」ですが、変数 `@step` は正常な `'1 month'` で上限超過に使われるだけです。変数解決後の `0 month`、未対応単位、不正係数、および year 非年初アンカーが未検証です。実装は解決後に `validateStatementStatic()` を再実行し、リテラルと同じ `planResolved()`／`validateDateAnchor()` に合流しているため、コード上は一致しています（`execute.ts`、`generateSeries.ts`）。ただし、重点①と仕様 §15.3 の回帰証拠として不足します。

- 中 — 警告抑止範囲のB159受入テストが CROSS JOIN に偏っている  
  `b159GenerateSeriesMonthYear.test.ts`、`b159GenerateSeriesMonthYear.test.ts`  
  直接生成と CROSS JOIN は確認されていますが、通常 JOIN と一時テーブル経由の month/year 警告維持がありません。B149 の通常 JOIN テストは整数系列のみで、一時テーブルテストはメタだけを確認して警告を検査していません（`b149GenerateSeries.test.ts`、`b149GenerateSeries.test.ts`）。実装自体は JOIN なし・直接生成 CTE に限定し、`uniqueGeneratedColumn` を再実体化へ伝播していないため仕様どおりです（`execute.ts`、`execute.ts`）。

- 低 — EXPLAIN 正規化4組のうち2組しか固定されていない  
  `b159GenerateSeriesMonthYear.test.ts`  
  現テストは `'1 months' → 1 month` と `'+2 year' → 2 years` のみです。仕様 §11.3 の `'-1 years' → -1 year`、`'-2 year' → -2 years` が未検証です。実装式は絶対値1だけ単数形、それ以外を複数形としており、4組すべて正しく処理します（`execute.ts`）が、逐語回帰テストが不足しています。

観点別結論:

1. アンカー検証: 実装は一致。変数異常step/yearアンカーのテスト不足。
2. 負方向stop境界: 適合。非アンカーを次の月初・年初へ切り上げ、stop未満を生成しません（`generateSeries.ts`）。
3. 警告抑止: 実装はB149の範囲内。通常JOIN・一時テーブルのB159テスト不足。
4. 行数・10,000ガード: 適合。LIMIT前、`values` 配列確保前、API前に検査され、変数解決後もWITH合計へ合流します（`generateSeries.ts`、`generateSeries.ts`）。
5. EXPLAIN正規化: 実装は全組適合。テストは4組中2組。
6. §8エラー: 実装文言は逐語一致。既存 `0 day` 文言も維持されています（`generateSeries.ts`、`b149GenerateSeries.test.ts`）。

指定に従い、テスト実行、git、MCP、ファイル書き込みは行っていません。