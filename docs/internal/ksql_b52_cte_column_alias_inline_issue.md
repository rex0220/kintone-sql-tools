# B52 — 単一 CTE の列別名（AS）がインライン化で解決されず `unknown field` になる

- 起票日: 2026-07-21
- ステータス: **起票（実データ再現・未着手）**
- 種別: バグ（正しさ・ただし silent でなく error 終了）
- 優先度: **中**（結果は壊さず明確にエラーになる＝B51 の silent wrong results より危険度は低い。ただし正当な SQL が動かない）
- 発見の経緯: B51（複数 CTE の CTE 間 JOIN 誤結果）の root-cause 調査（codex）中に、単一 CTE ＋列別名の別欠陥として切り分けられた（B51 の「関連観察①」）。B51 とは直接原因が異なるため別課題として起票。

## 症状

**単一の CTE 本体で列に `AS 別名` を付け、外側 SELECT でその別名を参照すると `unknown field code(s)` エラーになる。** CTE の出力別名が物理アプリのフィールドとして検証・取得されてしまう。

## 最小再現（本番 kintone・APP730・CLI v3.10.0）

```sql
WITH a AS (SELECT レコード番号 AS aid FROM APP730 WHERE レコード番号 IN (1,2,3))
SELECT a.aid FROM a
```
- 期待: 3 行（aid=1,2,3）。
- 実際: `ArgumentError: unknown field code(s): aid (APP730)`。

対照（別名なしは正常）:
```sql
WITH a AS (SELECT レコード番号 FROM APP730 WHERE レコード番号 IN (1,2,3))
SELECT a.レコード番号 FROM a   -- 正常（既存の window/CTE 機能で多用される形）
```

## Root-cause（codex 調査・2026-07-21）

`canInlineSingleCte`（[src/core/cteInlining.ts:5](../../src/core/cteInlining.ts#L5)）は CTE 本体の**出力別名を考慮せず**この形をインライン化可能と判定する。`buildInlinedQuery`（[cteInlining.ts:18](../../src/core/cteInlining.ts#L18)）は外側の列定義をそのまま物理アプリの SELECT へ移すだけで、**`aid → レコード番号` の写像を行わない**。その結果、物理 APP730 に対して `aid` を取得・検証し、`validateSelectFieldCodes`（[execute.ts:2500](../../src/execute.ts#L2500) 付近）が `unknown field code(s): aid` を返す。

B51（実体化 JOIN の alias 衝突）とは直接原因が異なるが、**「CTE 出力スキーマ（別名を含む列の見え方）を名前解決に使っていない」という上位の設計不足は共通**。

## 影響

- CTE 内で列に別名を付けて外側で参照する正当な SQL が動かない（error）。
- silent wrong results ではない（明確にエラー）ので B51 ほど危険ではないが、機能欠落。
- 回避策: CTE 内で `AS` 別名を使わず物理フィールド名のまま参照する。または一時テーブル（`CREATE TEMP TABLE ... AS SELECT ... AS 別名`）にすると実体化されて別名が保持される（B51 の effective alias 修正後は CTE でも同様に扱える見込み）。

## 修正方針（案・未確定）

1. **schema 対応インライン化（本格）**: CTE 投影から出力スキーマ写像（`aid → レコード番号` / 式）を作り、外側 SELECT・WHERE・ORDER BY・GROUP BY を物理フィールド/式へ合成する。`canInlineSingleCte` は「形が単純」だけでなく「外側参照が CTE 出力スキーマを通して安全に物理列へ解決できる」ことまで証明する。
2. **短期の安全策**: 次の CTE をインライン不可にして実体化経路（B51 修正後は正しい）へ回す。
   - CTE 投影に `AS` 別名がある
   - 外側が CTE 出力別名を参照する
   - CTE 投影に式・リテラル等があり安全な写像を構成できない
   - `SELECT *` または同名フィールドだけの単純 CTE は既存のインライン最適化を維持。

## 依存・順序

- **B51（effective alias）の後に着手が自然**。B51 修正で実体化経路の CTE JOIN/参照が正しくなるため、短期策②（インライン不可にして実体化へ回す）が安全に成立する。
- 単独でも patch 可能（インライン判定の絞り込み）。

## 次アクション

- 修正方針の確定（schema 対応 vs インライン絞り込み）。B51 完了後に着手。
- 再現テスト＝CTE 列別名 no-join・CTE 列別名＋JOIN・式/リテラル投影・`SELECT *`/同名列の非回帰。
