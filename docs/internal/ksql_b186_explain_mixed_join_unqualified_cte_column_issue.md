# B186 物理 APP と CTE を混在させた JOIN の WHERE に未修飾の CTE 列を書くと `EXPLAIN` だけが `WHERE_FIELD_UNRESOLVED` で落ちる — 実行は通る

- 状態: 📝 **起票（2026-09-16）**。未着手。実測 v3.77.0（MCP）と v3.78.0（CLI 再ビルド版）で同じ。「実行は正常なのに EXPLAIN だけ通らない」の 4 例目（B162 / B163 / B167 に続く）。改善（EXPLAIN 面のみ・実行不変）

## 1. 現象（dev profile・SFA パック）

```sql
WITH s AS (SELECT 顧客No_ AS CustNo, SUM(売上) AS Amount FROM APP4149 GROUP BY 顧客No_)
SELECT c.会社名, amount
FROM APP4148 AS c INNER JOIN s ON c.顧客No = s.custno
WHERE amount > 10000000
ORDER BY amount DESC LIMIT 3
```

| 経路 | 結果 |
| :--- | :--- |
| 実行（CLI / MCP `ksql_query`） | 成功。3 行（サイボウズ商事 20,700,000 ほか） |
| `EXPLAIN`（MCP `ksql_explain` v3.77.0・CLI `--dry-run` v3.78.0） | `ArgumentError: WHERE predicate is unsupported (field=amount, operator=>, reason=WHERE_FIELD_UNRESOLVED).` |
| 同じ SQL で WHERE を `s.Amount > 10000000` に修飾 | `EXPLAIN` も成功 |
| WHERE を外して `ORDER BY amount` だけ | `EXPLAIN` も成功 |

- 小文字 `amount` でも元表記 `Amount` でも同じ（B181 の修正とは無関係）
- 実行側は未修飾名を「実体化列に完全一致 → 物理側に同名が無ければ CTE 列」で解決する（B181 で明文化した規則）。`EXPLAIN` の WHERE 解析（`buildExplainWhereAnalysis` → `whereCapability`）は混在 JOIN で未修飾名を CTE 列へ解決せず、物理フィールドとしてだけ探して未解決にしている

## 2. なぜ問題か

- 第 9 回の三層は「`explain` が通れば押し下げの確認ができる」と書いている。`EXPLAIN` が偽陽性で落ちると、AI も人間も**正しい SQL を書き直す**（第 9 回付録の第 3 回依頼文で Claude Desktop が `WHERE` を書けば踏む形）
- B162 / B163 / B167 と同じ「EXPLAIN だけ通らない」型。修正のたびに「隣の経路」を測る約束（memory: check-sibling-path-when-fixing）の対象

## 3. 対応案

**案 A（EXPLAIN の WHERE 解析を実行時の解決規則に揃える）**: `EXPLAIN` の WHERE 解析でも `bindProjectedNamesForSelect` 後の名前で、CTE 列（`explainRelations` の `columns`）を候補に含める。未修飾名が CTE 列に解決できるときは `WHERE_FIELD_UNRESOLVED` にせず、既存の「実体化 source の述語は押し下げない」扱い（`join pushdown not applied: SOURCE_KIND` / JOIN 後に評価）で計画を出す。実行結果・EXPLAIN の他の行は不変

**案 B（文書のみ）**: 言語リファレンス §24 に「混在 JOIN の WHERE で CTE 列を使うときは修飾する」を書く。実行は通るので運用上は困らないが、非対称は残る

推奨は **A**。案 B は A までのつなぎとして §24 に 1 文足してよい

## 4. 受入条件

- §1 の SQL で `EXPLAIN` が成功し、`[main]` の行が「WHERE を `s.Amount` に修飾した形」と同じになる（述語の押し下げ判定は SOURCE_KIND で not applied のまま）
- 未修飾名が物理フィールドと CTE 列の両方に一致する場合（B181 のテスト `mixedClient` の `Amount`）は物理側で解析する（実行と同じ）
- 本当に存在しない列は従来どおり `WHERE_FIELD_UNRESOLVED`
- 既存の EXPLAIN snapshot（プラグイン同梱エンジン含む）が変わらない
- 助言をそのまま実行するテスト 1 本（第 9 回付録の第 3 回依頼文で AI が書く形＝CTE 集計 × 物理顧客の JOIN に未修飾 WHERE）

## 5. 経緯

- 2026-09-16: B181 のレビュー中、混在 JOIN の実機確認（`MIX WHERE CTE fold`）で `EXPLAIN` だけが落ちるのを発見。小文字でも v3.77.0 の MCP でも同じことを確認して B181 の範囲外と判断（[B181 codex 報告](ksql_b181_codex_impl_report.md) Claude レビュー §3）。v3.78.0 リリース後の別課題候補 4 件の起票で B186 に採番
- 関連: [B185](ksql_b185_explain_select_column_existence_issue.md)（EXPLAIN が通り実行で落ちる逆向き）、B162 / B163 / B167（EXPLAIN だけ通らない先例）
