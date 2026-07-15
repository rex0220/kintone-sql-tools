# 課題+仕様: 選択系フィールドの `IN ('')` / `NOT IN ('')` 空セル評価の SIMPLE/FULL_SCAN 乖離

- 作成日: 2026-07-15
- ステータス: **課題+仕様案 R1（codex レビュー前）**
- 分担: Claude=仕様/観点、Codex=実装/テスト
- 位置づけ: フェーズ1（[ksql_fullscan_in_typed_eval_spec.md](ksql_fullscan_in_typed_eval_spec.md)・v2.5.0）の空セル意味論の隙間。空セル数値 −∞（[evalwhere-empty-cell-numeric] v2.2.0）と同種の「SIMPLE/FULL_SCAN 空セル乖離」。選択系 IN 押し下げ フェーズ2a（[ksql_selection_in_pushdown_spec.md](ksql_selection_in_pushdown_spec.md)）と**同じ v2.6.0 に束ねる**（ユーザー指示）。
- 関連コード: `src/engine/evalWhere.ts`（`typedInContains`:152 / `evalOp` の IN 経路:109）、`src/engine/process.ts`（`flatten`:64・69）

## 0. 課題（実機で確認済み・APP4221）

kintone は選択系フィールドの `field in ("")` を**空/未設定セルに一致**させるが、FULL_SCAN の JS 型付き IN 評価は一致させない。同じ SQL が実行モードで異なる結果を返す。

| クエリ | SIMPLE（kintone） | FULL_SCAN（JS） |
|---|---|---|
| `ドロップダウン IN ('')` | **1,2,3,4**（空セル一致） | **0** |
| `複数選択 IN ('')` | 1,2,3,4 | 0 |
| `チェックボックス IN ('')` | 1,2,3,4 | 0 |
| `ドロップダウン NOT IN ('')` | **5,6**（非空のみ） | **1〜6 全件**（空も含む） |

（APP4221: $id 1-4 は各選択系が空、$id 5,6 は値あり。タイトルは全件非空なので LIKE の影響なし。`$id LIKE '%'` で FULL_SCAN 強制しても同結果。）

## 1. 根本原因（診断済み）

`flatten`（[process.ts:69](../../src/engine/process.ts#L69)）: `strVal = typeof val === "string" ? val : JSON.stringify(val ?? "")`。

- **スカラー選択（DROP_DOWN / RADIO_BUTTON / STATUS）の空**: kintone 値が **null** → `JSON.stringify(null ?? "")` = **`""`（2 文字）**。診断: `ドロップダウン IN ('""')` が 1,2,3,4 に一致＝leftStr は 2 文字の `""`。IN 値集合 `{""}`（0 文字の空文字）と一致しない。
- **配列選択（CHECK_BOX / MULTI_SELECT / USER / 組織 / グループ / 作業者）の空**: `[]`。`typedInContains`（[evalWhere.ts:179](../../src/engine/evalWhere.ts#L179)）の `parsed.some(...)` は空配列で常に false。診断: `チェックボックス IN ('[]')` も 0。

→ kintone は「空セル ∈ `in ("")`」だが、JS は空スカラー=`""`(2 文字)・空配列=`[]` のため空文字リテラルと一致せず、IN で除外・NOT IN で包含してしまう。

補足: **テキスト/数値の `IN ('')` は乖離しない**（空テキストは kintone 値が `""`（string）→ flatten で `""`（0 文字）→ `values.has("")` が真）。乖離は**選択系のみ**。DROP_DOWN の `= ''` は SIMPLE で GAIA_IQ03（`=` 不可）のため、空探索に `IN ('')` を使う実需がある。

## 2. 望ましい意味論（kintone に合わせる）

選択系フィールドで、**空/未設定セルは `IN ('')` に一致し、`NOT IN ('')` に一致しない**（kintone SIMPLE と同一）。非空セルは不変。テキスト/数値は不変。

## 3. 修正案（2 案・要 codex 判断）

### 案A（`typedInContains` に局所化・projection 不変）
`typedInContains` に「空セル判定」を追加し、IN 値集合が空文字 `""` を含むときだけ空セルを一致させる:
- **配列選択型**: `parsed` が空配列 `[]` かつ `values.has("")` → true。
- **スカラー選択型**（DROP_DOWN/RADIO/STATUS）: 空表現（`leftStr === '""'`＝JSON 化された空、または `leftStr === ""`）かつ `values.has("")` → true。
- 長所: 変更が IN 評価に閉じる。SELECT 投影・他比較は不変。
- 短所: スカラー空を `leftStr === '""'`（2 文字）で判定するのがやや脆い（選択肢値が文字通り `""` の稀ケースと衝突し得るが、実用上ほぼ無い）。

### 案B（`flatten` の null 正規化 ＋ `typedInContains` 配列空）
- `flatten` を `val == null ? "" : (typeof val === "string" ? val : JSON.stringify(val))` に変更＝**null/undefined を `""`(0 文字)へ正規化**（現状 `JSON.stringify(null ?? "")` が `""`(2 文字)を生む点を是正）。これでスカラー空 → `""`(0 文字) → `values.has("")` が自然に真。
- 配列空は案A と同じく `typedInContains` で対応（配列は null でなく `[]` のため flatten 変更の影響外）。
- 長所: 空スカラーの **SELECT 投影も `""`(2 文字)→空** に是正され、より正しい表示。スカラー IN が自然に解決。
- 短所: **投影・他経路への波及**（null 値フィールドの表示が `""`→空に変わる）。回帰確認が広い。空配列の別扱いは依然必要。

**推奨**: まず **案A**（局所・低リスク）で SIMPLE/FULL_SCAN 乖離を解消。flatten の null→`""`(2 文字)是正（案B の投影改善）は**別の表示課題**として切り出す（IN 乖離修正のクリティカルパスに載せない）。

## 4. スコープと非対象
- **対象**: DROP_DOWN / RADIO_BUTTON / CHECK_BOX / MULTI_SELECT / USER / 組織 / グループ / 作業者（STATUS_ASSIGNEE）の `IN ('')` / `NOT IN ('')` 空セル一致。`evalWhere` の全 JS 評価経路（WHERE/HAVING/CASE WHEN/サブテーブル DML）。
- **STATUS**: スカラー同様に扱うが、プロセス管理無効時は SIMPLE 側が GAIA_ST02 で基準を取れない（有効アプリでの確認は将来）。
- **非対象**: テキスト/数値の `IN ('')`（既に一致・不変）。空文字以外の値（フェーズ1 のまま）。押し下げ（`IN ('')` は Phase 2a で非押下のまま＝`''` は optionOrder 非在・STATUS は GAIA_ST02 回避。JS 側が正しく評価するので機能欠落なし）。flatten の投影是正（案B・別課題化）。

## 5. 受入
1. **`IN ('')` == 空/未設定セル**（DROP_DOWN/RADIO/CHECK_BOX/MULTI_SELECT/USER 系）で SIMPLE==FULL_SCAN（APP4221: 1,2,3,4）。
2. **`NOT IN ('')` == 非空セル**で SIMPLE==FULL_SCAN（5,6）。空セルは NOT IN で除外。
3. **混在** `IN ('', 'd1')` は空セル ∪ d1（1,2,3,4,5）。
4. **非空値の IN/NOT IN は不変**（フェーズ1 の全型評価が回帰なし）。
5. **テキスト/数値の `IN ('')` は不変**（空テキスト一致・型メタなしフォールバック維持）。
6. **NOT IN の空配列包含**（フェーズ1）と両立（`複数選択 NOT IN ('M2')` は空も含む）。
7. Phase 2a 非退行: `IN ('')` は EXPLAIN 候補にならず非押下のまま（`value.value !== ""` ガード）。

## 6. 進め方
- 案A/案B を codex レビューで確定 → 実装（`typedInContains` に空セル一致・案A）→ 実装レビュー（コードで裏取り）→ 実機（APP4221 で SIMPLE==FULL_SCAN）→ **v2.6.0 に Phase 2a と束ねてリリース**。
