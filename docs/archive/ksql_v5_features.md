# ksql v5 追加仕様

v5 ではサブテーブル運用を中心に、以下の機能を追加しました。

---

## 1. サブテーブル仮想テーブル

`APP100$明細` 形式でサブテーブルを通常テーブルのように参照できます。

```sql
SELECT * FROM APP100$明細
SELECT _p.伝票番号, 商品コード, 数量 FROM APP100$明細
```

### システム列（v5 正式名）

| 列名 | 意味 |
|---|---|
| `_pid` | 親レコード ID（`$id`） |
| `_rid` | サブテーブル行 ID |
| `_idx` | 親レコード内の行順（0-based） |

> 旧長名（`_parent_record_id` / `_row_id` / `_row_index`）は廃止し、短縮名に統一。

---

## 2. 親項目ショートカット（`_p`）

サブテーブルクエリ内で親項目を直接参照できます。

```sql
SELECT _p.伝票番号, 商品コード, 数量
FROM APP100$明細
WHERE _p.伝票番号 LIKE 'S%'
```

### `_p.*` 一括展開

```sql
SELECT _p.*, 商品コード, 数量
FROM APP100$明細
```

- `SELECT *` には `_p.*` を暗黙追加しません（結果肥大化回避）
- 親項目が必要なときだけ明示指定します

---

## 3. サブテーブル DML（INSERT / UPDATE / DELETE）

サブテーブル行の追加・更新・削除を SQL で実行できます。

### INSERT（行追加）

```sql
INSERT INTO APP100$明細 (_pid, 商品コード, 数量)
VALUES (123, 'A-001', 2)
```

- `_pid` 必須
- 末尾追加で保存

### UPDATE（行更新）

```sql
UPDATE APP100$明細
SET 数量 = 5
WHERE _pid = 123 AND _rid = '67890'
```

- 安全のため `_rid` 条件必須

### DELETE（行削除）

```sql
DELETE FROM APP100$明細
WHERE _pid = 123 AND _rid = '67890'
```

- 安全のため `_rid` 条件必須

---

## 4. REORDER（並び替え）

親単位でサブテーブル行を並び替えできます。

### 条件付き並び替え

```sql
REORDER APP100$明細
BY 商品コード ASC, 納期 DESC
WHERE _pid = 123
```

### 全件並び替え（明示構文）

```sql
REORDER ALL APP100$明細
BY 商品コード ASC
```

### 制約

- `REORDER` は `WHERE` 必須
- `REORDER ALL` は `WHERE` 併用不可
- `_idx` は参照専用（`UPDATE SET _idx=...` 不可）

---

## 5. REORDER の更新方式（重要）

`REORDER` は **行の `id` のみ送信**して順序を更新します。  
行値（`value`）は再送しません。

目的:
- テーブル内ルックアップ項目がある場合でも、並び替え時の再評価・コピー値変化リスクを最小化するため

---

## 6. UI 表示改善

`REORDER` / `REORDER ALL` の実行結果表示を追加しました。

表示例:
- `N 件の親レコードで並び順を更新しました。`

---

## v5 機能一覧まとめ

| 機能 | 構文例 |
|---|---|
| サブテーブル参照 | `SELECT * FROM APP100$明細` |
| 親項目参照 | `SELECT _p.伝票番号 FROM APP100$明細` |
| 親項目一括展開 | `SELECT _p.* FROM APP100$明細` |
| 行追加 | `INSERT INTO APP100$明細 (_pid, ...) VALUES (...)` |
| 行更新 | `UPDATE APP100$明細 SET ... WHERE _rid='...'` |
| 行削除 | `DELETE FROM APP100$明細 WHERE _rid='...'` |
| 並び替え | `REORDER APP100$明細 BY ... WHERE _pid=...` |
| 全件並び替え | `REORDER ALL APP100$明細 BY ...` |

