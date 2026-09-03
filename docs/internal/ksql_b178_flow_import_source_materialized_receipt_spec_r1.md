# B178 `/flow` IMPORT source materialize 通知（rows receipt）仕様 R1

- 対象版: v3.76.0
- 種別: 公開 API の純加法追加
- 公開面: `@rex0220/kintone-sql-tools/flow`
- 非対象: CLI、MCP、プラグイン、公開 `ExecuteOptions` 契約
- 上流要求: `C:/Users/rex02/Projects/ksql-flow/docs/internal/contract-v1.1-import-implementation-plan.md` §3.3・§4.1
- 先行仕様: `docs/internal/flow_import_source_api_spec.md`（B177）

## 0. 結論

`CreateExecutionContextOptions` に `/flow` 専用の任意 callback `onImportSourceMaterialized` を追加する。

callback は、到達した IMPORT 文の source が decode および raw materialize に成功した直後、projection、validation、`ON ERROR SKIP` の行選別、確認 callback、mutation より前に1回だけ await する。通知値は source 名、source 種別、decoder が確定した物理 record 数、有効 encoding、0始まりの `statementIndex` とする。

公開契約は次で固定する。

- CSV の `rows` は header を除いた RFC 4180 data record 数とする。quoted cell 内の改行は別 record に数えない。
- `NO HEADER COLUMNS` では全 record を data record として数える。
- subtable CSV は親 record 数ではなく、継続行を含む data record の物理行数とする。
- JSON の `rows` は top-level record 数とする。subtable child 数ではない。
- CSV の `encoding` は `SQL ENCODING > loader payload.encoding > "utf8"` の解決後の小文字値とする。
- JSON の `encoding` は `"utf8"` とする。
- `statementIndex` は当該 `StatementResult.index` と同じ0始まりの文 index とする。
- 同じ source を複数の IMPORT 文が参照した場合も、materialize 成功ごとに通知する。engine は文をまたいで通知を dedupe しない。
- maxRecords 超過、decode 失敗、source load／payload 境界エラー、materializer 内の構造エラーでは通知しない。
- callback の throw／reject は当該文の `StatementResult.status === "error"` とし、その文の mutation API 呼出しを0回にする。後続文は既存の fail-fast 規則に従う。
- callback 用の新しい固定 error code は追加せず、既存の statement error 変換規則を使う。
- callback を指定しない consumer は、`StatementResult`、mutation、metadata read、loader、その他の kintone API 呼出し回数を含め、v3.75.0 と同じ結果を得る。
- path、bytes、cell 値、列名、loader metadata 以外の情報は callback 引数に含めない。
- `StatementResult`、`FlowDmlResult`、metrics、`FlowImportSourcePayload` の shapeは変更しない。

配線は、公開 `/flow` から managed execution context までは `onChunkWritten` と同じ専用引数方式を採る。materializer への最終搬送だけは、公開 `ExecuteOptions` に field を追加せず、private `unique symbol` seam を使う。この組合せにより、共有 `ExecuteOptions` の契約を変更せず、各文の `statementIndex` を確定した callback を既存の materialize 呼出しへ届ける。

## 1. 現状調査

### 1.1 公開 `/flow` 面

v3.75.0 の `CreateExecutionContextOptions` は `importSource` と `onChunkWritten` を公開しているが、source materialize 完了を受け取る option はない（`src/flow-library/publicTypes.ts:182-212`）。

`createExecutionContext` は `onChunkWritten` を残余 execution options から分離し、専用引数として managed execution context へ渡している（`src/flow-library/index.ts:146-167`）。この分離により、`onChunkWritten` は共有 `ExecuteOptions` の field になっていない。

一方、内部 `ExecuteOptions` は `enableImport` と `importSource` を持ち、CLI、MCP、プラグインを含む実行層で共有されるが、`onImportSourceMaterialized` は存在しない（`src/execute.ts:744-792`）。B178 ではこの interface に公開 propertyを追加しない。

### 1.2 managed context と statement error

managed execution context は `onChunkWritten` を専用 field として保持する（`src/execute.ts:1835-1855,1871-1877,1915-1932`）。

文実行時の index は `nextIndex` から取得され、`StatementResult` の基礎情報へ入る（`src/execute.ts:1946-1956`）。公開 adapter はこの結果を `StatementResult` として返すため、B178 の `statementIndex` はこの index と同値にできる（`src/flow-library/index.ts:239-260`、`src/flow-library/publicTypes.ts:315-333`）。

文実行中の例外は managed execution の catch で `StatementResult.status: "error"` へ変換される（`src/execute.ts:2036-2044`）。error code は、非 `Error` オブジェクトの `code`、`Error.name`、message 接頭辞の既存優先規則で決まる（`src/execute.ts:2862-2889`）。

fail-fast 状態の後続文は `status: "skipped"` になる（`src/execute.ts:1958-1972`）。また、DML を含む batch では `continueOnError` 自体が拒否されるため、IMPORT callback failure 後に後続 DML を継続する新しい分岐は作らない（`src/execute.ts:1889-1890`）。

### 1.3 materialize 経路

IMPORT source の raw materialize は、1文の実行につき次の5経路に整理できる。

| 経路 | 現行の呼出し関係 | materialize 回数 |
| --- | --- | ---: |
| flat CSV/JSON・通常 INSERT/UPSERT | IMPORT が生成した DML へ分岐し（`src/execute.ts:9781-9791,9815-9817`）、INSERT は `src/execute.ts:10102-10110`、UPSERT は同:11584-11592から共通 source materialize を呼ぶ | 1 |
| flat・`VALIDATE ONLY` | IMPORT 分岐は validation を1回呼び（`src/execute.ts:9796-9806`）、validation candidate 作成時に共通 source materialize を1回呼ぶ（同:8752-8757,8954-8991） | 1 |
| flat・`ON ERROR SKIP` | IMPORT 分岐は skip 実行を1回呼び（`src/execute.ts:9808-9813`）、その事前 validation が candidate 作成を1回行う（同:8873-8904,8954-8991） | 1 |
| `IMPORT UPDATE ... MATCH RECORD NUMBER` | source load 後に flat CSV materialize を直接1回呼ぶ（`src/execute.ts:9925-9946`） | 1 |
| subtable CSV/JSON | source load 後、source 種別に応じた import-record materializerを1回呼ぶ（`src/execute.ts:9639-9675`） | 1 |

したがって、同一文内で通常実行用と validation 用の materialize が重複して走る経路はない。特に `ON ERROR SKIP` は事前 validation で作った candidates をそのまま mutation へ渡しており、mutation 前に再materializeしていない（`src/execute.ts:8881-8904,8918-8951`）。

### 1.4 `rows` と encoding の現物

flat CSV は `decodeCsv` の結果を受け、`decoded.rows.length` を maxRecords と比較してから materialized rows を組み立てる（`src/import/materializeDmlSource.ts:11-26,67-97`）。

`decodeCsv` は RFC 4180 parser の出力について、header ありなら `records.slice(1)`、header なしなら全 records を `rows` とする（`src/import/csvDecoder.ts:62-83`）。quoted cell 中の改行は quoted 状態の cell 内容へ取り込まれ、record 終端にはならない（同:15-50）。

flat JSON は `decodeJsonRecords` が返した top-level records の件数を maxRecords と比較し、同じ件数の materialized rows を返す（`src/import/jsonMaterializer.ts:48-81`）。

subtable JSON は top-level decoded records を親 records に変換するため、receipt の `rows` は `decoded.length` とする（`src/import/importRecordsMaterializer.ts:12-26,44-58`）。

subtable CSV は `decoded.rows` を走査し、`"*"` の親行と空 marker の継続行を親 records へグループ化する（`src/import/importRecordsMaterializer.ts:61-100`）。このため `records.length` は親数であり、receipt の `rows` には使用できない。B178 はグループ化前の `decoded.rows.length` を保持し、継続行を含む物理 data record 数として通知する。

CSV の有効 encoding は flat で `source.encoding ?? payload.encoding ?? "utf8"`（`src/import/materializeDmlSource.ts:19-23`）、subtable で同じ優先順位（`src/import/importRecordsMaterializer.ts:70-72`）となる。JSON は payload encoding が指定される場合も `"utf8"` 以外を拒否する（`src/import/jsonMaterializer.ts:49-57`、`src/import/importRecordsMaterializer.ts:12-21`）。

maxRecords 超過は materializer の完了前に throw される（`src/import/materializeDmlSource.ts:24-26`、`src/import/jsonMaterializer.ts:55-57`、`src/import/importRecordsMaterializer.ts:19-21,89-90`）。

### 1.5 projection と API 順序

flat CSV projection は raw CSV materialize の後に実行される（`src/execute.ts:10063-10079`）。したがって通知する `rows` は projection 後の出力件数ではなく、raw materialize が保持した件数とする。

flat INSERT/UPSERT は destination metadata を取得してから source materialize を行う（`src/execute.ts:10102-10108,11584-11590`）。subtable と record-number update も materialize より前に destination metadata を取得する（同:9664-9672,9936-9942）。よって callback failure 時の契約は mutation API 0回であり、metadata API 0回ではない。

## 2. 公開 API 契約

### 2.1 公開型

`src/flow-library/publicTypes.ts` に次を追加し、`src/flow-library/index.ts` から type export する。

```ts
export interface FlowImportSourceMaterializedInfo {
  /** バッチ内の文 index。StatementResult.index と同じ0始まり。 */
  readonly statementIndex: number;

  /** SQL の FROM CSV <name> / FROM JSON <name> で指定された source name。 */
  readonly name: string;

  /** materialize した source 種別。 */
  readonly kind: "CSV" | "JSON";

  /**
   * decoder が返した物理 input record 数。
   * CSV は header 除外、JSON は top-level record 数。
   */
  readonly rows: number;

  /** SQL、payload、既定値を解決した後の有効文字コード。 */
  readonly encoding: ImportEncoding;
}

export interface CreateExecutionContextOptions extends ParseScriptOptions {
  // existing fields...

  /**
   * IMPORT source の raw materialize 成功直後、mutation 前に1回 await される。
   * throw/reject は当該文を error にし、その文の mutation は0回となる。
   */
  onImportSourceMaterialized?: (
    info: FlowImportSourceMaterializedInfo
  ) => void | Promise<void>;
}
```

`ImportEncoding` はB177で公開済みの次の unionを再利用する。

```ts
export type ImportEncoding = "utf8" | "sjis";
```

callback 引数には optional field を設けない。source materialize が成功した通知だけを発行するため、`rows` や `encoding` を `undefined`／`null` で通知する形は認めない。

### 2.2 option の規則

| `onImportSourceMaterialized` | IMPORT 文の状態 | callback | 公開結果 |
| --- | --- | --- | --- |
| 省略 | 任意 | 呼ばない | v3.75.0 と同じ |
| 指定あり | 文へ未到達、EXIT／fail-fast／依存失敗でskip | 呼ばない | 既存の `status: "skipped"` |
| 指定あり | source load、payload検査、decode、materialize のいずれかが失敗 | 呼ばない | 既存の `status: "error"` |
| 指定あり | raw materialize 成功 | 1回 await | resolve後に既存処理を続行 |
| 指定あり | callback がthrow／reject | 再試行しない | 当該文は `status: "error"`、mutation API 0回 |
| 指定あり | 同じ source を別の2文がmaterialize | 文ごとに1回、合計2回 | 各文は独立した `StatementResult` |

`onImportSourceMaterialized` は IMPORT capability を有効化しない。`enableImport` と `importSource` の既存組合せはB177のまま維持する。

parse、validate、explain、context 作成だけでは callback を呼ばない。`executeStatement` が当該 IMPORT 文へ到達し、source の raw materialize に成功した場合だけ呼ぶ。

### 2.3 field の同値規則

| field | 値の決定規則 | 同値判定 |
| --- | --- | --- |
| `statementIndex` | 実行 context 内の `StatementResult.index` | 数値の完全一致 |
| `name` | SQL が参照し、resolver が解決した source name | case-sensitiveな文字列完全一致 |
| `kind` | IMPORT source AST の `"CSV"`／`"JSON"` | literalの完全一致 |
| `rows` | §2.4の source 種別別規則 | 非負整数の完全一致 |
| `encoding` | §2.5の有効 encoding | `"utf8"`／`"sjis"` の完全一致 |

同じ `name` に対する複数通知を消費側が1つの receipt へまとめる場合、source metadata の同値集合は `{ name, kind, rows, encoding }` とする。`statementIndex` はmaterialize occurrenceの識別子であり、source metadata の同値判定には含めない。

同じ `name` で `kind`、`rows`、`encoding` のいずれかが異なる通知を受けた場合に fail-closed とする責務は kSQL-Flow 側にある。engine は通知を dedupeせず、矛盾を隠さない。

### 2.4 `rows` 規則

| source／経路 | `rows` |
| --- | ---: |
| header あり flat CSV | RFC 4180 decode後のdata records数。headerは除外 |
| `NO HEADER COLUMNS` flat CSV | RFC 4180 decode後の全records数 |
| projection あり flat CSV | projection前のraw data records数 |
| flat JSON | top-level input records数 |
| subtable JSON | top-level parent records数 |
| subtable CSV | headerを除く物理data records数。継続行を含む |
| `VALIDATE ONLY` | validation対象／成功件数ではなくraw source records数 |
| `ON ERROR SKIP` | valid／skipped件数ではなくraw source records数 |
| record-number update CSV | headerを除くraw data records数 |

CSVの quoted cell 内改行は1つの record 内の文字であり、`rows` を増やさない。末尾改行は空のdata recordを暗黙追加する理由にしない。

多列CSVの末尾または途中の空行は1 cellのrecordとしてdecodeされ、期待列数との不一致でerrorになるため通知しない。一方、1列CSVの空行は列数が一致する空値のdata recordとして数える（`code\nA\n\n` は `rows: 2`）。

### 2.5 encoding 規則

| source | SQL `ENCODING` | payload `encoding` | callback `encoding` |
| --- | --- | --- | --- |
| CSV | `UTF8` | 任意 | `"utf8"` |
| CSV | `SJIS` | 任意 | `"sjis"` |
| CSV | 省略 | `"utf8"` | `"utf8"` |
| CSV | 省略 | `"sjis"` | `"sjis"` |
| CSV | 省略 | 省略 | `"utf8"` |
| JSON | 指定なし／UTF8相当 | 省略／`"utf8"` | `"utf8"` |
| JSON | — | `"sjis"` | 通知せずstatement error |

SQL指定は loader payload metadata より優先する。callback は canonicalな小文字 unionを返し、大文字化はkSQL-Flow側の Execution Result 組立て時に行う。

### 2.6 `statementIndex`

`statementIndex` は同じ実行 context に登録された statements 配列の0始まりindexであり、対応する `StatementResult.index` と等しくする。

変数解決後の内部 AST、IMPORT から生成される INSERT/UPSERT、validation 用の内部文に別indexを割り当てない。通知には利用者が `executeStatement` へ渡した元の IMPORT 文のindexを使う。

同一 source をstatement 0とstatement 3が参照し、双方がmaterializeに成功した場合、通知は2回で、それぞれ `statementIndex: 0` と `statementIndex: 3` になる。

通知順序は逐次 `executeStatement` の実行順とする。source name順への並べ替えや、文をまたぐ通知の集約は行わない。

## 3. 通知タイミングと fail-closed 契約

### 3.1 共通タイミング

通知境界を次で固定する。

```text
source resolve/load
  -> decode
  -> maxRecords・source構造検査
  -> raw materialized valueを確定
  -> onImportSourceMaterializedをawait
  -> projection／validation／skip選別／確認
  -> mutation
```

「materialize成功」は、対象materializerが例外を投げず、raw materialized valueとreceipt metadataの両方を返した状態を指す。decodeだけ成功し、その後のmaterializer内検査が失敗した場合は成功に含めない。

callback の呼出し後に projection、DML field対応、validation、確認、mutation が失敗しても、既に成功したmaterialize通知を取り消す通知は出さない。

### 3.2 5経路の挿入点

| 経路 | 通知挿入点 | 後続処理との境界 |
| --- | --- | --- |
| flat CSV/JSON・通常 INSERT/UPSERT | raw CSV/JSON materializerが返った直後（`src/execute.ts:10063-10072`） | CSV projection分岐より前（同:10073-10079）。通常INSERTの呼出し元は同:10102-10110、UPSERTは同:11584-11592 |
| flat・`VALIDATE ONLY` | 通常flatと同じ共通raw materialize直後（同:10063-10072） | validation candidateの列数、CHECK、field値検査より前。経路は同:9796-9806,8752-8757,8954-9010 |
| flat・`ON ERROR SKIP` | 通常flatと同じ共通raw materialize直後（同:10063-10072） | invalid row選別およびPOST/PUTより前。経路は同:9808-9813,8873-8904,8918-8951 |
| `IMPORT UPDATE ... MATCH RECORD NUMBER` | CSV materializerが返った直後（同:9939-9942） | record-number重複検査、lookup GET、validation、PUTより前（同:9943-9961,10028-10035） |
| subtable CSV/JSON | import-record materializerが返った直後（同:9669-9672） | 親record準備、validation、lookup、POST/PUTより前（同:9673-9713,9725-9739,9760-9769） |

flat 3経路は同じraw materialize境界へ集約して通知する。経路ごとに個別callbackを追加して二重通知を発生させてはならない。

record-number updateとsubtableは共通flat materialize境界を経由しないため、それぞれの直接materialize直後に通知する。

### 3.3 decode／maxRecords／source境界エラー

次の場合は callback 呼出し回数を0回とする。

- source名未供給
- resolver／loaderのthrowまたはreject
- payload shape／encoding／10 MiB検査失敗
- malformed UTF-8／Shift_JIS
- malformed RFC 4180
- CSVのdata rowなし、列数不一致、header不正
- JSON parse／構造／値materialize失敗
- subtable CSV marker／継続行構造不正
- `maxRecords` 超過
- source materializerが返る前に発生したその他のsource境界エラー

これらは既存の statement error codeを維持する。B178用error codeへ包み直さない。

maxRecords超過はmaterializerの完了前に検出されるため（`src/import/materializeDmlSource.ts:24-26`、`src/import/jsonMaterializer.ts:55-57`、`src/import/importRecordsMaterializer.ts:19-21,89-90`）、通知なし、mutation API 0回とする。

### 3.4 callback resolve

callback は同期戻り値とPromiseの双方を受理し、常に `await` 相当で完了を待つ。

callback が正常終了した場合だけ、projection、validation、`ON ERROR SKIP`、確認、mutationへ進む。callback 実行中にmutationを開始してはならない。

callback の待機時間は当該 statement の実行時間および既存 timeout対象に含める。callbackをfire-and-forgetにしない。

callback正常終了によって `StatementResult`、`result`、metrics、loader回数、kintone API回数を変更しない。

### 3.5 callback throw／reject

callback がthrowまたはrejectした場合は、その値を既存の文実行catchへそのまま伝播する。新しいwrapper errorへ変換しない。

公開結果は次とする。

- 当該 `StatementResult.status === "error"`
- `StatementResult.index === callback.info.statementIndex`
- `StatementResult.error.code` と `message` は既存の変換規則
- 当該文の `postRecords`、`putRecords`、`deleteRecords`、`upsertRecords` 呼出し回数はすべて0
- metadata readの回数は0を保証しない
- 同じcallbackを自動再試行しない
- 後続文は既存fail-fastにより `status === "skipped"` となる

`Error` subclassまたは `Error.name` が指定されたerrorはそのnameをcodeとして保持し、plain `Error` は既存のmessage接頭辞判定へ従う（`src/execute.ts:2869-2885`）。

callback自身が行った外部副作用はengineのrollback対象ではない。engineが保証するmutation 0は、当該IMPORT文がkintone clientへ行うmutation APIについての保証である。

### 3.6 到達しない文

managed contextは、EXIT、fail-fast、timeout、壊れたtemp依存を実行本体より前にskipする（`src/execute.ts:1958-1977`）。この場合、source materializeもcallbackも実行しない。

`EXPLAIN IMPORT` と `previewStatement` はmaterialize receipt通知の対象外とする。receiptは実行時のraw source内容に基づくため、実行されていない文について推定値を通知しない。

## 4. 実装方針

### 4.1 配線方式の比較

| 方式 | 内容 | 利点 | 問題 | 判定 |
| --- | --- | --- | --- | --- |
| (a) 専用引数＋managed context保持 | `onChunkWritten` と同様に公開optionから分離し、managed contextへ専用引数で渡す | `/flow` 専用性が明確。callback lifecycleとstatement indexをmanaged contextが所有できる | materializerは現在 `ExecuteOptions` しか受けないため（`src/execute.ts:10048-10054`）、純粋な(a)だけでは多数の中間関数へ引数追加が必要 | 公開境界と所有方式として採用 |
| (b) `ExecuteOptions`へ追加 | callbackを通常propertyとして全実行経路へ渡す | 実装差分が小さい | CLI/MCP/プラグインと共有するinterfaceの契約を変更し、B178の公開面制約に反する | 不採用 |
| (c) private Symbol seam | `statementEvaluationContextKey` と同様の `unique symbol` を内部optionsへ付加する | 公開propertyを増やさず、既存のoptions搬送を再利用できる | managed contextを介さず直接注入するとsurface境界とstatement index所有が曖昧になる | materializerへの最終搬送として採用 |

採用案は **(a)＋(c)の分離配線** とする。

1. `/flow` adapterが公開optionからcallbackを分離する。
2. callbackを専用引数でmanaged execution contextへ渡す。
3. managed contextがcallbackを保持する。
4. 文実行開始時に0始まりのstatement indexを確定する。
5. callbackがある場合だけ、statement indexをbindした内部callbackをprivate `unique symbol` で当該文用optionsへ付加する。
6. materialize成功箇所はprivate symbol経由でcallbackを取得し、receiptを渡してawaitする。
7. callbackがない場合はsymbolを付加せず、追加処理を行わない。

既存の `statementEvaluationContextKey` は、公開 `ExecuteOptions` を変更せず内部状態を搬送する先例である（`src/execute.ts:794-840`）。B178は別の `unique symbol` を使い、時刻評価contextと責務を混ぜない。

### 4.2 内部materialize receipt

materializerの内部戻り値へ、公開DTOとは分離したreceipt metadataを追加する。

概念形は次とする。

```ts
interface ImportMaterializationReceipt {
  readonly rows: number;
  readonly encoding: ImportEncoding;
}
```

flat materialized tableとsubtable materialized recordsは、materialize成功時にこのreceiptを保持する。source `name`、`kind`、`statementIndex` は呼出し側が既に持つため、materializerへ重複して渡さない。

receiptの生成元は次で固定する。

- flat CSV: `decoded.rows.length` と解決済みCSV encoding
- flat JSON: `decoded records.length` と `"utf8"`
- subtable CSV: グループ化前の `decoded.rows.length` と解決済みCSV encoding
- subtable JSON: top-level `decoded.length` と `"utf8"`

projection結果の `rows.length`、valid candidates数、親record数、mutation件数からreceiptを逆算しない。

### 4.3 通知処理の集中

公開DTOの組立てとcallback awaitは1つの内部通知境界へ集約する。3つの実挿入点がそれぞれ独自にencodingやrow数を再計算してはならない。

実挿入点は次の3箇所だけとする。

1. flat CSV/JSON共通raw materialize直後
2. record-number update CSV materialize直後
3. subtable CSV/JSON materialize直後

`VALIDATE ONLY` と `ON ERROR SKIP` はflat共通境界を通るため、専用通知を追加しない。

### 4.4 callbackのsurface隔離

`src/flow-library/index.ts` は `onImportSourceMaterialized` をdestructureし、残余 `executeOptions` へ含めない。これにより公開callbackが文字列keyの `ExecuteOptions` propertyとしてCLI/MCP/プラグインへ伝播しない。

private symbolを設定する入口はmanaged `/flow` 実行だけとし、CLI/MCP/プラグインから利用するsetterやexportを追加しない。

callback引数はbrowser-neutralなprimitiveだけで構成し、Node `fs`、path、Buffer型を `/flow` bundleへ持ち込まない。

### 4.5 変更ファイル一覧

#### 実装

| ファイル | 変更内容 |
| --- | --- |
| `src/flow-library/publicTypes.ts` | `FlowImportSourceMaterializedInfo`、`CreateExecutionContextOptions.onImportSourceMaterialized?` を追加 |
| `src/flow-library/index.ts` | 新型のtype export、公開optionの分離、managed contextへの専用引数配線 |
| `src/execute.ts` | managed callback保持、statement index bind、private Symbol seam、3箇所の通知 |
| `src/import/types.ts` | 内部materialize receipt型と内部戻り値へのreceipt追加 |
| `src/import/materializeDmlSource.ts` | flat CSVのraw rows／effective encodingをreceiptへ保持 |
| `src/import/jsonMaterializer.ts` | flat JSONのtop-level rows／UTF-8 receiptを保持 |
| `src/import/importRecordsMaterializer.ts` | subtable JSON親数とsubtable CSV物理data record数をreceiptへ保持 |

`src/import/csvDecoder.ts` のRFC 4180、BOM、CRLF処理はB178の通知配線に必要な変更がない限り変更しない。

#### テスト

| ファイル | 変更内容 |
| --- | --- |
| `src/flow-library/__tests__/importSourcePublicApi.test.ts` | 公開 `/flow` APIだけによる通知値、statement index、timing、fail-closed、非回帰 |
| `src/flow-library/__tests__/publicApi.test.ts` | type/export/context lifecycleとoption省略時の回帰 |
| `src/import/__tests__/materializeDmlSource.test.ts` | 既存materialize戻り値にreceiptを加えた内部整合 |
| `src/import/__tests__/jsonMaterializer.test.ts` | JSON top-level件数とUTF-8 receipt |
| `src/import/__tests__/importRecordsMaterializer.test.ts` | subtable CSV物理行、JSON親数、maxRecords前後のreceipt境界 |

自動受入の正は `src/flow-library/__tests__/importSourcePublicApi.test.ts` の公開観測とする。内部materializer testだけでB178完了扱いにしない。

## 5. 後方互換

本変更は純加法とする。

- 既存の必須optionを増やさない。
- `onImportSourceMaterialized` 省略時はv3.75.0と同じ経路を実行する。
- `StatementResult`、`StatementError`、`FlowDmlResult`、metricsのshapeを変更しない。
- IMPORT結果へreceipt fieldを追加しない。
- `FlowImportSourcePayload`へ行数を追加しない。
- `ExecuteOptions`へcallback propertyを追加しない。
- CLI/MCP/プラグインのoption、表示、error、API呼出し回数を変更しない。
- `/engine`へIMPORT型やcallbackを公開しない。
- parser、validator、EXPLAINのloader非実行契約を変更しない。
- IMPORTの10 MiB上限、maxRecords、100件write chunk、native UPSERT分岐、`ON ERROR SKIP`、`VALIDATE ONLY` の結果を変更しない。
- callback指定時も、callback自体を除くloader回数とkintone API回数を増やさない。
- 正常終了するcallbackの有無で `StatementResult` を変えない。
- callback失敗時のfail-closedはopt-in consumerだけに適用される。
- `onChunkWritten` の引数、通知順、throw後の既存意味論を変更しない。

公開 `/flow` option追加のためSemVer上はminorとし、v3.76.0へ収録する。

## 6. テスト方針

### 6.1 受入原則

受入テストはpackageの公開 `/flow` exportだけをimportし、次を観測する。

- `executeStatement` が返す `StatementResult`
- `onImportSourceMaterialized` が受けた引数と呼出し順
- mock `FlowKintoneClient` のread／mutation API呼出し回数
- 必要な場合だけloader呼出し回数

内部関数の呼出し回数や内部return shapeは受入条件にしない。

metadata API呼出し回数は、非回帰比較では固定するが、callback失敗時に常に0であることは要求しない。mutation APIは `postRecords`、`putRecords`、`deleteRecords`、`upsertRecords` の合計で観測する。

### 6.2 最低テストmatrix

| ケース | 公開APIからの期待観測 |
| --- | --- |
| flat UTF-8 CSV・INSERT | callback 1回。`name`、`kind:"CSV"`、data record数、`encoding:"utf8"`、対応する `statementIndex`。文はsuccess |
| flat UTF-8 CSV・UPSERT | callback 1回。raw data record数。文はsuccess。既存のmock API回数を維持 |
| quoted改行入りCSV | quoted cell内改行を別rowに数えず、callback `rows` はRFC 4180 data record数 |
| CRLF CSV | LF版と同じdata record数を通知 |
| 末尾改行あり／なし | 同じ論理CSV fixtureでcallback `rows` が一致 |
| 1列CSVの末尾空行 | 空値のdata recordとして数え、`code\nA\n\n` のcallback `rows` は2 |
| UTF-8 BOM | BOMなしfixtureと同じheader／data record数を通知 |
| `NO HEADER COLUMNS` | 全recordsをdata rowsとして通知 |
| SJIS・payload metadata | SQL encoding省略、payload `encoding:"sjis"` でcallback `encoding:"sjis"`。日本語fixtureの文はsuccess |
| SJIS・SQL句 | payload metadataと異なるSQL `ENCODING` を指定し、callbackはSQL側の有効encoding。SQL優先でdecodeされた公開結果を確認 |
| JSON | callback `kind:"JSON"`、top-level record数、`encoding:"utf8"` |
| flat CSV projection | callback `rows` はprojection前のraw records数。文のmutation件数と異なってよい |
| subtable JSON | callback `rows` はtop-level親record数。child rows数ではない |
| subtable CSV・継続行 | callback `rows` は親行＋継続行の物理data record数。`StatementResult` の更新親数より大きいfixtureで差を確認 |
| `ON ERROR SKIP` | callback 1回でraw records数。valid／skipped件数とは独立。既存の書込結果とmock API回数を維持 |
| `VALIDATE ONLY` | callback 1回。`StatementResult.status:"success"`、validation結果あり、mutation API 0回 |
| record-number update | callback 1回。raw CSV data record数。通知後に既存lookup／validation／PUTが行われる |
| maxRecords超過 | callback 0回。当該文 `status:"error"`。mutation API 0回 |
| malformed CSV／JSON | callback 0回。当該文 `status:"error"`。mutation API 0回 |
| source未供給／loader失敗／payload不正／10 MiB超過 | callback 0回。当該文は既存stable codeのerror。mutation API 0回 |
| callback同期throw | callback 1回。当該文 `status:"error"`。error codeは投入したErrorの既存変換結果。mutation API 0回 |
| callback Promise reject | 同期throwと同じ。Promiseをawaitしたことを順序でも確認 |
| callback正常終了まで保留 | callback Promise未resolve中はmutation mockが0回。resolve後に文が完了 |
| callback throw後の後続文 | 先頭IMPORTはerror、後続文はskipped。後続callback 0回、mutation API 0回 |
| EXIT後のIMPORT skip | IMPORTの `StatementResult.status:"skipped"`。callback 0回、loader 0回、mutation API 0回 |
| 依存temp失敗後のIMPORT skip | IMPORTはskipped。callback 0回、mutation API 0回 |
| 同一sourceを2文が参照 | callback 2回。`name/kind/rows/encoding` は同じで、`statementIndex` が各文のindexと一致 |
| 異なる2 sourceの途中失敗 | 先に成功したsourceだけ通知。失敗中sourceと未到達sourceは通知なし |
| callback省略 | 既存goldenと `StatementResult` および全mock API呼出し回数が一致 |
| no-op callback指定 | callback以外は省略時と同じ `StatementResult`、loader回数、mock API回数 |
| parse／validate／explain／context作成 | callback 0回、loader 0回 |
| `onChunkWritten`併用 | materialize通知が先、mutation成功後にchunk通知。双方の既存引数を維持 |

### 6.3 callback error code

テストでは固有の `Error.name` を持つerrorをcallbackからthrowし、公開 `StatementResult.error.code` がそのnameになることを固定する。

加えてplain `Error` と `{ code, message }` rejectionを各1件確認し、B178が独自wrapperによって既存のcode優先順位を変えていないことを確認する。

### 6.4 非漏出

callback引数を列挙し、keyが次の5つだけであることを確認する。

```text
statementIndex
name
kind
rows
encoding
```

path、bytes、cell値、列名、token、実アプリID、mtime、hashを含めない。

error結果、metrics、`StatementResult.result` にcallback引数やreceiptを暗黙追加しない。

### 6.5 実行順

実装時は次を最低ラインとする。

1. B178公開面のtargeted Jest
2. `src/flow-library/__tests__` 全体
3. import materializer関連Jest
4. `npm run build:flow`
5. `npm run flow:bundle-guard`
6. 公開package pathから新型をimportするdeclaration smoke
7. `npm test`
8. `npm run flow:pack-smoke`
9. `npm pack --dry-run --json`
10. `npm run version:check:release`

静的testとmock client testだけで実kintone確認済みとは記載しない。

## 7. 文書・リリース

### 7.1 文書更新

| ファイル | 更新内容 |
| --- | --- |
| `README.md` | `/flow` export一覧、callback利用例、rows／encoding／timing／throw契約 |
| `docs/ksql_language_reference.md` | `/flow` IMPORT節にmaterialized receipt、source種別別rows、statementIndex、fail-closedを追加 |
| `docs/ksql_issue_tracker.md` | B178を実装・検証・公開状態へ同期 |
| `CHANGELOG.md` | v3.76.0の純加法API、既定動作不変、callback failure時mutation 0 |
| `docs/ksql_release_history.md` | 公開commit、version、検証結果 |
| kSQL-Flow側回答文書 | 利用可能な最低engine version、公開型、callback例、statementIndex追加を通知 |

READMEの例は公開package pathからのみimportし、内部 `ExecuteOptions`、private symbol、`src/import/*` を使わない。

### 7.2 配布物

release候補で次を確認する。

- `dist-flow/flow-library/publicTypes.d.ts` に新interfaceとoptionが存在する
- `dist-flow/flow-library/index.d.ts` から新型をimportできる
- ESM／CJSの両方で既存value exportが維持される
- private symbolと内部receipt型は公開declarationへexportされない
- Node `fs/path`、CLI実装が `/flow` bundleへ混入しない
- npm tarballが更新済みdeclarationを含む

release時は `package.json`、`package-lock.json`、`prod/manifest.json`、`release/VERSION.txt`、`release/README.txt` をv3.76.0へ同期する。

### 7.3 公開順序

```text
kSQL engine v3.76.0 publish
  -> registry tarballで公開型・bundle・receipt testを再確認
  -> kSQL-Flowが最低依存をv3.76.0へ更新
  -> kSQL-Flowが公開 /flow callbackだけでinput_filesを組み立て
  -> kSQL-Flow Contract v1.1 testを実行
  -> features.importCsv=trueを開放
  -> FlowNet段階1を開放
```

kSQL-Flowは同一source名の通知について `{ kind, rows, encoding }` を照合し、一致時だけ1 entryへdedupeする。矛盾時はfail-closedとする。engine v3.76.0の公開だけでkSQL-Flow側のgate完了とは扱わない。

## 8. Claude が実測すべき未確認事項

次はR1時点で静的根拠はあるが、公開期待値を固定する前にClaudeが実行testで確認する。

1. CRLF、LF、末尾改行あり、末尾改行なしの各CSVについて、同じ論理recordsが同じ `rows` になること。
2. UTF-8 BOM付きCSVでBOMが先頭header名へ残らず、BOMなしと同じ `rows` になること。
3. quoted cell内にCRLFを含むCSVで、quoted改行が別recordに数えられないこと。
4. `NO HEADER COLUMNS` と末尾改行の組合せで、空の末尾recordが追加されないこと。
5. subtable CSVの継続行が `rows` に含まれ、親record数より大きい値をcallbackが返すこと。
6. subtable CSVでmaxRecordsが親数に対して適用される現行意味論と、receiptの物理data record数が両立すること。
7. callback Promiseを未解決にした間、すべてのmutation API呼出しが0のままであること。
8. callback throw後、当該文がerror、後続文がfail-fast skipとなり、callbackが再試行されないこと。
9. 同じresolver handle／source nameを2つのIMPORT文が参照した場合、materialize通知が2回発生し、異なる `statementIndex` を持つこと。
10. `VALIDATE ONLY` と `ON ERROR SKIP` の各経路で、1文内の通知が1回だけであること。
11. callbackと `onChunkWritten` を併用した場合、materialized通知が最初のchunk通知より先に完了すること。
12. kSQL-Flow側が追加の `statementIndex` を受理し、同一source metadataのdedupe判定から除外できること。
13. registry tarballのESM／CJS／declarationから新型を利用でき、private symbolと内部receipt型が公開されないこと。

1〜6の実測値が§2の規範と異なる場合、decoder挙動をB178で暗黙変更せず、差異を記録してR2で互換性判断を行う。

## 9. 見積り

1人日を実装、review修正、自動testまでを含む作業日とし、npm公開承認、実kintone環境待ち、kSQL-Flow／FlowNet側実装は含めない。

| 作業 | 見積り |
| --- | ---: |
| 公開型、managed context、private Symbol配線 | 0.3〜0.5人日 |
| materializer receiptと3通知点 | 0.4〜0.7人日 |
| 公開API成功系・fail-closed test | 0.6〜0.9人日 |
| CRLF／BOM／subtable／複数文の実測固定 | 0.3〜0.5人日 |
| README、言語リファレンス、CHANGELOG、台帳 | 0.2〜0.4人日 |
| build、declaration、bundle、pack、全suite、review修正 | 0.4〜0.7人日 |
| **合計** | **2.2〜3.7人日** |

kSQL-Flow側のreceipt registry、同値検査、Execution Result `input_files`、dependency更新、Contract testは別見積りとする。engine公開後のkSQL-Flow／FlowNet実機E2Eも別枠とする。


---

## R1 レビュー（Claude・2026-09-03）

**判定: R1 を実装可とする。** 下記の修正は小さいので R2 を起こさず、実装時に本文へ反映する（反映後は本節の該当項目に「反映済み」と追記する）。

### 静的主張の照合（file:line）

- §1.2 の catch（`src/execute.ts:2036-2044`）・§1.3 の `ON ERROR SKIP` が事前 validation を経由し再 materialize しない（`executeOnErrorSkip` → `prepareDmlValidation`、`src/execute.ts:8881-8904`）・5 経路の挿入点（起票 §2.1 と一致）＝**すべて実コードと一致**。
- private symbol seam の前提＝per-statement options は `{ ...options, ... }` の spread で作られる（例 `src/execute.ts:9798,10078`）ため、symbol キーの own enumerable property は搬送される。既存 `statementEvaluationContextKey` と同じ前提で成立する。

### 実測で確定（起票 §5・§8 の 1〜4 を解消）

| 入力 | `rows` | 仕様への反映 |
|---|---|---|
| LF・末尾改行あり／なし、CRLF | 同値 | §2.4 のとおり |
| BOM＋LF | BOM なしと同値 | §2.4 のとおり |
| quoted cell 内 LF／CRLF | 1 record | §2.4 のとおり |
| **多列 CSV の空行（末尾・途中）** | **throw**（列数不一致）→ 通知なし | §3.3 の「列数不一致」に含まれる。§2.4 に明記する |
| **1 列 CSV の末尾空行** | **空値の data row として +1**（`code\nA\n\n` → 2） | **§2.4 に追記する**＝「列数が一致する空行は data record」。kSQL-Flow へ通知済み（fixture が踏まないよう先方が固定する） |
| `NO HEADER COLUMNS`＋末尾改行 | 全 record・空 record 追加なし | §8-4 解消 |
| header だけ | throw（data row なし）→ 通知なし | §3.3 のとおり |

### 文言の修正（実装時に反映）

1. **反映済み。** §2.1 の `name` コメント「`FROM CSV/JSON SOURCE`」→ 実構文は `FROM CSV <name>` / `FROM JSON <name>`（`SOURCE` はキーワードではない）。
2. **反映済み。** §2.4 末尾「末尾改行は空の data record を暗黙追加する理由にしない」の直後に、上表の 2 行（多列空行＝エラー／1 列空行＝data record）を追記する。
3. **反映済み。** §6.2 に「1 列 CSV の末尾空行 → `rows` が +1」の固定テストを 1 行加える（先方 fixture の罠を engine 側でも固定する）。

### 残る未確認（§8 のうち実装後に Claude が実測するもの）

§8 の 5〜13。特に 7（callback 未 resolve 中の mutation 0）・11（`onChunkWritten` との順序）・13（tarball の declaration）は公開 API の観測で固定する。
