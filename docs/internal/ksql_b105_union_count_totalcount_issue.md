# B105 `UNION` の枝の `COUNT(*)` が単発 GET にならず、既定値では失敗する

- 起票: 2026-07-31
- ステータス: 📝 **評価（優先 中）**
- 出典: オーナーの実クエリ（12 アプリの件数一覧）が FULL_SCAN になった
- 関連: [B94 `COUNT(*)` の単発取得](ksql_b94_count_star_totalcount_spec.md) / [B97 打ち切られた入力の集計を fail-closed 化](ksql_b97_incomplete_aggregate_failclosed_issue.md)

## 1. 症状

**同じ `COUNT(*)` が、単体では成功し `UNION` の枝では失敗する。**

```
SELECT COUNT(*) FROM APP912                        → 10228（成功）

SELECT 'a' AS k, COUNT(*) AS n FROM APP912
UNION ALL SELECT 'b', COUNT(*) FROM APP2           → エラー
  「集計の正しい結果には完全な候補集合が必要です。
    complete input reason: AGGREGATE。取得件数が上限（500 件）を超えました。」
```

**いずれも既定 `maxRecords=500`。**

## 2. 原因

**[B94](ksql_b94_count_star_totalcount_spec.md) の単発 GET は、トップレベルの単一 SELECT にしか適用されない。**

| | |
|---|---|
| 実行時 | `markCountTotalCountRoot()` の呼び出しは `src/execute.ts:1069` の **`case "SELECT"` だけ**。`case "UNION"` は枝を登録しない |
| `EXPLAIN` | `buildSelectPlan()` の `allowTotalCountPlan` は**トップレベルだけ `true`**。union 枝（`:10535`）・CTE 本体・インライン CTE・サブクエリ・DML source はすべて `false` |

**両者は一致している。**`EXPLAIN` の `false` は表示漏れではなく、実装と揃った設計である。

```
単体   SELECT COUNT(*) FROM APP912  → mode: COUNT_TOTAL_COUNT / single GET
UNION 枝                              → mode: FULL_SCAN / (全件取得) / fields: $id
```

**FULL_SCAN に落ちると、[B97](ksql_b97_incomplete_aggregate_failclosed_issue.md) の完全入力要求が効く。**
**`AGGREGATE` は `onLimit=truncate` を `error` へ倒すため、`maxRecords` を超えると停止する。**

**B94 の経路は `maxRecords` を適用しないので、単体では止まらない。この差が症状になる。**

## 3. B94 の仕様に `UNION` は無い

**B94 の仕様は対象外を列挙している。**

> `COUNT(列)` / 他の集計関数との併用 / 他の列との併用 /
> `GROUP BY` / `HAVING` / `DISTINCT` / window / `JOIN` /
> **一時テーブル・CTE・サブテーブル仮想テーブル** / `LIMIT`・`OFFSET` あり

**`UNION` はどこにも書かれていない。**含めても除外してもいない。

**実装は「入れ子の文脈すべてを一律に対象外」としており、その結果 `UNION` も外れている。**

## 4. 実害（実測 2026-07-31）

**オーナーの実クエリ（12 アプリの件数一覧）で測った。**

```
APP2 6 / APP15 9 / APP45 12 / APP75 148 / APP76 0 / APP86 6
APP912 10228 / APP3235 5 / APP4147 18 / APP4148 215 / APP4149 20 / APP4150 8
                                                              合計 10,675 件
```

| | |
|---|---|
| `$id` 全件取得（500 件/ページ） | **約 32 回の GET** |
| 単発 GET なら | **12 回** |
| **既定 `maxRecords=500` での結果** | **エラー**（APP912 の枝で停止） |

**回避策は `maxRecords` を 11,000 などへ引き上げること。**
**ただし 10,675 件を実際に取得するので、遅さは残る。**

## 5. **`UNION` の枝は、他の入れ子とは性質が違う**

**CTE 本体・一時テーブル source・サブクエリ・DML source は、
結果が下流で使われる。**

**`UNION` の枝は終端である。**

- **枝の出力はそのまま結果集合へ入る**（`UNION` なら重複排除が乗るだけ）
- **`SELECT COUNT(*) FROM APPn` が `EXACT_PUSHDOWN` なら、枝の出力は 1 行**
- **その 1 行の値は `totalCount` そのもの。**下流が元レコードを必要としない

**したがって `UNION` の枝だけを対象に加えるのは筋が通る。**
**他の入れ子は B94 の仕様どおり対象外のままにする。**

## 6. 案

### 案 A: **`UNION` の枝を root として登録する**（推し）

- 実行時＝`executeUnion` が `executeSelect` を呼ぶ 2 箇所で `markCountTotalCountRoot()` を通す
- `EXPLAIN`＝`:10535` の `allowTotalCountPlan` を `true` にする
- **適用可否の判定は既存のものをそのまま使う**（`isCountStarTotalCountEligible` ＋ `EXACT_PUSHDOWN`）。
  **枝ごとに個別に判定される**ので、対象外の枝は従来どおり FULL_SCAN になる
- **入れ子 `UNION` は `executeUnion` が再帰するため、自然に届く**

### 案 B: 何もしない（`maxRecords` の引き上げで回避）

- **同じクエリが単体で成功し `UNION` で失敗する**という驚きが残る
- **件数一覧は実用的な用途**で、アプリが増えるほど踏みやすい

### 案 C: 入れ子の文脈すべてに広げる

- **B94 が明示的に対象外とした CTE・一時テーブルを覆す**
- **B94 の「迷ったら従来経路へ落とす」という方針に反する**

## 7. 現時点の見立て

**案 A。優先度は 中。**

- **誤った結果を返す問題ではない**（正しい件数を返すか、エラーで止まる）
- **ただし実用的なクエリが既定値で失敗する。**回避策はあるが自明ではない
- **修正は小さく、判定は既存のものを流用できる**

**B94 の方針は保つ。**

> **迷ったら従来経路へ落とす。速さより正しさを優先する。**

**枝ごとの判定に手を入れず、「root として登録するかどうか」だけを変える。**

## 8. 対象外

| | 理由 |
|---|---|
| **CTE 本体・一時テーブル source・サブクエリ・DML source** | **B94 が明示的に対象外とした**（§3）。今回覆さない |
| **`COUNT(*)` 以外の集計** | B94 と同じ。広げない |
| **適用可否の判定そのもの** | **既存の `isCountStarTotalCountEligible` を流用する**。再定義しない |
| **`UNION` の重複排除・`ORDER BY`・`LIMIT`** | **枝の外側の話**。触らない |
