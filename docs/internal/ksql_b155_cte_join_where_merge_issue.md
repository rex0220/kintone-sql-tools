# B155 CTE→APP JOIN の取得クエリに B151/B152 で開放した WHERE 葉が合流しない

- 起票: 2026-08-08（[依頼元の v3.61.0 返信 §5](../../../ksql-analytics/docs/internal/kSQLエンジンへの返信-20260807-v3610.md)・エンジン側で再現確認済み）
- ステータス: 📝 **調査完了（2026-08-08・原因確定・影響範囲は単一表 FULL_SCAN まで拡大）・方向判断待ち（案 A 推奨・優先 中）**
- 関連: [B150](ksql_b150_cte_join_date_pushdown_issue.md)（結合キー側は解決済み）／
  [B151](ksql_b151_join_inclusive_range_pushdown_issue.md)／[B152](ksql_b152_join_pushdown_all_types_issue.md)

## 1. 症状（実測・v3.61.0）

同じ `WHERE t.個数 <= 100 AND t.製品名 = '牛乳' AND t.入出庫区分 = '出庫'` で:

```
CTE→APP（日付キー・範囲 prefilter）:
  kintone query: (日付 >= "2026-07-29" and 日付 <= "2026-08-04") and (入出庫区分 in ("出庫"))
  → 合流したのは選択系正規化の 1 本だけ。TEXT `=` と NUMBER `<=` が乗らない

物理→物理:
  kintone query: 日付 >= "2026-05-08" and 個数 <= 100（fetch: EXACT / relation: exact）
  → 両方乗る（v3.60.0 の開放どおり）
```

**結果は正しい**（残余再評価）。**取得量の削減が部分的**なだけ。

## 2. 原因（2026-08-08 調査で確定）

**B76 世代の「安全な葉」規則が 2 つの実装に存在し、B151/B152 は片方しか開放していなかった。**

| 実装 | 受理する葉 | 使われる経路 |
|---|---|---|
| `joinPredicatePushdown.classifySupportedLeaf` | **B151/B152 で全面開放済み** | 物理→物理 JOIN の pushdown plan |
| `wherePredicatePushdown.isSafeComparison`（旧） | KLIKE・`$id`・**NUMBER の `=` と安全整数 strict `<` `>` のみ**・選択系 IN（実在検証） | `buildKlikePushdownPlan.joinConditions` → **CTE/一時テーブル含む FULL_SCAN JOIN の per-alias 条件**（`execute.ts:5540-5542`）＋**単一表 FULL_SCAN の安全プレフィルタ** |

**決定的な実測**（v3.61.0）＝同じ CTE→APP JOIN で **`個数 < 101`（旧規則の strict）は合流し、
`個数 <= 100`（B151 で開放済みのはずの inclusive）は落ちる**。
**B151 が撤廃した「安全整数 strict のみ」制限が、第 2 の実装に凍結されたまま生き残っていた**
——同じ規則を 2 箇所に書くと片方だけ直る、という B141 のコード版。

### 影響範囲は単一表にも及ぶ（調査で新発見）

```
SELECT $id FROM APP4228 WHERE 製品名 = '牛乳' AND 仕入先 LIKE 'zz'
→ kintone query: (全件取得)   ※ 製品名 = '牛乳' がプレフィルタに使われない
```

LIKE 等で WHERE 全体の exact 直列化が崩れた**単一表 FULL_SCAN の「安全な条件だけ prefilter」も
同じ旧抽出器**なので、TEXT `=`・NUMBER inclusive などが乗らない。**LIKE 併用の絞り込みは
よくある形**のため、優先度を中へ上げる。

## 3. 対応の方向（調査後）

| 案 | 内容 |
|---|---|
| **A（推奨）** | **`isSafeComparison` の葉判定を `classifySupportedLeaf`（B151/B152 の正）へ統一**。CTE 結合の per-alias 条件と単一表 FULL_SCAN プレフィルタの両方に B151/B152 の開放が自動で届く。必要な型メタ（fieldTypes / fieldOptions）は既に options で渡っている。B150 仕様の「型一覧を複製しない」原則をこの残存複製にも適用する形 |
| B | 文書化のみ（依頼元は `ksql_explain` 確認を規約化済み） |

**案 A の副次効果**＝B154（`not applied` 表示の誤読）も、統一設計の中で表示を整理すれば同時に解消できる見込み。

## 4. 次の一手

案 A を B150 方式（codex 仕様 → 実装前実測 → 実装 → 3 経路受入）で 1 サイクル。
受入の要＝①依頼元の (a) 形で `製品名 = '牛乳'`・`個数 <= 100` が合流する
②単一表 FULL_SCAN（LIKE 併用）で TEXT `=` がプレフィルタに乗る
③旧規則でしか通らなかった形の回帰なし④結果不変（3 経路一致）。
