# B211 別名の無い関数の列で、中の `CASE` を「case」と略すため、違う式の列が同じ名前になって片方が消える（黙って誤る）

- 状態: 📝 **起票のみ（2026-11-10）**。直すかは Takashi 判断（既定の列名が変わる）
- 種別: 正しさ（**黙って誤る**。列が 1 つ消える・再帰 CTE では 2 列とも同じ値になる）
- 優先: 中（別名を付ければ起きない。ただし再帰 CTE の列名リストで受ける形は別名を書かないのが自然）
- 見つけ方: B210 の発端（在庫の事例の候補。発注ロットを `WITH RECURSIVE` で持ち越す形）を、公開した v3.94.0 で確かめ直したら、まだ「在庫の列に発注数の値が入る」ままだった。切り分けるとこの不具合だった（B210 はその切り分けの途中で見つけた別の不具合）。再現は `work-link/ksql-action-stock-lot-probe.cjs` の `CAST(CASE …)` を 2 列にした形
- 関連: [B210](ksql_b210_case_in_function_numeric_compare_issue.md)

## 1. 現象（v3.94.0 の実測。`x` は NUMBER で 1 と 5 の 2 行）

| # | SQL | 列 | 行 |
|---|---|---|---|
| 1 | `SELECT CAST(CASE WHEN x > 2 THEN 1 ELSE 0 END AS NUMBER), CAST(CASE WHEN x > 2 THEN 10 ELSE 20 END AS NUMBER) FROM APP1` | `CAST(case,'NUMBER')` が 2 つ | **1 列だけ**（20・10。1 列目の 0・1 が消える） |
| 2 | 同じ式に別名 `AS a`・`AS b` | `a`・`b` | 正しい（0・20 / 1・10） |
| 4 | `COALESCE(CASE …, 9)` を 2 列 | `COALESCE(case,9)` が 2 つ | **1 列だけ** |
| 7 | `WITH RECURSIVE r (n, a, b) AS (SELECT 番号, CAST(CASE …), CAST(CASE …) … UNION ALL …)` | `n`・`a`・`b` | **a と b が同じ値**（20・20。正しくは 0・20） |
| 9 | `CREATE TEMP TABLE #t AS SELECT CAST(CASE …), CAST(CASE …) …` | **1 列だけ** | 1 列目が消える |

起きないもの: 列そのものの CASE（`case`・`case_2` と番号が付く）、集計（`SUM(CASE WHEN x > 2 THEN 1 ELSE 0 END)` のように中身まで名前に入る）、中に CASE の無い関数（`CONCAT('a', x)` と `CONCAT('b', x)`）。
同じ式を 2 回（`ROUND(x), ROUND(x)`・`x, x`）も同じ名前になるが、値も同じなので消えても値は失われない（別の論点）。

## 2. 原因

関数の列の既定の名前（`stringFuncDefaultKey` → `scalarValueDefaultKey`。`src/engine/process.ts`）が、引数の CASE を `"case"` と略す。
中身の違う CASE を含む 2 つの列が同じ名前になり、射影の行のオブジェクトで後の列が前の列を上書きする。重なりを検出していない。
再帰 CTE の列名リストは位置で名前を付け替えるが、元の行のキーが 1 つしかないので両方に同じ値が入る。

## 3. 直し方の案

- **案 A（勧める）**: 関数の列の既定の名前で、CASE を集計と同じく**中身まで書く**（`aggregateExpression.ts` の `caseLabel`）。集計の既定名と規則がそろう。**既定の列名が変わる**（`CAST(case,'NUMBER')` → `CAST(CASE WHEN x > 2 THEN 1 ELSE 0 END,'NUMBER')`）
- 案 B: 名前が重なったら番号を付ける（列そのものの CASE と同じ `_2`）。今の名前は 1 列目だけ残る
- 案 C: 中身の違う式が同じ名前になったら止める（fail-closed。「別名を付けてください」）。今まで動いていた形（重なっても値が同じ・1 列しか使わない）も止まり得る
- どの案でも、再帰 CTE の列名リストは**射影の位置**で受け取るよう直すのが本筋（名前の重なりに頼らない）

## 4. 回避策（v3.94.0 まで）

関数の列には**必ず別名を付ける**（再帰 CTE の列名リストで受けるときも、SELECT の中で `AS 在庫` のように付ける）。
