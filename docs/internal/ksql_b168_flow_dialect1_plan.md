# B168 Flow dialect 1 エンジン実装 — 調査結果と実装計画（R2）

- ステータス: 🚧 **裁定済み・実装中（Stage 1）**（2026-08-21・**オーナー裁定＝Q1〜Q9・Q11 すべて §5 の推奨案で確定・Q10 は [B169](ksql_b169_current_datetime_drift_issue.md)＝v3.67.0 で解消済み**。Q3 の対象関数は設計書の 4 つ（@NOW/@TODAY/@MONTH_START/@NEXT_MONTH_START）から開始）
- 指示書: [flow_dialect1_engine_task.md](../flow_dialect1_engine_task.md) ／ 発注元設計書: `ksql-flow/docs/ksql_flow_design_v2_4.md`（参照可・v2.4 と指示書は整合を確認済み）
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md)
- 本書の役割: 指示書 §4-1「調査フェーズ → 実装計画（変更ファイル・段階分け・リスク）を先に提示」の成果物。**§5 の要判断事項に回答が出るまでコード変更しない。**
- 改訂履歴: R1（2026-08-21 Claude 調査・起案）→ **R2（同日・codex read-only レビューの指摘＝重大 6・中 9・軽微 1 を検証のうえ反映**。§7 参照）

---

## 1. 調査結果の要点 — 指示書の前提への訂正 4 件

調査は 5 領域（パーサー/バッチ・時刻関数・UPSERT/一時テーブル・スキーマ/validate・公開 API/MCP/EXPLAIN）を実施した。**指示書の前提と実装の実態が食い違う点が 4 つある**。いずれも作業を止めるものではないが、仕様の読み替えが要る。

### 訂正 1: `SELECT ... INTO #t` という構文は存在しない

指示書 §2.5 は「既存の一時テーブル構文 `SELECT ... INTO #t` を正とする」と書くが、**この形はパーサーに無い**。既存の正は **`CREATE TEMP TABLE #x AS SELECT ...`**（`src/parser/parser.ts:611-628`・AST `CreateTempTableStatement`）である。つまり dialect 1 エイリアス (a) は**ほぼ実装済み**で、差分は「`#` なし裸名の受理」（`parseTempTableName` が `#` 必須・参照側 `parser.ts:2661-2668` も `#` 起点）だけ。裸名を受けるなら宣言名の集合を追跡して `FROM temp_monthly_summary` → `#temp_monthly_summary` に正規化する（パーサーは既に `this.cteNames` で同じ機構を持つ）。

### 訂正 2: `ON DUPLICATE` は現行でも複合キー対応・kintone updateKey API は不使用

- `parseOnDuplicate()` は N キーを受理し（`parser.ts:3772-3784`）、実行系は複合キーの合成索引を実際に組む（`execute.ts:6364-6421`）。**「複合キー禁止」は既存制限ではなく dialect 1 専用の新規検証**になる。
- UPSERT の実装は **read-then-write**（`GET records.json` で `$id` を引いて POST/PUT・多重ヒットは max `$id` 優先）。**kintone の updateKey API は一切使っていない**（`src/` に `updateKey` の出現ゼロ・`KintoneClient` にも該当メソッド無し）。よって「updateKey 制約」検証は API の技術的必然ではなく、**非 unique キーでの upsert 意味論の曖昧さ（どの行に当たるか不定）を防ぐ方針上のチェック**として実装する。

### 訂正 3: サブテーブル DML は現行エンジンの正式機能

サブテーブル向けの **`INSERT INTO APPn$tbl (...) VALUES ...`／`UPDATE APPn$tbl SET ...`／`DELETE FROM APPn$tbl WHERE ...`** は実装済み・文書化済みの第一級機能（`parser.ts:3706-3708, 3980-3982, 4443-4445`・MCP カタログにも 3 例）。**UPSERT／INSERT...SELECT／UPDATE...FROM はサブテーブルを現行でも明示拒否**しており、MERGE も同様に対象外でよい。設計書 §3.4 の「kintone API の仕様上サブテーブル行だけを単独で INSERT/UPDATE することはできない」という前提は、**エンジンが親レコード経由で既に解決している**。したがって「サブテーブル DML 禁止」は**エンジン全体には適用できず（絶対条件 1 違反）、dialect 1 スクリプト限定のゲート**になる。さらに既存エラーメッセージ `execute.ts:7017-7022` は逆に「サブテーブル DML 構文を使え」と**推奨**しており、dialect 1 では文言の出し分けが要る。

### 訂正 4: `bulkRequest` は未実装 — EXPLAIN 推定の前提が実装と異なる

書込チャンクは `chunk(records, 100)` のみ（`dmlToKintone.ts:112` ほか 5 箇所）。**`bulkRequest`（2,000 件/20 サブリクエスト）は `src/` のどこにも無い**（課題台帳でも M5 として ⏸ 保留中）。設計書 §5.1-4「エンジンは 100 件/リクエスト・2,000 件/bulkRequest で自動チャンク分割」は現状**後半が事実でない**。EXPLAIN の API 消費推定（H）は「エンジンが実際にやること」を数えるべきで、bulkRequest 前提の推定式は実装と乖離する。→ §5 Q5。

### その他の重要な実測

| 領域 | 実態 |
|---|---|
| マルチステートメント（A） | **既存**。トークンベース分割で文字列内 `;`/`--` は構造的に安全（`parser.ts:399-422`）。上限 `MAX_BATCH_STATEMENTS = 20`。 |
| `ASSERT`（C） | **既存だが文法が異なる**: `ASSERT <式> <比較> <式>`（メッセージ引数・WARN 無し）。スカラーサブクエリ比較は対応済み。dialect 1 の `ASSERT <条件>, 'msg'` は既存予約語上の文法拡張 → §5 Q1。**受入 5(d)「dialect 0 での ASSERT 使用 → エラー」は既存 ASSERT の後方互換（絶対条件 1）と矛盾**しており、「dialect 0 で **Flow 形式**（`, 'msg'`/`WARN`）のみエラー」と読み替える裁定が要る → Q1。 |
| ヘッダ（B） | コメントは字句解析で破棄され AST に位置情報も無い。`-- @ksql` は**生テキストの前段パス**で読む（前例: `normalizeSqlAppProfiles` の rewriteSegments）。 |
| `LAPP_` 論理アプリ（受入 2） | **パーサーは `APP+数字` しか受理しない**。`LAPP_` 解決は外側の profile/runtime 層（`normalizeSqlForTool`・`engine-library/logicalApps.ts`）。受入 2 のサンプルは `LAPP_受注` を含むため、**`parseScript` 単体で解析できる経路が現状無い** → 解決方針を Stage 1 で確定（§3）。 |
| 時刻関数（F） | **共有クロック無し**（各所が `new Date()` を独立に呼ぶ）。`CURRENT_DATE()`/`CURRENT_TIMESTAMP()` は**式が評価されるたび**に時計を読む（行指向の射影・WHERE では実質行ごと・評価位置により回数は異なる）＝深夜跨ぎで非決定になる潜在バグ。`@NOW()` 等の @ 付き時刻関数と `MONTH_START` 系は**未実装**（@ は変数専用シジル）。TZ 設定は皆無（ホストローカル依存）。WHERE 素通しの server-only 関数は 16 種で、**うち時刻依存は 14 種**（`TODAY`/`NOW` + 相対日付 12 種。残る `LOGINUSER`/`PRIMARY_ORGANIZATION` は時刻関数ではない）— これらは kintone サーバー評価であり as-of 固定不能 → §5 Q7。 |
| updateKey メタデータ（G） | `unique` は `GET app/form/fields.json` が返し、エンジンは `isUnique` として**取得・保持済み**（`formFieldInfo.ts:74`）。ただし消費は DESCRIBE 表示 1 箇所のみ。UPSERT キー経路は `getFieldTypeMap()`（isUnique を落とす）を使うため `getFieldsCached()` へ切替が要る（追加 API 呼び出しは不要・同一キャッシュ）。**REST 経路の正規化は `field.unique === true` で必ず boolean に潰す**ため、`undefined`（＝取得不能・警告格下げ）になるのは **BYO クライアントの `getFields()` が省略した場合のみ**。REST 応答で「未設定」と「unique:false」は区別できない（どちらも false）。 |
| 構造化 diagnostics（G） | **完全に新規**。severity・行/列・診断コード・warnings 配列のいずれも現存しない。位置は文字オフセットがメッセージ文字列内に埋め込まれるだけ（`ParseError`・`parser.ts:320-325`）。`ksql_validate` は**ネットワーク 0** の構文検証のみで warnings キーも無い。 |
| EXPLAIN 推定（H） | 数値推定はほぼ皆無（再帰 CTE の記号式 1 行のみ）。読取式の材料は `fetchAll.ts:246-250`（500 件/頁・offset→`$id` シーク・`KINTONE_MAX_OFFSET=10,000`）に揃っている。**総リクエスト数にはソース別 GET・メタデータ取得・UPSERT の事前 GET（重複判定）・UPDATE/DELETE の対象取得も入る**ため、推定は分解形にする（§3 Stage 5）。 |
| 公開 API（I） | `@rex0220/kintone-sql-tools/engine` が既存（`runQuery`/`runBatch`/`explainQuery`/`createReadonlyKintoneClient`/`KsqlEngineError`/`version`）だが **read-only 専用**（2 層のガードで DML 遮断）・**文単位実行は不可**（`runBatch` は all-or-nothing）。文単位実行の天然の継ぎ目は非公開の `executeBatchStatement`（`execute.ts:1703-1712`）。その引数は **stmt・info（解析結果）・client・options・cacheContext・tempTables・variables・relativeDateVariables の 8 つ**で、metrics 集計・deadline・cursor cleanup・キャッシュ scope の解放は**呼び出し側 `executeBatch` が外側で管理**している — 公開化はこの生成/破棄まで含めた設計が要る。→ §5 Q6。 |
| MCP（J） | `ksql_validate` は parse+analyzeBatch のみ。応答は単文/バッチで明示的な形状を持ち（単文はトップレベルへスカラー展開）、失敗は `{ok:false, error:{code,message}}` を throw 経由で返す。`ksql_docs` はビルド時埋め込み（`docsResources.ts`）で節キーは文書から自動生成 — dialect 1 節の追加は言語リファレンス/レシピへの追記で機械的に載る。 |

---

## 2. 設計方針

1. **dialect ゲートは `ParserCapabilities` の拡張**。既存の `{ import?: boolean }` に `dialect1?: boolean` を足す（IMPORT ゲートが正確な前例・`parser.ts:458-463`）。ヘッダ前段パスが `dialect: 1` を検出したときだけ有効化。dialect 0 で dialect 1 構文が出たら「`-- @ksql dialect: 1` の宣言が必要」を含む ParseError。
2. **エイリアスはパース時脱糖で AST 痕跡ゼロ**。前例に完全準拠: `IF→CASE_WHEN`（`parser.ts:2315`）・`BETWEEN` 展開（`:2916`、`type ExpandedBetween` の意図注記スタイル）・関数名別名（`SUBSTR→SUBSTRING`）。`MERGE` は `UPSERT_SELECT` を発行し、`parseCheckGroups()`/`parseDmlControlSuffix()` を流用して CHECK/CONTROL も無償で対応。実行系・EXPLAIN・dmlGuard 等の下流は**一切無変更**。
3. **予約語を増やさない**。`MERGE`/`USING`/`KEY`/`EXIT`/`SUCCESS`/`WARN`/`TEMP` はすべてソフトキーワード。`KEY` は `tryParseImplicitAlias`（`parser.ts:2712-2729`）に**別名として飲み込まれる実衝突**があるため、既存の `VALIDATE ONLY`/`CHECK WHEN` と同じ「`KEY` + `(` lookahead で別名にしない」ガードを追加（`ROLLUP`/`CUBE` の `(` lookahead 慣行どおり）。**`KEY` を KEYWORDS に足すのは禁止**（`key` というフィールドコードの実例が MCP カタログ内にある）。
4. **診断は新設の `Diagnostic` 型に集約**し、既存の throw 経路は不変。`{ severity: "error"|"warning"; code: DiagnosticCode; message: string; line: number; column: number; statementIndex?: number }`。行・列は「生テキスト + 文字オフセット」から導出（トークン `pos` は既にある）。既存 API は従来どおり throw し、新設の `parseScript`/`validateScript` だけが diagnostics 配列を**返す**（収集モード）。**`DiagnosticCode` は一覧を定義し、`/engine` の公開契約である `KsqlEngineError.code` 6 値（`PARSE_ERROR` ほか）と衝突しない命名規約**（例: `KSQL1xxx` 系の独立番号体系）とする。parse/validate/explain/execute それぞれの throw/return 境界も型で明示する。
5. **as-of は「単一の基準時刻を文脈で引き回す」**。`ExecutionContext`（Stage 1 で内部導入・§3）に `asOf: Date`（省略時は実行開始時に 1 回だけ `new Date()`）と `timezone: string`（省略時ホスト TZ）を持たせ、JS 評価の時刻関数 3 経路（`evalWhere.ts:465`・`evalFunc.ts:467/474`）をそこから読むよう配線する。**固定クロックの適用は dialect 1 実行文脈に限定**し、dialect 0 の既存挙動（`CURRENT_*` の評価ごとドリフト）は**変えない**（絶対条件 1。dialect 0 側の潜在バグ修正は別チケットで別途判断 → §5 Q10）。TZ 付き暦日導出は `Intl.DateTimeFormat`（Node の full-icu 前提・プラグイン面はブラウザ ICU）で新設。
6. **内部 `ExecutionContext` を Stage 1 で先行導入し、公開は Stage 6 でアダプタのみ**。`executeBatchStatement` の 8 引数（stmt・info・client・options・cacheContext・tempTables・variables・relativeDateVariables）に clock を加えた**正確な**内部型を定義し、`executeBatch` は文脈オブジェクトの生成・破棄（metrics 集計・deadline・cursor cleanup・キャッシュ scope 解放）を担う形に整理（挙動不変リファクタ・既存テストで担保）。これにより **Stage 2 以降の新機能が最初から実経路（`executeBatch`）で動き、テストも実経路で書ける**。

---

## 3. 段階分けと変更ファイル

指示書 §4-2 の順序（A/B → C/D → E → F → G/H → I/J）に従う。各段でテストを足してから次へ。**Stage 1 で共通実行入口（ヘッダ前段パス → capabilities 付きパース → `executeBatch`）を内部接続する**ため、Stage 2 以降の機能は各段の時点で実経路から到達でき、受入テストを実 SQL で書ける（公開 API・MCP への露出だけが Stage 6）。

### Stage 1 — 解析基盤（A/B）: ヘッダ前段パス・Diagnostic 型・内部 ExecutionContext・parseScript 骨格

| 変更 | ファイル |
|---|---|
| `-- @ksql` ヘッダ解析（生テキスト前段パス）。**値の制約検証を含む**: `timeout` は正の整数（非整数/0 以下はエラー診断）・`dialect` は 0/1 のみ（他はエラー）・`name`/`depends_on` の空要素と重複キーの扱いを定義・未知キーは warning | **新規** `src/core/scriptHeader.ts` |
| `Diagnostic`/`DiagnosticCode` 型・文字オフセット→行/列変換・収集ユーティリティ・`KsqlEngineError.code` と非衝突の命名規約 | **新規** `src/core/diagnostics.ts` |
| `ParserCapabilities.dialect1` 追加・文ごとのトークン範囲（開始/終了 pos）の記録 | `src/parser/parser.ts` |
| **内部 `ExecutionContext` 型**（stmt info・options・client・cacheContext・tempTables・variables・relativeDateVariables・clock）と `executeBatch` の文脈生成/破棄の整理（挙動不変） | `src/execute.ts` |
| `parseScript(source, opts)` → `{ meta, statements, diagnostics }`（内部版・公開は Stage 6）。**`LAPP_` の扱いを確定**（§5 Q11 の裁定に従う: 推奨は既存 `normalizeSqlForTool` 系の事前正規化を `parseScript` に統合し、AppResolver を opts で受ける） | **新規** `src/core/script.ts`（`core/sql.ts` の隣） |
| ヘッダ解析済みスクリプトを `executeBatch` へ渡す内部経路（dialect capabilities の貫通） | `src/execute.ts`・`src/core/sql.ts` |
| テスト: 文字列内 `;`/`--`/`@ksql` 誤解釈なし（受入 6）・ヘッダ値制約・dialect 既定 0・受入 2 サンプル（LAPP 込み）の parseScript 解析 | **新規** `src/__tests__/b168ScriptHeader.test.ts` ほか |

リスク: `@profile`/`LAPP_` 正規化と行/列導出の相互作用。ヘッダ・行列導出は**正規化前の原文**基準に統一して回避（既存 `restoreSqlContextError` の前例）。

### Stage 2 — 新文（C/D）: ASSERT 拡張・EXIT SUCCESS IF

| 変更 | ファイル |
|---|---|
| `ASSERT <条件>, '<msg>'`・`ASSERT WARN`（dialect 1 ゲート・§5 Q1 の裁定に従う）| `src/parser/parser.ts`（`parseAssert` 拡張）・`src/types/ast.ts`（`AssertStatement` に `message?`, `warn?` を追加＝純加法） |
| `EXIT SUCCESS IF <条件>, '<msg>'` 新文 | `ast.ts`（`ExitStatement` 追加）・`parser.ts`（IDENT ディスパッチに `EXIT`）・`src/core/dmlGuard.ts`・`src/core/batch.ts`（analysis）・`src/core/klikeValidation.ts` 等の網羅 switch |
| 実行: **Flow 用の結果種別（`ASSERT_VIOLATION`/`ASSERT_WARNING`/`ASSERT_PASSED`/`EXIT_NO_DATA`）は新設の `StatementResult` union（Stage 6 で公開する Flow 面の型）として定義**し、既存の二層契約（`BatchStatementResult.type/status/result` と `ExecuteResult`・ASSERT 失敗＝`AssertError` で error status・batch envelope・MCP 変換）は**不変**。dialect 1 実行時のみ内部でマークし、ASSERT WARN は続行・EXIT は以降 skip（`skippedReason: "exit"`）で**正常終了扱い** | `src/execute.ts`（`executeAssert` 拡張・EXIT ハンドラ・バッチループの skip 理由） |
| EXPLAIN の文表示 | `src/execute.ts`（batch explain builder） |

リスク: `Statement` union への型追加は網羅 switch を踏むため TypeScript が漏れを検出する（低）。既存 ASSERT の失敗メッセージ・`code` は不変。

### Stage 3 — 構文エイリアス（E）

| 変更 | ファイル |
|---|---|
| `CREATE TEMP TABLE 裸名 AS`（dialect 1）: 宣言名追跡 + 参照の `#` 正規化 | `src/parser/parser.ts`（`parseCreateTempTable`・`parseTableRef`） |
| `UPSERT ... KEY (k)` ≡ `ON DUPLICATE (k)`: `parseOnDuplicate` に代替受理 + `tryParseImplicitAlias` の `KEY (` ガード | `src/parser/parser.ts` |
| `MERGE INTO ... USING ... ON ... WHEN ...` → `UpsertSelectStatement` 発行（`parseMergeAsUpsert`）。ON は単一等値のみ・両句の式一致必須（AST が強制）・片側省略は明示エラー（§5 Q2）。サブテーブルは既存 UPSERT 同様に拒否 | `src/parser/parser.ts`（IDENT ディスパッチ + 新メソッド）|
| 同一内部表現テスト（受入 3）: UPSERT 版と MERGE 版の AST 深い等価 | **新規** `src/parser/__tests__/b168MergeAlias.test.ts` ほか |

リスク: `KEY` ガードは共有関数 1 箇所の修正で全 call site に効くが、列別名経路（`parseAliasName` は任意キーワードを別名に取る）に同種の露出があり、テストで固定する。

### Stage 4 — as-of 固定評価（F）

| 変更 | ファイル |
|---|---|
| `ExecutionContext.clock`（asOf + timezone・Stage 1 で導入済みの枠に実装を入れる）。**クロックの文単位固定と評価器への配線は [B169](ksql_b169_current_datetime_drift_issue.md)（先行実施）で完了済みの前提**で、本段は「注入された asOf でスクリプト全体の基準時刻を上書きする」層を足すだけ。省略時は従来どおり実行開始時刻 | `src/execute.ts` |
| `resolveKintoneFunc`（SET/DECLARE の NOW/TODAY）を同じクロックへ接続（B169 の配線に相乗り） | `src/engine/evalWhere.ts:462-481` |
| `@NOW()` / `@TODAY()` / `@MONTH_START()` / `@NEXT_MONTH_START()`（dialect 1・§5 Q3 の裁定に従う）: lexer は既に `@NOW` を VARIABLE トークン化するため「VARIABLE + `(`」をパーサーで時刻関数呼び出しに解釈（dialect 1 のみ）| `src/parser/parser.ts`・`ast.ts`・評価器 |
| TZ 付き暦日導出（`Intl.DateTimeFormat`）・DATETIME 比較値の UTC 変換 | **新規** `src/core/asOfClock.ts` |
| as-of テスト（受入 4）: 複数文で全時刻関数が注入値から導出・一致（Stage 1 の実経路接続により `executeBatch` 経由で検証） | **新規** `src/__tests__/b168AsOf.test.ts` |

リスク: **server-only 時刻依存 14 種（`TODAY()` 等の WHERE 素通し）は kintone サーバー評価で as-of 固定できない**（§5 Q7）。

### Stage 5 — validate / EXPLAIN 拡張（G/H）

| 変更 | ファイル |
|---|---|
| **内部 `validateScriptCore(statements, schema, opts)` をこの段で完成**させる（Stage 6 は export と MCP 変換のみ）。`opts.strict?: boolean` を定義 | **新規** `src/core/dialect1Validation.ts` |
| dialect ゲート検証（dialect 0 で dialect 1 構文 → エラー）| Stage 1-3 のパーサーゲートで実現済み・診断コード付与のみ |
| 複合キー禁止（dialect 1 の KEY/ON 句・回避策「連結キーフィールド」をメッセージに）・サブテーブル DML 禁止（dialect 1）・素の INSERT 警告（`strict` でエラー化）| `dialect1Validation.ts`（`validateStatementStatic` 方式で全面に効かせる） |
| updateKey 検証は **3 条件を別コードで診断**: ①キー数 = 1、②`fieldType ∈ {SINGLE_LINE_TEXT, NUMBER}`、③`isUnique === true`（`undefined` のみ警告格下げ・`false` はエラー）。schema-aware のため `validateScriptCore` の schema 引数で実施し、実行前 prepare（`assertWritableTopLevelDmlFields` 近傍・`getFieldsCached()` へ切替）でも同一診断を出す | `dialect1Validation.ts`・`src/execute.ts` |
| EXPLAIN 推定 API 消費は**分解形の構造化見積り**: ソース別 GET（`ceil(min(件数, maxRecords)/500)`）＋メタデータ取得＋UPSERT 事前 GET（重複判定・`ceil(N/チャンク)`）＋UPDATE/DELETE の対象取得＋書込 `ceil(N/100)`（現実装どおり bulkRequest 無し・§5 Q5）。件数不明の項は「不明（上限 N と仮定）」と明示し数字を捏造しない。参考値としてサブリクエスト数併記 | `src/execute.ts`（explain builders）・構造化面は `ExplainFetchPlan` 純加法 |
| validate テスト（受入 5 の a〜e。(d) は Q1 の裁定した解釈で）| **新規** `src/__tests__/b168Dialect1Validation.test.ts` ほか |

### Stage 6 — 公式 API・MCP（I/J）

| 変更 | ファイル |
|---|---|
| `parseScript` / `validateScript` / `explainScript` / `executeStatement(stmt, ctx)` の**公開アダプタ**（実体は Stage 1/5 の内部実装。配置は §5 Q6 の裁定に従う: 案 A `/flow` サブパス新設）。context の生成/破棄 API（`createExecutionContext`/`disposeExecutionContext` 相当: キャッシュ scope 解放・cursor cleanup を含む）と並行利用可否を型と文書で明示 | **新規** `src/flow-library/`（`engine-library` の構成を踏襲: index/publicTypes/build/bundle-guard/smoke）・`package.json` exports・`build-flow.mjs` |
| MCP: `ksql_validate`/`ksql_explain` が dialect 1 スクリプト（ヘッダ付き複数文）を受理。**structured diagnostics は成功応答（`ok:true`）への純加法**とし、失敗時の `{ok:false, error:{code,message}}` 挙動・単文応答のトップレベルスカラー展開は**不変**（回帰テストで固定）。`strict` に対応する input オプションを純加法で追加 | `src/mcp/tools.ts`・`src/mcp/schemas.ts` |
| `ksql_docs` に dialect 1 節（ASSERT/EXIT/エイリアス/as-of/ヘッダ・構文例を豊富に・「異常 vs 正常な早期終了」の書き分け明記）| `docs/ksql_language_reference.md` へ節追加（節キーは自動生成で載る）・`docs/ksql_batch_recipes.md` に Flow ジョブ例 |
| README: 公開 API・**エンジンバージョン × dialect 対応表**・semver 明記・変更履歴（受入 8）| `README.md`・`docs/ksql_engine_library.md` 系の新文書 |
| MCP 受入（受入 7）: サンプルジョブを `ksql_validate` に渡し構造化 diagnostics が返る | **新規** MCP 統合テスト |

### 横断: 受入基準との対応

受入 1（既存テスト全件パス）= 各段で `npm test`（約 5,000 件）。受入 2（サンプルジョブが parseScript で解析・validateScript 診断ゼロ）= **LAPP 解決込みで Stage 1 から解析可・診断ゼロは Stage 5 の validateScriptCore 完成時**に mock スキーマ（unique 付き `顧客コード`・SINGLE_LINE_TEXT）で検証。受入 3〜7 は各段の表に記載。受入 8 = Stage 6。

---

## 4. リスク一覧

| リスク | 大きさ | 対処 |
|---|---|---|
| `Statement` union 追加が踏む網羅 switch の漏れ | 低 | TypeScript の網羅性検査 + 既存 5,000 件テスト |
| `KEY` lookahead が既存クエリの別名解釈を変える | 低〜中 | ガード条件を「IDENT `KEY` + 直後 `(`」に限定。直後に `(` が来る形は現行では構文エラーのため実害はないはずだが、テストで固定 |
| `executeBatch` の文脈整理（Stage 1 リファクタ）で挙動が変わる | 中 | 挙動不変が目的のリファクタ。既存バッチ系テスト全通過を各コミットで確認 |
| 診断の行/列と `@profile`/`LAPP_` 正規化の位置ずれ | 中 | ヘッダ・行列導出は正規化**前**の原文基準に統一 |
| 公開面の拡大（semver 契約の増加） | 中 | `/engine` は不変のまま新サブパスに隔離（Q6 案 A）。bundle-guard を流用して混入を fail-closed。`DiagnosticCode` は `KsqlEngineError.code` と独立の番号体系 |
| パーサー単一ファイル（4,700 行超）の肥大 | 低 | MERGE/EXIT は既存メソッド分割慣行内で追加。無関係リファクタはしない（指示書 §4-3） |
| MCP 応答へのフィールド追加が既存クライアントを壊す | 低〜中 | 成功応答への純加法のみ・失敗時挙動と単文トップレベル項目は回帰テストで固定。`ValidationResult` を WeakMap で使い回す 2 箇所（`validationContexts`/`applyMutationValidations`）に注意 |

---

## 5. 要判断事項（推奨案つき）

> **✅ 裁定（2026-08-21 オーナー）: Q1〜Q9・Q11 はすべて各項の推奨案で確定**（Q10 は B169 として分離・v3.67.0 で解消済み）。以下の各「推奨」が決定事項である。Q3 の対象関数は設計書の 4 つから開始。Q5 の指示書 §2.8 改訂は同日実施（証跡は指示書側の追記）。

**Q1. ASSERT の文法統合と受入 5(d) の解釈** — 既存 `ASSERT <式> <比較> <式>` に対し、dialect 1 は末尾 `, '<msg>'` と `WARN` 修飾を**純加法**で足す（dialect 1 ゲート内のみ受理）。条件部の文法は既存 ASSERT のまま（スカラーサブクエリ比較は既対応・オペランド制限も同一と解釈）。**あわせて受入 5(d)「dialect 0 での ASSERT 使用 → エラー」は既存 ASSERT（dialect 0 の正式機能）と矛盾するため、「dialect 0 で Flow 形式（`, 'msg'`/`WARN`）を使ったらエラー・既存形式は不変」と読み替えることの承認を求める**（既存 ASSERT の成功テストを受入に追加）。**推奨: この加法拡張＋読み替えで確定**。

**Q2. MERGE の片側省略**（指示書 §2.5 が調査を指示）— UPSERT の AST に「更新のみ/挿入のみ」の表現が**無い**（常に両方実行）。近い既存型は `UPDATE ... FROM`（更新のみ）と `INSERT ... SELECT`（挿入のみ）だが、別の文型のため「同一内部表現・AST 痕跡ゼロ」が崩れる。**推奨: 初期実装は明示エラー**「WHEN MATCHED / WHEN NOT MATCHED の両句が必要です（更新のみは UPDATE ... FROM、挿入のみは INSERT ... SELECT を使用）」— 代替構文の案内付き。

**Q3. `@NOW()` 系の構文** — `@` は既存では変数専用シジルで、`@NOW()` は未実装。lexer は `@NOW` を VARIABLE トークンにするため「VARIABLE + `(`」で dialect 1 の as-of 時刻関数と解釈でき、既存変数と衝突しない。`@MONTH_START()`/`@NEXT_MONTH_START()` は新規実装（TZ 付き月初導出）。**推奨: 設計書どおり @ 付きで実装**（bare の `NOW()`/`TODAY()` は kintone 押し下げ用として温存し、「@ 付き＝as-of 固定・エンジン評価」「bare＝kintone サーバー評価」の対比を文書化）。対象関数は設計書の 4 つから始めるか、週初・年初も初期から入れるか指定を仰ぎたい。

**Q4. updateKey unique 検証の置き場所** — `ksql_validate`（MCP）は現在**ネットワーク 0**が契約。unique 検証はメタデータ要。**推奨: 静的に済む検証（複合キー・サブテーブル DML・dialect ゲート・素の INSERT 警告）は `ksql_validate` に載せ、schema-aware 検証（キー型・unique）は `validateScriptCore(statements, schema)`（公開 `validateScript` とランナーの `ksql-flow validate` が使用）と実行前 prepare で行う**。ksql_validate の「ネットワーク 0」契約を破ってでも opt-in メタデータ検証を入れるかはオーナー判断。

**Q5. EXPLAIN 書込推定の単位** — bulkRequest は未実装（M5 ⏸ 保留）。**推奨: 現実装どおり `ceil(N/100)` の HTTP リクエスト数で推定**し、「bulkRequest 導入時は推定式も更新」と実装ノートに記す。設計書 §5.1-4/§11 の bulkRequest 前提は現状のエンジンと乖離している旨を**発注元（ksql-flow）へ正式に申し送り、指示書 §2.8 の推定前提（2,000 件/bulkRequest）を改訂した証跡を残す**（bulkRequest 実装を B168 スコープに入れるなら別途起票・工数追加）。

**Q6. 文単位実行 API の公開面** — 既存 `/engine` は read-only を 2 層ガードで保証しており、ランナーには DML 実行が要る。案 A: **新サブパス `@rex0220/kintone-sql-tools/flow` を新設**（writable クライアント + `executeStatement`/`parseScript`/`validateScript`/`explainScript`。`/engine` の read-only 保証は完全不変）。案 B: `/engine` に opt-in で writable を追加（既存契約の変質・bundle-guard の書き換え要）。**推奨: 案 A**。ただし公開は関数 4 本だけでは済まず、**`ExecutionContext` の生成/破棄（キャッシュ scope 解放・cursor cleanup・metrics 集計・deadline）・文番号と解析情報の受け渡し・writable クライアントの能力要件・並行利用可否**までが公開契約に入る — この範囲の承認も求める。

**Q7. 押し下げ時刻関数と as-of の不整合** — `WHERE 受注日 >= @MONTH_START()` は as-of 固定できるが、`WHERE 受注日 = TODAY()`（bare）は kintone サーバーが評価するため **as-of を注入しても固定されない**。**推奨: dialect 1 スクリプトで bare の server-only 時刻依存関数（14 種＝`TODAY`/`NOW`+相対日付 12）を使ったら validate warning**（「as-of の対象外・再現性が要るなら @ 付きへ」）。`LOGINUSER()`/`PRIMARY_ORGANIZATION()` は時刻関数ではないため対象外（再現性診断が要るなら別扱い）。エラーにはしない（押し下げの性能価値は残す）。

**Q8. `MAX_BATCH_STATEMENTS = 20`** — Flow ジョブは長くなり得るが、指示書は上限変更を要求していない。選択肢: (a) **20 のまま維持**（超えたら分割を案内）／(b) dialect 1 のみ固定引き上げ（例 50）／(c) `parseScript`/実行オプション化（解析上限と実行上限を分離）。**推奨: まず (a) で着手し、Flow の実ジョブが 20 文を超えた実例が出たら (b) を裁定**（DoS 面・MCP 入力上限との整合は据え置きが最も安全）。

**Q9. リリース戦略** — 6 段を 1 リリースにまとめるか、段ごとに小刻みに出すか。**推奨: Stage 1-3 で 1 回（解析系・後方互換のみ）、Stage 4-5 で 1 回、Stage 6 で 1 回の計 3 リリース**。Stage 1 で実行入口が内部接続されるため各回とも実経路テスト済みの状態で出せる。公開面（/flow・MCP 応答拡張）が載るのは最終回のみ。

**Q10. `CURRENT_DATE()`/`CURRENT_TIMESTAMP()` の評価ごとドリフトの扱い — ✅ 裁定済み（2026-08-21 オーナー）**: **[B169](ksql_b169_current_datetime_drift_issue.md) として分離起票し、B168 Stage 4 より先に対応する**（案 B の先行実施）。文単位固定を dialect 0 含む全経路で「正しさの修正」として独立リリースし、B168 Stage 4 は固定済みクロックへの as-of 注入だけになる — dialect 0/1 でクロック意味論が分岐せず、絶対条件 1 の論点自体が消える。文書契約との矛盾なし（言語リファレンスは「JS で取得」としか約束していない・実測確認済み）。

**Q11.（R2 追加）受入 2 の `LAPP_` を `parseScript` でどう扱うか** — パーサーは `APP+数字` のみ受理で、`LAPP_` 解決は現在 profile/runtime 層にある。選択肢: (a) **`parseScript(source, { apps?: AppResolver })` が既存の正規化（`normalizeSqlForTool` 系）を内包**し、resolver 未指定時は未解決 LAPP をエラー診断にする／(b) AST に「未解決論理アプリ参照」を表現できるノードを足し、解決は後段へ遅延（AST 変更が大きい）。**推奨: (a)**。既存機構の再利用で足り、ランナー（config の `apps` マップを持つ）とも噛み合う。

---

## 6. 発注元（ksql-flow）への申し送り事項

1. 設計書 §3.7「既存構文 `SELECT ... INTO #t`」は誤り。既存の正は `CREATE TEMP TABLE #x AS ...`（dialect 1 の書き味には影響なし・対応表の右列を訂正されたい）。
2. 設計書 §5.1-4 の「エンジンが bulkRequest で自動チャンク」は現状未実装（100 件/リクエストのみ）。原子性の記述（1 bulkRequest = 2,000 件単位）とチェックポイント設計は現実装では 100 件単位になる。**推定式の前提変更は指示書 §2.8 側にも反映し、改訂の証跡を残す**（Q5）。
3. サブテーブル DML はエンジンでは可能（dialect 1 でのみ禁止する実装になる）。将来「親レコード経由のテーブル一括更新構文」を検討する際は既存実装が流用できる。
4. UPSERT は kintone updateKey API 不使用（read-then-write）。unique でないキーでも動作はするが多重ヒット時は max `$id` 優先 — dialect 1 の unique 必須化はこの曖昧さを塞ぐ意味を持つ。
5. 受入 5(d)「dialect 0 での ASSERT 使用 → エラー」は既存 ASSERT（dialect 0 の正式機能）と両立しない。「Flow 形式のみエラー」への読み替えを提案中（Q1）。

---

## 7. レビュー履歴

- **R1 → R2（2026-08-21・codex read-only レビュー）**: 指摘＝重大 6・中 9・軽微 1。全件を検証し反映した。主な変更: ①受入 2 の `LAPP_` 解析経路の欠落 → Q11 新設＋Stage 1 に組み込み ②updateKey 検証にフィールド型条件（SINGLE_LINE_TEXT/NUMBER）を追加し 3 条件別コード化 ③EXPLAIN 推定を分解形（ソース別 GET・メタデータ・UPSERT 事前 GET・書込）に改訂 ④内部 `ExecutionContext` を Stage 1 へ前倒しし引数列挙を実装実態（8 引数＋外側管理の生成/破棄）に訂正 ⑤`validateScriptCore` を Stage 5 で完成（Stage 6 は公開のみ）に変更 ⑥Q10 を選択肢 A/B/C 化し dialect 0 不変（絶対条件 1）を既定に ⑦Q1 に受入 5(d) の矛盾の裁定を統合 ⑧Q7 の対象を時刻依存 14 種に限定 ⑨Q8 に「20 維持」を第一候補として明示 ⑩ヘッダ値制約検証・`strict` の公開経路・診断コードと `KsqlEngineError.code` の関係・MCP 応答の載せ場所と回帰テストを各段へ追記 ⑪事実表現の訂正（サブテーブル DML の構文表記・isUnique undefined の条件・「行ごと」→「式評価ごと」・16 種→時刻依存 14 種）。
