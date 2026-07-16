# 仕様案: 空 `SELECT *` の列復活（列スキーマのパイプライン伝播）

- 作成日: 2026-07-16
- 対象課題: [ksql_empty_select_columns_issue.md](ksql_empty_select_columns_issue.md) の残スコープ（§95 「スコープ外・別課題」）
- 先行修正: [ksql_empty_select_columns_fix_spec.md](ksql_empty_select_columns_fix_spec.md)（明示列＝v2.1.1 リリース済）
- ステータス: **R3 実装済み・codex 検証済み。v2.11.0 予定②（B1 の後・B8 の前）**
- 更新履歴:
  - 2026-07-16 R1: 初版
  - 2026-07-16 R2: codex レビュー反映（コードで裏取り）。①非インライン CTE のテストを必須化（`canInlineSingleCte` で単純 CTE は MaterializedTable 経路を踏まない）②混在ワイルドカードの semantics を修正＝`sourceColumns` 展開は**単独 `SELECT *` 限定**・混在は明示列のみ返す（現行 1 行以上と一致）・「先勝ち」表現を撤回③`PARENT_WILDCARD` を1つでも含む列リストは `sourceColumns` 展開を使わない。未決事項3点を確定（実アプリ bare `SELECT *`＝案ア／`MaterializedTable`＝execute.ts ローカル private／ストア＝単一構造体マップ）
  - 2026-07-16 R3: codex 再レビュー反映（コードで裏取り）。①§5 の非インライン CTE 成功例から「最終クエリが JOIN」を除外（JOIN は `sourceColumns` 非供給＝空列維持で受入条件と衝突）②§3.5 UNION は `executeUnion`（1580）に加え **temp/CTE が通る `executeQueryWithCte` の UNION 分岐（1666-1681）** も `leftResult.columns` ベースで自動波及・両者変更不要と明記③§2「自動的に正しい」を「実体化時点で `result.columns` が確定している複合クエリに限る」へ限定（空 bare `SELECT *`/空 JOIN で `result.columns` が空なら保存後も空＝対象外）
  - 2026-07-16 実装: `MaterializedTable` で temp/CTE の行と列を保持し、JOIN なし単一ソースの 0 行 `SELECT *` へ列を伝播。混在ワイルドカードは明示列のみ復元。全 1,145 単体/結合テスト＋25 CLI e2e 通過。
- 分担: Claude=仕様/観点、Codex=実装/テスト
- SemVer: バグ修正・後方互換（1 行以上の既存出力・明示列 0 行は不変）→ minor バンドル v2.11.0 の一部

---

## 1. 目的とスコープ

### 目的

**0 行の `SELECT *`（およびワイルドカードを含む列リスト）が、一時テーブル・CTE・UNION を経由しても出力列を失わない**ようにする。これにより、差分バッチの「空日」に `SELECT * FROM #empty_temp` を使うレシピが、`insertedCount=0` の no-op として正常完走する。

### 前提（v2.1.1 で既に解決済み）

明示列（`WILDCARD`/`PARENT_WILDCARD` を含まない）の 0 行 SELECT は、`project()` が AST から列を確定するため既に正しい（[ksql_empty_select_columns_fix_spec.md](ksql_empty_select_columns_fix_spec.md)）。したがって [課題 §14-21](ksql_empty_select_columns_issue.md) の実例（temp 作成・読み出しとも明示列）は **既に修正済み**。本仕様が扱うのは **読み出しが `SELECT *` の場合**に限られる。

### 対象（今回直す）

1. **単独 `SELECT * FROM #empty_temp`** / **単独 `SELECT * FROM empty_cte`**（JOIN なし・単一ソース）— 実体化時に確定した列スキーマ（`sourceColumns`）を保存し、0 行でもそれを返す（§3.4(a)）。**これが主目的**（差分バッチの空日）。
2. **混在ワイルドカード `SELECT *, extra FROM #temp`（0 行）** — `*` は `columns` に寄与させず（現行 1 行以上と同じ）、**明示列 `extra` だけを 0 行でも復活**させる（§3.4(b)）。現状 0 行で `columns=[]` になり明示列すら失う不整合を解消。`*` をスキーマ展開はしない（`sourceColumns` 非使用）。
3. **左辺が空 `SELECT *` の `UNION` / `UNION ALL`** — 1 の結果 `columns` が非空になることで [`executeUnion`](../../src/execute.ts#L1580) が自動的に直る（本仕様の追加変更なし・回帰テストで固定）。

### 対象外（本仕様では直さない）

- **実アプリ直参照の 0 行 `SELECT * FROM APP`** — 案ア確定（§3.6・対象外・メッセージ改善のみ）。
- **JOIN を伴う `SELECT *`（0 行）** — 複数ソースの列合成順が行依存で、0 行では確定不能。`sourceColumns` 非供給で現状維持（空列＋メッセージ）。
- **単独 `SELECT _p.*`（`PARENT_WILDCARD`）0 行** — サブテーブル親ショートカットは行依存。現状維持（空列）。混在に `_p.*` を含む場合は §3.4(c)（明示列のみ）。
- **混在 `SELECT *, extra` の `*` 分の列**（0 行でスキーマ展開して `*` を列に載せること）— 1 行以上でも `*` は `columns` に寄与しない現行仕様に合わせ、行わない。
- **実体化時点で `result.columns` が確定している複合クエリ**（JOIN・GROUP BY 等を含む CTE/temp で、実体化 SELECT が明示列 or 1 行以上の `SELECT *`）は、その `result.columns` をそのまま保存できる（追加設計不要）。**ただし実体化 SELECT 自体が空 bare `SELECT *`・空 JOIN 等で `result.columns` が空なら、保存後も空のまま**（今回の対象外＝連鎖の起点で列が確定しないケース）。

---

## 2. 現状（コード裏取り済み）

### 2.1 ストアが列スキーマを捨てている

一時テーブルも CTE も **行だけ**を保存する。

- 一時テーブル: `tempTables = new Map<string, ProcessRow[]>()`（[execute.ts:525](../../src/execute.ts#L525)）。実体化は `tempTables.set(resolvedStmt.name, result.rows)`（[execute.ts:677](../../src/execute.ts#L677)）。**`result.columns` を破棄**。
- CTE: `cteCache = new Map<string, ProcessRow[]>()`（[execute.ts:1636](../../src/execute.ts#L1636)）。`cteCache.set(cte.name, result.rows)`（[execute.ts:1648](../../src/execute.ts#L1648)）。**同上**。

### 2.2 読み出しは行だけを FULL_SCAN へ渡す

CTE/temp 参照は常に FULL_SCAN。メイン取得は `const rows = cteCache.get(stmt.from.cteName) ?? []`（[execute.ts:1741](../../src/execute.ts#L1741)）、JOIN も同様（[execute.ts:1761](../../src/execute.ts#L1761)）。行を `KintoneRecord` 化して `runFullScan` → `project` へ。**列スキーマは渡らない**。

### 2.3 `project()` の `SELECT *` は 0 行で空列

`project()` のワイルドカード分岐は行データからしか列を作れない（[process.ts:597-600](../../src/engine/process.ts#L597)）。

```ts
if (columns.length === 1 && columns[0].type === "WILDCARD") {
  const projected = rows.map((row) => stripParentShortcutColumns(row));
  const cols = projected.length > 0 ? Object.keys(projected[0]) : [];  // ← 0 行で []
  return { rows: projected, columns: cols };
}
```

混在ワイルドカード分岐（[process.ts:614-624](../../src/engine/process.ts#L614)）の `WILDCARD`/`PARENT_WILDCARD` も `rowIdx===0` 依存で 0 行では列が出ない。

→ 結果 `columns: []` が下流（INSERT/UPSERT 列数チェック [execute.ts:2382/3122](../../src/execute.ts#L2382)、UNION、CLI ヘッダ）を破綻させる。

---

## 3. 設計

### 3.1 実体化テーブル型（列スキーマ同梱）

**`src/execute.ts` 内の private interface として定義する**（codex レビュー確定）。`ProcessRow` は engine 側の型のため `src/types/ast.ts`（AST 層）へ置くと層が濁る。ストア 2 マップは execute.ts 内で生成・参照され、外部へは行データ（`KintoneRecord` 化）と `sourceColumns: string[]` しか渡らない（§3.3）ので、型を execute.ts に閉じられる。外へ出す必要が生じたら `src/engine/process.ts`。

```ts
// src/execute.ts 内（非 export の private interface）
/** CTE / 一時テーブルの実体化結果。行に加えて列スキーマを保持する。 */
interface MaterializedTable {
  readonly rows: ProcessRow[];
  /** 実体化 SELECT の出力列（順序保持）。0 行でも保持される。 */
  readonly columns: string[];
}
```

ストアの型を変更（**単一構造体マップ**・codex 確定）:

- `tempTables: Map<string, MaterializedTable>`
- `cteCache: Map<string, MaterializedTable>`

**波及**: この 2 つのマップを引き回す関数シグネチャ（`executeQueryWithCte` / `executeFullScanWithCte` / `runSelectLike` / `resolveSubqueries` / `evaluateScalarSubquery` / `executeWith` / `executeBatchStatement` ほか）の該当引数型を差し替える。get 側は `.get(name)?.rows ?? []` へ修正。**型変更を TypeScript コンパイラに拾わせて get サイトを漏れなく洗い出す**（`ProcessRow[]` → `MaterializedTable` の不一致がコンパイルエラーになる）。

> 代替案（不採用）: 行マップは現状維持し、`Map<string, string[]>` のスキーマ別マップを並走させる。get 側の変更は最小だが、全シグネチャに 2 本目のマップを追加することになり、「行と列がずれない」不変条件を型で保証しにくい。単一構造体マップ（採用案）の方が安全。

### 3.2 実体化時に列を保存

- 一時テーブル（[execute.ts:677](../../src/execute.ts#L677)）:
  ```ts
  tempTables.set(resolvedStmt.name, { rows: result.rows, columns: result.columns });
  ```
- CTE（[execute.ts:1648](../../src/execute.ts#L1648)）:
  ```ts
  cteCache.set(cte.name, { rows: result.rows, columns: result.columns });
  ```

`result.columns` は実体化 SELECT の `project()` 出力。明示列なら v2.1.1 で 0 行でも正しく埋まる。実体化元が `SELECT *`（実アプリ・1 行以上）なら実データ由来の列が入る。**実体化元が `SELECT *` かつ 0 行**の場合の列は §3.6 に従う（既定＝空。連鎖する空 `SELECT *` は最初の実アプリ参照で列が決まらない限り空のまま）。

### 3.3 読み出し時にスキーマを供給（FULL_SCAN・単一ソース）

`executeFullScanWithCte`（[execute.ts:1709-1806](../../src/execute.ts#L1709)）で、メインソースが CTE/temp のとき保存済みスキーマを取り出し、`runFullScan` へ **`sourceColumns`** として渡す。

```ts
let sourceColumns: string[] | null = null;
if (stmt.from.cteName != null) {
  const mat = cteCache.get(stmt.from.cteName);      // ここで tempTables も同一マップ
  sourceColumns = mat?.columns ?? null;
  tables.set(stmt.from.alias, (mat?.rows ?? []).map(processRowToKintoneRecord));
} else { /* 実アプリ取得（現状のまま） */ }
```

**JOIN があるときは `sourceColumns = null`**（列合成順が確定不能なため）。すなわち `sourceColumns` を使うのは `stmt.joins.length === 0` かつメインが単一 CTE/temp のときだけ。

`runFullScan` / `project` へ `sourceColumns?: string[]` を伝播（`runFullScan` の引数オブジェクトに追加 → `project(rows, columns, scalarCache, resolveFieldType, sourceColumns)`）。

### 3.4 `project()` のワイルドカード 0 行展開

**1 行以上の挙動は完全に不変**（実データ優先）。0 行のときだけ、列リストの形に応じて列を補う。`sourceColumns` 展開は**単独 `SELECT *` に限定**する（codex レビュー確定）。

#### (a) 単独 `SELECT *`（`columns.length === 1 && columns[0].type === "WILDCARD"`）

先頭の fast path（[process.ts:597](../../src/engine/process.ts#L597)）で `sourceColumns` を使う。1 行以上は現行どおり `Object.keys(row0)`。

```ts
const cols = projected.length > 0 ? Object.keys(projected[0]) : (sourceColumns ?? []);
```

#### (b) 混在（列リストに `WILDCARD`/`PARENT_WILDCARD` を含み、かつ他の列もある、または複数ワイルドカード）

**`sourceColumns` は使わない。0 行では「明示列（非ワイルドカード）だけ」を AST の列順で返す**（`computeOutputKeys` 相当をワイルドカード位置スキップで適用）。これは現行 1 行以上の挙動と一致する:

- 現行 [process.ts:614](../../src/engine/process.ts#L614) の `WILDCARD` は `Object.assign` するが **`orderedKeys` に push しない**＝`*` は `columns` に寄与しない。0 行でも同様に `*` は寄与させない。
- 値（1 行以上）は現行どおり **last-write**（`*` 展開後に同名の明示列があれば後着の明示列が上書き）。「先勝ち」は誤りだったため撤回。列リストは明示列の**出現順で重複排除**（同じ明示列名が2回現れたら先の位置を保持）。
- 現状 0 行の混在は `orderedKeys=[]`（行ループが回らず明示列すら失う）→ **本修正で明示列が 0 行でも復活**する（これが混在の主目的。`INSERT ... SELECT *, a FROM #empty` の列数不一致を解消）。

#### (c) `PARENT_WILDCARD`（`_p.*`）を含む列リスト

**`_p.*` を1つでも含む 0 行投影では `sourceColumns` 展開を使わない**（codex Finding 3・前者案採用）。`_p.` の親キーは行依存で `sourceColumns` に含まれないため、部分展開して列順・列集合が壊れるのを防ぐ。

- 単独 `SELECT _p.*`（0 行）: 対象外・現状どおり空列。
- 混在に `_p.*` を含む（例 `SELECT *, _p.*, extra`）: (b) と同じく**明示列のみ**返す（`*`・`_p.*` はともに 0 行で寄与なし）。1 行以上では現行どおり（`_p.*` は [process.ts:621](../../src/engine/process.ts#L621) で親キーを push）。0 行と 1 行以上で `_p.*` 分の列が非対称になるが、親スキーマが 0 行で取得不能なため許容（§受入で明示）。

> まとめ: `sourceColumns` を消費するのは **(a) 単独 `SELECT *`** のみ。(b)(c) は `sourceColumns` 非依存で明示列だけを 0 行でも確定する。`sourceColumns == null`（実アプリ bare `SELECT *`・JOIN あり）の (a) は現状どおり空列。

### 3.5 UNION は自動波及

UNION の実装は 2 経路あり、**どちらも `leftResult.columns`（`leftCols`）ベース**で結果列を決め、右辺行を左辺列へリマップする:

- 通常実行の `executeUnion`（[execute.ts:1580-1600](../../src/execute.ts#L1580)）。
- **temp/CTE を含む UNION が通る `executeQueryWithCte` の UNION 分岐**（[execute.ts:1666-1681](../../src/execute.ts#L1666)）。本仕様の受入テスト（`SELECT * FROM #empty UNION …`）は実際にこちらを通る。

左辺が `SELECT * FROM #empty`（§3.3-3.4 で列が復活）なら両分岐とも `leftCols` が非空になり、右辺値が正しく載る。**どちらも UNION 側のコード変更は不要**。両経路を回帰テストで固定する（§6）。

### 3.6 実アプリ直参照の 0 行 `SELECT *`（決定点）

`SELECT * FROM APP WHERE (0 件)` は保存スキーマがなく、列を得るには `getFields`（フィールド定義）が必要。

- **案ア（推奨・既定）＝対象外のまま**: 実アプリ bare `SELECT *` の 0 行は列不定を維持し、§5 のメッセージ改善で「0 行が原因」を示す。理由: (1) レシピ／差分バッチの実害は temp/CTE 経由（§3.1-3.4 で解決）で、実アプリ直 `SELECT *` を空ソース DML に使う実需は薄い。(2) 0 行のためだけに `getFields` の追加 API を撃つのは費用対効果が低い。
- **案イ（拡張・任意）＝ getFields で解決**: 単一アプリ・JOIN なしの 0 行 `SELECT *` に限り `getFields`（`getFieldTypeMap` と同じキャッシュ経路）で列名を取得し `sourceColumns` に流す。網羅性は上がるが API を 1 回増やす。JOIN は非対象。

**案ア確定**（codex レビュー・ユーザー判断）。v2.11.0 では実アプリ bare `SELECT *`（0 行）は対象外＋§5 のメッセージ改善維持。`getFields` 追加（案イ）は API コストと列順（JOIN 合成順）の別論点が増えるため、本 materialized pipeline からは切る。案イが必要なら別課題で起票。

---

## 4. 変更対象ファイル

| ファイル | 変更 |
|---|---|
| `src/execute.ts` | **`MaterializedTable` private interface を追加**（§3.1）、ストア 2 マップの型変更（525/1636 ほかシグネチャ）、実体化 set（677/1648）で columns 保存、FULL_SCAN 読み出し（1741/1761）を `?.rows` 化＋**JOIN なし単一 CTE/temp のときだけ** `sourceColumns` 供給、`runFullScan` へ伝播 |
| `src/engine/process.ts` | `project()` に `sourceColumns?: string[]` 引数、(a) 単独 `SELECT *` の 0 行分岐、(b)(c) 混在／`_p.*` の 0 行「明示列のみ」分岐、`runFullScan` の引数追加。**`MaterializedTable` 型は import しない**（受け取るのは `string[]` のみ） |
| `src/__tests__/execute.test.ts` / `process` テスト | §6 の回帰・境界を追加（**非インライン CTE を含む**） |
| `docs/ksql_batch_recipes.md` | 空日に `SELECT * FROM #temp` が no-op 完走する旨（回避策不要）を追記 |
| `docs/internal/ksql_empty_select_columns_issue.md` | 残スコープ解消を記録 |

コアの `runFullScan`/`project` 以外の実行計画・SIMPLE 経路は不変。

---

## 5. 受入条件

- [x] `SELECT * FROM #empty_temp`（実体化元＝明示列・0 行）が実体化時スキーマの列を返す。
- [x] **非インライン CTE の空 `SELECT *`**（下記のいずれか。単純 CTE は `canInlineSingleCte` でインライン化され MaterializedTable 経路を踏まないため必須 — codex Finding 1）。0 行で CTE 実体化スキーマの列を返す:
  - **CTE 本体が GROUP BY／`UNION`／JOIN 等で非 SIMPLE**、かつ実体化結果の列が確定するもの（§6 の GROUP BY 本体の例）。
  - **複数 CTE**。
  - **最終クエリが JOIN なしの非インライン条件を持つもの**（例: 最終側に GROUP BY／DISTINCT）。
  - ※「最終クエリが JOIN」は成功例から除外する。JOIN 時は `sourceColumns` を供給せず空列を維持する仕様（§3.3・JOIN 非対象の受入条件）と衝突するため。
- [x] `UPSERT INTO x (a,b) SELECT * FROM #empty_temp ON DUPLICATE (a)` が `inserted=0/updated=0` の no-op（**POST/PUT 未呼び出し**）。
- [x] `INSERT INTO x (a,b) SELECT * FROM #empty_temp` が `inserted=0`（**POST 未呼び出し**）。
- [x] **混在 `SELECT *, extra FROM #empty_temp`（0 行）は明示列 `['extra']` のみを返す**（`*` は列に寄与しない＝1 行以上と一致・§3.4(b)）。現状の `columns=[]`（明示列すら失う）からの回復が主目的。
- [x] **1 行以上の `SELECT *, a` は `columns` が現行どおり（`['a']`・`*` は寄与しない）で不変**（回帰の要・codex Finding 2）。
- [x] 左辺が空 `SELECT *` の `UNION ALL` / `UNION` で結果列が左辺スキーマ由来、右辺値が正しく載る（`deduplicateRows` も `leftCols` で機能）。
- [x] **1 行以上の `SELECT *`（temp/CTE/実アプリ）は列・列順・値ともに不変**（回帰の要）。
- [x] **JOIN を伴う 0 行 `SELECT *` は現状どおり**（`sourceColumns` 非供給＝空列＋メッセージ・挙動不変）。
- [x] **`_p.*` を含む列リスト（0 行）は `sourceColumns` 展開を使わない**（単独 `_p.*`＝空列／混在＝明示列のみ・codex Finding 3）。
- [x] `sourceColumns == null` の 0 行単独 `SELECT *` は従来どおり空列（実アプリ bare `SELECT *`・案ア）。
- [x] メッセージ改善: 列数不一致 かつ `columns.length===0` かつ `rows.length===0` のときだけ「0 行が原因」を示す（v2.1.1 の条件を踏襲・実アプリ bare `SELECT *` 救済）。
- [x] ストア型変更後も既存のバッチ／CTE／スカラーサブクエリ／`IN (SELECT … FROM #temp)` が回帰なし。

## 6. テスト計画（修正前 fail → 修正後 pass）

### 単体（`project()`）
- (a) `project([], [WILDCARD], _, _, ['a','b'])` → `columns===['a','b']`、`rows===[]`。
- (a) `sourceColumns` 無し（`undefined`）の 0 行 `[WILDCARD]` → `columns===[]`（対象外維持）。
- (b) 混在 `[WILDCARD, FIELD extra]` × 0 行（`sourceColumns` 有無に関わらず）→ `columns===['extra']`（`*` は寄与しない）。
- (b) 重複: 混在 `[FIELD a, WILDCARD, FIELD a]` × 0 行 → `columns===['a']`（明示列を出現順で重複排除）。
- (c) `[WILDCARD, PARENT_WILDCARD, FIELD extra]` × 0 行 → `columns===['extra']`（`*`・`_p.*` とも寄与なし・`sourceColumns` 非使用）。
- (c) 単独 `[PARENT_WILDCARD]` × 0 行 → `columns===[]`（対象外維持）。
- **回帰（Finding 2）**: 1 行以上の `[WILDCARD, FIELD a]` で `columns===['a']`（現行）・値は last-write（`a` は FIELD 値）を修正前後で完全一致。
- **回帰**: 1 行以上の単独 `[WILDCARD]`（temp/実データ）で修正前後の `{rows,columns}` が完全一致。

### 結合（execute 経由・書き込み API モック）
- 空 temp `SELECT *`: `CREATE TEMP TABLE #t AS SELECT a,b FROM APP WHERE (0件); UPSERT INTO x (a,b) SELECT * FROM #t ON DUPLICATE (a)` → `inserted=0/updated=0`・**POST/PUT 未呼び出し**。
- **非インライン CTE の空 `SELECT *`（Finding 1・必須）**: 例 `WITH c AS (SELECT a, COUNT(*) cnt FROM APP WHERE (0件) GROUP BY a) SELECT * FROM c`（本体 GROUP BY＝FULL_SCAN＝非インライン）→ 0 行で `columns` が CTE スキーマ（`['a','cnt']`）。**併せて `canInlineSingleCte` が false になることをコメントで固定**（単純 CTE との差を明示）。
- 参考（インライン CTE・別経路）: `WITH c AS (SELECT a,b FROM APP WHERE (0件)) SELECT * FROM c` は `canInlineSingleCte=true` で `SELECT a,b` に展開され、v2.1.1 の明示列経路で既に列が出る（MaterializedTable 経路ではない）ことを1本で確認。
- 左辺空 UNION（両経路・両演算子）:
  - **通常経路（`executeUnion` 1580）は既存テストを流用**: [execute.test.ts:2158-2176](../../src/__tests__/execute.test.ts#L2158) の `test.each`（`UNION`/`UNION ALL`）が、空の明示列左辺 `SELECT a FROM APP100`（`recordsByApp: { 100: [] }`）で `columns===['a']`・右辺値の `a` へのリマップを検証済み。追加不要。
  - **temp/CTE 経路（`executeQueryWithCte` の UNION 分岐 1666-1681）を新規追加**: `SELECT * FROM #empty UNION ALL SELECT b FROM APP2` と `… UNION …` → 結果列＝#empty スキーマ、右辺値が `leftCols` へ載る。**本仕様で追加すべきはこちら**（左辺が temp/CTE の `SELECT *`）。
- **JOIN 非対象**: `SELECT * FROM #empty t JOIN APP a ON ...`（0 行）→ `sourceColumns` 非供給で現状どおり（空列）を固定。
- 1 行以上の `SELECT * FROM #temp` 回帰。

## 7. リスク・非対象

- **リスク（列と値のずれ）**: `sourceColumns` で列を出すが行が空なので値ずれは起きない（`rows===[]`）。1 行以上は `sourceColumns` を使わない（実データ優先）ため不変。混在の値は 1 行以上で現行どおり last-write（`*` 展開後に同名の明示列が上書き）を維持。
- **リスク（ストア型変更の広域波及）**: get 側の `?.rows` 化漏れが実行時 `undefined` を招く可能性 → 型変更で TS コンパイルエラーとして検出できる（`ProcessRow[]` → `MaterializedTable` の不一致）。全 get サイトを型で洗い出す。
- **非対象**: 実アプリ bare `SELECT *`（案ア）・JOIN 0 行 `SELECT *`・単独 `_p.*` 0 行・混在の `*`/`_p.*` 分の列展開。

## 8. 確定事項（R2・codex レビューで解決済み）

1. **実アプリ bare `SELECT *`（0 行）＝案ア確定**。対象外＋メッセージ改善維持。`getFields`（案イ）は API コスト・列順の別論点のため本仕様から切る（必要なら別課題）。
2. **`MaterializedTable` の置き場所＝`src/execute.ts` 内の private interface**。`ProcessRow` は engine 型ゆえ `types/ast.ts` は避ける。`project()` へ渡すのは `string[]`（`sourceColumns`）のみなので process.ts は `MaterializedTable` を import しない。
3. **ストア型変更＝単一構造体マップ**。型変更をコンパイラに拾わせて get サイトを網羅（`?.rows` 化）。

### 残る実装時の確認（コードで確定）
- ストア 2 マップ（`tempTables`/`cteCache`）を引き回す全関数が `src/execute.ts` 内に閉じているか（閉じていれば `MaterializedTable` を execute.ts ローカルに保てる）。外部へ渡る箇所があれば型の置き場所を `process.ts` へ再検討。
