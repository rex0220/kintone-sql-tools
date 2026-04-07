# ksql v6 追加仕様

v6 では以下の機能を追加しました。

---

## 1. CURRENT_DATE() / CURRENT_TIMESTAMP()

SELECT 列・WHERE 句で現在日時を JS で取得できます。

| 関数 | 返却値 | 評価 |
|---|---|---|
| `CURRENT_DATE()` | `YYYY-MM-DD` | 常に JS |
| `CURRENT_TIMESTAMP()` | ISO 8601（`2026-04-04T12:34:56.789Z`） | 常に JS |

```sql
-- SELECT 列で取得日時を付加
SELECT 顧客名, 金額, CURRENT_TIMESTAMP() AS 取得日時 FROM APP100
SELECT *, CURRENT_DATE() AS 今日 FROM APP100

-- WHERE でも使用可能（FULL_SCAN）
SELECT * FROM APP100 WHERE 作成日 = CURRENT_DATE()
```

### kintone 専用関数との使い分け

| 関数 | 評価場所 | SELECT 列 | WHERE SIMPLE |
|---|---|---|---|
| `TODAY()` | kintone API / JS | ❌ WHERE のみ | ✅ API に渡す |
| `NOW()` | kintone API / JS | ❌ WHERE のみ | ✅ API に渡す |
| `CURRENT_DATE()` | 常に JS | ✅ | ✅（FULL_SCAN） |
| `CURRENT_TIMESTAMP()` | 常に JS | ✅ | ✅（FULL_SCAN） |

### フィールドコードとの衝突回避

`CURRENT_DATE` / `CURRENT_TIMESTAMP` はキーワード未登録です。  
`()` があれば関数、なければフィールド参照として扱われます。

```sql
SELECT CURRENT_DATE()  FROM APP100  -- 関数（今日の日付）
SELECT CURRENT_DATE   FROM APP100   -- フィールド参照（「CURRENT_DATE」フィールド）
```

---

## 2. スカラーサブクエリ

1 行 1 列を返すサブクエリを WHERE 右辺・SELECT 列・HAVING 右辺で使用できます。  
**非相関のみ対応。** サブクエリは 1 回だけ実行され、全行に同じ値が適用されます。

### WHERE 右辺

```sql
-- 全体平均を超えるレコードを抽出
SELECT * FROM APP100
WHERE 金額 > (SELECT AVG(金額) FROM APP100)

-- 別アプリの最大値と比較
SELECT * FROM APP100
WHERE 金額 >= (SELECT MAX(上限金額) FROM APP200 WHERE 区分 = '標準')
```

### SELECT 列

```sql
-- 全件数・合計をすべての行に付加
SELECT
  顧客名,
  金額,
  (SELECT COUNT(*) FROM APP100) AS 総件数,
  (SELECT SUM(金額) FROM APP100) AS 合計金額
FROM APP100
WHERE ステータス = '完了'
```

列のエイリアスを省略した場合は `(subquery)` が列名になります。

### HAVING 右辺

```sql
SELECT 担当者, SUM(金額) AS 合計
FROM APP100
GROUP BY 担当者
HAVING SUM(金額) > (SELECT AVG(金額) FROM APP100)
```

### 制約

- **1 行 1 列を返す必要があります。** 0 行はエラー、2 行以上もエラー
- **相関サブクエリは非対応**（外側テーブルのフィールドをサブクエリ内で参照不可）
- **サブクエリ後の算術演算子は非対応。** 算術はサブクエリ内に移動してください

```sql
-- NG: サブクエリの後に演算子
HAVING SUM(金額) > (SELECT AVG(金額) FROM APP100) * 2

-- OK: 算術をサブクエリ内で実行
HAVING SUM(金額) > (SELECT AVG(金額) * 2 FROM APP100)
```

- SELECT 列にスカラーサブクエリがあると自動的に FULL_SCAN モードになります

---

## 3. LIKE 挙動の統一（バグ修正）

ワイルドカードなし（`LIKE 'keyword'`）の FULL_SCAN 時の評価を kintone API と同じ**部分一致（contains）**に統一しました。

| モード | 修正前 | 修正後 |
|---|---|---|
| SIMPLE（kintone API） | 部分一致 | 部分一致（変更なし） |
| FULL_SCAN（JS 評価） | **完全一致**（バグ） | **部分一致**（修正済み） |

```sql
-- この 2つは同等
WHERE 顧客名 LIKE '会社'
WHERE 顧客名 LIKE '%会社%'
```

**影響を受けるケース:** EXISTS / IN (SELECT) / JOIN / GROUP BY / WHERE 関数 などで FULL_SCAN になる場合と LIKE を AND/OR で組み合わせたとき。

---

## v6 機能一覧まとめ

| 機能 | 構文例 |
|---|---|
| CURRENT_DATE() | `SELECT CURRENT_DATE() AS 今日 FROM APP100` |
| CURRENT_TIMESTAMP() | `SELECT CURRENT_TIMESTAMP() AS 取得日時 FROM APP100` |
| スカラーサブクエリ（WHERE 右辺） | `WHERE 金額 > (SELECT AVG(金額) FROM APP100)` |
| スカラーサブクエリ（SELECT 列） | `SELECT (SELECT COUNT(*) FROM APP100) AS 総件数 FROM APP100` |
| スカラーサブクエリ（HAVING 右辺） | `HAVING SUM(金額) > (SELECT AVG(金額) FROM APP100)` |
| LIKE 挙動統一 | ワイルドカードなし LIKE = 部分一致（FULL_SCAN でも同様） |

---

## 実行モードへの影響

| 機能 | モード |
|---|---|
| `CURRENT_DATE()` / `CURRENT_TIMESTAMP()`（SELECT 列） | FULL_SCAN |
| `CURRENT_DATE()` / `CURRENT_TIMESTAMP()`（WHERE） | FULL_SCAN |
| スカラーサブクエリ（WHERE 右辺） | FULL_SCAN |
| スカラーサブクエリ（SELECT 列） | FULL_SCAN |
| スカラーサブクエリ（HAVING 右辺） | FULL_SCAN |
