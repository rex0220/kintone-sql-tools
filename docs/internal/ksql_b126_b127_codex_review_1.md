# B126 / B127 warnings Phase 1 仕様 R1 レビュー

## 結論

**要修正（11 件: 高 4 / 中 6 / 低 1）。現状のままでは実装着手不可。**

B126 の中心方針（意味や押し下げを変えず、既存 `warnings` に診断だけを加える）と、B127 の `frame.source` を使う方針は妥当です。一方、検出対象・JOIN・全順序抑止・警告の運搬に、実装すると誤案内または警告欠落になる穴があります。

特に次の 4 点は R2 で仕様を確定してから実装すべきです。

1. `CHECK_BOX` / `MULTI_SELECT` の `=` / `!=` は警告候補ではなく、実行前に `UNSUPPORTED` になる。
2. `nativeWhereOperatorsForType(type).has("in")` だけでは対象が `RADIO_BUTTON` / `DROP_DOWN` に限定されず、他の複数値型やサブテーブル構造まで拾う。
3. JOIN で `IN` が押し下がる条件は単一表と異なるため、現在の文面を一律に出せない。
4. `$id` / `RECORD_NUMBER` は物理アプリ内では一意でも、JOIN・サブテーブル等で増幅された結果行の全順序を保証しない。

## 指摘

### 1. [高] B126 の機械的規則が意図した単一値選択系より広い

- 該当: R1 §2.1、§2.3、§5.1、§7-1
- 根拠: `src/core/optimization/whereCapability.ts:74-99,105-127,211-228,453-462`

`CHECK_BOX` / `MULTI_SELECT` は `LOCAL_VALID_OPERATORS` が `in` / `not in` だけなので、`=` / `!=` は `native.has(...)` より前に `UNSUPPORTED` になります。

```ts
const LOCAL_VALID_OPERATORS = new Map<string, ReadonlySet<NativeOperator>>([
  ["CHECK_BOX", new Set(["in", "not in"])],
  ["MULTI_SELECT", new Set(["in", "not in"])],
]);

if (!isLocallyValidOperator(semantics.fieldType, nativeOp)) {
  return unsupported("WHERE_OPERATOR_INVALID_FOR_FIELD_TYPE", ...);
}
```

一方、`USER_SELECT` / `ORGANIZATION_SELECT` / `GROUP_SELECT` は `LOCAL_COLLECTION_TYPES` に含まれるものの上の partial policy にはなく、native 集合には `in` / `not in` があります。そのため `=` / `!=` は `WHERE_RESIDUAL` へ到達し、R1 §2.1 の規則に一致します。

```ts
["USER_SELECT", new Set(["in", "not in"])],
["ORGANIZATION_SELECT", new Set(["in", "not in"])],
["GROUP_SELECT", new Set(["in", "not in"])],
```

これらも複数値であり、言語リファレンスは集合 overlap と明記しています。

```md
ユーザー・組織・グループ選択・作業者も複数値なので、`code` の集合 overlap
```

さらに `structureAllows` は `requiresCollectionOperators` のとき `=` / `!=` を residual に落とします。フォーム情報から `inSubtable: true` は `requiresCollectionOperators: true` になるため、native 集合に `in` を持つサブテーブル列も型名だけの規則で候補になり得ます（`src/core/fieldSemantics.ts:51-56`）。

**提案:** R2 では §2.3 の未確定を解消し、Phase 1 の積極的な書き換え案内を少なくとも「トップレベルの単一値型で、`=` / `!=` 自体が local-valid、代替演算子が当該実行経路で適用可能」に限定する。意図が `RADIO_BUTTON` / `DROP_DOWN` だけなら、その意味カテゴリを共有 policy として明示的に定義する。「型名をハードコードしない」ことより、意味の安全性を優先する。

### 2. [高] JOIN では同じ capability 判定だけで `IN` の押し下げを保証できない

- 該当: R1 §2.1、§2.2、§7-2
- 根拠: `src/core/optimization/joinPredicatePushdown.ts:183-233,1013-1077`、`docs/ksql_language_reference.md:925-936`

JOIN の leaf はまず `classifyWhereCapability` を通しますが、その後に JOIN 固有の `classifySupportedLeaf` を通ります。

```ts
const capability = classifyWhereCapability(predicate, ...);
if (capability.capability !== "EXACT_PUSHDOWN") return unsafe();

const relation = classifySupportedLeaf(predicate, owner, fieldType);
```

選択系 `IN` / `NOT IN` が JOIN prefilter になるには、対象型が JOIN の `SELECTION_TYPES` に含まれ、右辺が非空 `IN_LIST`、さらに全リテラルが空でない実在選択肢である必要があります。

```ts
if (SELECTION_TYPES.has(fieldType)) {
  if ((predicate.op !== "IN" && predicate.op !== "NOT_IN")
    || predicate.right.type !== "IN_LIST"
    || predicate.right.values.length === 0) return "unsafe";
  const options = owner.source.fieldOptions?.get(owner.fieldCode);
  if (options === undefined) return "unsafe";
  return predicate.right.values.every((value) =>
    value.type === "STRING" && value.value !== "" && options.has(value.value)
  ) ? "exact" : "unsafe";
}
```

加えて言語契約上、この表は「alias 付き物理 APP だけを入力にする INNER JOIN」の規則であり、単一表や外部結合にはそのまま適用できません。

**提案:** Phase 1 は B126 を単一物理 APP の SELECT に限定するのが安全。JOIN も対象にするなら、元の residual reason ではなく、実際に構築済みの `RuntimeJoinPushdownPlan` に対して「同じ leaf を `IN` / `NOT IN` に置換した場合にその alias の item が採用される」ことを確認できる場合だけ案内する。`LEFT` / `RIGHT JOIN`、CTE・一時表・派生入力、owner 不明、選択肢 metadata 不足は案内しない。

### 3. [高] 「全件取得になります」は述語単体の residual からは導けない

- 該当: R1 §2.2、§5.1
- 根拠: `src/core/optimization/whereCapability.ts:478-497`、`docs/ksql_language_reference.md:918-932`

`WHERE_RESIDUAL` leaf があっても、`AND` の別 leaf が exact なら全体 capability は `SUPERSET_PREFILTER` です。

```ts
if (op === "AND" && (left.capability === "EXACT_PUSHDOWN" || right.capability === "EXACT_PUSHDOWN"
  || left.capability === "SUPERSET_PREFILTER" || right.capability === "SUPERSET_PREFILTER")) {
  return { capability: "SUPERSET_PREFILTER", reasons: [...] };
}
```

したがって、例えば選択系 `=` と押し下げ可能な `$id` 条件を `AND` したクエリは、対象の `=` 自体は residual でも全件取得とは限りません。言語リファレンスも FULL_SCAN で安全な条件だけを prefilter に使う形を明記しています。

**提案:** 文面を述語単位の事実に変える。例: 「この条件は kintone 側へ押し下げられず、取得候補が増える場合があります」。本当に fetch scope が `ALL` の場合だけ「全件取得」を出したいなら、最終 fetch plan (`ExplainFetchScope` / runtime plan) を条件にする。受入に residual + exact の混在を追加する。

### 4. [高] `$id` / `RECORD_NUMBER` を含むだけでは JOIN・サブテーブル結果の全順序にならない

- 該当: R1 §3.2、§5.2
- 根拠: `src/types/ast.ts:426-445`、`src/engine/process.ts:1038-1064`、`src/core/optimization/joinPredicatePushdown.ts:1036-1040`

ウィンドウ関数は JOIN 等を経た `ProcessRow[]` を partition ごとにソートして評価します。

```ts
export function applyWindow(rows: ProcessRow[], columns: SelectColumn[], ...): ProcessRow[] {
  ...
  for (const partition of partitions.values()) {
    const sortedResult = sortDecoratedRows(partition, window.orderBy, ...);
    ...
  }
}
```

物理 APP 内で一意な `a.$id` でも、`a` の 1 行が JOIN 相手の複数行に一致すれば結果中で同じ `a.$id` が複数回現れます。サブテーブル展開でも親のレコード番号は子行ごとに反復します。JOIN planner 自身も `RECORD_NUMBER` を `$id` と同じ canonical domain と証明できないとして fail-closed にしています。

```ts
if (fieldType === "RECORD_NUMBER") {
  // `$id` と同じ canonical domain を証明する repo contract はまだ無い。
  return "unsafe";
}
```

**提案:** Phase 1 の抑止は、少なくとも「FROM が単一の親物理 APP、JOIN なし、サブテーブルなし、行増幅する中間結果なし」に限定する。CTE / UNION / 一時表で一意性 provenance を保持しない限り警告を抑止しない。JOIN で抑止したい場合は、結果行の一意性を証明する別 planner が必要であり、「どれか 1 つの ID キーを含む」だけでは不可。

### 5. [中] `native` 集合に代替演算子があるだけでは、案内した SQL の実行成功を保証しない

- 該当: R1 §2.1、§2.2
- 根拠: `src/core/optimization/wherePredicatePushdown.ts:114-134`、`docs/ksql_language_reference.md:1113-1117`

FULL_SCAN の安全 prefilter は、選択系を 5 型に限定し、型 metadata に加えて選択肢の実在確認を要求します。非実在値や空文字は押し下げません。単一表 SIMPLE 経路で native query に直列化した場合も、非実在選択肢は kintone 側エラーになり得ます。

```ts
const validOptions = options.fieldOptions?.get(expr.left.field);
if (validOptions === undefined) return false;
return expr.right.values.every((value) =>
  value.type === "STRING" && value.value !== "" && validOptions.has(value.value)
);
```

**提案:** 文面を「書くと絞り込めます」と断定するなら、案内する literal がその型・経路で押し下げ可能であることまで確認する。そこまでしないなら「同じ意味になる場合は `IN` を検討してください」のように条件付きにする。

### 6. [中] B127 の `RECORD_NUMBER` 判定は AST だけではできず、alias 名の文字列比較も危険

- 該当: R1 §3.2、§6
- 根拠: `src/types/ast.ts:744-754`、`src/execute.ts:5646-5764,5772-5789`

`OrderByItem` が持つのは `FIELD_NAME.name: string` であり、物理型や「field / SELECT alias」の区別は AST にありません。

```ts
export type OrderByKey =
  | { type: "FIELD_NAME"; name: string }
  | { type: "ARITH_KEY"; expr: ArithNode }
  | { type: "FUNC_KEY"; expr: StringFuncExpr };
```

実行時には `buildOrderSemanticsForSelect` がフォーム定義、table owner、SELECT alias を解決して `ResolvedFieldSemantics` を作っています。`RECORD_NUMBER` 判定にはこの metadata が必要です。`$id` も名前だけで判定すると、同名 SELECT alias を誤って一意キーとみなすおそれがあります。逆に物理 `$id` を別名で ORDER BY した場合は provenance を見なければ認識できません。

**提案:** `OrderByItem.key.name` の文字列比較ではなく、既存 `orderMeta.semantics.get(name)` の `fieldType` と `source` を使う。R1 §6 の「AST だけで済む」は削除する。EXPLAIN は `buildExplainWhereAnalysis` 内で `buildOrderByMetaForSelect` を既に呼ぶため、その結果から warning を生成・保持する。CTE / temp で metadata が確定しない場合は安全側に警告を出す。

### 7. [中] 警告の運搬経路は converter ではなく、実行 / EXPLAIN の既存解析結果に置くべき

- 該当: R1 §4.1、§6
- 根拠: `src/execute.ts:2630-2769,3195-3312,4517-4744,9419-9527,10341-10391`

実行経路では `executeSelect` が既に `whereCapability` と `orderMeta` を解決してから SIMPLE / FULL_SCAN に分岐します。

```ts
const whereCapability = rememberSelectWhereCapability(stmt,
  await resolveSelectWhereCapability(stmt, client, cacheContext, cteCache));
...
const orderMeta = await buildOrderByMetaForSelect(stmt, client, cacheContext, cteCache);
...
result = await executeSimpleSelect(...); // または executeFullScanSelect(...)
```

したがって `selectToKintone.ts` から分類結果を運ぶ必要はありません。そこで新しい戻り値や引数を作ると、FULL_SCAN / JOIN / CTE と SIMPLE の診断が分岐しやすくなります。EXPLAIN も `ExplainWhereAnalysis.capabilities` を既に保持していますが、`executeExplain` の返却値には現在 `warnings` がありません。

```ts
const result: SelectResult = {
  type: "SELECT",
  columns: ["plan"],
  rows: lines.map((line) => ({ plan: line })),
  rowCount: lines.length,
};
```

**提案:** 純粋関数 `collectSelectWarnings(stmt, capability, orderSemantics, finalPlanContext)` のような共有 collector を計画層に置く。実行は `executeSelect` の結果へ merge、EXPLAIN は `buildExplainWhereAnalysis` が select ごとに収集して `executeExplain` の `SelectResult.warnings` へ載せる。`selectToKintone.ts` は変更対象から外す。

### 8. [中] UNION / 実体化 CTE では子 SELECT の warnings が現在の合成結果から失われる

- 該当: R1 §1、§4、§6
- 根拠: `src/execute.ts:4751-4813,4833-4871,4878-4908`

`executeUnion` は左右の `SelectResult` から行と列だけを合成し、新しい結果に warnings を移していません。

```ts
const result: SelectResult = { type: "SELECT", rows, columns: leftCols, rowCount: rows.length };
```

実体化 CTE も中間結果から `rows` / `columns` / `columnMeta` だけをキャッシュし、最終 SELECT の結果だけを返します。

```ts
cteCache.set(cte.name, {
  rows: result.rows,
  columns: result.columns,
  columnMeta: materializedMetaBySelectResult.get(result),
});
```

このまま各 `executeSelect` に警告追加だけを実装すると、トップレベル単純 SELECT では出ても UNION branch / CTE 本体では消えます。

**提案:** R2 で警告スコープを決める。全 SELECT node を対象にするなら UNION は左右 warnings を `Set` merge し、CTE / temp の中間 warnings も最終結果または batch statement result へ運ぶ必要がある。トップレベル SELECT だけを対象にするなら、その制限を明記し受入にも固定する。

### 9. [中] `Set<string>` だけでは「同一フィールド・同一演算子」の重複排除を満たさない

- 該当: R1 §2.2、§4、§5.1
- 根拠: R1 §2.2 の文面と `src/execute.ts:3221,3312`

既存の `Set<string>` は完全一致する文面しか重複排除しません。文面に literal を埋め込むため、同じフィールド・同じ演算子でも値が異なれば別文字列になります。

```sql
WHERE 区分 = 'A' OR 区分 = 'B'
```

この 2 leaf は `区分 = 'A' ...` と `区分 = 'B' ...` になり、`Set<string>` では 2 件です。また JOIN で alias を文面に含めない場合、別 APP の同名フィールドを誤って 1 件へ潰す可能性があります。

**提案:** `alias/app + field + operator + warningCode` の構造化キーで dedupe し、最後に文字列化する。または要件を「同一文面のみ重複排除」に変更する。受入に「同じ field/op で異なる literal」と「別 alias の同名 field」を追加する。

### 10. [中] 受入条件が誤案内・警告欠落・非変更性を十分に固定していない

- 該当: R1 §5
- 根拠: 上記 1〜9 のコード経路

現行表では単純な正例・負例は検出できますが、次が未固定です。

- B126: residual + exact `AND`（fetch は ALL とは限らない）
- B126: `USER_SELECT` / `ORGANIZATION_SELECT` / `GROUP_SELECT` の `=` / `!=`
- B126: サブテーブル列、非実在選択肢、空文字
- B126: INNER JOIN の成功条件、LEFT / RIGHT JOIN、CTE / temp input
- B126: 同 field/op・異なる literal、別 alias・同名 field
- B127: JOIN で同じ `$id` が複数結果行に現れるケース、サブテーブル、CTE / UNION
- B127: `$id` という SELECT alias、物理 `$id` の別名、metadata 未解決
- 共通: UNION branch / CTE 本体の warning 伝播、既存 warning との同時発生

「警告の有無で結果が変わらない」は、期待値を文章で置くだけでは実装の副作用を検出しにくいです。

**提案:** 同じ fixture/client に対して、警告 collector を無効化した基準実行と有効化した実行の `rows` / `columns` / `rowCount`、records API の app/query/fields 呼出列、fetch 件数を deep-equal する回帰テストを置く。EXPLAIN は `warnings` を除いた `rows` と fetch-plan carrier を deep-equal する。少なくとも警告生成を plan/AST の読み取りだけで行い、stmt・capability・plan を変更しないことを単体テストする。

### 11. [低] 警告の主体と「1 行」の表現を明確にする必要がある

- 該当: R1 §2.2、§3.3、§4
- 根拠: `src/mcp/tools.ts:295-304`、`src/cli/index.ts:822-837`

公開面では `warnings` は文字列配列です。「1 行」が「配列要素 1 個」なのか、「文字列内にも改行を含めない」のかが曖昧です。また B126 は JOIN を対象にするなら `field` だけでは owner を識別できません。

**提案:** 「1 warning = 配列要素 1 個、文字列内改行なし」と定義する。JOIN 対象時は表示名を `alias.field` にする。B127 alias が空でないことは AST 契約上保証されているので、その点は現仕様のままでよい。

## 依頼の 6 点への回答

### 1. `CHECK_BOX` / `MULTI_SELECT` の `= 'A'` はどう分類されるか

**`WHERE_RESIDUAL` には到達しない。`WHERE_OPERATOR_INVALID_FOR_FIELD_TYPE` の `UNSUPPORTED` になる。**

処理順は次のとおりです。

1. `normalizeOperator("=")` は `=` のまま。
2. `isLocallyValidOperator("CHECK_BOX", "=")` / `MULTI_SELECT` は、policy が `in` / `not in` だけなので false。
3. `hasLocalContract` と `native.has(nativeOp)` へ進む前に `unsupported(...)` を返す。
4. `executeSelect` は `UNSUPPORTED` を records API 前に `ArgumentError` にする（`src/execute.ts:2660-2663`）。EXPLAIN も原則同じ schema-aware 判定で拒否する（`src/execute.ts:9511-9515`）。

したがって §2.3 の W1/W2 は `CHECK_BOX` / `MULTI_SELECT` については不要です。ただし同じ意味論問題が、現規則で実際に residual になる `USER_SELECT` / `ORGANIZATION_SELECT` / `GROUP_SELECT` に移ります。

### 2. 「native 演算子集合が `in` を含むか」は成立するか

**単独条件としては成立しない。** `=` / `!=` の residual reason と組み合わせたときに実際に一致する主な型は次のとおりです。

| 型 / 構造 | `=` / `!=` の分類 | native に代替あり | R1 規則 |
|---|---|---:|---:|
| `RADIO_BUTTON`, `DROP_DOWN` | `WHERE_RESIDUAL` | あり | 対象（意図どおり） |
| `CHECK_BOX`, `MULTI_SELECT` | `UNSUPPORTED` | あり | 対象外 |
| `USER_SELECT`, `ORGANIZATION_SELECT`, `GROUP_SELECT` | `WHERE_RESIDUAL` | あり | 対象（意図外・複数値） |
| `CREATOR`, `MODIFIER` | `UNSUPPORTED` | あり | 対象外 |
| `STATUS` | `WHERE_EXACT` | あり | 対象外 |
| `RECORD_NUMBER`, `__ID__`, `SINGLE_LINE_TEXT`, `LINK`, `NUMBER`, `CALC` | 通常は `WHERE_EXACT` | あり | 通常は対象外 |
| `requiresCollectionOperators: true` の上記 scalar 型 | `WHERE_RESIDUAL` になり得る | 型次第であり | 意図外に対象になり得る |
| `MULTI_LINE_TEXT`, `RICH_TEXT`, `FILE`, `STATUS_ASSIGNEE` 等 | residual / unsupported | なし | 対象外 |

`CALC` は native に `in` が混ざりますが、通常の `=` / `!=` 自体も native なので residual 条件と同時成立せず、直接の誤検出にはなりません。問題は複数値型と構造条件です。

### 3. JOIN で「`IN` と書けば絞れます」は真か

**一律には偽。** 真になるのは、alias 付き物理 APP の INNER JOIN で owner が一意に解決し、JOIN 対象型が `DROP_DOWN` / `RADIO_BUTTON` / `CHECK_BOX` / `MULTI_SELECT` / `STATUS`、右辺が非空の文字列 list、全値が実在選択肢、という JOIN 固有 gate を通る場合です。

`LEFT` / `RIGHT JOIN`、CTE / temp / subtable input、owner 不明、metadata 不足、非実在値、`USER_SELECT` 等では同じ案内を保証できません。Phase 1 を単一表に限定するのが最小かつ安全です。

### 4. `warnings` を計画側から実行結果へ運ぶ経路

**新しい converter 引数は不要。既存の `executeSelect` と `buildExplainWhereAnalysis` が必要情報の合流点です。**

- 実行: `executeSelect` が `whereCapability` と `orderMeta` を得た後、共有 collector で warning 候補を作る。SIMPLE / FULL_SCAN の結果が戻った後、`new Set(result.warnings ?? [])` に merge する。
- EXPLAIN: `buildExplainWhereAnalysis` の SELECT visit で capability と order metadata を使って同じ collector を呼び、analysis に warnings を保持する。`executeExplain` が `SelectResult.warnings` に設定する。
- batch EXPLAIN: `buildBatchExplainPlans` は現戻り値に warning field がないため、外側 MCP/CLI の期待 shape と合わせて statement 単位または集約 warnings の契約を R2 で決める必要がある。
- UNION / CTE: 子 SELECT warnings をトップ結果へ出す契約なら、合成時の明示 merge が必要。

既存 MCP / CLI は `result.warnings ?? []` を既に返すため、単文 `SelectResult` に正しく載れば adapter 変更は原則不要です（`src/mcp/tools.ts:295-304`, `src/cli/index.ts:822-837`）。

### 5. B127 の全順序判定

**`RECORD_NUMBER` 型判定にはフォーム定義が要る。`OrderByItem` AST だけでは型も owner も alias provenance も分からない。**

実行では `buildOrderByMetaForSelect` が既に `ResolvedFieldSemantics` を返すため直接物理 APP の判定が可能です。EXPLAIN でも同関数は呼ばれていますが、現在は warning 用に結果を保持していないため analysis へ追加する必要があります。

`$id` は `systemColumnMeta` で `fieldType: "__ID__"` と解決できます。ただし文字列名だけで抑止せず、物理 source semantics を確認すべきです。また `$id` / `RECORD_NUMBER` の一意性は入力レコードの性質であって、JOIN・サブテーブルで増幅された結果行の一意性ではありません。Phase 1 で安全に抑止できるのは、単一の親物理 APP を直接読む行増幅なしの SELECT に限定するのが妥当です。

### 6. 受入条件で検出できない穴

現行 §5 で基本的な単一表 leaf とウィンドウ構文条件は検出できますが、指摘 10 の列挙ケースは検出できません。特に「警告だけの変更」は次の 3 層で機械的に固定すべきです。

1. warning collector の純粋性: 入力 AST / capability / plan を変更しない。
2. 実行不変性: before / after の `rows`, `columns`, `rowCount` と records API 呼出列を deep-equal。
3. EXPLAIN 不変性: `warnings` を除く plan rows と fetch plan を deep-equal。

既存の取得上限・検索中断 warning と新 warning が同時に出た場合の集合、順序、重複排除も受入へ追加すべきです。

## 仕様が正しかった点（R2 で消さない）

1. **警告だけを加え、意味・結果・押し下げ挙動を変えない方針**は妥当。B126 の自動 `=` → `IN` 正規化を Phase 2 に分けた判断も正しい。
2. **B127 で既定 `RANGE` 自体を変更しない方針**は標準準拠を維持している。
3. **`frame.source: "DEFAULT" | "EXPLICIT"` を使う検出**はコードと一致する（`src/types/ast.ts:291-294`）。明示 `ROWS` / 明示 `RANGE` を警告対象外にする区別が可能。
4. **集計ウィンドウだけを対象にし、順位系を除外する条件**は AST の `windowKind: "AGGREGATE"` と一致する（`src/types/ast.ts:306-318`）。
5. **`ORDER BY` なしを除外する条件**は、全 partition フレームと既定 RANGE の論点を混同しないため妥当。
6. **既存 `warnings` 面を再利用し、MCP / CLI に新しい応答フィールドを作らない方針**は既存 adapter と整合する。
7. **`ksql_validate` を対象外にする方針**は、schema-aware な最終判断を query / explain / runtime に置く既存契約と整合する。
8. **B127 の抑止判定を意図的に狭くする考え方**自体は正しい。ただし狭さは「キー型」だけでなく「結果行で一意性が保存される source shape」まで含める必要がある。
9. **警告が利用者に届く本命を SELECT 実行結果とし、EXPLAIN にも同じ診断を載せる方針**は妥当。
10. **既存警告との共存・重複排除・結果不変を受入に含めたこと**は正しい。R2 では構造化 dedupe key と合成経路を補えばよい。
