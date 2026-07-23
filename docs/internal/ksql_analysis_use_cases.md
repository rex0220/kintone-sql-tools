# kSQL 分析ユースケース集（集計・表示・分析）

- 作成日: 2026-07-23
- ステータス: **📝 提案（テンプレート・実アプリ未束縛）**。各クエリは説明用テンプレート＝`APP番号`・フィールド名は環境に合わせて置換する。ユーザー公開する場合は実アプリに束縛して `ksql_validate` で確認する（横断教訓「公開 SQL はそのまま validate すべき」）。
- 位置づけ: [バッチレシピ集](../ksql_batch_recipes.md)（R1–R13＝バッチ/DML の実務手順）とは**別軸**で、**アプリの集計・表示・分析（read-only 中心）**の用途カタログ。B66（read-only ライブラリ＝ダッシュボード用途）の価値題材でもある。
- 例のドメイン: 営業案件管理 `APP100`（`会社名`・`地域`・`担当`・`フェーズ`（引合/商談/受注）・`金額`・`受注日`・`商品`・`単価`）を想定。

| # | 用途 | 主に使う kSQL 機能 |
|---|---|---|
| 1 | クロス集計（ピボット） | 条件付き集計 `SUM(CASE …)`（B64） |
| 2 | 明細＋小計・総計レポート | `ROLLUP`/`CUBE`＋`GROUPING()`（B65） |
| 3 | グループ別ランキング／各グループ最新 | window `ROW_NUMBER`/`RANK`（B17）＋CTE |
| 4 | 時系列トレンド（日/週/月/四半期・曜日） | `DATE_FORMAT`/`QUARTER`/`WEEK`/`DAYOFWEEK`（B57） |
| 5 | KPI サマリカード | 無グループ集計＋条件付き件数 |
| 6 | 統計分布・ばらつき | `MEDIAN`/`MODE`/`STDDEV_SAMP`/`VAR_SAMP`（B56/B58） |
| 7 | 前期比・成長率 | 複数 CTE＋CTE 間 JOIN（B51） |
| 8 | ファネル／歩留まり | 条件付き集計＋比率（B64） |
| 9 | アプリ間突合・未マッチ抽出 | `JOIN`（単一等値）＋外部結合 |
| 10 | 重複検出・データ品質 | `GROUP BY … HAVING COUNT>1`＋`GROUP_CONCAT`（B16） |

---

## 1. クロス集計表（ピボット）

行＝カテゴリ、列＝区分の横持ち表を1クエリで。担当×フェーズ、月×商品など。

```sql
SELECT 担当,
  SUM(CASE WHEN フェーズ = '受注' THEN 金額 END) AS 受注,
  SUM(CASE WHEN フェーズ = '商談' THEN 金額 END) AS 商談,
  SUM(CASE WHEN フェーズ = '引合' THEN 金額 END) AS 引合
FROM APP100
GROUP BY 担当
ORDER BY 受注 DESC;
```

表示: そのままテーブル表示、または担当を軸にした積み上げ棒グラフ。

## 2. 明細＋小計・総計の階層レポート

地域→会社の小計と総計を1結果セットで。`GROUPING()` で行種別を判別。

```sql
SELECT
  CASE WHEN GROUPING(地域) = 1 THEN '総計'
       WHEN GROUPING(会社名) = 1 THEN 地域 || ' 小計'
       ELSE 会社名 END AS 区分,
  SUM(金額) AS 売上
FROM APP100
GROUP BY ROLLUP(地域, 会社名)
ORDER BY GROUPING(地域), 地域, GROUPING(会社名), 会社名;
```

表示: 小計・総計行を強調したレポート表。両軸の小計が要るなら `CUBE(地域, 会社名)`。

## 3. グループ別ランキング／各グループの最新レコード

「各会社の売上トップ3」「各顧客の最新案件を全列付きで」。

```sql
-- 各会社の金額トップ3
WITH r AS (
  SELECT 会社名, 商品, 金額,
         RANK() OVER (PARTITION BY 会社名 ORDER BY 金額 DESC) AS 順位
  FROM APP100
)
SELECT 会社名, 商品, 金額, 順位 FROM r WHERE 順位 <= 3
ORDER BY 会社名, 順位;
```

`ROW_NUMBER() … WHERE rn = 1` にすれば「各グループ最新1件」。window 列は `AS alias` 必須。

## 4. 時系列トレンド（日/週/月/四半期・曜日別）

日付を任意粒度に畳み込んで期間別集計。

```sql
-- 週次（ISO 週・年跨ぎ安全な %G-%v）
SELECT DATE_FORMAT(受注日, '%G-W%v') AS 週, COUNT(*) AS 件数, SUM(金額) AS 売上
FROM APP100
GROUP BY 週
ORDER BY 週;

-- 四半期別 / 曜日別
SELECT QUARTER(受注日) AS 四半期, SUM(金額) FROM APP100 GROUP BY 四半期;
SELECT DAYOFWEEK(受注日) AS 曜日, COUNT(*) FROM APP100 GROUP BY 曜日 ORDER BY 曜日;
```

表示: 折れ線（トレンド）、曜日別は棒グラフ。

## 5. KPI サマリカード（無グループ集計・達成率）

ダッシュボード上部の数値カード群を1行で返す（0件でも1行）。

```sql
SELECT
  COUNT(*) AS 件数,
  SUM(金額) AS 合計,
  AVG(金額) AS 平均,
  SUM(CASE WHEN フェーズ = '受注' THEN 1 END) AS 受注数,
  SUM(CASE WHEN フェーズ = '受注' THEN 金額 END) AS 受注額
FROM APP100
WHERE 受注日 >= '2026-01-01';
```

表示: 数値カード（件数・合計・平均・受注数）。

## 6. 統計分布・ばらつき分析

単価・工数・リードタイムの中央値/最頻値/標準偏差で分布と外れ値を把握。

```sql
SELECT 商品,
  COUNT(*) AS 件数,
  MEDIAN(単価) AS 中央値,
  MODE(商品) AS 最頻,
  STDDEV_SAMP(単価) AS 標準偏差,
  MIN(単価) AS 最小, MAX(単価) AS 最大
FROM APP100
GROUP BY 商品;
```

表示: 箱ひげ的な指標テーブル、標準偏差でばらつきの大きい商品を強調。

## 7. 前期比・成長率（期間比較）

当期と前期を別々に集計して突き合わせ、増減・比率を算出。

```sql
WITH 今月 AS (
  SELECT 地域, SUM(金額) AS 売上 FROM APP100
  WHERE 受注日 >= '2026-07-01' AND 受注日 < '2026-08-01' GROUP BY 地域
),
先月 AS (
  SELECT 地域, SUM(金額) AS 売上 FROM APP100
  WHERE 受注日 >= '2026-06-01' AND 受注日 < '2026-07-01' GROUP BY 地域
)
SELECT c.地域, c.売上 AS 今月, p.売上 AS 先月, (c.売上 - p.売上) AS 増減
FROM 今月 c JOIN 先月 p ON c.地域 = p.地域
ORDER BY 増減 DESC;
```

表示: 増減で並べた比較表、増減の符号で色分け。

## 8. ファネル／歩留まり分析

案件フェーズや採用選考の段階別件数と通過率。

```sql
SELECT
  COUNT(*) AS 全体,
  SUM(CASE WHEN フェーズ IN ('引合','商談','受注') THEN 1 END) AS 引合以上,
  SUM(CASE WHEN フェーズ IN ('商談','受注') THEN 1 END) AS 商談以上,
  SUM(CASE WHEN フェーズ = '受注' THEN 1 END) AS 受注
FROM APP100;
```

表示: ファネル図（各段階の件数）。比率は表示側 or 追加列で算出。

## 9. アプリ間突合・未マッチ抽出

2アプリを業務キーで結合し、片方にしかないレコード（未計上・不整合）を検出。請求↔入金、マスタ↔明細など。

```sql
-- 未入金（請求にあって入金に無い）
SELECT a.伝票番号, a.会社名, a.金額
FROM APP請求 a
LEFT JOIN APP入金 b ON a.伝票番号 = b.伝票番号
WHERE b.伝票番号 IS NULL;
```

JOIN は単一等値・派生テーブル非対応（必要なら `WITH`）。表示: 不整合レコードの一覧。

## 10. 重複検出・データ品質チェック

キー重複、空値、異常値を集計して品質を可視化。重複 ID をリスト化。

```sql
-- メール重複
SELECT メール, COUNT(*) AS 件数, GROUP_CONCAT($id) AS IDリスト
FROM APP100
GROUP BY メール
HAVING COUNT(*) > 1
ORDER BY 件数 DESC;

-- 空値・異常値の件数
SELECT
  SUM(CASE WHEN 会社名 = '' THEN 1 END) AS 会社名空,
  SUM(CASE WHEN 金額 < 0 THEN 1 END) AS 金額負
FROM APP100;
```

表示: 重複・欠損のカウントカードと、詳細ドリルダウン一覧。

---

## 補足の候補（余力があれば）

- **11. ABC／パレート分析**: 売上降順に順位付けし累積比率で A/B/C ランク化。累計 `SUM() OVER()` は未実装のため、現状は temp/CTE で降順ソート＋順位付けの二段で近似。
- **12. コホート／継続率**: 初回登録月でグルーピングし期間別の継続を追う（日付軸＋条件付き集計）。

## 関連

- [バッチレシピ集（R1–R13）](../ksql_batch_recipes.md)
- [B66 エンジンのライブラリ公開評価](ksql_b66_engine_library_evaluation.md)
- [言語リファレンス](../ksql_language_reference.md)（集計 §8 / 日付 §9 / window / ROLLUP）
