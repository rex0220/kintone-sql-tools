# 課題: 0 行の SELECT が列を失い、空ソースの INSERT / UPSERT … SELECT が誤メッセージで失敗する

- 作成日: 2026-07-14
- 更新履歴:
  - 2026-07-14 R1: 起票（v2.1.0 バッチレシピ R1 の実機テスト STEP 4＝差分 0 件のリランで発覚）
- ステータス: **未着手**
- 発見経緯: `docs/ksql_batch_recipes.md` の R1（差分更新バッチ）を実アプリで実行 → 差分 0 件の再実行で、空の一時テーブルに対する `UPSERT … SELECT` が下記エラーで停止

## 事象（実機で確認済み）

差分 0 件（＝処理対象なし）のとき、空の一時テーブルを SELECT する `UPSERT … SELECT` が失敗する:

```sql
CREATE TEMP TABLE #tgt AS
SELECT 顧客コード, 顧客名 FROM APP4220 WHERE 処理ステータス IN ('未処理');   -- 0 行

UPSERT INTO APP4219 (顧客コード, 顧客名)
SELECT 顧客コード, 顧客名 FROM #tgt ON DUPLICATE (顧客コード);
-- ⚠ SELECT の列数（0）と UPSERT のフィールド数（2）が一致しません
```

利用者は `SELECT 顧客コード, 顧客名`（2 列）と**明示している**のに「SELECT の列数（0）」と言われ、**0 行が原因だと分からない**。標準的な SQL では「空テーブルからの `INSERT/UPSERT … SELECT` は 0 件書き込みの no-op」であるべきで、エラーで止まるのは差分バッチの**平常の空日（差分なし）を毎回失敗させる**。

## 原因（コード裏取り済み）

**1. `project()` が出力列名を「1 行目を処理するとき」にしか記録しない**（[src/engine/process.ts:594-670](../../src/engine/process.ts#L594)）。各列型とも:

```ts
case "FIELD": {
  const key = col.alias ?? defaultFieldKeys.get(colIdx) ?? col.field;
  out[key] = resolveFieldRef(row, col.field);
  if (rowIdx === 0) orderedKeys.push(key);   // ← 0 行だと一度も実行されず orderedKeys=[]
  break;
}
```

`orderedKeys` は `rows.map((row, rowIdx) => …)` の中で `rowIdx === 0` のときだけ push される。**0 行だと `map` が回らず列リストが空**になる。列名は各型とも `col.alias ?? 既定名` で **AST から静的に決まる**のに、行に依存して組み立てている。WILDCARD（`SELECT *`）も `projected.length > 0 ? Object.keys(projected[0]) : []`（[:588](../../src/engine/process.ts#L588)）で 0 行だと空。

**2. 一時テーブルは行だけを保存し列スキーマを捨てる**（[src/execute.ts:556](../../src/execute.ts#L556) `tempTables.set(name, result.rows)`）。`Map<string, ProcessRow[]>`（[:446](../../src/execute.ts#L446)）で行（`Record<string,string>`）のみ保持。材料化時点で `result.columns` はあるのに使っていない。よって空の一時テーブルは列情報を完全に失い、そこからの SELECT は上記 1 で 0 列になる。

**3. 列数チェックが 0 列を弾く**（[src/execute.ts:2060-2063](../../src/execute.ts#L2060)）:

```ts
if (columns.length !== stmt.fields.length) {
  throw new Error(`SELECT の列数（${columns.length}）と INSERT のフィールド数（${stmt.fields.length}）が一致しません`);
}
```

## 影響

- **差分バッチの空日が失敗する**（本課題の実害）。0 件は差分バッチの正常系（静かな日）なのに、`UPSERT/INSERT … SELECT FROM #empty` がエラーで止まる。レシピ側は現状「確保前ゲートを `BETWEEN 1` にして 0 件は書き込み前に停止」または「呼び出し側で件数を先に確認してスキップ」という**回避策**を強いられている。
- **一時テーブルに限らず、0 行の SELECT ソース全般**が対象（高確度・要確認）。`INSERT INTO x SELECT a, b FROM APP WHERE (0 件一致)` も同じ `project()` を通るため列 0 で失敗するはず。
- **エラーメッセージが原因を示さない**（「列数 0」が 0 行由来だと分からない）。
- CLI の出力ヘッダも 0 行時は `Object.keys(rows[0] ?? {})`（[cli/index.ts:631](../../src/cli/index.ts#L631)）で空になり、同根。

## 修正方針（案）

**本命: `project()` の出力列名を `SelectColumn[]`（AST）から決める（行数に依存させない）。**

- 各列型の `key` 決定ロジック（`col.alias ?? 既定名`）を、行ループの前に **1 回だけ列名を算出する関数**へ切り出す。行ループは値の充填だけを行う。これで **0 行でも明示列 SELECT が正しく列を返す** → `UPSERT/INSERT … SELECT` from 空ソースが **inserted=0 の no-op** になる。
  - 対象: `FIELD` / `LITERAL_COL` / `AGGREGATE` / `ARITH_AGG_COL` / `ARITH_COL` / `CASE_COL` / `STRFUNC_COL` / `SCALAR_SUBQUERY_COL`（いずれも `alias ?? 既定名` で列名が静的に決まる）。
- **`WILDCARD` / `PARENT_WILDCARD` は AST から列を決められない**（データ/スキーマ依存）。0 行の `SELECT *` は原理的に列不明。
  - `SELECT * FROM #empty_temp` を成立させるには、**一時テーブルに列スキーマを併せて保存**する（`Map<string, { columns: string[]; rows: ProcessRow[] }>` へ変更し、材料化時の `result.columns` を保持）。読み出し時にこの列を使う。二次対応（レシピは全て明示列のため優先度は下）。
  - 0 行の APP ソースからの `SELECT *` は列不明のまま（アプリ定義取得は重い）。この場合は下記のメッセージ改善で救う。
- **エラーメッセージ改善**（補助）: 列数不一致で `columns.length === 0` のとき、「空の結果から列を特定できません（0 行）」を含める。ただし本命修正後は明示列で 0 列にならなくなるため、発生は限定的。

## 影響範囲・優先度

- 実害は「差分バッチの空日が失敗」で、差分バッチが主用途なら日常的に踏む。**優先度: 高**（0 件正常系を成立させ、レシピの回避策を不要にする）。
- 本命修正（`project()` の AST 由来列）は `project()` 1 関数に閉じ、既存の 1 行以上のケースは列順・列名が不変（回帰は列順の同一性で担保）。WILDCARD-空・一時テーブルスキーマ保存は分離して段階的に入れられる。

## テスト観点（修正時・修正前 fail → 修正後 pass）

- `CREATE TEMP TABLE #t AS SELECT a, b FROM APP WHERE (0 件); UPSERT INTO x (a,b) SELECT a,b FROM #t` → **inserted=0 の no-op**（現状 fail）。
- `INSERT INTO x (a,b) SELECT a,b FROM APP WHERE (0 件)` → 同上。
- 0 行の `SELECT a, b FROM APP WHERE (0 件)` の結果 `columns` が `['a','b']`（別名時は別名）になる。
- 1 行以上の既存ケースの列順・列名が不変（回帰防止）。
- （二次）`SELECT * FROM #empty_temp` が材料化時のスキーマで列を返す。
- （補助）列数不一致メッセージが 0 列時に原因を示す。
