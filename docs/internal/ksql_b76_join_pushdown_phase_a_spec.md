# B76 — JOIN 述語押し下げ Phase A 仕様 R1

- 作成: 2026-07-27（codex、Step 0 調査結果）
- ステータス: **R1（レビュー待ち・未実装）**
- 対象バージョン基準: **v3.25.0**
- 親計画: [B76 実装計画](ksql_b76_join_predicate_pushdown_impl_plan.md) §0.3
- 関連評価: [B76 extension evaluation](ksql_b76_join_predicate_pushdown_extension_evaluation.md) §2.4
- 履歴資料: [perf-where-pushdown-join.md](perf-where-pushdown-join.md)（**設計根拠に使わない**）

## 1. 目的

INNER JOIN を含む SELECT で、各物理 APP に属する WHERE 条件を kintone records API の
プレフィルタへ安全に押し下げ、JOIN 前の取得行数を減らす。

確定方針は **A-2'（ハイブリッド）**である。

1. WHERE を物理 APP の別名スコープごとに分解する。
2. `whereCapability` は REST 受理性・型妥当性の判定に使う。
3. `wherePredicatePushdown` が担う超集合性、選択肢実在検証、KLIKE node identity の契約を維持する。
4. 通常述語について、**元 WHERE 全体を client residual として残す**。
5. Phase A では通常述語を residual から除去しない。既存 KLIKE の applied-node 処理だけを例外として維持する。

目標は次であり、「単一表で押し下げられる全述語を JOIN でも無条件に押す」ことではない。

> JOIN 前に送る各サーバー条件の一致集合が、元の JS 条件を満たし得る対象 APP 行の集合を
> 欠落させない。取得後は元 WHERE を再評価して最終結果を確定する。

## 2. 不変条件

### 2.1 集合不変条件

対象 APP `T`、押し下げ条件 `P_T`、元 WHERE の JS 評価で必要となる `T` 行の集合 `J_T`、
kintone が `P_T` で返す集合 `K_T` とする。

Phase A の採用条件は **`K_T ⊇ J_T`** である。`K_T = J_T` は性能上望ましいが、
通常述語の採用条件ではない。`K_T ⊂ J_T` になり得る条件は、residual を残しても回復不能なので採用しない。

| 分類 | 集合関係 | Phase A の扱い | residual |
|---|---|---|---|
| `exact` | `K_T = J_T` を証明済み | 押し下げ可 | 通常述語は残す |
| `superset` | `K_T ⊃ J_T` または equality 未証明だが `K_T ⊇ J_T` を証明済み | 押し下げ可 | **必須** |
| `unsafe` | `K_T ⊇ J_T` を証明できない、REST 拒否、または対象 APP を一意に定められない | 押し下げ不可 | 元 WHERE で評価 |

`exact` の証明が必須になるのは次の場合だけである。

- その node を residual から除去する。
- KLIKE のように JS evaluator が意味論を持たず、サーバー適用済み node として消費する。
- 相対日付・`TODAY()` / `NOW()` / `LOGINUSER()` のような server-only node を client 評価から除く。
- 完全な候補集合を前提に top-N、更新対象、集計結果などを確定する。

Phase A の通常リテラル述語は residual から除去しないため、`superset` で足りる。
server-only 関数は Phase B まで解禁しない。

### 2.2 契約を統合しない

`whereCapability.EXACT_PUSHDOWN` と本仕様の `exact` は同じ契約ではない。

| 契約 | 答える問い |
|---|---|
| `whereCapability` | 解決済み field type と operator の組合せを kintone REST へ直列化できるか。単一表計画を server-only として扱えるか |
| JOIN set relation | 特定 APP へ送る条件が、JOIN 後の JS 評価に必要な行を欠落させないか。residual を除去できるほど同値か |

JOIN residual 除去には `whereCapability.EXACT_PUSHDOWN` に加え、少なくとも次の証明が要る。

1. field reference の所有 APP と別名が一意である。
2. server と `evalWhere` の型別比較が完全同値である。
3. `OR` / `NOT` / `GROUP` を含む tree 合成後も完全同値である。
4. 変数・subquery 解決後 AST と、serialize・fetch・residual が同一 node/plan を参照する。
5. 外部結合なら nullability provenance を含めて意味保存される。
6. `maxRecords`、truncate、検索打ち切りで母集合が欠けていない。

Phase A は通常述語について 2〜6 の完全証明を要求する residual 除去を行わない。

## 3. スコープ

### 3.1 対象

- SELECT の **INNER JOIN**。
- main table と JOIN table が、別名を持つ直接の物理 APP である場合。
- WHERE の解決済み AST にある、単一 APP だけを参照する条件。
- AND 因子、または同一 APP 内で完結し subtree 全体が `exact` / `superset` と証明できる
  OR / GROUP subtree。
- §5 の Phase A 対応表で `exact` または `superset` の条件。
- 既存の NUMBER / `$id` / 選択系 IN / KLIKE 契約の非回帰。

### 3.2 明示的な対象外

- LEFT / RIGHT JOIN と、複数 JOIN における nullability provenance。
- 相対日付 12 関数、`TODAY()`、`NOW()`、`LOGINUSER()` の JOIN 解禁。
- CTE・一時表・subtable virtual table を物理 APP とみなした押し下げ。
- cross-table predicate（例 `a.x = b.y`）の server 条件化。
- 構造的 `NOT` subtree の新規押し下げ。
- LIKE / NOT LIKE の native query 再解禁。
- 一般 NUMBER の `>=` / `<=`、厳密 10 進比較の新設。
- 通常リテラル述語の residual 除去。
- DML、VALIDATE、REORDER、KORDER の能力拡張。

単一 CTE のインライン化で最終的に直接の物理 APP SELECT へ変換される既存経路も、
Phase A の新規対象には含めない。effective AST の同一性を別途証明するまでは現行挙動を維持する。

## 4. 現行コード監査

### 4.1 確認できた構造

- `whereToKintone.convertField()` は `field.field` だけを引用し、table alias を出力しない。
  したがって serializer 単体では送信先 APP の正しさを保証できない。
- `extractSafePushdownLeaves()` は AND spine と GROUP だけをたどり、OR / NOT / EXISTS /
  NULL_CHECK / BOOLEAN を subtree ごと除外する。
- 一般 NUMBER は型メタ確定後の `=` と strict `<` / `>`、`$id` は
  `=` / `<` / `>` / `<=` / `>=` を扱う。
- 選択系 IN / NOT IN は field type と全 literal の実在選択肢を確認する。
- KLIKE は押し下げた AST node の参照同一性を `appliedKlikes` で共有し、
  集合外 node が `evalWhere` に到達すると fail-closed になる。
- `evalWhere` は JOIN 後に元 WHERE を評価する。通常の押し下げ leaf は残余から消していない。

### 4.2 Claude 実測との食い違い

DATE `=`、TEXT `=` が JOIN では全件取得になる点、NUMBER が個別に押し下がる点、
alias を serializer が捨てる点は現行コードと一致する。

一方、次の前提は現行 v3.25.0 ソースと一致しない。

> JOIN 側の押し下げ呼び出しに `fieldTypes` が渡されていないため、DROP_DOWN IN は全件取得になる。

候補検出の `extractTypedPushdownCandidates(..., { tableAlias })` 自体は型メタを受けないが、
runtime は候補 APP の `fieldTypes` / `fieldOptions` を取得し、
`buildKlikePushdownPlan()` から JOIN alias ごとの `extractSafePushdownLeaves()` へ渡している。
既存テスト
`FULL_SCAN JOIN: 各アプリの実在選択系 IN を別々に押し下げる`
も、DROP_DOWN と CHECK_BOX を両 APP へ個別送信することを固定している。
Step 0 では当該テストだけを v3.25.0 worktree で再実行し、PASS
（1 suite / 1 test、他329件は filter により skip）を確認した。

したがって R1 は次のように扱う。

- Claude の実機観測は負の回帰 fixture として残し、同じ SQL・schema・実行面・配布物版数で再現確認する。
- Phase A の根因を「JOIN runtime に型メタ配線が無い」とは定義しない。
- 新 plan でも候補検出と runtime 型メタ確定を分け、EXPLAIN が未確定候補を確定 query と表示しない。

## 5. 型 × 演算子 × exact / superset / unsafe

### 5.1 記号と共通前提

- `E`: exact
- `S`: superset
- `U`: unsafe（Phase A では押し下げない）
- 表は **物理 APP、解決済み literal、単一 alias、INNER JOIN、元 WHERE residual 維持**
  を前提とする。
- `whereCapability` が REST 非対応・型不正・field unresolved と判定した場合は、
  表が `E` / `S` でも `U` へ降格する。
- 空文字、非実在選択肢、未解決変数、subquery、field-to-field RHS は個別注記がない限り `U`。
- `LIKE` / `NOT LIKE` は全型で `U`。KLIKE と混同しない。

### 5.2 中核対応表

| field type | `=` | `!=` / `<>` | `<` / `>` | `<=` / `>=` | `IN` | `NOT IN` | `KLIKE` / `NOT KLIKE` | 根拠・制限 |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `$id` / `__ID__` | E | U | E | E | U | U | U | 正の安全整数 domain。現行 safe leaf を維持 |
| RECORD_NUMBER | E | U | E | E | U | U | U | `$id` と同じ canonical record-number domain と証明できる場合だけ |
| NUMBER | S | U | S* | U | U | U | U | `*` strict `<` / `>` かつ右辺が安全整数。IEEE-754 境界のため inclusive は不可 |
| CALC | U | U | U | U | U | U | U | 表示・計算精度を NUMBER と同一視する根拠が不足 |
| SINGLE_LINE_TEXT | S | U | U | U | U | U | E† | `=` は JS の byte/code-point equality が真なら同 literal の server equality も真となる方向だけを採用。正規化同値は主張しない |
| LINK | U | U | U | U | U | U | E† | TEXT `=` へ一般化しない |
| MULTI_LINE_TEXT / RICH_TEXT | U | U | U | U | U | U | E† | native KLIKE 以外は Phase A 対象外 |
| DATE | S | U | U | U | U | U | U | canonical literal `=` のみ。range は空セル境界の包含性未証明 |
| TIME | S | U | U | U | U | U | U | canonical literal `=` のみ |
| DATETIME | S | U | U | U | U | U | U | canonical API value と literal の `=` のみ。TZ 同値までは主張しない |
| CREATED_TIME / UPDATED_TIME | S | U | U | U | U | U | U | DATETIME と同じ |
| DROP_DOWN / RADIO_BUTTON | U | U | U | U | E* | E* | U | `*` 全 literal が空でなく optionOrder に実在 |
| CHECK_BOX / MULTI_SELECT | U | U | U | U | E* | E* | U | `*` 全 literal 実在。空配列を含む既存 JS 契約を維持 |
| STATUS | U | U | U | U | E* | E* | U | process enabled、states 取得成功、全 literal 実在 |
| CREATOR / MODIFIER | U | U | U | U | U | U | U | LOGINUSER は Phase B。literal user directory の静的実在証明なし |
| USER_SELECT / ORGANIZATION_SELECT / GROUP_SELECT | U | U | U | U | U | U | U | directory 実在値を field metadata だけで検証できない |
| FILE | U | U | U | U | U | U | E† | `†` 現行 native KLIKE 適用済み node identity を維持 |
| STATUS_ASSIGNEE / CATEGORY / subtable system fields | U | U | U | U | U | U | U | 新規 JOIN 押し下げ対象外 |
| 型不明・CTE/temp synthetic type | U | U | U | U | U | U | U | fail-closed |

`E†` は「同じ predicate を JS が再計算して exact」という意味ではない。
KLIKE は JS 意味論を持たないため、server へ実際に適用した同一 AST node を
`appliedKlikes` で消費する既存 server-only exact 契約である。clone / reparse node は別 node とみなし、
集合外 KLIKE が残余評価へ到達したらエラーにする。

### 5.3 なぜ `S` で足りるか

例として `a.担当者 = '佐藤'` を server equality へ送り、その server 集合が JS equality より広くても、
JOIN 後に元 WHERE が `evalWhere` で再評価されるため余分な行は落ちる。
逆に `a.担当者 != '佐藤'` は equality の補集合であり、equality が広い場合に必要行を server が落とす。
よって `=` の `S` から `!=` の安全性は導けず、`U` とする。

### 5.4 tree 合成

| AST | 合成規則 |
|---|---|
| `A AND B` | 同じ target alias に属する採用可能因子を個別抽出可。E∧E=E、それ以外の E/S の積は S |
| `A OR B` | **subtree 全体**が同一 target alias で、両辺とも E/S の場合だけ採用。E∨E=E、それ以外は S |
| cross-alias `OR` | 片辺だけを押さない。subtree 全体 U |
| `GROUP(A)` | scope と relation を変えず、括弧を保持 |
| `NOT(A)` | Phase A の新規対象外。superset の補集合は subset になり得る |
| cross-table binary | U。JOIN 後 residual 専用 |
| NULL_CHECK / EXISTS / BOOLEAN | Phase A の新規対象外 |

同一 alias OR の一部に LOCAL_ONLY / UNSUPPORTED / U がある場合、OR 全体を押さない。
AND は他 alias、cross-table、local-only の因子が混在しても、安全な単一 alias 因子だけを押せる。

## 6. 別名スコープ分解と serializer 安全規則

### 6.1 ownership 解決

pushdown plan を作る前に、全物理 source の field schema から各 `FIELD` を次の3値に解決する。

| 解決 | 扱い |
|---|---|
| `OWNED(alias, appId, fieldCode)` | target alias の候補になれる |
| `AMBIGUOUS` | 押し下げ不可。既存 planner が曖昧参照を拒否する文脈ではその拒否を維持 |
| `UNKNOWN` | 押し下げ不可。既存 unknown-field 検査を迂回しない |

修飾 field は alias と物理 source の対応、かつその APP に fieldCode が実在することを確認する。
非修飾 field は全 JOIN source のうち fieldCode を持つ source が **ちょうど1つ**の場合だけ
`OWNED` とする。0 または2以上なら serializer に渡さない。

### 6.2 `whereToKintone` の alias 消失への対処

`whereToKintone` 自体に target APP を推測させない。plan item は必ず次を保持する。

```ts
interface JoinPushdownItem {
  targetAlias: string;
  appId: number;
  predicate: WhereExpr;
  relation: "exact" | "superset";
}
```

serializer 呼び出し前に predicate 内の全 field が item の `targetAlias` / `appId` に
`OWNED` と解決済みであることを再検査する。異なる alias、非一意非修飾 field、field-to-field RHS が
1つでもあれば内部エラーとして fail-loud にする。alias を黙って捨てて別 APP へ送る状態を許さない。

両 APP に同名 field がある正例・負例を必須回帰にする。

## 7. 計画生成・runtime・EXPLAIN

### 7.1 一つの生成済み plan

候補検出、型・選択肢メタ取得、ownership、set relation、KLIKE identity をまとめた
immutable `JoinPushdownPlan` を一度生成し、次が同じ object を参照する。

- validation / fail-closed gate
- main / join records fetch
- `appliedKlikes`
- residual evaluator
- EXPLAIN renderer

EXPLAIN 専用の別抽出ロジックを安全判定の真実にしない。metadata 未取得の静的 EXPLAIN は
`candidate` と表示し、`kintone query` / `applied` と表示しない。
schema-aware EXPLAIN と runtime は同じ解決済み AST と plan builder を使う。

表示必須項目:

- target APP / alias
- server prefilter query
- relation (`exact` / `superset`)
- residual (`original WHERE` / KLIKE applied node count)
- 非採用 subtree と reason（cross-alias OR、ambiguous field、unsafe relation、source kind 等）
- runtime metadata requirement

### 7.2 解決タイミング

1. parser / CTE 既存処理
2. batch scalar/list variable の置換
3. IN/scalar subquery の解決
4. effective SELECT AST の確定
5. field schema、選択肢、STATUS metadata の必要分取得
6. `JoinPushdownPlan` を生成
7. validate → fetch → JOIN → 元 WHERE residual

未解決 variable を runtime plan へ通さない。静的検証で候補扱いした flag
（例 `allowUnresolvedVariables`）を runtime が黙って継承・無視しない。
各 flag は true / false のテストを持つ。

### 7.3 CTE・temp・subtable

- materialized CTE / temp / subtable source は pushdown target にならない。
- それらと物理 APP の INNER JOIN でも、物理 APP にだけ属する安全な AND 因子は、
  cross-source OR を含まない場合に限り候補にできる。ただし Phase A R1 はこの混在経路を対象外とし、
  新 plan を配線しない。
- CTE inline 前後で node identity が変わる経路は既存 KLIKE 契約を維持し、
  Phase A の新規 subtree pushdown を行わない。

## 8. limits・検索打ち切り・失敗時契約

- B76 固有の `maxRecords` / `onLimit=truncate` 非対称を追加しない。
- JOIN、local ORDER、aggregate 等が既に完全入力を要求する場合、その既存 policy を維持する。
- truncate が既存契約上許される経路では、「押し下げなし全件 JS」との完全結果同値を
  truncate 後の部分集合にまで主張しない。EXPLAIN は既存 limit policy を併記する。
- `searchAborted:true` は母集合欠落なので fail-closed。警告だけで結果を確定しない。
- metadata 取得失敗は records fetch 前に伝播し、「型不明なので全件取得」に黙ってフォールバックしない。
- serializer ownership guard、KLIKE unapplied gate、server-only function guard の失敗後は records /
  cursor / mutation 0、retry 0。

## 9. Step 0 — 18 論点の決着表

| # | 出典 | 論点 | R1 決着 |
|---:|---|---|---|
| 1 | §0.2-1 | OR 跨ぎ | cross-alias OR は全体非押し下げ。同一 alias OR は全 subtree が E/S の場合だけ丸ごと押す |
| 2 | §0.2-2 | cross-table predicate | JOIN 後 residual 専用。片側 APP へ変形しない |
| 3 | §0.2-3 | NOT / GROUP | GROUP は透過し括弧保持。構造的 NOT の新規押し下げは Phase A 対象外 |
| 4 | §0.2-4 | capability 合成 | `whereCapability` と JOIN relation の両方を満たす。AND/OR の E/S 合成は §5.4、U 混在 OR は全体 U |
| 5 | §0.2-5 | residual | 通常述語は元 WHERE 全体を残す。Phase A で除去しない。既存 KLIKE identity だけ例外 |
| 6 | §0.2-6 | 外部結合 non-nullable 側 | LEFT/RIGHT 全体を Phase A 対象外。扱うなら B6 再オープンと複数 JOIN provenance が必要 |
| 7 | §0.3.6-1 | `EXACT_PUSHDOWN` と residual 除去 | 別契約。ownership、server/JS 同値、tree、node identity、nullability、完全入力の追加証明が必要 |
| 8 | §0.3.6-2 | exact / superset / unsafe 表 | §5 で確定。通常 Phase A は S で採用可、U は不可 |
| 9 | §0.3.6-3 | NUMBER・IEEE-754・inclusive | 一般 NUMBER は `=` と strict `<`/`>`安全整数だけ S。`>=`/`<=` は U。`$id`/record number は E |
| 10 | §0.3.6-4 | 選択系実在値・GAIA | optionOrder / process states で全値実在を確認できる5型だけ E。空・非実在・directory型は U |
| 11 | §0.3.6-5 | KLIKE identity / gate | 現行 identity 集合を維持。plan と fetch/eval が同じ node を共有し、unapplied は fail-closed |
| 12 | §0.3.6-6 | JOIN 非修飾 field | schema 上ちょうど1 source に実在するときだけ owner を付与。曖昧・unknown は押し下げ不可 |
| 13 | §0.3.6-7 | CTE・temp・subtable・inline AST | 新規対象外。effective AST / identity を別 Phase で証明する |
| 14 | §0.3.6-8 | INNER / LEFT / RIGHT nullability | Phase A は INNER の直接物理 APP のみ。LEFT/RIGHT provenance は B6 領域へ切り出す |
| 15 | §0.3.6-9 | EXPLAIN / runtime 同一 plan | immutable plan を validate/fetch/eval/EXPLAIN で共有。静的候補を applied と表示しない |
| 16 | §0.3.6-10 | maxRecords / truncate / SearchAborted | 既存 complete-input policy を維持し固有非対称を足さない。SearchAborted は fail-closed |
| 17 | §0.3.6-11 | variable / subquery 後の再計画 | 全置換・解決後に一度だけ runtime plan を生成。未解決許可 flag を runtime で黙って無視しない |
| 18 | §0.3.6-12 | 負の回帰 | 非実在選択肢、同名 field、複数 JOIN、LEFT/RIGHT、cross-OR、NOT、unapplied KLIKE を必須化 |

18点はすべて決着した。未証明領域は「保留」ではなく Phase A 対象外として明示した。

## 10. 実装 Step

| Step | 内容 | 単独 merge の安全性 | 見積 |
|---|---|---|---:|
| 1. plan 型・ownership・relation 基盤 | immutable plan、alias/app/field owner resolver、E/S/U classifier、tree 合成 unit test。runtime 未配線 | 公開挙動不変で単独 merge 可 | 0.75〜1.0 人日 |
| 2. A-1 相当の限定 leaf | INNER JOIN・単一 alias AND leaf に DATE/TIME/DATETIME系 `=` と SINGLE_LINE_TEXT `=` を S として追加。型メタ、serializer ownership guard、元 WHERE residual 維持、records fetch を**同一 merge** | classifier だけ先行、または residual/guard なしの runtime 先行は禁止 | 1.0〜1.5 人日 |
| 3. A-2' subtree 分解 | 同一 alias OR/GROUP、AND 因子分離、main/join 両 APP、選択系/KLIKE plan 統合、validate/fetch/eval の plan 共有を**同一 merge** | scope 分解と target ownership、serializer guard、runtime 使用は分けない | 1.5〜2.5 人日 |
| 4. EXPLAIN・limits・負例 | runtime plan renderer、candidate/applied 分離、変数/subquery 後、SearchAborted、同名/複数 JOIN/外部 JOIN 回帰 | 公開意味論は Steps 2〜3 と同じ | 0.75〜1.0 人日 |
| 5. parity・docs・release gate | CLI/MCP/Firefox/Chrome、language reference、CHANGELOG、tracker、配布物 smoke | release 前必須 | 1.0〜1.5 人日 |

実装合計は **5〜8 人日**。Step 0・本 R1 は親計画どおり **3〜5 人日**、
Phase A 全体は **8〜13 人日**を維持する。

### 10.1 A-1 を先行段階にする是非

**価値はある。** 理由は次のとおり。

- 単一 alias AND leaf、residual 維持という小さい安全境界で、DATE/TEXT の実用効果を先に検証できる。
- A-2' の ownership / set relation / metadata 配線を小さい tree で先に固められる。
- v2.0.0 LIKE 事故と同様の広域緩和を避け、before 全件取得 → after prefilter＋同一 rows を示しやすい。

ただし、A-1 を別製品方針として固定したり、旧抽出器へ ad hoc な型分岐だけを足したりしない。
Step 2 は A-2' plan 基盤上の先行段階である。4面と実機 gate を満たせば単独リリース可能だが、
gate の二重実施コストを踏まえ、既定は同じ Phase A release 内の中間 merge とする。

## 11. 受入条件

### 11.1 正例・集合 parity

1. Claude 実測と同じ DATE `=` / TEXT `=` は、対象 APP query にだけ入り、全件 JS baseline と最終 rows が一致する。
2. 両側 NUMBER の既存個別押し下げが同じ query byte と rows を維持する。
3. JOIN 両側の実在 DROP_DOWN / CHECK_BOX IN が各 APP へ個別に入り、現行 v3.25.0 テストを維持する。
4. 同一 alias `(a.DATE = '...' OR a.TEXT = '...')` は subtree 全体を一つの prefilter とし、元 WHERE で再評価する。
5. `$id`、NUMBER 空セル、NUMBER strict safe-integer 境界、選択系空配列の既存 semantics を維持する。
6. KLIKE applied node count と node identity が plan / fetch / eval で一致する。

集合 parity は打ち切りなしの同一 fixture について次を比較する。

- prefilter なしで全件取得＋元 WHERE を JS 評価した rows
- Phase A prefilter＋元 WHERE を JS 評価した rows

### 11.2 負例

7. `a.x = ... OR b.y = ...` は両 APP とも OR の片辺を送らない。
8. `a.x = b.y` はどちらにも送らない。
9. `NOT (...)` は新規条件を送らない。GROUP は意味を変えない。
10. 両 APP に同名 field がある非修飾 WHERE は誤った APP へ送らない。
11. 一意な非修飾 field だけが正しい APP owner へ解決される。
12. 非実在・空の選択肢は送らず、GAIA エラーを新たに発生させない。
13. LEFT / RIGHT JOIN は DATE/TEXT の新規 pushdown を行わず、KLIKE の既存拒否を維持する。
14. materialized CTE、temp、subtable source は新規 target にならない。
15. unresolved variable、subquery、scalar RHS、field RHS、unknown type は serializer に到達しない。
16. unapplied KLIKE、server-only 関数の residual 到達、ownership guard 違反は records API 前に fail-closed。

### 11.3 EXPLAIN

17. alias / APP / query / E-S relation / original residual / reason / metadata requirement を表示する。
18. runtime で実際に送る query と schema-aware EXPLAIN の applied query が一致する。
19. metadata 未取得の静的 EXPLAIN は候補と確定を分ける。
20. cross-alias OR、ambiguous field、outer join、source-kind 対象外の reason を表示する。
21. KLIKE applied/unapplied count と existing fail-closed reason を維持する。

### 11.4 B71 / B72 / B75 の教訓

22. records mock は request の `fields` だけを返す。全 field 常時返却 mock を正しさの証明に使わない。
23. 初回 records request の `fields` と `query` を同時に assert し、residual に必要な field を欠落させない。
24. B76 固有の `onLimit=truncate` 禁止を足さず、同じ literal query の既存 policy と揃える。
25. `allowUnresolvedVariables`、source-kind、outer-join、residual 等の引数・flag を黙って無視しない。
26. 各 flag の true / false、未指定を unit test する。
27. v2.0.0 LIKE 回帰として、LIKE / NOT LIKE は全型で server query に入らない。

### 11.5 4面 parity・回帰

| 面 | 必須確認 |
|---|---|
| CLI | rows、各 APP query、EXPLAIN、失敗 reason、API 0 |
| MCP | `ksql_validate`、`ksql_query`、`ksql_explain`、docs 記述 |
| Firefox plugin | 実 kintone schema で DATE/TEXT/選択系/同名 field/outer join |
| Chrome plugin | Firefox と同一 SQL、query、rows、reason |

ブラウザ実機 smoke は Node mock で代替しない。

回帰 gate:

- 全 unit / integration / snapshot
- 既存 KLIKE INNER JOIN と LEFT/RIGHT fail-closed
- B67/B72/B75/B77/B78 server-only function guard
- B26/B32 typed comparison
- B71 requested-fields projection mock
- SIMPLE SELECT の query byte
- SearchAborted / maxRecords / truncate

## 12. B6 却下との整合

B6 は、外部結合の non-nullable 側だけへ KLIKE を押すには結合順と nullability provenance が必要で、
誤ると P0 誤結果を再導入する一方、CTE / temp で安全な回避策があるため却下された。

B76 Phase A で DATE/TEXT に限って同じ領域を暗黙に開く根拠はない。
通常述語で residual を残しても、nullable / preserved side の誤判定によって server prefilter が
JOIN 前に必要行を落とせば回復できない。よって INNER JOIN 限定は妥当である。

外部結合を扱う場合は B6 を正式に再オープンし、複数 JOIN の各段階で
preserved / nullable side を追跡する provenance、KLIKE、通常述語、OR/NOT の意味保存を
同じ仕様と見積もりへ含める。親計画の **10〜16 人日**枠で別 Phase とする。

## 13. 見積もり再確認

親計画 §0.3.4 から変更しない。

| 作業 | 見積 |
|---|---:|
| Step 0・Phase A 詳細仕様 | 3〜5 人日 |
| Phase A 実装（INNER JOIN、residual 維持） | 5〜8 人日 |
| **Phase A 合計** | **8〜13 人日** |
| 外部結合まで含む別 Phase | 10〜16 人日 |
| Phase B（server-only 関数、INNER JOIN） | 5〜8 人日 |

現行 runtime に JOIN 選択系 metadata 配線が既に存在するため、その一点だけなら減算要因である。
しかし、ownership guard、E/S/U classifier、subtree plan、EXPLAIN/runtime plan 共有、
4面の負例が主要工数なので、全体レンジを下げる根拠にはしない。

## 14. 判断に迷った点

1. **DATE / DATETIME range**: `whereCapability` は REST 受理を認めるが、空セルと DATETIME TZ を含む
   server/JS 超集合性を本 Step 0 の repo evidence だけで証明できない。`=` の S だけに限定した。
2. **TEXT `=` の exact 性**: JS は code-point equality だが、kintone 側の正規化有無を exact と断言する
   実測表がない。JS exact match を server が落とさない方向だけを S とし、`!=` は除外した。
3. **RECORD_NUMBER**: current safe extractor は `$id` を特別扱いする。公開 RECORD_NUMBER field semantics が
   同じ canonical domain と保証される経路だけ E とし、実装時に `$id` alias との対応を固定する必要がある。
4. **Claude の DROP_DOWN 実測**: 現行コード・自動テストと反する。配布物、実行面、schema response、
   request fields/options の差を実機で再確認するまで、実測もテストも片方だけを消さない。
5. **A-1 のリリース単位**: 技術的には単独リリース可能だが、4面 gate を二度回す費用がある。
   R1 は中間 merge を既定とし、別リリースは実需と release cadence の判断に残した。

これらは確定方針を実現不能にするものではない。安全性を証明できない演算子・source・join type を
Phase A から明示的に外すことで、A-2' は実装可能である。
