# B173 native UPSERT（`updateKey` + `upsert: true`）仕様 R3

- 状態: 仕様 R3。実装未着手。この仕様作成セッションではコード、文書、git 状態を変更していない。
- 対象:
  - `/flow` の素の `UPSERT VALUES` / `UPSERT SELECT` 本実行、および同じ実行条件を反映する `previewStatement`。
  - CLI の実行ごとの明示 opt-in による同じ native UPSERT 経路。
  - CLI、MCP、プラグイン、engine-library、`/flow` が共有する EXPLAIN の native 適格性表示。
- 前提:
  - 案 C「能力検出付きの opt-in・素の UPSERT 限定」を維持する。既定は OFF。
  - opt-in を公開する面は `/flow` と CLI の2面とする。
  - CLI の opt-in は実行ごとの明示フラグだけとし、`ksql.config.json`、環境変数、プロファイル設定には追加しない。
  - プラグインと MCP には実行 opt-in を追加しない。
  - `putRecords` は変更せず、任意の能力メソッド `upsertRecords?` を純加法で追加する。
  - 能力メソッドを実装する同梱クライアントは `src/flow-library/writableClient.ts` と `src/cli/nodeKintoneClient.ts` の2面とする。
  - native UPSERT はアプリのレコード追加権限を追加で要求するため、既定 ON にはしない。
  - `onChunkWritten` は native の1リクエストにつき1回通知し、INSERT/UPDATE に分割しない。
  - CHECK / APPLY / IMPORT / VALIDATE ONLY / ON ERROR SKIP の各書込経路は変更しない。
  - 実機測定結果は `docs/internal/ksql_b173_native_upsert_update_key_issue.md:132-149` および同文書 §3.2 を採用し、再導出しない。
  - B173 の tracker 状態と対象は `docs/ksql_issue_tracker.md:42` を正とする。

## R2 からの変更点

- opt-in の公開範囲を `/flow` 限定から `/flow` と CLI に変更した。
- CLI の明示フラグ名を `--native-upsert` とした。フラグは `--allow-dml`、`--yes`、`--dry-run` とは独立して扱い、既存の DML 許可・件数ガード・確認を迂回しない。
- `--native-upsert` は REPL 起動時にも指定でき、その REPL セッション内の子実行へ `buildReplExecArgv` が明示的に転送する。セッション表示にも ON/OFF を出す。
- CLI の `src/cli/nodeKintoneClient.ts` に `upsertRecords` を追加する。プラグインと MCP のクライアントには追加しない。
- R2 で追加した `options.confirm` 契約を、将来の保険ではなく CLI の実動経路で必ず満たす契約へ改めた。
- `ExecutionMetrics` に `nativeUpsertCalls` を純加法で追加する。各 native 呼出しは従来どおり `putCalls` にも計上し、`nativeUpsertCalls` は `putCalls` の内数とする。
- `FlowUpsertResult` には引き続き native/fallback の別を露出させない。
- native 適格性判定を本実行・`previewStatement`・EXPLAIN の3者で共有する。
- EXPLAIN に `ELIGIBLE`、`INELIGIBLE`、`UNKNOWN` の3状態を追加する。判定材料がない場合を不適格と表示しない。
- `ExplainScriptOptions` に `enableNativeUpsert?: boolean` を純加法で追加する。
- MCP の単文 EXPLAIN も共通バッチ計画を通す。単文の既存レスポンス形は維持し、共通計画の1文目から従来の単文 plan を構成する。
- `resolveMetadata: false`、CLI の完全オフライン dry-run、`UPSERT SELECT` の未 materialize ソースについて、判定不能となる条件を明文化した。
- 適格性判定のためだけの追加 API 呼出しは禁止した。EXPLAIN は既に取得済みの metadata だけを再利用する。

## 1. 目的

現行の素の UPSERT は、キーによる事前 GET で既存レコードを解決し、その後に新規行を POST、既存行を PUT する。`UPSERT VALUES` の現行処理は `src/execute.ts:10538-10588`、`UPSERT SELECT` は `src/execute.ts:11161-11218` にある。

B173 は、明示的に opt-in され、かつ安全に適用できる文だけを、kintone の次の native UPSERT に置き換える。

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

1. 既存判定のための事前 GET をなくす。
2. `/flow` と、本番と同じ API トークンを指定できる CLI で同じ書込経路を実行可能にする。
3. EXPLAIN で、native になるか、ならないか、現時点では決められないかを実行前に確認可能にする。

プラグインはセッション認証であり、本番 API トークンの権限差を原理的に再現できない。MCP はツール入力を LLM が構成するため、追加権限を要求する opt-in を裁量に開放しない。CLI はプロファイル認証で本番トークンを指定でき、同じ dialect 1 ジョブ SQL をスクリプトや CI から実行できるため、権限差を含むリハーサル面とする（`docs/internal/ksql_b173_native_upsert_update_key_issue.md:243-294`）。

opt-in されていない実行、および適用条件を一つでも満たさない実行は、現在の read-then-write 経路をそのまま使用する。

## 2. 非対象

次は B173 の native 書込対象外とし、既存経路、結果、検証、API 順序を変更しない。

- `CHECK` 付き UPSERT
- `APPLY UPSERT`
- `VALIDATE ONLY`
- `ON ERROR SKIP`
- `IMPORT` が内部生成する `UPSERT SELECT`
- `previewStatement` の既存値読取、差分、件数、サンプル
- プラグインの `src/ui/kintoneClient.ts`
- MCP の実行クライアントとツール入力
- engine-library の read-only 実行
- dialect 1 の構文・静的検証規則
- `putRecords` の入力型と `Promise<void>` の戻り値
- `ksql.config.json`、環境変数、プロファイル単位の native opt-in
- `FlowUpsertResult` への経路情報追加

事前 GET は CHECK 系では検証モードの決定、APPLY では既存値、IMPORT では既存サブテーブルと revision の取得にも使われているため、native へ置換できない（`docs/internal/ksql_b173_native_upsert_update_key_issue.md:23-38`）。dialect 1 の検証も現行のままとする（`src/core/dialect1Validation.ts:90-128`）。

EXPLAIN の適格性表示は非対象ではない。MCP・プラグイン・engine-library は native を実行しないが、共通 EXPLAIN による判定の可視性は提供する。

## 3. 公開型と公開オプション

### 3.1 `FlowKintoneClient`

現行の `FlowKintoneClient.putRecords` は ID 指定更新だけを受け、戻り値を返さない（`src/flow-library/publicTypes.ts:53-81`）。

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

古いクライアント、自前クライアント、プラグインクライアント、MCP の能力なしクライアントは、このメソッドを実装しなければ現在の経路を使い続ける。

### 3.2 `/flow` の opt-in

`CreateExecutionContextOptions` に次を追加する。

```ts
export interface CreateExecutionContextOptions extends ParseScriptOptions {
  client: FlowKintoneClient;

  /**
   * 素の UPSERT で kintone native UPSERT の利用を許可する。
   * 省略時および false は現行経路。既定 false。
   */
  enableNativeUpsert?: boolean;
}
```

`createExecutionContext` は公開 options から managed execution context を構成し、execute と preview の双方に同じ context を渡している（`src/flow-library/index.ts:109-152`）。B173 でも同一の opt-in 値を本実行と preview から参照する。

従来の単文・バッチ core APIの公開 `ExecuteOptions` へ一般利用者向け opt-in は追加しない。CLI と `/flow` から core へ渡す値は、公開 barrel に出さない内部オプションまたは同等の private plumbing とする。これにより、MCP・プラグイン・engine-library が同名プロパティを任意に設定できる公開契約を作らない。

### 3.3 CLI の opt-in

CLI のフラグ名は次とする。

```text
--native-upsert
```

意味は「この CLI 実行コンテキスト内の適格な素の UPSERT に native 経路を許可する」である。

次を契約とする。

- 既定は OFF。
- boolean flag とし、値は取らない。
- `ksql.config.json` には同等項目を追加しない。
- `KSQL_NATIVE_UPSERT` などの環境変数を追加しない。
- プロファイルから暗黙に有効化しない。
- 同一スクリプト内に複数の UPSERT がある場合、フラグは各文へ同じ値で適用され、各文が独立して6条件を判定する。
- UPSERT を含まない入力で指定してもエラーにはせず、実行結果に影響しない。

CLI の既存 DML 安全ゲートとは独立させる。

- `--native-upsert` 単独では DML を許可しない。
- 本実行・dry-run とも、UPSERT には従来どおり `--allow-dml` が必要である（`src/cli/index.ts:2059-2077`）。
- `--yes` は確認プロンプトを省略するだけで、native opt-in を有効化しない。
- `--native-upsert` は `--allow-without-where`、`--dml-max-rows`、`--dml-max-subtable-rows` の意味を変更しない。
- `--native-upsert` は CHECK / APPLY / IMPORT / VALIDATE ONLY / ON ERROR SKIP を native 対象に変えない。

CLI は現在、`--allow-dml` と `--yes` を別々に解析し（`src/cli/index.ts:349-366`）、DML の許可判定後に `confirm` を実行へ渡す（`src/cli/index.ts:2410-2526`）。`--native-upsert` も独立した `ParsedArgs` boolean として追加する。

### 3.4 REPL

`ksql --console --native-upsert` は許可する。

この場合の「実行ごと」は、REPL の各内部子プロセスではなく、利用者が明示的に開始した REPL セッションを単位とする。

- `buildReplExecArgv` は `base.nativeUpsert === true` の場合、子実行 argv に `--native-upsert` を追加する。
- `:run`、通常実行、`:rerun` のすべてで同じ値を転送する。
- REPL の `session:` 表示と設定表示に `native-upsert=on|off` を追加し、セッション中に有効であることを隠さない。
- REPL 側で DML 確認済みの子実行に `--yes` と `--allow-dml` を付ける現行契約は維持する（`src/cli/index.ts:1270-1324`）。
- native のためだけの別確認を追加しない。
- REPL の通常 DML 確認を拒否した場合、子実行自体を開始せず、native API も呼ばない（`src/cli/index.ts:1591-1611`、`src/cli/index.ts:1779-1797`）。

### 3.5 `--dry-run`

`--native-upsert --dry-run` は許可する。

意味は native 実行ではなく、native を有効にした本実行を想定した適格性の予測である。

- 書込 API は呼ばない。
- `upsertRecords` は呼ばない。
- `options.confirm` と対話確認は行わない。
- UPSERT には従来どおり `--allow-dml` を要求する。
- `--yes` の有無は dry-run の結果へ影響しない。
- `--native-upsert` は EXPLAIN 判定の条件2を true として渡す。
- dry-run 用 client 自体に `upsertRecords` は追加しない。

`createDryRunClient` は現在9メソッドを明示列挙し、すべて例外を投げる（`src/cli/index.ts:1062-1076`）。この列挙へ `upsertRecords` を追加しない。したがって dry-run が native 書込経路へ入ることは構造的にない。

EXPLAIN の条件1は「dry-run client にメソッドがあるか」ではなく、「予測対象である通常の CLI client が native 能力を持つか」を入力として受け取る。CLI 同梱 client は能力あり、dry-run client は書込不能、という2つの事実を混同しない。

### 3.6 `ExplainScriptOptions`

`ExplainScriptOptions` に次を追加する。

```ts
export interface ExplainScriptOptions extends ParseScriptOptions {
  client: FlowKintoneClient;

  /**
   * native UPSERT を有効にした実行を想定して適格性を判定する。
   * 省略時および false は opt-in OFF として表示する。
   */
  enableNativeUpsert?: boolean;

  // 既存オプションは変更しない
}
```

これは EXPLAIN の予測条件であり、書込許可ではない。`explainScript` 自体が書込 API を呼べるようにはしない。

`/flow` 利用者が本実行と同じ判定を得るには、`createExecutionContext` と `explainScript` の双方へ同じ `enableNativeUpsert` を指定する。

### 3.7 `FlowChunkWrittenInfo`

`FlowChunkWrittenInfo` を次のように純加法で拡張する。

```ts
export interface FlowChunkWrittenInfo {
  statementIndex: number;
  appId: number;
  operation: "INSERT" | "UPDATE" | "DELETE" | "UPSERT";
  records: number;
  chunkIndex: number;

  /**
   * native UPSERT のレスポンスが INSERT と報告した件数。
   * operation === "UPSERT" の通知にだけ設定する。
   */
  insertedCount?: number;

  /**
   * native UPSERT のレスポンスが UPDATE と報告した件数。
   * operation === "UPSERT" の通知にだけ設定する。
   */
  updatedCount?: number;

  lastKeyValue?: string;
}
```

native UPSERT の通知は常に次の形とする。

```ts
{
  operation: "UPSERT",
  records: insertedCount + updatedCount,
  insertedCount,
  updatedCount,
  lastKeyValue
}
```

`insertedCount` と `updatedCount` は型上 optional だが、`operation === "UPSERT"` の通知では両方を必ず設定する。既存の3操作では設定しない。

`operation` の union 拡大は exhaustive switch を持つ利用者には型上の影響がある。ただし新値は明示 opt-in 時だけ観測され、既定 OFF の既存利用者には通知されないため、この限定された拡大を許容する。現行定義は `src/flow-library/publicTypes.ts:154-165` にある。

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

したがって常に次を満たす。

```text
0 <= nativeUpsertCalls <= putCalls
```

native 呼出しが reject した場合も、既存カウンタと同じく呼出し回数として両方を増やす。レスポンス検証エラーや callback エラーで後から文が失敗しても減算しない。

現行カウンタは `src/flow-library/publicTypes.ts:179-200`、既存 PUT 計上は `src/execute.ts:968-978` にある。

面ごとの見え方は次とする。

- `/flow`: 各 statement result の累積 `metrics.nativeUpsertCalls` から観測できる。
- CLI: core 内部では計上するが、CLI は現在 JSON 出力から metrics を除外しているため、新しい CLI 出力項目は追加しない（`src/cli/index.ts:780`）。事前確認は EXPLAIN、HTTP の実確認は既存 debug 手段を使う。
- MCP・プラグイン・engine-library: native 実行 opt-in がないため通常は0。新しい公開結果項目は追加しない。
- `FlowUpsertResult`: 引き続き経路情報を露出させない。

### 3.9 変更しない結果型

次は変更しない。

```ts
export interface FlowUpsertResult {
  type: "UPSERT";
  insertedCount: number;
  updatedCount: number;
}
```

native か現行経路かは、DML の意味上の結果ではなく metrics と EXPLAIN で観測する。

## 4. native 適用可否

### 4.1 判定単位

判定単位は1文全体とする。

同じ文の一部だけを native、残りを現行経路に流してはならない。schema 不明、空文字、ソース重複などが1行でもあれば、その文全体を現行経路へ戻す。

同一スクリプト内の別の UPSERT 文は独立して判定する。

### 4.2 単一の共有判定

本実行、`previewStatement`、EXPLAIN は、同じ評価器を共有しなければならない。3経路に条件式を複製してはならない。

共有評価器は次の discriminated union 相当を返す。

```ts
type NativeUpsertEligibility =
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

本実行と preview は全判定材料が揃った段階で呼ぶ。実行上 `UNKNOWN` が残った場合は fail-closed とし、native 不適格として現行経路へ戻す。

EXPLAIN は部分的な入力を許す。評価規則は次とする。

1. 判定可能な条件をすべて評価する。
2. 判定可能な条件に false があれば `INELIGIBLE` とする。
3. false が複数ある場合は、§4.3 の順序で最初の条件を表示する。
4. false がなく、未判定条件が1つ以上あれば `UNKNOWN` とする。
5. 6条件すべてが true の場合だけ `ELIGIBLE` とする。

これにより、条件3が不明でも条件4が明確に不適格なら `INELIGIBLE` と表示できる。一方、既知の不適格条件がない状態で metadata やソース行だけが不足している場合は `UNKNOWN` とする。

共有判定の入力は少なくとも次を含む。

- native 能力の有無
- `enableNativeUpsert` の値
- UPSERT 文の構文情報
- IMPORT 由来かどうか
- 対象フィールドの schema、または schema 未取得という状態
- 評価・materialize 済みの全ソース行のキー値、またはソース未 materialize という状態
- キーフィールドの型

本実行では、全ソースレコードの組み立てと既存の書込値検証が完了した後、既存対象を検索する直前に判定する。

preview でも同じ段階で同じ判定を行う。`previewUpsertRecords` は全行の `records` と `rowKeys` を既に構築しているため、空文字とソース内重複を含む6条件を本実行と同じ入力で評価できる（`src/execute.ts:2605-2621`）。

preview は判定結果が native でも既存対象 GET を省略しない。GET は `counts`、before/after、sample に必要である（`src/execute.ts:2605-2644`）。

### 4.3 判定順序

判定順序は次の6条件で固定する。

#### 1. クライアント能力

`upsertRecords` が能力として存在し、かつ関数でなければならない。

```ts
"upsertRecords" in client
&& typeof client.upsertRecords === "function"
```

`typeof` だけで判定してはならない。readonly client は write property の `get` をブロック関数として返す一方、`has` では存在しないと報告するためである（`src/engine-library/readonlyClient.ts:74-83`）。

EXPLAIN では予測対象となる通常実行 client の能力を入力にする。CLI dry-run の throwing client を通常 CLI client の能力判定に使用しない。

#### 2. 明示 opt-in

`enableNativeUpsert === true` を要求する。`undefined`、`false`、その他の値は不適格とする。

CLI では `--native-upsert` がこの条件に対応する。`--allow-dml` や `--yes` から暗黙に true と推測してはならない。

#### 3. キー schema

次のすべてを要求する。

- `keyFields.length === 1`
- schema にそのフィールドが存在する
- `fieldType` が `"SINGLE_LINE_TEXT"` または `"NUMBER"`
- `isUnique === true`

`isUnique === undefined` は実行時には不適格とする。dialect 1 の既存検証は不明な `isUnique` を warning とするが（`src/core/dialect1Validation.ts:115-126`）、native の能力選択では曖昧な schema を許可しない。

EXPLAIN で schema 自体が取得されていない場合は `isUnique === undefined` と同一視せず、条件3を `UNKNOWN` とする。

dialect 0 / 1 自体は条件にしない。

#### 4. 素の UPSERT

次のどちらかだけを適格とする。

- CHECK、APPLY、VALIDATE ONLY、ON ERROR SKIP を伴わない `UPSERT VALUES`
- CHECK、VALIDATE ONLY、ON ERROR SKIP を伴わず、IMPORT 由来でもない `UPSERT SELECT`

この条件は構文木だけで判定できる。dialect 1 でも CHECK 付き UPSERTは受理されるため、dialect を根拠に素の UPSERT と仮定してはならない（`docs/internal/ksql_b173_native_upsert_update_key_issue.md:92-99`）。

#### 5. 空文字キーなし

全ソース行について、評価後のキー値が `""` でないことを要求する。

空文字の `updateKey.value` は kintone が `CB_VA01` で拒否する。一方、現行経路は空文字を含むキーを行ごとの GET で処理するため（`src/execute.ts:7252-7262`、`src/execute.ts:7279-7292`）、空文字を新しいエラーにはせず現行経路へ戻す。

EXPLAIN で全ソース行が materialize されていない場合は、空文字がないと推測せず `UNKNOWN` とする。

#### 6. ソース内キー重複なし

評価・materialize 済みの全ソース行を一括して検査する。100件チャンクごとではなく、文のソース全体をスコープとする。

同値性は次のとおり。

- `SINGLE_LINE_TEXT`: 文字列の完全一致
- `NUMBER`: exact-decimal 正規化後の一致

NUMBER の `"5"` と `"5.0"` は重複、文字列の `"001"` と `"1"` は別キーである。現行の NUMBER 正規化規則は `src/execute.ts:7188-7212` にある。

EXPLAIN で全ソース行が materialize されていない場合は、重複がないと推測せず `UNKNOWN` とする。

### 4.4 不適格時と判定不能時の実行

本実行または preview で6条件のどれかを満たさない場合、または必要な判定材料が不足した場合は、その文全体を静かに現行経路へ戻す。

- 新しい警告を出さない。
- 新しいエラーを出さない。
- native を一度試してから現行経路へ再試行しない。
- 適用判定だけを目的とする API 呼出しを増やさない。
- 現行の対象 GET、POST、PUT の順序を変えない。
- `onChunkWritten` の通知列を変えない。
- preview の `estimatedWrites` は現行式を使う。

schema と型は、既に書込検証で取得するフォーム定義を使う。追加の `getFields` や `getNumberPrecision` を発行してはならない。現行の書込フィールド読込位置は `src/execute.ts:10535-10544` および `src/execute.ts:11135-11141` にある。

EXPLAIN の `UNKNOWN` は表示上の状態であり、実行時に楽観的に native を選ぶ許可ではない。

### 4.5 EXPLAIN の入力充足

EXPLAIN は metadata API 以外の実行 APIを呼ばない planner である（`src/execute.ts:12636-12653`）。したがって次を契約とする。

- 条件1: 予測対象面の能力情報から判定する。
- 条件2: EXPLAIN に渡された opt-in から判定する。
- 条件3: planner が別目的で既に取得・キャッシュしたフォーム metadata がある場合だけ判定する。
- 条件4: 構文木から常に判定する。
- 条件5・6:
  - `UPSERT VALUES` で、値と変数を副作用なしに確定できる場合は判定する。
  - `UPSERT SELECT` はソース行を取得・materialize しないため `UNKNOWN` とする。
  - 一時表や変数の値が planner 上で確定できない場合も `UNKNOWN` とする。

`resolveMetadata === false` の場合、条件3は `UNKNOWN` とする。条件3のために `getFields` を呼んではならない。

`resolveMetadata === true` でも、既存 EXPLAIN 処理が当該アプリの metadata を取得しない文について、native 判定だけを理由に新しい API 呼出しを追加してはならない。その場合も条件3は `UNKNOWN` とする。

## 5. ソース内キー重複

重複時は現行経路へ戻す。

理由は、現行の素の UPSERT が重複を一律エラーにしていないためである。既存レコードに対する重複行は、同じ `$id` を複数回 PUT して後勝ちで成功する（`docs/internal/ksql_b173_native_upsert_update_key_issue.md:138-145`）。opt-in は性能と書込方式の選択であり、入力契約を破壊してはならない。

重複を検出した場合:

- native UPSERT は1回も呼ばない。
- 全行を現行経路で処理する。
- 現行経路で成功するか、既存の重複禁止違反になるかも現在の結果を維持する。
- preview の `counts` と sample は現在の既存判定から構成する。
- preview の `estimatedWrites` は現行式を使う。
- EXPLAIN は `INELIGIBLE` と条件6を表示する。

## 6. native ペイロード

### 6.1 組み立て順

各行について次の順に処理する。

1. 現行と同じ規則で全 UPSERT フィールドを含む `KintoneRecord` を構成する。
2. 現行のフィールド書込可否、必須、長さ、数値精度などの検証を、キーを含む元のレコードに対して実行する。
3. 単一キーフィールドの値を文字列として取得する。
4. 送信用 `record` を新しく作り、キーフィールドだけを除外する。
5. 取り出したキー値を `updateKey.value` に設定する。
6. `updateKey.field` にフィールドコードを設定する。
7. ソース順を維持したまま100件単位に分割する。
8. 各リクエストにトップレベルの `upsert: true` を必ず設定する。

元のレコードオブジェクトを破壊的に変更してはならない。

キー除去の結果、送信用 `record` が空オブジェクトになっても、そのまま `record: {}` として送る。キー以外の書込フィールドがない UPSERTについて、`record: {}` の INSERT と UPDATE、および `record` 自体を省略した INSERT の3形が実機で受理されている。したがってキーのみの UPSERT も6条件を変更せず native 適格とする（`docs/internal/ksql_b173_native_upsert_update_key_issue.md §3.2`）。

公開入力型では `record` を必須とするため、省略形は使わず `record: {}` を送る。

### 6.2 キー値

`updateKey.value` は必ず文字列で送る。

NUMBER キーも JavaScript の `number` に変換しない。VALUES の数値リテラルは raw 表現、SELECT の値は materialize 後の文字列表現を維持する。安全整数を超える値も、アプリの `numberPrecision` に収まる限りそのまま送る。

現行の VALUES キー抽出は数値リテラルの raw text を維持している（`src/execute.ts:10597-10606`）。実機でも16桁・20桁の NUMBER キーを文字列のまま `updateKey` に渡せば照合できている（`docs/internal/ksql_b173_native_upsert_update_key_issue.md:142-145`）。

### 6.3 キーの除去

キーフィールドを `record` と `updateKey` の両方へ載せてはならない。

禁止:

```json
{
  "updateKey": {
    "field": "key_text",
    "value": "K1"
  },
  "record": {
    "key_text": {
      "value": "K1"
    },
    "payload": {
      "value": "value-1"
    }
  }
}
```

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

キーだけの UPSERT:

```json
{
  "updateKey": {
    "field": "key_text",
    "value": "K1"
  },
  "record": {}
}
```

キーを `record` に含めると、kintone は INSERT、UPDATE、同値、別値のいずれも `CB_VA01` で拒否する。一方、INSERT 時のキーフィールド値は `updateKey` から登録される（`docs/internal/ksql_b173_native_upsert_update_key_issue.md:136-145`）。

## 7. 書込順・確認・結果

### 7.1 書込順

native 適格な文では、ソース順のまま100件単位で `upsertRecords` を呼ぶ。

現行の「INSERT 全チャンクを POSTした後、UPDATE 全チャンクを PUTする」順序（`src/execute.ts:10578-10588`、`src/execute.ts:11208-11218`）とは異なる。この差は opt-in 時だけ許容する。

0行の場合は `options.confirm` と `upsertRecords` のいずれも呼ばず、次を返す。

```ts
{
  type: "UPSERT",
  insertedCount: 0,
  updatedCount: 0
}
```

### 7.2 `options.confirm`

全ソースレコードの構築、現行と同じ書込値検証、native 適格性判定が完了した後、最初の `upsertRecords` の直前に次を実行する。

```ts
const total = records.length;

if (options.confirm && total > 0) {
  const ok = await options.confirm(total, "UPDATE");
  if (!ok) throw new OperationCancelledError("UPDATE", total);
}
```

契約は次のとおり。

- 件数は INSERT/UPDATE の内訳ではなく文全体の合計件数。
- 第2引数は現行と同じ `"UPDATE"`。
- 複数チャンクでも1回だけ呼ぶ。
- `false` の場合は `OperationCancelledError("UPDATE", total)` を変更せず送出する。
- 拒否された場合は `upsertRecords`、`postRecords`、`putRecords`、`onChunkWritten` のいずれも0回。
- 0件では呼ばない。

現行 UPSERT VALUES / SELECT も最初の書込前に合計件数と `"UPDATE"` を渡している（`src/execute.ts:10571-10576`、`src/execute.ts:11201-11206`）。

R3 では CLI が opt-in 面になったため、この契約は実動する。

単文 CLI では:

- `--allow-dml` がなければ native 判定より前に拒否する。
- `--yes` がなければ既存の DML 確認を表示する。
- `--yes` があれば確認 callback は true を返すが、`--dml-max-rows` の件数ガードは維持する。
- 確認拒否時は API 呼出しを開始しない。

バッチ CLI では:

- 既存どおりバッチ全体の DML 確認を1回行う（`src/cli/index.ts:2432-2441`）。
- 文ごとの `confirm` は件数ガードと詳細表示を維持し、追加の対話確認を行わない（`src/cli/index.ts:2442-2481`）。
- native 適格な各 UPSERT 文でも、core の `options.confirm(total, "UPDATE", context)` 呼出し自体は省略しない。

REPL では利用者確認を REPL 側で済ませ、子実行へ `--yes` を付ける現行契約を維持する。

### 7.3 結果の内訳

各 native レスポンスについて、リクエスト行と同じ順序で返る `records[]` を検査する。

- `operation === "INSERT"` の数を `insertedCount` に加算する。
- `operation === "UPDATE"` の数を `updatedCount` に加算する。
- `revision` から INSERT/UPDATE を推測しない。
- `id` と `revision` はレスポンス契約として検査するが、`FlowUpsertResult` には追加しない。

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

次のいずれかは不正なクライアントレスポンスとして fail-closed にする。

- `records` が配列でない。
- `records.length` が送信件数と一致しない。
- 各要素の `operation` が `"INSERT"` / `"UPDATE"` 以外。
- `id` または `revision` が文字列でない。

この場合、現行経路へ再試行しない。

```text
code: NativeUpsertResponseError
message: NativeUpsertResponseError: upsertRecords returned an invalid response.
```

## 8. クライアントとラッパー

任意メソッドは、能力のない client にラッパーが能力を付与しないよう、すべて条件付きで公開する。

### 8.1 `/flow` の `createKintoneClient`

`src/flow-library/writableClient.ts` の同梱クライアントに `upsertRecords` を実装する。現行 `putRecords` はレスポンスを捨てている（`src/flow-library/writableClient.ts:139-148`）。

`upsertRecords` は:

- `PUT /records.json` を使用する。
- `app`、`upsert: true`、`records` を body に送る。
- レスポンスの `records` を返す。
- guest space、認証、timeout、HTTP error は既存の共通 request 処理を使う。

### 8.2 CLI の `createNodeKintoneClient`

`src/cli/nodeKintoneClient.ts` の同梱 client に同じ `upsertRecords` を追加する。

現行 `putRecords` は `{app, records}` を再構成して送っている（`src/cli/nodeKintoneClient.ts:337-349`）。そのメソッドへトップレベル `upsert` を混ぜず、専用メソッドとして次を送る。

```ts
{
  app: params.app,
  upsert: true,
  records: params.records
}
```

戻り値は `requestJson<KintoneNativeUpsertResult>` のレスポンスを捨てずに返す。

認証、トークン解決、guest space、URL、timeout、HTTP error 変換は、既存の `postRecords` / `putRecords` と同じ `requestJson` 経路を使う（`src/cli/nodeKintoneClient.ts:322-349`）。

### 8.3 `wrapClientWithMetrics`

現行 wrapper はメソッド列挙型である（`src/execute.ts:914-996`）。

- 内側に能力がある場合だけ外側にも `upsertRecords` を追加する。
- 委譲前に `metrics.putCalls` と `metrics.nativeUpsertCalls` をそれぞれ1増やす。
- 成功・失敗の双方を計上する。
- 内側に能力がない場合、外側の `"upsertRecords" in client` も false。
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
- `params.app` を物理アプリ ID に置換する。
- `upsert`、`records`、`updateKey`、`record` は変更しない。
- 戻り値をそのまま返す。

### 8.6 `wrapClientWithPreviewWriteBlock`

現行はスプレッド後に書込メソッドを塞いでいる（`src/execute.ts:1984-1995`）。

- 内側に `upsertRecords` がある場合だけ同名の blocked method で上書きする。
- 呼ばれた場合は次を送出する。

```text
PreviewWriteBlockedError: previewStatement blocked a write API call.
```

- 内側に能力がない場合は blocked method 自体を追加しない。
- preview の適格性判定は能力を保持できるが、実際に呼んではならない。

### 8.7 `wrapClientWithChunkWrittenCallback`

現行は POST / PUT / DELETE の成功後に通知する（`src/execute.ts:2114-2167`）。

- 内側に能力がある場合だけ `upsertRecords` をラップする。
- response の構造と件数を検査する。
- 成功した1リクエストにつき1回通知する。
- `operation` は常に `"UPSERT"`。
- `records` はリクエスト件数。
- `insertedCount` / `updatedCount` は response の `operation` から集計する。
- `lastKeyValue` はリクエスト最後の `updateKey.value`。
- callback を await してから response を返す。
- callback が throw した場合、その文はエラーになるが対象チャンクは書込済みとする（`src/flow-library/publicTypes.ts:147-151`）。

### 8.8 `projectReadonlyClient`

`WRITE_METHODS` に `"upsertRecords"` を追加する（`src/engine-library/readonlyClient.ts:5-9`）。

readonly client は:

- `"upsertRecords" in client === false`
- 直接 property を取得して呼んだ場合は read-only violation
- native 能力として検出されない

### 8.9 スプレッド型のその他ラッパー

`wrapClientWithSearchAbort` と cursor scope は client をスプレッドしているため、前段で条件付き公開された `upsertRecords` を保持する（`src/execute.ts:1004-1055`）。

能力が実行入口まで失われないこと、および能力なし client へ新しい property を追加しないことを固定する。

## 9. `onChunkWritten`

native 適格な3行を1回で送り、レスポンスが次の場合:

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

101行なら通知回数は2回で、`records` は100、1となる。INSERT と UPDATE の内訳のために通知回数を増やさない。

`chunkIndex` は、その文で成功通知された書込 API リクエストの0始まり index とする。失敗したリクエストには通知せず、後続も実行しない。

複数リクエストの部分失敗では、先行リクエストが確定して残り、失敗した後続リクエスト内部は全件ロールバックされることを実機で確認済みである（`docs/internal/ksql_b173_native_upsert_update_key_issue.md §3.2`）。

成功境界は `onChunkWritten` が通知済みのソース順 prefix とする。

## 10. preview、EXPLAIN、`estimatedWrites`

### 10.1 preview の読取経路

preview は native 適格でも、既存対象を検索して次を現在と同じ規則で構成する。

- `counts.insert`
- `counts.update`
- before / after
- samples
- `reads`

`previewStatement` は書込を実行しない。現行 write block は `src/execute.ts:1984-1995`、UPSERT preview の GET と分類は `src/execute.ts:2605-2644` にある。

### 10.2 `estimatedWrites`

共有判定が `ELIGIBLE` の場合:

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

UPSERT 以外の式は変更しない。現行式は `src/execute.ts:2472-2481` にある。

preview では通常実行クライアントの能力、同一 execution context の opt-in、既に取得済みの schema、全 materialize 行を使う。

### 10.3 EXPLAIN の表示

UPSERT / UPSERT_SELECT 文の `plan` に、既存の計画行を削除・変更せず次の1行を追加する。

適格:

```text
  native UPSERT eligibility: ELIGIBLE（6 条件をすべて満たす）
```

不適格:

```text
  native UPSERT eligibility: INELIGIBLE（条件 3: KEY_SCHEMA — キー項目は重複禁止の SINGLE_LINE_TEXT または NUMBER ではない）
```

判定不能:

```text
  native UPSERT eligibility: UNKNOWN（条件 3: KEY_SCHEMA — フォームメタデータ未取得; 条件 5・6: SOURCE_KEYS — ソース行未 materialize）
```

固定状態値は `ELIGIBLE`、`INELIGIBLE`、`UNKNOWN` とする。理由文は日本語でよいが、条件番号と短い識別子を必ず含める。

識別子は次を使う。

```text
1 CLIENT_CAPABILITY
2 OPT_IN
3 KEY_SCHEMA
4 PLAIN_UPSERT
5 EMPTY_KEY
6 SOURCE_DUPLICATE
```

`INELIGIBLE` は最初の既知の失敗条件だけを表示する。`UNKNOWN` は未判定条件を条件番号順にすべて表示する。

注記を追加する `plan` は、内側の UPSERT 文に対応する statement plan とする。UPSERT 以外の文へ native 行を追加しない。

既存の dialect 1 API 見積りには現行経路を前提とした `UPSERT pre-read` がある（`src/execute.ts:12832-12855`）。native 適格性行はこの既存行を削除せず、次の解釈を明示する。

- `ELIGIBLE`: 本実行では既存の `UPSERT pre-read` を行わず、write は合計行数の100件チャンクになる。
- `INELIGIBLE`: 既存の pre-read と INSERT/UPDATE 分割見積りを使う。
- `UNKNOWN`: 表示時点では現行見積りを安全側の上限として残す。

必要なら適格性行の直後に次を追加できる。

```text
    note: ELIGIBLE の場合、UPSERT pre-read は 0 回。UNKNOWN は現行経路の見積りを表示
```

### 10.4 `buildBatchExplainPlans`

`buildBatchExplainPlans` は CLI、MCP、プラグイン、engine-library、`/flow` が共有している（`src/cli/index.ts:2348-2354`、`src/mcp/tools.ts:705-720`、`src/ui/batchExplain.ts:17-30`、`src/engine-library/query.ts:120-136`、`src/flow-library/index.ts:76-103`）。

関数へ trailing optional options object または同等の純加法引数を追加し、少なくとも次を渡せるようにする。

```ts
interface NativeUpsertExplainOptions {
  enableNativeUpsert?: boolean;

  /**
   * EXPLAIN が予測する通常実行 client の能力。
   * dry-run の write-block client そのものから推測しない。
   */
  clientHasNativeUpsert?: boolean;
}
```

既存呼出しで省略された場合は次とする。

```ts
enableNativeUpsert === false
clientHasNativeUpsert
  === ("upsertRecords" in client
    && typeof client.upsertRecords === "function")
```

CLI dry-run は通常 CLI client が能力を持つ事実を明示的に渡す。`/flow` は routed client の実能力と `ExplainScriptOptions.enableNativeUpsert` を渡す。

MCP・プラグイン・engine-library は実行 opt-in を公開しないため、既定では条件1または2により `INELIGIBLE` となる。ただし同じ共通評価器と理由形式を使う。

### 10.5 MCP の単文 EXPLAIN

MCP は現在、複文だけ `buildBatchExplainPlans` を使い、単文は `executeSql(explainSql(...))` を使う（`src/mcp/tools.ts:674-745`）。

R3 では単文も `buildBatchExplainPlans` を通す。

- `statements.length > 1` の分岐だけに共通 planner を置かない。
- 単文でも `plans.statements[0].plan` を取得する。
- MCP 単文の既存 scalar response shape は維持する。
- バッチだけが `batch: true` と配列形を返す既存互換性は維持する。
- 単文の app binding 復元も従来どおり行う。
- MCP ツール入力に `enableNativeUpsert` は追加しない。

単文レスポンス形への正確な plan 格納方法は、現行 `toSelectPayload` の列契約との整合を実装時に確認する必要があるため要確認。ただし、単文で適格性行が欠落する実装は不受理とする。

### 10.6 CLI の EXPLAIN

次の双方へ `--native-upsert` を渡す。

- `--dry-run` が直接 `buildBatchExplainPlans` を呼ぶ経路（`src/cli/index.ts:2348-2354`）
- SQL として書かれた `EXPLAIN UPSERT ...` の単文・バッチ経路

CLI の単文 `EXPLAIN` が共通 planner を通らない場合は、単文 MCP と同様に共通 planner へ寄せるか、同一の共有評価器と renderer を `executeExplain` から呼ぶ。条件式や文言を複製してはならない。

### 10.7 dry-run の表示例

```bash
ksql --allow-dml --native-upsert --dry-run -e \
  "UPSERT INTO APP1 (key, value) VALUES ('K1', 'v') KEY (key)"
```

schema が取得されていない場合:

```text
native UPSERT eligibility: UNKNOWN（条件 3: KEY_SCHEMA — フォームメタデータ未取得）
```

`UPSERT SELECT` で schema だけ判定できた場合:

```text
native UPSERT eligibility: UNKNOWN（条件 5・6: SOURCE_KEYS — UPSERT SELECT のソース行未 materialize）
```

`--native-upsert` を省略した場合は、他条件が不明でも既知の条件2が false なので:

```text
native UPSERT eligibility: INELIGIBLE（条件 2: OPT_IN — native UPSERT の明示 opt-in が無効）
```

「metadata 未取得」を「schema 不適格」と表示してはならない。

## 11. エラー

### 11.1 kintone API エラー

`upsertRecords` が kintone API error を返した場合、現行 wrapper の error code とトップレベル message を変更せず上位へ送る。

対象例:

- `GAIA_IQ28`
- `CB_VA01`
- レコード追加権限不足
- guest space / auth error

フィールド別詳細を新しい独自形式に変換しない。

### 11.2 `/flow` と CLI

`/flow` の `executeStatement` は既存どおり error result に正規化する。

```ts
{
  status: "error",
  error: {
    code: error.name,
    message: error.message
  }
}
```

CLI は既存の error-to-exit-code と stderr 契約を維持する。native 専用 exit code は追加しない。

`OperationCancelledError`、`NativeUpsertResponseError`、kintone API error のいずれでも、native 開始後に現行経路へ切り替えない。

### 11.3 native エラー後の fallback 禁止

適格性判定で不適格または判定不能なら書込前に現行経路へ戻す。

一度でも native リクエストを開始した後は、次のいずれでも現行経路へ再試行しない。

- API error
- レスポンス不正
- `onChunkWritten` callback error
- CLI の出力処理 error

先行チャンクが確定済みの可能性があり、再試行すると二重書込や件数誤報になるためである。実機でも、先行チャンクは確定して残り、失敗した後続リクエスト内は全ロールバックされることを確認済みである（`docs/internal/ksql_b173_native_upsert_update_key_issue.md §3.2`）。

通常 UPSERT のエラー結果に `partialSuccess` は追加しない。成功境界は `onChunkWritten` の通知済み prefix とする。

## 12. 移行と互換性

### 12.1 既定 OFF

次のいずれかでは、B173 実装前と同じ動作を保証する。

- `/flow` で `enableNativeUpsert` を省略
- `/flow` で `enableNativeUpsert: false`
- CLI で `--native-upsert` を省略
- client に `upsertRecords` がない
- 6条件のどれかを満たさない
- 実行時に必要な判定材料が揃わない

保証対象は次のすべて。

- UPSERT の最終レコード内容
- `insertedCount` / `updatedCount`
- GET / POST / PUT の回数
- POST 全部の後に PUT 全部を行う順序
- 各 API body
- `onChunkWritten.operation`
- `onChunkWritten.records`
- `onChunkWritten.chunkIndex`
- `onChunkWritten.lastKeyValue`
- preview の counts、samples、reads、`estimatedWrites`
- 既存の error code / message
- CLI の DML 許可、確認、exit code
- MCP・プラグイン・engine-library の実行経路

`ExecutionMetrics.nativeUpsertCalls` の追加と EXPLAIN の適格性行は純加法の観測情報であり、DML 結果の互換性には含めない。

native 適格な文では INSERT 対象も HTTP PUT に統合されるため、`postCalls` は0になる。各 native 呼出しは `putCalls` と `nativeUpsertCalls` の双方に計上する。

### 12.2 古いクライアント

`upsertRecords` は optional であるため、既存の自前 `FlowKintoneClient` 実装は変更不要である。

能力を宣言していないクライアントに `/flow` の `enableNativeUpsert: true` を渡してもエラーにはせず、現行経路を使う。

既存の metrics object を手作業で構築している TypeScript 利用者にとって、新しい必須 number property は型上の影響がある。実行結果の各 metrics snapshot では必ず `nativeUpsertCalls: 0` 以上を含める。公開型の純加法を優先し、optional にはしない。

### 12.3 CLI

CLI 同梱 client は能力を持つが、`--native-upsert` を指定しない限り現行経路を使う。

次の例だけが native を許可する。

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

`--yes` を付けても native の6条件、件数ガード、能力判定は省略しない。

本番 `/flow` と同じ権限を検証する場合は、CLI profile が本番と同じ API トークンを参照していることを利用者が確認しなければならない。プロファイル名が同じ、または同じアプリを指すだけでは権限主体の同一性を保証しない。

### 12.4 プラグインと MCP

プラグイン client は `upsertRecords` を実装しない。MCP の実行入力にも opt-in を追加しない。

- プラグインはセッション認証で、本番 API トークンの権限差を再現できない。
- MCP は LLM が入力を構成するため、追加権限を要求する opt-in を公開しない。
- 両面の実行は現行経路を維持する。
- EXPLAIN の3状態表示だけを共通提供する。

トップレベル `upsert` を既存 `putRecords` に混ぜて渡す実装にはしない。既存 client が `{app, records}` を再構成するため追加値を落とし得ることは、起票文書で確認済みである（`docs/internal/ksql_b173_native_upsert_update_key_issue.md:40-52`）。

### 12.5 EXPLAIN の互換性

既存の statement count、statement type、plan 配列、MCP 単文/バッチの外形を維持する。

変更は UPSERT / UPSERT_SELECT の `plan` への適格性行追加だけとする。

- SELECT、UPDATE、DELETE、INSERT などの既存 plan は変更しない。
- `UNKNOWN` を理由に EXPLAIN 自体を error にしない。
- metadata やソースを追加取得しない。
- 現行の API consumption 行を削除しない。
- 単文 MCP のレスポンスをバッチ形へ変更しない。

## 15. Claude が実機で確かめるべき未確認事項

次は仕様の採否条件ではない。実装レビューまたはリリース前に実機で確認し、結果をレビュー記録またはリリース記録へ残す。

1. `/flow` 実クライアント経由の error message

   `src/flow-library/writableClient.ts` の `upsertRecords` を通して `GAIA_IQ28` / `CB_VA01` を発生させ、公開されるトップレベル `message` の正確な文字列を記録する。

   `CB_VA01` のフィールド別 `errors[...]` を現行 wrapper が保持しない場合、トップレベル message だけで運用上十分か確認する。

2. CLI 実クライアント経由の成功レスポンスと error message

   `src/cli/nodeKintoneClient.ts` の `upsertRecords` を通して INSERT / UPDATE の混在リクエストを実行し、次を確認する。

   - `records[]` がリクエスト順で返る。
   - `id` / `revision` / `operation` が失われない。
   - `GAIA_IQ28` / `CB_VA01` の code とトップレベル message が既存 `requestJson` 経路で保持される。
   - CLI の exit code と stderr が既存 error policy に従う。

3. 本番と同じトークンによる CLI リハーサル

   `/flow` 本番と同じ API トークンを指す CLI profile を使い、`--allow-dml --native-upsert` で同じ dialect 1 ジョブ SQLを実行する。

   - native 経路で成功すること。
   - 事前 GET が発生しないこと。
   - INSERT / UPDATE の結果件数が一致すること。
   - `--native-upsert` を外すと現行経路へ戻ること。

4. レコード追加権限なしの全件 UPDATE

   レコード追加権限を持たず、編集権限だけを持つトークンで、既存キーだけの native UPSERT が実際に権限エラーになることを確認する。

   `/flow` client と CLI client の双方で同じトークンを使い、実レスポンスの code / message と API 呼出し境界を記録する。

5. CLI の確認実経路

   native 適格な UPSERT VALUES / SELECT について次を確認する。

   - `--yes` なしで確認拒否した場合、native API が0回。
   - `--yes` ありでは確認プロンプトなしで実行される。
   - `--dml-max-rows` 超過では `--yes` があっても書込0回。
   - バッチは全体確認1回で、文ごとの件数ガードが残る。
   - REPL はセッション表示に `native-upsert=on` を出し、子実行へフラグを転送する。

   対話部分は CLI integration test で固定できるが、本番トークンを使った一度の確認も記録する。

6. guest space

   guest space 内アプリで `/flow` client と CLI client の native UPSERT が既存 `apiBase` routing と同じ URLへ送られ、response が取得できることを確認する。

7. CLI dry-run と本実行の表示整合

   同じ SQL と profile について次を記録する。

   - 完全オフライン dry-run では metadata / source 不足を `UNKNOWN` と表示する。
   - metadata が利用できる EXPLAIN では条件3を確定できる。
   - `UPSERT SELECT` の未 materialize 条件5・6は `UNKNOWN` のまま。
   - 実行時に全材料が揃った後、native または fallback が共有判定どおり選ばれる。
   - dry-run の `UNKNOWN` を `INELIGIBLE` と誤表示しない。

8. 5面の EXPLAIN 到達性

   同じ UPSERT を CLI、MCP、プラグイン、engine-library、`/flow` の各 EXPLAIN から通し、適格性行が欠落しないことを確認する。

   API 呼出しと client 差は mock / integration test で固定できる。実機確認が必要なのは metadata を取得する面で実フィールド定義が理由文へ正しく反映されることだけとする。

上記以外の能力保持、request gate、readonly、論理アプリ routing、重複 fallback、NUMBER raw body、preview write block、metrics の内数、`options.confirm` の引数、MCP 単文の外形は mock / integration test で決着でき、実機確認を必須としない。
---

## 16. レビュー記録

レビュー: Claude（[[spec-and-impl-by-codex]]＝codex が仕様と実装、Claude がレビュー・実測・リリース）。静的な主張は file:line を開いて突き合わせ、動的な主張は実機で測る。

### 16.1 R1 レビュー（2026-08-25）→ R2 で全件反映済み

- **[Major] `options.confirm` の欠落** — 現行は書込直前に確認コールバックを呼び拒否時に `OperationCancelledError` を投げる（`src/execute.ts:10571-10576`・`:11201-11206`）が、R1 の native 書込ループにその段が無く受入条件にも `confirm` が 0 件だった。**R3 で CLI が opt-in 面になったため、この契約は実動する**（R1 のままなら CLI へ広げた瞬間に確認なしで書く経路ができていた）
- [軽微] `postCalls` が 0 になる互換ノート／preview で共有判定が実行できる根拠 → R2 で反映

**評価できた点**（R3 でも不変）＝能力検出を `"upsertRecords" in client && typeof … === "function"` の両方で要求する理由（readonly client は write property の `get` を blocked 関数として返す一方 `has` は false・`src/engine-library/readonlyClient.ts:74-83`）／判定単位を 1 文全体に固定／native 開始後の fallback 禁止／既存テストの snapshot 一括更新の禁止。

### 16.2 R3 レビュー（2026-08-25）

**総評: CLI opt-in・metrics カウンタ・`confirm` の実動化・EXPLAIN の 3 状態は妥当。ただし可視化に、目的を無効化する欠陥が 1 件。**

#### [Major 1] 非 opt-in 面で常に `INELIGIBLE` になり、**可視化の目的を達しない**

§10.4 は「MCP・プラグイン・engine-library は実行 opt-in を公開しないため、**既定では条件 1 または 2 により `INELIGIBLE`**」としている。

**しかし可視化の目的（起票文書 §7.3）は「検証面で『この文は `/flow` / CLI で native になるのか』を実行前に読めるようにする」こと。** 常に「opt-in が無いから不適格」と出るなら、**その面では何も分からない**。可視化を入れる意味がほぼ消える。

しかも起票文書 §7.6.4 のとおり **opt-in を出さない面ほど可視化の価値が高い**（実行しないなら、せめて本番の挙動が読めることが要る）。R3 の設計はここが逆になっている。

**修正案＝条件を 2 群に分けて報告する。**

| 群 | 条件 | 性質 |
|---|---|---|
| **面依存** | 1（クライアント能力）・2（opt-in） | **実行面の構成**。MCP / プラグインでは常に不成立 |
| **文・データ依存** | 3（キー schema）・4（素の UPSERT）・5（空文字キー）・6（ソース重複） | **その SQL とデータの性質**。面によらない |

非 opt-in 面では**面依存の 2 条件を「対象外」として扱い、文・データ依存の判定を出す**:

- 「本質条件（3〜6）を満たす。**opt-in のある面（`/flow` / CLI）では native になる**」
- 「**条件 6 で不適格（ソース重複）＝どの面でも native にならない**」

これで初めて、MCP でジョブを組む Claude や、プラグインで試す開発担当者に**意味のある情報**が届く。§7.7.3 のとおり**実運用でいちばん読まれるのは「不適格＋理由」**なので、その理由が「opt-in が無い」で埋まってはいけない。

#### [Major 2] MCP 単文 EXPLAIN の経路統合（§10.5）は**スコープ過大**

**「単文にも適格性を出す必要がある」という判断は正しい**（B175 と違い B173 は単文 UPSERT でも適格になり得る）。しかし手段が重い。

実装を確認した:

- MCP の単文 EXPLAIN は `executeSql(explainSql(...))` → `toSelectPayload` で **SELECT ペイロード**を返す（`src/mcp/tools.ts:730-745`）。`buildBatchExplainPlans` の plan 文字列配列とは**別物**
- 単文の計画生成は `executeExplain`（`src/execute.ts:13111`）で、**`buildBatchExplainPlans` とは別実装**
- 書込見積り行を作る `buildDialect1ApiEstimateLines`（`src/execute.ts:12803`）は **`buildBatchExplainPlans` からしか呼ばれていない**（`:12759`）＝**書込見積りが単文 EXPLAIN に出ないのは既存の非対称**

R3 はこの既存の非対称を直そうとして経路統合に踏み込んでおり、**codex 自身も「単文レスポンス形への正確な plan 格納方法は実装時に確認が必要」と書いている**。load-bearing な既存出力を作り直す risk に対して、得られるのは助言 1 行。

**修正案＝共有するのは判定関数であって計画生成の経路ではない。** `executeExplain` からも同じ評価器を呼んで 1 行足す。出力の形をどこも変えずに済み、CLI の単文 EXPLAIN（§10.6 で同じ論点が未決）も同時に解決する。**既存の非対称（書込見積りが単文に出ない）は B173 の範囲外として残す。**

#### [Minor] §12 に「既定を将来反転させる想定」が無い

起票文書 §7.7 のとおり、**適格な UPSERT を持つ利用者はほぼ全員が有効化する**。「指定なし」は選択ではなく「まだ移行していない」状態になり、**主要な失敗モードは「有効化を忘れて黙って遅い経路を通る」**。→ §12 に寿命と反転条件を明記する。

**あわせて既定 OFF の理由を書き換える。** 現行の理由（権限要件）は**弱い**＝権限エラーは**大きく鳴る**（静かに誤らない）し、一度トークンを直せば済む。

**本当の理由は公開面の非破壊性**: R2 / R3 は `FlowChunkWrittenInfo.operation` の union 拡大を **「新しい値は opt-in したときにしか出ない」の一点で正当化している**（§3）。既定 ON にすると**その正当化が消え**、opt-in していない既存利用者に `"UPSERT"` が流れ込む。`postCalls` が 0 になることと `estimatedWrites` の式変更も同様。**既定 ON は B173 を全利用者にとっての破壊的リリースに変える。**

→ **反転はメジャー版に紐づける**（起票文書 §7.7.4 の「1〜2 版後」はマイナー版を含意しており不正確なので訂正する）。なお「権限エラーなら自動 fallback」は理屈上可能（権限エラーは 1 チャンク目で起き all-or-nothing なので書込ゼロで検出できる）だが**採らない** — loud に落ちてトークンを直させるほうが、静かに遅い経路へ落ちるより良い。

#### 理由の差し替え（結論は不変）

**プラグインを opt-in 対象外とする理由**（起票文書 §7.6.3）。旧理由 2 つはどちらも成立しない — 利用者が開発担当者でアプリ管理権限を持つのは**設計上の前提であって欠陥ではなく**、`/flow` の API トークン権限を確かめるのはプラグインの役割ではない。UI 作業の重さも、開発者向け面なら弱い。**新理由＝CLI の opt-in に対する追加価値が小さく、自然な設定粒度がアプリ単位（環境単位）で、退けたはずの「書いたら以後ずっと効く」形になる。**

**権限の担保は運用手順が本筋**（有効化前に `/flow` が使うトークンの追加権限を確認する）。API トークンのスコープを問い合わせる手段が無い以上どの実行面でも代替できず、**CLI が本番トークンを指せるのは補助であって代替ではない**。

### 16.3 R4 で直すこと

1. **[Major] 非 opt-in 面の適格性表示**を、面依存条件（1・2）と文・データ依存条件（3〜6）の 2 群に分けて報告する
2. **[Major] 単文 EXPLAIN は経路統合せず、`executeExplain` から共有評価器を呼ぶ**（MCP・CLI とも）
3. **[Minor] §12 に既定反転の想定と条件**を追加し、**既定 OFF の理由を「公開面の非破壊性」へ書き換える**（反転はメジャー版）
4. **[Minor] プラグイン対象外の理由**を差し替える
