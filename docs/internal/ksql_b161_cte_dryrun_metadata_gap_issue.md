# B161 CTE の物理ソース列推論が dry-run の metadata 要否判定から漏れ DryRunError（既存穴）

- 起票: 2026-08-08（**B157 最終チェック（codex）が机上で特定・Claude が実測確定**）
- ステータス: ✅ **v3.63.0 リリース（2026-08-08・CTE 物理ソーストリガ追加・実機確認済み）**
- 関連: [B157](ksql_b157_batch_dryrun_metadata_regression_issue.md)（最終チェックの出所）／
  B123・B150 修正 2（同族＝metadata 要否判定の穴）

## 1. 症状（実測・2026-08-08）

他に metadata トリガ（WHERE のフィールド・ORDER BY・JOIN 等）が無い **WITH＋物理 APP** の
最小形が、CLI `--dry-run` で DryRunError・exit 1 になる。**単文・複文とも**:

```
ksql --dry-run -e "WITH c AS (SELECT $id FROM APP4228) SELECT $id FROM c"
ksql --dry-run -e "SELECT 1 AS x; WITH c AS (SELECT $id FROM APP4228) SELECT $id FROM c"
→ DryRunError: API call should not happen in dry-run.
```

- **v3.61.0 でも再現**（worktree でビルドして実測）＝**既存穴。B157 の回帰ではない**
- v3.62.0 は複文形のみ `resolveMetadata=false`（B157 で修正した全スキップ）が偶然隠していた
- 非 CTE の単一表（`SELECT キー FROM APP4228`）は影響なし（実測 exit 0）

## 2. 原因

`explainNeedsAppMetadata`（`selectNeedsOwnMetadata`）が **CTE 本体の物理ソース列推論**を
metadata 需要として検出しない。判定 false → throwing client 選択のまま、
`buildExplainWhereAnalysis` の CTE 列 metadata 解決が `getFields()` に到達して throw。
**B150 修正 2（型依存 JOIN の検出漏れ）と同族**＝要否判定と実際の消費点の乖離。

## 3. 修正方針

`explainNeedsAppMetadata` に「WITH/CTE チェーンに物理ソースの SELECT を含む」トリガを追加
（B150 修正 2 の前例）。実 client 経路へ倒すだけで、表示・意味論は不変。
B155 静的経路（`dryRunUsesStaticTypedPlan`）は独立ゲートのため不変。

## 4. 受入

1. §1 の単文・複文が逐語で exit 0・records API 0 回（fields API は可）
2. B155 静的形（CTE→APP JOIN＋WHERE 候補）は従来どおり**全 API 0 回**・candidate 表示
3. 非 CTE 単一表・実 EXPLAIN・MCP は不変
4. 修正前 fail を固定してから直す（CLI e2e）
