# B182 `COALESCE` / `ISNULL` で包んだ集計値が静かに間違う — 並び順・順位・累計が文字列順になり、算術で包むと 0 になる

- 状態: ✅ **v3.78.0 でリリース（2026-09-16）**。codex が実装・Claude レビュー済み（コミット d1dbec9・[報告](ksql_b182_codex_impl_report.md)）。レビューで回帰 1 件（GROUP BY のみの文の EXPLAIN reason に「集計関数あり」が付く）を修正しテストを追加。実機（SFA）で並び順・RANK・累計・算術値の修正を確認。版数据え置き・リリースは B181・B183 と合わせて判断。実測 v3.77.0（MCP・dev profile・SFA パック）。**エラーも警告も出ない**「静かに間違う」系（B119〜B122 の隣）

## 1. 現象

### 1.1 `COALESCE(SUM(x), 0)` の列で並べ替えると文字列順になる

```sql
WITH 集計 AS (
  SELECT 顧.会社名 AS 会社名, COALESCE(SUM(案.売上), 0) AS 売上合計
  FROM APP4148 AS 顧 LEFT JOIN APP4149 AS 案 ON 案.顧客No_ = 顧.顧客No
  GROUP BY 顧.会社名
)
SELECT 会社名, 売上合計 FROM 集計 ORDER BY 売上合計 DESC LIMIT 3
```

| 結果（実測） | 期待 |
| :--- | :--- |
| 篠村食品 9,050,000 → テクノロジーサービス 7,200,000 → 橘川ケミカル 6,700,000 | サイボウズ商事 20,700,000 → キントーンシステムズ 15,550,000 → 倉本 13,600,000 |

`'9…' > '7…' > '6…' > … > '2…' > '1…'` の**コードポイント順**。`RANK() OVER (ORDER BY 売上合計 DESC)` と `SUM(…) OVER (ORDER BY 売上合計 DESC ROWS …)` も同じ順で評価されるため、ABC 分析（Qiita 実践 #3）の順位・累積構成比・区分がすべてずれる。INNER JOIN でも同じ（LEFT JOIN に依存しない）。

| 書き方 | 並び |
| :--- | :--- |
| `SUM(案.売上)` | 数値順 |
| `COALESCE(SUM(案.売上), 0)` | **文字列順** |
| `ISNULL(SUM(案.売上), 0)` | **文字列順** |
| `CASE WHEN SUM(案.売上) = '' THEN 0 ELSE SUM(案.売上) END` | 数値順 |
| `SUM(COALESCE(案.売上, 0))` | 数値順 |
| `CAST(COALESCE(SUM(案.売上), 0) AS NUMBER)` | 数値順 |

### 1.2 `COALESCE(SUM(x), 0)` を算術で包むと 0 になる

同じ CTE で `COALESCE(SUM(案.売上), 0) + 0`、`COALESCE(SUM(案.売上), 0) * 1`、`ISNULL(SUM(案.売上), 0) * 1` は**全行 0**（実測）。`SUM(案.売上) + 0` は正しい値。JOIN も GROUP BY も無い単一グループでも同じ（`SELECT COALESCE(SUM(売上), 0) + 0 FROM APP4149` → `0`、`SUM(売上) + 0` → `81800000`・実測）。値そのものが壊れるので、1.1 より重い。B122（`HAVING` に集計を式でくるむと 0 行）と同じ根の可能性がある。

`ksql_validate` は ok、`ksql_explain` も ok（型の行は出ない）。実行も成功する。**結果を見て気づく以外に手段が無い**。

## 2. なぜ起きるか（codex 調査で確定・2026-09-16・[報告](ksql_b181_b184_codex_plan_report.md) §3）

- **1.1（文字列順）**: 値の JS 型ではなく列メタデータの問題。`deriveOutputOrderSemantics`（`src/engine/process.ts:2205-2234`）は `STRFUNC_COL` を `NUMERIC_ORDER_FUNCTIONS` に無い関数なら string にする。`COALESCE` / `ISNULL` / `NULLIF` はこの集合に無い。CTE 列メタ（`execute.ts:5550-5565`・`5790-5799`）、HAVING 比較（`execute.ts:3768-3771`）、WHERE/HAVING の関数比較（`evalWhere.ts:185-203`）も同じ規則
- **1.2（算術で 0）**: 関数から始まる算術は `ARITH_COL` に分類される（`parser.ts:1742-1747`）が、`hasAggregateColumns`（`process.ts:431-439`）は `ARITH_COL` 内の集計を見ず、集計実体化（`process.ts:617-678`）にも `ARITH_COL` 分岐が無い。射影時に通常算術として再評価され（`process.ts:1589-1590`）、関数引数の集計値は未実体化で空文字になる（`evalFunc.ts:721-735`）→ `COALESCE('', 0) + 0` = 0。**パーサ分類と集計依存 materialization の非対称**が直接原因
- 実装案（codex 第一案・M）: (1) `ARITH_COL` 内も `collectAggregateRefs()` で走査し、集計を含めば `hasAggregateColumns` の対象にして集計後に `AGG_REF` / `AGG_ARITH` を確定値へ置換してから `evalArithExpr`（`materializeAggregateDependencies()` / `resolveAggInScalarValue()` を一般化）。(2) `COALESCE` / `ISNULL` / `NULLIF` / `GREATEST` / `LEAST` は全引数が数値意味型なら number、混在なら string。`CAST(… AS NUMBER)` と既知数値関数も共通 helper へ（`process.ts` / `execute.ts` / `evalWhere.ts` の数値関数集合の重複を 1 か所に）。回帰対象は b119〜b122 のテスト。B184 の隠し列の型推定もこの helper を使う（B182 先行）

（以下は起票時の推定。上の確定内容で置き換え済み）

- `COALESCE` / `ISNULL` の評価は文字列を返す（`src/engine/evalFunc.ts:412-419`）。列の型は式から推定されず、言語リファレンス §10「型を確定できない式・一時列も既定は文字列」の規則で並ぶ。`CASE` は分岐の型（数値リテラル・集計）を引き継いでいるとみられ、数値順を保つ
- 1.2 は、算術式の中の関数呼び出しが引数の集計を評価しない（あるいは集計前の行で評価する）経路。B119（集計の引数に文字列関数）・B122（HAVING で集計を式でくるむ）の修正が `COALESCE(集計)` を算術で包む形を覆っていない可能性

## 3. 対応案

- **1.2 は不具合として修正**（値が壊れる）。`COALESCE` / `ISNULL` / `NULLIF` の引数に集計がある式を、算術・比較の中でも集計後の値で評価する。B119〜B122 の受入テストに「`COALESCE(SUM(x), 0) + 0`」「`* 100.0 / SUM(x)`」を桁違いの値で追加
- **1.1 は型推定の改善**: `COALESCE` / `ISNULL` / `NULLIF` / `GREATEST` / `LEAST` の結果型を「引数がすべて数値型（NUMBER・数値集計・数値リテラル）なら数値」と推定し、`ORDER BY`・ウィンドウ `ORDER BY`・比較で数値順にする。引数に文字列が混ざる場合は現状どおり文字列
- **文書（併用）**: §5 の `COALESCE` 行と §10 の「型を確定できない式」に「集計値の 0 埋めは `CASE WHEN SUM(x) = '' THEN 0 ELSE SUM(x) END` か `SUM(COALESCE(x, 0))`、または `CAST(… AS NUMBER)`」と注記。レシピ R17（0 埋め）の `CASE` を使う理由として明記

## 4. 受入条件

- 1.1 の SQL が数値順で返り、`RANK` / 累計 / `ORDER BY` が `SUM(案.売上)` と同じ結果になる
- 1.2 の `+ 0` / `* 1` / `* 100.0 / 2` が `SUM(x)` を使った式と同じ値になる（なお `COALESCE(SUM(x), 0) * 100.0 / SUM(x)` は算術式のオペランド制約で ParseError になるので受入には使わない）。境界値は桁を変えて両方向（B119〜B122 の教訓）
- `COALESCE(メモ, '－')` のような文字列用途の挙動と結果列名は変わらない
- 助言をそのまま実行するテストを 1 本（文書の推奨形 3 つがすべて数値順になること）

## 5. 経緯

- 2026-09-16: Qiita「kSQL 実践 #3」の改訂依頼文に対する Claude Desktop の回答（`COALESCE(SUM(案.売上), 0)` で 0 埋めした 3 段 CTE）を実機検証して発見。validate・explain・実行がすべて通り、順位 1 位が 905 万・6 位が 2,070 万という結果で気づいた。切り分けは 1.1 の表。記事側は第 3 回「Claude が書いた SQL を検証する」と第 9 回の誤り表に反映、第 2 回の「`COALESCE(a.件数, 0)` でも同じ結果」に型の注意を追記
- 関連: B119〜B122（v3.44.0・集計まわりで静かに間違う 4 件）、B181（別名の小文字正規化。同じ回答の 1 巡目で発見）
