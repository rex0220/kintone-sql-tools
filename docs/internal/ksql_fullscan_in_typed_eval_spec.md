# 課題+仕様: FULL_SCAN `IN` / `NOT IN` の型メタ付き複数値・ユーザーコード評価（述語分割 第2段・フェーズ1）

- 作成日: 2026-07-15
- ステータス: **課題+仕様案（codex レビュー前）**
- 分担: Claude=仕様/観点、Codex=実装/テスト
- SemVer: **バグ修正（挙動変更・後方互換方向）→ minor 相当**（実装後に確定）
- 位置づけ: 選択系 `IN` 押し下げ（[ksql_selection_in_pushdown_spec.md](ksql_selection_in_pushdown_spec.md)）の**フェーズ1（正しさ・押し下げと独立）**。フェーズ2（押し下げ＋実在検証）の**前提**。
- 関連コード: `src/engine/evalWhere.ts`（`evalOp` の IN 判定）、`src/engine/process.ts`（`flatten`・[:59](../../src/engine/process.ts#L59)）、`src/execute.ts`（`getFieldTypeMap` / FULL_SCAN の型メタ配線）

## 0. 課題（実機で確認済み）

FULL_SCAN で**複数値/オブジェクト型フィールドの `IN` / `NOT IN` が誤結果**になる。`flatten`（[process.ts:59-64](../../src/engine/process.ts#L59)）が配列/オブジェクト値を **JSON 文字列**にするため、JS の `IN` が要素と一致しない。

| 実機（MCP・APP4149・`主担当`＝USER_SELECT） | 結果 |
|---|---|
| `主担当 IN ('rex0220')` SIMPLE（kintone） | **20 件**（一致） |
| `主担当 IN ('rex0220') AND $id LIKE '%'` FULL_SCAN（JS） | **0 件**（`[{"code":"rex0220",...}]` ∉ `{"rex0220"}`） |

同じ SQL が実行モードで異なる結果を返す（②空セル −∞ と同種のモード乖離）。CHECK_BOX/MULTI_SELECT/USER/組織/グループ選択が該当。

## 1. 設計方針（型メタ付き評価＝ナイーブ JSON parse は不可）

**`flatten` 後の文字列だけでは型を判別できない**（例: `SINGLE_LINE_TEXT` に文字どおり `["A"]` が保存されている場合、JSON parse で配列と誤認すると文字列一致→要素一致に意味が変わり**別の回帰**を生む）。→ **フィールド型メタを JS 評価（`evalWhere`）まで渡し、型ごとに評価規則を切り替える**。

### 1.1 型ごとの `IN` / `NOT IN` 評価規則
| フィールド型 | 値の形（flatten 後） | `IN` の判定 |
|---|---|---|
| `DROP_DOWN` / `RADIO_BUTTON` / `STATUS` / `RECORD_NUMBER` / テキスト・数値等 | スカラー文字列 | 従来どおり `row[field] ∈ {v...}`（**変更なし**） |
| `CHECK_BOX` / `MULTI_SELECT` | 文字列配列 `["A","B"]` | 配列要素のいずれかが `{v...}` に含まれる |
| `USER_SELECT` / `ORGANIZATION_SELECT` / `GROUP_SELECT` / `STATUS_ASSIGNEE` | オブジェクト配列 `[{code,name},...]` | いずれかの要素の **`code`** が `{v...}` に含まれる |
| `CREATOR` / `MODIFIER` | 単一オブジェクト `{code,name}` | その **`code`** が `{v...}` に含まれる |
| **型不明・上記以外** | — | **従来の文字列比較を維持**（回帰なし） |

- **`NOT IN`** は各型で `IN` の否定（配列/オブジェクトも「いずれの要素も含まれない」）。
- **ユーザー系は表示名でなく `code` で比較**（`name` は照合に使わない）。

### 1.2 型メタの入手・配線
- `evalWhere` は現状フィールド型を持たない。**FULL_SCAN 評価に `FieldTypeMap` を渡す**（`runFullScan` → `evalWhere` 経路にフィールド型を伝播）。
- 取得は既存 `getFieldTypeMap`（[execute.ts](../../src/execute.ts)）を流用。**WHERE / HAVING に `IN`/`NOT IN` を含む FULL_SCAN のときだけ**当該アプリの型メタを取得（無関係クエリに API を足さない。フィールド検証で既取得ならキャッシュ再利用）。
- **JOIN**: 修飾フィールド（`alias.field`）ごとに、そのテーブルの型で評価する（テーブル別 `FieldTypeMap`）。
- **サブテーブル仮想行**: 展開後のサブテーブルフィールド（CHECK_BOX/MULTI_SELECT 等）の型も対象。サブテーブルのフィールド定義から型を得る。

### 1.3 頑健性
- **malformed JSON**: 配列/オブジェクト型なのに `JSON.parse` に失敗する値は、**例外にせず従来の文字列比較へフォールバック**。
- **空配列** `[]`: `IN` は **false**、`NOT IN` は **true**。
- **型メタ空・不明**: 従来の文字列比較を維持（安全側・回帰なし）。
- **変数を含む IN**: 実行前に `resolveVariableRefs` でリテラル置換後、上記と同じ評価。

## 2. 受入テスト観点（必須・修正前 fail → 修正後 pass）
- **複数値の一致**: `CHECK_BOX IN ('A')` が要素 A を含む行に一致。`USER_SELECT IN ('rex0220')` が `code` 一致で一致（実機の 20 vs 0 を解消）。
- **[回帰防止] テキストの誤配列化なし**: `SINGLE_LINE_TEXT` の値が文字列 `["A"]` でも**配列扱いしない**（`IN ('["A"]')` で一致、`IN ('A')` で不一致＝従来の文字列比較）。
- **空配列**: 空の CHECK_BOX に対し `IN ('A')` は false、`NOT IN ('A')` は true。
- **ユーザー系は code**: `USER_SELECT IN ('開発太郎')`（表示名）は不一致、`IN ('rex0220')`（code）は一致。
- **CREATOR/MODIFIER**: 単一オブジェクトの `code` で一致。
- **JOIN**: 修飾フィールドごとに正しい型で評価（片側 CHECK_BOX・片側テキスト等）。
- **サブテーブル仮想行**: サブテーブルの CHECK_BOX/MULTI_SELECT が要素比較になる。
- **型メタ空/不明**: 従来の文字列比較を維持（挙動不変）。
- **malformed JSON**: 例外にならず従来比較にフォールバック。
- **変数**: `WHERE k IN (@a, @b)` がリテラル置換後に同じ評価。
- **NOT IN**: 各型で `IN` の否定。
- **型メタ取得の限定**: `IN`/`NOT IN` を含まない FULL_SCAN で追加の getFields を発生させない。
- **実機**: `主担当 IN ('rex0220')` が SIMPLE == FULL_SCAN（20 == 20）。CHECK_BOX/MULTI_SELECT のあるアプリで同様に一致。

## 3. 実装メモ（Codex 向け）
- `evalWhere` の IN 判定（`evalOp` の `IN`/`NOT IN`）を**型メタ付き**にする。`evalWhere`（および `runFullScan`/`applyHaving`/CASE/サブテーブル DML 選定の呼び出し経路）に `FieldTypeMap`（テーブル別）を渡す。
- 型 → 評価規則は §1.1 の分類を関数化（`SCALAR / STRING_ARRAY / OBJECT_ARRAY(code) / SINGLE_OBJECT(code) / UNKNOWN→従来`）。配列/オブジェクトは `JSON.parse`＋失敗時フォールバック。
- FULL_SCAN で `IN`/`NOT IN` を含むアプリだけ型メタ取得（`getFieldTypeMap`・キャッシュ再利用）。JOIN はテーブル別。
- SIMPLE モードは kintone が評価するため**変更不要**（本課題は FULL_SCAN の JS 評価のみ）。
- プラグイン: FULL_SCAN エンジンをバンドルするため **`npm run build`（plugin 含む）** で `desktop.js` 再生成。
- ドキュメント: 言語リファレンスの `IN` 節に「複数値/ユーザー系は要素/code 比較（FULL_SCAN）」を明記。

## 4. 位置づけ・次
- **フェーズ1（本課題）を独立コミットで完成・実機確認**してから、フェーズ2（型メタ付き押し下げ＋実在検証）へ。
- フェーズ2の親仕様は [ksql_selection_in_pushdown_spec.md](ksql_selection_in_pushdown_spec.md)（本課題完了後に押し下げ詳細を整理）。
