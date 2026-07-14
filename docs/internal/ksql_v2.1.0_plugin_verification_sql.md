# v2.1.0 プラグイン実機テスト SQL

- 作成日: 2026-07-14
- 対象: kintone プラグイン(v2.1.0 ビルド `release/ksql-plugin-v2.1.0.zip`)
- 前提アプリ: APP4148(顧客: `顧客No` / `会社名` / `顧客ランク`)、APP4149(案件: `案件No_` / `案件名` / `商談フェーズ` / `売上` / `顧客No_`)
- 関連: 仕様 [ksql_batch_variables_phase1a_spec.md](ksql_batch_variables_phase1a_spec.md) / 言語リファレンス §25

**v2.1.0 の追加**: **バッチ変数 `SET @var`**。`;` 区切りのバッチ内で `SET @名前 = <式>` により値を一度定義し、後続の文から `@名前` で参照できる。プラグインは実行エンジンをバンドルするため、この挙動はプラグイン上で確認できる。

> **前提**: 変数は **2 文以上のバッチ**でのみ使える。プラグインでは複数文を `;` で区切って入力し実行する（**最後に結果を返した文だけが表示**される）。A・B・D は read-only なので確認ダイアログなしで実行できる。C（時刻固定）は DML のため書き込みが発生する（注意）。
>
> **フィールド型の注意（重要）**: kintone では**フィールド型により使える演算子が異なります**。チェックボックス・複数選択（例では `顧客ランク`・`商談フェーズ` が該当する可能性が高い）は `=` を使えず `in` が必要で、`=` を使うと `GAIA_IQ03: 演算子=を使用できません` になります。**変数は `IN (...)` の要素にも書けます**（v2.1.0）ので、これらのフィールドは `WHERE 顧客ランク IN (@rank)` の形で変数を使えます（A-6）。`=` を使う A-1〜A-5 は、`=` が使えるテキスト（`会社名`・`案件名`）・数値（`売上`）で確認します。

---

## A. 基本（変数の代入と参照）

### A-1. 文字列変数（LIKE・部分一致）

```sql
SET @kw = '株式会社';
SELECT 顧客No, 会社名
FROM APP4148
WHERE 会社名 LIKE @kw
ORDER BY 顧客No DESC
```

期待: 会社名に「株式会社」を含む行（`@kw` が `'株式会社'` に置換され JS 部分一致）。

> `=` を試す場合は、`=` が使えるフィールド（テキスト/数値）で。一覧から実在する会社名をコピーして:
> ```sql
> SET @co = '（実在する会社名をコピー）';
> SELECT 顧客No, 会社名 FROM APP4148 WHERE 会社名 = @co
> ```

### A-2. 数値変数（大小比較）

```sql
SET @min = 1000000;
SELECT 案件No_, 案件名, 売上
FROM APP4149
WHERE 売上 >= @min
ORDER BY 案件No_ DESC
```

期待: `WHERE 売上 >= 1000000` と同じ結果（数値変数として比較）。

### A-3. 同じ変数を複数文で再利用（DRY・一貫性）

```sql
SET @min = 1000000;
SELECT 案件No_, 売上 FROM APP4149 WHERE 売上 >= @min ORDER BY 案件No_ DESC;
SELECT COUNT(*) AS 件数 FROM APP4149 WHERE 売上 >= @min
```

期待: 両方の文が同じ `@min` で絞り込む。プラグインは**最後の文（COUNT）**を表示 → 件数が 1 文目の行数と一致（`@min` を 1 か所で定義して重複記述しない）。

### A-4. 算術式の代入

```sql
SET @threshold = 500000 * 2;
SELECT 案件No_, 売上 FROM APP4149 WHERE 売上 >= @threshold ORDER BY 案件No_ DESC
```

期待: `WHERE 売上 >= 1000000`（右辺の `500000 * 2` が評価される）。

### A-5. 関数の代入（`NOW()` / `TODAY()`）

```sql
SET @today = TODAY();
SELECT 案件No_, 案件名 FROM APP4149 WHERE 案件名 != @today ORDER BY 案件No_ DESC
```

期待: エラーなく実行（`@today` は当日の `YYYY-MM-DD` 文字列。案件名がその文字列と一致しないので全件）。※ `NOW()` / `TODAY()` は代入可、`LOGINUSER()` は不可（D-4）。

### A-6. IN リストで変数を使う（チェックボックス/複数選択フィールド・v2.1.0 で追加）

```sql
SET @rank = 'A';
SELECT 顧客No, 会社名, 顧客ランク
FROM APP4148
WHERE 顧客ランク IN (@rank)
ORDER BY 顧客No DESC
```

期待: `WHERE 顧客ランク IN ('A')` と同じ結果（`顧客ランク` に A を含む行）。**`=` が使えないフィールドでも `IN (@変数)` なら変数を使えます**。複数値は `IN (@a, @b)`:

```sql
SET @a = 'A'; SET @b = 'B';
SELECT 顧客No, 顧客ランク FROM APP4148 WHERE 顧客ランク IN (@a, @b) ORDER BY 顧客No DESC
```

---

## B. ASSERT で変数を使う（実行時ゲート）

### B-1. 変数を ASSERT のオペランドに

```sql
SET @max = 100000;
ASSERT @max > 0;
SELECT 案件No_, 売上 FROM APP4149 WHERE 売上 <= @max ORDER BY 案件No_ DESC
```

期待: `ASSERT @max > 0` は成立（100000 > 0）→ 続行し、SELECT（売上 <= 100000 の案件）を表示。

> **件数ゲートの現行レシピ（1a では `SET @cnt = (SELECT COUNT(*)...)` は不可＝Phase 1b）**: 件数チェックは変数を使わず、ASSERT に**スカラーサブクエリを直接**書けます。
> ```sql
> ASSERT (SELECT COUNT(*) FROM APP4149 WHERE 売上 >= 1000000) >= 0;
> SELECT 案件No_, 売上 FROM APP4149 WHERE 売上 >= 1000000 ORDER BY 案件No_ DESC
> ```

---

## C. 時刻固定（DML・**書き込み注意**）

`SET @now = NOW()` はバッチ内で時刻を固定します（各文で `NOW()` を評価すると値がぶれるのを防ぐ）。**これは UPDATE で書き込みが発生**します。プラグインは文ごとの確認ダイアログ、CLI は `--dry-run` で計画のみ確認できます。**本番データでは実行しないでください**（テスト用フィールド/レコードで）。

```sql
SET @now = NOW();
UPDATE APP4149 SET 更新メモ = @now WHERE 案件No_ = '（テスト用の案件No_）'
```

期待: `更新メモ`（テキスト系フィールド）にバッチ開始時刻（ISO 文字列）が入る。同じバッチ内で `@now` を複数の UPDATE に使えば全文で同一時刻になり、事後検証が `= @now` の完全一致で書ける。

---

## D. エラー系（プラグインでメッセージ確認）

> D 系はいずれも **kintone へ問い合わせる前（パース/静的検証/実行前）にエラー**になるため、フィールド型は関係しません。

### D-1. 単文の `SET` → エラー

```sql
SET @x = 'A'
```

期待: **エラー**「`ArgumentError: SET variable requires a batch.`」（変数は 2 文以上のバッチでのみ使用可）。

### D-2. 未定義変数の参照 → エラー

```sql
SET @kw = '株式会社';
SELECT 顧客No FROM APP4148 WHERE 会社名 LIKE @typo
```

期待: **エラー**「`ParseError: variable @typo is not defined before statement 2.`」（実行前に検出）。

### D-3. 再代入 → エラー

```sql
SET @kw = '株式会社';
SET @kw = '有限会社';
SELECT 顧客No FROM APP4148 WHERE 会社名 LIKE @kw
```

期待: **エラー**「`ParseError: variable @kw is already defined.`」

### D-4. `LOGINUSER()` の代入 → エラー

```sql
SET @u = LOGINUSER();
SELECT 顧客No FROM APP4148 WHERE 会社名 LIKE @u
```

期待: **エラー**「SET の右辺で LOGINUSER() は使用できません（実行環境共通のログインユーザー解決は未対応です）」。

### D-5. スカラーサブクエリ代入 → エラー（Phase 1b）

```sql
SET @cnt = (SELECT COUNT(*) FROM APP4148);
SELECT 顧客No, 会社名 FROM APP4148 ORDER BY 顧客No DESC
```

期待: **エラー**「SET のスカラーサブクエリ代入は Phase 1b で対応予定です」。

### D-6. SET の右辺で別変数を参照 → エラー

```sql
SET @a = 1;
SET @b = @a;
SELECT 顧客No, 会社名 FROM APP4148 ORDER BY 顧客No DESC
```

期待: **エラー**「SET の右辺では他の変数を参照できません（Phase 1a）」。

### D-7. 前方参照（定義前に参照）→ エラー

```sql
SELECT 顧客No FROM APP4148 WHERE 会社名 LIKE @late;
SET @late = '株式会社'
```

期待: **エラー**「`ParseError: variable @late is not defined before statement 1.`」

### D-8. 単文での `@参照`（先行 SET なし）→ エラー

```sql
SELECT 顧客No FROM APP4148 WHERE 会社名 LIKE @kw
```

期待: **エラー**「`ParseError: variable @kw is not defined in a batch.`」

---

## 判定サマリ

| # | 期待 |
|---|------|
| A-1 | 会社名に「株式会社」を含む行（`@kw` 置換・LIKE） |
| A-2 | 売上 >= 1000000 の案件 |
| A-3 | 件数が 1 文目の行数と一致（`@min` 再利用） |
| A-4 | 売上 >= 1000000（`500000 * 2`） |
| A-5 | エラーなく実行（`TODAY()` 代入可） |
| A-6 | `顧客ランク IN (@rank)` が `IN ('A')` と同結果（チェックボックス系でも変数可） |
| B-1 | ASSERT 成立 → SELECT 表示 |
| C | `更新メモ` に固定時刻（書き込み注意） |
| D-1〜D-8 | いずれも実行前エラー（各メッセージ） |

> **フィールド型メモ**: `=` / `!=` はテキスト・数値・ドロップダウン・ラジオで使用可、チェックボックス・複数選択は `in` のみ。**変数は `in` の要素にも書ける**（v2.1.0）ため、チェックボックス系フィールドも `IN (@rank)` で変数を使える（A-6）。1 変数が複数値を持つ配列展開（`IN (@list)`）は後続フェーズ。
>
> **`@profile` との併用**は CLI / MCP でのみ意味を持ちます（プラグインは論理/プロファイル指定に非対応）。CLI 例: `SET @now = NOW(); SELECT * FROM APP100@dev WHERE 作成日時 = @now` は `@profile` と `@変数` が同居しても正しく分離されます。
