# B140 CTE の `GROUP BY` キーを全順序として証明する 仕様（R1）

- ステータス: ❌ **R1 は破棄。→ [仕様 R2](ksql_b140_cte_groupby_total_order_spec_r2.md)**（2026-08-07）。
  **中核（どの出力が `GROUP BY` キーか）は [B148](ksql_b148_bare_column_group_by_issue.md) の実装で解けた**
- 起票: [B140](ksql_b140_cte_groupby_total_order_issue.md)
- 関連: [B127](../ksql_issue_tracker.md)（既定フレーム警告・v3.47.0）／
  [B128](ksql_b128_lag_lead_spec.md)（`LAG`/`LEAD`・v3.51.0）

---

## 0. 確定事項（実測・コード確認）

### 0.1 **B127 と B128 の両方で偽陽性が出る**（実測・v3.51.0）

**同じ CTE の上で、2 種類の警告がどちらも不要に出る。**

```sql
WITH 月次 AS (
  SELECT DATE_FORMAT(日付, '%Y-%m') AS 年月, SUM(個数) AS 出庫数
  FROM APP4228 WHERE 入出庫区分 = '出庫' GROUP BY 年月
)
SELECT 年月, 出庫数, SUM(出庫数) OVER (ORDER BY 年月) AS 累計 FROM 月次
```

```
累計 は既定フレーム（RANGE）で評価されます。ORDER BY の値が同じ行はすべて同じ値になります。…
```

**`年月` は `GROUP BY` キーなので 1 行 1 値で一意。同順の行は存在し得ない。**
**したがって `RANGE` と `ROWS` の結果は必ず同一で、この警告は無意味。**

`LAG` 側も同じ CTE で警告が出る（起票 §1）。

> **起票時の「B127 側にも同じ穴があるか」は実測で確認できた。** **ある。**
> **本件は B128 だけの話ではなく、B127 の穴でもある。**

### 0.2 現行の判定器

```ts
// src/execute.ts:2552-2565
function canProveTotalWindowOrder(stmt, orderBy, resolveField, context): boolean {
  if (context !== "DIRECT" || stmt.joins.length > 0
      || stmt.from.cteName !== null || stmt.from.subtableCode != null) {
    return false;
  }
  return orderBy.some((item) => {
    if (item.key.type !== "FIELD_NAME") return false;
    const ref = aggregateFieldRef(item.key.name);
    return ref.field === "$id" || resolveField(ref)?.fieldType === "RECORD_NUMBER";
  });
}
```

**CTE を読む SELECT は 2 条件（`context !== "DIRECT"` と `from.cteName !== null`）で即座に false。**
**根拠にできるのは物理フィールドの `$id` / `RECORD_NUMBER` だけ。**

### 0.3 呼び出し元は 1 か所に集約されている

`collectDefaultRangeWindowWarnings`（`execute.ts:2567-2597`）が
**B127（既定フレーム）と B128（VALUE）の両方**を出しており、
**どちらも同じ `canProveTotalWindowOrder` を通る**。**1 か所直せば両方に効く。**

---

## 1. スコープ

| 区分 | 内容 |
|---|---|
| **対象** | **CTE の `GROUP BY` キーを全順序の根拠として使えるようにする** |
| **対象** | B127（既定フレーム）と B128（VALUE）の**両方**（判定器が共通なので自動的に両方） |
| **非対象** | 一時テーブル（→ §5-1。定義が別の文にあり経路が違う） |
| **非対象** | `ROLLUP` / `CUBE` / `GROUPING SETS`（→ §2.3） |
| **非対象** | JOIN・サブテーブルを含む形（現行どおり証明しない） |
| **非対象** | 警告の文言（変えない） |

---

## 2. 判定の追加

### 2.1 証明の形

**CTE `N` を読む SELECT で、`N` の定義 SELECT が `GROUP BY k1..kn` を持ち、
ウィンドウの `ORDER BY` が `k1..kn` を**すべて**含むなら、全順序。**

**根拠**＝`GROUP BY` の結果は 1 グループ 1 行なので、`(k1..kn)` の組はその CTE 内で一意。

```
WITH 月次 AS (... GROUP BY 年月)  →  OVER (ORDER BY 年月)          … 証明できる
WITH m AS (... GROUP BY a, b)     →  OVER (ORDER BY a, b)          … 証明できる
WITH m AS (... GROUP BY a, b)     →  OVER (ORDER BY a)             … 証明できない（正しい）
```

**キーの対応は出力列名で取る。** `SELECT DATE_FORMAT(...) AS 年月 ... GROUP BY 年月` のように
**`GROUP BY` が SELECT の別名を参照する形**が現行の標準（`GROUP BY` に式は書けない）。

### 2.2 `DISTINCT` も根拠にできる（任意・→ §5-2）

`SELECT DISTINCT a, b FROM ...` の CTE は `(a, b)` について一意。
**ただし `ORDER BY` が出力列を全部含む必要があり、実用上まれ。** 入れるかは論点。

### 2.3 `ROLLUP` / `CUBE` / `GROUPING SETS` は根拠にしない

**小計・総計行では除外されたキーが空文字になる**（B124 の検討で実測済み）。
**実データに空文字があると小計行と衝突する**ため、一意性が壊れる。**除外する。**

### 2.4 `UNION` を含む CTE も根拠にしない

`GROUP BY` した 2 つの SELECT を `UNION` した CTE は、
**両側に同じキーがあれば重複し得る**（`UNION` は重複排除するが、`UNION ALL` はしない）。

---

## 3. 実装方針

### 3.1 CTE 定義へ到達できるようにする

現行 `canProveTotalWindowOrder` は `stmt` しか受けず、**CTE の定義を見られない**。
**`WithStatement` の CTE 定義（または解決済みの列メタ）を渡す必要がある。**

**論点**＝呼び出し元がどこまで文脈を持っているか。**実装時に確認する**（→ §5-3）。

### 3.2 `context !== "DIRECT"` の扱い

**現行はこの 1 行で CTE 経路を全部落としている。**
**「CTE を読む」ことと「証明できない」ことを分ける**必要がある。

**`DERIVED` でも、読んでいる CTE の定義が §2.1 を満たすなら証明できる**ようにする。

### 3.3 判定は `some` ではなく「全キーを含むか」

現行は `orderBy.some(...)`（1 つでも `$id` があれば真）。
**`GROUP BY` キーは「全部含む」必要がある**ので、**別の述語**になる。
**既存の `$id` / `RECORD_NUMBER` 判定は残す**（純加法）。

---

## 4. 受入条件

### 4.1 警告が消えること（**B127 と B128 の両方**）

| 入力 | 期待 |
|---|---|
| `WITH m AS (... GROUP BY k) SELECT SUM(x) OVER (ORDER BY k) FROM m` | **B127 の警告が出ない** |
| 同上で `LAG(x) OVER (ORDER BY k)` | **B128 の警告が出ない** |
| `GROUP BY a, b` に対し `ORDER BY a, b` | **出ない** |
| `GROUP BY a, b` に対し `ORDER BY b, a`（順序違い） | **出ない**（一意性は順序に依らない） |

### 4.2 警告が残ること（**偽陰性を作らない**）

| 入力 | 期待 |
|---|---|
| `GROUP BY a, b` に対し `ORDER BY a` だけ | **出る**（本当に同順があり得る） |
| `GROUP BY` の無い CTE | **出る** |
| `ROLLUP` / `CUBE` / `GROUPING SETS` の CTE | **出る**（§2.3） |
| `UNION` を含む CTE | **出る**（§2.4） |
| JOIN を含む SELECT | **出る**（現行どおり） |
| 一時テーブル経由 | **出る**（本 Phase 非対象） |

### 4.3 回帰

1. **direct APP ＋ `$id` / `RECORD_NUMBER` の抑止が不変**（現行の唯一の証明経路）
2. **値は一切変わらない。** 本件は警告の出し分けだけ
3. **暗黙のタイブレークを comparator に足さない**（既存の並びが変わる）

### 4.4 実機

**§0.1 の 2 本**（`SUM(...) OVER` と `LAG(...) OVER`）で**警告が消えることを確認する**。
**値が変わらないこと**も同時に見る。

---

## 5. 未確定（実装時に決めて報告する）

1. **一時テーブル**（`CREATE TEMP TABLE #t AS SELECT ... GROUP BY k`）を同じ方法で扱えるか。
   **扱えるなら入れる**（定義が別の文にあるため経路が違う）
2. **`DISTINCT` を根拠に入れるか**（§2.2）
3. **CTE 定義へ到達する経路**（§3.1）。`canProveTotalWindowOrder` のシグネチャをどう変えるか

---

## 6. 採らなかった案

### 実行時にタイの有無を見る

**ソート後の行が手元にあるので、隣接行が `ORDER BY` キーで等しいかを実際に見れば
「今回の結果にタイがあるか」は厳密に分かる。**

**採らない。**

- **同じクエリが日によって警告を出したり出さなかったりする。** 利用者から見て挙動が不安定
- 警告の目的は「**このクエリは同順があると壊れる**」という**構造の指摘**であり、
  「今回はたまたま大丈夫」ではない
- **静的に証明できる形（本件）を先に潰すほうが、警告の意味が一貫する**

**ただし将来、静的に証明できない形について「実際にタイがあったときだけ出す」へ
切り替える余地は残る。** その場合も本件の静的証明は無駄にならない。
