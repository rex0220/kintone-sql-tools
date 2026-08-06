# B148 仕様 R3 作成依頼（codex）

**仕様の作成依頼。コードは 1 行も変更しないこと。ファイルへの書き込みも不要。**
git 操作をしないこと（`git status` も含む）。kSQL MCP を叩かないこと。`npm test` は不要。
**自分の MEMORY.md は読まないこと**（このファイルと参照先だけで完結させる）。

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（v3.56.3）

## 0. 依頼

**B148 の仕様 R3 を、そのまま実装依頼に出せる形で書いてほしい。**
**R1・R2 は破棄済み。R3 が正本になる。**

**出力は R3 の全文（Markdown）1 本。** レビューは別途 Claude が行う。

| ファイル | 役割 |
|---|---|
| `docs/internal/ksql_b148_bare_column_group_by_issue.md` | 起票（実測あり） |
| `docs/internal/ksql_b148_codex_review_1.md` | **R1 のレビュー＋実測検証。§6 に既存検査の到達範囲**（重要） |
| `docs/internal/ksql_b148_codex_review_2.md` | **R2 のレビュー＋実測検証。あなたの前回の指摘と推奨案**（重要） |
| `docs/internal/ksql_b148_bare_column_group_by_spec_r2.md` | 破棄した R2（構成の下敷きとしてのみ） |
| `src/core/groupingValidation.ts` | **既存検査（B65）。R3 はこれを 3 層に分ける** |
| `src/core/optimization/plainGroupByPlan.ts` | plain GROUP BY の解決 plan |
| `src/core/grouping.ts` / `src/engine/process.ts` / `src/execute.ts` / `src/types/ast.ts` / `src/parser/parser.ts` | 実行経路 |
| `docs/ksql_language_reference.md` §8 | GROUP BY の契約 |

## 1. 決まっていること（変更しない）

- **方針＝標準 SQL に合わせる**（オーナー判断）。**警告ではなくエラー**
- **破壊的変更でよい**。依頼元の資産・掲載 SQL に該当が無いことは確認済み
- **移行先は `MIN(<列>)` または `GROUP BY` への追加**。`ANY_VALUE` は新設しない
- **事前照会をしないので、エラー文が唯一の案内**（保存クエリ・プラグイン利用者向け）

## 2. R2 のレビューで確定した設計方針（**R3 に反映すること**）

**あなた自身が前回出した推奨案。R3 ではこれを採用した前提で書いてよい。**

1. **3 層分離**（Critical 1 推奨案 B）＝
   共通層（`SELECT`/`HAVING`/`ORDER BY` の依存収集・集計内部・サブクエリ境界・wildcard・first error）／
   ordinary policy（plain plan から identity 構築）／
   B65 policy（物理限定・`GROUPING()` membership・set/item 制限・alias collision）
2. **集計とウィンドウの同一 `SELECT` 併用は従来どおり `ParseError`**（High 1 推奨案 B）。
   **`WINDOW_COL` は B148 の走査対象外**。**「未確定」ではなく回帰受入として書く**
3. **CTE・一時表・EXPLAIN は検査時点を分ける**（High 2 推奨案 B）＝
   direct APP は statement preflight、CTE 本体はその CTE の実行直前、
   **records API 0 の意味を「違反 query block 自身」で定義する**
4. **canonical identity は対象ノードと再帰規則を列挙し、
   grouping expression と一致する部分木を semantic leaf として走査を止める**（High 3 推奨案 B）
5. **移行案は式種別と alias 解決結果に応じて変える**（High 4 推奨案 B）
6. **human-readable message と machine reason を分離し、
   `B65_NON_GROUPED_DEPENDENCY` を維持して人間向け本文から `B65`/`Phase1` を除く**（Medium 1 推奨案 B）

## 3. 実測で確定している事実（**再導出せず、そのまま使うこと**）

**すべて v3.56.3・実アプリ APP4228（製品名 / 個数 / 日付 / 入出庫区分・1000 レコード）で確認済み。**

### 3.1 現状の欠陥

```
SELECT 製品名, 個数, 日付, SUM(個数) AS 合計, COUNT(*) AS 件数 FROM APP4228 GROUP BY 製品名
  → 食パン / 646 / 2025-08-05 / 23429 / 220     （個数・日付はグループ先頭行の値）

SELECT 製品名, 個数, SUM(個数) AS 合計, COUNT(*) AS 件数 FROM APP4228
  → 食パン / 646 / 85438 / 1000     （1 行。GROUP BY 無しでも同じ）

SELECT 製品名, SUM(個数) AS 合計 FROM APP4228 GROUP BY 製品名 HAVING 個数 > 0
  → エラーにならず 3 行返る
```

### 3.2 拡張 grouping では既に効いている

```
GROUP BY ROLLUP(製品名) + SELECT の非集計列   → B65 non-aggregate field 個数 in SELECT is not a grouping item (reason=B65_NON_GROUPED_DEPENDENCY)
同上 HAVING                                    → 同じ文面で in HAVING
同上 ORDER BY                                  → 同じ文面で in ORDER BY
SELECT *, SUM(個数) ... GROUP BY ROLLUP(製品名) → B65 wildcard projection is not supported in Phase1.
JOIN 修飾名                                    → 同じ文面で t.個数 と名指し
CTE の中                                       → 同じ文面
GROUP BY ROLLUP(年月)（別名）                  → B65 field 年月 does not exist in a physical APP source.
SELECT 個数 + 1 ... GROUP BY ROLLUP(個数)      → 通る。キー 646 → 647 で値も正しい
```

### 3.3 通り続けなければならない形（実測で動作を確認済み）

```
SELECT DATE_FORMAT(日付,'%Y-%m') AS 年月, SUM(個数) FROM APP4228 GROUP BY 年月   -- 主用途。13 行（月次）
SELECT CASE WHEN 個数 > 100 THEN '大' ELSE '小' END AS 区分, SUM(個数) FROM APP4228 GROUP BY 区分  -- 大 48425 / 小 37013
SELECT YEAR(日付) + 1 AS 翌年, SUM(個数) FROM APP4228 GROUP BY YEAR(日付)         -- 2026 / 2027。値も正しい
SELECT SUM(個数) OVER () AS 総計 FROM APP4228                                     -- 3 行。ウィンドウだけでは集計クエリにしない
SELECT DATE_FORMAT(日付,'%Y-%m') AS 年月, SUM(個数) FROM APP4228 GROUP BY ROLLUP(日付)  -- 日ごとの合計に月ラベル。値は正しい
```

### 3.4 `ParseError` になる形（規則の対象外・R3 で前提にしてよい）

```
SELECT ... HAVING COUNT(*) > 0（GROUP BY 無し）  → ParseError（2 形で確認）
SELECT 製品名, SUM(個数), ROW_NUMBER() OVER (...) ... GROUP BY 製品名
  → ParseError: ウィンドウ関数は GROUP BY / 集計関数と同じ SELECT では使用できません
GROUP BY CASE WHEN ... END                        → ParseError（CASE は別名経由のみ）
```

### 3.5 偽陽性を作ってはいけない反例

```
物理フィールド 年月 がある状態での SELECT DATE_FORMAT(日付,...) AS 年月 ... GROUP BY 年月
  → GROUP BY は物理 年月 を取る（実測で出力に重複が出ることを確認済み）。DATE_FORMAT の 日付 が非キーなのでエラーになるべき
```

## 4. R3 に必ず含めること

1. **規則**（何が許され何がエラーか）
2. **3 層の責務分担**（§2-1）。**ただし内部関数名を受入条件にしないこと**
3. **identity の作り方**（`PHYSICAL` / `ALIAS_SAFE` / `EXPRESSION`）と、
   **canonical 構造キーの対象ノード・再帰規則の列挙**（§2-4）
4. **`SELECT` 式の中の参照を SELECT alias へ fallback させない**原則
5. **適用単位**（CTE 本体・最終 query・`UNION` 各 arm・サブクエリ・`CREATE TEMP TABLE` source・
   `INSERT`/`UPSERT SELECT` source。**`UPDATE FROM` は対象外**）
6. **検査時点と records API 0 の定義**（§2-3）
7. **`ksql_validate` の二段階契約**（AST-only と schema-aware）
8. **エラー文の要件・骨子・式種別ごとの移行案**（§2-5・§2-6）
9. **受入条件**＝**通り続けるもの / エラーになるもの / adversarial / 回帰**。
   **完全な SQL で書き、公開結果（`SelectResult` / 送出される `ArgumentError` /
   mock client の records API 呼び出し回数）で観測できる形にすること**
10. **Phase の線引き**（Phase 1 に入れないものと、その理由）
11. **未確認事項**（あなたは実行できないので、**Claude が実測すべきことを列挙する**）

## 5. 書き方の制約

- **受入条件に内部実装を要求しない**（過去 3 件、これで実装者を誤らせている）
- **「示した形が実際に動く」ことを受入に含める**（**「従うと壊れる助言」を 3 回出している**）
- **コードで確定できることと、実行しないと分からないことを区別する**
  （前者はファイル:行 を示し、後者は「未確認」と明記する）
- **日本語。既存の仕様書（R2）と同じ体裁**（見出し番号・表・コードブロック）
- **根拠の無い断定を書かない**

上記に従い、**R3 の全文を Markdown で出力**してください。ファイルへの書き込みは不要です。
