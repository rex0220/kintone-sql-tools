# ksql v3 追加仕様

v3 では以下の機能を追加しました。

---

## 1. UNION / UNION ALL

複数の SELECT 結果を縦に結合します。

```sql
-- 重複を除去して結合
SELECT 氏名, 金額 FROM APP100
UNION
SELECT 氏名, 金額 FROM APP200

-- 重複を保持して結合
SELECT 氏名 FROM APP100
UNION ALL
SELECT 氏名 FROM APP200
```

- `UNION` — 重複行を除去（DISTINCT）
- `UNION ALL` — 重複行をそのまま保持
- 列数が一致しない場合はエラー
- 右辺の列名は左辺の列名に位置対応でリマップされます
- 3つ以上を連鎖可能（左結合）

```sql
SELECT 名前 FROM APP100
UNION
SELECT 名前 FROM APP200
UNION
SELECT 名前 FROM APP300
```

---

## 2. WITH 句（CTE: Common Table Expression）

クエリの冒頭で仮想テーブル（CTE）を定義し、後続の SELECT / JOIN で参照できます。

```sql
WITH CTE名 AS (
  サブクエリ
)
SELECT ...
FROM CTE名
```

### 基本例

```sql
-- GROUP BY 集計結果を CTE に入れて LIMIT
WITH 月別 AS (
  SELECT 月, SUM(金額) AS 合計
  FROM APP100
  GROUP BY 月
)
SELECT 月, 合計
FROM 月別
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

**注意事項:**
- CTE を参照するクエリは常に FULL_SCAN モードで実行（JS 側で評価）
- CTE 内のサブクエリは SIMPLE / FULL_SCAN を自動判定
- 再帰 CTE は非対応

---

## 3. WHERE 句での算術式

WHERE 句の左辺・右辺に算術式を使用できます。  
算術式を含む条件は自動的に FULL_SCAN モードで実行されます。

### 左辺に算術式

```sql
-- 単純な乗算
WHERE 金額 * 1.1 > 10000

-- 括弧を使った複合算術式
WHERE (単価 + 送料) * 数量 < 5000

-- 関数との組み合わせ
WHERE LENGTH(備考) * 2 > 20
```

### 右辺に算術式

```sql
-- 右辺に計算式
WHERE 税込金額 = 金額 * 1.1

-- 別フィールドとの比較
WHERE 実績 >= 目標 * 0.8
```

### テーブルエイリアス付き（JOIN あり）

```sql
SELECT *
FROM APP100 AS a
INNER JOIN APP200 AS b ON a.顧客ID = b.顧客ID
WHERE a.金額 * 1.1 > 10000
```

**注意:** 算術式を含む WHERE は kintone API に渡せないため全件取得になります。  
件数が多い場合はパフォーマンスに注意してください。

---

## 4. CASE WHEN — WHERE 句・UPDATE SET での使用

SELECT 列以外に、WHERE 句と UPDATE SET でも CASE WHEN を使用できます。

### WHERE 句の左辺に CASE WHEN

```sql
-- 区分に応じて比較値を切り替え
WHERE CASE
    WHEN 区分 = '特別' THEN 金額
    ELSE 0
  END > 1000

-- ステータスに応じてスコアを計算して絞り込み
WHERE CASE
    WHEN ランク = 'A' THEN スコア * 2
    ELSE スコア
  END >= 100
```

### WHERE 句の右辺に CASE WHEN

```sql
-- 区分ごとに閾値を変える
WHERE スコア > CASE
    WHEN 区分 = 'A' THEN 80
    ELSE 50
  END

-- フィールド値と動的な基準値を比較
WHERE 金額 = CASE
    WHEN ステータス = '割引適用' THEN 定価 * 0.9
    ELSE 定価
  END
```

### ELSE 省略

ELSE を省略すると、どの条件にも合致しない行では CASE WHEN の結果が空文字（NULL 相当）になります。

```sql
-- 区分が 'A' の行だけ通過させる（ELSE なし → '' = 'A' は false）
WHERE CASE WHEN 区分 = 'A' THEN 区分 END = 'A'
```

### UPDATE SET での CASE WHEN

```sql
-- 区分に応じて金額を書き分ける
UPDATE APP100
SET 金額 = CASE
    WHEN 区分 = '特別' THEN 500
    ELSE 1200
  END
WHERE ステータス = '対象'

-- 複数フィールドを混在更新（算術式と CASE WHEN）
UPDATE APP100
SET 合計  = 単価 * 数量,
    ランク = CASE
        WHEN 単価 >= 10000 THEN 'S'
        WHEN 単価 >= 5000  THEN 'A'
        ELSE 'B'
      END
WHERE 担当者 = '田中'
```

**注意事項:**
- CASE WHEN を含む UPDATE は「現在値取得 → CASE 評価 → PUT」の 2 フェーズで実行
- CASE 条件内のフィールド参照は自動的に GET クエリの取得対象に含まれます
- THEN / ELSE の値には文字列リテラル・数値・フィールド参照・算術式・文字列関数が使用可能
- WHERE 句の CASE WHEN は FULL_SCAN モードで実行（kintone API に変換不可）

---

## 5. CTE インライン化（WHERE プッシュダウン最適化）

単純な CTE（GROUP BY・集計・JOIN なし）を使う場合、自動的に CTE をインライン化して WHERE 条件を kintone REST API クエリに変換します。

```sql
-- このクエリを書いたとき
WITH 対象 AS (SELECT * FROM APP100 WHERE 区分 = 'A')
SELECT * FROM 対象 WHERE 金額 > 1000

-- 実際には以下と同等に実行される（REST API に 1 回リクエスト）
SELECT * FROM APP100 WHERE 区分 = 'A' AND 金額 > 1000
```

インライン化される条件:
- CTE が 1 つ
- CTE 本体に GROUP BY・集計・JOIN がない（SIMPLE モード）
- 最終クエリが単純 SELECT（GROUP BY・集計・DISTINCT なし）
- 最終クエリの FROM が CTE のみ（JOIN なし）

インライン化されない場合（従来どおり FULL_SCAN）:
- CTE が複数
- CTE 本体に GROUP BY / 集計関数がある
- 最終クエリで CTE を JOIN している

---

## 6. UI 改善

### エラーメッセージの表示

kintone API のエラーをわかりやすく表示します。

```
⚠ 入力内容が正しくありません。
  records[0].顧客ランク.value: "V"は選択肢にありません。

⚠ 指定されたフィールド（顧客ランク）が見つかりません。
```

### 実行履歴（エラー時も保存）

エラーになった SQL も履歴に保存されます。  
履歴から選択して修正・再実行できます。  
（キャンセルした場合は保存されません）

---

## v3 機能一覧まとめ

| 機能 | 構文例 |
|------|--------|
| UNION | `SELECT ... UNION SELECT ...` |
| UNION ALL | `SELECT ... UNION ALL SELECT ...` |
| WITH 句（CTE） | `WITH 名前 AS (SELECT ...) SELECT * FROM 名前` |
| CTE + JOIN | `... INNER JOIN CTE名 AS a ON ...` |
| 複数 CTE | `WITH a AS (...), b AS (...) SELECT ...` |
| WHERE 左辺算術式 | `WHERE 金額 * 1.1 > 10000` |
| WHERE 括弧算術式 | `WHERE (単価 + 送料) * 数量 < 5000` |
| WHERE 右辺算術式 | `WHERE 税込 = 金額 * 1.1` |
| WHERE 左辺 CASE WHEN | `WHERE CASE WHEN 区分 = 'A' THEN ... END > 100` |
| WHERE 右辺 CASE WHEN | `WHERE スコア > CASE WHEN ... END` |
| UPDATE SET CASE WHEN | `SET ランク = CASE WHEN ... END` |
| CTE インライン化 | 単純 CTE の WHERE を自動的に REST API へ |
| エラーメッセージ表示 | kintone API エラーを日本語で表示 |
| 履歴（エラー時保存） | エラーになった SQL も履歴に残る |

---

## 実行モードへの影響

| 機能 | モード |
|------|--------|
| UNION / UNION ALL | FULL_SCAN |
| WITH 句（GROUP BY あり CTE） | FULL_SCAN |
| WITH 句（単純 CTE） | **SIMPLE**（インライン化により REST API） |
| WHERE 算術式 | FULL_SCAN |
| WHERE CASE WHEN | FULL_SCAN |
| UPDATE SET CASE WHEN | 2フェーズ（GET + PUT） |

kintone API のクエリに直接変換できない場合、レコード件数が多いとパフォーマンスに影響します。
