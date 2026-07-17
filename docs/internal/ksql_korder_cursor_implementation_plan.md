# B33: `KORDER BY` 大規模窓 Cursor API 実装計画

- ステータス: **R1・レビュー前**
- 対象リリース: **v3.1.0**
- 対象課題: **B33**
- 分担: **Claude=仕様/観点、Codex=実装/テスト**
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md)
- 正となる仕様: [B33 設計 R4](ksql_cursor_api_fetch_spec.md)（本書の「R3 §n」参照は R4 でも同一節番号）
- 参照契約: [型付き順序・安全な ORDER BY R8 §4.3](ksql_local_order_by_draft.md)、[文字列の扱い R8.5 §0/原則6](ksql_string_semantics.md)

本書はB33 R3 §15を実ファイル・実シンボル単位へ展開する実装計画である。R3の事実や契約本文は再掲せず、該当節を参照する。R3と本書が衝突する場合はR3を正とし、本書を修正する。

## 1. 目的と完了条件

v3.1.0では、単発Records APIで完結しないトップレベル`KORDER BY`窓を、通常の取得経路へ影響させず`KORDER_CURSOR`で実行可能にする。

完了は次のすべてを満たす状態を指す。

1. R3 §16の18受入条件を§8の対応表どおりに満たす
2. Phase 0のDelete実応答blockerをClaudeまたはユーザー実機で測定し、観測結果だけをfixtureへ固定する
3. planner、lifecycle、concurrency、routingをNode自動テストで固定する
4. 10,001件以上の順序と500件境界の同値群を実機で確認する
5. CLI / MCP / Chromium / Firefoxの実機smokeを通し、Nodeでブラウザcleanupを代用しない
6. v3.1.0のCHANGELOG、言語リファレンス、移行文書、全成果物のversionを同期する

### 1.1 事実・設計決定・未検証の分離

横断仕様の原則6に従い、根拠を次のラベルで管理する。

| 区分 | 本計画での扱い |
|---|---|
| **コード確定** | 現在の実装、型、呼出し経路をgrepとコード読解で確認した事項。§3に限定して記す |
| **設計決定案** | kSQL v3.1.0が採る実装値・公開設定・cleanup方針。§4でレビュー対象として明示する |
| **未検証** | Delete済みID、自動削除済みID、公式5分timeout後の残存、複数ページ順序、ブラウザ離脱cleanup。観測前に成功statusやerror codeを仮定しない |

実測によりR3の横断事実が変わる場合は、先にR3へ反映する。本計画だけに新しい一般契約を閉じ込めない。

## 2. 今回含めないもの

- 通常の`ORDER BY`、FULL_SCAN、JOIN、UNION、CTE、DML、一時テーブルの取得方式変更
- `src/api/fetchAll.ts`へCursor APIを組み込むこと
- nested `KORDER BY`を許可すること
- Cursor結果のローカル再ソート、canonical tie、暗黙の`$id asc`追加
- Create / Get Cursorの自動再試行
- プロセスをまたぐドメイン全体のcursor枠調停
- Cursor APIを完全snapshotとして扱うこと
- B9の厳密10進比較、B29の数値精度・丸めそのものの実装手順。本書は同一releaseでの統合境界だけを扱う

## 3. 現行コードで確認した変更点

### 3.1 KORDER接続点と通常ページング

| 責務 | コード確定した現状 | B33の接続先 |
|---|---|---|
| plan kind | `src/core/optimization/canonicalOrderPlanner.ts`の`CanonicalOrderPlanKind`は`CANONICAL_REST_TOP_N / CANONICAL_LOCAL / KORDER_NATIVE` | `KORDER_CURSOR`を追加する |
| KORDER planner | `src/core/optimization/korderPlanner.ts`の`planKorderNative()`がallowlist、query形状、WHERE、LIMIT/OFFSET、`maxRecords`を検査する | 関数名を`planKorder()`へ一般化し、R3 §4.2の境界でnative/cursorを返す |
| planner呼出し | `src/execute.ts`のトップレベル実行（約1452行）、CTE側検査（約2664行）、EXPLAIN走査（約5167/5199行）が`planKorderNative()`を呼ぶ | 3箇所を同じplannerへ置換し、実行とEXPLAINの二重判定を作らない |
| executor | `src/execute.ts`の`executeSimpleSelect()`（約1567行）が`KORDER_NATIVE`を`client.getRecords()`単発GETへ流す | 同関数内で`KORDER_CURSOR`だけを新しいcursor executorへ渡す |
| `LIMIT 0` | `executeSimpleSelect()`が`KORDER_NATIVE && limit===0`をAPIなしで空結果にする | plan kindに依存しないKORDER共通の検証後no-API短絡へする |
| EXPLAIN | `buildExplainWhereAnalysis()`がplan mapを構築し、SELECT plan表示部（約5435行）が`KORDER_NATIVE`と単発GETを表示する | 同じplan objectからR3 §13の`KORDER_CURSOR`表示を生成する |
| 通常全件取得 | `src/api/fetchAll.ts`はRecords APIと`$id`キーセットページングを使い、`KINTONE_MAX_OFFSET=10_000`で内部windowを切り替える | Cursor APIへ接続しない。既存の`fetchAll`テストを回帰gateにする |

`src/api/fetchAll.ts`冒頭と`KINTONE_MAX_OFFSET`のコメントは、現在のHEADでは既に「offset 10000到達前後で保守的にカーソル方式へ切り替える内部閾値」と訂正済みであり、「`>=10000`はAPIエラー」とは書かれていない。これはv3.0.0計画からの引継ぎ事項としてPhase 0で再確認し、ページング動作は変更しない。実装branchに古い文言が残る場合だけ同ファイルのコメントを訂正する。

### 3.2 `KintoneClient`実装・wrapper・mockのgrep全列挙

次の一覧は`rg -l "\\bKintoneClient\\b" src --glob "*.ts"`と、object生成を探す`rg`で確認した。`src/core/index.ts`は型のre-export、`src/ui/desktop.ts`はconsumer、`src/cli/__tests__/nodeKintoneClient.test.ts`と`src/ui/__tests__/kintoneClient.test.ts`は実adapterの試験であり、独立実装ではない。

#### 本番実装・wrapper

| 種別 | ファイル / シンボル | `openCursor`必須化時の責務 |
|---|---|---|
| interface | `src/execute.ts` `KintoneClient` | `openCursor`をoptionalでなく追加する |
| Node実装 | `src/cli/nodeKintoneClient.ts` `createNodeKintoneClient()` | create/get/delete endpoint、base URL・guest・tokenをhandleへ固定する |
| plugin実装 | `src/ui/kintoneClient.ts` `createKintoneClient()` | `kintone.api()`によるcreate/get/deleteとreject正規化を実装する |
| RequestGate wrapper | `src/api/requestGate.ts` `withRequestGate()` / `RequestGate` | `runCursorStep()`を追加し、Create/Get/Deleteをセマフォ対象・retryなしにする |
| metrics wrapper | `src/execute.ts` `wrapClientWithMetrics()` | handleを包み、R3 §13のcursor counterを集計する |
| search warning wrapper | `src/execute.ts` `wrapClientWithSearchAbort()` | spreadで`openCursor`を保持する。Cursor queryにはLIKE/KLIKEを入れないことを試験する |
| EXPLAIN trace wrapper | `src/execute.ts` `buildExplainWhereAnalysis()`内`tracedClient` | spreadで`openCursor`を保持するが、EXPLAINで呼ばれないことを試験する |
| Node logical-app router | `src/node/runtime.ts` `routedClient` | cursor作成時のapp/profile/clientを固定し、handle後続呼出しを同clientへ閉じる |
| CLI profile router | `src/cli/index.ts`のprofile別client object（約1921行） | Node runtimeと同じ固定routingを保つ |
| CLI dry-run mock | `src/cli/index.ts` `createDryRunClient()` | 呼ばれたら失敗する`openCursor`を追加する |
| MCP no-op mock | `src/mcp/tools.ts` `noOpClient()` | metadata不要query用のfail mockへ`openCursor`を追加する |

#### テストmock

| ファイル | mock生成箇所 |
|---|---|
| `src/__tests__/execute.test.ts` | `makeClient()`、`makeConcurrencyClient()`、局所`getRecords`差替え |
| `src/__tests__/executeAssert.test.ts` | `makeClient()` |
| `src/__tests__/executeBatch.test.ts` | `makeClient()` |
| `src/__tests__/explain.test.ts` | `makeClient()` |
| `src/__tests__/klike.execute.test.ts` | `makeClient()` |
| `src/__tests__/searchAbort.execute.test.ts` | `makeAbortedClient()`と局所client literal |
| `src/__tests__/window.execute.test.ts` | `makeClient()` |
| `src/api/__tests__/requestGate.test.ts` | `client: KintoneClient` literal |
| `src/mcp/__tests__/tools.test.ts` | `makeClient()`、約1305/1433/1530/1596行の個別client literal |
| `src/cli/__tests__/batchJsonOutput.test.ts` | `makeClient()` |

すべての再構築objectが`KintoneClient`の戻り型または注釈へ接続されているため、`openCursor`を必須にすると未追加objectはTypeScriptの構造型検査で失敗する。spread wrapperは元clientから必須メソッドが伝播するため型検査だけでは意味的なwrap漏れを検出できない。したがって`wrapClientWithMetrics()`のcounter、`withRequestGate()`のretry禁止、logical-app routing、EXPLAIN no-callは専用テストでも固定する。

## 4. 目標アーキテクチャと実装前決定案

### 4.1 client・handle層

R3 §7の`KintoneCursorHandle`と必須`KintoneClient.openCursor()`を採用する。型と共有state machineは新規`src/api/kintoneCursor.ts`へ置き、`src/execute.ts`から型をimportする。Node/plugin adapterはraw HTTP差だけを注入し、次を共有実装する。

- handleは作成時のclient、認証経路、guest space、cursor ID、leaseを閉包し、IDだけを別clientへ渡せない
- `nextPage()`を同一handle内で直列化し、空ページは`next`だけで判定する
- `close()`は同一promiseを共有する冪等state machineとし、多重DELETEを防ぐ
- `next=false`観測後の`close()`はネットワーク要求を送らない
- Create/Getはretryせず、DeleteだけPhase 0で確定した既解放応答と再確認規則を使う
- cursor IDは通常ログ、surface error、EXPLAINへ出さない

### 4.2 lease・RequestGate層

新規`src/api/cursorLeaseManager.ts`へhost単位registryを置く。active semaphore、Add Cursor mutex、quarantine timerをHTTP要求単位の`RequestGate`から分離する。Node adapterは`new URL(baseUrl).host`、plugin adapterはkintone API URLのhostをkeyとし、guest path、profile、logical appが同じhost leaseを共有する。

`RequestGate`にはprivate `withSlot()`を使うpublic `runCursorStep()`を追加する。`runReadOnly()`を流用せず、HTTP methodがGETのGet Cursorにもretryを掛けない。`withRequestGate()`は`openCursor()`だけでなく返却handleの`nextPage()`と`close()`も`runCursorStep()`へ包む。

### 4.3 planner・executor層

`planKorderNative()`を`planKorder()`へ一般化し、R3 §4.1の共通検査を一度完了した後、§4.2の順で`KORDER_NATIVE`、`KORDER_CURSOR`、planning errorを選ぶ。`LIMIT`、`OFFSET`、`scanRows`は加算前後にsafe integerを検査する。`KORDER_NATIVE`優先を維持し、native窓へcursor側の`scanRows <= maxRecords`を誤適用しない。

新規`src/core/optimization/korderCursorExecutor.ts`は、planner済みの単一物理app、fields、WHERE、KORDERキー、offset、limitだけを受け取る。Cursor query生成は新規`buildKorderCursorQuery()`へ分離し、SQLのLIMIT/OFFSETを含めない。`executeSimpleSelect()`はplan kindで単発GETまたはcursor executorを選び、通常`fetchAll()`へは接続しない。

executorは`try/finally`でhandleを所有し、offset読み飛ばし、limit収集、`totalCount <= offset`早期close、必要窓到達後の早期closeを実装する。変換失敗、Get失敗、timeout、利用者cancelでも、元のsignalとは独立したcleanup budgetでcloseを完了またはquarantineへ移してからsurfaceへ結果を返す。

### 4.4 R3 §17への決定案

以下は**設計決定案**であり、R1レビューで承認後に実装定数・公開schemaへ固定する。

| 決定項目 | v3.1.0決定案 | 根拠 |
|---|---|---|
| cursor permit待機時間 | **30秒**。abort-awareな単調時計timeoutとし、超過時はAPI前に`CursorCapacityError` | 一時的な同一process競合は吸収しつつ、10分leaseの後ろで無期限待機しない。既定HTTP timeoutと同程度で運用説明が単純になる |
| cleanup timeout | **5秒、初回DELETEと再確認を含む全体budget** | cleanupを本処理timeoutから独立させ、ページ離脱や失敗後の待機を短く抑える。超過時は成功推定せずquarantineする |
| DELETE再確認回数 | **初回失敗後に1回だけ**、固定250ms後。汎用retryへ入れない | 一時的な通信失敗の再確認機会を持ちつつ、長いretry列と重複DELETEを避ける。既解放判定はPhase 0実測値だけを使う |
| quarantine安全余裕 | **10分TTLに30秒を加える**。基準は最後に成功したCreate/Get時刻 | timer・通信遅延を吸収し、即時permit返却による孤児増加を防ぐ。公式5分timeout後の残存を否定する根拠には使わない |
| active cursor数の公開設定 | **公開する**。既定2、入力範囲1..5、範囲外は明示エラー | R3 §6/§9の「設定しても最大5」を利用者契約にする。CLI=`--cursor-max-active`、env=`KSQL_CURSOR_MAX_ACTIVE`、profile=`query.cursorMaxActive`、MCP=server/profile設定、plugin=保存optionとする。permit wait等の内部値はv3.1.0では公開しない |
| pluginページ離脱cleanup | **実施する**。active handle registryへ対して`pagehide`と`beforeunload`から冪等`close()`をfire-and-forgetする | 通常の`finally`を主保証としつつ、ページ離脱時に可能な範囲でDELETEを始める。ブラウザは完了を保証しないため「解放済み」とは扱わず、実機smokeを必須にする |
| B9/B29との同居 | **B33+B9+B29をv3.1.0へ同居させる** | B33はAPI adapter・cursor lease・KORDER planner/executor、B9は共有数値比較primitive、B29はschemaの`numberPrecision`とDML/Tier-0検証・量子化が中心で、所有layerが異なる。`src/execute.ts`と設定型の統合競合はあり得るため課題別commitを保ち、最後に統合testする |

次の2項目は**未検証のまま残し、本表で決定しない**。

- Delete済み／自動削除済みIDへDeleteした実応答
- 公式5分Create timeout後に有効cursorが残るか

## 5. 実装フェーズとコミット分割

各Phaseは独立review単位にする。Phase 0のDelete blockerが閉じるまでPhase 1の既解放判定を実装せず、特定status/codeを仮置きしない。

### Phase 0: 契約fixtureと実測gate

#### Step 0-1: KORDER境界のfail-first fixture

- `KORDER_NATIVE`の既存境界、`LIMIT 501`、`LIMIT 10001`、`OFFSET 10001`、safe integer、`scanRows > maxRecords`、`LIMIT 0`をtable-drivenに固定する
- allowlist外型、残余WHERE、KLIKE、nested KORDER、複数キーの指定順を既存拒否契約と合わせる
- **変更ファイル**: `src/core/optimization/__tests__/korderPlanner.test.ts`、`src/__tests__/execute.test.ts`、`src/__tests__/explain.test.ts`
- **新規ファイル**: `src/api/__tests__/fixtures/korderCursorPages.ts`
- **テストファイル**: 上記3既存testとfixture consumer

#### Step 0-2: lifecycle fail-firstと性質testの骨格

- create/get/deleteのscripted fixture、空ページ、早期終了、Get失敗、変換失敗、abort、timeout、close多重呼出し、cleanup二重失敗を先に期待値化する
- deterministicなaction列生成器で`close`冪等性、`nextPage`直列性、permitが解放確認前に戻らない性質をmodel-based testする。外部property-test依存は追加せずseedと最小反例を出力する
- **変更ファイル**: なし
- **新規ファイル**: `src/api/__tests__/kintoneCursor.test.ts`、`src/api/__tests__/kintoneCursor.property.test.ts`、`src/api/__tests__/cursorLeaseManager.test.ts`
- **テストファイル**: 新規3ファイル

#### Step 0-3: Delete実応答の実測blocker — **実測済み（2026-07-18・blocker 解消）**

> **結果**: 明示 Delete 済み・自動削除（next=false）済みの 2 経路とも **`HTTP 404` + `code: GAIA_CN01`** で完全同一（[実測記録](evidence/b33_cursor_delete_responses.md)・R4 §14.4 へ反映済み）。既解放 fixture はこのペア 1 種のみ。Phase 1 以降の既解放判定を実装可能。

担当は**Claudeまたはユーザー実機**とし、raw RESTまたはブラウザの`kintone.api()`で次を行う。token、cookie、cursor IDは成果物へ残さない。

1. `POST /k/v1/records/cursor.json`へ`{ app, query: "order by $id asc", size: 500 }`を送り、cursor IDと`totalCount`を一時保持する
2. `DELETE /k/v1/records/cursor.json`へ`{ id }`を送る
3. 同じ`id`で同じDELETEをもう1回送り、**2回目のHTTP status、kintone error code、error id、message、response body形状**を記録する
4. 別cursorをPOSTし、fixtureを全件取得できるqueryで`GET /k/v1/records/cursor.json?id=...`を`next=false`まで繰り返す
5. 自動削除後に同じIDをDELETEし、**HTTP status、kintone error code、error id、message、response body形状**を記録する
6. guest space有無、認証経路、app、実施日時、ページ件数、API endpointを記録し、認証情報をredactする

観測前に「404/特定codeなら既解放」等の仮契約を書かない。2経路の結果が一致しなくても別fixtureとして保持する。

- **変更ファイル**: 実測後の`docs/internal/ksql_cursor_api_fetch_spec.md`は別途仕様担当が更新する。本実装作業では承認済みR3改訂を取り込む
- **新規ファイル**: 実装時に`docs/internal/evidence/b33_cursor_delete_responses.md`を作るかはreviewで決める。作る場合もID/tokenを残さない
- **テストファイル**: `src/api/__tests__/fixtures/korderCursorPages.ts`、`src/api/__tests__/kintoneCursor.test.ts`

#### Step 0-4: 公式5分timeout後の残存調査gate

これはDelete blockerと分離し、**未検証**のまま扱う。安全に隔離したtest domainで、他製品がcursorを使っていないことを確認したうえで、Claudeまたはユーザー実機が次を行う。

1. timeoutを再現できる高コストCreateを1回だけ実行し、5分timeoutのHTTP status/code/id/messageと時刻を記録する
2. 直後に既知の軽量cursorを最大10個まで順に作り、何個目で容量エラーになるかを記録し、受信済みIDはすべてDELETEする
3. 10分+安全余裕後に同じ容量probeを行い、3回以上の独立試行とvendor回答の有無を併記する

結果が一度同じでも「残存しない」と一般化しない。十分な実測または公式回答が得られるまではCreate outcome unknownをquarantineするR3契約を維持する。

- **変更ファイル**: なし（結果を一般契約へ昇格する場合だけ先にR3を改訂）
- **新規ファイル**: 任意のredact済み実測記録
- **テストファイル**: Node自動テストなし。実機gateのみ

#### Step 0-5: `fetchAll`分離と引継ぎコメント確認

- `src/api/fetchAll.ts`がRecords API＋`$id`キーセットのままであること、`>=10000はAPIエラー`という古い文言がないことを確認する
- `src/api/__tests__/fetchAll.test.ts`の10,000件前後のwindow切替を回帰実行する
- **変更ファイル**: `src/api/fetchAll.ts`（古いbranchに文言がある場合はコメントだけ。現在HEADでは変更不要）
- **新規ファイル**: なし
- **テストファイル**: `src/api/__tests__/fetchAll.test.ts`

### Phase 1: cursor client

#### Step 1-1: 必須interfaceと共有handle

- `KintoneCursorHandle`、`OpenCursorParams`、raw cursor transport、冪等state machineを追加する
- `KintoneClient.openCursor`を必須化し、§3.2の全objectをコンパイルエラーから順に埋める
- **変更ファイル**: `src/execute.ts`、`src/core/index.ts`、§3.2記載の全production wrapper/mockと全test mock
- **新規ファイル**: `src/api/kintoneCursor.ts`
- **テストファイル**: `src/api/__tests__/kintoneCursor.test.ts`、`src/api/__tests__/kintoneCursor.property.test.ts`

#### Step 1-2: Node/plugin raw adapter

- NodeでPOST/GET/DELETE cursor endpointを実装し、guest/profile/token/base URLをhandle生成時に固定する
- pluginで`kintone.api()`の同3 endpointとreject正規化を実装する
- fields省略と`size:500`固定を検査し、cursor IDをerror/logへ露出しない
- **変更ファイル**: `src/cli/nodeKintoneClient.ts`、`src/ui/kintoneClient.ts`
- **新規ファイル**: なし
- **テストファイル**: `src/cli/__tests__/nodeKintoneClient.test.ts`、`src/ui/__tests__/kintoneClient.test.ts`

#### Step 1-3: retryなしRequestGate

- `RequestGate.runCursorStep()`と`withRequestGate()`のhandle wrapperを実装する
- Create/Get/Deleteの408/429/5xx/network errorが再試行されず、slotだけ解放されることを固定する
- **変更ファイル**: `src/api/requestGate.ts`
- **新規ファイル**: なし
- **テストファイル**: `src/api/__tests__/requestGate.test.ts`

#### Step 1-4: routing固定

- logical app、guest space、複数profileの`openCursor`をcreate時clientへ束縛し、後続page/closeでrouteを再解決しない
- CLI側のprofile routerとMCP共通Node runtimeの両方を試験する
- **変更ファイル**: `src/node/runtime.ts`、`src/cli/index.ts`
- **新規ファイル**: なし
- **テストファイル**: `src/node/__tests__/runtime.test.ts`、`src/cli/__tests__/integration.test.ts`、`src/mcp/__tests__/tools.test.ts`

### Phase 2: lease・cleanup

#### Step 2-1: host lease manager

- host単位active semaphore（既定2、最大5）、Add mutex（1固定）、30秒permit timeoutを実装する
- guest/profile/logical appが同じhost keyを共有し、異なるhostは独立するfixtureを追加する
- **変更ファイル**: `src/node/config.ts`、`src/node/runtime.ts`、`src/cli/index.ts`、`src/ui/desktop.ts`
- **新規ファイル**: `src/api/cursorLeaseManager.ts`
- **テストファイル**: `src/api/__tests__/cursorLeaseManager.test.ts`、`src/node/__tests__/config.test.ts`

#### Step 2-2: cleanup timeout・再確認・quarantine

- 5秒の独立cleanup budget、1回のDELETE再確認、10分+30秒quarantineを共有state machineへ実装する
- Phase 0で観測した応答だけを既解放fixtureとして登録し、未観測status/codeを成功扱いしない
- Create応答喪失、Delete outcome unknown、遅れて成功したDelete、timer解放をfake clockで固定する
- **変更ファイル**: `src/api/kintoneCursor.ts`、`src/api/cursorLeaseManager.ts`
- **新規ファイル**: `src/core/errors/cursorErrors.ts`
- **テストファイル**: `src/api/__tests__/kintoneCursor.test.ts`、`src/api/__tests__/cursorLeaseManager.test.ts`

#### Step 2-3: warning・エラー合成・診断counter

- 元エラーを主因に保ちcleanup診断を付加する。成功結果+cleanup失敗は`CursorCleanupWarning`を`SelectResult.warnings`へ出す
- `ExecuteMetrics`と`wrapClientWithMetrics()`へR3 §13の8 counterを追加する
- current/peak/quarantine counterはlease snapshotから取得し、cursor IDは含めない
- **変更ファイル**: `src/execute.ts`、`src/cli/index.ts`、`src/mcp/tools.ts`、`src/ui/renderResult.ts`
- **新規ファイル**: なし
- **テストファイル**: `src/__tests__/execute.test.ts`、`src/cli/__tests__/batchJsonOutput.test.ts`、`src/mcp/__tests__/tools.test.ts`、`src/ui/__tests__/renderResult.test.ts`

#### Step 2-4: cancel・timeoutからcleanupを待つ

- execution-scoped AbortSignalを内部optionへ通し、KORDER cursor executorだけが利用者cancel/batch timeoutを観測できるようにする
- `runWithDeadline()`が元promiseを放置したままsurfaceへ返る形に依存せず、cursor abort後に独立cleanupが完了またはquarantineへ移るまで待つ
- **変更ファイル**: `src/execute.ts`、`src/cli/index.ts`、`src/mcp/tools.ts`、`src/ui/desktop.ts`
- **新規ファイル**: なし
- **テストファイル**: `src/__tests__/executeBatch.test.ts`、`src/__tests__/execute.test.ts`、`src/mcp/__tests__/tools.test.ts`

### Phase 3: KORDER planner / executor

#### Step 3-1: `KORDER_CURSOR` planner

- plan kind、reason code、safe integer検査、native優先、cursorの`scanRows <= maxRecords`を実装する
- `LIMIT 501`、`LIMIT 10001`、`LIMIT 1 OFFSET 10001`、nativeの`LIMIT 500 OFFSET 10000`を固定する
- **変更ファイル**: `src/core/optimization/canonicalOrderPlanner.ts`、`src/core/optimization/korderPlanner.ts`、`src/execute.ts`
- **新規ファイル**: なし
- **テストファイル**: `src/core/optimization/__tests__/korderPlanner.test.ts`、`src/__tests__/explain.test.ts`

#### Step 3-2: Cursor query生成

- 完全押し下げ済みWHEREと利用者KORDERキー・方向だけをqueryへ入れ、LIMIT/OFFSETと暗黙`$id`を入れない
- 複数キーは指定順を保ち、SELECTされていないKORDERキーをfieldsへ追加しない
- **変更ファイル**: `src/converter/selectToKintone.ts`
- **新規ファイル**: `src/converter/korderCursorQuery.ts`
- **テストファイル**: `src/converter/__tests__/korderCursorQuery.test.ts`

#### Step 3-3: offset skip・limit collect・早期DELETE

- `executeSimpleSelect()`の`KORDER_NATIVE`単発GETの隣へ`KORDER_CURSOR`だけを接続する
- `totalCount <= offset`、空ページ、途中`next=false`、必要窓到達、10,001件、変換失敗を実装する
- Cursor順を保持し、`applyOrderBy()`と`applyLimit()`を二重適用しない
- **変更ファイル**: `src/execute.ts`
- **新規ファイル**: `src/core/optimization/korderCursorExecutor.ts`
- **テストファイル**: `src/__tests__/execute.test.ts`、`src/api/__tests__/kintoneCursor.test.ts`

#### Step 3-4: 複文・非対象経路の固定

- 複文batchが前文close完了後に次文cursorを作ることを確認する
- JOIN / UNION / CTE / subquery / SELECT-based DML / nested KORDERはAPI前に拒否し、通常ORDER/FULL_SCAN/DMLのcursor counterが0であることを確認する
- **変更ファイル**: `src/execute.ts`（必要な場合のみ）
- **新規ファイル**: なし
- **テストファイル**: `src/__tests__/executeBatch.test.ts`、`src/parser/__tests__/parser.test.ts`、`src/__tests__/execute.test.ts`

### Phase 4: surface・文書・smoke・release

#### Step 4-1: EXPLAINとsurface表示

- R3 §13のplan名、API、page size、scan rows、process-local concurrency、orderingを表示する
- CLI/MCP/pluginで`CursorCapacityError`、`CursorCreateTimedOutError`、`CursorCreateOutcomeUnknownError`、`CursorCleanupWarning`のcodeと主要文言を共通化する
- EXPLAINはmetadataだけを読み、Cursor API counterが0であることを固定する
- **変更ファイル**: `src/execute.ts`、`src/cli/index.ts`、`src/mcp/tools.ts`、`src/mcp/index.ts`、`src/mcp/schemas.ts`、`src/ui/renderResult.ts`、`src/ui/desktop.ts`
- **新規ファイル**: なし
- **テストファイル**: `src/__tests__/explain.test.ts`、`src/mcp/__tests__/tools.test.ts`、`src/cli/__tests__/integration.test.ts`、UI関連test

#### Step 4-2: 公開設定とplugin離脱cleanup

- `cursorMaxActive`をCLI/env/profile/MCP runtime/pluginへ追加し、1..5以外を明示エラーにする
- pluginのactive handle registry、`pagehide`、`beforeunload` best-effort closeを実装し、通常finallyとの重複を冪等化する
- **変更ファイル**: `src/node/config.ts`、`src/node/runtime.ts`、`src/cli/index.ts`、`src/mcp/tools.ts`、`src/mcp/schemas.ts`、`src/ui/desktop.ts`、`src/ui/kintoneClient.ts`、設定sample
- **新規ファイル**: 必要なら`src/ui/cursorPageLifecycle.ts`
- **テストファイル**: `src/node/__tests__/config.test.ts`、CLI/MCP/UI設定test、`src/ui/__tests__/cursorPageLifecycle.test.ts`

#### Step 4-3: 公開文書とv3.1.0成果物

- SemVerは、既存queryを変更せず新しい成功可能範囲と設定を加えるため**minor**とし、v3.0.0からv3.1.0へ上げる
- `CHANGELOG.md`へB33+B9+B29、Cursorの制限、cleanup warning、process-local上限を記載する
- `docs/ksql_language_reference.md`のKORDER上限表を、単発GET窓=`KORDER_NATIVE`、それ以外かつ`scanRows <= maxRecords`=`KORDER_CURSOR`へ更新する
- 新規`docs/ksql_v3_1_migration_guide.md`へ設定、エラー、完全snapshotでない制限、B9/B29の意味論変更をまとめる。v3.0.0用`docs/ksql_v3_migration_guide.md`は履歴として書換えない
- README、MCP tool description/schema `.describe()`、設定sample、台帳はreview承認後のrelease作業で同期する
- package/lock、`prod/manifest.json`、CLI/MCP/MCPB/plugin bundle等をv3.1.0へ同期し、生成bundleに`KORDER_CURSOR`と新error codeが含まれることを確認する
- **変更ファイル**: `CHANGELOG.md`、`docs/ksql_language_reference.md`、README、設定sample、`package.json`、`package-lock.json`、`prod/manifest.json`、build成果物、承認後の`docs/ksql_issue_tracker.md`
- **新規ファイル**: `docs/ksql_v3_1_migration_guide.md`
- **テストファイル**: release smoke script、MCP/MCPB verify、bundle文字列guard

#### Step 4-4: 実機smoke

- Claudeまたはユーザー実機がCLI / MCP / Chromium / Firefoxを実施する
- 10,001件以上の順序、1,501件以上で500件境界へ同値群を置くfixture、`$id`二次キー有無×ASC/DESC、早期DELETE直後の再Createを確認する
- pluginでは通常完了、実行中cancel、ページ離脱、cleanup warning表示をChromium/Firefox別々に確認する
- **変更ファイル**: 実測で契約差が判明した場合は先にR3へ指摘し、黙って実装だけを合わせない
- **新規ファイル**: redact済みsmoke記録（release手順に従う）
- **テストファイル**: Node代用なし。実機release gate

## 6. テスト計画

### 6.1 planner unit test

R3 §14.1を`src/core/optimization/__tests__/korderPlanner.test.ts`のtableへ落とす。期待値はplan kindだけでなく`scanRows`、reason code、API call countも固定する。`Number.MAX_SAFE_INTEGER`前後と加算overflowを含める。

### 6.2 lifecycle fixture test

`src/api/__tests__/fixtures/korderCursorPages.ts`は、ページ配列、`next`、`totalCount`、各stepのthrow、Delete観測結果を宣言する有限fixtureだけを持つ。次を例示fixtureで検証する。

- 500/501/1,000/10,001件のページ連結
- `records=[] / next=true`
- offsetがページ中央・境界・総件数以降
- 早期close、`next=false`後no-delete、多重close
- abort/timeout/Get/変換失敗
- 成功+cleanup失敗、失敗+cleanup失敗
- Create/Get retry 0、Delete再確認1

### 6.3 lifecycle property test

`src/api/__tests__/kintoneCursor.property.test.ts`はfixtureの具体例を増やす場所ではなく、modelと生成action列の不変条件を検証する。

- `close()`成功または`next=false`後にactive permitが最終的に1回だけ返る
- outcome unknownではquarantine期限前にpermitが返らない
- Delete side effectは、Phase 0で別契約と確定しない限り1初回+1再確認を超えない
- `nextPage()`の同時呼出しでもページ順が入替わらない
- 任意の空ページ列で`next=true`なら終了しない
- 元エラーはcleanup errorで上書きされない

seedを失敗出力へ含め、CI再現可能にする。性質testはraw kintoneの順序事実を証明しない。

### 6.4 concurrency・routing test

R3 §14.3を`cursorLeaseManager.test.ts`、`runtime.test.ts`、`executeBatch.test.ts`へ分ける。

- lease manager: same host Add直列、active上限、permit timeout、quarantine、異host独立
- runtime: guest/profile/logical appの作成時route固定
- batch: 1文1cursor、close完了前に次Createなし、nestedは0cursor
- RequestGate: cursor stepはHTTP semaphoreに入るがretryなし

### 6.5 実機だけが証明できる項目

次はNode mockで代用しない。

| 項目 | 実機担当 / surface | Nodeで代用できない理由 |
|---|---|---|
| Delete済み・自動削除済みIDの応答 | Claude/ユーザー、raw API | status/codeはkintone実応答でしか確定しない |
| 5分Create timeout後の枠残存 | Claude/ユーザー、隔離domain | サーバー側cursor資源状態である |
| 10,001件のKORDER順 | Claude/ユーザー、CLI/MCP/plugin | 複数ページの順序保証が公式明文だけで確定しない |
| 500件境界の同値群 | Claude/ユーザー、4 surface | mockはkintone固有tieを再現した前提に過ぎない |
| pagehide/beforeunload cleanup | Claude/ユーザー、Chromium/Firefox | Node/JSDOMは実ブラウザのunload/network打切りを再現しない |
| plugin warning/error表示 | Claude/ユーザー、Chromium/Firefox | 実`kintone.api()` rejectとDOM lifecycleが必要である |

CLI / MCPも同じcore contractを使うことはunit testできるが、認証route、実API error、実件数・順序のrelease gateは各surfaceで実施する。

## 7. EXPLAIN・診断・エラー契約

EXPLAINはR3 §13を参照し、事実を重複定義しない。表示を次の責務へ分ける。

- planner: plan kind、scan rows、ordering
- executor capability: fetch API、page size
- runtime configuration: cursor concurrencyとprocess-local注記
- metrics: create/get/delete、active current/peak、cleanup failure、outcome unknown、quarantine current、scanned records

新規error/warningは`src/core/errors/cursorErrors.ts`で一元生成する。

| code | 条件 | surface契約 |
|---|---|---|
| `CursorCapacityError` | 30秒でpermitを得られない | API前失敗。host、上限、待機時間を出しIDは出さない |
| `CursorCreateTimedOutError` | 公式5分timeoutと識別できる実応答 | query簡素化・絞込みを案内し、資源不存在を断定しない |
| `CursorCreateOutcomeUnknownError` | Create応答喪失 | 自動retry禁止と最大10分+余裕の枠影響可能性を案内する |
| `CursorCleanupWarning` | 主処理成功、解放未確認 | 正しい結果と同時に目立つwarningを返す |

主処理失敗時は元errorを主因とし、cleanup診断をcause/detailへ付加する。CLI / MCP / pluginが独自文言を組み立てない。

## 8. 受入条件対応表

| R3 §16 | 受入条件の要点 | 充足Phase / Step |
|---:|---|---|
| 1 | Cursor計画は`KORDER_CURSOR`だけ | Phase 3 Step 3-1/3-4、Phase 4 Step 4-1 |
| 2 | ORDER/FULL_SCAN/JOIN/DMLは現行方式 | Phase 0 Step 0-5、Phase 3 Step 3-4 |
| 3 | `KORDER_NATIVE`単発GET不変 | Phase 0 Step 0-1、Phase 3 Step 3-1/3-3 |
| 4 | safeな`scanRows <= maxRecords`でcursor選択 | Phase 3 Step 3-1 |
| 5 | 501/0/501境界 | Phase 0 Step 0-1、Phase 3 Step 3-1 |
| 6 | Cursor順をlocal再sortしない | Phase 3 Step 3-2/3-3、Phase 4 Step 4-4 |
| 7 | 必要窓到達で明示DELETE | Phase 2 Step 2-2、Phase 3 Step 3-3 |
| 8 | 全件取得以外の全終了でDELETE試行 | Phase 0 Step 0-2、Phase 2 Step 2-2/2-4 |
| 9 | cleanup不明permitをquarantine | Phase 2 Step 2-1/2-2 |
| 10 | same host Add非並行 | Phase 2 Step 2-1 |
| 11 | active既定2・最大5 | Phase 2 Step 2-1、Phase 4 Step 4-2 |
| 12 | Create/GetにGET retryなし | Phase 1 Step 1-3 |
| 13 | 空ページは`next`に従う | Phase 0 Step 0-2、Phase 3 Step 3-3 |
| 14 | DML/nested/allowlist外を許可しない | Phase 0 Step 0-1、Phase 3 Step 3-4 |
| 15 | CLI/MCP/plugin同一contract | Phase 1 Step 1-2/1-4、Phase 4 Step 4-1/4-4 |
| 16 | Delete既解放応答を実測固定 | Phase 0 Step 0-3、Phase 2 Step 2-2 |
| 17 | 複数ページ順・同値安定性を実機確認 | Phase 4 Step 4-4 |
| 18 | 複数キー1、複文1文1、nested 0 | Phase 0 Step 0-1、Phase 3 Step 3-2/3-4 |

## 9. 実装レビューgate

- [ ] Phase 0の2種Delete応答を実測する前に既解放status/codeを実装していない
- [ ] 公式5分timeout後にcursorが残らないと断定していない
- [ ] `openCursor`がoptionalでなく、§3.2のproduction objectとmockがすべて型検査を通る
- [ ] spread wrapperのmetrics、gate、routingを型検査だけで済ませていない
- [ ] Get Cursorを`runReadOnly()`へ載せていない
- [ ] Create/Getを自動retryしていない
- [ ] cleanupが本処理のabort済みsignalを再利用していない
- [ ] cleanup失敗が元errorを上書きしていない
- [ ] 解放不明permitを即時返していない
- [ ] lease keyへguest path、profile名、app IDを使っていない
- [ ] `KORDER_NATIVE`優先境界へcursorの`scanRows`上限を誤適用していない
- [ ] `LIMIT 0`が型・WHERE・query形状検査を短絡していない
- [ ] Cursor queryへLIMIT/OFFSET、暗黙`$id`、LIKE/KLIKEを入れていない
- [ ] Cursor結果を`applyOrderBy()`で再sortしていない
- [ ] `src/api/fetchAll.ts`へCursor APIを接続していない
- [ ] EXPLAINがCursor APIを実行していない
- [ ] cursor IDを通常ログ、error、EXPLAINへ出していない
- [ ] plugin離脱cleanupをNode testだけで完了扱いにしていない
- [ ] B9/B29との共有ファイル競合を課題別commitと統合testで解消した
- [ ] `.claude/settings.local.json`等の個人設定をcommitへ含めていない

## 10. 検証コマンド

Phaseごとの対象testを先に実行し、統合時に次を通す。

```powershell
npm test -- --runInBand
npm run build
npm run mcp:verify
npm run mcpb:verify
rg -n ">= ?10000.*API.*エラー|10000.*以上.*API.*エラー" src/api/fetchAll.ts
rg -n "KORDER_CURSOR|CursorCapacityError|CursorCleanupWarning" prod dist mcpb
git diff --check
```

古いコメント検出用`rg`は**0件を期待**する。実機smokeはこのコマンド列と別のrelease gateであり、Node成功で代用しない。生成物の実pathは実装時のbuild出力へ合わせて調整する。

## 11. 推奨コミット列

1. `test: add B33 cursor planner and lifecycle fixtures`
2. `feat: add required kintone cursor client contract`
3. `feat: add cursor lease and cleanup lifecycle`
4. `feat: plan and execute KORDER_CURSOR windows`
5. `feat: expose cursor diagnostics and surface settings`
6. `docs: prepare B33 for v3.1.0 release`
7. B9/B29の独立commit列
8. `chore: integrate B33 B9 B29 release artifacts for v3.1.0`

途中commitは公開releaseとせず、B33+B9+B29の全gate通過後にv3.1.0を一度公開する。B33は加法的機能なのでSemVer minorである。B9/B29に利用者可視の意味論変更が含まれる場合も、v3.1.0移行文書で個別に明示し、B33のAPI lifecycle変更と混同しない。

## 12. R3への指摘

R1作成時点で、R3本文を変更しなければ実装不能となる矛盾は確認していない。ただし次の実装上の注意はR3改訂候補である。

1. 現行`BatchExecuteOptions.timeoutMs`は`runWithDeadline()`で呼出し元を先に失敗させ得る一方、進行中HTTPを中断しない。B33の「timeoutでもfinallyからDELETE」をsurfaceが待つには、Phase 2 Step 2-4のexecution-scoped cancellation契約を明文化するとreviewしやすい
2. `src/api/fetchAll.ts`の古い「`>=10000`はAPIエラー」コメントは現在HEADでは訂正済みである。R3または後続計画では「未修正の変更項目」ではなく「引継ぎ回帰確認」として扱うのが正確である

これらはDelete実応答や5分timeout後の残存を推定する指摘ではない。
