# B126 / B127 仕様 R1 codex レビュー依頼

**レビュー依頼であり実装依頼ではない。コードは 1 行も変更しないこと。**
git 操作をしないこと。kSQL MCP を叩かないこと（headless で無言停止する）。`npm test` は不要。

## 依頼

kSQL に**警告を 2 種類足す** Phase 1 仕様を書いた。実装前のレビューをお願いしたい。

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（v3.46.0）

読むもの:
- `docs/internal/ksql_b126_b127_warnings_phase1_spec.md`（**レビュー対象の R1**）
- `docs/internal/ksql_analytics_request_20260805_evaluation.md`（起点・triage）
- `src/core/optimization/whereCapability.ts` / `src/converter/selectToKintone.ts`
- `src/execute.ts`（`warnings` の既存 2 件）/ `src/types/ast.ts`（`WindowFrame`）
- `docs/ksql_language_reference.md` §6（押し下げ表・複数値 `IN` の一致規則）

背景: 直前に B123/B124/B125 で同じ形のレビューをしてもらい、いずれも R1 の
中核前提が覆った（合計 22 件の指摘を全件反映）。**同じ穴が残っていないかを見てほしい。**

## 特に見てほしい点（コードで真偽が決まるもの）

### 1. 【最優先】`CHECK_BOX` / `MULTI_SELECT` の `= 'A'` はどう分類されるか

R1 §2.3 / §7-1 の未確定。`classifyWhereCapability` で
`isLocallyValidOperator` → `hasLocalContract` → `native.has(nativeOp)` の
どこで落ちるか。**`WHERE_RESIDUAL` に到達するのか、その前にエラーになるのか。**
到達するなら「`IN` と書けば絞れます」という案内は**結果を変える助言**になる
（複数値の `IN` は集合 overlap）。**到達するか否かで仕様が変わる。**

### 2. 検出規則「native 演算子集合が `in` を含むか」は成立するか

R1 §2.1 は型をハードコードせず `nativeWhereOperatorsForType(fieldType)` に
`in` があるかで「書き換えが実在する」と判定する。
**この関数の実際の戻り値**（型ごと）を確認し、意図した型だけが該当するか、
意図しない型（`CALC` など押し下げ皆無の型）が混ざらないかを見てほしい。

### 3. JOIN では「`IN` と書けば絞れます」が嘘にならないか

R1 §7-2。言語リファレンス §6 は JOIN の field vs literal に別表を持つ。
**JOIN の prefilter 経路で選択系の `IN` が実際に押し下がるか**、
押し下がらない条件があるなら、その条件で警告を出すと誤案内になる。

### 4. `warnings` を計画側から実行結果へ運ぶ経路

R1 §6 は「`execute.ts` の既存 `Set<string>` に足す」としか書いていない。
**分類は converter/planner で行われ、`warnings` は execute で組み立てられる。**
その間をどう運ぶかを、実際の呼び出し関係から具体化してほしい
（新しい引数が要るのか、既存の plan/metrics に乗るのか）。
`ksql_explain` 側で同じ判定を通す経路も同様。

### 5. B127 の全順序判定

R1 §3.2 は「`$id` または `RECORD_NUMBER` 型が `ORDER BY` キーにあれば全順序」とする。
**`RECORD_NUMBER` 型の判定にフォーム定義が要るか**（要るなら `EXPLAIN` /
実行のどちらで判定できるか）。`ORDER BY` キーの AST 形（`OrderByItem`）から
どこまで静的に分かるか。

### 6. 受入条件で検出できない穴

§5 で何が検出できて何ができないか。とくに
「警告の有無で結果が変わらない」をどう機械的に固定するか。

## 出したい成果物

`docs/internal/ksql_b126_b127_codex_review_1.md` に、次の形で。

- 結論（実装着手可能 / 要修正・件数）
- 指摘（重要度 高/中/低・該当 §/file:line・内容・**コード引用による根拠**・提案）
- 上の 6 点への回答（コード引用つき）
- 仕様が正しかった点（R2 で消さないため）

重要度: 高 = そのまま実装すると誤る/既存を壊す、中 = 実装が詰まる/受入の穴、低 = 表現。
**根拠のないコメントは書かないでほしい。** 確認できなかった項目は「未確認」と明記のこと。
