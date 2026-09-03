# `/flow` named IMPORT source 公開 API 実装計画 R1

- 作成日: 2026-09-03
- 対象: `@rex0220/kintone-sql-tools/flow`（engine リポジトリ）
- ステータス: ✅ **B177 v3.75.0 でリリース済み（2026-09-03）**（`flow:declaration-smoke` は任意・未実施）
- 課題: [B177 台帳](../ksql_issue_tracker.md#1-バックログ未リリース要対応)
- 上流要求: `C:\Users\rex02\Projects\ksql-flownet\docs\internal\csv-io-implementation-plan.md` §2.1、§3.1
- SemVer: **minor**。既存利用者の既定動作を変えない additive な公開 API 追加

## 0. 結論

現行 engine は IMPORT の parser、AST、CSV/JSON decoder、10 MiB byte 上限、DML 実行を既に持ち、CLI・MCP・プラグインからは内部 `ExecuteOptions.enableImport` / `importSource` を通して利用している。一方、公開 `/flow` はこの capability と source 型を公開しておらず、`parseScript` / `validateScript` / `explainScript` / `createExecutionContext` の正式経路から IMPORT を使えない。

次の最小追加でこの差を解消する。

1. `/flow` から `ImportEncoding`、`FlowImportSourcePayload`、`FlowImportSourceLoader`、`FlowImportSourceResolver`、named source 登録型と登録 helper を公開する。
2. `ParseScriptOptions.enableImport?: boolean` を追加し、これを継承する `ValidateScriptOptions`、`ExplainScriptOptions`、`CreateExecutionContextOptions` の全てで同じ gate を使う。省略または `false` は現行どおり IMPORT を `KSQL1202` で拒否する。
3. `CreateExecutionContextOptions.importSource?: FlowImportSourceResolver` を追加し、実行時だけ source 名を解決して loader を遅延実行する。parser・validator・EXPLAIN は loader を呼ばない。
4. source 登録、解決、load、payload 検査の失敗を `...Error` 形式の安定 code に分ける。ファイル path の解決、`lstat` / open / read は呼び出し側の責務であり、engine は path を受け取らず `Uint8Array` だけを検査・消費する。
5. SQL の `ENCODING UTF8|SJIS` > loader の `encoding` > UTF-8、という現行優先順位は変えない。

`/engine` read-only API、既存 CLI/MCP/plugin の IMPORT 入力形、dialect 0/1 の既存 SQL、IMPORT を使わない `/flow` consumer は変更しない。

## 1. 現状調査（2026-09-03 の実コード）

### 1.1 公開 `/flow` 面

`package.json:21-32` の `exports["./flow"]` は ESM/CJS と declaration を `dist-flow` から公開する。entry point は `src/flow-library/index.ts`、公開型は `src/flow-library/publicTypes.ts` である。現在の value export は `version`、`parseScript`、`validateScript`、`explainScript`、`createExecutionContext`、`previewStatement`、`executeStatement`、`disposeExecutionContext`、`createKintoneClient`、`KsqlFlowError`、`isDmlResult` である（`src/flow-library/index.ts:36-47,49-115,116-244,323-357`）。

現行公開型の不足は次のとおり。

| 公開 API | 現状 | IMPORT に必要な差分 |
| --- | --- | --- |
| `parseScript(source, opts)` | `ParseScriptOptions` は `apps?` のみ | `enableImport?` を parser capability へ渡す |
| `validateScript(source, opts)` | `ParseScriptOptions` を継承するが IMPORT gate を指定できない | parse と同じ `enableImport?` を使う |
| `explainScript(source, opts)` | IMPORT を parse できず、内部 planner の `enableImport` 引数には常に `false` が渡る | dry-run parity のため同じ gate を渡す |
| `createExecutionContext(opts)` | `enableImport` / `importSource` が公開型にない | gate と resolver を managed execute options へ渡す |
| `executeStatement(stmt, context)` | context の内部 options を使うため関数固有 option はない | context 作成時の設定だけで実行する |

`createExecutionContext` は `client`、script/statement 入力、`apps`、`onChunkWritten`、`enableNativeUpsert` を除いた残余 option を `createManagedStatementExecutionContext` へ渡す（`src/flow-library/index.ts:116-154`）。従って公開型へ `enableImport` / `importSource` を追加すれば、実行層の既存 `BatchExecuteOptions` へ到達できる。ただし、型追加だけでは parser adapter と EXPLAIN の gate は開かないため §4 の配線が必要である。

`build-flow.mjs` は `src/flow-library/index.ts` を bundle し、`tsconfig.flow.json` から declaration を生成する。`flow-bundle-guard` は CLI、MCP、plugin UI、zod の混入を禁止する。公開実装は `src/import/*` の path-free primitive を共有してよいが、`src/cli/*` を import してはならない。

### 1.2 KSQL1202 の発生箇所

`src/core/script.ts:58-60` の `parseScript` は `new Parser(..., { dialect1 })` としており、IMPORT capability を渡していない。`src/parser/parser.ts:511-515,780-784` は先頭 `IMPORT` と `EXPLAIN IMPORT` の双方で `capabilities.import` が false の場合、`ParseError("IMPORT is not supported (capability is disabled).")` を投げる。`src/core/script.ts:81-101` がこれを `DiagnosticCodes.PARSE_ERROR`、すなわち **`KSQL1202`**（`src/core/diagnostics.ts:9-11`）に変換する。

したがって現行の `/flow` では次が成立する。

- `parseScript` は throw せず、`diagnostics[]` に `KSQL1202` を返す。
- `validateScript` は parse error があればその diagnostics を返し、schema validationへ進まない。
- `createExecutionContext({ script })` は同じ parse diagnostic を `KsqlFlowError` として throw する。
- `statements+meta` を非公開 parser 等で作って渡す迂回は公開契約ではない。

この fail-closed 既定は維持する。IMPORT が予約語になったわけではなく、明示 capability がある場合だけ既存 soft keyword parser を開く。

### 1.3 engine 内部の capability と named source

既存機構は既に存在する。

```ts
// src/execute.ts（現行内部公開型）
interface ExecuteOptions {
  enableImport?: boolean;
  importSource?: ImportSourceResolver;
}

// src/import/types.ts（現行内部型）
interface ImportSourcePayload {
  bytes: Uint8Array;
  encoding?: "utf8" | "sjis";
}
interface ImportSourceHandle {
  load(): Promise<ImportSourcePayload>;
}
type ImportSourceResolver = (name: string) => ImportSourceHandle | undefined;
```

`src/import/sourceLoader.ts:3-32` は resolver の不在、source 名の未供給、payload の `Uint8Array` 検査、`IMPORT_MAX_BYTES = 10 * 1024 * 1024` を持つ。同一 `ImportSourceHandle` の load Promise は実行内 cache に保持される。現状はこれらをすべて概ね `ImportSourceError` 1 code に畳んでおり、呼び出し側 loader の I/O error も安定分類していない。

### 1.4 CLI の `--import-csv` / `--import-json` 経路

`src/cli/index.ts:392-412` は repeatable な `--import-csv <name=path>` / `--import-json <name=path>` を `Record<string,string>` に収集する。同じ name が CSV/JSON のいずれかに既にあれば引数解析時に `ArgumentError: import source "..." is specified more than once.` で拒否する。

実行直前に次の resolver を作り、`executeBatch`、単文 `execute`、dry-run `EXPLAIN` の `enableImport` / `importSource` へ渡す。

```ts
const importSource = (name: string) => {
  const sourcePath = args.importCsv[name] ?? args.importJson[name];
  return sourcePath === undefined
    ? undefined
    : { load: async () => ({ bytes: new Uint8Array(readFileSync(sourcePath)) }) };
};
```

CLI loader は path を engine core へ渡さず、`lstatSync` で通常ファイルを確認してから `readFileSync` する。検査・read の fs failure は path と OS 原因（`ENOENT` 等）を含む `ImportSourceReadError` 相当にし、directory 等は path 入りの `ImportSourceNotRegularFileError` 相当にする。これは path を指定した CLI 呼び出し側だけの詳細であり、公開 `/flow` 境界の message に path を含めない契約は変えない。公開 `/flow` 実装でこの CLI module を直接 importしてはならない。kSQL-Flow 固有の allowlist、realpath、sha256、保持期限は別リポジトリの責務である。

### 1.5 `executeImport` と `executeOnErrorSkip`

`src/execute.ts:9639-9649` の `executeImport` は最初に `enableImport` を確認し、次に `resolveImportSource(stmt.source.sourceName, options.importSource)` で handle を得る。flat IMPORT では `ImportExecutionSource` を generated `INSERT_SELECT` / `UPSERT_SELECT` に関連付け（`src/execute.ts:9781-9791`）、`materializeDmlSource` が loader を実行して CSV/JSON を materialize する（`src/execute.ts:10048-10077`）。

`executeOnErrorSkip` は事前 validation 後の有効行だけを処理する（`src/execute.ts:8873-8904`）。INSERT は100件単位の `postRecords`（同:8918-8923）、IMPORT由来 UPSERT は `importSourceByDmlStatement` の印（同:9040）により native UPSERT 対象外となり、既存キーを先に GET して create/update に分け、POST/PUT を各100件単位で実行する。従って単一重複禁止キーと同一 source bytes の条件下では、部分適用後の再実行時に既適用キーが update、未適用キーが create へ回る現行意味論を維持できる。

source の文字コードは `materializeCsvDmlSource` → `decodeCsv` で次の順に決まる。

```ts
source.encoding ?? payload.encoding ?? "utf8"
```

SQL の `ENCODING` 句が loader metadata より優先する要求は既に満たしており、この式を回帰テストで固定する。JSON は UTF-8 固定であり SQL `ENCODING` を parser が拒否する現行規則を変えない。

## 2. 公開 API 契約

### 2.1 公開型

`src/flow-library/publicTypes.ts` に、内部 AST や `ExecuteOptions` 全体を公開せず、次の `/flow` 専用 DTO とerror code unionを追加する。value class `FlowImportProviderError` とresolver helperは `src/flow-library/importSources.ts` に実装して `index.ts` から公開する。命名は既存の `FlowKintoneClient`、`FlowChunkWrittenInfo` と同じく、曖昧な型には `Flow` 接頭辞を付ける。

```ts
export type ImportEncoding = "utf8" | "sjis";

export interface FlowImportSourcePayload {
  readonly bytes: Uint8Array;
  readonly encoding?: ImportEncoding;
}

export interface FlowImportSourceLoader {
  load(): Promise<FlowImportSourcePayload>;
}

/** SQL source name -> lazy loader。path を受け取る契約ではない。 */
export type FlowImportSourceResolver = (
  name: string
) => FlowImportSourceLoader | undefined;

export interface FlowNamedImportSource {
  readonly name: string;
  readonly loader: FlowImportSourceLoader;
}

export type FlowImportProviderErrorCode =
  | "ImportSourceReadError"
  | "ImportSourceNotRegularFileError";

export class FlowImportProviderError extends Error {
  readonly code: FlowImportProviderErrorCode;
  readonly cause?: unknown;
  constructor(
    code: FlowImportProviderErrorCode,
    message: string,
    cause?: unknown
  );
}
```

加えて `src/flow-library/index.ts` から次を value export する。

```ts
export function createImportSourceResolver(
  sources: readonly FlowNamedImportSource[]
): FlowImportSourceResolver;
```

helper は source name の空文字を拒否し、**完全一致・case-sensitive** で map を作る。SQL の source name は `parseIdentifier()` が返す文字列（`src/parser/parser.ts:836-841`）と同じ値で照合し、暗黙の小文字化、path basename 化、拡張子補完はしない。同名が2件あれば `KsqlFlowError.code = "ImportSourceDuplicateError"` を同期 throw し、後勝ちにしない。loader 自体は登録時にも parse/validate/explain 時にも呼ばない。`FlowImportProviderError` は `name` と `code` の双方を指定codeに設定し、managed executionの既存変換（`src/execute.ts:2862-2897`）でcodeが失われないようにする。

raw resolver も正式公開するが、複数 source の登録には重複検査を持つ `createImportSourceResolver` を規範経路とする。kSQL-Flow はこの helper を使い、非公開 `ExecuteOptions` の import や型 cast を行わない。

### 2.2 option と capability 伝播

公開 option は次の additive 変更とする。

```ts
export interface ParseScriptOptions {
  apps?: Readonly<Record<string, number>>;
  /** Omitted/false keeps IMPORT unavailable and preserves KSQL1202. */
  enableImport?: boolean;
}

export interface CreateExecutionContextOptions extends ParseScriptOptions {
  // existing fields...
  importSource?: FlowImportSourceResolver;
}
```

`ValidateScriptOptions` と `ExplainScriptOptions` は既に `ParseScriptOptions` を継承するため、同じ `enableImport` を得る。呼び出し方は次で固定する。

```ts
const importSource = createImportSourceResolver([
  {
    name: "orders",
    loader: {
      async load() {
        return { bytes, encoding: "sjis" };
      },
    },
  },
]);

const capability = { enableImport: true } as const;
const parsed = parseScript(sql, capability);
const diagnostics = await validateScript(sql, { ...capability, schema });
await explainScript(sql, { ...capability, client });
const context = createExecutionContext({
  ...capability,
  client,
  statements: parsed.statements,
  meta: parsed.meta,
  importSource,
});
```

同値規則は次のとおり。

| `enableImport` | `importSource` | parse/validate/explain | execution context / execute |
| --- | --- | --- | --- |
| 省略 / `false` | 省略 | 現行どおり `KSQL1202` | IMPORT AST が渡された場合も fail-closed |
| 省略 / `false` | あり | resolver の存在だけでは gate を開かない | loader を呼ばず fail-closed |
| `true` | 省略 | IMPORT 構文を解析・検証・EXPLAIN可 | source 解決時に `ImportSourceNotSuppliedError` |
| `true` | あり | IMPORT 構文を解析・検証・EXPLAIN可。loaderは未実行 | `executeStatement` が到達した IMPORT だけ resolve/load |

`enableImport` と resolver の存在を別々の暗黙 gate にしない。parser capability の正は常に `enableImport === true` とする。`createExecutionContext({ statements, meta })` に IMPORT AST を渡しながら gate を省略した場合は、context 作成時に `KsqlFlowError.code = "KSQL1202"` で同期拒否し、先行 API を呼ばない。これにより非公開 parser で作った AST による gate 迂回も閉じる。

### 2.3 lazy load、bytes、encoding

resolver は名前を loader handle に解決するだけで、bytes は返さない。loader は当該 IMPORT 文へ実行が到達したときに初めて呼ぶ。同じ handle は同一 IMPORT 実行内で1回だけ load し、Promise を再利用する。通常 resume でスキップされるノードや、先行 `EXIT SUCCESS IF` により到達しない IMPORT の loader は呼ばない。

loader 成功値は次を満たす。

- `bytes` は `Uint8Array`。検査は `instanceof` だけに依存せずcross-realmを考慮する。文字列、素のArrayBuffer、pathは受理しない。Nodeの`Buffer`は`Uint8Array` subtypeとしてのみ受理し、公開型をBuffer依存にしない。
- `encoding` は省略可。指定可能値は `"utf8" | "sjis"` のみ。
- engine は実際に返された `bytes.byteLength` を10 MiB以下か再検査する。呼び出し側の事前 `stat` だけを信用しない。
- engine は loader の bytes を変更しない。内容、path、cell value を error message、metrics、resultへ追加しない。
- CSV の effective encoding は `SQL ENCODING > payload.encoding > utf8`。JSON はUTF-8のみ。

### 2.4 ファイル責務境界

engine `/flow` は次を**行わない**。

- path 文字列、URL、file handle を公開 API 入力として受け取る
- cwd からの相対解決、環境変数展開、拡張子補完
- `stat` / `lstat` / `realpath`、symlink/junction、allowlist、保持期限の判定
- ファイル open/read、sha256、期待 hash との照合
- 絶対 path のログ・結果への出力

kSQL-Flow は FlowNet から受けた検証済み絶対 path に対し、`lstat` と open handle の検査、通常ファイル確認、実 read、sha256/bytes 照合を行い、最後に `Uint8Array` を返す loader を構成する。通常ファイルでない場合は公開 `FlowImportProviderError("ImportSourceNotRegularFileError", ...)`、open/read不能は `FlowImportProviderError("ImportSourceReadError", ..., cause)` を throw する。engine はこの stable code を保持し、その他の loader rejection は `ImportSourceReadError` へ包み、raw fs codeやpathを公開 resultへ漏らさない。

## 3. 安定エラー契約

本リポジトリの実行エラーは `ArgumentError`、`FetchAllLimitError`、`ExecutionContextOrderError` のような **PascalCase + `Error`** を `code` に使う。IMPORT source 境界も同じ規約に合わせる。CSV内容上の既存 `ERR_IMPORT_*` やDML validation codeは本件で改名しない。

| code | 発生条件 | 発生時点 | fail-closed 条件 |
| --- | --- | --- | --- |
| `KSQL1202` | `enableImport !== true` で IMPORT / EXPLAIN IMPORT | parse/validate、または context 作成 | loader・kintone API・mutation 0 |
| `ImportSourceDuplicateError` | named source 登録に完全一致する name が複数 | `createImportSourceResolver` | resolverを作らず同期 throw |
| `ImportSourceNotSuppliedError` | SQL が参照する name を resolver が返さない、または resolver 未指定 | IMPORT 文の source 解決 | message は `ImportSourceNotSuppliedError: the named IMPORT source "<name>" was not supplied.`。loader・当該文のkintone API・mutation 0 |
| `ImportSourceReadError` | raw resolver 関数が throw、loader が open/read不能を報告、または未知の理由でreject | source 解決または loader await | mutation 0。causeは非enumerable。公開 `/flow` loader はpathをmessageに含めず、CLI fs loaderだけはpathと原因を保持 |
| `ImportSourceNotRegularFileError` | caller が directory、device、socket等を拒否 | loader await | read完了扱いにせず mutation 0 |
| `ImportSourceTooLargeError` | 実 payload が10 MiB超 | loader成功直後 | decode・mutation 0 |
| `ImportSourceInvalidPayloadError` | resolver が返す handle の `load` が関数でない、bytesが`Uint8Array`でない、encodingが不正 | source 解決またはloader成功直後 | decode・mutation 0 |

`executeStatement` は現行の managed execution 契約どおり、実行中の source errorを原則 throw せず `StatementResult { status: "error", error: { code, message } }` で返し、後続を fail-fast skip にする。登録時の重複、context引数不整合、context lifecycle errorは同期/Promise rejectionの `KsqlFlowError` とする。この境界を公開テストで固定し、呼び出し側が message の文字列照合をしなくて済むようにする。

優先順位も固定する。capability disabledとsource name未供給はloaderより先に拒否し、provider/type/size、CSV/JSON decode、schema/DML validationの全てが成功するまでmutationへ進まない。metadata API とsource loadの前後はsource種別によって現行順序が異なるため統一せず、source transport error時のmetadata API 0は保証しないが、**mutation APIは常に0**を保証する。

## 4. 実装方針

### 4.1 parser / validate / explain

1. `src/core/script.ts` の internal `ParseScriptOptions` に `enableImport?: boolean` を追加し、`Parser` capabilityへ `import: opts.enableImport === true` を渡す。
2. `src/flow-library/index.ts::parseWithBindings` は公開 optionをそのまま core parserへ渡す。LAPP正規化・source offset復元は変更しない。
3. `validateScript` は `parseWithBindings` を共有するため同じ gateになる。IMPORT固有のschema validationは既存 `validateStatementStatic` / 実行前 validationを再利用し、loaderを呼ばない。
4. `explainScript` は `buildBatchExplainPlans` の既存 `enableImport` 引数へ `opts.enableImport === true` を渡す。plannerは source bytesを要求せず、実データ依存値を捏造しない。
5. `createExecutionContext({ script })` は同じ parser optionを使う。`statements+meta` 入力では IMPORT AST と gate の不一致を明示検査する。

### 4.2 source adapter

1. `src/import/types.ts` の内部型を直接 re-exportせず、`src/flow-library/publicTypes.ts` の DTO と構造互換にする。内部 import graphにFlow adapterへの逆依存を作らない。
2. `src/flow-library/importSources.ts` を新設し、named listの重複検査、map化、`FlowImportProviderError` を実装する。このmoduleはNode `fs/path`をimportしない。
3. `src/import/sourceLoader.ts` は単一 `ImportSourceError` への集約をやめ、source境界の安定 subclass/codeを追加する。CSV parse/content errorの既存 `ImportSourceError` は維持する。
4. `loadImportSource` は provider errorのcodeを保持し、未知の loader rejectionだけを `ImportSourceReadError`へwrapする。成功後にpayload shape、encoding、実byte長を検査する。
5. `executeImport` の既存 `enableImport` / resolver / materializer経路を再利用し、別の `/flow` 専用IMPORT executorを作らない。

### 4.3 CLI との境界

現行CLIは既に公開済みであり、重複時の `ArgumentError` とfs errorの表示を本件で変更すると「既存利用者に影響しないadditive変更」から外れる。このreleaseではCLI実装を変更せず、`/flow`用のbrowser-neutral primitiveだけを追加する。将来CLIを同じstable codeへ移行する場合は別issueで互換性を判断する。

`src/import/sourceLoader.ts` にNode `fs`を入れず、`flow-bundle-guard`でCLI/Node固有実装が `/flow` bundleへ混入しないことを検証する。

## 5. 変更ファイル一覧

### 5.1 実装時に変更するファイル

| ファイル | 変更内容 |
| --- | --- |
| `src/flow-library/publicTypes.ts` | 公開 source DTO/error code、`enableImport?`、`importSource?` |
| `src/flow-library/index.ts` | 型/value export、parse/create/explainへのgate伝播、statements入力のgate検査 |
| `src/flow-library/importSources.ts`（新規） | named source registry、重複検査、provider error |
| `src/core/script.ts` | `enableImport` を parser capabilityへ接続 |
| `src/import/types.ts` | 公開DTOと構造互換な内部alias整理 |
| `src/import/sourceLoader.ts` | stable source error、provider rejection wrap、payload/encoding/size検査 |
| `src/execute.ts` | 必要最小限のerror伝播・context preflight。既存 `executeImport` / `executeOnErrorSkip` 意味論は維持 |
| `build-flow.mjs` | 新規 declaration `importSources.d.ts` を配布物へcopy |

### 5.2 テスト

| ファイル | 目的 |
| --- | --- |
| `src/flow-library/__tests__/importSourcePublicApi.test.ts`（新規） | 公開APIだけでparse→validate→context→execute、lazy load、UTF-8/SJIS、error境界 |
| `src/flow-library/__tests__/publicApi.test.ts` | export面、KSQL1202既定、context lifecycleとの非回帰 |
| `src/import/__tests__/sourceLoader.test.ts`（新規） | provider error保持、invalid payload、10 MiB境界、Promise cache |
| `scripts/flow-bundle-guard.mjs` | Node fs/CLI混入が無いこと。既存guardで足りるなら変更せずテストのみ |

### 5.3 公開文書・リリース

| ファイル | 変更内容 |
| --- | --- |
| `README.md` | `/flow` export一覧、bytes-only source例、path責務境界、既定OFF |
| `docs/ksql_language_reference.md` | §27へIMPORT capability、encoding優先順位、10 MiB、stable code表 |
| `docs/flow_engine_requests_20260821.md` または新しい回答文書 | kSQL-Flowへの対応versionと利用例。既存完了記録を改変するより新規回答文書を推奨 |
| `CHANGELOG.md` | 新minor節へ `/flow` IMPORT公開API、既定OFF、error code、移行不要を記載 |
| `package.json` / `package-lock.json` / `prod/manifest.json` / `release/VERSION.txt` / `release/README.txt` | release時のversion同期 |
| `docs/ksql_release_history.md` | 公開後のrelease記録 |

この計画書自身以外は、本計画作成時には変更しない。

## 6. 後方互換性

変更は additive とする。

- `enableImport` の省略/`false` は現行と同じ。IMPORTは `KSQL1202`、通常SQLは同じAST/result/errorとなる。
- `importSource` だけを渡してもgateは開かない。設定ミスでIMPORTが暗黙有効にならない。
- 既存の `ParseScriptOptions`、`ValidateScriptOptions`、`ExplainScriptOptions`、`CreateExecutionContextOptions` の必須fieldは増やさない。
- `StatementResult`、`FlowDmlResult`、metrics、`onChunkWritten` の既存shapeは変えない。IMPORT結果固有のfieldを新たな安定DML unionへ混ぜない。
- `/engine` は引き続きIMPORTを `READ_ONLY_VIOLATION` とし、write methodやIMPORT型を公開しない。
- CLI/MCP/pluginの既存IMPORT構文、10 MiB上限、CSV/JSON内容検証、100件write chunk、IMPORT由来UPSERTの事前GET分岐を変えない。
- ksql-dashboard等のread-only `/engine` consumerは型・bundle・実行のいずれも影響を受けない。`/flow` consumerも新optionを使わなければ影響を受けない。

公開後に `enableImport` や10 MiB上限を撤去・既定ON化する場合は別の互換性判断を要する。本リリースでは行わない。

## 7. テスト方針

### 7.1 公開 API 成功系

mock `FlowKintoneClient` と公開 `/flow` exportだけをimportするテストを作る。内部 `execute`、`ExecuteOptions`、`src/import/*` をtestから直接importして成功扱いにしない。

1. UTF-8 CSV: `parseScript(enableImport:true)` → `validateScript` → `createExecutionContext(importSource)` → `executeStatement` でINSERT/UPSERTが成功し、期待payloadをclientが受ける。
2. Shift_JIS CSV: loader metadata `encoding:"sjis"` だけで日本語を正しくdecodeする。
3. SQL優先: SJIS metadataを持つloaderへUTF-8 bytesを返し、SQLに `ENCODING UTF8` を書くと成功する。逆方向も1件固定し、`source.encoding ?? payload.encoding ?? "utf8"` の優先順位を証明する。
4. UTF-8既定: SQL句もmetadataもない場合にUTF-8として成功する。
5. lazy性: parse、validate、explain、context作成ではload count=0、対象IMPORTの `executeStatement` 到達時だけ1になる。先行EXITでskipされたIMPORTは0のまま。
6. 同一handle cache: 1文内の複数materialize経路があってもloadは1回。必要なら別IMPORT文はresolverが同じhandleを返しても文ごとの現行cache範囲を明記して固定する。
7. IMPORT + `ON ERROR SKIP` + `ON DUPLICATE`: existing keyとnew keyを混在させ、事前GET後にPUT/POSTへ分かれ、native `upsertRecords` が呼ばれない。

### 7.2 fail-closed matrix

各ケースで `error.code`、loader call数、get/post/put/delete/upsert call数を検査する。少なくともmutation API 0を必須とする。

| ケース | 期待 |
| --- | --- |
| capability省略/falseの `parseScript` / `validateScript` | `KSQL1202`。現行messageと位置を維持 |
| capability省略の `createExecutionContext({script})` | `KsqlFlowError.code === "KSQL1202"` |
| capability省略でIMPORT ASTを `statements+meta` 入力 | context作成時 `KSQL1202`、resolver/load 0 |
| source未供給 | statement `status:error`、`ImportSourceNotSuppliedError`、mutation 0 |
| raw resolver関数がthrow | `ImportSourceReadError`、当該文のkintone API・mutation 0 |
| named source重複 | `createImportSourceResolver` が `ImportSourceDuplicateError`、loader 0 |
| loader read不能 | `ImportSourceReadError`、cause非列挙、messageにpath/token/cell値なし |
| directory等 | callerの `ImportSourceNotRegularFileError` がstatement codeへ保持、mutation 0 |
| `10 MiB + 1 byte` | `ImportSourceTooLargeError`、decode/mutation 0。metadata API回数は非契約 |
| `10 MiB` 境界 | size理由では拒否しない |
| handleの`load`が関数でない / bytes型不正 / encoding不正 | `ImportSourceInvalidPayloadError`、mutation 0 |
| malformed UTF-8/SJIS、RFC4180不正 | 既存 `ImportSourceError`。source transport codeと混同しない |

### 7.3 回帰・配布検証

実装時は次の順で実行する。

1. `npx jest --runInBand src/flow-library/__tests__/importSourcePublicApi.test.ts src/import/__tests__/sourceLoader.test.ts`
2. `npx jest --runInBand src/flow-library/__tests__`
3. `npm run build:flow`
4. `npm run flow:bundle-guard`
5. declaration smokeとして、公開 package pathから新型/helperだけをimportするconsumer fixtureをcompileする。既存 `engine:declaration-smoke` と対称な `flow:declaration-smoke` の追加を推奨する。
6. `npm test`
7. release候補で `npm run flow:pack-smoke`、`npm pack --dry-run --json`、`npm run version:check:release`

Node単体テストに実token・実アプリID・実業務値を入れない。公開API経由のmock testを自動受入とし、実kintone smokeは別途、専用検証アプリとダミーデータで行う。静的testだけで実機確認済みとはしない。

## 8. kSQL-Flowが消費する形

kSQL-Flow側は自身のCLI引数・allowlist検証・hash照合を終えた後、次の形へ変換する。

```ts
import {
  createImportSourceResolver,
  FlowImportProviderError,
  parseScript,
  validateScript,
  createExecutionContext,
} from "@rex0220/kintone-sql-tools/flow";

const importSource = createImportSourceResolver(inputs.map((input) => ({
  name: input.name,
  loader: {
    async load() {
      // path解決、lstat/open/read、sha256照合はkSQL-Flow側。
      // engineへ返すのはbytesと任意の既定encodingだけ。
      try {
        const bytes = await readVerifiedBytes(input);
        return { bytes, encoding: input.defaultEncoding };
      } catch (cause) {
        throw classifyProviderFailure(cause); // 公開provider error codeへ分類
      }
    },
  },
})));

const importCapability = { enableImport: true } as const;
const parsed = parseScript(sql, importCapability);
const diagnostics = await validateScript(sql, { ...importCapability, client });
const context = createExecutionContext({
  ...importCapability,
  client,
  statements: parsed.statements,
  meta: parsed.meta,
  importSource,
});
```

実装時のkSQL-Flow側は `classifyProviderFailure` を具体化し、通常ファイル以外を `ImportSourceNotRegularFileError`、open/read不能を `ImportSourceReadError` にする。公開 `/flow` result のerror messageへpathを含めず、監査用の安全な source name と内部ログのredacted識別子を分ける。pathを明示入力する本リポジトリのCLI fs loaderだけは、診断のためmessageにpathと原因を保持する。`--import-csv` / `--import-json` の重複はengine helperでも二重に閉じる。

内部CLI bundleの直接import、`as unknown as ExecuteOptions` 等による非公開option注入、`dist-cli/ksql.js` の関数呼出し、engineにpathを渡す独自拡張は禁止する。

## 9. リリース方針と順序

### 9.1 version

公開 `/flow` の型・value export・受理可能構文をopt-inで追加するため **minor version** とする。現行3.74.0を基準にすれば次のminor候補は3.75.0だが、実装時点で先行releaseがあればその次のminorへ載せ、計画書でversionを固定しない。

CHANGELOGには最低限、次を明記する。

- `/flow` にnamed IMPORT source APIを追加したこと
- IMPORTは既定OFFで、`enableImport:true` の明示が必要なこと
- sourceはpathではなくlazy loaderが返す`Uint8Array`であること
- SQL `ENCODING` > loader metadata > UTF-8
- 10 MiB上限とstable source error code
- 既存consumerに移行作業がないこと
- kSQL-Flowが要求すべき最低engine version

### 9.2 release順序

順序は必ず次とする。

```text
engine minor publish
  -> kSQL-Flow が dependency 最低版を更新し、公開型だけで named source を配線
  -> kSQL-Flow が features.importCsv=true を返す版を publish
  -> FlowNet がその kSQL-Flow Contract v1.1 最低版を要求し、inputs を開放
```

engineだけが新しい間は既存kSQL-Flow/FlowNetに影響しない。kSQL-Flowはparse、validate、execution、期待sha256照合、result `input_files` が全て揃う版でのみ `features.importCsv:true` を返す。FlowNetが先行または古いkSQL-Flowと混在した場合は、上流計画どおりNetwork lock取得前のcapability検証で拒否する。

publish前に npm tarball の `dist-flow/index.mjs`、`index.cjs`、`flow-library/*.d.ts` に新APIが存在し、`src/cli` / Node fs がbundleに混入していないことを確認する。公開後にkSQL-Flowの実dependencyを更新してcontract testを通すまで、FlowNet段階1のblocking prerequisiteは完了扱いにしない。

## 10. 見積り

上流の仮置き2〜4人日は概ね妥当だが、stable errorと配布 declarationを含めると下限2人日は楽観的である。1人日を実装、review修正、自動testまでとし、npm/GitHubの承認待ちと実機環境待ちは含めない。

| 作業 | 見積り |
| --- | ---: |
| 公開型・parser/validate/explain/context配線 | 0.6〜0.9人日 |
| source registry、stable error、payload/size検査 | 0.6〜1.0人日 |
| `/flow` 公開面・source loader test | 0.7〜1.0人日 |
| README、言語リファレンス、CHANGELOG、回答文書 | 0.3〜0.5人日 |
| build/declaration/bundle/pack/full suite、review修正 | 0.5〜0.8人日 |
| **合計** | **2.7〜4.2人日** |

上流仮置き2〜4人日の上端を0.2人日超える可能性があるのは、loader failureを安全に正規化し、declaration/tarballまで公開契約として検査するためである。CLIの通常ファイル判定・error移行はこの見積りに含めない。kSQL-Flow側の引数、sha256、Execution Result配線、FlowNet側のIO/securityも含めない。

## 11. 完了条件

次を全て満たした時点でengine前提を完了とする。

1. npm tarballの `@rex0220/kintone-sql-tools/flow` から新しいsource型、provider error、resolver helperをimportできる。
2. `parseScript` / `validateScript` / `explainScript` / `createExecutionContext` が同じ `enableImport` gateでIMPORTを扱う。
3. 公開APIだけを使うUTF-8/SJIS実行、SQL encoding優先、lazy loadの自動testがgreen。
4. source未供給、重複、read不能、通常ファイル以外、10 MiB超、invalid payloadが表のstable codeでfail-closedになり、mutation APIは0。
5. capability無効時の `KSQL1202` とIMPORTを使わない既存 `/flow` の結果が不変。
6. IMPORT由来の`ON ERROR SKIP` UPSERTが既存の事前GET→POST/PUT経路を維持し、native UPSERTへ流れない。
7. `/flow` bundleにCLI、Node fs、plugin UI、MCPが混入しない。
8. README、言語リファレンス、CHANGELOG、version同期、release historyが公開版と一致する。
9. engine minor公開後、kSQL-Flowが非公開import/型castなしで依存更新し、contract testを通してから`features.importCsv:true`を返す。
