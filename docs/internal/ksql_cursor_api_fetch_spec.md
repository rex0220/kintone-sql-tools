# B33: `KORDER BY` 大規模窓の Cursor API 対応（設計案 R4）

## 0. ステータス

- 種別: 設計確定・実装中。**R4（2026-07-18）: 実装前 blocker だった Delete 実応答を実機実測し §14.4 / §17 へ反映**（明示 Delete 済み・自動削除済みの 2 経路とも `HTTP 404` + `GAIA_CN01` で完全同一・[実測記録](evidence/b33_cursor_delete_responses.md)）。同日、planner/executor・client lifecycle・lease/cleanup・各surface設定まで実装し、ローカルtest/build/MCP検証を通過。**複数ページ順序release blockerはAPP730のCLI/MCP実機smoke 7/7完全一致で解消**（[実測記録](evidence/b33_cli_mcp_smoke.md)）。残るrelease blockerはplugin実機確認
- 対象バージョン: **v3.1.0（B33 単独リリースと決定・2026-07-18）**。B9/B29 は同居させず後続 minor（v3.3.0 目安）へ分離する。B9↔B29 の「同時着手が安価」（B9 再昇格トリガー②）の関係は両者の同時リリース時に回収する
- 対象: 単発Records APIで完結しない `KORDER BY` の結果窓
- 非対象: 通常の `ORDER BY`、FULL_SCAN、JOIN、DML、一時テーブルの取得方式変更

R1は Cursor API を `fetchAll` 全体へ導入する案だった。R2では10,000件超の `KORDER BY` だけへ限定したが、`LIMIT 500`は成功、501は失敗、10,001は成功という穴あき契約になった。R3ではCursor APIを使う経路を `KORDER BY` だけに保ちながら、境界を **単発Records APIで完結するか** へ改める。

B33は、現在planning errorになるqueryを成功させる加法的機能である。状態管理、cleanup、ブラウザ終了という新しい障害モードを、実機smokeだけが残るv3.0.0へ追加しない。v3.0.0のB26 / B27 / B30 / B31 / B32を先にリリースする。

本書でいう Cursor API は、kintone REST API の次の3 APIを指す。

- [カーソルを作成する](https://kintone.dev/en/docs/kintone/rest-api/records/create-cursor/)
- [カーソルからレコードを取得する](https://kintone.dev/en/docs/kintone/rest-api/records/get-cursor/)
- [カーソルを削除する](https://kintone.dev/en/docs/kintone/rest-api/records/delete-cursor/)

## 1. 結論

Cursor APIを利用する計画は、次の1種類だけとする。

```text
KORDER_CURSOR
```

通常のレコード取得へCursor APIを導入しない。

| 処理 | 取得方式 |
|---|---|
| 通常の `ORDER BY` / FULL_SCAN | 現行のRecords API＋`$id`キーセットページング |
| `CANONICAL_REST_TOP_N` | 現行の単発Records API |
| 小さい `KORDER BY` | 現行の `KORDER_NATIVE`（単発Records API） |
| 単発GETで完結しない `KORDER BY` | 新しい `KORDER_CURSOR` |
| JOIN / UNION / CTE / DML / 一時テーブル | Cursor API対象外 |

これにより、Cursor APIの状態管理、同時カーソル上限、cleanup失敗の影響範囲を `KORDER BY` の1経路へ閉じ込める。

### 1.1 複数の `KORDER` が必要な場合

「複数」には3種類あるため、契約を分ける。

#### 1つの `KORDER BY` に複数キーを書く場合

```sql
SELECT 会社名, 金額
FROM APP100
KORDER BY 業種 ASC, 金額 DESC, $id ASC
LIMIT 1000;
```

これは1つの順序定義であり、作成するカーソルは **1個**である。Create Cursorのqueryへ、キー列と方向を指定順のまま渡す。ページごと、キーごとにカーソルを分けない。最後の `$id` は同値群を決定的にする利用者指定の二次・三次キーであり、kSQLが暗黙追加しない。

#### 複文バッチに複数のトップレベル `KORDER BY` 文がある場合

```sql
SELECT * FROM APP100 KORDER BY 金額 LIMIT 1000;
SELECT * FROM APP200 KORDER BY 更新日時 DESC LIMIT 1000;
```

各SQL文が独立して1個のカーソルを作る。現行 `executeBatch` は文を順次実行するため、1文目のカーソルを全件取得または明示削除してから2文目を開始する。通常は同時active cursor数は1である。

将来、独立文を並列実行するsurfaceを追加しても、文ごとに別カーソルとし、host単位lease managerの既定2・最大5を超えない。1文の失敗やcleanupを別文のカーソルIDへ流用してはならない。

#### 1つのSQL内部の複数箇所で `KORDER BY` が必要な場合

次は初期KORDER契約で拒否する。

- JOINの各入力を別々のkintone順にしたい
- UNIONの各分岐へ `KORDER BY` を書く
- CTE、IN/scalar subquery、SELECT-based DMLの内側へ書く
- 1つのSELECTへ複数の `KORDER BY` 節を書く

parserは `KORDER BY` を利用者へ直接結果を返すトップレベルSELECTだけに許可し、plannerは単一物理アプリだけを許可する。したがって、この形ではカーソルを複数作るのではなく、**最初のAPI呼び出し前にParseErrorまたはplanning error**とする。

複数アプリのkintone固有順は、各アプリ内では定義できても、JOIN / UNION後の1つの大域順序へそのまま合成できない。将来nested KORDERを導入する場合は、「各枝のtop-Nを順次materializeし、カーソルを枝ごとに閉じる」機能と、「外側結果を何順にするか」という別の言語仕様が必要であり、B33には含めない。

## 2. 限定する根拠

### 2.1 通常の全件取得は現行方式で10,000件超に対応済み

現行の `src/api/fetchAll.ts` は、Records APIの `offset` が10,000付近へ達すると、次の条件へ切り替える。

```sql
$id > 最終取得ID ORDER BY $id ASC
```

これは Cursor API ではなく、`$id` によるキーセットページングである。`maxRecords` を引き上げれば、通常のFULL_SCANは既に10,000件超を取得できる。

通常の `ORDER BY` は全候補取得後に共有比較器で並べるため、取得時のkintone順を維持する必要がない。したがって、v3.0.0でCursor APIを追加しなければ実現できない機能ではない。

### 2.2 `KORDER BY` はローカルで再現できない

`KORDER BY` は、高速化ヒントではなく、kintone REST APIの型別順序を選ぶ別意味論である。

- 選択肢の定義順
- STATUSのプロセス定義順
- kintone固有の空値位置
- kintone側の同値群順

これらを共有canonical比較器で置き換えると、`KORDER BY` ではなく通常の `ORDER BY` になる。`$id > 最終ID` を主キーにしたキーセットページングも、利用者が指定したkintone順を壊すため利用できない。

したがって、**kintone順のまま単発Records APIの窓を超える処理**が、Cursor APIを必要とする唯一のB33対象である。

## 3. Cursor APIへ切り替える境界

アプリの総レコード数ではなく、単発Records APIで要求窓を取得できるかで判定する。Cursor APIへ入った後の実走査件数は、要求した窓へ到達するために先頭から読み進める件数である。

```ts
const scanRows = offset + limit;
```

例:

| SQL | `scanRows` | 計画 |
|---|---:|---|
| `KORDER BY 金額 LIMIT 100` | 100 | `KORDER_NATIVE` |
| `KORDER BY 金額 LIMIT 500 OFFSET 10000` | 10,500 | 単発GETで公式範囲内のため `KORDER_NATIVE` |
| `KORDER BY 金額 LIMIT 501` | 501 | `KORDER_CURSOR` |
| `KORDER BY 金額 LIMIT 1 OFFSET 10001` | 10,002 | `KORDER_CURSOR` |
| `KORDER BY 金額 LIMIT 10001` | 10,001 | `KORDER_CURSOR` |

単にアプリが10,000件を超えるだけではCursor APIを作成しない。`LIMIT 100`なら、アプリ総件数が100万件でも単発GETだけを使う。

### 3.1 R2の不連続を廃止する

R2は次のqueryを意図的に拒否していた。

```sql
SELECT * FROM APP100 KORDER BY 金額 LIMIT 501;
```

しかし、501件をCursor APIで取得するときのページ連結と、10,001件をCursor APIで取得するときのページ連結に異なる証明義務はない。R2は高コストな10,001件を許可し、低コストな501件を拒否していたため、R3ではこの不連続を廃止する。

Records APIのoffset複数ページ方式は追加しない。単発GETで完結しないKORDER窓は、件数にかかわらず同じ `KORDER_CURSOR` で処理する。

## 4. planner契約

### 4.1 共通の `KORDER BY` 条件

`KORDER_NATIVE` と `KORDER_CURSOR` は、R8で確定した次の条件を共有する。

1. トップレベルSELECTである
2. 単一の物理アプリである
3. キーは非修飾の直接物理フィールドである
4. 型はKORDER native allowlistに含まれる
5. WHERE全体をkintoneへ完全押し下げできる
6. `KLIKE` を含まない
7. `LIMIT` を明示する
8. `LIMIT >= 0`、`OFFSET >= 0` である
9. `LIMIT`、`OFFSET`、`OFFSET + LIMIT` がすべて安全な整数である
10. nested SELECT、DISTINCT、GROUP BY、HAVING、window関数を含まない
11. 条件を満たさない場合、通常の `ORDER BY` へフォールバックしない

### 4.2 計画選択

```ts
const scanRows = offset + limit;
if (
  !Number.isSafeInteger(limit) ||
  !Number.isSafeInteger(offset) ||
  !Number.isSafeInteger(scanRows)
) {
  throw KorderPlanningError;
}

if (limit <= 500 && offset <= 10_000 && limit <= maxRecords) {
  return KORDER_NATIVE;
}

if (scanRows <= maxRecords) {
  return KORDER_CURSOR;
}

throw KorderPlanningError;
```

`LIMIT 0` は、全条件を検査した後にAPIを呼ばず空結果を返す。

### 4.3 `maxRecords`

`KORDER_CURSOR` では、返却行数ではなく読み飛ばすOFFSETを含む走査件数へ `maxRecords` を適用する。

```text
OFFSET + LIMIT <= maxRecords
```

例:

```sql
-- scanRows = 10,500。maxRecords が10,000ならplanning error
SELECT * FROM APP100
KORDER BY 金額
LIMIT 500 OFFSET 10000;
```

ただしこの例は `LIMIT <= 500 && OFFSET <= 10000` なので、単発GETで実行できる場合は `KORDER_NATIVE` を優先し、500件だけを受信する。`scanRows` 上限を適用するのはCursor APIへ入る場合だけである。

この非対称は、OFFSETを誰が処理するかで決まる。`KORDER_NATIVE` のOFFSETはkintoneサーバーが読み飛ばし、kSQLが受信するのはLIMIT行だけである。`KORDER_CURSOR` のOFFSETはkSQLが先頭から受信して捨てるため、既存の「kSQLが受信する行数の上限」である `maxRecords` へ `OFFSET + LIMIT` を適用する。

`KORDER_CURSOR` で `OFFSET + LIMIT` がCLI/MCPの既定 `maxRecords=500` を超える場合、利用者は必要な走査件数以上へ明示的に引き上げる。

## 5. Cursor queryと結果窓

Create Cursor APIへ渡すqueryには、次だけを含める。

- 完全押し下げ可能と確認済みのWHERE
- 利用者が指定した `KORDER BY` のキーと方向

SQLの `LIMIT / OFFSET` はCursor queryへ含めない。公式例と同様に、Cursor APIの `size=500` で順番に取得する。

```text
WHERE条件 order by 利用者キー...
```

取得処理:

1. `offset` 件を順番に読み飛ばす
2. 続く `limit` 件を結果へ格納する
3. `limit` 件へ到達したら、それ以降を取得せずカーソルを明示削除する
4. 途中で `next=false` になったら、得られた行だけを返す

Cursor APIが返す順序をそのまま結果順とする。ローカル再ソート、canonical tie、`$id asc` の追補を行わない。決定的な同値群順が必要な利用者は、v3.0.0契約どおり `$id` を最後の `KORDER BY` キーとして明示する。

## 6. 公式制約とkSQL契約

| 項目 | kintone公式契約 | kSQL R3 |
|---|---|---|
| 1回の取得件数 | `size` 最大500、既定100 | 500固定 |
| 有効カーソル | 1ドメイン最大10個（**実測確認済み・R4**: 10個目まで成功・11個目は `HTTP 429`+`GAIA_TM12`・[実測記録](evidence/b33_cursor_timeout_capacity_probe.md)） | kSQLは既定2、設定しても最大5 |
| Add Cursorの並行性 | 同一ドメインで並行作成要求があると、後続要求はサーバー側で待機 | host単位mutexでクライアント側から直列化 |
| 有効期限 | 作成から10分。残件取得時に10分延長 | 停止せず逐次取得。期限切れは明示エラー |
| 解放 | 全件取得、削除、期限切れ | 全件取得以外は必ず明示削除 |
| Add Cursor timeout | サーバー側で5分経過するとtimeoutエラー | queryの単純化・絞り込みを案内し、自動再試行しない |
| 対象集合 | 作成時点で固定 | KORDER結果集合の基準とする |
| フィールド値 | 各Get時点の値 | 完全snapshotではないと明記 |
| 空ページ | `records=[]`, `next=true` があり得る | `next` だけで終了判定 |

カーソルを閉じないと、期限切れまで最大10分程度、ドメインの10枠の1つを占有する。異常終了が続けば、同じドメインを使う他処理のCreate Cursorも失敗し得る。

Add Cursor mutexは、並行要求がAPIエラーになることを防ぐ機構ではない。サーバー待機中の要求が既存 `RequestGate` のHTTPセマフォ枠を占有し、最大5分のCreate timeout窓へ滞留することを防ぐために置く。

## 7. クライアント契約

Cursor APIを一般の `fetchAll` へ混ぜず、KORDER実行器が次のハンドルを消費する。

```ts
interface KintoneCursorHandle {
  readonly totalCount: number;
  nextPage(): Promise<{
    records: KintoneRecord[];
    next: boolean;
  }>;
  close(): Promise<void>;
}

interface KintoneClient {
  // 既存メソッド省略
  openCursor(params: {
    app: number;
    fields?: string[];
    query: string;
    size: 500;
  }): Promise<KintoneCursorHandle>;
}
```

`openCursor` はoptionalにしない。`withRequestGate()` は `KintoneClient` のメソッドを列挙して新しいobjectへ再構築するため、必須メソッドにしてwrapper・Node・plugin・mockへの追加漏れをコンパイルエラーにする。

`fields` はSELECT出力に必要な列だけでよい。`KORDER_CURSOR` はkintoneが返した順序をローカル比較せず、OFFSETも行数だけを数えるため、SELECTされていないKORDERキーを取得する必要はない。

`searchAborted` は初期interfaceに持たせない。現行plannerではSQL `LIKE` は残余評価になり、`KLIKE` はKORDER条件で禁止されるため、Cursor queryへ `like / not like` は入らない。将来KLIKEを許可する場合に、警告headerの契約とともに追加する。

ハンドルは作成時のbase URL、guest space、API token/profile、カーソルID、カーソルリースを保持する。IDだけの `getCursor(id)` を公開し、論理アプリの別profileから誤って続きを取得できる構造にしない。

`close()` は冪等とする。`next=false` 後はkintoneが自動解放済みなので、ネットワーク要求を送らず成功する。

## 8. cleanup契約

### 8.1 解放確認を必須にする

処理は次のいずれかへ到達するまで、カーソル解放処理を終了扱いにしない。

- `next=false` を受け取った
- Delete Cursor APIが成功した
- Delete Cursor APIが、実測で確定した「既に解放済み」を示す応答を返した

次のすべてで `finally` から `close()` を呼ぶ。

- `OFFSET + LIMIT` 件へ到達した早期終了
- `maxRecords` 関連エラー
- 利用者キャンセル
- timeout
- Get Cursor失敗
- レコード変換失敗
- 呼び出し元例外

呼び出し元の `AbortSignal` は既にabort済みの場合がある。cleanupは同じsignalを使わず、短い独立cleanup timeoutを使う。

### 8.2 cleanup失敗

| 状況 | 結果 |
|---|---|
| 本処理成功、早期close失敗 | 正しい結果を返し、目立つ `CursorCleanupWarning` と診断を付ける |
| 本処理失敗、close成功 | 元のエラーを返す |
| 本処理失敗、closeも失敗 | 元のエラーを主因とし、cleanup失敗を診断へ付加 |
| DELETE再確認が実測済みの既解放応答 | 解放済みとして成功 |

cleanup失敗を無言で隠さない。一方、正しい結果をDELETE失敗だけで捨てると、再実行により高コストなCursorをもう1つ作る運用被害があるため、成功結果には警告を付けて返す。元のSQLエラーがある場合はcleanupエラーで上書きしない。

cleanup失敗またはCreate応答喪失でサーバー上のカーソル存否が不明な場合、active permitを即時返さない。最後に成功したCreate/Getから10分と安全余裕が経過するまで **quarantine lease** として保持し、その後に返す。これにより、同一プロセスが不明なカーソルを無視して新規カーソルを作り続けることを防ぐ。

## 9. 同時カーソル数

既存の `RequestGate` はHTTP要求単位の同時数を制御するだけで、複数要求にまたがる有効カーソル数を制御できない。別のcursor lease managerを設ける。

| 制御 | 既定 | 上限 | 単位 |
|---|---:|---:|---|
| active cursor | 2 | 5 | ドメイン・プロセス |
| 同時Add Cursor | 1 | 1固定 | ドメイン |
| 同一カーソルのGet | 1 | 1固定 | カーソル |

手順:

1. active cursor permitを取得
2. host単位Add Cursor mutexを取得
3. Create Cursorを1回呼ぶ
4. mutexを解放
5. 全件取得またはDELETE完了までpermitを保持
6. 解放確認後にpermitを返す

lease managerのキーはURL全体やguest space pathではなく、URLの **host** とする。同じhostのguest space、複数profile、論理アプリは同じ公式10枠を共有する。

これはプロセス内制御であり、複数CLIプロセスやkSQL以外の製品を含むドメイン全体の空き枠は保証しない。permit待機にはtimeoutを設け、取得できなければAPI呼び出し前に `CursorCapacityError` とする。

## 10. 再試行規則

| API | 自動再試行 | 理由 |
|---|---|---|
| Create Cursor | 禁止 | 応答喪失時、作成済みか不明。再試行で孤児カーソルを増やし得る |
| Get Cursor | 禁止 | カーソル位置を進めるため、応答喪失後の再試行でページ欠落の可能性がある |
| Delete Cursor | 汎用retryは禁止。cleanup専用の短い再確認だけ許可 | 再確認時の既解放応答は実測で確定する |

Get CursorはHTTP GETだが、既存の `RequestGate.runReadOnly()` へ載せない。同時HTTP要求数だけを制御し、retryしない `runCursorStep()` を追加する。

公式の5分timeoutと、クライアント側のnetwork切断による応答喪失は診断を分ける。前者は `CursorCreateTimedOutError` としてqueryの単純化または対象件数の絞り込みを案内し、後者は `CursorCreateOutcomeUnknownError` とする。ただし、公式ページは5分timeout後にサーバー上のカーソルが存在しないことまでは明記していない。いずれもカーソルIDを受信できず削除できないため、資源の存否を断定せず、最大10分枠が残る可能性を診断へ含めてpermitをquarantineする。

## 11. `totalCount` の扱い

`totalCount` はクエリ条件へ一致する総件数であり、`KORDER_CURSOR` が実際に走査する上限ではない。

```sql
-- totalCountが100万でも、10,001件を読み取った時点でDELETEして終了
SELECT * FROM APP100
KORDER BY 金額
LIMIT 10001;
```

したがって、`totalCount > maxRecords` だけを理由に失敗させない。planning時に証明した `OFFSET + LIMIT <= maxRecords` を走査上限とし、必要な窓へ到達後にカーソルを削除する。

`totalCount <= OFFSET` の場合も、APIエラーにせず、カーソルを即時削除して空結果を返す。結果が不要と作成応答だけで確定しているため、最後まで読み進めない。

## 12. 制限事項

### 制限1: KORDER以外ではCursor APIを使用しない

- 影響する面: CLI / MCP / プラグイン
- 現れ方: 通常のFULL_SCANは従来どおり `maxRecords` とキーセットページングを使う
- 理由: Cursor APIだけが提供できる意味論を、単発GETで完結しないKORDER窓へ限定するため
- 回避策: 通常の全件取得は `maxRecords` を引き上げる

### 制限2: 完全なスナップショットではない

- 影響する面: CLI / MCP / プラグイン
- 現れ方: 対象集合と行の位置は作成時点で決まるが、走査中に更新された値はGet時点の値で返り得る。ソートキー自体が更新されると、返却結果が表示値上はKORDER順に見えない場合がある
- 検知: 一般には不可能
- 回避策: 更新のない時間帯に実行する

カーソル作成後にアクセス権が変わると、変更後の設定では絞り込み条件を満たさないはずのレコードが返る場合がある。閲覧権限のないフィールド値は返らない。この挙動は公式Get Cursorの制限事項であり、kSQL側では完全に補正できない。

### 制限3: ドメイン全体の空き枠を保証できない

- 影響する面: 同一ドメインの全利用者
- 現れ方: kSQL内部上限以下でもCreate Cursorが失敗し得る
- 検知: Create Cursor APIエラーとして検知（**実測・R4**: `HTTP 429` + `code: GAIA_TM12`「作成できるカーソルの上限に達しているため…」）。kSQL内部のpermit不足（API前の`CursorCapacityError`）とは診断を区別できる。`429`だが自動再試行は§10のとおり禁止
- 回避策: 並列ジョブを減らし、時間を置いて再実行する

### 制限4: Create応答喪失時は即時削除できない

- 影響する面: CLI / MCP / プラグイン
- 現れ方: 失敗後、最大10分程度カーソル枠が減る可能性がある
- 検知: 結果不明エラーとして検知できるが、作成成否は確定不能
- 回避策: Createを自動再試行しない

### 制限5: Cursorの複数ページ順序は公式明文だけでは確定していない（APP730実機gateは通過）

- 影響する面: CLI / MCP / プラグイン
- 現れ方: `order by` を指定したCursorのページ連結順が、仕様上のKORDER結果順を維持するかは実測前には保証しない
- 理由: 公式は同じCursorで「続き」を取得すると説明し、Create例に `order by` があるが、同値群を含む複数ページの順序保証を明記していないため
- 実測: APP730（618,525件）で10,001件・21ページ、500件境界をまたぐ同値群のASC/DESC・`$id`有無、LIMIT 501、OFFSET 700をraw Cursor APIと照合し7/7完全一致（[証跡](evidence/b33_cli_mcp_smoke.md)）
- 回避策: 公式保証ではないため、決定的順序が必要な利用者には引き続き`$id`の明示的な最終キーを案内する

## 13. EXPLAIN・診断

`KORDER_CURSOR` を独立した計画名として表示する。

```text
order plan: KORDER_CURSOR
fetch API: POST/GET/DELETE records/cursor.json
cursor page size: 500
scan rows: 10001
cursor concurrency: 2 per domain (process-local)
ordering: kintone native
```

内部診断:

- `cursorCreateCalls`
- `cursorGetCalls`
- `cursorDeleteCalls`
- `cursorActiveCurrent` / `cursorActivePeak`
- `cursorCleanupFailures`
- `cursorCreateOutcomeUnknown`
- `cursorQuarantinedCurrent`
- `cursorRecordsScanned`

カーソルIDを通常ログへそのまま出さない。

## 14. テスト計画

### 14.1 planner

- 既存 `LIMIT 0..500 / OFFSET 0..10000` は `KORDER_NATIVE`
- `LIMIT 501 / OFFSET 0 / maxRecords 501` は `KORDER_CURSOR`
- `LIMIT 10001 / OFFSET 0 / maxRecords 10001` は `KORDER_CURSOR`
- `LIMIT 1 / OFFSET 10001 / maxRecords 10002` は `KORDER_CURSOR`
- `OFFSET + LIMIT > maxRecords` はAPI前にplanning error
- `LIMIT`、`OFFSET`、加算結果が安全な整数でなければAPI前にplanning error
- `LIMIT 0` は全条件検査後にAPIなしで空結果
- KORDER allowlist外型、残余WHERE、nested KORDERはCursorへ逃がさず従来どおり拒否
- 複数キーの `KORDER BY` は指定順を保った1個のCursor queryになる

### 14.2 lifecycle

- 10,001件をkintone順のまま取得し、欠落・重複がない
- 500件境界でページを連結しても順序を変えない
- `records=[] / next=true` でも継続する
- 必要窓へ到達したら残件を取得せずDELETEする
- `next=false` 後はDELETEを送らない
- abort、timeout、Get失敗、変換失敗で必ずDELETEする
- close多重呼び出しでDELETEを重複しない
- cleanup失敗が元エラーを隠さない
- 成功結果後のcleanup失敗は結果と目立つwarningを返す
- cleanup結果不明のpermitはTTL＋安全余裕までquarantineする
- Create / Getへ汎用retryを適用しない

### 14.3 concurrency・routing

- 同一ドメインのAdd Cursorが直列になる
- active cursor数が設定上限を超えない
- cleanup完了前にpermitを返さない
- guest space、profile、logical appが同じhostのleaseを共有する
- 論理アプリ、guest space、複数profileで作成時の認証経路を維持する
- 複数CLI / MCP実行時の容量エラーが明示される
- 複文バッチのKORDER文は順次実行され、前文のclose完了前に次文のカーソルを作らない
- JOIN / UNION / CTE / subquery内のKORDERはカーソル作成前に拒否する

### 14.4 実機

- kintone順とCursor取得順が10,001件以上で一致する
- 1,501件以上のfixtureで、500件境界に同値群を置き、`$id` 二次キーあり／なし×ASC／DESCの連結順を照合する
- Create→Delete→同じIDをDeleteし、2回目のstatusとerror codeを記録する
- Create→`next=false`まで取得→Deleteし、自動削除後のstatusとerror codeを記録する
- ページ1取得後に後続ページのソートキーを更新し、位置と返却値を記録する
- 早期DELETE直後に新しいカーソルを作成できる
- CLI / MCP / Chromium / Firefoxで同じ件数・順序・エラー契約になる

Nodeテストだけでブラウザのcleanup保証を代用してはならない。

**Deleteの二重実行と自動削除後Deleteの応答は実測済み（R4・2026-07-18・[実測記録](evidence/b33_cursor_delete_responses.md)）。** 2 経路とも完全に同一の応答であり、別 fixture に分ける必要はない:

```text
明示 Delete 済みへの再 Delete      → HTTP 404  {"code":"GAIA_CN01","id":"…","message":"指定したカーソルは存在しないか、既に有効期限が切れています。"}
自動削除（next=false）後の Delete → HTTP 404  同一 code・同一 message・同一 body 形状 {code,id,message}
Delete 成功（1回目）              → HTTP 200  {}
```

**「既解放」契約: HTTP statusを観測できるNode面では、`HTTP 404` かつ `code === "GAIA_CN01"` のペアに限り解放済みとして成功扱いにできる。** このペア以外（404 の別 code・GAIA_CN01 の別 status・5xx・ネットワークエラー）は既解放と推定せず quarantine へ送る。pluginの`kintone.api()` rejectはHTTP statusを公開しないため、plugin面に限り`code === "GAIA_CN01"`かつstatus不在も既解放扱いにする。statusが存在する場合はNode面と同じ404とのペアを要求する。なお `GAIA_CN01` は「存在しない」と「期限切れ」を区別しないが、cleanup の目的はサーバー上に資源が無いことの確認であり、不存在の理由の特定ではないため、どちらも解放済み扱いで安全である。HTTP実測はpassword認証・guest spaceなしの1経路で行った。pluginの実reject形状はChromium/Firefox smokeで二重DELETEを行い確認する。

複数ページの順序・同値安定性は、APP730のCLI/MCP実機smoke 7/7完全一致によりB33のrelease blockerを解消した（[証跡](evidence/b33_cli_mcp_smoke.md)）。

## 15. 実装フェーズ

### Phase 0: 契約fixture

- `KORDER_NATIVE` の既存境界を固定
- `KORDER_CURSOR` のfail-first planner / lifecycle test
- `LIMIT 501` からCursorへ切り替わる境界テスト
- Deleteの二重実行と自動削除後Deleteを実測し、既解放応答を確定

### Phase 1: cursor client

- Node / pluginへ `KintoneCursorHandle` を実装
- retryなしのcursor request gate
- profile / guest space routing固定
- `openCursor` を必須メソッドとして全client / wrapper / mockへ追加

### Phase 2: lease・cleanup

- ドメイン単位active semaphore
- host単位Add Cursor mutex
- 独立cleanup timeout
- quarantine lease、warning、エラー合成・診断

### Phase 3: KORDER planner / executor

- `KORDER_CURSOR` 計画
- WHERE＋KORDERキーをCursor queryへ変換
- OFFSET読み飛ばし＋LIMIT収集＋早期DELETE
- 通常の `fetchAll` へ接続しない

### Phase 4: surface・文書・smoke

- CLI / MCP / plugin optionとEXPLAIN
- 言語リファレンスのKORDER上限表
- migration guide / CHANGELOG
- CLI / MCP / Chromium / Firefox実機smoke

## 16. 受入条件

1. Cursor APIを呼ぶ計画は `KORDER_CURSOR` だけである
2. 通常の `ORDER BY`、FULL_SCAN、JOIN、DMLは現行取得方式のままである
3. 既存の `KORDER_NATIVE` 単発GET契約を変えない
4. 単発GET条件を満たさず、`scanRows` が安全な整数かつ `scanRows <= maxRecords` のとき `KORDER_CURSOR` を選ぶ
5. `LIMIT 501 / OFFSET 0 / maxRecords 501` は `KORDER_CURSOR` になる
6. Cursor queryのkintone順をローカルで並べ替えない
7. 必要窓へ到達したら必ずカーソルを明示削除する
8. 全件取得以外の全終了経路でDELETEを試行する
9. cleanup結果不明時はTTL＋安全余裕までpermitをquarantineする
10. 同一hostでAdd Cursorを並行実行しない
11. kSQLのactive cursor数は既定2、最大5とする
12. Create / Get Cursorへ既存GET retryを適用しない
13. 空ページでは終了せず `next` に従う
14. DML / nested KORDER / allowlist外型をCursor対応の名目で許可しない
15. CLI / MCP / pluginが同じplanner・executor・cleanup契約を使う
16. Deleteの既解放応答は実測結果で固定する
17. 複数ページの順序・同値安定性を実機で確認してから出荷する
18. 複数KORDERキーは1カーソル、複文バッチは1文1カーソル、nested KORDERは0カーソルで拒否する

## 17. 実装前の決定事項

次は未確定であり、実装前に決める。

- ~~Delete済み／自動削除済みIDへDeleteしたときの実応答~~ → **R4 で実測済み**（`404` + `GAIA_CN01`・2 経路同一・§14.4）
- 公式5分timeout後に有効カーソルが残る可能性の有無 — **未検証のまま（R4 で再現試行済み・再現不能）**: 618,525 件＋複合 4 キー order by の Create でも約 9 秒で成功（[実測記録](evidence/b33_cursor_timeout_capacity_probe.md)）。quarantine 契約を維持し、再開条件＝より大規模な環境での再試行または公式回答
- `KORDER_CURSOR` をB9と同じv3.1.0へ含めるか、別minorへ分けるか
- cursor permit待機時間
- cleanup timeout、DELETE再確認回数、quarantineの安全余裕
- 公開設定でactive cursor数を変更可能にするか
- プラグインのページ離脱時best-effort cleanup
