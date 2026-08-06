# B148 仕様 R1 codex レビュー 1

- 実施: 2026-08-06（v3.56.3）
- 依頼: [レビュー依頼](ksql_b148_codex_review_request.md)
- 対象: [仕様 R1](ksql_b148_bare_column_group_by_spec.md)

**こちらの実測による検証は [§5](#5-実測による検証claude2026-08-06) に追記した。**

---

# 1. 結論

**実装着手不可。R2 で契約を確定してから着手すべきです。**

| 重大度 | 件数 |
|---|---:|
| Critical | 3 |
| High | 5 |
| Medium | 1 |

中核方針は妥当ですが、次の3点が未確定のままです。

1. schema-aware な同一性判定と、schema を読まない `ksql_validate` の受入条件が両立しない
2. `plainGroupByPlan` だけでは式・SELECT 側列参照の同一性を証明できない
3. `HAVING` にだけ集計がある形を、現行エンジンは集計クエリとして実行していない

コード変更、git 操作、MCP 実行、テスト実行は行っていません。

# 2. 指摘

## Critical 1: `ksql_validate` で「同じエラー」は実現不能

R1 は「同じ実体」を schema-aware に判定するとしています。`plainGroupByPlan` も物理フィールド解決のため source schema を要求し、実行時には `getFields` を呼びます。

- `docs/internal/ksql_b148_bare_column_group_by_spec.md:69-75`
- `src/core/optimization/plainGroupByPlan.ts:85-105`
- `src/execute.ts:2995-3039`

一方、`ksql_validate` の公開契約は「kintone API を呼ばない構文・静的検査」です。実装も parse と `analyzeBatch` だけです。

- `docs/internal/ksql_b148_bare_column_group_by_spec.md:128-129`
- `src/mcp/index.ts:139-147`
- `src/mcp/tools.ts:514-524`
- `src/mcp/schemas.ts:56-58`

したがって、次のようなケースを `ksql_validate` だけで確定できません。

```sql
SELECT DATE_FORMAT(x, '%Y') AS a, SUM(v)
FROM APP1
GROUP BY a
```

APP1 に物理フィールド `a` があれば `GROUP BY a` は物理フィールド、無ければ SELECT alias です。これはフォーム定義なしには判定不能です。

対応案:

- 案A: `ksql_validate` を metadata-aware に変更する
- 案B: static と schema-aware の二段階契約にする
- 案C: B148 を `ksql_validate` の対象外にする

**推奨は案B。** `ksql_validate` の既存契約を壊しません。

R2 文案:

> `ksql_validate` は AST だけで確定できる B148 違反を検出する。物理フィールドと SELECT alias の競合、JOIN の曖昧性、CTE・一時テーブルの出力 schema など metadata を要する判定は確定しない。`ksql_explain` と実行は schema-aware な同一判定を行い、レコード API 呼び出し前に同じ reason code の `ArgumentError` を返す。

「同じエラー」は、全文一致ではなく「同じエラー種別・reason code・違反箇所」と定義するのが安全です。

---

## Critical 2: `plainGroupByPlan` はそのままでは B148 判定に使えない

既存 plan が保持する情報は次のとおりです。

- `PHYSICAL`: source index / field code / runtime key
- `ALIAS_SAFE`: SELECT column index
- `EXPRESSION`: 種別だけで、式そのものや canonical identity は持たない

`src/core/optimization/plainGroupByPlan.ts:11-29,177-229,236-247`

したがって:

- `PHYSICAL` はフィールド同一性に利用可能
- `ALIAS_SAFE` は列 index から元 SELECT 式を引き直せる
- `EXPRESSION` は `stmt.groupBy[index]` と組み合わせなければ比較不能

さらに SELECT 列は、現在は解決 plan を通らず、投影時に文字列キーで読み出されます。

- `src/engine/process.ts:1250-1263`
- `src/engine/process.ts:1412-1415`
- `src/engine/evalFunc.ts:741-749`

JOIN 行は修飾キーと非修飾キーの両方を持つため、B148 で SELECT 側を単なる名前一致にすると source identity を失います。

- `src/engine/process.ts:96-109`
- `src/core/optimization/plainGroupByPlan.ts:182-205`

対応案:

- 案A: `plainGroupByPlan` の `EXPRESSION` に canonical expression を追加する
- 案B: plan と `stmt.groupBy[index]` から B148 専用の resolved grouping identity を構築する
- 案C: SELECT 名と GROUP BY 表記だけを比較する

**推奨は案B。** 既存 plan の公開形を不必要に変更せずに済みます。

推奨する判定モデルは次です。

```text
PHYSICAL
  → (sourceIndex, fieldCode)

ALIAS_SAFE
  → columnIndex の SELECT 式を canonicalize

EXPRESSION
  → 対応する GroupByKey の式を canonicalize
```

SELECT/HAVING の検査では:

1. 集計関数の内部は検査終了
2. スカラーサブクエリは外側から切り離し、内側 SELECT として別検査
3. 式全体が grouping expression と一致すれば許可
4. それ以外の物理フィールド参照は `(sourceIndex, fieldCode)` が grouping key と一致するときだけ許可
5. 不明・曖昧な参照は安全側にエラー

また、§8 の「物理フィールド優先 → SELECT alias」は **GROUP BY token の解決規則**です。SELECT 式内のフィールド参照を SELECT alias へ fallback させてはいけません。R1 自身も「同じ SELECT 句の alias は他の式から見えない」としています。

- `docs/ksql_language_reference.md:1432-1437`
- `docs/internal/ksql_b148_bare_column_group_by_spec.md:165-166`

---

## Critical 3: `HAVING` にだけ集計がある形と現行実行条件が一致しない

R1 は、`SELECT` または `HAVING` に集計があれば集計クエリと判定します。

`docs/internal/ksql_b148_bare_column_group_by_spec.md:60-63`

しかし実行時の `hasAggregateColumns` は SELECT 列だけを見ています。

`src/engine/process.ts:239-247`

グループ化開始条件も ordinary/grouping sets または SELECT 集計だけです。`HAVING` はその後に評価されます。

`src/engine/process.ts:1952-1985`

したがって、例えば次の有効形をR1の定義に含めると、B148 検査だけでなく実行意味論も直す必要があります。

```sql
SELECT '存在あり'
FROM APP1
HAVING COUNT(*) > 0
```

対応案:

- 案A: 集計クエリ判定を SELECT/HAVING 共通 helper にし、実行パイプラインも変更する
- 案B: Phase 1 は「SELECT に集計がある、または GROUP BY がある」に限定する
- 案C: HAVING-only 集計を別 issue とし、それまでは明示エラーにする

**推奨は案A。** 「標準 SQL に合わせる」という決定と整合します。ただし、B148 が単なる validator 追加ではなく、集計開始条件の変更も含むことを明記すべきです。

最低限、次を受入に追加してください。

```sql
SELECT 'ok' FROM APP1 HAVING COUNT(*) >= 0
-- 1グループとして正しく評価される

SELECT x FROM APP1 HAVING COUNT(*) >= 0
-- x が非集計なので B148 エラー
```

---

## High 1: 式の「構文的一致」の正規形が未定義

AST では空白は既に消え、`SUBSTR` は `SUBSTRING` に canonicalize されます。

- `src/parser/parser.ts:135-145`
- `src/types/ast.ts:357-377`

一方、数値リテラルは `value` と元表記 `raw` の両方を持ちます。

`src/types/ast.ts:641-657`

したがって `JSON.stringify(AST)` のような比較では、非意味的な `raw` や補助プロパティまで一致条件に入る危険があります。

対応案:

- 案A: AST の単純 deep equality
- 案B: 評価結果が同じ可能性のある式を代数的に同一視
- 案C: B148 専用の保守的 canonical structural key を定義

**推奨は案C。**

R2 文案:

> 式一致は canonical AST の構造一致とする。空白、キーワードの大小、parser が正規化する関数 alias、表示用情報、数値リテラルの非意味的表記は比較対象外とする。フィールド葉は文字列ではなく解決済み source identity で比較する。交換法則、定数畳み込み、CAST 省略などの代数的同値性は認めない。判定不能時は不一致とする。

安全性は「偽陰性を出さない」側、つまり不確実ならエラーを推奨します。

「別名経由だけを許す」案は非推奨です。R1 の受入と現行リファレンスが、直接式による grouping を明示的に契約しています。

- `docs/internal/ksql_b148_bare_column_group_by_spec.md:84-85`
- `docs/ksql_language_reference.md:1422-1430`

---

## High 2: CTE・一時テーブルを含む「レコード取得前」の意味が曖昧

AST 上は CTE、UNION、スカラーサブクエリ、一時テーブル source がそれぞれ入れ子の `SelectStatement` を持ちます。

- `src/types/ast.ts:97-101`
- `src/types/ast.ts:180-201`
- `src/types/ast.ts:405-415`
- `src/types/ast.ts:719-725`

通常実行には statement 全体を再帰 walk する preflight が既にあります。

`src/execute.ts:1048-1060,3111-3131`

ただし CTE は順に実体化してから最終 SELECT を実行します。

`src/execute.ts:5182-5207`

EXPLAIN では未実体化 CTE/temp の plain group plan を deferred としています。

`src/execute.ts:9897-9909,11121-11129`

そのため「レコード取得前」が次のどちらかで難易度が変わります。

- 違反している SELECT 自身が records API を呼ぶ前
- 文全体で records API が1回も呼ばれる前

対応案:

- 案A: 各 SELECT の取得前に検査
- 案B: 文全体を schema 推論し、CTE取得も含めて records API 0 回で拒否
- 案C: 物理 APP source は文全体 preflight、未実体化 schema は SELECT-local preflight

**推奨は案C。** ただし依頼元の典型例のように、CTE本体そのものが違反している場合は、再帰 walk によって CTE取得前に拒否することを必須にします。

R2 には適用単位を明記してください。

> B148 は AST 内の各 SelectStatement に独立して適用する。WITH の CTE 本体、最終 query、UNION の全 arm、スカラー／IN／EXISTS サブクエリ、CREATE TEMP TABLE の source、INSERT/UPSERT SELECT の source を含む。

なお `UPDATE ... FROM` は AST 上 `SelectStatement` を持たず、relation source を直接持つ別構造です。

`src/types/ast.ts:932-1045`

したがって「DML の SELECT 部（UPDATE FROM）」という表現は不正確です。B148 の対象は `INSERT_SELECT` / `UPSERT_SELECT`、`UPDATE FROM` は対象外または別規則、と書き分けるべきです。

---

## High 3: ordinary GROUP BY と拡張 grouping の受入が混ざっている

拡張 grouping は既に別の metadata-backed validator を持ち、SELECT/HAVING/ORDER BY の非集計依存を canonical physical identity で検査しています。

`src/core/groupingValidation.ts:241-305`

また、grouping item と `GROUPING()` 引数は物理 APP フィールド限定です。

- `docs/ksql_language_reference.md:1570-1573`
- `src/types/ast.ts:737-758`

`GROUPING()` の引数は「素の非集計参照」ではなく、grouping item membership を別規則で検証する特殊ノードです。

`src/core/groupingValidation.ts:151-165`

R1 §4.1 の「`GROUP BY ROLLUP(...)` の grouping item は通る」だけでは、何を観測する受入なのか不明瞭です。

対応案:

- 案A: ordinary と拡張 grouping を同一 validator に統合
- 案B: 拡張 grouping の既存 validator を維持し、B148 は ordinary/no-group を補完
- 案C: Phase 1 は ordinary のみ

**推奨は案B。** 既存の厳しい物理フィールド契約を崩さないためです。

受入は完全なSQLにしてください。

```sql
SELECT a, SUM(v) FROM APP1 GROUP BY ROLLUP(a)                 -- 通る
SELECT b, SUM(v) FROM APP1 GROUP BY ROLLUP(a)                 -- エラー
SELECT GROUPING(a), SUM(v) FROM APP1 GROUP BY ROLLUP(a)       -- 通る
SELECT GROUPING(b), SUM(v) FROM APP1 GROUP BY ROLLUP(a)       -- 既存 membership error
SELECT *, SUM(v) FROM APP1 GROUP BY ROLLUP(a)                 -- 既存 wildcard error
```

---

## High 4: ウィンドウ関数と ORDER BY-only 集計の契約が不足

ウィンドウ集計は AST 上 `WINDOW_COL` と通常集計 `AGGREGATE` で明確に分かれています。

`src/types/ast.ts:274-339`

現行 `hasAggregateColumns` も `WINDOW_COL` を集計開始条件に含めていません。これはR1の意図どおりです。

`src/engine/process.ts:239-247`

一方、`OrderByKey` には集計関数専用ノードがありません。

`src/types/ast.ts:765-770`

parser も最終的に返す order key は field/function/arithmetic/grouping のいずれかです。

`src/parser/parser.ts:3327-3368`

したがって `ORDER BY COUNT(*)` を「集計クエリ開始条件」に含めるには、現行 AST でどう保持されるかを先に確定する必要があります。R1 の「適用箇所は ORDER BY」と「Phase 1に入れるか未確定」も矛盾気味です。

- `docs/internal/ksql_b148_bare_column_group_by_spec.md:55-58`
- `docs/internal/ksql_b148_bare_column_group_by_spec.md:133-135`

対応案:

- 案A: ORDER BY を Phase 1 に含め、ASTも拡張する
- 案B: ORDER BY は「既に集計クエリと判定された場合の依存検査」だけ行い、ORDER BY 自身は集計開始条件にしない
- 案C: ORDER BY を全面的に Phase 2 へ送る

**推奨は案B。**

併せて、次を回帰受入へ追加してください。

```sql
SELECT SUM(v) OVER () AS total FROM APP1
-- 通る。ウィンドウだけでは B148 の集計クエリにならない
```

通常集計とウィンドウを併用した場合の、window argument / PARTITION BY / window ORDER BY が「集計前の列」か「集計後の出力」かも別途明記が必要です。

---

## High 5: adversarial case とエラー契約が不足

現在の §4.2 は基本形だけで、最も危険な alias/field 衝突、JOIN source identity、wildcard、入れ子スコープを止められません。

`docs/internal/ksql_b148_bare_column_group_by_spec.md:91-99`

最低限、次を追加すべきです。

| 入力の性質 | 期待 |
|---|---|
| 物理フィールド `年月` がある状態で `SELECT DATE_FORMAT(日付,...) AS 年月 ... GROUP BY 年月` | `GROUP BY` は物理 `年月`。DATE_FORMAT の `日付` が非キーならエラー |
| `GROUP BY l.a` に対する `SELECT r.a` | エラー |
| JOIN で両表に `a` がある `SELECT a ... GROUP BY l.a` | 曖昧参照エラー |
| `SELECT * , SUM(v)` / `_p.*` | エラー |
| `SELECT a + 1, SUM(v) ... GROUP BY a` | 通る |
| `SELECT DATE_FORMAT(x,'%m') ... GROUP BY DATE_FORMAT(x,'%Y')` | エラー |
| aggregate 内の `CASE WHEN b ...` | `b` は集計関数の内部なので通る |
| outer aggregate + scalar subquery | サブクエリ内部は別 SELECT として検査 |
| UNION | 各 arm を独立検査 |
| INSERT/UPSERT SELECT | source SELECT で同じエラー |
| 複数の違反列 | first error か全件列挙かを固定 |

エラー骨子も `GROUP BY` なしと式違反を扱えていません。

`docs/internal/ksql_b148_bare_column_group_by_spec.md:101-118,136`

特に `SELECT x + y` の違反に `MIN(x)` だけを案内すると式全体の修正になりません。

対応案:

- 案A: 最初の違反フィールドだけを名指し
- 案B: 違反する SELECT/HAVING 式と、その中の非キー列を併記
- 案C: 全違反を一括列挙

**推奨は案B。** 安定した first-error 契約にしつつ、利用者が式全体を直せます。

R2 文案:

> エラーは clause、違反式、非集計・非キーの物理列を示す。`GROUP BY` なしでは「全体が1グループになるため」と説明する。移行例は単純列なら `MIN(列)`、複合式なら `MIN(式)` を示す。GROUP BY 追加案は、追加後の完全な GROUP BY 句として示す。

受入条件自体は概ね観測可能です。「レコード取得前」も mock client の records API 呼出回数 `0` として観測可能です。ただし「同じ実体」や「plan を使う」は実装方法ではなく、公開結果の具体例へ落とす必要があります。

---

## Medium 1: プラグイン bundle の受入が不足

プラグインは `src/ui/desktop.ts` を `prod/js/desktop.js` へ bundle します。

`build.mjs:94-116`

manifest はその bundle をロードします。

`prod/manifest.json:14-17`

したがって engine の新しい検査・エラー文は `prod/js/desktop.js` と配布 ZIP に波及します。R1 は影響に触れていません。

対応案:

- 案A: source test だけを受入にする
- 案B: plugin build artifact と実ブラウザ表示まで release gate にする
- 案C: bundle 更新だけ確認し、表示は確認しない

**推奨は案B。**

R2 には次を追加してください。

> plugin production bundle に B148 検査と確定エラー文が含まれること。プラグインの EXPLAIN と通常実行で同じ reason code・違反列・移行案が表示され、records API 呼出前に停止すること。

# 3. 仕様が正しかった点

R2 でも次は維持すべきです。

- `GROUP BY` なし集計も「全体で1グループ」として非集計列を拒否する方針  
  `docs/internal/ksql_b148_bare_column_group_by_spec.md:47-53`
- 素の非集計 SELECT へ影響させないこと  
  `docs/internal/ksql_b148_bare_column_group_by_spec.md:60-63,86-87`
- 名前一致ではなく、物理 source identity を基準にする方針  
  `docs/internal/ksql_b148_bare_column_group_by_spec.md:65-75`
- 同名物理フィールドを SELECT alias より優先する §8 契約  
  `docs/ksql_language_reference.md:1432-1437`
- alias 経由の式 GROUP BY を主用途として保護すること  
  `docs/internal/ksql_b148_bare_column_group_by_spec.md:74-75,83-85`
- レコード API 呼出前に失敗させ、EXPLAIN でも検出する目標  
  `docs/internal/ksql_b148_bare_column_group_by_spec.md:123-129`
- エラーで列を名指しし、「存在しない」と誤読させず、移行方法を示すこと  
  `docs/internal/ksql_b148_bare_column_group_by_spec.md:101-121`
- 拡張 grouping の物理フィールド限定契約を維持すること  
  `docs/ksql_language_reference.md:1446,1570-1573`
- `$id` / `レコード番号` の関数従属を Phase 1 では認めない判断  
  `docs/internal/ksql_b148_bare_column_group_by_spec.md:138-140`

`GROUP BY $id` で詳細列も同時に返す用途は、レコード単位の重複除去、JOIN後の1レコード化、集計列の付加などで現実的にあり得ます。ただし、実際の保存クエリでの頻度は今回未確認です。

将来これを許可する変更は、従来エラーだった入力を成功させるだけであり、既存の成功クエリの値を変えない限り、互換性上は非破壊的に広げられます。

# 4. 決めるために測るべきこと

以下はコード読解だけでは確定できず、今回は未確認です。

1. **実保存クエリでの `$id` / `レコード番号 GROUP BY` の利用頻度**  
   コード上の影響形は分かりますが、実利用数は測れていません。

2. **式表記ゆれの既存利用量**  
   `1` と `1.0`、修飾／非修飾、関数 alias、バッククォートなど。canonicalization の互換影響を決める材料になります。

3. **確定エラー文の移行例が全 surface で実際に通ること**  
   GROUP BY あり／なし、JOIN、CTE、一時テーブル、サブテーブルについて実測が必要です。

4. **プラグイン production bundle の表示と API 呼出順**  
   `prod/js/desktop.js` を更新した後、通常実行と EXPLAIN の双方で、records API が0回のまま同じ診断が表示されることを確認すべきです。

5. **HAVING-only aggregate の現行実測**  
   コード上は SELECT 集計だけが grouping 開始条件ですが、具体的な入力ごとの現在値は実行していないため未確認です。R2 確定後に before/after を固定すべきです。


---

## 5. 実測による検証（Claude・2026-08-06）

**codex はコードを読んで推論しており、実行していない。**
**動的な主張を実機（APP4228・v3.56.3）で確かめた。結果は 3 勝 1 敗。**

### 5.1 **【最重要】High 3 は正しく、しかも仕様の位置づけが変わる**

**同じ規則が既に kSQL に実装されている。拡張 grouping の経路にだけ。**

```
SELECT 製品名, 個数, SUM(個数) AS 合計 FROM APP4228 GROUP BY ROLLUP(製品名)
  → ArgumentError: B65 non-aggregate field 個数 in SELECT is not a grouping item
     (reason=B65_NON_GROUPED_DEPENDENCY)
```

**B148 は「標準 SQL の規則を新しく入れる」話ではない。**
**「規則はあるのに、片方の経路にしか効いていない」話である。**

**[B145 の v3.56.1](ksql_b145_describe_subtable_field_issue.md) と正確に鏡像**＝
あちらは **plain `GROUP BY` がエラーで、拡張 grouping が素通り**していた。
**本件はその逆。** **同じ「経路ごとに検査が揃っていない」形が、向きを変えて 2 度目である。**

**帰結**

- **新しい判定器を作るのではなく、[`groupingValidation.ts`](../../src/core/groupingValidation.ts) の
  既存検査を ordinary `GROUP BY` にも効かせる**のが Phase 1 の中心になる
- **reason code `B65_NON_GROUPED_DEPENDENCY` が既にある。** 揃えるべき
- **R1 §3（対応づけの判定方法）を一から設計する必要が薄れる**＝
  **既存検査が canonical physical identity で判定している**（codex の指摘どおりなら）
- **ただし現行のエラー文は R1 §4.3 の要件を満たしていない**
  （`B65 non-aggregate field ... (reason=...)` は内部語で、**移行方法を示していない**）。
  **揃えるなら拡張 grouping 側の文面も改善される**

### 5.2 **Critical 3 は前提が成り立たない**

**`GROUP BY` の無い `HAVING` は構文として存在しない。**

```
SELECT '存在あり' AS 判定 FROM APP4228 HAVING COUNT(*) > 0
  → ParseError: 文の区切りには ; が必要です（位置 33、トークン:「HAVING」）

SELECT COUNT(*) AS 件数 FROM APP4228 HAVING COUNT(*) > 0
  → ParseError（位置 35・同じ）
```

**codex は「次の有効形を R1 の定義に含めると」と書いたが、その形は有効ではない。**

**したがって「集計開始条件と実行パイプラインを変える」（案 A）は不要。**
**R1 §2 の「`SELECT` / `HAVING` のいずれかに集計関数があるか」は、
`HAVING` が `GROUP BY` を要求する以上、後半が冗長なだけで害は無い。**

**R2 では「`HAVING` は `GROUP BY` を伴う」ことを明記して、条件を単純化する。**

### 5.3 Critical 1 は成立

```
ksql_validate: SELECT 製品名, 個数, SUM(個数) AS 合計 FROM APP4228 GROUP BY 製品名
  → ok: true
```

**違反クエリを通す。** `appBindings` は解決するが（`physical:APP4228@dev`）、
**フィールド定義は読まない**ので、schema-aware な判定はできない。
**codex の案 B（static と schema-aware の二段階契約）が妥当。**

### 5.4 High 4 の前提は正しい（回帰の確認）

```
SELECT SUM(個数) OVER () AS 総計 FROM APP4228 LIMIT 3
  → 3 行（85438 / 85438 / 85438）
```

**ウィンドウだけでは集計クエリにならない。** 現行どおりで正しく、**Phase 1 で壊してはいけない。**

### 5.5 CTE 経由の穴も確認

```
WITH m AS (SELECT 製品名, 個数, SUM(個数) AS 合計 FROM APP4228 GROUP BY 製品名)
SELECT 製品名, 個数, 合計 FROM m
  → 食パン / 646 / 23429（素通り）
```

**ordinary `GROUP BY` はどこでも検査されていない**ので、CTE の中でも同じ。
**High 2 の「適用単位を明記せよ」は妥当。**

### 5.6 傾向（5 回目の観測）

**codex の静的な主張（行を示せるもの）は当たり、動的な主張は外れることがある。**
**今回も Critical 3 だけが外れ、それは「この SQL は有効形である」という実行しないと分からない主張**だった。
**codex 自身が §4-5 で「HAVING-only aggregate の現行実測は未確認」と明記していた点は評価できる。**

---

## 6. 既存検査（B65）の到達範囲 — 実測（Claude・2026-08-06・APP4228）

**`groupingValidation.ts` が拡張 grouping 経路で何をしているかを、実機で全数確認した。**
**R2 のスコープはこれで決まる。**

### 6.1 到達範囲の表

| 検査項目 | 拡張 grouping（`ROLLUP`） | ordinary `GROUP BY` |
|---|---|---|
| **`SELECT` の非集計列** | ✅ エラー | ❌ **素通り** |
| **`HAVING` の非集計列** | ✅ エラー | ❌ **素通り** |
| **`ORDER BY` の非集計列** | ✅ エラー | ❌ **素通り** |
| **`SELECT *`** | ✅ 拒否 | ❌ **素通り** |
| **JOIN の修飾名** | ✅ エラー（**`t.個数` と名指し**） | ❌ **素通り** |
| **CTE の中** | ✅ エラー | ❌ **素通り** |
| **キーへの式**（`個数 + 1`） | ✅ **許可・値も正しい**（キー 646 → 647） | — |
| **別名の grouping item** | ❌ **拒否**（物理フィールドのみ） | ✅ **許可**（§8 の契約・**主用途**） |
| **式の grouping item** | ❌ **拒否**（物理フィールドのみ） | ✅ **許可** |

**実測したエラー文**

```
B65 non-aggregate field 個数 in SELECT is not a grouping item (reason=B65_NON_GROUPED_DEPENDENCY).
B65 non-aggregate field 個数 in HAVING is not a grouping item (reason=B65_NON_GROUPED_DEPENDENCY).
B65 non-aggregate field 個数 in ORDER BY is not a grouping item (reason=B65_NON_GROUPED_DEPENDENCY).
B65 non-aggregate field t.個数 in SELECT is not a grouping item (reason=B65_NON_GROUPED_DEPENDENCY).
B65 wildcard projection is not supported in Phase1.
B65 field 年月 does not exist in a physical APP source.
```

### 6.2 **R2 のスコープはこれで決まる**

**句の走査・JOIN 修飾・CTE 適用・wildcard・キーへの式**——
**R1 が設計しようとしていたものは、ほぼ全部すでにある。**

**足りないのは 1 点だけ**＝**grouping item を物理フィールドしか受け付けない。**

**ordinary `GROUP BY` は別名と式を許す**（§8 の契約）ので、**そこを教えれば残りは付いてくる。**

**したがって R2 の中心は次になる。**

> **既存検査の grouping item identity を、別名（`ALIAS_SAFE`）と式（`EXPRESSION`）へ広げ、
> そのうえで ordinary `GROUP BY` と `GROUP BY` 無し集計で検査を有効にする。**

**これは codex の Critical 2 の推奨（案 B＝plan と `stmt.groupBy[index]` から
resolved grouping identity を構築する）とちょうど噛み合う。**

### 6.3 副産物

- **エラー文が内部語である**（`B65 ... (reason=...)`）。
  **ordinary へ広げるときに R1 §4.3 の要件へ揃えれば、拡張 grouping 側も同時に良くなる**
- **`B65 wildcard projection is not supported in Phase1.`** は
  **開発時の Phase ラベルが利用者に漏れている**。合わせて直す
- **`GROUP BY ROLLUP(日付)` に対する `SELECT DATE_FORMAT(日付,'%Y-%m')` は通り、値も正しい**
  （日ごとの合計に月のラベルが付く。**見た目は紛らわしいが誤りではない**）。
  **「キーの式は関数従属なので許す」が既に効いている**証拠で、**R2 でもこの挙動を保つ**
