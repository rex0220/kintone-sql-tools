# 仕様案: 選択系 `IN` の型メタ付きプレフィルタ（述語分割 第2段）

- 作成日: 2026-07-15
- ステータス: **仕様案（codex レビュー前）**
- 分担: Claude=仕様/観点、Codex=実装/テスト
- SemVer: **後方互換の最適化 → minor（v2.5.0 想定）**
- 位置づけ: 述語分割の続き。① 第0段（`$id`・`5c987e0`）／② 空セル −∞（`1c73828`）／③ 型メタ付き**数値**プレフィルタ（`30ff297`）に続く**選択系 `IN`**。親仕様 [ksql_like_predicate_pushdown_spec.md](ksql_like_predicate_pushdown_spec.md) R3 の「第1段（選択系 in）」の詳細。
- 関連コード: `src/core/optimization/wherePredicatePushdown.ts`（`extractSafePushdownLeaves` / `extractNumericPushdownCandidates`）、`src/execute.ts`（`extractMainSafePushdown` / `loadNumericPushdownFieldTypes` / EXPLAIN）、`src/converter/whereToKintone.ts`（`convertInList`）

## 0. 目的

`LIKE` 等で FULL_SCAN になるクエリでも、**型メタで確定したスカラー文字列型の選択系フィールドの `IN`** を kintone へプレフィルタ押し下げして取得件数を削減する。

```sql
SELECT 件名, 担当 FROM APP100 WHERE ステータス IN ('対応中') AND 件名 LIKE '%至急%'
-- ステータス IN ('対応中') を kintone に押し下げ →「対応中」だけ取得 → LIKE は JS 評価
```

`ステータス`（ワークフロー状態）・カテゴリ等の絞り込みは多用されるため、`LIKE 検索 ＋ 選択系絞り込み`で実用的な削減効果がある。

## 1. スコープ

- **入れる**: **スカラー文字列型の選択系フィールド**（`DROP_DOWN` / `RADIO_BUTTON` / `STATUS`）の **`IN (文字列リテラル, ...)`** を、型メタ（`FieldTypeMap`）で型確定のうえ押し下げ。
- **入れない**:
  - **配列/オブジェクト型の選択系**（`CHECK_BOX` / `MULTI_SELECT` / USER・組織・グループ選択）。JS 側で **JSON 文字列**（例 `["A"]`。[execute.ts:2099](../../src/execute.ts#L2099) / [dmlToKintone.ts:58](../../src/converter/dmlToKintone.ts#L58) の `ARRAY_TYPES`）になり、kintone の `in`（選択肢要素判定）と**述語の対象単位が違う**ため。
  - **`NOT IN`**（否定は超集合性が反転）。
  - テキスト `IN`（テキスト照合の全角半角・正規化で超集合性が不確実。③のテキスト等値と同じ理由で対象外）。
  - 右辺に非文字列リテラル・サブクエリ（`IN (SELECT ...)`）を含むもの。

## 2. 正しさ（超集合性）

押し下げる `P = field IN (v1, v2, ...)` について「kintone の P 集合 ⊇ JS の P 集合」（親仕様 §2）。

- **スカラー文字列型選択系**: JS 側の値は**選択肢コードのスカラー文字列**（例 `"対応中"`）。JS の `IN` は `row[field] ∈ {v...}` を判定。kintone の `in` も選択肢コードの一致判定。**両者が一致**（kintone-P == JS-P）→ 超集合性 OK。
- **未選択（空）**: 選択なしのドロップダウン等は JS で空文字。`IN ('対応中')` は kintone・JS とも**空を除外**（空 ∉ 選択肢集合）→ 一致。
- **配列型を除外する理由**: `CHECK_BOX` は JS で `["A"]`（JSON 文字列）。`row[field] === "A"` にならず `IN` の対象単位が違う → 超集合性を保証できない。
- **同値性は取得打ち切りなし前提**（親仕様 §2.1）。
- **実機検証必須**: kintone の選択系 `in` とスカラー文字列値の一致を、型ごと（DROP_DOWN / RADIO_BUTTON / STATUS）に実データで確認する（§6）。

## 3. 抽出器の拡張（③の基盤に載せる）

現行 `extractSafePushdownLeaves`（[wherePredicatePushdown.ts](../../src/core/optimization/wherePredicatePushdown.ts)）は `$id`（静的）と NUMBER（型メタ）を押し下げる。ここに**選択系 `IN`** を追加する。

### 3.1 リーフ判定
- `field IN (...)` は WhereExpr の **`BINARY`**（`op: "IN"`・右 `InList { type:"IN_LIST", values }`）。
- **選択系 `IN` 候補**（型メタなしで構文判定・`isSelectionInCandidate`）:
  - 左辺が単純フィールド参照（`$id` 以外・対象テーブル）。
  - `op === "IN"`（**`NOT IN` は不可**）。
  - 右辺が `IN_LIST` で、**全要素が文字列リテラル**（`STRING`。数値・サブクエリ・変数未解決は不可。変数は実行前に `resolveVariableRefs` で `STRING` へ解決済み）。
- **押し下げ可**（`isSafeComparison` 内・型メタ確定）: 上記候補 かつ **`fieldTypes.get(field) ∈ {"DROP_DOWN","RADIO_BUTTON","STATUS"}`**。

### 3.2 候補抽出・型メタ取得の一般化
- 現行の `extractNumericPushdownCandidates`（型メタなし・EXPLAIN と型メタ取得判定に使用）を、**数値候補 ∪ 選択系 IN 候補**へ一般化する（例 `extractTypedPushdownCandidates` にリネーム、または選択系候補を OR 追加）。
- `loadNumericPushdownFieldTypes`（[execute.ts](../../src/execute.ts)）＝「候補のある物理アプリだけ `getFieldTypeMap` を取得」も、選択系候補を含めて判定するよう一般化（候補があるアプリだけ取得の方針は不変）。
- **メタ空/型不明 → 非押し下げ**、**`getFields` reject → 例外伝播**（③と同じ）。

## 4. kintone クエリ変換
- `field IN ('A','B')` の変換は既存の `convertInList`（[whereToKintone.ts:212](../../src/converter/whereToKintone.ts#L212)）で対応済み（`in ("A","B")`）。**変換側の追加実装は不要**。抽出器が選択系 IN を通すだけ。

## 5. EXPLAIN
- 型メタが async のため、EXPLAIN では NUMBER と同様に**選択系 IN も `pushdown candidate` 行**に表示（`$id` は `kintone query` に確定）。実行時に型確定して押し下げる。no-API 契約は維持。

## 6. 受入・実機テスト（打ち切りなし前提で 押し下げ後 == 全件 JS 評価）
- **単体（抽出器 × 型メタ）**: `fieldTypes` に `ステータス:STATUS` / `区分:DROP_DOWN` / `優先度:RADIO_BUTTON` を与えたとき `ステータス IN ('対応中')` を押し下げる。**`CHECK_BOX`/`MULTI_SELECT`/USER 型・テキスト型・型不明は押し下げない**。**`NOT IN`・非文字列 IN・`IN (SELECT ...)` は押し下げない**。`fieldTypes` 空・未指定は非押し下げ。
- **超集合性（結合・打ち切りなし）**: `ステータス IN ('対応中') AND … LIKE …`（無エイリアス/エイリアス/JOIN）で押し下げ結果 == 全件 JS 評価。**未選択（空）行・複数値 IN・該当 0 件**を含めて一致。
- **実機（型別）**: DROP_DOWN / RADIO_BUTTON / STATUS それぞれで、SIMPLE（`WHERE 選択 IN (...)`）と FULL_SCAN（`… AND $id LIKE '%'` 等）で結果一致を確認。CHECK_BOX で押し下げないこと（誤って押すと配列不一致で欠落）。
- **型メタ取得の限定**: 選択系候補が無いクエリで `getFieldTypeMap` を呼ばない。
- **EXPLAIN**: 選択系 IN が `pushdown candidate` に出て `kintone query` には出ない。`$id` は確定。
- **回帰**: ①（$id）②（空セル）③（数値）と既存 SIMPLE/FULL_SCAN が不変。

## 7. 実装メモ（Codex 向け）
- `wherePredicatePushdown.ts`:
  - `isSelectionInCandidate(expr)`: 左辺フィールド（非 $id）・`op==="IN"`・右辺 `IN_LIST` かつ全要素 `STRING`。
  - `isSafeComparison` に「選択系候補 かつ `fieldTypes.get(field)` がスカラー文字列選択型（`DROP_DOWN`/`RADIO_BUTTON`/`STATUS`）」を追加。
  - 候補抽出（`extractNumericPushdownCandidates`）を数値 ∪ 選択系 IN に一般化（EXPLAIN・型メタ取得判定で使用）。名前は `extractTypedPushdownCandidates` 等へ。
- `execute.ts`: `loadNumericPushdownFieldTypes` の候補判定を一般化（選択系候補を含める）。`extractMainSafePushdown`/JOIN は fieldTypes を渡す既存経路のまま。EXPLAIN の候補行も一般化。
- スカラー文字列選択型の集合は定数化（`SCALAR_STRING_SELECTION_TYPES = new Set(["DROP_DOWN","RADIO_BUTTON","STATUS"])`）。配列型（`CHECK_BOX`/`MULTI_SELECT`）は既存の `ARRAY_TYPES` を参照/共有。
- プラグイン: FULL_SCAN/押し下げ/EXPLAIN エンジンをバンドルするため **`npm run build`（plugin 含む）** で `desktop.js` 再生成。
- ドキュメント: 言語リファレンスの押し下げ節・EXPLAIN 表記。

## 8. 効果・リスク
- **効果**: `LIKE 等 FULL_SCAN ＋ 選択系 IN` のクエリで取得件数を削減（選択の選択性に比例）。ステータス絞り込みは多用されるため実用的。
- **リスク**: **低〜中**。③の型メタ基盤・候補抽出・EXPLAIN をそのまま流用。新規は選択系候補判定と型集合の追加のみ。正しさは型限定（スカラー文字列選択のみ）＋実機超集合性テストで担保。
- **非対象**: `CHECK_BOX`/`MULTI_SELECT`/USER 等の配列型・`NOT IN`・テキスト IN・日時・`<=`/`>=`（案B）。
