# EXPLAIN 実装仕様書

## 概要

`EXPLAIN` は SQL 文の実行計画を表示するコマンドです。  
実際に kintone API を呼び出さず、パース結果と変換ロジックだけで次の情報を返します。

**SELECT / UNION / WITH:**
- 実行モード（SIMPLE / FULL_SCAN）
- FULL_SCAN になった理由
- kintone に送信されるクエリ文字列
- 取得フィールド一覧
- サブクエリがある場合はその実行計画（再帰）

**INSERT:**
- 対象アプリ・件数・バッチ分割数
- 呼び出す REST API（POST）

**UPDATE:**
- 対象アプリ・WHERE の kintone クエリ
- 単純 SET か算術 SET かの判定
- 算術 SET 時の参照フィールド（GET に含めるフィールド）
- 呼び出す REST API（GET → PUT）

**DELETE:**
- 対象アプリ・WHERE の kintone クエリ
- 呼び出す REST API（GET → DELETE）

デバッグ・パフォーマンス確認・学習目的で使用します。

---

## 構文

```sql
-- SELECT
EXPLAIN SELECT * FROM APP100 WHERE ステータス = '完了'
EXPLAIN SELECT 顧客名, SUM(金額) FROM APP100 GROUP BY 顧客名
EXPLAIN SELECT * FROM APP100 WHERE 金額 > (SELECT AVG(金額) FROM APP100)
EXPLAIN WITH cte AS (SELECT * FROM APP100) SELECT * FROM cte
EXPLAIN SELECT 顧客名 FROM APP100 UNION SELECT 顧客名 FROM APP200

-- INSERT
EXPLAIN INSERT INTO APP100 (顧客名, 金額) VALUES ('田中', 1000)
EXPLAIN INSERT INTO APP100 (顧客名) SELECT 顧客名 FROM APP200

-- UPDATE
EXPLAIN UPDATE APP100 SET 金額 = 金額 * 1.1 WHERE ステータス = '完了'

-- DELETE
EXPLAIN DELETE FROM APP100 WHERE ステータス = '完了'
```

`EXPLAIN` キーワードの後ろに SELECT / UNION / WITH / INSERT / UPDATE / DELETE を記述します。  
SHOW / DESCRIBE / REORDER には対応しません（構文エラー）。

---

## 出力形式

EXPLAIN は `SelectResult` と同じ型で返します。  
行単位のテキストプランとして `plan` という 1 列の結果セットを返します。

---

## SELECT の出力例

### SIMPLE モード

```sql
EXPLAIN SELECT 顧客名, 金額 FROM APP100 WHERE ステータス = '完了' ORDER BY 金額 desc LIMIT 10
```

```
  mode:          SIMPLE
  app:           APP100 (100)
  kintone query: ステータス = "完了" order by 金額 desc limit 10
  fields:        顧客名, 金額
```

### FULL_SCAN モード

```sql
EXPLAIN SELECT 顧客名, SUM(金額) AS 合計 FROM APP100 GROUP BY 顧客名
```

```
  mode:          FULL_SCAN
  reason:        GROUP BY あり, 集計関数（COUNT / SUM 等）あり
  app:           APP100 (100)
  kintone query: (全件取得)
  fields:        (全フィールド)
```

### スカラーサブクエリ

```sql
EXPLAIN SELECT 顧客名, 金額 FROM APP100 WHERE 金額 > (SELECT AVG(金額) FROM APP100)
```

```
  mode:          FULL_SCAN
  reason:        WHERE 句に JS 評価が必要な式
  app:           APP100 (100)
  kintone query: (全件取得)
  fields:        (全フィールド)

[subquery:1]
  mode:          FULL_SCAN
  reason:        集計関数（COUNT / SUM 等）あり
  app:           APP100 (100)
  kintone query: (全件取得)
  fields:        (全フィールド)
```

### UNION

```sql
EXPLAIN SELECT 顧客名 FROM APP100 UNION SELECT 顧客名 FROM APP200
```

```
[union:1]
  mode:          SIMPLE
  app:           APP100 (100)
  kintone query: (なし)
  fields:        顧客名

[union:2]
  mode:          SIMPLE
  app:           APP200 (200)
  kintone query: (なし)
  fields:        顧客名
```

### WITH 句

```sql
EXPLAIN WITH 対象 AS (SELECT * FROM APP100 WHERE ステータス = '完了')
SELECT 顧客名, 金額 FROM 対象 WHERE 金額 > 10000
```

```
[cte: 対象]
  mode:          SIMPLE
  app:           APP100 (100)
  kintone query: ステータス = "完了"
  fields:        (全フィールド)

[main]
  mode:          SIMPLE
  app:           APP0 (0)
  kintone query: 金額 > "10000"
  fields:        顧客名, 金額
```

---

## INSERT の出力例

### INSERT VALUES

```sql
EXPLAIN INSERT INTO APP89 (顧客名, 部署名, 顧客ランク, 担当者名)
VALUES ('株式会社アルファ', '営業部', 'A', '田中'),
       ('株式会社ベータ',   '企画部', 'B', '伊藤')
```

```
  [INSERT]
  app:     APP89 (89)
  records: 2 件（バッチ 1 回 × 最大 100 件）
  api:     POST /k/v1/records.json × 1
  fields:  顧客名, 部署名, 顧客ランク, 担当者名
```

150 件の場合（バッチ 2 回に分割）:

```
  [INSERT]
  app:     APP89 (89)
  records: 150 件（バッチ 2 回 × 最大 100 件）
  api:     POST /k/v1/records.json × 2
  fields:  顧客名, 部署名, 顧客ランク, 担当者名
```

### INSERT SELECT

```sql
EXPLAIN INSERT INTO APP88 (顧客名, 案件名)
SELECT 顧客名, 案件名 FROM APP88 WHERE 確度 in ('0%')
```

```
  [INSERT SELECT]
  app:     APP88 (88)
  fields:  顧客名, 案件名
  api:     POST /k/v1/records.json（件数は SELECT 結果に依存、100 件ごとにバッチ）

[source SELECT]
  mode:          SIMPLE
  app:           APP88 (88)
  kintone query: 確度 in ("0%")
  fields:        顧客名, 案件名
```

---

## UPDATE の出力例

### 単純 SET

```sql
EXPLAIN UPDATE APP89 SET 顧客ランク = 'A' WHERE 顧客名 = '株式会社テスト'
```

```
  [UPDATE]
  app:           APP89 (89)
  kintone query: 顧客名 = "株式会社テスト"
  api:           GET /k/v1/records.json → PUT /k/v1/records.json
  set type:      単純 SET
  set fields:
    顧客ランク = 'A'
```

### 算術 SET

```sql
EXPLAIN UPDATE APP88 SET プラン費用 = プラン費用 * 1.1
WHERE 確度 in ('80%', '100%')
```

```
  [UPDATE]
  app:           APP88 (88)
  kintone query: 確度 in ("80%","100%")
  api:           GET /k/v1/records.json → PUT /k/v1/records.json
  set type:      算術 SET（現在値を取得して計算）
  ref fields:    プラン費用（GET に含める）
  set fields:
    プラン費用 = プラン費用 * 1.1
```

> **算術 SET の処理フロー:** GET で `$id` と参照フィールドを取得 → JS で計算 → PUT で更新。

---

## DELETE の出力例

```sql
EXPLAIN DELETE FROM APP88 WHERE 確度 in ('0%') AND 受注予定日 < TODAY()
```

```
  [DELETE]
  app:           APP88 (88)
  kintone query: 確度 in ("0%") and 受注予定日 < TODAY()
  api:           GET /k/v1/records.json → DELETE /k/v1/records.json
```

---

## FULL_SCAN になる理由（reason 文言）

| 条件 | reason 文言 |
|---|---|
| `joins.length > 0` | JOIN あり |
| `groupBy.length > 0` | GROUP BY あり |
| `distinct === true` | DISTINCT あり |
| SELECT 列に `AGGREGATE` / `ARITH_AGG_COL` | 集計関数（COUNT / SUM 等）あり |
| SELECT 列に `SCALAR_SUBQUERY_COL` | SELECT 列にスカラーサブクエリ |
| WHERE 左辺が FUNC_FIELD / ARITH_FIELD / CASE_FIELD | WHERE 句に JS 評価が必要な式 |
| WHERE 右辺が `ARITH_VALUE` | WHERE 句に JS 評価が必要な式 |
| WHERE 右辺が `CASE_VALUE` | WHERE 句に JS 評価が必要な式 |
| WHERE 右辺が `SUBQUERY_IN_LIST` | WHERE 句に JS 評価が必要な式 |
| WHERE 右辺が `SCALAR_SUBQUERY` | WHERE 句に JS 評価が必要な式 |
| `EXISTS` | WHERE 句に JS 評価が必要な式 |
| `from.subtableCode` / `joins[].table.subtableCode` | サブテーブル仮想テーブル |
| ORDER BY に FIELD_NAME 以外 | ORDER BY に式 |

複数条件が重なる場合はすべて列挙します。

```
reason:        GROUP BY あり, 集計関数（COUNT / SUM 等）あり
```

---

## AST 設計

### `ExplainStatement`

```ts
// ast.ts
export interface ExplainStatement {
  type: "EXPLAIN";
  query:
    | SelectStatement
    | UnionStatement
    | WithStatement
    | InsertStatement
    | InsertSelectStatement
    | UpdateStatement
    | DeleteStatement;
}
```

`Statement` 型に追加:

```ts
export type Statement =
  | SelectStatement
  | UnionStatement
  | WithStatement
  | InsertStatement
  | ...
  | ExplainStatement;  // ← 追加
```

---

## パーサー設計

`parseStatement()` の `EXPLAIN` case で、続くキーワードによって分岐します。

```
parseExplain():
  advance()  // EXPLAIN を消費
  if peek() == WITH    → parseWith()
  if peek() == SELECT  → parseSelect() → tryParseUnionChain()
  if peek() == INSERT  → parseInsert()
  if peek() == UPDATE  → parseUpdate()
  if peek() == DELETE  → parseDelete()
  else → ParseError
```

`EXPLAIN` はキーワードとして登録（`TokenKind.EXPLAIN`）。

---

## 実行エンジン設計

### executeExplain()

API を呼び出さず変換ロジックだけでプランを生成します。`KintoneClient` / `ExecuteOptions` は不要です。

```ts
function executeExplain(stmt: ExplainStatement): SelectResult {
  const lines = buildExplainPlan(stmt.query);
  return {
    type: "SELECT",
    columns: ["plan"],
    rows: lines.map((line) => ({ plan: line })),
    rowCount: lines.length,
  };
}
```

### buildExplainPlan() — ルーティング

```ts
function buildExplainPlan(query: ExplainStatement["query"], label?: string): string[] {
  if (query.type === "UNION")         return buildUnionPlan(query);
  if (query.type === "WITH")          return buildWithPlan(query);
  if (query.type === "INSERT")        return buildInsertPlan(query, label);
  if (query.type === "INSERT_SELECT") return buildInsertSelectPlan(query, label);
  if (query.type === "UPDATE")        return buildUpdatePlan(query, label);
  if (query.type === "DELETE")        return buildDeletePlan(query, label);
  return buildSelectPlan(query, label);
}
```

### buildInsertPlan()

```ts
function buildInsertPlan(stmt: InsertStatement, label?: string): string[] {
  const totalRows  = stmt.values.length;
  const batchCount = Math.ceil(totalRows / 100);
  return [
    label ?? "",
    `  [INSERT]`,
    `  app:     APP${stmt.appId} (${stmt.appId})`,
    `  records: ${totalRows} 件（バッチ ${batchCount} 回 × 最大 100 件）`,
    `  api:     POST /k/v1/records.json × ${batchCount}`,
    `  fields:  ${stmt.fields.join(", ")}`,
  ].filter(Boolean);
}
```

### buildUpdatePlan()

```ts
function buildUpdatePlan(stmt: UpdateStatement, label?: string): string[] {
  const isArith = hasArithAssignment(stmt);
  // ...
  lines.push(`  set type: ${isArith ? "算術 SET（現在値を取得して計算）" : "単純 SET"}`);
  if (isArith) lines.push(`  ref fields: ${collectArithRefFields(stmt).join(", ")}（GET に含める）`);
  for (const a of stmt.assignments) lines.push(`    ${formatAssignment(a)}`);
}
```

### buildDeletePlan()

```ts
function buildDeletePlan(stmt: DeleteStatement, label?: string): string[] {
  return [
    `  [DELETE]`,
    `  app:           APP${stmt.appId} (${stmt.appId})`,
    `  kintone query: ${safeWhereToKintone(stmt.where)}`,
    `  api:           GET /k/v1/records.json → DELETE /k/v1/records.json`,
  ];
}
```

### safeWhereToKintone()

WHERE に JS 評価が必要な式が含まれる場合は `whereToKintone` が例外を投げます。その場合は代替文言を返します。

```ts
function safeWhereToKintone(where: WhereExpr): string {
  try {
    return whereToKintone(where);
  } catch {
    return "(JS 評価が必要なため kintone クエリに変換不可)";
  }
}
```

---

## 対応ファイル一覧

| ファイル | 変更内容 |
|---|---|
| `src/lexer/tokens.ts` | `EXPLAIN` キーワード追加（enum + KEYWORDS マップ） |
| `src/types/ast.ts` | `ExplainStatement` 定義、`Statement` 型拡張、DML 型を query に追加 |
| `src/parser/parser.ts` | `parseExplain()` 追加、`parseStatement` に case 追加 |
| `src/execute.ts` | `executeExplain` / `buildExplainPlan` / `buildInsertPlan` / `buildInsertSelectPlan` / `buildUpdatePlan` / `buildDeletePlan` / ヘルパー群 |
| `src/__tests__/explain.test.ts` | 20 テスト（SELECT 12 + INSERT 3 + UPDATE 2 + DELETE 3） |

---

## 実装上の注意点

### API コール不要

`executeExplain` は `KintoneClient` を受け取りません。

### EXPLAIN の EXPLAIN は非対応

`ExplainStatement.query` に `ExplainStatement` が来ることは構文上ないためガード不要。

### INSERT SELECT の件数は実行前不明

`INSERT SELECT` の POST バッチ数は SELECT 結果件数に依存します。EXPLAIN では「件数は SELECT 結果に依存」と表示します。

### UPDATE WHERE に JS 関数が含まれる場合

`whereToKintone` が例外を投げる場合は `safeWhereToKintone` が `(JS 評価が必要なため kintone クエリに変換不可)` を返します。

### WITH 句 CTE の app: APP0 (0)

CTE（仮想テーブル）は実際の kintone アプリではないため、app ID が 0 として表示されます。

---

## スコープ外（将来検討）

- JOIN 先テーブルの詳細プラン
- API コスト見積もり（ページ数予測）
- `EXPLAIN UPSERT / REORDER / SHOW / DESCRIBE`
