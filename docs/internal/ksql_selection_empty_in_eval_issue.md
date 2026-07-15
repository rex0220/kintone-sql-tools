# 課題+仕様: 選択系フィールドの `IN ('')` / `NOT IN ('')` 空セル評価の SIMPLE/FULL_SCAN 乖離

- 作成日: 2026-07-15
- ステータス: **課題+仕様案 R2（codex レビュー反映・案B 採用で実装着手可）**
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

## 3. 修正方式（**案B 採用**・codex レビュー R2）

### 採用: 案B ＝ `flatten` の null 正規化 ＋ `typedInContains` の空配列補完
- **`flatten`（[process.ts:69](../../src/engine/process.ts#L69)）を `val == null ? "" : (typeof val === "string" ? val : JSON.stringify(val))` に変更**＝**null/undefined を `""`(0 文字)へ正規化**（現状 `JSON.stringify(null ?? "")` が `""`(2 文字)を生む点を是正）。空スカラー → `""`(0 文字) → スカラー経路 `values.has("")` が自然に真。
- **配列空は `typedInContains`（[evalWhere.ts:152](../../src/engine/evalWhere.ts#L152)）で補完**（空配列は kintone が `[]` を返し null でないため flatten 変更の影響外）。**JSON parse と型別の形検証を通した後にのみ** `if (parsed.length === 0 && values.has("")) return true;` を適用（点3）。`NOT IN` は既存 `!contains` で自然反転。

### 案A を採らない理由（codex 点1・Medium）
案A のスカラー空判定 `leftStr === '""'`(2 文字) は、**実際の選択肢コードが文字通り 2 文字の `""` だった場合と区別できない**（flatten で null が `""`(2 文字)へ変換された後は実値と空セルが同一表現）。案A はその実値まで `IN ('')` に誤一致させる。案B は **null のうちに 0 文字へ正規化**するため、この曖昧性を作らない。

### 案B は「新意味論」でなく「整合修正」（codex 点2・Medium）
`flatten` の値は投影だけでなく **JOIN / GROUP BY / DISTINCT / ORDER BY / CASE / WHERE / CTE・一時テーブル化** に使われる（[execute.ts:1064](../../src/execute.ts#L1064) / [process.ts:856,862](../../src/engine/process.ts#L856)）。一方、**サブテーブル側 `toFlatString`（[subtableAdapter.ts:56](../../src/converter/subtableAdapter.ts#L56)）は既に null/undefined を 0 文字の空文字へ正規化済み**。よって案B は新しい意味論ではなく、**トップレベルとサブテーブルの表現不整合の是正**。§5 の回帰固定で安全に採用できる。

### 空配列補完の位置（codex 点3・Low）
`typedInContains` の各型分岐で、**`JSON.parse` 成功 ＋ `Array.isArray` ＋ 要素形検証を通した後**に `parsed.length === 0 && values.has("")` を判定する。これにより malformed JSON のフォールバックや、テキスト値 `"[]"`（型メタなし＝フォールバック経路）を壊さない。

## 4. スコープと非対象
- **対象**: DROP_DOWN / RADIO_BUTTON / CHECK_BOX / MULTI_SELECT / USER / 組織 / グループ / 作業者（STATUS_ASSIGNEE）の `IN ('')` / `NOT IN ('')` 空セル一致。`evalWhere` の全 JS 評価経路（WHERE/HAVING/CASE WHEN/サブテーブル DML）。
- **STATUS**: スカラー同様に扱うが、プロセス管理無効時は SIMPLE 側が GAIA_ST02 で基準を取れない（有効アプリでの確認は将来）。
- **含む（案B の副次的是正）**: flatten の null→0 文字正規化により、空スカラー選択の **SELECT 投影が `""`(2 文字)→空** に是正される（サブテーブルと整合）。§5.9-14 で回帰固定。
- **非対象**: テキスト/数値の `IN ('')`（既に一致・不変）。空文字以外の値（フェーズ1 のまま）。押し下げ（`IN ('')` は Phase 2a で非押下のまま＝`''` は optionOrder 非在・STATUS は GAIA_ST02 回避。JS 側が正しく評価するので機能欠落なし）。

## 5. 受入

### IN 空セル一致（本題）
1. **`IN ('')` == 空/未設定セル**（DROP_DOWN/RADIO/CHECK_BOX/MULTI_SELECT/USER 系）で SIMPLE==FULL_SCAN（APP4221: 1,2,3,4）。
2. **`NOT IN ('')` == 非空セル**で SIMPLE==FULL_SCAN（5,6）。空セルは NOT IN で除外。
3. **混在** `IN ('', 'd1')` は空セル ∪ d1（1,2,3,4,5）。
4. **非空値の IN/NOT IN は不変**（フェーズ1 の全型評価が回帰なし）。
5. **テキスト/数値の `IN ('')` は不変**（空テキスト一致・型メタなしフォールバック維持）。
6. **NOT IN の空配列包含**（フェーズ1）と両立（`複数選択 NOT IN ('M2')` は空も含む）。
7. **`IN (SELECT ...)` の結果集合に空文字 `""` を含む**場合も、空セルが一致（`typedInContains` の空配列補完・スカラー `values.has("")` が SUBQUERY_IN_LIST 経路でも効く）。
8. **CASE / サブテーブル DML の空セル**（`evalWhere` の全 JS 評価経路）で同じ空セル意味論。

### flatten null 正規化の回帰固定（案B の波及・codex 点2）
9. **null の SELECT 投影が 0 文字の空文字**（空スカラー選択が `""`(2 文字)→空表示）。
10. **null 同士の JOIN・GROUP BY・DISTINCT**（空キー同士が正しくグルーピング/結合。`""`(2 文字) 依存の既存挙動がないこと）。
11. **空セルの CASE / WHERE**（`= ''` 等の比較・条件分岐が空を空として扱う）。
12. **サブテーブルとトップレベルで同じ表現**（`toFlatString` と `flatten` が null を同一の 0 文字へ）。
13. **LEFT JOIN 欠損側**（右側が存在しない行の値が 0 文字の空文字で、`IN ('')`/比較が一貫）。
14. **テキスト・数値・非空値は不変**（string/number/array 値は従来どおり）。

### Phase 2a 非退行
15. `IN ('')` は EXPLAIN 候補にならず非押下のまま（`value.value !== ""` ガード）。JS 側でこの修正が効き、押し下げと独立に SIMPLE==FULL_SCAN が回復。

## 6. 進め方
- **案B 確定**（codex R2 承認）→ codex 実装（`flatten` の null→0 文字正規化 ＋ `typedInContains` の空配列補完・形検証後）→ 実装レビュー（コードで裏取り・§5 回帰固定）→ 実機（APP4221 で `IN ('')`/`NOT IN ('')` の SIMPLE==FULL_SCAN・投影是正）→ **v2.6.0 に Phase 2a と束ねてリリース**。
