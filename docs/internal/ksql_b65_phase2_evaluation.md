# B65 Phase2 — 小計・総計の拡張候補（仕様案＋効果評価）

- ステータス: ⏸ 保留（残4件・代替策あり・実需待ち・2026-07-23）。**コア4件（#8 static validate / #2 HAVING GROUPING / #1 field-only CUBE / #5 SELECT DISTINCT）は v3.18.0 で出荷済み**。残＝#6 CTE/temp 実体化列・#3 式 grouping item・#7 window 併用・#4 GROUPING_ID。いずれも新能力でなく書き方の直接性のみで代替策あり（#4=複数 `GROUPING()`・#7 順位=CTE 2段形・#3=#6 の下位互換・#6=kintone 計算フィールド追加で迂回）。実需が出るなら **#6 が起点**。台帳 §3（保留）へ移動
- 種別: 機能／UX（`GROUP BY`・集計後処理・事前検証の拡張）
- 優先: 低（残4件は実需待ち・保留）
- 関連: [B65 Phase1 仕様 R2](ksql_b65_rollup_grouping_sets_spec.md)／[B65 Phase1 実装計画](ksql_b65_impl_plan.md)／[B65 Phase1 codex 評価](ksql_b65_rollup_grouping_sets_evaluation.md)／[B64 条件付き集計](ksql_b64_aggregate_case_expression_spec.md)／[B56 統計集約・完全入力](ksql_b56_statistical_aggregates_spec.md)／[B59 ORDER BY alias](ksql_b59_orderby_alias_fix_spec.md)／[B40 有界 fail-closed](ksql_property_graph_phase1_spec.md)

## 1. 結論

B65 Phase2 は一括で全候補を実装するより、次の三層へ分けるのが妥当である。

1. **Phase2 本体より先に #8**: `ksql_validate` の parse + static validation で、`SELECT DISTINCT` + B65 のような純 AST だけで確定する拒否を返す。現状の「validate は ok、実行 planning で拒否」という AI 向け UX ギャップを 0.5〜1.5 人日で閉じられる。
2. **Phase2 推奨コア**: #2 HAVING 内 `GROUPING()` → #1 field-only `CUBE` → #5 `SELECT DISTINCT` 正式対応。いずれも Phase1 の grouping-set 正規形、membership sidecar、後段 pipeline を直接拡張でき、固有価値と実装リスクの釣り合いがよい。
3. **第二波または別テーマ**: #6 CTE/temp 実体化列、#4 grouping bitmask、#3 式 grouping item、#7 window 併用。特に #3 と #7 は parser 追加よりも、値 identity・中間行・評価順・型メタの再設計が主体となるため、同じ Phase2 へ詰め込まない。

推奨 Phase2 コア（#2 + #1 + #5）の概算は **6.0〜10.0 人日**、#6 まで含める場合は **9.5〜15.5 人日**である。Phase1 の 6 Step／13〜21 人日相当に対し、既存 engine と sidecar を再利用できる一方、#5 と #6 は共通 evaluator／source identity の横断変更を伴う。

`GROUPING_ID` は Oracle／SQL Server で一般的な名前だが、PostgreSQL は多引数 `GROUPING(a,b,...)` 自体を整数 bitmask とする。標準準拠を優先するなら、#4 は **まず多引数 `GROUPING()` を正式化し、`GROUPING_ID` を互換 alias として追加するかは別判断**とするのが保守的である。

## 2. 評価の前提

### 2.1 Phase1 の出荷済み土台

Phase1 は次の機構をすでに持つ。

- `normalizeGroupingSpec()` が通常 GROUP BY と B65 を `NONE | PLAIN | GROUPING_SETS` へ正規化し、`ROLLUP` を明示 set 列へ展開する。
- `resolveGroupingSpec()`／`validateGroupingPlanning()` が物理 source identity と field code から `canonicalId`、`directKey`、`unqualifiedBridgeKey` を解決する。
- `applyGroupingSets()` が set ごとに bucket を独立評価し、結果を縦結合する。除外 field は `""` へ明示上書きし、B64/B56 を含む集計 state は set 間で共有しない。
- `groupingRowMeta.ts` は非列挙 symbol sidecar に `includedCanonicalIds` を保持し、`bindGroupingRefCanonicalId()`／`evalGroupingRef()` が値ではなく membership から `0/1` を返す。
- `runFullScan()` は filter → grouping → HAVING → window → DISTINCT → ORDER BY → LIMIT/OFFSET → project の順で処理する。
- `CompleteInputReason` の `GROUPING_SETS` により B65 は常に完全入力必須であり、`onLimit=truncate` を許さない。
- `B65_MAX_GROUPING_SETS=64`、`B65_MAX_GROUPING_ITEMS=16`、`B65_MAX_GENERATED_ROWS=50,000` の独立 guard が planning/runtime で fail-closed に働く。
- Phase1 の `validateGroupingPlanning()` は `SELECT DISTINCT`、window、materialized CTE/temp item、HAVING 内 `GROUPING()` を planning 時に拒否する。

### 2.2 標準意味論の参照基準

公開構文の意味論は独自に発明せず、次を基準とする。

- PostgreSQL の `GROUPING SETS` は各 set を別々に group 化した結果であり、`CUBE(e1,...,en)` は全ての部分集合、すなわち `2^n` set へ展開される。各 item は列だけでなく式も取り得る。  
  [PostgreSQL: GROUPING SETS, CUBE, and ROLLUP](https://www.postgresql.org/docs/current/queries-table-expressions.html#QUERIES-GROUPING-SETS)
- PostgreSQL の `GROUPING(arg...)` は、右端の引数を最下位 bit とする整数 mask を返す。引数は評価されず、同じ query level の GROUP BY 式と一致しなければならない。  
  [PostgreSQL: Grouping Operations](https://www.postgresql.org/docs/current/functions-aggregate.html#FUNCTIONS-GROUPING-TABLE)
- `SELECT DISTINCT` は SELECT 出力式を評価した結果行全体から重複を除く。`GROUP BY DISTINCT` の grouping-set 重複除去とは別機能である。  
  [PostgreSQL: SELECT / DISTINCT](https://www.postgresql.org/docs/current/sql-select.html#SQL-DISTINCT)
- window 関数は grouping、通常集計、HAVING の後に評価され、元入力行ではなく group 結果行を見る。  
  [PostgreSQL: Window Function Processing](https://www.postgresql.org/docs/current/queries-table-expressions.html#QUERIES-WINDOW)
- `GROUPING_ID` は Oracle／SQL Server が提供する grouping bit vector の整数化である。SQL Server では SELECT、HAVING、ORDER BY で利用し、右端引数が最下位 bit になる。  
  [SQL Server: GROUPING_ID](https://learn.microsoft.com/en-us/sql/t-sql/functions/grouping-id-transact-sql)／[Oracle: GROUPING_ID](https://docs.oracle.com/en/database/oracle/oracle-database/26/sqlrf/GROUPING_ID.html)

本評価では、Phase1 が対象外にした nested grouping element、通常 item との混在、`GROUP BY DISTINCT` まで暗黙に開かない。各候補の評価範囲を超える標準構文は、従来どおり明示拒否する。

## 3. 候補別評価

### 3.1 #1 `CUBE(a,b,...)`

#### 効果・需要

`ROLLUP(a,b)` が `(a,b)`, `(a)`, `()` の階層だけを作るのに対し、`CUBE(a,b)` は `(a,b)`, `(a)`, `(b)`, `()` を作る。地域×商品、担当×状態など、**両軸の明細・各軸小計・総計を 1 結果に揃える**用途に固有価値がある。

MCP がクロス集計の下地を作るとき、明示 `GROUPING SETS` を全列挙せず標準構文で意図を表せる。看板機能の自然な延長で需要は **中**。3軸を超える CUBE は出力が読みにくくなり、実務需要より爆発リスクが先に立つ。

#### 仕様案

Phase2 の初期範囲は次に限定する。

```sql
GROUP BY CUBE(field_ref [, field_ref ...])
```

- direct、field-only、1 item 以上。
- `CUBE` 内の式、要素 sublist、`GROUPING SETS` 内への nested CUBE、通常 GROUP BY item との混在は #3 または別仕様まで拒否する。
- `CUBE(a1,...,an)` は引数位置の全部分集合 `2^n` 個を生成し、`GroupingSpec.source` を `"CUBE"` へ拡張したうえで既存 `GROUPING_SETS` 正規形へ lower する。
- 引数位置の重複によって同値 set が生じても、`GROUP BY ALL` 相当の現行契約に従い保持する。`GROUP BY DISTINCT` は別候補であり、暗黙 dedupe しない。
- set の列挙順は内部安定性と EXPLAIN のため固定してよいが、結果順契約にはしない。必要な順序は `ORDER BY` で指定する。

#### 設計案

- `parser.ts` の既存 `isCubeStart()` の Phase1 専用拒否を `parseCubeClause()` へ置換する。
- `GroupingSpec["source"]`、`NormalizedGroupingSpec`、`ResolvedGroupingSpec` を `"CUBE"` 対応にする。
- `normalizeGroupingSpec()`／`resolveGroupingSpec()`／`applyGroupingSets()` は展開後の共通形をそのまま使う。
- `validateGroupingPlanning()` の guard hook へ、展開後 set 実体を作る前に計算した set 数を渡す。

`2 ** n` を先に通常 Number で計算して巨大配列を作ってはならない。安全策は次のいずれかとする。

1. `count=1` から item ごとに倍加し、次の倍加が `B65_MAX_GROUPING_SETS` を超える時点で `GROUPING_SET_LIMIT_EXCEEDED`。
2. `BigInt` で `1n << BigInt(n)` を計算し、limit と比較してから配列化。

現行 limit 64 なら direct field item は実質 6 個までで、7 個は `128 > 64` として fetch 前に拒否される。item limit 16 と set limit 64 は独立に維持する。

#### 複雑度・リスク・相互作用

- 複雑度: **低〜中**。engine 新設は不要。
- 最大リスク: 展開前 guard の欠落、重複引数の誤 dedupe、set 順を出力順保証と誤記すること。
- B64/B56: set/bucket ごとの既存 evaluator をそのまま使う。set 数増加により計算量だけが増える。
- B56/完全入力: `GROUPING_SETS` reason を継続利用する。
- B59: `GROUPING()` と通常集計 alias のローカル ORDER は不変。
- B40/guard: planning set guard と runtime generated-row guard の両方を免除しない。HAVING/LIMIT で減る見込みを先取りしない。
- 空文字/sidecar: `applyGroupingSets()` の field 上書きと membership をそのまま利用する。

#### 概算・判断

- **2.0〜3.5 人日**
- 判断: **やる**。Phase2 コアの第2優先。#2 より変更面は広いが、既存正規形への糖衣展開として費用対効果が高い。

### 3.2 #2 HAVING 内 `GROUPING()`

#### 効果・需要

小計だけ、総計だけ、明細だけを返すフィルタを同じ query level で表現できる。

```sql
HAVING GROUPING(会社名) = 1
```

値が `""` かどうかで total を推測せず membership で絞れるため、実データ空セルとの衝突を避けられる。MCP が「総計だけ」「明細と総計だけで中間小計を除外」といった指示へ素直に応答でき、需要は **高**。Phase1 の看板構文から自然に要求される。

#### 仕様・設計案

- 許可位置を B65 query level の HAVING 条件へ広げる。WHERE、JOIN ON、集計引数、window 定義、DML は引き続き拒否する。
- `parser.ts` は HAVING の `parseWhereExpr()` 呼出し時だけ `groupingFieldAllowedDepth` 相当の context を有効化する。SELECT CASE 用の boolean flag を流用して文脈を曖昧にせず、`SELECT_CASE | HAVING | FORBIDDEN` の明示 context 化が望ましい。
- `groupingValidation.ts` は `stmt.having` の `GroupingRef` を forbidden collection から allowed collection へ移し、`validateGroupingRefMembership()` と `bindGroupingRefCanonicalId()` を適用する。
- `evalWhere.ts` は既に `GROUPING_FIELD` を number semantics とし、`evalGroupingRef()` から値を読む。`runFullScan()` も `applyGroupingSets()` 後に HAVING を評価するため、engine の段階位置は変更不要。

保守的に、HAVING 内の利用は既存 WhereExpr が表現できる比較・論理条件に限定する。`GROUPING()+1` のような新しい scalar arithmetic は #3/#4 の AST 拡張まで許さない。

#### 複雑度・リスク・相互作用

- 複雑度: **低**。必要な sidecar・値 evaluator・number semantics は Phase1 で実装済み。
- 最大リスク: WHERE まで誤って開く context leakage と、HAVING 内 ref の planning bind 漏れ。
- B64/B56: HAVING は set ごとの集計結果に作用し、既存条件付き／統計集計値を同時に参照できる。
- B56/完全入力: HAVING で結果が減っても完全入力と generated-row guard は免除しない。
- B59: HAVING 後の ORDER BY 契約は不変。
- 空文字/sidecar: 値ではなく `includedCanonicalIds` を見るため整合する。

#### 概算・判断

- **1.0〜2.0 人日**
- 判断: **やる**。Phase2 コア第1優先。最も効果が高く、Phase1 の既存機構を最小差分で開ける。

### 3.3 #3 式 grouping item と式引数 `GROUPING(expr)`

#### 効果・需要

```sql
GROUP BY ROLLUP(UPPER(会社名))
GROUPING(地域 || 会社名)
```

表記揺れを正規化した小計、年月抽出、複数 field の表示キーなど、**元 app に計算済み field を追加せずレポート軸を作れる**。需要は **中〜高**。通常 GROUP BY が既に `ARITH_KEY`／`FUNC_KEY` を受理するため、B65 でも自然に期待される。

ただし `地域 || 会社名` は通常 `GroupByKey` の既存 `ARITH_KEY | FUNC_KEY | FIELD_NAME` だけでは表現しきれず、B64 系の `ScalarValueExpr` まで grouping grammar を広げる必要がある。見た目以上に大きい。

#### 保守的な仕様案

Phase2 の式 item は「kSQL が既に行単位で決定的に評価できる scalar value expression」に限定する。

- 許可候補: field、算術式、既存 scalar/string function、`||`。
- 後送: CASE grouping item、subquery、aggregate、window、contextual function、alias、ordinal。
- `GROUPING(expr)` の引数は値を評価せず、同じ query level の grouping item と canonical expression identity が一致する場合だけ受理する。
- 意味的同値化は行わない。`a+b` と `b+a`、`UPPER(x)` と `UPPER(TRIM(x))` は別 identity とする。
- 大小文字・空白・括弧など parser 後に消える表記差は同一 AST として扱う。
- 無修飾 field と一意解決された修飾 field は、planning 後の source identity が同じなら同一とする。

#### canonical identity と中間行の設計

表示用 SQL や default output name を identity にしてはならない。次の二段階が必要である。

1. parser AST を構造保持する。
2. planning で全 leaf field を `source-id + field-code` へ解決し、node type、operator/function、literal、解決済み leaf identity を deterministic serializer へ渡す。

`canonicalId` はこの resolved AST serialization から作る。`stringFuncDefaultKey()`／`arithColDefaultKey()` は出力表示名には再利用できるが、source alias 解決や将来 grammar を含む truth identity にはしない。

空文字上書きも field-only より難しい。除外式の leaf field を空文字にすると、別の grouping expression が同じ leaf を使う場合に壊れる。反対に元行を残して project 時に式を再評価すると、subtotal/total に先頭行の式値が漏れる。

したがって `GroupingRowMeta` を次の概念へ拡張するのが安全である。

```ts
type GroupingRowMeta = {
  includedCanonicalIds: ReadonlySet<string>;
  valuesByCanonicalId: ReadonlyMap<string, string>;
};
```

- `applyGroupingSets()` は current set に含まれる式の bucket 値を `valuesByCanonicalId` へ保存する。
- SELECT／CASE／ORDER BY／HAVING の同じ grouping expression は、元 leaf から再評価せず sidecar の確定値を読む。
- current set に含まれない式は `""` を返す。
- 物理 field item の外部出力は Phase1 の direct/bridge overwrite を維持し、式 item は collision-free sidecar を truth source とする。

#### 複雑度・リスク・相互作用

- 複雑度: **高**。parser/AST、required-field walker、resolved serializer、engine bucket、projection、CASE/HAVING/ORDER、型メタを横断する。
- 最大リスク: canonical identity の不一致、除外式の再評価による先頭行値漏れ、式 output name と alias/集計合成名の衝突。
- B64: scalar expression evaluator／canonical serializer の再利用候補はあるが、aggregate argument identity と grouping identity を同じ文字列規約へ雑に統合しない。
- B56/完全入力: B65 reason は維持。数値式が非有限値になる場合の fail-closed 規約も必要。
- B59: 式 item の sort semantics を expression 全体から推論し、alias／direct expression の両経路を揃える。
- guard: canonical item 数は式単位で数える。leaf field 数には required-field／式深さの別 guard が必要かを検討する。
- CTE/temp: #6 と同時に行うと source identity の種類が増え、試験行列が乗算になる。順次実装が安全。

#### 概算・判断

- **6.0〜9.0 人日**
- 判断: **後回し（今回 Phase2 コアから見送り）**。価値は高いが、#1/#2 の延長ではなく sidecar value model の第二設計になる。需要 SQL を収集して許可式 grammar を先に絞る。

### 3.4 #4 `GROUPING_ID(a,b,...)`

#### 効果・需要

複数の `GROUPING(a)`, `GROUPING(b)` を並べず、detail/subtotal/total の level を 1 整数で識別できる。MCP が CASE ラベルや HAVING filter を短く生成でき、特に CUBE で価値が上がる。

2列なら次の mask となる。

| a | b | mask |
|---:|---:|---:|
| included | included | 0 |
| included | excluded | 1 |
| excluded | included | 2 |
| excluded | excluded | 3 |

需要は **中**。便利だが、Phase1 の複数 `GROUPING()` でも同じ判別は可能で、単独では新しい集計能力を増やさない。

#### 仕様上の名称判断

PostgreSQL／SQL 標準寄りの意味論では `GROUPING(a,b,...)` 自体が整数 mask であり、Phase1 の1引数形はその安全な subset である。一方 `GROUPING_ID` は Oracle／SQL Server の互換名である。

推奨は次の順である。

1. `GROUPING(field_ref [, field_ref ...])` を正式な多引数 mask として拡張する。
2. 利用者互換性を重視する場合だけ、同一 AST／evaluator へ lower する `GROUPING_ID(...)` alias を追加する。

`GROUPING_ID` だけを追加して多引数 `GROUPING` を拒否し続けると、参照基準としている PostgreSQL の構文と不自然にずれる。

#### 設計案

- `GroupingRef` を引数列を持つ node へ一般化するか、`GroupingMaskRef` を別 node として追加する。
- planning は各 arg を `validateGroupingRefMembership()` 相当で解決し、canonical ID 列を node へ bind する。
- evaluator は左から `mask = mask * 2 + excludedBit` と計算する。右端が最下位 bit になる。
- 現行 item limit 16 なら最大値 65,535 で Number の安全整数範囲内だが、32 bit bitwise 演算への依存は避け、将来 limit 変更にも備える。
- SELECT、SELECT CASE 条件、direct ORDER BY、#2 採用後の HAVING で同じ resolver を使い、number semantics を供給する。
- arg は grouping item と exact canonical identity が一致するものに限定する。#3 未実装中は field-only。

#### 複雑度・リスク・相互作用

- 複雑度: **低〜中**。
- 最大リスク: bit 順の逆転、単一引数との互換 drift、`GROUPING_ID` と多引数 `GROUPING` の二重実装。
- B59: direct/alias ORDER BY とも number semantics。
- #1: CUBE の各 grouping level 判定で相乗効果が大きい。
- #2: HAVING で mask を使うには #2 が先行している方が自然。
- sidecar: `includedCanonicalIds` だけで計算でき、row value map は不要。

#### 概算・判断

- 多引数 `GROUPING()` のみ: **1.5〜2.5 人日**
- `GROUPING_ID` alias、docs、互換 test まで: **2.0〜3.5 人日**
- 判断: **やる候補だが要オーナー判断**。#2/#1 後の第4優先。標準優先なら多引数 `GROUPING()`、互換性優先なら `GROUPING_ID` も alias とする。

### 3.5 #5 `SELECT DISTINCT` + B65 正式対応

#### 効果・需要

重複 grouping set、同じ表示値になる detail/total、CASE ラベル後に同一となる行を、**実際の SELECT 出力列全体**で正しく dedupe できる。Phase1 の明示的な組合せ拒否を解除し、標準 SELECT の直交性を回復する。

需要は **中**。通常の ROLLUP では不要なことも多いが、明示 `GROUPING SETS` の重複、discriminator を出さない表示用 query、将来 CUBE との組合せで自然に現れる。何より「一般には使える `SELECT DISTINCT` が B65 だけ拒否」という説明コストを下げる。

#### 仕様案

- HAVING 後、window 後、最終 ORDER BY 前に、SELECT list の各列を列位置順に評価した tuple で重複除去する。
- alias 名ではなく列位置と評価値を key にする。同じ出力名が複数あっても列を落とさない。
- `GROUPING_COL` を SELECT していれば detail `0` と total `1` は別行。SELECT しておらず全投影値が同じなら dedupe される。
- `SELECT DISTINCT` は grouping set 自体を消さない。`GROUP BY DISTINCT` は引き続き別機能。

#### 設計案

現行 `buildDistinctKeyBuilder()` は主に FIELD、WINDOW、wildcard しか評価せず、AGGREGATE、CASE、GROUPING、scalar/string/literal を網羅しない。Phase2 では `project()` と共通の「1 SELECT column evaluator」を作る。

概念上は次の責務へ分割する。

```ts
evaluateSelectColumnValue(column, row, context): string | string[]
buildDistinctTuple(columns, row, context): readonly unknown[]
projectRow(columns, row, context): ProcessRow
```

- aggregate は `materializeAggregateColumns()` が置いた alias／synthetic keyを読む。
- CASE、scalar/string、literal、`GROUPING_COL`、scalar subquery、window を `project()` と byte-equivalent に評価する。
- wildcard は現行の全行 key union、hidden qualified column、`_p.*` 規約を維持する。
- tuple serialization は JSON 等の衝突しない構造化形式を使い、欠損と `""` を区別する。
- `applyDistinct()` と `project()` が別々の switch を持たないことを受入条件にする。

#### 複雑度・リスク・相互作用

- 複雑度: **中〜高**。B65 固有というより SELECT projection 基盤の共通化。
- 最大リスク: project と DISTINCT の値 drift、重複出力名、wildcard、scalar subquery cache、CASE 型評価の取りこぼし。
- B64/B56: aggregate 値は各 set で materialize 済み。DISTINCT evaluator が再集計してはならない。
- B59: DISTINCT 後に ORDER BY。SELECT に無い ORDER BY key の既存制約を変えない。
- #7: window 出力も DISTINCT tuple に含める。両方を同時実装せず、#5 で既存 WINDOW_COL 回帰を固定する。
- guard: generated-row guard は DISTINCT 前のまま。dedupe 見込みで上限を免除しない。
- sidecar: `GROUPING_COL` は `evalGroupingRef()` を使い、非列挙 meta 自体を key に含めない。

#### 概算・判断

- **3.0〜4.5 人日**
- 判断: **やる**。Phase2 コア第3優先。#1/#2 より横断リスクが高いため、独立 Step と before-fail → after-pass 証跡を持たせる。

### 3.6 #6 CTE/temp 実体化列

#### 効果・需要

前段 CTE/temp で正規化・結合・計算した列を、後段の ROLLUP/CUBE 軸にできる。

```sql
WITH base AS (
  SELECT UPPER(会社名) AS 会社キー, 売上
  FROM APP100
)
SELECT 会社キー, SUM(売上)
FROM base
GROUP BY ROLLUP(会社キー)
```

kSQL は derived table を持たず、CTE/temp が段階処理の主要手段である。その materialized column を B65 軸にできない制約はレポート構築で目立つ。需要は **中〜高**で、#3 の式 grammar を広げずに前処理済み軸を使える代替にもなる。

#### 仕様案

- 同じ query level の FROM/JOIN に存在する materialized CTE/temp column を field-like grouping item として受理する。
- `GROUPING(materialized_col)` も同じ source identity へ解決する。
- column alias は materialized schema の列名として扱う。現在 query の SELECT alias／ordinal を grouping item にすることとは区別する。
- 同名列が複数 source にあれば物理 APP と同じく無修飾参照を拒否する。
- B65 結果を CTE/temp へ materialize する既存対応は維持する。

#### 設計案

`buildGroupingFieldResolver()` は現在 materialized source を検出できるが、`ResolvedGroupingField.physical=false` とし、`validateGroupingPlanning()` が拒否する。これを boolean `physical` ではなく source kind へ一般化する。

```ts
type GroupingSourceKind = "APP_FIELD" | "MATERIALIZED_COLUMN";
```

- APP field canonical ID: 現行 `source:<table-index>:APP<id>:<field-code>`。
- materialized canonical ID: query-local source identity + materialized column identity。表示 alias だけを ID にしない。
- `directKey`／一意 bridge の解決は `MaterializedTable` の columns と runtime row shape を使う。
- required-field walker は materialized column を Records API の取得 field に加えない。
- sort semantics は materialized table が保持する column metadata／`sortKind` を伝播する。
- `validateGroupingPlanning()` の「physical APP field 必須」を「resolved groupable source column 必須」へ置き換える。

Phase1 で共通化済みの complete-input policy を維持し、outer B65 が materialized source を読む場合も、元 APP fetch が truncate されて部分小計を作らないことを実行 test で固定する。

#### 複雑度・リスク・相互作用

- 複雑度: **中**。
- 最大リスク: query-local canonical ID の衝突、qualified/unqualified bridge、materialized 型メタ欠落、CTE inline と materialize の経路差。
- B64: 前段で作った CASE/連結列を grouping 軸にでき、#3 の安全な代替になる。
- B56/完全入力: outer B65 reason を物理 fetch まで確実に適用する。CTE/temp がすでに完全 materialize 済みでも runtime generated-row guard は必要。
- B59: materialized numeric/string metadata を grouping outputと ORDER BY へ伝播する。
- sidecar/空文字: field-like `directKey` と bridge を Phase1 と同じように上書きできる。
- #3: #6 を先に入れると、式 grouping の実需要を CTE 回避で測れる。両方同時に source identity を拡張しない。

#### 概算・判断

- **3.5〜5.5 人日**
- 判断: **やるが第二波**。Phase2 コア後の第5優先。実需が「前処理済み軸」に集中するなら #4 より先へ上げてよい。

### 3.7 #7 window 関数との併用

#### 効果・需要

grouping-set 合成行を対象に、売上順位、地域内順位、累計などを同じレポートへ付けられる。効果自体は **高**で、分析 SQL として自然である。

しかし現行 kSQL window は `ROW_NUMBER`、`RANK`、`DENSE_RANK` のみで、parser は同じ SELECT に GROUP BY／通常集計と window が共存すること自体を拒否する。累計に必要な `SUM(...) OVER (...)` は未実装である。したがって候補文言の「累計・順位」を一括対応すると、B65 の小拡張ではなく window Phase2 相当になる。

#### 現状の代替

B65 body を CTE/temp へ materialize し、外側の非集計 SELECT で既存 ranking window を使う二段形は、同じ SELECT 内併用より明示的である。

```sql
WITH g AS (
  SELECT 地域, 会社名, SUM(売上) AS 売上合計
  FROM APP100
  GROUP BY ROLLUP(地域, 会社名)
)
SELECT 地域, 会社名, 売上合計,
       RANK() OVER (PARTITION BY 地域 ORDER BY 売上合計 DESC) AS 順位
FROM g
```

この形の実行可否は既存 CTE/window 回帰で固定すべきだが、設計上は query level を分けるため Phase1 の「同じ SELECT で window 禁止」に抵触しない。ranking だけなら直接併用の固有価値は限定される。

#### 段階案

##### 7A: ranking-only

- B65 group + HAVING 後の合成行を `applyWindow()` へ渡す。
- `ROW_NUMBER`／`RANK`／`DENSE_RANK` だけを対象。
- window PARTITION/ORDER の参照対象を、grouping output field、aggregate expression、grouping discriminator のどこまで許すか標準構文に沿って定義する。
- SELECT alias を同じ window definition から参照させる独自短縮は避ける。標準形で集計式を再記述する AST、または CTE 二段形を使う。

##### 7B: cumulative aggregate window

- `SUM(...) OVER (...)` 等の aggregate window AST、frame、型メタ、完全入力、空集合規約を別仕様化する。
- B64 CASE aggregate を window aggregate の引数に許すか、B56 統計 window まで広げるかを別判断する。
- デフォルト frame と peer の意味を文書化し、単なる全 partition SUM と累計を混同しない。

#### 複雑度・リスク・相互作用

- 複雑度: ranking-only でも **中〜高**、累計込みは **非常に高い**。
- 最大リスク: query level の依存解決、aggregate alias／synthetic key、window ORDER の型メタ、sidecar clone、標準評価順の崩れ。
- B64/B56: window aggregateまで開くと accumulator、NULL、DISTINCT、完全入力の組合せが急増する。
- B59: top-level ORDER と window-local ORDER は別 planner。synthetic group row を REST へ押し下げない。
- #5: pipeline は window → DISTINCT。full SELECT evaluator が WINDOW_COL を正しく key 化する必要がある。
- guard: grouping generated-row guard 後に window sort/partition が追加メモリを使う。grouping row limitだけで十分か benchmark が必要。
- sidecar: `applyWindow()` は現在 row を保持するが、将来 clone/partition処理でも grouping meta を落とさない test が必要。

#### 概算・判断

- 7A ranking-only: **4.0〜6.0 人日**
- 7B aggregate window／累計: **6.0〜10.0 人日**
- 一括: **9.0〜14.0 人日**
- 判断: **今回 Phase2 では見送り、別 window 仕様へ分離**。まず CTE 二段形の既存能力を docs/実行 test で確認し、固有需要が残る場合だけ 7A、7B の順に進める。

### 3.8 #8 `ksql_validate` の純 AST 拒否強化

#### 効果・需要

現状、次は parser と `analyzeBatch()` を通るため `ksql_validate` が `ok:true` を返し得るが、実行前の metadata-backed `validateGroupingPlanning()` で拒否される。

```sql
SELECT DISTINCT 会社名, SUM(売上)
FROM APP100
GROUP BY ROLLUP(会社名)
```

拒否条件は `stmt.distinct && grouping.type === "GROUPING_SETS"` だけで確定し、kintone metadata は不要である。AI は通常 `ksql_validate` を事前 gate に使うため、そこで見逃して実行時に初めて失敗するのは Phase1 の残 UX ギャップである。

需要は **高**。新しい SQL 能力ではないが、AI が unsupported combination を早期に修正でき、無駄な query 実行と説明往復を減らす。

#### 設計案

`validateGroupingPlanning()` を次の二層へ分割する。

```ts
validateGroupingStatic(stmt)           // AST only
validateGroupingResolved(stmt, resolve) // metadata-backed
```

`validateGroupingStatic()` の対象は、少なくとも次とする。

- B65 + `SELECT DISTINCT`
- B65 + window
- B65 + KORDER
- B65 + wildcard
- `GROUPING()` の禁止 context など、AST だけで確定するもの

物理 field 実在、JOIN 曖昧性、canonical arg membership、materialized source kind、alias/runtime key collisionなど metadata が必要な拒否は `validateGroupingResolved()` に残す。

`ksql_validate` は `parseSqlStatements()` → `analyzeBatch()` の経路なので、static validator を全 query levelへ再帰適用する共通 helper を `analyzeBatch()` から呼ぶ。WITH body、UNION branch、CREATE TEMP query、scalar/IN/EXISTS subqueryも取りこぼさない。

実行／EXPLAINも同じ static validator を通し、MCP validate 専用の複製条件を作らない。エラー code/message は実行 planning と一致させる。

#### 複雑度・リスク・相互作用

- 複雑度: **低**。
- 最大リスク: validate と実行の validator 二重化、再帰 walker の query level 漏れ、metadata-dependent 条件まで static に移して誤拒否すること。
- #5 実装後は `SELECT DISTINCT` 拒否を static allow へ反転し、full evaluator test と同じ commit で更新する。
- B64/B56/B59/guard: 実行意味論は変えない。
- MCP/CLI/plugin: core static validator を共有すれば surface 固有実装は不要。MCP tool の `ksql_validate` smoke は必須。

#### 概算・判断

- **0.5〜1.5 人日**
- 判断: **Phase2 本体と独立に先行してやる**。最優先。#5 が近く実装予定でも、先に拒否を正しく返す価値があり、#5 完了時には受理へ反転できる。

## 4. 比較表

| 候補 | 固有価値 | 需要 | 複雑度 | 概算人日 | 推奨 |
|---|---|---|---|---:|---|
| #8 validate UX | AI が実行前に unsupported combination を検知 | 高 | 低 | 0.5〜1.5 | **独立先行** |
| #2 HAVING GROUPING | detail/subtotal/total を membership で抽出 | 高 | 低 | 1.0〜2.0 | **Phase2-1** |
| #1 CUBE | 全軸小計を標準糖衣で生成 | 中 | 低〜中 | 2.0〜3.5 | **Phase2-2** |
| #5 SELECT DISTINCT | SELECT 出力値全体で正式 dedupe | 中 | 中〜高 | 3.0〜4.5 | **Phase2-3** |
| #4 bitmask | 多列 grouping level を1整数化 | 中 | 低〜中 | 2.0〜3.5 | 名称判断後 |
| #6 CTE/temp item | 前処理済み列をレポート軸に利用 | 中〜高 | 中 | 3.5〜5.5 | 第二波 |
| #3 式 item | 正規化・計算済み軸を query 内生成 | 中〜高 | 高 | 6.0〜9.0 | 後回し |
| #7 window | 合成行の順位・累計 | 中 | 非常に高 | 9.0〜14.0 | 別テーマ |

## 5. 推奨スコープと実装順

### 5.1 先行 UX patch

1. #8 `validateGroupingStatic()` 抽出
2. `ksql_validate` で `SELECT DISTINCT + ROLLUP/GROUPING SETS` を拒否
3. nested query level を含む static validation test
4. 実行 planning と同じ error code/message であることを確認

この patch は SQL の受理範囲を広げず、Phase1 の fail-closed 契約を早い段階へ移すだけである。minor 機能 release を待たず、patch 候補として切り出せる。

### 5.2 推奨 Phase2 コア

1. **#2 HAVING GROUPING**  
   既存 `GROUPING_FIELD`／`evalGroupingRef()` を HAVING contextへ開く。
2. **#1 field-only direct CUBE**  
   展開前 `2^n` guardを先に固定し、既存 grouping-set engineへ lowerする。
3. **#5 SELECT DISTINCT**  
   `project()` と `buildDistinctKeyBuilder()` を共通 select-column evaluatorへ統合する。

各 Step で `npm test`、`npm run build`、通常 GROUP BY／Phase1 B65 の全回帰、MCP validate/query、Firefox/Chrome plugin smokeを分けて確認する。#1 は guard、#5 は before-fail → after-pass の値証跡を必須にする。

### 5.3 第二波

4. **#4 多引数 GROUPING／GROUPING_ID**  
   オーナーが名称を決める。CUBE 後に入れると実利用例が明確になる。
5. **#6 CTE/temp materialized column**  
   source-kind identityと型メタを独立 Step で導入する。

#3 は #6 の実需確認後に再評価する。#7 は B65 Phase2 から外し、既存 CTE 二段 workaround と window aggregate の要否を先に評価する。

## 6. 受入・回帰観点

Phase2 のどの subset を選んでも、次は不変条件とする。

- `normalizeGroupingSpec()` の通常 GROUP BY byte-compatible 経路を壊さない。
- `applyGroupingSets()` は set 間で B64/B56 accumulator／DISTINCT state を共有しない。
- subtotal/total の除外 field／式へ入力先頭行値を残さない。
- membership truth は外部 `""` ではなく collision-free sidecar に置く。
- B65 は `GROUPING_SETS` complete-input reason を維持し、truncate を許さない。
- set/item/generated-row guard は HAVING、DISTINCT、window、LIMITで後から減る場合も免除しない。
- B59 の構文・値・型メタ・planner の4層を direct key／aliasの双方で揃える。
- `GROUP BY DISTINCT`、nested/mixed grouping element、式 itemなど未選択の標準構文は、既存構文へ誤解釈せず明示拒否する。
- `ksql_validate` の static 判定と実行 planning の判定を共通実装にし、surface 間で受理範囲をずらさない。

## 7. 要 Claude／オーナー判断

1. **Phase2 の投資上限**: 推奨コア #2 + #1 + #5（6.0〜10.0 人日）までか、#6 を含む 9.5〜15.5 人日までか。
2. **#4 の公開名**: PostgreSQL/標準寄りの多引数 `GROUPING()` を本体にするか、Oracle/SQL Server 互換の `GROUPING_ID` alias も同時提供するか。
3. **#3 の許可式 grammar**: 算術・string function・`||` までか、CASE まで含めるか。canonical resolved AST serializer と sidecar value map を受け入れるか。
4. **#6 の優先度**: 実務上、式 item より CTE/temp 前処理済み列の需要が高いという見立てで第二波を先行するか。
5. **#7 の分離**: ranking-only と aggregate window／frameを別 issue にし、B65 Phase2 から除外するか。
6. **#8 の release 単位**: Phase2 minorを待たず、Phase1 UX gap修正として patch 先行するか。

## 8. 最終要約

1. **①効果が高い候補**: #2 HAVING `GROUPING()`、#6 CTE/temp 実体化列、#1 CUBE。#5 DISTINCT は能力追加より直交性・説明容易性の改善効果が高い。
2. **②リスク/複雑度が高い候補**: #7 window は既存の aggregate+window 禁止と累計 window 未実装まで波及する。#3 式 item は canonical resolved identity、sidecar value、除外式の空文字表現が難所。
3. **③先行できる小粒**: #8。`SELECT DISTINCT + ROLLUP` が `ksql_validate` では ok、実行 planning で拒否される Phase1 残 UX gapを、共通 static validatorで独立に閉じられる。
4. **④推奨 Phase2 スコープと優先順**: #8先行 → #2 HAVING → #1 field-only CUBE → #5 DISTINCT → #4 多引数bitmask（名称判断後）→ #6 CTE/temp。#3/#7は別仕様へ送る。
5. **⑤要 Claude/オーナー判断**: Phase2を#5までに絞るか#6まで含めるか、`GROUPING_ID` を公開するか多引数 `GROUPING()` を優先するか、#3式grammar、#7別issue化、#8 patch先行の5点。
