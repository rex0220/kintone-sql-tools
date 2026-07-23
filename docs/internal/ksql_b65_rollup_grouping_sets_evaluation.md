# B65 — 小計・総計（`ROLLUP` / `GROUPING SETS` / `GROUPING()`）対応（評価）

- ステータス: 📝 **【A: 評価・方向判断】起票（2026-07-23）**。1 クエリ・1 結果セットで小計/総計行を出すための `GROUP BY ROLLUP` / `GROUP BY GROUPING SETS` と、集計行を判別する `GROUPING()` 関数の対応案。仕様前・実需/スコープの確認待ち。
- 種別: 機能（集計・GROUP BY 拡張）
- 優先: 中
- 関連: [B64 集計引数のスカラー値式（条件付き集計）](ksql_b64_aggregate_case_expression_issue.md) / [B56 統計集約](ksql_b56_statistical_aggregates_spec.md) / [B59 ORDER BY alias/合成名](ksql_b59_orderby_alias_fix_spec.md) / [B40 グラフ（有界 fail-closed 思想）](ksql_property_graph_evaluation.md) / 言語 §8 集計・§10 ORDER BY

## 1. 背景・課題

kSQL の `GROUP BY` は単一レベルの集計のみで、**小計（subtotal）・総計（grand total）行を同じ結果に含められない**。会社別の明細に「全体合計」を 1 行足す、地域×会社で階層小計を出す、といったレポート/ダッシュボードの定番が 1 クエリで書けない。

標準 SQL には次がある。

- `GROUP BY ROLLUP(a, b)` … `(a,b)` の明細に加え `(a)` 小計・`()` 総計を積む階層集計。
- `GROUP BY GROUPING SETS ((a,b),(a),())` … 出したいグループ化の集合を明示。
- `GROUP BY CUBE(a, b)` … 全部分集合（2^n 通り）。
- `GROUPING(col)` … その行で `col` が集約されているか（super-aggregate 行か）を `1/0` で返す。合計行のラベル付けやソートに使う。

現状の回避策は「明細クエリ＋総計クエリを `UNION ALL`」または「クライアント側で合算」。前者は総計行の grouped 列を定数リテラルで埋める・列を揃えるなど冗長で、階層が増えると破綻する。

## 2. 実測境界（現状・`ksql_validate`）

いずれも未対応で `ParseError`（`ROLLUP`/`GROUPING`/`GROUPING SETS` は通常識別子として解釈される）。

```sql
-- ❌ GROUP BY ROLLUP(会社名) → 「文の区切りには ; が必要です（トークン: 「(」）」
SELECT 会社名, SUM(売上) FROM APP4149 GROUP BY ROLLUP(会社名)

-- ❌ GROUP BY GROUPING SETS (...) → 「文の区切りには ; が必要です（トークン: 「SETS」）」
SELECT 会社名, SUM(売上) FROM APP4149 GROUP BY GROUPING SETS ((会社名), ())

-- ❌ GROUPING(会社名) → 「比較演算子（…）が必要です（トークン: 「(」）」
SELECT CASE WHEN GROUPING(会社名) = 1 THEN '合計' ELSE 会社名 END, SUM(売上)
FROM APP4149 GROUP BY 会社名
```

現在できるのは B64 の条件付き集計までで、**明細行の中で列を横に割る**（受注済/見込を列で分ける）ことは可能。だが**行方向の小計/総計は出せない**。

```sql
-- ✅ 現状可能（B64・明細のみ・総計行は無い）
SELECT 会社名,
  COUNT(*) AS 案件数,
  SUM(売上) AS 売上合計,
  SUM(CASE WHEN 商談フェーズ = '受注' THEN 売上 ELSE 0 END) AS 受注済売上,
  SUM(CASE WHEN 商談フェーズ IN ('提案中','内示') THEN 売上 ELSE 0 END) AS 見込売上,
  SUM(CASE WHEN 商談フェーズ = '受注' THEN 1 ELSE 0 END) AS 受注件数
FROM APP4149
GROUP BY 会社名
ORDER BY 売上合計 DESC
```

## 3. 固有価値（欲しい形）

会社別の明細に **総計行を 1 行足して同じ結果に**（`GROUPING()` で合計行を判別・末尾へ）。B64 の条件付き集計とそのまま組み合わせられる。

```sql
-- ROLLUP + GROUPING（総計行つき）
SELECT
  CASE WHEN GROUPING(会社名) = 1 THEN '合計' ELSE 会社名 END AS 会社名,
  COUNT(*) AS 案件数,
  SUM(売上) AS 売上合計,
  SUM(CASE WHEN 商談フェーズ = '受注' THEN 売上 ELSE 0 END) AS 受注済売上,
  SUM(CASE WHEN 商談フェーズ IN ('提案中','内示') THEN 売上 ELSE 0 END) AS 見込売上,
  SUM(CASE WHEN 商談フェーズ = '受注' THEN 1 ELSE 0 END) AS 受注件数
FROM APP4149
GROUP BY ROLLUP(会社名)
ORDER BY GROUPING(会社名), 売上合計 DESC
```

`GROUPING SETS` なら出したい集合を明示できる（会社別だけ／総計だけ／両方）。多列にすれば地域小計＋会社明細＋総計のような階層レポートになる。

## 4. 設計案（たたき台）

### 4.1 実行モデル

kintone にサーバ側の ROLLUP は無いため、既存 `GROUP BY` と同じ **クライアント側 FULL_SCAN**。全行を 1 度取得し、**複数のグループ化セットを内部で評価して縦に結合**する。

- **`GROUPING SETS` を土台**にする。`ROLLUP(a,b)` = `GROUPING SETS((a,b),(a),())`、`CUBE(a,b)` = 全部分集合、として糖衣展開する。まず GROUPING SETS の実行を作り、ROLLUP/CUBE をその上に載せると素直。
- 各グループ化セットごとに既存の集計（B56 統計含む）・B64 条件付き集計を評価し、結果行に **どの列が集約されたか（grouping bitmask）** を付与して連結する。

### 4.2 `GROUPING(col)`

- その行のグループ化セットで `col` が**集約されている**（＝super-aggregate 行）なら `1`、グループキーとして残っていれば `0` を返すスカラー関数。
- 集計コンテキスト専用（`GROUP BY` を伴う文でのみ有効）。**SELECT 列・`ORDER BY`・`HAVING`** で使える。B64 で拡張したスカラー式評価（`CASE` 条件・`SELECT` 式）から参照できる必要がある。
- 予約語追加（`GROUPING`）。`ROLLUP`/`CUBE`/`GROUPING SETS`（複合キーワード `GROUPING SETS`）も文法トークン化。

### 4.3 super-aggregate 行の grouped 列の表現

- 標準 SQL では super-aggregate 行の grouped 列は `NULL`。kSQL は空セル＝空文字なので、**「実データの空セル」と「総計行の全体」を値だけでは区別できない**。ここが `GROUPING()` の存在意義：総計行では grouped 列を空文字にしつつ、`GROUPING(col)=1` で判別する。ラベルは `CASE WHEN GROUPING(col)=1 THEN '合計' ELSE col END` で付ける。
- 出力列の型メタは各セット共通（縦結合するため）。

### 4.4 ORDER BY / HAVING との整合

- `ORDER BY GROUPING(会社名), 売上合計 DESC` のように、**合計行を末尾へ寄せる**用途が定番。B59 で整えた ORDER BY の alias/合成名/値解決 planner に `GROUPING()` と grouping bitmask を供給する経路が要る。
- `HAVING` で `GROUPING()` や集計を参照する形も検討（Phase を分けてよい）。

### 4.5 爆発の抑制（有界 fail-closed）

- `GROUPING SETS` は明示個数、`ROLLUP(n 列)` は `n+1` セットで有界。**`CUBE(n 列)` は `2^n`** でセット数が急増するため、B40 と同思想で**セット数・出力行数の上限を設けて超過は fail-closed**。CUBE は Phase を分けるか、当面見送りも選択肢。

## 5. 論点

- **スコープ**: Phase1 を `GROUPING SETS` ＋ `ROLLUP`（単一列）＋ `GROUPING()` に絞るか、複数列 ROLLUP まで含めるか。`CUBE` は爆発リスクで別 Phase or 見送り。
- **`GROUPING()` の実装統合**: パーサ（予約語・複合キーワード）、集計エンジン（grouping bitmask の付与）、スカラー式評価（`CASE`/SELECT/ORDER BY/HAVING からの参照）の横断対応。実装規模は中〜大（集計エンジンが単一セット前提のため、複数セット評価と縦結合、フラグ付与への拡張が核）。
- **super-aggregate 行の表現**: grouped 列を空文字＋`GROUPING()=1` で区別する契約でよいか（実データの空セルとの取り違えを `GROUPING()` 前提で運用）。
- **ORDER BY GROUPING()**: B59 planner との整合、REST 押し下げ不可（FULL_SCAN 固定）で問題ないか。
- **完全入力（B56）との相互作用**: 統計集約を含む場合、各グループ化セットで完全入力必須が波及する。
- **実需**: 小計/総計付きレポートの需要規模（ダッシュボード/Excel 出力の下地）。

## 6. 段階案

- **Phase1**: `GROUP BY GROUPING SETS (...)` ＋ `GROUP BY ROLLUP(単一列)` ＋ `GROUPING(col)`（SELECT / ORDER BY）。総計行の grouped 列は空文字＋`GROUPING()=1`。B64 条件付き集計と併用可。
- **Phase2**: 複数列 `ROLLUP`、`HAVING` での `GROUPING()`、`CUBE`（有界 fail-closed）。

## 7. 次アクション

1. 実需の確認（小計/総計付きレポートをどれだけ求めるか。ダッシュボード/Excel 出力との組み合わせ）。
2. スコープ確定（Phase1 の範囲・CUBE の是非・super-aggregate 表現の契約）。
3. 方向が定まれば Phase1 仕様 R1 →（既存フロー）codex レビュー → R2 → 実装。
