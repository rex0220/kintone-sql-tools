# B72 — 相対日付が「WHERE 全体 exact ＋ FULL_SCAN」で拒否される（純 exact ほど通らない逆転）

- 作成日: 2026-07-26
- ステータス: **📝 評価・起票**（2026-07-26）。実エンジンのプローブで設計ギャップを確認。**優先度: 中〜高**（ダッシュボード等の集計クエリで相対日付が実質使えず、回避策が「ダミー述語を足す」という不自然な形になるため）。
- 報告元: kSQL Dashboard Pro（`kSQLエンジン報告-20260726.md` 参考情報の切り分けから判明）
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B72
- 関連: B67 Phase1（v3.20.0・押し下げ専用 server-only）／B67 Phase2 A（v3.21.0・SUPERSET_PREFILTER）

## 1. 現象

`WHERE` 全体が exact に押し下げ可能でも、**文が FULL_SCAN 化する要素（GROUP BY / DISTINCT / 集計 / 通常 ORDER BY 等）を含むと相対日付が拒否**される。一方、**押し下げ不能な残余述語を足すと通る**（Phase2 A の prefilter 形になるため）。

### プローブ実測（2026-07-26・実エンジン）

| クエリ | 結果 |
|---|---|
| `WHERE 日付 = THIS_MONTH()`（単純 SELECT・SIMPLE） | ✅ OK |
| `WHERE 日付 = THIS_MONTH() OR 日付 = LAST_MONTH()`（SIMPLE） | ✅ OK（**OR 単体は拒否要因ではない**） |
| `WHERE 日付 = THIS_MONTH() GROUP BY 区分` | ❌ `WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN` |
| `WHERE 日付 = THIS_MONTH() ORDER BY 日付` | ❌ 同上 |
| `SELECT DISTINCT 区分 … WHERE 日付 = THIS_MONTH()` | ❌ 同上 |
| `WHERE 日付 = THIS_MONTH() AND LENGTH(区分) > 1 GROUP BY 区分` | ✅ **OK**（Phase2 A の prefilter＋残余） |
| `WHERE 日付 = THIS_MONTH() AND LENGTH(区分) > 1 ORDER BY 日付` | ✅ OK |
| `SELECT DISTINCT 区分 … WHERE 日付 = THIS_MONTH() AND LENGTH(区分) > 1` | ✅ OK |

**条件を弱める（無意味な残余述語を足す）と通り、純粋な exact 条件だと拒否される**という逆転が起きている。

## 2. 根因

相対日付の実行許可は `relativeDatePushdownGuard` の2つの許可形だけ:

| 許可形 | 条件 |
|---|---|
| 第1（B67 Phase1） | physical top-level ＋ **`selectMode === "SIMPLE"`** ＋ WHERE 全体 `EXACT_PUSHDOWN` ＋ serialize 確認 |
| 第2（B67 Phase2 A） | **capability === `SUPERSET_PREFILTER`** ＋ FULL_SCAN ＋ no KORDER ＋ 単一物理 APP ＋ AND-only 分解成功 |

「WHERE 全体 exact ＋ FULL_SCAN」は、
- 第1許可形 → `SIMPLE` でないため不可
- 第2許可形 → capability が `EXACT_PUSHDOWN` なので `decomposeRelativeDatePrefilter` が `DEFER_PHASE1`（Phase1 へ委譲）を返し不可

の**どちらにも当てはまらず落ちる**。安全性の観点では、この形は「WHERE 全体を押し下げれば client 側の残余評価が不要（＝相対日付の client 評価 0）」なので**本来もっとも安全に許可できる形**である。

FULL_SCAN で拒否せざるを得なかった歴史的理由は「`runFullScan` が取得後に `stmt.where` を `applyFilter` で再評価する（相対日付が backstop に到達する）」ことだが、**Phase2 A で `FullScanInput.residualWhere`（`null` = 残余フィルタなし）の配線が既に入っている**ため、現在は解決可能。

## 3. 対策案（第3許可形）

`relativeDatePushdownGuard` に第3許可形を追加する:

```text
physical single-app SELECT
+ FULL_SCAN（GROUP BY / DISTINCT / 集計 / window / 通常 ORDER BY 由来）
+ no JOIN / subtable / materialized・temp / CTE / 派生表
+ no KORDER
+ capability === EXACT_PUSHDOWN（WHERE 全体が exact）
+ serialize 確認済み
→ WHERE 全体を server へ押し下げ、residualWhere = null（client 評価なし）
```

実装は Phase2 A の資産をほぼそのまま使える見込み:
- `executeFullScanSelect` は既に `prefilterPlan` から `pushDownCond` と `residualWhere` を受け取る形になっている。
- 本ケースは `prefilterWhere = stmt.where`（全体）・`residualWhere = null` の特殊形として表現できる。
- `allowOriginalWherePushdown` の扱い（capability が EXACT なら現状 true）と二重生成しないことの確認が必要。

**要検討**: `KORDER BY` は従来どおり拒否維持（順序計画の前提が別）。DML・JOIN・VALIDATE・CTE/temp も Phase2 A と同じく対象外を維持。

## 4. 効果

- **ダッシュボード等の集計クエリで相対日付が使えるようになる**（`GROUP BY` ＋ `WHERE 日付 = THIS_MONTH()` が最頻出形）。
- 「ダミー述語を足すと通る」という不自然な回避策が不要になる。
- 相対日付の client 評価 0 という安全契約は維持（むしろ residual なしなので最も安全）。

## 5. 見積り（暫定）

2〜4 人日（第3許可形の判定・fetch/residual 配線の分岐・EXPLAIN 表示・受入と非回帰テスト・4面確認）。Phase2 A の実装資産流用のため、Phase2 A 本体（4〜6.5 人日）より小さい見込み。

## 6. 備考

- 本件は B67 Phase2 B（KORDER・DML・JOIN・VALIDATE・OR/NOT・client 評価）とは**別**。Phase2 B が「押し下げできない形をどう救うか」なのに対し、本件は「**押し下げできる形が誤って拒否されている**」ギャップの解消。
- ドキュメント（言語リファレンス §5）にも FULL_SCAN 化要因が fail-closed 条件として明記されていない問題があり、**B74** で先行是正する。
