# B74 — 言語リファレンス §5 の相対日付 fail-closed 記述が実挙動とずれている

- 作成日: 2026-07-26
- ステータス: **✅ 対応済み（docs のみ・次回リリースで `ksql_docs` へ反映）**（2026-07-26）。B71/B72/B73 と同時起票し、本件のみ即対応。実挙動をプローブで確定 → 言語リファレンス §5（使える形2つ／拒否形に FULL_SCAN 化要因を追加／`OR` の条件を正確化）と §6 の2箇所（相互参照節・kintone 専用関数節）を是正。MCP docs embedding テスト green。**B72 実装時に「FULL_SCAN 純 exact も可」へ再更新が必要**。
- 報告元: kSQL Dashboard Pro からの報告（`kSQLエンジン報告-20260726.md`）の切り分け調査で判明
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B74
- 関連: B67 Phase1（v3.20.0）／B67 Phase2 A（v3.21.0）／**B72**（本件の実装側ギャップ）

## 1. 問題

言語リファレンス §5「kintone 相対日付関数」の fail-closed 一覧が、実挙動と2点でずれている。

### (a) 最も踏みやすい条件が抜けている

現状の記述は「`OR` の枝／`NOT` 配下／`KORDER BY`／DML 対象選択／`INSERT`・`UPSERT ... SELECT` の source／JOIN 後残余／`VALIDATE`／サブテーブル／一時テーブル・実体化 CTE・派生表」を挙げるが、**`GROUP BY` / `DISTINCT` / 集計 / window / 通常 `ORDER BY`（＝FULL_SCAN 化要因）に触れていない**。

実測では、これらを付けると `WHERE` 全体が exact でも拒否される（B72 参照）。ダッシュボード等の集計クエリで**最初に踏む制約**であり、記載がないと利用者は理由を理解できない。

### (b) `OR` の記述が実挙動より厳しい

現状は「相対日付関数が `OR` の枝にある」だけで fail-closed と読めるが、実測では **`OR` の両枝とも exact なら SIMPLE のまま通る**:

```sql
-- 実測 OK（単純 SELECT）
SELECT $id FROM APP100 WHERE 日付 = THIS_MONTH() OR 日付 = LAST_MONTH()
```

正しくは「`OR` 枝に押し下げ不能な述語があり `WHERE` 全体が exact にならない場合、Phase2 A の分解も OR を対象外とするため拒否」である。

## 2. 実挙動（プローブ実測 2026-07-26）

**使える形**:
1. 単一物理アプリの **SIMPLE** SELECT で `WHERE` 全体が exact 押し下げ可能（`OR`・複数条件・`BETWEEN` 可）
2. **FULL_SCAN** でも、相対日付 exact leaf が「相対日付を含まない残余」と `AND` で結ばれ `SUPERSET_PREFILTER` になる形（Phase2 A・単一物理 APP・KORDER なし）

**拒否される形**:
- `WHERE` 全体が exact でも FULL_SCAN 化する場合（`GROUP BY`・`DISTINCT`・集計・window・通常 `ORDER BY`）← **B72 で改善予定**
- 相対日付が `OR` / `NOT` に絡み、かつ `WHERE` 全体が exact にならない場合
- `KORDER BY`（native / Cursor）・DML 対象選択・`INSERT`/`UPSERT ... SELECT` の source・JOIN 後残余・`VALIDATE`・サブテーブル・一時テーブル / 実体化 CTE / 派生表

## 3. 対応

言語リファレンス §5（および §6 の相互参照節）を上記の実挙動へ是正する。**docs のみで SQL 挙動は不変**。`ksql_docs`（MCP）へは次回リリースのビルドで反映される。

B72 実装時には、この記述を再度更新する（FULL_SCAN 純 exact が許可されるため）。

## 4. 受入

- §5 に「使える形」と「拒否される形」が実挙動どおり記載される（FULL_SCAN 化要因を明記・OR の条件を正確化）。
- §6 の相対日付節（相互参照）も矛盾しない。
- MCP docs embedding テスト（`docsResources.test.ts` / `b67RelativeDateDocs.test.ts`）が green（"exact pushdown" 等の要求トークンを保持）。
