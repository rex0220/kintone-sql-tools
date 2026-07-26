# B76 実装計画 — JOIN の述語押し下げ拡張（Phase A）と相対日付の JOIN 対応（Phase B）

- 作成: 2026-07-26（Claude 起草・**Step 0 の調査と仕様起草は codex 担当**）
- ステータス: 📝 **計画（未着手）**。B75 の後に着手。
- 評価: [B76 eval](ksql_b76_join_predicate_pushdown_extension_evaluation.md)

## 0. 本計画の性格

B75 と違い、**着手前に未解決の調査項目がある**。押し下げの安全性は kSQL が過去に
事故を起こしている領域（v2.0.0 で全 `LIKE` の押し下げを撤回）であり、
**調査を済ませずに実装計画を確定してはならない。**

したがって本書は「Step 0（調査）＋その結果で決まる Phase A の骨格」を定める。
**Step 0 の成果として codex が Phase A の詳細仕様を起草し、Claude がレビューする**運用とする。

## Step 0 — 調査（codex 担当・成果物＝Phase A 仕様 R1）

### 調査 A: kintone の日付比較セマンティクス

`whereToKintone` が生成するクエリを kintone が評価する規則と、
kSQL のクライアント側評価（`evalWhere`）の規則が**一致するか**を確定する。

| 論点 | 確認すること |
|---|---|
| DATE 型の `=` `>` `>=` `<` `<=` | 日単位比較か。境界（当日）の扱い |
| DATETIME / CREATED_TIME / UPDATED_TIME | 時刻を含む比較か。**タイムゾーン**（アプリ設定 / ユーザー設定 / UTC のどれ基準か） |
| 空セル（未入力） | kintone 側と JS 側で真偽が一致するか。数値では `IN ('')` 空セル評価・−∞ 準拠の前例あり（v2.2.0 / v2.6.0） |
| 文字列リテラルの引用・エスケープ | `whereToKintone` の既存実装で日付リテラルが正しく引用されるか |

**結論の型**: 各型・各演算子について「exact に一致する / superset として安全 / 押し下げ不可」の3値で表を作ること。

> 参考: 既存の押し下げ判断は `src/core/optimization/wherePredicatePushdown.ts` の
> `isSafeComparison` / `isNumericCandidate` / `isSelectionInComparison`。
> 型メタ確定を要求する設計（`options.fieldTypes?.get(...) === "NUMBER"`）が前例。

### 調査 B: なぜ日付が現在除外されているのか

v2.0.0〜v2.2.0 の押し下げ絞り込みの経緯を確認し、**日付が意図的に外されたのか、
単に未対応なのか**を確定する。意図的なら理由（当時の不一致事例）を掘り起こすこと。
関連文書: `docs/internal/ksql_numeric_*`・`ksql_like_js_*`・`ksql_selection_*`（台帳 §2 の v2.x 行からリンク）。

### 調査 C: TEXT `=` の押し下げ可否

Pro のレシピは `t.年月 = '2026-07'`（SINGLE_LINE_TEXT）を使う。
文字列完全一致が押し下げ可能かは日付と独立の論点。**全角/半角・大文字小文字・
前後空白の正規化**が kintone 側と JS 側で一致するかを確認する。
一致しないなら Phase A のスコープから外す。

### 調査 D: JOIN 側の型メタ解決

現在 JOIN テーブルへの押し下げ呼び出しは `extractTypedPushdownCandidates(stmt.where, { tableAlias: join.table.alias })`
で **`fieldTypes` を渡していない**（`src/execute.ts` 付近）。
このため選択系 `IN` は型メタ確定が必要な条件を満たせず押し下げられない（実測で確認済み）。
日付押し下げも型メタを要するため、**JOIN 側で型メタを解決して渡す配線が必要かどうか**を確定する。

## Phase A — 日付述語の押し下げ拡張（相対日付とは独立）

> **Step 0 の結論次第でスコープが変わる。** 以下は「DATE の比較が exact に一致した場合」の骨格。

### A-1 リーフ判定の拡張

`wherePredicatePushdown.ts` に日付比較の判定を追加。型メタで DATE 系と確定した場合のみ許可。

### A-2 JOIN 側への型メタ配線

調査 D の結論により、JOIN テーブルの `fieldTypes` を解決して
`extractTypedPushdownCandidates` に渡す（選択系 `IN` の押し下げも同時に有効化される副産物あり）。

### A-3 EXPLAIN 表示

各テーブルの `kintone query:` に押し下げられた日付述語が現れること。

### A-4 4面 parity・docs

**受入条件**:

1. **exact と確定した形のみ residual から除去する。** 少しでも不一致の疑いがあれば
   **superset として押し下げ、client 残余評価を必ず残す**（B67 Phase2 A と同型）。
   これが本 Phase の最重要方針。
2. JOIN の各テーブルに対し個別に押し下がること（既に NUMBER で実現している形）。
3. 既存の押し下げ挙動（NUMBER・`$id`・KLIKE・選択系 IN）に回帰がないこと。
4. `npm test` 全件 green・snapshot 差分は意図したものだけ。
5. fields を尊重するモックで検証すること。

**見積もり**: 2〜3 人日（調査 Step 0 を除く）。**単独でリリース可能**（相対日付を待たない）。
SemVer=**minor**（性能改善・結果は不変）。ただし押し下げにより
**取得件数が変わるため上限（`maxRecords`）到達の有無が変わりうる**点は CHANGELOG に明記すること。

## Phase B — JOIN での相対日付許可（第5許可形）

Phase A で日付が exact に押し下げられるようになって初めて成立する。

- B67 Phase2 A の**リーフ採用＋残余からの除去**を JOIN の駆動表へ適用する
- 相対日付リーフが**単一の別名だけを参照**すること（複数テーブルにまたがる相対日付は拒否）
- 採用したリーフを client 残余から確実に除去し、**相対日付の client 評価を 0** にする
- `OR` / `NOT` にまたがる相対日付は従来どおり拒否
- guard の3許可形すべてが持つ `joins.length === 0` 前提を、第5許可形でのみ解除する

**見積もり**: 3〜5 人日。**Phase A なしでは着手不可。**

## 優先順位

**B75 → B76 Phase A → B76 Phase B** を推奨。

- B75 は guard のみで完了し、Pro の CTE 用途を直接解消する（費用対効果が最大）
- B76 Phase A は相対日付と無関係に JOIN の取得件数を減らす純粋な性能改善
- B76 Phase B は Pro の本命だが最も重い

## 実装時の注意

- **押し下げは事故歴のある領域。** exact を主張するのは Step 0 の検証を経てからに限る。
  迷ったら superset＋残余評価に倒す。
- B72 の教訓どおり、**リテラル日付と相対日付で挙動が非対称にならないこと**を
  Phase B の受入条件に含める。
