# SQL 実行パフォーマンス改善 実装計画

[perf-sql-execution-improvements.md](./perf-sql-execution-improvements.md) の実装推奨ロードマップを、PR 単位の作業計画に落としたもの。項目番号（A-1 等)は提案ドキュメントに対応する。

## 全体方針

- **PR は 1 目的 1 PR**。挙動を固定する characterization テストを先に入れ、最適化はその後のコミットで行う
- 各 PR の完了条件は「`npm test` 全通過 + 項目ごとの完了条件」。MCP に触れる PR は `npm run mcp:verify` も実行する
- PR-0（計測基盤）を最初に入れ、以降の PR は説明欄に**改善前後の API 呼び出し回数**を記載する

### PR 一覧（実装順）

| PR | 項目 | 内容 |
|----|------|------|
| PR-0 | 計測基盤 | ExecuteResult への metrics 伝搬 |
| PR-1 | A-2 | CLI / MCP の `fetchParallel` 配線 |
| PR-2 | C-1 | fetchAll の `order by $id asc` 常時付与 |
| PR-3 | B-2/B-3/B-5 | JS 小改善まとめ |
| PR-4 | A-4 | スカラーサブクエリ重複排除 + 並列化 |
| PR-5 | A-1 | UPSERT の N+1 解消 |
| PR-6 | A-3 | サブクエリ / UNION の並列化 |
| PR-7 | A-5 | フィールド定義取得のオーバーラップ / スキップ |
| PR-8 | A-6 小修正 | `parents.find` の Map 化・サブテーブル INSERT の options 尊重 |
| PR-9 | B-1 | ORDER BY ソートキー事前計算 |
| PR-10 | B-6 | DISTINCT キー生成最適化 |

フェーズ 3 相当（A-7 / A-8 / A-6 絞り込み本体 / B-4 / B-7）は PR-0 の計測結果を見てから別途計画する（末尾の設計メモ参照）。

---

## PR-0: 計測基盤

**対象**: [execute.ts](../src/execute.ts)、[sharedPlanner.ts](../src/core/optimization/sharedPlanner.ts)

**変更内容**:

1. `execute()` 冒頭で `KintoneClient` をカウント付きラッパーで包む（`fetchAll` 側を触らず、SIMPLE モードの単発 GET も含めて全 API 呼び出しを 1 箇所で計測できる）:

   ```ts
   interface ExecuteMetrics {
     getCalls: number;      // GET /k/v1/records.json
     postCalls: number;     // POST /k/v1/records.json
     putCalls: number;      // PUT /k/v1/records.json
     deleteCalls: number;   // DELETE /k/v1/records.json
     fieldCalls: number;    // GET /k/v1/app/form/fields.json（validation / 選択肢順 / DESCRIBE）
     appsCalls: number;     // GET /k/v1/apps.json（SHOW APPS）
     fetchedRows: number;
     elapsedMs: number;
   }
   ```

   `getFields` / `getApps` もラッパーで数える。SELECT はレコード GET の前に field validation・選択肢順取得で `getFields` を呼ぶため、これを含めないと「全 API 呼び出し」にならない（A-5 の効果計測にも必要）

2. `SelectResult` / `InsertResult` / `UpdateResult` / `DeleteResult` / `UpsertResult` / `ReorderResult` に `metrics?: ExecuteMetrics` を追加（optional なので既存呼び出し元は無変更で通る）
3. CLI は `--debug` 時、MCP はレスポンスのメタ情報、プラグイン UI は結果フッターに表示（表示側は別 PR に分けてもよい）
4. `SharedFetchMetrics`（[sharedPlanner.ts:11](../src/core/optimization/sharedPlanner.ts#L11)）は現状呼び出し側で捨てられているが、PR-0 では**触らない**（計測基盤の追加に集中し、差分を最小にする）。ラッパー方式で計測が一元化されたあと、別の整理 PR で削除を検討する

**テスト**: [execute.test.ts](../src/__tests__/execute.test.ts) に「SIMPLE SELECT で getCalls=1」「10,001 件 FULL_SCAN で getCalls=ページ数」等の assert を追加。

**完了条件**: すべての `ExecuteResult` に metrics が入り、既存テストが無変更で通る。

---

## PR-1: A-2 — CLI / MCP の `fetchParallel` 配線

**デフォルト値の方針**: 3（許容範囲 1〜10、範囲外は入力エラー）。プラグイン UI の実績値 5 より控えめに始め、レート制限の問題がなければ引き上げる。

### CLI 側

**対象**: [cli/index.ts](../src/cli/index.ts)、[node/config.ts](../src/node/config.ts)、README

1. `CliArgs`（[cli/index.ts:146](../src/cli/index.ts#L146) 付近）に `fetchParallel: number | null` を追加し、`--max-records` のパース（[cli/index.ts:314](../src/cli/index.ts#L314) 付近）と同形式で `--fetch-parallel` を追加。範囲外（1〜10 以外）は **`ArgumentError` でエラー**にする — MCP 側の `z.number().int().min(1).max(10)` と揃え、クランプの暗黙挙動を作らない
2. 解決ロジック（[cli/index.ts:1275](../src/cli/index.ts#L1275) 付近）に追加:

   ```ts
   const fetchParallel = args.fetchParallel ?? envInt("KSQL_FETCH_PARALLEL") ?? profile.query?.fetchParallel ?? 3;
   ```

3. `execute()` 呼び出し（[cli/index.ts:1598](../src/cli/index.ts#L1598)）に `fetchParallel` を渡す
4. console モードの子プロセス引数引き継ぎ（[cli/index.ts:753](../src/cli/index.ts#L753) 付近の `pushOpt` 群）に `--fetch-parallel` を追加
5. `KsqlProfileConfig.query`（[node/config.ts:26](../src/node/config.ts#L26)）に `fetchParallel?: number` を追加
6. **`HELP_TEXT` と README の同期**: [help_sync.test.ts](../src/cli/__tests__/help_sync.test.ts) が README の `BEGIN_HELP_SYNC` セクションと `HELP_TEXT` の一致を検証しているため、両方を更新しないとテストが落ちる

### MCP 側

**対象**: [mcp/schemas.ts](../src/mcp/schemas.ts)、[node/runtime.ts](../src/node/runtime.ts)、[mcp/tools.ts](../src/mcp/tools.ts)

1. schemas.ts に共通入力を追加し、5 スキーマへ配線:

   ```ts
   const fetchParallel = z.number().int().min(1).max(10).optional();
   // queryInputSchema / mutateInputSchema / describeAppInputSchema
   // / showAppsInputSchema / runSavedQueryInputSchema に追加
   ```

2. `CreateKsqlRuntimeInput`（[runtime.ts:26](../src/node/runtime.ts#L26)）と `KsqlRuntime`（[runtime.ts:37](../src/node/runtime.ts#L37)）に `fetchParallel` を追加。解決は `maxRecords` と同形式（[runtime.ts:70-73](../src/node/runtime.ts#L70-L73)）:

   ```ts
   const fetchParallel = input.fetchParallel
     ?? envInt("KSQL_FETCH_PARALLEL")
     ?? profile.query?.fetchParallel
     ?? 3;
   ```

3. tools.ts の各 `executeSql()` 呼び出し（[tools.ts:313](../src/mcp/tools.ts#L313) / [331](../src/mcp/tools.ts#L331) / [366](../src/mcp/tools.ts#L366) ほか）に `fetchParallel: runtime.fetchParallel` を追加
4. **`runSavedQuery` の明示転送 2 箇所**: read-only 経路の `query({...})`（[tools.ts:465-471](../src/mcp/tools.ts#L465-L471)）と DML 経路の `mutate({...})`（[tools.ts:481-488](../src/mcp/tools.ts#L481-L488)）の転送リストに `fetchParallel: input.fetchParallel` を追加

**テスト**:

- [tools.test.ts:138](../src/mcp/__tests__/tools.test.ts#L138) の「maxRecords/onLimit を execute options にマップする」テストと同形式で `fetchParallel` のマッピングを検証
- saved query の read-only / DML 両経路で `fetchParallel` が伝搬することを検証（現行テストは DML 経路の転送漏れを検出できないため必須）
- CLI の引数パース・環境変数・profile の優先順位テスト

**完了条件**: CLI / MCP の全 SELECT・DML 経路で `ExecuteOptions.fetchParallel` に値が渡ること。`npm run mcp:verify` 通過。

**リスク**: kintone の同時リクエスト制限。デフォルト 3 + 入力上限 10 で緩和。問題発生時は profile 設定で 1 に戻せる。

---

## PR-2: C-1 — fetchAll の `order by $id asc` 常時付与

**対象**: [api/fetchAll.ts](../src/api/fetchAll.ts)、[fetchAll.test.ts](../src/api/__tests__/fetchAll.test.ts)、CHANGELOG / README

**事前確認（実装前に必須）**: `fetchAll` / `fetchRecordsForSharedPlan` の全呼び出し箇所で、渡している `query` に `order by` / `limit` が含まれないことを確認する。現状確認済みの範囲では `executeSimpleSelect` は `whereToKintone(stmt.where)` のみ、FULL_SCAN 経路は WHERE 条件のみだが、`selectToFetchAllParams` の出力は要確認。防御として `buildCursorQuery` に「query に `order by` / `limit` が混入していたら例外」の assert を足すとよいが、**単純な substring 判定は文字列リテラルで誤検知する**（例: `メモ like "order by"`、値に `limit` を含む条件）。入れる場合は「クォート（`"..."`、`\"` エスケープ考慮）の外側にあるキーワードのみ検出」する軽量スキャナにし、誤検知ケースのテストを添える。スキャナのコストが見合わないと判断したら、防御 assert は省いて呼び出し箇所の目視確認 + 呼び出し側テストに留める。

**変更内容**:

```ts
export function buildCursorQuery(baseQuery: string, cursorId: number): string {
  const base = baseQuery.trimEnd();
  if (cursorId > 0) {
    // base が "A or B" のとき "A or (B and $id > N)" にならないよう必ず括弧で包む
    const cursor = `$id > ${cursorId} order by $id asc`;
    return base ? `(${base}) and ${cursor}` : cursor;
  }
  return base ? `${base} order by $id asc` : `order by $id asc`;
}
```

なお現行実装（`${base} and ${cursor}`）にも base がトップレベル `or` を含む場合に条件の意味が変わる**潜在バグ**があり（`whereToKintone` は `A or B` を生成し得る）、本 PR の括弧付与で同時に解消される。この点もテストで固定する（`base = 'A = "1" or B = "2"'` + カーソルのケース）。

**テスト**: [fetchAll.test.ts:34-45](../src/api/__tests__/fetchAll.test.ts#L34-L45) の `cursorId=0` 期待値を order 付きに更新。クエリ文字列を assert している他のテスト（[fetchAll.test.ts:197](../src/api/__tests__/fetchAll.test.ts#L197) 等、execute.test.ts にもあれば）を一括更新。加えて「10,000 件超 + カーソル切替で重複しない」シナリオテストを追加。

**互換性**:

- `ORDER BY` なし SELECT の表示順が ID 降順 → 昇順に変わる。CHANGELOG に明記し、リリースノートで案内する
- **UPSERT の更新対象を暗黙に変えない**: `order by $id asc` 化により UPSERT 既存判定の `existing[0]` が「最大 $id（最新）」→「最小 $id（最古）」に変わってしまう。DML の更新対象変更はページング安定化 PR に含めるべきでないため、本 PR で `executeUpsert` / `executeUpsertSelect` 側を**結果から最大 $id を明示選択**するよう先に修正して現行挙動を維持し、テストで固定する（挙動を変えるかどうかの判断は PR-5 に委ねる）

**完了条件**: 全ページングクエリに `order by $id asc` が入り、順序依存の取りこぼしテストが通る。

---

## PR-3: B-2 / B-3 / B-5 — JS 小改善まとめ

**対象**: [engine/evalWhere.ts](../src/engine/evalWhere.ts)、[engine/process.ts](../src/engine/process.ts)

1. **B-2**: `matchLike`（[evalWhere.ts:237](../src/engine/evalWhere.ts#L237)）にモジュールレベルの `Map<string, RegExp>` キャッシュを追加。上限 200 件程度、超えたら `clear()`（LRU は不要）
2. **B-3**: `applyJoin` の LEFT JOIN 非マッチ時の `emptyRight` 生成（[process.ts:147-152](../src/engine/process.ts#L147-L152)）をループ外へ。RIGHT JOIN 側（[process.ts:111-112](../src/engine/process.ts#L111-L112)）と同形にする
3. **B-5**: `evalAggregate` の `Math.max(...nums)` / `Math.min(...nums)`（[process.ts:278-279](../src/engine/process.ts#L278-L279)）をループに置換

**テスト**: 既存 [process.test.ts](../src/engine/__tests__/process.test.ts) が挙動固定になっている。B-5 用に「150,000 要素の MAX/MIN が RangeError にならない」テストを追加。

**完了条件**: 既存テスト無変更で通過 + B-5 の大量要素テスト追加。

---

## PR-4: A-4 — スカラーサブクエリの重複排除 + 並列化

**対象**: [execute.ts:2061-2078](../src/execute.ts#L2061-L2078) `resolveScalarColumns`

**変更内容**:

```ts
const byQuery = new Map<string, Promise<string>>();
for (const [i, col] of columns.entries()) {
  if (col.type !== "SCALAR_SUBQUERY_COL") continue;
  const key = JSON.stringify(col.query);
  let p = byQuery.get(key);
  if (!p) {
    p = executeSelect(col.query, client, options, cacheContext).then(/* 1行1列検証して値を返す */);
    byQuery.set(key, p);
  }
  pending.push([i, p]);
}
// Promise.all で解決して Map<number, string> を構築
```

行数 0 / 複数行のエラーメッセージは現行を維持する。

**テスト**: モッククライアントで `getRecords` 呼び出し回数をカウントし、「同一サブクエリ 2 列で GET 1 回」「異なるサブクエリ 2 列は並列実行でも結果が正しい」を検証。

**完了条件**: doc コメント「同一クエリは 1 回だけ実行」と実装が一致する。

---

## PR-5: A-1 — UPSERT / UPSERT SELECT の N+1 解消

**対象**: [execute.ts:1352-1432](../src/execute.ts#L1352-L1432) `executeUpsert`、[execute.ts:1856-1937](../src/execute.ts#L1856-L1937) `executeUpsertSelect`

### Step 1: characterization テスト（先行コミット）

現行挙動をテストで固定してから最適化する:

- **複数ヒット時**: 仕様は「最大 $id（最新）を更新」— PR-2 で明示選択に修正しテスト固定済みの現行挙動。本 PR のチャンク取得側でも**キーごとに最大 $id を選ぶ**ことで維持する。挙動を変えたい場合（最古優先等）は本 PR で明示的に仕様変更として扱い、CHANGELOG に記載する
- **同一 UPSERT 入力内の重複キー**: 現行は行ごとに独立判定のため、既存なし × 同キー 2 行は**両方 INSERT され重複が生まれる**。この挙動を維持するか修正するかを Step 1 で決める（修正するなら「後勝ちで 1 件に統合」を推奨、CHANGELOG 記載）
- **値の quote / エスケープ**: `"` を含むキー値の検索が現行と一致すること

### Step 2: 一括解決の実装

1. 共通ヘルパー `resolveUpsertTargets(appId, keyFields, keyValuesPerRow, client, options): Map<複合キー文字列, number /* $id */>` を追加
2. **単一キー**: 重複除去したキー値を `sqlQuote`（[execute.ts:860](../src/execute.ts#L860)）で quote し、`JOIN_IN_CHUNK_SIZE`（50）単位で `key in (...)` チャンク取得。取得 fields は `["$id", ...keyFields]`。キーごとに**最大 $id を採用**（PR-2 で固定した仕様と一致）
3. **複合キー**: 第 1 キーで `in (...)` 絞り込み後、残りキーはクライアント側照合。第 1 キーは「重複値が最も少ない列」等の選定はせず、`keyFields[0]` 固定でよい（過剰設計を避ける）
4. `executeUpsert` / `executeUpsertSelect` の行ループから GET を排除し、Map 参照に置換。以降の確認ダイアログ・POST/PUT バッチ処理は現行のまま
5. キー値が空文字の行は現行どおり `key = ""` 検索相当の挙動を維持（チャンクから除外して個別判定 or 空文字も in に含める — kintone クエリの空文字 in の挙動を確認して決める）

**留意**: kintone の `in` 演算子はフィールド型によって使えない型（リッチテキスト等）がある。実機 smoke（`npm run mcp:kintone-smoke` 相当）で数値・文字列・日付キーを確認する。使えない型は行ごと GET へフォールバック。

**テスト**: モックで「1,000 行・単一キー → GET 20 回」「複合キー」「重複キー」「複数ヒット」「quote」の各ケース。

**完了条件**: 既存判定 GET が ⌈ユニークキー数/50⌉ 回になり、Step 1 の characterization テストが（意図した変更以外）そのまま通る。

---

## PR-6: A-3 — サブクエリ / UNION の並列化

**対象**: [execute.ts:1993-2032](../src/execute.ts#L1993-L2032) `resolveSubqueries`、[execute.ts:507-511](../src/execute.ts#L507-L511) `executeUnion`

1. `resolveSubqueries` を「木を走査してサブクエリノードを収集 → `Promise.all` で実行 → `resolved` を書き込み」の 2 段階に分割。WHERE と HAVING の 2 回呼び出し（[execute.ts:387-388](../src/execute.ts#L387-L388)）も 1 つの `Promise.all` にまとめる
2. `executeUnion` の左辺・右辺を `Promise.all` で並列実行（結果の結合順は現行どおり左→右を維持）

**挙動差の注意**: 直列では最初のサブクエリのエラーだけが投げられるが、並列では `Promise.all` の最初の reject が伝播する。エラーメッセージ自体は変わらないため許容とする（テストで確認）。

**完了条件**: サブクエリ 3 個のクエリで実行がオーバーラップすること（モックの呼び出しタイミングで検証）。

---

## PR-7: A-5 — フィールド定義取得のオーバーラップ / スキップ

**対象**: [execute.ts:282-333](../src/execute.ts#L282-L333) `executeSimpleSelect`、[execute.ts:376-494](../src/execute.ts#L376-L494) `executeFullScanSelect`

1. **ORDER BY なし時のスキップ（全経路共通）**: `stmt.orderBy.length === 0` なら `buildOptionOrdersForSelect` / `buildSortKindsForSelect` をスキップ（`applyOrderBy` が即 return するため取得自体が無駄）。対象は SIMPLE（[execute.ts:325-327](../src/execute.ts#L325-L327)）だけでなく、**FULL_SCAN（[execute.ts:487-488](../src/execute.ts#L487-L488)）と CTE 参照経路の `executeFullScanWithCte`（[execute.ts:799-800](../src/execute.ts#L799-L800)）も同様**。3 箇所で同じ条件になるため、`buildOrderByMetaForSelect(stmt, ...)` のような共通ヘルパー（orderBy 空なら空 Map を即返す）に寄せる
2. **並列化 / オーバーラップ**: orderBy がある場合、SIMPLE では 2 つを `Promise.all` に。FULL_SCAN / CTE 経路では `resolveScalarColumns` / `buildOptionOrdersForSelect` / `buildSortKindsForSelect` の Promise をメインフェッチ開始直後に生成し、`runFullScan` 直前で `await Promise.all`。`resolveSubqueries` は WHERE プッシュダウン計算より前に必要なので現行位置を維持

**完了条件**: ORDER BY なしの SIMPLE / FULL_SCAN / CTE 参照 SELECT（キャッシュ未ヒット時）のいずれでも、**optionOrders / sortKinds 由来の追加 field GET が発生しない**こと。`validateSelectFieldCodes` 由来の `getFields` は残る（フィールド指定のある SELECT では validation が先に呼ぶ）ため、検証は `SELECT *`（validation がフィールドを収集しない）で `fieldCalls = 0` を確認するか、`getFieldsCached` の呼び出し元単位でモック検証する。

---

## PR-8: A-6 小修正 — Map 化と options 尊重

**対象**: [execute.ts](../src/execute.ts) サブテーブル DML 各関数

1. `executeUpdateSubtable`（[1553](../src/execute.ts#L1553)）/ `executeDeleteSubtable`（[1605](../src/execute.ts#L1605)）/ `executeReorder`（[1794](../src/execute.ts#L1794)）の `parents.find(...)` を、`executeInsertSubtable` と同じ `Map<pid, parent>` 方式に統一
2. `executeInsertSubtable`（[1464](../src/execute.ts#L1464)）のハードコード `{ maxRecords: 10_000, parallel: 1 }` を `options.maxRecords ?? 10_000` / `options.fetchParallel ?? 1` に変更（シグネチャに `options: ExecuteOptions` を追加し、呼び出し元 `executeInsert` から伝搬）

**完了条件**: 既存のサブテーブル DML テストが通過し、`executeInsertSubtable` が options を尊重する。

---

## PR-9: B-1 — ORDER BY ソートキー事前計算

**対象**: [process.ts:382-489](../src/engine/process.ts#L382-L489) `applyOrderBy`

decorate–sort–undecorate 方式に変更:

```ts
const decorated = rows.map((row) => ({
  row,
  keys: orderBy.map(({ key }) => {
    const s = evalOrderKey(key, row);
    const n = Number(s);
    return { s, n, isNum: !Number.isNaN(n) };
  }),
}));
decorated.sort((a, b) => { /* keys[i] 同士を compareOrderValues 相当で比較 */ });
```

**注意**: 現行の `compareAuto` は「両辺とも数値のときだけ数値比較」というペア依存ロジックのため、前計算では文字列値・数値値・数値可否フラグの 3 点を保持し、比較時に `a.isNum && b.isNum` を判定して同一挙動を維持する。optionOrders / sortKinds の分岐も現行どおり。

**テスト**: 既存の ORDER BY テスト（数値/文字列混在、選択肢順、式キー）が無変更で通ること。

**完了条件**: 式評価回数が行数 × キー数（1 回ずつ）になり、既存テスト全通過。

---

## PR-10: B-6 — DISTINCT キー生成最適化

**対象**: [process.ts:342-373](../src/engine/process.ts#L342-L373) `applyDistinct` / `buildDistinctKey`

1. **テスト先行**: キー同一性の前提を固定するテストを追加
   - 値に `\x00` を含む行同士が誤って同一視されないこと（delimiter 衝突）
   - `SELECT DISTINCT *` で行によってキー集合が異なるケース（LEFT JOIN の空埋め行等）の挙動
2. 列リストを**呼び出しごとに 1 回だけ**確定し、行ループでは values の結合のみ行う。FIELD 列なら列名リスト、WILDCARD の場合は**全行のキー集合の union** を事前に 1 パスで確定する（初回行だけを使うと、後続行にのみ存在するキーが無視されて誤重複する）。さらに現行の `Object.entries(row)` は「キーが存在しない」と「キーが空文字」を区別するため、union キーで値を並べる際は欠損を `null`、空文字を `""` としてエンコードし（`JSON.stringify` なら両者は区別される）、この区別を維持する
3. delimiter 衝突対策として、単純 join ではなく `JSON.stringify(values)` を使う（`deduplicateRows`（[execute.ts:533-541](../src/execute.ts#L533-L541)）の `\0` join にも同じ衝突があるため、共通ヘルパーに寄せて両方直す）

**完了条件**: 10,000 行 DISTINCT のキー生成が「行ごとの entries + sort」なしで動き、衝突テストが通る。

---

## フェーズ 3 設計メモ（計測後に着手判断）

- **A-8（LIMIT>500 打ち切り）— v2.11.0 実装済み**: `ORDER BY` 空・`LIMIT` 明示・`offset + limit <= maxRecords`・KLIKE なしの SIMPLE SELECT に限定し、`fetchAll.stopAfter` で必要件数に達した時点で正常終了する。`ORDER BY` 付きの押し下げやフィールド定義判定は不要な安全サブセットへ絞った。詳細は [B8 仕様](internal/ksql_limit_over_500_fetch_truncation_spec.md)
- **A-7（bulkRequest）**: `KintoneClient` に `bulkRequest?: (requests) => Promise<...>` を optional 追加し、実装があるクライアントのみ利用。全成功/全失敗の挙動差があるため `ExecuteOptions.useBulkRequest`（デフォルト off）のオプトイン。エラー時のメッセージ（何件目のバッチで失敗したか）の再設計が必要
- **A-6 絞り込み本体**: `extractTableCondition` の親フィールド（`_p.` プレフィックス）版を実装し、サブテーブル DML の WHERE から親条件をプッシュダウン。`_pid in (...)` は `$id in (...)` に変換
- **B-4（flatten 二重キー削減）**: `resolveFieldRef` に「非修飾名 → alias 付きキー」の逆引きを追加してから flatten の二重書き込みを外す。ProcessRow を参照する全箇所（evalWhere / evalFunc / project / groupBy / orderBy）の網羅テストが前提。ヒープスナップショットで効果を計測してから
- **B-7（GROUP BY 1 パス化)**: `maxRecords` 引き上げ計画が出た時点で再評価

## 検証コマンド

| 対象 | コマンド |
|------|---------|
| 単体テスト | `npm test` |
| MCP ビルド + smoke | `npm run mcp:verify` |
| 実機 smoke（kintone 接続） | `npm run mcp:kintone-smoke` |
| プラグインビルド | `npm run build:plugin` |

実機確認は `sample-app/` のアプリ定義を使い、PR-0 の metrics 出力で改善前後の API 呼び出し回数を記録して PR 説明欄に貼る。
