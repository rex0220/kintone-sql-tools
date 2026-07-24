# B67 Phase2 A — 相対日付 exact prefilter ＋残余 client 評価仕様

- 作成日: 2026-07-24
- ステータス: **仕様 R2＝実装着手可能水準**（2026-07-25）。R1（codex 起草）→ Claude レビュー済＝設計妥当。核心（相対日付 exact leaf を explicit prefilter で押し下げ＋residualWhere〔相対日付 leaf 除去済み〕を FULL_SCAN filter 入力にし client 再評価しない・backstop 維持）は妥当。ブリーフの LIKE/KLIKE 混同を R1 が是正（`extractSafePushdownLeaves` は KLIKE/$id/型確認 NUMBER/選択 IN を扱い通常 SQL LIKE は残余 JS＝相対日付分解は汎用抽出器に負わせず隣接追加）。8論点決着・AND 限定・OR/KORDER/DML/JOIN/VALIDATE は対象外で明示。**R2 で §13 の非意味論 3 点を §14 に決着**（識別子名・空 residual の EXPLAIN 表記＝Phase1 exact 表示へ委任・browser fixture 方針）。公開意味論の未決なし。**次＝実装計画（codex 起草→Claude レビュー）→ ブランチ切って Step 実装**（見積り 5〜8 人日）。B67 Phase1（v3.20.0）とは独立の後続。
- 方針: **SUPERSET_PREFILTER**。相対日付 exact leaf は kintone server で1回だけ評価し、取得後は相対日付 leaf を除いた残余だけを client 評価する。
- 正: [B67 Phase1 仕様 R2](ksql_b67_rest_query_functions_phase1_spec.md)（特に §5、§11.1）
- 起草ブリーフ: [B67 Phase2 SUPERSET_PREFILTER 仕様 R1 ブリーフ](ksql_b67_phase2_prefilter_spec_r1_brief.md)
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B67

## 1. スコープ（Phase2 A）

### 1.1 対象

Phase2 A は、物理 kintone アプリの単一テーブル SELECT node において、次の形を許可する。

```text
相対日付 exact leaf（1個以上、複数可）
AND
相対日付を含まない client 評価可能な残余（1個以上）
```

相対日付 exact leaf は Phase1 の型・位置・引数・6比較の allowlist をすべて満たす `EXACT_PUSHDOWN` leaf でなければならない。対象 leaf を kintone query へ exact prefilter として押し下げ、取得行には残余だけを評価する。相対日付関数を Node / CLI / MCP / plugin の JavaScript evaluator で値へ解決する機能は追加しない。

SELECT node は直接の物理 APP を一意に指し、サブテーブル・JOIN を持たないことを必須とする。`UNION` の各 branch は独立した SELECT node として同じ条件を検査してよい。単一 CTE の既存 inline 後に一意な物理 SELECT node になる場合は、その inlined node に対して同じ判定を行ってよい。temp / materialized CTE / 派生結果を入力とする node は対象外である。

相対日付 leaf と残余によって FULL_SCAN になった後、既存の単一テーブル FULL_SCAN が filter 後に行う projection、GROUP、DISTINCT、window、canonical local ORDER 等は、その演算自体に相対日付関数を含まず、既存 complete-input 契約を満たす限り利用できる。Phase2 A が変更するのは取得前 prefilter と WHERE filter 入力だけであり、後段演算の意味論・上限・順序契約は変更しない。

### 1.2 対象外

- 相対日付を含む leaf が `OR` の内側または外側にある形。残余だけの OR は、相対日付 leaf と AND で結ばれていれば許可できる。
- 相対日付 leaf に対する `NOT`、関数左辺、非 Phase1 型、非 Phase1 演算子、引数不正、型不明。
- `KORDER BY`。`KORDER_NATIVE` / `KORDER_CURSOR` はともに WHERE 全体の exact 性を要求する既存境界を維持する。
- UPDATE / DELETE その他 DML の対象選択。`VALIDATE ONLY` を含め、既存の WHERE 全体 `EXACT_PUSHDOWN` 必須を維持する。
- JOIN 後残余、JOIN table 別 prefilter、外部結合、サブテーブル、`VALIDATE`、temp / materialized CTE、派生表。
- 相対日付関数そのものの client 評価、日時リテラルへの展開、server 評価結果の client clock による再現。
- Phase1 が拒否した SELECT列、SET / VALUES、CHECK、HAVING、JOIN ON、CASE、関数引数、GROUP / ORDER key 等の一般式位置。

### 1.3 現行実装の裏取り

| 実コード | 確認した現行契約 | Phase2 A の接続要件 |
|---|---|---|
| `src/core/optimization/wherePredicatePushdown.ts:27-39,63-88` | `extractSafePushdownLeaves` は AND leaf だけを抽出し、OR / NOT 等は subtree ごと除外する | AND-only traversal は再利用するが、相対日付の「抽出＋残余除去」を汎用抽出器だけに負わせない |
| `src/core/optimization/wherePredicatePushdown.ts:91-135` | 現行 safe leaf は KLIKE、`$id` / 型確認済み NUMBER 比較、選択系 IN 等。通常の SQL LIKE 自体は safe leaf ではない | 通常 LIKE は残余に残す。既存 safe leaf の包含性・identity 契約を変えない |
| `src/core/optimization/whereCapability.ts:5-23,138-181` | B32 は `EXACT_PUSHDOWN` / `SUPERSET_PREFILTER` / `LOCAL_ONLY` / `UNSUPPORTED` と reason を返し、通常 LIKE は `WHERE_RESIDUAL` | eligible な混在 WHERE の全体 capability は `SUPERSET_PREFILTER` とする |
| `src/core/optimization/whereCapability.ts:189-258,333-415` | B67 leaf は型・演算子・引数を満たせば exact。一方、AND 全体が非 exact になると `WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN` が追加される | exact relative leaf を安全に除去できる分解済み計画だけ、この Phase1 拒否を緩和する |
| `src/core/optimization/relativeDatePushdownGuard.ts:305-425` | 現行 plan walk は物理 SIMPLE SELECT かつ WHERE 全体 exact、または DML exact だけを許可し、それ以外を API 取得前に拒否する | eligible な単一 APP FULL_SCAN prefilter plan を明示的な第2許可形として加える |
| `src/converter/selectToKintone.ts:160-183` | `selectToFetchAllParams` は JS 評価不要な元 WHERE 全体だけを query 化し、ORDER / LIMIT は含めない | Phase2 A は元 WHERE 全体でなく、planner が確定した explicit prefilter を fetch 経路へ渡す |
| `src/execute.ts:3539-3595,3681-3695,4005-4032,4043-4065` | FULL_SCAN fetch は `pushDownCond` を `whereToKintone` で query 化し、取得後は元 `stmt` を `runFullScan` へ渡す | Phase2 A では relative exact leaf を含む explicit prefilter を `pushDownCond` とし、元 WHERE 全体の暗黙 pushを無効化した上で residualを別入力にする |
| `src/engine/process.ts:1558-1612` / `src/engine/process.ts:219-228` | `runFullScan` は join 後に `applyFilter(rows, stmt.where, ...)` を呼び、同関数が各行を `evalWhere` で評価する | Phase2 A は元 `stmt.where` でなく、相対日付 leaf 除去済み `residualWhere` を filter 入力にする |
| `src/execute.ts:1080-1100` | `VALIDATE` は prefilter 後も元 WHERE 全体を `evalWhere` する | Phase2 A に含めず、現行 B67 取得前拒否を維持する |
| `src/engine/evalWhere.ts:445-468` | 相対日付関数名が client 値解決へ到達すると `WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN` を含むエラーを throw する | backstop を維持し、通常成功経路では相対日付 node を一度も到達させない |

## 2. 意味論（exact prefilter ＋残余分解）

### 2.1 集合契約

元 WHERE を次のように表す。

```text
W = E1 AND E2 ... AND En AND R
```

- `Ei`: Phase1 の `EXACT_PUSHDOWN` を満たす相対日付 leaf。
- `R`: 相対日付を含まず、既存 JavaScript evaluator で評価可能な残余。
- `S`: `R` または元 WHERE から既存 `extractSafePushdownLeaves` が得る safe prefilter。存在しなければ `TRUE`。

物理計画は次である。

```text
server prefilter P = E1 AND E2 ... AND En AND S
client residual  C = R
```

`Ei` は kintone server の判定と同じ集合を返す exact 条件である。したがって、取得された各行について `Ei` を client で再評価する必要はなく、残余では `TRUE` として畳める。`S` が exact でなく候補集合の superset だけを保証する leaf を含んでも、`R` の client 評価が最終集合を確定する。

重要な不変条件は次の3点である。

1. 相対日付 leaf は **exact server predicate** として query に実在する。
2. query への serialize 成功を確認した同じ leaf だけを residual から除去する。
3. 相対日付関数を含む node は residual AST に0個である。

いずれかを証明できなければ、取得を開始せず Phase1 と同じ fail-closed に戻す。server が query を REST error にした場合も全件取得や client 評価へ retry しない。

### 2.2 代表例

```sql
SELECT 都道府県, 更新日時 FROM APP730
WHERE 更新日時 >= YESTERDAY()
AND   LENGTH(都道府県) > 1
```

計画は次に固定する。

```text
server prefilter: 更新日時 >= YESTERDAY()
client residual:  LENGTH(都道府県) > 1
relative date client evaluations: 0
```

複数 leaf も同じである。

```sql
WHERE 更新日時 >= FROM_TODAY(-7, DAYS)
AND 更新日時 < TOMORROW()
AND (LENGTH(都道府県) > 1 OR 都道府県 IS NULL)
```

2個の相対日付 leaf は server prefilter、括弧内の相対日付を含まない OR subtree は client residual とする。

## 3. 分解規則（AND 限定・leaf 除去）

### 3.1 eligible leaf

除去可能な相対日付 leaf は、次をすべて満たす `BINARY` node だけである。

1. root からその leaf までの論理経路が `AND` と透過 `GROUP` だけである。
2. leaf 単体の B67 capability が Phase1 の `EXACT_PUSHDOWN` である。
3. field は一意な物理 APP のトップレベル `DATE` / `DATETIME` / `CREATED_TIME` / `UPDATED_TIME`。
4. operator は `=` `!=` `<` `<=` `>` `>=` のいずれかで、関数・引数は Phase1 allowlist に適合する。
5. `whereToKintone` の出力に対象関数が正規表現で実在し、prefilter query に採用される。

`BETWEEN` は parser が生成する `>= AND <=` の各 leaf を個別に判定する。相対日付境界が2個なら両方を除去できる。一方だけが非 exact なら、その相対日付 occurrence が残るため文全体を拒否する。

### 3.2 OR / NOT の扱い

相対日付 occurrence が1個でも OR subtree 内にあれば、OR の他方が exact か local かにかかわらず Phase2 A では拒否する。

```sql
-- 拒否
WHERE 更新日時 >= YESTERDAY() OR LENGTH(都道府県) > 1

-- 拒否
WHERE (更新日時 >= YESTERDAY() AND A = 1) OR B = 2

-- 許可可能: OR は相対日付を含まない残余だけ
WHERE 更新日時 >= YESTERDAY() AND (A = 1 OR LENGTH(B) > 2)
```

OR 枝で行が候補集合へ入る場合、相対日付 leaf を `TRUE` に置換すると元 WHERE と同値でなくなるためである。NOT の内側も補集合により同じ安全性を証明できないため拒否する。OR / NOT を分配・ド・モルガン変換して適用範囲を広げない。

### 3.3 residual AST の生成

eligible と確定し、prefilter query に採用した相対日付 leaf だけを `BOOLEAN true` に置換し、次の局所正規化を行う。

```text
TRUE AND X  -> X
X AND TRUE  -> X
GROUP(TRUE) -> TRUE
```

すべての WHERE leaf が除去された場合は `residualWhere = null` とし、client filter を呼ばない。`TRUE` を含む一般的な論理最適化、OR 分配、leaf の並べ替えは行わない。

相対日付以外の残余 node は clone / reparse せず object identity を維持する。現行 KLIKE 経路の `appliedKlikes` は AST node identity で server 適用済みを判定するため、Phase2 A の surgery が既存 KLIKE 契約を壊してはならない。

分解結果は最低限、次を不可分な1 plan object として持つ。

```text
prefilterWhere
residualWhere
exactRelativeLeaves
relativeFunctionNames
appliedKlikes
capability / reasons
```

prefilter と residual を別々に再解析・再分類して対応関係を失う実装は禁止する。

## 4. 既存 LIKE / safe-leaf prefilter との差異

ブリーフでいう「既存 LIKE prefilter」は、通常 LIKE を含む WHERE が `SUPERSET_PREFILTER` / FULL_SCAN となり、安全な同伴 leaf を先に押し下げ、取得後に残余を JavaScript で確定する経路を指す。実コード上、通常の SQL `LIKE` / `NOT LIKE` 自体は `extractSafePushdownLeaves` の safe leaf ではなく、`whereCapability.ts` で `WHERE_RESIDUAL` となり client 評価に残る。native `KLIKE` / `NOT KLIKE` は別意味論・別 identity 契約である。

| 観点 | 通常 LIKE を含む既存 superset 経路 | B67 Phase2 A の相対日付 leaf |
|---|---|---|
| server 条件 | 同伴する safe leaf を候補絞り込みに使用。通常 LIKE 自体は押し下げない | 相対日付 leaf 自体を exact に押し下げる |
| server 条件の要求 | safe leaf は最終候補を落とさない superset 性で足りる | Phase1 と同じ厳密な exact 性が必須 |
| client WHERE | 通常 LIKE を含む残余を JS 評価する。現行 FULL_SCAN は原則元 WHERE 全体を渡す | 相対日付 leafを `TRUE` に畳んだ残余だけを渡す |
| leaf の再評価 | 通常 LIKE は必ず JS で最終判定 | 相対日付は client 評価0 |
| evaluator | LIKE の JavaScript 意味論を持つ | 相対日付の JavaScript 意味論を追加しない。到達時は throw |
| 失敗時 | safe prefilter がなければ全候補取得が可能 | exact relative prefilter が作れなければ取得前拒否 |

`KLIKE` は server exact として `appliedKlikes` により client evaluator で skip される既存の別契約であり、通常 LIKE と相対日付の比較表へ混入させない。Phase2 A は既存 LIKE / KLIKE の意味論、safe leaf allowlist、object identity、query byte を変更しない。

## 5. plan gate の緩和と fail-closed 維持

### 5.1 capability

混在 WHERE 全体の capability は `SUPERSET_PREFILTER` とする。理由集合は少なくとも次を保持する。

- 全体: `WHERE_SUPERSET_PREFILTER`
- 相対日付 exact leaf: `WHERE_EXACT` と function / field / fieldType / operator
- client residual: `WHERE_RESIDUAL` または既存 local reason

現行 `requireExactRelativeDatePushdown` が付加する `WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN` は、単なる capability 名だけで抑止してはならない。§3 の分解 plan が成立し、§5.2 の面・物理計画 gate をすべて通り、prefilter serialization と residual の相対日付0件を確認した場合だけ、実行拒否理由として扱わない。分解前の一般 capability 判定を全 statement に対して緩める実装は禁止する。

### 5.2 `relativeDatePushdownGuard` の第2許可形

Phase1 の許可形:

```text
physical top-level + SIMPLE + WHERE全体 EXACT_PUSHDOWN + server serialization
```

に加え、Phase2 A は次を第2許可形とする。

```text
physical single-app SELECT
+ no JOIN / subtable / materialized source
+ no KORDER
+ capability SUPERSET_PREFILTER
+ §3 の AND-only decomposition 成功
+ relative exact prefilter serialization 成功
+ residual is client-evaluable
+ relative occurrences in residual = 0
```

`clientWhereEvaluation` は単純な boolean では情報不足になるため、EXPLAIN と実行が共有する plan node で `serverPrefilter` と `clientResidual` を別々に表現する。相対日付については常に `client evaluation: 0` である。

### 5.3 実行経路

FULL_SCAN fetch へは plan の `prefilterWhere` を明示的に渡す。`selectToFetchAllParams(stmt, ...)` に元 WHERE 全体を判定させる経路はこの plan では使用せず、`allowOriginalWherePushdown = false` 相当を必須とする。これにより押し下げ不能残余を含む元 WHERE の誤 serialize と、prefilter の二重生成を防ぐ。

`runFullScan` / `applyFilter` へは `stmt.where` ではなく plan の `residualWhere` を明示的に渡す。表示・後段処理のために元 statement を破壊的変更してはならない。実装形は `FullScanInput.residualWhere` の追加、または同等に元 statement と残余を分離できる入力とする。

### 5.4 fail-closed と runtime backstop

次はすべて records / cursor API 前に従来 reason で拒否する。

- OR / NOT 絡み、非 exact leaf、unsupported context。
- prefilter query に相対日付関数が実在しない、または serializer が失敗する。
- residual traversal で相対日付 occurrence が1個以上見つかる。
- KORDER、DML、JOIN、VALIDATE、サブテーブル、materialized source。

`evalWhere.ts` の相対日付 runtime backstop は削除・緩和・skip 対象化しない。planner を bypass して相対日付 node が evaluator に到達した場合は、引き続き関数名と `WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN` を含むエラーを throw する。通常の Phase2 A 成功テストは backstop が発火しないことに加え、evaluator spy / residual AST 検査で相対日付評価回数0を直接証明する。

## 6. KORDER / DML / JOIN 後残余の境界

| 面 | Phase2 A | 理由 |
|---|---|---|
| 単一物理 APP SELECT の FULL_SCAN prefilter | **許可** | server exact relative leaf と client residual の順で元 WHERE と同値にできる |
| `KORDER_NATIVE` / `KORDER_CURSOR` | **拒否維持** | residual filter が件数・LIMIT到達・順序計画を変え、KORDER の SIMPLE + WHERE exact 前提を満たさない |
| UPDATE / DELETE target selection | **拒否維持** | mutation対象集合は既存 DML converter が WHERE 全体 exact で確定する契約を維持する |
| SELECT-based DML source | **対象外** | source SELECT と mutation副作用境界を Phase2 A で同時に広げない |
| JOIN 後 residual / table別 prefilter | **対象外** | leaf の所属・外部結合の null-extension・結合後 truth を別途証明する必要がある |
| VALIDATE | **対象外** | 現行は prefilter 後に元 WHERE 全体を `evalWhere` する |
| サブテーブル / temp / materialized CTE | **対象外** | 相対日付 server-only の評価主体となる一意な物理 query を保証しない |

KORDER や DML で「一度多く取得して residual で減らす」fallback を暗黙に追加してはならない。これらは Phase B で、それぞれの limit、order、confirm、mutation 0、SearchAbortedError 契約まで含めて別仕様化する。

## 7. EXPLAIN

EXPLAIN は実行と同じ decomposition plan を共有し、フォームメタデータ以外の records / cursor / mutation API を呼ばない。eligible plan は少なくとも次を表示する。

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

複数関数は各 function / field / operator を列挙し、合成した server prefilter と client residual をそれぞれ1回表示する。`residualWhere = null` の Phase1 exact case は従来どおり `EXACT_PUSHDOWN` / `client evaluation: forbidden` 表示を維持し、無理に `SUPERSET_PREFILTER` へ変更しない。

拒否計画は実行可能な query と誤認される表示をせず、関数名、path、`WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN` と、該当する field / operator / context reason を表示する。EXPLAIN と execution で decomposition・capability・reason が一致しなければならない。

## 8. 面（Node / CLI / MCP / plugin）

分解は core の共有 planner で1回だけ行い、surface ごとの分岐を設けない。

| 面 | 必須契約 |
|---|---|
| Node API | 共有 plan の prefilter / residual を使用し、相対日付 client 評価0 |
| CLI | Node と同一 query、結果、EXPLAIN、reason |
| MCP | Node と同一 query、結果、EXPLAIN、reason。tool schema / instructions に独自の許可条件を持たない |
| Firefox / Chrome plugin | 同一 SQL・同一 app metadata で同じ query と結果。browser clock / timezone を参照しない |

server-side relative date のタイムゾーン、週境界、月末、繰越意味論は Phase1 のまま kintone に所有させる。4面の時刻差・locale 差は結果へ影響してはならない。

## 9. 受入条件（テスト化）

### 9.1 正例

- `更新日時 >= YESTERDAY() AND LENGTH(都道府県) > 1` は query に `更新日時 >= YESTERDAY()` を出し、取得後は `LENGTH(都道府県) > 1` だけを評価する。
- 上記の初回 records GET は、現行 `fetchAll` の paging suffix を含めて `更新日時 >= YESTERDAY() order by $id asc limit 500 offset 0` を生成する。後続ページも同じ base predicate に `$id` keyset / offset / limit だけを加える。相対日付 evaluator 呼出し0、residual AST 内の相対日付 occurrence 0、backstop 未発火。
- `相対日付 exact AND 通常 LIKE` は相対日付を prefilter＋除去し、通常 LIKE は residual で JavaScript 評価する。
- `相対日付 exact AND KLIKE AND 通常 LIKE` は、既存 KLIKE identity / `appliedKlikes` 契約を維持し、通常 LIKEだけを残余評価し、相対日付は評価0。
- 相対日付 exact leaf が複数ある場合、すべてを AND した query を出し、すべてを residual から除去する。
- 相対日付 exact AND「相対日付を含まない OR residual」は許可し、OR subtree 全体を client 評価する。
- 既存 Phase1 の WHERE 全体 exact case は `EXACT_PUSHDOWN`、元 query、client evaluator 0のまま挙動不変。

### 9.2 拒否・backstop

- 相対日付が OR の任意の枝にある形、NOT 配下、非 exact operator / type / context は records API 前に拒否する。
- prefilter serialize 失敗、関数名の query 欠落、relative occurrence が残余に残る test seam は取得前拒否する。
- KORDER と「相対日付 exact＋非押し下げ残余」は native / cursor とも拒否し、cursor作成0。
- UPDATE / DELETE / SELECT-based DML、JOIN後残余、VALIDATE、サブテーブル、materialized CTE / temp は Phase2 A として許可せず、mutation / confirm 0。
- planner を意図的に bypass して相対日付 node を `evalWhere` へ渡すと、引き続き `WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN` で throw する。
- kintone が relative date query を REST error にした場合、空 query / FULL_SCAN / client clock 評価へ retry しない。

### 9.3 非回帰・4面

- `TODAY()` / `NOW()` / `LOGINUSER()` の parse、query、client evaluator の既存3 caseを変更しない。
- 相対日付を含まない B32 capability / reason matrix、LIKE-only residual、既存 safe-leaf prefilter、KLIKE-only exact / identity を回帰する。
- Node / CLI / MCP / Firefox plugin / Chrome plugin で、同じ SQL の prefilter query、residual結果、EXPLAIN、拒否 reason が一致する。
- maxRecords / complete-input / SearchAbortedError の既存 fail-closed を維持し、prefilter 取得の途中打切りによる部分結果を返さない。

## 10. Phase B 引き継ぎ（対象外）

- KORDER と residual filter を両立する scan / limit / ordering 契約。
- DML target selection の superset＋residual、confirm件数、mutation 0、SearchAbortedError、VALIDATE ONLY の副作用境界。
- INNER / LEFT / RIGHT JOIN の table別 relative prefilter と、null-extension 前後の leaf 除去証明。
- VALIDATE の residual-only 評価、サブテーブル、temp / materialized CTE / 派生表。
- 相対日付を含む OR / NOT の安全な論理分解。DNF 化や複数 REST query の集合演算を行う場合は取得上限・重複排除も別途固定する。
- 相対日付関数の client 評価。kintone と同じ server calendar semantics を公式根拠と実機で固定できるまで実装しない。

## 11. 工数見積り

Phase2 A の概算は **5〜8人日**。

| 作業 | 目安 |
|---|---:|
| AND-only decomposition、relative leaf exact 検証、residual AST surgery | 1〜1.5人日 |
| capability / relativeDatePushdownGuard の第2許可形 | 0.75〜1.25人日 |
| FULL_SCAN fetch と residual input の分離、LIKE / KLIKE identity維持 | 1〜1.5人日 |
| EXPLAIN と reason 整合 | 0.5〜0.75人日 |
| unit / integration / negative / backstop テスト | 1〜1.5人日 |
| CLI / MCP / Firefox / Chrome smoke、docs同期 | 0.75〜1.5人日 |

主要リスクは、(a) prefilter に採用した leaf と residual から除去する leaf の対応ずれ、(b) KLIKE object identity の破壊、(c) 元 `stmt.where` を参照する隠れた FULL_SCAN 経路、(d) capability だけを緩めて KORDER / DML / VALIDATE まで誤って開くことである。

## 12. 判断論点の決着表

| # | ブリーフの判断論点 | R1 の決着 |
|---:|---|---|
| 1 | 残余から相対日付 leaf を除去 | **除去する。** server query に採用・serialize確認済みの exact relative leafだけを `TRUE` に畳み、clientで再評価しない。通常 LIKE は残余でJS評価する（§2〜§4）。 |
| 2 | AND限定・exact限定・OR | **AND spine上のPhase1 exact leafだけ。** 相対日付がOR / NOTに絡む形は拒否維持。相対日付を含まないOR residualは許可（§3）。 |
| 3 | backstop | **維持する。** 成功経路はresidual内の相対日付0件をplannerとテストで証明し、漏れた場合は既存throwでfail-closed（§5.4、§9.2）。 |
| 4 | 既存 prefilter 経路への組込み | **相対日付専用 decomposition を隣接追加する。** `extractSafePushdownLeaves` 自体の責務・allowlistは広げず、その結果とrelative exact leavesを合成した不可分planを作る（§3.3、§5.3）。 |
| 5 | capability / plan gate | eligible混在WHEREは `SUPERSET_PREFILTER`。構造・面・serialize・residual 0件まで確認したplanだけPhase1拒否を緩和し、一般capabilityだけでは許可しない（§5.1〜§5.2）。 |
| 6 | KORDER / DML / 範囲 | **単一物理APP SELECTのFULL_SCAN prefilterだけ。** KORDER、DML、JOIN後残余、VALIDATE、サブテーブル、materialized sourceは拒否 / 対象外（§1、§6）。 |
| 7 | EXPLAIN | server exact prefilter、client residual、各relative leaf、`relative date client evaluations: 0` を実行と同じplanから表示（§7）。 |
| 8 | 4面一致 | core共有planをNode / CLI / MCP / Firefox / Chrome pluginが共用し、query・結果・EXPLAIN・reasonを一致させる（§8、§9.3）。 |

## 13. R1 時点の未解決論点

Phase2 A の公開意味論とブリーフの8論点に未決はない。実装着手前レビューでは、次の非意味論的詳細だけを確定する。

1. 共有 plan / helper / `FullScanInput` field の最終的な識別子名。
2. EXPLAIN の空 residual 表記を `(none; server exact)` とするか、Phase1 exact 表示へ完全に委ねるか。
3. browser smoke に使用する物理 app / field と、相対日付境界を跨がず再現可能な fixture。

KORDER、DML、JOIN、VALIDATE、OR / NOT、client相対日付評価は未決ではなく、Phase2 A では明示的に対象外と決着済みである。

## 14. R2 決着（§13 の非意味論 3 点）

いずれも公開意味論に影響しない実装詳細であり、R2 で次に固定する。

### 14.1 共有 plan / helper / 入力 field の識別子名

- 分解 plan object: `RelativeDatePrefilterPlan`。field は §3.3 の列挙どおり `prefilterWhere` / `residualWhere` / `exactRelativeLeaves` / `relativeFunctionNames` / `appliedKlikes` / `capability` / `reasons`。EXPLAIN と実行が共有する不可分オブジェクトとし、prefilter と residual を別々に再解析する経路は作らない（§3.3・§5.3）。
- 分解 helper: `decomposeRelativeDatePrefilter(stmt, formMeta)`（core の共有 planner）。`extractSafePushdownLeaves` の責務・allowlist は変更せず、その結果と relative exact leaves を合成する隣接関数として置く（§12 論点4）。
- FULL_SCAN 入力: `FullScanInput.residualWhere`（optional）。未設定時は従来どおり `stmt.where` を filter 入力とし、Phase2 A の plan が成立したときだけ `residualWhere` を明示的に渡す。元 statement は破壊的変更しない（§5.3）。
- guard 第2許可形: `relativeDatePushdownGuard` 内の `allowRelativeDatePrefilterPlan(plan)`。§5.2 の全条件（single-app FULL_SCAN・no JOIN/subtable/materialized・no KORDER・SUPERSET_PREFILTER・AND-only 分解成功・prefilter serialize 成功・residual client 評価可・residual 内相対日付 occurrence 0）を満たすときだけ Phase1 拒否理由を実行拒否に用いない。

### 14.2 空 residual の EXPLAIN 表記

新表記（`(none; server exact)` 等）は追加せず、**Phase1 exact 表示へ委任する**。SUPERSET_PREFILTER ケースは §2.1 の定義上 `R`（相対日付を含まない client 評価残余）が必ず存在するため residual は非 null であり、空 residual になるのは相対日付 leaf だけの純 exact（Phase1）ケースに限られる。その場合は従来どおり `EXACT_PUSHDOWN` / `client evaluation: forbidden` を表示し、SUPERSET_PREFILTER へ昇格させない（§7 と一致）。EXPLAIN が `SUPERSET_PREFILTER` を表示するときは常に `client residual` 行が1つ以上ある。

### 14.3 browser smoke fixture 方針

- 相対日付境界を跨いでも結果が変わらない**広い窓**を用いる。既定候補は APP730@dev の `更新日時 >= FROM_TODAY(-3650, DAYS) AND LENGTH(都道府県) > 0`（10年窓で当日実行時刻に依存せず全件が prefilter を通過し、residual の client 評価だけが件数を決める）。
- 検証観点は「同一 SQL・同一 app metadata で Node/CLI/MCP と同じ prefilter query・residual 結果・EXPLAIN・reason」（§8・§9.3）と、browser clock / timezone を参照しないこと。
- 最終的な物理アプリ / フィールドは smoke 実施時にユーザー環境で確定してよい。fixture は境界跨ぎで flaky にならない窓であることだけを要件とする。
