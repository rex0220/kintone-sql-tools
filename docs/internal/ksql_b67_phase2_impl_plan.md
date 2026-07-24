# B67 Phase2 A 実装計画 — SUPERSET_PREFILTER

- 作成日: 2026-07-25
- ステータス: **Step 1〜5 実装完了（2026-07-25・全 4,242＋CLI 26 green・build 全面・実装＝ブランチ `feat/b67-phase2-superset-prefilter`）＝release/実機待ち**。各 Step codex 実装→Claude レビュー→commit（Step1=decomposition 54b43e9／Step2=guard 第2許可形 762a067／Step3=fetch/residual 配線 1138761／Step4=EXPLAIN 33e2bc2／Step5=受入・docs・benchmark＋DML source 拒否）。**owner 決定 A**＝`INSERT/UPSERT…SELECT` の DML source SELECT への Phase2 適用は spec スコープ尊重で fail-closed（`WalkCandidate.allowPhase2Prefilter` を DML nested source だけ false・pure-exact DML source は第1許可形で非回帰）。受入・benchmark は [evidence/b67_phase2_acceptance.md](evidence/b67_phase2_acceptance.md)。残＝言語リファレンス反映済み・**Firefox/Chrome 実機 smoke（ユーザー）→ v3.21.0 リリース**。以下は原計画（codex 起草→Claude 裏取り）。主要 touchpoint を実ソースで確認＝`allowOriginalWherePushdown`（execute.ts:3546/4053・`baseQuery = isMainTable && allowOriginalWherePushdown`）／`FullScanInput`＋`runFullScan`＋`applyFilter(rows, stmt.where…)`（process.ts:1463/1558/1611）／`resolveKintoneFuncValue` backstop（evalWhere.ts:451）／capability の既存 `SUPERSET_PREFILTER`＋`requireExactRelativeDatePushdown`（whereCapability.ts:346-349）／`buildSingleTableKlikePushdownPlan`（klikePushdownPlan.ts:45）／complete-input 別 fetch call site（execute.ts:3958）＝いずれも実在・行番号ズレなし・幻の関数名なし。**次＝ブランチ切って Step 1 着手**。
- 正仕様: [B67 Phase2 A 仕様 R2](ksql_b67_phase2_superset_prefilter_spec.md)
- 前提: [B67 Phase1 仕様 R2](ksql_b67_rest_query_functions_phase1_spec.md)／[B67 Phase1 実装計画](ksql_b67_impl_plan.md)
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B67
- 実装分担: codex はファイル編集と自動検証まで担当する。`git status`／`git diff`を含む git 操作、差分レビュー、branch、commit、push、PR、tag はすべて Claude 側で行う。各 Step の gate を Claude が確認した後、Claude が commit する。

## 1. 結論と段階マージ方針

B67 Phase2 A は、単一の物理 APP を読む単一テーブル SELECT の `FULL_SCAN` に限り、Phase1 exact 相対日付 leaf を kintone server の明示 prefilter として1回だけ評価し、取得後は相対日付 leaf を除去した residual だけを client 評価する。

```text
元 WHERE:          E1 AND ... AND En AND R
server prefilter:  E1 AND ... AND En AND S
client residual:   R
capability:        SUPERSET_PREFILTER
relative date client evaluations: 0
```

- `Ei` は Phase1 の型・位置・引数・6比較 allowlistを満たす `EXACT_PUSHDOWN` 相対日付 leaf。
- `R` は相対日付 occurrence を0個にした client 評価可能な残余。
- `S` は元 WHERE から既存 safe-leaf 抽出で得る候補絞り込み。存在しなければ相対日付 leafだけを prefilterにする。
- prefilterへの採用、serialize確認、residualからの除去、`appliedKlikes`、capability／reasonを、1個の `RelativeDatePrefilterPlan` として不可分に扱う。

実装は次の5 Stepに分ける。

1. **decomposition primitive** — `RelativeDatePrefilterPlan`、`decomposeRelativeDatePrefilter(stmt, formMeta)`、AND-only分解、局所AST surgery、全reject path
2. **capability／guard第2許可形** — `SUPERSET_PREFILTER`の保持と `allowRelativeDatePrefilterPlan(plan)` に限定したPhase1拒否の緩和
3. **FULL_SCAN wiring** — explicit `prefilterWhere`、元WHERE暗黙pushdown無効化、`FullScanInput.residualWhere`、KLIKE identity維持
4. **EXPLAIN／reason／backstop-0 proof** — 実行と同じplanを表示し、相対日付client評価0を直接証明
5. **4面受入／docs／regression／benchmark** — Node／CLI／MCP／Firefox・Chrome pluginの同一性とrelease evidence

この順序にする理由は、Step 1で「何をserverへ送り、何をclientへ残すか」を副作用なしのpure planとして先に固定し、Step 2で許可判定だけを開き、Step 3で初めてrecords取得とclient filterへ接続するためである。Step 1〜2の途中では既存Phase1 guardが実行を拒否し続ける。Step 3で実行能力を開いた後、Step 4でEXPLAINと直接的な評価0証明を揃え、Step 5で全surfaceとrelease gateを閉じる。各Stepは単独レビュー・単独commit可能な最小の安全単位とする。

### 1.1 各 Step の共通 gate

各 Step 末で次を必須とする。

1. `npm test` が全 green。既存の `scripts/run-tests.mjs` 二段runnerをそのまま使用し、通常gateへJest引数を追加しない。
2. `npm run build` が成功する。plugin／CLI／MCP／MCPB／engineの全buildを通す。
3. Step固有testと、影響面に対応する既存smokeが成功する。
4. `src/parser/__tests__/__snapshots__/parser_compat.test.ts.snap` を含む既存snapshotは無変更。Phase2 A固有の期待値は専用test／snapshotへ置く。
5. Phase1 exact相対日付、`TODAY()`／`NOW()`／`LOGINUSER()`、相対日付を含まないB32 capability／reason、LIKE／KLIKE、通常SIMPLE／FULL_SCAN routingが無回帰。
6. 拒否caseはフォームメタデータ以外のrecords GET、Cursor POST／GET／DELETE、mutation、confirmを0回にし、部分結果を返さない。
7. Claudeが対象差分、test／smoke output、既存snapshot無変更、API呼出し0、必要な実機evidenceをレビューし、Claudeがcommitする。codexはgit操作を一切行わない。

### 1.2 全 Step を貫く非変更条件

- 相対日付関数をNode／CLI／MCP／browserの日時、時計、タイムゾーン、週境界、月末計算へ解決しない。
- `src/engine/evalWhere.ts` の相対日付runtime backstopを削除・緩和・skip対象化しない。
- `extractSafePushdownLeaves` の責務・allowlistを広げない。相対日付分解は隣接helperへ置く。
- 元 `SelectStatement` と元 `stmt.where` を破壊的変更しない。
- 残余の非相対日付nodeをclone／reparseせず、object identityと順序を維持する。
- 一般boolean最適化、OR分配、ド・モルガン変換、leaf並べ替えを追加しない。
- KORDER、DML、SELECT-based DML source、JOIN residual、VALIDATE、サブテーブル、temp／materialized CTE、派生sourceを開かない。
- kintoneが相対日付queryをREST errorにした場合、空query、全件FULL_SCAN、client clock評価へretryしない。
- 単一CTEは既存inline後に一意な物理SELECTになる場合だけ対象にできる。`UNION`はbranchごとに独立判定する。

## 2. 着手前チェックリスト

Step 1開始前にClaudeが次を確認する。

1. 正仕様はPhase2 A仕様R2、とくに§3、§5、§5.3、§14であり、Phase1仕様§5／§11.1を前提契約として維持する。
2. 最終識別子をR2どおり固定する。
   - plan: `RelativeDatePrefilterPlan`
   - helper: `decomposeRelativeDatePrefilter(stmt, formMeta)`
   - guard第2許可形: `allowRelativeDatePrefilterPlan(plan)`
   - FULL_SCAN入力: `FullScanInput.residualWhere`
3. `RelativeDatePrefilterPlan` は `prefilterWhere`／`residualWhere`／`exactRelativeLeaves`／`relativeFunctionNames`／`appliedKlikes`／`capability`／`reasons` を必須fieldとして持つ。prefilterとresidualを後段で別々に再解析・再分類しない。
4. `formMeta` は単一物理APPのトップレベルfield semanticsと、既存safe prefilterが必要とするfield type／option metadataを同じsnapshotから供給する。新しいsurface別metadata shapeを作らない。
5. parser／ASTの変更は原則不要とする。Phase1の `WhereExpr`、`KINTONE_FUNC`、`BETWEEN` の `>= AND <=` 展開をそのまま使い、実装中に型不足が確認された場合だけStep 1内の純加法型変更として再レビューする。
6. Step 1〜2 merge時はPhase2実行をまだ開通させず、既存Phase1 guardで取得前拒否を維持する。
7. Step 3で実行を開く前に、prefilter query内の各相対日付関数名を `\bNAME\s*\(` 相当のregexで確認し、residual ASTの相対日付occurrenceが0であるtestをgreenにする。
8. Firefox／Chrome smoke fixtureは仕様§14.3の広い窓を基本とし、最終APP／fieldだけユーザー環境で確定する。browser実機evidenceをNode testで代替しない。
9. 5 Stepのcommit分割、各Step共通gate、Claude review→Claude commit、codex git非実行の分担を維持する。

## 3. 仕様 §1.3 と現行コードの裏取り

2026-07-25の現行sourceを関数名で再検索し、Phase2 A仕様R2 §1.3の行参照を確認した。主要範囲はv3.20.0 merge後の現行コードとも一致している。実装時は行番号だけに依存せず、表中のsymbol名を再検索する。

| 実コード（現行行） | 確認した現行契約 | Phase2 A の変更／不変条件 | 主Step |
|---|---|---|---:|
| `src/core/optimization/wherePredicatePushdown.ts:27-39,63-88` `extractSafePushdownLeaves`／`extractAndLeaves` | AND leafだけを抽出しGROUPを透過、OR／NOT等はsubtreeごと除外 | AND traversalの規則は揃えるが、既存helperの責務・allowlistは変更せず、隣接decompositionを追加 | 1 |
| `src/core/optimization/wherePredicatePushdown.ts:91-135` `isSafeComparison` | KLIKE、`$id`、型確認済みNUMBER、選択系IN等をsafe leaf化。通常LIKEは対象外 | safe leafをprefilterへ合成し、通常LIKEはresidualに残す。既存leaf objectを再利用 | 1, 3 |
| `src/core/optimization/klikePushdownPlan.ts:21-29,43-56,59-103` | conditionと`appliedKlikes`を同じ抽出結果から作り、KLIKE leafをcloneせずidentityで追跡 | `decomposeRelativeDatePrefilter`から同primitiveを利用または同planを入力し、`appliedKlikes`を不可分planへ保持 | 1, 3 |
| `src/core/optimization/whereCapability.ts:5-23,92-180` | 4 capabilityとreason unionを持ち、通常LIKEは`WHERE_RESIDUAL` | mixed WHEREは`SUPERSET_PREFILTER`と全reason detailを保持 | 2 |
| `src/core/optimization/whereCapability.ts:189-258,333-415` | relative leafは型・演算子・引数が適合すればexact。AND全体がnon-exactなら`requireExactRelativeDatePushdown`がPhase1拒否reasonを追加 | 一般分類は緩和しない。成立済みplanをguardが受け取ったときだけ拒否reasonを実行許可へ読み替える | 1, 2 |
| `src/core/optimization/relativeDatePushdownGuard.ts:260-262,305-416` `serializationContainsFunctions`／`buildRelativeDatePushdownPlan` | regexで関数serializeを確認し、物理top-level SIMPLE＋WHERE全体exactまたはDML exactだけ許可 | 既存Phase1許可形を残し、SELECT FULL_SCAN専用の第2許可形と共有decomposition planを追加 | 1, 2 |
| `src/core/optimization/relativeDatePushdownGuard.ts:416-426` `assertRelativeDatePushdownPlan` | 不許可planをAPI前にPhase1 reasonでthrow | `allowRelativeDatePrefilterPlan(plan)`成功時だけassertを通す。その他は同じreasonで閉じる | 2 |
| `src/core/relativeDateFunction.ts:1-20` `RELATIVE_DATE_FUNCTION_NAMES` | 12関数名とtype guardのtruth source | occurrence探索、regex確認、EXPLAIN列挙もこの集合を共有し、別listを作らない | 1, 4 |
| `src/converter/selectToKintone.ts:160-183` `selectToFetchAllParams` | FULL_SCANで元WHERE全体がJS評価不要なら暗黙にquery化 | Phase2 planではこの暗黙経路を使用せず、explicit `prefilterWhere`だけをfetchへ渡す | 3 |
| `src/execute.ts:2318-2380` `executeSelect` | capabilityがexactでなければmodeをFULL_SCANにし、`allowOriginalWherePushdown`相当をbooleanで渡す | 同じ共有planを選択routingへ渡し、eligible planだけFULL_SCAN＋explicit prefilterへ接続 | 2, 3 |
| `src/execute.ts:3539-3595,3681-3695` `executeFullScanSelect` | `pushdownPlan.mainCondition`でfetchし、取得後`runFullScan`へ元stmtと`appliedKlikes`を渡す | Phase2 planのprefilter／residual／appliedKlikesを同じcall chainへ渡す | 3 |
| `src/execute.ts:3958-3969,4015-4032,4043-4066` `fetchTableRecordsForFullScan` | `pushDownCond`を`whereToKintone`化し、許可時は`selectToFetchAllParams`由来の元WHEREqueryとも合成 | Phase2 planでは`pushDownCond=prefilterWhere`、`allowOriginalWherePushdown=false`を必須とし、二重生成を防ぐ | 3 |
| `src/engine/process.ts:219-228` `applyFilter` | 指定WHEREを各rowの`evalWhere`へ渡す | `null`ならfilterを呼ばず、非nullならresidualだけを評価 | 3, 4 |
| `src/engine/process.ts:1463-1484,1558-1612` `FullScanInput`／`runFullScan` | `FullScanInput`に`appliedKlikes`を持ち、現在は`applyFilter(rows, stmt.where, ...)`を固定使用 | optional `residualWhere`を追加し、未指定時だけ従来どおり`stmt.where`、Phase2 planでは明示値を使用 | 3 |
| `src/execute.ts:885-915,8233-8287,8479-8508,8711-8744` | executionとEXPLAINが`RelativeDatePushdownPlan`を共有し、現行EXPLAINはPhase1 exact／rejectを表示 | plan objectをdecompositionまで拡張し、server prefilter／client residual／各leaf／評価0を同じobjectから表示 | 2, 4 |
| `src/execute.ts:1080-1100` existing-record `VALIDATE` prefilter後評価 | prefilter後も元WHERE全体を`evalWhere`する | Phase2対象外のままguardでAPI前拒否 | 1, 2 |
| `src/engine/evalWhere.ts:341-352,451-466` `resolveKintoneFuncValue` | 相対日付名のclient到達でPhase1 reasonをthrowし、既存3関数だけをresolverへ渡す | backstopは無変更。成功testでこの関数への相対日付dispatchが0回であることを別途証明 | 4 |

### 3.1 現行実装から追加で固定する注意点

1. `executeFullScanSelect` だけでなく、complete-input経路にも `fetchTableRecordsForFullScan` と `runFullScan` の別call siteがある。両方を検索し、eligible Phase2 planがどちらへ入っても元 `stmt.where` を暗黙利用しないことをtestする。
2. 現行 `executeParsedStatement` は実行前に `resolveRelativeDateExecutionPlan`／`assertRelativeDatePushdownPlan` を通す。第2許可形はこの共通入口へ統合し、`executeSelect`内だけの例外にしない。
3. EXPLAINは`buildExplainWhereAnalysis`で同じrelative planを受け取る。execution用とEXPLAIN用にdecompositionを二重実装しない。
4. `FullScanInput.residualWhere` はoptionalだが、`undefined`を「従来どおりstmt.where」、`null`を「filter不要」と区別する。`residualWhere ?? stmt.where`では`null`を潰すため、property presenceまたは明示的な`undefined`判定を使う。

## 4. Step 1 — decomposition、plan object、reject path

### 4.1 目的

副作用なしのcore plannerとして、相対日付exact leaf、既存safe prefilter、client residual、KLIKE identity、capability／reasonを1個の `RelativeDatePrefilterPlan` に固定する。まだ実行guardは緩和せず、decompositionの成功・失敗だけを独立testする。

### 4.2 対象ファイル

- 新規候補
  - `src/core/optimization/relativeDatePrefilterPlan.ts`
  - `src/core/optimization/__tests__/b67Phase2RelativeDatePrefilterPlan.test.ts`
- 既存
  - `src/core/optimization/wherePredicatePushdown.ts`（export済みprimitiveの利用のみ。allowlist変更なし）
  - `src/core/optimization/klikePushdownPlan.ts`（single-table safe planとidentity集合の再利用）
  - `src/core/optimization/whereCapability.ts`
  - `src/core/relativeDateFunction.ts`
  - `src/types/ast.ts`（型参照のみ。parser／AST shape変更は原則なし）
- 回帰
  - `src/core/optimization/__tests__/wherePredicatePushdown.test.ts`
  - `src/core/optimization/__tests__/klikePushdownPlan.test.ts`
  - `src/core/optimization/__tests__/b67RelativeDateWhereCapability.test.ts`

### 4.3 実装内容

1. 次のfieldを不可分に持つ `RelativeDatePrefilterPlan` を定義する。

   ```text
   prefilterWhere
   residualWhere
   exactRelativeLeaves
   relativeFunctionNames
   appliedKlikes
   capability
   reasons
   ```

2. `decomposeRelativeDatePrefilter(stmt, formMeta)` を追加し、直接の物理APP、単一テーブル、トップレベルfield、subtableなしを入口で確認する。単一CTEは呼出し側が既存inlineを済ませた物理SELECTだけを渡せる形にする。
3. rootから`AND`と透過`GROUP`だけを辿る専用walkを実装する。相対日付occurrenceがOR subtree内またはNOT配下に1個でもあれば、他のbranchに関係なく文全体を失敗にする。
4. 各相対日付`BINARY` leafを単体でPhase1 classifierへ渡し、field type／top-level semantics／operator／argumentsが`EXACT_PUSHDOWN`であるものだけを候補化する。`BETWEEN`はparser展開済みの2 leafを別々に判定し、一方でも不適格または残存なら失敗にする。
5. `RELATIVE_DATE_FUNCTION_NAMES`を用いて元WHERE内の全occurrenceを数え、候補leaf数との対応を追跡する。関数名listを別定義しない。
6. 既存`buildSingleTableKlikePushdownPlan`または同じsingle-table primitiveからsafe conditionと`appliedKlikes`を得る。`extractSafePushdownLeaves`自体は変更しない。
7. 各relative exact leafを個別に`whereToKintone`へ通して、そのleafの関数名が個別query内にregexで存在することを確認する。その後、relative leafと既存safe conditionを元のAND順序を尊重してprefilterへ合成し、full `whereToKintone(prefilterWhere)`も確認する。同名関数leafが複数ある場合は、関数名ごとのoccurrence multisetが不足していないことまで検査し、1個のregex matchで複数leafを除去しない。
8. serialize確認済みの同じleaf objectだけを`BOOLEAN true`へ置換し、次だけを局所適用する。
   - `TRUE AND X -> X`
   - `X AND TRUE -> X`
   - `GROUP(TRUE) -> TRUE`
9. 全leaf除去後は`residualWhere=null`とする。それ以外の非相対日付nodeはclone／reparseせず、同じobject identityを残す。LOGICAL／GROUPの必要最小限の親node再構成だけを許す。
10. surgery後にresidualを再walkし、相対日付occurrenceが0でなければplan成立前に失敗する。prefilter serialize失敗、関数regex欠落、leaf対応ずれも同様にfail-closedとする。
11. `capability`／`reasons`は元mixed WHEREの分類を保持する。純Phase1 exactでresidualが空のcaseはPhase2 planへ昇格させず、既存Phase1経路へ委ねる。

### 4.4 追加test（fail-before → pass-after）

- `relative exact AND LENGTH(...)` は変更前Phase1拒否、変更後decomposition単体でrelative leafをprefilter、`LENGTH` nodeを同一identityのresidualとして返す。
- 複数relative leaf、透過GROUP、`BETWEEN`展開、relativeなしOR residualを正しく分解する。
- relativeを含むOR／NOT、非exact operator／type／context、subtable、JOIN、materialized sourceをplan不成立にする。
- serializer throw、関数名regex欠落、residual occurrence残存のtest seamをすべて失敗させる。
- `TRUE AND X`／`X AND TRUE`／`GROUP(TRUE)`だけが畳まれ、OR分配、並べ替え、一般constant foldingを行わない。
- `relative exact AND KLIKE AND LIKE`で、residualのLIKE nodeとKLIKE node identity、`appliedKlikes.has(originalKlike)`を確認する。
- 既存`extractSafePushdownLeaves`のLIKE／KLIKE／NUMBER／選択IN matrixとsnapshotが無変更。
- 純relative exactはPhase1用として識別され、空residualの新EXPLAIN記法を要求しない。

### 4.5 gate／Claude確認観点

共通gateに加え、decomposition testをtable-drivenで全greenにし、Step 1時点では既存Phase1 execution guardがmixed WHEREを引き続きAPI前拒否することを確認する。

Claudeは次を確認してcommitする。

- prefilter採用leafとresidual除去leafが同じ参照・同じserialize確認に結び付いているか。
- `extractSafePushdownLeaves`のallowlistや通常LIKEの扱いを変更していないか。
- 非相対日付nodeとKLIKE nodeのidentityが維持されているか。
- residual occurrence 0が成功条件であり、backstop到達を成功扱いしていないか。
- parser／ASTを不必要に変更していないか。

想定: **1.0〜1.5人日**。

## 5. Step 2 — capabilityとguard第2許可形の定義

### 5.1 目的

mixed WHEREの一般capabilityはPhase1どおり`SUPERSET_PREFILTER`＋Phase1拒否reasonを保持したまま、Step 1のplanが全条件を満たす単一APP SELECT FULL_SCANだけを識別する第2許可形を定義する。このStepでは判定関数と共有planへの格納までを実装し、outer execution assertの解除はStep 3のfetch／residual配線と同じcommitで原子的に有効化する。

### 5.2 対象ファイル

- 既存
  - `src/core/optimization/whereCapability.ts`
  - `src/core/optimization/relativeDatePushdownGuard.ts`
  - `src/core/optimization/relativeDatePrefilterPlan.ts`
  - `src/execute.ts`（plan resolutionとSELECT node／UNION branch／inlined CTEへのplan引渡し）
- test
  - `src/core/optimization/__tests__/b67RelativeDateWhereCapability.test.ts`
  - `src/core/optimization/__tests__/b67RelativeDatePlanGuard.test.ts`
  - 新規候補 `src/core/optimization/__tests__/b67Phase2RelativeDatePlanGuard.test.ts`
  - `src/__tests__/b67RelativeDateExecutionPaths.test.ts`

### 5.3 実装内容

1. mixed WHEREの分類結果を`SUPERSET_PREFILTER`とし、`WHERE_SUPERSET_PREFILTER`、relative leafの`WHERE_EXACT` detail、residualの`WHERE_RESIDUAL`／既存local reason、`WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN`を保持する。
2. `requireExactRelativeDatePushdown`を全statement向けに緩和しない。capability名だけで実行許可しない。
3. `allowRelativeDatePrefilterPlan(plan)` を `relativeDatePushdownGuard`へ追加し、次をすべて確認する。
   - physical single-app SELECT
   - single table、no JOIN、no subtable、no materialized／derived source
   - FULL_SCANかつno KORDER
   - capability=`SUPERSET_PREFILTER`
   - AND-only decomposition成功
   - relative exact prefilter serialize成功
   - residualが既存client evaluatorで評価可能
   - residual内relative occurrence=0
4. 現行Phase1許可形（SIMPLE＋WHERE全体exact＋serialize）を第1許可形として一切変えない。DML exact許可も変えない。`allowRelativeDatePrefilterPlan(plan)`はunit test可能な判定関数として追加するが、このStepでは`assertRelativeDatePushdownPlan`の実行許可へまだ接続しない。
5. `buildRelativeDatePushdownPlan`のSELECT nodeに `RelativeDatePrefilterPlan` を保持させ、executionとEXPLAINが同じobjectを参照できるようにする。単一CTEは既存inline後node、UNIONは各branchを独立判定する。
6. eligibleなmixed WHEREは、`WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN`を診断reasonとして保持したまま第2許可候補とする。実行拒否として扱わない切替はStep 3で行う。planが欠ける／失敗するcaseは従来どおり同reasonでthrowする。
7. KORDER native／cursor、UPDATE／DELETE、SELECT-based DML source、JOIN、VALIDATE、subtable、temp／materialized CTEは第2許可形へ入る前に拒否し、API／Cursor／mutation／confirm 0とする。

### 5.4 追加test（fail-before → pass-after）

- eligible single physical APP mixed SELECTは、`allowRelativeDatePrefilterPlan(plan)=true`かつ`SUPERSET_PREFILTER`候補planを返す一方、outer execution assertはStep 2単独では変更前どおり拒否する。
- 同じWHEREをKORDER native／cursor、UPDATE、DELETE、INSERT SELECT／UPSERT SELECT source、JOIN、VALIDATE、subtable、temp／materialized CTEへ置くと拒否を維持する。
- residual内relative occurrence、serializer欠落、OR／NOT entanglementのtest seamはguard第2許可形を通らない。
- UNIONはeligible branchを独立計画し、1 branchでも不適格ならstatementをAPI前拒否する。
- single CTE inline後に物理single-app SELECTになるcaseだけ許可し、materializeされるcaseは拒否する。
- Phase1 pure exact SIMPLE／KORDER／許可DMLのcapability、REST query、client evaluator 0を無変更で回帰する。
- 全拒否caseでrecords／Cursor／mutation／confirm 0をspyする。

### 5.5 gate／Claude確認観点

共通gateに加え、capability matrixとguard matrixを同じgateで実行し、「一般capabilityはPhase1拒否reasonを保持」「成立済みplanだけ第2許可候補」「outer execution assertはまだPhase1拒否」の三段を確認する。Step 2ではFULL_SCAN fetch／residual実行へ接続せず、実行testは取得前拒否のままとする。

Claudeは次を確認してcommitする。

- `SUPERSET_PREFILTER`という名前だけでPhase1 reasonを削除していないか。
- KORDER／DML／VALIDATEの既存exact境界を共有helperの副作用で広げていないか。
- UNION branchとinline CTEの物理source判定がstatement全体の粗いbooleanになっていないか。
- EXPLAINとexecution用に別planを作っていないか。

想定: **0.75〜1.25人日**。

## 6. Step 3 — FULL_SCAN fetch／residual wiringとKLIKE identity

### 6.1 目的

Step 2で許可したplanを実行経路へ接続する。server fetchへは`plan.prefilterWhere`だけを明示し、client filterへは`plan.residualWhere`だけを明示する。元statementは変更せず、既存KLIKE identityとcomplete-input契約を維持する。

### 6.2 対象ファイル

- 既存
  - `src/execute.ts`
  - `src/converter/selectToKintone.ts`
  - `src/engine/process.ts`
  - `src/core/optimization/klikePushdownPlan.ts`
- test
  - 新規候補 `src/__tests__/b67Phase2RelativeDateExecution.test.ts`
  - `src/engine/__tests__/process.test.ts`
  - `src/__tests__/execute.test.ts`
  - `src/__tests__/klike.execute.test.ts`
  - `src/__tests__/searchAbort.execute.test.ts`
  - complete-input／maxRecords関連既存test

### 6.3 実装内容

1. `executeSelect`からeligible `RelativeDatePrefilterPlan`を`executeFullScanSelect`へ明示的に渡す。surface別の分岐は追加しない。
2. `assertRelativeDatePushdownPlan`へ`allowRelativeDatePrefilterPlan(plan)`を接続し、第2許可形の有効化と以下のfetch／residual配線を同じcommitで行う。配線なしでassertだけを先に開かない。
3. main physical tableの`fetchTableRecordsForFullScan`へ次を渡す。
   - `pushDownCond = plan.prefilterWhere`
   - `allowOriginalWherePushdown = false`
4. `selectToFetchAllParams(stmt, ...)`に元WHERE全体を判定させる暗黙経路をPhase2 planでは必ず無効にし、prefilterの二重生成・元mixed WHEREの誤serializeを防ぐ。
5. `FullScanInput`へoptional `residualWhere`を追加する。
   - `undefined`: 従来どおり`stmt.where`
   - `null`: filter不要
   - `WhereExpr`: そのresidualだけを`applyFilter`へ渡す
6. `runFullScan`はpropertyの`undefined`を明示判定し、`residualWhere ?? stmt.where`を使わない。元stmtをprojection／GROUP／DISTINCT／window／ORDER等へそのまま渡し、WHEREだけを別入力にする。
7. `appliedKlikes`はStep 1 planで対応付けた同じSet／leaf identityを`runFullScan`へ渡す。再parse／deep clone／JSON round-tripを行わない。
8. `residualWhere=null`では`applyFilter`／`evalWhere`を呼ばない。ただしこのpure exact caseは原則Phase1 SIMPLE経路であり、Phase2 SUPERSET_PREFILTER表示へ変更しない。
9. 初回records GET queryが `相対日付predicate order by $id asc limit 500 offset 0` となり、後続pageでもbase predicateを維持してkeyset／offset／limitだけを付加する既存`fetchAll`契約を回帰する。
10. maxRecords、complete-input、SearchAbortedError、REST error時のfail-closedを維持する。途中打切りの部分結果や空query retryを追加しない。
11. `executeFullScanSelect`とcomplete-input側の全`fetchTableRecordsForFullScan`／`runFullScan` call siteを検索し、hidden `stmt.where` pathがないことをtestで固定する。

### 6.4 追加test（fail-before → pass-after）

- `更新日時 >= YESTERDAY() AND LENGTH(都道府県) > 1`が変更前API前拒否、変更後relative queryでrecordsを取得し、LENGTHだけで結果を絞る。
- mockの初回・後続GET query byteを比較し、全pageでrelative predicateが保持される。
- `relative exact AND LIKE`でLIKEだけをJS評価する。
- `relative exact AND KLIKE AND LIKE`でserver query、`appliedKlikes` identity、LIKE residual評価、最終結果を確認する。
- 複数relative leafは全leafをANDしたqueryになり、client residualには1個も残らない。
- relativeなしOR residualはsubtree全体をclient評価し、OR node identityを維持する。
- 元`stmt.where` objectとJSONが実行前後で不変である。
- `FullScanInput.residualWhere`の`undefined`／`null`／ASTの3値contractを`process.test.ts`で固定する。
- kintone REST error時にgetRecords retry用空query、client relative評価、部分結果が0である。
- maxRecords／complete-input／SearchAbortedError既存testを回帰する。

### 6.5 gate／Claude確認観点

共通gateに加え、正例のquery byte、結果row、residual AST、KLIKE identity、API call sequenceを同じintegration testで確認する。Phase2実行能力を初めて開くStepなので、Step 1／2の全negative matrixとPhase1 backstop testも同時に必須とする。

Claudeは次を確認してcommitする。

- `allowOriginalWherePushdown=false`がeligible planの全fetch call siteで強制されるか。
- `runFullScan`が`stmt.where`へ戻るhidden pathを残していないか。
- `null` residualを`undefined`と混同していないか。
- KLIKE applied setとresidual nodeが同じoriginal AST identityを保つか。
- REST error／上限到達時にfallbackや部分結果を返さないか。

想定: **1.0〜1.5人日**。

## 7. Step 4 — EXPLAIN、reason parity、backstop-0証明

### 7.1 目的

実行と同じ `RelativeDatePrefilterPlan` からEXPLAINを生成し、server prefilter、client residual、各relative leaf、`relative date client evaluations: 0`を表示する。同時に、成功経路で相対日付evaluator呼出しが実際に0であることをspyとresidual ASTの両方で直接証明する。

### 7.2 対象ファイル

- 既存
  - `src/core/optimization/relativeDatePushdownGuard.ts`
  - `src/core/optimization/relativeDatePrefilterPlan.ts`
  - `src/execute.ts`
  - `src/engine/evalWhere.ts`（実装変更なしを原則とし、spy seamが必要なら挙動不変のtest-only注入だけ）
- test
  - `src/__tests__/b67RelativeDateExplain.test.ts`
  - 新規候補 `src/__tests__/b67Phase2RelativeDateExplain.test.ts`
  - `src/engine/__tests__/b67RelativeDateBackstop.test.ts`
  - `src/__tests__/b67RelativeDateAcceptance.test.ts`

### 7.3 実装内容

1. EXPLAINはexecutionが使う同じplan objectを受け取り、再decompose／再serializeしない。
2. eligible mixed caseで少なくとも次を表示する。

   ```text
   mode: FULL_SCAN
   where capability: SUPERSET_PREFILTER
   relative date function: YESTERDAY
   relative date evaluation: kintone server exact prefilter
   server prefilter: 更新日時 >= YESTERDAY()
   client residual: LENGTH(都道府県) > 1
   relative date client evaluations: 0
   kintone query: 更新日時 >= YESTERDAY()
   ```

3. 複数relative leafはfunction／field／fieldType／operatorを各leafごとに列挙し、合成server prefilterとclient residualはそれぞれ1回表示する。
4. pure Phase1 exact／empty residualは従来の`EXACT_PUSHDOWN`／`client evaluation: forbidden`へ完全に委ね、新しいempty notationや`SUPERSET_PREFILTER`表示を追加しない。
5. reject EXPLAINは関数名、path、Phase1 reasonと詳細reasonを表示し、実行可能なGET／Cursor queryと誤認させない。フォームmetadata以外のAPIは0。
6. evaluator spyを追加し、Phase2成功caseで相対日付`KINTONE_FUNC`が`resolveKintoneFuncValue`へdispatchされる回数を0として観測する。residual AST occurrence 0のassertも別に残し、spyだけに依存しない。
7. planner bypass testは従来どおり相対日付nodeを`evalWhere`へ直接渡し、`WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN`でthrowすることを維持する。
8. executionとEXPLAINでquery、capability、reason、leaf detailが一致するsnapshot／structured assertionを追加する。

### 7.4 追加test（fail-before → pass-after）

- mixed正例のEXPLAINがPhase1 reject表示から、FULL_SCAN／SUPERSET_PREFILTER／server prefilter／client residual／評価0表示へ変わる。
- 複数leafのdetail列挙と合成query／residualの単一表示を確認する。
- Phase1 pure exact EXPLAIN snapshotはbyte無変更。
- OR／NOT、KORDER、DML、JOIN、VALIDATE等のreject EXPLAINとexecution reasonが一致し、API 0。
- 成功caseすべてでresidual occurrence 0、relative evaluator spy 0、backstop未発火。
- planner bypass caseではbackstopが引き続き発火し、未知関数default denyと既存3関数挙動も無変更。

### 7.5 gate／Claude確認観点

共通gateに加え、execution＝EXPLAIN parity、residual AST 0、evaluator spy 0、bypass backstop throwの4証拠を同じgateで揃える。

Claudeは次を確認してcommitする。

- EXPLAIN専用decomposition／allowlist／reason変換が追加されていないか。
- `client evaluation: forbidden`と`relative date client evaluations: 0`をcaseに応じて混同していないか。
- 成功を「backstopがthrowしなかった」だけで判定せず、dispatch 0を直接観測しているか。
- reject EXPLAINが実行可能queryを表示していないか。

想定: **0.5〜0.75人日**。

## 8. Step 5 — 4面受入、docs、regression、benchmark

### 8.1 目的

Node／CLI／MCP／Firefox・Chrome pluginが1個のcore plannerを共有し、同じSQL、app metadata、query、結果、EXPLAIN、reject reasonを返すことをrelease gateとして固定する。仕様§9の受入matrix、公開docs同期、性能・上限の非回帰を完了する。

### 8.2 対象ファイル

- test／smoke
  - `src/__tests__/b67RelativeDateAcceptance.test.ts`
  - `src/__tests__/b67RelativeDateSurfaces.test.ts`
  - `scripts/mcp-smoke.mjs`
  - CLI smokeの既存script／test
  - plugin browser smokeの既存harness／手順
  - 新規候補 `scripts/b67-phase2-prefilter-benchmark.mjs`
- docs／evidence
  - `docs/ksql_language_reference.md`
  - `README.md`（該当する相対日付制約記述がある場合）
  - `src/mcp/docsResources.ts`
  - `src/mcp/index.ts`／tool description（契約driftがある場合だけ）
  - `docs/internal/evidence/b67_phase2_acceptance.md`
  - `docs/internal/evidence/b67_phase2_browser_smoke.md`
  - `docs/ksql_issue_tracker.md`（実装完了時）
  - 本計画（完了status／実測値のみ）

### 8.3 実装内容

1. Node engineで仕様§9.1〜§9.3の正例、拒否、backstop、非回帰matrixを全件ID付きで実行する。
2. build済みCLIとMCP `ksql_query`／`ksql_explain`で代表正例・拒否例を実行し、Nodeとquery／result／EXPLAIN／reasonを比較する。MCP schema／instructionsへ独自許可条件を追加しない。
3. Firefox／Chrome pluginは同一build、同一SQL、同一app metadataで実機smokeする。仕様§14.3の既定候補は次とする。

   ```sql
   SELECT 都道府県, 更新日時 FROM APP730
   WHERE 更新日時 >= FROM_TODAY(-3650, DAYS)
   AND LENGTH(都道府県) > 0
   ```

4. browser clock／timezoneを参照しないこと、送信query、residual結果、EXPLAIN、relative evaluator 0をDevTools／harness evidenceへ記録する。最終APP／fieldはユーザー環境で確定してよい。
5. Firefox／Chromeの両evidenceが揃うまでbrowser release gateを未完了とし、Node／jsdom／build成功で代替しない。
6. 言語リファレンスとMCP docs resourceへPhase2 Aの許可形と対象外を同期する。一般的なFULL_SCAN相対日付対応、KORDER／DML対応、client相対日付評価と誤記しない。
7. benchmarkは同じmock fixtureで次を比較する。
   - Phase2 prefilterありの取得候補数／client residual評価数
   - 相対日付を含まない既存FULL_SCAN baseline
   - 1万件上限近傍でのplanning時間とresidual filter時間
8. benchmarkは意味論gateではなく回帰観測とし、時刻計算を含めない。maxRecords／complete-input／SearchAbortedErrorの既存fail-closedを別testで維持する。
9. `npm run mcp:smoke`、`npm run mcp:verify`、`npm run mcpb:verify`、engine bundle／declaration／pack／docs smokeなど影響面の既存配布smokeを実行する。

### 8.4 追加test／smoke（fail-before → pass-after）

- Node／CLI／MCP／pluginでmixed正例が変更前同reasonで拒否、変更後同じprefilter query／result／EXPLAINを返す。
- 全surfaceでOR／NOT、KORDER native／cursor、DML、JOIN、VALIDATE等が同reasonで拒否される。
- Firefox／Chromeで広い窓fixtureが日付境界を跨いでもflakyにならず、client clock参照0。
- `TODAY()`／`NOW()`／`LOGINUSER()`、Phase1 exact、B32 reason matrix、LIKE-only residual、safe-leaf prefilter、KLIKE-only exact／identityを回帰する。
- maxRecords／complete-input／SearchAbortedErrorで部分結果を返さない。
- benchmark結果をacceptance evidenceへ記録し、性能悪化があればrelease前に原因を再確認する。

### 8.5 gate／Claude確認観点

1. 共通gate。
2. `npm test`全green、既存snapshot無変更。
3. `npm run build`でplugin／CLI／MCP／MCPB／engine全成功。
4. Phase2 decomposition／guard／execution／EXPLAIN／backstop／surface test全成功。
5. MCP／MCPB／engineの既存配布smoke無回帰。
6. build済みNode／CLI／MCPの代表正例・拒否例が同じquery／result／EXPLAIN／reason。
7. Firefox／Chrome実ブラウザsmokeはユーザーが実施し、両方のevidenceが揃うまでbrowser release gate未完了。
8. Claudeが仕様§9とのID対応、全output、API 0、snapshot無変更、benchmark、両browser evidenceをレビューし、Claudeがcommitする。

Claudeは次を確認する。

- surface別planner／allowlist／fallbackを作っていないか。
- docsが単一物理APP SELECT FULL_SCAN限定と対象外を正確に説明しているか。
- browser実機をNode testで代替していないか。
- benchmarkの候補削減を意味論の正しさの代用にしていないか。

想定: **0.75〜1.5人日**（Firefox／Chromeのユーザー実施時間を除く）。

## 9. 仕様 §9 受入項目と Step 対応

識別のため、仕様の箇条書きを上から順に `9.1-1` のように採番する。

| 受入ID | 受入内容 | 主Step | 最終証拠 |
|---|---|---:|---|
| 9.1-1 | relative exact＋LENGTHをprefilter／residualへ分離 | 1, 3 | decomposition＋execution integration |
| 9.1-2 | 初回／後続records GET query、evaluator 0、residual occurrence 0 | 3, 4 | query byte＋AST＋spy |
| 9.1-3 | relative exact＋通常LIKE | 1, 3 | residual evaluation test |
| 9.1-4 | relative exact＋KLIKE＋通常LIKE、identity維持 | 1, 3 | identity＋result test |
| 9.1-5 | 複数relative leafを全push／全除去 | 1, 3, 4 | plan＋query＋EXPLAIN |
| 9.1-6 | relativeなしOR residualを許可 | 1, 3 | AND-spine／OR-subtree test |
| 9.1-7 | Phase1 pure exact無回帰 | 全Step | Phase1 acceptance／snapshot |
| 9.2-1 | OR／NOT／非exact type・operator・contextをAPI前拒否 | 1, 2 | guard negative matrix |
| 9.2-2 | serialize失敗、関数欠落、residual残存をAPI前拒否 | 1, 2 | fault-injection test |
| 9.2-3 | KORDER native／cursor拒否、Cursor作成0 | 2, 4 | KORDER matrix＋API spy |
| 9.2-4 | DML／SELECT-based DML／JOIN／VALIDATE／subtable／materialized・temp拒否 | 2 | execution-path matrix |
| 9.2-5 | planner bypass時にbackstop throw | 4 |既存backstop test |
| 9.2-6 | REST error時に空query／FULL_SCAN／client clockへretryしない | 3 | API call sequence test |
| 9.3-1 | 既存3 contextual関数無回帰 | 全Step | legacy parser／query／resolver test |
| 9.3-2 | B32／LIKE／safe leaf／KLIKE無回帰 | 1, 2, 3 | optimization／execution regression |
| 9.3-3 | Node／CLI／MCP／Firefox／Chrome一致 | 4, 5 | surface test＋browser evidence |
| 9.3-4 | maxRecords／complete-input／SearchAbortedError維持 | 3, 5 |既存fail-closed regression |

Step 1は§9.1／§9.2の構造的前提を固定し、Step 2は対象面とAPI前拒否を固定する。Step 3で§9.1の実行正例と取得契約を満たし、Step 4でEXPLAIN／reason／評価0／backstopを完成させる。Step 5は全項目を4面とrelease evidenceで再実行する最終gateである。

## 10. 段階マージ順と安全境界

| 順 | 独立レビュー単位 | 開く能力 | merge時の安全境界 |
|---:|---|---|---|
| 1 | decomposition／plan object | pureなprefilter・residual計画 | execution guardはPhase1拒否のまま |
| 2 | capability／第2許可形 | eligible planの識別 | fetch／filter配線前、APIはまだ開かない |
| 3 | FULL_SCAN wiring | Phase2 A正例の実行 | explicit prefilter＋residual、backstop維持 |
| 4 | EXPLAIN／評価0証明 | 診断と実行の一致 | AST 0＋spy 0＋bypass throw |
| 5 | 4面／docs／benchmark | release可否の証拠 | Firefox／Chrome実機evidence必須 |

Step 1だけをmergeしても実行能力は増えない。Step 2もplanを認識するだけに留め、Step 3のexplicit fetch／residual wiringと同時でなければmixed WHEREを実行許可しない。もし既存入口の都合でStep 2時点に`allowed=true`が実行へ直結するなら、feature-internalな配線順を調整し、Step 2 commitではassertを開かない。安全性をcommit境界より後へ先送りしない。

## 11. 見積り

| Step | 領域 | 人日 |
|---:|---|---:|
| 1 | decomposition／plan object／AST surgery／reject test | 1.0〜1.5 |
| 2 | capability／guard第2許可形／対象面matrix | 0.75〜1.25 |
| 3 | FULL_SCAN fetch／residual input／KLIKE identity | 1.0〜1.5 |
| 4 | EXPLAIN／reason parity／backstop-0証明 | 0.5〜0.75 |
| 5 | 4面acceptance／docs／benchmark／browser手順 | 0.75〜1.5 |
| **合計** | **B67 Phase2 A** | **4.0〜6.5人日** |

正仕様の5〜8人日に対し、Phase1でparser、serializer、relative classifier、plan walk、runtime backstop、4面基盤が実装済みであるため、純実装は4.0〜6.5人日を目安とする。ただし、hidden FULL_SCAN pathの修正が複数経路へ広がる場合、またはFirefox／Chrome実機fixtureの準備が必要な場合は仕様見積り上限の8人日まで見る。実ブラウザをユーザーが操作する時間は別扱いとする。

## 12. 主要リスクと停止条件

### 12.1 leaf／residual対応ずれ

最も重大なriskは、server queryへ採用していないrelative leafをresidualから除去することである。serialize確認済みleafと除去leafを同じplan生成pass・同じobject対応で固定し、regex欠落や個数不一致ではAPI前拒否する。prefilterとresidualを別々にreparse／reclassifyする設計は停止して見直す。

### 12.2 KLIKE identity破壊

KLIKE skipは`appliedKlikes`のAST node identityに依存する。deep clone、JSON round-trip、全tree再構築を行わず、非relative residual nodeを原参照のまま残す。`appliedKlikes.has(originalNode)`が失敗した時点でStep 1または3のgateを停止する。

### 12.3 hidden `stmt.where` FULL_SCAN path

`execute.ts`には複数の`fetchTableRecordsForFullScan`／`runFullScan` call siteがあり、`selectToFetchAllParams`にも元WHERE暗黙pushdownがある。全call siteを検索し、eligible planで`allowOriginalWherePushdown=false`と`FullScanInput.residualWhere`が必ず届くことをintegration testで固定する。相対日付evaluator spyが1回でも観測されたらrelease不可とする。

### 12.4 capabilityの過剰緩和

`WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN`を一般分類から削除すると、KORDER、DML、VALIDATE等まで誤って開く。reasonは保持し、`allowRelativeDatePrefilterPlan(plan)`だけが局所的に実行拒否を解除する。KORDER／DML／VALIDATE matrixのいずれかがAPIへ到達したらStep 2以降を停止する。

### 12.5 `null` residualのfallback誤り

`residualWhere=null`をnullish coalescingで`stmt.where`へ戻すとbackstopへ到達する。`undefined`と`null`を別意味として型・testで固定する。pure exact caseはPhase1へ委ね、Phase2 pathで偶発的に空residualを作らない。

## 13. 完了判定

B67 Phase2 Aを完了と呼べるのは、次がすべて成立したときだけである。

1. `RelativeDatePrefilterPlan`がR2 §14.1の7 fieldを持ち、executionとEXPLAINで共有される。
2. AND spine上のserialize確認済みPhase1 exact leafだけがresidualから除去される。
3. residual AST内の相対日付occurrenceが常に0で、成功時のrelative evaluator dispatchが0回である。
4. explicit `prefilterWhere`だけがFULL_SCAN fetchへ渡り、元WHERE暗黙pushdownが無効である。
5. `FullScanInput.residualWhere`だけがclient filterへ渡り、元statementは不変である。
6. 通常LIKE、safe leaf、KLIKE identity、Phase1 exact、既存3 contextual関数が無回帰である。
7. OR／NOT、KORDER、DML、SELECT-based DML、JOIN、VALIDATE、subtable、temp／materialized sourceがAPI前にfail-closedする。
8. EXPLAINがserver prefilter、client residual、各relative leaf、`relative date client evaluations: 0`を同じplanから表示する。
9. `npm test`、全surface build、snapshot不変、配布smoke、maxRecords／complete-input／SearchAbortedError regressionがgreenである。
10. Node／CLI／MCP／Firefox／Chromeで同じquery、result、EXPLAIN、reasonが確認され、両browser実機evidenceをClaudeがレビューしてcommitする。
