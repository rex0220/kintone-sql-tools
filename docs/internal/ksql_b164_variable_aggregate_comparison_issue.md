# B164 `@変数` を含む集計が比較位置（CASE WHEN / HAVING）で -Infinity になる

- 起票: 2026-08-08（[依頼元の v3.64.0 返信 §3](../../../ksql-analytics/docs/internal/kSQLエンジンへの返信-20260808-v3640.md)・**主張 3 点すべて実測で逐語再現**）
- ステータス: ✅ **v3.65.0 リリース（2026-08-08・案 A＝参照 key 再生成＋未計算参照の警告・実機確認済み）**
- 関連: B147/B148（式の canonical identity）／B124（集計算術式の合成名キー）／
  [evalwhere-empty-cell 系](ksql_string_semantics.md)（空＝最小値の意味論）

## 1. 症状（実測・2026-08-08・v3.64.0・APP4228）

**同じ集計式が、`SELECT` リストでは正しく、`CASE WHEN`／`HAVING` の比較位置では
`-Infinity` として評価される。違いは引数に `@変数` を含むかどうかだけ。エラーも警告も出ない。**

最小再現（依頼元の逐語・当方 MCP でも再現）:

```sql
DECLARE @a = '2026-02';
DECLARE @b = '2026-04';
SELECT 製品名,
  SUM(CASE WHEN DATE_FORMAT(日付,'%Y-%m') >= @a AND DATE_FORMAT(日付,'%Y-%m') <= @b
      THEN 個数 ELSE 0 END) AS 前3_変数,                               -- → 0 ✅
  CASE WHEN SUM(...同じ式...) = 0 THEN 'ZERO' ELSE 'NONZERO' END AS 判定_変数  -- → NONZERO ❌
FROM APP4228 WHERE 入出庫区分 = '出庫' AND 製品名 = 'ライ麦パン' GROUP BY 製品名
```

- リテラル版（`'2026-02'`/`'2026-04'` 直書き）は `ZERO` ✅
- 比較位置の実値: `< 0` → NEG・`< -1.79e308` → **INFINITY**（実測）＝ `-Infinity`
- **HAVING でも同じ**＝`HAVING SUM(...@変数...) = 0` が黙って 0 行（リテラル版は 1 行）

## 2. 影響範囲（依頼元実測＋当方確認）

| 位置 | 結果 |
|---|---|
| `SELECT` リスト | 正しい |
| `CASE WHEN` の比較 | `-Infinity`（除数ガード不発火→ NaN が結果に出る） |
| `HAVING` の比較 | `-Infinity`（該当行が静かに消える） |

依頼元の登録済み保存クエリ・既存 30 本に該当なし（比較位置に `@変数` 集計を書いていない）。
依頼元は鉄則に「比較位置に書かない」を追加して回避済み。**優先 中（依頼元申告）だが
「静かに間違う」クラス**であり、HAVING の症状が既知の別原因（SELECT 非掲出）と同形のため
確認手段が効かない、という指摘つき。

## 3. 原因の見立て（調査で確定させる）

比較位置の集計値は**式の identity（canonical 形）で SELECT リストの計算結果を引く**構造の
はずで、`@変数` を含むと「計算側（変数解決後）」と「参照側」の形が食い違い、**未計算扱い→
空＝最小値（`-Infinity` バンド）に落ちる**と推定（B147/B148 の canonical identity・
B124 の合成名キーと同族）。`SELECT` リスト自身が正しいことから、集計の計算自体は正常で
**参照の突合だけが破れている**可能性が高い。

## 4. 方針候補

- **本命＝参照突合の修正**（変数解決のタイミングを計算側・参照側で一致させる）
- **依頼元提案の中間策**＝修正が重い場合、`EXPLAIN`/実行時に
  「比較位置の集計に `@変数` が含まれます」の検知警告を先行（fail-open のまま黙らせない）
- 受入（起票時点）: §1 の逐語で `判定_変数=ZERO`・符号 probe が `NONNEG`/`FINITE`・
  HAVING が 1 行・リテラル版と全列一致。SELECT リストの既存正常値は不変

## 5. 原因（確定・2026-08-08 [調査報告](ksql_b164_codex_investigation_report.md)）

**canonicalizer の差ではなく、同一 serializer（`aggregateSyntheticName()`）を
変数解決の前後で呼んでいることが原因**:

1. parser が CASE/HAVING の直接集計を `FIELD` に変換する際、**解決前の AST から
   合成 key を作って `FieldRef.field` に焼き付ける**（`parser.ts:2858-2873`。
   構造は `aggregateRef` に併存保持）
2. 変数 resolver は `aggregateRef` 内の `VARIABLE` は解決するが、
   **派生文字列 `FieldRef.field` を再生成しない**（`execute.ts:2170-2188`）
3. 計算側は**解決後 AST から key を作って保存**（`process.ts:521-528`）→ 参照側は
   解決前 key で検索 → 未一致
4. 未一致は `""` になり、数値比較の**band 0（空＝`-Infinity` の band 1 よりさらに下）**へ
   （`scalarCompare.ts:30-43`）。probe が `-Infinity` に見えたのは空 sentinel
5. SELECT リストは**列位置**で読むため正常（`process.ts:1417-1424`）——症状の非対称と一致

影響の正確な範囲＝CASE/IF 条件・HAVING の**直接集計参照**（全 AggregateFunc・
GROUPING SETS 含む）。集計算術式（`SUM(...)+0`）・THEN/ELSE・関数包み（`ROUND(SUM(...))`）・
ORDER BY alias・ウィンドウは**別経路で対象外**。既知の「HAVING 非掲出で 0 行」は
同症状・別原因（受入で分離必須）。

## 6. 方向（案 A 推奨・調査報告 §6）

**案 A＝参照時に `aggregateRef` から key を再生成**（`FieldRef.field` を信用しない）。
最小かつ本質的＝`aggregateRef` を値と semantics の唯一の正本にでき、CASE/HAVING を同時に修正。
再生成 key も未一致の場合は B164 と区別できる診断を追加（HAVING 非掲出問題との混同防止）。
長期は案 C（派生文字列の二重正本解消）を別途。回帰観点は調査報告 §6 末尾の 9 項目。
