# v1.4.0 プラグイン実機テスト SQL

- 作成日: 2026-07-09
- 対象: kintone プラグイン(v1.4.0 ビルド `dist/ksql-plugin-v1.4.0.zip`)
- 前提アプリ: APP4148(顧客: `顧客No` / `会社名` / `顧客ランク`)、APP4149(案件: `案件No_` / `案件名` / `商談フェーズ` / `売上` / `顧客No_`)

**プラグイン UI は read-only バッチ + 一時テーブルに対応**しています(最終結果のみ表示。仕様 §8.4)。DML を含むバッチは CLI / MCP で検証します。プラグイン観点は、①既存クエリの回帰(A)、②単文経路の改善(B)、③新しく出るようになったエラー(C)、④DML 確認ダイアログ(D)、⑤**バッチ実行(E)**、の5つです。

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
WHERE 顧客ランク IN ('A')
ORDER BY 顧客No ASC
LIMIT 100
```

### A-3. 集計(GROUP BY + HAVING)— **v1.4.0 のバグ修正確認**

```sql
SELECT 商談フェーズ, COUNT(*) AS 件数, SUM(売上) AS 売上合計
FROM APP4149
GROUP BY 商談フェーズ
HAVING SUM(売上) > 0
ORDER BY 売上合計 DESC
```

期待: HAVING なし版と同じグループが返る(売上合計 > 0 のグループのみ)。
**v1.3.0 以前は「集計列に alias を付けると HAVING が常に偽になる」既存バグにより0件になっていた**(実機検証で発見・v1.4.0 で修正)。0件になったら不具合再発。

### A-4. WITH(CTE)+ JOIN

```sql
WITH ranked AS (
  SELECT 顧客No, 会社名
  FROM APP4148
  WHERE 顧客ランク IN ('A')
)
SELECT r.会社名, b.案件名, b.売上
FROM ranked r
INNER JOIN APP4149 b ON r.顧客No = b.顧客No_
ORDER BY b.売上 DESC
```

### A-5. UNION ALL

```sql
SELECT 案件名, 売上 FROM APP4149 WHERE 商談フェーズ IN ('受注')
UNION ALL
SELECT 案件名, 売上 FROM APP4149 WHERE 商談フェーズ IN ('内示')
```

期待: 受注案件(8件)+ 内示案件(2件)= 10 行(A-3 の件数と整合)。
選択系フィールド(商談フェーズ / 顧客ランク)は kintone クエリの制約で `=` が使えないため、本書の SQL はすべて `IN (...)` を使用している。

### A-6. EXPLAIN(実 API なし)

```sql
EXPLAIN SELECT a.会社名, b.案件名
FROM APP4148 a INNER JOIN APP4149 b ON a.顧客No = b.顧客No_
WHERE a.顧客ランク IN ('A')
```

期待: `mode: FULL_SCAN` / `reason: JOIN あり` / 両アプリの取得計画。実行はされない。

---

## B. v1.4.0 の単文経路の改善確認

### B-1. サブクエリ内の CTE 参照(v1.4.0 で解決)

```sql
WITH high AS (
  SELECT 顧客No FROM APP4148 WHERE 顧客ランク IN ('A')
)
SELECT 案件No_, 案件名, 売上
FROM APP4149
WHERE 顧客No_ IN (SELECT 顧客No FROM high)
ORDER BY 案件No_ DESC
```

期待: **A-4(JOIN 版)と同等の案件集合**(A-1 とは商談フェーズ条件の有無で差が出る)。旧版ではサブクエリ内の CTE 参照が解決されなかった経路なので、A-4 と件数を突き合わせて一致することを確認する。

### B-2. IN / EXISTS / スカラーサブクエリ(回帰)

```sql
SELECT 会社名,
  (SELECT MAX(売上) AS m FROM APP4149) AS 全体最大売上
FROM APP4148
WHERE 顧客No IN (SELECT 顧客No_ FROM APP4149 WHERE 商談フェーズ IN ('受注'))
```

期待: 受注案件を持つ顧客のみ。`全体最大売上` は全行同値。

---

## C. 新しいエラーの確認(意図した拒否・v1.4.0 で挙動変化)

| # | SQL | 期待するエラー |
|---|---|---|
| ~~C-1~~ | ~~複文はエラー~~ | **削除** — read-only バッチ対応(E 系)により、複文は最終結果のみ表示で実行される |
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
SELECT 会社名, 顧客No FROM APP4148 WHERE 顧客ランク IN ('A') LIMIT 1
```

期待: 「1 件のレコードを**登録**します。」ダイアログが出ること。
- v1.4.0 開発中の不具合(修正済み)ではここが「**削除**します」と誤表示されていた — **「登録します」表示であることを必ず確認**
- キャンセル時は書き込みが発生しないこと
- OK 時は1件だけ追加されること(SELECT 側の LIMIT 1 が効く)

後片付け:

```sql
DELETE FROM APP4149 WHERE $id = <D-2 で追加されたレコード番号>
```

(`$id` は D-2 実行後にレコードで確認。DELETE 時は「削除します」ダイアログが出ることも同時に確認)

---

## E. プラグインのバッチ実行(read-only・最終結果のみ表示)

> v1.4.0 でプラグインも read-only バッチ + 一時テーブルに対応(仕様 §8.4)。表示されるのは**最後に結果セットを返した文**のみ。

### E-1. 一時テーブル経由の2段クエリ(最終 SELECT のみ表示)

```sql
CREATE TEMP TABLE #a顧客 AS
SELECT 顧客No, 会社名 FROM APP4148 WHERE 顧客ランク IN ('A');

SELECT t.会社名, b.案件名, b.売上
FROM #a顧客 t
INNER JOIN APP4149 b ON t.顧客No = b.顧客No_
ORDER BY b.売上 DESC;
```

期待: 最終 SELECT の結果のみ表示(A-4 と同等の結果)。CREATE の実体化結果は表示されない。

### E-2. 一時テーブルの連鎖 + 集計

```sql
CREATE TEMP TABLE #受注 AS
SELECT 顧客No_, 売上 FROM APP4149 WHERE 商談フェーズ IN ('受注');

CREATE TEMP TABLE #顧客別 AS
SELECT 顧客No_, SUM(売上) AS 合計 FROM #受注 GROUP BY 顧客No_;

SELECT * FROM #顧客別 ORDER BY 合計 DESC;
```

期待: 顧客別の受注合計のみ表示(2つの CREATE は表示されない)。

### E-3. 最終文が DROP のバッチ

```sql
CREATE TEMP TABLE #t AS SELECT 顧客No FROM APP4148;
DROP TEMP TABLE #t;
```

期待: 「バッチ 2 文を実行しました(結果セットなし)。」の情報表示。

### E-4. DML を含むバッチ(v1.9.0 で解禁 — 文ごとの確認ダイアログ付きで実行)

> v1.4.0〜v1.8.0 は `ArgumentError: プラグインのバッチ実行は read-only 文のみ対応しています(...)` で拒否。v1.9.0 から以下の挙動に変更(仕様: `docs/internal/ksql_plugin_dml_batch_spec.md`)。

#### E-4a. SELECT-based DML バッチ(実行時確認・確定件数)

```sql
CREATE TEMP TABLE #targets AS SELECT 会社名, $id AS 顧客No FROM APP4148 WHERE 顧客ランク IN ('A') LIMIT 2;
UPSERT INTO APP4149 (案件名, 顧客No_) SELECT 会社名, 顧客No FROM #targets ON DUPLICATE (案件名);
SELECT 案件名, 顧客No_ FROM APP4149 WHERE 顧客No_ <> '' ORDER BY 顧客No_
```

期待: `[2/3] UPSERT_SELECT INTO APP4149` + 「2 件のレコードを登録/更新します」の確認ダイアログ → OK で実行 → 最終 SELECT の結果テーブルの上に「バッチ 3 文を実行しました。」+ `[2] UPSERT_SELECT: inserted=... updated=...` のサマリ行。

#### E-4b. 実行時確認のキャンセル(先行文は反映済み)

E-4a のダイアログで**キャンセル**を押す。

期待: 「キャンセルしました(文 [2/3] で中断。[1] までの実行結果は反映済みです)」の情報表示(エラー表示ではない)。3文目は実行されない。履歴には保存されない。

#### E-4c. INSERT VALUES を含むバッチ(実行前静的確認)

```sql
CREATE TEMP TABLE #t AS SELECT 顧客No FROM APP4148 WHERE 顧客ランク IN ('A');
INSERT INTO APP4149 (案件名) VALUES ('検証案件X'), ('検証案件Y');
SELECT 案件名 FROM APP4149 WHERE 案件名 LIKE '検証案件%'
```

期待: **バッチ実行前**に `[2/3] INSERT INTO APP4149` + 「2 件のレコードを登録します」の確認ダイアログ。キャンセルすると**1文も実行されない**(「キャンセルしました(文 [2/3] の実行前確認。バッチは実行されていません)」)。

#### E-4d. 単文 INSERT VALUES の確認(v1.9.0 併修)

```sql
INSERT INTO APP4149 (案件名) VALUES ('検証案件Z')
```

期待: `INSERT INTO APP4149` + 「1 件のレコードを登録します」の確認ダイアログが出る(v1.8.0 以前は確認なしで書き込まれていた)。キャンセルで「キャンセルしました(対象: 1 件)」。

### E-5. バッチの EXPLAIN(実行されないこと)

E-1 の SQL を入力したまま **EXPLAIN ボタン**を押す。

期待: 全文のプラン(`[1] CREATE_TEMP_TABLE` のスコープ・行数不明、`[2] SELECT` の FULL_SCAN(一時テーブル参照))が表示され、**クエリは実行されない**(結果テーブルではなくプラン行が出る)。

### E-6. 途中文の実行時エラー(fail-fast の番号付き表示)

```sql
CREATE TEMP TABLE #t AS SELECT 顧客No FROM APP9999999;
SELECT * FROM #t;
```

期待: `[1] ...`(存在しないアプリのエラー)が表示され、2文目は実行されない。

## 判定基準まとめ

- A 系: v1.3.0 と結果一致(回帰なし)。A-3 は HAVING バグ修正の確認
- B-1: 旧版で空/エラーだった形が正しい結果を返す
- C 系: 表のエラーメッセージが表示される(silent 失敗・誤実行がない)。※C-1(複文エラー)は E 系対応により**該当しなくなった**ため削除 — 複文は E 系の挙動が正
- D-2: **「登録します」**(「削除します」なら不具合再発)
- E 系: 最終結果のみ表示 / DML バッチは文ごと確認付きで実行(E-4a〜d。v1.9.0) / EXPLAIN ボタンで実行されない
