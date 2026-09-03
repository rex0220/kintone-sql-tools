# B178 `/flow` IMPORT source の materialize 通知（rows receipt）— 公開 API の不足

- 状態: ✅ **v3.76.0 でリリース済み（2026-09-04）**＝[R1](ksql_b178_flow_import_source_materialized_receipt_spec_r1.md) どおり実装（公開型、managed context＋private Symbol seam、3 通知点、receipt、公開 API 受入）。実装報告は §6（codex がクレジット切れで停止したため Claude が代行）
- 種別: 改善（公開 API の純加法追加）
- 優先: **中**（kSQL-Flow は本 API の公開まで `features.importCsv` を出さず 0.8.0 を release しない＝FlowNet 段階 1 の gate）
- 版: **minor（v3.76.0 想定）**。既定動作は変えない
- 上流要求（正）: `C:\Users\rex02\Projects\ksql-flow\docs\internal\contract-v1.1-import-implementation-plan.md` §3.3・§4.1（ksql-flow main 11ecf3b）
- 関連: [B177 仕様](flow_import_source_api_spec.md)（v3.75.0 で公開した named import source API）

## 1. 何が足りないか

kSQL-Flow の Execution Contract v1.1 は結果 JSON の `input_files[]` に **RFC 4180 解析後の data row 数（`rows`）と有効文字コード**を載せる。v3.75.0 の公開 `/flow` にはこれを埋める経路がない。

| 候補 | なぜ使えないか（上流 §4.1・こちらでも確認） |
|---|---|
| `FlowImportSourcePayload` | bytes と任意 `encoding` のみ。行数は decode 後にしか決まらない |
| `StatementResult.rowCount?` | CREATE TEMP TABLE 等の汎用 field で IMPORT 入力行数の契約ではない |
| `FlowDmlResult` の件数 | `ON ERROR SKIP` / `VALIDATE ONLY` / CSV subtable 継続行 / decode 途中失敗で source 行数を復元できない |
| 内部 `importAudit` | 非公開。列の監査（書込列・無視列）で行数を持たない（`src/execute.ts:458`） |
| 改行数の自前計算 | quoted cell 内改行を数えてしまう。上流は不採用と明記 |

上流の要求（設計指定ではなく要求）:

```ts
interface FlowImportSourceMaterializedInfo {
  readonly name: string;
  readonly kind: "CSV" | "JSON";
  readonly rows: number;
  readonly encoding: ImportEncoding;
}
interface CreateExecutionContextOptions {
  onImportSourceMaterialized?: (info: FlowImportSourceMaterializedInfo) => void | Promise<void>;
}
```

通知＝materialize 完了後・mutation 前・source materialization 1 回につき 1 回。callback throw は mutation 0 の statement error。CSV `rows` は header を除く物理 data record 数、JSON は top-level record 数。encoding は `SQL ENCODING > payload > utf8` 解決後の値。source 名以外の内容・path は含めない。

## 2. 実コードで測った事実（2026-09-03・main 16e56c4＝v3.75.0）

**仕様起案・実装ではここを再導出せずそのまま使う。**

### 2.1 IMPORT の materialize は 1 文の実行につき 1 回・5 経路

| 経路 | 呼出し | materializer | `rows` の実体 |
|---|---|---|---|
| flat CSV/JSON・本実行 INSERT | `executeInsertSelect` → `dmlSourceMaterializer.materialize`（`execute.ts:10108` → `materializeDmlSource` 10048） | `materializeCsvDmlSource` / `materializeJsonDmlSource`（10070-10071） | CSV: `decodeCsv().rows.length`／JSON: `decodeJsonRecords().length` |
| flat・本実行 UPSERT | `executeUpsertSelect`（11590）→ 同上 | 同上 | 同上 |
| flat・`VALIDATE ONLY` | `executeDmlValidation`（8754）→ `materializeValidationCandidates`（8990）→ 同上 | 同上 | 同上 |
| flat・`ON ERROR SKIP` | `executeOnErrorSkip`（8873）は事前 validation（`executeDmlValidation`）を経由＝materialize は 1 回 | 同上 | 同上 |
| `IMPORT UPDATE ... MATCH RECORD NUMBER`（flat CSV） | `executeImportRecordNumberUpdate`（9939）が `materializeCsvDmlSource` を直接呼ぶ | `materializeCsvDmlSource` | `decodeCsv().rows.length` |
| subtable（INTO に SUBTABLE 目標） | `executeImport`（9669-9672） | JSON: `materializeJsonImportRecords`／CSV: `materializeCliKintoneCsvImportRecords` | JSON: `decodeJsonRecords().length`（親 record 数）／CSV: `decodeCsv().rows.length`（**継続行を含む物理行**。親数は `records.length`） |

- `decodeCsv`（`src/import/csvDecoder.ts:62-84`）＝`parseRfc4180` で quoted 改行を 1 record に畳んだ後、`hasHeader` なら `records.slice(1)`、`NO HEADER` なら全 record。列数不一致・0 行はここで throw。
- **maxRecords 超過の検査は decode 直後・materialize 内**（`materializeDmlSource.ts:24-26`、`jsonMaterializer.ts:57`、`importRecordsMaterializer.ts:21,90`）＝超過は throw で「materialize 完了」に到達しない → 通知なし・mutation 0。
- 有効 encoding＝CSV は `source.encoding ?? payload.encoding ?? "utf8"`（`materializeDmlSource.ts:20`、`importRecordsMaterializer.ts:71`）。JSON は `payload.encoding` が `utf8` 以外なら throw＝実質 `utf8` 固定。
- flat CSV に projection（`FROM CSV ... SELECT` 形）がある場合、raw materialize の後に projection SELECT が走る（10074-10079）。**`rows` は raw（projection 前）で取る**。

### 2.2 通知点は mutation の前・metadata API の後

- 全経路で materialize は最初の mutation API より前。ただし flat 経路では `getFieldsCached`（フォーム定義）が materialize より前に走る（例 9664、10105）＝**B177 §3 と同じく「metadata API 0」は契約にしない。mutation 0 だけを契約にする**。
- 到達しない IMPORT（EXIT 後 skip・fail-fast skip・依存 temp 欠落 skip）・`EXPLAIN IMPORT`（planner は source を解決しない）・`previewStatement`（IMPORT を ArgumentError で拒否）では materialize が走らない → 通知なし。

### 2.3 callback の配線先例＝`onChunkWritten`

- 公開型 `CreateExecutionContextOptions.onChunkWritten`（`src/flow-library/publicTypes.ts:211`）→ `createExecutionContext` が分離して `createManagedStatementExecutionContext(..., onChunkWritten, ...)` の**専用引数**で渡し（`src/flow-library/index.ts:146-167`）、managed context に保持（`execute.ts:1851,1931`）。文実行時に client を wrap して呼ぶ（1990-1997）。
- callback の throw は `executeManagedStatement` の try/catch で `toBatchStatementError`（2869）により `StatementResult.error`（code は `e.name` → message 接頭辞）になる。
- `ExecuteOptions`（`execute.ts` 756-792）は CLI/MCP/プラグインと共有の内部 options。**B177 の教訓＝共有 primitive を触ると他の面の契約が動く**（[履歴 v3.75.0](../ksql_release_history.md)）。

## 3. 決まっていること（仕様レビューの対象外）

1. 公開面は `/flow` だけ。CLI/MCP/プラグインの挙動・出力・`ExecuteOptions` の公開契約は変えない（`onChunkWritten` と同じ扱い）。
2. option 名と info の形は上流案を採り、`statementIndex`（0 始まり・`FlowChunkWrittenInfo` と同じ）を**加える**。バッチ内で同じ source を複数 IMPORT 文が参照したとき、消費側が文ごとの通知を識別できるようにするため。上流の dedupe（同 metadata なら 1 entry・矛盾は fail-closed）はこの追加で妨げない。
3. `rows` の定義＝§2.1 の表のとおり **decoder が返した物理 record 数**（CSV は header 除く・quoted 改行は 1・subtable CSV は継続行を含む／JSON は top-level record 数）。projection・validation・skip の後の件数ではない。
4. 通知は **materialize 成功 1 回につき 1 回**（＝IMPORT 文の実行 1 回につき 1 回）、raw materialize 直後・projection SELECT と mutation の前。maxRecords 超過・decode 失敗・source 境界エラーでは通知しない。
5. callback は await する。throw / reject は当該文の `status: "error"`（code は既存の `toBatchStatementError` 規則）・**mutation 0**・後続は既存の fail-fast。B177 と同じく metadata API 0 は非契約。
6. `encoding` は公開型 `ImportEncoding`（`"utf8" | "sjis"`）の小文字。大文字化は消費側。
7. path・cell 値・列名・bytes は info に含めない（B177 と同じ非漏出）。
8. 純加法・minor（v3.76.0）。`onImportSourceMaterialized` 未指定の既存 consumer は結果・API 回数とも不変。

## 4. codex への仕様依頼（R1）

出力＝`docs/internal/ksql_b178_flow_import_source_materialized_receipt_spec_r1.md`。B177 仕様（`flow_import_source_api_spec.md`）の章立て（現状調査／公開 API 契約／安定エラー契約／実装方針／変更ファイル／後方互換／テスト方針／リリース）に合わせる。特に決めてほしいこと:

- **配線方式**＝(a) `onChunkWritten` と同じ専用引数＋managed context 保持 (b) `ExecuteOptions` への追加 (c) `statementEvaluationContextKey` と同じ Symbol seam。§3-1 の制約（CLI/MCP/プラグインの契約不変）と、materialize 呼出しが `ExecuteOptions` しか受け取らない現実（`materializeDmlSource(stmt, client, options, ...)`）の両立。
- 5 経路それぞれの通知挿入点（file:line）と、subtable CSV の `rows` を物理行にする根拠の明記。
- 同一文内で materialize が 2 回走る経路が本当に無いか（§2.1 の「1 回」は grep による静的確認。`executeOnErrorSkip` → `executeDmlValidation` の呼出し関係を file:line で確定する）。
- テスト表（受入は公開 API の観測だけで書く）: quoted 改行入り CSV／CRLF／末尾改行あり・なし／BOM／`NO HEADER COLUMNS`／SJIS（metadata と SQL 句の両方）／JSON／subtable CSV（継続行）／`ON ERROR SKIP`／`VALIDATE ONLY`／maxRecords 超過（通知なし）／callback throw（mutation 0・後続 skip）／EXIT 後 skip（通知なし）／同一 source を 2 文が参照（2 回・`statementIndex` が異なる）／未指定時の非回帰（結果・API 回数不変）。
- **Claude が実測すべき未確認事項を列挙する**（例: CRLF・BOM の扱いは `parseRfc4180` / `decodeImportText` の実装依存）。

## 5. 実測で確定したこと（2026-09-03・`decodeCsv` を esbuild で束ねて node 実行）

| 入力 | `rows` | 備考 |
|---|---|---|
| LF・末尾改行あり／なし | 2／2 | 末尾改行の有無で変わらない |
| CRLF | 2 | |
| BOM＋LF | 1 | BOM は `decodeImportText` が除去 |
| quoted cell 内の LF／CRLF | 2／1 | 改行を含む cell は 1 record（改行数 3 に対し rows 2） |
| 末尾に空行（2 列 CSV） | **throw**（`CSV row 3 has 1 cells; expected 2.`） | 空行は 1 cell の record になり列数不一致で拒否＝**通知なし** |
| 途中の空行（2 列 CSV） | **throw** | 同上 |
| **1 列 CSV の末尾空行** | **2**（`[["A"],[""]]`） | 列数が一致するため**空値の data row として数える**。仕様・テストに明記する |
| `NO HEADER COLUMNS (…)` | 3 | 全 record が data row |
| header だけ | throw（`CSV has no data rows.`） | 通知なし |

- subtable CSV の継続行は `materializeCliKintoneCsvImportRecords` が `decoded.rows.forEach` で処理する（`importRecordsMaterializer.ts:85`）＝物理行に含まれる（コード上の確定。テストで固定する）。
- kSQL-Flow 側は `statementIndex` の追加を受入済み（2026-09-03 flownet セッション回答）。同時に kSQL-Flow の Execution Result 契約は `input_files[].rows` を **optional** にする（receipt を受けた source だけ rows を記載）＝「maxRecords 超過・decode 失敗は通知なし」と整合。

## 6. 実装報告（2026-09-03・Claude 代行）

**経緯**: codex（`codex exec -s workspace-write`）が仕様 R1 どおり 15 ファイルを変更し targeted jest を通した後、**最終報告を書く前にワークスペースのクレジット切れで停止**（exit 2）。[B155 の前例](../ksql_release_history.md)どおり Claude が差分レビューとゲートを代行した。

### 6.1 変更ファイル

| ファイル | 要旨 |
|---|---|
| `src/flow-library/publicTypes.ts` | `FlowImportSourceMaterializedInfo`（5 key）と `CreateExecutionContextOptions.onImportSourceMaterialized?` |
| `src/flow-library/index.ts` | option を分離して managed context へ専用引数で渡す。type export |
| `src/execute.ts` | managed context に保持、文実行時に `statementIndex` を bind した内部 callback を private `unique symbol` で当該文 options へ付加、通知 helper、**通知点 3 箇所**（flat 共通 `materializeDmlSource` 直後／record-number UPDATE の CSV materialize 直後／subtable materializer 直後）。callback 完了後に deadline を再検査（timeout 後の detached 実行が mutation へ到達しないため） |
| `src/import/types.ts` | 内部 `ImportMaterializationReceipt { rows, encoding }`。flat table と subtable records の戻り値に必須で保持 |
| `src/import/materializeDmlSource.ts` / `jsonMaterializer.ts` / `importRecordsMaterializer.ts` | receipt の生成（CSV = `decoded.rows.length` と解決済み encoding／JSON = top-level 件数と `utf8`／subtable CSV = グループ化前の物理行） |
| `src/flow-library/__tests__/importSourcePublicApi.test.ts` | 公開 API だけの受入 13 test（仕様 §6.2 の matrix・§6.3 error code 3 形・§6.4 の 5 key 固定・timeout 後の mutation 0・`onChunkWritten` との順序・同一 source 2 文・省略／no-op の非回帰） |
| `CHANGELOG.md` / `README.md` / `docs/ksql_language_reference.md` / 仕様 R1 | 文書。R1 レビュー節の修正 3 件は本文へ反映済み |

CLI/MCP/プラグインは symbol を設定しないため通知 helper は no-op。`ExecuteOptions` に公開 property は増えていない。

### 6.2 ゲート（Claude 実行）

| ゲート | 結果 |
|---|---|
| `npx jest src/flow-library/__tests__ src/import/__tests__` | 14 suites / 152 tests PASS |
| `npm test`（version:check + docs:check + 全 suite + e2e） | 290 suites / 6,342 tests + e2e 26 PASS |
| `npm run build:flow` + `flow:bundle-guard` | PASS。`dist-flow/flow-library/{publicTypes,index}.d.ts` に新型と option を確認 |
| `npm run build:engine` + `engine:bundle-guard` + `engine:declaration-smoke` | PASS（engine の公開面は不変） |
| `npx tsc --noEmit -p tsconfig.json` | `src/ui/desktop.ts` に 5 件のエラー。**main でも同じで B178 無関係**（配布物は esbuild と tsconfig.flow/engine で作られる） |

### 6.3 仕様 §8 の未確認事項との対応

| § 8 | 状態 |
|---|---|
| 1〜4（CRLF/BOM/quoted/NO HEADER） | 起票 §5 の実測で確定・受入テストで固定 |
| 5（subtable CSV 継続行） | 受入テスト（親 1 行＋継続 1 行 → rows 2）で固定 |
| 6（subtable の maxRecords は親数） | 未固定（現行意味論のまま。受入テスト未追加＝任意） |
| 7（callback 未 resolve 中の mutation 0） | 受入テストで固定（gate Promise） |
| 8（throw 後 fail-fast・再試行なし） | 受入テストで固定 |
| 9（同一 source 2 文 → 2 回・index 相違） | 受入テストで固定 |
| 10（VALIDATE ONLY / ON ERROR SKIP で 1 回） | 受入テストで固定 |
| 11（`onChunkWritten` より先） | 受入テストで固定 |
| 12（kSQL-Flow が `statementIndex` を受理） | flownet セッション回答で確定 |
| 13（tarball の declaration・private symbol 非公開） | リリース時の `npm pack --dry-run` で確認する |

### 6.4 意味が変わるため触らなかった既存テスト

なし（既存テストは receipt callback の追加 assert だけ）。
