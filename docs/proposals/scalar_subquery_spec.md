# スカラーサブクエリ 実装仕様書

## 概要

スカラーサブクエリは **1行 × 1列** の値を返すサブクエリです。  
WHERE 句の右辺・SELECT 列・HAVING 句に記述でき、集計結果や別アプリの値と比較できます。

**非相関のみ対応。** 外側クエリのフィールドをサブクエリ内で参照することはできません。

---

## 構文

```sql
-- WHERE 右辺
SELECT * FROM APP100
WHERE 金額 > (SELECT AVG(金額) FROM APP100 WHERE ステータス = '完了')

-- SELECT 列
SELECT
  顧客名,
  金額,
  (SELECT MAX(金額) FROM APP100) AS 最大金額
FROM APP100

-- HAVING 句
SELECT 担当者, SUM(金額) AS 合計
FROM APP100
GROUP BY 担当者
HAVING SUM(金額) > (SELECT AVG(合計) FROM APP200)
```

---

## 対応箇所

| 記述箇所 | 対応 | 例 |
|---|---|---|
| WHERE 右辺（比較演算子の右） | ✅ | `WHERE 金額 > (SELECT AVG(金額) FROM APP100)` |
| SELECT 列 | ✅ | `SELECT (SELECT COUNT(*) FROM APP200) AS 件数 FROM APP100` |
| HAVING 右辺 | ✅ | `HAVING SUM(金額) > (SELECT AVG(合計) FROM APP200)` |
| WHERE 左辺 | ❌ | パーサー複雑度に対して実用性が低いため対象外 |
| UPDATE SET 右辺 | ❌ | 別フェーズで検討 |
| ORDER BY | ❌ | 実用性が低いため対象外 |

---

## エラー条件

| 条件 | エラーメッセージ |
|---|---|
| サブクエリが 0件を返した | スカラーサブクエリが値を返しませんでした |
| サブクエリが 2件以上返した | スカラーサブクエリが複数行を返しました（1行のみ許可） |
| 相関参照（外側テーブルのフィールド） | 非対応（実行時に外側フィールドが空文字として評価される） |

---

## 実行モード

スカラーサブクエリを含む場合は常に **FULL_SCAN** モードで実行されます。  
サブクエリは `resolveSubqueries()` の中で **事前に 1 回だけ実行** され、結果値を AST ノードに埋め込みます。

---

## AST 設計

### 新規ノード: `ScalarSubquery`

```ts
// ast.ts に追加
export interface ScalarSubquery {
  type: "SCALAR_SUBQUERY";
  query: SelectStatement;
}
```

### `SqlValue` 拡張

```ts
// WHERE 右辺・HAVING 右辺にスカラーサブクエリを許可
export type SqlValue =
  | StringLiteral
  | NumberLiteral
  | KintoneFunction
  | InList
  | SubqueryInList
  | ArithSqlValue
  | CaseSqlValue
  | ScalarSubquery;   // ← 追加
```

### `SelectColumn` 拡張

```ts
// SELECT 列にスカラーサブクエリを許可
export type SelectColumn =
  | WildcardColumn
  | ParentWildcardColumn
  | FieldColumn
  | AggregateColumn
  | AggArithColumn
  | ArithColumn
  | CaseColumn
  | StringFuncColumn
  | ScalarSubqueryColumn;  // ← 追加

export interface ScalarSubqueryColumn {
  type: "SCALAR_SUBQUERY_COL";
  query: SelectStatement;
  alias: string | null;
}
```

### 実行時解決: `ResolvedScalarSubquery`

```ts
// evalWhere.ts に追加（IN/EXISTS と同じパターン）
export interface ResolvedScalarSubquery extends ScalarSubquery {
  resolved: string;  // サブクエリの実行結果値（文字列として保持）
}
```

---

## パーサー設計

### WHERE 右辺での検出

`parseValue()` で `(` の次が `SELECT` なら `ScalarSubquery` をパースします。

```
parseValue():
  if peek() == LPAREN and peekAt(1) == SELECT:
    advance()          // ( を消費
    query = parseSelect()
    expect(RPAREN)
    return { type: "SCALAR_SUBQUERY", query }
  ...（既存処理）
```

### SELECT 列での検出

`parseSelectColumn()` で `(` の次が `SELECT` なら `ScalarSubqueryColumn` をパースします。

```
parseSelectColumn():
  if peek() == LPAREN and peekAt(1) == SELECT:
    advance()          // ( を消費
    query = parseSelect()
    expect(RPAREN)
    alias = consume AS ? parseAlias() : null
    return { type: "SCALAR_SUBQUERY_COL", query, alias }
  ...（既存処理）
```

### 算術式との衝突

`(金額 * 1.1)` のような括弧算術式は `(` の次が `SELECT` でないため既存処理に委譲されます。衝突はありません。

---

## 変換レイヤー設計

### selectToKintone.ts（hasWhereFunc）

```ts
case "BINARY":
  return isFunc(where.left)
    || where.right.type === "ARITH_VALUE"
    || where.right.type === "CASE_VALUE"
    || where.right.type === "SUBQUERY_IN_LIST"
    || where.right.type === "SCALAR_SUBQUERY";  // ← 追加
```

### whereToKintone.ts（convertValue）

```ts
case "SCALAR_SUBQUERY":
  throw new KintoneQueryError("スカラーサブクエリは kintone クエリに変換できません");
```

### dmlToKintone.ts（toKintoneValue）

```ts
case "SCALAR_SUBQUERY":
  throw new DmlConvertError("スカラーサブクエリは DML に変換できません");
```

---

## 実行エンジン設計

### resolveSubqueries()（execute.ts）

既存の `SUBQUERY_IN_LIST` / `EXISTS` と同じパターンでサブクエリを事前実行します。

```ts
case "BINARY": {
  const right = where.right;
  if (right.type === "SUBQUERY_IN_LIST") { ... }   // 既存
  if (right.type === "SCALAR_SUBQUERY") {           // ← 追加
    const result = await executeSelect(right.query, client, options);
    if (result.rowCount === 0)
      throw new Error("スカラーサブクエリが値を返しませんでした");
    if (result.rowCount > 1)
      throw new Error("スカラーサブクエリが複数行を返しました（1行のみ許可）");
    const col = result.columns[0] ?? "";
    (right as ResolvedScalarSubquery).resolved = result.rows[0]?.[col] ?? "";
  }
  break;
}
```

### evalWhere.ts（resolveValue）

```ts
case "SCALAR_SUBQUERY":
  return (right as ResolvedScalarSubquery).resolved;
```

### SELECT 列のスカラーサブクエリ

SELECT 列は `resolveSubqueries` とは別に、`executeFullScanSelect` 内で各行評価時に解決します。

サブクエリ列は 1 回だけ実行して結果をキャッシュし、全行に同じ値を付与します。

```
executeFullScanSelect():
  // スカラーサブクエリ列を事前実行してキャッシュ
  const scalarCache = new Map<number, string>()  // column index → resolved value
  for (const [i, col] of stmt.columns.entries()):
    if col.type === "SCALAR_SUBQUERY_COL":
      result = await executeSelect(col.query, ...)
      scalarCache.set(i, result.rows[0]?.[result.columns[0]] ?? "")

  // runFullScan に scalarCache を渡して列評価時に使用
```

### process.ts（projectRow）

`SCALAR_SUBQUERY_COL` をキャッシュ値で評価します。

```ts
case "SCALAR_SUBQUERY_COL":
  return [col.alias ?? `(SUBQUERY)`, scalarCache.get(colIndex) ?? ""];
```

---

## selectToKintoneParams — fields 抽出

```ts
// extractFields() にスカラーサブクエリ列を追加
const hasWildcard = columns.some(
  (c) => c.type === "WILDCARD"
    || c.type === "AGGREGATE"
    || c.type === "ARITH_AGG_COL"
    || c.type === "CASE_COL"
    || c.type === "SCALAR_SUBQUERY_COL"  // ← 追加: 全フィールド取得
);
```

---

## 対応が必要なファイル一覧

| ファイル | 変更内容 |
|---|---|
| `src/types/ast.ts` | `ScalarSubquery`・`ScalarSubqueryColumn` 追加、`SqlValue`・`SelectColumn` 拡張 |
| `src/parser/parser.ts` | `parseValue()` と `parseSelectColumn()` でスカラーサブクエリ検出 |
| `src/engine/evalWhere.ts` | `ResolvedScalarSubquery`・`resolveValue` に `SCALAR_SUBQUERY` case 追加 |
| `src/engine/process.ts` | `projectRow` に `SCALAR_SUBQUERY_COL` case 追加（scalarCache 受け取り） |
| `src/converter/selectToKintone.ts` | `hasWhereFunc` と `extractFields` に `SCALAR_SUBQUERY` case 追加 |
| `src/converter/whereToKintone.ts` | `convertValue` に throw case 追加 |
| `src/converter/dmlToKintone.ts` | `toKintoneValue` に throw case 追加 |
| `src/execute.ts` | `resolveSubqueries` 拡張、`executeFullScanSelect` にスカラー列事前実行追加 |

---

## 実装上の注意点

### pushDownNot.ts

`pushDownNot` は `WhereExpr` を受け取りますが、`ScalarSubquery` は `WhereExpr` ではなく `SqlValue` に属するため変更不要です。

### stripCteAlias（execute.ts）

スカラーサブクエリ内のエイリアスは外側 CTE と独立しているため、`EXISTS` と同様に `return where` で素通しします。

### scalarCache の設計

SELECT 列の `SCALAR_SUBQUERY_COL` は実行コストが高いため、同一クエリオブジェクトを参照インデックス（列番号）でキャッシュし、全行に同じ値を使用します。

---

## 使用例

```sql
-- 全体平均と比較
SELECT 顧客名, 金額
FROM APP100
WHERE 金額 > (SELECT AVG(金額) FROM APP100)

-- 別アプリの最大値と比較
SELECT * FROM APP100
WHERE 金額 >= (SELECT MAX(上限金額) FROM APP200 WHERE 区分 = '標準')

-- SELECT 列でサマリ値を付加
SELECT
  顧客名,
  金額,
  (SELECT COUNT(*) FROM APP100) AS 総件数,
  (SELECT SUM(金額) FROM APP100) AS 合計金額
FROM APP100
WHERE ステータス = '完了'

-- HAVING でサブクエリ
SELECT 担当者, SUM(金額) AS 合計
FROM APP100
GROUP BY 担当者
HAVING SUM(金額) > (SELECT AVG(金額) * 2 FROM APP100)

-- WITH 句との組み合わせ
WITH 対象 AS (
  SELECT * FROM APP100 WHERE ステータス = '完了'
)
SELECT 顧客名, 金額
FROM 対象
WHERE 金額 > (SELECT AVG(金額) FROM APP200)
```

---

## スコープ外（将来検討）

- **相関サブクエリ**: 外側テーブルのフィールドをサブクエリ内で参照（N+1 API コール発生）
- **UPDATE SET でのスカラーサブクエリ**: `SET 金額 = (SELECT MAX(金額) FROM APP200)`
- **サブクエリ後の算術演算子**: `(SELECT AVG(金額) FROM APP100) * 1.1` — 未対応。算術はサブクエリ内に移動する（`SELECT AVG(金額) * 1.1 FROM APP100`）
