# B59 修正仕様 — `ORDER BY <alias>` の黙殺を解消（alias 値解決の追加）

- ステータス: 📋 **修正仕様 R2（2026-07-22・codex レビュー R1→R2 反映済＝P1×5/P2×3/P3×3 全件裏取り一致・実装着手可）**
- 起票: [B59 issue](ksql_b59_orderby_alias_ignored_issue.md)
- 種別: バグ修正（正しさ・silent wrong order）／SemVer: **minor**（B9 前例＝観測結果が変わる正しさ修正を minor 出荷・CHANGELOG に「従来 no-op だった alias ORDER BY の結果順が変わる」を明記）
- 関連: B26/B27（v3 整列意味論・order planner）／v2.1.2（集計算術 alias の同種修正前例）
- R1→R2 の主な変更（codex レビューで R1 の前提誤り 2 件を訂正）: ①「存在しないキーは黙殺」は誤り＝**B27 planner が取得前に `ORDER_KEY_UNRESOLVED` を throw 済み**（canonicalOrderPlanner.ts:65-87・execute.test.ts:2072 で固定済み）→B59 は「**planner では解決済みの SELECT alias の値評価だけが欠落**」という不具合に再定義・別課題化は不要 ②「実フィールド優先」は誤り＝metadata 層（execute.ts:4249 `aliasSemantics.get(name) ?? physical`）と取得列解析（selectToKintone.ts:431＝SELECT alias は物理取得対象から除外）が既に **alias 優先**であり、値解決だけ逆にすると値と型が別列になる→**alias 完全一致優先で三層統一** ③window ORDER の分離・SIMPLE 経路の供給・CASE 評価コンテキスト・`$id`/ドット alias の planner guard を追加

## 1. 影響マトリクス（2026-07-22 実測・CLI dev APP4221＋engine 直接 probe）

| alias の列種 | GROUP BY | 結果 |
|---|---|---|
| `COUNT(*) AS c`（AGGREGATE）・`SUM(金額)-0 AS d`（ARITH_AGG_COL）・`ROW_NUMBER() AS rn`（WINDOW）・CTE/temp 実体化後 | — | ✅ |
| `金額 AS m`（FIELD・**SIMPLE 経路**）・`金額*2 AS x`（ARITH_COL）・`LENGTH(t) AS len`（STRFUNC_COL・GROUP BY 有無とも）・DISTINCT 併用 | — | ❌ 黙殺 |
| CASE_COL / SCALAR_VALUE_COL / LITERAL_COL / SCALAR_SUBQUERY_COL alias | — | 未実測（構造上 ❌ 見込み・受入で確認） |

公開文書（チュートリアル・Qiita の `ORDER BY 件数 DESC`）は ✅ 側。v2.1.2 が「alias 参照 ORDER BY」を受入条件にした前例あり＝**意図された機能の欠落**。

## 2. 根本原因（4 層・実測確定・codex 裏取り済）

1. FULL_SCAN パイプラインは `… → 6. window → 7. distinct → 8. ORDER BY → 10. project`＝**射影（alias キー生成）はソートの後**。SIMPLE 経路も `flatten → applyOrderBy → applyLimit → project`（execute.ts:2498-2509）で同型。
2. ソート前に alias キーを行へ書くのは AGGREGATE（alias＋合成名併記＝process.ts:280-285）・ARITH_AGG_COL（:287）・集計内包 STRFUNC/SCALAR_VALUE（:289-297）・WINDOW（applyWindow:739）のみ。**FUNC_KEY グループキーは合成名のみ**（:271）・**非集計の射影列は書かれない**。
3. `evalOrderKey` の FIELD_NAME 分岐（:694）は `row[key.name] ?? ""`＝キー不在で全行 `""` → 安定ソート no-op。
4. `applyOrderBy`/`sortDecoratedRows` 自体は正常（単体 probe で確認）。**planner は alias を解決済み**（`buildOrderSemanticsForSelect` が alias semantics を供給→`ORDER_KEY_UNRESOLVED` にならない）のに、**値評価だけが欠けている**のが B59 の本質。

## 3. 修正設計

### 3.1 解決の優先順位（三層統一・決定的規則）

トップレベル `ORDER BY` の FIELD_NAME キーは:

1. **SELECT 出力 alias の完全一致を最優先**（ドットを含む alias も完全一致で優先＝修飾物理列より前。alias と同名の物理列にはアクセスできなくなることを言語リファレンスへ明記）
2. 一致しなければ**入力行フィールド**（従来どおり）
3. どちらも解決できなければ**既存の planner fail-closed**（`ORDER_KEY_UNRESOLVED`・変更なし・非回帰テストで維持）

これにより値解決・整列 semantics（execute.ts:4249 の alias 優先）・取得列解析（selectToKintone.ts:431 の alias 除外）の**三層が同じ優先順位**になる。**重複 alias は project の後勝ちに揃える**（最後の同名列を採用・テストで固定）。

### 3.2 値の評価（alias evaluator）

`applyOrderBy` に**任意の alias evaluator コールバック**を追加し、SELECT 列から事前コンパイルして渡す。列種ごとの値ソース:

| 列種 | 値ソース |
|---|---|
| AGGREGATE / ARITH_AGG_COL / WINDOW_COL / 集計内包 STRFUNC・SCALAR_VALUE | `row[alias]`（ソート前に書込済＝現行 ✅ 群・挙動不変） |
| FIELD | `row[解決済みフィールドキー]`（JOIN 修飾は project と同じ規則） |
| ARITH_COL | `evalArithExpr` |
| STRFUNC_COL（集計なし） | `evalStringFunc` |
| CASE_COL | `evalCaseWhen`＋**project と同等の評価コンテキスト**（`FieldTypeResolver`/`FieldSemanticsResolver`。型付き IN を含む CASE が出力とソートで食い違わないため） |
| SCALAR_VALUE_COL | `evalScalarValueExpr`＋同上 |
| LITERAL_COL | リテラル値（全行同値＝安定ソートで従来順） |
| SCALAR_SUBQUERY_COL | `scalarCache` 経由（project と同じ） |

### 3.3 適用範囲（供給と非供給）

- **供給する**: `runFullScan`（stage 8）と **`executeSimpleSelect` のローカルソート**（execute.ts:2500）＝実測 NG の全経路。両呼び出し元から `stmt.columns`＋評価コンテキスト（resolvers・scalarCache）を渡す。
- **供給しない**: `applyWindow` の `OVER (ORDER BY …)`（`sortDecoratedRows` の本番共有はこの 2 箇所のみ＝codex 全数確認）。**OVER 内で同一 SELECT の alias を解決してはいけない**（既存仕様はスコープを CTE で分ける設計・負性テストで固定）。REORDER は別比較器（execute.ts:7569）で対象外・KORDER は alias 拒否維持。

### 3.4 planner guard（押し下げ混入の防止）

- REST top-N の同値判定（canonicalOrderPlanner.ts:89 `name === "$id"`）と KORDER の `$id` 特例（korderPlanner.ts:44）は**名前だけで判定している**ため、`SELECT 金額 AS `$id`` のような alias が押し下げへ混入し得る。**「その名前が SELECT alias として解決される場合は直接列扱いしない」ガード**を両 planner に追加（alias なら CANONICAL_LOCAL / KORDER は拒否）。

## 4. 受入条件

1. **マトリクス全 ✅ 化**: §1 の ❌ 群（FIELD/ARITH/STRFUNC×GROUP BY 有無/DISTINCT/SIMPLE）＋CASE/SCALAR_VALUE/LITERAL/SCALAR_SUBQUERY alias が昇順・降順とも正しく並ぶ。B57 発見時の再現クエリ 2 種の実機確認。
2. **型**: `金額 AS m`=数値順・`DAYOFWEEK(…) AS dw`=数値順・テキスト=コードポイント順・STATUS=定義順（alias semantics 経路の非回帰）。
3. **規則**: alias と同名物理列の衝突→alias 優先（`SELECT 金額 AS 名前 … ORDER BY 名前`＝金額の値・金額の型）・重複 alias→後勝ち・**`OVER (ORDER BY 同一 SELECT alias)` は解決しない**（負性テスト）。
4. **planner guard**: `$id` alias・ドット含み alias が REST top-N/KORDER へ混入しない（LOCAL/拒否）。
5. **fail-closed 非回帰**: `ORDER BY 存在しないキー` は従来どおり `ORDER_KEY_UNRESOLVED`（既存テスト維持）。
6. **非回帰**: ✅ 群・合成名参照・関数直書き ORDER BY・B30 完全入力・sort後 LIMIT/OFFSET・UNION 各分岐の alias ORDER BY（**UNION に最終再ソート段は無い**＝各分岐の回帰確認と明記・execute.ts:3401/3426）・サブテーブル仮想テーブルの alias・全テスト green。

## 5. 同期箇所

- `src/engine/process.ts`（`applyOrderBy` シグネチャ＋alias evaluator・`evalOrderKey`）・`src/execute.ts`（runFullScan/executeSimpleSelect からの供給・alias evaluator のコンパイル）
- `src/core/optimization/canonicalOrderPlanner.ts`・`korderPlanner.ts`（§3.4 guard）
- 契約テスト（マトリクス全組み合わせ＋§4 の規則群）・実機 evidence
- 言語リファレンス §ORDER BY（alias 参照可・alias 優先規則・重複 alias 後勝ち・OVER 内不可）
- `CHANGELOG.md` 未リリース見出し（観測結果が変わる旨）・tracker / issue / spec ステータス行
- B55 カタログ・予約語は対象外（関数追加ではない）

## 6. 解決済み論点

- **R1-Q1: 撤回**。未知キーは現行すでに fail-closed（`ORDER_KEY_UNRESOLVED`）。B59 は解決済み alias の値評価欠落の修正であり、別課題は不要（codex 指摘採用）。
- **R1-Q2: `applyOrderBy` 内部一元化を採用**。ただし evaluator はトップレベル呼び出し（runFullScan/executeSimpleSelect）のみに供給し、`applyWindow` へは渡さない（codex 条件付き賛成のとおり）。
