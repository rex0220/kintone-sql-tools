# B51 — 複数 CTE の CTE 間 JOIN が誤結果を返す

- 起票日: 2026-07-21
- ステータス: **起票（実データで再現確認・未着手・要 root-cause 調査）**
- 種別: バグ（正しさ・silent wrong results）
- 優先度: **高**（結果が静かに壊れる＝誤ったデータで判断/書き戻しの危険）
- 発見の経緯: B6（外部結合の KLIKE 押し下げ）の回避策検討で「一時テーブルの代わりに WITH でも同様にできるのでは？」という問いを実データで検証したところ、WITH（複数 CTE の CTE 間 JOIN）が KLIKE と無関係に誤結果を返すことが判明。

## 症状

**2つ以上の CTE を定義し、CTE 同士を JOIN すると、左 CTE の投影列が空になり、行が重複し、行数も誤る。** 右 CTE の列は正しい。LEFT JOIN では未一致行（NULL 埋め対象）も消える。同一論理を一時テーブル（`CREATE TEMP TABLE`）で書くと正しい結果になるため、CTE 間 JOIN の実行経路固有の不具合。

## 最小再現（本番 kintone・APP730・CLI v3.10.0）

```sql
WITH a AS (SELECT レコード番号 AS aid FROM APP730 WHERE レコード番号 IN (1,2,3)),
     b AS (SELECT レコード番号 AS bid, 郵便番号 AS bzip FROM APP730 WHERE レコード番号 IN (1,2))
SELECT a.aid, b.bid, b.bzip FROM a INNER JOIN b ON a.aid = b.bid
```

- 期待: 2 行（aid/bid=1,2・bzip あり）。
- 実際: **4 行**・`a.aid` が**空**・各行が 2 倍重複。
  ```
  aid,bid,bzip
  ,1,5008334
  ,2,5020834
  ,1,5008334
  ,2,5020834
  ```

### LEFT JOIN でも同様（未一致行が消える）

```sql
WITH a AS (SELECT レコード番号 AS aid, 都道府県 AS apref FROM APP730 WHERE レコード番号 IN (1,2,3)),
     b AS (SELECT レコード番号 AS bid, 郵便番号 AS bzip FROM APP730 WHERE レコード番号 IN (1,2))
SELECT a.aid, a.apref, b.bzip FROM a LEFT JOIN b ON a.aid = b.bid
```
- 期待: 3 行（1,2 は bzip あり・3 は NULL）。
- 実際: 4 行・`a.aid`/`a.apref` 空・3（未一致）欠落・重複。

## 対照（同一論理を一時テーブルで＝正しい）

```sql
CREATE TEMP TABLE #a AS SELECT レコード番号 AS aid, 都道府県 AS apref FROM APP730 WHERE レコード番号 IN (1,2,3);
CREATE TEMP TABLE #b AS SELECT レコード番号 AS bid, 郵便番号 AS bzip FROM APP730 WHERE レコード番号 IN (1,2);
SELECT a.aid, a.apref, b.bzip FROM #a a LEFT JOIN #b b ON a.aid = b.bid
```
- 実際: **正しい** 3 行（`1,岐阜県,5008334` / `2,岐阜県,5020834` / `3,岐阜県,`（NULL））。

## 観察・切り分け

- **KLIKE とは無関係**（KLIKE を含まない `IN` フィルタでも再現）。
- **左 CTE の列だけが空**（`a.aid`/`a.apref`）・右 CTE の列は正しい → CTE 間 JOIN での**左辺 CTE 行の列投影 or 別名解決**が疑わしい。
- **行の重複・LEFT 未一致行の欠落** → JOIN の**カーディナリティ/マッチング**も壊れている（左キーが空になり join 条件が誤評価されている可能性）。
- 一時テーブル版は正しい → 実体化テーブルの JOIN 経路は健全で、**CTE（特に複数 CTE の CTE 間 JOIN）の実行経路**に固有。
- 単一 CTE の実アプリ JOIN はインライン化で別経路になり得る（本 issue は複数 CTE の CTE 間 JOIN に焦点）。

## 影響

- **silent wrong results**（エラーにならず誤った行/列を返す）。誤ったデータで判断したり、`UPDATE ... FROM` / 書き戻しに使うと誤書き込みにつながり得る（最も警戒すべき事象）。
- 回避策: **CTE 間 JOIN を一時テーブル（`CREATE TEMP TABLE ... AS SELECT`）に置き換える**（実データで正しさ確認済み）。B6 の KLIKE 外部結合回避策も一時テーブルを使う（WITH は本 issue のため不可）。

## 次アクション

1. root-cause 調査（複数 CTE の CTE 間 JOIN の列投影・別名解決・JOIN カーディナリティ・CTE インライン化/実体化の分岐）。codex 調査→仕様/修正計画→実装→レビュー→実データ再現の pass/fail 固定→リリース。
2. 少なくとも**誤結果を返す代わりに明確なエラー**にする（silent wrong results の即時緩和）か、正しく実行できるよう修正する。
3. 単一 CTE・INNER/LEFT/RIGHT・別名有無・同一アプリ/別アプリ・列衝突有無の直積で再現範囲を確定（実データで全件流す）。
