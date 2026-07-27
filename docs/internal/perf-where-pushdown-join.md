# WHERE 条件 Push Down（JOIN 時のレコード取得最適化）

> **陳腐化した履歴文書（2026-07-27）:** 本文は初期検討時の記録であり、現行仕様・設計根拠として
> 再利用しないでください。JOIN 述語押し下げの現行契約は
> [`ksql_b76_join_pushdown_phase_a_spec.md`](ksql_b76_join_pushdown_phase_a_spec.md) と
> [`ksql_language_reference.md`](../ksql_language_reference.md) を参照してください。

## 背景

JOIN クエリは現状 `FULL_SCAN` モードで実行され、各テーブルのレコードを全件取得したあと
JavaScript 側で WHERE フィルタを適用している。

```sql
SELECT a.顧客No, a.会社名, a.顧客ランク,
       b.案件No_, b.案件名, b.商談フェーズ, b.売上
FROM APP4148 AS a
INNER JOIN APP4149 AS b ON a.顧客No = b.顧客No_
WHERE b.商談フェーズ IN ('提案中', '内示', '受注')
  AND a.顧客ランク IN ('A')
ORDER BY b.案件No_ DESC
```

現在の EXPLAIN 出力：

```
mode: FULL_SCAN
reason: JOIN あり
app: APP4148 AS a (4148)
kintone query: (全件取得)
fields: 顧客No, 会社名, 顧客ランク
JOIN: APP4149 AS b (4149)
kintone query: (全件取得)
fields: 案件No_, 案件名, 商談フェーズ, 売上, 顧客No_
```

## 目標

WHERE 条件を各テーブルへ分解（Predicate Pushdown）し、
kintone API の query パラメータに乗せて必要なレコードのみ取得する。

目標の EXPLAIN 出力：

```
mode: FULL_SCAN
reason: JOIN あり
app: APP4148 AS a (4148)
kintone query: 顧客ランク in ("A")
fields: 顧客No, 会社名, 顧客ランク
JOIN: APP4149 AS b (4149)
kintone query: 商談フェーズ in ("提案中","内示","受注")
fields: 案件No_, 案件名, 商談フェーズ, 売上, 顧客No_
```

## Push Down 可否の判定基準

| 条件の種類 | 判定 | 理由 |
|---|---|---|
| `a.field = value` / `!=` / `>` / `<` / `>=` / `<=` | ✅ 可 | kintone API サポート済み |
| `a.field LIKE value` | ✅ 可 | kintone API サポート済み |
| `a.field NOT LIKE value` | ✅ 可 | kintone API サポート済み |
| `a.field IN (...)` | ✅ 可 | kintone API サポート済み |
| `a.field NOT IN (...)` | ✅ 可 | kintone API サポート済み |
| `a.field IS NULL / IS NOT NULL` | ✅ 可 | kintone API サポート済み |
| `AND` の両辺が同一テーブル | ✅ 可 | 分割して各 API に適用できる |
| `OR` の両辺が異なるテーブル | ❌ 不可 | 分離すると結果が変わる |
| `a.field = b.field`（クロステーブル） | ❌ 不可 | JOIN 後でないと評価できない |
| `UPPER(a.field) = value` 等（関数付き） | ❌ 不可 | kintone API 非対応 |

> **原則**：`whereToKintone` が変換できる演算子 = push down 可

## 実装ステップ

---

### Step 1：条件分離ロジック作成

**新規ファイル**：`src/core/optimization/wherePredicatePushdown.ts`

#### 実装する関数

```typescript
/**
 * WHERE 式からテーブルエイリアスに対応する push down 可能な条件を抽出する。
 * 抽出できない（クロステーブル・OR・関数付き）条件は null を返す。
 */
export function extractTableCondition(
  where: WhereExpr,
  tableAlias: string
): WhereExpr | null
```

#### アルゴリズム

```
extractTableCondition(expr, alias):
  BINARY / NULL_CHECK:
    → 参照フィールドが alias のみ かつ 関数なし → そのまま返す
    → それ以外 → null

  LOGICAL AND:
    left  = extractTableCondition(left,  alias)
    right = extractTableCondition(right, alias)
    → both non-null : AND(left, right) を返す
    → one non-null  : non-null 側を返す
    → both null     : null を返す

  LOGICAL OR:
    → 両辺が異なるテーブルを参照する可能性 → null を返す（安全側）

  NOT / GROUP:
    → null を返す（複雑化を避け JavaScript 側に委ねる）
```

#### 呼び出しイメージ

```typescript
// WHERE 全体から各テーブル用の条件を取り出す
const condA = extractTableCondition(stmt.where, "a");
// → BinaryExpr { op: "IN", left: a.顧客ランク, right: ["A"] }

const condB = extractTableCondition(stmt.where, "b");
// → BinaryExpr { op: "IN", left: b.商談フェーズ, right: ["提案中","内示","受注"] }
```

#### テスト項目

- `AND` でつながれた異なるテーブルの条件が正しく分離される
- `OR` でつながれた条件は push down されない
- クロステーブル条件（`a.field = b.field`）は push down されない
- 関数付き条件（`UPPER(a.field)`）は push down されない
- エイリアスなし条件（`field = value`、JOIN なし相当）の扱い

---

### Step 2：`whereToKintone` のエイリアス対応確認・修正

**ファイル**：`src/converter/whereToKintone.ts`

#### 確認内容

`a.顧客ランク IN ('A')` のように `FieldRef.tableAlias` が付いた条件を
`whereToKintone` に渡したとき、kintone query 文字列として正しく出力されるか確認する。

期待する変換：

```
a.顧客ランク in ("A")  →  顧客ランク in ("A")   ← エイリアスを除去
```

#### 修正方針

`FieldRef` 処理箇所でエイリアスを除いたフィールド名のみを使用するよう修正する（既に対応済みの場合はスキップ）。

---

### Step 3：`execute.ts` に push down を組み込む

**ファイル**：`src/execute.ts`

#### 変更箇所 1：`executeFullScanSelect`（push down 条件の計算）

```typescript
// executeFullScanSelect の冒頭で各テーブルの push down 条件を計算
const tableConditions = new Map<string, WhereExpr>();

if (stmt.where !== null) {
  const mainAlias = stmt.from.alias ?? String(stmt.from.appId);
  const cond = extractTableCondition(stmt.where, mainAlias);
  if (cond) tableConditions.set(mainAlias, cond);

  for (const join of stmt.joins) {
    const joinAlias = join.table.alias ?? String(join.table.appId);
    const cond = extractTableCondition(stmt.where, joinAlias);
    if (cond) tableConditions.set(joinAlias, cond);
  }
}
```

#### 変更箇所 2：`fetchTableRecordsForFullScan`（main テーブルへの適用）

```typescript
// 現状: JOIN ありの場合 WHERE を API に渡さない
// 変更後: push down 条件が存在すれば kintone query に追加
const pushDownCond = tableConditions.get(mainAlias) ?? null;
const query = buildFetchQuery(stmt, table.appId, pushDownCond);
```

#### 変更箇所 3：`tryFetchJoinRecordsBySourceKeys`（JOIN テーブルへの適用）

```typescript
// 既存: "joinField in (v1, v2, ...)" を生成
// 変更後: push down 条件がある場合は AND で結合
// "joinField in (v1, v2, ...) and 商談フェーズ in ("提案中","内示","受注")"
const pushDownCond = tableConditions.get(joinAlias) ?? null;
const combinedQuery = pushDownCond
  ? `${inClause} and ${whereToKintone(pushDownCond)}`
  : inClause;
```

> JavaScript 側の `applyFilter`（全件 WHERE 評価）は **そのまま維持**する。
> push down は絞り込みの最適化であり、結果の正確性は JavaScript 側フィルタが保証する。

---

### Step 4：EXPLAIN 表示の更新

**ファイル**：`src/core/optimization/sharedPlanner.js`

push down 後の実際の kintone query を EXPLAIN に反映する。

```
変更前: kintone query: (全件取得)
変更後: kintone query: 顧客ランク in ("A")
```

push down 条件がない場合は引き続き `(全件取得)` と表示する。

---

### Step 5：統合テスト・動作確認

#### 確認するクエリパターン

| パターン | push down | 期待動作 |
|---|---|---|
| AND で各テーブル条件が分離できる | ✅ 両テーブルへ | レコード取得数が減少 |
| OR でつながれた条件 | ❌ 不可 | 全件取得のまま（正確性維持） |
| クロステーブル条件のみ | ❌ 不可 | 全件取得のまま |
| WHERE なし | — | 変化なし |
| main テーブルのみ条件あり | ✅ main のみ | JOIN テーブルは全件取得 |

#### 結果の正確性確認

push down あり / なし で同一クエリの結果行が一致することを確認する。

---

## 修正ファイル一覧

| ファイル | 種別 | 内容 |
|---|---|---|
| `src/core/optimization/wherePredicatePushdown.ts` | 新規 | 条件分離ロジック |
| `src/converter/whereToKintone.ts` | 修正（要確認） | エイリアス除去対応 |
| `src/execute.ts` | 修正 | push down 条件の計算・適用 |
| `src/core/optimization/sharedPlanner.js` | 修正 | EXPLAIN 表示更新 |

## ブランチ・マージ手順

```bash
# 作業ブランチ（作成済み）
git checkout perf/where-pushdown-join

# 各ステップをコミット
git add src/core/optimization/wherePredicatePushdown.ts
git commit -m "perf: add WHERE predicate pushdown extraction logic"

git add src/converter/whereToKintone.ts
git commit -m "perf: strip table alias in whereToKintone for pushdown"

git add src/execute.ts
git commit -m "perf: apply per-table WHERE conditions to kintone API calls"

git add src/core/optimization/sharedPlanner.js
git commit -m "perf: show pushed-down kintone query in EXPLAIN output"

# PR 作成
git push -u origin perf/where-pushdown-join
gh pr create --title "perf: WHERE predicate pushdown for JOIN queries"
```
