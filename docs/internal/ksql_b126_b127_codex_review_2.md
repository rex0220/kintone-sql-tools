# B126 / B127 仕様 R3 codex レビュー（2 回目）

## 結論

**要修正（8 件: 高 4 / 中 3 / 低 1）。現状のままでは実装着手不可。**

B126 の中心方針、すなわち「実在する非空の単一値選択肢に限り、`= 'X'` を利用者記述の `IN ('X')` と同じ AST へ正規化し、既存の IN 経路を再利用する」は成立します。対象になり得る実質的な物理型は現状 `RADIO_BUTTON` / `DROP_DOWN` で、正規化後のローカル評価も元の `=` と同値です。

ただし R3 は、その AST を **どの共有境界で作り、実行と EXPLAIN の全 downstream consumer にどう渡すか**を未確定のまま影響範囲を `whereCapability.ts` 内の書き換えとしています。現コードの `classifyWhereCapability()` は capability しか返さず、converter、JOIN planner、COUNT、KORDER、ローカル再評価は別途 `stmt.where` を読みます。このまま分類関数内だけで書き換えると、分類結果と実際の query / 再評価が分離します。

また、R3 §4.3 の「EXPLAIN は `kintone query` と `pushdown normalized` 行以外が一致」は、B126 の効果そのものと矛盾します。正規化に成功すれば mode、fetch、reason、COUNT/KORDER plan も変わり得ます。

実装前に最低限、次を R4 で固定すべきです。

1. schema resolver 構築後に pure な正規化を行い、`normalizedWhere` と rewrite 記録を返す共有 API
2. 実行と EXPLAIN が、その同じ API の結果を capability、converter、JOIN、COUNT、KORDER、ローカル評価へ渡す方法
3. 正規化は WHERE 全体の capability ではなく **各 BINARY leaf** に対して判定すること
4. B127 の「CTE / UNION を経ていない」を親 AST context から保持する方法、および子 warning の merge 経路
5. EXPLAIN と metrics の受入条件の修正

なお、指定どおりコード・仕様本文は変更せず、git 操作、kSQL MCP、`npm test` は実施していません。

## 指摘

### 1. [高] `classifyWhereCapability()` 内だけでは正規化済み AST を downstream と共有できない

- 該当: R3 §2.4、§5、§6-1〜2
- 根拠: `src/core/optimization/whereCapability.ts:130-148,176-228`、`src/execute.ts:2556-2565,2660-2711,2736-2758`、`src/converter/selectToKintone.ts:126-134`

`classifyWhereCapability()` は AST を受けて `PredicateCapabilityResult` だけを返します。

```ts
export function classifyWhereCapability(
  where: WhereExpr | null,
  resolveField: WhereFieldSemanticsResolver
): PredicateCapabilityResult {
  if (where === null) {
    return { capability: "EXACT_PUSHDOWN", reasons: [{ code: "WHERE_EXACT" }] };
  }
  return classifyNode(where, resolveField);
}
```

実行側は capability を得た後も元の `stmt` / `stmt.where` を全 downstream に渡しています。

```ts
const whereCapability = rememberSelectWhereCapability(
  stmt,
  await resolveSelectWhereCapability(stmt, client, cacheContext, cteCache)
);
...
serializedWholeWhere = whereToKintone(stmt.where);
...
const orderPlan = ...({
  stmt,
  whereCapability: whereCapability.capability,
  ...
  hasKlike: whereHasKlike(stmt.where),
});
...
result = await executeSimpleSelect(stmt, ...);
// または
result = await executeFullScanSelect(stmt, ...);
```

SIMPLE converter も分類結果ではなく `stmt.where` を直列化します。

```ts
if (stmt.where !== null) {
  queryParts.push(whereToKintone(stmt.where));
}
```

したがって、分類処理のローカル変数だけを `IN` にしても REST query は元の `=` のままです。逆に `classifyWhereCapability()` が入力 AST を破壊的に変更すると、同じ AST を WeakMap key、EXPLAIN tree、relative-date plan、CTE inline 判定等が共有しているため、呼出順依存になります。さらに JOIN 内部の classifier は型だけから semantics を作り、`optionOrder` を持ちません（`joinPredicatePushdown.ts:222-227`）。分類関数内で正規化を兼ねると呼出経路ごとに結果が変わります。

**提案:** `classifyWhereCapability()` は純粋な分類器のまま維持し、schema resolver 構築後に次のような pure API を追加する方針を R4 に固定する。

```ts
normalizeWhereForPushdown(where, resolver)
  -> { where: normalizedWhere, rewrites: PushdownRewrite[] }
```

実行では `buildWhereFieldSemanticsResolver()` を一度作り、正規化後の `effectiveStmt = { ...stmt, where: normalizedWhere }` を capability、relative-date、COUNT、KORDER、converter、JOIN planner、FULL_SCAN に一貫して渡す。EXPLAIN でも同じ API を使い、original Select node と effective Select / rewrite 記録の対応を analysis に保持して renderer まで渡す。「演算子別の downstream 分岐を足さない」は維持できるが、**正規化済み AST を downstream へ運ぶ plumbing は必要**である、と明記する。

### 2. [高] 条件 1 は whole-WHERE capability ではなく BINARY leaf 単位と明記しないと正規化が欠落する

- 該当: R3 §2.1 条件 1、§4.1、§5
- 根拠: `src/core/optimization/whereCapability.ts:140-171,239-245,478-497`

R3 は「`classifyWhereCapability` が `WHERE_RESIDUAL` を返す述語」と書いていますが、実際の返り値の capability は `LOCAL_ONLY` であり、`WHERE_RESIDUAL` は reason code です。

```ts
return {
  capability: "LOCAL_ONLY",
  reasons: [{
    code: "WHERE_RESIDUAL",
    field: left.field,
    fieldType: semantics.fieldType,
    operator: nativeOp,
  }],
};
```

さらに WHERE 全体を分類すると、対象 leaf が residual でも別 leaf が exact の `AND` は `SUPERSET_PREFILTER` になります。

```ts
if (op === "AND" && (
  left.capability === "EXACT_PUSHDOWN" || right.capability === "EXACT_PUSHDOWN"
  || left.capability === "SUPERSET_PREFILTER" || right.capability === "SUPERSET_PREFILTER"
)) {
  return {
    capability: "SUPERSET_PREFILTER",
    reasons: [{ code: "WHERE_SUPERSET_PREFILTER" }, ...reasons],
  };
}
```

例えば `WHERE 選択 = 'A' AND $id > 100` は、選択 leaf 自体は `WHERE_RESIDUAL` でも WHERE 全体は `SUPERSET_PREFILTER` です。whole-WHERE capability を条件 1 に使うと正規化されません。また `OR` / `NOT` / `GROUP` 内でも `=` → singleton `IN` は同値なので、論理位置を理由に除外する必要はありません。

**提案:** 「WHERE tree を再帰走査し、各 `BINARY` leaf を単独で `classifyWhereCapability(leaf, resolver)` した結果が `LOCAL_ONLY` かつ reason `WHERE_RESIDUAL` で、条件 2〜6 を満たす場合に置換する」と記す。受入に `AND`、`OR`、`NOT (選択 = 'A')`、括弧付き、および同一 WHERE 内の複数正規化 leaf を追加する。

### 3. [高] §4.3 の EXPLAIN 非変更性は正規化の効果と矛盾する

- 該当: R3 §2.4、§4.1、§4.3
- 根拠: `src/execute.ts:2698-2711,4457-4475,10640-10652,10719-10740,10854-10883`

R3 §4.3 は、EXPLAIN は `kintone query` と `pushdown normalized` 行以外が一致すると要求しています。しかし EXPLAIN の mode / reason / fetch は capability と query の有無から計算されます。

```ts
const mode = totalCountPlan
  ? "COUNT_TOTAL_COUNT"
  : orderPlan?.kind === "CANONICAL_LOCAL"
  ? "FULL_SCAN"
  : whereCapability && whereCapability.capability !== "EXACT_PUSHDOWN"
    ? "FULL_SCAN"
    : resolveSelectMode(stmt);

if (whereCapability && whereCapability.capability !== "EXACT_PUSHDOWN") {
  reasons.push(...whereCapability.reasons.map((reason) => reason.code));
}
```

COUNT 最適化も exact capability を必須にします。

```ts
function isCountStarTotalCountEligible(stmt, whereCapability): boolean {
  if (whereCapability.capability !== "EXACT_PUSHDOWN") return false;
  ...
}
```

通常 SELECT でも正規化前は `LOCAL_ONLY` により `FULL_SCAN`、正規化後は `EXACT_PUSHDOWN` により static mode へ戻ります。したがって少なくとも次は正しく変化し得ます。

- `mode: FULL_SCAN` → `SIMPLE` / `COUNT_TOTAL_COUNT`
- `fetch: ALL` → `EXACT`（JOIN なら source ごとの `PREFILTERED` / `EXACT`）
- `WHERE_RESIDUAL` reason の消滅
- KORDER / canonical order plan の採否
- COUNT の `limit 1`, `totalCount=true`, fields `$id` 表示

**提案:** §4.3 を「結果行・列は不変。EXPLAIN は正規化に因果関係のある `mode` / `fetch` / `reason` / order plan / COUNT plan / query / normalized 行の変化を許可し、それ以外は不変」に修正する。ケース別 golden を置き、単純 SELECT、COUNT、KORDER、JOIN で期待する plan 差分を明記する。

### 4. [高] B127 条件 4 は SelectStatement 単体からは判定できず、現結果合成は子 warning を捨てる

- 該当: R3 §3.2 条件 2〜4、§3.3、§4.2、§5、§6-3
- 根拠: `src/types/ast.ts:186-200,207-222,427-432`、`src/execute.ts:4751-4813,4833-4871,4890-4908`

単一 SELECT 自身から直接判定できるのは次です。

```ts
export interface SelectStatement {
  from: TableRef;
  joins: JoinClause[];
  ...
}

export interface TableRef {
  appId: number;
  alias: string | null;
  cteName: string | null;
  subtableCode?: string | null;
}
```

したがって `joins.length === 0`、`from.cteName === null`、`!from.subtableCode` は判定できます。一方、「UNION の枝である」「CTE 定義本体として実行された」「単純 CTE の inline 後である」は Select node 自身にはありません。親 AST は別型です。

```ts
export interface WithStatement {
  type: "WITH";
  ctes: CteDefinition[];
  query: SelectStatement | UnionStatement;
}

export interface UnionStatement {
  type: "UNION";
  left: SelectStatement | UnionStatement;
  right: SelectStatement;
}
```

特に inline CTE は新しい Select を直接 `executeSelect()` へ渡すため、そこで warning を集める時点では「CTE を経た」という履歴を失います。

```ts
if ((seed == null || seed.size === 0) && canInlineSingleCte(stmt)) {
  return executeSelect(buildInlinedQuery(stmt), client, options, cacheContext, ...);
}
```

また現 UNION 合成は行・列だけを新しい結果へ移し、左右の warnings を捨てます。

```ts
const result: SelectResult = {
  type: "SELECT",
  rows,
  columns: leftCols,
  rowCount: rows.length,
};
```

実体化 CTE cache も `rows` / `columns` / `columnMeta` だけです。

```ts
cteCache.set(cte.name, {
  rows: result.rows,
  columns: result.columns,
  columnMeta: materializedMetaBySelectResult.get(result),
});
```

Select 単体の source shape だけで抑止すると、UNION の各枝が直接 APP を読む場合に条件 4 を見落として警告を誤って抑止します。

**提案:** root statement walk で Select ごとに `DIRECT_TOP_LEVEL` / `DERIVED_CTE` / `DERIVED_UNION` context を付け、実行・EXPLAIN の warning collector に渡す。判定不能なら必ず derived 扱いにして警告を出す。UNION は左右 warnings を安定順で merge し、CTE は中間 warning を cache か execution context に保持して最終結果へ merge する。inline 前の context を inline 後 Select に引き継ぐ。受入には「直接 SELECT と同一形の UNION branch / inline CTE body」を入れる。

### 5. [中] `!=` を Phase 2 に送る superset 性の根拠は現コード・現文書と一致しない

- 該当: R3 §1、§2.5、§4.1、§6-4
- 根拠: `docs/ksql_language_reference.md:1077-1085,1108-1117`、`src/engine/evalWhere.ts:145-160,238-280`、`src/core/optimization/wherePredicatePushdown.ts:114-134,174-182`、`src/core/optimization/joinPredicatePushdown.ts:1066-1074`

言語リファレンスは未選択行について次を明記しています。

```md
選択系の空／未設定セルは IN ('') に一致し、NOT IN ('') で除外されます。
...
NOT IN ('A','B')＝A も B も含まない行に一致します（... `[]` と `['C']`）。
```

ローカル評価も `NOT_IN` を `IN` の論理補集合として実装しています。

```ts
const contains = typedInContains(leftStr, values, fieldType);
return op === "IN" ? contains : !contains;
```

単一値 `DROP_DOWN` / `RADIO_BUTTON` は collection 型の JSON 展開へ入らず `values.has(leftStr)` です。未選択は `leftStr === ""` なので、非空の `X` に対して `NOT IN ('X')` は true です。これは scalar `!= 'X'` と一致します。

既存の FULL_SCAN safe prefilter は `IN` と `NOT_IN` を同じ gate で扱い、JOIN も実在する非空選択肢なら両方を `exact` としています。

```ts
if (expr.op !== "IN" && expr.op !== "NOT_IN") return false;
...
return expr.right.values.every((value) =>
  value.type === "STRING" && value.value !== "" && validOptions.has(value.value)
);
```

```ts
if ((predicate.op !== "IN" && predicate.op !== "NOT_IN")
  || predicate.right.type !== "IN_LIST"
  || predicate.right.values.length === 0) return "unsafe";
...
return ... ? "exact" : "unsafe";
```

**判定:** 現在の kSQL 契約と実装を前提にすると、実在する非空 `X` に対する単一値選択系の `!= 'X'` → `NOT IN ('X')` は同値であり、未選択行を落としません。R3 の「部分集合になり得る」という Phase 2 根拠は成立しません。

**提案:** 次のどちらかをオーナー判断として明記する。

1. Phase 1 に `!=` / `<>` → `NOT_IN` も同じ条件で含め、`=` と同じ受入を置く。
2. リリース範囲を小さくするため意図的に延期する。ただし理由を superset 性ではなく「初回スコープ限定」とし、既存 `NOT IN` 契約を疑う記述は削除する。

外部 kintone 実機の `not in` 挙動は今回 MCP 禁止かつ実機テストなしのため **未確認**。上の結論は、現リポジトリが公開契約とし、既存 optimizer が exact と扱っている意味論に基づく。

### 6. [中] `metrics.fetchedRows` の厳密減少は一般には効果証明にならず、Cursor 経路を数えない

- 該当: R3 §4.1、§4.3
- 根拠: `src/execute.ts:791-814,834-887`

`fetchedRows` は `getRecords()` 応答の `records.length` だけを加算します。

```ts
getRecords: async (params) => {
  metrics.getCalls += 1;
  const res = await client.getRecords(params);
  metrics.fetchedRows += res.records.length;
  return res;
},
```

Cursor は別の `cursorRecordsScanned` に入ります。

```ts
const page = await handle.nextPage();
metrics.cursorRecordsScanned += page.records.length;
```

したがって、次のケースでは `fetchedRows` の strict decrease が成立しない、または比較対象として不十分です。

- fixture の全レコードが `出庫` で、押し下げ前後の取得件数が同じ
- アプリが 0 件
- LIMIT / page 境界により最初の応答件数が同じ
- 正規化後に `KORDER_CURSOR` となり、取得量が `cursorRecordsScanned` 側へ移る
- mock client が query を解釈せず常に同じ records を返す

**提案:** 効果受入を二層に分ける。

1. 決定的な unit / integration fixture で records API の `query` が `IN ('X')` と同一であること、サーバー応答を対象件数へ絞る mock なら `fetchedRows` が減ることを確認する。
2. KORDER Cursor では `fetchedRows` ではなく `cursorRecordsScanned` と fetch plan を確認する。

`fetchedRows` の減少は「対象外レコードを含む固定 fixture での追加証拠」とし、全ケース共通の必須条件にはしない。

### 7. [中] `IN ('')` は whole-WHERE exact では押し下がるが、safe prefilter / JOIN では意図的に押し下がらない

- 該当: R3 §2.1 条件 5〜6、§4.1、依頼点 4
- 根拠: `src/core/optimization/whereCapability.ts:223-238`、`src/core/optimization/wherePredicatePushdown.ts:122-134,174-182`、`src/core/optimization/joinPredicatePushdown.ts:1066-1074`、`docs/ksql_language_reference.md:980-994,1074-1085,1113-1117`

利用者が直接 `IN ('')` と書いた場合、whole-WHERE capability は `rightCanPush && native.has("in")` だけで `EXACT_PUSHDOWN` になり、`optionOrder` の実在確認は行いません。

```ts
const rightCanPush = right.type === "STRING" || right.type === "NUMBER"
  || right.type === "IN_LIST" || ...;
...
if (rightCanPush && structureAllows && native.has(nativeOp) && !sqlLikeIsResidual) {
  return { capability: "EXACT_PUSHDOWN", ... };
}
```

一方、FULL_SCAN の安全 leaf 抽出は空文字を明示的に拒否します。

```ts
return expr.right.values.every((value) =>
  value.type === "STRING" && value.value !== "" && validOptions.has(value.value)
);
```

JOIN gate も同じです。したがって言語リファレンスの「`確度 IS NULL` → `確度 IN ('')` は押し下がる形」は whole-WHERE exact の実測としては整合しますが、「どの経路でも prefilter になる」という意味ではありません。

`optionOrder` に空文字が無いことと、直接記述した `IN ('')` が特別な空セル sentinel として有効であることは両立します。R3 の条件 5 は「通常の選択肢 X が実在するか」を確かめる gate であり、空 sentinel の妥当性 gate ではありません。条件 6 により自動正規化から空文字を外す判断は保守的で安全です。ただし条件 5 だけでも通常は空文字が落ちるため、条件 6 の役割は「空 sentinel を将来 optionOrder 特例で通しても Phase 1 では対象外」と固定することです。

**提案:** R4 で次を明記する。

- `IN ('')` の押し下げ可否は whole-WHERE exact と safe prefilter / JOIN で異なる。
- `= ''` を外すのは非同値だからではなく、空 sentinel の REST 契約を Phase 1 の自動書換え対象にしないというスコープ判断。
- 受入に直接記述した `IN ('')` の SIMPLE / residual 混在 / JOIN の3経路を置き、既存挙動を固定する。

実 kintone API が各経路で空 sentinel をどう受理するかは、今回実機テストなしのため **未確認**。コードと現言語リファレンスから確認できるのは上記 planner 挙動までである。

### 8. [低] `pushdown normalized` の複数件・順序・表示 escaping が未定義

- 該当: R3 §2.6、§4.3
- 根拠: `src/types/ast.ts:480-505,692-696`、`src/converter/whereToKintone.ts:214-217`

WHERE には複数の BINARY leaf があり得ますが、R3 は「1 行出す」とだけ書いています。`A = 'x' OR B = 'y'` では2件の rewrite が発生します。また literal に `'`、`"`、`\` がある場合、SQL 表示と kintone query 表示の escaping は異なります。

```ts
function convertString(v: StringLiteral): string {
  return `"${v.value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
```

**提案:** 1 rewrite = 1 plan row、WHERE の左から右への安定順、同一 AST leaf は1回だけ、と定義する。左側は SQL renderer、右側は既存 `whereToKintone()` を使い、手組み escaping を避ける。受入に複数 leaf と quote / backslash を含む選択肢を加える。

## 依頼の 7 点への回答

### 1. 正規化を差し込む位置と EXPLAIN / 実行の一致

**推奨位置は `classifyWhereCapability()` の中ではなく、`buildWhereFieldSemanticsResolver()` の完了直後かつ capability / plan 構築前の共有正規化パスです。**

現実行は次の順です。

```ts
// src/execute.ts:2556-2565
const resolver = await buildWhereFieldSemanticsResolver(...);
return classifyWhereCapability(stmt.where, resolver);
```

```ts
// src/execute.ts:2660-2708
const whereCapability = ... await resolveSelectWhereCapability(stmt, ...);
...
const mode = whereCapability.capability === "EXACT_PUSHDOWN"
  ? staticMode
  : "FULL_SCAN";
const orderPlan = ...({ stmt, whereCapability: whereCapability.capability, ... });
```

EXPLAIN も同じ resolver / classifier を呼びます。

```ts
// src/execute.ts:9511-9522
const capability = await resolveSelectWhereCapability(select, tracedClient, cacheContext);
capabilities.set(select, capability);
const joinPushdownPlan = ... buildRuntimeJoinPushdownPlan(
  select,
  await loadTypedPushdownMeta(select, tracedClient, cacheContext)
);
```

ただし共有しているのは **分類関数**であり、実行対象 AST そのものではありません。候補と落とし穴は次です。

| 候補 | 判定 | 落とし穴 |
|---|---|---|
| `classifyWhereCapability()` 内で破壊的変更 | 不可 | 戻り値に AST がなく、呼出順依存。JOIN 内部 resolver には optionOrder がない。classifier の純粋性を壊す |
| `resolveSelectWhereCapability()` で正規化 | 条件付き | 現戻り値は capability のみ。`{ normalizedWhere, capability, rewrites }` に変え、全 caller が effective stmt を使う必要がある |
| `executeSelect()` だけで正規化 | 不可 | EXPLAIN、CTE 専用 `executeFullScanWithCte()`、subquery / UNION branch と不一致になる |
| parse 直後に statement tree 全体を正規化 | 不可 | `optionOrder` 取得前なので条件 5 を判定できない |
| schema-aware Select planning 共通層で pure 正規化 | 推奨 | 実行と EXPLAIN の両方に同じ helper を組み込み、effective AST と rewrite 記録を運ぶ設計が必要 |

正規化後は capability、`whereToKintone`、JOIN plan、COUNT、KORDER、`runFullScan` のすべてが同じ effective AST を読むべきです。

### 2. その位置で `optionOrder` を参照できるか

**物理選択フィールドの WHERE では参照可能です。parse 直後では不可です。metadata 未解決経路は正規化しない fail-closed で足ります。**

`buildWhereFieldSemanticsResolver()` は通常フィールドを含む WHERE なら physical app の fields を取得します。

```ts
const physicalAppIds = forcePhysicalMetadata || whereNeedsFieldMetadata(stmt.where)
  ? [...new Set(tables.filter((table) => table.cteName === null).map((table) => table.appId))]
  : [];
...
const infos = await getFieldsCached(appId, client, cacheContext);
```

field resolver は `KintoneFieldInfo` から semantics を作り、source も付けます。

```ts
const base = info.semantics ?? resolveFieldSemantics(info);
...
return withFieldSemanticSource(semantics, table.appId, info.code);
```

`resolveFieldSemantics()` は `optionOrder` を Map に載せます。

```ts
const optionOrder = source.optionOrder
  ? new Map(Object.entries(source.optionOrder))
  : undefined;
...
...(optionOrder && optionOrder.size > 0 ? { optionOrder } : {}),
```

CTE / temp は materialized column metadata があれば semantics を返し、無ければ synthetic string へ倒れます（`src/execute.ts:2466-2475`）。JOIN の非修飾同名列も ambiguous なら synthetic semantics です（`2485-2488`）。これらでは `optionOrder` 不在により正規化しないのが安全です。

注意点として、JOIN planner 内部の `classifyWhereCapability()` 呼出しは `resolveFieldSemantics({ fieldType })` だけで optionOrder を作りません。したがって normalizer は JOIN leaf classifier 内ではなく、それより前の schema-aware Select planning に置く必要があります。

### 3. 「IN と同じ AST に落とせば下流は不変」は本当か

**「選択系 `=` 専用の分岐を downstream に足さなくてよい」という意味では真です。ただし effective AST を全 downstream に渡す plumbing は必要です。**

利用者記述の `IN` は次の AST です。

```ts
{ type: "BINARY", op: "IN", left: field,
  right: { type: "IN_LIST", values: [...] } }
```

型定義も `BINARY.op` に `IN`、右辺に `IN_LIST` を持ちます（`src/types/ast.ts:480-490,692-696`）。

下流確認結果:

- kintone query: `whereToKintone()` は `IN` → `in`、`IN_LIST` → `(...)` を既に処理する（`whereToKintone.ts:85-100,305-317`）。
- JOIN prefilter: 選択系は `IN` / `NOT_IN` + 非空実在 option list を `exact` とする（`joinPredicatePushdown.ts:1066-1074`）。
- COUNT: AST の `=` を直接見る分岐はなく、exact capability を見る（`execute.ts:4457-4475`）。
- KORDER / canonical order: operator ではなく `whereCapability` を入力にする（`execute.ts:2702-2711`、`core/optimization/korderPlanner.ts:30-38`）。
- EXPLAIN: capability と actual query を使う。ただし renderer は `stmt.where` を直列化するため effective AST の伝播が必須（`execute.ts:10640-10652,10719-10724,10854-10866`）。
- ローカル再評価: FULL_SCAN は `stmt.where` を `evalWhere()` に渡す（`engine/process.ts:1917-1921`）。

ローカル意味論も対象型では同値です。`=` は option compare の `cmp === 0`、`IN` は単一値型では `values.has(leftStr)` です。

```ts
// scalarCompare.ts:159-169
const cmp = compareCanonicalValues(left, right, semantics);
case "=": return cmp === 0;
```

```ts
// evalWhere.ts:145-160,238-263
const contains = typedInContains(leftStr, values, fieldType);
return op === "IN" ? contains : !contains;
...
return fallback(); // scalar 型は values.has(leftStr)
```

条件 1〜6を同時に満たす実質対象は通常 `RADIO_BUTTON` / `DROP_DOWN` です。`STATUS` は `=` 自体が native exact、`CREATOR` / `MODIFIER` は `=` が local-invalid、複数値型は条件 3で除外されます。非空実在 X に対して、未知値・空値を含め `= X` と singleton `IN (X)` の結果は一致します。

したがってローカル再評価も normalized `IN` でよく、original `=` を別保持して評価する必要はありません。むしろ original と normalized を経路別に混ぜない方が安全です。

### 4. `= ''` と `IS NULL` / `IN ('')`

**`IN ('')` は whole-WHERE exact 経路では押し下がりますが、safe prefilter と JOIN では空文字 gate により押し下がりません。条件 5との論理矛盾ではありません。`= ''` を Phase 1 対象外にする判断は妥当です。**

`IS NULL` は AST が `NULL_CHECK` で、capability は local-only です。converter 自体には `field = ""` への変換がありますが、capability gate を通らないので通常の exact query にはなりません（`whereCapability.ts:149-151,429-450`、`whereToKintone.ts:103-114`）。

直接 `IN ('')` は empty sentinel として言語契約にあり（language reference `1074,1083,1088-1091`）、whole-WHERE exact classifier は optionOrder を検査しないため REST query になります。一方、安全 leaf と JOIN は `value !== ""` を要求します。

条件 5は通常 option の実在性、空文字は option ではなく sentinel です。条件 6は sentinel を Phase 1 から明示的に外します。将来 `= ''` を自動変換するなら、optionOrder membership とは別の「empty sentinel を当該 REST 経路で安全に使える」証明が必要です。

### 5. `!=` を Phase 2 にする根拠

**現 repo 契約では superset 問題は確認できず、`!= X` と `NOT IN (X)` は対象の単一値型で同値です。現在の Phase 2 根拠は撤回すべきです。**

ローカル `NOT_IN` は `IN` の補集合で、空セル `""` は非空 X を含まないため true です。既存 safe prefilter と JOIN は `NOT_IN` を `IN` と同じ実在・非空 gate で採用し、JOIN は `exact` としています。言語リファレンスも `NOT IN ('A','B')` が未選択 `[]` を含むと明記しています。

したがって Phase 1 同梱はコード契約上可能です。延期するなら、理由は安全性ではなくスコープ縮小とすべきです。実 kintone API の再実測は今回の禁止条件により未確認です。

### 6. B127 の抑止条件 2〜4をどの情報から判定するか

| 条件 | 判定材料 | 判定可否 |
|---|---|---|
| 単一物理 app | `SelectStatement.from.appId`, `from.cteName`, `joins.length` | Select 単体で可 |
| JOIN なし | `SelectStatement.joins.length === 0` | 可 |
| サブテーブルなし | `SelectStatement.from.subtableCode == null` | 可 |
| CTE / temp source なし | `from.cteName === null`、各 join `table.cteName` | 直接参照は可 |
| CTE を経ていない | 親 `WithStatement.ctes/query` context、inline 前 context | Select 単体では不可 |
| UNION を経ていない | 親 `UnionStatement.left/right` context | Select 単体では不可 |

ORDER BY key の型は `buildOrderByMetaForSelect()` の `semantics` から取れます。これは top-level order と全 window order を収集します。

```ts
const items = [
  ...stmt.orderBy,
  ...stmt.columns.flatMap((column) =>
    column.type === "WINDOW_COL" ? column.orderBy : []),
];
```

SELECT alias は physical field より先に解決されます。

```ts
const base = aliasSemantics.get(name)
  ?? resolveField(aggregateFieldRef(name))?.semantics;
```

したがって `$id` という文字列だけを見る必要はなく、`fieldType === "__ID__"` / `"RECORD_NUMBER"` を使えます。alias provenance も既存 resolver がある程度保持します。

判定不能時に「抑止しない（警告を出す）」のは安全です。ただし、親 context を渡さないまま各 Select を既定で direct とみなしてはいけません。**明示的に DIRECT と証明できた top-level Select だけ抑止可能**、それ以外は warning、とするのが最小です。

### 7. 受入条件で検出できない穴

現 §4 には次の穴があります。

1. `選択 = 'A' AND $id > 10` のような whole capability が `SUPERSET_PREFILTER` になる複合 WHERE。leaf 正規化漏れを検出できない。
2. `OR` / `NOT` / GROUP 内の同値正規化、複数 leaf、複数 field。
3. EXPLAIN の mode / fetch / reason / COUNT / KORDER plan が正しく変わること。現「それ以外一致」は逆に正しい実装を失敗させる。
4. 実行と EXPLAIN の actual `kintone query` 一致。単に両方が `IN` を含むだけでなく、JOIN source 別 query と fetch scope まで比較すべき。
5. `metrics.fetchedRows` はデータ分布・API方式依存。Cursor は `cursorRecordsScanned`。
6. B127 の UNION branch / inline CTE body が、形だけ直接 SELECT と同じケース。
7. UNION / CTE warning の merge、既存 warning との順序・重複。
8. `$id` という SELECT alias、physical `$id AS rid` を window ORDER BY するケース、metadata 未解決。
9. `IN ('')` の whole exact / residual 混在 / JOIN の経路差。
10. `!=` を残すなら既存通り residual、同梱するなら `NOT IN` と結果・query・空セルが一致する受入。

`metrics.fetchedRows` は対象外レコードを含む固定 fixture でのみ strict decrease を要求し、KORDER Cursor は `cursorRecordsScanned` を見るべきです。最も直接的な効果証明は、実 records API call の `query` が利用者記述の `IN ('A')` と byte-for-byte 同じであることです。

## 仕様が正しかった点（R4 で消さない）

1. **B126 を警告ではなく正規化にする中心方針**は妥当。利用者に手書き変更を要求せず、既存 IN pipeline を再利用できる。
2. **利用者が書いた singleton `IN` と同じ `BINARY(op: "IN") + IN_LIST` AST にする方針**は正しい。downstream に B126 専用 operator branch は不要。
3. **単一値型だけに限定する条件 3**は必須。複数値型の `IN` は overlap で、scalar `=` と同義ではない。
4. **実在 option の確認（条件 5）**は必須。定義外値を自動で REST へ送って、従来の正常 0 行を `GAIA_IQ10` に変えてはならない。
5. **metadata 不在時の fail-closed**は正しい。正規化しなければ従来のローカル評価を維持できる。
6. **空文字を Phase 1 対象外にする条件 6**は保守的で妥当。empty sentinel は通常 option membership と別契約である。
7. **正規化後もローカル再評価する原則**は正しい。対象型・条件では normalized `IN` の再評価も元の `=` と同値である。
8. **JOIN / COUNT / KORDER の挙動を利用者記述 IN に委ねる方針**は正しい。ただし effective AST の共通伝播は必要。
9. **正規化を EXPLAIN で観測可能にする方針**は必要。SQL と REST query の見た目の差を説明できる。
10. **B127 を警告のままにし、既定 RANGE 自体を変えない方針**は正しい。ROWS / RANGE の選択は利用者意図で決まる。
11. **`windowKind === "AGGREGATE"`、`orderBy.length > 0`、`frame.source === "DEFAULT"` の検出条件**は AST / parser と一致する（`src/types/ast.ts:287-315`、`src/parser/parser.ts:1528-1529`）。
12. **B127 の抑止を、結果行の一意性を証明できる直接単一 APP に狭める方針**は正しい。JOIN、サブテーブル、CTE、UNION は fail-closed に警告するべきである。
13. **ORDER key の型を既存 `buildOrderByMetaForSelect()` から得る方向**は正しい。AST の名前文字列だけで `$id` / RECORD_NUMBER を判定すべきではない。
14. **UNION / CTE の子 warning を親へ集約する要件**は正しい。現コードが捨てているため、R4 でも消してはならない。
15. **`ksql_validate` を不変とするスコープ**は妥当。B126/B127 は SELECT planning / result diagnostics の変更として閉じられる。
