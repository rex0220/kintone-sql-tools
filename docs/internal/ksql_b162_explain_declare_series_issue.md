# B162 DECLARE 変数 × GENERATE_SERIES の EXPLAIN が誤解を招く ArgumentError

- 起票: 2026-08-08（[依頼元の v3.63.0 意見 §1](../../../ksql-analytics/docs/internal/kSQLエンジンへの意見-20260808-EXPLAIN2件.md)・実測裏取り済み）
- ステータス: 📝 **起票（EXPLAIN 面のみ・優先 中）**
- 関連: [B149](ksql_b149_generate_series_issue.md)（variable-dependent 判定は実行へ委ねる契約）／
  B131（EXPLAIN と実行の乖離クラス）

## 1. 症状（実測・2026-08-08・v3.63.0）

```sql
DECLARE @m_start = '2025-08-01';
DECLARE @m_stop  = '2026-08-01';
WITH 月系列 AS (GENERATE_SERIES(@m_start, @m_stop, '1 month') AS 月)
SELECT 月 FROM 月系列
```

- `ksql_validate` → OK・`ksql_query` → OK（13 行）
- `ksql_explain` → `ArgumentError: GENERATE_SERIES の日付引数には実在する YYYY-MM-DD 形式の DATE を指定してください。`

**利用者は正しい DATE を書いている**のにこのエラー文が出る＝誤解を招く。
依頼元の運用「保存クエリは DECLARE で書く」×「本番クエリは EXPLAIN まで通す」が
両立せず、EXPLAIN 可能性を優先してリテラル固定へ後退した。

## 2. 原因（見立て・実装調査で確定させる）

EXPLAIN のバッチ計画は未解決の DECLARE 変数を**文字列プレースホルダ（`@名前`）で代用**する
（WHERE 表示には `pushdown candidate:` の placeholder 判定が既にある）。
GENERATE_SERIES の静的検証はこのプレースホルダを日付リテラルとして検証し失敗する。
B149 の「variable-dependent 判定は実行へ委ねる」が EXPLAIN 経路に通っていない。

## 3. 案

- **案 A**: DECLARE の**リテラル既定値を EXPLAIN で束縛**して計画表示（外部注入で変わり得る旨を
  1 行注記）。依頼元の期待の第 1 候補
- **案 B**: 束縛せず `series type: deferred (variable)`・`rows: runtime` の保留表示で通す
- **案 C（最低限）**: エラー文を「変数は EXPLAIN では解決されません」系へ変更
- 見立て＝案 A が運用に一番効く（既定値はリテラルで静的に読める）。B131 の「EXPLAIN は
  実行時情報を知らない」クラスとの線引きを仕様で明確化

## 4. 受入（起票時点の必須形）

§1 の逐語 SQL の `ksql_explain` が exit OK になり、系列計画（type/step/rows か deferred）を表示。
`ksql_query` の 13 行・`ksql_validate` OK は不変。
