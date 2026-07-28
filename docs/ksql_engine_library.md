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
  KsqlEngineError,
  runBatch,
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

const batch = await runBatch(
  "CREATE TEMP TABLE #ids AS SELECT $id FROM APP100; SELECT * FROM #ids",
  { client }
);
console.log(batch.results.at(-1)?.rows);
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

value export は次の6つです。

- `version: string`: build 済みライブラリの版。v3.19.0 では `"3.19.0"`。
- `createReadonlyKintoneClient(options?)`: kintone browser global を使う read-only client。
- `runQuery(sql, options): Promise<QueryResult>`: read-only 単文を実行。
- `runBatch(sql, options): Promise<BatchResult>`: read-only 複文を順次実行。一時テーブル、
  `SET` / `DECLARE`、`ASSERT` を含められる。
- `explainQuery(sql, options): Promise<ExplainResult>`: `SELECT` / `WITH` / `UNION`
  の plan を返す。SQL 先頭の `EXPLAIN` はあってもなくてもよい。
- `KsqlEngineError`: `code`、`message`、任意の `cause` を持つ公開 error class。

公開型は次の専用 DTO だけです。内部 AST、executor、DML、IMPORT、APPLY、MCP の型は
公開しません。

- query/result: `RunQueryOptions`、`RunBatchOptions`、`QueryColumn`、`QueryMetrics`、
  `QueryResult`、`BatchResultItem`、`BatchStatementInfo`、`BatchResult`、`ExplainResult`
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
  columns: readonly {
    name: string;
    valueType: "string";
    fieldType?: string;
    sortKind?: "number" | "string";
    sourceApp?: number;
  }[];
  rowCount: number;
  warnings: readonly string[];
  validateStats?: {
    errorRecords: number;
    errorCount: number;
    constraintMetadata?: {
      present: ("required" | "length" | "range" | "choice")[];
      absent: ("required" | "length" | "range" | "choice")[];
    };
  };
  metrics: QueryMetrics;
};
```

`QueryColumn` の追加メタはすべて optional です。

- `fieldType`: 元の kintone フィールド型（`NUMBER`、`DROP_DOWN`、`__ID__` など）、
  または engine が導出した擬似型（`KSQL_NUMBER`、`KSQL_STRING`、
  `KSQL_UNKNOWN` など）。
- `sortKind`: 列の比較種別。決定できる場合は `"number"` または `"string"`。
  unsupported な列では `undefined`。型が安全に確定しない列は
  `KSQL_UNKNOWN` / `"string"` へ degrade する場合があります。
- `sourceApp`: CTE / 一時テーブルを介さない物理 SELECT で、出力列が直接の
  フィールド参照または `$id` 等のシステム列として一意な物理アプリへ解決できる場合の
  app ID。式、集計、CASE、曖昧な JOIN 列、CTE / 一時テーブル由来の列では
  `undefined` です。UNION では左右が同じ app ID に一致するときだけ保持します。

`undefined` のメタ項目は結果オブジェクト自体に含まれません。consumer は追加メタの
存在を前提にせず、必要に応じてフォールバックしてください。

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

`runQuery(sql, options)`、`runBatch(sql, options)`、`explainQuery(sql, options)` は、
実行前に未知 key と不正値を拒否します。暗黙の clamp は行いません。

| option | 対象 | 契約 |
|---|---|---|
| `client` | 3 API | 必須。6 read methodを持つ client |
| `maxRecords` | 3 API | 正の safe integer。取得上限 |
| `onLimitReached` | `runQuery` / `runBatch` | `"error"` または `"truncate"`。完全入力が必要な query は truncate せず fail-closed |
| `fetchParallel` | 3 API | 正の safe integer。並列取得数 |
| `cursorMaxActive` | 3 API | 1〜5 の整数。query 内 Cursor 上限 |
| `variables` | `runBatch` | `DECLARE` 変数への文字列注入。キーは `@` なし・大文字小文字を区別しない。`SET` 変数へは注入不可 |
| `tempTableMaxRows` | `runBatch` | 一時テーブル1表の実体化上限。既定10,000。超過は `onLimitReached: "truncate"` でも error |

`createReadonlyKintoneClient()` 自体の option は `cursorMaxActive`（1〜5）のみです。

## read-only 境界

利用可能な構文は API ごとに異なります。

| API | 利用可能な構文 |
|---|---|
| `runQuery()` | 単文の `SELECT`、`WITH`、`UNION [ALL]`、`SHOW APPS`、`DESCRIBE` / `DESC`、既存レコードの `VALIDATE` |
| `runBatch()` | 上記の行を返す文、`CREATE TEMP TABLE ... AS SELECT/WITH`、`DROP TEMP TABLE`、`SET`、`DECLARE`、`ASSERT`、`EXPLAIN` |
| `explainQuery()` | 単文の `SELECT`、`WITH`、`UNION [ALL]`。SQL 先頭の `EXPLAIN` は任意 |

次は parse できても `READ_ONLY_VIOLATION` で拒否します。

- DML: `INSERT`、`UPDATE`、`UPDATE ... FROM`、`UPSERT`、`DELETE`、`REORDER`
- `APPLY` を含む文
- `IMPORT`
- DML の `VALIDATE ONLY`

malformed SQL は `PARSE_ERROR` です。allowlist と、write methodを持たない client
射影の二重境界で mutation API を呼ばないようにします。

### `VALIDATE` のメタデータ完全性と内訳集計

既存レコードの `VALIDATE` が検証できる制約は、client の `getFields()` が返す
`ReadonlyFieldInfo` に依存します。`required`、`minLength`、`maxLength`、
`minValue`、`maxValue`、`optionOrder` を渡さない場合、`VALIDATE` は該当する制約を
検証せず、違反があっても0件を返すことがあります。

`createReadonlyKintoneClient()` は `/k/v1/app/form/fields.json` の制約メタデータを
自動的に渡すため、factory 利用者の変更は不要です。BYO readonly client は同 API の
値を `ReadonlyFieldInfo` へ渡してください。

`validateStats.constraintMetadata` は、実際の `VALIDATE` 対象フィールドについて、
client から渡された制約メタデータの種別を開示します。`present` は含まれていた種別、
`absent` は既知4種のうち含まれていなかった種別です。対応は
`required`＝必須、`length`＝`minLength` / `maxLength`、`range`＝
`minValue` / `maxValue`、`choice`＝`optionOrder` です。配列はこの順で安定します。

```json
{
  "errorRecords": 0,
  "errorCount": 0,
  "constraintMetadata": {
    "present": ["choice"],
    "absent": ["required", "length", "range"]
  }
}
```

これは**入力メタデータの観測事実**であり、「アプリに制約が無い」「BYO client が
制約を落とした」という推測や警告ではありません。たとえば上の結果は
「選択肢だけを検証対象にして0件」までを示します。単に「0件」と読むより、
検証範囲を同時に表示することで誤った安心を避けられます。全4種が `absent` でも
警告は返しません。`CHECK` と NUMBER の型・精度検証は、この4種の
フォーム制約メタデータ一覧には含みません。

`validateStats.errorCount` は集約前の違反総数で、結果行の `$err_count` 合計と一致します。
`$err_code` 別などの内訳は `COUNT(*)` ではなく `SUM($err_count)` で集計してください。
サブテーブルの同一違反は1行へまとまり、本数が `$err_count` に入るためです。たとえば
KPI カードに `errorCount`、隣の棒グラフに `$err_code` 別の `COUNT(*)` を置くと、
同じ画面で合計が食い違って見えます。

```sql
VALIDATE APP100 INTO #err;
SELECT $err_code, SUM($err_count) AS errorCount
FROM #err
GROUP BY $err_code;
```

### `runBatch` の成功・失敗契約

`runBatch()` は文が1つでも失敗したら `KsqlEngineError` を throw し、
`BatchResult` や途中までの `results` を返しません。成功結果に `ok` フィールドは
ありません。失敗した文は error の `statementIndex`（0-based）と
`statementType` で特定できます。

これは、プログラム API で部分結果が完全な結果に見えたままアプリケーションロジックへ
流れ込む事故を防ぐための fail-closed 契約です。

```js
try {
  const batch = await runBatch(sql, { client });
  render(batch.results);
} catch (error) {
  if (error instanceof KsqlEngineError) {
    console.error(error.code, error.statementIndex, error.statementType);
  }
  throw error;
}
```

`BatchResult.results[]` は行を返した文だけを `QueryResult` として格納します。
各要素の `metrics` は**文別計測ではなく、同一のバッチ全体集計値**です。
個々の文の性能コストとして解釈しないでください。

### 一時テーブルのメモリと上限

一時テーブルは `runBatch()` 呼び出し単位で、**利用者アプリのプロセス内メモリ**へ
実体化されます。1表の上限は `tempTableMaxRows`（既定10,000行）で、超過は
`onLimitReached: "truncate"` を指定しても常に error です。同時に存在できるのは
最大16表です。`DROP TEMP TABLE` でメモリと枠を解放すれば、同じバッチ内で次の表に
その枠を再利用できます。

### 一時テーブル、JOIN、server-only 関数

server-only 関数は、入力が物理アプリだけである間に絞り込みへ使ってください。
物理アプリ同士を JOIN する `CREATE TEMP TABLE ... AS SELECT` の source では使えます。
一方、実体化済みの一時テーブルが入力に1つでも含まれる SELECT / JOIN は文全体が
対象外となり、`..._CONTEXT_UNSUPPORTED` で拒否されます。関数を物理アプリ側の列へ
置いても許可されません。

```sql
-- OK: 物理アプリ同士を JOIN し、関数で絞ってから実体化
CREATE TEMP TABLE #当月 AS
  SELECT d.顧客No AS k, d.売上, c.業種
  FROM APP100 d INNER JOIN APP200 c ON d.顧客No = c.顧客No
  WHERE d.受注日 = THIS_MONTH();

-- NG: 一時テーブルが入力に含まれる文で server-only 関数を使う
CREATE TEMP TABLE #x AS SELECT 顧客No, 受注日 FROM APP100;
SELECT *
FROM #x a INNER JOIN APP200 c ON a.顧客No = c.顧客No
WHERE c.受注日 = THIS_MONTH();
```

### 一時テーブル source の計画を読む

`EXPLAIN` / `explainQuery()` は `CREATE TEMP TABLE` 自体を受け付けません。
`AS` 以降の `SELECT`（または `WITH`）を単体で `EXPLAIN` すると、実体化前に使われる
同じ取得・JOIN 計画を確認できます。

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
