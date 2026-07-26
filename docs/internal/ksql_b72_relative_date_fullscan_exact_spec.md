# B72 Phase1 — 相対日付の whole-WHERE exact ＋ local-processing 許可仕様

- 作成日: 2026-07-26
- ステータス: **仕様 R1（codex 起草）→ Claude レビュー済＝実装着手可能**（2026-07-26）。Claude が実コードで裏取り＝①第1許可形の `(orderBy.length === 0 || orderMode === "KINTONE_NATIVE")` 条件とコメント「Canonical ORDER BY may switch to a local complete-input plan」を確認し、**第3許可形に canonical ORDER BY を含める必要がある**という設計判断が正しいことを確認（`relativeDatePushdownGuard.ts:393-399`）②**`executeSimpleSelect` に `applyFilter`/`evalWhere` は無く** `baseQuery = whereToKintone(stmt.where)` を server へ送るだけ＝canonical ORDER BY ケースは **guard 許可だけで成立**（runtime 配線不要・実装が単純化）③`allowOriginalWherePushdown` の渡し（`execute.ts:2452`）と B71 plan の配線も記述どおり。**残オーナー判断なし**。次＝§10 の Step 1 から実装。
- 対象リリース: **v3.24.0 候補**
- SemVer: **minor**
- 評価: [B72 評価](ksql_b72_relative_date_fullscan_exact_evaluation.md)
- 前提: [B67 Phase1](ksql_b67_rest_query_functions_phase1_spec.md)（v3.20.0）／[B67 Phase2 A](ksql_b67_phase2_superset_prefilter_spec.md)（v3.21.0）／[B71 Phase1](ksql_b71_groupby_alias_phase1_spec.md)（v3.23.0）
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B72

## 1. 目的

B72 Phase1 は、相対日付を含む `WHERE` **全体**が `EXACT_PUSHDOWN` であるにもかかわらず、SELECT が取得後の local processing を必要とするため拒否される設計ギャップを解消する。

対象例:

```sql
SELECT 区分, COUNT(*) AS 件数
FROM APP100
WHERE 日付 = THIS_MONTH()
GROUP BY 区分
```

現行 guard の SELECT 許可形は次の2つだけである。

1. B67 Phase1: 単一物理 APP、`selectMode === "SIMPLE"`、canonical `ORDER BY` なしまたは `KORDER BY`、WHERE 全体 `EXACT_PUSHDOWN`、serialize 確認（`src/core/optimization/relativeDatePushdownGuard.ts:378-399`）。
2. B67 Phase2 A: 全体 capability `SUPERSET_PREFILTER`、decomposition 成功、単一物理 APP の FULL_SCAN、no KORDER / JOIN / subtable / materialized source（同 `:400-417`、同 `:294-307`）。

純 exact WHERE は Phase2 A の分解器で `DEFER_PHASE1` となり（`src/core/optimization/relativeDatePrefilterPlan.ts:114-129`）、残余が空になった場合も Phase1 委譲となる（同 `:185-193`）。一方、Phase1 allow-form は local processing を必要とする SELECT を許可しない。このため、安全性が最も高い「WHERE 全体 server exact、client residual なし」が両 allow-form の間に落ちている。

Phase1 の公開原則は維持する。

- 相対日付の値・期間・比較結果は kintone server が所有する。
- client clock による相対日付評価は追加しない。
- server query に採用した WHERE を client で再評価しない。
- plan を証明できない経路は records / cursor / mutation API 前に fail-closed する。
- `evalWhere` の相対日付 backstop は削除・緩和しない。

## 2. スコープ

### 2.1 第3 allow-form

実行・EXPLAIN が共有する第三 allow-form を **`FULL_SCAN_EXACT`** と呼ぶ。公開 capability 名は新設せず、WHERE capability は既存の `EXACT_PUSHDOWN` のままとする。

次をすべて満たす SELECT node だけを許可する。

```text
SELECT node
+ direct physical APP（appId > 0）
+ no JOIN
+ no subtable
+ no temp / materialized CTE / derived source
+ WITH 由来でない（inline CTE も第3 allow-formでは開かない）
+ DML source SELECT でない
+ no KORDER BY
+ local processing が必要:
     resolveSelectMode(select) === FULL_SCAN
     または canonical ORDER BY が存在
+ WHERE contains relative-date function
+ whole-WHERE capability === EXACT_PUSHDOWN
+ whole WHERE serialization succeeded
+ serialized query contains every relative-date function occurrence/name required by the plan
→ whole WHERE を kintone server へ送る
→ client residual = null
→ relative-date client evaluations = 0
```

`resolveSelectMode()` が `FULL_SCAN` を返す主な単一 APP 要因は plain / grouping sets の `GROUP BY`、`DISTINCT`、window、集計・集計依存列・scalar subquery、押し下げ不能 WHERE、式 `ORDER BY` である（`src/converter/selectToKintone.ts:63-90`）。本 allow-form は WHERE capability を whole-WHERE `EXACT_PUSHDOWN` に限定するため、押し下げ不能 WHERE を理由とする FULL_SCAN は自然に対象外となる。

通常 `ORDER BY` は実装上の注意点である。直接 field の canonical `ORDER BY` は `resolveSelectMode()` が `SIMPLE` を返し得る一方、order planner が `CANONICAL_LOCAL` を選び `executeSimpleSelect()` 内で全候補を取得・local sort する（`src/core/optimization/canonicalOrderPlanner.ts:97-127`、`src/execute.ts:2867-2937,2941-2956`）。したがって第三 allow-form の形状判定は `selectMode === "FULL_SCAN"` だけにせず、**canonical `ORDER BY` の存在も含める**。これは問題表の `WHERE 日付 = THIS_MONTH() ORDER BY 日付` を確実に対象化するための必須条件である。

### 2.2 許可する代表形

- `GROUP BY`、`DISTINCT`、通常集計、統計集計、window による local processing。
- canonical `ORDER BY`。`CANONICAL_REST_TOP_N` / `CANONICAL_LOCAL` のどちらでも、WHERE 全体が server query に入り相対日付を client 評価しないことを条件とする。
- 上記の組合せ。
- whole-WHERE が exact なら、相対日付を含む `OR`。AND-only decomposition は要求しない。
- `UNION` の各 branch。各 branch が独立した direct physical APP SELECT node として全条件を満たす場合だけ branch 単位で許可する。現行 walker も UNION の左右を個別 node として収集する（`src/core/optimization/relativeDatePushdownGuard.ts:162-171`）。
- 通常 SELECT 内の scalar subquery body。外側・内側を別 SELECT node として検査し、各 node が自身の条件を満たす場合だけ許可する。現行 walker は nested SELECT を独立収集する（同 `:112-159`）。

例:

```sql
-- plain GROUP BY
SELECT 区分, COUNT(*) AS 件数
FROM APP100
WHERE 日付 = THIS_MONTH()
GROUP BY 区分

-- B71 safe alias grouping
SELECT DATE_FORMAT(日付, '%Y-%m') AS 年月, COUNT(*) AS 件数
FROM APP100
WHERE 日付 = THIS_MONTH()
GROUP BY 年月

-- DISTINCT
SELECT DISTINCT 区分
FROM APP100
WHERE 日付 = THIS_MONTH()

-- canonical local order
SELECT 日付, 区分
FROM APP100
WHERE 日付 = THIS_MONTH()
ORDER BY 日付

-- whole-WHERE exact OR
SELECT 区分, COUNT(*) AS 件数
FROM APP100
WHERE 日付 = THIS_MONTH() OR 日付 = LAST_MONTH()
GROUP BY 区分
```

### 2.3 既存2 allow-form は狭めず、広げない

第三 allow-form は既存2形の後方互換な追加であり、既存判定を書き換えて一つの緩い条件へ統合しない。

| allow-form | capability | server predicate | client residual | B72 の変更 |
|---|---|---|---|---|
| B67 Phase1 SIMPLE / 既存 exact DML | `EXACT_PUSHDOWN` | whole WHERE | なし | 変更なし |
| B67 Phase2 A | `SUPERSET_PREFILTER` | exact relative leaf ＋ safe leaf | 非相対日付 residual | 変更なし |
| B72 `FULL_SCAN_EXACT` | `EXACT_PUSHDOWN` | whole WHERE | `null` | 新規 |

B72 を理由に次を変更してはならない。

- Phase1 SIMPLE / KORDER / exact UPDATE・DELETE の既存受理条件。
- Phase2 A の AND-only leaf decomposition、OR / NOT 拒否、`SUPERSET_PREFILTER` capability、non-null residual。
- `whereCapability` の型・演算子・相対日付関数 allowlist。
- relative date serializer、client evaluator backstop、LIKE / KLIKE の identity 契約。

## 3. guard と plan 判定

### 3.1 `buildRelativeDatePushdownPlan()`

第三 allow-form の可否は `buildRelativeDatePushdownPlan()` の SELECT 分岐でのみ決める。現行は SELECT node ごとに physical shape、mode、capability、whole-WHERE serialization を先に計算し（`src/core/optimization/relativeDatePushdownGuard.ts:378-391`）、Phase1 allow-form、Phase2 A allow-formの順で判定する（同 `:392-417`）。B72 はこの順序を次に固定する。

1. **既存 Phase1 allow-form** を現行どおり評価する。
2. 未許可なら **既存 Phase2 A allow-form** を現行どおり評価する。
3. なお未許可で、`capability === "EXACT_PUSHDOWN"` なら **B72 `FULL_SCAN_EXACT`** の全 gate を評価する。
4. 3形のいずれにも当てはまらなければ、従来どおり `WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN` で拒否する。

Phase2 A より後に置くのは capability が排他的であるため意味論上は同値だが、既存2形を byte / plan 表示ごと維持し、B72 が Phase2 plan の分解・reason を変えないことを明確にするためである。

第三 allow-form の helper は pure な共有関数とし、概ね次の契約を持つ。

```ts
buildRelativeDateFullScanExactPlan(
  select,
  capability,
  context,
  serializedWholeWhere
): RelativeDatePrefilterPlan | null
```

必須検査:

- `select.where !== null`。
- `select.from.appId > 0`、`select.from.cteName === null`、`!select.from.subtableCode`、`select.joins.length === 0`。
- `context.allowFullScanExact === true`。DML source、WITH、temp / materialized / derived context は false。
- `select.orderMode !== "KINTONE_NATIVE"`。
- local-processing 条件（§2.1）。
- `capability.capability === "EXACT_PUSHDOWN"`。
- `whereToKintone(select.where)` 成功。
- `serializationContainsFunctions()` により必要な相対日付関数名が query に実在する。現行 helper は各関数名の `NAME(` を確認する（`src/core/optimization/relativeDatePushdownGuard.ts:290-292`）。
- 同名関数が複数 occurrence ある場合も欠落を見逃さないよう、Phase2 A が合成queryに使う occurrence multiset 検査と同等の確認を行う（`src/core/optimization/relativeDatePrefilterPlan.ts:171-182`）。名前集合だけの検査で完了としてはならない。

関数名の集合だけでなく、whole WHERE から生成した query 自体を plan に保持する AST と一致させる。AST を clone / reparse / 部分分解してはならない。

`RelativeDatePlanNode` には EXPLAIN と enforcement が第三形を識別できる `allowForm: "FULL_SCAN_EXACT"` 相当の marker を持たせる。runtime transportの `RelativeDatePrefilterPlan` に新kindは追加しないが、guard nodeを `selectMode` やnullable residualから後付け推測してはならない。既存Phase1 / Phase2 nodeのfieldと表示は不変とする。

### 3.2 context gate

現行 `WalkCandidate.allowPhase2Prefilter` は DML source SELECT 等で false にされる（`src/core/optimization/relativeDatePushdownGuard.ts:70-77,266-285`）。B72 はこれを暗黙流用して意味を混ぜず、`allowFullScanExact` 相当の明示 context bit を持つ。

- 通常のトップレベル SELECT、UNION branch、通常 SELECT 内 scalar subquery: true。
- DML source SELECT: false。
- `CREATE TEMP TABLE AS SELECT`: false。
- materialized / non-inlined CTE とその consumer: false。
- inline CTE: B72 Phase1 では false。
- `VALIDATE` / REORDER / subtable DML 等、既存 `FORBIDDEN`: false。

これにより「SELECT node だから許可」という一般化で mutation / materialization 境界を開かない。Phase2 A の `allowPhase2Prefilter` 自体は変更しない。

### 3.3 `assertRelativeDatePushdownPlan()`

`assertRelativeDatePushdownPlan()` は新しい形を再推論しない。全 gate は builder で確定し、assert は従来どおり `plan.allowed === false` の rejection を実行前エラーへ変換する enforcement point とする（`src/core/optimization/relativeDatePushdownGuard.ts:481-490`）。

ただし builder が返す allowed node の internal invariant は plan 作成時に次を assert する。

- `FULL_SCAN_EXACT` node は `kind === "SELECT"`。
- `capability.capability === "EXACT_PUSHDOWN"`。
- whole-WHERE plan の `prefilterWhere !== null`。
- `residualWhere === null`。
- serialized query に全相対日付関数が存在。
- `clientWhereEvaluation === false`。

invariant failure を一般 rejection として握り潰したり、元 WHERE の client 評価へ fallback したりしない。internal error または通常の B67 rejection に倒し、records API は0回とする。

## 4. 実行配線

### 4.1 Phase2 A plan shape の流用

B72 は Phase2 A の `RelativeDatePrefilterPlan` と `FullScanInput.residualWhere` を流用する。新しい runtime plan kind は作らず、既存 `capability` と `residualWhere` の組で2形を区別する。

```text
Phase2 A:
  capability      = SUPERSET_PREFILTER
  prefilterWhere  = relative exact leaves + safe leaves
  residualWhere   = non-relative WhereExpr（non-null）

B72:
  capability      = EXACT_PUSHDOWN
  prefilterWhere  = stmt.where（whole WHERE、同一 AST）
  residualWhere   = null
  appliedKlikes   = empty または既存 plan と整合する集合
```

現行 plan は `prefilterWhere`、nullable `residualWhere`、exact leaves、function names、`appliedKlikes`、capability、reasons を一つの object に保持する（`src/core/optimization/relativeDatePrefilterPlan.ts:25-35`）。`FullScanInput.residualWhere` は `undefined = stmt.where`、`null = filter なし`、`WhereExpr = その残余だけ` を既に区別する（`src/engine/process.ts:1527-1530`）。consumer もこの三値をそのまま使う（同 `:1657-1661`）。

B72 の exact plan builder は Phase2 A の `decomposeRelativeDatePrefilter()` を呼ばない。理由は次のとおり。

- pure exact は同 helper が意図的に `DEFER_PHASE1` を返す（`src/core/optimization/relativeDatePrefilterPlan.ts:125-129`）。
- OR 内の相対日付は Phase2 A の AND-spine 規則では拒否されるが、whole-WHERE exact なら分解自体が不要である（同 `:117-123,218-225`）。
- B72 は leaf 除去・safe leaf 合成を行わず、元 WHERE 全体を一つの exact predicate として採用する。

ただし serialize 確認、relative occurrence 収集、plan field、EXPLAIN / execution 共有という Phase2 A の infrastructure は再利用する。

### 4.2 `executeSelect()` での runtime plan 作成

現行 `executeSelect()` は schema-aware WHERE capability を解決し、`SUPERSET_PREFILTER` の場合だけ Phase2 decomposition を作る（`src/execute.ts:2400-2415`）。B72 は同じ場所で、共有 pure helper により exact local-processing plan を作る。

順序:

1. B71 plain GROUP BY plan を現行どおり先に作る（`src/execute.ts:2394-2399`）。
2. WHERE capability を解決する（同 `:2400-2404`）。
3. Phase2 A plan、またはB72 exact planのどちらか一つだけを `prefilterPlan` に設定する。
4. order plan、field validation、complete-input policy を現行どおり作る（同 `:2416-2440`）。
5. static `mode === "FULL_SCAN"` の場合は `executeFullScanSelect()` へ plan を渡す（同 `:2442-2456`）。

EXPLAIN 側と runtime 側で別条件を再実装しない。`buildRelativeDatePushdownPlan()` と `executeSelect()` は同じ `buildRelativeDateFullScanExactPlan()` を使う。statement-level plan object を nested execution 全体へ新たに thread することは Phase1 の必須条件にしないが、helper の入力と出力は同一でなければならない。

### 4.3 `allowOriginalWherePushdown` の排他

現行 `executeSelect()` は `executeFullScanSelect()` へ

```ts
allowOriginalWherePushdown =
  whereCapability.capability === "EXACT_PUSHDOWN"
```

を渡す（`src/execute.ts:2446-2455`）。一方、`executeFullScanSelect()` は `prefilterPlan && allowOriginalWherePushdown` を internal error とする（同 `:3801-3809`）。

B72 exact plan は capability が `EXACT_PUSHDOWN` なので、現行のまま plan を渡すと必ずこの internal error になる。B72 では呼出し側を次に固定する。

```ts
const allowOriginalWherePushdown =
  whereCapability.capability === "EXACT_PUSHDOWN"
  && prefilterPlan === undefined;
```

B72 plan がある場合:

- `allowOriginalWherePushdown = false`。
- `mainFetchCondition = prefilterPlan.prefilterWhere = stmt.where`。
- fetch helper の `baseQuery` は空、`pushQuery` だけが whole WHERE を serialize する。
- `runFullScan()` には `residualWhere = null` を渡す。

現行 fetch helper は `allowOriginalWherePushdown` が true のときだけ `selectToFetchAllParams()` の元 WHERE query を作り、別途 `pushDownCond` も query 化して両方あれば AND する（`src/execute.ts:4317-4329`）。したがって上記排他により whole WHERE は**一度だけ**生成され、二重 query や `WHERE AND WHERE` を作らない。

`executeFullScanSelect()` は既に plan の `prefilterWhere` を main fetch condition にし、plan の `residualWhere` を `runFullScan()` へ渡す（`src/execute.ts:3806-3809,3914-3931`）。この配線自体は変更しない。

### 4.4 canonical `ORDER BY`

static mode が `SIMPLE` の canonical `ORDER BY` は `executeFullScanSelect()` へ入らないため、B72 prefilter plan を runtime 引数として渡す必要はない。

`executeSimpleSelect()` は次のどちらでも whole WHERE を server query に使う。

- REST window: `selectToKintoneParams()` の query を直接 GET（`src/execute.ts:2867-2873,2915-2921`）。
- `CANONICAL_LOCAL`: `baseQuery = whereToKintone(stmt.where)` を `fetchAll()` へ渡し、その後は ORDER / LIMIT / projection だけを行う（同 `:2922-2959`）。

この経路には `applyFilter(stmt.where)` がないため、guard が第三 allow-form として許可すれば相対日付 client 評価は0のまま成立する。B72 のために canonical order planner、比較意味論、REST top-N allowlist、tie-break、LIMIT / OFFSET を変更しない。

## 5. must-stay-rejected と非拡張境界

| 経路 | B72 Phase1 | 根拠・理由 |
|---|---|---|
| `KORDER BY` native / cursor | **第三 allow-formでは拒否維持** | `orderMode === "KINTONE_NATIVE"` を明示除外する。KORDER planner は `staticMode === SIMPLE` と exact WHERE を前提に native / cursor を決める（`src/core/optimization/korderPlanner.ts:30-45,84-107`）。B72 local-processing planを混ぜない。既存 Phase1 の SIMPLE exact KORDER は不変。 |
| UPDATE / DELETE target selection | **B72による拡張なし** | guard はトップレベル exact UPDATE / DELETE と、UPDATE FROM / APPLY / subtable 等を既に別分類する（`src/core/optimization/relativeDatePushdownGuard.ts:238-263`）。B72 は SELECT node のみ。既存 Phase1 exact DML は不変、FULL_SCAN / residual DML は拒否。 |
| `INSERT` / `UPSERT ... SELECT` source | **第三 allow-formでは拒否維持** | nested source SELECT は walker 上で Phase2 拡張不可 context が渡される（同 `:266-285`）。owner 決定 A を継承し、pure-exact SIMPLE source の既存受理可否は変えず、local-processing sourceをB72で新規に開かない。mutation前にsource全体を実体化する経路へ能力拡張を持ち込まない。 |
| JOIN | **拒否維持** | 複数 source の WHERE を一つの APP query として exact 証明できず、join後 truth / outer join null-extension が別課題。現行 physical gate も joins 0 を要求する（同 `:380-383`）。 |
| `VALIDATE` | **拒否維持** | walker が明示 `FORBIDDEN` にする（同 `:221-236`）。既存監査は取得後 WHERE 評価を持つため、server-only相対日付を開かない。 |
| subtable | **拒否維持** | virtual row は親 records 取得後に展開される（`src/execute.ts:4334-4343`）。一意なトップレベル physical field predicate として whole WHERE を押し下げる契約外。 |
| temp table / materialized CTE / derived source | **拒否維持** | kintone server が相対日付 predicate を評価する一意な物理 source ではない。現行 WITH walker も非inline CTEを forbidden にする（`src/core/optimization/relativeDatePushdownGuard.ts:173-195`）。 |
| inline CTE | **B72 Phase1では第三 allow-form対象外** | 現行 SIMPLE/Phase2の既存挙動は変えないが、B72 local-processingの新規許可はdirect SELECTに限定する。CTE provenance と plan identity の追加検証を本件へ含めない。 |
| 相対日付を含む non-exact OR / NOT | **拒否維持** | whole-WHERE capability が exact でないため第三 allow-form不成立。Phase2 A の AND-only規則も変更しない。 |

「拒否維持」は B72 の第三 allow-formで新規に開かないという意味である。特に既存 B67 Phase1 が許可済みの SIMPLE exact KORDER、トップレベル exact UPDATE / DELETE、pure-exact SIMPLE DML sourceまで狭めてはならない。

## 6. B71 plain GROUP BY との合成

B71 v3.23.0 は plain GROUP BY 名を source schema で `PHYSICAL` / `ALIAS_SAFE` / rejectへ解決する immutable plan を持つ（`src/core/optimization/plainGroupByPlan.ts:11-29,232-247`）。runtime は WHERE capability より前にこの plan を作り（`src/execute.ts:2394-2401`）、同じ planを fetched fields と `runFullScan()` の group evaluationへ渡す（同 `:2446-2456,3927-3931`）。

B72 はこの順序・plan・取得列を変更しない。

### 6.1 alias grouping

```sql
SELECT DATE_FORMAT(日付, '%Y-%m') AS 年月, COUNT(*) AS 件数
FROM APP100
WHERE 日付 = THIS_MONTH()
GROUP BY 年月
```

- B71 は source に `年月` 物理列がなければ `DATE_FORMAT(日付, ...) AS 年月` を `ALIAS_SAFE` とし、alias式の依存列 `日付` を fetchする。
- B72 は同じ request の query 条件を `日付 = THIS_MONTH()` にするだけで、B71 plan の source identity、column index、runtime key、依存列 walkerを変更しない。
- serverから返る候補は既にwhole WHEREを満たすため、`residualWhere = null` の後にB71のgroup stageが実行される。現行 pipeline も filter の後に GROUP BY を行う（`src/engine/process.ts:1657-1689`）。

### 6.2 physical grouping

```sql
SELECT 金額 AS 区分, COUNT(*) AS 件数
FROM APP100
WHERE 日付 = THIS_MONTH()
GROUP BY 区分
```

source schema に実列 `区分` がある場合、B71 は SELECT alias より `PHYSICAL` を優先し、必要列を強制 fetchする。B72 は `selectToFetchAllFields(stmt, table, plainGroupByPlan)` の入力を変えず（`src/execute.ts:4300-4313`）、query predicateの追加・残余抑止だけを行う。したがってB72が fetched fieldsを減らしたり、相対日付fieldだけに置換したりしてはならない。

### 6.3 相互非回帰

- B72 は B71 の `PHYSICAL` / `ALIAS_SAFE` / rejection / ambiguityを再分類しない。
- B71 は B72 の whole-WHERE capability、serialize、server-only契約を再分類しない。
- B71 rejection は records API前、B72 rejectionもrecords API前。どちらのエラーを先に出すかを公開契約にはしないが、どちらかをcatchしてもう一方のunsafe fallbackへ進めてはならない。
- B65 grouping sets、HAVING、ORDER BY、DISTINCT、projectionの既存stage順を変更しない。

## 7. complete-input、`maxRecords`、検索打切り

### 7.1 complete-input / `maxRecords`

B72 は候補集合の取得前 predicateだけを変え、完全入力が必要な後段演算の契約を変えない。

現行は local ORDER、window ORDER、統計集計、grouping setsをcomplete-input reasonとして列挙する一方、plain GROUP BY、通常集計、DISTINCTは列挙していない（`src/core/dmlGuard.ts:63-69,141-155`）。complete-input reasonがあると `onLimitReached="truncate"` を `"error"` へ強制し（`src/execute.ts:2728-2747`）、上限到達時は部分結果でなく説明付き `FetchAllLimitError` を返す（同 `:2750-2758`）。

B72で新規に許可するlocal-processing形は、いずれもwhole-WHEREに一致した**完全な候補集合**がなければ正しい集計・重複排除・window・順序結果を保証できない。以前は実行前拒否だったため、B72 allow-formに限り `RELATIVE_DATE_FULL_SCAN_EXACT` 相当のcomplete-input reasonを追加し、次へ固定する。

- `FULL_SCAN_EXACT` は plain GROUP BY、DISTINCT、通常/統計集計、window、式ORDERを含め、常に `onLimitReached="error"`。
- canonical `ORDER BY` のうち `CANONICAL_LOCAL` は同じくcomplete-input。`CANONICAL_REST_TOP_N` はserverが最終windowを返す既存計画なので新reasonを追加しない。
- `maxRecords` は**server predicate適用後の候補取得件数**に対して適用する。
- B72 complete-input queryで `onLimitReached="truncate"` を指定しても部分結果を返さない。
- 相対日付を含まない既存queryやB72以外のSELECTに、この新reasonを逆適用しない。

### 7.2 `SearchAbortedError`

現行 wrapper は `searchAborted` を収集し、fail-closed contextでは `SearchAbortedError` をthrowする（`src/execute.ts:850-865`）。通常read-only SELECTはwarning付与である（同 `:709-737`）が、この既存契約をB72のlocal集計へそのまま適用すると部分集計を成功結果として返し得る。

B72では第三 allow-formのうち完全候補をlocal処理する計画をsearch-abort fail-closed contextとして扱い、`searchAborted: true` は **`SearchAbortedError`** とする。実装はstatement種別だけで決める現行wrapperの一般条件を全SELECTへ広げず、B72 shared plan / effective order planで対象を限定する。

- `FULL_SCAN_EXACT` と `CANONICAL_LOCAL` はwarning付き部分結果を返さない。
- `CANONICAL_REST_TOP_N` は既存server-window契約を維持する。
- 外側のDML / temp materializationが `SearchAbortedError` を要求する既存contextでは、B72 predicateを理由にwarningへ緩和しない。
- `SearchAbortedError`、`FetchAllLimitError`、REST error発生後に空query・client相対日付評価・部分集計へretryしない。
- DML source / temp / CTEを第三 allow-formから除外することで、不完全なsourceを新たにmutation/materializationへ渡さない。
- error時は結果objectを成功として返さず、mutation / confirm 0の既存fail-closedを維持する。

## 8. EXPLAIN

EXPLAIN は実行と同じ shared helper から第三 allow-formを表示し、records / cursor / mutation APIを呼ばない。

例:

```text
mode: FULL_SCAN
relative date function: THIS_MONTH
relative date evaluation: kintone server whole-WHERE exact
field: 日付 (DATE)
operator: =
where capability: EXACT_PUSHDOWN
server predicate: 日付 = THIS_MONTH()
client residual: (none)
relative date client evaluations: 0
kintone query: 日付 = THIS_MONTH()
```

複数相対日付関数を含むexact OR:

```text
relative date function: THIS_MONTH
relative date function: LAST_MONTH
where capability: EXACT_PUSHDOWN
server predicate: 日付 = THIS_MONTH() or 日付 = LAST_MONTH()
client residual: (none)
relative date client evaluations: 0
kintone query: 日付 = THIS_MONTH() or 日付 = LAST_MONTH()
```

現行 EXPLAIN は Phase2 A planについて、non-null residualがある場合だけ server prefilter / client residual / evaluation 0を表示する（`src/execute.ts:8880-8912`）。それ以外のexact形は generic Phase1表示へ落ち、`client evaluation: forbidden` を出す（同 `:8914-8926`）。B72では `FULL_SCAN_EXACT` nodeだけ上記専用表示を追加する。

表示の非回帰:

- B67 Phase1 SIMPLE exact: 現行 `evaluation: kintone server` / `client evaluation: forbidden` 表示を変更しない。
- B67 Phase2 A: 現行 `where capability: SUPERSET_PREFILTER` / `server prefilter` / non-null `client residual` 表示を変更しない。
- B72: capabilityを `SUPERSET_PREFILTER` と偽装せず `EXACT_PUSHDOWN` と表示する。
- rejection: 実行可能なqueryを表示せず、関数名・path・既存 reason codeを表示する。
- runtime first records queryからpaging suffixを除いたbase predicateと、EXPLAINの `kintone query` を一致させる。

canonical `ORDER BY` が `executeSimpleSelect()` 経路でも、第三 allow-formとして同じwhole-WHERE exact / evaluation 0を表示する。`mode` は既存EXPLAINの実効 order plan表示と矛盾させず、`CANONICAL_LOCAL` の場合はlocal complete-inputであることを既存order行に委ねる。

## 9. 受入条件

### 9.1 正例

1. `WHERE 日付 = THIS_MONTH() GROUP BY 区分` が成功し、初回records queryに `日付 = THIS_MONTH()` が1回だけ入る。`residualWhere = null`、相対日付 evaluator 0回、2件以上のgroup fixtureで正しいgroup結果。
2. `SELECT DISTINCT 区分 ... WHERE 日付 = THIS_MONTH()` が成功し、whole WHEREをserverへ押し、client filterを呼ばない。
3. `SELECT COUNT(*) ... WHERE 日付 = THIS_MONTH()` と通常 aggregateが成功する。
4. `STDDEV_POP`等の統計集計が成功可能になり、`maxRecords`到達時はcomplete-input errorで部分値を返さない。
5. `ROW_NUMBER() OVER (ORDER BY ...)` 等window SELECTが成功し、相対日付評価0。window complete-input非回帰も確認する。
6. `WHERE 日付 = THIS_MONTH() ORDER BY 日付` が成功する。`CANONICAL_LOCAL` のbase queryにwhole WHEREが入り、local sort前にclient WHERE評価をしない。
7. REST top-N可能なcanonical `ORDER BY $id LIMIT n` もguardで誤拒否せず、既存REST window計画・query・LIMIT/OFFSETを維持する。
8. `WHERE 日付 = THIS_MONTH() OR 日付 = LAST_MONTH() GROUP BY 区分` を許可する。whole-WHERE capability exact、whole OR query serialize、residual null、相対日付評価0を固定する。
9. `BETWEEN` 展開、複数AND、exact KLIKE等を含むwhole-WHERE exactも、元WHERE全体を一度だけ送る。
10. UNIONの各direct APP branchが条件を満たす場合、branchごとにwhole WHEREを押し、各branchの相対日付評価0。

### 9.2 B71 合成

11. `DATE_FORMAT(日付,'%Y-%m') AS 年月 ... GROUP BY 年月` はB71 `ALIAS_SAFE` planを使い、`日付`をfieldsに要求し、B72 query predicateも同じ `日付` fieldでserver適用する。
12. aliasと同名の実列があるcaseはB71 `PHYSICAL`を維持し、その実列を必ずfieldsに含める。
13. B71 aggregate-dependent alias、duplicate alias、unknown、JOIN ambiguity rejectionをB72が開かない。records API 0。
14. B65 grouping setsはB71/B65既存planを使い、B72はWHERE fetch/residualだけを変える。

### 9.3 必須 mock 契約

15. records mockはrequestの `fields` を尊重し、指定外fieldを返さない。全fieldを常時返すmockだけで合格にしてはならない。既存B71 testもrequested fieldsだけをrecordへ投影する（`src/__tests__/b71GroupByAliasStep2.test.ts:52-66`）。
16. `getFields` mockはAPPごとの実在fieldと型を返す。空schema fallbackでexact capabilityやB71 resolutionを通さない。
17. spyで初回 `getRecords` の `fields` と `query` を同時検証する。B71必要列が欠落せず、B72 whole WHEREが1回だけ存在することを固定する。
18. mockのquery evaluatorが相対日付をローカル再現することを正しさの証明に使わない。server適用済みfixtureを返し、query文字列とclient evaluator 0を別々にassertする。

### 9.4 拒否

19. KORDER＋B72 local-processing shapeはnative / cursorとも第三 allow-formを使わず拒否または既存parser/planner error。cursor create 0。既存SIMPLE exact KORDER positiveは不変。
20. relative exact＋non-exact OR / NOTはwhole-WHERE exactでないためB72拒否。Phase2 AのAND-only適格形だけは従来どおり許可。
21. JOIN、subtable、VALIDATE、temp、materialized CTE、derived source、inline CTE local-processingをrecords API前に拒否する。
22. UPDATE FROM / APPLY / subtable DML / residual DMLはmutation・confirm 0。既存トップレベルexact UPDATE / DELETE positiveは不変。
23. `INSERT` / `UPSERT ... SELECT`のFULL_SCAN exact sourceはB72で開かずmutation・confirm 0。pure-exact SIMPLE sourceの既存testは非回帰。
24. serializer failure、serialized queryから関数欠落、`residualWhere !== null`、capability driftのtest seamはrecords API前にfail-closed。
25. plannerをbypassして相対日付nodeを`evalWhere`へ渡すbackstop testは従来どおりthrowする。

### 9.5 complete-input・EXPLAIN・surface

26. plain GROUP BY / DISTINCT /通常集計 / local ORDER / window /統計集計 / grouping setsのB72形で `maxRecords`超過時に部分結果を返さない。`onLimitReached="truncate"` はB72 complete-input reasonによりerror。
27. B72 `FULL_SCAN_EXACT` / `CANONICAL_LOCAL` の `searchAborted: true` は `SearchAbortedError`、retry 0、成功result 0。B72以外の通常read-only SELECT warning契約は変えない。
28. EXPLAINはB72専用のwhole-WHERE exact、residual none、client evaluations 0、kintone queryを表示する。
29. Phase1 SIMPLE exactとPhase2 A SUPERSET_PREFILTERのEXPLAIN snapshotをbyte非回帰する。
30. Node / CLI / MCP / Firefox plugin / Chrome pluginで同一SQLのquery、結果、EXPLAIN、reasonを一致させる。browser clock / timezoneを参照しない。

### 9.6 一般非回帰

31. `TODAY()` / `NOW()` / `LOGINUSER()`、相対日付12関数のparser / AST / serializer、型×演算子allowlistを変更しない。
32. 相対日付を含まないSIMPLE / FULL_SCAN、LIKE、KLIKE、safe-leaf prefilter、canonical ORDER、KORDERの既存testを回帰する。
33. Phase2 AのAND-only residual surgery、AST identity、`appliedKlikes`、residual内相対日付0件testを回帰する。
34. B71 fetched-fields、plain GROUP BY alias、PHYSICAL shadow、nested path、B65非回帰testを回帰する。
35. 全Jest、build、CLI subprocess、MCP smoke、両browser smoke、docs embedding / resource guardをgreenにする。

## 10. 実装 Step（各 Step 単独 mergeで安全）

総見積は評価どおり **2〜4人日**。各Stepは単独merge時にwrong resultやKORDER / DML拡張を生まない。

| Step | 変更 | 単独merge時の公開挙動 | 見積 |
|---|---|---|---:|
| 1. pure exact plan foundation | `buildRelativeDateFullScanExactPlan()`、context bit、plan invariant、unit testを追加。guard / runtime未配線 | **完全不変**。pure helper未使用 | 0.5〜0.75人日 |
| 2. guard allow ＋ safe runtime同時配線 | 第三 allow-formをguardへ追加。同じmergeで`executeSelect()` plan作成、`allowOriginalWherePushdown = exact && !prefilterPlan`、whole-WHERE push、`residualWhere=null`、B72 complete-input reason、plan-aware SearchAborted fail-closedを配線。GROUP/DISTINCT/aggregate/window/canonical ORDER positive、上限・検索打切り、全must-reject testを追加 | 対象queryだけ正しく成功。guardだけ先行してclient backstopへ漏れる状態や、部分集計を返す中間状態を作らない。KORDER/DML/CTE/JOINは閉じたまま | 1.0〜1.5人日 |
| 3. EXPLAIN / B71 acceptance | B72専用EXPLAIN、OR exact、B71 alias/PHYSICAL合成、fields-respecting mockを追加。Phase1/Phase2 snapshot非回帰 | 実行・fail-closed意味論はStep 2と同じ。診断と機能間合成の証拠を完成 | 0.5〜0.75人日 |
| 4. docs / 4面 / release gate | language reference §5/§6/quick reference、CHANGELOG、issue tracker、CLI/MCP/plugin/browser smoke、docs guardsを更新 | 意味論はStep 2と同じ。公開契約とrelease gateを同期 | 0.5〜1.0人日 |

Step 2 は guard緩和とruntime residual抑止を**同一merge**にする。guardだけを先に開くStep、`residualWhere=null`だけを先に入れて一般exact FULL_SCANのclient filterを無条件に消すStepは禁止する。

## 11. ドキュメント同期

### 11.1 必須

`docs/ksql_language_reference.md` はB74により現行実装の「使える形は2つ」「whole-WHERE exactでもFULL_SCANならfail-closed」を正確に記述している。

- §5 相対日付関数: `docs/ksql_language_reference.md:642-680`
- §6 WHERE内の要約: 同 `:694-719`
- quick reference内の相対日付要約: 同 `:985-987`

B72 releaseでは次へ更新する。

- 使える形を3つにする。
- 第3形としてdirect physical APPのwhole-WHERE exact＋local processingを追加。
- GROUP BY / DISTINCT / aggregate / window / canonical ORDERをfail-closed一覧から削除し、許可条件へ移す。
- whole-WHERE exact ORはFULL_SCANでも可と明記する。
- KORDER、DML拡張、DML source FULL_SCAN、JOIN、VALIDATE、subtable、temp / CTE / derived、non-exact OR / NOTは引き続きfail-closedと明記する。
- `residualWhere=null`、相対日付client評価0、complete-input / maxRecordsは既存契約維持と記す。

B74の訂正文言を単純に巻き戻してはならない。B74が明確化した「OR自体は拒否理由でない」「fail-closedはplan形状で決まる」という説明を残し、B72後の3 allow-formへ更新する。

### 11.2 release同期

- `CHANGELOG.md`: additiveな新規許可、代表SQL、対象外、server-only / evaluation 0、B71合成、SemVer minor。
- `docs/ksql_issue_tracker.md`: B72を実装・release状態へ更新し、B74行に「B72で再更新済み」を反映。
- MCP `ksql_docs` embedding / resource snapshotとdocs guard。
- 必要ならCLI/plugin helpの相対日付制約文。ただしsurface独自のallowlistを新設しない。

## 12. SemVer

**minor** とする。

- 既存で成功していたqueryの結果、AST、query byte、reasonを変更しない。
- 従来 `WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN` で拒否していたdirect physical APPのwhole-WHERE exact＋local-processing SELECTだけが成功する。
- client相対日付評価、DML能力、JOIN能力、KORDER能力を追加しない。

純加法のfeature enablementでありpatchではない。対象version候補は現行 `package.json` のv3.23.0に続く **v3.24.0** とする（`package.json:3`、`CHANGELOG.md:5-7`）。

## 13. 判断論点の決着表

| # | 論点 | Phase1決着 |
|---:|---|---|
| 1 | 第3 allow-form | direct physical APP SELECT、whole-WHERE `EXACT_PUSHDOWN`、serialize確認、no KORDER/JOIN/subtable/CTE/temp/derived/DML source、local processingあり。whole WHERE server、residual null、client評価0。 |
| 2 | plan形 | Phase2 Aの `RelativeDatePrefilterPlan` / `FullScanInput.residualWhere` を流用。新kindは作らず `capability=EXACT_PUSHDOWN`＋`residualWhere=null`で区別。pure helperはPhase2 decompositionと分離。 |
| 3 | original WHERE pushdown | B72 plan時は `allowOriginalWherePushdown=false`、planの`prefilterWhere=stmt.where`だけを明示push。二重生成禁止。 |
| 4 | canonical ORDER | static SIMPLEでも第三 allow-formに含める。`executeSimpleSelect()`のwhole-WHERE server queryを使い、client WHERE評価なし。 |
| 5 | OR | whole-WHERE exactなら含める。AND-only decomposition不要。non-exact OR / NOTは拒否維持。 |
| 6 | B71 | plain GROUP BY plan・fields・evaluationを不変維持。B72はquery predicateとresidualだけを変更。fields-respecting mock必須。 |
| 7 | complete input | B72 local-processing用reasonを追加し、plain GROUP BY / DISTINCT /通常集計を含めmaxRecords・truncate・search abortで部分結果を返さない。B72以外の既存SELECT契約は不変。 |
| 8 | EXPLAIN | `EXACT_PUSHDOWN`、whole server predicate、residual none、client evaluations 0、queryを表示。Phase1/Phase2表示不変。 |
| 9 | SemVer | minor、v3.24.0候補。 |

## 14. 残るオーナー判断

公開意味論上のblockerはない。本仕様は評価§3の第三 allow-formを、安全側に次の2点まで具体化した。

1. 通常 `ORDER BY` はstatic `SIMPLE`でもlocal complete-inputになり得るため、`resolveSelectMode() === FULL_SCAN`だけでなくcanonical `ORDER BY`も第三 allow-formに含める。
2. Phase2 Aのtransport shapeは流用するが、pure exact用builderはAND-only decompositionから分離し、ORを含むwhole-WHERE exactも扱う。

残るオーナー判断はない。inline CTEのlocal-processing exact形は **Phase1対象外** と決着する。direct physical APPだけでB72の主要ユースケースを満たし、CTE context/provenanceを開かず2〜4人日の見積内に収める。将来含める場合は、inlined ASTとEXPLAIN/runtime plan identity、DML sourceとのcontext分離を別仕様・別受入として扱う。
