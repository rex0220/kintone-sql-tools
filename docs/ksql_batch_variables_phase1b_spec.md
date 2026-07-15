# 仕様案: バッチ変数 Phase 1b（スカラーサブクエリ代入 `SET @x = (SELECT ...)`）

- 作成日: 2026-07-15
- ステータス: **仕様案（codex レビュー前）**
- 分担: Claude=仕様/観点、Codex=実装/テスト
- SemVer: **後方互換の機能追加 → minor（v2.3.0 想定）**
- 前提: Phase 1a（`SET @x = <スカラー式>`）はリリース済み（v2.1.0）。本書はその拡張。
- 関連コード: `src/parser/parser.ts`（`parseScalarExpr` / `parseSetVariable`）、`src/execute.ts`（`evaluateScalarExpr` / SET_VARIABLE 処理 / `evalAssertOperand`）、`src/core/batch.ts`（`analyzeBatch` / `collectVariableRefs`）、`src/types/ast.ts`（`ScalarExpr` / `SetVariableStatement`）

## 0. 目的

`;` 区切りバッチ内で **`SET @名前 = (SELECT ...)`（スカラーサブクエリ）** による変数代入を可能にする。主用途は**件数ゲートの DRY 化**:

```sql
-- 現状（1a）: 件数を各所に直接書く
ASSERT (SELECT COUNT(*) FROM APP100 WHERE 処理ステータス IN ('未処理')) BETWEEN 0 AND 10000;
CREATE TEMP TABLE #t AS SELECT 顧客コード FROM APP100 WHERE 処理ステータス IN ('未処理');

-- 1b: 一度定義して使い回す
SET @cnt = (SELECT COUNT(*) FROM APP100 WHERE 処理ステータス IN ('未処理'));
ASSERT @cnt BETWEEN 0 AND 10000;
SELECT '対象件数' AS 区分, @cnt AS 件数 FROM APP100 LIMIT 1;
```

現状は `parseScalarExpr`（[parser.ts:269](../src/parser/parser.ts#L269)）が **「SET のスカラーサブクエリ代入は Phase 1b で対応予定です」** で拒否している。本課題でこれを解禁する。

## 1. スコープ

- **入れる**: `SET @名前 = (SELECT ...)`。サブクエリは **1 行 × 1 列**（スカラー）を返すこと。**バッチ実行時に一度だけ評価**し、以後は定数として扱う（1a と同じ）。
- **入れない（後続フェーズ）**: `DECLARE` 外部注入（1c）、`NULL` 代入、1 変数の配列展開（`IN (@list)`）、変数から変数への代入（`SET @b = @a`）、サブクエリ結果に対する算術（`SET @x = (SELECT ...) * 2`）。

## 2. 構文

- `SET @名前 = ( SELECT ... )`。括弧付きスカラーサブクエリ。既存の ASSERT オペランドのスカラーサブクエリ（[parser.ts:464-483](../src/parser/parser.ts#L464)）と同じ構文・制約を流用する。
- **サブクエリ後の算術は不可**（ASSERT と同じ）: `SET @x = (SELECT ...) * 2` は「スカラーサブクエリの後に算術演算子は使用できません。サブクエリ内で計算してください」。→ `SET @x = (SELECT COUNT(*) * 2 FROM ...)` と書く。
- 単文の `SET` は不可（1a と同じ・**2 文以上のバッチ限定**）。

### AST
- `SetVariableStatement.expr` の型（現 `ScalarExpr` = STRING / NUMBER / KINTONE_FUNC / STRING_FUNC / ARITH）に **`SCALAR_SUBQUERY`** を追加する（`ScalarSubquery` は既存型を再利用）。

## 3. 実行意味論

### 3.1 評価タイミング・スカラー保証
- **SET の実行時に一度だけサブクエリを実行**し、結果のスカラー値を変数へ束縛する（以後は定数）。
- **スカラー検証は `evalAssertOperand` の SCALAR_SUBQUERY 経路（[execute.ts:817-836](../src/execute.ts#L817)）を流用**:
  - `withScalarProbeLimit`（非集計は LIMIT 2 で多重行を早期検出）。
  - **列数 > 1 → エラー**（`SELECT *` 等は実行時に検証）。
  - **0 行 → エラー**（「スカラーサブクエリが 0 行（1 行が必要）」）。※ GROUP BY なし集計は 0 件でも 1 行を返す（v1.12.0）ため、`COUNT(*)` 等の件数取得は 0 件でも成立する。
  - **複数行 → エラー**。
- **結果値の型**: kintone のスカラー値（文字列）を **`VarValue` の `string`** として束縛する（`COUNT(*)` は数値文字列 `"5"`）。以降の比較は既存どおり `scalarCompare` が数値/文字列を動的に解釈する（`ASSERT @cnt < 10000` は数値比較）。**サブクエリ結果に対する算術は非対応**（1a と同じく変数は定数バインドのみ）。

### 3.2 実行経路の async 化
- 現在の SET 処理は同期（[execute.ts:545](../src/execute.ts#L545) `variables.set(stmt.name, evaluateScalarExpr(stmt.expr))`）。**サブクエリ代入は非同期**（SELECT 実行）になるため、SET_VARIABLE 分岐を **async 評価**にする:
  - `expr.type !== "SCALAR_SUBQUERY"` → 従来の同期 `evaluateScalarExpr`。
  - `expr.type === "SCALAR_SUBQUERY"` → `await` でサブクエリ実行（`evalAssertOperand` の SCALAR_SUBQUERY と同じ関数を共通化して呼ぶ）→ 文字列を `{type:"string", value}` で束縛。

### 3.3 一時テーブル・変数の参照
- **一時テーブル**: SET **より前**に作成された一時テーブルをサブクエリから参照できる（`evalAssertOperand` は既に `tempTables` を受け取る）。これにより `CREATE TEMP TABLE #t AS ...; SET @cnt = (SELECT COUNT(*) FROM #t)` が成立する。
- **先行変数の参照（設計判断・推奨=許可）**: サブクエリ内 WHERE 等で**既に定義済みの `@var` を参照可**にする（例 `SET @cnt = (SELECT COUNT(*) FROM APP WHERE 期限 < @cutoff)`）。実装は、サブクエリ実行前に `resolveVariableRefs` をサブクエリへ適用する（`@var` の WHERE 参照は 1a の既存機能）。
  - このため **`analyzeBatch` / `collectVariableRefs` が SET サブクエリ内の `@var` も走査**し、未定義・前方参照を実行前に検出する必要がある（§4）。
  - 代替（スコープ縮小）: 1b では SET サブクエリ内の `@var` 参照を**不可**とし、温存（temp テーブル参照のみ）。→ DRY 効果が落ちるため**非推奨**。

## 4. バッチ静的解析（`analyzeBatch`）

- **変数の定義順**: `SET @x = (SELECT ...)` は 1 つの定義。サブクエリ内で参照する `@var` は**その文より前に定義済み**でなければならない（未定義・前方参照は実行前エラー、1a と同じ規則）。→ `collectVariableRefs` が **SET サブクエリの内部（WHERE 等）も走査**する。
- **再代入・未使用**: 1a と同じ（再代入はエラー、未使用は警告）。
- **一時テーブル参照の順序**: サブクエリが参照する `#temp` はその文より前に作成済みであること（既存の temp 解析に準拠）。

## 5. エラー方針
- **SET の評価失敗（0 行 / 複数行 / 複数列 / API エラー）は `continueOnError` に関わらずバッチを停止**（1a と同じ＝SET は基盤定義のため fail-fast）。
- 単文 SET・前方参照・未定義・再代入は**実行前エラー**（静的解析）。

## 6. 受入テスト観点

- **基本**: `SET @cnt = (SELECT COUNT(*) FROM APP WHERE ...); ASSERT @cnt BETWEEN 0 AND N; SELECT ... @cnt ...` が件数で正しく動く。0 件でも `COUNT(*)` は 1 行（値 0）で成立。
- **一時テーブル参照**: `CREATE TEMP TABLE #t AS ...; SET @cnt = (SELECT COUNT(*) FROM #t); ...`。
- **先行変数参照（許可する場合）**: `SET @cutoff = TODAY(); SET @cnt = (SELECT COUNT(*) FROM APP WHERE 期限 < @cutoff); ...`。未定義 `@x` の前方参照はエラー。
- **スカラー違反**: 複数列（`SELECT a, b`）→ エラー、複数行 → エラー、0 行（非集計の `SELECT k FROM ... WHERE 該当なし`）→ エラー。
- **算術後置**: `SET @x = (SELECT ...) * 2` → パースエラー（サブクエリ内で計算せよ）。
- **単文**: 単文 `SET @x = (SELECT ...)` → 「requires a batch」。
- **エラー時停止**: `continueOnError: true` でも SET 評価失敗でバッチ停止。
- **型/比較**: `@cnt`（文字列 `"5"`）が `ASSERT @cnt < 10000`（数値比較）・`WHERE 件数 = @cnt` で期待どおり。
- **回帰**: 1a（非サブクエリ SET）・ASSERT のスカラーサブクエリが不変。

## 7. 実装メモ（Codex 向け）
- `parseScalarExpr`（parser.ts:260-）: 269 の Phase 1b 拒否を外し、`(SELECT ...)` を ASSERT オペランドと同じ経路でパースして `SCALAR_SUBQUERY` を返す。算術後置の拒否メッセージも流用。
- `types/ast.ts`: `SetVariableStatement.expr` に `ScalarSubquery` を含める。
- `execute.ts`: SET_VARIABLE 分岐を async 化。SCALAR_SUBQUERY は `evalAssertOperand` の SCALAR_SUBQUERY 検証ロジックを**共通ヘルパー**へ切り出して SET からも呼ぶ（重複回避）。値は `{type:"string", value}`。サブクエリ実行前に `resolveVariableRefs` を適用（先行変数許可の場合）。
- `core/batch.ts`: `collectVariableRefs` が SET サブクエリ内部を走査（未定義・前方参照検出）。
- プラグイン: バッチ実行エンジンをバンドルするため **`npm run build`（plugin 含む）** で `prod/js/desktop.js` も再生成。

## 8. 効果・リスク
- **効果**: 件数ゲート・条件値の DRY 化（レシピ集 R1/R2 と直結）。後方互換の機能追加。
- **リスク**: 低〜中。既存のスカラーサブクエリ実行・検証を流用するため中核ロジックは実績あり。主な新規要素は (i) SET 分岐の async 化、(ii) `collectVariableRefs` のサブクエリ走査（先行変数許可時）。
- **非対象**: サブクエリ結果の算術・`NULL`・配列展開・`DECLARE`（1c）。
