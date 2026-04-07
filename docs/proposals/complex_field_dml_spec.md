# 複合フィールド DML 仕様書

**バージョン:** 1.1  
**作成日:** 2026-04-04  
**更新日:** 2026-04-04  
**ステータス:** 実装済み

---

## 1. 概要

kintone の複合フィールド（ユーザー選択・組織選択・グループ選択・チェックボックス・複数選択）に対して、
INSERT / UPDATE / UPSERT / INSERT SELECT / UPSERT SELECT で値をセットできるようにする。

### 対象フィールド型

| kintone フィールド型 | 分類 | kintone API 送信形式 |
|---|---|---|
| USER_SELECT | ユーザー系 | `[{"code": "user1"}]` |
| ORGANIZATION_SELECT | ユーザー系 | `[{"code": "org1"}]` |
| GROUP_SELECT | ユーザー系 | `[{"code": "grp1"}]` |
| CHECK_BOX | 配列系 | `["選択肢A", "選択肢B"]` |
| MULTI_SELECT | 配列系 | `["選択肢A", "選択肢B"]` |
| DATETIME | 日時系 | `"2026-04-05T03:00:00Z"`（UTC ISO 8601） |
| DATE | 日時系 | `"2026-04-05"` |

### 非対応（本スコープ外）

| フィールド型 | 理由 |
|---|---|
| CREATOR / MODIFIER | records API で更新不可（kintone 制約） |
| FILE（添付ファイル） | バイナリ送信が別 API |
| SUBTABLE | 仮想テーブル経由で対応済み |

---

## 2. INSERT VALUES / UPDATE SET / UPSERT VALUES

### 2.1 基本動作: DESCRIBE 自動判定

実行前に対象アプリの `getFields()` でフィールド定義を取得し、型ごとに文字列を自動変換する。

#### ユーザー系フィールド

```sql
-- 単一ユーザー
UPDATE APP89 SET 担当者 = 'user1' WHERE 顧客名 = 'A社'

-- 複数ユーザー（カンマ区切り）
UPDATE APP89 SET 担当者 = 'user1,user2' WHERE 顧客名 = 'A社'

-- 空にする
UPDATE APP89 SET 担当者 = '' WHERE 顧客名 = 'A社'
UPDATE APP89 SET 担当者 = NULL WHERE 顧客名 = 'A社'
```

| SQL 値 | kintone API 送信値 |
|---|---|
| `'user1'` | `[{"code":"user1"}]` |
| `'user1,user2'` | `[{"code":"user1"},{"code":"user2"}]` |
| `''` / `NULL` | `[]` |

#### 配列系フィールド（CHECK_BOX / MULTI_SELECT）

```sql
-- 単一選択肢
UPDATE APP89 SET タグ = '選択肢A' WHERE ...

-- 複数選択肢（カンマ区切り）
UPDATE APP89 SET タグ = '選択肢A,選択肢B' WHERE ...

-- 空にする
UPDATE APP89 SET タグ = '' WHERE ...
```

| SQL 値 | kintone API 送信値 |
|---|---|
| `'選択肢A'` | `["選択肢A"]` |
| `'選択肢A,選択肢B'` | `["選択肢A","選択肢B"]` |
| `''` / `NULL` | `[]` |

---

### 2.2 明示的指定: 配列リテラル `[...]`

カンマを含む選択肢など、カンマ区切りでは曖昧になるケースに使用する。
配列リテラルは DESCRIBE の結果と組み合わせて変換する。

```sql
-- ユーザー選択（複数）
UPDATE APP89 SET 担当者 = ['user1', 'user2'] WHERE ...

-- カンマを含む選択肢（CHECK_BOX）
INSERT INTO APP89 (タグ) VALUES (['選択肢A', '選択肢B,C'])
--  ↑ '選択肢B,C' が 1 つの値

-- 単一も配列リテラルで明示可
UPDATE APP89 SET 担当部門 = ['org1'] WHERE ...
```

#### 配列リテラルの変換ルール

| 送信先フィールド型 | 配列要素 | kintone API 送信値 |
|---|---|---|
| USER_SELECT / ORGANIZATION_SELECT / GROUP_SELECT | `['user1', 'user2']` | `[{"code":"user1"},{"code":"user2"}]` |
| CHECK_BOX / MULTI_SELECT | `['選択肢A', 'B,C']` | `["選択肢A","B,C"]` |
| DESCRIBE 失敗・型不明 | `['val']` | `["val"]`（配列のまま送信） |

#### カンマ区切り vs 配列リテラル 使い分け

| ケース | 推奨記法 |
|---|---|
| 選択肢にカンマが含まれない（通常ケース） | カンマ区切り文字列 |
| 選択肢にカンマが含まれる | 配列リテラル `[...]` |
| INSERT VALUES で複数行を一括登録 | カンマ区切り文字列（簡潔） |
| 意図を明示したい | 配列リテラル `[...]` |

---

### 2.3 INSERT VALUES での利用例

```sql
-- 単一行
INSERT INTO APP89 (顧客名, 担当者, タグ)
VALUES ('A社', 'user1', '重要,VIP')

-- 複数行
INSERT INTO APP89 (顧客名, 担当者, タグ)
VALUES
  ('A社', 'user1,user2', '重要'),
  ('B社', 'user3',       '通常,新規')

-- 配列リテラルを使った INSERT
INSERT INTO APP89 (顧客名, 担当者)
VALUES ('C社', ['user1', 'user2'])
```

### 2.4 UPSERT VALUES での利用例

```sql
UPSERT INTO APP89 (顧客名, 担当者, タグ)
VALUES ('A社', 'user1,user2', '重要,VIP')
ON DUPLICATE (顧客名)
```

---

## 3. INSERT INTO ... SELECT / UPSERT ... SELECT

### 3.1 同型フィールド間: 自動転送

転送元と転送先のフィールド型が同じ場合、ProcessRow の JSON 文字列を解析して
kintone API 形式に自動変換する。ユーザーは特別な構文を書く必要がない。

```sql
-- USER_SELECT → USER_SELECT: そのまま転送
INSERT INTO APP89 (顧客名, 担当者)
SELECT 顧客名, 担当者 FROM APP88

-- CHECK_BOX → CHECK_BOX: そのまま転送
UPSERT INTO APP89 (顧客名, タグ)
SELECT 顧客名, タグ FROM APP88
ON DUPLICATE (顧客名)

-- 複合: 通常フィールドと混在
INSERT INTO APP89 (顧客名, 担当者, 金額, タグ)
SELECT 顧客名, 担当者, 金額, タグ FROM APP88 WHERE 確度 = '100%'
```

#### 自動転送の変換フロー

```
APP88 GET → ProcessRow（JSON 文字列として格納）
                ↓
           両側 DESCRIBE で型照合
                ↓
           同型なら JSON パース → kintone API 形式に変換
                ↓
           APP89 PUT/POST
```

#### 自動転送の対象形式

| ProcessRow の値（JSON 文字列） | 変換後（kintone API 送信値） |
|---|---|
| `[{"code":"u1","name":"田中"}]` | `[{"code":"u1"}]` |
| `["選択肢A","選択肢B"]` | `["選択肢A","選択肢B"]` |
| `[]` | `[]` |

### 3.2 異型フィールド間: エラー

転送元と転送先のフィールド型が異なる場合はエラーとする。

```sql
-- TEXT → USER_SELECT: 型不一致エラー
INSERT INTO APP89 (担当者)
SELECT 担当者コード FROM APP88   -- 担当者コードが SINGLE_LINE_TEXT
-- ❌ エラー: 型不一致 担当者コード(SINGLE_LINE_TEXT) → 担当者(USER_SELECT)
```

異型間のセットが必要な場合は VALUES / SET でカンマ区切りまたは配列リテラルを使用する。

```sql
-- 回避策: サブクエリで値を取得し VALUES で指定
INSERT INTO APP89 (顧客名, 担当者)
SELECT 顧客名, (SELECT 担当者コード FROM APP88 WHERE ...) FROM APP90
-- → 担当者コードを DESCRIBE 判定で USER_SELECT 変換
```

---

## 4. DESCRIBE キャッシュ

毎回 API を呼ぶとパフォーマンスが低下するため、セッション中はアプリ ID をキーにキャッシュする。

```
execute() 呼び出し
    ↓
INSERT / UPDATE / UPSERT を検出
    ↓
fieldCache.has(appId) ?
    Yes → キャッシュから取得
    No  → getFields(appId) → キャッシュに保存
    ↓
フィールド型マップ（code → type）を構築
    ↓
toKintoneValue() に渡す
```

---

## 5. AST 変更

### 5.1 配列リテラル AST ノード追加

```ts
// 追加
interface ArrayLiteral {
  type: "ARRAY";
  elements: StringLiteral[];   // 配列リテラルの要素は文字列リテラルのみ
}

// SqlValue ユニオンに追加
type SqlValue =
  | StringLiteral
  | NumberLiteral
  | ArrayLiteral      // 追加
  | ArithValue
  | ...
```

### 5.2 パーサー変更箇所

- `parseAssignmentValue()`: `[` トークンを検出したら `parseArrayLiteral()` を呼ぶ
- `parseInsertValues()`: VALUES の各要素で `[` を許可
- `parseArrayLiteral()`: `[str, str, ...]` を読んで `ArrayLiteral` を返す

---

## 6. `dmlToKintone.ts` 変更

### 6.1 型定義変更

```ts
// 変更前
export interface KintoneFieldValue {
  value: string;
}

// 変更後
export interface KintoneFieldValue {
  value: string | string[] | Array<{ code: string }>;
}
```

### 6.2 `toKintoneValue()` 変更

```ts
function toKintoneValue(
  value: SqlValue,
  fieldType: string | undefined   // getFields() で取得した type
): string | string[] | Array<{ code: string }> {
  if (value.type === "ARRAY") {
    return convertArrayLiteral(value.elements.map((e) => e.value), fieldType);
  }
  if (value.type === "STRING") {
    return convertStringValue(value.value, fieldType);
  }
  // NUMBER / その他は文字列化（既存と同様）
  ...
}

function convertStringValue(
  raw: string,
  fieldType: string | undefined
): string | string[] | Array<{ code: string }> {
  if (isUserType(fieldType)) {
    if (raw === "" || raw === null) return [];
    return raw.split(",").map((c) => ({ code: c.trim() }));
  }
  if (isArrayType(fieldType)) {
    if (raw === "" || raw === null) return [];
    return raw.split(",").map((v) => v.trim());
  }
  return raw;
}

function convertArrayLiteral(
  elements: string[],
  fieldType: string | undefined
): string[] | Array<{ code: string }> {
  if (isUserType(fieldType)) return elements.map((c) => ({ code: c }));
  return elements;   // CHECK_BOX / MULTI_SELECT / 型不明
}

const USER_TYPES  = new Set(["USER_SELECT", "ORGANIZATION_SELECT", "GROUP_SELECT"]);
const ARRAY_TYPES = new Set(["CHECK_BOX", "MULTI_SELECT"]);
function isUserType(t: string | undefined):  boolean { return USER_TYPES.has(t  ?? ""); }
function isArrayType(t: string | undefined): boolean { return ARRAY_TYPES.has(t ?? ""); }
```

---

## 7. エラーケース

| ケース | エラーメッセージ例 |
|---|---|
| 配列リテラルに数値・式を含む | `配列リテラルには文字列リテラルのみ指定できます` |
| INSERT SELECT で型不一致 | `型不一致: 担当者コード(SINGLE_LINE_TEXT) → 担当者(USER_SELECT)` |
| CREATOR / MODIFIER への更新 | `CREATOR / MODIFIER は更新できません` |
| getFields() 失敗 | フィールド型不明として文字列送信（エラーにしない） |

---

## 8. 日時フィールドの自動変換

### 概要

DATETIME・DATE フィールドは、入力文字列を kintone の要求形式に自動変換します。  
変換はブラウザのローカルタイムゾーンを基準とします。

### DATETIME フィールド

kintone は `YYYY-MM-DDTHH:MM:SSZ`（UTC）形式を要求します。

| 入力形式 | 変換後（JST 環境） | 備考 |
|---|---|---|
| `'2026-04-05 12:00'` | `'2026-04-05T03:00:00Z'` | スペース区切り・秒省略 |
| `'2026-04-05 12:00:00'` | `'2026-04-05T03:00:00Z'` | スペース区切り・秒あり |
| `'2026/04/05 12:00'` | `'2026-04-05T03:00:00Z'` | スラッシュ区切り |
| `'2026-04-05T12:00'` | `'2026-04-05T03:00:00Z'` | T 区切り・秒省略 |
| `'2026-04-05T03:00:00Z'` | `'2026-04-05T03:00:00Z'` | 既に UTC → 変換なし |

### DATE フィールド

| 入力形式 | 変換後 |
|---|---|
| `'2026/04/05'` | `'2026-04-05'` |
| `'2026-04-05'` | `'2026-04-05'`（変換なし） |

### 実装箇所

`src/converter/dmlToKintone.ts` — `convertString()` 内で `fieldType === "DATETIME"` / `"DATE"` を検出して変換。  
`getFields()` で取得した `FieldTypeMap` をフィールド変換時に参照します。

### タイムゾーンの注意点

- DATETIME 変換は `new Date(localTimeString).toISOString()` を使用
- kintone プラグインが動作するブラウザのローカルタイムゾーンで変換される
- UTC のまま指定したい場合は末尾に `Z` を付ける（例: `'2026-04-05T03:00:00Z'`）

---

## 9. 非対応（本スコープ外）

- 算術式・CASE WHEN での配列生成（`SET 担当者 = CASE WHEN ... THEN ['u1'] END`）
- `UPDATE SET` で配列リテラルを使った CASE WHEN の結果型判定
- ユーザー系フィールドへの `name` 指定（`code` のみ受け付ける）
- INSERT SELECT での異型変換（型不一致はエラー）

---

## 9. バージョン履歴

| バージョン | 内容 |
|---|---|
| 1.0 | 初版。DESCRIBE 自動判定 + 配列リテラル + INSERT SELECT 同型転送 |
| 1.1 | DATETIME / DATE フィールドの自動変換を追加 |
