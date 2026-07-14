# v2.0.0 プラグイン実機テスト SQL

- 作成日: 2026-07-14
- 対象: kintone プラグイン(v2.0.0 ビルド `release/ksql-plugin-v2.0.0.zip`)
- 前提アプリ: APP4148(顧客: `顧客No` / `会社名` / `顧客ランク`)、APP4149(案件: `案件No_` / `案件名` / `商談フェーズ` / `売上` / `顧客No_`)
- 関連: 仕様 [ksql_like_js_default_optin_pushdown_spec.md](ksql_like_js_default_optin_pushdown_spec.md)(R5・JS-only)

**v2.0.0 の変更点(Breaking)**: **あらゆる LIKE / NOT LIKE を JavaScript(kSQL §6 意味論)でのみ評価**し、kintone へ押し下げない。プラグインは実行エンジンをバンドルするため、この挙動はプラグイン上で確認できる。通常 DML の LIKE 拒否(D)は、プラグインが DML 非対応の場合 **CLI の `--dry-run`** で確認(書き込みは発生しない)。

> **kSQL §6 意味論**: `%`/`_` 付き=SQL ワイルドカード(前方/部分一致)、ワイルドカードなし=**kSQL 独自の部分一致(contains)**。
> **v1.14.0 との差**: v1.14.0 では**ワイルドカードなし LIKE は kintone(単語検索)へ委譲・SIMPLE**だったが、v2.0.0 では**JS の部分一致・FULL_SCAN** になる。結果件数・実行モードが変わり得る。
> 一部の期待結果はデータ依存。以下では自己検証できる形(件数の一致・包含関係)を併記しているので、データを知らなくても判定できる。例の部分文字列(`東京` 等)は貴社データに存在する語へ置き換えてよい。

---

## A. 回帰確認(LIKE を含まないクエリは v1.14.0 と同結果)

### A-1. 基準クエリ(JOIN + IN + ORDER BY)

```sql
SELECT
  a.顧客No, a.会社名, a.顧客ランク,
  b.案件No_, b.案件名, b.商談フェーズ, b.売上
FROM APP4148 AS a
INNER JOIN APP4149 AS b
  ON a.顧客No = b.顧客No_
WHERE b.商談フェーズ IN ('提案中', '内示', '受注')
AND a.顧客ランク IN ('A')
ORDER BY b.案件No_ DESC
```

期待: v1.14.0 と同一の行数・並び順(LIKE なしのため挙動不変)。

---

## B. 非ワイルドカード LIKE の新挙動(v2.0.0 の目玉)

### B-1. 裸 LIKE は「含む(contains)」= JS 評価

```sql
SELECT 顧客No, 会社名
FROM APP4148
WHERE 会社名 LIKE '東京'
ORDER BY 顧客No DESC
```

期待: **会社名が「東京」を含む行**(前方一致ではなく contains)。結果の全 `会社名` に「東京」が含まれることを目視。
- v1.14.0(参考): kintone の単語検索へ委譲(SIMPLE)。トークン境界等で件数が異なることがあった。
- v2.0.0: JS の contains で評価(FULL_SCAN)。

### B-2. 裸 LIKE と `%…%` が一致(自己検証・データ非依存)

同じ結果集合になるはず(どちらも JS の contains)。

```sql
-- (a) 裸
SELECT 顧客No, 会社名 FROM APP4148 WHERE 会社名 LIKE '東京'
```
```sql
-- (b) %…%
SELECT 顧客No, 会社名 FROM APP4148 WHERE 会社名 LIKE '%東京%'
```

期待: **(a) と (b) の件数・レコードが完全一致**。
- v2.0.0 ではどちらも JS contains のため一致する。v1.14.0 では (a)=kintone / (b)=JS で食い違う可能性があった。**一致すれば v2.0.0 の統一を確認**。

### B-3. 前方一致 `'東京%'`(包含関係の自己検証)

```sql
SELECT 顧客No, 会社名
FROM APP4148
WHERE 会社名 LIKE '東京%'
ORDER BY 顧客No DESC
```

期待: **会社名が「東京」で始まる行のみ**。B-1(contains)の**部分集合**になる(件数: `'東京%'` ≤ `'東京'`)。

---

## C. モード非依存(全 LIKE が JS)

### C-1. 3 形態が同一結果(自己検証)

```sql
-- (a) 裸(単一テーブル → v2.0.0 は FULL_SCAN)
SELECT 顧客No, 会社名 FROM APP4148 WHERE 会社名 LIKE '東京'
```
```sql
-- (b) 関数併記で強制 FULL_SCAN(無害条件)
SELECT 顧客No, 会社名 FROM APP4148 WHERE 会社名 LIKE '東京' AND LENGTH(会社名) >= 0
```
```sql
-- (c) %…%
SELECT 顧客No, 会社名 FROM APP4148 WHERE 会社名 LIKE '%東京%'
```

期待: **(a) = (b) = (c) が完全一致**。実行モード(SIMPLE/FULL_SCAN)やワイルドカード有無に関わらず、LIKE は常に JS で同じ結果になる(v2.0.0 の一貫化)。

### C-2. JOIN + LIKE(エラーにならず JS 評価)

```sql
SELECT a.顧客No, a.会社名, b.案件No_, b.案件名
FROM APP4148 AS a
INNER JOIN APP4149 AS b ON a.顧客No = b.顧客No_
WHERE b.案件名 LIKE '新規'
ORDER BY b.案件No_ DESC
```

期待: **案件名が「新規」を含む案件のみ**。エラーにならず返る(LIKE は JOIN 押し下げから除外され JS 評価)。

---

## D. 通常 DML の LIKE 全拒否(v2.0.0)

> プラグインが DML 非対応の場合は CLI で確認。`--dry-run` で書き込みは発生しない(変換段階で拒否)。

### D-1. 裸 LIKE の UPDATE → 拒否(v2.0.0 の変更点)

```sql
UPDATE APP4149 SET 商談フェーズ = '受注' WHERE 案件名 LIKE '報告'
```

期待: **エラー(`DmlConvertError`)**。メッセージに「LIKE / NOT LIKE は使用できません」「SELECT で対象レコード番号を確認し、IN または完全一致で対象を指定」。
- **v1.14.0 との差**: v1.14.0 では**裸 LIKE の DML は許可**(kintone 押し下げ)されていた。v2.0.0 で拒否に変わる。

### D-2. ワイルドカード LIKE / NOT LIKE の DML → 拒否

```sql
UPDATE APP4149 SET 商談フェーズ = '受注' WHERE 案件名 LIKE '%報告%'
```
```sql
DELETE FROM APP4149 WHERE 案件名 NOT LIKE '一時'
```

期待: いずれも **`DmlConvertError`**。

### D-3. 完全一致・IN の DML → 従来どおり(回帰)

```sql
UPDATE APP4149 SET 商談フェーズ = '受注' WHERE 案件No_ = '（存在する案件No_）'
```

期待: 変換・実行される(LIKE を含まないため拒否されない)。移行運用: 先に SELECT で対象を確認 → `案件No_ IN (...)` で DML。

---

## E. EXPLAIN(ルーティング表示)

### E-1. 裸 LIKE も FULL_SCAN + LIKE 固有理由(v2.0.0)

```sql
EXPLAIN SELECT 顧客No, 会社名 FROM APP4148 WHERE 会社名 LIKE '会社'
```

期待: `mode: FULL_SCAN`、`reason` に **「LIKE は常に JS 評価のため全件取得」**。
- **v1.14.0 との差**: v1.14.0 では裸 LIKE は `mode: SIMPLE`(kintone 委譲)だった。v2.0.0 で FULL_SCAN に変わる。

---

## 判定サマリ

| # | 期待 | v1.14.0(参考) |
|---|------|-----------------|
| B-1 | 会社名に「東京」を含む行(contains) | kintone 単語検索(件数が異なり得る) |
| B-2 | 裸 `'東京'` と `'%東京%'` が**一致** | 食い違う可能性 |
| B-3 | `'東京%'` は B-1 の部分集合(前方一致) | 同左 |
| C-1 | 裸 / 関数併記 / `%…%` が**全一致** | モードで食い違う可能性 |
| C-2 | JOIN + LIKE がエラーなく contains 評価 | 同左(押し下げ除外) |
| D-1 | 裸 LIKE DML → **拒否** | **許可**されていた |
| D-2 | ワイルドカード LIKE / NOT LIKE DML → 拒否 | 拒否(v1.14.0 から) |
| D-3 | 完全一致・IN の DML → 実行可 | 実行可 |
| E-1 | 裸 LIKE → **FULL_SCAN** + LIKE 固有理由 | **SIMPLE** だった |

> **性能上の注意(v2.0.0)**: 裸 LIKE も全件取得になる。大規模アプリでは一致件数に関わらず**全走査件数が `maxRecords`(既定 10,000)に到達し得る**。到達時は既定でエラー(`onLimitReached="error"`)。件数が多い場合は絞り込み条件の併記(現状は取得量は減らないが将来の述語分割で改善予定)や `maxRecords` 調整を検討。
