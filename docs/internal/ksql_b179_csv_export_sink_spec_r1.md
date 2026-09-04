# B179 CSV export（名前付きシンク・engine serializer・`/flow` 公開 API）仕様 R1

- 状態: 仕様 R1
- 対象版: v3.77.0
- 変更種別: minor・純加法
- 上流要求: `ksql-flownet/docs/internal/csv-io-implementation-plan.md` §4.1〜§4.2
- 関連: B177 named IMPORT source、B178 materialized receipt
- 対象外: MCP／プラグインへの export 配線、ストリーミング export、cli-kintone のサブテーブル `*` 形式

## 0. 結論

B179 は、CSV 方言を `src/export/` の browser-neutral serializer へ一元化し、CLI と公開 `/flow` API から同じ実装を利用できるようにする。

1. serializer は `{ columns, rows, columnMeta? }` を受け、Unicode CSV文字列、指定encodingの `Uint8Array`、`rows / columns / bytes / encoding` receiptを返す。path、URL、file handleは受け取らず、ファイルを書かない。
2. headerは現在のresult列名をそのまま使う。完全一致する重複headerはserialize前に拒否する。明示aliasの既存小文字化は変更しない。
3. CSV形式はheaderあり、RFC 4180 quoting、CRLF record区切り、BOMなしとする。
4.既知の複数値fieldはJSON配列文字列をLF連結へ変換する。USER／ORGANIZATION／GROUP／STATUS_ASSIGNEE系は各要素の `code` を使う。fieldType不明の式列はJSONに見えても解釈せず、生文字列を保持する。
5. SUBTABLEとFILE列はserialize前に拒否する。サブテーブルを出力する場合は `APP$明細` 仮想テーブルをSELECTする。
6. 名前付きsinkは宣言名 `name` とtemp table `#name` を完全一致で対応させる。公開 `/flow` context作成時に宣言重複、CREATE不存在、CREATE重複、利用不能なtargetを同期拒否する。
7. `/flow` は、context内の名前付きsinkをserializeする関数、任意のmaterialized inputをserializeする純関数、単文SELECTの `StatementResult` をserializeする純関数を公開する。通知callbackは追加せず、呼出結果としてreceiptを直接返す。
8. Shift_JISは呼出側encoder注入方式を推奨する。`/flow` bundleへCP932表やNode builtinを入れない。CLIはCP932実装をCLI bundleだけへ取り込み、encode後のround-trip検査によって表現不能文字をfail-closedにする。
9. 計算列の指数表記は、指数を持たない等価な10進文字列へ展開する方式を推奨する。浮動小数点数を再計算せず、既に得られた10進文字列を字句的に展開する。
10. CLIは新しい反復可能な `--export-csv <name>=<path>` と、単文SELECT専用の `--export-csv <path>` を追加する。既存 `--format csv` と `--output` は変更しない。
11. CLIはSQL全文成功後に全sinkをメモリ上でserializeしてから、一時fileへのwrite、fsync、close、同一directory内renameを行う。途中失敗では不完全な完成fileを残さない。
12. `/engine` export、共有 `ExecuteOptions`、既存CLI出力、IMPORT契約は変更しない。

## 1. 現状調査

### 1.1 resultとmaterialized table

SELECT結果は `rows: ProcessRow[]`、列定義順の `columns: string[]`、`rowCount` を保持する（`src/execute.ts:418-424`）。

temp tableの実体は次の形である。

```ts
interface MaterializedTable {
  readonly rows: ProcessRow[];
  readonly columns: string[];
  readonly columnMeta?: ReadonlyMap<string, MaterializedColumnMeta>;
}
```

`MaterializedColumnMeta` は `displayName`、`sortKind`、`fieldType`、`semantics`、`publicSourceApp` を保持する（`src/execute.ts:440-455`）。CREATE TEMP TABLEの成功時にはSELECT結果の `rows`、`columns`、column metadataが同じtemp tableへ保存される（`src/execute.ts:2491-2505`）。

起票 §2.1 の実測結果を正として、直接field参照のresult列名は既に正式field codeであり、追加の `getFields` header復元は行わない。式、計算列、明示aliasも現在のresult列名を使う。

### 1.2 managed `/flow` context

公開 `CreateExecutionContextOptions` はscriptまたはstatementsと、実行optionを受ける（`src/flow-library/publicTypes.ts:195-230`）。context作成時にはscript全体のparseとbatch解析が行われ、managed stateへstatements、analysis、temp tableの `Map`、実行順、失敗状態が保持される（`src/flow-library/index.ts:117-174`、`src/execute.ts:1846-1868,1892-1960`）。

`executeStatement` は登録順を検査し、成功、error、skippedを `StatementResult` として返す（`src/flow-library/index.ts:240-261`）。contextは明示的にdisposeされ、dispose後はmanaged stateへアクセスできない（`src/flow-library/index.ts:268-274`）。

したがって名前付きsinkは、最後の文の実行後かつdispose前に同じmanaged contextのtemp tableをserializeできる。

### 1.3 batch実行境界

`executeBatch` は全文をparse／解析した後、共有temp table mapを使って文を順次実行する（`src/execute.ts:1657-1669,1709-1723,1777-1795`）。実行時errorは文ごとの `status:"error"` として記録され、既定では後続文がfail-fastでskipされる（`src/execute.ts:1809-1829`）。戻り値の `ok` は、全結果がsuccessまたは正常なEXITによるskipの場合だけtrueになる（`src/execute.ts:1832-1840`）。

現在のbatch戻り値にはtemp table本体が含まれないため、CLI exportにはbatch完了時点でtemp tableを読み出す内部seamが必要である。

### 1.4 既存CLI CSV

既存 `--format csv` は表示用変換を通し、`,`、`"`、LFだけをquote判定に使い、LFでrecordを結合する（`src/cli/index.ts:896-918`）。既存 `--output` は生成済み表示文字列を `writeFileSync` で直接書く（`src/cli/index.ts:1028-1039`）。

B179の `--export-csv` はこの経路とは別契約とし、既存 `--format csv`、表示option、`--output` の意味を変更しない。

### 1.5 encodingとbundle境界

IMPORTのShift_JIS対応は `TextDecoder("shift_jis")` によるdecodeであり、encode機能ではない（`src/import/csvDecoder.ts:6-12`）。

`/flow` はneutral platform向けにもbundleされる（`build-flow.mjs:21-39`）。bundle guardはNode builtin、CLI、MCP、plugin UI等の混入をfail-closedで検査する（`scripts/flow-bundle-guard.mjs:11-23,29-51`）。

CLIはNode向け単一bundleであり、依存moduleをbundleできる構成である（`build-cli.mjs:10-17`）。現行 `package.json` はruntime `dependencies` を持たず、build用moduleは `devDependencies` に置かれている（`package.json:78-90`）。

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

  /** 各値はengine resultと同じ文字列表現。null/undefinedも空セルとして受理する。 */
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
   * 置換文字による継続は禁止し、表現不能文字ではthrowする。
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
  /** headerを除くdata row数。 */
  readonly rows: number;

  /** header列数。 */
  readonly columns: number;

  /** 実際に返したencoded payloadのbyteLength。 */
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
```

`bytes` はreceipt内ではbyte数、payloadは `data` と命名して混同を避ける。Node `Buffer`、path、URL、file handleは公開型に含めない。

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

export function serializeExportSink(
  context: ExecutionContext,
  name: string,
  options?: FlowCsvExportOptions
): FlowCsvExportResult;
```

規則は次のとおり。

- `serializeCsvExport` は純関数であり、kintone API、filesystem、clock、host timezoneへアクセスしない。
- `serializeSelectResultAsCsv` は `status:"success"` かつ `result.type === "SELECT"` の `StatementResult` だけを受理する。単文SELECTの名前省略exportはこの関数で実現する。
- `serializeExportSink` はcontext作成時に宣言済みのsinkだけを受理する。
- `serializeExportSink` は、登録された全statementが処理済みで、errorまたは異常skipがなく、contextがdisposeされていない場合だけ結果を返す。
- 3関数は同じ `src/export/` serializerを使い、独自の値変換やCSV quotingを持たない。
- sha256は返さない。呼出側が `result.data` に対して計算する。

### 2.3 sink宣言option

`CreateExecutionContextOptions` へ次の `/flow` 専用propertyだけを加える。

```ts
export interface CreateExecutionContextOptions extends ParseScriptOptions {
  // existing fields...
  readonly exportSinks?: readonly FlowNamedExportSink[];
}
```

これは共有 `ExecuteOptions` へ追加しない。`src/flow-library/index.ts` でdestructureし、managed contextへ専用引数として渡す。

`exportSinks` の規則は次のとおり。

1. 省略または空配列では、既存context動作を一切変えない。
2. `name` は空文字を許可せず、先頭の `#` を含めない。
3. 宣言名はcase-sensitiveな完全一致で比較する。暗黙の小文字化、trim、basename化はしない。
4. `name:"export"` は、同じscript内の `CREATE TEMP TABLE #export AS SELECT ...` ちょうど1文に対応しなければならない。
5. 同じ宣言名が複数ある場合、後勝ちにせず同期throwする。
6. 対応するCREATEがない、同じ名前を複数回CREATEする、対応表がDROPによって最終時点に存在しないことが静的に確定する場合はcontext作成時に同期throwする。
7. sink宣言検査はkintone API呼出し、文実行、encoder呼出しより前に完了する。
8. named sinkのsourceはtemp tableだけである。DML結果、通常SELECTの「最後の結果」、任意のstatement indexを暗黙にsinkへ対応させない。
9. 単文SELECTは `exportSinks` を使わず、成功した `StatementResult` を `serializeSelectResultAsCsv` へ渡す。

CREATE TEMP TABLE名が `#` を含むことは現行AST契約である（`src/types/ast.ts:97-101`）。

### 2.4 値変換表

入力rowのproperty lookupはheader名の完全一致で行う。propertyが存在しない場合は `undefined` と同じ空セルにする。

| `fieldType` | 入力値の形 | CSV cell文字列 |
| --- | --- | --- |
| 任意 | `null` / `undefined` / `""` | `""` |
| `SINGLE_LINE_TEXT`、`MULTI_LINE_TEXT`、`RICH_TEXT`、`LINK`、`DROP_DOWN`、`RADIO_BUTTON`、`RECORD_NUMBER`、`CREATOR`等のscalar | string | そのまま |
| `NUMBER`、`CALC` | 非指数の数値文字列 | そのまま。parse／再丸めしない |
| `NUMBER`、`CALC`、`KSQL_NUMBER` | 有効な指数表記文字列 | §5-Bに従って等価な非指数10進文字列へ字句展開 |
| `CHECK_BOX`、`MULTI_SELECT`、`CATEGORY` | JSON string array | 要素を順序どおりLFで連結 |
| `USER_SELECT`、`ORGANIZATION_SELECT`、`GROUP_SELECT`、`STATUS_ASSIGNEE` | `{ code: string, ... }[]` のJSON文字列 | `code` を順序どおりLFで連結 |
| `DATE` | `YYYY-MM-DD` | そのまま。timezone変換しない |
| `DATETIME` | ISO 8601 UTC文字列、`timezone` 省略 | そのまま |
| `DATETIME` | ISO 8601 UTC文字列、`timezone` 指定 | 同じinstantを指定IANA timezoneへ変換した `YYYY-MM-DDTHH:mm:ss±HH:mm` |
| `TIME` | string | そのまま。timezone変換しない |
| `SUBTABLE` | 任意 | error |
| `FILE` | 任意 | error |
| `fieldType` 不明 | 任意のstring | JSON配列に見えても解釈せず、そのまま |
| 既知の複数値型 | malformed JSON、期待と異なる要素型、`code` 欠落 | error |
| `DATETIME` | 無効な日時文字列 | error |

追加規則:

- 複数値の空配列は空セルになる。
- LF連結の区切りは常にU+000Aであり、host改行へ変換しない。
- user系の `name`、組織名、group名は出力しない。
- 不明fieldTypeを内容だけでJSON parseしない。式が偶然 `["a","b"]` という文字列を返した場合も文字列として保持する。
- `columnMeta` がないinputでもscalar exportは可能だが、SUBTABLE／FILE拒否や複数値変換を保証するにはmetadataを渡さなければならない。名前付きtemp sinkは保持済みmetadataを必ず渡す。
- `SUBTABLE` errorのmessageには対象列名と、`APP$明細` 仮想テーブル経由でSELECTする案内を含める。
- `FILE` errorのmessageには対象列名を含め、添付ファイルexportが対象外であることを示す。

### 2.5 CSV形式

canonical CSV文字列は次を満たす。

- header行を必ず1行出力する。
- header順は `columns` の順序とする。
- data row順は `rows` の順序とする。
- cellが `"`、`,`、CR、LFのいずれかを含む場合、cell全体を `"` で囲む。
- cell内の `"` は `""` に置換する。
- record区切りはCRLFとする。
- 最終recordの後にもCRLFを付ける。
- UTF-8 BOMおよびShift_JIS BOMは付けない。
- 空結果でもheaderと末尾CRLFを返す。
- 空セルとNULLは同じ空文字になるため、CSVからのround-tripでは区別できない。
- headerの重複判定はcase-sensitiveな文字列完全一致とする。`code` と `Code` は異なるheader、`code` と `code` は重複である。
- 重複headerはdata rowを変換する前に拒否する。

### 2.6 encoding

| option | 必要条件 | 結果 |
| --- | --- | --- |
| 省略 | なし | UTF-8、BOMなし |
| `encoding:"utf8"` | `encoder` は不要 | 標準 `TextEncoder` によるUTF-8 |
| `encoding:"sjis"` | `encoder.encoding === "sjis"` | 注入encoderのbytes |
| `encoding:"sjis"`、encoderなし | — | `ExportSinkEncoderRequiredError` |
| encoderがthrow | — | `ExportSinkEncodingError` |
| encoderが非 `Uint8Array` を返す | — | `ExportSinkInvalidEncoderResultError` |
| encoderが置換を検出してthrow | — | `ExportSinkEncodingError`、結果なし |

encoderはCSV全体を1回で受け取る。cell単位またはchunk単位の部分bytesを外部へ通知しない。

### 2.7 receiptと同値規則

receiptの各fieldは次のように決定する。

| field | 決定規則 | 同値規則 |
| --- | --- | --- |
| `rows` | `input.rows.length` | 非負整数の完全一致 |
| `columns` | `input.columns.length` | 非負整数の完全一致 |
| `bytes` | `result.data.byteLength` | 非負整数の完全一致 |
| `encoding` | option解決後の `"utf8"` / `"sjis"` | literal完全一致 |

同じsinkを複数回serializeした結果の同値判定は、同じcontext状態と同じoptionに対する `data` のbyte-for-byte一致、およびreceipt全fieldの一致とする。

`text` はencodingにかかわらず同じcanonical Unicode CSVである。UTF-8とShift_JISでは `data` と `receipt.bytes / encoding` が異なってよい。

### 2.8 安定error code

公開関数とcontext作成時の失敗は `KsqlFlowError` としてthrowし、次のstable codeを使う。messageへcell値、record全体、path、token、実アプリIDを含めない。

| code | 条件 |
| --- | --- |
| `ExportSinkInvalidNameError` | 空名、先頭 `#`、公開契約外のname |
| `ExportSinkDuplicateError` | 同じsink宣言が複数、または対応するCREATEが複数 |
| `ExportSinkNotFoundError` | 宣言に対応するCREATEまたは実体化済みtemp tableがない |
| `ExportSinkInvalidTargetError` | DML、複文の名前なし結果、非SELECT結果、DROP済みtemp tableを指定 |
| `ExportSinkExecutionIncompleteError` | 登録statementが最後まで処理される前にserialize |
| `ExportSinkExecutionFailedError` | statement error、timeout、assertion、依存失敗後にserialize |
| `ExportSinkDuplicateHeaderError` | header完全一致の重複 |
| `ExportSinkUnsupportedColumnError` | SUBTABLEまたはFILE列 |
| `ExportSinkInvalidValueError` | 既知fieldTypeの値shape不正、日時不正、数値指数構文不正 |
| `ExportSinkInvalidTimezoneError` | 無効または未対応のIANA timezone |
| `ExportSinkEncoderRequiredError` | Shift_JIS指定でencoder未供給 |
| `ExportSinkEncodingError` | encoder throw、表現不能文字、encode後検証失敗 |
| `ExportSinkInvalidEncoderResultError` | encoder戻り値が有効な `Uint8Array` でない |
| `ExecutionContextDisposedError` | dispose済みcontext |

既存error正規化は、固有のError nameまたはmessage先頭の `PascalCaseError:` をcodeとして保持する（`src/flow-library/errors.ts:13-24`）。

## 3. fail-closed 契約

### 3.1 serializer共通境界

serializerは次の順序で処理する。

```text
option・timezone・encoder shape検査
  -> header重複検査
  -> 全column metadata検査
  -> 全rowのcell変換
  -> canonical CSV text確定
  -> 全体encode
  -> encoded payload検査
  -> receipt確定
  -> resultを返す
```

いずれかが失敗した場合、`FlowCsvExportResult`、部分 `data`、receiptのいずれも返さない。内部で途中まで構築した文字列やbytesは外部callbackへ渡さない。

### 3.2 実行前sink検査

名前付きsink宣言はcontext作成時に同期検査する。この検査で失敗した場合:

- contextを返さない。
- encoderを呼ばない。
- kintone mock clientの全API呼出しは0回。
- statementを1文も実行しない。
- temp tableを作らない。

CLIの `--export-csv` 指定も、SQL parseとbatch解析後、実行APIを呼ぶ前に次を検査する。

- option構文
- sink名重複
- 出力path重複
- 名前付きsinkとCREATE TEMP TABLEの対応
- 名前なし指定が単文SELECTであること
- DMLまたは複文の名前なし指定でないこと
- `--export-csv` のtargetが既存 `--output` targetと衝突しないこと

pathの存在、directory、権限等、filesystemでしか確定しない条件は書込み準備段階で検査する。

### 3.3 実行途中の失敗

名前付きsinkのCREATEが成功していても、その後のstatementがerrorになった場合はserializeしない。

公開 `/flow` では、全statementを順番に `executeStatement` した後、全結果がsuccessまたは正常なEXITによるskipである場合だけ `serializeExportSink` が成功する。error、timeout、assertion、依存失敗を含む場合は `ExportSinkExecutionFailedError` をthrowする。

CLIではbatch結果が成功でない場合:

- serializer呼出し回数は0回。
- export先の完成fileを新規作成しない。
- 既存完成fileを変更しない。
- export用一時fileを残さない。
- 通常のstatement errorとexit codeを維持する。

### 3.4 serialize途中の失敗

複数sinkを指定した場合、CLIは全sinkのserializer結果をメモリ上で確定してから最初のfileを作る。

header、値、timezone、Shift_JIS表現不能文字、encoder結果のいずれかが1sinkでも不正なら:

- どの完成fileも作成・置換しない。
- 既存完成fileを変更しない。
- receiptをExecution Resultへ渡さない。
- kintone APIを追加で呼ばない。

### 3.5 file書込み途中の失敗

file書込みはsinkごとに次の順序とする。

```text
targetのabsolute path解決
  -> 同一directory内に衝突しない一時fileをexclusive create
  -> data全量write
  -> file fsync
  -> close
  -> atomic replace
  -> 必要なplatformではdirectory fsync
```

失敗時はopen handleをcloseし、未renameの一時fileを削除する。

保証単位は各完成fileである。1つの完成fileについて、利用者が観測できる状態は「旧file全体」または「新file全体」のいずれかであり、部分CSVを完成pathへ露出しない。

複数targetをまたぐ単一transactionはOS filesystemのrenameだけでは保証しない。全serializer失敗と全staging失敗はcommit前に止めるが、複数renameの途中でprocess／OSが停止した場合、先にrename済みのtargetと未renameのtargetが混在し得る。この制約をCLI文書へ明記する。

### 3.6 既存file

既存fileは同一pathへの全量置換とする。置換方式は次を満たさなければならない。

- 通常成功時は旧fileを残さず新fileへ置換する。
- write／fsync／closeまでの失敗では旧fileを変更しない。
- replace失敗では旧fileを可能な限り維持し、不完全な新fileを完成pathへ残さない。
- 一時file名をstdout、Execution Result、通常errorへ露出しない。
- targetと一時fileは同一directory、同一filesystemとする。

Windowsにおける既存fileへのrename挙動は §9 の実測事項とし、確認前に「全Windows環境で原子的に置換できる」とは断定しない。

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

- `types.ts`: engine内部のserializer input／output型
- `csvSerializer.ts`: header検査、RFC 4180 quoting、CRLF組立て、receipt生成
- `cellSerializer.ts`: fieldType別値変換、複数値JSON shape検査、SUBTABLE／FILE拒否
- `decimalText.ts`: 指数表記から非指数10進文字列への字句展開
- `dateTimeText.ts`: DATETIMEのtimezone変換
- `encoding.ts`: UTF-8 encode、注入Shift_JIS encoderの検査

Node builtin、`Buffer`、filesystem、process、CLI module、MCP module、UI moduleをimportしない。

既存 `src/core/displayFormat.ts` は表示用の `", "` 連結、user name/code選択、local date表示等を持つため、B179 serializerから利用しない（`src/core/displayFormat.ts:28-75`）。

### 4.2 `/flow` 配線

`src/flow-library/exportSinks.ts` を新設し、次を担当させる。

- 公開DTOから内部serializer DTOへの変換
- sink宣言の正規化と重複検査
- context作成時のstatement対応検査
- `StatementResult` のSELECT shape検査
- stable `KsqlFlowError` への変換
- named sinkのmanaged context参照

`src/flow-library/index.ts` は `exportSinks` を通常のexecute optionから分離する。共有 `ExecuteOptions` へ文字列keyのpropertyとして流さない。この方式は、既存IMPORT callbackが公開optionをdestructureして専用引数へ渡す構造と同じ境界を使える（`src/flow-library/index.ts:145-168`）。

named sinkのserializeはmanaged contextのtemp tableを読む専用内部操作とする。公開利用者へtemp table mapそのもの、任意temp table reader、internal execution contextを公開しない。

### 4.3 CLI配線の選択

#### 候補1: `executeBatch` 完了hook

利点:

- 現行batchのparse、validate-all-first、fail-fast、timeout、EXIT、warning、metrics、confirm処理をそのまま使える。
- temp table mapの生存期間内にserializeできる。
- CLIがstatement loopを再実装しない。

欠点:

- 公開 `BatchExecuteOptions`／共有 `ExecuteOptions` にhookを追加するとsurfaceが漏れる。
- hook errorをbatchのstatement errorと混同しない設計が必要。

#### 候補2: CLIをmanaged context方式へ移行

利点:

- `/flow` と同じsink APIを直接使える。
- 各 `StatementResult` をCLI側で確認してからserializeできる。

欠点:

- 現行 `executeBatch` の確認、timeout、EXIT、warnings、metrics、fail-fast、dependency skipをCLI側で再構成する必要がある。
- CLIとbatch実行の意味論が分岐しやすい。

#### 推奨

候補1を採用する。ただし共有 `ExecuteOptions` に公開propertyを追加しない。

`executeBatch` 内部に非公開Symbolまたは専用の内部entry pointを設け、次の結果をCLI adapterへ返す。

```ts
interface InternalBatchExportResult {
  readonly batch: BatchExecuteResult;
  readonly exports: ReadonlyMap<string, CsvExportResult>;
}
```

通常の `executeBatch(sql, client, options)` のsignatureと戻り値は変更しない。CLIの `--export-csv` 指定時だけ内部entry pointを使う。

内部entry pointは:

1. 実行前sink宣言検査を行う。
2. 現行batch処理を一度だけ実行する。
3. batch成功時だけ、temp table mapの解放前に全sinkをserializeする。
4. batch結果とserializer結果をCLIへ返す。
5. filesystem操作は行わない。

これによりengine serializer、batch実行、CLI filesystemの責務を分離する。

### 4.4 CLI option

追加option:

```text
--export-csv <name>=<path>  Export temp table #<name> as CSV (repeatable)
--export-csv <path>         Export the result of a single SELECT
--export-encoding <type>    utf8 | sjis; default utf8
--export-timezone <zone>    IANA timezone for DATETIME cells
```

規則:

- `name=path` は反復可能。
- 同じnameまたは同じ解決済みtarget pathの重複は実行前error。
- 名前なし形式は `--export-csv` が1件だけで、SQLが単文SELECTの場合だけ許可する。
- 複文、DML、ASSERT、VALIDATE、EXPLAIN、CREATE/DROP TEMP TABLE単独結果に名前なし形式は使えない。
- 名前付きと名前なしを同時指定できない。
- `--export-encoding` と `--export-timezone` は全sinkに共通適用する。sink別指定はB179対象外。
- CSV bytesをstdoutへ出さない。
- `--format csv` は通常の表示出力、`--export-csv` はartifact出力として併用可能。ただし同じpathを `--output` と共有できない。
- export receiptを既存CLI stdoutへ暗黙追加しない。

### 4.5 CLI Shift_JIS encoder

Shift_JIS実装はCLI bundle内に限定する。

推奨構成:

1. CP932対応libraryを `devDependencies` に追加する。
2. Node向け `dist-cli/ksql.js` へbundleする。
3. `package.json.dependencies` は追加せずruntime依存ゼロを維持する。
4. `/flow` bundleからは参照しない。
5. encode後に標準Shift_JIS decoderでround-tripし、元のcanonical CSV文字列と完全一致しない場合はthrowする。
6. libraryが `?` 等へ置換して成功扱いにしても、round-trip不一致として完成bytesを受理しない。

round-tripによってCP932の同義文字が厳格に拒否される可能性はあるが、誤った文字へ置換して完成fileを生成するよりfail-closedを優先する。

CLI以外のNode consumer、kSQL-Flowは自身のCP932 encoderを `FlowExportTextEncoder` として注入する。

### 4.6 atomic write

CLI専用moduleを `src/cli/exportCsvFiles.ts` として分離する。

実装条件:

- path解決とfilesystem操作はCLI層だけで行う。
- 一時fileはtargetと同じdirectoryへexclusive createする。
- random suffixを使い、既存fileへ追記しない。
- `write` の短縮書込みを考慮して全bytesを書き切る。
- file descriptorをfsyncしてからcloseする。
- close済み一時fileだけをrename対象にする。
- rename成功後に一時file cleanupを再実行してもtargetを削除しない。
- process終了hookだけにcleanupを依存しない。
- cleanup errorで元の主要errorを上書きしない。
- Windowsの既存file置換は実測済みplatform contractに従う。

### 4.7 変更ファイル一覧

#### 実装

| ファイル | 変更内容 |
| --- | --- |
| `src/export/types.ts`（新規） | 内部serializer型 |
| `src/export/csvSerializer.ts`（新規） | canonical CSV組立て、header、receipt |
| `src/export/cellSerializer.ts`（新規） | fieldType別値変換 |
| `src/export/decimalText.ts`（新規） | 指数表記の10進展開 |
| `src/export/dateTimeText.ts`（新規） | IANA timezone変換 |
| `src/export/encoding.ts`（新規） | UTF-8／注入encoder境界 |
| `src/flow-library/publicTypes.ts` | export DTO、receipt、encoder、sink宣言、context option |
| `src/flow-library/exportSinks.ts`（新規） | 公開関数、sink検査、error正規化 |
| `src/flow-library/index.ts` | value/type export、context配線 |
| `src/execute.ts` | managed sink宣言保持、temp table serialize seam、batch完了内部seam |
| `src/cli/index.ts` | `--export-csv`、encoding、timezoneのparseと実行配線 |
| `src/cli/exportCsvFiles.ts`（新規） | atomic write |
| `src/cli/shiftJisEncoder.ts`（新規） | CLI CP932 encodeとround-trip検査 |
| `package.json` / lockfile | CLI bundle用CP932 libraryをdevDependencyへ追加 |
| `build-flow.mjs` | 新しいdeclaration fileのcopyが必要な場合のみ更新 |
| `scripts/flow-bundle-guard.mjs` | `src/export/*` を許可し、Node builtin混入を引き続き拒否 |

#### テスト

| ファイル | 変更内容 |
| --- | --- |
| `src/export/__tests__/csvSerializer.test.ts`（新規） | 値変換、RFC 4180、encoding、receipt |
| `src/export/__tests__/decimalText.test.ts`（新規） | 指数展開境界 |
| `src/export/__tests__/dateTimeText.test.ts`（新規） | timezone、DST、invalid zone |
| `src/flow-library/__tests__/exportSinkPublicApi.test.ts`（新規） | 公開APIだけによるsink宣言、実行、serialize、error |
| `src/flow-library/__tests__/publicApi.test.ts` | export一覧、型、context省略時回帰 |
| `src/cli/__tests__/exportCsv.e2e.test.ts`（新規） | CLI option、file bytes、atomic write、cleanup |
| `scripts/flow-declaration-smoke.mjs` または同等 | registry相当のESM/CJS/declaration利用確認 |

## 5. 要決定 A/B/C の比較と推奨

最終判断はオーナーが行う。R1の推奨は以下のとおり。

### 5-A. Shift_JIS encoderの置き場所

| 観点 | (a) CP932表をengineへ同梱 | (b) 呼出側encoder注入 |
| --- | --- | --- |
| `/flow` bundleサイズ | CP932表と変換処理の分だけ恒常増加 | UTF-8 serializerとinterfaceだけ。増加を抑えられる |
| runtime依存ゼロ | 自前表またはbundle済みlibraryなら可能だが、表の保守責任がengineへ入る | `/flow` は維持可能。CLI libraryはdevDependencyとしてbundle可能 |
| browser-neutral | pure TypeScriptなら可能 | encoder interfaceはbrowser-neutral。利用環境が実装を選べる |
| 表の出所・license | engine配布物として固定・監査が必要 | 各provider／CLI bundleの採用品だけを監査 |
| CLI | 内蔵実装をそのまま利用可能 | CLI専用encoderが必要 |
| kSQL-Flow | engine内蔵を利用可能 | Node側で既存のCP932 libraryを選べる |
| fail-closed | engineがencode結果を直接管理できる | encoder契約と戻り値検査が必要。CLIはround-trip検査を追加できる |
| 責務 | serializerが文字コード表まで所有 | serializerはCSV意味論、providerはencoding能力を所有 |

推奨は **(b) 呼出側encoder注入** とする。

理由:

- CP932表をneutral `/flow` bundleへ持ち込まず、bundleサイズと依存境界を維持できる。
- browser、Node、将来のhostがそれぞれ利用可能なencoderを選べる。
- `package.json.dependencies` を空のまま維持しつつ、CLIだけはdevDependencyをNode bundleへ内包できる。
- Shift_JISが不要なconsumerへCP932表を配布しない。
- fail-closedは「正確にencodeできなければthrow」というinterface契約、戻り値shape検査、CLIのround-trip検査で固定できる。

オーナー判断として残す点:

- CLI bundleへ採用するCP932 libraryとlicense。
- round-trip完全一致が一部のCP932同義文字を拒否することを許容するか。
- 将来、標準化したCP932 encoderを別subpathとして提供するか。

### 5-B. 計算列の指数表記

| 案 | 利点 | 欠点 |
| --- | --- | --- |
| (i) `1.25e+22` をそのまま出力 | engine結果文字列を完全保持。実装が最小 | kintone NUMBERへの再取込互換性を損ねる可能性 |
| (ii) 等価な非指数10進文字列へ展開 | CSV再取込に適したdecimal表現。追加丸めなし | 字句展開実装と境界testが必要 |

推奨は **(ii) 非指数10進展開** とする。

展開は入力文字列のsign、coefficient、decimal point、exponentを解析し、桁位置を移動するだけとする。JavaScript `Number` へ再変換しないため、新たなIEEE 754丸めを発生させない。

例:

| 入力 | 出力 |
| --- | --- |
| `1.25e+22` | `12500000000000000000000` |
| `1e-7` | `0.0000001` |
| `-0e+10` | `-0` |
| `0.3333333333333333` | そのまま |

展開後の文字列長上限は既存row／result上限だけでは防げないため、実装時に安全な上限を設ける。具体値は §9 の実測後にオーナー決定とする。上限超過は `ExportSinkInvalidValueError` でfail-closedにする。

### 5-C. user系の表現

| 案 | round-trip | 安定性 | 情報量 |
| --- | --- | --- | --- |
| `code` | kintoneへの再指定に適する | 表示名変更の影響を受けにくい | nameを失う |
| `name` | 人が読みやすい | 重複・変更・localeの影響を受ける | codeを失う |
| JSON全体 | 情報を保持 | cli-kintone互換とLF連結要求を満たさない | 最大 |

推奨は **`code` のLF連結** とする。

対象はUSER_SELECT、ORGANIZATION_SELECT、GROUP_SELECT、STATUS_ASSIGNEEとする。配列順を保持し、nameは出力しない。`code` 欠落を空文字へ黙って変換せず、shape不正としてfail-closedにする。

## 6. 後方互換

### 6.1 不変とするsurface

- 既存 `ExecuteOptions` のpropertyと意味を変更しない。現行のIMPORT関連propertyも維持する（`src/execute.ts:745-788`）。
- `/engine` の公開型、`QueryColumn`、`run`／`runBatch`契約を変更しない。`QueryColumn` は既に列名、fieldType、sortKind、sourceAppを公開している（`src/engine-library/publicTypes.ts:152-162`）。
- 既存 `--format csv` のescaping、LF、表示option連携を変更しない。
- 既存 `--output` の通常表示出力をB179のatomic artifact出力へ置き換えない。
- `--export-csv` を指定しないCLIのstdout、stderr、exit code、API回数、file書込みを変更しない。
- `exportSinks` を省略した `/flow` contextの実行順、`StatementResult`、metrics、mock client API回数を変更しない。
- `StatementResult.result` やmetricsへreceiptを暗黙追加しない。
- IMPORTの `ImportEncoding`、named resolver、materialized receiptを変更しない。
- temp tableの既定10,000行上限を変更しない（`src/execute.ts:1538-1549`）。
- MCP／pluginへ新しいexport optionを追加しない。

### 6.2 additive export

`@rex0220/kintone-sql-tools/flow` に新しい型と関数を追加する。既存exportの削除、改名、signature変更は行わない。

`package.json.exports["./flow"]` のESM、CJS、declarationすべてから同じ新APIを利用可能にする。現在のsubpath構成は `package.json:21-31` のまま維持する。

### 6.3 version

公開 `/flow` APIとCLI optionの純加法であるため、v3.77.0のminor releaseとする。

## 7. テスト方針

### 7.1 受入原則

受入条件は公開結果だけで観測する。

- 公開関数の返り値
- `KsqlFlowError.code`
- `StatementResult`
- mock clientの各API呼出し回数
- CLI exit code、stdout、stderr
- 完成file、一時file、既存fileのbytesと存在状態
- ESM／CJS／declarationからのimport可否

内部関数名、private symbol、内部map、内部callbackの呼出しを受入条件にしない。

### 7.2 serializer matrix

| ケース | 公開期待値 |
| --- | --- |
| 通常scalar | header、row順、値が入力順で一致。receiptのrows/columnsが一致 |
| 重複header | `ExportSinkDuplicateHeaderError`、結果なし |
| `code` と `Code` | 重複扱いにせず両方出力 |
| 空結果 | header＋CRLF、`rows:0` |
| SUBTABLE | `ExportSinkUnsupportedColumnError`。messageに列名と `APP$明細` |
| FILE | `ExportSinkUnsupportedColumnError`。messageに列名 |
| CHECK_BOX／MULTI_SELECT | JSON配列がLF連結され、そのcellがquoteされる |
| USER_SELECT | codeがLF連結され、nameは含まれない |
| ORGANIZATION／GROUP／STATUS_ASSIGNEE | USER_SELECTと同じcode規則 |
| known multi-value malformed JSON | `ExportSinkInvalidValueError`、結果なし |
| fieldType不明のJSON配列文字列 | JSON文字列をそのままcellへ出力 |
| `"` を含むcell | `""` escaping |
| commaを含むcell | cell全体をquote |
| CRのみを含むcell | cell全体をquote |
| LFのみを含むcell | cell全体をquote |
| CRLFを含むcell | 改行を保持してcell全体をquote |
| null／undefined／欠落／空文字 | すべて空cell |
| NUMBER `12.50` | `12.50` を保持 |
| 計算結果 `1/3` | 既存結果文字列を保持 |
| `1.25e+22` | `12500000000000000000000` |
| 小さい負指数 | 等価な `0.00...` 表現 |
| DATE＋timezone | DATEは不変 |
| DATETIME既定 | UTC ISO入力を保持 |
| DATETIME＋timezone | 指定zoneのoffset付きISO |
| DST境界 | 各instantに対応するoffset |
| invalid timezone | `ExportSinkInvalidTimezoneError`、結果なし |
| UTF-8 | BOMなし、`data` が `text` のUTF-8、receipt.bytes一致 |
| Shift_JIS成功 | 注入encoderのbytes、receipt.encoding `"sjis"` |
| Shift_JIS encoderなし | `ExportSinkEncoderRequiredError`、結果なし |
| 表現不能文字 | `ExportSinkEncodingError`、結果なし |
| encoder非bytes | `ExportSinkInvalidEncoderResultError`、結果なし |
| 同じinputを2回 | text/data/receiptが一致 |

### 7.3 `/flow` sink matrix

| ケース | 公開期待値 |
| --- | --- |
| 宣言1件＋対応CREATE1件 | context作成成功 |
| sink宣言重複 | context作成が同期throw、code `ExportSinkDuplicateError`、mock API 0回 |
| 対応CREATE不存在 | 同期throw、code `ExportSinkNotFoundError`、mock API 0回 |
| 対応CREATE重複 | 同期throw、code `ExportSinkDuplicateError`、mock API 0回 |
| DROPによって最終sink不存在 | 同期throwまたは規定した事前error、mock API 0回 |
| DML結果指定 | `ExportSinkInvalidTargetError`、mock API 0回 |
| 複文の名前なし | `ExportSinkInvalidTargetError`、mock API 0回 |
| 単文SELECT成功 | `StatementResult.status:"success"`、純関数からCSV結果 |
| 単文DML成功結果 | 純関数が `ExportSinkInvalidTargetError` |
| 全文実行前にnamed serialize | `ExportSinkExecutionIncompleteError` |
| CREATE後、後続DML成功 | 最終serialize成功。実行時の既存mock API回数を維持 |
| CREATE後、後続文error | `StatementResult.status:"error"`、serializeは `ExportSinkExecutionFailedError` |
| fail-fast後続skip | serialize結果なし |
| 正常EXIT | errorがなくsinkが作成済みならserialize可。EXIT後未作成sinkは不可 |
| dispose後 | `ExecutionContextDisposedError` |
| sink上限内 | receipt.rowsがtemp table row数と一致 |
| `tempTableMaxRows` 超過 | CREATE文がerror、serialize結果なし |
| `exportSinks` 省略 | 既存 `StatementResult` と全mock API回数がgolden一致 |
| serialize実行 | mock clientの全API回数がserialize前後で不変 |

### 7.4 CLI matrix

| ケース | 公開期待値 |
| --- | --- |
| `name=path` 1件 | 成功時だけ完成file。bytesは公開serializer結果と一致 |
| 複数sink | 各fileが対応temp tableのCSV |
| 単文SELECT＋名前なしpath | 完成file生成 |
| 複文＋名前なしpath | 実行前error、mock API 0回、fileなし |
| DML＋名前なしpath | 実行前error、mutation API 0回、fileなし |
| sink不存在／重複 | 実行前error、mock API 0回、fileなし |
| SQL途中error | 完成fileなし、既存file不変、一時fileなし |
| serializer error | 全targetで完成file変更なし、一時fileなし |
| Shift_JIS成功 | CP932 bytes、BOMなし |
| Shift_JIS表現不能文字 | non-zero exit、完成fileなしまたは既存file不変、一時fileなし |
| write失敗 | non-zero exit、完成pathへ部分fileなし、一時file cleanup |
| fsync失敗 | write失敗と同じ |
| close失敗 | renameしない、既存file不変 |
| rename失敗 | non-zero exit、既存file不変、一時file cleanup |
| 新規target | 完成fileだけが残る |
| 既存target | 成功時に全量置換 |
| `--format csv` のみ | v3.76.0 goldenとbyte-for-byte一致 |
| `--output` のみ | 既存挙動と一致 |
| `--format csv`＋`--export-csv` | stdout／`--output` は旧表示CSV、export fileはB179 canonical CSV |
| `--output` と同じexport path | 実行前error |
| quiet等既存option | export receiptをstdoutへ追加しない |

### 7.5 platform contract

最低限、CIまたは実機で次をWindowsとPOSIXに分けて固定する。

- 同一directoryの新規rename
- 既存fileへのreplace
- open handleが残る場合
- read-only target
- rename直前のtarget生成競合
- Unicode path
- cleanup時に一時fileが既にない場合
- process中断後に残り得るstaged fileの識別と安全な再実行

Windowsの既存file置換が要求を満たさない場合、削除後renameへ黙ってfallbackしてatomicityを失わせない。対応方式を別途決定するまで `ExportSinkFileReplaceError` 相当でfail-closedにする。

### 7.6 bundle・配布検証

- `npm run build:flow`
- `npm run flow:bundle-guard`
- `npm run build:cli`
- `npm pack --dry-run --json`
- registry相当tarballから `/flow` のESM import
- registry相当tarballから `/flow` のCJS require
- declarationだけを使うTypeScript compile
- neutral `/flow` bundleのNode builtin import 0
- neutral `/flow` bundleのCP932 table／CLI module混入0
- `package.json.dependencies` が未追加
- CLI bundle単体でShift_JIS export可能

## 8. 文書・リリース

### 8.1 更新文書

| 文書 | 更新内容 |
| --- | --- |
| `README.md` | `/flow` CSV serializerとCLI `--export-csv` の最小例 |
| `docs/ksql_language_reference.md` | CREATE TEMP TABLEをexport sinkとして使う例、単文SELECT例 |
| CLI help | 新option、名前付き／名前なし制約、stdout禁止、atomic write |
| `/flow` API reference | 型、関数、receipt、error code、encoder契約 |
| `docs/internal/ksql_b179_csv_export_sink_issue.md` | 実装PR、test、release結果 |
| `CHANGELOG.md` | v3.77.0のadditive API／CLI feature |
| kSQL-Flow側Contract文書 | `features.resultCsv`、`output_files[]` との対応 |

### 8.2 公開例

```ts
import {
  createExecutionContext,
  executeStatement,
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
  // parse結果のstatementsを順番に全てexecuteする
  // 全StatementResultの成功確認後:
  const csv = serializeExportSink(context, "export");
  // csv.dataをfileへ書く責務は呼出側
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

例では内部 `ExecuteOptions`、`src/export/*`、CLI bundle、private symbol、filesystem handleをimportしない。

### 8.3 kSQL-Flow連携

kSQL-Flowは:

1. 全statementを実行する。
2. 全結果の成功を確認する。
3. dispose前に名前付きsinkをserializeする。
4. `data` を自身のallowlist済みabsolute pathへatomic writeする。
5. `data` からsha256を計算する。
6. receiptとsha256をExecution Resultの次の形へ転記する。

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

engineはabsolute path、sha256、保持期限、allowlist、Execution Result JSONを扱わない。

### 8.4 リリース順序

```text
engine v3.77.0 implementation
  -> serializer / flow / CLI targeted tests
  -> full test and build
  -> flow bundle guard
  -> tarball ESM/CJS/declaration smoke
  -> CLI Windows/POSIX atomic-write contract test
  -> v3.77.0 publish
  -> kSQL-Flow dependency update
  -> Contract features.resultCsv enable
  -> kSQL-FlowNet E2E
```

MCP／plugin配線は別issueとする。

## 9. Claude が実測すべき未確認事項

次は静的根拠または起票 §2 の確定実測だけでは保証できないため、実装前後にClaudeが実測する。

1. `SELECT code, code FROM APP1` が重複columnsを持つ成功結果になるか、parser／plannerで先に拒否されるか。
2. CATEGORY、STATUS_ASSIGNEE、GROUP_SELECT、ORGANIZATION_SELECTの実際の `ProcessRow` 文字列shape。
3. 空の複数値fieldが `[]`、空文字、nullのどれになるか。
4. `APP$明細` 仮想テーブルの実際のcolumns、親record識別列、header表示。
5. FILE列とSUBTABLE列の `columnMeta.fieldType` が全SELECT／CTE／temp table経路で保持されるか。
6. wildcard、UNION、CTEを経た既知fieldのmetadata欠落範囲。
7. `SELECT code, code` のmetadata mapが重複列を表現できない場合でも、header検査をmetadata参照より先に行えること。
8. DATETIME値が全経路で秒精度か、ミリ秒を含む場合があるか。
9. IANA timezone変換でミリ秒を保持するか切り捨てるか。
10. DST fold／gap instantのoffset出力。
11. `Intl.DateTimeFormat` を使う場合のneutral browser／Node 18間の出力一致。
12. 計算列で発生し得る指数表記の最大正負exponent。
13. 非指数展開後の安全な最大文字数と、上限超過時のmemory影響。
14. CP932 libraryが表現不能文字をthrowするか、置換して返すか。
15. CP932 encode後round-tripで、波ダッシュ、全角チルダ、円記号、バックスラッシュ等が完全一致するか。
16. CLI bundleへCP932 libraryを含めた増分byte数。
17. `/flow` ESM／CJS bundleへCP932 tableが混入していないこと。
18. Windows上で `fs.renameSync` が、同一volume・既存通常file・open handleなしの条件で既存fileを置換するか。
19. Windows上でantivirus／indexerが一時的にhandleを保持した場合のrename error。
20. Windowsでreplace失敗後に旧fileと一時fileがどの状態で残るか。
21. POSIXでfile fsync後、directory fsyncを行う場合の実装とtest環境対応。
22. 複数sink rename途中のprocess強制終了時に観測されるfile集合。
23. target pathのcase-insensitive重複をWindowsで実行前検出できるか。
24. `--export-csv name=path` のpathに `=` を含む場合の引数分割規則。
25. temp tableをCREATE後DROPし、同名再CREATEするscriptを現行batch解析が許可するか。
26. 正常EXIT後の未実行statementをmanaged `/flow` 呼出側が最後まで `executeStatement` してskipped結果として回収する現行運用。
27. `tempTableMaxRows` 超過時の公開 `StatementResult.error.code`。
28. registry tarballのESM、CJS、declarationから全新型・関数を利用できること。
29. `package.json.dependencies` を空のままCLI Shift_JISが実行できること。
30. `--format csv`、`--output` の既存goldenがB179後もbyte-for-byte不変であること。

未確認事項の結果が本仕様の公開契約と矛盾する場合、実装で暗黙に契約を弱めず、R2またはオーナー判断へ戻す。

## 10. 見積り

| 作業 | 見積り |
| --- | ---: |
| serializer型、RFC 4180、receipt | 0.5〜0.8人日 |
| fieldType別値変換、unsupported列、指数展開 | 0.7〜1.1人日 |
| timezone変換と境界test | 0.4〜0.7人日 |
| `/flow` sink宣言、公開関数、managed context配線 | 0.8〜1.2人日 |
| batch完了内部seam | 0.5〜0.9人日 |
| CLI optionと単文／名前付き配線 | 0.6〜1.0人日 |
| CLI Shift_JIS encoderとround-trip検査 | 0.5〜0.9人日 |
| atomic writeとWindows/POSIX test | 0.8〜1.4人日 |
| bundle、declaration、tarball smoke | 0.3〜0.5人日 |
| 文書、CHANGELOG、release metadata | 0.3〜0.5人日 |
| 合計 | **5.4〜9.0人日** |

別見積り:

- kSQL-FlowのCLI option、absolute path／allowlist、sha256、Execution Result `output_files[]`
- kSQL-FlowNetのnetwork schema、retention、resume整合
- MCP／plugin export配線
- ストリーミングserializer
- 複数output fileを跨ぐtransactional commit
- 独立した標準CP932 encoder packageの公開


---

## R1 レビュー（Claude・2026-09-04）

**判定: R1 の骨格（engine 層 serializer・bytes 返却・sink 事前宣言・同期 receipt・fail-closed 表）は採用可。実装前に反映する修正が 1 件（Major）と、要決定の確定・§9 の一部解消がある。** 規模が大きい（5.4〜9.0 人日）ので、実装は下記を反映した R2 を codex に書かせてから着手する。

### 依頼元回答の反映（起票 §3.2・オーナー裁定待ち）

| 要決定 | 依頼元（flownet）回答 | R1 推奨 | 扱い |
|---|---|---|---|
| A. Shift_JIS encoder | **(b) 注入**を支持（kSQL-Flow が iconv-lite 等を持つ・CLI は Node 層で持てばよい） | (b) | 一致。R2 で確定。**CLI bundle に取り込む CP932 library とその license はオーナー決定** |
| B. 指数表記 | **10 進展開（丸めなし）** | (ii) | 一致 |
| C. user 系 | **`code` の LF 連結** | `code` | 一致 |

### Major: 単文 SELECT 経路の column metadata

§2.2 `serializeSelectResultAsCsv(result: StatementResult)` は公開 `StatementResult.result`（`SelectResult`＝`rows` / `columns` / `rowCount`）しか受けないが、§2.4 の複数値変換と SUBTABLE / FILE 拒否は `fieldType` が無いと働かない（§2.4 追加規則が「metadata を渡さなければならない」と自ら書いている）。このままでは**単文 SELECT の export が checkbox / user を JSON 文字列のまま出し、SUBTABLE 列も拒否できない**＝named sink と単文で契約が変わる。

修正: engine は `SelectResult` オブジェクトに列 meta を `WeakMap` で関連付けている（`getSelectColumnMeta`・`src/execute.ts:465-470`。`captureColumnMeta` 有効時）。`/flow` の `executeStatement` は内部結果を spread して返す（`src/flow-library/index.ts:247-260`）ため `result.result` は同じオブジェクト参照であり、公開関数の内部で meta を引ける。R2 では (1) managed context は `captureColumnMeta` を常に有効にする（既存 consumer への影響＝meta が WeakMap に付くだけで公開結果は不変）、(2) `serializeSelectResultAsCsv` は engine 付随 meta を必ず使い、meta が引けない `StatementResult`（他 context 由来・改変済み）は `ExportSinkInvalidTargetError` で拒否する、と規定する。純関数 `serializeCsvExport` は明示 `columnMeta` を受ける現行案のままでよい。

### §9 のうち起票 §2・§5 の実測で解消済み

| §9 | 結果 |
|---|---|
| 1（`SELECT code, code`） | 単文は `columns: ["code","code"]` で成功（row は map・値 1 つ）。**temp table は重複を 1 列に畳む**→ named sink では重複 header が発生せず、検出が効くのは単文経路。§2.5 の「重複 header 拒否」は単文経路の契約として書き、temp table の畳み込みは既存挙動として文書化する |
| 2（値の shape） | CATEGORY / MULTI_SELECT＝JSON 文字列配列、GROUP / ORG＝`[{code,name}]`（USER 同形）。STATUS_ASSIGNEE は未測（USER 同形の見込み） |
| 4（`APP$明細`） | columns＝`_pid, _rid, _idx, <子 field…>`。`$id` は空文字 |
| 18（Windows rename） | 同一 directory・fsync → close → `renameSync` で既存 file を上書き可・一時 file は残らない。**既存 file を他プロセスが open していると `EPERM`**（§3.6 の契約「replace 失敗＝旧 file 維持・一時 file 削除・error」で吸収。§7.5 の「削除後 rename へ fallback しない」も維持） |
| 12・13（指数の範囲・展開長） | 値は JS `Number` の `String()` 由来なので exponent は ±308 程度に有界（`Number.MAX_VALUE` ≈ 1.8e308・`Number.MIN_VALUE` = 5e-324）。展開後は最長 ~330 文字＝**上限はオーナー決定不要**（安全側に 1,024 文字で fail-closed にする程度でよい） |

残る §9（3・5〜11・14〜17・19〜30）は実装時に Claude が実測する。3（空の複数値）と 8（DATETIME の秒精度）は起票側で追加実測中。

### Minor（R2 で反映）

1. §2.1 `FlowCsvExportInput.rows` の値型に `string | null | undefined` を許すが、engine の `ProcessRow` は文字列のみ（起票 §2.2）。公開型は緩くてよいが、§2.4 の「不明 fieldType は解釈しない」規則と合わせ、非文字列（number/object）が来た場合の扱い（`ExportSinkInvalidValueError`）を表に足す。
2. §2.3 規則 6 の「DROP で最終時点に存在しない」は静的解析で判定できる（`analyzeBatch` の tempTablesCreated/依存）。判定できない形（条件分岐は無いので原則すべて静的）を残さないよう、R2 で「context 作成時に必ず判定」と言い切る。
3. §4.4 の `--export-csv <path>`（名前なし）と `<name>=<path>` の判別は「`=` を含むか」だけでは Windows path（`C:\…`）や `=` を含む path と衝突しない（drive letter は `:`）。判別規則を R2 で明記（先頭の `<name>=` は識別子文字だけ・それ以外は path）。
4. §7.4 に「`--export-csv` 指定時も `--format csv` / `--output` の stdout が v3.76.0 golden と一致」を 1 行加える（B177 で共有 primitive の変更が他面へ波及した教訓）。

### 次の工程

1. オーナー裁定（A の CP932 library・B・C の確定）→ 2. codex に R2（本節の反映）→ 3. flownet セッションの消費側レビュー → 4. codex 実装（規模が大きいので serializer → /flow → CLI の 3 段 PR を推奨）→ 5. Claude 実測（§9 残り）→ 6. v3.77.0。

### 追加実測（2026-09-04・レビュー後）

- §9-8（DATETIME の精度）: kintone の DATETIME field は秒精度の `…T03:04:00Z` だが、dialect 1 の `@NOW()` は **ミリ秒付き** `2026-09-04T00:56:07.859Z` を返す（`@TODAY()` は `YYYY-MM-DD`）。timezone 変換はミリ秒を保持する規則（§9-9）を R2 で明記する。
- §9-3（空の複数値）: CHECK_BOX / USER_SELECT の空値は **`"[]"`（JSON 空配列の文字列）**、DATETIME の空値は `""`。§2.4 の「複数値の空配列は空セル」は `"[]"` → `""` の変換として実装する。FILE 列の値は `[{"fileKey","name","size","contentType"}]` の JSON 文字列（§2.4 どおり error で拒否）。

### 消費側レビュー（flownet セッション・2026-09-04）＝R2 への追加要求

骨格と Major の対応方針（単文経路も WeakMap 列 meta＋`captureColumnMeta` 常時 ON・meta 不能は InvalidTarget）を支持。追加規定:

1. **EXIT との交差を明文化**（R2 必須）: (i) sink 作成済みで EXIT → 以降 skip＝「処理済み」として serialize 可。(ii) **sink 未作成のまま EXIT**＝`serializeExportSink` は error ではなく「未生成」を判別できる形（または呼出側が呼ばない判定材料の公開）にする。消費側は output_files へ載せず既存 file 不変・exit code は NO_DATA 系のまま（「対象なし月は file を配信しない」運用に直結）。
2. encoder 契約に「encoder は表現不能文字で throw する義務を負う（検査方式は実装者責務）」の一文を置く。iconv-lite は `?` 置換で throw しないため、kSQL-Flow 側で encode→decode→比較の wrapper を実装する（CLI の round-trip 検査と同方式）。
3. receipt の形は足りる（sha256 は戻り値 `data` から呼出側計算・`columns` は任意扱い）。
4. atomic write 契約の統一（EPERM 時＝旧 file 維持・一時 file 削除・error）に賛成。
5. `name=path` の判別＝「最初の `=` で分割・path に `=` を含む場合は名前付き必須」の明文化を希望。
