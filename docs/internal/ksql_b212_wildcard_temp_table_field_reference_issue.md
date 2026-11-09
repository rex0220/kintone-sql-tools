# B212 ワイルドカードと式を一緒に入れた一時テーブルで、ワイルドカードで入った列を名前で読むと「無い項目」で止まる

- 状態: 📝 **起票のみ（2026-11-10）**。直すかは Takashi 判断
- 種別: 正しさ（止まる側＝fail-closed。誤った値は返さない）
- 優先: 低〜中（`SELECT * FROM #t` では読める。式に別名を付けても同じかは未確認）
- 見つけ方: B211 の Codex レビューの試験の不足（ワイルドカードと一緒の一時テーブルの `_2` を数値で比べる）を書いていて、`SELECT 番号 FROM #t` が止まった。v3.94.0 でも同じで、B211 とは別
- 関連: [B211](ksql_b211_function_column_default_key_collision_issue.md)

## 1. 現象（v3.94.0 と B211 の作業中の版で同じ。代役のアプリ `x`・`番号`・`親` は NUMBER）

| SQL | 結果 |
|---|---|
| `CREATE TEMP TABLE #t AS SELECT *, CAST(CASE WHEN x > 2 THEN 1 ELSE 0 END AS NUMBER) FROM APP200;` → `SELECT 番号 FROM #t` | **`ArgumentError: unknown field code(s): 番号 (#t)`** |
| 同じ一時テーブルで `SELECT x FROM #t` | **`unknown field code(s): x (#t)`** |
| 同じ一時テーブルで `SELECT * FROM #t` | 読める（列は `$id`・`x`・`番号`・`親`・式の列） |
| 同じ一時テーブルで `SELECT * FROM #t WHERE \`CAST(case,'NUMBER')\` > 0` | 読める（式の列は名前で絞れる） |
| `CREATE TEMP TABLE #t AS SELECT * FROM APP200;` → `SELECT 番号 FROM #t` | 読める |
| `CREATE TEMP TABLE #t AS SELECT 番号, x FROM APP200;` → `SELECT 番号 FROM #t` | 読める |

ワイルドカードだけ・明示した列だけなら読める。**ワイルドカードと明示した列が混ざると、ワイルドカードで入った列だけが名前で引けない**。

## 2. 見立て（未調査）

一時テーブルの列の実在の検査（「実体化後の列実在チェック」）が、ワイルドカードと明示した列が混ざったときに、ワイルドカードで入った列を数えていないとみられる
（`inferSelectColumnMeta` のワイルドカード混在の分岐か、一時テーブルの列一覧の作り方）。原因はまだ確かめていない。

## 3. 回避策

一時テーブルにワイルドカードと式を混ぜない（使う列を明示する）。または `SELECT * FROM #t` で読む。
