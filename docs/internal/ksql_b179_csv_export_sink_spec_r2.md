# B179 CSV export（名前付きシンク・engine serializer・`/flow` 公開 API）仕様 R2

- 状態: 仕様 R2
- 対象版: v3.77.0
- 変更種別: minor・純加法
- 上流要求: `ksql-flownet/docs/internal/csv-io-implementation-plan.md` §4.1〜§4.2
- 関連: B177 named IMPORT source、B178 materialized receipt
- 対象外: MCP／プラグインへの export 配線、ストリーミング export、cli-kintone のサブテーブル `*` 形式

## R1 からの変更点

1. 単文 SELECT の export でも名前付きsinkと同じcolumn metadataを使用する。managed `/flow` contextは列metadata取得を常時有効にし、engineが `SelectResult` にWeakMapで関連付けたmetadataをserializerが内部取得する。metadataを取得できない `StatementResult` は `ExportSinkInvalidTargetError` とする。
2. metadata取得を常時有効にしても、公開 `SelectResult`、`StatementResult`、metrics、API呼出し回数は変更しない。metadataは公開objectのpropertyではなくWeakMapへ保持する。
3. 正常なEXITとの交差は、公開純関数 `exportSinkStatus` を追加する案を採用する。sink作成後のEXITはserialize可能、作成前のEXITは `"not-created"` として判別でき、`serializeExportSink` を直接呼んだ場合は `ExportSinkNotMaterializedError` とする。
4. encoderは表現不能文字でthrowする義務を負う。検査方式はencoder実装者の責務とし、CLIのCP932 encoderはencode後に `TextDecoder("shift_jis")` でdecodeし、canonical textとの完全一致を検査する。
5. `--export-csv` は最初の `=` でのみ分割する。`=` を含む指定は必ず名前付き形式とし、左辺が有効なsink識別子でなければ構文errorとする。したがって名前なしpathに `=` は使用できず、pathに `=` を含める場合は有効な `name=` を前置する。
6. オーナー裁定A/B/Cを確定事項へ変更した。Aは呼出側encoder注入＋CLIだけCP932 library、Bは丸めを伴わない10進展開、Cは `code` のLF連結である。
7. 実測済み事項を本文へ統合した。空の複数値 `"[]"` は空セル、`@NOW()` のミリ秒はtimezone変換後も保持、temp tableでは重複列が畳まれる、Windowsの `EPERM` では旧file維持・一時file削除・error、指数展開は最大1,024文字でfail-closedとする。
8. 非文字列値を `ExportSinkInvalidValueError` とし、DROPによるsink不存在はcontext作成時に必ず判定すると明記した。
9. `--export-csv` 併用時も既存 `--format csv`／`--output` の出力がv3.76.0 goldenと一致する受入条件を追加した。
10. 実装をserializer、`/flow`、CLIの3段PRに分割し、各段の受入条件と完了条件を定義した。

## 0. 結論

B179は、CSV方言を `src/export/` のbrowser-neutral serializerへ一元化し、CLIと公開 `/flow` APIから同じ実装を利用できるようにする。

1. serializerは `{ columns, rows, columnMeta? }` を受け、canonical Unicode CSV文字列、指定encodingの `Uint8Array`、`rows / columns / bytes / encoding` receiptを返す。path、URL、file handleは受け取らず、fileを書かない。
2. headerは現在のresult列名をそのまま使う。完全一致する重複headerはserialize前に拒否する。明示aliasの既存小文字化は変更しない。
3. CSV形式はheaderあり、RFC 4180 quoting、CRLF record区切り、最終CRLFあり、BOMなしとする。
4. 既知の複数値fieldはJSON配列文字列をLF連結へ変換する。USER／ORGANIZATION／GROUP／STATUS_ASSIGNEE系は各要素の `code` を使う。空配列文字列 `"[]"` は空セルにする。
5. fieldType不明の式列はJSONに見えても解釈せず、生文字列を保持する。
6. SUBTABLEとFILE列はserialize前に拒否する。サブテーブルを出力する場合は `APP$明細` 仮想テーブルをSELECTする。
7. 名前付きsinkは宣言名 `name` とtemp table `#name` を完全一致で対応させる。公開 `/flow` context作成時に宣言重複、CREATE不存在、CREATE重複、DROPによる最終不存在、利用不能なtargetを同期拒否する。
8. managed `/flow` contextではcolumn metadata取得を常時有効にする。単文SELECTはengineが `SelectResult` に関連付けたmetadataを内部取得し、名前付きsinkと同じ値変換およびSUBTABLE／FILE拒否を行う。
9. 正常なEXIT後は、EXITより前にsinkが実体化済みなら後続skipを処理済みとみなしserializeできる。EXIT時点でsinkが未作成なら公開statusは `"not-created"` とし、消費側は成果物を生成しない。
10. Shift_JISは呼出側encoder注入方式とする。`/flow` bundleへCP932表やNode builtinを入れない。encoderは表現不能文字でthrowする義務を負う。
11. CLIだけにCP932 libraryをbundleする。第一候補は `encoding-japanese` とし、実装前に `iconv-lite` とbundle増分、license、encode結果を実測して採用品を確定する。
12. 計算列の指数表記は、丸めを行わず、指数を持たない等価な10進文字列へ字句展開する。展開後が1,024文字を超える場合はfail-closedにする。
13. CLIは反復可能な `--export-csv <name>=<path>` と、単文SELECT専用の `--export-csv <path>` を追加する。既存 `--format csv` と `--output` は変更しない。
14. CLIはSQL全文成功後に全対象をメモリ上でserializeしてから、一時fileへのwrite、fsync、close、同一directory内renameを行う。途中失敗では不完全な完成fileを残さない。
15. `/engine` export、共有 `ExecuteOptions`、既存CLI出力、IMPORT契約は変更しない。

## 1. 現状調査

### 1.1 result、column metadata、materialized table

SELECT結果は `rows: ProcessRow[]`、列定義順の `columns: string[]`、`rowCount` を保持する（`src/execute.ts:418-424`）。

column metadataは公開 `SelectResult` のpropertyではなく、`SelectResult` objectをkeyとするWeakMapへ関連付けられ、取得関数はmetadataがなければ `undefined` を返す（`src/execute.ts:465-470`）。列metadata取得は現在 `ExecuteOptions.captureColumnMeta` で制御され、既定値はfalseである（`src/execute.ts:745-750`）。

temp tableの実体は次の形である。

```ts
interface MaterializedTable {
  readonly rows: ProcessRow[];
  readonly columns: string[];
  readonly columnMeta?: ReadonlyMap<string, MaterializedColumnMeta>;
}
```

`MaterializedColumnMeta` は `displayName`、`sortKind`、`fieldType`、`semantics`、`publicSourceApp` を保持する（`src/execute.ts:440-455`）。CREATE TEMP TABLE成功時にはSELECT結果の `rows`、`columns`、WeakMapから取得したcolumn metadataが同じtemp tableへ保存される（`src/execute.ts:2491-2505`）。

直接field参照のresult列名は正式field codeである。式、計算列、明示aliasも現在のresult列名を使い、追加の `getFields` header復元は行わない。明示aliasの小文字化を含む実測結果は起票に記録済みである（`docs/internal/ksql_b179_csv_export_sink_issue.md:24-36`）。

単文 `SELECT code, code` は重複する `columns` を返す。一方、CREATE TEMP TABLEでは重複列が1列へ畳まれる。これは既存挙動として変更しない。したがって重複header検出は特に単文SELECT経路で必要となる（`docs/internal/ksql_b179_csv_export_sink_issue.md:110-115`）。

### 1.2 managed `/flow` contextと公開結果の不変性

公開 `CreateExecutionContextOptions` はscriptまたはstatementsと実行optionを受ける（`src/flow-library/publicTypes.ts:195-232`）。context作成時にはscript全体のparseとbatch解析が行われ、managed stateへstatements、analysis、temp table、実行順、失敗状態が保持される（`src/flow-library/index.ts:117-170`、`src/execute.ts:1893-1960`）。

`executeStatement` は内部結果から公開 `StatementResult` を組み立てるが、ネストされた `result` objectの参照は維持される（`src/flow-library/index.ts:240-261`）。このため、単文SELECTの公開 `StatementResult.result` から同じ `SelectResult` objectを使ってWeakMap metadataを取得できる。

R2ではmanaged context作成時に、利用者から渡された値にかかわらず内部実行optionの `captureColumnMeta` をtrueとする。これは次の理由により既存consumerの公開結果を変えない。

- `SelectResult` の公開shapeへpropertyを追加しない（`src/execute.ts:418-438`）。
- metadataはWeakMapだけへ保存される（`src/execute.ts:465-470`）。
- 公開 `StatementResult` のshapeを変更せず、receiptやmetadataを暗黙追加しない（`src/flow-library/publicTypes.ts:335-349`）。
- `executeStatement` が返す既存status、kind、result、metricsの構築方法を変更しない（`src/flow-library/index.ts:240-265`）。

contextは明示的にdisposeされ、dispose後はmanaged stateへアクセスできない（`src/flow-library/index.ts:268-274`）。

### 1.3 EXITと実行状態

managed実行は登録順に進み、EXIT後の文を `status:"skipped"`、`skippedReason:"exit"` として返す。このskipは失敗集合へ追加されない（`src/execute.ts:1970-1989`）。EXITが成立するとmanaged stateのabort理由が `"exit"` になる（`src/execute.ts:2066-2072`）。

したがって、全statementがsuccessまたはEXITによるskipまで回収済みであれば処理完了とする。ただしsinkの実体化有無は別に判定する。

- EXITより前に対応temp tableが作成済み: `"materialized"`。serialize可能。
- EXITより前に対応temp tableが作成されていない: `"not-created"`。正常なNO_DATA系終了として扱え、成果物は作らない。
- error、timeout、assertion、依存失敗: `"failed"`。serialize不可。
- 未処理statementが残る: `"incomplete"`。serialize不可。

### 1.4 batch実行境界

`executeBatch` は全文をparse／解析した後、共有temp table mapを使って文を順次実行する（`src/execute.ts:1657-1669`）。実行時errorは文ごとの `status:"error"` として記録され、既定では後続文がfail-fastでskipされる（`src/execute.ts:1648-1655`）。

現在のbatch戻り値にはtemp table本体が含まれないため、CLI exportにはbatch完了時点でtemp tableを読み出し、既存公開signatureを変えずにserializerへ渡す内部seamが必要である。CLIは現在 `executeBatch` を利用している（`src/cli/index.ts:2501-2508`）。

batch解析はtemp tableのlive setを実行順に追跡し、未定義／DROP済み参照とliveな同名CREATEを静的に拒否する（`src/core/batch.ts:227-234,398-445`）。B179のsink検査もこの解析結果を使い、対応sinkが最終状態でDROP済みかどうかをcontext作成時に必ず判定する。

### 1.5 値の実測結果

engineの `ProcessRow` ではscalar値とJSON化された複数値が文字列として渡される。実測済みの主なshapeは次のとおりである（`docs/internal/ksql_b179_csv_export_sink_issue.md:38-53`）。

| field型 | 実測値 |
| --- | --- |
| SINGLE_LINE_TEXT／NUMBER | `"A"`／`"12.50"` |
| CHECK_BOX／MULTI_SELECT／CATEGORY | JSON文字列配列 |
| USER_SELECT／GROUP_SELECT／ORGANIZATION_SELECT | `{code,name}` のJSON配列文字列 |
| DATETIME field | UTC ISO文字列、通常は秒精度 |
| SUBTABLE | 行objectのJSON配列文字列 |
| FILE | `fileKey`、`name`、`size`、`contentType` を持つobjectのJSON配列文字列 |
| 計算列 | JS numberの文字列表現。指数表記を含み得る |

CHECK_BOX／USER_SELECTの空値は文字列 `"[]"`、DATETIMEの空値は `""` である。`"[]"` は複数値の空配列として空セルへ変換する。

dialect 1の `@NOW()` はミリ秒付きUTC ISO文字列を返し得る。timezone変換ではこのミリ秒を保持する。`@TODAY()` は `YYYY-MM-DD` でありtimezone変換対象にしない。

`APP$明細` 仮想テーブルの実測columnsは `_pid`、`_rid`、`_idx`、子fieldの順であり、export headerもその列名を使用する。仮想テーブルに存在しない `$id` を選んだ場合の空文字という既存挙動もB179では変更しない。

### 1.6 既存CLI CSVとbundle境界

既存 `--format csv` は表示用変換を通し、`,`、`"`、LFだけをquote判定に使い、LFでrecordを結合する（`src/cli/index.ts:895-918`）。既存 `--output` は生成済み表示文字列を直接書く（`src/cli/index.ts:1034-1039`）。

B179の `--export-csv` はこの経路とは別契約とし、既存 `--format csv`、表示option、`--output` の意味を変更しない。

`/flow` bundle guardはNode builtin、CLI、MCP、plugin UI等の混入をfail-closedで検査する（`scripts/flow-bundle-guard.mjs:11-23,29-51`）。CLIはNode向け単一bundleで、依存moduleをbundleできる（`build-cli.mjs:10-17`）。

## 2. 公開 API 契約

### 2.1 serializerの公開型

`src/flow-library/publicTypes.ts` から次をtype exportする。

```ts
export type ExportEncoding = "utf8" | "sjis";

export interface FlowCsvExportColumnMeta {
  readonly fieldType?: string;
}

export interface FlowCsvExportInput {
  /** CSV header。順序を保持する。 */
  readonly columns: readonly string[];

  /**
   * engine result互換のrow。
   * string、null、undefined以外の値は実行時に拒否する。
   */
  readonly rows: readonly Readonly<
    Record<string, string | null | undefined>
  >[];

  /** keyはcolumns内の列名。省略列はfieldType不明として扱う。 */
  readonly columnMeta?: ReadonlyMap<string, FlowCsvExportColumnMeta>;
}

export interface FlowExportTextEncoder {
  readonly encoding: "sjis";

  /**
   * 入力全体を正確にencodeできる場合だけbytesを返す。
   * encoderは表現不能文字でthrowする義務を負う。
   * 表現不能文字の検査方式はencoder実装者の責務である。
   */
  encode(text: string): Uint8Array;
}

export interface FlowCsvExportOptions {
  /** 既定 utf8。 */
  readonly encoding?: ExportEncoding;

  /** DATETIME変換先のIANA timezone。省略時はUTC保持形式を維持する。 */
  readonly timezone?: string;

  /** encoding:"sjis" の場合に必須。 */
  readonly encoder?: FlowExportTextEncoder;
}

export interface FlowCsvExportReceipt {
  readonly rows: number;
  readonly columns: number;
  readonly bytes: number;
  readonly encoding: ExportEncoding;
}

export interface FlowCsvExportResult {
  /** encoding前のcanonical CSV文字列。 */
  readonly text: string;

  /** 指定encodingでencode済みの完全なCSV payload。 */
  readonly data: Uint8Array;

  readonly receipt: FlowCsvExportReceipt;
}

export interface FlowNamedExportSink {
  /**
   * SQL上のtemp table #<name> に対応する、#を含まないsink名。
   * 照合はcase-sensitiveな完全一致。
   */
  readonly name: string;
}

export type FlowExportSinkStatus =
  | "materialized"
  | "not-created"
  | "failed"
  | "incomplete";
```

`bytes` はreceipt内ではbyte数、payloadは `data` と命名する。Node `Buffer`、path、URL、file handleは公開型に含めない。

### 2.2 serializer関数

`@rex0220/kintone-sql-tools/flow` から次をvalue exportする。

```ts
export function serializeCsvExport(
  input: FlowCsvExportInput,
  options?: FlowCsvExportOptions
): FlowCsvExportResult;

export function serializeSelectResultAsCsv(
  result: StatementResult,
  options?: FlowCsvExportOptions
): FlowCsvExportResult;

export function exportSinkStatus(
  context: ExecutionContext,
  name: string
): FlowExportSinkStatus;

export function serializeExportSink(
  context: ExecutionContext,
  name: string,
  options?: FlowCsvExportOptions
): FlowCsvExportResult;
```

規則は次のとおり。

- `serializeCsvExport` は純関数であり、kintone API、filesystem、clock、host timezoneへアクセスしない。
- `serializeSelectResultAsCsv` は `status:"success"` かつ `result.type === "SELECT"` の `StatementResult` だけを受理する。
- `serializeSelectResultAsCsv` はengineが対象 `SelectResult` objectへ関連付けたcolumn metadataを内部取得し、必ずserializerへ渡す。
- metadataが取得できない `StatementResult` は、shapeがSELECTに見えても `ExportSinkInvalidTargetError` とする。他context由来、clone、JSON復元、利用者が組み立てたobjectは受理しない。
- named sinkと単文SELECTは同じmetadata解釈、値変換、SUBTABLE／FILE拒否、CSV形式を使用する。
- `exportSinkStatus` はcontextの実行状態と宣言済みsinkの実体化状態だけを読む純関数であり、kintone API、encoder、filesystemを呼ばない。
- `exportSinkStatus` は宣言済みsinkだけを受理する。dispose済みcontextには `ExecutionContextDisposedError`、未宣言名には `ExportSinkNotFoundError` をthrowする。
- `serializeExportSink` はstatusが `"materialized"` の場合だけ結果を返す。
- statusが `"not-created"` の場合は `ExportSinkNotMaterializedError`、`"incomplete"` は `ExportSinkExecutionIncompleteError`、`"failed"` は `ExportSinkExecutionFailedError` をthrowする。
- sha256は返さない。呼出側が `result.data` に対して計算する。

戻り値union案は採用しない。通常のserialize成功型を単純に保ち、成果物を作るべきかどうかは副作用のないstatus照会で事前判定できるためである。

### 2.3 sink宣言option

`CreateExecutionContextOptions` へ次の `/flow` 専用propertyだけを加える。

```ts
export interface CreateExecutionContextOptions extends ParseScriptOptions {
  // existing fields...
  readonly exportSinks?: readonly FlowNamedExportSink[];
}
```

これは共有 `ExecuteOptions` へ追加しない。

`exportSinks` の規則は次のとおり。

1. 省略または空配列では既存context動作を変更しない。
2. `name` は空文字、先頭 `#`、kSQLのtemp table識別子として無効な文字列を許可しない。
3. 宣言名はcase-sensitiveな完全一致で比較する。暗黙の小文字化、trim、basename化はしない。
4. `name:"export"` は、同じscript内の `CREATE TEMP TABLE #export AS SELECT ...` ちょうど1文に対応しなければならない。
5. 同じ宣言名が複数ある場合は同期throwする。
6. 対応するCREATEがない、同じlive名を複数回CREATEする、対応表がDROPによって最終状態で存在しない場合は、context作成時に必ず同期throwする。
7. sink宣言検査はkintone API、文実行、encoder呼出しより前に完了する。
8. named sinkのsourceはtemp tableだけである。DML結果、通常SELECTの「最後の結果」、任意のstatement indexを暗黙にsinkへ対応させない。
9. 単文SELECTは `exportSinks` を使わず、成功した `StatementResult` を単文用serializerへ渡す。

### 2.4 値変換表

入力rowのproperty lookupはheader名の完全一致で行う。propertyが存在しない場合は `undefined` と同じ空セルにする。

| `fieldType` | 入力値の形 | CSV cell文字列 |
| --- | --- | --- |
| 任意 | `null` / `undefined` / `""` | `""` |
| 任意 | number、boolean、object、array等の非文字列 | `ExportSinkInvalidValueError` |
| scalar型 | string | そのまま |
| `NUMBER`、`CALC` | 非指数の数値文字列 | そのまま。parse／再丸めしない |
| `NUMBER`、`CALC`、`KSQL_NUMBER` | 有効な指数表記文字列 | 等価な非指数10進文字列へ字句展開 |
| 数値型 | 指数展開後が1,024文字超 | `ExportSinkInvalidValueError` |
| `CHECK_BOX`、`MULTI_SELECT`、`CATEGORY` | JSON string array | 要素を順序どおりLFで連結 |
| 上記複数値型 | 文字列 `"[]"` | 空セル |
| `USER_SELECT`、`ORGANIZATION_SELECT`、`GROUP_SELECT`、`STATUS_ASSIGNEE` | `{ code: string, ... }[]` のJSON文字列 | `code` を順序どおりLFで連結 |
| 上記主体選択型 | 文字列 `"[]"` | 空セル |
| `DATE` | `YYYY-MM-DD` | そのまま。timezone変換しない |
| `DATETIME` | ISO 8601 UTC文字列、timezone省略 | そのまま |
| `DATETIME` | ISO 8601 UTC文字列、timezone指定 | 同じinstantを指定zoneへ変換したoffset付きISO。入力のミリ秒を保持 |
| `TIME` | string | そのまま |
| `SUBTABLE` | 任意 | `ExportSinkUnsupportedColumnError` |
| `FILE` | 任意 | `ExportSinkUnsupportedColumnError` |
| fieldType不明 | string | JSON配列に見えても解釈せず、そのまま |
| 既知の複数値型 | malformed JSON、期待と異なる要素型、`code` 欠落 | `ExportSinkInvalidValueError` |
| `DATETIME` | 無効な日時文字列 | `ExportSinkInvalidValueError` |

追加規則:

- LF連結の区切りは常にU+000Aとし、host改行へ変換しない。
- USER／ORGANIZATION／GROUP／STATUS_ASSIGNEE系の `name` は出力しない。
- 不明fieldTypeを値の内容だけでJSON parseしない。
- 明示入力を受ける汎用serializerでは `columnMeta` 省略を許すが、型固有変換はmetadataが存在する列だけに適用する。
- named sinkと単文SELECTではmetadataを必須とし、取得不能をscalar扱いへfallbackしない。
- SUBTABLE errorには対象列名と `APP$明細` 仮想テーブル経由の案内を含める。
- FILE errorには対象列名と、添付ファイルexportが対象外であることを含める。

### 2.5 CSV形式

canonical CSV文字列は次を満たす。

- header行を必ず1行出力する。
- header順は `columns` の順序、data row順は `rows` の順序とする。
- cellが `"`, `,`, CR, LFのいずれかを含む場合、cell全体を `"` で囲む。
- cell内の `"` は `""` に置換する。
- record区切りはCRLFとする。
- 最終recordの後にもCRLFを付ける。
- UTF-8 BOMおよびShift_JIS BOMは付けない。
- 空結果でもheaderと末尾CRLFを返す。
- 空セルとNULLは同じ空文字になるため、CSVからのround-tripでは区別できない。
- headerの重複判定はcase-sensitiveな完全一致とする。
- 重複headerはdata row変換より前に拒否する。
- temp table経路で既に畳まれた重複列をserializerが復元しない。

### 2.6 encoding

| option | 必要条件 | 結果 |
| --- | --- | --- |
| 省略 | なし | UTF-8、BOMなし |
| `encoding:"utf8"` | encoder不要 | 標準 `TextEncoder` によるUTF-8 |
| `encoding:"sjis"` | `encoder.encoding === "sjis"` | 注入encoderのbytes |
| `encoding:"sjis"`、encoderなし | — | `ExportSinkEncoderRequiredError` |
| encoderがthrow | — | `ExportSinkEncodingError` |
| encoderが非 `Uint8Array` を返す | — | `ExportSinkInvalidEncoderResultError` |
| encoderが表現不能文字を置換せずthrow | — | `ExportSinkEncodingError`、結果なし |

encoderはCSV全体を1回で受け取る。表現不能文字でthrowすることは公開契約上の義務であり、round-trip、文字集合表、library固有APIなど、検査方式は実装者の責務とする。

CLIのCP932実装は次を必須とする。

```text
canonical text
  -> CP932 encode
  -> TextDecoder("shift_jis") でdecode
  -> canonical textとcode-unit完全一致
```

完全一致しなければbytesを破棄し、`ExportSinkEncodingError` とする。

### 2.7 receiptと同値規則

| field | 決定規則 |
| --- | --- |
| `rows` | `input.rows.length` |
| `columns` | `input.columns.length` |
| `bytes` | `result.data.byteLength` |
| `encoding` | option解決後の `"utf8"` / `"sjis"` |

同じcontext状態と同じoptionで同じsinkを複数回serializeした結果は、`data` がbyte-for-byte一致し、receipt全fieldも一致しなければならない。

`text` はencodingにかかわらず同じcanonical Unicode CSVである。UTF-8とShift_JISでは `data`、`receipt.bytes`、`receipt.encoding` が異なってよい。

### 2.8 安定error code

公開関数とcontext作成時の失敗は `KsqlFlowError` としてthrowし、次のstable codeを使う。messageへcell値、record全体、path、token、実アプリIDを含めない。

| code | 条件 |
| --- | --- |
| `ExportSinkInvalidNameError` | 空名、先頭 `#`、識別子として無効なname |
| `ExportSinkDuplicateError` | 同じsink宣言が複数、または対応CREATEが複数 |
| `ExportSinkNotFoundError` | 未宣言sink、または宣言に対応するCREATE不存在 |
| `ExportSinkNotMaterializedError` | 正常EXITにより宣言済みsinkが作成されなかった |
| `ExportSinkInvalidTargetError` | DML、複文の名前なし結果、非SELECT結果、metadataを取得できない単文SELECT |
| `ExportSinkExecutionIncompleteError` | 未処理statementが残る |
| `ExportSinkExecutionFailedError` | statement error、timeout、assertion、依存失敗 |
| `ExportSinkDuplicateHeaderError` | header完全一致の重複 |
| `ExportSinkUnsupportedColumnError` | SUBTABLEまたはFILE列 |
| `ExportSinkInvalidValueError` | 非文字列値、既知fieldTypeのshape不正、日時不正、指数構文不正、指数展開上限超過 |
| `ExportSinkInvalidTimezoneError` | 無効または未対応のIANA timezone |
| `ExportSinkEncoderRequiredError` | Shift_JIS指定でencoder未供給 |
| `ExportSinkEncodingError` | encoder throw、表現不能文字、encode後検証失敗 |
| `ExportSinkInvalidEncoderResultError` | encoder戻り値が有効な `Uint8Array` でない |
| `ExecutionContextDisposedError` | dispose済みcontext |

## 3. fail-closed 契約

### 3.1 serializer共通境界

serializerは次の順序で処理する。

```text
option・timezone・encoder shape検査
  -> header重複検査
  -> 全column metadata検査
  -> 全rowの値型・cell変換
  -> canonical CSV text確定
  -> 全体encode
  -> encoded payload検査
  -> receipt確定
  -> resultを返す
```

いずれかが失敗した場合、結果、部分bytes、receiptのいずれも返さない。途中生成物を外部callbackへ渡さない。

### 3.2 実行前sink検査

名前付きsink宣言はcontext作成時に同期検査する。失敗した場合:

- contextを返さない。
- encoderを呼ばない。
- kintone API呼出しは0回。
- statementを実行しない。
- temp tableを作らない。

CREATE不存在、同名CREATE重複、宣言重複、最終状態でのDROP済みはcontext作成時に必ず判定する。

CLIもSQL parseとbatch解析後、実行APIを呼ぶ前に次を検査する。

- option構文
- sink名重複
- 解決済み出力path重複
- 名前付きsinkとCREATE TEMP TABLEの対応
- 名前なし指定が単文SELECTであること
- DMLまたは複文の名前なし指定でないこと
- `--output` targetとの衝突

### 3.3 EXIT、未生成、実行途中の失敗

全statementを順番に処理し、EXIT後の文も `skippedReason:"exit"` として回収する。

- sink作成後に正常EXIT: statusは `"materialized"`。serialize可能。
- sink作成前に正常EXIT: statusは `"not-created"`。error終了にはせず、消費側は成果物を作らない。
- 未処理statementあり: statusは `"incomplete"`。
- error、timeout、assertion、依存失敗あり: statusは `"failed"`。

kSQL-Flow側は `"not-created"` のsinkを `output_files` へ載せず、既存fileを変更せず、既存のNO_DATA系exit codeを維持する。

CLIのbatch結果が失敗の場合:

- serializer呼出しは0回。
- 完成fileを新規作成しない。
- 既存完成fileを変更しない。
- export用一時fileを残さない。
- 通常のstatement errorとexit codeを維持する。

正常EXITで対象が未生成の場合も、新規fileを作成せず既存fileを変更しない。

### 3.4 serialize途中の失敗

複数sinkを指定した場合、CLIは `"materialized"` の全sinkをメモリ上でserializeし終えてから最初のfileを作る。`"not-created"` のsinkは対象集合から除外する。

header、値、timezone、Shift_JIS表現不能文字、encoder結果のいずれかが1sinkでも不正なら:

- どの完成fileも作成・置換しない。
- 既存完成fileを変更しない。
- receiptを外部へ渡さない。
- kintone APIを追加で呼ばない。

### 3.5 file書込み途中の失敗

file書込みはsinkごとに次の順序とする。

```text
targetのabsolute path解決
  -> 同一directory内に一時fileをexclusive create
  -> data全量write
  -> file fsync
  -> close
  -> atomic rename
  -> 必要なplatformではdirectory fsync
```

失敗時はopen handleをcloseし、未renameの一時fileを削除する。

保証単位は各完成fileである。利用者が観測できる状態は旧file全体または新file全体のいずれかであり、部分CSVを完成pathへ露出しない。

複数targetをまたぐ単一transactionは保証しない。複数renameの途中でprocess／OSが停止した場合、更新済みtargetと未更新targetが混在し得る。

### 3.6 Windowsと既存file

Windows Node 24では、同一directoryでfsync、closeした一時fileを既存fileへrenameして上書きできることを実測済みである。一方、既存fileを他processがopenしている場合は `EPERM` になり得る（`docs/internal/ksql_b179_csv_export_sink_issue.md:110-115`）。

`EPERM` を含むreplace失敗時の契約は次のとおり。

- 旧fileを維持する。
- 一時fileを削除する。
- non-zero errorとする。
- 旧fileを先に削除してからrenameするfallbackは行わない。
- 不完全な新fileを完成pathへ残さない。

## 4. 実装方針

### 4.1 `src/export/` の構成

```text
src/export/
  types.ts
  csvSerializer.ts
  cellSerializer.ts
  decimalText.ts
  dateTimeText.ts
  encoding.ts
```

責務:

- `types.ts`: engine内部serializer型
- `csvSerializer.ts`: header検査、RFC 4180 quoting、CRLF組立て、receipt
- `cellSerializer.ts`: fieldType別変換、値型検査、SUBTABLE／FILE拒否
- `decimalText.ts`: 指数表記の10進展開と1,024文字上限
- `dateTimeText.ts`: DATETIMEのtimezone変換とミリ秒保持
- `encoding.ts`: UTF-8 encode、注入Shift_JIS encoder境界

Node builtin、`Buffer`、filesystem、process、CLI、MCP、UIをimportしない。既存表示用formatterはCSV artifact契約と異なるため利用しない。

### 4.2 `/flow` 配線

`src/flow-library/exportSinks.ts` を新設し、公開DTO変換、sink宣言検査、SELECT shape検査、stable error変換、managed context参照を担当させる。

managed context作成時には内部実行optionの `captureColumnMeta` を常にtrueへ上書きする。利用者指定の有無によって単文SELECT exportの安全性を変えない。

単文SELECT serializerは公開 `StatementResult.result` と同一参照の `SelectResult` からWeakMap metadataを取得する。cloneや復元objectへのfallback、列名からのfieldType推測、全列scalar扱いは行わない。

named sink serializerはmanaged contextのtemp tableを読む。公開利用者へtemp table map、任意temp table reader、internal contextを公開しない。

### 4.3 CLI配線

現行batch実行を維持し、CLIをmanaged contextの独自statement loopへ移行しない。既存公開 `executeBatch` のsignatureと戻り値は変更せず、CLI専用の内部entry pointでbatch結果とexport対象を受け取る。

内部entry pointは:

1. 実行前sink検査を行う。
2. 現行batch処理を一度だけ実行する。
3. batchの最終状態と各sinkの実体化状態を確定する。
4. `"materialized"` の対象だけをtemp table解放前にserializeする。
5. `"not-created"` の対象を成果物集合へ含めない。
6. filesystem操作を行わない。

### 4.4 CLI option

追加option:

```text
--export-csv <name>=<path>  Export temp table #<name> as CSV (repeatable)
--export-csv <path>         Export the result of a single SELECT
--export-encoding <type>    utf8 | sjis; default utf8
--export-timezone <zone>    IANA timezone for DATETIME cells
```

引数判別規則:

1. 引数に `=` がなければ全体を名前なしpathとする。
2. 引数に `=` があれば最初の `=` だけで左辺と右辺へ分割する。
3. `=` を含む引数は必ず名前付き形式として解釈する。
4. 左辺は `#` を含まない有効なkSQL temp table識別子でなければならない。識別子でない左辺はpath扱いにfallbackせず、option構文errorとする。
5. 右辺は空であってはならない。2個目以降の `=` はpathの一部として保持する。
6. 名前なしpathには `=` を含められない。pathに `=` が必要な場合は有効な `name=` を前置する。
7. Windows drive letterの区切りは `:` であるため、`C:\...` はこの判定と衝突しない。
8. backslash、colon等を含む左辺をsink名として受理しない。

その他の規則:

- `name=path` は反復可能。
- 同じnameまたは同じ解決済みtarget pathの重複は実行前error。
- 名前なし形式は1件だけで、SQLが単文SELECTの場合だけ許可する。
- 名前付きと名前なしを同時指定できない。
- encodingとtimezoneは全sinkへ共通適用する。
- CSV bytesをstdoutへ出さない。
- `--format csv` と併用できるが、表示CSVとartifact CSVは別契約とする。
- `--output` と同じ解決済みpathを使用できない。
- receiptを既存CLI stdoutへ暗黙追加しない。

### 4.5 CLI Shift_JIS encoder

CLIだけにCP932 libraryをbundleする。第一候補は `encoding-japanese` とするが、実装前に `iconv-lite` と次を比較して採用品を確定する。

- minified前後のCLI bundle増分byte数
- CP932 encode対象範囲
- 表現不能文字の挙動
- round-trip完全一致結果
- Node 18以上での動作
- licenseと配布物への表示要否

採用品はdevDependencyとしてCLI bundleへ内包し、`package.json.dependencies` は増やさない。`/flow` bundleから参照しない。

libraryが `?` 等へ置換して成功扱いにしても、標準 `TextDecoder("shift_jis")` によるdecode結果がcanonical textと完全一致しなければthrowする。

### 4.6 atomic write

CLI専用moduleへfilesystem責務を分離する。

- targetと同じdirectoryへ一時fileをexclusive createする。
- random suffixを使い、既存fileへ追記しない。
- 短縮writeを考慮して全bytesを書き切る。
- fsync後にcloseする。
- close済み一時fileだけをrenameする。
- cleanup errorで主要errorを上書きしない。
- Windowsの `EPERM` では旧file維持、一時file削除、errorとする。
- 削除後renameへfallbackしない。

### 4.7 変更ファイル

| ファイル | 変更内容 |
| --- | --- |
| `src/export/*` | 共通serializer、値変換、指数展開、日時、encoding |
| `src/flow-library/publicTypes.ts` | export DTO、status、receipt、encoder、sink宣言 |
| `src/flow-library/exportSinks.ts` | 公開関数、sink検査、status、error正規化 |
| `src/flow-library/index.ts` | exportとmanaged context配線 |
| `src/execute.ts` | metadata取得常時有効化、temp table／batch内部seam |
| `src/cli/index.ts` | option parseと実行配線 |
| `src/cli/exportCsvFiles.ts` | atomic write |
| `src/cli/shiftJisEncoder.ts` | CP932 encodeと完全一致検査 |
| `package.json`／lockfile | CLI bundle用CP932 library |
| `scripts/flow-bundle-guard.mjs` | neutral境界の継続検証 |
| serializer／flow／CLI tests | 公開契約とplatform contract |

## 5. オーナー裁定 A/B/C

### 5-A. Shift_JIS encoder

採用: 呼出側encoder注入。

- engineと `/flow` はCP932表を持たない。
- UTF-8はengine内蔵とし、注入不要。
- Shift_JIS利用者は `FlowExportTextEncoder` を注入する。
- encoderは表現不能文字でthrowする義務を負う。
- CLIだけはCP932 libraryをbundleする。
- 第一候補は `encoding-japanese`。`iconv-lite` とのbundle増分実測後にCLI採用品を確定する。
- CP932同義文字がround-trip完全一致を満たさない場合はfail-closedを優先する。

### 5-B. 計算列の指数表記

採用: 等価な非指数10進文字列への字句展開。

入力文字列のsign、coefficient、decimal point、exponentだけを解析して桁位置を移動する。JavaScript `Number` へ再変換せず、新たな丸めを行わない。

| 入力 | 出力 |
| --- | --- |
| `1.25e+22` | `12500000000000000000000` |
| `1e-7` | `0.0000001` |
| `-0e+10` | `-0` |
| `0.3333333333333333` | そのまま |

engine由来の指数はJS `Number` の範囲により概ね±324以内で、通常の展開長は約330文字以内である。防御的上限を1,024文字とし、超過時は `ExportSinkInvalidValueError` とする。途中までのtextやbytesは返さない。

### 5-C. user系の表現

採用: `code` のLF連結。

対象はUSER_SELECT、ORGANIZATION_SELECT、GROUP_SELECT、STATUS_ASSIGNEEとする。配列順を保持し、`name` は出力しない。`code` 欠落を空文字へ変換せず `ExportSinkInvalidValueError` とする。

## 6. 後方互換

### 6.1 不変とするsurface

- 共有 `ExecuteOptions` の公開propertyと意味を変更しない。
- `/engine` の公開型、`run`、`runBatch` 契約を変更しない。
- 既存 `--format csv` のescaping、LF、表示option連携を変更しない。
- 既存 `--output` の通常表示出力をatomic artifact出力へ置き換えない。
- `--export-csv` を指定しないCLIのstdout、stderr、exit code、API回数、file書込みを変更しない。
- `exportSinks` を省略した `/flow` contextの実行順、公開 `StatementResult`、metrics、API回数を変更しない。
- 公開結果objectへcolumn metadataやreceiptを追加しない。
- IMPORT契約を変更しない。
- temp tableの既存行数・個数上限を変更しない。
- MCP／pluginへexport optionを追加しない。

### 6.2 additive export

`@rex0220/kintone-sql-tools/flow` に新しい型と関数を追加する。既存exportの削除、改名、signature変更は行わない。

ESM、CJS、declarationのすべてから同じ新APIを利用可能にする。

### 6.3 version

公開 `/flow` APIとCLI optionの純加法であるため、v3.77.0のminor releaseとする。

## 7. テスト方針

### 7.1 受入原則

- 受入条件は公開API、CLI、file、error code、API呼出し回数から観測する。
- 内部関数の呼出し自体を受入条件にしない。
- serializer、named sink、単文SELECTで同じCSV bytesになることを確認する。
- fail-closedケースでは結果、部分bytes、receipt、完成fileがないことを確認する。
- 動的なplatform挙動はWindowsとPOSIXで分けて固定する。

### 7.2 serializer matrix

| ケース | 公開期待値 |
| --- | --- |
| scalar | 入力文字列を保持 |
| number／object等の非文字列 | `ExportSinkInvalidValueError` |
| `null`／`undefined`／`""` | 空セル |
| `"[]"` の複数値 | 空セル |
| 複数値2件 | LF連結され、CSV cellはquoteされる |
| user系 | `code` のLF連結 |
| fieldType不明のJSON風文字列 | 生文字列を保持 |
| SUBTABLE／FILE | `ExportSinkUnsupportedColumnError` |
| `"`、`,`、CR、LF | RFC 4180 quoting |
| 重複header | row変換前に `ExportSinkDuplicateHeaderError` |
| 空結果 | header＋CRLF |
| 指数表記 | 丸めなしの10進展開 |
| 1,024文字以内 | 成功 |
| 1,024文字超 | `ExportSinkInvalidValueError` |
| DATETIME既定 | 入力UTC ISOを保持 |
| DATETIME＋timezone | offset付きISO、ミリ秒保持 |
| invalid timezone | `ExportSinkInvalidTimezoneError` |
| UTF-8 | BOMなし、byte数一致 |
| Shift_JIS成功 | 注入encoderのbytes |
| encoderなし | `ExportSinkEncoderRequiredError` |
| 表現不能文字 | `ExportSinkEncodingError`、結果なし |
| encoder非bytes | `ExportSinkInvalidEncoderResultError` |
| 同じinputを2回 | text、data、receiptが一致 |

### 7.3 `/flow` matrix

| ケース | 公開期待値 |
| --- | --- |
| 宣言1件＋対応CREATE1件 | context作成成功 |
| sink宣言重複 | 同期throw、API 0回 |
| 対応CREATE不存在 | 同期throw、API 0回 |
| 対応CREATE重複 | 同期throw、API 0回 |
| 最終状態でDROP済み | context作成時に同期throw、API 0回 |
| 単文SELECT成功 | canonical CSVを取得 |
| 単文SELECTの複数値 | named sinkと同じLF変換 |
| 単文SELECTのSUBTABLE／FILE | named sinkと同じ拒否 |
| clone／JSON復元したSELECT結果 | `ExportSinkInvalidTargetError` |
| 単文DML結果 | `ExportSinkInvalidTargetError` |
| 全文処理前 | status `"incomplete"`、serializeは実行不完全error |
| sink作成後に正常EXIT | status `"materialized"`、serialize成功 |
| sink作成前に正常EXIT | status `"not-created"`、直接serializeは未実体化error |
| EXIT後skipを全件回収 | 処理完了と判定 |
| statement error | status `"failed"`、serializeは実行失敗error |
| dispose後 | `ExecutionContextDisposedError` |
| sink上限内 | receipt row数が一致 |
| temp table行上限超過 | CREATEがerror、結果なし |
| sink宣言省略 | 既存公開結果、metrics、API回数がgolden一致 |
| serialize／status照会 | API回数が前後で不変 |

### 7.4 CLI matrix

| ケース | 公開期待値 |
| --- | --- |
| `name=path` 1件 | 成功時だけ完成file |
| pathに2個目以降の `=` | 最初の `=` だけで分割し、残りをpathへ保持 |
| `bad:left=path` | 名前なしpathへfallbackせず構文error |
| 名前なしpathに `=` | 使用不可。名前付き指定を要求 |
| Windows absolute path | drive letterの `:` を名前区切りと誤認しない |
| 複数sink | 各fileが対応sinkのCSV |
| 単文SELECT＋名前なしpath | 完成file生成 |
| 複文／DML＋名前なしpath | 実行前error、API 0回、fileなし |
| sink不存在／重複／DROP済み | 実行前error、API 0回、fileなし |
| sink作成後EXIT | 作成済みfileだけ生成 |
| sink作成前EXIT | fileを新規作成せず、既存file不変、NO_DATA系exit code維持 |
| SQL途中error | 完成fileなし、既存file不変、一時fileなし |
| serializer error | 全target不変、一時fileなし |
| Shift_JIS成功 | CP932 bytes、BOMなし |
| Shift_JIS表現不能文字 | non-zero、完成fileなしまたは既存file不変 |
| write／fsync／close失敗 | renameせず、旧file維持、一時file cleanup |
| rename `EPERM` | non-zero、旧file維持、一時file cleanup |
| 新規target | 完成fileだけが残る |
| 既存target | 成功時に全量置換 |
| `--format csv` のみ | v3.76.0 goldenとbyte-for-byte一致 |
| `--output` のみ | v3.76.0 goldenと一致 |
| `--export-csv`＋`--format csv`／`--output` | stdoutおよび通常出力fileがv3.76.0 goldenと一致し、export fileだけがB179形式 |
| `--output` と同じexport path | 実行前error |
| quiet等既存option | receiptをstdoutへ追加しない |

### 7.5 platform contract

WindowsとPOSIXで次を固定する。

- 同一directoryの新規rename
- 既存fileへのreplace
- open handleが残る場合
- read-only target
- rename直前のtarget生成競合
- Unicode path
- cleanup時に一時fileが既にない場合
- process中断後に残り得るstaged file
- Windows `EPERM` で旧file維持、一時file削除、error
- 削除後renameへfallbackしないこと

### 7.6 bundle・配布検証

- `npm run build:flow`
- `npm run flow:bundle-guard`
- `npm run build:cli`
- `npm pack --dry-run --json`
- tarballから `/flow` のESM import
- tarballから `/flow` のCJS require
- declarationだけを使うTypeScript compile
- neutral `/flow` bundleのNode builtin import 0
- neutral `/flow` bundleのCP932 table／CLI module混入0
- `package.json.dependencies` 追加0
- CLI bundle単体でShift_JIS export可能
- CP932 library採用前後のCLI bundle増分を記録

## 8. 文書・リリース

### 8.1 更新文書

| 文書 | 更新内容 |
| --- | --- |
| `README.md` | `/flow` CSV serializerとCLI例 |
| `docs/ksql_language_reference.md` | named sink、単文SELECT、EXIT未生成 |
| CLI help | option構文、最初の `=`、名前付き／名前なし制約、atomic write |
| `/flow` API reference | 型、関数、status、receipt、error、encoder義務 |
| B179起票 | PR、test、実測、release結果 |
| `CHANGELOG.md` | v3.77.0 additive API／CLI feature |
| kSQL-Flow側Contract | `features.resultCsv`、`output_files[]`、未生成sink |

### 8.2 公開例

```ts
import {
  createExecutionContext,
  executeStatement,
  exportSinkStatus,
  serializeExportSink,
  disposeExecutionContext,
} from "@rex0220/kintone-sql-tools/flow";

const context = createExecutionContext({
  client,
  script: `
    CREATE TEMP TABLE #export AS
    SELECT code, amount FROM APP1;
  `,
  exportSinks: [{ name: "export" }],
});

try {
  // 全statementを順番に処理し、EXIT後のskipも回収する。
  if (exportSinkStatus(context, "export") === "materialized") {
    const csv = serializeExportSink(context, "export");
    // csv.dataの保存は呼出側の責務。
  }
} finally {
  await disposeExecutionContext(context);
}
```

単文SELECT:

```ts
const result = await executeStatement(statement, context);
const csv = serializeSelectResultAsCsv(result, {
  encoding: "utf8",
});
```

### 8.3 kSQL-Flow連携

kSQL-Flowは:

1. 全statementを処理し、EXIT後のskipも回収する。
2. 各sinkのstatusを確認する。
3. `"materialized"` のsinkだけをdispose前にserializeする。
4. `"not-created"` のsinkは `output_files` へ載せず、既存fileを変更しない。
5. `"failed"`／`"incomplete"` は成果物処理へ進めない。
6. `data` を自身のallowlist済みabsolute pathへatomic writeする。
7. `data` からsha256を計算する。
8. receiptとsha256をExecution Resultへ転記する。

```json
{
  "output_files": [
    {
      "name": "export",
      "sha256": "<64hex>",
      "bytes": 1234,
      "rows": 100,
      "encoding": "utf8"
    }
  ]
}
```

正常EXITでsinkが `"not-created"` の場合は該当entryを作らず、既存fileを維持し、NO_DATA系exit codeを変更しない。

engineはabsolute path、sha256、allowlist、保持期限、Execution Result JSONを扱わない。

### 8.4 3段PR

#### PR 1: serializer

範囲:

- browser-neutral serializer
- RFC 4180
- 値変換
- 10進展開
- timezone変換
- UTF-8／注入encoder
- receipt

受入条件:

- 明示入力からcanonical CSVとbytesを生成できる。
- 複数値、空配列、非文字列、unsupported列、重複header、指数、ミリ秒、encodingのmatrixが通る。
- Node builtin、filesystem、path、URL、file handleを公開型またはbundleへ持ち込まない。
- 既存CLIおよび `/flow` の挙動を変更しない。

完了条件:

- serializerのtargeted testsが成功する。
- flow bundle guardが成功する。
- 10進展開の1,024文字上限が固定される。
- 後続PRが同じserializerを再実装せず利用できる内部境界が確定する。

#### PR 2: `/flow`

範囲:

- 公開型と公開serializer関数
- sink事前宣言
- sink status
- WeakMap metadata取得
- managed contextのmetadata取得常時有効化
- named sink／単文SELECTの契約統一

受入条件:

- named sinkと単文SELECTが同じbytesを返す。
- 単文SELECTでも複数値変換とSUBTABLE／FILE拒否が働く。
- metadataを持たないSELECT風objectを拒否する。
- sink作成前／後のEXITを `"not-created"`／`"materialized"` と判別できる。
- sink宣言省略時の公開結果、metrics、API回数が既存goldenと一致する。
- ESM、CJS、declarationから新APIを利用できる。

完了条件:

- `/flow` のtargeted testsが成功する。
- full testとflow build／bundle guardが成功する。
- neutral bundleにNode builtin、CP932 table、CLI moduleが含まれない。
- 公開API文書とerror code一覧が更新される。

#### PR 3: CLI

範囲:

- batch内部seam
- `--export-csv`
- 最初の `=` による引数判定
- CLI専用CP932 encoder
- atomic write
- Windows／POSIX contract
- release文書

受入条件:

- 名前付き／名前なしexportが契約どおり動作する。
- path内の `=`、無効な左辺、Windows drive letterを規則どおり処理する。
- 正常EXITで未生成sinkのfileを作らず、既存fileとNO_DATA系exit codeを維持する。
- 全sinkのserialize成功前に完成fileへ書かない。
- Windows `EPERM` で旧file維持、一時file削除、errorとなる。
- `--export-csv` 併用時も `--format csv`／`--output` の結果がv3.76.0 goldenと一致する。
- `/flow` bundleへCP932実装が混入しない。

完了条件:

- CP932 library比較結果と採用理由を記録する。
- CLI、Windows、POSIXのtargeted testsが成功する。
- full test、CLI build、flow build、bundle guard、tarball smokeが成功する。
- README、language reference、CLI help、CHANGELOG、B179起票を更新する。
- v3.77.0 release candidateでkSQL-Flow連携試験へ進める。

## 9. Claude が実測すべき未確認事項

次は実装前後に実測する。結果が公開契約と矛盾する場合、実装で暗黙に契約を弱めず、R2改訂またはオーナー判断へ戻す。

1. FILE列とSUBTABLE列のmetadataがSELECT／CTE／temp tableの全対象経路で保持されるか。
2. wildcard、UNION、CTEを経た既知fieldのmetadata欠落範囲。
3. 重複header検査をmetadata参照より先に確実に行えるか。
4. IANA timezone変換がすべてのミリ秒桁を保持するか。
5. DST fold／gap instantのoffset出力。
6. `Intl.DateTimeFormat` 利用時のneutral browser／Node 18間の一致。
7. 採用候補CP932 libraryが表現不能文字をthrowするか、置換するか。
8. CP932 round-tripで波ダッシュ、全角チルダ、円記号、backslash等が完全一致するか。
9. `encoding-japanese` と `iconv-lite` のCLI bundle増分byte数。
10. `/flow` ESM／CJS bundleへCP932 tableが混入していないこと。
11. Windowsでantivirus／indexerが一時的にhandleを保持した場合のrename error。
12. Windowsでreplace失敗後に旧fileと一時fileが契約どおりの状態になること。
13. POSIXでfile fsync後にdirectory fsyncを行う実装とtest環境対応。
14. 複数sink rename途中のprocess強制終了時に観測されるfile集合。
15. target pathのcase-insensitive重複をWindowsで実行前検出できるか。
16. `--export-csv name=path=with=equals.csv` と無効左辺の実装結果が§4.4どおりであること。
17. temp tableをCREATE後DROPし、同名再CREATEするscriptとsink宣言の静的判定。
18. 正常EXIT後の未実行statementをmanaged `/flow` 呼出側が最後までskipとして回収する運用。
19. `tempTableMaxRows` 超過時の公開error code。
20. registry tarballのESM、CJS、declarationから全新型・関数を利用できること。
21. `package.json.dependencies` を空のままCLI Shift_JISが実行できること。
22. `--format csv`、`--output` の既存goldenがB179後もbyte-for-byte不変であること。

## 10. 見積り

| PR | 作業 | 見積り |
| --- | --- | ---: |
| 1 | serializer型、RFC 4180、receipt | 0.5〜0.8人日 |
| 1 | fieldType別変換、unsupported列、指数展開 | 0.7〜1.1人日 |
| 1 | timezone変換と境界test | 0.4〜0.7人日 |
| 2 | `/flow` sink宣言、status、公開関数 | 0.8〜1.2人日 |
| 2 | WeakMap metadata配線と単文SELECT回帰 | 0.4〜0.7人日 |
| 3 | batch完了内部seam | 0.5〜0.9人日 |
| 3 | CLI optionと引数判定 | 0.6〜1.0人日 |
| 3 | CP932 library比較、encoder、round-trip | 0.6〜1.0人日 |
| 3 | atomic writeとWindows／POSIX test | 0.8〜1.4人日 |
| 1〜3 | bundle、declaration、tarball smoke | 0.3〜0.5人日 |
| 3 | 文書、CHANGELOG、release metadata | 0.3〜0.5人日 |
|  | 合計 | **5.9〜9.8人日** |

別見積り:

- kSQL-Flowのabsolute path／allowlist、sha256、Execution Result `output_files[]`
- kSQL-FlowNetのnetwork schema、retention、resume整合
- MCP／plugin export配線
- ストリーミングserializer
- 複数output fileを跨ぐtransactional commit
- 独立した標準CP932 encoder package


---

## R2 レビュー（Claude・2026-09-04）

**判定: R2 を実装可とする（flownet セッションの消費側レビューを経て PR 1 から着手）。** R1 レビュー・消費側レビューの要求 10 点はすべて本文に反映されている。下記は実装時に反映する小さな修正と、実測で解消した §9 項目。

### CP932 library の実測（§9-7・8・9 を解消）

scratchpad で `encoding-japanese@2` と `iconv-lite@0.6` を実際に bundle・実行した。

| 観点 | encoding-japanese | iconv-lite |
|---|---|---|
| CLI bundle 増分（esbuild・node・CJS・minify） | **231 KB** | 494 KB |
| license | MIT | MIT |
| 表現不能文字（絵文字・ハングル・波ダッシュ U+301C・ダッシュ U+2014） | **`?` へ黙って置換・throw しない** | 同左 |
| 円記号 U+00A5 | `?` | `0x5C`（backslash）に置換 |
| マイナス U+2212 | `0x817C`（decode すると U+FF0D 全角ハイフン） | `?` |
| 全角チルダ U+FF5E・backslash・ローマ数字Ⅰ・丸数字①・髙﨑・半角カナ | round-trip 一致 | 同左 |

→ **採用品は `encoding-japanese` で確定**（増分がほぼ半分・日本語専用・MIT）。どちらも throw しないので、§2.6 の「encode → `TextDecoder("shift_jis")` → 完全一致」検査は必須であり、この検査で U+301C / U+00A5 / U+2212 / U+2014 / 絵文字 / ハングルは fail-closed になる（`?` や別文字への置換を完成 file に残さない）。**U+2212 のように「もっともらしい別文字」へ写る場合も拒否する**のが正しい（round-trip 完全一致の規則どおり）。

### 実装時に反映する修正（Minor）

1. **§2.8 の message 規則の補足**: `ExportSinkEncodingError` と `ExportSinkInvalidValueError` は「cell 値を含めない」だけだと利用者が原因文字を特定できない。**行番号（data row の 1 始まり）・列名・問題の code point（例 `U+301C`）は message に含めてよい**（cell 全文・record 全体は含めない）と明記する。CLI の round-trip 検査は最初の不一致位置を code point で報告する。
2. §1.5 の表「DATETIME field は通常は秒精度」→ 実測どおり「kintone field は秒精度・dialect 1 の `@NOW()` はミリ秒付き」と書き分ける（本文 §1.5 末尾に既にある記述と表を揃える）。
3. §4.5 の「実装前に比較して確定」は本節の実測で完了。PR 3 の完了条件「CP932 library 比較結果と採用理由を記録」は本節への参照で満たす。
4. §9 から 7・8・9 を外し、残り 19 項目を PR ごとに割り当てる（PR 1: 1〜6・3、PR 2: 17〜20、PR 3: 10〜16・21・22）。

### 静的主張の照合

- §1.1 `captureColumnMeta` の存在と既定 false・WeakMap 保持（`src/execute.ts:465-470`）＝一致。
- §1.3 EXIT skip は失敗集合へ入らない（`managed.aborted !== "exit"` のときだけ `failed.add`・`src/execute.ts:1964` 相当）＝一致。
- §1.2 `executeStatement` が `result` の参照を維持する（`{ ...internal, kind, metrics }`・`src/flow-library/index.ts:260`）＝一致。単文経路の WeakMap 取得は成立する。

### 次の工程

flownet 消費側レビュー（特に `exportSinkStatus` の 4 値と `"not-created"` の扱い・encoder message 規則）→ codex 実装 PR 1（serializer）→ Claude 実測・レビュー → PR 2（/flow）→ PR 3（CLI）→ v3.77.0。
