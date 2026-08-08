# B163 一時テーブルの GROUP BY を含むバッチ EXPLAIN が InternalError

- 起票: 2026-08-08（[依頼元の v3.63.0 意見 §2](../../../ksql-analytics/docs/internal/kSQLエンジンへの意見-20260808-EXPLAIN2件.md)・実測裏取り済み）
- ステータス: 📝 **起票（EXPLAIN 面のみ・優先 中）**
- 関連: B123（EXPLAIN 計画の未対応形クラス）／[B65/B148]（GROUP BY 計画の schema 依存）

## 1. 症状（実測・2026-08-08・v3.63.0）

```sql
CREATE TEMP TABLE #t AS
WITH s AS (GENERATE_SERIES('2025-08-01', '2026-08-01', '1 month') AS 月)
SELECT DATE_FORMAT(s.月, '%Y-%m') AS 年月, m.製品名 AS 製品名
FROM s CROSS JOIN APP4229 AS m;

SELECT 製品名, COUNT(*) AS 月数 FROM #t GROUP BY 製品名
```

- `ksql_validate` → OK・`ksql_query` → OK（temp 104 行→GROUP BY 8 行）
- バッチ全体の `ksql_explain` →
  `InternalError: materialized schema #t is not available for GROUP BY planning.`

**問題は 2 層**: ①未対応形であること ②**InternalError という語がエンジンのバグに読める**こと
（実際は「EXPLAIN は一時テーブルを実体化しないため schema が無い」という設計上の未対応。
エラー品質の原則＝内部語を利用者に出さない、に反する）。

## 2. 原因（見立て・実装調査で確定させる）

EXPLAIN は一時テーブルを実体化しない契約のため、後段 SELECT の GROUP BY 計画が
`#t` の materialized schema を要求して throw する。**CREATE TEMP TABLE AS SELECT の
出力列（年月・製品名）は文 1 の SELECT 句から静的に導出できる**ので、原理的には
schema 静的伝播で計画可能なはず。

## 3. 案

- **案 A**: 文 1 の SELECT 句から静的 schema を導出し、後段を
  `source: temp table (schema from statement 1)` として計画表示（依頼元の期待の第 1 候補）
- **案 B**: `plan status: deferred (temp table)` で通す（計画は出さないが落ちない）
- **案 C（最低限）**: InternalError をやめ、ArgumentError＋回避案内
  （「バッチは kintone に触る文だけ個別に EXPLAIN する」＝依頼元の現回避）へ
- 見立て＝**最低ラインは案 C を即時**（InternalError の語は単独で直す価値がある）。
  案 A は B65/B148 の GROUP BY 計画層に静的 schema を渡す配線の費用を測ってから

## 4. 受入（起票時点の必須形）

§1 の逐語バッチの `ksql_explain` が InternalError を出さない（案 A なら GROUP BY 計画表示・
案 B/C なら明示的な未対応表示）。`ksql_query` の実行結果は不変。
