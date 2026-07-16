# 仕様案: 空 `SELECT *` の列復活（列スキーマのパイプライン伝播）

- 作成日: 2026-07-16
- 対象課題: [ksql_empty_select_columns_issue.md](ksql_empty_select_columns_issue.md) の残スコープ（§95 「スコープ外・別課題」）
- 先行修正: [ksql_empty_select_columns_fix_spec.md](ksql_empty_select_columns_fix_spec.md)（明示列＝v2.1.1 リリース済）
- ステータス: **仕様案 R1（codex レビュー前）。v2.11.0 予定②（B1 の後・B8 の前）**
- 分担: Claude=仕様/観点、Codex=実装/テスト
- SemVer: バグ修正・後方互換（1 行以上の既存出力・明示列 0 行は不変）→ minor バンドル v2.11.0 の一部

---

## 1. 目的とスコープ

### 目的

**0 行の `SELECT *`（およびワイルドカードを含む列リスト）が、一時テーブル・CTE・UNION を経由しても出力列を失わない**ようにする。これにより、差分バッチの「空日」に `SELECT * FROM #empty_temp` を使うレシピが、`insertedCount=0` の no-op として正常完走する。

### 前提（v2.1.1 で既に解決済み）

明示列（`WILDCARD`/`PARENT_WILDCARD` を含まない）の 0 行 SELECT は、`project()` が AST から列を確定するため既に正しい（[ksql_empty_select_columns_fix_spec.md](ksql_empty_select_columns_fix_spec.md)）。したがって [課題 §14-21](ksql_empty_select_columns_issue.md) の実例（temp 作成・読み出しとも明示列）は **既に修正済み**。本仕様が扱うのは **読み出しが `SELECT *` の場合**に限られる。

### 対象（今回直す）

1. **`SELECT * FROM #empty_temp`** / **`SELECT * FROM empty_cte`**（JOIN なし・単一ソース）— 実体化時に確定した列スキーマを保存し、0 行でもそれを返す。
2. **混在ワイルドカード `SELECT *, extra FROM #temp`**（JOIN なし・単一ソース）— `*` を保存スキーマへ展開し、追加の明示列を続ける。
3. **左辺が空 `SELECT *` の `UNION` / `UNION ALL`** — 1 の結果 `columns` が非空になることで [`executeUnion`](../../src/execute.ts#L1580) が自動的に直る（本仕様の追加変更なし・回帰テストで固定）。

### 対象外（本仕様では直さない）

- **実アプリ直参照の 0 行 `SELECT * FROM APP`** — §3.6 の決定次第（既定＝対象外・メッセージ改善のみ）。
- **JOIN を伴う `SELECT *`（0 行）** — 複数ソースの列合成順が行依存で、0 行では確定不能。現状維持（空列＋メッセージ）。
- **`SELECT _p.*`（`PARENT_WILDCARD`）0 行** — サブテーブル親ショートカットは行依存。現状維持。
- **CTE/temp が JOIN・GROUP BY 等を含む複合クエリで実体化された場合の列**は、実体化時の `result.columns`（＝ project 出力）をそのまま保存するので**自動的に正しい**（追加設計不要）。

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

中立モジュール（`src/types/ast.ts` もしくは `src/engine/process.ts` の型エクスポート）に追加:

```ts
/** CTE / 一時テーブルの実体化結果。行に加えて列スキーマを保持する。 */
export interface MaterializedTable {
  readonly rows: ProcessRow[];
  /** 実体化 SELECT の出力列（順序保持）。0 行でも保持される。 */
  readonly columns: string[];
}
```

ストアの型を変更:

- `tempTables: Map<string, MaterializedTable>`
- `cteCache: Map<string, MaterializedTable>`

**波及**: この 2 つのマップを引き回す関数シグネチャ（`executeQueryWithCte` / `executeFullScanWithCte` / `runSelectLike` / `resolveSubqueries` / `evaluateScalarSubquery` / `executeWith` / `executeBatchStatement` ほか）の該当引数型を差し替える。get 側は `.get(name)?.rows ?? []` へ機械的に修正（§3.3）。

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

`sourceColumns` が与えられたときだけ、0 行のワイルドカードを展開する。**1 行以上の挙動は完全に不変**（実データ優先）。

- **単独 `SELECT *`**（[process.ts:597](../../src/engine/process.ts#L597)）:
  ```ts
  const cols = projected.length > 0 ? Object.keys(projected[0]) : (sourceColumns ?? []);
  ```
- **混在 `SELECT *, extra`**: 0 行のとき、`WILDCARD` 位置を `sourceColumns` で展開し、後続の明示列キー（§v2.1.1 の `computeOutputKeys` 相当）を続ける。列順は「AST の列順」に沿って `*`→スキーマ列、明示列→算出キー を連結。**重複キーは先勝ち**（`*` 展開に含まれる列と同名の明示列があれば明示列を後着で上書きしない＝現行の 1 行以上の `Object.assign` 順序と一致させる）。
  - 実装は「0 行かつ `hasWildcard` かつ `sourceColumns != null`」の専用分岐を追加し、`orderedKeys` を組み立てて `{ rows: [], columns: orderedKeys }` を返す。`sourceColumns == null` の 0 行は現状どおり空列（対象外ケース）。

`PARENT_WILDCARD` は `sourceColumns` に含まれない（親ショートカットは行依存）ため、混在に `_p.*` を含む 0 行は展開対象外（列不定のまま）。

### 3.5 UNION は自動波及

`executeUnion`（[execute.ts:1580-1600](../../src/execute.ts#L1580)）は `leftResult.columns` を結果列とし、右辺行を左辺列へリマップする。左辺が `SELECT * FROM #empty`（§3.3-3.4 で列が復活）なら `leftCols` が非空になり、右辺値が正しく載る。**UNION 自体の変更は不要**。回帰テストで固定する（§6）。

### 3.6 実アプリ直参照の 0 行 `SELECT *`（決定点）

`SELECT * FROM APP WHERE (0 件)` は保存スキーマがなく、列を得るには `getFields`（フィールド定義）が必要。

- **案ア（推奨・既定）＝対象外のまま**: 実アプリ bare `SELECT *` の 0 行は列不定を維持し、§5 のメッセージ改善で「0 行が原因」を示す。理由: (1) レシピ／差分バッチの実害は temp/CTE 経由（§3.1-3.4 で解決）で、実アプリ直 `SELECT *` を空ソース DML に使う実需は薄い。(2) 0 行のためだけに `getFields` の追加 API を撃つのは費用対効果が低い。
- **案イ（拡張・任意）＝ getFields で解決**: 単一アプリ・JOIN なしの 0 行 `SELECT *` に限り `getFields`（`getFieldTypeMap` と同じキャッシュ経路）で列名を取得し `sourceColumns` に流す。網羅性は上がるが API を 1 回増やす。JOIN は非対象。

**本仕様の既定は案ア**。案イは codex/ユーザー判断で追加可能（§8）。

---

## 4. 変更対象ファイル

| ファイル | 変更 |
|---|---|
| `src/types/ast.ts`（または process.ts） | `MaterializedTable` 型を追加 |
| `src/execute.ts` | ストア 2 マップの型変更（525/1636 ほかシグネチャ）、実体化 set（677/1648）で columns 保存、FULL_SCAN 読み出し（1741/1761）を `?.rows` 化＋`sourceColumns` 供給、`runFullScan` へ伝播 |
| `src/engine/process.ts` | `project()` に `sourceColumns?` 引数、単独/混在ワイルドカードの 0 行展開分岐、`runFullScan` の引数追加 |
| `src/__tests__/execute.test.ts` / `process` テスト | §6 の回帰・境界を追加 |
| `docs/ksql_batch_recipes.md` | 空日に `SELECT * FROM #temp` が no-op 完走する旨（回避策不要）を追記 |
| `docs/internal/ksql_empty_select_columns_issue.md` | 残スコープ解消を記録 |

コアの `runFullScan`/`project` 以外の実行計画・SIMPLE 経路は不変。

---

## 5. 受入条件

- [ ] `SELECT * FROM #empty_temp`（実体化元＝明示列・0 行）が実体化時スキーマの列を返す。
- [ ] `SELECT * FROM empty_cte`（同上）も同様。
- [ ] `UPSERT INTO x (a,b) SELECT * FROM #empty_temp ON DUPLICATE (a)` が `inserted=0/updated=0` の no-op（**POST/PUT 未呼び出し**）。
- [ ] `INSERT INTO x (a,b) SELECT * FROM #empty_temp` が `inserted=0`（**POST 未呼び出し**）。
- [ ] 混在 `SELECT *, 追加列 FROM #empty_temp` が「スキーマ列＋追加列」を順序どおり返す（重複キーは先勝ち）。
- [ ] 左辺が空 `SELECT *` の `UNION ALL` / `UNION` で結果列が左辺スキーマ由来、右辺値が正しく載る（`deduplicateRows` も `leftCols` で機能）。
- [ ] **1 行以上の `SELECT *`（temp/CTE/実アプリ）は列・列順・値ともに不変**（回帰の要）。
- [ ] **JOIN を伴う 0 行 `SELECT *` は現状どおり**（空列＋メッセージ・挙動不変）。
- [ ] `sourceColumns == null` の 0 行ワイルドカードは従来どおり空列（実アプリ bare `SELECT *`・案ア）。
- [ ] メッセージ改善: 列数不一致 かつ `columns.length===0` かつ `rows.length===0` のときだけ「0 行が原因」を示す（v2.1.1 の条件を踏襲・実アプリ bare `SELECT *` 救済）。
- [ ] ストア型変更後も既存のバッチ／CTE／スカラーサブクエリ／`IN (SELECT … FROM #temp)` が回帰なし。

## 6. テスト計画（修正前 fail → 修正後 pass）

### 単体（`project()`）
- `project([], [WILDCARD], _, _, ['a','b'])` → `columns===['a','b']`、`rows===[]`。
- `sourceColumns` 無し（`undefined`）の 0 行 `[WILDCARD]` → `columns===[]`（対象外維持）。
- 混在 `[WILDCARD, FIELD extra]` × 0 行 × `sourceColumns=['a','b']` → `columns===['a','b','extra']`。
- 重複: 混在 `[WILDCARD, FIELD a]` × `sourceColumns=['a','b']` → `columns===['a','b']`（先勝ち・重複しない）。
- **回帰**: 1 行以上の `[WILDCARD]`（temp/実データ）で修正前後の `{rows,columns}` が完全一致。

### 結合（execute 経由・書き込み API モック）
- 空 temp `SELECT *`: `CREATE TEMP TABLE #t AS SELECT a,b FROM APP WHERE (0件); UPSERT INTO x (a,b) SELECT * FROM #t ON DUPLICATE (a)` → `inserted=0/updated=0`・**POST/PUT 未呼び出し**。
- 空 CTE `SELECT *`: `WITH c AS (SELECT a,b FROM APP WHERE (0件)) INSERT INTO x (a,b) SELECT * FROM c` → `inserted=0`。
- 左辺空 UNION（`UNION ALL` と `UNION` 両方）: `SELECT * FROM #empty UNION ALL SELECT b FROM APP2` → 結果列＝#empty スキーマ、右辺値が載る。
- **JOIN 非対象**: `SELECT * FROM #empty t JOIN APP a ON ...`（0 行）→ 現状どおり（空列）を固定。
- 1 行以上の `SELECT * FROM #temp` 回帰。

## 7. リスク・非対象

- **リスク（列と値のずれ）**: `sourceColumns` で列を出すが行が空なので値ずれは起きない（`rows===[]`）。1 行以上は `sourceColumns` を使わない（実データ優先）ため不変。
- **リスク（ストア型変更の広域波及）**: get 側の `?.rows` 化漏れが実行時 `undefined` を招く可能性 → 型変更で TS コンパイルエラーとして検出できる（`ProcessRow[]` → `MaterializedTable` の不一致）。全 get サイトを型で洗い出す。
- **非対象**: 実アプリ bare `SELECT *`（案ア）・JOIN 0 行 `SELECT *`・`_p.*` 0 行。

## 8. 未決事項（codex / ユーザー判断）

1. **§3.6 の案ア（既定・対象外）／案イ（getFields 解決）**。既定は案ア。案イを採るなら「単一アプリ・JOIN なし・0 行」限定＋キャッシュ利用を条件にする。
2. **`MaterializedTable` 型の置き場所**（`types/ast.ts` の中立モジュール vs `process.ts`）。ストア波及の import 循環を避ける置き場所を実装時に確定。
3. **ストア型変更のスコープ**: 単一構造体マップ（採用案）で全シグネチャを差し替える範囲を codex がコードで確定（get サイトの網羅）。
