# 課題+仕様: FROM なし SELECT/UNION を一時テーブル化・CTE 文脈で実行すると 0 行になる

- 作成日: 2026-07-15
- ステータス: **課題+仕様案 R2（codex レビュー反映・センチネル共有を修正・実装着手可）**
- 分担: Claude=仕様/観点、Codex=実装/テスト
- 位置づけ: [[fromless-union-temp-table-empty-bug]]。P0（[ksql_search_abort_warning_issue.md](ksql_search_abort_warning_issue.md)）と**同一バージョンで対応**（ユーザー指示）。
- 関連コード: `src/execute.ts`（`executeQueryWithCte`:1601 / `isNoFromSelect`:985 / `executeNoFromSelect`:1029 / `executeUnion`:1512 / `executeFullScanWithCte`:1644）、`src/parser/parser.ts`:618（`__NO_FROM__` 生成）

## 0. 課題（実機確認済み）

FROM なし SELECT（`SELECT '4' AS id`）や FROM なし UNION は、**直接実行すると正しく行を返す**が、**`CREATE TEMP TABLE AS` で実体化すると 0 行**になる。

```sql
-- 直接: 2 行返る
SELECT '4' AS id UNION ALL SELECT '7' AS id;

-- 一時テーブル化: COUNT=0・SELECT * も 0 行（実機確認）
CREATE TEMP TABLE #ids AS SELECT '4' AS id UNION ALL SELECT '7' AS id;
SELECT COUNT(*) FROM #ids;   -- 0（期待は 2）
```

## 1. 根本原因（コードで特定）

FROM なし SELECT は parser（[parser.ts:621](../../src/parser/parser.ts#L621)）で `from = { appId: 0, alias: null, cteName: "__NO_FROM__" }` になる。

- **直接実行経路**: `executeSelect`（[execute.ts:971](../../src/execute.ts#L971)）が最初に `isNoFromSelect(stmt)` を確認し `executeNoFromSelect` へ。直接 UNION（`executeUnion`:1512）も各枝を `executeSelect` 経由で処理 → **正しい**。
- **一時テーブル化・CTE 文脈経路**: `CREATE TEMP TABLE AS` は `runSelectLike` → **`executeQueryWithCte`**（[execute.ts:1601](../../src/execute.ts#L1601)）を通る。ここは `hasCteRef = query.from.cteName != null || …`（[1626](../../src/execute.ts#L1626)）で CTE 参照を判定するが、**`__NO_FROM__` は非 null なので `hasCteRef=true`** になり、`executeFullScanWithCte` へ回される。そこで「`__NO_FROM__` という名の CTE 行」を `cteCache` から探すが存在せず **0 行**。
- UNION の場合、`executeQueryWithCte` は各枝を**再帰的に自分自身で処理**（[1610](../../src/execute.ts#L1610)）するため、各 FROM なし枝が同じく 0 行化する。

→ **`executeQueryWithCte` が `__NO_FROM__` センチネルを実 CTE 参照と誤認**しているのが原因。

## 2. 修正方針

`executeQueryWithCte` の CTE 参照判定から **`__NO_FROM__` を除外**する（FROM なし SELECT は CTE 参照ではない）。

### 案A（採用）: `hasCteRef` から sentinel を除外＋括弧で優先順位明示
```ts
const hasCteRef =
  (
    query.from.cteName != null &&
    query.from.cteName !== NO_FROM_CTE_NAME
  ) ||
  query.joins.some((j) => j.table.cteName != null);
```
→ `hasCteRef=false` となり [1630](../../src/execute.ts#L1630) の `executeSelect(query, …)` へ → `isNoFromSelect` → `executeNoFromSelect`。単一 FROM なし SELECT・UNION 各枝の両方が直る。

### [P1] センチネルは中立モジュールへ集約（**「isNoFromSelect で共有」は不可**）
`__NO_FROM__` 文字列は現在**少なくとも 3 か所**に重複している:
- Parser: [parser.ts:621](../../src/parser/parser.ts#L621)
- Execute: `isNoFromSelect`（[execute.ts:985](../../src/execute.ts#L985)）
- DML guard: [dmlGuard.ts:53](../../src/core/dmlGuard.ts#L53)

`isNoFromSelect` は execute ローカル関数で、parser がそれに依存すべきでない（依存方向が逆）。→ **`NO_FROM_CTE_NAME` を `src/types/ast.ts` 等の中立モジュールに定義**し、parser・execute（`isNoFromSelect`・`executeQueryWithCte`）・dmlGuard の 3 か所すべてがそれを参照する。案A の条件式もこの定数を使う。

## 3. スコープ・受入
- **対象**: `CREATE TEMP TABLE AS <FROM なし SELECT / FROM なし UNION>` の実体化・および CTE 文脈（`executeQueryWithCte`）を通る FROM なし SELECT。
- **受入**:
  1. `CREATE TEMP TABLE #ids AS SELECT '4' AS id UNION ALL SELECT '7' AS id; SELECT COUNT(*) FROM #ids` → **2**。
  2. `SELECT id FROM #ids` → `4`,`7`。`… WHERE $id IN (SELECT id FROM #ids)` が機能。
  3. 単一 FROM なし: `CREATE TEMP TABLE #x AS SELECT 'A' AS v; SELECT * FROM #x` → 1 行 `A`。
  4. 直接 FROM なし SELECT/UNION（従来正しい）は不変。
  5. 実 CTE 参照（`WITH c AS (…) SELECT … FROM c`）・通常の一時テーブル参照は不変（`__NO_FROM__` 以外の cteName は従来どおり CTE 扱い）。
- **非対象**: FROM なし SELECT の機能拡張（列式・複数行生成など）。本件は「実体化経路の 0 行化バグ修正」のみ。

## 4. 進め方
- 実装: `NO_FROM_CTE_NAME` を `src/types/ast.ts` に定義 → parser・execute・dmlGuard の 3 か所を差し替え → `executeQueryWithCte` の `hasCteRef` を案A（括弧付き・定数使用）に修正 → 実機（上記受入・FROM なし単一/UNION 各枝・実 CTE 参照の非退行）→ **P0 と同一の minor バージョンでリリース**。
