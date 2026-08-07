# B155 仕様 R1 作成依頼（codex）——安全葉判定の分類器統一（案 A）

**仕様の作成依頼。コードは 1 行も変更しないこと。ファイルへの書き込みも不要。**
git 操作・kSQL MCP・MEMORY.md 禁止。

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（v3.61.0）

## 0. 依頼

**B155（B76 世代の安全葉規則の 2 実装複製）の案 A 仕様 R1 を、そのまま実装依頼に出せる形で書く。**
方向はオーナー判断（2026-08-08）で確定済み。

| ファイル | 役割 |
|---|---|
| `docs/internal/ksql_b155_cte_join_where_merge_issue.md` | **調査完了の起票（原因確定・決定的実測・影響範囲）** |
| `src/core/optimization/wherePredicatePushdown.ts` | 旧抽出器（`isSafeComparison` / `isNumericCandidate`＝B76 規則が凍結） |
| `src/core/optimization/klikePushdownPlan.ts` | 旧抽出器の呼び出し元（`joinConditions`・単一表 `mainCondition`） |
| `src/core/optimization/joinPredicatePushdown.ts` | **正とする分類器**（B151/B152 で全面開放済み） |
| `src/execute.ts:5540-5542` | CTE 含む FULL_SCAN JOIN の per-alias 条件の消費点 |
| `docs/internal/ksql_b151_join_number_pushdown_spec_r1.md` / `ksql_b152_join_pushdown_phase234_spec_r1.md` | 開放済み契約の正 |

## 1. 決まっていること（変更しない）

- **案 A＝旧 `isSafeComparison` の葉判定を `classifySupportedLeaf`（B151/B152 の正）へ統一**し、
  同じ規則の複製を残さない（B150 仕様の「型一覧を複製しない」原則の適用）
- **対象経路は 2 つ**＝①CTE/一時テーブルを含む FULL_SCAN JOIN の per-alias 条件
  ②単一表 FULL_SCAN の安全プレフィルタ（LIKE 併用等で exact 直列化が崩れた形）
- **結果は変えない**（プレフィルタは superset・元 WHERE の残余再評価を維持）
- **KLIKE・`$id` の既存受理・選択系の実在検証・B126 正規化後の AST を受ける前提は維持**
- **B84 公開表は変わらない**（分類器自体は不変。届く経路が増えるだけ）
- 受入の必須形（調査の実測 4 本）:
  1. CTE→APP JOIN で `製品名 = '牛乳'`・`個数 <= 100` が範囲 prefilter と合流する
  2. 単一表 `WHERE 製品名 = '牛乳' AND 仕入先 LIKE 'zz'` で `製品名 = '牛乳'` がプレフィルタに乗る
  3. `< 101` と `<= 100` が同等に扱われる（旧 strict 制限の消滅）
  4. 旧規則でのみ通っていた形の回帰なし・3 経路の結果一致

## 2. あなたがコードから決めること（ファイル:行）

1. **統一の形**＝`isSafeComparison` を分類器呼び出しへ差し替えるか、共有 leaf policy を抽出するか。
   `fieldTypes` / `fieldOptions` オプションと `JoinPushdownSource` の橋渡し
2. **単一表 FULL_SCAN プレフィルタの relation 契約**（現行の扱いと、開放後の superset/exact の整理・
   `EXPLAIN` の `reason:` 表示への影響）
3. **B154 の同梱可否**＝統一後の表示整理（`join pushdown plan: not applied` の but書き）を
   本件に含めるか別課題のまま残すか、判断と理由
4. 旧抽出器の他の利用箇所の列挙と影響（`extractNumericPushdownCandidates` 等の
   EXPLAIN/メタ判定用途が壊れないこと——**B150 修正 2 の metadata 要否判定への波及に注意**）

## 3. 仕様に必ず含めること

B151/B152 と同じ型＝規則・適用経路・EXPLAIN 契約・受入条件（逐語 SQL・実 serializer 形・
3 経路一致・KLIKE/選択系回帰・dry-run の API 0 回）・Phase 線引き・Claude 実測項目。

## 4. 書き方の制約

従来どおり。**仕様の全文（Markdown）を最終メッセージで出力**。
