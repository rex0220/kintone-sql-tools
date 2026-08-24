# B173 native UPSERT（`updateKey` + `upsert: true`）仕様 R2

- 状態: 仕様 R2。実装未着手。この仕様作成セッションではコード、文書、git 状態を変更していない。
- 対象: `/flow` の素の `UPSERT VALUES` / `UPSERT SELECT` 本実行、および同じ実行条件を反映する `previewStatement` の `estimatedWrites`。
- 前提（この仕様がレビュー対象外として受け取った決定事項）:
  - 案 C「能力検出付きの opt-in・素の UPSERT 限定」を採用する。既定は OFF。
  - opt-in は `/flow` 限定で、`CreateExecutionContextOptions` に置く。
  - `putRecords` は変更せず、任意の能力メソッド `upsertRecords?` を純加法で追加する。
  - 能力メソッドを実装する同梱クライアントは `src/flow-library/writableClient.ts` の `createKintoneClient` だけとする。CLI とプラグインのクライアントは変更しない。
  - native UPSERT はアプリのレコード追加権限を追加で要求するため、既定 ON にはしない。
  - `onChunkWritten` は native の1リクエストにつき1回通知し、INSERT/UPDATE に分割しない。
  - dry-run の読取経路、CHECK / APPLY / IMPORT / VALIDATE ONLY / ON ERROR SKIP の各経路は変更しない。
  - 実機測定結果は `docs/internal/ksql_b173_native_upsert_update_key_issue.md:132-149` および R1 レビューで確定した追加測定結果（`docs/internal/ksql_b173_native_upsert_update_key_issue.md §3.2`）を採用し、再導出しない。
  - B173 の tracker 状態と対象は `docs/ksql_issue_tracker.md:42` を正とする。

## R1 からの変更点

- native 経路でも、最初の書込前に現行と同じ引数で `options.confirm` を呼ぶ契約を追加した。拒否時は `OperationCancelledError("UPDATE", total)` を変更せず送出し、書込を開始しない。
- キー以外の書込フィールドがない UPSERT、100件上限のレスポンス、複数リクエストの部分失敗について、実機測定済みの事実を本文へ反映した。
- native 適格時は `ExecutionMetrics.postCalls` が0になり、API呼出し内訳が変化することを互換性に明記した。
- preview が全行の `records` と `rowKeys` を既に構築しているため、本実行と共有する適格性判定を実行できることを明記した。
- 既存の受入条件 AC-1〜AC-17 は変更せず、確認拒否を固定する AC-18 を追加した。
- 未確認事項は、実クライアント経由のエラー message、追加権限なしトークン、guest space の3件だけとした。

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

目的は既存判定のための事前 GET をなくすことである。opt-in されていない実行、および適用条件を一つでも満たさない実行は、現在の read-then-write 経路をそのまま使用する。

## 2. 非対象

次は B173 の対象外とし、既存経路、結果、検証、API 順序を変更しない。

- `CHECK` 付き UPSERT
- `APPLY UPSERT`
- `VALIDATE ONLY`
- `ON ERROR SKIP`
- `IMPORT` が内部生成する `UPSERT SELECT`
- `previewStatement` の既存値読取、差分、件数、サンプル
- CLI の `src/cli/nodeKintoneClient.ts`
- プラグインの `src/ui/kintoneClient.ts`
- dialect 1 の構文・静的検証規則
- `putRecords` の入力型と `Promise<void>` の戻り値

事前 GET は CHECK 系では検証モードの決定、APPLY では既存値、IMPORT では既存サブテーブルと revision の取得にも使われているため、native へ置換できない（`docs/internal/ksql_b173_native_upsert_update_key_issue.md:23-38`）。dialect 1 の検証も現行のままとする（`src/core/dialect1Validation.ts:90-128`）。

## 3. 公開型

### 3.1 `FlowKintoneClient`

現行の `FlowKintoneClient.putRecords` は ID 指定更新だけを受け、戻り値を返さない（`src/flow-library/publicTypes.ts:53-69`）。

変更前:

```ts
export interface FlowKintoneClient {
  // ...
  putRecords(params: {
    app: number;
    records: Array<{
      id: number;
      revision?: number;
      record: KintoneRecord;
    }>;
  }): Promise<void>;
  // ...
}
```

変更後:

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
  putRecords(params: {
    app: number;
    records: Array<{
      id: number;
      revision?: number;
      record: KintoneRecord;
    }>;
  }): Promise<void>;

  /**
   * kintone native UPSERT 能力。
   * メソッドが存在するクライアントだけが native 候補になる。
   */
  upsertRecords?(
    params: KintoneNativeUpsertParams
  ): Promise<KintoneNativeUpsertResult>;

  // ...
}
```

`src/execute.ts` の `KintoneClient` にも、構造的に同一の任意メソッドを追加する。現行の `putRecords: (params: KintonePutParams) => Promise<void>` は変更しない（`src/execute.ts:274-293`）。

メソッドの存在だけが能力宣言である。古いクライアント、CLI クライアント、プラグインクライアント、自前クライアントは、このメソッドを実装しなければ現在の経路を使い続ける。

### 3.2 `CreateExecutionContextOptions`

変更前（該当部分）:

```ts
export interface CreateExecutionContextOptions extends ParseScriptOptions {
  client: FlowKintoneClient;
  // ...
  onChunkWritten?: (
    info: FlowChunkWrittenInfo
  ) => void | Promise<void>;
}
```

変更後:

```ts
export interface CreateExecutionContextOptions extends ParseScriptOptions {
  client: FlowKintoneClient;

  /**
   * 素の UPSERT で kintone native UPSERT の利用を許可する。
   * 省略時および false は現行経路。既定 false。
   */
  enableNativeUpsert?: boolean;

  // ...
  onChunkWritten?: (
    info: FlowChunkWrittenInfo
  ) => void | Promise<void>;
}
```

このフラグは `/flow` の `createExecutionContext` だけから設定できる公開 opt-in とする。`createExecutionContext` は現在、公開 options から実行用 options を構成し、execute と preview の双方に同じ managed context を渡している（`src/flow-library/index.ts:109-152`）。B173 でも同一の値を両方から参照させる。

CLI、プラグイン、および従来の単文・バッチ実行 APIへ同名の opt-in を追加しない。

### 3.3 `FlowChunkWrittenInfo`

変更前:

```ts
export interface FlowChunkWrittenInfo {
  statementIndex: number;
  appId: number;
  operation: "INSERT" | "UPDATE" | "DELETE";
  records: number;
  chunkIndex: number;
  lastKeyValue?: string;
}
```

現行定義は `src/flow-library/publicTypes.ts:154-165` にある。

変更後:

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

  /**
   * 単一キー UPSERT ではソース順で当該リクエストの最後にあるキー。
   */
  lastKeyValue?: string;
}
```

native UPSERT の通知は、INSERT/UPDATE の内訳にかかわらず常に次の形とする。

```ts
{
  operation: "UPSERT",
  records: insertedCount + updatedCount,
  insertedCount,
  updatedCount,
  lastKeyValue
}
```

`insertedCount` と `updatedCount` は型上 optional とするが、`operation === "UPSERT"` の通知では両方を必ず設定する。既存の3操作では両プロパティを設定しない。

`operation` の union 拡大は exhaustive switch を持つ TypeScript 利用者には型上の破壊的変更となる。ただし、新値は利用者が `enableNativeUpsert: true` を明示し、能力を持つクライアントを渡した場合にしか観測されない。既定 OFF の既存利用者には新値が送られないため、この限定された union 拡大を許容する。

### 3.4 変更しない公開型

次は変更しない。

```ts
export interface FlowUpsertResult {
  type: "UPSERT";
  insertedCount: number;
  updatedCount: number;
}
```

現行型は `src/flow-library/publicTypes.ts:219-223` にある。native か現行経路かは結果型に露出させない。

`ExecutionMetrics` に新しいカウンタは追加しない。native UPSERT は HTTP PUT であるため、1回の `upsertRecords` 成功・失敗呼び出しにつき既存の `putCalls` を1増やす。現行のカウンタ定義は `src/flow-library/publicTypes.ts:179-200`、既存 PUT 計上は `src/execute.ts:968-978` にある。

## 4. native 適用可否

### 4.1 判定単位

判定単位は1文全体とする。

同じ文の一部だけを native、残りを現行経路に流してはならない。ソース重複、空文字、schema 不明などが1行でもあれば、その文全体を現行経路へ戻す。

### 4.2 単一の共有判定

本実行と `previewStatement` は、同じ入力から同じ結果を返す単一の適格性判定を共有しなければならない。別々の条件式を実装してはならない。

共有判定の入力は、少なくとも次を含む。

- `enableNativeUpsert` の値
- 実行入口でラップ済みの client
- UPSERT 文の構文情報
- IMPORT 由来かどうか
- 対象フィールドの schema
- 評価・materialize 済みの全ソース行のキー値
- キーフィールドの型

本実行では、全ソースレコードの組み立てと既存の書込値検証が完了した後、既存対象を検索する直前に判定する。

preview でも同じ段階で同じ判定を行う。`previewUpsertRecords` は判定に必要な全行の `records` を受け取り、全行の `rowKeys` も既に構築しているため、空文字およびソース内重複を含む6条件を本実行と同じ入力で評価できる（`src/execute.ts:2605-2621`）。

ただし preview は判定結果が native であっても既存対象の GET を省略しない。GET は `counts`、before/after、sample の構成に必要であり、現行処理は `src/execute.ts:2605-2644` にある。

### 4.3 判定順序

次の順序で判定し、最初に満たさない条件が見つかった時点で不適格とする。判定理由は公開結果や警告には追加しない。

1. クライアント能力

   `upsertRecords` が能力として存在し、かつ関数でなければならない。

   判定は次の両方を要求する。

   ```ts
   "upsertRecords" in client
   && typeof client.upsertRecords === "function"
   ```

   `typeof` だけで判定してはならない。readonly client は write property の `get` をブロック関数として返す一方、`has` では存在しないと報告するためである（`src/engine-library/readonlyClient.ts:74-83`）。

2. 明示 opt-in

   `enableNativeUpsert === true` を要求する。`undefined`、`false`、その他の値は不適格とする。

3. キー schema

   次のすべてを要求する。

   - `keyFields.length === 1`
   - schema にそのフィールドが存在する
   - `fieldType` が `"SINGLE_LINE_TEXT"` または `"NUMBER"`
   - `isUnique === true`

   `isUnique === undefined` は不適格とする。dialect 1 の既存検証は不明な `isUnique` を warning とするが（`src/core/dialect1Validation.ts:115-126`）、native の能力選択では曖昧な schema を許可しない。

   dialect 0 / 1 自体は条件にしない。どちらの dialect でも上記 schema を満たせば候補にできる。

4. 素の UPSERT

   次のどちらかだけを適格とする。

   - CHECK、APPLY、VALIDATE ONLY、ON ERROR SKIP を伴わない `UPSERT VALUES`
   - CHECK、VALIDATE ONLY、ON ERROR SKIP を伴わず、IMPORT 由来でもない `UPSERT SELECT`

   dialect 1 でも CHECK 付き UPSERT は構文上受理されるため、dialect を根拠に素の UPSERT と仮定してはならない（`docs/internal/ksql_b173_native_upsert_update_key_issue.md:92-99`）。

5. 空文字キーなし

   全ソース行について、評価後のキー値が `""` でないことを要求する。

   空文字の `updateKey.value` は kintone が `CB_VA01` で拒否する。一方、現行経路は空文字を含むキーを行ごとの GET で処理するため（`src/execute.ts:7252-7262`、`src/execute.ts:7279-7292`）、空文字を明示エラーにはせず現行経路へ戻す。

6. ソース内キー重複なし

   評価・materialize 済みの全ソース行を一括して検査する。100件の書込チャンクごとではなく、文のソース全体をスコープとする。

   同値性は次のとおり。

   - `SINGLE_LINE_TEXT`: 文字列の完全一致
   - `NUMBER`: exact-decimal 正規化後の一致

   したがって、NUMBER の `"5"` と `"5.0"` は重複、文字列の `"001"` と `"1"` は別キーである。現行の NUMBER 正規化規則は `src/execute.ts:7188-7212` にある。

### 4.4 不適格時の扱い

6条件のどれかを満たさない場合は、その文全体を静かに現行経路へ戻す。

- 新しい警告を出さない。
- 新しいエラーを出さない。
- native を一度試してから現行経路へ再試行してはならない。
- 適用判定だけを目的とする API 呼び出しを増やさない。
- 現行の対象 GET、POST、PUT の順序を変えない。
- `onChunkWritten` の通知列を変えない。
- preview の `estimatedWrites` は現行式を使う。

schema と型は、既に書込検証で取得するフォーム定義を使う。追加の `getFields` や `getNumberPrecision` を発行してはならない。現行の書込フィールド読込位置は `src/execute.ts:10535-10544` および `src/execute.ts:11135-11141` にある。

## 5. ソース内キー重複

重複時は選択肢 (a)「現行経路へ落とす」を採用する。

理由は、現行の素の UPSERT が重複を一律エラーにしていないためである。特に既存レコードに対する重複行は、同じ `$id` を複数回 PUT して後勝ちで成功する（`docs/internal/ksql_b173_native_upsert_update_key_issue.md:138-145`）。B173 で明示エラーにすると、opt-in が性能選択ではなく入力契約の破壊になる。

重複を検出した場合:

- native UPSERT は1回も呼ばない。
- 全行を現行経路で処理する。
- 現行経路で成功するか、重複禁止違反になるかも、現在の処理結果を維持する。
- preview の `counts` と sample は現在の既存判定から構成する。
- preview の `estimatedWrites` は現行式を使う。

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

キー除去の結果、送信用 `record` が空オブジェクトになっても、そのまま `record: {}` として送ってよい。キー以外の書込フィールドがない UPSERT について、`record: {}` の INSERT と UPDATE、および `record` プロパティを省略した INSERT の3形すべてが実機で受理されている。したがって、キーのみの UPSERT も6条件を変更せず native 適格とする（`docs/internal/ksql_b173_native_upsert_update_key_issue.md §3.2`）。

本仕様の公開入力型は `record` を必須とするため、実装はプロパティを省略する必要はなく、空になった場合も `record: {}` を送る。

### 6.2 キー値

`updateKey.value` は必ず文字列で送る。

NUMBER キーも JavaScript の `number` に変換してはならない。VALUES の数値リテラルは raw 表現、SELECT の値は materialize 後の文字列表現を維持する。安全整数を超える値も、アプリの `numberPrecision` に収まる限りそのまま送る。

現行の VALUES キー抽出は数値リテラルの raw text を維持している（`src/execute.ts:10597-10606`）。実機でも16桁・20桁の NUMBER キーを文字列のまま `updateKey` に渡せば照合できている（`docs/internal/ksql_b173_native_upsert_update_key_issue.md:142-145`）。

### 6.3 キーの除去

次のように、キーフィールドを `record` と `updateKey` の両方へ重複して載せてはならない。

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

キーだけの UPSERT では次も許可する。

```json
{
  "updateKey": {
    "field": "key_text",
    "value": "K1"
  },
  "record": {}
}
```

キーを `record` に含めると kintone は INSERT、UPDATE、同値、別値のいずれも `CB_VA01` で拒否する。一方、INSERT 時のキーフィールド値は `updateKey` から登録される（`docs/internal/ksql_b173_native_upsert_update_key_issue.md:136-145`）。

## 7. 書込順と結果

### 7.1 書込順

native 適格な文では、ソース順のまま100件単位で `upsertRecords` を呼ぶ。

現行の「INSERT 全チャンクを POSTした後、UPDATE 全チャンクを PUTする」順序（`src/execute.ts:10578-10588`、`src/execute.ts:11208-11218`）とは異なる。この差は opt-in 時だけ許容する。

ただし、書込前の確認契約は変更しない。全ソースレコードの構築、現行と同じ書込値検証、および native 適格性判定が完了した後、最初の `upsertRecords` を呼ぶ直前に、現行経路と同じ引数で次を実行する。

```ts
const total = records.length;

if (options.confirm && total > 0) {
  const ok = await options.confirm(total, "UPDATE");
  if (!ok) throw new OperationCancelledError("UPDATE", total);
}
```

- 件数は INSERT/UPDATE の内訳ではなく、その文の書込対象となる合計件数とする。
- 第2引数は現行と同じ `"UPDATE"` とする。
- 複数チャンクでも `options.confirm` は最初の書込リクエスト前に1回だけ呼ぶ。
- `false` が返った場合は `OperationCancelledError("UPDATE", total)` を変更せず送出する。
- 確認を拒否された場合は `upsertRecords`、`postRecords`、`putRecords` のいずれも呼ばない。
- 0件の場合は現行と同様に `options.confirm` を呼ばない。

現行の `UPSERT VALUES` と `UPSERT SELECT` も、それぞれ最初の POST より前に合計件数と `"UPDATE"` を渡して確認し、拒否時に同じ例外を送出している（`src/execute.ts:10571-10576`、`src/execute.ts:11201-11206`）。

opt-in の公開入口が現時点で `/flow` 限定であることを理由に、この確認段を省いてはならない。native 分岐を持つ `executeUpsert` / `executeUpsertSelect` は共有関数であり、将来 opt-in を CLI、プラグインまたは他の実行面へ公開した場合に、確認なしで書き込む経路を残さないためである。

0行の場合は `options.confirm` と `upsertRecords` のいずれも呼ばず、次を返す。

```ts
{
  type: "UPSERT",
  insertedCount: 0,
  updatedCount: 0
}
```

### 7.2 結果の内訳

各 native レスポンスについて、リクエスト行と同じ順序で返る `records[]` を検査する。

- `operation === "INSERT"` の数を `insertedCount` に加算する。
- `operation === "UPDATE"` の数を `updatedCount` に加算する。
- `revision` の値から INSERT/UPDATE を推測しない。
- `id` と `revision` はレスポンス契約として受け取るが、`FlowUpsertResult` には追加しない。

全チャンク成功後に次を返す。

```ts
{
  type: "UPSERT",
  insertedCount: 全レスポンスの INSERT 件数,
  updatedCount: 全レスポンスの UPDATE 件数
}
```

実機では、100件の混在リクエストについて、先頭50件の `operation` が `"UPDATE"`、後続50件が `"INSERT"` として、100件すべてがリクエスト順に返った。全件の `id` と `revision` は欠落なく文字列であり、所要時間は617msだった。このため、100件上限でもレスポンス順による内訳集計と、リクエスト最後のキーによる `lastKeyValue` の構成が成立する（`docs/internal/ksql_b173_native_upsert_update_key_issue.md §3.2`）。

### 7.3 不正なレスポンス

次のいずれかは、不正なクライアントレスポンスとして fail-closed にする。

- `records` が配列でない。
- `records.length` が送信件数と一致しない。
- 各要素の `operation` が `"INSERT"` / `"UPDATE"` 以外。
- `id` または `revision` が文字列でない。

この場合、現行経路へ再試行してはならない。既に書込が確定した可能性があるためである。

公開されるエラーは次とする。

```text
code: NativeUpsertResponseError
message: NativeUpsertResponseError: upsertRecords returned an invalid response.
```

## 8. クライアントとラッパー

任意メソッドは、能力の無い client にラッパーが能力を付与しないよう、すべて条件付きで公開する。

### 8.1 `createKintoneClient`

`src/flow-library/writableClient.ts` の同梱クライアントにだけ `upsertRecords` を実装する。現行 `putRecords` はリクエスト結果を捨てている（`src/flow-library/writableClient.ts:139-148`）。

`upsertRecords` は:

- `PUT /records.json` を使用する。
- `params` の `app`、`upsert: true`、`records` をそのまま body に送る。
- レスポンスの `records` を捨てずに返す。
- guest space、認証、timeout、HTTP error の扱いは既存の共通 request 処理を使う。

### 8.2 `wrapClientWithMetrics`

現行はメソッド列挙型である（`src/execute.ts:914-996`）。

- 内側に `upsertRecords` がある場合だけ、外側にも追加する。
- 1呼び出しにつき `metrics.putCalls` を1増やす。
- 内側に無い場合は、外側の `"upsertRecords" in client` も false にする。
- 戻り値をそのまま返す。

### 8.3 `withRequestGate`

現行はメソッド列挙型で、書込を `runMutation` に載せる（`src/api/requestGate.ts:164-188`）。

- 内側に能力がある場合だけ公開する。
- `gate.runMutation(() => client.upsertRecords(params))` とする。
- 読取リトライを適用しない。
- 戻り値をそのまま返す。

### 8.4 `routeClient`

現行は論理アプリを物理アプリへ付け替えるメソッド列挙型である（`src/flow-library/index.ts:293-308`）。

- 内側に能力がある場合だけ公開する。
- `params.app` を物理アプリ ID に置換する。
- `upsert`、`records`、`updateKey`、`record` は変更しない。
- 戻り値をそのまま返す。

### 8.5 `wrapClientWithPreviewWriteBlock`

現行はスプレッド後に3書込メソッドを塞いでいる（`src/execute.ts:1984-1995`）。

- 内側に `upsertRecords` がある場合だけ、同名の blocked method で上書きする。
- 呼ばれた場合は既存書込と同じ例外を送出する。

```text
PreviewWriteBlockedError: previewStatement blocked a write API call.
```

- 内側に能力がない場合は、blocked method 自体を追加しない。
- preview の適格性判定は blocked method の存在を「通常実行時には能力あり」と解釈できるが、preview 処理から実際に呼んではならない。

### 8.6 `wrapClientWithChunkWrittenCallback`

現行は POST / PUT / DELETE の成功後に通知する（`src/execute.ts:2114-2167`）。

- 内側に能力がある場合だけ `upsertRecords` をラップする。
- native response の構造と件数を検査する。
- 成功した1リクエストにつき1回だけ通知する。
- `operation` は常に `"UPSERT"`。
- `records` はリクエスト件数。
- `insertedCount` / `updatedCount` は response の `operation` から集計する。
- `lastKeyValue` はリクエスト最後の `updateKey.value`。
- callback を await してから response を呼び出し元へ返す。
- callback が throw した場合、その文はエラーになるが対象チャンクは書込済みとする。これは既存コメントの契約と同じである（`src/flow-library/publicTypes.ts:147-151`）。

### 8.7 `projectReadonlyClient`

`WRITE_METHODS` に `"upsertRecords"` を追加する（`src/engine-library/readonlyClient.ts:5-9`）。

readonly client は:

- `"upsertRecords" in client` を false とする。
- 直接 property を取得して呼んだ場合は read-only violation にする。
- native 能力として検出されない。

### 8.8 スプレッド型のその他ラッパー

`wrapClientWithSearchAbort` と cursor scope は client をスプレッドしているため、能力と wrapper 済みの `upsertRecords` をそのまま保持する（`src/execute.ts:1004-1055`）。新しい書込制御は持たないため個別の上書きは不要だが、能力が実行入口まで失われないことをテストする。

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

101行なら、成功時の通知回数は2回で、`records` は100、1となる。INSERT と UPDATE の内訳のために通知回数を増やしてはならない。

`chunkIndex` は現在と同じく、その文で成功通知された書込 API リクエストの0始まり index とする。失敗したリクエストには通知せず、後続リクエストも実行しない。

複数リクエストの部分失敗については、先行リクエストが確定して残り、失敗した後続リクエストの内部は全件ロールバックされることを実機で確認済みである。実測では、chunk1 の P1 更新と P3 挿入が確定した後、chunk2 が `GAIA_IQ28` で失敗し、最終状態は `P1="chunk1"`、`P2="orig"`、`P3="chunk1"` となった（`docs/internal/ksql_b173_native_upsert_update_key_issue.md §3.2`）。

したがって、成功境界は `onChunkWritten` が通知済みのソース順 prefix とする。失敗したリクエスト内の一部成功を通知してはならず、失敗後の後続チャンクも実行してはならない。

## 10. preview と `estimatedWrites`

### 10.1 読取経路

preview は native 適格であっても、既存対象を検索して次を現在と同じ規則で構成する。

- `counts.insert`
- `counts.update`
- before / after
- samples
- `reads`

`previewStatement` は書込を実行しない。現行の preview write block は `src/execute.ts:1984-1995`、UPSERT preview の既存 GET と分類は `src/execute.ts:2605-2644` にある。

### 10.2 算出式

共有した適格性判定が native 適格の場合:

```ts
estimatedWrites =
  Math.ceil((counts.insert + counts.update) / 100);
```

不適格の場合:

```ts
estimatedWrites =
  Math.ceil(counts.insert / 100)
  + Math.ceil(counts.update / 100);
```

UPSERT 以外の式は変更しない。現行式は `src/execute.ts:2472-2481` にある。

判定には、preview 用の write-block client が保持する「通常実行クライアントの native 能力」と、同一 execution context の `enableNativeUpsert` を使う。

## 11. エラー

### 11.1 kintone API エラー

native が選ばれた後に kintone が返すエラーは、現行の writable client と同じ規則で扱う。

既存の HTTP wrapper は、非2xxレスポンスについて:

- `status` を保持する。
- kintone の `code` を Error の `name` に設定する。
- kintone のトップレベル `message` を変更せず使用する。

現行実装は `src/flow-library/writableClient.ts:22-26` および `src/flow-library/writableClient.ts:77-90` にある。

したがって、`upsertRecords` を直接呼んだ場合は、少なくとも次の観測形になる。

```ts
error instanceof Error === true
error.name === "GAIA_IQ28" // または "CB_VA01"
error.message === kintone が返したトップレベル message
```

`errors["records[..."]` のフィールド別詳細を新たに公開する変更は B173 に含めない。現在の共通 request 処理が保持していないためである。

### 11.2 `/flow` の `executeStatement`

`executeStatement` は通常の文実行エラーを throw せず、`StatementResult` の error として返す。現行の変換は `src/execute.ts:2756-2791`、公開 result は `src/flow-library/publicTypes.ts:258-269` にある。

`GAIA_IQ28` の例:

```ts
{
  status: "error",
  kind: "STATEMENT",
  error: {
    code: "GAIA_IQ28",
    message: "「updateKey」に指定した条件にあてはまるレコードが重複しています。"
  }
}
```

`CB_VA01` も同様に:

```ts
{
  status: "error",
  kind: "STATEMENT",
  error: {
    code: "CB_VA01",
    message: "kintone が返したトップレベル message"
  }
}
```

元の Error は現在と同じく `error.cause` に non-enumerable で保持する（`src/execute.ts:2785-2790`）。

### 11.3 native エラー後の fallback 禁止

適格性判定で不適格なら書込前に現行経路へ戻すが、一度でも native リクエストを開始した後の API エラー、レスポンス不正、callback エラーについては現行経路へ再試行してはならない。

先行チャンクが確定済みの可能性があり、再試行すると二重書込や結果件数の誤報になるためである。実機でも、先行チャンクは確定して残る一方、`GAIA_IQ28` で失敗した後続リクエスト内は全件ロールバックされることを確認済みであり、この成功境界を前提とする（`docs/internal/ksql_b173_native_upsert_update_key_issue.md §3.2`）。

通常 UPSERT のエラー結果に `partialSuccess` は追加しない。成功境界は `onChunkWritten` の通知済み prefix とする。

## 12. 移行と互換性

### 12.1 既定 OFF

次のいずれかでは、B173 実装前と同じ動作を保証する。

- `enableNativeUpsert` を省略
- `enableNativeUpsert: false`
- client に `upsertRecords` がない
- 6条件のどれかを満たさない

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
- preview の `counts`、samples、reads、`estimatedWrites`
- 既存のエラー code / message

native 適格な文では、INSERT 対象も HTTP PUT の `upsertRecords` に統合されるため、公開 `ExecutionMetrics.postCalls` は0になる。API呼出し合計は現行と比較可能なまま `putCalls` に計上するが、`postCalls` / `putCalls` の内訳は変化する。

### 12.2 古いクライアント

`upsertRecords` は optional であるため、既存の自前 `FlowKintoneClient` 実装は型・実行とも変更不要である。

能力を宣言していないクライアントに `enableNativeUpsert: true` を渡してもエラーにはせず、現行経路を使う。

### 12.3 CLI とプラグイン

CLI とプラグインの client は `upsertRecords` を実装しない。したがって能力判定が false になり、現行経路を維持する。

トップレベル `upsert` を既存の `putRecords` に混ぜて渡す実装にはしない。CLI とプラグインは `{app, records}` を再構成するためトップレベルの追加値を落とし得ることが、起票文書で確認されている（`docs/internal/ksql_b173_native_upsert_update_key_issue.md:40-52`）。

## 13. 変更するファイル

### Production

- `src/flow-library/publicTypes.ts`
  - native UPSERT の公開入力・レスポンス型を追加する。
  - `FlowKintoneClient.upsertRecords?` を追加する。
  - `CreateExecutionContextOptions.enableNativeUpsert?` を追加する。
  - `FlowChunkWrittenInfo.operation` に `"UPSERT"` を追加する。
  - `insertedCount?` / `updatedCount?` を追加する。

- `src/flow-library/writableClient.ts`
  - `createKintoneClient` に `upsertRecords` を実装する。
  - `PUT /records.json` のレスポンスを返す。
  - 既存の HTTP error 変換を再利用する。

- `src/flow-library/index.ts`
  - opt-in を managed execution context に渡す。
  - 論理アプリ routing で、能力がある場合だけ `upsertRecords` を公開し、`app` を物理 ID に置換する。

- `src/execute.ts`
  - `KintoneClient` に任意の native 能力を追加する。
  - 本実行と preview が共有する適格性判定を追加する。
  - 素の UPSERT VALUES / SELECT に native 書込経路を追加する。
  - IMPORT 由来を明示的に除外する。
  - 全ソース重複検査を行う。
  - キーを除いた payload を100件単位・ソース順で送る。
  - native 書込開始前に、現行と同じ `options.confirm(total, "UPDATE")` を実行する。
  - response の検証と INSERT/UPDATE 集計を行う。
  - metrics、preview write block、chunk callback の各 wrapper で能力を条件付き転送・制御する。
  - preview の `estimatedWrites` を共有判定に連動させる。

- `src/api/requestGate.ts`
  - 能力がある場合だけ `upsertRecords` を `runMutation` 経由で転送する。

- `src/engine-library/readonlyClient.ts`
  - `WRITE_METHODS` に `"upsertRecords"` を追加する。

### 変更しない Production ファイル

- `src/core/dialect1Validation.ts`
  - dialect 1 の構文・schema 検証は変更しない。
  - native 適格性の `isUnique === true` 判定を既存 warning 規則へ混ぜない。

- `src/cli/nodeKintoneClient.ts`
  - 能力メソッドを追加しない。

- `src/ui/kintoneClient.ts`
  - 能力メソッドを追加しない。

### Tests

既存契約の担当 suiteを更新し、B173 の対テストを追加する。

- `src/__tests__/execute.test.ts`
  - native 本実行、fallback、body、順序、結果内訳、重複、NUMBER raw 値、`options.confirm` の引数・位置・拒否時の無書込。

- `src/__tests__/b95MetricsPropagation.test.ts`
  - native 1リクエストが `putCalls` 1として計上されること。

- `src/flow-library/__tests__/previewStatement.test.ts`
  - 条件付き `estimatedWrites`、読取不変、write block。

- `src/flow-library/__tests__/publicApi.test.ts`
  - opt-in、公開結果、`onChunkWritten` の新しい値。

- `src/flow-library/__tests__/b170FlowRequests.test.ts`
  - 同梱 client の URL、method、body、response、HTTP error。

- `src/api/__tests__/requestGate.test.ts`
  - native write が mutation gate を通り、リトライされないこと。

- `src/engine-library/__tests__/readonlyProjection.test.ts`
- `src/engine-library/__tests__/readonlyBypass.test.ts`
- `src/engine-library/__tests__/readonlyNegativeMatrix.test.ts`
  - readonly client が native 能力を報告せず、直接呼出しも拒否すること。

必要なら、上記を横断する `/flow` 統合ケースを `src/flow-library/__tests__/b173NativeUpsert.test.ts` に新設する。

## 14. 受入条件

以下は内部関数の存在ではなく、公開結果、例外、mock client の呼出しで判定する。

### AC-1 既定 OFF

native 能力を持つ mock client を渡しても、`enableNativeUpsert` を省略した UPSERT は:

- `upsertRecords` 呼出し0回。
- 既存対象 GET は従来回数。
- INSERT 対象の `postRecords` が先。
- UPDATE 対象の `putRecords` が後。
- `FlowUpsertResult` は従来値。
- `onChunkWritten` は従来の `"INSERT"` / `"UPDATE"` の通知列。
- preview の `estimatedWrites` は `ceil(insert/100) + ceil(update/100)`。

### AC-2 能力なし

`enableNativeUpsert: true` でも client に `upsertRecords` がなければ、AC-1 と同じ呼出し回数、順序、body、結果になる。能力不足を示すエラーや警告は出ない。

### AC-3 適格な VALUES

単一の重複禁止文字列キーで、1件 UPDATE、1件 INSERT の適格な UPSERT VALUES は:

- 対象解決用 `getRecords` 0回。
- `postRecords` 0回。
- `putRecords` 0回。
- `upsertRecords` 1回。
- body は `app`、`upsert: true`、ソース順の `records` を含む。
- 各 `record` にキーフィールドが存在しない。
- 各 `updateKey.value` に元のキー文字列が入る。
- `metrics.putCalls` は1増える。

### AC-4 適格な SELECT

適格な UPSERT SELECT は:

- SELECT ソース取得の read は現在と同じ順序・回数。
- ソース取得後の対象解決 GET は0回。
- source order のまま native body を作る。
- IMPORT 由来の同形文は native を0回とし、現行経路を使う。

### AC-5 チャンク

101件の適格なソースでは:

- `upsertRecords` は2回。
- 第1 body は先頭100件。
- 第2 body は最後の1件。
- 呼出し順はソース順。
- `metrics.putCalls` は2増える。

### AC-6 結果内訳

mock response が順に:

```ts
["UPDATE", "INSERT", "INSERT"]
```

を返した場合、公開結果は:

```ts
{
  type: "UPSERT",
  insertedCount: 2,
  updatedCount: 1
}
```

となる。revision の値を変えても `operation` が同じなら件数は変わらない。

### AC-7 `onChunkWritten`

AC-6 の1チャンクについて通知は1回だけで、次を満たす。

```ts
operation === "UPSERT"
records === 3
insertedCount === 2
updatedCount === 1
chunkIndex === 0
lastKeyValue === ソース3行目のキー
```

INSERT と UPDATE に分けた2通知を送らない。

### AC-8 preview

同じ適格な101件について:

- 書込メソッドの呼出しはすべて0回。
- 既存対象の read、counts、samples は現在と同じ。
- `estimatedWrites === 2`。

同じ文で opt-in OFF、能力なし、または他の不適格条件がある場合は:

```ts
estimatedWrites
  === Math.ceil(counts.insert / 100)
   + Math.ceil(counts.update / 100)
```

となる。

### AC-9 schema の fail-closed

次の各ケースで `upsertRecords` は0回となり、現行経路を使う。

- 複合キー。
- `fieldType` が対応外。
- キーフィールドが schema にない。
- `isUnique === false`。
- `isUnique === undefined`。

### AC-10 素の UPSERT 限定

次の各ケースで `upsertRecords` は0回となる。

- dialect 1 の CHECK 付き UPSERT。
- APPLY UPSERT。
- VALIDATE ONLY。
- ON ERROR SKIP。
- IMPORT 由来の UPSERT SELECT。

各ケースの既存公開結果または既存エラーは変わらない。

### AC-11 空文字

ソース内にキー `""` が1件でもあれば、文全体で:

- `upsertRecords` 0回。
- 現行対象 GET を実行。
- 残りの非空行も含めて現行経路で処理。

B173 が新しい `CB_VA01` を発生させない。

### AC-12 ソース重複

100件チャンク内または100件境界をまたいで重複するキーがあれば、文全体で:

- `upsertRecords` 0回。
- 現行経路を使用。
- 新しい `ERR_KEY_DUP_SOURCE` を出さない。

既存ありの同一キー2行が現行経路で後勝ち成功するケースは、opt-in ON でも同じ最終結果になる。

NUMBER の `"5"` / `"5.0"` は重複として fallback し、文字列の `"001"` / `"1"` は重複としない。

### AC-13 NUMBER raw 値

キー `9007199254740993` および `12345678901234567890` は:

- `updateKey.value` が同じ文字列。
- mock body に指数表記、丸め値、JavaScript number が現れない。

### AC-14 wrapper の能力保持

能力あり client を各 wrapper に通した場合:

- metrics wrapper、request gate、logical-app route、chunk callback は能力を保持する。
- logical-app route 後の body は物理 app ID。
- request gate は native write を mutation として1回実行し、失敗時に再試行しない。
- capability のない client を各 wrapperに通しても `"upsertRecords" in wrappedClient` は false。
- preview wrapper は能力ありの場合に呼出しを `PreviewWriteBlockedError` で拒否する。
- readonly client は `"upsertRecords" in client === false`。

### AC-15 kintone error

native mock が、`name: "GAIA_IQ28"` と既知 message の Error を reject した場合、`executeStatement` の公開結果は:

```ts
status === "error"
error.code === "GAIA_IQ28"
error.message === mock の message
```

となる。

`CB_VA01` も同様に code とトップレベル message を変更しない。失敗後に `postRecords` または `putRecords` を呼ばない。

### AC-16 不正レスポンス

送信2件に対して response が1件、または未知の operation を返した場合:

```ts
status === "error"
error.code === "NativeUpsertResponseError"
error.message
  === "NativeUpsertResponseError: upsertRecords returned an invalid response."
```

となる。現行経路への再試行は0回。

### AC-17 既存契約の回帰防止

opt-in を指定しない既存の UPSERT fixture 群について、B173 前後で次を完全一致させる。

- 公開 result
- record API の呼出し回数
- GET → POST → PUT の順序
- 各 request body
- callback 通知列
- preview result
- error code / message

### AC-18 `confirm` 拒否

native 適格で書込対象が1件以上ある UPSERT VALUES および UPSERT SELECT において、`options.confirm` が `false` を返した場合:

- `options.confirm` は最初の書込リクエスト前に1回だけ呼ばれる。
- 第1引数は文全体の合計件数。
- 第2引数は `"UPDATE"`。
- `OperationCancelledError("UPDATE", total)` が送出される。
- `upsertRecords` は0回。
- `postRecords` は0回。
- `putRecords` は0回。
- `onChunkWritten` は0回。
- native 適格であっても書込は発生しない。

0件の場合は `options.confirm` を呼ばず、0件の `FlowUpsertResult` を返す。

## 15. 未確認事項

次の3件は本仕様の採否条件ではない。実装レビューまたはリリース前に実機で確認し、結果をレビュー記録またはリリース記録へ残す。

4. 実クライアント経由のエラー message

   `createKintoneClient.upsertRecords` を通して `GAIA_IQ28` / `CB_VA01` を発生させ、公開されるトップレベル `message` の正確な文字列を記録する。

   特に `CB_VA01` のフィールド別 `errors[...]` は現行 wrapper が保持しないため、トップレベル message だけで運用上十分か確認する。

5. 追加権限なしの全件 UPDATE

   レコード追加権限を持たず、編集権限だけを持つトークンで、既存キーだけの native UPSERT が実際に権限エラーになることを確認する。既定 OFF の判断は確定済みだが、利用者向けのエラー例として実レスポンス code / message を記録する。

6. guest space

   guest space 内アプリで同梱 client の native UPSERT が既存 `apiBase` routing と同じ URLへ送られ、response が取得できることを確認する。コード上は共通 request 経路を使えるが、B173 としての実機確認は未実施である。

上記以外の、能力保持、request gate、readonly、論理アプリ routing、重複 fallback、NUMBER raw body、preview write block、metrics、`options.confirm` は mock / integration test で決着でき、実機確認を必須としない。

---

## 16. レビュー記録

レビュー: Claude（[[spec-and-impl-by-codex]] の分担＝codex が仕様と実装、Claude がレビュー・実測・リリース）。
静的な主張は file:line を開いて突き合わせ、動的な主張は実機で確かめた。

### 16.1 R1 レビュー（2026-08-25）→ **R2 で全件反映済み**

**総評: 中核は正しい。直すのは 1 件。** とくに次の 3 点は、レビュー側では出せなかった精度だった。

- **能力検出を `"upsertRecords" in client && typeof … === "function"` の両方で要求する理由**（§4.3 の 1）。`projectReadonlyClient` は write property の `get` を **blocked 関数**として返す一方 `has` は false を返すため、`typeof` だけだと readonly client を「能力あり」と誤検出する（`src/engine-library/readonlyClient.ts:74-83`）。
- **判定単位を 1 文全体に固定したこと**（§4.1）。行ごとに native と現行を混ぜると、書込順・`onChunkWritten`・`estimatedWrites` のすべてが説明できなくなる。
- **native 開始後の fallback を明示的に禁じたこと**（§11.3）。先行チャンクが確定済みの可能性があるため。§16.2 の実測が裏付けた。

| 指摘 | 重大度 | R2 での反映 |
|---|---|---|
| **`options.confirm` の欠落**＝現行の素の UPSERT は書込直前に確認コールバックを呼び、拒否時に `OperationCancelledError` を投げる（`src/execute.ts:10571-10576`・`src/execute.ts:11201-11206`）が、R1 §7.1 の native 書込ループにその段が無く、受入条件にも `confirm` の語が 0 件だった。opt-in が `/flow` 限定なので**今日の到達面では踏めない**が、規定対象は `executeUpsert` / `executeUpsertSelect` という**共有関数**であり、仕様どおり実装すると確認の段が落ちる。将来 opt-in を他面へ出したとき（案 D）に**確認なしで書き込む経路が既に出来上がっている**ことになる | **Major** | §7.1 に確認契約を追加（引数・位置・複数チャンクでも 1 回・拒否時の例外・0 件時は呼ばない）＋**AC-18** 追加＋§13 のテスト対象に追記。**「opt-in が `/flow` 限定であることは省略の理由にならない」という理由づけも仕様本文に残した** |
| `postCalls` が 0 になる互換ノートが無い | 軽微 | §12.1 に明記（合計は `putCalls` に計上され比較可能・内訳が動く） |
| preview で共有判定が実行できる根拠が無い | 軽微 | §4.2 に明記（`previewUpsertRecords` は全行の `records` と `rowKeys` を既に構築している・`src/execute.ts:2605-2621`） |

**レビューで確認して問題がなかった点**（R2 でも不変）:

- §8.5（preview write block）と §10.2（`estimatedWrites`）の噛み合わせ。preview のクライアントは実行用クライアントを**後から**スプレッドして包む（`src/execute.ts:2039`）ので、列挙型ラッパー（§8.2-8.4）が能力を前段で保持していれば `"upsertRecords" in previewClient` は真になり native 式を選べる。§8.5 は「内側に能力がない場合は blocked method 自体を追加しない」としており、**能力の有無を偽らない**。
- §4.3 条件 6 の同値性規則（NUMBER は exact-decimal 正規化・文字列は完全一致）が**現行の `lookupUpsertTarget` と一致**しており（`src/execute.ts:7188-7212`）、fallback したときに結果が変わらない。
- §5 の重複時 fallback（案 a）。現行は「既存あり + ソース重複」を後勝ちで成功させているため明示エラー（案 b）は破壊的。**opt-in は性能選択であって入力契約の変更ではない**という理由づけが妥当。

**R2 で軽微に手を入れた点（レビュー側の編集）**: R1 が測定結果を**自ファイルの行番号**で参照していた 5 か所を、起票文書 §3.2 への参照へ置き換えた（改訂で行番号がずれるため）。§15 の項番が 4・5・6 のままなのは R1 との対応を保つための意図的なもの。

### 16.2 実機で解消した未確認事項（R1 §15 の 1・2・3）

APP4253「B173 native upsert 検証」で測定（起票文書 §3.2 と同じ環境）。**R2 本文へ確定事実として反映済み**。

| R1 §15 | 測定 | 結果 |
|---|---|---|
| **2** | キー以外の書込フィールドが無い UPSERT | **3 形すべて受理**＝`record: {}` で新規（`operation:"INSERT"`・payload は空文字）／同じく更新（`"UPDATE"`）／**`record` プロパティ自体を省略**しても新規（`"INSERT"`）。→ 6 条件の変更は不要 |
| **3** | 100 件・混在の実レスポンス | **100 件すべてがリクエスト順に返る**（先頭 50 = `UPDATE`・後続 50 = `INSERT`）。`id` / `revision` は**全件が文字列**で欠落なし。所要 617ms |
| **1** | 複数リクエストの部分失敗 | **先行リクエストは確定して残る**。後続リクエストが `GAIA_IQ28` で失敗しても、**失敗したリクエストの中では 1 件も適用されない**（全ロールバック）。実測＝chunk1 で P1 更新・P3 挿入が確定 → chunk2 が重複で 400 → 最終状態は `P1="chunk1"` / `P2="orig"`（手つかず）/ `P3="chunk1"` |

測定スクリプト: `scratchpad/b173-measure.mjs`・`b173-measure2.mjs`・`b173-measure3.mjs`。
