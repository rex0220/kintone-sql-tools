# B154 `join pushdown plan: not applied` の行が `join key prefilter` の適用と誤読される

- 起票: 2026-08-08（[依頼元の v3.61.0 返信 §4](../../../ksql-analytics/docs/internal/kSQLエンジンへの返信-20260807-v3610.md)）
- ステータス: ✅ **v3.62.0 リリース（2026-08-08・B155 に同梱＝`not applied` 行へ but 書きを追加）**

## 1. 何が起きるか

CTE→APP JOIN の `EXPLAIN` は次のように出る（v3.61.0 実測・再現確認済み）。

```
join pushdown plan: not applied
join pushdown not applied: SOURCE_KIND
  ...
  join key prefilter: range
  fetch:         PREFILTERED
```

`join pushdown`（field-vs-literal の計画）と `join key prefilter`（結合キーの絞り込み）は
**別の仕組みで、表示としては正しい**。しかし**名前が似ているため、上の行だけ見て
「絞れていない」と読む余地**がある（依頼元は「信用するのは `fetch:`」を規約化して回避）。

## 2. 依頼元の要望（弱・急がない）

`not applied` の行に**「（別途 `join key prefilter` が適用されています）」の但し書き**があると
読み間違いが構造的に消える。

## 3. 次の一手

安価な表示追記。B155（経路統一）を先にやると `not applied` 自体が減るため、**B155 の後**が自然。
