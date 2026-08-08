# B164 実装依頼（codex）——比較位置の集計参照 key を aggregateRef から再生成（案 A）

**[起票（原因確定済み）](ksql_b164_variable_aggregate_comparison_issue.md)と
[調査報告](ksql_b164_codex_investigation_report.md)のとおり実装する。
方向はオーナー判断（2026-08-08）＝案 A。v3.65.0 候補。**

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（作業ブランチ `b164/dev`・v3.64.0 相当）

## 0. 禁止事項（従来どおり）

git 操作・version・CHANGELOG・README・release/・台帳・リリース履歴の変更・ビルド
（`prod/js/desktop.js` に触れない）・kSQL MCP・MEMORY.md 禁止。
エラー本文に内部語を出さない。公開型への必須プロパティ追加禁止。

## 1. 実装内容（方針確定・変更しない）

1. **案 A**＝`aggregateRef` を持つ `FIELD` の値参照で、焼き付いた `FieldRef.field` を信用せず
   **解決後の `aggregateRef` から `aggregateSyntheticName()` で key を再生成**して引く
   （調査報告 §3 の突合点・§6-A）。CASE/IF 条件・HAVING の両方を同時に直す
2. **区別診断**＝再生成 key でも未一致（＝計算されていない集計参照）の場合、
   従来の黙った `""` にせず、**B164 と「HAVING 非掲出」を区別できる形**にする。
   既存 fail-open 挙動の互換に配慮し、まず警告（既存 warnings 機構）とし、
   例外化はしない（調査報告 §6-E の互換懸念）。警告文に内部語を出さない
3. **semantics 判定はすでに `aggregateRef` 正本**＝変更しない。案 C（二重正本の解消）は
   別課題として持ち込まない

## 2. テストの要件

- **修正前 fail の確認**＝起票 §1 の逐語（CASE 比較 NONZERO・probe INFINITY・HAVING 0 行）を
  修正前挙動として固定してから直す
- 受入＝起票 §4: `判定_変数=ZERO`・probe が `NONNEG`/`FINITE`・HAVING 1 行・
  リテラル版と全列一致・SELECT リスト既存値は不変
- **回帰観点 9 項目（調査報告 §6 末尾）を全部**＝CASE 直接 SUM 比較／HAVING 直接比較／
  AND・OR・NOT 内の複数 occurrence／引用符エスケープを含む文字列変数／DISTINCT・全 AggregateFunc／
  GROUPING SETS 系／**集計算術式・THEN/ELSE 集計が変化しない**こと／
  **HAVING 非掲出問題を B164 の合格条件へ混入させない**（別テストで現状挙動＋新診断を固定）／
  ORDER BY alias・window・UNION 各枝の非回帰
- 既存テスト変更は不可（あれば「仕様との差分」として報告）

## 3. 進め方と報告（従来どおり）

コード → テスト →（言語リファレンスに変更が必要なら §該当節のみ・README 等は Claude）。
`npm test` 全体（認証環境変数はプロセス内除外）。
最終メッセージ＝実装報告のみ（変更ファイル・受入↔テスト対応表・テスト結果・既存テスト変更・
差分・Claude 実機残項目）。
