# B148 実装報告（codex）と Claude レビュー

- 実施: 2026-08-06（v3.56.3 の作業ツリー）
- 依頼: [実装依頼](ksql_b148_codex_impl_request.md)
- 仕様: [R3](ksql_b148_bare_column_group_by_spec_r3.md)

---

B148 を R3 に基づいて実装しました。git 操作・kSQL MCP・MEMORY.md の参照は行っていません。

## 1. 変更ファイル

実装:

- [aggregateDependencyValidation.ts](C:/Users/rex02/Projects/kintone-sql-tools/src/core/aggregateDependencyValidation.ts)
  - 共通の集計 query 判定、依存走査、canonical identity、semantic leaf、alias 解決、first error、エラー生成を新設。
- [plainGroupByPlan.ts](C:/Users/rex02/Projects/kintone-sql-tools/src/core/optimization/plainGroupByPlan.ts)
  - ordinary policy が利用する source-aware field resolution を追加。
- [groupingValidation.ts](C:/Users/rex02/Projects/kintone-sql-tools/src/core/groupingValidation.ts)
  - B65 の句依存検査を共通層へ移動。
  - B65 固有の membership、物理限定、上限、alias collision は維持。
  - 人間向け本文から `B65` / `Phase1` を除去。
- [grouping.ts](C:/Users/rex02/Projects/kintone-sql-tools/src/core/grouping.ts)
  - grouping 上限エラーの人間向け表現を更新。
- [execute.ts](C:/Users/rex02/Projects/kintone-sql-tools/src/execute.ts)
  - plain plan 後の schema-aware B148 検査を追加。
  - direct APP、JOIN、CTE、一時テーブル、UNION、サブクエリ、SELECT-based DML、EXPLAINへ接続。
  - EXPLAIN の CTE/temp relation schema 伝播と `ALIAS_SAFE` 表示を追加。
  - records API 前の query-block preflight 順を調整。

テスト:

- [b148BareColumnGroupBy.test.ts](C:/Users/rex02/Projects/kintone-sql-tools/src/__tests__/b148BareColumnGroupBy.test.ts) を新設。
- B148 の意図した破壊的変更に合わせ、次を更新:
  - `b71GroupByAliasStep2.test.ts`
  - `b71Step4Regression.test.ts`
  - `b72RelativeDateFullScanExactStep2.test.ts`
  - `b94CountTotalCount.test.ts`
  - `b105UnionCountTotalCount.test.ts`
  - `b67RelativeDateSurfaces.test.ts`
  - `b65GroupingStaticValidation.test.ts`
  - `b65GroupByConsumerAllowlist.test.ts`

build により plugin、CLI、MCP、MCPB、engine の配布物も再生成されています。

## 2. 3層分離

- 共通層:
  - `aggregateDependencyValidation.ts`
  - SELECT → HAVING → ORDER BY の順序、左から右の走査、aggregate/window/subquery 境界、wildcard、alias、canonical expression、semantic leaf、machine reason を担当。
- ordinary policy:
  - plain plan の `PHYSICAL` / `ALIAS_SAFE` / `EXPRESSION` から identity を構築。
  - `(sourceIndex, fieldCode)` を使用し、物理フィールド優先と alias fallback の既存規則を維持。
  - GROUP BY なし集計は空 identity。
- B65 policy:
  - `groupingValidation.ts` に物理 APP 項目限定、`GROUPING()` membership、set/item 上限、KORDER/window 制限、aggregate alias collisionを残した。
  - 句依存走査だけを共通層へ委譲。

machine reason は `B65_NON_GROUPED_DEPENDENCY` のままです。

## 3. `npm test`

指定された5資格情報を unset して実行しました。

- 通常: 234 suites / 5519 tests / 22 snapshots
- subprocess: 2 suites / 26 tests
- 合計: **236 suites / 5545 tests**
- 失敗: **0**

version-sync と docs-check も通過しています。

## 4. `npm run build`

成功しました。

- plugin
- CLI
- MCP
- MCPB
- engine

`dist/ksql-plugin-v3.56.3.zip` を含む全成果物が再生成されています。

## 5. 既存テストを書き換えた理由

意味が変わったテストがあります。

旧テストには、物理フィールドと SELECT alias が衝突した状態で、別の非 grouping 列を先頭行から返す SQLや、GROUP BY なしで bare column と `COUNT(*)` を併用する SQLがありました。

これらはまさに B148 が禁止する対象なので、成功結果ではなく以下を確認するテストへ変更しました。

- `ArgumentError`
- `B65_NON_GROUPED_DEPENDENCY`
- 正しい最初の依存名
- records API 0
- DMLでは mutation API 0

B67 の KORDER fixture は、B148 に先に拒否されない aggregate alias ORDERへ変更し、元の相対日付テストの意味を維持しています。

## 6. 実装しなかった部分

- R3 §14 の公開ドキュメント、CHANGELOG、移行案内更新:
  - 今回指定された実装範囲が §2〜§8・§11〜§12 だったため未変更です。
- 複雑式、HAVING、ORDER BY、JOIN、CTE等のエラーでは、不完全な完成SQLを生成せず安全な修正方針だけを表示します。
  - 単純な direct APP列では、表示した完全SQLを実際に parse・実行するテストを追加しました。
  - R3 §8 が全ケースで具体的な完成SQLを要求すると解釈する場合、ここは未完です。汎用AST→SQL serializerが存在せず、推測で生成すると `GROUP BY CASE` やalias衝突を再導入するため、黙って危険な例を出さない形にしました。

## 7. R3 §16 の確認範囲

ローカルで確認済み:

- ordinary field/expression/alias grouping
- CASE alias、算術、文字列関数、concat、scalar subquery関連の既存回帰
- semantic leaf
- source identity付きJOIN
- UNION、scalar subquery、CTE、一時テーブルのAPI境界
- INSERT / UPSERT SELECT のfetch/mutation 0
- EXPLAIN のCTE/temp schema伝播
- B65 wildcard、membership、上限、alias collision、JOIN、machine reason
- window-only成功
- aggregate＋windowの既存 `ParseError`
- 通過する既存SQLの全テスト回帰
- 単純列向け表示SQLの再parse・実行

Claudeの実測が必要:

- 実APP上の全 `ALIAS_SAFE` 値・行順

---

## Claude レビュー（2026-08-06・実測つき）

**結論＝おおむね良い。指摘 3 件（中 2 / 低 1）はすべてエラー文の表示。規則本体と回帰に問題は無い。**

### A. ゲート（Claude が自分で測った）

| | |
|---|---|
| `npm test` | **236 suites / 5,545 tests / 0 失敗**（234+2・報告と一致） |
| `version:check` / `docs:check` / `mcp:verify` | 全通 |

### B. 実機（`dist-mcp/ksql-mcp.js` を stdio 起動・実 kintone APP4228）

**通り続けるべき 10 形すべて、値も変わらず通る。**

| 形 | 結果 |
|---|---|
| 主用途 `DATE_FORMAT(...) AS 年月 … GROUP BY 年月` | **13 行・値不変** |
| `CASE … AS 区分 … GROUP BY 区分` | 大 48425 / 小 37013 |
| **`YEAR(日付) + 1 … GROUP BY YEAR(日付)`**（semantic leaf） | **2026 / 2027** |
| `SUM(個数) OVER ()`（ウィンドウ専用） | 3 行 |
| `GROUP BY ROLLUP(日付)` に対するキーの式 | 値不変 |
| `個数 + 1 … GROUP BY 個数` | 647 / 707 |
| 素の `SELECT 製品名, 個数` | 不変 |
| `SELECT SUM(個数)`（集計だけ） | 85438 |
| `GROUP BY ROLLUP(製品名)` | 不変 |
| scalar subquery alias grouping | 2026-08-04 / 85438 |

**エラーになるべき 8 形すべて発火する**（`GROUP BY` あり／なし／`HAVING`／`ORDER BY`／wildcard／
式の不一致／CTE 本体／部分木の不一致）。

**`EXPLAIN` でも同じエラー。** **`CREATE TEMP TABLE` の source も拒否され、後続は fail-fast で skip。**

**B140 の主用途（CTE ＋ `LAG`）も `EXPLAIN` / 実行とも従来どおり動く。**

### C. 【中】式の違反が「式」としか表示されない

```
SELECT DATE_FORMAT(日付,'%m') AS 月, SUM(個数) AS 合計 FROM APP4228 GROUP BY 製品名
  → SELECT 式「式」は集計もグループ化もされていません（APP4228、非グループ化依存: 日付）。
```

**別名 `月` があるのに使っていない。** 素の列では正しく名前が出る（`SELECT 式「個数」`）。

**R3 §8.2 は「違反式」を示すことを要求している。**
**列が多い SELECT では、どの式かを利用者が探すことになる**
（`非グループ化依存: 日付` が手掛かりにはなるが、**同じ列を使う式が複数あると絞れない**）。

**対応案＝別名があれば別名を使う**（`SELECT 式「月」`）。無ければ**列位置**（`SELECT 2 列目の式`）。

### D. 【中】`GROUP BY` の表示も「式」になる

```
GROUP BY DATE_FORMAT(日付,'%Y')  →  「GROUP BY 式 の各グループでは」
```

**R3 §8.2 は「現在の `GROUP BY`」を示すことを要求している。**
**対応案＝C と同じ**（grouping item に別名があればそれ、無ければ位置）。

### E. 【低】書き換え例が他の列を落とす

```
入力: SELECT 製品名, 個数, 日付, SUM(個数) AS 合計, COUNT(*) AS 件数 … GROUP BY 製品名
例示: SELECT 製品名, MIN(個数) FROM APP4228 GROUP BY 製品名
```

**`日付` / `SUM(個数)` / `COUNT(*)` が消えている。**
**R3 §8.3 の骨子は、元の列を保った完成形だった。**

**「実行可能な書き換え例」と断っており、示された SQL は実際に動く**ので致命ではない。
**そのまま貼り替えると列を失う**点だけが差。

**対応案＝文言を「最小の例」と明示するか、元の列を保った形にする。**

### F. codex の自己申告（§6）への判断＝**実装側が正しい**

> 複雑式・`HAVING`・`ORDER BY`・JOIN・CTE 等では、不完全な完成SQLを生成せず
> 安全な修正方針だけを表示する。汎用 AST→SQL serializer が無く、推測で生成すると
> `GROUP BY CASE` や alias 衝突を再導入するため。

**この判断を支持する。** **R3 §8.5〜§8.8 は完成 SQL を示すと書いたが、
それは「serializer がある」前提を暗に置いていた。**

**推測で SQL を組み立てるのは、まさに「従うと壊れる助言」の作り方**である
（[B140](ksql_b140_cte_groupby_total_order_issue.md) / [B145](ksql_b145_describe_subtable_field_issue.md) で 3 回）。
**黙って危険な例を出すより、方針だけ示すほうが良い。**

**→ R3 §8 を実装に合わせて改める**（完成 SQL は単純な direct APP 列に限る、と明記）。

### G. 既存テストの書き換え（8 本）

**すべて「B148 が禁止する形を成功として固定していた」テスト**で、
**意味の変更は意図した破壊的変更と一致する。**

**1 本だけ性質が違う**＝`b67RelativeDateSurfaces.test.ts` は
**B148 に先に拒否されない `ORDER BY` へ fixture を変え、元の相対日付テストの意味を保っている。**
**これは正しい直し方**（テストの目的を変えずに、B148 と衝突しない題材へ移した）。

### H. 挙動変更の自己申告（§8）

> 従来 `EXPLAIN` が materialized schema を `DEFERRED` としていた点を、
> CTE output columns を伝播して確定するよう変更した。

**B148 の範囲を超える変更**だが、**R3 §6.6 が要求している**（`EXPLAIN` でも同じ診断）ので妥当。
**実機で `EXPLAIN` の CTE 計画が従来どおり出ることを確認済み。**

### I. 残件

- **R3 §14（言語リファレンス §8・CHANGELOG・移行案内）は未実施**（実装範囲外と指示したため）
- **R3 §16 のうち Claude 実測が要るもの**＝プラグインのブラウザ実測・全 surface の表示
