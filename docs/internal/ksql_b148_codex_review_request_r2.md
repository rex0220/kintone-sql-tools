# B148 仕様 R2 codex レビュー依頼

**レビュー依頼であり実装依頼ではない。コードは 1 行も変更しないこと。**
git 操作をしないこと（`git status` も含む）。kSQL MCP を叩かないこと。`npm test` は不要。
**自分の MEMORY.md は読まないこと**（このファイルと参照先だけで完結させる）。

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（v3.56.3）

## 0. 依頼

**仕様 R2 のレビュー。問題があれば、指摘だけでなく対応案も出してほしい。**

| ファイル | 役割 |
|---|---|
| `docs/internal/ksql_b148_bare_column_group_by_spec_r2.md` | **レビュー対象の R2** |
| `docs/internal/ksql_b148_codex_review_1.md` | **R1 のレビュー結果とその実測検証**（あなたの前回の指摘＋こちらの実機確認） |
| `docs/internal/ksql_b148_bare_column_group_by_issue.md` | 起票（実測あり） |
| `docs/internal/ksql_b148_bare_column_group_by_spec.md` | 破棄した R1（経緯としてのみ） |
| `src/core/groupingValidation.ts` | **既存検査（B65）。R2 はこれを広げる** |
| `src/core/optimization/plainGroupByPlan.ts` | plain GROUP BY の解決 plan |
| `src/core/grouping.ts` / `src/engine/process.ts` / `src/execute.ts` / `src/types/ast.ts` | 実行経路 |
| `docs/ksql_language_reference.md` §8 | GROUP BY の契約 |

## 1. R1 から変わった点（前提）

**R1 のレビューを受けて、位置づけが変わった。**

**実測で判明した最重要事項**＝**同じ規則は既に `groupingValidation.ts` にあり、
拡張 grouping の経路にだけ効いている。** 拡張 grouping では
`SELECT`／`HAVING`／`ORDER BY` の非集計列・`SELECT *`・JOIN の修飾名・CTE の中が
すべてエラーになり、キーへの式（`個数 + 1`）は許可されて値も正しい。
**ordinary `GROUP BY` はそのすべてが素通りする。**

**足りないのは 1 点＝grouping item を物理フィールドしか受け付けない。**
**R2 の新規はそこだけ**（別名と式の grouping item へ identity を広げる）。

**あなたの前回指摘のうち Critical 3（`HAVING` にだけ集計がある形）は実測で前提が崩れた**
（`GROUP BY` の無い `HAVING` は 2 形とも `ParseError`）。**R2 では採用していない。**

## 2. 特に見てほしい点

### 2.1 【最優先】既存検査を広げる方針そのものが成立するか

- **`groupingValidation.ts` の現行実装は、物理フィールド前提がどこまで染み込んでいるか。**
  **別名・式の grouping item を足すのは「identity の差し替え」で済むか、
  それとも構造の作り直しになるか**
- **ordinary `GROUP BY` の経路から、この検査を呼べる位置はあるか。**
  **レコード API 呼び出し前**という要件を満たせるか
- **`GROUP BY` 無しの集計クエリ**（grouping item が空）で、既存検査は動くか

### 2.2 identity の対応づけ（R2 §3）

- `PHYSICAL` / `ALIAS_SAFE` / `EXPRESSION` から identity を作る案は、実装可能か
- **`SELECT` 側の列参照を `(sourceIndex, fieldCode)` へ解決する経路は実在するか**
- **`SELECT` 式の中の参照を別名へ fallback させない**（R2 §3.1）は、現行実装と整合するか

### 2.3 式の canonical 一致（R2 §3.2）

- **保守的な構造キー**で、**主用途と R2 §8.1 の全例が通るか**
- **判定できないときエラー側へ倒す**方針で、**落ちてしまう既存の正当なクエリ**はないか

### 2.4 適用単位（R2 §4）

- **CTE 本体の違反を「取得前」に落とせるか**（CTE は順に実体化される）
- `UNION` 各 arm・サブクエリ・`INSERT/UPSERT SELECT`・`CREATE TEMP TABLE` source で
  呼べる位置はあるか
- **`UPDATE FROM` を対象外とする**判断は妥当か

### 2.5 拡張 grouping を壊さないか（R2 §5）

- **identity 拡張を ordinary 経路にだけ効かせる**という分離は、実装上きれいに書けるか
- **エラー文を揃える**（R2 §6.3）ときに、拡張 grouping 側の既存テストがどう影響するか

### 2.6 R2 §8.4（**未確定として残した点**）

**通常集計とウィンドウを併用したとき、ウィンドウの引数・`PARTITION BY`・
ウィンドウの `ORDER BY` は「集計前の列」か「集計後の出力」か。**
**現行実装ではどうなっているか。R2 はどう書くべきか。**

### 2.7 受入条件

- **R2 §8.1（通り続けるもの）に抜けは無いか**
- **R2 §8.3（adversarial）で偽陰性を止められるか**
- **受入が内部実装を要求していないか**（公開結果で観測できているか）

## 3. 出力の形

**Markdown で、以下の順に。**

1. **結論**（実装着手可否・重大度別の件数）
2. **指摘**（重大度順。**ファイル:行 を根拠に**。各指摘に**対応案**を必ず付け、推奨を 1 つ選ぶ）
3. **仕様が正しかった点**（R3 で消さないもの）
4. **決めるために測るべきこと**

**根拠の無い断定は書かないこと。**
**コードを読んで分かることと、実行しないと分からないことを区別すること**
（前者はファイル:行 を示し、後者は「未確認」と明記する）。

上記の依頼に従い、レビュー結果と対応案を Markdown で出力してください。ファイルへの書き込みは不要です。
