# B76 — JOIN 述語押し下げ Phase B 仕様 R1

- 作成: 2026-07-27（codex）
- ステータス: **R1（Claude レビュー待ち・未実装）**
- 基盤: [Phase A 確定仕様](ksql_b76_join_pushdown_phase_a_spec.md)（v3.26.0）
- 親計画: [B76 実装計画](ksql_b76_join_predicate_pushdown_impl_plan.md) §0.3
- 関連仕様:
  [B67 Phase2 A 計画](ksql_b67_phase2_impl_plan.md) /
  [B72 whole-WHERE exact 仕様](ksql_b72_relative_date_fullscan_exact_spec.md) /
  [B75 CTE・temp 計画](ksql_b75_relative_date_cte_temp_impl_plan.md) /
  [B77/B78 server-only 関数仕様](ksql_b77_b78_kintone_function_fail_closed_spec.md) /
  [B79 検索打ち切り](ksql_b79_outer_join_search_abort_issue.md)

## 1. 目的

INNER JOIN を含む SELECT でも、WHERE 内の kintone server-only 15 関数を
kintone records API へ確実に適用し、client 評価を 0 にした計画だけを許可する。

対象は次の 15 関数である。

- 相対日付 12 関数:
  `YESTERDAY()`、`TOMORROW()`、`FROM_TODAY()`、`THIS_WEEK()`、`LAST_WEEK()`、
  `NEXT_WEEK()`、`THIS_MONTH()`、`LAST_MONTH()`、`NEXT_MONTH()`、
  `THIS_YEAR()`、`LAST_YEAR()`、`NEXT_YEAR()`
- legacy kintone function 3 関数:
  `TODAY()`、`NOW()`、`LOGINUSER()`

Phase B は Phase A の `JoinPushdownPlan`、field ownership 解決、E-S-U classifier、
serializer ownership guard、KLIKE node identity を拡張利用する。別の JOIN pushdown 系を
新設せず、Phase A の通常述語 pushdown と同じ plan / fetch を使う。

本仕様の核心は、同じ WHERE の中で次の非対称を安全に成立させることである。

| predicate | server prefilter | client residual |
|---|---|---|
| 通常述語 | Phase A の E/S なら採用可 | **元の述語を残す** |
| server-only 関数を持つ predicate | **exact のときだけ採用可** | **採用した単位を除去する** |

## 2. 不変条件

### 2.1 client 評価 0

server-only 関数 occurrence を持つ文を成功させる必要十分条件は、全 occurrence が次のいずれかで
同一の immutable plan により消費されることである。

1. 第5-L許可形の exact leaf として、対象 APP の server query に直列化され、同じ leaf が
   residual から除去される。
2. 第5-W許可形の whole-WHERE exact として、WHERE 全体が対象 APP の server query に
   直列化され、client residual が `null` になる。

成功計画では、residual AST に server-only 関数 occurrence が **0** でなければならない。
`evalWhere()` の backstop を成功経路として使わない。

### 2.2 全 occurrence の原子的採用

WHERE に複数の server-only 関数 occurrence がある場合、**全 occurrence を採用できるか、
文全体を records API 前に拒否するかの二択**とする。

- 一部だけを server へ送り、残りを client に落とさない。
- serializer 失敗時に空 query / 全件取得へ retry しない。
- 関数名が同じ leaf が複数ある場合も occurrence multiset で照合する。
- main APP だけ成功し JOIN APP の関数が失敗する、といった部分実行をしない。

### 2.3 exact の意味

Phase B の「関数 leaf exact」は、Phase A の通常 literal predicate に対する
server/JS 同値ではない。server-only 関数には正当な JS 評価が存在しないため、次をすべて
証明した契約を指す。

1. B77/B78 の field type × operator × function classifier が `EXACT_PUSHDOWN`。
2. leaf の全 field が単一の物理 APP / alias に `OWNED`。
3. serializer ownership guard を通り、生成 query に対象関数 occurrence が同数存在する。
4. その query が実際に対象 APP の records fetch に使われる。
5. 採用した同一 leaf、または whole WHERE が residual から完全に消費される。
6. residual の再 walk で server-only occurrence が 0。

`whereCapability.EXACT_PUSHDOWN` **だけ**、`JoinPushdownPlan` **が存在することだけ**、
または関数名 regex **だけ**では exact の証明にならない。

## 3. スコープ

### 3.1 対象

- SELECT の **INNER JOIN**。
- main table と全 JOIN table が、alias を持つ直接の物理 APP。
- Phase A と同じく、変数・subquery 解決後の effective SELECT AST。
- 第5-L許可形:
  top-level AND spine 上にある、単一 alias の exact server-only 関数 leaf。
- 第5-W許可形:
  WHERE 全体が単一 alias に属し whole-WHERE exact と証明できる形。
- 関数 leaf が main APP、JOIN APP、または複数の物理 APP に分散する形。
- 通常述語の Phase A pushdown と residual 維持。
- GROUP BY、集計、DISTINCT、window、local ORDER 等、既存 FULL_SCAN 後段処理。

### 3.2 明示的な対象外

- LEFT / RIGHT JOIN。B6 の nullability provenance 領域を再オープンしない。
- materialized CTE、temp table、subtable virtual table、derived / synthetic source を
  server-only 関数の target とすること。
- DML、DML source SELECT、VALIDATE、REORDER、KORDER の JOIN 能力拡張。
- cross-table binary に server-only 関数を組み込む形。
- cross-alias `OR` に server-only 関数が入る形。
- 第5-L許可形で `OR` / `NOT` の内側から関数 leaf だけを抜き出すこと。
- `superset` の server-only 関数 leaf。
- LOGINUSER と literal の混在 IN list、複数 LOGINUSER、または singleton 以外の IN list。
- Phase A の通常 literal predicate の residual 除去。
- 新しい server-only 関数、型、演算子の追加。

inline CTE が direct physical APP の JOIN へ変換される経路は、Phase A §7.3 と同じく
effective AST と node identity の別証明がないため Phase B R1 の対象外とする。

## 4. 第5許可形

第5許可形は、目的の異なる2バリアントを一つの JOIN server-function allow-form として扱う。
guard / runtime / EXPLAIN は `allowForm: "JOIN_SERVER_FUNCTION_EXACT"` 相当の明示 marker と、
次の variant を plan に保持する。mode や nullable residual から後付け推測しない。

### 4.1 第5-L — exact leaf adoption

B67 Phase2 A の「exact leaf 採用＋残余除去」を、INNER JOIN の各物理 APP fetch へ適用する。

```sql
WHERE a.受注日 = THIS_MONTH()
  AND LENGTH(a.件名) > 1
  AND t.有効日 >= TODAY()
```

概念上の計画:

```text
APP100/a server: a.受注日 = THIS_MONTH() [exact]
APP200/t server: t.有効日 >= TODAY()      [exact]
client residual: LENGTH(a.件名) > 1
server-only function client evaluations: 0
```

規則:

1. `GROUP` を透過しつつ top-level `AND` だけを分解する。
2. server-only occurrence を持つ `BINARY` leaf は §5 の専用 exact matrix を通す。
3. leaf 単位の ownership、serialize、occurrence multiset を確認する。
4. 同じ leaf identity を server query への採用集合と residual 除去集合に使う。
5. 関数を含まない通常述語は Phase A の規則で E/S prefilter に追加できるが residual に残す。
6. KLIKE は AND spine 上なら既存 `appliedKlikes` identity 契約を維持して共存できる。
7. 全関数 leaf を除去した residual が `null` でもよい。

第5-L は「駆動表だけ」に限定しない。INNER JOIN では main / JOIN の各物理 source に属する
AND 因子を、その source の fetch 前に適用できる。複数 APP へ分散した場合は alias ごとに
server predicate を合成し、全 alias の plan を records API 前に確定する。

### 4.2 第5-W — single-alias whole-WHERE exact

B72/B75 の whole-WHERE exact を、INNER JOIN 文の単一物理 alias に属する WHERE へ広げる。

```sql
WHERE a.受注日 = THIS_MONTH() OR a.受注日 = LAST_MONTH()
```

許可条件:

1. WHERE の全 field が同じ `OWNED(alias, appId, fieldCode)` に解決される。
2. WHERE 全体が `EXACT_PUSHDOWN`。
3. WHERE 全体を serializer ownership guard 後に直列化できる。
4. 全 server-only occurrence と全 KLIKE occurrence が serialized whole WHERE に存在する。
5. serialized whole WHERE をその alias の records fetch に実際に使う。
6. client residual は `null`。

target は main alias に限らず JOIN alias でもよい。WHERE 全体が JOIN alias `t` にだけ属するなら
APP `t` の fetch に whole WHERE を適用する。

第5-W は同一 alias の exact `OR` / `GROUP` / exact `NOT` を許可する。これは関数 leaf だけを
`OR` / `NOT` から抜く規則ではなく、**whole WHERE を一単位で server 適用し、residual 全体を
消費する規則**である。whole-WHERE capability が exact でない場合は許可しない。

### 4.3 両バリアントの優先順

1. 既存第1〜第4許可形を従来どおり評価する。
2. `joins.length > 0` かつ全 JOIN が INNER のときだけ第5許可形を評価する。
3. 第5-W が成立する場合は whole WHERE を一度だけ送り、同じ leaf を第5-L と重複採用しない。
4. 第5-W が不成立なら第5-L を評価する。
5. 第5-L でも全 server-only occurrence を消費できなければ既存 requires-exact reason で拒否する。

この優先順は optimizer の偶然の mode や plan の存在ではなく、whole-WHERE exact /
AND-spine exact leaf / ownership / occurrence という意味的条件に直接結び付ける。

## 5. 型 × 演算子 × exact / superset / unsafe

### 5.1 Phase B 専用 matrix

次だけを関数 leaf `exact` とする。比較6演算子は `=`、`!=` / `<>`、`<`、`>`、`<=`、`>=`。

| field type | function | operator / RHS shape | Phase B relation |
|---|---|---|---|
| DATE | 相対日付12 / `TODAY()` | 比較6 | exact |
| DATETIME | 相対日付12 / `TODAY()` / `NOW()` | 比較6 | exact |
| CREATED_TIME | 相対日付12 / `TODAY()` / `NOW()` | 比較6 | exact |
| UPDATED_TIME | 相対日付12 / `TODAY()` / `NOW()` | 比較6 | exact |
| CREATOR | `LOGINUSER()` | singleton `IN` / `NOT IN` | exact |
| MODIFIER | `LOGINUSER()` | singleton `IN` / `NOT IN` | exact |
| USER_SELECT | `LOGINUSER()` | singleton `IN` / `NOT IN` | exact |
| その他の型・関数・operator・shape | — | — | unsafe |

相対日付関数の引数検証は B67/B77 の既存規則をそのまま使う。`TIME`、`RECORD_NUMBER`、
`$id`、文字列、選択系、`ORGANIZATION_SELECT`、`GROUP_SELECT` を新たに許可しない。

### 5.2 Phase A §5.2 との関係

Phase A §5.2 の literal matrix から server-only 関数 leaf の residual 除去可能性を
導いてはならない。

- DATE / DATETIME / CREATED_TIME / UPDATED_TIME の literal `=` は Phase A では `S`。
  これは通常 predicate を residual に残すための分類で、関数 leaf 除去の根拠にならない。
- CREATOR / MODIFIER は Phase A では全て `U` で、明示的に「LOGINUSER は Phase B」。
- USER_SELECT も Phase A では全て `U`。
- KLIKE の `E†` は既存 server-only exact 契約であり、Phase B の関数 matrix と AND で共存できる。

したがって、Phase A §5.2 のうち Phase B が直接再利用する exact 行は KLIKE `E†` 等の
**関数を含まない併存 predicate**である。関数 leaf 自体は B77/B78 の公式型・演算子契約を
固定した本節の専用 matrix で exact とする。

### 5.3 superset は採用不可

server-only 関数 leaf を `superset` として押し下げ、residual から除去してはならない。

`K` を server predicate の一致集合、`J` を元 predicate の一致集合とすると、
`K ⊃ J` では false positive が残る。通常述語なら residual が除外できるが、server-only 関数は
client 評価禁止なので residual を残せない。

```text
superset + residual除去  = false positive を返し得る
superset + residual維持  = client 評価禁止に違反
```

両立する第三案はない。よって関数 leaf は exact でなければ第5許可形へ採用しない。
通常述語は従来どおり superset prefilter＋residual を維持できる。

注意: alias ごとの合成 server query 全体は、通常 `S` predicate を AND するため
`relation: superset` になり得る。この場合も、**その中の関数 leaf は leaf 単位で exact**であり、
通常 `S` predicate は residual に残る。item relation と関数消費 relation を混同しない。

## 6. tree 合成と residual surgery

### 6.1 合成表

| AST | server-only 関数を含む場合の規則 |
|---|---|
| `A AND B` | 第5-L では各 exact 関数 leafを alias ごとに採用し、その leaf だけ residual から除去。通常 predicate は残す |
| `A OR B`（同一 alias） | 第5-W で **whole WHERE 全体**が exact の場合だけ許可。第5-L で片辺や leaf だけを採用しない |
| cross-alias `OR` | 文全体を requires-exact で拒否。片側 APP へ押さない |
| `GROUP(A)` | AND spine / whole-WHERE の構造を保持して透過 |
| `NOT(A)` | 第5-W の whole-WHERE exact の場合だけ許可。第5-L で内側 leaf を抜かない |
| cross-table binary | 関数 occurrence を含まなければ通常 residual。関数を含む shape は拒否 |
| EXISTS / nested SELECT | node ごとの既存 guard を維持。外側 JOIN planへ混ぜない |

### 6.2 residual surgery の単位

第5-L では、採用 leaf を `TRUE` とみなして **AND spine だけ**を簡約する。

```text
F_exact AND R       -> R
R AND F_exact       -> R
F1_exact AND F2_exact -> null
GROUP(F_exact AND R)  -> GROUP(R) または同値な最小構造
```

`OR` / `NOT` の内部では置換しない。非関数 node は clone / reparse せず、既存 object identity を
維持する。親 `AND` / `GROUP` の必要最小限の再構成だけを許す。

第5-W は surgery を行わず `residualWhere = null` とする。

### 6.3 KLIKE との整合

現行 `evalWhere()` には2種類の server-only backstop がある。

- applied KLIKE: `appliedKlikes.has(node)` なら行ごとに無条件 `true`
- 15関数: client 到達時に requires-exact reason で **throw**

15関数は KLIKE のように `true` を返さない。しかし client 再評価不能という根は同じであり、
関数 leaf を残した `OR` residual は成功できない。

- 第5-L の AND spine では、関数 leafは residual から消え、KLIKE は同一 plan の
  `appliedKlikes` で既存どおり消費されるため共存可。
- 関数を含む同一 alias OR は、第5-W で whole WHERE を exact に server 適用し
  residual を `null` にする場合だけ可。
- 第5-W の whole WHERE に KLIKE を含める場合、全 KLIKE occurrence を同じ serialized query と
  `appliedKlikes` に結び付ける。residual は存在しないため Phase A §5.5 の
  `true OR false` 問題は起きない。
- whole exact でない KLIKE-containing OR は Phase A §5.5 どおり非採用で、関数があれば文を拒否。

## 7. ownership・複数 APP・serializer

### 7.1 ownership

Phase A §6 の3値解決を変更しない。

| 解決 | Phase B |
|---|---|
| `OWNED(alias, appId, fieldCode)` | exact matrix の候補 |
| `AMBIGUOUS` | 関数 occurrence があれば文を拒否 |
| `UNKNOWN` | 関数 occurrence があれば文を拒否 |

非修飾 field は全 JOIN source のうち実在先がちょうど1つの場合だけ採用する。
alias を除去する `whereToKintone()` に ownership 判定を委ねない。

### 7.2 複数 APP

```sql
WHERE a.受注日 = THIS_MONTH()
  AND t.更新日時 >= FROM_TODAY(-7, DAYS)
  AND a.担当者 = t.担当者
```

- APP `a`: `受注日 = THIS_MONTH()`
- APP `t`: `更新日時 >= FROM_TODAY(-7, DAYS)`
- residual: `a.担当者 = t.担当者`

のように alias ごとに計画する。全 item を serialize・検証してから最初の records API を呼ぶ。
1 item でも失敗したら全体を拒否する。

### 7.3 serializer 安全規則

各関数 consumption は最低限、次を同一 plan に保持する。

```ts
interface JoinServerFunctionConsumption {
  readonly targetAlias: string;
  readonly appId: number;
  readonly predicate: WhereExpr; // 元 leaf または元 whole WHERE
  readonly functionLeaves: readonly BinaryExpr[];
  readonly functionOccurrences: readonly string[];
  readonly relation: "exact";
  readonly consumption: "leaf" | "whole-where";
  readonly serializedPredicate: string;
}
```

`JoinPushdownPlan` は既存 `items` / `appliedKlikes` / `allKlikes` / `rejections` に加え、
明示的な `serverFunctionConsumptions`、`residualWhere`、allow-form variant、
全 occurrence / adopted occurrence を持つ。候補検出後に別々のロジックで
server query と residual を再構成しない。

serializer 直前に Phase A §6.2 の ownership guard を実行し、直列化後に関数 occurrence
multiset と KLIKE 適用集合を確認する。引数や `allowUnresolvedVariables`、source-kind、
outer-join flag を黙って無視しない。

## 8. guard・計画生成・runtime

### 8.1 既存 guard への追加

`relativeDatePushdownGuard.ts` の既存第1〜第4許可形にある `joins.length === 0` を
削除・緩和しない。既存形は無変更で回帰させる。

その後に、独立した第5許可分岐を追加する。

```text
has server-only occurrence
AND SELECT
AND joins.length > 0
AND every join is INNER
AND every source is aliased direct physical APP
AND resolved JoinPushdownPlan.allowForm == JOIN_SERVER_FUNCTION_EXACT
AND all occurrences adopted
AND residual occurrences == 0
AND every adopted predicate serialized and wired to its target fetch
=> allowed
```

`"joinPlan" in plan`、`items.length > 0`、FULL_SCAN であること等の間接条件で許可しない。
第5許可形専用の意味的 predicate（例 `allowJoinServerFunctionPlan(plan)`）を unit test 可能な
pure function として持つ。

### 8.2 一つの immutable plan

変数・subquery 解決と全 APP metadata 取得後に一度だけ生成した `JoinPushdownPlan` を、
次が共有する。

- relative/server-function guard と fail-closed gate
- main / JOIN records fetch
- alias ごとの serialized query
- `appliedKlikes`
- `residualWhere`
- `runFullScan()`
- EXPLAIN renderer

guard 用に関数 leaf を抽出し直したり、EXPLAIN 専用 plan を安全判定の真実にしたりしない。

### 8.3 runtime 配線

1. parser / CTE 既存処理
2. batch scalar/list variable 解決
3. IN / scalar subquery 解決
4. effective SELECT AST 確定
5. 全物理 APP の field schema / optionOrder / STATUS metadata 取得
6. Phase B 対応 `JoinPushdownPlan` 生成
7. guard、ownership、serialize、occurrence、unapplied KLIKE、residual occurrence を全検証
8. alias ごとの records fetch
9. INNER JOIN
10. `plan.residualWhere` だけを client 評価
11. GROUP / aggregate / DISTINCT / window / ORDER / LIMIT

`runFullScan()` には第5許可形で `residualWhere` を明示する。`undefined` を従来の
`stmt.where`、`null` を filter 不要として区別し、`??` で `null` を潰さない。

guard を開く merge と、fetch / `residualWhere` / `appliedKlikes` の実行配線は
**同一 merge 必須**である。guard だけ先行して client backstop へ到達する中間状態を作らない。

## 9. LOGINUSER()

JOIN でも B78 と同じ次の形を許可する。

```sql
a.作成者 in (LOGINUSER())
t.更新者 not in (LOGINUSER())
a.ユーザー選択 in (LOGINUSER())
```

条件:

1. field ownership が単一の物理 alias に `OWNED`。
2. field type は `CREATOR` / `MODIFIER` / `USER_SELECT`。
3. operator は `IN` / `NOT IN`。
4. RHS は `LOGINUSER()` だけを持つ singleton `IN_LIST`。
5. `LOGINUSER()` が引用されず同じ byte で target APP query に存在する。
6. leaf または whole WHERE が residual から消費される。

`CREATOR = LOGINUSER()`、`GROUP_SELECT in (LOGINUSER())`、literal 混在、
複数要素 list、client `typedInContains()` は許可しない。失敗時は
`WHERE_KINTONE_FUNCTION_FIELD_TYPE_UNSUPPORTED` /
`WHERE_KINTONE_FUNCTION_OPERATOR_UNSUPPORTED` /
`WHERE_KINTONE_FUNCTION_CONTEXT_UNSUPPORTED` の具体 reason と
`WHERE_KINTONE_FUNCTION_REQUIRES_EXACT_PUSHDOWN` を保持する。

## 10. limits・truncate・検索打ち切り

### 10.1 `maxRecords` / `onLimit=truncate`

Phase B 固有の complete-input reason や `onLimit=truncate` 禁止を追加しない。
同じ JOIN query の server-only 関数を、同じ server 一致集合を表す literal predicate に
置き換えた場合と同じ既存 policy に従う。

`maxRecords` は alias ごとの server predicate 適用後候補に作用する。truncate 時の性質は
処理段階で区別する。

| 段階 | truncate / 不完全取得の影響 |
|---|---|
| raw INNER JOIN rows | 返った tuple 自体は predicate を満たす。起きるのは true row の欠落 |
| aggregate / GROUP BY | `SUM` / `COUNT` / `AVG` 等が過小・不正確な**誤った派生値**になり得る |
| DISTINCT / window / local ORDER / LIMIT | 順位、代表集合、top-N 等が完全入力時と異なり得る |

したがって「関数 leaf を residual から除去したから truncate が誤値を作る」のではない。
不完全入力を後段処理へ渡す既存契約の性質である。Phase B はそれを拡大も隠蔽もせず、
既存 complete-input policy と warning / error をそのまま適用する。EXPLAIN は既存 limit policy を併記する。

### 10.2 `searchAborted`

B79 v3.27.0 の現行契約を維持する。

- LEFT / RIGHT JOIN: plugin / CLI / MCP は fail-closed。Phase B はそもそも対象外。
- INNER JOIN: plugin / CLI / MCP は警告＋部分結果を維持する。
- engine library: query shape に関係なく既存 `SEARCH_ABORTED` hard error を維持する。

INNER JOIN の relational tuple 層では true row の欠落にとどまるが、その不完全集合から
集計・window・top-N を作れば派生値は不正確になり得る。Phase B の plan の存在や関数採用を理由に
INNER JOIN だけ新たに fail-closed にしない。これは Phase A §16 で撤回済みの非対称を
再導入するためである。

`searchAborted`、limit、REST error 後に空 query、関数除去前 residual、client 関数評価へ
retry しない。

## 11. EXPLAIN

EXPLAIN は runtime と同じ metadata-resolved `JoinPushdownPlan` から表示する。
static metadata 未解決時は `candidate` とし、`applied` / evaluation 0 を断言しない。

alias ごとの表示必須項目:

- target alias / APP
- `pushdown applied`
- server predicate
- item relation (`exact` / `superset`)
- adopted server-function leaf と leaf relation (`exact`)
- consumption (`leaf` / `whole-WHERE`)
- client residual
- KLIKE applied / unapplied count
- 非採用 reason

例:

```text
join pushdown plan: applied (runtime metadata resolved)
allow form: JOIN_SERVER_FUNCTION_EXACT (leaf)

app: APP100 AS a
pushdown applied: 受注日 = THIS_MONTH()
relation: exact
relative date function: THIS_MONTH
relative date evaluation: kintone server exact JOIN prefilter

JOIN: APP200 AS t
pushdown applied: 作成者 in (LOGINUSER()) and 区分 in ("有効")
relation: exact
kintone function: LOGINUSER
kintone function evaluation: kintone server exact JOIN prefilter

client residual: LENGTH(a.件名) > 1
relative date client evaluations: 0
kintone function client evaluations: 0
```

相対日付と legacy 3関数が同じ文に混在する場合は、両方の 0 行を出す。
現行 helper の「全 leaf が相対日付なら relative、それ以外は kintone」という一行選択だけでは
混在を表せないため、関数集合ごとに独立集計する。

rejected plan は対象関数、alias / field、具体 reason、requires-exact reason、
`client evaluation: forbidden`、records/cursor API 0 を表示する。

## 12. 実装 Step

Phase A の成果を再設計せず、次の5 Step とする。

| Step | 内容 | 同一 merge / gate | 見積もり |
|---|---|---|---:|
| 1. 第5-L plan decomposition | `JoinPushdownPlan` に関数 consumption、occurrence multiset、AND-spine residual surgery を追加。B77 matrix と Phase A ownership / E-S-U / KLIKE identity を統合。実行許可はまだ開かない | classifier・採用 leaf・除去 leaf・serializer確認を同じ plan に固定。pure unit test | 1.0〜1.5 人日 |
| 2. 第5-L guard＋runtime 原子的配線 | `relativeDatePushdownGuard` に第5-Lを追加し、main/JOIN fetch、`residualWhere`、`appliedKlikes`、records API 前全件検証へ接続 | **guard allow と fetch/residual 配線は同一 merge必須**。片方だけ先行禁止 | 1.5〜2.0 人日 |
| 3. 第5-W / LOGINUSER / 複数 APP | 第5-W whole exact、同一 alias OR/NOT、LOGINUSER singleton、複数 alias 関数、KLIKE 共存と負例を完成 | **第5-Wの guard allow・whole-WHERE fetch・residual null・全 occurrence消費を同一 merge** | 1.0〜1.5 人日 |
| 4. EXPLAIN・limits・4面回帰 | runtime plan renderer、混在2種の評価0、truncate / searchAborted / complete-input、配布面 reason parity | EXPLAIN専用再計画禁止。runtime plan と renderer を同じ merge | 0.75〜1.25 人日 |
| 5. docs・smoke・release gate | language reference、README/MCP resource、CLI/MCP/plugin/engine tests、Firefox/Chrome 実機手順、change note | 公開 docs と配布物の契約を同一 release に含める | 0.75〜1.25 人日 |

**合計: 5.0〜7.5 人日（計画値は 5〜8 人日）。**

Phase A は Step 0 調査・仕様 3〜5 人日＋実装 5〜8 人日の合計 8〜13 人日だった。
Phase B は Phase A の ownership / classifier / serializer / runtime plan を再利用できるため小さい。
ただし residual 除去、whole-WHERE variant、15関数の全 occurrence gate があるため、
単純な guard 条件削除として 2〜3 人日には縮めない。

## 13. 受入条件

### 13.1 正例

1. 冒頭例の `a.受注日 = THIS_MONTH()`＋GROUP BY が target APP query に入り、正しい集計を返す。
2. main alias の相対日付、JOIN alias の `TODAY()`、別 alias の `LOGINUSER()` を
   同一文で採用し、全関数 client 評価 0。
3. 複数同名関数 occurrence を multiset どおり全て serialize・消費する。
4. exact 関数 leaf＋通常 `S` predicate では item relation は superset、通常 predicate は residual、
   関数 leafは residual から除去される。
5. exact 関数 leaf＋local predicate では local predicate だけが residual。
6. 複数 alias の AND 等で第5-Wが不成立でも、全 WHERE がexact関数 leafだけなら
   第5-Lで residual `null`。
7. 同一 alias の whole exact OR / GROUP / exact NOT は第5-Wで queryを一度だけ送り residual `null`。
8. whole exact KLIKE-containing OR は全 KLIKE / 関数 occurrence が適用済みで residual `null`。
9. `CREATOR` / `MODIFIER` / `USER_SELECT` × singleton LOGINUSER `IN` / `NOT IN` を許可。
10. main / JOIN のどちらが target でも同じ意味契約。

### 13.2 residual 安全性

11. 採用関数 leafと residual 除去 leafが同一 identity。
12. successful plan の residual AST に server-only occurrence 0。
13. 通常 predicate の identityを維持し、Phase A どおり residual に残る。
14. KLIKE `appliedKlikes` と fetch predicate が同じ node identity。
15. residual `undefined` と `null` を区別し、null時に元 WHERE を再評価しない。
16. evaluator spy で相対日付・legacy kintone function とも呼出し 0。

### 13.3 負例

17. `superset` 関数 leafは押し下げず、records API前に requires-exact で拒否。
18. 関数を含む non-exact OR、cross-alias OR、関数 leafを内包する非 whole-exact NOT を拒否。
19. 一つでも AMBIGUOUS / UNKNOWN / cross-table / non-APP ownership があれば全 occurrenceを拒否。
20. serializer throw、関数名欠落、occurrence不足・過剰、wrong alias、wrong appIdを全て拒否。
21. 一部 aliasだけeligibleな複数関数文を部分実行せず、全 records API 0。
22. LEFT / RIGHT JOIN、CTE/temp/subtable、DML source、KORDER、VALIDATE は既存 reasonで拒否。
23. `DATE = NOW()`、`TIME = TODAY()`、`CREATOR = LOGINUSER()`、
    `GROUP_SELECT in (LOGINUSER())`、混在 IN list を具体 reason付きで拒否。
24. unapplied KLIKE、residual内関数 occurrence、guard/runtime plan不一致は fail-closed。

### 13.4 B71 / B72 / B75 / Phase A の教訓

25. metadata mock は要求された `fields` だけを返す。選択系 metadata は `optionOrder` を持つ。
26. 初回 records request の `fields` と `query` を同時 assertし、残余・JOIN・出力に必要な fieldを欠落させない。
27. server-only 関数固有の `onLimit=truncate` 禁止や complete-input reasonを追加しない。
28. 同値 literal JOIN query と `maxRecords` / truncate / searchAborted の面別挙動が一致する。
29. `allowUnresolvedVariables`、source-kind、outer-join、residual flag の true / false testを持つ。
30. plan の存在ではなく、全 occurrence採用・exact・residual 0を直接 assertする。
31. KLIKE-containing OR は whole exact＋residual null以外では一律拒否する。

### 13.5 EXPLAIN・surface parity

32. runtime適用後だけ `pushdown applied`、alias / APP、server query、item relation、
    関数 leaf exact、consumption、residualを表示。
33. 相対日付と legacy 関数の混在時も
    `relative date client evaluations: 0` と
    `kintone function client evaluations: 0` を別々に表示。
34. static metadata未解決時は candidate表示に留める。
35. runtimeとEXPLAINの query byte、target alias、adopted occurrence、residualが一致。
36. 実行面 parity（CLI / MCP / Firefox plugin / Chrome plugin）を確認する。
37. 配布面 parity（plugin / CLI / MCP / engine library）では、B80後の契約どおり
    拒否 reason 文字列と records API 0を一致させる。APP profile表記だけ正規化する。

### 13.6 limits・検索打ち切り

38. raw INNER JOIN truncate / searchAborted fixture は誤った tupleを追加せず、true tupleの欠落として扱う。
39. aggregate / window fixtureでは不完全入力から派生値が変わり得ることを明示し、
    既存 warning / complete-input error契約を固定する。
40. INNER JOINだけを Phase B planの存在で新規 fail-closedにしない。
41. LEFT / RIGHT JOINのB79 fail-closed、engine libraryの全形hard errorを無変更で回帰する。
42. limit / searchAborted / REST error後のretry、空query、client関数評価は0。

## 14. docs・テスト・リリース同期

最低限、次を同一 release で監査・同期する。

- `docs/ksql_language_reference.md`
- `README.md` の server-only 関数 / JOIN 記述
- MCP docs resource、tool schema `.describe()`、function catalog
- `scripts/mcp-smoke.mjs`
- CLI / MCP / plugin / engine library の run / EXPLAIN / rejection tests
- Firefox / Chrome 実機 smoke 手順
- changelog / package versions / plugin manifest / release artifact

docs は「JOINなら常に使える」と一般化せず、INNER JOIN・direct physical APP・exact leafまたは
single-alias whole-WHERE exact・client評価0という許可境界を記す。

## 15. スコープ外と将来課題

1. LEFT / RIGHT JOIN の nullability provenance と server-only 関数。
2. arbitrary exact subtree consumption。
   R1 は AND leafか、WHERE全体の2単位だけで、`(exact OR exact) AND other-alias` の
   OR subtreeだけを消費する一般化はしない。
3. cross-alias OR の provenance 分割。
4. KLIKE / server-only 関数に対する取得経路別 match provenance。
5. CTE inline / materialized CTE / temp / subtable source の JOIN target化。
6. LOGINUSER混在 IN list、directory lookupによるliteral user exact証明。
7. 通常 literal predicate の residual 除去。
8. 外部結合と検索打ち切りの追加変更。B79の現行契約を維持する。
9. incomplete-input時の aggregate warning / error契約そのものの再設計。

## 16. 判断に迷った点・実現不可能な組合せ

### 16.1 superset 関数 leaf

`superset＋残余除去` と `superset＋残余維持` は、それぞれ誤結果とclient評価禁止違反になる。
現行契約のまま両立する方法はなく、**exact限定が必須**である。これは設計上の選択ではなく
論理的な制約である。

### 16.2 同一 alias OR

関数 leafだけを OR から抜くことは不可能。一方、B72と同じく whole WHERE 全体を exact に
server適用して residualを無くす形は安全である。このため第5-Wだけを許可し、
arbitrary exact OR subtree consumptionは将来課題とした。

### 16.3 KLIKE-containing OR

元 WHERE residualを残す Phase A 方式では `appliedKlikes` が無条件trueを返して誤結果になる。
whole-WHERE exact＋residual nullならclient evaluator自体を通らないため安全であり、第5-Wだけで
許可した。planが全 KLIKE occurrenceを同じ queryへ適用したことを証明できない場合は拒否する。

### 16.4 truncate / searchAborted

INNER JOINのtuple層では欠落だが、後段集計では派生値が不正確になり得る。
それでもPhase B固有のfail-closedを足すと、同値literal queryとの非対称とPhase A §16の
撤回事由を再発させる。よって本仕様は既存policyを維持し、別課題なしに安全性契約を
拡張したとは主張しない。

### 16.5 実現可能性

本仕様内に実装不能な要求矛盾はない。Phase A planへの residual / consumption拡張と
B67/B72 primitiveの統合で実現可能である。ただし guardだけの緩和、superset関数の採用、
cross-alias ORの部分採用は安全に実現できないため明示的に禁止する。

---

## Claude レビュー（2026-07-27・R1 承認）

**結論: R1 を承認する。実装へ進んでよい。**

### A. §5.3 の不可能性証明が本仕様の核心

```
superset + residual除去  = false positive を返し得る
superset + residual維持  = client 評価禁止に違反
両立する第三案はない
```

**この2行が Phase B の設計を決めている。** 起草依頼時に Claude が
「両立できないなら関数 leaf は exact でなければ押し下げない、という結論になるはず」と
提起した論点に、**明確な証明で答えている**。

Phase A では「迷ったら superset＋残余評価に倒す」を安全弁にしてきたが、
**server-only 関数は残余評価そのものが禁止**なのでこの原則が使えない。
R1 はその制約を正面から扱い、**exact 限定**という結論を導いた。

### B. §2.3 の「exact」再定義が正しい

server-only 関数には**正当な JS 評価が存在しない**ため、Phase A の
「server 集合 ⊇ JS 集合」という枠組みがそのままでは適用できない。
R1 は exact を **6点の契約**（classifier `EXACT_PUSHDOWN` ／ 単一 alias `OWNED` ／
serializer ownership guard ／ occurrence 同数 ／ 実際に fetch へ使用 ／
residual 再 walk で occurrence 0）として定義し直した。

> `whereCapability.EXACT_PUSHDOWN` **だけ**、`JoinPushdownPlan` **が存在することだけ**、
> または関数名 regex **だけ**では exact の証明にならない。

**B76 Phase A の「plan の存在で判定した」失敗が明示的に排除されている。**

### C. §5.3 末尾の区別が重要

> alias ごとの合成 server query 全体は、通常 `S` predicate を AND するため
> `relation: superset` になり得る。この場合も、**その中の関数 leaf は leaf 単位で exact**であり、
> 通常 `S` predicate は residual に残る。**item relation と関数消費 relation を混同しない。**

**この区別を落とすと実装が破綻する。** item が superset だから関数も superset、と
短絡すると §5.3 の禁止に抵触する。実装・レビュー時の最重要チェックポイント。

### D. §6.3 の KLIKE 整合が的確

Phase A §5.5 で見つけた「`KLIKE ∨ superset` の偽陽性行が residual で除去できない」問題は、
**residual 再評価が存在することが前提**だった。R1 はこれを踏まえ:

- **第5-W（whole exact・residual `null`）なら KLIKE を含む `OR` も可**
  — residual が存在しないので `true OR false` 問題が起きない
- **whole exact でない KLIKE-containing `OR` は §5.5 どおり非採用**

**問題の前提を正確に理解したうえで、その前提が消える形だけを開いている。**
機械的に「KLIKE を含む OR は全部禁止」としなかった点が良い。

### E. Claude による独立検証

| 主張 | 検証結果 |
|---|---|
| 15 関数は KLIKE と違い `true` を返さず **throw** する | ✅ `src/engine/evalWhere.ts:291` で `WHERE_KINTONE_FUNCTION_REQUIRES_EXACT_PUSHDOWN` を throw |
| §5.1 の matrix が kintone 公式の型 × 関数表と一致 | ✅ **`DATE` に `NOW()` が無い**、`CREATOR`/`MODIFIER`/`USER_SELECT` は `LOGINUSER()` の singleton `IN`/`NOT IN`、`GROUP_SELECT` は不可 — すべて公式表どおり |

### F. 実装時の留意点

1. **§5.3 末尾の区別**（item relation と関数消費 relation）を実装で明示的に分けること。
   同じ変数名・同じ型で扱うと混同が起きる。
2. **§2.3 の6点契約をすべて検証すること。** 1つでも省くと exact の証明にならない。
   特に「**実際に fetch へ使用**」と「**residual 再 walk で occurrence 0**」は
   静的な判定では代替できない。
3. **既存3許可形の `joins.length === 0` を変更しないこと**（§4 の方針どおり）。
   独立した第5分岐として足す。既存形に回帰を出さない。
4. **`onLimit` の非対称を作らないこと**（B72 の教訓）。§6 の「Phase B 固有の truncate 禁止や
   fail-closed を追加せず、同値 literal query と同じ既存 policy を維持する」を守ること。
5. **B79 との整合**: 外部結合は fail-closed（v3.27.0）。Phase B は INNER JOIN 限定なので
   競合しないが、実装時に外部結合が第5許可形へ紛れ込まないことをテストで固定すること。

### G. 見積もり

5 Step / 5.0〜7.5 人日を妥当と判断する。計画値 5〜8 人日の範囲内。
「単純な guard 解除ではないため 2〜3 人日には縮めていない」という判断も正しい。


## 【Step 2 レビュー・2026-07-27】一時的な EXPLAIN 不整合（Step 4 で解消）

Step 2 は **第5-L の実行だけを解禁**し、**EXPLAIN は従来どおり拒否**のままである。
したがって **Step 2 時点では「実行は成功するが EXPLAIN は拒否を返す」**という不整合が存在する。

- **意図的なスコープ分割**であり欠陥ではない（§12 で EXPLAIN は Step 4 担当）
- ただし **リリース前に必ず解消すること**。EXPLAIN と runtime が同じ plan を参照する契約
  （§0.3.6-9・Phase A §7.1）は Phase B でも維持しなければならない
- **Step 4 の受入条件に「JOIN ＋ server-only 関数の EXPLAIN が実行と一致する」を含めること**

**未解消のままリリースしてはならない。**
