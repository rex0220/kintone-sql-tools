# B140 仕様 R2 作成依頼（codex）

**仕様の作成依頼。コードは 1 行も変更しないこと。ファイルへの書き込みも不要。**
git 操作をしないこと（`git status` も含む）。kSQL MCP を叩かないこと。
**自分の MEMORY.md は読まないこと**（このファイルと参照先だけで完結させる）。

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（**v3.57.0**）

## 0. 依頼

**B140 の仕様 R2 を、そのまま実装依頼に出せる形で書いてほしい。R1 は破棄済み。**
**出力は R2 の全文（Markdown）1 本。** レビューは Claude が行う。

| ファイル | 役割 |
|---|---|
| `docs/internal/ksql_b140_cte_groupby_total_order_issue.md` | **起票。§7 に「B148 で中核が解けた」** |
| `docs/internal/ksql_b140_codex_design_1.md` | **対応案**（あなたが出したもの。**B148 実装の前**なので前提が変わっている） |
| `docs/internal/ksql_b140_codex_review_1.md` | R1 のレビュー（8 件） |
| `docs/internal/ksql_b140_cte_groupby_total_order_spec.md` | **破棄した R1**（経緯としてのみ。**参照して設計しないこと**） |
| `src/core/aggregateDependencyValidation.ts` | **B148 で新設。`buildOrdinaryDependencyPolicy` が identity を作る** |
| `src/core/optimization/plainGroupByPlan.ts` | plain GROUP BY の解決 plan |
| `src/execute.ts` | `canProveTotalWindowOrder` / `collectDefaultRangeWindowWarnings` / CTE 実体化 / `MaterializedTable` |
| `docs/internal/ksql_b148_bare_column_group_by_spec_r3.md` | **B148 の仕様**（identity と canonical の定義が書いてある） |

## 1. 解きたいこと

**CTE の `GROUP BY` キーを、ウィンドウ関数の `ORDER BY` が全順序である根拠として使いたい。**

**依頼元の主用途で毎回、偽陽性の警告が出る。**

```sql
WITH 月次 AS (
  SELECT DATE_FORMAT(日付,'%Y-%m') AS 年月, SUM(個数) AS 出庫数
  FROM APP4228 WHERE 入出庫区分 = '出庫' GROUP BY 年月
)
SELECT 年月, 出庫数, LAG(出庫数) OVER (ORDER BY 年月) AS 前月 FROM 月次
```

```
warnings: ["前月 の ORDER BY は全順序でないため、同順内の前後関係は未規定です。…"]
```

**`年月` は `GROUP BY` キーなので 1 行 1 値。同順は存在し得ない。**

**被害は「値が誤る」ことではなく「警告の信用が落ちる」こと。**
**B127（既定フレーム `RANGE` の警告）と B128（`LAG`/`LEAD` の警告）が
同じ `canProveTotalWindowOrder` を共有しており、主用途で毎回鳴ると
実害があるときの B127 の警告まで読み飛ばされる。**

**同じ CTE で B127 の警告も出ることは実測済み。1 か所直せば両方に効く。**

## 2. **前提が変わった**（R1・対応案の後で起きたこと）

**B148（v3.57.0）で、必要だった identity が実装された。**

```ts
// src/core/aggregateDependencyValidation.ts
export function buildOrdinaryDependencyPolicy(stmt, plan, schemas): {
  readonly identities: ReadonlySet<string>;   // GROUP BY キーの canonical identity 集合
  ...
}
```

| plan | identity |
|---|---|
| `PHYSICAL` | `FIELD:source:<index>:<fieldCode>` |
| `ALIAS_SAFE` | `columnIndex` の SELECT 式を canonicalize |
| `EXPRESSION` | 対応する `GroupByKey` の式を canonicalize |

**あなたの対応案は「Phase 1-min は `ALIAS_SAFE` だけ」と提案したが、
それは identity が無かった頃の話である。R2 では前提から見直してよい。**

**canonical 一致は実測で 8 形の表記ゆれを通している**
（`1`／`1.0`・修飾／非修飾の両方向・余分な括弧・`SUBSTR`／`SUBSTRING`・連結・
リテラル別名・空白）。**B140 でも同じ道具を使える見込み。**

## 3. 残っている作業（**R1 の想定より小さいはず。確かめて書いてほしい**）

1. **identity → CTE の出力列の対応づけ**。
   `ALIAS_SAFE` は `columnIndex` を持つ。`PHYSICAL` は fieldCode。
   `EXPRESSION` は出力列側と canonical 比較が要る
2. **実体化した relation へ候補キーを運ぶ**。
   **`mergeSelectWarnings` が clone 時に列メタしか引き継がない**ので、そこも要る
3. **consumer 側で、ウィンドウの `ORDER BY` が候補キーを包含するか**の判定

## 4. 実測で確定している事実（**再導出せず、そのまま使うこと**）

**v3.57.0・実アプリ APP4228（製品名 / 個数 / 日付 / 入出庫区分・1000 レコード）。**

```
主用途（上記の CTE + LAG）           → 13 行・値は正しい・警告が出る（偽陽性）
同じ CTE で SUM(...) OVER (ORDER BY 年月) → B127 の警告も出る（同じく偽陽性）
direct APP + レコード番号 を ORDER BY   → 警告は出ない（現行の唯一の証明経路）
```

**現行の判定器**（`src/execute.ts` の `canProveTotalWindowOrder`）は
**`context !== "DIRECT"` と `from.cteName !== null` の 2 条件で CTE 経路を落とし、
根拠にできるのは物理フィールドの `$id` / `RECORD_NUMBER` だけ。**

## 5. R2 に必ず含めること

1. **証明の規則**（何を根拠に全順序と言えるか）
2. **候補キーの持ち方と伝播**（どこに載せ、どこで失効させるか）
3. **除外するもの**（`ROLLUP` 系・`UNION`・JOIN・サブテーブル・一時テーブル 等）と、その理由
4. **Phase の線引き**（Phase 1 に入れないものと理由。**B148 の identity が使える今の前提で**）
5. **受入条件**＝**通り続けるもの / 警告が消えるもの / 警告が残るもの（偽陰性を作らない）/ 回帰**。
   **完全な SQL で書き、公開結果（`SelectResult.warnings` / 値 / 行順）で観測できる形に**
6. **B127 と B128 の両方**について受入を書く（判定器が共通なので両方に効く）
7. **値・行順・`columns` を一切変えないこと**。**`ORDER BY` に暗黙のタイブレークを足さないこと**
8. **未確認事項**（あなたは実行できないので、**Claude が実測すべきことを列挙する**）

## 6. 書き方の制約

- **受入条件に内部実装（関数名・ファイル名）を要求しない**
- **コードで確定できることと、実行しないと分からないことを区別する**
  （前者はファイル:行 を示し、後者は「未確認」と明記する）
- **日本語。B148 の R3 と同じ体裁**（見出し番号・表・コードブロック）
- **根拠の無い断定を書かない**

## 7. 参考: 判断が割れうる点（**R2 で決めてほしい**）

- **`DISTINCT` を経た列**を根拠に含めるか
- **一時テーブル**（`CREATE TEMP TABLE ... AS SELECT ... GROUP BY`）を Phase 1 に入れるか
- **多段 CTE**（CTE を読む CTE）へ候補キーを伝播するか
- **`$id` / `レコード番号` による関数従属**（B148 R3 §9.1 が Phase 2 送りにしたもの）と合流させるか
- **警告の文言を変えるか**（現行は「未規定です」。「証明できませんでした」へ変える案が起票にある）

上記に従い、**R2 の全文を Markdown で出力**してください。ファイルへの書き込みは不要です。
