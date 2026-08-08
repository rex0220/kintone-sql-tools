# B157 実装の最終チェック報告（codex・2026-08-08）

- 対象: `b157/dev` の B157 実装（`e10ee56` 相当）
- 結論: **高 1 件**（→ 実測の結果 **v3.61.0 でも再現する既存穴**と確定し
  [B161](ksql_b161_cte_dryrun_metadata_gap_issue.md) として起票。B157 の回帰ではない）

## 指摘（高）

`throwing client + resolveMetadata=true` となる分岐は安全ではない。例えば複文
`SELECT 1; WITH c AS (SELECT $id FROM APP4228) SELECT $id FROM c` では
`explainNeedsAppMetadata=false`・`dryRunUsesStaticTypedPlan=false` となるため
throwing client を選択しつつ metadata 解決を行う（`src/cli/index.ts` の 2003 行・2263 行）。
`src/core/explainMetadata.ts` の判定（68 行〜）は WITH の物理ソース列推論を検出しないが、
metadata 解決は `src/execute.ts` の CTE 列 metadata 経路から `getFields()` に到達し
`DryRunError` になる。追加テスト（`b150_dry_run.e2e.test.ts` の B157 ケース）は
この分岐を覆っていない。

`!dryRunUsesStaticTypedPlan` 自体は正本方針および v3.61.0 相当への復帰と一致するが、
「client 選択と全分岐で対」「throwing client + true が安全」は成立していない。

## 観点別結論（指摘なし）

- B155 静的経路は `throwing client + resolveMetadata=false` のままで、
  API 0 回の非回帰テストも全 API 件数を検査している
- 単文・MCP・実 EXPLAIN 経路には B157 の変更は波及していない

## Claude の判定（追記）

指摘の再現形を実測 → **v3.61.0 の worktree ビルドでも同じ DryRunError**（既存穴）。
v3.62.0 は複文の全スキップが偶然隠していた。境界も実測で確定（非 CTE 単一表は無事）。
B157 はこのまま採用し、穴は [B161](ksql_b161_cte_dryrun_metadata_gap_issue.md) で
v3.63.0 に同梱する。
