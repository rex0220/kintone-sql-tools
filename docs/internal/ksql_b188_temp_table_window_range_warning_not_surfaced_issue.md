# B188 `CREATE TEMP TABLE` 経由だとウィンドウの既定フレーム（RANGE）警告が表面化しない — 直接の SELECT と CTE では出る

- 状態: 📝 **起票（2026-09-16）**。未着手。実測 v3.78.0（CLI・dev profile・SFA パック）。改善（警告の伝播・結果は不変）

## 1. 現象

同じウィンドウ式（`ORDER BY` だけでフレーム省略＝既定 RANGE）を 3 経路で実行し、`warnings` を比較した。

| 経路 | `warnings` |
| :--- | :--- |
| `SELECT 会社名, 売上, SUM(売上) OVER (ORDER BY 売上) AS 累計 FROM APP4149 WHERE 売上 > 6000000` | **あり**: 「累計 は既定フレーム（RANGE）で評価されます。ORDER BY の値が同じ行はすべて同じ値になります。…ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW を明示するか…」 |
| `WITH t AS (同じ SELECT) SELECT * FROM t` | **あり**（同じ警告） |
| `CREATE TEMP TABLE #t AS 同じ SELECT; SELECT * FROM #t` | **なし**。文 1（CREATE TEMP TABLE）も文 2（SELECT）も `warnings: []` |

- 一時テーブルの中身は正しい（RANGE で評価された値）。**警告だけが落ちる**
- CTE は実体化時の `warnings` を最終 SELECT へ伝えているが、`CREATE TEMP TABLE` の結果（`CREATE_TEMP_TABLE` の statement result）には SELECT 側の `warnings` が載らない

## 2. なぜ問題か

- 第 3 回・第 8 回・第 9 回付録（第 7 回・第 8 回の依頼文）で推奨している形は「集計を一時テーブルに実体化してから使う」。**推奨した経路だけ警告が消える**
- RANGE の既定フレームは「同額の行が同じ累計になる」静かな誤りで、警告はそのための唯一の合図（第 3 回の「境界条件」）。バッチ（CLI・`/flow`）は一時テーブル経路が主なので、実運用で最も見えにくい

## 3. 対応案

**案 A（伝播・純加法）**: `CREATE TEMP TABLE … AS SELECT` の実体化で得た `SelectResult.warnings` を、`CREATE_TEMP_TABLE` の statement result の `warnings` に載せる（`executeBatch` の該当分岐）。`IMPORT` / `INSERT … SELECT` も同じ経路なら同じ扱いにする。結果行・列は不変

**案 B（EXPLAIN でも出す）**: `EXPLAIN` の一時テーブル文の行に `window frame: RANGE (default)` のような注記を足す。プラグイン同梱エンジンの snapshot に波及するので A の後に判断

推奨は **A**。`/flow` はステートメント結果の `warnings` をログに残す（第 8 回）ので、A だけで実運用に届く

## 4. 受入条件

- §1 の 3 経路で同じ警告文が出る（`CREATE TEMP TABLE` は文 1 の `warnings`）。文 2 の `SELECT * FROM #t` には重複して出さない
- 警告の無い SELECT を実体化したときは `warnings: []` のまま（既存の一時テーブルテストが不変）
- CLI の表示・MCP `ksql_query` のバッチ envelope・`/flow` の statement result・プラグインの一時テーブル実行で同じ
- ウィンドウ以外の警告（例: JOIN キー 300 件超の全件取得警告）も同じ経路で伝わることを 1 本

## 5. 経緯

- 2026-09-16: 第 8 回の執筆時に「一時テーブル経由だと RANGE 警告が出ない」に気づき別課題候補として記録（計画書）。v3.78.0 で 3 経路を再測して確定。別課題候補 4 件の起票で B188 に採番
- 関連: 第 3 回（`ROWS` フレームとタイブレーク）、B65-O 系（ウィンドウの一意性警告の文言）
