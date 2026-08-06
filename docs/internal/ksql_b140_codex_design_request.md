# B140 R2 対応案の提案依頼（codex）

**対応案の提案であり実装依頼ではない。コードは 1 行も変更しないこと。**
git 操作をしないこと（`git status` も含む）。kSQL MCP を叩かないこと。`npm test` は不要。
**自分の MEMORY.md は読まないこと**（このファイルだけで完結させる）。

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（v3.56.3）

---

## 0. 依頼

**R1 は中核が崩れて破棄した。R2 をどう組むかの「対応案」を出してほしい。**
**仕様そのものを書かなくてよい。案を 2〜4 個、比較できる形で並べてほしい。**

**求めるもの**

1. **候補キーをどこにどう持つか**の案（複数）。**それぞれの費用と壊れ方**
2. **どこまでを Phase 1 にするか**の線引き案。**「これだけなら安い」と言える最小形**
3. **各案が §2 の反例 2 つを本当に弾けるか**（コードの行を根拠に）
4. **やらない案（現状維持・文言のみ）が勝つ条件**があるならそれも

**推奨を 1 つ選び、理由を書いてほしい。** 迷う場合は「決めるために何を測ればよいか」を書く。

---

## 1. 何を解きたいか

**CTE の `GROUP BY` キーを、ウィンドウ関数の `ORDER BY` が全順序である根拠として使いたい。**

現状、依頼元の主用途で**偽陽性の警告が毎回出る**。

```sql
WITH 月次 AS (
  SELECT DATE_FORMAT(日付, '%Y-%m') AS 年月, SUM(個数) AS 出庫数
  FROM APP4228 WHERE 入出庫区分 = '出庫' GROUP BY 年月
)
SELECT 年月, 出庫数, LAG(出庫数) OVER (ORDER BY 年月) AS 前月 FROM 月次
```

```
warnings: ["前月 の ORDER BY は全順序でないため、同順内の前後関係は未規定です。…"]
```

`年月` は `GROUP BY` キーなので 1 行 1 値。同順は存在し得ない。

**被害は「値が誤る」ことではなく「警告の信用が落ちる」こと。**
同じ判定器を B127（既定フレーム `RANGE` の警告）と B128（`LAG`/`LEAD` の警告）が共有しており、
**主用途で毎回鳴ると、実害があるときの B127 の警告まで読み飛ばされる。**

### 現行の判定器

```ts
// src/execute.ts の canProveTotalWindowOrder（行番号は変わっている可能性がある。関数名で探すこと）
function canProveTotalWindowOrder(stmt, orderBy, resolveField, context): boolean {
  if (context !== "DIRECT" || stmt.joins.length > 0
      || stmt.from.cteName !== null || stmt.from.subtableCode != null) {
    return false;
  }
  return orderBy.some((item) => {
    if (item.key.type !== "FIELD_NAME") return false;
    const ref = aggregateFieldRef(item.key.name);
    return ref.field === "$id" || resolveField(ref)?.fieldType === "RECORD_NUMBER";
  });
}
```

**呼び出し元は `collectDefaultRangeWindowWarnings` の 1 か所**で、B127 と B128 の両方がここを通る。
**1 か所直せば両方に効く。**

---

## 2. **R1 が崩れた地点（実データで確認済み・v3.56.3）**

R1 は「**キーの対応は出力列名で取る**」と書いた。**これが不成立であることを実機で確かめた。**

### 反例① `GROUP BY` は SELECT 別名より物理列を先に解決する

```sql
WITH m AS (SELECT DATE_FORMAT(日付,'%Y-%m') AS 日付, COUNT(*) AS 件数
           FROM APP4228 GROUP BY 日付)
SELECT 日付, 件数 FROM m
```

**実際の結果**

```
2025-08 / 3     2025-08 / 3     2025-08 / 4     2025-08 / 1   …（同じ値が並ぶ）
```

**グループは物理 `日付`（日単位）でできており、出力列 `日付` は `DATE_FORMAT`（月単位）。**
**名前は一致するが中身は別物**で、`DATE_FORMAT` は非単射なので**出力列に重複が出る。**
**R1 の規則ならここで警告を消していた（偽陰性）。**

### 反例② 出力名の重複が通り、後続の集計値がキーを上書きする

```sql
WITH m AS (SELECT 入出庫区分, SUM(個数) AS 入出庫区分 FROM APP4228 GROUP BY 入出庫区分)
SELECT * FROM m
```

**実際の結果**

```
columns: ["入出庫区分"]
rows:    [{"入出庫区分":"43793"}, {"入出庫区分":"41645"}]
```

**列が 1 本に潰れ、残ったのは合計値。グループキーは出力から消えている。**

### 前回のレビューで指摘済みだった点（R2 で潰すこと）

- **列単位の真偽フラグでは複合キーを表せない。**
  `GROUP BY a, b` は「a と b が揃って初めて一意」であり、
  列ごとに「グループキー由来」を立てると **`ORDER BY a` だけを通してしまう**
- **警告判定の時点で、CTE の実体化キャッシュには定義 AST が無い**。
  行・列・通常の列メタ（表示名・ソート種別・型・semantics）しか残らない
- **`DERIVED` は「CTE を読んでいる」を意味しない。** context の意味を確かめること
- **`GROUP BY` に式が書けるかどうか**、R1 の記述と現行 AST が食い違っていた。確かめること

---

## 3. 制約（変えてはいけないもの）

| | |
|---|---|
| **値** | 一切変えない。本件は警告の出し分けだけ |
| **並び** | `ORDER BY` に暗黙のタイブレークを足さない（既存の並びが変わる） |
| **既存の証明** | direct APP の `$id` / `RECORD_NUMBER` 抑止は**純加法で残す** |
| **fail-closed** | 証明できないものは**警告を残す**。偽陰性を作らない |
| **公開型** | 必須プロパティの追加は破壊的変更（BYO クライアントが壊れる） |

**除外してよいもの**（現状どおり警告を残す）＝`ROLLUP`/`CUBE`/`GROUPING SETS`、`UNION` を含む CTE、
JOIN を含む consumer、サブテーブル仮想テーブル、一時テーブル（別文で定義されるため経路が違う）。

**ただし「一時テーブルも同じ枠組みで扱えるなら Phase 2 で入る」形が望ましい。**
**Phase 1 で塞いだ道が Phase 2 を塞がないか**も見てほしい。

---

## 4. 参考になるファイル

| ファイル | 役割 |
|---|---|
| `docs/internal/ksql_b140_cte_groupby_total_order_issue.md` | 起票（実測あり） |
| `docs/internal/ksql_b140_cte_groupby_total_order_spec.md` | **破棄した R1**（案の出発点としてのみ） |
| `docs/internal/ksql_b140_codex_review_1.md` | **R1 のレビュー結果 8 件**（あなたが以前に出したもの） |
| `src/execute.ts` | `canProveTotalWindowOrder` / `collectDefaultRangeWindowWarnings` / `MaterializedColumnMeta` / CTE 実体化 |
| `src/core/optimization/plainGroupByPlan.ts` | **plain `GROUP BY` の解決 plan**（PHYSICAL / ALIAS_SAFE の判定） |
| `src/engine/process.ts` | 投影（同名出力の上書きが起きる場所） |
| `src/core/grouping.ts` | `GROUP BY` の正規化 |
| `src/types/ast.ts` | `WithStatement` / `SelectStatement` |

---

## 5. 出力の形

**Markdown で、以下の順に。**

1. **結論**（推奨案と一言理由）
2. **案の比較表**（案名 / 何を持つか / Phase 1 の大きさ / 壊れ方 / §2 の反例を弾けるか）
3. **各案の詳細**（**コードの行を根拠に**。ファイル:行 で示す）
4. **推奨案の Phase 1 受入条件の骨子**（詳細な仕様は不要。**観測可能な形**で）
5. **決めるために測るべきこと**（あれば）

**根拠の無い断定は書かないこと。**
**コードを読んで分かることと、実行しないと分からないことを区別して書くこと**
（前者は行を示し、後者は「未確認」と明記する）。
