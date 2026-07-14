# 仕様案: 0 行 SELECT の列欠落バグ修正（`project()` の列名を AST から確定する）

- 作成日: 2026-07-14
- 対象課題: [ksql_empty_select_columns_issue.md](./ksql_empty_select_columns_issue.md)（codex レビュー済み R2）
- ステータス: **仕様案（codex 実装レビュー前）**
- 分担: Claude=仕様/観点、Codex=実装/テスト
- SemVer: **バグ修正・後方互換（0 行以外の既存出力は不変）→ patch 相当**（リリース版数は実装後に確定）

## 1. 目的とスコープ

**目的**: 明示列（非ワイルドカード）の `SELECT` が **0 行でも出力列（`columns`）を失わない**ようにし、空ソースからの `INSERT / UPSERT … SELECT` と 左辺が空の `UNION` を「0 件書き込みの no-op / 値保持」で成立させる。

### 対象（今回直す）

- 明示列のみで構成される `SELECT`（`WILDCARD` / `PARENT_WILDCARD` を **含まない**列リスト）。全 `SelectColumn` 型のうち以下:
  `FIELD` / `LITERAL_COL` / `AGGREGATE` / `ARITH_AGG_COL` / `ARITH_COL` / `CASE_COL` / `STRFUNC_COL` / `SCALAR_SUBQUERY_COL`
- これが 0 行でも `columns` を AST から確定することで、下流の以下が自動的に直る:
  - 空の直接 SELECT からの `INSERT/UPSERT … SELECT`
  - 空の一時テーブル経由の `INSERT/UPSERT … SELECT`
  - 左辺が 0 行の `UNION` / `UNION ALL`（`executeUnion` が `leftResult.columns` を使うため）

### 対象外（本課題では直さない・別課題へ分離）

- **空の `SELECT *`（`WILDCARD`）** — 列がデータ依存。0 行で列不明のまま。
- **空の `SELECT _p.*`（`PARENT_WILDCARD`）** — 同上。
- **空 CTE / 空一時テーブルからの `SELECT *`** — 列メタデータをパイプライン（一時テーブル・CTE・UNION）へ伝播する必要があり、範囲が大きい（[issue.md](./ksql_empty_select_columns_issue.md) の二次対応）。
- **混在ワイルドカード（例: `SELECT *, a`）** — 列リストに `WILDCARD`/`PARENT_WILDCARD` を 1 つでも含むもの。**既存の行依存経路を維持**（今回は挙動を一切変えない）。

> 対象外の 0 行ケースは §5 のメッセージ改善で「原因が 0 行である」ことだけ明示する。

## 2. 現状（バグの所在）

[src/engine/process.ts:580-671](../../src/engine/process.ts#L580) の `project()`:

- 単独 `SELECT *` は line 586 で別処理（`projected.length>0 ? Object.keys(projected[0]) : []`）→ 0 行で空。
- それ以外は `rows.map((row, rowIdx) => …)` の中で、各列型とも **`if (rowIdx === 0) orderedKeys.push(key)`**。列名 `key` は型ごとに `alias ?? 既定名` で**静的に決まる**のに、**行 0 を処理したときにしか記録しない**。→ `rows` が空だと `map` が回らず `orderedKeys = []`。
- 戻り値 `columns: orderedKeys` が空 → 下流の列数チェック（[execute.ts:2060](../../src/execute.ts#L2060)）・`UNION`（[execute.ts:1211-1226](../../src/execute.ts#L1211)）・CLI ヘッダ（[cli/index.ts:631](../../src/cli/index.ts#L631)）が破綻。

## 3. 修正方針: 列名の算出を行ループの外へ

**行数に依存せず、列リスト（AST）から出力キーを 1 回だけ確定する。** 行ループは「値の充填」だけを行い、`orderedKeys` は行ループの前に確定した配列をそのまま返す。

### 3.1 新規: AST 由来の列名算出関数

`project()` 内（または同ファイル内 private）に、列ごとの出力キーを返す関数を追加する。

```ts
/**
 * 各 SELECT 列の出力キー名を AST から算出する（行データに依存しない）。
 * WILDCARD / PARENT_WILDCARD はデータ依存のため null を返す（キーを静的決定できない）。
 *
 * @param columns          SELECT 列定義（順序＝出力列順）
 * @param defaultFieldKeys buildDefaultFieldOutputKeys() の結果（FIELD の修飾名衝突解決）
 * @returns keys[colIdx] — 出力キー名。WILDCARD/PARENT_WILDCARD の位置は null
 */
function computeOutputKeys(
  columns: SelectColumn[],
  defaultFieldKeys: Map<number, string>
): (string | null)[];
```

- **入力**: `columns: SelectColumn[]`（順序保持）と、既存 [`buildDefaultFieldOutputKeys(columns)`](../../src/engine/process.ts#L673) の戻り値。
- **出力**: `columns` と同じ長さ・同じ順序の `(string | null)[]`。null は `WILDCARD` / `PARENT_WILDCARD`（データ依存）。
- **各型のキー式（現行 `project()` と完全に同一の式を使う）**:

  | 型 | 出力キー | 備考 |
  |---|---|---|
  | `FIELD` | `col.alias ?? defaultFieldKeys.get(colIdx) ?? col.field` | 修飾名衝突は §3.2 |
  | `LITERAL_COL` | `col.alias ?? \`'${col.value}'\`` | |
  | `AGGREGATE` | `col.alias ?? aggregateSyntheticName(col.func, col.distinct, col.arg)` | 現行 `dstKey` |
  | `ARITH_AGG_COL` | `col.alias ?? aggArithDefaultKey(col.expr)` | |
  | `ARITH_COL` | `col.alias ?? arithColDefaultKey(col.expr)` | |
  | `CASE_COL` | `col.alias ?? "case"` | |
  | `STRFUNC_COL` | `col.alias ?? stringFuncDefaultKey(col.expr)` | 値充填の分岐は現行維持 |
  | `SCALAR_SUBQUERY_COL` | `col.alias ?? "(subquery)"` | |
  | `WILDCARD` / `PARENT_WILDCARD` | `null` | 静的決定不可 |

### 3.2 `buildDefaultFieldOutputKeys()` の衝突規則・列順は完全維持

[process.ts:673-691](../../src/engine/process.ts#L673) の規則を**一切変えない**:

- `FIELD` かつ `alias` なしの列のみ対象。`stripTableQualifier(col.field)` の**非修飾名の出現回数**をカウント。
- 出現回数 > 1（衝突）かつ `col.field.includes(".") && !startsWith("_p.")`（テーブル修飾あり）なら**修飾名 `col.field`**、そうでなければ**非修飾名**を採用。
- `stripTableQualifier`（[:693](../../src/engine/process.ts#L693)）: `_p.` はそのまま、先頭以外の最初の `.` 以降を採用（空なら元の値）。

`computeOutputKeys()` はこの Map をそのまま参照するだけで、衝突解決ロジックは複製・変更しない。**列順は `columns.entries()` の順**＝現行 `orderedKeys` の push 順と同一。

### 3.3 `project()` 本体の分岐

```
project(rows, columns, scalarCache):
  // (A) 単独 WILDCARD: 現行のまま（対象外）
  if (columns.length === 1 && columns[0].type === "WILDCARD"):
      return 現行処理

  defaultFieldKeys = buildDefaultFieldOutputKeys(columns)

  // (B) 列リストにワイルドカードを含むか（混在含む）
  hasWildcard = columns.some(c => c.type === "WILDCARD" || c.type === "PARENT_WILDCARD")

  if (hasWildcard):
      // 対象外: 現行の行依存経路をそのまま維持（挙動不変・回帰なし）
      return 現行の rows.map + rowIdx===0 push 経路

  // (C) 明示列のみ: 列名を行ループ前に AST から確定（本修正）
  outputKeys = computeOutputKeys(columns, defaultFieldKeys)   // string[]（null を含まない）
  projected = rows.map(row => 各列を outputKeys[colIdx] へ充填)   // 値充填のみ、push しない
  return { rows: projected, columns: outputKeys }
```

- **(C) の値充填は現行と同じ式**（`STRFUNC_COL` の集計分岐、`AGGREGATE` の `row[alias??src] ?? row[src] ?? "0"` 等）を、キーだけ `outputKeys[colIdx]` に置き換えて使う。**キーは充填と columns で必ず同一物**を使うため、1 行以上の既存出力は列名・列順・値ともに不変。
- **(B) を残す理由**: `WILDCARD`/`PARENT_WILDCARD` は 0 行だと列を出せず、混在時に明示列だけ AST 確定してもワイルドカード分の列が抜け、順序も壊れる。今回は触らず現状維持（対象外の宣言と一致）。

### 3.4 空行でも `columns` が確定する契約（明示列）

- **契約**: `project(rows, columns)` は、`columns` が `WILDCARD`/`PARENT_WILDCARD` を含まない限り、`rows.length` に関わらず `result.columns` が `computeOutputKeys()` と 1:1・同順で**必ず非空**（列数＝明示列数）になる。
- これにより `executeSelect` → `runFullScan`（[execute.ts:1187](../../src/execute.ts#L1187)）が返す `SelectResult.columns` が 0 行でも埋まり、下流（INSERT/UPSERT 列数チェック・UNION・CLI ヘッダ）が正しく動く。

## 4. 下流への波及（自動で直る／確認する）

いずれも `project()` 修正だけで直るが、テストで固定する。

- **INSERT … SELECT**（[execute.ts:2060](../../src/execute.ts#L2060) 列数チェック）: `columns.length === stmt.fields.length` となり通過 → 0 行なら書き込みなし。
- **UPSERT … SELECT**: 同上。ソース 0 行 → マッチも新規もなし。
- **UNION / UNION ALL**（[executeUnion, execute.ts:1210-1226](../../src/execute.ts#L1210)）: 左辺が明示列なら `leftResult.columns` が非空 → `leftCols.forEach` が回り、右辺の値が左辺列名へ正しくリマップされる。
- **CLI 出力ヘッダ**（[cli/index.ts:631/641/648](../../src/cli/index.ts#L631)）: `result.columns` が非空になり、フォールバック（先頭行）に依存せずヘッダが出る。

## 5. メッセージ改善（補助・対象外ケース救済）

本修正後、明示列で `columns.length === 0` になるのは **対象外のワイルドカード×0 行**のみ。列数不一致エラー（[execute.ts:2060-2063](../../src/execute.ts#L2060)）を次の条件で改善する:

- **発動条件**: `columns.length !== stmt.fields.length` **かつ** `columns.length === 0`。
- **文言**: 現行に加え「結果が 0 行のため列を特定できませんでした（`SELECT *` を空ソースに使うと列を決定できません。明示列で指定してください）」の趣旨を付記。
- 明示列 SELECT では本条件に到達しなくなるため、実質「空 `SELECT *`」専用の案内となる。

## 6. 受入条件（実装で満たすこと）

- [ ] ワイルドカードを含まない列は、**行ループの前に AST から順序付きで確定**する（`computeOutputKeys`）。
- [ ] `FIELD` の**修飾名衝突処理（`buildDefaultFieldOutputKeys`）を含め、1 行以上の既存結果の列名・列順・値が不変**（回帰防止の要）。
- [ ] `WILDCARD` / `PARENT_WILDCARD` を検出した列リスト（単独・混在）は**既存経路を維持**し挙動不変。
- [ ] **空行でも明示列の `columns` が確定**（列数＝明示列数、順序一致）。
- [ ] `INSERT` 結果 `insertedCount = 0`、**`UPSERT` 結果 `insertedCount = 0 / updatedCount = 0`**（0 行ソース）。
- [ ] **左辺が空の `UNION` で結果列が左辺由来、右辺の値が正しく載る**。
- [ ] **POST / PUT（kintone 書き込み API）が呼ばれない**ことを検証（0 行 no-op が無通信）。
- [ ] メッセージ改善が **`columns.length === fields 数不一致 かつ 0`** のときだけ発動する。
- [ ] 空 `SELECT *`・空 CTE・混在ワイルドカードは**今回対象外**である（挙動不変を確認）。

## 7. テスト計画（修正前 fail → 修正後 pass）

### 単体（`project()`）

- `project([], [FIELD a, FIELD b])` → `columns === ['a','b']`、`rows === []`。
- 別名: `project([], [FIELD a AS x])` → `columns === ['x']`。
- 修飾名衝突: `SELECT t1.f, t2.f`（別名なし）で 1 行以上と 0 行で `columns` が同一（衝突時は修飾名）。
- 各型（`LITERAL_COL`/`AGGREGATE`/`ARITH_COL`/`CASE_COL`/`STRFUNC_COL`/`SCALAR_SUBQUERY_COL`）で 0 行時に既定キー/別名が出る。
- **回帰**: 代表的な複数行 SELECT で、修正前後の `{rows, columns}` が完全一致。
- **対象外維持**: `SELECT *`（単独）・`SELECT *, a`（混在）・`SELECT _p.*` が 0 行で現行どおり空列（挙動不変）。

### 結合（execute 経由・書き込み API モック）

- 空直接 SELECT: `INSERT INTO x (a,b) SELECT a,b FROM APP WHERE (0 件)` → `insertedCount=0`・**POST 未呼び出し**。
- 空一時テーブル: `CREATE TEMP TABLE #t AS SELECT a,b FROM APP WHERE (0 件); UPSERT INTO x (a,b) SELECT a,b FROM #t ON DUPLICATE (a)` → `inserted=0,updated=0`・**POST/PUT 未呼び出し**。
- 左辺空 UNION: `SELECT a FROM APP1 WHERE (0 件) UNION ALL SELECT b FROM APP2` → `columns===['a']`、`rows` に APP2 の値が `a` 列で入る。
- メッセージ: 空 `SELECT *` を空ソースに使った `INSERT` で改善文言が出る。

## 8. リスク・非対象

- **リスク**: 値充填で使うキーと `columns` のキーが乖離すると列と値がずれる → **同一 `outputKeys[colIdx]` を両者で使う**設計で回避。回帰テストで列名・列順・値の一致を固定。
- **非対象**: 空 `SELECT *` / 空 CTE / 混在ワイルドカードの列復活は別課題（列メタデータのパイプライン伝播）。本修正では挙動を変えない。
