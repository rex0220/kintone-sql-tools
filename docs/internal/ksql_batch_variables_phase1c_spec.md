# 仕様案: バッチ変数 Phase 1c（`DECLARE @x = 既定値` 外部パラメータ注入）

- 作成日: 2026-07-15
- ステータス: **実装済み・v2.4.0 リリース済（`DECLARE @x = 既定値` 外部パラメータ注入・MCP/CLI）**
- 分担: Claude=仕様/観点、Codex=実装/テスト
- 更新履歴:
  - 2026-07-15 R1: 初版
  - 2026-07-15 R2: codex レビュー反映（[High] `DECLARE` はソフトキーワード（lexer 予約語にしない＝既存 `declare` フィールドを潰さない）／[High] 未宣言注入は**実行ループ前に一括検査**・`DECLARE_VARIABLE` だけを注入対象名として照合（`SET` は対象外）／[Medium] CLI/MCP の注入契約を字句レベルで確定（`@`なしキー・小文字正規化・最初の `=` 分割・重複/不正はエラー）／[Medium] `variables` は `BatchExecuteOptions` に持たせ MCP query/mutate 両経路で転送・`DECLARE_VARIABLE` を read-only 分類／注入時は既定値式を評価しない・`NOW()`/`TODAY()` は 1 回評価・`LOGINUSER()` 拒否・**「単文可」→「最小 2 文のバッチ」**（`DECLARE` 単独は拒否）・`--dry-run` は宣言照合のみ値非表示・`--var` は秘密情報向けでない旨の注意）。
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

- **入れる**: `DECLARE @名前 = <既定値>` 文と、**外部注入**（MCP `variables` パラメータ／CLI `--var name=value`）。**最小 2 文のバッチ**（`DECLARE` ＋ 使用 1 文以上）で成立。
- **入れない（後続/別機構）**: プラグインでの注入 UI・`:name` 保存クエリパラメータ（別ドラフト）・`NULL` 代入・配列展開（`IN (@list)`）・`SELECT` 列での変数参照・注入値の型指定（すべて文字列束縛）。

## 2. 構文

- `DECLARE @名前 = <既定値式>;`
  - **`DECLARE` はソフトキーワード**（[High]）。lexer の予約語にはせず、**文頭 `IDENT` が `DECLARE`（大小無視）のときだけ** `DECLARE_VARIABLE` として解析する（既存の `CREATE`/`DROP` と同じ方式・[parser.ts:214-235](../src/parser/parser.ts#L214)）。これにより `declare` という**フィールドコードを未引用で使えなくなる後方非互換を避ける**。
  - `@名前` は 1a と同じ規則（英字/`_` 始まり・64 文字以内・**大小区別なし**）。
  - **既定値式は 1a のスカラー式**（リテラル・`NOW()`/`TODAY()`・文字列/数値関数・数値算術）。**スカラーサブクエリ（1b）・変数参照・`LOGINUSER()` は既定値に使えない**（既定値は静的・安価に保つ。`LOGINUSER()` は 1a と同様に拒否）。
  - 複数の `DECLARE` を並べられる。
- **最小 2 文のバッチ**（[Medium]・「単文可」から改称）: `DECLARE @p = <既定値>; <@p を使う 1 文>` が最小の**パラメータ化クエリ**。`DECLARE` 単独（使用文なし）の入力は**拒否**する（`SET` の「単文不可」と整合。1 文のみの `DECLARE` は無意味）。
- AST: `DeclareStatement { type: "DECLARE_VARIABLE"; name: string; default: Exclude<ScalarExpr, ScalarSubquery> }` を追加。

## 3. 実行意味論

### 3.1 注入と既定値
- 実行時、各 `DECLARE @name` について:
  - 外部注入（正規化キー `name` が `options.variables` にある）が**あれば**その値（文字列）を採用し、**既定値式は評価しない**（[追加確定]。`DECLARE @t = NOW()` に注入があれば `NOW()` を呼ばない＝副作用・コストを避ける）。
  - **なければ**既定値式を評価して採用（1a の `evaluateScalarExpr` 流用）。`NOW()`/`TODAY()` は **`DECLARE` 実行時に 1 回だけ**評価。
- 採用値は **`VarValue` の `string`** として束縛（注入値は常に文字列。比較は既存どおり `scalarCompare` が数値/文字列を動的に解釈）。
- 変数名前空間は **`SET @var` と共有**。同名を `DECLARE` と `SET` の両方で定義、または `DECLARE` を再宣言するのは**再定義エラー**（1a の再代入検出に準拠）。

### 3.2 外部注入インターフェイス
- **`BatchExecuteOptions.variables?: Readonly<Record<string, string>>`** を追加（[Medium]。汎用 `ExecuteOptions` ではなく**バッチ専用オプション**に持たせる。単文 `execute()` に渡して黙って無視される事故を防ぐ）。`DECLARE` 解決時にバッチ変数 Map（[execute.ts:451](../src/execute.ts#L451)）へ反映。
- **注入キーの正規化契約（[Medium]・字句レベルで確定）**:
  - キーは **`@` なしの `name`**。
  - **大小を区別せず小文字へ正規化**（`@var` 名が大小非区別のため。`Since` と `since` を同一視できるよう、宣言側の名前も小文字化して照合）。
  - CLI `--var name=value` は**最初の `=` だけで分割**（`--var x=a=b` の値は `a=b`）。`name=` は**空文字**として許可。値中の空白はシェルの引用で保持。
  - **正規化後に重複するキーはエラー**。`--var @name=value`（`@` 付き）・`--var name`（`=` なし）・不正な名前（1a の命名規則違反）は**エラー**。
  - MCP のオブジェクトキーも**同じ正規化**を適用（`variables[name]` の素の参照では大小差で不一致になる）。
- **MCP**: `ksql_query` / `ksql_mutate` のスキーマ（`src/mcp/schemas.ts`）に `variables?: Record<string, string>`（値は文字列）を追加し、**両ツールのバッチ経路で `BatchExecuteOptions.variables` へ転送**（[tools.ts](../src/mcp/tools.ts)）。
- **CLI**: `--var name=value`（繰り返し可）を上記契約で解析し `Record<string,string>` に集約して渡す。
- **プラグイン**: **`DECLARE` 文自体は実行可能**（バッチ実行エンジンをバンドルするため）。ただし**外部注入の経路は持たない**ため、プラグインでは常に**既定値のみ**で評価される。同じ SQL が「プラグイン＝既定値／CLI・MCP＝注入で差し替え」と一貫して動作する。
- **注入値のバインド**: 値としてバインド（識別子化しない）。**SQL インジェクションは発生しない**（1a と同じ）。
- **秘密情報の注意**: `--var` の値は**プロセス一覧・シェル履歴に残り得る**ため、**秘密情報（トークン等）の注入手段ではない**旨をヘルプ/ドキュメントに明記する。

### 3.3 参照形（最小 2 文のバッチ）
- パラメータ化クエリの最小形は **`DECLARE @p = <既定値>; <@p を使う 1 文>`**（＝2 文のバッチ）。既存のバッチ経路で動く。単文中の `@ref` 拒否（[execute.ts:320](../src/execute.ts#L320)）はそのまま（`DECLARE` を伴わない単文の `@ref` は従来どおりエラー）。
- **純粋注入（`DECLARE` 無しの単一 `SELECT` に `@p` を注入）は本フェーズでは非対応**（`DECLARE` で明示宣言する方式に統一。SQL が自らのパラメータを自己文書化し、未宣言注入のタイポを防ぐ）。→ 将来検討。

## 4. バッチ静的解析と実行前検査（[High-2]）
- `DECLARE @name` は**変数定義**（`SET` と同じ扱いで定義順・再定義・未使用を検査）。使用は**定義より後**（前方参照エラー）。`collectVariableRefs` は汎用再帰のため既存のまま。
- **既定値式の検査**: 既定値に `@var`・サブクエリ・`LOGINUSER()` は不可（静的スカラー式のみ）。
- **未宣言注入は「実行ループの前」に一括検査する**（重要）。文へ到達した時点で検査すると、それ以前の `SELECT` / DML が既に実行され得る。順序:
  1. `parse`（`parseSqlBatch`）
  2. `analyze`（`analyzeBatch`）
  3. **`DECLARE_VARIABLE` の名前集合**を収集（正規化）＋注入キーを正規化
  4. **未宣言・重複・不正名を検査**（`options.variables` のキーが `DECLARE` 名集合に含まれるか。**`SET @x` は注入対象ではない**ため、解析結果の全変数一覧ではなく `DECLARE_VARIABLE` だけを抽出して照合）
  5. 検査を通ってから **API 呼び出し・文実行を開始**（[executeBatch:420](../src/execute.ts#L420) の既存の事前チェック群と同じ段で行う）

## 4.5 文種分類・EXPLAIN・dry-run
- **`DECLARE_VARIABLE` は read-only 文**（kintone に書き込まない）。`isReadOnlyType`（[dmlGuard.ts:30-45](../src/core/dmlGuard.ts#L30)）に追加し、`SET_VARIABLE` と同じ扱い（`--allow-dml` 不要・プラグインの DML 確認対象外）。CLI/MCP/プラグインの**許可文種判定**に反映。
- **バッチ EXPLAIN**: `DECLARE @name = <既定値>` を文種表示（`SET` の EXPLAIN と同様。実行時 1 回評価・値は非公開）。
- **`--dry-run`（EXPLAIN）**: **注入名の宣言照合までは行う**（未宣言注入はここでもエラー）。ただし**注入値や既定値の実値は計画・ログに表示しない**（値は結果メタデータ非公開）。

## 5. エラー方針
- 既定値の評価失敗・未宣言注入・再定義・前方参照は**実行前/評価時エラー**でバッチ停止（`SET` と同じ fail-fast 系）。
- 注入値は文字列。空文字注入は「空文字の値」として扱う（`NULL` ではない）。

## 6. 受入テスト観点
- **既定値**: `DECLARE @since = '2026-01-01'; SELECT ... >= @since` が注入なしで既定値で動く。
- **注入で上書き**: 同 SQL に `variables: { since: "2026-07-01" }`（MCP）／`--var since=2026-07-01`（CLI）で結果が変わる。**注入時は既定値式を評価しない**（`DECLARE @t = NOW()` に注入 → `NOW()` 未評価）。
- **最小 2 文**: `DECLARE @p = 'X'; SELECT ... WHERE k = @p` が成立。**`DECLARE` 単独（使用文なし）は拒否**。
- **ソフトキーワード（後方互換）**: `declare` を**フィールドコード**として使う既存 SQL（例 `SELECT declare FROM APP`）が引き続き動く。
- **未宣言注入は実行前にエラー**: `DECLARE @a=1; DELETE FROM APP ...; ` に `variables: { typo: ... }` → **DELETE が実行される前**にエラー（副作用なし）。`SET @x` の名前を注入 → エラー（SET は注入対象外）。
- **キー正規化**: `--var Since=...` が `@since` を上書き（小文字化）。`--var x=a=b` の値が `a=b`。`name=` が空文字。正規化後重複・`@name=`・`name`（=なし）はエラー。
- **複数 DECLARE**・**DECLARE と SET の併用**（別名）・**同名再定義エラー**。
- **前方参照/未定義参照**: 既存 1a と同じく実行前エラー。
- **既定値式の制約**: `DECLARE @x = (SELECT ...)`（サブクエリ）・`DECLARE @x = @y`（変数）・`DECLARE @x = LOGINUSER()` はパース/解析エラー。
- **文種分類**: `DECLARE` が read-only（`--allow-dml` 不要・プラグインの DML 確認対象外）。EXPLAIN に `DECLARE @name` が出るが値は非表示。`--dry-run` は未宣言注入を検出するが値を出さない。
- **型/比較・バインド安全性**: 注入値（文字列 `"100"`）が数値/文字列比較で期待どおり。`' OR 1=1` 等は値バインドで識別子・演算子にならない。
- **経路**: MCP `ksql_query` と `ksql_mutate` の両方で `variables` が転送される。
- **プラグイン**: `DECLARE` 入力が既定値のみで動作（注入経路なし）。
- **回帰**: 1a/1b（`SET`）・既存の単文 @ref 拒否が不変。

## 7. 実装メモ（Codex 向け）
- `types/ast.ts`: `DeclareStatement { type: "DECLARE_VARIABLE"; name; default: Exclude<ScalarExpr, ScalarSubquery> }` を `Statement` union に追加。
- `parser.ts`: **lexer 予約語にしない**。`parseStatement` の `case IDENT`（[:230-235](../src/parser/parser.ts#L230)）に `if (upper === "DECLARE") return this.parseDeclare()` を追加（`CREATE`/`DROP` と同方式）。既定値は `parseScalarExpr` 相当だが**サブクエリ・変数参照・`LOGINUSER()` を拒否**。
- `core/batch.ts`: `analyzeBatch` が `DECLARE` を変数定義として扱う（定義順・再定義・未使用・前方参照）。`SET` と同じ名前空間。
- `core/dmlGuard.ts`: `isReadOnlyType` に `DECLARE_VARIABLE` を追加。
- `execute.ts`:
  - `BatchExecuteOptions.variables?: Readonly<Record<string,string>>` を追加（汎用 `ExecuteOptions` ではない）。
  - **実行ループ前**（[executeBatch:420 の事前チェック群](../src/execute.ts#L420)）に**未宣言注入の一括検査**を追加: `analysis` から `DECLARE_VARIABLE` 名だけを集めて正規化し、`options.variables` の正規化キーが宣言集合に含まれるか照合（含まれない/重複/不正はエラー）。
  - `DECLARE_VARIABLE` の実行分岐（`SET` 同様・結果セットなし）: 注入キーがあれば注入値、なければ既定値式を評価（`NOW()` は 1 回）。**注入時は既定値式を評価しない**。
  - 注入キーの正規化（`@` 除去・小文字化）を CLI/MCP/実行で共通化。
- `mcp/schemas.ts` / `mcp/tools.ts`: `ksql_query`（[schemas.ts:41](../src/mcp/schemas.ts#L41)）・`ksql_mutate` に `variables?: Record<string,string>` を追加し、**両方のバッチ経路**（[tools.ts:511 付近](../src/mcp/tools.ts#L511)）で `BatchExecuteOptions.variables` へ転送。キー正規化を適用。
- `cli/index.ts`: `--var name=value`（繰り返し）を §3.2 の契約で解析（最初の `=` 分割・小文字化・重複/不正はエラー）。ヘルプに「秘密情報向けでない」注意。
- EXPLAIN: `buildBatchStatementPlan` に `DECLARE_VARIABLE` の行（値非表示）。`--dry-run` でも未宣言注入を検出。
- プラグイン: UI 変更なし。バッチエンジンをバンドルするため `DECLARE` 自体は動く（既定値のみ）。**`npm run build`（plugin 含む）** で `desktop.js` 再生成。
- ドキュメント: 言語リファレンス §25・レシピ集にパラメータ化例。

## 8. `:name`（保存クエリのパラメータ化）との関係
- **別機構として両立**（確定）。`:name` は MCP 保存クエリ（単文・カタログ）向けのバインド変数ドラフト、1c は**バッチ変数 `@var` の外部注入**。文脈が異なるため独立に設計する。
- 将来的な統一（1 つの外部パラメータ機構への収斂）は本フェーズの対象外。両者が併存しても名前空間（`@var` と `:name`）が異なるため衝突しない。

## 9. 効果・リスク
- **効果**: 定型 SQL のパラメータ化。MCP クライアント／CLI スクリプトから「文型・対象アプリは固定、値だけ差し替え」を安全に実行。
- **リスク**: **中**。パーサ（新キーワード）・実行（注入と既定値）・**外部インターフェイス（MCP スキーマ＋CLI フラグ）** に広がる。中核の変数解決は 1a/1b の実績を流用。
- **非対象**: プラグイン注入 UI・純粋注入（DECLARE 無し）・`NULL`・配列展開・`SELECT` 列変数・`:name` 統一。
