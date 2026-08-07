# B157 CLI 複文バッチの --dry-run が metadata 解決を失い、診断と計画の kintone query が食い違う（v3.62.0 回帰）

- 起票: 2026-08-08（[依頼元の v3.62.0 返信 §5](../../../ksql-analytics/docs/internal/kSQLエンジンへの返信-20260808-v3620.md)・エンジン側で再現し原因確定）
- ステータス: 📝 **起票（原因確定・v3.62.0 回帰・表示のみ・優先 中）**
- 関連: [B155](ksql_b155_cte_join_where_merge_issue.md)（§5.3 静的経路の導入元）／
  [最終チェック報告](ksql_b155_final_check_report.md)（本件は取り残し）

## 1. 症状（実測・2026-08-08・v3.62.0）

**複文バッチ**の `--dry-run` で、同じ文に `kintone query:` が 2 回出て食い違う:

```
$ ksql --dry-run -e "SELECT 1 AS x; SELECT COUNT(*) FROM APP4228 WHERE 日付 >= TODAY()"
  where capability: EXACT_PUSHDOWN
  server predicate: 日付 >= TODAY()
  kintone query: 日付 >= TODAY()      ← 相対日付の診断ブロック（実 client で解決済み）
fetch summary: ALL
  mode:          FULL_SCAN
  kintone query: (全件取得)            ← 計画本体（metadata 未解決の悲観側）
```

**単文では起きない**（同じ SQL の単文 dry-run は `COUNT_ONLY` / `COUNT_TOTAL_COUNT` を表示し
実 EXPLAIN と一致）。v3.61.0 では複文バッチでも一致していた＝**回帰**。

依頼元は「dry-run はフォーム定義を取らないため悲観側」と理解して報告したが、
実際は**単文は取る。複文だけが v3.62.0 で取らなくなった**。

## 2. 原因（確定）

B155 実装（`0b4c939`）が CLI のバッチ dry-run 呼び出しへ **`resolveMetadata=false` を
無条件に渡す**ようにした（`src/cli/index.ts` の `buildBatchExplainPlans(..., false)`）。

- このフラグは **B155 静的経路（CTE→APP JOIN 形・API 0 回）のため**のもの
- しかし呼び出し分岐は `args.dryRun && (isBatchSql || dryRunUsesStaticTypedPlan)` で、
  **B155 形を含まない普通の複文バッチも同じ `false` を通る**
- 一方 `resolveRelativeDateExecutionPlan` は実 client（`dryRunNeedsMetadata` 時）で
  従来どおり解決するため、**診断ブロックだけ楽観・計画本体だけ悲観**の食い違いが出る
- v3.61.0 は同分岐で `resolveMetadata`（当時は引数なし＝常に解決）だった

## 3. 影響範囲

- **表示のみ**（実行・結果・API 契約は不変。dry-run の exit 0 も維持）
- ただし依頼元の指摘どおり**「上の楽観行を読んで絞れると判断し、下を見落とす」誤読**があり、
  複文バッチは依頼元の標準形なので露出は広い
- MCP `ksql_explain` は別経路（常に解決）で**影響なし**

## 4. 修正方針

`resolveMetadata` は **B155 静的経路を選んだときだけ false**、それ以外は v3.61.0 どおり解決する:

```
resolveMetadata = !dryRunUsesStaticTypedPlan
```

（`dryRunUsesStaticTypedPlan` は [B155 最終チェック修正](ksql_b155_final_check_report.md)で
相対日付 resolver 必要時に false になるため、実 client と常に対で動く）

## 5. 受入（逐語）

1. `SELECT 1 AS x; SELECT COUNT(*) AS 直近件数 FROM APP4228 WHERE 日付 >= TODAY()` の
   `--dry-run` が `fetch summary: COUNT_ONLY`・`mode: COUNT_TOTAL_COUNT` を表示し、
   `kintone query:` が診断・計画本体とも `日付 >= TODAY()` で一致（records API 0 回）
2. B155 静的形（CTE→APP JOIN＋WHERE 候補）の dry-run は従来どおり **API 0 回**・
   `pushdown candidate:` 表示（`b150_dry_run.e2e.test.ts` の既存契約を維持）
3. 単文 dry-run・実 EXPLAIN・MCP は不変

## 6. 教訓（最終チェックの取り残し）

B155 最終チェックは混在バッチの **exit 0** までは実測したが、**非 B155 文の表示同等性**
（v3.61.0 との plan 一致）を見なかった。回帰検査は「落ちないこと」ではなく
**「前版と同じものが出ること」**まで比べる。
