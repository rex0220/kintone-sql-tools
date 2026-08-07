# B155 CTE→APP JOIN の取得クエリに B151/B152 で開放した WHERE 葉が合流しない

- 起票: 2026-08-08（[依頼元の v3.61.0 返信 §5](../../../ksql-analytics/docs/internal/kSQLエンジンへの返信-20260807-v3610.md)・エンジン側で再現確認済み）
- ステータス: 📝 **起票（評価前・優先 低〜中）**
- 関連: [B150](ksql_b150_cte_join_date_pushdown_issue.md)（結合キー側は解決済み）／
  [B151](ksql_b151_join_inclusive_range_pushdown_issue.md)／[B152](ksql_b152_join_pushdown_all_types_issue.md)

## 1. 症状（実測・v3.61.0）

同じ `WHERE t.個数 <= 100 AND t.製品名 = '牛乳' AND t.入出庫区分 = '出庫'` で:

```
CTE→APP（日付キー・範囲 prefilter）:
  kintone query: (日付 >= "2026-07-29" and 日付 <= "2026-08-04") and (入出庫区分 in ("出庫"))
  → 合流したのは選択系正規化の 1 本だけ。TEXT `=` と NUMBER `<=` が乗らない

物理→物理:
  kintone query: 日付 >= "2026-05-08" and 個数 <= 100（fetch: EXACT / relation: exact）
  → 両方乗る（v3.60.0 の開放どおり）
```

**結果は正しい**（残余再評価）。**取得量の削減が部分的**なだけ。

## 2. 原因の仮説（再現時の計画から）

CTE ソースの JOIN は `join pushdown plan: not applied: SOURCE_KIND` ＝
**B151/B152 を実装した field-vs-literal 分類器（`joinPredicatePushdown`）がこの経路では走らず**、
CTE 結合の取得クエリへ合流する条件は**別の古い機構（選択系の typed pushdown meta＝P2a 世代）だけ**が
収集している。**「経路ごとに揃っていない」系列（B145/B148/B150 と同族）の新標本**。

## 3. 対応の方向（未評価）

| 案 | 内容 |
|---|---|
| A | CTE→APP 結合の additional-push 収集を `joinPredicatePushdown` 分類器へ統一（B151/B152 の開放が自動で届く） |
| B | 文書化のみ（依頼元は `ksql_explain` 確認を規約化済み） |

依頼元の優先度は「低」（期間が乗った時点で十分絞れている）。**実装するなら案 A**＝
統一によって B154 の `not applied` 表示問題も同時に消える可能性が高い。

## 4. 次の一手

実需（大規模アプリでの CTE 結合の取得量）が出たら案 A を B150 方式で仕様化。
