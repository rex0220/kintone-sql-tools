# B86 仕様案 R1 — 実体化ソースの不存在列参照を fail-closed 化

- 作成日: 2026-07-28
- 対象: [B86 課題](ksql_b86_materialized_unknown_column_issue.md)
- ステータス: **R1 実装済み（2026-07-28）**
- SemVer: **minor**（破壊的変更を含む正しさ修正。§8）
- 実装結果: §9 Step 1〜4 と §10 の受入条件を反映済み

---

## 0. 結論

案 A（実体化ソースでも列の実在を検証する）を採用する。

1. 実体化結果は `MaterializedTable` の `rows` と `columns` として保存される
   （`src/execute.ts:380-387`, `1745-1750`, `4250-4254`）。
2. CTE／一時テーブルを参照する下流 SELECT は必ず
   `executeQueryWithCte()`（`src/execute.ts:4265-4314`）を通る。ここでは
   CTE／一時テーブルの実体化が完了し、かつ下流 SELECT の
   `resolveSubqueries()`、物理アプリの records API、`runFullScan()` はまだ走っていない。
3. したがって、**`executeQueryWithCte()` の実行ディスパッチ前に、SELECT 単位の
   source-aware column preflight を行う**。`UNION` は両枝を preflight してから
   `Promise.all` で実行する。これが「実体化後、下流文の取得前」を満たす最早の共通位置である。
4. 現行 `validateSelectFieldCodes()` は物理アプリの取得列だけを検証し、
   FULL_SCAN では `cteName !== null` を明示的に除外する
   （`src/execute.ts:3080-3122`）。さらに `executeFullScanWithCte()` はこの関数を
   呼ばない。このため、単に `.filter()` を外すだけでは直らない。
5. 比較演算子は `LIKE` だけに限定せず、**`=` を含む全演算子と全列参照位置**を対象にする。
   不存在列を参照した SQL に正しい結果はなく、`LIKE` の全件も `=` の 0 件も誤結果である。

実測中に、B86 の記載より広い同根の穴を確認した。

- 実体化ソースと物理アプリを混在させた JOIN は
  `executeFullScanWithCte()` を通るため、**物理アプリ側の不存在列検証も迂回する**。
- `INSERT INTO ... SELECT missing FROM #temp` は、現行では不存在列を空文字へ変換し、
  **空文字レコードを実際に POST する**。SELECT-based DML の source も同一 merge で
  preflight しなければならない。

いずれも本書では仕様へ含めるが、コードは修正していない。

---

## 1. 現行構造と検証可能な契機

### 1.1 列集合が確定する位置

| ソース | 列集合の生成 | 保存 |
|---|---|---|
| `SHOW APPS` | 固定 `["アプリID","アプリ名","説明"]`（`execute.ts:8520-8528`） | CTE の `MaterializedTable.columns` |
| `DESCRIBE` | 固定 `["フィールドコード","ラベル","タイプ"]`（`execute.ts:8535-8547`） | 同上 |
| CTE の SELECT / UNION | 各 `SelectResult.columns` | `executeWith()` の `cteCache`（`execute.ts:4240-4254`） |
| 一時テーブル | source の `SelectResult.columns` | `executeBatchStatement()` の `tempTables`（`execute.ts:1737-1751`） |
| UNION 結果 | 左枝の `columns`。右枝は位置対応で左列名へ remap | CTE／一時テーブルへ保存可能（`execute.ts:4173-4201`, `4273-4291`） |

通常の明示列は 0 行でも AST から `columns` が確定する。B2 で保存済み列も
`MaterializedTable` に伝播済みである。

ただし、**0 行の物理アプリ `SELECT *` や 0 行 JOIN の `SELECT *` は、
現行 B2 仕様上 `columns=[]` になり得る**。これは §7.2 の例外として扱う。

### 1.2 最早の共通 preflight

採用位置は `executeQueryWithCte()` の入口とする。

```text
CTE / temp source を実体化
  -> MaterializedTable { rows, columns } を cache へ保存
  -> executeQueryWithCte(query, cache)
       -> B86 source-aware preflight       <- 新規契機
       -> subquery の実行
       -> 下流 SELECT の物理 records GET
       -> runFullScan / projection
```

この位置なら次を満たす。

- 実体化列が利用可能。
- 不正な下流 SELECT 自身の subquery 実行より前。
- 混在 JOIN の物理アプリ records GET より前。
- SELECT-based DML の confirm／POST／PUT より前。
- CTE と一時テーブルで同じ検証を再利用可能。
- engine library の `runQuery` / `runBatch`、plugin、CLI、MCP が共有する
  `execute()` / `executeBatch()` の内部で一貫する。

`executeFullScanWithCte()` の先頭だけに置く案は不採用とする。理由は、`UNION` の
両枝が現在 `Promise.all` で並列開始されるため、一方の不正を検出する前に他方の
records GET が始まり得ること、また query-level の再帰 preflight を置きにくいことである。

### 1.3 既存検証の再利用範囲

`validateSelectFieldCodes()` のエラー契約と物理フォーム定義キャッシュは再利用するが、
`selectToFetchAllFields()` の返り値だけを実体化検証へ流用してはならない。

理由:

- 現行の required-fields collector は物理テーブルだけを state に登録する
  （`src/converter/selectToKintone.ts:355-366`）。
- `SELECT *` は「全フィールド取得」を `fields=[]` で表すため、列実在検証の完全な
  参照一覧ではない。
- `ORDER BY` / `HAVING` / `GROUP BY` の SELECT alias、集計合成名、修飾名の解決規則があり、
  単純な文字列集合比較では誤拒否する。

実装では、既存 collector の走査規則を共通化するか、同じ AST 位置を扱う
**source-aware reference collector** を追加する。物理／実体化を同じ source resolution
で解決し、各 source の有効列集合だけを差し替える。

---

## 2. スコープ実測

実測はリポジトリファイルを変更せず、`src/execute.ts` を一時 transpile して
モック client で実行した。APP100=`x,k` 3 行、APP200=`z,k` 2 行、
SHOW APPS=3 行を主な fixture とした。

### 2.1 結果一覧

| 対象 | 実測 SQL の要旨 | 現状 |
|---|---|---|
| CTE (`SHOW APPS`) | `WHERE アプリ名 LIKE missing` | 3/3 行、警告なし |
| CTE (`SHOW APPS`) | `WHERE アプリ名 = missing` | 0 行、警告なし |
| CTE (`DESCRIBE`) | `WHERE フィールドコード LIKE missing` | 2/2 行、警告なし |
| CTE（物理由来・非インライン） | `WITH c AS (SELECT x AS y ...) ... WHERE y LIKE x` | 3/3 行、警告なし |
| CTE（物理由来・インライン可） | `WITH c AS (SELECT x ...) ... WHERE x LIKE missing` | 物理 APP の検証へ入り、取得前エラー |
| 一時テーブル | `#t(y)` に対し `WHERE y LIKE missing` | 3/3 行、警告なし |
| `IN` subquery | subquery 内で `y LIKE missing` | subquery 全行が候補になり、外側 1 行 |
| scalar subquery（WHERE 右辺） | subquery 内で `y LIKE missing LIMIT 1` | 成功、外側 1 行 |
| `EXISTS` subquery | subquery 内で `y LIKE missing` | `true` となり、外側 2/2 行 |
| scalar subquery（SELECT 列） | subquery 内で `y LIKE missing LIMIT 1` | 成功し値を返す |
| 派生表 | `FROM (SELECT ...) AS d` | ParseError。構文未対応 |
| `UNION ALL` 左枝 | 左枝 `WHERE y LIKE missing` | 左 3 行＋右 2 行＝5 行 |
| `UNION ALL` 右枝 | 右枝 `WHERE y LIKE missing` | 左 2 行＋右 3 行＝5 行 |
| UNION 出力別名 | 左 `x AS y`、右 `z AS q` の結果から `q` を参照 | UNION の列は左由来 `y` のみ。`q` は空文字 4 行 |
| JOIN（実体化側不存在） | `WHERE c.y LIKE c.missing` | 成功。結合済み 1/1 行 |
| JOIN（物理側不存在） | `WHERE p.z LIKE p.missing` | **成功。結合済み 1/1 行** |
| JOIN（物理側 SELECT 不存在） | `SELECT p.missing ...` | 空文字列を持つ 1 行 |
| JOIN ON 不存在 | `ON c.k = p.missing` | records GET 後に既存 JOIN-key guard がエラー |

### 2.2 列別名

`WITH c AS (SELECT x AS y FROM APP100)` の実体化後に存在する列は `y` だけである。

| 下流参照 | 現状 | B86 後 |
|---|---|---|
| `SELECT y FROM c` | 元の値 3 行 | 成功（不変） |
| `SELECT x FROM c` | `x=""` の 3 行 | 不存在列エラー |
| `WHERE y LIKE 'Al'` | 2 行 | 成功（不変） |
| `WHERE x LIKE 'Al'` | 0 行 | 不存在列エラー |
| `WHERE y LIKE x` | 3/3 行 | 不存在列エラー |
| `WHERE y LIKE y` | 3/3 行（正しい列同士比較） | 成功（不変） |

ここでの `x` は「同じ SELECT 内の alias 解決」ではなく、**一度実体化した後に
失われた入力列名を下流 SELECT が参照する形**である。下流から見える schema は
出力名 `y` のみとする。

### 2.3 UNION の列名

UNION 結果の列名は SQL の既存実装どおり左枝由来とする。

```sql
WITH c AS (
  SELECT x AS y FROM APP100
  UNION ALL
  SELECT z AS q FROM APP200
)
SELECT y FROM c;  -- 有効

SELECT q FROM c;  -- 無効。q は UNION 結果の列名ではない
```

各枝の内部参照は各枝自身の source schema で検証し、UNION を実体化した後の参照は
左枝由来の `MaterializedTable.columns` で検証する。

### 2.4 混在 JOIN の追加所見

materialized ref が FROM/JOIN のどこかに 1 つでもあると
`executeQueryWithCte()` → `executeFullScanWithCte()` へ入り、通常の
`executeSelect()` にある `validateSelectFieldCodes()` を通らない。このため、
混在 JOIN では物理 source も無検証になる。

B86 実装では次を同時に直す。

- 実体化 source: `MaterializedTable.columns` で検証。
- 物理 source: `getFieldsCached(appId)` の defs で検証。
- JOIN ON: 下流 records GET 後の `runFullScan()` guard に任せず preflight する。
  既存の `JOIN key ... is not available` 契約は維持してよい。
- 非修飾列: 既存の source ownership／曖昧性規則を維持し、B86 を理由に優先順位を変えない。

### 2.5 SELECT-based DML

追加実測:

```sql
CREATE TEMP TABLE #t AS SELECT x AS y FROM APP100;
INSERT INTO APP200 (dest) SELECT missing FROM #t;
```

現状は成功し、APP100 の 2 行に対応する次の payload を POST した。

```json
[
  {"dest":{"value":""}},
  {"dest":{"value":""}}
]
```

これは read-only の誤結果より強い、**silent wrong write** である。
`INSERT ... SELECT`、`UPSERT ... SELECT`、それらの `VALIDATE ONLY` / `ON ERROR SKIP`
を含め、source SELECT が実体化 source を参照する全経路で同じ preflight を共有する。
`UPDATE ... FROM` 等に既存の source-column guard があっても、その上流で
`CREATE TEMP TABLE #u AS SELECT missing FROM #t` が空文字列を materialize できるため、
B86 preflight は source SELECT 自体で必須である。

---

## 3. 対象・非対象

### 3.1 対象

source schema に対する列参照として、物理アプリの現行検証と同じ AST 位置を対象にする。

- SELECT 射影の FIELD、算術、文字列関数、CASE、aggregate 引数、window の
  `PARTITION BY` / `ORDER BY`
- WHERE の左辺と、裸の識別子として parse された右辺 field reference
- JOIN ON
- GROUP BY
- HAVING
- ORDER BY
- `IN` / scalar / `EXISTS` / SELECT 列 scalar subquery の各 SELECT
- UNION / UNION ALL の各枝、および UNION 実体化後の下流 SELECT
- CTE 本体、WITH 最終 query、一時テーブルの作成元／読出し
- SELECT-based DML の source SELECT
- materialized source と物理 APP の混在 JOIN
- 修飾参照 `alias.column` と、既存規則で source が一意に決まる非修飾参照

`$id`、`_pid`、`_rid` 等も、**実体化後は投影されて `columns` に存在する場合だけ有効**
とする。物理 source の system-field bypass を実体化 sourceへコピーしてはならない。
実体化は source の出力 schema であり、元アプリの system field が暗黙復活することはない。

### 3.2 対象外

| 非対象 | 理由 |
|---|---|
| `FROM (SELECT ...)` 派生表 | 現在の grammar が未対応で ParseError。B86 で構文追加しない |
| SELECT alias の一般的な解決順変更 | ORDER/HAVING/GROUP の既存 alias 規則を維持する。B86 は source schema の不存在だけを扱う |
| 曖昧な非修飾列の優先順位変更 | 既存の ambiguity / ownership 契約を維持。別の列を勝手に選ばない |
| 不明 table alias の新しい意味論 | 既存の alias guard の責務。B86 は解決済み source 内の列実在を扱う |
| `EXPLAIN` で実体化後 schema を完全再現 | EXPLAIN は CTE/temp を実行しないため runtime の `MaterializedTable.columns` が存在しない。静的 schema inference は別課題 |
| 物理アプリ単独 SELECT の現行検証規則変更 | 既に取得前拒否する。共有 helper への refactor 以外の意味変更をしない |
| 存在列に対する LIKE / `=` の比較意味論 | B86 は不存在列を評価器へ渡さない変更であり、既存列同士・列と literal の評価は不変 |

EXPLAIN は「実行時には materialized schema preflight がある」旨を plan 文言へ加えることは
できるが、具体的な unknown 列判定を release gate にしない。

---

## 4. 演算子の判断

### 4.1 `=` を含める

**含める。LIKE だけの hotfix にはしない。**

根は演算子ではなく「不存在列を値 `""` として評価器へ渡す」ことである。

| 形 | 現状 | 正しい SQL 契約 |
|---|---|---|
| `existing LIKE missing` | 空 pattern により全件 | unknown column error |
| `existing = missing` | 多くの場合 0 件 | unknown column error |
| `SELECT missing` | 全行 `""` | unknown column error |
| `INSERT ... SELECT missing` | 空文字を書込み得る | mutation 前 unknown column error |

`=` の 0 件も「該当データがない」という意味の正しい 0 件ではない。
列が存在しない SQL には結果集合が定義されないため、エラー化で正しい結果を失わない。

### 4.2 B78 / B79 の基準

B78 / B79 の基準をそのまま適用できる。

> 現在成功して見えるクエリは実際には誤った結果を返しているので、
> エラー化しても正しい結果を失わない。

B86 はさらに、物理アプリでは既に unknown field error であり、source 面による
不整合を埋める変更でもある。`LIKE` の全件、`=` の 0 件、projection の空文字、
DML の空文字書込みはいずれも有効な結果ではない。

ただし `columns=[]` で schema 自体が未確定の 0 行 wildcard source は、
「missing と証明済み」ではないため同じ論証を直接使えない。§7.2 の限定例外とする。

---

## 5. 破壊的変更

### 5.1 影響を受けるクエリ

現在成功する次の形が `ArgumentError` へ変わる。

1. literal の引用符を忘れた右辺:
   `WHERE name LIKE customer` / `WHERE code = ABC`
2. typo／削除済み列を WHERE、SELECT、式、集計、CASE、GROUP/HAVING/ORDER/window で参照。
3. `SELECT x AS y` を実体化した後に元名 `x` を参照。
4. UNION の右枝だけに付けた alias を UNION 結果の列名として参照。
5. CTE／temp 内の subquery が不存在列を参照。
6. UNION のいずれかの枝が実体化 source の不存在列を参照。
7. materialized + physical APP の混在 JOIN で、どちらかの source の不存在列を参照。
8. `CREATE TEMP TABLE ... AS SELECT missing FROM #t` のように誤った空列を次段へ再実体化。
9. `INSERT/UPSERT ... SELECT` が不存在列由来の空文字を書き込む形。
10. qualified `c.missing`、または既存規則で source が一意な unqualified `missing`。

### 5.2 影響しないクエリ

- literal を引用した `LIKE '顧客'` / `= 'ABC'`
- 実在列同士の比較
- 実体化後の出力 alias を正しく使う query
- UNION の左枝由来列名を使う query
- 物理アプリ単独で既に unknown field error になる query（結果不変）
- 既存の有効な JOIN、subquery、temp/CTE pipeline

### 5.3 移行案内

破壊的変更のため、同一リリースで具体例と修正方法を案内する。

- 裸の語を値として意図した場合: `'...'` で引用。
- `SELECT x AS y` の後段: `x` ではなく `y` を参照。
- UNION 後: 左枝の列名／alias へ統一。
- typo／削除済み列: 実体化 source の SELECT 出力を確認して修正。

公開同期先は最低でも `CHANGELOG.md`、`docs/ksql_language_reference.md`、
`release/README.txt` の 3 箇所とする。issue tracker と本 B86 文書のステータス更新も
同一 merge に含める。

---

## 6. 既存テスト影響

`src/__tests__` の unknown/missing/不存在 sentinel と CTE/temp/UNION query corpus を
静的監査した結果、**現在の誤成功を正しい期待値として固定している既存テストは 0 件**
と特定した。

既存で materialized JOIN key の不存在を扱うものは 2 件ある。

- `src/__tests__/b51CteJoinAlias.test.ts`
  - `JOIN 参照列不存在は空文字直積にせず拒否する`
  - `0行 CTE も保存済み columns で JOIN 参照列不存在を拒否する`

この 2 件は既に error を期待するため、B86 後も成功させる。preflight が先に発火しても
既存の `JOIN key ... is not available` message を維持すれば変更不要である。

ただしこれは実装前の静的監査である。source-aware collector が alias／GROUP BY 等を
誤解すると有効 query を過剰拒否し得るため、実装時には full `npm test` と
「既存 query corpus で新規 rejection 0」の確認を release gate にする。

---

## 7. `defs.length === 0` と schema 不明の扱い

### 7.1 `defs.length === 0` を実体化 source へコピーしない

現行の

```ts
if (defs.length === 0) continue;
```

は、物理アプリのフォーム定義を返さない既存モックを互換維持するための分岐である
（`src/execute.ts:3113-3115`）。

materialized source の `columns` が非空なら、それは実行結果自身が持つ authoritative
schema であり、外部 API／mock の defs ではない。したがって:

- `getFields()` が `[]` でも materialized `columns` があるなら必ず検証する。
- 行が 0 件でも明示 projection、SHOW APPS、DESCRIBE 等で `columns` があるなら検証する。
- `columnMeta` が空でも、列実在には `columns` を使えるため検証を skip しない。

同じ `defs.length===0` escape hatch を実体化 source に作ると B86 がそのまま残るため禁止する。

### 7.2 `MaterializedTable.columns.length === 0`

`columns=[]` は「列が 0 個の表」ではなく、現行 B2 の対象外ケースでは
**schema を確定できなかった 0 行 wildcard 結果**を意味し得る。

実測:

```sql
CREATE TEMP TABLE #t AS SELECT * FROM APP300; -- APP300 は 0 行、form には x,k
SELECT x FROM #t;       -- 現状 0 行で成功
SELECT missing FROM #t; -- 現状も 0 行で成功
```

この状態で `x` を unknown と断定すると正しい 0 行 queryを誤拒否する。一方、
`missing` を許すと列実在の完全な parity にはならない。

R1 の判断は次とする。

- `columns.length > 0`: B86 検証必須。skip 禁止。
- `columns.length === 0 && rows.length === 0`: **schema-unavailable として B86 の
  unknown-column 判定だけを保留**し、JOIN なしの 0 行読出しでは B2 の既存挙動を維持。
- schema-unavailable source を JOIN 入力にする場合: 有効な JOIN key も証明できないため、
  既存の遅い JOIN-key error を **下流 records GET 前の schema-unavailable error** へ前倒しする。
- `columns.length === 0 && rows.length > 0`: 内部不変条件違反として fail-closed。
- schema-unavailable source は JOIN key として現状も `runFullScan` guard が拒否するため、
  空 source を外部結合して unknown field が全件化する経路は成立しない。B86 では
  この拒否を records GET 前へ移す。

この限定 skip は `defs.length===0` の一般的な抜け道とは異なり、
`rows.length===0 && columns.length===0` の組にだけ閉じる。

残る制限として、空 source を UNION の左枝に置き、明示列名を AST から作る形では、
その列が本当に元 source に存在したかを証明できない。右枝の行が左枝列名へ remap されるため、
結果行が存在することもある。ここまで厳格化すると正しい 0 行 wildcard pipeline も拒否するため、
R1 は互換性を優先して残す。完全解消は下記 schema 復元と同時に行う必要がある。

完全 parity が必要なら、物理 `SELECT *` の 0 行時に form defs から
`MaterializedTable.columns` を復元する B2 拡張が必要であり、B86 R1 には含めない。
理由は、フォーム列順、system field、subtable、0 行 JOIN の合成 schema まで別設計になるため。

---

## 8. SemVer とリリース判断

プロジェクトの B78 / B79 前例に従い **minor** とする。

- 破壊的変更ではあるが、成功から error へ変わる SQL は全て不存在列を参照しており、
  現在の結果は正しくない。
- 物理アプリでは既に error であり、実体化面だけの穴を閉じる。
- 正しい SQL の結果は変えない。
- silent wrong write も防ぐため、patch として黙って入れるより migration note 付き minor が妥当。

通常の SemVer の互換性観点では major 候補になり得るが、本プロジェクトは
「誤結果を error 化し、正しい結果を失わない」変更を migration note 付き minor とする
先例を明示的に採用している。B86 にだけ異なる基準を適用する理由はない。

---

## 9. 実装ステップと同一 merge 要件

### Step 1 — source-aware collector / validator

- SELECT AST の列参照を clause と source ownership 付きで収集。
- SELECT alias、aggregate synthetic name、system field、qualified/unqualified、
  GROUP/HAVING/ORDER の既存規則を維持。
- 物理 source は defs、materialized source は `columns` を valid set とする。
- error は `ArgumentError`、unknown 名と source（`APP<n>` / CTE名 / `#temp`）を含める。

### Step 2 — query preflight 配線

- `executeQueryWithCte()` の SELECT dispatch 前に検証。
- UNION は全枝を再帰 preflight してから実行を開始。
- subquery は各 SELECT を同じ preflight へ通す。
- 混在 JOIN の物理 source も同じ pass で検証。
- validation failure 時の downstream records GET / confirm / POST / PUT は 0。

### Step 3 — regression / acceptance tests

- §10 の before-fail → after-pass corpus を追加。
- B51 の既存 JOIN-key error 2 件を非回帰。
- `defs=[]` と materialized columns 非空の組を必須 fixture にする。
- full test、engine library、CLI/MCP shared execution surface を確認。

### Step 4 — migration / docs

- CHANGELOG、言語リファレンス、release README に破壊的変更と修正例。
- issue tracker、本 issue、本 spec のステータス同期。

### 同一 merge が必須のもの

次は分割しない。

1. validator と `executeQueryWithCte()` 配線。
2. UNION 全枝 preflight（片枝だけ先行させない）。
3. mixed JOIN の物理 source 検証（materialized 側だけ直さない）。
4. SELECT-based DML の mutation 前 guard。
5. runtime tests と 4 面共有回帰。
6. 破壊的変更の公開 3 文書。

validator だけを先行すると未使用コード、配線だけを先行すると alias 誤拒否、
SELECT read path だけを先行すると silent wrong write が残るため、同一 merge とする。

---

## 10. 受入条件

### 10.1 基本

- [x] `WITH a AS (SHOW APPS) ... LIKE missing` が全件を返さず、下流評価前に error。
- [x] 同じ query の `= missing` も error。
- [x] `LIKE '顧客'` は従来どおり成功。
- [x] `LIKE 説明` のような実在列同士比較は従来どおり成功。
- [x] DESCRIBE、物理由来非インライン CTE、一時テーブルで同じ。
- [x] 0 行でも明示列を持つ materialized source は unknown を拒否。

### 10.2 alias / UNION

- [x] `SELECT x AS y` 実体化後の `y` は有効、`x` は SELECT／WHERE の双方で error。
- [x] UNION 各枝の unknown を枝実行前に拒否。
- [x] UNION 実体化結果では左枝列名だけを有効とする。
- [x] 不正枝があれば sibling branch の records GET も開始しない。

### 10.3 subquery

- [x] IN、scalar RHS、EXISTS、SELECT 列 scalar subquery 内の materialized unknown を error。
- [x] 不正な外側 SELECT は subquery 自体を実行しない。
- [x] 不正な subquery は外側 records GET 前に error。
- [x] `FROM (SELECT...)` は従来どおり ParseError（構文追加なし）。

### 10.4 JOIN

- [x] materialized 側 unknown を records GET 前に error。
- [x] mixed JOIN の物理側 unknown も records GET 前に error。
- [x] JOIN ON unknown を records GET 前に error。
- [x] 有効 JOIN と曖昧性／alias 規則は不変。
- [x] B51 の既存 missing JOIN-key tests は message を含めて green。

### 10.5 DML safety

- [x] `INSERT ... SELECT missing FROM #t` は confirm／POST 前に error。
- [x] UPSERT、VALIDATE ONLY、ON ERROR SKIP の source SELECT も同じ。
- [x] DML failure 時 POST / PUT / DELETE は 0。
- [x] 有効 source SELECT の DML は不変。

### 10.6 `defs=[]` / schema unavailable

- [x] 物理 mock の `defs=[]` 既存互換は維持。
- [x] materialized `columns=["y"]` なら defs／columnMeta が空でも `x` を拒否。
- [x] `rows=[] && columns=[]` は B2 の既存 0 行挙動を維持。
- [x] `rows=[] && columns=[]` の source を JOIN 入力にした場合は、物理 records GET 前に
      schema-unavailable error。
- [x] `rows.length>0 && columns.length===0` は内部エラー。

### 10.7 release gates

- [x] 新規 B86 tests が修正前 fail → 修正後 pass。
- [x] `npm test` green。
- [x] engine library `runQuery` / `runBatch` の error envelope を確認。
- [x] CLI / MCP / plugin が共有 runtime で同じ `ArgumentError`。
- [x] CHANGELOG、言語リファレンス、release README の migration note 同梱。

調査時ベースラインは `npm test` で **189 suites / 4,842 tests / 22 snapshots green**
（通常 187 suites / 4,816 tests、CLI subprocess 2 suites / 26 tests）だった。

---

## 11. 見積もり

追加所見（mixed JOIN の物理検証迂回、SELECT-based DML の silent wrong write、
UNION 全枝 preflight）を含め、元 issue の 1.0〜1.75 人日から上方修正する。

| 作業 | 見積もり |
|---|---:|
| source-aware collector / validator | 0.75〜1.0 人日 |
| CTE/temp/subquery/UNION/mixed JOIN/DML 配線 | 0.5〜0.75 人日 |
| tests（負例・API 0 回・4 面回帰） | 0.5〜0.75 人日 |
| migration docs / issue tracker / release note | 0.25 人日 |
| full verification・レビュー修正余裕 | 0.25〜0.5 人日 |
| **合計** | **2.25〜3.25 人日** |

`columns=[]` の完全 schema 復元まで同時に行う場合は、B2 の再設計として
**追加 0.75〜1.5 人日**（物理 wildcard、system fields、subtable、JOIN schema、
追加 API と列順の契約）が必要である。

---

## 12. 判断に迷った点・実現不可能な組み合わせ

1. **`columns=[]` で strict unknown 判定と既存の正しい 0 行 query の両立は不可能。**
   schema を復元しない限り `x` と `missing` を区別できない。R1 は限定 skip を選ぶ。
2. **EXPLAIN で runtime materialized schema を使うことは不可能。**
   CTE/temp を実行しないためで、完全 parity には静的 schema inference が別途必要。
3. **`executeFullScanWithCte()` だけの局所修正と、UNION 文全体の「取得前拒否」は両立しない。**
   枝が並列開始されるため、query-level preflight が必要。
4. **LIKE だけを拒否して source parity を達成することは不可能。**
   `=`、projection、DML に同じ空文字解決が残る。
5. **materialized 側だけを直して mixed JOIN parity を達成することは不可能。**
   現在は同じ経路で物理側検証も迂回している。
6. **`defs.length===0` をそのまま materialized source に適用すると B86 を閉じられない。**
   materialized `columns` は mock metadata と独立して authoritative である。
