# ksql v4 追加仕様

v4 では以下の機能を追加しました。

---

## 1. 数学関数

`ABS`・`MOD`・`POWER`（`POW`）・`SQRT` と剰余演算子 `%` を追加しました。

| 関数・演算子 | 構文 | 説明 |
|---|---|---|
| `ABS` | `ABS(フィールド)` | 絶対値 |
| `MOD` | `MOD(フィールド, 除数)` | 剰余（`%` 演算子と同等） |
| `POWER` | `POWER(フィールド, 指数)` | 累乗（`POW` も可） |
| `SQRT` | `SQRT(フィールド)` | 平方根 |
| `%` | `フィールド % 数値` | 剰余演算子 |

```sql
SELECT ABS(差額) AS 差額絶対値 FROM APP100
SELECT MOD(数量, 3) AS 余り FROM APP100      -- 数量 % 3 と同等
SELECT 数量 % 3 AS 余り FROM APP100
SELECT POWER(辺長, 2) AS 面積 FROM APP100
SELECT ROUND(SQRT(面積), 2) AS 辺長 FROM APP100
```

関数の結果は算術式・他の関数と組み合わせ可能です。

```sql
SELECT ROUND(SQRT(POWER(x, 2) + POWER(y, 2)), 2) AS 距離 FROM APP100
```

---

## 2. SHOW APPS / DESCRIBE

### SHOW APPS — アプリ一覧取得

kintone 上のすべてのアプリの一覧を取得します。

```sql
SHOW APPS
```

| カラム | 内容 |
|---|---|
| `appId` | アプリ ID |
| `name` | アプリ名 |
| `description` | 説明 |

100 件単位で自動ページングし、最大 **1,000 件**まで取得します。

### DESCRIBE / DESC — フィールド一覧取得

指定したアプリのフィールド定義を取得します。

```sql
DESCRIBE APP100
DESC APP100      -- 省略形（DESCRIBE と同等）
```

| カラム | 内容 |
|---|---|
| `fieldCode` | フィールドコード |
| `label` | フィールドラベル |
| `type` | フィールドタイプ（`SINGLE_LINE_TEXT`、`NUMBER` 等） |

### WITH 句での使用

`SHOW APPS` / `DESCRIBE` / `DESC` の結果を CTE として後続クエリで利用できます。

```sql
-- 名前でアプリを絞り込む
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

---

## 3. UPSERT

キーフィールドの値で既存レコードを検索し、一致すれば更新・なければ新規登録します。

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

### 結果表示

| 項目 | 内容 |
|---|---|
| 登録件数 | 新規登録されたレコード数 |
| 更新件数 | 更新されたレコード数 |

> キーフィールドに一致するレコードが複数ある場合はエラーになります。

---

## 4. WHERE サブクエリ

### IN (SELECT ...) / NOT IN (SELECT ...)

別アプリの検索結果を IN リストとして使用できます。

```sql
-- APP89 の「ランク A」顧客名でフィルタ
SELECT * FROM APP88
WHERE 顧客名 IN (SELECT 顧客名 FROM APP89 WHERE 顧客ランク = 'A')

-- 除外
SELECT * FROM APP88
WHERE 顧客名 NOT IN (SELECT 顧客名 FROM APP89 WHERE ステータス = '停止')
```

- サブクエリの 1 列目（または指定フィールド）の値セットを IN リストとして使用します
- 自動的に FULL_SCAN モードで実行されます
- サブクエリ自体も SIMPLE / FULL_SCAN を自動判定します

### EXISTS / NOT EXISTS（非相関）

サブクエリが 1 件以上返すかどうかで条件を判定します。

```sql
-- サブクエリが 1件以上あれば全行を返す
SELECT * FROM APP88
WHERE EXISTS (SELECT $id FROM APP89 WHERE ステータス = '承認済み')

-- サブクエリが 0件なら全行を返す
SELECT * FROM APP88
WHERE NOT EXISTS (SELECT $id FROM APP89 WHERE フラグ = 'NG')

-- AND との組み合わせ
SELECT 顧客名, 金額 FROM APP88
WHERE 金額 > 10000
  AND EXISTS (SELECT $id FROM APP89 WHERE 承認フラグ = '1')
```

- サブクエリは 1 回だけ実行され、全行に同じ結果（真/偽）が適用されます
- **相関サブクエリは非対応**（外側テーブルのフィールドをサブクエリ内で参照不可）
- 自動的に FULL_SCAN モードで実行されます

---

## 5. LIKE 挙動の統一（バグ修正）

ワイルドカードなし（`LIKE 'keyword'`）の FULL_SCAN 時の評価を kintone API と同じ**部分一致（contains）**に統一しました。

| モード | 修正前 | 修正後 |
|---|---|---|
| SIMPLE（kintone API） | 部分一致 | 部分一致（変更なし） |
| FULL_SCAN（JS 評価） | **完全一致**（バグ） | **部分一致**（修正済み） |

```sql
-- この 2つは同等（ワイルドカードなし = %keyword% と同じ動作）
WHERE 顧客名 LIKE '会社'
WHERE 顧客名 LIKE '%会社%'
```

**影響を受けるケース:** EXISTS / IN (SELECT) / JOIN / GROUP BY / WHERE 関数 など FULL_SCAN になる条件と LIKE を AND/OR で組み合わせた場合。

---

## v4 機能一覧まとめ

| 機能 | 構文例 |
|---|---|
| 剰余演算子 | `SELECT 数量 % 3 AS 余り FROM APP100` |
| ABS | `SELECT ABS(差額) AS 絶対値 FROM APP100` |
| MOD | `SELECT MOD(数量, 3) AS 余り FROM APP100` |
| POWER / POW | `SELECT POWER(辺長, 2) AS 面積 FROM APP100` |
| SQRT | `SELECT SQRT(面積) AS 辺長 FROM APP100` |
| SHOW APPS | `SHOW APPS` |
| DESCRIBE / DESC | `DESCRIBE APP100` / `DESC APP100` |
| SHOW APPS in WITH | `WITH アプリ AS (SHOW APPS) SELECT * FROM アプリ WHERE name LIKE '受注%'` |
| DESC in WITH | `WITH f AS (DESC APP100) SELECT * FROM f WHERE type = 'NUMBER'` |
| UPSERT VALUES | `UPSERT INTO APP100 (...) VALUES (...) ON DUPLICATE (キー)` |
| UPSERT SELECT | `UPSERT INTO APP100 (...) SELECT ... ON DUPLICATE (キー)` |
| IN (SELECT) | `WHERE 顧客名 IN (SELECT 顧客名 FROM APP89 WHERE ...)` |
| NOT IN (SELECT) | `WHERE 顧客名 NOT IN (SELECT 顧客名 FROM APP89 WHERE ...)` |
| EXISTS | `WHERE EXISTS (SELECT $id FROM APP89 WHERE ...)` |
| NOT EXISTS | `WHERE NOT EXISTS (SELECT $id FROM APP89 WHERE ...)` |
| LIKE 挙動統一 | ワイルドカードなし LIKE = 部分一致（FULL_SCAN でも同様） |

---

## 実行モードへの影響

| 機能 | モード |
|---|---|
| 数学関数（SELECT 列） | SIMPLE（関数はJS評価のみ、kintone に列指定として渡さない） |
| 数学関数（WHERE 左辺） | FULL_SCAN |
| SHOW APPS | — （専用 API） |
| DESCRIBE / DESC | — （専用 API） |
| UPSERT VALUES / SELECT | — （専用フロー） |
| IN (SELECT ...) | FULL_SCAN |
| NOT IN (SELECT ...) | FULL_SCAN |
| EXISTS / NOT EXISTS | FULL_SCAN |
