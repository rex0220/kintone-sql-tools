# B179 CSV export（名前付きシンク・engine 層 serializer・`/flow` 公開 API）— 段階 2

- 状態: ✅ **v3.77.0 でリリース済み（2026-09-04）**＝3 段 PR 完了・kSQL-Flow ローカル結合 PASS・codex 最終チェック反映済み（§6・§7）。仕様＝[R2](ksql_b179_csv_export_sink_spec_r2.md)（codex 起案・R1 と 2 つのレビューを反映・末尾に Claude レビュー節）。[R1](ksql_b179_csv_export_sink_spec_r1.md) は経緯として保存。要決定 A/B/C はオーナー裁定済み。CP932 library は実測で `encoding-japanese` に確定（231 KB・両 library とも表現不能文字を `?` 置換するため round-trip 検査必須）。flownet の消費側レビュー後、serializer → /flow → CLI の 3 段 PR で実装
- 種別: 機能（engine 層に CSV serializer を 1 回だけ実装し、CLI と `/flow` から使う。公開 API は純加法）
- 優先: **中**（kSQL-Flow Contract v1.1 の `features.resultCsv` / `output_files[]` の前提）
- 版: **minor（v3.77.0 想定）**。既定動作は変えない
- 上流要求（正）: `C:\Users\rex02\Projects\ksql-flownet\docs\internal\csv-io-implementation-plan.md` §4.1〜§4.2
- 関連: [B177](flow_import_source_api_spec.md)（named IMPORT source・bytes の向きの対称形）／[B178](ksql_b178_flow_import_source_materialized_receipt_issue.md)（receipt の思想）

## 1. 要求の要点（上流 §4.1〜4.2 から）

1. **ヘッダ解決 C-1(b) getFields 方式**: 1:1 の field 列は正式 field code、式・計算列・明示 alias は現行 result 列名。曖昧・重複 header は export 前にエラー。(a) AST 方式は切替条件付きで不採用。
2. **値表現 6 項目（cli-kintone 互換）**: 複数値＝セル内 LF 連結＋RFC 4180 quoting／空・NULL＝空文字（round-trip で区別不能と明記）／数値＝生値・追加丸めなし／日時＝ISO・UTC 既定＋timezone は明示 option／UTF-8 既定・BOM なし＋Shift_JIS option・表現不能文字は fail-closed（完成 file を残さない）。
3. **名前付きシンク**: option `<sink>=<path>` が temp table `#<sink>` に対応。単文 SELECT だけ名前省略可。複文で名前なし・不存在 sink・同名重複・DML 指定は実行前エラー。「最後の SELECT」は選ばない。
4. **serialize 条件**: SQL 全文成功後のみ。同一 directory の一時 file → flush/fsync → close → atomic rename（OS 差は platform 別 contract test）。全件メモリ・既存上限維持・ストリーミング対象外。
5. **serializer は engine 層に 1 回**（CLI/MCP/plugin/flow が方言を持たない）。`/flow` 公開 API として sink 供給経路（bytes の向きは B177 と対称・engine は path を持たない）。
6. Execution Result 連携用に rows/bytes/sha256 相当が flow 側で取れる形（B178 receipt と同じ思想。output 側の通知 API の要否・形は engine 側の設計判断）。
7. サブテーブルは仮想テーブル（`APP$明細`）経由の行出力のみ。cli-kintone の `*` 形式は再現しない。添付ファイル対象外。

## 2. 実コードで測った事実（2026-09-04・main eaeef36＝v3.76.0）

**仕様起案・実装ではここを再導出せずそのまま使う。**

### 2.1 result 列名（header の元）

`/flow` 公開 API＋mock client で実測した result 列名と値:

| SQL | `columns` | 備考 |
|---|---|---|
| `SELECT code, Code2, … FROM APP1` | `["code","Code2",…]` | **直接 field 参照の列名＝field code そのもの**（大小文字も SQL の綴り＝getFields の正式 code と一致） |
| `SELECT CODE FROM APP1`（field は `code`） | error `ArgumentError: unknown field code(s): CODE (APP1)` | **field code の照合は case-sensitive**＝「ASCII field code を正式 code へ戻す」処理は engine に存在せず、存在する列名はすでに正式 code |
| `SELECT a.code, b.code FROM APP1 a INNER JOIN APP2 b …` | `["a.code","b.code"]` | 修飾名で衝突しない |
| `SELECT code AS C, UPPER(code)` | `["c","UPPER(code)"]` | **明示 alias は小文字化される**（既存挙動）。無 alias の式は式テキスト |
| `CREATE TEMP TABLE #t AS SELECT code, num*2 AS dbl; SELECT * FROM #t` | `["code","dbl"]` | temp table は SELECT の出力名を保持。名前は `"#"` を含む（`CreateTempTableStatement.name`＝`"#t"`・`src/types/ast.ts:98-102`） |

→ C-1(b) の「1:1 field 列＝正式 field code」は kSQL では**列名そのもの**で満たされる。header 決定に getFields は不要で、必要なのは **重複 header の検出**（例 `SELECT code, code`）と **出力不能な列型の拒否**（§2.2）だけ。列の出自は `MaterializedColumnMeta`（`src/execute.ts:441-450`: `displayName` / `fieldType` / `semantics` / `publicSourceApp`＝直接参照列の物理アプリ）で判別できる。`/engine` は同じ meta を `QueryColumn`（`src/engine-library/publicTypes.ts:152-162`）として既に公開している。

### 2.2 result の値の形（`ProcessRow` は文字列 map）

同じ実測で 1 行の値:

| field 型 | 値（文字列） | export 時の扱い（要求 §4.2.1 との対応） |
|---|---|---|
| SINGLE_LINE_TEXT / NUMBER | `"A"` / `"12.50"` | 生値そのまま（数値は kintone の文字列） |
| CHECK_BOX / MULTI_SELECT 等 | `"[\"x\",\"y\"]"`（**JSON 配列の文字列**） | LF 連結へ変換が必要 |
| USER_SELECT / ORG / GROUP | `"[{\"code\":\"u1\",\"name\":\"User One\"}]"` | cli-kintone 互換＝`code` を LF 連結（要決定 §3） |
| DATETIME | `"2026-01-02T03:04:00Z"`（kintone 保持形式・UTC） | 既定はそのまま。timezone option で変換 |
| SUBTABLE（親の列として選んだ場合） | `"[{\"id\":\"9\",\"value\":{…}}]"` | **export 不可**（要求 7＝`APP$明細` 経由のみ）→ export 前エラー |
| 計算列 `num * 2` | `"25"` | JS number の `String()` |
| 計算列 `num * 1e21` | **`"1.25e+22"`** | **指数表記になる**（`String(number)`）。「追加丸めなし」だが指数表記の可否は要決定 §3 |
| 計算列 `1/3` | `"0.3333333333333333"` | IEEE 754 の桁（要求どおり注意書き） |

値の JSON 化は `src/execute.ts:2942-2948`（`safeJsonStringify`）ほか record → row の変換で行われる。既存の CLI 表示は `formatDisplayText`（`src/core/displayFormat.ts`）で `arrayFormat: "join"` のとき `", "` 連結・user は `code`/`name` 選択・date は `local` 変換＝**cli-kintone 互換の LF 連結とは別物**（流用しない）。

### 2.3 既存の CSV 出力

- CLI `--format csv`（`src/cli/index.ts:896-902,915-918`）: `csvEscape` は `"` `,` `\n` だけを quoting 対象にし（**`\r` を見ない**）、行区切りは `\n`、BOM なし、UTF-8 のみ、値は `formatDisplayText` 経由＝**RFC 4180 でも cli-kintone 互換でもない**。B179 の serializer はこれを置き換えない（既存 CLI 出力契約は不変）。
- `--output <path>` は `writeFileSync` の直書き（`src/cli/index.ts:1038`）＝atomic ではない。
- プラグイン・MCP に CSV export は無い（MCP の `csv` 出現 1 件は無関係）。

### 2.4 文字コード

- **リポジトリに Shift_JIS の encoder は無い**。IMPORT の SJIS は `TextDecoder("shift_jis")`（decode 専用・`src/import/csvDecoder.ts:6-13`）。`TextEncoder` は UTF-8 固定で、Node にも標準の SJIS encoder は無い。
- `package.json` の runtime `dependencies` は **空**（`/engine` `/flow` bundle は依存ゼロ・browser-neutral・`flow-bundle-guard` が Node builtin を禁止）。
- → SJIS export は **(a) CP932 変換表を engine に同梱**（表の出所と bundle サイズの問題）／**(b) encoder を呼出側から注入**（engine は UTF-8 文字列を作り、SJIS への変換と表現不能文字の fail-closed は encoder 契約に置く。kSQL-Flow は Node で `iconv-lite` 等）のどちらか。**要決定 §3-A**。

### 2.5 temp table と実行境界

- temp table は `Map<string, MaterializedTable>`（`rows` / `columns` / `columnMeta`）で managed context が保持し、`disposeExecutionContext` まで生存（`src/execute.ts:1842,2500-2505`）。`/flow` から temp table の中身を読む公開 API は無い。
- `/flow` は文単位実行なので「SQL 全文成功後」は呼出側（ランナー）が知っている。**engine 側は「最後の文の後・dispose の前に sink を serialize する公開関数」を出せばよく、成功判定を engine が持つ必要はない**。
- CLI は `executeBatch`（`src/cli/index.ts:2504`）で一括実行し、戻り値に temp table は含まれない → CLI の export は executeBatch のオプション（完了 hook）か、CLI を managed context 方式へ寄せるかの設計が要る。
- 上限: temp table は `tempTableMaxRows`（既定 10,000）・同時 16 表。sink は temp table なのでこの上限がそのまま効く（追加上限は不要）。

## 3. 決まっていること・要決定

### 3.1 決まっていること（仕様レビューの対象外）

1. serializer は `src/export/`（新設・browser-neutral・Node builtin なし）に 1 実装。入力＝`{ columns, rows, columnMeta? }`（MaterializedTable 互換）、出力＝CSV 文字列と receipt（`rows` / `columns`）。**engine は path・file handle・URL を受け取らず、file を書かない**（B177 と対称）。
2. header＝result 列名（§2.1 の事実により C-1(b) を満たす）。重複列名は serialize 前にエラー。alias の小文字化は既存挙動でありこの件では変えない（上流 (a) 非採用と整合）。
3. 値表現: RFC 4180（`"` `,` CR LF を含む cell を quoting・`"` は `""`・record 区切り CRLF・header 行あり・BOM なし）。複数値（JSON 配列文字列・`fieldType` が CHECK_BOX / MULTI_SELECT / USER_SELECT / ORGANIZATION_SELECT / GROUP_SELECT / CATEGORY / STATUS_ASSIGNEE 等）は LF 連結、user 系は `code`。NULL / undefined / 空は空文字。数値は生値。DATETIME は既定そのまま（UTC ISO）、`timezone` option 指定時だけ ISO 8601 with offset へ変換。
4. **SUBTABLE と FILE 型の列が sink にあれば serialize 前にエラー**（列名を message に含める・`APP$明細` の案内）。
5. 名前付きシンク＝temp table `#<name>`。`/flow` は `createExecutionContext` で sink 名を事前宣言し、対応する `CREATE TEMP TABLE` が statements に無い・重複・DML 指定を **context 作成時に同期拒否**（B177 の gate 迂回拒否と同じ位置）。serialize は「最後の文の後・dispose 前」に呼出側が公開関数で行い、**戻り値が receipt**（bytes・rows・columns・encoding）。sha256 は呼出側。単文 SELECT の名前省略＝`StatementResult` の SELECT 結果をそのまま serialize できる純関数を公開して満たす。
6. CLI `--export-csv <name>=<path>`（反復可）と単文 SELECT 向け `--export-csv <path>`。バッチ全文成功後のみ serialize し、同一 directory の一時 file → fsync → close → rename。既存 `--format csv` / `--output` は不変。
7. MCP・プラグインへの export 配線は本件の対象外（serializer 共有の設計だけ担保）。
8. 全件メモリ・既存上限（`tempTableMaxRows` / `maxRecords`）維持。ストリーミング対象外。
9. 純加法・minor（v3.77.0）。

### 3.2 要決定（仕様 R1 で比較して推奨を書く。最終判断はオーナー）

**依頼元（flownet セッション・2026-09-04）の回答**: A＝**(b) encoder 注入を支持**（kSQL-Flow が iconv-lite 等を持つと確約。公開 encoder 契約は `(text: string) => Uint8Array`・失敗は throw・UTF-8 は engine 内蔵で注入不要。CLI の SJIS は Node 層で encoder を持てばよい）／B＝**10 進展開（丸めなし）**／C＝**cli-kintone 互換＝`code` の LF 連結**。R1 はこれを既定案として書き、オーナー裁定で確定する。

**オーナー裁定（2026-09-04）: A＝(b) 呼出側注入・CLI だけ CP932 library を bundle（第一候補 encoding-japanese（MIT）。実装前に iconv-lite と bundle 増分を実測して最終確定）／B＝10 進展開（丸めなし）／C＝`code` の LF 連結。いずれも確定。**

- **A. Shift_JIS encoder の置き場所**（§2.4）: (a) CP932 表の同梱／(b) 呼出側注入。推奨は (b)＝engine を依存ゼロ・browser-neutral のまま保ち、「表現不能文字の fail-closed」は encoder 契約（throw → 完成 bytes を返さない）で満たす。CLI は Node で encoder を持つ必要がある（(b) なら CLI にも encoder 実装が要る＝結局 (a) が要る可能性。ここを R1 で整理する）。
- **B. 計算列の指数表記**（§2.2）: `String(number)` は `1.25e+22` を出す。上流「生値・追加丸めなし」との両立＝(i) そのまま（kintone NUMBER への再取込は指数不可）／(ii) 指数を使わない 10 進展開（丸めなし・既存 `parseExactDecimal` 系を流用）。推奨 (ii)。
- **C. user 系の表現**: cli-kintone 互換＝`code` の LF 連結を推奨（`name` は捨てる）。

## 4. codex への仕様依頼（R1）

出力＝`docs/internal/ksql_b179_csv_export_sink_spec_r1.md`。B177/B178 仕様の章立てに合わせ、次を必ず決める。

- serializer の入出力型と値変換表（`fieldType` × 値の形 → cell 文字列）。`fieldType` 不明（temp table の式列）の JSON 配列文字列をどう扱うか（そのまま／配列なら LF 連結）。
- `/flow` 公開 API の形: sink 事前宣言 option・serialize 関数（context＋name → receipt）・単文 SELECT 用の純関数・エラー code（PascalCase+Error・`ExportSink…Error`）・fail-closed 表（どの失敗で bytes を返さないか）。B177 の `FlowImportSource*` と命名を対にする。
- CLI の配線: `executeBatch` の完了 hook か managed 方式か、atomic write の手順（`fs.openSync` + `fsyncSync` + `renameSync`・Windows の rename 上書き）。
- 要決定 A/B/C の比較と推奨。A で (b) を推す場合は CLI 側の encoder をどうするか。
- 後方互換（既存 `--format csv` 不変・`ExecuteOptions` 共有契約不変・`/engine` 不変）。
- テスト matrix（受入は公開 API の観測）: header 重複／SUBTABLE・FILE 列拒否／複数値 LF＋quoting／`"` CR LF を含む cell／空・NULL／数値生値・指数／DATETIME 既定と timezone／UTF-8 BOM なし／SJIS 成功と表現不能文字で bytes なし／sink 不存在・重複・DML・複文名前なしの実行前エラー／途中失敗で serialize されない／上限／CLI の atomic write（一時 file が残らない・既存 file が壊れない）。
- **Claude が実測すべき未確認事項**（例: `SELECT code, code` が通るか・CATEGORY / STATUS_ASSIGNEE の値の形・Windows `renameSync` の上書き挙動）。

## 5. 未確認（Claude が実測する）

- ~~`SELECT code, code FROM APP1` が重複列名の result を返すか~~ → **実測済み**: 単文 SELECT は `columns: ["code","code"]` を返し、row は map なので値は 1 つ（`SELECT code AS x, cat AS x` は `columns: ["x","x"]`・row の `x` は後勝ち＝cat）。**`CREATE TEMP TABLE #dup AS SELECT code, code` は temp table 側で `columns: ["code"]` に畳まれる**（既存挙動・本件で変えない）→ serializer の重複 header 検出は主に単文 SELECT 経路で効く。temp table の重複 alias は engine が黙って畳むことを文書に明記する
- ~~CATEGORY・STATUS_ASSIGNEE・GROUP_SELECT の値の形~~ → **実測済み**: CATEGORY / MULTI_SELECT は JSON 文字列配列（`["c1","c2"]`）、GROUP_SELECT / ORGANIZATION_SELECT は `[{"code","name"}]`（USER_SELECT と同形）、`$revision` は文字列。STATUS_ASSIGNEE は未測（USER と同形の見込み・実装時に固定）
- ~~`APP$明細` 仮想テーブルの列名~~ → **実測済み**: `SELECT * FROM APP1$Lines` の columns は `["_pid","_rid","_idx", <子 field…>]`（親 ID・行 ID・行 index の順）。`$id` を選ぶと空文字（仮想テーブルには無い）。export header はこの列名のまま
- ~~Windows での `fs.renameSync` による既存 file 上書き~~ → **実測済み（win32・Node 24）**: 同一 directory の一時 file を fsync → close → `renameSync` で既存 file を**上書きできる**（一時 file は残らない）。ただし**既存 file を他プロセスが open していると `EPERM`** で失敗する（Windows 固有・POSIX は成功する）→ 仕様は「rename 失敗時は一時 file を削除して error、既存 file は不変」を契約にし、platform 別 contract test で固定する
- `APP$明細` 仮想テーブルの列名（親 `$id` の付与形）と export header の見え方

## 6. 実装の進行（2026-09-04〜）

3 段 PR（R2 §8.4）で `feature/b179-csv-export` に積む。実装は codex、レビュー・ゲート・コミットは Claude。

### 6.1 PR 1: serializer（コミット c30248a）

`src/export/`（types / csvSerializer / cellSerializer / decimalText / dateTimeText / encoding）。codex の最終報告どおり仕様との食い違いなし。Claude ゲート＝jest 58 PASS・strict tsc PASS・Node builtin import なし。

### 6.2 PR 2: `/flow` 公開 API（Claude 代行で完了）

codex（workspace-write）が実装を終え **最終報告を書く直前にワークスペースのクレジット切れで停止**（B178 と同じ形）。Claude が差分をレビューして完了扱いにした。

| ファイル | 要旨 |
|---|---|
| `src/flow-library/publicTypes.ts` | `ExportEncoding` / `FlowCsvExport*` / `FlowExportTextEncoder` / `FlowNamedExportSink` / `FlowExportSinkStatus`（PR 1 内部型の alias）と `CreateExecutionContextOptions.exportSinks?` |
| `src/flow-library/exportSinkContext.ts`（新規） | sink 宣言の同期検査（空名・先頭 `#`・識別子でない → `ExportSinkInvalidNameError`／宣言重複・CREATE 重複 → `ExportSinkDuplicateError`／CREATE 不存在・最終状態で DROP 済み → `ExportSinkNotFoundError`／DML の `INTO #name` → `ExportSinkInvalidTargetError`。`analyzeBatch` の live set で静的判定）と public context → managed context の WeakMap |
| `src/flow-library/exportSinks.ts`（新規） | 公開 4 関数。`exportSinkStatus` は failed（`failed` 集合または exit 以外の abort）→ incomplete（busy または未処理文あり）→ materialized / not-created の順。`serializeSelectResultAsCsv` は engine が `SelectResult` に WeakMap で付けた列 meta（`getSelectColumnMeta`）を必ず使い、引けない結果は `ExportSinkInvalidTargetError`。`ExportSerializerError` → `KsqlFlowError`（code・message・cause 維持） |
| `src/flow-library/index.ts` | `exportSinks` を共有 `ExecuteOptions` から分離し managed context へ専用引数で渡す。4 関数を value export・型を type export |
| `src/execute.ts` | managed context に `exportSinks` 集合を保持。**内部 options の `captureColumnMeta` を常に true**（公開結果の shape は不変＝テストで固定） |
| `build-flow.mjs` | `exportSinks.d.ts` と `export/types.d.ts` を配布物へ copy |
| `src/flow-library/__tests__/exportSinkPublicApi.test.ts`（新規） | R2 §7.3 の matrix 21 test（named と単文で同一 bytes・単文の複数値/SUBTABLE/FILE・clone/JSON 復元/手組み/DML は InvalidTarget・captureColumnMeta false 指定でも meta 取得・incomplete/materialized/not-created/failed・EXIT 前後・行上限・宣言省略時の golden・status/serialize で API 回数不変・dispose 後） |

Claude ゲート＝flow-library＋export の jest PASS、`build:flow` + `flow:bundle-guard` PASS、`dist-flow/flow-library/exportSinks.d.ts` は `./publicTypes` のみ参照（`../execute` の漏れなし）、`dist-flow/export/types.d.ts` が配布物に含まれる。全 suite は §6.4 に記載。

### 6.3 PR 3: CLI（Claude 実装）

codex がクレジット切れのため Claude が実装した（仕様 R2 §4.3〜4.6・§7.4・§7.5）。

| ファイル | 要旨 |
|---|---|
| `src/execute.ts` | 内部 seam `withBatchCompletionObserver(options, observer)`（private symbol・公開 `ExecuteOptions` 不変）。`executeBatch` は最終結果を組み立てた直後・scope 解放前に observer へ `{ result, tempTables }` を渡す |
| `src/cli/index.ts` | `--export-csv <name>=<path>` / `--export-csv <path>` / `--export-encoding` / `--export-timezone` の parse（最初の `=` で分割・`=` を含む引数は必ず名前付き・左辺が識別子でなければ ArgumentError）。実行前検査 `buildCliExportPlan`（`--dry-run` 併用不可・名前付き／名前なし混在不可・名前なしは単文 SELECT のみ・sink 宣言は `/flow` と同じ `normalizeExportSinkDeclarations`・path 重複と `--output` 衝突・timezone の事前検証）。batch は observer で temp table を受け取り、`writeBatchOutput` の後に全 sink を serialize してから file を書く。単文 SELECT は `captureColumnMeta: true` で実行し engine 付随 meta を使う |
| `src/cli/shiftJisEncoder.ts`（新規） | `encoding-japanese`（devDependency・CLI bundle 限定）で encode → `TextDecoder("shift_jis")` で decode → code unit 完全一致でなければ最初の不一致の code point と offset を message に含めて throw |
| `src/cli/exportCsvFiles.ts`（新規） | 同一 directory の一時 file（`.<name>.<random>.tmp`）を `wx` で作成 → 全量 write → fsync → close → `renameSync`。失敗時は handle を close し一時 file を削除して `ExportSinkWriteError`（旧 file 維持） |
| `src/cli/encoding-japanese.d.ts`（新規） | `@types` が無いため最小の module 宣言 |
| `src/flow-library/exportSinkContext.ts` | `isExportSinkName` を export（CLI と同じ識別子規則） |
| `src/cli/__tests__/exportCsv.e2e.test.ts`（新規） | R2 §7.4 の matrix 19 test（named 成功・単文 SELECT の列 meta・複文／DML の名前なし拒否・sink 不存在／DROP 済み／DML target の実行前拒否＝API 0 回・構文 error 3 形・`=` を含む path・重複／`--output` 衝突／`--dry-run`・失敗時の既存 file 不変と一時 file なし・EXIT 前 CREATE で file なし＝exit 0・SUBTABLE で全 sink 未作成・SJIS 成功と U+301C の fail-closed・timezone 変換と invalid zone・`--format csv` の stdout golden 不変・既存 file の置換と **Windows の open handle で EPERM＝旧 file 維持**） |
| `CHANGELOG.md` / `README.md` / `docs/ksql_language_reference.md` §18.2（新設）/ CLI help | 文書 |

**実測**: CLI bundle（非 minify）は 1,426,387 → 1,850,046 bytes（+424 KB。minify 相当 231 KB）。`/flow` bundle に encoding-japanese の混入なし（guard PASS）。`package.json.dependencies` は空のまま。

**Claude ゲート**: exportCsv e2e 19/19 PASS、`npx tsc --noEmit`（`src/ui/desktop.ts` の既存エラーを除き 0）、`npm test` 全 suite PASS（§6.4）、`build:cli` / `build:flow` / `flow:bundle-guard` PASS。

**codex が担うはずだった自己チェックの代替**: 仕様 §3.4「全 sink を serialize してから最初の file」＝`runNamedCliExports` が serialize ループ完了後に `writeCliExportFiles` を呼ぶ（SUBTABLE テストで good.csv も未作成を固定）。§3.3「batch 失敗時は serialize 0 回」＝`batchCode !== 0` で早期 return。§4.4 の `=` 規則＝parse で固定。不変契約＝`--format csv` golden をテストで固定。

### 6.4 全 suite（PR 3 時点）

`npm test`（version:check + docs:check + 全 suite + e2e）PASS。件数は §7 のリリース記録で確定する。

### 6.5 kSQL-Flow 側のローカル結合（2026-09-04・flownet セッション報告）

kSQL-Flow が `file:../kintone-sql-tools`（feature/b179-csv-export・e4bb63f の `dist-flow`）で export 配線を実装し、**全 365 テスト＋build＋SEA 合格・engine 側の修正不要**（ブランチ feat/contract-v1.1-export d6c7253）。公開 4 関数・`exportSinkStatus` 4 状態・encoder 契約・EPERM 契約が期待どおり。shiftJisEncoder の byte-for-byte 一致も encoding-japanese 直で確認済み。v3.77.0 公開後に registry 版へ確定 → kSQL-Flow 0.9.0 へ。

## 7. リリース前の codex 最終チェックと対応（2026-09-04）

[codex 報告（原文）](ksql_b179_codex_final_check_report.md)。範囲＝独立レビュー未実施の PR 3（CLI）と PR 2 の配線。**総評＝修正が必要（High 1・Medium 2・Low 1）**。全件を feature ブランチで対応した。

| 重要度 | 指摘 | 対応 |
|---|---|---|
| High | `withBatchCompletionObserver` の observer が throw すると完成済み batch が reject になる（`executeBatch` 末尾で無保護に呼んでいた） | observer 呼出しを try/catch で隔離（batch 結果を変えない）。テスト `src/__tests__/b179BatchCompletionObserver.test.ts`（throw する observer でも `ok: true`・symbol が公開 property に出ない） |
| Medium | 一時 file 名が衝突して `wx` が失敗しても、自分が作っていないその file を `unlink` していた | `created` フラグを `openSync` 成功後に立て、自分が作った一時 file だけ削除 |
| Medium | `writeSync` が 0 を返すと無限ループ | 0 以下を `ExportSinkWriteError` にして cleanup へ |
| Low | README に `=` 分割・無効左辺・drive letter・`--output` 衝突・`--dry-run` 禁止の説明が無い | README の CLI option 直後に「引数規則」段落を追加 |

**fault injection のために `writeExportFileAtomically` に `ExportFileIo` seam を追加**（Node 24 の `fs` 名前空間は `jest.spyOn` で差し替えられないため）。単体テスト 7 件＝新規／置換・0 byte write・short write の継続・一時名衝突で他人の file を消さない・fsync／close／rename 失敗で旧 file 維持＋一時 file 削除。

codex が挙げたテストの穴への追加: `exportSinkStatus` の ASSERT 失敗＝failed／依存 skip＝failed、APP-backed SELECT の API 回数が `exportSinks` 省略時と serialize 後で不変、`--output` 衝突・`--dry-run` で API 0 回。**適合確認済み（codex）**＝CLI の serialize 完了→書込の順序、4 状態判定、単文 SELECT の同一参照（`execute()` は複製時に meta を付け直す・`mergeSelectWarnings` も移送）、observer key の非公開、引数規則、Shift_JIS の round-trip。

未実測で残すもの（codex 列挙）: Windows Node 18/20 での EPERM 挙動（24 は e2e で固定）、孤立サロゲートの SJIS、warning 付き SELECT の meta 取得（静的には移送されている）。
