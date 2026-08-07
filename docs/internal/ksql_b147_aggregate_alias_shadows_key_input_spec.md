# B147 集計の別名がキー式の入力フィールドを上書きする問題 仕様（R1）

- ステータス: ✅ **実装済み（v3.58.0）**（2026-08-07）。**Claude レビュー指摘 0 件**（§13）
- 対象: **kSQL v3.57.0**
- 起票: [B147](ksql_b147_aggregate_alias_shadows_key_input_issue.md)
- 関連: [B148 R3](ksql_b148_bare_column_group_by_spec_r3.md)
- 種別: 不具合修正（静かな誤結果）
- 方針: **SELECT の出力値と入力フィールドを別の名前空間で保持する**
- 互換性: **結果値が変わる破壊的変更。ただし新たなエラーは導入しない**
- 実装案: 起票 §5 の **案 C**
- 対象面: engine library / CLI / MCP / plugin の共通 SELECT 実行経路

---

## 0. R1 の位置づけ

v3.57.0 では、集計結果をグループ行へ SELECT alias 名で書き込んだ後、同じ行を使って他の SELECT 式を評価している。

そのため、集計 alias が入力フィールド名と一致すると、同じ SELECT 句の別の式が参照する入力フィールドが集計値に置き換わる。

```sql
SELECT DATE_FORMAT(日付, '%Y-%m') AS 年月,
       SUM(個数) AS 日付
FROM APP4228
GROUP BY 年月
```

`DATE_FORMAT` が参照すべきものは入力列 `日付` である。しかし現行実装では、最終投影時に `SUM(個数) AS 日付` の集計結果を参照してしまい、`年月` が空になる。

症状は日付関数だけではない。

- 算術式では、キー値ではなく集計値を使った数値になる
- 文字列連結では、元の文字列ではなく集計値が連結される
- `CASE` では、分類結果が反転することがある
- 1件だけのグループではキー値と集計値が偶然一致し、不具合が見えない

本仕様は次の原則を実行時にも成立させる。

> **SELECT 句の別名は、同じ SELECT 句の他の式からは見えない。**

B148 R3 が依存検査で採用した規則と同じである。B147 では、その規則を実行時の値解決へ適用する。

---

## 1. 根拠と確定範囲

### 1.1 コードから静的に確定していること

| 事実 | 根拠 |
|---|---|
| ordinary `GROUP BY` は入力グループの先頭行をコピーして出力行の土台にする | `src/engine/process.ts:293-297` |
| 式による grouping key を同じ出力行へ書き込んだ後、集計列を実体化する | `src/engine/process.ts:299-308` |
| 通常集計は、集計結果を `alias` または合成名をキーとして出力行へ直接書き込む | `src/engine/process.ts:410-426` |
| 集計を含む文字列関数、scalar value、`CASE` も同じ出力行へ結果を実体化する | `src/engine/process.ts:427-449` |
| 非集計の算術、`CASE`、文字列関数、scalar value は最終投影時に行から再評価される | `src/engine/process.ts:1226-1302` |
| 最終 projection は各 SELECT 列を列順に評価して公開行を構築する | `src/engine/process.ts:1378-1446` |
| FULL_SCAN の順序は、集計、`HAVING`、ウィンドウ、`DISTINCT`、`ORDER BY`、`LIMIT/OFFSET`、最終 projection である | `src/engine/process.ts:1952-2030` |
| `HAVING` は集計後の行に対して評価される | `src/engine/process.ts:768-776,1981-1985` |
| 通常 `ORDER BY` は SELECT alias 用 evaluator を持ち、alias を優先して評価できる | `src/engine/process.ts:964-1036,2008-2016` |
| ウィンドウ関数も結果を `window.alias` 名で処理行へ直接書き込む | `src/engine/process.ts:1043-1094,1104-1109,1163-1166` |
| B148 の依存検査は、SELECT 内部の参照では同じ SELECT の alias へ fallback せず、`HAVING` / `ORDER BY` だけ句固有の alias 解決を行う | `src/core/aggregateDependencyValidation.ts:249-268,285-319` |
| plain `GROUP BY` の token は、物理フィールドを優先し、存在しない場合だけ SELECT alias へ fallback する | `src/core/optimization/plainGroupByPlan.ts:217-269` |
| SELECT 句はフィールド、算術、`CASE`、文字列関数、scalar value、集計、ウィンドウ、scalar subquery 等を別の AST 種別として保持する | `src/types/ast.ts:224-239` |
| ordinary `GROUP BY` が直接保持するキーはフィールド、算術式、関数式である | `src/types/ast.ts:731-735` |
| 公開 SELECT 結果は `rows`、`columns`、`rowCount`、任意の `warnings` 等で構成される | `src/execute.ts:380-400` |
| FULL_SCAN の公開結果は共通の `runFullScan()` を通って構築される | `src/execute.ts:5060-5085` |
| `UPDATE SET` の scalar subquery は通常の SELECT 実行経路で先に実行され、その公開結果の先頭列を SET 値へ変換する | `src/execute.ts:9796-9816` |
| 言語リファレンスは、`GROUP BY` は物理フィールド優先、通常 `ORDER BY` は SELECT alias 優先と定めている | `docs/ksql_language_reference.md:1420-1437` |
| 言語リファレンスは、ウィンドウ内の `OVER (ORDER BY ...)` から同じ SELECT の alias を参照できないと定めている | `docs/ksql_language_reference.md:1771-1789` |

以上から、起票 §2 の原因の見立ては正しい。

ただし、原因を「キー式の再評価」だけに限定してはならない。より正確には次のとおりである。

> **入力フィールド、grouping key、集計結果、ウィンドウ結果、SELECT alias を同じ文字列キーの処理行へ格納しているため、後から実体化した SELECT 出力が入力値を上書きする。**

### 1.2 実測で確定していること

v3.57.0・APP4228 の実測結果は起票 §8 を正とし、再導出しない。

| 式 | 衝突時 | 非衝突時 |
|---|---|---|
| `DATE_FORMAT(日付,'%Y-%m')` | 空 | `2025-08` |
| `個数 * 2` | `2584` | `1292` |
| `製品名 \|\| '-x'` | `23429-x` | `食パン-x` |
| `CASE WHEN 個数 > 100 …` | `大` | `小` |

また、次も確定済みである。

- 集計値そのものは正しい
- エラーも警告も出ない
- 集約後に別の SELECT 列だけが壊れる
- 1件のグループではキー値と集計値が偶然一致する
- 通常 `ORDER BY` の alias 優先は契約どおりであり、本件の誤動作ではない
- CTE の下流では、CTE の出力列が下流 query block の入力列になるため正しい

### 1.3 未確認のもの

次は静的に衝突可能な経路または関連経路を確認できるが、v3.57.0 の公開結果は未実測である。

- `HAVING` で物理フィールド名と集計 alias が一致する場合
- ウィンドウ関数の alias が同じ SELECT の別式の入力フィールド名と一致する場合
- `UPDATE SET` の scalar subquery 内で本件を踏む形
- `DISTINCT` と衝突を併用した場合
- JOIN の修飾・非修飾参照を含む場合
- `ROLLUP` / `CUBE` / `GROUPING SETS` の既存 alias collision 契約

これらは §12 の実測対象とする。

---

## 2. 規則

### 2.1 SELECT 内部の名前解決

SELECT 式の内部に現れるフィールド参照は、その query block の入力 relation の列を指す。

同じ SELECT 句の次の出力名を参照してはならない。

- 通常集計の alias
- 集計算術式の alias
- 集計を含む文字列関数、scalar value、`CASE` の alias
- ウィンドウ関数の alias
- 同じ SELECT 句にある他の非集計式の alias

SELECT 列の記述順による左から右への可視性も設けない。

```sql
SELECT 個数 * 2 AS 倍,
       SUM(個数) AS 個数
FROM APP147A
GROUP BY 個数
```

`個数 * 2` の `個数` は入力列である。`SUM(個数) AS 個数` の出力 alias ではない。

列順を逆にしても意味は変わらない。

```sql
SELECT SUM(個数) AS 個数,
       個数 * 2 AS 倍
FROM APP147A
GROUP BY 個数
```

### 2.2 集計 alias と入力フィールドの同名を許可する

次の自然な SQL は引き続き許可する。

```sql
SELECT 商品,
       SUM(数量) AS 数量
FROM APP100
GROUP BY 商品
```

集計 alias が入力フィールド名と一致すること自体はエラーにしない。

同じ SELECT の別式が `数量` を参照していなければ、公開結果も従来から変わらない。

### 2.3 `GROUP BY` の名前解決は変えない

plain `GROUP BY <名前>` は次の既存順序を維持する。

1. 同名の入力フィールド
2. 入力フィールドが存在しない場合だけ、GROUP BY 前に評価可能な SELECT alias

```sql
SELECT DATE_FORMAT(日付, '%Y-%m') AS 年月,
       SUM(個数) AS 合計
FROM APP147A
GROUP BY 年月
```

APP147A に物理フィールド `年月` がなければ、`GROUP BY 年月` は SELECT alias の式へ解決する。

APP147A に物理フィールド `年月` があれば、その物理フィールドを優先する。

この規則は `GROUP BY` token 専用であり、同じ SELECT 句の他の式へ拡張しない。

### 2.4 `HAVING` の alias 解決は変えない

`HAVING` は SELECT 句とは異なる句であり、既存の alias 参照を維持する。

```sql
SELECT 製品名,
       SUM(個数) AS 個数
FROM APP147A
GROUP BY 製品名
HAVING 個数 >= 700
```

この `HAVING 個数` は、既存契約どおり集計 alias を参照する。入力行の物理 `個数` へ戻してはならない。

一方、SELECT 式内の `個数` は入力列を参照する。

実装は句ごとの名前空間を区別しなければならない。

### 2.5 `ORDER BY` の alias 解決は変えない

トップレベルの通常 `ORDER BY` は、言語リファレンス §8 の既存契約どおり SELECT alias を優先する。

```sql
SELECT 製品名 AS 商品,
       SUM(個数) AS 個数
FROM APP147A
GROUP BY 製品名
ORDER BY 個数 DESC
```

`ORDER BY 個数` は集計結果で並べる。

本修正によって物理 `個数` による並びへ変えてはならない。

`KORDER BY`、ウィンドウ内の `OVER (ORDER BY ...)`、plain `GROUP BY` の既存名前解決は変更しない。

### 2.6 ウィンドウ関数

同じ SELECT 句の他の式から、ウィンドウ関数の alias は見えない。

```sql
SELECT 個数 * 2 AS 倍,
       ROW_NUMBER() OVER (ORDER BY $id) AS 個数
FROM APP147A
```

`個数 * 2` は入力列 `個数` を参照する。

ウィンドウ関数の結果は公開出力 `個数` になるが、同じ SELECT の式評価用入力を上書きしてはならない。

また、`PARTITION BY` および `OVER (ORDER BY ...)` は同じ SELECT の出力 alias を参照しないという既存契約を維持する。

通常集計とウィンドウ関数を同じ SELECT へ置けない既存構文制約は変更しない。

### 2.7 CTE・一時テーブル・サブクエリ境界

規則は query block ごとに適用する。

CTE、サブクエリ、一時テーブルが実体化された後、その公開出力列は下流 query block の正規の入力列になる。

```sql
WITH m AS (
  SELECT 製品名,
         SUM(個数) AS 個数
  FROM APP147A
  GROUP BY 製品名
)
SELECT 個数 * 2 AS 倍
FROM m
```

下流の `個数` は CTE `m` の入力列であり、集計済みの値を参照する。これは同じ SELECT 句の alias 参照ではない。

したがって、CTE 下流で `2 × SUM(個数)` になる既存挙動を変えてはならない。

scalar subquery も内側と外側を独立した query block として扱う。

### 2.8 DML

`INSERT ... SELECT` および `UPSERT ... SELECT` の SELECT query block には本仕様を適用する。

SELECT source の公開列、列順、値が正しくなった後、既存の DML 変換へ渡す。

`UPDATE SET` 自体のフィールド参照規則は変更しない。

`UPDATE SET x = (SELECT ...)` の scalar subquery は通常の SELECT 実行経路を使用するため、内側 query block には本仕様を適用する。ただし、scalar subquery の1行1列制約、実行回数、SET への変換規則は変更しない。

### 2.9 拡張 grouping

`ROLLUP` / `CUBE` / `GROUPING SETS` でも、内部の入力値と出力値を混在させてはならない。

ただし、B65 の次の既存契約は変更しない。

- grouping item は物理フィールド限定
- aggregate alias と grouping runtime key の既存 collision 検査
- `GROUPING()` の規則
- `KORDER BY`、ウィンドウ等との既存併用制限

B147 を理由に、従来エラーだった拡張 grouping SQLを新たに許可しない。

---

## 3. 実現方法

### 3.1 採用案

起票 §5 の **案 C「衝突しても元のフィールド値を壊さない」**を採用する。

案 C は次の原則を直接実現する。

> SELECT 出力の alias は、入力 relation のフィールド名ではない。

入力フィールドと SELECT 出力を同じ文字列キーのオブジェクトへ格納せず、内部で別の名前空間または別の保存領域として保持する。

### 3.2 必要な内部責務

具体的な関数名やデータ構造は実装者に委ねるが、意味上は次を分離する。

1. **source 値**
   - 入力レコードの物理フィールド
   - JOIN の修飾フィールド
   - CTE・一時テーブル・サブクエリから受け取った入力列
   - grouping key の元になる値

2. **SELECT materialized 値**
   - 通常集計
   - 集計算術式
   - 集計を含む文字列関数、scalar value、`CASE`
   - ウィンドウ関数
   - `GROUPING()` 等、SELECT 出力として実体化される値

3. **句固有の alias lookup**
   - `HAVING`
   - 通常 `ORDER BY`
   - 最終 projection

materialized 値の内部 identity は、公開 alias 文字列だけに依存させてはならない。少なくとも SELECT 列位置または同等の衝突しない identity を持たせる。

### 3.3 内部値を source 列として露出しない

materialized 値の内部保存先は、次へ混入してはならない。

- SELECT 式内のフィールド参照
- `SELECT *`
- `alias.*`
- `_p.*`
- wildcard の列一覧
- `DISTINCT` の入力列集合
- CTE・一時テーブルの公開 `columns`
- 公開 `SelectResult.rows`
- 公開 `SelectResult.columns`

文字列の予約 prefix を使う場合も、利用者が同名フィールドを作れる可能性を考慮し、通常のフィールド参照から到達できないことを保証する。

### 3.4 集計値の読み出し

集計列自身の projection は、入力行の `row[alias]` ではなく、その SELECT 列に対応する materialized 値を読む。

```sql
SUM(個数) AS 個数
```

この列の公開出力名は `個数` のままだが、内部保存先は入力フィールド `個数` と別でなければならない。

alias のない集計列も、公開合成名と内部保存先を分ける。

### 3.5 句ごとの解決

- SELECT 式内のフィールド参照は source 値だけを見る
- `HAVING` の SELECT alias 参照は materialized 値または対象 SELECT 式を見る
- 通常 `ORDER BY` の SELECT alias 参照は対象 SELECT 列の値を見る
- alias に一致しない `HAVING` / `ORDER BY` の参照は既存規則で入力列等へ解決する
- 最終 projection は SELECT 列順に materialized 値または source から評価した値を公開出力へ書く

同じ名前に対して全句共通の単一 lookup を使用してはならない。

### 3.6 評価回数と評価順

本仕様では、評価順または評価回数を意図的に変更しない。

維持する順序は次のとおりである。

1. FROM / JOIN
2. WHERE
3. GROUP BY と集計
4. HAVING
5. ウィンドウ
6. DISTINCT
7. 通常 ORDER BY
8. LIMIT / OFFSET
9. 最終 projection

また、次も維持する。

- grouping key は既存どおり入力行ごとに評価する
- 集計関数は既存どおりグループ単位で評価する
- `HAVING` は集計後に評価する
- ウィンドウ関数は `HAVING` 後に評価する
- `ORDER BY` alias は projection 前に対象 SELECT 列の値として評価できる
- scalar subquery の実行回数は変更しない
- SET scalar subquery は既存どおり一度実行した値を使用する

非集計 SELECT 式を集約前に先行評価して持ち回る方式は採用しない。これは関数の評価時点・評価回数を変える可能性があるためである。

本修正は評価時点を移動するのではなく、評価時に参照する名前空間を正す。

### 3.7 他案を採用しない理由

| 案 | 判断 | 理由 |
|---|---|---|
| 案 A: キー式を再評価しない | 不採用 | grouping key と完全一致する式以外も対象であり、SELECT 式の評価回数・評価時点を変える可能性がある |
| 案 B: alias とフィールドの衝突をエラーにする | 不採用 | `SELECT 商品, SUM(数量) AS 数量 ...` という自然で無害な SQL まで拒否する |
| 案 C: 保存先を分ける | **採用** | SELECT 内 alias 非可視という原則を直接表現し、無害な同名 alias を維持できる |
| 案 D: 警告だけ出す | 不採用 | 誤った値を返し続けるため、静かな誤結果の解消にならない |

---

## 4. 破壊的変更

### 4.1 破壊的変更になる範囲

新たな構文エラーまたは実行時エラーは導入しない。

ただし、現行の上書き挙動へ依存していた SQL の結果値は変わるため、結果互換性の点では破壊的変更である。

```sql
SELECT 個数 * 2 AS 倍,
       SUM(個数) AS 個数
FROM APP147A
WHERE 製品名 = '食パン'
GROUP BY 製品名, 個数
```

fixture 上の現行誤結果:

```text
倍=2584, 個数=1292
```

修正後:

```text
倍=1292, 個数=1292
```

次も同様に変わる。

- 日付関数の空文字が正しい日付文字列になる
- 算術式が集計値ベースから grouping key ベースになる
- 文字列連結が集計値の文字列化から元フィールド値になる
- `CASE` の誤分類が元フィールドによる分類になる
- ウィンドウ alias の衝突が実測で再現する場合、その誤結果も正しい入力列ベースへ変わる

これらは意図した修正であり、旧結果を互換動作として残さない。

### 4.2 落としてはならない SQL

次はエラーにしてはならない。

```sql
SELECT 商品,
       SUM(数量) AS 数量
FROM APP100
GROUP BY 商品
```

集計 alias と入力フィールド名が同じでも、他の SELECT 式がその入力フィールドへ依存しない限り結果は従来と同じである。

同様に、次も維持する。

```sql
SELECT 製品名,
       SUM(個数) AS 個数
FROM APP147A
GROUP BY 製品名
ORDER BY 個数 DESC
```

```sql
SELECT 製品名,
       SUM(個数) AS 個数
FROM APP147A
GROUP BY 製品名
HAVING 個数 >= 700
```

### 4.3 エラー契約

B147 専用の新しい `ArgumentError`、warning、reason code は設けない。

本件は名前衝突を禁止する変更ではなく、成功していた SQL の値を正す変更である。

既存の次のエラーは維持する。

- B148 の非 grouping dependency エラー
- 集計 alias を `GROUP BY` key にするエラー
- plain `GROUP BY` の unknown / ambiguous / duplicate alias エラー
- B65 の aggregate alias collision
- 集計とウィンドウを同じ SELECT に置く `ParseError`
- scalar subquery の0行・複数行・複数列エラー

---

## 5. 適用範囲

| 対象 | Phase 1 の扱い |
|---|---|
| ordinary `GROUP BY` の SELECT | **対象** |
| `GROUP BY` なし集計の SELECT | **対象** |
| SELECT 内の算術・関数・連結・`CASE` | **対象** |
| 集計算術式・集計入り関数・集計入り `CASE` | **対象** |
| `HAVING` | alias の既存可視性を維持し、回帰対象 |
| 通常 `ORDER BY` | alias 優先を維持し、回帰対象 |
| `KORDER BY` | 名前解決規則は変更しない |
| ウィンドウ関数 | 同じ SELECT の入力を上書きしない内部表現の対象 |
| `OVER (PARTITION BY / ORDER BY)` | 同一 SELECT alias 非可視を維持 |
| CTE | query block ごとに適用。下流の実体化列は入力列 |
| 一時テーブル | CTE と同じ |
| scalar subquery | 内外を別 query block として適用 |
| `INSERT ... SELECT` | SELECT source に適用 |
| `UPSERT ... SELECT` | SELECT source に適用 |
| `UPDATE SET x = (SELECT ...)` | 内側 SELECT に適用。SET 自体は変更しない |
| `UPDATE ... FROM` | 専用 relation / SET 規則は変更しない |
| `ROLLUP` / `CUBE` / `GROUPING SETS` | 内部保存分離は適用するが、B65 の公開制約は維持 |
| UNION | 各 branch の query block に独立適用 |
| SELECT 出力の重複 alias | 既存の公開出力規則を維持 |

---

## 6. 受入条件

### 6.1 観測方法

受入条件は内部関数名、ファイル名、クラス名、保存方式を要求しない。

正常系は公開 `SelectResult` の次の値で判定する。

- `rows`
- `columns`
- `rowCount`
- `warnings`

行順を要求するケースでは、完全な SQL に `ORDER BY` を含める。

本仕様によって新しい warning を追加しない。

### 6.2 fixture

APP147A は次の物理フィールドを持つ。

- `$id`
- `製品名`
- `個数`
- `日付`
- `入出庫区分`

mock records は次の5件とする。

| `$id` | 製品名 | 個数 | 日付 | 入出庫区分 |
|---:|---|---:|---|---|
| 1 | 食パン | 646 | 2025-08-01 | 入庫 |
| 2 | 食パン | 646 | 2025-08-15 | 出庫 |
| 3 | 牛乳 | 706 | 2025-09-01 | 入庫 |
| 4 | りんご | 27 | 2025-10-01 | 入庫 |
| 5 | りんご | 27 | 2025-10-02 | 出庫 |

APP147A に物理フィールド `年月`、`倍`、`区分`、`加工名`、`商品`は存在しない。

### 6.3 直るもの

#### 6.3.1 日付関数

```sql
SELECT DATE_FORMAT(日付, '%Y-%m') AS 年月,
       SUM(個数) AS 日付
FROM APP147A
WHERE 製品名 = '食パン'
GROUP BY 年月
```

期待結果:

```json
{
  "type": "SELECT",
  "columns": ["年月", "日付"],
  "rows": [
    { "年月": "2025-08", "日付": "1292" }
  ],
  "rowCount": 1
}
```

`年月` を空にしてはならない。

#### 6.3.2 算術式

```sql
SELECT 個数 * 2 AS 倍,
       SUM(個数) AS 個数
FROM APP147A
WHERE 製品名 = '食パン'
GROUP BY 製品名, 個数
```

期待結果:

```json
{
  "type": "SELECT",
  "columns": ["倍", "個数"],
  "rows": [
    { "倍": "1292", "個数": "1292" }
  ],
  "rowCount": 1
}
```

`倍` を `2584` にしてはならない。

#### 6.3.3 文字列連結

```sql
SELECT 製品名 || '-x' AS 加工名,
       SUM(個数) AS 製品名
FROM APP147A
WHERE 製品名 = '食パン'
GROUP BY 製品名
```

期待結果:

```json
{
  "type": "SELECT",
  "columns": ["加工名", "製品名"],
  "rows": [
    { "加工名": "食パン-x", "製品名": "1292" }
  ],
  "rowCount": 1
}
```

`加工名` を `1292-x` にしてはならない。

#### 6.3.4 `CASE`

```sql
SELECT CASE
         WHEN 個数 > 40 THEN '大'
         ELSE '小'
       END AS 区分,
       SUM(個数) AS 個数
FROM APP147A
WHERE 製品名 = 'りんご'
GROUP BY 個数
```

期待結果:

```json
{
  "type": "SELECT",
  "columns": ["区分", "個数"],
  "rows": [
    { "区分": "小", "個数": "54" }
  ],
  "rowCount": 1
}
```

集計値 `54` で判定した `大` を返してはならない。

### 6.4 SELECT 列順に依存しないこと

次のSQLも §6.3.2 と同じ値を返す。

```sql
SELECT SUM(個数) AS 個数,
       個数 * 2 AS 倍
FROM APP147A
WHERE 製品名 = '食パン'
GROUP BY 製品名, 個数
```

期待結果:

```json
{
  "type": "SELECT",
  "columns": ["個数", "倍"],
  "rows": [
    { "個数": "1292", "倍": "1292" }
  ],
  "rowCount": 1
}
```

集計列を先に書いたか後に書いたかで `倍` の値を変えてはならない。

### 6.5 変わらないもの

#### 6.5.1 自然な同名 alias

```sql
SELECT 製品名,
       SUM(個数) AS 個数
FROM APP147A
WHERE 製品名 = '食パン'
GROUP BY 製品名
```

期待結果:

```json
{
  "type": "SELECT",
  "columns": ["製品名", "個数"],
  "rows": [
    { "製品名": "食パン", "個数": "1292" }
  ],
  "rowCount": 1
}
```

エラーまたは warning にしてはならない。

#### 6.5.2 非衝突形

```sql
SELECT 個数 * 2 AS 倍,
       SUM(個数) AS 合計
FROM APP147A
WHERE 製品名 = '食パン'
GROUP BY 製品名, 個数
```

期待結果:

```json
{
  "type": "SELECT",
  "columns": ["倍", "合計"],
  "rows": [
    { "倍": "1292", "合計": "1292" }
  ],
  "rowCount": 1
}
```

#### 6.5.3 1件グループ

```sql
SELECT 個数 * 2 AS 倍,
       SUM(個数) AS 個数
FROM APP147A
WHERE 製品名 = '牛乳'
GROUP BY 製品名, 個数
```

期待結果:

```json
{
  "type": "SELECT",
  "columns": ["倍", "個数"],
  "rows": [
    { "倍": "1412", "個数": "706" }
  ],
  "rowCount": 1
}
```

このケースだけで修正を検証してはならない。旧実装でも偶然同じ値になり得る。

#### 6.5.4 `ORDER BY` alias 優先

```sql
SELECT 製品名 AS 商品,
       SUM(個数) AS 個数
FROM APP147A
GROUP BY 製品名
ORDER BY 個数 DESC
```

期待結果:

```json
{
  "type": "SELECT",
  "columns": ["商品", "個数"],
  "rows": [
    { "商品": "食パン", "個数": "1292" },
    { "商品": "牛乳", "個数": "706" },
    { "商品": "りんご", "個数": "54" }
  ],
  "rowCount": 3
}
```

物理 `個数` ではなく集計 alias の値で並べる。

#### 6.5.5 `HAVING` alias

```sql
SELECT 製品名 AS 商品,
       SUM(個数) AS 個数
FROM APP147A
GROUP BY 製品名
HAVING 個数 >= 700
ORDER BY 個数 DESC
```

期待結果:

```json
{
  "type": "SELECT",
  "columns": ["商品", "個数"],
  "rows": [
    { "商品": "食パン", "個数": "1292" },
    { "商品": "牛乳", "個数": "706" }
  ],
  "rowCount": 2
}
```

`HAVING 個数` をグループ先頭行の物理 `個数` として評価してはならない。

#### 6.5.6 CTE 下流

```sql
WITH m AS (
  SELECT 製品名,
         SUM(個数) AS 個数
  FROM APP147A
  WHERE 製品名 = '食パン'
  GROUP BY 製品名
)
SELECT 個数 * 2 AS 倍
FROM m
```

期待結果:

```json
{
  "type": "SELECT",
  "columns": ["倍"],
  "rows": [
    { "倍": "2584" }
  ],
  "rowCount": 1
}
```

下流 query block では、CTE 出力の `個数` が正規の入力列である。

### 6.6 ウィンドウ alias の adversarial 条件

```sql
SELECT 個数 * 2 AS 倍,
       ROW_NUMBER() OVER (ORDER BY $id) AS 個数
FROM APP147A
WHERE 製品名 = 'りんご'
ORDER BY $id
```

期待結果:

```json
{
  "type": "SELECT",
  "columns": ["倍", "個数"],
  "rows": [
    { "倍": "54", "個数": "1" },
    { "倍": "54", "個数": "2" }
  ],
  "rowCount": 2
}
```

`倍` をウィンドウ結果から計算した `2`、`4` にしてはならない。

この現行誤動作は未実測であるため、Claude が修正前の実測結果も記録する。修正前に再現しなかった場合でも、SELECT alias 非可視の契約として上記結果を保証する。

### 6.7 `DISTINCT` と内部値の漏洩防止

```sql
SELECT DISTINCT 個数 * 2 AS 倍,
                SUM(個数) AS 個数
FROM APP147A
WHERE 製品名 = '食パン'
GROUP BY 製品名, 個数
```

期待結果:

```json
{
  "type": "SELECT",
  "columns": ["倍", "個数"],
  "rows": [
    { "倍": "1292", "個数": "1292" }
  ],
  "rowCount": 1
}
```

内部 materialized slot を `columns` または公開行へ追加してはならない。

### 6.8 複数の参照式

```sql
SELECT 個数 * 2 AS 倍,
       CASE WHEN 個数 > 100 THEN '大' ELSE '小' END AS 区分,
       SUM(個数) AS 個数
FROM APP147A
WHERE 製品名 = '食パン'
GROUP BY 製品名, 個数
```

期待結果:

```json
{
  "type": "SELECT",
  "columns": ["倍", "区分", "個数"],
  "rows": [
    { "倍": "1292", "区分": "大", "個数": "1292" }
  ],
  "rowCount": 1
}
```

すべての非集計式が同じ source 値 `646` を参照する。

### 6.9 実アプリ APP4228 の回帰

起票 §8 の実測SQLを v3.57.0 と修正後で比較する。

修正後は次を満たす。

- 日付関数: `年月="2025-08"`
- 算術: `倍=1292`
- 文字列連結: `食パン-x`
- `CASE`: キー値27のグループは `小`
- 集計値、`columns`、`rowCount`、行順、既存 warnings は衝突修正以外で変わらない
- 非衝突SQLの公開結果は完全一致する

---

## 7. 回帰条件

次を必須回帰とする。

1. `SELECT 商品, SUM(数量) AS 数量 ... GROUP BY 商品` が成功する
2. plain `GROUP BY` の物理フィールド優先を維持する
3. plain `GROUP BY` の SELECT alias fallback を維持する
4. 通常 `ORDER BY` の SELECT alias 優先を維持する
5. `HAVING` の既存集計 alias 参照を維持する
6. CTE・一時テーブル下流では実体化列を通常の入力列として扱う
7. scalar subquery の1行1列制約を維持する
8. 集計とウィンドウを同じ SELECT に置く既存 `ParseError` を維持する
9. B148 の dependency validation 結果を変更しない
10. B65 の aggregate alias collision を変更しない
11. SELECT 出力列順を変更しない
12. 同名出力 alias の既存上書き規則を変更しない
13. `SELECT *` に内部 materialized 値を出さない
14. `DISTINCT` の tuple に内部保存用キーを追加しない
15. `rowCount`、warnings、metrics の公開形式を変更しない
16. 集計関数の評価回数を増やさない
17. scalar subquery の実行回数を増やさない

---

## 8. Phase 1 の線引き

### 8.1 Phase 1 に含めるもの

- aggregate materialized 値と source 値の分離
- window materialized 値と source 値の分離
- SELECT projection の正しい読み分け
- `HAVING` の alias lookup 維持
- 通常 `ORDER BY` の alias lookup 維持
- ordinary `GROUP BY`
- `GROUP BY` なし集計
- 拡張 grouping 内部での値保存分離
- CTE・一時テーブル・サブクエリの query block 境界
- `INSERT ... SELECT` / `UPSERT ... SELECT` の source SELECT
- `UPDATE SET` scalar subquery の内側 SELECT
- engine library / CLI / MCP / plugin 共通結果
- 言語リファレンスとリリースノートの更新

### 8.2 Phase 1 に入れないもの

| 対象外 | 理由 |
|---|---|
| 集計 alias と物理フィールドの衝突禁止 | 自然で無害なSQLまで落とすため |
| B147 専用 warning | 正しい値を返せば警告は不要 |
| B147 専用エラーコード | 本件は成功SQLの値修正である |
| SELECT alias の左から右への参照 | 標準 SQL の原則に反する別言語機能 |
| `GROUP BY` の名前解決順変更 | 公開契約外の変更になる |
| `HAVING` / 通常 `ORDER BY` の alias 廃止 | 既存公開契約を壊す |
| `OVER` 内から同一 SELECT alias を参照可能にする変更 | 既存契約と異なる言語拡張 |
| 集計とウィンドウの同一 SELECT 解禁 | parser・評価順を含む別機能 |
| B65 の aggregate alias collision 緩和 | 拡張 grouping の公開契約変更 |
| `UPDATE ... FROM` の専用 SET 名前解決変更 | 本件の SELECT 出力上書きとは別経路 |
| 相関 scalar subquery | 現行の非相関 scalar subquery 契約外 |
| SELECT 式の一度だけ評価保証 | 評価回数を変える別仕様 |
| 公開 `SelectResult` 型の拡張 | 内部保存分離は公開型を変えず実現できる |
| B148 の grouping identity 規則変更 | B147 と B148 は異なる欠陥である |

---

## 9. 文書・リリース

実装時は少なくとも次を更新する。

- `docs/ksql_language_reference.md` §8
- CHANGELOG / release history
- 本仕様の実装報告
- 集計・ウィンドウ・CTE の回帰テスト
- CLI / MCP / plugin の共通 smoke または同等の公開結果テスト
- 配布 bundle / manifest / release artifact

言語リファレンス §8 には次を明記する。

1. SELECT alias は同じ SELECT 句の他の式から見えない
2. SELECT 式内のフィールド参照は入力 relation の列を指す
3. 集計 alias と入力フィールド名が同じでもエラーにはならない
4. `GROUP BY` は物理フィールド優先、存在しない場合だけ SELECT alias fallback
5. 通常 `ORDER BY` は SELECT alias 優先
6. `HAVING` の既存 alias 参照は維持する
7. CTE・一時テーブル等で実体化された出力列は下流 query block の入力列になる
8. ウィンドウ内から同一 SELECT alias は参照できない

リリースノートには、次のように結果互換性が変わることを具体例付きで記載する。

```sql
SELECT 個数 * 2 AS 倍,
       SUM(個数) AS 個数
FROM APP100
GROUP BY 個数
```

以前は `倍` が `2 × SUM(個数)` になる場合があったが、修正後は SQL の意味どおり `2 × grouping key 個数` になる。

---

## 10. 実装完了条件

次をすべて満たしたとき B147 Phase 1 完了とする。

- §6 の正常系が公開 `SelectResult` で一致する
- §7 の回帰を通す
- SELECT 列順を逆転した adversarial test を通す
- 2件以上を実際に集約する fixture で検証する
- 1件グループだけを根拠にしない
- APP4228 の4種類の実測SQLを再実行する
- `HAVING` / `ORDER BY` の alias 契約を実測する
- ウィンドウ alias 衝突を修正前後で実測する
- CTE 下流が集計済み列を参照することを実測する
- 内部保存値が wildcard、`DISTINCT`、公開 `columns`、公開 `rows` に漏れない
- 新しいエラーまたは warning を導入しない
- 集計・scalar subquery の評価回数に意図しない変更がない
- 言語リファレンスとリリース文書を更新する
- build / unit tests / integration tests / browser-facing smoke を対象面に応じて完了する

---

## 11. B148 との関係

B148 と B147 は別の欠陥である。

- B148: grouping identity に依存しない列をグループ先頭行から返していた
- B147: 正しく許可された grouping dependency の入力値を、SELECT alias が上書きしていた

共通する原則は次である。

> **SELECT 式の内部参照を、同じ SELECT 句の alias へ fallback させない。**

B148 の canonical identity は、SELECT 内部の参照がどの入力列・grouping expression に依存するかを検査する。

B147 は、その検査を通った式が実行時にも同じ入力値を参照することを保証する。

B147 の実装によって、B148 の許可・拒否範囲、エラー reason、修正案、first error を変更してはならない。

---

## 12. Claude が実測すべき未確認事項

以下はコード読解だけでは公開面の現行挙動または全影響範囲を確定できない。実装前後に Claude が実測する。

### 12.1 `HAVING`

集計 alias と物理フィールド名が一致する場合に、現行 v3.57.0 がどちらを参照するか確認する。

```sql
SELECT 製品名 AS 商品,
       SUM(個数) AS 個数
FROM APP147A
GROUP BY 製品名
HAVING 個数 >= 700
ORDER BY 個数 DESC
```

確認項目:

- 修正前の `rows` / `columns` / `rowCount`
- 修正後に集計 alias を参照すること
- 物理フィールドへ解決が変わらないこと
- 直接記述した集計関数を使う既存形との一致

### 12.2 ウィンドウ関数の alias

少なくとも次を実測する。

- `ROW_NUMBER()`
- `RANK()` / `DENSE_RANK()`
- `LAG()` / `LEAD()`
- `SUM(...) OVER (...)`
- frame あり／なし
- alias が入力物理フィールド名と一致する形
- alias が別の SELECT 式から参照されそうに見える形
- `PARTITION BY` または window 内 `ORDER BY` と alias が同名になる形

代表SQL:

```sql
SELECT 個数 * 2 AS 倍,
       ROW_NUMBER() OVER (ORDER BY $id) AS 個数
FROM APP147A
WHERE 製品名 = 'りんご'
ORDER BY $id
```

修正前に再現しない場合も、その結果を記録する。

### 12.3 DML の `SET` 側

`UPDATE SET x = (SELECT ...)` について確認する。

- 内側 SELECT が通常の修正済み実行経路を通ること
- scalar subquery の1行1列制約が先に効く形
- CTEまたは一時テーブルを介して、B147 の影響を受けた列だけを1列にした scalar subquery が現行 grammar で表現可能か
- 表現可能なら、使い捨て target app で SET 値を実測する
- scalar subquery が1回だけ実行されること
- 対象件数、confirm、VALIDATE ONLY 等の既存安全契約が変わらないこと

現行 grammar で直接再現できない場合は「DML 固有の不具合なし。内側 SELECT の修正が伝播するだけ」と記録し、無理に構文を追加しない。

### 12.4 集計列の全種別

次の materialized SELECT 列について、alias が入力フィールド名と一致しても source 値を壊さないことを確認する。

- `COUNT`
- `SUM`
- `AVG`
- `MIN`
- `MAX`
- `GROUP_CONCAT`
- `MEDIAN`
- `MODE`
- 分散・標準偏差系
- DISTINCT aggregate
- 集計算術式
- 集計を含む文字列関数
- 集計を含む scalar value
- 集計を含む `CASE`

### 12.5 JOIN

次を分けて実測する。

- 非修飾の物理列
- テーブル alias で修飾した物理列
- 左右に同名フィールドがある JOIN
- SELECT aggregate alias が非修飾名と一致する形
- SELECT aggregate alias が文字列として修飾名と同じ形
- `ORDER BY` alias の既存優先
- ambiguous field error の維持

修飾列と非修飾 bridge のどちらも、SELECT materialized 値で上書きされないことを確認する。

### 12.6 `DISTINCT` / wildcard / 重複 alias

次を確認する。

- `SELECT DISTINCT` の比較値が修正後の SELECT 値と一致する
- materialized 内部値が `SELECT *` に出ない
- 0行時の `columns` に内部値が出ない
- wildcard 混在時に内部値が出ない
- 同じ alias を複数の SELECT 列に付けた場合の既存公開規則
- `columns` の順序
- 公開 `rows` のキー
- CTE・一時テーブルへ実体化した際の列一覧

### 12.7 拡張 grouping

次を実測する。

- `ROLLUP`
- `CUBE`
- `GROUPING SETS`
- `GROUPING()`
- aggregate alias と grouping runtime key の既存 collision error
- grouping field と同名でない aggregate alias の正常系
- 内部保存分離によって既存エラーが成功へ変わらないこと
- 小計・総計行の空値表現が変わらないこと

### 12.8 CTE・サブクエリ・一時テーブル・UNION

次を実測する。

- CTE 内部で衝突する query block
- CTE 下流で集計済み同名列を参照する query block
- scalar subquery 内部
- scalar subquery の外側
- 一時テーブルへの実体化
- 一時テーブル下流
- UNION の片側だけが衝突する形
- UNION の列名・列順・型メタデータ

各 query block の境界を越えた出力列は、下流で正規の入力列として扱うことを確認する。

### 12.9 評価回数・評価順

instrumented test または既存の評価回数を観測できる fixture で次を確認する。

- grouping key の評価回数
- 集計関数の評価回数
- SELECT scalar subquery の実行回数
- `UPDATE SET` scalar subquery の実行回数
- `ORDER BY` alias evaluator の評価時点
- `DISTINCT` と projection の評価順
- ウィンドウ評価が `HAVING` 後であること

本修正のために非集計 SELECT 式を集約前へ移動していないことを確認する。

### 12.10 全公開面

同じ SQL と fixture について、可能な範囲で次の結果を比較する。

- engine library
- CLI
- MCP
- plugin
- CTE / batch / 一時テーブル経路
- `INSERT ... SELECT`
- `UPSERT ... SELECT`
- `UPDATE SET` scalar subquery

比較対象:

- `rows`
- `columns`
- `rowCount`
- warnings
- エラー種別と reason
- DML の場合は mutation 前に得られる source 値と、使い捨て環境での保存値

B147 で意図した値修正以外の差分があれば、Phase 1 完了前に原因を切り分ける。

---

## 13. Claude レビュー（2026-08-07・実測つき）

**結論＝実装着手可。指摘 0 件。実測で 1 つ範囲が広がった（仕様は先回りできている）。**

**作成は codex、レビューは Claude。**

### 13.1 §12.2 を実測 — **ウィンドウ別名でも起きる。しかも `GROUP BY` が要らない**

```
SELECT 個数 * 2 AS 倍, ROW_NUMBER() OVER (ORDER BY $id) AS 個数 FROM APP4228
  → 倍 = 2, 4, 6          ← 2 × 行番号（誤り）

SELECT 個数, 個数 * 2 AS 倍, ROW_NUMBER() OVER (ORDER BY $id) AS 順 FROM APP4228
  → 倍 = 1292, 1412, 796  ← 2 × 個数（正）
```

**起票は「集計の別名」として書いたが、ウィンドウ関数の別名でも同じことが起きる。**
**しかも素の `SELECT`（集計も `GROUP BY` も無い）で起きる**ので、**踏む範囲は起票時の想定より広い。**

**仕様は §8.1 に「window materialized 値と source 値の分離」を入れており、先回りできている。**
**起票の表題と §1 は「集計の別名」に限っているので、そちらを直す**（§13.4）。

### 13.2 §12.1 の基準値を実測（**修正後に変わってはいけない**）

```
SELECT 製品名, SUM(個数) AS 個数 FROM APP4228 GROUP BY 製品名
HAVING 個数 >= 20000 ORDER BY 個数 DESC
  → 牛乳 29351 / 食パン 23429
```

**`HAVING` と `ORDER BY` は集計の別名を見ている。** **§4.2 のとおり維持すること。**

**これが本仕様のいちばん難しいところ**＝**別名を `SELECT` 式からは見えなくしつつ、
`HAVING` / `ORDER BY` からは見えたままにする**（§3.2 の 3 番目）。

```
SELECT 製品名, SUM(個数) AS 個数, COUNT(*) AS 件数 FROM APP4228 GROUP BY 製品名
  → 食パン 23429 / 220（正しい。他の式が 個数 を参照していないため）
```

### 13.3 良かった点（R2 で消さないこと）

- **§3.1 で案 C を選んだ理由**＝「SELECT 出力の alias は、入力 relation のフィールド名ではない」。
  **案 B（衝突をエラー）を採らなかったのが正しい**＝
  **`SELECT 商品, SUM(数量) AS 数量` は自然で無害**であり、落とすと実害だけが残る
- **§3.3 が「内部保存先を source 列として露出しない」を列挙**している
  （`SELECT *`・`DISTINCT` の入力列・CTE の公開 `columns`・公開 `SelectResult`）。
  **予約 prefix を使う場合も利用者が同名フィールドを作れる**と書いてあるのが良い
- **§4.1 が「新たなエラーを導入しない」と明言**。**本件は成功 SQL の値修正**である
- **§8.2 が「入れないもの」を 14 件、理由つきで挙げている**。
  とくに**「SELECT alias の左から右への参照」を別言語機能として切っている**のが正しい
- **§11 が B148 との混同を禁止**している

### 13.4 R2 で直すもの（**仕様ではなく起票の記述**）

**[起票](ksql_b147_aggregate_alias_shadows_key_input_issue.md)の表題と §1 が「集計の別名」に限っている。**
**ウィンドウ別名でも起きる**ので、**起票側を「SELECT の出力別名」に広げる。**
**仕様は既に広く書けているので、変更不要。**
