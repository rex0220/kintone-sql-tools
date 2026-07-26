# B76 JOIN クエリの述語押し下げ拡張（日付・文字列）と相対日付の JOIN 対応

- 起票: 2026-07-26
- ステータス: 📝 **評価・起票（優先 中／Phase A は性能課題として独立に有効）**。未着手。
- 出典: Pro（ksql-dashboard-pro）検証報告 2026-07-26 の NG ケース ①（実エンジン v3.24.0）
- 関連: [B75 CTE 本体](ksql_b75_relative_date_cte_temp_evaluation.md) / [B72](ksql_b72_relative_date_fullscan_exact_spec.md) / [B67 Phase2 A](ksql_b67_phase2_impl_plan.md) / 旧ドラフト [perf-where-pushdown-join.md](perf-where-pushdown-join.md)

## 1. 事象

JOIN を含むと相対日付が取得前に拒否される。

```sql
SELECT a.担当者, SUM(a.受注金額) AS 売上
FROM APP100 a JOIN APP200 t ON a.担当者 = t.担当者
WHERE a.受注日 = THIS_MONTH()
GROUP BY a.担当者
-- THIS_MONTH: WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN (path=statement)
```

集計の有無は無関係（`SELECT a.担当者 ... WHERE a.受注日 = THIS_MONTH()` だけでも同じ）。
相対日付の3つの許可形すべてが `joins.length === 0` を前提としているため。

## 2. 原因（実コード確定・当初の見立てを訂正）

### 2.1 訂正: JOIN でも述語押し下げは「実装済み」

`src/core/optimization/wherePredicatePushdown.ts` は存在し、`execute.ts` に配線済み。
JOIN でも**テーブルごとに**押し下げが効く（実測）。

```
SELECT a.担当者 FROM APP100 a JOIN APP200 t ON ... WHERE a.受注金額 > 100 AND t.目標金額 > 50
→ app=100 q=[受注金額 > 100 order by $id asc limit 500 offset 0]
→ app=200 q=[目標金額 > 50 order by $id asc limit 500 offset 0]
```

> 旧ドラフト `perf-where-pushdown-join.md`（「JOIN は全件取得している」前提）は**この点で陳腐化**している。
> ブランチ `perf/where-pushdown-join` も現存せず、台帳にも未登録。B76 着手時に整理・統合すること。

### 2.2 真の制約＝押し下げ可能なリーフ種別が狭い

`extractSafePushdownLeaves` / `extractTypedPushdownCandidates` が許すのは以下のみ。

| 述語 | 押し下げ | 実測 |
|---|---|---|
| NUMBER `=` / strict `<` `>` | ✅ | `受注金額 > 100` → 押し下げ |
| `$id` の数値比較 | ✅ | `$id <= 3000` → 押し下げ |
| KLIKE | ✅ | （v2.9.0） |
| 選択系 `IN` / `NOT IN` | 条件付き | 型メタ確定時のみ。JOIN 側の呼び出しは `fieldTypes` 未指定 |
| **DATE / DATETIME 比較** | ❌ | `受注日 = '2026-07-01'`・`>= '2026-07-01'` とも押し下げなし |
| **TEXT `=`** | ❌ | `担当者 = '佐藤'` 押し下げなし |
| 関数付き（`DATE_FORMAT(...) = ...`） | ❌ | 原理的に不可 |

これは v2.0.0〜v2.2.0 で押し下げを安全側へ絞り込んだ経緯（`LIKE` 全廃・案A で数値限定）に由来する
**意図的な保守設計**であり、バグではない。

### 2.3 相対日付が拒否される理由は正しい

DATE 述語が押し下げられない以上、JOIN で相対日付を許せば `THIS_MONTH()` を**クライアント評価**することになる。
これは B67 の fail-closed 設計が禁じている当のものなので、**現状の拒否は正しい挙動**。

## 3. 利用者への実務的影響（Pro に共有済み）

Pro の現行 D10 レシピは JOIN ＋ `DATE_FORMAT(a.受注日,'%Y-%m') = DATE_FORMAT(CURRENT_DATE(),'%Y-%m')` 形。
**関数付きのため押し下げ不可・`t.年月`（TEXT）も押し下げ不可**で、両アプリとも全件取得になる。
当面の緩和策は **NUMBER / `$id` 述語を AND で足して母集合を絞る**こと（例 `AND a.$id > 200000`）。

## 4. 方針案（2 Phase）

### Phase A（性能・相対日付と独立）— 日付述語の押し下げ拡張

DATE / DATETIME / CREATED_TIME / UPDATED_TIME の `=` `>` `>=` `<` `<=` を
型メタ確定時に限り押し下げ対象へ追加する。

- 検討点: kintone の日付比較セマンティクス（DATE は日単位・DATETIME は時刻＋TZ）と
  JS 側評価の一致。**不一致なら superset として押し下げ、client 残余評価を必ず残す**（B67 Phase2 A と同型）。
- 空セル・未入力の扱い（数値で前例あり: `IN ('')` 空セル評価／−∞ 準拠）を日付でも確定させること。
- JOIN 以外（単一表 FULL_SCAN）にも同時に効く。効果は JOIN 用途で特に大きい。
- 想定 2〜3 人日。**単独でリリース可能**（相対日付を待たない）。

### Phase B — JOIN での相対日付許可（第5許可形）

Phase A で日付が exact に押し下げられるようになった上で、
B67 Phase2 A の**リーフ採用＋残余からの除去**を JOIN の駆動表に適用する。

- 相対日付リーフが単一の別名（＝単一物理 APP）だけを参照すること
- 採用したリーフを client 残余から確実に除去（相対日付 client 評価 0）
- `OR` / `NOT` にまたがる相対日付は従来どおり拒否
- 想定 3〜5 人日。Phase A なしでは成立しない。

## 5. 優先度の根拠

- **Phase A は相対日付と無関係に価値がある**（JOIN の全件取得を減らす純粋な性能改善）。
  日付での絞り込みは実利用で最も多い形なので効果が読みやすい。
- Phase B は Pro の本命ケースだが、規模が大きく B75（CTE）より費用対効果が劣る。
  **B75 → B76 Phase A → B76 Phase B** の順を推奨。
- ただし押し下げの安全性は kSQL が過去に何度も痛い目を見た領域（v2.0.0 の `LIKE` 全廃）なので、
  Phase A も superset＋残余評価を既定とし、exact を主張するのは検証後に限ること。
