# B47 — APPLY 複数親 UPDATE の親 WHERE における LIKE 仕様 R1

- 作成日: 2026-07-21
- ステータス: **R1（仕様案・未実装）**
- 対象: B47「APPLY 複数親 UPDATE の WHERE で `LIKE` / `KLIKE` が使えない」
- 一次情報: [ksql_issue_tracker.md B47](../ksql_issue_tracker.md#L39)
- 関連仕様: [B44 APPLY block spec](ksql_apply_block_spec.md)、[LIKE predicate pushdown spec](ksql_like_predicate_pushdown_spec.md)、[B45 subtable system column WHERE plan](ksql_b45_subtable_system_column_where_plan.md)

## 1. 症状

次の B44 複数親 APPLY UPDATE は、親 `WHERE` の `LIKE` に到達した時点で `DmlConvertError` となり、records API / mutation API を呼ばずに拒否される。

```sql
UPDATE APP4223
SET 金額 = 1
WHERE タイトル LIKE 'B44%'
APPLY テーブル (...);
```

表示される現行エラーは次である。

```text
UPDATE / DELETE の WHERE に LIKE / NOT LIKE は使用できません。
LIKE は kSQL の意味論に従って JS で評価する必要がありますが、親レコード DML には JS 評価経路がないため、安全上拒否しました。
SELECT で対象レコード番号を確認し、IN または完全一致で対象を指定してください。
```

根拠は [src/converter/dmlToKintone.ts:34-46](../../src/converter/dmlToKintone.ts#L34) である。

```ts
function assertDmlWhereIsSafe(where: WhereExpr): void {
  if (whereHasKlike(where)) {
    throw new DmlConvertError(
      "UPDATE / DELETE の WHERE に KLIKE / NOT KLIKE は使用できません。" +
      "kintone キーワード検索の打ち切りを検出できないため、全 DML で安全上拒否しています。"
    );
  }
  if (!whereHasLike(where)) return;
  throw new DmlConvertError(
    "UPDATE / DELETE の WHERE に LIKE / NOT LIKE は使用できません。" +
    "LIKE は kSQL の意味論に従って JS で評価する必要がありますが、親レコード DML には JS 評価経路がないため、安全上拒否しました。" +
    "SELECT で対象レコード番号を確認し、IN または完全一致で対象を指定してください。"
  );
}
```

現行の回避策は、一次情報どおり完全一致、`IN (...)`、または SELECT で確認した `$id IN (...)` で対象親を明示することである。

## 2. 原因（実コードによる事実確定）

### 2.1 parser は LIKE/KLIKE を別の比較演算子として保持する

parser は `LIKE` / `NOT LIKE` を `BINARY` の `LIKE` / `NOT_LIKE`、`KLIKE` / `NOT KLIKE` を `KLIKE` / `NOT_KLIKE` として AST に保持する。`KLIKE` の右辺だけは文字列またはバッチ変数に限定される（[src/parser/parser.ts:2047-2082](../../src/parser/parser.ts#L2047)、[src/parser/parser.ts:2085-2118](../../src/parser/parser.ts#L2085)）。

```ts
if (this.consume(TokenKind.LIKE)) {
  const pattern = this.parseSqlValue();
  return { type: "BINARY", op: "NOT_LIKE", left: field, right: pattern };
}
if (this.consume(TokenKind.KLIKE)) {
  const pattern = this.parseKlikePattern();
  return { type: "BINARY", op: "NOT_KLIKE", left: field, right: pattern };
}
// ...
if (this.consume(TokenKind.KLIKE)) {
  const pattern = this.parseKlikePattern();
  return { type: "BINARY", op: "KLIKE", left: field, right: pattern };
}
// ...
case TokenKind.LIKE:  return "LIKE";
```

したがって原因は parser が構文を受理しないことではない。構文受理後の DML 変換・実行経路が fail-closed である。

### 2.2 whereToKintone は LIKE を拒否し、KLIKE だけを native like に変換する

`whereToKintone` のトップレベル switch は `WhereExpr` の構造型だけを扱い、`BINARY` を `convertBinary` へ渡す（[src/converter/whereToKintone.ts:45-55](../../src/converter/whereToKintone.ts#L45)）。`STRING_FUNC` は `WhereExpr` の直下ケースではなく、左辺の `FUNC_FIELD` として後段で拒否される（[src/converter/whereToKintone.ts:165-170](../../src/converter/whereToKintone.ts#L165)）。LIKE の本体は `convertBinary` 冒頭で常に拒否される（[src/converter/whereToKintone.ts:61-70](../../src/converter/whereToKintone.ts#L61)）。

```ts
function convertBinary(expr: BinaryExpr): string {
  if (isLike(expr)) {
    throw new KintoneQueryError(
      "LIKE / NOT LIKE は kintone クエリに変換できません（常に JS 評価が必要です）"
    );
  }
  const left = convertField(expr.left);
  const op = convertOp(expr.op);
  const right = convertValue(expr.right, expr.op);
  return `${left} ${op} ${right}`;
}
```

一方、演算子変換は KLIKE だけを kintone native `like` / `not like` へ通す（[src/converter/whereToKintone.ts:84-99](../../src/converter/whereToKintone.ts#L84)）。

```ts
case "LIKE":      return "like";
case "NOT_LIKE": return "not like";
case "KLIKE":     return "like";
case "NOT_KLIKE": return "not like";
```

ここで `LIKE` の case が残っていても、`convertBinary` の `isLike(expr)` が先に throw するため到達しない。KLIKE は `isLike` ではないので到達する。

### 2.3 親 DML は WHERE 全体を kintone query にする前提で、JS 再評価を持たない

通常 UPDATE の対象取得は `assertDmlWhereIsSafe` 後に `whereToKintone(stmt.where)` をそのまま query にする（[src/converter/dmlToKintone.ts:145-158](../../src/converter/dmlToKintone.ts#L145)）。

```ts
export function updateToGetQuery(stmt: UpdateStatement): KintoneGetForDmlParams {
  assertDmlWhereIsSafe(stmt.where);
  const checkFields = collectUpdateCheckTargetFields(stmt);
  return {
    app: stmt.appId,
    query: whereToKintone(stmt.where),
    fields: ["$id", ...checkFields],
    totalCount: false,
  };
}
```

DELETE も同じく WHERE 全体を query に変換する（[src/converter/dmlToKintone.ts:488-500](../../src/converter/dmlToKintone.ts#L488)）。この設計では query が返した集合がそのまま更新・削除対象であり、LIKE を JS で再評価する段がないため、v2.0.0 以降の fail-closed と整合する。

## 3. B44 複数親 WHERE 評価経路の事実確定

### 3.1 結論: 全件 GET 後の JS 親選択ではなく、WHERE 全体を kintone へ push-down している

台帳 B47 の「B44 複数親は全件 GET してから JS で post-image を組む」という記述のうち、**post-image を取得 snapshot から JS で組む点は正しいが、対象親をアプリ全件 GET 後に JS で絞る点は現行コードと一致しない**。

単一 `$id` 以外の APPLY UPDATE は `executeMultipleParentApplyPreflight` へ分岐する（[src/execute.ts:6082-6089](../../src/execute.ts#L6082)）。その中では `updateToGetQuery(stmt).query` を `baseQuery` とし、`fetchAll` に渡している（[src/execute.ts:6216-6240](../../src/execute.ts#L6216)）。

```ts
if (!isSinglePositiveRecordIdWhere(stmt.where)) {
  return executeMultipleParentApplyPreflight(stmt, client, options, cacheContext, statementNumber);
}

// executeMultipleParentApplyPreflight
const fields = collectApplySnapshotFields(stmt, fieldInfos);
const baseQuery = updateToGetQuery(stmt).query;
const detectionLimit = dmlMaxRows + 1;
const snapshots = await fetchAll(client.getRecords, stmt.appId, baseQuery, [...fields], {
  pageSize: Math.min(500, detectionLimit),
  parallel: options.fetchParallel ?? 1,
  maxRecords: detectionLimit,
  stopAfter: detectionLimit,
  onLimit: "error",
});
```

`updateToGetQuery` は §2.3 のとおり WHERE 全体を `whereToKintone` へ渡す。従って現行の親選択は次である。

```text
親 WHERE 全体
  -> assertDmlWhereIsSafe
  -> whereToKintone（WHERE 全体の exact push-down）
  -> fetchAll（query に一致した snapshot だけ）
  -> prepareApplyPatchWrite
  -> PUT
```

### 3.2 buildApplyPatchPlans は渡された全 snapshot を対象化し、親 WHERE を再評価しない

`prepareApplyPatchWrite` は受け取った `snapshots` をそのまま `buildApplyPatchPlans` へ渡し、その後 post-image 検証とガードを行う（[src/core/applyPatchPrepare.ts:59-77](../../src/core/applyPatchPrepare.ts#L59)、[src/core/applyPatchPrepare.ts:91-126](../../src/core/applyPatchPrepare.ts#L91)）。

```ts
for (const snapshot of snapshots) requireRevision(snapshot);
const rawPlans = buildApplyPatchPlans(statement, snapshots, fieldInfos, metadata);
// ... validatePostImage for every raw plan ...
const parentRows = rawPlans.length;
// ... guards ...
const records = plans.flatMap((plan) => applyPatchPlanToKintone(plan).records);
```

`buildApplyPatchPlans` は `snapshots.map(...)` で全 snapshot を親計画へ変換するだけで、`statement.where` を `evalWhere` へ渡さない（[src/core/applyPatchPlanner.ts:260-276](../../src/core/applyPatchPlanner.ts#L260)）。

```ts
export function buildApplyPatchPlans(/* ... */): readonly ApplyPatchPlan[] {
  const parentIds = new Set<number>();
  return snapshots.map((snapshot) => {
    const parentId = requirePositiveInteger(snapshot["$id"]?.value, "APPLY snapshot $id");
    if (parentIds.has(parentId)) argument(`APPLY snapshots contain duplicate parentId ${parentId}.`);
    parentIds.add(parentId);
    return buildApplyPatchPlanForSnapshot(statement, snapshot, metadata, parentId);
  });
}
```

従って、現状の B44 複数親に SELECT の `FULL_SCAN + evalWhere` をそのまま「既にある経路」として流用することはできない。B47 の実装には、親 snapshot の取得 query を exact WHERE から安全プレフィルタへ変更し、取得後の親 WHERE 全体再評価を**新たに接続する**必要がある。

## 4. SELECT 側の LIKE / KLIKE 評価

### 4.1 LIKE は FULL_SCAN を要求する

`resolveSelectMode` は `whereRequiresJsEval` が true なら FULL_SCAN とし、`whereRequiresJsEval` は `isLike(where)` を JS 評価必須と判定する（[src/converter/selectToKintone.ts:57-83](../../src/converter/selectToKintone.ts#L57)、[src/converter/selectToKintone.ts:87-101](../../src/converter/selectToKintone.ts#L87)）。

```ts
if (whereRequiresJsEval(stmt.where)) return "FULL_SCAN";

case "BINARY":
  return isFunc(where.left)
    || /* ... */
    || isLike(where);
```

FULL_SCAN は安全な押し下げ計画を作り、候補を取得した後、`runFullScan` に元の statement と計画上の `appliedKlikes` を渡す（[src/execute.ts:3229-3248](../../src/execute.ts#L3229)、[src/execute.ts:3333-3347](../../src/execute.ts#L3333)）。`runFullScan` は元の WHERE 全体を `applyFilter` へ渡し、各行を `evalWhere` で再評価する（[src/engine/process.ts:1081-1117](../../src/engine/process.ts#L1081)、[src/engine/process.ts:185-194](../../src/engine/process.ts#L185)）。

```ts
const pushdownPlan = buildKlikePushdownPlan(stmt, pushdownMeta);
// ... fetch candidate records ...
const { rows, columns } = runFullScan({
  tables,
  stmt,
  // ...
  appliedKlikes: pushdownPlan.appliedKlikes,
});

// runFullScan
rows = applyFilter(rows, stmt.where, fieldTypeResolver, appliedKlikes, fieldSemanticsResolver);
```

### 4.2 B47 で流用すべき LIKE evaluator

`evalWhere` は論理式・括弧・否定を再帰評価し（[src/engine/evalWhere.ts:80-95](../../src/engine/evalWhere.ts#L80)）、`LIKE` / `NOT_LIKE` を `matchLike` へ渡す（[src/engine/evalWhere.ts:147-155](../../src/engine/evalWhere.ts#L147)）。

```ts
if (op === "LIKE") {
  const pattern = resolveValue(right, row, resolveFieldType);
  return matchLike(leftStr, pattern);
}
if (op === "NOT_LIKE") {
  const pattern = resolveValue(right, row, resolveFieldType);
  return !matchLike(leftStr, pattern);
}
```

`matchLike` は wildcard なしを contains、`%` を任意長、`_` を1文字として Unicode regexp で評価する（[src/engine/evalWhere.ts:410-445](../../src/engine/evalWhere.ts#L410)）。B47 は新しい LIKE 実装を作らず、親 snapshot を `ProcessRow` に flatten した上で、この `evalWhere` / `matchLike` 経路を共有しなければならない。

### 4.3 KLIKE は局所評価できない

`evalWhere` は KLIKE ノードが「押し下げ済み集合」に含まれる場合だけ true 扱いし、それ以外は throw する（[src/engine/evalWhere.ts:101-117](../../src/engine/evalWhere.ts#L101)）。

```ts
if (expr.op === "KLIKE" || expr.op === "NOT_KLIKE") {
  if (appliedKlikes?.has(expr)) return true;
  throw new Error("KLIKE / NOT KLIKE は押し下げ済み集合に含まれないため JavaScript 側では評価できません");
}
```

SELECT の KLIKE は `buildKlikePushdownPlan` が query 条件と `appliedKlikes` を同一抽出結果から作り、fetch と JS 残余評価で共有する専用設計である（[src/core/optimization/klikePushdownPlan.ts:16-24](../../src/core/optimization/klikePushdownPlan.ts#L16)、[src/core/optimization/klikePushdownPlan.ts:37-82](../../src/core/optimization/klikePushdownPlan.ts#L37)）。B45 も同じ理由でサブテーブル SELECT の局所 WHERE から KLIKE を対象外にした前例がある（[docs/internal/ksql_b45_subtable_system_column_where_plan.md:109-120](ksql_b45_subtable_system_column_where_plan.md#L109)）。

## 5. 設計

### 5.1 スコープ

R1 の推奨スコープは次に限定する。

```text
UPDATE <physical app>
SET ...
WHERE <parent predicate containing LIKE / NOT LIKE>
APPLY ...
```

かつ `isSinglePositiveRecordIdWhere(stmt.where) === false` で複数親 preflight に入る文だけを対象とする。

- **対象**: B44 APPLY 複数親 UPDATE の親 WHERE にある `LIKE` / `NOT LIKE`。
- **対象外**: APPLY なしの通常親 UPDATE / DELETE。これらは query の返却集合を直接対象にするため、JS 再評価を追加するなら DML 全体の別設計になる。
- **対象外**: 単一 `$id` APPLY。LIKE を含む時点で単一 `$id` selector ではないため B47 の実需と交差しない。
- **対象外**: INSERT APPLY。INSERT には既存親を選ぶ WHERE がない。
- **対象外**: UPSERT APPLY。既存親選択は `ON DUPLICATE` キー解決であり、UPDATE 文の親 WHERE を持たない。
- **対象外**: 親 DELETE APPLY。B44 自体が親 DELETE APPLY を提供していない。

この限定により、通常親 DML の fail-closed 契約を変更せず、B44 の「対象親 snapshot を取得してから全親を prepare する」専用経路だけを拡張する。

### 5.2 LIKE 解禁方法

#### 選択肢 A: query を空にして全件取得後、WHERE 全体を JS 評価

意味論は単純だが、アプリ全件が `maxRecords` の対象となり、既存の安全押し下げ資産を使わない。現行 B44 は `dmlMaxRows + 1` 件で早期停止できるが、JS フィルタ前の候補数は更新対象数ではないため、この早期停止もそのまま使えない。

#### 選択肢 B: 安全 prefilter を push-down し、取得完了後に WHERE 全体を JS 再評価（推奨）

SELECT の前例と同じ二段階にする。

```text
P = extractSafePushdownLeaves(parent WHERE, allowKlike=false, metadata...)
C = fetchAll(kintone query = P, onLimit=error)
T = C.filter(snapshot => evalWhere(original parent WHERE, flatten(snapshot), resolvers...))
prepareApplyPatchWrite(snapshots=T)
```

`extractSafePushdownLeaves` は AND の安全な leaf だけを抽出し、OR / NOT / NULL_CHECK / EXISTS を subtree ごと除外する既存 primitive である（[src/core/optimization/wherePredicatePushdown.ts:27-39](../../src/core/optimization/wherePredicatePushdown.ts#L27)、[src/core/optimization/wherePredicatePushdown.ts:63-88](../../src/core/optimization/wherePredicatePushdown.ts#L63)）。B47 では `allowKlike: false` を明示する。

安全 leaf がなければ query は空になり、選択肢 A と同じ全件取得になる。安全 leaf があれば候補を減らせるが、最終対象は必ず元の WHERE 全体を `evalWhere` した結果だけとする。

### 5.3 取得上限と dmlMaxRows

現行の `detectionLimit = dmlMaxRows + 1`、`maxRecords = stopAfter = detectionLimit` は、kintone query が対象集合を exact に返すことを前提にする（[src/execute.ts:6232-6242](../../src/execute.ts#L6232)）。安全 prefilter は超集合を返し得るため、B47 LIKE 経路にはそのまま使えない。

R1 推奨契約:

1. prefilter 候補集合は `options.maxRecords ?? 10_000` を上限に `onLimit: "error"` で**最後まで**取得する。
2. 候補取得が上限で未完了なら書き込み0件で fail-closed とする。truncate は許可しない。
3. 全候補へ元 WHERE を JS 評価した後の `T.length` に `dmlMaxRows` を適用する。
4. `VALIDATE ONLY` も同じ候補取得・再評価を行い、実対象だけを `validatedRows` / `guards.parentRows` に数える。
5. LIKE を含まない従来経路は、既存の `dmlMaxRows + 1` 早期検出を維持して性能回帰を避ける。

候補件数を `dmlMaxRows` と比較してはならない。安全 prefilter の false positive が多いだけで、本来 `dmlMaxRows` 内の mutation を誤拒否するためである。

### 5.4 KLIKE 方針

#### R1 推奨: KLIKE / NOT KLIKE は非対応継続

理由は次のとおり。

- KLIKE は `matchLike` で局所評価できず、native query へ確実に適用したノードだけを `appliedKlikes` として残余評価へ渡す専用証明が必要である（§4.3）。
- APPLY 親 WHERE の scope checker 自体も KLIKE を明示拒否する（[src/core/applyPatchScope.ts:494-514](../../src/core/applyPatchScope.ts#L494)）。
- DML converter も KLIKE を LIKE より先に明示拒否する（[src/converter/dmlToKintone.ts:34-40](../../src/converter/dmlToKintone.ts#L34)）。
- B45 でも局所評価経路の KLIKE は対象外とした（§4.3）。
- B47 の症状を直す最小価値は SQL LIKE の解禁であり、KLIKE の native 検索意味論・適用済みノード証明まで同時に広げる必要はない。

なお、現行 `execute()` は非 SELECT 文の `getRecords` が `searchAborted` を返すと `SearchAbortedError` を投げる fail-closed wrapper を持つ（[src/execute.ts:651-666](../../src/execute.ts#L651)、[src/execute.ts:787-800](../../src/execute.ts#L787)）。従って `dmlToKintone.ts:38` の「打ち切りを検出できない」というエラー文は現在の共通 wrapper と整合しておらず、KLIKE を将来検討する際はこの文言も別途監査対象になる。ただし検出可能になったことだけで、局所評価不能・`appliedKlikes` 証明の問題は解消しない。

R1 では既存の KLIKE 拒否を維持し、回避策を含む明示エラーを返す。

```text
APPLY 複数親 UPDATE の親 WHERE に KLIKE / NOT KLIKE は使用できません。
KLIKE は JavaScript で再評価できないため、完全一致、IN、または SELECT で確認した $id IN (...) を使用してください。
```

### 5.5 scope checker と converter の境界

LIKE を許可する変更は `assertDmlWhereIsSafe` を全 DML 一律に緩めてはならない。推奨する責務分離は次である。

- 通常 `updateToGetQuery` / `deleteToGetQuery`: 現状どおり LIKE/KLIKE を拒否。
- APPLY 複数親 LIKE 専用の preflight planner: safe prefilter を生成し、元 WHERE の JS 再評価を必須化。
- `assertSafeParentWhere`: LIKE は既に一般ノード走査を通過できるため、新たに広域許可を加えない。KLIKE 拒否は維持。
- `prepareApplyPatchWrite`: 対象選択責務を混ぜず、フィルタ済み snapshot だけを受け取る現行契約を維持。

この境界なら、`buildApplyPatchPlans` が全入力 snapshot を更新対象化する性質を変えず、誤更新防止を呼び出し側の「必ず filter 済み」契約で固定できる。

## 6. 正しさ

### 6.1 超集合性

安全 prefilter `P` と元 WHERE `W` について、次を必須不変条件とする。

```text
{ snapshot | JS evalWhere(W) = true }
  subset-of
{ snapshot | kintone query(P) returns snapshot }
```

取得集合が JS 真集合の超集合であれば、取得後の `evalWhere(W)` が false positive を除去する。逆に prefilter が狭いと、取得されなかった真の親を再評価できず、静かな未更新になる。既存の pushdown 仕様も同じ包含条件を正しさの生命線としている（[docs/internal/ksql_like_predicate_pushdown_spec.md:33-47](ksql_like_predicate_pushdown_spec.md#L33)）。

従って次を禁止する。

- LIKE 自体を kintone native `like` として prefilter に使う。
- OR / NOT subtree の一部だけを抜き出す。
- 型不明の一般フィールド比較を推測で押し下げる。
- 候補取得を truncate して、その prefix だけを対象集合とする。
- prefilter の候補数を更新対象数としてガード・confirm・診断へ流す。

### 6.2 対象外親を更新しない

`buildApplyPatchPlans` は入力 snapshot を無条件に plan 化する（§3.2）。従って実装時には次の順序を固定する。

```text
fetch candidates
-> flatten parent snapshots
-> evalWhere(original WHERE)
-> targets only
-> prepare all targets
-> confirm
-> PUT chunks
```

`prepare` より後でフィルタしてはならない。post-image validation、guard、confirm、diagnostic、PUT records のすべてが対象外親を含む危険がある。

### 6.3 post-image 検証との整合

フィルタ後の対象 `T` だけを `prepareApplyPatchWrite` に渡せば、現行の全対象親 post-image 検証、正規化、`dmlMaxRows` / `dmlMaxSubtableRows` 判定はそのまま維持される（[src/core/applyPatchPrepare.ts:91-126](../../src/core/applyPatchPrepare.ts#L91)）。対象選択は更新前 snapshot に対して一度だけ行い、親 `SET` 後の値で WHERE を再判定しない。

### 6.4 チャンク・部分成功との整合

prepared records は100件単位に chunk される（[src/converter/applyPatchToKintone.ts:59-79](../../src/converter/applyPatchToKintone.ts#L59)）。実行は chunk を順次 PUT し、後続失敗時は成功済み親数を持つ `ApplyWritePartialFailureError` を返す（[src/core/applyPatchExecutePrepared.ts:57-93](../../src/core/applyPatchExecutePrepared.ts#L57)）。B47 は対象選択までの preflight だけを変え、次を維持する。

- 全候補取得、全 WHERE 再評価、全対象 post-image 検証、全 guard を最初の PUT 前に完了する。
- chunk はフィルタ後の対象順に100親ずつ作る。
- revision conflict 時に WHERE を再評価・再取得・再試行しない。
- 後続 chunk 失敗時の先行成功はロールバックしない。

### 6.5 search abort / maxRecords

候補集合が不完全なら真の対象親が未取得の可能性があるため、mutation は必ず書き込み0件で閉じる。`SearchAbortedError` と `FetchAllLimitError` は confirm / PUT より前に伝播させる。SELECT の truncate 警告方式を mutation に持ち込まない。

## 7. SemVer

B47 は従来エラーだった APPLY 複数親 UPDATE の構文を成功可能にする、後方互換な受理範囲拡大である。既存の成功文の意味論を変えず、新構文・新オプションも追加しないが、利用者が観測できる機能追加なので **minor** を推奨する。

現行 package version は `3.8.0`（[package.json:1-3](../../package.json#L1)）。実装する場合の候補は `3.9.0` 以降であり、`3.8.x` patch へ入れない。patch は不具合修正とも解釈できるが、DML の安全上の明示拒否を解禁する変更は影響面が大きく、minor の方が契約変更を正確に伝える。

## 8. 費用対効果

### 8.1 利益

- B44 の複数親修復を、タイトル prefix 等の自然な業務条件で一文実行できる。
- `$id` の事前列挙を不要にし、SELECT と UPDATE の間の対象変動・転記ミスを減らせる。
- LIKE evaluator と safe pushdown primitive は既存資産を共有できる。

### 8.2 費用・リスク

- 現行 B44 は exact push-down + `dmlMaxRows + 1` 早期停止であり、単なる `evalWhere` 1行追加ではない。取得計画、型メタ、field resolver、上限意味論、diagnostic/EXPLAIN の同期が必要になる。
- LIKE 単独ではアプリ全件 snapshot（post-image 検証に必要な広い fields を含む）を読み得る。`maxRecords` 到達で利用不能なアプリもある。
- safe prefilter の包含性を崩すと「対象親を静かに未更新」という重大な不具合になる。
- KLIKE まで同時対応すると、native 検索・適用済みノード・search abort の別設計が増える。

### 8.3 判断材料

台帳が示す完全一致、`IN`、`$id IN (...)` は安全かつ既に利用可能であり、B44 v3.8.0 の追加修正として急ぐ費用対効果は低い。R1 の推奨判断は次である。

- **v3.8.x では見送り継続**。
- 実需が「事前 SELECT + `$id IN`」では不足すると確認できた場合、**LIKE のみを minor feature として実装推奨**。
- KLIKE は別課題へ分離。

実装判断前に、実アプリでの対象件数、LIKE と AND 併記できる安全 prefilter の有無、`maxRecords` 内で候補を取得しきれる割合を確認する。

## 9. テスト観点

実装時は修正前 fail / 修正後 pass を同じ SQL で示す。

### 9.1 parser / scope / converter

- `LIKE` / `NOT LIKE` AST は変更しない。
- APPLY 複数親 LIKE は専用 preflight に入り、通常 `updateToGetQuery` の一律緩和を起こさない。
- 通常 UPDATE / DELETE の LIKE は従来エラーを維持する。
- APPLY 親 KLIKE / NOT KLIKE は明示エラーを維持する。
- INSERT APPLY / UPSERT APPLY の既存経路に変化がない。

### 9.2 親選択

- `タイトル LIKE 'B44%'`: query は空、全候補取得後に一致親だけを PUT。
- `金額 > 0 AND タイトル LIKE 'B44%'`: 安全と判定された leaf だけ query に入り、元 WHERE 全体の再評価で対象を確定。
- `タイトル LIKE 'B44%' OR 金額 > 0`: OR の片側だけを押し下げず、全候補取得後に再評価。
- `NOT (タイトル LIKE 'B44%')`: NOT subtree を押し下げず、JS で正しく否定評価。
- `LIKE` / `NOT LIKE`、wildcard なし contains、`%`、`_`、空文字、Unicode を SELECT と同じ期待値で固定。
- バッチ変数を LIKE 右辺に使う場合、変数解決後の AST を評価する。
- 対象0件は PUT 0回、confirm/diagnostic の親件数0。
- 候補に「LIKE 不一致だが prefilter 一致」の親を混ぜ、PUT records に絶対に入らないことを検証する。

### 9.3 上限・安全性

- 候補101件・実対象1件・`dmlMaxRows=1`: 候補数では拒否せず、全候補評価後に1件を許可する。
- 候補101件・実対象2件・`dmlMaxRows=1`: 最初の PUT 前に拒否する。
- 候補が `maxRecords` を超える: 書き込み0件で `FetchAllLimitError`。
- native search abort: 書き込み0件で `SearchAbortedError`。
- post-image 検証エラー: 全対象の prepare 後、書き込み0件。
- confirm cancel: PUT 0件。
- 101対象: 100 + 1 chunk。後続失敗は既存 partial-success detail を維持する。
- revision conflict: 再取得・再評価・retry なし。

### 9.4 VALIDATE ONLY / EXPLAIN / surface

- `VALIDATE ONLY` の `validatedRows`、`validRows`、`guards.parentRows` は候補数でなく LIKE 後の実対象数。
- `VALIDATE ONLY` は records GET を行うが mutation API 0回。
- EXPLAIN は records API 0回を維持し、`parent WHERE: JS re-evaluation`、safe prefilter、candidate limit policy、KLIKE unsupported を表示する。
- CLI / plugin の confirm 親件数はフィルタ後件数。
- MCP の既存 APPLY mutation fail-closed は変更しない。

## 10. 決定点

| ID | 選択肢 | R1 推奨 | 理由 |
|---|---|---|---|
| D1 スコープ | APPLY 複数親 UPDATE のみ / 通常親 DML まで拡大 | **APPLY 複数親 UPDATE のみ** | snapshot prepare 経路に限定し、通常 DML の直接 push-down 契約を変えない |
| D2 LIKE 取得 | 全件 GET / safe prefilter + JS 全体再評価 | **safe prefilter + JS 全体再評価** | 現行は exact push-down。既存 primitive を使いつつ超集合性を維持できる |
| D3 candidate limit | `dmlMaxRows+1` を維持 / `maxRecords` まで完全取得 | **`maxRecords`・onLimit=error** | prefilter 候補数は実対象数ではない |
| D4 KLIKE | 同時対応 / 非対応継続 | **非対応継続** | 局所評価不能で applied-node 証明が別設計。B45 前例とも一致 |
| D5 SemVer | patch / minor | **minor** | 安全上拒否していた DML 受理範囲の利用者可視な拡大 |
| D6 投資判断 | 即実装 / 実需確認まで見送り | **v3.8.x は見送り、実需確認後に minor で実装** | 回避策あり。取得計画・上限・正しさの変更は小さくない |

## 11. スコープ外

- APPLY なしの UPDATE / DELETE における LIKE / KLIKE。
- KLIKE / NOT KLIKE の APPLY 親 WHERE 対応。
- kintone native `like` と kSQL LIKE の意味論統一。
- LIKE の JS evaluator 自体の意味論変更。
- INSERT / UPSERT APPLY のキー探索変更。
- 親 DELETE APPLY、`UPDATE ... FROM`、相関更新、CTE/一時表を親 selector にする拡張。
- `maxRecords` を超える巨大候補集合の streaming filter / cursor 化。
- B44 の chunk、revision、partial-success、post-image validation 契約の変更。
- MCP APPLY mutation gate の緩和。

