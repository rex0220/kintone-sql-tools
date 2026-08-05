# B140 CTE の `GROUP BY` キーを全順序として証明する 仕様 R1 codex レビュー 1

## 結論

**要修正・8 件（高 3 / 中 4 / 低 1）。現状の R1 のままでは実装着手不可。**

`GROUP BY` 結果から候補キーを得る方向自体は正しい。しかし R1 §2.1 の
「キーの対応は出力列名で取る」は、現行の `GROUP BY` 解決順と投影仕様では安全でない。
同じ名前でも、実際のグループキーとは異なる非単射の式や、後続の同名出力列が下流値に
なる形があり、警告を消すと偽陰性になる。

また、警告判定時の CTE キャッシュには定義 AST ではなく、行・列・通常の列メタしか残らない。
複合 `GROUP BY` は「各列が group key 由来」という列単位フラグでは表現できないため、
**出力列位置（または一意な出力列 identity）の組として候補キーを持つ関係メタ**と、その
伝播・失効規則を R2 で確定する必要がある。

## 指摘

### 1. 高 — §2.1: 出力列名の一致は、グループキーとの同一性を証明しない

該当: `docs/internal/ksql_b140_cte_groupby_total_order_spec.md:81-93`、
`src/core/optimization/plainGroupByPlan.ts:177-215`、`src/engine/process.ts:1386-1424`

R1 は「キーの対応は出力列名で取る」とするが、現行は同名の物理列があれば SELECT alias
より先に物理列として `GROUP BY` を解決する。

```ts
// src/core/optimization/plainGroupByPlan.ts:186-201
const physical = candidateSources.filter((source) => source.columns.includes(parsed.fieldCode));
...
if (physical.length === 1) {
  ...
  return { kind: "PHYSICAL", ... };
}
```

alias fallback はその後である。

```ts
// src/core/optimization/plainGroupByPlan.ts:207-215
const aliases = columns.flatMap((column, columnIndex) =>
  explicitAlias(column) === name ? [{ column, columnIndex }] : []
);
...
return { kind: "ALIAS_SAFE", columnIndex: candidate.columnIndex };
```

したがって、例えば source に物理列 `k` がある
`SELECT UPPER(k) AS k, SUM(v) AS total ... GROUP BY k` では、グループは物理 `k` で作られる一方、
CTE の出力 `k` は `UPPER(k)` である。`UPPER` は非単射なので、物理 `k` が異なる複数行が
同じ出力 `k` になり得る。下流の `ORDER BY k` を全順序とみなすと偽陰性になる。

さらに、通常 SELECT は重複出力名を一般には拒否しておらず、投影は同じ object key へ順に書く。

```ts
// src/engine/process.ts:1386-1411
for (const [colIdx, col] of columns.entries()) {
  ...
  case "FIELD": {
    const key = outputKeys?.[colIdx] ?? col.alias ?? ...;
    out[key] = value as string;
```

```ts
// src/engine/process.ts:1420-1424
case "AGGREGATE": {
  ...
  out[dstKey] = value as string;
```

`SELECT k, SUM(v) AS k ... GROUP BY k` では、下流の `k` は集計値で上書きされ、一意とは限らない。

提案: 名前一致を証明に使わない。plain GROUP BY の解決 plan と SELECT の列位置を結び、
「その出力列値が実際に評価した group key 値と同一」であることを証明する。重複出力名、
物理名と alias の衝突、非単射変換、wildcard 混在は証明不能として警告を残す。

### 2. 高 — §3.1 / §5-3: 必要な provenance の保持形式が未確定で、列単位フラグ案では複合キーを表せない

該当: `docs/internal/ksql_b140_cte_groupby_total_order_spec.md:114-126,171-176`、
`src/execute.ts:397-419,4994-5040,5047-5108,5165-5176`

現行の実体化メタは表示・型・semantics だけで、一意性や候補キーを持たない。

```ts
// src/execute.ts:397-404
export interface MaterializedColumnMeta {
  readonly displayName?: string;
  readonly sortKind?: "number" | "string";
  readonly fieldType?: string;
  readonly semantics?: ResolvedFieldSemantics;
  readonly publicSourceApp?: number;
}
```

CTE 実体化時にキャッシュへ保存するのも行・列・この列メタだけである。

```ts
// src/execute.ts:5026-5033
result = await executeQueryWithCte(cte.query, client, options, cteCache, cacheContext, true);
...
cteCache.set(cte.name, {
  rows: result.rows,
  columns: result.columns,
  columnMeta: materializedMetaBySelectResult.get(result),
});
```

最終 CTE SELECT の警告判定は `executeFullScanWithCte` 内で `cteCache` を持つので、ここから
relation metadata を読むことはできる。しかし `WithStatement.ctes` は渡っていない。

```ts
// src/execute.ts:5165-5176
const { resolver: choiceAndWindowResolver } = await normalizeSelectChoiceEquality(
  stmt, client, cacheContext, cteCache, hasWindowNeedingOrderProof(stmt)
);
const defaultRangeWarnings = collectDefaultRangeWindowWarnings(
  stmt, choiceAndWindowResolver, "DERIVED"
);
```

`GROUP BY a,b` の証明は `{a,b}` という組で初めて成立する。各列へ独立に
`groupKey=true` を付けると、別の候補キー由来の列を混ぜる、変換後もフラグだけ残す、
UNION/JOIN/重複名を越えて誤伝播する、といった偽陰性を防げない。

提案: `MaterializedTable` または結果に relation-level の
`candidateKeys: readonly (readonly ColumnIdentity[])[]` 相当を持たせる。最低限、生成時、単純投影・
rename、filter、DISTINCT、UNION/UNION ALL、JOIN、集約、重複出力名、CTE 連鎖、一時テーブル化で
何を保持・変換・破棄するかを R2 で定義する。本 Phase を直接 CTE 定義だけに限定するなら、
CTE 名から定義 AST と解決済み plain GROUP BY plan へ到達する引数経路を明記する。

### 3. 高 — §4.2: 偽陰性を止める受入条件が不足している

該当: `docs/internal/ksql_b140_cte_groupby_total_order_spec.md:147-156`、
`src/core/optimization/plainGroupByPlan.ts:177-215`、`src/engine/process.ts:1485-1547`

§4.2 は「キー不足」「GROUP BY なし」「grouping sets」「UNION」「JOIN」「temp」を挙げるが、
指摘 1 の実在する名前衝突・値変換を含まない。また出力名は AST だけの単純な alias ではなく、
列種別ごとに `computeOutputKey` で決まる。

```ts
// src/engine/process.ts:1519-1543
case "FIELD": return col.alias ?? defaultFieldKeys.get(colIdx) ?? col.field;
case "AGGREGATE": return col.alias ?? aggregateSyntheticName(...);
case "ARITH_COL": return col.alias ?? arithColDefaultKey(col.expr);
...
case "WINDOW_COL": return col.alias;
```

提案: 少なくとも次を「警告が残る」受入へ追加する。

- `SELECT UPPER(k) AS k, SUM(v) ... GROUP BY k` → 下流 `ORDER BY k`
- `SELECT k, SUM(v) AS k ... GROUP BY k` → 下流 `ORDER BY k`
- 複合キーの一部だけを rename / 非単射変換 / 非投影にした形
- 同名出力列、wildcard と明示列の衝突、修飾名と非修飾名の取り違え
- group CTE を単純投影、UNION ALL、JOIN で包む多段 CTE（伝播を仕様化するまでは残す）
- `ORDER BY` に式キーがある形、およびキー全部＋追加キーの形

「全キーを含む」の観測可能な受入は、B127 と B128 の公開 warning 配列で同じ SQL matrix を
検証すればよい。内部 helper やメタの形を受入条件にしない方針は正しい。

### 4. 中 — §3.2: `DERIVED` は CTE 読み取りを意味せず、一般解禁は危険

該当: `docs/internal/ksql_b140_cte_groupby_total_order_spec.md:121-126`、
`src/execute.ts:4925-4944,5007-5011,5095-5100,5172-5176`

`DERIVED` は少なくとも次の異なる経路で渡る。

```ts
// src/execute.ts:4925-4944 — UNION の左右
executeSelect(..., "DERIVED")
```

```ts
// src/execute.ts:5007-5011 — inline 化された WITH
return executeSelect(buildInlinedQuery(stmt), ..., "DERIVED");
```

```ts
// src/execute.ts:5095-5100 — WITH 配下だがトップレベル CTE 参照なし
return executeSelect(query, ..., "DERIVED");
```

CTE を実際に読む SELECT は別経路 `executeFullScanWithCte` で、そこでも固定値 `DERIVED` が渡る。
したがって `context !== "DIRECT"` を単純に外す、または `DERIVED` 一般を許すのは安全でない。

提案: 既存 context は既存の direct APP 証明の保守条件として残し、CTE 候補キー証明は
「参照 source が単一 materialized sourceで、その relation metadata に候補キーがある」ことを
独立条件にする。R1 の「`DERIVED` でも」はこの限定条件付きに書き換える。

### 5. 中 — §2.1: 「GROUP BY に式は書けない」は現行 AST と不一致

該当: `docs/internal/ksql_b140_cte_groupby_total_order_spec.md:92-93`、
`src/types/ast.ts:731-735`、`src/engine/process.ts:526-527`

現行 `GroupByKey` はフィールド名だけでなく算術・関数キーを公開型として持つ。

```ts
// src/types/ast.ts:732-735
export type GroupByKey =
  | { type: "FIELD_NAME"; name: string }
  | { type: "ARITH_KEY"; expr: ArithNode }
  | { type: "FUNC_KEY"; expr: StringFuncExpr };
```

実行器も両者を評価する。

```ts
// src/engine/process.ts:526-527
if (key.type === "FUNC_KEY") return evalStringFunc(key.expr, row);
return String(evalArithExpr(key.expr, row));
```

提案: Phase 1 を `normalizeGroupingSpec(stmt).type === "PLAIN"` かつ全 item が
`FIELD_NAME`、さらに安全な出力 identity へ対応できる場合だけ、と明記する。式キーを対象にするなら
式 AST の構造一致ではなく、実際の投影値 identity と結ぶ規則が必要。

### 6. 中 — §5-1 / §4.2: 一時テーブルのスコープが相互矛盾している

該当: `docs/internal/ksql_b140_cte_groupby_total_order_spec.md:64-73,147-156,171-176`、
`src/execute.ts:1822-1836,1891-1902`

§1 と §4.2 は一時テーブルを非対象・警告ありと確定する一方、§5-1 は「扱えるなら入れる」とする。
これは実装者の判断で公開挙動と受入期待が変わる。

コード上は `CREATE TEMP TABLE` も SELECT 結果の同じ列メタを `MaterializedTable` に保存する。

```ts
// src/execute.ts:1830-1835
const result = await runSelectLike(...);
tempTables.set(resolvedStmt.name, {
  rows: result.rows,
  columns: result.columns,
  columnMeta: materializedMetaBySelectResult.get(result),
});
```

よって relation-level candidate key を採れば経路の共通化余地はある。ただし batch statement を越える
provenance と受入 matrix が増えるため、R2 では本 Phase から明確に外し、別 Phase とするのが安全。

### 7. 中 — §2.1 / §2.3: NUL 連結は衝突するが、B140 の一意性命題への影響を区別すべき

該当: `src/engine/process.ts:267-281,493-527`、`src/core/grouping.ts:63-65`

通常 GROUP BY の実データキーは、各値をそのまま NUL で連結する。

```ts
// src/engine/process.ts:267-281
const groups = new Map<string, ProcessRow[]>();
...
const key = groupByKeys.map(... evalGroupByKey(...)).join("\x00");
```

値自体のエスケープはないため、複合キー `("a\0b","c")` と `("a","b\0c")` は衝突する。
また FIELD_NAME の欠損は空文字へ正規化される。

```ts
// src/engine/process.ts:501-504
if (!resolution) return row[key.name] ?? "";
if (resolution.kind === "PHYSICAL") return row[resolution.runtimeKey] ?? "";
```

ただし、この衝突は異なる semantic group を**併合して行を減らす**ものであり、group key をそのまま
出力している限り、同じ group-key tuple の出力行を二つ作るものではない。そのため B140 の
「出力行間で group-key tuple が一意」という狭い命題を直接は崩さない。一方で集計値を誤らせる
独立の correctness defect なので、R2 では「B140 の証明条件とは分離して別 issue 化」するか、
候補キーの根拠をより強く「semantic group と 1:1」と表現するなら先に修正する、と明記すべき。

`grouping.ts:64` の NUL は grouping item の**構文 identity**用で、実データの group key 連結とは別物。

### 8. 低 — §6: 実行時タイ検査を採らない結論は妥当だが、主理由を契約へ寄せるべき

該当: `docs/internal/ksql_b140_cte_groupby_total_order_spec.md:180-195`、
`src/execute.ts:2779-2783,5172-5176`

現行 warning はどちらの実行経路でも行評価・sort より前に収集される。

```ts
// src/execute.ts:2779-2783
const defaultRangeWarnings = collectDefaultRangeWindowWarnings(...);
```

```ts
// src/execute.ts:5172-5176
const defaultRangeWarnings = collectDefaultRangeWindowWarnings(...);
```

実行時タイ検査は警告位置の後段移動、全入力保証、全 ORDER BY 型の比較 semantics 共有が必要で、
今回の静的証明追加より変更範囲が大きい。日ごとの変動も事実だが、より強い理由は
「警告は今回のデータ状態ではなく、クエリ構造の非決定性を通知する契約」であること。
R1 の不採用判断は維持し、この契約理由を先に書くのがよい。

## 指定された 7 点への回答

### 1. `GROUP BY` キーで一意と言い切れるか

**条件付きで言えるが、R1 の「出力列名一致」だけでは言えない。** `applyGroupBy` は Map の各内部キーに
対し 1 行だけ出すため（`src/engine/process.ts:267-309`）、実際に評価された plain GROUP BY tuple を
値を変えず、重複名で上書きせず出力した列組なら一意である。

空セル・欠損は `?? ""` で同一 group になり、NUL を含む複合値も連結衝突する。ただし両者は行を
併合するので、直接には同じ出力 tuple の複数行を作らない。NUL 衝突は別の集計 correctness defect。

`ROLLUP` / `CUBE` / `GROUPING SETS` は `normalizeGroupingSpec` が plain と明確に区別する。

```ts
// src/core/grouping.ts:75-99
if (stmt.grouping === undefined) {
  return stmt.groupBy.length === 0 ? { type: "NONE" } : { type: "PLAIN", ... };
}
...
return { type: "GROUPING_SETS", source: stmt.grouping.source, ... };
```

よって `type === "PLAIN"` のみ許す除外は十分。CTE 定義の `query.type === "UNION"` も AST で判別できる
（`src/types/ast.ts:181-200`）ため、直接の UNION CTE 除外は可能かつ十分。ただし候補キー metadata を
導入するなら、UNION や多段 CTE を越える伝播規則を別途 fail-closed にする必要がある。

### 2. CTE 定義へ到達できるか

**警告を出す現在地点から `WithStatement.ctes` へ直接は到達できない。** 最終 CTE SELECT は
`executeFullScanWithCte(stmt, ..., cteCache, ...)` で処理され、手元にあるのは consumer の
`SelectStatement` と `Map<string, MaterializedTable>` である（`src/execute.ts:5116-5122`）。

最小変更は二案ある。

1. `executeWith` から CTE 定義 map / 解決済み候補キー map を `executeQueryWithCte`、
   `executeFullScanWithCte`、warning collector へ渡す。
2. 実体化時に relation-level candidate keys を `MaterializedTable` へ保存する。

多段 CTEと将来の temp tableを考えると 2 が素直。ただし「列に group key フラグ」では複合キーを
表せないので不可。直接 CTE だけを狭く実装するなら 1 の方が変更量と誤伝播リスクは小さい。

### 3. `context` の意味

`DIRECT` は `executeSelect` の既定値（`src/execute.ts:2748-2758`）。`DERIVED` は UNION arm、WITH
inline、WITH 配下の通常 SELECT、CTE materialized source の warning 判定に使われる。したがって
source provenance ではなく、複数の保守的派生経路をまとめたフラグである。

CTE 本体の SELECT は `executeQueryWithCte(..., true)` で順に実行され、窓があればその CTE 本体の
実行時に警告される（`src/execute.ts:5018-5028`）。CTE を読む最終 SELECT の窓は
`executeFullScanWithCte` 内で別に警告される（`src/execute.ts:5165-5176`）。

よって「DERIVED を一般に証明可能へ」は安全でない。「単一 materialized source の候補キーを consumer
ORDER BY が含む場合」という独立条件に限れば安全。

### 4. キーの対応づけ

`GROUP BY 年月` が物理 source 列に存在しないときは SELECT alias へ fallback し、pre-group safe な
`DATE_FORMAT(...) AS 年月` 等を `ALIAS_SAFE` として評価する（`plainGroupByPlan.ts:204-215`）。この形では
同じ列位置の出力 `年月` と結べる。

物理 `k` を `SELECT k AS x ... GROUP BY k` とした形も、FIELD column の値をそのまま `x` へ出すなら
対応可能。ただし AST の name 比較ではなく、PHYSICAL resolution の `runtimeKey` と FIELD column の
参照を解決して同一と証明する必要がある。

修飾名は `plainGroupByPlan.ts:159-205` で qualifier を分解し、修飾名から alias fallback しない。
この解決結果を再利用すべきで、文字列から独自にドットを剥がすと取り違える。物理名と alias が同名の
場合は物理が優先されるため、特に名前だけの対応は禁止。

### 5. 一時テーブル

技術的には同じ `MaterializedTable` と列メタ経路へ載る（`src/execute.ts:1822-1836`）。relation-level
candidate keys を採るなら共通化できる可能性が高い。ただし定義は別 batch statement で、失効・伝播の
受入が増える。R1 内の「非対象」と「扱えるなら入れる」は矛盾するため、今回は分けるべき。

### 6. 受入条件の穴

**不足している。** 指摘 3 の adversarial cases が必要。判定結果は内部 predicate ではなく、公開される
`SelectResult.warnings` を B127/B128 の双方で観測すればよい。既存テストも同じ観測方法である。

```ts
// src/__tests__/window.execute.test.ts:318-325
const result = await execute(...);
expect(result.warnings).toContain(warningFor("cumulative"));
```

`ORDER BY` が複合 candidate key の全列 identity を含む場合だけ両警告が消え、一部、別 identity、式、
重複名、伝播未定義の経路では残る、という SQL matrix に落とせる。

### 7. 実行時にタイの有無を見る案

**採らない判断は妥当。** 今回の警告契約はデータスナップショットではなく構造上の非決定性を知らせる
ものだからである。さらに現行は実行前に warning を収集しており、動的判定は配置と比較 semantics の
変更を伴う。将来別仕様で「実タイだけ通知」に契約自体を変える余地を残す記述も妥当。

## 仕様が正しかった点（R2 で消さないこと）

- B127 と B128 が同じ `canProveTotalWindowOrder` を通るため、証明述語を共通化する方向。
- 複合 GROUP BY は全キーを含む必要があり、キー順自体は一意性に影響しないという §2.1 / §3.3。
- 既存 `$id` / `RECORD_NUMBER` 証明を残す純加法の方針。
- grouping sets、直接 UNION、consumer JOIN、subtable を fail-closed で除外する保守性。
- comparator に暗黙タイブレークを加えず、値・順序の実行 semantics を変えないこと。
- B127/B128 の warning 配列と値を公開結果で確認する、観測可能な受入の方向。
- 実行時の偶然のタイ有無ではなく、静的に証明できるクエリ構造を警告抑止の根拠にする方針。

