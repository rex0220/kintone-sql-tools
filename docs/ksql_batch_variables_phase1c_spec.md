# 仕様案: バッチ変数 Phase 1c（`DECLARE @x = 既定値` 外部パラメータ注入）

- 作成日: 2026-07-15
- ステータス: **仕様案（codex レビュー前）**
- 分担: Claude=仕様/観点、Codex=実装/テスト
- SemVer: **後方互換の機能追加 → minor（v2.4.0 想定）**
- 前提: Phase 1a（`SET @x = <スカラー式>`・v2.1.0）／1b（`SET @x = (SELECT ...)`・v2.3.0）はリリース済み。本書はその拡張。
- 方針（確定）: **注入経路＝MCP＋CLI（プラグインは対象外）／`DECLARE @name = 既定値`（未注入なら既定値・単文可）／既存の `:name`（保存クエリのパラメータ化）とは別機構として両立**。
- 関連コード: `src/parser/parser.ts`、`src/types/ast.ts`、`src/execute.ts`（バッチ変数 Map・[:451](../src/execute.ts#L451)／単文 @ref 拒否 [:320](../src/execute.ts#L320)）、`src/core/batch.ts`、`src/mcp/schemas.ts` / `src/mcp/tools.ts`、`src/cli/index.ts`

## 0. 目的

**同じ定型 SQL を、値だけ外部から差し替えて実行**できるようにする。`SET`（バッチ内で値を確定）と違い、`DECLARE` は**値を外部（MCP パラメータ / CLI フラグ）から注入**する。未注入時は**既定値**を使う。

```sql
DECLARE @since = '2026-01-01';           -- 既定値。外部注入で上書き可
SELECT * FROM APP100 WHERE 登録日 >= @since;
```

- MCP: `ksql_query({ sql, variables: { since: "2026-07-01" } })` で `@since` を上書き。
- CLI: `ksql -e "DECLARE @since = '2026-01-01'; SELECT ... >= @since" --var since=2026-07-01`。
- 未注入なら `@since = '2026-01-01'`（既定値）で実行。

## 1. スコープ

- **入れる**: `DECLARE @名前 = <既定値>` 文と、**外部注入**（MCP `variables` パラメータ／CLI `--var name=value`）。**単文（`DECLARE` ＋ 1 文の使用）で可**。
- **入れない（後続/別機構）**: プラグインでの注入 UI・`:name` 保存クエリパラメータ（別ドラフト）・`NULL` 代入・配列展開（`IN (@list)`）・`SELECT` 列での変数参照・注入値の型指定（すべて文字列束縛）。

## 2. 構文

- `DECLARE @名前 = <既定値式>;`
  - `@名前` は 1a と同じ規則（英字/`_` 始まり・64 文字以内・大小区別なし）。
  - **既定値式は 1a のスカラー式**（リテラル・`NOW()`/`TODAY()`・文字列/数値関数・数値算術）。**スカラーサブクエリ（1b）は既定値には使えない**（既定値は静的・安価に保つ。必要なら `SET` を使う）。
  - 複数の `DECLARE` を並べられる。
- **単文可**: `DECLARE @p = <既定値>; <@p を使う 1 文>` を最小の**パラメータ化クエリ**として許可する（`SET` の「2 文以上」制約と異なり、`DECLARE` ＋ 使用 1 文で成立）。
- AST: `DeclareStatement { type: "DECLARE_VARIABLE"; name: string; default: ScalarExpr(サブクエリ除く) }` を追加。

## 3. 実行意味論

### 3.1 注入と既定値
- 実行時、各 `DECLARE @name` について:
  - 外部注入（`options.variables[name]`）が**あれば**その値（文字列）を採用。
  - **なければ**既定値式を評価して採用（1a の `evaluateScalarExpr` 流用）。
- 採用値は **`VarValue` の `string`** として束縛（注入値は常に文字列。比較は既存どおり `scalarCompare` が数値/文字列を動的に解釈）。
- 変数名前空間は **`SET @var` と共有**。同名を `DECLARE` と `SET` の両方で定義、または `DECLARE` を再宣言するのは**再定義エラー**（1a の再代入検出に準拠）。

### 3.2 外部注入インターフェイス
- **`ExecuteOptions.variables?: Readonly<Record<string, string>>`** を追加。実行時にバッチ変数 Map（[execute.ts:451](../src/execute.ts#L451)）へ `DECLARE` 解決時に反映する。
- **MCP**: `ksql_query` / `ksql_mutate` のスキーマ（`src/mcp/schemas.ts`）に `variables?: Record<string, string>`（値は文字列）を追加し、`ExecuteOptions.variables` へ渡す。
- **CLI**: `--var name=value`（繰り返し可）を追加し、`Record<string,string>` に集約して渡す。`=` 前が変数名、後が値。
- **プラグイン**: 対象外（注入 UI を持たない）。プラグインで `DECLARE` を含む SQL は**既定値のみ**で動作する（注入経路がないため）。
- **注入値のバインド**: 値としてバインド（識別子化しない）。**SQL インジェクションは発生しない**（1a と同じ）。

### 3.3 単文での参照（[execute.ts:320](../src/execute.ts#L320) の緩和）
- 現状、単文中の `@ref` は「`variable @X is not defined in a batch`」で拒否される。**`DECLARE` を含む入力はバッチ**（`DECLARE` ＋ 使用文＝2 文以上）として扱われるため、この最小形は既存のバッチ経路で動く。
- **純粋注入（`DECLARE` 無しの単一 `SELECT` に `@p` を注入）は本フェーズでは非対応**（`DECLARE` で明示宣言する方式に統一。SQL が自らのパラメータを自己文書化し、未宣言注入のタイポを防ぐ）。→ 将来検討。

## 4. バッチ静的解析（`analyzeBatch`）
- `DECLARE @name` は**変数定義**（`SET` と同じ扱いで定義順・再定義・未使用を検査）。使用は**定義より後**（前方参照エラー）。`collectVariableRefs` は汎用再帰のため既存のまま。
- **未宣言の注入**: `options.variables` に**`DECLARE` されていない名前**が渡された場合は**エラー**（タイポ保護）。
- **既定値式の検査**: 既定値に `@var`・サブクエリは不可（静的スカラー式のみ）。

## 5. エラー方針
- 既定値の評価失敗・未宣言注入・再定義・前方参照は**実行前/評価時エラー**でバッチ停止（`SET` と同じ fail-fast 系）。
- 注入値は文字列。空文字注入は「空文字の値」として扱う（`NULL` ではない）。

## 6. 受入テスト観点
- **既定値**: `DECLARE @since = '2026-01-01'; SELECT ... >= @since` が注入なしで既定値で動く。
- **注入で上書き**: 同 SQL に `variables: { since: "2026-07-01" }`（MCP）／`--var since=2026-07-01`（CLI）で結果が変わる。
- **単文（DECLARE＋1文）**: `DECLARE @p = 'X'; SELECT ... WHERE k = @p` が成立。
- **複数 DECLARE**・**DECLARE と SET の併用**（別名）・**同名再定義エラー**。
- **未宣言注入エラー**: `variables: { typo: ... }`（DECLARE に無い）→ エラー。
- **前方参照/未定義参照**: 既存 1a と同じく実行前エラー。
- **既定値式の制約**: `DECLARE @x = (SELECT ...)`（サブクエリ）・`DECLARE @x = @y`（変数）はパース/解析エラー。
- **型/比較**: 注入値（文字列 `"100"`）が数値比較・文字列比較で期待どおり。
- **バインド安全性**: 注入値に `' OR 1=1` 等を入れても値としてバインドされ、識別子・演算子にならない。
- **プラグイン**: `DECLARE` 入力が既定値のみで動作（注入経路なし）。
- **回帰**: 1a/1b（`SET`）・既存の単文 @ref 拒否（DECLARE を伴わない単文）が不変。

## 7. 実装メモ（Codex 向け）
- `types/ast.ts`: `DeclareStatement` 追加（`Statement` union に）。既定値は `Exclude<ScalarExpr, ScalarSubquery>`。
- `parser.ts`: `DECLARE` キーワード（lexer 追加要否を確認）→ `parseDeclare`。既定値は `parseScalarExpr` 相当だがサブクエリ・変数参照を拒否。
- `core/batch.ts`: `analyzeBatch` が `DECLARE` を変数定義として扱う（定義順・再定義・未使用・前方参照）。未宣言注入の検査は実行側（options.variables のキーが宣言集合に含まれるか）。
- `execute.ts`:
  - `ExecuteOptions.variables?: Record<string,string>` を追加。バッチ実行の変数 Map 初期化（[:451](../src/execute.ts#L451)）または `DECLARE` 実行時に「注入があれば注入、なければ既定値」を束縛。
  - `DECLARE_VARIABLE` の実行分岐を追加（`SET` 同様、結果セットなし）。
  - 未宣言注入エラー・再定義エラーの検査。
- `mcp/schemas.ts` / `mcp/tools.ts`: `ksql_query` / `ksql_mutate` に `variables` を追加し `ExecuteOptions` へ。
- `cli/index.ts`: `--var name=value`（繰り返し）を解析。
- プラグイン: 変更なし（注入 UI なし）。ただしバッチエンジンをバンドルするため `DECLARE` 自体は動く（既定値のみ）。**`npm run build`（plugin 含む）** で `desktop.js` 再生成。
- ドキュメント: 言語リファレンス §25・レシピ集にパラメータ化例。

## 8. `:name`（保存クエリのパラメータ化）との関係
- **別機構として両立**（確定）。`:name` は MCP 保存クエリ（単文・カタログ）向けのバインド変数ドラフト、1c は**バッチ変数 `@var` の外部注入**。文脈が異なるため独立に設計する。
- 将来的な統一（1 つの外部パラメータ機構への収斂）は本フェーズの対象外。両者が併存しても名前空間（`@var` と `:name`）が異なるため衝突しない。

## 9. 効果・リスク
- **効果**: 定型 SQL のパラメータ化。MCP クライアント／CLI スクリプトから「文型・対象アプリは固定、値だけ差し替え」を安全に実行。
- **リスク**: **中**。パーサ（新キーワード）・実行（注入と既定値）・**外部インターフェイス（MCP スキーマ＋CLI フラグ）** に広がる。中核の変数解決は 1a/1b の実績を流用。
- **非対象**: プラグイン注入 UI・純粋注入（DECLARE 無し）・`NULL`・配列展開・`SELECT` 列変数・`:name` 統一。
