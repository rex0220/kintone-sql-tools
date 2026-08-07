# B155 安全葉判定の分類器統一 仕様（R1）

- ステータス: **R1 正本**
- 対象: kSQL v3.61.0
- 実装候補版: v3.62.0
- 起票: [B155](ksql_b155_cte_join_where_merge_issue.md)
- 関連: [B150 R1](ksql_b150_join_key_range_prefilter_spec_r1.md) / [B151 R1](ksql_b151_join_number_pushdown_spec_r1.md) / [B152 R1](ksql_b152_join_pushdown_phase234_spec_r1.md) / [B154](ksql_b154_join_prefilter_explain_note_issue.md)
- 初版: 2026-08-08
- SemVer: **minor**
- 採用案: **案 A — B76 世代の安全葉判定を単一の分類器へ統一**

---

## 0. R1 の位置づけ

B155 は、B76 世代の「kintone へ安全に送れる WHERE leaf」の規則が次の2実装へ複製され、B151/B152 の型開放が片方にしか届かなかった問題を解消する性能改善である。

| 実装 | 現在の役割 |
|---|---|
| `joinPredicatePushdown.classifySupportedLeaf` | B151/B152 を反映した正規の型×演算子分類 |
| `wherePredicatePushdown.isSafeComparison` | B76 時点の NUMBER 制限などが残った旧分類 |

現行 v3.61.0 では、物理 APP だけの `INNER JOIN` は正規分類器を使う一方、次の経路は旧分類器を使う。

1. CTEまたは一時テーブルを含む FULL_SCAN JOIN の、物理 APP ごとの WHERE prefilter
2. 単一表 FULL_SCAN で元 WHERE 全体を直列化できない場合の、安全な AND leaf prefilter

その結果、同じ leaf でも経路によって押し下げ可否が異なる。

```text
物理→物理 JOIN:
  NUMBER <=、TEXT = などが B151/B152 の規則で採用される

CTE/一時テーブル→APP JOIN:
  NUMBER = と安全整数 strict < > など、旧規則の一部だけが採用される

単一表 FULL_SCAN:
  LIKE 等が残余にあると、TEXT = や NUMBER <= が旧規則に阻まれる
```

B155 後は、通常フィールドの leaf 判定を `joinPredicatePushdown` 側の共有分類器へ統一する。経路ごとに型一覧や演算子一覧を再定義してはならない。

B155 は結果集合を変更しない。変更するのは records API に送る prefilter、取得候補数、`EXPLAIN` の query/fetch 表示である。元 WHERE の残余再評価は維持する。

---

## 1. 目的

B155 の目的は次のとおりである。

1. CTE/一時テーブルを含む FULL_SCAN JOIN の物理 APP 側 WHERE leaf に、B151/B152 の分類結果を適用する。
2. 単一表 FULL_SCAN の安全 prefilter に、同じ分類結果を適用する。
3. NUMBER、TEXT、DATE/TIME/DATETIME、選択系などの型×演算子規則を1か所だけに置く。
4. `< 101` と `<= 100` の経路差を解消する。
5. `fieldTypes` / `fieldOptions` の取得要否判定を新しい分類対象へ追随させる。
6. KLIKE、`$id`、選択肢の実在検証、B126 正規化後 AST、元 WHERE の残余評価を回帰させない。
7. 実行と `EXPLAIN` が同じ metadata-aware prefilter plan を表示・使用する。
8. B154 の誤読を防ぐ表示注記を同梱する。

公開原則は次である。

> 物理 APP の直接フィールドを対象とする安全な WHERE leaf は、実行経路ではなく、共有された型・literal・演算子分類によって一意に判定する。

---

## 2. 現行コードから確定していること

### 2.1 旧抽出器

`extractSafePushdownLeaves()` は AND spine をたどり、`isSafeComparison()` が受理した leaf だけを再構成する。

根拠:

- `src/core/optimization/wherePredicatePushdown.ts:27-38`
- `src/core/optimization/wherePredicatePushdown.ts:63-89`
- `src/core/optimization/wherePredicatePushdown.ts:91-100`

旧 `isSafeComparison()` は次を別々に判定する。

- KLIKE / NOT KLIKE
- `$id` の数値比較
- NUMBER の `=`
- NUMBER と安全整数の strict `<` / `>`
- 選択系 `IN` / `NOT IN` と実在選択肢

NUMBER の `<=` / `>=` / `!=` / `<>` / `IN` / `NOT IN`、TEXT/LINK、DATE/TIME/DATETIME など、B151/B152 後の規則は反映されていない。

根拠:

- `src/core/optimization/wherePredicatePushdown.ts:103-172`
- `src/core/optimization/wherePredicatePushdown.ts:174-192`

### 2.2 正規分類器

`classifyJoinPushdownLeaf()` は次の gate を通した後、`classifySupportedLeaf()` を呼ぶ。

1. 左辺が直接 `FIELD`
2. ownership が一意
3. owner が物理 APP
4. field type が既知
5. `KSQL_*` 合成型ではない
6. `classifyWhereCapability()` が `EXACT_PUSHDOWN`
7. 型別 leaf policy が `exact` または `superset`

根拠:

- `src/core/optimization/joinPredicatePushdown.ts:198-248`

型別の正規規則は `classifySupportedLeaf()` に集約されている。

根拠:

- `src/core/optimization/joinPredicatePushdown.ts:1028-1137`

### 2.3 旧抽出器の実行経路

`buildKlikePushdownPlan()` は、メイン物理 APP と各 JOIN 物理 APPについて `extractSafePushdownLeaves()` を呼ぶ。

根拠:

- `src/core/optimization/klikePushdownPlan.ts:41-56`
- `src/core/optimization/klikePushdownPlan.ts:59-103`

通常の FULL_SCAN 実行では、物理 APP だけの直接 `INNER JOIN` なら `buildRuntimeJoinPushdownPlan()` を使用し、それ以外は `buildKlikePushdownPlan()` へフォールバックする。

根拠:

- `src/execute.ts:3950-4002`
- `src/execute.ts:4941-4967`
- `src/execute.ts:5474-5490`

CTE/一時テーブルを含む JOIN では、フォールバック plan の `joinConditions` が物理 APP の取得条件として消費される。

根拠:

- `src/execute.ts:5511-5542`
- `src/execute.ts:5543-5568`

JOIN key prefilter と WHERE prefilter は、双方がある場合に AND で結合される。

根拠:

- `src/execute.ts:5935-5985`

単一表 FULL_SCAN では、`mainCondition` が records API の prefilter になる。

根拠:

- `src/execute.ts:4966-4996`
- `src/execute.ts:5643-5685`

### 2.4 元 WHERE の残余評価

通常の prefilter leaf は元 WHERE から除去しない。records API で候補を絞った後、`runFullScan()` が元 statement の WHERE を再評価する。

根拠:

- `src/execute.ts:5092-5113`
- `src/engine/process.ts:2089-2121`

したがって、B155 で追加される query は最終結果を直接決定する条件ではなく、元 WHERE の候補集合を包含する prefilter である。

### 2.5 metadata の現状

`loadTypedPushdownMeta()` は、`extractTypedPushdownCandidates()` が見つけた構文候補についてのみ `fieldTypes` と `fieldOptions` を取得する。

根拠:

- `src/execute.ts:3922-3934`
- `src/execute.ts:4005-4061`

現行の `extractTypedPushdownCandidates()` は NUMBER の旧候補と選択系 `IN` / `NOT IN` しか列挙しない。

根拠:

- `src/core/optimization/wherePredicatePushdown.ts:41-60`
- `src/core/optimization/wherePredicatePushdown.ts:161-183`

このため leaf classifier だけを差し替えても、TEXT `=`、DATE range、NUMBER `<=` などに必要な型メタが取得されない経路が残る。B155 は metadata 要否判定も同時に修正しなければならない。

---

## 3. 適用経路

### 3.1 CTE/一時テーブルを含む FULL_SCAN JOIN

次をすべて満たす leaf を、対象物理 APP の per-alias condition 候補とする。

1. JOIN が `INNER JOIN`
2. 対象 table が物理 APP
3. 対象 APP に利用可能な alias がある
4. 左辺が対象 alias の直接フィールド
5. RHS に別フィールド参照を含まない
6. field type と必要な field options が解決済み
7. 共有分類器が `exact` または `superset`
8. OR / NOT / NULL_CHECK / EXISTS 等の既存 AND-spine gate を通る

CTE、一時テーブル、サブテーブル自体へ kintone query を送ってはならない。

### 3.2 単一表 FULL_SCAN

次のように元 WHERE 全体を exact に送れない場合でも、安全な AND leaf を prefilter として使用する。

```sql
SELECT $id
FROM APP4228
WHERE 製品名 = '牛乳'
  AND 仕入先 LIKE 'zz'
ORDER BY $id
```

B155 後の records API query は次である。

```text
製品名 = "牛乳"
```

`仕入先 LIKE 'zz'` は local residual のままである。

### 3.3 物理 APP だけの INNER JOIN

物理 APP だけを入力にする直接 `INNER JOIN` は、従来どおり `buildRuntimeJoinPushdownPlan()` と `classifyJoinPushdownLeaf()` を使う。

B155 はこの経路の型×演算子表、relation、ownership、serializer、残余規則を変更しない。

---

## 4. 分類器の統一設計

### 4.1 採用する統一形

`classifyJoinPushdownLeaf()` を `wherePredicatePushdown.ts` から擬似的な JOIN source を作って直接呼ぶ方式は採用しない。

理由は次のとおりである。

- 単一表の非修飾 field と JOIN の ownership は別契約である。
- `JoinPushdownSource` の `alias` / `appId` / `sourceKind` をダミー値で埋めると、ownership policy と leaf policy が混ざる。
- KLIKE の静的検証用 variable と単一表 `$id` の既存受理を、JOIN ownership の都合で変えてしまう。
- 将来 source policy を変更した際に、単一表側へ不要な影響が及ぶ。

代わりに、現行の private `classifySupportedLeaf()` を、ownership から独立した共有 leaf policy として公開可能な形へ抽出する。

概念上の入力は次である。

```ts
interface SupportedLeafMetadata {
  readonly fieldCode: string;
  readonly fieldType: string;
  readonly fieldOptions?: ReadonlySet<string>;
}
```

概念上の API は次である。

```ts
function classifySupportedLeaf(
  predicate: BinaryExpr,
  metadata: SupportedLeafMetadata
): JoinPushdownClassification;
```

実際の名前は既存命名との整合を優先してよい。ただし、型×演算子の本体が複数ファイルへ残る形は禁止する。

### 4.2 `JoinPushdownSource` からの橋渡し

`classifyJoinPushdownLeaf()` は ownership と source-kind gate を従来どおり担当し、共有 leaf policy へ次を渡す。

```text
fieldCode    = owner.fieldCode
fieldType    = owner.source.fieldTypes.get(owner.fieldCode)
fieldOptions = owner.source.fieldOptions?.get(owner.fieldCode)
```

`classifyWhereCapability()` の gate も維持する。

### 4.3 `SafePushdownOptions` からの橋渡し

旧抽出器側は、alias/unqualified gate を先に通した後、次を共有 leaf policy へ渡す。

```text
fieldCode    = expr.left.field
fieldType    = options.fieldTypes.get(expr.left.field)
fieldOptions = options.fieldOptions?.get(expr.left.field)
```

通常フィールドは field type が不明なら採用しない。

共有 policy が `unsafe` 以外を返した leaf だけを抽出する。`exact` と `superset` はどちらも prefilter 候補にできるが、最終 fetch relation は §7 に従う。

### 4.4 capability gate

共有 leaf policy を呼ぶ経路は、同じ field metadata を使って `classifyWhereCapability()` を通す。

次の場合は fail-closed で不採用とする。

- capability が `UNSUPPORTED`
- capability が `LOCAL_FILTER`
- serializer が対象 leaf を表現できない
- RHS に field reference がある
- field type が不明
- `KSQL_*` 合成型
- 必要な選択肢 metadata がない
- literal policy を満たさない

### 4.5 KLIKE の互換性

KLIKE / NOT KLIKE は、既存の identity-based consumption と静的検証契約を維持する。

特に次を変更しない。

- `allowKlike: false` なら採用しない。
- outer join では採用しない。
- `allowUnresolvedKlikeVariables: true` の静的検証では未解決 variable を候補として扱う。
- `appliedKlikes` は抽出後 AST の同一 node identity から作る。
- KLIKE を含む OR は採用しない。
- 未適用 KLIKE は local evaluator が fail-closed で拒否する。

通常型の分類統一を理由に、既存の KLIKE candidate 判定を JOIN runtime classifier の metadata 必須条件へ狭めてはならない。

根拠:

- `src/core/optimization/klikePushdownPlan.ts:41-56`
- `src/core/optimization/klikePushdownPlan.ts:95-107`
- `src/core/optimization/joinPredicatePushdown.ts:1033-1040`

### 4.6 `$id` の互換性

単一表および fallback extractor の既存 `$id` 受理は維持する。

対象演算子:

```text
=  <  >  <=  >=
```

B155 は `$id` の literal domain、relation、`!=` / `<>`、`IN` / `NOT IN` の開放を扱わない。

通常フィールドの型規則を共有化するために、`$id` の既存経路を狭めたり広げたりしてはならない。

### 4.7 B126 正規化後 AST

B155 の planner は、`normalizeSelectChoiceEquality()` 後の AST を受ける。

選択系の equality が既存処理で `IN` / `NOT IN` へ正規化される場合、B155 内に選択系 `=` の特例を追加してはならない。

選択系は共有分類器の既存規則どおり、実在する非空選択肢だけからなる `IN` / `NOT IN` を採用する。

---

## 5. metadata 候補抽出

### 5.1 必須変更

`extractTypedPushdownCandidates()` 相当の metadata 要否判定を、B151/B152 後の共有分類器へ追随させる。

少なくとも次を候補として検出しなければならない。

- NUMBER の6比較演算子
- NUMBER の `IN` / `NOT IN`
- DATE / TIME / DATETIME / CREATED_TIME / UPDATED_TIME の比較
- SINGLE_LINE_TEXT / LINK の equality、inequality、`IN` / `NOT IN`
- RECORD_NUMBER / CALC の既存 superset 対象
- ユーザー・組織・グループ・作業者系の既存対象
- 選択系 `IN` / `NOT IN`

ただし、上記の型一覧を `wherePredicatePushdown.ts` に複製してはならない。

### 5.2 構文候補 helper

型メタ取得前には field type を判定できないため、共有分類器と同じモジュールに「metadata を取得すれば採用される可能性がある直接 leaf」の構文候補 helper を置く。

この helper は少なくとも次を確認する。

- 左辺が直接 field
- 対象 alias または許可された非修飾 field
- `$id` ではない
- RHS に field reference がない
- scalar literal または非空 literal list
- 共有 policy が扱いうる operator family

候補 helper は採用可否や relation を決定しない。最終判断は metadata 解決後の共有 leaf policy が行う。

新しい型や演算子を共有 leaf policy へ追加した場合、同じ変更で候補 helperも追随することを parity test で保証する。

### 5.3 B150 修正2との整合

CLI `--dry-run` は metadata candidate の存在を理由に records API または metadata API を呼んではならない。

dry-run では次だけを表示できる。

```text
pushdown candidate: <serializer可能な構文候補>（実行時の型・実在確認待ち）
```

次を確定表示してはならない。

- metadata 未解決 leaf の `relation: exact`
- 実在未確認の選択肢
- runtime CTE key の実値
- 実 records API query が確定したかのような表示

CLI dry-run の API call count は、`getRecords`、`getFields`、`getProcessStatuses`、その他の kintone API を含めて0回でなければならない。

---

## 6. 型×演算子契約

B155 は共有分類器の結果を別経路へ届ける変更であり、分類器自身の公開表を変更しない。

正は B151/B152 および現行 `classifySupportedLeaf()` とする。

代表的な対象は次のとおりである。

| field type | leaf | relation |
|---|---|---|
| NUMBER | numeric literal との `=` / `!=` / `<>` / `<` / `>` / `<=` / `>=` | `exact` |
| NUMBER | 対応範囲内 numeric literal の `IN` / `NOT IN` | `exact` |
| DATE / TIME / DATETIME 系 | canonical string literal との対応比較 | `exact` |
| SINGLE_LINE_TEXT / LINK | 非空文字列との `=` / `!=` / `<>` | `exact` |
| SINGLE_LINE_TEXT / LINK | 非空文字列 list の `IN` / `NOT IN` | `exact` |
| 選択系 | 全値が実在する非空文字列 list の `IN` / `NOT IN` | `exact` |
| RECORD_NUMBER / CALC | 既存分類器が許可する scalar/list | `superset` |
| KLIKE 対応型 | 既存 KLIKE 契約を満たす leaf | 既存契約 |
| `$id` | 既存の肯定数値比較 | 既存契約 |

次は引き続き対象外である。

- field-to-field 比較
- 算術式、関数、CASE、集計結果を左辺に置く比較
- scalar subquery
- `IN (SELECT ...)`
- LIKE / NOT LIKE 自体の prefilter 化
- canonical policy 外の DATE/TIME/DATETIME literal
- B151 の NUMBER literal policy 外
- 空文字を禁止している型での空文字 literal
- 実在しない選択肢
- source ownership が不明または曖昧な field
- outer join で安全証明できない leaf
- CTE/一時テーブル列を kintone query へ送る形

---

## 7. relation と残余契約

### 7.1 leaf relation

共有分類器の `exact` / `superset` は、単独 leafについての server/client 集合関係である。

```text
exact:
  server leaf の集合 = local leaf の集合

superset:
  server leaf の集合 ⊇ local leaf の集合
```

### 7.2 WHERE 全体に対する fetch relation

単一の leaf が `exact` でも、元 WHERE に local residual が残る場合、records fetch 全体は `PREFILTERED` である。

例:

```sql
WHERE 製品名 = '牛乳'
  AND 仕入先 LIKE 'zz'
```

records API query:

```text
製品名 = "牛乳"
```

fetch scope:

```text
PREFILTERED
```

この形を `EXACT` と表示してはならない。

### 7.3 JOIN keyとの合成

JOIN key range prefilter が `superset` なら、追加 WHERE leaf がすべて `exact` でも、合成後 relation は `superset` である。

```text
superset AND exact = superset
```

元 WHERE は JOIN 後に再評価する。

### 7.4 結果不変条件

B155 前後で公開 `rows`、列順、rowCount、warning、エラー条件を変更してはならない。

取得 query が狭くなっても、次を満たすこと。

```text
rows(prefilter enabled) = rows(prefilter disabled)
```

---

## 8. serializer 契約

既存の `whereToKintone()` をそのまま使用する。B155 専用 serializer、NUMBER widening、文字列再正規化を追加してはならない。

### 8.1 CTE→APP の必須 SQL

```sql
WITH s AS (
  GENERATE_SERIES('2026-07-29', '2026-08-04') AS 日付
)
SELECT
  s.日付,
  t.$id,
  t.製品名,
  t.個数
FROM s
INNER JOIN APP4228 AS t
  ON s.日付 = t.日付
WHERE t.製品名 = '牛乳'
  AND t.個数 <= 100
  AND t.入出庫区分 = '出庫'
ORDER BY s.日付, t.$id
```

B126 正規化後、選択系 equality は既存規則どおり `IN` になる。

WHERE prefilter 単体の実 serializer 形は次である。

```text
(製品名 = "牛乳" and 個数 <= 100) and 入出庫区分 in ("出庫")
```

JOIN key range と合成した実 query は次である。

```text
(日付 >= "2026-07-29" and 日付 <= "2026-08-04") and ((製品名 = "牛乳" and 個数 <= 100) and 入出庫区分 in ("出庫"))
```

空白差を除き、この文字列を受入テストで固定する。

### 8.2 strict/inclusive 対照

次の2 SQLは、WHERE leaf の採用可否が同じでなければならない。

```sql
WITH s AS (
  GENERATE_SERIES('2026-07-29', '2026-08-04') AS 日付
)
SELECT s.日付, t.$id
FROM s
INNER JOIN APP4228 AS t
  ON s.日付 = t.日付
WHERE t.個数 < 101
ORDER BY s.日付, t.$id
```

```sql
WITH s AS (
  GENERATE_SERIES('2026-07-29', '2026-08-04') AS 日付
)
SELECT s.日付, t.$id
FROM s
INNER JOIN APP4228 AS t
  ON s.日付 = t.日付
WHERE t.個数 <= 100
ORDER BY s.日付, t.$id
```

実 serializer 形:

```text
個数 < 101
個数 <= 100
```

`<= 100` を `< 101` へ変形してはならない。

### 8.3 単一表 FULL_SCAN

必須 SQL:

```sql
SELECT $id
FROM APP4228
WHERE 製品名 = '牛乳'
  AND 仕入先 LIKE 'zz'
ORDER BY $id
```

実 serializer 形:

```text
製品名 = "牛乳"
```

LIKE leaf は query に含めない。

---

## 9. EXPLAIN 契約

### 9.1 実行と同一 plan

通常 EXPLAIN は、実行時と同じ metadata-aware fallback plan を構築する。

現行のように、実行では `buildKlikePushdownPlan(stmt, pushdownMeta)` を使い、表示では metadata なしの `buildKlikePushdownPlan(stmt)` を再構築する差を残してはならない。

次を同じ plan objectまたは同値の immutable planから取得する。

- `mainCondition`
- `joinConditions`
- `appliedKlikes`
- serializer query
- fetch scope
- relation
- candidate/pending state

### 9.2 CTE→APP 表示

§8.1 の SQLでは、概念上次を表示する。

```text
join pushdown plan: not applied (join key/WHERE prefilters are reported per source below)
join pushdown not applied: SOURCE_KIND
...
JOIN:          APP4228 AS t (4228)
kintone query: (日付 >= "2026-07-29" and 日付 <= "2026-08-04") and ((製品名 = "牛乳" and 個数 <= 100) and 入出庫区分 in ("出庫"))
fetch:         PREFILTERED
join key prefilter: range
pushdown applied: (日付 >= "2026-07-29" and 日付 <= "2026-08-04") and ((製品名 = "牛乳" and 個数 <= 100) and 入出庫区分 in ("出庫"))
relation: superset
```

既存 renderer の桁揃えは維持してよい。

`join pushdown plan: not applied` は、物理 APP だけの JOIN planner が source-kind gate により不適用であることを表す。per-source fallback prefilter が不適用という意味にしてはならない。

### 9.3 単一表表示

§8.3 の SQLでは次を表示する。

```text
kintone query: 製品名 = "牛乳"
fetch:         PREFILTERED
```

leaf 自体が exact であっても、LIKE residual があるため fetch を `EXACT` と表示してはならない。

### 9.4 dry-run

metadata APIを使わない dry-run では、確定 query と候補を区別する。

```text
pushdown candidate: 製品名 = "牛乳"（実行時の型・実在確認待ち）
```

CTE→APP の runtime join keyは、B150 の既存契約どおり runtime candidate として表示する。CTEの実値を取得するために SELECT や records API を実行してはならない。

---

## 10. B154 の同梱

B154 の表示整理をB155へ同梱する。

理由は次のとおりである。

1. B155 後も CTE/一時テーブルを含む JOIN は、直接 JOIN pushdown planner の `SOURCE_KIND` gateを通らない。
2. その一方で、JOIN key prefilter と WHERE per-alias prefilter は適用される。
3. `join pushdown plan: not applied` だけを見ると、B155で追加した prefilterまで不適用と誤読される。
4. 実行意味論を変えない短い表示変更であり、B155 の EXPLAIN 受入と同じテストで固定できる。

表示は次とする。

```text
join pushdown plan: not applied (join key/WHERE prefilters are reported per source below)
```

続く理由行は維持する。

```text
join pushdown not applied: SOURCE_KIND
```

B154 の独立起票は、B155 の実装・受入完了時に解決済みへ更新する。

---

## 11. 他の利用箇所と影響

### 11.1 `buildSingleTableKlikePushdownPlan`

利用箇所:

- `src/core/optimization/klikePushdownPlan.ts:45-56`

影響:

- 通常フィールドの安全 leaf が共有分類器へ拡張される。
- `appliedKlikes` の node identity は変えない。
- KLIKE の静的 variable 受理を維持する。

### 11.2 `buildKlikePushdownPlan.joinConditions`

利用箇所:

- `src/core/optimization/klikePushdownPlan.ts:81-96`

影響:

- CTE/一時テーブルを含む INNER JOIN の物理 APP 側へ、B151/B152 leaf が届く。
- outer join、aliasなし、subtable、物理 APP でない table は従来どおり除外する。

### 11.3 VALIDATE の prefilter

利用箇所:

- `src/execute.ts:1251-1271`

`VALIDATE ... WHERE` も `extractSafePushdownLeaves()` を使用するため、共有化の影響を受ける。

契約:

- VALIDATE の公開結果、エラー件数、明細、SUMMARYを変更しない。
- 元 WHERE は取得後に `evalWhere()` で再評価する。
- VALIDATE は引き続き read-only であり、PUT/POST/DELETEを行わない。
- 新しい leaf が安全 prefilter に使われても、B155 の公開機能追加とは扱わない。
- 少なくとも NUMBER inclusive、TEXT equality、選択系実在確認について prefilter有無の結果一致をテストする。

### 11.4 `extractNumericPushdownCandidates`

現行 production runtime の主要 metadata gate は `extractTypedPushdownCandidates()` であり、`extractNumericPushdownCandidates()` は独立した旧構文 helper として残っている。

契約:

- 削除する場合は全importとテストを整理する。
- 残す場合は「NUMBERの旧安全規則」ではなく、用途を名前・コメント・テストで限定する。
- metadata 要否判定の正として使用してはならない。

### 11.5 `extractTypedPushdownCandidates`

利用箇所:

- `src/execute.ts:3922-3934`
- `src/execute.ts:4032-4039`
- `src/execute.ts:10272-10290`
- `src/execute.ts:11652-11795`

影響:

- metadata loading
- JOIN key EXPLAIN の追加 WHERE query
- main/join の pending candidate表示
- fetch scope判定

すべて同じ構文候補 helperへ揃える。

---

## 12. 受入条件

### 12.1 分類器 parity

共有分類器の全既存対象について、次を table-driven test で確認する。

```text
direct JOIN classifier の relation != unsafe
⇔
metadata-aware safe extractor が同じ leaf を抽出する
```

例外は、明示された KLIKE静的検証互換と `$id` の経路固有互換だけとする。

少なくとも次を含める。

- NUMBER `=` / `!=` / `<>` / `<` / `>` / `<=` / `>=`
- NUMBER `IN` / `NOT IN`
- DATE/TIME/DATETIME比較
- TEXT/LINK equality、inequality、list
- 選択系の実在・非実在・空文字
- USER/ORGANIZATION/GROUP/STATUS_ASSIGNEE の現行分類
- RECORD_NUMBER/CALC の現行 superset
- canonical外 literal
- field-to-field
- arithmetic/function/CASE
- alias mismatch
- metadataなし
- KSQL合成型

### 12.2 CTE→APP の3 leaf合流

§8.1 の SQLを実行し、APP4228の records API query が次と逐語一致すること。

```text
(日付 >= "2026-07-29" and 日付 <= "2026-08-04") and ((製品名 = "牛乳" and 個数 <= 100) and 入出庫区分 in ("出庫"))
```

次の3 leafがすべて含まれること。

```text
製品名 = "牛乳"
個数 <= 100
入出庫区分 in ("出庫")
```

### 12.3 strict制限の消滅

同じ CTE→APP JOINで次をそれぞれ実行する。

```sql
WHERE t.個数 < 101
```

```sql
WHERE t.個数 <= 100
```

双方が対象 APP の WHERE prefilter に採用されること。

次を禁止する。

- `< 101` だけ採用
- `<= 100` を全件取得
- `<= 100` を `< 101` へ書き換え
- 一方だけ metadata candidate から漏れる

### 12.4 単一表 FULL_SCAN

次を実行する。

```sql
SELECT $id
FROM APP4228
WHERE 製品名 = '牛乳'
  AND 仕入先 LIKE 'zz'
ORDER BY $id
```

records API query:

```text
製品名 = "牛乳"
```

EXPLAIN fetch:

```text
PREFILTERED
```

`仕入先 LIKE 'zz'` はlocal residualとして評価されること。

### 12.5 3経路一致

同じ論理条件について、次の3経路の公開 rows が完全一致すること。

1. CTE/一時テーブル→APP JOIN の fallback per-alias prefilter
2. 物理 APP→物理 APP JOIN の runtime join pushdown
3. prefilterを無効化した FULL_SCAN後のlocal評価

比較対象:

- row count
- row values
- row orderを指定した場合の順序
- 空セル
- NUMBER境界
- TEXT値
- 選択系値

### 12.6 旧規則の回帰なし

少なくとも次を確認する。

```sql
WHERE t.個数 = 100
WHERE t.個数 < 101
WHERE t.個数 > 99
WHERE t.$id >= 1
WHERE t.入出庫区分 IN ('出庫')
```

B155 前に採用されていた leaf が不採用になってはならない。

### 12.7 KLIKE回帰

少なくとも次を確認する。

- 単一表 KLIKE
- INNER JOIN の対象alias KLIKE
- NOT KLIKE
- KLIKEを含むOR
- outer join
- 未解決batch variableの静的検証
- `appliedKlikes` identity
- 未適用KLIKEのfail-closed

通常leafの分類統一により、KLIKEの採用数または残余評価が変化してはならない。

### 12.8 選択系回帰

次を確認する。

- 実在選択肢だけの `IN`
- 実在選択肢だけの `NOT IN`
- equalityから正規化された `IN`
- 非実在値を含むlist
- 空文字を含むlist
- fieldOptionsなし
- STATUSでprocess metadataあり
- process metadataなしまたは無効

実在確認なしで選択系leafを送ってはならない。

### 12.9 EXPLAIN一致

実行時に送られる query と EXPLAIN の `kintone query:` / `pushdown applied:` が一致すること。

CTE→APP JOINでは次を同時に確認する。

- `join pushdown plan: not applied`
- B154注記
- `SOURCE_KIND`
- join key prefilter
- WHERE leafの合流
- `fetch: PREFILTERED`
- `relation: superset`

### 12.10 dry-run API 0回

CLIで次を実行する。

```text
node dist-cli/ksql.js --dry-run -e "<§8.1 の SQL>"
```

受入条件:

- exit code 0
- planを表示
- runtime candidateまたはmetadata pendingを明示
- records API 0回
- fields API 0回
- process/status API 0回
- CTE実体化のためのSELECT実行0回
- `DryRunError`なし

同じ条件を一時テーブル→APP JOINでも確認する。

### 12.11 VALIDATE非回帰

NUMBER inclusive、TEXT equality、LIKE residual併用について、prefilter有効/無効でVALIDATE結果が一致すること。

確認項目:

- detail rows
- SUMMARY
- errorRecords
- errorCount
- records API以外の書き込みAPI 0回

### 12.12 全surface

少なくとも次を確認する。

- engine library
- CLI
- CLI `--dry-run`
- MCP `ksql_explain`
- MCP query実行
- Firefox plugin
- Chrome plugin

ブラウザsurfaceは実機smokeをrelease gateとし、Node testだけで代替しない。

---

## 13. テスト要件

### 13.1 unit

更新または追加対象:

- `src/core/optimization/__tests__/wherePredicatePushdown.test.ts`
- `src/core/optimization/__tests__/joinPredicatePushdown.test.ts`
- `src/core/optimization/__tests__/b151NumberPushdown.test.ts`
- `src/core/optimization/__tests__/b152DateTextPushdown.test.ts`
- `src/core/optimization/__tests__/klikePushdownPlan.test.ts`

必須内容:

- 共有leaf policyの型別matrix
- JOIN classifierとのparity
- NUMBER inclusive
- TEXT equality
- DATE range
- metadataなしfail-closed
- 選択肢実在確認
- KLIKE/$id互換
- AND/GROUP抽出
- OR/NOT除外
- alias ownership

### 13.2 integration

B155専用acceptance testを追加する。

必須ケース:

1. CTE→APP range + TEXT `=` + NUMBER `<=` + selection
2. 一時テーブル→APPの同形
3. `< 101`
4. `<= 100`
5. 単一表 TEXT `=` + LIKE residual
6. prefilter有効/無効のrows一致
7. 物理→物理JOINとの一致
8. EXPLAIN実query一致
9. B154注記
10. metadata API callの対象APP限定

### 13.3 dry-run e2e

既存 `src/cli/__tests__/b150_dry_run.e2e.test.ts` にB155形を追加するか、B155専用e2eを追加する。

API rejecting clientを使い、1回でもAPIへ到達したら失敗させる。

### 13.4 回帰全体

最低限次を通す。

```text
npm test
npm run build
npm run build:cli
```

repositoryに既存のlint/typecheck専用commandがある場合はそれも通す。

---

## 14. Claude が実測すべき項目

### 14.1 修正前の決定的再現

同じ CTE→APP JOINで次を実行し、v3.61.0の差を記録する。

```text
個数 < 101  → 合流する
個数 <= 100 → 合流しない
```

記録項目:

- SQL全文
- EXPLAIN全文
- 実records API query
- row count
- APP revision
- kSQL version

### 14.2 修正後の合流

§8.1 の SQLを実行し、次を記録する。

- 実records API query
- DATE range
- `製品名 = "牛乳"`
- `個数 <= 100`
- `入出庫区分 in ("出庫")`
- fetch scope
- relation
- rows

### 14.3 単一表

§8.3 の SQLについて、修正前後のqueryを記録する。

期待:

```text
修正前: (全件取得)
修正後: 製品名 = "牛乳"
```

rowsが一致すること。

### 14.4 3経路

同じデータ・条件について次を比較する。

- CTE→APP
- 物理→物理
- local FULL_SCAN

差がある場合、B155を完了扱いにしない。

### 14.5 KLIKE/選択系

次を実機で確認する。

- KLIKEを含む既存query
- 選択系equalityのB126正規化
- 実在選択肢
- 非実在選択肢
- STATUSのprocess metadata

### 14.6 dry-run

CLI `--dry-run` と MCP `ksql_explain` の双方で、CTE→APPおよび一時テーブル→APPを確認する。

CLI `--dry-run` はAPI 0回を計測する。

### 14.7 ブラウザ

Firefox/Chrome pluginで次を確認する。

- CTE→APP query
- 単一表LIKE併用query
- EXPLAIN
- rows一致
- 生のkintone errorなし

---

## 15. Phase線引き

### 15.1 本仕様に含めるもの

- 共有leaf policyの抽出
- `classifyJoinPushdownLeaf()` から共有policyへの接続
- fallback safe extractorから共有policyへの接続
- metadata構文候補の拡張
- CTE/一時テーブル→APP per-alias prefilter
- 単一表FULL_SCAN prefilter
- runtimeとEXPLAINのplan一致
- relation/fetch表示
- B154注記
- VALIDATE利用箇所の非回帰
- KLIKE、`$id`、選択系の非回帰
- dry-run API 0回
- unit/integration/e2e/実機受入

### 15.2 本仕様に含めないもの

- B151/B152の型×演算子表の変更
- B84公開表の変更
- LIKE / NOT LIKEのserver pushdown
- outer joinの新規pushdown
- CTE/一時テーブル自体へのquery pushdown
- JOIN source-kind gateの撤廃
- JOIN key IN/range選択アルゴリズムの変更
- NUMBER widening
- DATE/TIME/DATETIME literal policyの変更
- KLIKE意味論の変更
- `$id`演算子の追加
- 選択系の実在検証撤廃
- server-only functionの新規開放
- DMLのpushdown規則変更
- 公開result schemaの変更

### 15.3 B84を変更しない理由

B155は分類器の判定結果を変えず、その判定が届く実行経路を増やす。

したがってB84の型×演算子表は変更しない。必要なのは、B155起票、issue tracker、release historyへ「経路間の分類器統一」を記録することだけである。

---

## 16. 実装順序

### Step 1: 共有leaf policy

- 現行 `classifySupportedLeaf()` をownership非依存の入力へ整理
- 型×演算子一覧を1か所へ集約
- JOIN classifierの既存testをgreenに保つ

### Step 2: metadata候補

- metadata前の構文候補helperを共有側へ追加
- `extractTypedPushdownCandidates()` を接続
- B151/B152全対象のmetadata要否をtest
- B150 dry-run API 0回を維持

### Step 3: fallback extractor

- alias/unqualified gate後に共有policyを呼ぶ
- KLIKEと`$id`の既存互換を維持
- selection optionsを橋渡し
- AND/GROUPの再構成を維持

### Step 4: runtime

- CTE/一時テーブルを含むJOINの`joinConditions`
- 単一表の`mainCondition`
- JOIN key queryとのAND合成
- residual WHERE再評価
- VALIDATE非回帰

### Step 5: EXPLAIN/B154

- runtimeと同じmetadata-aware fallback planを使用
- query、fetch、relationを同期
- B154注記を追加
- pending candidateと確定planを区別

### Step 6: 受入

- 修正前failを確認
- unit/integration/e2e
- build
- CLI/MCP
- Claude実機
- Firefox/Chrome smoke
- issue tracker/release history同期

---

## 17. 完了条件

B155は次をすべて満たした場合だけ完了とする。

1. 通常フィールドの型×演算子規則が単一の共有leaf policyに集約されている。
2. `wherePredicatePushdown.ts` にB151/B152の型一覧を複製していない。
3. `JoinPushdownSource` と `SafePushdownOptions` のmetadata橋渡しが明示されている。
4. CTE→APP JOINでTEXT `=`、NUMBER `<=`、選択系条件がrange prefilterへ合流する。
5. 一時テーブル→APP JOINでも同じ結果になる。
6. 単一表FULL_SCANでTEXT `=` がLIKE residualとは独立してprefilterになる。
7. `< 101` と `<= 100` が同じ経路で採用される。
8. NUMBER式を書き換えず、そのままserializerへ渡す。
9. 物理→物理、CTE/一時テーブル→APP、local FULL_SCANのrowsが一致する。
10. 元WHEREの残余再評価が維持される。
11. KLIKEの採用、identity、fail-closedが回帰しない。
12. `$id`の既存受理が回帰しない。
13. 選択系の実在確認が回帰しない。
14. B126正規化後ASTを使い、選択系規則を複製しない。
15. metadata要否判定がTEXT、DATE/TIME/DATETIME、NUMBER inclusive等を検出する。
16. metadata未解決leafを確定pushdownとして表示しない。
17. 実行queryとEXPLAIN queryが一致する。
18. 単一表のresidualありfetchを`PREFILTERED`と表示する。
19. rangeとexact leafの合成relationを`superset`と表示する。
20. B154注記により、直接JOIN planとper-source prefilterを区別できる。
21. CLI `--dry-run` がAPI 0回で成功する。
22. MCP `ksql_explain` がrecords API 0回で成功する。
23. VALIDATEの公開結果とread-only契約が変わらない。
24. B84公開表を変更していない。
25. 全unit/integration/e2e/buildが成功する。
26. Claude実機で必須SQLと実serializer queryを確認する。
27. Firefox/Chrome plugin smokeが成功する。
28. 実測不一致のleafを、期限や推測を理由に採用状態へ残さない。