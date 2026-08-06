# B148 集計されていない列参照を標準 SQL に合わせてエラーにする 仕様（R2）

- ステータス: 📋 **仕様 R2（レビュー前）**
- 起票: [B148](ksql_b148_bare_column_group_by_issue.md)
- 破棄した前版: [R1](ksql_b148_bare_column_group_by_spec.md)（[codex レビュー 1](ksql_b148_codex_review_1.md) で Critical 3 / High 5 / Medium 1）
- 方針決定: **標準 SQL に合わせる**（2026-08-06・オーナー判断）
- 関連: [B147](ksql_b147_aggregate_alias_shadows_key_input_issue.md)（別の欠陥・§10）／
  [B140](ksql_b140_cte_groupby_total_order_issue.md)（候補キー・§9.2）

---

## 0. R1 から変わった点

**R1 は「標準 SQL の規則を新しく入れる」仕様だった。R2 は違う。**

**同じ規則は既に kSQL にある。拡張 grouping の経路にだけ効いている**
（[レビュー §6](ksql_b148_codex_review_1.md) の実測）。

```
GROUP BY ROLLUP(製品名)  →  ArgumentError: B65 non-aggregate field 個数 in SELECT
                            is not a grouping item (reason=B65_NON_GROUPED_DEPENDENCY)
GROUP BY 製品名          →  素通り（先頭行の値が返る）
```

**[B145 の v3.56.1](ksql_b145_describe_subtable_field_issue.md) と鏡像**＝あちらは
**plain `GROUP BY` がエラーで、拡張 grouping が素通り**していた。**同じ形が向きを変えて 2 度目。**

**したがって R2 は「既存検査を ordinary へ広げる」仕様である。**

---

## 1. 既に在るもの / 足りないもの（実測）

**拡張 grouping 経路で、次はすべて効いている。**

| | |
|---|---|
| `SELECT` / `HAVING` / `ORDER BY` の非集計列 | エラー |
| `SELECT *` | 拒否 |
| JOIN の修飾名 | エラー（**`t.個数` と名指しする**） |
| CTE の中 | エラー |
| **キーへの式**（`個数 + 1` に対し `GROUP BY ROLLUP(個数)`） | **許可・値も正しい**（646 → 647） |

**足りないのは 1 点だけ。**

> **grouping item を物理フィールドしか受け付けない。**
> `GROUP BY ROLLUP(年月)` → `B65 field 年月 does not exist in a physical APP source.`

**ordinary `GROUP BY` は別名と式を許す**（言語リファレンス §8 の契約）。
**主用途はまさに別名の形**である。

```sql
SELECT DATE_FORMAT(日付,'%Y-%m') AS 年月, SUM(個数) AS 出庫数
FROM APP4228 GROUP BY 年月
```

---

## 2. 規則

**集計を含むクエリでは、`SELECT` / `HAVING` / `ORDER BY` に現れる列参照は、次のいずれかでなければならない。**

1. **grouping item と同一の実体**を指す
2. **grouping item だけを葉に持つ式**の中にある（`個数 + 1` に対し `GROUP BY 個数`）
3. **集計関数の引数の中**にある

**満たさない参照はエラー。**

### 2.1 「集計を含むクエリ」の判定

**`SELECT` に集計関数があるか、`GROUP BY` があるとき。**

> **R1 は「`SELECT` / `HAVING` のいずれか」と書いたが、`HAVING` は `GROUP BY` を要求する**
> （実測＝`GROUP BY` の無い `HAVING` は `ParseError`。2 形で確認）。
> **後半は冗長なので落とす。** [codex Critical 3](ksql_b148_codex_review_1.md) の
> 「集計開始条件と実行パイプラインを変える」は**不要**。

**`GROUP BY` の無い集計クエリは「全体で 1 グループ」**として同じ規則が効く（grouping item は空）。

### 2.2 ウィンドウ関数は集計ではない

**`SUM(x) OVER (...)` は集計クエリの開始条件にしない**（現行どおり）。

```sql
SELECT SUM(個数) OVER () AS 総計 FROM APP4228   -- 通る。3 行返る（実測）
```

**ここが壊れると素の SELECT を壊す。最重要の回帰。**

**通常集計とウィンドウを併用した場合**、ウィンドウの引数・`PARTITION BY`・
ウィンドウの `ORDER BY` は**集計後の出力に対する参照**として扱う（→ §8-4）。

---

## 3. grouping item の identity（**R2 の新規はここだけ**）

**名前一致で判定しない。**[B147](ksql_b147_aggregate_alias_shadows_key_input_issue.md) と
[R1 の反例](ksql_b148_bare_column_group_by_spec.md)で同じ罠を踏んでいる。

**`plainGroupByPlan` の解決結果を identity の出所にする**（[codex Critical 2](ksql_b148_codex_review_1.md) 推奨案 B）。

| plan の種別 | identity |
|---|---|
| `PHYSICAL` | **`(sourceIndex, fieldCode)`** |
| `ALIAS_SAFE` | `columnIndex` の **SELECT 式を canonicalize** したもの |
| `EXPRESSION` | 対応する `GroupByKey` の**式を canonicalize** したもの |

**`SELECT` 側の列参照は `(sourceIndex, fieldCode)` へ解決してから比較する。**
**JOIN 行は修飾キーと非修飾キーの両方を持つ**ので、名前だけで比べると source identity を失う。

### 3.1 **`SELECT` 式の中の参照を別名へ fallback させない**

**§8 の解決順（同名フィールド優先 → 無ければ SELECT 別名）は `GROUP BY` トークンの規則**であって、
**`SELECT` 式の中のフィールド参照には適用しない。**

**標準 SQL では、`SELECT` 句の別名は同じ `SELECT` 句の他の式からは見えない。**
（**[B147](ksql_b147_aggregate_alias_shadows_key_input_issue.md) はこの原則が破れている欠陥**。§10）

### 3.2 式の canonical 一致（[codex High 1](ksql_b148_codex_review_1.md) 推奨案 C）

**canonical AST の構造一致とする。**

| 比較対象に**含めない** | |
|---|---|
| 空白・キーワードの大小 | parser が既に落とす |
| parser が正規化する関数別名 | `SUBSTR` → `SUBSTRING` 等 |
| 数値リテラルの非意味的表記 | `raw` を見ない |
| 表示用の付随情報 | |

| 比較対象に**する** | |
|---|---|
| フィールド葉 | **文字列ではなく解決済み source identity** |
| 関数名・引数の並び・入れ子の構造 | |

**代数的同値性は認めない**（交換法則・定数畳み込み・`CAST` 省略など）。
**判定できないときは不一致**＝**エラー側へ倒す。**

> **偽陰性（違う式を同じとみなして誤った値を通す）を作らない**ことを優先する。
> 本件は**静かに間違う**のを止めるための仕様であり、**そこを緩めると目的を失う**。

> **「別名経由だけを許し、式の一致は諦める」案は採らない。**
> **言語リファレンス §8 が直接式による grouping を明示的に契約している**ため。

---

## 4. 適用単位（[codex High 2](ksql_b148_codex_review_1.md)）

**AST 内の各 `SelectStatement` に独立して適用する。**

| 含む | |
|---|---|
| `WITH` の CTE 本体 | **CTE 本体が違反しているなら、CTE を取得する前に落とす**（必須） |
| 最終 query | |
| `UNION` の各 arm | |
| スカラー / `IN` / `EXISTS` サブクエリ | **内側は別 `SelectStatement` として独立に検査** |
| `CREATE TEMP TABLE ... AS SELECT` の source | |
| `INSERT ... SELECT` / `UPSERT ... SELECT` の source | |

| 含まない | 理由 |
|---|---|
| **`UPDATE ... FROM`** | **AST に `SelectStatement` を持たず、relation source を直接持つ別構造**。
本 Phase の対象外とし、必要なら別 issue |

> **R1 は「DML の `SELECT` 部（`UPDATE FROM`）」と書いた。不正確だったので書き分けた。**

---

## 5. 拡張 grouping との関係（[codex High 3](ksql_b148_codex_review_1.md) 推奨案 B）

**拡張 grouping の既存契約を崩さない。**

- **grouping item と `GROUPING()` の引数は物理 APP フィールド限定**（現行どおり）
- **`GROUPING()` の引数は「素の非集計参照」ではない。** grouping item membership を
  **別規則で検証する特殊ノード**として現行どおり扱う
- **本仕様は ordinary `GROUP BY` と `GROUP BY` 無し集計を補完する**

**§3 の identity 拡張は ordinary 経路にだけ効かせる**（拡張 grouping は物理限定のまま）。

---

## 6. エラー（**事前照会をしないので、これが唯一の案内**）

### 6.1 満たすこと

| 要件 | なぜ |
|---|---|
| **句・違反式・非集計非キーの列**を示す（[codex High 5](ksql_b148_codex_review_1.md) 推奨案 B） | `SELECT x + y` の違反に `MIN(x)` だけ示すと**式全体を直せない** |
| **「存在しない」と読めないこと** | **その列は存在する**。[v3.56.1](ksql_b145_describe_subtable_field_issue.md) で `unknown field code(s)` が「そんな項目は無い」と読まれ、誤った結論へ誘導した |
| **移行先を 2 つ示す** | 単純列なら `MIN(<列>)`、複合式なら `MIN(<式>)`。**`GROUP BY` 追加案は追加後の完全な句として示す**（意味が変わるので利用者が選ぶ） |
| **`GROUP BY` 無しでは説明を変える** | 「`GROUP BY` に足す」が的外れになる。**「全体が 1 グループになるため」**と書く |
| **示した形が実際に動くこと** | **[B140](ksql_b140_cte_groupby_total_order_issue.md) / [B145](ksql_b145_describe_subtable_field_issue.md) で「従うと壊れる助言」を 3 回出している。**実測してから載せる |
| **内部語を出さない** | 現行は `B65 ... (reason=B65_NON_GROUPED_DEPENDENCY)` / `not supported in Phase1`。
**開発時の Phase ラベルが利用者に漏れている** |

**複数の違反があるときは first error で固定する**（安定した契約にする）。

### 6.2 骨子（**実装時に実測して確定する**）

```
ArgumentError: 個数 は集計もグループ化もされていません（APP4228・SELECT）。
GROUP BY 製品名 のもとでは、グループ内のどの行の値を返すか決まりません。
  グループごとに 1 つに決まる値なら  →  MIN(個数) AS 個数
  行を分けたいなら                  →  GROUP BY 製品名, 個数
```

```
ArgumentError: 個数 は集計もグループ化もされていません（APP4228・SELECT）。
GROUP BY が無いため全体が 1 グループになり、どの行の値を返すか決まりません。
  代表値でよいなら  →  MIN(個数) AS 個数
  行を分けたいなら  →  GROUP BY 個数
```

**「なぜ決まらないか」を書く**のは、[v3.56.2](ksql_b145_describe_subtable_field_issue.md) で
**症状だけ書くと別の入口から来た人に通じない**と学んだため。

### 6.3 **拡張 grouping 側の文面も同時に揃える**

**同じ違反に別々の文面を出さない。** 現行の `B65 ...` を §6.1 の要件へ改める。
**これは本件の副産物だが、揃えないと「経路ごとに文面が違う」を新しく作ることになる。**

---

## 7. 位置と surface

- **レコード API を呼ぶ前にエラー**（言語リファレンス §8 の「レコード取得前にエラーになります」の一覧へ並べる）
- **CTE 本体が違反しているなら、その CTE を取得する前に落ちる**（§4）
- **`ksql_explain` でも同じ診断**（依頼元は実行前に `ksql_explain` まで通す運用。→ [B143](ksql_b143_explain_warnings_issue.md)）
- **プラグイン**（[codex Medium 1](ksql_b148_codex_review_1.md) 推奨案 B）＝
  `prod/js/desktop.js` は engine を bundle するので**波及する**。
  **プラグインの EXPLAIN と通常実行でも同じ診断が出て、レコード API 呼び出し前に停止すること**

### 7.1 `ksql_validate` は二段階契約（[codex Critical 1](ksql_b148_codex_review_1.md) 推奨案 B）

**`ksql_validate` は kintone API を呼ばない**（公開契約）。
**物理フィールドと SELECT 別名の競合は、フォーム定義なしには判定できない。**

```sql
SELECT DATE_FORMAT(x,'%Y') AS a, SUM(v) FROM APP1 GROUP BY a
-- APP1 に物理 a があれば GROUP BY は物理 a、無ければ SELECT 別名
```

**契約文**

> `ksql_validate` は **AST だけで確定できる違反**を検出する。
> **物理フィールドと SELECT 別名の競合、JOIN の曖昧性、CTE・一時テーブルの出力 schema など
> metadata を要する判定は確定しない。**
> `ksql_explain` と実行は schema-aware に判定し、**レコード API 呼び出し前に同じ reason code の
> `ArgumentError` を返す。**

**「同じエラー」は全文一致ではなく「同じ種別・同じ reason code・同じ違反箇所」と定義する。**

---

## 8. 受入条件（**公開結果で観測する**）

**判定は内部述語ではなく、`SelectResult` / 送出される `ArgumentError` で観測する。**
**「レコード取得前」は mock client の records API 呼び出し回数 `0` で観測する。**

### 8.1 通り続けるもの（**回帰。ここが壊れたら出さない**）

```sql
SELECT 製品名, SUM(個数) AS 合計 FROM APP4228 GROUP BY 製品名
SELECT DATE_FORMAT(日付,'%Y-%m') AS 年月, SUM(個数) AS 出庫数 FROM APP4228 GROUP BY 年月   -- 主用途
SELECT DATE_FORMAT(日付,'%Y-%m'), SUM(個数) FROM APP4228 GROUP BY DATE_FORMAT(日付,'%Y-%m')
SELECT 個数 + 1 AS 加算, SUM(個数) AS 合計 FROM APP4228 GROUP BY 個数                      -- キーへの式
SELECT SUM(個数) FROM APP4228                                                              -- 集計だけ
SELECT 製品名, 個数 FROM APP4228                                                           -- 集計もグループ化も無い
SELECT SUM(個数) OVER () AS 総計 FROM APP4228                                              -- ウィンドウだけ
SELECT 製品名, SUM(個数) FROM APP4228 GROUP BY ROLLUP(製品名)                              -- 拡張 grouping
SELECT DATE_FORMAT(日付,'%Y-%m') AS 年月, SUM(個数) FROM APP4228 GROUP BY ROLLUP(日付)     -- キーの式（値も正しい）
```

**レシピ R13 / R15 / R16 / R17 の掲載 SQL が通ること**（該当なしを測って確認済み）。

### 8.2 エラーになるもの

```sql
SELECT 製品名, 個数, SUM(個数) FROM APP4228 GROUP BY 製品名                 -- §0.1
SELECT 製品名, 個数, SUM(個数) FROM APP4228                                 -- GROUP BY 無し
SELECT 製品名, SUM(個数) FROM APP4228 GROUP BY 製品名 HAVING 個数 > 0       -- HAVING
SELECT 製品名, SUM(個数) FROM APP4228 GROUP BY 製品名 ORDER BY 個数         -- ORDER BY
SELECT *, SUM(個数) FROM APP4228 GROUP BY 製品名                            -- wildcard
SELECT DATE_FORMAT(x,'%m'), SUM(v) FROM APP1 GROUP BY DATE_FORMAT(x,'%Y')   -- 式が違う
```

### 8.3 adversarial（**偽陰性を止める**・[codex High 5](ksql_b148_codex_review_1.md)）

| 入力の性質 | 期待 |
|---|---|
| **物理フィールド `年月` がある状態**で `SELECT DATE_FORMAT(日付,…) AS 年月 … GROUP BY 年月` | **`GROUP BY` は物理 `年月`。`DATE_FORMAT` の `日付` が非キーなのでエラー**（[R1 の反例①](ksql_b148_bare_column_group_by_spec.md)） |
| `GROUP BY l.a` に対する `SELECT r.a` | エラー |
| JOIN で両表に `a` があり `GROUP BY l.a` に対し非修飾 `SELECT a` | 曖昧参照エラー |
| `SELECT _p.*` | エラー |
| **集計の中の `CASE WHEN b …`** | **通る**（`b` は集計関数の内部） |
| **外側集計＋スカラーサブクエリ** | サブクエリ内部は**別 `SelectStatement` として検査** |
| `UNION` の各 arm | 独立に検査 |
| `INSERT` / `UPSERT ... SELECT` の source | 同じエラー |
| **CTE 本体が違反** | **CTE を取得する前に落ちる**（records API 0 回） |
| 複数の違反列 | **first error で固定** |

### 8.4 未確定として明記するもの

**通常集計とウィンドウの併用で、ウィンドウの引数 / `PARTITION BY` / ウィンドウの `ORDER BY` が
「集計前の列」か「集計後の出力」か。** **R2 のレビューで確定させる。**

### 8.5 値・並び

**通るクエリの値・行順・`columns` は一切変えない。**

---

## 9. 範囲外（Phase 2 以降）

### 9.1 `$id` / `レコード番号` での `GROUP BY`

**標準 SQL は一意キーへの関数従属を認める**ので、`GROUP BY レコード番号` なら他の列を許してよい。
**Phase 1 では許さない**（`MIN()` で書ける）。

**後から許す側へ広げるのは非破壊**＝**従来エラーだった入力を成功させるだけ**で、
**既存の成功クエリの値は変わらない。**

> **現実的な用途はある**（レコード単位の重複除去、JOIN 後の 1 レコード化、集計列の付加）。
> **実利用の頻度は未測。**

### 9.2 [B140](ksql_b140_cte_groupby_total_order_issue.md) との合流

**§9.1 の関数従属は、B140 の「候補キー」と同じ概念。**
**B140 が relation レベルの候補キーを持てば、本件の Phase 2 はそれを使える。**
**Phase 1 で「候補キーを持たない」形に閉じておけば、B140 の道を塞がない。**

### 9.3 `UPDATE ... FROM`

§4 のとおり別構造。**必要なら別 issue。**

---

## 10. [B147](ksql_b147_aggregate_alias_shadows_key_input_issue.md) との関係

**B147 は本仕様では直らない。** B147 の `DATE_FORMAT(日付,…) AS 年月` は
**`GROUP BY 年月` のキーそのもの**なので、§2 の規則を満たしてしまう。

**ただし §3.1 の原則が B147 の直し方でもある**＝
**標準 SQL では、`SELECT` 句の別名は同じ `SELECT` 句の他の式からは見えない。**
**B147 の仕様はこの原則から書き始める。**

---

## 11. 破壊的変更

**`SELECT *` の列数を変えた [v3.56.0](ksql_b145_describe_subtable_field_issue.md)、
拡張 grouping をエラーにした v3.56.1 と同じ扱い。リリースノートに移行案内を明記する。**

- **依頼元（`ksql-analytics`）の資産は該当なし**（オーナーが把握）
- **掲載 SQL（レシピ・言語リファレンス）は該当なし**（測って確認）
- **既存テスト 233 suites は実装すれば落ちて分かる**
- **保存クエリ・プラグイン利用者は測る手立てが無い**。**エラー文が唯一の案内**（§6）

## 12. 未確定（レビューで決める）

1. **§8.4**（ウィンドウの引数・`PARTITION BY` の扱い）
2. **式表記ゆれの既存利用量**（`1` と `1.0`、修飾／非修飾、関数別名）。
   **canonicalization の互換影響を決める材料**。**未測**
3. **エラー文の移行例が全 surface で実際に通ること**
   （`GROUP BY` あり／なし・JOIN・CTE・一時テーブル・サブテーブル）。**実測が要る**
4. **プラグイン bundle 更新後の表示と API 呼び出し順**。**実測が要る**
