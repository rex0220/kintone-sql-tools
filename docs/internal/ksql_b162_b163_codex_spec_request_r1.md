# B162・B163 仕様 R1 作成依頼（codex）——EXPLAIN の未解決情報の扱い 2 件

**仕様の作成依頼。コードは 1 行も変更しないこと。ファイルへの書き込みも不要。**
git 操作・kSQL MCP・MEMORY.md 禁止。

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（main・v3.63.0）

## 0. 依頼

**[B162](ksql_b162_explain_declare_series_issue.md)（DECLARE×GENERATE_SERIES の EXPLAIN）と
[B163](ksql_b163_explain_temp_groupby_internalerror_issue.md)（temp GROUP BY のバッチ EXPLAIN）を
1 本の仕様 R1 に束ねて書く。** 共通テーマ＝「EXPLAIN が実行時にしか確定しない情報
（変数値・一時テーブル schema）にどう向き合うか」の原則を先に立て、2 件をその適用として書く。

## 1. 決まっていること（変更しない）

- **実行・validate の挙動は一切変えない**（両形とも実行は正常＝実測済み）。EXPLAIN 面のみ
- **EXPLAIN の API 契約は不変**（records API 0 回・一時テーブルを実体化しない）
- **InternalError を利用者に出す現状は不可**（B163）。最低ラインは分類・文言の修正
- 起票の実測（2026-08-08・v3.63.0・逐語エラー 2 件・実行側の正常値）は再導出せずそのまま使う

## 2. あなたがコードから決めること（ファイル:行を添えて）

1. **B162 の方式選定**＝案 A（DECLARE のリテラル既定値を EXPLAIN で束縛・注入で変わり得る旨を
   表示）/ 案 B（deferred 表示）/ 併用。既存の変数プレースホルダ機構（`placeholder: true`・
   WHERE 表示の placeholder 判定）との整合。**既定値束縛が他の文型（WHERE・LIMIT・IN 等）へ
   波及する範囲**を列挙し、Phase を切ること（系列引数だけ先行も可）
2. **B163 の方式選定**＝案 A（CREATE TEMP TABLE AS SELECT の SELECT 句から静的 schema を導出し
   GROUP BY 計画へ渡す）/ 案 B（deferred 表示）/ 案 C（分類・文言のみ）。
   **案 C を即時に含めるか**（案 A の費用が高い場合の 2 段構え）はあなたが費用を測って判断
3. GROUP BY 計画（B65/B148 の 3 層）と materialized schema の結合点・
   静的 schema 導出の既存部品（`inferSelectColumnMeta` 等）の再利用可否
4. EXPLAIN 表示の形（`series type: deferred (variable)` / `source: temp table (schema from
   statement 1)` 等の行仕様）と、B131「EXPLAIN は実行時情報を知らない」クラスとの線引き

## 3. 仕様に必ず含めること

従来の型＝規則・適用経路（MCP/CLI/engine・単文/バッチ）・EXPLAIN 契約・受入条件
（**起票 2 件の逐語 SQL が必須形**・dry-run への波及確認・B155/B157/B161 静的経路の非回帰）・
Phase 線引き・Claude 実測項目。

## 4. 書き方の制約

従来どおり。**仕様の全文（Markdown）を最終メッセージで出力**。
