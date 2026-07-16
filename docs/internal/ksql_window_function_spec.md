# 仕様案: ウィンドウ関数サブセット `ROW_NUMBER` / `RANK` / `DENSE_RANK`（B17）

- 作成日: 2026-07-16
- 位置づけ: [主要 RDB 機能比較評価](ksql_sql_feature_comparison_evaluation.md) §3 T1-1 で「**最大の欠落**」と評価した機能。
- ステータス: **仕様案 R2（codex レビュー反映済み・実装着手可）。未実装。**
- 分担: Claude=仕様/観点、Codex=実装/テスト
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md)

---

## 0. 効果の確定: 「**不可能 → 可能**」。しかも **CTE で 1 文**（R2 で再訂正）

評価と R1 で 2 回書き間違えたので、実機で確定させた結論を先に置く。

### 0.1 結論

| 主張 | 判定 |
|---|---|
| 比較評価「派生テーブルで **1 文**」 | ❌ **誤り**。kSQL は派生テーブル `FROM (SELECT …)` に非対応（実測 `ParseError`） |
| R1「派生テーブルが無いので **2 文**（temp 経由）」 | ❌ **誤り**。**`WITH` CTE があるので 1 文で書ける**（実測: `WITH c AS (…) SELECT … FROM c WHERE …` は動作） |
| 「`MAX()` 回避策では最新行の**他列**が取れない」 | ✅ **正しい**（下記） |

**正しい 1 文形**:

```sql
WITH ranked AS (
  SELECT 顧客ID, 受注日, 金額,
         ROW_NUMBER() OVER (PARTITION BY 顧客ID ORDER BY 受注日 DESC) AS rn
  FROM APP300
)
SELECT 顧客ID, 受注日, 金額 FROM ranked WHERE rn = 1;
```

CTE は非インライン時に実体化され、後段の `WHERE` はその実体化結果に対して評価される（[execute.ts:2072-2077](../../src/execute.ts#L2072)）。**派生テーブルは B17 の 1 文化に不要**（独立課題・§8）。

### 0.2 それでも「不可能 → 可能」である理由（実測）

現状の `MAX()` + `GROUP BY` 回避策では、**最大値を持つ行の他列を取得できない**。取得するには `(グループキー, 最大値)` で元行へ結合し直す必要があるが:

- **JOIN が複合キー結合に非対応**（実測: `ON a.業種 = t.業種 AND a.顧客No = t.最新No` → `AND` で `ParseError`。JOIN は**単一等値のみ**）
- **派生テーブルも非対応**（§0.1）

したがって「**各グループの最新 1 件を、その行の全列とともに取得する**」は**現状の kSQL では表現できない**。B17 はこれを初めて可能にする（＝「3 文→1 文」ではなく「**不可能→可能**」）。

### 0.3 【重要】CTE インライン化との相互作用（R2 で追加・codex 指摘外）

上記 1 文形の正しさは、**ウィンドウ列が FULL_SCAN を強制すること**に依存する。

`canInlineSingleCte`（[cteInlining.ts:5-16](../../src/core/cteInlining.ts#L5)）は「CTE が 1 つ・**CTE 本体が SIMPLE**・最終クエリが JOIN/GROUP BY/DISTINCT/集計を持たない」とき CTE をインライン化し、`buildInlinedQuery`（[:19-27](../../src/core/cteInlining.ts#L19)）は**最終クエリの `WHERE` を CTE 本体の `WHERE` へ `AND` で併合**する。

つまり **CTE 本体のウィンドウ列が `resolveSelectMode` で FULL_SCAN と判定されないと**、上の 1 文形はインライン化され、`WHERE rn = 1` が**存在しないフィールド `rn` への kintone クエリ条件**として押し込まれる。

→ §5 の「ウィンドウ列があれば FULL_SCAN 強制」は**モードの好みではなく、看板ユースケースの正しさを支える必須条件**。受入条件で 1 文形の実動作を固定する。

## 1. 課題

主要 RDB がすべて持つウィンドウ関数が無く、次の定番が書けない:

| ユースケース | 現状 |
|---|---|
| **各顧客の最新受注 1 件（金額なども含む全列）** | **表現不可能**（§0） |
| 売上ランキング（同順位・順位飛ばし） | 表現不可能 |
| グループ内の連番付与 | 表現不可能 |

`MAX()` + `GROUP BY` で取れるのは「グループキーと最大値だけ」であり、その行の他の列は取れない。

## 2. 現状（コード裏取り済み）

### 2.1 FULL_SCAN のパイプライン

`runFullScan`（[process.ts:930 付近](../../src/engine/process.ts#L930)）は次の順で処理する:

```
1. flatten → 2. join → 3. filter(WHERE) → 4. GROUP BY+集計 → 5. HAVING
→ 6. DISTINCT → 7. ORDER BY → 8. LIMIT/OFFSET
```

SQL 標準のウィンドウ評価位置は **HAVING の後・DISTINCT/ORDER BY の前**。つまり **5 と 6 の間**に差し込む。

### 2.2 再利用できる基盤: `applyOrderBy`

`applyOrderBy`（[process.ts:503](../../src/engine/process.ts#L503)）は**ウィンドウの `ORDER BY` にそのまま使える設計**:

```ts
export function applyOrderBy(
  rows: ProcessRow[], orderBy: OrderByItem[],
  optionOrders?: OptionOrderMap,      // 選択系の「選択肢の定義順」
  sortKinds?: FieldSortKindMap        // number | string
): ProcessRow[]
```

- 行ごとにソートキーを前計算 → 比較 → 並べ替え。**パーティションごとに呼べば良い**。
- **`optionOrders` が重要**: ドロップダウン等は**選択肢の定義順**で並ぶ（辞書順ではない）。ウィンドウの `ORDER BY` もこれに揃えないと、同じ `ORDER BY 業種` がトップレベルとウィンドウで**違う順序**になる。

### 2.3 **罠: ソートメタが実際にはロードされない**（B13 P1-1 と同型）

`buildOrderByMetaForSelect`（[execute.ts:2684](../../src/execute.ts#L2684)）は**トップレベル `ORDER BY` が無ければ空 Map を返す**:

```ts
if (stmt.orderBy.length === 0) {
  return { optionOrders: new Map(), sortKinds: new Map() };   // ← 早期 return
}
```

`SELECT *, ROW_NUMBER() OVER (PARTITION BY 顧客ID ORDER BY 受注日 DESC) AS rn FROM APP300` は **`stmt.orderBy.length === 0`**（トップレベルに `ORDER BY` が無い）。このままだと `optionOrders` / `sortKinds` が空になり、**ウィンドウの `ORDER BY` が数値を辞書順で並べ、選択系を定義順で並べない**。

> **`buildSortKindsForSelect` / `buildOptionOrdersForSelect` 自体は物理アプリの全フィールドを読む**（[execute.ts:2727/2694](../../src/execute.ts#L2727)）ため、**ゲートを開けさえすればウィンドウの `ORDER BY` 列も自動的に含まれる**。修正は早期 return の条件だけで済む。

### 2.4 **罠: ウィンドウキーのフィールドが API から取得されない**（R2 で追加）

`collectRequiredFieldsByTable`（[selectToKintone.ts:577 付近](../../src/converter/selectToKintone.ts#L577)）は `stmt.columns` / WHERE / GROUP BY / トップレベル ORDER BY を走査して**kintone から取得するフィールドを決める**。ウィンドウ列を追加しただけでは `partitionBy` / `orderBy` のキーが走査されない。

```sql
-- 受注日 を SELECT していない
SELECT 顧客ID, ROW_NUMBER() OVER (PARTITION BY 顧客ID ORDER BY 受注日 DESC) AS rn FROM APP300
```

→ `受注日` が取得フィールドに入らず、全行で `row["受注日"] === undefined` → **全行が同値扱い**になり `rn` が並び順どおりにならない。**静かに壊れる**（エラーにならない）。

→ §5 で `WindowColumn` の `partitionBy` / `orderBy` を走査対象に追加し、**キーを SELECT しない受入テスト**を必須にする。

### 2.5 比較器のフォールバック（R2 で明確化）

`compareSortKeys`（[process.ts:559-569](../../src/engine/process.ts#L559)）の優先順位:

```ts
if (meta.orderMap)  → 選択肢の定義順（rank）で比較
if (meta.sortKind === "string") → 辞書順（localeCompare "ja"）
それ以外（sortKind="number" / メタ無し） → 両辺が数値なら数値比較、でなければ辞書順
```

つまり**メタが無くても「値ベースの自動判定」で動く**（実測: `SELECT 顧客No FROM #t ORDER BY 顧客No DESC` は temp 由来でメタが無いが `214, 213, 212` と数値順）。`optionOrders` / `sortKinds` は**その自動判定を上書きして正しくする**役割:

- `sortKinds="string"`: 郵便番号のような**数値に見えるテキスト**を辞書順に矯正
- `optionOrders`: 選択系を**選択肢の定義順**に矯正（辞書順ではない）

### 2.6 その他

| 項目 | 現状 |
|---|---|
| 派生テーブル `FROM (SELECT …)` | **非対応**（§0・実測）。ただし **CTE があるので 1 文化には不要** |
| JOIN の複合キー結合 | **非対応**（単一等値のみ・実測） |
| CTE インライン化 | `canInlineSingleCte` が CTE 本体 SIMPLE 時にインライン化し、**外側 WHERE を CTE へ AND 併合**（§0.3・**FULL_SCAN 強制が必須の理由**） |
| **CTE/temp 由来のソートメタ** | `buildOptionOrdersForSelect` / `buildSortKindsForSelect` はともに **`cteName != null` をスキップ**（[execute.ts:2737](../../src/execute.ts#L2737) 等）。B14 の `columnMeta` にも `optionOrder` は無い（`sortKind`/`fieldType` のみ）。→ **CTE/temp 由来の列では選択肢定義順が使えず §2.5 の自動判定になる**。これは**既存のトップレベル `ORDER BY` と同じ**（B17 が新たに壊すわけではない）→ §4.6 で v1 の制限として明記 |
| DISTINCT のキー生成 | [process.ts:430 付近](../../src/engine/process.ts#L430) が列種別ごとにキーを作る。**ウィンドウ列は未対応**（§5） |
| 実行モード | 集約列があれば FULL_SCAN。ウィンドウ関数も**同様に FULL_SCAN 強制**が必要（§0.3 のとおり正しさの前提） |

## 3. スコープ

| 区分 | 内容 |
|---|---|
| **対象** | `ROW_NUMBER()` / `RANK()` / `DENSE_RANK()` ＋ `OVER ([PARTITION BY …] [ORDER BY …])` |
| **対象** | SELECT 列でのみ使用可。FULL_SCAN 強制。ウィンドウ結果での絞り込みは **CTE（`WITH`）で 1 文**、または一時テーブル経由（§0.1） |
| **非対象（v2）** | 集計の `OVER`（`SUM(x) OVER (…)`）・フレーム句（`ROWS BETWEEN …`）・`LAG`/`LEAD`/`NTILE`/`FIRST_VALUE` |
| **非対象（別課題）** | 派生テーブル `FROM (SELECT …)`・`QUALIFY`・複合キー JOIN |
| **非対象（v1 の制限）** | `GROUP BY` / 集計関数との併用（§4.8） |

## 4. 仕様

### 4.1 構文

```
<ウィンドウ関数>() OVER ( [PARTITION BY <フィールド> [, …]] [ORDER BY <フィールド> [ASC|DESC] [, …]] ) AS <alias>
```

- 関数は `ROW_NUMBER` / `RANK` / `DENSE_RANK` の 3 つ。**引数なし**（`ROW_NUMBER(x)` は `ParseError`）。
- `OVER` は**必須**（`ROW_NUMBER()` 単独は `ParseError`）。
- `PARTITION BY` / `ORDER BY` はともに省略可。両方省略した `OVER ()` も可（= 全行 1 パーティション・行順）。
- `PARTITION BY` のキーは**フィールド参照のみ**（`GROUP BY` と同じ規則。式・関数は v1 非対応）。
- `ORDER BY` のキーは**トップレベル `ORDER BY` と同じ規則**（`OrderByItem` を再利用）。
- `OVER`・`PARTITION` は**ソフトキーワード**として扱い、同名フィールドを壊さない（`SEPARATOR` の前例）。`ROW_NUMBER` / `RANK` / `DENSE_RANK` は**予約語**（`KLIKE` / `GROUP_CONCAT` の前例。バッククォートで回避可）。

### 4.2 評価位置

**HAVING の後・DISTINCT の前**（SQL 標準）。

`WHERE` はウィンドウより前に評価されるため、**同一 SELECT スコープの `WHERE` でウィンドウ結果を絞ることはできない**（標準どおり。`SELECT …, ROW_NUMBER() … AS rn FROM t WHERE rn = 1` は不可）。絞り込みは**外側のスコープ**で行う:

- **CTE（推奨・1 文）**: `WITH ranked AS (… ROW_NUMBER() … AS rn …) SELECT … FROM ranked WHERE rn = 1`（§0.1）
- 一時テーブル（複文）: `CREATE TEMP TABLE #ranked AS …;` → `SELECT … FROM #ranked WHERE rn = 1`

いずれも**外側の `WHERE` は実体化済みの行に対して評価される**。CTE 経路が正しく動くには §0.3 の FULL_SCAN 強制が必要。

### 4.3 意味論

| 規則 | 内容 |
|---|---|
| **パーティション** | `PARTITION BY` のキー値が等しい行が 1 パーティション。**空文字も 1 つの値**として扱う（`GROUP BY` と同じ）。省略時は全行 1 パーティション |
| **並び** | パーティション内を `ORDER BY` で並べる。**`applyOrderBy` と完全に同じ比較規則**（`optionOrders` による選択肢定義順・`sortKinds` による数値/辞書順）を使う |
| `ROW_NUMBER()` | 1 から始まる連番。**同値でも連番**（1,2,3,4） |
| `RANK()` | 同値は同順位・**次は飛ぶ**（1,1,3,4） |
| `DENSE_RANK()` | 同値は同順位・**飛ばさない**（1,1,2,3） |
| **`ORDER BY` 省略時** | 全行が同値扱い。`RANK`/`DENSE_RANK` は全行 1。`ROW_NUMBER` は**行順**（＝取得順）で連番。順序保証が要るなら `ORDER BY` を書く |
| **戻り値** | 数値（1 以上の整数）。出力は他の列と同じく文字列化される |
| **`ORDER BY` の同値** | ROW_NUMBER の同値内の順序は**入力行順**（安定ソート）。決定性が要るなら一意になるキーを `ORDER BY` に足す |

### 4.4 出力列名（R2 で追加）

**v1 は `AS alias` を必須**とする（`ParseError: ウィンドウ関数には AS alias が必要です`）。

- 理由: alias 無しの合成名を規定すると、**`OVER` の中身まで含めないと衝突する**（`ROW_NUMBER() OVER (ORDER BY a)` と `ROW_NUMBER() OVER (ORDER BY b)` が同じ列名になる）。集約の合成名（`SUM(x)`）は引数だけで一意になるが、ウィンドウはそうならない。
- alias を必須にすれば合成名の規定・`isAggregateSyntheticName` 相当の判定・HAVING/ORDER BY からの合成名参照をすべて回避できる。**看板ユースケースは alias（`AS rn`）を必ず書く**ため実害は無い。
- v2 で必要になったら `ROW_NUMBER() OVER (PARTITION BY … ORDER BY …)` 全体を含む合成名を規定する。

### 4.5 複数のウィンドウ列（R2 で追加）

同一 SELECT に複数のウィンドウ列を書ける。**各列は同じ入力行集合に対して独立に評価**する（ある列の採番結果が他の列の入力に影響しない）。

```sql
SELECT 顧客ID, 金額,
       ROW_NUMBER() OVER (PARTITION BY 顧客ID ORDER BY 受注日 DESC) AS rn,
       RANK()       OVER (ORDER BY 金額 DESC)                        AS 全体順位
FROM APP300
```

### 4.6 CTE / 一時テーブル由来の列の並び（R2 で追加・v1 の制限）

ウィンドウの `ORDER BY` は**トップレベル `ORDER BY` と完全に同じ規則**（同じ比較器・同じメタ）で動く。したがって **CTE / 一時テーブル由来の列に対しては、既存のトップレベル `ORDER BY` と同様に**:

- **選択肢の定義順が使えない**（`optionOrders` が物理アプリのみ・§2.6）→ 選択系は辞書順になる
- `sortKinds` も無いため §2.5 の**値ベース自動判定**になる（数値に見えるテキストは数値順になり得る）

これは **B17 が新たに壊すものではなく、既存の `ORDER BY` と同じ挙動**である。「ウィンドウとトップレベルで並びが食い違わない」ことを優先し、v1 では**この制限を明記するにとどめる**（メタ伝播は B14 の `columnMeta` へ `optionOrder` を足す別課題）。

> **物理アプリを直接読む場合は影響なし**。§0.1 の看板 1 文形は CTE 本体が `FROM APP300`（物理）なので、選択肢順・型メタとも正しく効く。

### 4.7 型メタ（B14 との連携）

- ウィンドウ関数列は**常に数値**。B14 の `inferSelectColumnMeta` で `{ sortKind: "number" }` を宣言する（一時テーブル/CTE へ実体化後の `WHERE rn = 1` / `MAX(rn)` が数値として正しく効く）。

### 4.8 `GROUP BY` / 集計との併用は v1 非対応

同一 SELECT に `GROUP BY`・集計関数・ウィンドウ関数が混在する場合は **`ParseError`** とする。

- 理由: 標準では「集約後の行に対してウィンドウを適用」だが、`PARTITION BY` / `ORDER BY` が集約の出力列（alias・合成名）を参照する解決が必要になり、面が広がる。
- **看板ユースケース（各グループ最新 1 件・ランキング・連番）はいずれも `GROUP BY` を必要としない**ため、v1 の価値は損なわれない。
- 集約結果へ順位を付けたい場合は**スコープを分ける**。CTE なら 1 文で書ける:
  ```sql
  WITH agg AS (SELECT 部署, SUM(売上) AS 合計 FROM APP300 GROUP BY 部署)
  SELECT 部署, 合計, RANK() OVER (ORDER BY 合計 DESC) AS 順位 FROM agg;
  ```
  一時テーブル経由（複文）でも同じ。**いずれも v1 で書ける**（ウィンドウ側の SELECT に `GROUP BY`／集計が無いため）。

## 5. 実装差分

| 箇所 | 変更 |
|---|---|
| `src/lexer/tokens.ts` | `ROW_NUMBER` / `RANK` / `DENSE_RANK` を予約語に。`OVER` / `PARTITION` は**ソフトキーワード** |
| `src/types/ast.ts` | `WindowColumn`（`type: "WINDOW_COL"`・`func`・`partitionBy: FieldRef[]`・`orderBy: OrderByItem[]`・**`alias: string`**）を `SelectColumn` へ追加。他の列は `alias: string \| null` だが、ウィンドウ列は **alias 必須（§4.4）なので `string` にして不変条件を型で保証**する（`?? 合成名` のフォールバックを書けなくする） |
| `src/parser/parser.ts` | SELECT 列で `ROW_NUMBER()` 等を検出し `OVER (…)` を解析。**`OVER` 必須**・引数なし・**`AS alias` 必須**（§4.4）・`PARTITION BY` はフィールド参照のみ。`GROUP BY`/集計との併用は `ParseError`（§4.8） |
| **`resolveSelectMode`** | ウィンドウ列があれば **FULL_SCAN 強制**（`hasAggregateColumns` に相当する `hasWindowColumns` を追加）。**§0.3 のとおり CTE インライン化を止める役割も兼ね、看板 1 文形の正しさに直結する** |
| **`collectRequiredFieldsByTable`（[selectToKintone.ts:577 付近](../../src/converter/selectToKintone.ts#L577)）** | **`WindowColumn` の `partitionBy` / `orderBy` のキーを走査対象に追加**（§2.4）。これが無いとキーが API から取得されず**静かに全行同順位**になる |
| **DISTINCT のキー生成（[process.ts:430 付近](../../src/engine/process.ts#L430)）** | ウィンドウ列の出力値をキーへ含める。現状は列種別ごとの分岐でウィンドウ列を扱えず、`SELECT DISTINCT RANK() … AS r` が**全行同一キー**になり 1 行へ潰れる（§6） |
| **`buildOrderByMetaForSelect`（[execute.ts:2684](../../src/execute.ts#L2684)）** | 早期 return の条件を **`stmt.orderBy.length === 0 && ウィンドウの ORDER BY も無い`** へ変更（§2.3）。**これが無いと数値が辞書順で並ぶ** |
| `src/engine/process.ts` | `applyWindow(rows, columns, optionOrders, sortKinds)` を新設し、**HAVING と DISTINCT の間**で呼ぶ。パーティション分割 → **`applyOrderBy` でパーティション内を整列** → 採番。結果を各行へ **`alias`** で書き込む（alias は必須なので合成名の分岐は無い・§4.4） |
| `selectToKintone.ts` の出力列収集 | ウィンドウ列の **alias** を出力列として認識（`collectSelectOutputNames`）。合成名は無い（§4.4） |
| `inferSelectColumnMeta`（B14） | ウィンドウ列 → `{ sortKind: "number" }`（§4.7） |
| 言語リファレンス | 新節を追加。**同一スコープの `WHERE` ではウィンドウ結果を絞れない**（標準どおり）ことと、**絞り込みは CTE で 1 文**（または一時テーブル経由）で書くことを明記 |

### 5.1 採番アルゴリズム（パーティションごと）

```
sorted = applyOrderBy(partitionRows, window.orderBy, optionOrders, sortKinds)
ROW_NUMBER: 1..n を順に付与
RANK / DENSE_RANK:
  直前行と ORDER BY キーが「等しい」なら同順位
  等しさの判定は applyOrderBy の比較器と同一（cmp === 0）＝ 並びと順位の判定がズレない
  RANK       → 次の順位 = これまでの行数 + 1
  DENSE_RANK → 次の順位 = 直前順位 + 1
```

> **重要**: 同値判定に**独自の比較を書かない**。`applyOrderBy` が使う比較器（`compareSortKeys`）を共有する。別実装にすると「並びは同値なのに順位が別」といった不整合が起きる。

## 6. 受入条件

- [ ] `ROW_NUMBER() OVER (PARTITION BY k ORDER BY d DESC)` がパーティションごとに 1..n を付ける。
- [ ] `RANK` は同値で同順位・次が飛ぶ（1,1,3）。`DENSE_RANK` は飛ばない（1,1,2）。`ROW_NUMBER` は同値でも連番（1,2,3）。
- [ ] **看板（CTE で 1 文）**: `WITH ranked AS (SELECT 顧客ID, 受注日, 金額, ROW_NUMBER() OVER (PARTITION BY 顧客ID ORDER BY 受注日 DESC) AS rn FROM APP300) SELECT 顧客ID, 受注日, 金額 FROM ranked WHERE rn = 1` で**各グループ最新 1 件が全列付きで取れる**（§0.1）。
- [ ] **CTE がインライン化されない**こと（§0.3）。上記 1 文が `WHERE rn = 1` を kintone クエリへ押し込まず、実体化後に評価される（EXPLAIN／モック client の `getRecords` クエリで確認）。
- [ ] 一時テーブル経由（複文）でも同じ結果になる。
- [ ] **ウィンドウキーを SELECT しなくても正しく採番される**（§2.4）: `SELECT 顧客ID, ROW_NUMBER() OVER (PARTITION BY 顧客ID ORDER BY 受注日 DESC) AS rn FROM APP300`（`受注日` を出力しない）で、`受注日` が**取得フィールドに含まれる**こと（モック client の `fields` を assert）と、全行同順位に**ならない**こと。
- [ ] **数値の `ORDER BY` が数値順**（`ORDER BY 顧客No DESC` で 214 が 1 位。辞書順なら `"99"` になる）＝ §2.3 のゲート修正の回帰テスト。**トップレベル `ORDER BY` が無い SELECT で確認すること**。
- [ ] **選択系の `ORDER BY` が選択肢の定義順**（トップレベル `ORDER BY` と同じ並び）。
- [ ] `PARTITION BY` 省略（全行 1 パーティション）・`ORDER BY` 省略（`RANK` は全行 1）・`OVER ()` が動く。
- [ ] `PARTITION BY` の空文字が 1 グループとして扱われる。
- [ ] ウィンドウ列がある SELECT は **FULL_SCAN**（EXPLAIN で確認）。
- [ ] B14: 実体化後の `#ranked.rn` が**数値型**（`MAX(rn)` が数値順）。
- [ ] **`SELECT DISTINCT` がウィンドウ列の値を区別する**（§2.6）: `SELECT DISTINCT 業種, RANK() OVER (ORDER BY 顧客No) AS r FROM …` が全行同一キーで 1 行へ潰れない。
- [ ] **`AS alias` 必須**（§4.4）: alias 無しのウィンドウ列は `ParseError`。
- [ ] **複数のウィンドウ列**が独立に評価される（§4.5）: 異なる `OVER` を持つ 2 列が互いに影響しない。
- [ ] **CTE/temp 由来の列**の並びが**トップレベル `ORDER BY` と一致**する（§4.6・v1 の制限を固定）。
- [ ] `ROW_NUMBER(x)`（引数あり）・`ROW_NUMBER()`（`OVER` なし）は `ParseError`。
- [ ] `GROUP BY` / 集計との併用は `ParseError`（§4.8）。
- [ ] `ROW_NUMBER` 等は予約語（`` `ROW_NUMBER` `` で同名フィールド参照可）。**`OVER` / `PARTITION` は通常のフィールド名として使える**。
- [ ] 既存の `ORDER BY` / 集計 / `GROUP_CONCAT` に回帰なし。

## 7. リスク・SemVer

- **SemVer: minor**。ただし**完全な後方互換ではない**: `ROW_NUMBER` / `RANK` / `DENSE_RANK` を予約語にするため、同名フィールドを裸で参照している既存クエリは壊れ得る。`KLIKE`（v2.8.0）・`GROUP_CONCAT`（v2.15.0）と同じ前例に従い minor とし、バッククォート回避を用意して CHANGELOG に明記する。
- **リスク（ソートメタのゲート）**: §2.3 を落とすと**静かに誤った順序**（数値が辞書順）で採番される。NaN のように目立たないため、受入条件で「トップレベル `ORDER BY` 無し」の数値順を必ず固定する。
- **リスク（比較器の二重実装）**: §5.1 のとおり `applyOrderBy` の比較器を共有する。独自実装すると並びと順位がズレる。
- **リスク（性能）**: パーティションごとのソートで O(N log N)。FULL_SCAN 前提（既に全件 JS 保持）なので新たな API コストは無い。
- **リスク（利用者の期待）**: 同一スコープの `WHERE rn = 1` が書けない（SQL 標準どおり）。他 RDB 経験者は派生テーブルで回避しようとするが kSQL には無いため、**言語リファレンスで CTE 形を明示**する。
- **リスク（インライン化）**: §0.3。FULL_SCAN 強制を落とすと看板 1 文形が壊れる（`WHERE rn = 1` が kintone へ押し込まれる）。受入条件で固定する。

## 8. スコープ外・後続

- **集計の `OVER`**（`SUM(x) OVER (PARTITION BY …)`）とフレーム句（`ROWS BETWEEN …`）: 累計・移動平均。v2。
- **`LAG` / `LEAD`**（前月比）・`NTILE` / `FIRST_VALUE` / `LAST_VALUE`。
- **派生テーブル `FROM (SELECT …)`**: **本機能の 1 文化には不要**（CTE で既に 1 文・§0.1）。他 RDB からの移植時に**同等処理を別構文でも書ける**ようにする利便性が価値であり、**独立した別課題**として起票候補。
- **`QUALIFY`**（ウィンドウ結果での絞り込み専用句）: Snowflake 等にはあるが MySQL/Oracle/SQL Server には無いため優先度低。
- **`GROUP BY` との併用**（§4.8）。
