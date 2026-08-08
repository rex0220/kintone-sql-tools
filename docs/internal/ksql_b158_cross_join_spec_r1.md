# B158 `CROSS JOIN`（直積・2 軸格子生成）仕様（R1）

- ステータス: **R1 正本**
- 対象: kSQL v3.62.0
- 実装候補版: v3.63.0
- 起票: [B158](ksql_b158_cross_join_grid_issue.md)
- 関連: [B128 Phase 2](ksql_b128_window_phase2_spec.md) / [B149](ksql_b149_generate_series_spec_r2.md) / B150 / B151 / B152 / B155 / B157
- 初版: 2026-08-08
- SemVer: **minor**
- オーナー判断: **明示 `CROSS JOIN` を新設する。`ON 1=1` とカンマ結合は開放しない**

---

## 0. R1 の位置づけ

B158 は、2 つの入力の直積を標準 SQL の明示構文で生成できるようにする。

```sql
SELECT d.日付, m.製品名
FROM 日付系列 AS d
CROSS JOIN 製品マスタ AS m
```

意味は次である。

```text
左 N 行 × 右 M 行 = N×M 行
```

どちらかが 0 行なら結果も 0 行である。

主用途は、`GENERATE_SERIES` で作った日付系列と小さい製品マスタを掛け合わせ、取引の無い日・製品を含む格子を作ることである。

B158 は次を変更しない。

- 通常の `JOIN ... ON` は等値条件 1 本、両辺とも列参照だけを受理する。
- `INNER JOIN ... ON 1 = 1` は受理しない。
- `FROM a, b` のカンマ結合は受理しない。
- `LEFT CROSS JOIN` / `RIGHT CROSS JOIN` は存在しない。
- `GENERATE_SERIES` を直接 `FROM` / `JOIN` に書く構文は開放しない。従来どおり CTE 本体に置く。
- 複合キー JOIN、複数 `ON` 条件、任意 JOIN predicate は B158 の対象外である。

---

## 1. 目的

B158 の目的は次の 6 点である。

1. 明示 `CROSS JOIN` により標準 SQL の直積を生成する。
2. CTE・一時テーブル・物理 APP・サブテーブル仮想テーブルの組み合わせを同じ意味論で扱う。
3. 直積行数を生成前に計算し、10,000 行を超える直積を fail-closed で拒否する。
4. `EXPLAIN` に直積の左右行数、生成行数または算出式、行数ガードを表示する。
5. `CROSS JOIN` のために records API を追加で呼ばず、CLI `--dry-run` は API 0 回を維持する。
6. B150/B155 の WHERE prefilter は安全な物理 APP leaf に引き続き適用し、JOIN キー prefilter とは明確に分離する。

---

## 2. 現行コードから確定した変更点

### 2.1 parser・AST

| 現行事実 | 根拠 |
|---|---|
| JOIN の lexer token は `INNER` / `LEFT` / `RIGHT` / `JOIN` / `ON` だけ | `src/lexer/tokens.ts:50-55,231-235` |
| SELECT は `FROM` の直後に `parseJoins()` を呼ぶ | `src/parser/parser.ts:1154-1161` |
| `parseJoins()` はすべての JOIN に `ON` を要求する | `src/parser/parser.ts:2547-2556` |
| JOIN 種別は `INNER` / `LEFT` / `RIGHT` だけ | `src/types/ast.ts:464-470` |
| `ON` は列対列の等値 1 本に固定されている | `src/types/ast.ts:472-476`; `src/parser/parser.ts:2580-2585` |
| `GENERATE_SERIES(...)` を `FROM` / `JOIN` の表位置に置くと専用 ParseError になる | `src/parser/parser.ts:2483-2489` |

`CROSS` は hard keyword として追加する。

```ts
TokenKind.CROSS = "CROSS"
KEYWORDS.set("CROSS", TokenKind.CROSS)
```

これにより、未引用の `CROSS` は予約語になる。既存のフィールド名・別名として使う場合はバッククォートを必要とする。

```sql
SELECT `CROSS` FROM APP100
SELECT x.`CROSS` FROM APP100 AS x
```

AST は `on` の nullable 化だけで済ませず、次の discriminated union にする。

```ts
export type JoinClause =
  | {
      type: "INNER" | "LEFT" | "RIGHT";
      table: TableRef;
      on: JoinCondition;
    }
  | {
      type: "CROSS";
      table: TableRef;
      on: null;
    };
```

`JoinType` は次となる。

```ts
export type JoinType = "INNER" | "LEFT" | "RIGHT" | "CROSS";
```

この形により、`join.on` を読む既存箇所は `join.type !== "CROSS"` の narrowing を要求される。単に `on?: JoinCondition` として既存処理を黙って通してはならない。

主な追随箇所:

- JOIN キー事前検証: `src/execute.ts:3862-3874`
- runtime JOIN キー prefilter: `src/execute.ts:5894-5929`
- EXPLAIN JOIN キー計画: `src/execute.ts:10239-10252`
- fetch field 収集: `src/converter/selectToKintone.ts:789-790`
- EXPLAIN metadata 要否: `src/core/explainMetadata.ts:73-81`
- JOIN 実処理: `src/engine/process.ts:216-293`

### 2.2 実行順序

現行 FULL_SCAN の処理順は次である。

```text
flatten
→ JOIN
→ WHERE
→ GROUP BY / aggregate
→ HAVING
→ window
→ DISTINCT
→ ORDER BY
→ LIMIT / OFFSET
→ project
```

根拠: `src/engine/process.ts:2089-2195`

`CROSS JOIN` も JOIN 段で処理する。WHERE、GROUP BY、ウィンドウ、ORDER BY の意味論や順序を変更しない。

### 2.3 FULL_SCAN と入力取得

- JOIN が 1 件でもあれば `FULL_SCAN` になる。  
  `src/converter/selectToKintone.ts:67-92`
- CTE を `FROM` / `JOIN` に含む SELECT も、CTE を実体化して FULL_SCAN へ渡す。  
  `src/execute.ts:5372-5407`
- 物理 APP はソースごとに `maxRecords` の制約を受ける。  
  `src/execute.ts:4935-5017,5532-5594`
- サブテーブル仮想テーブルは親レコード取得後に明細行へ展開される。  
  `src/execute.ts:5716-5741`

したがって直積ガードは records API の取得件数ではなく、JOIN 段へ渡された実際の展開済み左右行数に対して適用する。

---

## 3. 構文

### 3.1 受理する構文

```ebnf
cross_join_clause :=
  CROSS JOIN table_ref
```

例:

```sql
SELECT a.x, b.y
FROM APP100 AS a
CROSS JOIN APP200 AS b
```

```sql
WITH d AS (
  GENERATE_SERIES('2026-01-01', '2026-12-31') AS 日付
),
m AS (
  SELECT 製品名 FROM APP4229
)
SELECT d.日付, m.製品名
FROM d
CROSS JOIN m
```

通常 JOIN との混在も受理する。

```sql
FROM a
CROSS JOIN b
LEFT JOIN c ON b.key = c.key
```

```sql
FROM a
INNER JOIN b ON a.key = b.key
CROSS JOIN c
```

JOIN は記述順に評価する。各 `CROSS JOIN` の左側は、それ以前の JOIN を適用済みの中間行集合である。

### 3.2 拒否する構文

```sql
FROM a LEFT CROSS JOIN b
```

```text
ParseError: CROSS JOIN に LEFT / RIGHT は指定できません。
```

```sql
FROM a RIGHT CROSS JOIN b
```

```text
ParseError: CROSS JOIN に LEFT / RIGHT は指定できません。
```

```sql
FROM a INNER CROSS JOIN b
```

```text
ParseError: CROSS JOIN に INNER は指定できません。
```

```sql
FROM a CROSS JOIN b ON a.x = b.x
```

```text
ParseError: CROSS JOIN に ON 句は指定できません。
```

次は既存エラー契約を維持する。

```sql
FROM a INNER JOIN b ON 1 = 1
```

`parseQualifiedIdent()` が数値リテラルを列参照として受理しないため ParseError。

```sql
FROM a, b
```

カンマ結合は引き続き ParseError。

```sql
FROM GENERATE_SERIES(1, 5) AS n
```

`GENERATE_SERIES` の表関数化は行わず、既存の配置エラーを維持する。

---

## 4. 意味論

### 4.1 基本規則

左入力を記述順に `L = [l1, l2, ...]`、右入力を `R = [r1, r2, ...]` とする。

出力は次の順で生成する。

```text
l1×r1, l1×r2, ...,
l2×r1, l2×r2, ...,
...
```

つまり左入力を外側、右入力を内側とする安定した nested-loop 順である。

ただし、利用者が公開結果の順序を必要とする場合は `ORDER BY` を書かなければならない。上記は実装回帰を固定するための内部安定順であり、`ORDER BY` の無い SQL に公開上の順序保証を新設するものではない。

### 4.2 空入力

| 左行数 | 右行数 | 出力 |
|---:|---:|---:|
| 0 | 0 | 0 |
| 0 | M | 0 |
| N | 0 | 0 |
| N | M | N×M |

空側を補完する行は生成しない。`CROSS JOIN` は outer join ではない。

### 4.3 同名列

既存 JOIN と同じ flatten・修飾列規則を使用する。別の列名前空間や自動 suffix は導入しない。

曖昧な非修飾列参照は既存の検証・解決規則に従う。B158 の実装が「後勝ち」で値を選ぶ新しい挙動を作ってはならない。

---

## 5. 適用経路

### 5.1 ソース組み合わせ

| 左入力 | 右入力 | B158 | 行数の正本 | WHERE prefilter |
|---|---|:---:|---|---|
| CTE | CTE | 許可 | 実体化済み行数 | API prefilter なし |
| CTE | 一時テーブル | 許可 | 実体化済み行数 | API prefilter なし |
| 一時テーブル | 一時テーブル | 許可 | 実体化済み行数 | API prefilter なし |
| 系列 CTE | 物理 APP | **許可・本命** | 系列実行行数 × fetch 後 APP 行数 | APP 側の安全 leaf は可 |
| CTE/一時テーブル | 物理 APP | 許可 | 実体化済み行数 × fetch 後 APP 行数 | APP 側の安全 leaf は可 |
| 物理 APP | 物理 APP | 許可 | 両 APP の fetch 後行数 | alias ごとの安全 leaf は可 |
| サブテーブル仮想表 | 任意 | 許可 | 親取得後に展開した明細行数 | 現行サブテーブル規則を維持 |
| 任意 | サブテーブル仮想表 | 許可 | 親取得後に展開した明細行数 | JOIN 中は新規 pushdown なし |

`GENERATE_SERIES` は直接の table ref にはならない。

```sql
-- 不可
FROM GENERATE_SERIES(1, 10) AS s
CROSS JOIN APP100 AS a
```

次の形を使う。

```sql
WITH s AS (
  GENERATE_SERIES(1, 10) AS n
)
SELECT s.n, a.$id
FROM s
CROSS JOIN APP100 AS a
```

### 5.2 物理 APP × 物理 APP

物理 APP 同士も一律拒否しない。双方の取得後行数を使って直積ガードを適用する。

ただし次をすべて満たす必要がある。

1. 各 APP の必要行が `maxRecords` 内で完全取得できる。
2. `onLimit=truncate` を使用しない。
3. 取得後の実行時直積行数が 10,000 以下である。

したがって、10,000×10,000 の入力を取得して 1 億行を生成することはない。取得後、結果配列の確保・nested loop 開始より前に拒否する。

### 5.3 サブテーブル仮想テーブル

`maxRecords` は親レコードの取得上限であり、サブテーブル展開後の明細行数上限ではない。

直積ガードは展開後行数を使用する。

```text
親 100 レコード
各親に明細 20 行
→ サブテーブル入力 2,000 行
```

これを右 6 行と直積する場合は `2,000×6=12,000` として拒否する。

---

## 6. 行数ガード

### 6.1 上限

`CROSS JOIN` の生成上限は **10,000 行**とする。

値は `GENERATE_SERIES_MAX_ROWS` と共有する。ただしカウンタは共有しない。

```ts
export const GENERATED_ROW_MAX_ROWS = 10_000;
export const GENERATE_SERIES_MAX_ROWS = GENERATED_ROW_MAX_ROWS;
export const CROSS_JOIN_MAX_ROWS = GENERATED_ROW_MAX_ROWS;
```

理由:

- `GENERATE_SERIES` と直積はいずれも入力 API の行ではなく、kSQL がメモリ上に生成する行である。
- 利用者が既に理解している `row guard: ... / 10000` と同じ公開上限にできる。
- 365 日×8 製品＝2,920 行を許可できる。
- `maxRecords` を引き上げても直積上限が暗黙に上がらない。

`GENERATE_SERIES` の「同じ WITH 内の系列行数合計」と、`CROSS JOIN` の出力行数は別々に判定する。

### 6.2 算出単位

各 `CROSS JOIN` の直前に、その JOIN の出力行数を計算する。

```text
crossRows = currentLeftRows × rightRows
```

複数の `CROSS JOIN` がある場合は順番に判定する。

```sql
FROM a
CROSS JOIN b
CROSS JOIN c
```

```text
guard 1: rows(a) × rows(b)
guard 2: rows(a×b) × rows(c)
```

どちらかの段が 10,000 を超えた時点で拒否する。

後続の `WHERE`、`GROUP BY`、`DISTINCT`、`LIMIT` で行数が減る見込みを理由に免除しない。

### 6.3 算出時点

runtime では次の順にする。

```text
各ソースを完全取得・CTEを実体化
→ サブテーブルを展開
→ CROSS JOIN の左右実行行数を取得
→ N×M を算出
→ 上限判定
→ 結果配列の確保・行生成
```

上限判定を nested loop の途中に置いてはならない。一部行を生成してから失敗する実装は禁止する。

### 6.4 共通実装

許可判定と行数算出は pure helper 1 個を正本とする。

```ts
export interface CrossJoinRowPlan {
  leftRows: number;
  rightRows: number;
  outputRows: number;
  limit: number;
  allowed: boolean;
}

export function planCrossJoinRows(
  leftRows: number,
  rightRows: number,
  limit = CROSS_JOIN_MAX_ROWS
): CrossJoinRowPlan;
```

runtime、EXPLAIN の静的確定値、unit test はこの helper を使用する。renderer、`applyJoin()`、CLI、MCP に同じ掛け算・上限判定を複製しない。

超過時のエラーは次に固定する。

```text
ArgumentError: CROSS JOIN の生成件数 11000 行（左 110 行 × 右 100 行）が上限 10000 行を超えています。
```

0 行側がある場合は必ず `outputRows=0` とし、他方の行数にかかわらず直積ガード自体は成功する。

---

## 7. FULL_SCAN・完全入力・`maxRecords`

### 7.1 FULL_SCAN

`CROSS JOIN` を含む SELECT は既存 JOIN と同じく `FULL_SCAN` とする。

EXPLAIN の reason は単なる `JOIN あり` だけでなく、次を表示する。

```text
reason:        CROSS JOIN あり
```

通常 JOIN と混在する場合は両方を列挙してよい。

### 7.2 完全入力

`CompleteInputReason` に次を追加する。

```ts
"CROSS_JOIN"
```

`CROSS JOIN` を含む SELECT は完全入力を要求する。

```text
complete input: required (onLimit=truncate disabled)
complete input reason: CROSS_JOIN
onLimit=truncate: disabled
```

理由は、片側の取得を truncate すると標準 SQL の N×M ではなく「取得できた範囲の直積」を静かに返すためである。

通常 INNER JOIN の既存 truncate 契約は B158 では変更しない。完全入力の追加は `CROSS JOIN` を含む SELECT に限定する。

### 7.3 `maxRecords`

`maxRecords` と直積上限は別の契約である。

| 上限 | 対象 | 既定 | 可変性 |
|---|---|---:|---|
| `maxRecords` | 各物理 APP の取得行数 | surface の既存値 | 既存 option/profile で変更可 |
| temp table 上限 | 各一時テーブルの実体化行数 | 10,000 | `tempTableMaxRows` |
| `GENERATE_SERIES` 上限 | WITH 内の系列生成 | 10,000 | 固定 |
| `CROSS JOIN` 上限 | 各直積段の出力行数 | 10,000 | Phase 1 では固定 |

`maxRecords=50,000` にしても `CROSS_JOIN_MAX_ROWS` は 10,000 のままである。

物理 APP が `maxRecords` を超えた場合は、直積上限エラーではなく既存の完全入力付き `FetchAllLimitError` を先に返す。

---

## 8. WHERE pushdown と JOIN キー prefilter

### 8.1 JOIN キー prefilter

`CROSS JOIN` には JOIN キーがないため、B150 の JOIN キー prefilter は適用しない。

次を行ってはならない。

- `planJoinKeyPrefilter()` を呼ぶ
- `IN` / range 用の JOIN キーを収集する
- `join key prefilter:` を CROSS JOIN に表示する
- JOIN キーのために fields API を要求する
- `on` が無いことを fallback として扱う

runtime の `tryFetchJoinRecordsBySourceKeys()` は `join.type === "INNER"` の場合だけ到達する既存 gateを維持する。`CROSS` を INNER 扱いでここへ流してはならない。

### 8.2 alias-local WHERE leaf

次のような右側物理 APP だけを参照する WHERE leaf は、直積前に絞り込んでも結果集合が変わらない。

```sql
WITH s AS (
  GENERATE_SERIES(1, 10) AS n
)
SELECT s.n, m.製品名
FROM s
CROSS JOIN APP4229 AS m
WHERE m.$id <= 8
```

したがって、B155 の共有 leaf policy で安全と判定できる物理 APP leaf は、`CROSS JOIN` でも対象 APP の records API query へ送る。

上の例の serializer 正本は次である。

```text
$id <= 8
```

`fetchAll` の先頭 records API query は次となる。

```text
$id <= 8 order by $id asc limit 500 offset 0
```

B155 と同じく、元 WHERE は JOIN 後にも residual として再評価する。

### 8.3 direct physical plan の gate

`buildRuntimeJoinPushdownPlan()` の現行 gate は、すべての JOIN が `INNER` のときだけ direct physical plan を作る。

根拠: `src/execute.ts:3966-3981`

B158 では、WHERE leaf の ownership/pushdown に限り次を許可する。

```text
join.type ∈ { INNER, CROSS }
```

ただし次は別 gate のままとする。

- JOIN キー prefilter: `INNER` のみ
- outer join を含む plan: 従来どおり direct plan 対象外
- CTE・一時テーブル・サブテーブルの leaf: API pushdown 対象外
- cross-alias `OR`: 従来どおり不採用
- field-to-field、式、未解決 ownership: 従来どおり不採用

### 8.4 ガードに使う行数

安全な WHERE prefilter が実際に records API へ適用された場合、ガードは絞り込み後に取得した候補行数を使用する。

```text
右 APP 全体 1,000 行
WHERE exact prefilter 後 8 行
左系列 365 行
→ 365×8=2,920 行
```

local residual だけの WHERE は JOIN 後に評価されるため、直積ガードを減らさない。

```text
右 APP 1,000 行
local-only WHERE の最終一致 8 行
左系列 365 行
→ guard は 365×1,000 で超過
```

Phase 1 では、直積ガードを通すための新しい local WHERE 押し下げ器を作らない。

---

## 9. GROUP BY・ウィンドウ・ORDER BY

### 9.1 同一 SELECT の既存制約

現行 parser は、ウィンドウ列と GROUP BY または集計列を同じ SELECT に置くことを拒否する。

根拠: `src/parser/parser.ts:1210-1214`

B158 はこの制約を変更しない。日次集計、0 埋め、ウィンドウは CTE で段を分ける。

### 9.2 実行順

直積後は既存順序を維持する。

```text
CROSS JOIN
→ residual WHERE
→ GROUP BY / aggregate
→ window
→ ORDER BY
```

`LIMIT` を直積ガードより前へ移してはならない。

### 9.3 メタデータ

CTE の materialized column metadata は既存の `inferSelectColumnMeta()` で伝播する。

現行実装は次を行う。

- 物理列の型・意味型を解決する。  
  `src/execute.ts:4615-4665`
- aggregate、CASE、window の出力 metadata を推論する。  
  `src/execute.ts:4710-4755`
- CTE を含む ORDER BY / window ORDER BY の metadata を組み立てる。  
  `src/execute.ts:6310-6327`

B158 では、CROSS JOIN が metadata の境界になってはならない。

最低限、次を維持する。

- `GENERATE_SERIES` の日付列は DATE semantics
- 製品名は string semantics
- `SUM` 結果は number semantics
- `CASE WHEN 実績='' THEN 0 ELSE 実績 END` は number semantics
- 0 埋め列を読む `SUM(...) OVER` は number semantics
- `PARTITION BY 製品名 ORDER BY 日付` は CTE metadata を参照できる

### 9.4 `explainNeedsAppMetadata`

現行 `selectNeedsOwnMetadata()` は JOIN キーの `join.on` を直接読む。

根拠: `src/core/explainMetadata.ts:68-84`

`CROSS JOIN` は次のように扱う。

- JOIN キー metadata は不要。
- WHERE、GROUP BY、ORDER BY、window が別途 metadata を必要とする場合だけ、その既存理由で true とする。
- `join.on === null` を参照して例外にしてはならない。
- CROSS JOIN の行数表示のために fields API や records API を要求してはならない。

---

## 10. EXPLAIN 契約

### 10.1 静的に行数が分かる場合

```sql
EXPLAIN WITH
a AS (GENERATE_SERIES(1, 3) AS x),
b AS (GENERATE_SERIES(1, 4) AS y)
SELECT a.x, b.y
FROM a
CROSS JOIN b
```

必須表示:

```text
cross join:    a × b
left rows:     3
right rows:    4
rows:          12
row guard:     12 / 10000
guard timing:  before row materialization
records API:   none
```

### 10.2 物理入力を含む場合

records API を呼ばずに物理 APP の現在行数を正確に知ることはできない。

したがって、EXPLAIN は推測値を正確値として表示せず、静的に分かる operand と runtime 算出式を表示する。

```sql
EXPLAIN WITH d AS (
  GENERATE_SERIES('2026-01-01', '2026-12-31') AS 日付
)
SELECT d.日付, m.製品名
FROM d
CROSS JOIN APP4229 AS m
```

必須表示:

```text
cross join:    d × m
left rows:     365
right rows:    runtime (APP4229 fetched rows)
rows:          runtime (365 × right rows)
row guard:     runtime checked / 10000
guard timing:  after complete source fetch, before row materialization
records API:   none
```

「365×maxRecords」を実生成件数として表示してはならない。`maxRecords` は上限であり実件数ではない。

### 10.3 静的行数解析

EXPLAIN が exact と表示できるのは、コードから行数を証明できる場合だけとする。

Phase 1 の exact 候補:

- literal `GENERATE_SERIES`
- no-FROM SELECT の 1 行
- 行数が exact な CTE に対する、行数保存が証明できる SELECT
- exact な左右入力の CROSS JOIN
- `WHERE FALSE` による 0 行

次を含む入力は原則 runtime とする。

- 物理 APP
- 一時テーブルの実体化前
- WHERE の結果件数
- GROUP BY / DISTINCT / aggregate
- runtime variable を含む系列
- source row count が不明な JOIN
- サブテーブル展開

静的行数解析と runtime guard は同じ `planCrossJoinRows()` を使用する。

### 10.4 API 契約

| surface | records API | metadata API |
|---|:---:|:---:|
| engine `EXPLAIN` | 0 回 | 既存 metadata 要否に従う |
| MCP `ksql_explain` | 0 回 | 既存 metadata 要否に従う |
| CLI `--dry-run` B158 静的経路 | **全 API 0 回** | 0 回 |
| 実 SELECT | 入力取得に必要な回数 | 既存要否に従う |

CLI `--dry-run` は B155 の静的 candidate 表示と同様、metadata 未解決時に悲観的な確定計画を捏造しない。

```text
pushdown candidate: ...
実行時の型・実在確認待ち
```

B157 の教訓に従い、複文バッチでも診断ブロックと計画本体の表示を一致させる。

---

## 11. 受入条件

### 11.1 基本直積

```sql
WITH
a AS (GENERATE_SERIES(1, 3) AS x),
b AS (GENERATE_SERIES(10, 20, 10) AS y)
SELECT a.x, b.y
FROM a
CROSS JOIN b
ORDER BY a.x, b.y
```

期待 rows:

| x | y |
|---:|---:|
| 1 | 10 |
| 1 | 20 |
| 2 | 10 |
| 2 | 20 |
| 3 | 10 |
| 3 | 20 |

`rowCount=6`。

### 11.2 空側

```sql
WITH
a AS (GENERATE_SERIES(1, 5, -1) AS x),
b AS (GENERATE_SERIES(1, 3) AS y)
SELECT a.x, b.y
FROM a
CROSS JOIN b
```

左が 0 行なので結果も 0 行。行数ガードは `0 / 10000`。

左右を逆にした形も 0 行。

### 11.3 上限境界

```sql
WITH
a AS (GENERATE_SERIES(1, 100) AS x),
b AS (GENERATE_SERIES(1, 100) AS y)
SELECT a.x, b.y
FROM a
CROSS JOIN b
```

10,000 行で成功。

```sql
WITH
a AS (GENERATE_SERIES(1, 101) AS x),
b AS (GENERATE_SERIES(1, 100) AS y)
SELECT a.x, b.y
FROM a
CROSS JOIN b
```

次で失敗。

```text
ArgumentError: CROSS JOIN の生成件数 10100 行（左 101 行 × 右 100 行）が上限 10000 行を超えています。
```

`LIMIT 1`、`WHERE FALSE` 以外の後段 WHERE、`DISTINCT`、`GROUP BY` を付けても免除しない。

### 11.4 WHERE prefilter と実 serializer

```sql
WITH s AS (
  GENERATE_SERIES(1, 365) AS n
)
SELECT s.n, m.製品名
FROM s
CROSS JOIN APP4229 AS m
WHERE m.$id <= 8
ORDER BY s.n, m.$id
```

必須事項:

- CROSS JOIN 用 JOIN キー prefilter は表示しない。
- `$id <= 8` は APP4229 の安全な alias-local WHERE leaf として押し下げる。
- serializer の base query は逐語で `$id <= 8`。
- 先頭 records API query は逐語で次。

```text
$id <= 8 order by $id asc limit 500 offset 0
```

- APP4229 が 8 行なら guard は `365×8=2920`。
- 元 WHERE を JOIN 後にも再評価する。
- prefilter 無効の参照経路と rows が一致する。

### 11.5 物理 APP × 物理 APP

```sql
SELECT a.$id AS a_id, b.$id AS b_id
FROM APP100 AS a
CROSS JOIN APP200 AS b
WHERE a.$id <= 10
  AND b.$id <= 20
ORDER BY a.$id, b.$id
```

10 行×20 行なら 200 行。

両 WHERE leaf が各 APP へ送られること。片側だけを誤って両 APP の query へ送らないこと。

### 11.6 サブテーブル

展開後 50 行の `APP100$明細` と 3 行 CTE の直積が 150 行になること。

展開後 5,001 行と 2 行の直積は 10,002 行として、行生成前に拒否すること。

---

## 12. R17 製品別暦日形

次の 3 段が通ることを B158 の代表受入とする。

1. 日付系列 `CROSS JOIN` 製品マスタ CTE
2. 日次実績を `LEFT JOIN`
3. 0 埋め済み入力に固定境界ウィンドウ

現行 JOIN は等値 1 本だけなので、日付＋製品の複合キーは CTE で明示的に 1 列へ構成する。

```sql
WITH
日付系列 AS (
  GENERATE_SERIES('2025-08-01', '2026-07-31', '1 day') AS 日付
),
製品マスタ AS (
  SELECT 製品名
  FROM APP4229
),
日次実績 AS (
  SELECT
    日付,
    製品名,
    CONCAT(日付, '|', 製品名) AS 格子キー,
    SUM(個数_在庫計算用) AS 日次増減
  FROM APP4228
  GROUP BY 日付, 製品名
),
格子 AS (
  SELECT
    d.日付,
    m.製品名,
    CONCAT(d.日付, '|', m.製品名) AS 格子キー
  FROM 日付系列 AS d
  CROSS JOIN 製品マスタ AS m
),
0埋め AS (
  SELECT
    g.日付,
    g.製品名,
    CASE
      WHEN f.日次増減 = '' THEN 0
      ELSE f.日次増減
    END AS 日次増減
  FROM 格子 AS g
  LEFT JOIN 日次実績 AS f ON g.格子キー = f.格子キー
)
SELECT
  日付,
  製品名,
  日次増減,
  SUM(日次増減) OVER (
    PARTITION BY 製品名
    ORDER BY 日付
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  ) AS 暦日在庫
FROM 0埋め
ORDER BY 製品名, 日付
```

受入データは次を含む。

- 製品数 8
- 日付系列 365 日
- 格子 2,920 行
- 期間中に取引が 1 件も無い日×製品
- 同日に複数取引がある製品
- 正負の `個数_在庫計算用`

必須結果:

- 格子は 365×8＝2,920 行。
- 取引の無い日×製品にも 1 行ある。
- その行の `日次増減` は数値 `0`。
- `暦日在庫` は前日の値を維持する。
- 製品間でウィンドウ値が混ざらない。
- 最終日の `暦日在庫` は同期間の製品別 `SUM(個数_在庫計算用)` と一致する。
- window 出力 metadata は number。
- `ORDER BY 日付` は生成 DATE metadata を使う。
- 直積 guard は 2,920 / 10,000。
- `EXPLAIN` は records API 0 回。
- CLI `--dry-run` は全 API 0 回。

---

## 13. parser・AST 回帰

必須 parser test:

1. `CROSS JOIN` を大文字小文字を問わず受理する。
2. 通常 `JOIN` / `INNER JOIN` / `LEFT JOIN` / `RIGHT JOIN` は AST 不変。
3. `CROSS JOIN` の AST は `{ type: "CROSS", table, on: null }`。
4. `CROSS JOIN ... ON` を専用 ParseError にする。
5. `LEFT CROSS JOIN` / `RIGHT CROSS JOIN` / `INNER CROSS JOIN` を専用 ParseError にする。
6. `ON 1=1` を引き続き拒否する。
7. カンマ結合を引き続き拒否する。
8. `FROM GENERATE_SERIES(...)` を引き続き拒否する。
9. バッククォート付き `` `CROSS` `` は識別子として使える。
10. `LEFT()` / `RIGHT()` 関数と LEFT/RIGHT JOIN の共存が不変。
11. parser compatibility snapshot を更新し、既存 SQL の AST 差分が CROSS の追加以外に無い。

---

## 14. 実行・回帰テスト

### 14.1 unit

追加対象候補:

- `src/core/optimization/__tests__/crossJoinRowPlan.test.ts`
- `src/parser/__tests__/parser.test.ts`
- `src/engine/__tests__/process.test.ts`
- `src/core/__tests__/explainMetadata.test.ts`

必須内容:

- 0×N、N×0、1×1
- 100×100
- 101×100
- 多段 CROSS JOIN
- 通常 JOIN との混在
- stable nested-loop order
- 行生成前に超過すること
- `join.on` の CROSS narrowing
- EXPLAIN metadata 判定で CROSS が JOIN キー metadata を要求しないこと

### 14.2 integration

追加する B158 acceptance testで次を確認する。

1. 系列 CTE×CTE
2. 系列 CTE×物理 APP
3. 一時テーブル×物理 APP
4. 物理 APP×物理 APP
5. サブテーブル×CTE
6. WHERE exact prefilter
7. WHERE superset prefilter
8. local-only residual
9. prefilter 有効/無効の rows 一致
10. GROUP BY を別 CTE に置く形
11. LEFT JOIN 後の 0 埋め
12. 固定境界ウィンドウ
13. metadata の DATE/string/number 伝播
14. `maxRecords` 超過
15. CROSS row guard 超過

### 14.3 CLI dry-run e2e

API rejecting clientを使い、1 回でも API へ到達したら失敗させる。

逐語 SQL:

```sql
WITH
d AS (
  GENERATE_SERIES('2026-08-01', '2026-08-07') AS 日付
),
m AS (
  SELECT 製品名 FROM APP4229
)
SELECT d.日付, m.製品名
FROM d
CROSS JOIN m
ORDER BY d.日付, m.製品名
```

必須条件:

- exit code 0
- `DryRunError` なし
- API request 0 件
- `cross join:` 表示
- 左 7 行は静的表示
- 右は runtime 表示
- `row guard: runtime checked / 10000`
- records API none
- JOIN キー prefilter 表示なし

複文バッチでも同じ API 0 回を確認する。

### 14.4 全回帰

最低限次を通す。

```text
npm test
npm run build
npm run build:cli
```

加えて次の既存範囲を必須回帰とする。

- INNER / LEFT / RIGHT JOIN
- B51 CTE-to-CTE JOIN
- B76 JOIN predicate pushdown
- B79/B98 outer join fail-closed
- B123 EXPLAIN metadata
- B125 window
- B140 window warning
- B149 GENERATE_SERIES
- B150 JOIN key range prefilter
- B151/B152 typed leaf
- B155 unified leaf policy
- B157 CLI dry-run metadata
- temp table
- subtable virtual table
- INSERT/UPSERT SELECT
- Firefox/Chrome plugin smoke

---

## 15. DML・公開 surface

`CROSS JOIN` は SELECT grammar の追加なので、SELECT を入力に取る次の経路でも同じ AST・guard を使う。

- top-level SELECT
- WITH CTE
- CREATE TEMP TABLE AS SELECT
- INSERT ... SELECT
- UPSERT ... SELECT
- scalar/EXISTS 等の SELECT
- EXPLAIN

DML では既存の確認、書込件数ガード、`VALIDATE ONLY` を維持する。

直積ガード超過は mutation API より前に発生しなければならない。超過時に POST/PUT/DELETE API を 1 回でも呼んではならない。

公開 surface:

- engine library
- CLI
- CLI `--dry-run`
- MCP query
- MCP `ksql_explain`
- saved query
- Firefox plugin
- Chrome plugin

すべて同じ parser・AST・runtime guard・エラー文を使用する。

---

## 16. Claude が実測すべき項目

### 16.1 修正前の 3 形

v3.62.0 で次を記録する。

```sql
FROM s CROSS JOIN APP4229 AS m
```

```sql
FROM s INNER JOIN APP4229 AS m ON 1 = 1
```

```sql
FROM s, APP4229 AS m
```

記録項目:

- SQL 全文
- ParseError 全文
- kSQL version

### 16.2 基本直積

- 3×2 の逐語 rows
- 0×N
- N×0
- 100×100
- 101×100
- 行順
- エラーが部分 rows を返さないこと

### 16.3 実 serializer

§11.4 を実行し、次を記録する。

- SQL 全文
- EXPLAIN 全文
- 実 records API query
- APP4229 revision
- APP4229 取得件数
- guard の左右行数
- 出力 row count
- prefilter 無効時との rows 比較

### 16.4 経路別

同じ小データで次を比較する。

- CTE×CTE
- CTE×APP
- temp×APP
- APP×APP
- subtable×CTE

比較項目:

- row count
- row values
- 明示 ORDER BY 後の順序
- guard 表示
- complete input 表示
- API call count
- warning

### 16.5 R17 形

§12 を APP4228/APP4229 で実行し、次を保存する。

- 製品数
- 日付数
- 期待格子行数
- 実格子行数
- guard 表示
- 取引無し日×製品の具体例
- その `日次増減=0`
- 前日と同じ `暦日在庫`
- 製品別最終残高と単純 SUM の一致
- EXPLAIN
- 実 serializer query
- APP revision
- kSQL version

### 16.6 API 0 回

CLI `--dry-run` で単文・複文の双方を実測する。

記録対象:

- records API 0
- fields API 0
- status/process API 0
- settings API 0
- CTE 実体化 SELECT 0
- exit code 0
- `DryRunError` なし

MCP `ksql_explain` は records API 0 回を確認する。

### 16.7 ブラウザ

Firefox/Chrome pluginで次を確認する。

- 基本 CROSS JOIN
- R17 形
- guard 境界
- guard 超過エラー全文
- EXPLAIN
- 取引無し日×製品の 0
- CLI/engine と rows 一致
- 生の JavaScript error や kintone error が露出しないこと

ブラウザ実機 smoke は Node test で代替しない。

---

## 17. Phase 線引き

### 17.1 B158 に含めるもの

- `CROSS` keyword
- `CROSS JOIN table_ref`
- discriminated JOIN AST
- 標準直積意味論
- CTE/temp/APP/subtable の組み合わせ
- 10,000 行 guard
- 完全入力 `CROSS_JOIN`
- EXPLAIN の左右行数・生成行数または runtime 式
- dry-run API 0 回
- alias-local WHERE prefilter
- JOIN キー prefilter の明示的非適用
- GROUP BY/window/ORDER BY の既存 pipeline 利用
- materialized column metadata の伝播
- R17 の製品別暦日形
- engine/CLI/MCP/plugin の全 surface
- 既存 JOIN 全回帰

### 17.2 B158 に含めないもの

- `INNER JOIN ... ON 1=1`
- `ON TRUE`
- カンマ結合
- 複合 `ON`
- `AND` を含む JOIN condition
- non-equi JOIN
- `USING`
- `NATURAL JOIN`
- `FULL JOIN`
- `LEFT CROSS JOIN` / `RIGHT CROSS JOIN`
- lateral join
- table function としての `FROM GENERATE_SERIES(...)`
- derived table の新設
- local WHERE の新しい source-level pushdown
- cost-based join reorder
- hash cross join
- spill-to-disk
- CROSS 上限の利用者 override
- `maxRecords` と CROSS 上限の統合
- B128 Phase 2a の移動フレーム
- B159 month/year step
- B160 window warning 文言変更
- 複合キー JOIN の新設

### 17.3 B128 との関係

B158 は B128 Phase 2a の前提だが、B158 自体は固定境界ウィンドウだけで独立した価値を持つ。

順序は次を維持する。

```text
B158 CROSS JOIN
→ B159 month/year step
→ B160 generated-column window warning
→ B128 Phase 2a
```

B158 の完了を B128 Phase 2a の同時実装に依存させない。

---

## 18. 実装順序

### Step 1: lexer・parser・AST

- `CROSS` token/keyword
- discriminated `JoinClause`
- `CROSS JOIN` parser
- 専用 ParseError
- parser compatibility 回帰

### Step 2: 共通 row plan

- `GENERATED_ROW_MAX_ROWS`
- `CROSS_JOIN_MAX_ROWS`
- `planCrossJoinRows()`
- 境界・空入力・超過 unit test

### Step 3: runtime

- CROSS dispatch
- 行生成前 guard
- stable nested loop
- table column metadata の合流
- 通常 JOIN 非回帰

### Step 4: fetch・complete input

- `CROSS_JOIN` complete reason
- truncate 無効化
- APP/temp/subtable 経路
- `maxRecords` と guard のエラー優先順

### Step 5: pushdown

- direct physical WHERE plan の `INNER|CROSS` 許可
- JOIN キー prefilter の INNER-only 維持
- B155 leaf policy 再利用
- actual serializer 回帰

### Step 6: EXPLAIN・dry-run

- exact/runtime 行数表示
- guard timing
- records API none
- CLI 静的経路 API 0
- B157 複文表示回帰

### Step 7: metadata・分析形

- `join.on` 全参照の narrowing
- `inferSelectColumnMeta`
- `buildOrderByMetaForSelect`
- `explainNeedsAppMetadata`
- R17 3 段 SQL

### Step 8: release gate

- unit/integration/e2e
- build
- CLI/MCP
- Claude 実測
- Firefox/Chrome smoke
- issue tracker、言語リファレンス、MCP syntax catalog、release history の同期

---

## 19. 完了条件

B158 は次をすべて満たした場合だけ完了とする。

1. 明示 `CROSS JOIN` が parse できる。
2. `ON` 無しを AST で型安全に表現している。
3. `LEFT/RIGHT/INNER CROSS JOIN` を専用 ParseError にする。
4. `CROSS JOIN ... ON` を専用 ParseError にする。
5. `ON 1=1` とカンマ結合を開放していない。
6. 通常 JOIN の等値 1 本・両辺列契約が不変。
7. 左 N 行×右 M 行が N×M 行になる。
8. 空側があれば 0 行になる。
9. 直積上限が 10,000 行である。
10. 10,000 行は成功し、10,001 行以上は失敗する。
11. guard が行生成前に実行される。
12. 許可判定・行数算出が 1 helper に集約されている。
13. 系列 CTE×物理 APP が通る。
14. CTE/temp/APP/subtable の全組み合わせが仕様どおりである。
15. 物理 APP×物理 APP を実行時 guard で安全に扱う。
16. サブテーブルは展開後行数で判定する。
17. `CROSS_JOIN` が完全入力理由になる。
18. `onLimit=truncate` を無効化する。
19. `maxRecords` と CROSS guard を混同しない。
20. JOIN キー prefilter を CROSS に適用しない。
21. alias-local WHERE leaf は B155 policy で押し下げられる。
22. 元 WHERE の residual 再評価が維持される。
23. actual serializer query が EXPLAIN と一致する。
24. EXPLAIN が exact 値または runtime 算出式を表示する。
25. 物理件数を推測して exact と表示しない。
26. EXPLAIN が records API を呼ばない。
27. CLI `--dry-run` の B158 静的経路が全 API 0 回で成功する。
28. 複文 dry-run の診断と計画が一致する。
29. GROUP BY、window、ORDER BY の既存順序が不変。
30. CTE metadata が CROSS JOIN を越えて伝播する。
31. §12 の R17 形が 365×8＝2,920 行を生成する。
32. 取引の無い日×製品が `日次増減=0` で出る。
33. 固定境界ウィンドウで製品別暦日在庫が得られる。
34. INNER/LEFT/RIGHT JOIN の全回帰が通る。
35. B149/B150/B151/B152/B155/B157 の回帰が通る。
36. DML source で guard 超過時に mutation API を呼ばない。
37. engine/CLI/MCP の公開結果が一致する。
38. Firefox/Chrome plugin 実機 smoke が成功する。
39. 文書・syntax catalog・issue tracker・release history が同じ契約へ同期する。
40. 実測と異なる経路を推測だけで完了扱いにしない。