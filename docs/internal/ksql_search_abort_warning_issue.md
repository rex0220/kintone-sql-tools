# B7 — プラグイン検索打ち切り検出仕様 R2

- 作成日: 2026-07-15
- 改稿日: 2026-07-21
- ステータス: **R2（実装着手可・未実装）**
- 対象リリース: **v3.10.0（B47 と同梱）**
- 対象: B7「プラグインでの検索打ち切り検出（raw fetch 経路）」
- 前提実装: Node / CLI / MCP の検索打ち切り検出と、実行文種別ごとの警告／fail-closed 切替は実装済み
- 後続依存: [B47 APPLY 複数親 UPDATE の親 WHERE LIKE/KLIKE 仕様 R2](ksql_b47_apply_parent_where_like_spec.md)

## 1. 目的

kintone のレコード取得は、`like` / `not like` による検索が 10 万件に達すると処理を打ち切り、HTTP レスポンスヘッダー `X-Cybozu-Warning: Filter aborted because of too many search results` を返す。Node クライアントはこのヘッダーを読んで `searchAborted` を返すが、現行プラグインの `getRecords` は `kintone.api()` の本文しか受け取れず、打ち切りを実行エンジンへ通知できない。

B7 の目的は、プラグインの `getRecords` でも同じヘッダーを検出し、既存の `KintoneGetResponse.searchAborted` を立てることである。これにより次の2つを実現する。

1. DML の既存 fail-closed をプラグインでも一様に効かせる。これは B47 で KLIKE を全 surface に解禁する安全前提である。
2. プラグイン SELECT が検索打ち切りで静かに切り詰められた場合、既存の警告を結果へ付ける。

`execute()` は文を parse した後、`wrapClientWithSearchAbort(..., !isSelectLikeStatement(stmt))` を適用しており、SELECT / UNION / WITH だけ `failClosed=false`、それ以外は `true` になる（[src/execute.ts:665-688](../../src/execute.ts#L665)、[src/execute.ts:801-817](../../src/execute.ts#L801)、[src/execute.ts:851-862](../../src/execute.ts#L851)）。バッチも文ごとに SELECT / UNION / WITH かを判定して同じ wrapper と警告付与を行う（[src/execute.ts:1376-1390](../../src/execute.ts#L1376)）。したがって B7 は実行エンジンの分岐を増やさず、プラグイン client が正しい `searchAborted` を返すことに集中する。

## 2. 現状と不足

### 2.1 伝播契約は既に存在する

`KintoneGetResponse` は `searchAborted?: boolean` を持ち、`PageFetcher` の戻り値として `fetchAll` まで運べる（[src/api/fetchAll.ts:26-40](../../src/api/fetchAll.ts#L26)）。`fetchAll` は先頭ページを早期 return より前に検査し、並列ページも全レスポンスを検査して `onSearchAborted` を呼べる（[src/api/fetchAll.ts:108-128](../../src/api/fetchAll.ts#L108)、[src/api/fetchAll.ts:164-194](../../src/api/fetchAll.ts#L164)、[src/api/fetchAll.ts:210-212](../../src/api/fetchAll.ts#L210)）。また、実行側 wrapper は単発 `getRecords` の戻り値も直接検査する（[src/execute.ts:801-817](../../src/execute.ts#L801)）。

よって新しいレスポンス型、警告配列、コールバックは不要である。プラグイン `getRecords` が `{ records, searchAborted?: true }` を返せば、単発 GET と `fetchAll` の両方に既存契約が届く。

### 2.2 Node は検出済みだが定数が private である

Node クライアントは現在、ファイルローカルの `SEARCH_ABORTED_HEADER_VALUE` と `res.headers.get("X-Cybozu-Warning")` の `includes` 判定を使う（[src/cli/nodeKintoneClient.ts:48-52](../../src/cli/nodeKintoneClient.ts#L48)、[src/cli/nodeKintoneClient.ts:125-138](../../src/cli/nodeKintoneClient.ts#L125)）。`getRecords` は判定結果が true のときだけ本文へ `searchAborted: true` を合成する（[src/cli/nodeKintoneClient.ts:246-270](../../src/cli/nodeKintoneClient.ts#L246)）。

B7 ではこのメッセージ定数と判定規則を共通モジュールへ移し、Node と plugin が同じ定数／helper を参照する。文字列を2箇所へ重複定義してはならない。

### 2.3 プラグインは本文だけを返している

プラグイン adapter は `KintoneApiWithUrl` と `apiUrl(path) = kintone.api.url(path, true)` を既に持つ（[src/ui/kintoneClient.ts:26-27](../../src/ui/kintoneClient.ts#L26)）。しかし `getRecords` は共通 `api()` helper を通じて `kintone.api()` を呼び、本文の `records` だけを返すため、`searchAborted` を設定できない（[src/ui/kintoneClient.ts:80-105](../../src/ui/kintoneClient.ts#L80)）。

この不足は `getRecords` に限定される。カーソル、書き込み、アプリ一覧、フィールド、数値精度、プロセス管理設定は同じ `api()` helper を使うが（[src/ui/kintoneClient.ts:107-203](../../src/ui/kintoneClient.ts#L107)）、検索打ち切りヘッダーを契約化する対象は `GET /k/v1/records.json` である。

## 3. 設計

### 3.1 案aを採用する（直列化は kintone に委譲する）

プラグイン `createKintoneClient().getRecords` だけを、`kintone.api()` から raw Fetch 経路へ変更する。**query string の直列化を自前で再実装しない**（変換ミスのリスクを避けるため、kintone 自身の URL 生成 API を使う）。

kintone の公式仕様で確定した事実（[kintone REST API リクエスト送信](https://cybozu.dev/ja/kintone/docs/js-api/api/kintone-rest-api-request/)、[クエリ文字列付き URL 取得](https://cybozu.dev/ja/kintone/docs/js-api/api/get-url-including-query/)）:

- `kintone.api()` は本文しか返さずレスポンスヘッダーを露出しない。ヘッダーが必要なケースは公式が Fetch / XMLHttpRequest の利用を案内している。
- **URL が 4KB を超える GET は、kintone.api() 内部で自動的に `X-HTTP-Method-Override: GET` を付与して POST 送信される**。本ツールは FULL_SCAN で長い `query` / 多数 `fields` を送るため、この分岐を無視すると 414 で大規模取得が壊れる。
- `kintone.api.urlForGet(path, params, isGuestSpace)` は **kintone 自身が** `fields:['x']` を `fields[0]=x` の形式で URL エンコードして直列化した GET URL を返す（公式サンプルで確認）。

したがって次の2経路にする。両経路で `X-Cybozu-Warning` を読む。

```text
[短い GET（生成 URL ≤ 4KB）]
  url = kintone.api.urlForGet("/k/v1/records.json", { app, query, fields }, true)  // kintone が直列化
  -> fetch(url, { method:"GET", credentials:"include",
                  headers:{ "X-Requested-With":"XMLHttpRequest" } })

[長い GET（生成 URL > 4KB）＝kintone.api() と同じ 4KB 閾値で POST override]
  url = kintone.api.url("/k/v1/records.json", true)
  -> fetch(url, { method:"POST", credentials:"include",
                  headers:{ "X-Requested-With":"XMLHttpRequest",
                            "X-HTTP-Method-Override":"GET",
                            "Content-Type":"application/json",
                            "X-Cybozu-Request-Token": kintone.getRequestToken() },
                  body: JSON.stringify({ app, query, fields }) })   // 標準 JSON・自前直列化なし

両経路 -> HTTP status / JSON body 検査 -> isSearchAbortedWarning(X-Cybozu-Warning) -> { records, searchAborted?: true }
```

**設計の要点＝自前直列化をしない**: 危険な GET クエリの配列直列化は `kintone.api.urlForGet`（kintone の実装）に委譲し、POST override 経路の body は標準 `JSON.stringify`。自前ロジックは①**4KB 閾値の判定**（`urlForGet` が返した URL のバイト長で GET/POST を分岐＝kintone.api() と同一閾値）②**POST 時の CSRF トークン付与**（`kintone.getRequestToken()`）の2点だけに限定し、いずれも単体テストで固定する。`getRecords` は GET セマンティクスのみ（現行 `api(..., "GET", ...)`・[src/ui/kintoneClient.ts:96-103](../../src/ui/kintoneClient.ts#L96)）。POST override は「GET を transport だけ POST にする」ものであり、書き込み API（POST/PUT/DELETE の records mutation）を raw Fetch へ広げない。

補足: 4KB 閾値・CSRF 要否・POST override 経路での `X-Cybozu-Warning` 露出は kintone 実挙動に依存するため、通常/guest space の実機ゲート（§6.2）で確認する。閾値が実機とずれても壊れないよう、POST override 経路自体は URL 長に関わらず常に安全側で動く実装（長さで壊れない）にする。

### 3.2 ヘッダー判定と定数共有

共通モジュールに少なくとも次の責務を置く。

- `SEARCH_ABORTED_HEADER_VALUE = "Filter aborted because of too many search results"`
- `X-Cybozu-Warning` の値がその文字列を `includes` するかを判定する pure helper

Node の現行判定は複数警告を含み得るヘッダーに対する `includes` であり、完全一致へ狭めない（[src/cli/nodeKintoneClient.ts:134-137](../../src/cli/nodeKintoneClient.ts#L134)）。plugin も同じ helper を使い、該当時だけ `searchAborted: true` を返す。該当しない警告、ヘッダーなし、空文字ではプロパティを省略する。

共通モジュールは Node 専用 API に依存しない場所へ置き、plugin bundle と CLI bundle の双方から import できるものとする。

### 3.3 認証・same-origin・guest space

- URL は既存の `apiUrl(path)`、すなわち `(kintone.api as KintoneApiWithUrl).url(path, true)` を必ず使う（[src/ui/kintoneClient.ts:26-27](../../src/ui/kintoneClient.ts#L26)。`true` は現在の adapter が全 REST 呼び出しで使っている guest-aware URL 生成契約である）。
- Fetch は `credentials: "include"` を明示し、ログインセッション cookie を送る。
- `X-Requested-With: XMLHttpRequest` を付与する。
- URL を別 origin へ書き換えない。生成 URL と現在ページが同一 origin であることを前提にする。

ただし、`kintone.api.url(path, true)` が通常 space / guest space で生成する実 URL、および `X-Cybozu-Warning` がブラウザー Fetch の `Response.headers` に実際に露出することは、このリポジトリのコードだけでは証明できない。通常 space と guest space の双方を実機受入ゲートにする。

### 3.4 エラー契約を維持する

現行 `api()` は `kintone.api()` の reject を `toDetailedApiError` へ渡し、`message`、`code`、field-level `errors`、`status` を Error に保持する（[src/ui/kintoneClient.ts:36-77](../../src/ui/kintoneClient.ts#L36)、[src/ui/kintoneClient.ts:80-90](../../src/ui/kintoneClient.ts#L80)）。raw Fetch の `getRecords` でも利用者可視のこの契約を維持する。

1. `res.ok === false` なら可能な限り JSON body を読み、`{ code, id, message, errors, status: res.status }` 形へ整えて `toDetailedApiError` で変換して throw する。
2. JSON error body に `code` があれば Error の `name` / `code` へ通し、field-level `errors` があれば message に畳み込む。
3. JSON でないエラー応答、空 body、ネットワーク拒否も、元の原因と HTTP status が失われない Error にする。
4. 非 2xx 応答を成功 body として扱わず、エラー応答の `X-Cybozu-Warning` から `searchAborted` を返さない。

raw Fetch 専用 helper を追加してもよいが、既存の書き込み等が使う `api()` と `toDetailedApiError` の挙動は変更しない。

### 3.5 変更しない API

raw Fetch 化するのは `createKintoneClient().getRecords` のみである。

- cursor create/get/delete は現行 `kintone.api()` のまま。
- `postRecords` / `putRecords` / `deleteRecords` は現行のまま。
- `getApps` / `getFields` / `getNumberPrecision` / `getProcessStatuses` は現行のまま。
- Node / CLI / MCP の通信方式と fail-closed ロジックは変更しない。ただし Node の定数／判定 helper の import 元だけは共有化のため変更対象になり得る。

## 4. 実行時契約

### 4.1 SELECT / UNION / WITH

`searchAborted: true` を受けた wrapper は collector を立てるが throw せず、最終結果が SELECT の場合に既存警告を重複なく付ける（[src/execute.ts:801-817](../../src/execute.ts#L801)、[src/execute.ts:855-862](../../src/execute.ts#L855)）。警告文と SELECT の行選択・上限・truncate 契約は変更しない。B7 は、従来プラグインだけ欠落していた検出入力を供給するものである。

### 4.2 DML

非 SELECT 文では同じ wrapper が `SearchAbortedError` を `getRecords` の戻り直後に投げる（[src/execute.ts:801-817](../../src/execute.ts#L801)。エラー型と文言は [src/execute.ts:213-218](../../src/execute.ts#L213)）。confirm、POST、PUT、DELETE より前に伝播し、書き込み0件で fail-closed とする。B7 は新しい DML 分岐を追加しない。

### 4.3 B47 との依存

B47 の KLIKE 親選択は native `like` / `not like` が返した候補集合の完全性を必要とする。Node / CLI / MCP は既に検索打ち切りを検出できるが、プラグイン全面解禁には B7 が必須である。

- 実装順は **B7 → B47** とする。
- B7 の実機受入まで完了した場合、B47 に surface gate は設けない。
- B7 が未達または実機でヘッダー非露出と判明した場合、B47 KLIKE は plugin で fail-closed に拒否し、Node / CLI / MCP 限定へフォールバックする。警告を出して実行継続してはならない。

## 5. 非対象

- Node / CLI / MCP の検索打ち切り検出方式の再設計。
- plugin の書き込み API の raw Fetch 化。
- cursor API のヘッダー検出。
- SELECT 打ち切り時の意味論変更。既存 `attachSearchAbortWarning` に載るだけである。
- 検索打ち切りそのものの回避、再試行、分割検索、完全結果の合成。
- B47 の親 WHERE evaluator／prefilter 実装。

## 6. 受入テスト

### 6.1 unit / client-level

- **短い GET**: `kintone.api.urlForGet("/k/v1/records.json", { app, query, fields }, true)` の戻り URL を使い、`method:"GET"`・`credentials:"include"`・`X-Requested-With: XMLHttpRequest`。直列化は urlForGet に委譲し、自前で query string を組まない（fields 直列化を test では urlForGet の戻り値で確認）。空 fields は params から省く。
- **長い GET（生成 URL > 4KB）**: `kintone.api.url(...)` へ `method:"POST"`・`X-HTTP-Method-Override:"GET"`・`Content-Type:"application/json"`・CSRF トークン・`body=JSON.stringify({app,query,fields})`。**この経路でも `X-Cybozu-Warning` を読む**。4KB 前後の境界（例: 長い query）で GET/POST が正しく切り替わる。
- 200 + `X-Cybozu-Warning` に共通メッセージあり → `{ records, searchAborted: true }`（GET/POST override 両経路）。
- 200 + ヘッダーなし／別警告 → `{ records }` で `searchAborted` なし。
- Node と plugin の双方が同じ定数／helper を参照し、既存 Node テストが非回帰。
- 400 等の JSON error body から `message`、`code`、`errors`、`status` が既存 Error 契約へ移る。
- JSON でないエラー、空 body、Fetch rejection が明示的な Error になる。
- `getFields`、cursor、書き込み等は `kintone.api()` を使い続ける。
- plugin client の `searchAborted: true` を `execute()` へ渡し、SELECT は警告、DML は `SearchAbortedError`、DML mutation API は0回になる。

### 6.2 実機

優先する実機検証は、10万件を超えて native `like` / `not like` の検索打ち切りを起こせる大規模アプリを通常 space と guest space に用意することである。各 surface で次を確認する。

1. 通常 space の SELECT が完了し、検索打ち切り警告を表示する。
2. 通常 space の読取後 DML が `SearchAbortedError` となり、confirm 前・書き込み0件で終わる。
3. guest space でも URL、認証、GET query、ヘッダー露出、SELECT 警告、DML fail-closed が同じ結果になる。
4. 打ち切りなしの通常応答が従来どおり動く。
5. 権限エラーや不正 query のエラー応答で code / 詳細 message が維持される。

10万件超アプリを準備できない場合、ブラウザー開発環境・検証 proxy 等で同一オリジン応答へ `X-Cybozu-Warning` を強制注入できるなら、それを準実機検証としてよい。ただし、kintone 本番応答でのヘッダー露出を確認したとは記録しない。

いずれの実機手段も使えない場合は、Fetch `Response` と `headers.get` を mock した plugin client-level unit test を代替ゲートとする。この場合も SELECT 警告／DML fail-closed／書き込み0件まで結合検査し、リリースノートへ「実際の10万件応答、guest space、ブラウザーでのヘッダー露出は未検証」と明記する。B47 KLIKE を plugin へ全面解禁するかは §4.3 のフォールバック条件に従う。

## 7. SemVer / リリース

B7 単独でも、プラグインに新しい SELECT 警告と DML fail-closed の発火契機を追加する利用者可視の安全性改善であるため **minor** とする。B47 と同梱し **v3.10.0** でリリースする。

リリース順序は、B7 の unit・実機ゲートを通した後に B47 KLIKE の plugin 全面解禁を有効化する。package の現行 version は `3.9.0`（[package.json:1-3](../../package.json#L1)）。
