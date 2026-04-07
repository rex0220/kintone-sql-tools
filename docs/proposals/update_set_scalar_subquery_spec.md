# UPDATE SET スカラーサブクエリ 仕様書

## 概要

`UPDATE SET` の右辺にスカラーサブクエリ `(SELECT ...)` を指定できます。  
サブクエリは実行前に 1 回だけ評価され、対象レコード全件に同じ値が設定されます。

---

## 構文

```sql
UPDATE アプリ SET フィールド = (SELECT 集計 FROM アプリ [WHERE ...]) WHERE 条件

-- 複数フィールド（通常 SET / 算術 SET との混在も可）
UPDATE アプリ SET
  フィールドA = (SELECT ...),
  フィールドB = フィールドB * 1.1,
  フィールドC = '固定値'
WHERE 条件
```

---

## 使用例

### 例 1 — 同アプリの最大値でセット

```sql
UPDATE APP88 SET 上限費用 = (SELECT MAX(合計費用) FROM APP88)
WHERE 確度 in ('80%', '100%')
```

### 例 2 — 別アプリの値でセット

```sql
UPDATE APP89 SET 顧客ランク = (SELECT 最高ランク FROM APP90 WHERE 区分 = '基準')
WHERE 顧客ランク in ('B')
```

### 例 3 — 通常 SET との混在

```sql
UPDATE APP88 SET
  合計費用   = 合計費用 * 1.1,
  上限費用   = (SELECT MAX(合計費用) FROM APP88),
  ステータス = '更新済み'
WHERE 確度 in ('80%', '100%')
```

---

## 制約

| 項目 | 内容 |
|---|---|
| 返却行数 | 1 行 1 列のみ（0 行はエラー、2 行以上もエラー） |
| 相関サブクエリ | 非対応（外側テーブルのフィールドを参照不可） |
| サブクエリ後の算術 | 非対応 — 算術はサブクエリ内で行う |
| 対象 | SET 右辺のみ（WHERE 右辺は既存の SCALAR_SUBQUERY で対応済み） |

```sql
-- NG: サブクエリ後の算術
UPDATE APP88 SET 上限費用 = (SELECT AVG(合計費用) FROM APP88) * 1.1
WHERE 確度 in ('80%', '100%')

-- OK: 算術をサブクエリ内で実行
UPDATE APP88 SET 上限費用 = (SELECT AVG(合計費用) * 1.1 FROM APP88)
WHERE 確度 in ('80%', '100%')
```

---

## 実行フロー

```
① SET を全走査し SCALAR_SUBQUERY を検出
       ↓
② 各サブクエリを事前実行（非相関 → 1 回のみ API コール）
   結果を StringLiteral / NumberLiteral に変換して Assignment に上書き
       ↓
③ WHERE → kintone クエリ変換（または JS 評価）で対象 $id を取得
       ↓
④ 解決済みの値で PUT バッチ送信（100 件ごとに分割）
```

サブクエリは非相関のため全レコードに同じ値が適用されます。  
手順 ② で `Assignment.value` を `StringLiteral` に差し替えることで、  
既存の通常 SET / 算術 SET の実行パスをそのまま利用できます。

---

## EXPLAIN 出力

```sql
EXPLAIN UPDATE APP88
SET 上限費用 = (SELECT MAX(合計費用) FROM APP88)
WHERE 確度 in ('80%', '100%')
```

```
  [UPDATE]
  app:           APP88 (88)
  kintone query: 確度 in ("80%","100%")
  api:           GET /k/v1/records.json → PUT /k/v1/records.json
  set type:      スカラーサブクエリ SET
  set fields:
    上限費用 = (SELECT MAX(合計費用) FROM APP88)

[subquery: 上限費用]
  mode:          FULL_SCAN
  reason:        集計関数（COUNT / SUM 等）あり
  app:           APP88 (88)
  kintone query: (全件取得)
  fields:        (全フィールド)
```

通常 SET / 算術 SET との混在時:

```sql
EXPLAIN UPDATE APP88 SET
  合計費用 = 合計費用 * 1.1,
  上限費用 = (SELECT MAX(合計費用) FROM APP88)
WHERE 確度 in ('80%', '100%')
```

```
  [UPDATE]
  app:           APP88 (88)
  kintone query: 確度 in ("80%","100%")
  api:           GET /k/v1/records.json → PUT /k/v1/records.json
  set type:      算術 SET（現在値を取得して計算）, スカラーサブクエリ SET
  ref fields:    合計費用（GET に含める）
  set fields:
    合計費用 = 合計費用 * 1.1
    上限費用 = (SELECT MAX(合計費用) FROM APP88)

[subquery: 上限費用]
  mode:          FULL_SCAN
  reason:        集計関数（COUNT / SUM 等）あり
  app:           APP88 (88)
  kintone query: (全件取得)
  fields:        (全フィールド)
```

---

## AST 設計

### 変更なし

`Assignment.value` の型は `SqlValue | ArithExpr` であり、`SqlValue` には既に `ScalarSubquery` が含まれます。

```ts
// ast.ts — 既存（変更なし）
export interface Assignment {
  field: string;
  value: SqlValue | ArithExpr;  // SqlValue は ScalarSubquery を含む ✅
}

export type SqlValue =
  | StringLiteral
  | NumberLiteral
  | KintoneFuncValue
  | InList
  | SubqueryInList
  | ArithSqlValue
  | CaseSqlValue
  | ScalarSubquery;   // ← これが SET 右辺にも使われる
```

---

## パーサー設計

`parseAssignmentValue()` に `(` で始まる場合のスカラーサブクエリを追加します。

```
parseAssignmentValue():
  if peek() == LPAREN:
    advance()               // ( を消費
    if peek() == SELECT:
      q = parseSelect()
      expect(RPAREN)
      return { type: "SCALAR_SUBQUERY", query: q }
    else:
      // 括弧内の算術式（既存パス）
  ...
```

---

## 実行エンジン設計

### resolveSetSubqueries()（新規追加）

```ts
async function resolveSetSubqueries(
  assignments: Assignment[],
  client: KintoneClient,
  options: ExecuteOptions
): Promise<void> {
  for (const a of assignments) {
    if (a.value.type !== "SCALAR_SUBQUERY") continue;
    const result = await executeSelect(a.value.query, client, options);
    if (result.rowCount === 0) throw new Error(`SET サブクエリが値を返しませんでした（${a.field}）`);
    if (result.rowCount > 1)  throw new Error(`SET サブクエリが複数行を返しました（${a.field}）`);
    const col = result.columns[0] ?? "";
    const resolved = result.rows[0]?.[col] ?? "";
    // StringLiteral に差し替え（dmlToKintone.ts の変更不要）
    a.value = { type: "STRING", value: resolved };
  }
}
```

### executeUpdate() への組み込み

```ts
async function executeUpdate(...): Promise<UpdateResult> {
  // ① SET のスカラーサブクエリを事前解決
  await resolveSetSubqueries(stmt.assignments, client, options);

  // ② 以降は既存パス（算術 SET / 通常 SET）をそのまま使用
  if (hasArithAssignment(stmt)) { ... }
  ...
}
```

---

## 対応ファイル一覧

| ファイル | 変更内容 | 規模 |
|---|---|:---:|
| `src/types/ast.ts` | 変更なし | — |
| `src/parser/parser.ts` | `parseAssignmentValue()` に SCALAR_SUBQUERY ケース追加 | 小 |
| `src/execute.ts` | `resolveSetSubqueries()` 追加、`executeUpdate()` に呼び出し追加、`buildUpdatePlan()` に表示追加 | 小 |
| `src/converter/dmlToKintone.ts` | 変更なし（StringLiteral に差し替え済みのため） | — |
| `src/__tests__/update_scalar.test.ts` | 新規テスト（単一 / 複数フィールド / 混在 / エラー） | 小 |

---

## テストケース

| # | クエリ | 確認内容 |
|---|---|---|
| 1 | `SET 上限費用 = (SELECT MAX(合計費用) FROM APP88)` | サブクエリの値で全件 PUT される |
| 2 | 0 行返す SELECT | エラーになる |
| 3 | 2 行以上返す SELECT | エラーになる |
| 4 | 通常 SET と混在 | 両方正しく適用される |
| 5 | 算術 SET と混在 | arith パスが維持される |
| 6 | EXPLAIN — 単一 | `[subquery: フィールド名]` セクションが出る |
| 7 | EXPLAIN — 混在 | `set type` に両方表示される |

---

## スコープ外（将来検討）

- サブクエリ後の算術（`SET 費用 = (SELECT AVG(...) FROM ...) * 1.1`）
- 相関サブクエリ（`SET 費用 = (SELECT MAX(費用) FROM APP88 WHERE 顧客名 = outer.顧客名)`）
- サブテーブル UPDATE での SET スカラーサブクエリ
