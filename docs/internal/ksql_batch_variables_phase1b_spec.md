# 仕様案: バッチ変数 Phase 1b（スカラーサブクエリ代入 `SET @x = (SELECT ...)`）

- 作成日: 2026-07-15
- ステータス: **実装済み・v2.3.0 リリース済（`SET @x=(SELECT ...)` スカラーサブクエリ代入）**
- 分担: Claude=仕様/観点、Codex=実装/テスト
- 更新履歴:
  - 2026-07-15 R1: 初版
  - 2026-07-15 R2: codex レビュー反映（[High] `SELECT @cnt` は現行構文で不可＝利用例を ASSERT/WHERE/UPDATE SET/IN に限定／[Medium] 共通ヘルパーは中立エラーを投げ SET は fail-fast・ASSERT は AssertError に分類（AssertError 直流用だと "assertion" に誤分類）／[Medium] バッチ EXPLAIN で SET サブクエリの計画（APP/temp・1回評価）を表示・先行変数はプレースホルダー解決／[Low] `collectVariableRefs` は汎用再帰で自動収集・SET 分岐は async ヘルパーを await するだけ／1列判定は `!== 1`）。
- SemVer: **後方互換の機能追加 → minor（v2.3.0 想定）**
- 前提: Phase 1a（`SET @x = <スカラー式>`）はリリース済み（v2.1.0）。本書はその拡張。
- 関連コード: `src/parser/parser.ts`（`parseScalarExpr` / `parseSetVariable`）、`src/execute.ts`（`evaluateScalarExpr` / SET_VARIABLE 処理 / `evalAssertOperand`）、`src/core/batch.ts`（`analyzeBatch` / `collectVariableRefs`）、`src/types/ast.ts`（`ScalarExpr` / `SetVariableStatement`）

## 0. 目的

`;` 区切りバッチ内で **`SET @名前 = (SELECT ...)`（スカラーサブクエリ）** による変数代入を可能にする。主用途は**件数ゲートの DRY 化**:

```sql
-- 現状（1a）: 件数を各所に直接書く
ASSERT (SELECT COUNT(*) FROM APP100 WHERE 処理ステータス IN ('未処理')) BETWEEN 0 AND 10000;
CREATE TEMP TABLE #t AS SELECT 顧客コード FROM APP100 WHERE 処理ステータス IN ('未処理');

-- 1b: 一度定義して使い回す（参照は WHERE / UPDATE SET / ASSERT / IN）
SET @cnt = (SELECT COUNT(*) FROM APP100 WHERE 処理ステータス IN ('未処理'));
ASSERT @cnt BETWEEN 0 AND 10000;
UPDATE APP100 SET 対象件数メモ = @cnt WHERE 処理ステータス IN ('未処理');
```

現状は `parseScalarExpr`（[parser.ts:269](../../src/parser/parser.ts#L269)）が **「SET のスカラーサブクエリ代入は Phase 1b で対応予定です」** で拒否している。本課題でこれを解禁する。

> **[High] 変数の参照範囲は 1a のまま**（WHERE 右辺 / `UPDATE` の SET 値 / `ASSERT` オペランド / `IN` リスト要素）。**`SELECT` の列に `@var` は書けない**（`parseSelectColumn` は VARIABLE を受理しない・[parser.ts:687](../../src/parser/parser.ts#L687)）。1b は「SET の右辺にサブクエリを許可する」だけで、**参照範囲は拡張しない**。

## 1. スコープ

- **入れる**: `SET @名前 = (SELECT ...)`。サブクエリは **1 行 × 1 列**（スカラー）を返すこと。**バッチ実行時に一度だけ評価**し、以後は定数として扱う（1a と同じ）。
- **入れない（後続フェーズ）**: `DECLARE` 外部注入（1c）、`NULL` 代入、1 変数の配列展開（`IN (@list)`）、変数から変数への代入（`SET @b = @a`）、サブクエリ結果に対する算術（`SET @x = (SELECT ...) * 2`）。

## 2. 構文

- `SET @名前 = ( SELECT ... )`。括弧付きスカラーサブクエリ。既存の ASSERT オペランドのスカラーサブクエリ（[parser.ts:464-483](../../src/parser/parser.ts#L464)）と同じ構文・制約を流用する。
- **サブクエリ後の算術は不可**（ASSERT と同じ）: `SET @x = (SELECT ...) * 2` は「スカラーサブクエリの後に算術演算子は使用できません。サブクエリ内で計算してください」。→ `SET @x = (SELECT COUNT(*) * 2 FROM ...)` と書く。
- 単文の `SET` は不可（1a と同じ・**2 文以上のバッチ限定**）。

### AST
- `SetVariableStatement.expr` の型（現 `ScalarExpr` = STRING / NUMBER / KINTONE_FUNC / STRING_FUNC / ARITH）に **`SCALAR_SUBQUERY`** を追加する（`ScalarSubquery` は既存型を再利用）。

## 3. 実行意味論

### 3.1 評価タイミング・スカラー保証
- **SET の実行時に一度だけサブクエリを実行**し、結果のスカラー値を変数へ束縛する（以後は定数）。
- **スカラー検証ロジックは `evalAssertOperand` の SCALAR_SUBQUERY 経路（[execute.ts:817-836](../../src/execute.ts#L817)）を共通ヘルパーへ切り出して流用**:
  - `withScalarProbeLimit`（非集計は LIMIT 2 で多重行を早期検出）。
  - **列数 `!== 1` → エラー**（`SELECT *` 等は実行時に検証。契約どおり「ちょうど 1 列」で判定＝`> 1` でなく `!== 1`）。
  - **0 行 → エラー**。※ GROUP BY なし集計は 0 件でも 1 行を返す（v1.12.0）ため、`COUNT(*)` 等の件数取得は 0 件でも成立する。
  - **複数行 → エラー**。
- **[Medium] 共通ヘルパーは中立エラー（`ScalarSubqueryError`）を投げる**。呼び出し側で分類:
  - **ASSERT**: 従来どおり `AssertError` に変換（バッチは `"assertion"` で停止）。
  - **SET**: `ArgumentError`（＝非 AssertError）にする。バッチ実行器の分類（[execute.ts:510-519](../../src/execute.ts#L510)）は **`instanceof AssertError` を SET_VARIABLE より先に判定**するため、SET が `AssertError` を投げると誤って `"assertion"` 停止になる。中立エラーにすることで **SET 失敗は `"fail-fast"` 停止**（正しい分類）になる。
- **結果値の型**: kintone のスカラー値（文字列）を **`VarValue` の `string`** として束縛する（`COUNT(*)` は数値文字列 `"5"`）。以降の比較は既存どおり `scalarCompare` が数値/文字列を動的に解釈する（`ASSERT @cnt < 10000` は数値比較）。**サブクエリ結果に対する算術は非対応**（1a と同じく変数は定数バインドのみ）。

### 3.2 SET 分岐の非同期評価（[Low]・小さい変更）
- `executeBatchStatement` は**既に async**（[execute.ts:535](../../src/execute.ts#L535)）で呼び出し側も await 済み。**関数シグネチャの async 化は不要**。SET_VARIABLE 分岐（[:545](../../src/execute.ts#L545)）で**非同期ヘルパーを await する**だけ:
  - `expr.type !== "SCALAR_SUBQUERY"` → 従来の同期 `evaluateScalarExpr`。
  - `expr.type === "SCALAR_SUBQUERY"` → `await` で共通スカラーサブクエリヘルパーを実行 → 文字列を `{type:"string", value}` で束縛。

### 3.3 一時テーブル・変数の参照
- **一時テーブル**: SET **より前**に作成された一時テーブルをサブクエリから参照できる（`evalAssertOperand` は既に `tempTables` を受け取る）。これにより `CREATE TEMP TABLE #t AS ...; SET @cnt = (SELECT COUNT(*) FROM #t)` が成立する。
- **先行変数の参照（設計判断・推奨=許可）**: サブクエリ内 WHERE 等で**既に定義済みの `@var` を参照可**にする（例 `SET @cnt = (SELECT COUNT(*) FROM APP WHERE 期限 < @cutoff)`）。実装は、サブクエリ実行前に `resolveVariableRefs` をサブクエリへ適用する（`@var` の WHERE 参照は 1a の既存機能）。
  - このため **`analyzeBatch` / `collectVariableRefs` が SET サブクエリ内の `@var` も走査**し、未定義・前方参照を実行前に検出する必要がある（§4）。
  - 代替（スコープ縮小）: 1b では SET サブクエリ内の `@var` 参照を**不可**とし、温存（temp テーブル参照のみ）。→ DRY 効果が落ちるため**非推奨**。

## 4. バッチ静的解析（`analyzeBatch`）

- **[Low] `collectVariableRefs` は汎用再帰**（[batch.ts:135](../../src/core/batch.ts#L135) が `Object.values` を再帰走査）。`SetVariableStatement.expr` の型に `SCALAR_SUBQUERY` を含めれば、**サブクエリ内の `@var`（VARIABLE ノード）は自動的に収集される**。関数自体の拡張は原則不要。
- **変数の定義順**: サブクエリ内で参照する `@var` は**その文より前に定義済み**でなければならない（未定義・前方参照は実行前エラー、1a と同じ規則が自動収集により適用される）。
- **再代入・未使用**: 1a と同じ（再代入はエラー、未使用は警告）。
- **一時テーブル参照の順序**: サブクエリが参照する `#temp` はその文より前に作成済みであること（既存の temp 解析に準拠）。

## 4.5 バッチ EXPLAIN（[Medium]）

現在の SET 計画（[execute.ts:3118-3123](../../src/execute.ts#L3118)）は `SET @name = <scalar expression>` の 2 行のみでサブクエリを表示しない。1b の SET サブクエリは **APP アクセスや一時テーブル走査が発生**するため、ASSERT と同様に計画を表示する:

- `SET @cnt = (SELECT ...)` の見出し。
- APP 参照時は SELECT 計画（SIMPLE/FULL_SCAN・kintone query 等）。
- 一時テーブル参照時は temp/FULL_SCAN 計画。
- 「実行時に 1 回評価」の注記。
- **先行変数のプレースホルダー解決**: 現在 EXPLAIN は SET 文だけ `resolveVariableRefs` を回避（[execute.ts:3085](../../src/execute.ts#L3085)）。SET サブクエリを計画化する際は、**SET 名は保持しつつ、サブクエリ内の先行変数だけプレースホルダー解決**する（後続 SET 用に `@name` プレースホルダーを設定する既存挙動（[:3093](../../src/execute.ts#L3093)）と整合させる）。

## 5. エラー方針
- **SET の評価失敗（0 行 / 複数行 / 複数列 / API エラー）は `continueOnError` に関わらずバッチを停止**（1a と同じ＝SET は基盤定義のため fail-fast）。**分類は `"fail-fast"`**（§3.1 の中立エラーにより、AssertError の `"assertion"` と区別される）。
- 単文 SET・前方参照・未定義・再代入は**実行前エラー**（静的解析）。

## 6. 受入テスト観点

- **基本**: `SET @cnt = (SELECT COUNT(*) FROM APP WHERE ...); ASSERT @cnt BETWEEN 0 AND N; UPDATE APP SET メモ = @cnt WHERE ...` が件数で正しく動く。0 件でも `COUNT(*)` は 1 行（値 0）で成立。**参照は WHERE / UPDATE SET / ASSERT / IN のみ**（`SELECT @cnt` はテストに含めない＝現行構文で不可）。
- **一時テーブル参照**: `CREATE TEMP TABLE #t AS ...; SET @cnt = (SELECT COUNT(*) FROM #t); ASSERT @cnt ...`。
- **先行変数参照**: `SET @cutoff = TODAY(); SET @cnt = (SELECT COUNT(*) FROM APP WHERE 期限 < @cutoff); ...`。未定義 `@x` の前方参照はエラー（`collectVariableRefs` の自動収集で検出）。
- **1 回だけ実行**: `@cnt` を複数の後続文で参照しても**サブクエリ API は再実行されない**（SET 時 1 回のみ）。
- **エラー分類（[Medium]）**: **SET のスカラー違反時、`continueOnError: true` でも後続文の `skippedReason` が `"fail-fast"`**。一方 **ASSERT の同じスカラー違反は従来どおり `"assertion"`**。
- **スカラー違反**: 複数列（`SELECT a, b`）→ エラー、複数行 → エラー、0 行（非集計の `SELECT k FROM ... WHERE 該当なし`）→ エラー（`columns.length !== 1` / 行数で判定）。
- **算術後置**: `SET @x = (SELECT ...) * 2` → パースエラー（サブクエリ内で計算せよ）。
- **単文**: 単文 `SET @x = (SELECT ...)` → 「requires a batch」。
- **EXPLAIN（[Medium]）**: SET サブクエリの APP 参照計画・一時テーブル参照計画が出る。先行変数を含む SET サブクエリで**プレースホルダー解決**された計画になる。
- **型/比較**: `@cnt`（文字列 `"5"`）が `ASSERT @cnt < 10000`（数値比較）・`WHERE 件数 = @cnt` で期待どおり。
- **回帰**: 1a（非サブクエリ SET）・ASSERT のスカラーサブクエリが不変。

## 7. 実装メモ（Codex 向け）
- `parseScalarExpr`（parser.ts:260-）: 269 の Phase 1b 拒否を外し、`(SELECT ...)` を ASSERT オペランドと同じ経路でパースして `SCALAR_SUBQUERY` を返す。算術後置の拒否メッセージも流用。
- `types/ast.ts`: `SetVariableStatement.expr` に `ScalarSubquery` を含める（→ `collectVariableRefs` が自動でサブクエリ内変数を収集）。
- `execute.ts`:
  - スカラーサブクエリ検証を**共通ヘルパー**へ切り出す（現 `evalAssertOperand` の SCALAR_SUBQUERY ロジック）。**中立エラー `ScalarSubqueryError` を投げる**。`columns.length !== 1` で 1 列判定。
  - **ASSERT** 側: ヘルパーを呼び、`ScalarSubqueryError` を `AssertError` に変換（既存分類 `"assertion"` を維持）。
  - **SET** 側: SET_VARIABLE 分岐（[:545](../../src/execute.ts#L545)）で `SCALAR_SUBQUERY` のとき `await` ヘルパー。エラーは `ArgumentError`（非 AssertError）にして **`"fail-fast"`** 分類にする。値は `{type:"string", value}`。実行前に `resolveVariableRefs` をサブクエリへ適用（先行変数解決）。`executeBatchStatement` は既に async のためシグネチャ変更不要。
  - **EXPLAIN**: `buildBatchStatementPlan` の SET_VARIABLE 分岐（[:3118](../../src/execute.ts#L3118)）で `SCALAR_SUBQUERY` のときサブクエリ計画を出す。バッチ EXPLAIN の SET は `resolveVariableRefs` を回避しているため（[:3085](../../src/execute.ts#L3085)）、SET 名は保持しつつサブクエリ内の先行変数だけプレースホルダー解決する。
- `core/batch.ts`: 原則変更不要（汎用再帰）。SET サブクエリ内の temp 参照順序チェックが既存 temp 解析で効くことを確認。
- プラグイン: バッチ実行エンジンをバンドルするため **`npm run build`（plugin 含む）** で `prod/js/desktop.js` も再生成。

## 8. 設計判断（codex レビュー確定）
- **先行変数参照**: **許可**（静的走査・実行前置換が既に汎用再帰のため追加コスト小・DRY 効果大）。
- **0 行**: **エラー**（1b は `NULL` を導入しない。`COUNT` は 0 件でも 1 行のため主用途を妨げない）。
- **1 列判定**: `columns.length !== 1`（契約どおり「ちょうど 1 列」）。

## 9. 効果・リスク
- **効果**: 件数ゲート・条件値の DRY 化（レシピ集 R1/R2 と直結）。後方互換の機能追加。
- **リスク**: **低**。既存のスカラーサブクエリ実行・検証を共通化して流用し、`collectVariableRefs`/`executeBatchStatement` は変更不要（[Low]）。新規は (i) SET 分岐で async ヘルパーを await、(ii) 中立エラーの分類、(iii) EXPLAIN の SET サブクエリ計画。
- **非対象**: サブクエリ結果の算術・`NULL`・配列展開・`DECLARE`（1c）・`SELECT` 列での変数参照。
