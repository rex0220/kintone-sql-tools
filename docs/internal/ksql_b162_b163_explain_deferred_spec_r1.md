# B162・B163 EXPLAIN の未解決情報を安全に扱う仕様（R1）

- ステータス: **R1**
- 対象: kSQL v3.63.0
- 起票:
  - [B162](ksql_b162_explain_declare_series_issue.md)
  - [B163](ksql_b163_explain_temp_groupby_internalerror_issue.md)
- 対象範囲: **EXPLAIN のみ**
- 実行・`ksql_validate` の意味論: **変更しない**
- EXPLAIN 契約:
  - records API は **0 回**
  - 一時テーブルの行は実体化しない
  - 実行時にしか確定しない値を、確定済みであるかのように表示しない
  - `InternalError` を利用者向け診断として出さない

---

## 0. 目的

B162 と B163 は原因となる機能が異なる。

- B162 は、`DECLARE` 変数の値を EXPLAIN がプレースホルダーへ置換した後、そのプレースホルダーを `GENERATE_SERIES` の実在する日付として検査してしまう問題である。
- B163 は、EXPLAIN が一時テーブルを実体化しないため後続 `GROUP BY` の schema が無いと判断し、利用者へ `InternalError` を出す問題である。

しかし、共通する設計課題は同じである。

> **EXPLAIN は、SQL から静的に証明できる情報を利用してよい。一方、外部注入値、SET の評価結果、一時テーブルの実行行など、実行時にしか確定しない情報は確定計画として扱わず、条件付き計画または deferred として明示する。**

B162・B163 はこの原則の適用として実装する。

---

## 1. 現行コードから確定する事実

### 1.1 バッチ変数と B162

| 事実 | 根拠 |
|---|---|
| EXPLAIN は `SET` / `DECLARE` の後続参照に、`placeholder: true` の文字列 `@name` を登録する | `src/execute.ts:11063-11070` |
| 通常の変数参照は登録値を `STRING` または `NUMBER` リテラルへ置換する | `src/execute.ts:2107-2153` |
| 算術内のプレースホルダーは `NUMBER value=0, raw=@name` という特例で保持される | `src/execute.ts:2130-2152` |
| WHERE の候補表示には、`@` で始まる文字列をプレースホルダーとみなす既存判定がある | `src/execute.ts:3944-3957` |
| プレースホルダーを含む WHERE は確定 pushdown ではなく `pushdown candidate` として表示される | `src/execute.ts:11824-11830,11934-11940` |
| `GENERATE_SERIES` の引数は数値、文字列、変数だけである | `src/types/ast.ts:186-193`, `src/parser/parser.ts:1271-1302` |
| `GENERATE_SERIES` の AST-only 検証は、未解決 `VARIABLE` を含む場合に型・step・行数の値依存判定を保留できる | `src/core/generateSeries.ts:262-304` |
| 解決後の系列 planner は文字列を実在日付として検査し、不正なら起票の `ArgumentError` を出す | `src/core/generateSeries.ts:189-259` |
| バッチ EXPLAIN は変数置換後の statement に静的検査を行う | `src/execute.ts:11008-11016` |
| 系列 EXPLAIN は現在、常に `resolveGenerateSeries()` を呼び、type/start/stop/step/rows を確定表示する | `src/execute.ts:12065-12082` |
| 実行時の `DECLARE` は外部注入値を優先し、なければ既定値式を評価する。注釈なし `DECLARE` は最終的に文字列として束縛する | `src/execute.ts:1754-1771` |
| EXPLAIN の既存契約は `DECLARE` の値を非公開とし、外部注入値も表示しない | `src/execute.ts:11124-11134`, `src/__tests__/explain.test.ts:915-925` |

したがって、B162 の直接原因は「EXPLAIN では未解決である値を、`VARIABLE` のまま保留せず、通常文字列 `@name` に近いノードへ変換してから系列の確定 planner に渡すこと」である。

### 1.2 一時テーブル schema と B163

| 事実 | 根拠 |
|---|---|
| 実行時の一時テーブルは `rows`、`columns`、省略可能な `columnMeta` を持つ | `src/execute.ts:413-435` |
| `CREATE TEMP TABLE AS` の実行は SELECT 結果から `rows`、`columns`、`columnMeta` を保存する | `src/execute.ts:1841-1855` |
| ordinary `GROUP BY` planner は materialized source に対して `MaterializedTable.columns` を使用する | `src/execute.ts:3049-3055`, `src/core/optimization/plainGroupByPlan.ts:86-101,121-136` |
| materialized schema が無い場合、現行 planner は起票の `InternalError` を throw する | `src/execute.ts:3050-3054` |
| schema を受け取った plain planner は source schema、grouping plan、B148 依存検査を連続して構築する | `src/execute.ts:3087-3094` |
| EXPLAIN 分析には、初期 materialized relation を渡せる `initialRelations` 引数が既にある | `src/execute.ts:10042-10049` |
| EXPLAIN 分析内部には、行を実行せず relation の出力列名を推論する処理がある | `src/execute.ts:10139-10205` |
| 推論した CTE schema は空の `rows` と列定義を持つ relation として登録される | `src/execute.ts:10214-10236` |
| schema が渡れば plain `GROUP BY` plan と B148 検査を実行できる | `src/execute.ts:10245-10265` |
| バッチ EXPLAIN は各文を独立に分析し、前文の静的 schema を後続文へ渡していない | `src/execute.ts:11008-11050` |
| renderer 自体には materialized schema 未解決時の `DEFERRED` 表示が既にある | `src/execute.ts:11612-11620` |

したがって、B163 は GROUP BY の3層を作り直す問題ではない。欠けているのは、文1から静的に導出した一時テーブルの列 schema を、文2の既存 materialized schema 入力へ渡す配線である。

---

## 2. 共通原則

### 2.1 情報を3種類に分類する

EXPLAIN が扱う情報を次の3種類に分ける。

| 分類 | 例 | EXPLAIN の扱い |
|---|---|---|
| 静的確定 | SQL に直接書かれたリテラル、明示 SELECT 列名、alias、系列のリテラル step | 確定計画に使用できる |
| 条件付き静的 | `DECLARE` のリテラル既定値、先行 `CREATE TEMP TABLE AS SELECT` の出力 schema | 条件と出所を明記して計画に使用できる |
| 実行時 | 外部注入値、`SET` の評価結果、スカラーサブクエリ結果、一時テーブルの行数・実データ | 値を推測せず deferred または runtime と表示する |

### 2.2 条件付き静的情報

条件付き静的情報を利用する場合は、必ず出所と限界を同じ計画ブロックに表示する。

- `DECLARE` の既定値を使う場合:
  - 「DECLARE default に基づく」
  - 「外部注入時は実行計画・件数が変わり得る」
- 一時テーブル schema を使う場合:
  - 「statement N の SELECT 句から導出」
  - 「行は実体化していない」
  - 行数は `runtime`

### 2.3 禁止事項

EXPLAIN は次をしてはならない。

1. `@name` というプレースホルダー文字列を、利用者が指定した実日付として検査する。
2. 外部注入値を計画本文へ表示する。
3. `SET` やスカラーサブクエリを実行して値を得る。
4. schema 推論のために一時テーブルの SELECT を実行する。
5. 静的に分からない schema や値を、空文字・0・任意の型として確定する。
6. 未解決情報を理由として利用者へ `InternalError` を返す。
7. deferred を、正常実行を保証する意味で使用する。

### 2.4 B131 クラスとの線引き

「EXPLAIN は実行時情報を知らない」という B131 クラスの原則は維持する。

B162・B163 で新しく認めるのは、実行時情報の取得ではなく、SQL 本文から導出できる条件付き静的情報の使用である。

| 情報 | B131 の実行時情報か | 本仕様で使用可能か |
|---|---:|---:|
| `DECLARE @x = '2026-01-01'` のリテラル既定値 | いいえ | 条件付きで可 |
| EXPLAIN 呼び出しに渡された外部注入値 | はい | 計画表示には使用しない |
| `SET @x = NOW()` の評価結果 | はい | 不可 |
| `SET @x = (SELECT ...)` の結果 | はい | 不可 |
| `CREATE TEMP TABLE #t AS SELECT a AS x ...` の出力列名 `x` | いいえ | 可 |
| `#t` に実際に入る行数・値 | はい | 不可 |
| APP のフォーム metadata | 実データではない | 既存 EXPLAIN 契約の範囲で可 |
| records API の結果 | はい | 不可 |

---

## 3. B162 の方式選定

### 3.1 決定

B162 は次の併用とする。

1. **主経路: 案Aの限定適用**
   - `GENERATE_SERIES` の引数に限り、先行 `DECLARE` のリテラル既定値を EXPLAIN 内部で束縛する。
   - これは「既定値を使った条件付き計画」である。
2. **fallback: 案B**
   - リテラル既定値だけでは系列を完全に確定できない場合は deferred 表示にする。
3. **案C単独は採用しない**
   - 起票の逐語 SQLは静的に計画可能であるため、エラー文を変えるだけでは運用上の問題を解消できない。
   - ただし deferred にできず診断を返す経路が残る場合も、プレースホルダーを日付として扱った現行エラーは禁止する。

### 3.2 Phase 1 で束縛する既定値

Phase 1 で対象にするのは、注釈なし `DECLARE` の既定値 AST が次のいずれかである場合だけとする。

- `STRING`
- `NUMBER`

実行との一致のため、NUMBER 既定値も注釈なし `DECLARE` の実行規則どおり文字列表現として変数束縛した後、既存 `GENERATE_SERIES` の「変数から解決された整数」規則へ渡す。

次は Phase 1 では評価しない。

- `NOW()` / `TODAY()`
- 文字列関数
- 数値関数
- 数値算術
- `SET`
- スカラーサブクエリ
- `RELATIVE_DATE`
- 外部注入値

これらを含む系列は案Bへ送る。

### 3.3 系列引数だけを対象にする

既存の EXPLAIN 変数 map を、全用途で実値束縛へ変更してはならない。

系列用に次のいずれかの等価な構造を設ける。

- provenance を持つ EXPLAIN 変数情報から、`GenerateSeriesStatement.args` だけを解決する。
- または、通常の placeholder AST と系列計画用 AST を分ける。

受入条件は内部構造ではなく、次である。

1. `GENERATE_SERIES` の引数だけがリテラル既定値で条件付き解決される。
2. 同じ変数が WHERE 等にも使われている場合、その WHERE は従来どおり placeholder/candidate 表示を維持する。
3. 外部注入値は表示されない。
4. 通常実行の変数 resolver は変更しない。

### 3.4 deferred 判定

系列の start、stop、step のうち、型・step・行数の確定に必要な値が1つでも未解決なら、系列全体を deferred とする。

一部のリテラルだけから型を推測してはならない。ただし、未解決値に依存しない構文違反は従来どおりエラーにしてよい。

例:

```sql
SET @start = TODAY();
WITH s AS (GENERATE_SERIES(@start, '2026-08-01', '1 month') AS 月)
SELECT 月 FROM s
```

表示:

```text
[cte: s]
  source:        GENERATE_SERIES
  column:        月
  series type:   deferred (variable)
  start:         @start (runtime)
  stop:          literal
  step:          1 month
  rows:          runtime
  row guard:     runtime / 10000
  records API:   none
```

EXPLAIN は、この表示を成功として返す。実行時には既存の系列検証が実値に対して行われる。

---

## 4. B162 の表示仕様

### 4.1 起票 SQL の表示

必須 SQL:

```sql
DECLARE @m_start = '2025-08-01';
DECLARE @m_stop  = '2026-08-01';
WITH 月系列 AS (GENERATE_SERIES(@m_start, @m_stop, '1 month') AS 月)
SELECT 月 FROM 月系列
```

系列ブロックは少なくとも次の意味を表示する。

```text
[cte: 月系列]
  source:        GENERATE_SERIES
  column:        月
  series type:   DATE (DECLARE default)
  start:         @m_start (DECLARE default; value hidden)
  stop:          @m_stop (DECLARE default; value hidden)
  step:          1 month
  rows:          13 (default-bound estimate)
  row guard:     13 / 10000
  binding:       DECLARE defaults; runtime injection may change this plan
  records API:   none
```

日本語化は可とするが、次の意味要素を欠かしてはならない。

- DATE 系列であること
- `DECLARE` 既定値に基づくこと
- 13 行であること
- 外部注入時は変わり得ること
- records API を呼ばないこと
- start/stop の実値を新たに露出しないこと

### 4.2 外部注入値

EXPLAIN に変数入力が渡されても、Phase 1 では系列計画に注入値を使用しない。

理由:

- 現行 EXPLAIN は注入値を非公開としている。
- 注入値を系列計画へ使用すると、rows/type/step を通じた値の間接漏えいが起こり得る。
- EXPLAIN と保存クエリ実行の入力契約を別途定義せずに、注入値依存の計画へ変更してはならない。

表示は SQL 本文の既定値に基づく条件付き計画、または deferred とする。

---

## 5. B162 の波及範囲と Phase 線引き

注釈なしスカラー変数は現行言語上、次の位置へ到達する。

- WHERE の比較右辺
- HAVING の比較右辺
- CHECK WHEN
- CASE / IF 条件
- KLIKE / NOT KLIKE 右辺
- `IN (@a, @b)` の要素
- SELECT 定数列
- IMPORT SELECT 射影
- UPDATE / UPDATE FROM の SET 値
- ASSERT
- SET のスカラーサブクエリ内
- SELECT 列の算術オペランド
- 集計引数や連結式など、上記と共有する scalar expression 内
- `GENERATE_SERIES` 引数

このうち `LIMIT @n`、`OFFSET @n`、EXPECT ROWS、REJECT LIMIT は現行構文で使用不可である。したがって B162 Phase 1 の束縛変更を LIMIT 等へ波及させてはならない。変数配置の現行境界は `docs/ksql_language_reference.md:3918-3960` に定義されている。

全用途で既定値を束縛すると、次が変わり得る。

- WHERE の `pushdown candidate` が確定 `pushdown applied` になる
- 選択肢・ステータスの実在判定結果
- IN 展開
- KLIKE 計画
- SELECT 定数列の型
- 算術の型判定
- ASSERT の静的評価
- DML の対象・SET 表示
- 機密値の表示
- B148 canonical identity
- dry-run の metadata 要否

したがって Phase を次のように分ける。

| Phase | 範囲 |
|---|---|
| **Phase 1 / B162** | `GENERATE_SERIES` 引数のリテラル `DECLARE` 既定値だけを条件付き束縛。その他は既存 placeholder |
| **Phase 2 候補** | 系列引数における副作用のない非リテラル既定値の評価可否を個別評価 |
| **別仕様** | WHERE、IN、KLIKE、SELECT、算術、ASSERT、DML 等を含む全般的な EXPLAIN default binding |

Phase 2・別仕様は B162 の完了条件に含めない。

---

## 6. B163 の方式選定

### 6.1 決定

B163 は次の3段構えとする。

1. **主経路: 案A**
   - 先行 `CREATE TEMP TABLE AS SELECT` の出力列 schema を静的に導出し、後続文の materialized schema として渡す。
2. **fallback: 案B**
   - schema を安全に導出できない形は `plan status: deferred (temp table schema)` として EXPLAIN を成功させる。
3. **防御契約: 案C相当**
   - 未解決 schema を利用者向け `InternalError` にしてはならない。
   - static/deferred のどちらにも分類できない入力エラーがある場合は、理由と回避方法を持つ `ArgumentError` にする。

案Aの費用は高くない。既存コードには以下が揃っている。

- EXPLAIN 用 relation map
- relation 出力列推論
- `initialRelations`
- materialized `columns` を受ける plain GROUP BY planner
- B148 ordinary dependency policy

必要な中心変更は、これらをバッチ文間で接続する静的 schema ledger である。

### 6.2 案Cだけを先行リリースしない理由

起票の逐語 SQL は明示 SELECT 列だけで schema を導出できる。

```sql
SELECT DATE_FORMAT(s.月, '%Y-%m') AS 年月,
       m.製品名 AS 製品名
```

出力 schema は `["年月", "製品名"]` であり、行の実行や wildcard 展開を必要としない。

したがって、分類・文言だけを先に直して案Aを後回しにする費用上の理由はない。案C相当の防御契約は案Aと同じ Phase に含める。

---

## 7. 静的 temp schema ledger

### 7.1 基本構造

バッチ EXPLAIN は文を先頭から順番に処理し、次の静的台帳を保持する。

```text
temp name
  columns
  optional columnMeta
  producer statement index
  origin = static-select-schema
```

台帳には行を保存しない。

```text
rows: []
```

または行を持たない専用 schema 型としてよい。重要なのは、実行済み一時テーブルと誤認させないことである。

### 7.2 CREATE

`CREATE TEMP TABLE #name AS <query>` では、query の出力列を静的に導出し、成功すれば台帳へ登録する。

明示 SELECT 列では、既存の projection/output-column 規則を再利用する。

対象:

- alias 付き列
- alias なしの単純フィールド
- 集計列
- 計算列
- `WITH`
- `UNION` の位置対応
- `GENERATE_SERIES`
- 空結果でも決定できる明示 schema

### 7.3 DROP

`DROP TEMP TABLE #name` を通過した時点で台帳から削除する。

後続文は削除前の schema を参照してはならない。

### 7.4 後続参照

後続 SELECT が `#name` を参照した場合、台帳の columns を既存 `MaterializedTable.columns` 入力と等価な schema として plain GROUP BY planner へ渡す。

producer statement index は1始まりで表示する。

### 7.5 schema を導出できない場合

次のような形で、安全な列名集合を決定できない場合は deferred とする。

- metadata なしでは展開できない wildcard
- 複数 source wildcard で列衝突規則を確定できない形
- 将来追加される未対応 query producer
- 出力列数・列名を安全に決められない IMPORT 等

deferred のために空 schema を渡してはならない。空 schema は「列が存在しない」という誤った確定情報になる。

---

## 8. `inferSelectColumnMeta` 等の再利用判断

### 8.1 列名推論

B163 Phase 1 の GROUP BY planning に必要なのは、まず `MaterializedTable.columns` である。

既存 plain GROUP BY schema 入力も materialized source については列名集合だけを使用する。

- `src/execute.ts:3049-3055`
- `src/core/optimization/plainGroupByPlan.ts:98-101,134-135`

したがって、主部品として再利用するのは、現行 EXPLAIN 内の relation output column 推論である。

- `src/execute.ts:10139-10205`

この処理をバッチ静的台帳からも利用できる共通 helper へ分離してよい。

### 8.2 `inferSelectColumnMeta`

`inferSelectColumnMeta` は次を扱う既存部品である。

- source field metadata
- 数値／文字列 sort kind
- field semantics
- aggregate、window、CASE 等の出力型
- materialized source からの metadata 継承

根拠: `src/execute.ts:4623-4763`

しかし、B163 の逐語 SQLで後続 ordinary GROUP BYを解決するために必要なのは `年月` と `製品名` の存在であり、完全な型 metadata ではない。

また、`inferSelectColumnMeta` は列種によって APP metadata を取得する可能性がある。

- `src/execute.ts:4608-4637`

したがって R1 では次とする。

1. 出力列名推論は既存 EXPLAIN relation schema 推論を再利用する。
2. `inferSelectColumnMeta` を B163 の必須条件にはしない。
3. 通常 EXPLAIN で metadata が既に利用可能なら、`columnMeta` の付加に再利用してよい。
4. CLI 静的 dry-run では、`inferSelectColumnMeta` のためだけに API を呼ばない。
5. 型 semantics が無いと確定できない後続計画は、列名だけから推測せず既存規則に従い deferred/candidate とする。

---

## 9. GROUP BY 3層との結合

B148 が規定する3層は変更しない。

### 9.1 共通層

- 集計 query block 判定
- SELECT / HAVING / ORDER BY の依存収集
- first error
- reason と利用者向け診断

B163 はこの層を変更しない。

### 9.2 ordinary policy

ordinary policy は schema-aware plain plan から次を作る。

- `PHYSICAL`
- `ALIAS_SAFE`
- `EXPRESSION`
- schema-aware dependency validation

B163 の静的 temp schema は、この ordinary policy の source schema 入力へ結合する。

具体的な結合点は次である。

1. temp schema ledger から `MaterializedTable.columns` 相当を得る。
2. `buildRuntimePlainGroupByPlan()` の materialized source 分岐へ渡す。
3. `resolvePlainGroupBySourceSchemas()` を通す。
4. `planPlainGroupByResolution()` を通す。
5. `assertRuntimePlainGroupByPlan()` と `validateAggregateDependencies()` を通す。

現行の結合点は `src/execute.ts:3049-3055,3087-3094` にある。

B163 専用の別 GROUP BY resolver を作ってはならない。

### 9.3 B65 policy

ROLLUP / CUBE / GROUPING SETS の次の規則は変更しない。

- grouping item の物理 APP フィールド制限
- `GROUPING()` membership
- grouping set/item 上限
- alias collision
- B65 固有制限

B163 は ordinary `GROUP BY` への schema 供給であり、B65 policy の許可範囲を拡張しない。

---

## 10. B163 の表示仕様

### 10.1 必須 SQL

```sql
CREATE TEMP TABLE #t AS
WITH s AS (GENERATE_SERIES('2025-08-01', '2026-08-01', '1 month') AS 月)
SELECT DATE_FORMAT(s.月, '%Y-%m') AS 年月, m.製品名 AS 製品名
FROM s CROSS JOIN APP4229 AS m;

SELECT 製品名, COUNT(*) AS 月数 FROM #t GROUP BY 製品名
```

### 10.2 statement 1

少なくとも次を表示する。

```text
CREATE TEMP TABLE #t
  schema:        年月, 製品名
  schema source: SELECT output of statement 1
  rows:          runtime (not materialized by EXPLAIN)
```

既存の行数上限表示は維持する。

### 10.3 statement 2

少なくとも次の意味を表示する。

```text
  mode:          FULL_SCAN（一時テーブル参照）
  source:        temp table #t (schema from statement 1)
  rows:          runtime
  group key 製品名: PHYSICAL (source=0, field=製品名)
  plan status:   static schema / runtime rows
  records API:   none
```

表記の空白や日本語化は既存 renderer に合わせてよい。

必須意味要素:

- source が `#t` である
- schema の出所が statement 1 である
- GROUP BY キーが schema に対して解決済みである
- 行は実体化していない
- records API は0回である

### 10.4 deferred fallback

schema を導出できない場合:

```text
  source:        temp table #t
  schema:        deferred (could not be derived statically)
  group key x:   DEFERRED (temp table schema unavailable)
  plan status:   deferred (temp table schema)
  rows:          runtime
  records API:   none
```

この場合も EXPLAIN は成功してよい。

---

## 11. エラー分類

### 11.1 禁止する診断

次を利用者へ出してはならない。

```text
InternalError: materialized schema #t is not available for GROUP BY planning.
```

### 11.2 分類規則

| 状態 | 結果 |
|---|---|
| schema を静的導出できる | 既存 GROUP BY planner で確定 |
| schema を静的導出できないが、query 自体は静的に不正と断定できない | deferred |
| schema を導出でき、GROUP BY 列が存在しない | 既存の利用者向け `ArgumentError` |
| schema が複数 source で曖昧 | 既存の ambiguity `ArgumentError` |
| batch dependency が不正 | 既存 batch analysis エラー |
| 実装内部の予期しない不変条件違反 | 内部では記録してよいが、公開面では安易に「未対応」と誤分類しない |

`InternalError` の文字列を catch して置換する実装は禁止する。schema の有無を `STATIC` / `DEFERRED` 等の構造化された結果として分岐する。

### 11.3 ArgumentError fallback

deferred で返せない公開入力エラーには、少なくとも次を含める。

```text
ArgumentError: EXPLAIN could not determine the schema of temp table #t from statement 1.
Explain the source statement separately, or rewrite it with explicit output columns.
(reason=EXPLAIN_TEMP_SCHEMA_UNAVAILABLE)
```

ただし、起票の必須 SQLはこの fallback に入ってはならない。

---

## 12. 適用経路

### 12.1 engine

`buildBatchExplainPlans()` を正本とする。

- バッチ変数の系列限定 default binding
- temp schema ledger
- static/deferred 分類
- 表示行

を同じ実装に置く。

engine library の batch EXPLAIN も `buildBatchExplainPlans()` を使用している。

- `src/engine-library/query.ts:120-129`

### 12.2 MCP

複文 `ksql_explain` は `buildBatchExplainPlans()` を使用する。

- `src/mcp/tools.ts:628-637`

したがって MCP 専用の B162/B163 resolver を作らない。

単文 EXPLAIN の既存経路には、B162/B163 に必要なバッチ文脈が無い。単文の通常 EXPLAIN 契約は変更しない。

### 12.3 CLI

複文 `--dry-run` は `buildBatchExplainPlans()` を使用する。

- `src/cli/index.ts:2289-2305`

metadata の必要性と B155 静的経路は CLI 側で分岐している。

- `src/cli/index.ts:1867-1871,2034-2036`
- `src/cli/index.ts:2291-2295`

B162/B163 の静的処理は `resolveMetadata=false` でも動作しなければならない。

### 12.4 plugin

plugin が同じ batch EXPLAIN engine を利用する限り、表示・診断を一致させる。plugin 独自の default binding、temp schema 推論、エラー置換を追加しない。

---

## 13. dry-run と静的経路

### 13.1 B162

B162 の逐語 SQLは APP metadata を必要としない。

CLI `--dry-run` では:

- API 0回
- exit 0
- DATE 系列
- 13行の default-bound estimate
- 外部注入で変わり得る注記

を表示する。

### 13.2 B163

B163 の temp schema `年月, 製品名` は明示 SELECT 列から導出できる。

したがって `resolveMetadata=false` の静的 dry-run でも、少なくとも後続 GROUP BY の source schema と group key identity を解決できるようにする。

schema ledger の構築を `resolveMetadata=true` の `buildExplainWhereAnalysis()` 内だけへ置いてはならない。そうすると B155 静的経路で再び schema が消える。

### 13.3 B155/B157/B161 非回帰

次を維持する。

1. B155 の静的 typed pushdown 経路は、引き続き API 0回で candidate を表示する。
2. B157 の通常複文 dry-run は、必要な文について metadata 解決を失わない。
3. B161 の CTE 内物理 source metadata 要否検出を変更しない。
4. B162/B163 を含む混在バッチでも、CLI の診断ブロックと計画本文が異なる metadata 前提を使わない。
5. B163 の静的 schema ledger を理由に、全バッチの `resolveMetadata` を一律 false または一律 true に変更しない。
6. records API は全経路で0回とする。

---

## 14. 実行・validate の不変条件

### 14.1 B162

変更しないもの:

- `ksql_validate` は変数依存の系列 type、step、10,000行上限を実行へ保留する。
- 実行は外部注入値を優先する。
- 未注入時は既定値を実行時に1回評価する。
- 実行時の実値に対し、既存 `GENERATE_SERIES` 検証を行う。
- 起票 SQL の実行結果は13行。

### 14.2 B163

変更しないもの:

- `CREATE TEMP TABLE AS SELECT` は実行時に行と schema を実体化する。
- temp table row limit
- GROUP BY の B65/B148検査
- GROUP BY の実行結果
- 起票 SQL の temp 104行、後続 GROUP BY 8行
- `ksql_validate` の結果

EXPLAIN 用の空行 static relation を、実行時 temp table map へ混入させてはならない。

---

## 15. 受入条件

### 15.1 B162 必須受入

次の逐語 SQLを使用する。

```sql
DECLARE @m_start = '2025-08-01';
DECLARE @m_stop  = '2026-08-01';
WITH 月系列 AS (GENERATE_SERIES(@m_start, @m_stop, '1 month') AS 月)
SELECT 月 FROM 月系列
```

受入条件:

1. engine batch EXPLAIN が成功する。
2. MCP `ksql_explain` が成功する。
3. CLI `--dry-run` が成功する。
4. plugin EXPLAIN が同じ意味を表示する。
5. `ArgumentError: GENERATE_SERIES の日付引数には実在する...` を出さない。
6. series type が DATE と表示される。
7. rows が13の default-bound estimate と表示される。
8. `DECLARE` 既定値に基づく条件付き計画であることを表示する。
9. 外部注入で変わり得ることを表示する。
10. start/stop の実値を新たに表示しない。
11. records API は0回。
12. `ksql_validate` は従来どおりOK。
13. `ksql_query` は従来どおり13行。

### 15.2 B162 deferred 受入

少なくとも次を含む。

```sql
SET @start = TODAY();
WITH s AS (GENERATE_SERIES(@start, '2026-08-01', '1 month') AS 月)
SELECT 月 FROM s
```

受入条件:

1. EXPLAIN がプレースホルダーを日付として検査しない。
2. `series type: deferred (variable)` を表示する。
3. `rows: runtime` を表示する。
4. records API は0回。
5. SET を評価しない。
6. 実行時の既存検証は不変。

### 15.3 B162 波及非回帰

1. `DECLARE @phase='受注'; SELECT ... WHERE 状態=@phase` は従来どおり placeholder/candidate 表示。
2. 外部注入値が計画本文へ出ない。
3. 選択系 IN の placeholder 表示が不変。
4. 算術 placeholder の `raw=@name` 契約が不変。
5. LIMIT/OFFSET へ変数を新たに許可しない。
6. WHERE、HAVING、CHECK、CASE、KLIKE、SELECT列、UPDATE SET、ASSERT の実行意味論を変えない。

### 15.4 B163 必須受入

次の逐語 SQLを使用する。

```sql
CREATE TEMP TABLE #t AS
WITH s AS (GENERATE_SERIES('2025-08-01', '2026-08-01', '1 month') AS 月)
SELECT DATE_FORMAT(s.月, '%Y-%m') AS 年月, m.製品名 AS 製品名
FROM s CROSS JOIN APP4229 AS m;

SELECT 製品名, COUNT(*) AS 月数 FROM #t GROUP BY 製品名
```

受入条件:

1. engine batch EXPLAIN が成功する。
2. MCP `ksql_explain` が成功する。
3. CLI `--dry-run` が成功する。
4. plugin EXPLAIN が同じ意味を表示する。
5. `InternalError` を出さない。
6. statement 1 の static schema に `年月, 製品名` を表示する。
7. statement 2 に `source: temp table #t (schema from statement 1)` 相当を表示する。
8. `製品名` の group key を既存 plain GROUP BY planner で解決する。
9. 行数は runtime と表示する。
10. 一時テーブルを実体化しない。
11. records API は0回。
12. `ksql_validate` は従来どおりOK。
13. `ksql_query` は従来どおり temp 104行、GROUP BY 8行。

### 15.5 B163 schema error 受入

1. 静的 schema に存在しない GROUP BY 列は、既存の利用者向け unknown-field `ArgumentError` になる。
2. 同名列が複数 source に存在する場合は既存 ambiguity エラーになる。
3. schema を安全に導出できない形は deferred になり、空 schema として確定しない。
4. `InternalError: materialized schema ...` は公開面に出ない。
5. B148 の非 grouping dependency 検査が temp table source でも維持される。

### 15.6 DROP と複数 temp table

1. `DROP TEMP TABLE #t` 後に、その static schema を後続文へ渡さない。
2. 複数 temp table の schema と producer statement index を混同しない。
3. temp table から別 temp tableを作る場合、静的に導出できる範囲で schema を連鎖伝播する。
4. 伝播途中で不明になった schema は以後 deferred とし、推測で復元しない。

### 15.7 B155/B157/B161

1. B155 の静的 CTE→APP JOIN dry-run がAPI 0回。
2. B155 の `pushdown candidate` 表示が不変。
3. B157 の通常複文 dry-run が必要な metadata 解決を維持。
4. B157 の診断と計画本文が一致。
5. B161 の CTE物理 source metadata 要否検出が不変。
6. B162/B163との混在バッチでも上記がすべて成立。
7. 既存 B149、B150、B158 の系列・JOIN・CROSS JOIN EXPLAIN を非回帰とする。

---

## 16. テスト配置

最低限、次を追加する。

### 16.1 engine unit / integration

- B162 逐語 SQL
- B162 deferred SQL
- B162 同一変数を系列と WHERE の両方で使用する形
- B162 外部注入値非表示
- B162 数値 DECLARE 系列
- B162 非リテラル既定値
- B163 逐語 SQL
- B163 unknown group key
- B163 deferred schema
- B163 DROP 後
- B163 temp→temp schema 伝播
- B148 dependency violation on temp source

### 16.2 CLI e2e

- B162 `--dry-run` exit 0、API 0回
- B163 `--dry-run` exit 0、records API 0回
- `resolveMetadata=false` の B163 static schema
- B155/B157/B161 既存ケースとの混在バッチ

### 16.3 MCP / engine library

- batch EXPLAIN の構造化結果
- 表示行の意味一致
- records API 0回
- 外部注入値非表示

### 16.4 plugin

- production bundle に B162/B163 の分類・表示が含まれること
- ブラウザ EXPLAIN で起票2件が成功すること
- 実行結果が従来値のままであること

---

## 17. Claude 実測項目

実装後、Claude は机上確認だけでなく次を実測する。

### 17.1 B162

1. 修正前:
   - 逐語 SQLが起票どおりの日付 `ArgumentError` になること。
2. 修正後:
   - engine EXPLAIN
   - CLI `--dry-run`
   - MCP `ksql_explain`
   - plugin EXPLAIN
3. 全面で:
   - DATE
   - rows 13
   - default-bound 注記
   - injection may differ 注記
   - records API 0回
4. `ksql_validate` がOK。
5. `ksql_query` が13行。
6. 外部注入を指定しても値が表示されない。
7. SET/TODAY形が deferred になる。
8. 同じ変数を WHERE に使っても WHERE が従来どおり candidate になる。

### 17.2 B163

1. 修正前:
   - 逐語バッチが起票どおりの `InternalError` になること。
2. 修正後:
   - engine EXPLAIN
   - CLI `--dry-run`
   - MCP `ksql_explain`
   - plugin EXPLAIN
3. 全面で:
   - `年月, 製品名` schema
   - statement 1由来
   - group key `製品名` 解決
   - runtime rows
   - records API 0回
4. `ksql_validate` がOK。
5. `ksql_query` がtemp 104行、GROUP BY 8行。
6. unknown列が利用者向け `ArgumentError` になる。
7. 推論不能schemaがdeferredになる。
8. `InternalError` が公開出力に含まれない。

### 17.3 静的経路

1. B155のAPI 0回。
2. B157のmetadataあり複文表示。
3. B161のCTE metadata要否検出。
4. B162/B163との混在バッチ。
5. CLIの診断ブロックと計画本文の一致。
6. records API、cursor API、temp実体化がいずれも0回。

---

## 18. Phase と完了条件

### Phase 1

B162:

- 系列引数限定のリテラル `DECLARE` default binding
- deferred fallback
- 条件付き計画表示
- 外部注入値非表示
- 他の変数用途は非変更

B163:

- static temp schema ledger
- 明示 SELECT 列のschema伝播
- ordinary GROUP BY plannerへの接続
- deferred fallback
- `InternalError` 公開禁止
- dry-run静的経路対応

Phase 1 の完了条件は、§15の全受入と§17の実測完了である。

### Phase 2候補

- `NOW()` / `TODAY()` 等の非リテラル DECLARE defaultを、系列EXPLAINで評価するか
- UNION/wildcard/IMPORT等の静的schema推論拡張
- temp `columnMeta` の完全な静的伝播
- schema由来のORDER BY、window、typed predicate計画拡張

Phase 2はR1の完了条件に含めない。

### 別仕様

- 外部注入値を使ったEXPLAIN
- WHERE/IN/KLIKE/SELECT/ASSERT/DML等への汎用default binding
- 注入値を秘匿したままrows/typeだけへ反映する情報漏えい評価
- EXPLAIN専用パラメーター契約の追加

---

## 19. 最終決定

1. B162 は **案Aの系列引数限定適用＋案B fallback** とする。
2. B162 で全変数用途を実値束縛へ変更しない。
3. B162 の外部注入値は使用・表示しない。
4. B163 は **案AをPhase 1で実装**する。
5. B163 の推論不能形には **案B deferred** を使う。
6. B163 は同じPhaseで **案C相当の公開診断防御**を含め、`InternalError` を禁止する。
7. B163 は既存の relation schema 推論、materialized columns入力、plain GROUP BY planner、B148依存検査を再利用する。
8. `inferSelectColumnMeta` は型metadataの任意拡張には再利用できるが、B163 Phase 1の列名schema伝播の必須部品にはしない。
9. 実行・validate・records API 0回・一時テーブル非実体化の契約は変更しない。
10. B155/B157/B161の静的・metadata経路を非回帰条件とする。