# kSQL read-only エンジン・ライブラリ

v3.19.0 から、kSQL の read-only エンジンを他の kintone プラグインや
カスタマイズへ組み込めます。既存 plugin / CLI / MCP の entry とは独立した、
純加法の公開面です。

## インストールと使用例

npm から取り込める plugin / bundler 環境では、依存解決と版固定が明確な npm bundle
を優先してください。

### ESM

```js
import {
  createReadonlyKintoneClient,
  runQuery,
  version,
} from "@rex0220/kintone-sql-tools/engine";

const client = createReadonlyKintoneClient();
const result = await runQuery(
  "SELECT 'ok' AS status, 19 AS release",
  { client, maxRecords: 3000, cursorMaxActive: 2 }
);

console.log(version, result.rows);
// => 3.19.0 [{ status: "ok", release: "19" }]
```

### CommonJS

```js
const {
  createReadonlyKintoneClient,
  runQuery,
  version,
} = require("@rex0220/kintone-sql-tools/engine");

const client = createReadonlyKintoneClient();
runQuery("SELECT 'ok' AS status, 19 AS release", { client })
  .then((result) => console.log(version, result.rows))
  .catch(console.error);
```

### UMD

`dist-engine/ksql-engine.umd.js` を読み込んだ後、consumer は必ず
`window.ksql.get("3.19.0")` で版を明示してください。`window.ksql` 自体を engine
として扱ったり、`versions` の先頭を暗黙選択したりしないでください。

```html
<script src="./ksql-engine.umd.js"></script>
<script>
  // 変数名は consumer 側のコードに残るため、汎用的な `engine` ではなく
  // kSQL のものと分かる名前（`ksqlEngine` 等）を推奨する。
  const ksqlEngine = window.ksql.get("3.19.0");
  const client = ksqlEngine.createReadonlyKintoneClient();

  ksqlEngine.runQuery("SELECT 'ok' AS status, 19 AS release", { client })
    .then((result) => console.log(ksqlEngine.version, result.rows))
    .catch(console.error);
</script>
```

実アプリを読む場合は SQL を、たとえば
`SELECT 顧客名, SUM(金額) AS 合計 FROM APP100 GROUP BY 顧客名` に置き換えます。

## 公開 API

value export は次の5つです。

- `version: string`: build 済みライブラリの版。v3.19.0 では `"3.19.0"`。
- `createReadonlyKintoneClient(options?)`: kintone browser global を使う read-only client。
- `runQuery(sql, options): Promise<QueryResult>`: read-only 単文を実行。
- `explainQuery(sql, options): Promise<ExplainResult>`: `SELECT` / `WITH` / `UNION`
  の plan を返す。SQL 先頭の `EXPLAIN` はあってもなくてもよい。
- `KsqlEngineError`: `code`、`message`、任意の `cause` を持つ公開 error class。

公開型は次の専用 DTO だけです。内部 AST、executor、DML、IMPORT、APPLY、MCP の型は
公開しません。

- query/result: `RunQueryOptions`、`QueryColumn`、`QueryMetrics`、`QueryResult`、
  `ExplainResult`
- client: `ReadonlyKintoneClient`、`ReadonlyGetRecordsParams`、
  `ReadonlyGetRecordsResult`、`ReadonlyKintoneRecord`、
  `ReadonlyKintoneFieldValue`
- Cursor: `ReadonlyCursorOpenParams`、`ReadonlyCursorHandle`、
  `ReadonlyCursorPage`
- metadata: `ReadonlyAppInfo`、`ReadonlyFieldInfo`、`ReadonlyNumberPrecision`、
  `ReadonlyNumberRoundingMode`、`ReadonlyProcessStatuses`、
  `ReadonlyProcessStatusState`
- browser: `CreateReadonlyKintoneClientOptions`

### 結果の値はすべて文字列

`QueryResult.rows` のセルは、NUMBER、日時、集計値、record id を含めて
**すべて `string`** です。`QueryColumn.valueType` も常に `"string"` です。
数値計算や日時処理が必要な consumer は、用途に応じて明示変換してください。

```ts
type QueryResult = {
  type: "query";
  rows: readonly Readonly<Record<string, string>>[];
  columns: readonly { name: string; valueType: "string" }[];
  rowCount: number;
  warnings: readonly string[];
  metrics: QueryMetrics;
};
```

`QueryMetrics` は `recordGetCalls`、`fetchedRows`、`elapsedMs`、
`cursorRecordsScanned` の4項目です。`ExplainResult` は `lines`、`text` と
同じ metrics shape を返します。

## client の供給

### browser factory

`createReadonlyKintoneClient({ cursorMaxActive? })` は kintone ページ内の
`kintone.api` / `fetch` を使います。write method や page lifecycle listener を
公開 client へ追加しません。factory instance ごとに Cursor lease を分離します。

### BYO readonly client

Node や独自 proxy、既存 transport を使う場合は、次の6 read methodをすべて持つ
`ReadonlyKintoneClient` を渡します。

```ts
interface ReadonlyKintoneClient {
  getRecords(params: ReadonlyGetRecordsParams): Promise<ReadonlyGetRecordsResult>;
  openCursor(params: ReadonlyCursorOpenParams): Promise<ReadonlyCursorHandle>;
  getApps(): Promise<readonly ReadonlyAppInfo[]>;
  getFields(appId: number): Promise<readonly ReadonlyFieldInfo[]>;
  getNumberPrecision(appId: number): Promise<ReadonlyNumberPrecision>;
  getProcessStatuses(appId: number): Promise<ReadonlyProcessStatuses>;
}
```

BYO client に余分な write method があっても engine は6 methodだけを別 objectへ射影
します。ただし、guest space の URL、reverse proxy、認証 header、retry、network
policy などの route / transport 契約は **BYO client 側の責務**です。engine は
guest / proxy route を推測、補正、再構築しません。`openCursor()` が返す handle の
`close()` は idempotent にしてください。

## options

`runQuery(sql, options)` と `explainQuery(sql, options)` は、実行前に未知 key と不正値を
拒否します。暗黙の clamp は行いません。

| option | 対象 | 契約 |
|---|---|---|
| `client` | 両方 | 必須。6 read methodを持つ client |
| `maxRecords` | 両方 | 正の safe integer。取得上限 |
| `onLimitReached` | `runQuery` のみ | `"error"` または `"truncate"`。完全入力が必要な query は truncate せず fail-closed |
| `fetchParallel` | 両方 | 正の safe integer。並列取得数 |
| `cursorMaxActive` | 両方 | 1〜5 の整数。query 内 Cursor 上限 |

`createReadonlyKintoneClient()` 自体の option は `cursorMaxActive`（1〜5）のみです。

## read-only 境界

許可する単文は `SELECT`、`WITH`、`UNION [ALL]`、`SHOW APPS`、`DESCRIBE` です。
`explainQuery()` の対象は read-only の `SELECT`、`WITH`、`UNION [ALL]` に限ります。

次は parse できても `READ_ONLY_VIOLATION` で拒否します。

- DML: `INSERT`、`UPDATE`、`UPDATE ... FROM`、`UPSERT`、`DELETE`、`REORDER`
- `APPLY` を含む文
- `IMPORT`
- `VALIDATE`、DML の `VALIDATE ONLY`
- `CREATE TEMP TABLE`、`DROP TEMP TABLE` と一時表を使う batch
- `SET`、`DECLARE`、`ASSERT`
- セミコロン区切りの複文

malformed SQL は `PARSE_ERROR` です。allowlist と、write methodを持たない client
射影の二重境界で mutation API を呼ばないようにします。

### 検索打ち切りと Cursor

client が `searchAborted: true` を返した場合、simple query、JOIN、GROUP BY を問わず
常に `SEARCH_ABORTED` の **hard error** です。部分行や warning result は返しません。

query が開いた Cursor は、成功、query error、次ページ error のいずれでも query 終了時
に `close()` します。close error が主 error を隠すことはありません。

## Cursor が使われる条件

`openCursor()`（kintone の Cursor API `/records/cursor.json`）が呼ばれるのは、
**`KORDER BY` の窓が単発 GET に収まらない場合だけ**です。それ以外の読み取りでは
呼ばれません。

### 使われる

`KORDER BY` を含み、かつ次の**いずれか**に当てはまるとき（＝単発 GET の条件を
満たさないとき）:

- `LIMIT` が **500 超**
- `OFFSET` が **10,000 超**
- `LIMIT` が `maxRecords` 超

さらに Cursor 実行には **`OFFSET + LIMIT ≤ maxRecords`** が必要です。これを超えると
**レコード取得も Cursor 作成もせずに**失敗し、**別方式へフォールバックしません**。
公開 `code` は `EXECUTION_ERROR` で、`message` に理由
`KORDER_SCAN_ROWS_EXCEEDS_MAX_RECORDS(scanRows=..., maxRecords=...)` を含みます。
`maxRecords` を上げるか、`LIMIT` / `OFFSET` を小さくするか、`ORDER BY`（ローカル整列）
へ切り替えてください。

```js
// Cursor を使う（LIMIT 501 > 500）
await runQuery("SELECT $id FROM APP100 KORDER BY $id LIMIT 501", {
  client,
  maxRecords: 1000,   // OFFSET + LIMIT = 501 ≤ maxRecords が必要
});
```

### 使われない

- **通常の `SELECT` / `ORDER BY` / JOIN / 集計 / CTE などのページング**。1万件超でも
  Cursor API ではなく `$id` シーク方式（前ページ末尾の `$id` より大きい行を取得）で
  進みます。したがって `openCursor()` は呼ばれず、`cursorMaxActive` も影響しません。
- `KORDER BY` でも窓が単発 GET に収まる場合（`LIMIT ≤ 500` かつ `OFFSET ≤ 10,000`
  かつ `LIMIT ≤ maxRecords`）。
- `explainQuery()`。plan の生成のみでレコード取得も Cursor 作成も行いません。

### 上限

`cursorMaxActive`（既定 2・1〜5）は **その client instance 内で同時に開ける Cursor の
上限**です。超過は Cursor 作成前に fail-closed になります。kintone 側のホスト単位の
上限は最大 5 で、独立コピー間では協調しません（[複数コピーと Cursor 上限](#複数コピーと-cursor-上限)）。

### KLIKE との関係

`KLIKE`（kintone ネイティブ検索への押し下げ）を使うクエリは **Cursor を使いません**。
`KORDER BY` が `KLIKE` との併用を受け付けないためです。

```js
// NG: KORDER BY と KLIKE は併用できない
// → EXECUTION_ERROR / message に KORDER_KLIKE_UNSUPPORTED
await runQuery("SELECT $id FROM APP100 WHERE 名前 KLIKE 'ケン' KORDER BY $id LIMIT 501", { client });

// OK: KLIKE は WHERE がネイティブ like へ押し下がる（Cursor は使わない）
await runQuery("SELECT $id FROM APP100 WHERE 名前 KLIKE 'ケン' ORDER BY $id", { client });
```

そのため `KLIKE` で並び順が必要なときは `ORDER BY`（ローカル整列）を使うか、順序を
指定せず既定順のまま受け取ります。

**注意**: `KLIKE` は kintone 側で検索が実行されるため、ヒット件数が多いと
**10 万件の検索打ち切り**に当たりやすくなります。打ち切りが起きた場合は
（他のクエリ形と同様に）常に `SEARCH_ABORTED` の hard error で、部分結果は返りません。
広くヒットする `KLIKE` は他の条件で絞り込んでください。

## error code

`KsqlEngineError.code` は次の固定 union です。

| code | 意味 |
|---|---|
| `PARSE_ERROR` | 字句／構文エラー、空文、複文など入力を単一文として解釈できない |
| `READ_ONLY_VIOLATION` | 公開 read-only allowlist 外、または write boundary への到達 |
| `SEARCH_ABORTED` | kintone の検索が打ち切られた。部分結果なし |
| `FETCH_LIMIT_EXCEEDED` | 許可された取得上限を超えた |
| `CLIENT_ERROR` | transport / kintone API client が返したエラー |
| `EXECUTION_ERROR` | 上記以外の planning / execution エラー |

`message` の完全一致へ依存せず `code` で分岐してください。元 error がある場合は
`cause` に保持されます。

```js
try {
  await runQuery(sql, { client });
} catch (error) {
  if (error instanceof KsqlEngineError && error.code === "SEARCH_ABORTED") {
    // 部分結果は存在しない。再検索条件や取得範囲を見直す。
  }
  throw error;
}
```

## 複数コピーと Cursor 上限

UMD registry は複数版を共存させますが、独立した engine copy / client instance 間で
Cursor lease を協調しません。

- 同じページで使う独立コピーの `cursorMaxActive` の**合計を5以下**にする。
- 3コピー以上を同時に使う場合は、通常それぞれ `cursorMaxActive: 1` にする。
- 自分が管理しない第三者 plugin も Cursor を使うページでは、全 copy の合算上限を
  consumer だけで保証できない。host の Cursor 上限エラーを前提に、同時実行数を減らす。

npm で依存を集約できる plugin は、別々の UMD copy を持ち込まず npm bundle を優先すると
版と Cursor 運用を管理しやすくなります。
