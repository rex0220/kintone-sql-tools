# 仕様: B105 — `UNION` の枝でも `COUNT(*)` を単発 GET にする

- 作成: 2026-07-31
- 対象課題: [B105](ksql_b105_union_count_totalcount_issue.md)（**§2 が原因・§5 が線引きの根拠**）
- ステータス: 📋 **実装待ち**
- 分担: Claude=仕様/レビュー、codex=実装/テスト
- SemVer: **minor**（適用範囲の拡大。公開型・既存の挙動は不変）

## 1. 決めたこと

**`UNION` の枝を、[B94](ksql_b94_count_star_totalcount_spec.md) の単発 GET の対象に加える。**

**適用可否の判定には一切手を入れない。**
**変えるのは「root として登録するかどうか」だけ。**

## 2. 変更点（2 箇所だけ）

### 2.1 実行時

**`executeUnion`（`src/execute.ts:4565` 付近）が `executeSelect` を呼ぶ 2 箇所で、
`markCountTotalCountRoot()` を通す。**

```ts
// 左辺（UNION でない場合）と右辺の両方
executeSelect(markCountTotalCountRoot(stmt.left), ...)
executeSelect(markCountTotalCountRoot(stmt.right), ...)
```

- **入れ子 `UNION` は `executeUnion` が再帰するため、自然に届く。**
  **左辺が `UNION` のときは従来どおり `executeUnion` を呼ぶ**（マークしない）

### 2.2 `EXPLAIN`

**`src/execute.ts:10535` の `allowTotalCountPlan` を `false` → `true` にする。**

```ts
buildSelectPlan(sel, `[union:${i + 1}]`, capabilities, orderPlans, plainGroupByPlans, true)
```

**他の呼び出し（CTE 本体 `:10549` / インライン CTE `:10568` /
サブクエリ `:10621`・`:10624`・`:10628`・`:10642` / DML source `:10689`）は
`false` のまま変えないこと。**

> **実行時と `EXPLAIN` は必ず一致させること。**
> **B94 の受入条件 7「`EXPLAIN` が実態を映す」を引き継ぐ。**

## 3. 変えないもの

| | |
|---|---|
| `isCountStarTotalCountEligible` | **触らない。**判定を再定義しない |
| `EXACT_PUSHDOWN` の意味 | **触らない** |
| `tryCountStarWithTotalCount` | **触らない**（フォールバック・`searchAborted` の fail-closed を含む） |
| `UNION` の重複排除・`ORDER BY`・`LIMIT` | **枝の外側**。触らない |
| CTE 本体・一時テーブル source・サブクエリ・DML source | **B94 が明示的に対象外とした**。今回覆さない |

## 4. なぜ `UNION` の枝だけ広げてよいか

**枝は終端だからである。**

- **枝の出力はそのまま結果集合へ入る**（`UNION` なら重複排除が乗るだけ）
- **`SELECT COUNT(*) FROM APPn` が `EXACT_PUSHDOWN` なら出力は 1 行**
- **その値は `totalCount` そのもので、下流が元レコードを必要としない**

**CTE 本体・一時テーブル source・サブクエリ・DML source は、結果が下流で使われる。**
**そちらは B94 の判断を維持する。**

## 5. 受入条件

1. **`SELECT COUNT(*) FROM APPn UNION ALL SELECT COUNT(*) FROM APPm` の各枝が
   `COUNT_TOTAL_COUNT` になり、`EXPLAIN` にもそう出る**
2. **既定 `maxRecords` で、10,000 件超のアプリを含む `UNION` が成功する**
   （`maxRecords` が適用されないため）
3. **`UNION`（`ALL` なし）でも同じ**——重複排除は枝の外側の話であり、影響しない
4. **入れ子 `UNION` の枝にも届く**
5. **適用条件を外れた枝は従来どおり FULL_SCAN**——同じ `UNION` の中で
   **枝ごとに判定が分かれる**こと（例: 一方が `COUNT(*)`、他方が `COUNT(列)` や `GROUP BY` つき）
6. **CTE 本体・一時テーブル source・サブクエリ・DML source は従来どおり**
   ＝**`EXPLAIN` で `COUNT_TOTAL_COUNT` にならない**
7. **`searchAborted` は従来どおり fail-closed**
8. **BYO が `totalCount` を返さない場合は従来どおり全件取得へフォールバックし、
   件数が正しい**（`0` を返さない）
9. **既存テスト全 green・snapshot 22 不変**

## 6. テスト

**B94 の既存テストと同じ観点を `UNION` について足す。**

- **枝が単発 GET になること**（`getRecords` の呼び出し回数で確かめる）
- **枝ごとに判定が分かれること**（受入 5）
- **入れ子 `UNION`**（受入 4）
- **CTE 本体・サブクエリが従来どおりであること**（受入 6）
- **フォールバックと `searchAborted`**（受入 7・8）

> **B94 の既存テストを書き換えないこと。**
> **書き換えが要るなら、それは既存の決定を覆している合図。止めて報告すること。**

## 7. 注意点

- **B94 の方針を保つこと**——**迷ったら従来経路へ落とす。速さより正しさを優先する**
- **件数は検算されにくい。**利用者は返ってきた数を信じる
- **判定を新規に書かないこと。**既存の `isCountStarTotalCountEligible` を通すだけ
- **`allowTotalCountPlan` を `true` にするのは union 枝の 1 箇所だけ**

## 8. 今回やらないこと

| | 理由 |
|---|---|
| 入れ子の文脈すべてへの拡大 | **B94 が明示的に対象外とした**（[B105 §8](ksql_b105_union_count_totalcount_issue.md)） |
| `COUNT(*)` 以外の集計 | B94 と同じ |
| `release/README.txt` と `docs/internal/ksql_*.md` の編集 | リリース時にこちらで書く |
| 版数の更新 | リリース時にこちらでやる |
