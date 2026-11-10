# B212 ワイルドカードと他の列を混ぜた SELECT で、結果の列一覧にワイルドカードの列が載らない

- 状態: 📝 **保留（2026-11-10 Takashi「保留」）**。同日、混ぜる形を言語仕様で**非推奨**と書いた（Takashi「OK」。§4）
- 種別: 正しさ（値は誤らない。出力では列が**黙って欠け**、一時テーブル・CTE では止まる側＝fail-closed）
- 優先: 中（起票のときは「低〜中」。一時テーブルで止まるだけでなく、CLI の CSV・表と Dashboard Pro の表で列が黙って欠けると分かった）
- 見つけ方: B211 の Codex レビューの試験の不足（ワイルドカードと一緒の一時テーブルの `_2` を数値で比べる）を書いていて、`SELECT 番号 FROM #t` が止まった。v3.94.0 でも同じで、B211 とは別
- 関連: [B211](ksql_b211_function_column_default_key_collision_issue.md)、B86（実体化ソースの列の実在の検査）、B88（0 行の `SELECT *` の列）

## 1. 現象

### 1.1 起票のとき（v3.94.0 と B211 の作業中の版。代役のアプリ `x`・`番号`・`親` は NUMBER）

| SQL | 結果 |
|---|---|
| `CREATE TEMP TABLE #t AS SELECT *, CAST(CASE WHEN x > 2 THEN 1 ELSE 0 END AS NUMBER) FROM APP200;` → `SELECT 番号 FROM #t` | **`ArgumentError: unknown field code(s): 番号 (#t)`** |
| 同じ一時テーブルで `SELECT x FROM #t` | **`unknown field code(s): x (#t)`** |
| 同じ一時テーブルで `SELECT * FROM #t` | 読める（列は `$id`・`x`・`番号`・`親`・式の列） |
| 同じ一時テーブルで `SELECT * FROM #t WHERE \`CAST(case,'NUMBER')\` > 0` | 読める（式の列は名前で絞れる） |
| `CREATE TEMP TABLE #t AS SELECT * FROM APP200;` → `SELECT 番号 FROM #t` | 読める |
| `CREATE TEMP TABLE #t AS SELECT 番号, x FROM APP200;` → `SELECT 番号 FROM #t` | 読める |

### 1.2 v3.95.0 で調べ直した結果（2026-11-10。代役のアプリ `品目` は文字列、`増減`・`番号` は NUMBER、2 行）

| # | SQL | 結果 |
|---|---|---|
| 1 | `SELECT *, ROUND(増減, 0) FROM LAPP_増減` | `columns` = `["ROUND(増減,0)"]`。行には `$id`・`$revision`・`品目`・`増減`・`番号` も入る |
| 2 | `SELECT *, 番号 AS y FROM LAPP_増減` | `columns` = `["y"]`（項目に別名を付けても同じ） |
| 3 | 一時テーブル `SELECT *, ROUND(増減, 0)` → `SELECT 番号 FROM #t` | **`unknown field code(s): 番号 (#t)`** |
| 4 | 一時テーブル `SELECT *, ROUND(増減, 0) AS y` → `SELECT 番号 FROM #t` | **止まる**（式に別名を付けても同じ） |
| 5 | 一時テーブル `SELECT *, 番号 AS y` → `SELECT 番号 FROM #t` | **止まる** |
| 6 | 一時テーブル `SELECT *, ROUND(増減, 0) AS y` → `SELECT * FROM #t` | 読める（6 列） |
| 7 | 一時テーブル `SELECT *, ROUND(増減, 0) AS y` → `SELECT * FROM #t WHERE 番号 = 2` | **止まる**（`*` で読んでも、WHERE で名前を書くと止まる） |
| 8 | `WITH c AS (SELECT *, ROUND(増減, 0) AS y FROM LAPP_増減) SELECT 番号, y FROM c` | **`unknown field code(s): 番号 (c)`**（CTE でも同じ） |
| 9 | 0 行の一時テーブル `SELECT *, 番号 AS y … WHERE 番号 = 99` → `SELECT 番号 FROM #t` | **止まる** |

出力の口（`SELECT *, ROUND(増減, 0) AS r FROM APP1`、1 行）:

| 口 | 結果 |
|---|---|
| CLI の `buildOutput`（`src/cli/index.ts`）の CSV・表（TSV） | 見出しも値も **`r` の 1 列だけ**。Markdown も同じ作り（`result.columns` が空でなければそれを使う） |
| CLI の JSON | `columns` は `["r"]`、`rows` には全部の列が入る。JSONL は行だけなので欠けない |
| エンジンのライブラリの `runQuery`（Dashboard Pro が使う） | `columns` は `r` の 1 件だけ（型の情報も `r` だけ） |
| kSQL Dashboard Pro の表・CSV ダウンロード | `src/desktop/PaneView.tsx` が `result.columns` の名前で描く・書き出すので、`*` の列が欠ける（コードを読んで確かめた。実機は見ていない） |

再現のスクリプト（kintone-plugin の work-link）: `ksql-b212-wildcard-probe.cjs`（表の 1〜9。`/flow`）、`ksql-b212-wildcard-runquery-probe.cjs`（`runQuery`）、`ksql-b212-wildcard-cli-probe.ts`（CLI の `buildOutput`。esbuild で束ねて実行）。

## 2. 原因（確定）

`project()`（`src/engine/process.ts`）で、ワイルドカードと他の列が混ざると、列一覧（`orderedKeys`）に**ワイルドカードで展開した列を入れていない**。

- 1 行以上: `case "WILDCARD":`（process.ts:1816）は行に値を書くだけで `orderedKeys` に足さない。明示した列（`FIELD`・`STRFUNC_COL` など）は 1 行目で足す。`_p.*`（`PARENT_WILDCARD`）は足している。
- 0 行: `computeExplicitOutputKeys`（process.ts:1793 から呼ぶ）が明示した列だけを返す。
- この作りは Ver.1（8043141c、2026-04-07）から。2026-07 に試験で固定した（`src/engine/__tests__/process.test.ts` の「1 行以上の混在 SELECT *, a は従来どおり明示列だけ columns に載せる」「0 行の混在 SELECT *, extra は明示列だけ返す」。a78bf143・df64cb4c）。

一時テーブル・CTE で止まるのはその先:

- 一時テーブルは結果の `columns` をそのまま保存する（`src/execute.ts:3170` の `tempTables.set(…, { rows, columns: result.columns, … })`）。
- B86 の列の実在の検査は、実体化した表の `validCodes` を `columns` から作る（execute.ts:5975）。`*` の列は `columns` に無いので「無い項目」になる。
- `SELECT * FROM #t` は行のキーから列を作るので読める。

## 3. 直し方の案（再開するとき）

- **案 A（推奨）**: `project()` で直す。1 行以上は `SELECT *` と同じく行のキーの順を列一覧にする（`*` の位置に展開した列、明示した列はその位置。`SELECT *, 番号` のように名前が重なる列は 1 列）。0 行は、元の表の列が分かるとき（B88 で戻した `sourceColumns`）はそれで展開し、分からないときは今どおり明示した列だけ。一時テーブル・CTE の列の型（`inferSelectColumnMeta` のワイルドカード混在の分岐）も、`*` の列に元の項目の型を付ける（1.2 の 7 を数値で比べるため）。固定した試験 2 件を直す。列が増えるのは挙動の変化なので minor で CHANGELOG に書く。
- 案 B: 一時テーブル・CTE の検査だけ行のキーで通す。範囲は狭いが、CLI と Dashboard Pro で列が欠けるのが残るので採らない。

案 A の前に確かめること: `INSERT/UPSERT … SELECT *, 式` は元の列一覧の位置で値を移す。今は `INSERT INTO X (a) SELECT *, r` が `a ← r` として通っているとみられ、直すと列の数が合わなくなって止まる側に変わる（誤った値は書かない）。kSQL アクションの事例と契約の試験、Dashboard Pro の設定にこの形が無いかを先に洗う。

## 4. 当面の扱い（2026-11-10。Takashi「OK」）

- 言語仕様（`docs/ksql_language_reference.md`）§2「全フィールド取得」に、`*` と他の列を混ぜる形を**非推奨**と書いた（理由＝出力で列が欠ける・一時テーブル・CTE で名前で読めない。代わりに使う列を明示するか `SELECT *` だけで書く）。
- 言語仕様の中で混ぜる形を使っていた例（`SELECT *, CURRENT_DATE() AS 今日 FROM APP100`。§の現在日時と付録の 2 か所）を `SELECT 顧客名, CURRENT_DATE() AS 今日 FROM APP100` に直した。
- kSQL アクションの `docs/`、kSQL Dashboard Pro の `docs/` とオーサリングの資料には、混ぜる形の例は無い（2026-11-10 に検索して 0 件）。
- `SELECT *` だけの形は非推奨にしない（列一覧も一時テーブルも正しく動く。資料の例も多い）。

## 5. 回避策

使う列を明示する（`SELECT 顧客名, 金額, ROUND(金額, 0) AS 丸め`）。または `SELECT *` だけで書き、式の列は後の段で足す。
