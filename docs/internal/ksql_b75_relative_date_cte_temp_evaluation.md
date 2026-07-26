# B75 相対日付を CTE 本体・一時テーブルでも使えるように（第4許可形）

- 起票: 2026-07-26
- ステータス: 📝 **計画済み・未着手（優先 中〜高／次点）**。実装計画は [B75 実装計画](ksql_b75_relative_date_cte_temp_impl_plan.md)。実装は codex・レビューは Claude。
- 出典: Pro（ksql-dashboard-pro）検証報告 2026-07-26 の NG ケース ②③（実エンジン v3.24.0）
- 関連: [B67 Phase1/Phase2 A](ksql_b67_phase2_impl_plan.md) / [B72 第3許可形](ksql_b72_relative_date_fullscan_exact_spec.md) / [B76 JOIN](ksql_b76_join_predicate_pushdown_extension_evaluation.md)

## 1. 事象

CTE 本体（`WITH x AS (SELECT ... WHERE 日付 = THIS_MONTH() ...)`）で相対日付を使うと、
押し下げ可能かどうかに関係なく**取得前に拒否**される。JOIN の有無は無関係。

```sql
WITH cur AS (
  SELECT 担当者, SUM(受注金額) AS 売上 FROM APP100 WHERE 受注日 = THIS_MONTH() GROUP BY 担当者
)
SELECT * FROM cur
-- THIS_MONTH: WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN (path=statement.cte[0])
```

`CREATE TEMP TABLE ... AS SELECT ... WHERE 日付 = THIS_MONTH()` も同様（`path=statement.query`）。

## 2. 原因（実コード確定）

`relativeDatePushdownGuard.ts` の `collectWith()` が **CTE 本体を無条件に `kind: "FORBIDDEN"`** として
candidates に積む。`FORBIDDEN` は plan walk の先頭で capability 判定を経ずに即 reject される。

```ts
// src/core/optimization/relativeDatePushdownGuard.ts  collectWith()
statement.ctes.forEach((cte, index) => {
  if (cte.query.type === "SELECT") {
    collectSelect(cte.query, `${path}.cte[${index}]`, candidates, /* forceForbidden */ true, true, false);
  } else if (cte.query.type === "UNION") {
    collectUnion(cte.query, `${path}.cte[${index}]`, candidates, /* forceForbidden */ true, false);
  }
});
if (statement.query.type === "SELECT") {
  collectSelect(statement.query, `${path}.main`, candidates, /* forceForbidden */ true, true, false);
}
```

`CREATE_TEMP_TABLE` も `collectStatement()` で同様に `forceForbidden = true`。

つまり **B67 起票時の fail-closed 既定がそのまま残っているだけ**で、
「押し下げできないから拒否している」のではない。

### 2.1 例外＝単一 CTE のインライン展開

`canInlineSingleCte()` が真なら CTE は消えて通常 SELECT になり、許可形1に乗るため**通る**。

```sql
-- OK（実測）: query=受注日 = THIS_MONTH() order by $id asc limit 500 offset 0
WITH cur AS (SELECT 担当者, 受注金額 FROM APP100 WHERE 受注日 = THIS_MONTH()) SELECT * FROM cur
```

ただしインライン条件は厳しく（単一 CTE・本体が SIMPLE・列は WILDCARD か素の FIELD・
最終側に `JOIN`/`GROUP BY`/`DISTINCT`/集計列が無い）、**集計用途では成立しない**。
実測でも最終側を `SELECT 担当者, SUM(受注金額) FROM cur GROUP BY 担当者` にすると
`path=statement.cte[0]` で落ちる。**利用者向けの回避策としては使えない。**

## 3. 実現可能性（probe による裏取り）

同じ形をリテラル日付で流すと、**CTE 本体は WHERE をサーバーへ押し下げている**。

```
WITH cur AS (SELECT 担当者, SUM(受注金額) AS 売上 FROM APP100 WHERE 受注日 = '2026-07-01' GROUP BY 担当者) SELECT * FROM cur
→ getRecords app=100 query=受注日 = "2026-07-01" order by $id asc limit 500 offset 0
```

これは B72 が第3許可形として開けた「whole WHERE exact ＋ FULL_SCAN」と**同一の形**である。
B76（JOIN）と違い、押し下げ機構は既に存在する。

## 4. 方針案

**第4許可形＝CTE 本体・一時テーブル source の `FULL_SCAN_EXACT`。**
B72 の `buildRelativeDateFullScanExactPlan()` をそのまま適用対象に含め、
`collectWith` / `CREATE_TEMP_TABLE` の blanket `forceForbidden` を
「B72 と同じ条件を満たすなら SELECT 候補として扱う」に緩める。

### 4.1 必須の安全条件（B72 から継承）

- source が単一物理 APP（`cteName === null` / `subtableCode` なし / `joins.length === 0`）
- `capability === "EXACT_PUSHDOWN"`（WHERE 全体が exact に serialize できる）
- serialize 後の文字列に相対日付関数の出現が過不足なく一致（`sameOccurrenceList`）
- `orderMode !== "KINTONE_NATIVE"`（KORDER は従来どおり拒否）
- **client 側の残余 WHERE 評価が 0**（`residualWhere = null`）

### 4.2 最大の検討点＝残余抑止の配線

CTE 本体は現状 push down しても**クライアント側で WHERE を再評価している**可能性が高い
（`runFullScan` は `input.residualWhere !== undefined ? input.residualWhere : stmt.where`）。
再評価が残ると相対日付が client 評価されてしまい、fail-closed 設計に反する。
**B72 で作った `residualWhere = null` の配線を CTE 本体の実行経路にも通すこと**が実装の核心。

> B72 Step 2 の教訓（guard 緩和と runtime 残余抑止は**同一 merge** で入れる）をここでも適用する。
> guard だけ先行させると「相対日付を client 評価する経路」が開いてしまい backstop が漏れる。

### 4.3 スコープ外（fail-closed 継続）

- 実体化 CTE を **JOIN の入力**にする形（B76 の JOIN 側制約が別途かかる）
- CTE 本体が `UNION` の枝（別途評価）
- 相互参照・再帰 CTE（B53 領域）

## 5. 影響・規模

- **純加法**（現在通っているクエリの結果は不変）。SemVer=minor。
- **想定 1〜1.5 人日**（guard のみの変更で runtime 実装が無いため B72 より軽い）。詳細は [B75 実装計画](ksql_b75_relative_date_cte_temp_impl_plan.md)。
- 公開面: 言語リファレンス §5 の「CTE 本体では相対日付不可」の記述を要更新。

## 6. 優先度の根拠

Pro のダッシュボード用途（集計を CTE に切り出して JOIN する構成）で直接ブロックになっている。
B72 で単純な集計クエリは解消したが、**CTE を挟むと再び使えなくなる**ため体験の一貫性を欠く。
機構が既にあり、B72 と同型で risk が読めている点も着手しやすい。
