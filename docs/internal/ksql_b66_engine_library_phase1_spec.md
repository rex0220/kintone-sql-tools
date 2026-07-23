# B66 Phase1 — read-only kSQL エンジン・ライブラリ公開仕様

- 作成日: 2026-07-23
- ステータス: **仕様 R2・Claude レビュー済＝実装着手可能水準**（2026-07-23）。R1 レビュー指摘5件（§12）を R2 本文へ反映（§3.2 bypass 正規化／§4.4 import グラフ監査／§4.5 バージョン共存〔UMD registry・per-instance・Cursor lease 非協調＝実コード監査済み〕／§2.1 string 明示／§3.3 UX 注記）＝再レビューで全数妥当・新規の綻びなし。公開意味論の2核心（read-only 二重強制／型隔離）は不変。**オーナー判断も決着（2026-07-23）＝§3.3 検索打ち切りは常時 fail-closed で確定・部分結果＋warning は将来 Phase2 の明示 opt-in**。未決の仕様/オーナー論点はなく、**実装着手可否の判断のみ**（見積り 4〜7 人日）。
- 対象リリース: 未定
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B66
- 起草ブリーフ: [ksql_b66_phase1_spec_r1_brief.md](ksql_b66_phase1_spec_r1_brief.md)
- 評価: [ksql_b66_engine_library_evaluation.md](ksql_b66_engine_library_evaluation.md)
- 実装土台: `src/execute.ts` の `execute(sql, client, options)` / `KintoneClient`、`src/ui/kintoneClient.ts`、`src/cli/nodeKintoneClient.ts`

## 1. スコープ（Phase1）

既存 kSQL エンジンを、ダッシュボード系 kintone プラグイン／カスタマイズが取り込める **read-only ライブラリ**として公開する。エンジン本体を別実装にせず、既存 `execute()` の前後に安全境界と安定した公開型を持つ薄い public wrapper を置く。

### 1.1 対象

- 単文の `SELECT`、`WITH`、`UNION [ALL]`、`SHOW APPS`、`DESCRIBE`。
- read-only の `SELECT` / `WITH` / `UNION [ALL]` を対象とする `EXPLAIN`。公開面では通常実行と分けて `explainQuery()` から呼ぶ。
- JOIN、集約、CTE、window、KLIKE、KORDER／Cursor を含む、既存エンジンが受理する read-only SQL。
- 目的別 wrapper `runQuery()`、ブラウザ用 `createReadonlyKintoneClient()`、利用者実装の `ReadonlyKintoneClient` を渡す BYO client。
- npm subpath の ESM / CJS、ブラウザ向け UMD、最小の `.d.ts`。
- read-only の二重強制、公開エラー正規化、最小 metrics、既存 plugin / CLI / MCP の非回帰。

### 1.2 対象外

- `INSERT`、`UPDATE`、`UPSERT`、`DELETE`、`REORDER`、`APPLY`、`IMPORT`。`VALIDATE ONLY` であっても DML 構文は Phase1 public API では受理しない。
- `VALIDATE`、一時テーブル、batch、変数、`ASSERT`。これらは kintone mutation を行わない形を含むが、Phase1 のダッシュボード向け最小契約には含めない。
- MCP の保存クエリ作成・更新・削除・実行。Phase1 ライブラリは保存クエリ API 自体を公開しない。
- `execute()`、`executeBatch()`、parser、AST、内部 `KintoneClient`、内部 `ExecuteOptions` / `ExecuteResult` の直接公開。
- `runMutation()` と、書込み可能な browser / Node client の公開。Phase2 へ送る。
- `src/execute.ts` の `execute()` / `KintoneClient`、parser、SQL 意味論の変更。
- プラグイン間の実行時共有サービス。各利用元が自分の bundle にライブラリを取り込む。

## 2. 公開 API 面（型と関数）

公開 entry は `@rex0220/kintone-sql-tools/engine` とし、次の名前だけを semver 対象にする。以下は契約を示す疑似 TypeScript であり、内部型の alias や全 re-export を意味しない。

```ts
export interface ReadonlyKintoneClient {
  getRecords(params: ReadonlyGetRecordsParams): Promise<ReadonlyGetRecordsResult>;
  openCursor(params: ReadonlyCursorOpenParams): Promise<ReadonlyCursorHandle>;
  getApps(): Promise<readonly ReadonlyAppInfo[]>;
  getFields(appId: number): Promise<readonly ReadonlyFieldInfo[]>;
  getNumberPrecision(appId: number): Promise<ReadonlyNumberPrecision>;
  getProcessStatuses(appId: number): Promise<ReadonlyProcessStatuses>;
}

export interface RunQueryOptions {
  client: ReadonlyKintoneClient;
  maxRecords?: number;
  onLimitReached?: "error" | "truncate";
  fetchParallel?: number;
  cursorMaxActive?: number;
}

export interface QueryColumn {
  name: string;
  valueType: "string";
}

export interface QueryMetrics {
  recordGetCalls: number;
  fetchedRows: number;
  elapsedMs: number;
  cursorRecordsScanned: number;
}

export interface QueryResult {
  type: "query";
  rows: readonly Readonly<Record<string, string>>[];
  columns: readonly QueryColumn[];
  rowCount: number;
  warnings: readonly string[];
  metrics: QueryMetrics;
}

export interface ExplainResult {
  type: "explain";
  lines: readonly string[];
  text: string;
  metrics: QueryMetrics;
}

export interface CreateReadonlyKintoneClientOptions {
  cursorMaxActive?: number;
}

export const version: string;

export function createReadonlyKintoneClient(
  options?: CreateReadonlyKintoneClientOptions
): ReadonlyKintoneClient;

export function runQuery(
  sql: string,
  options: RunQueryOptions
): Promise<QueryResult>;

export function explainQuery(
  sql: string,
  options: Omit<RunQueryOptions, "onLimitReached">
): Promise<ExplainResult>;

export class KsqlEngineError extends Error {
  readonly code:
    | "PARSE_ERROR"
    | "READ_ONLY_VIOLATION"
    | "SEARCH_ABORTED"
    | "FETCH_LIMIT_EXCEEDED"
    | "CLIENT_ERROR"
    | "EXECUTION_ERROR";
  readonly cause?: unknown;
}
```

`ReadonlyGetRecordsParams`、Cursor handle、app / field / precision / process status の各型も、上記関数シグネチャを成立させるための**専用 public DTO**として定義する。内部 `PageFetchParams`、`KintoneCursorHandle`、`KintoneFieldInfo`、`NumberPrecision` 等を alias export しない。public DTO は Phase1 の read path が実際に読み書きするプロパティだけを持つ。

### 2.1 結果型

> **Phase1 の公開値はすべて文字列である。** 数値・日付・真偽値を含め、`rows` のセルは `string`、`QueryColumn.valueType` は `"string"` で返す。値の型付け・自動変換は Phase1 対象外であり、必要な consumer は列の用途に応じて明示的に parse する。

- `runQuery()` は内部 `SelectResult` を返さず、必ず `QueryResult` へコピーして返す。内部 `type: "SELECT"`、`validateStats`、内部 metrics 名は漏らさない。
- 行セルは現行 `ProcessRow = Record<string, string>` に合わせ、Phase1 の公開値型を `string` に固定する。`QueryColumn.valueType` も `"string"` のみとする。
- 内部の `ResolvedFieldSemantics`、`MaterializedColumnMeta`、`sortKind`、source field type は Phase1 の安定契約に含めない。現行 `execute()` は一般の SELECT 結果へこれらを公開しておらず、エンジン改変なしに完全な式列メタを保証できないためである。
- `columns` は SQL の出力順、`rows` の key は列名を表す。0行でも `columns` を保持する。
- metrics はダッシュボードで必要な取得量・時間・Cursor走査量の4項目だけに写像する。内部 metrics の mutation counter、cache、Cursor lease 診断等は公開しない。
- `explainQuery()` は内部の1列 `plan` の SELECT 表現を公開せず、行単位 `lines` と改行結合済み `text` を返す。

### 2.2 `runQuery()` と `explainQuery()`

- `runQuery()` は `SELECT` / `WITH` / `UNION` / `SHOW_APPS` / `DESCRIBE` だけを受理する。`EXPLAIN` は `explainQuery()` へ誘導し、結果 union を増やさない。
- `explainQuery()` は、先頭 `EXPLAIN` の有無をどちらも受け付け、内部ではちょうど1個の `EXPLAIN` に正規化する。対象 AST は `SELECT` / `WITH` / `UNION` だけを許す。DML や IMPORT の EXPLAIN は拒否する。
- 両関数とも単文専用である。空文、複文、末尾以外の余剰 token は parse error とする。

## 3. read-only 強制の意味論

Phase1 は次の**二重強制を両方必須**とし、片方だけに安全性を依存しない。

### 3.1 第1境界 — parse 後・実行前の statement allowlist

1. wrapper が既存 parser で入力全体を parse する。IMPORT も非 read 文として識別して拒否できるよう、分類時だけ IMPORT capability を有効にして AST を得てよい。
2. `runQuery()` は top-level type の allowlist を `SELECT` / `WITH` / `UNION` / `SHOW_APPS` / `DESCRIBE` に固定する。
3. `explainQuery()` は top-level `EXPLAIN` に加え、内側 statement も `SELECT` / `WITH` / `UNION` であることを検査する。
4. allowlist 外、未知の type、将来追加された type はすべて `READ_ONLY_VIOLATION` で fail-closed とし、`execute()` を呼ばない。
5. `WITH` / `UNION` は内包 query も再帰的に検査する。分類不能な枝へ通常 SELECT としてフォールバックしない。

これにより DML、APPLY、IMPORT、`VALIDATE ONLY`、batch 内メモリ文を、書込み API の有無にかかわらず実行前に拒否する。保存クエリ書込みはそもそも公開関数を持たない。

### 3.2 第2境界 — 書込みメソッドを持たない client

public `ReadonlyKintoneClient` と `createReadonlyKintoneClient()` の返却オブジェクトは、内部 `KintoneClient` に存在する次の3メソッドを持たない。

- `postRecords`
- `putRecords`
- `deleteRecords`

wrapper は `ReadonlyKintoneClient` を内部 `execute()` へ渡す際、書込みメソッドを no-op として補完しない。型上の変換だけで既存 read path を呼び、**ラップ前の元 client** には3メソッドが存在しない状態を保つ。現行 `wrapClientWithMetrics` は全 `KintoneClient` メソッドに対応する委譲 closure を組み立て、write メソッドも内部で元 client の `postRecords` / `putRecords` / `deleteRecords` を遅延呼び出しする。このため、ラップ後 client は write closure を持ち、「書込みメソッド不在」を保証する対象はラップ前の元 client に限る。

第1境界を bypass して write closure が呼ばれた場合、元 client のメソッド不在による生の `TypeError` を外へ漏らしたり、一般の `EXECUTION_ERROR` に落としたりしてはならない。public wrapper 境界でこの失敗を捕捉して `KsqlEngineError("READ_ONLY_VIOLATION")` へ正規化する。実装上、同じ code を投げる明示的な write stub を metrics wrapper の委譲先に置く方式を選んでもよいが、どちらの方式でも record mutation API 呼出しは0であり、公開される失敗は clean な `READ_ONLY_VIOLATION` でなければならない。

`openCursor()` は Records Cursor の作成・取得・解放を1つの read resource lifecycle として抽象化するため公開面に残す。内部では kintone REST の `POST /records/cursor.json` と `DELETE /records/cursor.json` を使うが、レコード作成・更新・削除ではない。Cursor handle は作成時 route に束縛され、close を必須にする既存契約を維持する。

BYO client に余分なプロパティが存在しても構造型だけでは禁止できないため、wrapper は受領時に allowlist 6メソッドだけを新しい readonly object へ射影し、余分な `postRecords` / `putRecords` / `deleteRecords` を `execute()` の入力 client へ渡さない。これを runtime test で固定する。

### 3.3 検索打ち切り

`getRecords()` が `searchAborted: true` を返した時点で、wrapper の client guard が `SEARCH_ABORTED` を投げ、部分結果を返さない。内部 `execute()` が単純 SELECT では warning を返し得る現状より Phase1 public API を厳しくし、JOIN／集約の有無によらず10万件検索打ち切りを fail-closed に統一する。BYO client にも同じ guard を必ず被せる。

> **オーナー判断済（2026-07-23）＝fail-closed を採用（確定）。** 10万件超の単純 SELECT は既存 plugin 面の「部分結果＋warning」ではなく hard error（`SEARCH_ABORTED`）にする。ダッシュボード/分析用途では、総計・平均が静かに過少になるより明示エラーが安全という理由で、この UX 差を許容する。**部分結果＋warning が必要な場合は将来 Phase2 で明示 opt-in（例 `allowPartialOnAbort`）として追加する**（既定は常に fail-closed のまま）。Phase1 の公開エラー契約・非回帰条件は本 R2 のとおり確定とし、これ以上の未決オーナー判断はない。

## 4. 配布・ビルド

### 4.1 npm

`package.json` は現状 `bin` と `files` に `dist-cli/`、`dist-mcp/`、`dist-mcpb/` を持つ一方、`main` / `module` / `types` / `exports` を持たない。Phase1 は root import を新設せず、次の subpath だけを加える。

```json
{
  "exports": {
    "./engine": {
      "types": "./dist-engine/index.d.ts",
      "import": "./dist-engine/index.mjs",
      "require": "./dist-engine/index.cjs"
    }
  },
  "files": [
    "dist-engine/",
    "dist-cli/",
    "dist-mcp/",
    "dist-mcpb/",
    "README.md",
    "LICENSE",
    "package.json"
  ]
}
```

- ESM / CJS は同じ public entry と同じ意味論を持つ。
- browser / neutral の target は ES2020、CJS の動作確認対象は既存 CLI / MCP と揃えて Node 18 以上とする。
- 既存 `bin`、既存3配布 directory、root package 解決は変更しない。
- `prepack` は既存 CLI / MCP / MCPB に engine build と declaration build を加え、未生成／古い `dist-engine` を publish しない。

### 4.2 UMD

- `dist-engine/ksql-engine.umd.js` を自己完結 bundle として同梱し、`window.ksql` は単一 engine object ではなく §4.5 の version 名前空間レジストリに固定する。
- UMD が公開する名前と型の意味論は npm `./engine` と同じとし、`execute()` や内部型だけを追加露出しない。
- UMD は kintone customization の script 配置用途であり、別プラグインの JavaScript から他プラグインの bundle を参照する仕組みではない。
- npm / UMD とも利用側ごとに engine のコピーを持つ。UMD registry は版の発見と選択だけを担い、engine の状態や Cursor lease をプラグイン間で共有する runtime service にはしない。

### 4.3 `.d.ts`

- declaration は専用 public entry から `emitDeclarationOnly` で生成し、実装 bundle から推測生成しない。
- declaration smoke で consumer fixture を `moduleResolution: NodeNext` と `Node16` の双方で型検査する。
- `dist-engine/index.d.ts` から `src/execute.ts`、`src/types/ast.ts`、`src/parser/**`、`src/mcp/**` への import が残らないことを検査する。
- npm pack 後の tarball から ESM / CJS / `.d.ts` を実際に import / require / typecheck する。

### 4.4 build 内容

R2 実装着手の最初に engine entry の import グラフ監査を行い、`execute()` の推移依存が MCP instructions、docs、statement catalog、zod、MCP SDK を引かないことを確定する。いずれかを引く場合は、forbidden module 検査だけで済ませず engine 用 entry／依存の分割が必要である。監査と必要な entry 分割が完了するまで bundle 実装へ進まない。

- engine entry から到達する parser、planner、converter、read-only executor、browser readonly adapter だけを bundle する。
- MCP instructions、言語リファレンス／recipe 埋め込み、statement catalog、MCP SDK、zod、CLI argument / profile / credential 処理、plugin UI / config / manifest / CSS を含めない。
- browser / UMD bundle に `fs`、`path`、`child_process`、`Buffer` 等の Node 専用参照または Node builtin import を含めない。
- tree-shaking 後の metafile を保存して forbidden module 検査を行い、minified / gzip サイズを release artifact に記録する。R2 では既存 engine の実測前に恣意的な容量上限を置かず、初回値を以後の回帰基準にする。

### 4.5 バージョン共存・競合回避

複数プラグイン／customization が同一ページで異なる kSQL engine 版を読み込んでも、後勝ち上書きや共有 global 副作用を起こさないことを Phase1 必須要件とする。

1. **UMD version 名前空間レジストリ:** `window.ksql` は `{ versions, get }` の安定した registry とし、各 UMD は `window.ksql.versions[version]` に自版の public API object を登録する。`get(version: string)` は完全一致した版だけを返し、未登録版は `undefined` を返す。既に別バージョンが存在しても registry や既存 entry を上書きしない。同じ version key の重複ロードも先着 entry を維持し、`console.warn` して後着実装を登録しない。既存 `window.ksql` が registry 契約を満たさない場合も上書きせず初期化を fail-closed にする。利用版を build 時に固定できる plugin は npm bundle 取込を優先し、UMD consumer は必ず `get("x.y.z")` で版を明示する。
2. **共有 global 副作用の禁止:** engine public entry は状態を client／engine instance ごとに閉じ、`window` / `globalThis` を鍵にした singleton、`kintone.api` の monkey-patch、同一 DOM event への lifecycle listener の重複登録を行わない。R2 監査時点の実コードでは、`src/ui/cursorPageLifecycle.ts` の `activeHandles` / `installed` と `src/api/cursorLeaseManager.ts` の `managers` は各 module コピー内の singleton である。`createKintoneClient()` は `installCursorPageLifecycle(window)` を呼び、`registerCursorHandle()` は module-level set に登録するため、異なる bundle コピーでは `pagehide` / `beforeunload` listener が各1組ずつ登録され得る。また `getCursorLeaseManager()` の host map もコピー間では共有されない。したがって engine readonly adapter はこれら singleton helper をそのまま public entry へ持ち込まず、Cursor handle と lease manager を factory が生成した per-instance state に閉じる。engine public entry は global lifecycle listener を自動登録せず、query の成功・失敗時に自 instance が開いた handle を `finally` で close する。既存 plugin 内部の `createKintoneClient()` の挙動は非回帰のため変更しない。
3. **ホスト Cursor 上限と独立コピー:** kintone のホスト単位 Cursor 上限は最大5である一方、独立コピーの per-instance lease は合算されないため、複数コピーの同時実行では各 instance が上限内でもホスト実上限を超え得る。Phase1 は共有 coordinator を設けず、各 instance の `cursorMaxActive` を既定2に保つ。instance 内の上限到達は新規 Cursor 作成前に fail-closed、ホスト合算超過を kintone が拒否した場合も retry、非 Cursor 経路への fallback、部分結果返却を行わず `CLIENT_ERROR` とする。運用資料には「独立コピー数と各 `cursorMaxActive` の合計を5以下に設定する。3コピー以上の共存では通常1を指定する」こと、および第三者 plugin を含む場合は合算保証ができないことを明記する。version 間共有 coordinator は Phase1 対象外とする。
4. **version の公開:** npm / CJS / ESM / UMD の public API object は build 時に固定した `version` を公開する。この値は package version と一致し、UMD registry key、host 側の版選択、診断に用いる。同じ artifact 内で runtime に変更できない。

## 5. クライアント供給

### 5.1 browser factory

既存 `src/ui/kintoneClient.ts` の実態は、レコード GET に raw `fetch` を使って `X-Cybozu-Warning` の検索打ち切りを検出し、Cursor と app / fields / settings / status の取得には `kintone.api` を使う。`createReadonlyKintoneClient()` はこの read path と error 詳細化を再利用し、record mutation 3メソッドだけを組み込まない。

`createKintoneClient()` は現行どおり plugin 内部用の書込み可能 client として残すが、Phase1 の `./engine` からは export しない。read-only package から両 factory を公開すると第2境界を弱めるためである。既存 plugin の import path と動作は変えない。

### 5.2 BYO client

BYO `ReadonlyKintoneClient` を正式サポートする。ゲストスペース、proxy、特殊 route、test double は利用者が6メソッドを実装できる。契約は次のとおり。

- `getRecords()` は検索打ち切りを検出した場合に `searchAborted: true` を失わず返す。
- Cursor handle は page 取得と idempotent close を提供し、作成時の host / guest route へ束縛する。
- app / field / precision / process status の応答は public DTO を満たす。
- 認証、retry、rate limit、tenant routing は BYO 実装の責務だが、wrapper の read-only射影、検索打ち切り guard、statement allowlist は BYO にも必ず適用する。

### 5.3 Node

`src/cli/nodeKintoneClient.ts` は full `KintoneClient` を返し、token / user-password、guest route、Cursor、record mutation を含む。Phase1 はこれを browser bundle に入れず、`createNodeKintoneClient()` も export しない。Node consumer は `./engine` を CJS / ESM で読み、BYO readonly client を渡す。既存 CLI / MCP は従来の Node adapter をそのまま使う。

## 6. options、エラー、semver

### 6.1 options の公開サブセット

| public option | 決着 |
|---|---|
| `client` | 必須。`ReadonlyKintoneClient` のみ |
| `maxRecords` | 公開。正の safe integer。省略時は現行 engine default 10,000 |
| `onLimitReached` | `runQuery()` のみ公開。`"error"` / `"truncate"`。完全入力を要する既存 plan では engine の fail-closed が優先 |
| `fetchParallel` | 公開。正の safe integer。既存 fetchAll の意味論を維持 |
| `cursorMaxActive` | 公開。1〜5、既定2。KORDER Cursor と EXPLAIN 表示へ同じ実効値を渡す |
| `cacheContext` | 非公開。client identity に基づく既存既定へ任せ、利用者に内部 cache key 契約を凍結しない |
| `confirm` / DML guards / IMPORT / APPLY / snapshot loader | 非公開かつ指定不能 |

未知 option は TypeScript だけに依存せず runtime でも拒否する。数値範囲外を暗黙補正しない。

### 6.2 エラー契約

エラーは result envelope ではなく reject される `KsqlEngineError` に統一する。内部 error class は re-export せず、wrapper 境界で次へ正規化する。

| `code` | 条件 |
|---|---|
| `PARSE_ERROR` | lexer / parser が入力を構文として受理できない、空文、複文 |
| `READ_ONLY_VIOLATION` | parse できたが allowlist 外、EXPLAIN 内側が非 read、未知 statement type、または第1境界 bypass 後に write closure が呼ばれた |
| `SEARCH_ABORTED` | `searchAborted: true`。常に部分結果0 |
| `FETCH_LIMIT_EXCEEDED` | 内部 `FetchAllLimitError`。truncate が許されない plan を含む |
| `CLIENT_ERROR` | kintone / BYO transport error。元の status / kintone code を取得できる場合は optional detail として保持可 |
| `EXECUTION_ERROR` | 上記以外の planner / executor error |

`message` は診断用であり文言完全一致を semver 契約にしない。`name`、`code`、`instanceof KsqlEngineError`、`cause` の保持を契約にする。`ParseError`、`SearchAbortedError`、`FetchAllLimitError` 自体は public export しない。

### 6.3 型凍結と後方互換

semver 対象は §2 に列挙した `version`、関数、class、public interface / DTO、その必須プロパティと意味論、error code、および §4.5 の UMD registry 契約である。minor では optional property / 新関数の追加はできるが、既存 property の削除・rename・型の狭小化、既存 default の意味変更、error code の付け替えをしない。公開 union への値追加で exhaustive consumer を壊し得る変更も major 扱いとする。

次は明示的に semver 対象外であり re-export しない。

- `ExecuteOptions`、`ExecuteResult` と各 DML result、`ExecuteMetrics`
- 内部 `KintoneClient` と mutation parameter
- AST / parser token / planner / converter 型
- `ResolvedFieldSemantics`、materialized table / column meta
- cache、request gate、Cursor lease の内部型
- plugin / CLI / MCP 固有 payload

内部型を public DTO の `extends`、type alias、conditional type、import type の形でも漏らさない。

## 7. 面・非回帰

- library wrapper は純加法の新 entry とし、既存 plugin は従来の `createKintoneClient()` と `execute()`、CLI / MCP は従来の Node adapter と core entry を使う。
- `src/execute.ts` の `execute()` / `KintoneClient`、parser、AST、SQL plan / result は変更しない。
- `package.json` の既存 bin と既存配布物を維持する。`npm run build` / `prepack` への engine target 追加以外で build 順序や出力を変えない。
- 同じ SQL、client fixture、実効 options なら、library `QueryResult.rows` / 列順は既存 `execute()` の SELECT result と一致する。差分は公開 envelope、検索打ち切りの常時 fail-closed、型名の隔離だけである。
- engine bundle は plugin / CLI / MCP の docs、設定、認証、UI を副作用として初期化しない。
- 複数 engine 版の共存対策は新しい public entry 内に閉じる。既存 plugin 内部の `createKintoneClient()`、Cursor page lifecycle、CLI / MCP の client lifecycle を変更しない。

## 8. 受入条件（テスト化）

### 8.1 正例

- browser fixture で `createReadonlyKintoneClient()` を作り、`runQuery("SELECT ... JOIN ... GROUP BY ...", { client })` が正しい行、列順、rowCount、metrics を返す。
- `WITH`、`UNION ALL`、`SHOW APPS`、`DESCRIBE` が同じ `QueryResult` 契約で返る。
- KORDER Cursor query が `openCursor()` を使い、成功・error の双方で handle を close する。
- BYO readonly client で browser factory と同じ fixture result を返す。guest route を持つ BYO fixture でも route が失われない。
- `explainQuery()` が plan を返し、records GET / Cursor API は0回。必要な field metadata GET は許す。
- ESM import、CJS require、UMD `window.ksql.get(version)` の3面で同じ `version`、public 名、結果を返す。
- npm pack 後の consumer fixture で runtime import と `.d.ts` typecheck が成功する。

### 8.2 read-only 負例

- INSERT / UPDATE / UPSERT / DELETE / REORDER / APPLY / IMPORT / `VALIDATE ONLY` を各1例以上 parse し、`READ_ONLY_VIOLATION`、engine実行0、record mutation API 0とする。
- `EXPLAIN UPDATE ...`、`EXPLAIN IMPORT ...` を `READ_ONLY_VIOLATION` とする。
- `VALIDATE`、CREATE / DROP TEMP TABLE、SET / DECLARE、ASSERT、複文を拒否する。
- 将来 statement type を模した classifier fixture を allowlist 外として拒否し、default-allow の退行を防ぐ。
- `createReadonlyKintoneClient()` が生成した**ラップ前 client** の own property と prototype に `postRecords` / `putRecords` / `deleteRecords` が存在しない。
- 書込み3メソッドを余分に持つ BYO object を渡しても、`wrapClientWithMetrics` より前の射影済み client から3メソッドが除去される。metrics ラップ後の write closure の有無をこの検査対象と混同しない。
- 第1境界を test seam で故意に通過させた各 write 負例でも mutation API call 0とし、生の `TypeError` や `EXECUTION_ERROR` ではなく clean な `READ_ONLY_VIOLATION` を返して二重強制を独立に実証する。

### 8.3 境界・エラー

- malformed SQL は `PARSE_ERROR`、parse 可能な非 read 文は `READ_ONLY_VIOLATION` と区別する。
- browser / BYO の `searchAborted: true` は simple SELECT、JOIN、GROUP BY の全てで `SEARCH_ABORTED`、結果行0。
- `maxRecords` 超過は `FETCH_LIMIT_EXCEEDED`。`onLimitReached: "truncate"` が既存意味論で許される単純 query だけは warning 付き結果を返し、完全入力必須 plan は error のまま。
- kintone API error と未知 executor error がそれぞれ `CLIENT_ERROR` / `EXECUTION_ERROR` となり、`cause` を保持する。
- options の未知 key、非整数、範囲外を実行前に拒否する。

### 8.4 型・bundle・非回帰

- public `.d.ts` の export snapshot が §2 の `version` を含む面だけであり、内部 `execute.ts` 型と DML 型を含まない。
- browser / UMD bundle の forbidden Node builtin、MCP SDK、zod、embedded docs / catalog の不在を metafile と文字列 guard で検査する。
- `npm run test`、plugin / CLI / MCP / MCPB build、MCP smoke / pack smoke が従来どおり通る。
- plugin の代表 browser smoke、CLI と MCP の代表 read query / EXPLAIN / DML guard を非回帰確認する。
- package tarball に既存 bin、既存3 dist、engine ESM / CJS / UMD / `.d.ts` が揃い、bin path と実行結果が変わらない。

### 8.5 バージョン共存・global 副作用

- 同一 browser fixture へ UMD 2バージョンを順不同でロードし、`window.ksql.versions` の両 entry が保持され、相互上書きされない。`get(v1)` / `get(v2)` はそれぞれ自版の `version` と実装を返す。
- 同一 version の UMD を再ロードしても先着実装を上書きせず、重複 warning を1回出す。非 registry の既存 `window.ksql` も上書きせず fail-closed にする。
- 2バージョンで readonly client / Cursor query を動かし、`window.addEventListener` の `pagehide` / `beforeunload` 登録数が engine ロード前から増えず、`kintone.api` の identity が変わらず、global 副作用の二重登録がない。
- 各版の Cursor handle registry と lease snapshot が per-instance で分離され、一方の close / capacity 変更が他方へ伝播しない。instance 内 `cursorMaxActive` 超過は Cursor 作成前に fail-closed とし、ホスト合算超過を模した API reject は retry・fallback・部分結果なしの `CLIENT_ERROR` とする。

## 9. Phase2 引き継ぎ（DML）

- `runMutation()` と、書込み可能 client factory / BYO mutation client。
- `confirm` の必須化、`dmlMaxRows` / `dmlMaxSubtableRows` の安全既定、APPLY capability、IMPORT source、`ON ERROR SKIP` / reject limit。
- DML 専用結果・partial failure・validation result の安定 public DTO。
- 検索打ち切り時の mutation 0、全候補確定前 write 0、確認表示後だけ書込み可能という独立した受入条件。
- Node credential adapter の public subpath は、認証型と guest / proxy 契約を凍結する必要が生じた時点で Phase2 と別に判断する。
- 保存クエリ連携と B49 相当の raw metadata reader は Phase3 候補とし、Phase1 engine entry へ混在させない。
- 検索打ち切り時に「部分結果＋warning」を返す明示 opt-in（例 `allowPartialOnAbort`）。Phase1 は常時 fail-closed（§3.3 でオーナー確定）であり、既定を変えずに opt-in を追加する形とする。

## 10. 論点・要判断

R2 では read-only 二重強制、型隔離、build 境界、バージョン共存の仕様を決着した。公開意味論上の残論点は、§3.3 の検索打ち切り常時 fail-closed が既存 plugin 面と異なる UX をオーナーが許容するか、の1点である。値を `string` に固定する点は §2.1 に明示済みであり、未決ではない。実装時に確定する初回 bundle の minified / gzip 実測値と、それを基準にした以後の回帰閾値も、公開 API や安全境界を未決に戻すものではない。

### 10.1 ブリーフ8論点＋R2追加論点の決着表

| # | 判断論点 | R2 の決着 |
|---:|---|---|
| 1 | read-only 二重強制 | **必須**。parse 後の再帰的 allowlist と、mutation 3メソッドを持たない／BYOから射影するラップ前 `ReadonlyKintoneClient` の両方。bypass 時も `READ_ONLY_VIOLATION` へ正規化する（§3） |
| 2 | 公開 API 粒度 | `execute()` を出さず `runQuery()`。EXPLAIN は `explainQuery()` に分離。内部 union でなく固定 `QueryResult` / `ExplainResult`（§2） |
| 3 | client 供給 | browser `createReadonlyKintoneClient()` と BYO readonly を正式対応。full `createKintoneClient()` と Node adapter は非公開（§5） |
| 4 | 配布物 | npm `./engine` の ESM + CJS、UMD `window.ksql` version registry、`.d.ts` の三系統。既存 bin と root は不変（§4） |
| 5 | 型凍結 | **最小 public DTO のみ**。内部 `execute.ts` 型、AST、意味型、DML型を一切 re-export しない（§2、§6.3） |
| 6 | library target | read path だけを bundle。着手時に import graph を監査し、MCP instructions / docs / catalog / zod / SDK を引く場合は entry を分割する（§4.4） |
| 7 | options subset | `client`、`maxRecords`、`onLimitReached`、`fetchParallel`、`cursorMaxActive` のみ。cache / DML / IMPORT / APPLY option は非公開（§6.1） |
| 8 | error 契約 | reject される `KsqlEngineError` と固定 code。内部 error class は非公開。検索打ち切りは全queryで常時 fail-closed を採用するが、既存 plugin との UX 差はオーナー要判断（§3.3、§6.2） |
| 9 | バージョン共存 | **Phase1 必須**。UMD version registry、public `version`、per-instance 状態、global 副作用禁止。Cursor lease は非協調を明記し保守既定＋fail-closed で扱う（§4.5、§8.5） |

## 11. 工数見積り

Phase1 は **4〜7人日**。既存 engine の変更ではなく、安全 wrapper、配布 target、型隔離、pack / browser smoke が中心である。

| 作業 | 目安 |
|---|---:|
| public DTO、`version`、`runQuery` / `explainQuery`、error 正規化 | 1〜1.5人日 |
| parse allowlist、readonly client 射影、検索打ち切り guard | 1〜1.5人日 |
| browser readonly factory、per-instance Cursor state、BYO contract test | 0.5〜1人日 |
| ESM / CJS / UMD registry build、exports、declaration、pack | 1〜1.5人日 |
| bundle / global side-effect guard、unit / integration / browser smoke、非回帰 | 0.5〜1.5人日 |

実装着手前レビューでは、(a) `WITH` 内包 query の再帰 classifier が全 AST variant を fail-closed に扱うこと、(b) BYO 射影後 object を既存 `execute()` へ渡しても read path が mutation method の存在を前提にしないこと、(c) `openCursor()` の close と検索打ち切りの例外化が競合しないこと、(d) declaration rollup が内部 import を残さないこと、(e) engine entry の import graph、(f) readonly adapter が既存 module singleton を経由しないことをコード単位で再確認する。§3.3 のオーナー判断を除き、いずれも本R2の公開意味論を未決に戻すものではない。

## 12. Claude レビュー（R1→R2 申し送り）

2026-07-23・Claude レビュー。核心2論点（read-only 二重強制／内部型を一切 re-export しない型隔離）は妥当で採用。以下は原指摘を削除せず、R1→R2 の反映状況を併記する。

1. **【安全性・最重要／R1→R2 で反映済み】第2境界の「失敗のきれいさ」を確定する。** `wrapClientWithMetrics`（`src/execute.ts:735`）は write メソッドを closure で保持し、内部で `client.postRecords/putRecords/deleteRecords` を**遅延呼び出し**する（コードで確認）。したがって §3.2 の狙いどおり「第1境界を bypass しても実 REST write は 0」は成立する一方、失敗は**メトリクス wrapper 内から投げられる生の `TypeError`（`client.postRecords is not a function`）**であり、`READ_ONLY_VIOLATION` にならない（放置すると `EXECUTION_ERROR` へ落ちるか、wrapper の try/catch 外なら未正規化で表面化）。R2 で: ①bypass 時の失敗を wrapper 境界で捕捉し **`READ_ONLY_VIOLATION` へ正規化**（または明示的に throw する stub を READ_ONLY_VIOLATION で入れる）。②**`wrapClientWithMetrics` の出力は write closure を持つ**ため「書込みメソッド不在」は*ラップ前の元 client* でのみ保証される点を §3.2 に明記し、§8.2 の「射影済み client から3メソッド除去」テストはラップ前を対象に、加えて「bypass で clean な READ_ONLY_VIOLATION（TypeError/EXECUTION_ERROR でない）」を別テストで固定する。**反映先:** §3.2、§6.2、§8.2。
2. **【要判断／R1→R2 で注記済み・オーナー判断待ち】§3.3 の検索打ち切り常時 fail-closed は UX 変更**。Phase1 は単純 SELECT でも `SEARCH_ABORTED` を hard error にし、内部 `execute()`（部分結果＋warning）より厳しくする。10万件超アプリのダッシュボードは「部分表示」でなく「エラー」になる。誤集計を出さない設計として妥当だが、プラグイン面との**意図的な UX 差**なのでオーナー確認事項として明記する（採用なら現状文言でよい）。**反映先:** §3.3、§10、§10.1。
3. **【ビルド・実現性／R1→R2 で反映済み】engine entry の import グラフ監査を最上位の R2 検証に。** §4.4 の「MCP instructions／docs／catalog／zod／SDK を除外して軽量化」は、`execute()` とその推移依存が実際にそれらを引かないことに依存する。§8.4 の forbidden-module metafile 検査は方向として正しいが、**監査で execute() が catalog/docs を推移 import していると判明した場合は entry 分割が必要**になる。R2 着手の最初に import グラフ監査を置き、軽量 bundle が改変なしで達成可能かを確定する。**反映先:** §4.4、§10.1、§11。
4. **【小・既知／R1→R2 で明示済み】§2.1 の値は全て string**（`ProcessRow` 準拠）。数値/日付が要るダッシュボードは client 側で parse が必要。正直で妥当だが、公開 API docs で「値は文字列・型付けは Phase1 対象外」を目立つ形で明示し、消費側の誤解を防ぐ。**反映先:** §2.1、§10。

5. **【設計・重要／オーナー指摘／R1→R2 で反映済み】複数プラグインが別バージョンの kSQL を同居させても競合しない仕組み（Phase1 必須要件）。** 各プラグインは自分の bundle にコピーを持つ（§4.2）。npm ビルド時取込は module scope が分離されるため原則衝突しないが、次の3経路で衝突し得るため、R2 に専用セクション（例 §4.5「バージョン共存・競合回避」）を新設して決着させる。
   - **① UMD `window.ksql` の上書き**: 別バージョンが同じ global を後勝ちで壊す。→ **version 名前空間レジストリ**（例 `window.ksql.versions['3.18.0'] = engine`＋`window.ksql.get(range)`）で共存させ、**既存の別バージョンを上書きしない・重複ロードは warn**。単一 customization 用途以外で UMD を使う場合の指針、npm 取込との使い分けを推奨レベルで示す。
   - **② 共有 global 副作用の禁止**: `installCursorPageLifecycle` / `registerCursorHandle`（`src/ui/kintoneClient.ts`）・`getCursorLeaseManager` が **module singleton か window/global 参照か**を監査。**window/global を鍵にした singleton・`kintone.api` の monkey-patch・重複 install する global listener を禁止**し、状態は per-instance に閉じる（複数コピーが同一 DOM/イベントに二重登録しないこと）。
   - **③ ホスト共有資源（Cursor lease）の非協調問題**: kintone のホスト単位 Cursor 上限（実測 max 5・B33）に対し、独立コピーが各自 lease を数えると**合算で実上限を超え得る**（各コピーは自分が ≤5 と認識）。Phase1 は **per-instance 保守既定（`cursorMaxActive` 既定2）＋超過 fail-closed** を基本とし、複数コピー協調（versioned な window 共有コーディネータ）を将来オプションにするか、Phase1 は非協調＝各コピー保守運用と明記するかを decide。少なくとも「複数コピー同時実行時に実上限超過があり得る」旨をドキュメント化する。
   - **④ version 露出**: public API に `version`（ライブラリ版）を出し、UMD レジストリの鍵・host 側のバージョン検出・診断に使えるようにする。
   - 受入条件（§8）に、UMD 2バージョン同時ロードで相互に上書きしない／各バージョンが自分の実装を返す／global 副作用の二重登録がない、を追加する。
   - **反映先:** §2、§4.2、§4.5、§6.3、§7、§8.1、§8.4、§8.5、§10.1、§11。実コード監査では `cursorPageLifecycle` と `cursorLeaseManager` が module singleton であり、bundle コピー間では listener／lease が協調しない現状を確認した。

指摘1・3・5は R1→R2 で本文へ反映済み、指摘4は明示済み。指摘2だけは安全側の現仕様を維持したままオーナー判断待ちである。公開意味論の2核心（read-only 二重強制／型隔離）は変更していない。
