# B59 ORDER BY alias 修正 — CLI 実機照合（dev・APP4221）

- 実施日: 2026-07-22
- 環境: dev プロファイル・APP4221
- 方法: `node dist-cli/ksql.js --profile dev -f <sql>`（全クエリ read-only・書き込みゼロ・復元不要）
- 比較対象: 修正前の同一クエリ実測（[B59 issue §1](../ksql_b59_orderby_alias_ignored_issue.md)・[B57 evidence §5](b57_date_axis_smoke.md)）

## 1. 修正前 NG 群 → 全 ✅（同一クエリの before/after）

| ケース | 修正前 | 修正後 | 判定 |
|---|---|---|---|
| `金額 AS m ORDER BY m`（FIELD・SIMPLE） | 出現順 0,-1,1,1000,3000 | **-1,0,1,1000,1001**（数値昇順） | PASS |
| `DISTINCT 金額 AS m2 ORDER BY m2` | 出現順 | 数値昇順 | PASS |
| `金額*2 AS x ORDER BY x`（ARITH） | 出現順 0,-2,2,… | **-2,0,2,2000,2002** | PASS |
| `LENGTH(タイトル) AS len ORDER BY len`（STRFUNC） | 出現順 6,3,4,3,2,2 | **2,2,2,2,3,3** | PASS |
| **発見時再現**: `DAYOFWEEK(日付) AS dw … GROUP BY … ORDER BY dw` | 出現順 4,3,1 | **1,3,4**（関数直書きと同一結果） | PASS |

## 2. 既存 ✅ 群の非回帰（同時実行）

- `COUNT(*) AS c … ORDER BY c DESC` → 55,4,2 ✓（チュートリアルの約束パターン）
- `SUM(金額)-0 AS d ORDER BY d` → 0,6000,62275 ✓・`MIN(金額) AS mn ORDER BY mn` → 空文字が先頭 ✓（v3 canonical band）
- `ROW_NUMBER() … AS rn ORDER BY rn DESC` → 59,58,57 ✓・CTE 実体化後 alias ✓

## 3. 契約テスト（unit・codex 実装・Claude 独立実行で確認）

- alias/物理列衝突は alias 優先・重複 alias 後勝ち・`OVER (ORDER BY 同一 SELECT alias)` 非解決（負性）・`$id` alias / ドット alias の planner guard（REST top-N/KORDER 非混入）・`ORDER BY 存在しないキー`=既存 `ORDER_KEY_UNRESOLVED` 非回帰・CASE/SCALAR_VALUE/LITERAL/SCALAR_SUBQUERY alias・UNION 各分岐 — `orderByAlias.test.ts`＋planner テストで固定（実装前 13 fail / 4 pass → 実装後 green）。

## 4. 自動ゲート（同日）

- `npm test`: 114 suites / 2,809 ＋ subprocess 2 / 25 ＝ **2,834 green**（Claude 独立実行・codex 報告と一致）
- `build:mcp` → `mcp:smoke` / `mcp:pack-smoke`: ok・`build:cli`: ok

## 5. 残確認

- プラグイン面はリリース準備のバンドル再ビルド時（B56/B57/B58 と同じ・v3.13.0 同梱想定）。
