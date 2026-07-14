# v1.14.0 プラグイン実機テスト SQL

- 作成日: 2026-07-14
- 対象: kintone プラグイン(v1.14.0 ビルド `dist/ksql-plugin-v1.14.0.zip` / `release/ksql-plugin-v1.14.0.zip`)
- 前提アプリ: APP4148(顧客: `顧客No` / `会社名` / `顧客ランク`)、APP4149(案件: `案件No_` / `案件名` / `商談フェーズ` / `売上` / `顧客No_`)
- 関連: 課題 [ksql_where_rhs_field_and_like_mode_divergence_issue.md](ksql_where_rhs_field_and_like_mode_divergence_issue.md) / 対策 [ksql_where_rhs_field_and_like_fix_spec.md](ksql_where_rhs_field_and_like_fix_spec.md)

プラグインは EXPLAIN / 実行エンジンをバンドルするため、v1.14.0 の **① WHERE 右辺フィールド・文字列関数比較** と **② ワイルドカード LIKE の JS 評価統一** はプラグイン上で確認できます。通常 DML の安全拒否(D)は、プラグインが DML 非対応の場合 **CLI の `--dry-run`** で確認してください(書き込みは発生しません)。

検証観点:
- **A**: 既存クエリの回帰(v1.13.x と同結果)
- **B**: ① 右辺フィールド/文字列関数比較の修正
- **C**: ② ワイルドカード LIKE の前方一致(§6)統一・モード非依存
- **D**: 通常 DML のワイルドカード LIKE 安全拒否
- **E**: EXPLAIN のルーティング表示(任意)

> 一部の「期待結果」はデータ依存です。**修正前(v1.13.2)の挙動**を併記しているので、対比で判定してください。特に B は `顧客No` / `会社名` が **数値化できない文字列**(例: `C-001` / `株式会社〇〇`)のときに差が出ます(純粋な数値コードだと修正前でも偶然通ることがあります)。

---

## A. 回帰確認(v1.13.x と同じ結果になること)

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

期待: v1.13.x と同一の行数・並び順(LIKE も右辺フィールド比較も無いため挙動不変)。

---

## B. ① 右辺フィールド / 文字列関数の文字列比較(修正の中核)

### B-1. 文字列フィールドの自己比較 `=`(→ 全件一致)

```sql
SELECT 顧客No, 会社名
FROM APP4148
WHERE 会社名 = 会社名
ORDER BY 顧客No DESC
```

期待: **APP4148 の全件**(会社名は必ず自分自身と一致)。
- 修正前(v1.13.2): **0 件**(右辺が `Number()` 強制で `"NaN"` 化し不一致)。

### B-2. 文字列フィールドの自己比較 `!=`(→ 0 件)

```sql
SELECT 顧客No, 会社名
FROM APP4148
WHERE 会社名 != 会社名
```

期待: **0 件**。
- 修正前: **全件**(常に不一致扱い)。

### B-3. JOIN の文字列突き合わせ(報告①の JOIN 相当)

`ON` で `a.顧客No = b.顧客No_` を保証済みのため、同じ条件を WHERE の `!=` に置くと 0 件になるはず。

```sql
SELECT a.顧客No, a.会社名, b.案件No_, b.案件名
FROM APP4148 AS a
INNER JOIN APP4149 AS b
  ON a.顧客No = b.顧客No_
WHERE a.顧客No != b.顧客No_
ORDER BY b.案件No_ DESC
```

期待: **0 件**(等値保証済みなので `!=` は成立しない)。
- 修正前: `顧客No` が非数値文字列なら **全件**(完全一致行まで「不一致」として残る = 報告①の JOIN 症状)。

対の確認(`=` 版、全件一致):

```sql
SELECT a.顧客No, a.会社名, b.案件No_, b.案件名
FROM APP4148 AS a
INNER JOIN APP4149 AS b
  ON a.顧客No = b.顧客No_
WHERE a.顧客No = b.顧客No_
ORDER BY b.案件No_ DESC
```

期待: A-1 の JOIN(絞り込み無し)と同じ結合行がすべて出る。
- 修正前: 非数値キーだと **0 件**。

> **注意(実測例): 上記 `=` 版は v1.13.2 でも 16 件返る場合があります。** これは `顧客No` が**正準な数値コード**(`Number()` を通しても表記が変わらない値)のときで、右辺を数値化しても元に戻り**偶然一致**するためです(v1.14.0 でも同じ 16 件 = 回帰なし)。この場合 B-3 は①のビフォー/アフター差を示せません。**JOIN のまま①を確実に示す**には、数値キーではなく**文字列フィールドの自己比較**を使ってください:

```sql
-- JOIN 内での ① 実証(文字列フィールド)
SELECT a.顧客No, a.会社名, b.案件No_, b.案件名
FROM APP4148 AS a
INNER JOIN APP4149 AS b
  ON a.顧客No = b.顧客No_
WHERE b.案件名 = b.案件名          -- 期待: 全件 / 修正前(v1.13.2): 0 件
ORDER BY b.案件No_ DESC
```

```sql
SELECT a.顧客No, a.会社名, b.案件No_, b.案件名
FROM APP4148 AS a
INNER JOIN APP4149 AS b
  ON a.顧客No = b.顧客No_
WHERE b.案件名 != b.案件名         -- 期待: 0 件 / 修正前(v1.13.2): 全件
ORDER BY b.案件No_ DESC
```

`=` 版が全件(例: 16 件)、`!=` 版が 0 件になれば①の修正が確認できます(修正前は逆)。

### B-4. 右辺に文字列関数(REPLACE)

恒等 REPLACE(`'株式会社'` を `'株式会社'` に置換=無変化)なので `会社名` と一致するはず。

```sql
SELECT 顧客No, 会社名
FROM APP4148
WHERE 会社名 = REPLACE(会社名, '株式会社', '株式会社')
ORDER BY 顧客No DESC
```

期待: **全件**。
- 修正前: **0 件**(右辺文字列関数の結果も数値化され `"NaN"`)。

### B-5. 数値・算術式の回帰確認(挙動が変わらないこと)

```sql
SELECT b.案件No_, b.売上
FROM APP4149 AS b
WHERE b.売上 = b.売上
ORDER BY b.案件No_ DESC
```

期待: **全件**(数値フィールド自己比較。修正前・後とも一致 = 回帰なし)。

---

## C. ② ワイルドカード LIKE の前方一致(§6)統一・モード非依存

### C-1. 前方一致 `'株式会社%'`(= 株式会社で始まる)

```sql
SELECT 顧客No, 会社名
FROM APP4148
WHERE 会社名 LIKE '株式会社%'
ORDER BY 顧客No DESC
```

期待: **会社名が「株式会社」で始まる行のみ**。結果の全 `会社名` が「株式会社」始まりであることを目視確認。
- 修正前: 単純 SELECT は SIMPLE で kintone の `like`(単語検索・`%` 非ワイルドカード)へ委譲され、**前方一致にならない**ことがあった。

### C-2. 同条件を関数付きで強制 FULL_SCAN(モード非依存の確認)

```sql
SELECT 顧客No, 会社名
FROM APP4148
WHERE 会社名 LIKE '株式会社%' AND LENGTH(会社名) >= 0
ORDER BY 顧客No DESC
```

期待: **C-1 と完全に同じ行**(`LENGTH(...) >= 0` は常に真の無害条件だが FULL_SCAN に切り替わる)。
- 修正前: C-1(SIMPLE)と C-2(FULL_SCAN)で **同じ SQL の結果が食い違う**ことがあった(報告②の本質)。**両者が一致すれば修正確認**。

### C-3. 部分一致は `%…%` を明示(新仕様の確認)

```sql
SELECT 顧客No, 会社名
FROM APP4148
WHERE 会社名 LIKE '%物産%'
ORDER BY 顧客No DESC
```

期待: **会社名に「物産」を含む行**。C-1(前方一致)とは異なる/より広い集合になることを確認。「含む」検索は `%…%` を明示する運用に統一。

### C-4. JOIN + ワイルドカード LIKE(押し下げ除外・中央ガード非該当の確認)

```sql
SELECT a.顧客No, a.会社名, b.案件No_, b.案件名, b.商談フェーズ
FROM APP4148 AS a
INNER JOIN APP4149 AS b
  ON a.顧客No = b.顧客No_
WHERE b.案件名 LIKE '新規%'
ORDER BY b.案件No_ DESC
```

期待: **案件名が「新規」で始まる案件のみ**。エラーにならず結果が返る(ワイルドカード LIKE は JOIN 押し下げから除外され JS で評価。中央ガードには到達しない)。

### C-5. NOT LIKE(否定形)

```sql
SELECT 案件No_, 案件名
FROM APP4149
WHERE 案件名 NOT LIKE '%テスト%'
ORDER BY 案件No_ DESC
```

期待: **案件名に「テスト」を含まない行**。

---

## D. 通常 DML のワイルドカード LIKE 安全拒否

> プラグインが DML 非対応の場合は CLI で確認。**`--dry-run` を付ければ書き込みは発生しません**(変換段階で拒否されるため dry-run でもエラーになります)。実行例: `ksql --dry-run -e "…"`。

### D-1. UPDATE + ワイルドカード LIKE(→ 拒否)

```sql
UPDATE APP4149 SET 商談フェーズ = '受注' WHERE 案件名 LIKE '%内示%'
```

期待: **エラー(`DmlConvertError`)**。メッセージに「ワイルドカード（% / _）付き LIKE は使用できません」「SELECT で対象レコード番号を確認し、IN または完全一致で対象を指定」。
- 修正前: kintone の単語検索で対象を決めて**実行できてしまい、意図しない案件を更新する恐れ**があった。

回避策(正しい運用):

```sql
-- 1) まず対象を SELECT で確認
SELECT 案件No_, 案件名 FROM APP4149 WHERE 案件名 LIKE '%内示%' ORDER BY 案件No_ DESC;
-- 2) 確認した案件No_ を IN / 完全一致で指定して UPDATE
UPDATE APP4149 SET 商談フェーズ = '受注' WHERE 案件No_ IN ('（確認した案件No_）')
```

### D-2. DELETE + ワイルドカード LIKE(→ 拒否)

```sql
DELETE FROM APP4149 WHERE 案件名 LIKE '一時%'
```

期待: **エラー(`DmlConvertError`)**。

### D-3. ワイルドカードなし DML は従来どおり(回帰確認)

```sql
-- 完全一致 WHERE は従来どおり実行可(--dry-run で対象件数のみ確認)
UPDATE APP4149 SET 商談フェーズ = '受注' WHERE 案件No_ = '（存在する案件No_）'
```

期待: 従来どおり変換・実行される(ワイルドカードを含まないため拒否されない)。

---

## E. EXPLAIN のルーティング表示(任意)

### E-1. ワイルドカード LIKE は FULL_SCAN

```sql
EXPLAIN SELECT 顧客No, 会社名 FROM APP4148 WHERE 会社名 LIKE '株式会社%'
```

期待: `mode: FULL_SCAN`、`reason` に「WHERE 句に JS 評価が必要な式」。

### E-2. ワイルドカードなし LIKE は従来どおり(単純 SELECT は SIMPLE)

```sql
EXPLAIN SELECT 顧客No, 会社名 FROM APP4148 WHERE 会社名 LIKE '株式会社'
```

期待: `mode: SIMPLE`(kintone へ委譲。`会社名 like "株式会社"`)。

---

## 判定サマリ

| # | 期待 | 修正前(v1.13.2) |
|---|------|-----------------|
| B-1 | 全件 | 0 件 |
| B-2 | 0 件 | 全件 |
| B-3 (`!=`) | 0 件 | 非数値キーなら全件 |
| B-4 (REPLACE) | 全件 | 0 件 |
| B-5 (数値) | 全件 | 全件(回帰なし) |
| C-1 と C-2 | **一致** | 食い違う場合あり |
| C-4 (JOIN+LIKE) | 前方一致で返る | 押し下げで結果が異なる恐れ |
| D-1 / D-2 | エラー拒否 | 実行できてしまう |
| D-3 | 実行可 | 実行可(回帰なし) |
