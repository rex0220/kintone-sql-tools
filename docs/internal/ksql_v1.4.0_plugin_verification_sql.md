# v1.4.0 プラグイン実機テスト SQL

- 作成日: 2026-07-09
- 対象: kintone プラグイン(v1.4.0 ビルド `dist/ksql-plugin-v1.4.0.zip`)
- 前提アプリ: APP4148(顧客: `顧客No` / `会社名` / `顧客ランク`)、APP4149(案件: `案件No_` / `案件名` / `商談フェーズ` / `売上` / `顧客No_`)

**プラグイン UI は単文のみ**です(バッチ・一時テーブルは CLI / MCP で検証)。プラグイン観点は、①既存クエリの回帰、②単文経路の改善、③新しく出るようになったエラー、④DML 確認ダイアログ、の4つです。

---

## A. 回帰確認(v1.3.0 と同じ結果になること)

### A-1. 基準クエリ(JOIN + IN + ORDER BY、FULL_SCAN)

```sql
SELECT
  a.顧客No,
  a.会社名,
  a.顧客ランク,
  b.案件No_,
  b.案件名,
  b.商談フェーズ,
  b.売上
FROM APP4148 AS a
INNER JOIN APP4149 AS b
  ON a.顧客No = b.顧客No_
WHERE b.商談フェーズ IN ('提案中', '内示', '受注')
AND a.顧客ランク IN ('A')
ORDER BY b.案件No_ DESC
```

期待: v1.3.0 と同一の行数・並び順。

### A-2. SIMPLE モード(kintone クエリ変換)

```sql
SELECT 顧客No, 会社名, 顧客ランク
FROM APP4148
WHERE 顧客ランク = 'A'
ORDER BY 顧客No ASC
LIMIT 100
```

### A-3. 集計(GROUP BY + HAVING)

```sql
SELECT 商談フェーズ, COUNT(*) AS 件数, SUM(売上) AS 売上合計
FROM APP4149
GROUP BY 商談フェーズ
HAVING SUM(売上) > 0
ORDER BY 売上合計 DESC
```

### A-4. WITH(CTE)+ JOIN

```sql
WITH ranked AS (
  SELECT 顧客No, 会社名
  FROM APP4148
  WHERE 顧客ランク = 'A'
)
SELECT r.会社名, b.案件名, b.売上
FROM ranked r
INNER JOIN APP4149 b ON r.顧客No = b.顧客No_
ORDER BY b.売上 DESC
```

### A-5. UNION ALL

```sql
SELECT 案件名, 売上 FROM APP4149 WHERE 商談フェーズ = '受注'
UNION ALL
SELECT 案件名, 売上 FROM APP4149 WHERE 商談フェーズ = '内示'
```

### A-6. EXPLAIN(実 API なし)

```sql
EXPLAIN SELECT a.会社名, b.案件名
FROM APP4148 a INNER JOIN APP4149 b ON a.顧客No = b.顧客No_
WHERE a.顧客ランク = 'A'
```

期待: `mode: FULL_SCAN` / `reason: JOIN あり` / 両アプリの取得計画。実行はされない。

---

## B. v1.4.0 の単文経路の改善確認

### B-1. サブクエリ内の CTE 参照(v1.4.0 で解決)

```sql
WITH high AS (
  SELECT 顧客No FROM APP4148 WHERE 顧客ランク = 'A'
)
SELECT 案件No_, 案件名, 売上
FROM APP4149
WHERE 顧客No_ IN (SELECT 顧客No FROM high)
ORDER BY 案件No_ DESC
```

期待: **A-1 と同等の案件集合**(商談フェーズ条件なしの分は差あり)。旧版ではサブクエリ内の CTE 参照が解決されなかった経路。A-4(JOIN 版)と件数を突き合わせると確認しやすい。

### B-2. IN / EXISTS / スカラーサブクエリ(回帰)

```sql
SELECT 会社名,
  (SELECT MAX(売上) AS m FROM APP4149) AS 全体最大売上
FROM APP4148
WHERE 顧客No IN (SELECT 顧客No_ FROM APP4149 WHERE 商談フェーズ = '受注')
```

期待: 受注案件を持つ顧客のみ。`全体最大売上` は全行同値。

---

## C. 新しいエラーの確認(意図した拒否・v1.4.0 で挙動変化)

| # | SQL | 期待するエラー |
|---|---|---|
| C-1 | `SELECT 会社名 FROM APP4148; SELECT 案件名 FROM APP4149` | `この API は単文のみ受け付けます`(プラグインは複文非対応の明示) |
| C-2 | `CREATE TEMP TABLE #t AS SELECT 顧客No FROM APP4148` | `ArgumentError: CREATE TEMP TABLE requires a batch (temp tables are batch-scoped).` |
| C-3 | `SELECT * FROM #t` | `ParseError: temp table #t is not defined in this batch.` |
| C-4 | `SELECT 会社名 AS #x FROM APP4148` | `エイリアス名に # で始まる名前は使用できません` |
| C-5 | `SELECT 会社名 FROM APP4148 /* メモ` | `ブロックコメントが閉じられていません`(**旧版は無言で通っていた挙動変化**) |
| C-6 | `SELECT # FROM APP4148` | `「#」 の直後には識別子が必要です` |

---

## D. DML 確認ダイアログ(⚠ テスト環境のアプリで実施)

> 書き込みを伴います。本番データでは実施せず、テスト用レコードで行ってください。

### D-1. UPDATE 確認(回帰 — 「更新します」)

```sql
UPDATE APP4149 SET 商談フェーズ = '提案中' WHERE 案件No_ = '<テスト案件No>'
```

期待: 「1 件のレコードを**更新**します。」ダイアログ → OK で反映、キャンセルで中止。

### D-2. INSERT ... SELECT 確認(**v1.4.0 の修正確認**)

```sql
INSERT INTO APP4149 (案件名, 顧客No_)
SELECT 会社名, 顧客No FROM APP4148 WHERE 顧客ランク = 'A' LIMIT 1
```

期待: 「1 件のレコードを**登録**します。」ダイアログが出ること。
- v1.4.0 開発中の不具合(修正済み)ではここが「**削除**します」と誤表示されていた — **「登録します」表示であることを必ず確認**
- キャンセル時は書き込みが発生しないこと
- OK 時は1件だけ追加されること(SELECT 側の LIMIT 1 が効く)

後片付け:

```sql
DELETE FROM APP4149 WHERE 案件名 = '<D-2 で入った会社名>' AND 商談フェーズ = ''
```

(条件はテスト環境の実データに合わせて調整。DELETE 時は「削除します」ダイアログが出ることも同時に確認)

---

## 判定基準まとめ

- A 系: v1.3.0 と結果一致(回帰なし)
- B-1: 旧版で空/エラーだった形が正しい結果を返す
- C 系: 表のエラーメッセージが表示される(silent 失敗・誤実行がない)
- D-2: **「登録します」**(「削除します」なら不具合再発)
