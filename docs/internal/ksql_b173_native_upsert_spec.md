# B173 native UPSERT（`updateKey` + `upsert: true`）仕様 R5

> ## 【規範的訂正 2026-08-25】engine-library は可視化の対象外
>
> **本文で「MCP・プラグイン・engine-library」と書かれている箇所のうち、EXPLAIN の適格性表示に関するものは「MCP・プラグイン」と読み替える。AC-17 / AC-21 も engine-library には適用しない。**
>
> **理由 2 点:**
>
> 1. **[B89](ksql_b89_library_explain_batch_spec.md) §6b が `EXPLAIN UPSERT` の拒否を名指しで固定している** — 「`EXPLAIN UPDATE` / `EXPLAIN DELETE` / `EXPLAIN INSERT` / **`EXPLAIN UPSERT`** が **`runBatch` でも `explainQuery` でも** `READ_ONLY_VIOLATION` になること」。同 §4 は「**受理集合が `runBatch` と一致する — これが本仕様の中核**」とする。engine-library で適格性を表示するには**この中核契約に例外を作る**必要があり、診断行 1 本のために払う額ではない
> 2. **可視化の目的（起票文書 §7.3）は「`/flow` ジョブをオーサリング・検証する面で本番の挙動を読めるようにする」こと。** engine-library は**ダッシュボード等に読み取りクエリを埋め込むライブラリ**であって、ジョブを書く面ではない。**要件は目的（オーサリング／検証面）に従うべきで、実装の都合（`buildBatchExplainPlans` を共有する 5 面）に従うべきではなかった**
>
> **経緯**＝R3 の依頼で Claude が「非 opt-in 面（MCP・プラグイン・engine-library）」と書いたのが誤り（§17.6）。**engine-library の read-only ガード（`prepareExplainQuerySql`）は変更しない。**
>
> **対象面は「MCP・プラグイン・CLI」。** `src/engine-library/readonlyClient.ts` の `WRITE_METHODS` への `"upsertRecords"` 追加は**この訂正の対象外**（能力を報告しないための純加法で、可視化とは無関係）。

- 状態: 仕様 R5。実装未着手。この仕様作成セッションではコード、文書、git 状態を変更していない。
- 対象:
  - `/flow` の素の `UPSERT VALUES` / `UPSERT SELECT` 本実行、および同じ実行条件を反映する `previewStatement`。
  - CLI の実行ごとの明示 opt-in による同じ native UPSERT 経路。
  - CLI、MCP、プラグイン、engine-library、`/flow` が共有する EXPLAIN の native 適格性表示。
- 前提:
  - 案 C「能力検出付き・素の UPSERT 限定」を維持する。
  - `/flow` は native UPSERT を既定 ON とし、`enableNativeUpsert: false` を明示した場合だけ現行経路へ opt-out する。
  - CLI は既定 OFF とし、実行ごとの `--native-upsert` だけを opt-in とする。
  - プラグイン、MCP、engine-library には実行 opt-in を追加しない。
  - `putRecords` は変更せず、任意の能力メソッド `upsertRecords?` を純加法で追加する。
  - 能力メソッドを実装する同梱クライアントは `src/flow-library/writableClient.ts` と `src/cli/nodeKintoneClient.ts` の2面とする。
  - `onChunkWritten` は native の1リクエストにつき1回通知し、INSERT/UPDATE に分割しない。
  - CHECK / APPLY / IMPORT / VALIDATE ONLY / ON ERROR SKIP の各書込経路は変更しない。
  - 実機測定結果は `docs/internal/ksql_b173_native_upsert_update_key_issue.md:132-149` および同文書 §3.2 を採用し、再導出しない。
  - B173 の tracker 状態と対象は `docs/ksql_issue_tracker.md:44` を正とする。

## R4 からの変更点（復元）

- R3 の出力欠落で失われた R2 の列挙型受入条件を、R4 の AC-1〜AC-24 の番号体系を維持したまま AC-2 へ復元した。能力なし、schema の fail-closed、素の UPSERT 限定、空文字キーの各ケースを個別に固定した。
- R3 の出力欠落で失われた「変更するファイル」を §13 に復元した。R2 の Production／変更しない Production／Tests を土台に、R3・R4 で追加された CLI、共有適格性評価器と renderer、単文・バッチ EXPLAIN、metrics、`/flow` の既定 ON／opt-out を反映した。
- 上記2件以外の設計、判断、規範文言は R4 から変更していない。

## R3 からの変更点

- `/flow` の `enableNativeUpsert` を既定 `true` に変更した。省略時に native を許可し、`false` を明示した場合だけ現行経路へ戻す。
- CLI は従来どおり既定 `false` とし、`--native-upsert` による実行ごとの明示 opt-in を維持した。
- 面ごとに既定が異なる理由を明文化した。`/flow` は公開4日で既知の利用者が1者だけであり、その利用者が追加権限を持って変更を待っている。CLI は約4か月半公開され、追加権限を持たないトークンによる既存運用を否定できない（`docs/internal/ksql_b173_native_upsert_update_key_issue.md:424-479`）。
- EXPLAIN の判定を、面依存条件1・2と、文・データ依存条件3〜6に分けた。実行 opt-in を持たないMCP・プラグイン・engine-libraryでも、条件3〜6を独立して表示する。
- MCP・CLIの単文EXPLAINを `buildBatchExplainPlans` へ統合しない。共有するのは適格性評価器とrendererだけとし、既存の `executeExplain` から呼び出す。
- 単文EXPLAINに書込見積りがなく、バッチEXPLAINだけに `buildDialect1ApiEstimateLines` の見積りがある既存の非対称は、B173の範囲外として維持する（`src/execute.ts:12759-12765`、`:12803-12857`、`:13111-13169`）。
- プラグインをopt-in対象外とする理由を、CLIに対する追加価値の小ささと、自然な設定粒度がアプリ単位＝環境単位になる点へ差し替えた。
- 権限は検証面ではなく運用手順で担保するものとした。native有効化または `/flow` アップグレード前に、使用するAPIトークンに対象アプリのレコード追加権限があることを確認する。
- 権限エラー時の自動fallbackは採用しない。loudに失敗させ、トークンを修正させる。
- §12に、`/flow` のアップグレードで変わる5点、成功時のレコード内容が同じであること、opt-out、CLIの将来方針を追加した。
- §13にCHANGELOG文面案と依頼元への通知事項を追加した。
- §14の受入条件ではAC-1を `/flow` 省略時nativeへ書き換え、opt-outとCLI既定OFFを末尾の追加ACとして固定した。
- §15の実機確認事項を、既定ON、面別EXPLAIN、権限運用手順に合わせて更新した。

## 1. 目的

現行の素のUPSERTは、キーによる事前GETで既存レコードを解決し、その後に新規行をPOST、既存行をPUTする。`UPSERT VALUES` の現行処理は `src/execute.ts:10538-10588`、`UPSERT SELECT` は `src/execute.ts:11161-11218` にある。

B173は、安全に適用できる文をkintoneのnative UPSERTへ置き換える。

```http
PUT /k/v1/records.json
Content-Type: application/json

{
  "app": 4253,
  "upsert": true,
  "records": [
    {
      "updateKey": {
        "field": "key_text",
        "value": "K1"
      },
      "record": {
        "payload": {
          "value": "value-1"
        }
      }
    }
  ]
}
```

目的は次の3点である。

1. 既存判定のための事前GETをなくす。
2. `/flow` と、本番と同じAPIトークンを指定できるCLIで同じ書込経路を実行可能にする。
3. EXPLAINで、そのSQLとデータがnative適格か、どの面で実行可能か、現時点では決められないかを実行前に確認可能にする。

`/flow` とCLIの既定は意図的に異なる。

- `/flow` は2026-08-21に公開されてから4日で、既知の利用者はksql-flowだけである。その利用者はレコード追加権限を持ち、この変更を待っている。この面には既定OFFを要求する公開契約上の制約が実質ないため、既定ONとする。
- CLIは2026-04-07から約4か月半公開され、利用者を数えられない。追加権限を持たないトークンで更新専用UPSERTを実行する既存運用が存在し得るため、既定OFFを維持する。
- CLIの目的はCLI自体の高速化ではなく、本番と同じnative経路のリハーサルである。

プラグインには実行opt-inを追加しない。native挙動のリハーサルはCLIで足り、CLIはスクリプト化してCIにも載せられる。また、プラグインの自然な設定粒度はアプリ単位＝環境単位であり、「設定した後は以後ずっと効く」形になりやすい。実行ごとのUIトグルを追加する価値もCLIに対して小さい。

プラグイン利用者が通常アプリ管理権限を持つことや、セッション認証が `/flow` のAPIトークン権限を再現しないことは、プラグインを対象外にする理由にはしない。`/flow` が使うAPIトークンの権限を確認することはプラグインの役割ではない。

MCPはツール入力をLLMが構成するため、追加権限を要求する実行opt-inを裁量に開放しない。ただしMCP・プラグイン・engine-libraryにも条件3〜6のEXPLAIN表示を提供し、`/flow` またはCLIでnativeになる文かを読めるようにする。

`/flow` で `enableNativeUpsert: false` が指定された実行、フラグなしCLI、MCP、プラグイン、および適用条件を満たさない実行は、現在のread-then-write経路をそのまま使用する。

## 2. 非対象

次はB173のnative書込対象外とし、既存経路、結果、検証、API順序を変更しない。

- `CHECK` 付きUPSERT
- `APPLY UPSERT`
- `VALIDATE ONLY`
- `ON ERROR SKIP`
- `IMPORT` が内部生成する `UPSERT SELECT`
- `previewStatement` の既存値読取、差分、件数、サンプル
- プラグインの `src/ui/kintoneClient.ts`
- MCPの実行クライアントとツール入力
- engine-libraryのread-only実行
- dialect 1の構文・静的検証規則
- `putRecords` の入力型と `Promise<void>` の戻り値
- `ksql.config.json`、環境変数、プロファイル単位のnative設定
- `FlowUpsertResult` への経路情報追加
- 単文EXPLAINへのdialect 1書込見積り追加
- 単文EXPLAINとバッチEXPLAINの計画生成経路統合
- 権限エラー時の自動fallback

事前GETは、CHECK系では検証モードの決定、APPLYでは既存値、IMPORTでは既存サブテーブルとrevisionの取得にも使われているため、nativeへ置換できない（`docs/internal/ksql_b173_native_upsert_update_key_issue.md:23-38`）。dialect 1の検証も現行のままとする（`src/core/dialect1Validation.ts:90-128`）。

EXPLAINの適格性表示は非対象ではない。MCP・プラグイン・engine-libraryはnativeを実行しないが、条件3〜6について意味のある可視性を提供する。

## 3. 公開型と公開オプション

### 3.1 `FlowKintoneClient`

現行の `FlowKintoneClient.putRecords` はID指定更新だけを受け、戻り値を返さない（`src/flow-library/publicTypes.ts:53-81`）。

変更後は次を純加法で追加する。

```ts
export interface KintoneNativeUpdateKey {
  field: string;
  value: string;
}

export interface KintoneNativeUpsertRecord {
  updateKey: KintoneNativeUpdateKey;
  record: KintoneRecord;
}

export interface KintoneNativeUpsertParams {
  app: number;
  upsert: true;
  records: KintoneNativeUpsertRecord[];
}

export interface KintoneNativeUpsertRecordResult {
  id: string;
  revision: string;
  operation: "INSERT" | "UPDATE";
}

export interface KintoneNativeUpsertResult {
  records: KintoneNativeUpsertRecordResult[];
}

export interface FlowKintoneClient {
  // 既存メソッドは変更しない

  upsertRecords?(
    params: KintoneNativeUpsertParams
  ): Promise<KintoneNativeUpsertResult>;
}
```

`src/execute.ts` の `KintoneClient` にも、構造的に同一の任意メソッドを追加する。現行の `putRecords` は変更しない。

メソッドの存在だけが能力宣言である。同梱クライアントでは次の2つが能力を持つ。

- `src/flow-library/writableClient.ts` の `createKintoneClient`
- `src/cli/nodeKintoneClient.ts` の `createNodeKintoneClient`

古いクライアント、自前クライアント、プラグインクライアント、MCPの能力なしクライアントは、このメソッドを実装しなければ現在の経路を使い続ける。

### 3.2 `/flow` のopt-out

`CreateExecutionContextOptions` に次を追加する。

```ts
export interface CreateExecutionContextOptions extends ParseScriptOptions {
  client: FlowKintoneClient;

  /**
   * 素の UPSERT で kintone native UPSERT の利用を許可する。
   * 省略時および true は許可。false のときだけ現行経路へ戻す。
   * 既定 true。
   */
  enableNativeUpsert?: boolean;
}
```

解決規則は次のとおり。

```ts
const enableNativeUpsert =
  options.enableNativeUpsert !== false;
```

`createExecutionContext` は公開optionsからmanaged execution contextを構成し、executeとpreviewの双方に同じcontextを渡している（`src/flow-library/index.ts:109-152`）。B173でも同一の値を本実行とpreviewから参照する。

従来の単文・バッチcore APIの公開 `ExecuteOptions` へ一般利用者向けopt-inは追加しない。CLIと `/flow` からcoreへ渡す値は、公開barrelに出さない内部オプションまたは同等のprivate plumbingとする。

### 3.3 CLIのopt-in

CLIのフラグ名は次とする。

```text
--native-upsert
```

意味は「このCLI実行コンテキスト内の適格な素のUPSERTにnative経路を許可する」である。

次を契約とする。

- 既定はOFF。
- boolean flagとし、値は取らない。
- `ksql.config.json` には同等項目を追加しない。
- `KSQL_NATIVE_UPSERT` などの環境変数を追加しない。
- プロファイルから暗黙に有効化しない。
- 同一スクリプト内に複数のUPSERTがある場合、各文が独立して6条件を判定する。
- UPSERTを含まない入力で指定してもエラーにはせず、実行結果に影響しない。

CLIの既存DML安全ゲートとは独立させる。

- `--native-upsert` 単独ではDMLを許可しない。
- 本実行・dry-runとも、UPSERTには従来どおり `--allow-dml` が必要である（`src/cli/index.ts:2059-2077`）。
- `--yes` は確認プロンプトを省略するだけで、native opt-inを有効化しない。
- `--native-upsert` は `--allow-without-where`、`--dml-max-rows`、`--dml-max-subtable-rows` の意味を変更しない。
- CHECK / APPLY / IMPORT / VALIDATE ONLY / ON ERROR SKIPをnative対象に変えない。

CLIは現在、`--allow-dml` と `--yes` を別々に解析し（`src/cli/index.ts:349-366`）、DMLの許可判定後に `confirm` を実行へ渡す（`src/cli/index.ts:2410-2526`）。`--native-upsert` も独立した `ParsedArgs` booleanとして追加する。

### 3.4 REPL

`ksql --console --native-upsert` は許可する。

この場合の「実行ごと」は、REPLの各内部子プロセスではなく、利用者が明示的に開始したREPLセッションを単位とする。

- `buildReplExecArgv` は `base.nativeUpsert === true` の場合、子実行argvに `--native-upsert` を追加する。
- `:run`、通常実行、`:rerun` のすべてで同じ値を転送する。
- REPLの `session:` 表示と設定表示に `native-upsert=on|off` を追加する。
- REPL側でDML確認済みの子実行に `--yes` と `--allow-dml` を付ける現行契約を維持する（`src/cli/index.ts:1270-1324`）。
- nativeのためだけの別確認を追加しない。
- REPLの通常DML確認を拒否した場合、子実行自体を開始せず、native APIも呼ばない（`src/cli/index.ts:1591-1611`、`:1779-1797`）。

### 3.5 `--dry-run`

`--native-upsert --dry-run` は許可する。

意味はnative実行ではなく、nativeを有効にしたCLI本実行を想定した適格性の予測である。

- 書込APIは呼ばない。
- `upsertRecords` は呼ばない。
- `options.confirm` と対話確認は行わない。
- UPSERTには従来どおり `--allow-dml` を要求する。
- `--yes` の有無はdry-run結果へ影響しない。
- `--native-upsert` は面依存条件2をtrueとして渡す。
- dry-run用client自体に `upsertRecords` は追加しない。

`createDryRunClient` は全APIで例外を投げる完全オフラインclientである（`src/cli/index.ts:1062-1076`）。条件3・5・6を判定できない場合は `UNKNOWN` とし、`INELIGIBLE` と表示してはならない。

EXPLAINの条件1はdry-run clientではなく、予測対象となる通常のCLI clientの能力を入力として受け取る。

### 3.6 `ExplainScriptOptions`

`ExplainScriptOptions` に次を追加する。

```ts
export interface ExplainScriptOptions extends ParseScriptOptions {
  client: FlowKintoneClient;

  /**
   * /flow 本実行を想定する native UPSERT 設定。
   * 省略時および true は有効、false は opt-out。
   * EXPLAIN 自体に書込権限を与えるものではない。
   */
  enableNativeUpsert?: boolean;

  // 既存オプションは変更しない
}
```

`explainScript` は `/flow` の予測面であるため、省略時は `true` として扱う。本実行を `enableNativeUpsert: false` で構成する利用者が同じ判定を得るには、`explainScript` にも `false` を渡す。

MCP・プラグイン・engine-libraryから共通plannerを呼ぶ場合、`enableNativeUpsert` の省略を `/flow` の既定ONと解釈してはならない。内部では予測対象面を明示し、これらの面は条件1・2を「対象外」として条件3〜6だけを評価する。

### 3.7 `FlowChunkWrittenInfo`

`FlowChunkWrittenInfo` を次のように純加法で拡張する。

```ts
export interface FlowChunkWrittenInfo {
  statementIndex: number;
  appId: number;
  operation: "INSERT" | "UPDATE" | "DELETE" | "UPSERT";
  records: number;
  chunkIndex: number;

  insertedCount?: number;
  updatedCount?: number;
  lastKeyValue?: string;
}
```

native UPSERTの通知は常に次の形とする。

```ts
{
  operation: "UPSERT",
  records: insertedCount + updatedCount,
  insertedCount,
  updatedCount,
  lastKeyValue
}
```

`insertedCount` と `updatedCount` は型上optionalだが、`operation === "UPSERT"` の通知では両方を必ず設定する。既存の3操作では設定しない。

`operation` のunion拡大はexhaustive switchを持つ利用者に型上の影響がある。`/flow` は公開から4日で既知の利用者が1者だけであり、その利用者には網羅switchがないことが確認されているため、既定ONでの拡大を本リリースで許容する（`docs/internal/ksql_b173_native_upsert_update_key_issue.md:387-420`）。この変更はCHANGELOGと依頼元通知で明示する。現行定義は `src/flow-library/publicTypes.ts:154-165` にある。

### 3.8 `ExecutionMetrics`

`ExecutionMetrics` に次を純加法で追加する。

```ts
export interface ExecutionMetrics {
  getCalls: number;
  postCalls: number;
  putCalls: number;

  /**
   * upsertRecords を呼び出した回数。
   * putCalls の内数であり、成功・失敗の双方を含む。
   */
  nativeUpsertCalls: number;

  // 既存カウンタは変更しない
}
```

定義は次のとおり。

```text
nativeUpsertCalls
  = wrapClientWithMetrics が upsertRecords を委譲開始した回数

putCalls
  = 通常 putRecords の委譲開始回数
  + upsertRecords の委譲開始回数
```

常に次を満たす。

```text
0 <= nativeUpsertCalls <= putCalls
```

native呼出しがrejectした場合も両方を増やす。レスポンス検証エラーやcallbackエラーで後から文が失敗しても減算しない。現行カウンタは `src/flow-library/publicTypes.ts:179-200`、既存PUT計上は `src/execute.ts:968-978` にある。

面ごとの見え方は次とする。

- `/flow`: statement resultの累積 `metrics.nativeUpsertCalls` から観測できる。
- CLI: core内部では計上するが、CLI JSON出力に新項目は追加しない（`src/cli/index.ts:780`）。
- MCP・プラグイン・engine-library: native実行しないため0。
- `FlowUpsertResult`: 経路情報を追加しない。

### 3.9 変更しない結果型

次は変更しない。

```ts
export interface FlowUpsertResult {
  type: "UPSERT";
  insertedCount: number;
  updatedCount: number;
}
```

nativeか現行経路かは、metricsとEXPLAINで観測する。

## 4. native適用可否

### 4.1 判定単位

判定単位は1文全体とする。

同じ文の一部だけをnative、残りを現行経路に流してはならない。schema不明、空文字、ソース重複などが1行でもあれば、その文全体を現行経路へ戻す。同一スクリプト内の別のUPSERT文は独立して判定する。

### 4.2 単一の共有判定

本実行、`previewStatement`、バッチEXPLAIN、単文EXPLAINは同じ評価器を共有しなければならない。条件式を複製してはならない。

条件を次の2群に分ける。

| 群 | 条件 | 性質 |
|---|---|---|
| 面依存 | 1 クライアント能力、2 native設定 | 実行面の構成 |
| 文・データ依存 | 3 キーschema、4 素のUPSERT、5 空文字キー、6 ソース重複 | SQLとデータの性質 |

共有評価器は各条件を `PASS`、`FAIL`、`UNKNOWN`、`NOT_APPLICABLE` の内部結果として保持し、外部表示では次の3状態を使う。

```ts
type NativeUpsertEligibilityStatus =
  | "ELIGIBLE"
  | "INELIGIBLE"
  | "UNKNOWN";
```

実行可能面の評価結果は次に相当する。

```ts
type NativeUpsertExecutionEligibility =
  | { status: "ELIGIBLE" }
  | {
      status: "INELIGIBLE";
      condition: 1 | 2 | 3 | 4 | 5 | 6;
      reason: string;
    }
  | {
      status: "UNKNOWN";
      unknownConditions: Array<{
        condition: 1 | 2 | 3 | 4 | 5 | 6;
        reason: string;
      }>;
    };
```

文・データ依存の評価結果は同じ3状態を条件3〜6だけに適用する。

```ts
type NativeUpsertStatementEligibility =
  | { status: "ELIGIBLE" }
  | {
      status: "INELIGIBLE";
      condition: 3 | 4 | 5 | 6;
      reason: string;
    }
  | {
      status: "UNKNOWN";
      unknownConditions: Array<{
        condition: 3 | 4 | 5 | 6;
        reason: string;
      }>;
    };
```

評価規則は次のとおり。

1. 判定可能な条件をすべて評価する。
2. falseがあれば `INELIGIBLE` とする。
3. falseが複数ある場合は§4.3の順序で最初の条件を表示する。
4. falseがなく未判定条件があれば `UNKNOWN` とする。
5. 対象となる全条件がtrueの場合だけ `ELIGIBLE` とする。
6. MCP・プラグイン・engine-libraryでは条件1・2を `NOT_APPLICABLE` とし、条件3〜6の状態を表示する。
7. 条件3〜6に既知の失敗がある場合、面依存条件が対象外でも `INELIGIBLE` と表示する。
8. 条件3〜6がすべてtrueの場合、「opt-inのある面ではnativeになる」と表示する。

本実行とpreviewでは6条件をすべて適用する。実行時に `UNKNOWN` が残った場合はfail-closedとし、現行経路へ戻す。

共有判定の入力は少なくとも次を含む。

- 予測対象面
- native能力の有無
- 解決済みの `enableNativeUpsert`
- UPSERT文の構文情報
- IMPORT由来かどうか
- 対象フィールドのschema、またはschema未取得という状態
- 評価・materialize済みの全ソース行のキー値、または未materializeという状態
- キーフィールドの型

本実行では、全ソースレコードの組み立てと既存の書込値検証が完了した後、既存対象を検索する直前に判定する。

previewでも同じ段階で同じ判定を行う。`previewUpsertRecords` は全行の `records` と `rowKeys` を構築しているため、空文字とソース内重複を同じ入力で評価できる（`src/execute.ts:2605-2621`）。

previewはnative適格でも既存対象GETを省略しない。GETはcounts、before/after、sampleに必要である（`src/execute.ts:2605-2644`）。

### 4.3 判定順序

判定順序は次の6条件で固定する。

#### 1. クライアント能力

`upsertRecords` が能力として存在し、かつ関数でなければならない。

```ts
"upsertRecords" in client
&& typeof client.upsertRecords === "function"
```

`typeof` だけで判定してはならない。readonly clientはwrite propertyのgetをブロック関数として返す一方、`has` では存在しないと報告するためである（`src/engine-library/readonlyClient.ts:74-83`）。

EXPLAINでは予測対象となる通常実行clientの能力を入力にする。MCP・プラグイン・engine-libraryでは文・データ評価に対してこの条件を対象外とする。

#### 2. native設定

`/flow` では解決後の `enableNativeUpsert === true` を要求する。省略はtrue、明示falseは不適格である。

CLIでは `--native-upsert` を要求する。`--allow-dml` や `--yes` から暗黙にtrueと推測してはならない。

MCP・プラグイン・engine-libraryの文・データ評価では、この条件を対象外とする。

#### 3. キーschema

次のすべてを要求する。

- `keyFields.length === 1`
- schemaにそのフィールドが存在する
- `fieldType` が `"SINGLE_LINE_TEXT"` または `"NUMBER"`
- `isUnique === true`

`isUnique === undefined` は実行時には不適格とする。EXPLAINでschema自体が取得されていない場合は `UNKNOWN` とする。dialect 0 / 1自体は条件にしない（`src/core/dialect1Validation.ts:115-126`）。

#### 4. 素のUPSERT

次のどちらかだけを適格とする。

- CHECK、APPLY、VALIDATE ONLY、ON ERROR SKIPを伴わない `UPSERT VALUES`
- CHECK、VALIDATE ONLY、ON ERROR SKIPを伴わず、IMPORT由来でもない `UPSERT SELECT`

この条件は構文木だけで判定できる。dialect 1でもCHECK付きUPSERTは受理されるため、dialectを根拠に素のUPSERTと仮定してはならない（`docs/internal/ksql_b173_native_upsert_update_key_issue.md:92-99`）。

#### 5. 空文字キーなし

全ソース行について、評価後のキー値が `""` でないことを要求する。

空文字の `updateKey.value` はkintoneが `CB_VA01` で拒否する。一方、現行経路は空文字を含むキーを行ごとのGETで処理するため、空文字を新しいエラーにはせず現行経路へ戻す（`src/execute.ts:7252-7262`、`:7279-7292`）。

全ソース行がmaterializeされていないEXPLAINでは `UNKNOWN` とする。

#### 6. ソース内キー重複なし

評価・materialize済みの全ソース行を一括して検査する。100件チャンク単位ではなく、文のソース全体をスコープとする。

同値性は次のとおり。

- `SINGLE_LINE_TEXT`: 文字列の完全一致
- `NUMBER`: exact-decimal正規化後の一致

NUMBERの `"5"` と `"5.0"` は重複、文字列の `"001"` と `"1"` は別キーである。現行のNUMBER正規化規則は `src/execute.ts:7188-7212` にある。

全ソース行がmaterializeされていないEXPLAINでは `UNKNOWN` とする。

### 4.4 不適格時と判定不能時の実行

本実行またはpreviewで条件を満たさない場合、または必要な判定材料が不足した場合は、その文全体を静かに現行経路へ戻す。

- 新しい警告を出さない。
- 新しいエラーを出さない。
- nativeを一度試してから現行経路へ再試行しない。
- 適用判定だけを目的とするAPI呼出しを増やさない。
- 現行の対象GET、POST、PUTの順序を変えない。
- `onChunkWritten` の通知列を変えない。
- previewの `estimatedWrites` は現行式を使う。

schemaと型は既に書込検証で取得するフォーム定義を使う。追加の `getFields` や `getNumberPrecision` を発行してはならない（`src/execute.ts:10535-10544`、`:11135-11141`）。

EXPLAINの `UNKNOWN` は表示上の状態であり、実行時にnativeを選ぶ許可ではない。

### 4.5 EXPLAINの入力充足

EXPLAINはmetadata API以外の実行APIを呼ばないplannerである（`src/execute.ts:12636-12653`）。

- 条件1: 実行可能面では予測対象clientの能力から判定する。非実行面の文・データ評価では対象外。
- 条件2: `/flow` またはCLIの解決済み設定から判定する。非実行面では対象外。
- 条件3: ~~plannerが別目的で既に取得・キャッシュしたフォームmetadataがある場合だけ判定する。~~ → **【訂正 2026-08-25・B176】対象アプリのフォームmetadataを取得して判定する**（下記）。
- 条件4: 構文木から常に判定する。
- 条件5・6:
  - `UPSERT VALUES` で値と変数を副作用なしに確定できる場合は判定する。
  - `UPSERT SELECT` はソース行を取得・materializeしないため `UNKNOWN` とする。
  - 一時表や変数の値がplanner上で確定できない場合も `UNKNOWN` とする。

~~`resolveMetadata === false` の場合、条件3は `UNKNOWN` とする。条件3のために `getFields` を呼んではならない。~~

> ## 【規範的訂正 2026-08-25・[B176](ksql_b176_explain_eligibility_always_unknown_issue.md)】EXPLAIN は条件 3 のために metadata API を引いてよい
>
> **旧規定「条件 3 のために `getFields` を呼んではならない」は、AC-16（`ELIGIBLE` を表示する）と両立しなかった。** `EXPLAIN UPSERT` は対象アプリのフォーム定義を別目的では取得しないため、旧規定のもとでは**条件 3 が常に `UNKNOWN` になり、`ELIGIBLE` に到達できない**（v3.73.0 で実際にそうなった）。
>
> **新規定:**
>
> - **EXPLAIN では、条件 3 の判定のために対象アプリの `getFields` を引いてよい**（invocation キャッシュを共有し、同一アプリは 1 回）。**`EXPLAIN SELECT` は既に引いており、面としての一貫性はむしろ上がる**
> - **レコード API・Cursor API・mutation API は引き続き 0 回**。この境界は動かさない
> - **`resolveMetadata === false` と、CLI の完全オフライン `--dry-run` では引かない**。材料が無いので条件 3 は `UNKNOWN`（**「判定不能」であって「不適格」ではない**）
> - **metadata 取得が失敗した場合はエラーを伝播する**（`EXPLAIN SELECT` と同じ）。**握り潰して `UNKNOWN` に降格しない**＝権限不足や通信障害を隠すことになるため
>
> **本実行と `previewStatement` には旧規定がそのまま当てはまる**（§4.4 の「適用判定だけを目的とする API 呼出しを増やさない」）。**両者は書込検証で既にフォーム定義を持っているので、そもそも追加取得が要らない。**
>
> → **「API を増やさない」の制約は本実行・preview のもの。EXPLAIN は metadata API 可・レコード API 不可。**

## 5. ソース内キー重複

重複時は現行経路へ戻す。

現行の素のUPSERTは重複を一律エラーにしていない。既存レコードに対する重複行は、同じ `$id` を複数回PUTして後勝ちで成功する（`docs/internal/ksql_b173_native_upsert_update_key_issue.md:138-145`）。nativeへの切替で入力契約を破壊してはならない。

重複を検出した場合:

- native UPSERTは1回も呼ばない。
- 全行を現行経路で処理する。
- 現行経路での成功または既存エラーを維持する。
- previewのcounts、sample、`estimatedWrites` は現行規則を使う。
- EXPLAINの文・データ状態は `INELIGIBLE`、条件6と表示する。
- この不適格性は面に依存せず、どの面でもnativeにならないと表示する。

## 6. nativeペイロード

### 6.1 組み立て順

各行について次の順に処理する。

1. 現行と同じ規則で全UPSERTフィールドを含む `KintoneRecord` を構成する。
2. 現行のフィールド書込可否、必須、長さ、数値精度などの検証を元のレコードに対して実行する。
3. 単一キーフィールドの値を文字列として取得する。
4. 送信用 `record` を新しく作り、キーフィールドだけを除外する。
5. キー値を `updateKey.value` に設定する。
6. フィールドコードを `updateKey.field` に設定する。
7. ソース順を維持したまま100件単位に分割する。
8. 各リクエストにトップレベルの `upsert: true` を必ず設定する。

元のレコードオブジェクトを破壊的に変更してはならない。

キー除去後に送信用 `record` が空でも `record: {}` として送る。キーのみのUPSERTも6条件を変更せずnative適格とする（`docs/internal/ksql_b173_native_upsert_update_key_issue.md §3.2`）。

### 6.2 キー値

`updateKey.value` は必ず文字列で送る。

NUMBERキーもJavaScriptの `number` に変換しない。VALUESの数値リテラルはraw表現、SELECTの値はmaterialize後の文字列表現を維持する。安全整数を超える値も、アプリの `numberPrecision` に収まる限りそのまま送る。

現行のVALUESキー抽出は数値リテラルのraw textを維持している（`src/execute.ts:10597-10606`）。実機でも16桁・20桁のNUMBERキーを文字列のまま渡せば照合できている（`docs/internal/ksql_b173_native_upsert_update_key_issue.md:142-145`）。

### 6.3 キーの除去

キーフィールドを `record` と `updateKey` の両方へ載せてはならない。

許可:

```json
{
  "updateKey": {
    "field": "key_text",
    "value": "K1"
  },
  "record": {
    "payload": {
      "value": "value-1"
    }
  }
}
```

キーのみ:

```json
{
  "updateKey": {
    "field": "key_text",
    "value": "K1"
  },
  "record": {}
}
```

キーを `record` に含めるとkintoneは `CB_VA01` で拒否する。INSERT時のキーフィールド値は `updateKey` から登録される（`docs/internal/ksql_b173_native_upsert_update_key_issue.md:136-145`）。

## 7. 書込順・確認・結果

### 7.1 書込順

native適格な文では、ソース順のまま100件単位で `upsertRecords` を呼ぶ。

現行の「INSERT全チャンクをPOSTした後、UPDATE全チャンクをPUTする」順序とは異なる（`src/execute.ts:10578-10588`、`:11208-11218`）。

0行の場合は `options.confirm` と `upsertRecords` のいずれも呼ばず、次を返す。

```ts
{
  type: "UPSERT",
  insertedCount: 0,
  updatedCount: 0
}
```

### 7.2 `options.confirm`

全ソースレコードの構築、書込値検証、native適格性判定が完了した後、最初の `upsertRecords` の直前に次を実行する。

```ts
const total = records.length;

if (options.confirm && total > 0) {
  const ok = await options.confirm(total, "UPDATE");
  if (!ok) throw new OperationCancelledError("UPDATE", total);
}
```

契約は次のとおり。

- 件数は文全体の合計件数。
- 第2引数は現行と同じ `"UPDATE"`。
- 複数チャンクでも1回だけ呼ぶ。
- falseの場合は `OperationCancelledError("UPDATE", total)` を送出する。
- 拒否時は `upsertRecords`、`postRecords`、`putRecords`、`onChunkWritten` のすべて0回。
- 0件では呼ばない。

現行UPSERT VALUES / SELECTも合計件数と `"UPDATE"` を渡している（`src/execute.ts:10571-10576`、`:11201-11206`）。

CLIでは既存のDML許可、確認、件数ガードを維持する。バッチでは全体確認1回と文ごとの件数ガードを維持し、coreの `options.confirm(total, "UPDATE", context)` 呼出し自体を省略しない（`src/cli/index.ts:2432-2481`）。

### 7.3 結果の内訳

各nativeレスポンスについて、リクエスト行と同じ順序で返る `records[]` を検査する。

- `operation === "INSERT"` を `insertedCount` に加算する。
- `operation === "UPDATE"` を `updatedCount` に加算する。
- `revision` からINSERT/UPDATEを推測しない。
- `id` と `revision` は検査するが、`FlowUpsertResult` には追加しない。

全チャンク成功後に次を返す。

```ts
{
  type: "UPSERT",
  insertedCount: 全レスポンスの INSERT 件数,
  updatedCount: 全レスポンスの UPDATE 件数
}
```

実機では100件の混在リクエストについて、全100件がリクエスト順に返り、全件の `id` と `revision` が文字列だった（`docs/internal/ksql_b173_native_upsert_update_key_issue.md §3.2`）。

### 7.4 不正なレスポンス

次のいずれかはfail-closedにする。

- `records` が配列でない。
- `records.length` が送信件数と一致しない。
- 各要素の `operation` が `"INSERT"` / `"UPDATE"` 以外。
- `id` または `revision` が文字列でない。

現行経路へ再試行しない。

```text
code: NativeUpsertResponseError
message: NativeUpsertResponseError: upsertRecords returned an invalid response.
```

## 8. クライアントとラッパー

任意メソッドは、能力のないclientにラッパーが能力を付与しないよう、すべて条件付きで公開する。

### 8.1 `/flow` の `createKintoneClient`

`src/flow-library/writableClient.ts` の同梱クライアントに `upsertRecords` を実装する。現行 `putRecords` はレスポンスを捨てている（`src/flow-library/writableClient.ts:139-148`）。

`upsertRecords` は:

- `PUT /records.json` を使用する。
- `app`、`upsert: true`、`records` をbodyに送る。
- レスポンスの `records` を返す。
- guest space、認証、timeout、HTTP errorは既存共通処理を使う。

### 8.2 CLIの `createNodeKintoneClient`

`src/cli/nodeKintoneClient.ts` の同梱clientに同じ `upsertRecords` を追加する。

現行 `putRecords` へトップレベル `upsert` を混ぜず、専用メソッドとして次を送る（`src/cli/nodeKintoneClient.ts:337-349`）。

```ts
{
  app: params.app,
  upsert: true,
  records: params.records
}
```

戻り値は `requestJson<KintoneNativeUpsertResult>` のレスポンスを返す。

### 8.3 `wrapClientWithMetrics`

現行wrapperはメソッド列挙型である（`src/execute.ts:914-996`）。

- 内側に能力がある場合だけ外側にも `upsertRecords` を追加する。
- 委譲前に `metrics.putCalls` と `metrics.nativeUpsertCalls` を1ずつ増やす。
- 成功・失敗の双方を計上する。
- 内側に能力がない場合、外側の `"upsertRecords" in client` もfalse。
- 戻り値をそのまま返す。

### 8.4 `withRequestGate`

現行は書込を `runMutation` に載せるメソッド列挙型である（`src/api/requestGate.ts:164-188`）。

- 内側に能力がある場合だけ公開する。
- `gate.runMutation(() => client.upsertRecords(params))` とする。
- 読取リトライを適用しない。
- 戻り値をそのまま返す。

### 8.5 `routeClient`

現行は論理アプリを物理アプリへ付け替えるメソッド列挙型である（`src/flow-library/index.ts:293-308`）。

- 内側に能力がある場合だけ公開する。
- `params.app` を物理アプリIDに置換する。
- `upsert`、`records`、`updateKey`、`record` は変更しない。
- 戻り値をそのまま返す。

### 8.6 `wrapClientWithPreviewWriteBlock`

現行はスプレッド後に書込メソッドを塞いでいる（`src/execute.ts:1984-1995`）。

- 内側に `upsertRecords` がある場合だけblocked methodで上書きする。
- 呼ばれた場合は次を送出する。

```text
PreviewWriteBlockedError: previewStatement blocked a write API call.
```

- 内側に能力がない場合はblocked methodを追加しない。
- previewの適格性判定は能力を保持するが、実際に呼んではならない。

### 8.7 `wrapClientWithChunkWrittenCallback`

現行はPOST / PUT / DELETEの成功後に通知する（`src/execute.ts:2114-2167`）。

- 内側に能力がある場合だけ `upsertRecords` をラップする。
- responseの構造と件数を検査する。
- 成功した1リクエストにつき1回通知する。
- `operation` は常に `"UPSERT"`。
- `records` はリクエスト件数。
- `insertedCount` / `updatedCount` はresponseから集計する。
- `lastKeyValue` はリクエスト最後の `updateKey.value`。
- callbackをawaitしてからresponseを返す。
- callbackがthrowした場合、文はエラーになるが対象チャンクは書込済みとする（`src/flow-library/publicTypes.ts:147-151`）。

### 8.8 `projectReadonlyClient`

`WRITE_METHODS` に `"upsertRecords"` を追加する（`src/engine-library/readonlyClient.ts:5-9`）。

readonly clientは:

- `"upsertRecords" in client === false`
- 直接propertyを取得して呼んだ場合はread-only violation
- native能力として検出されない

### 8.9 スプレッド型のその他ラッパー

`wrapClientWithSearchAbort` とcursor scopeはclientをスプレッドするため、前段で条件付き公開された `upsertRecords` を保持する（`src/execute.ts:1004-1055`）。

能力が実行入口まで失われないこと、および能力なしclientへ新しいpropertyを追加しないことを固定する。

## 9. `onChunkWritten`

native適格な3行を1回で送り、レスポンスが次の場合:

```json
{
  "records": [
    { "id": "6", "revision": "2", "operation": "UPDATE" },
    { "id": "7", "revision": "1", "operation": "INSERT" },
    { "id": "8", "revision": "1", "operation": "INSERT" }
  ]
}
```

通知は1回だけ行う。

```ts
{
  statementIndex: 0,
  appId: 4253,
  operation: "UPSERT",
  records: 3,
  insertedCount: 2,
  updatedCount: 1,
  chunkIndex: 0,
  lastKeyValue: "最後のソース行のキー"
}
```

101行なら通知回数は2回で、`records` は100、1となる。INSERTとUPDATEの内訳のために通知回数を増やさない。

`chunkIndex` は、その文で成功通知された書込APIリクエストの0始まりindexとする。失敗したリクエストには通知せず、後続も実行しない。

複数リクエストの部分失敗では、先行リクエストが確定して残り、失敗した後続リクエスト内部は全件ロールバックされることを実機で確認済みである（`docs/internal/ksql_b173_native_upsert_update_key_issue.md §3.2`）。

成功境界は `onChunkWritten` が通知済みのソース順prefixとする。

## 10. preview、EXPLAIN、`estimatedWrites`

### 10.1 previewの読取経路

previewはnative適格でも、既存対象を検索して次を現在と同じ規則で構成する。

- `counts.insert`
- `counts.update`
- before / after
- samples
- `reads`

`previewStatement` は書込を実行しない（`src/execute.ts:1984-1995`、`:2605-2644`）。

### 10.2 `estimatedWrites`

実行可能面について、共有判定が `ELIGIBLE` の場合:

```ts
estimatedWrites =
  Math.ceil((counts.insert + counts.update) / 100);
```

`INELIGIBLE` または `UNKNOWN` の場合:

```ts
estimatedWrites =
  Math.ceil(counts.insert / 100)
  + Math.ceil(counts.update / 100);
```

UPSERT以外の式は変更しない。現行式は `src/execute.ts:2472-2481` にある。

`/flow` は省略時にnative設定がONなので、能力ありclientと条件3〜6を満たすUPSERTではnative式を使う。`enableNativeUpsert: false`、能力なしclient、不適格、判定不能では現行式を使う。

### 10.3 EXPLAINの表示

UPSERT / UPSERT_SELECT文のplanに既存行を削除・変更せず適格性行を追加する。

#### 実行可能面

`/flow` とCLIでは6条件の実行適格性を表示する。

```text
  native UPSERT eligibility: ELIGIBLE（6 条件をすべて満たす）
```

```text
  native UPSERT eligibility: INELIGIBLE（条件 3: KEY_SCHEMA — キー項目は重複禁止の SINGLE_LINE_TEXT または NUMBER ではない）
```

```text
  native UPSERT eligibility: UNKNOWN（条件 3: KEY_SCHEMA — フォームメタデータ未取得; 条件 5・6: SOURCE_KEYS — ソース行未 materialize）
```

必要に応じて、文・データ条件の状態も別行で表示できる。ただし同じ評価結果からrenderし、条件式を再評価してはならない。

#### 非実行面

MCP・プラグイン・engine-libraryでは条件1・2を理由に `INELIGIBLE` と表示しない。条件3〜6だけを報告する。

```text
  native UPSERT statement/data eligibility: ELIGIBLE（条件 3〜6 を満たす）
  native UPSERT execution surface: NOT_APPLICABLE（この面では実行しない。/flow または CLI --native-upsert では native 候補）
```

```text
  native UPSERT statement/data eligibility: INELIGIBLE（条件 6: SOURCE_DUPLICATE — ソース内に同一キーがある。どの面でも native にならない）
  native UPSERT execution surface: NOT_APPLICABLE（この面では実行しない）
```

```text
  native UPSERT statement/data eligibility: UNKNOWN（条件 3: KEY_SCHEMA — フォームメタデータ未取得; 条件 5・6: SOURCE_KEYS — ソース行未 materialize）
  native UPSERT execution surface: NOT_APPLICABLE（この面では実行しない）
```

固定の適格性状態値は引き続き `ELIGIBLE`、`INELIGIBLE`、`UNKNOWN` とする。`NOT_APPLICABLE` は適格性状態ではなく、面依存条件1・2がそのEXPLAIN面の評価対象外であることを表す補助値である。

識別子は次を使う。

```text
1 CLIENT_CAPABILITY
2 OPT_IN
3 KEY_SCHEMA
4 PLAIN_UPSERT
5 EMPTY_KEY
6 SOURCE_DUPLICATE
```

`INELIGIBLE` は対象群で最初の既知の失敗条件だけを表示する。`UNKNOWN` は未判定条件を条件番号順にすべて表示する。

既存のdialect 1 API見積りには現行経路を前提とした `UPSERT pre-read` がある（`src/execute.ts:12832-12855`）。バッチEXPLAINでは既存行を削除せず、適格性行により次の解釈を示す。

- `ELIGIBLE`: 本実行ではpre-readを行わず、writeは合計行数の100件チャンク。
- `INELIGIBLE`: 既存のpre-readとINSERT/UPDATE分割見積り。
- `UNKNOWN`: 現行見積りを安全側の上限として残す。
- 非実行面で文・データ `ELIGIBLE`: `/flow` またはopt-in CLIで、面依存条件も満たせばnative見積りになる。

### 10.4 `buildBatchExplainPlans`

`buildBatchExplainPlans` はCLI、MCP、プラグイン、engine-library、`/flow` が共有している（`src/cli/index.ts:2348-2354`、`src/mcp/tools.ts:705-720`、`src/ui/batchExplain.ts:17-30`、`src/engine-library/query.ts:120-136`、`src/flow-library/index.ts:76-103`）。

trailing optional options objectまたは同等の純加法引数を追加する。

```ts
interface NativeUpsertExplainOptions {
  surface: "FLOW" | "CLI" | "DOCUMENT_ONLY";

  /**
   * FLOW / CLI の実行設定。
   * DOCUMENT_ONLY では条件 2 は対象外。
   */
  enableNativeUpsert?: boolean;

  /**
   * FLOW / CLI が予測する通常実行 client の能力。
   * dry-run client から推測しない。
   * DOCUMENT_ONLY では条件 1 は対象外。
   */
  clientHasNativeUpsert?: boolean;
}
```

呼出元はsurfaceを明示する。

- `/flow`: `surface: "FLOW"`。`enableNativeUpsert` は省略時true。routed clientの実能力を渡す。
- CLI: `surface: "CLI"`。`enableNativeUpsert` は `--native-upsert` の有無。通常CLI clientの能力を渡す。
- MCP・プラグイン・engine-library: `surface: "DOCUMENT_ONLY"`。条件1・2を対象外とし、条件3〜6を表示する。

後方互換のため既存呼出しがoptionsを省略した場合の扱いは要確認とする。実装では呼出元をすべて明示更新し、暗黙の省略値によってMCP等を `/flow` と誤判定しないことを優先する。

### 10.5 MCPの単文EXPLAIN

MCPの単文EXPLAINは `executeSql(explainSql(...))` → `toSelectPayload` でSELECTペイロードを返す（`src/mcp/tools.ts:730-745`）。複文の `buildBatchExplainPlans` とは別の出力経路である。

R4ではこの経路を統合しない。

- 単文は従来どおり `executeSql(explainSql(...))` を使う。
- `executeExplain` からバッチと同じ共有適格性評価器とrendererを呼ぶ。
- `executeExplain` が作る `columns: ["plan"]` と `rows` の外形を維持する（`src/execute.ts:13111-13169`）。
- MCPの `toSelectPayload`、app binding復元、単文/バッチのレスポンス形を変更しない。
- MCPツール入力に `enableNativeUpsert` は追加しない。
- 単文でも条件3〜6の行を欠落させない。
- 単文に `buildDialect1ApiEstimateLines` を追加しない。

### 10.6 CLIのEXPLAIN

次の双方へCLI面の設定を渡す。

- `--dry-run` が直接 `buildBatchExplainPlans` を呼ぶ経路（`src/cli/index.ts:2348-2354`）
- SQLとして書かれた `EXPLAIN UPSERT ...` の単文・バッチ経路

CLIの単文EXPLAINは `executeExplain` から共有評価器とrendererを呼ぶ。共通plannerへ寄せず、条件式や文言を複製しない。

`--native-upsert` なしのCLIでは、条件3〜6の状態を面依存の不適格理由で隠さない。表示例:

```text
  native UPSERT eligibility: INELIGIBLE（条件 2: OPT_IN — --native-upsert が指定されていない）
  native UPSERT statement/data eligibility: ELIGIBLE（条件 3〜6 を満たす。--native-upsert 指定時は native 候補）
```

条件6も失敗する場合:

```text
  native UPSERT eligibility: INELIGIBLE（条件 2: OPT_IN — --native-upsert が指定されていない）
  native UPSERT statement/data eligibility: INELIGIBLE（条件 6: SOURCE_DUPLICATE — ソース内に同一キーがある。フラグを付けても native にならない）
```

### 10.7 dry-runの表示例

```bash
ksql --allow-dml --native-upsert --dry-run -e \
  "UPSERT INTO APP1 (key, value) VALUES ('K1', 'v') KEY (key)"
```

schema未取得の場合:

```text
native UPSERT eligibility: UNKNOWN（条件 3: KEY_SCHEMA — フォームメタデータ未取得）
```

`UPSERT SELECT` でschemaだけ判定できた場合:

```text
native UPSERT eligibility: UNKNOWN（条件 5・6: SOURCE_KEYS — UPSERT SELECT のソース行未 materialize）
```

`--native-upsert` を省略した場合:

```text
native UPSERT eligibility: INELIGIBLE（条件 2: OPT_IN — --native-upsert が指定されていない）
native UPSERT statement/data eligibility: UNKNOWN（条件 3: KEY_SCHEMA — フォームメタデータ未取得）
```

「metadata未取得」を「schema不適格」と表示してはならない。

## 11. エラー

### 11.1 kintone APIエラー

`upsertRecords` がkintone API errorを返した場合、現行wrapperのerror codeとトップレベルmessageを変更せず上位へ送る。

対象例:

- `GAIA_IQ28`
- `CB_VA01`
- レコード追加権限不足
- guest space / auth error

フィールド別詳細を新しい独自形式に変換しない。

### 11.2 `/flow` とCLI

`/flow` の `executeStatement` は既存どおりerror resultに正規化する。

```ts
{
  status: "error",
  error: {
    code: error.name,
    message: error.message
  }
}
```

CLIは既存のerror-to-exit-codeとstderr契約を維持する。native専用exit codeは追加しない。

`OperationCancelledError`、`NativeUpsertResponseError`、kintone API errorのいずれでも、native開始後に現行経路へ切り替えない。

### 11.3 nativeエラー後のfallback禁止

適格性判定で不適格または判定不能なら、書込前に現行経路へ戻す。

一度でもnativeリクエストを開始した後は、次のいずれでも現行経路へ再試行しない。

- API error
- 権限エラー
- レスポンス不正
- `onChunkWritten` callback error
- CLIの出力処理error

権限エラーが1チャンク目でall-or-nothingとなり、書込ゼロで検出できる場合でも自動fallbackしない。権限不足をloudに失敗させ、APIトークンを修正させる。静かに遅い現行経路へ落とすと、権限設定ミスと性能退行を隠すためである。

先行チャンクが確定済みの可能性がある場合、再試行すると二重書込や件数誤報になる。実機でも、先行チャンクは確定して残り、失敗した後続リクエスト内は全ロールバックされることを確認済みである（`docs/internal/ksql_b173_native_upsert_update_key_issue.md §3.2`）。

通常UPSERTのエラー結果に `partialSuccess` は追加しない。成功境界は `onChunkWritten` の通知済みprefixとする。

## 12. 移行と互換性

### 12.1 `/flow` の既定ONとアップグレード影響

`/flow` は `enableNativeUpsert` 省略時にnativeを許可する。

能力のある同梱clientを使い、条件3〜6を満たす素のUPSERTは、B173を含む版へアップグレードした時点でnative経路になる。

成功時の最終レコード内容と `insertedCount` / `updatedCount` は現行経路と同じである。一方、次の5点は変わる。

1. 書込順  
   現行の「新規全部をPOSTした後、更新全部をPUT」から、ソース順のINSERT/UPDATE混在チャンクへ変わる。

2. 部分失敗時に確定している範囲  
   現行のINSERT群・UPDATE群単位ではなく、ソース順の成功済みprefixになる。

3. `onChunkWritten`  
   `operation: "UPSERT"` が出現し、`insertedCount` と `updatedCount` が付く。

4. `ExecutionMetrics`  
   native適格な書込では `postCalls` が0になる。書込は `putCalls` に集約され、`nativeUpsertCalls` は `putCalls` の内数になる。

5. `estimatedWrites`  
   現行の

   ```text
   ceil(insert / 100) + ceil(update / 100)
   ```

   から、native適格時は

   ```text
   ceil((insert + update) / 100)
   ```

   へ変わる。

opt-outは次のように明示する。

```ts
const context = createExecutionContext({
  client,
  enableNativeUpsert: false
});
```

opt-outした `/flow` では、結果、API呼出し回数、GET→POST→PUTの順序、API body、`onChunkWritten`、preview、既存エラーをB173実装前と同じにする。`nativeUpsertCalls` の追加とEXPLAIN行は純加法の観測情報として除く。

### 12.2 古いクライアント

`upsertRecords` はoptionalであるため、既存の自前 `FlowKintoneClient` 実装は変更不要である。

能力を宣言していないclientでは、`/flow` の既定がONでもエラーにせず現行経路を使う。

既存のmetrics objectを手作業で構築するTypeScript利用者には、新しい必須propertyが型上の影響を持つ。各metrics snapshotでは必ず `nativeUpsertCalls: 0` 以上を含める。

### 12.3 CLI

CLI同梱clientは能力を持つが、`--native-upsert` を指定しない限り現行経路を使う。

```bash
ksql \
  --profile production-rehearsal \
  --allow-dml \
  --native-upsert \
  -f job.sql
```

対話確認を省略する場合:

```bash
ksql \
  --profile production-rehearsal \
  --allow-dml \
  --native-upsert \
  --yes \
  -f job.sql
```

`--yes` を付けても6条件、件数ガード、能力判定は省略しない。

CLIの既定を将来ONへ反転させる場合はメジャー版に限る。ただしCLIの目的が本番native経路のリハーサルである限り、明示フラグのままでよく、反転を予定作業とはしない。

`/flow` はR4時点で既に既定ONとするため、将来の既定反転論はない。`enableNativeUpsert: false` は退避弁として維持する。

### 12.4 プラグインとMCP

プラグインclientは `upsertRecords` を実装しない。MCPの実行入力にもopt-inを追加しない。

- native挙動のリハーサルはCLIで足り、CLIはCIにも載せられる。
- プラグインの自然な設定粒度はアプリ単位＝環境単位であり、継続的に有効になる設定を生みやすい。
- MCPはLLMが実行入力を構成するため、追加権限を要求するopt-inを公開しない。
- 両面の実行は現行経路を維持する。
- EXPLAINでは条件1・2を対象外とし、条件3〜6を表示する。

トップレベル `upsert` を既存 `putRecords` に混ぜて渡す実装にはしない（`docs/internal/ksql_b173_native_upsert_update_key_issue.md:40-52`）。

### 12.5 EXPLAINの互換性

既存のstatement count、statement type、plan配列、MCP単文/バッチの外形を維持する。

変更はUPSERT / UPSERT_SELECTのplanへの適格性行追加だけとする。

- SELECT、UPDATE、DELETE、INSERT等の既存planは変更しない。
- `UNKNOWN` を理由にEXPLAIN自体をerrorにしない。
- metadataやソースを追加取得しない。
- 現行のAPI consumption行を削除しない。
- MCP単文のレスポンスをバッチ形へ変更しない。
- 単文計画を `buildBatchExplainPlans` で作り直さない。
- 単文に既存バッチ専用の書込見積りを追加しない。

### 12.6 権限の運用手順

native UPSERTは、既存行だけを更新する場合でも対象アプリのレコード追加権限を要求する。

`/flow` の既定がONになるため、B173を含む版へアップグレードする前に、`/flow` が使うAPIトークンに対象アプリのレコード追加権限があることを確認する。

APIトークンのスコープを問い合わせる手段がない以上、この確認はどの実行面でも自動代替できない。CLIで本番と同じトークンを指定できることは挙動確認の補助であり、運用上の権限確認の代替ではない。

確認手順は少なくとも次を含む。

1. `/flow` が実際に参照するAPIトークンを特定する。
2. 対象アプリごとにレコード閲覧・追加・編集権限を確認する。
3. 必要なら本番前にCLIの `--native-upsert` で同じSQLをリハーサルする。
4. 問題時に `enableNativeUpsert: false` でopt-outできることを確認する。

## 13. 変更するファイル

### Production

- `src/flow-library/publicTypes.ts`
  - native UPSERT の公開入力・レスポンス型を追加する。
  - `FlowKintoneClient.upsertRecords?` を追加する（`src/flow-library/publicTypes.ts:53-75`）。
  - `CreateExecutionContextOptions.enableNativeUpsert?` を追加し、`/flow` では省略時 `true`、明示 `false` だけを opt-out とする（`src/flow-library/publicTypes.ts:126-152`）。
  - `ExplainScriptOptions.enableNativeUpsert?` を追加し、省略時 `true` とする（`src/flow-library/publicTypes.ts:104-119`）。
  - `FlowChunkWrittenInfo.operation` に `"UPSERT"` を追加する。
  - `insertedCount?` / `updatedCount?` を追加する（`src/flow-library/publicTypes.ts:154-177`）。
  - `ExecutionMetrics.nativeUpsertCalls` を追加する。`putCalls` の内数であり、すべての初期snapshotに `0` を入れる（`src/flow-library/publicTypes.ts:179-200`、`src/execute.ts:869-878`）。

- `src/flow-library/writableClient.ts`
  - `createKintoneClient` に `upsertRecords` を実装する（`src/flow-library/writableClient.ts:29-148`）。
  - `PUT /records.json` のレスポンスを返す。
  - 既存のguest space、認証、timeout、HTTP error変換を再利用する。

- `src/flow-library/index.ts`
  - `enableNativeUpsert` の省略を `true` に解決し、managed execution contextへ渡す（`src/flow-library/index.ts:109-152`）。
  - `explainScript` から `ExplainScriptOptions.enableNativeUpsert` の省略時 `true` とrouted clientの実能力を共有評価器へ渡す（`src/flow-library/index.ts:76-103`）。
  - 論理アプリroutingで、能力がある場合だけ `upsertRecords` を公開し、`app` を物理IDに置換する（`src/flow-library/index.ts:293-308`）。

- `src/cli/index.ts`
  - `--native-upsert` を実行ごとのbooleanフラグとして解析し、既定 `false` とする（引数解析の現行位置は `src/cli/index.ts:231-377`）。
  - `buildReplExecArgv` でフラグを子実行へ転送し、REPLの状態表示に反映する（`src/cli/index.ts:1270-1324`、`:1335-1344`、`:1591-1611`、`:1779-1797`）。
  - `--allow-dml`、`--yes`、`--dml-max-rows`、`--dml-max-subtable-rows`、バッチ確認、REPL確認を迂回させない。`--yes` だけでnativeを有効化しない（`src/cli/index.ts:349-366`、`:2410-2526`）。
  - `--dry-run` との組み合わせでは書込を行わず、CLI面のopt-in状態をバッチEXPLAINと単文EXPLAINの共有評価器へ渡す（`src/cli/index.ts:1062-1076`、`:2348-2354`）。
  - help、usage、未知オプション、REPL転送を担当する既存CLI契約を同期する。

- `src/cli/nodeKintoneClient.ts`
  - `createNodeKintoneClient` が返すclientに `upsertRecords` を実装する（`src/cli/nodeKintoneClient.ts:337-349`、`:457-510`）。
  - `PUT /records.json` へ `upsert: true` と `updateKey` を含むbodyを送り、`records[].id` / `revision` / `operation` を失わず返す。
  - 既存のbase URL、guest space、認証、HTTP error変換を再利用する。

- `src/execute.ts`
  - `KintoneClient` に任意のnative能力 `upsertRecords?` を追加する（`src/execute.ts:274-333`）。
  - 本実行、`previewStatement`、バッチEXPLAIN、単文EXPLAINが共有する適格性評価器とrendererをこのファイルに置く。条件式と理由文を各経路へ複製しない（本実行入口は `src/execute.ts:780-861`、previewは `:1966-2088`、バッチEXPLAINは `:12637-12796`、単文 `executeExplain` は `:13111-13169`）。
  - 素のUPSERT VALUES / SELECTにnative書込経路を追加する。
  - CHECK / APPLY / IMPORT / VALIDATE ONLY / ON ERROR SKIPを明示的に除外する。
  - 全ソースの空文字キーと重複を、native書込開始前に文単位で検査する。
  - キーを除いたpayloadを100件単位・ソース順で送り、元レコードを破壊しない。
  - native書込開始前に、現行と同じ `options.confirm(total, "UPDATE", context)` を実行する。
  - responseの検証とINSERT / UPDATE集計を行う。
  - metrics、preview write block、chunk callbackの各wrapperで能力を条件付き転送・制御する（`src/execute.ts:914-996`、`:1984-1995`、`:2114-2167`）。
  - `ExecutionMetrics.nativeUpsertCalls` を `putCalls` の内数として計上する（`src/execute.ts:869-878`、`:914-996`）。
  - previewの `estimatedWrites` を共有判定に連動させる（`src/execute.ts:2472-2481`、`:2605-2644`）。
  - `executeExplain` から共有適格性評価器とrendererを呼び、単文EXPLAINに適格性行を追加する。単文を `buildBatchExplainPlans` へ寄せず、既存の `columns: ["plan"]` と `rows`、バッチ専用見積りがない外形を維持する（`src/execute.ts:13111-13169`）。
  - `buildBatchExplainPlans` から同じ評価器とrendererを呼び、バッチEXPLAINに適格性行を追加する。既存のdialect 1 API見積り行は削除しない（`src/execute.ts:12637-12796`、`:12803-12857`）。

- `src/api/requestGate.ts`
  - 能力がある場合だけ `upsertRecords` を `runMutation` 経由で転送し、read retryの対象にしない（`src/api/requestGate.ts:164-188`）。

- `src/engine-library/readonlyClient.ts`
  - `WRITE_METHODS` に `"upsertRecords"` を追加し、readonly clientが能力を報告しないようにする（`src/engine-library/readonlyClient.ts:5-9`、`:42-83`）。

- バッチEXPLAINの各呼出元
  - `src/mcp/tools.ts`、`src/ui/batchExplain.ts`、`src/engine-library/query.ts`、`src/flow-library/index.ts`、`src/cli/index.ts` から `surface` と面ごとのnative設定を明示する。
  - MCP・プラグイン・engine-libraryは `DOCUMENT_ONLY`、`/flow` は既定ON、CLIは `--native-upsert` の有無を渡す（`src/mcp/tools.ts:705-720`、`src/ui/batchExplain.ts:17-30`、`src/engine-library/query.ts:120-136`、`src/flow-library/index.ts:76-103`、`src/cli/index.ts:2348-2354`）。
  - MCPとCLIの単文EXPLAINは既存の `executeExplain` 経路を維持する。`buildBatchExplainPlans` へ統合しない（`src/mcp/tools.ts:730-745`、`src/execute.ts:13111-13169`）。

### 変更しない Production ファイル

- `src/core/dialect1Validation.ts`
  - dialect 1の構文・schema検証は変更しない（`src/core/dialect1Validation.ts:90-128`）。
  - native適格性の `isUnique === true` 判定を既存warning規則へ混ぜない。

- `src/ui/kintoneClient.ts`
  - プラグインclientに能力メソッドを追加しない。
  - プラグインの実行は現行経路を維持する。
  - EXPLAINは `src/ui/batchExplain.ts` から文・データ条件3〜6を表示するが、実行opt-inは追加しない（`src/ui/batchExplain.ts:17-30`）。

- MCPの公開ツール入力
  - native実行opt-inを追加しない。
  - MCPの実行は現行経路を維持し、EXPLAINだけ文・データ条件3〜6を表示する（`src/mcp/tools.ts:705-745`）。

- engine-libraryの公開実行入力
  - native実行opt-inを追加しない。
  - readonly契約を維持し、EXPLAINだけ文・データ条件3〜6を表示する（`src/engine-library/query.ts:120-136`、`src/engine-library/readonlyClient.ts:42-83`）。

- 既存の `putRecords`
  - トップレベル `upsert` を混ぜず、従来の更新API契約を変更しない（`src/execute.ts:274-333`、`docs/internal/ksql_b173_native_upsert_update_key_issue.md:40-52`）。

### Tests

既存契約の担当suiteを更新し、B173の対テストを追加する。各テストは内部関数の存在ではなく、公開結果、例外、plan行、mock clientの呼出し回数・順序・bodyで判定する。

- `src/__tests__/execute.test.ts`
  - native本実行、fallback、body、順序、結果内訳、チャンク、キーのみ、ソース重複、NUMBER raw値、`options.confirm` の引数・位置・拒否時の無書込。
  - 能力なしで警告なし、schemaの5ケース、素のUPSERT限定の5ケース、空文字1件による文全体fallbackを個別ケースとして固定する。
  - native開始後のAPI error、権限エラー、不正response、callback errorで現行経路へ再試行しないこと。

- `src/__tests__/b95MetricsPropagation.test.ts`
  - native 1リクエストで `putCalls` と `nativeUpsertCalls` が1ずつ増え、`postCalls` は増えないこと。
  - rejectと後段callback errorでも減算せず、`nativeUpsertCalls <= putCalls` を保つこと。
  - 既存snapshotの `nativeUpsertCalls: 0` と伝播を固定する。

- `src/__tests__/explain.test.ts`
  - 共有rendererの `ELIGIBLE` / `INELIGIBLE` / `UNKNOWN`、条件番号順、既知falseの優先、条件3〜6の別表示を固定する。
  - 単文 `executeExplain` に適格性行を追加しつつ、既存の `columns: ["plan"]`、`rows`、SELECT payload、バッチ専用見積りがない外形を維持する。
  - バッチ `buildBatchExplainPlans` の既存API見積り行を維持し、適格性行だけを追加する。
  - metadata・ソース不足を `UNKNOWN` とし、EXPLAINのためのAPI呼出しを増やさない。

- `src/flow-library/__tests__/previewStatement.test.ts`
  - native適格時と現行経路時の条件付き `estimatedWrites`、既存のread、counts、before/after、samples、write blockを固定する。

- `src/flow-library/__tests__/publicApi.test.ts`
  - `/flow` の省略時既定ON、明示 `true`、明示 `false` opt-out、公開結果、`ExplainScriptOptions.enableNativeUpsert`、`onChunkWritten` の新しい値を固定する。

- `src/flow-library/__tests__/b170FlowRequests.test.ts`
  - 同梱 `/flow` clientのURL、method、body、response、guest space、HTTP errorを固定する。

- `src/cli/__tests__/index.test.ts`
- `src/cli/__tests__/dml_guard.e2e.test.ts`
- `src/cli/__tests__/console.e2e.test.ts`
  - `--native-upsert` の既定OFF、引数解析、help、REPL転送と状態表示を固定する。
  - `--allow-dml`、`--yes`、`--dml-max-rows`、バッチ確認、REPL確認を迂回しないことを固定する。
  - `--dry-run` との組み合わせでは書込0回で、フラグ有無をEXPLAIN表示へ反映すること。
  - CLIのバッチEXPLAINとSQLの単文EXPLAINの双方で、面依存条件1・2と文・データ条件3〜6を仕様どおり表示すること。

- `src/cli/__tests__/nodeKintoneClient.test.ts`
  - CLI clientのnative URL、method、body、response、guest space、HTTP error、`records[].operation` 保持を固定する。

- `src/mcp/__tests__/tools.test.ts`
  - MCPの単文EXPLAINが既存SELECT payloadを維持し、条件3〜6の適格性行を追加すること。
  - バッチ形やバッチ専用書込見積りへ変わらず、native実行opt-inを公開しないこと。

- プラグインとengine-libraryのEXPLAIN担当suite
  - MCP・プラグイン・engine-libraryで条件1・2を対象外とし、条件3〜6を `ELIGIBLE` / `INELIGIBLE` / `UNKNOWN` として表示すること。
  - 条件3〜6の不適格理由が面依存理由に隠れず、既存SELECT等のplanが変わらないこと。

- `src/api/__tests__/requestGate.test.ts`
  - native writeがmutation gateを通り、リトライされないこと。
  - 能力なしclientに `upsertRecords` propertyを追加しないこと。

- `src/engine-library/__tests__/readonlyProjection.test.ts`
- `src/engine-library/__tests__/readonlyBypass.test.ts`
- `src/engine-library/__tests__/readonlyNegativeMatrix.test.ts`
  - readonly clientがnative能力を報告せず、直接呼出しも拒否すること。

必要なら、上記を横断する `/flow` 統合ケースを `src/flow-library/__tests__/b173NativeUpsert.test.ts` に新設する。

## 14. リリース付随作業

### 14.1 `CHANGELOG.md` 文面案

B171の「※結果が変わります」の前例は `CHANGELOG.md:6-28` にある。B173では成功時のレコード内容は同じであり、観測値と部分失敗時の状態が変わるため、次のように書き分ける。

```md
### 改善（B173: UPSERT を kintone native UPSERT へ）**※ `/flow` の UPSERT は挙動が変わります**

`/flow` の適格な素の `UPSERT VALUES` / `UPSERT SELECT` は、アップグレード後、
既定で kintone の `updateKey` + `upsert: true` を使います。成功時のレコード内容と
`insertedCount` / `updatedCount` は従来と同じです。

一方、書込順、部分失敗時に確定している範囲、`onChunkWritten.operation`、
`ExecutionMetrics` の API 回数内訳、preview の `estimatedWrites` が変わります。

従来経路へ戻す場合は、`createExecutionContext` に
`enableNativeUpsert: false` を指定してください。native の利用には対象アプリの
レコード追加権限が必要です。

CLI は既定 OFF のままです。`--allow-dml --native-upsert` を指定した実行だけが
同じ native 経路を使用します。
```

リリース版数は実装時点で決定するため要確認。

### 14.2 依頼元ksql-flowへの通知

リリース前または遅くともリリースと同時に、依頼元へ次を通知する。

- B173を含むリリース版数。
- 成功時のレコード内容と件数結果は同じであること。
- アップグレードで変わる5点:
  - 書込順
  - 部分失敗時に確定している範囲
  - `onChunkWritten.operation === "UPSERT"` と内訳property
  - `postCalls === 0`、`putCalls` への集約、`nativeUpsertCalls` が内数
  - `estimatedWrites` の算出式
- 依頼元の追随作業:
  - 推定式7.2 / 10.2
  - 公開仕様§3.4
  - 内訳取得元の `records[].operation` への切替
- これらの期限が「nativeを有効化した時」から「B173版へアップグレードした時」へ前倒しになること。
- アップグレード前にAPIトークンのレコード追加権限を確認すること。
- opt-outは `enableNativeUpsert: false` であること。
- 先にCLIの `--allow-dml --native-upsert` で同じSQLをリハーサルできること。
- 比較測定は、まず `/flow` を `enableNativeUpsert: false` にして現行経路の基準値を取り、その後falseを外してnativeを測れること。

## 15. 受入条件

注: 現在のR3ファイルは§12から§15へ飛んでおり、AC本文が欠落している。レビュー記録から確認できる既存番号はAC-1とAC-18である。以下はR3本文の規範をAC-1〜AC-18へ復元し、今回の新規条件をAC-19以降へ追加したものとする。AC-2〜AC-17のR2原文との逐語的対応は要確認だが、規範内容を弱めてはならない。

### AC-1 `/flow` 省略時のnative実行

能力を持つ同梱 `/flow` clientで `enableNativeUpsert` を省略し、条件3〜6を満たす素のUPSERTを実行すると、事前GET、`postRecords`、通常の `putRecords` を呼ばず、`upsertRecords` をソース順の100件チャンクで呼ぶ。

### AC-2 6条件と判定順序

本実行とpreviewは条件1〜6を固定順で評価し、1つでも不成立または判定不能なら文全体を現行経路へ戻す。EXPLAINは既知のfalseをUNKNOWNより優先し、複数falseでは最初の条件を表示する。

R2で個別に固定されていた次のケースも、条件1〜6の受入条件として復元する。

- **能力なし**: `enableNativeUpsert: true` でもclientに `upsertRecords` がなければ、現行経路と同じ呼出し回数、順序、body、結果になる。能力不足を示すエラーや警告は出さない。
- **schemaのfail-closed**: 次の各ケースで `upsertRecords` は0回となり、現行経路を使う。
  - 複合キー。
  - `fieldType` が対応外。
  - キーフィールドがschemaにない。
  - `isUnique === false`。
  - `isUnique === undefined`。
- **素のUPSERT限定**: 次の各ケースで `upsertRecords` は0回となる。
  - dialect 1のCHECK付きUPSERT。
  - APPLY UPSERT。
  - VALIDATE ONLY。
  - ON ERROR SKIP。
  - IMPORT由来のUPSERT SELECT。
  - 各ケースの既存公開結果または既存エラーは変わらない。
- **空文字**: ソース内にキー `""` が1件でもあれば、文全体で `upsertRecords` は0回となる。現行対象GETを実行し、残りの非空行も含めて現行経路で処理する。B173が新しい `CB_VA01` を発生させない。

### AC-3 現行経路の完全維持

次の実行では、結果、GET / POST / PUT回数、API body、書込順、エラー、`onChunkWritten`、previewをB173前と同じにする。

- `/flow` の `enableNativeUpsert: false`
- フラグなしCLI
- MCP
- プラグイン
- 能力なしclient
- 条件1〜6の不成立または判定不能
- CHECK / APPLY / IMPORT / VALIDATE ONLY / ON ERROR SKIP

### AC-4 nativeペイロード

各行の `updateKey.field` と文字列の `updateKey.value` を正しく構成し、キーフィールドを送信用 `record` から除外し、トップレベル `upsert: true` を付ける。元レコードを破壊しない。

### AC-5 キーのみUPSERT

キー以外の書込フィールドがない場合も `record: {}` を送り、INSERT / UPDATEの両方を成功させる。

### AC-6 NUMBERキー

NUMBERキーはJavaScript numberへ変換せずraw文字列で送る。exact-decimal正規化で `"5"` と `"5.0"` を重複として扱い、安全整数超えの値を丸めない。

### AC-7 ソース重複fallback

同一キーが同一チャンク内または100件境界をまたいで存在する場合、native APIを0回とし、文全体を現行経路へ戻す。

### AC-8 チャンクと結果内訳

101行では100件、1件の順に2回native APIを呼び、全レスポンスの `records[].operation` から `insertedCount` / `updatedCount` を集計する。revisionから推測しない。

### AC-9 不正レスポンス

件数不一致、配列以外、不正operation、非文字列id/revisionを `NativeUpsertResponseError` とし、現行経路へ再試行しない。

### AC-10 ラッパーの能力保持

metrics、request gate、routing、preview write block、chunk callback、readonly、search abort、cursor scopeの各ラッパーで、能力ありclientだけが `upsertRecords` を保持する。能力なしclientへpropertyを追加しない。

### AC-11 preview

previewはnative適格でも書込APIを0回とし、既存GET、counts、before/after、samples、readsを維持する。native適格時だけ `estimatedWrites = ceil(total / 100)` とする。

### AC-12 `onChunkWritten`

nativeの成功リクエスト1回につき通知1回とし、`operation: "UPSERT"`、リクエスト件数、両内訳、最後のキー、0始まりchunk indexを返す。INSERT/UPDATE別通知へ分割しない。

### AC-13 metrics

native呼出しごとに `putCalls` と `nativeUpsertCalls` を1ずつ増やし、`postCalls` は増やさない。rejectや後段callback失敗でも減算せず、常に `nativeUpsertCalls <= putCalls` を満たす。

### AC-14 エラーとfallback禁止

native開始後のAPI error、権限エラー、レスポンスエラー、callback errorで現行経路へfallbackしない。権限エラーだけを特別扱いした自動fallbackも行わない。

### AC-15 CLI安全ゲート

`--native-upsert` は `--allow-dml`、`--yes`、件数ガード、バッチ確認、REPL確認を迂回しない。フラグなしでは現行経路を維持する。

### AC-16 EXPLAINの3状態と追加API禁止

本実行、preview、バッチEXPLAIN、単文EXPLAINが同じ評価器を共有する。EXPLAINは `ELIGIBLE` / `INELIGIBLE` / `UNKNOWN` を使い、metadataまたはソース不足を不適格と誤表示せず、判定のためのAPI呼出しを増やさない。

### AC-17 非opt-in面の文・データ評価

MCP・プラグイン・engine-libraryでは条件1・2を対象外とし、条件3〜6を評価する。条件3〜6適格なら `/flow` またはopt-in CLIでnative候補と表示し、条件3〜6不適格ならどの面でもnativeにならない理由を表示する。

### AC-18 `options.confirm`

native適格な1件以上の文では最初のnative書込直前に `options.confirm(total, "UPDATE", context)` を1回だけ呼ぶ。拒否時は `OperationCancelledError("UPDATE", total)` とし、全書込APIと `onChunkWritten` を0回にする。0件では呼ばない。

### AC-19 `/flow` の明示opt-out

能力を持つ同梱 `/flow` clientでも `enableNativeUpsert: false` を指定すると、条件3〜6が適格であってもnative APIを0回とし、結果、API呼出し回数、書込順、body、エラーを現行経路と同一にする。

### AC-20 CLIの既定OFF

CLI同梱clientが能力を持っていても、`--native-upsert` を省略した実行はnative APIを0回とする。`--allow-dml` または `--yes` だけでnativeを有効化しない。

### AC-21 面別EXPLAIN既定

`/flow` の `explainScript` は `enableNativeUpsert` 省略時にONとして予測し、CLIはフラグ有無を反映する。MCP・プラグイン・engine-libraryは文・データ評価として条件1・2を対象外にする。

### AC-22 単文EXPLAIN経路維持

MCPとCLIの単文EXPLAINは `executeExplain` から共有評価器とrendererを呼ぶ。`buildBatchExplainPlans` へ統合せず、既存SELECTペイロードと単文出力形を維持する。バッチ専用の書込見積りを単文へ追加しない。

### AC-23 アップグレード互換通知

CHANGELOGと依頼元通知に、成功時のレコード内容は同じであること、変わる5点、権限要件、opt-out方法、CLIリハーサル方法を含める。

### AC-24 権限運用手順

リリース前文書に、`/flow` が使用するAPIトークンについて対象アプリのレコード追加権限をアップグレード前に確認する手順を含める。CLIによる確認を補助と位置付け、権限確認の代替とは記載しない。

## 16. Claudeが実機で確かめるべき未確認事項

次は仕様の採否条件ではない。実装レビューまたはリリース前に実機で確認し、レビュー記録またはリリース記録へ残す。

1. `/flow` 実クライアント経由のerror message

   `src/flow-library/writableClient.ts` の `upsertRecords` を通して `GAIA_IQ28` / `CB_VA01` を発生させ、公開されるトップレベルmessageを記録する。

2. CLI実クライアント経由の成功レスポンスとerror message

   INSERT / UPDATE混在リクエストで次を確認する。

   - `records[]` がリクエスト順で返る。
   - `id` / `revision` / `operation` が失われない。
   - `GAIA_IQ28` / `CB_VA01` のcodeとmessageが保持される。
   - CLIのexit codeとstderrが既存policyに従う。

3. CLIによる事前リハーサル

   `/flow` 本番と同じAPIトークンを指すCLI profileを使い、`--allow-dml --native-upsert` で同じdialect 1ジョブSQLを実行する。

   - native経路で成功する。
   - 事前GETが発生しない。
   - INSERT / UPDATE件数が一致する。
   - `--native-upsert` を外すと現行経路へ戻る。

4. レコード追加権限なしの全件UPDATE

   編集権限だけを持つトークンで、既存キーだけのnative UPSERTが権限エラーになることを確認する。

   - `/flow` とCLIの双方でcode / messageを記録する。
   - 1チャンク目が書込ゼロで失敗することを確認する。
   - 自動fallbackが発生しないことを確認する。
   - `enableNativeUpsert: false` またはフラグなしCLIでは現行経路が従来どおり成功することを確認する。

5. `/flow` 既定ONとopt-out

   同じSQLと同梱clientについて次を確認する。

   - `enableNativeUpsert` 省略時にnativeになる。
   - `enableNativeUpsert: true` でも同じ。
   - `enableNativeUpsert: false` で現行経路へ戻る。
   - 成功時のレコード内容と件数結果が両経路で一致する。
   - 5つの観測差が仕様どおりである。

6. CLIの確認実経路

   - `--yes` なしで確認拒否した場合、native APIが0回。
   - `--yes` ありでは確認プロンプトなしで実行される。
   - `--dml-max-rows` 超過では書込0回。
   - バッチは全体確認1回で、文ごとの件数ガードが残る。
   - REPLは `native-upsert=on` を表示し、子実行へフラグを転送する。

7. guest space

   guest space内アプリで `/flow` clientとCLI clientのnative UPSERTが既存 `apiBase` routingと同じURLへ送られ、responseを取得できることを確認する。

8. CLI dry-runと本実行の表示整合

   - 完全オフラインdry-runではmetadata / source不足を `UNKNOWN` と表示する。
   - metadataが利用できるEXPLAINでは条件3を確定する。
   - `UPSERT SELECT` の未materialize条件5・6は `UNKNOWN`。
   - 本実行では全材料が揃った後、共有判定どおりnativeまたはfallbackを選ぶ。
   - `UNKNOWN` を `INELIGIBLE` と誤表示しない。

9. 5面のEXPLAIN到達性

   同じUPSERTをCLI、MCP、プラグイン、engine-library、`/flow` の各EXPLAINから通す。

   - `/flow` は省略時ONとして6条件を表示する。
   - CLIはフラグ有無を反映し、フラグなしでも条件3〜6を別表示する。
   - MCP・プラグイン・engine-libraryは条件1・2を対象外とし、条件3〜6を表示する。
   - 条件6不適格が面依存理由で隠れない。
   - 条件3〜6適格なら `/flow` / opt-in CLIでnative候補と表示する。

10. 単文EXPLAINの外形

    MCPとCLIの単文 `EXPLAIN UPSERT` について次を確認する。

    - 適格性行が追加される。
    - MCPは既存のSELECTペイロードを維持する。
    - バッチ形へ変わらない。
    - 既存バッチ専用書込見積りが単文へ混入しない。
    - バッチと単文の適格性状態・理由文が同じ共有rendererから生成される。

11. 依頼元アップグレードリハーサル

    ksql-flowについて、`enableNativeUpsert: false` で現行基準値を取り、falseを外してnativeを測定する。

    - 推定式7.2 / 10.2
    - 公開仕様§3.4
    - `records[].operation` による内訳
    - `onChunkWritten.operation === "UPSERT"`
    - metricsの変化
    - 部分失敗時のprefix

    追随作業がB173版へのアップグレード前または同時に完了していることを確認する。

上記以外の能力保持、request gate、readonly、論理アプリrouting、重複fallback、NUMBER raw body、preview write block、metricsの内数、`options.confirm` の引数はmock / integration testで決着でき、実機確認を必須としない。
---

## 17. レビュー記録

レビュー: Claude（[[spec-and-impl-by-codex]]＝codex が仕様と実装、Claude がレビュー・実測・リリース）。

### 17.1 版ごとの経緯

| 版 | 内容 | レビュー指摘 |
|---|---|---|
| R1 | 初版（案 C・適用条件 6 つ・ラッパー方針・エラー方針） | **[Major] `options.confirm` の欠落**＋軽微 2 件 |
| R2 | R1 の指摘を反映。実機測定 5 項目を本文へ取り込み | — |
| R3 | **オーナー指摘 3 件**（CLI opt-in・metrics カウンタ・EXPLAIN 可視化）を反映 | **[Major] 非 opt-in 面で常に `INELIGIBLE`／[Major] 単文 EXPLAIN の経路統合がスコープ過大**＋軽微 2 件 |
| R4 | R3 の指摘 4 件と**オーナー決定「`/flow` の既定 ON」**を反映 | **[Major] R2 の列挙型 AC と変更ファイル一覧の欠落**（R3 の出力欠落に起因） |
| **R5** | **復元（列挙型 AC・変更するファイル）** | **指摘なし。確定。** |

### 17.2 R1 の指摘（R2 で反映済み）

**[Major] `options.confirm` の欠落** — 現行は書込直前に確認コールバックを呼び拒否時に `OperationCancelledError` を投げる（`src/execute.ts:10571-10576`・`:11201-11206`）が、R1 の native 書込ループにその段が無く、受入条件にも `confirm` が 0 件だった。当時は opt-in が `/flow` 限定で到達面が無かったが、**R3 で CLI が opt-in 面になり実動化した**。R1 のまま実装していれば、CLI へ広げた瞬間に確認なしで書く経路ができていた。

### 17.3 R3 の指摘（R4 で反映済み）

- **[Major] 非 opt-in 面で常に `INELIGIBLE` になり可視化の目的を達しない** → **面依存条件（1・2）と文・データ依存条件（3〜6）に分割**。非実行面では `execution surface: NOT_APPLICABLE` + `statement/data eligibility` の 2 行。**`--native-upsert` なしの CLI でも文・データ判定を隠さない**（指摘していなかった同型ケースまで自発的に拾った）
- **[Major] MCP 単文 EXPLAIN の経路統合はスコープ過大** → **統合しない。共有するのは適格性評価器と renderer だけ**とし `executeExplain` から呼ぶ。**既存の非対称（書込見積りが単文 EXPLAIN に出ない）は B173 の範囲外として維持**
- [Minor] §12 の既定反転の想定／既定の理由を**公開 API の契約**へ書き換え
- [Minor] プラグイン対象外の理由を差し替え＋**権限は運用手順で担保**を明記

### 17.4 R4 の指摘（R5 で復元済み）— **原因はこちらの見落とし**

**R3 の出力が `## 13`（変更するファイル）と `## 14`（受入条件）を丸ごと落としており、Claude がそれに気づかずコミットした**（`10402c4`）。R4 は AC を再構成したが R2 の列挙が復元されず、変更ファイル一覧は R4 にも無いままだった。

**R5 で確認した復元結果**:

| 復元対象 | 結果 |
|---|---|
| **能力なし** | AC-2 に復元（`upsertRecords` が無ければ現行経路・**能力不足を示すエラーや警告を出さない**） |
| **schema の fail-closed** | AC-2 に 5 ケース復元（複合キー／`fieldType` 対応外／キーが schema に無い／`isUnique === false`／**`isUnique === undefined`**） |
| **素の UPSERT 限定** | AC-2 に 5 ケース復元（**dialect 1 の CHECK 付き UPSERT**／APPLY UPSERT／VALIDATE ONLY／ON ERROR SKIP／**IMPORT 由来の UPSERT SELECT**） |
| **空文字** | AC-2 に復元（1 件でも文全体で 0 回・現行 GET を実行・非空行も現行経路・**新しい `CB_VA01` を発生させない**） |
| **変更するファイル** | **§13 として復元**（Production 8 / 変更しない 2 / Tests）。R3・R4 の増分（CLI の引数解析と REPL 転送・`nodeKintoneClient`・適格性評価器と renderer・`executeExplain`・`nativeUpsertCalls`・`ExplainScriptOptions`）を含む |

**とくに落としてはいけなかった 2 ケースが復元されていることを確認した**＝**「dialect 1 の CHECK 付き UPSERT」**（起票文書 §2.5 ①＝dialect 1 でも CHECK は構文上受理されるので方言を根拠に素の UPSERT と仮定してはならない）と**「`isUnique === undefined`」**（同 §2 の 4＝BYO schema resolver が省略し得るので曖昧な schema を許可しない）。

**§13 Tests が挙げるテストファイル 10 件はすべて実在を確認済み**（`b95MetricsPropagation` / `explain` / `cli/index` / `cli/nodeKintoneClient` / `cli/dml_guard.e2e` / `cli/console.e2e` / `engine-library/readonlyProjection` / `engine-library/readonlyBypass` / `flow-library/publicApi` / `api/requestGate`）。

### 17.5 確定

**R5 で指摘なし。実装着手可。** AC は R4 の AC-1〜AC-24 体系で確定（R2 の番号へは戻さない。R2 原文は `git show 7d77f32:docs/internal/ksql_b173_native_upsert_spec.md`）。

**実装依頼で codex へ渡すもの**＝この仕様 R5 の全文／起票文書 §2.5（依頼元回答＝レビュー対象外）・§3.2（実機測定）・§7（オーサリング面の論点と既定 ON の決定）／**受入は公開結果で観測する形にすること**（結果オブジェクト・送出される例外・mock client の API 呼び出し回数と順序と body。内部関数名を受入条件に書かない）。

**リリース時に忘れないこと**＝§14.1 の CHANGELOG 文面（**成功時の結果は同じ／変わるのは書込順・部分失敗時の確定範囲・`onChunkWritten.operation`・API 回数内訳・`estimatedWrites`**）と §14.2 の依頼元通知（**追随作業の期限が「有効化時」から「アップグレード時」へ前倒しになる**）。

### 17.6 実装フェーズ 2 のレビュー — read-only ガードの開通を戻した（2026-08-25）

**codex はフェーズ 2 で `src/engine-library/statementGuard.ts` の `prepareExplainQuerySql` を変更し、`EXPLAIN UPSERT` / `EXPLAIN UPSERT_SELECT` だけを read-only ガードの対象外にした**（`guardRunBatchSql` は無傷で、影響は explain 経路に閉じていた）。**AC-17 / AC-21 を満たすためであり、codex は「要確認」として正直に報告している。**

#### 争点

| | 主張 |
|---|---|
| Claude | fail-closed の境界を表示要件のために緩めている／read-only 契約が不整合になる／誰も必要としていない／**AC-17・21 は engine-library に適用されず拒否で満たせるのでは** |
| codex（方針レビュー） | **「AC-17 は engine-library を名指しで表示要求しており、拒否では満たせない」＝ Claude の 4 点目は誤り。** ただし **B89 の「`explainQuery` と `runBatch` の受理集合一致」に明白な例外を作っている**ので、案 2（維持）を採るなら B89・B66・公開文書・負のマトリクスの 4 つを例外契約へ書き換えること。**「コードは維持、旧不変条件は放置」は不可** |

#### 決着 — **案 1（戻す）+ 仕様の訂正**

**codex の指摘（4 点目は誤り）は R5 の文言に照らして正しい。しかし R5 がそう書いてあるのは Claude の誤りだった**＝R3 の依頼で「非 opt-in 面（MCP・プラグイン・engine-library）」と書き、**`buildBatchExplainPlans` を共有する 5 面という実装上の事実から、可視化が要る面を過度に一般化した**。

**そして codex 自身が、Claude の弱い根拠（テスト名）より強い根拠を掘り当てていた**＝**B89 §6b が `EXPLAIN UPSERT` を名指しで拒否対象に挙げ、§4 が受理集合一致を「本仕様の中核」としている**。

→ **codex が挙げた「判断を覆す条件」の 1 番目（R5 を改訂して engine-library を除外する）を適用**し、案 1 を採る。**冒頭の規範的訂正がその改訂。**

#### 実施した内容

| 対象 | 内容 |
|---|---|
| `src/engine-library/statementGuard.ts` | **revert**（ガードは元のまま） |
| `src/engine-library/__tests__/b89ExplainBatch.test.ts` | 新規 2 テストを置換＝**`EXPLAIN UPSERT` / `EXPLAIN UPSERT SELECT` が `explainQuery` / `runBatch` の両経路で `READ_ONLY_VIOLATION` になり API 呼び出しが 0 回**であることを固定 |
| `src/engine-library/__tests__/readonlyNegativeMatrix.test.ts` | 列に `EXPLAIN UPSERT` / `EXPLAIN UPSERT SELECT` を追加し、**「EXPLAIN non-read is rejected」という既存の不変条件を B89 §6b が求めていた形へ強めた**（従来は `EXPLAIN UPDATE` と `EXPLAIN IMPORT` だけだった） |
| 仕様 | 冒頭に規範的訂正。対象面を **MCP・プラグイン・CLI** に改める |

#### 学び

**「共通の実装を持つ面」と「要件が及ぶ面」は別物。** `buildBatchExplainPlans` を 5 面が共有しているのは実装の都合であって、5 面すべてに同じ要件が及ぶ理由にはならない。**要件は目的から導く**（ここでは「`/flow` ジョブをオーサリング・検証する面」）。

**また、下流へ「決まっていること」として渡す前提は、[B141](ksql_b141_doc_sql_unverified_issue.md) の 6 回目と同じ形で誤りを増幅する。** 今回も Claude が依頼文へ書いた面の一覧が、そのまま仕様の AC と実装（ガードの開通）に焼き付いた。**面の一覧のような「何に適用するか」の指定は、渡す前に既存の契約（ここでは B89）と突き合わせる。**
