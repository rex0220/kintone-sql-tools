# v3.6.0 実装計画（B39 IMPORT 全体）

- 作成日: 2026-07-19
- 対象版: **v3.6.0**（現行 3.5.0・[package.json:3](../../package.json#L3)・[manifest.json:3](../../prod/manifest.json#L3)）
- SemVer: **minor**（新しい IMPORT 文と source capability の追加。既存 SQL の意味は変更しない）
- 分担/cadence: **Codex=各 Phase の実装・テスト、Claude=各 Phase のコードレビュー、dev=実機 smoke**。各 Phase は `実装 → Claude review → 修正 → dev smoke → Phase 完了` の gate を通過してから次へ進む
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B39
- 確定仕様: [IMPORT v1 R4](ksql_import_statement_spec.md)・[IMPORT v2 R1](ksql_import_v2_spec.md)・[cli-kintone 互換 R2](ksql_import_cli_kintone_compat_spec.md)・[比較評価 R2](ksql_import_vs_cli_kintone_evaluation.md)

## 1. スコープと仕様優先順位

v3.6.0 に次の全 deliverable を束ねる。**添付ファイルだけを対象外**とする。

| Phase | deliverable | 主な source / write mode |
|---|---|---|
| 1 | v1 フラット CSV IMPORT（土台） | CSV、位置対応/SELECT 射影、INSERT/業務キー UPSERT |
| 2 | v2a フラット JSON | JSON、名前対応、INSERT/業務キー UPSERT |
| 3 | 互換 段0/1 | CSV `BY NAME`、export 列分類、LF 複数値、数値字面保持 |
| 4 | 互換 段2 | CSV レコード番号照合による純 UPDATE |
| 5 | v2b＋互換 段3 | JSON ネスト＋CSV `*`、サブテーブル全置換 |

仕様間の差は次の優先順位で解く。

1. ユーザー確定の release scope を最優先する。互換 R2 は段1〜3を個別 minor とするが（[互換仕様:26-33](ksql_import_cli_kintone_compat_spec.md#L26)）、本計画では**単独リリースせず全 Phase を v3.6.0 に束ねる**。Phase 中は CHANGELOG の未リリース節へ追記し、版数は上げない。
2. v2 R1 は CSV `*` を任意後続とするが（[v2仕様:26-33](ksql_import_v2_spec.md#L26)）、本計画では Phase 5 の必須 deliverable とする。
3. JSON UPSERT は `_rid` を受けず全子行を再採番する全置換、互換 CSV UPDATE は行 ID を照合して既存 ID を維持する全置換であり、意図的に別 source mode とする（[v2仕様:176-186](ksql_import_v2_spec.md#L176)・[互換仕様:242-251](ksql_import_cli_kintone_compat_spec.md#L242)）。共通化は親子表現・検証・payload builder までとし、行 ID policy は混ぜない。
4. 添付 `FILE` は `INTO` 指定なら analyze error、非指定の既知 export 列なら監査付き無視とし、bytes upload/picker は実装しない（[互換仕様:188-196](ksql_import_cli_kintone_compat_spec.md#L188)）。

## 2. 現行コードの実装アンカー

- 平坦 source の共通形は `MaterializedTable { rows, columns, columnMeta? }`（[execute.ts:244-260](../../src/execute.ts#L244)）。IMPORT v1/v2a もこの形へ落とし、公開 `SelectResult` に IMPORT 固有情報を混ぜない。
- 通常 INSERT SELECT は [execute.ts:4726-4773](../../src/execute.ts#L4726)、通常 UPSERT SELECT は [execute.ts:5578-5620](../../src/execute.ts#L5578)、検証/CHECK 候補は [execute.ts:4189-4247](../../src/execute.ts#L4189) と別々に source を materialize している。3経路を `materializeDmlSource` へ接続する。
- 位置対応は `columns[i] → fields[i]`（[execute.ts:4764-4770](../../src/execute.ts#L4764)）。Phase 1 の位置対応と Phase 3 の `BY NAME` 後の INTO 順 materialization はこの下流契約を維持する。
- `ON DUPLICATE` はキーが書込み fields に含まれることを要求し（[execute.ts:4248-4255](../../src/execute.ts#L4248)）、検証候補経路には正規化後の源内重複検出がある（[execute.ts:4253-4273](../../src/execute.ts#L4253)）。通常 UPSERT にも同じ global preflight を適用し、全経路で `ERR_KEY_DUP_SOURCE` を書込み/照合 read 前に返す。
- `UPDATE ... FROM` は source `$id` を `RECORD_NUMBER` として扱う（[execute.ts:4541-4577](../../src/execute.ts#L4541)）。Phase 4 は正規化・照合の考え方を抽出して共有するが、CSV を temp/JOIN source として公開しない。
- 現行 `convertProcessRowValue` は USER 系/配列系を JSON またはカンマで変換し、LF を扱わない（[execute.ts:3905-3929](../../src/execute.ts#L3905)）。Phase 3 は IMPORT の `BY NAME` 境界だけに `convertImportCsvValue` を新設する。
- `flattenFields` は child に `inSubtable` を付けるが親 subtable code を保持しない（[formFieldInfo.ts:28-56](../../src/core/formFieldInfo.ts#L28)）。Phase 5 は raw form properties から `subtableCode → child info` index を作る。
- 既存 subtable INSERT は `_pid` 必須で既存行へ追加し（[execute.ts:5108-5155](../../src/execute.ts#L5108)）、UPDATE は `_rid` 条件必須（[execute.ts:5161-5169](../../src/execute.ts#L5161)）。親子 IMPORT はいずれへも委譲しない。
- 現行 subtable PUT は `rows as unknown as string` を使う（[execute.ts:5343-5363](../../src/execute.ts#L5343)）。Phase 5 で IMPORT 専用の再帰 REST payload 型を作り、この cast は流用しない。
- lexer は固定 `KEYWORDS` map（[tokens.ts:199](../../src/lexer/tokens.ts#L199)）、文 dispatch は token kind switch と IDENT のソフトキーワード分岐（[parser.ts:235-259](../../src/parser/parser.ts#L235)）。`IMPORT`、`CSV`、`JSON`、`ENCODING`、`HEADER`、`COLUMNS`、`MATCH`、`RECORD`、`SOURCE`、`REPLACE`、`SUBTABLES` 等は予約語へ追加せずソフトキーワードとして文脈認識する。
- 単文/バッチ配線点は、実行 dispatch（[execute.ts:610-639](../../src/execute.ts#L610)）、batch temp/error table 分析（[batch.ts:222-334](../../src/core/batch.ts#L222)）、DML/read-only 分類（[dmlGuard.ts:24-58](../../src/core/dmlGuard.ts#L24)）。IMPORT は DML、`VALIDATE ONLY` は非書込みとして全箇所を揃える。

## 3. 共通アーキテクチャと Phase gate

### 3.1 共通型・入口

Phase 1 で次の基盤を確定し、Phase 2〜4 は平坦入口、Phase 5 は親子入口を追加する。

```text
DmlSource = SELECT | CSV | JSON
ImportSourceHandle = { load(): Promise<{ bytes: Uint8Array, encoding?: "utf8" | "sjis" }> }
ExecuteOptions.importSource?: (name: string) => ImportSourceHandle | undefined

materializeDmlSource(SELECT | flat CSV | flat JSON) -> MaterializedTable
materializeImportRecords(nested JSON | cli-kintone CSV *) -> MaterializedImportRecords
```

resolver は同期で capability/source 存在を返し、`load()` は遅延実行する。SQL AST が header/columns を所有し、loader metadata は任意 encoding のみ、SQL `ENCODING` が優先、既定 UTF-8、1 source/文 10 MiB、文単位 cache とする（[v1仕様:244-249](ksql_import_statement_spec.md#L244)）。実行順は source handle 同期確認 → destination form 検証 → load/byte上限/decode/materialize → global preflight → row/field検証/CHECK → confirm → mutation とする。

### 3.2 Phase 完了条件

各 Phase は次を満たすまで次へ進まない。

1. 当該 Phase の AST/parser、単文/batch dispatch、DML guard、EXPLAIN、対象 surface を実装。
2. 正常・境界・fail-closed の単体/統合 test と、その時点の既存全 test を green にする。
3. Claude が current patch をコード裏取りで review し、指摘を解消する。
4. dev が `node dist-cli/ksql.js -f <file>`、profile `dev`、APP4221 等で実機 smoke を行い、証跡を `docs/internal/evidence/` に残す。
5. 破壊的書込みを含む場合は `VALIDATE ONLY` または INSERT → 確認 → DELETE で復旧可能な fixture を使う。Phase 5 の全置換は専用 confirm と差分件数が一致するまで実書込みしない。

## 4. Phase 1 — v1 フラット CSV IMPORT（土台）

### deliverable・依存・工数

- deliverable: `IMPORT INTO ... FROM CSV <source>`、UTF-8/SJIS、BOM、RFC4180、HEADER/NO HEADER/COLUMNS、位置対応/任意 SELECT 射影、INSERT/業務キー UPSERT、CHECK、`VALIDATE ONLY`、`ON ERROR SKIP INTO #err`、全 UPSERT 経路の源内キー重複拒否、loader capability、静的/実行時 EXPLAIN。
- 依存: B34 writable field validation、B37 CHECK、B12 validation/error table、B38 scalar projection、既存 SELECT-based DML。後続 Phase の依存元であり、先行 Phase 依存なし。
- 工数: **17〜27 人日**。全面 surface が同時なら上側、CLI capability を最初の review/smoke slice として作り同じ Phase 内で MCP/plugin を追随させるなら下側寄り（v1 R4 の内訳は [v1仕様:264-267](ksql_import_statement_spec.md#L264)）。

### 触るファイル/関数・新規モジュール

- `src/types/ast.ts`: `Statement`/`ExplainStatement.query`（[ast.ts:15-34](../../src/types/ast.ts#L15)・[ast.ts:51-65](../../src/types/ast.ts#L51)）へ `ImportStatement`、`DmlSource`、CSV options、projection、処分句を追加。
- `src/parser/parser.ts`: statement dispatch（[parser.ts:235-259](../../src/parser/parser.ts#L235)）、EXPLAIN dispatch（[parser.ts:431-460](../../src/parser/parser.ts#L431)）へ `parseImport`。IMPORT 系語は `isSoftKeyword`/IDENT 消費 helper で読む。
- `src/execute.ts`: `ExecuteOptions`（[execute.ts:350-371](../../src/execute.ts#L350)）へ同期 resolver、`executeParsedStatement` と batch dispatch、`ValidationStatement`（[execute.ts:3939](../../src/execute.ts#L3939)）へ IMPORT を接続。`executeInsertSelect`/`executeUpsertSelect`/`materializeValidationCandidates` の source 取得を `materializeDmlSource` に集約し、`MaterializedTable.columnMeta` を明示的に渡して CHECK の WeakMap 依存を source 境界から除く。
- `src/core/batch.ts`: IMPORT error table の単文拒否、schema/依存/target app、`VALIDATE ONLY`/`ON ERROR SKIP` を登録（現行入口 [batch.ts:222-334](../../src/core/batch.ts#L222)）。`src/core/dmlGuard.ts`: IMPORT を DML/complete-input に分類し、validate-only 時だけ `writesKintone=false`。
- 新規候補: `src/import/types.ts`、`src/import/sourceLoader.ts`、`src/import/csvDecoder.ts`、`src/import/materializeDmlSource.ts`、`src/import/importProjection.ts`。Node `fs` は `src/cli/` に閉じ込める。
- surfaces: `src/cli/index.ts` に `--import-csv <name>=<path>`、`src/mcp/schemas.ts`/`src/mcp/index.ts` に inline bytes/text source、plugin UI/config に named file picker。共有コアへ path/`fs` を持ち込まない。
- docs: `docs/ksql_language_reference.md`、`docs/ksql_cli_tutorial.md`、`docs/ksql_batch_recipes.md`、`docs/ksql_issue_tracker.md`、MCP schema/describe/help、比較評価を未リリース状態として同期。

### AST/parser・EXPLAIN 差分

- `ImportStatement` は target app/fields、`source:{kind:"CSV",sourceName,encoding,hasHeader,columns?,projection?}`、`keyFields?`、CHECK、処分句を保持する。CSV path/string literal は受けない。HEADER 列名は exact/case-sensitive/trimなし、空/重複は source schema error。
- parse/analyze は句排他、NO HEADER/COLUMNS、射影の JOIN/subquery/修飾参照禁止を検査する。実 header に依存する列参照、行幅、0行は load 後かつ書込み前の preflight で検査する（[v1仕様:200-203](ksql_import_statement_spec.md#L200)）。
- EXPLAIN は source kind/name、encoding/header、projection/列メタ、byte/row limit、write mode、key、CHECK/処分、loader capability、`writesKintone`、源内重複 preflight を表示。loader 不在でも静的 EXPLAIN は可能だが、実データ件数が必要な項目は unknown/requiresLoad とする。

### テスト・dev 実機 smoke

- unit: parser snapshot、ソフトキーワード同名 field 非回帰、RFC4180（quote/`""`/comma/cell newline/CRLF/LF）、UTF-8/SJIS/BOM/fatal decode、10 MiB±1、0 bytes/header-only/0 rows、行幅、header/COLUMNS、loader 未供給、load 1回 cache。
- execution: 位置対応、CAST/CONCAT/`||`/`@var` 射影、列メタと CHECK、INSERT/UPSERT、fail-fast/VALIDATE/SKIP、単文 error table 拒否、B34、max rows、通常/検証双方の `ERR_KEY_DUP_SOURCE` が read/write 0。3経路それぞれを spy で固定する。
- smoke: CLI の named CSV を APP4221 へ `VALIDATE ONLY`、安全な新規キーで INSERT → DELETE、業務キー UPSERT。SJIS/BOM/quoted newline、不良1行の `#err`、重複キーの API mutation 0を確認。MCP は旧 build を使うため dev smoke には使わない。
- SemVer: v3.6.0 全体として minor。Phase 中は version bump なし。

## 5. Phase 2 — v2a フラット JSON source

### deliverable・依存・工数

- deliverable: `FROM JSON <source>`、UTF-8 root array/object records、全階層 duplicate-key 検出、数値元字句保持、安全整数判定、precision target は JSON string 必須、欠落/null/presence の区別、未知 key 拒否。
- 依存: Phase 1 の handle/cache/10 MiB/row limit、平坦 `materializeDmlSource`、3経路、処分/重複 preflight。
- 工数: **4〜7 人日**（厳密 tokenizer/decoder が主コスト。v2 R1 評価 [v2仕様:256-275](ksql_import_v2_spec.md#L256)）。

### 触るファイル/関数・新規モジュール

- `src/types/ast.ts`/`src/parser/parser.ts`: `DmlSource` に JSON、`FROM JSON` と CSV-only 句の排他。
- `src/import/materializeDmlSource.ts`: flat JSON 分岐を追加。`ProcessRow` の `?? ""` が欠落を空に潰すため（[execute.ts:4764-4770](../../src/execute.ts#L4764)）、row presence metadata を `MaterializedTable` の IMPORT 内部付帯情報として保持する。
- 新規候補: `src/import/jsonTokenizer.ts`、`src/import/jsonDecoder.ts`、`src/import/jsonMaterializer.ts`。裸の `JSON.parse` は duplicate key と number lexeme を失うため使わない（[v2仕様:66-82](ksql_import_v2_spec.md#L66)）。
- `src/core/dmlValidation.ts` の厳密10進 primitive は変更せず、IMPORT 境界で型を検査して string/正規化safe-intだけを渡す（根拠 [v2仕様:74-97](ksql_import_v2_spec.md#L74)）。

### AST/parser・EXPLAIN・テスト/smoke

- AST は `{kind:"JSON",sourceName}`。JSON では `ENCODING SJIS`、NO HEADER/COLUMNS/SELECT/BY NAME を拒否。INTO 順へ名前対応して平坦 table を作る。
- EXPLAIN は `sourceFormat=JSON`、UTF-8 only、duplicateKeyPolicy=reject、numberLexemePolicy、precisionTargetsRequireString、unknownKeyPolicy=reject、presenceAware=true を表示。
- unit/fail-closed: root非array、非object要素、空、末尾garbage、UTF-8不正、各階層dup-key、未知key、boolean/object/array型違反、null対欠落、NUMBER string 30桁、`9007199254740991`/`...992`、小数/指数/`-0`、source内UPSERT重複。decoder errorは位置付きで mutation 0。
- smoke: APP4221 の NUMBER を30桁級stringのまま `VALIDATE ONLY`、安全整数の非精度 field、null/欠落 update、JSON INSERT → DELETE。不正 JSON/dup-key は API 0。
- SemVer: minor 内の加法、version bump なし。

## 6. Phase 3 — cli-kintone 互換 段0/1

### deliverable・依存・工数

- deliverable: 段0の数値字面保持/CALC回帰、CSV `BY NAME`、INTO allowlist、既知非書込み列の監査付き無視、未知列の既定拒否＋明示 `IGNORE UNKNOWN COLUMNS`、5種複数値のセル内 LF 解釈。
- 依存: Phase 1 CSV schema/materializer、form metadata、処分/EXPLAIN。Phase 2 には機能依存しないが cadence 上 Phase 2 gate 後に着手。
- 工数: **7〜12 人日**（段0 1〜2＋段1 6〜10。共有済み基盤による下振れを見込むが、surface監査表示で上振れあり）。

### 触るファイル/関数・新規モジュール

- `src/types/ast.ts`/`src/parser/parser.ts`: `mappingMode:"POSITION"|"BY_NAME"`、`ignoreUnknownColumns`。BY NAME と SELECT は排他。
- `src/import/csvMaterializer.ts`: header→destination exact mapping、重複/欠落/二重消費、INTO 順の `columns/rows`、ignored-column audit/presence を構築。既存位置対応を変更しない（[execute.ts:4764-4770](../../src/execute.ts#L4764)）。
- 新規 `src/import/convertImportCsvValue.ts`: BY NAME 生セルだけ `\r\n|\n` を分割。CHECK_BOX/MULTI_SELECT は string[]、USER/ORG/GROUP は `{code}[]`、空セル `[]`、末尾/連続LFの空要素は row error。現行カンマ/JSON変換（[execute.ts:3905-3929](../../src/execute.ts#L3905)）は触らない。
- `src/core/formFieldInfo.ts`/IMPORT preflight: writable、lookup copy、system/CALC/SUBTABLE/FILE を分類。`FILE` は現行集合だけでは writable になり得るため IMPORT 固有拒否を置く（[formFieldInfo.ts:49-62](../../src/core/formFieldInfo.ts#L49)・[execute.ts:3940-3963](../../src/execute.ts#L3940)）。

### EXPLAIN・テスト/smoke

- EXPLAIN: `mapping=BY_NAME`、written columns、ignored known columns＋reason、unknown policy＋非空件数、delimiter=LF、`sourceValueMode=string-preserving`、NUMBER/CALC/空セル、SELECT不使用、`roundTripNumericGuarantee`。
- unit: header順替え、重複/欠落、未知列拒否/opt-in、既知system/CALC/FILE、INTOに非書込み指定、30桁NUMBER字面、5型LF、CRLF、空/連続/末尾LF、BY NAME＋SELECT排他、従来位置対応/カンマ契約非回帰。schema errorは全体、LF item errorは親row隔離。
- smoke: cli-kintone export fixture を APP4221 へ BY NAME `VALIDATE ONLY`、CALC/レコード番号等の監査付き無視、NUMBER字面、5型LF、変更対象列だけの UPDATE 安全例。export全列をUPDATEすると空セルが既存値を明示clearする警告を docs/recipe に固定する。
- SemVer: minor 内、version bump なし。

## 7. Phase 4 — cli-kintone 互換 段2（レコード番号純 UPDATE）

### deliverable・依存・工数

- deliverable: `IMPORT UPDATE APP... FROM CSV ... BY NAME MATCH RECORD NUMBER SOURCE <header>`。record number は照合専用、payloadへ入れず、INSERT 0。source重複は global error、空/未一致は row error。
- 依存: Phase 3 BY NAME/header分類、Phase 1 処分/confirm、既存 record fetch/UPDATE normalization。
- 工数: **5〜8 人日**。

### 触るファイル/関数・新規モジュール

- `src/types/ast.ts`/`src/parser/parser.ts`: `writeMode:"UPDATE_RECORD_NUMBER"`、`recordNumberSourceHeader`。`ON DUPLICATE` と排他、BY NAME 必須、ASCII 10進整数（trimなし、`+`/小数/指数/prefix拒否）。
- 新規候補 `src/import/recordNumberUpdate.ts`: source key normalization、重複 preflight、bulk existing read、match/unmatched、PUT candidate。`loadUpdateFromSourceRows` の `$id` type rule（[execute.ts:4541-4577](../../src/execute.ts#L4541)）を共通 helper へ抽出しても、IMPORT source を temp tableへ公開せず UPSERT経路へ接続しない。
- `src/execute.ts`: IMPORT UPDATE dispatch、VALIDATE/CHECK/ON ERROR SKIP、PUT batching、confirm。`ON DUPLICATE` の「keyはwrite fields」制約（[execute.ts:4248-4255](../../src/execute.ts#L4248)）はこの mode に適用しない。

### EXPLAIN・テスト/smoke

- EXPLAIN: `writeMode=UPDATE_RECORD_NUMBER`、key header、parent rows、duplicate、match/unmatched/invalid（静的時は `requiresLookup=true`）、`inserted=0`、key omitted from payload。
- unit: parse排他、key lexical boundary、source duplicateでread/write 0、空/未一致のfail-fast/SKIP/VALIDATE、全一致PUT、payloadにrecord numberなし、新旧混在をUPSERTしない、confirm件数、revision/API error。
- smoke: APP4221 の既存 `$id` 1〜2件を export fixture で安全な fieldだけ更新し復元。まず VALIDATE ONLY、次に実更新、未一致/SKIP、重複全体拒否、INSERT 0を metrics と実データで確認。
- SemVer: minor 内、version bump なし。

## 8. Phase 5 — v2b サブテーブル＋互換 段3

### deliverable・依存・工数

- deliverable: JSON nested subtable、二層 `MaterializedImportRecords`、scoped form index、専用再帰 payload、親単位隔離、4層 error位置、JSON UPSERT全置換、CSV `*` grouping、row ID照合、`REPLACE SUBTABLES`、削除差分と専用 confirm/EXPLAIN。
- 依存: Phase 1 共通 loader/処分/confirm、Phase 2 JSON decoder/presence、Phase 3 BY NAME/LF/列分類、Phase 4 record-number UPDATE/existing read。
- 工数: **16〜25 人日**。JSON基盤共用で下振れし得るが、複数table grouping・既存read・行ID差分・全surface confirmで上振れする。

### 触るファイル/関数・新規モジュール

- `src/types/ast.ts`/parser: `ImportTarget = FIELD | SUBTABLE`、subtable child declarations、CSV `TABLE ... ROW ID SOURCE ...` 相当、`REPLACE SUBTABLES(...)`。重複宣言、所属違い、未列挙table child、write mode/句排他を analyze error。
- 新規候補: `src/import/materializeImportRecords.ts`、`src/import/subtableFormIndex.ts`、`src/import/cliKintoneCsvGrouping.ts`、`src/import/importRecordValidation.ts`、`src/import/importPayload.ts`、`src/import/subtableReplacementPlan.ts`、`src/import/importErrors.ts`。
- raw form properties から親table所属を保持する index を構築し、既存 `flattenFields`（[formFieldInfo.ts:28-56](../../src/core/formFieldInfo.ts#L28)）やトップレベル writable guardへ子を流さない。
- payload builder は `{[table]:{value:Array<{id?,value:childRecord}>}}` を型で表し、既存 `_pid`/`_rid` DMLと `unknown as string` cast（[execute.ts:5108-5169](../../src/execute.ts#L5108)・[execute.ts:5343-5363](../../src/execute.ts#L5343)）を流用しない。親＋列挙tableを一つの POST/PUT record とし、API batch境界で親を分割しない。
- JSON: `_rid` は未知key拒否。updateでsubtable keyありはIDなし全置換、欠落は維持、`[]` は全削除（[v2仕様:176-186](ksql_import_v2_spec.md#L176)。CSV: markerで親group、既存ID維持、空ID/未知IDはIDなし追加、欠落既存IDは削除。source内同table ID重複はglobal error（[互換仕様:234-251](ksql_import_cli_kintone_compat_spec.md#L234)）。
- error は `parentRow/subtableCode/childRow/childCode`、CSV は物理 `$err_source_row` も保持。`#err` は v2b IMPORTだけ `$err_subtable/$err_subrow/$err_source_row` を追加し、既存DMLの固定schemaを変えない。

### confirm/EXPLAIN・fail-closed

- 実データ preflight で table別 `existingRows/inputRows/updateRows/addRows/deleteRows`、`rowIdNotFound`、親合計、invalid parentsを計算。invalid親はトップ/全table/削除を丸ごと実行対象から除外し、REJECT LIMITは親数を数える。
- confirm context/result を IMPORT 専用 detail で拡張し、`parentsToWrite`、table名、add/update/deleteを全surfaceへ渡す。delete > 0（空table全削除含む）は最上位に「サブテーブル全置換・N行削除」。詳細を表示/承認できない CLI/MCP/plugin/engine surface は Phase 5 mutation を **Unsupported/fail-closed** とし、VALIDATE ONLY/EXPLAINだけ許す。
- 静的 EXPLAIN は source format、marker/header、対象table/row-ID header、replacement=destructive、未知列方針、requiresLookupを表示。実行計画/VALIDATEは上記差分を表示。`REPLACE SUBTABLES` がなければ削除0ではなく、全置換を要求する文自体を拒否する。

### テスト・dev 実機 smoke

- unit: nested JSON複数table、所属/未知/重複key、欠落対`[]`、child型/既定/必須/NUMBER、親単位隔離、4層位置。CSVはmarker先頭/継続、複数table同一物理行、空table、親値継続行、行ID重複/空/既存/未知/別親、未列挙table維持、REPLACE必須、差分/confirm一致。
- fail-closed: parse/source/global preflightはmutation 0、child error親は全mutation 0、REJECT LIMITはinvalid親単位、confirm非対応/拒否はPUT/POST 0、revision conflictは親単位失敗。
- smoke: devに専用subtable appを用意するかAPP4221の安全fixtureを使う。まず VALIDATE ONLY で既存/入力/add/update/deleteを確認。実書込みは復旧snapshot取得後、INSERT→DELETE、または限定親で既存ID更新・空ID追加・未知ID追加・欠落ID削除・空table全削除を確認し即復元。専用警告文と実API結果を照合する。
- SemVer: minor 内、version bump なし。

## 9. 横断テスト・build 方針

- 各 Phase で parser/decoder/materializer/validation/payload の正常・境界・fail-closedを追加し、**既存 1,955+ test を毎 Phase 非回帰 gate**とする。テスト数は実装開始時の `npm test` baseline を記録し、増加後の正確な件数を review 証跡へ残す。
- Phase review前の標準順は対象 test → `npm test` → typecheck/build相当。実装時だけ実行し、本計画作成段階では実行しない。
- plugin面に IMPORT file picker/confirmを出す Phase では `npm run build` により [build.mjs:68-90](../../build.mjs#L68) の `prod/js/desktop.js`/`config.js` とplugin zipを再生成し、browser smokeする。CLI-only sliceなら desktop.js は不要だが、v3.6.0 releaseには全surfaceを含むため最終 buildは必須。
- CLI dev smokeは必ず uncommitted codeから `npm run build:cli` 後の `node dist-cli/ksql.js -f <file>`、profile `dev` を使う。MCPは旧buildなので Phase smokeの代替にしない。
- 破壊的操作は VALIDATE ONLY優先。実mutationが必要なら復旧可能な INSERT fixtureまたは事前snapshot＋限定DELETE/PUT復元とし、件数・対象ID・復元結果を evidenceへ記録する。

## 10. 公開面・文書の同期

Phase 1で共通 source capability を公開し、以後の Phase で同じ source名・上限・error taxonomyをCLI/MCP/pluginへ拡張する。CLI-only先行は Phase内部のreview sliceとして許すが、Phase 1完了を名乗るには後述の判断に従い確定したsurface範囲を満たす。

- CLI: named file引数、複数source、重複name/path/error、help、batch `-f`。
- MCP: inline source schema、10 MiB、JSON/CSV format、破壊的confirm capability。旧配布buildではなくsource testで検証。
- plugin: picker、source名、encoding、ファイル再選択/cache lifetime、confirm detail。pickerを出すならdesktop.js再build必須。
- engine: `ExecuteOptions.importSource` と公開型、capability無しの同期fail。
- docs: language reference、CLI tutorial、batch recipes、README/docs README、MCP tool describe/schema、比較評価、issue tracker、実機evidence。Phase 3後に比較表のLF/record-number差、Phase 5後にsubtable差を更新する。添付非対応は残す。

## 11. リスク・未確定と着手時の判断

1. **loader capability の面範囲（確定＝CLI＋MCP＋plugin 全面）**: v1 R4はCLI/MCP/pluginまで実装範囲（[v1仕様:257-262](ksql_import_statement_spec.md#L257)。**ユーザー確定＝3面すべてに IMPORT を出す。** Phase 1 は **1A=core+CLI、1B=MCP+plugin の review slice に分け、両方通過まで Phase 1 未完**。plugin picker/confirm を出す Phase では desktop.js 再ビルド＋browser smoke を必須とする。
2. **phase ごと main merge＋feature gate（確定）**: 各Phaseをminor releaseにせず、CHANGELOGに `Unreleased / v3.6.0予定` のB39小節を積み上げる。公開版数、manifest、release artifactsはPhase中変更しない。**ユーザー確定＝各 Phase を Claude review＋dev smoke 通過後に main へ merge する。** そのため **off-by-default の capability gate を Phase 1 で作り込み**、gate OFF の公開ビルドでは IMPORT を parse 時に未対応として拒否（既存文法・既存挙動は不変）。gate は CLI/MCP/plugin/engine すべてで既定 OFF、dev/test でのみ ON。v3.6.0 リリース時に既定 ON へ切り替える。gate 機構の確定は Phase 1 の deliverable。
3. **破壊的confirm**: Phase 5の件数内訳を表示できない面はmutation不可。非対話CLI/MCPの事前承認token形式はPhase 5着手前にsurface契約として確定する。一般 `confirm(count,operation)`（[execute.ts:350-360](../../src/execute.ts#L350)）だけでは不足するため、後方互換なdetail/context拡張が必要。
4. **親子書込みの独立性**: v2bは既存 `_pid`/`_rid` DMLへ委譲せず専用payload builderを新設する。巨大な `MaterializedTable | MaterializedImportRecords` unionを既存3経路へ流さず、handle/cache/preflight/confirmだけ共有する。
5. **JSON/CSV行ID UX**: JSONはIDなし再採番、CSV互換はID維持/未知IDを追加へ降格する。EXPLAIN/helpでsource別policyを明示し、共通の「全置換」という語だけで隠さない。
6. **実機fixture**: cli-kintoneのmarker/header/複数table配置、未知row IDのAPI挙動、全配列PUTでの欠落削除をPhase 5実装前に公式export＋dev fixtureで再確認する。仕様と実機が矛盾した場合は実装を止め、仕様文書を先に更新してClaude reviewへ戻す。

## 12. リリース手順（v3.6.0、全Phase完了後のみ）

**版数 bump はリリース直前だけ**行い、Phase実装中は3.5.0のままにする。

1. 全PhaseのClaude review、dev smoke、docs/台帳、未リリースCHANGELOGを完了させる。
2. 版数をすべて3.6.0へ更新する: `package.json`、`package-lock.json`先頭のversion 2箇所（[package-lock.json:1-12](../../package-lock.json#L1)）、`prod/manifest.json`、`release/VERSION.txt`、`release/README.txt`、`CHANGELOG.md`。manifestはplugin build前に更新する。
3. `npm test` → `npm run build`（desktop.js/config.js/plugin zip）→ `npm run build:cli`/必要なMCP buildを行い、release成果物を`release/`へcopyする。
4. package/lock/manifest/CLI表示/zip manifest/release VERSION/README/CHANGELOGの3.6.0一致、添付対象、hash/sizeを検証する。
5. commitする。`.claude/settings.json`、**`.claude/settings.local.json`**その他無関係なlocal設定は除外する。
6. PR → Claude/CI最終review → merge。
7. tag `v3.6.0` → GitHub Releaseを作り、**3 assets**（plugin zip、MCP bundle、app template/既定のrelease 3点）を添付してasset名・版数を検証する。
8. npm publishは**ユーザー操作**。公開後にnpm/GitHub/tagの版数とinstall smokeを確認し、台帳/リリース履歴を確定する。

## 13. 全体工数

| Phase | 工数 |
|---|---:|
| Phase 1: v1 CSV土台 | 17〜27人日 |
| Phase 2: v2a JSON | 4〜7人日 |
| Phase 3: 互換 段0/1 | 7〜12人日 |
| Phase 4: 互換 段2 | 5〜8人日 |
| Phase 5: v2b＋互換 段3 | 16〜25人日 |
| release/docs最終化（各Phase内分を除く） | 2〜4人日 |
| **合計** | **51〜83人日** |

共有基盤による下振れ余地はあるが、Claude review修正、dev fixture準備、plugin/MCPの破壊的confirm UI、実機API差異が上振れ要因。Phaseを束ねても設計上の元見積を単純に削らず、Phase完了時に実績で残工数を再見積りする。

## 14. Phase 1 着手の具体的手順

1. feature branchを作り、`npm test`のbaseline件数（1,955+）と3.5.0のbuild状態を記録する。版数は変更しない。
2. Phase 1A/1Bのsurface範囲を確定し、IMPORTの未完成露出を防ぐgateを決める。
3. `ImportStatement`、`DmlSource`、`ImportSourceHandle`、`ExecuteOptions.importSource` の公開/内部型を追加する。
4. ソフトキーワード方式でCSV IMPORT、CHECK/処分句、EXPLAINをparseし、AST/parser testを先に固定する。
5. source resolver同期preflight、遅延load、文cache、10 MiB/row limitを実装する。
6. UTF-8/SJIS fatal decoder、BOM、RFC4180 parser、header/COLUMNS/0行/schema errorを独立module＋unit testで完成させる。
7. CSV列scopeの射影 evaluatorと式由来`columnMeta`推論を実装する。
8. `materializeDmlSource`をSELECT/CSVで作り、通常INSERT、通常UPSERT、検証/CHECKの3経路を順に移行する。各移行ごとに既存SELECT source testを回す。
9. UPSERT正規化key重複preflightを共通化し、通常/VALIDATE/SKIPの全経路で照合read・mutation 0を固定する。
10. batch/DML guard/単文dispatch/error table/EXPLAINを接続し、CLI named sourceを実装する。確定範囲に従いMCP/pluginを同Phaseで接続する。
11. docs/help/schemaを未リリースとして同期し、対象test→全`npm test`→必要buildを実行する。
12. Claudeへcurrent patch、test証跡、未解決リスクを渡す。指摘解消後、dev CLI smoke→evidence保存→Phase 1完了判定とする。

## 15. Claude が Phase 1 計画でレビューすべき点

1. `materializeDmlSource → MaterializedTable` が通常INSERT/通常UPSERT/検証候補の**3経路すべて**を本当に置換し、CHECK型メタをWeakMapの偶然に依存させないか。
2. source handleの同期存在確認が`getFields`等のkintone APIより前、bytes loadがdestination検証後で、10 MiB・文cache・SQL encoding優先が全surfaceで一致するか。
3. parserがIMPORT語群を予約語化せず、既存同名field/app、EXPLAIN、batch、CHECK/処分句を壊さないか。
4. RFC4180/SJIS/UTF-8/BOM/cell newline/0行/header/COLUMNS/行幅のsource error境界が書込み0で決定的か。
5. CSV射影の参照scope、alias/出力列一意性、列数、式由来`columnMeta`、CHECK評価名が確定仕様どおりか。
6. `ERR_KEY_DUP_SOURCE` が正規化後に、通常/VALIDATE/SKIPすべてで照合read・confirm・mutationより前に文全体拒否されるか。
7. IMPORTがDML guard、complete-input、単文/batch dispatch、temp error schema、EXPLAIN、CLI/MCP/plugin help/schemaへ漏れなく接続されているか。
8. Node `fs`がCLI境界に留まりbrowser buildを壊さず、pluginに露出する場合desktop.js再build/browser smokeが計画されているか。
9. Phase 1のscopeが後続BY NAME/LF/JSON/record-number/subtableを先取りして複雑化せず、同時に後続で作り直さない拡張点を持つか。
10. testが正常だけでなくloader不在、byte/row上限、decode/schema/重複key相当のfail-closed、既存SELECT-based DML非回帰をAPI call count付きで証明するか。
