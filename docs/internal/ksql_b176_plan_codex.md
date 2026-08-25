## 1. 推奨案

**案 A を採用すべきです。**

`resolveMetadata !== false` の `EXPLAIN UPSERT` / `EXPLAIN UPSERT SELECT` では、対象アプリのフォーム定義を1回取得し、同一 invocation のキャッシュへ格納してから既存の適格性評価器へ渡します。

理由は次のとおりです。

- `ELIGIBLE` を表示するという B173 の目的を満たせる唯一の案です。
- `EXPLAIN SELECT` は既にフォーム metadata を取得しています。UPSERT だけ取得しない合理的理由はありません。
- 増えるのは `app/form/fields.json` だけで、records、cursor、mutation API を呼ばない契約は維持できます。
- 本実行・preview と同じ `getFieldsCached` と同じ評価器を使えます。
- `resolveMetadata: false` と完全オフライン `--dry-run` は、材料がないため従来どおり `UNKNOWN` が正しいです。

なお、起票と依頼では「§7 の API 契約」とされていますが、現行 R5 の §7 は「書込順・確認・結果」です。矛盾する規範は実際には `ksql_b173_native_upsert_spec.md:550` の §4.4、`同:566` の §4.5、および `同:1531` の AC-16 です。この章番号の誤記も直すべきです。

## 2. 確認 1〜4

### 確認1: SELECT はどこで `getFields` を呼ぶか

単文 EXPLAIN は次の経路です。

`execute` → `executeParsedStatement` → `executeExplain` → `buildExplainWhereAnalysis`

- EXPLAIN の dispatch: `src/execute.ts:1230`
- `executeExplain` が解析を呼ぶ箇所: `src/execute.ts:13587`
- SELECT visitor は WHERE が field metadata を要するか判定し、schema-aware resolver を構築します: `src/execute.ts:12230`、`同:12246`、`同:12251`
- wildcard・CTE 列推論でも物理 APP の `getFieldsCached` を呼びます: `src/execute.ts:12077`、`同:12099`
- キャッシュ miss が実 `client.getFields` に到達する箇所: `src/execute.ts:7936`

UPSERT VALUES が通らない理由は、`buildExplainWhereAnalysis` の visitor に `UPSERT` / `UPSERT_SELECT` の対象 schema を取得する分岐がないためです。SELECT、VALIDATE、UPDATE/DELETE は固有処理を持ちますが、UPSERT は一般的な子要素走査だけです: `src/execute.ts:12221`、`同:12230`、`同:12432`。

その後、native 適格性表示は schema を取得せず、キャッシュだけを参照します: `src/execute.ts:7457`、`同:7464`。キャッシュがなければ `null` になり、条件3が `UNKNOWN` になります: `同:7475`、`同:7480`。

`UPSERT SELECT` ではソース SELECT の都合で source app の metadata が取れる場合がありますが、target app の schema 取得は保証されません。同じ app を先行 SELECT したテストだけが偶然キャッシュを温めていました。

### 確認2: `resolveMetadata`

バッチ planner の既定は `true` です: `src/execute.ts:13089`、`同:13099`。`false` では `buildExplainWhereAnalysis` を実行しません: `同:13140`。

各面は次の状態です。

- MCP バッチ: 明示 `true`: `src/mcp/tools.ts:705`、`同:716`
- プラグイン: 明示 `true`: `src/ui/batchExplain.ts:17`、`同:27`
- `/flow`: `opts.resolveMetadata` をそのまま渡し、省略時は planner の既定 `true`: `src/flow-library/index.ts:88`、`同:98`
- engine-library: 明示 `true`: `src/engine-library/query.ts:122`、`同:132`。ただし現在 `EXPLAIN UPSERT` 自体を read-only guard で拒否するため、B176 の対象面ではありません: `src/engine-library/__tests__/b89ExplainBatch.test.ts:73`
- CLI batch dry-run: 静的 planner の条件により `false` になり得ます: `src/cli/index.ts:2369`、`同:2374`
- MCP／CLI 単文: `executeExplain` 経路には現在 `resolveMetadata` 引数がありません: `src/mcp/tools.ts:733`、`src/execute.ts:13569`

したがって、**`resolveMetadata` は B176 の直接原因ではありません**。`true` でも UPSERT target schema を読む処理がないことが原因です。ただし修正時には、単文 EXPLAIN にも metadata 解決可否を渡せるようにしないと、オフライン dry-run を維持できません。

### 確認3: 本実行と preview の schema 入手経路

本実行:

- `executeUpsert`: `loadWritableTopLevelDmlFields` で schema を取得してから評価器へ渡します: `src/execute.ts:10963`、`同:10973`、`同:10981`
- `executeUpsertSelect`: 同様です: `src/execute.ts:11573`、`同:11583`、`同:11627`
- `loadWritableTopLevelDmlFields` は内部で `getFieldsCached` を使用します: `src/execute.ts:8324`

preview:

- dialect 1 の事前検証でも schema を取得します: `src/execute.ts:2546`
- `previewUpsert`: `src/execute.ts:2754`、`同:2761`
- `previewUpsertSelect`: `src/execute.ts:2768`、`同:2776`

EXPLAIN が同じ `getFieldsCached` を使えない理由はありません。ただし `loadWritableTopLevelDmlFields` 全体を流用すると書込可否エラーまで発生させるため、**流用するのは `getFieldsCached` と評価器だけ**にすべきです。

### 確認4: 契約・出力・時間への影響

壊さないもの:

- records、cursor、mutation API は0回のままです。R5 自体が EXPLAIN では metadata API を許可しています: `ksql_b173_native_upsert_spec.md:566`
- `columns: ["plan"]`、MCP payload、単文／バッチの外形は維持できます: `ksql_b173_native_upsert_spec.md:1009`
- 既存 plan 行は削除せず、metadata 診断と適格性結果が加わるだけです: `src/execute.ts:13210`、`同:13219`

変わるもの:

- 対象 app ごと、invocation 内キャッシュ miss 時に `app/form/fields.json` が1回増えます。
- 単文 `execute` の `metrics.fieldCalls` は0から1になります。metrics は実 API 回数を数える設計です: `src/execute.ts:954`、`同:1029`
- plan に `metadata API: form definition APP...` が追加され、`rowCount` も増えます。完全一致型テストは更新対象です。
- 所要時間は metadata API 1往復分増えます。ただし同一 app はキャッシュされます: `src/execute.ts:7936`
- metadata API が失敗した場合の扱いは**要確認**です。推奨は SELECT EXPLAIN と同じくエラーを伝播することです。UPSERT だけ握り潰して `UNKNOWN` にすると、権限・通信障害を隠す別契約になります。

## 3. 採用時の変更内容

### Production

1. `buildExplainWhereAnalysis` の visitor に `UPSERT` / `UPSERT_SELECT` 分岐を追加し、target `appId` を `getFieldsCached` で取得する。
2. `resolveMetadata === false` の場合はこの分岐を実行しない。
3. 単文 `executeExplain` にも metadata 解決可否を渡せる純加法 option を追加する。既定は `true`。
4. 完全オフライン CLI `--dry-run` は明示的に `false` を渡す。現在の offline 判定は `src/cli/index.ts:2106` にあります。
5. MCP の runtime 要否判定にも「native UPSERT 適格性の target metadata」を含める。現在の `explainNeedsAppMetadata` は VALIDATE、SELECT、UPDATE/DELETE 等だけで UPSERT を認識しません: `src/core/explainMetadata.ts:115`、`同:123`。ただし CLI offline 判定と同じ helper を無条件に変更すると dry-run が認証必須になるため、用途を分離すべきです。
6. renderer と `evaluateNativeUpsertEligibility` は変更しない。問題は評価器の入力供給です。

### 仕様

- §4.4 の「適格性判定だけの API を増やさない」は本実行・preview に限定する。
- §4.5 を「`resolveMetadata !== false` の EXPLAIN は target form metadata を取得できる。records/cursor/mutation API は呼ばない」へ変更する。
- 「既に別目的でキャッシュされた場合だけ」を削除する: `ksql_b173_native_upsert_spec.md:568`、`同:572`
- `resolveMetadata:false` の `UNKNOWN` 契約は維持する: `同:579`
- AC-16 を「metadata API は最大1回/appまで許可し、records/cursor/mutation API を増やさない」に修正する: `同:1531`
- AC-17、AC-21 の `ELIGIBLE` 要求は維持する: `同:1535`、`同:1551`
- AC-22 の単文経路・出力外形も維持する: `同:1555`

## 4. 再発防止テスト

核心は、**UPSERT 単独で開始し、実 adapter の transport 呼出しを観測すること**です。先行 SELECT でキャッシュを温めてはいけません。

最低限、次を固定します。

1. UPSERT VALUES 単独の EXPLAIN
2. form fields API が対象 app にちょうど1回
3. records/cursor/write API は0回
4. 出力が `ELIGIBLE`
5. `resolveMetadata:false` は form API 0回かつ `UNKNOWN`
6. 同一 app の複数 UPSERT は form API 1回
7. 異なる2 app は各1回
8. UPSERT SELECT は target schema を取得し、source records は取得しない
9. metadata API 失敗時の契約を固定する（推奨はエラー伝播）

実クライアント相当の具体形:

- CLI: 既存の `runWithArgv` + `globalThis.fetch` を使う e2e に追加する。既に本実行ではこの形で actual Node client の `/app/form/fields.json` と `/records.json` を検査しています: `src/cli/__tests__/b173_native_upsert.test.ts:10`、`同:43`
- プラグイン: `createKintoneClient()` と mock `kintone.api` を組み合わせる。実 adapter の `getFields` は `/k/v1/app/form/fields.json` を呼びます: `src/ui/kintoneClient.ts:260`
- `/flow`: `createKintoneClient({fetch})` を使い、fetch URL と回数を検査する。実 adapter の取得経路は `src/flow-library/writableClient.ts:170`
- MCP: runtime だけを構成して actual Node client を返し、`executeSql` は実物を使用する。fetch で form endpoint 1回、records endpoint 0回、SELECT payload 外形、`ELIGIBLE` を固定する。
- core: adapter 統合とは別に、`execute("EXPLAIN UPSERT ...")` で `getFields` が1回呼ばれたことを明示検査する。ここでは mock client でもよいですが、**出力だけでなく invocation を必ず assert**します。

既存テストの修正:

- `src/ui/__tests__/b170BatchExplain.test.ts:32`: 先行 SELECT を削除し、UPSERT 単独にする。可能なら actual plugin client 統合テストへ移す。
- `src/flow-library/__tests__/publicApi.test.ts:105`: 先行 SELECT を削除し、`createKintoneClient({fetch})` を使用。enabled/disabled の両方で form API 回数を固定する。
- `src/__tests__/b168Stage5ExecutionExplain.test.ts:103`: 先行 SELECT を削除し、UPSERT 単独でも `getFields` 1回、records 0回、`ELIGIBLE` を固定する。
- `src/__tests__/explain.test.ts:665`: 現在は `UNKNOWN`、`getFields` 0回を明示的に固定しており、修正と正面衝突します。`同:677`、`同:681` を `ELIGIBLE`、1回へ反転する必要があります。
- `src/mcp/__tests__/tools.test.ts:3164`: `UNKNOWN` を固定しているので actual runtime client を使う `ELIGIBLE` テストへ置換する。
- offline CLI の `UNKNOWN` テストは残す: `src/cli/__tests__/index.test.ts:177`

## 5. 同じ欠陥が他にないか

確認した範囲では、**native 本実行、metrics、`onChunkWritten` に同じ欠落は確認できません**。

- metrics wrapper は `upsertRecords` を条件付きで保持し、`putCalls` と `nativeUpsertCalls` を実呼出し時に加算します: `src/execute.ts:1042`
- `/flow` 公開入口を通したテストが native request、result、metrics、callback を同時に固定しています: `src/flow-library/__tests__/b173NativeUpsert.test.ts:85`
- callback は native response 検証後に `UPSERT` と件数を通知します: `src/execute.ts:2253`
- callback error 時にも legacy retry しないことが固定されています: `src/flow-library/__tests__/b173NativeUpsert.test.ts:253`
- request gate が optional `upsertRecords` capability を保持することも専用テストがあります: `src/api/__tests__/requestGate.test.ts:244`
- CLI は actual Node client + fetch で native PUT body と records GET/POST 省略を確認しています: `src/cli/__tests__/b173_native_upsert.test.ts:43`

ただし、次はテストギャップです。

- `/flow` の logical-app routing が `upsertRecords` を保持する実装はありますが、LAPP を通した B173 native 統合テストは検索範囲で見つかりませんでした: `src/flow-library/index.ts:301`、`同:317`
- B173 本実行テストは `fieldCalls === 1` を固定していません。schema の取得と再利用を保証するため、成功・fallback の双方に追加すべきです。
- actual `/flow` client → route → metrics → callback までを1本で通す transport-level テストはありません。現在は adapter テストと public execution テストが分離されています。B176 と同型の層間欠落を防ぐため、1本追加する価値があります。

## 6. 判断を覆す条件

次のいずれかが確定した場合は、案 A を再検討します。

- form metadata 取得権限が一般的な EXPLAIN 利用者に存在せず、`EXPLAIN UPSERT` の成功率を大きく下げる。
- metadata API の追加1往復が運用上許容できないという明示的な性能要件がある。
- 「EXPLAIN は metadata を含め一切ネットワークアクセスしない」が正式な上位契約になる。
- 製品要件として適格性表示を廃止し、`UNKNOWN` のみでよいと明示的に決定する。
- metadata 失敗時にエラーではなく `UNKNOWN` へ降格する必要がある。この場合はエラー分類・警告表示・テストを別途仕様化すべきです。

コード、ファイル、git には触れていません。read-only 指示に従い、テスト実行も行わず静的監査だけでまとめました。