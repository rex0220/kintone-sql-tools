# B149 `GENERATE_SERIES` — 数値・日付系列の生成 仕様（R1）

- ステータス: **R1 正本**
- 対象: kSQL v3.58.0
- 起票: [B149](ksql_b149_generate_series_issue.md)
- 関連: [B134](ksql_b134_series_generation_issue.md)
- 初版: 2026-08-07
- 参照挙動: PostgreSQL `generate_series`
- Phase 1: **整数系列・`DATE` 系列**
- 旧版: なし

---

## 0. R1 の位置づけ

B149 は、kSQL 内で入力レコードを必要とせず、整数または日付の系列を生成する機能である。

価値の中心は、系列そのものの表示ではなく、系列を `LEFT JOIN` の左辺に置き、元アプリに存在しない日を `0` として補うことにある。

```sql
WITH 日付系列 AS (
  GENERATE_SERIES('2026-08-01', '2026-08-03', '1 day') AS 日付
),
日別 AS (
  SELECT 日付, SUM(金額) AS 合計
  FROM APP100
  GROUP BY 日付
)
SELECT s.日付,
       CASE WHEN d.合計 = '' THEN 0 ELSE d.合計 END AS 合計
FROM 日付系列 AS s
LEFT JOIN 日別 AS d ON s.日付 = d.日付
ORDER BY s.日付
```

Phase 1 では PostgreSQL 互換名 `GENERATE_SERIES` を採用するが、既存の `FROM` 文法は拡張しない。`DESCRIBE` / `SHOW APPS` と同じく、`WITH` 内で実体化される文 CTE とする。

---

## 1. 根拠と確定範囲

### 1.1 コードから静的に確定していること

| 事実 | 根拠 |
|---|---|
| `WITH` の CTE 本体には現在 `SELECT` / `UNION` / `SHOW APPS` / `DESCRIBE` を格納できる | `src/types/ast.ts:180-190` |
| parser は CTE 本体の先頭を見て `SHOW` / `DESCRIBE` と通常の SELECT 系を分岐する | `src/parser/parser.ts:1233-1258` |
| CTE 名は宣言後に登録され、後続 CTE と最終 query の `FROM` / `JOIN` から参照できる | `src/parser/parser.ts:1251-1257,2435-2459` |
| CTE は宣言順に実行され、行・列・列メタをキャッシュした後、最終 query が実行される | `src/execute.ts:5213-5259` |
| CTE を `FROM` または `JOIN` から参照する SELECT は、実体化済み行を使う実行経路を持つ | `src/execute.ts:5262-5327` |
| 実体化テーブルは、行が 0 件でも列定義と列メタを保持できる | `src/execute.ts:402-425` |
| CTE の列メタは後段の比較・ソートへ渡される | `src/execute.ts:2488-2517,4578-4628` |
| 値参照ウィンドウの出力メタは引数の列メタを引き継ぐ | `src/execute.ts:4541-4544` |
| NUMBER の比較意味は数値、DATE の比較意味は文字列である | `src/core/fieldSemantics.ts:22-46` |
| 正規化された `YYYY-MM-DD` の DATE は文字列順と日付順が一致する | `docs/ksql_language_reference.md:917-923` |
| 既存の日付処理には実在日付の検証処理と UTC 基準の日付加算処理がある | `src/engine/evalFunc.ts:499-517,607-634` |
| 一時テーブルの既定実体化上限は 10,000 行であり、超過時は打ち切らずエラーにする | `src/execute.ts:1385-1396,1828-1842` |
| `CREATE TEMP TABLE ... AS WITH ...` は既存構文である | `src/types/ast.ts:96-101`, `src/parser/parser.ts:603-619` |
| `INSERT INTO ... SELECT` の source は現行 AST 上 `SelectStatement` であり、`WITH` 自体は直接保持しない | `src/types/ast.ts:849-859` |
| FROM なし `SELECT` は専用の予約 source を持ち、フィールド参照等を制限して実行できる | `src/types/ast.ts:12-13`, `src/execute.ts:3412-3497` |
| 空文字は算術では 0 だが、比較では数値 0 と等しくない | `docs/ksql_language_reference.md:316-318,520-532` |

### 1.2 起票・依頼で確定していること

次は再評価しない。

- 名称は `GENERATE_SERIES`
- PostgreSQL の境界規則を基準にする
- `stop` は、系列値がちょうど一致した場合だけ含む
- step の向きと範囲の向きが逆ならエラーではなく 0 行
- step が 0 ならエラー
- kSQL に SQL NULL は導入しない
- 空文字、非数値、非日付は `ArgumentError`
- Phase 1 は整数と `DATE`
- 小数、`DATETIME`、`TIME`、`FROM` 直置きは Phase 1 に含めない
- `INTERVAL` 型は導入しない
- 行数上限を必須とする
- `LEFT JOIN` による日付の 0 埋めを受入条件に含める

### 1.3 実行しないと確定できないこと

次はコード上の経路が存在することまでは確認できるが、B149 の構文追加後に実測が必要である。

- 文 CTE として追加した `GENERATE_SERIES` が、既存の複数 CTE parser と競合しないこと
- 0 行の生成結果でも、後段が列名と型メタを失わないこと
- 生成 CTE を左辺にした CTE 間 `LEFT JOIN` が完全な SQL のまま動くこと
- DATE メタが JOIN、通常 `ORDER BY`、`LAG` / `LEAD` の各段で維持されること
- `EXPLAIN WITH ...` の表示とレコード API 呼び出し回数
- `CREATE TEMP TABLE ... AS WITH ...` を経由した後段参照
- CLI、MCP、プラグイン、ライブラリで同じ公開結果になること

これらは §15 の未確認事項として Claude が実測する。

---

## 2. 構文

### 2.1 完全文法

```text
<with-statement> ::=
  WITH <cte-definition> [, <cte-definition> ...]
  <select-or-union>

<cte-definition> ::=
  <cte-name> AS ( <cte-body> )

<cte-body> ::=
    <select-or-union>
  | SHOW APPS
  | DESCRIBE <app-reference>
  | <generate-series-statement>

<generate-series-statement> ::=
  GENERATE_SERIES (
    <series-start> ,
    <series-stop>
    [ , <series-step> ]
  )
  [ AS <column-alias> ]

<series-start> ::= <number-literal> | <string-literal> | <batch-variable>
<series-stop>  ::= <number-literal> | <string-literal> | <batch-variable>
<series-step>  ::= <number-literal> | <string-literal> | <batch-variable>
```

`GENERATE_SERIES` は大文字小文字を区別しない。

### 2.2 許可する位置

Phase 1 で `GENERATE_SERIES` 文を直接書ける位置は、`WITH` の CTE 本体だけである。

```sql
WITH s AS (
  GENERATE_SERIES(1, 5)
)
SELECT generate_series
FROM s
```

次は Phase 1 では許可しない。

```sql
SELECT *
FROM GENERATE_SERIES(1, 5)
```

```sql
GENERATE_SERIES(1, 5)
```

```sql
SELECT GENERATE_SERIES(1, 5)
```

### 2.3 複数 CTE

通常の CTE と同じく、複数定義と併用できる。

```sql
WITH s AS (
  GENERATE_SERIES(1, 3) AS n
),
a AS (
  SELECT n, n * 10 AS value
  FROM s
)
SELECT n, value
FROM a
ORDER BY n
```

後続 CTEは、それ以前に宣言された生成 CTEを参照できる。前方参照および循環参照は導入しない。

### 2.4 引数に書ける値

Phase 1 の引数は次に限定する。

- 数値リテラル
- 文字列リテラル
- バッチ内で定義済みのスカラー変数

フィールド参照、集計関数、ウィンドウ関数、スカラーサブクエリ、`CASE`、配列、任意の関数呼び出しは受け付けない。

バッチ変数は、その文を実行する前に実値へ解決する。未定義変数、配列変数、相対日付変数は既存の変数エラー規則に従う。

```sql
DECLARE @開始 DEFAULT 1;
DECLARE @終了 DEFAULT 5;

WITH s AS (
  GENERATE_SERIES(@開始, @終了) AS n
)
SELECT n
FROM s;
```

---

## 3. 系列型の決定

### 3.1 整数系列

次の条件をすべて満たす場合は整数系列とする。

- `start` と `stop` が数値リテラルである、または変数解決後の値が10進整数として解釈できる
- 明示 step がある場合、step も数値リテラルである、または変数解決後の値が10進整数として解釈できる
- すべて JavaScript の安全整数範囲に入る
- 指数表記を解決した値も整数である

許可例:

```sql
WITH s AS (GENERATE_SERIES(-20, 20, 10))
SELECT generate_series FROM s
```

```sql
WITH s AS (GENERATE_SERIES(1e2, 5e2, 1e2))
SELECT generate_series FROM s
```

拒否例:

```sql
WITH s AS (GENERATE_SERIES(0.1, 0.5, 0.1))
SELECT generate_series FROM s
```

```sql
WITH s AS (GENERATE_SERIES(1, 5, 0.5))
SELECT generate_series FROM s
```

文字列リテラル `'1'` と `'5'` を整数引数として暗黙変換しない。バッチ変数は外部注入値が文字列で渡される既存契約があるため、変数解決後に限り正規の10進整数文字列を受理する。

### 3.2 DATE 系列

次の条件をすべて満たす場合は DATE 系列とする。

- `start` と `stop` が `YYYY-MM-DD` 形式の文字列である
- 暦上実在する日付である
- 年は `0001` から `9999`
- 明示 step がある場合、§3.3 の日付 step 形式である

時刻、タイムゾーン、先頭10文字だけが日付に見える値は受理しない。

```sql
WITH d AS (
  GENERATE_SERIES('2026-08-01', '2026-08-05', '1 day') AS 日付
)
SELECT 日付
FROM d
```

次は `DATETIME` であるため拒否する。

```sql
WITH d AS (
  GENERATE_SERIES(
    '2026-08-01T00:00:00Z',
    '2026-08-03T00:00:00Z',
    '1 day'
  )
)
SELECT generate_series
FROM d
```

### 3.3 DATE step

Phase 1 の DATE step は文字列で表し、次の形式だけを受理する。

```text
<date-step> ::= <signed-nonzero-integer> <space> ("day" | "days")
```

例:

```text
'1 day'
'2 days'
'-1 day'
'-14 days'
```

`day` / `days` は大文字小文字を区別しない。整数と単位の間には1文字以上の空白を必要とし、前後の空白は無視してよい。

Phase 1 で対応する単位は `day` / `days` だけである。

- `week` は `7 days` の倍数で表現できるため新しい単位として入れない
- `month` / `year` は月末丸めと反復時の基準日の規則を別途決める必要があるため入れない
- 時、分、秒は `DATETIME` / `TIME` 系列と同時に検討する

`'0 day'` / `'0 days'` は、形式不正ではなく step 0 として診断する。

### 3.4 型不一致

`start` と `stop` は同じ系列型でなければならない。

次はすべて `ArgumentError` とする。

```sql
WITH s AS (
  GENERATE_SERIES(1, '2026-08-03')
)
SELECT generate_series FROM s
```

```sql
WITH s AS (
  GENERATE_SERIES('2026-08-01', '2026-08-03', 1)
)
SELECT generate_series FROM s
```

```sql
WITH s AS (
  GENERATE_SERIES(1, 5, '1 day')
)
SELECT generate_series FROM s
```

---

## 4. 整数系列の生成規則

### 4.1 基本規則

整数系列は次の値を順に生成する。

```text
start
start + step
start + 2 * step
...
```

生成値が step の方向で `stop` を超える直前に停止する。

- step 正: 生成値が `stop` 以下である間だけ生成
- step 負: 生成値が `stop` 以上である間だけ生成
- `stop` にちょうど一致する値は含む
- `stop` をまたぐ値は含まない

計算途中で安全整数範囲を外れる系列は `ArgumentError` とする。丸めた値、`Infinity`、`NaN` を生成してはならない。

### 4.2 step 省略

整数系列で step を省略した場合は `1` とする。

```sql
WITH s AS (GENERATE_SERIES(1, 5))
SELECT generate_series FROM s
```

結果:

```text
1
2
3
4
5
```

`start > stop` で step を省略した場合は、既定 step が正なので 0 行となる。降順を生成したい場合は負 step を明示する。

### 4.3 方向の4象限

| start と stop | step | 結果 |
|---|---:|---|
| `start < stop` | 正 | 昇順系列 |
| `start < stop` | 負 | 0 行 |
| `start > stop` | 正 | 0 行 |
| `start > stop` | 負 | 降順系列 |

向きが逆であること自体はエラーではない。

### 4.4 start と stop が等しい場合

step が 0 でなければ、step の正負にかかわらず `start` の1行を返す。

```sql
WITH s AS (GENERATE_SERIES(7, 7, 3))
SELECT generate_series FROM s
```

```text
7
```

```sql
WITH s AS (GENERATE_SERIES(7, 7, -3))
SELECT generate_series FROM s
```

```text
7
```

### 4.5 境界値

| 呼出し | 結果 |
|---|---|
| `GENERATE_SERIES(8, 28, 10)` | `8, 18, 28` |
| `GENERATE_SERIES(7, 28, 10)` | `7, 17, 27` |
| `GENERATE_SERIES(28, 8, -10)` | `28, 18, 8` |
| `GENERATE_SERIES(35, 4, -10)` | `35, 25, 15, 5` |
| `GENERATE_SERIES(2, 100, 49)` | `2, 51, 100` |
| `GENERATE_SERIES(100, 2, -49)` | `100, 51, 2` |

桁数の異なる値を含む受入条件を必須とし、文字列比較でも偶然正答するテストだけにしない。

---

## 5. DATE 系列の生成規則

### 5.1 基本規則

DATE 系列は、日付に step の日数を加算して生成する。

- タイムゾーン変換を行わない
- 日付値は常に `YYYY-MM-DD`
- 日単位の暦計算とする
- 月をまたいでも日数をそのまま加算する
- うるう年を暦どおり扱う
- `stop` の包含と方向規則は整数系列と同じ

```sql
WITH d AS (
  GENERATE_SERIES('2026-02-27', '2026-03-02', '1 day') AS 日付
)
SELECT 日付 FROM d
```

結果:

```text
2026-02-27
2026-02-28
2026-03-01
2026-03-02
```

### 5.2 step 省略

DATE 系列で step を省略した場合は `'1 day'` とする。

```sql
WITH d AS (
  GENERATE_SERIES('2026-08-01', '2026-08-03')
)
SELECT generate_series FROM d
```

結果:

```text
2026-08-01
2026-08-02
2026-08-03
```

降順は負 step を明示する。

```sql
WITH d AS (
  GENERATE_SERIES('2026-08-03', '2026-08-01', '-1 day')
)
SELECT generate_series FROM d
```

### 5.3 DATE の4象限

| start と stop | step | 結果 |
|---|---:|---|
| `start < stop` | 正の日数 | 昇順系列 |
| `start < stop` | 負の日数 | 0 行 |
| `start > stop` | 正の日数 | 0 行 |
| `start > stop` | 負の日数 | 降順系列 |

### 5.4 DATE 境界値

| 呼出し | 結果 |
|---|---|
| `('2026-08-01', '2026-08-05', '2 days')` | `08-01, 08-03, 08-05` |
| `('2026-08-01', '2026-08-06', '2 days')` | `08-01, 08-03, 08-05` |
| `('2026-08-10', '2026-08-04', '-3 days')` | `08-10, 08-07, 08-04` |
| `('2026-08-10', '2026-08-03', '-3 days')` | `08-10, 08-07, 08-04` |
| `('2024-02-28', '2024-03-01', '1 day')` | `02-28, 02-29, 03-01` |
| `('2025-02-28', '2025-03-01', '1 day')` | `02-28, 03-01` |

---

## 6. 生成列

### 6.1 既定列名

既定の列名は、小文字の次で固定する。

```text
generate_series
```

関数表記が `GENERATE_SERIES`、`Generate_Series` 等であっても既定列名は変えない。

```sql
WITH s AS (
  GENERATE_SERIES(1, 3)
)
SELECT generate_series
FROM s
```

### 6.2 `AS` による改名

生成文の末尾に `AS <column-alias>` を指定できる。

```sql
WITH s AS (
  GENERATE_SERIES(1, 3) AS n
)
SELECT n
FROM s
```

`AS` は列別名であり、CTE 名とは別である。

```sql
WITH 日付系列 AS (
  GENERATE_SERIES('2026-08-01', '2026-08-03') AS 日付
)
SELECT 日付系列.日付
FROM 日付系列
```

暗黙 alias は導入しない。改名する場合は `AS` を必須とする。

### 6.3 公開値

既存の SELECT 結果規則に合わせ、公開 `rows` 内の値は文字列とする。

整数系列:

```json
{
  "type": "SELECT",
  "columns": ["n"],
  "rows": [
    { "n": "2" },
    { "n": "10" },
    { "n": "100" }
  ],
  "rowCount": 3
}
```

DATE 系列:

```json
{
  "type": "SELECT",
  "columns": ["日付"],
  "rows": [
    { "日付": "2026-08-01" },
    { "日付": "2026-08-02" }
  ],
  "rowCount": 2
}
```

### 6.4 型メタ

整数生成列は次の意味型を持つ。

- 数値比較
- 数値ソート
- NUMBER 相当
- `2, 10, 100` は `2, 10, 100` の順

DATE 生成列は次の意味型を持つ。

- DATE 相当
- 正規化済み `YYYY-MM-DD`
- 日付順と一致する文字列比較
- `ORDER BY` で暦順を維持

値の見た目から後段で型を推測してはならない。生成時に確定した列メタを CTE、一時テーブル、JOIN、後続 CTEへ渡す。

### 6.5 `LAG` / `LEAD`

生成列を `LAG` / `LEAD` の引数にした場合、既存の値参照ウィンドウと同様に引数の型メタを引き継ぐ。

- 整数生成列の `LAG` / `LEAD` 出力は数値メタ
- DATE 生成列の `LAG` / `LEAD` 出力は DATE メタ
- CTE の次段でも同じ比較・ソート規則を維持

端の行で生じる空文字は既存の `LAG` / `LEAD` 契約に従い、系列引数のエラーとは扱わない。

---

## 7. 負 step

Phase 1 で負 step を許可する。

理由は次のとおり。

1. PostgreSQL の基本挙動に含まれる
2. 正方向と逆方向の境界規則を対称にできる
3. 降順の日付範囲を追加構文なしで表せる
4. 負 step を拒否すると、`start > stop` の有用な系列を生成できない
5. 実装上は step の符号によって継続条件を切り替えればよく、小数や月末規則のような新しい精度問題を持ち込まない

符号と範囲の向きが逆の場合は 0 行であり、診断を出さない。step 0 だけは必ずエラーにする。

---

## 8. 行数上限

### 8.1 上限値

1つの `WITH` 文内で `GENERATE_SERIES` が生成できる行数の合計は、既定で **10,000 行**とする。

根拠は、既存の一時テーブルが無制限の実体化を避けるために採用している既定上限 `TEMP_TABLE_MAX_ROWS = 10,000` である。

B149 は無から行を生成する初の機能であり、物理アプリの取得件数制限に依存してはならない。

### 8.2 適用単位

上限は生成 CTEごとではなく、同一 `WITH` 文に含まれる全生成 CTEの合計に適用する。

```sql
WITH a AS (
  GENERATE_SERIES(1, 6000) AS n
),
b AS (
  GENERATE_SERIES(1, 5000) AS n
)
SELECT n FROM a
UNION ALL
SELECT n FROM b
```

合計 11,000 行となるためエラーにする。

同じ生成 CTEを複数回参照しても再生成とは数えない。生成 CTEは1回だけ実体化する。

### 8.3 上限判定

可能な生成件数を、全行を作る前に算出する。

- 0 行になる方向なら件数は 0
- `start = stop` なら件数は 1
- 境界へちょうど到達する場合を含める
- 整数差の計算で浮動小数点丸めを使わない
- 上限超過を `LIMIT`、`WHERE`、後段集計によって免除しない

次もエラーである。

```sql
WITH s AS (
  GENERATE_SERIES(1, 1000000)
)
SELECT generate_series
FROM s
LIMIT 1
```

生成 CTEの要求範囲自体が上限を超えているためである。

### 8.4 既存上限との関係

| 上限 | 対象 | B149 との関係 |
|---|---|---|
| B149 生成上限 10,000 行 | 同一 `WITH` 文内の生成行合計 | 常に適用 |
| `tempTableMaxRows` | バッチ一時テーブル1個の実体化結果 | `CREATE TEMP TABLE ... AS WITH ...` では別途適用 |
| SELECT の `maxRecords` | 物理アプリ等の取得・結果経路 | B149 上限の代替にはしない |
| DML 行数上限 | INSERT / UPDATE 等の書込対象 | DML実行時に別途適用 |

`CREATE TEMP TABLE ... AS WITH ...` では、B149 の10,000行ガードを通過した後、一時テーブル側の上限も満たさなければならない。

### 8.5 超過時

超過時は打ち切った部分結果を返さず、`ArgumentError` とする。

```text
ArgumentError: GENERATE_SERIES の生成件数 10001 行が上限 10000 行を超えています。
```

複数生成 CTEの合計超過時:

```text
ArgumentError: この WITH 文の GENERATE_SERIES 生成件数合計 11000 行が上限 10000 行を超えています。
```

---

## 9. 適用単位

### 9.1 直接配置

| 位置 | Phase 1 |
|---|---|
| `WITH name AS (GENERATE_SERIES(...))` | 可 |
| トップレベルの `GENERATE_SERIES(...)` 文 | 不可 |
| `FROM GENERATE_SERIES(...)` | 不可 |
| `JOIN GENERATE_SERIES(...)` | 不可 |
| SELECT 列のスカラー関数 | 不可 |
| `UNION` arm に直接記述 | 不可 |
| スカラーサブクエリ内に直接記述 | 不可 |

### 9.2 生成 CTE の参照先

実体化された生成 CTEは通常の CTE と同じ relation として扱う。

| 参照先 | Phase 1 |
|---|---|
| `WITH` の最終 SELECT | 可 |
| 後続 CTE の `FROM` | 可 |
| 後続 CTE の `JOIN` | 可 |
| 最終 `UNION` / `UNION ALL` の各 arm | 可 |
| 最終 query 内のサブクエリ | 可 |
| `CREATE TEMP TABLE ... AS WITH ...` | 可 |
| 一時テーブルを介した後続 `INSERT ... SELECT` | 可 |
| `INSERT ... SELECT` の中へ `WITH` を直接埋め込む | 不可 |
| `UPDATE ... FROM` の直接 CTE source | 既存構文どおり不可 |
| `UPDATE ... FROM #temp` | 既存の一時テーブル規則に従う |

### 9.3 INSERT への使用

現行の `INSERT INTO ... SELECT` は `WITH` を直接 source にできないため、Phase 1 でその文法を同時拡張しない。

必要な場合はバッチ一時テーブルを介する。

```sql
CREATE TEMP TABLE #days AS
WITH d AS (
  GENERATE_SERIES('2026-08-01', '2026-08-03') AS 日付
)
SELECT 日付 FROM d;

INSERT INTO APP200 (日付)
SELECT 日付
FROM #days;
```

この場合、INSERT の確認、検証、書込上限、レコード API 呼び出しは既存 DML 契約に従う。`GENERATE_SERIES` 自体が書込 API を呼ぶことはない。

---

## 10. エラー契約

### 10.1 分類

| 条件 | 例外 |
|---|---|
| 構文不正、許可されない配置 | `ParseError` |
| 引数個数、値、型、step、上限の問題 | `ArgumentError` |
| 未定義バッチ変数 | 既存の変数エラー |
| 実行キャンセル | 既存のキャンセル規則 |

人間向け本文には AST 名、実行モード名、内部 reason、関数名等の実装語を出さない。

### 10.2 引数個数

```text
ArgumentError: GENERATE_SERIES は start、stop と省略可能な step の2個または3個の引数を受け付けます。
```

### 10.3 step 0

整数:

```text
ArgumentError: GENERATE_SERIES の step に 0 は指定できません。
```

DATE:

```text
ArgumentError: GENERATE_SERIES の日付 step に 0 day は指定できません。
```

向きが逆で 0 行になる範囲でも、step 0 の検査を先に行う。

### 10.4 空文字

```text
ArgumentError: GENERATE_SERIES の start に空文字は指定できません。
```

```text
ArgumentError: GENERATE_SERIES の stop に空文字は指定できません。
```

```text
ArgumentError: GENERATE_SERIES の step に空文字は指定できません。
```

空文字を算術の 0 に変換してはならない。

### 10.5 非数値・小数

```text
ArgumentError: GENERATE_SERIES の数値系列は整数の start、stop、step のみを受け付けます。
```

対象例:

```sql
WITH s AS (GENERATE_SERIES(1, 5, 0.5))
SELECT generate_series FROM s
```

```sql
WITH s AS (GENERATE_SERIES(1.2, 5.2))
SELECT generate_series FROM s
```

```sql
DECLARE @step DEFAULT 'abc';
WITH s AS (GENERATE_SERIES(1, 5, @step))
SELECT generate_series FROM s;
```

### 10.6 非日付・不正日付

```text
ArgumentError: GENERATE_SERIES の日付引数には実在する YYYY-MM-DD 形式の DATE を指定してください。
```

対象例:

```text
''
'2026-2-1'
'2026-02-30'
'0000-01-01'
'10000-01-01'
'abc'
```

### 10.7 型不一致

```text
ArgumentError: GENERATE_SERIES の start と stop は、両方を整数または両方を DATE にしてください。
```

step の型不一致:

```text
ArgumentError: GENERATE_SERIES の step が系列の型と一致しません。整数系列には整数、DATE 系列には day 単位を指定してください。
```

### 10.8 未対応の日付単位

```text
ArgumentError: GENERATE_SERIES の日付 step は day または days のみ対応しています。
```

対象:

```text
'1 week'
'1 month'
'1 year'
'1 hour'
```

### 10.9 DATETIME / TIME

```text
ArgumentError: GENERATE_SERIES は Phase 1 では整数と DATE のみ対応しています。DATETIME と TIME は使用できません。
```

### 10.10 `FROM` 直置き

```text
ParseError: GENERATE_SERIES は WITH の CTE 本体に書いてください。例: WITH s AS (GENERATE_SERIES(1, 5)) SELECT generate_series FROM s
```

この修正例自体が実際に parse・実行できることを受入条件にする。

### 10.11 診断前の副作用

引数、型、step、生成上限を静的または変数解決後に確定できる場合は、レコード APIを呼ぶ前にエラーにする。

エラーになる生成 CTEが、同じ文の後続 CTEに物理アプリ参照を持つ場合でも、その物理アプリのレコード API呼び出し回数は 0 とする。

---

## 11. `EXPLAIN`

### 11.1 基本表示

純粋な整数系列:

```sql
EXPLAIN
WITH s AS (
  GENERATE_SERIES(2, 100, 49) AS n
)
SELECT n
FROM s
ORDER BY n
```

計画には少なくとも次を表示する。

```text
[cte: s]
  source:        GENERATE_SERIES
  column:        n
  series type:   INTEGER
  start:         2
  stop:          100
  step:          49
  rows:          3
  row guard:     3 / 10000
  records API:   none
```

DATE 系列:

```text
[cte: d]
  source:        GENERATE_SERIES
  column:        日付
  series type:   DATE
  start:         2026-08-01
  stop:          2026-08-05
  step:          2 days
  rows:          3
  row guard:     3 / 10000
  records API:   none
```

表記上の空白幅は固定契約にしないが、項目と値は表示する。

### 11.2 API 契約

純粋な生成系列だけを含む `EXPLAIN` と実行は、次を呼ばない。

- レコード取得 API
- Cursor API
- レコード書込 API
- フォームフィールド取得 API
- アプリ情報取得 API

物理アプリを読む別 CTEが同じ文にある場合、その別 CTEに必要な APIだけを表示・実行する。生成 CTEを物理アプリの fetch source として数えない。

### 11.3 上限超過

生成件数が上限を超える `EXPLAIN` は、実行可能であるかのような計画を表示せず、実行と同じ `ArgumentError` にする。

---

## 12. 受入条件

### 12.1 観測方法

各受入条件は、必要に応じて次を観測する。

- 公開 SELECT 結果の `type`
- `columns`
- `rows`
- `rowCount`
- 送出された例外の種別と本文
- `getSelectColumnMeta` で公開される列メタ
- mock client のレコード API 呼び出し回数
- mock client の metadata API 呼び出し回数
- DMLを含む場合は既存の確認・書込結果

受入条件は内部関数名、AST の具体的なフィールド名、ファイル分割を要求しない。

### 12.2 整数系列 — 通るもの

#### A1: 既定 step と stop 包含

```sql
WITH s AS (
  GENERATE_SERIES(1, 5)
)
SELECT generate_series
FROM s
ORDER BY generate_series
```

期待:

```json
{
  "type": "SELECT",
  "columns": ["generate_series"],
  "rows": [
    { "generate_series": "1" },
    { "generate_series": "2" },
    { "generate_series": "3" },
    { "generate_series": "4" },
    { "generate_series": "5" }
  ],
  "rowCount": 5
}
```

レコード API呼び出し回数は 0。

#### A2: 桁違い・stop ちょうど

```sql
WITH s AS (
  GENERATE_SERIES(2, 100, 49) AS n
)
SELECT n
FROM s
ORDER BY n
```

期待値は `"2"`, `"51"`, `"100"`。文字列順の `"100"`, `"2"`, `"51"` にならない。

#### A3: 桁違い・stop をまたぐ直前

```sql
WITH s AS (
  GENERATE_SERIES(7, 28, 10) AS n
)
SELECT n FROM s
```

期待値は `"7"`, `"17"`, `"27"`。

#### A4: 負 step・stop ちょうど

```sql
WITH s AS (
  GENERATE_SERIES(100, 2, -49) AS n
)
SELECT n FROM s
```

期待値は `"100"`, `"51"`, `"2"`。

#### A5: 負 step・stop をまたぐ直前

```sql
WITH s AS (
  GENERATE_SERIES(35, 4, -10) AS n
)
SELECT n FROM s
```

期待値は `"35"`, `"25"`, `"15"`, `"5"`。

#### A6: start と stop が同じ

```sql
WITH a AS (
  GENERATE_SERIES(7, 7, 3) AS n
),
b AS (
  GENERATE_SERIES(7, 7, -3) AS n
)
SELECT n FROM a
UNION ALL
SELECT n FROM b
```

期待値は `"7"`, `"7"`。

### 12.3 方向の4象限

次の完全な SQL をそれぞれ実行する。

```sql
WITH s AS (GENERATE_SERIES(1, 5, 2) AS n)
SELECT n FROM s
```

`1, 3, 5`。

```sql
WITH s AS (GENERATE_SERIES(1, 5, -2) AS n)
SELECT n FROM s
```

0 行。`columns` は `["n"]` のまま。

```sql
WITH s AS (GENERATE_SERIES(5, 1, 2) AS n)
SELECT n FROM s
```

0 行。`columns` は `["n"]` のまま。

```sql
WITH s AS (GENERATE_SERIES(5, 1, -2) AS n)
SELECT n FROM s
```

`5, 3, 1`。

### 12.4 DATE 系列 — 通るもの

#### D1: step 省略

```sql
WITH d AS (
  GENERATE_SERIES('2026-08-01', '2026-08-03') AS 日付
)
SELECT 日付
FROM d
ORDER BY 日付
```

期待値:

```text
2026-08-01
2026-08-02
2026-08-03
```

#### D2: stop ちょうど

```sql
WITH d AS (
  GENERATE_SERIES('2026-08-01', '2026-08-05', '2 days') AS 日付
)
SELECT 日付 FROM d
```

期待値は `2026-08-01`, `2026-08-03`, `2026-08-05`。

#### D3: stop をまたぐ直前

```sql
WITH d AS (
  GENERATE_SERIES('2026-08-01', '2026-08-06', '2 days') AS 日付
)
SELECT 日付 FROM d
```

期待値は `2026-08-01`, `2026-08-03`, `2026-08-05`。

#### D4: 負 step

```sql
WITH d AS (
  GENERATE_SERIES('2026-08-10', '2026-08-03', '-3 days') AS 日付
)
SELECT 日付 FROM d
```

期待値は `2026-08-10`, `2026-08-07`, `2026-08-04`。

#### D5: うるう年

```sql
WITH d AS (
  GENERATE_SERIES('2024-02-28', '2024-03-01', '1 day') AS 日付
)
SELECT 日付 FROM d
```

期待値は `2024-02-28`, `2024-02-29`, `2024-03-01`。

### 12.5 列名・型メタ

#### M1: 既定列名

```sql
WITH s AS (
  Generate_Series(1, 1)
)
SELECT generate_series FROM s
```

`columns` は `["generate_series"]`。

#### M2: 整数ソート

```sql
WITH s AS (
  GENERATE_SERIES(2, 100, 49) AS n
)
SELECT n
FROM s
ORDER BY n DESC
```

期待値は `100, 51, 2`。

公開列メタは数値比較である。

#### M3: DATE ソート

```sql
WITH d AS (
  GENERATE_SERIES('2025-12-30', '2026-01-02') AS 日付
)
SELECT 日付
FROM d
ORDER BY 日付 DESC
```

期待値は `2026-01-02`, `2026-01-01`, `2025-12-31`, `2025-12-30`。

公開列メタは DATE 相当である。

#### M4: `LAG` の型メタ引継ぎ

```sql
WITH s AS (
  GENERATE_SERIES(2, 100, 49) AS n
),
w AS (
  SELECT n,
         LAG(n) OVER (ORDER BY n) AS 前
  FROM s
)
SELECT n, 前
FROM w
ORDER BY 前
```

`前` は数値メタを維持する。空文字を除く値は数値順になる。

#### M5: `LEAD` の DATE メタ引継ぎ

```sql
WITH d AS (
  GENERATE_SERIES('2025-12-30', '2026-01-02') AS 日付
),
w AS (
  SELECT 日付,
         LEAD(日付) OVER (ORDER BY 日付) AS 次日
  FROM d
)
SELECT 日付, 次日
FROM w
ORDER BY 次日
```

`次日` は DATE メタを維持する。

### 12.6 複数 CTE・UNION・サブクエリ

#### C1: 後続 CTE

```sql
WITH s AS (
  GENERATE_SERIES(1, 3) AS n
),
x AS (
  SELECT n, n * 10 AS value
  FROM s
)
SELECT n, value
FROM x
ORDER BY n
```

期待行は `(1,10)`, `(2,20)`, `(3,30)`。

#### C2: UNION の各 arm

```sql
WITH s AS (
  GENERATE_SERIES(1, 3) AS n
)
SELECT n FROM s WHERE n <= 2
UNION ALL
SELECT n FROM s WHERE n >= 2
```

同一 CTEを1回だけ生成し、期待値は `1, 2, 2, 3`。

#### C3: サブクエリからの参照

```sql
WITH s AS (
  GENERATE_SERIES(1, 3) AS n
)
SELECT n
FROM s
WHERE n IN (
  SELECT n
  FROM s
  WHERE n >= 2
)
ORDER BY n
```

期待値は `2, 3`。

### 12.7 `LEFT JOIN` 0 埋め

mock APP100 のレコードを次とする。

| 日付 | 金額 |
|---|---:|
| 2026-08-01 | 100 |
| 2026-08-01 | 50 |
| 2026-08-03 | 200 |

実行 SQL:

```sql
WITH 日付系列 AS (
  GENERATE_SERIES('2026-08-01', '2026-08-04', '1 day') AS 日付
),
日別 AS (
  SELECT 日付, SUM(金額) AS 合計
  FROM APP100
  GROUP BY 日付
)
SELECT s.日付,
       CASE WHEN d.合計 = '' THEN 0 ELSE d.合計 END AS 合計
FROM 日付系列 AS s
LEFT JOIN 日別 AS d ON s.日付 = d.日付
ORDER BY s.日付
```

期待結果:

```json
{
  "type": "SELECT",
  "columns": ["日付", "合計"],
  "rows": [
    { "日付": "2026-08-01", "合計": "150" },
    { "日付": "2026-08-02", "合計": "0" },
    { "日付": "2026-08-03", "合計": "200" },
    { "日付": "2026-08-04", "合計": "0" }
  ],
  "rowCount": 4
}
```

小さい fixture を1ページで返す mock client では、APP100 のレコード取得 API呼び出し回数は1回とする。生成系列による追加呼び出しは0回。

この SQL が、構文を変更せずそのまま動くことを必須受入条件とする。

### 12.8 一時テーブル

```sql
CREATE TEMP TABLE #days AS
WITH d AS (
  GENERATE_SERIES('2026-08-01', '2026-08-03') AS 日付
)
SELECT 日付 FROM d;

SELECT 日付
FROM #days
ORDER BY 日付;
```

期待値は3日分であり、DATE メタを維持する。純粋な生成・参照だけならレコード API呼び出し回数は0。

### 12.9 エラーになるもの

次はすべて部分結果を返さず、指定した例外になる。

```sql
WITH s AS (GENERATE_SERIES(1, 5, 0))
SELECT generate_series FROM s
```

`ArgumentError`。

```sql
WITH d AS (
  GENERATE_SERIES('2026-08-01', '2026-08-05', '0 day')
)
SELECT generate_series FROM d
```

`ArgumentError`。

```sql
WITH s AS (GENERATE_SERIES(1, 5, 0.5))
SELECT generate_series FROM s
```

`ArgumentError`。

```sql
WITH s AS (GENERATE_SERIES(1.5, 5.5))
SELECT generate_series FROM s
```

`ArgumentError`。

```sql
WITH d AS (
  GENERATE_SERIES('2026-02-30', '2026-03-02')
)
SELECT generate_series FROM d
```

`ArgumentError`。

```sql
WITH d AS (
  GENERATE_SERIES(
    '2026-08-01T00:00:00Z',
    '2026-08-03T00:00:00Z',
    '1 day'
  )
)
SELECT generate_series FROM d
```

`ArgumentError`。

```sql
WITH d AS (
  GENERATE_SERIES('2026-08-01', '2026-08-03', '1 month')
)
SELECT generate_series FROM d
```

`ArgumentError`。

```sql
WITH s AS (
  GENERATE_SERIES(1, '2026-08-03')
)
SELECT generate_series FROM s
```

`ArgumentError`。

```sql
WITH d AS (
  GENERATE_SERIES('2026-08-01', '2026-08-03', 1)
)
SELECT generate_series FROM d
```

`ArgumentError`。

```sql
SELECT *
FROM GENERATE_SERIES(1, 5)
```

`ParseError`。本文に動作する文 CTE の修正例を含む。

### 12.10 上限・adversarial

#### X1: ちょうど上限

```sql
WITH s AS (
  GENERATE_SERIES(1, 10000) AS n
)
SELECT COUNT(*) AS 件数
FROM s
```

成功し、件数は `10000`。

#### X2: 1行超過

```sql
WITH s AS (
  GENERATE_SERIES(1, 10001) AS n
)
SELECT COUNT(*) AS 件数
FROM s
```

`ArgumentError`。レコード API呼び出し回数は0。

#### X3: LIMIT で回避できない

```sql
WITH s AS (
  GENERATE_SERIES(1, 1000000000) AS n
)
SELECT n FROM s LIMIT 1
```

`ArgumentError`。巨大配列を作らない。

#### X4: 複数 CTE 合計

```sql
WITH a AS (
  GENERATE_SERIES(1, 6000) AS n
),
b AS (
  GENERATE_SERIES(1, 5000) AS n
)
SELECT n FROM a
UNION ALL
SELECT n FROM b
```

合計上限超過の `ArgumentError`。

#### X5: 逆方向の巨大範囲

```sql
WITH s AS (
  GENERATE_SERIES(1, 9007199254740991, -1) AS n
)
SELECT n FROM s
```

方向が逆なので0行であり、上限超過にはしない。

#### X6: 安全整数外

```sql
WITH s AS (
  GENERATE_SERIES(9007199254740992, 9007199254740993)
)
SELECT generate_series FROM s
```

`ArgumentError`。丸めて同じ値として扱わない。

#### X7: 空文字変数

```sql
DECLARE @start DEFAULT '';
WITH s AS (
  GENERATE_SERIES(@start, 5)
)
SELECT generate_series FROM s;
```

`ArgumentError`。空文字を0に変換しない。

### 12.11 EXPLAIN

```sql
EXPLAIN
WITH s AS (
  GENERATE_SERIES(2, 100, 49) AS n
)
SELECT n
FROM s
ORDER BY n
```

次を公開表示で確認できる。

- source が `GENERATE_SERIES`
- 列名 `n`
- 型 `INTEGER`
- start `2`
- stop `100`
- step `49`
- 生成件数 `3`
- 上限 `10000`
- records API が `none`

mock client の全 API呼び出し回数は0。

### 12.12 回帰

次を維持する。

- 通常の `WITH ... AS (SELECT ...)`
- `WITH ... AS (SHOW APPS)`
- `WITH ... AS (DESCRIBE APP100)`
- 複数 CTE
- CTE 間 JOIN
- FROM なし `SELECT ... UNION ALL`
- 一時テーブル作成・参照
- `LAG` / `LEAD` の既存列メタ引継ぎ
- NUMBER、DATE の通常 `ORDER BY`
- 既存スカラー関数名としての識別子利用
- バッククォートで囲んだ `` `GENERATE_SERIES` `` を通常識別子として扱う既存規則

---

## 13. Phase 1 の線引き

### 13.1 Phase 1 に入れるもの

- 整数系列
- DATE 系列
- 正 step
- 負 step
- step 省略
- `day` / `days`
- 文 CTE
- 列 alias
- 型メタ伝播
- 通常 SELECT、JOIN、UNION、サブクエリからの参照
- `CREATE TEMP TABLE ... AS WITH ...`
- `EXPLAIN`
- 10,000行の生成上限
- `LEFT JOIN` による日次0埋め

### 13.2 Phase 1 に入れないもの

| 対象外 | 理由 |
|---|---|
| 小数 start / stop / step | kSQL 算術は binary64 であり、累積誤差と stop 包含規則を別途設計する必要がある |
| `DATETIME` | タイムゾーン、夏時間、時刻 step、正規化形式の論点が増える |
| `TIME` | 日付をまたぐか、循環するか、終端をどう扱うかが未定義 |
| `INTERVAL` 型 | kSQL に新しい値型と演算規則を導入する必要があり、日次0埋めには不要 |
| `week` 単位 | `7 days` の倍数で表現できる |
| `month` / `year` 単位 | 月末丸め、反復時の基準日、逆方向の対称性を別途決める必要がある |
| hour / minute / second | `DATETIME` / `TIME` と同時に設計すべき |
| `FROM GENERATE_SERIES(...)` | FROM grammar、table function alias、列 alias、planner全体への変更が必要 |
| SELECT 列の SRF | 行増殖と通常のスカラー式評価を混在させるため |
| CTE 列名リスト `WITH s(n) AS (...)` | 既存 CTE grammarに無い別機能であり、末尾 `AS n` で目的を満たせる |
| `INSERT ... WITH ... SELECT` | 現行 INSERT SELECT AST の拡張を伴う。Phase 1 は一時テーブル経由を使う |
| 利用者指定の系列上限 | API surface ごとの設定公開を伴う。初版は固定上限で安全性を優先する |
| 再帰 CTE | B149 の実需を満たすために不要で、別件 B53 の範囲である |

### 13.3 後続 Phase で拡張する場合

後続 Phaseでは、少なくとも次を個別に仕様化する。

- 小数を10進として保持するか binary64 とするか
- 月・年 step の月末規則
- `DATETIME` のタイムゾーンと夏時間
- `FROM` 直置きの table alias / column alias grammar
- 上限の利用者設定と実行面ごとの公開方法
- `INSERT ... WITH ... SELECT` を含む DML source grammar

Phase 1 の DATE と整数の結果を変更する形で拡張してはならない。

---

## 14. 文書・リリース要件

実装時は少なくとも次を同期する。

- `docs/ksql_language_reference.md`
- B149 起票・仕様・実装報告
- `docs/ksql_issue_tracker.md`
- README または公開機能一覧
- CHANGELOG
- CLI / MCP の schema・description
- EXPLAIN のサンプル
- mock client による API 0 回テスト
- ブラウザ向け機能である場合は Firefox / Chrome smoke
- version、manifest、配布物

言語リファレンスには次を明記する。

- 文 CTEとしての完全構文
- 整数と DATE
- step 省略
- 負 step
- 0 行になる方向
- step 0 のエラー
- 10,000行上限
- `day` / `days` のみ
- `FROM` 直置き非対応
- `LEFT JOIN` 0 埋めの完全な SQL
- 公開値は文字列だが比較・ソートは列メタに従うこと

---

## 15. Claude が実測すべき未確認事項

### 15.1 parser と AST

- `GENERATE_SERIES` を文 CTEとして追加した完全 SQLが parse できること
- 2引数、3引数、末尾 `AS` の境界
- 複数 CTEとの併用
- `GENERATE_SERIES` を通常識別子として使う既存 SQLとの衝突
- バッククォート識別子の回帰
- `FROM` 直置き時の診断と、本文中の修正 SQLが実際に動くこと

### 15.2 整数境界

- stop ちょうど
- stop をまたぐ直前
- 正負両方向
- 4象限
- start = stop
- step 省略
- 桁数の異なる `2`, `51`, `100`
- 安全整数境界
- 件数計算が浮動小数点誤差で1行ずれないこと

### 15.3 DATE 境界

- 月またぎ
- 年またぎ
- うるう日
- 正負 step
- step 省略
- stop ちょうど
- stop をまたぐ直前
- 不正日付
- `0000`、`9999` 付近
- 日付加算による範囲外

### 15.4 型メタ

- 整数が文字列順ではなく数値順になること
- DATE が後段 CTEでも DATE メタを保つこと
- JOIN後も生成列のメタが残ること
- 一時テーブル化後もメタが残ること
- `LAG` / `LEAD` が引数メタを引き継ぐこと
- 0行の生成 CTEでも列名とメタが残ること
- `getSelectColumnMeta` の公開結果

### 15.5 `LEFT JOIN` 0 埋め

§12.7 の SQLを変更せず実行し、次を確認する。

- 取引のない `2026-08-02` と `2026-08-04` が消えない
- 右辺不一致の空文字を `CASE` が `0` に変換する
- 日付順に4行並ぶ
- APP100 のレコード取得以外に生成系列由来の API呼び出しが無い
- CTE 間 JOINの列名解決が曖昧にならない

### 15.6 上限

- 10,000行は成功
- 10,001行はエラー
- `LIMIT 1` で上限を回避できない
- 複数生成 CTEの合計上限
- 逆方向で0行になる巨大範囲
- 上限超過時に巨大配列を作らない
- 一時テーブル上限との二重ガード
- エラー前のレコード API呼び出しが0回

### 15.7 EXPLAIN

- 純粋な生成系列の API呼び出しが全種類0回
- 型、start、stop、step、件数、上限、列名が表示される
- DATE step の正規化表示
- 0行系列の件数表示
- 複数生成 CTEの合計上限表示
- 上限超過の EXPLAIN が実行と同じエラーになる
- 物理アプリ CTEを併用したとき、生成系列を fetch source と誤表示しない

### 15.8 バッチ変数

- 数値既定値
- 外部注入された整数文字列
- DATE文字列
- day step文字列
- 空文字
- 非数値
- 配列変数
- 未定義変数
- 変数解決後の上限判定
- エラー文で変数値を過剰に露出しないこと

### 15.9 一時テーブルと DML

- `CREATE TEMP TABLE ... AS WITH ...` が動くこと
- 一時テーブルの列メタが維持されること
- 一時テーブルを介した `INSERT ... SELECT`
- B149 上限と DML 上限が独立して働くこと
- `GENERATE_SERIES` 自体が書込 APIを呼ばないこと
- 既存の確認・キャンセル・VALIDATE ONLY契約を迂回しないこと

### 15.10 全 surface

同じ SQLについて次を確認する。

- ライブラリ
- CLI
- MCP
- Firefox プラグイン
- Chrome プラグイン

公開する `columns`、`rows`、`rowCount`、例外分類、例外本文が一致すること。ブラウザ向けリリース判定では、Nodeだけの試験をブラウザ smoke の代用にしない。