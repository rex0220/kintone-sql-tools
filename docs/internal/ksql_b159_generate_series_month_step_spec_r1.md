# B159 `GENERATE_SERIES` — month / year step 仕様（R1）

- 対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`
- 対象版: v3.63.0
- 同梱: B158 `CROSS JOIN`
- 起票: [B159](ksql_b159_generate_series_month_step_issue.md)
- 前提機能: B149 `GENERATE_SERIES`
- ステータス: 実装依頼可能

## 0. R1 の位置づけ

B149 で導入した `GENERATE_SERIES` の DATE 系列に、月次・年次系列を生成する `month` / `year` step を追加する。

B159 は新しい系列構文を増やすものではない。出荷済みの `GENERATE_SERIES(start, stop [, step])` に DATE step の単位を追加し、空月があると `LAG` が静かに 2 か月前を参照する問題を、月次 0 埋めによって防げるようにする。

B149 の次の契約は変更しない。

- `GENERATE_SERIES` を直接書けるのは `WITH` の CTE 本体だけ
- 整数系列と DATE 系列を生成する
- stop を超えない
- start と stop の向きに step が合わない場合は 0 行
- step 0 は `ArgumentError`
- 負 step を許可する
- 1つの `WITH` 文内の `GENERATE_SERIES` 生成件数合計は最大 10,000 行
- 行数は実体化前に算出する
- 出力列の INTEGER / DATE 型メタを後続処理へ伝播する
- 生成列を直接読むウィンドウについて、厳密単調性から全順序を直接証明できる場合だけ警告を抑止する
- `EXPLAIN` に系列型、境界、step、行数、行数ガード、API 不使用を表示する
- 純粋な生成系列、静的検証、dry-run、EXPLAIN は kintone API を呼ばない

現行実装の根拠は次のとおり。

| 現行契約 | 根拠 |
|---|---|
| step は数値または文字列のリテラル、あるいはバッチ変数として AST に保持される | `src/types/ast.ts:186-193`; `src/parser/parser.ts:1271-1306` |
| DATE step は現在、符号付き整数係数と `day` / `days` を受け付ける | `src/core/generateSeries.ts:70-85` |
| 行数は生成前に算出される | `src/core/generateSeries.ts:113-118,120-180` |
| リテラルは AST-only 検証、変数依存判定は実行時へ保留される | `src/core/generateSeries.ts:183-220` |
| 同じ WITH 内の系列件数を合算して 10,000 行を検査する | `src/core/generateSeries.ts:223-246` |
| 実行時も単一系列の上限を再検査してから値を生成する | `src/core/generateSeries.ts:249-269` |
| DATE 出力には DATE semantics が付く | `src/execute.ts:5304-5325` |
| 生成列の直接参照だけを全順序として保守的に証明する | `src/execute.ts:2572-2592,2634-2665,5457-5464` |
| EXPLAIN は系列計画と `row guard:`、`records API: none` を表示する | `src/execute.ts:11878-11910` |

## 1. 目的

次の月次系列を kSQL 内で生成可能にする。

```sql
WITH m AS (
  GENERATE_SERIES(
    '2025-08-01',
    '2026-08-01',
    '1 month'
  ) AS 月
)
SELECT 月
FROM m
ORDER BY 月
```

結果は13行とする。

```text
2025-08-01
2025-09-01
2025-10-01
...
2026-07-01
2026-08-01
```

年次系列も同じ構文で生成可能にする。

```sql
WITH y AS (
  GENERATE_SERIES(
    '2022-01-01',
    '2026-01-01',
    '1 year'
  ) AS 年
)
SELECT 年
FROM y
ORDER BY 年
```

結果:

```text
2022-01-01
2023-01-01
2024-01-01
2025-01-01
2026-01-01
```

## 2. 構文

### 2.1 完全文法

既存構文を変更しない。

```text
GENERATE_SERIES(start, stop [, step]) [AS column]
```

DATE 系列の step は次を受理する。

```text
[+|-]integer whitespace unit
```

`unit` は大文字・小文字を区別せず、次のいずれかとする。

```text
day
days
month
months
year
years
```

前後の空白は無視する。係数と単位の間には1文字以上の空白が必要である。

### 2.2 係数付き step

day step の現行実装は、`/^([+-]?\d+)\s+(day|days)$/i` により任意の符号付き整数係数を受け付けている（`src/core/generateSeries.ts:70-84`）。

この一貫性に従い、month / year も係数付きを許可する。

受理例:

```sql
'1 month'
'1 months'
'2 month'
'2 months'
'+2 months'
'-1 month'
'-3 months'

'1 year'
'1 years'
'2 year'
'2 years'
'+2 years'
'-1 year'
'-3 years'
```

単数形・複数形と係数の一致は要求しない。これは現行の day / days と同じ規則である。

係数は JavaScript の安全な整数範囲内でなければならない。小数、指数表記、単位だけの指定、係数と単位の間に空白がない指定は拒否する。

拒否例:

```sql
'1.5 months'
'1e2 months'
'month'
'1month'
```

### 2.3 負 step

負の month / year step を許可する。

```sql
WITH m AS (
  GENERATE_SERIES(
    '2026-08-01',
    '2026-02-01',
    '-2 months'
  ) AS 月
)
SELECT 月
FROM m
```

結果:

```text
2026-08-01
2026-06-01
2026-04-01
2026-02-01
```

### 2.4 step 省略

DATE 系列で step を省略した場合は、B149 の既存契約どおり `1 day` とする。

month / year を既定 step にはしない。

## 3. 系列型と出力

### 3.1 系列型

month / year step を指定した系列の型は、day step と同じ `DATE` とする。

`EXPLAIN` の `series type:` も新しい `MONTH` / `YEAR` 型にはせず、次を維持する。

```text
series type:   DATE
```

### 3.2 公開値

month step の各値は月初の DATE とする。

```text
YYYY-MM-01
```

year step の各値は年初の DATE とする。

```text
YYYY-01-01
```

内部値・公開値とも文字列型の `YYYY-MM` にはしない。

DATE 型を維持することで、現行の次の処理と同じ意味論を使う。

- DATE ソート
- B149 の型メタ伝播
- `LAST_DAY`
- `DATE_ADD`
- `LAG` / `LEAD`
- DATE フィールドとの JOIN
- DATE_FORMAT による表示形式変換

現行の DATE メタ付与位置は `src/execute.ts:5313-5324` であり、month / year step でも同じ経路を通す。

### 3.3 `YYYY-MM` が必要な場合

月キーを文字列で扱う場合は、生成系列自体の型を変えず、CTE を1段追加して `DATE_FORMAT` する。

```sql
WITH m AS (
  GENERATE_SERIES(
    '2025-08-01',
    '2026-08-01',
    '1 month'
  ) AS 月
),
月キー付き AS (
  SELECT
    月,
    DATE_FORMAT(月, '%Y-%m') AS 月キー
  FROM m
)
SELECT 月, 月キー
FROM 月キー付き
ORDER BY 月
```

## 4. 月初・年初アンカー

### 4.1 month step

month / months step は、start が月初である場合だけ許可する。

```text
start の日 = 1
```

許可:

```sql
GENERATE_SERIES('2025-08-01', '2026-08-01', '1 month')
GENERATE_SERIES('2025-08-01', '2026-08-31', '2 months')
GENERATE_SERIES('2026-08-01', '2025-08-15', '-1 month')
```

拒否:

```sql
GENERATE_SERIES('2025-08-02', '2026-08-01', '1 month')
GENERATE_SERIES('2025-08-31', '2026-08-31', '1 month')
```

### 4.2 year step

year / years step は、start が年初である場合だけ許可する。

```text
start の月 = 1
start の日 = 1
```

許可:

```sql
GENERATE_SERIES('2022-01-01', '2026-01-01', '1 year')
GENERATE_SERIES('2022-01-01', '2026-12-31', '2 years')
GENERATE_SERIES('2026-01-01', '2022-06-30', '-1 year')
```

拒否:

```sql
GENERATE_SERIES('2022-02-01', '2026-01-01', '1 year')
GENERATE_SERIES('2022-01-02', '2026-01-01', '1 year')
GENERATE_SERIES('2024-02-29', '2028-02-29', '1 year')
```

### 4.3 stop のアンカー

stop は実在する DATE であれば月初・年初でなくてもよい。

stop は生成値ではなく包含境界である。生成した月初・年初が stop を超えない範囲だけを返す。

```sql
GENERATE_SERIES('2025-08-01', '2025-10-15', '1 month')
```

結果:

```text
2025-08-01
2025-09-01
2025-10-01
```

```sql
GENERATE_SERIES('2025-10-01', '2025-08-15', '-1 month')
```

結果:

```text
2025-10-01
2025-09-01
```

`2025-08-01` は stop より前なので含めない。

### 4.4 検証順

start / stop の DATE 妥当性、step の構文・単位・step 0 を検証した後、month / year の start アンカーを検証する。

start と stop の向きが逆で結果が 0 行になる場合でも、start アンカー違反は許容しない。

次は 0 行ではなくエラーとする。

```sql
WITH m AS (
  GENERATE_SERIES(
    '2025-08-15',
    '2024-08-01',
    '1 month'
  ) AS 月
)
SELECT 月
FROM m
```

## 5. 生成規則

### 5.1 累積加算を禁止する

month / year 系列は、直前に生成した値へ step を累積加算して作らない。

各行は start のアンカーと行番号から直接算出する。

month step の第 `n` 行:

```text
monthIndex(n) = monthIndex(start) + n × stepCoefficient
day = 1
```

year step の第 `n` 行:

```text
year(n) = year(start) + n × stepCoefficient
month = 1
day = 1
```

`n` は 0 始まりとする。

月末丸め、短い月による日付ドリフト、直前行の丸め結果の累積を系列へ持ち込まない。

### 5.2 month index

月を次の連続整数へ変換する。

```text
monthIndex(date) = year × 12 + (month - 1)
```

月初 DATE への逆変換は次とする。

```text
year  = floor(monthIndex / 12)
month = monthIndex mod 12 + 1
day   = 1
```

実装上は西暦 1～9999 年を正しく扱う。`Date.UTC()` の 0～99 年補正へ依存せず、既存 `dateParts()` / `setUTCFullYear()` と同じ年境界の扱いを維持する（`src/core/generateSeries.ts:38-59`）。

### 5.3 year index

year step では西暦年を連続整数として扱う。

```text
yearIndex(date) = year
```

生成値は常に次である。

```text
YYYY-01-01
```

`12 months` と `1 year` は同じ間隔だが、アンカー契約は異なる。

- `12 months`: start は任意の月の1日でよい
- `1 year`: start は1月1日でなければならない

### 5.4 stop 境界の正規化

正方向では、stop を超えない最後の期間アンカーを上限とする。

- month: stop が属する月の月初
- year: stop が属する年の年初

負方向では、stop 以上となる最小の期間アンカーを下限とする。

- stop 自体が月初・年初なら、そのアンカー
- stop が月中・年中なら、stop の次の月初・年初

これにより、負方向でも stop を下回る値を生成しない。

例:

```sql
GENERATE_SERIES('2026-01-01', '2025-12-31', '-1 year')
```

結果:

```text
2026-01-01
```

`2025-01-01` は stop より前なので生成しない。

## 6. 行数の事前算出

### 6.1 共通式

start と stop の向きが step と一致しない場合は 0 行とする。

start と stop が等しい場合は、start アンカー検証を通過した後、step の符号に関係なく1行とする。

方向が一致する場合、正規化済みの期間 index を使って次で算出する。

```text
distance = abs(boundaryIndex - startIndex)
rowCount = floor(distance / abs(stepCoefficient)) + 1
```

month では month index、year では year index を使う。

整数系列・day 系列に使っている `countRows()` と同じ境界規則を維持する（`src/core/generateSeries.ts:113-118`）。

### 6.2 例

| 呼び出し | 行数 | 結果 |
|---|---:|---|
| `GENERATE_SERIES('2025-08-01','2026-08-01','1 month')` | 13 | 2025-08-01 ～ 2026-08-01 |
| `GENERATE_SERIES('2025-08-01','2026-08-31','2 months')` | 7 | 2025-08-01 ～ 2026-08-01 |
| `GENERATE_SERIES('2026-08-01','2025-08-15','-2 months')` | 6 | 2026-08-01 ～ 2025-10-01 |
| `GENERATE_SERIES('2022-01-01','2026-12-31','2 years')` | 3 | 2022、2024、2026 |
| `GENERATE_SERIES('2026-01-01','2025-12-31','-1 year')` | 1 | 2026-01-01 |
| `GENERATE_SERIES('2025-08-01','2026-08-01','-1 month')` | 0 | 空 |
| `GENERATE_SERIES('2026-08-01','2025-08-01','1 month')` | 0 | 空 |

### 6.3 10,000 行ガード

month / year の `rowCount` は、B149 と同じ上限検査へ合流させる。

単一系列:

```text
rowCount <= 10000
```

同じ WITH 内の全系列:

```text
sum(rowCount of every GENERATE_SERIES CTE) <= 10000
```

検査位置は次を維持する。

- リテラルで確定する場合は AST-only 静的検証
- 変数を含む場合は変数解決後、実体化前
- 実行時も単一系列を再検査
- `LIMIT` 適用前
- 行配列確保前
- kintone API 呼び出し前

既存の合流点は `src/core/generateSeries.ts:216-220,223-246,249-253` である。

B158 により上限定数が共通の `GENERATED_ROW_MAX_ROWS` へ移された場合は、その共通値を参照する。ただし、B158 の CROSS JOIN 出力行数カウンタと、B149/B159 の WITH 内系列件数合計カウンタは統合しない。

## 7. 静的検証と変数解決

### 7.1 リテラル

次の情報がリテラルだけで確定する場合、通常実行、保存、dry-run、EXPLAIN の前に静的検証する。

- DATE の妥当性
- step 構文
- step 単位
- step 0
- start の月初・年初アンカー
- 単一系列の行数
- 同じ WITH 内の系列件数合計

現行の静的検証入口は `validateStatementStatic()` から呼ばれる `validateGenerateSeriesInStatement()` である（`src/core/statementValidation.ts:8-12`; `src/core/generateSeries.ts:223-246`）。

### 7.2 変数

start、stop、step のいずれかが変数で、値に依存する判定を静的に完了できない場合は、その判定だけを変数解決後へ保留する。

```sql
DECLARE @start = '2025-08-01';
DECLARE @stop = '2026-08-01';
DECLARE @step = '1 month';

WITH m AS (
  GENERATE_SERIES(@start, @stop, @step) AS 月
)
SELECT 月
FROM m
ORDER BY 月
```

変数は実行時に NUMBER または STRING リテラル相当へ解決される（`src/execute.ts:2101-2149`）。解決後にリテラルと同じ検証を行う。

既知部分は変数があっても検査する。

例:

```sql
DECLARE @stop = '2026-08-01';

WITH m AS (
  GENERATE_SERIES('2025-08-15', @stop, '1 month') AS 月
)
SELECT 月
FROM m
```

step と start だけで month アンカー違反が確定するため、stop の解決を待つ必要はない。

## 8. エラー契約

すべて `ArgumentError` とし、診断前に API を呼ばない。

### 8.1 step 0

逐語:

```text
ArgumentError: GENERATE_SERIES の日付 step に 0 month は指定できません。
```

対象:

```sql
'0 month'
'+0 month'
'-0 months'
```

逐語:

```text
ArgumentError: GENERATE_SERIES の日付 step に 0 year は指定できません。
```

対象:

```sql
'0 year'
'+0 year'
'-0 years'
```

day の既存エラーは変更しない。

```text
ArgumentError: GENERATE_SERIES の日付 step に 0 day は指定できません。
```

### 8.2 month の非月初 start

逐語:

```text
ArgumentError: GENERATE_SERIES の month step では start に月初（YYYY-MM-01）を指定してください。
```

例:

```sql
WITH m AS (
  GENERATE_SERIES(
    '2025-08-15',
    '2026-08-01',
    '1 month'
  ) AS 月
)
SELECT 月
FROM m
```

### 8.3 year の非年初 start

逐語:

```text
ArgumentError: GENERATE_SERIES の year step では start に年初（YYYY-01-01）を指定してください。
```

例:

```sql
WITH y AS (
  GENERATE_SERIES(
    '2025-02-01',
    '2028-01-01',
    '1 year'
  ) AS 年
)
SELECT 年
FROM y
```

### 8.4 未対応単位

逐語:

```text
ArgumentError: GENERATE_SERIES の日付 step は day、days、month、months、year、years のみ対応しています。
```

例:

```sql
'1 week'
'1 quarter'
'1 hour'
```

### 8.5 型不一致

DATE 系列へ数値 step、整数系列へ文字列 step を指定した場合の文言は、month / year を反映して次へ更新する。

```text
ArgumentError: GENERATE_SERIES の step が系列の型と一致しません。整数系列には整数、DATE 系列には day、month、year 単位を指定してください。
```

### 8.6 不正な係数

逐語:

```text
ArgumentError: GENERATE_SERIES の日付 step の係数には安全な整数を指定してください。
```

例:

```sql
'1.5 months'
'1e2 months'
'9007199254740992 months'
```

### 8.7 上限超過

既存文言を維持する。

単一系列:

```text
ArgumentError: GENERATE_SERIES の生成件数 10001 行が上限 10000 行を超えています。
```

WITH 内合計:

```text
ArgumentError: この WITH 文の GENERATE_SERIES 生成件数合計 11000 行が上限 10000 行を超えています。
```

## 9. 型メタとウィンドウ警告

### 9.1 型メタ

month / year 系列の生成列には次を付与する。

```text
fieldType: DATE
sortKind: string
semantics: DATE
```

`LAG(月)` / `LEAD(月)` の結果も、B149 の既存伝播経路により DATE とする。

### 9.2 厳密単調性

非ゼロの month / year step と月初・年初アンカーから生成した値は、次を満たす。

- 正 step なら厳密増加
- 負 step なら厳密減少
- 同じ値を2回生成しない

month / year でも、B149 の生成列に対する全順序の直接証明は同じ根拠で成立する。

次は警告を抑止する。

```sql
WITH m AS (
  GENERATE_SERIES(
    '2025-08-01',
    '2026-08-01',
    '1 month'
  ) AS 月
)
SELECT
  月,
  LAG(月) OVER (ORDER BY 月) AS 前月
FROM m
ORDER BY 月
```

負 step であっても、生成列が一意であるため、`ORDER BY 月` または `ORDER BY 月 DESC` は全順序である。

### 9.3 抑止範囲

抑止範囲は B149 から広げない。

次をすべて満たす場合だけ抑止する。

- FROM が直接の `GENERATE_SERIES` CTE
- JOIN がない
- ORDER BY にその生成列自体が含まれる
- 生成列の修飾が無修飾、または FROM の有効 alias と一致する

現行の直接証明条件は `src/execute.ts:2579-2585` である。

次の経路では警告を維持する。

- JOIN 後
- UNION 後
- 一時テーブル経由
- 生成列を加工した式だけで ORDER BY
- 別 CTE で射影・集約した後
- B158 `CROSS JOIN` 後

B159 では関係レベルの候補キー推論を追加しない。

## 10. `LAST_DAY` / `DATE_ADD` との合成

### 10.1 月末系列

月末が必要な場合も系列のアンカーを月末へ変えず、月初系列を `LAST_DAY` で変換する。

```sql
WITH m AS (
  GENERATE_SERIES(
    '2024-01-01',
    '2024-03-01',
    '1 month'
  ) AS 月初
)
SELECT
  月初,
  LAST_DAY(月初) AS 月末
FROM m
ORDER BY 月初
```

結果:

```text
月初         月末
2024-01-01   2024-01-31
2024-02-01   2024-02-29
2024-03-01   2024-03-31
```

### 10.2 うるう年

次を必須受入条件とする。

```sql
WITH m AS (
  GENERATE_SERIES(
    '2024-01-01',
    '2024-03-01',
    '1 month'
  ) AS 月
)
SELECT 月, LAST_DAY(月) AS 月末
FROM m
ORDER BY 月
```

`2024-02-01` が生成され、`LAST_DAY('2024-02-01')` が `2024-02-29` になること。

平年では次を確認する。

```sql
WITH m AS (
  GENERATE_SERIES(
    '2025-01-01',
    '2025-03-01',
    '1 month'
  ) AS 月
)
SELECT 月, LAST_DAY(月) AS 月末
FROM m
ORDER BY 月
```

`LAST_DAY('2025-02-01')` は `2025-02-28` とする。

### 10.3 将来の任意日起点

本 Phase では任意日起点を許可しない。

将来、任意日起点を開放する場合の規則は、既存 `DATE_ADD(date, n, 'MONTH')` と同じ次に固定する。

- start をアンカーとする
- 各行を `start + n × step` から直接算出する
- 月末を超える場合は対象月の月末へ丸める
- 直前行の丸め結果へ step を累積しない

本 Phase ではこの規則を実装しない。

## 11. `EXPLAIN`

### 11.1 month

```sql
EXPLAIN WITH m AS (
  GENERATE_SERIES(
    '2025-08-01',
    '2026-08-01',
    '1 month'
  ) AS 月
)
SELECT 月
FROM m
ORDER BY 月
```

必須表示:

```text
[cte: m]
  source:        GENERATE_SERIES
  column:        月
  series type:   DATE
  start:         2025-08-01
  stop:          2026-08-01
  step:          1 month
  rows:          13
  row guard:     13 / 10000
  records API:   none
```

### 11.2 year

```sql
EXPLAIN WITH y AS (
  GENERATE_SERIES(
    '2022-01-01',
    '2026-01-01',
    '2 years'
  ) AS 年
)
SELECT 年
FROM y
ORDER BY 年
```

必須表示:

```text
[cte: y]
  source:        GENERATE_SERIES
  column:        年
  series type:   DATE
  start:         2022-01-01
  stop:          2026-01-01
  step:          2 years
  rows:          3
  row guard:     3 / 10000
  records API:   none
```

### 11.3 step の正規化

`step:` は単位を小文字へ正規化する。

絶対値が1なら単数形、それ以外は複数形とする。

| 入力 | EXPLAIN |
|---|---|
| `'1 months'` | `step: 1 month` |
| `'+2 month'` | `step: 2 months` |
| `'-1 years'` | `step: -1 year` |
| `'-2 year'` | `step: -2 years` |

day の既存表示規則も維持する。

現行 EXPLAIN は DATE step を常に day/days と組み立てているため、単位情報を系列 plan に保持して分岐させる（`src/execute.ts:11894-11907`）。

## 12. 月次 0 埋めと `LAG`

### 12.1 必須の実需形

次の完全 SQLを受理すること。

```sql
WITH m AS (
  GENERATE_SERIES(
    '2025-08-01',
    '2026-08-01',
    '1 month'
  ) AS 月
),
月キー付き AS (
  SELECT
    月,
    DATE_FORMAT(月, '%Y-%m') AS 月キー
  FROM m
),
月次実績 AS (
  SELECT
    月キー,
    SUM(金額) AS 実績
  FROM APP100
  GROUP BY 月キー
),
月次0埋め AS (
  SELECT
    m.月,
    CASE
      WHEN a.実績 = '' THEN 0
      ELSE a.実績
    END AS 実績
  FROM 月キー付き AS m
  LEFT JOIN 月次実績 AS a
    ON m.月キー = a.月キー
),
月次比較 AS (
  SELECT
    月,
    実績,
    LAG(実績) OVER (ORDER BY 月) AS 前月実績
  FROM 月次0埋め
)
SELECT
  月,
  実績,
  前月実績
FROM 月次比較
ORDER BY 月
```

### 12.2 必須データ条件

少なくとも次の入力で確認する。

| 月キー | 実績 |
|---|---:|
| 2025-08 | 10 |
| 2025-10 | 30 |

2025-09 のレコードは存在しない。

### 12.3 必須結果

結果には空月が明示的な0として現れる。

```text
月           実績   前月実績
2025-08-01   10
2025-09-01   0      10
2025-10-01   30     0
```

2025-10 の `前月実績` は `10` ではなく `0` でなければならない。

これにより `LAG` は「前に存在するレコード」ではなく、0 埋め後の正しい1か月前を見る。

この SQL は JOIN と中間 CTE を通るため、現行の保守的な全順序警告が残ってもよい。B159 の正しさ条件は、空月が0行として補われ、`LAG` の値が正しいことである。

## 13. 受入条件

### 13.1 month 正方向

```sql
WITH m AS (
  GENERATE_SERIES(
    '2025-08-01',
    '2026-08-01',
    '1 month'
  ) AS 月
)
SELECT 月
FROM m
ORDER BY 月
```

- 13行
- 先頭 `2025-08-01`
- 最後 `2026-08-01`
- 全行 DATE メタ
- 重複なし

### 13.2 month 係数付き

```sql
WITH m AS (
  GENERATE_SERIES(
    '2025-08-01',
    '2026-08-31',
    '2 months'
  ) AS 月
)
SELECT 月
FROM m
ORDER BY 月
```

期待値:

```text
2025-08-01
2025-10-01
2025-12-01
2026-02-01
2026-04-01
2026-06-01
2026-08-01
```

### 13.3 month 負 step

```sql
WITH m AS (
  GENERATE_SERIES(
    '2026-08-01',
    '2026-02-01',
    '-2 months'
  ) AS 月
)
SELECT 月
FROM m
```

期待値:

```text
2026-08-01
2026-06-01
2026-04-01
2026-02-01
```

### 13.4 year 正方向

```sql
WITH y AS (
  GENERATE_SERIES(
    '2022-01-01',
    '2026-01-01',
    '1 year'
  ) AS 年
)
SELECT 年
FROM y
ORDER BY 年
```

期待値:

```text
2022-01-01
2023-01-01
2024-01-01
2025-01-01
2026-01-01
```

### 13.5 year 負 step

```sql
WITH y AS (
  GENERATE_SERIES(
    '2026-01-01',
    '2020-01-01',
    '-2 years'
  ) AS 年
)
SELECT 年
FROM y
```

期待値:

```text
2026-01-01
2024-01-01
2022-01-01
2020-01-01
```

### 13.6 stop 非アンカー

```sql
WITH m AS (
  GENERATE_SERIES(
    '2025-08-01',
    '2025-10-15',
    '1 month'
  ) AS 月
)
SELECT 月
FROM m
```

期待値:

```text
2025-08-01
2025-09-01
2025-10-01
```

負方向:

```sql
WITH m AS (
  GENERATE_SERIES(
    '2025-10-01',
    '2025-08-15',
    '-1 month'
  ) AS 月
)
SELECT 月
FROM m
```

期待値:

```text
2025-10-01
2025-09-01
```

### 13.7 向きが逆

逐語 SQL:

```sql
WITH m AS (
  GENERATE_SERIES(
    '2025-08-01',
    '2026-08-01',
    '-1 month'
  ) AS 月
)
SELECT 月
FROM m
```

期待:

```text
0 rows
```

逐語 SQL:

```sql
WITH y AS (
  GENERATE_SERIES(
    '2026-01-01',
    '2022-01-01',
    '1 year'
  ) AS 年
)
SELECT 年
FROM y
```

期待:

```text
0 rows
```

### 13.8 step 0

逐語 SQL:

```sql
WITH m AS (
  GENERATE_SERIES(
    '2025-08-01',
    '2026-08-01',
    '0 month'
  ) AS 月
)
SELECT 月
FROM m
```

逐語エラー:

```text
ArgumentError: GENERATE_SERIES の日付 step に 0 month は指定できません。
```

逐語 SQL:

```sql
WITH y AS (
  GENERATE_SERIES(
    '2022-01-01',
    '2026-01-01',
    '0 year'
  ) AS 年
)
SELECT 年
FROM y
```

逐語エラー:

```text
ArgumentError: GENERATE_SERIES の日付 step に 0 year は指定できません。
```

### 13.9 非月初・非年初

逐語 SQL:

```sql
WITH m AS (
  GENERATE_SERIES(
    '2025-08-31',
    '2026-08-01',
    '1 month'
  ) AS 月
)
SELECT 月
FROM m
```

逐語エラー:

```text
ArgumentError: GENERATE_SERIES の month step では start に月初（YYYY-MM-01）を指定してください。
```

逐語 SQL:

```sql
WITH y AS (
  GENERATE_SERIES(
    '2025-02-01',
    '2028-01-01',
    '1 year'
  ) AS 年
)
SELECT 年
FROM y
```

逐語エラー:

```text
ArgumentError: GENERATE_SERIES の year step では start に年初（YYYY-01-01）を指定してください。
```

### 13.10 `LAST_DAY` と2月

次の両方を確認する。

```sql
WITH m AS (
  GENERATE_SERIES(
    '2024-01-01',
    '2024-03-01',
    '1 month'
  ) AS 月
)
SELECT 月, LAST_DAY(月) AS 月末
FROM m
ORDER BY 月
```

```text
2024-02-01 → 2024-02-29
```

```sql
WITH m AS (
  GENERATE_SERIES(
    '2025-01-01',
    '2025-03-01',
    '1 month'
  ) AS 月
)
SELECT 月, LAST_DAY(月) AS 月末
FROM m
ORDER BY 月
```

```text
2025-02-01 → 2025-02-28
```

### 13.11 全順序警告

直接生成 CTE:

```sql
WITH m AS (
  GENERATE_SERIES(
    '2025-08-01',
    '2026-08-01',
    '1 month'
  ) AS 月
)
SELECT
  月,
  LAG(月) OVER (ORDER BY 月) AS 前月
FROM m
ORDER BY 月
```

期待:

- `前月` の型メタは DATE
- 全順序でないという警告を出さない

JOIN 後:

```sql
WITH m AS (
  GENERATE_SERIES(
    '2025-08-01',
    '2026-08-01',
    '1 month'
  ) AS 月
)
SELECT
  m.月,
  LAG(m.月) OVER (ORDER BY m.月) AS 前月
FROM m
LEFT JOIN APP100 AS a
  ON m.月 = a.月
ORDER BY m.月
```

期待:

- JOIN により重複可能性があるため、既存の全順序警告を維持する

### 13.12 10,000 行境界

ちょうど上限:

```sql
WITH m AS (
  GENERATE_SERIES(
    '1000-01-01',
    '1833-04-01',
    '1 month'
  ) AS 月
)
SELECT COUNT(*) AS 件数
FROM m
```

期待:

```text
10000
```

1行超過:

```sql
WITH m AS (
  GENERATE_SERIES(
    '1000-01-01',
    '1833-05-01',
    '1 month'
  ) AS 月
)
SELECT COUNT(*) AS 件数
FROM m
```

逐語エラー:

```text
ArgumentError: GENERATE_SERIES の生成件数 10001 行が上限 10000 行を超えています。
```

`LIMIT 1` を付けても回避できないこと。

### 13.13 dry-run API 0 回

次を CLI dry-run で実行する。

```sql
WITH m AS (
  GENERATE_SERIES(
    '2025-08-01',
    '2026-08-01',
    '1 month'
  ) AS 月
)
SELECT 月
FROM m
ORDER BY 月
```

期待:

- parse 成功
- 静的検証成功
- DATE 系列計画を表示
- records API 0 回
- Cursor API 0 回
- form API 0 回
- app API 0 回
- write API 0 回

リテラルのアンカー違反、step 0、10,000 行超過も dry-run 中に API 0 回で拒否する。

## 14. B158 `CROSS JOIN` との同時開発

### 14.1 parser・AST の衝突

B159 は parser または公開 AST の変更を必要としない。

理由:

- `GENERATE_SERIES` の step は現在も STRING 引数として parse される
- `month` / `year` は文字列リテラル内の値であり、新しい token ではない
- CTE 本体の判定は `parseWith()` 内の `GENERATE_SERIES` 分岐で完結する
- B159 は `GenerateSeriesStatement.args` の形を変更しない
- `FROM GENERATE_SERIES(...)` は引き続き拒否する

根拠:

- CTE 本体の分岐: `src/parser/parser.ts:1241-1268`
- GENERATE_SERIES 引数 parse: `src/parser/parser.ts:1271-1306`
- AST: `src/types/ast.ts:180-198`
- FROM / JOIN 直置き拒否: `src/parser/parser.ts:2483-2489`

B158 は JOIN 句側へ `CROSS` token と `JoinClause` の `CROSS` 分岐を追加する。B158 の変更対象は `parseJoins()`、`JoinType`、`JoinClause` および JOIN 実行経路である（`docs/internal/ksql_b158_cross_join_spec_r1.md:60-116`）。

したがって parser・AST 上の機能依存はない。

### 14.2 同じファイルの編集競合

論理依存はないが、同時実装では次のファイルに編集競合が起こり得る。

- `src/execute.ts`
  - B159: `executeGenerateSeries()`、`buildWithPlan()` の系列表示
  - B158: JOIN 実行、行数ガード、EXPLAIN JOIN 表示
- 公開文書
  - 言語リファレンス
  - README
  - リリース履歴
  - issue tracker
- テスト
  - v3.63.0 の release gate
  - EXPLAIN / dry-run の統合テスト

B158 を先に統合し、その後 B159 を追随させる。

B158 が生成行上限の共通定数を導入した場合、B159 はその定数を使用する。ただし系列件数ガードと CROSS JOIN 出力件数ガードの判定単位は別のままとする。

### 14.3 同時受入 SQL

B158 と B159 が同梱された状態で次を受理する。

```sql
WITH m AS (
  GENERATE_SERIES(
    '2026-01-01',
    '2026-12-01',
    '1 month'
  ) AS 月
),
p AS (
  SELECT 製品コード
  FROM APP200
)
SELECT
  m.月,
  p.製品コード
FROM m
CROSS JOIN p
ORDER BY m.月, p.製品コード
```

確認事項:

- B159 の月系列は12行
- 製品が8件なら直積は96行
- B149/B159 の系列ガードは12 / 10000
- B158 の CROSS JOIN ガードは96 / 10000
- 両ガードを加算・混同しない
- `GENERATE_SERIES` を FROM 直置きしたものとして誤 parse しない
- `CROSS` を step 単位として扱わない
- month step の DATE メタが CROSS JOIN 後も失われない

## 15. 実装変更点

### 15.1 `src/core/generateSeries.ts`

次を実装する。

- DATE step parser に `month(s)` / `year(s)` を追加
- step の係数と単位を別々に保持
- month / year の start アンカー検証
- month / year の行数事前算出
- month / year の値生成
- step 0 の単位別エラー
- 未対応単位・型不一致文言の更新
- 静的検証と変数解決後検証の一致
- 10,000 行ガードへの合流

内部 plan は少なくとも次を区別できる形にする。

```ts
type DateSeriesUnit = "DAY" | "MONTH" | "YEAR";

interface DateSeriesStep {
  readonly coefficient: number;
  readonly unit: DateSeriesUnit;
}
```

公開 AST をこの型へ変更する必要はない。

### 15.2 `src/execute.ts`

次を維持・拡張する。

- month / year の結果にも DATE メタを付与
- `uniqueGeneratedColumn` を維持
- EXPLAIN の step 単位表示
- `series type: DATE`
- `row guard: rows / 10000`
- `records API: none`

### 15.3 テスト

既存 `src/__tests__/b149GenerateSeries.test.ts` の month 拒否テストは、B159 で成功テストへ置き換える。

少なくとも次を追加する。

- month / months
- year / years
- 単数形・複数形と係数の非対応形
- 明示的 `+`
- 負 step
- step 0
- 非月初
- 非年初
- stop 非アンカー
- 正逆4象限
- start = stop
- うるう年2月
- `LAST_DAY`
- `DATE_FORMAT`
- DATE メタ
- `LAG` / `LEAD`
- 直接生成列の警告抑止
- JOIN 後の警告維持
- 10,000 / 10,001 行
- WITH 内複数系列合計
- 変数解決後のアンカー・step・上限
- EXPLAIN
- dry-run API 0 回
- B158 `CROSS JOIN` との統合 SQL
- day / integer 系列の全既存回帰

## 16. 文書・公開 surface

次を更新する。

- `docs/ksql_language_reference.md`
  - DATE step の対応単位
  - month / year の月初・年初アンカー
  - 係数付き・負 step
  - stop 境界
  - `LAST_DAY` による月末変換
  - `DATE_FORMAT` による `YYYY-MM` 変換
  - 月次0埋め＋`LAG`
- `README.md`
  - `GENERATE_SERIES` の month / year 対応
- `docs/ksql_issue_tracker.md`
  - B159 の状態
  - v3.63.0 同梱
- `docs/ksql_release_history.md`
  - B159 の契約と実測結果
- MCP schema / tool description
  - DATE step が day だけと読める記述を month / year 対応へ更新
- statement syntax catalog
  - month の代表例を追加
- smoke assertion
  - EXPLAIN の正規化 step と API `none`
- package / manifest / changelog
  - v3.63.0 の release metadata

既存言語リファレンスの `GENERATE_SERIES` 節は `docs/ksql_language_reference.md:2345-2401`、MCP の公開説明は `src/mcp/schemas.ts:58-74,195` および `src/mcp/index.ts:141-215` にある。day-only または単に INTEGER/DATE とだけ書かれた説明を、過不足なく同期する。

## 17. Claude が実測すべき項目

### 17.1 修正前

v3.62.0 または B159 適用前ビルドで次を確認する。

```sql
WITH m AS (
  GENERATE_SERIES(
    '2025-08-01',
    '2026-08-01',
    '1 month'
  ) AS 月
)
SELECT 月
FROM m
```

逐語:

```text
ArgumentError: GENERATE_SERIES の日付 step は day または days のみ対応しています。
```

### 17.2 基本系列

ビルド済み CLI で次を確認する。

- `1 month`
- `2 months`
- `-1 month`
- `1 year`
- `2 years`
- `-1 year`
- stop 非アンカー
- 向き逆の 0 行
- start = stop

結果の先頭、末尾、行数、順序を記録する。

### 17.3 月次 0 埋め＋LAG

§12 の完全 SQLを実行し、少なくとも次を記録する。

- 空月が結果行として存在する
- 空月の実績が0
- 空月直後の `LAG` がその0を返す
- 空月を飛ばして2か月前を返していない
- 月の昇順が DATE 意味論である

### 17.4 `LAST_DAY` と2月

次を実測する。

- `2024-02-01 → 2024-02-29`
- `2025-02-01 → 2025-02-28`
- 月初系列自体は常に `YYYY-MM-01`
- 月末丸めが系列生成へ逆流しない

### 17.5 エラー

逐語で確認する。

- `0 month`
- `0 year`
- 非月初 month
- 非年初 year
- 不正係数
- 未対応単位
- 型不一致
- 10,001 行
- 変数解決後の非アンカー
- 変数解決後の上限超過

すべて API 呼び出し前に失敗すること。

### 17.6 EXPLAIN

month / year の両方について次を確認する。

- `source: GENERATE_SERIES`
- `series type: DATE`
- start
- stop
- 正規化 step
- rows
- `row guard: ... / 10000`
- `records API: none`

### 17.7 dry-run API 0 回

計測可能な client で次がすべて0回であることを確認する。

- records GET
- Cursor
- form fields
- app metadata
- write API

対象:

- 正常な month 系列
- 正常な year 系列
- step 0
- 非アンカー
- 上限超過
- EXPLAIN

### 17.8 ウィンドウ警告

次を別々に確認する。

- 直接生成 CTEの `LAG(月) OVER (ORDER BY 月)` は警告なし
- month / year の負 step でも直接生成列は警告なし
- JOIN 後は警告あり
- CROSS JOIN 後は警告あり
- 一時テーブル経由は警告あり

### 17.9 B158 同梱

§14.3 の月 × 製品 SQLについて確認する。

- parser 成功
- DATE メタ維持
- 期待する直積行数
- 系列ガードと CROSS ガードを個別表示・個別判定
- 10,000 行超過時は行生成前に拒否
- B158 の INNER / LEFT / RIGHT JOIN 回帰なし

### 17.10 ブラウザ

v3.63.0 の Firefox / Chrome プラグイン smoke で次を確認する。

- month 系列
- year 系列
- 月次 0 埋め＋LAG
- `LAST_DAY`
- EXPLAIN
- step 0
- 非月初
- B158 CROSS JOIN との組み合わせ
- 既存 day 系列
- 既存整数系列

ブラウザ smoke の実測結果を v3.63.0 のリリースゲートとする。

## 18. Phase 線引き

### 18.1 B159 に含めるもの

- `month` / `months`
- `year` / `years`
- 符号付き整数係数
- 負 step
- month の月初 start
- year の年初 start
- stop 非アンカー
- DATE 出力
- 行数事前算出
- 10,000 行ガード
- EXPLAIN
- DATE メタ伝播
- 直接生成列の既存警告抑止
- `LAST_DAY` / `DATE_FORMAT` 合成の文書化
- 月次0埋め＋`LAG` の受入形
- B158 との統合確認

### 18.2 B159 に含めないもの

- 任意日 start
- 月末 start
- 累積 interval 加算
- quarter
- week
- hour / minute / second
- DATETIME / TIME 系列
- interval 型
- `FROM GENERATE_SERIES(...)`
- table function alias
- 複数列生成
- timezone
- 利用者による10,000行上限 override
- JOIN 後の候補キー推論
- B160 の警告文言変更
- B128 Phase 2a の移動フレーム

## 19. 実装順序

1. `generateSeries.ts` の step 型を係数＋単位へ内部正規化する。
2. month / year の step parse と単位別エラーを追加する。
3. 月初・年初アンカー検証を追加する。
4. stop の方向別期間境界を算出する。
5. month / year の行数を生成前に算出する。
6. 10,000 行の既存ガードへ合流する。
7. start アンカー＋行番号から値を直接生成する。
8. 変数解決後の検証をリテラル経路と一致させる。
9. EXPLAIN の正規化 step 表示を追加する。
10. DATE メタと警告抑止の回帰を確認する。
11. 月次0埋め＋LAG、`LAST_DAY`、うるう年を追加する。
12. B158 統合テストを追加する。
13. 公開文書、MCP説明、smoke、release metadata を同期する。
14. CLI、dry-run、Firefox、Chrome の release gate を通す。

## 20. 完了条件

次をすべて満たした時点で B159 完了とする。

- month / months と year / years を受理する
- 係数付き、明示的正符号、負 step が動作する
- month は月初 start、year は年初 start に限定される
- stop 非アンカーでも stop を超えない
- 累積加算を使わない
- 出力は DATE
- 月末は `LAST_DAY` で取得できる
- `YYYY-MM` は `DATE_FORMAT` で取得できる
- うるう年2月が正しい
- step 0、非アンカー、上限超過の逐語エラーが一致する
- 向き逆は0行
- 行数を生成前に算出する
- WITH 内合計10,000行ガードを維持する
- 直接生成列の厳密単調性による警告抑止を維持する
- JOIN / CROSS JOIN 後は保守的な警告を維持する
- EXPLAIN が DATE、正規化 step、rows、row guard、API none を表示する
- dry-run の全 API が0回
- 空月が0で現れ、`LAG` が正しい1か月前を見る
- B158 との parser・AST 衝突がない
- B158 と組み合わせた月 × 製品の格子生成が動作する
- 既存の整数系列、day 系列、DATE メタ、上限、EXPLAIN に回帰がない
- CLI、Firefox、Chrome の v3.63.0 smoke が通る