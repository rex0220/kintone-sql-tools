# B140 CTE の `GROUP BY` キーを全順序として証明できず、主用途で毎回警告が出る

- 起票: 2026-08-06
- ステータス: 📝 **起票（実測済み）。仕様 R1 は破棄。R2 から**（2026-08-07）＝
  **[B148](ksql_b148_bare_column_group_by_issue.md)（v3.57.0）で中核の identity が実装された**（§7）
- 発見: [B128](ksql_b128_lag_lead_spec.md)（`LAG` / `LEAD`）の実機検算中
- 関連: [B127](../ksql_issue_tracker.md)（ウィンドウ既定フレームの警告・v3.47.0）

---

## 1. 事実

**B128 の主用途——依頼元の実需そのもの——で毎回警告が出る。**

```sql
WITH 月次 AS (
  SELECT DATE_FORMAT(日付, '%Y-%m') AS 年月, SUM(個数) AS 出庫数
  FROM APP4228 WHERE 入出庫区分 = '出庫' GROUP BY 年月
), 前月付き AS (
  SELECT 年月, 出庫数, LAG(出庫数) OVER (ORDER BY 年月) AS 前月 FROM 月次
)
SELECT ... FROM 前月付き
```

```
warnings: ["前月 の ORDER BY は全順序でないため、同順内の前後関係は未規定です。
           レコード番号等を ORDER BY に追加してください。"]
```

**しかし `年月` は CTE の `GROUP BY` キーなので、構造上 1 行 1 値で一意。**
**同順の行は存在し得ない。** つまりこの警告は**偽陽性**である。

### 判定器自体は正しく動いている

**direct APP で `レコード番号` を含む場合は抑止される**（実測・v3.51.0 相当）。

```
SELECT レコード番号, LAG(仕入価格) OVER (ORDER BY レコード番号) AS 前 FROM APP4229 ORDER BY レコード番号
→ warnings: []
```

**問題は「CTE 由来の列を証明できない」ことだけ**で、判定器の欠陥ではない。
`canProveTotalWindowOrder` は物理フィールドの `$id` / `RECORD_NUMBER` しか根拠にできない。

---

## 2. なぜ重要か

**警告疲れを起こす。**

- B127（ウィンドウ既定フレーム）は「**実害があるときだけ警告する**」設計で、
  **`ORDER BY` が全順序と静的に判定できるときは出さない**ようにしてある
- 同じ判定器を共有した結果、**B128 の主用途が毎回警告される**
- **主用途で毎回出る警告は読み飛ばされる。** そうなると **B127 の警告まで効かなくなる**

**正しさには影響しない**（値は正しい）。**警告の質の問題。**

---

## 3. 証明できるはずの根拠

**CTE の外側 `SELECT` が `GROUP BY k` を持ち、下流の `ORDER BY` がちょうど `k` なら、
その CTE の行は `k` について一意。** これは静的に判定できる。

| 形 | 一意か | 現在 |
|---|---|---|
| `WITH m AS (... GROUP BY k) SELECT ... OVER (ORDER BY k) FROM m` | **一意** | 警告が出る |
| `GROUP BY k1, k2` に対し `ORDER BY k1, k2` | **一意** | 警告が出る |
| `GROUP BY k1, k2` に対し `ORDER BY k1` だけ | 一意でない | 警告が出る（正しい） |
| `DISTINCT` を経た列 | 一意 | 警告が出る |

**materialized ソースの列メタは既に保持されている**（`execute.ts` の CTE / 一時テーブル経路）ので、
**「この列は GROUP BY キーだった」という情報を運べるかが論点。**

---

## 4. 対応案

| 案 | 内容 | 見立て |
|---|---|---|
| **A** | **CTE / 一時テーブルの `GROUP BY` キー（と `DISTINCT` 列）を全順序の根拠として証明できるようにする** | **筋が良い**。列メタに「グループキー由来」を持たせる必要がある |
| **B** | CTE 経由のときは**警告を出さない** | 偽陽性は消えるが、**本物の非全順序も見逃す**（B127 の設計思想に反する） |
| **C** | 文言を「証明できなかった」に変える（`未規定` → `判定できませんでした`） | 安いが、**主用途で毎回出ることは変わらない** |
| **D** | 現状のまま | 警告疲れが残る |

**見立て＝案 A。** ただし**列メタの拡張が要る**ので、独立した仕様と codex レビューを経ること。

**案 C は案 A までのつなぎとして併用できる**（文言だけなら安い）。

---

## 5. 未確定

1. **`GROUP BY` キー由来であることを列メタで運べるか**（既存の `columnMeta` / `fieldSemantics` に
   足すのか、別の経路か）
2. **一時テーブル経由**でも同じ証明ができるか
3. `DISTINCT` 由来の一意性まで含めるか
4. **B127 側にも同じ偽陽性があるか**（集計ウィンドウを CTE の上で使う形）。
   **あるなら本件は B127 の穴でもある**

---

## 7. **【2026-08-07】B148 の実装で中核が解けた**

**[B148](ksql_b148_bare_column_group_by_issue.md)（v3.57.0）で、B140 が必要としていた
「どの出力が `GROUP BY` キーか」の identity が実装された。**

```ts
// src/core/aggregateDependencyValidation.ts
export function buildOrdinaryDependencyPolicy(stmt, plan, schemas): {
  readonly identities: ReadonlySet<string>;   // ← GROUP BY キーの canonical identity 集合
  ...
}
```

**`plainGroupByPlan` の解決種別ごとに identity を作る。**

| plan | identity |
|---|---|
| `PHYSICAL` | `FIELD:source:<index>:<fieldCode>` |
| `ALIAS_SAFE` | **`columnIndex` の SELECT 式**を canonicalize |
| `EXPRESSION` | 対応する `GroupByKey` の式を canonicalize |

**これは [B140 の仕様 R1](ksql_b140_cte_groupby_total_order_spec.md) が
「名前一致で取る」と書いて崩れた箇所そのもの。**
**同じ罠を B148 の R1・R2 でも踏み、3 版目で解いた。**

### 7.1 残っている作業（**R1 の想定より小さい**）

1. **identity → CTE の出力列の対応**。
   **`ALIAS_SAFE` は `columnIndex` を持つので出力列が直に分かる。**
   `PHYSICAL` は fieldCode、`EXPRESSION` は出力列側の式と canonical 比較が要る
2. **実体化した relation へ候補キーを運ぶ**（[codex の対応案](ksql_b140_codex_design_1.md) 案 A）。
   **`mergeSelectWarnings` が clone 時に列メタしか引き継がない**ので、そこも要る
3. **consumer 側で、ウィンドウの `ORDER BY` が候補キーを包含するか**を見る

**B148 の canonical 一致は実測で 8 形の表記ゆれを通している**
（`1`／`1.0`・修飾／非修飾の両方向・余分な括弧・関数別名・連結・リテラル・空白）ので、
**B140 でもそのまま使える見込み。**

### 7.2 Phase 1 の線引きへの影響

**[codex の対応案](ksql_b140_codex_design_1.md) は「Phase 1-min は `ALIAS_SAFE` だけ」と提案した。**
**その提案は B148 実装の前に出たもの**である。

**いまは `PHYSICAL` / `EXPRESSION` の identity も存在する**ので、
**`ALIAS_SAFE` 限定は「identity が無いから」ではなく
「出力列への対応づけが直に取れるから」という理由に変わる。**
**Phase 1 の範囲は仕様で決め直す。**

### 7.3 依頼元への照会

**[ウィンドウ警告の扱いを聞く照会](../../../ksql-analytics/docs/internal/kSQLエンジンからの照会-20260806-B140警告の扱い.md)
を先方の文書に置いてある**（A〜E の選択肢）。**回答は打ち手の優先度を変えるが、方向は変えない**
（どの回答でも案 A が本命）。**待たずに仕様を進めてよい。**
