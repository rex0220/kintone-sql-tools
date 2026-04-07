# ksql v2 追加仕様

## 文字列・変換関数

| 関数 | 構文例 | 備考 |
|------|--------|------|
| `UPPER` / `LOWER` | `UPPER(顧客名)` | |
| `TRIM` / `LTRIM` / `RTRIM` | `TRIM(備考)` | |
| `LENGTH` | `LENGTH(住所)` | 文字数（UTF-16） |
| `SUBSTRING` / `SUBSTR` | `SUBSTRING(コード, 1, 3)` | 1-indexed |
| `CONCAT` | `CONCAT(姓, '　', 名)` | 可変長引数 |
| `REPLACE` | `REPLACE(電話番号, '-', '')` | |
| `COALESCE` | `COALESCE(メモ, '－')` | 最初の非空値 |
| `CAST` | `CAST(金額 AS NUMBER)` | TEXT / NUMBER |
| `CONVERT` | `CONVERT(金額, NUMBER)` | CAST の別記法 |

## 数値関数

| 関数 | 構文例 | 備考 |
|------|--------|------|
| `ROUND(f, n)` | `ROUND(金額, -3)` | n 省略時 = 0、負数で上位桁丸め |
| `FLOOR(f, n)` | `FLOOR(金額, 2)` | |
| `CEIL(f, n)` | `CEIL(金額, -2)` | `CEILING` も可 |
| `FORMAT(f, pat)` | `FORMAT(金額, '#,##0.00')` | Excel 風パターン / MySQL 整数スタイル |

### FORMAT パターン

| パターン | 入力 | 出力 |
|---------|------|------|
| `'#,##0'` | 1234567 | `1,234,567` |
| `'#,##0.00'` | 1234.5 | `1,234.50` |
| `'0.00%'` | 0.156 | `15.60%` |
| `'#,##0.##'` | 1234.5 | `1,234.5` |
| `2`（整数） | 1234.5 | `1,234.50` |

## CASE WHEN

```sql
SELECT
  CASE
    WHEN 金額 >= 10000 THEN '大口'
    WHEN 金額 >= 1000  THEN '中口'
    ELSE '小口'
  END AS 区分
FROM APP100
```

- THEN / ELSE の値: 文字列リテラル / 算術式 / 関数呼び出し
- ELSE 省略時は空文字（NULL 相当）

## 関数・算術の組み合わせ

関数の結果を算術式の被演算子として使用可能。

```sql
SELECT
  ROUND(合計費用) / 2      AS 半額,
  LENGTH(顧客名) * 100      AS スコア,
  CONCAT(姓, 名) AS 氏名
FROM APP100
```

## WHERE / ORDER BY での関数使用

```sql
-- WHERE 左辺に関数
WHERE UPPER(ステータス) = 'ACTIVE'
WHERE LENGTH(コード) > 5

-- ORDER BY に算術・関数
ORDER BY 金額 * 1.1 DESC
ORDER BY UPPER(顧客名) ASC
ORDER BY ROUND(金額, -3) DESC
```

> WHERE に関数を含む場合、または ORDER BY に算術式・関数を含む場合は自動的に FULL_SCAN モードに切り替わります。

## INSERT INTO ... SELECT

別アプリのデータをそのままコピーする構文。

```sql
INSERT INTO APP100 (顧客名, 金額)
SELECT 顧客名, 合計金額
FROM APP200
WHERE ステータス = '確定'
```

- SELECT の列数と INSERT フィールド数が一致しない場合はエラー
- SELECT 側は SIMPLE / FULL_SCAN 自動判定（JOIN・GROUP BY・関数も使用可）
- 100 件バッチで POST
