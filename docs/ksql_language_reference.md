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
10.1. [ウィンドウ関数](#101-ウィンドウ関数)
11. [LIMIT / OFFSET](#11-limit--offset)
12. [UNION / UNION ALL](#12-union--union-all)
13. [WITH 句（CTE）](#13-with-句cte)
14. [SHOW APPS / DESCRIBE](#14-show-apps--describe)
15. [INSERT](#15-insert)
16. [UPDATE](#16-update)
17. [UPSERT](#17-upsert)
18. [DELETE](#18-delete)
18.1. [IMPORT（ファイル取込）](#181-importファイル取込v360)
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

### CLI / MCP / browser engine-library 拡張: 論理アプリ参照 `LAPP_<NAME>`

同じ用途・同じフィールド構成のアプリで物理 ID だけが環境ごとに異なる場合、論理名を使用できます。

```sql
SELECT * FROM LAPP_ORDERS
SELECT * FROM LAPP_注文
SELECT * FROM LAPP_ORDERS@prod
SELECT * FROM LAPP_ORDERS$明細@prod
```

CLI / MCP の `LAPP_ORDERS` は実効 profile の `logicalApps.ORDERS` に設定された物理アプリ IDへ、実行前に解決されます。browser engine-library では `runQuery` / `runBatch` / `explainQuery` の `logicalApps` オプションで同じ対応を渡します。`APP100` は従来どおり常に物理 ID 100 であり、暗黙に論理解決されません。

```json
{
  "profiles": {
    "dev": { "logicalApps": { "ORDERS": 100 } },
    "prod": { "logicalApps": { "ORDERS": 1200 } }
  }
}
```

構文と制約:

- 論理名の開始文字は ASCII 英字または日本語 4 範囲（U+3040–U+30FF、U+3400–U+9FFF、U+F900–U+FAFF、U+FF01–U+FF60）。継続文字には ASCII 数字と `_` も使用可能
- 論理名は最大 64 UTF-16 コードユニット。SQL と設定キーの両側を NFC 正規化してから `toUpperCase()` で canonical 化する（ASCII と全角英字は大小同一、かな・漢字は文字どおり区別）
- 半角 `$` はサブテーブル区切り、半角 `@` は profile 区切りであり、論理名には含めない。全角 `＄` / `＠`、中黒 `・`、長音 `ー` は論理名の文字として扱う
- canonical 化後に同名となる複数キーはエラー
- config のキーは裸の論理名（`ORDERS`）。`APP100`、`100`、`LAPP_ORDERS` は禁止
- 未定義論理名、未知 profile、`allowPhysicalAppRefs: false` の profile に対する物理参照は API 呼び出し前にエラー
- validation は `source`、`logicalName`、内部 `mappedAppId`、最終 `appId`、`profile` を返す
- EXPLAIN と利用者向け診断は論理名・最終物理 ID・profile を表示し、内部 mapped ID は表示しない
- CLI の `DELETE FROM LAPP_ORDERS@prod ...` は明示 profile 制約により拒否。MCPでは許可
- browser engine-library は `@profile` をサポートせず、`LAPP_X@p` / `APP100@p` を API 呼び出し前に明示エラーにする

> **移行上の注意（破壊的変更）**: `LAPP_` の直後が日本語で始まる未引用の識別子は、
> 論理アプリ参照として予約されます。従来フィールド名などに `LAPP_案件` を使っていた場合は、
> バッククォートで `` `LAPP_案件` `` と囲んで識別子として退避してください。未定義のまま
> 別の意味へ変わることはなく、API 呼び出し前にエラーとなります。

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
SELECT 列別名の英字（全角を含む）は結果列名で小文字へ正規化されます。
バッククォートで囲んでも結果列名の大文字・小文字は保持されません。

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
[ORDER BY キーリスト | KORDER BY キーリスト]
[LIMIT 件数 [OFFSET スキップ数]]
```

`ORDER BY` と `KORDER BY` は排他です。`KORDER BY` は比較意味を kintone REST API の型別順序へ切り替える別構文で、`LIMIT` が必須など固有の条件があります。詳細は §10「ORDER BY」内の「KORDER BY（kintone固有順、v3.0.0）」を参照してください。

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

-- 先行して定義した数値バッチ変数も直接使用可能
SET @total = (SELECT SUM(売上) FROM APP100);
SELECT (売上 * 100) / @total AS 構成比 FROM APP100

-- 関数の結果も被演算子として使用可能
SELECT ROUND(合計費用) / 2 AS 半額 FROM APP100
SELECT LENGTH(顧客名) * 100 AS スコア FROM APP100

-- WHERE 句の左辺・右辺に算術式（FULL_SCAN モードで実行）
WHERE 金額 * 1.1 > 10000
WHERE (単価 + 送料) * 数量 < 5000
WHERE 税込金額 = 金額 * 1.1
```

演算子の優先順位は通常の算術規則（`*` `/` > `+` `-`）に従い、カッコで明示指定できます。

算術式の変数は数値でなければなりません。文字列変数を直接算術または `ROUND(算術式, ...)` の算術部分に使うと、`ArgumentError: variable @名前 is not numeric and cannot be used in arithmetic.` で停止します。未定義変数と配列変数は §25 の既存エラー規則に従います。

> **WHERE 算術式は FULL_SCAN モード:** kintone API に変換できないため全件取得後 JS で評価します。

### 算術の精度と空セル（重要な制約）

算術式は **IEEE 754 倍精度浮動小数点（JavaScript の number）** で評価し、結果の丸め・量子化は行いません。`SUM` / `AVG` と統計集約（分散・標準偏差・中央値）も binary64 で計算します。統計集約は厳密 10 進演算の対象外です。次の制約があります。

**1. 小数の表現誤差**（桁数によらず、値に依存して発生します）

```sql
SELECT 金額 * 1.1 FROM APP100   -- 金額=3000 → 3300.0000000000005
                                -- 金額=1000 → 1100（この値ではたまたま誤差なし）
SELECT 0.1 + 0.2                -- 0.30000000000000004
```

このため `WHERE 金額 * 1.1 = 3300` のような**算術結果の等値比較は失敗することがあります**。等値で比較する場合は `ROUND(金額 * 1.1, 2)` のように丸めてください。

**2. 算術の有効桁は 15〜17 桁**（整数は 9,007,199,254,740,992 = 2^53 まで正確）

```sql
SELECT 9007199254740993 + 1     -- → 9007199254740992（+1 が結果に反映されない）
```

単純な数値リテラルは元の10進字句を保持するため、比較・REST query・単純DMLでは丸まりません。`1e3` / `1.2E-3` の指数表記も使用できます。一方、算術へ入るとJavaScript numberになり、安全整数域を超える整数では1の位の変化が消えることがあります。

**3. kintone の計算フィールドとは結果が異なることがあります**

kintone の計算フィールドはサーバー側の 10 進演算＋アプリの `numberPrecision` 設定（桁数・丸めモード）で丸めた値を返します。同じ式でも kSQL の算術は生の浮動小数点値を返すため、結果が一致しないことがあります（実測: 定義が同じ `金額 * 1.1` で、計算フィールド= `3300`・kSQL= `3300.0000000000005`）。**精度が重要な計算は kintone の計算フィールド側に寄せ、kSQL ではその値を参照する**のが安全です。

**4. 空セルは 0 として計算されます**

```sql
SELECT 金額 + 1 FROM APP100     -- 金額が空セル → 1（金額=0 の行と区別できない）
```

kintone の未設定値は空文字で、算術式では 0 に変換されます。空セルを計算対象から除きたい場合は `WHERE 金額 != ''` で除外してください（比較・ORDER BY では v3.0.0 以降、空セルは 0 ではなく最小値として扱われます — §6「型付き比較」参照）。

> **なお、フィールド値そのものは無傷です。** kSQL は取得した数値を文字列のまま保持し、算術式を通さない限り最大30桁を有限10進として厳密比較します。`1.10 = 1.1`、`-0 = 0`、`1e21 = 1000000000000000000000`です。JS算術・SUM/AVG・数値関数が返す値は、既にbinary64へ丸められた `String(number)` の10進値として比較します。

---

## 4. CASE WHEN

条件分岐した値を返します。SELECT 列・WHERE 句・UPDATE SET、および v3.16.0 以降は集計関数の引数で使用できます。

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
- ELSE を省略すると、どの条件にも合致しない場合は NULL 相当になります。集計関数の引数では候補から除外され、それ以外の表示・更新では空文字として扱われます
- IF(条件, then値, else値) は CASE WHEN の短縮記法として使用できます
- 配列リテラルを THEN/ELSE で返す場合、フィールド型に応じて自動変換されます（INSERT VALUES / UPDATE SET）
- 集計関数の引数で使う `CASE` の結果はスカラー値に限ります。配列リテラル・サブクエリ・集計関数は THEN / ELSE に指定できません

### WHEN 条件の評価

`WHEN` の条件には `WHERE` と同じ述語を書けます（比較 `= != < >`・`IN`／`NOT IN`・`LIKE`・`BETWEEN`・`AND`／`OR`／`NOT` 等）。**`WHERE` と同じ述語構文で、kSQL の同じ二値評価規則により行ごとに評価**され、`IN` の一致規則も §6 と同一です（複数値フィールドは「いずれかを含む」判定など）。

```sql
SELECT $id,
  CASE WHEN 区分 IN ('A', 'B') THEN '対象' ELSE '対象外' END AS 判定,
  CASE WHEN タグ IN ('重要') THEN 1 ELSE 0 END AS 重要フラグ   -- チェックボックス＝「含む」判定
FROM APP100
```

- CASE / IF は**常に JavaScript で評価**され（kintone へは押し下げません）、条件は FULL_SCAN と同じ規則で判定します。
- したがって、選択系フィールドに**定義に無い選択肢値**を `WHEN … IN (…)` へ渡しても、`WHERE` が REST に押し下げられて `GAIA_IQ10` になり得るのと違い、CASE の条件は常にローカル評価なので**エラーにならず単に不一致**になります（§6 の「定義に無い選択肢値」の注意を参照）。

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
| `LENGTH` | `LENGTH(フィールド)` | UTF-16 コードユニット数（kintone の文字数）を返す |
| `LENGTH_CHAR` | `LENGTH_CHAR(フィールド)` | Unicode コードポイント数を返す |
| `SUBSTRING` | `SUBSTRING(フィールド, 開始 [, 長さ])` | 部分文字列（1-indexed、`SUBSTR` も可） |
| `LEFT` | `LEFT(値, 文字数)` | 先頭から指定文字数を返す |
| `RIGHT` | `RIGHT(値, 文字数)` | 末尾から指定文字数を返す |
| `INSTR` | `INSTR(値, 検索文字列)` | 検索位置を 1-indexed で返す（見つからなければ `0`） |
| `CONCAT` | `CONCAT(値1, 値2, ...)` | 文字列の連結（可変長引数） |
| `REPLACE` | `REPLACE(フィールド, 検索, 置換)` | 文字列置換 |
| `REGEXP_LIKE` | `REGEXP_LIKE(値, パターン [, フラグ])` | 一致すれば文字列 `'1'`、非一致なら文字列 `'0'` |
| `REGEXP_REPLACE` | `REGEXP_REPLACE(値, パターン, 置換 [, フラグ [, occurrence]])` | 正規表現に一致する箇所の全部または N 番目を置換 |
| `REGEXP_SUBSTR` | `REGEXP_SUBSTR(値, パターン [, フラグ])` | 最初の一致文字列（非一致は空文字） |
| `TRANSLATE` | `TRANSLATE(値, 変換元, 変換先)` | コードポイント単位の 1 文字対 1 文字写像 |
| `COALESCE` | `COALESCE(値1, 値2, ...)` | 最初の非空値を返す |
| `ISNULL` | `ISNULL(値, 代替値)` | 値が空なら代替値、それ以外は値（`COALESCE` の 2 引数版） |
| `NULLIF` | `NULLIF(値1, 値2)` | 値1 と 値2 が等しければ空文字、それ以外は 値1 |
| `GREATEST` | `GREATEST(値1, 値2, ...)` | 行内の最大値（2 引数以上） |
| `LEAST` | `LEAST(値1, 値2, ...)` | 行内の最小値（2 引数以上） |
| `LPAD` | `LPAD(値, 長さ [, 埋め文字列])` | 左側を埋める（既定は半角スペース） |
| `RPAD` | `RPAD(値, 長さ [, 埋め文字列])` | 右側を埋める（既定は半角スペース） |

```sql
SELECT UPPER(ステータス) AS ステータス FROM APP100
SELECT CONCAT(姓, '　', 名) AS 氏名 FROM APP100
SELECT '氏名: ' || 姓 || '　' || 名 AS 表示 FROM APP100   -- || は CONCAT と同義（v3.4.0）
SELECT SUBSTRING(郵便番号, 1, 3) AS 市外局番 FROM APP100
SELECT LEFT(顧客コード, 2) AS 分類, RIGHT(顧客コード, 4) AS 連番 FROM APP100
SELECT LPAD(顧客No, 5, '0') AS 顧客コード FROM APP100
SELECT GREATEST(見積額, 受注額, 請求額) AS 最大額 FROM APP100
SELECT REPLACE(電話番号, '-', '') AS 電話番号 FROM APP100
SELECT REGEXP_LIKE(郵便番号, '^[0-9]{3}-[0-9]{4}$') AS 書式OK FROM APP100
SELECT REGEXP_REPLACE(電話番号, '[^0-9]', '') AS 数字のみ FROM APP100
SELECT REGEXP_SUBSTR(メモ, '[A-Z]{2}-[0-9]{6}') AS 受付番号 FROM APP100
SELECT LENGTH(会社名) AS kintone文字数, LENGTH_CHAR(会社名) AS コードポイント数 FROM APP100
SELECT TRANSLATE(会社名, '啞焰鷗', '唖焔鴎') AS 会社名 FROM APP100
SELECT COALESCE(メモ, '（なし）') AS メモ FROM APP100
SELECT ISNULL(建物名, '（なし）') AS 建物名 FROM APP100
SELECT NULLIF(業種, 'その他') AS 業種 FROM APP100   -- 'その他' を空にする
```

> `SUBSTRING` の開始位置は 1 以上です。`0` 以下は `1` と同じく先頭から扱います。MySQL のような「負数＝末尾から」の切り出しには対応していないため、末尾から取得する場合は `RIGHT` を使用してください。

`SUBSTRING` / `LEFT` / `RIGHT` / `LPAD` / `RPAD` の長さ引数はコードユニット予算です。サロゲートペアを割る境界では安全な側へ縮めます。結果は必ず指定予算以下になります。`LPAD` / `RPAD` では、指定予算の残りに埋め文字列を安全に収められない場合、結果が指定長より短くなることがあります。

`LENGTH` は kintone と同じ UTF-16 コードユニット数、`LENGTH_CHAR` は Unicode コードポイント数を返します。たとえば `LENGTH('𠮟') = 2`、`LENGTH_CHAR('𠮟') = 1` です。`LENGTH(x) - LENGTH_CHAR(x)` は、入力に含まれるサロゲートペア数になります。`LENGTH_CHAR` は書記素数ではないため、IVS・結合文字・ZWJ 絵文字を人が見る 1 文字としてまとめません。

`TRANSLATE` は `変換元` と `変換先` をコードポイント単位で位置対応させる、1 文字から 1 文字への写像専用関数です。両者の文字数が異なる場合は `ArgumentError` になり、`変換元` に同じ文字が複数ある場合は最初の対応が優先されます。対応しない入力文字はそのまま返します。`ﾎﾞ`（2 文字）から `ボ`（1 文字）のような半角カナから全角カナへの変換は 2 対 1 を含むため、`TRANSLATE` だけではできません。

正規表現3関数は ECMAScript（JavaScript）方言を使い、POSIX ERE ではありません。フラグは `i` / `m` / `s` のみ指定でき、Unicode モード `u` は常に有効です。`g` / `y` / `d` / `u` / `v` その他のフラグは `ArgumentError` になります。`REGEXP_REPLACE` の `occurrence` は省略または `0` で全一致、非負整数 `N`（1 以上）で N 番目の一致だけを置換し、一致数を超える場合は入力を変更しません。kSQL では第4引数がフラグ、第5引数が `occurrence` であり、MySQL／Oracle とは引数位置が異なります。置換文字列の `$1`〜`$99`・`$<name>`・`$&`・`$$` は ECMAScript の規則で解釈します。前後文字列を挿入する `` $` `` と `$'` は使用できません。`REGEXP_SUBSTR` は非一致と空文字一致のどちらも空文字を返すため、区別が必要な場合は `REGEXP_LIKE` を併用してください。パターン、フラグ、`occurrence` にはリテラルだけでなく式やフィールドを指定でき、行ごとに実行時評価されます。

> **正規表現の利用はユーザー責任です。** パターンによっては ReDoS（破滅的バックトラック）で実行が暴走し、kSQL からは中断できません。プラグインではタブを強制終了（同じタブの未保存レコード編集と未保存 SQL も失われます）、CLI では Ctrl+C、MCP ではプロセスを再起動してください。MCP では同一プロセスの他のリクエストも停止します。
>
> 結果や構文の受理可否は実行環境（ブラウザ／Node）とその版に依存し得ます。特に `\p{}`、`u+i` の case folding は Unicode 版差、新しい正規表現構文は Node 版差の影響を受け、同じ SQL でもプラグイン・CLI・MCP で結果が変わる場合があります。

`GREATEST` / `LEAST` は、列方向の集約関数 `MAX` / `MIN` とは異なり、同じ行の引数同士を比較します。空文字は常に最小です。空文字を除いた集合がすべて数値なら数値比較し、1 つでも非数値なら集合全体を文字列比較します。数値が同値なら元の文字列表記を二次キーにするため、引数順によって結果は変わりません。

`LEFT` / `RIGHT` / `INSTR` / `GREATEST` / `LEAST` / `LPAD` / `RPAD` は引数の個数を検証し、不正な場合は `ArgumentError` になります。`LPAD` / `RPAD` で埋め文字列が空の場合は、入力値をそのまま返します。

- `LENGTH_CHAR` / `TRANSLATE` / `REGEXP_LIKE` / `REGEXP_REPLACE` / `REGEXP_SUBSTR` / `INSTR` / `GREATEST` / `LEAST` / `LPAD` / `RPAD` は予約語です。同名フィールドは `` `REGEXP_LIKE` `` のようにバッククォートで囲みます。`LEFT` / `RIGHT` は `LEFT JOIN` / `RIGHT JOIN` の予約語を兼ねており、直後に `(` がある場合のみ関数として扱います。

> **`ISNULL` は 2 引数（SQL Server 系）です。** MySQL の 1 引数 `ISNULL(式)`（真偽を返す）とは**別物**です。空判定には `IS NULL` / `IS NOT NULL`（→ [§6](#6-where-句)）を使ってください。

> **`NULLIF` によるゼロ除算ガードは効きません。** kintone には NULL がなく kSQL では**空文字が NULL 相当**のため、`NULLIF(x, 0)` の結果（空文字）を除数にすると `Number('') = 0` となり、結局ゼロ除算で `NaN` になります。
>
> ```sql
> -- ✗ RDB の定番だが kSQL では NaN（ガードにならない）
> SELECT 1000 / NULLIF(金額, 0) AS 単価 FROM APP100   -- 金額=0 の行も、金額が空セルの行も NaN
>
> -- ○ NULL 置換としては正しく機能する
> SELECT ISNULL(NULLIF(金額, 0), '未設定') AS 金額 FROM APP100   -- 金額=0 の行は「未設定」
>
> -- ✗ ゼロだけガードすると空セルがすり抜ける
> SELECT CASE WHEN 金額 = 0 THEN '' ELSE 1000 / 金額 END AS 単価 FROM APP100   -- 金額が空セルの行は NaN
>
> -- ○ 空セルとゼロの両方をガードする
> SELECT CASE WHEN 金額 = '' OR 金額 = 0 THEN '' ELSE 1000 / 金額 END AS 単価 FROM APP100
> ```
>
> **`= 0` だけでは空セルを捕まえられません。** 空文字は**算術では 0 になりますが、比較では 0 と等しくない**ため、`CASE WHEN 金額 = 0` は空セルの行を `ELSE` へ落とし、そこで `Number('') = 0` によるゼロ除算が起きます。

> **どの除数にガードが要るかは、値の作り方で決まります**（実測・v3.54.1）。
>
> | 除数の作り方 | 値が無いとき | `= 0` だけ | 必要なガード |
> |---|---|---|---|
> | **`SUM` / `COUNT` / `AVG` を通した値** | `0` | 捕まえる | `= 0` で足りる |
> | **`MIN` / `MAX` を通した値** | 空文字 | **すり抜けて `NaN`** | `= '' OR = 0` |
> | **素の列として渡ってきた値** | 空文字 | **すり抜けて `NaN`** | `= '' OR = 0` |
>
> **「集計を通したから安全」ではありません。** `SUM` / `COUNT` / `AVG` は対象行が 1 行も無くても `0` を返しますが（MySQL は `NULL` を返すため、ここは方言差です）、**`MIN` / `MAX` は空文字を返します**（v3.54.0 で `0` から変更。→ [集計関数](#集計関数)）。
>
> **空文字は「値が無かった」ことから生まれます**——`LEFT JOIN` で一致しなかった行、`LAG` / `LEAD` でパーティションの端、`NULLIF` の結果、そして**対象が 0 件の `MIN` / `MAX`**。**除数がこれらのいずれかなら `= '' OR = 0` が要ります。**
>
> **踏みやすいのは「率」ではなく「〜あたり」の指標です。** **在庫日数**（在庫 ÷ 出庫ペース）・**単価**（金額 ÷ 数量）・**1 件あたり**・**回転率**——いずれも**分母が「動きの無い対象」で空になります**。前月比のような「率」より、**対象そのものが止まっている場合に分母が消える**形のほうが踏みやすく、**エラーは出ず `NaN` が表に載ります**。
>
> ```sql
> -- 集計を通しているので = 0 で足りる
> SELECT SUM(売上) / COUNT(*) AS 平均 FROM APP100
>
> -- LEFT JOIN で一致しない行の 出庫数 は空文字。= '' が要る
> SELECT CASE WHEN s.出庫数 = '' OR s.出庫数 = 0 THEN '' ELSE 1000 / s.出庫数 END
> FROM APP200 m LEFT JOIN #集計 s ON m.製品名 = s.製品名
> ```

### 数値関数

| 関数 | 構文 | 説明 |
|------|------|------|
| `ROUND` | `ROUND(フィールド [, 桁])` | 四捨五入 |
| `FLOOR` | `FLOOR(フィールド [, 桁])` | 切り捨て |
| `CEIL` | `CEIL(フィールド [, 桁])` | 切り上げ（`CEILING` も可） |
| `TRUNCATE` | `TRUNCATE(フィールド [, 桁])` | 0 方向へ切り捨て（`TRUNC` も可） |

桁数の指定:
- 正の整数: 小数点以下 n 桁で丸める
- `0`（省略時）: 整数に丸める
- 負の整数: 10^n の単位で丸める

```sql
SELECT ROUND(金額, 2)  AS 金額   FROM APP100   -- 例: 1234.567 → 1234.57
SELECT ROUND(金額)     AS 金額   FROM APP100   -- 例: 1234.5   → 1235
SELECT ROUND(金額, -3) AS 千単位 FROM APP100   -- 例: 1234567  → 1235000
SELECT FLOOR(金額, -2) AS 百未満切捨 FROM APP100
SELECT TRUNCATE(金額, 2) AS 小数2桁切捨 FROM APP100
```

`FLOOR` が常に小さい方へ丸めるのに対し、`TRUNCATE` は 0 方向へ丸めます。負数で差が出ます（`FLOOR(-1.5)` = `-2`、`TRUNCATE(-1.5)` = `-1`）。

- `TRUNCATE` / `TRUNC` は予約語です。同名フィールドは `` `TRUNCATE` `` とバッククォートで囲みます。

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

> 関数エイリアスの canonical 対応は `SUBSTR` → `SUBSTRING`、`CONVERT` → `CAST`、`CEILING` → `CEIL`、`TRUNC` → `TRUNCATE`、`POW` → `POWER` です。

型名: `TEXT` / `VARCHAR` / `CHAR` → 文字列、`NUMBER` / `INT` / `INTEGER` / `DECIMAL` / `FLOAT` → 数値

```sql
SELECT CAST(金額 AS TEXT) AS 金額文字列 FROM APP100
SELECT CAST(コード AS NUMBER) AS コード数値 FROM APP100
```

### 日付・日時関数

> **`WEEK()` は ISO-8601 固定です。MySQL `WEEK()` の既定 mode 0 とは互換性がなく、mode 引数は指定できません。** 週は月曜始まりで、その年の木曜日を含む週が W01 です。

| 関数 | 構文 | 説明 |
|------|------|------|
| `YEAR` | `YEAR(フィールド)` | 年を返す |
| `MONTH` | `MONTH(フィールド)` | 月を返す（1〜12） |
| `DAY` | `DAY(フィールド)` | 日を返す（1〜31） |
| `DAYOFWEEK` | `DAYOFWEEK(日付)` | 曜日番号を返す（1=日曜〜7=土曜） |
| `QUARTER` | `QUARTER(日付)` | 四半期を返す（1〜3月=1、10〜12月=4） |
| `WEEK` | `WEEK(日付)` | ISO-8601 週番号をゼロ埋めなしで返す（1〜53） |
| `DATE_FORMAT` | `DATE_FORMAT(フィールド, フォーマット)` | 日付を書式化 |
| `DATEDIFF` | `DATEDIFF(日付1, 日付2)` | 日数差（日付1 − 日付2） |
| `DATE_ADD` | `DATE_ADD(日付, 加算値, 単位)` | 日付加算（単位は `'YEAR'` / `'MONTH'` / `'DAY'`） |
| `LAST_DAY` | `LAST_DAY(日付)` | 月末日を `YYYY-MM-DD` で返す |
| `CURRENT_DATE()` | `CURRENT_DATE()` | 今日の日付（`YYYY-MM-DD`）を JS で取得 |
| `CURRENT_TIMESTAMP()` | `CURRENT_TIMESTAMP()` | 現在日時（ISO 8601）を JS で取得 |

```sql
SELECT YEAR(作成日時) AS 年, MONTH(作成日時) AS 月 FROM APP100
SELECT DAYOFWEEK(受注日) AS 曜日番号, QUARTER(受注日) AS 四半期 FROM APP100
SELECT DATE_FORMAT(受注日, '%G-%v') AS ISO週, COUNT(*) FROM APP100 GROUP BY DATE_FORMAT(受注日, '%G-%v')
SELECT DATEDIFF(TODAY(), 期限日) AS 残日数 FROM APP100
SELECT DATE_FORMAT(作成日時, '%Y-%m') AS 年月 FROM APP100
SELECT DATE_ADD(期限日, -1, 'MONTH') AS 前月, LAST_DAY(期限日) AS 月末日 FROM APP100

-- SELECT 列で現在日時を付加（常に JS 評価）
SELECT 顧客名, 金額, CURRENT_TIMESTAMP() AS 取得日時 FROM APP100
SELECT *, CURRENT_DATE() AS 今日 FROM APP100

-- WHERE でも使用可能（FULL_SCAN）
SELECT * FROM APP100 WHERE 作成日 = CURRENT_DATE()
```

`DATE_FORMAT` は次の指定子に対応します。ISO 週ラベルには、暦年 `%Y` ではなく ISO week-year `%G` を使う **`%G-%v`** を推奨します（年をまたぐ週で `%Y-%v` は誤った組み合わせになります）。

| 指定子 | 値 |
|---|---|
| `%Y` | 4桁年 |
| `%y` | 2桁年 |
| `%m` | 2桁月（`01`〜`12`） |
| `%c` | 月（`1`〜`12`） |
| `%d` | 2桁日（`01`〜`31`） |
| `%e` | 日（`1`〜`31`） |
| `%H` | 2桁時（`00`〜`23`） |
| `%i` | 2桁分（`00`〜`59`） |
| `%s` | 2桁秒（`00`〜`59`） |
| `%w` | 曜日番号（0=日曜〜6=土曜） |
| `%a` | **kSQL 定義**の日本語短縮曜日（`日`〜`土`。MySQL の英語短縮名とは非互換） |
| `%v` | ISO 週番号（`01`〜`53`） |
| `%G` | ISO week-year（4桁） |

新しい日付軸関数と `%w` / `%a` / `%v` / `%G` は、先頭10文字が `YYYY-MM-DD` で暦上実在する日付の場合だけ値を返します。不正日付では関数は空文字になり、`DATE_FORMAT` は新しい指定子だけを空文字へ置換します。たとえば `DATE_FORMAT('2026-02-31', '%Y|%w|%G-%v')` は `2026||-` です。既存9指定子は従来どおり文字列部分を整形します。未対応指定子、単独 `%`、`%%Y` は従来どおり素通しです。

`DATE_ADD` の単位は大文字小文字を区別しません。`YEAR` / `MONTH` / `DAY` 以外を指定すると、リテラル・フィールド参照のどちらでも実行時に `ArgumentError` になります。`YEAR` / `MONTH` の加減算で元の日が対象月に存在しない場合は、対象月の末日へ丸めます（例: `DATE_ADD('2026-01-31', 1, 'MONTH')` は `2026-02-28`）。この丸めが起きると、逆向きに同じ月数を加算しても元の日には戻りません（`2026-01-31` → `2026-02-28` → `2026-01-28`）。`DAY` 加算ではこの丸めは行いません。`DATE_SUB` はありません。減算は加算値に負数を指定してください（`DATE_ADD(期限日, -1, 'MONTH')`）。

- `DAYOFWEEK` / `QUARTER` / `WEEK` / `LAST_DAY` は予約語です。同名フィールドは `` `WEEK` `` のようにバッククォートで囲みます。`WEEKLY` のような長い識別子は影響を受けません。

> **`CURRENT_DATE()` / `CURRENT_TIMESTAMP()` はキーワードではありません。**  
> `()` があれば関数、なければフィールド参照として扱われます。kSQL のスカラー関数であり、
> kintone REST query への押し下げ経路はありません。SELECT 列でも `WHERE` でも、常に
> **実行環境のローカルタイムゾーン**で client 評価されます。本リリースの
> kintone query function の fail-closed 対象外です。

#### kintone クエリ関数（server-only）

`TODAY()` / `NOW()` / `LOGINUSER()` / `PRIMARY_ORGANIZATION()` と次の相対日付12関数は、`WHERE` で kintone REST query
へそのまま渡す **server-only** 関数です。Node / CLI / MCP / プラグインで client 評価せず、
kintone サーバーが値・期間と比較結果を決定します。

| 関数 | 対象フィールド型 | 演算子・形 |
|---|---|---|
| `TODAY()` | `DATE` / `DATETIME` / `CREATED_TIME` / `UPDATED_TIME` | 比較右辺の `=` / `!=` / `<` / `<=` / `>` / `>=`、`BETWEEN` 境界 |
| `NOW()` | `DATETIME` / `CREATED_TIME` / `UPDATED_TIME` | 比較右辺の `=` / `!=` / `<` / `<=` / `>` / `>=`、`BETWEEN` 境界。**`DATE` には使用不可** |
| `LOGINUSER()` | `CREATOR` / `MODIFIER` / `USER_SELECT` | singleton の `in (LOGINUSER())` / `not in (LOGINUSER())` のみ |
| `PRIMARY_ORGANIZATION()` | `ORGANIZATION_SELECT` | singleton の `in (PRIMARY_ORGANIZATION())` / `not in (PRIMARY_ORGANIZATION())` のみ |

```sql
SELECT * FROM APP100 WHERE 日付 = TODAY()
SELECT * FROM APP100 WHERE 作成日時 <= NOW()
SELECT * FROM APP100 WHERE 作成者 in (LOGINUSER())
SELECT * FROM APP100 WHERE 担当者 not in (LOGINUSER())
SELECT * FROM APP100 WHERE 担当組織 in (PRIMARY_ORGANIZATION())
```

`LOGINUSER()` は `作成者` / `更新者` / ユーザー選択だけに使用できます。
**グループ選択には使用できません**（kintone 公式の型別表で利用可能な関数は「なし」）。
`PRIMARY_ORGANIZATION()` は組織選択だけに使用できます。
**優先組織が未設定のユーザーでは、kintone がこの条件を無視し、
他の条件を満たす全レコードを返します**（kintone 公式の記述。2026-07-31 に実機で再現を確認）。

**エンジンからは、条件が無視されたかどうかを判別できません。**そのため扱いが分かれます。

| | |
|---|---|
| **DML**（`UPDATE` / `DELETE` / `UPSERT` と `INSERT` / `UPSERT ... SELECT` の source） | **常に拒否**します。条件が消えると対象がアプリ全件になるためです |
| **`SELECT`** | **そのまま返します**（kintone の一覧の絞り込みと同じ挙動） |

> **`SELECT` で使う場合は注意してください。**
> **優先組織が未設定の利用者には、絞り込みが効かないまま全件が返ります。**
> **画面からは区別がつかず、警告も出ません**（出せません）。
> ダッシュボードのように結果だけを見せる用途では、**利用者側での案内を検討してください。**

**相対日付関数（12関数）**

| 分類 | 関数と引数 |
|---|---|
| 前日・翌日 | `YESTERDAY()` / `TOMORROW()` |
| 相対期間 | `FROM_TODAY(n, unit)`。`n` は `-9,007,199,254,740,991`〜`9,007,199,254,740,991` の10進安全整数、`unit` は `DAYS` / `WEEKS` / `MONTHS` / `YEARS` |
| 週 | `THIS_WEEK([weekday])` / `LAST_WEEK([weekday])` / `NEXT_WEEK([weekday])`。曜日は `SUNDAY`〜`SATURDAY`、省略時は週全体 |
| 月 | `THIS_MONTH([day])` / `LAST_MONTH([day])` / `NEXT_MONTH([day])`。`day` は `1`〜`31` / `LAST`、省略時は月全体 |
| 年 | `THIS_YEAR()` / `LAST_YEAR()` / `NEXT_YEAR()` |

```sql
SELECT * FROM APP100 WHERE 作成日時 < FROM_TODAY(5, DAYS)
SELECT * FROM APP100 WHERE 更新日時 = THIS_WEEK(MONDAY)
SELECT * FROM APP100 WHERE 日付 = LAST_MONTH(LAST)
SELECT * FROM APP100
WHERE 日付 BETWEEN FROM_TODAY(-7, DAYS) AND TODAY()
```

- 対象は単一の物理アプリに由来する `DATE` / `DATETIME` / `CREATED_TIME` / `UPDATED_TIME` フィールドだけです。比較は6種の `=` / `!=` / `<` / `<=` / `>` / `>=` を使用でき、`<>` は `!=` へ正規化されます。`BETWEEN` は両境界を `>=` / `<=` へ展開し、両方を exact pushdown できる場合だけ使用できます。
- kintone クエリ関数を含む条件は、レコード取得前に REST query への押し下げ計画が確定できる場合だけ実行できます。関数そのものを client 評価する **client fallback はなく**、client 評価回数は常に 0 です。`ksql_validate` は構文と引数形を検査しますが、型と物理計画の可否は metadata を使う `ksql_query` / `ksql_explain` / 実行時に確定します。
- **性能**: kintone クエリ関数は**押し下げできなければ実行できません**（client fallback なし）。
  したがって**実行できた時点で、候補の絞り込みは kintone サーバー側で終わっています**。
  `LIKE` のように黙って FULL_SCAN（全件取得）になることはありません。
  同じアプリ・同じ `maxRecords` でも結果が分かれます。

  ```
  APP4148（215 件）・maxRecords=5

  SELECT COUNT(*) FROM APP4148 WHERE 作成者 in (LOGINUSER())
    → 成功。kintone 側で絞り込むため、215 件のアプリでも上限に掛からない

  SELECT COUNT(*) FROM APP4148 WHERE 会社名 LIKE '%株式会社%'
    → 上限エラー。FULL_SCAN で全件取得しようとする

  SELECT COUNT(*) FROM APP4148 WHERE 会社名 LIKE '%株式会社%' OR 作成者 in (LOGINUSER())
    → レコード取得前に拒否（WHERE_KINTONE_FUNCTION_REQUIRES_EXACT_PUSHDOWN）
  ```

  ただし**形2（prefilter ＋残余）では、取得件数が減るのは関数条件の分だけ**です。
  残余は client 評価なので、関数条件を満たす集合は全件取得します。
  `EXPLAIN` の `where capability`（`EXACT_PUSHDOWN` か）、
  `kintone query`（実際に送る query 文字列）、
  `kintone function client evaluations`（常に 0）で確認できます。
- **kintone クエリ関数を使える SELECT の形は次の4つです**。3・4が INNER JOIN の
  **第5許可形**です。いずれも関数 occurrence を kintone server へ exact に適用し、
  client 側で関数を評価しません。

  1. **その SELECT の `WHERE` 全体を exact pushdown できる形**（v3.24.0 で `GROUP BY` 等、B75 で CTE・一時テーブル source に拡大）。複数条件・`OR`・`BETWEEN` を含んでいても、`WHERE` 全体が kintone クエリへ完全に変換できるなら使用できます。トップレベル SELECT に加え、**実体化 CTE の本体、`WITH` の最終 SELECT、`CREATE TEMP TABLE ... AS SELECT` / `CREATE TEMP TABLE ... AS WITH ...` の source、単一 CTE のインライン展開**でも使用できます。`GROUP BY` / `SELECT DISTINCT` / 集計関数 / ウィンドウ関数 / 通常の `ORDER BY` を含んでいても構いません。トップレベルの `KORDER BY` もこの whole-WHERE exact の形だけは native / Cursor とも使用できます（`WHERE` 全体をサーバーへ渡し、取得後の client 側 WHERE 評価は行いません）。

     ```sql
     SELECT * FROM APP100 WHERE 日付 = THIS_MONTH()
     SELECT * FROM APP100 WHERE 日付 = THIS_MONTH() OR 日付 = LAST_MONTH()   -- OR も可（両辺とも押し下げ可能なため）
     SELECT 区分, COUNT(*) AS 件数 FROM APP100
     WHERE 日付 = THIS_MONTH() GROUP BY 区分                                  -- 集計クエリでも可（v3.24.0）
     SELECT * FROM APP100 WHERE 日付 = THIS_MONTH() ORDER BY 日付             -- 通常の ORDER BY も可（v3.24.0）
     SELECT 日付 FROM APP100 WHERE 日付 = TODAY()
     KORDER BY 日付 LIMIT 5                                                   -- KORDER も whole-WHERE exact なら可
     WITH 月別 AS (
       SELECT 区分, COUNT(*) AS 件数 FROM APP100
       WHERE 日付 = THIS_MONTH() GROUP BY 区分
     )
     SELECT * FROM 月別                                                        -- 実体化 CTE 本体でも可
     CREATE TEMP TABLE #今月 AS
     SELECT * FROM APP100 WHERE 日付 = THIS_MONTH()                            -- 一時テーブル source でも可
     ```

  2. **prefilter ＋残余（v3.21.0）**: 単一の物理アプリを読む SELECT で、kintone クエリ関数の exact leaf が「関数を含まない残余」（例 `LENGTH(都道府県) > 1`・`LIKE`）と `AND` で結ばれている場合。関数 leaf だけを kintone REST query の prefilter として押し下げ、取得後は残余だけを client 評価します。関数の値・比較は依然すべて kintone サーバーが決定します。`BETWEEN` 展開の各境界や複数の関数 leaf、`KLIKE`・押し下げ可能な安全リーフとの併用も同じ規則で prefilter に載ります。この形は `GROUP BY` などで FULL_SCAN になっていても使用できます。

     ```sql
     SELECT 日付, 件名 FROM APP100
     WHERE 日付 = TODAY() AND LENGTH(件名) > 1   -- 日付だけ server prefilter、LENGTH だけ client
     ```

  3. **第5-W（INNER JOIN・single-alias whole-WHERE exact）**: 全 source が alias 付きの
     物理 APP で、`WHERE` 全体が単一 alias に属し、kintone query へ exact に変換できる場合。
     同じ alias 内の `OR` / `NOT` と、whole-WHERE exact な `KLIKE` 共存も使用できます。
     `WHERE` 全体を対象 APP に一度だけ送り、client residual はありません。

     ```sql
     SELECT a.$id, a.日付
     FROM APP100 a INNER JOIN APP200 b ON a.$id = b.$id
     WHERE a.日付 = THIS_MONTH() OR a.日付 = LAST_MONTH()
     ```

  4. **第5-L（INNER JOIN・AND-spine exact leaf）**: `WHERE` の AND スパインにある
     exact な関数 leaf を alias ごとに採用し、それぞれの APP へ押し下げます。
     複数 alias に関数が分散していても使用でき、関数を含まない残余だけを client 評価します。
     `LOGINUSER()` は `作成者` / `更新者` / ユーザー選択、`PRIMARY_ORGANIZATION()` は
     組織選択の singleton `in` / `not in` に限ります。

     ```sql
     SELECT a.$id, a.日付, b.作成者
     FROM APP100 a INNER JOIN APP200 b ON a.$id = b.$id
     WHERE a.日付 = THIS_MONTH()
       AND b.作成者 in (LOGINUSER())
       AND LENGTH(a.件名) > 1
     ```

- 次の計画は、関数を安全に exact 押し下げしつつ残余だけを client 評価する保証がないため、レコード・Cursor・mutation API の前に fail-closed します（legacy 4 関数は reason `WHERE_KINTONE_FUNCTION_REQUIRES_EXACT_PUSHDOWN`、相対日付12関数は `WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN`）。

  - 相対日付関数が `OR` の枝または `NOT` の配下にあり、**`WHERE` 全体としては exact pushdown できない**場合（`OR` の他方に `LENGTH()` などの押し下げ不能な述語があるとき等）。`OR` を含むこと自体は拒否理由ではありません。**回避策**: 押し下げ可能な述語へ置換する（例 `都道府県 != ''`）か、上記2の形（相対日付 leaf と残余を `AND` で結ぶ）にします。
  - `LEFT` / `RIGHT JOIN`、cross-alias `OR`、cross-table 述語に関数を含む形、
    whole-WHERE exact でない `KLIKE` を含む `OR`。一部の KLIKE 混在形は、関数側が
    exact でないことを示す `WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN`
    （legacy 4関数では `WHERE_KINTONE_FUNCTION_REQUIRES_EXACT_PUSHDOWN`）で拒否します。
  - サブテーブル・入れ子 SELECT（スカラーサブクエリ等）・派生表・CTE・一時テーブルを
    JOIN 入力にする形、`VALIDATE`。`GROUP_SELECT in (LOGINUSER())` は kintone 公式に
    対応するクエリ関数がないため `WHERE_KINTONE_FUNCTION_FIELD_TYPE_UNSUPPORTED` です。
    **実体化 CTE 本体・`WITH` の最終クエリ・一時テーブル source が `UNION` の場合**
    も拒否します（トップレベルの `UNION` は枝ごとに判定するため、各枝が条件を満たせば
    使用できます）。**`KORDER BY` と DML（`UPDATE` / `DELETE` の対象選択、
    `INSERT` / `UPSERT ... SELECT` の source）は上記1の whole-WHERE exact のみ可**で、
    上記2の prefilter＋残余や FULL_SCAN_EXACT は使用できません。ただし
    **`PRIMARY_ORGANIZATION()` を含む DML は whole-WHERE exact でも常に拒否します**。
- 拒否形の `EXPLAIN` は throw せず、`plan status: rejected`、対象 alias / field、
  reason、`client evaluation: forbidden`、実行 API なしを表示します。
- **CTE・一時テーブルに残る非対称**: 押し下げ不能な述語が `AND` で混ざる形（例 `WHERE 日付 = THIS_MONTH() AND LENGTH(件名) > 1`）は、トップレベルの単一物理アプリ SELECT では上記2の prefilter＋残余として使用できますが、**CTE 本体・`WITH` の最終 SELECT・一時テーブル source では使用できません**。これらの実体化経路では、その SELECT の `WHERE` 全体が exact である必要があります。該当する場合は CTE や一時テーブルへ切り出さず、トップレベル SELECT として書いてください。
- 一時テーブルの実体化行数には通常の `maxRecords` とは別に専用の `tempTableMaxRows`（既定 10,000）が適用されます。超過時は `onLimit` の設定にかかわらず常にエラーで、日付リテラルと相対日付で扱いは同一です。
- legacy 4 関数の診断 reason code は `WHERE_KINTONE_FUNCTION_FIELD_TYPE_UNSUPPORTED`、`WHERE_KINTONE_FUNCTION_OPERATOR_UNSUPPORTED`、`WHERE_KINTONE_FUNCTION_CONTEXT_UNSUPPORTED`、`WHERE_KINTONE_FUNCTION_REQUIRES_EXACT_PUSHDOWN` です。相対日付12関数は `WHERE_RELATIVE_DATE_ARGUMENT_INVALID`、`WHERE_RELATIVE_DATE_FIELD_TYPE_UNSUPPORTED`、`WHERE_RELATIVE_DATE_OPERATOR_UNSUPPORTED`、`WHERE_RELATIVE_DATE_CONTEXT_UNSUPPORTED`、`WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN` を使用します。
- 関数名、`DAYS` / `WEEKS` / `MONTHS` / `YEARS`、曜日、`LAST` は hard keyword ではなく、該当する WHERE 値・引数位置だけで解釈する soft keyword です。同名フィールドは通常どおり使えます。関数呼び出しとの曖昧さを避ける場合は `` `FROM_TODAY` ``、`` `LAST` `` のようにバッククォートで退避してください。引用した単位・曜日・`LAST` は関数引数としては受理しません。

### 関数のネスト

関数の引数に別の関数を指定できます。

```sql
SELECT UPPER(TRIM(氏名)) AS 氏名 FROM APP100
SELECT ROUND(金額 * 1.1, 0) AS 税込金額 FROM APP100
```

---

## 6. WHERE 句

> **ユーザー系・複数選択系には `in` / `not in` を使います。** 型に合わない演算子
> （`WHERE 作成者 = 'taro'` など）は `WHERE_OPERATOR_INVALID_FOR_FIELD_TYPE` で
> レコード取得前に拒否します（0 件を静かに返すことはありません）。
>
> **`TODAY()` / `NOW()` / `LOGINUSER()` は kintone REST query へ押し下げられる形だけ**
> 使用できます。押し下げ不能な位置に書くと
> `WHERE_KINTONE_FUNCTION_REQUIRES_EXACT_PUSHDOWN` で拒否します（`WHERE 日付 = NOW()`
> のような型不一致、`WHERE $id >= TODAY()` も同様）。使用できる 4 つの形は
> [§5 kintone クエリ関数](#kintone-クエリ関数server-only)にあります。
>
> 押し下げ可能な関数 leaf と残余を `AND` で結ぶ形（`WHERE 日付 = TODAY() AND LENGTH(件名) > 1`）
> では、**関数条件だけを server prefilter へ押し下げ、残余だけを client で評価**します。
> `KORDER BY` と DML は whole-WHERE exact の形だけで、この prefilter＋残余は使えません。

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

> **日時フィールドの境界:** `DATETIME` / 作成日時 / 更新日時では、日付だけの `'2026-07-14'` は
> **その日の 0:00 の一点**として扱われます。`<=` に指定しても同日の 0:00 より後のレコードは
> 含まれず、`>= '2026-07-14' AND <= '2026-07-14'` は 0 件になります。
>
> **上端を「翌日」にして `<` で閉じる半開区間で書いてください。**
>
> ```sql
> WHERE 作成日時 >= '2026-07-14' AND 作成日時 < '2026-07-15'   -- 7/14 の全体
> ```
>
> この形は kintone が両端を同じ規則で解決するため、**kintone 側のタイムゾーン設定を
> 意識せずに正しい 1 日**になります。`2026-07-14T23:59:59Z` のような RFC3339 文字列も
> 指定できますが、末尾のオフセット（`Z` など）と kintone 側の解決が食い違うと境界が
> ずれるため、日付単位で区切る場合は半開区間を推奨します。

### 相対日付関数

`YESTERDAY()`、`FROM_TODAY(...)`、週・月・年の相対日付関数は、4つの日付系フィールド型に対する比較右辺と `BETWEEN` 境界で使用できます。これらは server-only で、相対日付関数そのものを client 評価へ切り替えることはありません。単一 APP では、**その SELECT の `WHERE` 全体を exact pushdown できる形**（`OR` を含んでいても全体が押し下げ可能なら可。`GROUP BY` / `SELECT DISTINCT` / 集計 / ウィンドウ関数 / 通常の `ORDER BY`、実体化 CTE 本体、`WITH` の最終 SELECT、一時テーブル source、単一 CTE のインライン展開でも可）と、**相対日付 leaf が「相対日付を含まない残余」と AND で結ばれたトップレベルの単一物理アプリ SELECT**（相対日付 leaf だけを prefilter に載せ残余を client 評価・v3.21.0）で使えます。INNER JOIN では、全 source が alias 付き物理 APP のとき、**単一 alias の whole-WHERE exact（第5-W）**または**AND スパイン上の exact 関数 leaf を alias ごとに採用する形（第5-L）**で使えます。複数 alias へ分散した関数 leaf も各 APP へ押し下げ、関数を含まない残余だけを client 評価します。`LEFT` / `RIGHT JOIN`、cross-alias `OR`、関数を含む cross-table 述語、whole-WHERE exact でない KLIKE-containing `OR`、JOIN 入力がサブテーブル・入れ子 SELECT・派生表・CTE・一時テーブルの形は fail-closed です。単一 APP の prefilter＋残余は CTE 本体・`WITH` の最終 SELECT・一時テーブル source では使えません。`VALIDATE`、および**実体化 CTE 本体 / `WITH` 最終クエリ / 一時テーブル source が `UNION` の場合**も fail-closed です（トップレベルの `UNION` は枝ごとに判定します）。**`KORDER BY` と DML（`UPDATE` / `DELETE` の対象選択、`INSERT` / `UPSERT ... SELECT` の source）は whole-WHERE exact の形だけが使え、prefilter＋client 残余や FULL_SCAN_EXACT では使えません。** 関数一覧、引数、型・演算子、reason code、残る非対称、soft keyword とバッククォート退避は [§5「kintone クエリ関数」](#kintone-クエリ関数server-only) を参照してください。

### 型付き比較（v3.0.0）

比較方法は値の見た目ではなく、フォーム定義または一時テーブルへ伝播した列型で決まります。

- 文字列型と型不明列は Unicode コードポイント順で比較します。`'20' > '100'` は真です
- NUMBER と数値形式 CALC は最大30桁の有限10進を文字列のまま厳密比較します。空セル、無限大、検証失敗値を含む一時テーブル列にも決定的な固定順があります。空白のみは数値0ではなく「その他非数値」です
- DATE / TIME / DATETIME はkintoneの正規化済み表現を文字列として比較します
- DROP_DOWN / RADIO_BUTTON / STATUS等は、取得できた定義順を使用します
- 文字列（1行）等でkintone RESTが受理しない`<` / `>`は、SELECTでは自動的にローカル評価へ切り替えます。DMLは対象集合を暗黙に広げず、実行前にエラーにします

v2までは数字だけの文字列を値ベースで数値比較する経路がありました。v3ではこのペア単位の自動切替を廃止したため、WHEREの結果行、集計値、DML候補が変わる場合があります。詳細は[v3.0.0 移行ガイド](ksql_v3_migration_guide.md)を参照してください。

### WHERE の REST 押し下げ

ここでいう「押し下げ」は、`WHERE` の条件を kintone records API の query に含め、取得候補を
サーバー側で減らす最適化です。結果の意味は変わりません。候補を広めに取得する
`superset` を含め、押し下げ後も元の `WHERE` を client で再評価するためです。
内部区分は `EXPLAIN` の `relation: exact` / `relation: superset` で確認できます。

押し下げには複数の機構があります。次の表が説明するのは、**alias 付き物理 APP だけを
入力にする INNER JOIN で、1つのフィールドを1つのリテラル（`IN` / `NOT IN` は
リテラルリスト）と比較する単一の条件**だけです。単一表、server-only 関数、`KLIKE` は
別の規則です。

- **単一表:** `WHERE` 全体を kintone query へ exact に直列化できれば、フィールド型を問わず
  押し下げます。FULL_SCAN でも安全な条件だけを prefilter に使える形があります。
- **JOIN・field vs literal:** 次表の「押し下がる」条件だけを APP ごとの prefilter に使います。
  表にないフィールド型は押し下がりません。

選択系の `IN` / `NOT IN` は、空でない実在選択肢だけのリストを指定し、型情報と選択肢情報を
取得できた場合に押し下がります。表はこの条件を満たすリテラルでの判定です。

**○ = 押し下がる／✕ = 押し下がらない**（✕ の条件は prefilter に使わず、取得後に JS で判定します）。

<!-- B84_JOIN_FIELD_LITERAL_TABLE_START -->
| フィールド型 | `=` | `!=` | `<` | `>` | `<=` | `>=` | `in` | `not in` |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `CALC` | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ |
| `CATEGORY` | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ |
| `CHECK_BOX` | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ○ | ○ |
| `CREATED_TIME` | ○ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ |
| `CREATOR` | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ |
| `DATE` | ○ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ |
| `DATETIME` | ○ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ |
| `DROP_DOWN` | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ○ | ○ |
| `FILE` | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ |
| `GROUP_SELECT` | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ |
| `LINK` | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ |
| `MODIFIER` | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ |
| `MULTI_LINE_TEXT` | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ |
| `MULTI_SELECT` | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ○ | ○ |
| `NUMBER` | ○ | ✕ | ○ | ○ | ✕ | ✕ | ✕ | ✕ |
| `ORGANIZATION_SELECT` | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ |
| `RADIO_BUTTON` | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ○ | ○ |
| `RECORD_NUMBER` | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ |
| `RICH_TEXT` | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ |
| `SINGLE_LINE_TEXT` | ○ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ |
| `STATUS` | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ○ | ○ |
| `STATUS_ASSIGNEE` | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ |
| `TIME` | ○ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ |
| `UPDATED_TIME` | ○ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ |
| `USER_SELECT` | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ |
<!-- B84_JOIN_FIELD_LITERAL_TABLE_END -->

`$id` は上表の `RECORD_NUMBER` とは別です。`$id` はフィールド型ではなく、正準なレコード ID
であると証明できる擬似フィールド名なので、正の安全整数リテラルに対する `=` / `<` / `>` /
`<=` / `>=` を JOIN でも押し下げます。JOIN 中の `RECORD_NUMBER` フィールドは別アプリ由来かも
しれず、同じ保証がないため押し下げません。

フィールドを `DATE_FORMAT(field, ...)` などの関数で包む条件は kintone query として表現できず、
押し下がりません。server-only の kintone クエリ関数は
[専用節](#kintone-クエリ関数server-only)、`KLIKE` / `NOT KLIKE` は
[専用節](#klike--not-klikekintoneキーワード検索)の規則に従います。

選択系の `=` / `!=` は kintone query が `in` / `not in` しか受け付けませんが、
**単一値の選択系（`RADIO_BUTTON` / `DROP_DOWN` / `STATUS` など）では、エンジンが自動で
`IN` / `NOT IN` へ正規化して押し下げます**（`EXPLAIN` に `pushdown normalized:` 行が出ます。
書き換えは不要です）。**正規化の対象外**＝複数値フィールド（チェックボックス・複数選択・
ユーザー選択など。`IN` にすると「いずれかを含む」判定になり意味が変わるため）・
**定義に無い選択肢値・空文字（`= ''`）**。これらは従来どおり押し下がりません。
なお **JOIN の field-vs-literal prefilter（上表）は別経路で、この正規化は掛かりません**。

#### 押し下がる形への書き換え

**結果は同じでも、書き方で取得件数が変わります。**下表は同じ意味のまま押し下がる形へ
書き換える例です（`fetch:` は `EXPLAIN` の表示。→ [§24 出力の読み方](#出力の読み方)）。

| 全件取得になる書き方 | なぜ | 押し下がる書き方 |
|---|---|---|
| `確度 = ''`（選択系の空セル判定） | 空文字は `IN` への自動正規化（単一値選択系の `=` / `!=`）の対象外 | **`確度 IN ('')`** |
| `YEAR(受注予定日) = 2026` | フィールドを関数で包むと変換できない | **`受注予定日 = THIS_YEAR()`** |
| `受注予定日 >= CURRENT_DATE()` | kSQL のスカラー関数で、押し下げ経路が無い | **相対日付関数**（`TODAY()` / `FROM_TODAY(n, unit)`） |
| `案件名 LIKE '%商事%'` | `LIKE` は**前方一致でも**常に JS 評価 | **`案件名 KLIKE '商事'`**（一致規則は kintone 準拠で別物）、または押し下がる条件を `AND` で足して prefilter を効かせる |
| `確度 IS NULL` | `IS NULL` は押し下がらない | 選択系の未選択は **`確度 IN ('')`** |
| JOIN 内の `売上 >= 5000000` | 非厳密比較は JOIN で押し下げない（IEEE-754 の境界） | **`売上 > 4999999`**（整数フィールドなら同義。ただし下記の注意） |

**上表はいずれも実測です**（`EXPLAIN` の `fetch:` が `ALL` → `EXACT` へ変わることを確認）。

> **JOIN の書き換えだけは効果が限定的です。**`売上 > 4999999` にすると**主表は `PREFILTERED`**
> になりますが（`pushdown applied` / `relation: superset`）、**結合先は `ALL` のまま**です。
> JOIN の押し下げは結合キーによる絞り込みが中心で、外部結合では行われません。

> **`CURRENT_DATE()` / `CURRENT_TIMESTAMP()` は実行環境のローカルタイムゾーンで評価されます。**
> kintone ドメインと時差がある環境では月初・月末の境界がずれ得るため、**期間の絞り込みには
> 相対日付関数を優先**してください（サーバー側で評価されます）。列の値として今日を出す用途
> （`SELECT CURRENT_DATE() AS 今日`）は従来どおりです。

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
- FULL_SCANでの制約: 通常は OR または`NOT (...)`配下、サブテーブル、CTE／一時テーブル上のKLIKEは使用できません。例外として、alias 付き物理 APP だけの INNER JOIN で server-only 関数を含み、単一 alias の `WHERE` 全体を exact に押し下げる第5-Wでは、OR / NOT 配下を含む全 KLIKE occurrence を同じ server query に適用して client residual を無くせるため使用できます。whole-WHERE exact でない KLIKE-containing OR は拒否します。それ以外の JOIN との併用は、すべての JOIN が `INNER JOIN` で、KLIKE のフィールドをテーブルエイリアスで明示した場合だけ許可します。`LEFT JOIN` / `RIGHT JOIN`を含むSELECTでは、安全側にKLIKEを拒否します。直接の`NOT KLIKE`はANDリーフとして使用できます。
- 右辺は単一引用符の文字列または文字列バッチ変数に限定されます。`%` は使用できません。`_` は使用できますが、1文字ワイルドカードではなくkintone検索上の単語構成文字です。
- DML では次の親レコード DML の WHERE で使用できます（v3.10.0）: **通常（APPLY なし）の親 `UPDATE` / `DELETE`**、および **APPLY 複数親 `UPDATE` の親 WHERE**。前者は WHERE 全体を kintone クエリへ exact 変換して対象を解決するため `OR` / `NOT` 配下の KLIKE も使用できます。後者は安全プレフィルタ＋残余評価のため、`OR` / `NOT` 配下など native query に完全適用できない KLIKE は使用できません。**サブテーブル `UPDATE` / `DELETE`・`REORDER`・`INSERT` / `INSERT ... SELECT`・`UPSERT` / `UPSERT ... SELECT`・独立した `VALIDATE` では引き続き使用できません**（JS 評価経路のため）。SQL `LIKE` / `NOT LIKE` は通常 DML では引き続き使用できません（JS 評価が必要）。
- 利用可能なフィールドは[kintone公式の演算子対応表](https://cybozu.dev/ja/kintone/docs/overview/query/)に従います。文字列1行・複数行、リッチエディター、リンク、添付ファイルなどが対象です。非対応フィールドはkintone APIエラーになります。
- kintoneはキーワード一致が10万件に達すると検索を打ち切ります。**CLI / MCP / プラグインすべてで打ち切りを検出します**（プラグインは v3.10.0 で raw fetch によりレスポンスヘッダー `X-Cybozu-Warning` を読み取ります）。検索打ち切り後の挙動は、利用面とクエリの形で異なります。

  | 利用面 | `LEFT` / `RIGHT JOIN` を含むクエリ | `INNER JOIN` / 単一表 |
  |---|---|---|
  | プラグイン / CLI / MCP | `SearchAbortedError`（B79 から） | 警告＋部分結果 |
  | engine ライブラリ | `SEARCH_ABORTED` hard error（従来どおり） | `SEARCH_ABORTED` hard error（従来どおり） |

  外部結合では、結合相手を取得できなかっただけの行が null 拡張され、**「該当なし」という誤った値**になり得ます。単なる行の欠落ではなく、返った行の値自体が誤るため、プラグイン / CLI / MCP でも B79 から fail-closed に変更しました。従来成功して見えた該当クエリは実際には誤った値を返していたため、エラー化によって正しい結果が失われることはありません。`WHERE` で対象を絞るか、意味を保てる場合は `INNER JOIN` へ置き換えてください。

  engine ライブラリは B79 の変更対象ではなく、従来からクエリ形を問わず常に hard error です。プログラム API では部分結果が黙ってアプリケーションロジックへ流れ込むほうが危険なため、意図的に厳格な契約としています。読み取り結果を書き込みや一時テーブル実体化に使う場合、および KLIKE を含む親 DML の対象解決でも、不完全な対象集合で実行しないよう従来どおり `SearchAbortedError` でエラー終了し、書き込み0件で fail-closed とします。
- engine ライブラリの静的検証で `KLIKE` / `NOT KLIKE` の使用位置や検索語が不正な場合、エラー `code` は従来どおり `PARSE_ERROR` のまま、`message` に具体的な reason（例: `KLIKE / NOT KLIKE は SELECT の WHERE 句でのみ使用できます`）を返します。B80 より、従来の一律な `SQL statement could not be parsed` ではなく、プラグイン / CLI / MCP と同じ reason で原因を特定できます。`code` で分岐している利用者コードへの影響はありません。
- `KLIKE` は予約語です。同名フィールドを参照するときは `` `KLIKE` `` と記述します。

### IN / NOT IN（値リストによる一致・除外）

`IN` は列挙した値の**いずれかに一致**する行、`NOT IN` は**いずれにも一致しない**行を選びます。

```sql
WHERE ステータス IN ('進行中', '完了', 'レビュー中')
WHERE 区分 IN (1, 2, 3)
WHERE ステータス NOT IN ('キャンセル', '却下')
```

**IN リストの値（構文）**

- 単一引用符の文字列 `'...'`・数値・バッチ変数 `@名前` を指定でき、**1 要素以上が必須**です。文字列はダブルクォートでなく単一引用符です（`IN ("A")` は構文エラー）。
- 例外として、`CREATOR` / `MODIFIER` / `USER_SELECT` では singleton の
  `LOGINUSER()`、`ORGANIZATION_SELECT` では singleton の `PRIMARY_ORGANIZATION()` を
  `in` / `not in` に使用できます。文字列・数値との混在 list、複数個の関数、
  `TODAY()` / `NOW()` / 相対日付関数は IN list に指定できません。
- 負数リテラルも指定できます（`IN (-1, -2)`）。
- **`IN ()`（0 要素）は書けません**（ParseError）。「空／未選択」を探すのは `IN ('')` です（後述）。
- サブクエリを渡す `IN (SELECT ...)` は別項です（後述）。

**一致の意味論はフィールド型で異なります**

- **単一値フィールド**（テキスト・数値・ドロップダウン・ラジオ・日付・ステータス等）＝**スカラー等値**（`列 = 値1 OR 列 = 値2 …`）。**標準SQLと同じ**です。
- **複数値フィールド**（チェックボックス・複数選択）＝**選択集合が列挙値の少なくとも 1 つを含む**（集合の overlap）。標準SQL のスカラー `IN` とは異なります（後述の「標準SQLとの違い」）。
- ユーザー・組織・グループ選択・作業者も複数値なので、`code` の集合 overlap（いずれかを含む）で判定します。作成者・更新者は単一値で `code` のスカラー等値です（いずれも表示名ではなく `code` で比較）。
- 型情報を取得できない値、型と値の形が一致しない場合は文字列比較を維持します。
- 選択系の空／未設定セルは `IN ('')` に一致し、`NOT IN ('')` で除外されます（空スカラー値の投影も空文字で返します）。

この規則はリテラル／バッチ変数の IN リスト・`IN (SELECT ...)`・サブテーブルの JavaScript 評価すべてに適用されます。**実在する値に対する一致結果は、REST 押し下げでも JS 評価でも同じ**です（定義外の選択肢値だけは、押し下げ経路で実行エラーになり得ます・下記）。

```sql
-- 空／未設定の選択セルを抽出（ドロップダウンは = '' が使えないため IN ('') を使う）
WHERE ドロップダウン IN ('')            -- 未選択のレコード
WHERE ドロップダウン NOT IN ('')        -- 選択済みのレコード
WHERE ドロップダウン IN ('', '対応中')  -- 未選択 または「対応中」
```

> **標準SQLとの違い（複数値フィールドの `IN`）**  
> 標準SQLの `x IN ('A','B')` は `x = 'A' OR x = 'B'` というスカラー等値で、**`x` を 1 つの値**として `'A'`・`'B'` と突き合わせます（要素ごとには照合しません）。標準SQLは 1 フィールド＝スカラーが前提で多値列を持たず、多値は別行に正規化して `EXISTS` などで表すためです。  
> 一方 kintone のチェックボックス・複数選択は 1 フィールドが複数値なので、kSQL は kintone ネイティブの `in` に合わせ、**集合を要素に開いて「列挙値の少なくとも 1 つを含むか」**（集合の overlap）で判定します。これにより `['A']` も `['A','B']` も `IN ('A','B')` に**一致します**。標準SQLで同義を書くなら中間テーブルの `EXISTS`（セミ結合）や配列 overlap（`checkbox && ARRAY[...]`）に相当します。実在する値に対する一致結果は REST 押し下げでも JS 評価でも同じです（単一選択・テキスト・数値は従来どおりスカラー等値で、標準SQLと同じ）。

`チェックボックス`（選択肢 A/B/C）に対する判定例:

| フィールド値 | `IN ('A','B')` | `IN ('')` | `NOT IN ('')` |
|---|:---:|:---:|:---:|
| `[]`（未選択） | ✗ | ✓ | ✗ |
| `['A']` | ✓ | ✗ | ✓ |
| `['C']` | ✗ | ✗ | ✓ |
| `['A','C']` | ✓ | ✗ | ✓ |
| `['A','B','C']` | ✓ | ✗ | ✓ |

- **`IN ('列挙値', ...)`**：列挙値のいずれかを**含む**行に一致します。`['A','C']` はリスト外の `C` を含んでいても `A` があれば一致で、部分集合や完全一致ではありません。
- **`IN ('')`（空文字 1 要素）＝未選択（空）の行だけに一致**します。`= ''` が使えない選択系（ドロップダウン等）の「空」判定にも使います。空文字を含める `IN ('', 'A')` は「未選択 または A を含む」です。
- **`NOT IN ('')`＝選択が 1 つ以上ある行**（`[]` 以外）に一致＝`IN ('')` の補集合です。
- **`NOT IN ('A','B')`＝A も B も含まない行**に一致します（上表なら `[]` と `['C']`）。

FULL_SCAN の `WHERE` では、フィールド型と選択肢の実在を確認できた
`DROP_DOWN`／`RADIO_BUTTON`／`CHECK_BOX`／`MULTI_SELECT` の `IN`／`NOT IN`
（空でない文字列リテラルのみ）を kintone の事前絞り込みにも使用します。結果は取得後に同じ型付き規則で再評価します。
存在しない選択肢、空文字、型情報・選択肢情報を取得できない場合は押し下げず、JavaScript 評価だけを行います。
ユーザー・組織・グループ選択はこの最適化の対象外です。プロセス管理が有効で、実行ユーザーの表示言語における状態名の実在を確認できたステータスの `IN`／`NOT IN` も事前絞り込みに使用します。プロセス管理が無効、状態名が非実在、または空文字の場合は押し下げません。

> **選択系フィールドの `=` と取得件数:** ドロップダウン／ラジオボタン／
> チェックボックス／複数選択に対する `=` は、kintone のクエリ文法が
> `in` / `not in` のみを受け付けるため、records API へ押し下げません。
> 結果は取得後の評価で正しくなりますが、取得候補が大きく増える場合があります。
> 同じ条件を表せるときは `IN (...)` を使用してください。

> **選択系フィールドに「定義に無い選択肢値」を渡したときの注意（重要）**  
> `DROP_DOWN`／`RADIO_BUTTON`／`CHECK_BOX`／`MULTI_SELECT`／ステータスに、そのフィールドの選択肢として**定義されていない値**を `IN`／`NOT IN` へ渡すと、その `IN` が **kintone REST へ押し下げられるか否か**で挙動が分かれます（実行モードが SIMPLE か FULL_SCAN かではありません）。
> - **`WHERE` 全体が REST に完全押し下げされる場合**（純粋な SIMPLE のほか、`DISTINCT`／`GROUP BY`／`ORDER BY` などで実行モードが FULL_SCAN になっても、`WHERE` 自体は押し下げ可能なとき）: 定義外値が kintone に渡り、`GAIA_IQ10`（項目に「値」は存在しません）で**実行エラー**になります。
> - **`WHERE` に JavaScript 評価が必須な部分がある場合**（関数・算術式・`LIKE`・`IN (SELECT ...)` などの残余があり、安全リーフだけを事前絞り込みする経路）や、**`CASE WHEN` などの条件**（→ §4）: 定義外値・空文字を含む選択系 `IN` は押し下げず JS で評価するため、**エラーにならず単に一致 0 件**（`NOT IN` は全一致）になります。
>
> テキスト・数値フィールドは定義選択肢の概念が無いため、未一致でも常に 0 件（エラーなし）です。**バッチ変数**は置換後に通常の `IN` リストになるため、上の「完全押し下げ」経路では定義外値が混じると `GAIA_IQ10` になり得ます（事前に有効値へ絞ってください）。一方 **`IN (SELECT ...)` は常に JavaScript 評価**（REST へ渡さない）なので、この経路では `GAIA_IQ10` にはなりません。

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
- GROUP BY なしの集計サブクエリ（`AVG(...)` 等）は対象 0 件でも 1 行を返すためエラーになりません。**戻り値は関数ごとに違います**（→ [§8「0 件時の挙動」](#0-件時の挙動)）
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

> **評価経路（Breaking）**<br>
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

kintone の [クエリ関数](https://cybozu.dev/ja/kintone/docs/overview/query/#function) に対応する関数です。値・比較は kintone サーバーが決定します（server-only）。

**基本の3関数**:

| 関数 | 意味 |
|------|------|
| `TODAY()` | 今日の日付（`YYYY-MM-DD` 形式） |
| `NOW()`   | 現在日時（ISO 8601 形式） |
| `LOGINUSER()` | ログイン中のユーザー（`WHERE` では kintone server が解決） |
| `PRIMARY_ORGANIZATION()` | ログイン中のユーザーの優先組織（`WHERE` では kintone server が解決） |

```sql
WHERE 作成日時 >= TODAY()
WHERE 期限日 < TODAY()
WHERE 作成者 in (LOGINUSER())
WHERE 担当者 not in (LOGINUSER())
WHERE 担当組織 in (PRIMARY_ORGANIZATION())
```

`WHERE` では16関数すべてが server-only です。`TODAY()` は日付系4型、
`NOW()` は `DATETIME` / 作成日時 / 更新日時（**`DATE` には不可**）の比較右辺・
`BETWEEN` 境界に使用できます。`LOGINUSER()` は作成者 / 更新者 / ユーザー選択の
singleton `in` / `not in` だけに使用でき、**グループ選択には使用できません**。
`PRIMARY_ORGANIZATION()` は組織選択の singleton `in` / `not in` だけに使用できます。

`WHERE` 以外で構文上許可される既存経路の `TODAY()` / `NOW()` は、従来どおり
実行環境のローカル TZ で評価されます。内部のローカル評価器で `LOGINUSER()` /
`PRIMARY_ORGANIZATION()` を解決した場合は、プラグインを含む**全実行面で空文字**です
（`SET` / `DECLARE` の右辺では両関数を構文上拒否します）。現在の日付・日時を意図的に client のローカル TZ で評価する場合は、
kSQL スカラー関数の `CURRENT_DATE()` / `CURRENT_TIMESTAMP()` を使用してください。
これらには押し下げ経路がなく、本項の fail-closed 対象外です。

**相対日付関数（12関数・`WHERE` 専用）**: `YESTERDAY()` / `TOMORROW()` / `FROM_TODAY(n, unit)` / `THIS_WEEK([曜日])` / `LAST_WEEK([曜日])` / `NEXT_WEEK([曜日])` / `THIS_MONTH([日])` / `LAST_MONTH([日])` / `NEXT_MONTH([日])` / `THIS_YEAR()` / `LAST_YEAR()` / `NEXT_YEAR()`。

16関数共通で、単一 APP では **その SELECT の `WHERE` 全体を押し下げられる形**（`OR` 併用も全体が押し下げ可能なら可。`GROUP BY` / `DISTINCT` / 集計 / ウィンドウ関数 / 通常の `ORDER BY`、実体化 CTE 本体、`WITH` の最終 SELECT、一時テーブル source、単一 CTE のインライン展開でも可）と、**関数を含まない残余（例 `LENGTH(...) > 1`）と `AND` で結ばれたトップレベルの単一物理アプリ SELECT**（関数 leaf を prefilter に押し下げ残余だけ client 評価・`SUPERSET_PREFILTER`）で使えます。INNER JOIN では alias 付き物理 APP だけを入力とし、単一 alias の whole-WHERE exact（第5-W）、または AND スパイン上の exact 関数 leaf を alias ごとに押し下げて関数なし残余だけを client 評価する形（第5-L）で使えます。後者は複数 alias へ分散した関数にも対応します。`LEFT` / `RIGHT JOIN`、cross-alias `OR`、関数を含む cross-table 述語、whole-WHERE exact でない KLIKE-containing `OR`、JOIN 入力が CTE・一時テーブル・サブテーブル・入れ子 SELECT・派生表の形はレコード取得前に fail-closed します。単一 APP の prefilter＋残余は CTE 本体・`WITH` の最終 SELECT・一時テーブル source では使えません。`VALIDATE`、および**実体化 CTE 本体 / `WITH` 最終クエリ / 一時テーブル source が `UNION` の場合**も fail-closed します（トップレベルの `UNION` は枝ごとに判定します）。**`KORDER BY` と DML は whole-WHERE exact の形だけが使え、prefilter＋残余や FULL_SCAN_EXACT では使えません。`PRIMARY_ORGANIZATION()` を含む DML は常に拒否します。** 型・演算子・reason code・移行方法は [§5「kintone クエリ関数」](#kintone-クエリ関数server-only) を参照してください。

```sql
WHERE 作成日時 < FROM_TODAY(5, DAYS)
WHERE 日付 BETWEEN FROM_TODAY(-7, DAYS) AND TODAY()
WHERE 更新日時 >= YESTERDAY() AND LENGTH(都道府県) > 1   -- prefilter＋残余（v3.21.0）
WHERE 日付 = TODAY() AND LENGTH(件名) > 1                 -- TODAY() も同じ prefilter
```

> `PRIMARY_ORGANIZATION()` は組織選択の singleton `in` / `not in` だけに使用できます。
> **優先組織が未設定のユーザーでは条件が無視され、全レコードが返ります**
> （kintone 公式の記述。2026-07-31 に実機で再現を確認）。
> **この関数を含む DML は常に拒否**しますが、**`SELECT` はそのまま返します**——
> **絞り込みが効いていないことを、エンジンからも画面からも判別できません**（§5 参照）。

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

> **注意:** JOIN は FULL_SCAN モードで client 側の結合を行います。通常は元の `WHERE` を
> client 側でも再評価しますが、第5-W は whole WHERE を server で exact に適用して
> client residual を持たず、第5-L は server-only 関数 leaf を除いた残余だけを再評価します。
> ただし、INNER JOIN で、型と演算子が対応する単一 alias の述語は、各 APP の records API
> query へ prefilter として押し下げます。押し下げは取得件数を減らす性能最適化であり、
> 通常述語は元の `WHERE` を client で再評価するため結果は変わりません。
>
> server-only 関数は、alias 付き物理 APP だけの INNER JOIN で次の2形を使用できます。
> **第5-W**は `WHERE` 全体が単一 alias に属する exact 形で、同一 alias の `OR` / `NOT` /
> whole-exact な KLIKE 共存も可です。**第5-L**は AND スパインの exact 関数 leaf を
> alias ごとに押し下げ、関数を含まない残余だけを client 評価します。複数 alias に
> 関数が分散していても各 APP へ押し下げます。`LOGINUSER()` は作成者 / 更新者 /
> ユーザー選択、`PRIMARY_ORGANIZATION()` は組織選択の singleton `in` / `not in` に限ります。
>
> server-only 関数を使用できない JOIN は、LEFT / RIGHT JOIN、cross-alias `OR`、
> 関数を含む cross-table 述語、whole exact でない KLIKE-containing `OR`、および
> サブテーブル・入れ子 SELECT・派生表・CTE・一時テーブルを入力にする形です。
> 通常述語の APP 別 prefilter については、型不明・非実在の選択肢・選択系フィールド等を
> 引き続き押し下げません。
>
> `EXPLAIN` では、実行時メタデータで確定した `pushdown applied`、静的な
> `pushdown candidate`、および集合関係 `relation: exact` / `relation: superset`
> を確認できます。拒否形でも throw せず `plan status: rejected` と reason、
> `client evaluation: forbidden`、実行 API なしを表示します。

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

#### GROUP BY にエイリアスを指定する

`GROUP BY` には、**フィールド・式のほか、SELECT 句で付けたエイリアス**も指定できます。

```sql
SELECT DATE_FORMAT(作成日時, '%Y-%m') AS 年月, COUNT(*) AS 件数
FROM APP100
GROUP BY 年月                              -- 式に付けたエイリアスで集計できる
```

上は `GROUP BY DATE_FORMAT(作成日時, '%Y-%m')` と**同じ結果**になります。エイリアスの元が文字列・日付関数、算術式、`CASE`、リテラル、フィールド参照、スカラーサブクエリのいずれでも解決されます。

**名前の解決順**は次のとおりです。

1. **同名のフィールドがあればそれを使います**（物理フィールド、`$id` / `レコード番号` などのシステム列、サブテーブルの `_pid` / `_rid` / `_idx` / `_p.<親フィールド>`、CTE・一時テーブルの列）。SELECT で同名のエイリアスを付けていても、フィールドが優先されます。
2. 同名のフィールドが無いときだけ、SELECT のエイリアスとして解決します。

`ORDER BY` はエイリアスを優先しますが、`GROUP BY` は**フィールドを優先**します。`GROUP BY` はグループ化前の行に対する操作で、`ORDER BY` は出力行に対する操作だからです（標準 SQL / MySQL と同じ）。

次はレコード取得前にエラーになります。

- **集計関数のエイリアス**（`SELECT COUNT(*) AS 件数 … GROUP BY 件数`）。グループ化前に値が確定しないためです。集計を含む `CASE` / 文字列関数 / 連結式のエイリアス、エイリアスを付けていない集計列の合成名（`` GROUP BY `SUM(金額)` ``）も同様です。
- 同名のエイリアスが複数あり、`GROUP BY` がそれをエイリアスとして解決しようとした場合（同名のフィールドがあればフィールド優先で正常に動きます）。
- JOIN で複数のテーブルに同名フィールドがある非修飾名。テーブル別名で修飾してください。
- `GROUPING()` 列やウィンドウ関数のエイリアス。
- **集計もグループ化もされていない列参照**（`SELECT 製品名, 個数, SUM(個数) … GROUP BY 製品名` の `個数`）。→ [集計されていない列は書けません](#集計されていない列は書けません)（v3.57.0〜）

> `GROUP BY ROLLUP(...)` / `GROUP BY GROUPING SETS (...)`（[小計・総計](#小計総計rollup--cube--grouping-sets--grouping)）の grouping item は**物理フィールドのみ**で、エイリアスは指定できません（従来どおり）。

### SELECT 内では同じ SELECT の別名を参照しません

**SELECT 式のフィールド参照は、その query block の入力列を参照します。** 同じ SELECT 句にある別の列の alias は参照しません。列を左から右へ書いた順序でも意味は変わりません。

```sql
SELECT 個数 * 2 AS 倍,
       SUM(個数) AS 個数
FROM APP100
GROUP BY 製品名, 個数
```

`倍` の `個数` は入力フィールドです。集計結果の alias `個数` ではありません。ウィンドウ関数の alias も同じ SELECT の別式からは見えません。

```sql
SELECT 個数 * 2 AS 倍,
       ROW_NUMBER() OVER (ORDER BY $id) AS 個数
FROM APP100
```

集計・ウィンドウの alias が入力フィールドと同名でもエラーや警告にはなりません。`HAVING` とトップレベルの通常 `ORDER BY` は別の句なので、従来どおり SELECT alias を参照できます。CTE・一時テーブル・サブクエリを実体化した後は、その公開出力列が下流 query block の通常の入力列になります。

### 集計されていない列は書けません

**（実測・v3.57.0）**

**集計を含むクエリでは、`SELECT` / `HAVING` / `ORDER BY` に書ける列参照は次のいずれかだけです。**

1. **`GROUP BY` に書いた列そのもの**
2. **`GROUP BY` に書いた列（または式）だけから計算した式**
3. **集計関数の引数の中**

**どれにも当てはまらない列は、レコードを取得する前にエラーになります。**

```sql
SELECT 製品名, 個数, SUM(個数) AS 合計 FROM APP100 GROUP BY 製品名   -- エラー（個数）
SELECT 製品名, 個数, SUM(個数) AS 合計 FROM APP100                   -- エラー（GROUP BY が無くても同じ）
SELECT 製品名, SUM(個数) AS 合計 FROM APP100 GROUP BY 製品名 HAVING 個数 > 0  -- エラー
```

**`GROUP BY` が無くても集計関数があれば同じ規則が効きます**（入力全体が 1 グループになるため）。

**通る形**

```sql
SELECT 製品名, SUM(個数) AS 合計 FROM APP100 GROUP BY 製品名
SELECT DATE_FORMAT(日付,'%Y-%m') AS 年月, SUM(個数) FROM APP100 GROUP BY 年月
SELECT 個数 + 1 AS 加算, SUM(個数) FROM APP100 GROUP BY 個数          -- キーだけから計算した式
SELECT YEAR(日付) + 1 AS 翌年, SUM(個数) FROM APP100 GROUP BY YEAR(日付)
SELECT 製品名, 個数 FROM APP100                                       -- 集計もグループ化も無い素の SELECT
SELECT SUM(個数) OVER () AS 総計 FROM APP100                          -- ウィンドウだけ
```

**移行**

| したいこと | 書き方 |
|---|---|
| グループごとに 1 つに決まる値を出す | **`MIN(<列>)`** / `MAX(<列>)` |
| その列でも行を分ける | **`GROUP BY` に足す** |

**`ANY_VALUE()` はありません。** `MIN()` / `MAX()` が同じ役割を果たします。

> **v3.57.0 より前は、これらは黙って「グループの先頭レコードの値」を返していました。**
> **`SELECT 製品名, 個数, SUM(個数) … GROUP BY 製品名` の `個数` は、
> そのグループの 220 件のうち 1 件の値**でした。エラーも警告も出ませんでした。

> **`ksql_validate` は構文と静的検査だけ**を行い、kintone のフォーム定義を読みません。
> **同名の物理フィールドと SELECT エイリアスのどちらへ `GROUP BY` が解決されるかは、
> フォーム定義が要る**ため、`ksql_validate` が成功しても実行時にこのエラーになることがあります。
> **`ksql_explain` と実行は最終判断をします。**

> **`ROLLUP` / `CUBE` / `GROUPING SETS` では以前からエラー**になっていました。
> v3.57.0 で ordinary `GROUP BY` と `GROUP BY` 無し集計にも同じ規則が効きます。

### 集計関数

| 関数 | 意味 | NULL/空の扱い |
|------|------|---------------|
| `COUNT(*)` | 全行数 | NULL を含む全行を数える |
| `COUNT(フィールド)` | 空でない行数 | 空文字・NULL はスキップ |
| `SUM(フィールド)` | 合計 | 空文字・NULL はスキップ |
| `AVG(フィールド)` | 平均 | 空文字・NULL はスキップ |
| `MAX(フィールド)` | 最大値 | NULL はスキップ。選択された空セルは canonical empty band の候補 |
| `MIN(フィールド)` | 最小値 | NULL はスキップ。選択された空セルは canonical empty band の候補 |
| `GROUP_CONCAT([DISTINCT] 引数 [SEPARATOR '区切り'])` | 文字列連結 | 空文字・NULL はスキップ |
| `VAR_POP([DISTINCT] 引数)` | 母集団分散 | 空文字・NULL はスキップ |
| `VAR_SAMP([DISTINCT] 引数)` | 標本分散 | 空文字・NULL はスキップ |
| `STDDEV_POP([DISTINCT] 引数)` | 母集団標準偏差 | 空文字・NULL はスキップ |
| `STDDEV_SAMP([DISTINCT] 引数)` | 標本標準偏差 | 空文字・NULL はスキップ |
| `MEDIAN([DISTINCT] 引数)` | 中央値 | 空文字・NULL はスキップ |
| `MODE(引数)` | 最頻値 | 空文字・NULL は候補から除外 |

> **`MAX`/`MIN`/`MODE` の比較規則**: 実アプリの NUMBER と数値形式 CALC は数値順、テキスト・選択・日時フィールドと文字列形式 CALC はコードポイント順、選択肢・STATUS は定義順で比較します。日時の時系列順と一致するのは kintone が返す正規化形式（DATE=`YYYY-MM-DD`、TIME=`HH:mm`、DATETIME/作成日時/更新日時=`...Z`）が前提です。確定できた型メタは一時テーブル/CTEにも伝播します。`CASE` 引数は全分岐が同じ型ならその型、型が混在するか不明なら文字列として比較します。`MODE` の算術式引数は数値順、型メタ不明の直接フィールド参照は安全側のコードポイント順です。

```sql
SELECT COUNT(*) AS 総件数, SUM(金額) AS 合計金額, AVG(金額) AS 平均金額
FROM APP100
WHERE ステータス = '完了'
```

### 集計関数の引数に式を指定（v3.16.0）

引数を取る全 12 集計関数に、従来のフィールド・算術式・関数呼び出しに加えて、`CASE` 式・`||` 連結・スカラー変数 `@var` を指定できます。関数ごとの空値・完全入力・`DISTINCT` 規約は変わりません。

```sql
-- 条件付き集計
SELECT
  部署,
  SUM(CASE WHEN ステータス = '受注' THEN 売上 ELSE 0 END) AS 受注売上,
  COUNT(CASE WHEN ステータス = '受注' THEN 1 END) AS 受注件数
FROM APP100
GROUP BY 部署

-- カテゴリを列へ展開する横持ちピボット
SELECT
  部署,
  SUM(CASE WHEN ステータス = '受注'   THEN 売上 ELSE 0 END) AS 受注,
  SUM(CASE WHEN ステータス = '提案中' THEN 売上 ELSE 0 END) AS 提案中
FROM APP100
GROUP BY 部署
```

> **集計する値が 1 つも無いときの戻り値は、関数ごとに違います。** `GROUP BY` の無い集計は対象が 0 行でも 1 行を返しますが、その値は `0` とは限りません（→ [§8「0 件時の挙動」](#0-件時の挙動)）。

- `CASE` の `ELSE` を省略した非一致行は集計から除外されます。したがって `COUNT(CASE WHEN 条件 THEN 1 END)` は一致件数です
- 条件に一致して選択された空セルと、明示した `ELSE ''` は、`MIN` / `MAX` では既存の canonical empty band の候補に残ります。`SUM` / `AVG` / `GROUP_CONCAT` / 統計集約 / `MODE` の空値規約は従来どおりです
- 比較・述語そのものを値にする `SUM(売上 > 0)` は使用できません。`SUM(CASE WHEN 売上 > 0 THEN 1 ELSE 0 END)` のように値を明示してください（ParseError でもこの形を案内します）
- サブクエリと集計の入れ子（`SUM(SUM(x))`）は引数に指定できません。`MODE(DISTINCT ...)` も引き続き使用できません
- `HAVING SUM(CASE WHEN ステータス = '受注' THEN 売上 ELSE 0 END) > 1000000` も同じ書き方で使用できます。既存の算術式引数の挙動は変わりません

### 集計結果の算術式

集計を含む算術式は**集計関数から始まり**、被演算子には集計関数・数値リテラル・`@変数`・
**ordinary `GROUP BY` に書いた表記と一致する列**を書けます。SELECT 列と `HAVING` の両方で使用できます。

```sql
SELECT 分類, SUM(売上) * 単価 FROM APP1 GROUP BY 分類, 単価   -- 可
SELECT 分類, SUM(売上) * 担当者 FROM APP1 GROUP BY 分類       -- 不可（GROUP BY に無い）
SELECT 分類, 単価 * SUM(売上) FROM APP1 GROUP BY 分類, 単価   -- 不可（集計関数始まりでない）
```

修飾名も表記を合わせる必要があります。たとえば `GROUP BY m.単価` に対して使えるのは
`SUM(t.数量) * m.単価` であり、非修飾の `SUM(t.数量) * 単価` は使用できません。
`GROUP BY` の式・関数・SELECT alias も、この位置のオペランドには使用できません。

`ROLLUP` / `CUBE` / `GROUPING SETS` では、集計算術式にフィールドを書けません
（小計・総計行で値が定まらないため）。

**`SUM(a) * 単価` と `SUM(a * 単価)` は同じ値になるとは限りません。** 小数では丸めの位置が違い、
非数値の列では前者が `NaN`、後者が `0` になります。

### 小計・総計（ROLLUP / CUBE / GROUPING SETS / GROUPING）

`GROUP BY ROLLUP(a[, b ...])`、`GROUP BY CUBE(a[, b ...])`、`GROUP BY GROUPING SETS ((...), (...), ())` は、明細に加えて小計・総計行を同じ結果へ出力します。1 クエリで必要な階層をまとめて集計できます。

```sql
-- 単一列 ROLLUP: 会社別明細と総計
SELECT 会社名, SUM(売上) AS 売上合計
FROM APP100
GROUP BY ROLLUP(会社名)

-- 複数列 ROLLUP: 地域×会社明細、地域小計、総計
SELECT 地域, 会社名, SUM(売上) AS 売上合計
FROM APP100
GROUP BY ROLLUP(地域, 会社名)

-- CUBE: 明細に加え、地域小計・会社小計・総計をすべて出力
SELECT 地域, 会社名, SUM(売上) AS 売上合計
FROM APP100
GROUP BY CUBE(地域, 会社名)

-- 必要な階層だけを明示
SELECT 地域, 会社名, SUM(売上) AS 売上合計
FROM APP100
GROUP BY GROUPING SETS ((地域, 会社名), (地域), ())
```

`ROLLUP(a, b)` は `(a, b)`、`(a)`、`()` の階層だけを作ります。`CUBE(a, b)` は加えて `(b)` も作り、`(a, b)`・`(a)`・`(b)`・`()` の全 `2^n` 組合せ（各軸の小計と総計）を出力します。両軸の小計を揃えたいときに使います。

`GROUPING(field)` は、その行で `field` が集約された super-aggregate 行なら `1`、グループキーとして残っていれば `0` を返します。小計・総計行の grouped 列は空文字になるため、実データの空セルとの判別にはフィールド値ではなく `GROUPING(field)` を使用します。通常の `ORDER BY GROUPING(会社名)` を昇順で指定すると、総計行を末尾へ寄せられます（§10 も参照）。

```sql
SELECT
  CASE WHEN GROUPING(会社名) = 1 THEN '合計' ELSE 会社名 END AS 会社名,
  GROUPING(会社名) AS grouping_company,
  COUNT(*) AS 案件数,
  SUM(売上) AS 売上合計,
  SUM(CASE WHEN 商談フェーズ = '受注' THEN 売上 ELSE 0 END) AS 受注済売上,
  SUM(CASE WHEN 商談フェーズ IN ('提案中','内示') THEN 売上 ELSE 0 END) AS 見込売上
FROM APP100
GROUP BY ROLLUP(会社名)
ORDER BY GROUPING(会社名), 売上合計 DESC
```

この例は B64 の条件付き集計と併用し、会社別明細と総計を返します。`grouping_company` は実データと総計行を機械的に判別する値です。

- grouping item（`ROLLUP` / `CUBE` / `GROUPING SETS` の要素）と `GROUPING()` の引数は、APP の物理フィールド参照または修飾フィールド参照だけです。式・SELECT alias・CTE／一時テーブルの実体化列は使用できません
- `ROLLUP` / `CUBE` / `GROUPING SETS` の入れ子、通常 item と grouping-set の混在、`GROUPING()` の式引数・複数引数、`GROUPING_ID` は未対応です
- `GROUPING()` は SELECT 列、SELECT の CASE 条件、トップレベルの通常 `ORDER BY`、`HAVING`（`HAVING` は v3.18.0 以降）で使用できます。`HAVING GROUPING(会社名) = 1` は総計行だけ、`= 0` は明細＋小計だけに絞り込めます
- `SELECT DISTINCT` を併用できます（v3.18.0 以降）。`KORDER BY`・ウィンドウ関数との併用はできません
- 小計・総計は全入力に依存するため、常に完全入力が必要です。`onLimit=truncate` は使用できず、取得上限へ到達した場合は部分結果を返さずエラーになります。`SELECT DISTINCT`・`HAVING`・`LIMIT` で結果行が減る見込みでも上限は緩みません
- 展開後の grouping set 数、grouping item 数、生成行数には安全上限があります。超過時は planning または実行時に fail-closed でエラーとなり、部分結果を返しません。`CUBE(a, b, ...)` は展開後 `2^n` の grouping set を作るため、上限を超える列数（既定上限では 7 列以上）は取得前に拒否されます
- 重複する grouping set は除去せず、その分の結果行を保持します。`SELECT DISTINCT` は grouping set 自体を消さず、SELECT 出力列の値が完全一致する行だけを除去します。`GROUPING()` を SELECT していれば明細（`0`）と小計・総計（`1`）は別行のまま残り、SELECT しておらず全投影値が同じ行は 1 行にまとまります

### GROUP_CONCAT

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

### 統計集約

`VAR_POP` / `VAR_SAMP` / `STDDEV_POP` / `STDDEV_SAMP` / `MEDIAN` は数値分布を、`MODE` は文字列の完全一致単位で最頻値を集計します。分散と標準偏差は Welford 法、中央値は数値昇順で求めます。偶数件の中央値は中央 2 値の binary64 平均です。

```sql
SELECT 部署, STDDEV_SAMP(金額) AS 標準偏差, MEDIAN(金額) AS 中央値
FROM APP100
GROUP BY 部署

SELECT 部署, MODE(ステータス) AS 最頻ステータス
FROM APP100
GROUP BY 部署
```

- 収集した値に数値化できない値または `Infinity` / `-Infinity` があれば `ArgumentError` になります
- 6 関数は完全入力を必要とします。`onLimit=truncate` を指定しても上限到達時はエラーとなり、部分集合の統計値を返しません
- `DISTINCT` は Number 化後の数値同値で重複を除きます。たとえば `"1"` と `"01"` は同じ値です。既存の 6 集計（`COUNT` / `SUM` / `AVG` / `MIN` / `MAX` / `GROUP_CONCAT`）は従来どおり文字列単位です
- `*` は指定できません。引数にはフィールド、算術式、または前掲の `CASE` 式・`||` 連結・スカラー変数を 1 つ指定します
- `MODE` の同頻度候補は引数型の canonical 順で最小の値を選びます。canonical 同値（数値列の `"1"` と `"01"` など）は raw 文字列のコードポイント順を二次キーにするため、入力順によらず決定的です
- `MODE` は未選択（空セル）を候補に含めません。未選択件数は `COUNT(*) - COUNT(フィールド)` で確認してください。未選択をカテゴリ化する場合は `MODE(CASE WHEN フィールド = '' THEN '未選択' ELSE フィールド END)` と明示できます
- `MODE(DISTINCT x)` は使用できません。`MODE(COALESCE(フィールド, '未選択'))` は算術式扱いで数値評価されるため、この用途では前項の `CASE` を使用してください
- 無印の `STDDEV` / `VARIANCE` は別名ではなく非対応です。母集団・標本のどちらかが方言で異なるため、`_POP` / `_SAMP` を明示してください
- 6 関数は予約語です。`MODE` を含む同名フィールドは `` `MODE` `` のようにバッククォートで囲みます。`MODEL` など長い識別子は影響を受けません

### DISTINCT 付き集計

```sql
SELECT COUNT(DISTINCT 担当者) AS 担当者数 FROM APP100
SELECT COUNT(DISTINCT 都道府県) AS 都道府県数 FROM APP100
```

### 0 件時の挙動

GROUP BY のない集計クエリは、対象が 0 件でも**常に 1 行**を返します（SQL 標準準拠）。

```sql
-- 該当 0 件でも「COUNT(*) = 0」の 1 行が返る
SELECT COUNT(*) FROM APP100 WHERE 異常フラグ = '1'
```

**この表が集計の戻り値の正本です**（実測・v3.54.3）。本書の他の箇所は値を持たず、ここを参照します。

| 集計 | 0 件時の値 | 標準 SQL |
|------|-----------|---|
| `COUNT(*)` / `COUNT(f)` / `COUNT(DISTINCT f)` | `0` | `0`（一致） |
| `SUM` / `AVG` | `0` | `NULL`（**方言差**） |
| `MAX` / `MIN` | `""`（空文字・**v3.54.0 で `0` から変更**） | `NULL` |
| `GROUP_CONCAT` | `""`（空文字） | `NULL` |
| `VAR_POP` / `STDDEV_POP` / `VAR_SAMP` / `STDDEV_SAMP` / `MEDIAN` | `""`（空文字） | `NULL` |
| `MODE` | `""`（空文字） | `NULL` |

**空文字は kSQL の NULL 相当**です。`SUM` / `AVG` が `0` を返すのは、**空セルが算術で `0` になる**という kSQL 全体の規約に合わせているためです。

- 「対象なし（COUNT = 0）」と「合計が 0」を区別したい場合は COUNT を併用してください
- GROUP BY が**ある**場合は従来どおり 0 行を返します（グループが存在しないため）
- 1 件だけのグループでは `VAR_SAMP` / `STDDEV_SAMP` は空文字、`VAR_POP` / `STDDEV_POP` は `0`、`MEDIAN` はその値です
- 1 件だけの `MODE` はその値、全件が空セルなら空文字です
- これにより ASSERT の健全性チェック `ASSERT (SELECT COUNT(*) ... WHERE 異常条件) = 0` が該当 0 件（健全時）に成立します（§26 ASSERT）

---

## 9. HAVING

GROUP BY 後の集計結果に対してフィルタをかけます。  
HAVING 句には集計関数・GROUP BY フィールドを使用できます。

直接記述した集計関数は、同じ集計が SELECT 列にも存在する場合に限り評価できます。SELECT にない集計を HAVING 専用で追加計算はしません。v3.16.0 以降の `CASE` 式引数も同じ規則で直接記述でき、SELECT で付けた alias から参照する書き方も有効です。

B65 の HAVING は grouping set の集約後に各行へ作用します。通常の集計条件に加え、v3.18.0 以降は `HAVING` 内で `GROUPING(field)` を使用できます。`HAVING GROUPING(会社名) = 1` は総計・小計行だけ、`= 0` は明細行だけを残し、`HAVING GROUPING(会社名) = 1 AND SUM(売上) > 0` のように集計条件と組み合わせられます。`GROUPING()` は行の所属 grouping set から `0` / `1` を返す membership 判定であり、grouped 列が空文字の明細行と総計行を取り違えません。`WHERE`・JOIN 条件・集計関数の引数・ウィンドウ定義の中では `GROUPING()` は使用できません。

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

```sql
SELECT 部署,
       SUM(CASE WHEN ステータス = '受注' THEN 売上 ELSE 0 END) AS 受注売上
FROM APP100
GROUP BY 部署
HAVING SUM(CASE WHEN ステータス = '受注' THEN 売上 ELSE 0 END) > 1000000
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

### SELECT alias によるソート

トップレベルの通常 `ORDER BY` では、SELECT 出力 alias をキーとして参照できます。alias の値は SELECT 式と同じ規則・型で評価してからソートします。

```sql
SELECT 金額 AS amount
FROM APP100
ORDER BY amount DESC

SELECT DAYOFWEEK(日付) AS weekday
FROM APP100
ORDER BY weekday ASC
```

- ORDER BY 名が SELECT alias と入力行フィールドの両方に完全一致する場合は、**SELECT alias を優先**します。ドットを含む alias も完全一致を先に判定するため、同名の修飾物理列にはその ORDER BY からアクセスできません
- 同じ alias を複数の SELECT 列へ指定した場合は、出力と同じく**後に記述した列が優先**されます
- alias に一致しない名前は従来どおり入力行フィールドとして解決します。どちらにも解決できない名前は `ORDER_KEY_UNRESOLVED` で実行前に拒否します
- この alias 解決はトップレベルの通常 `ORDER BY` だけに適用します。`OVER (ORDER BY ...)` から同一 SELECT の alias は参照できません。必要な場合は CTE または一時テーブルで一度列を実体化してください
- `KORDER BY` は SELECT alias を直接物理列として扱いません

### GROUPING() による小計・総計行のソート

B65 の通常 `ORDER BY GROUPING(field)` を昇順で指定すると、`GROUPING(field)=1` となる super-aggregate（小計・総計）行を末尾へ寄せられます。B65 文は FULL_SCAN で取得後にローカルソートします。

```sql
SELECT 会社名, GROUPING(会社名) AS grouping_company, SUM(売上) AS 売上合計
FROM APP100
GROUP BY ROLLUP(会社名)
ORDER BY GROUPING(会社名), 売上合計 DESC
```

### canonical順（v3.0.0）

通常の`ORDER BY`は、REST取得・FULL_SCAN・一時テーブル・CLI・MCP・プラグインのどの経路でも、同じkSQL canonical比較規則を使います。

- typed string／型不明: Unicodeコードポイント順。NFC/NFD等のUnicode正規化やロケール照合は行いません
- typed number: `空セル < -Infinity < 有限数 < +Infinity < "NaN" < その他非数値`。その他非数値のバンド内はコードポイント順です
- 選択系: フォームまたはプロセス設定の定義順。未知・削除済み選択肢は既知値の後ろです
- RECORD_NUMBER: アプリコードを含む表示値から末尾の数値IDを任意精度で比較します
- DESCはバンドを含む順序全体を反転します

文字列`"10"`を数値10として扱う値ベース自動判定は行いません。型を確定できない式・一時列も既定は文字列です。ローカル比較契約のない複合型は、行数に依存せずplanning時にエラーになります。

同値行の最終表示順はcanonical tieとして安定化しますが、`RANK` / `DENSE_RANK`のpeer判定にはそのtieを混ぜません。JOINで複数テーブルに同名列がある場合、非修飾キーは`ambiguous column`として拒否するため、`a.列名`のように修飾してください。

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

### KORDER BY（kintone固有順、v3.0.0）

`KORDER BY`は高速化ヒントではなく、比較意味をkintone REST APIの型別順序へ切り替える別構文です。条件外で通常`ORDER BY`へ黙ってフォールバックしません。

```sql
SELECT 会社名, 金額
FROM APP100
WHERE 顧客ランク = 'A'
KORDER BY 会社名 ASC, $id ASC
LIMIT 20
```

初期版は次をすべて満たす場合だけ使用できます。

- 利用者へ結果を返すトップレベルSELECT、単一の物理アプリ、JOIN／CTE／temp／UNION／集約／WINDOWなし
- **非修飾の**直接物理フィールドまたは`$id`だけをキーにする。SELECT alias、`t.金額`のような表修飾、関数、算術式は未対応
- WHERE全体をkintoneへ同値に押し下げられ、SQL `LIKE`／`KLIKE`を含まない
- `LIMIT`を明示し、`LIMIT`・`OFFSET`・`OFFSET + LIMIT`がすべて0以上の安全な整数である
- 型は`$id`、RECORD_NUMBER、SINGLE_LINE_TEXT、NUMBER、CALC、DATE、DATETIME、TIME、CREATED_TIME、UPDATED_TIME、DROP_DOWN、RADIO_BUTTON、STATUS、LINK、CREATOR、MODIFIERの明示allowlist内

`LIMIT ≤ 500`・`OFFSET ≤ 10000`・`LIMIT ≤ maxRecords`なら、指定したORDER/LIMIT/OFFSETを単発GETへそのまま送ります。`LIMIT 0`も型・WHERE・query形状を完全検査した後、records APIを呼ばず空結果を返します。同値群の決定性が必要なら、最後のキーとして`$id ASC`等を明示してください。

#### 大きい窓と Cursor API（v3.1.0）

v3.0.0 では単発GETで完結しない窓（`LIMIT > 500`・`OFFSET > 10000`）は planning error です。**v3.1.0** では、この窓を kintone の **Cursor API**（カーソル作成・取得・削除）で実行できます（計画名 `KORDER_CURSOR`）。

カーソルを利用する条件（すべて満たす場合だけ）:

- 上記の `KORDER BY` 共通条件（トップレベル SELECT・単一物理アプリ・非修飾キー・型 allowlist・WHERE 完全押し下げ・`KLIKE` なし・`LIMIT` 明示）をすべて満たす
- 単発GETの窓（`LIMIT ≤ 500` かつ `OFFSET ≤ 10000` かつ `LIMIT ≤ maxRecords`）に**収まらない**。収まる場合は従来どおり単発GET（`KORDER_NATIVE`）を優先する
- **走査件数 `OFFSET + LIMIT` が実行時 `maxRecords` 以下**。カーソルでは OFFSET 分を kSQL が先頭から受信して読み捨てるため、返却行数ではなく走査件数に `maxRecords` が掛かります（単発GETの OFFSET はサーバーが読み飛ばすため対象外 — この非対称は「kSQL が受信する行数の上限」という `maxRecords` の意味そのものです）
- 条件を満たさない場合は planning error。通常 `ORDER BY` へ黙ってフォールバックしません

```sql
-- v3.1.0: 10,001 件を kintone 固有順のまま取得
SELECT 会社名, 金額
FROM APP100
KORDER BY 金額 DESC, $id ASC
LIMIT 10001
-- CLI/MCP の既定 maxRecords=500 では走査件数が超過するため、
-- --max-records 10001 等へ明示的に引き上げる
```

> **カーソルの特長・制限（注釈）:**
>
> - **対象集合はカーソル作成時点で固定、値は各取得時点** — 完全なスナップショットではありません。走査中にレコードが更新されると、返る値は取得時点のものになり、ソートキー自体が更新された場合は結果が表示値上 KORDER 順に見えないことがあります。更新のない時間帯の実行を推奨します
> - **カーソルは 1 ドメイン最大 10 個**を、kSQL 以外の製品・他プロセスも含めて共有します。kSQL は自制のため同時カーソルを既定 2・最大 5 に制限します。ドメイン全体の空き枠は保証できないため、内部上限以下でも作成が失敗することがあります
> - **有効期限は作成から 10 分**（残件取得で延長）。全件取得または明示削除で解放されます。kSQL は必要な窓へ到達した時点でカーソルを即時削除しますが、異常終了時は最大 10 分程度、ドメインの枠を 1 つ占有する可能性があります
> - **取得は 500 件ずつ**の逐次ページで、kintone が返した順序をそのまま結果にします（ローカル再ソート・`$id` の自動追補なし）。同値群の決定性が必要なら単発GETと同様に `$id` を最後のキーへ明示してください
> - **カーソルの作成・取得は自動再試行しません**。応答喪失時に再試行すると、孤児カーソル（作成）やページ欠落（取得）が起き得るためです。作成タイムアウト時はクエリの絞り込み・単純化を案内するエラーになります

同時カーソル上限はCLIの`--cursor-max-active`、環境変数`KSQL_CURSOR_MAX_ACTIVE`、profileの`query.cursorMaxActive`、MCP入力`cursorMaxActive`、pluginの取得オプションで1..5へ設定できます。既定は2です。同一process・同一hostで後から変更した場合も次の取得から反映されます。上限を下げても既存Cursorは強制終了せず、active数が新上限を下回るまで新規作成を待機させます。

`KORDER`は予約語です。同名フィールドは`` `KORDER` ``と記述します。



---

## 10.1 ウィンドウ関数

順位付け・グループ内連番、`SUM` / `COUNT` / `AVG` / `MIN` / `MAX` の集計ウィンドウに加え、前後の行を参照する `LAG` / `LEAD` を使用できます。ウィンドウ関数を含むSELECTは全件を取得してJSで評価するため、常にFULL_SCANモードです。集計ウィンドウと `LAG` / `LEAD` は完全入力を要求し、取得上限での truncate は部分結果を返さずエラーになります。

```sql
ROW_NUMBER() OVER ([PARTITION BY フィールド [, ...]] [ORDER BY キー [ASC|DESC] [, ...]]) AS alias
RANK()       OVER ([PARTITION BY フィールド [, ...]] [ORDER BY キー [ASC|DESC] [, ...]]) AS alias
DENSE_RANK() OVER ([PARTITION BY フィールド [, ...]] [ORDER BY キー [ASC|DESC] [, ...]]) AS alias

{SUM|COUNT|AVG|MIN|MAX}(引数) OVER (
  [PARTITION BY フィールド [, ...]]
  [ORDER BY キー [ASC|DESC] [, ...]
    [{ROWS|RANGE} BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW]]
) AS alias

{LAG|LEAD}(値式 [, offset]) OVER (
  [PARTITION BY フィールド [, ...]]
  ORDER BY キー [ASC|DESC] [, ...]
) AS alias
```

- `ROW_NUMBER` — 同順位を作らず、1から連番を付ける
- `RANK` — 同値は同順位。次の順位を飛ばす（`1, 1, 3`）
- `DENSE_RANK` — 同値は同順位。次の順位を飛ばさない（`1, 1, 2`）
- `PARTITION BY` 省略時は全行を1グループとして扱う
- `ORDER BY` 省略時、`RANK` / `DENSE_RANK` は全行1。`ROW_NUMBER` は取得順で採番する
- `AS alias` は必須
- 集計引数は通常集計と同じく、フィールド・算術式・関数・`CASE`・`||`・`@var` を指定できる。`COUNT(*)` も使用できる
- `SUM(DISTINCT x) OVER (...)` のような引数の `DISTINCT`、`GROUP_CONCAT`・統計集計の `OVER`、ウィンドウ結果を同じ SELECT 内の式へ入れる形は未対応。CTEで一度実体化する
- `SELECT DISTINCT` とウィンドウ列の併用は可能。ウィンドウ評価後に DISTINCT を適用する
- `LAG(expr, n)` はソート後のパーティション内で `n` 行前、`LEAD(expr, n)` は `n` 行後の値を返す。パーティション外は空文字
- `offset` は省略時 `1`。非負の safe integer リテラルだけを指定でき、`0` は現在行を返す。変数・式・小数・負数は使用できない
- `LAG` / `LEAD` の第3引数（既定値）は未対応。必要なら次の段の `CASE` で空文字を置き換える
- `LAG` / `LEAD` は `ORDER BY` 必須。全順序でない場合は同順内の前後関係が未規定になるため、レコード番号などのタイブレークキーを加える
- **CTE や一時テーブルを読む場合、その表に `レコード番号` は無い。** 元になった集約のキーなど、その表の中で一意になる列を `ORDER BY` に含める（警告の文面も経路に応じて変わる）
- **集約結果の列は、実際に一意でも一意だと証明できない。** `GROUP BY` キーで並べていてもこの警告は出る。**値は正しく、その形では警告を消せない**（`ksql_docs` の `recipes/r16` に例がある）
- `LAG` / `LEAD` は soft keyword。同名のフィールドは従来どおり参照できる

```sql
-- 顧客ごとの受注を新しい順に採番
SELECT 顧客ID, 受注日, 金額,
       ROW_NUMBER() OVER (PARTITION BY 顧客ID ORDER BY 受注日 DESC) AS rn
FROM APP300
```

### 前後の行を参照する `LAG` / `LEAD`

前月比のようにウィンドウ結果を計算へ使う場合は、集約、`LAG`、比率計算の3段に分けます。ウィンドウ結果を同じSELECTの式へ直接入れることはできません。

```sql
WITH 月次 AS (
  SELECT DATE_FORMAT(日付, '%Y-%m') AS 年月, SUM(個数) AS 出庫数
  FROM APP4228 WHERE 入出庫区分 = '出庫' GROUP BY 年月
), 前月付き AS (
  SELECT 年月, 出庫数,
         LAG(出庫数) OVER (ORDER BY 年月) AS 前月
  FROM 月次
)
SELECT 年月, 出庫数, 前月,
       CASE WHEN 前月 = '' THEN ''
            ELSE ROUND((出庫数 - 前月) * 100.0 / 前月, 1) END AS 前月比
FROM 前月付き
ORDER BY 年月
```

参照先のセルが空なら空文字をそのまま返します。引数はフィールドだけでなく、算術・文字列関数・`CASE`・連結を含む値式を指定できます。出力列は引数の型メタデータを引き継ぐため、次の段の `ORDER BY` や `MIN` / `MAX` も数値順・日付順・選択肢の定義順など元の列の比較規則を使用します。

### 集計ウィンドウのフレーム

`ORDER BY` が無い場合はパーティション全体を集計し、全行へ同じ値を載せます。`ORDER BY` がある場合の既定は標準どおり `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` です。明示できるフレームは `ROWS` または `RANGE` の同じ固定境界だけです。

前日までの残高が60で、同じ日に3件の増減がある場合、`RANGE` は同順グループ末尾の値を全peer行へ書き戻し、`ROWS` は行ごとの途中値を返します。

| 日付 | 増減 | `ROWS`（明示） | `RANGE`（既定） |
|---|---:|---:|---:|
| 2026-03-18 | +100 | 160 | 110 |
| 2026-03-18 | -30 | 130 | 110 |
| 2026-03-18 | -20 | 110 | 110 |

日次残高では既定 `RANGE`、取引ごとの残高では `ROWS` を明示します。全順序にしたい場合はレコード番号などのタイブレークキーも `ORDER BY` に加えます。**CTE や一時テーブルを読む場合はその表に `レコード番号` が無い**ので、元になった集約のキーなど、その表の中で一意になる列を使います。`EXPLAIN` は実効フレームを表示し、既定 `RANGE` だけ `(既定)` を付けます。

```sql
SELECT 製品名, 日付, 個数_在庫計算用,
       SUM(個数_在庫計算用) OVER (
         PARTITION BY 製品名 ORDER BY 日付, レコード番号
         ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
       ) AS 累積在庫
FROM APP4228
```

空値・NaN のスキップと比較規則は通常集計と共通です。小数を含む `SUM` / `AVG` はウィンドウの並び順で加算するため、通常集計との比較は相対誤差 `1e-12` を目安にします。`MIN` / `MAX` は canonical 同値の値（例: 数値型の `"1"` と `"01"`）では先に走査した raw 表記を保持するため、raw 表記は不定です。

`WHERE` はウィンドウ関数より先に評価されるため、同じSELECTの `WHERE rn = 1` では絞り込めません。CTEでスコープを分けると、各顧客の最新行を全列付きで1文取得できます。

```sql
WITH ranked AS (
  SELECT 顧客ID, 受注日, 金額,
         ROW_NUMBER() OVER (PARTITION BY 顧客ID ORDER BY 受注日 DESC) AS rn
  FROM APP300
)
SELECT 顧客ID, 受注日, 金額
FROM ranked
WHERE rn = 1
```

ウィンドウ内の `ORDER BY` はトップレベルの通常`ORDER BY`と同じcanonical比較規則を使用します。CTE／一時テーブル由来でも伝播した型メタデータを使い、型を確定できない列は文字列として扱います。値の見た目による数値／文字列のペア単位切替は行いません。`KORDER BY`はウィンドウ内では使用できません。

同じSELECT内での `GROUP BY`／集計関数との併用は未対応です。集約結果へ順位を付ける場合はCTEでスコープを分けます。

```sql
WITH agg AS (
  SELECT 部署, SUM(売上) AS 合計 FROM APP300 GROUP BY 部署
)
SELECT 部署, 合計, RANK() OVER (ORDER BY 合計 DESC) AS 順位
FROM agg
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

### v3.0.0 制限値一覧

| 対象 | 制限値 | 超過・条件不成立時の動作 |
|---|---:|---|
| 通常`ORDER BY`の`LIMIT` | SQL構文上の固定上限なし | REST top-Nの条件を満たさない値（初期版では`LIMIT > 500`等）は禁止せず、完全候補取得後のlocal sortへ切り替える |
| 通常`ORDER BY`の`OFFSET` | SQL構文上の固定上限なし | REST top-Nの条件を満たさない値（初期版では`OFFSET > 10000`等）は禁止せず、local評価へ切り替える |
| local `ORDER BY`の候補取得 | 実行時`maxRecords`未満で完了すること | 上限へ到達すると、`LIMIT 1`や`onLimit=truncate`でも`FetchAllLimitError`。部分候補のtop-Nは返さない |
| `CANONICAL_REST_TOP_N`の窓 | `LIMIT 0..500`かつ`LIMIT <= maxRecords`、`OFFSET 0..10000` | 利用者エラーにはせず`CANONICAL_LOCAL`へ切り替える。初期キーallowlistは`$id`のみ |
| `KORDER BY`の`LIMIT` | **必須**。`0..500`かつ`LIMIT <= maxRecords` | planning error。通常`ORDER BY`へフォールバックしない |
| `KORDER BY`の`OFFSET` | 省略または`0..10000` | `10001`以上はplanning error。APIが受理する場合でも許可しない |

`KORDER BY` の窓制限は **v3.1.0** で緩和され、単発GETに収まらない窓を Cursor API で実行できます（条件: 走査件数 `OFFSET + LIMIT` ≤ `maxRecords`）。詳細と注意点は §10「大きい窓と Cursor API」を参照してください。

`maxRecords`はSQLの返却行数ではなく、RESTから取得して保持する候補行数の上限です。入口ごとの既定値は次のとおりです。

| 実行面 | `maxRecords`既定値 | 変更方法 |
|---|---:|---|
| エンジンAPIを直接利用 | 10,000件 | `ExecuteOptions.maxRecords` |
| CLI | 500件 | `--max-records`／`KSQL_MAX_RECORDS`／profile `query.maxRecords` |
| MCP | 500件 | `ksql_query`・`ksql_explain`等のtool入力`maxRecords`／`KSQL_MAX_RECORDS`／profile `query.maxRecords` |
| プラグイン | 3,000件 | 実行画面の「最大取得件数」 |

値を引き上げるとAPI呼出し回数、メモリ使用量、タイムアウトリスクも増えます。`CREATE TEMP TABLE`の実体化には別の`tempTableMaxRows`（既定10,000件）が適用され、`maxRecords`とは独立です。

> **`LIMIT`と`maxRecords`は別の値です:** `LIMIT`は返却行数、`maxRecords`は候補取得数を制御します。`LIMIT`を省略しても無制限にはならず、上表の入口別`maxRecords`が適用されます。

> **`LIMIT > 500` の早期停止:** `ORDER BY`がなくKLIKEを含まない安全な経路では、`OFFSET + LIMIT`件を取得した時点で正常終了します。`maxRecords`は実際に取得する行数の上限です。

> **ORDER BYと取得上限（v3.0.0）:** ローカル`ORDER BY`は正しいtop-Nのため完全な候補集合を必要とします。上限到達時に`onLimit=truncate`で部分候補を並べ替えて返さず、エラーにします。`CANONICAL_REST_TOP_N`（初期allowlistは`$id`のみ）と`KORDER_NATIVE`は単発REST窓なので、この完全入力エラーの対象外です。

> **集計・重複排除と取得上限:** 通常集計（`COUNT` / `SUM` / `AVG` / `MIN` / `MAX` など）、plain `GROUP BY`、`SELECT DISTINCT`、`UNION`（`ALL` なし）は完全な候補集合を必要とします。上限到達時は`onLimit=truncate`でも部分集合を畳んだ値を返さず、エラーにします。従来成功して見えた場合も結果は正しくありません（実測では、真の件数が3のlocal `LIKE` + `COUNT(*)`が`maxRecords=3`で`0`を返しました）。素の明細と`UNION ALL`は従来どおり取得行と警告を返します。完全押し下げ可能な`COUNT(*)`の単発`totalCount`取得はレコード本体を打ち切らないため、この制限の対象外です。

> **SIMPLE モード（JOIN なし）:** `ORDER BY`のREST押し下げはLIMIT値だけで決めず、schema-aware plannerがWHERE・型・query形状・窓全体を検査します。それ以外は全候補取得後にcanonical順を適用します。
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
- 両辺は同じ列数にする必要があります。実体化後の列数が一致しない場合は、左右の列数を示すエラーになります。足りない側には `''` などのリテラルを追加して列数を揃えてください
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

### CTE と相対日付

実体化 CTE の本体、`WITH` の最終 SELECT、単一 CTE のインライン展開では、その SELECT の `WHERE` 全体を kintone クエリへ exact に押し下げられる場合に相対日付関数を使用できます。これらを JOIN 入力にする形、`KORDER BY`、サブテーブル、入れ子 SELECT、本体そのものが `UNION` の場合、または `WHERE` 全体が exact にならない形では使用できません。JOIN で使える第5-W / 第5-L は、JOIN の全入力が alias 付き物理 APP の場合に限ります。

```sql
WITH 月別 AS (
  SELECT 区分, COUNT(*) AS 件数
  FROM APP100
  WHERE 日付 = THIS_MONTH()
  GROUP BY 区分
)
SELECT * FROM 月別
```

`WHERE 日付 = THIS_MONTH() AND LENGTH(件名) > 1` のような prefilter＋client 残余の形はトップレベル SELECT では使えますが、CTE 本体や `WITH` の最終 SELECTでは使えません。その場合は CTE に切り出さずトップレベルで書きます。

### CTE 内での SHOW APPS / DESCRIBE

`SHOW APPS` と `DESCRIBE` / `DESC` の結果も CTE として定義し、後続クエリでフィルタ・加工できます。

```sql
-- 名前でアプリ一覧を絞り込む
WITH アプリ一覧 AS (SHOW APPS)
SELECT * FROM アプリ一覧
WHERE アプリ名 LIKE '受注%'

-- テキスト系フィールドだけ抽出
WITH フィールド AS (DESCRIBE APP100)
SELECT * FROM フィールド
WHERE タイプ IN ('SINGLE_LINE_TEXT', 'MULTI_LINE_TEXT')

-- DESC も使用可能
WITH フィールド AS (DESC APP100)
SELECT フィールドコード, ラベル FROM フィールド
ORDER BY フィールドコード ASC
```

### GENERATE_SERIES — 整数・日付系列

入力レコードを使わず、整数または `DATE` の系列を作れます。`GENERATE_SERIES` を直接書けるのは `WITH` の CTE 本体だけです。`FROM GENERATE_SERIES(...)`、トップレベル直書き、SELECT 列のスカラー関数としての使用には対応しません。

```text
WITH CTE名 AS (
  GENERATE_SERIES(start, stop [, step]) [AS 列名]
)
SELECT ... FROM CTE名
```

列名を省略した場合は `generate_series` です。整数の既定 step は `1`、日付の既定 step は `'1 day'` です。正負の step と明示的な `+`（`+2` / `'+2 days'`）を使用でき、`stop` にちょうど到達する値は含みます。範囲と step の向きが逆なら0行（列定義は維持）、step 0は `ArgumentError` です。

```sql
WITH n AS (GENERATE_SERIES(2, 100, 49) AS number)
SELECT number FROM n ORDER BY number;
-- 2, 51, 100（文字列順ではなく数値順）

WITH d AS (GENERATE_SERIES('2026-08-05', '2026-08-01', '-2 days') AS 日付)
SELECT 日付 FROM d;
-- 2026-08-05, 2026-08-03, 2026-08-01
```

日付は実在する `YYYY-MM-DD` だけを受け付け、step の単位は `day` / `days` だけです。小数、`DATETIME`、`TIME`、`week`、`month`、`year` には対応しません。公開行の値は文字列ですが、生成時に確定した NUMBER / DATE の列メタが CTE、JOIN、後続 CTE、一時テーブルへ伝播し、比較・ソートに使われます。

同じ `WITH` 文にある全生成 CTEの生成件数合計は10,000行までです。上限は全行を作る前に検査され、`LIMIT`、`WHERE`、後段集計では回避できません。同じ生成 CTEを複数回参照しても再生成しません。

```sql
DECLARE @from = '2026-08-01';
DECLARE @today = TODAY();
WITH d AS (GENERATE_SERIES(@from, @today) AS 日付)
SELECT 日付 FROM d ORDER BY 日付;
```

通常のスカラー変数が具体的な日付になれば DATE 引数に使用できます。`ksql_validate` はリテラルだけで確定する型、step 0、不正日付、未対応単位、安全整数、単一・合計上限を API 0回で検査します。変数値に依存する型・step・件数は保留し、実行時に変数解決後の値で最終判定します。生成 `WITH` は read-only で、read-only 保存クエリと `ksql_run_saved_query` から利用できます。

生成 CTEを JOIN なしで直接読むウィンドウで、`OVER (ORDER BY 生成列)` が生成列そのものを参照する場合、その列は一意なので既定 `RANGE` と `LAG` / `LEAD` の全順序警告を抑止します。JOIN、自己 JOIN、`UNION`、通常 CTEによる再実体化、サブテーブル展開、一時テーブル、`ORDER BY n + 0` 等では既存警告を維持します。

存在しない日を0で補う完全例:

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

`EXPLAIN WITH ... GENERATE_SERIES ...` は source、列名、INTEGER / DATE、start、stop、正規化した step、生成件数、10,000行ガード、records API が `none` であることを表示します。純粋な生成系列の実行と EXPLAIN はレコード、Cursor、書込、フォーム・アプリ情報 API を呼びません。

### 実体化後の列実在チェック（B86）

CTE・一時テーブル・`SHOW APPS` / `DESCRIBE` の結果は、実体化した SELECT の**出力列だけ**を後段から参照できます。存在しない列は空文字として評価せず、下流の records GET、DML 確認、POST / PUT より前に `ArgumentError: unknown field code(s)` で拒否します。SELECT、WHERE（`=` / `LIKE` を含む全演算子）、式、CASE、集計、GROUP BY / HAVING / ORDER BY、window、JOIN、subquery、UNION、`INSERT` / `UPSERT ... SELECT` の source で共通です。物理 APP と実体化 source を混在 JOIN した場合も両方を検証します。

これは、従来の誤結果・誤書き込みをエラーへ変える破壊的な正しさ修正です。特に、値のつもりで裸の識別子を書くと列参照になります。文字列値は引用してください。

```sql
-- NG: 顧客 は列参照。実体化結果にその列がなければ ArgumentError
WITH アプリ一覧 AS (SHOW APPS)
SELECT * FROM アプリ一覧 WHERE アプリ名 LIKE 顧客;

-- OK: 値を文字列リテラルとして引用
WITH アプリ一覧 AS (SHOW APPS)
SELECT * FROM アプリ一覧 WHERE アプリ名 LIKE '顧客';
```

`SELECT x AS y` を実体化した後段では `x` ではなく出力名 `y` を使います。UNION の実体化結果では左枝の列名／alias が出力 schema です。`rows=[] && columns=[]` で schema 自体を復元できない0行 wildcard source は、JOIN なしの読出しに限り既存の0行挙動を維持します。JOIN 入力では有効な JOIN key を証明できないため、物理レコード取得前に schema-unavailable error になります。

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
| `アプリID` | アプリ ID |
| `アプリ名` | アプリ名 |
| `説明` | 説明 |

> 100 件単位で自動ページングし、最大 1,000 件まで取得します。

### DESCRIBE / DESC — フィールド一覧取得

指定したアプリのフィールド定義を取得します。

```sql
DESCRIBE APP100
DESC APP100      -- 省略形（DESCRIBE と同等）
```

| カラム | 内容 |
|--------|------|
| `フィールドコード` | フィールドコード |
| `ラベル` | フィールドラベル |
| `タイプ` | フィールドタイプ（`SINGLE_LINE_TEXT`、`NUMBER` 等） |
| `サブテーブル` | サブテーブルの中の項目なら、そのサブテーブルのフィールドコード。親項目なら空文字 |
| `ルックアップ` | ルックアップフィールドなら `YES`、それ以外は空文字 |
| `コピー元` | ルックアップからコピーされた値なら `YES`、それ以外は空文字 |
| `重複禁止` | 値の重複が禁止されていれば `YES`、それ以外は空文字 |
| `計算式` | 計算フィールドまたは非空の計算式を持つフィールドなら `YES`、それ以外は空文字 |

値の由来を示す4列（`ルックアップ` / `コピー元` / `重複禁止` / `計算式`）は、該当するときだけ文字列 `YES` を返します。4列がすべて空でも、完全な制約や設定の確認が不要とは限りません。必要に応じて `ksql_app_metadata` を使用してください。

> **`DESCRIBE` は親項目とサブテーブルの中の項目を両方返します**（v3.56.0 で `サブテーブル` 列を追加）。
> **どちらから選ぶかを間違えると、エラーにならず全行が空になります。**
>
> ```sql
> -- ✗ 明細項目を親から選ぶと、警告は出るが値は全行空
> SELECT $id, 数量 FROM APP100
>
> -- ○ サブテーブル仮想テーブルから選ぶ
> SELECT _pid, 数量 FROM APP100$明細
> ```
>
> **`サブテーブル` 列が空でない項目は、`APP100$<その値>` から選んでください。**
> 親から選んだ場合は実行時に警告を出しますが、**値は変えません**（既存の SQL を壊さないため）。

```sql
-- WITH 句と組み合わせてフィルタ
WITH アプリ AS (SHOW APPS)
SELECT * FROM アプリ WHERE アプリ名 LIKE '受注%'

WITH フィールド AS (DESC APP100)
SELECT * FROM フィールド WHERE タイプ = 'NUMBER'
```

---

## 15. INSERT

### 親レコード DML の対象フィールド検査

親レコードを対象とする `INSERT` / `UPDATE` / `UPSERT` は、書き込み先フィールドが対象アプリに存在し、トップレベルにあり、書き込み可能であることを実行前に検査します。不存在フィールド（フィールドコードの誤記を含む）とサブテーブル子フィールドは、行単位で無視・隔離せず文単位の `ArgumentError` になります。サブテーブル子を更新する場合は `APP100$明細` のような[サブテーブル DML](#サブテーブル-dml)を使用してください。

この検査は `VALIDATE ONLY` / `ON ERROR SKIP` を含む全経路で、ソース SELECT、更新・UPSERT対象レコードの取得、確認ダイアログ、POST / PUT より前に完了します。不正な書き込み先ではフォーム定義の取得以外のレコード API や確認処理を呼びません。

### VALUES による登録

```sql
INSERT INTO APP100 (フィールド1, フィールド2, ...)
VALUES (値1, 値2, ...)
```

VALUES の数値には単項符号付きリテラル（`-5` / `+5` / `-0.5` / `+0.5`）を指定できます。符号の直後は数値リテラルに限られ、`--5` / `+-5` / `-+5` / `++5`、算術式、フィールド参照、関数呼び出しは指定できません。引用符付きの `'-5'` は数値ではなく文字列です。この規則は親・サブテーブルの INSERT VALUES と UPSERT VALUES で共通です。

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

> **確認ダイアログ（プラグイン）:** `INSERT INTO ... VALUES` も実行前に登録件数を表示して確認を求めます。  
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

数値リテラルには単項 `-` / `+` を指定できます（例: `SET 金額 = -5`、`SET 金額 = +0.5`）。単項 `+` は数値リテラル直前だけに限られ、`+フィールド` や `+(式)`、符号のネストは指定できません。既存の単項 `-` はフィールドや括弧付き算術式にも使用できます。

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

> `REGEXP_REPLACE` / `REGEXP_SUBSTR` などの正規表現結果を一時テーブル経由の `UPDATE ... FROM` で書き戻す場合、ブラウザ／Node とその版による結果差が保存データの差になります。書き戻しに使う実行面と版を固定し、事前に SELECT で結果を確認してください。

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

### SET での文字列関数

親レコードの通常の `UPDATE` では、SET の右辺に文字列関数を直接指定できます。関数は更新対象レコードごとに評価され、SET 対象とは別のフィールドも参照できます。戻り値は関数の意味型を引き継ぎ、値の見た目から数値／文字列を再判定しません。

```sql
UPDATE APP100
SET 正規化名 = UPPER(名称),
    コード = LPAD(コード, 5, '0')
WHERE $id IN (1, 2, 3)
```

`UPPER` / `CONCAT` / `REPLACE` / `SUBSTRING` / `LEFT` / `RIGHT` / `TRANSLATE` / `REGEXP_LIKE` / `REGEXP_REPLACE` / `REGEXP_SUBSTR` などの文字列関数を使用できます。`LPAD('7', 5, '0')` と `REGEXP_LIKE(...)` の結果は、見た目が数値でも文字列のまま書き込まれます。`VALIDATE ONLY` と `ON ERROR SKIP` は、関数を評価した後の値を検証します。

これは書き込み候補に対する組み込み制約検証です。CHECK の評価行は別で、通常 UPDATE は更新前の既存値を参照します。新値を検査する場合は SET 式を CHECK に再掲してください。INSERT/UPSERT/UPDATE FROM を含む文種別の評価行は §17.3 を参照してください。

正規表現のホスト差は保存データの差になり得るため、書き込みに使う実行面と版を固定してください。

次の範囲は非対応です。

- `SET n = LENGTH(s) * 1` のように算術式の中へ文字列関数を入れること
- `SET a = b` のようにフィールド参照だけを右辺へ指定すること
- `UPDATE ... FROM` またはサブテーブル UPDATE の SET 右辺へ文字列関数を直接指定すること（`UPDATE ... FROM` の `SET a = src.b` は従来どおり使用できます）

また、親レコード DML の WHERE 句では文字列関数を使用できません。SET で関数を使えるようになっても、`WHERE LEFT(郵便番号, 3) = '100'` のような絞り込みは拒否されます。不正な行だけを正規化する場合は、一時テーブルで対象と変換値を作り、`UPDATE ... FROM` で書き戻します。

```sql
CREATE TEMP TABLE #norm AS
SELECT $id AS 対象id,
       REPLACE(REPLACE(電話番号, '-', ''), ' ', '') AS 正規化
FROM APP100
WHERE 条件;

UPDATE APP100
SET 電話番号 = n.正規化
FROM #norm AS n
WHERE APP100.$id = n.対象id;
```

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
| 返却行数 | 1 行 1 列のみ（0 行・2 行以上はエラー。GROUP BY なしの集計サブクエリは 0 件でも 1 行を返すためエラーになりません。**戻り値は関数ごとに違います** — §8） |
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

検証対象は必須、数値・日付・時刻・日時、数値範囲、文字列長、選択肢、UPSERTキーの空値・ソース内重複です（`UPDATE`/`UPSERT` update 分岐は後述の post-image によりレコード全体・サブテーブル子行も対象）。1行に複数の問題があればエラーも複数行になります。結果には `validatedRows` / `validRows` / `invalidRows` / `errorCount` と、入力ペイロード列および `$err_*` 診断列（`$err_statement` / `$err_operation` / `$err_row` / `$err_field` / `$err_code` / `$err_message` / `$err_value` / `$err_subtable` / `$err_subrow` / `$err_subrow_id` の10列。v3.9.0 以降）が含まれます。子セル以外の違反では末尾4列（`$err_value` / `$err_subtable` / `$err_subrow` / `$err_subrow_id`）は空文字です。

複文バッチでは `VALIDATE ONLY INTO #err` とすると、同じエラー行を後続文から一時テーブルとして参照できます。同名 `#err` は入力列構成が同じ場合だけ追記でき、異なるschemaまたは `tempTableMaxRows` 超過は既存行を変更せずエラーになります。

```sql
INSERT INTO APP100 (顧客コード, 金額)
SELECT 顧客コード, 金額 FROM #source
VALIDATE ONLY INTO #err;
SELECT * FROM #err;
```

- `VALIDATE ONLY` はread-only扱いで、MCPでは `ksql_query`、CLIでは `--allow-dml`なし、プラグインでは確認ダイアログなしで実行できます
- 書き込み先に NUMBER 列がある場合、通常 DML と同じく運用環境の `app/settings.json` から `numberPrecision` を取得し、**整数部**が `digits - decimalPlaces` 桁を超える値を書き込み前に検出します（`ERR_NUMBER_INTEGER_DIGITS`）。kintone も整数超過は全面で `CB_VA01` 拒否するため、これはその判断の前倒しです
- **小数部は kSQL では検証しません**。`decimalPlaces` を超える小数はそのまま kintone へ渡し、kintone が `roundingMode` で自動丸めします（REST API・CSV 読み込み・編集画面・計算フィールドと同じ挙動）。`1/3` などの算術結果に `ROUND` を強制しません
- 一般設定は同じ実行コンテキスト・アプリごとに最大1回取得します。取得失敗、不正レスポンス、未知の丸めモードでは既定値を仮定せず文全体をfail-closedし、`ON ERROR SKIP` の行エラーには変換しません
- 既存 `ROUND` の意味は変わりません。算術、集計、数値関数、CASE、CALC由来値の計算は引き続きbinary64です
- 完全な候補集合が必要なため、`onLimit=truncate` / CLI `--on-limit truncate` / プラグインのtruncate設定は無視され、常にerrorとして扱われます
- ローカル検証は通常の書き込み経路より厳密な場合があります。検証エラーはkSQLが検出したTier 0問題であり、同じ値をkintone APIが必ず拒否するという予測ではありません
- 検証通過は書き込み成功を保証しません。権限、競合、ユーザー実在性、既存レコードとの一意制約衝突などAPI実行時の問題は対象外です
- **`UPDATE` / `UPSERT`（update 分岐）の `VALIDATE ONLY` は、SET 対象列だけでなく、更新対象レコードの取得スナップショットに SET を適用した「post-image（レコード全体）」を検証します（v3.9.0・B43）。** これにより、SET 対象外のトップレベル項目や**サブテーブル子行に残る既存違反**（必須・文字列長・数値範囲・選択肢・数値精度）も書き込み前に検出します。kintone は PUT 時にレコード全体を再検証するため、この検証は本実行時の `CB_VA01` を前倒しで捕捉します。子違反は `$err_subtable`（テーブルコード）・`$err_subrow`（1-based 行序数）・`$err_subrow_id`（永続行 ID＝仮想テーブルの `_rid`）で位置を示します。プレーンな `UPDATE`/`UPSERT` 実行（`VALIDATE ONLY`/`ON ERROR SKIP` なし）の取得挙動は変わりません
- この検証のため、`UPDATE`/`UPSERT` の `VALIDATE ONLY` は対象レコードの完全なスナップショット（`$id`＋検証対象トップレベル＋全サブテーブル）を取得します。`UPDATE` は既存 GET の取得列を拡張し、`UPSERT` は照合後に更新対象 ID を100件ずつまとめて追加取得します（対象1件ごとの追加 GET は行いません）

## 17.2 ON ERROR SKIP（事前検証エラー行の隔離）

複文バッチ内の親レコード `INSERT` / `UPSERT` / `UPDATE` に `ON ERROR SKIP INTO #err` を付けると、`VALIDATE ONLY` と同じTier 0検証で不正になった行を `#err` へ隔離し、合格行だけを書き込みます。書き込みを行うため、MCPでは `ksql_mutate` とDML承認、CLIでは `--allow-dml` が必要です。**`UPDATE` / `UPSERT`（update 分岐）では §17.1 の post-image 検証により、更新対象レコードのサブテーブル子を含む既存違反を持つ親も隔離対象になります（v3.9.0・B43）。** これにより、既存違反レコード1件が同一チャンクの合格行まで巻き添えにして `CB_VA01` で失敗する事態を防ぎ、合格親だけを確実に書き込みます。

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
- 組み込み制約（必須・文字列長・数値範囲・選択肢・数値精度）の既存違反は、update 分岐では post-image 検証で事前に検出・隔離されます（v3.9.0・B43）。一方、kintone APIが書き込み時に返す権限・競合・一意制約・ユーザー実在性などの実行時エラーは隔離せず、従来どおりfail-fastです

---

## 17.3 CHECK（カスタムチェック・v3.4.0）

`INSERT` / `UPSERT` / `UPDATE` のソースの後、処分節（`VALIDATE ONLY` / `ON ERROR SKIP`）の前に `CHECK` ブロックを置くと、ユーザー定義の行レベル業務ルールで不正行を `#err`（`$err_code = ERR_CHECK`）へ隔離できます。

```sql
INSERT INTO APP123 (数値1, 数値2, 数値3)
SELECT 数値1, 数値2, 数値3 FROM APP999
CHECK
  WHEN 数値1 IS NULL THEN '数値1 未入力エラー'
  WHEN 数値1 > 数値2  THEN '数値1=' || 数値1 || ' が 数値2=' || 数値2 || ' を超過'
CHECK
  WHEN 数値3 > 100 THEN CONCAT('数値3 が上限超過: ', 数値3)
ON ERROR SKIP INTO #err;
```

- **グループ＝先勝ち**：1 つの `CHECK` ブロック内は上から評価し、最初に該当した `WHEN` のメッセージだけを 1 件出します。`CHECK` ブロックを複数並べると互いに独立に評価します（関連チェックは同じブロック＝最初のエラーのみ、無関係チェックは別ブロック＝それぞれ）。
- **参照は読み取り行**：
  - `INSERT` / `UPSERT … SELECT` は元 SELECT の出力列（別名可）。**先頭 N 列が書き込み対象、残りの末尾列は CHECK 専用**（`CHECK` を付けるとき SELECT 出力名は一意にする）。
  - `… VALUES` は挿入列。
  - `UPDATE` は**更新前の既存値**（書き込む新値を検査したいときは SET 式を書く：`SET 数量 = 数量 - 出庫数` に対し `WHEN 数量 - 出庫数 < 0`）。
  - `UPDATE … FROM` は `APP<n>.列`＝更新前ターゲット・`<ソース別名>.列`＝ソース新値で識別（`WHEN s.金額 < APP100.金額 THEN '減額不可'`）。ソース列を修飾なしで参照するとエラー。
- メッセージは `||` / `CONCAT` でフィールドや `@var` を補間できます。**条件（`WHEN`）では `||` は使えません**（`CONCAT` を使う）。
- 処分：`ON ERROR SKIP INTO #err` は該当行を隔離して残りを書き込み、`VALIDATE ONLY` は書かずに報告、処分節なしの素 DML は書き込み前に停止します。組み込み検証（必須・型・範囲・桁）とは独立に評価し、`#err` は組み込みエラー → カスタムエラーの順です。比較非対応の複合型を条件に使う等の評価不能は文全体エラー（行隔離しません）。サブテーブル DML には指定できません。`CHECK` は `CHECK WHEN` の並びのときだけキーワードになります（同名フィールドはバッククォート）。

## 17.4 VALIDATE（既存レコードの読み取り監査）

先頭の `VALIDATE` 文は、保存済みレコードへフォームの組み込み制約と任意の `CHECK` を適用する read-only 文です。DML 末尾の `VALIDATE ONLY` とは別文で、kintone の POST / PUT / DELETE API は呼びません。

```sql
VALIDATE APP100 (顧客コード, 明細(数量, 単価))
WHERE 作成日時 >= '2026-01-01'
CHECK WHEN 金額 < 0 THEN '金額が負です';

VALIDATE APP100 INTO #err;
SELECT $id, $err_field, $err_code, $err_message, $err_value,
       $err_subtable, $err_subrow, $err_subrow_id
FROM #err;

-- 大量違反は詳細行を作らず親×テーブル×フィールド×コードで集約
VALIDATE APP100 SUMMARY INTO #summary;
```

- `(fields)` 省略時は、制約を持つトップレベル／サブテーブル子フィールドと、トップレベル／子の全 `NUMBER` が対象です。テーブルコード単独はそのテーブルの監査可能な子すべて、`テーブル(子1, 子2)` は指定した子だけを選びます。裸の子コード、未知・所属違い・重複・監査対象外は取得前に拒否します
- 詳細出力は固定9列 `$id`, `$err_field`, `$err_code`, `$err_message`, `$err_value`, `$err_subtable`, `$err_subrow`, `$err_subrow_id`, `$err_count` です。同一レコードの違反を装飾前の元 message を含む `($id, $err_subtable, $err_field, $err_code, $err_message)` で集約し、`$err_count` に件数を文字列化して格納します。異なる元 message は別行です。出力は先頭出現順で、`$err_value` はグループ先頭の値を保持します。子違反の `$err_subrow` は全該当行の1-based表示序数、`$err_subrow_id` は同順の全永続行ID（各要素が仮想テーブルの `_rid` と同値）を、それぞれカンマ区切り・切り捨てなしで格納します（例: `"1,2"` / `"r10,r20"`）。サブテーブル違反かつ `$err_count >= 2` の出力 message には集約後に `（{count}行: {subrowリスト}）` を付けます（例: `文字列T2 は 3 文字以上で指定してください（2行: 1,2）`）。リストは `$err_subrow` と同一で、先頭出現順・切り捨てなしです。`$err_count=1` の子違反、トップレベル違反、`CHECK` 違反の message は従来どおりです。`INTO #err` にも装飾済み message を格納します。型メタは `$err_subrow=string`、`$err_count=number` です。トップレベル／`CHECK` のロケータ3列は空で、通常 `$err_count=1` です。0行テーブルでは子の必須違反は発火しません
- `SUMMARY` は `(fields)` 後・`WHERE` 前に置く soft keyword です。詳細行を生成せず、固定5列 `$id`, `$err_subtable`, `$err_field`, `$err_code`, `$err_count` へ直接集約します。SUMMARY はレコード横断の規模把握、詳細9列は message 別のレコード内訳と全該当行ロケータリストに使います
- 詳細／`SUMMARY` のどちらも、結果メタデータ `validateStats` に集約前の統計を返します。`errorRecords` は違反を1件以上持つ distinct `$id` 数、`errorCount` は集約前の違反総数で、結果行の `$err_count` 合計と一致します。違反0件でも両方を0で返します。さらに任意フィールド `constraintMetadata` は、実際の監査対象フィールドでメタデータに含まれていたフォーム制約種別を `present`、既知4種の差集合を `absent` で返します。種別は `required`（必須）、`length`（`minLength` / `maxLength`）、`range`（`minValue` / `maxValue`）、`choice`（`optionOrder`）で、この順に安定します。たとえば選択肢だけが渡された0件結果は `{ "errorRecords": 0, "errorCount": 0, "constraintMetadata": { "present": ["choice"], "absent": ["required", "length", "range"] } }` です。これは入力メタデータの観測事実であり、「アプリに制約が無い」「client が制約を落とした」という推測や警告ではありません。全4種が `absent` でも警告は返しません。`CHECK` と NUMBER の型・精度検証はこの4種に含みません。「0件」だけでなく「選択肢だけを検証対象にして0件」と検証範囲を併記することで、誤った安心を避けられます。プラグインは `エラー {errorRecords} レコード / {errorCount} 件（表示 {rowCount} 行）`、CLI の table／markdown は末尾サマリに `errorRecords=… errorCount=…` を表示し、JSON／MCP は `validateStats` を含めます。プラグインの `INTO #err` はテーブルの代わりに `VALIDATE: エラー {errorRecords} レコード / {errorCount} 件（#err へ {rowCount} 行）` を文位置へ表示します。`INTO #err` を使うバッチでも統計は VALIDATE 文自身の結果だけに付き、後続の汎用 `SELECT` には引き継ぎません
- `$err_code` 別などの内訳を再集計するときは、行数の `COUNT(*)` ではなく違反本数の `SUM($err_count)` を使います。サブテーブルの同一違反は1行へまとまり、その本数が `$err_count` に入るためです。たとえば KPI カードに `validateStats.errorCount`、隣の棒グラフに `$err_code` 別の `COUNT(*)` を置くと、同じ画面で合計が食い違って見えます。`VALIDATE APP100 INTO #err; SELECT $err_code, SUM($err_count) AS errorCount FROM #err GROUP BY $err_code;` のように集計してください
- `INTO #err` は複文バッチ専用です。詳細9列と SUMMARY 5列は別スキーマで、同名一時表への混在追記は解析時に拒否します。`tempTableMaxRows` はどちらも集約後行数へ適用し、超過時は部分結果を残さずエラーにします
- `WHERE` は通常比較、`BETWEEN`, リテラル `IN`, `IS NULL`, `LIKE` を使えます。`KLIKE`, サブクエリ, 修飾フィールド参照、サブテーブル子参照は使えません。`CHECK` もトップレベル参照だけです。安全な条件だけを取得時に押し下げ、取得後に元の条件全体を再評価します
- 完全な監査集合が必要なため、全 surface で `onLimit=truncate` を無効化して error にします。取得は通常 records API の offset + `$id` keyset paging で、Cursor API は使いません
- `EXPLAIN VALIDATE` はフォーム定義と、NUMBER 対象がある場合の数値精度だけを読みます。レコード API / mutation API は呼ばず、違反件数も算出しません

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

## 18.1 IMPORT（ファイル取込・v3.6.0）

CSV / JSON ファイルを、**射影・検証・不良行隔離・cli-kintone 互換**を備えて kintone アプリへ一括登録／更新する自己完結ステートメントです。既定では無効（capability gate off）で、**面がソースを名前で供給したときだけ有効**になります。SQL 本文にファイルパスは書きません（インジェクション防止・1 ソース最大 10 MiB）。

### 構文

```
IMPORT [UPDATE] INTO APP<n> ( <取込先> )
  FROM CSV|JSON <ソース名>
  [ENCODING UTF8|SJIS]                     -- CSV のみ（既定 UTF8）
  [NO HEADER [COLUMNS (col, ...)]]         -- CSV のみ
  [SELECT <式>, ...]                        -- CSV のみ（位置指定の代わりに射影）
  [BY NAME [IGNORE UNKNOWN COLUMNS]]        -- CSV のみ（ヘッダ＝フィールドコード）
  [MATCH RECORD NUMBER SOURCE <ヘッダ>]      -- IMPORT UPDATE 必須
  [ON DUPLICATE (キー, ...)]                 -- UPSERT
  [REPLACE SUBTABLES (サブテーブル, ...)]     -- CSV サブテーブルのみ
  [CHECK WHEN ... THEN ...]                 -- §17.3
  [VALIDATE ONLY [INTO #err] | ON ERROR SKIP INTO #err [REJECT LIMIT n]]   -- §17.1 / §17.2
```

`<取込先>` は `フィールドコード`、またはサブテーブル `サブテーブルコード(子1, 子2) [ROW ID SOURCE <ヘッダ>]`（`ROW ID SOURCE` は子列リストの閉じ括弧の**後**）。

### ソースの供給（面ごと）

| 面 | 供給方法 |
|---|---|
| CLI | `--import-csv <name>=<path>` / `--import-json <name>=<path>`（反復可・指定で gate ON） |
| MCP | 引数 `importSources: [{ name, text \| base64, encoding? }]`（inline・パス不可・指定で gate ON） |
| プラグイン | ヘッダーの「ファイルを選択」（ソース名＝拡張子を除去し、識別子に使えない文字を `_` に正規化。`sales.csv` → `sales`、`sales 2026.csv` → `sales_2026`） |

### CSV の取込

列の対応は 3 通り:

- **位置指定**（既定）: CSV 列を `INTO (...)` の順で対応。
- **射影 `SELECT`**: 取込前に式変換（`CAST` / 関数 / `||` / `@var`）。`FROM` / `JOIN` / `WHERE` / `GROUP BY` / `ORDER BY` / `LIMIT` / サブクエリ / 修飾参照は不可（純粋な式の並びのみ・列数は取込先と一致）。
- **`BY NAME`**: ヘッダ行をフィールドコードとして対応（cli-kintone 互換）。

```sql
-- 位置指定 + UPSERT
IMPORT INTO APP100 (顧客コード, 金額)
FROM CSV sales
ON DUPLICATE (顧客コード);

-- 射影で数値化
IMPORT INTO APP100 (顧客コード, 金額)
FROM CSV sales
SELECT code, CAST(amount AS NUMBER) AS 金額;

-- ヘッダ無し
IMPORT INTO APP100 (顧客コード, 金額)
FROM CSV sales NO HEADER COLUMNS (顧客コード, 金額);
```

- CSV は RFC 4180 準拠。`ENCODING` で UTF-8 / Shift_JIS、BOM 許容。

### JSON の取込

```sql
IMPORT INTO APP100 (顧客コード, 金額) FROM JSON payload;
```

- **厳密 10 進デコード**（字句を保持し、安全整数のみ数値化。精度が必要な NUMBER は JSON 側で文字列として渡す）。
- **全階層で重複キーを拒否**。`null` / 欠落 / 存在の区別あり。
- JSON は UTF-8 固定（`ENCODING` 不可）。射影・`BY NAME`・`NO HEADER` は CSV 専用。

### cli-kintone 互換（`BY NAME` ・レコード番号 UPDATE）

`cli-kintone record export` の CSV をそのまま戻せます。

- `BY NAME`: ヘッダをフィールドコードとして対応。**書込み不可の既知列**（`$id`・作成者・更新日時など）は監査ログを残して無視、**未知列**は既定で拒否（`IGNORE UNKNOWN COLUMNS` で無視）。複数値フィールドはセル内改行（LF）で分割。
- `IMPORT UPDATE … MATCH RECORD NUMBER SOURCE <ヘッダ>`: レコード番号で既存レコードを**純 UPDATE**（INSERT 0・番号は照合専用で書き換えない）。`ON DUPLICATE` とは併用不可。

```sql
IMPORT UPDATE INTO APP100 (金額)
FROM CSV exported BY NAME
MATCH RECORD NUMBER SOURCE `レコード番号`;
```

### サブテーブルの取込

意味論はソース種別で異なります。

- **JSON（ネスト配列）**: 新規 INSERT / `ON DUPLICATE` UPSERT。行 ID を持たず、親内のサブテーブルは**全置換**（再採番）。`ROW ID SOURCE` は不可。
- **CSV `*` 形式**（cli-kintone export）: **`IMPORT UPDATE` 専用**。`BY NAME` ＋ `MATCH RECORD NUMBER SOURCE` ＋ `REPLACE SUBTABLES (...)` ＋ 各サブテーブルの `ROW ID SOURCE <ヘッダ>` が必須。行 ID を保持して更新し、ソースに無い行は削除。

```sql
-- JSON: 明細を持つレコードを新規登録
IMPORT INTO APP100 (顧客コード, 明細(品名, 数量)) FROM JSON payload;

-- CSV *: 既存レコードの明細を全置換更新
IMPORT UPDATE INTO APP100 (明細(品名, 数量) ROW ID SOURCE `明細_行ID`)
FROM CSV exported BY NAME
MATCH RECORD NUMBER SOURCE `レコード番号`
REPLACE SUBTABLES (明細);
```

- **破壊的全置換（JSON のネスト配列／CSV の `REPLACE SUBTABLES`）は、削除内訳を確認表示できる面でのみ実行**（fail-closed）。プラグインは確認ダイアログに増減サマリを表示します。JSON UPSERT も既存の子行を削除して全置換します（`REPLACE SUBTABLES` は書かない・書くと構文エラー）。
- **MCP はサブテーブル mutation を常に fail-closed**（削除内訳を対話承認できないため）。サブテーブル書込みは CLI / プラグインで行い、MCP は `ksql_query` の `VALIDATE ONLY`／`ksql_explain` の `EXPLAIN` まで。

### 検証・チェック・隔離

`VALIDATE ONLY`（§17.1）・`ON ERROR SKIP INTO #err`（§17.2）・`CHECK`（§17.3）を DML と同じ意味論で利用できます。なお §17.1 は一般 DML では「サブテーブル DML 非対応」ですが、**IMPORT のサブテーブルはその例外**で `VALIDATE ONLY` を実行できます（read-only のため全面で可）。

```sql
IMPORT INTO APP100 (顧客コード, 金額) FROM CSV sales BY NAME
CHECK WHEN 金額 < 0 THEN '金額が負です'
ON ERROR SKIP INTO #err REJECT LIMIT 100;
SELECT * FROM #err;
```

**MCP の振り分け**: フラット（親のみ）の書込み IMPORT は `ksql_mutate`、`VALIDATE ONLY`（read-only）は `ksql_query`、`EXPLAIN` は `ksql_explain`、サブテーブル mutation は Unsupported。

### 制限

- **添付ファイル（FILE）は非対応**（cli-kintone を使う）。
- **取込行数の上限 `maxRecords` は面・経路で異なる**（超過はサイレント切り捨てせず fail-closed）:
  - CLI = 既定 **500**（`--max-records` で拡張）。
  - プラグイン = 初期値 **3000**（UI で変更可）。
  - MCP = 通常の書込み mutation は `dmlMaxRows`（＋1）で解決、`ON ERROR SKIP` / `VALIDATE ONLY` は通常の runtime `maxRecords` 解決に戻る。
  - **CSV サブテーブル置換**では、同じ `maxRecords` が取込親件数だけでなく**行 ID 所有権検査のための既存レコード全件走査**にも適用される。既定を超える既存レコードがあると、取込件数が少なくても fail-closed になる。
- **CSV のサブテーブルは UPDATE 専用**。新規登録は JSON。
- 標準スペース・ゲストスペースの両方で動作。

---

## 19. サブテーブル仮想テーブル

サブテーブルは `APP100$明細` 形式の仮想テーブルとして操作できます。

> **サブテーブルの `SELECT` は、親レコードを取得してから行へ展開します**（実測・v3.55.0）。
> **取得量は `WHERE` の内容で決まります。**
>
> ```
> SELECT COUNT(*) FROM APP100                        → fetch: COUNT_ONLY （1 リクエスト）
> SELECT COUNT(*) FROM APP100$明細                   → fetch: ALL        （親を全件取得）
> SELECT * FROM APP100$明細 WHERE _pid = 1           → fetch: ALL   （後述）
> SELECT * FROM APP100$明細 WHERE _p.$id in (1, 2)   → fetch: EXACT （親 2 件だけ取得）
> ```
>
> **親項目だけで書いた `WHERE`（`_p.` 修飾）は kintone へ押し下げます**（v3.55.0）。
> **押し下がらないのは次の 3 つ**で、いずれも親を全件取得します。
>
> - **明細項目の条件**（`数量 > 10` など）——行単位の条件で、親を絞る根拠にできません
> - **サブテーブル側のシステム列**（`_pid` / `_rid` / `_idx`）
> - **親項目と明細項目の混在**（`WHERE` 全体を変換できないため）
>
> **`COUNT(*)` だけでも親の取得が要ります。** kintone の `totalCount` は**親レコードの件数**で、
> **サブテーブル行を数える手段が API にありません**。行はレコードを取得してから展開します。
>
> **大きなアプリでは `maxRecords` に達してエラーになります。**
> **`_p.` で親を絞れる条件があるなら書いてください。** 無い場合は、親アプリ側の `SELECT` で
> 対象を絞ってからサブテーブルを扱う形（一時テーブル経由など）を検討してください。

> **明細項目を親アプリから参照したときの挙動**（実測・v3.56.1）。
> **`DESCRIBE` の `サブテーブル` 列が空でない項目**を、親アプリの `SELECT` に書いた場合です。
>
> **原理は 1 つです——値として出す位置なら「空 + 警告」、キーとして使う位置なら「エラー」。**
>
> | 書いた場所 | 結果 |
> |---|---|
> | 射影（`SELECT 数量`） | **空** + 警告 |
> | 集計（`MAX(数量)`） | **空** + 警告 |
> | `ORDER BY` | 並びに影響せず + 警告 |
> | `HAVING`（`MAX(数量) > 0`） | 空として評価され、**黙って 0 行**になる + 警告 |
> | `GROUP BY` | **エラー**（どの表から集計するか案内します） |
> | `ROLLUP` / `CUBE` / `GROUPING SETS` / `GROUPING()` | **エラー**（同上） |
> | `WHERE` | **kintone の API エラー**（`GAIA_IQ07`。kSQL の案内は出ません） |
>
> **`GROUP BY` 系だけがエラーなのは、その項目を「行の同一性」に使うため**です。値は常に空なので、
> **全レコードが 1 グループへ畳まれ、結果そのものが無意味**になります。
> 値として出すだけの位置は、**空を出せば処理が成立する**ので警告にとどめています
> （エラーにすると既存の SQL が壊れるため）。
>
> **とくに `HAVING` は見分けが付きません。** `GROUP BY` 系は止まり、射影は空の列が見えますが、
> **`HAVING` は「行が無い」だけ**で、**分析としては正当な「該当なし」と区別が付きません**。
> 0 行が返ったときは、**警告が出ていないかを必ず確認してください**。
>
> **`WHERE` だけは kSQL が判定せず、kintone 側のエラーになります。**
> メッセージは「テーブルに設定している場合、…演算子を使用できません」で、
> **サブテーブルの項目だとは読めますが、どう直すかは示されません**。
> `APPn$<サブテーブル>` から書き直してください。

### システム列

| 列名 | 意味 | 比較型 |
|------|------|------|
| `_pid` | 親レコード ID（`$id`） | 数値 |
| `_rid` | サブテーブル行 ID | 文字列 |
| `_idx` | 親レコード内の行順（0-based） | 数値 |

- システム列は SELECT の `WHERE` / `ORDER BY` で参照でき、全比較演算子・`BETWEEN` / `IN` / `IS NULL` / `LIKE` に対応します（サブテーブル SELECT は常にローカル全件評価のため kintone へは押し下げません）。
- 比較型は上表のとおりで、`_pid` / `_idx` は数値、`_rid` は不透明な文字列として比較します（例: `_idx > 2` は数値順、`_rid` は辞書順）。
- 未保存行では `_rid` が空のため `_rid IS NULL` が真になります。
- 親項目ショートカット経由の `_p._pid` 等（システム列を `_p.` 修飾した形）は無効です。

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

## 19.1 APPLY ブロック（テーブル外・内の同時更新）

`UPDATE` / `INSERT` / `UPSERT` に `APPLY` ブロックを付けると、**親（テーブル外）項目とサブテーブル（テーブル内）行を1文＝1 PUT レコードで同時に更新**できます。kintone は書き込み時にレコード全体を再検証するため、テーブル内に既存違反があるとテーブル外項目だけの `UPDATE` も失敗しますが、`APPLY` で違反セルへ妥当な値を同時にセットしてレコード全体を valid 化する「修復書き込み」が可能になります。

```sql
UPDATE APP100
SET ステータス = '確定'
WHERE $id = 5
APPLY 明細 (
  PATCH SET 数量 = 0 WHERE 数量 < 0;     -- 既存行のセル更新
  APPEND (商品コード, 数量) VALUES ('A-001', 1);  -- 行追加
  REMOVE WHERE 廃番 = 'true'            -- 行削除
)
```

### 操作

| 操作 | 意味 |
|------|------|
| `PATCH SET … {WHERE 行条件 \| ALL ROWS \| _idx = n \| _rid = 'id'}` | 既存行のセル更新（行 id・行順・未指定セルを保持） |
| `APPEND (子…) VALUES (…)` | 行追加（未指定の子は既定値で明示補完） |
| `REMOVE {WHERE 行条件 \| _idx = n \| _rid = 'id'}` | 行削除（存続行は全列を保持） |

- **多値フィールド**（`CHECK_BOX` / `MULTI_SELECT` / `USER_SELECT` 等）: `APPLY <多値> (ADD '値'; REMOVE '値')`。
- 1文に複数テーブル／多値の `APPLY` ブロックを併記できます。

### 行アドレッシング・行数表明

- 行セレクタ: `ALL ROWS`（**明示必須**）・`WHERE 行条件`・`_idx`（0-based）・`_rid`（行 ID）。
- `EXPECT ROWS n | BETWEEN a AND b | AT LEAST n | AT MOST n` で対象行数を表明でき、不一致は書き込み前に `ArgumentError`。

### 意味論・安全ルール

- **スナップショット意味論**: セレクタと右辺は更新前スナップショットで評価し、同一文内の `APPEND` 行は同文の `PATCH`/`REMOVE` から見えません。
- **post-image 検証**: 変異後のレコード全体を書き込み前に検証し、違反は行ロケータ付きで報告します。
- **複数親**: 親 `WHERE` が複数レコードに一致する `UPDATE APPLY` に対応（1対象親=1 PUT・100件/チャンク・**非トランザクション**・自動リトライなし・部分成功あり）。`INSERT APPLY`（親作成＋初期行）・`UPSERT APPLY`（`ON INSERT` / `ON UPDATE` 分岐）も可。
- **ガード**: revision ガード必須。`dmlMaxRows`（親件数）と `dmlMaxSubtableRows`（変更子行数・既定500）の二重ガード。プラグインは「最大取得件数」設定を両ガードへ兼用します。
- **MCP**: すべての `APPLY` mutation は実行前に fail-closed（`allowDml` / `dmlMaxSubtableRows` でも解禁されません）。`VALIDATE ONLY` / `EXPLAIN` は許可。

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
| `(SELECT ...)` | WHERE 右辺・SELECT 列・HAVING 右辺 | スカラーサブクエリ（1 行 1 列。GROUP BY なしの集計は 0 件でも 1 行を返す。**戻り値は関数ごと** — §8） |

**共通制約:**
- **非相関のみ対応** — 外側テーブルのフィールドをサブクエリ内で参照することはできません
- すべて FULL_SCAN モードで実行されます
- サブクエリ自体も SIMPLE / FULL_SCAN を自動判定します
- サブクエリは 1 回だけ実行され、全行に同じ結果が適用されます

---

## 22. 制限事項

### 正規表現の適用限界

`REGEXP_LIKE` / `REGEXP_REPLACE` / `REGEXP_SUBSTR` に安全性ゲートや実行時間制限はありません。ReDoS で同期処理が暴走すると kSQL 自身からは中断できません。プラグインはタブ強制終了、CLI は Ctrl+C、MCP はプロセス再起動で復旧します。プラグインでは同じタブの未保存編集と SQL、MCP では同一プロセスの全リクエストを巻き込みます。

ECMAScript 正規表現はホストのブラウザ／Node とその版に依存します。`\p{}`、Unicode モードと `i` の case folding、新構文の受理可否などは同じ SQL でも面ごとに異なる場合があります。結果を `UPDATE SET` または一時テーブル経由の `UPDATE ... FROM` で保存すると、その差が保存データへ残るため、書き戻し環境を固定して事前確認してください。

### サポートしていない構文

| 機能 | 状況 |
|------|------|
| 相関サブクエリ | 非対応（非相関 IN/EXISTS は対応） |
| INTERSECT / EXCEPT | 非対応 |
| 再帰 CTE | 非対応 |
| FULL OUTER JOIN | 非対応 |
| UPDATE の汎用 JOIN | 非対応（`UPDATE ... FROM` の `$id`／文字列（1行）／数値キーによる単一等値のみ対応） |
| トランザクション | kintone API の制約により非対応（バッチ実行も非アトミック） |
| DML を含むバッチ（複文） | 対応（`ksql_mutate` / CLI `--allow-dml` / プラグインは文ごとの確認ダイアログ。常に fail-fast。→ [§25](#25-バッチ実行と一時テーブル)） |
| 一時テーブルへの DML | 非対応（`CREATE TEMP TABLE ... AS SELECT` / `DROP TEMP TABLE` のみ） |
| `ASSERT` の複合条件（`AND` / `OR`） | 非対応（複数の `ASSERT` 文に分けて書く。→ [§26](#26-assert)） |
| バッチ変数の高度な利用 | `SET @x = (SELECT ...)`、`DECLARE @x = default`、SELECT 定数列 `@x AS alias`、文字列配列 `SET @list=['A','B']` と `IN @list`、CLI/MCP 外部注入に対応。`NULL` 代入・サブクエリ結果への算術は現時点で非対応（→ [§25 バッチ変数](#25-バッチ実行と一時テーブル)） |
| 書き込み系 API（POST / PUT / DELETE）の自動リトライ | 非対応（応答喪失時の二重実行を避けるため。リトライは GET 系限定 — 対象: 408/429/502/503/504。必要なら呼び出し側で冪等な再実行（UPSERT 等）を設計する） |
| `DELETE` での `APP@profile`（CLI 拡張） | 未対応（`ArgumentError: @profile is not supported for DELETE yet.`） |
| **プロセス管理のステータス・作業者の UPDATE** | **対象外**（`/k/v1/records/status.json` が必要なため） |

### 実行モード

kSQL は以下の条件に応じて自動的に実行モードを切り替えます。

| 条件 | モード |
|------|--------|
| JOIN なし、GROUP BY なし、DISTINCT なし、WHERE/ORDER BY に関数・算術式なし | **SIMPLE候補**（型×演算子能力とORDER plannerで最終決定） |
| JOIN あり / GROUP BY あり / DISTINCT / WHERE に関数・算術式・CASE WHEN / ORDER BY に算術式 | **FULL_SCAN**（JS 処理。JOIN の安全な単一 alias 述語など、対応する prefilter は records API へ押し下げる） |
| WHERE に IN (SELECT) / EXISTS / NOT EXISTS / スカラーサブクエリ | **FULL_SCAN** |
| SELECT 列にスカラーサブクエリ | **FULL_SCAN** |
| SELECT 列にウィンドウ関数 | **FULL_SCAN** |
| UNION / UNION ALL | **FULL_SCAN** |
| WITH 句（単純 CTE）— インライン化される | **SIMPLE**（kintone クエリに変換） |
| WITH 句（GROUP BY ありの CTE・複数 CTE・CTE JOIN） | **FULL_SCAN** |

FULL_SCAN モードは大量レコードの場合、時間がかかります。

### 取得件数の上限

- エンジン既定値: **10,000 件**
- CLI 既定値: **500 件**（`--max-records` で変更可能）
- JOIN / GROUP BY / DISTINCT は client 側処理のため大量データでは時間がかかります。INNER JOIN の対応述語は各 APP へ押し下げて取得件数を減らしますが、押し下げられない APP は全件取得します
- ローカル`ORDER BY`で上限に達した場合、`truncate`設定でも誤ったtop-Nを返さずエラーになります

### 算術は浮動小数点（IEEE 754 倍精度）

- 算術式・数値リテラル・集計（SUM/AVG）は倍精度浮動小数点で評価します。小数の表現誤差（`3000 * 1.1` = `3300.0000000000005`）・有効桁 15〜17 桁・**空セル= 0 扱い**の制約があります。詳細と回避策は §3「算術の精度と空セル」を参照してください
- 取得した数値そのものは文字列のまま保持するため、算術を通さなければ桁落ちしません

### JOIN の等値結合のみ対応

```sql
-- OK: 等値結合
ON a.顧客ID = b.顧客ID

-- NG: 範囲結合・不等値結合は非対応
ON a.金額 > b.下限金額
```

### INSERT / UPDATE の値

文字列・数値（`-5` / `+5` のような符号付き数値を含む）・配列リテラル `[...]` が指定可能です。INSERT / UPSERT VALUES の符号直後は数値リテラルだけ、UPDATE SET の単項 `+` も数値リテラル直前だけです。
ユーザー選択・組織選択・グループ選択・チェックボックス・複数選択フィールドへの書き込みをサポートします（フィールド型を `getFields()` で自動取得して変換）。

以下は引き続き非対応です:

| フィールド型 | 状況 |
|---|---|
| 添付ファイル（FILE） | バイナリ送信が別 API のため非対応 |
| CREATOR / MODIFIER | kintone API で更新不可 |
| SUBTABLE | 仮想テーブル経由（`APP100$明細`）で操作 |

### LIKE の挙動

LIKEはワイルドカードの有無にかかわらず常にJavaScriptで評価し、kintoneへ押し下げません。ワイルドカードなしはkSQL独自の部分一致（`includes`）です。通常の親レコードDMLではLIKEを使用できません（**例外**: v3.10.0 以降、APPLY 複数親 `UPDATE` の親 WHERE では LIKE を使用できます＝安全プレフィルタで取得後に元 WHERE を JS 再評価します。通常の親 UPDATE/DELETE では KLIKE のみ使用でき LIKE は使用できません）。詳細は「LIKE / NOT LIKE（部分一致・除外）」を参照してください。

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

`EXPLAIN` を先頭に付けると、schema-awareな実行計画を表示します。フォーム定義と、canonical STATUS順に必要な場合だけプロセス状態定義を読みます。レコード取得・書き込みAPIは呼びません。

```sql
EXPLAIN SELECT * FROM APP100 WHERE ステータス = '完了'
EXPLAIN UPDATE APP100 SET 状態 = '完了' WHERE $id = 1
EXPLAIN DELETE FROM APP100 WHERE $id = 1
EXPLAIN INSERT INTO APP100 (顧客名) VALUES ('A社')
EXPLAIN UPSERT INTO APP100 (顧客コード, 顧客名) VALUES ('C001', 'A社') ON DUPLICATE (顧客コード)
EXPLAIN REORDER APP100$明細 BY 商品コード ASC WHERE _pid = 1
EXPLAIN VALIDATE APP100
EXPLAIN IMPORT INTO APP100 (顧客コード, 顧客名) FROM CSV customers BY NAME
```

### サポート対象

- `SELECT` / `WITH` / `INSERT` / `UPDATE` / `DELETE` / `UPSERT` / `REORDER` / `VALIDATE` / `IMPORT`

### 制約

- `EXPLAIN SHOW APPS` など、上記以外の文は非対応です
- `EXPLAIN CREATE TEMP TABLE ... AS SELECT ...` は非対応です。`AS` 以降の
  `SELECT`（または `WITH`）を単体で `EXPLAIN` すると、同じ取得・JOIN 計画を確認できます
- 実データの取得・更新は行いません（metadata APIのみ）
- 対象アプリのフォーム定義を読める権限が必要です。schema取得に失敗した場合、推定SIMPLEとして成功させず元の認証・通信エラーを返します
- `order plan`は`CANONICAL_LOCAL`／`CANONICAL_REST_TOP_N`／`KORDER_NATIVE`を表示します
- **`EXPLAIN` は `warnings` を返しません**（常に空配列）。**実行時の警告は実行しないと出ません**——
  ウィンドウの既定フレーム（`RANGE`）や `ORDER BY` が全順序でない旨の警告は、
  計画上は `frame:` / `window ...:` の行に現れますが、**`warnings` には入りません**。
  **「`EXPLAIN` が通ったから警告は無い」とは読めません。**

### 出力の読み方

計画は次の 3 つの問いに答えます。**どの行を読むかは、知りたいことで決まります。**

| 知りたいこと | 読む行 |
|---|---|
| **kintone から何件取りに行くか** | `fetch:`（ソースごと）／`fetch summary:`（文ごと） |
| **途中で止まらないか** | `complete input:`／`search abort:`／`onLimit=truncate:` |
| **どの条件が押し下がったか** | `kintone query:`／`pushdown applied:`／`pushdown candidate:`／`relation:` |

#### ⚠ `mode:` は取得量ではありません

`mode:` は**エンジン内部の評価戦略名**です。`FULL_SCAN` は「取得したレコードを
JS で全行評価する」という意味で、**「全件取得する」という意味ではありません。**

**`GROUP BY` や集計を含むクエリは、絞り込みが効いていても `FULL_SCAN` になります。**
取得量は `fetch:` の行で判断してください。

```
mode:          FULL_SCAN
kintone query: 確度 in ("A")
fetch:         PREFILTERED (未確定)      ← 絞り込みは効いている
```

#### `fetch:` — そのソースから何を取りに行くか

| 値 | 意味 |
|---|---|
| `NONE` | **kintone から取得するソースが無い文**です（一時テーブルだけを参照する文など）。この値は構造化された `plan` にのみ現れ、テキストでは `fetch:` / `fetch summary:` を表示しません |
| `COUNT_ONLY` | **レコードを走査しません**（`COUNT(*)` を `totalCount` の単発 GET で解く場合など）。件数に関係なく **1 リクエスト**で、転送されるのは `limit 1` の 1 件だけです（`metrics.fetchedRows` は 1）。**サブテーブル仮想テーブルの `COUNT(*)` はこれになりません**（`totalCount` は親レコードの件数のため。→ [§19](#19-サブテーブル仮想テーブル)） |
| `EXACT` | `WHERE` 全体を kintone 側で絞り込み、**JS での追加評価はありません** |
| `PREFILTERED` | **一部の述語だけ**を kintone 側で絞り込み、残りは JS で評価します |
| `ALL` | **全件取得**します |

接尾辞が付くことがあります。

- `(limit N)` — 押し下げたクエリが `limit` を伴います（上位 N 件・`KORDER BY` など）
- `(未確定)` — **実行時の型・選択肢の実在確認で、絞り込みが落ちる可能性があります。**
  落ちた場合は全件取得になります

**`fetch summary:` は文全体の最悪値**です（`NONE` < `COUNT_ONLY` < `EXACT` < `PREFILTERED` < `ALL`）。
kintone から取得するソースが 1 つも無い文（一時テーブルだけを参照する文など）では出ません。

> **同じ `WHERE` でも、クエリの形が違えば `fetch` の値は変わります。**
>
> ```
> SELECT COUNT(*) FROM APP100 WHERE 担当者 in ('user1')
>   → COUNT_ONLY  （押し下げは効いているが、走査しないので COUNT_ONLY が優先される）
>
> SELECT 区分, COUNT(*) FROM APP100 WHERE 担当者 in ('user1') GROUP BY 区分
>   → PREFILTERED （同じ WHERE・同じ押し下げ。走査するので PREFILTERED）
> ```
>
> **押し下げが効いているかを比べるときは、すべて同じ形で測ってください。**
> 形を混ぜた表を作ると、**押し下げの差ではなく形の差**を読んでしまいます
> （`COUNT_ONLY` の行だけ `SELECT COUNT(*)` で測る、など）。

#### 取得のされ方はソースごとに違います

`JOIN` や `UNION` では、**同じクエリの中でソースごとに取得のされ方が変わります。**
だから `fetch:` はソース単位（`app:` / `JOIN:` / `[union:n]` / CTE）で出ます。

```
[union:1]
  mode:          COUNT_TOTAL_COUNT
  fetch:         COUNT_ONLY (limit 1)  ← 1 件だけ転送し、走査しない

[union:2]
  mode:          FULL_SCAN
  fetch:         ALL                   ← 全件取得
```

#### 安全側に倒しています

分類に迷いがある場合は、**より多く取得する側**（`EXACT` より `PREFILTERED`、
`PREFILTERED` より `ALL`）を表示します。「絞り込み済み」と表示して実際は全件だった、
という誤りを避けるためです。

#### 機械的に読む場合

**計画本文の文字列を解析しないでください。**engine ライブラリでは
`explainQuery()` の結果の `plan` に同じ内容が構造で入ります
（→ [エンジン・ライブラリ利用ガイド](ksql_engine_library.md)）。

`fetch:` / `fetch summary:` / `mode:` / `kintone query:` は安定した読みどころですが、
**それ以外の診断行は実装の詳細**であり、予告なく増減します。

---

## 25. バッチ実行と一時テーブル

> **CLI（`-e` / `-f` / `--console`）、MCP（`ksql_query` / `ksql_validate` /
> `ksql_mutate` / `ksql_explain`）、engine ライブラリの `runBatch()` で利用可能**です。
> プラグイン UI もバッチに対応し（DML を含むバッチも実行可能）、最後に結果セットを
> 返した文（通常は最終 SELECT）だけを表示します。詳細仕様は
> [ksql_batch_temp_table_spec.md](internal/ksql_batch_temp_table_spec.md) を参照してください。
>
> **リラン可能な差分更新バッチの設計パターン**（ステータス駆動・件数ゲート・スナップショット・バッチ変数の活用）は [ksql_batch_recipes.md](ksql_batch_recipes.md) にまとめています。

### engine ライブラリで利用できる構文

| API | 構文 |
|---|---|
| `runQuery()` | 単文の `SELECT` / `WITH` / `UNION [ALL]` / `SHOW APPS` / `DESCRIBE` / `DESC` / 既存レコード `VALIDATE` |
| `runBatch()` | 上記、`CREATE TEMP TABLE ... AS SELECT/WITH` / `DROP TEMP TABLE` / `SET` / `DECLARE` / `ASSERT` / `EXPLAIN` |
| `explainQuery()` | 単文の `SELECT` / `WITH` / `UNION [ALL]` |

engine ライブラリは read-only 専用です。書き込み DML、DML `VALIDATE ONLY`、
`IMPORT`、`APPLY` は受け付けません。`runBatch()` は文が1つでも失敗したら throw し、
部分結果を返しません。成功結果に `ok` フィールドはなく、失敗した文は error の
`statementIndex` / `statementType` で特定します。これは部分結果が完全な結果として
アプリケーションロジックへ流れ込む事故を防ぐためです。

`results[]` の各 `metrics` は文別計測ではなく、同一の**バッチ全体集計値**です。
文ごとの性能コストとして解釈しないでください。API と型の詳細は
[エンジン・ライブラリ利用ガイド](ksql_engine_library.md)を参照してください。

### 複文（バッチ）

`;` 区切りで複数の SQL 文を1回の呼び出しで**順次**実行できます（最大 20 文）。

```sql
SELECT 部門 FROM APP100;
SELECT 部門 FROM APP200;
```

- read-only 文のみのバッチは `ksql_query` / CLI / プラグインがそのまま実行します。**DML を含むバッチ**は `ksql_mutate`（`dmlMaxRows` は文ごと + 任意の `dmlTotalMaxRows` で合計ガード）、CLI `--allow-dml`（確認プロンプトはバッチ全体で1回、`--yes` でスキップ）、またはプラグイン（文ごとの確認ダイアログ）で実行します。DML バッチは常に fail-fast です
- SELECT-based DML（`INSERT INTO APPxxx ... SELECT` / `UPSERT INTO APPxxx ... SELECT ... ON DUPLICATE`）のソースは **APP・一時テーブル・両者の混在（JOIN・サブクエリ）のいずれも指定できます**。件数には書き込み前の確認で `dmlMaxRows` が適用され（UPSERT は insert + update の**合計**）、超過時は当該文ゼロ書き込みでエラーになります
- SELECT-based DML の読み取り上限はソース種類ごとに異なります: **APP ソースの読み取りは `maxRecords` の通常解決値（`KSQL_MAX_RECORDS` / profile の `query.maxRecords`、既定 500 件）**（超過は書き込み前の安全側エラー。JOIN の APP 側も同様。`dmlMaxRows` は影響行数ガード専用で読み取りを絞りません）、**一時テーブルは実体化上限 既定 10,000 行（`tempTableMaxRows` で変更可）**。UPSERT 系では書き込み先アプリへの既存レコード照合読み取りが**ソース種類に関わらず**発生します（一時テーブルに実体化しても回避されません）
- 実行前に全文を検証し、1文でも不正ならバッチ全体を拒否します（validate-all-first）
- 既定は fail-fast（エラー文以降はスキップ）。`--continue-on-error`（CLI）/ `continueOnError`（MCP）でエラー後の続行を選べます
- 結果は文ごとに `success` / `error` / `skipped` として報告されます

### 一時テーブル

`CREATE TEMP TABLE #名前 AS SELECT ...` で SELECT 結果をバッチ内に実体化し、後続の文から `FROM` / `JOIN` / サブクエリで参照できます。

source は `SELECT` と `WITH` のどちらでも、その SELECT の `WHERE` 全体を kintone クエリへ exact に押し下げられる場合に相対日付関数を使用できます。物理アプリ同士の INNER JOIN も、JOIN の全入力が alias 付き物理 APP で第5-W / 第5-L を満たせば、server-only 関数で絞ってから実体化できます。

一方、**入力に一時テーブルが1つでもあれば文全体が server-only 関数の対象外**です。
関数を一時テーブルの列へ書かなければよい、という意味ではありません。JOIN 相手の
物理アプリ側へ関数を置いても `..._CONTEXT_UNSUPPORTED` で拒否されます。

```sql
-- OK: 物理アプリ同士を JOIN し、関数で絞ってから実体化する
CREATE TEMP TABLE #当月 AS
  SELECT d.顧客No AS k, d.売上, c.業種
  FROM APP100 d INNER JOIN APP200 c ON d.顧客No = c.顧客No
  WHERE d.受注日 = THIS_MONTH();

-- NG: 実体化後。一時テーブルが入力にあるため、関数を物理 APP 側へ置いても拒否
CREATE TEMP TABLE #x AS
  SELECT 顧客No, 受注日 FROM APP100;
SELECT *
FROM #x a INNER JOIN APP200 c ON a.顧客No = c.顧客No
WHERE c.受注日 = THIS_MONTH();
```

一時テーブルは利用者アプリのプロセス内メモリへ実体化されます。1表の上限は
`tempTableMaxRows`（既定10,000行）で、超過は `truncate` 指定でも error です。
同時に存在できるのは最大16表で、`DROP TEMP TABLE` すると同じバッチ内で枠を再利用できます。

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

> **注意**: 上記の `MAX(受注日)` は、`APP300` のフォーム定義から DATE 型を解決して最新日を返します。一時テーブル/CTEへ型メタが伝播するため、`SELECT MAX(最新受注日) FROM #latest` のような再集約でも日時の辞書順比較を維持します（前掲の集計関数の比較規則を参照）。

| 規則 | 内容 |
|---|---|
| 名前 | `#` + 識別子（例: `#temp` / `#集計`）。`#` は一時テーブル名の先頭のみで有効。エイリアスには使用不可 |
| 寿命 | **バッチ内のみ**。呼び出し終了で自動破棄（呼び出しをまたぐ参照は不可） |
| 破棄 | `DROP TEMP TABLE #名前`（主にメモリの早期解放用。DROP 後の同名再 CREATE は可） |
| 上限 | 同時 16 個・1個あたり既定 10,000 行（超過は常にエラー）。通常の取得上限 `maxRecords` ではなく専用の `tempTableMaxRows` で変更可能（MCP ツール引数 / CLI `--temp-table-max-rows` / env `KSQL_TEMP_TABLE_MAX_ROWS` / profile `query.tempTableMaxRows` / プラグインは「⚙ オプション → 取得」の「一時テーブル上限(行)」。空欄 = 既定）。変更しても超過時は truncate されず常にエラーで、日付リテラルと相対日付で扱いは同一 |
| DML | 一時テーブルへの INSERT / UPDATE / DELETE は非対応 |
| 実行 | 参照は常にインメモリ FULL_SCAN（kintone クエリへの WHERE プッシュダウンは効かない） |

### コンソール（`--console`）での入力

- 単文は従来どおり行末 `;` で実行されます
- `CREATE TEMP TABLE` で始まる入力は**バッチ構築モード**になり、`;` では実行されず **`:run`** でバッファ全体をバッチ実行します（破棄は `:clear`）

### プラグインでの DML バッチ

プラグイン UI でも DML を含むバッチを実行できます。

- DML 文は**文ごとの確認ダイアログ**（文番号 `[N/M]`・書き込み先アプリ・確定件数付き）で書き込み直前に確認します
- `INSERT INTO ... VALUES` は静的に件数が確定するため、**バッチ実行前**にまとめて確認します（キャンセル時は 1 文も実行されません）
- 実行時確認をキャンセルした場合は文 `[N/M]` で中断し、それ以前の文の実行結果は反映済みのまま残ります（トランザクションなし）
- 成功した DML 文の影響件数はサマリ行（`[N] タイプ: inserted=... updated=...`）として結果の上に表示されます
- DML を含む実行（単文・バッチとも）では取得上限到達時の動作が UI 設定に関わらず **error に固定**されます（truncate だと SELECT-based DML のソース読み取りが黙って切り捨てられ、部分書き込みになるため）

### プラグインでの一時テーブル上限指定

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

### バッチ変数（`SET @var`）

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
| 構文 | `SET @名前 = <式>`。式は**リテラル**（文字列・数値）・**関数**（`NOW()` / `TODAY()` / 文字列・数値関数）・**数値算術**・**スカラーサブクエリ**（`(SELECT ...)`。下記）・**文字列配列**（`['A','B']` / `[]`）。`@名前` は英字か `_` で始まり英数字・`_`、64 文字以内。大文字小文字は区別しない |
| 参照できる位置 | スカラーは **WHERE 右辺の値** / **UPDATE の SET 値** / **ASSERT のオペランド** / **IN リストの要素**（`IN (@a,@b)`）/ **SELECT 定数列**（`@x AS alias`、AS 必須）。配列は全条件位置のカッコ無し **`IN @list` / `NOT IN @list`** だけ |
| 評価 | `SET` の実行時に**一度だけ**評価し、以後は定数（`SET @now = NOW()` はバッチ内で同じ時刻に固定。`NOW()` 自体の意味は変わりません） |
| 型 | 代入値から **string / number / string array** を決定。scalar/array の参照位置違反は全バッチ実行前に拒否。比較の型規則は WHERE と同一 |
| スコープ | **1 バッチ内のみ**（一時テーブルと同じ寿命）。バッチをまたがない |
| バッチ必須 | **2 文以上のバッチでのみ使用可**。単文の `SET`・単文での `@参照` はエラー |
| 静的検査 | **未定義参照・前方参照・再代入はエラー**（実行前に検出）。未使用は警告。`SET` の評価に失敗した場合は `continueOnError` に関わらずバッチを停止 |
| 上限 | 変数の防御上限は **64 個**。ただしバッチ全体の**最大 20 文**（§25 冒頭）が先に効くため、`SET` も 1 文ずつ数える現状の実効上限は **20 個以下** |
| 演算 | 式内の `+` は**数値加算**。文字列連結は `CONCAT()` を使う。**SET の右辺から別の変数は参照できません**（`SET @b = @a + 1` は不可） |
| 束縛 | 値としてバインド（文字列連結ではない）ため、**SQL インジェクションは発生しません**。変数に入るのは値のみで、アプリ ID・フィールドコード・演算子など識別子のパラメータ化はできません |

#### スカラー変数の配置詳細

上の「参照できる位置」は概要です。配置の文法境界は次の表を正とします。ID は parser と batch analyzer の特性化テストに一対一で対応します。

| ID | 使える配置 | 境界 |
|---|---|---|
| A01 | WHERE の比較右辺 | `列 >= @x` のように右辺の直接値として使える。VALIDATE WHERE、APPLY PATCH/REMOVE WHERE も同じ条件文法を使う |
| A02 | HAVING の比較右辺 | 集約結果との比較右辺に使える |
| A03 | CHECK WHEN 条件 | 比較右辺に使える。CHECK の評価行は §17.3 を参照 |
| A04 | CASE / IF 条件 | 条件内の比較右辺に使える |
| A05 | KLIKE 右辺 | `列 KLIKE @x` / `列 NOT KLIKE @x` のパターン値に使える |
| A06 | IN リスト要素 | スカラー変数を `IN (@a, @b)` の要素に使える |
| A07 | カッコ無し IN | 文字列配列変数だけを `IN @list` / `NOT IN @list` に使える |
| A08 | SELECT 定数列 | `SELECT @x AS alias`（AS 必須）でスカラー値を列として実体化できる |
| A09 | IMPORT SELECT 射影 | IMPORT の SELECT 射影でも `@x AS alias`（AS 必須）を使える |
| A10 | UPDATE SET 値 | 通常 UPDATE の SET 右辺の直接値に使える |
| A11 | UPDATE FROM SET 値 | UPDATE FROM の SET 右辺の直接値にも使える |
| A12 | ASSERT オペランド | 比較・BETWEEN の直接オペランドに使える |
| A13 | SET のスカラーサブクエリ内 | 先行変数を `(SELECT ... WHERE 列 = @a)` のように参照できる。外側の SET 式とは別扱い |
| A14 | SELECT 列の算術オペランド | `SELECT (売上 * 100) / @total AS 構成比` のように数値変数を直接使える |

| ID | 使えない配置 | 境界 |
|---|---|---|
| R01 | VALUES の直接要素 | INSERT / UPSERT / APPEND の `VALUES (@x)` は不可。VALUES が受理する CASE / IF の内部では条件・式に変数が入り得る |
| R02 | 件数・位置を表す固定数値句 | `LIMIT @n` / `OFFSET @n` は不可。EXPECT ROWS / REJECT LIMIT も変数化できない |
| R03 | 条件左辺・構造位置 | `@x = 列` は不可。GROUP BY / ORDER BY、アプリ ID・フィールドコード・演算子などの識別子位置にも置けない |
| R04 | 外側の SET / DECLARE 式 | `SET @b = @a / 2` と `DECLARE @b = @a` は不可。A13 の SET スカラーサブクエリ内だけが先行変数参照の例外 |
| R05 | ASCII 規則外の変数名 | 変数名は `@[A-Za-z_][A-Za-z0-9_]{0,63}`（最大 64 文字）で、名前は小文字へ正規化される。`@max金額` は `@max` と `金額` の 2 トークンに分かれ、変数名として受理されない |

SELECT 列ではフィールドまたは数値から始まる算術式のオペランドとして変数を使えます。条件の比較右辺を `@avg / 2` のような一般式にすること、既存変数から別の SET 変数を直接導出すること、VALUES の直接要素に置くことは引き続きできません。SET で派生値が必要なら元のスカラーサブクエリ内で同時に計算します。

#### スカラーサブクエリ代入 `SET @x = (SELECT ...)`

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

#### 外部パラメータ注入 `DECLARE @x = default`

```sql
DECLARE @since = '2026-01-01';
SELECT * FROM APP100 WHERE 登録日 >= @since;
```

- 未注入時は既定値を実行時に1回評価。CLI の `--var since=2026-07-01`、MCP `variables: { "since": "2026-07-01" }` で文字列値を上書きできる。注入時は既定値式を評価しない。
- プラグインでも `DECLARE` 文は実行できるが注入 UI はなく、常に既定値を使う。
- キーは `@` なし・大文字小文字を区別しない。未宣言キー、重複、不正名は API 呼び出しや DML より前にエラー。`SET` で定義した名前は注入対象にならない。
- 既定値はリテラル・`NOW()` / `TODAY()`・文字列/数値関数・数値算術。サブクエリ、別変数、`NULL`、`LOGINUSER()`、`PRIMARY_ORGANIZATION()` は不可。採用値は文字列として束縛する。
- `DECLARE` と使用文を含む2文以上のバッチが必要。値は EXPLAIN、結果メタデータに表示しない。CLI `--var` はプロセス一覧やシェル履歴に残り得るため秘密情報には使わない。

`RELATIVE_DATE` 注釈を付けると、文字列ではなく kintone の相対日付関数トークンを安全に束縛できます。

```sql
DECLARE @period RELATIVE_DATE = THIS_MONTH();
SELECT * FROM APP100 WHERE 受注予定日 = @period;
-- CLI: --var period="FROM_TODAY(-1, MONTHS)"
-- MCP / library: variables: { "period": "THIS_YEAR()" }
```

- `RELATIVE_DATE` は変数名直後・`=` の前だけで解釈する soft keyword です。既定値は必須です。
- 受け付けるのは日付系14個です: `TODAY()` / `NOW()` / `YESTERDAY()` / `TOMORROW()` /
  `FROM_TODAY(n, DAYS|WEEKS|MONTHS|YEARS)` / `THIS_WEEK([曜日])` / `LAST_WEEK([曜日])` /
  `NEXT_WEEK([曜日])` / `THIS_MONTH([日|LAST])` / `LAST_MONTH([日|LAST])` /
  `NEXT_MONTH([日|LAST])` / `THIS_YEAR()` / `LAST_YEAR()` / `NEXT_YEAR()`。
  引数は通常の WHERE 関数と同じ規則で検証し、トークンの前後に余分な字句は置けません。
  `LOGINUSER()` / `PRIMARY_ORGANIZATION()`、日付文字列、任意の式は使用できません。
- 使用位置は **WHERE の比較右辺**と **BETWEEN の境界**だけです。HAVING / CHECK / CASE・IF /
  KLIKE / IN / SELECT 定数列 / UPDATE SET / ASSERT / 算術には置けません。
- `RELATIVE_DATE` 変数は DML（`UPDATE` / `DELETE` / `INSERT ... SELECT` / `UPSERT`）と
  `VALIDATE` では fail-closed です。違反・不正な注入値は変数名を含むエラーで、API 呼び出し前に停止します。
  SQL に直接書いた相対日付関数の既存 DML 規則は変わりません。
- 注釈なし `DECLARE` は従来どおり、注入値を常に文字列として束縛します。

`TODAY()` は書く位置で評価主体が異なります。

| 書き方 | 束縛・押し下げ | 時刻・TZ の基準 |
|---|---|---|
| `DECLARE @p = TODAY(); ... WHERE 日付 = @p` | `"YYYY-MM-DD"` の文字列リテラル | kSQL 実行環境のホスト時計・ホスト TZ |
| `WHERE 日付 = TODAY()` | `TODAY()` のまま server へ押し下げ | kintone サーバー・利用者設定 |
| `DECLARE @p RELATIVE_DATE = TODAY(); ... WHERE 日付 = @p` | `TODAY()` のまま server へ押し下げ | kintone サーバー・利用者設定 |

#### SELECT 定数列と配列 IN

```sql
SET @batch = NOW();
SET @ranks = ['A', 'B'];
SELECT @batch AS バッチID, 顧客No FROM APP100 WHERE 顧客ランク IN @ranks;
```

- `@x AS alias` は文字列・数値だけ。配列は SELECT 列に置けない。`@x || field` は従来どおり一般スカラー式として扱う。
- `IN @list` は非空配列を通常の literal IN へ展開する。`IN (@x)` は従来どおりスカラー 1 要素で、配列展開ではない。
- 空配列は `IN @empty`=偽、`NOT IN @empty`=真として AND/OR/NOT/括弧を簡約する。SELECT の恒偽 WHERE はレコード API を呼ばず空入力を後段へ渡す。UPDATE/DELETE/非 ALL REORDER の最終 WHERE が恒真になる場合は全件更新防止のため実行前エラー、恒偽は 0 件 no-op。

**現時点で非対応（今後のフェーズ）**: `NULL` の代入・数値/混在配列・配列のサブクエリ代入・`IN (@list)` での配列展開・`SET` 右辺での別変数参照・スカラーサブクエリ結果への算術・関数引数への `NOW()` 直接指定・`LOGINUSER()`・`PRIMARY_ORGANIZATION()`。

> **`APP@profile` との併用**: `SET @now = NOW(); SELECT * FROM APP100@dev WHERE 作成日時 = @now` のように、`@profile`（アプリ指定）と `@変数` は同居できます（CLI / MCP が profile だけを先に正規化するため混同しません）。

### 注意

- **トランザクションはありません**。バッチも非アトミックです（DML バッチ対応後も、途中失敗時に前半のみ反映された状態が起こり得ます）
- MCP では `CREATE TEMP TABLE` の実体化結果は返却されません（`tempTable` 名と `rowCount` のみ）。中間結果をコンテキストに載せないための設計です

---

## 26. ASSERT

> 条件が成立しなければ `AssertError` で実行を止める**実行時ゲート**です。DML 前の件数ガードや CLI ヘルスチェック（exit code 監視）に使います。

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
- **GROUP BY なしの集計サブクエリは対象 0 件でも 1 行（COUNT は `0`）を返す**（§8「0 件時の挙動」）ため、上の CLI 例のような `ASSERT (SELECT COUNT(*) ... WHERE 異常条件) = 0` の健全性チェックが該当 0 件（健全時）に成立します。0 行エラーが起きるのは、非集計プローブの空振り（`SELECT フィールド FROM ... WHERE ...` が 0 件）や GROUP BY 付き集計が 0 行になる場合です

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
SELECT * FROM アプリ WHERE アプリ名 LIKE '受注%'

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
