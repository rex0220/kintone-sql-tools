# B49 — DESCRIBE 制約付き JSON 出力仕様 R1

- 作成日: 2026-07-21
- ステータス: **R1（仕様案・未実装）**
- 対象: B49「MCP の `DESCRIBE` がフィールド制約を返さず、Claude が kintone API を別途呼ぶ」
- 一次情報: [ksql_issue_tracker.md B49](../ksql_issue_tracker.md#L40)
- 関連仕様: [言語リファレンス §14](../ksql_language_reference.md#L1433)、[multi-statement / temp table spec](ksql_batch_temp_table_spec.md)

## 1. 症状

kSQL MCP で Claude が SQL / DML を組み立てる際、現行の `DESC APPxxx` から分かるのはフィールドコード、ラベル、型だけである。必須、文字列長、数値範囲、選択肢、表示・精度関連設定、lookup / calc の定義、サブテーブル子の所有関係を取得するには、Claude が別途 kintone REST API を呼ぶ必要がある。

これは単なる表示不足ではない。MCP の専用 `ksql_describe_app` も内部では同じ `DESCRIBE APPxxx` を `query` へ渡す（[src/mcp/tools.ts:900-908](../../src/mcp/tools.ts#L900)）。入力 schema も正整数 `app` と接続・fetch option だけで、出力形式 option はない（[src/mcp/schemas.ts:107-115](../../src/mcp/schemas.ts#L107)）。従って SQL 文経由と専用ツール経由の両方が同じ3列に制限される。

```ts
async function describeApp(input: DescribeAppInput): Promise<Record<string, unknown>> {
  return await query({
    sql: `DESCRIBE APP${input.app}`,
    profile: input.profile,
    maxRecords: input.maxRecords,
    fetchParallel: input.fetchParallel,
    onLimit: input.onLimit,
    timeout: input.timeout,
  });
}
```

B49 の目的は、従来の3列表を壊さず、明示オプション時だけ `/k/v1/app/form/fields.json` の応答を欠落なく JSON として返し、MCP の `structuredContent` では LLM が追加の REST 呼び出しなしにオブジェクトとして読めるようにすることである。

## 2. 現状の裏取り

### 2.1 現行 DESCRIBE は3列だけを返す

`executeDescribe` は `getFieldsCached` の各要素から `code` / `label` / `fieldType` だけを3列へ投影する（[src/execute.ts:7290-7302](../../src/execute.ts#L7290)）。

```ts
const fields = await getFieldsCached(stmt.appId, client, cacheContext);
const columns = ["フィールドコード", "ラベル", "タイプ"];
const rows: ProcessRow[] = fields.map((f) => ({
  "フィールドコード": f.code,
  "ラベル":           f.label,
  "タイプ":           f.fieldType,
}));
return { type: "SELECT", rows, columns, rowCount: rows.length };
```

従って、制約は API から一度も取得されていないのではなく、正規化後の情報の一部がこの最終投影で捨てられている。ただし、次節のとおり API 生応答の全情報が `KintoneFieldInfo` に残っているわけでもない。

### 2.2 `KintoneFieldInfo` が実際に保持する範囲

`KintoneFieldInfo` の公開型は次を持つ（[src/execute.ts:220-242](../../src/execute.ts#L220)）。

```ts
export interface KintoneFieldInfo {
  code: string;
  label: string;
  fieldType: string;
  optionOrder?: Record<string, number>;
  sortKind?: "number" | "string";
  semantics?: ResolvedFieldSemantics;
  required?: boolean;
  minValue?: string;
  maxValue?: string;
  minLength?: string;
  maxLength?: string;
  defaultValue?: unknown;
  inSubtable?: boolean;
  writable?: boolean;
  subtableCode?: string;
}
```

実際の変換元 `FormFieldProperty` は `format`、`options`、子 `fields`、上記の基本制約、`defaultValue`、lookup の `fieldMappings[].field` だけを型として読む（[src/core/formFieldInfo.ts:4-19](../../src/core/formFieldInfo.ts#L4)）。変換処理は次のようにフラット化する（[src/core/formFieldInfo.ts:41-78](../../src/core/formFieldInfo.ts#L41)）。

```ts
const info: KintoneFieldInfo = {
  code: field.code,
  label: field.label,
  fieldType: field.type,
  optionOrder,
  sortKind,
  required: field.required,
  minValue: normalizeConstraintValue(field.minValue),
  maxValue: normalizeConstraintValue(field.maxValue),
  minLength: normalizeConstraintValue(field.minLength),
  maxLength: normalizeConstraintValue(field.maxLength),
  defaultValue: field.defaultValue,
  inSubtable,
  ...(subtableCode ? { subtableCode } : {}),
  writable: !lookupCopyFields.has(field.code) && !NON_WRITABLE_FIELD_TYPES.has(field.type),
};
// ...
if (field.fields) out.push(...flattenFields(field.fields, lookupCopyFields, true, ...));
```

現行の保持範囲は次のとおり確定する。

| 情報 | `KintoneFieldInfo` の保持 | 実コード上の扱い |
|---|---|---|
| code / label / type | あり | そのまま保持 |
| required / minValue / maxValue / minLength / maxLength | あり | 空文字を `undefined` に正規化（[formFieldInfo.ts:100-102](../../src/core/formFieldInfo.ts#L100)） |
| defaultValue | あり | `unknown` のまま保持 |
| 選択肢 | **部分的** | label → 数値化した index の `optionOrder` のみ。index を数値化できない要素は落ちる（[formFieldInfo.ts:104-116](../../src/core/formFieldInfo.ts#L104)） |
| サブテーブル子 | **フラット化して保持** | `inSubtable` と `subtableCode` は残るが、API の `SUBTABLE.fields` 入れ子そのものは残らない |
| lookup | **定義は保持しない** | `fieldMappings[].field` をコピー先集合の算出にだけ使い、最終的には `writable` に畳み込む（[formFieldInfo.ts:86-97](../../src/core/formFieldInfo.ts#L86)） |
| calc | **定義は保持しない** | `type` と `format` から `sortKind` を導出するだけで、計算式等は型にも出力にもない（[formFieldInfo.ts:119-128](../../src/core/formFieldInfo.ts#L119)） |
| `digit` / `displayScale` / `unit` 等 | なし | `FormFieldProperty` と `KintoneFieldInfo` のいずれにもプロパティがない |
| アプリ共通の数値精度 | 別経路 | `/k/v1/app/settings.json` を `NumberPrecision { digits, decimalPlaces, roundingMode }` に変換する（[numberPrecision.ts:5-16](../../src/core/numberPrecision.ts#L5)、[numberPrecision.ts:31-43](../../src/core/numberPrecision.ts#L31)） |

従って「`KintoneFieldInfo` を列挙すれば REST 直呼びと同じ情報になる」は成立しない。正規化構造だけでは、完全な選択肢メタデータ、lookup / calc 定義、未知・将来追加プロパティ、元のサブテーブル入れ子を復元できない。

### 2.3 `getFieldsCached` は生 fields JSON を保持しない

`KintoneClient.getFields` の契約自体が `Promise<KintoneFieldInfo[]>` である（[src/execute.ts:184-189](../../src/execute.ts#L184)）。Node クライアントは `/app/form/fields.json` を取得後、`res.properties` を即座に `flattenFormFieldProperties` へ渡して配列だけを返す（[src/cli/nodeKintoneClient.ts:308-318](../../src/cli/nodeKintoneClient.ts#L308)）。プラグイン側も同じである（[src/ui/kintoneClient.ts:179-184](../../src/ui/kintoneClient.ts#L179)）。

```ts
const res = await requestJson<{ properties: Record<string, FormFieldProperty> }>(
  `${apiBasePath}/app/form/fields.json?${qs.toString()}`,
  { method: "GET" },
  appId
);
return flattenFormFieldProperties(res.properties);
```

`getFieldsCached` がキャッシュするのも `Promise<KintoneFieldInfo[]>` だけである（[src/execute.ts:3933-3938](../../src/execute.ts#L3933)、[src/execute.ts:3966-3972](../../src/execute.ts#L3966)）。

```ts
const fieldInfoCache = new Map<string, Map<number, Promise<KintoneFieldInfo[]>>>();

async function getFieldsCached(...) {
  const cached = getScopedCacheValue(fieldInfoCache, cacheContext, appId);
  if (cached) return cached;
  const loading = client.getFields(appId);
  setScopedCacheValue(fieldInfoCache, cacheContext, appId, loading);
  return loading;
}
```

**結論:** 現行キャッシュには生 fields JSON はない。`AS JSON` を実装するには、同じ form fields endpoint の生応答を返すクライアント経路とキャッシュを追加する必要がある。`KintoneFieldInfo[]` からの逆生成は禁止する。

### 2.4 DESCRIBE の parser / AST と soft keyword 前例

statement dispatcher は `DESCRIBE` と `DESC` を同じ `parseDescribe` へ渡す（[src/parser/parser.ts:245-258](../../src/parser/parser.ts#L245)）。現行 parser はアプリ参照を1個だけ読み、サブテーブル参照を拒否し、AST には `appId` しか保存しない（[src/parser/parser.ts:437-445](../../src/parser/parser.ts#L437)、[src/types/ast.ts:46-50](../../src/types/ast.ts#L46)）。

```ts
private parseDescribe(): DescribeStatement {
  this.advance(); // DESCRIBE / DESC
  const name = this.parseIdentifier();
  const { appId, subtableCode } = extractTableRef(name, this.prev());
  if (subtableCode) throw new ParseError(...);
  return { type: "DESCRIBE", appId };
}
```

予約語を増やさない前例として、`CREATE` / `DROP` / `TEMP` / `TABLE` は `IDENT` を値比較する soft keyword で処理される（[src/parser/parser.ts:379-417](../../src/parser/parser.ts#L379)）。`JSON` も IMPORT で既に soft keyword として使われ、通常の `SELECT JSON FROM APP1` を潰さないことがテストされている（[src/parser/parser.ts:530-531](../../src/parser/parser.ts#L530)、[src/parser/__tests__/import.test.ts:22-27](../../src/parser/__tests__/import.test.ts#L22)）。一方 `KLIKE` は `TokenKind` と keyword map に追加された予約語である（[src/lexer/tokens.ts:88-93](../../src/lexer/tokens.ts#L88)、[src/lexer/tokens.ts:248-253](../../src/lexer/tokens.ts#L248)）。B49 は `JSON` の既存 soft keyword 前例を使い、新予約語を増やさない。

### 2.5 現行の結果 shape と raw object の前例

`DESCRIBE` は `ExecuteResult` 上も独自型ではなく `SelectResult` を返す。`SelectResult.rows` は `ProcessRow[]`、`ProcessRow` は `Record<string, string>` であり、セルに任意の object を直接格納する契約ではない（[src/execute.ts:248-256](../../src/execute.ts#L248)、[src/execute.ts:291-307](../../src/execute.ts#L291)、[src/engine/evalWhere.ts:60-66](../../src/engine/evalWhere.ts#L60)）。

CTE も `executeDescribe` の `SelectResult` をそのまま行・列として実体化する（[src/execute.ts:3425-3439](../../src/execute.ts#L3425)）。バッチ envelope も成功した `SELECT` だけを `columns` / `rows` / `rowCount` として結果セットへ積む（[src/output/batchEnvelope.ts:118-143](../../src/output/batchEnvelope.ts#L118)）。従って core の行セルへ object を混ぜる、または新しい result type を追加する案は、CTE・バッチ・CLI の広い変更を伴う。

一方 MCP は全 payload を JSON text と `structuredContent` の両方で返す既存機構を持つ（[src/mcp/tools.ts:460-470](../../src/mcp/tools.ts#L460)）。

```ts
return {
  content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  structuredContent: payload as Record<string, unknown>,
  isError,
};
```

通常の query payload は SELECT の `columns` / `rows` / `rowCount` を写すだけである（[src/mcp/tools.ts:285-294](../../src/mcp/tools.ts#L285)、[src/mcp/tools.ts:715-728](../../src/mcp/tools.ts#L715)）。リポジトリ内には、DESCRIBE が nested object を core result として返す前例はない。MCP payload 自体には object を載せられるため、core では JSON 文字列セル、専用ツールでは parse 済み object、という境界が最小変更になる。

### 2.6 LAPP・プロファイル解決

MCP は parse 前に `resolveSqlContext` を通し、`normalizeSqlAppProfiles` で論理・プロファイル付き参照を mapped `APP<id>` に書き換え、binding と source-aware `cacheContext` を作る（[src/node/runtime.ts:99-130](../../src/node/runtime.ts#L99)）。論理参照は物理解決先と profile を binding に保持する（[src/node/appProfiles.ts:342-370](../../src/node/appProfiles.ts#L342)）。実行時の `getFields` は mapped app ID から binding を引き、該当 profile の client に物理 app ID を渡す（[src/node/runtime.ts:400-405](../../src/node/runtime.ts#L400)）。

```ts
const normalized = normalizeSqlAppProfiles(sql, profileName, resolutionContext);
const bindings = normalized.appBindingByMappedApp;
// ...
cacheContext: buildCacheContext(profileName, bindings),

// routed client
getFields: (appId) => {
  const binding = resolveRuntimeBinding(runtimeContext.sqlContext, appId);
  const routed = runtimeContext.clientsByProfile.get(binding.profile);
  if (!routed) throw new Error(...);
  return routed.getFields(binding.appId);
},
```

従って JSON 用 metadata GET も、この routed client と `cacheContext` を必ず踏襲しなければならない。mapped ID を直接 REST API に渡す、default profile client に固定する、物理 app ID だけでグローバルキャッシュする設計は禁止する。

## 3. 設計

### 3.1 ① 構文

R1 推奨構文は次とする。

```sql
DESCRIBE APP100 AS JSON
DESC APP100 AS JSON
DESCRIBE LAPP_ORDERS AS JSON       -- Node / CLI / MCP の論理解決前処理を使用
DESCRIBE APP100@prod AS JSON       -- profile 構文を使用できる surface
```

- オプションなしの `DESCRIBE APP100` / `DESC APP100` は従来の3列、複数行 `SelectResult` を完全維持する。
- `AS` は既存 `TokenKind.AS` を使い、`JSON` は `IDENT` の値を比較する soft keyword とする。lexer keyword mapは変更しない。
- AST は `format: "TABLE" | "JSON"` を必須で保持する案を推奨する。parser が省略時に `"TABLE"` を設定すれば executor の暗黙 default をなくせる。公開 AST の差分を小さくするなら `format?: "JSON"` も実装可能だが非推奨である。
- `AS` の後が `JSON` 以外、オプション重複、末尾の余剰 token は parse error とする。
- `WITH x AS (DESCRIBE APP100 AS JSON)` は受理する。結果は後述の1行1文字列列なので、既存 CTE 実体化契約を壊さない。

`FULL` / `WITH CONSTRAINTS` / `RAW` より `AS JSON` を推す理由は、出力形式を明示し、将来 `AS YAML` 等を追加でき、`JSON` を既存の soft keyword として再利用できるためである。`RAW` は「どの endpoint の raw か」が構文から不明瞭、`FULL` は正規化表の列追加にも読める。

### 3.2 ② 出力形: raw form fields response を採用

#### 選択肢 A: `KintoneFieldInfo` 正規化 JSON

利点は既存の kSQL 語彙と一致し、`getFieldsCached` をそのまま利用できること。欠点は §2.2 の欠落を仕様上回復できず、Claude が REST API を直に呼ぶ現状を完全には解消しないことである。

#### 選択肢 B: form fields API の生応答（**R1 推奨・採用案**）

`/k/v1/app/form/fields.json` から返った JSON object を、フィールドの削除、rename、flatten、空値正規化をせず保存・返却する。これにより、現行型が知らないプロパティも passthrough でき、サブテーブルの `fields` 入れ子も維持できる。

core の `AS JSON` は既存 `SelectResult` を維持し、次の1行1列とする。

```ts
{
  type: "SELECT",
  columns: ["json"],
  rows: [{ json: JSON.stringify(rawFormFieldsResponse) }],
  rowCount: 1
}
```

JSON は compact 文字列でよい。構造の同一性は `JSON.parse(row.json)` と取得時 object が deep-equal であることを契約とする。キー順と whitespace は契約にしない。

この形なら通常 query、CTE、temp table、read-only batch、CLI の既存 `SelectResult` 消費側を変更しない。CTE から JSON 内部を SQL で照会する関数は今回追加しない。

#### 生応答取得・キャッシュ

現行 `getFieldsCached` から生応答を復元できないため、次を追加する。

```ts
interface RawFormFieldsResponse extends Record<string, unknown> {
  properties: Record<string, unknown>;
}

interface KintoneClient {
  // existing
  getFields(appId: number): Promise<KintoneFieldInfo[]>;
  // B49
  getRawFormFields(appId: number): Promise<RawFormFieldsResponse>;
}
```

- Node / plugin adapter は同じ `/k/v1/app/form/fields.json` を呼び、レスポンス object 全体を無加工で返す。
- executor に `rawFormFieldsCache: Map<cacheContext, Map<appId, Promise<RawFormFieldsResponse>>>` を追加する。失敗 Promise を同じ cache scope で共有する点も `fieldInfoCache` と合わせる。
- request metrics の `fieldCalls` は normalized / raw のどちらの form fields GET でも1回加算する。
- routed client と request gate にも `getRawFormFields` を追加する。現行 request gate は GET 系 `getFields` を read-only retry 対象にしているため（[src/api/requestGate.ts:164-183](../../src/api/requestGate.ts#L164)）、新メソッドも同じ `runReadOnly` 経路とする。
- legacy table と JSON を同じ execute/batch で両方初回取得した場合、最小実装では normalized cache と raw cache が別なので endpoint GET は最大2回になる。R1 はこの稀な混在を許容する。既存 `getFields` 契約を raw-first に全面変更して大量の client mock を更新する最適化はスコープ外とする。

### 3.3 ③ MCP 露出

#### `ksql_query`

`DESCRIBE ... AS JSON` を通常の read-only SQL として受理し、既存 SELECT payload を返す。

```json
{
  "ok": true,
  "type": "SELECT",
  "columns": ["json"],
  "rows": [{ "json": "{\"properties\":{...}}" }],
  "rowCount": 1,
  "warnings": []
}
```

これは SQL / batch の共通結果 shape を維持する経路である。LLM は JSON 文字列を読めるが、MCP client にとっては nested object ではない。

#### `ksql_describe_app`（MCP 推奨経路）

専用ツールには後方互換な optional input を追加する。

```ts
format: z.enum(["table", "json"]).default("table")
```

- 省略または `table`: 現行どおり `DESCRIBE ...` を実行し、SELECT payload を返す。
- `json`: `DESCRIBE ... AS JSON` を実行し、厳密に `columns=["json"]`、1行、string cell であることを検証して `JSON.parse` する。想定外 shape / parse 失敗は `InternalError` として fail-closed にする。
- JSON 時の MCP payload は wrapper の `data` に raw object を無加工で載せる。

```json
{
  "ok": true,
  "type": "DESCRIBE",
  "format": "json",
  "app": "APP100",
  "data": {
    "properties": {}
  }
}
```

`toToolResult` がこれを text JSON と `structuredContent` の両方へ載せるため、Claude は `data.properties` を直接辿れる。「MCP がそのまま利用できる」の主経路はこれと定義する。

専用ツールの `app` は現行の正整数を維持しつつ、論理アプリも表現できる union へ加法拡張する案を推奨する。

```ts
app: z.union([
  z.number().int().positive(),
  z.string().regex(/^LAPP_[A-Za-z][A-Za-z0-9_]{0,63}$/i),
])
```

文字列は上記 regex のみを許し、SQL 断片を自由入力させない。tool の `profile` input と SQL 内 `@profile` を二重化しないため、専用 tool の string app には `@profile` を許可せず、既存 `profile` input を用いる。

### 3.4 ④ サブテーブル子フィールド

JSON モードは行フラット化を行わない。API 生応答の `SUBTABLE` property 配下にある `fields` object をその位置のまま返す。

- 子フィールドをトップレベル `properties` に複製しない。
- `inSubtable` / `subtableCode` の kSQL 独自キーを注入しない。
- 同じ子 code が別テーブルに存在しても、所有テーブルは JSON path で一意に読める。
- 従来 table モードは現行 `flattenFormFieldProperties` の結果を維持する。

### 3.5 ⑤ LAPP・プロファイル整合

- SQL 文経由では、`AS JSON` の有無に関係なく既存 `resolveSqlContext` → mapped APP AST → routed client の順を踏襲する。
- raw cache の scope は既存 `cacheContext` と mapped `appId` の組とする。同じ物理 app ID でも profile / logical source の異なる binding を誤共有しない。
- `getRawFormFields` の runtime routing は現行 `getFields` と同じ `resolveRuntimeBinding` を使用する。
- `allowPhysicalAppRefs:false`、未知 LAPP、token 欠落、未知 profile の既存 fail-closed 挙動を迂回しない。
- プラグイン surface は Node の LAPP/profile rewrite を持たない現行境界を変更せず、物理 `APPxxx` の `AS JSON` だけを扱う。

## 4. 出力例

次は**実 kintone 応答の断定ではなく、passthrough 契約を検証する合成 fixture**である。入力として adapter が次の object を受け取った場合、`JSON.parse(rows[0].json)` および MCP `data` は同じ object と deep-equal でなければならない。

```json
{
  "properties": {
    "件名": {
      "code": "件名",
      "label": "件名",
      "type": "SINGLE_LINE_TEXT",
      "required": true,
      "minLength": "1",
      "maxLength": "100"
    },
    "区分": {
      "code": "区分",
      "label": "区分",
      "type": "DROP_DOWN",
      "options": {
        "A": { "index": "0" },
        "B": { "index": "1" }
      }
    },
    "明細": {
      "code": "明細",
      "label": "明細",
      "type": "SUBTABLE",
      "fields": {
        "数量": {
          "code": "数量",
          "label": "数量",
          "type": "NUMBER",
          "minValue": "0",
          "digit": true,
          "displayScale": "2",
          "unit": "個"
        }
      }
    }
  },
  "revision": "7"
}
```

fixture 中の `digit` / `displayScale` / `unit` / `revision` は、現行 `FormFieldProperty` / `KintoneFieldInfo` に未定義でも削除しないことを試すための sentinel である。R1 は各 unknown key の kintone 意味論を再定義せず、取得 object の保存だけを契約にする。

## 5. 決定点

| ID | 決定点 | 選択肢 | R1 推奨 |
|---|---|---|---|
| D1 | 構文 | `AS JSON` / `FULL` / `WITH CONSTRAINTS` / `RAW` | **`AS JSON`**。`JSON` は既存 soft keyword |
| D2 | AST default | `format?: "JSON"` / `format: "TABLE" | "JSON"` | **必須 discriminant**。省略構文を parser が `TABLE` にする |
| D3 | 情報モデル | normalized `KintoneFieldInfo` / raw form fields response | **raw**。欠落・将来 drift を避ける |
| D4 | core result | 新 result type / object cell / JSON string 1セル | **既存 SELECT の JSON string 1セル**。CTE・batch・CLI を維持 |
| D5 | MCP | query rows のみ / dedicated tool だけ / 両方 | **両方**。専用 tool は parsed object を `structuredContent.data` に返す |
| D6 | サブテーブル | flat rows / nested raw | **nested raw** |
| D7 | raw 取得 | `KintoneFieldInfo` から逆生成 / client の raw GET | **raw GET**。別 cache を持つ |
| D8 | 専用 tool の LAPP | 数値 app のみ / safe union | **safe union**。`profile` は既存 input を使う |
| D9 | app-wide number precision | fields raw のみ / settings を合成 | **fields raw のみ（R1）**。合成は raw 契約を壊し追加 GET になる |
| D10 | mixed table+JSON GET | client 全面 raw-first refactor / 最大2 GETを許容 | **最大2 GETを許容**。最小実装を優先 |

D1〜D10 は R1 の推奨決定であり、Claude / ユーザー承認前は確定扱いにしない。特に D4、D8、D9 は public contract と実装範囲を左右するためレビュー必須である。

### D9 の補足: 「数値精度」の境界

form fields raw 応答に含まれて実際に返った `digit` / `displayScale` / `unit` 等は unknown key を含めそのまま返す。一方、kSQL が整数部桁数検証に使う `NumberPrecision { digits, decimalPlaces, roundingMode }` は `/k/v1/app/settings.json` の別 API であることがコード上確定している。R1 の `AS JSON` は endpoint raw 契約を優先し、settings を合成しない。

Claude の DML 正当性判断に app-wide precision も必須と判断する場合は、次のいずれかを R2 決定点として追加する。

1. `DESCRIBE ... AS JSON WITH SETTINGS` の別オプション。
2. MCP 専用 tool だけ `includeSettings: true` を持ち、`data.formFields` と `data.numberPrecision` を明示分離。

暗黙合成は「form fields API の生 JSON」という D3 の意味を曖昧にするため採用しない。

## 6. SemVer

推奨は **minor** である。

- オプションなしの parser AST 意味、3列、列名、行数を維持する。
- `AS JSON` と MCP optional input は純加法である。
- `JSON` は soft keyword のため同名フィールドを予約語化しない。
- ただし `KintoneClient` TypeScript interface に必須メソッドを追加すると埋め込み利用者には source-level breaking になり得る。公開 API 安定性を重く見る場合は、`getRawFormFields?` を optional にし、JSON モード利用時だけ未実装 client を明示エラーにするか、次 major まで client interface 追加を待つ判断が要る。repo 内蔵 Node/plugin client を対象とする製品 SemVer は minor、core library interface の互換性は Claude レビューで確認する。

## 7. 費用対効果

### 効果

- Claude の「DESCRIBE → 不足を認識 → REST tool を探す → form fields GET → 結果を統合」という追加往復を「`ksql_describe_app(format=json)` 1回」に短縮する。
- raw passthrough なので、kSQL の型追加が追いつかない新プロパティでも Claude が読める。
- nested subtable、lookup / calc の原定義、選択肢の原形を1つの構造で渡せる。
- 既存 table mode を残すため、人間向け一覧や CTE フィルタ用途を損なわない。

### コスト

- parser / AST / executor の小変更。
- Node client、plugin client、runtime router、request gate、metrics wrapper、mock clients に raw GET method を配管。
- raw cache の追加。
- MCP schema / tool の option、shape 検証、JSON parse と structured payload 化。
- docs / smoke / manifest 説明の同期（実装時）。

最大の機械的コストは `KintoneClient` mock 群の更新で、難しいアルゴリズムはない。正規化 `KintoneFieldInfo` を拡張し続ける案より、raw passthrough の方が B49 の目的に対する実装・保守コストは小さい。

## 8. テスト観点

### 8.1 parser / AST

- `DESCRIBE APP1 AS JSON` と `DESC APP1 AS JSON` が同じ AST になる。
- オプションなしは `format:"TABLE"` になり現行 AST 意味を維持する。
- `JSON` が soft keyword のままで `SELECT JSON FROM APP1` を壊さない。
- `AS RAW`、`AS` のみ、`AS JSON JSON`、`DESCRIBE APP1$T AS JSON` を拒否する。
- `WITH x AS (DESCRIBE APP1 AS JSON) SELECT json FROM x` を受理する。

### 8.2 executor / raw 保持

- table mode は既存3列・複数行の snapshot と完全一致する。
- JSON mode は `columns=["json"]`、1行、`rowCount=1`。
- 合成 raw fixture の unknown keys、空文字、boolean、array、nested `fields`、options、lookup / calc 用 object、revision が deep-equal で残る。
- JSON mode が `getFields` を呼ばず `getRawFormFields` だけを1回呼ぶ。
- 同一 `cacheContext + appId` の raw 呼び出しは1 GET、異なる context は共有しない。
- table → JSON 混在は仕様どおり最大2 GET、JSON → JSON は1 GET。
- raw GET failure を normalized data から補完せず、そのまま fail-closed にする。

### 8.3 MCP

- `ksql_query` は JSON string cell を含む通常 SELECT payload を返す。
- `ksql_describe_app` の format 省略 / `table` は現行 payload と SQL `DESCRIBE APPn` を維持する。
- `format=json` は SQL `DESCRIBE ... AS JSON` を実行し、`structuredContent.data` が raw object になる。
- 専用 tool は行欠落、複数行、列名不一致、非 string、invalid JSON を InternalError にする。
- text content と structuredContent が同じ payload を表す。
- 数値 app、`LAPP_NAME + profile`、未知 LAPP、`allowPhysicalAppRefs:false`、token 欠落を既存解決規則どおり扱う。
- app string の regex で SQL injection 断片を拒否する。

### 8.4 Node / plugin / routing / gate

- Node は guest space を含む既存 `apiBasePath` で form fields endpoint を呼び、response 全体を返す。
- plugin は `kintone.api` 応答全体を返す。
- profile routed client は mapped ID を物理 ID に変換して正しい profile client を選ぶ。
- request gate は raw GET を read-only retry / concurrency 対象にする。
- metrics `fieldCalls` が raw GET でも増える。

### 8.5 回帰・契約同期

- 既存 DESCRIBE executor / parser / CTE / batch tests。
- `src/mcp/__tests__/tools.test.ts` の現行期待 `DESCRIBE APP100`（[tools.test.ts:426-433](../../src/mcp/__tests__/tools.test.ts#L426)）。
- 言語リファレンス §14、MCP tool description、schema `.describe()`、README、smoke assertions、CHANGELOG を実装時に同期する。
- browser/plugin 対象リリースでは Node test だけで完了扱いせず、プラグイン実機で nested raw response を確認する。

## 9. スコープ外

- `KintoneFieldInfo` 全体を kintone form fields schema と同じ完全型へ拡張すること。
- JSON 内部を SQL の JSON path / `JSON_VALUE` 等で検索する機能。
- raw response のキー rename、型変換、localization、schema version 固定。
- app settings、layout、views、process management、permissions 等の別 endpoint を暗黙結合すること。
- app-wide `NumberPrecision` の暗黙合成（D9 参照）。
- `DESCRIBE APPxxx$subtable` の解禁。
- legacy table mode の列追加、サブテーブル行表現変更、列名変更。
- form fields response の永続ディスクキャッシュ。
- B49 仕様作成時点でのコード実装、version bump、manifest 更新、commit。

## 10. 完了条件

1. オプションなし DESCRIBE の3列契約が完全に維持される。
2. `AS JSON` は form fields API の取得 object を欠落なく1つの JSON value として返す。
3. 専用 MCP tool の JSON mode は同じ object を `structuredContent.data` に返す。
4. subtable nesting、unknown keys、lookup / calc 関連 object を正規化で失わない。
5. LAPP / profile / token / cache routing は既存 source-aware 経路を迂回しない。
6. raw 未取得・invalid result は推測や逆生成をせず fail-closed にする。
7. D1〜D10 と core library interface の SemVer 判断が承認される。
