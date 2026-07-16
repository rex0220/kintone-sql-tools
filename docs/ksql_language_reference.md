# kSQL 言語リファレンス

kSQL は kintone アプリを SQL ライクな構文で操作する言語です（プラグイン / CLI 対応）。  
本ドキュメントでは利用できる構文・演算子・関数をすべて説明します。

> 注記:
> 本書は言語仕様を中心に記載しています。CLI / プラグインの UI・運用オプションは補足扱いです。
> 実行時オプションの詳細は `README.md` および `docs/ksql_cli_console_spec.md` を参照してください。

---

## 目次

1. [基本ルール](#1-基本ルール)
2. [SELECT](#2-select)
3. [算術式](#3-算術式)
4. [CASE WHEN](#4-case-when)
5. [文字列・数値関数](#5-文字列数値関数)
6. [WHERE 句](#6-where-句)
7. [JOIN](#7-join)
8. [GROUP BY / 集計関数](#8-group-by--集計関数)
9. [HAVING](#9-having)
10. [ORDER BY](#10-order-by)
11. [LIMIT / OFFSET](#11-limit--offset)
12. [UNION / UNION ALL](#12-union--union-all)
13. [WITH 句（CTE）](#13-with-句cte)
14. [SHOW APPS / DESCRIBE](#14-show-apps--describe)
15. [INSERT](#15-insert)
16. [UPDATE](#16-update)
17. [UPSERT](#17-upsert)
18. [DELETE](#18-delete)
19. [サブテーブル仮想テーブル](#19-サブテーブル仮想テーブル)
20. [REORDER](#20-reorder)
21. [サブクエリ](#21-サブクエリ)
22. [制限事項](#22-制限事項)
23. [UI 機能](#23-ui-機能)
24. [EXPLAIN](#24-explain)
25. [バッチ実行と一時テーブル](#25-バッチ実行と一時テーブル)
26. [ASSERT](#26-assert)

---

## 1. 基本ルール

### テーブル名

kintone のアプリ ID を `APP` + 数字で指定します。

```sql
APP100      -- アプリ ID 100
APP42       -- アプリ ID 42
APP100$明細 -- アプリ ID 100 のサブテーブル「明細」
```

大文字・小文字は区別しません（`app100` も有効）。

### CLI 拡張: `APP@profile`

CLI ではテーブル参照の末尾に `@profile` を指定できます。

```sql
APP100@dev       -- APP100 を dev プロファイルで実行
APP80$明細@guest -- サブテーブル参照でも指定可能
```

ルール:

- `@profile` なしの `APPxxx` は既定 profile（`--profile` / config）を使用
- profile 名の大文字・小文字は区別しません（`APP100@Dev` も有効）
- 同一 SQL 内で同一 APP に異なる profile を混在可能（別環境の別アプリとして扱う）
- 文字列リテラル・コメント中の `APP100@dev` は `@profile` 構文として解釈しません
- プラグイン側では `@profile` 非対応です（`APP100@dev` を含む SQL はエラー）

### CLI / MCP 拡張: 論理アプリ参照 `LAPP_<NAME>`（v1.13.0）

同じ用途・同じフィールド構成のアプリで物理 ID だけが環境ごとに異なる場合、論理名を使用できます。

```sql
SELECT * FROM LAPP_ORDERS
SELECT * FROM LAPP_ORDERS@prod
SELECT * FROM LAPP_ORDERS$明細@prod
```

`LAPP_ORDERS` は実効 profile の `logicalApps.ORDERS` に設定された物理アプリ IDへ、実行前に解決されます。`APP100` は従来どおり常に物理 ID 100 であり、暗黙に論理解決されません。

```json
{
  "profiles": {
    "dev": { "logicalApps": { "ORDERS": 100 } },
    "prod": { "logicalApps": { "ORDERS": 1200 } }
  }
}
```

構文と制約:

- `LAPP_` と論理名は ASCII の範囲で大小文字を区別しない
- 論理名は `[A-Za-z][A-Za-z0-9_]{0,63}`
- config のキーは裸の論理名（`ORDERS`）。`APP100`、`100`、`LAPP_ORDERS` は禁止
- 未定義論理名、未知 profile、`allowPhysicalAppRefs: false` の profile に対する物理参照は API 呼び出し前にエラー
- validation は `source`、`logicalName`、内部 `mappedAppId`、最終 `appId`、`profile` を返す
- EXPLAIN と利用者向け診断は論理名・最終物理 ID・profile を表示し、内部 mapped ID は表示しない
- CLI の `DELETE FROM LAPP_ORDERS@prod ...` は明示 profile 制約により拒否。MCPでは許可
- Node.js runtime（CLI / MCP）の機能であり、プラグインでは非対応

### フィールド名（識別子）

- 日本語フィールドコードをクォートなしで使用できます
- スペース・特殊文字を含む名前はバッククォートで囲みます
- キーワード（`SELECT`、`FROM` 等）と同名のフィールドもバッククォートで囲みます

```sql
SELECT 金額, 担当者名 FROM APP100
SELECT `受注 金額`, `order` FROM APP100
```

### 文字列リテラル

シングルクォートで囲みます。  
文字列中のシングルクォートは `''`（2つ連続）でエスケープします。

```sql
WHERE ステータス = '完了'
WHERE 備考 = 'it''s done'   -- it's done
```

### 数値リテラル

整数・小数をそのまま記述します。

```sql
WHERE 金額 > 10000
WHERE 進捗率 >= 0.5
```

### 大文字・小文字

キーワード（`SELECT`、`WHERE` 等）は大文字・小文字を区別しません。  
フィールドコードは kintone の定義に従います（通常は区別あり）。

### セミコロン

文末のセミコロン（`;`）は任意です。

---

## 2. SELECT

### 基本構文

```sql
SELECT [DISTINCT] カラムリスト
[FROM テーブル名 [AS エイリアス]]
[JOIN句]
[WHERE 条件]
[GROUP BY フィールドリスト]
[HAVING 条件]
[ORDER BY キーリスト]
[LIMIT 件数 [OFFSET スキップ数]]
```

`FROM` は省略可能です（式専用 SELECT）。

```sql
SELECT 'xxx' AS a
SELECT 'ABC' as a;
```

制約:

- `FROM` 省略時は式列のみ対応（例: 文字列リテラル、数値演算、関数）
- `SELECT *` / フィールド参照（例: `SELECT 顧客名`）は非対応

### 全フィールド取得

```sql
SELECT * FROM APP100
```

### 特定フィールド指定

```sql
SELECT 氏名, 金額, ステータス FROM APP100
```

### 文字列リテラル列

```sql
SELECT 顧客名, 'XXX' AS a FROM APP60
```

文字列リテラル列は `AS` でエイリアスを付けて利用できます。

```sql
SELECT 'XXX' AS a
```

### AS エイリアス

```sql
SELECT 氏名 AS name, 金額 AS amount FROM APP100
```

### DISTINCT（重複除去）

```sql
SELECT DISTINCT 都道府県 FROM APP100
SELECT DISTINCT ステータス, 担当者 FROM APP100
```

### JOIN での修飾フィールド参照

JOIN を使う場合、`エイリアス.フィールド名` の形式で指定します。

```sql
SELECT a.氏名, b.金額
FROM APP100 AS a
INNER JOIN APP200 AS b ON a.顧客ID = b.顧客ID
```

`FROM/JOIN` のテーブル alias は `AS` 省略形も使用できます。

```sql
SELECT a.氏名, b.金額
FROM APP100 a
INNER JOIN APP200 b ON a.顧客ID = b.顧客ID
```

---

## 3. 算術式

SELECT 列・WHERE 句・ORDER BY・UPDATE SET で四則演算を使用できます。

| 演算子 | 意味 |
|--------|------|
| `+` | 加算 |
| `-` | 減算 |
| `*` | 乗算 |
| `/` | 除算（ゼロ除算は NaN） |
| `%` | 剰余・余り（ゼロ除算は NaN） |

```sql
-- SELECT 列で算術式
SELECT 単価 * 数量 AS 小計 FROM APP100
SELECT 金額 * 1.1 AS 税込金額 FROM APP100
SELECT (売上 - 原価) / 売上 AS 粗利率 FROM APP100
SELECT 数量 % 3 AS 余り FROM APP100

-- 関数の結果も被演算子として使用可能
SELECT ROUND(合計費用) / 2 AS 半額 FROM APP100
SELECT LENGTH(顧客名) * 100 AS スコア FROM APP100

-- WHERE 句の左辺・右辺に算術式（FULL_SCAN モードで実行）
WHERE 金額 * 1.1 > 10000
WHERE (単価 + 送料) * 数量 < 5000
WHERE 税込金額 = 金額 * 1.1
```

演算子の優先順位は通常の算術規則（`*` `/` > `+` `-`）に従い、カッコで明示指定できます。

> **WHERE 算術式は FULL_SCAN モード:** kintone API に変換できないため全件取得後 JS で評価します。

---

## 4. CASE WHEN

条件分岐した値を返します。SELECT 列・WHERE 句・UPDATE SET で使用できます。

```sql
CASE
  WHEN 条件1 THEN 値1
  WHEN 条件2 THEN 値2
  ...
  [ELSE デフォルト値]
END [AS エイリアス]
```

### SELECT 列での使用

```sql
SELECT
  氏名,
  CASE
    WHEN 金額 >= 100000 THEN '大口'
    WHEN 金額 >= 10000  THEN '中口'
    ELSE '小口'
  END AS 顧客区分
FROM APP100
```

```sql
-- THEN に算術式・関数
SELECT
  CASE
    WHEN ステータス = '割引' THEN ROUND(金額 * 0.9)
    ELSE 金額
  END AS 請求金額
FROM APP100
```

### WHERE 句での使用

WHERE 句の左辺・右辺に CASE WHEN を使用できます（FULL_SCAN モードで実行）。

```sql
-- 左辺: 区分に応じて比較値を切り替え
WHERE CASE
    WHEN 区分 = '特別' THEN 金額
    ELSE 0
  END > 1000

-- 右辺: 区分ごとに閾値を変える
WHERE スコア > CASE
    WHEN ランク = 'A' THEN 80
    ELSE 50
  END
```

### UPDATE SET での使用

```sql
UPDATE APP100
SET 顧客ランク = CASE
    WHEN 金額 >= 100000 THEN 'S'
    WHEN 金額 >= 10000  THEN 'A'
    ELSE 'B'
  END
WHERE ステータス = '対象'
```

THEN / ELSE に配列リテラルを指定すると、フィールド型に応じてユーザー選択・チェックボックス等に書き込めます。

```sql
-- ユーザー選択: ステータスに応じて担当者を切り替え
UPDATE APP89
SET 担当者 = CASE
    WHEN 優先度 = '高' THEN ['user1', 'user2']
    ELSE 'user3'
  END
WHERE ステータス = '未着手'

-- チェックボックス: IF() 短縮記法
UPDATE APP89
SET タグ = IF(顧客ランク = 'A', ['重要', 'VIP'], '通常')
WHERE 担当者 = 'user1'
```

### 共通ルール

- THEN / ELSE の値には文字列リテラル・数値・フィールド参照・算術式・関数呼び出し・**配列リテラル `[...]`** を使用できます
- ELSE を省略すると、どの条件にも合致しない場合に空文字（NULL 相当）を返します
- IF(条件, then値, else値) は CASE WHEN の短縮記法として使用できます
- 配列リテラルを THEN/ELSE で返す場合、フィールド型に応じて自動変換されます（INSERT VALUES / UPDATE SET）

---

## 5. 文字列・数値関数

関数は SELECT 列・WHERE 左辺・ORDER BY・CASE WHEN の THEN/ELSE で使用できます。  
関数の結果は算術式の被演算子としても使用できます。

### 文字列関数

| 関数 | 構文 | 説明 |
|------|------|------|
| `UPPER` | `UPPER(フィールド)` | 大文字変換 |
| `LOWER` | `LOWER(フィールド)` | 小文字変換 |
| `TRIM` | `TRIM(フィールド)` | 前後の空白を除去 |
| `LTRIM` | `LTRIM(フィールド)` | 左側の空白を除去 |
| `RTRIM` | `RTRIM(フィールド)` | 右側の空白を除去 |
| `LENGTH` | `LENGTH(フィールド)` | 文字数を返す |
| `SUBSTRING` | `SUBSTRING(フィールド, 開始, [長さ])` | 部分文字列（1-indexed） |
| `CONCAT` | `CONCAT(値1, 値2, ...)` | 文字列の連結（可変長引数） |
| `REPLACE` | `REPLACE(フィールド, 検索, 置換)` | 文字列置換 |
| `COALESCE` | `COALESCE(値1, 値2, ...)` | 最初の非空値を返す |
| `ISNULL` | `ISNULL(値, 代替値)` | 値が空なら代替値、それ以外は値（`COALESCE` の 2 引数版） |
| `NULLIF` | `NULLIF(値1, 値2)` | 値1 と 値2 が等しければ空文字、それ以外は 値1 |

```sql
SELECT UPPER(ステータス) AS ステータス FROM APP100
SELECT CONCAT(姓, '　', 名) AS 氏名 FROM APP100
SELECT SUBSTRING(郵便番号, 1, 3) AS 市外局番 FROM APP100
SELECT REPLACE(電話番号, '-', '') AS 電話番号 FROM APP100
SELECT COALESCE(メモ, '（なし）') AS メモ FROM APP100
SELECT ISNULL(建物名, '（なし）') AS 建物名 FROM APP100
SELECT NULLIF(業種, 'その他') AS 業種 FROM APP100   -- 'その他' を空にする
```

> **`ISNULL` は 2 引数（SQL Server 系）です。** MySQL の 1 引数 `ISNULL(式)`（真偽を返す）とは**別物**です。空判定には `IS NULL` / `IS NOT NULL`（→ [§6](#6-where-句)）を使ってください。

> **`NULLIF` によるゼロ除算ガードは効きません。** kintone には NULL がなく kSQL では**空文字が NULL 相当**のため、`NULLIF(x, 0)` の結果（空文字）を除数にすると `Number('') = 0` となり、結局ゼロ除算で `NaN` になります。
>
> ```sql
> -- ✗ RDB の定番だが kSQL では NaN（ガードにならない）
> SELECT 1000 / NULLIF(金額, 0) AS 単価 FROM APP100   -- 金額=0 の行は NaN
>
> -- ○ NULL 置換としては正しく機能する
> SELECT ISNULL(NULLIF(金額, 0), '未設定') AS 金額 FROM APP100   -- 金額=0 の行は「未設定」
>
> -- ○ ゼロ除算を避けたい場合は CASE WHEN を使う
> SELECT CASE WHEN 金額 = 0 THEN '' ELSE 1000 / 金額 END AS 単価 FROM APP100
> ```

### 数値関数

| 関数 | 構文 | 説明 |
|------|------|------|
| `ROUND` | `ROUND(フィールド [, 桁])` | 四捨五入 |
| `FLOOR` | `FLOOR(フィールド [, 桁])` | 切り捨て |
| `CEIL` | `CEIL(フィールド [, 桁])` | 切り上げ（`CEILING` も可） |

桁数の指定:
- 正の整数: 小数点以下 n 桁で丸める
- `0`（省略時）: 整数に丸める
- 負の整数: 10^n の単位で丸める

```sql
SELECT ROUND(金額, 2)  AS 金額   FROM APP100   -- 例: 1234.567 → 1234.57
SELECT ROUND(金額)     AS 金額   FROM APP100   -- 例: 1234.5   → 1235
SELECT ROUND(金額, -3) AS 千単位 FROM APP100   -- 例: 1234567  → 1235000
SELECT FLOOR(金額, -2) AS 百未満切捨 FROM APP100
```

### 数学関数

| 関数 | 構文 | 説明 |
|------|------|------|
| `ABS` | `ABS(フィールド)` | 絶対値 |
| `MOD` | `MOD(フィールド, 除数)` | 剰余（`%` 演算子と同等） |
| `POWER` | `POWER(フィールド, 指数)` | 累乗（`POW` も可） |
| `SQRT` | `SQRT(フィールド)` | 平方根 |

```sql
SELECT ABS(差額) AS 差額絶対値 FROM APP100
SELECT MOD(数量, 3) AS 余り FROM APP100       -- 数量 % 3 と同等
SELECT POWER(辺長, 2) AS 面積 FROM APP100
SELECT ROUND(SQRT(面積), 2) AS 辺長 FROM APP100
```

### FORMAT 関数

| 関数 | 構文 | 説明 |
|------|------|------|
| `FORMAT` | `FORMAT(フィールド, パターン)` | 書式整形 |

パターンには Excel 風の書式文字列または整数（MySQL スタイル）を指定します。

| パターン | 入力 | 出力 |
|---------|------|------|
| `'#,##0'` | 1234567 | `1,234,567` |
| `'#,##0.00'` | 1234.5 | `1,234.50` |
| `'0.00'` | 1234.5 | `1234.50` |
| `'0.00%'` | 0.156 | `15.60%` |
| `'#,##0.##'` | 1234.5 | `1,234.5` |
| `2`（整数） | 1234.5 | `1,234.50` |

```sql
SELECT FORMAT(金額, '#,##0') AS 金額表示 FROM APP100
SELECT FORMAT(達成率, '0.00%') AS 達成率表示 FROM APP100
```

### 型変換関数

| 関数 | 構文 | 説明 |
|------|------|------|
| `CAST` | `CAST(フィールド AS 型)` | 型変換 |
| `CONVERT` | `CONVERT(フィールド, 型)` | 型変換（`CAST` の別記法） |

型名: `TEXT` / `VARCHAR` / `CHAR` → 文字列、`NUMBER` / `INT` / `INTEGER` / `DECIMAL` / `FLOAT` → 数値

```sql
SELECT CAST(金額 AS TEXT) AS 金額文字列 FROM APP100
SELECT CAST(コード AS NUMBER) AS コード数値 FROM APP100
```

### 日付・日時関数

| 関数 | 構文 | 説明 |
|------|------|------|
| `YEAR` | `YEAR(フィールド)` | 年を返す |
| `MONTH` | `MONTH(フィールド)` | 月を返す（1〜12） |
| `DAY` | `DAY(フィールド)` | 日を返す（1〜31） |
| `DATE_FORMAT` | `DATE_FORMAT(フィールド, フォーマット)` | 日付を書式化 |
| `DATEDIFF` | `DATEDIFF(日付1, 日付2)` | 日数差（日付1 − 日付2） |
| `DATE_ADD` | `DATE_ADD(フィールド, INTERVAL n UNIT)` | 日付加算 |
| `CURRENT_DATE()` | `CURRENT_DATE()` | 今日の日付（`YYYY-MM-DD`）を JS で取得 |
| `CURRENT_TIMESTAMP()` | `CURRENT_TIMESTAMP()` | 現在日時（ISO 8601）を JS で取得 |

```sql
SELECT YEAR(作成日時) AS 年, MONTH(作成日時) AS 月 FROM APP100
SELECT DATEDIFF(TODAY(), 期限日) AS 残日数 FROM APP100
SELECT DATE_FORMAT(作成日時, '%Y-%m') AS 年月 FROM APP100

-- SELECT 列で現在日時を付加（常に JS 評価）
SELECT 顧客名, 金額, CURRENT_TIMESTAMP() AS 取得日時 FROM APP100
SELECT *, CURRENT_DATE() AS 今日 FROM APP100

-- WHERE でも使用可能（FULL_SCAN）
SELECT * FROM APP100 WHERE 作成日 = CURRENT_DATE()
```

> **`CURRENT_DATE()` / `CURRENT_TIMESTAMP()` はキーワードではありません。**  
> `()` があれば関数、なければフィールド参照として扱われます。  
> kintone 専用の `TODAY()` / `NOW()` と異なり、SELECT 列でも使用できます。

### 関数のネスト

関数の引数に別の関数を指定できます。

```sql
SELECT UPPER(TRIM(氏名)) AS 氏名 FROM APP100
SELECT ROUND(金額 * 1.1, 0) AS 税込金額 FROM APP100
```

---

## 6. WHERE 句

### 比較演算子

| 演算子 | 意味 |
|--------|------|
| `=`    | 等しい |
| `!=` または `<>` | 等しくない |
| `>`    | より大きい |
| `<`    | より小さい |
| `>=`   | 以上 |
| `<=`   | 以下 |
| `KLIKE` | kintone のキーワードを含む |
| `NOT KLIKE` | kintone のキーワードを含まない |

```sql
WHERE ステータス = '完了'
WHERE 金額 >= 100000
WHERE 担当者 != '山田'
```

> 右辺の値にはバッチ変数 `@名前` も指定できます（→ [§25 バッチ変数](#25-バッチ実行と一時テーブル)）。

### KLIKE / NOT KLIKE（kintoneキーワード検索）

`KLIKE` はSQL `LIKE`とは別の演算子です。条件をkintoneの `like` / `not like` へ変換し、kintone側でキーワード検索します。

```sql
SELECT 件名, 担当者
FROM APP100
WHERE 件名 KLIKE '至急'

SELECT 件名
FROM APP100
WHERE 件名 NOT KLIKE '保留'
```

- `LIKE` はkSQLのワイルドカード／部分一致をJavaScriptで評価します。`KLIKE` はkintoneのキーワード検索であり、半角・全角、大小文字、単語分割などの一致規則はkintoneに準拠します。**SQLの部分一致とは異なる**点に注意してください。
  - **一致挙動は文字種・用字系によって異なります**（詳細はkintoneの検索仕様に準拠）。**今回の実機観測**では次のとおりでした。**英数字例は空白区切りの語（トークン）単位**で一致し語の一部では一致せず、**日本語例は2文字以上の部分一致（中間を含む）**で一致し1文字では一致しませんでした。

    | 検索 | 対象の値 | 一致（観測例） |
    |---|---|---|
    | `KLIKE 'TOKYO'` | `TOKYO TO` | ○（空白区切りの語 `TOKYO`） |
    | `KLIKE 'TOK'` / `'OKYO'` | `TOKYO TO` | ×（語の一部では一致しない） |
    | `KLIKE 'A'` | `A1` | ×（`A1` で1語） |
    | `KLIKE '丸の'` / `'の内'` | `丸の内` | ○（2文字以上の部分一致・中間を含む） |
    | `KLIKE '内'` | `丸の内` | ×（1文字では一致しない） |

    > 上記は観測された例であり、kintoneの一致規則を網羅的に定義するものではありません。半角・全角、大小文字、記号の扱い等はkintoneの仕様に従います。
  - 迷ったら、確実に部分一致させたい場合は `LIKE`（JavaScript評価・FULL_SCAN）を、kintone側で高速に絞り込みたい場合は `KLIKE` を使い分けてください。
- **性能**: `LIKE` はFULL_SCANになり、AND条件に押し下げ可能な安全述語（`$id`・型確認済みNUMBERの `=` と安全整数との厳密な `<` / `>`・選択系 `IN` など）がなければ全件取得になります。大規模アプリでは取得上限（`maxRecords`）に達してエラーになりがちです。`KLIKE` はSIMPLEのままkintone側で検索するため、大規模アプリでも高速です（例: 数十万件規模のアプリで `都道府県 LIKE '%東京%'` は上限エラー、`都道府県 KLIKE '東京都'` は即応）。ただし下記の10万件打ち切りに注意。
- SIMPLE SELECTでは従来どおりWHERE全体をkintoneへ渡します。FULL_SCAN SELECTでも、KLIKEがWHEREルートからANDと括弧だけを経由する安全なリーフなら、kintoneへプレフィルタ押し下げして残りの条件をJavaScriptで精製します。これによりKLIKEと`LIKE`・関数・集計・`DISTINCT`を併用できます。
  ```sql
  -- 件名はkintoneで粗く絞り、備考はkSQLの部分一致で精製
  SELECT 件名, 備考 FROM APP100
  WHERE 件名 KLIKE '至急' AND 備考 LIKE '%緊急%'
  ```
- FULL_SCANでの制約: ORまたは`NOT (...)`配下、サブテーブル、CTE／一時テーブル上のKLIKEは使用できません。JOINとの併用は、すべてのJOINが`INNER JOIN`で、KLIKEのフィールドをテーブルエイリアスで明示した場合だけ許可します。`LEFT JOIN` / `RIGHT JOIN`を含むSELECTでは、安全側にKLIKEを拒否します。直接の`NOT KLIKE`はANDリーフとして使用できます。
- 右辺は単一引用符の文字列または文字列バッチ変数に限定されます。`%` は使用できません。`_` は使用できますが、1文字ワイルドカードではなくkintone検索上の単語構成文字です。
- UPDATE、DELETE、INSERT ... SELECT、UPSERT ... SELECT、REORDERを含むすべてのDMLでは引き続き使用できません。
- 利用可能なフィールドは[kintone公式の演算子対応表](https://cybozu.dev/ja/kintone/docs/overview/query/)に従います。文字列1行・複数行、リッチエディター、リンク、添付ファイルなどが対象です。非対応フィールドはkintone APIエラーになります。
- kintoneはキーワード一致が10万件に達すると検索を打ち切ります。CLI / MCP はレスポンス警告を検出し、SELECT では結果欠落の可能性を警告します。読み取り結果を書き込みや一時テーブル実体化に使う場合は、不完全な対象集合で実行しないようエラーにします。プラグインの `kintone.api()` はレスポンスヘッダーを公開しないため、現時点ではこの打ち切りを検出できません。プラグインでは十分に絞り込めるキーワードを指定してください。
- `KLIKE` は予約語です。同名フィールドを参照するときは `` `KLIKE` `` と記述します。

### IN / NOT IN（複数値一致・除外）

```sql
WHERE ステータス IN ('進行中', '完了', 'レビュー中')
WHERE 区分 IN (1, 2, 3)
WHERE ステータス NOT IN ('キャンセル', '却下')
```

> **IN リストの値**は、単一引用符の文字列 `'...'`・数値・バッチ変数 `@名前` を指定できます（**1 要素以上が必須**）。文字列リテラルはダブルクォートではなく単一引用符で囲みます（`IN ("A")` は構文エラー、`IN ()` も要素が必要でエラー）。空文字 `IN ('')` は「空／未設定セル」を表します（下記）。

FULL_SCAN で複数値フィールドを評価する場合も、kintone の `in` / `not in` と同じ単位で比較します。

- チェックボックス・複数選択は、選択値のいずれかが IN リストに含まれるかを判定します。
- ユーザー・組織・グループ選択・作業者は、表示名ではなく `code` を比較します。
- 作成者・更新者もユーザー `code` を比較します。
- 型情報を取得できない値や、型と値の形が一致しない場合は従来の文字列比較を維持します。
- v2.6.0 以降、選択系の空／未設定セルは kintone と同じく `IN ('')` に一致し、`NOT IN ('')` では除外されます。空スカラー値の投影も空文字として返します。

この規則はリテラル／バッチ変数の IN リストと `IN (SELECT ...)` の両方、およびサブテーブルを JavaScript 側で評価する経路に適用されます。

```sql
-- 空／未設定の選択セルを抽出（ドロップダウンは = '' が使えないため IN ('') を使う）
WHERE ドロップダウン IN ('')            -- 未選択のレコード
WHERE ドロップダウン NOT IN ('')        -- 選択済みのレコード
WHERE ドロップダウン IN ('', '対応中')  -- 未選択 または「対応中」
```

v2.6.0 以降、FULL_SCAN の `WHERE` では、フィールド型と選択肢の実在を確認できた
`DROP_DOWN`／`RADIO_BUTTON`／`CHECK_BOX`／`MULTI_SELECT` の `IN`／`NOT IN`
（空でない文字列リテラルのみ）を kintone の事前絞り込みにも使用します。結果は取得後に同じ型付き規則で再評価します。
存在しない選択肢、空文字、型情報・選択肢情報を取得できない場合は押し下げず、JavaScript 評価だけを行います。
ユーザー・組織・グループ選択はこの最適化の対象外です。v2.7.0 以降、プロセス管理が有効で、実行ユーザーの表示言語における状態名の実在を確認できたステータスの `IN`／`NOT IN` も事前絞り込みに使用します。プロセス管理が無効、状態名が非実在、または空文字の場合は押し下げません。

### IN (SELECT ...) / NOT IN (SELECT ...)（サブクエリ）

別アプリの検索結果を IN リストとして使用できます。

```sql
-- APP88 から「ランク A」の顧客名一覧を取得してフィルタ
SELECT * FROM APP88
WHERE 顧客名 IN (SELECT 顧客名 FROM APP89 WHERE 顧客ランク = 'A')

-- 除外
SELECT * FROM APP88
WHERE 顧客名 NOT IN (SELECT 顧客名 FROM APP89 WHERE ステータス = '停止')
```

- サブクエリは SELECT 1列目（または `SELECT フィールド名`）の値セットを返します
- 自動的に FULL_SCAN モードで実行されます
- サブクエリ自体も SIMPLE / FULL_SCAN を自動判定します

### EXISTS / NOT EXISTS（サブクエリ）

サブクエリが 1 件以上返すかどうかで条件を判定します（非相関のみ）。

```sql
-- サブクエリが 1件以上あれば全行を返す
SELECT * FROM APP88
WHERE EXISTS (SELECT $id FROM APP89 WHERE ステータス = '承認済み')

-- サブクエリが 0件なら全行を返す
SELECT * FROM APP88
WHERE NOT EXISTS (SELECT $id FROM APP89 WHERE フラグ = 'NG')

-- AND / OR と組み合わせ
SELECT 顧客名, 金額 FROM APP88
WHERE 金額 > 10000
  AND EXISTS (SELECT $id FROM APP89 WHERE 承認フラグ = '1')
```

- サブクエリは 1 回だけ実行され、全行に同じ結果（真/偽）が適用されます
- **相関サブクエリは非対応**（外側テーブルのフィールドをサブクエリ内で参照不可）
- 自動的に FULL_SCAN モードで実行されます

### スカラーサブクエリ（WHERE 右辺）

比較演算子の右辺に 1 行 1 列を返すサブクエリを指定できます。

```sql
-- 全体の平均と比較
SELECT * FROM APP100
WHERE 金額 > (SELECT AVG(金額) FROM APP100)

-- 別アプリの最大値と比較
SELECT * FROM APP100
WHERE 金額 >= (SELECT MAX(上限金額) FROM APP200 WHERE 区分 = '標準')
```

- サブクエリは 1 行 1 列を返す必要があります（0 行または 2 行以上はエラー）
- GROUP BY なしの集計サブクエリ（`AVG(...)` 等）は対象 0 件でも 1 行（値 `0`）を返すためエラーになりません（§8「0 件時の挙動」— v1.12.0）
- **相関サブクエリは非対応**（外側テーブルのフィールドをサブクエリ内で参照不可）
- 自動的に FULL_SCAN モードで実行されます

### BETWEEN（範囲指定）

`BETWEEN a AND b` は `>= a AND <= b` と同等です。

```sql
WHERE 金額 BETWEEN 10000 AND 50000
WHERE 作成日時 BETWEEN '2024-01-01' AND '2024-12-31'
```

### LIKE / NOT LIKE（部分一致・除外）

| ワイルドカード | 意味 |
|----------------|------|
| `%`            | 0文字以上の任意の文字列 |
| `_`            | 任意の1文字 |

```sql
WHERE 氏名 LIKE '田%'        -- 「田」で始まる
WHERE メモ LIKE '%重要%'     -- 「重要」を含む
WHERE コード LIKE 'A__'      -- 「A」+任意2文字
WHERE 氏名 NOT LIKE '田%'    -- 「田」で始まらない
WHERE 顧客名 LIKE '会社'     -- 「会社」を含む（ワイルドカードなし＝部分一致）
```

> **v2.0.0以降の評価経路（Breaking）**<br>
> `LIKE` / `NOT LIKE`はワイルドカードの有無にかかわらずkintoneへ渡さず、全件取得後にJavaScriptで評価します。`%` / `_`付きは上表のSQLワイルドカード、ワイルドカードなしの`LIKE '会社'`はkSQL独自仕様の部分一致（`includes`）です。kintoneの単語（トークン）検索には委譲しません。<br>
> LIKEを含むSELECTはFULL_SCANになります。ANDで併記した安全な`$id`条件、型確認済みNUMBER条件、実在確認済み選択系`IN`／`NOT IN`は事前絞り込みに使われますが、それ以外は全件取得になります。大量レコードでは走査件数が`maxRecords`へ到達し、既定ではエラーになります。`onLimitReached = "truncate"`を選ぶと上限以降の一致行を欠落させる可能性があります。<br>
> 通常の親レコードに対する`UPDATE` / `DELETE`では、すべての`LIKE` / `NOT LIKE`を拒否します。先に上限エラーのないSELECTで対象レコード番号を確認し、`IN`または完全一致条件で対象を指定してください。サブテーブルDMLはJavaScript評価経路のため従来どおり使用できます。

### IS NULL / IS NOT NULL

kintone では空文字（`""`）を NULL として扱います。

```sql
WHERE 備考 IS NULL           -- 備考が空のレコード
WHERE 担当者 IS NOT NULL     -- 担当者が設定されているレコード
```

### 論理演算子

優先順位: `NOT` > `AND` > `OR`

```sql
WHERE ステータス = '完了' AND 金額 > 50000
WHERE 部署 = '営業部' OR 部署 = '開発部'
WHERE NOT ステータス = 'キャンセル'
```

カッコで優先順位を明示できます。

```sql
WHERE (ステータス = '完了' OR ステータス = '承認済') AND 金額 > 10000
```

### WHERE での関数使用

WHERE 句の左辺に関数を使用できます。  
この場合、自動的に FULL_SCAN モードで実行されます。

```sql
WHERE UPPER(ステータス) = 'ACTIVE'
WHERE LOWER(メールアドレス) LIKE '%@example.com'
WHERE LENGTH(コード) > 5
WHERE TRIM(氏名) != ''
WHERE SUBSTRING(郵便番号, 1, 3) = '100'
```

### kintone 専用関数

| 関数 | 意味 |
|------|------|
| `TODAY()` | 今日の日付（`YYYY-MM-DD` 形式） |
| `NOW()`   | 現在日時（ISO 8601 形式） |
| `LOGINUSER()` | ログイン中のユーザー（kintone 環境のみ有効） |

```sql
WHERE 作成日時 >= TODAY()
WHERE 期限日 < TODAY()
WHERE 担当者 = LOGINUSER()
```

---

## 7. JOIN

INNER JOIN・LEFT JOIN・RIGHT JOIN に対応しています。  
複数の JOIN を連鎖して 3テーブル以上の結合も可能です。  
結合条件は等値結合（`ON a.フィールド = b.フィールド`）のみ対応。

### INNER JOIN

両テーブルで結合条件を満たす行のみ返します。

```sql
SELECT a.氏名, b.商品名, b.金額
FROM APP100 AS a
INNER JOIN APP200 AS b ON a.顧客ID = b.顧客ID
```

`INNER` は省略可能（`JOIN` のみで INNER JOIN 扱い）。

```sql
FROM APP100 AS a
JOIN APP200 AS b ON a.顧客ID = b.顧客ID
```

### LEFT JOIN

左テーブルの全行 + 結合条件を満たす右テーブルの行を返します。  
右テーブルにマッチしない場合、右側のフィールドは空文字になります。

```sql
SELECT a.氏名, b.金額
FROM APP100 AS a
LEFT JOIN APP200 AS b ON a.顧客ID = b.顧客ID
```

### RIGHT JOIN

右テーブルの全行 + 結合条件を満たす左テーブルの行を返します。  
左テーブルにマッチしない場合、左側のフィールドは空文字になります。

```sql
SELECT a.金額, b.顧客名
FROM APP100 AS a
RIGHT JOIN APP200 AS b ON a.顧客ID = b.顧客ID
```

### 3テーブル以上の JOIN（複数 JOIN 連鎖）

```sql
SELECT a.氏名, b.商品名, c.配送先
FROM APP100 AS a
INNER JOIN APP200 AS b ON a.注文ID = b.注文ID
LEFT  JOIN APP300 AS c ON a.配送ID = c.配送ID
```

> **注意:** JOIN を使うと全件取得（FULL_SCAN モード）になるため、  
> 大量レコードの場合はパフォーマンスに注意してください。

---

## 8. GROUP BY / 集計関数

### GROUP BY

```sql
SELECT 部署, COUNT(*) AS 件数
FROM APP100
GROUP BY 部署
```

```sql
SELECT 担当者, ステータス, SUM(金額) AS 合計
FROM APP100
GROUP BY 担当者, ステータス
```

### 集計関数

| 関数 | 意味 | NULL/空の扱い |
|------|------|---------------|
| `COUNT(*)` | 全行数 | NULL を含む全行を数える |
| `COUNT(フィールド)` | 空でない行数 | 空文字・NULL はスキップ |
| `SUM(フィールド)` | 合計 | 空文字・NULL はスキップ |
| `AVG(フィールド)` | 平均 | 空文字・NULL はスキップ |
| `MAX(フィールド)` | 最大値 | 空文字・NULL はスキップ |
| `MIN(フィールド)` | 最小値 | 空文字・NULL はスキップ |
| `GROUP_CONCAT([DISTINCT] 引数 [SEPARATOR '区切り'])` | 文字列連結 | 空文字・NULL はスキップ |

> **`MAX`/`MIN` の比較規則**: 実アプリの NUMBER と数値形式 CALC は数値順、テキスト・選択・日時フィールドと文字列形式 CALC は UTF-16 辞書順で比較します。日時の時系列順と一致するのは kintone が返す正規化形式（DATE=`YYYY-MM-DD`、TIME=`HH:mm`、DATETIME/作成日時/更新日時=`...Z`）が前提です。v2.15.0 以降は、確定できた型メタが一時テーブル/CTEにも伝播するため、素通し列・集約・算術・リテラルを経由した再集約でも同じ比較規則を使います。複数値・ユーザー等の対象外型、同名列が競合する JOIN、型を確定しない文字列関数・CASE・スカラーサブクエリ由来の列は、従来の数値経路を使うため非数値値が `NaN` になります。

```sql
SELECT COUNT(*) AS 総件数, SUM(金額) AS 合計金額, AVG(金額) AS 平均金額
FROM APP100
WHERE ステータス = '完了'
```

### GROUP_CONCAT（v2.15.0）

`GROUP_CONCAT` はグループ内の空でない値を収集順に連結します。既定の区切り文字は `,` です。

```sql
SELECT 顧客ID, GROUP_CONCAT(担当者) AS 担当者一覧
FROM APP100 GROUP BY 顧客ID

SELECT 顧客ID, GROUP_CONCAT(DISTINCT 業種 SEPARATOR ' / ') AS 業種一覧
FROM APP100 GROUP BY 顧客ID
```

- `DISTINCT` は文字列として重複を除き、最初に現れた順序を保ちます
- `SEPARATOR` には文字列リテラルだけを指定できます。`SEPARATOR ''` は区切りなしです
- `GROUP_CONCAT(*)` と `GROUP_CONCAT(DISTINCT *)` は使用できません
- 関数内の `ORDER BY` は未対応です。連結順は WHERE / JOIN 適用後の収集順であり、取得順が変われば結果も変わり得ます
- 結果を長さで切り捨てません。書き込み先フィールドの最大文字数を超えた場合は書き込み時の検証エラーになります
- `GROUP_CONCAT` は予約語です。同名フィールドは `` `GROUP_CONCAT` `` とバッククォートで囲みます。`SEPARATOR` は通常のフィールド名としても使えます

### DISTINCT 付き集計

```sql
SELECT COUNT(DISTINCT 担当者) AS 担当者数 FROM APP100
SELECT COUNT(DISTINCT 都道府県) AS 都道府県数 FROM APP100
```

### 0 件時の挙動（v1.12.0）

GROUP BY のない集計クエリは、対象が 0 件でも**常に 1 行**を返します（SQL 標準準拠）。

```sql
-- 該当 0 件でも「COUNT(*) = 0」の 1 行が返る
SELECT COUNT(*) FROM APP100 WHERE 異常フラグ = '1'
```

| 集計 | 0 件時の値 |
|------|-----------|
| `COUNT(*)` / `COUNT(f)` / `COUNT(DISTINCT f)` | `0` |
| `SUM` / `AVG` / `MAX` / `MIN` | `0`（**標準 SQL の NULL とは異なります**） |
| `GROUP_CONCAT` | `""`（空文字） |

- 「対象なし（COUNT = 0）」と「合計が 0」を区別したい場合は COUNT を併用してください
- GROUP BY が**ある**場合は従来どおり 0 行を返します（グループが存在しないため）
- これにより ASSERT の健全性チェック `ASSERT (SELECT COUNT(*) ... WHERE 異常条件) = 0` が該当 0 件（健全時）に成立します（§26 ASSERT）

---

## 9. HAVING

GROUP BY 後の集計結果に対してフィルタをかけます。  
HAVING 句には集計関数・GROUP BY フィールドを使用できます。

```sql
SELECT 部署, COUNT(*) AS 件数
FROM APP100
GROUP BY 部署
HAVING COUNT(*) >= 5
```

```sql
SELECT 担当者, SUM(金額) AS 合計
FROM APP100
GROUP BY 担当者
HAVING SUM(金額) > 1000000
```

WHERE との違い:
- `WHERE` — 集計前のレコードに対してフィルタ
- `HAVING` — 集計後のグループに対してフィルタ

```sql
SELECT 担当者, COUNT(*) AS 件数
FROM APP100
WHERE ステータス = '完了'     -- 集計前フィルタ
GROUP BY 担当者
HAVING COUNT(*) >= 3          -- 集計後フィルタ
```

---

## 10. ORDER BY

### 基本

```sql
SELECT * FROM APP100
ORDER BY 作成日時 DESC

SELECT * FROM APP100
ORDER BY 部署 ASC, 金額 DESC
```

- `ASC` — 昇順（省略可、デフォルト）
- `DESC` — 降順

数値として解釈できるフィールドは数値比較、それ以外は文字列（日本語対応）で比較します。

### 算術式・関数によるソート

ORDER BY のキーに算術式や関数を指定できます。  
この場合、自動的に FULL_SCAN モードで実行されます。

```sql
-- 算術式
ORDER BY 単価 * 数量 DESC
ORDER BY (売上 - 原価) / 売上 DESC

-- 関数
ORDER BY UPPER(顧客名) ASC
ORDER BY LENGTH(氏名) ASC
ORDER BY ROUND(金額, -3) DESC
```

---

## 11. LIMIT / OFFSET

取得件数の上限とスキップ件数を指定します。

```sql
SELECT * FROM APP100 LIMIT 10
SELECT * FROM APP100 ORDER BY 作成日時 DESC LIMIT 50
SELECT * FROM APP100 ORDER BY 作成日時 DESC LIMIT 20 OFFSET 40
```

- `LIMIT n` — 最大 n 件を返す
- `OFFSET m` — 先頭 m 件をスキップしてから返す（ページング用）

> **デフォルト上限:** LIMIT 未指定時のエンジン上限は最大 **10,000 件** です。  
> CLI 既定値は `--max-records=500` のため、CLI 実行時は 500 件で制御されます。  
> 超過した場合はエラーになります。

> **`LIMIT > 500` の早期停止（v2.11.0）:** SIMPLE モードで `ORDER BY` がなく KLIKE を含まない場合、`OFFSET + LIMIT` 件を取得した時点で正常終了します。`maxRecords` は実際に取得する行数の上限であるため、`OFFSET + LIMIT <= maxRecords` なら一致総数が上限を超えていても上限エラー／truncate 警告は出ません。`ORDER BY` 付き・KLIKE・`OFFSET + LIMIT > maxRecords` は従来どおりです。

> **SIMPLE モード（JOIN なし）:** `LIMIT <= 500` の OFFSET は kintone API に直接渡されます。`LIMIT > 500` はページング取得後に適用されます。
> **FULL_SCAN モード（JOIN あり等）:** JS 側でスライス処理します。

---

## 12. UNION / UNION ALL

複数の SELECT 結果を縦に結合します。

```sql
SELECT カラムリスト FROM テーブル1
UNION [ALL]
SELECT カラムリスト FROM テーブル2
```

- `UNION` — 重複行を除去（DISTINCT）
- `UNION ALL` — 重複行をそのまま保持（高速）
- 両辺の列数が一致しない場合はエラー
- 右辺の列名は左辺の列名に位置対応でリマップされます

```sql
-- 2アプリのデータを重複除去して結合
SELECT 顧客名, 金額 FROM APP100
UNION
SELECT 顧客名, 金額 FROM APP200

-- 重複を保持して全件結合
SELECT 顧客名 FROM APP100
UNION ALL
SELECT 顧客名 FROM APP200

-- 3つ以上の連鎖（左結合）
SELECT 名前 FROM APP100
UNION
SELECT 名前 FROM APP200
UNION
SELECT 名前 FROM APP300
```

> UNION は常に FULL_SCAN モードで実行されます。

---

## 13. WITH 句（CTE）

クエリの冒頭で仮想テーブル（CTE: Common Table Expression）を定義し、後続の SELECT / JOIN で参照できます。

```sql
WITH CTE名 AS (
  サブクエリ
)
SELECT ...
FROM CTE名
```

### 基本例

```sql
-- GROUP BY 集計結果を CTE に入れて上位 N 件を取得
WITH 月別集計 AS (
  SELECT 月, SUM(金額) AS 合計
  FROM APP100
  GROUP BY 月
)
SELECT 月, 合計
FROM 月別集計
ORDER BY 合計 DESC
LIMIT 5
```

### CTE を JOIN で使う

```sql
WITH 受注集計 AS (
  SELECT 顧客ID, SUM(金額) AS 合計
  FROM APP100
  GROUP BY 顧客ID
)
SELECT c.顧客名, r.合計
FROM APP200 AS c
INNER JOIN 受注集計 AS r ON c.顧客ID = r.顧客ID
WHERE r.合計 > 100000
```

### 複数 CTE

```sql
WITH
  A類 AS (SELECT 種別, SUM(金額) AS 合計 FROM APP100 WHERE 種別 = 'A' GROUP BY 種別),
  B類 AS (SELECT 種別, SUM(金額) AS 合計 FROM APP100 WHERE 種別 = 'B' GROUP BY 種別)
SELECT 種別, 合計 FROM A類
UNION ALL
SELECT 種別, 合計 FROM B類
```

### CTE 内で UNION

```sql
WITH 統合 AS (
  SELECT 顧客名 FROM APP100
  UNION ALL
  SELECT 顧客名 FROM APP200
)
SELECT 顧客名 FROM 統合
WHERE 顧客名 LIKE '田%'
```

### CTE インライン化（自動最適化）

単純な CTE（GROUP BY・集計・JOIN なし）は自動的にインライン化され、CTE の WHERE と最終クエリの WHERE が合成されて kintone REST API に送られます。

```sql
-- 書いたクエリ
WITH 対象 AS (SELECT * FROM APP100 WHERE 区分 = 'A')
SELECT * FROM 対象 WHERE 金額 > 1000

-- 実行されるクエリ（インライン化）
-- kintone クエリ: 区分 = "A" and 金額 > 1000
```

インライン化されない場合（FULL_SCAN のまま）:
- CTE が複数ある
- CTE 本体に GROUP BY / 集計関数がある
- 最終クエリで CTE を JOIN している

### CTE 内での SHOW APPS / DESCRIBE

`SHOW APPS` と `DESCRIBE` / `DESC` の結果も CTE として定義し、後続クエリでフィルタ・加工できます。

```sql
-- 名前でアプリ一覧を絞り込む
WITH アプリ一覧 AS (SHOW APPS)
SELECT * FROM アプリ一覧
WHERE name LIKE '受注%'

-- テキスト系フィールドだけ抽出
WITH フィールド AS (DESCRIBE APP100)
SELECT * FROM フィールド
WHERE type IN ('SINGLE_LINE_TEXT', 'MULTI_LINE_TEXT')

-- DESC も使用可能
WITH フィールド AS (DESC APP100)
SELECT fieldCode, label FROM フィールド
ORDER BY fieldCode ASC
```

**注意事項:**
- CTE 本体のサブクエリは SIMPLE / FULL_SCAN を自動判定
- 再帰 CTE は非対応

---

## 14. SHOW APPS / DESCRIBE

### SHOW APPS — アプリ一覧取得

kintone 上のすべてのアプリ（最大 1,000 件）の一覧を取得します。

```sql
SHOW APPS
```

| カラム | 内容 |
|--------|------|
| `appId` | アプリ ID |
| `name` | アプリ名 |
| `description` | 説明 |

> 100 件単位で自動ページングし、最大 1,000 件まで取得します。

### DESCRIBE / DESC — フィールド一覧取得

指定したアプリのフィールド定義を取得します。

```sql
DESCRIBE APP100
DESC APP100      -- 省略形（DESCRIBE と同等）
```

| カラム | 内容 |
|--------|------|
| `fieldCode` | フィールドコード |
| `label` | フィールドラベル |
| `type` | フィールドタイプ（`SINGLE_LINE_TEXT`、`NUMBER` 等） |

```sql
-- WITH 句と組み合わせてフィルタ
WITH アプリ AS (SHOW APPS)
SELECT * FROM アプリ WHERE name LIKE '受注%'

WITH フィールド AS (DESC APP100)
SELECT * FROM フィールド WHERE type = 'NUMBER'
```

---

## 15. INSERT

### VALUES による登録

```sql
INSERT INTO APP100 (フィールド1, フィールド2, ...)
VALUES (値1, 値2, ...)
```

#### 単一レコード

```sql
INSERT INTO APP100 (氏名, 金額, ステータス)
VALUES ('田中 太郎', 50000, '進行中')
```

#### 複数レコード（一括登録）

```sql
INSERT INTO APP100 (氏名, 金額)
VALUES ('田中 太郎', 50000),
       ('鈴木 花子', 30000),
       ('佐藤 一郎', 80000)
```

> **バッチ処理:** 100件ごとに API リクエストを分割して送信します。

> **確認ダイアログ（プラグイン）:** `INSERT INTO ... VALUES` も実行前に登録件数を表示して確認を求めます（v1.9.0）。  
> キャンセルすると登録は行われません。

### INSERT INTO ... SELECT

別アプリのデータをコピー登録します。

```sql
INSERT INTO APP100 (フィールド1, フィールド2, ...)
SELECT 列1, 列2, ...
FROM APP200
[WHERE 条件]
```

```sql
-- 別アプリから条件付きでコピー
INSERT INTO APP100 (顧客名, 金額)
SELECT 顧客名, 合計金額
FROM APP200
WHERE ステータス = '確定'

-- 関数・算術式を使って加工しながらコピー
INSERT INTO APP100 (顧客名, 税込金額)
SELECT UPPER(顧客名), ROUND(金額 * 1.1)
FROM APP200
WHERE 金額 > 0
```

- SELECT の列数と INSERT のフィールド数が一致しない場合はエラー
- SELECT 側は SIMPLE / FULL_SCAN 自動判定（JOIN・GROUP BY・関数も使用可）
- 結果を 100 件バッチで POST

### INSERT での複合フィールド

ユーザー選択・組織選択・グループ選択・チェックボックス・複数選択フィールドへの書き込みをサポートします。  
実行前に対象アプリの `getFields()` でフィールド型を自動取得し、型に応じた API 形式に変換します。

#### カンマ区切り文字列（通常ケース）

```sql
-- ユーザー選択（単一）
INSERT INTO APP89 (顧客名, 担当者) VALUES ('A社', 'user1')

-- ユーザー選択（複数）
INSERT INTO APP89 (顧客名, 担当者) VALUES ('A社', 'user1,user2')

-- チェックボックス / 複数選択
INSERT INTO APP89 (顧客名, タグ) VALUES ('A社', '重要,VIP')

-- 空にする
INSERT INTO APP89 (顧客名, 担当者) VALUES ('A社', '')
```

| SQL 値 | フィールド型 | kintone API 送信値 |
|---|---|---|
| `'user1'` | USER_SELECT 等 | `[{"code":"user1"}]` |
| `'user1,user2'` | USER_SELECT 等 | `[{"code":"user1"},{"code":"user2"}]` |
| `'選択肢A,選択肢B'` | CHECK_BOX 等 | `["選択肢A","選択肢B"]` |
| `''` | ユーザー系 / 配列系 | `[]` |

#### 配列リテラル `[...]`（カンマを含む選択肢など明示指定）

```sql
-- ユーザー選択（複数）
INSERT INTO APP89 (顧客名, 担当者) VALUES ('A社', ['user1', 'user2'])

-- カンマを含む選択肢
INSERT INTO APP89 (顧客名, タグ) VALUES ('A社', ['選択肢A', '選択肢B,C'])
--  ↑ '選択肢B,C' は 1 つの値
```

#### CASE WHEN / IF で配列を指定

```sql
-- ユーザー選択: IF() で担当者を分岐
INSERT INTO APP89 (顧客名, 担当者)
VALUES ('A社', IF(1 = 1, ['user1', 'user2'], 'user3'))

-- CASE WHEN で複数の分岐
INSERT INTO APP89 (顧客名, タグ)
VALUES ('B社', CASE WHEN 1 = 0 THEN ['重要', 'VIP'] ELSE '通常' END)
```

> INSERT VALUES の CASE WHEN / IF は定数条件のみ有効です。  
> フィールドの現在値を参照する条件（`ステータス = '対象'` 等）は空文字として評価されます（フィールド参照は UPDATE SET で使用してください）。

#### INSERT SELECT での同型フィールド自動転送

転送元・転送先が同じフィールド型の場合、JSON を自動解析して API 形式に変換します。

```sql
-- USER_SELECT → USER_SELECT: 自動転送
INSERT INTO APP89 (顧客名, 担当者) SELECT 顧客名, 担当者 FROM APP88

-- CHECK_BOX → CHECK_BOX: 自動転送
INSERT INTO APP89 (顧客名, タグ) SELECT 顧客名, タグ FROM APP88
```

### 日時フィールドの自動変換

日時（DATETIME）・日付（DATE）フィールドは、よく使われる表記を kintone の要求形式に自動変換します。  
変換はブラウザのローカルタイムゾーンを基準とします。

#### DATETIME フィールド

kintone は `YYYY-MM-DDTHH:MM:SSZ`（UTC）形式を要求します。  
以下の形式で指定すると自動変換されます。

| SQL 値（入力） | kintone API 送信値（JST 環境の場合） |
|---|---|
| `'2026-04-05 12:00'` | `'2026-04-05T03:00:00Z'` |
| `'2026-04-05 12:00:00'` | `'2026-04-05T03:00:00Z'` |
| `'2026/04/05 12:00'` | `'2026-04-05T03:00:00Z'` |
| `'2026-04-05T12:00'` | `'2026-04-05T03:00:00Z'` |
| `'2026-04-05T03:00:00Z'` | `'2026-04-05T03:00:00Z'`（変換なし） |

```sql
INSERT INTO APP15 (件名, 日時) VALUES ('会議', '2026-04-05 12:00')
```

#### DATE フィールド

kintone は `YYYY-MM-DD` 形式を要求します。  
スラッシュ区切りを自動変換します。

| SQL 値（入力） | kintone API 送信値 |
|---|---|
| `'2026/04/05'` | `'2026-04-05'` |
| `'2026-04-05'` | `'2026-04-05'`（変換なし） |

```sql
INSERT INTO APP15 (件名, 日付) VALUES ('会議', '2026/04/05')
```

> **タイムゾーン:** DATETIME の変換はブラウザのローカル時刻を UTC に変換します。  
> プラグインが動作する kintone 環境のタイムゾーン設定と一致させてください。

---

## 16. UPDATE

```sql
UPDATE APP100
SET フィールド1 = 値1, フィールド2 = 値2   -- 値: リテラル / 算術式 / CASE WHEN / (SELECT ...) / バッチ変数 @名前
WHERE 条件
```

```sql
UPDATE APP100
SET 優先度 = '高', 期限日 = '2025-03-31'
WHERE 担当者 = '田中' AND 完了フラグ = '0'
```

### 別テーブルの値で更新（UPDATE ... FROM）

`#temp` または別アプリの行を、更新先の `$id` または業務キーと対応付けて転記できます。

```sql
UPDATE APP100
SET 転記値 = s.元値,
    処理状態 = '完了',
    金額 = 金額 * 1.1
FROM APP200 AS s
WHERE APP100.$id = s.転記先ID
  AND APP100.有効 = '1';
```

文字列（1行）または数値の業務キーでも結合できます。ソース1行に対して同じキーの更新先が複数ある場合は全行を更新します。

```sql
UPDATE APP4220
SET 処理ステータス = 'エラー',
    エラー内容 = e.エラー内容
FROM APP200 AS e
WHERE APP4220.顧客コード = e.顧客コード;
```

一時テーブルを使う場合は同じバッチ内で先に実体化します。

```sql
CREATE TEMP TABLE #src AS
SELECT 転記先ID, エラー内容 FROM APP200 WHERE 処理状態 = 'エラー';

UPDATE APP100
SET エラー内容 = e.エラー内容
FROM #src AS e
WHERE APP100.$id = e.転記先ID;
```

- ソースは `#temp` または `APP<n>[@profile]`。CTE・サブクエリは非対応です。
- 結合条件は更新先とソース列の単一等値を1つだけ指定します。更新先キーは `$id`、文字列（1行）、数値に対応します。
- `$id` のソースキーは正の安全整数です。業務キーのソース値は空にできず、正規化後に重複する場合は書き込み前にエラーになります。
- 文字列キーは前後空白・大文字小文字を変換せず完全一致します。数値キーは浮動小数点へ変換せず、符号・先頭ゼロ・小数末尾ゼロを10進文字列として正規化します。
- kintoneの文字列（1行）`in` は先頭64文字が同じ行を過剰取得することがありますが、取得後に全文字で再照合するため誤更新しません。過剰取得行も `maxRecords` の読み取り件数へ含まれます。
- ソース側の同じ正規化キーは非決定になるためエラーです。更新先側の同じキーは決定的に全行更新します。
- ソース alias は結合条件と `SET alias.field` 以外では参照できません。
- `SOURCE_FIELD` はスカラー型のみ対応します。配列・ユーザー/組織/グループ選択・添付ファイルは非対応です。
- 実アプリソースは `maxRecords` 超過時に常にエラーとなり、暗黙の一部更新を行いません。
- `SET` やフィルタが参照するソース列がソースに存在しない場合、書き込み前にエラーになります。
- 結合等値はトップレベルの `AND` 連鎖に置きます。`OR` / `NOT` の配下に結合等値を書くとエラーになります（ターゲットのみを条件にした括弧内 `OR` は使えます）。
- **親レコードの `UPDATE` 限定**です。サブテーブルに対する `UPDATE ... FROM` は非対応です。

### SET での算術式

```sql
UPDATE APP100
SET 金額 = 金額 * 1.1
WHERE ステータス = '対象'
```

### SET でのスカラーサブクエリ

SET の右辺に `(SELECT ...)` を指定できます。  
サブクエリは実行前に 1 回だけ評価され、対象レコード全件に同じ値が設定されます。

```sql
-- 同アプリの最大値でセット
UPDATE APP88 SET 上限費用 = (SELECT MAX(合計費用) FROM APP88)
WHERE 確度 in ('80%', '100%')

-- 別アプリの値でセット
UPDATE APP89 SET 基準金額 = (SELECT AVG(合計費用) FROM APP88 WHERE 確度 in ('100%'))
WHERE 顧客ランク in ('A')
```

複数フィールドへの混在指定も可能です。

```sql
UPDATE APP88
SET 合計費用 = 合計費用 * 1.1,
    上限費用 = (SELECT MAX(合計費用) FROM APP88),
    ステータス = '更新済み'
WHERE 確度 in ('80%', '100%')
```

**制約:**

| 項目 | 内容 |
|---|---|
| 返却行数 | 1 行 1 列のみ（0 行・2 行以上はエラー。GROUP BY なしの集計サブクエリは 0 件でも 1 行 = `0` を返すためエラーになりません — §8） |
| 相関サブクエリ | 非対応（外側テーブルのフィールドを参照不可） |
| サブクエリ後の算術 | 非対応 — 算術はサブクエリ内で行う |

```sql
-- NG: サブクエリ後の算術
UPDATE APP88 SET 上限費用 = (SELECT AVG(合計費用) FROM APP88) * 1.1 WHERE ...

-- OK: 算術をサブクエリ内で実行
UPDATE APP88 SET 上限費用 = (SELECT AVG(合計費用) * 1.1 FROM APP88) WHERE ...
```

---

### SET での CASE WHEN

SET の右辺に CASE WHEN を使用できます。

```sql
UPDATE APP100
SET 顧客ランク = CASE
    WHEN 金額 >= 100000 THEN 'S'
    WHEN 金額 >= 10000  THEN 'A'
    ELSE 'B'
  END
WHERE ステータス = '対象'
```

算術式と CASE WHEN を同時に指定することもできます。

```sql
UPDATE APP100
SET 合計  = 単価 * 数量,
    ランク = CASE
        WHEN 単価 >= 10000 THEN 'S'
        ELSE 'A'
      END
WHERE 担当者 = '田中'
```

#### THEN / ELSE に配列リテラルを指定

ユーザー選択・チェックボックス等の複合フィールドに対して、条件に応じた値を書き込めます。  
フィールド型は `getFields()` で自動取得されます。

```sql
-- ユーザー選択: 優先度に応じて担当者を切り替え
UPDATE APP89
SET 担当者 = CASE
    WHEN 優先度 = '高' THEN ['user1', 'user2']
    WHEN 優先度 = '中' THEN 'user3'
    ELSE ''
  END
WHERE ステータス = '未着手'

-- IF() 短縮記法: チェックボックスを分岐
UPDATE APP89
SET タグ = IF(顧客ランク = 'A', ['重要', 'VIP'], '通常')
WHERE 担当者 = 'user1'

-- 文字列フィールドと複合フィールドを混在
UPDATE APP89
SET 顧客ランク = CASE WHEN 金額 >= 100000 THEN 'S' ELSE 'A' END,
    担当者     = CASE WHEN 金額 >= 100000 THEN ['user1', 'user2'] ELSE 'user3' END
WHERE ステータス = '対象'
```

> **WHERE 句は必須です。** 全件更新を防ぐため、WHERE なしの UPDATE は構文エラーになります。  
> 注: CLI には `--allow-without-where` オプションがありますが、現行実装では UPDATE/DELETE の文法上 WHERE が必須です。

> **確認ダイアログ:** 実行前に対象件数を表示して確認を求めます。  
> キャンセルすると更新は行われません。

> **プロセス管理のステータス・作業者は更新不可です。**  
> これらのフィールドは kintone の `/k/v1/records.json` では変更できず、専用の `/k/v1/records/status.json` API が必要です。  
> kSQL の UPDATE 対象外となります。

### SET での複合フィールド

ユーザー選択・チェックボックス等の複合フィールドへの SET をサポートします。  
フィールド型は実行前に `getFields()` で自動取得します。

#### カンマ区切り文字列

```sql
-- ユーザー選択を更新
UPDATE APP89 SET 担当者 = 'user1,user2' WHERE 顧客名 = 'A社'

-- チェックボックスを更新
UPDATE APP89 SET タグ = '重要,VIP' WHERE 顧客ランク = 'A'

-- 空にする
UPDATE APP89 SET 担当者 = '' WHERE 顧客名 = 'A社'
```

#### 配列リテラル `[...]`

```sql
-- カンマを含む選択肢
UPDATE APP89 SET タグ = ['選択肢A', '選択肢B,C'] WHERE 顧客ランク = 'A'
```

#### 対象フィールド型と変換ルール

| フィールド型 | SQL 記述例 | kintone API 送信値 |
|---|---|---|
| USER_SELECT / ORGANIZATION_SELECT / GROUP_SELECT | `'user1,user2'` | `[{"code":"user1"},{"code":"user2"}]` |
| CHECK_BOX / MULTI_SELECT | `'選択肢A,選択肢B'` | `["選択肢A","選択肢B"]` |
| 空にする（ユーザー系・配列系） | `''` | `[]` |
| DATETIME | `'2026-04-05 12:00'` | `'2026-04-05T03:00:00Z'`（ローカル→UTC） |
| DATE | `'2026/04/05'` | `'2026-04-05'` |
| CREATOR / MODIFIER | — | **更新不可**（kintone 制約） |

```sql
-- 日時フィールドの更新
UPDATE APP15 SET 日時 = '2026-04-05 12:00' WHERE $id = 9
UPDATE APP15 SET 日付 = '2026/04/05'       WHERE $id = 9
```

---

## 17. UPSERT

キーフィールドの値で既存レコードを検索し、一致すれば更新・なければ新規登録します。

```sql
UPSERT INTO テーブル名 (フィールド1, フィールド2, ...)
VALUES (値1, 値2, ...)
ON DUPLICATE (キーフィールド)
```

### VALUES による UPSERT

```sql
UPSERT INTO APP100 (顧客コード, 顧客名, 金額)
VALUES ('C001', '田中商店', 50000)
ON DUPLICATE (顧客コード)
```

複数レコードの一括 UPSERT:

```sql
UPSERT INTO APP100 (顧客コード, 顧客名, 金額)
VALUES ('C001', '田中商店', 50000),
       ('C002', '鈴木商事', 80000)
ON DUPLICATE (顧客コード)
```

複合キー:

```sql
UPSERT INTO APP100 (年度, 月, 担当者, 売上)
VALUES ('2025', '4', '田中', 150000)
ON DUPLICATE (年度, 月, 担当者)
```

### SELECT による UPSERT

別アプリのデータをソースにして UPSERT します。

```sql
UPSERT INTO APP100 (顧客コード, 顧客名, 合計金額)
SELECT 顧客コード, 顧客名, SUM(金額)
FROM APP200
WHERE ステータス = '確定'
GROUP BY 顧客コード, 顧客名
ON DUPLICATE (顧客コード)
```

- SELECT の列数と UPSERT のフィールド数が一致しない場合はエラー
- SELECT 側は SIMPLE / FULL_SCAN を自動判定（JOIN・GROUP BY・関数も使用可）
- USER_SELECT / CHECK_BOX 等の複合フィールドは、転送元・転送先が同型の場合に自動変換

### 複合フィールドを含む UPSERT

INSERT と同様に、ユーザー選択・チェックボックス等へのカンマ区切り文字列・配列リテラル指定が使用できます。

```sql
-- VALUES: カンマ区切りでユーザー選択
UPSERT INTO APP89 (顧客名, 担当者, タグ)
VALUES ('A社', 'user1,user2', '重要,VIP')
ON DUPLICATE (顧客名)

-- SELECT: 同型フィールド間は自動転送
UPSERT INTO APP89 (顧客名, 担当者)
SELECT 顧客名, 担当者 FROM APP88
ON DUPLICATE (顧客名)
```

### 結果表示

| 項目 | 内容 |
|------|------|
| 登録件数 | 新規登録されたレコード数 |
| 更新件数 | 更新されたレコード数 |

> キーフィールドに一致するレコードが複数ある場合はエラーになります。

---

## 17.1 VALIDATE ONLY（書き込み前検証）

`INSERT` / `UPSERT` / `UPDATE` の末尾に `VALIDATE ONLY` を付けると、候補行を全件検証し、kintone の POST / PUT / DELETE APIを呼ばずにエラー一覧を返します。親レコードDMLのみ対応し、サブテーブルDML、`DELETE`、`REORDER`には指定できません。

```sql
INSERT INTO APP100 (顧客コード, 金額)
VALUES ('C001', 100), ('', -1)
VALIDATE ONLY;

UPSERT INTO APP100 (顧客コード, 顧客名)
SELECT 顧客コード, 顧客名 FROM APP200
ON DUPLICATE (顧客コード)
VALIDATE ONLY;

UPDATE APP100 SET 金額 = 金額 * 1.1
WHERE ステータス = '有効'
VALIDATE ONLY;
```

検証対象は必須、数値・日付・時刻・日時、数値範囲、文字列長、選択肢、UPSERTキーの空値・ソース内重複です。1行に複数の問題があればエラーも複数行になります。結果には `validatedRows` / `validRows` / `invalidRows` / `errorCount` と、入力ペイロード列および `$err_*` 診断列が含まれます。

複文バッチでは `VALIDATE ONLY INTO #err` とすると、同じエラー行を後続文から一時テーブルとして参照できます。同名 `#err` は入力列構成が同じ場合だけ追記でき、異なるschemaまたは `tempTableMaxRows` 超過は既存行を変更せずエラーになります。

```sql
INSERT INTO APP100 (顧客コード, 金額)
SELECT 顧客コード, 金額 FROM #source
VALIDATE ONLY INTO #err;
SELECT * FROM #err;
```

- `VALIDATE ONLY` はread-only扱いで、MCPでは `ksql_query`、CLIでは `--allow-dml`なし、プラグインでは確認ダイアログなしで実行できます
- 完全な候補集合が必要なため、`onLimit=truncate` / CLI `--on-limit truncate` / プラグインのtruncate設定は無視され、常にerrorとして扱われます
- ローカル検証は通常の書き込み経路より厳密な場合があります。検証エラーはkSQLが検出したTier 0問題であり、同じ値をkintone APIが必ず拒否するという予測ではありません
- 検証通過は書き込み成功を保証しません。権限、競合、ユーザー実在性、既存レコードとの一意制約衝突などAPI実行時の問題は対象外です
- `UPDATE ... VALIDATE ONLY` はSET対象列だけを検証します。一方、kintoneはPUT時にレコード全体を再検証するため、制約を後から追加したアプリなどでは、既存レコードのSET対象外フィールド（サブテーブル子を含む）に残る必須・文字列長等の違反値によって本実行が失敗することがあります。この場合はAPI実行時エラーとしてfail-fastになります

## 17.2 ON ERROR SKIP（事前検証エラー行の隔離）

複文バッチ内の親レコード `INSERT` / `UPSERT` / `UPDATE` に `ON ERROR SKIP INTO #err` を付けると、`VALIDATE ONLY` と同じTier 0検証で不正になった行を `#err` へ隔離し、合格行だけを書き込みます。書き込みを行うため、MCPでは `ksql_mutate` とDML承認、CLIでは `--allow-dml` が必要です。

```sql
INSERT INTO APP100 (顧客コード, 金額)
SELECT 顧客コード, 金額 FROM #source
ON ERROR SKIP INTO #err REJECT LIMIT 100;

SELECT * FROM #err;
```

- `REJECT LIMIT n` は隔離されたユニーク入力行数へ適用します。n行までは許容し、n+1行以上なら全候補の検証完了後に書き込みゼロで停止します。省略時は無制限です
- 超過文は `RejectLimitExceededError` になりますが、全診断行は応答の結果セットに含まれます。後続文はfail-fastでskipされるため、超過時は後続SQLから `#err` を参照できません
- `ON ERROR SKIP` は `INTO #err` 必須のバッチ専用構文です。単文では使用できません
- 結果には既存のoperation別件数に加えて `affectedRows` / `skippedRows` / `rejectLimit` / `errTable` が含まれます
- `dmlMaxRows` と `dmlTotalMaxRows` は隔離後に実際に書き込む行数へ適用されます。ソース取得は通常の `maxRecords` で制御されます
- kintone APIが書き込み時に返す権限・競合・一意制約・既存レコード全体の再検証エラーなどは隔離せず、従来どおりfail-fastです

---

## 18. DELETE

```sql
DELETE FROM APP100
WHERE 条件
```

```sql
DELETE FROM APP100
WHERE ステータス = 'キャンセル'

DELETE FROM APP100
WHERE 作成日時 < '2020-01-01'
```

> **WHERE 句は必須です。** 全件削除を防ぐため、WHERE なしの DELETE は構文エラーになります。  
> 注: CLI には `--allow-without-where` オプションがありますが、現行実装では UPDATE/DELETE の文法上 WHERE が必須です。

> **確認ダイアログ:** 実行前に対象件数を表示して確認を求めます。  
> キャンセルすると削除は行われません。

> **CLI 拡張の制約:** `DELETE` での `APP@profile` 指定は未対応です。  
> 例: `DELETE FROM APP100@guest WHERE ...` は  
> `ArgumentError: @profile is not supported for DELETE yet.` で終了します。

---

## 19. サブテーブル仮想テーブル

サブテーブルは `APP100$明細` 形式の仮想テーブルとして操作できます。

### システム列

| 列名 | 意味 |
|------|------|
| `_pid` | 親レコード ID（`$id`） |
| `_rid` | サブテーブル行 ID |
| `_idx` | 親レコード内の行順（0-based） |

### 親項目ショートカット

- `_p.項目名` で親項目を参照可能
- `_p.*` で親項目を一括展開
- `SELECT *` には `_p.*` を暗黙追加しない

```sql
SELECT _p.伝票番号, 商品コード, 数量
FROM APP100$明細
WHERE _pid = 123
```

### サブテーブル DML

```sql
INSERT INTO APP100$明細 (_pid, 商品コード, 数量) VALUES (123, 'A-001', 2)

UPDATE APP100$明細
SET 数量 = 5
WHERE _pid = 123 AND _rid = '67890'

DELETE FROM APP100$明細
WHERE _pid = 123 AND _rid = '67890'
```

- `UPDATE` / `DELETE` は安全のため `_rid` 条件を必須とする

---

## 20. REORDER

サブテーブル行を親単位で並び替えます。

```sql
REORDER APP100$明細
BY 商品コード ASC, 納期 DESC
WHERE _pid = 123
```

全件対象の明示構文:

```sql
REORDER ALL APP100$明細
BY 商品コード ASC
```

ルール:
- `REORDER` は `WHERE` 必須
- `REORDER ALL` は `WHERE` 併用不可
- `_idx` は参照専用（`UPDATE SET _idx = ...` 不可）
- 並び替え更新時は行 `id` のみ送信し、行値は再送しない（ルックアップ再評価影響を抑制）

---

## 21. サブクエリ

### スカラーサブクエリ（SELECT 列・HAVING）

SELECT 列や HAVING 句でも 1 行 1 列を返すサブクエリを使用できます。

```sql
-- SELECT 列: 全件数・合計をすべての行に付加
SELECT
  顧客名,
  金額,
  (SELECT COUNT(*) FROM APP100) AS 総件数,
  (SELECT SUM(金額) FROM APP100) AS 合計金額
FROM APP100
WHERE ステータス = '完了'

-- HAVING でサブクエリ
SELECT 担当者, SUM(金額) AS 合計
FROM APP100
GROUP BY 担当者
HAVING SUM(金額) > (SELECT AVG(金額) FROM APP100) * 2
```

列のエイリアスを省略した場合は `(subquery)` が列名になります。

### サブクエリ一覧

| 構文 | 記述箇所 | 備考 |
|---|---|---|
| `IN (SELECT ...)` | WHERE | 1 列目の値セットを IN リストとして使用 |
| `NOT IN (SELECT ...)` | WHERE | 除外条件 |
| `EXISTS (SELECT ...)` | WHERE | 1 件以上返せば真 |
| `NOT EXISTS (SELECT ...)` | WHERE | 0 件なら真 |
| `(SELECT ...)` | WHERE 右辺・SELECT 列・HAVING 右辺 | スカラーサブクエリ（1 行 1 列。GROUP BY なしの集計は 0 件でも 1 行 = `0` を返す — §8） |

**共通制約:**
- **非相関のみ対応** — 外側テーブルのフィールドをサブクエリ内で参照することはできません
- すべて FULL_SCAN モードで実行されます
- サブクエリ自体も SIMPLE / FULL_SCAN を自動判定します
- サブクエリは 1 回だけ実行され、全行に同じ結果が適用されます

---

## 22. 制限事項

### サポートしていない構文

| 機能 | 状況 |
|------|------|
| 相関サブクエリ | 非対応（非相関 IN/EXISTS は対応） |
| INTERSECT / EXCEPT | 非対応 |
| 再帰 CTE | 非対応 |
| FULL OUTER JOIN | 非対応 |
| UPDATE の汎用 JOIN | 非対応（`UPDATE ... FROM` の `$id`／文字列（1行）／数値キーによる単一等値のみ対応） |
| トランザクション | kintone API の制約により非対応（バッチ実行も非アトミック） |
| DML を含むバッチ（複文） | 対応（CLI / MCP は v1.4.0、プラグインは v1.9.0。`ksql_mutate` / CLI `--allow-dml` / プラグインは文ごとの確認ダイアログ。常に fail-fast。→ [§25](#25-バッチ実行と一時テーブル)） |
| 一時テーブルへの DML | 非対応（`CREATE TEMP TABLE ... AS SELECT` / `DROP TEMP TABLE` のみ） |
| `ASSERT` の複合条件（`AND` / `OR`） | 非対応（複数の `ASSERT` 文に分けて書く。→ [§26](#26-assert)） |
| バッチ変数の高度な利用 | `SET @x = (SELECT ...)` は **v2.3.0**、`DECLARE @x = default` と CLI/MCP 外部注入は **v2.4.0** で対応。`NULL` 代入・1 変数が複数値を持つ配列展開（`IN (@list)`）・サブクエリ結果への算術は現時点で非対応（→ [§25 バッチ変数](#25-バッチ実行と一時テーブル)） |
| 書き込み系 API（POST / PUT / DELETE）の自動リトライ | 非対応（応答喪失時の二重実行を避けるため。リトライは GET 系限定 — 対象: 408/429/502/503/504。必要なら呼び出し側で冪等な再実行（UPSERT 等）を設計する） |
| `DELETE` での `APP@profile`（CLI 拡張） | 未対応（`ArgumentError: @profile is not supported for DELETE yet.`） |
| **プロセス管理のステータス・作業者の UPDATE** | **対象外**（`/k/v1/records/status.json` が必要なため） |

### 実行モード

kSQL は以下の条件に応じて自動的に実行モードを切り替えます。

| 条件 | モード |
|------|--------|
| JOIN なし、GROUP BY なし、DISTINCT なし、WHERE/ORDER BY に関数・算術式なし | **SIMPLE**（kintone クエリに変換） |
| JOIN あり / GROUP BY あり / DISTINCT / WHERE に関数・算術式・CASE WHEN / ORDER BY に算術式 | **FULL_SCAN**（全件取得して JS 処理） |
| WHERE に IN (SELECT) / EXISTS / NOT EXISTS / スカラーサブクエリ | **FULL_SCAN** |
| SELECT 列にスカラーサブクエリ | **FULL_SCAN** |
| UNION / UNION ALL | **FULL_SCAN** |
| WITH 句（単純 CTE）— インライン化される | **SIMPLE**（kintone クエリに変換） |
| WITH 句（GROUP BY ありの CTE・複数 CTE・CTE JOIN） | **FULL_SCAN** |

FULL_SCAN モードは大量レコードの場合、時間がかかります。

### 取得件数の上限

- エンジン既定値: **10,000 件**
- CLI 既定値: **500 件**（`--max-records` で変更可能）
- JOIN / GROUP BY / DISTINCT を使う場合、全テーブルを一括取得するため大量データでは時間がかかります

### JOIN の等値結合のみ対応

```sql
-- OK: 等値結合
ON a.顧客ID = b.顧客ID

-- NG: 範囲結合・不等値結合は非対応
ON a.金額 > b.下限金額
```

### INSERT / UPDATE の値

文字列・数値・配列リテラル `[...]` が指定可能です。  
ユーザー選択・組織選択・グループ選択・チェックボックス・複数選択フィールドへの書き込みをサポートします（フィールド型を `getFields()` で自動取得して変換）。

以下は引き続き非対応です:

| フィールド型 | 状況 |
|---|---|
| 添付ファイル（FILE） | バイナリ送信が別 API のため非対応 |
| CREATOR / MODIFIER | kintone API で更新不可 |
| SUBTABLE | 仮想テーブル経由（`APP100$明細`）で操作 |

### LIKE の挙動

v2.0.0以降、LIKEはワイルドカードの有無にかかわらず常にJavaScriptで評価し、kintoneへ押し下げません。ワイルドカードなしはkSQL独自の部分一致（`includes`）です。通常の親レコードDMLではLIKEを使用できません。詳細は「LIKE / NOT LIKE（部分一致・除外）」を参照してください。

---

## 23. UI 機能

### エラーメッセージ

kintone API のエラーはわかりやすく表示されます。フィールドレベルのエラーも展開して表示します。

```
⚠ 入力内容が正しくありません。
  records[0].顧客ランク.value: "V"は選択肢にありません。

⚠ 指定されたフィールド（顧客ランク）が見つかりません。
```

### 実行履歴

- 実行した SQL は自動的に履歴に保存されます
- **エラーになった SQL も保存されます**（修正・再実行がしやすくなります）
- キャンセルした場合は保存されません
- 「履歴 ▼」ボタンから過去の SQL を選択して再実行できます

---

## 24. EXPLAIN

`EXPLAIN` を先頭に付けると、実APIを実行せずに実行計画を表示します。

```sql
EXPLAIN SELECT * FROM APP100 WHERE ステータス = '完了'
EXPLAIN UPDATE APP100 SET 状態 = '完了' WHERE $id = 1
EXPLAIN DELETE FROM APP100 WHERE $id = 1
EXPLAIN INSERT INTO APP100 (顧客名) VALUES ('A社')
EXPLAIN UPSERT INTO APP100 (顧客コード, 顧客名) VALUES ('C001', 'A社') ON DUPLICATE (顧客コード)
EXPLAIN REORDER APP100$明細 BY 商品コード ASC WHERE _pid = 1
```

### サポート対象

- `SELECT` / `INSERT` / `UPDATE` / `DELETE` / `UPSERT` / `REORDER`

### 制約

- `EXPLAIN SHOW APPS` など、上記以外の文は非対応です
- 実データ更新は行いません（計画表示のみ）

---

## 25. バッチ実行と一時テーブル

> **v1.4.0 で追加**。**CLI（`-e` / `-f` / `--console`）と MCP（`ksql_query` / `ksql_validate` / `ksql_mutate` / `ksql_explain`）で利用可能**です。プラグイン UI もバッチに対応し（**v1.9.0 で DML を含むバッチも解禁**。v1.4.0〜v1.8.0 は read-only バッチのみ）、最後に結果セットを返した文（通常は最終 SELECT）だけを表示します。詳細仕様は [ksql_batch_temp_table_spec.md](ksql_batch_temp_table_spec.md) を参照してください。
>
> **リラン可能な差分更新バッチの設計パターン**（ステータス駆動・件数ゲート・スナップショット・バッチ変数の活用）は [ksql_batch_recipes.md](ksql_batch_recipes.md) にまとめています。

### 複文（バッチ）

`;` 区切りで複数の SQL 文を1回の呼び出しで**順次**実行できます（最大 20 文）。

```sql
SELECT 部門 FROM APP100;
SELECT 部門 FROM APP200;
```

- read-only 文のみのバッチは `ksql_query` / CLI / プラグインがそのまま実行します。**DML を含むバッチ**は `ksql_mutate`（`dmlMaxRows` は文ごと + 任意の `dmlTotalMaxRows` で合計ガード）、CLI `--allow-dml`（確認プロンプトはバッチ全体で1回、`--yes` でスキップ）、またはプラグイン（文ごとの確認ダイアログ — v1.9.0）で実行します。DML バッチは常に fail-fast です
- SELECT-based DML（`INSERT INTO APPxxx ... SELECT` / `UPSERT INTO APPxxx ... SELECT ... ON DUPLICATE`）のソースは **APP・一時テーブル・両者の混在（JOIN・サブクエリ）のいずれも指定できます**（v1.5.0〜v1.7.0 で段階解禁）。件数には書き込み前の確認で `dmlMaxRows` が適用され（UPSERT は insert + update の**合計**）、超過時は当該文ゼロ書き込みでエラーになります
- SELECT-based DML の読み取り上限はソース種類ごとに異なります: **APP ソースの読み取りは `maxRecords` の通常解決値（`KSQL_MAX_RECORDS` / profile の `query.maxRecords`、既定 500 件）**（超過は書き込み前の安全側エラー。JOIN の APP 側も同様。`dmlMaxRows` は影響行数ガード専用で読み取りを絞りません — v1.8.0）、**一時テーブルは実体化上限 既定 10,000 行（`tempTableMaxRows` で変更可 — v1.11.0）**。UPSERT 系では書き込み先アプリへの既存レコード照合読み取りが**ソース種類に関わらず**発生します（一時テーブルに実体化しても回避されません）
- 実行前に全文を検証し、1文でも不正ならバッチ全体を拒否します（validate-all-first）
- 既定は fail-fast（エラー文以降はスキップ）。`--continue-on-error`（CLI）/ `continueOnError`（MCP）でエラー後の続行を選べます
- 結果は文ごとに `success` / `error` / `skipped` として報告されます

### 一時テーブル

`CREATE TEMP TABLE #名前 AS SELECT ...` で SELECT 結果をバッチ内に実体化し、後続の文から `FROM` / `JOIN` / サブクエリで参照できます。

```sql
-- 相関サブクエリの回避例
CREATE TEMP TABLE #latest AS
SELECT 顧客ID, MAX(受注日) AS 最新受注日
FROM APP300
GROUP BY 顧客ID;

SELECT a.顧客名, t.最新受注日
FROM APP100 a
INNER JOIN #latest t ON a.顧客ID = t.顧客ID;
```

> **注意**: 上記の `MAX(受注日)` は、`APP300` のフォーム定義から DATE 型を解決して最新日を返します。v2.15.0 以降は一時テーブル/CTEへ型メタが伝播するため、`SELECT MAX(最新受注日) FROM #latest` のような再集約でも日時の辞書順比較を維持します（前掲の集計関数の比較規則を参照）。

| 規則 | 内容 |
|---|---|
| 名前 | `#` + 識別子（例: `#temp` / `#集計`）。`#` は一時テーブル名の先頭のみで有効。エイリアスには使用不可 |
| 寿命 | **バッチ内のみ**。呼び出し終了で自動破棄（呼び出しをまたぐ参照は不可） |
| 破棄 | `DROP TEMP TABLE #名前`（主にメモリの早期解放用。DROP 後の同名再 CREATE は可） |
| 上限 | 同時 16 個・1個あたり既定 10,000 行（超過は常にエラー）。行数上限は v1.11.0 から `tempTableMaxRows` で変更可能（MCP ツール引数 / CLI `--temp-table-max-rows` / env `KSQL_TEMP_TABLE_MAX_ROWS` / profile `query.tempTableMaxRows` / プラグインは「⚙ オプション → 取得」の「一時テーブル上限(行)」。空欄 = 既定）。変更しても超過時は truncate されず常にエラー |
| DML | 一時テーブルへの INSERT / UPDATE / DELETE は非対応 |
| 実行 | 参照は常にインメモリ FULL_SCAN（kintone クエリへの WHERE プッシュダウンは効かない） |

### コンソール（`--console`）での入力

- 単文は従来どおり行末 `;` で実行されます
- `CREATE TEMP TABLE` で始まる入力は**バッチ構築モード**になり、`;` では実行されず **`:run`** でバッファ全体をバッチ実行します（破棄は `:clear`）

### プラグインでの DML バッチ（v1.9.0）

プラグイン UI でも DML を含むバッチを実行できます。

- DML 文は**文ごとの確認ダイアログ**（文番号 `[N/M]`・書き込み先アプリ・確定件数付き）で書き込み直前に確認します
- `INSERT INTO ... VALUES` は静的に件数が確定するため、**バッチ実行前**にまとめて確認します（キャンセル時は 1 文も実行されません）
- 実行時確認をキャンセルした場合は文 `[N/M]` で中断し、それ以前の文の実行結果は反映済みのまま残ります（トランザクションなし）
- 成功した DML 文の影響件数はサマリ行（`[N] タイプ: inserted=... updated=...`）として結果の上に表示されます
- DML を含む実行（単文・バッチとも）では取得上限到達時の動作が UI 設定に関わらず **error に固定**されます（truncate だと SELECT-based DML のソース読み取りが黙って切り捨てられ、部分書き込みになるため）

### プラグインでの一時テーブル上限指定（v1.11.0）

「⚙ オプション → 取得」の「一時テーブル上限(行)」で実行ごとに指定できます（空欄 = 既定 10,000。超過は「打ち切って続行」設定でも常にエラー）。一覧ページの入力値は localStorage に保存され、SQL 履歴にもスナップショットとして残ります。

**レコード（保存SQL）ごとに値を保持する**には、保存SQLアプリに任意フィールドを追加します。レコード編集画面での入力値の保持と、一覧ページでレコードを選択したときのパネル反映に使われます。

#### 既存アプリへの「一時テーブル上限行」フィールド追加手順

v1.11.0 のアプリテンプレート（`ksql-app-template-v1.11.0.zip`）には追加済みです。それ以前のテンプレートから作成した既存アプリには、次の手順で追加します。

1. 保存SQLアプリの **設定 → フォーム** を開く
2. **数値** フィールドを配置する（場所は任意。「最大取得件数」の近くを推奨）
3. フィールドの設定を開き、次のとおり入力して保存する
   - フィールド名: 任意（例: `一時テーブル上限行`）
   - **フィールドコード: `一時テーブル上限行`（完全一致・必須）**
4. **アプリを更新** する

- フィールドを追加しなくても従来どおり動作します（レコードごとの保持が効かないだけで、パネルでの実行ごと指定・localStorage・履歴は使えます）
- レコードのフィールドが**空欄**の場合は「既定 10,000 で実行する」という明示指定になります（レコード選択時にパネルも空欄 = 既定へ戻ります）

### バッチ変数（`SET @var`）（v2.1.0）

バッチ内で値を一度定義し、後続の文から `@名前` で参照できます。**時刻の固定**・**バッチ ID**・**条件値の共通化（DRY）** に使います。

```sql
SET @now = NOW();          -- バッチ内で時刻を固定（ISO 文字列）
SET @batch_id = NOW();     -- バッチ ID として利用

UPDATE APP100
SET 処理ステータス = '処理済', 処理日時 = @now, バッチID = @batch_id
WHERE 処理ステータス = '未処理';
```

事後検証が `WHERE バッチID = @batch_id` の完全一致になり、`処理日時 >= TODAY()` のような近似条件が不要になります。

| 規則 | 内容 |
|---|---|
| 構文 | `SET @名前 = <式>`。式は**リテラル**（文字列・数値）・**関数**（`NOW()` / `TODAY()` / 文字列・数値関数）・**数値算術**・**スカラーサブクエリ**（`(SELECT ...)`。v2.3.0＝Phase 1b。下記）。`@名前` は英字か `_` で始まり英数字・`_`、64 文字以内。大文字小文字は区別しない |
| 参照できる位置 | **WHERE 右辺の値** / **UPDATE の SET 値** / **ASSERT のオペランド** / **IN リストの要素**（`WHERE k IN (@a, @b)`。チェックボックス等 `in` 必須のフィールドで有効） |
| 評価 | `SET` の実行時に**一度だけ**評価し、以後は定数（`SET @now = NOW()` はバッチ内で同じ時刻に固定。`NOW()` 自体の意味は変わりません） |
| 型 | 代入値から **string / number** を決定。比較の型規則は WHERE と同一（`=` / `!=` は文字列比較、大小比較は双方が数値なら数値） |
| スコープ | **1 バッチ内のみ**（一時テーブルと同じ寿命）。バッチをまたがない |
| バッチ必須 | **2 文以上のバッチでのみ使用可**。単文の `SET`・単文での `@参照` はエラー |
| 静的検査 | **未定義参照・前方参照・再代入はエラー**（実行前に検出）。未使用は警告。`SET` の評価に失敗した場合は `continueOnError` に関わらずバッチを停止 |
| 上限 | 変数の防御上限は **64 個**。ただしバッチ全体の**最大 20 文**（§25 冒頭）が先に効くため、`SET` も 1 文ずつ数える現状の実効上限は **20 個以下** |
| 演算 | 式内の `+` は**数値加算**。文字列連結は `CONCAT()` を使う。**SET の右辺から別の変数は参照できません**（`SET @b = @a + 1` は不可） |
| 束縛 | 値としてバインド（文字列連結ではない）ため、**SQL インジェクションは発生しません**。変数に入るのは値のみで、アプリ ID・フィールドコード・演算子など識別子のパラメータ化はできません |

#### スカラーサブクエリ代入 `SET @x = (SELECT ...)`（v2.3.0・Phase 1b）

`SET` の右辺に**スカラーサブクエリ**を指定できます。**件数ゲートの DRY 化**が主用途です。

```sql
SET @cnt = (SELECT COUNT(*) FROM APP100 WHERE 処理ステータス IN ('未処理'));
ASSERT @cnt BETWEEN 0 AND 10000;
UPDATE APP100 SET 対象件数メモ = @cnt WHERE 処理ステータス IN ('未処理');
```

| 規則 | 内容 |
|---|---|
| 評価 | `SET` の実行時に**一度だけ**サブクエリを実行し、以後は定数（同じ変数を複数文で参照しても再実行しない） |
| スカラー保証 | サブクエリは**必ず 1 行 1 列**。0 行・複数行・複数列はエラー。明示列で 2 列以上はパース時、`SELECT *` 等は実行時に検証。※ **GROUP BY なしの集計は 0 件でも 1 行（`COUNT` は `0`）** を返す（§8）ため `COUNT(*)` 件数取得は 0 件でも成立 |
| 参照 | サブクエリは**先行して作成した一時テーブル**・**先行して定義した変数**（`(SELECT ... WHERE k < @prev)`）を参照可。未定義・前方参照は実行前に検出 |
| 後置算術 | サブクエリ結果への算術は不可（`(SELECT ...) * 2` は不可 → `(SELECT COUNT(*) * 2 FROM ...)` とサブクエリ内で計算） |
| エラー | 評価失敗（0 行・複数行・複数列・API エラー）は `ArgumentError` で、**`continueOnError` に関わらずバッチを停止**（fail-fast。`ASSERT` 失敗の停止＝`assertion` とは区別） |
| EXPLAIN | バッチ EXPLAIN が `SET @x = (SELECT ...)` のサブクエリ計画（APP／一時テーブル参照・1 回評価）を表示 |

#### 外部パラメータ注入 `DECLARE @x = default`（v2.4.0・Phase 1c）

```sql
DECLARE @since = '2026-01-01';
SELECT * FROM APP100 WHERE 登録日 >= @since;
```

- 未注入時は既定値を実行時に1回評価。CLI の `--var since=2026-07-01`、MCP `variables: { "since": "2026-07-01" }` で文字列値を上書きできる。注入時は既定値式を評価しない。
- プラグインでも `DECLARE` 文は実行できるが注入 UI はなく、常に既定値を使う。
- キーは `@` なし・大文字小文字を区別しない。未宣言キー、重複、不正名は API 呼び出しや DML より前にエラー。`SET` で定義した名前は注入対象にならない。
- 既定値はリテラル・`NOW()` / `TODAY()`・文字列/数値関数・数値算術。サブクエリ、別変数、`NULL`、`LOGINUSER()` は不可。採用値は文字列として束縛する。
- `DECLARE` と使用文を含む2文以上のバッチが必要。値は EXPLAIN、結果メタデータに表示しない。CLI `--var` はプロセス一覧やシェル履歴に残り得るため秘密情報には使わない。

**現時点で非対応（今後のフェーズ）**: `NULL` の代入・**1 つの変数が複数値を持つ配列展開**（`SET @l = ('A','B'); IN (@l)`。※`IN (@a, @b)` のようにスカラー変数を並べるのは対応）・`SET` 右辺での別変数参照（`SET @b = @a + 1`）・スカラーサブクエリ結果への算術・`SELECT` の列での変数参照・関数引数への `NOW()` 直接指定（整形バッチ ID）・`LOGINUSER()`（実行環境共通のログインユーザー解決が未整備のため）。

> **`APP@profile` との併用**: `SET @now = NOW(); SELECT * FROM APP100@dev WHERE 作成日時 = @now` のように、`@profile`（アプリ指定）と `@変数` は同居できます（CLI / MCP が profile だけを先に正規化するため混同しません）。

### 注意

- **トランザクションはありません**。バッチも非アトミックです（DML バッチ対応後も、途中失敗時に前半のみ反映された状態が起こり得ます）
- MCP では `CREATE TEMP TABLE` の実体化結果は返却されません（`tempTable` 名と `rowCount` のみ）。中間結果をコンテキストに載せないための設計です

---

## 26. ASSERT

> **v1.10.0 で追加**。条件が成立しなければ `AssertError` で実行を止める**実行時ゲート**です。DML 前の件数ガードや CLI ヘルスチェック（exit code 監視）に使います。

```sql
ASSERT <式> <比較演算子> <式>;
ASSERT <式> BETWEEN <式> AND <式>;
```

- 比較演算子: `=` `<>` `!=` `<` `<=` `>` `>=` および `BETWEEN`（境界を含む）
- 式に使えるもの: **リテラル**（数値・文字列）、**算術式**（数値リテラルのみ）、**スカラーサブクエリ**（`(SELECT ...)`。APP・一時テーブルとも参照可）、**バッチ変数**（`@名前`。→ [§25 バッチ変数](#25-バッチ実行と一時テーブル)）
- 比較の型規則は WHERE 句と同一（`=` / `<>` は文字列比較、大小比較は双方が数値なら数値比較）

```sql
-- 典型例1: UPDATE 前の件数ガード
-- （UPDATE のサブクエリは一時テーブルを参照できないため、ASSERT で直接件数を検証し
--   UPDATE には同じ条件を書く）
ASSERT (SELECT COUNT(*) FROM APP100 WHERE 売上 > 1000000) BETWEEN 1 AND 500;

UPDATE APP100 SET 状態 = '対象' WHERE 売上 > 1000000;
```

```sql
-- 典型例2: 一時テーブルをゲート + SELECT-based DML のソースに使う
-- （INSERT/UPSERT ... SELECT は一時テーブルソース対応のため、検証した #src をそのまま書き込める）
CREATE TEMP TABLE #src AS
SELECT 顧客名, SUM(金額) AS 合計 FROM APP200 GROUP BY 顧客名;

ASSERT (SELECT COUNT(*) FROM #src) BETWEEN 1 AND 500;

INSERT INTO APP300 (顧客名, 合計金額) SELECT 顧客名, 合計 FROM #src;
```

```bash
# CLI ヘルスチェック（不成立なら exit code 1）
ksql -e "ASSERT (SELECT COUNT(*) FROM APP1 WHERE 異常フラグ = '1') = 0"
```

### 動作

- **read-only 扱い**です（kintone に書き込まない）。read-only バッチ・DML バッチのどちらにも書けます。単文でも実行できます
- 不成立の場合は `AssertError: assertion failed: <条件> (actual: <実測値>).` でその文がエラーになり、**バッチは常に停止**します（`continueOnError` 指定も無視。以降の文は `skipped` / `skippedReason: "assertion"`）
- バッチ成功時の ASSERT は結果を持たない文として扱われます（`statements[]` は `status: "success"` のみ）
- スカラーサブクエリは**必ず 1行1列**を要求します。0行・複数行は実行時 `AssertError`（0行を NULL 扱いにしません）。複数列は select list が明示的ならパース時に拒否、`SELECT *` 等は実行時に検証します
- **GROUP BY なしの集計サブクエリは対象 0 件でも 1 行（COUNT は `0`）を返す**（§8「0 件時の挙動」— v1.12.0）ため、上の CLI 例のような `ASSERT (SELECT COUNT(*) ... WHERE 異常条件) = 0` の健全性チェックが該当 0 件（健全時）に成立します。0 行エラーが起きるのは、非集計プローブの空振り（`SELECT フィールド FROM ... WHERE ...` が 0 件）や GROUP BY 付き集計が 0 行になる場合です

### 制限（初期版）

| 項目 | 内容 |
|---|---|
| `AND` / `OR` の複合条件 | 非対応（複数の `ASSERT` 文に分けて書く） |
| 裸の値のみ（`ASSERT 1`） | 非対応（比較演算子または BETWEEN が必須） |
| フィールド参照 | 非対応（FROM コンテキストがないため。サブクエリ内では使用可） |
| 関数呼び出し | 式の直下では非対応（サブクエリ内で計算する） |
| サブクエリ直後の算術 | 非対応（`(SELECT ...) * 2` は不可。サブクエリ内で計算する） |

> **注意（既存制限との組み合わせ）**: `UPDATE` / `DELETE` のサブクエリでは一時テーブルを参照できません（`ArgumentError: temp table references in UPDATE are not supported yet.` — §25）。`ASSERT` 自体は一時テーブルを参照できるため、一時テーブルで件数を検証しつつ後続の `UPDATE` / `DELETE` には同じ WHERE 条件を直接書くか、後続を一時テーブルソース対応の `INSERT` / `UPSERT ... SELECT` にしてください。

---

## クイックリファレンス

```sql
-- 基本 SELECT
SELECT * FROM APP100 WHERE ステータス = '完了' LIMIT 100

-- CLI 拡張: APP@profile
SELECT * FROM APP100@guest
SELECT * FROM APP80$明細@dev WHERE _pid = 123

-- 同一 APP の profile 混在（CLI 拡張）
SELECT a.$id, b.$id
FROM APP88@dev a
JOIN APP88@guest b ON a.$id = b.$id

-- BETWEEN / NOT IN / NOT LIKE
SELECT * FROM APP100
WHERE 金額 BETWEEN 10000 AND 50000
  AND ステータス NOT IN ('キャンセル', '却下')
  AND 氏名 NOT LIKE '%テスト%'

-- 算術式・関数
SELECT
  氏名,
  ROUND(金額 * 1.1, 0)    AS 税込金額,
  FORMAT(金額, '#,##0')   AS 金額表示,
  CONCAT(姓, '　', 名)    AS 氏名結合,
  COALESCE(メモ, '－')    AS メモ
FROM APP100

-- CASE WHEN
SELECT
  氏名,
  CASE
    WHEN 金額 >= 100000 THEN '大口'
    WHEN 金額 >= 10000  THEN '中口'
    ELSE '小口'
  END AS 顧客区分
FROM APP100

-- WHERE で関数使用（FULL_SCAN）
SELECT * FROM APP100
WHERE UPPER(ステータス) = 'ACTIVE'
  AND LENGTH(コード) >= 5

-- ORDER BY で算術式・関数（FULL_SCAN）
SELECT * FROM APP100
ORDER BY 単価 * 数量 DESC

-- LIMIT + OFFSET（ページング）
SELECT * FROM APP100 ORDER BY 作成日時 DESC LIMIT 20 OFFSET 40

-- 集計
SELECT 部署, COUNT(*) AS 件数, SUM(金額) AS 合計
FROM APP100
WHERE 作成日時 >= TODAY()
GROUP BY 部署
HAVING COUNT(*) > 0
ORDER BY 合計 DESC

-- JOIN
SELECT a.氏名, b.商品名, b.金額
FROM APP100 AS a
INNER JOIN APP200 AS b ON a.注文ID = b.注文ID
WHERE b.金額 > 10000

-- INSERT VALUES
INSERT INTO APP100 (氏名, 金額, ステータス)
VALUES ('田中 太郎', 50000, '進行中')

-- INSERT INTO ... SELECT
INSERT INTO APP100 (顧客名, 税込金額)
SELECT 顧客名, ROUND(金額 * 1.1)
FROM APP200
WHERE ステータス = '確定'

-- WHERE 算術式（FULL_SCAN）
SELECT * FROM APP100
WHERE 金額 * 1.1 > 10000
  AND (単価 + 送料) * 数量 < 5000

-- WHERE CASE WHEN（FULL_SCAN）
SELECT * FROM APP100
WHERE CASE
    WHEN 区分 = '特別' THEN 金額
    ELSE 0
  END > 1000

-- UNION / UNION ALL
SELECT 顧客名 FROM APP100
UNION
SELECT 顧客名 FROM APP200

-- WITH 句（CTE）
WITH 月別 AS (
  SELECT 月, SUM(金額) AS 合計
  FROM APP100
  GROUP BY 月
)
SELECT 月, 合計 FROM 月別 ORDER BY 合計 DESC LIMIT 5

-- UPDATE（算術式）
UPDATE APP100
SET 金額 = 金額 * 1.1
WHERE ステータス = '対象'

-- UPDATE（CASE WHEN）
UPDATE APP100
SET 顧客ランク = CASE
    WHEN 金額 >= 100000 THEN 'S'
    WHEN 金額 >= 10000  THEN 'A'
    ELSE 'B'
  END
WHERE ステータス = '対象'

-- UPDATE + APP@profile（CLI 拡張）
UPDATE APP100@qa
SET ステータス = '確認済み'
WHERE $id = 1

-- DELETE
DELETE FROM APP100
WHERE ステータス = 'キャンセル' AND 作成日時 < '2024-01-01'

-- サブテーブル SELECT
SELECT _p.伝票番号, 商品コード, 数量
FROM APP100$明細
WHERE _pid = 123

-- サブテーブル INSERT / UPDATE / DELETE
INSERT INTO APP100$明細 (_pid, 商品コード, 数量)
VALUES (123, 'A-001', 2)

UPDATE APP100$明細
SET 数量 = 5
WHERE _pid = 123 AND _rid = '67890'

DELETE FROM APP100$明細
WHERE _pid = 123 AND _rid = '67890'

-- サブテーブル並び替え
REORDER APP100$明細
BY 商品コード ASC, 納期 DESC
WHERE _pid = 123

REORDER ALL APP100$明細
BY 商品コード ASC

-- 数学関数・剰余
SELECT ABS(差額) AS 差額絶対値, MOD(数量, 3) AS 余り FROM APP100
SELECT POWER(辺長, 2) AS 面積, ROUND(SQRT(面積), 2) AS 辺長 FROM APP100
SELECT 数量 % 3 AS 余り FROM APP100

-- IN (SELECT ...) サブクエリ（FULL_SCAN）
SELECT * FROM APP88
WHERE 顧客名 IN (SELECT 顧客名 FROM APP89 WHERE 顧客ランク = 'A')

-- EXISTS / NOT EXISTS（FULL_SCAN）
SELECT * FROM APP88
WHERE EXISTS (SELECT $id FROM APP89 WHERE 承認フラグ = '1')

SELECT * FROM APP88
WHERE NOT EXISTS (SELECT $id FROM APP89 WHERE フラグ = 'NG')

-- SHOW APPS / DESCRIBE
SHOW APPS
DESCRIBE APP100
DESC APP100

-- SHOW APPS を WITH で絞り込む
WITH アプリ AS (SHOW APPS)
SELECT * FROM アプリ WHERE name LIKE '受注%'

-- UPSERT VALUES
UPSERT INTO APP100 (顧客コード, 顧客名, 金額)
VALUES ('C001', '田中商店', 50000)
ON DUPLICATE (顧客コード)

-- UPSERT SELECT
UPSERT INTO APP100 (顧客コード, 顧客名, 合計金額)
SELECT 顧客コード, 顧客名, SUM(金額)
FROM APP200
WHERE ステータス = '確定'
GROUP BY 顧客コード, 顧客名
ON DUPLICATE (顧客コード)

-- スカラーサブクエリ（WHERE 右辺）
SELECT * FROM APP100
WHERE 金額 > (SELECT AVG(金額) FROM APP100)

-- スカラーサブクエリ（SELECT 列）
SELECT
  顧客名, 金額,
  (SELECT COUNT(*) FROM APP100) AS 総件数,
  (SELECT SUM(金額) FROM APP100) AS 合計金額
FROM APP100
WHERE ステータス = '完了'

-- CURRENT_DATE() / CURRENT_TIMESTAMP()（SELECT 列で使用）
SELECT 顧客名, 金額, CURRENT_TIMESTAMP() AS 取得日時 FROM APP100
SELECT *, CURRENT_DATE() AS 今日 FROM APP100

-- 日付関数
SELECT YEAR(作成日時) AS 年, MONTH(作成日時) AS 月, DAY(作成日時) AS 日 FROM APP100
SELECT DATEDIFF(TODAY(), 期限日) AS 残日数 FROM APP100 WHERE 期限日 != ''

-- ASSERT（実行時ゲート。不成立なら AssertError で停止）
ASSERT (SELECT COUNT(*) FROM APP100 WHERE 異常フラグ = '1') = 0
```
